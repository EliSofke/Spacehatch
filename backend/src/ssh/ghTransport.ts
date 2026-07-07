import { spawn, execFile } from "node:child_process";
import { Duplex } from "node:stream";
import fs from "node:fs/promises";

/**
 * ============================================================================
 *  WARNING — this module is the ONE place that relies on UNDOCUMENTED /
 *  semi-stable GitHub behavior. Everything else in the backend uses the
 *  documented REST API.
 *
 *  Background: Codespaces do not expose a public SSH endpoint. The `gh` CLI
 *  reaches them through Microsoft Dev Tunnels using an internal connection
 *  API. Re-implementing that protocol would tie us to internals that change
 *  without notice, so instead we delegate exactly that hop to `gh`:
 *
 *    1. `gh codespace ssh --config`
 *       Prints an OpenSSH config per Codespace, including the remote `User`
 *       and the generated `IdentityFile` (~/.ssh/codespaces.auto). The flag
 *       exists and is listed in `gh codespace ssh --help`, but the output
 *       FORMAT is not a stable contract — we parse it defensively.
 *
 *    2. `gh codespace ssh -c <name> --stdio`
 *       Opens the tunnel to the Codespace's SSH server and pipes raw SSH
 *       bytes over stdio (this is what the ProxyCommand in the generated
 *       config uses). We hand that stdio pair to `ssh2` as its socket, so
 *       the actual SSH client (auth, channel, PTY) is fully under our
 *       control — no VS Code Server API involved.
 *
 *  If GitHub changes these flags, this module is the only thing to fix.
 * ============================================================================
 */

export interface SshTarget {
  /** Remote user inside the Codespace (usually "codespace" or "vscode"). */
  user: string;
  /** Path to the private key gh generated and authorized in the Codespace. */
  privateKey: Buffer;
}

export class GhCliError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = "GhCliError";
  }
}

function ghEnv(token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // gh authenticates non-interactively from GH_TOKEN; the token never
    // touches the command line (visible in `ps`) or any file.
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

/**
 * Discover user + identity file for a Codespace by parsing
 * `gh codespace ssh --config`. Calling this also makes gh generate the
 * keypair (~/.ssh/codespaces.auto) if it does not exist yet and register
 * the public key with the Codespaces SSH server.
 */
export async function resolveSshTarget(token: string, codespaceName: string): Promise<SshTarget> {
  const configText = await new Promise<string>((resolve, reject) => {
    execFile(
      "gh",
      ["codespace", "ssh", "--config"],
      { env: ghEnv(token), timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GhCliError(`gh codespace ssh --config failed: ${err.message}`, stderr));
        } else {
          resolve(stdout);
        }
      },
    );
  });

  // Defensive parse of OpenSSH-config-shaped output:
  //   Host cs.<name>.<suffix>
  //     User codespace
  //     IdentityFile /home/x/.ssh/codespaces.auto
  //     ...
  let inMatchingHost = false;
  let user: string | undefined;
  let identityFile: string | undefined;

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const hostMatch = /^Host\s+(\S+)/i.exec(line);
    if (hostMatch && hostMatch[1]) {
      inMatchingHost = hostMatch[1].includes(codespaceName);
      continue;
    }
    if (!inMatchingHost) continue;

    const kv = /^(\w[\w-]*)[\s=]+(.+)$/.exec(line);
    if (!kv || !kv[1] || !kv[2]) continue;
    const key = kv[1].toLowerCase();
    if (key === "user") user = kv[2].trim();
    if (key === "identityfile") identityFile = kv[2].trim();
  }

  if (!user || !identityFile) {
    throw new GhCliError(
      `Could not find SSH parameters for Codespace "${codespaceName}" in gh's ssh config. ` +
        `Is the Codespace running, and does the token have the "codespace" scope?`,
    );
  }

  const keyPath = identityFile.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  const privateKey = await fs.readFile(keyPath);
  return { user, privateKey };
}

export interface TunnelHandle {
  /** Duplex stream carrying raw SSH bytes; passed to ssh2 as `sock`. */
  sock: Duplex;
  /** Terminate the gh child process (tears the tunnel down). */
  close: () => void;
  /** Resolves/rejects when the gh process exits. */
  exited: Promise<void>;
}

/**
 * Open the raw byte tunnel to the Codespace's SSH server.
 * Equivalent to the ProxyCommand from the generated ssh config.
 */
export function openTunnel(token: string, codespaceName: string): TunnelHandle {
  const child = spawn("gh", ["codespace", "ssh", "-c", codespaceName, "--stdio"], {
    env: ghEnv(token),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  const sock = Duplex.from({ readable: child.stdout, writable: child.stdin });

  const exited = new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new GhCliError(`gh tunnel exited with code ${code}`, stderrTail));
    });
    child.on("error", (err) => reject(new GhCliError(`gh not runnable: ${err.message}`)));
  });
  // The bridge attaches its own handlers; avoid unhandled-rejection noise if
  // the tunnel dies after the bridge already cleaned up.
  exited.catch(() => {});

  return {
    sock,
    close: () => {
      child.stdin.destroy();
      child.kill("SIGTERM");
    },
    exited,
  };
}
