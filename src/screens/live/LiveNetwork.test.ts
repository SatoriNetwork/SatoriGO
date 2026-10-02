import { describe, expect, it } from 'vitest';
import { buildTiles } from './LiveNetwork';
import type { SatoriStats } from '../../services/satoriStats';

// The Network tab's two money tiles come from satorinet.io in USD; they follow
// the display currency through the gateway's cross rate, or stay USD (and say
// so with a $) when there is no rate.
const STATS: SatoriStats = {
  predictions: 1,
  neurons: 2,
  price: 0.2,
  stakeCostUsd: 50,
  avgEarningsPerNeuron: 0.1,
  walletHolders: 3,
  fetchedAt: 0,
};
const tile = (tiles: ReturnType<typeof buildTiles>, label: string) => tiles.find((t) => t.label === label)?.value;

describe('Network tab money tiles', () => {
  it('USD by default', () => {
    const tiles = buildTiles(STATS);
    expect(tile(tiles, 'Price')).toBe('$0.20');
    expect(tile(tiles, 'Cost')).toBe('$50.00');
  });

  it('converted to EUR and PLN with the cross rate', () => {
    expect(tile(buildTiles(STATS, 'EUR', { EUR: 0.86 }), 'Cost')).toBe('€43.00');
    const pln = buildTiles(STATS, 'PLN', { PLN: 3.7 });
    expect(tile(pln, 'Price')).toBe('0.74 zł');
    expect(tile(pln, 'Cost')).toBe('185.00 zł');
  });

  it('left in USD, labelled USD, with no rate', () => {
    expect(tile(buildTiles(STATS, 'EUR', {}), 'Price')).toBe('$0.20');
    expect(tile(buildTiles(STATS, 'PLN', { EUR: 0.86 }), 'Cost')).toBe('$50.00');
  });

  it('a missing figure stays blank, not zero', () => {
    expect(tile(buildTiles({ ...STATS, price: null, stakeCostUsd: null }, 'EUR', { EUR: 0.86 }), 'Price')).toBeNull();
  });
});
