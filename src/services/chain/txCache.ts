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

// v2 added spentNative/totalOutNative to each classified tx (wallet-level
// aggregation needs the raw, unclamped numbers) and moved the key under the
// chain. A bump discards older entries, costing exactly one re-sync.
// KEEP THIS TIED TO THE SHAPE: change LiveTransaction, bump this.
const CACHE_VERSION = 2;

/** Hard ceiling on PERSISTED transactions per address.
 *
 *  chrome.storage.local caps the WHOLE extension (10 MB without
 *  `unlimitedStorage`), shared with the vaults and settings, and a write past
 *  the cap is rejected. An address is not hypothetically large: real Evrmore
 *  pool-reward addresses carry 40,000+ transactions, which at the measured
 *  ~340 bytes each would exceed the entire quota on their own and freeze this
 *  cache permanently. Newest are kept, matching SEEN_TX_CAP / STAKING_EVENTS_CAP
 *  elsewhere. `knownHeights` is NOT capped: it is small and it is what stops
 *  already-classified transactions being fetched again. */
const MAX_CACHED_TXS = 2000;

/** Why the most recent cache write failed, or null if it succeeded.
 *
 *  Module scope because a write failure must outlive the call that hit it: the
 *  refresh has to carry on regardless (the in-memory view is still good), but
 *  the reason must reach the UI. A silently swallowed quota rejection is exactly
 *  how this cache used to freeze forever with no symptom. */
let lastPersistError: Error | null = null;

/** The most recent cache-write failure, or null. Read by the diagnostics view so
 *  a full storage quota is visible instead of being inferred from stale data. */
export function lastCacheWriteError(): Error | null {
  return lastPersistError;
}

/**
 * Why a history fetch failed.
 *
 *   'unreachable' — we could not talk to a server at all (transport failure).
 *                   Indistinguishable from being offline, because it IS that.
 *   'refused'     — the server ANSWERED and declined this address.
 *   'too-large'   — the specific refusal every big address hits: the server
 *                   caps how much history it will return.
 *
 * The distinction is the whole point: a refusal is PERMANENT for that address on
 * that server (retrying forever changes nothing), while 'unreachable' clears
 * itself the moment the network comes back. Reporting the first as the second is
 * what left a user staring at a frozen Activity list on an online wallet with no
 * error, no banner and nothing to act on.
 */
export type HistoryFailureReason = 'unreachable' | 'refused' | 'too-large';

/** One failed history fetch, reported to the caller (and remembered below). */
export interface HistoryFetchFailure {
  /** The address whose history could not be read. */
  address: string;
  reason: HistoryFailureReason;
  /** The server's own words (or the transport error), for diagnostics. */
  message: string;
}

/** `Error.name` a provider sets when the SERVER answered and refused a history
 *  request — see ElectrumWalletDataProvider.AddressHistoryRefusedError.
 *
 *  Matched STRUCTURALLY (name + flag) rather than with `instanceof`, so this
 *  module keeps the decoupling its header promises: it never imports the
 *  provider, and a test can inject a plain fake that throws the same shape. The
 *  two are pinned together in txCache.test.ts, which throws the REAL provider
 *  error class at this code. */
const REFUSED_ERROR_NAME = 'AddressHistoryRefusedError';

/** Classify a thrown history error into a reported failure. Anything that is not
 *  an explicit server refusal is 'unreachable' — fail-safe, because treating a
 *  transport blip as a permanent refusal would nag about a healthy address. */
function classifyHistoryError(address: string, err: unknown): HistoryFetchFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === REFUSED_ERROR_NAME) {
    const tooLarge = (err as { tooLarge?: boolean }).tooLarge === true;
    return { address, reason: tooLarge ? 'too-large' : 'refused', message };
  }
  return { address, reason: 'unreachable', message };
}

/** The most recent history-fetch REFUSAL, or null when the last history fetch
 *  succeeded. Same reasoning (and same diagnostics role) as lastCacheWriteError
 *  above: the refresh carries on with the cached view, so without this the
 *  reason would die inside the catch that swallows it. 'unreachable' is NOT
 *  recorded here — that is ordinary offline, already visible in the UI. */
let lastHistoryFailure: HistoryFetchFailure | null = null;

/** The most recent history-fetch refusal, or null. */
export function lastHistoryFetchError(): HistoryFetchFailure | null {
  return lastHistoryFailure;
}

/**
 * How many txs ONE address classifies concurrently per batch.
 *
 * MEASURED 2026-08-15, read-only, against four servers on three independent
 * operators. Each run issued `blockchain.transaction.get [txid, true]` in
 * batches of N over ONE socket, exactly as the loop below does, on DISJOINT and
 * interleaved txid sets (so no run reused a transaction an earlier run had
 * warmed, and every run got the same mix of large and small ones). Each size was
 * measured twice, ascending then descending, so server drift shows up as a gap
 * between the passes instead of as a concurrency effect. ms per transaction:
 *
 *   N                       1      5     10     25     50    100
 *   EVR  satorinet       68.7   21.8   18.9   12.9   14.1   17.7   (see below)
 *   EVR  evrmorecoin.org  ---   47.0    ---   30.9   22.0   20.8
 *   LTC  cipig           38.7    8.5    4.4    2.8    1.6    1.1
 *   BTC  cipig           40.9    8.9    4.5    2.5    1.6    1.05
 *
 * ZERO errors and no throttling anywhere, at any N, on any of the four. The
 * three servers other than satorinet were stable: their two passes agree within
 * about 10%, which is why single numbers are quoted for them.
 *
 * SATORINET DRIFTED AND ITS ROW IS THE ASCENDING PASS ONLY. Its descending pass
 * ran 2x to 4x slower at EVERY size, and a second, scrambled-order run (fresh
 * socket per size) degraded monotonically by roughly 10% per run whatever the
 * size, so this is the server slowing under the probe's own traffic, not a
 * property of N. De-trended, that second run put every size from 5 to 100
 * between 92 and 133 ms/tx with no dependable ordering. So the honest reading of
 * satorinet is: past 25 there is nothing reliable left to gain, and the one
 * clean pass says 50 and 100 are worse.
 *
 * WHY 25 AND NOT 100. The chains with small transactions (LTC, BTC, ~2 KiB per
 * verbose tx) are latency-bound and keep improving to 100. The chain this
 * constant exists for does not: a Satori pool address carries ~90 KiB verbose
 * transactions, so a big first sync there is BANDWIDTH-bound, and that is where
 * the gains stop (satorinet best at 25; evrmorecoin.org gains only 1.5x more
 * between 25 and 100 while quadrupling the burst). 25 is where every server has
 * taken most of the win that exists. Against the old value of 5 that is 1.7x on
 * satorinet, 1.5x on evrmorecoin.org and about 3.4x on LTC/BTC.
 *
 * The wallet-wide ceiling below is what stops this multiplying: a refresh runs
 * one of these loops PER ADDRESS over a shared socket, so the batch size alone
 * is not the number of requests a server sees.
 */
const CLASSIFY_BATCH_SIZE = 25;

/**
 * Ceiling on classify requests in flight ACROSS EVERY ADDRESS of the wallet.
 *
 * A refresh runs refreshTransactionCache() once per receive address, all at the
 * same time and all over ONE socket, so what a server actually sees is
 * CLASSIFY_BATCH_SIZE x addressCount. A wallet may hold up to 20 receive
 * addresses, so raising the batch from 5 to 25 without a ceiling would take the
 * worst case from 100 concurrent requests to 500 — a number nothing here has
 * measured, on servers that are often one volunteer's machine.
 *
 * 100 is deliberately EXACTLY the old worst case (old batch 5 x 20 addresses),
 * so no server ever sees a burst larger than the one this wallet already sent
 * before the change, while the ordinary single-address wallet (the Satori case,
 * addressCount 1) gets the full measured 25. It is also the largest value the
 * measurements above actually cover, with zero errors on all four servers.
 */
const MAX_CONCURRENT_CLASSIFY = 100;

/** Slots currently taken, and the callers waiting for one (FIFO, so a queued
 *  address cannot be starved by a busier one). Module scope because the limit is
 *  wallet-wide: each address's refresh is a separate call with no other way to
 *  know what its siblings are doing. */
let classifyInFlight = 0;
const classifyWaiters: (() => void)[] = [];

/** Run `fn` once a wallet-wide classify slot is free, always releasing the slot.
 *  A released slot is handed STRAIGHT to the next waiter rather than being freed
 *  and re-taken, so the count cannot drift and no wake-up can be lost. */
async function withClassifySlot<T>(fn: () => Promise<T>): Promise<T> {
  if (classifyInFlight >= MAX_CONCURRENT_CLASSIFY) {
    await new Promise<void>((resolve) => classifyWaiters.push(resolve));
  } else {
    classifyInFlight++;
  }
  try {
    return await fn();
  } finally {
    const next = classifyWaiters.shift();
    if (next) next();
    else classifyInFlight--;
  }
}

/** Persist a CHECKPOINT after this many freshly classified txs (= one batch of
 *  CLASSIFY_BATCH_SIZE). Bounds how much progress a mid-sync interruption
 *  (auto-lock / popup close) can cost to at most this many re-classifications.
 *  Kept level with the batch size rather than a multiple of it: the old pairing
 *  (5 and 20) also wrote once per 20 classified txs, so the storage write rate
 *  per transaction is unchanged by the larger batch. */
const CHECKPOINT_EVERY = 25;

/** Persisted shape under `txcache:<address>`. `knownHeights` records the last
 *  seen height per tx_hash (the authority for "have we classified this?") so a
 *  tx that classified to null isn't re-fetched every refresh, and a pending tx
 *  is re-classified precisely when its height changes. */
interface TxCacheEntry {
  version: typeof CACHE_VERSION;
  txs: LiveTransaction[];
  knownHeights: Record<string, number>;
}

/** Prefix every cache key carries. The ONLY place this literal exists — key
 *  construction and the delete sweep below both go through it. */
const CACHE_KEY_PREFIX = 'txcache:';

/** Storage key for one address's cache ON ONE CHAIN.
 *
 *  The chain segment is not decorative. Address formats happen to be disjoint
 *  across the chains shipped today, but reusing Bitcoin's version bytes and hrp
 *  is the norm among forks, and the moment two chains produce the same address
 *  string a single key would blend their histories: the instant-render path
 *  shows the cache before any network call, so the user would see the other
 *  chain's transactions. Keying by chain makes that impossible by construction
 *  rather than by luck. */
function cacheKey(chainId: string, address: string): string {
  return `${CACHE_KEY_PREFIX}${chainId}:${address}`;
}

/** Inverse of cacheKey: the {chainId, address} a cache key names, or null when
 *  the key is not one of ours. The chain id is the segment up to the FIRST ':'
 *  after the prefix and the address is everything after it, so an address that
 *  ever contained a ':' would still round-trip. */
function parseCacheKey(key: string): { chainId: string; address: string } | null {
  if (!key.startsWith(CACHE_KEY_PREFIX)) return null;
  const rest = key.slice(CACHE_KEY_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { chainId: rest.slice(0, sep), address: rest.slice(sep + 1) };
}

/**
 * Delete cached histories, returning how many entries were removed.
 *
 * With no `filter`, EVERY entry on every chain goes (the full-reset case). With
 * one, only entries whose chain AND address are both listed go — that is how a
 * removed wallet's history is reclaimed without touching a sibling wallet's.
 *
 * Deletion matters because these are the largest values the extension writes:
 * chrome.storage.local caps the WHOLE extension at 10 MB (shared with the vaults
 * and settings), so a deleted wallet's thousands of cached transactions used to
 * hold that quota hostage forever, with nothing in the UI able to reclaim it.
 *
 * Best-effort and never throws: reclaiming space must not be able to break the
 * removal (or reset) it is part of.
 */
export async function clearTransactionCaches(filter?: {
  chainIds: string[];
  addresses: string[];
}): Promise<number> {
  try {
    const storage = getStorage();
    const chains = filter ? new Set(filter.chainIds) : null;
    const addresses = filter ? new Set(filter.addresses) : null;
    const keys = await storage.keys();
    let removed = 0;
    for (const key of keys) {
      const parsed = parseCacheKey(key);
      if (!parsed) continue;
      if (chains && !chains.has(parsed.chainId)) continue;
      if (addresses && !addresses.has(parsed.address)) continue;
      try {
        await storage.remove(key);
        removed++;
      } catch {
        // One stubborn key must not abandon the rest of the sweep.
      }
    }
    return removed;
  } catch {
    // Storage unavailable / keys() unsupported: nothing reclaimed, no crash.
    return 0;
  }
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
async function readCache(chainId: string, address: string): Promise<TxCacheEntry | null> {
  try {
    const raw = await getStorage().get<TxCacheEntry>(cacheKey(chainId, address));
    if (!raw || raw.version !== CACHE_VERSION || !Array.isArray(raw.txs)) return null;
    const knownHeights =
      raw.knownHeights && typeof raw.knownHeights === 'object' ? raw.knownHeights : {};
    return { version: CACHE_VERSION, txs: raw.txs, knownHeights };
  } catch {
    return null;
  }
}

/** Returns the cached classified transactions for an address (or [] if none). */
export async function getCachedTransactions(
  chainId: string,
  address: string,
): Promise<LiveTransaction[]> {
  const entry = await readCache(chainId, address);
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
 * `onHistoryError` (optional) is invoked when step 1 fails, with WHY it failed.
 * The cache is still returned intact either way, but the caller can now tell a
 * server that REFUSED this address ("history too large") from one it could not
 * reach — see HistoryFailureReason. Without it the two are the same silent
 * "returned the cache", which is how a permanently unreadable address looked
 * exactly like a healthy one on a wallet still reporting itself online.
 *
 * Resilient: if the history fetch fails, the existing cache is returned intact.
 * A per-tx classification failure just leaves that tx for the next refresh — it
 * never wipes successfully cached transactions. Because the cache is checkpointed
 * during the run, a mid-sync interruption (auto-lock / popup close) loses at most
 * the last partial checkpoint, not the whole sync.
 */
export async function refreshTransactionCache(
  chainId: string,
  address: string,
  provider: TransactionCacheProvider,
  onProgress?: (done: number, total: number) => void,
  onHistoryError?: (failure: HistoryFetchFailure) => void,
): Promise<LiveTransaction[]> {
  const existing = await readCache(chainId, address);
  const cachedTxs = existing?.txs ?? [];
  const knownHeights: Record<string, number> = { ...(existing?.knownHeights ?? {}) };

  // Light history fetch. On failure keep the cache intact (resilience) — but
  // REPORT the failure instead of swallowing it, so a refusal is actionable.
  let history: TxHistoryItem[];
  try {
    history = await provider.getAddressHistory(address);
    // A successful read clears the remembered refusal: whatever the server said
    // last time, it is answering for this address now.
    if (lastHistoryFailure?.address === address) lastHistoryFailure = null;
  } catch (err) {
    const failure = classifyHistoryError(address, err);
    if (failure.reason !== 'unreachable') lastHistoryFailure = failure;
    onHistoryError?.(failure);
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
    // Cap what gets WRITTEN, newest first. The in-memory view returned to the
    // caller is not truncated, so this run still shows everything it classified.
    const all = Array.from(byTxid.values()).sort(compareLiveTx);
    const entry: TxCacheEntry = {
      version: CACHE_VERSION,
      txs: all.length > MAX_CACHED_TXS ? all.slice(0, MAX_CACHED_TXS) : all,
      knownHeights,
    };
    try {
      await getStorage().set(cacheKey(chainId, address), entry);
      lastPersistError = null;
    } catch (err) {
      // Still best-effort (the run must continue), but NO LONGER SILENT: a
      // quota rejection used to freeze this cache permanently with nothing to
      // show for it, so the reason is kept and reported to the caller.
      lastPersistError = err instanceof Error ? err : new Error(String(err));
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
      batch.map((item) =>
        // Slot-gated: the batch size is this ADDRESS's concurrency, the slot is
        // the WALLET's. On a single-address wallet nothing ever waits.
        withClassifySlot(() => provider.classifyTxHash(address, item.tx_hash, item.height)),
      ),
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
