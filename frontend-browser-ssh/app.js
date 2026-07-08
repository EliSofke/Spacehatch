/**
 * Spacehatch Variant D — browser-side SSH into a Codespace, no Node/gh.
 *
 * Pipeline (all client-side except the optional OAuth exchange):
 *   auth (PAT or OAuth) → REST create/poll (api.github.com, CORS ok)
 *   → GET /user/codespaces/{name}?internal=true → connection.tunnelProperties
 *   → @microsoft/dev-tunnels-connections opens the relay (WSS)
 *   → @microsoft/dev-tunnels-ssh runs SSH over it (Web Crypto)
 *   → xterm.js renders the shell.
 *
 * VERIFIED (via live probes): auth, REST lifecycle, and the tunnelProperties
 * fetch (api.github.com returns Access-Control-Allow-Origin: *).
 * TO VALIDATE LIVE (needs a browser + running codespace): the relay+SSH
 * handshake — encapsulated in connectTerminal() below, the single place to
 * adjust as the SDK surface is confirmed.
 */
"use strict";

const cfg = window.SPACEHATCH_D_CONFIG || {};
const params = new URLSearchParams(location.search);
const WORKER_URL = (cfg.workerUrl || cfg.authWorkerUrl || "").replace(/\/$/, "");

const els = {
  tabPat: document.getElementById("tab-pat"),
  tabOauth: document.getElementById("tab-oauth"),
  panePat: document.getElementById("pane-pat"),
  paneOauth: document.getElementById("pane-oauth"),
  token: document.getElementById("token"),
  login: document.getElementById("btn-login"),
  logout: document.getElementById("btn-logout"),
  owner: document.getElementById("owner"),
  repo: document.getElementById("repo"),
  launch: document.getElementById("btn-launch"),
  stop: document.getElementById("btn-stop"),
  status: document.getElementById("status"),
  whoami: document.getElementById("whoami"),
  led: document.getElementById("led"),
  bezelTitle: document.getElementById("bezel-title"),
  terminal: document.getElementById("terminal"),
};

els.owner.value = params.get("owner") || cfg.owner || "";
els.repo.value = params.get("repo") || cfg.repo || "";

const state = {
  mode: "pat", // "pat" | "oauth"
  oauthToken: null, // token acquired via OAuth (memory only)
  codespaceName: null,
  client: null, // dev-tunnels client, for teardown
};

function setStatus(t, live = false) {
  els.status.textContent = t;
  els.status.classList.toggle("live", live);
  log(t);
}

// Build stamp — replaced with the short commit SHA + date at Pages deploy time
// (see .github/workflows/pages.yml). Shows as "__BUILD_SHA__" when unstamped.
const BUILD = "__BUILD_SHA__";

// ---- On-page diagnostics: every step is visible without devtools ----------
function log(msg, level = "info") {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${level.toUpperCase()}  ${msg}`;
  const el = document.getElementById("log");
  if (el) {
    el.textContent += line + "\n";
    el.scrollTop = el.scrollHeight;
  }
  (level === "error" ? console.error : console.log)(line);
}
window.addEventListener("error", (e) =>
  log(`window.onerror: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, "error"),
);
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  log(`unhandledrejection: ${(r && (r.stack || r.message)) || r}`, "error");
});
document.addEventListener("DOMContentLoaded", () => {
  log(`spacehatch build ${BUILD}`);
  const b = document.getElementById("btn-copylog");
  if (b) b.addEventListener("click", () => {
    const t = document.getElementById("log");
    if (t) navigator.clipboard?.writeText(t.textContent).then(() => log("(log copied to clipboard)"));
  });
});
function setConnected(on, title) {
  els.led.classList.toggle("on", on);
  els.bezelTitle.textContent = title;
  els.stop.classList.toggle("hidden", !on);
}

// The active token, regardless of auth mode.
function token() {
  return state.mode === "oauth" ? state.oauthToken : els.token.value.trim();
}
function haveToken() {
  return !!token();
}

// ---- Auth mode toggle -----------------------------------------------------
function selectMode(mode) {
  state.mode = mode;
  els.tabPat.setAttribute("aria-selected", String(mode === "pat"));
  els.tabOauth.setAttribute("aria-selected", String(mode === "oauth"));
  els.panePat.classList.toggle("hidden", mode !== "pat");
  els.paneOauth.classList.toggle("hidden", mode !== "oauth");
}
els.tabPat.addEventListener("click", () => selectMode("pat"));
els.tabOauth.addEventListener("click", () => selectMode("oauth"));

// PAT-only deployment: remove the OAuth tab from the UI entirely.
if (cfg.patOnly) {
  els.tabOauth.classList.add("hidden");
}

// ---- OAuth (PKCE) — same design as frontend-oauth -------------------------
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return base64url(a);
}
async function pkceChallenge(v) {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
}
function redirectUri() {
  return location.origin + location.pathname;
}
async function signIn() {
  const verifier = randomString();
  const csrf = randomString(16);
  sessionStorage.setItem("sh_d_verifier", verifier);
  sessionStorage.setItem("sh_d_state", csrf);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", "codespace repo");
  url.searchParams.set("state", csrf);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  location.href = url.toString();
}
async function handleOAuthCallback(code, returnedState) {
  const expected = sessionStorage.getItem("sh_d_state");
  const verifier = sessionStorage.getItem("sh_d_verifier");
  history.replaceState({}, document.title, redirectUri());
  if (!expected || returnedState !== expected || !verifier) {
    setStatus("Sign-in state mismatch — try again.");
    return;
  }
  sessionStorage.removeItem("sh_d_state");
  sessionStorage.removeItem("sh_d_verifier");
  setStatus("completing sign-in …", true);
  try {
    const res = await fetch(`${WORKER_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(data.detail || data.error || `exchange failed (${res.status})`);
    state.oauthToken = data.access_token;
    selectMode("oauth");
    els.login.classList.add("hidden");
    els.logout.classList.remove("hidden");
    const me = await gh("/user");
    els.whoami.textContent = `@${me.login}`;
    setStatus(`signed in as ${me.login}`);
  } catch (err) {
    setStatus(`Sign-in failed: ${err.message}`);
  }
}
els.login.addEventListener("click", () => void signIn());
els.logout.addEventListener("click", () => {
  state.oauthToken = null;
  els.login.classList.remove("hidden");
  els.logout.classList.add("hidden");
  els.whoami.textContent = "";
  setStatus("signed out");
});

// ---- GitHub REST ----------------------------------------------------------
async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 204) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error("token invalid or expired — paste a current GitHub token");
    if (res.status === 403) throw new Error("forbidden — the token needs Codespaces write permission");
    if (res.status === 404) {
      throw new Error(
        "404 on " + path + " — GitHub returns this when the token can't access " +
        "Codespaces for the repo. Use a token with Codespaces (read and write) " +
        "permission and access to owner/repo, and check owner/repo are correct.",
      );
    }
    throw new Error(body.message ? `GitHub API ${res.status}: ${body.message}` : `GitHub API ${res.status}`);
  }
  return body;
}

async function pollUntilAvailable(name) {
  const start = Date.now();
  for (;;) {
    const cs = await gh(`/user/codespaces/${encodeURIComponent(name)}`);
    if (cs.state === "Available") return cs;
    if (cs.state === "Failed" || cs.state === "Deleted") throw new Error(`codespace state ${cs.state}`);
    if (Date.now() - start > 5 * 60 * 1000) throw new Error("timed out waiting for the codespace");
    setStatus(`codespace state: ${cs.state} …`, true);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

// ---- Tunnel credentials (verified: api.github.com sends ACAO: *) -----------
async function fetchTunnelProperties(name) {
  // internal=true exposes connection.tunnelProperties. This is undocumented
  // GitHub behavior (the one fragile dependency) — the same hop gh performs.
  const cs = await gh(`/user/codespaces/${encodeURIComponent(name)}?internal=true`);
  const tp = cs.connection && cs.connection.tunnelProperties;
  if (!tp || !tp.tunnelId || !tp.connectAccessToken) {
    throw new Error("no tunnelProperties in codespace connection (is it Available?)");
  }
  return tp; // { tunnelId, clusterId, connectAccessToken, managePortsAccessToken, serviceUri, domain }
}

// ---- Browser SSH via Dev Tunnels SDK --------------------------------------
// Loaded lazily as browser ESM so the page stays static.
async function loadSdk() {
  const cv = cfg.connectionsVersion || "1.3.50";
  const sv = cfg.sshVersion || "3.12.36";
  const base = "https://esm.sh/@microsoft";
  // Note: the SDK already runs its BROWSER path here (isNode() is false because
  // esm.sh's process shim reports release === {}), so the tunnel token is sent
  // as a WebSocket subprotocol — the correct browser mechanism. The relay still
  // closes the handshake (1006); cause is server-side, not the code path.
  const [connections, ssh] = await Promise.all([
    import(/* @vite-ignore */ `${base}/dev-tunnels-connections@${cv}`),
    import(/* @vite-ignore */ `${base}/dev-tunnels-ssh@${sv}`),
  ]);
  return { connections, ssh };
}

/**
 * Connect the terminal. This is the spike's live-validation boundary: the
 * REST + tunnelProperties steps above are verified; the relay+SSH handshake
 * below uses the SDK surface and must be confirmed against a running codespace
 * in a real browser. Kept in one function so adjustments are localized.
 */
async function connectTerminal(name, term) {
  setStatus("fetching tunnel credentials …", true);
  const tp = await fetchTunnelProperties(name);
  log(`tunnelProperties ok: cluster=${tp.clusterId} id=${tp.tunnelId} domain=${tp.domain} (token len=${(tp.connectAccessToken||"").length})`);

  setStatus("loading Dev Tunnels SDK …", true);
  const { connections, ssh } = await loadSdk();
  log(`SDK loaded: connections[${Object.keys(connections).slice(0,8).join(",")}]`);
  log(`SDK loaded: ssh[${Object.keys(ssh).filter(k=>/Ssh/.test(k)).slice(0,8).join(",")}]`);

  // The tunnel's endpoints (clientRelayUri, hostPublicKeys) come from the
  // tunnels management API, which is CORS-locked to vscode.dev — so we fetch
  // them through our relay (worker /tunnel). This is the one required function.
  if (!WORKER_URL || WORKER_URL.includes("YOUR-SUBDOMAIN")) {
    throw new Error(
      "workerUrl is not configured (still the placeholder). Deploy auth-worker/ " +
      "(npx wrangler deploy — no secrets needed in PAT-only mode) and set its " +
      "*.workers.dev URL as workerUrl in index.html.",
    );
  }
  setStatus("resolving tunnel endpoints via relay …", true);
  const relayRes = await fetch(`${WORKER_URL}/tunnel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cluster: tp.clusterId, tunnelId: tp.tunnelId, token: tp.connectAccessToken }),
  });
  if (!relayRes.ok) {
    const t = await relayRes.text().catch(() => "");
    throw new Error(`tunnel relay failed (${relayRes.status}): ${t.slice(0,160)}`);
  }
  const fetchedTunnel = await relayRes.json();
  const epCount = (fetchedTunnel.endpoints || []).length;
  log(`relay returned tunnel: endpoints=${epCount} relayUri=${epCount ? fetchedTunnel.endpoints[0].clientRelayUri : "-"}`);

  // Full Tunnel object for connect(): the management tunnel + the connect token.
  const tunnel = {
    ...fetchedTunnel,
    tunnelId: tp.tunnelId,
    clusterId: tp.clusterId,
    accessTokens: { connect: tp.connectAccessToken },
  };

  setStatus("connecting to the codespace relay …", true);
  const Client = connections.TunnelRelayTunnelClient;
  const client = new Client();
  state.client = client;

  // Surface relay/report diagnostics into the terminal AND the on-page log.
  if (client.trace) {
    client.trace = (level, _id, msg) => {
      term.write(`\r\n\x1b[2m[relay:${level}] ${msg}\x1b[0m`);
      log(`relay:${level} ${msg}`);
    };
  }

  try {
    await client.connect(tunnel);
    log("client.connect() resolved — relay handshake succeeded");
  } catch (err) {
    log(`client.connect() FAILED: ${err && (err.stack || err.message || err)}`, "error");
    throw err;
  }

  // Open the codespace's SSH channel over the tunnel and bind it to xterm.
  // The SDK forwards the codespace SSH port; the exact accessor for the
  // shell stream is the item to confirm live (candidates: waitForForwarded-
  // Channel / connectToForwardedPort / an SSH session over the forwarded
  // stream authenticated with a generated key registered via the codespace
  // SSH-key header). Encapsulated here on purpose.
  setStatus("relay connected — opening shell …", true);
  await bindShell(client, term, ssh);
  setConnected(true, `connected · ${name}`);
  setStatus("live", true);
}

/**
 * Variant C: get a bare shell with zero codespace-side artifacts.
 *  8a) open a stream to the agent's internal gRPC port (16634), call
 *      StartRemoteServerAsync(publicKey) → {port, user}  [the big live test]
 *  8b) open a stream to that port, run a second SSH session authenticated with
 *      our key as `user`, request a pty + shell, and bind it to xterm.
 * Heavy logging on purpose: the first live run should pinpoint any gap.
 */
async function bindShell(client, term, ssh) {
  const AGENT_PORT = 16634;
  const b64 = (u8) => { let s = ""; const a = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8); for (const b of a) s += String.fromCharCode(b); return btoa(s); };
  const toU8 = (d) => (d instanceof Uint8Array ? d : d && d.buffer ? new Uint8Array(d.buffer, d.byteOffset || 0, d.byteLength) : new Uint8Array(d));
  const toBuf = (u8) => (typeof globalThis.Buffer !== "undefined" ? globalThis.Buffer.from(u8) : u8);
  const streamAPI = (s) => { const p = s && Object.getPrototypeOf(s); return p ? Object.getOwnPropertyNames(p).filter((n) => typeof s[n] === "function").slice(0, 24).join(",") : typeof s; };
  const openForwarded = async (port) => {
    try { await client.waitForForwardedPort(port); } catch (e) { log(`waitForForwardedPort(${port}) note: ${e.message}`); }
    return client.connectToForwardedPort(port);
  };
  // The SDK's SshStream extends node:stream.Duplex, which esm.sh polyfills
  // incompletely in the browser (no working on()/write(); its internal push()
  // throws). But SshStream stores the real SshChannel as `.channel` and does
  // the SSH flow-control. We hijack push() to route inbound bytes to our
  // handler (SshStream still calls channel.adjustWindow for us) and send
  // outbound bytes via channel.send(), serialized to preserve order.
  const wireStream = (obj, onBytes) => {
    const channel = (obj && obj.channel) || obj;
    if (channel && typeof channel.send === "function") {
      if (obj.channel) {
        // SshStream wrapper: hijack push() (it feeds decoded chunks + adjusts window)
        obj.push = (chunk) => { if (chunk != null) onBytes(toU8(chunk)); return true; };
      } else if (typeof channel.onDataReceived === "function") {
        // Raw SshChannel: subscribe and replenish the window ourselves.
        channel.onDataReceived((data) => { onBytes(toU8(data)); if (typeof channel.adjustWindow === "function") channel.adjustWindow(data.length); });
      }
      let chain = Promise.resolve();
      return (bytes) => { const b = toBuf(bytes); chain = chain.then(() => channel.send(b)).catch((e) => log(`channel.send: ${e.message}`, "error")); return chain; };
    }
    if (typeof obj.on === "function") { obj.on("data", (d) => onBytes(toU8(d))); return (bytes) => obj.write(toBuf(bytes)); }
    log("stream: no .channel/.send and no on() — see streamAPI log", "error");
    return () => {};
  };

  const { GrpcConnection } = await import(`./grpc/client.js?v=${BUILD.split(" ")[0]}`);
  const { startRemoteServer } = await import(`./grpc/agent.js?v=${BUILD.split(" ")[0]}`);

  // ---- key: generate in the SDK so the SAME key registers + authenticates ---
  const alg = ssh.SshAlgorithms.publicKey.ecdsaSha2Nistp256;
  log("generating ECDSA P-256 keypair in the SDK …");
  const keyPair = await alg.generateKeyPair();
  const pubBytes = toU8(await keyPair.getPublicKeyBytes(alg.ecdsaSha2Nistp256 || undefined));
  const openssh = `ecdsa-sha2-nistp256 ${b64(pubBytes)} spacehatch`;
  log(`public key ready (${openssh.slice(0, 48)}…)`);

  // ---- 8a: gRPC StartRemoteServerAsync over forwarded port 16634 ------------
  setStatus("starting SSH server via agent (gRPC) …", true);
  log(`connecting to forwarded agent port ${AGENT_PORT} …`);
  const agentStream = await openForwarded(AGENT_PORT);
  log(`agentStream API: ${streamAPI(agentStream)} | has .channel=${!!(agentStream && agentStream.channel)}${agentStream && agentStream.channel ? " channel:" + streamAPI(agentStream.channel) : ""}`);
  const conn = new GrpcConnection(wireStream(agentStream, (u8) => conn.feed(u8)), { authority: "codespace-internal", debug: (m) => log(`grpc: ${m}`) });
  log("calling StartRemoteServerAsync …");
  const { port, user } = await startRemoteServer(conn, openssh);
  log(`StartRemoteServer OK → sshPort=${port} user=${user}`, "ok");
  term.write(`\r\n\x1b[32m[spacehatch] agent started SSH server on port ${port} as ${user}\x1b[0m\r\n`);

  // ---- 8b: second SSH session → pty + shell → xterm (live frontier) ---------
  setStatus("opening SSH session …", true);
  log(`connecting to forwarded ssh port ${port} …`);
  const sshStream = await openForwarded(port);
  log(`sshStream API: ${streamAPI(sshStream)}`);
  const config = new ssh.SshSessionConfiguration();
  const session = new ssh.SshClientSession(config);
  log(`session API: ${streamAPI(session)}`);
  await session.connect(sshStream);
  log("second SSH transport connected — authenticating …");
  const credentials = { username: user, publicKeys: [keyPair] };
  const authed = await session.authenticate(credentials);
  log(`authenticate → ${authed}`);
  if (!authed) throw new Error("second SSH authentication failed");

  const channel = await session.openChannel();
  log(`channel API: ${streamAPI(channel)}`);
  // pty + shell requests; exact request helpers vary — try common shapes.
  const cols = term.cols || 80, rows = term.rows || 24;
  if (typeof channel.requestTerminal === "function") await channel.requestTerminal("xterm-256color", cols, rows);
  else log("channel.requestTerminal not present — see channel API log", "error");
  if (typeof channel.requestShell === "function") await channel.requestShell();
  else log("channel.requestShell not present — see channel API log", "error");

  const chanSend = wireStream(channel, (u8) => term.write(toU8(u8)));
  term.onData((data) => chanSend(new TextEncoder().encode(data)));
  log("shell bound to xterm", "ok");
}

// ---- Launch ---------------------------------------------------------------
let term, fitAddon;
function ensureTerminal() {
  if (term) return;
  term = new Terminal({
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    fontSize: 14,
    theme: { background: "#0a0e12", foreground: "#dfe6ea", cursor: "#f2a33c" },
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(els.terminal);
  fitAddon.fit();
  window.addEventListener("resize", () => fitAddon.fit());
}

async function launch() {
  if (!haveToken()) {
    setStatus("Authenticate first (step 1).");
    return;
  }
  const owner = els.owner.value.trim();
  const repo = els.repo.value.trim();
  if (!owner || !repo) {
    setStatus("Enter owner and repository (step 2).");
    return;
  }
  els.launch.disabled = true;
  ensureTerminal();
  try {
    setStatus("looking for an existing codespace …", true);
    const { codespaces = [] } = await gh(`/repos/${owner}/${repo}/codespaces`);
    let cs = codespaces.find((c) => c.state !== "Deleted" && c.state !== "Failed");
    if (cs && (cs.state === "Shutdown" || cs.state === "Archived")) {
      cs = await gh(`/user/codespaces/${encodeURIComponent(cs.name)}/start`, { method: "POST" });
    } else if (!cs) {
      cs = await gh(`/repos/${owner}/${repo}/codespaces`, {
        method: "POST",
        body: JSON.stringify({ ref: cfg.ref || "main", idle_timeout_minutes: cfg.idleTimeoutMinutes || 30 }),
      });
    }
    state.codespaceName = cs.name;
    cs = await pollUntilAvailable(cs.name);
    await connectTerminal(cs.name, term);
  } catch (err) {
    setStatus(`Launch failed: ${err.message}`);
    log(`launch error: ${err && (err.stack || err.message || err)}`, "error");
    term && term.write(`\r\n\x1b[31m[spacehatch] ${err.message}\x1b[0m\r\n`);
  } finally {
    els.launch.disabled = false;
  }
}
els.launch.addEventListener("click", () => void launch());

els.stop.addEventListener("click", async () => {
  try {
    if (state.client && state.client.dispose) await state.client.dispose();
  } catch { /* ignore */ }
  setConnected(false, "disconnected");
  if (!state.codespaceName) return;
  try {
    setStatus("stopping codespace …", true);
    await gh(`/user/codespaces/${encodeURIComponent(state.codespaceName)}/stop`, { method: "POST" });
    setStatus("codespace stopped");
  } catch (err) {
    setStatus(`Stop failed: ${err.message}`);
  }
});

// ---- Boot -----------------------------------------------------------------
(function boot() {
  selectMode("pat");
  if (cfg.patOnly) return; // PAT-only: no OAuth callback handling
  const code = params.get("code");
  const st = params.get("state");
  if (code && st) {
    selectMode("oauth");
    void handleOAuthCallback(code, st);
  }
})();
