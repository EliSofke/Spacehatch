import { Client, type ClientChannel } from "ssh2";
import type { WebSocket, RawData } from "ws";
import { openTunnel, resolveSshTarget, GhCliError } from "./ghTransport";

/**
 * Bridges one browser WebSocket to one interactive shell inside a Codespace.
 *
 * Wire protocol (matches frontend/app.js):
 *  - Browser -> server, TEXT frames: raw keystrokes (sent by xterm.js
 *    AttachAddon) -> written verbatim to the PTY.
 *  - Browser -> server, BINARY frames starting with the 4-byte magic
 *    "\x00CTL": JSON control messages, currently { type: "resize", cols, rows }.
 *    Binary frames without the magic are treated as raw input (AttachAddon
 *    emits binary for some terminal reports).
 *  - Server -> browser, BINARY frames: raw shell output. Binary (not text)
 *    on purpose: UTF-8 sequences may be split across chunks, and xterm.js
 *    reassembles them correctly from bytes.
 */

const CONTROL_MAGIC = Buffer.from("\x00CTL", "latin1");

export interface BridgeOptions {
  token: string;
  codespaceName: string;
  /** Close everything and invoke onIdle after this much silence. */
  idleTimeoutMs: number;
  /** Called on idle timeout, so the caller can stop the Codespace. */
  onIdle: () => void;
  /** Initial terminal geometry from the client (query parameters). */
  cols: number;
  rows: number;
}

export async function bridgeWebSocketToCodespace(
  ws: WebSocket,
  options: BridgeOptions,
): Promise<void> {
  const { token, codespaceName, idleTimeoutMs, onIdle } = options;

  const sendStatus = (text: string) => {
    // Human-readable progress lines before the PTY exists; rendered by xterm.
    if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[2m[bridge] ${text}\x1b[0m\r\n`);
  };

  let shell: ClientChannel | undefined;
  let closed = false;

  // --- Idle timeout: any byte in either direction resets the clock. -------
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      sendStatus(`idle for ${Math.round(idleTimeoutMs / 1000)}s — stopping Codespace`);
      onIdle();
      teardown(1000, "idle timeout");
    }, idleTimeoutMs);
  };

  // --- Transport: gh tunnel (stdio) + ssh2 client on top. ------------------
  sendStatus(`resolving SSH parameters for ${codespaceName} …`);
  const target = await resolveSshTarget(token, codespaceName); // may throw GhCliError

  sendStatus("opening tunnel via gh …");
  const tunnel = openTunnel(token, codespaceName);
  const conn = new Client();

  const teardown = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    try {
      shell?.end();
    } catch {
      /* already gone */
    }
    conn.end();
    tunnel.close();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(code, reason.slice(0, 120));
    }
  };

  tunnel.exited.catch((err: GhCliError) => {
    sendStatus(`tunnel closed: ${err.message}`);
    teardown(1011, "tunnel closed");
  });

  ws.on("close", () => teardown(1000, "client closed"));
  ws.on("error", () => teardown(1011, "client error"));

  await new Promise<void>((resolve, reject) => {
    conn
      .on("ready", resolve)
      .on("error", (err) => {
        sendStatus(`SSH handshake failed: ${err.message}`);
        reject(err);
      })
      .connect({
        sock: tunnel.sock,
        username: target.user,
        privateKey: target.privateKey,
        // The Codespace SSH host key is ephemeral and reached through an
        // authenticated tunnel; gh's own config sets StrictHostKeyChecking=no
        // for the same reason. See README "Security assumptions".
        readyTimeout: 30_000,
      });
  });

  sendStatus("SSH ready — starting shell");

  shell = await new Promise<ClientChannel>((resolve, reject) => {
    conn.shell(
      { term: "xterm-256color", cols: options.cols, rows: options.rows },
      (err, stream) => (err ? reject(err) : resolve(stream)),
    );
  });

  // PTY -> browser
  shell.on("data", (chunk: Buffer) => {
    armIdleTimer();
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  shell.stderr.on("data", (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  shell.on("close", () => teardown(1000, "shell exited"));
  conn.on("close", () => teardown(1011, "ssh connection closed"));

  // Browser -> PTY
  ws.on("message", (data: RawData, isBinary: boolean) => {
    armIdleTimer();
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);

    if (isBinary && buf.subarray(0, 4).equals(CONTROL_MAGIC)) {
      try {
        const msg = JSON.parse(buf.subarray(4).toString("utf8")) as {
          type?: string;
          cols?: number;
          rows?: number;
        };
        if (msg.type === "resize" && msg.cols && msg.rows && shell) {
          // setWindow(rows, cols, heightPx, widthPx) — pixel sizes are unused.
          shell.setWindow(msg.rows, msg.cols, 0, 0);
        }
      } catch {
        /* malformed control frame: ignore, never forward to the shell */
      }
      return;
    }
    shell?.write(buf);
  });

  armIdleTimer();
}
