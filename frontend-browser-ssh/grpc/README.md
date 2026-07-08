# Variant C — in-browser gRPC bootstrap (zero codespace-side artifacts)

Goal: satisfy ALL constraints at once — bare target repo (no `.devcontainer`,
no dotfiles), own xterm terminal, browser-only, serverless-on-Cloudflare. The
only remaining server-side piece is the existing stateless Worker WS-proxy.

The blocker this must overcome: getting a shell on a bare codespace requires the
codespace agent's **gRPC** call `StartSSHServer(publicKey) → (port, sshUser)` on
the internal port 16634 — and gRPC is HTTP/2 + protobuf. Since no server can do
this for us without becoming a persistent backend, Variant C implements a
**minimal unary gRPC-over-HTTP/2 client in the browser**, tunneling to port
16634 through the Worker `/relay` proxy, then runs a second SSH session to the
returned port and opens a shell.

## Pipeline

1. Connect the tunnel (done — `client.connect()` resolves via the Worker proxy).
2. Open a raw duplex stream to forwarded port **16634** over the tunnel.
3. Speak **unary gRPC over HTTP/2** on that stream:
   `POST /codespaces.grpc.<Service>/StartSSHServer` with a protobuf body
   carrying the browser-generated ed25519 **public key**; read back
   `(serverPort, user)`.
4. Open a second raw stream to `serverPort` over the tunnel.
5. Run a second `SshClientSession` (dev-tunnels-ssh) over it, authenticate with
   the browser-generated **private key** as `user`.
6. Open a session channel, request pty + `shell`, wire to xterm.

## Bricks and status

| Brick | File | Status |
|---|---|---|
| Protobuf (varint, wire types 0/2) | `protobuf.js` | **built + unit-tested** |
| gRPC message framing (5-byte prefix) | `framing.js` | **built + unit-tested** |
| HTTP/2 frames (SETTINGS/HEADERS/DATA/WINDOW_UPDATE) | `http2.js` | pending |
| HPACK encode (literal) + decode (static/dynamic + Huffman) | `hpack.js` | pending |
| ed25519 keypair → OpenSSH public-key format | (browser) | pending |
| Unary gRPC call orchestration over a stream | `client.js` | pending |
| Agent service/method + request/response field numbers | — | to reverse-engineer from cli/cli `internal/codespaces/grpc` |
| Second SSH session + pty/shell → xterm | `app.js bindShell` | pending |

## Honesty note

The protocol bricks (protobuf, gRPC framing, HTTP/2, HPACK) are unit-testable in
Node against known vectors and are being built that way. The **integration** —
connecting to 16634 over the SDK stream, the live agent accepting our gRPC, the
second SSH, the shell — can only be validated in a real browser against a live
codespace, and may hit unforeseen constraints (agent auth/mTLS, SDK stream
access, HPACK edge cases). This is a long spike; each brick lands verified, the
end-to-end needs live iterations.
