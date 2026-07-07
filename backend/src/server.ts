import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config";
import {
  createSession,
  destroySession,
  invalidateSession,
  sessionFromCookieValue,
  sessionFromRequest,
  cookieName,
  type Session,
} from "./sessions";
import {
  GitHubApiError,
  createCodespace,
  getCodespace,
  getViewerLogin,
  listRepoCodespaces,
  startCodespace,
  stopCodespace,
  deleteCodespace,
} from "./githubApi";
import { bridgeWebSocketToCodespace } from "./ssh/bridge";
import { GhCliError } from "./ssh/ghTransport";

const app = express();
app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "..", "frontend")));

// ---------------------------------------------------------------------------
// OAuth (GitHub OAuth App flow, scope "codespace")
// ---------------------------------------------------------------------------

/** Pending OAuth `state` values -> issued-at, to block CSRF on the callback. */
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

app.get("/auth/login", (_req, res) => {
  const state = crypto.randomBytes(16).toString("base64url");
  pendingStates.set(state, Date.now());

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.githubClientId);
  url.searchParams.set("redirect_uri", `${config.baseUrl}/auth/callback`);
  // "codespace" grants full Codespaces control. Private repos additionally
  // need "repo" — see README.
  url.searchParams.set("scope", "codespace repo");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  const issuedAt = state ? pendingStates.get(state) : undefined;
  if (state) pendingStates.delete(state);

  if (!code || !state || issuedAt === undefined || Date.now() - issuedAt > STATE_TTL_MS) {
    res.status(400).send("OAuth state invalid or expired. Start again at /auth/login.");
    return;
  }

  try {
    // Exchange the code server-to-server; the client secret never leaves here.
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
        redirect_uri: `${config.baseUrl}/auth/callback`,
      }),
    });
    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
      error_description?: string;
    };
    if (!tokenBody.access_token) {
      res.status(502).send(`Token exchange failed: ${tokenBody.error_description ?? "unknown"}`);
      return;
    }

    const login = await getViewerLogin(tokenBody.access_token);
    createSession(res, tokenBody.access_token, login);
    res.redirect("/");
  } catch (err) {
    res.status(502).send(`OAuth callback failed: ${(err as Error).message}`);
  }
});

app.post("/auth/logout", (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Session-guarded API
// ---------------------------------------------------------------------------

interface AuthedRequest extends Request {
  session: Session;
}

function requireSession(req: Request, res: Response, next: NextFunction): void {
  const session = sessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: "not_authenticated", loginUrl: "/auth/login" });
    return;
  }
  (req as AuthedRequest).session = session;
  next();
}

/** Map GitHub/gh errors to consistent JSON, invalidating dead tokens. */
function handleApiError(err: unknown, session: Session, res: Response): void {
  if (err instanceof GitHubApiError) {
    if (err.isAuthError) {
      invalidateSession(session); // token expired or revoked -> force re-login
      res.status(401).json({ error: "token_expired", loginUrl: "/auth/login" });
      return;
    }
    res.status(err.status).json({ error: "github_api", message: err.message });
    return;
  }
  if (err instanceof GhCliError) {
    res.status(502).json({ error: "gh_cli", message: err.message, detail: err.stderr });
    return;
  }
  res.status(500).json({ error: "internal", message: (err as Error).message });
}

app.get("/api/session", (req, res) => {
  const session = sessionFromRequest(req);
  const defaultRepo = config.owner && config.repo ? `${config.owner}/${config.repo}` : "";
  const base = { defaultRepo, allowRepoOverride: config.allowRepoOverride };
  res.json(
    session
      ? { authenticated: true, login: session.login, ...base }
      : { authenticated: false, loginUrl: "/auth/login", ...base },
  );
});

/**
 * Rate limit on Codespace creation: double clicks and reload loops must not
 * spawn billable machines. 3 requests/min per client, on top of the reuse
 * logic below.
 */
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many launch attempts; wait a minute." },
});

/** Owner/repo name validation: GitHub's allowed character set, no path tricks. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * POST /api/codespaces
 * Idempotent-ish launch: reuse an existing Codespace of this user for the
 * target repo (starting it if stopped), otherwise create a new one.
 *
 * Repo-agnostic: owner/repo may be supplied per request (when
 * ALLOW_REPO_OVERRIDE is on), so a single deployment launches a Codespace for
 * any repo the user's token can open — the target repo needs no artifacts.
 */
app.post("/api/codespaces", requireSession, createLimiter, async (req, res) => {
  const { session } = req as AuthedRequest;

  const body = (req.body ?? {}) as { owner?: string; repo?: string };
  const owner = config.allowRepoOverride && body.owner ? body.owner : config.owner;
  const repo = config.allowRepoOverride && body.repo ? body.repo : config.repo;
  if (!owner || !repo) {
    res.status(400).json({ error: "missing_repo", message: "owner and repo are required" });
    return;
  }
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) {
    res.status(400).json({ error: "invalid_repo", message: "owner/repo contain invalid characters" });
    return;
  }

  try {
    const existing = await listRepoCodespaces(session.accessToken, owner, repo);
    let cs = existing.find((c) => c.state !== "Deleted" && c.state !== "Failed");

    if (cs && (cs.state === "Shutdown" || cs.state === "Archived")) {
      cs = await startCodespace(session.accessToken, cs.name);
    } else if (!cs) {
      cs = await createCodespace(session.accessToken, owner, repo, config.ref, {
        machine: config.machine || undefined,
        idleTimeoutMinutes: config.codespaceIdleTimeoutMinutes,
      });
    }

    session.codespaceName = cs.name;
    res.status(202).json({ name: cs.name, state: cs.state });
  } catch (err) {
    handleApiError(err, session, res);
  }
});

/** GET /api/codespaces/:name — polled by the frontend until "Available". */
app.get("/api/codespaces/:name", requireSession, async (req, res) => {
  const { session } = req as AuthedRequest;
  const name = req.params.name ?? "";
  try {
    const cs = await getCodespace(session.accessToken, name);
    res.json({ name: cs.name, state: cs.state });
  } catch (err) {
    handleApiError(err, session, res);
  }
});

/**
 * DELETE /api/codespaces/:name — manual cleanup endpoint.
 * Default: stop (keeps the machine, compute billing ends).
 * ?purge=true: delete the Codespace entirely.
 */
app.delete("/api/codespaces/:name", requireSession, async (req, res) => {
  const { session } = req as AuthedRequest;
  const name = req.params.name ?? "";
  try {
    if (req.query.purge === "true") {
      await deleteCodespace(session.accessToken, name);
    } else {
      await stopCodespace(session.accessToken, name);
    }
    if (session.codespaceName === name) session.codespaceName = undefined;
    res.json({ ok: true });
  } catch (err) {
    handleApiError(err, session, res);
  }
});

// ---------------------------------------------------------------------------
// WebSocket: /ws/terminal?codespace=<name>&cols=<n>&rows=<n>
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", config.baseUrl);
  if (url.pathname !== "/ws/terminal") {
    socket.destroy();
    return;
  }

  // Authenticate the upgrade with the same signed cookie as the HTTP API.
  const cookieHeader = req.headers.cookie ?? "";
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  const session = sessionFromCookieValue(raw ? decodeURIComponent(raw) : undefined);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const codespaceName = url.searchParams.get("codespace");
  // Only the Codespace this session launched may be attached to — a session
  // cannot probe arbitrary Codespace names.
  if (!codespaceName || codespaceName !== session.codespaceName) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const cols = Math.min(500, Math.max(20, Number(url.searchParams.get("cols") ?? 80)));
  const rows = Math.min(200, Math.max(5, Number(url.searchParams.get("rows") ?? 24)));

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    void bridgeWebSocketToCodespace(ws, {
      token: session.accessToken,
      codespaceName,
      idleTimeoutMs: config.idleTimeoutMs,
      cols,
      rows,
      onIdle: () => {
        stopCodespace(session.accessToken, codespaceName).catch((err) =>
          console.error(`[lifecycle] failed to stop ${codespaceName}:`, err),
        );
      },
    }).catch((err: Error) => {
      console.error("[bridge] failed:", err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\x1b[31m[bridge] connection failed: ${err.message}\x1b[0m\r\n`);
        ws.close(1011, "bridge failed");
      }
    });
  });
});

server.listen(config.port, () => {
  const repoInfo =
    config.owner && config.repo
      ? `default repo: ${config.owner}/${config.repo}`
      : "repo-agnostic (owner/repo per request)";
  console.log(`[server] listening on ${config.baseUrl} (${repoInfo})`);
});
