import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NEURON_STAKE_SATORI,
  deriveStakeCostUsd,
  fetchSatoriStats,
  parsePredictionStats,
  parsePredictorsMean,
  parsePrice,
  parseWalletHolders,
} from './satoriStats';

// A real slice of /api/approvals/distribution-report (2026-07-14). The average
// earnings figure is buried in a plain-text blob, which is exactly how satorinet.io
// reads it, so the parser is the part that can silently rot.
const REPORT_TEXT = [
  'date: 2026-07-14 00:03:10',
  'predictors count: 2385',
  'predictors sum: 718.7819965890411',
  'predictors min: 0.203810496747867',
  'predictors max: 0.60220419673703',
  'predictors mean: 0.30137609919875935',
  'predictors median: 0.301102098368515',
  'lenders count: 867',
  'workers count: 2223',
].join('\n');

describe('parsePredictorsMean', () => {
  it('pulls the mean out of the real report blob', () => {
    expect(parsePredictorsMean(REPORT_TEXT)).toBeCloseTo(0.30137609919875935, 12);
  });

  it('takes "mean", not the "median"/"min"/"max" lines that surround it', () => {
    const mean = parsePredictorsMean(REPORT_TEXT);
    expect(mean).not.toBeCloseTo(0.301102098368515, 6); // median
    expect(mean).not.toBeCloseTo(0.203810496747867, 6); // min
  });

  it('returns null when the line is missing or the body is not text', () => {
    expect(parsePredictorsMean('predictors count: 5')).toBeNull();
    expect(parsePredictorsMean(undefined)).toBeNull();
    expect(parsePredictorsMean({ text: 'x' })).toBeNull();
  });
});

describe('parsers', () => {
  it('reads the prediction stats', () => {
    expect(parsePredictionStats({ total_predictions: 131555, unique_neurons: 10790 })).toEqual({
      predictions: 131555,
      neurons: 10790,
    });
  });

  it('reads wallet holders and price', () => {
    expect(parseWalletHolders({ count: 27423 })).toBe(27423);
    expect(parsePrice({ price: 0.28, source: 'safetrade' })).toBe(0.28);
  });

  it('coerces numeric strings but rejects junk', () => {
    expect(parsePrice({ price: '0.28' })).toBe(0.28);
    expect(parsePrice({ price: 'n/a' })).toBeNull();
    expect(parsePrice({})).toBeNull();
    expect(parseWalletHolders(null)).toBeNull();
    expect(parsePredictionStats(null)).toEqual({ predictions: null, neurons: null });
  });
});

describe('deriveStakeCostUsd', () => {
  it('is 250 x price, the way satorinet.io computes it', () => {
    expect(NEURON_STAKE_SATORI).toBe(250);
    expect(deriveStakeCostUsd(0.279)).toBeCloseTo(69.75, 6); // matches the live site
    expect(deriveStakeCostUsd(0.28)).toBeCloseTo(70, 6);
  });

  it('is null when the price is unknown (never 0)', () => {
    expect(deriveStakeCostUsd(null)).toBeNull();
  });
});

describe('fetchSatoriStats', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('assembles all six figures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/stats/predictions')) return ok({ total_predictions: 131555, unique_neurons: 10790 });
        if (url.includes('/satori-price')) return ok({ price: 0.28 });
        if (url.includes('/wallet-holders')) return ok({ count: 27423 });
        if (url.includes('/distribution-report')) return ok({ text: REPORT_TEXT });
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const stats = await fetchSatoriStats(1_700_000_000_000);
    expect(stats.predictions).toBe(131555);
    expect(stats.neurons).toBe(10790);
    expect(stats.price).toBe(0.28);
    expect(stats.stakeCostUsd).toBeCloseTo(70, 6);
    expect(stats.avgEarningsPerNeuron).toBeCloseTo(0.30137609919875935, 12);
    expect(stats.walletHolders).toBe(27423);
    expect(stats.fetchedAt).toBe(1_700_000_000_000);
  });

  it('one dead endpoint does not blank the others', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/wallet-holders')) throw new Error('network down');
        if (url.includes('/stats/predictions')) return ok({ total_predictions: 10, unique_neurons: 2 });
        if (url.includes('/satori-price')) return ok({ price: 0.5 });
        return ok({ text: REPORT_TEXT });
      }),
    );

    const stats = await fetchSatoriStats();
    expect(stats.walletHolders).toBeNull(); // the one that failed
    expect(stats.predictions).toBe(10); // the rest still render
    expect(stats.neurons).toBe(2);
    expect(stats.price).toBe(0.5);
    expect(stats.stakeCostUsd).toBeCloseTo(125, 6);
  });

  it('an HTTP error is treated as a failure, not as data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ price: 999 }) })),
    );

    const stats = await fetchSatoriStats();
    expect(stats.price).toBeNull();
    expect(stats.stakeCostUsd).toBeNull();
    expect(stats.predictions).toBeNull();
  });
});
