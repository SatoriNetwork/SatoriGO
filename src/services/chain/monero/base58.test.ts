// base58.test.ts: Monero's block base58, which is not Bitcoin's.

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { MoneroBase58Error, moneroBase58Decode, moneroBase58Encode } from './base58';

describe('Monero base58', () => {
  it('encodes each full 8-byte block to exactly 11 characters, left-padded with 1', () => {
    expect(moneroBase58Encode(new Uint8Array(8))).toBe('11111111111');
    expect(moneroBase58Encode(new Uint8Array(16))).toBe('1'.repeat(22));
    // 2^64 - 1 is the largest block value.
    expect(moneroBase58Encode(new Uint8Array(8).fill(0xff))).toBe('jpXCZedGfVQ');
  });

  it('uses the fixed widths for a short tail block', () => {
    const widths = [0, 2, 3, 5, 6, 7, 9, 10, 11];
    for (let n = 0; n <= 8; n++) {
      expect(moneroBase58Encode(new Uint8Array(n).fill(0xff))).toHaveLength(widths[n]);
    }
  });

  it('standard (69 bytes) and integrated (77 bytes) payloads are 95 and 106 characters', () => {
    expect(moneroBase58Encode(new Uint8Array(69).fill(7))).toHaveLength(95);
    expect(moneroBase58Encode(new Uint8Array(77).fill(7))).toHaveLength(106);
  });

  it('decodes a published address back to prefix 18 and its public keys', () => {
    // monero-python test_seed.py: spendPub 4ee576f5..., viewPub e1ef99d6...
    const raw = moneroBase58Decode(
      '44cWztNFdAqNnycvZbUoj44vsbAEmKnx9aNgkjHdjtMsBrSeKiY8J4s2raH7EMawA2Fwo9utaRTV7Aw8EcTMNMxhH4YtKdH',
    );
    expect(raw).toHaveLength(69);
    expect(raw[0]).toBe(18);
    expect(bytesToHex(raw.subarray(1, 33))).toBe('4ee576f52b9c6a824a3d5c2832d117177d2bb9992507c2c78788bb8dbaf4b640');
    expect(bytesToHex(raw.subarray(33, 65))).toBe('e1ef99d66312ec0b16b17c66c591ab59594e21621588b63b62fa69fe615a768e');
  });

  it('round-trips every length 0..80 on pseudo-random bytes', () => {
    let seed: Uint8Array = keccak_256(new Uint8Array([1]));
    for (let len = 0; len <= 80; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 32) {
        seed = keccak_256(seed);
        bytes.set(seed.subarray(0, Math.min(32, len - i)), i);
      }
      expect(bytesToHex(moneroBase58Decode(moneroBase58Encode(bytes)))).toBe(bytesToHex(bytes));
    }
    expect(bytesToHex(moneroBase58Decode(moneroBase58Encode(hexToBytes('00ff00ff00'))))).toBe('00ff00ff00');
  });

  it('refuses characters outside the alphabet (0, O, I, l, space)', () => {
    for (const bad of ['0', 'O', 'I', 'l', ' ']) {
      expect(() => moneroBase58Decode('1111111111' + bad)).toThrow(MoneroBase58Error);
    }
  });

  it('refuses a tail block of a width no byte count encodes to (1, 4, 8 characters)', () => {
    for (const tail of ['1', '1111', '11111111']) {
      expect(() => moneroBase58Decode('11111111111' + tail)).toThrow(MoneroBase58Error);
    }
  });

  it('refuses a block whose value overflows its byte count', () => {
    // 11 characters of 'z' is 58^11 - 1, larger than 2^64 - 1.
    expect(() => moneroBase58Decode('zzzzzzzzzzz')).toThrow(/overflows/);
    // A 2-character block holds one byte; 'zz' is 3363.
    expect(() => moneroBase58Decode('zz')).toThrow(/overflows/);
  });
});
