/**
 * ed25519 key material for the second SSH session:
 *  - generate a keypair via WebCrypto (browser + Node),
 *  - format the public key in OpenSSH `authorized_keys` form to hand to the
 *    agent's StartSSHServer(UserPublicKey) call.
 * The private key stays in the browser (as a CryptoKey) for the SSH auth.
 */

function b64(u8) {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

/** SSH wire "string": 4-byte big-endian length prefix + bytes. */
export function sshString(u8) {
  const out = new Uint8Array(4 + u8.length);
  new DataView(out.buffer).setUint32(0, u8.length, false);
  out.set(u8, 4);
  return out;
}

export function concatBytes(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** raw 32-byte ed25519 public key → "ssh-ed25519 <base64>[ comment]". */
export function ed25519PublicKeyToOpenSSH(raw32, comment = "") {
  if (raw32.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  const type = new TextEncoder().encode("ssh-ed25519");
  const wire = concatBytes([sshString(type), sshString(raw32)]);
  return `ssh-ed25519 ${b64(wire)}${comment ? " " + comment : ""}`;
}

/** Inverse, for tests: parse the raw 32-byte key back out of an OpenSSH line. */
export function parseOpenSSHEd25519(line) {
  const b64part = line.trim().split(/\s+/)[1];
  const bin = atob(b64part);
  const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const dv = new DataView(u8.buffer);
  let p = 0;
  const readStr = () => { const n = dv.getUint32(p, false); p += 4; const s = u8.subarray(p, p + n); p += n; return s; };
  const type = new TextDecoder().decode(readStr());
  const key = readStr();
  if (type !== "ssh-ed25519") throw new Error(`unexpected key type ${type}`);
  return { type, key: key.slice() };
}

/** Generate an ed25519 keypair; returns the OpenSSH public line + CryptoKeys. */
export async function generateEd25519Key(comment = "spacehatch") {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const openssh = ed25519PublicKeyToOpenSSH(publicKeyRaw, comment);
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicKeyRaw, openssh };
}
