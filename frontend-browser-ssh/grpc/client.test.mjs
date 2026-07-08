/**
 * Brick 5 + 6 tests.
 *  - openssh: OpenSSH ed25519 formatting vs an independent construction + parse.
 *  - client: the hand-rolled unary gRPC client against a REAL node:http2 server
 *    that speaks gRPC framing + trailers. Run: node client.test.mjs
 */
import net from "node:net";
import http2 from "node:http2";
import { ed25519PublicKeyToOpenSSH, parseOpenSSHEd25519, generateEd25519Key } from "./openssh.js";
import { Writer, Reader } from "./protobuf.js";
import { encodeMessage, decodeMessages } from "./framing.js";
import { GrpcConnection } from "./client.js";
import { MockGrpcServer } from "./mock-server.js";

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`); }
}
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");

// ---- brick 5: OpenSSH ed25519 formatting -----------------------------------
{
  // Fixed 32-byte key → OpenSSH line, cross-checked with an independent
  // Node/Buffer construction of the same wire format.
  const raw = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const line = ed25519PublicKeyToOpenSSH(raw, "test@host");

  const type = Buffer.from("ssh-ed25519");
  const sstr = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  const wire = Buffer.concat([sstr(type), sstr(Buffer.from(raw))]);
  const expected = `ssh-ed25519 ${wire.toString("base64")} test@host`;
  eq(line, expected, "openssh ed25519 line matches independent construction");

  // Round-trip parse recovers the raw key and type.
  const parsed = parseOpenSSHEd25519(line);
  eq([parsed.type, hex(parsed.key)], ["ssh-ed25519", hex(raw)], "openssh parse round-trip");
}
{
  // A generated key produces a well-formed, parseable line with a 32-byte key.
  const { openssh, publicKeyRaw } = await generateEd25519Key("gen");
  const parsed = parseOpenSSHEd25519(openssh);
  eq([openssh.startsWith("ssh-ed25519 "), parsed.key.length, hex(parsed.key)],
     [true, 32, hex(publicKeyRaw)], "generated key formats + parses");
}

// ---- brick 6: unary gRPC client vs a real node:http2 server -----------------
await new Promise((done) => {
  // A minimal gRPC server: reads a protobuf {1:string name}, replies
  // {1:string ("hello, "+name), 2:uint 4242}, with trailer grpc-status: 0.
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    const chunks = [];
    stream.on("data", (d) => chunks.push(new Uint8Array(d)));
    stream.on("end", () => {
      const buf = chunks.length ? Buffer.concat(chunks.map(Buffer.from)) : Buffer.alloc(0);
      const { messages } = decodeMessages(new Uint8Array(buf));
      const req = new Reader(messages[0]);
      let name = "";
      while (!req.eof) { const { field, wireType } = req.tag(); if (field === 1) name = req.string(); else req.skip(wireType); }
      const body = new Writer().string(1, `hello, ${name}`).uint32(2, 4242).finish();
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.from(encodeMessage(body)));
      // record the observed request path for assertion
      server._lastPath = headers[":path"];
      server._lastCT = headers["content-type"];
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const sock = net.connect(port, "127.0.0.1", async () => {
      const conn = new GrpcConnection((bytes) => sock.write(Buffer.from(bytes)), { authority: "codespace-internal" });
      sock.on("data", (d) => conn.feed(new Uint8Array(d)));
      try {
        const reqBytes = new Writer().string(1, "spacehatch").finish();
        const { message } = await conn.call("codespaces.grpc.CodespaceHost", "StartSshServer", reqBytes);
        const r = new Reader(message);
        const out = {};
        while (!r.eof) { const { field, wireType } = r.tag(); if (field === 1) out.msg = r.string(); else if (field === 2) out.n = r.uint32(); else r.skip(wireType); }
        eq(out, { msg: "hello, spacehatch", n: 4242 }, "unary gRPC call round-trip vs node:http2");
        eq([server._lastPath, server._lastCT], ["/codespaces.grpc.CodespaceHost/StartSshServer", "application/grpc"], "server saw correct path + content-type");
      } catch (e) {
        fail++; console.error("FAIL unary call threw:", e.message);
      } finally {
        sock.end(); server.close(); done();
      }
    });
  });
});

// ---- brick 6b: client vs the shared in-memory MockGrpcServer (loopback) ----
{
  let server;
  const conn = new GrpcConnection((b) => server.feed(b), { authority: "codespace-internal" });
  server = new MockGrpcServer((b) => conn.feed(b), (reqMsg) => {
    const r = new Reader(reqMsg); let name = "";
    while (!r.eof) { const { field, wireType } = r.tag(); if (field === 1) name = r.string(); else r.skip(wireType); }
    return new Writer().string(1, `hi ${name}`).finish();
  });
  const { message } = await conn.call("pkg.Svc", "M", new Writer().string(1, "loop").finish());
  const r = new Reader(message); let msg = "";
  while (!r.eof) { const { field, wireType } = r.tag(); if (field === 1) msg = r.string(); else r.skip(wireType); }
  eq(msg, "hi loop", "loopback vs MockGrpcServer (preface handled)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
