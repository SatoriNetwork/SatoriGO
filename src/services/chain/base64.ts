// base64 for the vault + app-key records.
//
// MOVED VERBATIM out of vault.ts (1.4.0) so the app-key module can share the
// exact same encoder/decoder rather than carry a second copy of it. The bytes
// this produces and accepts are byte-for-byte what vault.ts produced before the
// move, which base64.test.ts pins against fixed vectors AND against
// globalThis.btoa/atob, so every VaultRecord ever written still decodes.
//
// No Buffer, no btoa — identical behaviour in the browser, the MV3 worker and
// node, and CSP-safe (no eval, no WASM).

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode bytes to a standard (padded) base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + '=';
  }
  return out;
}

/** Lookup table for base64 decode; -1 = invalid char, -2 = padding. */
const B64_LOOKUP: Int8Array = (() => {
  const t = new Int8Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  t['='.charCodeAt(0)] = -2;
  return t;
})();

/** Decode a standard base64 string to bytes. Throws on malformed input. */
export function base64ToBytes(b64: string): Uint8Array {
  // Collect the 6-bit values, ignoring padding.
  const vals: number[] = [];
  for (let i = 0; i < b64.length; i++) {
    const v = B64_LOOKUP[b64.charCodeAt(i)];
    if (v === -1) throw new Error('invalid base64 in vault record');
    if (v === -2) break; // padding: no more data
    vals.push(v);
  }
  const outLen = (vals.length * 6) >> 3;
  const out = new Uint8Array(outLen);
  let bits = 0;
  let buf = 0;
  let o = 0;
  for (let i = 0; i < vals.length; i++) {
    buf = (buf << 6) | vals[i];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}
