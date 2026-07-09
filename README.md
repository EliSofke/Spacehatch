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

The heavy lifting (relay WebSocket, gRPC to Codespace agent, SSH client) happens in a **Go/WASM module**.

## Layout

```
frontend-ssh-wasm/        the main static page (GitHub Pages)
├── index.html            UI + xterm + config
├── boot.js               JS orchestrator
└── spacehatch-ssh.wasm   Go transport (built from ssh-wasm-src/)

auth-worker/              the Cloudflare Worker (+ RelayProxy Durable Object)
├── worker.js  wrangler.toml  worker.test.mjs  README.md
test/e2e-launch.mjs       headless (Playwright) end-to-end launch test
docs/JOURNAL.md           project journal
.github/workflows/        pages.yml (deploy the page), deploy-worker.yml
```

## Deploy

- **Page** -> `pages.yml` publishes `frontend-ssh-wasm/` to GitHub Pages.
- **Worker** -> `deploy-worker.yml` runs `wrangler deploy`.

## Use

1. Open the page. The first log line shows `spacehatch build <sha> <date>`.
2. Paste a GitHub token with **Codespaces: read and write** on the target repo.
3. Set owner/repo (a repo **without** a `.devcontainer`) and click **Launch**.
4. A shell appears in the terminal — read and write, with a real pty.

## Test

```
# worker unit tests
node auth-worker/worker.test.mjs
# full headless launch (needs a Codespaces token)
CODESPACES_TOKEN=github_pat_... node test/e2e-launch.mjs
```