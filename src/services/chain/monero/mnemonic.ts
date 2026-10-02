// The 25-word Monero ("Electrum-style") mnemonic: the spend key in words.
//
// SAFETY-CRITICAL. These 25 words are what the user writes down to recover the
// Monero wallet in Feather, Cake, monero-wallet-cli or GUI, and what an
// imported Monero wallet is stored as. A bug here either shows the user words
// that restore a DIFFERENT wallet elsewhere, or imports someone's words into
// the wrong keys. Pinned by the Cake, monero-python and monero-project vectors
// in mnemonic.test.ts and keys.test.ts.
//
// Source of truth: monero-project src/mnemonics/electrum-words.cpp
// (bytes_to_words, words_to_bytes, create_checksum_index, checksum_test),
// ported from the research reference xmr_noble.mjs. Design: monero-engine.md §3.
//
// It is NOT BIP39. There is no PBKDF2 and no passphrase: the words are a direct
// base-1626 spelling of the 32-byte spend key, three words per four bytes, plus
// one checksum word that repeats one of the 24.
//
// Decisions that differ from what electrum-words.cpp would accept, on purpose:
//   - Exactly 25 words. Monero also accepts 24 (no checksum word) and 13 (the
//     old half seeds); both are refused here. The 25th word is the only thing
//     that catches a mistyped word, and a typo on the import path is a
//     different, empty wallet the user would then trust.
//   - English only. Monero has other word lists; a seed in another language
//     fails with code 'word', which the import screen explains.
//
// Nothing in this module logs or echoes a word: error messages name the
// position ("word 7"), never the word, because the words ARE the spend key.

import { MONERO_ENGLISH_PREFIX_LENGTH, MONERO_ENGLISH_WORDLIST } from './wordlist';

/** The Monero English word list, 1626 words, in english.h order. */
export const MONERO_ENGLISH_WORDS: readonly string[] = MONERO_ENGLISH_WORDLIST;

const N = 1626;
const WORD_COUNT = 25;
const KEY_BYTES = 32;

/**
 * ed25519 group order l. Duplicated from keys.ts on purpose: keys.ts imports
 * this module (moneroKeysFromLegacyWords), so importing it back would make a
 * cycle. keys.test.ts pins the two values equal.
 */
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

export type MoneroMnemonicErrorCode = 'length' | 'word' | 'checksum' | 'range';

/**
 * Thrown for every way a 25-word input can be wrong. `code` is for the UI to
 * pick its copy; the message is user-facing already and never contains a word.
 */
export class MoneroMnemonicError extends Error {
  readonly code: MoneroMnemonicErrorCode;
  constructor(code: MoneroMnemonicErrorCode, message: string) {
    super(message);
    this.name = 'MoneroMnemonicError';
    this.code = code;
  }
}

/** First 3 characters, by code point (electrum-words.cpp utf8prefix). */
function prefixOf(word: string): string {
  return Array.from(word).slice(0, MONERO_ENGLISH_PREFIX_LENGTH).join('');
}

const PREFIX_INDEX: ReadonlyMap<string, number> = new Map(
  MONERO_ENGLISH_WORDS.map((w, i) => [prefixOf(w), i] as const),
);

// CRC-32 (IEEE 802.3, the zlib one: reflected poly 0xEDB88320, init and
// xorout 0xFFFFFFFF), exactly boost::crc_32_type as create_checksum_index uses.
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Index (0..23) of the word the checksum word repeats: CRC-32 of the first 3
 * characters of each of the 24 words, concatenated, mod 24.
 */
function checksumIndex(words24: readonly string[]): number {
  const trimmed = words24.map(prefixOf).join('');
  return crc32(new TextEncoder().encode(trimmed)) % words24.length;
}

function isCanonicalScalar(bytes: Uint8Array): boolean {
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]);
  return x < ED25519_L;
}

/**
 * Spend key (32 bytes, already reduced mod l) to the 25 words other Monero
 * wallets show for it.
 *
 * Refuses a non-canonical key (>= l, code 'range') instead of spelling it:
 * those words would restore elsewhere, but to a wallet whose spend key differs
 * from the bytes given here, which is exactly the kind of quiet mismatch this
 * module exists to prevent. Every key keys.ts produces is canonical.
 */
export function spendKeyToLegacyWords(spendSec: Uint8Array): string[] {
  if (!(spendSec instanceof Uint8Array) || spendSec.length !== KEY_BYTES) {
    throw new MoneroMnemonicError('range', 'A Monero spend key is 32 bytes.');
  }
  if (!isCanonicalScalar(spendSec)) {
    throw new MoneroMnemonicError('range', 'This is not a valid Monero spend key.');
  }
  const words: string[] = [];
  for (let i = 0; i < KEY_BYTES; i += 4) {
    const x =
      (spendSec[i] | (spendSec[i + 1] << 8) | (spendSec[i + 2] << 16) | (spendSec[i + 3] << 24)) >>> 0;
    const w1 = x % N;
    const w2 = (Math.floor(x / N) + w1) % N;
    const w3 = (Math.floor(Math.floor(x / N) / N) + w2) % N;
    words.push(MONERO_ENGLISH_WORDS[w1], MONERO_ENGLISH_WORDS[w2], MONERO_ENGLISH_WORDS[w3]);
  }
  words.push(words[checksumIndex(words)]);
  return words;
}

/**
 * Free text to the canonical words: split on any whitespace, lowercase, and
 * resolve each word by its 3-character prefix to the full list word (so
 * "subt" and "SUBTLY" both come back as "subtly", as monero-wallet-cli would
 * read them). Throws MoneroMnemonicError code 'word' on a word no prefix
 * matches. Does NOT check the count or the checksum; legacyWordsToSpendKey
 * does.
 */
export function normalizeLegacyWords(input: string): string[] {
  const raw = input.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return raw.map((w, i) => {
    const idx = PREFIX_INDEX.get(prefixOf(w));
    // Every key in PREFIX_INDEX is exactly 3 characters, so a 1 or 2
    // character fragment ("ab") is unknown rather than a guess at "abbey".
    if (idx === undefined) {
      throw new MoneroMnemonicError('word', `Word ${i + 1} is not in the Monero English word list.`);
    }
    return MONERO_ENGLISH_WORDS[idx];
  });
}

/**
 * 25 words to the raw 32 bytes they spell (the spend key before sc_reduce32,
 * which is the identity for any seed a wallet generated; keys.ts applies it).
 *
 * Accepts free text or an array. Throws MoneroMnemonicError:
 *   'length'   not exactly 25 words;
 *   'word'     a word not in the list;
 *   'checksum' the 25th word is not the one the first 24 call for;
 *   'range'    a word triple that no 32-bit value encodes (words_to_bytes'
 *              `w0 % n != w1` check).
 * The caller owns the returned bytes and should zero them after use.
 */
export function legacyWordsToSpendKey(words: string | readonly string[]): Uint8Array {
  const list = normalizeLegacyWords(typeof words === 'string' ? words : words.join(' '));
  if (list.length !== WORD_COUNT) {
    throw new MoneroMnemonicError(
      'length',
      `A Monero recovery phrase has 25 words; this one has ${list.length}.`,
    );
  }
  const body = list.slice(0, WORD_COUNT - 1);
  if (prefixOf(body[checksumIndex(body)]) !== prefixOf(list[WORD_COUNT - 1])) {
    throw new MoneroMnemonicError(
      'checksum',
      'The last word does not match the others. Check each word for a typo.',
    );
  }
  const idx = body.map((w) => PREFIX_INDEX.get(prefixOf(w)) as number);
  const out = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < 8; i++) {
    const w1 = idx[i * 3];
    const w2 = idx[i * 3 + 1];
    const w3 = idx[i * 3 + 2];
    // electrum-words.cpp computes this in uint32, so a triple whose value
    // passes 2^32 - 1 wraps and then fails its `val % n == w1` check. Here
    // the arithmetic is exact (1626^3 fits a double), so the residue check
    // alone never fires and the explicit bound refuses the same triples.
    const w0 = w1 + N * ((N - w1 + w2) % N) + N * N * ((N - w2 + w3) % N);
    if (w0 % N !== w1 || w0 > 0xffffffff) {
      out.fill(0);
      throw new MoneroMnemonicError(
        'range',
        `Words ${i * 3 + 1} to ${i * 3 + 3} do not form a valid group. Check each word for a typo.`,
      );
    }
    out[i * 4] = w0 & 0xff;
    out[i * 4 + 1] = (w0 >>> 8) & 0xff;
    out[i * 4 + 2] = (w0 >>> 16) & 0xff;
    out[i * 4 + 3] = (w0 >>> 24) & 0xff;
  }
  return out;
}

/** True when `input` is 25 known words with a matching checksum word. */
export function isValidLegacyMnemonic(input: string): boolean {
  try {
    legacyWordsToSpendKey(input).fill(0);
    return true;
  } catch {
    return false;
  }
}
