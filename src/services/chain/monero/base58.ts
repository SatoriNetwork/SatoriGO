// Monero base58: NOT Bitcoin base58, and not interchangeable with it.
//
// Bitcoin base58 treats the whole payload as one big number, so a single
// changed byte can change every character. Monero (src/common/base58.cpp)
// cuts the payload into 8-byte blocks and encodes each block on its own into
// exactly 11 characters, left-padded with '1'; the last, shorter block uses the
// fixed width from ENCODED_BLOCK_SIZES. That is why every standard address is
// exactly 95 characters and every integrated one 106. Same alphabet as Bitcoin,
// no checksum here (the address layer adds keccak's 4 bytes itself).
//
// @scure/base's base58 is the Bitcoin kind, so this is its own ~50 lines,
// ported from the research reference (xmr_noble.mjs) and pinned by every
// address vector in address.test.ts plus base58.test.ts.
//
// Decoding is strict in the same three places base58.cpp is strict, because
// this is what the send form's address check stands on:
//   - a character outside the alphabet is refused;
//   - a trailing block whose length is not a valid encoded width (1, 4 or 8
//     characters) is refused, since no byte count encodes to it;
//   - a block whose value does not fit in its byte count ("zzzzzzzzzzz" is
//     larger than 2^64) is refused, rather than silently truncated.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encoded width in characters of a block of 0..8 bytes (base58.cpp encoded_block_sizes). */
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11] as const;
const FULL_BLOCK_SIZE = 8;
const FULL_ENCODED_BLOCK_SIZE = 11;

const ALPHABET_INDEX: ReadonlyMap<string, number> = new Map(
  Array.from(ALPHABET, (ch, i) => [ch, i] as const),
);

export class MoneroBase58Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneroBase58Error';
  }
}

function encodeBlock(block: Uint8Array): string {
  let num = 0n;
  for (const b of block) num = (num << 8n) | BigInt(b);
  const width = ENCODED_BLOCK_SIZES[block.length];
  let out = '';
  for (let i = 0; i < width; i++) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  return out;
}

function decodeBlock(chunk: string): Uint8Array {
  const size = (ENCODED_BLOCK_SIZES as readonly number[]).indexOf(chunk.length);
  if (size <= 0) throw new MoneroBase58Error('Invalid base58 block length.');
  let num = 0n;
  for (const ch of chunk) {
    const v = ALPHABET_INDEX.get(ch);
    if (v === undefined) throw new MoneroBase58Error('Invalid base58 character.');
    num = num * 58n + BigInt(v);
  }
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  if (num !== 0n) throw new MoneroBase58Error('Base58 block overflows its size.');
  return out;
}

/** Bytes to Monero base58 (8-byte blocks, 11 characters each). */
export function moneroBase58Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += FULL_BLOCK_SIZE) {
    out += encodeBlock(bytes.subarray(i, Math.min(i + FULL_BLOCK_SIZE, bytes.length)));
  }
  return out;
}

/** Monero base58 to bytes. Throws MoneroBase58Error on anything base58.cpp would refuse. */
export function moneroBase58Decode(text: string): Uint8Array {
  const fullBlocks = Math.floor(text.length / FULL_ENCODED_BLOCK_SIZE);
  const tailChars = text.length % FULL_ENCODED_BLOCK_SIZE;
  const tailBytes = tailChars === 0 ? 0 : (ENCODED_BLOCK_SIZES as readonly number[]).indexOf(tailChars);
  if (tailBytes < 0) throw new MoneroBase58Error('Invalid base58 length.');
  const out = new Uint8Array(fullBlocks * FULL_BLOCK_SIZE + tailBytes);
  let offset = 0;
  for (let i = 0; i < text.length; i += FULL_ENCODED_BLOCK_SIZE) {
    const block = decodeBlock(text.slice(i, i + FULL_ENCODED_BLOCK_SIZE));
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}
