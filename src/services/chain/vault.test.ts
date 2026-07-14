// Tests for the encrypted seed vault.
//
// These run in the default `node` vitest environment. src/test/setup.ts already
// assigns Node's WebCrypto to globalThis.crypto when crypto.subtle is missing,
// but we defensively ensure it here too so this file is self-contained.
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { describe, it, expect } from 'vitest';
import { scryptAsync } from '@noble/hashes/scrypt';
import {
  createVault,
  unlockVault,
  unlockVaultString,
  changeVaultPassword,
  DEFAULT_KDF,
  type VaultRecord,
} from './vault';

/**
 * Build a VaultRecord with EXPLICIT scrypt params, mirroring the production
 * createVault encryption path but without pinning to DEFAULT_KDF. Used to forge
 * a record written under the *previous* default (N=2**16) so the backward-compat
 * test can prove unlockVault honours the record's stored N/r/p.
 */
async function createVaultWithParams(
  secret: string,
  password: string,
  params: { N: number; r: number; p: number },
): Promise<VaultRecord> {
  const { N, r, p } = params;
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const dk = await scryptAsync(new TextEncoder().encode(password), salt, { N, r, p, dkLen: 32 });
  const key = await crypto.subtle.importKey('raw', dk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(secret),
  );
  return {
    version: 1,
    kdf: 'scrypt',
    N,
    r,
    p,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ct)),
  };
}

// A canonical BIP39 mnemonic (all-"abandon" + "about") — a realistic secret.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse battery staple';

describe('vault: round-trip', () => {
  it('1. createVault then unlockVaultString returns the exact mnemonic', async () => {
    const record = await createVault(MNEMONIC, PASSWORD);
    const recovered = await unlockVaultString(record, PASSWORD);
    expect(recovered).toBe(MNEMONIC);

    // Record shape sanity + the exact strong scrypt params.
    expect(record.version).toBe(1);
    expect(record.kdf).toBe('scrypt');
    expect(record.N).toBe(2 ** 17);
    expect(record.r).toBe(8);
    expect(record.p).toBe(1);
    expect(record.N).toBe(DEFAULT_KDF.N);
  });
});

describe('vault: backward compatibility with older KDF params', () => {
  it('1b. a record created with the OLD params (N=2**16) still unlocks correctly', async () => {
    // Simulate a vault written before DEFAULT_KDF.N was raised to 2**17. We build
    // the record with explicit N=2**16 (the previous default) so this test proves
    // that unlockVault honours the record's stored params, not DEFAULT_KDF.
    const record = await createVaultWithParams(MNEMONIC, PASSWORD, { N: 2 ** 16, r: 8, p: 1 });
    expect(record.N).toBe(2 ** 16);
    expect(record.N).not.toBe(DEFAULT_KDF.N); // confirm it differs from today's default

    const recovered = await unlockVaultString(record, PASSWORD);
    expect(recovered).toBe(MNEMONIC);
  });
});

describe('vault: wrong password', () => {
  it('2. unlockVault rejects on a wrong password (no garbage returned)', async () => {
    const record = await createVault(MNEMONIC, PASSWORD);
    await expect(unlockVault(record, 'wrong password')).rejects.toThrow();
  });
});

describe('vault: ciphertext hygiene', () => {
  it('3. serialized record contains neither the plaintext secret nor the password', async () => {
    const record = await createVault(MNEMONIC, PASSWORD);
    const json = JSON.stringify(record);
    expect(json).not.toContain(MNEMONIC);
    expect(json).not.toContain(PASSWORD);
    // Also ensure no obvious sub-phrase of the mnemonic leaks.
    expect(json).not.toContain('abandon');
    expect(json).not.toContain('about');
  });
});

describe('vault: uniqueness', () => {
  it('4. encrypting the same secret+password twice yields different salt, iv, and ciphertext', async () => {
    const a = await createVault(MNEMONIC, PASSWORD);
    const b = await createVault(MNEMONIC, PASSWORD);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);

    // Both must still decrypt to the same plaintext.
    expect(await unlockVaultString(a, PASSWORD)).toBe(MNEMONIC);
    expect(await unlockVaultString(b, PASSWORD)).toBe(MNEMONIC);
  });
});

describe('vault: tamper detection', () => {
  it('5. flipping a byte in the ciphertext makes unlock throw (GCM integrity)', async () => {
    const record = await createVault(MNEMONIC, PASSWORD);

    // Decode base64 -> flip one byte -> re-encode. We reproduce a minimal base64
    // round-trip here so the test does not depend on vault internals.
    const tampered: VaultRecord = { ...record, ciphertext: flipOneBase64Byte(record.ciphertext) };
    expect(tampered.ciphertext).not.toBe(record.ciphertext);

    await expect(unlockVault(tampered, PASSWORD)).rejects.toThrow();
  });
});

describe('vault: changeVaultPassword', () => {
  it('6. old password no longer unlocks, new password does, wrong old rejects', async () => {
    const OLD = PASSWORD;
    const NEW = 'a brand new stronger password';
    const record = await createVault(MNEMONIC, OLD);

    // Wrong old password must reject and NOT produce a new record.
    await expect(changeVaultPassword(record, 'not the old one', NEW)).rejects.toThrow();

    const rotated = await changeVaultPassword(record, OLD, NEW);

    // New password unlocks the rotated record.
    expect(await unlockVaultString(rotated, NEW)).toBe(MNEMONIC);
    // Old password no longer unlocks the rotated record.
    await expect(unlockVault(rotated, OLD)).rejects.toThrow();
  });
});

describe('vault: binary secret', () => {
  it('7. a Uint8Array seed round-trips to identical bytes', async () => {
    // A realistic 64-byte BIP39 seed's worth of random bytes.
    const seed = new Uint8Array(64);
    crypto.getRandomValues(seed);

    const record = await createVault(seed, PASSWORD);
    const recovered = await unlockVault(record, PASSWORD);

    expect(recovered.length).toBe(seed.length);
    expect(Array.from(recovered)).toEqual(Array.from(seed));
  });
});

// --- test helper: flip a byte inside a base64 blob, returning valid base64 ---
function flipOneBase64Byte(b64: string): string {
  const bytes = base64ToBytes(b64);
  bytes[0] ^= 0xff; // flip the first byte
  return bytesToBase64(bytes);
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
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
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const outLen = (clean.length * 6) >> 3;
  const out = new Uint8Array(outLen);
  let bits = 0;
  let buf = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    buf = (buf << 6) | B64_CHARS.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}
