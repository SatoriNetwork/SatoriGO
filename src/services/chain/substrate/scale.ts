// SCALE, by hand, for the handful of shapes the Substrate engine needs
// (design bittensor-engine.md §3, §4.1): compact integers, the mortal era,
// xxhash64 / twox128 and blake2_128Concat for storage keys, the System.Account
// key, and the AccountInfo decoder.
//
// SAFETY-CRITICAL on one point above all: Balance on subtensor is u64 (rao),
// not the u128 every Polkadot example uses. A 16-byte free/reserved/frozen
// would decode a balance that is not there and encode a transfer amount the
// runtime rejects (or, worse, reads differently). The 56-byte AccountInfo
// length check and the on-chain transfer in extrinsic.test.ts pin it.
//
// Pure TypeScript on @noble/hashes 1.8 (blake2b) with xxhash64 written here
// (40 lines of BigInt, asserted against the known System.Account prefix that
// every Substrate tool agrees on). Ported from the research reference
// proto_tao.mjs, which polkadot.js decoded field for field (xcheck.mjs).

import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';

/** Thrown for bytes that are not the SCALE shape this engine expects. */
export class ScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaleError';
  }
}

export const MAX_U32 = 0xffff_ffff;
export const MAX_U64 = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------
// Hex helpers (noble's hexToBytes refuses a 0x prefix; the RPC always sends one)
// ---------------------------------------------------------------------------

/** "0x..." or bare hex to bytes. Throws ScaleError on odd length or a non-hex character. */
export function hexToBytes0x(hex: string): Uint8Array {
  if (typeof hex !== 'string') throw new ScaleError('Expected a hex string.');
  const bare = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (bare.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(bare)) {
    throw new ScaleError('Not a hex string.');
  }
  return hexToBytes(bare);
}

/** Bytes to "0x..." lowercase hex. */
export function bytesToHex0x(bytes: Uint8Array): string {
  return `0x${bytesToHex(bytes)}`;
}

// ---------------------------------------------------------------------------
// Integers
// ---------------------------------------------------------------------------

/**
 * SCALE compact encoding of a non-negative integer, all four modes: single
 * byte (< 2^6), two bytes (< 2^14), four bytes (< 2^30) and big-integer
 * (length-prefixed little-endian) above. Refuses negatives and anything that
 * would not fit the 67-byte maximum (2^536), which nothing here ever needs.
 */
export function compact(n: bigint | number): Uint8Array {
  const v = typeof n === 'bigint' ? n : BigInt(assertSafeInt(n, 'compact'));
  if (v < 0n) throw new ScaleError('A compact integer cannot be negative.');
  if (v < 64n) return Uint8Array.of(Number(v) << 2);
  if (v < 16_384n) {
    const x = (Number(v) << 2) | 1;
    return Uint8Array.of(x & 0xff, x >> 8);
  }
  if (v < 1_073_741_824n) {
    const x = (Number(v) << 2) | 2;
    return Uint8Array.of(x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, x >>> 24);
  }
  const bytes: number[] = [];
  let x = v;
  while (x > 0n) {
    bytes.push(Number(x & 0xffn));
    x >>= 8n;
  }
  if (bytes.length > 67) throw new ScaleError('Integer too large for a compact encoding.');
  return Uint8Array.of(((bytes.length - 4) << 2) | 3, ...bytes);
}

/** Reads a compact integer at `off`; `next` is the offset after it. */
export function readCompact(buf: Uint8Array, off: number): { value: bigint; next: number } {
  if (off >= buf.length) throw new ScaleError('Unexpected end of data reading a compact integer.');
  const b0 = buf[off];
  const mode = b0 & 3;
  if (mode === 0) return { value: BigInt(b0 >> 2), next: off + 1 };
  if (mode === 1) {
    need(buf, off, 2, 'compact');
    return { value: BigInt((b0 | (buf[off + 1] << 8)) >>> 2), next: off + 2 };
  }
  if (mode === 2) {
    need(buf, off, 4, 'compact');
    const x = (b0 | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 2;
    return { value: BigInt(x), next: off + 4 };
  }
  const len = (b0 >> 2) + 4;
  need(buf, off, 1 + len, 'compact');
  return { value: readUintLE(buf, off + 1, len), next: off + 1 + len };
}

/** u32 little-endian, 4 bytes. */
export function u32le(n: number): Uint8Array {
  assertSafeInt(n, 'u32');
  if (n < 0 || n > MAX_U32) throw new ScaleError('Not a u32.');
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

export function readU32le(buf: Uint8Array, off: number): number {
  need(buf, off, 4, 'u32');
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/** `len` little-endian bytes at `off` as a bigint. */
export function readUintLE(buf: Uint8Array, off: number, len: number): bigint {
  need(buf, off, len, `u${len * 8}`);
  let v = 0n;
  for (let i = len - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(buf[off + i]);
  return v;
}

/** A bigint as `len` little-endian bytes. Refuses a value that does not fit. */
export function uintLE(v: bigint, len: number): Uint8Array {
  if (typeof v !== 'bigint' || v < 0n || v >= 1n << BigInt(len * 8)) {
    throw new ScaleError(`Not a u${len * 8}.`);
  }
  const out = new Uint8Array(len);
  let x = v;
  for (let i = 0; i < len; i += 1) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function assertSafeInt(n: number, what: string): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new ScaleError(`Not an integer (${what}).`);
  return n;
}

function need(buf: Uint8Array, off: number, len: number, what: string): void {
  if (off < 0 || off + len > buf.length) throw new ScaleError(`Unexpected end of data reading ${what}.`);
}

// ---------------------------------------------------------------------------
// Era (sp_runtime::generic::Era)
// ---------------------------------------------------------------------------

export interface MortalEra {
  /** The period actually encoded: `period` rounded to a power of two in [4, 65536]. */
  period: number;
  /** The quantized phase: checkpoint mod period, rounded down to the quantize step. */
  phase: number;
  /** The two wire bytes. */
  bytes: Uint8Array;
}

/**
 * Mortal era for `period` blocks starting at block `checkpoint`, exactly as
 * Era::mortal: the period is rounded to a power of two and clamped to
 * [4, 2^16], the phase is `checkpoint % period` quantized to `period / 4096`
 * (1 for every period the wallet uses), and the u16 LE encoding is
 * `(log2(period) - 1) | ((phase / quantize) << 4)`.
 */
export function mortalEra(period: number, checkpoint: number): MortalEra {
  assertSafeInt(period, 'era period');
  assertSafeInt(checkpoint, 'era checkpoint');
  if (period < 1 || checkpoint < 0) throw new ScaleError('Era period and checkpoint must be positive.');
  let p = 2 ** Math.round(Math.log2(period));
  p = Math.min(Math.max(p, 4), 1 << 16);
  const phase = checkpoint % p;
  const quantize = Math.max(p >> 12, 1);
  const qphase = Math.floor(phase / quantize) * quantize;
  const enc = Math.min(15, Math.max(1, Math.log2(p) - 1)) | ((qphase / quantize) << 4);
  return { period: p, phase: qphase, bytes: Uint8Array.of(enc & 0xff, enc >> 8) };
}

/** The two era bytes for `period` blocks from `checkpoint` (see mortalEra). */
export function encodeEra(period: number, checkpoint: number): Uint8Array {
  return mortalEra(period, checkpoint).bytes;
}

/**
 * Decodes an era at `off`: one 0x00 byte is immortal (period 0, phase 0),
 * otherwise two bytes of mortal era.
 */
export function decodeEra(buf: Uint8Array, off: number): { period: number; phase: number; next: number } {
  need(buf, off, 1, 'era');
  if (buf[off] === 0) return { period: 0, phase: 0, next: off + 1 };
  need(buf, off, 2, 'era');
  const enc = buf[off] | (buf[off + 1] << 8);
  const period = 2 << (enc & 15);
  const quantize = Math.max(period >> 12, 1);
  const phase = (enc >> 4) * quantize;
  if (phase >= period) throw new ScaleError('Invalid mortal era: phase is not below the period.');
  return { period, phase, next: off + 2 };
}

// ---------------------------------------------------------------------------
// xxhash64 (twox) for storage keys: pure BigInt, exact for the two constants
// ---------------------------------------------------------------------------

const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;
const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, r: number): bigint => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M64;
const round = (acc: bigint, inp: bigint): bigint => (rotl((acc + inp * P2) & M64, 31) * P1) & M64;
const merge = (acc: bigint, v: bigint): bigint => ((((acc ^ round(0n, v)) * P1) & M64) + P4) & M64;

export function xxhash64(data: Uint8Array, seed = 0n): bigint {
  const len = data.length;
  let i = 0;
  let h: bigint;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M64;
    let v2 = (seed + P2) & M64;
    let v3 = seed & M64;
    let v4 = (seed - P1) & M64;
    for (; i + 32 <= len; i += 32) {
      v1 = round(v1, readUintLE(data, i, 8));
      v2 = round(v2, readUintLE(data, i + 8, 8));
      v3 = round(v3, readUintLE(data, i + 16, 8));
      v4 = round(v4, readUintLE(data, i + 24, 8));
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M64;
    h = merge(h, v1);
    h = merge(h, v2);
    h = merge(h, v3);
    h = merge(h, v4);
  } else {
    h = (seed + P5) & M64;
  }
  h = (h + BigInt(len)) & M64;
  for (; i + 8 <= len; i += 8) {
    h ^= round(0n, readUintLE(data, i, 8));
    h = (((rotl(h, 27) * P1) & M64) + P4) & M64;
  }
  for (; i + 4 <= len; i += 4) {
    h ^= (readUintLE(data, i, 4) * P1) & M64;
    h = (((rotl(h, 23) * P2) & M64) + P3) & M64;
  }
  for (; i < len; i += 1) {
    h ^= (BigInt(data[i]) * P5) & M64;
    h = (rotl(h, 11) * P1) & M64;
  }
  h ^= h >> 33n;
  h = (h * P2) & M64;
  h ^= h >> 29n;
  h = (h * P3) & M64;
  h ^= h >> 32n;
  return h;
}

/** twox128: xxhash64 with seed 0 || xxhash64 with seed 1, each little-endian. */
export function twox128(data: Uint8Array): Uint8Array {
  return concatBytes(uintLE(xxhash64(data, 0n), 8), uintLE(xxhash64(data, 1n), 8));
}

/** blake2_128(data) || data, the hasher of System.Account. */
export function blake2_128Concat(data: Uint8Array): Uint8Array {
  return concatBytes(blake2b(data, { dkLen: 16 }), data);
}

// ---------------------------------------------------------------------------
// System.Account
// ---------------------------------------------------------------------------

/**
 * twox128("System") ++ twox128("Account"), the 32-byte prefix every Substrate
 * chain shares. Written out so a storage key needs no xxhash at runtime;
 * scale.test.ts recomputes it from twox128.
 */
export const SYSTEM_ACCOUNT_PREFIX = '0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9';

/** The storage key of System.Account for a 32-byte public key: 80 bytes as 0x hex. */
export function systemAccountKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new ScaleError('A Substrate public key is 32 bytes.');
  }
  return `${SYSTEM_ACCOUNT_PREFIX}${bytesToHex(blake2_128Concat(publicKey))}`;
}

/** Byte length of a System.Account key (16 + 16 + 16 + 32). */
export const SYSTEM_ACCOUNT_KEY_BYTES = 80;

/**
 * AccountInfo<u32, AccountData<u64>> as on Finney (spec 470): nonce,
 * consumers, providers, sufficients (u32 each), then free, reserved, frozen
 * (u64 each) and flags (u128). 56 bytes.
 */
export interface AccountInfo {
  nonce: number;
  consumers: number;
  providers: number;
  sufficients: number;
  free: bigint;
  reserved: bigint;
  frozen: bigint;
  flags: bigint;
}

export const ACCOUNT_INFO_BYTES = 56;

/**
 * Decodes a state_getStorage answer for System.Account. `null` (the key is
 * absent) means the account does not exist: 0 TAO, nonce 0, and it is
 * returned as null so the caller shows that state rather than a zero row.
 * Throws ScaleError on any length but 56: a u128 balance (72 bytes) or a
 * runtime that changed the struct must never decode as a number.
 */
export function decodeAccountInfo(hex: string | null): AccountInfo | null {
  if (hex === null || hex === undefined) return null;
  const b = hexToBytes0x(hex);
  if (b.length !== ACCOUNT_INFO_BYTES) {
    throw new ScaleError(`Unexpected AccountInfo length ${b.length} (expected ${ACCOUNT_INFO_BYTES}).`);
  }
  return {
    nonce: readU32le(b, 0),
    consumers: readU32le(b, 4),
    providers: readU32le(b, 8),
    sufficients: readU32le(b, 12),
    free: readUintLE(b, 16, 8),
    reserved: readUintLE(b, 24, 8),
    frozen: readUintLE(b, 32, 8),
    flags: readUintLE(b, 40, 16),
  };
}

/** The inverse of decodeAccountInfo, for tests and fixtures. */
export function encodeAccountInfo(info: AccountInfo): string {
  return bytesToHex0x(
    concatBytes(
      u32le(info.nonce),
      u32le(info.consumers),
      u32le(info.providers),
      u32le(info.sufficients),
      uintLE(info.free, 8),
      uintLE(info.reserved, 8),
      uintLE(info.frozen, 8),
      uintLE(info.flags, 16),
    ),
  );
}
