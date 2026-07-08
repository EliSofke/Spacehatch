/**
 * Unit tests for the Variant C protocol bricks. Run: node grpc.test.mjs
 * Verifies against canonical protobuf encodings and gRPC framing round-trips.
 */
import { Writer, Reader } from "./protobuf.js";
import { encodeMessage, decodeMessages } from "./framing.js";

let pass = 0;
let fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
  }
}
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join(" ");

// --- protobuf canonical vectors (from the protobuf encoding spec) -----------
// field 1 (varint) = 150  →  08 96 01
eq(hex(new Writer().uint32(1, 150).finish()), "08 96 01", "varint 150");
// field 2 (string) = "testing"  →  12 07 74 65 73 74 69 6e 67
eq(hex(new Writer().string(2, "testing").finish()), "12 07 74 65 73 74 69 6e 67", "string testing");
// bool true field 3  →  18 01
eq(hex(new Writer().bool(3, true).finish()), "18 01", "bool true");

// --- protobuf round-trip -----------------------------------------------------
{
  const body = new Writer().string(1, "ssh-ed25519 AAAA... user@host").uint32(2, 22).bool(3, true).finish();
  const r = new Reader(body);
  const fields = {};
  while (!r.eof) {
    const { field, wireType } = r.tag();
    if (field === 1) fields.key = r.string();
    else if (field === 2) fields.port = r.uint32();
    else if (field === 3) fields.flag = r.bool();
    else r.skip(wireType);
  }
  eq(fields, { key: "ssh-ed25519 AAAA... user@host", port: 22, flag: true }, "protobuf round-trip");
}

// --- unknown-field skip ------------------------------------------------------
{
  // field 9 varint (unknown) then field 1 string "ok"
  const body = new Writer().uint32(9, 12345).string(1, "ok").finish();
  const r = new Reader(body);
  let val = null;
  while (!r.eof) {
    const { field, wireType } = r.tag();
    if (field === 1) val = r.string();
    else r.skip(wireType);
  }
  eq(val, "ok", "skip unknown field");
}

// --- gRPC framing ------------------------------------------------------------
{
  const body = new Writer().string(1, "hello").finish();
  const frame = encodeMessage(body);
  eq(frame[0], 0, "grpc frame flag=0");
  eq([frame[1], frame[2], frame[3], frame[4]], [0, 0, 0, body.length], "grpc frame length BE");
  const { messages, consumed } = decodeMessages(frame);
  eq(messages.length, 1, "grpc decode one message");
  eq(hex(messages[0]), hex(body), "grpc decode body matches");
  eq(consumed, frame.length, "grpc decode consumed all");
}

// --- gRPC framing: two messages + partial trailer ---------------------------
{
  const b1 = encodeMessage(new Writer().uint32(1, 1).finish());
  const b2 = encodeMessage(new Writer().uint32(1, 2).finish());
  const joined = new Uint8Array(b1.length + b2.length + 3);
  joined.set(b1, 0);
  joined.set(b2, b1.length);
  // 3 trailing bytes = incomplete third frame header
  const { messages, consumed } = decodeMessages(joined);
  eq(messages.length, 2, "grpc decode two whole messages");
  eq(consumed, b1.length + b2.length, "grpc decode leaves partial trailer");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
