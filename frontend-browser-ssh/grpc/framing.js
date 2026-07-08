/**
 * gRPC message framing: each message is
 *   [1 byte compressed-flag][4 bytes big-endian length][message bytes].
 * We never compress (flag = 0). Browser + Node compatible.
 */

/** Wrap a protobuf message body into a single gRPC length-prefixed frame. */
export function encodeMessage(body) {
  const out = new Uint8Array(5 + body.length);
  out[0] = 0; // not compressed
  new DataView(out.buffer).setUint32(1, body.length, false); // big-endian
  out.set(body, 5);
  return out;
}

/**
 * Decode zero or more gRPC frames from a buffer. Returns the parsed message
 * bodies and the number of bytes consumed (so a caller can keep a remainder for
 * streamed data). A partial trailing frame is left unconsumed.
 */
export function decodeMessages(buf) {
  const messages = [];
  let pos = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (pos + 5 <= buf.length) {
    const compressed = buf[pos];
    const len = view.getUint32(pos + 1, false);
    if (pos + 5 + len > buf.length) break; // wait for more bytes
    if (compressed) throw new Error("gRPC compression not supported");
    messages.push(buf.subarray(pos + 5, pos + 5 + len));
    pos += 5 + len;
  }
  return { messages, consumed: pos };
}
