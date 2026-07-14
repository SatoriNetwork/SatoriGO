// HD key derivation and address encoding for Evrmore (EVR).
//
// SAFETY-CRITICAL: a bug in this module can render funds unspendable or leak
// keys. Every primitive here is pure-JS and CSP-safe (no Node APIs, no Buffer,
// no WASM, no eval) so it runs inside a Chrome MV3 service worker. Uint8Array
// is used throughout.
//
// Chain parameters are imported from ./chainParams (already verified against the
// Evrmore source). Do NOT hardcode version bytes here.

import { generateMnemonic as bip39Generate, validateMnemonic as bip39Validate, mnemonicToSeed as bip39MnemonicToSeed } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { concatBytes } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import type { EvrmoreNetwork } from './chainParams';

// base58check helper. @scure/base's base58check takes the sha256 fn and does the
// double-sha256 checksum (sha256(sha256(payload))[0..4]) internally, so we get a
// single, well-tested code path for every base58check encode/decode below.
const b58c = base58check(sha256);

// ---------------------------------------------------------------------------
// Mnemonic / seed
// ---------------------------------------------------------------------------

/** Generate a fresh BIP39 mnemonic (English). strength in bits: 128 => 12 words, 256 => 24 words. */
export function generateMnemonic(strength: 128 | 256 = 128): string {
  return bip39Generate(wordlist, strength);
}

/** Validate a BIP39 mnemonic against the English wordlist + checksum. */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39Validate(mnemonic, wordlist);
}

/** BIP39 mnemonic -> 64-byte seed (PBKDF2-HMAC-SHA512, 2048 rounds). */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  return bip39MnemonicToSeed(mnemonic, passphrase);
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** hash160 = ripemd160(sha256(data)). Used for P2PKH address payloads. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

// ---------------------------------------------------------------------------
// Address / script encoding
// ---------------------------------------------------------------------------

/**
 * Encode a P2PKH address from a (compressed) public key.
 * base58check(version || hash160(pubkey)), version = net.pubKeyHash.
 */
export function pubkeyToAddress(publicKey: Uint8Array, net: EvrmoreNetwork): string {
  const h160 = hash160(publicKey);
  const payload = concatBytes(Uint8Array.of(net.pubKeyHash & 0xff), h160);
  return b58c.encode(payload);
}

/**
 * Decode a base58check P2PKH address into its version byte + 20-byte hash160.
 * Throws if the checksum is invalid or the payload is not 1 + 20 bytes.
 */
export function addressToHash160(address: string): { version: number; hash: Uint8Array } {
  const payload = b58c.decode(address);
  if (payload.length !== 21) {
    throw new Error(`invalid P2PKH payload length: ${payload.length}`);
  }
  return { version: payload[0], hash: payload.slice(1) };
}

/**
 * Validate an address by base58check-decoding it. If a network is supplied the
 * version byte must match that network's P2PKH or P2SH prefix; otherwise any
 * well-formed 21-byte base58check payload is accepted.
 */
export function isValidAddress(address: string, net?: EvrmoreNetwork): boolean {
  try {
    const { version } = addressToHash160(address);
    if (net) {
      return version === net.pubKeyHash || version === net.scriptHash;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * True ONLY for a standard P2PKH address on `net` (the version byte equals
 * net.pubKeyHash). SAFETY-CRITICAL for the send path: the transaction builder
 * only ever emits P2PKH output scripts, so sending to a P2SH ('e…') or
 * wrong-network address — which isValidAddress() also accepts — would build an
 * output the recipient can NEVER spend (funds burned). Every recipient/change
 * address fed to the builder MUST pass this, not the looser isValidAddress().
 */
export function isP2pkhAddress(address: string, net: EvrmoreNetwork): boolean {
  try {
    return addressToHash160(address).version === net.pubKeyHash;
  } catch {
    return false;
  }
}

/**
 * P2PKH scriptPubKey for a hash160:
 *   OP_DUP OP_HASH160 <20-byte push> <hash160> OP_EQUALVERIFY OP_CHECKSIG
 *   0x76   0xa9        0x14          ...        0x88          0xac
 */
export function p2pkhScript(h160: Uint8Array): Uint8Array {
  if (h160.length !== 20) {
    throw new Error(`hash160 must be 20 bytes, got ${h160.length}`);
  }
  return concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), h160, Uint8Array.of(0x88, 0xac));
}

/**
 * Electrum protocol scripthash for an address:
 *   sha256(scriptPubKey), byte order REVERSED, lowercase hex.
 * This is the subscription key used by ElectrumX servers.
 */
export function addressToElectrumScripthash(address: string): string {
  const { hash } = addressToHash160(address);
  const script = p2pkhScript(hash);
  const digest = sha256(script);
  // Reverse byte order (Electrum uses little-endian display for the scripthash).
  const reversed = digest.slice().reverse();
  return bytesToHexLower(reversed);
}

// ---------------------------------------------------------------------------
// WIF (Wallet Import Format)
// ---------------------------------------------------------------------------

/**
 * Encode a 32-byte private key as WIF.
 * base58check(version || key || [0x01 if compressed]), version = net.wif.
 */
export function encodeWif(privateKey: Uint8Array, net: EvrmoreNetwork, compressed = true): string {
  if (privateKey.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKey.length}`);
  }
  const parts = [Uint8Array.of(net.wif & 0xff), privateKey];
  if (compressed) {
    parts.push(Uint8Array.of(0x01));
  }
  return b58c.encode(concatBytes(...parts));
}

/**
 * Decode a WIF string into its private key and compression flag.
 * Payload is version(1) || key(32) [|| 0x01]. Version byte is not checked
 * against a specific network so the same decoder works for mainnet/testnet.
 */
export function decodeWif(wif: string): { privateKey: Uint8Array; compressed: boolean } {
  const payload = b58c.decode(wif);
  // 1 (version) + 32 (key) => uncompressed; + 1 (0x01 flag) => compressed.
  if (payload.length === 34 && payload[33] === 0x01) {
    return { privateKey: payload.slice(1, 33), compressed: true };
  }
  if (payload.length === 33) {
    return { privateKey: payload.slice(1, 33), compressed: false };
  }
  throw new Error(`invalid WIF payload length: ${payload.length}`);
}

// ---------------------------------------------------------------------------
// HD derivation
// ---------------------------------------------------------------------------

export interface DerivedKey {
  path: string;
  index: number;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
  wif: string;
}

/**
 * Derive a single BIP44 key for Evrmore: m/44'/coinType'/account'/change/index.
 *
 * The master HDKey is created WITH Evrmore's bip32 version bytes. @scure/bip32
 * supports custom versions, but note these bytes only affect xprv/xpub
 * serialization — the derived private key, public key, and therefore address
 * are identical regardless of the version bytes used. Addresses depend solely
 * on net.pubKeyHash, which pubkeyToAddress controls.
 *
 * The public key returned by @scure/bip32 is the COMPRESSED 33-byte form, which
 * is the BIP44 standard for address derivation.
 */
export function deriveAddress(
  seed: Uint8Array,
  net: EvrmoreNetwork,
  account: number,
  change: 0 | 1,
  index: number,
): DerivedKey {
  const master = HDKey.fromMasterSeed(seed, { public: net.bip32.public, private: net.bip32.private });
  const path = `m/44'/${net.coinType}'/${account}'/${change}/${index}`;
  const child = master.derive(path);
  if (!child.privateKey || !child.publicKey) {
    throw new Error(`derivation produced no key material at ${path}`);
  }
  const privateKey = child.privateKey;
  const publicKey = child.publicKey; // compressed, 33 bytes
  return {
    path,
    index,
    privateKey,
    publicKey,
    address: pubkeyToAddress(publicKey, net),
    wif: encodeWif(privateKey, net, true),
  };
}

/**
 * Build a single-address DerivedKey directly from a raw 32-byte private key.
 * Used for PRIVATE-KEY imports (e.g. Satori-style single-key wallets), which have
 * exactly ONE address — there is no HD tree, so `index`/`path` are nominal.
 * The compression flag must match the key's origin (WIF carries it) so the
 * derived address matches the source wallet.
 */
export function privateKeyToDerived(
  privateKey: Uint8Array,
  net: EvrmoreNetwork,
  compressed = true,
): DerivedKey {
  if (privateKey.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKey.length}`);
  }
  const publicKey = secp256k1.getPublicKey(privateKey, compressed);
  return {
    path: 'imported',
    index: 0,
    privateKey,
    publicKey,
    address: pubkeyToAddress(publicKey, net),
    wif: encodeWif(privateKey, net, compressed),
  };
}

/**
 * Parse a user-supplied private key in WIF (base58check) or raw hex (64 chars,
 * optional 0x) form into its 32-byte value + compression flag. Validates the key
 * is a legal secp256k1 scalar. Throws on anything malformed.
 */
export function parsePrivateKey(input: string): { privateKey: Uint8Array; compressed: boolean } {
  const raw = input.trim();
  if (!raw) throw new Error('empty private key');

  let privateKey: Uint8Array;
  let compressed = true;

  const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Raw hex private key (compression is unknown; default to compressed).
    privateKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) privateKey[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    // Assume WIF (base58check). decodeWif validates the checksum + length.
    const decoded = decodeWif(raw);
    privateKey = decoded.privateKey;
    compressed = decoded.compressed;
  }

  // Reject a key that is 0 or ≥ the curve order (getPublicKey throws for these).
  try {
    secp256k1.getPublicKey(privateKey, compressed);
  } catch {
    throw new Error('invalid private key (not a valid secp256k1 scalar)');
  }
  return { privateKey, compressed };
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

const HEX_CHARS = '0123456789abcdef';

/** Lowercase hex without depending on Buffer. */
function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX_CHARS[(b >> 4) & 0x0f] + HEX_CHARS[b & 0x0f];
  }
  return out;
}
