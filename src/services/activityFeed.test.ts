import { describe, expect, it } from 'vitest';
import {
  mergeActivity,
  filterActivity,
  paginate,
  ACTIVITY_PER_PAGE,
  type ActivityItem,
  type StakingEvent,
} from './activityFeed';
import type { LiveTransaction } from './chain/electrumProvider';

/** Build a minimal LiveTransaction for the tests below. */
function tx(overrides: Partial<LiveTransaction> & { txid: string; timestamp: number }): LiveTransaction {
  return {
    asset: 'EVR',
    direction: 'in',
    amount: 1,
    feeEvr: 0,
    status: 'confirmed',
    counterparty: 'Ecounterparty',
    ...overrides,
  };
}

/** Build a minimal StakingEvent. */
function evt(overrides: Partial<StakingEvent> & { timestamp: number }): StakingEvent {
  return {
    type: 'pool-join',
    poolAddress: 'EpoolAddr',
    poolAlias: 'Namaste Club',
    addressCount: 1,
    ...overrides,
  };
}

describe('mergeActivity', () => {
  it('merges txs and staking events into one list sorted by timestamp desc', () => {
    const txs = [tx({ txid: 't-old', timestamp: 100 }), tx({ txid: 't-new', timestamp: 400 })];
    const events = [evt({ timestamp: 300 }), evt({ timestamp: 200, type: 'pool-leave' })];
    const merged = mergeActivity(txs, events);
    expect(merged.map((i) => i.timestamp)).toEqual([400, 300, 200, 100]);
    expect(merged.map((i) => i.kind)).toEqual(['tx', 'staking', 'staking', 'tx']);
  });

  it('tags each item with the right discriminant + carries the payload', () => {
    const merged = mergeActivity([tx({ txid: 'abc', timestamp: 10 })], [evt({ timestamp: 20 })]);
    expect(merged[0].kind).toBe('staking');
    expect(merged[1].kind).toBe('tx');
    const txItem = merged[1];
    if (txItem.kind === 'tx') expect(txItem.tx.txid).toBe('abc');
    const stkItem = merged[0];
    if (stkItem.kind === 'staking') expect(stkItem.event.poolAlias).toBe('Namaste Club');
  });

  it('uses txid as the tx id and a derived stable id for staking events', () => {
    const merged = mergeActivity(
      [tx({ txid: 'the-txid', timestamp: 10 })],
      [evt({ timestamp: 20, type: 'pool-join', poolAddress: 'Ep' })],
    );
    const stk = merged.find((i) => i.kind === 'staking')!;
    const t = merged.find((i) => i.kind === 'tx')!;
    expect(t.id).toBe('the-txid');
    expect(stk.id).toBe('stk-pool-join-Ep-20');
  });

  it('breaks a timestamp tie with tx before staking, deterministically', () => {
    const merged = mergeActivity([tx({ txid: 'zzz', timestamp: 500 })], [evt({ timestamp: 500 })]);
    expect(merged.map((i) => i.kind)).toEqual(['tx', 'staking']);
  });

  it('handles empty inputs', () => {
    expect(mergeActivity([], [])).toEqual([]);
    expect(mergeActivity([tx({ txid: 'a', timestamp: 1 })], [])).toHaveLength(1);
    expect(mergeActivity([], [evt({ timestamp: 1 })])).toHaveLength(1);
  });
});

describe('filterActivity', () => {
  const items: ActivityItem[] = mergeActivity(
    [
      tx({ txid: 'aaa111', timestamp: 500, asset: 'EVR', counterparty: 'EaliceAddr' }),
      tx({ txid: 'bbb222', timestamp: 400, asset: 'SATORIEVR', counterparty: 'EbobAddr' }),
    ],
    [evt({ timestamp: 300, poolAlias: 'Namaste Club', poolAddress: 'EpoolXYZ' })],
  );

  it('empty / whitespace query returns the list unchanged', () => {
    expect(filterActivity(items, '')).toEqual(items);
    expect(filterActivity(items, '   ')).toEqual(items);
  });

  it('filters tx by asset name (case-insensitive)', () => {
    const r = filterActivity(items, 'satori');
    expect(r).toHaveLength(1);
    expect(r[0].kind === 'tx' && r[0].tx.txid).toBe('bbb222');
  });

  it('filters tx by txid substring', () => {
    const r = filterActivity(items, 'aaa1');
    expect(r).toHaveLength(1);
    expect(r[0].kind === 'tx' && r[0].tx.txid).toBe('aaa111');
  });

  it('filters tx by counterparty address', () => {
    const r = filterActivity(items, 'ealice');
    expect(r.map((i) => (i.kind === 'tx' ? i.tx.txid : ''))).toEqual(['aaa111']);
  });

  it('filters staking events by pool alias', () => {
    const r = filterActivity(items, 'namaste');
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('staking');
  });

  it('filters staking events by pool address', () => {
    const r = filterActivity(items, 'epoolxyz');
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('staking');
  });

  it('matches the literal word "pool" to all staking rows', () => {
    const r = filterActivity(items, 'pool');
    expect(r.every((i) => i.kind === 'staking')).toBe(true);
    expect(r).toHaveLength(1);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterActivity(items, 'zzz-no-match')).toEqual([]);
  });

  it('does not crash on a staking event with a null alias', () => {
    const withNull = mergeActivity([], [evt({ timestamp: 1, poolAlias: null, poolAddress: 'Enull' })]);
    expect(filterActivity(withNull, 'enull')).toHaveLength(1);
    expect(filterActivity(withNull, 'namaste')).toEqual([]);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 25 }, (_, i) => i);

  it('defaults to 10 per page (ACTIVITY_PER_PAGE) with correct totals', () => {
    expect(ACTIVITY_PER_PAGE).toBe(10);
    const p1 = paginate(items, 1);
    expect(p1.items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p1.total).toBe(25);
    expect(p1.totalPages).toBe(3);
    expect(p1.page).toBe(1);
  });

  it('slices the middle page', () => {
    expect(paginate(items, 2).items).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('the last page holds the remainder', () => {
    expect(paginate(items, 3).items).toEqual([20, 21, 22, 23, 24]);
  });

  it('clamps an out-of-range page down to the last valid page', () => {
    const p = paginate(items, 999);
    expect(p.page).toBe(3);
    expect(p.items).toEqual([20, 21, 22, 23, 24]);
  });

  it('clamps a page below 1 up to page 1', () => {
    expect(paginate(items, 0).page).toBe(1);
    expect(paginate(items, -5).page).toBe(1);
  });

  it('an empty list yields exactly 1 empty page, never 0', () => {
    const p = paginate([], 1);
    expect(p.totalPages).toBe(1);
    expect(p.page).toBe(1);
    expect(p.items).toEqual([]);
    expect(p.total).toBe(0);
  });

  it('respects a custom page size', () => {
    const p = paginate(items, 1, 5);
    expect(p.items).toHaveLength(5);
    expect(p.totalPages).toBe(5);
  });

  it('does not sort — preserves the caller-provided order', () => {
    expect(paginate([3, 1, 2], 1).items).toEqual([3, 1, 2]);
  });
});
