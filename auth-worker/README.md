# auth-worker

The small, stateless Cloudflare Worker behind Spacehatch. It does only the few
things a browser cannot do itself; the SSH session stays end-to-end encrypted,
so the worker only relays ciphertext. **No secrets required** — just
`ALLOWED_ORIGIN`.

## Routes

- `POST /tunnel` — proxies the CORS-locked Dev Tunnels management GET for a
  tunnel and rewrites `endpoints[0].clientRelayUri` to this worker's `/relay`.
- `POST /port` — creates a tunnel port (`PUT .../tunnels/{id}/ports/{n}`), also
  CORS-locked. Used to expose the agent-started sshd port.
- `GET /relay/<cluster>/<tunnelId>` — WebSocket bridge to the dev-tunnels relay,
  handled by the **`RelayProxy` Durable Object**. The worker opens the upstream
  relay WS server-side (header auth, no browser origin) and bridges bytes. It
  runs in a Durable Object because a plain Worker tears the long-lived outbound
  WebSocket down after `fetch()` returns, which dropped the tunnel every ~10s.

All routes are locked to `ALLOWED_ORIGIN`.

## Config

`wrangler.toml` sets `ALLOWED_ORIGIN` (the exact Pages origin) and declares the
`RELAY` Durable Object binding + migration. Deployment is automated by
`.github/workflows/deploy-worker.yml` (`cloudflare/wrangler-action`), which needs
repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Test

```
node worker.test.mjs
```
