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
// base64 helpers (no Buffer, no btoa — works identically in browser + node)
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode bytes to a standard (padded) base64 string. */
function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + '=';
  }
  return out;
}

/** Lookup table for base64 decode; -1 = invalid char, -2 = padding. */
const B64_LOOKUP: Int8Array = (() => {
  const t = new Int8Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  t['='.charCodeAt(0)] = -2;
  return t;
})();

/** Decode a standard base64 string to bytes. Throws on malformed input. */
function base64ToBytes(b64: string): Uint8Array {
  // Collect the 6-bit values, ignoring padding.
  const vals: number[] = [];
  for (let i = 0; i < b64.length; i++) {
    const v = B64_LOOKUP[b64.charCodeAt(i)];
    if (v === -1) throw new Error('invalid base64 in vault record');
    if (v === -2) break; // padding: no more data
    vals.push(v);
  }
  const outLen = (vals.length * 6) >> 3;
  const out = new Uint8Array(outLen);
  let bits = 0;
  let buf = 0;
  let o = 0;
  for (let i = 0; i < vals.length; i++) {
    buf = (buf << 6) | vals[i];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

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
// validation
// ---------------------------------------------------------------------------

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
