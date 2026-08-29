// The app-password key model (the app-password design notes §3), in isolation.
//
// This module is pure: no storage, no wallet entries, no session. So everything
// here is a direct statement about the CRYPTO — that a wrong password is
// rejected once by the check blob, that a wallet key only unwraps under the
// master key that wrapped it, and that nothing derived here is a function of
// anything but the password and the record.
//
// Real scrypt at N=2^17 runs here. Do NOT lower it to make the suite faster.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { describe, expect, it } from 'vitest';
import {
  APP_KDF,
  APP_KEY_CHECK,
  MASTER_KEY_LEN,
  bytesEqual,
  createAppKeyRecord,
  deriveMasterKey,
  generateWalletKey,
  unwrapWalletKey,
  verifyAppPassword,
  wrapWalletKey,
  zeroKey,
  type AppKeyRecord,
} from './appKey';
import { base64ToBytes, bytesToBase64 } from './base64';

const PW = 'one password for the whole wallet';
const WRONG = 'one password for the whole walle';

describe('appKey: the app record', () => {
  it('is created with the strong scrypt params and a fresh 16-byte salt', async () => {
    const a = await createAppKeyRecord(PW);
    const b = await createAppKeyRecord(PW);
    try {
      // v2 since §13.3: a NEW record wraps a random master key rather than
      // being one derived from the password.
      expect(a.record.version).toBe(2);
      expect(a.record.wrappedMaster.ciphertext).toBeTruthy();
      expect(base64ToBytes(a.record.wrappedMaster.iv)).toHaveLength(12);
      // No recovery code until the user asks for one.
      expect(a.record.recovery).toBeUndefined();
      expect(a.record.kdf).toBe('scrypt');
      expect(a.record.N).toBe(2 ** 17);
      expect(a.record.N).toBe(APP_KDF.N);
      expect(a.record.r).toBe(8);
      expect(a.record.p).toBe(1);
      expect(base64ToBytes(a.record.salt)).toHaveLength(16);
      expect(base64ToBytes(a.record.check.iv)).toHaveLength(12);
      // Same password, different salt => a different record and a different key.
      expect(a.record.salt).not.toBe(b.record.salt);
      expect(a.record.check.ciphertext).not.toBe(b.record.check.ciphertext);
      expect(bytesEqual(a.masterKey, b.masterKey)).toBe(false);
      expect(a.masterKey).toHaveLength(MASTER_KEY_LEN);
    } finally {
      zeroKey(a.masterKey);
      zeroKey(b.masterKey);
    }
  });

  it('holds NO key material: the record never contains the master key', async () => {
    const { record, masterKey } = await createAppKeyRecord(PW);
    try {
      const json = JSON.stringify(record);
      expect(json).not.toContain(bytesToBase64(masterKey));
      expect(json).not.toContain(Array.from(masterKey).map((b) => b.toString(16).padStart(2, '0')).join(''));
      // ...and the check blob is not the constant in the clear either.
      expect(json).not.toContain(APP_KEY_CHECK);
    } finally {
      zeroKey(masterKey);
    }
  });

  it('refuses an empty app password', async () => {
    await expect(createAppKeyRecord('')).rejects.toThrow(/cannot be empty/i);
  });
});

describe('appKey: deriving the master key', () => {
  it('re-derives the SAME master key from the same password + record', async () => {
    const { record, masterKey } = await createAppKeyRecord(PW);
    const again = await deriveMasterKey(record, PW);
    try {
      expect(bytesEqual(again, masterKey)).toBe(true);
    } finally {
      zeroKey(masterKey);
      zeroKey(again);
    }
  });

  it('rejects a wrong password ONCE, via the check blob', async () => {
    const { record, masterKey } = await createAppKeyRecord(PW);
    zeroKey(masterKey);
    await expect(deriveMasterKey(record, WRONG)).rejects.toThrow(/wrong app password/i);
    expect(await verifyAppPassword(record, WRONG)).toBe(false);
    expect(await verifyAppPassword(record, PW)).toBe(true);
  });

  it('rejects a TAMPERED check blob rather than returning a key', async () => {
    const { record, masterKey } = await createAppKeyRecord(PW);
    zeroKey(masterKey);
    const bytes = base64ToBytes(record.check.ciphertext);
    bytes[0] ^= 0xff;
    const tampered: AppKeyRecord = {
      ...record,
      check: { ...record.check, ciphertext: bytesToBase64(bytes) },
    };
    await expect(deriveMasterKey(tampered, PW)).rejects.toThrow(/wrong app password/i);
  });

  it('refuses a malformed or hostile record BEFORE running scrypt', async () => {
    const { record, masterKey } = await createAppKeyRecord(PW);
    zeroKey(masterKey);
    // An absurd N would ask scrypt for a terabyte; it must never be attempted.
    await expect(deriveMasterKey({ ...record, N: 2 ** 30 }, PW)).rejects.toThrow(/Invalid scrypt N/i);
    await expect(deriveMasterKey({ ...record, N: 12345 }, PW)).rejects.toThrow(/Invalid scrypt N/i);
    await expect(deriveMasterKey({ ...record, r: 0 }, PW)).rejects.toThrow(/Invalid scrypt r\/p/i);
    // v1 and v2 are both real; anything else is a record this build cannot
    // read, and guessing at it is how a wrong key gets derived.
    await expect(
      deriveMasterKey({ ...record, version: 3 } as unknown as AppKeyRecord, PW),
    ).rejects.toThrow(/Unsupported or malformed/i);
    // A v2 record with its wrapped master removed is malformed, not "wrong
    // password": there is nothing to unwrap.
    await expect(
      deriveMasterKey({ ...record, wrappedMaster: undefined } as unknown as AppKeyRecord, PW),
    ).rejects.toThrow(/wrapped master key/i);
    await expect(
      deriveMasterKey({ ...record, check: undefined } as unknown as AppKeyRecord, PW),
    ).rejects.toThrow(/missing salt\/check/i);
  });
});

describe('appKey: wrapping wallet keys', () => {
  it('wraps and unwraps a wallet key under the master key', async () => {
    const { masterKey } = await createAppKeyRecord(PW);
    const walletKey = generateWalletKey();
    try {
      expect(walletKey).toHaveLength(MASTER_KEY_LEN);
      const wrapped = await wrapWalletKey(masterKey, walletKey);
      expect(base64ToBytes(wrapped.wrapIv)).toHaveLength(12);
      // The wrap is not the key.
      expect(wrapped.wrappedKey).not.toBe(bytesToBase64(walletKey));
      const back = await unwrapWalletKey(masterKey, wrapped);
      expect(bytesEqual(back, walletKey)).toBe(true);
      zeroKey(back);
    } finally {
      zeroKey(masterKey);
      zeroKey(walletKey);
    }
  });

  it('uses a fresh IV, so the same key wraps differently every time', async () => {
    const { masterKey } = await createAppKeyRecord(PW);
    const walletKey = generateWalletKey();
    try {
      const a = await wrapWalletKey(masterKey, walletKey);
      const b = await wrapWalletKey(masterKey, walletKey);
      expect(a.wrapIv).not.toBe(b.wrapIv);
      expect(a.wrappedKey).not.toBe(b.wrappedKey);
    } finally {
      zeroKey(masterKey);
      zeroKey(walletKey);
    }
  });

  it('refuses to unwrap under a DIFFERENT master key', async () => {
    const one = await createAppKeyRecord(PW);
    const two = await createAppKeyRecord('a completely different app password');
    const walletKey = generateWalletKey();
    try {
      const wrapped = await wrapWalletKey(one.masterKey, walletKey);
      await expect(unwrapWalletKey(two.masterKey, wrapped)).rejects.toThrow(/wrong app password|corrupted/i);
    } finally {
      zeroKey(one.masterKey);
      zeroKey(two.masterKey);
      zeroKey(walletKey);
    }
  });

  it('refuses a tampered wrap (GCM authenticates before it returns anything)', async () => {
    const { masterKey } = await createAppKeyRecord(PW);
    const walletKey = generateWalletKey();
    try {
      const wrapped = await wrapWalletKey(masterKey, walletKey);
      const bytes = base64ToBytes(wrapped.wrappedKey);
      bytes[3] ^= 0x01;
      await expect(
        unwrapWalletKey(masterKey, { ...wrapped, wrappedKey: bytesToBase64(bytes) }),
      ).rejects.toThrow(/corrupted|wrong app password/i);
      await expect(
        unwrapWalletKey(masterKey, { wrappedKey: wrapped.wrappedKey } as never),
      ).rejects.toThrow(/Malformed wrapped wallet key/i);
    } finally {
      zeroKey(masterKey);
      zeroKey(walletKey);
    }
  });
});

describe('appKey: zeroKey / bytesEqual', () => {
  it('zeroKey overwrites in place and tolerates null', () => {
    const k = generateWalletKey();
    zeroKey(k);
    expect(Array.from(k).every((b) => b === 0)).toBe(true);
    expect(() => zeroKey(null)).not.toThrow();
    expect(() => zeroKey(undefined)).not.toThrow();
  });

  it('bytesEqual compares length and content without short-circuiting', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });
});
