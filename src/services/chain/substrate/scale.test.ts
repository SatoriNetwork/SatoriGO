// scale.test.ts: compact across the four modes, the mortal era, twox128 and
// blake2_128Concat against the known System.Account prefix, the 80-byte
// storage key, and AccountInfo of the two live accounts (56 bytes, u64).

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import {
  ACCOUNT_INFO_BYTES,
  MAX_U64,
  SYSTEM_ACCOUNT_KEY_BYTES,
  SYSTEM_ACCOUNT_PREFIX,
  ScaleError,
  blake2_128Concat,
  compact,
  decodeAccountInfo,
  decodeEra,
  encodeAccountInfo,
  encodeEra,
  hexToBytes0x,
  mortalEra,
  readCompact,
  readU32le,
  readUintLE,
  systemAccountKey,
  twox128,
  u32le,
  uintLE,
  xxhash64,
} from './scale';
import { ss58Decode } from './ss58';
import { ACCOUNT_INFO, ONCHAIN_TRANSFER, PJS_PAYLOADS } from './testing/fixtures';

describe('compact', () => {
  const cases: [bigint, string][] = [
    [0n, '00'],
    [1n, '04'],
    [63n, 'fc'],
    [64n, '0101'],
    [7n, '1c'], // nonce 7 in the fixtures
    [5n, '14'], // tip 5 in the xcheck fixture
    [16_383n, 'fdff'],
    [16_384n, '02000100'],
    [1_000_000n, '02093d00'], // 0.001 TAO in the fixtures
    [41_390n, 'ba860200'], // the on-chain nonce
    [187_825_400n, 'e2f3c72c'], // the on-chain amount
    [1_073_741_823n, 'feffffff'],
    [1_073_741_824n, '0300000040'],
    [MAX_U64, '13ffffffffffffffff'],
    [1n << 64n, '17000000000000000001'],
  ];
  for (const [n, hex] of cases) {
    it(`${n} -> ${hex}`, () => {
      expect(bytesToHex(compact(n))).toBe(hex);
      const back = readCompact(hexToBytes(hex), 0);
      expect(back.value).toBe(n);
      expect(back.next).toBe(hex.length / 2);
    });
  }

  it('accepts a safe integer number, refuses negatives, floats and non-numbers', () => {
    expect(bytesToHex(compact(1_000_000))).toBe('02093d00');
    expect(() => compact(-1n)).toThrow(ScaleError);
    expect(() => compact(-1)).toThrow(ScaleError);
    expect(() => compact(1.5)).toThrow(ScaleError);
    expect(() => compact(Number.MAX_SAFE_INTEGER + 2)).toThrow(ScaleError);
    expect(() => compact('7' as unknown as number)).toThrow(ScaleError);
  });

  it('readCompact refuses truncated data', () => {
    expect(() => readCompact(new Uint8Array(0), 0)).toThrow(ScaleError);
    expect(() => readCompact(hexToBytes('01'), 0)).toThrow(ScaleError);
    expect(() => readCompact(hexToBytes('020900'), 0)).toThrow(ScaleError);
    expect(() => readCompact(hexToBytes('13ffff'), 0)).toThrow(ScaleError);
  });
});

describe('fixed-width integers', () => {
  it('u32le and readU32le', () => {
    expect(bytesToHex(u32le(470))).toBe('d6010000');
    expect(bytesToHex(u32le(1))).toBe('01000000');
    expect(bytesToHex(u32le(0xffff_ffff))).toBe('ffffffff');
    expect(readU32le(hexToBytes('d6010000'), 0)).toBe(470);
    expect(readU32le(hexToBytes('ffffffff'), 0)).toBe(0xffff_ffff);
    expect(() => u32le(-1)).toThrow(ScaleError);
    expect(() => u32le(2 ** 32)).toThrow(ScaleError);
    expect(() => readU32le(hexToBytes('d60100'), 0)).toThrow(ScaleError);
  });

  it('uintLE and readUintLE', () => {
    expect(bytesToHex(uintLE(83_124n, 8))).toBe('b444010000000000');
    expect(readUintLE(hexToBytes('b444010000000000'), 0, 8)).toBe(83_124n);
    expect(readUintLE(hexToBytes('00000000000000000000000000000080'), 0, 16)).toBe(1n << 127n);
    expect(() => uintLE(1n << 64n, 8)).toThrow(ScaleError);
    expect(() => uintLE(-1n, 8)).toThrow(ScaleError);
    expect(() => readUintLE(hexToBytes('b4'), 0, 8)).toThrow(ScaleError);
  });

  it('hexToBytes0x takes both forms and refuses junk', () => {
    expect(bytesToHex(hexToBytes0x('0x0a0b'))).toBe('0a0b');
    expect(bytesToHex(hexToBytes0x('0a0b'))).toBe('0a0b');
    expect(hexToBytes0x('0x').length).toBe(0);
    expect(() => hexToBytes0x('0x0')).toThrow(ScaleError);
    expect(() => hexToBytes0x('0xzz')).toThrow(ScaleError);
    expect(() => hexToBytes0x(null as unknown as string)).toThrow(ScaleError);
  });
});

describe('era', () => {
  it('period 64 at the fixture checkpoints (phase = checkpoint mod 64)', () => {
    for (const p of PJS_PAYLOADS) {
      const era = mortalEra(64, p.checkpointNumber);
      expect(era.period).toBe(64);
      expect(era.phase).toBe(p.era.phase);
      expect(bytesToHex(era.bytes)).toBe(p.era.bytes);
      expect(bytesToHex(encodeEra(64, p.checkpointNumber))).toBe(p.era.bytes);
      const back = decodeEra(era.bytes, 0);
      expect(back).toEqual({ period: 64, phase: p.era.phase, next: 2 });
    }
  });

  it('the on-chain transfer used period 1024, phase 640 (0x0928)', () => {
    expect(decodeEra(hexToBytes('0928'), 0)).toEqual({ period: 1024, phase: 640, next: 2 });
    expect(bytesToHex(encodeEra(1024, 640))).toBe('0928');
    expect(bytesToHex(encodeEra(1024, 9_168_516 - 9_168_516 % 1024 + 640))).toBe('0928');
  });

  it('periods 64 and 128 at several checkpoints round-trip', () => {
    for (const period of [64, 128]) {
      for (const checkpoint of [0, 1, 63, 64, 127, 128, 1000, 9_168_516, 9_168_527, 2 ** 31 - 1]) {
        const era = mortalEra(period, checkpoint);
        expect(era.period).toBe(period);
        expect(era.phase).toBe(checkpoint % period);
        expect(decodeEra(era.bytes, 0)).toEqual({ period, phase: checkpoint % period, next: 2 });
      }
    }
  });

  it('rounds the period to a power of two in [4, 65536] and quantizes above 4096', () => {
    expect(mortalEra(1, 10).period).toBe(4);
    expect(mortalEra(100, 10).period).toBe(128);
    expect(mortalEra(1 << 20, 10).period).toBe(65536);
    const big = mortalEra(65536, 65536 + 33);
    expect(big.phase).toBe(32); // quantize = 16
    expect(decodeEra(big.bytes, 0)).toEqual({ period: 65536, phase: 32, next: 2 });
  });

  it('decodes immortal (0x00) as period 0 and refuses a phase beyond the period', () => {
    expect(decodeEra(hexToBytes('00'), 0)).toEqual({ period: 0, phase: 0, next: 1 });
    // period 4 (enc & 15 == 1) with phase 5: impossible
    expect(() => decodeEra(Uint8Array.of(0x51, 0x00), 0)).toThrow(ScaleError);
    expect(() => decodeEra(new Uint8Array(0), 0)).toThrow(ScaleError);
    expect(() => decodeEra(Uint8Array.of(0x45), 0)).toThrow(ScaleError);
  });

  it('refuses a non-integer or negative period/checkpoint', () => {
    expect(() => mortalEra(0, 1)).toThrow(ScaleError);
    expect(() => mortalEra(64, -1)).toThrow(ScaleError);
    expect(() => mortalEra(64, 1.5)).toThrow(ScaleError);
  });
});

describe('storage hashing', () => {
  it('xxhash64 known answers (seed 0 and 1 of the empty input and of "a")', () => {
    // Reference values of XXH64: "" seed 0 = ef46db3751d8e999, "a" seed 0 = d24ec4f1a98c6e5b.
    expect(xxhash64(new Uint8Array(0)).toString(16)).toBe('ef46db3751d8e999');
    expect(xxhash64(utf8ToBytes('a')).toString(16)).toBe('d24ec4f1a98c6e5b');
  });

  it('twox128("System") and twox128("Account") make the known System.Account prefix', () => {
    expect(bytesToHex(twox128(utf8ToBytes('System')))).toBe('26aa394eea5630e07c48ae0c9558cef7');
    expect(bytesToHex(twox128(utf8ToBytes('Account')))).toBe('b99d880ec681799c0cf30e8886371da9');
    expect(`0x${bytesToHex(twox128(utf8ToBytes('System')))}${bytesToHex(twox128(utf8ToBytes('Account')))}`).toBe(SYSTEM_ACCOUNT_PREFIX);
    // a 40+ byte input exercises the 32-byte stripe loop
    expect(bytesToHex(twox128(utf8ToBytes('SubtensorModule')))).toHaveLength(32);
    expect(bytesToHex(twox128(utf8ToBytes('a'.repeat(45))))).toHaveLength(32);
  });

  it('blake2_128Concat is blake2b-128(key) || key', () => {
    const pub = hexToBytes('66933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972');
    const out = blake2_128Concat(pub);
    expect(out.length).toBe(48);
    expect(bytesToHex(out.slice(16))).toBe(bytesToHex(pub));
    expect(bytesToHex(out.slice(0, 16))).toBe('85eed350b03894f4ee3db867915c8395');
  });

  it('systemAccountKey is 80 bytes of the prefix, blake2_128 and the key, for each fixture account', () => {
    for (const acct of [ACCOUNT_INFO.reference, ACCOUNT_INFO.abandon, ACCOUNT_INFO.absent]) {
      const pub = ss58Decode(acct.address, 42).publicKey;
      const key = systemAccountKey(pub);
      expect(key).toBe(acct.key);
      expect((key.length - 2) / 2).toBe(SYSTEM_ACCOUNT_KEY_BYTES);
      expect(key.startsWith(SYSTEM_ACCOUNT_PREFIX)).toBe(true);
      expect(key.endsWith(bytesToHex(pub))).toBe(true);
    }
    expect(() => systemAccountKey(new Uint8Array(20))).toThrow(ScaleError);
  });
});

describe('decodeAccountInfo', () => {
  it('the reference account at block 9,168,516: nonce 41391, free 112.519492772 TAO, providers 1, new-logic flag', () => {
    const r = ACCOUNT_INFO.reference;
    expect(decodeAccountInfo(r.hex)).toEqual({
      nonce: r.nonce,
      consumers: r.consumers,
      providers: r.providers,
      sufficients: r.sufficients,
      free: r.free,
      reserved: r.reserved,
      frozen: r.frozen,
      flags: r.flags,
    });
    expect(encodeAccountInfo(decodeAccountInfo(r.hex)!)).toBe(r.hex);
  });

  it('the abandon account: 35,639 rao, nonce 7', () => {
    const a = ACCOUNT_INFO.abandon;
    const info = decodeAccountInfo(a.hex)!;
    expect(info.nonce).toBe(7);
    expect(info.free).toBe(35_639n);
    expect(info.providers).toBe(1);
    expect(info.reserved).toBe(0n);
    expect(info.frozen).toBe(0n);
    expect(info.flags).toBe(1n << 127n);
    expect(encodeAccountInfo(info)).toBe(a.hex);
  });

  it('the on-chain sender had nonce 41390 when it signed; the state after the block says 41391', () => {
    expect(decodeAccountInfo(ACCOUNT_INFO.reference.hex)!.nonce).toBe(ONCHAIN_TRANSFER.nonce + 1);
  });

  it('null is "no account" (not a zero row)', () => {
    expect(decodeAccountInfo(null)).toBeNull();
    expect(decodeAccountInfo(ACCOUNT_INFO.absent.hex)).toBeNull();
  });

  it('refuses any length but 56: a u128 balance (80 bytes) and a 57-byte blob', () => {
    expect(ACCOUNT_INFO_BYTES).toBe(56);
    expect(() => decodeAccountInfo(ACCOUNT_INFO.abandon.hex + '00')).toThrow(ScaleError);
    expect(() => decodeAccountInfo(ACCOUNT_INFO.abandon.hex.slice(0, -2))).toThrow(ScaleError);
    // u128 AccountData: 16 + 16 * 4 = 80 bytes
    expect(() => decodeAccountInfo('0x' + '00'.repeat(80))).toThrow(ScaleError);
    expect(() => decodeAccountInfo('0x')).toThrow(ScaleError);
    expect(() => decodeAccountInfo('nonsense')).toThrow(ScaleError);
  });

  it('a balance above 2^53 survives as a bigint', () => {
    const hex = encodeAccountInfo({ nonce: 1, consumers: 0, providers: 1, sufficients: 0, free: MAX_U64, reserved: 1n, frozen: 2n, flags: 0n });
    const info = decodeAccountInfo(hex)!;
    expect(info.free).toBe(MAX_U64);
    expect(info.reserved).toBe(1n);
    expect(info.frozen).toBe(2n);
  });
});
