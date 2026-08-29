// base64.ts was MOVED out of vault.ts (1.4.0) so appKey.ts could share it.
//
// A move of the encoder that reads every stored vault is exactly the kind of
// change that silently breaks decoding, so this pins it two ways: against fixed
// RFC 4648 vectors, and against the platform's own btoa/atob over random bytes.
// If these pass, every VaultRecord ever written still decodes byte for byte.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';

const enc = (s: string) => new TextEncoder().encode(s);

describe('base64: RFC 4648 vectors', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ];

  it('encodes every vector, padding included', () => {
    for (const [plain, b64] of vectors) {
      expect(bytesToBase64(enc(plain))).toBe(b64);
    }
  });

  it('decodes every vector back to the exact bytes', () => {
    for (const [plain, b64] of vectors) {
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(enc(plain)));
    }
  });
});

describe('base64: agrees with the platform encoder on random bytes', () => {
  it('round-trips 0..64-byte buffers and matches btoa/atob exactly', () => {
    for (let len = 0; len <= 64; len++) {
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      const ours = bytesToBase64(bytes);

      // The platform's answer, built without our table.
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      expect(ours).toBe(btoa(binary));

      // ...and our decoder recovers the original bytes.
      expect(Array.from(base64ToBytes(ours))).toEqual(Array.from(bytes));
    }
  });

  it('handles the 12-byte IV and 16-byte salt sizes the vault actually uses', () => {
    for (const len of [12, 16, 32, 45]) {
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });
});

describe('base64: malformed input', () => {
  it('throws on a character outside the alphabet', () => {
    expect(() => base64ToBytes('Zm9v!')).toThrow(/invalid base64/i);
  });

  it('stops at padding rather than decoding past it', () => {
    expect(Array.from(base64ToBytes('Zg=='))).toEqual([0x66]);
  });
});
