// The Monero send path (§15 Set C): plan, then broadcast. Mirrors evmSend.ts's
// shape (one builder every caller goes through, gate -> sign -> relay in
// broadcast) but everything money-shaped — decoy selection, the real fee,
// signing — happens inside monero-ts/wallet2 through the open MoneroWalletHost
// (Set B), never here. This file's job is the same as evmSend.ts's: turn
// screen-shaped text into a call the host understands, and turn the host's
// answer into a plan the review screen can only display, never re-derive.
//
// UNLIKE evmSend.ts, there is no provider/from argument: there is exactly ONE
// open Monero wallet per page (§6.3), held in the liveStore `monero` slice
// (Set D surface), and both functions here read it from there rather than
// taking it as a parameter — the send screen never touches a MoneroWalletHost
// directly.

import { useLiveStore } from './liveStore';
import type { MoneroTxDraft, MoneroWalletHost } from '../services/chain/monero/scanner';
import { assertMoneroFeeSane, formatXmr, parseXmr, type MoneroPriority } from '../services/chain/monero/fees';
import { isValidMoneroAddress } from '../services/chain/monero/address';

export interface MoneroSendInput {
  to: string;
  /** As typed. Ignored when `sweep` is true (the wallet sends everything
   *  spendable; there is no partial amount to parse). */
  amount: string;
  priority: MoneroPriority;
  sweep: boolean;
}

export interface MoneroSendPlan {
  draft: MoneroTxDraft;
  feeXmr: string;
  amountXmr: string;
  /** amount + fee, formatted — what leaves the unlocked balance. */
  totalXmr: string;
  /** Non-fatal notes the review screen shows above Confirm & Send (e.g. locked
   *  funds left out of a non-sweep send). Never blocks the send; a reason the
   *  send CANNOT proceed is thrown as a MoneroSendError instead, exactly as an
   *  insufficient-funds EVM/UTXO send never reaches its review screen either. */
  warnings: string[];
}

export class MoneroSendError extends Error {
  readonly code:
    | 'no-wallet'
    | 'invalid-address'
    | 'invalid-amount'
    | 'build-failed'
    | 'fee-unsafe'
    | 'broadcast-failed';
  constructor(code: MoneroSendError['code'], message: string) {
    super(message);
    this.name = 'MoneroSendError';
    this.code = code;
  }
}

/** The one open Monero wallet host for this page, or throws. There is nothing
 *  to "wait for" the way a UTXO chain's Electrum socket can be reconnecting:
 *  no host open means no wallet is unlocked, which the caller (Send's submit
 *  handler) should never reach in the first place — this is the last-resort
 *  guard, not the primary gate. */
function openHost(): MoneroWalletHost {
  const host = useLiveStore.getState().monero.host;
  if (!host) throw new MoneroSendError('no-wallet', 'No Monero wallet is open. Unlock your Monero wallet and try again.');
  return host;
}

/**
 * Build a plan: validate the recipient and amount, build the transaction
 * through the open wallet (createTx({relay:false}) under the hood — §10), and
 * refuse outright if wallet2 ever returns a fee above the absolute cap (§9;
 * never clamped). Throws MoneroSendError for everything else a caller must
 * show inline (bad address, unparsable amount, "not enough money" from the
 * host, an unreachable gateway).
 */
export async function buildMoneroSendPlan(input: MoneroSendInput): Promise<MoneroSendPlan> {
  const to = input.to.trim();
  // Mainnet only (§9): a stagenet/testnet or malformed address is refused
  // here, in the form, never handed to the daemon to reject later.
  if (!isValidMoneroAddress(to)) {
    throw new MoneroSendError('invalid-address', 'Enter a valid mainnet Monero address.');
  }

  let amountPico = 0n;
  if (!input.sweep) {
    try {
      amountPico = parseXmr(input.amount);
    } catch (err) {
      throw new MoneroSendError('invalid-amount', err instanceof Error ? err.message : 'Enter a valid amount.');
    }
    if (amountPico <= 0n) {
      throw new MoneroSendError('invalid-amount', 'Enter an amount greater than 0.');
    }
  }

  const host = openHost();
  let draft: MoneroTxDraft;
  try {
    draft = await host.buildTx({ to, amountPico, priority: input.priority, sweep: input.sweep });
  } catch (err) {
    throw new MoneroSendError('build-failed', err instanceof Error ? err.message : String(err));
  }

  try {
    assertMoneroFeeSane(draft.fee);
  } catch (err) {
    // Refuses, never clamps: the transaction wallet2 just built is simply
    // never offered for review. See MONERO_MAX_FEE_PICO (fees.ts).
    throw new MoneroSendError('fee-unsafe', err instanceof Error ? err.message : String(err));
  }

  const warnings: string[] = [];
  // Best-effort locked-funds note: informational only, so a failed re-read
  // here must never fail a plan the host already built successfully.
  try {
    const balance = await host.balance();
    if (!input.sweep && balance.total > balance.unlocked) {
      warnings.push(
        `${formatXmr(balance.total - balance.unlocked)} XMR of your balance is still locked and was not included in this send.`,
      );
    }
  } catch {
    // ignore — see above
  }

  return {
    draft,
    feeXmr: formatXmr(draft.fee),
    amountXmr: formatXmr(draft.amount),
    totalXmr: formatXmr(draft.amount + draft.fee),
    warnings,
  };
}

/**
 * Relay an already-built plan. No arming/caps logic lives here (unlike EVM's
 * broadcastEvmPlan): the mainnet arming gate is the screen's own checkbox +
 * password step (§10, same discipline as every other Send screen), and there
 * is no fee market to re-check at the moment of broadcast — the fee is fixed
 * the moment createTx ran, above.
 */
export async function broadcastMoneroPlan(plan: MoneroSendPlan): Promise<{ txid: string }> {
  const host = openHost();
  try {
    const txid = await host.relay(plan.draft);
    return { txid };
  } catch (err) {
    throw new MoneroSendError('broadcast-failed', err instanceof Error ? err.message : String(err));
  }
}
