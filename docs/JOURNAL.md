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
