/**
 * Minimal HTTP/2 framing — only what a single unary gRPC call needs:
 * connection preface, SETTINGS, HEADERS, DATA, WINDOW_UPDATE, RST_STREAM,
 * PING, GOAWAY. Browser + Node compatible (Uint8Array only). No priority,
 * no push, no CONTINUATION (our header blocks are small enough for one frame).
 */

export const FRAME = {
  DATA: 0x0,
  HEADERS: 0x1,
  RST_STREAM: 0x3,
  SETTINGS: 0x4,
  PING: 0x6,
  GOAWAY: 0x7,
  WINDOW_UPDATE: 0x8,
};

export const FLAG = {
  END_STREAM: 0x1, // DATA, HEADERS
  ACK: 0x1, // SETTINGS, PING
  END_HEADERS: 0x4, // HEADERS
  PADDED: 0x8,
  PRIORITY: 0x20,
};

// Client connection preface (RFC 7540 §3.5): the 24-octet magic string.
export const PREFACE = new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

/** Encode one frame: 9-byte header + payload. */
export function encodeFrame(type, flags, streamId, payload = new Uint8Array(0)) {
  const out = new Uint8Array(9 + payload.length);
  const dv = new DataView(out.buffer);
  // 24-bit length
  out[0] = (payload.length >>> 16) & 0xff;
  out[1] = (payload.length >>> 8) & 0xff;
  out[2] = payload.length & 0xff;
  out[3] = type;
  out[4] = flags;
  dv.setUint32(5, streamId & 0x7fffffff, false); // R bit 0 + 31-bit stream id
  out.set(payload, 9);
  return out;
}

/** SETTINGS frame from an array of [id, value] pairs (empty = defaults). */
export function encodeSettings(settings = []) {
  const payload = new Uint8Array(settings.length * 6);
  const dv = new DataView(payload.buffer);
  settings.forEach(([id, value], i) => {
    dv.setUint16(i * 6, id, false);
    dv.setUint32(i * 6 + 2, value >>> 0, false);
  });
  return encodeFrame(FRAME.SETTINGS, 0, 0, payload);
}

export function encodeSettingsAck() {
  return encodeFrame(FRAME.SETTINGS, FLAG.ACK, 0);
}

export function encodeWindowUpdate(streamId, increment) {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, increment & 0x7fffffff, false);
  return encodeFrame(FRAME.WINDOW_UPDATE, 0, streamId, payload);
}

export function encodeHeaders(streamId, headerBlock, { endStream = false, endHeaders = true } = {}) {
  let flags = 0;
  if (endStream) flags |= FLAG.END_STREAM;
  if (endHeaders) flags |= FLAG.END_HEADERS;
  return encodeFrame(FRAME.HEADERS, flags, streamId, headerBlock);
}

export function encodeData(streamId, data, { endStream = false } = {}) {
  return encodeFrame(FRAME.DATA, endStream ? FLAG.END_STREAM : 0, streamId, data);
}

export function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Incremental frame parser. Feed bytes with push(); it returns any complete
 * frames parsed so far as { type, flags, streamId, payload }. Handles the
 * PADDED flag for DATA/HEADERS and strips the (optional) priority field so
 * `payload` for HEADERS is the raw header-block fragment.
 */
export class FrameReader {
  constructor() {
    this._buf = new Uint8Array(0);
  }
  push(chunk) {
    this._buf = concat([this._buf, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)]);
    const frames = [];
    for (;;) {
      if (this._buf.length < 9) break;
      const len = (this._buf[0] << 16) | (this._buf[1] << 8) | this._buf[2];
      if (this._buf.length < 9 + len) break;
      const type = this._buf[3];
      const flags = this._buf[4];
      const streamId = new DataView(this._buf.buffer, this._buf.byteOffset + 5, 4).getUint32(0, false) & 0x7fffffff;
      let payload = this._buf.subarray(9, 9 + len);
      // Strip padding / priority so callers see the semantic payload.
      if ((type === FRAME.DATA || type === FRAME.HEADERS) && flags & FLAG.PADDED) {
        const padLen = payload[0];
        payload = payload.subarray(1, payload.length - padLen);
      }
      if (type === FRAME.HEADERS && flags & FLAG.PRIORITY) {
        payload = payload.subarray(5); // 4-byte dependency + 1-byte weight
      }
      frames.push({ type, flags, streamId, payload: payload.slice() });
      this._buf = this._buf.subarray(9 + len);
    }
    return frames;
  }
}
