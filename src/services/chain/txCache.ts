// Local transaction cache for fast incremental refresh.
//
// Persists classified LiveTransaction[] per address via getStorage() so that a
// refresh only fetches (and classifies) transactions that are NEW or whose
// height changed since the last time. The first load classifies everything in
// the address history; every subsequent load reuses the cache and touches only
// the delta — so it is much faster.
//
// CSP-safe: this module only uses getStorage() and the small provider hook
// below; it never opens a socket or touches the ElectrumClient directly.

import { getStorage } from '../storage';
import type { LiveTransaction } from './electrumProvider';

/** The light history item the cache diffs against (tx_hash + confirmation
 *  height only; height<=0 means mempool/pending). Structurally compatible with
 *  ElectrumHistoryItem, so `ElectrumWalletDataProvider.getAddressHistory` fits
 *  without any adaptor. */
export interface TxHistoryItem {
  tx_hash: string;
  height: number;
}

/** The minimal surface the cache needs from a live provider. Both methods are
 *  implemented by ElectrumWalletDataProvider; keeping the cache behind this
 *  interface lets tests inject a trivial fake and keeps the cache decoupled
 *  from the ElectrumClient. */
export interface TransactionCacheProvider {
  /** Light history (tx_hash + height), no per-tx classification. */
  getAddressHistory(address: string): Promise<TxHistoryItem[]>;
  /** Fetch + classify ONE transaction relative to `address`. */
  classifyTxHash(
    address: string,
    txHash: string,
    height: number,
  ): Promise<LiveTransaction | null>;
}

const CACHE_VERSION = 1;

/** Persisted shape under `txcache:<address>`. `knownHeights` records the last
 *  seen height per tx_hash (the authority for "have we classified this?") so a
 *  tx that classified to null isn't re-fetched every refresh, and a pending tx
 *  is re-classified precisely when its height changes. */
interface TxCacheEntry {
  version: typeof CACHE_VERSION;
  txs: LiveTransaction[];
  knownHeights: Record<string, number>;
}

function cacheKey(address: string): string {
  return `txcache:${address}`;
}

/** Sort classified txs: pending (mempool) first, then confirmed by height desc. */
function compareLiveTx(a: LiveTransaction, b: LiveTransaction): number {
  const aPending = a.status === 'pending';
  const bPending = b.status === 'pending';
  if (aPending && !bPending) return -1;
  if (!aPending && bPending) return 1;
  return (b.blockHeight ?? 0) - (a.blockHeight ?? 0);
}

/** Read + validate the cache entry for an address; returns null when absent,
 *  unreadable, or a different version (forward/backward-incompatible). */
async function readCache(address: string): Promise<TxCacheEntry | null> {
  try {
    const raw = await getStorage().get<TxCacheEntry>(cacheKey(address));
    if (!raw || raw.version !== CACHE_VERSION || !Array.isArray(raw.txs)) return null;
    const knownHeights =
      raw.knownHeights && typeof raw.knownHeights === 'object' ? raw.knownHeights : {};
    return { version: CACHE_VERSION, txs: raw.txs, knownHeights };
  } catch {
    return null;
  }
}

/** Returns the cached classified transactions for an address (or [] if none). */
export async function getCachedTransactions(address: string): Promise<LiveTransaction[]> {
  const entry = await readCache(address);
  return entry ? entry.txs : [];
}

/**
 * Incrementally refresh the cache for an address.
 *
 * 1. Fetch light history (tx_hash + height).
 * 2. Diff against `knownHeights`: classify ONLY tx_hashes we have never seen,
 *    plus any previously-seen tx whose height changed (e.g. pending→confirmed).
 * 3. Merge the freshly classified txs over the cached ones, prune anything no
 *    longer in history (dropped/replaced mempool txs), sort, persist, return.
 *
 * Resilient: if the history fetch fails, the existing cache is returned intact.
 * A per-tx classification failure just leaves that tx for the next refresh — it
 * never wipes successfully cached transactions.
 */
export async function refreshTransactionCache(
  address: string,
  provider: TransactionCacheProvider,
): Promise<LiveTransaction[]> {
  const existing = await readCache(address);
  const cachedTxs = existing?.txs ?? [];
  const knownHeights: Record<string, number> = { ...(existing?.knownHeights ?? {}) };

  // Light history fetch. On failure keep the cache intact (resilience).
  let history: TxHistoryItem[];
  try {
    history = await provider.getAddressHistory(address);
  } catch {
    return cachedTxs;
  }

  // Index cached txs by txid; this map is mutated as we classify new ones.
  const byTxid = new Map<string, LiveTransaction>();
  for (const tx of cachedTxs) byTxid.set(tx.txid, tx);

  // Decide which tx_hashes to (re)classify: unseen, or a changed height.
  const toClassify: TxHistoryItem[] = [];
  const historyTxids = new Set<string>();
  for (const item of history) {
    historyTxids.add(item.tx_hash);
    const seenHeight = knownHeights[item.tx_hash];
    const heightChanged = seenHeight !== undefined && seenHeight !== item.height;
    if (seenHeight === undefined || heightChanged) {
      toClassify.push(item);
    }
  }

  // Classify only the delta. Record the height even when classification returns
  // null (so a genuinely no-op tx isn't refetched forever); a per-tx failure is
  // swallowed so it retries next refresh without losing the rest.
  for (const item of toClassify) {
    try {
      const classified = await provider.classifyTxHash(address, item.tx_hash, item.height);
      if (classified) {
        byTxid.set(item.tx_hash, classified);
      } else {
        byTxid.delete(item.tx_hash);
      }
      knownHeights[item.tx_hash] = item.height;
    } catch {
      // Keep any existing cached version of this tx; retry on the next refresh.
    }
  }

  // Prune txs (and heights) no longer present in history — dropped/replaced
  // mempool txs — so the cache tracks the current on-chain history.
  for (const txid of Array.from(byTxid.keys())) {
    if (!historyTxids.has(txid)) byTxid.delete(txid);
  }
  for (const txid of Object.keys(knownHeights)) {
    if (!historyTxids.has(txid)) delete knownHeights[txid];
  }

  const merged = Array.from(byTxid.values()).sort(compareLiveTx);

  const entry: TxCacheEntry = { version: CACHE_VERSION, txs: merged, knownHeights };
  try {
    await getStorage().set(cacheKey(address), entry);
  } catch {
    // Persisting is best-effort; still return the freshly merged view.
  }

  return merged;
}
