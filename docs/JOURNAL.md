# Project Journal

## v0.1.0 — backend-bridged terminal (Variant A)
- Chose `gh codespace ssh --stdio` as raw byte transport under an `ssh2`
  client instead of re-implementing the Dev Tunnels protocol; isolated all
  undocumented behavior in `backend/src/ssh/ghTransport.ts`.
- Wire protocol decision: text frames = keystrokes (AttachAddon-native),
  binary frames = shell output (UTF-8-split safe), binary + `\0CTL` magic =
  JSON control channel (resize) — keeps AttachAddon untouched.
- Token confinement: server-side in-memory sessions, HMAC-signed httpOnly
  cookie, token to `gh` via environment only.

## v0.1.x — repo bootstrap
- Git history initialized, CI (build gate), Dockerfile with gh CLI,
  devcontainer, `scripts/bootstrap.sh` (remote + push + .env seeding).
- Convention adopted: service repo = target repo unless overridden in `.env`.

## v0.2.0 — pure-browser variant (Variant B)
- Constraint check (verified against docs/community): `api.github.com` is
  CORS-enabled; `github.com/login/oauth/*` is not → browser-only OAuth is
  impossible, PAT input chosen instead (memory-only).
- Devcontainer cannot set port visibility, and public ports would expose a
  shell → design rides GitHub's PRIVATE-port auth wall. Same-origin trick:
  the in-codespace bridge serves the terminal page itself, so page and
  WebSocket share one origin and the auth cookie applies to both.
- Reused the `\0CTL` wire protocol verbatim (Ubiquitous Language across
  variants).
- Lifecycle without a server: `idle_timeout_minutes` at creation time is the
  authoritative stop mechanism; the bridge additionally kills idle PTYs.
- Integration tests (run in CI container): origin-guard rejection, PTY
  round-trip (MARKER echo), resize via control frame (stty size), shared
  secret accept/reject differential.

## Open items
- Variant A: per-user SSH key isolation for multi-tenant hosts; external
  session store; CSRF token.
- Variant B: consider a GitHub App with device-flow proxy if a minimal
  serverless function ever becomes acceptable; revisit if GitHub ships a
  public port-visibility API or CORS on the OAuth endpoints.

## v0.2.1 — project named: Spacehatch
- Renamed the project to Spacehatch. Rationale: a hatch is the narrow,
  well-defined opening into a larger vessel — matches the product's job of
  being one deliberate entry point into a Codespace, nothing more.
- Renamed root directory, both package.json names (spacehatch-backend,
  spacehatch-terminal-bridge) and their lockfiles, devcontainer name,
  page titles/brand marks in both frontend variants, README title.
- No functional change; backend rebuild and the full terminal-bridge
  integration suite (origin guard, PTY round-trip, resize, shared secret)
  re-run clean after the rename.

## v0.2.2 — pure-browser terminal auto-opens
- Symptom: after "Launch" nothing opened — the manual "Open terminal" button
  only appeared at state=Available, and a fresh codespace shows "Provisioning"
  for 1–4 minutes first.
- Fix: open the terminal tab synchronously inside the click gesture (popup-
  blocker safe), show a loading page, then navigate it to the port-forwarding
  URL once Available. Manual button kept as fallback when popups are blocked.
- Added BRIDGE_GRACE_MS: wait for the in-codespace bridge (postStartCommand)
  to start listening before navigating, avoiding a 502 on the private port.
- Hint copy now sets cold-start expectations.

## v0.2.3 — deterministic in-codespace bridge startup
- Symptom: terminal URL returned 502 Bad Gateway. Diagnosis: port 7681 IS
  forwarded and GitHub auth passes (proves headless port forwarding works),
  but nothing listens on 7681 — the bridge did not come up.
- Hardened startup (the real fault line, not the wire protocol):
  - setup.sh: fail-loud install + explicit `require('node-pty')` load check,
    so a broken native module surfaces in the creation log, not as a 502.
  - start-bridge.sh: idempotent dep check (reinstall if node-pty unloadable),
    fully detached start via setsid+nohup so the process survives the
    lifecycle shell, and a /healthz readiness probe that logs a diagnosis on
    failure instead of failing silently.
- Verified locally: readiness probe detects health, node-pty loads, bridge
  logs its start line; integration suite still green.
- To adopt: push v0.2.3, then delete the current codespace and relaunch so
  the fresh codespace uses the hardened devcontainer lifecycle scripts.

## v0.3.0 — no-token-entry variant (OAuth + PKCE + exchange function)
- Question: can we skip token entry if the user is already signed in to GitHub?
- Verified current GitHub behavior (grounded, not assumed): PKCE is supported
  since 2025-07, but the token endpoint still has NO CORS and still requires
  the client_secret — confirmed by GitHub staff. And a github.com session does
  not authenticate api.github.com from a third-party origin. So a fully
  backend-free, tokenless flow is impossible today.
- Decision: minimal token-mediating function (BFF-lite). auth-worker/ does the
  one hop the browser cannot (code→token with secret+PKCE) and nothing else;
  stateless, ~90 LOC, Cloudflare-default and portable.
- frontend-oauth/: sign-in replaces the PAT field; silent redirect for already-
  authorized users; token in tab memory only; launch/auto-open reused verbatim.
- Tests: worker differential suite (preflight, origin guard, bad input, valid
  exchange, secret-never-leaks, upstream-error passthrough, 404) — 9/9 green;
  PKCE S256 verified against the RFC 7636 reference vector.
- Pages still deploys frontend-pure by default (works standalone); switching to
  frontend-oauth requires the worker + clientId/authWorkerUrl to be set first.

## docs — README restructured for symmetry
- Problem: README treated Variant A as the main doc (structure, prereqs, setup,
  API, risks) and appended B and C, so the variants were not comparable.
- New shape (MECE): shared intro + Concept (the invariant \0CTL wire protocol)
  → Project structure grouped by variant → Prerequisites → three variant
  chapters with an identical skeleton (Architecture / How it works / Setup /
  Security; A also API surface) → a single unified Comparison with a
  "which to choose" guide. No information dropped; docs-only, no version bump.

## docs — required repository artifacts documented
- Added a "Required repository artifacts" chapter after Prerequisites: a table
  of the .devcontainer/ bridge files the TARGET repo must carry for B/C (with
  the concrete failure each omission causes, e.g. 502), the note that
  node_modules is not committed, and that A needs nothing in the target repo.
- Verified every listed path against the actual tree; docs-only, no version bump.

## docs — troubleshooting section (real failure modes)
- Captured the two pitfalls hit live: (1) 403 "forbidden" from a token without
  Codespaces write (a push token has Contents/Workflows only); read-but-not-write
  fails on create/start. (2) 502 from a stale Codespace created before a
  devcontainer change — delete and relaunch so a fresh one runs the current
  lifecycle scripts. Added a symptom→cause→fix table; docs-only.

## v0.4.0 — Variant A repo-agnostic (works on any bare repo)
- Requirement: dial into a terminal on ANY bare repo, nothing committed to it.
- Grounded finding: the in-codespace-bridge variants (B/C) can't reach a bare
  repo — the forwarded port needs either the target repo's forwardPorts or a
  connected VS Code client; dotfiles run per-codespace but cannot declare
  forwardPorts for the target codespace, and headless dynamic auto-forward is
  a client feature. So bare-repo access is only reliable via Variant A's
  server-side gh SSH tunnel, which attaches to the standard shell every
  codespace has — zero target-repo artifacts.
- Change: made Variant A repo-agnostic. owner/repo optional in config;
  ALLOW_REPO_OVERRIDE (default true) lets the frontend pass owner/repo per
  request (?owner=&repo=), validated against GitHub's name charset. One
  deployment now launches a Codespace for any repo the token can open.
- Verified: backend builds and starts without GITHUB_OWNER/REPO, /api/session
  reports allowRepoOverride, unauth create -> 401, name validation in place.

## research — browser-SSH feasibility probes (Variante D groundwork)
Probed live against a running codespace (read-only, tokens scrubbed):
1. GitHub REST: GET /user/codespaces/{name}?internal=true returns
   connection.tunnelProperties (tunnelId, clusterId, connectAccessToken,
   managePortsAccessToken, serviceUri, domain) AND the response carries
   Access-Control-Allow-Origin: * — the browser can fetch tunnel credentials
   directly from any origin with the user's token. No connection-info proxy
   needed. (internal=true is undocumented behavior; flagged as risk.)
2. Dev Tunnels management API (…rel.tunnels.api.visualstudio.com): CORS is
   ORIGIN-ALLOWLISTED. Preflight with Origin https://vscode.dev returns
   access-control-allow-origin: https://vscode.dev; github.dev and our Pages
   origin get 204 WITHOUT ACAO → browser fetch from our origin fails.
3. Auth scheme confirmed: "Authorization: tunnel <connectAccessToken>" → 200.
   The tunnel object exposes endpoints[0].clientRelayUri (the WSS relay URI),
   hostPublicKeys, portUriFormat.
Verdict for Variante D: everything moves to the browser EXCEPT (a) the OAuth
exchange (unchanged) and (b) ONE ~20-line CORS relay for the tunnels
management GET that resolves clientRelayUri. The WSS relay handshake itself
has no CORS preflight; its server-side Origin policy is the one remaining
unknown, to be settled by a live SDK spike (@microsoft/dev-tunnels-ssh +
-connections + xterm.js).

## spike — Variant D browser-SSH (static page, PAT + OAuth)
- Built frontend-browser-ssh/: static page with a PAT/OAuth toggle, codespace
  lifecycle, tunnelProperties fetch, and the Dev Tunnels SDK loaded as browser
  ESM from esm.sh (local esbuild bundle abandoned: node builtins like stream
  break class inheritance with empty shims; CDN ESM is the right fit for a
  static page).
- Verified live (read-only): dual auth yields a token; REST lifecycle works;
  ?internal=true exposes tunnelProperties with ACAO:* (browser fetch, no proxy).
- Live-validation boundary isolated in connectTerminal()/bindShell(): the
  forwarded-SSH-shell accessor + SSH client-auth (browser-generated key via the
  codespace SSH-key header) confirmed only in a real browser + running codespace.
  bindShell() throws deliberately until then. No release tag (terminal stage
  unvalidated).

## spike — Variant D: relay endpoint resolution (live-log driven)
- Live log from the deployed page: SDK loads fine; client.connect() fails with
  "Tunnel endpoints cannot be null" (NOT a CORS/origin rejection). Confirmed:
  connect() needs tunnel.endpoints (clientRelayUri, hostPublicKeys), which come
  from the tunnels management API — CORS-locked to vscode.dev.
- Settles the earlier open question definitively: the browser-SSH terminal needs
  exactly ONE relay function (PAT mode) / two (OAuth). Not zero.
- Added POST /tunnel to the worker: proxies the management GET with
  Authorization: tunnel <connectAccessToken>, returns the Tunnel (with
  endpoints) + CORS. Sees only the short-lived tunnel token, never the GitHub
  token. Worker tests 9/9 + /tunnel validation checks pass.
- app.js now fetches endpoints via /tunnel and passes the full tunnel to
  connect(). Next live step: confirm connect() resolves with endpoints, then
  finalize bindShell (SSH shell channel).

## v0.5.0 — Variant E: tokenless session-based launcher (frontend-lite)
- Requirement: "as lightweight as VS Code itself, no PAT, no OAuth". Insight:
  VS Code Web is tokenless because it rides the github.com SESSION — and
  GitHub's documented quickstart URL does the same for launching:
  codespaces.new/{owner}/{repo}?quickstart=1 resumes-or-creates and always
  opens in the VS Code web client (terminal via Ctrl+`).
- frontend-lite/: static page, zero fetch/storage/third-party, top-level
  navigation only; owner/repo via inputs or ?owner=&repo=&ref=. Pages now
  deploys frontend-lite as the primary site (browser-ssh spike stays in repo).
- Positioning: E = zero infrastructure + GitHub UI shell around the terminal;
  D = bare terminal, one relay function, SSH binding still to validate;
  JupyterLab = terminal-first via account editor preference.

## v0.6.0 — E+B hybrid: tokenless bare terminal
- Trilemma made explicit: tokenless / own terminal / bare repo — pick two.
  E picks tokenless+bare-repo; the hybrid picks tokenless+own-terminal by
  reusing two verified facts: quickstart URLs are session-authenticated, and
  private forwarded ports are session-authenticated (Variant B auth wall).
- frontend-lite now has Step 2: opens https://<name>-7681.app.github.dev/
  (the in-codespace xterm bridge). No fetch anywhere on the page; only
  top-level navigations. localStorage stores solely the last codespace name
  (non-secret); name also settable via ?codespace=, port/domain via ?port=
  &domain= (GitHub reserves the right to change the domain).
- Constraint documented: target repo must carry the .devcontainer bridge;
  lifecycle (stop/delete) stays on github.com/codespaces.
