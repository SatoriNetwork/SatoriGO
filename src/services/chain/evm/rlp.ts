// RLP (Recursive Length Prefix): the only serialization Ethereum uses for a
// transaction. Everything an EVM signer touches (the signing preimage, the raw
// bytes eth_sendRawTransaction takes, the txid preimage) is RLP.
//
// The encoder follows the yellow paper. The decoder is deliberately STRICT: it
// rejects every non canonical encoding (a byte < 0x80 wrapped as a 1 byte
// string, a long form length that would have fit the short form, a length with
// a leading zero byte, trailing bytes, truncation) instead of guessing. On the
// money path an input that decodes two ways is a loss waiting to happen, and
// "decode then re-encode differs" is exactly how a transaction gets a txid
// nobody expected.
//
// Pure bytes in, bytes out: no network, no crypto, no ambient state.

/** A byte string, or a (possibly nested) list of them. Nothing else. */
export type RlpInput = Uint8Array | RlpInput[];

/** Longest length-of-length RLP allows (a 2^64 payload). */
const MAX_LENGTH_OF_LENGTH = 8;

/** Guard against a hostile blob nesting deep enough to blow the JS stack. */
const MAX_DEPTH = 1024;

function isBytes(value: RlpInput): value is Uint8Array {
  return value instanceof Uint8Array;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Minimal big endian bytes of a payload length (never has a leading zero). */
function lengthToBytes(len: number): Uint8Array {
  const out: number[] = [];
  let rest = len;
  while (rest > 0) {
    out.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return Uint8Array.from(out);
}

/**
 * The prefix for a payload of `len` bytes. `offset` is 0x80 for strings and
 * 0xc0 for lists, which is the whole difference between the two forms.
 */
function encodeLength(len: number, offset: number): Uint8Array {
  if (!Number.isSafeInteger(len) || len < 0) throw new Error('rlp: bad payload length');
  if (len < 56) return Uint8Array.of(offset + len);
  const lenBytes = lengthToBytes(len);
  if (lenBytes.length > MAX_LENGTH_OF_LENGTH) throw new Error('rlp: payload too long to encode');
  return concat([Uint8Array.of(offset + 55 + lenBytes.length), lenBytes]);
}

/** Encode a byte string or nested list per the Ethereum yellow paper. */
export function rlpEncode(input: RlpInput): Uint8Array {
  if (isBytes(input)) {
    // A single byte below 0x80 is its own encoding: prefixing it would be the
    // canonical form's evil twin, and the decoder below refuses to read it.
    if (input.length === 1 && input[0] < 0x80) return Uint8Array.of(input[0]);
    return concat([encodeLength(input.length, 0x80), input]);
  }
  if (!Array.isArray(input)) throw new Error('rlp: encode expects a Uint8Array or an array');
  const payload = concat(input.map((item) => rlpEncode(item)));
  return concat([encodeLength(payload.length, 0xc0), payload]);
}

interface Decoded {
  value: RlpInput;
  /** Index one past the last byte consumed. */
  next: number;
}

/** Read a long form length, rejecting every non canonical spelling of it. */
function readLength(bytes: Uint8Array, at: number, lenOfLen: number): number {
  if (lenOfLen > MAX_LENGTH_OF_LENGTH) throw new Error('rlp: length-of-length too large');
  if (at + lenOfLen > bytes.length) throw new Error('rlp: truncated length prefix');
  if (bytes[at] === 0) throw new Error('rlp: non canonical length (leading zero byte)');
  let len = 0;
  for (let i = 0; i < lenOfLen; i++) len = len * 256 + bytes[at + i];
  if (!Number.isSafeInteger(len)) throw new Error('rlp: length too large to address');
  if (len < 56) throw new Error('rlp: non canonical length (long form used for a short payload)');
  return len;
}

function decodeItem(bytes: Uint8Array, at: number, depth: number): Decoded {
  if (depth > MAX_DEPTH) throw new Error('rlp: nesting too deep');
  if (at >= bytes.length) throw new Error('rlp: truncated input');
  const prefix = bytes[at];

  // 0x00..0x7f: the byte is itself.
  if (prefix <= 0x7f) return { value: bytes.slice(at, at + 1), next: at + 1 };

  // 0x80..0xb7: short string, length carried in the prefix.
  if (prefix <= 0xb7) {
    const len = prefix - 0x80;
    const start = at + 1;
    if (start + len > bytes.length) throw new Error('rlp: truncated string');
    if (len === 1 && bytes[start] < 0x80) {
      throw new Error('rlp: non canonical single byte (must be encoded as itself)');
    }
    return { value: bytes.slice(start, start + len), next: start + len };
  }

  // 0xb8..0xbf: long string.
  if (prefix <= 0xbf) {
    const lenOfLen = prefix - 0xb7;
    const len = readLength(bytes, at + 1, lenOfLen);
    const start = at + 1 + lenOfLen;
    if (start + len > bytes.length) throw new Error('rlp: truncated string');
    return { value: bytes.slice(start, start + len), next: start + len };
  }

  // 0xc0..0xff: list, short (0xc0..0xf7) or long (0xf8..0xff).
  const shortList = prefix <= 0xf7;
  const lenOfLen = shortList ? 0 : prefix - 0xf7;
  const payloadLen = shortList ? prefix - 0xc0 : readLength(bytes, at + 1, lenOfLen);
  const start = at + 1 + lenOfLen;
  const end = start + payloadLen;
  if (end > bytes.length) throw new Error('rlp: truncated list');

  const items: RlpInput[] = [];
  let cursor = start;
  while (cursor < end) {
    const item = decodeItem(bytes, cursor, depth + 1);
    // An item reaching past its own list means the list length lied.
    if (item.next > end) throw new Error('rlp: list item overruns its list');
    items.push(item.value);
    cursor = item.next;
  }
  return { value: items, next: end };
}

/**
 * Decode exactly one RLP item from `bytes`. Strict: trailing bytes, truncation
 * and non canonical encodings all throw rather than returning something.
 */
export function rlpDecode(bytes: Uint8Array): RlpInput {
  if (!(bytes instanceof Uint8Array)) throw new Error('rlp: decode expects a Uint8Array');
  if (bytes.length === 0) throw new Error('rlp: empty input');
  const { value, next } = decodeItem(bytes, 0, 0);
  if (next !== bytes.length) throw new Error('rlp: trailing bytes after the top level item');
  return value;
}

/**
 * Minimal big endian bytes of a non negative integer, which is how RLP carries
 * every numeric transaction field. Zero is the EMPTY string (0x80 once
 * encoded), not a 0x00 byte: that is the most common RLP mistake and it changes
 * the txid.
 */
export function bigintToRlpBytes(n: bigint): Uint8Array {
  if (typeof n !== 'bigint') throw new Error('rlp: integer must be a bigint');
  if (n < 0n) throw new Error('rlp: negative integers have no RLP encoding');
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Inverse of bigintToRlpBytes. A leading zero byte is non canonical for an
 * integer field and is refused, because accepting it would let two distinct
 * byte strings mean the same amount.
 */
export function rlpBytesToBigint(b: Uint8Array): bigint {
  if (!(b instanceof Uint8Array)) throw new Error('rlp: integer bytes must be a Uint8Array');
  if (b.length > 0 && b[0] === 0) throw new Error('rlp: non canonical integer (leading zero byte)');
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}
