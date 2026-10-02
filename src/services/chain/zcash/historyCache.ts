// The Zcash history cache (the Zcash engine design notes §6.3): what the
// history scan has already found, so a refresh asks lightwalletd only for the
// blocks since the last one, and a popup that opens while the gateway is down
// still shows its Activity.
//
// chrome.storage.local (through services/storage), key `zec:history:<walletId>`,
// shape { v: 1, scannedTo, activeAddresses, txs } with at most 500 records,
// oldest dropped: the discipline of evmHistoryCache.ts.
//
// WHAT IS IN IT. Public chain data only: txids, heights and the amounts the
// wallet's own addresses received and spent. Raw transaction hex is parsed and
// discarded, never stored; a record is about 200 bytes, so the cap is about
// 100 KB. No key, no phrase, nothing that is not already on the chain. Not in
// the encrypted backup file (a rescan rebuilds it in seconds), and deleted with
// the wallet (liveWallet.removeWallet calls deleteZcashHistory).
//
// NOT A SOURCE OF TRUTH. A missing, corrupt or foreign-shaped entry reads as
// null and costs one full scan; a storage failure on save is swallowed (the
// next successful refresh saves again).

import { getStorage } from '../../storage';
import type { ZcashTxRecord } from './reader';

export interface ZcashHistoryCache {
  v: 1;
  /** Highest block height the scan has covered for EVERY address in
   *  `activeAddresses` (0 = nothing scanned yet). */
  scannedTo: number;
  /** Watch-set addresses that have ever held funds or appeared in the mempool.
   *  Kept so a fully spent address is not forgotten (§6.3). */
  activeAddresses: string[];
  /** Newest first, at most ZCASH_HISTORY_CAP. */
  txs: ZcashTxRecord[];
}

export const ZCASH_HISTORY_CAP = 500;

export function zcashHistoryKey(walletId: string): string {
  if (typeof walletId !== 'string' || !walletId || walletId.length > 200) throw new Error('A Zcash history cache needs a wallet id.');
  return `zec:history:${walletId}`;
}

/** A fresh, empty cache: what a wallet with no saved entry starts from. */
export function emptyZcashHistory(): ZcashHistoryCache {
  return { v: 1, scannedTo: 0, activeAddresses: [], txs: [] };
}

// --- stored form: bigints travel as decimal strings ------------------------

interface StoredRecord {
  txid: string;
  height: number | null;
  version: number | 'unknown';
  received: string;
  sent: string;
  fee: string | null;
  addresses: string[];
  coinbase: boolean;
  own?: [number, string][];
}

interface StoredCache {
  v: 1;
  scannedTo: number;
  activeAddresses: string[];
  txs: StoredRecord[];
}

const DEC = /^[0-9]{1,19}$/;
const T_ADDRESS_RE = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;

function toStored(r: ZcashTxRecord): StoredRecord {
  const s: StoredRecord = {
    txid: r.txid,
    height: r.height,
    version: r.version,
    received: r.received.toString(),
    sent: r.sent.toString(),
    fee: r.fee === null ? null : r.fee.toString(),
    addresses: [...r.addresses],
    coinbase: r.coinbase,
  };
  if (r.ownOutputs && r.ownOutputs.length) s.own = r.ownOutputs.map((o) => [o.index, o.valueZat.toString()]);
  return s;
}

/** One stored record back to the real thing, or null when it is not a shape
 *  this build wrote. A bad record is dropped, never guessed at. */
function fromStored(v: unknown): ZcashTxRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.txid !== 'string' || !o.txid || o.txid.length > 100) return null;
  const height = o.height === null ? null : typeof o.height === 'number' && Number.isSafeInteger(o.height) && o.height >= 0 ? o.height : undefined;
  if (height === undefined) return null;
  const version = o.version === 'unknown' ? 'unknown' : typeof o.version === 'number' && Number.isInteger(o.version) ? o.version : undefined;
  if (version === undefined) return null;
  if (typeof o.received !== 'string' || !DEC.test(o.received)) return null;
  if (typeof o.sent !== 'string' || !DEC.test(o.sent)) return null;
  if (o.fee !== null && (typeof o.fee !== 'string' || !DEC.test(o.fee))) return null;
  if (!Array.isArray(o.addresses) || !o.addresses.every((a) => typeof a === 'string')) return null;
  if (typeof o.coinbase !== 'boolean') return null;
  const rec: ZcashTxRecord = {
    txid: o.txid,
    height,
    version,
    received: BigInt(o.received),
    sent: BigInt(o.sent),
    fee: o.fee === null ? null : BigInt(o.fee as string),
    addresses: (o.addresses as string[]).slice(0, 20),
    coinbase: o.coinbase,
  };
  if (Array.isArray(o.own)) {
    const own: { index: number; valueZat: bigint }[] = [];
    for (const x of o.own) {
      if (!Array.isArray(x) || x.length !== 2) return null;
      const [index, value] = x as unknown[];
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return null;
      if (typeof value !== 'string' || !DEC.test(value)) return null;
      own.push({ index, valueZat: BigInt(value) });
    }
    if (own.length) rec.ownOutputs = own;
  }
  return rec;
}

/** Newest first: unconfirmed/unknown heights (null) on top, then by height
 *  descending, txid as a stable tie-break. */
export function sortZcashRecords(txs: readonly ZcashTxRecord[]): ZcashTxRecord[] {
  return [...txs].sort((a, b) => {
    const ah = a.height === null ? Number.MAX_SAFE_INTEGER : a.height;
    const bh = b.height === null ? Number.MAX_SAFE_INTEGER : b.height;
    if (ah !== bh) return bh - ah;
    return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
  });
}

/** Sorted newest first and cut to the cap (the oldest go). */
export function capZcashHistory(txs: readonly ZcashTxRecord[]): ZcashTxRecord[] {
  return sortZcashRecords(txs).slice(0, ZCASH_HISTORY_CAP);
}

/** The saved entry, or null (absent, unreadable, or a shape this build does
 *  not know). */
export async function loadZcashHistory(walletId: string): Promise<ZcashHistoryCache | null> {
  let key: string;
  try {
    key = zcashHistoryKey(walletId);
  } catch {
    return null;
  }
  try {
    const v = await getStorage().get<unknown>(key);
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (o.v !== 1) return null;
    if (typeof o.scannedTo !== 'number' || !Number.isSafeInteger(o.scannedTo) || o.scannedTo < 0) return null;
    if (!Array.isArray(o.activeAddresses) || !Array.isArray(o.txs)) return null;
    const activeAddresses = [...new Set(o.activeAddresses.filter((a): a is string => typeof a === 'string' && T_ADDRESS_RE.test(a)))];
    const txs: ZcashTxRecord[] = [];
    for (const raw of o.txs) {
      const r = fromStored(raw);
      // One unreadable record means the entry was not written by this build
      // (or was damaged): start over rather than show a partial history.
      if (!r) return null;
      txs.push(r);
    }
    return { v: 1, scannedTo: o.scannedTo, activeAddresses, txs: capZcashHistory(txs) };
  } catch {
    return null;
  }
}

/** Persist (best effort; a storage failure is not a history failure). */
export async function saveZcashHistory(walletId: string, cache: ZcashHistoryCache): Promise<void> {
  let key: string;
  try {
    key = zcashHistoryKey(walletId);
  } catch {
    return;
  }
  const stored: StoredCache = {
    v: 1,
    scannedTo: Number.isSafeInteger(cache.scannedTo) && cache.scannedTo > 0 ? cache.scannedTo : 0,
    activeAddresses: [...new Set(cache.activeAddresses)],
    txs: capZcashHistory(cache.txs).map(toStored),
  };
  try {
    await getStorage().set(key, stored);
  } catch {
    /* ignore: the next successful refresh saves again */
  }
}

/** Drop the entry (wallet removed). Best effort. */
export async function deleteZcashHistory(walletId: string): Promise<void> {
  let key: string;
  try {
    key = zcashHistoryKey(walletId);
  } catch {
    return;
  }
  try {
    await getStorage().remove(key);
  } catch {
    /* ignore */
  }
}
