# Spacehatch

One-click cloud terminal from a repo landing page. A visitor clicks one button and gets an interactive shell — rendered with xterm.js in the browser — inside a GitHub Codespace for a fixed repository. No VS Code UI, no local software. The Codespace runs on GitHub's infrastructure; Spacehatch only orchestrates its lifecycle and bridges its shell to the browser.

The same product ships in three variants that trade infrastructure for convenience. They share one terminal experience and one wire protocol; they differ only in how the user authenticates and where the terminal server runs. Pick one from the [comparison](#comparison) at the end.

## Concept

Every variant does the same four things: authenticate the user against GitHub, create or reuse a Codespace via the documented REST API, poll it until `Available`, and attach a live PTY to an xterm.js terminal in the browser.

The one invariant across all variants is the **terminal wire protocol** (Ubiquitous Language — the same names appear in every frontend and every bridge):

- Browser → server, **text** frames: raw keystrokes (emitted by xterm.js `AttachAddon`), written verbatim to the PTY.
- Browser → server, **binary** frames prefixed with the 4-byte magic `\0CTL`: JSON control messages, currently `{ type: "resize", cols, rows }`.
- Server → browser, **binary** frames: raw shell output (binary so multi-byte UTF-8 split across chunks reassembles correctly).

What differs between variants is only two axes: **auth** (server-held OAuth token / pasted PAT / one-click OAuth+PKCE) and **terminal transport** (an `ssh2` bridge on a backend host / an in-codespace `node-pty` bridge on a private forwarded port).

## Project structure

```
.
├── backend/                  Variant A · Node/Express bridge service (TypeScript)
│   ├── src/
│   │   ├── server.ts             Express app, OAuth flow, REST endpoints, WS upgrade
│   │   ├── config.ts             fail-fast environment configuration
│   │   ├── sessions.ts           server-side token store + signed httpOnly cookie
│   │   ├── githubApi.ts          documented REST calls (create/poll/start/stop/delete)
│   │   └── ssh/
│   │       ├── ghTransport.ts    ⚠ the ONLY undocumented-behavior module (gh tunnel)
│   │       └── bridge.ts         WebSocket ⇄ SSH PTY bridge, resize, idle timeout
│   ├── .env.example, package.json, tsconfig.json
├── frontend/                 Variant A · landing page with an inline xterm.js terminal
│
├── frontend-pure/            Variant B · static page, PAT entry
├── frontend-oauth/           Variant C · static page, GitHub sign-in (no token entry)
├── auth-worker/              Variant C · stateless OAuth code→token exchange function
│
├── .devcontainer/            Variants B & C · in-codespace terminal bridge
│   ├── devcontainer.json         forwards ports 3000 + 7681, autostarts the bridge
│   ├── setup.sh, start-bridge.sh lifecycle scripts (install, detached start, health probe)
│   └── terminal-bridge/          ws + node-pty server, its own terminal page, tests
│
├── .github/workflows/        ci.yml (build gate), pages.yml (deploy static frontend)
├── scripts/bootstrap.sh      one-shot repo bootstrap (remote, push, .env seeding)
├── docs/JOURNAL.md           decision log
└── Dockerfile                Variant A runtime image (Node + gh CLI)
```

## Prerequisites (all variants)

- A GitHub account with Codespaces enabled and access to the target repository.
- The **target repository** must contain `.devcontainer/` (the in-codespace bridge) for Variants B and C. Variant A reaches any repo the token can see.
- Node.js ≥ 18 (tested with 22) to build or run the JavaScript/TypeScript pieces.

Each variant lists its own additional prerequisites in its Setup section.

## Required repository artifacts

A Codespace is created from the **target repository**, so what that repository contains decides whether a terminal can start.

**Variants B and C** serve the terminal from inside the Codespace, so the target repository must contain the in-codespace bridge — committed and pushed, on the `ref` the Codespace is created from:

| Artifact | Role | Missing → |
|---|---|---|
| `.devcontainer/devcontainer.json` | Forwards port `7681` and wires the lifecycle commands (`postCreateCommand` → `setup.sh`, `postStartCommand` → `start-bridge.sh`) | Port never forwarded / bridge never started |
| `.devcontainer/setup.sh` | Installs bridge dependencies once at creation, verifies `node-pty` loads | Bridge cannot start |
| `.devcontainer/start-bridge.sh` | Starts the bridge detached on every start, probes `/healthz` | Nothing listens on `7681` |
| `.devcontainer/terminal-bridge/package.json` (+ `package-lock.json`) | Declares `ws` and `node-pty` for a reproducible install | Install fails |
| `.devcontainer/terminal-bridge/server.js` | The `ws` + `node-pty` bridge on port `7681` | Nothing listens on `7681` |
| `.devcontainer/terminal-bridge/terminal.html` | The xterm.js page the bridge serves | Terminal page 404s |

If any of these is absent, the Codespace still comes up but nothing listens on `7681`, and the forwarded-port URL returns **502 Bad Gateway**. `node_modules/` is *not* committed — `setup.sh` installs dependencies inside the Codespace. After changing any devcontainer artifact, delete and relaunch the Codespace: lifecycle changes only take effect in a freshly created one.

The landing page (`frontend-pure/` or `frontend-oauth/`) and, for Variant C, the `auth-worker/` are hosted separately (GitHub Pages / a function host). They are **not** required inside the target repository.

**Variant A** requires no artifacts in the target repository. It attaches over SSH to the Codespace's standard shell through the `gh` tunnel, so any repository the token can open works unchanged. In **repo-agnostic mode** (`ALLOW_REPO_OVERRIDE=true`, the default), a single deployment launches a Codespace for whatever repo is passed as `?owner=…&repo=…`, so every target repo stays bare. This is the only variant that reaches a bare repo, because B and C need the port forwarded, which requires either the target repo's `forwardPorts` or a connected VS Code client.

---

## Variant A — backend service

A Node.js/Express service authenticates the user, manages the Codespace, opens an SSH tunnel to it, and streams the shell over a WebSocket to an xterm.js terminal embedded directly in the landing page. The token never leaves the server.

### Architecture

```
Browser ── xterm.js + AttachAddon ── WebSocket ──┐
                                                 │
                       Node.js/Express backend   │
                       ├─ GitHub REST API  ──────┼── create / poll / stop / delete Codespace
                       └─ ssh2 client ── stdio ──┴── `gh codespace ssh --stdio` tunnel
                                                        │
                                                 GitHub Codespace (sshd)
```

### How it works

| Concern | Implementation |
|---|---|
| Create + start Codespace | `POST /repos/{owner}/{repo}/codespaces` (documented REST); reuse-or-start logic in `POST /api/codespaces` |
| Poll until `Available` | Frontend polls `GET /api/codespaces/:name` (backed by `GET /user/codespaces/{name}`) every 2.5 s |
| SSH, not VS Code Server API | `ssh2` client speaking real SSH over a raw byte tunnel from `gh codespace ssh --stdio` |
| WebSocket bridging | `ws` server; text = keystrokes, binary = shell output, binary `\0CTL`+JSON = resize |
| xterm.js + AttachAddon | `frontend/app.js`, with FitAddon and out-of-band resize frames |
| Token never in frontend | Token in an in-memory server session; browser holds only an HMAC-signed, httpOnly, SameSite=Lax cookie |
| Rate limiting | `express-rate-limit`, 3 launches/min, plus reuse instead of creating duplicates |
| Idle lifecycle | Bridge byte-flow timeout (`IDLE_TIMEOUT_MS`) stops the Codespace; GitHub `idle_timeout_minutes` as safety net |
| Error handling | 401/403 → session invalidated, back to login; tunnel/SSH death closes the WS with a reason shown in the terminal |

Additional prerequisite: the GitHub CLI `gh` ≥ 2.40 on the backend host and on `PATH` — used **only** as the tunnel transport, authenticating from the per-user token via `GH_TOKEN` (no `gh auth login`).

### Setup

1. **Register a GitHub OAuth App** (Settings → Developer settings → OAuth Apps → New OAuth App):
   - Homepage URL: `http://localhost:3000` (or your public base URL).
   - Authorization callback URL: `http://localhost:3000/auth/callback` — must equal `BASE_URL` + `/auth/callback`.
   - Copy the Client ID and generate a Client secret. Scopes are requested at runtime: `codespace` (lifecycle + tunnel) and `repo` (private repos only).
2. **Configure and run:**
   ```bash
   cd backend
   cp .env.example .env      # client id/secret, owner/repo, session secret
   npm install && npm run build && npm start
   ```
   The backend serves the frontend, so `http://localhost:3000` is all you need. Leave `GITHUB_OWNER`/`GITHUB_REPO` empty with `ALLOW_REPO_OVERRIDE=true` for repo-agnostic mode (any bare repo via `?owner=…&repo=…`), or pin a single default repo.
3. **Use it:** Sign in with GitHub → Launch cloud terminal → the state advances (`Queued → Provisioning → Starting → Available`; cold create 1–4 min, restart ~30 s) → the terminal attaches automatically. Stop ends compute billing; `DELETE /api/codespaces/:name?purge=true` removes the machine.

### API surface

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

### Security assumptions and risks

- **Token confinement.** The token lives only in backend memory and reaches `gh` via environment variable (never argv, never disk). Run the backend on trusted infrastructure only.
- **Session cookie = full shell access.** Serve over HTTPS in any non-local deployment (the cookie's `secure` flag follows `BASE_URL`) and keep `SESSION_SECRET` secret.
- **Host key checking is disabled by design.** The Codespace host key is per-machine and reached only through a GitHub-authenticated tunnel; `gh`'s own config makes the same trade-off.
- **One session ↔ one Codespace.** The WS upgrade only accepts the Codespace name stored in the caller's session.
- **⚠ Undocumented transport (`backend/src/ssh/ghTransport.ts`).** Codespaces expose no public SSH endpoint; connectivity goes through Microsoft Dev Tunnels. We delegate that hop to `gh codespace ssh --stdio` rather than re-implement it. Both `--stdio` and the parsed output of `gh codespace ssh --config` are CLI behavior, not an API contract — isolated so a fix touches one file.
- **Key material on disk.** `gh` generates `~/.ssh/codespaces.auto` on the host, shared across users in this prototype; per-user key isolation is the first multi-tenant hardening step.
- **In-memory sessions.** A restart logs everyone out; production wants an external session store + startup reconciliation via `GET /user/codespaces`.
- **No CSRF token** beyond `SameSite=Lax`; add a CSRF token or `Origin` check before production.

---

## Variant B — pure browser (PAT)

No backend at all: a **static page** (hostable on GitHub Pages) plus a tiny **terminal server running inside the codespace itself**. The browser talks to `api.github.com` directly and reaches the terminal over a privately forwarded codespace port.

### Architecture

```
Browser ── fetch ──────────────► api.github.com   (create / poll / stop / delete)
Browser ── https + WebSocket ──► <codespace>-7681.app.github.dev
                                   └─ terminal-bridge (ws + node-pty) inside the codespace
```

### How it works

1. `frontend-pure/index.html` asks for a **personal access token** (scope `codespace`, plus `repo` for private repos), kept in tab memory only. A browser-only OAuth flow is impossible: `api.github.com` is CORS-enabled, but `github.com/login/oauth/*` rejects cross-origin requests.
2. The page calls the documented REST API directly (reuse → start → create) and polls until `Available`. The create request sets `idle_timeout_minutes` — with no server of our own, GitHub's idle timeout stops forgotten machines.
3. The devcontainer starts `.devcontainer/terminal-bridge/server.js` on port **7681** (`postStartCommand`). It serves the xterm.js page and a WebSocket-attached PTY using the shared wire protocol.
4. The port stays **private**. GitHub's port-forwarding auth wall (cookie-based, codespace creator only, 3 h expiry) guards both the page and the WebSocket because both share one origin — the same-origin trick that makes a private port usable without any token handling on our side.

### Setup

1. Set `owner`, `repo`, `ref` in the config block of `frontend-pure/index.html` (or pass `?owner=…&repo=…` as URL parameters).
2. Enable GitHub Pages (Settings → Pages → Source: GitHub Actions). `pages.yml` deploys `frontend-pure/` on every push to `main`.
3. Ensure the **target repository** contains `.devcontainer/` with `terminal-bridge/` and the lifecycle scripts.
4. Open the Pages URL, paste a token, click Launch — the terminal opens automatically in a new tab. Signing in once on `*.app.github.dev` is the private-port protection.

### Security assumptions and risks

- **The token is only as safe as the page.** It stays in memory, but XSS on the page could read it; keep the page dependency-free (it is) and prefer a fine-grained token scoped to the one repository.
- **Port 7681 must never be made public.** The bridge authenticates only via a same-origin check and an optional `BRIDGE_SHARED_SECRET`; the real boundary is GitHub's private-port auth wall.
- **Private-port behavior is product behavior, not an API contract.** The cookie flow, the 3 h expiry, and the `app.github.dev` domain may change; the domain is configurable in the page config.
- **No server-side rate limit.** The client-side cooldown can be bypassed; the backstop is the user's own Codespaces quota and GitHub's API limits.

---

## Variant C — no token entry (OAuth + PKCE)

Variant B's only friction is the pasted PAT. Variant C removes it with a GitHub sign-in. It cannot be fully backend-free: GitHub's OAuth token endpoint has no CORS and still requires the `client_secret`, so the code→token exchange cannot run in the browser even with PKCE. The only added piece is one tiny, stateless function that performs exactly that exchange.

### Architecture

```
Browser ── authorize (top-level redirect, silent if already authorized) ─► github.com
Browser ── POST {code, verifier} ─► auth-worker  ── code→token (holds secret) ─► github.com
Browser ── fetch (Bearer token) ─► api.github.com     (create / poll / stop)
Browser ── https ─► <codespace>-7681.app.github.dev   (in-codespace bridge, as in Variant B)
```

### How it works

1. `frontend-oauth/` shows a **Sign in with GitHub** button. It runs the authorization-code flow with PKCE (S256): it generates a `code_verifier`, redirects to `authorize` with the `code_challenge`, and validates `state` on return. An already-signed-in, previously-authorized user returns silently — no prompt, no token entry.
2. On return, the page POSTs `{ code, code_verifier }` to `auth-worker/`, which holds the `client_secret` and performs the one hop the browser cannot. It returns only the access token, which then lives in tab memory — as in Variant B.
3. From there the flow is identical to Variant B: create/poll via `api.github.com`, terminal over the private codespace port.

`auth-worker/` is a ~90-line `export default { fetch }` handler — Cloudflare Workers by default, portable to Vercel/Netlify/Node (see `auth-worker/README.md`).

### Setup

1. Register an OAuth App (or GitHub App). Callback URL = the Pages URL of `frontend-oauth` (e.g. `https://elisofke.github.io/Spacehatch/`).
2. Deploy the worker (`auth-worker/README.md`), setting `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `ALLOWED_ORIGIN` (your Pages origin).
3. In `frontend-oauth/index.html`, set `clientId` and `authWorkerUrl`.
4. Point Pages at `frontend-oauth/` (edit `path:` in `.github/workflows/pages.yml`), or host it anywhere static.

### Security assumptions and risks

- **Client secret confinement.** The secret lives only in the worker's secret store — never in the repo or the browser.
- **PKCE binds the exchange** to the browser session that started it, so an intercepted authorization code alone cannot be redeemed.
- **The worker is origin-locked.** It accepts only `ALLOWED_ORIGIN` and returns only the token; the token then lives solely in tab memory, like Variant B.
- **CSRF and replay.** `state` is validated on return, and the code is stripped from the URL immediately to prevent replay on reload.
- Inherits Variant B's private-port and rate-limit considerations for everything after sign-in.

---

## Comparison

| | A · backend service | B · pure browser (PAT) | C · OAuth + PKCE |
|---|---|---|---|
| Servers to operate | 1 (Node + `gh` CLI) | 0 | 1 tiny stateless function |
| Sign-in | OAuth, token server-side | paste a PAT | one click, no token entry |
| Token location | server memory | tab memory | tab memory |
| Client secret | on the server | not used | in the exchange function only |
| Terminal transport | `ssh2` bridge on the backend host | in-codespace `node-pty` bridge | in-codespace `node-pty` bridge |
| Terminal embedding | inline on the landing page | separate tab on `app.github.dev` | separate tab on `app.github.dev` |
| Undocumented surface | `gh codespace ssh --stdio` | none | none |
| Rate limiting | server-side (`express-rate-limit`) | client-side guard + GitHub limits | client-side guard + GitHub limits |
| Idle handling | bridge stops the codespace actively | GitHub `idle_timeout_minutes` | GitHub `idle_timeout_minutes` |
| Works on a **bare** target repo (no artifacts) | **yes** (attaches via SSH; repo-agnostic) | no — needs the `.devcontainer/` bridge | no — needs the `.devcontainer/` bridge |
| Best when | any/bare repo, embedded terminal, full control | quickest to stand up | frictionless sign-in, minimal ops |

**Which to choose.** Pick **A** when the terminal must be embedded in your own page and you want full server-side control over auth, rate limiting, and lifecycle — accepting a Node host with the `gh` CLI and the one undocumented transport. Pick **B** for the least possible infrastructure when asking users for a PAT is acceptable; there is nothing to operate beyond static hosting. Pick **C** when you want one-click sign-in with no token entry and can run a single tiny, stateless function for the OAuth exchange.

## Troubleshooting

Symptom → cause → fix for the failure modes seen in practice:

| Symptom | Cause | Fix |
|---|---|---|
| **Launch fails immediately: "forbidden"** | The token lacks Codespaces access (e.g. a token scoped only for `Contents`/`Workflows`, such as a push token). | Use a token with **Codespaces: Read and write** (fine-grained) or the **`codespace`** scope (classic). It must also have access to the target repository. |
| **Launch fails after listing: "forbidden"** | The token has Codespaces **read** but not **write**, so create/start is rejected. | Raise the token's Codespaces permission from Read to **Read and write**. |
| **Terminal URL returns 502 Bad Gateway** | Port `7681` is forwarded but nothing listens: the in-codespace bridge did not come up. Common when the Codespace predates a devcontainer change and still runs the old lifecycle scripts. | **Delete the Codespace and relaunch** so a fresh one uses the current `.devcontainer/` scripts. Persistent failures are logged to `/tmp/spacehatch-bridge.log` inside the Codespace. |
| **Terminal URL returns 404** | Port `7681` is not forwarded yet — the bridge has not started, so the port was never registered. | Wait for the bridge to start, or delete and relaunch; confirm the target repo carries the full `.devcontainer/` bridge (see [Required repository artifacts](#required-repository-artifacts)). |
| **Codespace stuck in `Provisioning`** | A first cold start takes 1–4 minutes. | Wait; the terminal tab shows a loading screen and opens automatically once the state reaches `Available`. |

---

## Variant E — lite (session-based, zero everything)

The lightest possible launcher: a static page whose button navigates to
GitHub's documented quickstart URL, `https://codespaces.new/{owner}/{repo}?quickstart=1`.
Your existing github.com session handles auth — the same mechanism VS Code Web
rides. GitHub resumes the most recent codespace for the repo or creates one,
and quickstart links always open in the **VS Code web client**, where the
terminal is one `Ctrl+`` away. No PAT, no OAuth, no worker, no API calls,
works on any bare repository.

Trade-offs: the terminal lives inside VS Code Web (or JupyterLab, if opened
from the codespaces list with that editor preference) rather than standing
alone, and the page has no programmatic control — state, stop and delete are
handled on github.com/codespaces. That is exactly the deal: GitHub's
infrastructure does everything, our page only aims the click.
