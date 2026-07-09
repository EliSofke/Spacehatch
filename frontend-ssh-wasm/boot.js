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
function detail(msg) { if (term) term.writeln(`               \x1b[31m${msg}\x1b[0m`); }

function setStatus(s) { if (els.status) els.status.textContent = s; }

// Live latency readout. Keeps a light EWMA to smooth jitter and colour-codes the
// value (green ≤ 80 ms, amber ≤ 200 ms, red beyond). This is the measurement
// baseline (step A) for the responsiveness work.
let rttAvg = 0;
function showRtt(stage, ms) {
  if (!els.rtt || typeof ms !== "number" || ms < 0) return;
  rttAvg = rttAvg ? rttAvg * 0.7 + ms * 0.3 : ms;
  const v = Math.round(rttAvg);
  const color = v <= 80 ? "#6ac26a" : v <= 200 ? "#e0b341" : "#e06c6c";
  els.rtt.textContent = `${stage} ${v} ms`;
  els.rtt.style.color = color;
  els.rtt.style.borderColor = color;
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
  if (!r.ok) throw new Error(`GitHub ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? {} : r.json();
}

function stateTopic(state) {
  if (state === "Provisioning") return "Provisioning codespace";
  if (state === "Starting") return "Starting codespace";
  if (state === "Queued" || state === "Awaiting") return "Waiting for codespace";
  return `Waiting for codespace (${state})`;
}

async function poll(name, want = "Available", tries = 120, delayMs = 2000) {
  let shown = "";
  for (let i = 0; i < tries; i++) {
    const cs = await gh(`/user/codespaces/${encodeURIComponent(name)}`);
    if (cs.state !== shown) {
      shown = cs.state;
      setStatus(`${cs.state} …`);
      if (cs.state !== want) stepStart(stateTopic(cs.state));
    }
    if (cs.state === want) return cs;
    if (cs.state === "Failed" || cs.state === "Deleted") throw new Error(`codespace ${cs.state}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`codespace did not reach ${want} in time`);
}

// Codespace states that cannot be reused (must create a fresh one) and states
// that are stopped and need an explicit /start. Everything else that is not yet
// "Available" is transitional (heading toward Available) — we just wait for it.
const CS_DEAD = new Set(["Deleted", "Failed", "Moved", "Archived"]);
const CS_STOPPED = new Set(["Shutdown", "Unavailable", "ShuttingDown"]);

// Reuse an existing codespace whenever one exists; only create when there is
// genuinely none. Never spawn a second codespace just because an existing one is
// stopped or mid-transition — that was the old bug (a failing /start on a
// transitional codespace fell through to create).
async function launch(owner, repo) {
  const { codespaces = [] } = await gh(`/repos/${owner}/${repo}/codespaces`);
  const reusable = codespaces.filter((c) => !CS_DEAD.has(c.state));
  // Prefer already-running, then one already transitioning toward Available,
  // then a stopped one we can start.
  let cs = reusable.find((c) => c.state === "Available")
        || reusable.find((c) => !CS_STOPPED.has(c.state))
        || reusable[0];

  if (!cs) {
    stepStart("Creating codespace");
    cs = await gh(`/repos/${owner}/${repo}/codespaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    });
  } else if (cs.state !== "Available") {
    stepStart("Starting codespace");
    if (CS_STOPPED.has(cs.state)) {
      // Stopped → ask it to start. A 409 ("already starting") is fine: poll will
      // pick it up. Any other error also falls through to poll rather than
      // creating a duplicate; poll surfaces a genuine failure.
      try {
        await gh(`/user/codespaces/${encodeURIComponent(cs.name)}/start`, { method: "POST" });
      } catch (_) { /* already starting / transient — let poll decide */ }
    }
    // else: transitional (Starting/Provisioning/Queued/…) — just wait.
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
async function connect() {
  const owner = els.owner.value.trim();
  const repo = els.repo.value.trim();
  if (!owner || !repo) { setStatus("enter owner and repo"); return; }
  els.connect.disabled = true;

  ensureTerm();
  // neofetch-style header: cyan logo on the left, three attributes. Version and
  // commit come from version.json (generated at deploy).
  const v = await loadVersion();
  const CY = "\x1b[36m", CB = "\x1b[1;36m", D = "\x1b[90m", RS = "\x1b[0m";
  let ver = "";
  if (v.version) ver += `${CY}v${v.version}${RS}`;
  if (v.commit) ver += `${ver ? " " : ""}${D}(${v.commit})${RS}`;
  const lbl = (s) => `${CB}${s.padEnd(10)}${RS}`;
  term.writeln(`${CY}/------\\${RS}   ${CB}SpaceHatch${RS} ${ver}`);
  term.writeln(`${CY}[> SH <]${RS}   ${lbl("Terminal")}Xterm.js`);
  term.writeln(`${CY}\\------/${RS}   ${lbl("Target")}${owner}/${repo}`);
  term.writeln("");

  try {
    setStatus("launching …");
    stepStart("Locating codespace");
    const name = await launch(owner, repo);

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
    ws.onclose = () => { /* handled by the connect promise */ };
    handle.promise.then((shell) => {
      if (stepActive) stepOK();
      term.writeln("\x1b[90m" + "-".repeat(72) + "\x1b[0m");
      term.focus();
      // Enable predictive local echo now that the interactive shell is live.
      predict.on = true; predict.alt = false; predict.pending.length = 0; predict.pausedUntil = 0;
      term.onData((d) => { shell.write(d); predictInput(d); });
      let lastCols = term.cols, lastRows = term.rows;
      term.onResize(({ cols, rows }) => {
        if (cols === lastCols && rows === lastRows) return;
        lastCols = cols; lastRows = rows;
        shell.resize(cols, rows);
      });
      let fitTimer = 0;
      window.addEventListener("resize", () => {
        clearTimeout(fitTimer);
        fitTimer = setTimeout(() => fit.fit(), 150);
      });
      setStatus("connected");
    }).catch((err) => { if (stepActive) stepFail(); detail(String(err)); setStatus("failed"); });
  } catch (e) {
    if (stepActive) stepFail();
    detail(String(e && e.message ? e.message : e));
    setStatus("error");
  } finally {
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
