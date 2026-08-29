import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchDirectPrices,
  fetchGatewayPrices,
  SATORINET_PRICE_URL,
  fetchPrices,
  parseCoinexTicker,
  parseGatewayPrices,
  toPercent,
  PRICE_REFRESH_MS,
  PRICED_TICKERS,
  __resetPricesCacheForTests,
} from './prices';
import { HAS_GATEWAY, gatewayHeaders } from './gateway';

// Minimal Response-like stub: only .ok and .json() are used by prices.ts.
function ok(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

// Verified live shapes.
// satorinet.io/api/satori-price (PRIMARY) — change_percent is a DECORATED STRING
// ("+5.56%"), verified live 2026-08-19, not the bare number the name suggests.
const SATORINET_BODY = { price: 0.23, source: 'safetrade', change_percent: '+5.56%' };
// Catch-all body the stubs answer to any OTHER request with (the old SafeTrade
// ticker shape). No code path reads it any more: the dev path's SafeTrade
// fallback went with the `safe.trade` host permission (2026-08-21).
const SAT_BODY = { at: '1700000000', ticker: { last: '0.23' } };

// CoinEx v2 shape (verified live 2026-07-21; open/period added 2026-08-19 —
// the API carries no percent field, so the 24h move is derived from open/last).
const RVN_BODY = {
  code: 0,
  data: [{ last: '0.003884', open: '0.004', market: 'RVNUSDT', period: 86400 }],
};

const isCoinex = (url: unknown) => String(url).includes('coinex');
const isSatorinet = (url: unknown) => String(url).includes('satori-price');
const isRvnTicker = (url: unknown) => isCoinex(url) && String(url).includes('RVNUSDT');
// Any request that looks like an EVR market on any host. EVR HAS NO SOURCE on
// the DIRECT path: CoinEx delisted it (the API answers "market EVRMOREUSDT not
// found"), so the wallet must not poll for it there. (The gateway path does
// quote EVR, via CoinGecko server-side.)
const looksLikeEvrTicker = (url: unknown) => /EVR/i.test(String(url)) && !isSatorinet(url);

beforeEach(() => {
  __resetPricesCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The gateway path: ONE request for every price, in every build.
// ---------------------------------------------------------------------------

const GATEWAY = 'https://gateway.test';

/** The contract's response shape (docs: `GET <gateway>/prices`). */
const GATEWAY_BODY = {
  fetchedAt: 1_755_000_000_000,
  ttlSec: 60,
  prices: {
    EVR: { usd: 0.0142, eur: 0.0131, pln: 0.056, change24h: 1.2 },
    RVN: { usd: 0.003884, eur: 0.0036, pln: 0.0154, change24h: -2.9 },
    SATORIEVR: { usd: 0.23, eur: 0.21, pln: 0.9, change24h: 5.56 },
    LTC: { usd: 92.5, eur: 85.1, pln: 362.4, change24h: 0.4 },
    BTC: { usd: 62752, eur: 57800, pln: 246000, change24h: null },
    DOGE: { usd: 0.069897, eur: 0.064, pln: 0.274, change24h: -1.1 },
    ETH: { usd: 3120.5, eur: 2870, pln: 12250, change24h: 2.05 },
    BNB: { usd: 585.2, eur: 538, pln: 2295, change24h: -0.3 },
    EPIX: { usd: 0.0042, eur: 0.0039, pln: 0.0165, change24h: 8.8 },
  },
  sources: {
    coingecko: { ok: true, at: 1_755_000_000_000, error: null },
    satori: { ok: true, at: 1_755_000_000_000, source: 'safetrade', error: null },
  },
};

describe('gateway prices (the release shape: one host, every build)', () => {
  it('asks <gateway>/prices exactly once and contacts no exchange directly', async () => {
    const spy = vi.fn(async () => ok(GATEWAY_BODY));
    vi.stubGlobal('fetch', spy);
    await fetchGatewayPrices(GATEWAY);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe(`${GATEWAY}/prices`);
    expect(String(url)).not.toMatch(/coinex|safe\.trade|satorinet/);
    // The client token rides along exactly as the EVM routes send it. In tests
    // no token is configured, so this is {} — the assertion is that whatever
    // gatewayHeaders() decides is what goes on the wire.
    expect(init?.headers).toEqual(gatewayHeaders(undefined, GATEWAY));
  });

  it('maps every ticker of the contract into its price field and its 24h change', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(GATEWAY_BODY)));
    const p = await fetchGatewayPrices(GATEWAY);
    expect(p.EVR).toBeCloseTo(0.0142, 10);
    expect(p.RVN).toBeCloseTo(0.003884, 10);
    expect(p.SATORIEVR).toBeCloseTo(0.23, 10);
    expect(p.LTC).toBeCloseTo(92.5, 10);
    expect(p.BTC).toBeCloseTo(62752, 10);
    expect(p.DOGE).toBeCloseTo(0.069897, 10);
    // The EVM natives ride along so an EVM balance can show fiat.
    expect(p.ETH).toBeCloseTo(3120.5, 10);
    expect(p.BNB).toBeCloseTo(585.2, 10);
    expect(p.EPIX).toBeCloseTo(0.0042, 10);
    expect(p.changes24h.SATORIEVR).toBeCloseTo(5.56, 10);
    expect(p.changes24h.RVN).toBeCloseTo(-2.9, 10);
    expect(p.changes24h.ETH).toBeCloseTo(2.05, 10);
    expect(p.fetchedAt).toBeGreaterThan(0);
    // Every ticker this build knows about is covered by the fixture.
    for (const t of PRICED_TICKERS) expect(p.quotes[t], t).toBeDefined();
  });

  it('keeps the WHOLE quote table, including tickers this build has no field for', () => {
    // The owner configures per-ticker sources in the panel, so the response can
    // carry tickers a shipped wallet has never heard of. They must survive into
    // the store, so a chain added later is priced with no code change here.
    const p = parseGatewayPrices(
      {
        prices: {
          BTGS: { usd: 1.75, eur: 1.61, pln: 6.9, change24h: 3.5, source: 'custom' },
          WJK: { usd: 0.5, change24h: null, source: 'custom' },
          EVR: { usd: 0.0142, change24h: 1.2, source: 'coingecko' },
        },
      },
      123,
    );
    expect(p.quotes.BTGS).toEqual({ usd: 1.75, eur: 1.61, pln: 6.9, change24h: 3.5, source: 'custom' });
    expect(p.quotes.WJK).toEqual({ usd: 0.5, source: 'custom' });
    expect(p.quotes.EVR.source).toBe('coingecko');
    expect(p.changes24h.BTGS).toBeCloseTo(3.5, 10);
    // Readable by name off the flat map too, without a typed field existing.
    expect((p as unknown as Record<string, number>).BTGS).toBeCloseTo(1.75, 10);
  });

  it('omits a MISSING ticker rather than inventing one (the store then keeps its previous value)', () => {
    const p = parseGatewayPrices({ prices: { EVR: { usd: 0.0142 } } }, 1);
    expect(p.EVR).toBeCloseTo(0.0142, 10);
    expect(p.RVN).toBeUndefined();
    expect(p.SATORIEVR).toBeUndefined();
    expect(p.quotes.RVN).toBeUndefined();
  });

  it('treats change24h: null as unknown, never as a flat 0', () => {
    const p = parseGatewayPrices({ prices: { BTC: { usd: 62752, change24h: null } } }, 1);
    expect(p.BTC).toBeCloseTo(62752, 10);
    expect(p.changes24h.BTC).toBeUndefined();
    expect('change24h' in p.quotes.BTC).toBe(false);
  });

  it('ignores junk entries and junk fields instead of failing the whole document', () => {
    const p = parseGatewayPrices(
      {
        prices: {
          EVR: { usd: 0.0142, change24h: 1.2, someFutureField: { nested: true } },
          RVN: { usd: 'not-a-number' },
          LTC: null,
          BTC: 'nope',
          DOGE: { usd: -1 },
        },
        somethingNew: 42,
      },
      1,
    );
    expect(p.EVR).toBeCloseTo(0.0142, 10);
    expect(p.RVN).toBeUndefined();
    expect(p.LTC).toBeUndefined();
    expect(p.BTC).toBeUndefined();
    expect(p.DOGE).toBeUndefined();
    expect(Object.keys(p.quotes)).toEqual(['EVR']);
  });

  it('returns an EMPTY result on a non-OK response, a network error or a malformed body; never throws', async () => {
    for (const stub of [
      async () => ({ ok: false, json: async () => ({}) }) as unknown as Response,
      async () => {
        throw new Error('gateway unreachable');
      },
      async () => ok({ nope: true }),
      async () => ok(null),
    ]) {
      vi.stubGlobal('fetch', vi.fn(stub));
      const p = await fetchGatewayPrices(GATEWAY);
      expect(p.quotes).toEqual({});
      expect(p.changes24h).toEqual({});
      expect(p.EVR).toBeUndefined();
      expect(p.SATORIEVR).toBeUndefined();
      vi.unstubAllGlobals();
    }
  });

  it('SATORIEVR fallback: when the gateway answer carries no SATORIEVR, reads satorinet.io directly for that ONE ticker', async () => {
    // The gateway fetches from a datacenter egress that SafeTrade's and
    // satorinet.io's Cloudflare edges answer with 403 (2026-08-21); the wallet on
    // the user's IP gets through. satorinet.io is a host every manifest keeps.
    const { SATORIEVR: _omitted, ...withoutSatori } = GATEWAY_BODY.prices;
    void _omitted;
    const spy = vi.fn(async (url: unknown) =>
      isSatorinet(url) ? ok(SATORINET_BODY) : ok({ ...GATEWAY_BODY, prices: withoutSatori }),
    );
    vi.stubGlobal('fetch', spy);
    const p = await fetchGatewayPrices(GATEWAY);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String((spy.mock.calls[1] as unknown[])[0])).toBe(SATORINET_PRICE_URL);
    expect(p.SATORIEVR).toBeCloseTo(0.23, 10);
    expect(p.changes24h.SATORIEVR).toBeCloseTo(5.56, 6);
    expect(p.quotes.SATORIEVR?.source).toBe('satorinet');
    // Nothing else was touched by the fallback.
    expect(p.EVR).toBeCloseTo(0.0142, 10);
    expect(p.BTC).toBe(62752);
  });

  it('SATORIEVR fallback: runs when the gateway itself is unreachable, and is the ONLY thing that does', async () => {
    const spy = vi.fn(async (url: unknown) => {
      if (isSatorinet(url)) return ok(SATORINET_BODY);
      throw new Error('gateway unreachable');
    });
    vi.stubGlobal('fetch', spy);
    const p = await fetchGatewayPrices(GATEWAY);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(Object.keys(p.quotes)).toEqual(['SATORIEVR']);
    expect(p.SATORIEVR).toBeCloseTo(0.23, 10);
    expect(p.EVR).toBeUndefined();
    expect(spy.mock.calls.map((c) => String((c as unknown[])[0]))).not.toContainEqual(expect.stringMatching(/coinex|safe\.trade|safetrade\.com/));
  });

  it('SATORIEVR fallback: NOT taken when the gateway already carries SATORIEVR (one request, as the release shape promises)', async () => {
    const spy = vi.fn(async () => ok(GATEWAY_BODY));
    vi.stubGlobal('fetch', spy);
    const p = await fetchGatewayPrices(GATEWAY);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(p.quotes.SATORIEVR?.source).toBeUndefined();
  });

  it('this test run builds the DEV shape, so fetchPrices() takes the direct path', () => {
    // Guards the branch the rest of this file exercises: vitest.config.ts leaves
    // __EVM_GATEWAY_URL__ empty unless EVM_GATEWAY_URL is set, and the gateway
    // branch is compiled out of the build when it is empty.
    expect(HAS_GATEWAY).toBe(process.env.EVM_GATEWAY_URL !== undefined && process.env.EVM_GATEWAY_URL !== '');
  });
});

// ---------------------------------------------------------------------------
// The direct path: only a build with NO gateway configured (development).
// ---------------------------------------------------------------------------

describe('fetchPrices (direct sources: no gateway configured)', () => {
  it('parses SATORIEVR from the satorinet.io primary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => (isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY))),
    );
    const p = await fetchPrices();
    expect(p.SATORIEVR).toBeCloseTo(0.23, 10);
    expect(p.fetchedAt).toBeGreaterThan(0);
  });

  // Regression guard for the delisting: a dead market must not be polled once a
  // minute forever. If a future EVR source is added, this test is the place to
  // say so deliberately rather than let a URL creep back in.
  it('never requests an EVR ticker, and never reports an EVR price', async () => {
    const spy = vi.fn(async (url: unknown) => (isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY)));
    vi.stubGlobal('fetch', spy);
    const p = await fetchPrices({ includeRvn: true });
    expect(p.EVR).toBeUndefined();
    expect(spy.mock.calls.some(([u]) => looksLikeEvrTicker(u))).toBe(false);
  });

  it('omits SATORIEVR when satorinet.io fails (no SafeTrade fallback since the safe.trade host permission went, 2026-08-21); never throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('blocked');
      }),
    );
    const p = await fetchPrices();
    expect(p.SATORIEVR).toBeUndefined();
    expect(p.EVR).toBeUndefined();
  });

  it('ignores a non-OK / malformed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        isSatorinet(url) ? ok({ price: 'not-a-number' }) : ok({ ticker: { last: 'not-a-number' } }),
      ),
    );
    const p = await fetchPrices();
    expect(p.SATORIEVR).toBeUndefined();
  });

  it('caches a successful result and does not refetch within the window', async () => {
    const spy = vi.fn(async (url: unknown) => (isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY)));
    vi.stubGlobal('fetch', spy);
    await fetchPrices();
    await fetchPrices();
    // First call hits satorinet only (primary succeeds, so no SafeTrade fallback
    // and no EVR ticker); the second is served from cache -> exactly 1 fetch.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns an empty result when fetch is unavailable (jsdom guard)', async () => {
    vi.stubGlobal('fetch', undefined);
    const p = await fetchPrices();
    expect(p).toEqual({ quotes: {}, changes24h: {}, fetchedAt: 0 });
  });

  it('exposes a 60s refresh cadence', () => {
    expect(PRICE_REFRESH_MS).toBe(60_000);
  });

  // --- 24h change ------------------------------------------------------------
  describe('24h change', () => {
    it("parses the aggregator's decorated change_percent for SATORIEVR", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => (isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY))),
      );
      const p = await fetchPrices();
      expect(p.changes24h.SATORIEVR).toBeCloseTo(5.56, 10);
    });

    it('reports NO change when the aggregator omits it (never a 0 standing in for unknown)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => (isSatorinet(url) ? ok({ price: 0.23 }) : ok(SAT_BODY))),
      );
      const p = await fetchPrices();
      expect(p.SATORIEVR).toBeCloseTo(0.23, 10);
      expect(p.changes24h.SATORIEVR).toBeUndefined();
    });


    it('derives the RVN change from the CoinEx open/last pair', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          if (isRvnTicker(url)) return ok(RVN_BODY);
          if (isSatorinet(url)) return ok(SATORINET_BODY);
          return ok(SAT_BODY);
        }),
      );
      const p = await fetchPrices({ includeRvn: true });
      // (0.003884 - 0.004) / 0.004 = -2.9%
      expect(p.changes24h.RVN).toBeCloseTo(-2.9, 6);
    });

    it('parses a CoinEx ticker: price always, change only over a real 24h period', () => {
      expect(parseCoinexTicker(RVN_BODY)?.price).toBeCloseTo(0.003884, 10);
      // No `open`: a price, no change.
      expect(parseCoinexTicker({ code: 0, data: [{ last: '2', period: 86400 }] })).toEqual({
        price: 2,
      });
      // A SHORTER window must not be labelled 24h.
      expect(
        parseCoinexTicker({ code: 0, data: [{ last: '2', open: '1', period: 3600 }] }),
      ).toEqual({ price: 2 });
      // Malformed / error shapes stay undefined, exactly as before.
      expect(parseCoinexTicker({ code: 3008, data: [] })).toBeUndefined();
      expect(parseCoinexTicker(null)).toBeUndefined();
      expect(parseCoinexTicker({ code: 0, data: [{ last: 'nope' }] })).toBeUndefined();
    });

    it('accepts both the decorated string and a bare number as a percent', () => {
      expect(toPercent('+5.56%')).toBeCloseTo(5.56, 10);
      expect(toPercent('-1.2%')).toBeCloseTo(-1.2, 10);
      expect(toPercent(' 0% ')).toBe(0); // a flat day is a real answer, not "unknown"
      expect(toPercent(2.4)).toBe(2.4);
      expect(toPercent('n/a')).toBeUndefined();
      expect(toPercent(undefined)).toBeUndefined();
      expect(toPercent(NaN)).toBeUndefined();
    });
  });

  // --- the optional CoinEx tickers -------------------------------------------
  describe('optional tickers (RVN / LTC / BTC / DOGE)', () => {
    const coinexBody = (market: string, last: string) => ({
      code: 0,
      data: [{ last, market, period: 86400 }],
    });
    const marketOf = (url: unknown) => /market=([A-Z]+)USDT/.exec(String(url))?.[1];

    it('fetches NONE of them by default (a user who never touches them requests no ticker)', async () => {
      const spy = vi.fn(async (url: unknown) => (isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY)));
      vi.stubGlobal('fetch', spy);
      const p = await fetchPrices();
      expect(p.RVN).toBeUndefined();
      expect(p.LTC).toBeUndefined();
      expect(p.BTC).toBeUndefined();
      expect(p.DOGE).toBeUndefined();
      expect(spy.mock.calls.some(([u]) => isCoinex(u))).toBe(false);
    });

    it('fetches exactly the requested market, from CoinEx', async () => {
      const spy = vi.fn(async (url: unknown) => {
        const m = marketOf(url);
        if (m) return ok(coinexBody(`${m}USDT`, '1.5'));
        if (isSatorinet(url)) return ok(SATORINET_BODY);
        return ok(SAT_BODY);
      });
      vi.stubGlobal('fetch', spy);
      const p = await fetchPrices({ includeLtc: true });
      expect(p.LTC).toBeCloseTo(1.5, 10);
      expect(p.BTC).toBeUndefined();
      const markets = spy.mock.calls.map(([u]) => marketOf(u)).filter(Boolean);
      expect(markets).toEqual(['LTC']);
    });

    it('omits a ticker whose fetch fails or errors; never throws, SATORIEVR unaffected', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          if (isRvnTicker(url)) throw new Error('rvn ticker blocked');
          if (isSatorinet(url)) return ok(SATORINET_BODY);
          return ok(SAT_BODY);
        }),
      );
      const p = await fetchPrices({ includeRvn: true });
      expect(p.RVN).toBeUndefined();
      expect(p.SATORIEVR).toBeCloseTo(0.23, 10);

      __resetPricesCacheForTests();
      vi.unstubAllGlobals();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          if (isRvnTicker(url)) return ok({ code: 3008, data: [], message: 'market not found' });
          if (isSatorinet(url)) return ok(SATORINET_BODY);
          return ok(SAT_BODY);
        }),
      );
      expect((await fetchPrices({ includeRvn: true })).RVN).toBeUndefined();
    });

    it('refetches to add a ticker even within the cache window (the cache lacked it), and keeps the ones it already had', async () => {
      const spy = vi.fn(async (url: unknown) => {
        const m = marketOf(url);
        if (m) return ok(coinexBody(`${m}USDT`, m === 'BTC' ? '62752' : '92.5'));
        if (isSatorinet(url)) return ok(SATORINET_BODY);
        return ok(SAT_BODY);
      });
      vi.stubGlobal('fetch', spy);
      const first = await fetchPrices({ includeLtc: true });
      expect(first.LTC).toBeCloseTo(92.5, 10);
      // Within the window, but now wanting BTC: must refetch rather than serve
      // the BTC-less cache, so switching wallets gets a price promptly...
      const second = await fetchPrices({ includeBtc: true });
      expect(second.BTC).toBeCloseTo(62752, 10);
      // ...and the LTC price already on screen is carried forward, not dropped.
      expect(second.LTC).toBeCloseTo(92.5, 10);
    });
  });

  it('fetchDirectPrices is what fetchPrices delegates to in a build with no gateway', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => (isSatorinet(url) ? ok(SATORINET_BODY) : ok(SAT_BODY))),
    );
    const p = await fetchDirectPrices();
    expect(p.SATORIEVR).toBeCloseTo(0.23, 10);
    expect(p.quotes.SATORIEVR).toEqual({ usd: 0.23, change24h: 5.56 });
  });
});
