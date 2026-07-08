/**
 * A minimal mock HTTP/2 gRPC server built from our own encoders, for loopback
 * testing the client in environments without node:http2 (the browser). It
 * mirrors what a real server does: consume the 24-byte connection preface,
 * ACK SETTINGS, then answer a unary call with response DATA + grpc-status
 * trailers. The response body is produced by a caller-supplied handler.
 */
import { PREFACE, FRAME, FLAG, encodeSettingsAck, encodeHeaders, encodeData, FrameReader } from "./http2.js";
import { Decoder, encodeHeaderBlock } from "./hpack.js";
import { encodeMessage, decodeMessages } from "./framing.js";

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export class MockGrpcServer {
  /** handler(requestBytes) → responseBytes (both gRPC message bodies, unframed). */
  constructor(send, handler) {
    this.send = send;
    this.handler = handler;
    this.reader = new FrameReader();
    this.dec = new Decoder();
    this.req = new Map();
    this.prefaceLeft = PREFACE.length;
  }
  feed(bytes) {
    if (this.prefaceLeft > 0) {
      const skip = Math.min(this.prefaceLeft, bytes.length);
      this.prefaceLeft -= skip;
      bytes = bytes.subarray(skip);
      if (bytes.length === 0) return;
    }
    for (const f of this.reader.push(bytes)) {
      if (f.type === FRAME.SETTINGS) {
        if (!(f.flags & FLAG.ACK)) this.send(encodeSettingsAck());
      } else if (f.type === FRAME.HEADERS) {
        this.lastHeaders = Object.fromEntries(this.dec.decode(f.payload));
        if (!this.req.has(f.streamId)) this.req.set(f.streamId, []);
      } else if (f.type === FRAME.DATA) {
        const a = this.req.get(f.streamId) || [];
        if (f.payload.length) a.push(f.payload);
        this.req.set(f.streamId, a);
        if (f.flags & FLAG.END_STREAM) this._respond(f.streamId, a);
      }
    }
  }
  _respond(id, chunks) {
    const { messages } = decodeMessages(concat(chunks));
    const responseBody = this.handler(messages[0]);
    this.send(encodeHeaders(id, encodeHeaderBlock([[":status", "200"], ["content-type", "application/grpc"]]), { endHeaders: true }));
    this.send(encodeData(id, encodeMessage(responseBody), { endStream: false }));
    this.send(encodeHeaders(id, encodeHeaderBlock([["grpc-status", "0"]]), { endStream: true, endHeaders: true }));
  }
}
