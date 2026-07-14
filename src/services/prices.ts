// Live USD price feed for the only two priced assets in this wallet — EVR and
// SATORIEVR. Both come from public exchange tickers that quote against USDT,
// which we treat as ≈ USD. Every other asset simply has no price.
//
// Dependency-free and CSP-safe: plain `fetch`, no libraries. None of the
// endpoints send CORS headers, so the extension declares host_permissions for
// api.coinex.com, satorinet.io and safe.trade in public/manifest.json — that is
// what lets the popup fetch them cross-origin.

/** Poll cadence (ms) the store uses to refresh prices. */
export const PRICE_REFRESH_MS = 60_000;

/** Latest USD (≈ USDT) prices. An asset key is absent when its fetch failed or
 *  was blocked — callers keep any previous value rather than blanking the UI. */
export interface AssetPrices {
  EVR?: number;
  SATORIEVR?: number;
  /** Epoch ms of the fetch that produced this result (0 when fetch is unavailable). */
  fetchedAt: number;
}

// CoinEx spot ticker: { code: 0, data: [ { last: "0.00002645", ... } ] }.
const EVR_TICKER_URL = 'https://api.coinex.com/v2/spot/ticker?market=EVRMOREUSDT';
// PRIMARY SATORIEVR price: Satori's own aggregator (clean number, pulls from
// SafeTrade): { price: 0.23, source: "safetrade", change_percent, updated_at }.
const SATORINET_PRICE_URL = 'https://satorinet.io/api/satori-price';
// FALLBACK: SafeTrade lists SATORIEVR as "SAT": { at, ticker: { last: "0.23", ... } }.
const SAT_TICKER_URL = 'https://safe.trade/api/v2/peatio/public/markets/satusdt/tickers';

/** Return the cached result instead of re-fetching within this window. */
const CACHE_MS = 60_000;

// In-module cache — only ever holds a result that carried at least one real
// price, so a total outage can't pin an empty result for a whole minute.
let cache: AssetPrices | null = null;

/** Coerce a numeric string / number to a finite positive price, else undefined. */
function toPrice(value: unknown): number | undefined {
  const n = typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Fetch the EVR/USDT last price from CoinEx. Never throws — undefined on any
 *  failure (network / CORS / non-OK / malformed / `code !== 0`). */
async function fetchEvr(): Promise<number | undefined> {
  const res = await fetch(EVR_TICKER_URL);
  if (!res.ok) return undefined;
  const json: unknown = await res.json();
  if (!json || typeof json !== 'object' || (json as { code?: unknown }).code !== 0) {
    return undefined;
  }
  const data = (json as { data?: unknown }).data;
  const first = Array.isArray(data) ? (data[0] as unknown) : undefined;
  const last = first && typeof first === 'object' ? (first as { last?: unknown }).last : undefined;
  return toPrice(last);
}

/** Fetch the SATORIEVR price. PRIMARY: satorinet.io's aggregated price (the
 *  "current" price the Satori site shows); FALLBACK: SafeTrade's raw ticker.
 *  Never throws — undefined only if BOTH sources fail. */
async function fetchSat(): Promise<number | undefined> {
  // Primary — Satori's own /api/satori-price ({ price: 0.23, source: "safetrade" }).
  try {
    const res = await fetch(SATORINET_PRICE_URL);
    if (res.ok) {
      const json: unknown = await res.json();
      const p = toPrice(json && typeof json === 'object' ? (json as { price?: unknown }).price : undefined);
      if (p !== undefined) return p;
    }
  } catch {
    // fall through to SafeTrade
  }
  // Fallback — SafeTrade satusdt ticker.last.
  try {
    const res = await fetch(SAT_TICKER_URL);
    if (!res.ok) return undefined;
    const json: unknown = await res.json();
    const ticker = json && typeof json === 'object' ? (json as { ticker?: unknown }).ticker : undefined;
    const last = ticker && typeof ticker === 'object' ? (ticker as { last?: unknown }).last : undefined;
    return toPrice(last);
  } catch {
    return undefined;
  }
}

/**
 * Fetch both USD (≈ USDT) prices in parallel. A failed or blocked fetch simply
 * omits that asset — this never throws. A successful result is cached for
 * CACHE_MS so frequent store polls don't hammer the exchanges.
 */
export async function fetchPrices(): Promise<AssetPrices> {
  // jsdom / non-browser guard — no fetch means no prices.
  if (typeof fetch === 'undefined') return { fetchedAt: 0 };

  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_MS) return cache;

  const [evr, sat] = await Promise.allSettled([fetchEvr(), fetchSat()]);
  const result: AssetPrices = { fetchedAt: now };
  if (evr.status === 'fulfilled' && evr.value !== undefined) result.EVR = evr.value;
  if (sat.status === 'fulfilled' && sat.value !== undefined) result.SATORIEVR = sat.value;

  // Only cache a result that actually carries a price, so a transient full
  // outage doesn't freeze an empty result for the whole cache window.
  if (result.EVR !== undefined || result.SATORIEVR !== undefined) {
    cache = result;
  }
  return result;
}

/** Test-only: clear the in-module cache so each test starts from a clean slate. */
export function __resetPricesCacheForTests(): void {
  cache = null;
}
