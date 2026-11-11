import { useMemo } from 'react';

import { activeEvmChain, useLiveStore } from '../../store/liveStore';
import { satoriRowIsOfficial } from '../../store/satoriRewards';
import { pricedTickerFor } from '../../services/assetNotes';
import { useSettingsStore } from '../../store/settingsStore';
import { deriveFxRates, quoteInCurrency, type FiatCurrency, type FiatValue, type FxRates } from '../../services/fiat';
import type { PriceQuote } from '../../services/prices';

export interface FiatContext {
  /** The currency the user chose (Settings, Appearance). */
  currency: FiatCurrency;
  /** Cross rates implied by the gateway's quote table (empty without one). */
  fx: FxRates;
  /** One ticker's full quote: the store's quote table, with its flat USD price
   *  folded in (the two agree in the real store; a USD-only entry, such as one
   *  a test seeds, still prices). Undefined when nothing is known. */
  quoteFor(ticker: string): PriceQuote | undefined;
}

/** The fiat display context every screen that shows a fiat figure reads. */
export function useFiat(): FiatContext {
  const currency = useSettingsStore((s) => s.settings.currency);
  const prices = useLiveStore((s) => s.prices);
  const table = useLiveStore((s) => s.priceTable);
  const fx = useMemo(() => deriveFxRates(table), [table]);
  return useMemo(
    () => ({
      currency,
      fx,
      quoteFor: (ticker: string) => {
        const key = ticker.trim().toUpperCase();
        const row = table[key];
        const usd = prices[key];
        if (!row && usd === undefined) return undefined;
        return usd === undefined ? row : { usd, ...row };
      },
    }),
    [currency, fx, prices, table],
  );
}

/** One asset's unit price in the display currency and its 24h move, under the
 *  SAME rule the Home list prices a row by (services/assetNotes pricedTickerFor:
 *  the chain's own coin and the official SATORI, never a name collision). Both
 *  are undefined for an asset the feed does not carry. Used by the screens that
 *  show one asset: its detail screen and Send. */
export function useAssetFiat(name: string, isNative: boolean): { unit: FiatValue | undefined; change24h: number | undefined } {
  const ctx = useFiat();
  const evm = useLiveStore((s) => s.evm);
  const evmTokens = useLiveStore((s) => s.evmTokens);
  const changes = useLiveStore((s) => s.priceChanges24h);
  const official = useMemo(() => satoriRowIsOfficial(activeEvmChain({ evm })?.defaultTokens, evmTokens), [evm, evmTokens]);
  const ticker = pricedTickerFor(name, isNative, official);
  return {
    unit: ticker === null ? undefined : quoteInCurrency(ctx.quoteFor(ticker), ctx.currency, ctx.fx),
    change24h: ticker === null ? undefined : changes[ticker],
  };
}

/** What a typed amount is worth, or null when the text is not a positive number
 *  or the asset has no price. For the line under an amount field. */
export function typedAmountFiat(text: string, unit: FiatValue | undefined): FiatValue | null {
  if (!unit) return null;
  const n = Number(text.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return { value: n * unit.value, currency: unit.currency };
}
