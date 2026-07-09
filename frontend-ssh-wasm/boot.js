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

const SPACEHATCH_VERSION = "0.1.0";
const SPACEHATCH_COMMIT = "__COMMIT__"; // replaced with the short git SHA at deploy (pages.yml)

const els = {
  token: /** @type {HTMLInputElement} */ (document.getElementById("token")),
  owner: /** @type {HTMLInputElement} */ (document.getElementById("owner")),
  repo: /** @type {HTMLInputElement} */ (document.getElementById("repo")),
  connect: /** @type {HTMLButtonElement} */ (document.getElementById("connect")),
  status: /** @type {HTMLElement} */ (document.getElementById("status")),
  term: /** @type {HTMLElement} */ (document.getElementById("term")),
};

const params = new URLSearchParams(location.search);
els.owner.value = params.get("owner") || cfg.owner || "";
els.repo.value = params.get("repo") || cfg.repo || "";

// ---- the main terminal doubles as the boot console ------------------------
// Diagnostics print into the terminal like a Linux boot (kernel timestamps +
// [  OK  ] tags), then the codespace shell takes over in the same window.
let term = null, fit = null, bootT0 = 0;

function ensureTerm() {
  if (term) { try { term.dispose(); } catch (_) { /* noop */ } els.term.innerHTML = ""; term = null; }
  bootT0 = performance.now();
  // eslint-disable-next-line no-undef
  term = new Terminal({
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    cursorBlink: true,
    convertEol: true,
    theme: { background: "#0b0e14", foreground: "#d7dae0" },
  });
  // eslint-disable-next-line no-undef
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(els.term);
  // Held-key auto-repeat floods the networked PTY: a burst of Enter makes the
  // remote shell echo accepted empty lines while coalescing prompt redraws,
  // leaving blank lines. Drop Enter auto-repeat (holding Enter = one submit) and
  // throttle other held keys; distinct keystrokes and paste are untouched.
  let lastRepeat = 0;
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.repeat) return true;
    if (e.key === "Enter") return false;
    const now = performance.now();
    if (now - lastRepeat < 60) return false; // ~16 repeats/sec for other keys
    lastRepeat = now;
    return true;
  });
  fit.fit();
  window.__sshTerm = term;
  return term;
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
const SPIN_FRAMES = "⣾⣽⣻⢿⡿⣟⣯⣷";
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

// Find an existing usable codespace, else start/create one, then wait Available.
async function launch(owner, repo) {
  const { codespaces = [] } = await gh(`/repos/${owner}/${repo}/codespaces`);
  const usable = codespaces.filter((c) => c.state !== "Deleted");
  let cs = usable.find((c) => c.state === "Available") || usable[0];

  const createCs = () => gh(`/repos/${owner}/${repo}/codespaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });

  if (!cs) {
    stepStart("Creating codespace");
    cs = await createCs();
  } else if (cs.state !== "Available") {
    stepStart("Starting codespace");
    let started = true;
    try {
      await gh(`/user/codespaces/${encodeURIComponent(cs.name)}/start`, { method: "POST" });
    } catch (e) {
      started = false;
    }
    if (!started) { stepStart("Creating codespace"); cs = await createCs(); }
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

// ---- connect --------------------------------------------------------------
async function connect() {
  const owner = els.owner.value.trim();
  const repo = els.repo.value.trim();
  if (!owner || !repo) { setStatus("enter owner and repo"); return; }
  els.connect.disabled = true;

  ensureTerm();
  // neofetch-style header: cyan logo on the left, three attributes.
  const CY = "\x1b[36m", CB = "\x1b[1;36m", D = "\x1b[90m", RS = "\x1b[0m";
  const commit = SPACEHATCH_COMMIT.startsWith("__") ? "dev" : SPACEHATCH_COMMIT;
  const lbl = (s) => `${CB}${s.padEnd(10)}${RS}`;
  term.writeln(`${CY}/------\\${RS}   ${CB}SpaceHatch${RS} ${CY}v${SPACEHATCH_VERSION}${RS} ${D}(${commit})${RS}`);
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
    let relayUri;
    for (let i = 0; ; i++) {
      const relayRes = await fetch(`${WORKER_URL}/tunnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cluster: tp.clusterId, tunnelId: tp.tunnelId, token: tp.connectAccessToken }),
      });
      if (!relayRes.ok) throw new Error(`/tunnel ${relayRes.status} ${await relayRes.text()}`);
      const tunnel = await relayRes.json();
      relayUri = tunnel.endpoints && tunnel.endpoints[0] && tunnel.endpoints[0].clientRelayUri;
      if (!relayUri) throw new Error("no clientRelayUri from /tunnel");
      const hostUp = ((tunnel.status && tunnel.status.hostConnectionCount) || 0) >= 1;
      if (hostUp || i >= 40) break;
      await new Promise((r) => setTimeout(r, 750));
    }

    stepStart("Loading Go/WASM transport");
    await loadGo();

    setStatus("connecting …");
    stepStart("Connecting to relay");
    // Let the connection to the worker host settle before the WS upgrade (some
    // browsers fail the first upgrade right after a same-host HTTPS request).
    await new Promise((r) => setTimeout(r, 350));
    const ws = await openRelay(relayUri, tp.connectAccessToken);

    // ws is open — wire the Go transport; its status pings drive the next steps.
    const handle = window.spacehatchSSHConnect({
      sink: (u8) => { try { ws.send(u8); } catch (_) { /* closed */ } },
      onData: (u8) => term.write(typeof u8 === "string" ? u8 : new Uint8Array(u8)),
      onStatus: (s) => {
        if (/(…|\.\.\.)\s*$/.test(s)) stepStart(goTopic(s));
        else if (/connected\s*$/.test(s) && stepActive) stepOK();
      },
      workerUrl: WORKER_URL,
      cluster: tp.clusterId,
      tunnelId: tp.tunnelId,
      managePortsToken: tp.managePortsAccessToken || "",
      cols: term.cols,
      rows: term.rows,
    });
    ws.onmessage = (e) => handle.push(new Uint8Array(e.data));
    ws.onerror = () => { /* failure surfaces via the connect promise / close */ };
    ws.onclose = () => { /* handled by the connect promise */ };
    handle.promise.then((shell) => {
      if (stepActive) stepOK();
      term.writeln("\x1b[90m" + "-".repeat(72) + "\x1b[0m");
      term.focus();
      term.onData((d) => shell.write(d));
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
