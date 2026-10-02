// Fiat display currency: which currency every fiat figure in the wallet is
// shown in, and the conversion + formatting that goes with it.
//
// The gateway's /prices document carries usd, eur and pln per ticker (see
// services/prices.ts). A ticker priced in USD only (the dev path, or the
// satorinet.io SATORIEVR fallback the wallet reads directly) is converted with
// the cross rate implied by the gateway's own multi-currency rows, the same
// rate the gateway itself uses for its custom sources (fx = eur/pln per 1 USD,
// taken from CoinGecko's quotes). When no such rate exists, the figure stays in
// USD and is LABELLED as USD: a USD number is never printed with a € or zł.
//
// Pure and dependency-free, so the formatting and the fallback rules are tested
// directly (fiat.test.ts).

import type { PriceQuote } from './prices';

export type FiatCurrency = 'USD' | 'EUR' | 'PLN';

/** The currencies the user can choose, in the order the setting lists them. */
export const FIAT_CURRENCIES: readonly FiatCurrency[] = ['USD', 'EUR', 'PLN'];

export const DEFAULT_FIAT_CURRENCY: FiatCurrency = 'USD';

export function isFiatCurrency(value: unknown): value is FiatCurrency {
  return typeof value === 'string' && (FIAT_CURRENCIES as readonly string[]).includes(value);
}

/** A stored value read back from disk: anything this build does not offer
 *  (an old 'GBP', garbage) becomes the default rather than a broken label. */
export function normalizeFiatCurrency(value: unknown): FiatCurrency {
  return isFiatCurrency(value) ? value : DEFAULT_FIAT_CURRENCY;
}

/** Units of each non-USD currency per 1 USD. An absent key = no rate known. */
export type FxRates = Partial<Record<Exclude<FiatCurrency, 'USD'>, number>>;

/** A price or an amount together with the currency it is ACTUALLY in, which
 *  may be USD even when the user chose EUR/PLN (see the fallback above). */
export interface FiatValue {
  value: number;
  currency: FiatCurrency;
}

function positive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function quoteField(quote: PriceQuote, currency: FiatCurrency): number | undefined {
  const v = currency === 'USD' ? quote.usd : currency === 'EUR' ? quote.eur : quote.pln;
  return positive(v) ? v : undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The USD cross rates implied by the quote table: for each currency, the
 * median of eur/usd (pln/usd) over the rows that carry both. CoinGecko rows
 * are preferred because they are priced natively in every currency; the
 * gateway's satori/custom rows are themselves derived from that same rate, so
 * they are only used when no CoinGecko row qualifies. Empty when the table has
 * no multi-currency row at all (a dev build with no gateway).
 */
export function deriveFxRates(table: Readonly<Record<string, PriceQuote>>): FxRates {
  const fx: FxRates = {};
  const rows = Object.values(table).filter((q) => q && positive(q.usd));
  for (const currency of ['EUR', 'PLN'] as const) {
    const ratios = (preferCg: boolean) =>
      rows
        .filter((q) => !preferCg || q.source === 'coingecko')
        .map((q) => {
          const v = quoteField(q, currency);
          return v === undefined ? undefined : v / (q.usd as number);
        })
        .filter((r): r is number => r !== undefined && Number.isFinite(r) && r > 0);
    const rate = median(ratios(true)) ?? median(ratios(false));
    if (rate !== undefined) fx[currency] = rate;
  }
  return fx;
}

/**
 * One ticker's unit price in the chosen currency. Order of preference:
 *   1. the quote's own figure in that currency (as the source published it);
 *   2. its USD figure converted with `fx`;
 *   3. its USD figure, labelled USD.
 * Undefined when the quote has no usable price at all.
 */
export function quoteInCurrency(
  quote: PriceQuote | undefined,
  currency: FiatCurrency,
  fx: FxRates,
): FiatValue | undefined {
  if (!quote) return undefined;
  const direct = quoteField(quote, currency);
  if (direct !== undefined) return { value: direct, currency };
  const usd = quoteField(quote, 'USD');
  if (usd === undefined) return undefined;
  return convertUsd(usd, currency, fx);
}

/** A USD figure in the chosen currency, or left in USD (and saying so) when no
 *  rate is known. */
export function convertUsd(usd: number, currency: FiatCurrency, fx: FxRates): FiatValue {
  if (currency === 'USD') return { value: usd, currency: 'USD' };
  const rate = fx[currency];
  return positive(rate) ? { value: usd * rate, currency } : { value: usd, currency: 'USD' };
}

/**
 * The fiat total of several holdings. Every priced holding is expressed in the
 * chosen currency when it can be; if even ONE of them could only be priced in
 * USD, the whole total is computed in USD instead, because adding euros to
 * dollars would be a number in no currency at all. Null when nothing is priced.
 */
export function sumFiat(
  items: ReadonlyArray<{ amount: number; quote: PriceQuote | undefined }>,
  currency: FiatCurrency,
  fx: FxRates,
): FiatValue | null {
  const priced = items
    .map((item) => ({ item, price: quoteInCurrency(item.quote, currency, fx) }))
    .filter((p): p is { item: (typeof items)[number]; price: FiatValue } => p.price !== undefined);
  if (priced.length === 0) return null;
  if (priced.every((p) => p.price.currency === currency)) {
    return { value: priced.reduce((sum, p) => sum + p.item.amount * p.price.value, 0), currency };
  }
  let total = 0;
  for (const { item } of priced) {
    const usd = item.quote ? quoteField(item.quote, 'USD') : undefined;
    if (usd !== undefined) total += item.amount * usd;
  }
  return { value: total, currency: 'USD' };
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: FiatCurrency, fractionDigits: number): Intl.NumberFormat {
  const key = `${currency}:${fractionDigits}`;
  let nf = formatters.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    formatters.set(key, nf);
  }
  return nf;
}

/**
 * A fiat figure with its currency's sign: "$1,234.56", "€1,234.56",
 * "1,234.56 zł". The digits keep the wallet's one number style (en-US grouping
 * and decimal point, like every coin amount beside them); only the sign moves,
 * because złoty is written after the number. A positive value under one cent
 * keeps six decimals so it never collapses to 0.00; a non-finite value reads as
 * zero.
 */
export function formatFiat(value: number, currency: FiatCurrency): string {
  const v = Number.isFinite(value) ? value : 0;
  const digits = v > 0 && v < 0.01 ? 6 : 2;
  const nf = formatterFor(currency, digits);
  if (currency !== 'PLN') return nf.format(v);
  const number = nf
    .formatToParts(v)
    .filter((part) => part.type !== 'currency' && !(part.type === 'literal' && part.value.trim() === ''))
    .map((part) => part.value)
    .join('');
  return `${number}\u00a0zł`;
}

/** Shorthand for a FiatValue. */
export function formatFiatValue(fiat: FiatValue): string {
  return formatFiat(fiat.value, fiat.currency);
}
