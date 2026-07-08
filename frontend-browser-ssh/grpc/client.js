/**
 * Minimal unary gRPC-over-HTTP/2 client over an arbitrary duplex byte stream.
 *
 * Transport-agnostic: construct with a `send(Uint8Array)` sink and feed inbound
 * bytes via `feed(bytes)`. In the browser the stream is the tunnel-forwarded
 * port 16634; in tests it is a TCP socket to a real node:http2 server.
 *
 * Supports exactly what a unary call needs: preface + SETTINGS handshake,
 * one HEADERS + one DATA(END_STREAM) request, and response HEADERS/DATA +
 * trailers (grpc-status). No streaming, no CONTINUATION.
 */
import {
  PREFACE, FRAME, FLAG, encodeFrame, encodeSettings, encodeSettingsAck,
  encodeHeaders, encodeData, encodeWindowUpdate, FrameReader,
} from "./http2.js";
import { Decoder, encodeHeaderBlock } from "./hpack.js";
import { encodeMessage, decodeMessages } from "./framing.js";

const SETTINGS_INITIAL_WINDOW_SIZE = 0x4;
const MAX_WINDOW = 0x7fffffff;

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export class GrpcConnection {
  constructor(send, { authority = "localhost", userAgent = "spacehatch-grpc/0", debug = null } = {}) {
    this._send = send;
    this.authority = authority;
    this.userAgent = userAgent;
    this.debug = debug;
    this.reader = new FrameReader();
    this.hpackDec = new Decoder();
    this.nextStreamId = 1;
    this.streams = new Map();
    this._started = false;
    this._rx = []; // raw inbound bytes (for diagnostics)
  }

  _start() {
    if (this._started) return;
    this._started = true;
    this._send(PREFACE);
    this._send(encodeSettings([[SETTINGS_INITIAL_WINDOW_SIZE, MAX_WINDOW]]));
    // Grow the connection-level receive window so responses aren't blocked.
    this._send(encodeWindowUpdate(0, MAX_WINDOW - 65535));
  }

  feed(chunk) {
    if (this.debug) {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (this._rx.length < 8) this._rx.push(Array.from(u8.subarray(0, 64)).map((b) => b.toString(16).padStart(2, "0")).join(""));
    }
    for (const f of this.reader.push(chunk)) {
      if (this.debug) this.debug(`h2 frame type=${f.type} flags=${f.flags} stream=${f.streamId} len=${f.payload.length}`);
      this._onFrame(f);
    }
  }

  _onFrame(f) {
    if (f.type === FRAME.SETTINGS) {
      if (!(f.flags & FLAG.ACK)) this._send(encodeSettingsAck());
      return;
    }
    if (f.type === FRAME.PING) {
      if (!(f.flags & FLAG.ACK)) this._send(encodeFrame(FRAME.PING, FLAG.ACK, 0, f.payload));
      return;
    }
    if (f.type === FRAME.GOAWAY) {
      for (const [, st] of this.streams) st.reject(new Error("connection GOAWAY"));
      this.streams.clear();
      return;
    }
    if (f.type === FRAME.WINDOW_UPDATE) return;

    const st = this.streams.get(f.streamId);
    if (!st) return;
    if (f.type === FRAME.HEADERS) {
      for (const [k, v] of this.hpackDec.decode(f.payload)) st.headers[k] = v;
      if (f.flags & FLAG.END_STREAM) this._finish(f.streamId);
    } else if (f.type === FRAME.DATA) {
      if (f.payload.length) {
        st.data.push(f.payload);
        // Replenish both connection- and stream-level flow-control windows.
        this._send(encodeWindowUpdate(0, f.payload.length));
        this._send(encodeWindowUpdate(f.streamId, f.payload.length));
      }
      if (f.flags & FLAG.END_STREAM) this._finish(f.streamId);
    } else if (f.type === FRAME.RST_STREAM) {
      st.reject(new Error("stream reset by peer"));
      this.streams.delete(f.streamId);
    }
  }

  _finish(id) {
    const st = this.streams.get(id);
    if (!st) return;
    this.streams.delete(id);
    if (this.debug) this.debug(`response headers: ${JSON.stringify(st.headers)}; dataChunks=${st.data.length}; rx=${this._rx.join(" ")}`);
    const status = st.headers["grpc-status"];
    if (status !== undefined && status !== "0") {
      st.reject(new Error(`grpc-status ${status}: ${st.headers["grpc-message"] || ""}`));
      return;
    }
    const { messages } = decodeMessages(concat(st.data));
    if (!messages.length) {
      st.reject(new Error(`gRPC: no response message; headers=${JSON.stringify(st.headers)}`));
      return;
    }
    st.resolve({ message: messages[0], headers: st.headers });
  }

  /** Unary call. `service` like "pkg.Service", `method` like "Method". */
  call(service, method, requestBytes) {
    this._start();
    const id = this.nextStreamId;
    this.nextStreamId += 2;
    const headerBlock = encodeHeaderBlock([
      [":method", "POST"],
      [":scheme", "http"],
      [":path", `/${service}/${method}`],
      [":authority", this.authority],
      ["content-type", "application/grpc"],
      ["te", "trailers"],
      ["grpc-encoding", "identity"],
      ["user-agent", this.userAgent],
    ]);
    return new Promise((resolve, reject) => {
      this.streams.set(id, { resolve, reject, headers: {}, data: [] });
      this._send(encodeHeaders(id, headerBlock, { endStream: false, endHeaders: true }));
      this._send(encodeData(id, encodeMessage(requestBytes), { endStream: true }));
    });
  }
}
