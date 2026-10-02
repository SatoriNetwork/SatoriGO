// SS58 addresses (design bittensor-engine.md §2.1 step 5, §9).
//
// address = base58(prefix || publicKey(32) || blake2b-512("SS58PRE" || prefix || publicKey)[0..2])
//
// Bittensor uses the generic Substrate prefix 42 (one byte, 0x2a), so every
// address starts with "5". The decoder refuses any other prefix when asked
// for one: a Polkadot "1..." or Kusama address decodes cleanly but is not a
// Bittensor account, and sending to it would put TAO on a key nobody can use
// there. The two-byte prefix form (64..16383) is handled for completeness of
// decoding; the wallet never encodes one.
//
// Pure TypeScript on @noble/hashes 1.8 (blake2b) and @scure/base 1.2 (base58).

import { blake2b } from '@noble/hashes/blake2b';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { base58 } from '@scure/base';

/** Bittensor (and generic Substrate): prefix 42, addresses start with "5". */
export const TAO_SS58_PREFIX = 42;

export type Ss58ErrorCode = 'checksum' | 'prefix' | 'length' | 'format';

export class Ss58Error extends Error {
  readonly code: Ss58ErrorCode;
  constructor(code: Ss58ErrorCode, message: string) {
    super(message);
    this.name = 'Ss58Error';
    this.code = code;
  }
}

const SS58_PREFIX_BYTES = utf8ToBytes('SS58PRE');

function prefixBytes(prefix: number): Uint8Array {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 16383) {
    throw new Ss58Error('prefix', 'SS58 prefix must be an integer in 0..16383.');
  }
  if (prefix < 64) return Uint8Array.of(prefix);
  return Uint8Array.of(((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 0x03) << 6));
}

function checksum(body: Uint8Array): Uint8Array {
  return blake2b(concatBytes(SS58_PREFIX_BYTES, body), { dkLen: 64 }).slice(0, 2);
}

/** A 32-byte public key to its SS58 address under `prefix` (42 by default). */
export function ss58Encode(publicKey: Uint8Array, prefix: number = TAO_SS58_PREFIX): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new Ss58Error('length', 'An SS58 address encodes a 32-byte public key.');
  }
  const body = concatBytes(prefixBytes(prefix), publicKey);
  return base58.encode(concatBytes(body, checksum(body)));
}

/**
 * Decodes an SS58 address to its prefix and 32-byte public key. Throws
 * Ss58Error: 'format' for text that is not base58, 'length' when the key is
 * not 32 bytes, 'checksum' when the two trailing bytes do not match, and
 * 'prefix' when `expectedPrefix` is given and differs (checked AFTER the
 * checksum, so a mistyped address reads as mistyped, not as foreign).
 */
export function ss58Decode(address: string, expectedPrefix?: number): { prefix: number; publicKey: Uint8Array } {
  if (typeof address !== 'string' || address.length === 0) {
    throw new Ss58Error('format', 'Not an SS58 address.');
  }
  let raw: Uint8Array;
  try {
    raw = base58.decode(address);
  } catch {
    throw new Ss58Error('format', 'Not an SS58 address.');
  }
  if (raw.length < 35) throw new Ss58Error('length', 'Not an SS58 address.');
  let prefix: number;
  let off: number;
  if (raw[0] < 64) {
    prefix = raw[0];
    off = 1;
  } else if (raw[0] < 128) {
    prefix = ((raw[0] & 0x3f) << 2) | (raw[1] >> 6) | ((raw[1] & 0x3f) << 8);
    off = 2;
  } else {
    throw new Ss58Error('prefix', 'Reserved SS58 prefix.');
  }
  const body = raw.slice(0, raw.length - 2);
  const publicKey = raw.slice(off, raw.length - 2);
  if (publicKey.length !== 32) throw new Ss58Error('length', 'Not a 32-byte SS58 address.');
  const sum = checksum(body);
  if (sum[0] !== raw[raw.length - 2] || sum[1] !== raw[raw.length - 1]) {
    throw new Ss58Error('checksum', 'This address has a typo: the checksum does not match.');
  }
  if (expectedPrefix !== undefined && prefix !== expectedPrefix) {
    throw new Ss58Error('prefix', 'This is not a Bittensor address.');
  }
  return { prefix, publicKey };
}

/** True for a well-formed SS58 address with prefix 42 (a "5..." Bittensor account). */
export function isValidTaoAddress(address: string): boolean {
  try {
    ss58Decode(address, TAO_SS58_PREFIX);
    return true;
  } catch {
    return false;
  }
}
