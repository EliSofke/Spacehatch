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
  log: /** @type {HTMLElement} */ (document.getElementById("log")),
};

const params = new URLSearchParams(location.search);
els.owner.value = params.get("owner") || cfg.owner || "";
els.repo.value = params.get("repo") || cfg.repo || "";

function log(msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}
function setStatus(s) { els.status.textContent = s; }

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

async function poll(name, want = "Available", tries = 60, delayMs = 3000) {
  for (let i = 0; i < tries; i++) {
    const cs = await gh(`/user/codespaces/${encodeURIComponent(name)}`);
    setStatus(`codespace ${cs.state} …`);
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
  try {
    setStatus("launching …");
    const name = await launch(owner, repo);
    log(`codespace ready: ${name}`);

    const tp = await tunnelProps(name);
    log(`tunnelProperties: cluster=${tp.clusterId} id=${tp.tunnelId}`);

    // Poll /tunnel until the codespace's tunnel host has attached to the relay.
    // GitHub reports the codespace "Available" a few seconds before its tunnel
    // host connects; opening the relay WebSocket in that window hits a host-less
    // tunnel and the relay rejects it (close 1006). status.hostConnectionCount
    // (passed through by the worker) is the precise readiness signal.
    setStatus("waiting for tunnel host …");
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
      if (hostUp) { if (i) log(`tunnel host attached after ${i} check(s)`); break; }
      if (i >= 40) { log("tunnel host not reported ready — trying anyway", "error"); break; }
      await new Promise((r) => setTimeout(r, 750));
    }

    await loadGo();

    // eslint-disable-next-line no-undef
    const term = new Terminal({ fontSize: 13, theme: { background: "#0b0e14" }, cursorBlink: true });
    // eslint-disable-next-line no-undef
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(els.term);
    fit.fit();
    window.__sshTerm = term;

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
      onStatus: (s) => log(s),
      workerUrl: WORKER_URL,
      cluster: tp.clusterId,
      tunnelId: tp.tunnelId,
      managePortsToken: tp.managePortsAccessToken || "",
      cols: term.cols,
      rows: term.rows,
    });
    ws.onmessage = (e) => handle.push(new Uint8Array(e.data));
    ws.onerror = () => log("relay websocket error", "error");
    ws.onclose = (e) => log(`relay closed (code ${e.code})`, e.code === 1000 ? undefined : "error");
    handle.promise.then((shell) => {
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
      log("shell connected");
    }).catch((err) => { setStatus("failed"); log(`connect failed: ${err}`, "error"); });
  } catch (e) {
    setStatus("error");
    log(String(e && e.message ? e.message : e), "error");
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
