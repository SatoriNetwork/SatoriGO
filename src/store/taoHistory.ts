// The store's history read path for a Bittensor account (Bittensor engine
// design §15 Set C).
//
// THE OWNER'S 2026-09-28 OVERRIDE (design §1) governs this whole file: NO
// Taostats fetch in v1. Activity for TAO is the transfers SENT from this
// wallet, recorded locally the moment they are submitted, plus (rendered by
// LiveReceiveTao.tsx — see the Set C report) a per-address link to
// taostats.io for full history. Incoming transfers are never listed; the
// balance is always correct because it comes straight from the node
// (taoBalances.ts), never from this cache.
//
// Set B's services/chain/substrate/historyClient.ts (which landed after this
// file's first draft — see the Set C report) already owns the local cache
// itself: storage, normalization/cap, read-modify-write serialization,
// recordTaoSend, updateTaoSend and taoTransferFromPlan. This file's only job
// is the STORE-shaped read (walletId -> LiveTransaction[], the same contract
// every other chain's Activity screen already reads), so it is a thin mapper
// over Set B's real functions rather than a second implementation of them.
// taoSend.ts (this same Set) calls Set B's recordTaoSend/updateTaoSend
// directly for the same reason — see its file header.

import { loadTaoHistory } from '../services/chain/substrate';
import type { TaoTransfer } from '../services/chain/substrate';
import type { LiveTransaction } from '../services/chain/electrumProvider';
import { formatTao } from '../services/chain/substrate';

/** bigint rao -> whole-TAO number, via the exact decimal string (formatTao)
 *  rather than a raw division, the same boundary rule moneroHistory.ts uses
 *  for piconero. `Number` is lossless up to 2^53 rao (~9,007,199 TAO), far
 *  past any balance this wallet needs to display as a history row. */
function toWholeTao(rao: bigint): number {
  const sign = rao < 0n ? -1 : 1;
  return parseFloat(formatTao(rao < 0n ? -rao : rao)) * sign;
}

/** One locally-recorded TaoTransfer -> one LiveTransaction row. Set B's
 *  `status` (written by taoSend.ts from pollTaoInclusion's result) is the
 *  source of truth; `block > 0` is kept only as a fallback for a row from
 *  before `status` existed on disk (a fresh install never has one). */
function toLiveTransaction(tx: TaoTransfer): LiveTransaction {
  const confirmed = tx.status ? tx.status === 'included' : tx.block > 0;
  return {
    txid: tx.hash,
    asset: 'TAO',
    // v1 lists sends only (the override): every row here is this wallet's
    // own outgoing transfer.
    direction: 'out',
    amount: toWholeTao(tx.amount),
    feeEvr: toWholeTao(tx.fee),
    status: confirmed ? 'confirmed' : 'pending',
    blockHeight: tx.block > 0 ? tx.block : undefined,
    timestamp: tx.timestamp,
    counterparty: tx.to,
  };
}

/**
 * Local send history for `walletId`, newest first. Never throws: a read
 * failure (corrupt/missing storage) answers an empty list — loadTaoHistory
 * itself already degrades this way, so this wrapper only maps the shape.
 */
export async function refreshTaoHistory(walletId: string): Promise<LiveTransaction[]> {
  const rows = await loadTaoHistory(walletId);
  return rows.map(toLiveTransaction).sort((a: LiveTransaction, b: LiveTransaction) => b.timestamp - a.timestamp);
}

/** Re-exported for callers that need the shape without importing the
 *  substrate barrel just for one type. */
export type { TaoTransfer };
