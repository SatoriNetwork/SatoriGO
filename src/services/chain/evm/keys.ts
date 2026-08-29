// HD derivation, address encoding and address validation for the EVM family.
//
// SAFETY-CRITICAL, and for a different reason than the UTXO side. On EVM there
// is no base58check checksum wrapped around an address and no script for a node
// to reject: any 20 bytes are a payable account, so a mistyped address is a
// perfectly valid destination that nobody controls. EIP-55 (the mixed-case
// checksum below) is the only integrity check that exists, which is why
// isEvmAddress() REFUSES a mixed-case string whose checksum does not match
// instead of shrugging and lowercasing it.
//
// One key is one address on every EVM chain (see the EVM engine design notes, §1),
// so nothing in this module takes a chain: coin type 60 belongs to the family,
// not to a row in the registry. Everything here is pure, synchronous and
// CSP-safe (no Node APIs, no Buffer, no WASM, no eval) so it runs inside an MV3
// service worker.

import { HDKey } from '@scure/bip32';
import * as secp256k1 from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/**
 * SLIP-44 coin type for Ethereum, used by every EVM chain without exception.
 * MetaMask, Rabby and every hardware wallet derive at 60 whatever the network
 * is, so deriving at a chain-specific coin type would produce an account no
 * other tool could ever recover. It is a constant on the engine and
 * deliberately NOT a field on the chain registry.
 */
export const EVM_COIN_TYPE = 60;

/** Hardened offset: a non-hardened BIP32 child index must stay below 2^31. */
const HARDENED_OFFSET = 0x80000000;

/**
 * The BIP44 path for address index `index`: m/44'/60'/0'/0/{index}.
 *
 * The account level is pinned to 0' and the change level to 0 because that is
 * the single path every EVM wallet shows the user. Wallets that expose
 * "account 2" almost always mean address index 1 on this path, not account 1',
 * and following the other convention would silently hand the user a different
 * address than MetaMask shows for the same seed.
 */
export function evmDerivationPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
    throw new Error(`address index must be an integer in 0..${HARDENED_OFFSET - 1}, got ${index}`);
  }
  return `m/44'/${EVM_COIN_TYPE}'/0'/0/${index}`;
}

export interface EvmDerivedKey {
  path: string;
  index: number;
  privateKey: Uint8Array;
  /** UNCOMPRESSED, 65 bytes, 0x04-prefixed. See publicKeyToEvmAddress(). */
  publicKey: Uint8Array;
  /** EIP-55 checksummed, '0x' followed by 40 hex characters. */
  address: string;
}

/**
 * Normalize any accepted public-key encoding to the uncompressed 65-byte form,
 * validating that it really is a point on secp256k1 along the way.
 *
 * The on-curve check earns its keep here: garbage bytes hashed by
 * publicKeyToEvmAddress() would still produce a well-formed, checksummed
 * address, and no later layer could notice.
 */
function toUncompressedPublicKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 65 && publicKey.length !== 33) {
    throw new Error(
      `public key must be 65 bytes (uncompressed) or 33 bytes (compressed), got ${publicKey.length}`,
    );
  }
  if (publicKey.length === 65 && publicKey[0] !== 0x04) {
    throw new Error(
      `uncompressed public key must start with 0x04, got 0x${publicKey[0].toString(16)}`,
    );
  }
  try {
    // fromHex parses both encodings; toRawBytes(false) re-serializes as
    // 0x04 || X || Y, so a compressed key is decompressed here and an
    // uncompressed one round-trips unchanged.
    return secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  } catch {
    throw new Error('public key is not a valid secp256k1 point');
  }
}

/**
 * The EIP-55 checksummed address for a public key, accepting either the
 * 65-byte uncompressed or the 33-byte compressed encoding of the same key
 * (both yield the same address, because both describe the same point).
 *
 * *** THE ONE THING TO GET RIGHT ***
 * address = last 20 bytes of keccak256(X || Y), where X || Y is the
 * UNCOMPRESSED public key with its 0x04 prefix REMOVED, i.e. exactly 64 bytes.
 *
 * The two near misses both produce a valid-looking, checksummable address that
 * is simply not the user's account, and no "is this a valid address" check
 * catches either:
 *   - hashing the 33-byte COMPRESSED key;
 *   - hashing the 65-byte key with the 0x04 prefix still attached.
 * Funds sent to such an address are gone, so keys.test.ts pins both wrong
 * variants and asserts they differ from the published vector address.
 */
export function publicKeyToEvmAddress(publicKey: Uint8Array): string {
  const uncompressed = toUncompressedPublicKey(publicKey);
  // subarray(1) drops the 0x04 prefix, leaving the 64 bytes of X || Y.
  const digest = keccak_256(uncompressed.subarray(1));
  // The address is the LOW 20 bytes of the 32-byte digest, not the high ones.
  return toChecksumAddress(bytesToHex(digest.subarray(12)));
}

/**
 * Shared tail of deriveEvmKey() and privateKeyToEvmKey(), so the two can never
 * disagree about the public-key encoding and therefore about the address.
 */
function buildEvmKey(privateKey: Uint8Array, path: string, index: number): EvmDerivedKey {
  if (privateKey.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKey.length}`);
  }
  let publicKey: Uint8Array;
  try {
    // Uncompressed on purpose: it is the form the address derivation needs, and
    // carrying the compressed form on the record would invite hashing that.
    publicKey = secp256k1.getPublicKey(privateKey, false);
  } catch {
    throw new Error('invalid private key (not a valid secp256k1 scalar)');
  }
  return { path, index, privateKey, publicKey, address: publicKeyToEvmAddress(publicKey) };
}

/**
 * Derive one EVM account from a BIP39 seed at m/44'/60'/0'/0/{index}.
 *
 * The master key is built with @scure/bip32's DEFAULT version bytes. Those
 * bytes only affect xprv/xpub SERIALIZATION, never the derived keys, so there
 * is nothing chain-specific to configure: the same seed gives the same address
 * on Base, BSC and Ethereum at once, which is the whole point of the family.
 */
export function deriveEvmKey(seed: Uint8Array, index: number): EvmDerivedKey {
  const path = evmDerivationPath(index);
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive(path);
  if (!child.privateKey) {
    throw new Error(`derivation produced no key material at ${path}`);
  }
  return buildEvmKey(child.privateKey, path, index);
}

/**
 * Build an EvmDerivedKey from a raw 32-byte private key, for imports. There is
 * no HD tree behind such a key, so `path` is the nominal 'imported' and `index`
 * is 0, matching privateKeyToDerived() on the UTXO side.
 */
export function privateKeyToEvmKey(privateKey: Uint8Array): EvmDerivedKey {
  return buildEvmKey(privateKey, 'imported', 0);
}

/** '0x' followed by exactly 40 hex characters, in any case. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** The same 40 hex characters, with the '0x' already stripped. */
const EVM_ADDRESS_BODY_RE = /^[0-9a-fA-F]{40}$/;

/**
 * EIP-55: keccak256 of the LOWERCASE hex address WITHOUT the '0x', taken as an
 * ASCII string, then hex digit i is uppercased when nibble i of that hash is
 * >= 8. Digits carry no case, so only a..f ever change.
 *
 * Accepts the address with or without '0x' and in any case, because this is the
 * function that PRODUCES the canonical form; deciding whether a string is an
 * acceptable address is isEvmAddress()'s job. Throws on anything that is not 40
 * hex characters.
 */
export function toChecksumAddress(address: string): string {
  const trimmed = address.trim();
  const body = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
  if (!EVM_ADDRESS_BODY_RE.test(body)) {
    throw new Error(`not a 20-byte hex address: ${address}`);
  }
  const lower = body.toLowerCase();
  // The hash input is the ASCII TEXT of the address, not its 20 bytes. Hashing
  // the bytes would give a self-consistent but completely different checksum
  // that no other wallet agrees with.
  const hash = keccak_256(utf8ToBytes(lower));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    // Nibble i lives in byte i>>1: high nibble for even i, low nibble for odd i.
    const nibble = i % 2 === 0 ? hash[i >> 1] >> 4 : hash[i >> 1] & 0x0f;
    out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/**
 * The single validator both isEvmAddress() and normalizeEvmAddress() use, so
 * the two can never drift apart. Returns the checksummed form, or null.
 *
 * The mixed-case rule is the safety-critical part. An all-lowercase or an
 * all-uppercase address carries NO checksum (both are legal pre-EIP-55 forms),
 * but a mixed-case one is claiming to carry one, and a claim that does not
 * verify means the string was altered somewhere between the payee and here. On
 * a chain where any 20 bytes are a valid destination that is the only typo
 * detection that exists, so it fails closed.
 */
function parseEvmAddress(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!EVM_ADDRESS_RE.test(trimmed)) return null;
  const body = trimmed.slice(2);
  const checksummed = toChecksumAddress(body);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return checksummed;
  return `0x${body}` === checksummed ? checksummed : null;
}

/**
 * True for an address this wallet will accept: '0x' plus 40 hex characters that
 * are either all-lowercase, all-uppercase, or correctly EIP-55 checksummed. A
 * mixed-case address with a WRONG checksum is false, deliberately: that is what
 * a typo looks like, and there is no second line of defence after this one.
 */
export function isEvmAddress(value: string): boolean {
  return parseEvmAddress(value) !== null;
}

/**
 * Validate and return the canonical EIP-55 form. Use this wherever an address
 * is stored or displayed, so one account never becomes two strings.
 */
export function normalizeEvmAddress(value: string): string {
  const parsed = parseEvmAddress(value);
  if (!parsed) {
    throw new Error(
      `invalid EVM address: ${value} (expected 0x followed by 40 hex characters, with a valid EIP-55 checksum when mixed case)`,
    );
  }
  return parsed;
}

/**
 * Compare two addresses for identity. Case is not part of an address (it only
 * carries the checksum), so the comparison is case-insensitive, but both sides
 * must be valid: reporting "same" for two typos would be worse than false.
 */
export function isSameEvmAddress(a: string, b: string): boolean {
  const left = parseEvmAddress(a);
  const right = parseEvmAddress(b);
  return left !== null && right !== null && left === right;
}
