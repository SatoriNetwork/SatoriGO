import { describe, expect, it } from 'vitest';
import {
  orderAssetsForDisplay,
  applyManualOrder,
  moveInOrder,
  orderableNames,
  type AssetOrderContext,
} from './assetOrder';
import type { LiveAssetBalance } from '../../services/chain/electrumProvider';

/** Terse row builder — only name / amount / native matter to ordering. */
function row(name: string, whole: number, isNative = false): LiveAssetBalance {
  return {
    name,
    amountBase: BigInt(Math.round(whole * 1e8)),
    scale: 8,
    decimals: 8,
    isNative,
  };
}

/** Context from two plain maps; anything unlisted in them is "unknown". */
function ctx(
  usd: Record<string, number> = {},
  trust: Record<string, boolean> = {},
): AssetOrderContext {
  return {
    usdFor: (name) => (name in usd ? usd[name] : null),
    trustFor: (name) => (name in trust ? trust[name] : null),
  };
}

const names = (assets: LiveAssetBalance[]) => assets.map((a) => a.name);

describe('orderAssetsForDisplay', () => {
  it('keeps the native coin first even at a zero balance and a spammy alphabet', () => {
    const out = orderAssetsForDisplay(
      [row('$CLAIM', 5), row('ETH', 0, true), row('(t.me) claim', 5)],
      ctx(),
    );
    expect(names(out)[0]).toBe('ETH');
  });

  it('sorts valued rows by USD value descending, above unpriced holdings', () => {
    const out = orderAssetsForDisplay(
      [row('AAA', 10), row('SATORIEVR', 100), row('RVN', 1000), row('EVR', 1, true)],
      ctx({ SATORIEVR: 23, RVN: 3.9 }),
    );
    // EVR native, then SATORIEVR ($23) > RVN ($3.90), then the unpriced AAA.
    expect(names(out)).toEqual(['EVR', 'SATORIEVR', 'RVN', 'AAA']);
  });

  it('puts unlisted (spam) holdings below listed and unknown ones', () => {
    const out = orderAssetsForDisplay(
      [
        row('(t.me/s/US_POOL) claim', 1),
        row('$TRUMP Claim', 1),
        row('WETH', 2),
        row('MYSTERY', 3),
      ],
      ctx({}, { '(t.me/s/US_POOL) claim': false, '$TRUMP Claim': false, WETH: true }),
    );
    // Listed + unknown first (A→Z), then the two unlisted ones after them.
    expect(names(out).slice(0, 2)).toEqual(['MYSTERY', 'WETH']);
    expect(names(out).slice(2).sort()).toEqual(['$TRUMP Claim', '(t.me/s/US_POOL) claim']);
  });

  it('sinks every zero balance to the end, listed or not, priced or not', () => {
    const out = orderAssetsForDisplay(
      [row('USDC', 0), row('JUNK', 0), row('WETH', 0), row('HELD', 0.5), row('ETH', 0, true)],
      ctx({ USDC: 0 }, { USDC: true, WETH: true, JUNK: false }),
    );
    // Native, the only real holding, then the empties: listed A→Z, unlisted last.
    expect(names(out)).toEqual(['ETH', 'HELD', 'USDC', 'WETH', 'JUNK']);
  });

  it('a priced asset at a zero balance does not outrank an unpriced holding', () => {
    const out = orderAssetsForDisplay([row('USDC', 0), row('AAA', 7)], ctx({ USDC: 0 }));
    expect(names(out)).toEqual(['AAA', 'USDC']);
  });

  it('is stable for rows that tie on every key, and never mutates the input', () => {
    const input = [row('DUP', 4), row('DUP', 4), row('ETH', 0, true)];
    const before = [...input];
    const out = orderAssetsForDisplay(input, ctx());
    expect(out[1]).toBe(input[0]);
    expect(out[2]).toBe(input[1]);
    expect(input).toEqual(before);
    expect(out).not.toBe(input);
  });

  it('re-sorts as prices arrive (same rows, richer context)', () => {
    const rows = [row('EVR', 1, true), row('AAA', 1), row('SATORIEVR', 50)];
    expect(names(orderAssetsForDisplay(rows, ctx()))).toEqual(['EVR', 'AAA', 'SATORIEVR']);
    expect(names(orderAssetsForDisplay(rows, ctx({ SATORIEVR: 11.5 })))).toEqual([
      'EVR',
      'SATORIEVR',
      'AAA',
    ]);
  });

  it('handles an empty list', () => {
    expect(orderAssetsForDisplay([], ctx())).toEqual([]);
  });
});

describe('applyManualOrder', () => {
  it('with no stored order, changes nothing', () => {
    const rows = [row('EVR', 1, true), row('AAA', 2), row('BBB', 3)];
    expect(names(applyManualOrder(rows, []))).toEqual(['EVR', 'AAA', 'BBB']);
  });

  it('puts the arranged rows in the arranged order', () => {
    const rows = [row('EVR', 1, true), row('AAA', 2), row('BBB', 3), row('CCC', 4)];
    expect(names(applyManualOrder(rows, ['CCC', 'AAA', 'BBB']))).toEqual(['EVR', 'CCC', 'AAA', 'BBB']);
  });

  it('keeps the native coin first even when the order tries to move it', () => {
    const rows = [row('EVR', 1, true), row('AAA', 2)];
    // 'EVR' can never reach the stored order through the UI (its handle is
    // disabled), so an entry naming it is treated like any other dead entry.
    expect(names(applyManualOrder(rows, ['AAA', 'EVR']))).toEqual(['EVR', 'AAA']);
  });

  it('ignores an entry for an asset that is no longer displayed (never resurrects it)', () => {
    const rows = [row('EVR', 1, true), row('AAA', 2)];
    const out = applyManualOrder(rows, ['GONE', 'AAA', 'ALSOGONE']);
    expect(names(out)).toEqual(['EVR', 'AAA']);
    expect(out).toHaveLength(2);
  });

  it('a token with no stored position goes AFTER the arranged ones, in its default place', () => {
    // NEW1/NEW2 arrived after the last drag; the automatic order already put
    // NEW1 before NEW2, and that relative order is what they keep.
    const rows = [row('EVR', 1, true), row('NEW1', 5), row('NEW2', 4), row('BBB', 3), row('AAA', 2)];
    expect(names(applyManualOrder(rows, ['AAA', 'BBB']))).toEqual([
      'EVR',
      'AAA',
      'BBB',
      'NEW1',
      'NEW2',
    ]);
  });

  it('collapses a duplicated entry and never emits a row twice', () => {
    const rows = [row('EVR', 1, true), row('AAA', 2), row('BBB', 3)];
    const out = applyManualOrder(rows, ['BBB', 'BBB', 'AAA']);
    expect(names(out)).toEqual(['EVR', 'BBB', 'AAA']);
  });

  it('never mutates the input and returns a new array', () => {
    const rows = [row('EVR', 1, true), row('AAA', 2), row('BBB', 3)];
    const before = [...rows];
    const out = applyManualOrder(rows, ['BBB', 'AAA']);
    expect(rows).toEqual(before);
    expect(out).not.toBe(rows);
  });

  it('handles an empty list and a list with no native row', () => {
    expect(applyManualOrder([], ['AAA'])).toEqual([]);
    expect(names(applyManualOrder([row('AAA', 1), row('BBB', 2)], ['BBB']))).toEqual(['BBB', 'AAA']);
  });
});

describe('orderableNames', () => {
  it('is the non-native names, in display order', () => {
    expect(orderableNames([row('EVR', 1, true), row('BBB', 2), row('AAA', 3)])).toEqual(['BBB', 'AAA']);
  });
});

describe('moveInOrder', () => {
  const list = () => ['A', 'B', 'C', 'D'];

  it('moves an entry up and down', () => {
    expect(moveInOrder(list(), 2, 0)).toEqual(['C', 'A', 'B', 'D']);
    expect(moveInOrder(list(), 0, 3)).toEqual(['B', 'C', 'D', 'A']);
  });

  it('clamps past either end instead of dropping the entry', () => {
    expect(moveInOrder(list(), 1, -5)).toEqual(['B', 'A', 'C', 'D']);
    expect(moveInOrder(list(), 1, 99)).toEqual(['A', 'C', 'D', 'B']);
  });

  it('returns the SAME array for a no-op, so nothing is persisted needlessly', () => {
    const l = list();
    expect(moveInOrder(l, 1, 1)).toBe(l);
    expect(moveInOrder(l, 0, -1)).toBe(l);
    expect(moveInOrder(l, 9, 0)).toBe(l);
  });

  it('never mutates its input', () => {
    const l = list();
    moveInOrder(l, 0, 3);
    expect(l).toEqual(['A', 'B', 'C', 'D']);
  });
});
