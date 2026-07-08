/**
 * Brick 7: the agent StartRemoteServerAsync call, exercised end-to-end over the
 * GrpcConnection ↔ MockGrpcServer loopback. Verifies our request carries the
 * public key at field 1 and we parse ServerPort/User from the response.
 * Run: node agent.test.mjs
 */
import { Reader } from "./protobuf.js";
import { Writer } from "./protobuf.js";
import { GrpcConnection } from "./client.js";
import { MockGrpcServer } from "./mock-server.js";
import { startRemoteServer, decodeStartRemoteServerResponse, encodeStartRemoteServerRequest, SSH_SERVICE, START_REMOTE_SERVER } from "./agent.js";

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`); }
}

// request/response codec round-trip
{
  const reqBytes = encodeStartRemoteServerRequest("ssh-ed25519 AAAA... spacehatch");
  const r = new Reader(reqBytes);
  let key = "";
  while (!r.eof) { const { field, wireType } = r.tag(); if (field === 1) key = r.string(); else r.skip(wireType); }
  eq(key, "ssh-ed25519 AAAA... spacehatch", "request encodes UserPublicKey at field 1");

  const respBytes = new Writer().bool(1, true).string(2, "2222").string(3, "codespace").finish();
  eq(decodeStartRemoteServerResponse(respBytes), { result: true, serverPort: "2222", user: "codespace", message: "" }, "response decodes fields 1-3");
}

// end-to-end over the loopback
await (async () => {
  let seenKey = null;
  let server;
  const conn = new GrpcConnection((b) => server.feed(b), { authority: "codespace-internal" });
  server = new MockGrpcServer((b) => conn.feed(b), (reqMsg) => {
    const r = new Reader(reqMsg);
    while (!r.eof) { const { field, wireType } = r.tag(); if (field === 1) seenKey = r.string(); else r.skip(wireType); }
    // emulate the agent: Result=true, ServerPort=2222, User=codespace
    return new Writer().bool(1, true).string(2, "2222").string(3, "codespace").finish();
  });

  const { port, user } = await startRemoteServer(conn, "ssh-ed25519 KEYDATA me@spacehatch");
  eq({ port, user }, { port: 2222, user: "codespace" }, "startRemoteServer returns parsed port + user");
  eq(seenKey, "ssh-ed25519 KEYDATA me@spacehatch", "agent received our public key");
  eq(server.lastHeaders && server.lastHeaders.authorization, "Bearer token", "sends Authorization: Bearer token metadata");
  eq([SSH_SERVICE, START_REMOTE_SERVER], ["Codespaces.Grpc.SshServerHostService.v1.SshServerHost", "StartRemoteServerAsync"], "service/method constants");
})();

// failure path: Result=false → throws with Message
await (async () => {
  let server;
  const conn = new GrpcConnection((b) => server.feed(b));
  server = new MockGrpcServer((b) => conn.feed(b), () => new Writer().bool(1, false).string(4, "sshd not installed").finish());
  let threw = "";
  try { await startRemoteServer(conn, "k"); } catch (e) { threw = e.message; }
  eq(threw, "StartRemoteServer failed: sshd not installed", "Result=false throws with Message");
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
