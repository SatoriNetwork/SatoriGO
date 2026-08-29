// VaultRecord VERSION 2 — the app-key path (the app-password design notes §3).
//
// The v1 tests live in vault.test.ts and are deliberately untouched: v1 is
// readable forever and its behaviour must not move. Everything here is additive.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { describe, expect, it } from 'vitest';
import {
  createVault,
  createVaultV2,
  isVaultRecordV2,
  rewrapVaultV2,
  unlockVaultString,
  unlockVaultV2,
  unlockVaultV2String,
  type VaultRecordV2,
} from './vault';
import { createAppKeyRecord, bytesEqual, zeroKey } from './appKey';
import { base64ToBytes, bytesToBase64 } from './base64';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const APP_PW = 'one password for the whole wallet';

/** A master key to wrap under, plus a second, unrelated one. */
async function masters(): Promise<{ a: Uint8Array; b: Uint8Array }> {
  const one = await createAppKeyRecord(APP_PW);
  const two = await createAppKeyRecord('a completely different app password');
  return { a: one.masterKey, b: two.masterKey };
}

describe('vault v2: round-trip', () => {
  it('encrypts under a fresh wallet key and decrypts back with the master key', async () => {
    const { a, b } = await masters();
    try {
      const record = await createVaultV2(MNEMONIC, a);
      expect(record.version).toBe(2);
      expect(record.keySource).toBe('app');
      expect(isVaultRecordV2(record)).toBe(true);
      expect(base64ToBytes(record.iv)).toHaveLength(12);
      expect(base64ToBytes(record.wrapIv)).toHaveLength(12);
      // A wrapped 32-byte key is 32 + a 16-byte GCM tag.
      expect(base64ToBytes(record.wrappedKey)).toHaveLength(48);
      // There is NO KDF material in a v2 record: the scrypt cost is paid once,
      // on the app record, not per wallet.
      expect(record).not.toHaveProperty('salt');
      expect(record).not.toHaveProperty('N');

      expect(await unlockVaultV2String(record, a)).toBe(MNEMONIC);
      // The wrong master key never gets past the wrap.
      await expect(unlockVaultV2(record, b)).rejects.toThrow(/wrong app password|corrupted/i);
    } finally {
      zeroKey(a);
      zeroKey(b);
    }
  });

  it('gives a different record every time, for the same secret and key', async () => {
    const { a, b } = await masters();
    try {
      const one = await createVaultV2(MNEMONIC, a);
      const two = await createVaultV2(MNEMONIC, a);
      expect(one.iv).not.toBe(two.iv);
      expect(one.ciphertext).not.toBe(two.ciphertext);
      expect(one.wrappedKey).not.toBe(two.wrappedKey);
      // ...and each still opens.
      expect(await unlockVaultV2String(one, a)).toBe(MNEMONIC);
      expect(await unlockVaultV2String(two, a)).toBe(MNEMONIC);
    } finally {
      zeroKey(a);
      zeroKey(b);
    }
  });

  it('round-trips raw bytes as well as strings', async () => {
    const { a, b } = await masters();
    try {
      const raw = new Uint8Array([0, 1, 2, 250, 251, 255, 0]);
      const record = await createVaultV2(raw, a);
      const back = await unlockVaultV2(record, a);
      expect(bytesEqual(back, raw)).toBe(true);
    } finally {
      zeroKey(a);
      zeroKey(b);
    }
  });

  it('stores only ciphertext: neither the secret nor the wallet key is in the record', async () => {
    const { a, b } = await masters();
    try {
      const record = await createVaultV2(MNEMONIC, a);
      const json = JSON.stringify(record);
      expect(json).not.toContain(MNEMONIC);
      expect(json).not.toContain('abandon');
      expect(json).not.toContain(bytesToBase64(a));
    } finally {
      zeroKey(a);
      zeroKey(b);
    }
  });

  it('detects tampering in EITHER layer', async () => {
    const { a, b } = await masters();
    try {
      const record = await createVaultV2(MNEMONIC, a);
      const ct = base64ToBytes(record.ciphertext);
      ct[0] ^= 0xff;
      await expect(unlockVaultV2({ ...record, ciphertext: bytesToBase64(ct) }, a)).rejects.toThrow(
        /wrong password or corrupted/i,
      );
      const wk = base64ToBytes(record.wrappedKey);
      wk[0] ^= 0xff;
      await expect(unlockVaultV2({ ...record, wrappedKey: bytesToBase64(wk) }, a)).rejects.toThrow(
        /wrong app password|corrupted/i,
      );
    } finally {
      zeroKey(a);
      zeroKey(b);
    }
  });

  it('refuses a malformed v2 record', async () => {
    const { a, b } = await masters();
    try {
      const record = await createVaultV2(MNEMONIC, a);
      await expect(
        unlockVaultV2({ ...record, keySource: 'app+wallet' } as unknown as VaultRecordV2, a),
      ).rejects.toThrow(/Unsupported or malformed/i);
      await expect(
        unlockVaultV2({ ...record, iv: undefined } as unknown as VaultRecordV2, a),
      ).rejects.toThrow(/Malformed vault record/i);
    } finally {
      zeroKey(a);
      zeroKey(b);
    }
  });
});

describe('vault v2: isVaultRecordV2 keeps v1 and v2 apart', () => {
  it('answers false for a v1 record, null and undefined', async () => {
    const v1 = await createVault(MNEMONIC, 'wallet-pw');
    expect(isVaultRecordV2(v1)).toBe(false);
    expect(isVaultRecordV2(null)).toBe(false);
    expect(isVaultRecordV2(undefined)).toBe(false);
    // ...and v1 still reads exactly as it always did.
    expect(await unlockVaultString(v1, 'wallet-pw')).toBe(MNEMONIC);
  });
});

describe('vault v2: rewrap (the whole cost of an app-password change)', () => {
  it('re-wraps the key and copies the SECRET across untouched', async () => {
    const { a, b } = await masters();
    try {
      const record = await createVaultV2(MNEMONIC, a);
      const moved = await rewrapVaultV2(record, a, b);
      // The seed ciphertext is never rewritten: that is what makes a password
      // change unable to corrupt a seed.
      expect(moved.ciphertext).toBe(record.ciphertext);
      expect(moved.iv).toBe(record.iv);
      // Only the 32-byte key moved.
      expect(moved.wrappedKey).not.toBe(record.wrappedKey);
      expect(moved.wrapIv).not.toBe(record.wrapIv);

      expect(await unlockVaultV2String(moved, b)).toBe(MNEMONIC);
      // The OLD master key no longer opens the new record...
      await expect(unlockVaultV2(moved, a)).rejects.toThrow();
      // ...and the ORIGINAL record still opens under the old key: rewrap does
      // not mutate its input.
      expect(await unlockVaultV2String(record, a)).toBe(MNEMONIC);
    } finally {
      zeroKey(a);
      zeroKey(b);
    }
  });

  it('throws (rather than producing a dead record) when the OLD key is wrong', async () => {
    const { a, b } = await masters();
    const third = await createAppKeyRecord('a third app password');
    try {
      const record = await createVaultV2(MNEMONIC, a);
      await expect(rewrapVaultV2(record, b, third.masterKey)).rejects.toThrow(
        /wrong app password|corrupted/i,
      );
      // Nothing changed: the record still opens under its real key.
      expect(await unlockVaultV2String(record, a)).toBe(MNEMONIC);
    } finally {
      zeroKey(a);
      zeroKey(b);
      zeroKey(third.masterKey);
    }
  });

  it('verifies the new wrap by opening it again before returning', async () => {
    const { a, b } = await masters();
    try {
      const record = await createVaultV2(MNEMONIC, a);
      const moved = await rewrapVaultV2(record, a, b);
      // The contract callers rely on: a returned record ALWAYS opens under the
      // new key. (rewrapVaultV2 unwraps its own output and byte-compares before
      // it hands it back; this is that guarantee, observed.)
      expect(await unlockVaultV2String(moved, b)).toBe(MNEMONIC);
    } finally {
      zeroKey(a);
      zeroKey(b);
    }
  });
});
