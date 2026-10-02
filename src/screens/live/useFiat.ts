import { useMemo } from 'react';

import { useLiveStore } from '../../store/liveStore';
import { useSettingsStore } from '../../store/settingsStore';
import { deriveFxRates, type FiatCurrency, type FxRates } from '../../services/fiat';
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
