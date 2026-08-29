// THE ENCRYPTED BACKUP FILE (the app-password design notes §13.7).
//
// One file holding the whole `liveWallets` store: every wallet entry and its
// vault record, names, order, address counts, and the app-key record itself. It
// is the only route that survives losing the computer, which is the half a
// recovery code cannot answer (§13.6).
//
// SAFETY-CRITICAL, and narrow on purpose. This module transforms bytes: it
// never reads storage, never writes storage, and knows nothing about wallets
// beyond "the store is a JSON value". Deciding what to do with a restored store
// belongs to LiveWalletService, which owns the compare-and-swap write.
//
// WHY THE OUTER ENCRYPTION EXISTS AT ALL, given the vaults inside are already
// encrypted:
//   - `passwordless` wallets hold a seed under an EMPTY passphrase, so their
//     vault is plaintext in every sense that matters. A plain file would put
//     those seeds on disk in the clear, in a file people mail to themselves.
//   - Names, addresses, balances-by-implication and the shape of someone's
//     holdings are private even when the keys are not reachable.
//
// WHY ITS OWN PASSWORD RATHER THAN THE APP PASSWORD: the file exists so that a
// forgotten app password is survivable. Encrypting it with the thing that was
// forgotten would make it useless in precisely the case it is for.

import { scryptAsync } from '@noble/hashes/scrypt';
import { base64ToBytes, bytesToBase64 } from './base64';

/** Marks a file as ours before a single byte of it is trusted. */
export const BACKUP_FORMAT = 'satori-go-backup';

/** Envelope version. Bumped only for a shape the reader below cannot read. */
export const BACKUP_VERSION = 1;

/**
 * The file, exactly as it is written.
 *
 * IT NAMES NOTHING (§13.7). No wallet names, no addresses, not even how many
 * wallets are inside: those appear only after a successful decrypt, on the
 * confirmation step. Someone who finds the file learns that it is a Satori GO
 * backup and when it was made, and nothing else.
 */
export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** ISO 8601, so the user can tell two files apart without opening either. */
  createdAt: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  /** base64 of the 12-byte AES-GCM IV. */
  iv: string;
  /** base64 of AES-256-GCM(scrypt(password), JSON payload). */
  ciphertext: string;
}

/** What the ciphertext holds. Versioned separately from the envelope so the
 *  payload can grow without the file becoming unreadable. */
interface BackupPayload<S> {
  v: 1;
  store: S;
}

/**
 * The KDF for the file password, deliberately the SAME cost as the app
 * password's (N=2^17, ~128 MB). A backup file is an offline target: whoever has
 * it can attack it forever with no lockout and no rate limit, so this is the
 * one place where the cost is the entire defence for a human-chosen password.
 */
const BACKUP_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;

/** Hard ceiling on a STORED N, for the same reason appKey.ts has one: the
 *  parameters come out of a file someone else may have written, and N=2^30
 *  would hang the popup before any authentication could reject it. */
const MAX_STORED_N = 2 ** 20;

const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;

function randomBytes(len: number): Uint8Array {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return b;
}

async function fileKey(
  password: string,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(password);
  try {
    return await scryptAsync(bytes, salt, { N, r, p, dkLen: KEY_LEN });
  } finally {
    bytes.fill(0);
  }
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Thrown when the file is not a backup at all, as distinct from a backup with
 *  the wrong password. The two are different problems and the UI must not
 *  report "wrong password" for a photo of a cat. */
export class NotABackupFileError extends Error {
  constructor(message = 'That file is not a Satori GO backup.') {
    super(message);
    this.name = 'NotABackupFileError';
  }
}

/** Thrown when the file IS a backup and the password does not open it. */
export class WrongBackupPasswordError extends Error {
  constructor(message = 'Wrong password for this backup file.') {
    super(message);
    this.name = 'WrongBackupPasswordError';
  }
}

/**
 * Parse and shape-check a file WITHOUT the password.
 *
 * Everything a caller may learn before decrypting: that it is ours, and when it
 * was made. Returns null rather than throwing, because "the user picked the
 * wrong file" is an ordinary thing to happen and not an error condition.
 */
export function inspectBackup(text: string): { createdAt: string; version: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const env = parsed as Partial<BackupEnvelope>;
  if (!env || env.format !== BACKUP_FORMAT) return null;
  if (typeof env.version !== 'number' || !Number.isFinite(env.version)) return null;
  if (typeof env.iv !== 'string' || typeof env.ciphertext !== 'string') return null;
  if (!env.kdf || env.kdf.name !== 'scrypt' || typeof env.kdf.salt !== 'string') return null;
  return {
    createdAt: typeof env.createdAt === 'string' ? env.createdAt : '',
    version: env.version,
  };
}

/**
 * Encrypt `store` into a backup file.
 *
 * `now` is passed in rather than read from the clock so the caller owns the
 * timestamp and the function stays a pure transform, which is what makes it
 * testable without freezing time.
 */
export async function createBackup<S>(store: S, password: string, now: Date): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('A backup password cannot be empty.');
  }
  const { N, r, p } = BACKUP_KDF;
  const salt = randomBytes(SALT_LEN);
  const key = await fileKey(password, salt, N, r, p);
  try {
    const payload: BackupPayload<S> = { v: 1, store };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    let ct: ArrayBuffer;
    const iv = randomBytes(IV_LEN);
    try {
      ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(key), plaintext);
    } finally {
      // The serialized store held every vault record and, for a passwordless
      // wallet, a seed. Do not leave that buffer behind.
      plaintext.fill(0);
    }
    const envelope: BackupEnvelope = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: now.toISOString(),
      kdf: { name: 'scrypt', N, r, p, salt: bytesToBase64(salt) },
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ct)),
    };
    return `${JSON.stringify(envelope, null, 2)}\n`;
  } finally {
    key.fill(0);
  }
}

/**
 * Open a backup file. THROWS NotABackupFileError or WrongBackupPasswordError.
 *
 * The returned store is whatever was put in, unvalidated as wallet data: this
 * module cannot know what a wallet looks like. The caller validates before it
 * writes, and it must, because a backup file is data from outside the wallet.
 */
export async function readBackup<S>(
  text: string,
  password: string,
): Promise<{ store: S; createdAt: string }> {
  const head = inspectBackup(text);
  if (!head) throw new NotABackupFileError();
  if (head.version > BACKUP_VERSION) {
    throw new NotABackupFileError(
      'This backup was written by a newer version of Satori GO. Update, then restore it.',
    );
  }
  const env = JSON.parse(text) as BackupEnvelope;
  const { N, r, p } = env.kdf;
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > MAX_STORED_N) {
    throw new NotABackupFileError('This backup file is malformed.');
  }
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) {
    throw new NotABackupFileError('This backup file is malformed.');
  }
  const key = await fileKey(password, base64ToBytes(env.kdf.salt), N, r, p);
  let plain: Uint8Array;
  try {
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(env.iv) },
      await aesKey(key),
      base64ToBytes(env.ciphertext),
    );
    plain = new Uint8Array(buf);
  } catch {
    throw new WrongBackupPasswordError();
  } finally {
    key.fill(0);
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(plain)) as BackupPayload<S>;
    if (!payload || payload.v !== 1 || !payload.store) {
      throw new NotABackupFileError('This backup file is malformed.');
    }
    return { store: payload.store, createdAt: env.createdAt };
  } finally {
    plain.fill(0);
  }
}

/** The name the file is offered under. Dated, because the first thing anyone
 *  needs from a folder of these is which one is the newest. */
export function backupFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `satori-go-backup-${stamp}.json`;
}
