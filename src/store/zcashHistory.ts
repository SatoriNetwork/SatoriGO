// The store's history read path for the active Zcash wallet
// (docs/design/zcash-engine.md §6.3, §6.5, §10, §15 Set C). Maps the
// snapshot's own history rows (from Set B's refreshZcash / reader.ts,
// already parsed and classified) plus this wallet's own not-yet-confirmed
// local sends (zcashSend.ts §6.5) into the generic LiveTransaction[] shape
// every other chain's Activity screen already reads. Mirrors
// moneroHistory.ts in spirit: pure transform of data another module already
// fetched, never a network call of its own, never throws.
//
// UNLIKE moneroHistory.ts, there is no open host to read from: the snapshot
// this reads (`zcash.snapshot`, Set D's slice) is the SAME one
// refreshZcashWallet (zcashBalances.ts) already populated this refresh tick,
// so calling this costs nothing extra.

import { useLiveStore } from './liveStore';
import { classifySend, type ZcashTxRecord } from '../services/chain/zcash/reader';
import { formatZec, parseZec } from '../services/chain/zcash/fees';
import { loadLocalZcashSends, type ZcashLocalSend } from './zcashSend';
import type { LiveTransaction } from '../services/chain/electrumProvider';

/** bigint zatoshi -> whole-ZEC number, via the exact decimal string
 *  (formatZec) rather than a raw division — same boundary discipline
 *  moneroHistory.ts's toWholeXmr uses (never on the send/balance path,
 *  display only). Exact for any realistic wallet: Number stays lossless far
 *  past a Zcash balance any gateway-scanned wallet is near in v1. */
function toWholeZec(zat: bigint): number {
  const neg = zat < 0n;
  const abs = neg ? -zat : zat;
  const n = parseFloat(formatZec(abs));
  return neg ? -n : n;
}

/** `walletId`'s public watch addresses, but ONLY when it is genuinely the
 *  ACTIVE Zcash wallet — the same "stale caller" guard moneroBalances.ts's
 *  openHostFor applies, so a screen left open across a wallet switch reads
 *  as "nothing to show" rather than another wallet's history. Only used to
 *  pick the COUNTERPARTY side of a history row's `addresses` list (never to
 *  decide spendability; that is Set B's job inside the snapshot itself). */
function activeWatchSet(walletId: string): Set<string> | null {
  const state = useLiveStore.getState();
  if (state.activeWalletId !== walletId) return null;
  const wallet = state.wallets.find((w) => w.id === walletId);
  if (!wallet || wallet.family !== 'zcash') return null;
  const watch = (wallet as { zcashWatch?: string[] }).zcashWatch;
  return new Set(Array.isArray(watch) ? watch : []);
}

/** One ZcashTxRecord (Set B's already-classified chain history row) -> one
 *  LiveTransaction. `addresses` holds every address the row touches; the
 *  counterparty shown is the first one that is NOT ours, matching how a
 *  self-transfer (every address ours) falls back to the first address rather
 *  than an empty box. */
export function toLiveTransaction(tx: ZcashTxRecord, ours: ReadonlySet<string>): LiveTransaction {
  const spent = tx.sent > 0n || (tx.fee ?? 0n) > 0n;
  const net = spent ? tx.sent - tx.received : tx.received;
  const counterparty = tx.addresses.find((a) => !ours.has(a)) ?? tx.addresses[0] ?? '';
  return {
    txid: tx.txid,
    asset: 'ZEC',
    direction: spent ? 'out' : 'in',
    amount: toWholeZec(net < 0n ? 0n : net),
    // What THIS wallet paid: the fee of its own send, nothing on a receipt —
    // fee is known only for our own sends (§6.3).
    feeEvr: spent && tx.fee !== null ? toWholeZec(tx.fee) : 0,
    status: tx.height !== null ? 'confirmed' : 'pending',
    blockHeight: tx.height ?? undefined,
    // A history row carries no wall-clock time of its own (§6.3's /txs
    // answer is {hex, height}); "now" is as good an ordering key as any
    // other chain's history gets for a row with no timestamp, and it only
    // ever affects same-block ordering since blockHeight sorts first below.
    timestamp: Date.now(),
    counterparty,
  };
}

/** A recorded ZEC figure -> zat, 0 when absent or unreadable. */
function zatOfRecorded(v: string | undefined): bigint {
  if (!v) return 0n;
  try {
    return parseZec(v);
  } catch {
    return 0n;
  }
}

/** One not-yet-confirmed local send -> a pending LiveTransaction row, using
 *  the display figures recorded at broadcast time (zcashSend.ts) rather than
 *  re-parsing `hex`. The amount is what LEFT the wallet, fee included: the
 *  same figure the chain's own row shows once it confirms (toLiveTransaction:
 *  sent minus change), and the convention every other chain's native send row
 *  follows (liveStore.ts localPendingFromPlan). */
function localSendToLiveTransaction(send: ZcashLocalSend): LiveTransaction {
  const feeZat = zatOfRecorded(send.feeZec);
  return {
    txid: send.txid,
    asset: 'ZEC',
    direction: 'out',
    amount: toWholeZec(zatOfRecorded(send.amountZec) + feeZat),
    feeEvr: toWholeZec(feeZat),
    status: 'pending',
    timestamp: send.sentAt,
    counterparty: send.to ?? '',
  };
}

/**
 * This wallet's local sends the snapshot now reports as EXPIRED (§4.5, §6.5):
 * the tip passed their expiry height without them confirming, so they can
 * never be mined and the funds never left. Activity's row list does not show
 * them (a LiveTransaction has no failed state); the store keeps them in
 * `zcash.expiredSends` and the home screen shows a "not sent, send again"
 * notice until the user dismisses it (dismissExpiredZcashSends). Never
 * throws; [] when this is not the active Zcash wallet or nothing has loaded.
 */
export async function expiredZcashSends(walletId: string): Promise<ZcashLocalSend[]> {
  const ours = activeWatchSet(walletId);
  if (!ours) return [];
  const snapshot = useLiveStore.getState().zcash.snapshot;
  if (!snapshot) return [];
  const localSends = await loadLocalZcashSends(walletId);
  return localSends.filter(
    (send) => classifySend({ txid: send.txid, expiryHeight: send.expiryHeight }, snapshot) === 'expired',
  );
}

/**
 * History of the active Zcash wallet, newest first: the snapshot's own
 * confirmed rows, plus this wallet's local sends that have not yet appeared
 * in it. A local send the snapshot now reports as EXPIRED (§4.5, §6.5) is
 * dropped from the rows rather than shown pending forever; expiredZcashSends
 * above is what surfaces it to the user. Never throws: with no snapshot
 * loaded yet (never refreshed, or a non-Zcash wallet active) this answers an
 * empty list, the same "nothing to show" shape Activity already renders for
 * an offline wallet.
 */
export async function refreshZcashHistory(walletId: string): Promise<LiveTransaction[]> {
  const ours = activeWatchSet(walletId);
  if (!ours) return [];
  const snapshot = useLiveStore.getState().zcash.snapshot;
  if (!snapshot) return [];

  const rows = snapshot.history.map((tx) => toLiveTransaction(tx, ours));
  const known = new Set(rows.map((r) => r.txid));

  const localSends = await loadLocalZcashSends(walletId);
  for (const send of localSends) {
    if (known.has(send.txid)) continue; // already in the chain's own history
    const state = classifySend({ txid: send.txid, expiryHeight: send.expiryHeight }, snapshot);
    if (state === 'confirmed' || state === 'expired') continue; // confirmed-but-not-yet-in-history is rare; next refresh's history row wins either way
    rows.push(localSendToLiveTransaction(send));
    known.add(send.txid);
  }

  return rows.sort((a, b) => {
    const ap = a.status === 'pending' ? 1 : 0;
    const bp = b.status === 'pending' ? 1 : 0;
    if (ap !== bp) return bp - ap; // pending first
    const ah = a.blockHeight ?? 0;
    const bh = b.blockHeight ?? 0;
    if (ah !== bh) return bh - ah;
    return b.timestamp - a.timestamp;
  });
}
