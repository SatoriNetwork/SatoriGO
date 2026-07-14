// Satori Network statistics, as shown in the "Statistics" section of satorinet.io.
//
// The endpoints and the DERIVATIONS below were read out of satorinet.io's own client
// bundle, not guessed, so the wallet shows the same six figures the website does:
//
//   NETWORK OUTPUT     total_predictions          /api/stats/predictions
//   CONNECTED          unique_neurons             /api/stats/predictions
//   PRICE              price                      /api/satori-price
//   COST               250 * price                derived (a neuron stake is 250 SATORI)
//   24H AVG EARNINGS   "predictors mean" value    /api/approvals/distribution-report
//   TOTAL              count                      /api/wallet-holders
//
// The site literally does `u = 250 * d` where `d` is the price, and pulls the average
// earnings by running /predictors mean:\s*([\d.]+)/ over the report's plain-text blob.
//
// These hosts send no CORS headers and sit behind Cloudflare, so this only works from
// an extension context with `satorinet.io` in host_permissions (already granted for
// the price feed). Every field is independent: one endpoint failing must not blank the
// whole screen, so each is fetched separately and missing values stay `null`.
import { getStorage } from './storage';

const BASE = 'https://satorinet.io';
export const PREDICTIONS_URL = `${BASE}/api/stats/predictions`;
export const PRICE_URL = `${BASE}/api/satori-price`;
export const HOLDERS_URL = `${BASE}/api/wallet-holders`;
export const DISTRIBUTION_URL = `${BASE}/api/approvals/distribution-report`;

/** A neuron stake, in SATORI. satorinet.io multiplies this by the price for "COST". */
export const NEURON_STAKE_SATORI = 250;

const CACHE_KEY = 'satoriStats';
/** The upstream API is itself cached (it publishes `cache_updated_at`), so hammering
 *  it gains nothing. Serve our copy for a minute. */
export const STATS_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface SatoriStats {
  /** Total predictions the network has produced. */
  predictions: number | null;
  /** Neurons currently connected. */
  neurons: number | null;
  /** SATORIEVR price in USD. */
  price: number | null;
  /** USD cost of staking one neuron = NEURON_STAKE_SATORI * price. */
  stakeCostUsd: number | null;
  /** Mean 24h earnings per staked neuron, in SATORI. */
  avgEarningsPerNeuron: number | null;
  /** Number of wallet holders. */
  walletHolders: number | null;
  /** When we fetched this (epoch ms). */
  fetchedAt: number;
}

interface CachedStats {
  stats: SatoriStats;
  at: number;
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`http-${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** A finite number, or null. Guards against the API returning a string or null. */
function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Pull the mean 24h payout out of the distribution report's plain-text blob.
 *  Exported because this parser, not the HTTP call, is the part worth testing. */
export function parsePredictorsMean(reportText: unknown): number | null {
  if (typeof reportText !== 'string') return null;
  const match = /predictors mean:\s*([\d.]+)/.exec(reportText);
  return match ? num(match[1]) : null;
}

export function parsePredictionStats(body: unknown): { predictions: number | null; neurons: number | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  return { predictions: num(b.total_predictions), neurons: num(b.unique_neurons) };
}

export function parseWalletHolders(body: unknown): number | null {
  return num(((body ?? {}) as Record<string, unknown>).count);
}

export function parsePrice(body: unknown): number | null {
  return num(((body ?? {}) as Record<string, unknown>).price);
}

/** The website's own derivation: a neuron stake is 250 SATORI, priced in USD. */
export function deriveStakeCostUsd(price: number | null): number | null {
  return price === null ? null : NEURON_STAKE_SATORI * price;
}

/**
 * Fetch all six figures. Each endpoint is settled independently: a single failing
 * request leaves ITS fields null and the rest still render, because a wallet showing
 * five of six numbers is far better than one showing an error page.
 */
export async function fetchSatoriStats(now: number = Date.now()): Promise<SatoriStats> {
  const [predictionsRes, priceRes, holdersRes, reportRes] = await Promise.allSettled([
    getJson(PREDICTIONS_URL),
    getJson(PRICE_URL),
    getJson(HOLDERS_URL),
    getJson(DISTRIBUTION_URL),
  ]);

  const predictionStats =
    predictionsRes.status === 'fulfilled'
      ? parsePredictionStats(predictionsRes.value)
      : { predictions: null, neurons: null };

  const price = priceRes.status === 'fulfilled' ? parsePrice(priceRes.value) : null;
  const walletHolders = holdersRes.status === 'fulfilled' ? parseWalletHolders(holdersRes.value) : null;
  const avgEarningsPerNeuron =
    reportRes.status === 'fulfilled'
      ? parsePredictorsMean((reportRes.value as Record<string, unknown> | null)?.text)
      : null;

  return {
    predictions: predictionStats.predictions,
    neurons: predictionStats.neurons,
    price,
    stakeCostUsd: deriveStakeCostUsd(price),
    avgEarningsPerNeuron,
    walletHolders,
    fetchedAt: now,
  };
}

/** Cached read. Falls back to a stale cache if the network is unreachable, so the
 *  screen keeps showing the last known figures instead of going blank. */
export async function getSatoriStats(force = false, now: number = Date.now()): Promise<SatoriStats | null> {
  const cached = await getStorage().get<CachedStats>(CACHE_KEY);
  if (!force && cached && now - cached.at < STATS_TTL_MS) return cached.stats;

  try {
    const stats = await fetchSatoriStats(now);
    await getStorage().set(CACHE_KEY, { stats, at: now } satisfies CachedStats);
    return stats;
  } catch {
    return cached?.stats ?? null;
  }
}
