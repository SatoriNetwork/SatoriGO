// The APP PASSWORD's key model (the app-password design notes §3).
//
// SAFETY-CRITICAL. This module owns the top half of a two-level key model:
//
//   app password ──scrypt(N=2^17, app salt)──▶ MASTER KEY (32 bytes, memory only)
//                                                 │ AES-256-GCM wrap
//                                                 ▼
//                          per-wallet WALLET KEY (32 random bytes)
//                                                 │ AES-256-GCM
//                                                 ▼
//                                       the mnemonic / WIF
//
// The bottom half (the wallet key encrypting the actual secret) is vault.ts's
// VaultRecordV2. This file never touches storage, never touches a wallet entry
// and never logs: it only transforms. That makes it unit-testable in isolation,
// which for key-wrapping code is the whole point.
//
// WHY TWO LEVELS rather than deriving each wallet's key from the app password:
//   - ONE scrypt per session. 2^17 is deliberately expensive; deriving it once
//     and unwrapping N cheap keys is the difference between "the wallet opens"
//     and "the wallet opens N times slowly".
//   - Changing the app password re-wraps N 32-byte keys. The seed ciphertexts
//     are never rewritten, so a password change cannot corrupt a seed.
//   - §7's later "extra password on one wallet" wraps the SAME wallet key a
//     second time. No format change, no re-encryption of any secret.
//
// The MASTER KEY is handled as raw bytes (not a non-extractable CryptoKey), and
// zeroKey() overwrites that buffer on lock.
//
// BE PRECISE ABOUT WHAT THAT BUYS, because an earlier version of this comment
// was not: importKey() COPIES the bytes into WebCrypto, so a CryptoKey already
// imported from them keeps working after the JS buffer is zeroed. Zeroing does
// not revoke a key; it only removes one copy. What it does buy is real but
// narrower: the raw 32 bytes stop sitting in a long-lived JS heap object, so
// they are not in a heap snapshot, a crash dump or a DevTools memory profile
// taken after the lock, and no later code path can re-import them. The
// CryptoKeys themselves are per operation and unreferenced the moment the
// operation returns, so the only copies that outlive a lock are ones the
// engine has not collected yet, which JS cannot reach at all.
//
// The approach is deliberate and unchanged: raw bytes plus a per-use importKey
// is still strictly better than holding one long-lived CryptoKey, which JS
// could neither zero NOR drop early.

import { scryptAsync } from '@noble/hashes/scrypt';
import { base64ToBytes, bytesToBase64 } from './base64';

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

/**
 * The single app-password record. Self-describing like a VaultRecord: it holds
 * everything needed to re-derive the master key except the password itself.
 *
 * It contains NO key material. `check` is the encryption of a fixed, public
 * constant under the master key, and exists so a wrong app password is rejected
 * ONCE, up front, instead of producing N confusing per-wallet failures.
 */
export interface AppKeyRecordV1 {
  version: 1;
  kdf: 'scrypt';
  /** scrypt cost parameter (power of two). */
  N: number;
  /** scrypt block-size parameter. */
  r: number;
  /** scrypt parallelization parameter. */
  p: number;
  /** base64 of the 16-byte scrypt salt. */
  salt: string;
  /** AES-256-GCM(masterKey, APP_KEY_CHECK) — the wrong-password detector. */
  check: { iv: string; ciphertext: string };
}

/** A blob sealed under a key derived from ONE secret. */
export interface SealedBlob {
  /** base64 of the 12-byte GCM IV. */
  iv: string;
  /** base64 of the AES-256-GCM ciphertext (tag included). */
  ciphertext: string;
}

/**
 * The RECOVERY CODE's wrap of the master key (the app-password design notes §13).
 *
 * Absent until the user makes a code, which is the only thing that creates it.
 * It holds no key material of its own: a salt, KDF parameters, and the master
 * key sealed under scrypt(code). The code itself is never stored anywhere, in
 * any form, which is the entire point of it.
 */
export interface AppRecoveryBlock {
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64 of the 16-byte scrypt salt for the CODE (never the password's). */
  salt: string;
  /** AES-256-GCM(scrypt(code), masterKey) — the same master key the password
   *  wrap opens, so a code keeps working across a password change. */
  wrappedMaster: SealedBlob;
  /** Epoch ms, for "created on ..." in the UI. Public, no secret in it. */
  createdAt: number;
}

/**
 * v2: THE PASSWORD NO LONGER *IS* THE MASTER KEY, IT WRAPS ONE
 * (the app-password design notes §13.3).
 *
 * The master key is 32 random bytes. The password holds one wrapping of it and
 * an optional recovery code holds another, so:
 *
 *   - a recovery code SURVIVES a password change (the key it wraps is unchanged),
 *     which under v1 was impossible without storing the code;
 *   - a password change re-wraps 32 bytes and writes NO vault record at all,
 *     removing the one operation that could ever corrupt a seed.
 *
 * v1 records are still read, forever, by deriveMasterKey's version branch. An
 * install that never asks for a recovery code is never rewritten.
 */
export interface AppKeyRecordV2 {
  version: 2;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64 of the 16-byte scrypt salt for the PASSWORD. */
  salt: string;
  /** AES-256-GCM(scrypt(password), masterKey). */
  wrappedMaster: SealedBlob;
  /**
   * Kept from v1 with its meaning unchanged: AES-256-GCM(masterKey, APP_KEY_CHECK).
   *
   * The wrap's own GCM tag already rejects a wrong password, so this is not the
   * wrong-password detector here. It is what masterKeyMatchesRecord() opens, and
   * that function is the binding under every cached-master-key safety check in
   * liveWallet.ts. Keeping the blob means none of those had to change.
   */
  check: { iv: string; ciphertext: string };
  /** The recovery code's wrap of the SAME master key. Absent until made. */
  recovery?: AppRecoveryBlock;
}

/** Either shape. Both are read; only v2 is written for a NEW app password. */
export type AppKeyRecord = AppKeyRecordV1 | AppKeyRecordV2;

/** Narrow to the v2 shape. A record with no `version` is neither. */
export function isAppKeyRecordV2(
  record: AppKeyRecord | null | undefined,
): record is AppKeyRecordV2 {
  return !!record && record.version === 2;
}

/** Does this record carry a recovery code? (v1 never can.) */
export function recordHasRecovery(record: AppKeyRecord | null | undefined): boolean {
  return isAppKeyRecordV2(record) && !!record.recovery;
}

/** A wallet key sealed under the master key (lives inside a VaultRecordV2). */
export interface WrappedWalletKey {
  /** base64 of AES-256-GCM(masterKey, walletKey). */
  wrappedKey: string;
  /** base64 of the 12-byte GCM IV used for that wrap. */
  wrapIv: string;
}

/**
 * The known constant `check` encrypts. PUBLIC by design: its only job is to let
 * a wrong password fail the GCM auth tag. It is deliberately NOT derived from
 * anything secret, so the record leaks nothing about the password beyond what
 * any ciphertext under it would.
 */
export const APP_KEY_CHECK = 'satori-go/app-key/v1';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Master key length in bytes (AES-256 => 32). Also the wallet-key length. */
export const MASTER_KEY_LEN = 32;
/** scrypt salt length in bytes. */
const SALT_LEN = 16;
/** AES-GCM IV length in bytes (96-bit nonce, the GCM-recommended size). */
const IV_LEN = 12;

/**
 * Default scrypt parameters for a NEW app-key record. Identical cost to a
 * VaultRecord v1 (N=2^17, ~128 MB, ~100-200 ms): §9's "KDF cost is unchanged,
 * paid once per session instead of once per wallet".
 */
export const APP_KDF = {
  N: 2 ** 17,
  r: 8,
  p: 1,
} as const;

/**
 * Hard ceiling on a STORED record's N. A record is read back from disk, so a
 * corrupted or hostile value must not be handed to scrypt: N=2^30 with r=8 asks
 * for a terabyte and would hang or crash the popup before any auth check could
 * reject it. 2^20 leaves three doublings of headroom above today's default for
 * a future build to raise the cost into, and anything beyond it is refused as a
 * malformed record rather than attempted.
 */
const MAX_STORED_N = 2 ** 20;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function randomBytes(len: number): Uint8Array {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return b;
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Import raw key bytes as a non-extractable AES-GCM CryptoKey. The caller's
 *  buffer is NEVER zeroed here: it belongs to the caller (the session holds the
 *  master key across many operations and zeroes it once, on lock). */
async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== MASTER_KEY_LEN) throw new Error('Invalid key length.');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Overwrite a key buffer in place. Safe to call with null/undefined.
 *
 *  Read the header: this removes ONE copy of the bytes. It does not revoke a
 *  CryptoKey that was already imported from them. */
export function zeroKey(key: Uint8Array | null | undefined): void {
  key?.fill(0);
}

/**
 * Length-independent byte comparison. Used for the verify-before-replace check
 * (§4 rule 3) and for the re-wrap self-check, neither of which is a secret
 * ORACLE for an attacker, but both of which compare secret material — so the
 * comparison does not short-circuit on the first differing byte.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Reject KDF parameters that a stored record must never hand to scrypt. Shared
 *  by the record and by its recovery block, which is derived the same way and is
 *  read back from the same untrusted place. */
function validateKdf(k: { N: number; r: number; p: number; kdf: string }, what: string): void {
  if (k.kdf !== 'scrypt') throw new Error(`Unsupported KDF in the ${what}.`);
  if (!Number.isInteger(k.N) || k.N < 2 || (k.N & (k.N - 1)) !== 0 || k.N > MAX_STORED_N) {
    throw new Error(`Invalid scrypt N in the ${what}.`);
  }
  if (!Number.isInteger(k.r) || k.r < 1 || !Number.isInteger(k.p) || k.p < 1) {
    throw new Error(`Invalid scrypt r/p in the ${what}.`);
  }
}

/** A sealed blob read back from storage must have both halves as strings. */
function validateSealed(blob: SealedBlob | undefined | null, what: string): void {
  if (!blob || typeof blob.iv !== 'string' || typeof blob.ciphertext !== 'string') {
    throw new Error(`Malformed ${what}.`);
  }
}

/** Reject a malformed or hostile app-key record BEFORE it reaches scrypt. */
function validateAppKeyRecord(record: AppKeyRecord): void {
  if (!record || (record.version !== 1 && record.version !== 2)) {
    throw new Error('Unsupported or malformed app password record.');
  }
  validateKdf(record, 'app password record');
  if (typeof record.salt !== 'string' || !record.check) {
    throw new Error('Malformed app password record: missing salt/check.');
  }
  validateSealed(record.check, 'app password record: check blob');
  if (record.version === 2) {
    validateSealed(record.wrappedMaster, 'app password record: wrapped master key');
    if (record.recovery) {
      validateKdf(record.recovery, 'recovery code block');
      if (typeof record.recovery.salt !== 'string') {
        throw new Error('Malformed recovery code block: missing salt.');
      }
      validateSealed(record.recovery.wrappedMaster, 'recovery code block');
    }
  }
}

/** scrypt(password, salt) -> 32 raw master-key bytes. The caller owns them. */
async function scryptMaster(
  password: string,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
): Promise<Uint8Array> {
  const passwordBytes = utf8Encode(password);
  try {
    return await scryptAsync(passwordBytes, salt, { N, r, p, dkLen: MASTER_KEY_LEN });
  } finally {
    passwordBytes.fill(0);
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Create a brand-new app-key record for `password`, and return the master key
 * it derives. The caller owns that buffer and MUST zero it (zeroKey) when the
 * session ends; nothing here retains a reference to it.
 */
export async function createAppKeyRecord(
  password: string,
): Promise<{ record: AppKeyRecordV2; masterKey: Uint8Array }> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('An app password cannot be empty.');
  }
  // A NEW app password gets a v2 record and a RANDOM master key (§13.3). The
  // key is not derived from the password any more: the password wraps it. That
  // is what lets a recovery code outlive a password change, and it is why a
  // password change from here on rewrites no vault record at all.
  const masterKey = randomBytes(MASTER_KEY_LEN);
  try {
    return { record: await sealRecordForPassword(masterKey, password), masterKey };
  } catch (err) {
    // Never hand back a half-built pair: zero the key we are not returning.
    zeroKey(masterKey);
    throw err;
  }
}

/**
 * Build a COMPLETE v2 record that hands `masterKey` back to `password`.
 *
 * Used to create a record, to change the password on one, and to re-key one
 * after a recovery. `recovery` is carried across by the callers that have one,
 * because the master key inside it is the same key: that is the whole reason a
 * code survives a password change.
 */
async function sealRecordForPassword(
  masterKey: Uint8Array,
  password: string,
  recovery?: AppRecoveryBlock,
): Promise<AppKeyRecordV2> {
  if (masterKey.length !== MASTER_KEY_LEN) throw new Error('Invalid master key length.');
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('An app password cannot be empty.');
  }
  const { N, r, p } = APP_KDF;
  const salt = randomBytes(SALT_LEN);
  const passKeyBytes = await scryptMaster(password, salt, N, r, p);
  try {
    const wrappedMaster = await sealUnder(passKeyBytes, masterKey);
    const check = await sealUnder(masterKey, utf8Encode(APP_KEY_CHECK));
    const record: AppKeyRecordV2 = {
      version: 2,
      kdf: 'scrypt',
      N,
      r,
      p,
      salt: bytesToBase64(salt),
      wrappedMaster,
      check,
    };
    if (recovery) record.recovery = recovery;
    return record;
  } finally {
    // The password-derived KEY-ENCRYPTION key is not the master key and nothing
    // outside this function may keep it.
    zeroKey(passKeyBytes);
  }
}

/** AES-256-GCM(keyBytes, plaintext) with a fresh IV, as a storable blob. */
async function sealUnder(keyBytes: Uint8Array, plaintext: Uint8Array): Promise<SealedBlob> {
  const key = await importAesKey(keyBytes);
  const iv = randomBytes(IV_LEN);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ct)) };
}

/** The inverse of sealUnder. THROWS on a wrong key or a tampered blob. */
async function openUnder(keyBytes: Uint8Array, blob: SealedBlob): Promise<Uint8Array> {
  const key = await importAesKey(keyBytes);
  const iv = base64ToBytes(blob.iv);
  const ct = base64ToBytes(blob.ciphertext);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

/** Open a v2 record's `wrappedMaster` with a key derived from `secret` under
 *  `kdf`'s parameters, and prove the result is the master key by opening the
 *  record's own check blob with it. Shared by the password and the code. */
async function unwrapMaster(
  record: AppKeyRecordV2,
  kdf: { N: number; r: number; p: number; salt: string },
  wrapped: SealedBlob,
  secret: string,
): Promise<Uint8Array> {
  const derived = await scryptMaster(secret, base64ToBytes(kdf.salt), kdf.N, kdf.r, kdf.p);
  let masterKey: Uint8Array | null = null;
  try {
    masterKey = await openUnder(derived, wrapped);
    if (masterKey.length !== MASTER_KEY_LEN) throw new Error('bad-length');
    // Belt and braces: the wrap's GCM tag already proves the secret, but a
    // record whose check blob was swapped out would pass here and then fail
    // every masterKeyMatchesRecord() later, which is a confusing way to learn
    // that storage was edited. Fail once, now, where the message is honest.
    const plain = await openUnder(masterKey, record.check);
    const expected = utf8Encode(APP_KEY_CHECK);
    const ok = bytesEqual(plain, expected);
    plain.fill(0);
    expected.fill(0);
    if (!ok) throw new Error('check-mismatch');
    const out = masterKey;
    masterKey = null; // handed to the caller; do not zero it in `finally`
    return out;
  } finally {
    zeroKey(derived);
    zeroKey(masterKey);
  }
}

/**
 * Re-derive the master key for `password` and PROVE it is the right one by
 * decrypting the record's check blob.
 *
 * THROWS on a wrong password (the GCM auth tag fails) or a malformed record.
 * The returned buffer belongs to the caller, who must zero it on lock.
 */
export async function deriveMasterKey(record: AppKeyRecord, password: string): Promise<Uint8Array> {
  validateAppKeyRecord(record);
  if (record.version === 2) {
    // v2: the password does not BECOME the key, it opens the wrap around it.
    try {
      return await unwrapMaster(record, record, record.wrappedMaster, password);
    } catch {
      throw new Error('Wrong app password.');
    }
  }
  const salt = base64ToBytes(record.salt);
  const masterKey = await scryptMaster(password, salt, record.N, record.r, record.p);
  try {
    const key = await importAesKey(masterKey);
    const iv = base64ToBytes(record.check.iv);
    const ct = base64ToBytes(record.check.ciphertext);
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const plain = new Uint8Array(plainBuffer);
    const expected = utf8Encode(APP_KEY_CHECK);
    const ok = bytesEqual(plain, expected);
    plain.fill(0);
    expected.fill(0);
    if (!ok) throw new Error('check-mismatch');
    return masterKey;
  } catch {
    zeroKey(masterKey);
    // Do not leak which check failed or any key material.
    throw new Error('Wrong app password.');
  }
}

/**
 * Does this master key belong to THIS app-key record?
 *
 * SAFETY-CRITICAL, and the reason it exists: a master key is derived once and
 * then cached for the life of a page, while the record it came from lives in
 * shared storage that ANOTHER page can replace (changeAppPassword writes a new
 * salt and a new check blob). A cached key is therefore a claim about a record
 * that may no longer be there, and code that wraps a wallet key under a stale
 * master key produces a wallet nothing can open: the record no longer derives
 * that key, and the v1 record it replaced is gone.
 *
 * So every use of a CACHED key against a record re-establishes the binding by
 * decrypting the record's own check blob under it. No scrypt: this is one
 * AES-GCM open of 36 bytes, cheap enough to do on every wrap.
 *
 * Returns false (never throws) on a wrong key, a malformed record or a tampered
 * check blob.
 *
 * IT BINDS THE KEY TO THE CHECK BLOB, NOT TO THE RECORD, AND THAT IS ONLY HALF
 * THE ANSWER. A record whose `salt` has been replaced while its `check` was kept
 * still passes here: the check blob is what the key opens, and it is unchanged.
 * That is one hostile edit of storage away from a permanent loss, because the
 * salt on disk then derives a different key while a migration wraps a seed under
 * this one. The other half lives in the caller, which remembers the SALT its
 * cached key was derived from and requires it to still be the record's
 * (LiveWalletService.masterKeyBelongsTo). Do not read a `true` from here as
 * "this key belongs to this record" on its own.
 */
export async function masterKeyMatchesRecord(
  record: AppKeyRecord | undefined | null,
  masterKey: Uint8Array | null | undefined,
): Promise<boolean> {
  if (!record || !masterKey) return false;
  try {
    validateAppKeyRecord(record);
    const key = await importAesKey(masterKey);
    const iv = base64ToBytes(record.check.iv);
    const ct = base64ToBytes(record.check.ciphertext);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
    const expected = utf8Encode(APP_KEY_CHECK);
    const ok = bytesEqual(plain, expected);
    plain.fill(0);
    expected.fill(0);
    return ok;
  } catch {
    return false;
  }
}

/** True when `password` is the app password. Verifies and drops the key, so it
 *  never changes session state. */
export async function verifyAppPassword(record: AppKeyRecord, password: string): Promise<boolean> {
  try {
    const key = await deriveMasterKey(record, password);
    zeroKey(key);
    return true;
  } catch {
    return false;
  }
}

/** A fresh random 32-byte wallet key. One per wallet (per seed group). */
export function generateWalletKey(): Uint8Array {
  return randomBytes(MASTER_KEY_LEN);
}

/** Seal a wallet key under the master key. Fresh IV every time. */
export async function wrapWalletKey(
  masterKey: Uint8Array,
  walletKey: Uint8Array,
): Promise<WrappedWalletKey> {
  if (walletKey.length !== MASTER_KEY_LEN) throw new Error('Invalid wallet key length.');
  const key = await importAesKey(masterKey);
  const wrapIv = randomBytes(IV_LEN);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, key, walletKey);
  return { wrappedKey: bytesToBase64(new Uint8Array(ct)), wrapIv: bytesToBase64(wrapIv) };
}

/**
 * Open a wrapped wallet key with the master key. THROWS on a wrong master key
 * or a tampered wrap (GCM verifies before returning anything). The returned
 * buffer is the caller's to zero.
 */
export async function unwrapWalletKey(
  masterKey: Uint8Array,
  wrapped: WrappedWalletKey,
): Promise<Uint8Array> {
  if (typeof wrapped?.wrappedKey !== 'string' || typeof wrapped?.wrapIv !== 'string') {
    throw new Error('Malformed wrapped wallet key.');
  }
  const key = await importAesKey(masterKey);
  const iv = base64ToBytes(wrapped.wrapIv);
  const ct = base64ToBytes(wrapped.wrappedKey);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
  } catch {
    throw new Error('Failed to unwrap the wallet key: wrong app password or corrupted data.');
  }
  if (plain.length !== MASTER_KEY_LEN) {
    plain.fill(0);
    throw new Error('Failed to unwrap the wallet key: wrong length.');
  }
  return plain;
}

// ---------------------------------------------------------------------------
// The recovery code (the app-password design notes §13.5)
// ---------------------------------------------------------------------------
//
// A SECOND FULL-POWER KEY TO THE WALLET. Whoever holds the code does not need
// the password. Everything here is written on that basis: the code is generated
// from the CSPRNG, shown once, never stored in any form, and the only thing
// that survives it is a wrap of the master key that the code alone can open.

/**
 * Crockford's base32 alphabet: no `I`, `L`, `O` or `U`.
 *
 * The first three are excluded because a code gets written on paper and read
 * back: `I`/`l`/`1` and `O`/`0` are the pairs people actually confuse, and
 * leaving them out means a misreading cannot even be encoded. `U` is left out
 * so a random code cannot spell an unfortunate word.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Bytes of entropy in a recovery code. 20 bytes = 160 bits = exactly 32
 *  base32 characters, so the encoding needs no padding and no partial group. */
const RECOVERY_CODE_BYTES = 20;

/** Characters in a normalized code (RECOVERY_CODE_BYTES * 8 / 5). */
export const RECOVERY_CODE_LENGTH = (RECOVERY_CODE_BYTES * 8) / 5;

/** How the code is SHOWN: groups of four, hyphen separated. Purely cosmetic —
 *  the parser ignores every separator, so a user may type it however they
 *  copied it down. */
const RECOVERY_GROUP = 4;

/**
 * A fresh recovery code, formatted for display (`K7QM-4T1B-...`, 8 groups).
 *
 * The return value is the ONLY copy that will ever exist: nothing here writes
 * it anywhere, and the record built from it keeps only a wrap the code opens.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  try {
    // Straight 8-bit -> 5-bit repacking. 20 bytes divides evenly into 32
    // symbols, so there is no remainder to pad and no ambiguity to decode.
    let acc = 0;
    let bits = 0;
    let out = '';
    for (const b of bytes) {
      acc = (acc << 8) | b;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out += CROCKFORD[(acc >>> bits) & 31];
      }
    }
    return formatRecoveryCode(out);
  } finally {
    bytes.fill(0);
  }
}

/** Insert the display separators into a normalized code. */
export function formatRecoveryCode(code: string): string {
  return (code.match(new RegExp(`.{1,${RECOVERY_GROUP}}`, 'g')) ?? []).join('-');
}

/**
 * Fold what the user typed into the canonical form, or null if it cannot be a
 * code at all.
 *
 * FORGIVING ON PURPOSE, and only in ways that cannot change which code was
 * meant: case is ignored, every separator and space is dropped, and the three
 * character pairs Crockford excluded are folded to the character that IS in the
 * alphabet (`I`/`L` -> `1`, `O` -> `0`). A code copied out of a screenshot, read
 * off paper, or pasted with its hyphens all normalize to the same string.
 *
 * It is NOT forgiving about length or about characters outside the alphabet:
 * those mean this is not a code, and saying so beats spending a scrypt to fail.
 */
export function normalizeRecoveryCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const folded = input
    .toUpperCase()
    .replace(/[\s-_.]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (folded.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of folded) if (!CROCKFORD.includes(ch)) return null;
  return folded;
}

/**
 * A record that carries `code` as a second way to its master key.
 *
 * Returns a NEW record; the caller writes it. `masterKey` must be the record's
 * own master key, which is the caller's job to have proved (they either just
 * created it or just unwrapped it with the password).
 *
 * ANY EXISTING RECOVERY BLOCK IS REPLACED, which is what "regenerate" means:
 * the previous code stops opening anything the moment this record is written.
 */
export async function sealRecoveryBlock(
  masterKey: Uint8Array,
  code: string,
  now: number,
): Promise<AppRecoveryBlock> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw new Error('That is not a recovery code.');
  if (masterKey.length !== MASTER_KEY_LEN) throw new Error('Invalid master key length.');
  const { N, r, p } = APP_KDF;
  const salt = randomBytes(SALT_LEN);
  const codeKey = await scryptMaster(normalized, salt, N, r, p);
  try {
    const wrappedMaster = await sealUnder(codeKey, masterKey);
    // PROVE THE CODE OPENS IT BEFORE THE BLOCK IS HANDED BACK. The user is
    // about to be shown this code once and told it is their way back in; a wrap
    // that does not open is a promise broken at the worst possible moment. The
    // key is already in hand, so this costs one AES open, not a second scrypt.
    const proof = await openUnder(codeKey, wrappedMaster);
    const ok = bytesEqual(proof, masterKey);
    zeroKey(proof);
    if (!ok) throw new Error('The recovery code did not verify.');
    return { kdf: 'scrypt', N, r, p, salt: bytesToBase64(salt), wrappedMaster, createdAt: now };
  } finally {
    zeroKey(codeKey);
  }
}

/**
 * `record` with `code` attached as a second way to its master key.
 *
 * The caller must already hold the record's OWN master key, and that is
 * re-proved here rather than trusted: sealing the wrong key under the code
 * would produce a code that opens a key nothing is encrypted to, which is a
 * recovery that silently recovers nothing.
 *
 * ANY EXISTING RECOVERY BLOCK IS REPLACED, which is what "regenerate" means:
 * the previous code stops opening anything the moment this record is written.
 */
export async function withRecoveryCode(
  record: AppKeyRecordV2,
  masterKey: Uint8Array,
  code: string,
  now: number,
): Promise<AppKeyRecordV2> {
  if (!(await masterKeyMatchesRecord(record, masterKey))) {
    throw new Error('That master key does not belong to this app password record.');
  }
  return { ...record, recovery: await sealRecoveryBlock(masterKey, code, now) };
}

/** The same record with no recovery code. The old code stops working once it
 *  is written. */
export function withoutRecoveryCode(record: AppKeyRecordV2): AppKeyRecordV2 {
  const next = { ...record };
  delete next.recovery;
  return next;
}

/**
 * The master key, from the RECOVERY CODE instead of the password.
 *
 * THROWS when the record has no code, when the input is not a code, or when it
 * is the wrong one. The caller owns the returned buffer.
 */
export async function deriveMasterKeyFromRecovery(
  record: AppKeyRecord,
  code: string,
): Promise<Uint8Array> {
  validateAppKeyRecord(record);
  if (!isAppKeyRecordV2(record) || !record.recovery) {
    throw new Error('No recovery code is set on this wallet.');
  }
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw new Error('Wrong recovery code.');
  try {
    return await unwrapMaster(record, record.recovery, record.recovery.wrappedMaster, normalized);
  } catch {
    throw new Error('Wrong recovery code.');
  }
}

/**
 * The same master key, handed to a NEW password.
 *
 * This is what a v2 password change is, in full: one 32-byte re-wrap. No vault
 * record is read and none is written, so the failure mode where changing a
 * password damages a seed does not exist on a v2 record.
 *
 * The recovery block is carried across UNCHANGED and deliberately: it wraps the
 * same master key, so the user's code still works, which is the property §13.2
 * exists to buy.
 */
export async function rewrapAppKeyRecord(
  record: AppKeyRecordV2,
  masterKey: Uint8Array,
  newPassword: string,
): Promise<AppKeyRecordV2> {
  if (!(await masterKeyMatchesRecord(record, masterKey))) {
    throw new Error('That master key does not belong to this app password record.');
  }
  const next = await sealRecordForPassword(masterKey, newPassword, record.recovery);
  // Same reasoning as withRecoveryCode: prove the new password opens the new
  // record before anything is allowed to replace the old one.
  const proof = await deriveMasterKey(next, newPassword);
  const ok = bytesEqual(proof, masterKey);
  zeroKey(proof);
  if (!ok) throw new Error('The new app password did not verify.');
  return next;
}

/**
 * A v2 record for `masterKey` and `password`, with no recovery code.
 *
 * The v1 -> v2 upgrade (§13.4) uses this with a FRESH master key, which is why
 * it does not take the old record: nothing about the old one survives except
 * the wallets, and re-wrapping those is the caller's job (it owns the store).
 */
export async function createAppKeyRecordForMaster(
  masterKey: Uint8Array,
  password: string,
): Promise<AppKeyRecordV2> {
  return sealRecordForPassword(masterKey, password);
}

/** A fresh random master key, for the v1 -> v2 upgrade and for a restore. */
export function generateMasterKey(): Uint8Array {
  return randomBytes(MASTER_KEY_LEN);
}
