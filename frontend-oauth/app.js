/**
 * OAuth + PKCE controller — no manual token entry.
 *
 * Flow:
 *   1. "Sign in" → generate PKCE verifier+challenge, redirect to GitHub's
 *      authorize endpoint. Already-signed-in + previously-authorized users are
 *      redirected back silently (no prompt).
 *   2. On return (?code&state) → POST { code, code_verifier } to the stateless
 *      auth worker, which exchanges them for an access token (it holds the
 *      client secret; the browser never sees it).
 *   3. The token lives in memory for this tab only. Launch/poll/open then work
 *      exactly like the pure-browser variant.
 *
 * GitHub's token endpoint has no CORS and still requires the client secret, so
 * the exchange cannot happen in the browser even with PKCE — hence the worker.
 */
"use strict";

const cfgDefaults = window.SPACEHATCH_OAUTH_CONFIG || {};
const params = new URLSearchParams(window.location.search);
const cfg = {
  clientId: cfgDefaults.clientId,
  authWorkerUrl: (cfgDefaults.authWorkerUrl || "").replace(/\/$/, ""),
  owner: params.get("owner") || cfgDefaults.owner,
  repo: params.get("repo") || cfgDefaults.repo,
  ref: params.get("ref") || cfgDefaults.ref || "main",
  bridgePort: Number(cfgDefaults.bridgePort || 7681),
  domain: cfgDefaults.portForwardingDomain || "app.github.dev",
  idleTimeoutMinutes: Number(cfgDefaults.idleTimeoutMinutes || 30),
};

const els = {
  login: document.getElementById("btn-login"),
  logout: document.getElementById("btn-logout"),
  launch: document.getElementById("btn-launch"),
  open: document.getElementById("btn-open"),
  stop: document.getElementById("btn-stop"),
  del: document.getElementById("btn-delete"),
  status: document.getElementById("status"),
  whoami: document.getElementById("whoami"),
  repoName: document.getElementById("repo-name"),
};
els.repoName.textContent = `${cfg.owner}/${cfg.repo}`;

// Token lives here only — in memory, for the lifetime of this tab.
let accessToken = null;
const state = { codespaceName: null, launching: false, lastLaunchAt: 0 };
const LAUNCH_COOLDOWN_MS = 60 * 1000;
const BRIDGE_GRACE_MS = 8 * 1000;

function setStatus(text, live = false) {
  els.status.textContent = text;
  els.status.classList.toggle("live", live);
}

// ---- PKCE helpers ---------------------------------------------------------
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function randomString(byteLen = 32) {
  const a = new Uint8Array(byteLen);
  crypto.getRandomValues(a);
  return base64url(a);
}
async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

function redirectUri() {
  // Callback returns to this same page (without the query string).
  return window.location.origin + window.location.pathname;
}

// ---- Sign-in / callback ---------------------------------------------------
async function signIn() {
  const verifier = randomString();
  const csrfState = randomString(16);
  sessionStorage.setItem("sh_pkce_verifier", verifier);
  sessionStorage.setItem("sh_oauth_state", csrfState);

  const challenge = await pkceChallenge(verifier);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", "codespace repo");
  url.searchParams.set("state", csrfState);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.href = url.toString();
}

async function handleCallback(code, returnedState) {
  const expectedState = sessionStorage.getItem("sh_oauth_state");
  const verifier = sessionStorage.getItem("sh_pkce_verifier");
  // Clean the URL immediately so a reload can't replay the code.
  window.history.replaceState({}, document.title, redirectUri());

  if (!expectedState || returnedState !== expectedState || !verifier) {
    setStatus("Sign-in state mismatch — please sign in again.");
    return;
  }
  sessionStorage.removeItem("sh_oauth_state");
  sessionStorage.removeItem("sh_pkce_verifier");

  setStatus("completing sign-in …", true);
  try {
    const res = await fetch(`${cfg.authWorkerUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(data.detail || data.error || `exchange failed (${res.status})`);
    }
    await onSignedIn(data.access_token);
  } catch (err) {
    setStatus(`Sign-in failed: ${err.message}`);
  }
}

async function onSignedIn(token) {
  accessToken = token;
  els.login.classList.add("hidden");
  els.logout.classList.remove("hidden");
  els.launch.disabled = false;
  try {
    const me = await gh("/user");
    els.whoami.textContent = `@${me.login}`;
    setStatus(`signed in as ${me.login}`);
  } catch {
    setStatus("signed in");
  }
}

function signOut() {
  accessToken = null;
  state.codespaceName = null;
  els.login.classList.remove("hidden");
  els.logout.classList.add("hidden");
  els.launch.disabled = true;
  els.open.classList.add("hidden");
  els.stop.classList.add("hidden");
  els.del.classList.add("hidden");
  els.whoami.textContent = "";
  setStatus("signed out");
}

// ---- GitHub REST (documented, CORS-enabled on api.github.com) --------------
async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 204) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      signOut();
      throw new Error("session expired — sign in again");
    }
    throw new Error(body.message || `GitHub API ${res.status}`);
  }
  return body;
}

function terminalUrl(name) {
  return `https://${name}-${cfg.bridgePort}.${cfg.domain}/`;
}

async function pollUntilAvailable(name) {
  const startedAt = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000;
  for (;;) {
    const cs = await gh(`/user/codespaces/${encodeURIComponent(name)}`);
    if (cs.state === "Available") return cs;
    if (cs.state === "Failed" || cs.state === "Deleted") {
      throw new Error(`codespace entered state ${cs.state}`);
    }
    if (Date.now() - startedAt > TIMEOUT_MS) throw new Error("timed out waiting for the codespace");
    setStatus(`codespace state: ${cs.state} …`, true);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

function writeLoadingPage(win, message) {
  if (!win || win.closed) return;
  try {
    win.document.title = "Spacehatch — terminal";
    win.document.body.style.cssText =
      "margin:0;height:100vh;display:flex;align-items:center;justify-content:center;" +
      "background:#0a0e12;color:#f2a33c;font-family:ui-monospace,Menlo,monospace;font-size:14px";
    win.document.body.textContent = message;
  } catch {
    /* cross-origin after navigation */
  }
}

// ---- Launch (identical behaviour to the pure-browser variant) --------------
async function launch() {
  if (!accessToken) return;
  if (state.launching) return;
  if (Date.now() - state.lastLaunchAt < LAUNCH_COOLDOWN_MS && state.codespaceName) {
    setStatus("Launch cooldown active — use the existing codespace.");
    return;
  }
  state.launching = true;
  state.lastLaunchAt = Date.now();
  els.launch.disabled = true;

  const termWin = window.open("", "_blank");
  writeLoadingPage(termWin, "Provisioning your codespace …");

  try {
    setStatus("looking for an existing codespace …", true);
    const { codespaces = [] } = await gh(`/repos/${cfg.owner}/${cfg.repo}/codespaces`);
    let cs = codespaces.find((c) => c.state !== "Deleted" && c.state !== "Failed");

    if (cs && (cs.state === "Shutdown" || cs.state === "Archived")) {
      setStatus(`restarting ${cs.name} …`, true);
      cs = await gh(`/user/codespaces/${encodeURIComponent(cs.name)}/start`, { method: "POST" });
    } else if (!cs) {
      setStatus("creating a fresh codespace …", true);
      cs = await gh(`/repos/${cfg.owner}/${cfg.repo}/codespaces`, {
        method: "POST",
        body: JSON.stringify({ ref: cfg.ref, idle_timeout_minutes: cfg.idleTimeoutMinutes }),
      });
    }

    state.codespaceName = cs.name;
    cs = await pollUntilAvailable(cs.name);

    const url = terminalUrl(cs.name);
    els.open.href = url;
    els.open.classList.remove("hidden");
    els.stop.classList.remove("hidden");
    els.del.classList.remove("hidden");

    setStatus(`ready — ${cs.name}; opening terminal …`, true);
    writeLoadingPage(termWin, "Codespace ready — starting the terminal …");
    await new Promise((r) => setTimeout(r, BRIDGE_GRACE_MS));
    if (termWin && !termWin.closed) termWin.location.href = url;
    else setStatus(`ready — ${cs.name}. Click “Open terminal ↗”.`, true);
  } catch (err) {
    setStatus(`Launch failed: ${err.message}`);
    writeLoadingPage(termWin, `Launch failed: ${err.message}`);
  } finally {
    state.launching = false;
    els.launch.disabled = false;
  }
}

async function stopCodespace(purge) {
  if (!state.codespaceName) return;
  try {
    setStatus(purge ? "deleting …" : "stopping …", true);
    if (purge) {
      await gh(`/user/codespaces/${encodeURIComponent(state.codespaceName)}`, { method: "DELETE" });
      state.codespaceName = null;
      els.stop.classList.add("hidden");
      els.del.classList.add("hidden");
    } else {
      await gh(`/user/codespaces/${encodeURIComponent(state.codespaceName)}/stop`, { method: "POST" });
    }
    els.open.classList.add("hidden");
    setStatus(purge ? "codespace deleted" : "codespace stopped");
  } catch (err) {
    setStatus(`${purge ? "Delete" : "Stop"} failed: ${err.message}`);
  }
}

// ---- Wire up + boot -------------------------------------------------------
els.login.addEventListener("click", () => void signIn());
els.logout.addEventListener("click", signOut);
els.launch.addEventListener("click", () => void launch());
els.stop.addEventListener("click", () => void stopCodespace(false));
els.del.addEventListener("click", () => void stopCodespace(true));

(function boot() {
  const code = params.get("code");
  const returnedState = params.get("state");
  if (code && returnedState) {
    void handleCallback(code, returnedState);
  }
})();
