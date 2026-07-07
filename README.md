# Spacehatch

One-click cloud terminal from a repo landing page. A visitor clicks one button on a static landing page and gets an interactive shell — rendered with xterm.js in the browser — inside a GitHub Codespace for a fixed repository. No VS Code UI, no local software. The Codespace runs on GitHub's infrastructure; the Spacehatch service only orchestrates and bridges.

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
├── frontend-pure/       Variant B: pure-browser landing page (GitHub Pages)
│   ├── index.html
│   └── app.js
├── .devcontainer/
│   ├── devcontainer.json    Ports 3000 + 7681, bridge autostart
│   ├── setup.sh / start-bridge.sh
│   └── terminal-bridge/     Variant B: in-codespace web terminal (ws + node-pty)
│       ├── server.js
│       ├── terminal.html
│       └── test/bridge.test.js
└── README.md
```

Three variants live side by side. **Variant A** (backend service) is described
above; **Variant B** (pure browser, no backend, PAT entry) and **Variant C**
(static + minimal OAuth exchange function, no token entry) are described in
their own sections below.

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

---

## Variant B — pure browser, no backend

Everything above assumed a Node.js bridge service. Variant B removes it
entirely: a **static page** (hostable on GitHub Pages) plus a tiny
**terminal server running inside the codespace itself**.

```
Browser ── fetch ──────────────► api.github.com   (create / poll / stop / delete)
Browser ── https + WebSocket ──► <codespace>-7681.app.github.dev
                                   └─ terminal-bridge (ws + node-pty) inside the codespace
```

### How it works

1. `frontend-pure/index.html` asks for a **personal access token** with the
   `codespace` scope (plus `repo` access for private repositories). The token
   lives in tab memory only. A full OAuth flow is impossible without a server:
   `api.github.com` is CORS-enabled, but the token-exchange endpoints on
   `github.com/login/oauth/*` reject cross-origin requests by design.
2. The page calls the documented REST API directly from the browser:
   reuse → start → create, then polls until `Available`. The creation request
   sets `idle_timeout_minutes`, which is the lifecycle safety net — with no
   server of our own, GitHub's idle timeout stops forgotten machines.
3. The devcontainer starts `.devcontainer/terminal-bridge/server.js` on port
   **7681** (`postStartCommand`). It serves the xterm.js terminal page and a
   WebSocket-attached PTY — same wire protocol as Variant A (text = input,
   `\0CTL`+JSON = resize, binary = output).
4. The port stays **private**. GitHub's port-forwarding auth wall (cookie
   based, codespace creator only, 3 h expiry) guards both the page and the
   WebSocket, because both share the same origin — this same-origin trick is
   what makes the private port workable without any token handling.

### Setup

1. Edit the config block at the bottom of `frontend-pure/index.html`
   (`owner`, `repo`, `ref`) — or pass `?owner=…&repo=…` as URL parameters.
2. Enable GitHub Pages for the repository (Settings → Pages → Source:
   GitHub Actions). The `pages.yml` workflow deploys `frontend-pure/` on
   every push to `main`.
3. Make sure the **target repository** contains `.devcontainer/` with the
   `terminal-bridge/` folder and the two lifecycle scripts (copy them over
   if the target repo is a different one).
4. Open the Pages URL, paste a token, click **Launch**, then **Open terminal**.
   Signing in once on `*.app.github.dev` is the private-port protection.

### Trade-offs vs. Variant A

| | A: backend service | B: pure browser |
|---|---|---|
| Servers to operate | 1 (Node + gh CLI) | 0 |
| Auth | OAuth flow, token server-side | PAT pasted by the user |
| Undocumented surface | `gh codespace ssh --stdio` transport | none (REST + documented port forwarding) |
| Terminal embedding | inline on the landing page | separate tab on `app.github.dev` |
| Rate limiting | server-side (express-rate-limit) | client-side guard + GitHub API limits only |
| Idle handling | bridge stops the codespace actively | GitHub `idle_timeout_minutes` only |

### Variant-B security assumptions and open risks

1. **The token is only as safe as the page.** It stays in memory, but any XSS
   on the landing page could read it. Keep the page dependency-free (it is)
   and serve it from a trusted origin. A fine-grained token limited to the
   one repository reduces the blast radius.
2. **Port 7681 must never be made public.** The bridge performs no
   authentication of its own beyond a same-origin check and an optional
   `BRIDGE_SHARED_SECRET`; the security boundary is GitHub's private-port
   auth wall. A public port would expose a shell to anyone with the URL.
3. **Private-port behavior is product behavior, not an API contract.** The
   cookie flow, the 3 h expiry, and the `app.github.dev` domain are
   documented but may change; the domain is therefore configurable in the
   page config.
4. **No server-side rate limit.** The cooldown lives in the page and can be
   bypassed; the hard backstop is the user's own Codespaces quota and
   GitHub's API rate limits.

---

## Variant C — no token entry (OAuth + PKCE + minimal exchange function)

Variant B works with zero backend but asks the user to paste a personal access
token. Variant C removes that step. It cannot be fully backend-free: GitHub's
OAuth token endpoint has no CORS and still requires the `client_secret`, so the
code→token exchange cannot run in the browser even with PKCE. The only extra
piece is one tiny, stateless function that does exactly that exchange.

```
Browser ── authorize (top-level redirect, silent if already authorized) ─► github.com
Browser ── POST {code, verifier} ─► auth-worker  ── code→token (holds secret) ─► github.com
Browser ── fetch (Bearer token) ─► api.github.com     (create / poll / stop)
Browser ── https ─► <codespace>-7681.app.github.dev   (in-codespace bridge)
```

### Pieces

- `auth-worker/` — a ~90-line `export default { fetch }` handler (Cloudflare
  Workers by default, portable to Vercel/Netlify/Node). Holds the client
  secret, exchanges `{ code, code_verifier }` for an access token, returns only
  the token. See `auth-worker/README.md`.
- `frontend-oauth/` — the landing page with a "Sign in with GitHub" button
  instead of a token field. Runs the authorization-code flow with PKCE; an
  already-signed-in, previously-authorized user is redirected back silently.

### Setup

1. Register an OAuth App (or GitHub App). Callback URL = the Pages URL of
   `frontend-oauth` (e.g. `https://elisofke.github.io/Spacehatch/`).
2. Deploy the worker (`auth-worker/README.md`), setting `GITHUB_CLIENT_ID`,
   `GITHUB_CLIENT_SECRET`, and `ALLOWED_ORIGIN` (your Pages origin).
3. In `frontend-oauth/index.html`, set `clientId` and `authWorkerUrl`.
4. Point Pages at `frontend-oauth/` instead of `frontend-pure/` (edit the
   `path:` in `.github/workflows/pages.yml`), or host it anywhere static.

### Variant matrix

| | A: backend | B: pure browser | C: OAuth + exchange fn |
|---|---|---|---|
| Servers to operate | 1 (Node + gh CLI) | 0 | 1 tiny stateless function |
| Sign-in | OAuth, token server-side | paste a PAT | one click, no token entry |
| Token location | server memory | tab memory | tab memory |
| Client secret | on the server | not used | in the exchange function only |
| Best when | embedded terminal, full control | quickest to stand up | frictionless sign-in, minimal ops |

### Variant-C security notes

- The client secret lives only in the worker's secret store — never in the
  repo or the browser.
- PKCE binds the exchange to the browser session that started it, so an
  intercepted authorization code alone cannot be redeemed.
- The worker only accepts its configured `ALLOWED_ORIGIN` and returns only the
  token; the token then lives solely in the tab's memory, like Variant B.
- `state` is validated on return to block CSRF, and the code is stripped from
  the URL immediately to prevent replay on reload.
