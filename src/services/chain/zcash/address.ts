// Zcash transparent addresses: t1 (P2PKH), t3 (P2SH) and ZIP-320 TEX (tex1),
// encode and decode, plus the refusals Send shows for everything else
// (design docs/design/zcash-engine.md §2.1, §3).
//
// Why this is not a chainParams.ts row: a Zcash transparent address has a
// TWO-byte version prefix (1C B8 for t1), so the payload before the 4-byte
// SHA256d checksum is 22 bytes. The UTXO engine's pubkeyToP2pkhAddress takes a
// single version byte and cannot produce it.
//
// TEX (ZIP-320) is bech32m with HRP "tex" directly over the 20-byte P2PKH
// hash (no witness version). Paying one is exactly a P2PKH output; ZIP-320's
// rule that the paying transaction spends only transparent inputs holds by
// construction, since this wallet has no other kind.
//
// Unified (u1), Sapling (zs1) and Sprout (zc) addresses are refused with a
// message that says what to ask for: extracting a transparent receiver from a
// unified address needs ZIP-316 F4Jumble, and most carry none anyway.
//
// Pure TS on @scure/base and @noble/hashes; no Buffer, no Node APIs.

import { base58check, bech32m } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '@noble/hashes/utils';

export type ZcashNetwork = 'main' | 'test';
export type ZcashAddressKind = 'p2pkh' | 'p2sh' | 'tex';

export interface ZcashNetworkParams {
  coinType: number;
  p2pkh: readonly [number, number];
  p2sh: readonly [number, number];
  texHrp: string;
}

/** Address and derivation constants, from zcash_protocol's constants.rs. */
export const ZCASH_NETWORKS: Readonly<Record<ZcashNetwork, ZcashNetworkParams>> = Object.freeze({
  main: Object.freeze({ coinType: 133, p2pkh: [0x1c, 0xb8] as const, p2sh: [0x1c, 0xbd] as const, texHrp: 'tex' }),
  test: Object.freeze({ coinType: 1, p2pkh: [0x1d, 0x25] as const, p2sh: [0x1c, 0xba] as const, texHrp: 'textest' }),
});

export interface DecodedZcashAddress {
  net: ZcashNetwork;
  kind: ZcashAddressKind;
  /** The 20-byte key hash (P2PKH, TEX) or script hash (P2SH). */
  hash: Uint8Array;
  /** The output script paying this address. */
  script: Uint8Array;
}

export type ZcashAddressErrorCode = 'shielded' | 'unified' | 'testnet' | 'checksum' | 'format';

const SHIELDED_MESSAGE =
  'This is a shielded Zcash address. Satori GO sends to transparent addresses only (t1, t3 or tex1). Ask the recipient for a transparent address.';

const MESSAGES: Readonly<Record<ZcashAddressErrorCode, string>> = Object.freeze({
  shielded: SHIELDED_MESSAGE,
  unified: SHIELDED_MESSAGE,
  testnet: 'This is a Zcash testnet address. Satori GO sends on the Zcash main network only.',
  checksum: 'This Zcash address has a typo: its checksum does not match. Check it and paste it again.',
  format: 'This is not a valid Zcash address.',
});

/** Every refusal carries a user-facing message the form can show as is. */
export class ZcashAddressError extends Error {
  readonly code: ZcashAddressErrorCode;
  constructor(code: ZcashAddressErrorCode, message: string = MESSAGES[code]) {
    super(message);
    this.name = 'ZcashAddressError';
    this.code = code;
  }
}

const b58c = base58check(sha256);
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
/** bech32 strings are at most 90 characters (BIP173); a TEX address is 44 or 48. */
const BECH32_LIMIT = 90;

export function p2pkhScript(hash160: Uint8Array): Uint8Array {
  assertHash20(hash160);
  return concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash160, Uint8Array.of(0x88, 0xac));
}

export function p2shScript(hash160: Uint8Array): Uint8Array {
  assertHash20(hash160);
  return concatBytes(Uint8Array.of(0xa9, 0x14), hash160, Uint8Array.of(0x87));
}

function assertHash20(hash: Uint8Array): void {
  if (!(hash instanceof Uint8Array) || hash.length !== 20) throw new Error('zcash: a key or script hash is 20 bytes');
}

function encodeBase58(prefix: readonly [number, number], hash: Uint8Array): string {
  assertHash20(hash);
  return b58c.encode(concatBytes(Uint8Array.from(prefix), hash));
}

/** t1... (mainnet) or tm... (testnet) from a HASH160 of a compressed public key. */
export function encodeP2pkh(hash160: Uint8Array, net: ZcashNetwork = 'main'): string {
  return encodeBase58(ZCASH_NETWORKS[net].p2pkh, hash160);
}

/** t3... (mainnet) or t2... (testnet) from a HASH160 of a redeem script. */
export function encodeP2sh(hash160: Uint8Array, net: ZcashNetwork = 'main'): string {
  return encodeBase58(ZCASH_NETWORKS[net].p2sh, hash160);
}

/** ZIP-320 TEX address (tex1... / textest1...) over a P2PKH hash. */
export function encodeTex(hash160: Uint8Array, net: ZcashNetwork = 'main'): string {
  assertHash20(hash160);
  return bech32m.encode(ZCASH_NETWORKS[net].texHrp, bech32m.toWords(hash160), BECH32_LIMIT);
}

const samePrefix = (a: Uint8Array, p: readonly [number, number]) => a[0] === p[0] && a[1] === p[1];

function decodeTex(address: string, hrp: string, net: ZcashNetwork): DecodedZcashAddress {
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(address as `${string}1${string}`, BECH32_LIMIT);
  } catch {
    throw new ZcashAddressError('checksum');
  }
  if (decoded.prefix !== hrp) throw new ZcashAddressError('format');
  let hash: Uint8Array;
  try {
    hash = bech32m.fromWords(decoded.words);
  } catch {
    throw new ZcashAddressError('format');
  }
  if (hash.length !== 20) throw new ZcashAddressError('format');
  return { net, kind: 'tex', hash, script: p2pkhScript(hash) };
}

/**
 * Decodes a recipient for `net` (mainnet by default). Throws ZcashAddressError
 * with a user-facing message for a shielded, unified, other-network, mistyped
 * or malformed address. Surrounding whitespace is ignored; nothing else is
 * corrected.
 */
export function decodeZcashAddress(address: string, net: ZcashNetwork = 'main'): DecodedZcashAddress {
  if (typeof address !== 'string') throw new ZcashAddressError('format');
  const text = address.trim();
  if (text === '') throw new ZcashAddressError('format');
  const lower = text.toLowerCase();
  const params = ZCASH_NETWORKS[net];
  const other = ZCASH_NETWORKS[net === 'main' ? 'test' : 'main'];
  const wrongNet = () =>
    net === 'main'
      ? new ZcashAddressError('testnet')
      : new ZcashAddressError('format', 'This is a Zcash mainnet address, not a testnet one.');

  // Unified addresses (ZIP-316): u1 on mainnet, utest1 on testnet.
  if (lower.startsWith('u1') || lower.startsWith('utest1')) throw new ZcashAddressError('unified');
  // Sapling (zs1, ztestsapling1) and Sprout (base58 zc / zt).
  if (lower.startsWith('zs1') || lower.startsWith('ztestsapling1') || text.startsWith('zc') || text.startsWith('zt')) {
    throw new ZcashAddressError('shielded');
  }
  // TEX (ZIP-320). Check the longer HRP first: "textest1" also starts with "tex".
  if (lower.startsWith(`${params.texHrp}1`)) return decodeTex(text, params.texHrp, net);
  if (lower.startsWith(`${other.texHrp}1`)) throw wrongNet();

  if (!BASE58_RE.test(text)) throw new ZcashAddressError('format');
  let raw: Uint8Array;
  try {
    raw = b58c.decode(text);
  } catch {
    throw new ZcashAddressError('checksum');
  }
  if (raw.length !== 22) throw new ZcashAddressError('format');
  const hash = raw.slice(2);
  if (samePrefix(raw, params.p2pkh)) return { net, kind: 'p2pkh', hash, script: p2pkhScript(hash) };
  if (samePrefix(raw, params.p2sh)) return { net, kind: 'p2sh', hash, script: p2shScript(hash) };
  if (samePrefix(raw, other.p2pkh) || samePrefix(raw, other.p2sh)) throw wrongNet();
  throw new ZcashAddressError('format');
}

/** True when Send can pay this address on `net` (t1, t3 or tex1 on mainnet). */
export function isValidZcashRecipient(address: string, net: ZcashNetwork = 'main'): boolean {
  try {
    decodeZcashAddress(address, net);
    return true;
  } catch {
    return false;
  }
}

/**
 * The t-address an output script pays, or null for any other script. For
 * showing counterparties in Activity; the history match itself compares
 * scripts, never strings.
 */
export function scriptToZcashAddress(script: Uint8Array, net: ZcashNetwork = 'main'): string | null {
  if (
    script.length === 25 &&
    script[0] === 0x76 &&
    script[1] === 0xa9 &&
    script[2] === 0x14 &&
    script[23] === 0x88 &&
    script[24] === 0xac
  ) {
    return encodeP2pkh(script.slice(3, 23), net);
  }
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return encodeP2sh(script.slice(2, 22), net);
  }
  return null;
}
