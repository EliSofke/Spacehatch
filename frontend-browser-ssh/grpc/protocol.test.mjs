/**
 * HTTP/2 + HPACK unit tests. Run: node protocol.test.mjs
 * HPACK cases are the canonical RFC 7541 Appendix C examples (incl. Huffman).
 */
import { FRAME, FLAG, encodeSettings, encodeHeaders, encodeData, FrameReader } from "./http2.js";
import { Decoder, encodeHeaderBlock, _internal } from "./hpack.js";

let pass = 0, fail = 0;
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (s) => Uint8Array.from(s.replace(/\s+/g, "").match(/../g).map((h) => parseInt(h, 16)));
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`); }
}

// ---- integer coding (RFC 7541 C.1) -----------------------------------------
eq(_internal.encodeInteger(10, 5, 0), [0x0a], "int 10 / 5-bit");
eq(_internal.encodeInteger(1337, 5, 0), [0x1f, 0x9a, 0x0a], "int 1337 / 5-bit");
eq(_internal.encodeInteger(42, 8, 0), [0x2a], "int 42 / 8-bit");
eq(_internal.decodeInteger(bytes("1f9a0a"), 0, 5).value, 1337, "decode int 1337");

// ---- Huffman (from RFC 7541 C.4.1 value "www.example.com") ------------------
eq(new TextDecoder().decode(_internal.huffmanDecode(bytes("f1e3c2e5f23a6ba0ab90f4ff"))),
   "www.example.com", "huffman decode www.example.com");
eq(hex(_internal.huffmanEncode(new TextEncoder().encode("www.example.com"))),
   "f1e3c2e5f23a6ba0ab90f4ff", "huffman encode www.example.com");

// ---- HPACK decode: RFC 7541 C.4.1 (request, Huffman) -----------------------
{
  const dec = new Decoder();
  const headers = dec.decode(bytes("828684418cf1e3c2e5f23a6ba0ab90f4ff"));
  eq(headers, [[":method", "GET"], [":scheme", "http"], [":path", "/"], [":authority", "www.example.com"]],
     "decode C.4.1 request");
}

// ---- HPACK decode: RFC 7541 C.6.1 (response, Huffman, dyn table) ------------
{
  const dec = new Decoder(256);
  const block =
    "488264025885aec3771a4b6196d07abe" +
    "941054d444a8200595040b8166e082a6" +
    "2d1bff6e919d29ad171863c78f0b97c8" +
    "e9ae82ae43d3";
  const headers = dec.decode(bytes(block));
  eq(headers, [
    [":status", "302"],
    ["cache-control", "private"],
    ["date", "Mon, 21 Oct 2013 20:13:21 GMT"],
    ["location", "https://www.example.com"],
  ], "decode C.6.1 response");
}

// ---- HPACK encode → decode round-trip (our gRPC request headers) -----------
{
  const reqHeaders = [
    [":method", "POST"],
    [":scheme", "http"],
    [":path", "/codespaces.grpc.CodespaceHost/StartSshServer"],
    [":authority", "codespace-internal"],
    ["content-type", "application/grpc"],
    ["te", "trailers"],
    ["user-agent", "spacehatch-grpc/0"],
  ];
  const block = encodeHeaderBlock(reqHeaders);
  const back = new Decoder().decode(block);
  eq(back, reqHeaders, "encode→decode request headers round-trip");
}

// ---- HTTP/2 framing round-trip ---------------------------------------------
{
  const reader = new FrameReader();
  const stream = new Uint8Array([
    ...encodeSettings([[0x3, 100]]),
    ...encodeHeaders(1, new Uint8Array([0x82, 0x86]), { endStream: false, endHeaders: true }),
    ...encodeData(1, new Uint8Array([0xde, 0xad, 0xbe, 0xef]), { endStream: true }),
  ]);
  // feed in two chunks to exercise the incremental parser
  const frames = [...reader.push(stream.subarray(0, 12)), ...reader.push(stream.subarray(12))];
  eq(frames.length, 3, "framing: 3 frames parsed");
  eq(frames[0].type, FRAME.SETTINGS, "framing: settings type");
  eq([frames[1].type, frames[1].streamId, hex(frames[1].payload)], [FRAME.HEADERS, 1, "8286"], "framing: headers");
  eq([frames[2].type, (frames[2].flags & FLAG.END_STREAM) !== 0, hex(frames[2].payload)],
     [FRAME.DATA, true, "deadbeef"], "framing: data + END_STREAM");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
