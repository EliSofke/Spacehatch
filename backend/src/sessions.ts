import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "./config";

/**
 * Minimal server-side session store.
 *
 * Security model:
 *  - The GitHub access token NEVER leaves the server. The browser only holds
 *    an opaque, HMAC-signed session id in an httpOnly cookie.
 *  - Sessions live in memory. That is acceptable for a prototype; for
 *    production, swap this Map for Redis or an encrypted database and the
 *    reasoning below still holds.
 */

export interface Session {
  id: string;
  /** GitHub OAuth access token with "codespace" scope. Server-side only. */
  accessToken: string;
  /** GitHub login of the authenticated user (for display). */
  login: string;
  createdAt: number;
  /** Name of the Codespace this session currently controls, if any. */
  codespaceName?: string;
}

const COOKIE_NAME = "cst_session";
const sessions = new Map<string, Session>();

function sign(value: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

/** Constant-time comparison to avoid timing side channels on the signature. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function createSession(res: Response, accessToken: string, login: string): Session {
  const id = crypto.randomBytes(32).toString("base64url");
  const session: Session = { id, accessToken, login, createdAt: Date.now() };
  sessions.set(id, session);

  res.cookie(COOKIE_NAME, `${id}.${sign(id)}`, {
    httpOnly: true, // not readable from JS -> token id cannot be exfiltrated via XSS
    sameSite: "lax", // survives the OAuth top-level redirect, blocks CSRF POSTs
    secure: config.baseUrl.startsWith("https://"),
    maxAge: config.sessionTtlMs,
    path: "/",
  });
  return session;
}

/** Resolve the session from a cookie header value (used by HTTP and WS upgrade). */
export function sessionFromCookieValue(raw: string | undefined): Session | undefined {
  if (!raw) return undefined;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEqual(sig, sign(id))) return undefined;

  const session = sessions.get(id);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > config.sessionTtlMs) {
    sessions.delete(id);
    return undefined;
  }
  return session;
}

export function sessionFromRequest(req: Request): Session | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return sessionFromCookieValue(cookies?.[COOKIE_NAME]);
}

export function destroySession(req: Request, res: Response): void {
  const session = sessionFromRequest(req);
  if (session) sessions.delete(session.id);
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

/** Invalidate a session whose token GitHub rejected (expired / revoked). */
export function invalidateSession(session: Session): void {
  sessions.delete(session.id);
}

export const cookieName = COOKIE_NAME;
