# Spacehatch

A **browser-only terminal into a bare GitHub Codespace** — no VS Code, no
in-repo agent, no long-running backend. You open a static page, paste a GitHub
token, and get an interactive shell into a fresh Codespace created from any
repository that has no `.devcontainer` (so it uses GitHub's default image, which
ships an SSH server).

Live: <https://elisofke.github.io/Spacehatch/>

## How it works

Everything runs in the browser except one small, stateless Cloudflare Worker
that proxies the handful of calls a browser physically cannot make (CORS-locked
management APIs and a header-authenticated WebSocket). The SSH session is
end-to-end encrypted between the browser and the Codespace, so the worker only
ever relays ciphertext.

```
1. REST create/poll codespace   ─────────────────────────▶  api.github.com (CORS ok)
2. get tunnel endpoints          ─▶ POST /tunnel  ────────▶  tunnels mgmt API (CORS-locked)
3. connect relay (WebSocket)     ─▶ GET /relay/… (Durable Object) ─▶ dev-tunnels relay
4. hand-rolled gRPC over the tunnel to the codespace agent (port 16634):
   StartRemoteServerAsync(pubkey) ───────────────────────▶  agent starts sshd → {port,user}
5. expose the sshd port          ─▶ POST /port  ──────────▶  tunnels mgmt API (create port)
6. second SSH session over the forwarded port → pty + shell → xterm
```

The interesting part is step 4: browsers can't speak gRPC (no HTTP/2 frame
control), so Spacehatch implements a minimal **gRPC-over-HTTP/2 client by hand**
(protobuf, gRPC framing, HTTP/2 frames, HPACK + Huffman) and runs it over the
raw tunnel stream. See `frontend-browser-ssh/grpc/` and its in-browser
self-test at `/grpc/selftest.html`.

## Layout

```
frontend-browser-ssh/     the static page (GitHub Pages)
├── index.html            UI + config (paste a PAT, owner/repo)
├── app.js                the whole client pipeline (steps 1-6)
└── grpc/                 hand-rolled gRPC-over-HTTP/2 client
    ├── protobuf.js  framing.js  http2.js  hpack.js  huffman-table.js
    ├── client.js    mock-server.js  openssh.js  agent.js
    ├── *.test.mjs        unit tests (RFC 7541 vectors, node:http2 interop)
    └── selftest.html     runs the bricks in-browser
auth-worker/              the Cloudflare Worker (+ RelayProxy Durable Object)
├── worker.js  wrangler.toml  worker.test.mjs  README.md
test/e2e-launch.mjs       headless (Playwright) end-to-end launch test
docs/JOURNAL.md           project journal
.github/workflows/        pages.yml (deploy the page), deploy-worker.yml
```

## Deploy

Both deploys run from GitHub Actions on push (no local tooling needed):

- **Page** -> `pages.yml` publishes `frontend-browser-ssh/` to GitHub Pages and
  stamps the commit SHA into the build banner + versions the gRPC module graph
  for cache-busting.
- **Worker** -> `deploy-worker.yml` runs `wrangler deploy`. Repo secrets:
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. The worker needs **no**
  secrets of its own — only `ALLOWED_ORIGIN` in `wrangler.toml`.

## Use

1. Open the page. The first log line shows `spacehatch build <sha> <date>`.
2. Paste a GitHub token with **Codespaces: read and write** on the target repo.
3. Set owner/repo (a repo **without** a `.devcontainer`, so the default image
   with sshd is used) and click **Launch**.
4. A shell appears in the terminal — read and write, with a real pty.

Note: fine-grained PATs can list/create/delete codespaces but often cannot
`start` a stopped one; Spacehatch prefers a running codespace and creates a new
one when it can't start an existing one.

## Test

```
# worker unit tests
node auth-worker/worker.test.mjs
# gRPC protocol bricks
for t in frontend-browser-ssh/grpc/*.test.mjs; do node "$t"; done
# full headless launch (needs a Codespaces token)
CODESPACES_TOKEN=github_pat_... node test/e2e-launch.mjs
```
