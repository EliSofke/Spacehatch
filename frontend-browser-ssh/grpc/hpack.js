/**
 * HPACK (RFC 7541) — enough for a single unary gRPC call.
 * Encoder: request header blocks (literal, no Huffman — always valid).
 * Decoder: full — indexed fields, all literal forms, dynamic table size
 * updates, dynamic table with eviction, and Huffman-coded strings.
 * Browser + Node compatible (Uint8Array only).
 */
import { HUFFMAN } from "./huffman-table.js";

// RFC 7541 Appendix A — static table (1-based).
const STATIC = [
  null,
  [":authority", ""], [":method", "GET"], [":method", "POST"], [":path", "/"],
  [":path", "/index.html"], [":scheme", "http"], [":scheme", "https"], [":status", "200"],
  [":status", "204"], [":status", "206"], [":status", "304"], [":status", "400"],
  [":status", "404"], [":status", "500"], ["accept-charset", ""], ["accept-encoding", "gzip, deflate"],
  ["accept-language", ""], ["accept-ranges", ""], ["accept", ""], ["access-control-allow-origin", ""],
  ["age", ""], ["allow", ""], ["authorization", ""], ["cache-control", ""],
  ["content-disposition", ""], ["content-encoding", ""], ["content-language", ""], ["content-length", ""],
  ["content-location", ""], ["content-range", ""], ["content-type", ""], ["cookie", ""],
  ["date", ""], ["etag", ""], ["expect", ""], ["expires", ""],
  ["from", ""], ["host", ""], ["if-match", ""], ["if-modified-since", ""],
  ["if-none-match", ""], ["if-range", ""], ["if-unmodified-since", ""], ["last-modified", ""],
  ["link", ""], ["location", ""], ["max-forwards", ""], ["proxy-authenticate", ""],
  ["proxy-authorization", ""], ["range", ""], ["referer", ""], ["refresh", ""],
  ["retry-after", ""], ["server", ""], ["set-cookie", ""], ["strict-transport-security", ""],
  ["transfer-encoding", ""], ["user-agent", ""], ["vary", ""], ["via", ""],
  ["www-authenticate", ""],
];

// ---- Huffman decode structure: code length → (code → symbol) ---------------
const CODES_BY_LEN = new Map();
HUFFMAN.forEach(([code, len], sym) => {
  if (!CODES_BY_LEN.has(len)) CODES_BY_LEN.set(len, new Map());
  CODES_BY_LEN.get(len).set(code, sym);
});

function huffmanDecode(bytes) {
  const out = [];
  let cur = 0;
  let len = 0;
  for (let i = 0; i < bytes.length; i++) {
    for (let bit = 7; bit >= 0; bit--) {
      cur = (cur << 1) | ((bytes[i] >> bit) & 1);
      len++;
      const byLen = CODES_BY_LEN.get(len);
      if (byLen && byLen.has(cur)) {
        const sym = byLen.get(cur);
        if (sym === 256) throw new Error("HPACK: EOS symbol in Huffman string");
        out.push(sym);
        cur = 0;
        len = 0;
      }
    }
  }
  // Trailing bits must be EOS-prefix padding: fewer than 8 bits, all ones.
  if (len >= 8) throw new Error("HPACK: Huffman padding too long");
  if (len > 0 && cur !== (1 << len) - 1) throw new Error("HPACK: bad Huffman padding");
  return new Uint8Array(out);
}

function huffmanEncode(bytes) {
  const bits = [];
  for (const b of bytes) {
    const [code, len] = HUFFMAN[b];
    for (let i = len - 1; i >= 0; i--) bits.push((code >> i) & 1);
  }
  while (bits.length % 8 !== 0) bits.push(1); // pad with EOS MSBs (ones)
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  return out;
}

// ---- integer coding (RFC 7541 §5.1) ----------------------------------------
function encodeInteger(value, prefixBits, firstByteHigh) {
  const max = (1 << prefixBits) - 1;
  const out = [];
  if (value < max) {
    out.push(firstByteHigh | value);
  } else {
    out.push(firstByteHigh | max);
    value -= max;
    while (value >= 128) {
      out.push((value & 0x7f) | 0x80);
      value >>= 7;
    }
    out.push(value);
  }
  return out;
}

function decodeInteger(buf, pos, prefixBits) {
  const max = (1 << prefixBits) - 1;
  let value = buf[pos] & max;
  pos++;
  if (value < max) return { value, pos };
  let m = 0;
  for (;;) {
    const b = buf[pos++];
    value += (b & 0x7f) * 2 ** m;
    m += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, pos };
}

// ---- string coding ----------------------------------------------------------
function decodeString(buf, pos) {
  const huffman = (buf[pos] & 0x80) !== 0;
  const { value: len, pos: p } = decodeInteger(buf, pos, 7);
  const raw = buf.subarray(p, p + len);
  const bytes = huffman ? huffmanDecode(raw) : raw;
  return { str: new TextDecoder().decode(bytes), pos: p + len };
}

function encodeString(str, useHuffman = false) {
  const raw = new TextEncoder().encode(str);
  const data = useHuffman ? huffmanEncode(raw) : raw;
  const header = encodeInteger(data.length, 7, useHuffman ? 0x80 : 0x00);
  return Uint8Array.from([...header, ...data]);
}

// ---- decoder with dynamic table --------------------------------------------
export class Decoder {
  constructor(maxDynamicSize = 4096) {
    this.maxSize = maxDynamicSize;
    this.dyn = []; // most-recent first; entries [name, value]
    this.size = 0;
  }
  _evict() {
    while (this.size > this.maxSize && this.dyn.length) {
      const [n, v] = this.dyn.pop();
      this.size -= n.length + v.length + 32;
    }
  }
  _insert(name, value) {
    this.dyn.unshift([name, value]);
    this.size += name.length + value.length + 32;
    this._evict();
  }
  _lookup(index) {
    if (index >= 1 && index <= 61) return STATIC[index];
    const d = this.dyn[index - 62];
    if (!d) throw new Error(`HPACK: invalid table index ${index}`);
    return d;
  }
  setMaxSize(n) {
    this.maxSize = n;
    this._evict();
  }
  decode(block) {
    const headers = [];
    let i = 0;
    while (i < block.length) {
      const b = block[i];
      if (b & 0x80) {
        // Indexed header field.
        const { value: index, pos } = decodeInteger(block, i, 7);
        i = pos;
        const [name, value] = this._lookup(index);
        headers.push([name, value]);
      } else if (b & 0x40) {
        // Literal with incremental indexing (6-bit prefix name index).
        const r = this._readNameValue(block, i, 6);
        i = r.pos;
        this._insert(r.name, r.value);
        headers.push([r.name, r.value]);
      } else if ((b & 0x20) === 0x20) {
        // Dynamic table size update (5-bit prefix).
        const { value, pos } = decodeInteger(block, i, 5);
        i = pos;
        this.setMaxSize(value);
      } else {
        // Literal without indexing (0x00) or never indexed (0x10): 4-bit prefix.
        const r = this._readNameValue(block, i, 4);
        i = r.pos;
        headers.push([r.name, r.value]);
      }
    }
    return headers;
  }
  _readNameValue(block, i, prefixBits) {
    const { value: nameIndex, pos } = decodeInteger(block, i, prefixBits);
    i = pos;
    let name;
    if (nameIndex !== 0) {
      name = this._lookup(nameIndex)[0];
    } else {
      const s = decodeString(block, i);
      name = s.str;
      i = s.pos;
    }
    const v = decodeString(block, i);
    return { name, value: v.str, pos: v.pos };
  }
}

// ---- encoder (requests): literal, no Huffman, no dynamic-table growth -------
function findStatic(name, value) {
  for (let i = 1; i <= 61; i++) {
    if (STATIC[i][0] === name && STATIC[i][1] === value) return { full: i };
  }
  for (let i = 1; i <= 61; i++) {
    if (STATIC[i][0] === name) return { nameOnly: i };
  }
  return {};
}

export function encodeHeaderBlock(headers) {
  const out = [];
  for (const [name, value] of headers) {
    const hit = findStatic(name, value);
    if (hit.full) {
      out.push(...encodeInteger(hit.full, 7, 0x80)); // indexed
    } else if (hit.nameOnly) {
      // literal without indexing, indexed name (4-bit prefix)
      out.push(...encodeInteger(hit.nameOnly, 4, 0x00));
      out.push(...encodeString(value, false));
    } else {
      // literal without indexing, literal name
      out.push(0x00);
      out.push(...encodeString(name, false));
      out.push(...encodeString(value, false));
    }
  }
  return new Uint8Array(out);
}

export const _internal = { encodeInteger, decodeInteger, huffmanDecode, huffmanEncode, encodeString, decodeString, STATIC };
