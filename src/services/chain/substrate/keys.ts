// Substrate (sr25519) keys from the wallet's BIP39 phrase.
//
// SAFETY-CRITICAL. The account must be the one btcli, polkadot.js, Talisman
// and SubWallet show for the same phrase (design bittensor-engine.md §2), and
// the one rule that makes it so is easy to "simplify" away:
//
//   THE MINI SECRET COMES FROM THE PHRASE'S ENTROPY, NOT FROM ITS SEED.
//
// mini_secret = PBKDF2-HMAC-SHA512(password = entropy, salt = "mnemonic" ||
// passphrase, 2048 rounds)[0..32] (substrate-bip39, polkadot.js
// mnemonicToMiniSecret). The wallet's mnemonicToSeed feeds PBKDF2 the phrase
// TEXT and gives a different account: "abandon x11 about" is
// 5EPCUjPx... by the entropy route and 5EqgEeg5... by the seed route, and only
// the former exists in every other wallet. keys.test.ts asserts both.
//
// Then sr25519: secretFromSeed (schnorrkel ExpansionMode::Ed25519: SHA-512,
// clamp, divide by the cofactor), public = scalar * ristretto basepoint,
// signing context "substrate". All of it is @scure/sr25519 2.4.0 (audited,
// bit-exact against sp_core's published vectors and polkadot.js). No
// derivation path: the account is the phrase's root, as btcli's
// from_phrase(mnemonic, None) and keyring.addFromUri(mnemonic) make it.
//
// Secrets: the 32-byte mini secret is the one thing kept while unlocked
// (zeroSubstrateAccount wipes it). The 64-byte expanded secret is created
// inside sign() and wiped before returning; the scalar bigint noble needs
// cannot be zeroed, the same limit as every other curve in this wallet.

import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha512 } from '@noble/hashes/sha2';
import { blake2b } from '@noble/hashes/blake2b';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist as bip39English } from '@scure/bip39/wordlists/english';
import * as sr25519 from '@scure/sr25519';
import { compact } from './scale';
import { TAO_SS58_PREFIX, ss58Encode } from './ss58';

export interface SubstrateAccount {
  /** 32 bytes, SECRET: everything derives from it. Zero with zeroSubstrateAccount. */
  miniSecret: Uint8Array;
  /** 32-byte sr25519 (ristretto255) public key. */
  publicKey: Uint8Array;
  /** SS58 address of the public key under the account's prefix. */
  address: string;
}

/** Thrown for a phrase or key that cannot make a Substrate account. */
export class SubstrateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubstrateKeyError';
  }
}

const MINI_SECRET_BYTES = 32;
const EXPANDED_SECRET_BYTES = 64;

/**
 * substrate-bip39 mini secret: PBKDF2-HMAC-SHA512 over the phrase's ENTROPY
 * with salt "mnemonic" || passphrase, 2048 rounds, first 32 of 64 bytes.
 *
 * The phrase must be a valid English BIP39 phrase (checksum included) exactly
 * as liveWallet stores it (trimmed, single spaces). The passphrase passes
 * into the salt untouched, as sp_core does; Satori GO phrases have none by
 * default. Synchronous (2048 rounds, tens of ms), paid once per unlock.
 */
export function miniSecretFromMnemonic(mnemonic: string, passphrase = ''): Uint8Array {
  if (typeof mnemonic !== 'string' || !validateMnemonic(mnemonic, bip39English)) {
    throw new SubstrateKeyError('Invalid recovery phrase');
  }
  if (typeof passphrase !== 'string') throw new SubstrateKeyError('The passphrase must be text.');
  const entropy = mnemonicToEntropy(mnemonic, bip39English);
  let seed64: Uint8Array | null = null;
  try {
    seed64 = pbkdf2(sha512, entropy, utf8ToBytes(`mnemonic${passphrase}`), { c: 2048, dkLen: 64 });
    return seed64.slice(0, MINI_SECRET_BYTES);
  } finally {
    entropy.fill(0);
    seed64?.fill(0);
  }
}

function assertMiniSecret(mini: Uint8Array): void {
  if (!(mini instanceof Uint8Array) || mini.length !== MINI_SECRET_BYTES) {
    throw new SubstrateKeyError('A Substrate mini secret is 32 bytes.');
  }
}

/** Expands a mini secret into the 64-byte sr25519 secret (scalar || nonce). Caller zeroes it. */
function expand(mini: Uint8Array): Uint8Array {
  assertMiniSecret(mini);
  return sr25519.secretFromSeed(mini);
}

/** The public key of a 64-byte expanded sr25519 secret. */
export function publicKeyOfExpandedSecret(secret: Uint8Array): Uint8Array {
  if (!(secret instanceof Uint8Array) || secret.length !== EXPANDED_SECRET_BYTES) {
    throw new SubstrateKeyError('An expanded sr25519 secret is 64 bytes.');
  }
  return sr25519.getPublicKey(secret);
}

/**
 * The account of a mini secret: the mini secret is COPIED into the result
 * (the caller still owns and zeroes its own bytes), the public key is
 * scalar * basepoint, the address is SS58 under `ss58Prefix` (42).
 */
export function accountFromMiniSecret(mini: Uint8Array, ss58Prefix: number = TAO_SS58_PREFIX): SubstrateAccount {
  assertMiniSecret(mini);
  const secret = expand(mini);
  try {
    const publicKey = sr25519.getPublicKey(secret);
    return { miniSecret: mini.slice(), publicKey, address: ss58Encode(publicKey, ss58Prefix) };
  } finally {
    secret.fill(0);
  }
}

/** The wallet's derivation: phrase (and passphrase) to the root sr25519 account, SS58 42. */
export function accountFromMnemonic(
  mnemonic: string,
  passphrase = '',
  ss58Prefix: number = TAO_SS58_PREFIX,
): SubstrateAccount {
  const mini = miniSecretFromMnemonic(mnemonic, passphrase);
  try {
    return accountFromMiniSecret(mini, ss58Prefix);
  } finally {
    mini.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Derivation junctions (sp_core DeriveJunction). Implemented and pinned so a
// later "Account 2" is //0 and nothing else; NOT offered by the v1 UI.
// ---------------------------------------------------------------------------

/**
 * The 32-byte chain code of one junction: a decimal integer is a u64 LE
 * (zero padded); any other text is SCALE-encoded (compact length || utf8)
 * and zero padded, or blake2b-256 hashed when longer than 32 bytes.
 */
export function junctionChainCode(junction: string | number): Uint8Array {
  const text = typeof junction === 'number' ? String(junction) : junction;
  if (typeof text !== 'string' || text.length === 0 || text.includes('/')) {
    throw new SubstrateKeyError('A derivation junction is one name or number, without slashes.');
  }
  const cc = new Uint8Array(32);
  if (/^\d+$/.test(text)) {
    let n = BigInt(text);
    if (n > (1n << 64n) - 1n) throw new SubstrateKeyError('A numeric junction must fit a u64.');
    for (let i = 0; i < 8; i += 1) {
      cc[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return cc;
  }
  const bytes = utf8ToBytes(text);
  const enc = concatBytes(compact(bytes.length), bytes);
  if (enc.length > 32) return blake2b(enc, { dkLen: 32 });
  cc.set(enc);
  return cc;
}

/** "//name" for hard, "/name" for soft, or the bare name/number; the wrong kind of slash is refused. */
function stripJunction(junction: string | number, hard: boolean): string | number {
  if (typeof junction === 'number') return junction;
  if (junction.startsWith('//')) {
    if (!hard) throw new SubstrateKeyError('A soft junction starts with a single slash.');
    return junction.slice(2);
  }
  if (junction.startsWith('/')) {
    if (hard) throw new SubstrateKeyError('A hard junction starts with two slashes.');
    return junction.slice(1);
  }
  return junction;
}

/**
 * Hard child of a mini secret: "//0", "//Alice", or the bare name/number.
 * Returns the child's 64-byte EXPANDED sr25519 secret (scalar || nonce):
 * @scure/sr25519 derives the child mini secret inside HDKD.secretHard and
 * expands it before returning, so the child mini secret is not exposed.
 * Feed the result to publicKeyOfExpandedSecret and zero it when done.
 */
export function deriveHard(mini: Uint8Array, junction: string | number): Uint8Array {
  const parent = expand(mini);
  try {
    return sr25519.HDKD.secretHard(parent, junctionChainCode(stripJunction(junction, true)));
  } finally {
    parent.fill(0);
  }
}

/**
 * Soft child of a mini secret ("/Alice"): the same 64-byte expanded-secret
 * shape as deriveHard. Exists so the published sp_core soft vector pins the
 * junction encoding; the wallet never offers soft paths.
 */
export function deriveSoft(mini: Uint8Array, junction: string | number): Uint8Array {
  const parent = expand(mini);
  try {
    return sr25519.HDKD.secretSoft(parent, junctionChainCode(stripJunction(junction, false)));
  } finally {
    parent.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * sr25519 signature (64 bytes, Schnorrkel marker set) over `message` under
 * the signing context "substrate", from the mini secret. The expanded secret
 * lives only inside this call. `random` (32 bytes) seeds the nonce; tests
 * pass one for a deterministic signature, production leaves it to the CSPRNG.
 */
export function signSubstrate(mini: Uint8Array, message: Uint8Array, random?: Uint8Array): Uint8Array {
  if (!(message instanceof Uint8Array)) throw new SubstrateKeyError('The message to sign must be bytes.');
  const secret = expand(mini);
  try {
    return random === undefined ? sr25519.sign(secret, message) : sr25519.sign(secret, message, random);
  } finally {
    secret.fill(0);
  }
}

/** True when `signature` is a valid sr25519 signature of `message` by `publicKey` (context "substrate"). */
export function verifySubstrate(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return false;
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  if (!(message instanceof Uint8Array)) return false;
  try {
    return sr25519.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

/** Zero the secret (and, harmlessly, the public key) in place. Call on lock. */
export function zeroSubstrateAccount(account: SubstrateAccount): void {
  account.miniSecret.fill(0);
  account.publicKey.fill(0);
}
