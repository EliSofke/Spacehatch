/**
 * Pure-browser controller — no backend anywhere.
 *
 * The browser calls api.github.com directly (that host is fully CORS-enabled;
 * the OAuth token-exchange endpoints on github.com are NOT, which is why this
 * variant authenticates with a personal access token instead of an OAuth flow).
 *
 * The token lives in a closure variable for the lifetime of this tab: no
 * localStorage, no sessionStorage, no cookies.
 */
"use strict";

const cfgDefaults = window.CLOUD_TERMINAL_CONFIG || {};
const params = new URLSearchParams(window.location.search);
const cfg = {
  owner: params.get("owner") || cfgDefaults.owner,
  repo: params.get("repo") || cfgDefaults.repo,
  ref: params.get("ref") || cfgDefaults.ref || "main",
  bridgePort: Number(cfgDefaults.bridgePort || 7681),
  domain: params.get("domain") || cfgDefaults.portForwardingDomain || "app.github.dev",
  idleTimeoutMinutes: Number(cfgDefaults.idleTimeoutMinutes || 30),
};

const els = {
  token: document.getElementById("token"),
  launch: document.getElementById("btn-launch"),
  open: document.getElementById("btn-open"),
  stop: document.getElementById("btn-stop"),
  del: document.getElementById("btn-delete"),
  status: document.getElementById("status"),
  repoName: document.getElementById("repo-name"),
};
els.repoName.textContent = `${cfg.owner}/${cfg.repo}`;

const state = { codespaceName: null, launching: false, lastLaunchAt: 0 };
const LAUNCH_COOLDOWN_MS = 60 * 1000; // client-side guard against double launches
// After a codespace reports "Available", its forwarded port needs a moment
// before the in-codespace bridge is actually listening (postStartCommand
// race). Wait this long before navigating the terminal tab to avoid a 502.
const BRIDGE_GRACE_MS = 8 * 1000;

function setStatus(text, live = false) {
  els.status.textContent = text;
  els.status.classList.toggle("live", live);
}

function token() {
  return els.token.value.trim();
}

/** Minimal typed-ish wrapper for the documented REST API. */
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
    const reasons = {
      401: "token invalid or expired — create a new one with the codespace scope",
      403: body.message && /rate limit/i.test(body.message)
        ? "GitHub API rate limit hit — wait a bit"
        : "forbidden — check token scopes and organization policies",
      404: "repository not found or token lacks access to it",
    };
    throw new Error(reasons[res.status] || body.message || `GitHub API ${res.status}`);
  }
  return body;
}

function terminalUrl(name) {
  // Documented URL shape for forwarded ports; the domain is configurable
  // because GitHub reserves the right to change it.
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
    if (Date.now() - startedAt > TIMEOUT_MS) {
      throw new Error("timed out waiting for the codespace");
    }
    setStatus(`codespace state: ${cs.state} …`, true);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

els.launch.addEventListener("click", async () => {
  if (!token()) {
    setStatus("Paste a personal access token first (step 1).");
    els.token.focus();
    return;
  }
  // Single-flight + cooldown: without a server there is no server-side rate
  // limit, so the page itself refuses rapid re-launches.
  if (state.launching) return;
  if (Date.now() - state.lastLaunchAt < LAUNCH_COOLDOWN_MS && state.codespaceName) {
    setStatus("Launch cooldown active — use the existing codespace.");
    return;
  }
  state.launching = true;
  state.lastLaunchAt = Date.now();
  els.launch.disabled = true;

  // Open the terminal tab NOW, inside the click gesture, so popup blockers
  // let it through. It shows a loading page and is navigated to the real
  // terminal URL once the codespace is up. If the browser blocks it anyway,
  // termWin is null and we fall back to the manual "Open terminal" button.
  const termWin = window.open("", "_blank");
  writeLoadingPage(termWin, "Provisioning your codespace …");

  try {
    setStatus("looking for an existing codespace …", true);
    const { codespaces = [] } = await gh(
      `/repos/${cfg.owner}/${cfg.repo}/codespaces`,
    );
    let cs = codespaces.find((c) => c.state !== "Deleted" && c.state !== "Failed");

    if (cs && (cs.state === "Shutdown" || cs.state === "Archived")) {
      setStatus(`restarting ${cs.name} …`, true);
      cs = await gh(`/user/codespaces/${encodeURIComponent(cs.name)}/start`, { method: "POST" });
    } else if (!cs) {
      setStatus("creating a fresh codespace …", true);
      cs = await gh(`/repos/${cfg.owner}/${cfg.repo}/codespaces`, {
        method: "POST",
        body: JSON.stringify({
          ref: cfg.ref,
          idle_timeout_minutes: cfg.idleTimeoutMinutes, // lifecycle safety net
        }),
      });
    }

    state.codespaceName = cs.name;
    cs = await pollUntilAvailable(cs.name);

    const url = terminalUrl(cs.name);
    els.open.href = url;
    els.open.classList.remove("hidden");
    els.stop.classList.remove("hidden");
    els.del.classList.remove("hidden");

    // Give the bridge a moment to start listening, then navigate the tab.
    setStatus(`ready — ${cs.name}; opening terminal …`, true);
    writeLoadingPage(termWin, "Codespace ready — starting the terminal …");
    await new Promise((r) => setTimeout(r, BRIDGE_GRACE_MS));
    if (termWin && !termWin.closed) {
      termWin.location.href = url;
    } else {
      // Popup was blocked or closed: prompt the user to use the button.
      setStatus(`ready — ${cs.name}. Click “Open terminal ↗”.`, true);
    }
  } catch (err) {
    setStatus(`Launch failed: ${err.message}`);
    writeLoadingPage(termWin, `Launch failed: ${err.message}`);
  } finally {
    state.launching = false;
    els.launch.disabled = false;
  }
});

/** Render a minimal status page into the opened terminal tab. */
function writeLoadingPage(win, message) {
  if (!win || win.closed) return;
  try {
    win.document.title = "Spacehatch — terminal";
    win.document.body.style.cssText =
      "margin:0;height:100vh;display:flex;align-items:center;justify-content:center;" +
      "background:#0a0e12;color:#f2a33c;font-family:ui-monospace,Menlo,monospace;font-size:14px";
    win.document.body.textContent = message;
  } catch {
    /* cross-origin after navigation: nothing to do */
  }
}

els.stop.addEventListener("click", async () => {
  if (!state.codespaceName) return;
  els.stop.disabled = true;
  try {
    setStatus("stopping …", true);
    await gh(`/user/codespaces/${encodeURIComponent(state.codespaceName)}/stop`, {
      method: "POST",
    });
    setStatus("codespace stopped — compute billing ended");
    els.open.classList.add("hidden");
  } catch (err) {
    setStatus(`Stop failed: ${err.message}`);
  } finally {
    els.stop.disabled = false;
  }
});

els.del.addEventListener("click", async () => {
  if (!state.codespaceName) return;
  els.del.disabled = true;
  try {
    setStatus("deleting …", true);
    await gh(`/user/codespaces/${encodeURIComponent(state.codespaceName)}`, {
      method: "DELETE",
    });
    setStatus("codespace deleted");
    state.codespaceName = null;
    els.open.classList.add("hidden");
    els.stop.classList.add("hidden");
    els.del.classList.add("hidden");
  } catch (err) {
    setStatus(`Delete failed: ${err.message}`);
  } finally {
    els.del.disabled = false;
  }
});
