// Local transaction cache for fast incremental refresh.
//
// Persists classified LiveTransaction[] per address via getStorage() so that a
// refresh only fetches (and classifies) transactions that are NEW or whose
// height changed since the last time. The first load classifies everything in
// the address history; every subsequent load reuses the cache and touches only
// the delta — so it is much faster.
//
// Fast + interruption-safe for LARGE histories (e.g. Satori pool-reward wallets
// with thousands of small txs — the case that used to make first sync take tens
// of minutes and never finish because a popup close / auto-lock wiped all
// progress). Two properties make that bearable:
//   - Newest-first: the delta is classified mempool-first then by height DESC,
//     so recent activity lands in the cache first (what the user cares about).
//   - Concurrent + CHECKPOINTED: txs are classified in small concurrent batches
//     and the cache is persisted every CHECKPOINT_EVERY classified txs (not only
//     at the very end). `knownHeights` already records which tx_hashes are done,
//     so an interrupted run RESUMES from the last checkpoint on the next refresh
//     instead of restarting from zero.
// An optional onProgress hook reports classification progress (done / total) so
// the UI can show a first-sync indicator.
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

/** How many txs are classified concurrently per batch. Small enough to stay kind
 *  to the Electrum server (each classify may fetch prevouts too), large enough to
 *  cut the wall-clock time of a big first sync well below the old serial loop. */
const CLASSIFY_BATCH_SIZE = 5;

/** Persist a CHECKPOINT after this many freshly classified txs (= 4 batches of
 *  CLASSIFY_BATCH_SIZE). Bounds how much progress a mid-sync interruption
 *  (auto-lock / popup close) can cost to at most this many re-classifications. */
const CHECKPOINT_EVERY = 20;

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
 *    The delta is ordered newest-first (mempool, then height DESC) so recent
 *    activity is classified before old history.
 * 3. Classify the delta in small concurrent batches, persisting a CHECKPOINT
 *    every CHECKPOINT_EVERY txs so an interrupted run resumes instead of
 *    restarting. Merge over the cached txs, prune anything no longer in history
 *    (dropped/replaced mempool txs), sort, persist the final view, return.
 *
 * `onProgress` (optional) is invoked as (done, total) after each batch, where
 * `total` is the number of txs to classify this run; it is also called once with
 * (0, total) before the first batch when there is anything to do (total > 0).
 *
 * Resilient: if the history fetch fails, the existing cache is returned intact.
 * A per-tx classification failure just leaves that tx for the next refresh — it
 * never wipes successfully cached transactions. Because the cache is checkpointed
 * during the run, a mid-sync interruption (auto-lock / popup close) loses at most
 * the last partial checkpoint, not the whole sync.
 */
export async function refreshTransactionCache(
  address: string,
  provider: TransactionCacheProvider,
  onProgress?: (done: number, total: number) => void,
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

  // Newest-first: mempool (height<=0) first, then confirmed by height DESC, so
  // the txs the user is most likely to look for are classified (and checkpointed)
  // before the long tail of old history.
  toClassify.sort((a, b) => {
    const aMempool = a.height <= 0;
    const bMempool = b.height <= 0;
    if (aMempool && !bMempool) return -1;
    if (!aMempool && bMempool) return 1;
    return b.height - a.height;
  });

  // Persist the current (possibly-partial) view. Used both for mid-run
  // checkpoints and the final write; best-effort so it never throws.
  const persist = async (): Promise<void> => {
    const entry: TxCacheEntry = {
      version: CACHE_VERSION,
      txs: Array.from(byTxid.values()).sort(compareLiveTx),
      knownHeights,
    };
    try {
      await getStorage().set(cacheKey(address), entry);
    } catch {
      // Persisting is best-effort; the in-memory view is still returned/continued.
    }
  };

  const total = toClassify.length;
  if (total > 0) onProgress?.(0, total);

  // Classify the delta in small concurrent batches. Record the height even when
  // classification returns null (so a genuinely no-op tx isn't refetched forever);
  // a per-tx failure (rejected settle) is swallowed so it retries next refresh
  // without losing the rest. Checkpoint every CHECKPOINT_EVERY classified txs.
  let sinceCheckpoint = 0;
  for (let i = 0; i < total; i += CLASSIFY_BATCH_SIZE) {
    const batch = toClassify.slice(i, i + CLASSIFY_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((item) => provider.classifyTxHash(address, item.tx_hash, item.height)),
    );
    results.forEach((res, j) => {
      const item = batch[j];
      if (res.status === 'fulfilled') {
        if (res.value) {
          byTxid.set(item.tx_hash, res.value);
        } else {
          byTxid.delete(item.tx_hash);
        }
        knownHeights[item.tx_hash] = item.height;
      }
      // rejected: keep any existing cached version of this tx; retry next refresh.
    });

    const done = Math.min(i + batch.length, total);
    onProgress?.(done, total);

    sinceCheckpoint += batch.length;
    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      await persist();
      sinceCheckpoint = 0;
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

  // Final write (after pruning). Always persist so the pruned + fully-classified
  // view is the resume point for the next refresh.
  await persist();

  return merged;
}
