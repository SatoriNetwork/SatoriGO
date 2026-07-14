import { describe, expect, it } from 'vitest';
import { diffDeposits, DEPOSIT_EPSILON } from './deposits';

describe('diffDeposits', () => {
  it('returns nothing on first sight (prev undefined) — baseline only', () => {
    expect(diffDeposits(undefined, { EVR: 10, SATORIEVR: 5 })).toEqual([]);
  });

  it('reports a per-asset increase', () => {
    expect(diffDeposits({ EVR: 10 }, { EVR: 12.5 })).toEqual([{ asset: 'EVR', delta: 2.5 }]);
  });

  it('treats a brand-new asset as an increase from 0', () => {
    expect(diffDeposits({ EVR: 10 }, { EVR: 10, SATORIEVR: 3 })).toEqual([
      { asset: 'SATORIEVR', delta: 3 },
    ]);
  });

  it('ignores decreases (a send) and unchanged balances', () => {
    expect(diffDeposits({ EVR: 10, SATORIEVR: 5 }, { EVR: 8, SATORIEVR: 5 })).toEqual([]);
  });

  it('reports multiple simultaneous increases', () => {
    const out = diffDeposits({ EVR: 1, SATORIEVR: 1 }, { EVR: 2, SATORIEVR: 4 });
    expect(out).toEqual([
      { asset: 'EVR', delta: 1 },
      { asset: 'SATORIEVR', delta: 3 },
    ]);
  });

  it('ignores sub-epsilon float noise', () => {
    expect(diffDeposits({ EVR: 10 }, { EVR: 10 + DEPOSIT_EPSILON / 2 })).toEqual([]);
  });

  it('detects an increase of a single base unit (1e-8)', () => {
    const out = diffDeposits({ EVR: 10 }, { EVR: 10 + 1e-8 });
    expect(out).toHaveLength(1);
    expect(out[0].asset).toBe('EVR');
  });
});
