import dotenv from "dotenv";

dotenv.config();

/**
 * Central configuration, read once at startup.
 * Fail fast: missing mandatory values abort the process with a clear message
 * instead of failing later inside an OAuth redirect or an API call.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // eslint-disable-next-line no-console
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  /** Port the Express server listens on. */
  port: Number(process.env.PORT ?? 3000),

  /** Public base URL of this service; used to build the OAuth callback URL. */
  baseUrl: process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,

  /** GitHub OAuth App credentials (Settings -> Developer settings -> OAuth Apps). */
  githubClientId: required("GITHUB_CLIENT_ID"),
  githubClientSecret: required("GITHUB_CLIENT_SECRET"),

  /** The one fixed repository this landing page launches a Codespace for. */
  owner: required("GITHUB_OWNER"),
  repo: required("GITHUB_REPO"),
  /** Git ref to create the Codespace on. */
  ref: process.env.GITHUB_REF ?? "main",
  /** Optional machine type, e.g. "basicLinux32gb". Empty = GitHub default. */
  machine: process.env.CODESPACE_MACHINE ?? "",

  /** Secret used to HMAC-sign the session cookie. Must be long and random. */
  sessionSecret: required("SESSION_SECRET"),

  /**
   * Inactivity timeout of the *bridge*: if no bytes flow in either direction
   * for this long, the WebSocket is closed and the Codespace is stopped.
   * This is independent of GitHub's own idle timeout.
   */
  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS ?? 10 * 60 * 1000),

  /**
   * Idle timeout GitHub applies to the Codespace itself (server-side safety
   * net in case this backend dies while a Codespace is running).
   */
  codespaceIdleTimeoutMinutes: Number(process.env.CODESPACE_IDLE_TIMEOUT_MINUTES ?? 30),

  /** Session lifetime; after this the user has to re-authenticate. */
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 8 * 60 * 60 * 1000),
} as const;
