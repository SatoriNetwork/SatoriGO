// The Bittensor send path (Bittensor engine design §15 Set C): plan, then
// broadcast. This file is a THIN UI-shaped wrapper: Set B's
// services/chain/substrate/sender.ts (which landed after this file's first
// draft — see the Set C report) already owns everything money-shaped —
// planTaoSend (runtime guard, checkpoint, nonce, sign, fee, fee cap, the
// below-minimum/bad-call checks), sendTaoPlan (rebuild-when-stale,
// pre-flight-with-one-rebuild, the fee-changed and insufficient checks,
// submit) and pollTaoInclusion. This file's job is the same as
// evmSend.ts/moneroSend.ts's: turn screen-shaped text into a call Set B
// understands, and turn Set B's plan into the strings the review screen
// shows — never re-implement what Set B already does.
//
// A DELIBERATE DEVIATION FROM THE DESIGN'S LITERAL §15 SIGNATURES, flagged
// here and in the Set C report: the design shows
//   buildTaoSendPlan(input: TaoSendInput): Promise<TaoSendPlanView>
//   broadcastTaoPlan(view: TaoSendPlanView): Promise<{ hash: string }>
// with no account/rpc argument, the same shape moneroSend.ts uses (reading
// the open host straight out of the `monero` liveStore slice). Substrate has
// no such host: signing needs the SubstrateAccount (mini secret) that only
// LiveWalletService.substrateAccountOfActive() can produce (design §15 Set D
// surface), and only liveStore.ts ever holds that service instance (confirmed
// by reading the codebase: evmSend.ts's broadcastEvmPlan takes its `sign`
// callback as an explicit argument for exactly this reason, injected by
// liveStore.ts's `svc.signEvmTransaction`; no store or screen file anywhere
// else touches LiveWalletService directly). So these two functions take an
// explicit `TaoSendDeps` argument that Set D's liveStore.ts is expected to
// build as `{ rpc: taoRpcClient(), account: svc.substrateAccountOfActive(),
// walletId }` right before calling them — the EVM pattern, not the Monero
// one.
//
// ERRORS: this file re-throws Set B's own `TaoSendError` (codes: 'bad-call',
// 'below-minimum', 'fee-too-high', 'fee-changed', 'payment', 'insufficient',
// 'invalid', 'rejected') and `TaoRuntimeChangedError` unchanged rather than
// wrapping them in a second, competing error type — Set B's codes and
// messages are already what a review/error screen needs. This file adds its
// own errors ONLY for checks that happen before a call exists at all
// (garbage recipient text, unparsable amount).

import type {
  SubstrateAccount,
  TaoRuntimeProfile,
  TaoRpc,
  TaoSendPlan as SubstrateSendPlan,
  TransferCall,
  TaoInclusion,
} from '../services/chain/substrate';
import {
  planTaoSend,
  sendTaoPlan,
  pollTaoInclusion,
  recordTaoSend,
  updateTaoSend,
  loadTaoHistory,
  pendingTaoSends,
  inclusionTargetOf,
  taoTransferFromPlan,
  parseTao,
  formatTao,
  isValidTaoAddress,
  ss58Decode,
  TaoSendError,
  TaoRuntimeChangedError,
  TAO_PROFILE,
  TAO_SS58_PREFIX,
} from '../services/chain/substrate';
import { taoFeeWithMargin } from '../services/chain/substrate/fees';

export { TaoSendError, TaoRuntimeChangedError };

export interface TaoSendInput {
  to: string;
  /** As typed. Ignored when `sweep` is true (MAX is `transfer_all`, not a
   *  computed amount — design §4.5: "a 'send everything, close the account'
   *  is not offered", so this always keeps the account open). */
  amount: string;
  sweep: boolean;
}

export interface TaoSendPlan {
  plan: SubstrateSendPlan;
  /** Recipient, exactly as validated (trimmed SS58). Carried here (rather
   *  than re-derived from `plan`) so the local history record does not need
   *  to decode the extrinsic back apart. */
  to: string;
  sweep: boolean;
  /** The amount used to build the call (0 for a sweep: transfer_all's exact
   *  payout is computed on-chain). Set B's `plan.account.spendable - plan.fee`
   *  is the display/record ESTIMATE for a sweep, computed in buildTaoSendPlan. */
  amountRao: bigint;
  feeTao: string;
  amountTao: string;
  /** amount + fee, formatted — what leaves the free balance. For a sweep this
   *  reads as a note rather than a number, matching how Monero's sweep
   *  display works (the exact payout is not knowable client-side). */
  totalTao: string;
  /** Non-fatal notes the review screen shows above Confirm & Send (e.g. the
   *  ED-dust note on a sweep, or a shortfall Set B will refuse at broadcast).
   *  A reason the send CANNOT proceed at ALL is thrown, never put here. */
  warnings: string[];
}

/** What the caller must supply so this file never needs its own handle on
 *  LiveWalletService or the store — see the file header. */
export interface TaoSendDeps {
  rpc: TaoRpc;
  account: SubstrateAccount;
  /** Defaults to the pinned TAO_PROFILE (design §4.1); a caller only ever
   *  overrides this in a test, against a fixture profile. */
  profile?: TaoRuntimeProfile;
  /** For recordTaoSend/updateTaoSend after a successful broadcast. */
  walletId: string;
}

function resolveProfile(deps: Pick<TaoSendDeps, 'profile'>): TaoRuntimeProfile {
  return deps.profile ?? TAO_PROFILE;
}

/**
 * Build a plan: validate the recipient's TEXT (SS58 prefix 42 only, design
 * §9) and the amount's text before anything reaches the network, build the
 * call, then hand off to Set B's planTaoSend for everything money-shaped
 * (runtime guard, checkpoint, nonce, sign, fee, the below-minimum and fee-cap
 * checks). Throws Set B's TaoSendError / TaoRuntimeChangedError for anything
 * a caller must show inline, and a plain Error only for text that never
 * reaches a call (garbage amount text).
 */
export async function buildTaoSendPlan(deps: TaoSendDeps, input: TaoSendInput): Promise<TaoSendPlan> {
  const to = input.to.trim();
  if (!isValidTaoAddress(to)) {
    throw new TaoSendError('bad-call', 'Enter a valid Bittensor address (an SS58 address starting with 5).');
  }

  let rao = 0n;
  if (!input.sweep) {
    try {
      rao = parseTao(input.amount);
    } catch (err) {
      throw new TaoSendError('bad-call', err instanceof Error ? err.message : 'Enter a valid amount.');
    }
    if (rao <= 0n) {
      throw new TaoSendError('bad-call', 'Enter an amount greater than 0.');
    }
  }

  const dest = ss58Decode(to, TAO_SS58_PREFIX).publicKey;
  const call: TransferCall = input.sweep
    ? { kind: 'transfer_all', dest, keepAlive: true }
    : { kind: 'transfer_keep_alive', dest, rao };

  // planTaoSend validates the call is sendable (below-minimum, bad-call), runs
  // the runtime guard (throws TaoRuntimeChangedError on 'layout-changed'), and
  // refuses a fee over the cap (fee-too-high) — none of that is duplicated
  // here.
  const plan = await planTaoSend({ rpc: deps.rpc, account: deps.account, profile: resolveProfile(deps), call });

  const warnings: string[] = [];
  if (input.sweep) {
    warnings.push(
      "Sends the rest of your balance and keeps the account open with Bittensor's minimum balance (0.0000005 TAO).",
    );
  }
  if (to === deps.account.address) {
    warnings.push('The recipient is this same wallet.');
  }
  if (plan.shortfall > 0n) {
    // A typed amount that does not leave room for the fee is refused HERE,
    // in the form, with the largest amount that does fit: sendTaoPlan would
    // refuse it at Confirm anyway, and typing the whole "Available" figure
    // (which is before the fee) then read as "the wallet cannot send"
    // (owner, 2026-10-02). A sweep never has a shortfall of its own.
    if (!input.sweep) {
      const room = plan.account.spendable - taoFeeWithMargin(plan.fee);
      throw new TaoSendError(
        'insufficient',
        room > 0n
          ? `Not enough TAO for this amount plus the network fee (${formatTao(plan.fee)} TAO). You can send up to ${formatTao(room)} TAO, or use Max to send the rest.`
          : `Not enough TAO to pay the network fee (${formatTao(plan.fee)} TAO).`,
      );
    }
    warnings.push('This transfer and its fee may be more than your spendable balance.');
  }

  // A sweep's exact payout is only known on-chain; the review shows a
  // sentence rather than a number (see TaoSendPlan.amountTao), but the local
  // history record still needs a bigint estimate — the same one Set B's
  // taoShortfall math is built on: spendable minus the fee, never negative.
  const sweepEstimate = plan.account.spendable > plan.fee ? plan.account.spendable - plan.fee : 0n;

  return {
    plan,
    to,
    sweep: input.sweep,
    amountRao: input.sweep ? sweepEstimate : rao,
    feeTao: formatTao(plan.fee),
    amountTao: input.sweep ? 'the rest of your balance' : formatTao(rao),
    totalTao: input.sweep ? 'the rest of your balance' : formatTao(rao + plan.fee),
    warnings,
  };
}

/**
 * Relay an already-built plan through Set B's sendTaoPlan (rebuild-if-stale,
 * pre-flight with one rebuild on a nonce race, the fee-changed and
 * insufficient checks, submit), record the send locally (pending), and start
 * (fire-and-forget) polling for inclusion so the local record can be updated
 * to its final state. No arming/caps logic lives here (matching
 * moneroSend.ts): the mainnet arming gate is the screen's own checkbox +
 * password step.
 *
 * `onInclusion`, if given, is called once with the poll's final result
 * ('included' or 'expired') — how the caller (LiveSendTao.tsx) drives the
 * "waiting for inclusion" -> resolved UI state without this file needing a
 * store handle. A failure inside the poll itself (network trouble) is
 * swallowed: the submit already succeeded, and the local row stays 'pending'
 * for a later refresh to catch up.
 */
export async function broadcastTaoPlan(
  deps: TaoSendDeps,
  view: TaoSendPlan,
  onInclusion?: (inclusion: TaoInclusion) => void,
): Promise<{ hash: string }> {
  const result = await sendTaoPlan(
    { rpc: deps.rpc, account: deps.account, profile: resolveProfile(deps), call: view.plan.call },
    view.plan,
  );

  const row = taoTransferFromPlan(result.plan, view.amountRao, result.hash);
  await recordTaoSend(deps.walletId, row).catch(() => {
    // A failed local-history write must never fail an already-broadcast send.
  });

  trackTaoInclusion(
    { rpc: deps.rpc, walletId: deps.walletId, address: deps.account.address },
    { signed: result.plan.signed },
    undefined,
    onInclusion,
    result.hash,
  );

  return { hash: result.hash };
}

// --- inclusion polls that outlive the send screen ----------------------------
//
// A poll started by broadcastTaoPlan dies with the page: an MV3 popup closes
// on any click outside it, and the success screen auto-returns after a few
// seconds. The local row would then stay 'pending' forever, and a send whose
// era ran out would never be marked 'expired' (design §4.5 step 8: "not
// included, send again"). So every poll is registered here by hash, and the
// store's refresh tick resumes one for every pending row that is not already
// being polled in THIS page (resumeTaoInclusionPolls), from the finalized
// block the last poll had checked through (`checkedThrough`, written back on
// every exit so a resumed poll never re-walks blocks it already read).

export interface TaoPollDeps {
  rpc: TaoRpc;
  walletId: string;
  /** The sending account's SS58 address (public; no secret is needed to poll). */
  address: string;
}

const pollsInFlight = new Map<string, AbortController>();

function pollKey(walletId: string, hash: string): string {
  return `${walletId}:${hash.toLowerCase()}`;
}

/** Hashes of the sends this page is polling right now (tests, diagnostics). */
export function taoPollsInFlight(): string[] {
  return [...pollsInFlight.keys()];
}

/**
 * Poll one send to its final state and write that state back to the local
 * row. Idempotent per (wallet, hash): a poll already running for the hash is
 * left alone. A failure inside the poll itself (network trouble) is swallowed
 * and the row keeps its state for the next refresh to resume from.
 */
export function trackTaoInclusion(
  deps: TaoPollDeps,
  target: { signed: { hash: string; nonce: number; eraPeriod: number; checkpointNumber: number; hex?: string } },
  scanFrom?: number,
  onInclusion?: (inclusion: TaoInclusion) => void,
  /** The hash the local row was recorded under (sendTaoPlan's own answer);
   *  the signed target's hash when not given. */
  recordHash: string = target.signed.hash,
): void {
  const hash = recordHash;
  const key = pollKey(deps.walletId, hash);
  if (pollsInFlight.has(key)) return;
  const controller = new AbortController();
  pollsInFlight.set(key, controller);
  void pollTaoInclusion(deps.rpc, deps.address, target, controller.signal, scanFrom !== undefined ? { scanFrom } : {})
    .then((inclusion: TaoInclusion) => {
      const patch =
        inclusion.state !== 'pending'
          ? {
              status: inclusion.state,
              block: inclusion.blockNumber ?? 0,
              blockHash: inclusion.blockHash,
              extrinsicId:
                inclusion.blockNumber !== undefined && inclusion.extrinsicIndex !== undefined
                  ? `${inclusion.blockNumber}-${inclusion.extrinsicIndex}`
                  : '',
              checkedThrough: inclusion.checkedThrough,
            }
          : // Still pending (aborted, or the poll's own time budget ran out):
            // only the resume point moves, so the next poll starts where this
            // one stopped.
            inclusion.checkedThrough !== undefined
            ? { checkedThrough: inclusion.checkedThrough }
            : null;
      const written = patch ? updateTaoSend(deps.walletId, hash, patch).catch(() => []) : Promise.resolve([]);
      return written.then(() => {
        onInclusion?.(inclusion);
      });
    })
    .catch(() => {
      // Best-effort: the submit already succeeded; a poll failure leaves the
      // local row 'pending' for the next Activity refresh to resume.
    })
    .finally(() => {
      if (pollsInFlight.get(key) === controller) pollsInFlight.delete(key);
    });
}

/**
 * Resume a poll for every locally recorded send of `deps.walletId` that is
 * still 'pending' and carries what a poll needs (nonce, era, checkpoint).
 * Called from the store's Bittensor refresh tick; cheap when nothing is
 * pending (one storage read, no network call). Returns how many polls were
 * started by this call.
 */
export async function resumeTaoInclusionPolls(
  deps: TaoPollDeps,
  onInclusion?: (hash: string, inclusion: TaoInclusion) => void,
): Promise<number> {
  const rows = await loadTaoHistory(deps.walletId);
  let started = 0;
  for (const row of pendingTaoSends(rows)) {
    if (pollsInFlight.has(pollKey(deps.walletId, row.hash))) continue;
    trackTaoInclusion(deps, inclusionTargetOf(row), row.checkedThrough, (inclusion) => onInclusion?.(row.hash, inclusion));
    started++;
  }
  return started;
}

/** Stop every poll this page runs (leaving the wallet: lock, switch, remove,
 *  window close). Each poll exits 'pending' and writes its resume point back. */
export function abortTaoInclusionPolls(): void {
  for (const controller of pollsInFlight.values()) controller.abort();
}

/** Tests only: forget every registered poll (a mocked poll ignores abort). */
export function resetTaoPollsForTests(): void {
  pollsInFlight.clear();
}
