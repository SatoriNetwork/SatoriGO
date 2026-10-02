// The store's history read path for the open Monero wallet (§15 Set C). Maps
// the wallet's own scan (host.history(), MoneroTxRecord[]) into the generic
// LiveTransaction[] shape every other chain's Activity screen already reads —
// see design §10 Activity: "straight from the wallet's own scan; there is no
// indexer and no honest-empty-state to design, the scan IS the history."
//
// A NOTE ON PRECISION: LiveTransaction.amount is a display `number` in WHOLE
// units (every other chain's history row already is — see electrumProvider.ts).
// MoneroTxRecord's own amounts are exact `bigint` piconero, per §9's rule that
// XMR amounts are never a `number` "1 XMR is already past 2^40". That rule
// governs the SEND/BALANCE path (moneroSend.ts, moneroBalances.ts), where a
// lost bit is lost money; here the bigint is converted ONCE, at the boundary
// into a display-only field an existing screen already expects and already
// renders with plain `number` formatting for every other chain. The conversion
// itself is exact for any realistic wallet: `Number` is lossless up to 2^53
// piconero (~9,007 XMR), a total no gateway-scanned Satori wallet is remotely
// near in v1.

import { useLiveStore } from './liveStore';
import type { MoneroWalletHost, MoneroTxRecord } from '../services/chain/monero/scanner';
import { formatXmr } from '../services/chain/monero/fees';
import type { LiveTransaction } from '../services/chain/electrumProvider';

const XMR_DECIMALS = 12;
const PICONERO_PER_XMR = 1_000_000_000_000;

/** bigint piconero -> whole-XMR number, via the exact decimal string
 *  (formatXmr) rather than a raw `Number(pico) / 1e12` division: going through
 *  the same text `parseFloat` reads keeps this boundary consistent with how
 *  every OTHER chain's history already turns base units into a display number
 *  (see mergeTransactions.ts / electrumProvider.ts, which do the same via
 *  sats / 1e8). Never used on the send/balance path — see the file header. */
function toWholeXmr(pico: bigint): number {
  return parseFloat(formatXmr(pico < 0n ? -pico : pico)) * (pico < 0n ? -1 : 1);
}

function openHostFor(walletId: string): MoneroWalletHost | null {
  const host = useLiveStore.getState().monero.host;
  return host && host.walletId === walletId ? host : null;
}

/** One MoneroTxRecord -> exactly ONE LiveTransaction row, keyed by its hash.
 *  A record can carry both an incoming and an outgoing amount (a self-send,
 *  or an incoming transfer wallet2 reports beside a payment out): the row
 *  shows the NET movement, the way every other chain's history already
 *  merges one transaction into one row per txid. Two rows sharing a txid
 *  collided as Activity keys and the detail screen (which finds a row by
 *  txid) could only ever open the first of them.
 *
 *  Direction: anything this wallet spent (an outgoing amount, or a fee it
 *  paid) makes the row a send, with the amount net of what came back;
 *  otherwise it is a receipt of the incoming amount. */
export function toLiveTransaction(tx: MoneroTxRecord): LiveTransaction {
  const timestamp = tx.timestamp ?? Date.now();
  const status: LiveTransaction['status'] = tx.height !== null && tx.confirmations > 0 ? 'confirmed' : 'pending';
  const spent = tx.outgoing > 0n || tx.fee > 0n;
  const net = spent ? tx.outgoing - tx.incoming : tx.incoming;
  return {
    txid: tx.hash,
    asset: 'XMR',
    direction: spent ? 'out' : 'in',
    amount: toWholeXmr(net < 0n ? 0n : net),
    // What THIS wallet paid: the fee of its own send, nothing on a receipt
    // (the sender's fee is not ours).
    feeEvr: spent ? toWholeXmr(tx.fee) : 0,
    status,
    blockHeight: tx.height ?? undefined,
    timestamp,
    // Monero has no visible counterparty address (that is the point of the
    // protocol: ring signatures hide the other side). The field stays EMPTY
    // rather than carrying a placeholder that the detail screen would
    // truncate and offer to copy; the screen words the absence itself.
    counterparty: '',
  };
}

/**
 * History of the OPEN Monero wallet, newest first. Never throws: with no open
 * host (locked, or a non-Monero wallet active) or a read failure, this answers
 * an empty list — the same "nothing to show" shape Activity already renders
 * for an offline UTXO wallet, never a thrown error the screen would have to
 * catch specially.
 */
export async function refreshMoneroHistory(walletId: string): Promise<LiveTransaction[]> {
  const host = openHostFor(walletId);
  if (!host) return [];
  let records: MoneroTxRecord[];
  try {
    records = await host.history();
  } catch {
    return [];
  }
  return records
    .map(toLiveTransaction)
    .sort((a, b) => b.timestamp - a.timestamp);
}

// Re-exported for callers that need the exact scale without importing
// moneroChains.ts just for one number (kept in sync with MoneroChainInfo.nativeDecimals).
export { XMR_DECIMALS, PICONERO_PER_XMR };
