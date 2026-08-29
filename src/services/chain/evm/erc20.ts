// Minimal ERC-20 ABI codec: exactly the surface this wallet needs, and nothing
// else. Pure bytes in, bytes out. Nothing here fetches, nothing here signs.
//
// SAFETY-CRITICAL for a reason that is easy to miss while phase 2 only reads
// balances: the decoder half of this file is what will later turn calldata a
// WEBSITE composed into the sentence a user approves (the EVM engine design notes
// §7). A decoder that guesses is therefore a security bug, not a convenience,
// so every function here fails closed:
//
//   - a return value must be exactly the width the ABI says it is, never
//     "close enough" and never right-trimmed;
//   - a transfer/approve payload must be exactly 4 + 32 + 32 bytes, because a
//     longer one carries arguments we are not showing the user;
//   - the 12 bytes of zero padding in front of an address argument must
//     actually be zero. That padding is exactly where a malicious payload hides
//     a different recipient from a decoder that reads only the low 20 bytes.
//
// Amounts are bigint everywhere. One whole 18-decimal token is 1e18 base units,
// well past Number.MAX_SAFE_INTEGER, so a number would silently round money.
//
// Everything is synchronous and CSP-safe (no Node APIs, no Buffer, no WASM, no
// eval) so it runs inside an MV3 service worker.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { isEvmAddress, normalizeEvmAddress, toChecksumAddress } from './keys';

/** 2^256 - 1: the largest uint256, and the value every "unlimited allowance"
 *  approval carries. Named, because a wall of f's rendered as a number is the
 *  single most-read-past thing in an EVM approval screen. */
export const MAX_UINT256 = 2n ** 256n - 1n;

/** One ABI word. Every static argument and every head slot is 32 bytes. */
const WORD = 32;
/** A function selector is the first 4 bytes of the keccak-256 of its signature. */
const SELECTOR_BYTES = 4;
/** transfer(address,uint256) and approve(address,uint256) are both exactly this
 *  long: selector plus two words. Any other length is not one of these calls. */
const CALL_BYTES = SELECTOR_BYTES + 2 * WORD;
/** The low 20 bytes of an address word; the 12 in front of them must be zero. */
const ADDRESS_BYTES = 20;
const ADDRESS_PAD_BYTES = WORD - ADDRESS_BYTES;

/**
 * '0x' plus the first 4 bytes of keccak-256 over the UTF-8 signature, lowercase.
 *
 * The signature is the canonical form with no spaces and no argument names:
 * 'transfer(address,uint256)'. A space anywhere in it produces a completely
 * different selector, which is why ERC20_SELECTORS below pins the answers and a
 * test proves this function reproduces every one of them.
 */
export function selector(signature: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, SELECTOR_BYTES * 2)}`;
}

/**
 * The selectors this wallet recognises, pinned as literals rather than computed
 * at import time. Two reasons: they are constants of the ERC-20 standard and
 * belong in the source where they can be read against any block explorer, and
 * pinning them turns the keccak plumbing itself into something a test can check
 * (erc20.test.ts §1 asserts each equals selector(<signature>)).
 *
 * `approve` is here for DECODING only. Phase 5 has to recognise and explain an
 * allowance; this wallet has no reason to compose one, so no approve encoder
 * exists and none should be added without that being a deliberate decision.
 */
export const ERC20_SELECTORS = Object.freeze({
  /** balanceOf(address) */
  balanceOf: '0x70a08231',
  /** decimals() */
  decimals: '0x313ce567',
  /** symbol() */
  symbol: '0x95d89b41',
  /** name() */
  name: '0x06fdde03',
  /** totalSupply() */
  totalSupply: '0x18160ddd',
  /** transfer(address,uint256) */
  transfer: '0xa9059cbb',
  /** approve(address,uint256), decode only */
  approve: '0x095ea7b3',
} as const);

// ---------------------------------------------------------------------------
// hex and word helpers, all strict
// ---------------------------------------------------------------------------

const HEX_RE = /^0x[0-9a-fA-F]*$/;

/**
 * Parse a 0x-prefixed hex string. Case is accepted on both sides because hex
 * case carries no meaning here (unlike an address, where it is the EIP-55
 * checksum), but the 0x prefix is REQUIRED and an odd digit count is refused:
 * a caller passing something that is not hex return data should hear about it
 * rather than get a truncated number back.
 */
function parseHex(hex: string, label: string): Uint8Array {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) {
    throw new Error(`erc20: ${label} must be a 0x-prefixed hex string, got: ${String(hex)}`);
  }
  const body = hex.slice(2);
  if (body.length % 2 !== 0) {
    throw new Error(`erc20: ${label} has an odd number of hex digits (${body.length})`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Big-endian bytes to bigint. Used for every uint the ABI defines. */
function bytesToBigint(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Return data that must be exactly one word wide, or throw. */
function oneWord(returnData: string, label: string): Uint8Array {
  const bytes = parseHex(returnData, label);
  if (bytes.length !== WORD) {
    throw new Error(`erc20: ${label} must be exactly ${WORD} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * A validated address as a 32-byte left-padded ABI word.
 *
 * Validation is delegated to isEvmAddress() so this file cannot drift from the
 * rest of the engine: it accepts all-lowercase and all-uppercase (neither
 * carries a checksum) and a mixed-case string only when its EIP-55 checksum is
 * correct. Refusing a wrong checksum is the point, not a side effect: on a
 * chain where any 20 bytes are a valid destination it is the only typo
 * detection that exists.
 */
function addressWord(value: string, label: string): Uint8Array {
  if (typeof value !== 'string' || !isEvmAddress(value)) {
    throw new Error(
      `erc20: ${label} is not a valid EVM address: ${String(value)} ` +
        '(expected 0x followed by 40 hex characters, with a valid EIP-55 checksum when mixed case)',
    );
  }
  const body = normalizeEvmAddress(value).slice(2).toLowerCase();
  const word = new Uint8Array(WORD);
  for (let i = 0; i < ADDRESS_BYTES; i++) {
    word[ADDRESS_PAD_BYTES + i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return word;
}

/** A uint256 as a 32-byte big-endian ABI word, or throw if it does not fit. */
function uint256Word(value: bigint, label: string): Uint8Array {
  if (typeof value !== 'bigint') {
    throw new Error(`erc20: ${label} must be a bigint, got ${typeof value}`);
  }
  if (value < 0n) {
    throw new Error(`erc20: ${label} must not be negative, got ${value.toString()}`);
  }
  if (value > MAX_UINT256) {
    throw new Error(`erc20: ${label} exceeds uint256, got ${value.toString()}`);
  }
  const word = new Uint8Array(WORD);
  let rest = value;
  for (let i = WORD - 1; i >= 0; i--) {
    word[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return word;
}

// ---------------------------------------------------------------------------
// encoders
// ---------------------------------------------------------------------------

/** Calldata for `balanceOf(holder)`, as a 0x hex string ready for eth_call. */
export function encodeBalanceOf(holder: string): string {
  return ERC20_SELECTORS.balanceOf + bytesToHex(addressWord(holder, 'holder'));
}

/** Calldata for `decimals()`. No arguments, so the selector is the whole call. */
export function encodeDecimals(): string {
  return ERC20_SELECTORS.decimals;
}

/** Calldata for `symbol()`. */
export function encodeSymbol(): string {
  return ERC20_SELECTORS.symbol;
}

/** Calldata for `name()`. */
export function encodeName(): string {
  return ERC20_SELECTORS.name;
}

/** Calldata for `totalSupply()`. */
export function encodeTotalSupply(): string {
  return ERC20_SELECTORS.totalSupply;
}

/**
 * Calldata for `transfer(to, amount)` as BYTES, because this is the one call
 * here that goes into a transaction: it becomes `EvmTxRequest.data`, and an
 * ERC-20 transfer is just a native transaction with data (evm-engine.md §10,
 * point 2). Returning hex would mean the send path converts it back.
 *
 * Throws on an invalid address, a negative amount, or an amount past uint256.
 * 68 bytes: 4 selector, 32 address, 32 amount.
 */
export function encodeTransfer(to: string, amount: bigint): Uint8Array {
  const out = new Uint8Array(CALL_BYTES);
  out.set(parseHex(ERC20_SELECTORS.transfer, 'transfer selector'), 0);
  out.set(addressWord(to, 'to'), SELECTOR_BYTES);
  out.set(uint256Word(amount, 'amount'), SELECTOR_BYTES + WORD);
  return out;
}

// ---------------------------------------------------------------------------
// decoders
// ---------------------------------------------------------------------------

/** Exactly 32 bytes of return data as a uint256. Any other width throws. */
export function decodeUint256(returnData: string): bigint {
  return bytesToBigint(oneWord(returnData, 'uint256 return data'));
}

/**
 * A uint8 (`decimals()`). Still 32 bytes on the wire, since the ABI pads every
 * static value to a word, but a value above 255 is not a uint8 and is refused
 * rather than truncated: decimals is a divisor, and a wrong one misplaces the
 * decimal point on every balance the wallet shows.
 */
export function decodeUint8(returnData: string): number {
  const value = bytesToBigint(oneWord(returnData, 'uint8 return data'));
  if (value > 255n) {
    throw new Error(`erc20: uint8 return data is out of range: ${value.toString()}`);
  }
  return Number(value);
}

/** A bool. Only the canonical 0 and 1 are accepted; anything else throws. */
export function decodeBool(returnData: string): boolean {
  const value = bytesToBigint(oneWord(returnData, 'bool return data'));
  if (value === 0n) return false;
  if (value === 1n) return true;
  throw new Error(`erc20: bool return data is neither 0 nor 1: ${value.toString()}`);
}

// TextDecoder with fatal:true, so invalid UTF-8 throws instead of quietly
// becoming U+FFFD. A token whose name does not decode is a token we cannot
// name, and saying so beats displaying replacement characters.
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/**
 * The bytes32 form: a right-padded ASCII string in a single word. MakerDAO era
 * tokens (MKR is the canonical example) declared `symbol()` as bytes32 rather
 * than string, so this is not a legacy nicety, it is the only way to read them.
 *
 * Only TRAILING zero bytes are stripped. What is left must be printable ASCII:
 * an interior NUL or a control byte means the guess about where the string ends
 * was wrong, and a wrong guess about a token's name is exactly what a spoofed
 * token wants.
 */
function decodeBytes32String(word: Uint8Array): string {
  let end = word.length;
  while (end > 0 && word[end - 1] === 0) end--;
  let out = '';
  for (let i = 0; i < end; i++) {
    const byte = word[i];
    if (byte < 0x20 || byte > 0x7e) {
      throw new Error(
        `erc20: bytes32 string has a non-printable byte 0x${byte.toString(16).padStart(2, '0')} at index ${i}`,
      );
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * `symbol()` / `name()` return data, in either shape a real token uses:
 *
 *   - the ABI dynamic string: offset word (which must be 0x20, the only value a
 *     single dynamic return value can have), length word, then the UTF-8 bytes
 *     padded to a whole number of words;
 *   - exactly 32 bytes: the bytes32 form above. There is no ambiguity, since a
 *     dynamic string is never shorter than two words.
 *
 * The dynamic form is checked for CANONICAL encoding, not merely a survivable
 * one: the total length must be exactly two words plus the padded payload, and
 * the padding must be zero. A length that overruns the data therefore throws,
 * and so does a payload with bytes hidden past the end of the string.
 */
export function decodeString(returnData: string): string {
  const bytes = parseHex(returnData, 'string return data');

  if (bytes.length === WORD) return decodeBytes32String(bytes);

  if (bytes.length < 2 * WORD || bytes.length % WORD !== 0) {
    throw new Error(
      `erc20: string return data must be ${WORD} bytes (bytes32) or a whole number of ` +
        `words of at least ${2 * WORD} (dynamic), got ${bytes.length}`,
    );
  }

  const offset = bytesToBigint(bytes.subarray(0, WORD));
  if (offset !== BigInt(WORD)) {
    throw new Error(`erc20: dynamic string offset must be 0x20, got ${offset.toString()}`);
  }

  const length = bytesToBigint(bytes.subarray(WORD, 2 * WORD));
  // Padded in bigint on purpose: a hostile length near 2^256 must not be
  // narrowed to a Number before it is compared with what we actually hold.
  const padded = ((length + BigInt(WORD) - 1n) / BigInt(WORD)) * BigInt(WORD);
  if (BigInt(2 * WORD) + padded !== BigInt(bytes.length)) {
    // Both directions are refused: a length that overruns the data, and a
    // length short of it. Extra words past the string are data the caller was
    // never shown, and a codec that ignores them is a codec that can be fed
    // something other than what it reported.
    throw new Error(
      `erc20: dynamic string declares ${length.toString()} bytes, which does not match the ` +
        `${bytes.length - 2 * WORD} bytes of payload present`,
    );
  }

  const size = Number(length);
  for (let i = 2 * WORD + size; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      throw new Error(`erc20: dynamic string has a non-zero padding byte at index ${i}`);
    }
  }

  try {
    return UTF8_STRICT.decode(bytes.subarray(2 * WORD, 2 * WORD + size));
  } catch {
    throw new Error('erc20: dynamic string is not valid UTF-8');
  }
}

/** What decodeErc20Calldata() recognises. Addresses are EIP-55 checksummed. */
export type DecodedErc20Call =
  | { kind: 'transfer'; to: string; amount: bigint }
  | { kind: 'approve'; spender: string; amount: bigint; unlimited: boolean };

/**
 * Recognise the two calls this wallet has to be able to explain.
 *
 * Returns null when the calldata is not one of them (empty calldata, a native
 * send, or any other selector): "we do not know what this is" is a legitimate
 * answer and the caller decides how to present it.
 *
 * THROWS when the selector matches but the payload does not: a wrong length, or
 * a non-zero byte in the 12-byte padding in front of the address. Both mean the
 * bytes are NOT the call they claim to be, and returning a plausible-looking
 * `{to, amount}` for them would put a recipient on screen that the transaction
 * does not contain. Null would be just as wrong, since the caller would then
 * fall back to "unknown call" for something whose selector says otherwise.
 *
 * `unlimited` is true exactly when the allowance is 2^256-1, the value that
 * lets a spender move the user's entire balance forever.
 */
export function decodeErc20Calldata(data: Uint8Array): DecodedErc20Call | null {
  if (!(data instanceof Uint8Array)) {
    throw new Error('erc20: calldata must be a Uint8Array');
  }
  if (data.length < SELECTOR_BYTES) return null;

  const sel = `0x${bytesToHex(data.subarray(0, SELECTOR_BYTES))}`;
  const isTransfer = sel === ERC20_SELECTORS.transfer;
  const isApprove = sel === ERC20_SELECTORS.approve;
  if (!isTransfer && !isApprove) return null;

  const name = isTransfer ? 'transfer' : 'approve';
  if (data.length !== CALL_BYTES) {
    throw new Error(
      `erc20: ${name} calldata must be ${CALL_BYTES} bytes (selector plus two words), got ${data.length}`,
    );
  }

  for (let i = SELECTOR_BYTES; i < SELECTOR_BYTES + ADDRESS_PAD_BYTES; i++) {
    if (data[i] !== 0) {
      throw new Error(
        `erc20: ${name} address argument has a non-zero byte 0x${data[i].toString(16).padStart(2, '0')} ` +
          `in its ${ADDRESS_PAD_BYTES}-byte padding, so it is not a plain address`,
      );
    }
  }

  const address = toChecksumAddress(
    bytesToHex(data.subarray(SELECTOR_BYTES + ADDRESS_PAD_BYTES, SELECTOR_BYTES + WORD)),
  );
  const amount = bytesToBigint(data.subarray(SELECTOR_BYTES + WORD, CALL_BYTES));

  if (isTransfer) return { kind: 'transfer', to: address, amount };
  return { kind: 'approve', spender: address, amount, unlimited: amount === MAX_UINT256 };
}
