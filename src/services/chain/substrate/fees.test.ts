// fees.test.ts: the 0.01 TAO cap that refuses at 10,000,001 rao, the margin,
// and exact TAO <-> rao text at 9 decimals.

import { describe, expect, it } from 'vitest';
import {
  TAO_FEE_MARGIN_PERMILLE,
  TAO_MAX_FEE_RAO,
  TaoFeeError,
  assertTaoFeeSane,
  formatTao,
  parseTao,
  taoFeeWithMargin,
} from './fees';
import { RAO_PER_TAO, TAO_EXISTENTIAL_DEPOSIT } from './tao';
import { FEE_ANSWERS } from './testing/fixtures';

describe('constants', () => {
  it('1 TAO is 1e9 rao; the cap is 0.01 TAO; the margin is 10 percent', () => {
    expect(RAO_PER_TAO).toBe(10n ** 9n);
    expect(TAO_MAX_FEE_RAO).toBe(10_000_000n);
    expect(formatTao(TAO_MAX_FEE_RAO)).toBe('0.01');
    expect(TAO_FEE_MARGIN_PERMILLE).toBe(100n);
    expect(formatTao(TAO_EXISTENTIAL_DEPOSIT)).toBe('0.0000005');
  });
});

describe('assertTaoFeeSane', () => {
  it("accepts today's fee and everything up to and including the cap", () => {
    expect(() => assertTaoFeeSane(1n)).not.toThrow();
    expect(() => assertTaoFeeSane(FEE_ANSWERS.partialFee)).not.toThrow(); // 83,124 rao measured
    expect(() => assertTaoFeeSane(parseTao('0.000083124'))).not.toThrow();
    expect(() => assertTaoFeeSane(TAO_MAX_FEE_RAO)).not.toThrow();
  });

  it('refuses at 10,000,001 rao, and absurd fees, never clamping', () => {
    for (const fee of [10_000_001n, TAO_MAX_FEE_RAO + 1n, parseTao('0.1'), parseTao('1'), 2n ** 64n - 1n]) {
      let err: unknown;
      try {
        assertTaoFeeSane(fee);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TaoFeeError);
      expect((err as TaoFeeError).reason).toBe('above-cap');
      expect((err as TaoFeeError).actual).toBe(fee);
      expect((err as TaoFeeError).limit).toBe(TAO_MAX_FEE_RAO);
    }
  });

  it('the refusal message is user-facing, in TAO, with no em dash', () => {
    try {
      assertTaoFeeSane(parseTao('0.2'));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe(
        "Refusing to send: the network fee of 0.2 TAO is above this wallet's cap of 0.01 TAO per transaction.",
      );
      expect((e as Error).message).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it('refuses a zero or negative fee', () => {
    expect(() => assertTaoFeeSane(0n)).toThrow(TaoFeeError);
    expect(() => assertTaoFeeSane(-1n)).toThrow(TaoFeeError);
    let err: unknown;
    try {
      assertTaoFeeSane(0n);
    } catch (e) {
      err = e;
    }
    expect((err as TaoFeeError).reason).toBe('not-positive');
  });

  it('refuses a fee that is not a bigint (a number went through a float somewhere)', () => {
    let err: unknown;
    try {
      assertTaoFeeSane(83124 as unknown as bigint);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaoFeeError);
    expect((err as TaoFeeError).reason).toBe('not-bigint');
    expect(() => assertTaoFeeSane('83124' as unknown as bigint)).toThrow(TaoFeeError);
  });
});

describe('taoFeeWithMargin', () => {
  it('adds 10 percent, rounding down', () => {
    expect(taoFeeWithMargin(83_124n)).toBe(91_436n);
    expect(taoFeeWithMargin(0n)).toBe(0n);
    expect(taoFeeWithMargin(1n)).toBe(1n);
    expect(taoFeeWithMargin(10n)).toBe(11n);
  });

  it('refuses a number or a negative', () => {
    expect(() => taoFeeWithMargin(1 as unknown as bigint)).toThrow(TaoFeeError);
    expect(() => taoFeeWithMargin(-1n)).toThrow(TaoFeeError);
  });
});

describe('formatTao / parseTao', () => {
  it('formats exactly at 9 decimals with trailing zeros dropped', () => {
    expect(formatTao(0n)).toBe('0');
    expect(formatTao(1n)).toBe('0.000000001');
    expect(formatTao(500n)).toBe('0.0000005');
    expect(formatTao(83_124n)).toBe('0.000083124');
    expect(formatTao(RAO_PER_TAO)).toBe('1');
    expect(formatTao(1_500_000_000n)).toBe('1.5');
    expect(formatTao(112_519_492_772n)).toBe('112.519492772');
    expect(formatTao(2n ** 64n - 1n)).toBe('18446744073.709551615');
  });

  it('parses exactly, plain decimal only', () => {
    expect(parseTao('1')).toBe(RAO_PER_TAO);
    expect(parseTao('0.001')).toBe(1_000_000n);
    expect(parseTao('.5')).toBe(500_000_000n);
    expect(parseTao('0.000000001')).toBe(1n);
    expect(parseTao('112.519492772')).toBe(112_519_492_772n);
    expect(parseTao('18446744073.709551615')).toBe(2n ** 64n - 1n);
  });

  it('throws on more than 9 decimals, on junk, on an empty string, and above u64', () => {
    expect(() => parseTao('0.0000000001')).toThrow(/at most 9/);
    expect(() => parseTao('')).toThrow();
    expect(() => parseTao('1e9')).toThrow();
    expect(() => parseTao('1,000')).toThrow();
    expect(() => parseTao('abc')).toThrow();
    expect(() => parseTao('18446744073.709551616')).toThrow(/larger than any Bittensor amount/);
  });

  it('round-trips', () => {
    for (const rao of [1n, 500n, 83_124n, 1_000_000n, 187_825_400n, 112_519_492_772n]) {
      expect(parseTao(formatTao(rao))).toBe(rao);
    }
  });
});
