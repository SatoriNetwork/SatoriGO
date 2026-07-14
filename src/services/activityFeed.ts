// Activity feed — pure merge / filter / paginate for the Home Activity tab.
//
// The Activity list is a MERGE of two sources:
//   1. on-chain transactions (LiveTransaction, from electrumProvider), and
//   2. locally-recorded Satori pool staking events (join / leave). Pool
//      join/leave are real user actions but exist only server-side (no history
//      endpoint), so we record them locally at the moment they succeed and fold
//      them into the same timeline here.
//
// Everything in this module is PURE + exported (no I/O, no store access) so the
// UI and the unit tests share the exact same behavior. Rendering + the store's
// persistence live elsewhere.

import type { LiveTransaction } from './chain/electrumProvider';

/** A locally-recorded Satori pool staking event (join or leave). Persisted per
 *  wallet by the store; there is no server history endpoint for these. */
export interface StakingEvent {
  type: 'pool-join' | 'pool-leave';
  /** The pool the wallet joined / left. */
  poolAddress: string;
  /** Human alias of the pool at the time of the action, when known. */
  poolAlias?: string | null;
  /** How many of the wallet's addresses were (de)registered by this action. */
  addressCount: number;
  /** Epoch millis when the action succeeded (drives timeline ordering). */
  timestamp: number;
}

/** A transaction row in the merged activity feed. */
export interface TxActivityItem {
  kind: 'tx';
  /** Stable de-dupe / React key. */
  id: string;
  /** Epoch millis used for the desc sort. */
  timestamp: number;
  tx: LiveTransaction;
}

/** A staking-event row in the merged activity feed. */
export interface StakingActivityItem {
  kind: 'staking';
  id: string;
  timestamp: number;
  event: StakingEvent;
}

/** One row of the merged activity feed — either a tx or a staking event. */
export type ActivityItem = TxActivityItem | StakingActivityItem;

/** Stable id for a staking event (no server id exists, so we derive one from its
 *  own fields — unique enough for a React key and de-dupe within one wallet). */
function stakingEventId(e: StakingEvent): string {
  return `stk-${e.type}-${e.poolAddress}-${e.timestamp}`;
}

/**
 * Merge on-chain transactions and locally-recorded staking events into ONE list
 * ordered by timestamp descending (most recent first). Ties break by putting
 * transactions before staking events, then by id, so the order is fully
 * deterministic. Pure + exported for tests.
 */
export function mergeActivity(
  txs: LiveTransaction[],
  events: StakingEvent[],
): ActivityItem[] {
  const items: ActivityItem[] = [
    ...txs.map(
      (tx): TxActivityItem => ({ kind: 'tx', id: tx.txid, timestamp: tx.timestamp, tx }),
    ),
    ...events.map(
      (event): StakingActivityItem => ({
        kind: 'staking',
        id: stakingEventId(event),
        timestamp: event.timestamp,
        event,
      }),
    ),
  ];
  return items.sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    // Same timestamp: tx before staking, then a stable id tiebreak.
    if (a.kind !== b.kind) return a.kind === 'tx' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Case-insensitive substring filter over a merged activity list. An empty /
 * whitespace query returns the list unchanged. Matches, per row:
 *   - tx:      asset name, txid, counterparty address.
 *   - staking: the literal word "pool", the pool alias, and the pool address.
 * Pure + exported for tests.
 */
export function filterActivity(items: ActivityItem[], query: string): ActivityItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => haystackFor(item).includes(q));
}

/** The lowercase searchable text for one activity row. */
function haystackFor(item: ActivityItem): string {
  if (item.kind === 'tx') {
    const { asset, txid, counterparty } = item.tx;
    return `${asset} ${txid} ${counterparty}`.toLowerCase();
  }
  const { poolAlias, poolAddress } = item.event;
  // "pool" is always searchable so a user can type it to see all staking rows.
  return `pool ${poolAlias ?? ''} ${poolAddress}`.toLowerCase();
}

/** One page of activity plus the metadata the UI needs for Prev/Next + "X of Y". */
export interface Page<T> {
  /** The items on THIS page (shorter than pageSize on the last page). */
  items: T[];
  /** 1-based current page, clamped to [1, totalPages]. */
  page: number;
  /** Total number of pages (at least 1, even for an empty list). */
  totalPages: number;
  /** Total number of items BEFORE pagination (after any filtering). */
  total: number;
}

/** Default number of activity rows per page (matches the staking pool list). */
export const ACTIVITY_PER_PAGE = 10;

/**
 * Generic 1-based pagination. `page` is clamped into range so a stale
 * out-of-range page (e.g. after a search narrows the list) never yields an
 * empty page when a valid one exists. Does NOT sort — callers pass an
 * already-ordered list. Pure + exported; shared by the activity tab (and
 * general enough to reuse elsewhere).
 */
export function paginate<T>(items: T[], page: number, pageSize: number = ACTIVITY_PER_PAGE): Page<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (clamped - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page: clamped, totalPages, total };
}
