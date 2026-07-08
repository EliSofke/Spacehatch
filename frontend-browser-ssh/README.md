# frontend-browser-ssh

The static page that is Spacehatch. It authenticates with a pasted GitHub PAT,
creates/polls the Codespace over `api.github.com`, connects the Dev Tunnels
relay through the `auth-worker`, then runs a hand-rolled gRPC-over-HTTP/2 client
to start sshd on the codespace and opens a second SSH session (pty + shell) into
`xterm`. All client-side; no VS Code, no in-repo agent, no `gh` binary.

- `index.html` — UI (token, owner/repo) + `SPACEHATCH_D_CONFIG` (worker URL,
  defaults, SDK versions).
- `app.js` — the full pipeline, with an on-page diagnostic log.
- `grpc/` — the hand-rolled protocol bricks + `selftest.html` (in-browser
  RFC-vector tests) + `*.test.mjs` (node).

## Config

Set `owner`/`repo` in `SPACEHATCH_D_CONFIG` (or pass `?owner=&repo=`) and point
`workerUrl` at the deployed `auth-worker`. The target repo should have **no**
`.devcontainer`, so the codespace uses GitHub's default image (which includes
sshd).
