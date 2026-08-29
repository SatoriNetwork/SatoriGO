// A persistent, per chain + address cache of the ASSET ROWS the wallet last
// read, and the merge rule that keeps a failed or partial read from blanking
// them (owner's report, 2026-08-25: "w portfelu popup extension nie zawsze
// laduja sie wszystkie tokeny ktore byly, tylko czasami jeden glowny").
//
// WHAT WENT WRONG. The popup is torn down and rebuilt every time it opens, so
// the store starts each session at `assets: []`. Every "keep what we had"
// fallback in the refresh path (`assets: result.assets ?? get().assets`) was
// therefore keeping nothing on the FIRST read of a session. When that first
// read failed the whole way through (proven live on 2026-08-25: the gateway
// answers a burst with HTTP 429, the rpc client retries twice, and a gateway
// build has exactly one endpoint to fail over to), the list collapsed to the
// single synthesized native row computeDisplayedAssets falls back to. That is
// the "only the main coin" the owner saw, and it is why this cache exists: the
// last known rows are on disk, so they are on screen before the network is
// asked, and a failed read leaves them there.
//
// The second half of the same defect is a PARTIAL read. A token whose
// balanceOf did not answer is skipped by the provider (a skipped row is
// correct: showing it as 0 would be a lie), and the store then committed the
// short list as if it were complete. mergeBalanceRows below is what stops
// that: a row the wallet already knew only leaves the list when a read that
// answered for it says it is gone.
//
// Rows are LiveAssetBalance objects, whose `amountBase` is a bigint: neither
// JSON.stringify nor chrome.storage can hold one, so it is written as a
// decimal string and read back at exactly this boundary (the same treatment
// evmHistoryCache.ts gives a staking amount). The cache is advisory: a wrong
// or missing entry costs one ordinary refresh.

import type { LiveAssetBalance } from '../services/chain/electrumProvider';
import { getStorage } from '../services/storage';

export interface BalanceCacheEntry {
  /** The rows as the last successful (or partial) read left them. */
  rows: LiveAssetBalance[];
  /** Epoch ms of the read these rows reflect. */
  fetchedAt: number;
}

/** Most rows kept per chain + address. An address holding more tokens than
 *  this is already past what the list can usefully show, and the cap is what
 *  keeps a dozen accounts from weighing on extension storage. */
export const BALANCE_CACHE_MAX_ROWS = 100;

export function balanceCacheKey(chainId: string, address: string): string {
  return `balances:${chainId}:${address.toLowerCase()}`;
}

interface StoredRow {
  name: string;
  amountBase: string;
  scale: number;
  decimals: number;
  isNative: boolean;
}

function toStoredRow(row: LiveAssetBalance): StoredRow {
  return {
    name: row.name,
    amountBase: row.amountBase.toString(),
    scale: row.scale,
    decimals: row.decimals,
    isNative: row.isNative,
  };
}

/** One stored row back to a LiveAssetBalance, or null when the saved shape is
 *  not one this build wrote. A row whose AMOUNT cannot be read is dropped
 *  rather than shown at a number the chain never reported. */
function fromStoredRow(v: unknown): LiveAssetBalance | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name === '') return null;
  if (typeof o.amountBase !== 'string' || !/^[0-9]+$/.test(o.amountBase)) return null;
  if (typeof o.scale !== 'number' || !Number.isInteger(o.scale) || o.scale < 0 || o.scale > 255) return null;
  if (typeof o.decimals !== 'number' || !Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 255) return null;
  return {
    name: o.name,
    amountBase: BigInt(o.amountBase),
    scale: o.scale,
    decimals: o.decimals,
    isNative: o.isNative === true,
  };
}

/** The saved entry, or null (absent, unreadable, or a shape we do not know). */
export async function loadBalanceCache(chainId: string, address: string): Promise<BalanceCacheEntry | null> {
  try {
    const v = await getStorage().get<unknown>(balanceCacheKey(chainId, address));
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (!Array.isArray(o.rows) || typeof o.fetchedAt !== 'number') return null;
    const rows = o.rows.map(fromStoredRow).filter((r): r is LiveAssetBalance => r !== null);
    if (rows.length === 0) return null;
    return { rows, fetchedAt: o.fetchedAt };
  } catch {
    return null;
  }
}

/** Persist (best effort; a storage failure is not a balance failure). */
export async function saveBalanceCache(chainId: string, address: string, rows: readonly LiveAssetBalance[]): Promise<void> {
  try {
    await getStorage().set(balanceCacheKey(chainId, address), {
      rows: rows.slice(0, BALANCE_CACHE_MAX_ROWS).map(toStoredRow),
      fetchedAt: Date.now(),
    });
  } catch {
    /* ignore: the next successful read saves again */
  }
}

/**
 * Drop every saved entry belonging to `addresses`, on every chain (a removed
 * wallet). Swept by ADDRESS rather than by (chain, address) pairs because one
 * EVM account is the same address on every EVM chain and a UTXO wallet can be
 * derived onto several: the address is what the removal is really about, and a
 * caller that had to enumerate chains would silently miss one. Returns how many
 * entries were dropped. Best effort; a storage failure is not a removal
 * failure.
 */
export async function clearBalanceCaches(addresses: readonly string[]): Promise<number> {
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  if (wanted.size === 0) return 0;
  try {
    const storage = getStorage();
    const keys = await storage.keys();
    const doomed = keys.filter((k) => {
      if (!k.startsWith('balances:')) return false;
      const sep = k.lastIndexOf(':');
      return sep > 'balances:'.length - 1 && wanted.has(k.slice(sep + 1));
    });
    for (const key of doomed) await storage.remove(key);
    return doomed.length;
  } catch {
    return 0;
  }
}

/**
 * The rows to show, given what the wallet already knew and what a read just
 * answered.
 *
 * THE RULE (owner, 2026-08-25): a failed or partial read never blanks a token
 * the wallet already knew about. A row disappears only when a read that
 * ANSWERED FOR IT says the balance is gone.
 *
 * `complete` is that distinction and nothing else. TRUE means every asset the
 * read was asked about came back, so `fresh` replaces the list outright and a
 * token whose balance is gone drops out exactly as it always did. FALSE means
 * at least one asset did not answer, so the short list is additive: fresh rows
 * win where they exist, and every other row the wallet already had keeps its
 * last known figure instead of vanishing.
 *
 * Order: `fresh` first, in its own order (the provider puts the native coin
 * first), then the retained rows in the order they had. Pure, so the store and
 * the tests share it.
 */
export function mergeBalanceRows(
  previous: readonly LiveAssetBalance[],
  fresh: readonly LiveAssetBalance[],
  complete: boolean,
): LiveAssetBalance[] {
  if (complete) return [...fresh];
  const freshNames = new Set(fresh.map((r) => r.name));
  const retained = previous.filter((r) => !freshNames.has(r.name));
  if (retained.length === 0) return [...fresh];
  return [...fresh, ...retained];
}
