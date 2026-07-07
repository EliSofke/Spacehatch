"use strict";
/**
 * Terminal bridge — runs INSIDE the codespace (started by postStartCommand).
 *
 * Pure-browser architecture: there is no external backend. This process
 * serves the terminal page and a WebSocket-attached PTY on one port. The
 * port is forwarded PRIVATELY by Codespaces, so GitHub's own auth wall
 * (cookie-based, codespace creator only) guards every request — including
 * the WebSocket handshake, because the page is served from the SAME origin
 * as the socket. Nothing here must ever run on a PUBLIC port.
 *
 * Wire protocol (identical to variant A, backend/src/ssh/bridge.ts):
 *  - TEXT frames client -> server: raw keystrokes -> written to the PTY
 *  - BINARY frames with 4-byte magic "\0CTL" + JSON: control messages,
 *    currently { type: "resize", cols, rows }
 *  - BINARY frames server -> client: raw PTY output
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");

const PORT = Number(process.env.BRIDGE_PORT || 7681);
/** Kill idle shells (no bytes either direction). The VM itself is stopped by
 *  the Codespace idle timeout, set at creation time by the landing page. */
const IDLE_MS = Number(process.env.BRIDGE_IDLE_MS || 10 * 60 * 1000);
/** Optional defense in depth: if set, clients must present it as ?auth=…
 *  (the terminal page reads it from location.hash). Empty = rely on the
 *  private-port auth wall alone. */
const SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET || "";

const CONTROL_MAGIC = Buffer.from("\x00CTL", "latin1");

/** Start shells in the repo checkout: /workspaces/<repo>. */
function workspaceDir() {
  const repo = (process.env.GITHUB_REPOSITORY || "").split("/")[1] || "";
  const candidate = path.join("/workspaces", repo);
  try {
    if (repo && fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    /* fall through */
  }
  return process.env.HOME || "/";
}

const pageHtml = fs.readFileSync(path.join(__dirname, "terminal.html"));

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // The page embeds nothing sensitive, but keep it out of caches anyway.
      "cache-control": "no-store",
    });
    res.end(pageHtml);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  // Same-origin guard: the only legitimate client is the page this very
  // server just served. Blocks cross-site WebSocket hijacking even if the
  // port is ever (mis)configured as public.
  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== req.headers.host) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  if (SHARED_SECRET && url.searchParams.get("auth") !== SHARED_SECRET) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => attachShell(ws, url));
});

function attachShell(ws, url) {
  const cols = Math.min(500, Math.max(20, Number(url.searchParams.get("cols") || 80)));
  const rows = Math.min(200, Math.max(5, Number(url.searchParams.get("rows") || 24)));

  const shell = pty.spawn(process.env.SHELL || "bash", ["-il"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: workspaceDir(),
    env: process.env,
  });

  let idleTimer;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      ws.send(`\r\n\x1b[2m[bridge] idle for ${Math.round(IDLE_MS / 1000)}s — closing shell\x1b[0m\r\n`);
      teardown(4000, "idle timeout");
    }, IDLE_MS);
  };

  let closed = false;
  const teardown = (code, reason) => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    try {
      shell.kill();
    } catch {
      /* already dead */
    }
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(code, reason);
    }
  };

  shell.onData((data) => {
    armIdleTimer();
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, "utf8"));
  });
  shell.onExit(() => teardown(1000, "shell exited"));

  ws.on("message", (data, isBinary) => {
    armIdleTimer();
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

    if (isBinary && buf.subarray(0, 4).equals(CONTROL_MAGIC)) {
      try {
        const msg = JSON.parse(buf.subarray(4).toString("utf8"));
        if (msg.type === "resize" && msg.cols && msg.rows) {
          shell.resize(
            Math.min(500, Math.max(20, msg.cols)),
            Math.min(200, Math.max(5, msg.rows)),
          );
        }
      } catch {
        /* malformed control frame: ignore, never forward to the shell */
      }
      return;
    }
    shell.write(buf.toString("utf8"));
  });

  ws.on("close", () => teardown(1000, "client closed"));
  ws.on("error", () => teardown(1011, "client error"));
  armIdleTimer();
}

server.listen(PORT, () => {
  console.log(`[bridge] terminal bridge on :${PORT} (cwd for shells: ${workspaceDir()})`);
});
