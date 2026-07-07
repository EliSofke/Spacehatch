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
