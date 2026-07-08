# Spacehatch auth worker

The minimal backend that lets the Spacehatch frontend skip manual token entry.
It performs exactly one privileged operation — exchanging a GitHub OAuth
authorization code for an access token — because GitHub's token endpoint has
no CORS and still requires the `client_secret`, so a browser cannot do it
alone (even with PKCE). Everything else stays in the browser.

Stateless: no sessions, no storage, ~90 lines.

## Endpoints

| Method | Path      | Body                              | Response                     |
|--------|-----------|-----------------------------------|------------------------------|
| OPTIONS| `*`       | —                                 | CORS preflight (204)         |
| POST   | `/token`  | `{ code, code_verifier }`         | `{ access_token, scope }`    |
| POST   | `/tunnel` | `{ cluster, tunnelId, token }`    | the tunnels Tunnel object (with `endpoints`) |

`/token` is for the OAuth option (Variant C / D-OAuth). `/tunnel` proxies the
Dev Tunnels management GET — which is CORS-locked to `vscode.dev` — so a
browser page can obtain the tunnel `endpoints` (`clientRelayUri`,
`hostPublicKeys`) needed by `TunnelRelayTunnelClient.connect()`. `/tunnel` is
required for the browser-SSH terminal (Variant D) in **both** auth modes; it
sees only the short-lived tunnel connect token, never the GitHub token.

## Deploy on Cloudflare Workers

```bash
cd auth-worker
npm install -g wrangler        # or: npx wrangler
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
# edit ALLOWED_ORIGIN in wrangler.toml to your Pages origin
wrangler deploy
```

`wrangler deploy` prints the worker URL (e.g.
`https://spacehatch-auth.<subdomain>.workers.dev`). Put that URL into
`frontend-oauth/index.html` as `authWorkerUrl`.

## Portability

The handler is a standard `export default { fetch(request, env) }`. To run it
elsewhere, keep the logic and adapt only the entry point:

- **Vercel/Netlify function:** read `code`/`code_verifier` from the request
  body, read secrets from `process.env`, return the same JSON.
- **Tiny Node server:** wrap the same exchange in one Express route.

## Test

```bash
npm test   # mocks GitHub's token endpoint; no network, no real credentials
```

## Security notes

- The `client_secret` lives only in the worker's secret store, never in the
  repo or the browser.
- The worker only accepts requests from `ALLOWED_ORIGIN` and only returns the
  access token + scope. The token still lives solely in the browser tab after
  exchange (memory only).
- PKCE (`code_verifier`) binds the exchange to the browser session that began
  it, so an intercepted code alone is not redeemable.

## PAT-only mode (no secrets at all)

When the frontend runs with `patOnly: true`, only the `/tunnel` route is used.
The worker then needs **no secrets** — skip `wrangler secret put` entirely;
only `ALLOWED_ORIGIN` in `wrangler.toml` matters. The worker is stateless,
secret-free, and sees only short-lived tunnel connect tokens.
