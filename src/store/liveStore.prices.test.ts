// loadPrices: how the ONE price fetch lands in the store.
//
// Since 2026-08-21 every price comes from a single call (the Satori GO gateway
// in a gateway build, the direct sources in a dev build), so this covers the
// merge rules the UI depends on:
//   - a ticker the fetch could not fill keeps the value already on screen,
//   - a ticker the wallet has no typed field for is kept anyway (the gateway
//     publishes owner-configured tickers, e.g. BTGS/WJK, and a chain added
//     later must get fiat with no code change here),
//   - the full quote table (usd/eur/pln/change24h/source) is preserved,
//   - a failed fetch is never a wallet error.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchPricesMock } = vi.hoisted(() => ({ fetchPricesMock: vi.fn() }));

vi.mock('../services/prices', () => ({
  PRICE_REFRESH_MS: 60_000,
  fetchPrices: (...args: unknown[]) => fetchPricesMock(...args),
}));

import { useLiveStore } from './liveStore';

/** Build what services/prices.ts hands back from a quote table. */
function result(quotes: Record<string, { usd?: number; eur?: number; pln?: number; change24h?: number; source?: string }>) {
  const flat: Record<string, unknown> = { quotes, changes24h: {}, fetchedAt: Date.now() };
  const changes24h = flat.changes24h as Record<string, number>;
  for (const [ticker, quote] of Object.entries(quotes)) {
    if (quote.usd !== undefined) flat[ticker] = quote.usd;
    if (quote.change24h !== undefined) changes24h[ticker] = quote.change24h;
  }
  return flat;
}

beforeEach(() => {
  fetchPricesMock.mockReset();
  useLiveStore.setState({ prices: {}, priceChanges24h: {}, priceTable: {} });
});

describe('loadPrices', () => {
  it('maps every ticker of one fetch into prices, priceChanges24h and priceTable', async () => {
    fetchPricesMock.mockResolvedValue(
      result({
        EVR: { usd: 0.0142, eur: 0.0131, pln: 0.056, change24h: 1.2, source: 'coingecko' },
        SATORIEVR: { usd: 0.23, change24h: 5.56, source: 'safetrade' },
        RVN: { usd: 0.003884, change24h: -2.9 },
        LTC: { usd: 92.5 },
        BTC: { usd: 62752 },
        DOGE: { usd: 0.069897 },
        ETH: { usd: 3120.5, change24h: 2.05 },
        BNB: { usd: 585.2 },
        EPIX: { usd: 0.0042 },
      }),
    );
    await useLiveStore.getState().loadPrices();
    const s = useLiveStore.getState();
    expect(s.prices).toEqual({
      EVR: 0.0142,
      SATORIEVR: 0.23,
      RVN: 0.003884,
      LTC: 92.5,
      BTC: 62752,
      DOGE: 0.069897,
      ETH: 3120.5,
      BNB: 585.2,
      EPIX: 0.0042,
    });
    expect(s.priceChanges24h).toEqual({ EVR: 1.2, SATORIEVR: 5.56, RVN: -2.9, ETH: 2.05 });
    // The whole quote survives, not just the USD number the UI reads today.
    expect(s.priceTable.EVR).toEqual({ usd: 0.0142, eur: 0.0131, pln: 0.056, change24h: 1.2, source: 'coingecko' });
  });

  it('keeps a ticker the wallet has no typed field for, so a chain added later is priced with no code change', async () => {
    fetchPricesMock.mockResolvedValue(
      result({
        BTGS: { usd: 1.75, change24h: 3.5, source: 'custom' },
        WJK: { usd: 0.5, source: 'custom' },
      }),
    );
    await useLiveStore.getState().loadPrices();
    const s = useLiveStore.getState();
    expect(s.prices.BTGS).toBeCloseTo(1.75, 10);
    expect(s.prices.WJK).toBeCloseTo(0.5, 10);
    expect(s.priceChanges24h.BTGS).toBeCloseTo(3.5, 10);
    expect(s.priceTable.WJK).toEqual({ usd: 0.5, source: 'custom' });
  });

  it('MERGES: a ticker missing from this round keeps the value already on screen', async () => {
    fetchPricesMock.mockResolvedValue(result({ EVR: { usd: 0.0142, change24h: 1.2 }, RVN: { usd: 0.0039 } }));
    await useLiveStore.getState().loadPrices();

    // Next round the source only answered for RVN, at a new price.
    fetchPricesMock.mockResolvedValue(result({ RVN: { usd: 0.0041, change24h: -0.5 } }));
    await useLiveStore.getState().loadPrices();

    const s = useLiveStore.getState();
    expect(s.prices.EVR).toBeCloseTo(0.0142, 10); // kept, not blanked
    expect(s.prices.RVN).toBeCloseTo(0.0041, 10); // updated
    expect(s.priceChanges24h.EVR).toBeCloseTo(1.2, 10); // the chip does not flicker away
    expect(s.priceChanges24h.RVN).toBeCloseTo(-0.5, 10);
  });

  it('an empty result (the fetch failed) changes nothing', async () => {
    fetchPricesMock.mockResolvedValue(result({ EVR: { usd: 0.0142, change24h: 1.2 } }));
    await useLiveStore.getState().loadPrices();
    const before = useLiveStore.getState().prices;

    fetchPricesMock.mockResolvedValue({ quotes: {}, changes24h: {}, fetchedAt: Date.now() });
    await useLiveStore.getState().loadPrices();
    expect(useLiveStore.getState().prices).toEqual(before);
  });

  it('a rejected fetch is swallowed: prices are decorative, never a wallet error', async () => {
    fetchPricesMock.mockRejectedValue(new Error('gateway unreachable'));
    await expect(useLiveStore.getState().loadPrices()).resolves.toBeUndefined();
    expect(useLiveStore.getState().prices).toEqual({});
  });

  it('asks for exactly ONE fetch, and tells it which optional ticker the active chain needs', async () => {
    fetchPricesMock.mockResolvedValue(result({ SATORIEVR: { usd: 0.23 } }));
    await useLiveStore.getState().loadPrices();
    expect(fetchPricesMock).toHaveBeenCalledTimes(1);
    // The default chain is Evrmore, so none of the CoinEx-only markets are
    // wanted. (A gateway build ignores these flags: one document holds every
    // ticker. They keep a DEV build from polling markets nobody is looking at.)
    expect(fetchPricesMock).toHaveBeenCalledWith({
      includeRvn: false,
      includeLtc: false,
      includeBtc: false,
      includeDoge: false,
    });
  });
});
