import { describe, expect, it } from 'vitest';
import {
  ZAT_PER_ZEC,
  ZCASH_DUST_ZAT,
  ZCASH_MAX_FEE_ZAT,
  ZIP317_GRACE_ACTIONS,
  ZIP317_MARGINAL_FEE,
  ZcashFeeError,
  assertZcashFeeSane,
  formatZec,
  parseZec,
  zip317Fee,
  zip317FeeP2pkh,
} from './fees';

describe('ZIP-317 fee', () => {
  it('constants match ZIP-317 Revision 1', () => {
    expect(ZIP317_MARGINAL_FEE).toBe(5000n);
    expect(ZIP317_GRACE_ACTIONS).toBe(2);
    expect(ZAT_PER_ZEC).toBe(100_000_000n);
  });

  it('is 5000 * max(2, nIn, nOut) across 1..25 inputs and 1..3 outputs', () => {
    for (let nIn = 1; nIn <= 25; nIn++) {
      for (let nOut = 1; nOut <= 3; nOut++) {
        const expected = 5000n * BigInt(Math.max(2, nIn, nOut));
        expect(zip317FeeP2pkh(nIn, nOut)).toBe(expected);
        // The general size form agrees for P2PKH inputs (<= 148 bytes) and
        // P2PKH outputs (34 bytes).
        expect(zip317Fee(148 * nIn, 34 * nOut)).toBe(expected);
        expect(zip317Fee(147 * nIn, 34 * nOut)).toBe(expected);
      }
    }
  });

  it('1 in, 2 out is 10000 zat (the smoke test figure)', () => {
    expect(zip317FeeP2pkh(1, 2)).toBe(10_000n);
  });

  it('the size form charges an oversized input as two actions', () => {
    expect(zip317Fee(151, 34)).toBe(10_000n);
    expect(zip317Fee(151 * 3, 34)).toBe(20_000n);
  });

  it('refuses nonsense counts', () => {
    expect(() => zip317FeeP2pkh(-1, 1)).toThrow();
    expect(() => zip317FeeP2pkh(1.5, 1)).toThrow();
  });
});

describe('dust and the fee cap', () => {
  it('dust is 3 * (100 * (34 + 148) / 1000) = 54 zat', () => {
    expect(ZCASH_DUST_ZAT).toBe(3n * ((100n * (34n + 148n)) / 1000n));
    expect(ZCASH_DUST_ZAT).toBe(54n);
  });

  it('the cap is 0.01 ZEC = 200 logical actions', () => {
    expect(ZCASH_MAX_FEE_ZAT).toBe(1_000_000n);
    expect(zip317FeeP2pkh(200, 1)).toBe(ZCASH_MAX_FEE_ZAT);
    expect(() => assertZcashFeeSane(zip317FeeP2pkh(200, 1))).not.toThrow();
    expect(() => assertZcashFeeSane(zip317FeeP2pkh(201, 1))).toThrow(ZcashFeeError);
  });

  it('refuses zero, negative and number fees', () => {
    expect(() => assertZcashFeeSane(0n)).toThrow(/positive/);
    expect(() => assertZcashFeeSane(-1n)).toThrow(/positive/);
    expect(() => assertZcashFeeSane(10000 as unknown as bigint)).toThrow(/valid amount/);
    try {
      assertZcashFeeSane(2_000_000n);
    } catch (err) {
      expect((err as ZcashFeeError).reason).toBe('above-cap');
      expect((err as Error).message).toContain('0.02 ZEC');
      expect((err as Error).message).not.toMatch(/—/);
    }
  });
});

describe('ZEC text', () => {
  it('formats exactly', () => {
    expect(formatZec(150_000_000n)).toBe('1.5');
    expect(formatZec(1n)).toBe('0.00000001');
    expect(formatZec(10_000n)).toBe('0.0001');
    expect(formatZec(0n)).toBe('0');
  });

  it('parses exactly and refuses more than 8 decimals', () => {
    expect(parseZec('1.5')).toBe(150_000_000n);
    expect(parseZec('0.00000001')).toBe(1n);
    expect(parseZec(' 0.001 ')).toBe(100_000n);
    expect(() => parseZec('0.000000001')).toThrow(/at most 8/);
    expect(() => parseZec('1e8')).toThrow();
    expect(() => parseZec('')).toThrow();
  });

  it('refuses more than the supply', () => {
    expect(parseZec('21000000')).toBe(21_000_000n * ZAT_PER_ZEC);
    expect(() => parseZec('21000000.00000001')).toThrow(/more ZEC than can exist/);
  });
});
