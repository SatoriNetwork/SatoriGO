// Encrypted seed vault for the Evrmore wallet.
//
// SAFETY-CRITICAL: this module protects a real BIP39 mnemonic / seed. It only
// *transforms* secrets (encrypt / decrypt); it NEVER persists plaintext and
// NEVER logs the secret or the password. Storage of the resulting VaultRecord
// is the caller's responsibility.
//
// Design:
//   - KDF:    scrypt (@noble/hashes) with strong params (N=2**17, r=8, p=1),
//             deriving a 32-byte AES key from the password + a random salt.
//   - Cipher: AES-256-GCM via WebCrypto (crypto.subtle). GCM's authentication
//             tag gives us tamper detection and wrong-password rejection for
//             free — a bad key fails the auth check and decryption throws.
//   - Randomness: crypto.getRandomValues for a fresh 16-byte scrypt salt and a
//             fresh 12-byte GCM IV on every encryption.
//
// CSP-safe and MV3-safe: no Node APIs, no Buffer, no eval/WASM. Uint8Array is
// used throughout; all binary fields in the record are base64 strings so the
// record is plain-JSON-serializable.

import { scryptAsync } from '@noble/hashes/scrypt';
import { base64ToBytes, bytesToBase64 } from './base64';
import {
  bytesEqual,
  generateWalletKey,
  unwrapWalletKey,
  wrapWalletKey,
  zeroKey,
  type WrappedWalletKey,
} from './appKey';

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

/**
 * A self-describing encrypted secret. Every field needed to derive the key and
 * decrypt is stored (except the password), so the record can be persisted as
 * JSON and the KDF params can evolve without breaking old records.
 */
export interface VaultRecord {
  version: 1;
  kdf: 'scrypt';
  /** scrypt cost parameter (must be a power of two). */
  N: number;
  /** scrypt block-size parameter. */
  r: number;
  /** scrypt parallelization parameter. */
  p: number;
  /** base64 of the 16-byte scrypt salt. */
  salt: string;
  /** base64 of the 12-byte AES-GCM IV. */
  iv: string;
  /** base64 of the AES-256-GCM ciphertext (includes the 16-byte auth tag). */
  ciphertext: string;
}

/**
 * VERSION 2: the secret under a per-wallet WALLET KEY, and that wallet key
 * wrapped by the app MASTER KEY (the app-password design notes §3).
 *
 * There is no KDF here at all and that is the point: the expensive scrypt is
 * paid ONCE, on the app record (appKey.ts), and this record only holds two
 * AES-256-GCM blobs. Changing the app password re-wraps `wrappedKey` and never
 * rewrites `ciphertext`, so a password change cannot corrupt a seed.
 *
 * A v1 record is NEVER upgraded in place and NEVER stops being readable: v1 and
 * v2 both live in `WalletEntry.vault` forever, and the reader dispatches on
 * `version`. A wallet whose password the user does not supply simply stays v1.
 *
 * `keySource` names WHICH keys can open the wallet key. Today only 'app'. §7's
 * later "extra password on one wallet" adds a SECOND wrapped copy of the same
 * wallet key under 'app+wallet' — new optional fields, no format change and no
 * re-encryption of the secret, which is exactly why the wallet key exists.
 */
export interface VaultRecordV2 {
  version: 2;
  /** The wallet key is wrapped by the app master key. */
  keySource: 'app';
  /** base64 of AES-256-GCM(masterKey, walletKey). */
  wrappedKey: string;
  /** base64 of the 12-byte GCM IV for the wrap. */
  wrapIv: string;
  /** base64 of the 12-byte GCM IV for the secret itself. */
  iv: string;
  /** base64 of AES-256-GCM(walletKey, secret), auth tag included. */
  ciphertext: string;
}

/**
 * What `WalletEntry.vault` may hold. EVERY reader must dispatch on `version`;
 * isVaultRecordV2() is the only sanctioned way to ask.
 */
export type StoredVaultRecord = VaultRecord | VaultRecordV2;

/** True for an app-key-protected (v2) record. The v1 path is everything else. */
export function isVaultRecordV2(record: StoredVaultRecord | null | undefined): record is VaultRecordV2 {
  return !!record && (record as VaultRecordV2).version === 2;
}

// ---------------------------------------------------------------------------
// KDF parameters
// ---------------------------------------------------------------------------

/** Length in bytes of the derived AES key (AES-256 => 32 bytes). */
const DK_LEN = 32;
/** scrypt salt length in bytes. */
const SALT_LEN = 16;
/** AES-GCM IV length in bytes (96-bit nonce is the GCM-recommended size). */
const IV_LEN = 12;

/**
 * Default scrypt parameters for NEW vaults. N=2**17 (131072) is a strong
 * interactive setting: roughly 128 MB of memory (128 * N * r bytes) and
 * ~100-200 ms on a modern CPU. This raises the offline brute-force cost of a
 * stolen vault file versus the previous N=2**16 (~64 MB).
 *
 * Existing records are NOT affected: every VaultRecord stores its own N/r/p, so
 * unlockVault always derives with the record's stored params (see unlockVault /
 * deriveKey) and older vaults keep unlocking with whatever they were created at.
 *
 * @noble/hashes scrypt default maxmem is ~1 GB (1024**3 + 1024); this config
 * uses 128 * 8 * (N + p) ≈ 134 MB, comfortably under the limit, so no explicit
 * maxmem is required.
 */
export const DEFAULT_KDF = {
  N: 2 ** 17,
  r: 8,
  p: 1,
} as const;

// ---------------------------------------------------------------------------
// core crypto
// ---------------------------------------------------------------------------

/** Fill and return a fresh random Uint8Array of the given length. */
function randomBytes(len: number): Uint8Array {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return b;
}

/** UTF-8 encode a string to bytes. */
function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Derive a 32-byte AES key from a password + salt using scrypt, then import it
 * as a non-extractable AES-GCM CryptoKey. The raw derived bytes are zeroed once
 * imported so they don't linger in memory longer than necessary.
 */
async function deriveKey(
  password: string,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
): Promise<CryptoKey> {
  const passwordBytes = utf8Encode(password);
  const dk = await scryptAsync(passwordBytes, salt, { N, r, p, dkLen: DK_LEN });
  try {
    return await crypto.subtle.importKey('raw', dk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    dk.fill(0);
    passwordBytes.fill(0);
  }
}

/** Normalize the secret input to bytes (UTF-8 for strings). */
function toSecretBytes(secret: string | Uint8Array): Uint8Array {
  return typeof secret === 'string' ? utf8Encode(secret) : secret;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a secret (a BIP39 mnemonic string, or raw seed bytes) under a
 * password. Generates a fresh random salt and IV so the same secret+password
 * encrypts to a different record every time.
 */
export async function createVault(secret: string | Uint8Array, password: string): Promise<VaultRecord> {
  const { N, r, p } = DEFAULT_KDF;
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);

  const key = await deriveKey(password, salt, N, r, p);
  const plaintext = toSecretBytes(secret);
  const ctBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  // If we UTF-8-encoded a string above, zero that throwaway copy. (When the
  // caller passed a Uint8Array we do NOT touch their buffer.)
  if (typeof secret === 'string') plaintext.fill(0);

  return {
    version: 1,
    kdf: 'scrypt',
    N,
    r,
    p,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ctBuffer)),
  };
}

/**
 * Decrypt a vault record, returning the plaintext bytes.
 *
 * THROWS a clear Error on a wrong password or a tampered record: AES-GCM
 * verifies the authentication tag before returning any plaintext, so a bad key
 * or a flipped ciphertext byte fails the check rather than producing garbage.
 */
export async function unlockVault(record: VaultRecord, password: string): Promise<Uint8Array> {
  validateRecord(record);

  const salt = base64ToBytes(record.salt);
  const iv = base64ToBytes(record.iv);
  const ciphertext = base64ToBytes(record.ciphertext);

  const key = await deriveKey(password, salt, record.N, record.r, record.p);
  try {
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new Uint8Array(plainBuffer);
  } catch {
    // Do not leak which check failed or any key material — just a clear message.
    throw new Error('Failed to unlock vault: wrong password or corrupted data.');
  }
}

/** Decrypt a vault record and UTF-8-decode the result to a string. */
export async function unlockVaultString(record: VaultRecord, password: string): Promise<string> {
  const bytes = await unlockVault(record, password);
  // Zero the plaintext byte buffer once decoded; the returned string itself cannot be zeroed in JS.
  try {
    return new TextDecoder().decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Re-encrypt a vault under a new password. Verifies the old password first
 * (unlockVault throws if it is wrong), then produces a brand-new record with a
 * fresh salt and IV.
 */
export async function changeVaultPassword(
  record: VaultRecord,
  oldPassword: string,
  newPassword: string,
): Promise<VaultRecord> {
  const secret = await unlockVault(record, oldPassword); // throws on wrong old password
  try {
    return await createVault(secret, newPassword);
  } finally {
    secret.fill(0);
  }
}

// ---------------------------------------------------------------------------
// version 2: the app-key path
//
// These are ADDITIVE. Nothing above this line changed behaviour when v2 was
// introduced: a wallet with no app password never reaches any of it.
// ---------------------------------------------------------------------------

/**
 * Encrypt a secret under a FRESH random wallet key, and wrap that wallet key
 * under the app master key.
 *
 * Note the asymmetry with createVault(): the master key is NOT derived here and
 * NOT stored anywhere. It arrives from the session (liveWallet holds it in page
 * memory only) and leaves untouched.
 */
export async function createVaultV2(
  secret: string | Uint8Array,
  masterKey: Uint8Array,
): Promise<VaultRecordV2> {
  const walletKey = generateWalletKey();
  const plaintext = toSecretBytes(secret);
  try {
    const key = await crypto.subtle.importKey('raw', walletKey, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    const iv = randomBytes(IV_LEN);
    const ctBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    const wrapped: WrappedWalletKey = await wrapWalletKey(masterKey, walletKey);
    return {
      version: 2,
      keySource: 'app',
      wrappedKey: wrapped.wrappedKey,
      wrapIv: wrapped.wrapIv,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ctBuffer)),
    };
  } finally {
    zeroKey(walletKey);
    // Same rule as createVault: only a throwaway copy we made is zeroed.
    if (typeof secret === 'string') plaintext.fill(0);
  }
}

/**
 * Decrypt a v2 record with the app master key: unwrap the wallet key, then use
 * it on the secret. THROWS on a wrong master key or a tampered record (both
 * GCM layers authenticate before returning anything).
 */
export async function unlockVaultV2(record: VaultRecordV2, masterKey: Uint8Array): Promise<Uint8Array> {
  validateRecordV2(record);
  const walletKey = await unwrapWalletKey(masterKey, record);
  try {
    const key = await crypto.subtle.importKey('raw', walletKey, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    const iv = base64ToBytes(record.iv);
    const ciphertext = base64ToBytes(record.ciphertext);
    try {
      const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new Uint8Array(plainBuffer);
    } catch {
      throw new Error('Failed to unlock vault: wrong password or corrupted data.');
    }
  } finally {
    zeroKey(walletKey);
  }
}

/** Decrypt a v2 record and UTF-8-decode the result to a string. */
export async function unlockVaultV2String(record: VaultRecordV2, masterKey: Uint8Array): Promise<string> {
  const bytes = await unlockVaultV2(record, masterKey);
  try {
    return new TextDecoder().decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Move a v2 record from one master key to another. This is the whole cost of an
 * app-password change: 32 bytes re-wrapped, the SECRET'S ciphertext and IV
 * copied across untouched, so a change can never damage a seed.
 *
 * VERIFIED BY CONSTRUCTION: the new wrap is opened again with the NEW master
 * key and compared to the wallet key byte for byte before the record is
 * returned. A caller that gets a record back can rely on it opening.
 *
 * THROWS if `oldMasterKey` is wrong (the unwrap fails its auth tag) or if that
 * verification does not match.
 */
export async function rewrapVaultV2(
  record: VaultRecordV2,
  oldMasterKey: Uint8Array,
  newMasterKey: Uint8Array,
): Promise<VaultRecordV2> {
  validateRecordV2(record);
  const walletKey = await unwrapWalletKey(oldMasterKey, record); // throws on a wrong old key
  try {
    const wrapped = await wrapWalletKey(newMasterKey, walletKey);
    const next: VaultRecordV2 = {
      version: 2,
      keySource: 'app',
      wrappedKey: wrapped.wrappedKey,
      wrapIv: wrapped.wrapIv,
      iv: record.iv,
      ciphertext: record.ciphertext,
    };
    const check = await unwrapWalletKey(newMasterKey, next);
    const ok = bytesEqual(check, walletKey);
    zeroKey(check);
    if (!ok) throw new Error('Re-wrap verification failed.');
    return next;
  } finally {
    zeroKey(walletKey);
  }
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/** Sanity-check a v2 record's shape before attempting to use it. */
function validateRecordV2(record: VaultRecordV2): void {
  if (!record || record.version !== 2 || record.keySource !== 'app') {
    throw new Error('Unsupported or malformed vault record.');
  }
  if (
    typeof record.wrappedKey !== 'string' ||
    typeof record.wrapIv !== 'string' ||
    typeof record.iv !== 'string' ||
    typeof record.ciphertext !== 'string'
  ) {
    throw new Error('Malformed vault record: missing wrappedKey/wrapIv/iv/ciphertext.');
  }
}

/** Sanity-check a record's shape before attempting to use it. */
function validateRecord(record: VaultRecord): void {
  if (!record || record.version !== 1 || record.kdf !== 'scrypt') {
    throw new Error('Unsupported or malformed vault record.');
  }
  if (!Number.isInteger(record.N) || record.N < 2 || (record.N & (record.N - 1)) !== 0) {
    throw new Error('Invalid scrypt N (must be a power of two > 1).');
  }
  if (!Number.isInteger(record.r) || record.r < 1 || !Number.isInteger(record.p) || record.p < 1) {
    throw new Error('Invalid scrypt r/p parameters.');
  }
  if (typeof record.salt !== 'string' || typeof record.iv !== 'string' || typeof record.ciphertext !== 'string') {
    throw new Error('Malformed vault record: missing salt/iv/ciphertext.');
  }
}
