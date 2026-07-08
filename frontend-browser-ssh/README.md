# Variant D (spike) — browser SSH, no Node/gh

A static page that authenticates (PAT **or** OAuth), manages the Codespace via
`api.github.com`, fetches the Dev Tunnels credentials, and — the goal — speaks
SSH to the Codespace directly from the browser using Microsoft's
`@microsoft/dev-tunnels-*` SDKs, rendering the shell with xterm.js. No Node
backend, no `gh` binary.

## Status

**Verified (live probes against a running Codespace, read-only):**
- Dual auth: PAT input and OAuth+PKCE (via the `auth-worker`) both yield a token held in tab memory.
- Codespace lifecycle over `api.github.com` (list / create / start / poll) — CORS-enabled.
- `GET /user/codespaces/{name}?internal=true` returns `connection.tunnelProperties`
  (`tunnelId`, `clusterId`, `connectAccessToken`, …) **and** the response carries
  `Access-Control-Allow-Origin: *`, so the browser fetches tunnel credentials directly — no proxy needed.

**To validate live (needs a real browser + a running Codespace):**
- The relay + SSH handshake in `connectTerminal()` / `bindShell()` (`app.js`).
  `bindShell()` currently throws on purpose: the REST + relay path is wired, but
  the exact accessor for the forwarded SSH shell stream (and the SSH client-auth
  step — likely a browser-generated key registered via the Codespace SSH-key
  header) is the one item to confirm against the SDK at runtime. It is isolated
  in a single function so finalizing it touches nothing else.

## Known dependencies / risks

- **`internal=true`** is undocumented GitHub behavior (the same hop `gh` makes) — the one fragile dependency, isolated in `fetchTunnelProperties()`.
- **Dev Tunnels relay Origin policy:** the management API is CORS-allowlisted to `vscode.dev`; the WSS relay handshake has no preflight, so its server-side Origin acceptance for a third-party page is the remaining unknown the live spike settles. If the relay rejects the origin, a ~20-line CORS relay function is the fallback for that single hop.
- SDKs are loaded as browser ESM from `esm.sh` (pinned in `SPACEHATCH_D_CONFIG.sdkVersion`); for production, vendor a self-built browser bundle instead.

## Setup

1. Set `owner`/`repo` (or pass `?owner=&repo=`). For OAuth, set `clientId` and `authWorkerUrl` and deploy the `auth-worker`.
2. Host statically (GitHub Pages or any static host).
3. Authenticate, choose the target repo, Launch.
