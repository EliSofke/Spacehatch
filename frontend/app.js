/**
 * Frontend controller for the one-click cloud terminal.
 *
 * Flow: session check -> launch (POST /api/codespaces) -> poll until
 * "Available" -> open WebSocket -> xterm.js + AttachAddon.
 *
 * Wire protocol (must match backend/src/ssh/bridge.ts):
 *  - TEXT frames to the server: raw keystrokes (sent by AttachAddon).
 *  - BINARY frames with 4-byte magic "\x00CTL" + JSON: control messages
 *    (currently only terminal resize).
 *  - BINARY frames from the server: raw shell output.
 */
"use strict";

const els = {
  login: document.getElementById("btn-login"),
  launch: document.getElementById("btn-launch"),
  stop: document.getElementById("btn-stop"),
  status: document.getElementById("status"),
  repoName: document.getElementById("repo-name"),
  led: document.getElementById("led"),
  bezelTitle: document.getElementById("bezel-title"),
  terminal: document.getElementById("terminal"),
};

const state = {
  codespaceName: null,
  ws: null,
  term: null,
  fitAddon: null,
};

const CONTROL_MAGIC = new Uint8Array([0x00, 0x43, 0x54, 0x4c]); // "\0CTL"

// Target repo: taken from ?owner=&repo=, else the backend's configured default.
// This lets one deployment launch a Codespace for any bare repo the token opens.
const qs = new URLSearchParams(window.location.search);
const target = { owner: qs.get("owner") || "", repo: qs.get("repo") || "" };

function setStatus(text, live = false) {
  els.status.textContent = text;
  els.status.classList.toggle("live", live);
}

function setConnectedUi(connected, title) {
  els.led.classList.toggle("on", connected);
  els.bezelTitle.textContent = title;
  els.stop.classList.toggle("hidden", !state.codespaceName);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Session or GitHub token expired -> back to login, with a clear message.
    setStatus("Session expired — sign in again.");
    els.login.classList.remove("hidden");
    els.launch.classList.add("hidden");
    throw new Error("not_authenticated");
  }
  if (!res.ok) {
    throw new Error(body.message || body.error || `HTTP ${res.status}`);
  }
  return body;
}

// --------------------------------------------------------------------------
// Boot: figure out whether the user is signed in.
// --------------------------------------------------------------------------
(async function boot() {
  try {
    const session = await api("/api/session");
    if (!target.owner || !target.repo) {
      // Fall back to the backend default when no ?owner=&repo= was given.
      const [o, r] = (session.defaultRepo || "").split("/");
      target.owner = target.owner || o || "";
      target.repo = target.repo || r || "";
    }
    els.repoName.textContent =
      target.owner && target.repo ? `${target.owner}/${target.repo}` : "(pass ?owner=…&repo=…)";
    if (session.authenticated) {
      els.launch.classList.remove("hidden");
      setStatus(`signed in as ${session.login}`);
      document.getElementById("whoami").textContent = `@${session.login}`;
    } else {
      els.login.classList.remove("hidden");
    }
  } catch (err) {
    setStatus(`Backend unreachable: ${err.message}`);
  }
})();

els.login.addEventListener("click", () => {
  window.location.href = "/auth/login";
});

// --------------------------------------------------------------------------
// Launch: create/reuse Codespace, poll until Available, then attach.
// --------------------------------------------------------------------------
els.launch.addEventListener("click", async () => {
  els.launch.disabled = true;
  try {
    setStatus("requesting codespace …", true);
    const created = await api("/api/codespaces", {
      method: "POST",
      body: JSON.stringify({ owner: target.owner, repo: target.repo }),
    });
    state.codespaceName = created.name;

    const cs = await pollUntilAvailable(created.name);
    setStatus(`codespace ${cs.name} is available`, true);
    attachTerminal(cs.name);
  } catch (err) {
    if (err.message !== "not_authenticated") {
      setStatus(`Launch failed: ${err.message}`);
    }
    els.launch.disabled = false;
  }
});

async function pollUntilAvailable(name) {
  const startedAt = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000; // provisioning a fresh machine can take minutes
  for (;;) {
    const cs = await api(`/api/codespaces/${encodeURIComponent(name)}`);
    if (cs.state === "Available") return cs;
    if (cs.state === "Failed" || cs.state === "Deleted") {
      throw new Error(`codespace entered state ${cs.state}`);
    }
    if (Date.now() - startedAt > TIMEOUT_MS) {
      throw new Error("timed out waiting for the codespace to become available");
    }
    setStatus(`codespace state: ${cs.state} …`, true);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

// --------------------------------------------------------------------------
// Terminal attach: xterm.js + AttachAddon on the backend WebSocket.
// --------------------------------------------------------------------------
function attachTerminal(name) {
  // Fresh terminal per session; dispose any previous one.
  if (state.term) state.term.dispose();

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    fontSize: 14,
    theme: {
      background: "#0a0e12",
      foreground: "#dfe6ea",
      cursor: "#f2a33c",
      selectionBackground: "#26303a",
    },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(els.terminal);
  fitAddon.fit();

  state.term = term;
  state.fitAddon = fitAddon;

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url =
    `${proto}//${window.location.host}/ws/terminal` +
    `?codespace=${encodeURIComponent(name)}&cols=${term.cols}&rows=${term.rows}`;

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer"; // AttachAddon writes ArrayBuffer output to the terminal
  state.ws = ws;

  ws.addEventListener("open", () => {
    // AttachAddon: terminal keystrokes -> ws (text frames),
    // ws messages -> terminal. Exactly the bidirectional glue we need.
    const attach = new AttachAddon.AttachAddon(ws, { bidirectional: true });
    term.loadAddon(attach);
    term.focus();
    setConnectedUi(true, `connected · ${name}`);
    setStatus("live", true);
    sendResize(); // ensure server-side PTY matches the fitted geometry
  });

  ws.addEventListener("close", (ev) => {
    setConnectedUi(false, "disconnected");
    setStatus(ev.reason ? `disconnected: ${ev.reason}` : "disconnected");
    els.launch.disabled = false;
    term.write("\r\n\x1b[2m[connection closed]\x1b[0m\r\n");
  });

  ws.addEventListener("error", () => {
    setStatus("WebSocket error — see console");
  });

  // Resize: AttachAddon carries no geometry, so we send it out-of-band as a
  // binary control frame the server distinguishes by the magic prefix.
  function sendResize() {
    if (ws.readyState !== WebSocket.OPEN) return;
    const payload = new TextEncoder().encode(
      JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
    );
    const frame = new Uint8Array(CONTROL_MAGIC.length + payload.length);
    frame.set(CONTROL_MAGIC, 0);
    frame.set(payload, CONTROL_MAGIC.length);
    ws.send(frame);
  }
  term.onResize(sendResize);
  window.addEventListener("resize", () => {
    fitAddon.fit(); // triggers term.onResize -> sendResize
  });
}

// --------------------------------------------------------------------------
// Manual cleanup: stop the Codespace and close the session.
// --------------------------------------------------------------------------
els.stop.addEventListener("click", async () => {
  if (!state.codespaceName) return;
  els.stop.disabled = true;
  try {
    setStatus("stopping codespace …", true);
    if (state.ws) state.ws.close(1000, "user stopped session");
    await api(`/api/codespaces/${encodeURIComponent(state.codespaceName)}`, {
      method: "DELETE",
    });
    setStatus("codespace stopped");
    state.codespaceName = null;
    setConnectedUi(false, "disconnected");
  } catch (err) {
    setStatus(`Stop failed: ${err.message}`);
  } finally {
    els.stop.disabled = false;
    els.launch.disabled = false;
  }
});
