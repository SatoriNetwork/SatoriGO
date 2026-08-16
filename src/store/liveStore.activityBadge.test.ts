// The Activity badge's seen-model (node env, pure functions only).
//
// REGRESSION THIS FILE EXISTS FOR: "mark as seen" used to persist at most 400
// txids while the badge recounted the ENTIRE (unbounded) transaction list, so
// any wallet with more than 400 transactions cleared its badge on tap and got
// "9+" back on the next 20s refresh, forever. Nothing covered that behaviour.

import { describe, expect, it } from 'vitest';

import { countUnread, markSeen, type ActivitySeen } from './liveStore';
import type { LiveTransaction } from '../services/chain/electrumProvider';

/** One classified tx. height 0 == still in the mempool (pending). */
function tx(txid: string, height: number): LiveTransaction {
  return {
    txid,
    asset: 'EVR',
    direction: 'in',
    amount: 1,
    feeEvr: 0,
    status: height > 0 ? 'confirmed' : 'pending',
    blockHeight: height > 0 ? height : undefined,
    timestamp: 1_700_000_000_000,
    counterparty: 'Ecounterparty000000000000000000000',
  };
}

/** `n` confirmed txs, newest first (the order the store keeps txs in). */
function history(n: number, topHeight = 1_000_000): LiveTransaction[] {
  return Array.from({ length: n }, (_, i) => tx(`h${topHeight - i}`, topHeight - i));
}

const NOTHING_SEEN: ActivitySeen = { height: 0, txids: [] };

describe('countUnread', () => {
  it('counts everything on a wallet that has never looked', () => {
    expect(countUnread(history(5), NOTHING_SEEN)).toBe(5);
  });

  it('treats anything at or below the water mark as seen', () => {
    const txs = [tx('new', 105), tx('old', 100)];
    expect(countUnread(txs, { height: 100, txids: [] })).toBe(1);
    expect(countUnread(txs, { height: 105, txids: [] })).toBe(0);
  });

  it('counts a PENDING tx until its txid is explicitly seen (it has no height)', () => {
    const txs = [tx('pending', 0), tx('old', 100)];
    expect(countUnread(txs, { height: 999_999, txids: [] })).toBe(1);
    expect(countUnread(txs, { height: 100, txids: ['pending'] })).toBe(0);
  });

  it('counts a confirmed tx of UNKNOWN height rather than swallowing it', () => {
    const noHeight: LiveTransaction = { ...tx('weird', 100), blockHeight: undefined };
    expect(countUnread([noHeight], { height: 999_999, txids: [] })).toBe(1);
  });
});

describe('markSeen', () => {
  it('THE BUG: marking seen sticks on a wallet with far more txs than the txid cap', () => {
    // 1,000 transactions: more than the 400-txid cap that used to be the only
    // record of "seen", which is exactly when the old badge became permanent.
    const txs = history(1000);
    const seen = markSeen(txs, NOTHING_SEEN);

    // Right after marking: nothing unread.
    expect(countUnread(txs, seen)).toBe(0);
    // And it is still nothing unread on every later refresh over the same list —
    // this is the assertion that used to fail (it recounted 600 as "new").
    expect(countUnread(txs, seen)).toBe(0);
    // Storage stays bounded: the water mark carries the tail, not 1,000 ids.
    expect(seen.txids.length).toBeLessThanOrEqual(400);
    expect(seen.height).toBe(1_000_000);
  });

  it('a genuinely NEW transaction after marking is unread again', () => {
    const txs = history(1000);
    const seen = markSeen(txs, NOTHING_SEEN);
    const withNew = [tx('brand-new', 1_000_001), ...txs];
    expect(countUnread(withNew, seen)).toBe(1);
  });

  it('a PENDING tx that later CONFIRMS above the mark stays seen', () => {
    const pending = tx('p1', 0);
    const before = [pending, ...history(10, 500)];
    const seen = markSeen(before, NOTHING_SEEN);
    expect(seen.height).toBe(500);
    expect(seen.txids).toContain('p1');

    // It confirms in the next block — a height ABOVE the water mark. Without the
    // explicit txid it would re-arm the badge for a tx the user already saw.
    const after = [tx('p1', 501), ...history(10, 500)];
    expect(countUnread(after, seen)).toBe(0);
  });

  it('a REORG that re-confirms recent txs at new heights does not re-arm the badge', () => {
    const txs = history(5, 900); // heights 900..896
    const seen = markSeen(txs, NOTHING_SEEN);

    // The chain reorganises: the same transactions come back one block higher,
    // i.e. ABOVE the water mark. They are the newest txs, so they are inside the
    // boundary set and stay seen.
    const reorged = txs.map((t) => tx(t.txid, (t.blockHeight ?? 0) + 1));
    expect(countUnread(reorged, seen)).toBe(0);

    // A reorg that SHORTENS the chain must not un-see history either: the mark
    // only moves forward.
    const shorter = history(3, 880);
    expect(markSeen(shorter, seen).height).toBe(900);
  });

  it('a tx that unconfirms back into the mempool stays seen', () => {
    const txs = history(3, 700);
    const seen = markSeen(txs, NOTHING_SEEN);
    const unconfirmed = [tx('h700', 0), ...history(2, 699)];
    expect(countUnread(unconfirmed, seen)).toBe(0);
  });

  it('drops ids of txs that vanished (replaced mempool txs) so the set cannot grow forever', () => {
    const seen = markSeen([tx('replaced', 0), tx('h1', 10)], NOTHING_SEEN);
    expect(seen.txids).toContain('replaced');

    // 'replaced' never confirmed and is gone from history on the next mark.
    const next = markSeen([tx('h1', 10)], seen);
    expect(next.txids).not.toContain('replaced');
    expect(next.txids).toEqual(['h1']);
  });

  it('is a no-op when nothing is on screen yet (opened Activity mid-sync)', () => {
    const seen: ActivitySeen = { height: 42, txids: ['pending-1'] };
    expect(markSeen([], seen)).toBe(seen);
  });
});
