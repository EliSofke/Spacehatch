// @ts-check
/**
 * Spacehatch SSH boot — the thin JS half of the Stufe-2 endgame.
 *
 * JS does only: GitHub REST (existence/start/poll + tunnelProperties), the
 * worker /tunnel hop, opening ONE relay WebSocket, and rendering xterm. The
 * whole protocol (dev-tunnels relay SSH, grpc agent StartRemoteServer, the
 * codespace SSH shell) runs in the Go/WASM module via spacehatchSSHConnect().
 */

const cfg = window.SPACEHATCH_D_CONFIG || {};
const WORKER_URL = (cfg.workerUrl || "").replace(/\/$/, "");

const els = {
  token: /** @type {HTMLInputElement} */ (document.getElementById("token")),
  owner: /** @type {HTMLInputElement} */ (document.getElementById("owner")),
  repo: /** @type {HTMLInputElement} */ (document.getElementById("repo")),
  connect: /** @type {HTMLButtonElement} */ (document.getElementById("connect")),
  status: /** @type {HTMLElement} */ (document.getElementById("status")),
  term: /** @type {HTMLElement} */ (document.getElementById("term")),
  rtt: /** @type {HTMLElement} */ (document.getElementById("rtt")),
  sysinfo: /** @type {HTMLElement} */ (document.getElementById("sysinfo")),
};

const params = new URLSearchParams(location.search);
els.owner.value = params.get("owner") || cfg.owner || "";
els.repo.value = params.get("repo") || cfg.repo || "";

// ---- the main terminal doubles as the boot console ------------------------
// Diagnostics print into the terminal like a Linux boot (kernel timestamps +
// [  OK  ] tags), then the codespace shell takes over in the same window.
let term = null, fit = null, bootT0 = 0;

// --- Predictive local echo (step B) ------------------------------------------
// Typing otherwise waits a full RTT for the server echo. We speculatively echo
// printable keystrokes locally so typing feels instant, while the server stays
// the source of truth: each prediction is confirmed by SUPPRESSING the matching
// echo byte from the output stream. If the echo never comes (echo-off prompts
// like passwords, or unexpected output), the shown prediction is erased and
// prediction pauses. Safeguards: printable ASCII only; never in the alternate
// screen (vim/htop/less); off on detected password prompts; any non-printable
// key or a scan diverging from prediction resyncs to the server's truth.
const predict = { on: false, alt: false, pending: [], pausedUntil: 0 };
const asciiDecoder = new TextDecoder("latin1");
const isPrintable = (c) => c >= 0x20 && c <= 0x7e;

function predictClear(erase) {
  if (erase && predict.pending.length && term) term.write("\b \b".repeat(predict.pending.length));
  predict.pending.length = 0;
}
function predictReset() { predict.on = false; predict.alt = false; predict.pending.length = 0; predict.pausedUntil = 0; }

// A keystroke chunk from xterm (already encoded). Predict single printable chars;
// any other key (Enter, backspace, arrows, paste, control) resyncs by handing
// the line back to the server — pending echoes still drain via suppression, but
// on cursor-moving keys we stop adding and let the server redraw.
function predictInput(d) {
  if (!predict.on || predict.alt || performance.now() < predict.pausedUntil) return;
  if (d.length === 1 && isPrintable(d.charCodeAt(0))) {
    term.write(d);
    predict.pending.push(d.charCodeAt(0));
    return;
  }
  if (d === "\r" || d === "\n") return; // Enter: keep pending so its echo suppresses; do not predict
  // cursor-moving / editing / control input: stop predicting for a moment and
  // let the authoritative stream redraw. Do not erase (chars may be real).
  predict.pending.length = 0;
  predict.pausedUntil = performance.now() + 400;
}

// Server output bytes. Returns the bytes to actually write to xterm after
// suppressing confirmed echoes and reacting to alt-screen / password prompts.
function predictOutput(bytes) {
  if (predict.on) {
    const text = asciiDecoder.decode(bytes);
    if (text.includes("\x1b[?1049h") || text.includes("\x1b[?47h")) { predict.alt = true; predict.pending.length = 0; }
    if (text.includes("\x1b[?1049l") || text.includes("\x1b[?47l")) predict.alt = false;
    // Password / passphrase / PIN prompt → never echo the coming input locally.
    if (/(passwor|passphrase|\bPIN\b|verification code)[^\n]*$/i.test(text)) {
      predictClear(true);
      predict.pausedUntil = performance.now() + 10000;
    }
  }
  if (!predict.pending.length) return bytes;
  let i = 0;
  while (i < bytes.length && predict.pending.length && bytes[i] === predict.pending[0]) { i++; predict.pending.shift(); }
  if (i > 0) return bytes.subarray(i); // matched echoes already shown as predictions
  // Pending predictions but the server sent something else first: diverged
  // (echo-off or real output). Erase the shown predictions, then show the truth.
  predictClear(true);
  predict.pausedUntil = performance.now() + 600;
  return bytes;
}

function ensureTerm() {
  if (term) { try { term.dispose(); } catch (_) { /* noop */ } els.term.innerHTML = ""; term = null; }
  predictReset();
  bootT0 = performance.now();
  // eslint-disable-next-line no-undef
  term = new Terminal({
    fontSize: 18,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    cursorBlink: true,
    theme: { background: "#0b0e14", foreground: "#d7dae0" },
  });
  // eslint-disable-next-line no-undef
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(els.term);
  loadRenderer(term);
  // Held-key auto-repeat over a networked pty makes readline's echoes ("\r\n")
  // stack ahead of the grouped prompt redraws — real blank lines in the SERVER
  // stream (browser-independent). The echo-gated variant let repeats through at
  // the link pace, but the gate opened on the first output byte (mid prompt
  // redraw), so the next Enter still raced ahead and leaked blank lines. The
  // only approach with guaranteed zero stacking is to drop Enter auto-repeat
  // entirely: holding Enter submits once. Dropped on ALL event types +
  // preventDefault() so no follow-up keypress sends the "\r". Other held keys
  // are paced to ~16/s; distinct keystrokes and paste are untouched.
  let lastRepeat = 0;
  term.attachCustomKeyEventHandler((e) => {
    if (!e.repeat) return true;
    if (e.key === "Enter") { e.preventDefault(); return false; }
    if (e.type === "keydown") {
      const now = performance.now();
      if (now - lastRepeat < 60) { e.preventDefault(); return false; }
      lastRepeat = now;
    }
    return true;
  });
  fit.fit();
  window.__sshTerm = term;
  return term;
}

// Prefer an accelerated renderer (WebGL, then Canvas) over xterm's default DOM
// renderer. The DOM renderer can accumulate sub-pixel row rounding and leave
// visual gaps (apparent blank lines) between rows after scrolling on some
// browsers; the logical buffer is unaffected, so this is purely a rendering fix.
// Must run after term.open().
function loadRenderer(t) {
  if (typeof WebglAddon !== "undefined" && WebglAddon.WebglAddon) {
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch (_) { /* noop */ } loadCanvas(t); });
      t.loadAddon(webgl);
      return;
    } catch (_) { /* WebGL unavailable — fall back to Canvas */ }
  }
  loadCanvas(t);
}

function loadCanvas(t) {
  if (typeof CanvasAddon !== "undefined" && CanvasAddon.CanvasAddon) {
    try { t.loadAddon(new CanvasAddon.CanvasAddon()); } catch (_) { /* DOM fallback */ }
  }
}

function tstamp() {
  const s = ((performance.now() - bootT0) / 1000).toFixed(6);
  return `\x1b[90m[${s.padStart(11)}]\x1b[0m`;
}

// Each boot line is one step: "[time since boot] [ <status> ] <active topic>",
// where <status> spins (yellow-orange braille) while the step runs and flips to
// OK (green) or FAIL (red) in place when it ends. Topics are written actively
// ("Provisioning codespace", "Attaching tunnel host", …). One step at a time;
// starting a new step completes the previous one as OK.
const SPIN_FRAMES = "⠦⠖⠲⠴";
let stepTimer = 0, stepTopic = "", stepTs = "", stepFrame = 0, stepActive = false;

const TAG_OK = "[ \x1b[32mOK\x1b[0m ]";
const TAG_FAIL = "[\x1b[31mFAIL\x1b[0m]";
function tagSpin() { return `[ \x1b[38;5;214m${SPIN_FRAMES[stepFrame % SPIN_FRAMES.length]}\x1b[0m  ]`; }

function drawStep(tag) { if (term) term.write(`\r\x1b[K${stepTs} ${tag} ${stepTopic}`); }

function stepStart(topic) {
  if (!term) return;
  if (stepActive) stepOK();
  stepActive = true;
  stepTopic = topic;
  stepTs = tstamp();
  stepFrame = 0;
  drawStep(tagSpin());
  stepTimer = setInterval(() => { stepFrame++; drawStep(tagSpin()); }, 120);
}
function stepFinish(tag) {
  if (stepTimer) { clearInterval(stepTimer); stepTimer = 0; }
  if (!term || !stepActive) return;
  drawStep(tag);
  term.writeln("");
  stepActive = false;
}
function stepOK() { stepFinish(TAG_OK); }
function stepFail() { stepFinish(TAG_FAIL); }
// Error detail printed under a failed step.
function detail(msg) {
  if (!term) return;
  for (const line of String(msg).split(/\r?\n/)) term.writeln(`               \x1b[31m${line}\x1b[0m`);
}

let sysStatus = "";
function setStatus(s) { sysStatus = s; if (els.status) els.status.textContent = s; renderSysinfo(); }

// System-info line above the terminal, in the terminal aesthetic: the [ SH ]
// motif, a 24-hour HH:MM clock, the container (codespace) name, and its status.
// The clock is local and ticks every second; the status is push-driven — the Go
// transport reports it via onStatus (relayed through setStatus), so no polling is
// needed for it. GitHub exposes no push/subscribe for the codespace state itself.
let csName = "", sysTimer = 0, sysResizeBound = false;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// Colours mirror what xterm.js actually renders: OK green (\x1b[32m #4e9a06),
// FAIL red (\x1b[31m #cc0000), and the spinner's orange (256-colour 214 #ffaf00)
// for in-progress states. xterm's rendering is authoritative.
function sysStatusColor(s) {
  if (/disconnect|lost/i.test(s)) return "#cc0000";
  if (/connected/i.test(s)) return "#4e9a06";
  if (/fail|error/i.test(s)) return "#cc0000";
  if (/…|\.\.\.|reconnect|connect|launch|start|wait|provision|resolv|attach|load|queue|available/i.test(s)) return "#ffaf00";
  return "#555753";
}
const rttColor = (v) => (v <= 80 ? "#4e9a06" : v <= 200 ? "#ffaf00" : "#cc0000");
function clockStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function renderSysinfo() {
  if (!els.sysinfo) return;
  const status = (sysStatus || "").trim();
  const owner = els.owner.value.trim() || "EliSofke", repo = els.repo.value.trim() || "Spacehatch";
  const col = sysStatusColor(status || "idle");
  const A = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${esc(text)}</a>`;

  // Verb chosen so "<verb> to <target>" always reads as a sentence, in any state.
  let verb = "connecting";
  if (/disconnect|lost/i.test(status)) verb = "disconnected";
  else if (/reconnect/i.test(status)) verb = "reconnecting";
  else if (/connected/i.test(status)) verb = "connected";
  else if (/fail|error/i.test(status)) verb = "couldn't connect";

  const ownerUrl = `https://github.com/${encodeURIComponent(owner)}`;
  const repoUrl = `${ownerUrl}/${encodeURIComponent(repo)}`;
  // The codespace name (a link) is the only part that shortens on narrow screens;
  // the "@owner/repo" tail stays intact. fitCodespace() trims it in JS so we can
  // append a literal "..." right before the "@" — CSS text-overflow can do neither
  // (it clips at the end and renders a Unicode ellipsis).
  const csHtml = csName
    ? `<a class="cs" data-full="${esc(csName)}" href="https://github.com/codespaces/${encodeURIComponent(csName)}" target="_blank" rel="noopener">${esc(csName)}</a>@`
    : "";
  const target = csHtml + A(ownerUrl, owner) + "/" + A(repoUrl, repo);
  const sh = `[&gt; ${A(repoUrl, "SH")} &lt;]`;

  const rtt = Math.round(rttAvg);
  const rttHtml = rtt > 0 ? `<span style="color:${rttColor(rtt)}">${rtt} ms</span>` : "—";

  // Only the verb and the RTT are coloured; everything else is plain text.
  const left = `<span class="clk">${clockStr()}</span> ${sh} <span style="color:${col}">${esc(verb)}</span>`;
  const mid = `to ${target}`;
  const right = `⇄ ${rttHtml}`;

  els.sysinfo.innerHTML =
    `<span class="grp left">${left}</span>` +
    `<span class="grp mid">${mid}</span>` +
    `<span class="grp right">${right}</span>`;
  fitCodespace();
}
// Shorten the codespace name (only) until the middle group stops overflowing,
// appending a literal "..." before the "@". Binary search over the prefix length.
function fitCodespace() {
  if (!els.sysinfo) return;
  const mid = els.sysinfo.querySelector(".mid");
  const cs = mid && mid.querySelector(".cs");
  if (!cs) return;
  const full = cs.dataset.full || cs.textContent;
  cs.textContent = full;
  if (mid.scrollWidth <= mid.clientWidth + 1) return; // fits at full length
  let lo = 0, hi = full.length;
  while (lo < hi) {
    const n = Math.ceil((lo + hi) / 2);
    cs.textContent = full.slice(0, n) + "...";
    if (mid.scrollWidth <= mid.clientWidth + 1) lo = n; else hi = n - 1;
  }
  cs.textContent = full.slice(0, lo) + "...";
}
function tickClock() {
  const c = els.sysinfo && els.sysinfo.querySelector(".clk");
  if (c) c.textContent = clockStr();
}
function startSysinfo() {
  loadVersion().then(renderSysinfo).catch(() => {});
  renderSysinfo();
  if (!sysTimer) sysTimer = window.setInterval(tickClock, 1000);
  if (!sysResizeBound) {
    sysResizeBound = true;
    window.addEventListener("resize", () => requestAnimationFrame(fitCodespace));
  }
}

// Live latency readout. Keeps a light EWMA to smooth jitter and colour-codes the
// value (green ≤ 80 ms, amber ≤ 200 ms, red beyond). This is the measurement
// baseline (step A) for the responsiveness work.
let rttAvg = 0;
function showRtt(stage, ms) {
  if (typeof ms !== "number" || ms < 0) return;
  rttAvg = rttAvg ? rttAvg * 0.7 + ms * 0.3 : ms;
  if (els.rtt) { // legacy badge, if present
    const v = Math.round(rttAvg), color = rttColor(v);
    els.rtt.textContent = `${stage} ${v} ms`;
    els.rtt.style.color = color;
    els.rtt.style.borderColor = color;
  }
  renderSysinfo();
}

// Map the Go transport's status pings to active-voice step topics.
function goTopic(s) {
  if (/relay: SSH session/.test(s)) return "Opening relay session";
  if (/generating key/.test(s)) return "Generating SSH key";
  if (/StartRemoteServer/.test(s)) return "Starting remote SSH server";
  if (/connecting shell/.test(s)) return "Connecting shell";
  return s.replace(/\s*…\s*$/, "");
}

// ---- GitHub REST ----------------------------------------------------------
async function gh(path, opts = {}) {
  const token = els.token.value.trim();
  if (!token) throw new Error("enter a GitHub token");
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const need = r.headers.get("X-Accepted-GitHub-Permissions");
    const body = (await r.text()).replace(/\s+/g, " ").trim();
    throw new Error(`GitHub ${path}: ${r.status}${need ? ` — needs ${need}` : ""} ${body}`);
  }
  return r.status === 204 ? {} : r.json();
}

const CS_STOPPED = new Set(["Shutdown", "Unavailable"]);
// Poll until the codespace is Available. Codespaces commonly bounce
// (Shutdown -> Starting -> Shutdown) on a cold start before they hold, so we stay
// patient and keep monitoring the transition rather than giving up on the first
// fallback. If it settles back into a stopped state we nudge it with a fresh
// /start (throttled) — that fresh attempt is what a manual reconnect does and
// what usually succeeds. We only give up on a terminal state or the overall
// timeout. The single "Starting codespace" step (from launch) keeps spinning
// throughout; we don't split the wait into extra steps or surface raw states.
async function poll(name, want = "Available", tries = 90, delayMs = 2000) {
  const guide =
    "usually a Codespaces spending limit, an unavailable machine type, or a platform issue.\n" +
    "open github.com/codespaces to start it manually and see the reason, or delete it and reconnect.";
  let lastStartAt = performance.now(); // launch() just issued a /start
  for (let i = 0; i < tries; i++) {
    const cs = await gh(`/user/codespaces/${encodeURIComponent(name)}`);
    if (cs.state === want) return cs;
    if (cs.state === "Failed" || cs.state === "Deleted") throw new Error(`codespace reported ${cs.state}.\n${guide}`);
    // Fell back to a stopped state: nudge it again, but not more than every ~15s.
    if (CS_STOPPED.has(cs.state) && performance.now() - lastStartAt > 15000) {
      lastStartAt = performance.now();
      try { await gh(`/user/codespaces/${encodeURIComponent(name)}/start`, { method: "POST" }); } catch (_) { /* keep polling */ }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`codespace did not reach ${want} in time.\n${guide}`);
}

// Connect to the most recently created codespace, regardless of its state; only
// create a new one when none exists. If the chosen codespace isn't running yet,
// ask it to start (a 409 for an already-transitioning one is ignored) and let
// poll wait for it to become Available.
async function launch(owner, repo) {
  const { codespaces = [] } = await gh(`/repos/${owner}/${repo}/codespaces`);
  const cs = [...codespaces].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at),
  )[0];

  if (!cs) {
    stepStart("Creating codespace");
    const created = await gh(`/repos/${owner}/${repo}/codespaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    });
    await poll(created.name);
    return created.name;
  }

  if (cs.state !== "Available") {
    stepStart("Starting codespace");
    // Only a genuinely stopped codespace needs an explicit start; transitional
    // states (Starting/Provisioning/Queued/…) are already coming up, so we just
    // poll. Surface a real start failure (e.g. 403 without codespaces:write, or
    // 422) instead of silently polling a Shutdown codespace until timeout.
    if (cs.state === "Shutdown" || cs.state === "Unavailable" || cs.state === "ShuttingDown") {
      try {
        await gh(`/user/codespaces/${encodeURIComponent(cs.name)}/start`, { method: "POST" });
      } catch (e) {
        const msg = String(e).replace(/^Error:\s*/, "");
        if (!/\b409\b/.test(msg)) { // 409 = already starting, benign
          detail(`start failed: ${msg}`);
          if (/\b403\b/.test(msg)) {
            detail("hint: starting a codespace needs a classic PAT with the 'codespace' scope");
            detail("      (or a fine-grained PAT with Codespaces: Read and write on this repo).");
          }
          throw e;
        }
      }
    }
  }
  await poll(cs.name);
  return cs.name;
}

async function tunnelProps(name) {
  const cs = await gh(`/user/codespaces/${encodeURIComponent(name)}?internal=true`);
  const tp = cs.connection && cs.connection.tunnelProperties;
  if (!tp || !tp.tunnelId || !tp.connectAccessToken) {
    throw new Error("no tunnelProperties (is the codespace Available?)");
  }
  return tp; // { tunnelId, clusterId, connectAccessToken, managePortsAccessToken, ... }
}

// ---- Go/WASM transport (loaded once) --------------------------------------
let goReady;
function loadGo() {
  if (goReady) return goReady;
  goReady = (async () => {
    // eslint-disable-next-line no-undef
    const go = new Go();
    const bytes = await fetch("./spacehatch-ssh.wasm").then((r) => r.arrayBuffer());
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    go.run(instance); // never resolves (Go blocks on select{}); do NOT await
    for (let i = 0; i < 200 && !window.spacehatchSSHConnect; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!window.spacehatchSSHConnect) throw new Error("wasm did not register spacehatchSSHConnect");
  })();
  return goReady;
}

// ---- build metadata -------------------------------------------------------
// version.json is generated at deploy (SemVer from the repo + git commit +
// build time). Fetched once and cached; falls back gracefully in dev.
let versionInfo = null;
async function loadVersion() {
  if (versionInfo) return versionInfo;
  try {
    const r = await fetch("./version.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(String(r.status));
    versionInfo = await r.json();
  } catch (_) {
    versionInfo = { commit: "dev" };
  }
  return versionInfo;
}

// ---- connect --------------------------------------------------------------

// Session liveness. `live` is true only while an interactive shell is up; it
// gates disconnect handling so drops during the connect handshake fall through
// to connect()'s own error path instead. curWs/curShell reference the active
// transport so a reconnect can tear the old one down cleanly.
let live = false, connecting = false, curWs = null, curShell = null;
// Terminal IO and the fit-on-resize listener are wired exactly once (they read
// the *current* shell via curShell), so reconnecting doesn't stack duplicate
// handlers that would double every keystroke.
let ioBound = false, fitResizeBound = false, fitTimer = 0;
// Each connect attempt bumps `gen`; callbacks capture the gen they were wired
// under so a late event from a torn-down session can never tear down the current
// one (which would otherwise show up as spurious, frequent reconnects).
let gen = 0;
// Timestamps of recent auto-reconnects — bounds runaway loops if a codespace
// keeps dropping right after it comes back.
let reconnects = [];

function teardownSession() {
  live = false;
  try { if (curWs) { curWs.onclose = null; curWs.onmessage = null; curWs.onerror = null; curWs.close(); } } catch (_) { /* noop */ }
  try { const h = window.__sshHandle; if (h && h.close) h.close(); } catch (_) { /* noop */ }
  curWs = null; curShell = null; window.__sshHandle = null;
}

// Called when the transport dies under a live session: the relay closed the
// socket (ws.onclose), the Go keepalive stopped answering (onClosed), or a
// tab-return probe failed. srcGen ties the event to the session it came from.
// Surfaces the drop (including the WebSocket close code, which pins down the
// cause) and attempts a bounded reconnect; the codespace stays up, so
// reconnecting reattaches quickly.
function handleDisconnect(reason, srcGen, code, closeReason) {
  if (srcGen !== undefined && srcGen !== gen) return; // stale event from an old session
  if (!live || connecting) return; // ignore drops during connect and duplicates
  live = false;
  rttAvg = 0; // stop showing a stale latency
  const codeTag = code ? ` [ws ${code}${closeReason ? " " + closeReason : ""}]` : "";
  try { console.warn("spacehatch disconnect:", reason, "code=", code, "reason=", closeReason); } catch (_) { /* noop */ }
  const now = Date.now();
  reconnects = reconnects.filter((t) => now - t < 60000);
  if (reconnects.length >= 3) {
    teardownSession();
    setStatus("disconnected");
    if (term) term.writeln(`\r\n\x1b[31mconnection lost (${reason})${codeTag} — press Connect to reconnect\x1b[0m`);
    return;
  }
  reconnects.push(now);
  setStatus("reconnecting …");
  if (term) term.writeln(`\r\n\x1b[33mconnection lost (${reason})${codeTag} — reconnecting…\x1b[0m`);
  teardownSession();
  connect();
}

// A backgrounded tab throttles timers, so the keepalive can stall and the relay
// may drop the idle socket while we're away. On return, probe once: if the
// transport is dead, reconnect immediately instead of waiting for a stale UI.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !live) return;
    const h = window.__sshHandle;
    if (!h || !h.ping) return;
    h.ping()
      .then((ms) => { if (typeof ms === "number" && ms < 0) handleDisconnect("idle timeout", gen); })
      .catch(() => handleDisconnect("idle timeout", gen));
  });
}

async function connect() {
  if (connecting) return; // guard reentry (e.g. double-click, overlapping reconnect)
  const owner = els.owner.value.trim();
  const repo = els.repo.value.trim();
  if (!owner || !repo) { setStatus("enter owner and repo"); return; }
  connecting = true;
  const sessGen = ++gen;
  els.connect.disabled = true;
  startSysinfo();

  ensureTerm();

  try {
    setStatus("launching …");
    stepStart("Locating codespace");
    const name = await launch(owner, repo);
    csName = name; renderSysinfo();

    stepStart("Resolving tunnel");
    const tp = await tunnelProps(name);

    // GitHub reports the codespace "Available" a few seconds before its tunnel
    // host attaches to the relay; opening the relay WebSocket in that window
    // hits a host-less tunnel and the relay rejects it (close 1006).
    // status.hostConnectionCount (passed through by the worker) is the signal.
    setStatus("waiting for tunnel host …");
    stepStart("Attaching tunnel host");
    let workerRelayUri;
    for (let i = 0; ; i++) {
      const relayRes = await fetch(`${WORKER_URL}/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cluster: tp.clusterId, tunnelId: tp.tunnelId, token: tp.connectAccessToken }),
      });
      if (!relayRes.ok) throw new Error(`/tunnel ${relayRes.status} ${await relayRes.text()}`);
      const tunnel = await relayRes.json();
      workerRelayUri = tunnel.endpoints && tunnel.endpoints[0] && tunnel.endpoints[0].clientRelayUri;
      if (!workerRelayUri) throw new Error("no clientRelayUri from /tunnel");
      const hostUp = ((tunnel.status && tunnel.status.hostConnectionCount) || 0) >= 1;
      if (hostUp || i >= 40) break;
      await new Promise((r) => setTimeout(r, 750));
    }
    // The dev-tunnels relay accepts the connect token as a WebSocket subprotocol
    // (confirmed: works for Client/Connect from a browser Origin), so the browser
    // can reach the relay DIRECTLY — removing the worker (and its Durable Object)
    // from the per-byte path. The worker stays only for the one-time management
    // calls (/tunnel host-readiness polling above, /port registration in Go). The
    // worker relay remains the fallback if the direct handshake is ever refused.
    const directRelayUri =
      `wss://${tp.clusterId}-data.rel.tunnels.api.visualstudio.com/api/v1/Client/Connect/${tp.tunnelId}`;

    stepStart("Loading Go/WASM transport");
    await loadGo();

    setStatus("connecting …");
    stepStart("Connecting to relay");
    // Let the connection settle before the WS upgrade (some browsers fail the
    // very first upgrade right after a same-host HTTPS request).
    await new Promise((r) => setTimeout(r, 350));
    // Prefer the direct relay path (no worker in the byte stream); fall back to
    // the worker bridge if the direct handshake is refused.
    let ws;
    try {
      ws = await openRelay(directRelayUri, tp.connectAccessToken, 3);
    } catch (_) {
      ws = await openRelay(workerRelayUri, tp.connectAccessToken);
    }

    // ws is open — wire the Go transport; its status pings drive the next steps.
    const handle = window.spacehatchSSHConnect({
      sink: (u8) => { try { ws.send(u8); } catch (_) { /* closed */ } },
      onData: (u8) => {
        const bytes = typeof u8 === "string" ? new TextEncoder().encode(u8) : new Uint8Array(u8);
        term.write(predictOutput(bytes));
      },
      onStatus: (s) => {
        if (/(…|\.\.\.)\s*$/.test(s)) stepStart(goTopic(s));
        else if (/connected\s*$/.test(s) && stepActive) stepOK();
      },
      onRtt: (stage, ms) => showRtt(stage, ms),
      onClosed: () => handleDisconnect("ssh keepalive stopped", sessGen),
      workerUrl: WORKER_URL,
      cluster: tp.clusterId,
      tunnelId: tp.tunnelId,
      managePortsToken: tp.managePortsAccessToken || "",
      cols: term.cols,
      rows: term.rows,
    });
    ws.onmessage = (e) => handle.push(new Uint8Array(e.data));
    window.__sshHandle = handle; // exposes handle.ping() for latency probes
    ws.onerror = () => { /* failure surfaces via the connect promise / close */ };
    ws.onclose = (e) => handleDisconnect("relay closed the connection", sessGen, e && e.code, e && e.reason);
    handle.promise.then((shell) => {
      if (stepActive) stepOK();
      term.writeln("\x1b[90m" + "-".repeat(72) + "\x1b[0m");
      term.focus();
      // Mark the session live and adopt this transport as the current one.
      curShell = shell; curWs = ws; live = true;
      // Enable predictive local echo now that the interactive shell is live.
      predict.on = true; predict.alt = false; predict.pending.length = 0; predict.pausedUntil = 0;
      // Wire terminal IO and the resize->fit listener exactly once; both target
      // the *current* shell, so a later reconnect swaps curShell without stacking
      // duplicate handlers (which would double every keystroke).
      if (!ioBound) {
        ioBound = true;
        term.onData((d) => { if (curShell) { curShell.write(d); predictInput(d); } });
        term.onResize(({ cols, rows }) => { if (curShell) curShell.resize(cols, rows); });
      } else {
        curShell.resize(term.cols, term.rows); // sync size for the new shell
      }
      if (!fitResizeBound) {
        fitResizeBound = true;
        window.addEventListener("resize", () => {
          clearTimeout(fitTimer);
          fitTimer = setTimeout(() => fit.fit(), 150);
        });
      }
      setStatus("connected");
    }).catch((err) => { if (stepActive) stepFail(); detail(String(err)); setStatus("failed"); });
  } catch (e) {
    if (stepActive) stepFail();
    detail(String(e && e.message ? e.message : e));
    setStatus("error");
  } finally {
    connecting = false;
    els.connect.disabled = false;
  }
}

// Open the relay WebSocket. Some browsers (notably Firefox) fail the very first
// upgrade when it immediately follows a same-host HTTPS request; a retry on a
// fresh connection succeeds. Retry the first couple of times quickly and
// silently, and only surface a message if it keeps failing.
function openRelay(relayUri, token, tries = 6) {
  const delayFor = (n) => (n <= 2 ? 200 : 500 * (n - 1)); // 200, 200, 1000, 1500 …
  const attempt = (n) => new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUri, ["tunnel-relay-client", token]);
    ws.binaryType = "arraybuffer";
    let settled = false;
    const to = setTimeout(() => finish(false), 7000);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      if (ok) { resolve(ws); return; }
      try { ws.close(); } catch (_) { /* noop */ }
      if (n < tries) {
        setTimeout(() => attempt(n + 1).then(resolve, reject), delayFor(n));
      } else {
        reject(new Error("relay websocket did not open after retries"));
      }
    }
    ws.onopen = () => finish(true);
    ws.onclose = () => finish(false);
    ws.onerror = () => { /* close follows */ };
  });
  return attempt(1);
}

els.connect.addEventListener("click", connect);
// Test hooks for headless E2E.
window.__spacehatchSSH = { connect, loadGo, gh, launch, tunnelProps };
