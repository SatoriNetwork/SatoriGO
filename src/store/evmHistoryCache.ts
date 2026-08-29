// A persistent, per chain + address cache of EVM Activity rows (owner's
// report, 2026-08-19: "I have no EVM history any more, only 'the BNB Chain
// history service refused the request'; should it not be saved and only the
// newest fetched?"). Yes:
//
//   * What the indexer last answered is KEPT in chrome.storage.local, so a
//     fresh popup, a switched account, or an indexer that is down / throttled
//     right now still shows the rows it had, with a notice that they may be
//     stale, instead of an empty list and an error.
//   * Each refresh asks the indexer only for transfers SINCE the highest block
//     it already knows (minus a small overlap for reorgs), merges, and saves.
//     On a keyed provider that turns two 100-row queries plus ten receipts per
//     minute into two near-empty queries, which is also what keeps the account
//     under Alchemy's per-second compute budget.
//
// Rows are the store's own LiveTransaction objects (plain numbers and strings,
// JSON-safe). The cache is advisory: a wrong or missing entry only costs one
// full fetch.

import type { LiveTransaction } from '../services/chain/electrumProvider';
import type { StakingCallInfo } from '../services/chain/evm/cosmosStaking';
import { getStorage } from '../services/storage';

export interface EvmHistoryCacheEntry {
  /** Rows newest first, exactly what Activity shows. */
  rows: LiveTransaction[];
  /** Highest confirmed block among `rows` (0 when none). */
  highestBlock: number;
  /** Epoch ms of the last SUCCESSFUL indexer read these rows reflect. */
  fetchedAt: number;
}

/** Most rows kept per chain + address: enough history for Activity's pages,
 *  small enough that a dozen accounts never weigh on extension storage. */
export const EVM_HISTORY_CACHE_MAX_ROWS = 200;
/** Blocks re-asked below the highest known one: a small reorg or a lagging
 *  indexer must not lose a transfer that landed "just before" the watermark. */
export const EVM_HISTORY_REFETCH_OVERLAP_BLOCKS = 20;

export function evmHistoryCacheKey(chainKey: string, address: string): string {
  return `evmHistory:${chainKey}:${address.toLowerCase()}`;
}

function isEntry(v: unknown): v is EvmHistoryCacheEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.rows) && typeof o.highestBlock === 'number' && typeof o.fetchedAt === 'number';
}

// --- the ONE field of a row that is not JSON-safe -------------------------
//
// A staking row carries `amountBase` as a bigint, because it is money and every
// amount in this wallet is exact. Neither JSON.stringify nor chrome.storage can
// hold a bigint: the first THROWS and the second refuses, and either would lose
// the whole history entry, not just the label. So the amount is written as a
// decimal string and read back as a bigint at exactly this boundary, and
// nothing above it ever sees the string form.

type StoredStaking = Omit<StakingCallInfo, 'amountBase'> & { amountBase?: string };
type StoredRow = Omit<LiveTransaction, 'staking'> & { staking?: StoredStaking };

function toStoredRow(row: LiveTransaction): StoredRow {
  if (!row.staking) return row as StoredRow;
  const s = row.staking;
  const staking: StoredStaking = { kind: s.kind, validator: s.validator };
  if (s.validatorDst !== undefined) staking.validatorDst = s.validatorDst;
  if (s.amountBase !== undefined) staking.amountBase = s.amountBase.toString();
  return { ...row, staking };
}

/** A stored staking block back to the real thing, or null when the saved shape
 *  is not one this build wrote (an older or a corrupted entry). A row whose
 *  label cannot be read comes back UNLABELLED rather than mislabelled. */
function fromStoredStaking(v: unknown): StakingCallInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== 'stake' && kind !== 'unstake' && kind !== 'redelegate' && kind !== 'claim') return null;
  if (typeof o.validator !== 'string' || o.validator === '') return null;
  const out: StakingCallInfo = { kind, validator: o.validator };
  if (typeof o.validatorDst === 'string' && o.validatorDst !== '') out.validatorDst = o.validatorDst;
  // Only a plain non-negative integer string: anything else is dropped rather
  // than turned into a number the transaction never carried.
  if (typeof o.amountBase === 'string' && /^[0-9]+$/.test(o.amountBase)) out.amountBase = BigInt(o.amountBase);
  return out;
}

function fromStoredRow(row: LiveTransaction): LiveTransaction {
  if (row.staking === undefined) return row;
  const staking = fromStoredStaking(row.staking);
  const next: LiveTransaction = { ...row };
  if (staking) next.staking = staking;
  else delete next.staking;
  return next;
}

/** The saved entry, or null (absent, unreadable, or a shape we do not know). */
export async function loadEvmHistoryCache(chainKey: string, address: string): Promise<EvmHistoryCacheEntry | null> {
  try {
    const v = await getStorage().get<unknown>(evmHistoryCacheKey(chainKey, address));
    if (!isEntry(v)) return null;
    return { ...v, rows: v.rows.map(fromStoredRow) };
  } catch {
    return null;
  }
}

/** Persist (best effort; a storage failure is not a history failure). */
export async function saveEvmHistoryCache(chainKey: string, address: string, entry: EvmHistoryCacheEntry): Promise<void> {
  try {
    await getStorage().set(evmHistoryCacheKey(chainKey, address), { ...entry, rows: entry.rows.map(toStoredRow) });
  } catch {
    /* ignore: the next successful read saves again */
  }
}

/** Identity of a row for merging: one tx can legitimately produce several
 *  Activity rows (a native leg and a token leg, or two token legs), so the txid
 *  alone is not the key. */
function rowKey(t: LiveTransaction): string {
  return `${t.txid}|${t.asset}|${t.direction}|${t.counterparty}|${t.amount}`;
}

/** Highest confirmed block across rows (0 when none are confirmed). */
export function highestBlockOf(rows: readonly LiveTransaction[]): number {
  let h = 0;
  for (const r of rows) if (typeof r.blockHeight === 'number' && r.blockHeight > h) h = r.blockHeight;
  return h;
}

/** The block to ask the indexer from, given a cache: the watermark minus the
 *  overlap, never below 0; undefined without a cache (ask for everything). */
export function sinceBlockFor(cache: EvmHistoryCacheEntry | null): bigint | undefined {
  if (!cache || cache.highestBlock <= 0) return undefined;
  return BigInt(Math.max(0, cache.highestBlock - EVM_HISTORY_REFETCH_OVERLAP_BLOCKS));
}

/**
 * Merge freshly indexed rows over cached ones. Fresh wins on identity (its
 * status / fee / height are the newer truth); a cached PENDING row whose txid
 * the fresh list now carries confirmed is dropped in favour of the fresh one;
 * the rest of the cache survives. Newest first, capped.
 */
export function mergeEvmHistory(
  cached: readonly LiveTransaction[],
  fresh: readonly LiveTransaction[],
  /** Row cap. The default is what gets SAVED, and it is deliberately modest.
   *  The "Load older" path passes a larger one because those pages live in
   *  memory for the session only and are never written here: a user paging back
   *  through years of history must not turn into an ever-growing entry in the
   *  extension's shared storage quota. */
  max: number = EVM_HISTORY_CACHE_MAX_ROWS,
): LiveTransaction[] {
  const freshTxids = new Set(fresh.map((t) => t.txid));
  const out = new Map<string, LiveTransaction>();
  for (const t of fresh) out.set(rowKey(t), t);
  for (const t of cached) {
    if (t.status === 'pending' && freshTxids.has(t.txid)) continue;
    const k = rowKey(t);
    if (!out.has(k)) {
      out.set(k, t);
      continue;
    }
    // The fresh row wins on everything EXCEPT a decoded staking label. That
    // label is not something the indexer can answer (on a cosmos/evm chain the
    // history source carries no calldata at all), it was bought with one
    // eth_getTransactionByHash, and it is what makes this entry "fetched ONCE
    // ever" rather than once per refresh. A fresh row that carries its own
    // label keeps it.
    //
    // The fee is deliberately NOT on that list: the fresh row's fee is the real
    // gasUsed x gasPrice the chain charged, and it must always beat the local
    // estimate a just-broadcast row was built with.
    const merged = out.get(k) as LiveTransaction;
    if (t.staking && !merged.staking) {
      out.set(k, { ...merged, staking: t.staking });
    } else if (
      t.staking &&
      merged.staking &&
      merged.staking.amountBase === undefined &&
      t.staking.amountBase !== undefined &&
      // Only when the two labels describe the SAME call. An amount is money;
      // moving one from a cached label onto a fresh label of another kind, or
      // naming another validator, would be a figure the transaction never had.
      t.staking.kind === merged.staking.kind &&
      t.staking.validator === merged.staking.validator
    ) {
      // A CLAIM's amount comes from its receipt, not its calldata, so a fresh
      // row that decoded its own calldata still arrives without one. Losing the
      // cached figure here would buy the same receipt again on every refresh.
      out.set(k, { ...merged, staking: { ...merged.staking, amountBase: t.staking.amountBase } });
    }
  }
  return [...out.values()]
    .sort((a, b) => {
      const ap = a.status === 'pending' ? 1 : 0;
      const bp = b.status === 'pending' ? 1 : 0;
      if (ap !== bp) return bp - ap; // pending first
      const ah = a.blockHeight ?? 0;
      const bh = b.blockHeight ?? 0;
      if (ah !== bh) return bh - ah;
      return (b.timestamp ?? 0) - (a.timestamp ?? 0);
    })
    .slice(0, max);
}

/** Row cap for the list HELD ON SCREEN once the user has paged back through
 *  older history. Ten pages of 100 is far past what anyone scrolls in one
 *  session, and it bounds the memory a single account can take. Nothing past
 *  EVM_HISTORY_CACHE_MAX_ROWS is ever written to storage. */
export const EVM_HISTORY_IN_MEMORY_MAX_ROWS = 1000;
