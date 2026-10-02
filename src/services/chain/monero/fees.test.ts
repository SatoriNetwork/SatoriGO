// fees.test.ts: priority mapping, the 0.05 XMR cap that refuses, and exact
// XMR <-> piconero text at 12 decimals.

import { describe, expect, it } from 'vitest';
import {
  MONERO_DECIMALS,
  MONERO_MAX_FEE_PICO,
  MONERO_PRIORITY_CODE,
  MoneroFeeError,
  PICONERO_PER_XMR,
  assertMoneroFeeSane,
  formatXmr,
  parseXmr,
} from './fees';

describe('priority', () => {
  it('maps to wallet2 / monero-ts MoneroTxPriority codes', () => {
    // monero-ts MoneroTxPriority: DEFAULT 0, UNIMPORTANT 1, NORMAL 2, ELEVATED 3.
    expect(MONERO_PRIORITY_CODE).toEqual({ unimportant: 1, normal: 2, elevated: 3 });
    expect(Object.isFrozen(MONERO_PRIORITY_CODE)).toBe(true);
  });
});

describe('constants', () => {
  it('1 XMR is 1e12 piconero; the cap is 0.05 XMR', () => {
    expect(MONERO_DECIMALS).toBe(12);
    expect(PICONERO_PER_XMR).toBe(10n ** 12n);
    expect(MONERO_MAX_FEE_PICO).toBe(PICONERO_PER_XMR / 20n);
    expect(formatXmr(MONERO_MAX_FEE_PICO)).toBe('0.05');
  });
});

describe('assertMoneroFeeSane', () => {
  it('accepts normal fees up to and including the cap', () => {
    expect(() => assertMoneroFeeSane(1n)).not.toThrow();
    expect(() => assertMoneroFeeSane(30_720_000n)).not.toThrow(); // ~0.00003 XMR, a typical 2-output fee
    expect(() => assertMoneroFeeSane(parseXmr('0.0001'))).not.toThrow();
    expect(() => assertMoneroFeeSane(MONERO_MAX_FEE_PICO)).not.toThrow();
  });

  it('refuses one piconero above the cap, and absurd fees, never clamping', () => {
    for (const fee of [MONERO_MAX_FEE_PICO + 1n, parseXmr('0.1'), parseXmr('1'), 2n ** 64n - 1n]) {
      let err: unknown;
      try {
        assertMoneroFeeSane(fee);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MoneroFeeError);
      expect((err as MoneroFeeError).reason).toBe('above-cap');
      expect((err as MoneroFeeError).actual).toBe(fee);
      expect((err as MoneroFeeError).limit).toBe(MONERO_MAX_FEE_PICO);
    }
  });

  it('the refusal message is user-facing, in XMR, with no em dash', () => {
    try {
      assertMoneroFeeSane(parseXmr('0.2'));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe(
        "Refusing to send: the network fee of 0.2 XMR is above this wallet's cap of 0.05 XMR per transaction.",
      );
      expect((e as Error).message).not.toContain(String.fromCharCode(0x2014)); // no em dash
    }
  });

  it('refuses a zero or negative fee', () => {
    expect(() => assertMoneroFeeSane(0n)).toThrow(MoneroFeeError);
    expect(() => assertMoneroFeeSane(-1n)).toThrow(MoneroFeeError);
  });

  it('refuses a fee that is not a bigint (a number went through a float somewhere)', () => {
    let err: unknown;
    try {
      assertMoneroFeeSane(1000 as unknown as bigint);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MoneroFeeError);
    expect((err as MoneroFeeError).reason).toBe('not-bigint');
  });
});

describe('formatXmr', () => {
  it('is exact at every digit', () => {
    expect(formatXmr(0n)).toBe('0');
    expect(formatXmr(1n)).toBe('0.000000000001');
    expect(formatXmr(PICONERO_PER_XMR)).toBe('1');
    expect(formatXmr(1_500_000_000_000n)).toBe('1.5');
    expect(formatXmr(123_456_789_012_345n)).toBe('123.456789012345');
    expect(formatXmr(-1_000_000_000n)).toBe('-0.001');
  });

  it('stays exact past 2^53 piconero (about 9,007 XMR) and at the uint64 limit', () => {
    expect(formatXmr(9_007_199_254_740_993n)).toBe('9007.199254740993');
    expect(formatXmr(2n ** 64n - 1n)).toBe('18446744.073709551615');
  });
});

describe('parseXmr', () => {
  it('is exact, with no float anywhere', () => {
    expect(parseXmr('1')).toBe(PICONERO_PER_XMR);
    expect(parseXmr('0.000000000001')).toBe(1n);
    expect(parseXmr('.5')).toBe(500_000_000_000n);
    expect(parseXmr('1.')).toBe(PICONERO_PER_XMR);
    expect(parseXmr(' 0.1 ')).toBe(100_000_000_000n);
    // 0.1 + 0.2 is not 0.30000000000000004 here.
    expect(parseXmr('0.3')).toBe(parseXmr('0.1') + parseXmr('0.2'));
    expect(parseXmr('9007.199254740993')).toBe(9_007_199_254_740_993n);
    expect(parseXmr('0')).toBe(0n);
  });

  it('refuses more than 12 decimals', () => {
    expect(() => parseXmr('0.0000000000001')).toThrow(/at most 12/);
    expect(() => parseXmr('1.1234567890123')).toThrow(/at most 12/);
  });

  it('refuses malformed amounts', () => {
    for (const bad of ['', ' ', '.', 'abc', '1e3', '1,000', '-1', '+1', '1.2.3', '0x10', 'Infinity', 'NaN']) {
      expect(() => parseXmr(bad)).toThrow();
    }
  });

  it('refuses an amount larger than uint64 piconero', () => {
    expect(parseXmr('18446744.073709551615')).toBe(2n ** 64n - 1n);
    expect(() => parseXmr('18446744.073709551616')).toThrow(/larger than any Monero amount/);
  });

  it('round-trips with formatXmr', () => {
    for (const s of ['0', '1', '0.5', '0.000000000001', '123.456789012345', '18446744.073709551615']) {
      expect(formatXmr(parseXmr(s))).toBe(s);
    }
  });
});
