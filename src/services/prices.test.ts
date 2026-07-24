import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPrices, PRICE_REFRESH_MS, __resetPricesCacheForTests } from './prices';

// Minimal Response-like stub: only .ok and .json() are used by prices.ts.
function ok(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

// Verified live shapes.
const EVR_BODY = { code: 0, data: [{ last: '0.00002645' }] }; // CoinEx
const SATORINET_BODY = { price: 0.23, source: 'safetrade' }; //  satorinet.io/api/satori-price (PRIMARY)
const SAT_BODY = { at: '1700000000', ticker: { last: '0.23' } }; // SafeTrade (FALLBACK)

// CoinEx v2 shape, same endpoint family as EVR (verified live 2026-07-21).
const RVN_BODY = { code: 0, data: [{ last: '0.003884', market: 'RVNUSDT' }] };

const isCoinex = (url: unknown) => String(url).includes('coinex');
const isSatorinet = (url: unknown) => String(url).includes('satori-price');
// The EVR and RVN tickers share the CoinEx host; the market param tells them apart.
const isEvrTicker = (url: unknown) => isCoinex(url) && String(url).includes('EVRMOREUSDT');
const isRvnTicker = (url: unknown) => isCoinex(url) && String(url).includes('RVNUSDT');

beforeEach(() => {
  __resetPricesCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPrices', () => {
  it('parses EVR (CoinEx) and SATORIEVR (satorinet.io primary) prices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        isCoinex(url) ? ok(EVR_BODY) : isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY),
      ),
    );
    const p = await fetchPrices();
    expect(p.EVR).toBeCloseTo(0.00002645, 10);
    expect(p.SATORIEVR).toBeCloseTo(0.23, 10);
    expect(p.fetchedAt).toBeGreaterThan(0);
  });

  it('falls back to SafeTrade when the primary satorinet price is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (isCoinex(url)) return ok(EVR_BODY);
        if (isSatorinet(url)) throw new Error('satorinet down'); // primary fails
        return ok(SAT_BODY); // SafeTrade fallback succeeds
      }),
    );
    const p = await fetchPrices();
    expect(p.SATORIEVR).toBeCloseTo(0.23, 10);
  });

  it('omits EVR when CoinEx returns a non-zero code (SAT still parses)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        isCoinex(url) ? ok({ code: 1, message: 'err' }) : isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY),
      ),
    );
    const p = await fetchPrices();
    expect(p.EVR).toBeUndefined();
    expect(p.SATORIEVR).toBeCloseTo(0.23, 10);
  });

  it('omits SATORIEVR when BOTH price sources fail; never throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (isCoinex(url)) return ok(EVR_BODY);
        throw new Error('blocked'); // satorinet + SafeTrade both blocked (Cloudflare)
      }),
    );
    const p = await fetchPrices();
    expect(p.EVR).toBeCloseTo(0.00002645, 10);
    expect(p.SATORIEVR).toBeUndefined();
  });

  it('ignores a non-OK / malformed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        isCoinex(url)
          ? ({ ok: false, json: async () => ({}) } as unknown as Response)
          : isSatorinet(url)
          ? ok({ price: 'not-a-number' })
          : ok({ ticker: { last: 'not-a-number' } }),
      ),
    );
    const p = await fetchPrices();
    expect(p.EVR).toBeUndefined();
    expect(p.SATORIEVR).toBeUndefined();
  });

  it('caches a successful result and does not refetch within the window', async () => {
    const spy = vi.fn(async (url: unknown) =>
      isCoinex(url) ? ok(EVR_BODY) : isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY),
    );
    vi.stubGlobal('fetch', spy);
    await fetchPrices();
    await fetchPrices();
    // First call hits CoinEx + satorinet (primary succeeds, no SafeTrade fallback);
    // the second call is served from cache -> exactly 2 fetches total.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns an empty result when fetch is unavailable (jsdom guard)', async () => {
    vi.stubGlobal('fetch', undefined);
    const p = await fetchPrices();
    expect(p).toEqual({ fetchedAt: 0 });
  });

  it('exposes a 60s refresh cadence', () => {
    expect(PRICE_REFRESH_MS).toBe(60_000);
  });

  // --- RVN (Ravencoin) price: CoinEx, same host/endpoint family as EVR ------
  describe('RVN price', () => {
    it('does NOT fetch RVN by default (EVR-only users request no RVN ticker)', async () => {
      const spy = vi.fn(async (url: unknown) =>
        isEvrTicker(url) ? ok(EVR_BODY) : isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY),
      );
      vi.stubGlobal('fetch', spy);
      const p = await fetchPrices();
      expect(p.RVN).toBeUndefined();
      const hitRvnTicker = spy.mock.calls.some(([u]) => isRvnTicker(u));
      expect(hitRvnTicker).toBe(false);
    });

    it('fetches RVN from CoinEx when includeRvn is set', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          if (isEvrTicker(url)) return ok(EVR_BODY);
          if (isRvnTicker(url)) return ok(RVN_BODY);
          if (isSatorinet(url)) return ok(SATORINET_BODY);
          return ok(SAT_BODY);
        }),
      );
      const p = await fetchPrices({ includeRvn: true });
      expect(p.RVN).toBeCloseTo(0.003884, 10);
    });

    it('omits RVN when the CoinEx RVN ticker fails; never throws, EVR unaffected', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          if (isRvnTicker(url)) throw new Error('rvn ticker blocked');
          if (isEvrTicker(url)) return ok(EVR_BODY);
          if (isSatorinet(url)) return ok(SATORINET_BODY);
          return ok(SAT_BODY);
        }),
      );
      const p = await fetchPrices({ includeRvn: true });
      expect(p.RVN).toBeUndefined();
      expect(p.EVR).toBeCloseTo(0.00002645, 10);
    });

    it('omits RVN on a CoinEx error code (code !== 0)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          if (isRvnTicker(url)) return ok({ code: 3008, data: [], message: 'market not found' });
          if (isEvrTicker(url)) return ok(EVR_BODY);
          if (isSatorinet(url)) return ok(SATORINET_BODY);
          return ok(SAT_BODY);
        }),
      );
      const p = await fetchPrices({ includeRvn: true });
      expect(p.RVN).toBeUndefined();
    });

    it('refetches to add RVN even within the cache window (cache lacked RVN)', async () => {
      const spy = vi.fn(async (url: unknown) => {
        if (isEvrTicker(url)) return ok(EVR_BODY);
        if (isRvnTicker(url)) return ok(RVN_BODY);
        if (isSatorinet(url)) return ok(SATORINET_BODY);
        return ok(SAT_BODY);
      });
      vi.stubGlobal('fetch', spy);
      // First call: EVR-only, caches a result WITHOUT RVN.
      const first = await fetchPrices();
      expect(first.RVN).toBeUndefined();
      // Second call within the window but now wanting RVN: must refetch (not serve
      // the RVN-less cache) so switching to an RVN wallet gets a price promptly.
      const second = await fetchPrices({ includeRvn: true });
      expect(second.RVN).toBeCloseTo(0.003884, 10);
    });
  });
});
