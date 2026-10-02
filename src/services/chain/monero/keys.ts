// Monero key derivation: BIP39 phrase or 25 words to spend/view key pairs.
//
// SAFETY-CRITICAL. A bug here derives a wallet other than the one the user
// can restore anywhere else, and Monero gives no second chance to notice: the
// balance of a wrong address is simply zero. Every function is pinned by the
// vectors in keys.test.ts (Cake, Ledger, Trezor, monero-python,
// monero-project), each of which a wrong implementation fails.
//
// Pure TypeScript on @noble/curves (ed25519), @noble/hashes (keccak-256,
// HMAC-SHA512, HKDF-SHA256), @scure/bip32 and @scure/bip39. No WASM, no Node
// APIs, CSP-safe. monero-ts is handed the spend key and derives nothing, so
// there is exactly one derivation to keep right (design monero-engine.md §5).
// Ported from the research reference xmr_noble.mjs (noble1 variant), which
// agrees field for field with bip_utils + monero-python and with monero-ts.
//
// The rules the code obeys, each caught by a vector if broken:
//   - keccak_256 (original Keccak, padding 0x01), NEVER sha3_256;
//   - sc_reduce32 reads the 32 bytes LITTLE-endian;
//   - Monero private keys are raw scalars: public key = scalar * G by
//     Point.multiply only. NEVER ed25519.getPublicKey / sign, which clamp and
//     SHA-512 the seed (RFC 8032) and give a different point;
//   - a scalar that reduces to zero is refused, not used.
//
// Secrets are Uint8Array and the caller zeroes them (zeroMoneroKeys) when done.
// Intermediates (the BIP39 seed, the BIP32 nodes, the SLIP-10 chain codes, the
// keccak digests) are zeroed here before returning. The one thing that cannot
// be zeroed is the bigint noble needs for a scalar multiplication: JS bigints
// are immutable. That is the same limit keys.ts has on secp256k1 today.

import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as bip39English } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { legacyWordsToSpendKey } from './mnemonic';

export type MoneroNetwork = 'mainnet' | 'stagenet' | 'testnet';

/**
 * The three BIP39-to-Monero schemes found in the wild (design §2.2). They are
 * mutually incompatible: the same phrase gives three unrelated wallets.
 *   'cake-exodus'  secp256k1 BIP32 m/44'/128'/0'/0/0, spend = sc_reduce32(key)
 *                  (Cake Wallet cw_monero/bip39_seed.dart). THE ONE THAT SHIPS.
 *   'ledger'       same path, spend = sc_reduce32(keccak256(key))
 *                  (LedgerHQ app-monero monero_init.c).
 *   'trezor'       SLIP-0010 ed25519 m/44'/128'/0', spend = sc_reduce32(key)
 *                  (trezor-firmware apps/monero).
 * The two alternatives are kept as switches, proven by their vectors, so the
 * decision can still change BEFORE release without re-deriving anything.
 */
export type Bip39MoneroScheme = 'cake-exodus' | 'ledger' | 'trezor';

/**
 * The one that ships (owner decision 2026-09-28: Cake Wallet compatible).
 * Changing it after release orphans every user's funds view: the same phrase
 * would open a different, empty wallet and the funds would look gone.
 */
export const MONERO_BIP39_SCHEME: Bip39MoneroScheme = 'cake-exodus';

/**
 * SLIP-44 coin type 128. Scheme A does NO hashing between the secp256k1 BIP32
 * key at m/44'/128'/0'/0/0 and the Monero spend key, so revealing the spend
 * key (the 25 words) reveals that secp256k1 key. Harmless as long as coin type
 * 128 is never used for anything else in this wallet (design §2.2). Never
 * reuse it.
 */
export const MONERO_COIN_TYPE = 128;

export interface MoneroKeys {
  /** Private spend key, 32 bytes little-endian, canonical (< l). SECRET. */
  spendSec: Uint8Array;
  /** Private view key = Hs(spendSec). SECRET (reveals every incoming payment). */
  viewSec: Uint8Array;
  /** spendSec * G, 32 bytes compressed ed25519. */
  spendPub: Uint8Array;
  /** viewSec * G. */
  viewPub: Uint8Array;
}

/** Thrown for a key that cannot be a Monero key (wrong size, zero scalar). */
export class MoneroKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneroKeyError';
  }
}

/** ed25519 prime subgroup order l = 2^252 + 27742317777372353535851937790883648493. */
export const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

const HARDENED_OFFSET = 0x80000000;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** 32 little-endian bytes to a bigint. Exported for address.ts (subaddress math). */
export function scalarToBigInt(bytesLe: Uint8Array): bigint {
  let x = 0n;
  for (let i = bytesLe.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytesLe[i]);
  return x;
}

function bigIntToLe32(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * Monero's sc_reduce32: read 32 bytes LITTLE-endian, reduce mod l, write back
 * as 32 little-endian bytes. Returns a new array; the input is untouched.
 */
export function scReduce32(bytes32: Uint8Array): Uint8Array {
  if (!(bytes32 instanceof Uint8Array) || bytes32.length !== 32) {
    throw new MoneroKeyError('sc_reduce32 takes exactly 32 bytes.');
  }
  return bigIntToLe32(scalarToBigInt(bytes32) % ED25519_L);
}

/** Monero's Hs(x) = sc_reduce32(keccak256(x)). Exported for address.ts. */
export function hashToScalar(data: Uint8Array): Uint8Array {
  const digest = keccak_256(data);
  const s = scReduce32(digest);
  digest.fill(0);
  return s;
}

function isZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const b of bytes) acc |= b;
  return acc === 0;
}

/** scalar * G, raw (no clamping). The scalar must be canonical and non-zero. */
function publicKeyOf(scalarLe: Uint8Array): Uint8Array {
  return ed25519.Point.BASE.multiply(scalarToBigInt(scalarLe)).toBytes();
}

// ---------------------------------------------------------------------------
// Key sets
// ---------------------------------------------------------------------------

/**
 * The full key set from a 32-byte spend key, as monero's
 * account_base::generate(recovery_key, recover=true) does: reduce, then
 * view = Hs(spend), then both public keys.
 *
 * The input is reduced mod l first (the identity on any key a wallet made,
 * and what Monero does with a non-canonical recovery key). Throws
 * MoneroKeyError on a wrong length or a key that reduces to zero. The input
 * is copied, never kept: the caller still owns (and zeroes) its bytes.
 */
export function moneroKeysFromSpendKey(spendSec: Uint8Array): MoneroKeys {
  const spend = scReduce32(spendSec);
  if (isZero(spend)) {
    throw new MoneroKeyError('This key reduces to zero and cannot be a Monero spend key.');
  }
  const view = hashToScalar(spend);
  if (isZero(view)) {
    spend.fill(0);
    throw new MoneroKeyError('This key gives a zero view key and cannot be used.');
  }
  return { spendSec: spend, viewSec: view, spendPub: publicKeyOf(spend), viewPub: publicKeyOf(view) };
}

/**
 * Import of an existing Monero wallet from its 25 words (design §2.1 step 7).
 * Throws MoneroMnemonicError (from mnemonic.ts) on a bad phrase.
 */
export function moneroKeysFromLegacyWords(words: string): MoneroKeys {
  const raw = legacyWordsToSpendKey(words);
  try {
    return moneroKeysFromSpendKey(raw);
  } finally {
    raw.fill(0);
  }
}

// SLIP-0010 for ed25519, hardened children only (the only kind it defines).
// Used by the 'trezor' switch alone.
function slip10Ed25519(seed: Uint8Array, hardenedPath: readonly number[]): Uint8Array {
  let I = hmac(sha512, utf8ToBytes('ed25519 seed'), seed);
  for (const index of hardenedPath) {
    const i = (index + HARDENED_OFFSET) >>> 0;
    const data = new Uint8Array(37);
    data.set(I.subarray(0, 32), 1);
    data[33] = (i >>> 24) & 0xff;
    data[34] = (i >>> 16) & 0xff;
    data[35] = (i >>> 8) & 0xff;
    data[36] = i & 0xff;
    const next = hmac(sha512, I.subarray(32), data);
    data.fill(0);
    I.fill(0);
    I = next;
  }
  const key = I.slice(0, 32);
  I.fill(0);
  return key;
}

// secp256k1 BIP32 private key at m/44'/128'/account'/0/0, copied out; both
// HDKey nodes are wiped before returning.
function bip32MoneroPrivateKey(seed: Uint8Array, account: number): Uint8Array {
  const master = HDKey.fromMasterSeed(seed);
  const node = master.derive(`m/44'/${MONERO_COIN_TYPE}'/${account}'/0/0`);
  try {
    if (!node.privateKey) throw new MoneroKeyError('BIP32 derivation produced no private key.');
    return node.privateKey.slice();
  } finally {
    node.wipePrivateData();
    master.wipePrivateData();
  }
}

/**
 * BIP39 phrase to Monero keys under `scheme`, at scheme account `account`.
 *
 * `account` is the scheme's own account level (Cake's accountIndex, Trezor's
 * m/44'/128'/N'). It is NOT the Monero subaddress account (major index), and
 * the wallet only ever uses 0: this export exists so the published account-1
 * and account-2 vectors of Cake and Trezor can pin the switches.
 *
 * The phrase must be a valid English BIP39 phrase (checksum included) exactly
 * as stored, which is how liveWallet stores it (trimmed, single spaces).
 * Anything else throws: in particular a 25-word Monero seed passed here by
 * mistake would otherwise run through PBKDF2 and silently give a different,
 * empty wallet. The passphrase passes through to PBKDF2, as Cake does.
 *
 * Synchronous (mnemonicToSeedSync, 2048 rounds of PBKDF2, tens of ms): the
 * signature in design §15 is sync and the cost is paid once per unlock.
 */
export function moneroKeysFromBip39Account(
  mnemonic: string,
  passphrase: string,
  scheme: Bip39MoneroScheme,
  account: number,
): MoneroKeys {
  if (!Number.isInteger(account) || account < 0 || account >= HARDENED_OFFSET) {
    throw new MoneroKeyError(`account must be an integer in 0..${HARDENED_OFFSET - 1}.`);
  }
  if (scheme !== 'cake-exodus' && scheme !== 'ledger' && scheme !== 'trezor') {
    throw new MoneroKeyError('Unknown BIP39 to Monero scheme.');
  }
  if (!validateMnemonic(mnemonic, bip39English)) throw new MoneroKeyError('Invalid recovery phrase');

  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  try {
    return moneroKeysFromBip39SeedAccount(seed, scheme, account);
  } finally {
    seed.fill(0);
  }
}

/**
 * The same derivation from the 64-byte BIP39 SEED (mnemonicToSeed's output,
 * which is what liveWallet holds in memory while a seed wallet is unlocked)
 * instead of the phrase. It exists so "Add Monero" on an unlocked seed wallet
 * can derive the sibling's keys from the seed already in memory, without a
 * second PBKDF2 and without the phrase leaving the vault. The seed is the
 * caller's: it is read, never zeroed here. Every phrase-taking path above
 * runs through this, so the published vectors pin it too.
 */
export function moneroKeysFromBip39SeedAccount(
  seed: Uint8Array,
  scheme: Bip39MoneroScheme,
  account: number,
): MoneroKeys {
  if (!Number.isInteger(account) || account < 0 || account >= HARDENED_OFFSET) {
    throw new MoneroKeyError(`account must be an integer in 0..${HARDENED_OFFSET - 1}.`);
  }
  if (scheme !== 'cake-exodus' && scheme !== 'ledger' && scheme !== 'trezor') {
    throw new MoneroKeyError('Unknown BIP39 to Monero scheme.');
  }
  if (!(seed instanceof Uint8Array) || seed.length !== 64) {
    throw new MoneroKeyError('A BIP39 seed is 64 bytes.');
  }
  let recovery: Uint8Array | null = null;
  try {
    if (scheme === 'trezor') {
      recovery = slip10Ed25519(seed, [44, MONERO_COIN_TYPE, account]);
    } else {
      const priv = bip32MoneroPrivateKey(seed, account);
      if (scheme === 'ledger') {
        recovery = keccak_256(priv);
        priv.fill(0);
      } else {
        // cake-exodus: the secp256k1 scalar bytes as stored (big-endian for
        // secp256k1), read by sc_reduce32 as LITTLE-endian. No hash between.
        recovery = priv;
      }
    }
    return moneroKeysFromSpendKey(recovery);
  } finally {
    recovery?.fill(0);
  }
}

/** Account 0 of the shipped scheme from a 64-byte BIP39 seed; see above. */
export function moneroKeysFromBip39Seed(seed: Uint8Array, scheme: Bip39MoneroScheme = MONERO_BIP39_SCHEME): MoneroKeys {
  return moneroKeysFromBip39SeedAccount(seed, scheme, 0);
}

/**
 * The wallet's derivation: BIP39 phrase to Monero keys, account 0, under the
 * shipped scheme unless a scheme is named (only tests name one).
 */
export function moneroKeysFromBip39(
  mnemonic: string,
  passphrase = '',
  scheme: Bip39MoneroScheme = MONERO_BIP39_SCHEME,
): MoneroKeys {
  return moneroKeysFromBip39Account(mnemonic, passphrase, scheme, 0);
}

// ---------------------------------------------------------------------------
// Cache secrets (design §6.5)
// ---------------------------------------------------------------------------

const CACHE_HKDF_SALT = 'satori-go/monero/v1';

/**
 * Two independent secrets for the scan cache, both HKDF-SHA256 of the spend
 * key with salt "satori-go/monero/v1":
 *   cacheKey        info "cache",   32 bytes: the AES-256-GCM key that wraps
 *                   the wallet2 blobs before they reach IndexedDB;
 *   wallet2Password info "wallet2", 32 bytes as 64 lowercase hex characters:
 *                   the password monero-ts/wallet2 encrypts its own data with.
 *
 * Derived rather than stored, so the vault-copy sibling entry needs nothing
 * extra and re-importing the same wallet elsewhere lands on the same cache
 * key. The spend key, not the view key, is the input: a leaked view key must
 * not open the cache (it would reveal the spend history, which the view key
 * alone cannot). The info strings and the salt are frozen; changing either
 * orphans every cache (a rescan, not a loss). Pinned in keys.test.ts.
 */
export function moneroCacheSecrets(keys: MoneroKeys): { cacheKey: Uint8Array; wallet2Password: string } {
  if (!(keys.spendSec instanceof Uint8Array) || keys.spendSec.length !== 32 || isZero(keys.spendSec)) {
    throw new MoneroKeyError('No spend key to derive the cache secrets from.');
  }
  const salt = utf8ToBytes(CACHE_HKDF_SALT);
  const cacheKey = hkdf(sha256, keys.spendSec, salt, utf8ToBytes('cache'), 32);
  const pw = hkdf(sha256, keys.spendSec, salt, utf8ToBytes('wallet2'), 32);
  const wallet2Password = bytesToHex(pw);
  pw.fill(0);
  return { cacheKey, wallet2Password };
}

/** Zero every key in the set in place. Call when the owning object is dropped. */
export function zeroMoneroKeys(keys: MoneroKeys): void {
  keys.spendSec.fill(0);
  keys.viewSec.fill(0);
  keys.spendPub.fill(0);
  keys.viewPub.fill(0);
}
