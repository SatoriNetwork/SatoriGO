// Bittensor Activity for v1: the transfers SENT from this wallet, recorded
// locally when they are submitted and settled by the nonce polling of
// sender.ts (the Bittensor engine design notes, owner OVERRIDE of 2026-09-28:
// no Taostats in v1). There is no network call in this file. Incoming
// transfers are not listed; the balance is always right because it comes from
// the node, and the Activity screen links to the full history on taostats.io.
//
// WHERE. The extension's key-value storage (chrome.storage.local through
// services/storage.ts), key `taoHistory:<walletId>`. Public data only (hashes,
// addresses, amounts), capped at TAO_HISTORY_CAP rows, deleted with the
// wallet (§9), and not part of the encrypted backup file.
//
// SHAPE. Amounts are bigint rao in memory and decimal strings at rest (JSON
// and chrome.storage cannot hold a bigint); the conversion happens here and
// nowhere else. A stored row this build cannot read is dropped, never guessed.

import { getStorage } from '../../storage';
import type { TaoSendPlan } from './sender';
import { ss58Encode } from './ss58';

/** One transfer. `block` is 0 and `extrinsicId` '' until inclusion is known. */
export interface TaoTransfer {
  /** 0x blake2b-256 of the signed extrinsic, computed locally. */
  hash: string;
  block: number;
  /** ms since epoch: when it was submitted (a local record). */
  timestamp: number;
  from: string;
  to: string;
  /** rao. For a MAX send (`sweep`) the amount the review showed. */
  amount: bigint;
  /** rao: the fee the review quoted (partialFee). */
  fee: bigint;
  /** `<block>-<index>` once the block is known, else ''. */
  extrinsicId: string;
  /** Local-record fields (present on every row this build writes). */
  status?: TaoTransferStatus;
  /** The signed nonce, the era: what a resumed inclusion poll needs. */
  nonce?: number;
  eraPeriod?: number;
  checkpointNumber?: number;
  /** Highest finalized block already polled without finding the send. */
  checkedThrough?: number;
  blockHash?: string;
  /** A MAX send (`transfer_all`): the exact amount is set by the chain. */
  sweep?: boolean;
}

/** 'pending': submitted, not yet seen; 'included': in a finalized block;
 *  'expired': the era ran out (or the nonce went to another extrinsic), the
 *  transfer can never land: "not included, send again". */
export type TaoTransferStatus = 'pending' | 'included' | 'expired';

export interface TaoHistoryPage {
  rows: TaoTransfer[];
  page: number;
  hasMore: boolean;
}

/** Rows kept per wallet (§9). */
export const TAO_HISTORY_CAP = 200;

const KEY_PREFIX = 'taoHistory:';

// Read-modify-write per wallet is serialized, so a poll settling one send and
// a new send being recorded at the same moment cannot drop each other's row.
const pending = new Map<string, Promise<unknown>>();

export function taoHistoryKey(walletId: string): string {
  if (typeof walletId !== 'string' || walletId.length === 0 || walletId.length > 200) {
    throw new Error('Bittensor history: invalid wallet id.');
  }
  return `${KEY_PREFIX}${walletId}`;
}

type StoredTransfer = Omit<TaoTransfer, 'amount' | 'fee'> & { amount: string; fee: string };

const HASH_RE = /^0x[0-9a-f]{64}$/;
const UINT_RE = /^[0-9]{1,20}$/;

function isUint(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function toStored(row: TaoTransfer): StoredTransfer {
  return { ...row, amount: row.amount.toString(), fee: row.fee.toString() };
}

/** A stored row back to a TaoTransfer, or null for a shape this build did not
 *  write. Optional fields that are malformed are dropped, not the row. */
function fromStored(v: unknown): TaoTransfer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.hash !== 'string' || !HASH_RE.test(o.hash)) return null;
  if (!isUint(o.block) || !isUint(o.timestamp)) return null;
  if (typeof o.from !== 'string' || typeof o.to !== 'string' || o.from.length > 64 || o.to.length > 64) return null;
  if (typeof o.amount !== 'string' || !UINT_RE.test(o.amount) || typeof o.fee !== 'string' || !UINT_RE.test(o.fee)) return null;
  const row: TaoTransfer = {
    hash: o.hash,
    block: o.block,
    timestamp: o.timestamp,
    from: o.from,
    to: o.to,
    amount: BigInt(o.amount),
    fee: BigInt(o.fee),
    extrinsicId: typeof o.extrinsicId === 'string' && o.extrinsicId.length <= 32 ? o.extrinsicId : '',
  };
  if (o.status === 'pending' || o.status === 'included' || o.status === 'expired') row.status = o.status;
  if (isUint(o.nonce)) row.nonce = o.nonce;
  if (isUint(o.eraPeriod)) row.eraPeriod = o.eraPeriod;
  if (isUint(o.checkpointNumber)) row.checkpointNumber = o.checkpointNumber;
  if (isUint(o.checkedThrough)) row.checkedThrough = o.checkedThrough;
  if (typeof o.blockHash === 'string' && HASH_RE.test(o.blockHash)) row.blockHash = o.blockHash;
  if (o.sweep === true) row.sweep = true;
  return row;
}

/** Newest first (pending rows first among equals), one row per hash, capped. */
export function normalizeTaoHistory(rows: readonly TaoTransfer[], cap: number = TAO_HISTORY_CAP): TaoTransfer[] {
  const byHash = new Map<string, TaoTransfer>();
  for (const r of rows) {
    const k = r.hash.toLowerCase();
    if (!byHash.has(k)) byHash.set(k, { ...r, hash: k });
  }
  return [...byHash.values()]
    .sort((a, b) => {
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      const ap = a.status === 'pending' ? 1 : 0;
      const bp = b.status === 'pending' ? 1 : 0;
      return bp - ap;
    })
    .slice(0, Math.max(0, cap));
}

/** The wallet's recorded sends, newest first; [] when none or unreadable. */
export async function loadTaoHistory(walletId: string): Promise<TaoTransfer[]> {
  try {
    const v = await getStorage().get<unknown>(taoHistoryKey(walletId));
    if (!Array.isArray(v)) return [];
    const rows: TaoTransfer[] = [];
    for (const item of v) {
      const row = fromStored(item);
      if (row) rows.push(row);
    }
    return normalizeTaoHistory(rows);
  } catch {
    return [];
  }
}

/** Replace the wallet's rows (normalized and capped). A storage failure
 *  throws: the caller decides whether a lost local record matters. */
export async function saveTaoHistory(walletId: string, rows: TaoTransfer[]): Promise<void> {
  const key = taoHistoryKey(walletId);
  await getStorage().set(key, normalizeTaoHistory(rows).map(toStored));
}

export async function deleteTaoHistory(walletId: string): Promise<void> {
  const key = taoHistoryKey(walletId);
  pending.delete(key);
  await getStorage().remove(key);
}

function serialized<T>(walletId: string, fn: () => Promise<T>): Promise<T> {
  const key = taoHistoryKey(walletId);
  const prev = pending.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  pending.set(key, tail);
  void tail.then(() => {
    if (pending.get(key) === tail) pending.delete(key);
  });
  return next;
}

/** Add a send (or replace the row with the same hash). Returns the rows. */
export function recordTaoSend(walletId: string, row: TaoTransfer): Promise<TaoTransfer[]> {
  return serialized(walletId, async () => {
    const rows = await loadTaoHistory(walletId);
    const hash = row.hash.toLowerCase();
    const next = [{ ...row, hash }, ...rows.filter((r) => r.hash !== hash)];
    await saveTaoHistory(walletId, next);
    return loadTaoHistory(walletId);
  });
}

/** Merge `patch` into the row with `hash` (no-op when absent). Returns the rows. */
export function updateTaoSend(
  walletId: string,
  hash: string,
  patch: Partial<Omit<TaoTransfer, 'hash'>>,
): Promise<TaoTransfer[]> {
  return serialized(walletId, async () => {
    const rows = await loadTaoHistory(walletId);
    const h = hash.toLowerCase();
    if (!rows.some((r) => r.hash === h)) return rows;
    await saveTaoHistory(
      walletId,
      rows.map((r) => (r.hash === h ? { ...r, ...patch, hash: h } : r)),
    );
    return loadTaoHistory(walletId);
  });
}

/** The rows still waiting for inclusion that carry what a resumed poll needs
 *  (sender.ts pollTaoInclusion with `scanFrom: checkedThrough`). */
export function pendingTaoSends(rows: readonly TaoTransfer[]): Array<
  TaoTransfer & { nonce: number; eraPeriod: number; checkpointNumber: number }
> {
  return rows.filter(
    (r): r is TaoTransfer & { nonce: number; eraPeriod: number; checkpointNumber: number } =>
      r.status === 'pending' && isUint(r.nonce) && isUint(r.eraPeriod) && isUint(r.checkpointNumber),
  );
}

/** A pending row as the target pollTaoInclusion takes. */
export function inclusionTargetOf(row: TaoTransfer & { nonce: number; eraPeriod: number; checkpointNumber: number }): {
  signed: { hash: string; nonce: number; eraPeriod: number; checkpointNumber: number };
} {
  return { signed: { hash: row.hash, nonce: row.nonce, eraPeriod: row.eraPeriod, checkpointNumber: row.checkpointNumber } };
}

/**
 * The local record of a send the moment it is submitted: status 'pending',
 * block unknown, the nonce and era a resumed poll needs. `amountRao` is what
 * the review showed (for a MAX send, the spendable amount less the fee).
 */
export function taoTransferFromPlan(plan: TaoSendPlan, amountRao: bigint, hash: string = plan.signed.hash, now: number = Date.now()): TaoTransfer {
  return {
    hash: hash.toLowerCase(),
    block: 0,
    timestamp: now,
    from: plan.from,
    to: ss58Encode(plan.call.dest, plan.profile.ss58),
    amount: amountRao,
    fee: plan.fee,
    extrinsicId: '',
    status: 'pending',
    nonce: plan.signed.nonce,
    eraPeriod: plan.signed.eraPeriod,
    checkpointNumber: plan.signed.checkpointNumber,
    checkedThrough: plan.signed.checkpointNumber,
    ...(plan.call.kind === 'transfer_all' ? { sweep: true } : {}),
  };
}
