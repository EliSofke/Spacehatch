# One-Click Cloud Terminal from a Repo Landing Page

A visitor clicks one button on a static landing page and gets an interactive shell — rendered with xterm.js in the browser — inside a GitHub Codespace for a fixed repository. No VS Code UI, no local software. The Codespace runs on GitHub's infrastructure; this backend only orchestrates and bridges.

```
Browser ── xterm.js + AttachAddon ── WebSocket ──┐
                                                 │
                       Node.js/Express backend   │
                       ├─ GitHub REST API  ──────┼── create / poll / stop / delete Codespace
                       └─ ssh2 client ── stdio ──┴── `gh codespace ssh --stdio` tunnel
                                                        │
                                                 GitHub Codespace (sshd)
```

## Project structure

```
.
├── frontend/            Static landing page (vanilla JS + xterm.js from CDN)
│   ├── index.html
│   └── app.js
├── backend/
│   ├── src/
│   │   ├── server.ts        Express app, OAuth flow, REST endpoints, WS upgrade
│   │   ├── config.ts        Environment configuration, fail-fast validation
│   │   ├── sessions.ts      Server-side token store + signed httpOnly cookie
│   │   ├── githubApi.ts     Documented REST calls (create/poll/start/stop/delete)
│   │   └── ssh/
│   │       ├── ghTransport.ts   ⚠ the ONLY undocumented-behavior module (gh tunnel)
│   │       └── bridge.ts        WebSocket ⇄ SSH PTY bridge, resize protocol, idle timeout
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
└── README.md
```

## Prerequisites

- Node.js ≥ 18 (tested with 22)
- GitHub CLI `gh` ≥ 2.40 installed on the backend host and on `PATH`
  (used **only** as the tunnel transport; it authenticates from the per-user
  OAuth token via `GH_TOKEN`, no `gh auth login` needed)
- A GitHub account with access to the target repository and Codespaces enabled

## Setup

### 1. Register a GitHub OAuth App

GitHub → Settings → Developer settings → **OAuth Apps** → *New OAuth App*:

- **Homepage URL:** `http://localhost:3000` (or your public base URL)
- **Authorization callback URL:** `http://localhost:3000/auth/callback`
  — must match `BASE_URL` + `/auth/callback` exactly.

Copy the *Client ID* and generate a *Client secret*.

Scopes are requested at runtime by the backend: `codespace` (full Codespaces
lifecycle + tunnel access) and `repo` (required if the target repository is
private; you can remove it from `server.ts` for public repos).

### 2. Configure and run the backend

```bash
cd backend
cp .env.example .env        # fill in client id/secret, owner/repo, session secret
npm install
npm run build
npm start
```

The backend serves the frontend statically, so opening
`http://localhost:3000` is all you need.

### 3. Use it

1. **Sign in with GitHub** → OAuth consent → back on the page.
2. **Launch cloud terminal** → the page shows the Codespace state
   (`Queued → Provisioning → Starting → Available`; a cold create takes
   1–4 minutes, a restart ~30 s).
3. The terminal attaches automatically. **Stop codespace** ends compute
   billing; `DELETE /api/codespaces/:name?purge=true` removes the machine
   entirely.

## How each requirement is met

| Requirement | Implementation |
|---|---|
| Create + start Codespace | `POST /repos/{owner}/{repo}/codespaces` (documented REST), reuse-or-start logic in `POST /api/codespaces` |
| Poll until `Available` | Frontend polls `GET /api/codespaces/:name` (backed by `GET /user/codespaces/{name}`) every 2.5 s |
| SSH, not VS Code Server API | `ssh2` client speaking real SSH over a raw byte tunnel provided by `gh codespace ssh --stdio` |
| WebSocket bridging | `ws` server; text frames = keystrokes, binary frames = shell output; binary frames with magic `\0CTL` = JSON control (resize) |
| xterm.js + AttachAddon | `frontend/app.js`, with FitAddon and out-of-band resize frames |
| Token never in frontend | Token lives in an in-memory server session; browser holds only an HMAC-signed, httpOnly, SameSite=Lax cookie |
| Rate limiting | `express-rate-limit`, 3 launches/min, plus reuse of an existing Codespace instead of creating duplicates |
| Idle lifecycle | Bridge-level byte-flow timeout (`IDLE_TIMEOUT_MS`) stops the Codespace; GitHub-side `idle_timeout_minutes` as safety net if the backend dies |
| Error handling | 401/403 from GitHub → session invalidated, frontend returns to login; gh tunnel death and SSH disconnects close the WS with a reason string shown in the terminal |

## Security assumptions and open risks

**Assumptions**

1. **Token confinement.** The OAuth access token is held only in backend
   memory and passed to `gh` via environment variable (never argv, never
   disk). Anyone who can read backend process memory owns the tokens — run
   the backend on trusted infrastructure only.
2. **Session cookie = full shell access.** Whoever presents a valid session
   cookie gets an interactive shell in that user's Codespace. Serve
   exclusively over HTTPS in any non-local deployment (the cookie's `secure`
   flag follows `BASE_URL`), and keep `SESSION_SECRET` truly secret.
3. **Host key checking is disabled by design.** The Codespace's SSH host key
   is generated per machine and reached only through a GitHub-authenticated
   tunnel; there is no out-of-band channel to pin it. `gh`'s own generated
   ssh config makes the same trade-off. A MITM would require compromising
   the tunnel itself.
4. **One session ↔ one Codespace.** The WS upgrade only accepts the Codespace
   name stored in the caller's own session, so sessions cannot attach to
   arbitrary Codespace names.

**Open risks / known instabilities**

1. **⚠ Undocumented transport (`backend/src/ssh/ghTransport.ts`).**
   Codespaces expose no public SSH endpoint; connectivity goes through
   Microsoft Dev Tunnels via an internal API. We deliberately delegate that
   hop to `gh codespace ssh --stdio` instead of re-implementing the
   protocol. Both `--stdio` and the output format of
   `gh codespace ssh --config` (parsed for `User` and `IdentityFile`) are
   CLI behavior, not an API contract — a `gh` release can break this module.
   It is isolated so that a fix touches exactly one file.
2. **Key material on disk.** `gh` generates `~/.ssh/codespaces.auto` on the
   backend host and authorizes it in Codespaces reachable by the token. The
   prototype shares this keypair across all users on the host; per-user
   `HOME`/key isolation is the first hardening step for multi-tenant use.
3. **In-memory sessions.** A backend restart logs everyone out and forgets
   which Codespaces it manages (GitHub's own idle timeout then catches
   stragglers). Production: external session store + startup reconciliation
   via `GET /user/codespaces`.
4. **OAuth app tokens don't expire by default**, but users can revoke them;
   every GitHub call maps 401/403 to a forced re-login.
5. **Billing.** Codespaces bill the *user's* account (or the org, if
   configured). The rate limiter and reuse logic prevent accidental fleets,
   but a hostile user can still burn their own quota.
6. **No CSRF token on state-changing routes** beyond `SameSite=Lax` — fine
   for a prototype, add a CSRF token or `Origin` check before production.

## API surface (backend)

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/login` | Redirect to GitHub OAuth consent |
| GET | `/auth/callback` | Code→token exchange, session creation |
| POST | `/auth/logout` | Destroy session |
| GET | `/api/session` | Auth status + configured repo |
| POST | `/api/codespaces` | Launch (reuse → start → create), rate-limited |
| GET | `/api/codespaces/:name` | State polling |
| DELETE | `/api/codespaces/:name` | Stop (`?purge=true` → delete) |
| WS | `/ws/terminal?codespace=…&cols=…&rows=…` | Shell bridge |
