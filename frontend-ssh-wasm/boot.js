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
  fit.fit();
  window.__sshTerm = term;
  return term;
}

function tstamp() {
  const s = ((performance.now() - bootT0) / 1000).toFixed(6);
  return `\x1b[90m[${s.padStart(11)}]\x1b[0m`;
}

// A yellow-orange braille spinner pinned to the bottom line during long waits
// (e.g. codespace provisioning). Timestamped boot lines scroll above it.
const SPIN_FRAMES = "⣾⣽⣻⢿⡿⣟⣯⣷";
let spinTimer = 0, spinLabel = "", spinFrame = 0, spinStart = 0;

function renderSpin() {
  if (!term) return;
  const el = ((performance.now() - spinStart) / 1000).toFixed(0);
  const f = SPIN_FRAMES[spinFrame % SPIN_FRAMES.length];
  term.write(`\r\x1b[K\x1b[38;5;214m${f}\x1b[0m ${spinLabel} \x1b[90m${el}s\x1b[0m`);
}
function startSpinner(label) {
  if (!term) return;
  spinLabel = label; spinFrame = 0; spinStart = performance.now();
  if (spinTimer) clearInterval(spinTimer);
  renderSpin();
  spinTimer = setInterval(() => { spinFrame++; renderSpin(); }, 120);
}
function updateSpinner(label) { spinLabel = label; }
function stopSpinner() {
  if (spinTimer) { clearInterval(spinTimer); spinTimer = 0; }
  if (term) term.write("\r\x1b[K"); // clear the spinner line so the next line replaces it
}

// One boot line. level: undefined | "ok" | "warn" | "error".
function boot(msg, level) {
  if (!term) return;
  let tag = "";
  if (level === "ok") tag = "\x1b[32m[  OK  ]\x1b[0m ";
  else if (level === "warn") tag = "\x1b[33m[ WARN ]\x1b[0m ";
  else if (level === "error") tag = "\x1b[31m[FAILED]\x1b[0m ";
  const body = level === "error" ? `\x1b[31m${msg}\x1b[0m` : msg;
  const spinning = !!spinTimer;
  if (spinning) term.write("\r\x1b[K");   // lift the spinner off the last line
  term.writeln(`${tstamp()} ${tag}${body}`);
  if (spinning) renderSpin();             // re-pin the spinner to the bottom
}

// Backwards-compatible alias used by the retry logic below.
function log(msg, cls) { boot(msg, cls === "error" ? "error" : undefined); }
function setStatus(s) { if (els.status) els.status.textContent = s; }

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

async function poll(name, want = "Available", tries = 120, delayMs = 2000) {
  let last = "";
  startSpinner("waiting for codespace …");
  try {
    for (let i = 0; i < tries; i++) {
      const cs = await gh(`/user/codespaces/${encodeURIComponent(name)}`);
      if (cs.state !== last) { boot(`codespace: ${cs.state}`); setStatus(`${cs.state} …`); last = cs.state; }
      if (cs.state === want) return cs;
      if (cs.state === "Failed" || cs.state === "Deleted") throw new Error(`codespace ${cs.state}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`codespace did not reach ${want} in time`);
  } finally {
    stopSpinner();
  }
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
    log("no codespace — creating one …");
    cs = await createCs();
  } else if (cs.state !== "Available") {
    log(`starting codespace ${cs.name} (${cs.state}) …`);
    let started = true;
    try {
      await gh(`/user/codespaces/${encodeURIComponent(cs.name)}/start`, { method: "POST" });
    } catch (e) {
      started = false;
      log(`cannot start ${cs.name} (${e.message}) — creating a fresh codespace`, "error");
    }
    if (!started) cs = await createCs();
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
  term.writeln("\x1b[1;36mSpacehatch\x1b[0m SSH \x1b[90m— codespace over one Go/WASM transport (dev-tunnels + grpc-go + x/crypto/ssh)\x1b[0m");
  term.writeln("\x1b[90m" + "-".repeat(72) + "\x1b[0m");

  try {
    setStatus("launching …");
    boot("POST: locating codespace …");
    const name = await launch(owner, repo);
    boot(`codespace ready: ${name}`, "ok");

    const tp = await tunnelProps(name);
    boot(`tunnel: cluster=${tp.clusterId} id=${tp.tunnelId}`);

    // Poll /tunnel until the codespace's tunnel host has attached to the relay.
    // GitHub reports the codespace "Available" a few seconds before its tunnel
    // host connects; opening the relay WebSocket in that window hits a host-less
    // tunnel and the relay rejects it (close 1006). status.hostConnectionCount
    // (passed through by the worker) is the precise readiness signal.
    setStatus("waiting for tunnel host …");
    boot("relay: waiting for tunnel host to attach …");
    startSpinner("waiting for tunnel host …");
    let relayUri;
    try {
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
        if (hostUp) { boot(`tunnel host attached${i ? ` (after ${i} check${i > 1 ? "s" : ""})` : ""}`, "ok"); break; }
        if (i >= 40) { boot("tunnel host not reported ready — trying anyway", "warn"); break; }
        await new Promise((r) => setTimeout(r, 750));
      }
    } finally {
      stopSpinner();
    }

    await loadGo();
    boot("transport: Go/WASM module ready");

    setStatus("connecting …");
    // Let the connection to the worker host settle after the preceding /tunnel
    // request before upgrading to a WebSocket. Opening the WS in the same tick
    // as the REST call makes some browsers (notably Firefox) fail the first
    // upgrade — a fresh connection then succeeds.
    await new Promise((r) => setTimeout(r, 350));
    const ws = await openRelay(relayUri, tp.connectAccessToken);

    // ws is guaranteed open here — wire the Go transport directly.
    const handle = window.spacehatchSSHConnect({
      sink: (u8) => { try { ws.send(u8); } catch (_) { /* closed */ } },
      onData: (u8) => term.write(typeof u8 === "string" ? u8 : new Uint8Array(u8)),
      onStatus: (s) => boot(s, /connected|sshd on port/.test(s) ? "ok" : undefined),
      workerUrl: WORKER_URL,
      cluster: tp.clusterId,
      tunnelId: tp.tunnelId,
      managePortsToken: tp.managePortsAccessToken || "",
      cols: term.cols,
      rows: term.rows,
    });
    ws.onmessage = (e) => handle.push(new Uint8Array(e.data));
    ws.onerror = () => boot("relay websocket error", "error");
    ws.onclose = (e) => { if (e.code !== 1000) boot(`relay closed (code ${e.code})`, "error"); };
    handle.promise.then((shell) => {
      term.writeln("\x1b[90m" + "-".repeat(72) + "\x1b[0m");
      term.focus();
      term.onData((d) => shell.write(d));
      // Only forward a resize when the size actually changed, and debounce the
      // window-resize -> fit cascade. Each resize is a SIGWINCH that makes the
      // remote shell redraw its prompt; a burst produced dozens of blank prompts.
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
    }).catch((err) => { setStatus("failed"); boot(`connect failed: ${err}`, "error"); });
  } catch (e) {
    setStatus("error");
    boot(String(e && e.message ? e.message : e), "error");
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
        if (n >= 3) log(`relay still connecting (attempt ${n}) …`);
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
