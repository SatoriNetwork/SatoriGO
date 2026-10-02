import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIAT_CURRENCY,
  FIAT_CURRENCIES,
  convertUsd,
  deriveFxRates,
  formatFiat,
  formatFiatValue,
  isFiatCurrency,
  normalizeFiatCurrency,
  quoteInCurrency,
  sumFiat,
} from './fiat';
import type { PriceQuote } from './prices';

const NBSP = ' ';

// A table shaped like the gateway's /prices document (2026-09): CoinGecko rows
// carry all three currencies, a custom row carries its USD figure plus the
// cross-rate conversions, and the satorinet.io fallback carries USD only.
const TABLE: Record<string, PriceQuote> = {
  BTC: { usd: 80000, eur: 68800, pln: 296000, change24h: 1.5, source: 'coingecko' },
  EVR: { usd: 0.01, eur: 0.0086, pln: 0.037, source: 'coingecko' },
  WJK: { usd: 0.5, eur: 0.43, pln: 1.85, source: 'custom' },
  SATORIEVR: { usd: 0.2, change24h: 3, source: 'satorinet' },
};

describe('the currency list', () => {
  it('offers USD, EUR and PLN with USD as the default', () => {
    expect(FIAT_CURRENCIES).toEqual(['USD', 'EUR', 'PLN']);
    expect(DEFAULT_FIAT_CURRENCY).toBe('USD');
    expect(isFiatCurrency('EUR')).toBe(true);
    expect(isFiatCurrency('GBP')).toBe(false);
    expect(normalizeFiatCurrency('PLN')).toBe('PLN');
    expect(normalizeFiatCurrency('GBP')).toBe('USD');
    expect(normalizeFiatCurrency(undefined)).toBe('USD');
  });
});

describe('formatFiat', () => {
  it('prints each currency with its own sign', () => {
    expect(formatFiat(1234.5, 'USD')).toBe('$1,234.50');
    expect(formatFiat(1234.5, 'EUR')).toBe('€1,234.50');
    expect(formatFiat(1234.5, 'PLN')).toBe(`1,234.50${NBSP}zł`);
  });

  it('keeps six decimals for a positive value under one cent', () => {
    expect(formatFiat(0.000123, 'USD')).toBe('$0.000123');
    expect(formatFiat(0.000123, 'EUR')).toBe('€0.000123');
    expect(formatFiat(0.000123, 'PLN')).toBe(`0.000123${NBSP}zł`);
  });

  it('prints zero, and a non-finite value, as 0.00', () => {
    expect(formatFiat(0, 'USD')).toBe('$0.00');
    expect(formatFiat(Number.NaN, 'EUR')).toBe('€0.00');
    expect(formatFiat(Number.POSITIVE_INFINITY, 'PLN')).toBe(`0.00${NBSP}zł`);
  });

  it('keeps the minus sign on a negative złoty figure', () => {
    expect(formatFiat(-5, 'PLN')).toBe(`-5.00${NBSP}zł`);
  });
});

describe('deriveFxRates', () => {
  it('takes the cross rate from the CoinGecko rows (median)', () => {
    const fx = deriveFxRates(TABLE);
    expect(fx.EUR).toBeCloseTo(0.86, 6);
    expect(fx.PLN).toBeCloseTo(3.7, 6);
  });

  it('falls back to any multi-currency row when no CoinGecko row has one', () => {
    const fx = deriveFxRates({ WJK: TABLE.WJK, SATORIEVR: TABLE.SATORIEVR });
    expect(fx.EUR).toBeCloseTo(0.86, 6);
    expect(fx.PLN).toBeCloseTo(3.7, 6);
  });

  it('is empty when nothing carries a second currency (the dev path)', () => {
    expect(deriveFxRates({ SATORIEVR: TABLE.SATORIEVR, RVN: { usd: 0.02 } })).toEqual({});
    expect(deriveFxRates({})).toEqual({});
  });
});

describe('quoteInCurrency', () => {
  const fx = deriveFxRates(TABLE);

  it('uses the figure the source published in the chosen currency', () => {
    expect(quoteInCurrency(TABLE.BTC, 'EUR', fx)).toEqual({ value: 68800, currency: 'EUR' });
    expect(quoteInCurrency(TABLE.BTC, 'PLN', fx)).toEqual({ value: 296000, currency: 'PLN' });
    expect(quoteInCurrency(TABLE.BTC, 'USD', fx)).toEqual({ value: 80000, currency: 'USD' });
  });

  it('converts a USD-only quote with the cross rate', () => {
    const eur = quoteInCurrency(TABLE.SATORIEVR, 'EUR', fx);
    expect(eur?.currency).toBe('EUR');
    expect(eur?.value).toBeCloseTo(0.172, 9);
    const pln = quoteInCurrency(TABLE.SATORIEVR, 'PLN', fx);
    expect(pln?.currency).toBe('PLN');
    expect(pln?.value).toBeCloseTo(0.74, 9);
  });

  it('stays in USD, and says so, when no rate is known', () => {
    expect(quoteInCurrency(TABLE.SATORIEVR, 'EUR', {})).toEqual({ value: 0.2, currency: 'USD' });
    expect(quoteInCurrency(TABLE.SATORIEVR, 'PLN', { EUR: 0.9 })).toEqual({ value: 0.2, currency: 'USD' });
  });

  it('is undefined for a missing or empty quote', () => {
    expect(quoteInCurrency(undefined, 'USD', fx)).toBeUndefined();
    expect(quoteInCurrency({ change24h: 2 }, 'EUR', fx)).toBeUndefined();
  });
});

describe('convertUsd', () => {
  it('converts with the rate, or keeps USD labelled USD', () => {
    expect(convertUsd(10, 'USD', { EUR: 0.9 })).toEqual({ value: 10, currency: 'USD' });
    expect(convertUsd(10, 'EUR', { EUR: 0.9 })).toEqual({ value: 9, currency: 'EUR' });
    expect(convertUsd(10, 'PLN', { EUR: 0.9 })).toEqual({ value: 10, currency: 'USD' });
    expect(convertUsd(10, 'PLN', { PLN: 0 })).toEqual({ value: 10, currency: 'USD' });
  });
});

describe('sumFiat', () => {
  it('sums in the chosen currency when every row reaches it', () => {
    const fx = deriveFxRates(TABLE);
    const total = sumFiat(
      [
        { amount: 100, quote: TABLE.EVR },
        { amount: 10, quote: TABLE.SATORIEVR },
        { amount: 5, quote: undefined },
      ],
      'EUR',
      fx,
    );
    expect(total?.currency).toBe('EUR');
    expect(total?.value).toBeCloseTo(100 * 0.0086 + 10 * 0.172, 9);
  });

  it('falls back to a USD total when any priced row is USD-only and no rate exists', () => {
    const total = sumFiat(
      [
        { amount: 100, quote: TABLE.EVR },
        { amount: 10, quote: TABLE.SATORIEVR },
      ],
      'EUR',
      {},
    );
    expect(total?.currency).toBe('USD');
    expect(total?.value).toBeCloseTo(100 * 0.01 + 10 * 0.2, 9);
  });

  it('is null when nothing is priced', () => {
    expect(sumFiat([{ amount: 1, quote: undefined }], 'USD', {})).toBeNull();
    expect(sumFiat([], 'PLN', {})).toBeNull();
  });

  it('formats a FiatValue with its own currency', () => {
    expect(formatFiatValue({ value: 2, currency: 'USD' })).toBe('$2.00');
    expect(formatFiatValue({ value: 2, currency: 'PLN' })).toBe(`2.00${NBSP}zł`);
  });
});
