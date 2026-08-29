import { describe, expect, it } from 'vitest';
import { diffDeposits, type BalanceMap } from './deposits';

// Balances are compared in BASE UNITS carried as decimal strings: strings
// because the snapshot is persisted and extension storage goes through
// JSON.stringify (which throws on a BigInt), base units because the comparison
// then needs no epsilon at all. The old version compared whole-unit floats and
// had to ignore sub-satoshi noise it created itself.
const map = (o: Record<string, string>): BalanceMap => o;

const EVR = (whole: number) => String(BigInt(Math.round(whole * 1e8)));

describe('diffDeposits', () => {
  it('returns nothing on first sight (prev undefined) — baseline only', () => {
    expect(diffDeposits(undefined, map({ EVR: EVR(10), SATORIEVR: EVR(5) }))).toEqual([]);
  });

  it('reports a per-asset increase, in base units', () => {
    expect(diffDeposits(map({ EVR: EVR(10) }), map({ EVR: EVR(12.5) }))).toEqual([
      { asset: 'EVR', deltaBase: 250_000_000n, scale: 8 },
    ]);
  });

  it('treats a brand-new asset as an increase from 0', () => {
    expect(
      diffDeposits(map({ EVR: EVR(10) }), map({ EVR: EVR(10), SATORIEVR: EVR(3) })),
    ).toEqual([{ asset: 'SATORIEVR', deltaBase: 300_000_000n, scale: 8 }]);
  });

  it('ignores decreases (a send) and unchanged balances', () => {
    expect(
      diffDeposits(map({ EVR: EVR(10), SATORIEVR: EVR(5) }), map({ EVR: EVR(8), SATORIEVR: EVR(5) })),
    ).toEqual([]);
  });

  it('reports multiple simultaneous increases', () => {
    expect(
      diffDeposits(map({ EVR: EVR(1), SATORIEVR: EVR(1) }), map({ EVR: EVR(2), SATORIEVR: EVR(4) })),
    ).toEqual([
      { asset: 'EVR', deltaBase: 100_000_000n, scale: 8 },
      { asset: 'SATORIEVR', deltaBase: 300_000_000n, scale: 8 },
    ]);
  });

  it('detects an increase of a single base unit, exactly', () => {
    expect(diffDeposits(map({ EVR: '1000000000' }), map({ EVR: '1000000001' }))).toEqual([
      { asset: 'EVR', deltaBase: 1n, scale: 8 },
    ]);
  });

  // The reason the epsilon is gone: there is no float noise left to absorb.
  it('is exact past 2^53 base units, where the old whole-unit floats blurred', () => {
    const before = '9007199254740992'; // 2^53 base units
    const after = '9007199254740993'; // 2^53 + 1, which a double cannot hold
    expect(diffDeposits(map({ EVR: before }), map({ EVR: after }))).toEqual([
      { asset: 'EVR', deltaBase: 1n, scale: 8 },
    ]);
    // Through doubles those two are the SAME number, so the deposit vanished.
    expect(Number(before) === Number(after)).toBe(true);
  });

  it('reports each asset at its own scale', () => {
    const out = diffDeposits(map({ USDX: '100' }), map({ USDX: '300' }), (a) =>
      a === 'USDX' ? 2 : 8,
    );
    expect(out).toEqual([{ asset: 'USDX', deltaBase: 200n, scale: 2 }]);
  });

  // A snapshot written by an older build held WHOLE-unit numbers, a different
  // quantity entirely. Reading one as base units would report a colossal
  // deposit; the address re-baselines silently instead.
  it('stays silent on an old-format snapshot entry rather than misreading it', () => {
    const legacy = { EVR: 10 } as unknown as BalanceMap; // number, not a string
    expect(diffDeposits(legacy, map({ EVR: EVR(12) }))).toEqual([]);
  });

  it('ignores an unreadable current value instead of guessing', () => {
    const broken = { EVR: 'not-a-number' } as unknown as BalanceMap;
    expect(diffDeposits(map({ EVR: EVR(1) }), broken)).toEqual([]);
  });
});
