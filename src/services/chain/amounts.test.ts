import { describe, expect, it } from 'vitest';
import {
  parseAmount,
  formatAmount,
  formatListAmount,
  amountToNumber,
  toBaseUnits,
  maxSafeAmount,
} from './amounts';

// The point of this module is that the send path never passes an amount
// through a float. These tests are written around that: the interesting cases
// are the ones a double gets wrong.
describe('parseAmount', () => {
  it('converts ordinary amounts exactly at 8 decimals', () => {
    expect(parseAmount('1', 8)).toBe(100_000_000n);
    expect(parseAmount('0.00000001', 8)).toBe(1n);
    expect(parseAmount('123.45678901', 8)).toBe(12_345_678_901n);
    expect(parseAmount('0', 8)).toBe(0n);
  });

  it('accepts the loose shapes a text field produces', () => {
    expect(parseAmount('.5', 8)).toBe(50_000_000n);
    expect(parseAmount('1.', 8)).toBe(100_000_000n);
    expect(parseAmount('  1.5  ', 8)).toBe(150_000_000n);
    expect(parseAmount('007', 8)).toBe(700_000_000n);
  });

  // The whole reason this function exists. Through a double these are wrong.
  it('is exact past 2^53 base units, where the old float path lost digits', () => {
    // 2^53 base units is ~90,071,992 coins at 8 decimals: a real number on
    // Dogecoin, whose supply runs to hundreds of billions.
    expect(parseAmount('90071992.54740993', 8)).toBe(9_007_199_254_740_993n);
    expect(parseAmount('123456789012.12345678', 8)).toBe(12_345_678_901_212_345_678n);
    // Proof the old approach could not do this. Written with parseFloat on the
    // SAME text the field would hold, which is literally what the old send path
    // did, and which also keeps the imprecise value out of a source literal.
    const oldWay = (text: string) => BigInt(Math.round(parseFloat(text) * 1e8));
    expect(oldWay('123456789012.12345678')).not.toBe(parseAmount('123456789012.12345678', 8));
    expect(oldWay('90071992.54740993')).not.toBe(parseAmount('90071992.54740993', 8));
  });

  it('handles an 18-decimal chain, where one whole coin exceeds a JS number', () => {
    expect(parseAmount('1', 18)).toBe(10n ** 18n);
    expect(parseAmount('0.000000000000000001', 18)).toBe(1n);
    expect(Number(10n ** 18n) > Number.MAX_SAFE_INTEGER).toBe(true);
  });

  it('refuses more fraction digits than the chain has', () => {
    expect(() => parseAmount('0.000000001', 8)).toThrow(/decimal places/i);
    expect(() => parseAmount('1.5', 0)).toThrow(/whole number/i);
  });

  it('refuses what it cannot read unambiguously', () => {
    expect(() => parseAmount('', 8)).toThrow(/enter an amount/i);
    expect(() => parseAmount('   ', 8)).toThrow(/enter an amount/i);
    expect(() => parseAmount('.', 8)).toThrow(/valid amount/i);
    expect(() => parseAmount('1.2.3', 8)).toThrow(/valid amount/i);
    expect(() => parseAmount('-1', 8)).toThrow(/valid amount/i);
    expect(() => parseAmount('abc', 8)).toThrow(/valid amount/i);
    // Deliberate: both have more than one plausible reading on a send screen.
    expect(() => parseAmount('1e8', 8)).toThrow(/valid amount/i);
    expect(() => parseAmount('1,000', 8)).toThrow(/valid amount/i);
  });

  it('rejects an absurd decimals rather than building a monstrous string', () => {
    expect(() => parseAmount('1', 1000)).toThrow(/unsupported decimals/i);
    expect(() => parseAmount('1', -1)).toThrow(/unsupported decimals/i);
    expect(() => parseAmount('1', 1.5)).toThrow(/unsupported decimals/i);
  });
});

describe('formatAmount', () => {
  it('round-trips with parseAmount', () => {
    for (const text of ['1', '0.00000001', '123.45678901', '90071992.54740993']) {
      expect(formatAmount(parseAmount(text, 8), 8)).toBe(text.replace(/^0+(?=\d)/, ''));
    }
  });

  it('trims trailing zeros by default and keeps them when asked', () => {
    expect(formatAmount(100_000_000n, 8)).toBe('1');
    expect(formatAmount(150_000_000n, 8)).toBe('1.5');
    expect(formatAmount(100_000_000n, 8, { trimZeros: false })).toBe('1.00000000');
  });

  it('formats amounts far beyond a JS number exactly', () => {
    expect(formatAmount(12_345_678_901_212_345_678n, 8)).toBe('123456789012.12345678');
    expect(formatAmount(10n ** 18n, 18)).toBe('1');
  });

  it('pads a value smaller than one base-unit scale', () => {
    expect(formatAmount(1n, 8)).toBe('0.00000001');
    expect(formatAmount(0n, 8)).toBe('0');
  });

  // Rounding up would show money that is not there.
  it('TRUNCATES rather than rounds when the fraction is capped', () => {
    expect(formatAmount(199_999_999n, 8, { maxFractionDigits: 2 })).toBe('1.99');
    expect(formatAmount(199_999_999n, 8, { maxFractionDigits: 0 })).toBe('1');
  });

  it('groups the whole part on request', () => {
    expect(formatAmount(123_456_789_00_000_000n, 8, { grouping: true })).toBe('123,456,789');
  });

  it('handles negatives (a net movement in activity can be negative)', () => {
    expect(formatAmount(-150_000_000n, 8)).toBe('-1.5');
  });

  it('supports a 0-decimals chain', () => {
    expect(formatAmount(42n, 0)).toBe('42');
    expect(parseAmount('42', 0)).toBe(42n);
  });
});

describe('formatListAmount (the asset-list shape: six significant digits, truncated)', () => {
  const E18 = 10n ** 18n;
  it('zero is "0"', () => {
    expect(formatListAmount(0n, 18)).toBe('0');
    expect(formatListAmount(0n, 8)).toBe('0');
  });

  it('an 18-decimal balance just under 1000 shows three fraction digits, truncated, never rounded up', () => {
    // 999.999579999999999979 EPIX: the row that overlapped its price and 24h chip.
    expect(formatListAmount(999_999_579_999_999_999_979n, 18)).toBe('999.999');
    // 999.9999999 must not become 1000.
    expect(formatListAmount(999_999_999_900_000_000_000n, 18)).toBe('999.999');
  });

  it('from a thousand up: two fraction digits with grouping (unchanged shape)', () => {
    expect(formatListAmount(1000n * E18, 18)).toBe('1,000');
    expect(formatListAmount(12_345_678_900_000_000_000_000n, 18)).toBe('12,345.67');
    expect(formatListAmount(100_000_000_000n, 8)).toBe('1,000');
  });

  it('between 1 and 1000: six significant digits', () => {
    expect(formatListAmount(12_345_678_900_000_000_000n, 18)).toBe('12.3456');
    expect(formatListAmount(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatListAmount(100_000_000n, 8)).toBe('1');
  });

  it('below 1: six significant digits after the leading zeros, at most 8 fraction digits', () => {
    expect(formatListAmount(123_456_789_000_000n, 18)).toBe('0.00012345');
    expect(formatListAmount(123_456_789_000_000_000n, 18)).toBe('0.123456');
    expect(formatListAmount(500_000_000_000_000_000n, 18)).toBe('0.5');
    expect(formatListAmount(12_345_678_901_234n, 18)).toBe('0.00001234');
  });

  it('dust below 1e-8 is never printed as 0', () => {
    expect(formatListAmount(1n, 18)).toBe('<0.00000001');
    expect(formatListAmount(9_999_999_999n, 18)).toBe('<0.00000001');
    expect(formatListAmount(10_000_000_000n, 18)).toBe('0.00000001');
    // 8-decimal chains have no dust below their own unit.
    expect(formatListAmount(1n, 8)).toBe('0.00000001');
  });

  it('a 6-decimal token (USDC) is unaffected by the 8-digit cap', () => {
    expect(formatListAmount(1_234_567n, 6)).toBe('1.23456');
    expect(formatListAmount(1n, 6)).toBe('0.000001');
  });
});

describe('amountToNumber', () => {
  it('is exact in the ordinary range', () => {
    expect(amountToNumber(150_000_000n, 8)).toBeCloseTo(1.5, 10);
    expect(amountToNumber(1n, 8)).toBeCloseTo(0.00000001, 12);
  });
});

describe('toBaseUnits (the website-proposed number path)', () => {
  it('matches parseAmount for values a number can carry', () => {
    expect(toBaseUnits(1.5, 8)).toBe(parseAmount('1.5', 8));
    expect(toBaseUnits(0.00000001, 8)).toBe(1n);
  });

  it('refuses past the safe boundary instead of losing precision', () => {
    expect(maxSafeAmount(8)).toBeCloseTo(90_071_992.54740991, 8);
    expect(() => toBaseUnits(maxSafeAmount(8) * 2, 8)).toThrow(/too large/i);
    expect(() => toBaseUnits(NaN, 8)).toThrow(/valid amount/i);
    expect(() => toBaseUnits(Infinity, 8)).toThrow(/valid amount/i);
    expect(() => toBaseUnits(-1, 8)).toThrow(/valid amount/i);
  });

  // The boundary moves with the scale: on an 18-decimal chain a JS number
  // cannot even carry ONE whole coin.
  it('scales its boundary with decimals', () => {
    expect(maxSafeAmount(18)).toBeLessThan(1);
    expect(() => toBaseUnits(1, 18)).toThrow(/too large/i);
  });
});
