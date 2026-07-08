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

## v0.7.0 — decision: Variant D PAT-only is the primary solution
- Chosen combination: PAT + bare repo + own terminal → Variant D, PAT-only.
- frontend-browser-ssh: patOnly flag (default true) hides the OAuth tab and
  skips callback handling; /token unused. Worker becomes secret-free:
  only /tunnel + ALLOWED_ORIGIN (documented in auth-worker/README).
- Pages now deploys frontend-browser-ssh as the primary site; lite/hybrid
  remain in the repo as the tokenless alternatives.
- Open items unchanged: deploy the worker (user's Cloudflare account),
  set workerUrl, then live-validate connect() with endpoints and finalize
  bindShell (SSH shell channel).

## spike — Variant D: relay WebSocket auth diagnosis (1006)
Live log: endpoints resolved via our /tunnel relay (endpoints=1,
relayUri=wss://euw-data.rel.tunnels.api.visualstudio.com/api/v1/Client/Connect/
<id>). The SDK then opens the relay WebSocket with subprotocols
"tunnel-relay-client-v2-dev, tunnel-relay-client" and traces an
"Authorization: tunnel <token>" header — but every attempt closes with
WebSocket code 1006 (abnormal, no reason), backs off, and fails.

Two hypotheses tested:
- ORIGIN rejection — RULED OUT. Handshake probe against the relay data plane
  with a bogus tunnel returns 404 identically WITH and WITHOUT
  Origin: https://elisofke.github.io. An origin allowlist would 403 before the
  404. So the relay does not gate our origin. (Good: no first-party wall.)
- TOKEN DELIVERY — the remaining cause. Browsers cannot set an Authorization
  header on WebSocket; the token must ride the Sec-WebSocket-Protocol (or a
  query param). The trace shows only the two protocol names, no token-bearing
  subprotocol, plus an Authorization header — i.e. the esm.sh-bundled SDK is on
  its NODE code path (node-builtin polyfills → env detected as node → uses the
  header/`ws` path), which a real browser silently drops → relay 1006.

Fix direction: run the SDK's genuine BROWSER path (native WebSocket + token as
subprotocol, the mechanism vscode.dev uses). That means a proper browser build
where `ws`/isomorphic-ws resolves to native WebSocket and `process`/`Buffer`
are not globally injected — NOT esm.sh's node-polyfilled variant. Needs a real
browser to validate. Alternatives that already ship: Variant E (tokenless) and
the E+B hybrid (tokenless bare terminal).

## spike — Variant D: force browser path (the 1006 fix)
Read the esm.sh bundle: DefaultTunnelRelayStreamFactory.createRelayStream has
two branches keyed on isNode():
  isNode()  → openConnection(uri, protocols, {Authorization: `tunnel <token>`})
  browser   → protocols=[...protocols, token]; openConnection(uri, protocols)
i.e. the browser branch passes the tunnel token AS A WEBSOCKET SUBPROTOCOL
(the only browser-allowed mechanism). isNode() is
  () => typeof process<"u" && process.release?.name === "node"
and esm.sh's /node/process.mjs shim reports release.name === "node" → node
branch → Authorization header → browser drops it → relay 1006.
Fix (no rebuild): import the shared https://esm.sh/node/process.mjs singleton
and set release.name to "browser" before connect(), flipping isNode() false so
the SDK takes its browser path. Next live test should show client.connect()
resolving; then finalize bindShell.

## spike — Variant D: correcting the 1006 root-cause (previous entry was wrong)
The process-shim patch was a NO-OP: esm.sh's /node/process.mjs defines
`get release(){return {}}`, so process.release.name is undefined (not "node")
→ isNode() was ALREADY false → the SDK was ALREADY on its browser path,
appending the tunnel token as a WebSocket subprotocol (correct mechanism).
The "Authorization: tunnel <...>" log line is an UNCONDITIONAL trace, not proof
of the node branch. So the 1006 is a SERVER-SIDE handshake rejection by the
relay, cause not isolated:
- Origin-for-a-valid-tunnel NOT ruled out (the earlier bogus-tunnel probe 404s
  before any origin/auth check).
- Could also be a subprotocol/version detail (SDK offers
  "tunnel-relay-client-v2-dev").
Blocked from the definitive live handshake test: the stored Codespaces token now
returns 401 (rotated). Removed the inert patch. Next: either confirm origin via
a local (file://, Origin: null) handshake test, or make D robust by proxying the
relay WebSocket THROUGH the worker (server-side connect: no browser origin, can
set the auth header; SSH stays end-to-end encrypted so the worker sees only
ciphertext).

## v0.8.0 — Variant D: worker WebSocket relay-proxy (route B)
Make D robust to the relay 1006 by proxying the relay WS through the worker:
- worker /tunnel now rewrites endpoints[0].clientRelayUri to
  wss://<worker>/relay/<cluster>/<tunnelId>.
- new /relay/<cluster>/<tunnelId> route: validates origin, extracts the tunnel
  connect token from the client's offered subprotocols, opens the real relay WS
  SERVER-SIDE (Authorization header, no browser origin, known-good native path),
  and bridges bytes both ways with sanitized close codes. Echoes the upstream
  negotiated subprotocol back to the browser.
- SSH stays end-to-end (browser<->codespace); the worker sees only ciphertext.
- Frontend unchanged: it already passes the fetched tunnel (now with the
  rewritten relay URI) to connect().
- Tests: 9/9 + 4 new /relay early-return checks pass. Full path needs a live
  browser + codespace to validate; then finalize bindShell.

## MILESTONE — transport fully works (route B proven)
Live log with the worker WS proxy: relayUri now points at the worker; the
relay connects ("Connected with subprotocol 'tunnel-relay-client'") — the 1006
is GONE. Full SSH handshake to the dev-tunnels HOST succeeds (ecdh-sha2-nistp384,
server public key verified, client authenticated), client.connect() RESOLVED,
and the host forwards its ports (3000, 7681, 16634, 16635). The server-side
proxy solved the browser handshake rejection. bindShell still throws (by design);
the session then idles and cleanly reconnects.

## bindShell scope — confirmed from cli/cli ssh.go (the last piece)
The connected session is the dev-tunnels HOST (port-forward multiplexer,
Username: tunnel), NOT a login shell. gh's shell flow to replicate in-browser:
1. generate an SSH keypair (public+private).
2. over the tunnel/forwarder, rpc.CreateInvoker → JSON-RPC (vscode-jsonrpc) to
   the codespace agent (internal control port, likely ~16634).
3. invoker.StartSSHServerWithOptions({UserPublicKeyFile}) → returns
   (remoteSSHServerPort, sshUser); this registers our public key + starts sshd.
4. forward remoteSSHServerPort (internal) and open a stream to it via the
   tunnel client.
5. run a SECOND SshClientSession over that stream, auth as sshUser with the
   private key.
6. open a session channel, request pty + shell, wire to xterm.
This is essentially reimplementing gh's codespace SSH client in the browser
(RPC invoker + key gen/registration + second SSH + shell/pty). Large and only
verifiable in a live browser+codespace. Ports 16634/16635 in the forward list
are likely the internal control/RPC ports.
Pragmatic alternative for bridge-carrying repos: connectToForwardedPort(7681)
→ our in-codespace xterm bridge (working terminal now, but not bare-repo).

## blocker — the codespace agent RPC is gRPC, not JSON-RPC
Correcting the previous bindShell plan: the StartSSHServer RPC runs over gRPC
(HTTP/2 + protobuf) on the codespace's internal port 16634. Confirmed by cli/cli
issue #11206 ("forward the codespaces internal port (16634) ... to connect via
GRPC") and PR #6657 (Live Share RPC → gRPC server). Implication: a browser-only
bare-repo shell would require a gRPC/HTTP/2 client speaking raw gRPC over a raw
tunnel duplex stream (connectToForwardedPort(16634)). That is not practically
implementable in the browser: gRPC-web needs a server-side gRPC-web proxy the
agent doesn't provide, and raw gRPC needs full HTTP/2 framing over the stream.
16634 is a private internal port (not exposed via app.github.dev), so fetch/
gRPC-web can't reach it either.
=> The corner "browser-only + bare-repo + own-terminal" is blocked by the gRPC
   agent requirement. gh can do it (native Go gRPC stack); a browser cannot.
Achievable instead:
- own-terminal + browser-only + repo-with-bridge  = Variant B / E+B (built)
- own-terminal + bare-repo + server component (gRPC) = Variant A (built)
- browser-only + bare-repo + VS Code/Jupyter terminal = Variant E (built)
Pragmatic terminal over the proven transport: connectToForwardedPort(7681) →
in-codespace bridge (needs the bridge in the repo).

## spike — Variant C started: verifiable protocol bricks first
Building the in-browser unary-gRPC-over-HTTP/2 client brick by brick, each
unit-tested in Node before integration.
- frontend-browser-ssh/grpc/protobuf.js — minimal proto3 codec (varint, wire
  types 0/2). Tested against canonical vectors (150→08 96 01; "testing"→12 07…).
- frontend-browser-ssh/grpc/framing.js — gRPC 5-byte length-prefixed framing,
  with partial-trailer handling for streamed reads.
- grpc/grpc.test.mjs: 12/12 pass.
- grpc/README.md documents the full C pipeline, the 8 bricks, and their status,
  plus the honesty note (protocol bricks are unit-testable; integration —
  stream to 16634, live agent gRPC, second SSH, shell — needs live iterations).
Next brick: http2.js (frames) + hpack.js (literal encode + Huffman decode),
the crux; then the agent service/field reverse-engineering and integration.

## note — MS Learn confirms browsers can't call gRPC directly (bears on C)
learn.microsoft.com/aspnet/core/grpc/browser: "It's not possible to directly
call a gRPC service from a browser. gRPC uses HTTP/2 features, and no browser
provides the level of control required over web requests to support a gRPC
client." The two browser-compatible escapes both need SERVER support:
- gRPC-Web: different wire protocol, HTTP/1.1-friendly — but requires the server
  (or an Envoy-style proxy) to speak gRPC-Web. The codespace agent is raw
  grpc-go; it does NOT expose gRPC-Web.
- gRPC JSON transcoding: needs .proto HTTP annotations on the server. Not present.
Nuance for Variant C: that statement is about the browser's fetch/XHR HTTP
client. Variant C does NOT use fetch — it writes raw bytes over a WebSocket to
our worker, which pipes them to the tunnel-forwarded port 16634. Over a raw
duplex byte stream we control every byte, so we CAN implement HTTP/2 ourselves
(that's what the http2.js/hpack.js bricks are for). So the page does not make C
impossible — but it authoritatively confirms C means hand-implementing the
HTTP/2 stack that browsers deliberately don't expose, and that the easy escapes
(gRPC-Web/transcoding) don't apply because the agent doesn't support them.
Decision stands with the user: continue C (huge, browser HTTP/2 from scratch) or
use a Node/Go host (A) where gRPC is trivial.

## spike — Variant C: HTTP/2 + HPACK bricks done (the crux), unit-tested
- grpc/huffman-table.js — RFC 7541 Appendix B table generated programmatically
  from rfc7541.txt (257 entries; verified against 5 known codes incl. EOS).
- grpc/http2.js — frame reader/writer (preface, SETTINGS, HEADERS, DATA,
  WINDOW_UPDATE, RST_STREAM, PING, GOAWAY), incremental FrameReader with
  padding/priority stripping.
- grpc/hpack.js — integer + string coding, static (61) + dynamic table with
  eviction, all literal forms, dynamic-size updates, Huffman encode + decode.
- grpc/protocol.test.mjs: 13/13 pass, including the canonical RFC 7541 vectors
  C.4.1 (request, Huffman) and C.6.1 (response, Huffman + dynamic table), plus
  a full encode→decode round-trip of our gRPC request headers and HTTP/2 frame
  round-trips. protobuf/framing tests still 12/12.
Remaining C bricks: ed25519 keypair → OpenSSH format; unary gRPC call
orchestration (tie protobuf+framing+http2+hpack over the tunnel stream); agent
service/method + field numbers (reverse-engineer from cli/cli
internal/codespaces/grpc); second SSH session + pty/shell → xterm. Integration
remains live-only.

## spike — Variant C: bricks 5 + 6 done (gRPC client interoperates with real HTTP/2)
- grpc/openssh.js — ed25519 keypair via WebCrypto + OpenSSH public-key
  formatting (ssh-ed25519 wire format) and a parser. Tested: line matches an
  independent Node/Buffer construction; round-trip parse; generated key parses
  to a 32-byte key.
- grpc/client.js — GrpcConnection: transport-agnostic unary gRPC over HTTP/2
  over any duplex (send/feed). Preface+SETTINGS handshake, HEADERS+DATA request,
  response HEADERS/DATA + trailers (grpc-status), flow-control window replenish.
- grpc/client.test.mjs: 5/5. The key test stands up a REAL node:http2 server
  speaking gRPC framing + trailers; the hand-rolled client completes a unary
  call (protobuf echo) and the server confirms it saw the correct :path and
  content-type. => our HTTP/2+HPACK+framing+protobuf stack interoperates with a
  production HTTP/2 implementation.
Remaining: brick 7 (agent service/method + field numbers from cli/cli
internal/codespaces/grpc) and brick 8 (second SSH session + pty/shell → xterm),
then live integration (stream to 16634 via the SDK, real agent, real shell).

## fix — Variant C loopback: strip HTTP/2 preface in the mock server
Browser self-test hung at brick 6: the in-page mock fed the 24-byte connection
preface straight into FrameReader, which misread "PRI * HTTP/2..." as a giant
frame and waited forever (node:http2 in the Node test consumes the preface, so
it never surfaced). Factored the mock into grpc/mock-server.js (MockGrpcServer)
that skips PREFACE.length bytes first, used by BOTH the Node test and the
self-test page. Added a Node loopback case so this path is covered without a
browser. Node suites: grpc 12/12, protocol 13/13, client 6/6.

## spike — Variant C: brick 7 done, agent contract nailed from cli/cli source
Downloaded cli/cli v2.83.2 and read
internal/codespaces/rpc/ssh/ssh_server_host_service.v1.proto + invoker.go:
- service: Codespaces.Grpc.SshServerHostService.v1.SshServerHost
- method:  StartRemoteServerAsync
  path:    /Codespaces.Grpc.SshServerHostService.v1.SshServerHost/StartRemoteServerAsync
- StartRemoteServerRequest  { string UserPublicKey = 1 }
- StartRemoteServerResponse { bool Result = 1; string ServerPort = 2;
                              string User = 3; string Message = 4 }
- transport: INSECURE (insecure.NewCredentials()) = plaintext h2c, no TLS/mTLS
  → matches our GrpcConnection exactly. Agent on internal port 16634.
- gh then forwards ServerPort and SSHes as User with the ed25519 private key.
grpc/agent.js encodes/decodes these + startRemoteServer(conn, pubkey) →
{port, user}. grpc/agent.test.mjs 6/6 over the loopback (req field 1, response
parse, success + failure paths, service/method constants).
Remaining: brick 8 — second SSH session (auth as User with our ed25519 key) +
pty/shell → xterm, and the live wiring (SDK stream to 16634 → GrpcConnection →
startRemoteServer → SDK stream to ServerPort → SSH → shell). Live-only.

## spike — Variant C: brick 5→ECDSA + brick 8 wiring (live frontier)
SDK finding: dev-tunnels-ssh supports rsa + ecdsa (nistp256/384/521), NOT
ed25519. So the SSH key must be ecdsa. openssh.js gained ecdsaP256PublicKeyTo
OpenSSH + parseOpenSSHEcdsa + generateEcdsaP256Key (tested vs an independent
construction, 3/3). For a coherent end-to-end the key is generated INSIDE the
SDK (SshAlgorithms.publicKey.ecdsaSha2Nistp256.generateKeyPair →
getPublicKeyBytes) so the same key registers with the agent and signs the SSH
auth.
app.js bindShell now wires the full pipeline with heavy diagnostics:
 8a) connectToForwardedPort(16634) → GrpcConnection → StartRemoteServerAsync
     (openssh pubkey) → {port,user}  [the decisive live test of browser gRPC vs
     the real agent]
 8b) connectToForwardedPort(port) → SshClientSession.connect → authenticate
     {username:user, publicKeys:[keyPair]} → openChannel → requestTerminal +
     requestShell → xterm.
The stream/session/channel API surface is logged on first run (streamAPI helper)
because the ssh bundle is partly minified; 8b request helper names
(requestTerminal/requestShell) are best-effort and may need adjustment from the
first live log. 8a should be solid (bricks 1–7 verified). Live-only from here.

## fix — Variant C 8a: use SshChannel directly (Duplex broken in browser)
Live log: connect() resolved, ports forwarded (incl. 16634), ECDSA key made,
forwarded-tcpip channel to 16634 opened. But connectToForwardedPort returns an
SshStream (extends node:stream.Duplex); esm.sh's stream polyfill is incomplete
in the browser → no on()/write(), and SshStream's internal push() throws
(unhandledrejection from `xo` = SshStream). Fix: SshStream stores the real
SshChannel as `.channel`. wireStream now (a) for the SshStream wrapper, hijacks
`stream.push` to route inbound bytes to our gRPC client while SshStream still
calls channel.adjustWindow, and (b) for a raw SshChannel, subscribes via
onDataReceived + adjustWindow. Outbound goes via channel.send(), serialized.
Also logs .channel presence + channel API. This should let 8a (gRPC
StartRemoteServerAsync over 16634) complete; 8b reuses the same wiring.

## BREAKTHROUGH — 401 diagnosed: agent needs a fixed sentinel auth header
Live diagnostics paid off: the agent replied :status 401, server: Kestrel (the
codespace agent gRPC server is ASP.NET Core, not grpc-go). Our HTTP/2 stack is
correct — the server parsed it and returned a clean 401 for missing auth.
invoker.go shows gh attaches a FIXED header on every RPC:
  metadata.AppendToOutgoingContext(ctx, "Authorization", "Bearer token")
i.e. the literal string "Bearer token" (real auth is at the tunnel layer).
Fix: GrpcConnection.call now takes a metadata object; agent.js sends
{ authorization: "Bearer token" } (AGENT_METADATA). mock-server captures request
headers; agent.test asserts the header is sent. Suites: 12/13/6/7 green.
This should clear the 401 → StartRemoteServerAsync should return {port,user}.

## MILESTONE — 8a fully proven: browser gRPC → real agent → valid response
Live: the auth header cleared the 401. The agent (Kestrel/ASP.NET Core) executed
StartRemoteServerAsync and returned a real StartRemoteServerResponse with
Result=false, Message="Please check if an SSH server is installed in the
container…". So our hand-rolled browser gRPC stack (HTTP/2+HPACK+protobuf+auth)
works end-to-end against the real codespace agent. "Browsers can't do gRPC" is
refuted for our raw-stream path.
The failure is CONFIG, not code: Spacehatch's own devcontainer uses
mcr.microsoft.com/devcontainers/typescript-node:22, which has no sshd. GitHub
docs: "The default dev container image includes an SSH server, which is started
automatically." So a truly BARE repo (no .devcontainer → universal image) has
sshd and StartRemoteServer would return {port,user}. This vindicates Variant C's
bare-repo thesis. Next: test against a bare repo (no devcontainer) → expect
StartRemoteServer OK → then 8b (second SSH + shell). Alternatively add
ghcr.io/devcontainers/features/sshd:1 to a custom devcontainer.

## fix — resilience to transient relay session drops (fresh codespace)
On a fresh bare-repo codespace (silent-fog, universal image) the run hit
"Failed to connect to remote port. Ensure that the client has connected by
calling connectClient" — the tunnel SSH session (bo) drops periodically
("Error reading from stream") and reconnects (session-reconnect). Our port-open
happened during a drop. Hardened bindShell: openForwarded now waits for
client.isSshSessionActive and retries connectToForwardedPort (6x); the 8a
StartRemoteServer step retries up to 4x with a fresh stream + a 20s timeout, so
a mid-call drop is recovered. (Root cause of the ~10s relay drops — possibly the
plain-Worker WS proxy vs Durable Object — still to investigate separately.)

## fix — worker /relay: keep the invocation alive (ctx.waitUntil) → stop ~10s drops
Root cause of the periodic "Error reading from stream" tunnel drops: the plain
Worker's fetch handler returned, and the OUTBOUND relay WebSocket (the fetch
subrequest webSocket) was torn down shortly after — so the tunnel session died
every ~10s and had to session-reconnect, and on the fresh universal-image
codespace it never stabilized. Fix: fetch(request, env, ctx) and
ctx.waitUntil(done), where `done` resolves when either side closes. This keeps
the Worker (and the upstream WS) alive for the whole session. Worker tests green.

## MILESTONE — 8a DONE on a bare repo; 8b needs the sshd port forwarded
Live on a fresh universal-image (bare) codespace, with the worker keepalive fix
the relay stayed stable and: "StartRemoteServer OK → sshPort=2222 user=codespace".
So the entire thesis is proven: bare repo + browser-only + serverless gRPC →
agent starts a real sshd. 8b then hung at connectToForwardedPort(2222): port
2222 is NOT auto-advertised by the host (only 16634/16635 were), so
waitForForwardedPort(2222) never resolves. cli/cli's ssh.go shows gh calls
ForwardPort (CreateTunnelPort via mgmt API + RefreshPorts) before connecting.
First attempt (cheap): openForwarded now calls client.refreshPorts() before
waiting and logs the available forwardedPorts, since codespaces usually
auto-forwards a newly-listening port once refreshed. If 2222 still doesn't
appear, next step is a CreateTunnelPort management call (worker-proxied) like gh.

## 8b — register the sshd port via management API (CreateTunnelPort, worker-proxied)
refreshPorts alone didn't surface port 2222 (host acked RefreshPorts but never
forwarded it → waitForForwardedPort timed out). gh's ForwardPort creates the
port first: PUT https://{cluster}.rel.tunnels.api.visualstudio.com/tunnels/
{tunnelId}/ports/{port}?api-version=2023-09-27-preview, Authorization: tunnel
<managePortsAccessToken>, If-Not-Match: *, body {portNumber, protocol:"http"}
(format + auth confirmed against the existing /tunnel route and the mgmt SDK).
Added worker route POST /port that proxies exactly this; bindShell now calls it
for the agent-started port before refreshPorts + connect, and logs the API
status. tp (tunnelProperties, incl. managePortsAccessToken) threaded into
bindShell. Next live run should show createTunnelPort → api 200 and port 2222
becoming connectable, then the second SSH session.

## 8b — second SSH session over a channel-backed BaseStream (live frontier)
Live got all the way to "opened forwarded-tcpip channel #2 for 127.0.0.1:2222"
then "Failed to read the protocol version" — because we handed the broken-Duplex
SshStream to session.connect. session.connect needs an SDK Stream (BaseStream),
which buffers inbound via onData(buf) and reads via read(). Confirmed exports:
ssh.BaseStream, SshClientSession, SshSessionConfiguration, ChannelRequestMessage,
ChannelOpenMessage. Rewrote 8b: a ChannelStream extends ssh.BaseStream (write →
channel.send; inbound fed via the SshStream push-hijack → stream.onData);
session.onAuthenticating accepts the host key; authenticate({username, publicKeys:
[keyPair]}); session.openChannel() (defaults to a session channel); pty-req
(best-effort) + shell via ChannelRequestMessage; channel.onDataReceived → xterm,
term.onData → channel.send. Live-only; watch for "authenticate → true" then shell.

## MILESTONE — 8b SSH handshake real; fix relay via Durable Object
Fresh bare codespace (quick-horse): StartRemoteServer OK, createTunnelPort →
"Forwarded port 2222 is ready", channel #2 to 127.0.0.1:2222 opened, and the
channel carried a REAL SSH handshake — closed remotely with S:1321 R:3323 (we
sent 1321 bytes, received 3323). So the BaseStream adapter + second SSH session
exchange data with the codespace sshd. The only blocker is relay instability:
the tunnel session (bo) still drops every ~10s ("Error reading from stream")
and kills the handshake mid-flight. ctx.waitUntil wasn't enough — a plain Worker
can't hold the long-lived outbound relay WS. Refactored the /relay bridge into a
Durable Object (RelayProxy) keyed by tunnelId; /relay/* now forwards to the DO,
which holds both WebSockets for the whole session. wrangler.toml gains the DO
binding + a new_sqlite_classes migration (free-tier friendly). Worker tests 9/9.

## MILESTONE — 8b: second SSH connect + AUTH + openChannel all succeed!
Diagnostics (build 3d4dd87): "shell channel opened" printed, i.e. session.connect
✓, authenticate ✓ (we are logged in to the codespace sshd!), openChannel ✓. Then
the forwarded-tcpip channel #2 (transport to 2222) closed remotely 100ms later
(S:1321 R:3323), pty-req timed out, shell failed "Error writing to stream: o
disposed". Root cause: our pty-req was a bare ChannelRequestMessage with
requestType="pty-req" but NO pty payload (TERM/cols/rows/modes) — malformed, so
sshd drops the connection. Removed pty-req; request "shell" only (needs no
payload) to get bytes flowing. Proper pty-req to follow. DO relay held stable
through the whole handshake.

## E2E autonomy + proper pty-req
Confirmed I can drive the deployed page headless (Playwright + Chromium in the
container; WebSocket egress works incl. the full real relay bridge). Baseline
run (build 4c2e162, shell-only) went green through "shell bound to xterm" and
READ ok (Ubuntu MOTD), but terminal scraping via .xterm-rows was unreliable.
Added window.__shellOut (decoded output mirror) + window.__shellSend for the
harness. Implemented a proper pty-req: subclass ssh.ChannelRequestMessage,
onWrite appends RFC 4254 §6.2 payload (TERM, cols, rows, wpx=0, hpx=0, modes=
TTY_OP_END) — like CommandRequestMessage does for exec. Then shell. Harness
test/e2e-launch.mjs types PROBE_CMD via the xterm textarea (real path) and
falls back to __shellSend, checking window.__shellOut for a marker.

## ✅ COMPLETE — fully stable interactive browser terminal (autonomously verified)
Set up headless E2E (Playwright + Chromium in the container; WS egress works incl.
the real relay bridge). Drove the DEPLOYED page with a Codespaces token end-to-end.
Findings + fixes this session:
- Fine-grained PATs can list/get/create/delete codespaces but NOT POST
  /user/codespaces/{name}/start (403). Launch now prefers an Available codespace
  and falls back to CREATE when start 403s.
- Proper pty-req (subclass ChannelRequestMessage, RFC 4254 §6.2 payload) → sshd
  allocates a real pty (colored prompt, line editing). Bare pty-req had dropped sshd.
- Removed a DUPLICATE onDataReceived/onData wiring block that doubled every
  keystroke and output char ("eecchhoo"). Single wiring now.
- Added window-change (resize) so the pty tracks xterm size.
Result (build cfe3ddc), reproducible across runs A/B/C + final:
  StartRemoteServer OK → pty-req true → shell true → shell bound;
  READ ok, keyboard write ok, char-doubling FALSE, STABLE after 45s (DO relay holds).
  ★★ FULLY STABLE INTERACTIVE TERMINAL (read+write).
Test harness: test/e2e-launch.mjs (CODESPACES_TOKEN=… node test/e2e-launch.mjs).
Cleaned up all test codespaces afterward.
