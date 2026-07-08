/**
 * Minimal protobuf (proto3) wire-format codec — only what the codespace agent
 * gRPC messages need: varints and length-delimited fields (strings/bytes),
 * plus int32/int64 varints. Browser + Node compatible (Uint8Array only).
 *
 * Wire types: 0 = varint, 2 = length-delimited. Others are unused here.
 */

export class Writer {
  constructor() {
    this._b = [];
  }
  _varint(n) {
    // Unsigned LEB128. n may be a Number (< 2^53) or BigInt.
    let v = typeof n === "bigint" ? n : BigInt(n);
    if (v < 0n) v += 1n << 64n; // two's complement for negatives
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) b |= 0x80;
      this._b.push(b);
    } while (v > 0n);
    return this;
  }
  _tag(field, wireType) {
    return this._varint((field << 3) | wireType);
  }
  uint32(field, value) {
    if (value === undefined || value === null) return this;
    this._tag(field, 0)._varint(value);
    return this;
  }
  int32(field, value) {
    return this.uint32(field, value);
  }
  bool(field, value) {
    if (value === undefined || value === null) return this;
    this._tag(field, 0)._varint(value ? 1 : 0);
    return this;
  }
  bytes(field, value) {
    if (value === undefined || value === null) return this;
    const buf = typeof value === "string" ? new TextEncoder().encode(value) : value;
    this._tag(field, 2)._varint(buf.length);
    for (const b of buf) this._b.push(b);
    return this;
  }
  string(field, value) {
    return this.bytes(field, value);
  }
  finish() {
    return new Uint8Array(this._b);
  }
}

export class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  get eof() {
    return this.pos >= this.buf.length;
  }
  _varint() {
    let shift = 0n;
    let result = 0n;
    for (;;) {
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }
  /** Read the next field header → { field, wireType }. */
  tag() {
    const t = Number(this._varint());
    return { field: t >>> 3, wireType: t & 0x7 };
  }
  uint32() {
    return Number(this._varint());
  }
  int32() {
    return Number(BigInt.asIntN(32, this._varint()));
  }
  bool() {
    return this._varint() !== 0n;
  }
  bytes() {
    const len = Number(this._varint());
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  string() {
    return new TextDecoder().decode(this.bytes());
  }
  /** Skip a field whose value we don't care about, by wire type. */
  skip(wireType) {
    if (wireType === 0) this._varint();
    else if (wireType === 2) {
      const len = Number(this._varint());
      this.pos += len;
    } else if (wireType === 5) this.pos += 4;
    else if (wireType === 1) this.pos += 8;
    else throw new Error(`cannot skip wire type ${wireType}`);
  }
}
