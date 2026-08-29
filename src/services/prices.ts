// Live fiat price feed.
//
// RELEASE SHAPE (2026-08-21): every price comes from the Satori GO gateway, in
// ONE request to `<gateway>/prices`, in EVERY build (store packages included).
// The gateway talks to CoinGecko and SafeTrade/satorinet server-side, caches
// the answer, and hands the wallet a single small document. The wallet
// therefore contacts no exchange directly and `host_permissions` names no
// exchange host.
//
// DEV SHAPE: a build with no gateway configured (platforms/evm-gateway.json
// empty) keeps the old direct path: satorinet.io for SATORIEVR with SafeTrade
// as its fallback, and CoinEx v2 spot tickers for RVN/LTC/BTC/DOGE. That path
// is compiled out of a gateway build entirely (see HAS_GATEWAY in
// services/gateway.ts, and the dist grep in scripts/build.mjs).
//
// Dependency-free and CSP-safe either way: plain `fetch`, no libraries.

import { GATEWAY_URL, HAS_GATEWAY, gatewayHeaders } from './gateway';

/** Poll cadence (ms) the store uses to refresh prices. The gateway does its own
 *  caching; this stays the wallet's own interval. */
export const PRICE_REFRESH_MS = 60_000;

/** Tickers this build has a first-class use for. NOT a closed set: the gateway
 *  may publish more (the owner configures per-ticker sources in the panel), and
 *  every extra one is carried through untouched so a chain added later gets
 *  fiat with no change here. */
export type PricedTicker =
  | 'EVR'
  | 'SATORIEVR'
  | 'RVN'
  | 'LTC'
  | 'BTC'
  | 'DOGE'
  | 'ETH'
  | 'BNB'
  | 'EPIX';

/** The tickers above, as data. */
export const PRICED_TICKERS: readonly PricedTicker[] = [
  'EVR',
  'SATORIEVR',
  'RVN',
  'LTC',
  'BTC',
  'DOGE',
  'ETH',
  'BNB',
  'EPIX',
];

/** ticker -> USD price. The known tickers get autocomplete; any other ticker
 *  the source reported is still readable by name. An absent key means "not
 *  known", never 0. */
export type PriceMap = Partial<Record<PricedTicker, number>> & Partial<Record<string, number>>;

/** One ticker's quote, kept as published so a later currency switch (EUR/PLN)
 *  or a "priced by" label needs no new plumbing. Every field is optional: a
 *  source may report only some of them. */
export interface PriceQuote {
  usd?: number;
  eur?: number;
  pln?: number;
  /** 24h move in PERCENT (2.4 = +2.4%). Absent when the source has none. */
  change24h?: number;
  /** Which source the gateway used for this ticker, when it says. Free-form:
   *  the owner can configure a custom source per ticker. */
  source?: string;
}

/** Latest prices. A ticker is absent when its source failed or was blocked —
 *  callers keep any previous value rather than blanking the UI. */
export interface AssetPrices {
  /** EVR/USD. Present again since prices moved behind the gateway (CoinGecko
   *  quotes EVR; the CoinEx market this wallet used to read was delisted). */
  EVR?: number;
  SATORIEVR?: number;
  RVN?: number;
  LTC?: number;
  BTC?: number;
  DOGE?: number;
  ETH?: number;
  BNB?: number;
  EPIX?: number;
  /** EVERY ticker the source reported, verbatim, INCLUDING ones with no typed
   *  field above. This is the table the store keeps; the fields above are the
   *  convenience view of it. */
  quotes: Record<string, PriceQuote>;
  /**
   * 24h price move in PERCENT per ticker, e.g. 2.4 = +2.4%, -0.8 = down 0.8%.
   * A key is present only when the source actually reported (or lets us derive)
   * a 24h figure — never a 0 standing in for "unknown", which would read as
   * "flat".
   */
  changes24h: Partial<Record<string, number>>;
  /** Epoch ms of the fetch that produced this result (0 when fetch is unavailable). */
  fetchedAt: number;
}

/** Which optional tickers a caller wants priced. Only meaningful on the DEV
 *  path: the gateway returns everything it knows in one document, so a gateway
 *  build ignores these. Keeps a user who never touches RVN/LTC/BTC/DOGE from
 *  adding ticker chatter to third-party exchanges in a dev build. */
export interface PriceRequest {
  includeRvn?: boolean;
  includeLtc?: boolean;
  includeBtc?: boolean;
  includeDoge?: boolean;
}

/** Return the cached result instead of re-fetching within this window. */
const CACHE_MS = 60_000;

// In-module cache — only ever holds a result that carried at least one real
// price, so a total outage can't pin an empty result for a whole minute.
let cache: AssetPrices | null = null;

function emptyPrices(fetchedAt: number): AssetPrices {
  return { quotes: {}, changes24h: {}, fetchedAt };
}

/** Coerce a numeric string / number to a finite positive price, else undefined. */
function toPrice(value: unknown): number | undefined {
  const n = typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Coerce a percent to a finite number. Accepts the aggregator's decorated
 *  string form ("+5.56%", "-1.2%") as well as a bare number. Zero IS a valid
 *  percent (a flat day), so this only rejects what it cannot parse. */
export function toPercent(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const n = parseFloat(value.trim().replace('%', ''));
  return Number.isFinite(n) ? n : undefined;
}

/** Fold a quote table into the flat convenience fields + changes24h. Any ticker
 *  is accepted, not just the typed ones: an extra ticker still reaches the
 *  store through `quotes` and `changes24h`.
 *
 *  The flat fields live on the SAME object as `quotes`/`changes24h`/`fetchedAt`.
 *  That is safe because every ticker key is upper-cased and those three names
 *  are lower-case, so a ticker can never shadow one of them. */
function fromQuotes(quotes: Record<string, PriceQuote>, fetchedAt: number): AssetPrices {
  const result: AssetPrices = { quotes, changes24h: {}, fetchedAt };
  const flat = result as unknown as Record<string, number>;
  for (const [ticker, quote] of Object.entries(quotes)) {
    if (quote.usd !== undefined) flat[ticker] = quote.usd;
    if (quote.change24h !== undefined) result.changes24h[ticker] = quote.change24h;
  }
  return result;
}

/** True when a result carries at least one usable price (worth caching). */
function hasAnyPrice(p: AssetPrices): boolean {
  return Object.values(p.quotes).some((q) => q.usd !== undefined);
}

// --- SATORIEVR straight from satorinet.io (both paths) -----------------------

/** Satori's own aggregator: { price: 0.19, source: "safetrade",
 *  change_percent: "+5.56%", updated_at }. The 24h move comes free with it.
 *  Used by the DEV path as the primary SATORIEVR source, and by the GATEWAY path
 *  as the fallback when the gateway's answer carries no SATORIEVR: the gateway
 *  fetches from a datacenter egress that SafeTrade's and satorinet.io's
 *  Cloudflare edges answer with 403, while a wallet on a residential IP gets
 *  through (verified 2026-08-21). `satorinet.io` stays in host_permissions in
 *  every build for the Network tab anyway, so this adds no host. Never throws:
 *  undefined when the source did not answer. */
export const SATORINET_PRICE_URL = 'https://satorinet.io/api/satori-price';
export async function fetchSatorinetQuote(): Promise<PriceQuote | undefined> {
  try {
    const res = await fetch(SATORINET_PRICE_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    const json: unknown = await res.json();
    const body = json && typeof json === 'object' ? (json as { price?: unknown; change_percent?: unknown }) : undefined;
    const usd = toPrice(body?.price);
    if (usd === undefined) return undefined;
    const change24h = toPercent(body?.change_percent);
    return change24h === undefined ? { usd, source: 'satorinet' } : { usd, change24h, source: 'satorinet' };
  } catch {
    return undefined;
  }
}

// --- the gateway path -------------------------------------------------------

/** `GET <gateway>/prices` ->
 *  { fetchedAt, ttlSec, prices: { EVR: {usd, eur, pln, change24h}, ... },
 *    sources: { coingecko: {...}, satori: {...} } }
 *  Tickers may be missing (a source was down); an absent ticker simply carries
 *  no price this round and the store keeps whatever it had. Unknown fields and
 *  unknown TICKERS are both fine: extra tickers are kept as published. */
export function parseGatewayPrices(json: unknown, fetchedAt: number): AssetPrices {
  const body = json && typeof json === 'object' ? (json as { prices?: unknown }) : undefined;
  const raw = body?.prices;
  if (!raw || typeof raw !== 'object') return emptyPrices(fetchedAt);
  const quotes: Record<string, PriceQuote> = {};
  for (const [ticker, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as { usd?: unknown; eur?: unknown; pln?: unknown; change24h?: unknown; source?: unknown };
    const quote: PriceQuote = {};
    const usd = toPrice(row.usd);
    if (usd !== undefined) quote.usd = usd;
    const eur = toPrice(row.eur);
    if (eur !== undefined) quote.eur = eur;
    const pln = toPrice(row.pln);
    if (pln !== undefined) quote.pln = pln;
    // change24h is explicitly nullable in the contract; null means "unknown",
    // which must not become a 0 that reads as a flat day.
    const change = row.change24h === null ? undefined : toPercent(row.change24h);
    if (change !== undefined) quote.change24h = change;
    if (typeof row.source === 'string' && row.source) quote.source = row.source;
    // A ticker with nothing usable in it is not worth carrying.
    if (Object.keys(quote).length > 0) quotes[ticker.trim().toUpperCase()] = quote;
  }
  return fromQuotes(quotes, fetchedAt);
}

/** ONE request for every price. Never throws: an empty result on any failure,
 *  which makes the store keep the values already on screen. */
export async function fetchGatewayPrices(gateway: string = GATEWAY_URL): Promise<AssetPrices> {
  const now = Date.now();
  let quotes: Record<string, PriceQuote> = {};
  try {
    const res = await fetch(`${gateway}/prices`, { headers: gatewayHeaders(undefined, gateway) });
    if (res.ok) quotes = { ...parseGatewayPrices(await res.json(), now).quotes };
  } catch {
    // the gateway did not answer: the SATORIEVR fallback below still runs, and
    // every other ticker keeps whatever the store already has
  }
  // SATORIEVR fallback: the gateway's own SATORI sources sit behind Cloudflare
  // edges that block its datacenter egress; the wallet, on the user's IP, can
  // still read satorinet.io. Only when the gateway carried no SATORIEVR price.
  if (quotes.SATORIEVR?.usd === undefined) {
    const direct = await fetchSatorinetQuote();
    if (direct) quotes.SATORIEVR = direct;
  }
  return fromQuotes(quotes, now);
}

// --- the direct path (DEV builds with no gateway) ---------------------------
//
// Everything below is unreachable in a gateway build and is dropped from the
// bundle by Rollup (HAS_GATEWAY folds to a literal). It is kept because a
// developer without a gateway still wants prices on screen.

// CoinEx v2 spot markets, verified live: RVNUSDT (2026-07-21), LTCUSDT and
// BTCUSDT (2026-08-14), DOGEUSDT (2026-08-15). NO EVR MARKET EXISTS: CoinEx
// delisted it and answers "market EVRMOREUSDT not found", so this path reports
// no EVR price at all (the gateway path does, via CoinGecko).
const COINEX_MARKETS: Record<string, string> = {
  RVN: 'RVNUSDT',
  LTC: 'LTCUSDT',
  BTC: 'BTCUSDT',
  DOGE: 'DOGEUSDT',
};

function coinexTickerUrl(market: string): string {
  return `https://api.coinex.com/v2/spot/ticker?market=${market}`;
}

/** One market's ticker: last price plus, when derivable, its 24h move (percent). */
export interface MarketQuote {
  price: number;
  change24h?: number;
}

/** Fetch a market's last price (and 24h move) from a CoinEx v2 spot-ticker URL.
 *  Never throws — undefined on any failure (network / CORS / non-OK / malformed
 *  / `code !== 0`).
 *
 *  CoinEx v2 has no percent field, but it reports `open` alongside `last` over a
 *  `period` of 86400 seconds (verified live 2026-08-19 on RVNUSDT:
 *  { open: "0.002755", last: "0.002712", period: 86400 }), so the 24h change is
 *  simply (last - open) / open. The period is CHECKED rather than assumed: if
 *  CoinEx ever quotes a shorter window, we report no change instead of labelling
 *  the wrong one "24h". */
export function parseCoinexTicker(json: unknown): MarketQuote | undefined {
  if (!json || typeof json !== 'object' || (json as { code?: unknown }).code !== 0) {
    return undefined;
  }
  const data = (json as { data?: unknown }).data;
  const first = Array.isArray(data) ? (data[0] as unknown) : undefined;
  if (!first || typeof first !== 'object') return undefined;
  const row = first as { last?: unknown; open?: unknown; period?: unknown };
  const price = toPrice(row.last);
  if (price === undefined) return undefined;
  const open = toPrice(row.open);
  const change24h =
    open !== undefined && row.period === 86400 ? ((price - open) / open) * 100 : undefined;
  return change24h === undefined ? { price } : { price, change24h };
}

async function fetchCoinexQuote(market: string): Promise<MarketQuote | undefined> {
  try {
    const res = await fetch(coinexTickerUrl(market));
    if (!res.ok) return undefined;
    return parseCoinexTicker(await res.json());
  } catch {
    return undefined;
  }
}

/** The SATORIEVR price on the dev path: satorinet.io's aggregator (see
 *  fetchSatorinetQuote). The old SafeTrade fallback is gone with the
 *  `safe.trade` host permission (2026-08-21). */
async function fetchSat(): Promise<MarketQuote | undefined> {
  const q = await fetchSatorinetQuote();
  if (!q || q.usd === undefined) return undefined;
  return q.change24h === undefined ? { price: q.usd } : { price: q.usd, change24h: q.change24h };
}

/** Which optional CoinEx tickers this request wants. */
function wantedTickers(opts?: PriceRequest): string[] {
  const want: string[] = [];
  if (opts?.includeRvn) want.push('RVN');
  if (opts?.includeLtc) want.push('LTC');
  if (opts?.includeBtc) want.push('BTC');
  if (opts?.includeDoge) want.push('DOGE');
  return want;
}

/** The direct third-party path: SATORIEVR always, plus the requested CoinEx
 *  markets, in parallel. Never throws — a failed fetch simply omits that
 *  ticker. Exported so the tests can exercise it explicitly; production reaches
 *  it only through fetchPrices() in a build with no gateway. */
export async function fetchDirectPrices(opts?: PriceRequest): Promise<AssetPrices> {
  const now = Date.now();
  const want = wantedTickers(opts);
  const settled = await Promise.allSettled([
    fetchSat(),
    ...want.map((t) => fetchCoinexQuote(COINEX_MARKETS[t])),
  ]);
  const quotes: Record<string, PriceQuote> = {};
  const put = (ticker: string, quote: MarketQuote | undefined) => {
    if (!quote) return;
    quotes[ticker] = quote.change24h === undefined ? { usd: quote.price } : { usd: quote.price, change24h: quote.change24h };
  };
  const value = (i: number): MarketQuote | undefined => {
    const r = settled[i];
    return r.status === 'fulfilled' ? r.value : undefined;
  };
  put('SATORIEVR', value(0));
  want.forEach((ticker, i) => put(ticker, value(i + 1)));
  // Carry a prior price forward for a ticker this fetch did not ask for, so it
  // isn't dropped from the cache when the active wallet's chain changes.
  if (cache) {
    for (const [ticker, quote] of Object.entries(cache.quotes)) {
      if (quotes[ticker] === undefined && quote.usd !== undefined) quotes[ticker] = quote;
    }
  }
  return fromQuotes(quotes, now);
}

// --- the entry point --------------------------------------------------------

/**
 * Fetch the current prices. ONE gateway request when this build has a gateway
 * (the release shape: every price, every build); otherwise the direct
 * third-party sources for the tickers asked for.
 *
 * Never throws. A successful result is cached for CACHE_MS so frequent store
 * polls don't hammer anything. On the direct path, a request for a ticker the
 * cache lacks refetches even inside the window, so switching to (say) an RVN
 * wallet gets a price promptly rather than waiting out the cache.
 */
export async function fetchPrices(opts?: PriceRequest): Promise<AssetPrices> {
  // jsdom / non-browser guard — no fetch means no prices.
  if (typeof fetch === 'undefined') return emptyPrices(0);
  // A ternary on a build-time literal, not an if/else with an early return:
  // Rollup folds this to the one branch and drops the other, which is what
  // keeps the exchange URLs out of a gateway build entirely.
  return HAS_GATEWAY ? cachedGatewayPrices() : cachedDirectPrices(opts);
}

/** One document holds every ticker, so freshness is the only cache question. */
async function cachedGatewayPrices(): Promise<AssetPrices> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  const result = await fetchGatewayPrices();
  // Only cache a result that actually carries a price, so a transient outage
  // doesn't freeze an empty result for the whole cache window.
  if (hasAnyPrice(result)) cache = result;
  return result;
}

/** Direct path: also refetch inside the window when the cache lacks a ticker
 *  this call asked for. */
async function cachedDirectPrices(opts?: PriceRequest): Promise<AssetPrices> {
  const cached = cache;
  if (
    cached &&
    Date.now() - cached.fetchedAt < CACHE_MS &&
    wantedTickers(opts).every((t) => cached.quotes[t]?.usd !== undefined)
  ) {
    return cached;
  }
  const result = await fetchDirectPrices(opts);
  if (hasAnyPrice(result)) cache = result;
  return result;
}

/** Test-only: clear the in-module cache so each test starts from a clean slate. */
export function __resetPricesCacheForTests(): void {
  cache = null;
}
