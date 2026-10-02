// Sending TAO (the Bittensor engine design notes §4.5): plan (runtime guard,
// era checkpoint, nonce, sign, fee), pre-flight without broadcasting, submit,
// and settle by nonce polling until inclusion or era expiry.
//
//   planTaoSend      runtime guard, finalized checkpoint, System.Account (for
//                    affordability), system_accountNextIndex, sign, fee by
//                    payment_queryInfo, fee cap. Nothing is broadcast.
//   sendTaoPlan      the whole confirm step the store runs after arm plus
//                    password: rebuild when the plan is old, pre-flight with
//                    TaggedTransactionQueue_validate_transaction, one rebuild
//                    on Stale/Future/BadProof/AncientBirthBlock, the fresh
//                    affordability check, then submit.
//   preflightTaoSend / submitTaoSend   the two network steps on their own.
//   pollTaoInclusion System.Account every 12 s at the finalized head; when the
//                    nonce passes the signed one, a bounded chain_getBlock walk
//                    over the few blocks since the last poll finds the block;
//                    at era expiry the send is "not included".
//
// SECRETS. The `SubstrateAccount` (its 32-byte mini secret) is passed in by
// the caller, used inside Set A's buildSignedExtrinsic, and never stored,
// copied or logged here; the caller zeroes it (zeroSubstrateAccount) when the
// send is over. What crosses the gateway is the public address, the signed
// extrinsic and read queries.
//
// NEVER A SECOND SUBMIT. A submit whose outcome is unknown (timeout, 502/504,
// transport) answers `status: 'unknown'` with the locally computed hash; the
// caller records the send and polls. The hash is `blake2b-256` of the signed
// bytes (Set A), never parsed from a node's answer.

import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { TaoRpcError, type TaoRpc } from './rpc';
import {
  checkRuntime,
  profileForSigning,
  readAccountInfoAt,
  readFinalizedHead,
  spendableOf,
  type TaoAccountState,
} from './reader';
import { ss58Decode } from './ss58';
import {
  buildSignedExtrinsic,
  decodeTransactionValidity,
  encodeCall,
  type SignedExtrinsic,
  type TransactionValidity,
  type TransferCall,
} from './extrinsic';
import type { SubstrateAccount } from './keys';
import type { ProfileVerdict, TaoRuntimeProfile } from './profile';
import { TAO_ERA_PERIOD } from './tao';
import { assertTaoFeeSane, formatTao, taoFeeWithMargin } from './fees';

/** A plan older than this is rebuilt (fresh checkpoint and nonce) before it
 *  is pre-flighted: era 64 at 12 s blocks is about 12.8 minutes (§4.5 step 5). */
export const TAO_PLAN_MAX_AGE_MS = 10 * 60_000;
/** Poll cadence for inclusion, one Bittensor block. */
export const TAO_POLL_INTERVAL_MS = 12_000;
/** Most blocks one inclusion search walks with chain_getBlock (§4.5 step 8:
 *  "usually one to three", never a block per poll for the whole window). */
export const TAO_INCLUSION_SCAN_MAX = 16;
/** Longest a poll loop runs before handing back 'pending': the era window
 *  (64 blocks, about 13 minutes) with room for a stalled finality gadget. */
export const TAO_POLL_MAX_WAIT_MS = 25 * 60_000;

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffffffff;

export interface TaoSendArgs {
  rpc: TaoRpc;
  account: SubstrateAccount;
  profile: TaoRuntimeProfile;
  call: TransferCall;
}

export interface TaoSendPlan {
  signed: SignedExtrinsic;
  /** `partialFee` from payment_queryInfo, rao. What the review shows. */
  fee: bigint;
  /** ms since epoch; see TAO_PLAN_MAX_AGE_MS. */
  builtAt: number;
  /** The sender's SS58 address. */
  from: string;
  /** The call as asked for (the rebuild re-encodes it). */
  call: TransferCall;
  /** The profile the payload was signed with: the pin, with the live spec and
   *  tx versions when the guard said 'version-only'. */
  profile: TaoRuntimeProfile;
  runtime: ProfileVerdict;
  /** The sender's account at the checkpoint. */
  account: TaoAccountState;
  /** rao missing for `amount + fee * (1 + margin)` (0 = affordable). The
   *  review can show it; sendTaoPlan refuses a plan with a shortfall AFTER the
   *  pre-flight, so an unfunded account sees the network's own "Payment". */
  shortfall: bigint;
}

export type TaoSendErrorCode =
  | 'bad-call' // the call is not one v1 sends (wrong dest length, u64 overflow, transfer_all without keep_alive)
  | 'below-minimum' // under the existential deposit, the receiver would be reaped
  | 'fee-too-high' // over TAO_MAX_FEE_RAO: a runtime the wallet does not understand
  | 'fee-changed' // a rebuild came back with a fee above the reviewed one plus the margin
  | 'payment' // pre-flight: Invalid(Payment), cannot pay the fee
  | 'insufficient' // fee payable, but amount plus fee exceed what may be spent
  | 'invalid' // pre-flight: any other Invalid/Unknown validity
  | 'rejected'; // the node refused the submit with a JSON-RPC error

export class TaoSendError extends Error {
  readonly code: TaoSendErrorCode;
  /** The validity the pre-flight answered, when that is why. */
  readonly validity?: TransactionValidity;
  constructor(code: TaoSendErrorCode, message: string, validity?: TransactionValidity) {
    super(message);
    this.name = 'TaoSendError';
    this.code = code;
    if (validity) this.validity = validity;
  }
}

// InvalidTransaction variant indices (sp_runtime; extrinsic.ts
// INVALID_TRANSACTION), which decodeTransactionValidity reports as `code`.
const INVALID_PAYMENT = 1;
const INVALID_FUTURE = 2;
const INVALID_STALE = 3;
const INVALID_BAD_PROOF = 4;
const INVALID_ANCIENT_BIRTH = 5;

function isInvalid(v: TransactionValidity, index: number): boolean {
  return !v.ok && v.kind === 'invalid' && v.code === index;
}

/** Pre-flight answers the design rebuilds for, once (§4.5 step 6): a nonce
 *  race (Stale, Future), a checkpoint that fell out (AncientBirthBlock), and
 *  BadProof, which on a correct signer means the payload's versions or
 *  checkpoint no longer match. */
export function isRebuildableValidity(v: TransactionValidity): boolean {
  return (
    isInvalid(v, INVALID_STALE) ||
    isInvalid(v, INVALID_FUTURE) ||
    isInvalid(v, INVALID_BAD_PROOF) ||
    isInvalid(v, INVALID_ANCIENT_BIRTH)
  );
}

export function isPaymentValidity(v: TransactionValidity): boolean {
  return isInvalid(v, INVALID_PAYMENT);
}

function amountOf(call: TransferCall): bigint {
  return call.kind === 'transfer_all' ? 0n : (call.rao ?? 0n);
}

/** What `call` needs from the spendable balance (amount plus the fee with
 *  margin), and how much of it is missing. */
export function taoShortfall(call: TransferCall, fee: bigint, spendable: bigint): bigint {
  const need = amountOf(call) + taoFeeWithMargin(fee);
  return need > spendable ? need - spendable : 0n;
}

function assertCallSendable(call: TransferCall, ed: bigint): void {
  if (!call || !(call.dest instanceof Uint8Array) || call.dest.length !== 32) {
    throw new TaoSendError('bad-call', 'The recipient is not a valid Bittensor account.');
  }
  if (call.kind === 'transfer_all') {
    // v1 never offers "send everything and close the account" (§4.5).
    if (call.keepAlive !== true) throw new TaoSendError('bad-call', 'Sending everything always keeps the account open in Satori GO.');
    return;
  }
  if (call.kind !== 'transfer_keep_alive' && call.kind !== 'transfer_allow_death') {
    throw new TaoSendError('bad-call', 'This kind of transfer is not supported.');
  }
  const rao = call.rao;
  if (typeof rao !== 'bigint' || rao <= 0n || rao > U64_MAX) {
    throw new TaoSendError('bad-call', 'The amount is not a valid TAO amount.');
  }
  if (rao < ed) {
    throw new TaoSendError('below-minimum', `The recipient must receive at least ${formatTao(ed)} TAO.`);
  }
}

function parseFee(value: unknown): bigint {
  // payment_queryInfo answers partialFee as a decimal string on current nodes
  // and as a number on older ones.
  if (typeof value === 'string' && /^[0-9]{1,20}$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(value)) return BigInt(value);
  throw new TaoRpcError('format', 'payment_queryInfo', 'The Bittensor node sent a fee that is not a number.');
}

/**
 * Build and sign a transfer against the live chain, and price it. Throws
 * `TaoRuntimeChangedError` (reader.ts) when the runtime guard refuses,
 * `TaoSendError` for a call v1 does not send or a fee over the cap, and
 * `TaoRpcError` for network trouble. Broadcasts nothing.
 */
export async function planTaoSend(args: TaoSendArgs, signal?: AbortSignal): Promise<TaoSendPlan> {
  const { rpc, account, call } = args;
  assertCallSendable(call, args.profile.existentialDeposit);

  // 1. Runtime guard (§4.4): sign only a layout this build knows.
  const check = await checkRuntime(rpc, args.profile, signal);
  const profile = profileForSigning(args.profile, check);

  // 2. The era checkpoint: the finalized head.
  const head = await readFinalizedHead(rpc, signal);

  // 3. The account at that head (balance for affordability, nonce fallback),
  //    then the nonce including the pool, read right before signing.
  const info = await readAccountInfoAt(rpc, account.publicKey, head.hash, signal);
  const next = await rpc.call<unknown>('system_accountNextIndex', [account.address], signal);
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0 || next > U32_MAX) {
    throw new TaoRpcError('format', 'system_accountNextIndex', 'The Bittensor node sent an invalid nonce.');
  }
  // Never below the finalized nonce: a node that lost its pool cannot hand us
  // a nonce already spent on chain.
  const nonce = Math.max(next, info?.nonce ?? 0);

  // 4. Encode and sign.
  const signed = buildSignedExtrinsic({
    profile,
    account,
    call: encodeCall(profile, call),
    nonce,
    tip: 0n,
    eraPeriod: TAO_ERA_PERIOD,
    checkpointNumber: head.number,
    checkpointHash: hexToBytes(head.hash.slice(2)),
  });

  // 5. The fee, from the runtime itself, then the cap.
  const qi = await rpc.call<{ partialFee?: unknown } | null>('payment_queryInfo', [signed.hex], signal);
  if (!qi || typeof qi !== 'object') throw new TaoRpcError('format', 'payment_queryInfo', 'The Bittensor node sent no fee information.');
  const fee = parseFee(qi.partialFee);
  try {
    assertTaoFeeSane(fee);
  } catch (e) {
    throw new TaoSendError('fee-too-high', (e as Error)?.message || 'The network fee is higher than Satori GO accepts.');
  }

  const spendable = spendableOf(info, profile.existentialDeposit);
  return {
    signed,
    fee,
    builtAt: Date.now(),
    from: account.address,
    call,
    profile,
    runtime: check.verdict,
    account: {
      exists: info !== null,
      info,
      spendable,
      finalizedHash: head.hash,
      finalizedNumber: head.number,
    },
    shortfall: taoShortfall(call, fee, spendable),
  };
}

export function isTaoPlanStale(plan: Pick<TaoSendPlan, 'builtAt'>, now: number = Date.now()): boolean {
  return !(now - plan.builtAt < TAO_PLAN_MAX_AGE_MS);
}

/**
 * `TaggedTransactionQueue_validate_transaction(External, tx, at)` at the
 * current finalized head: the node checks the signature, the whole extension
 * layout, the nonce and fee payability without broadcasting (§4.5 step 6).
 */
export async function preflightTaoSend(rpc: TaoRpc, plan: TaoSendPlan, signal?: AbortSignal): Promise<TransactionValidity> {
  const head = await readFinalizedHead(rpc, signal);
  const tx = plan.signed.hex.slice(2);
  const args = `0x02${tx}${head.hash.slice(2)}`;
  const raw = await rpc.call<unknown>('state_call', ['TaggedTransactionQueue_validate_transaction', args, head.hash], signal);
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new TaoRpcError('format', 'state_call', 'The Bittensor node sent an invalid validation answer.');
  }
  try {
    return decodeTransactionValidity(raw);
  } catch {
    throw new TaoRpcError('format', 'state_call', 'The Bittensor node sent an invalid validation answer.');
  }
}

// author_submitExtrinsic JSON-RPC errors that mean "the pool has it already".
const ALREADY_KNOWN_CODES = new Set([1012 /* temporarily banned: seen recently */, 1013 /* already imported */]);

/** `author_submitExtrinsic`. 'accepted': a node took it (or already had it);
 *  'unknown': the outcome is not known and the caller must poll, never
 *  resend. Throws `TaoSendError('rejected')` when a node refused it. */
export async function submitTaoSend(
  rpc: TaoRpc,
  plan: TaoSendPlan,
  signal?: AbortSignal,
): Promise<{ hash: string; status: 'accepted' | 'unknown' }> {
  const hash = plan.signed.hash;
  try {
    await rpc.call<unknown>('author_submitExtrinsic', [plan.signed.hex], signal);
    return { hash, status: 'accepted' };
  } catch (e) {
    if (e instanceof TaoRpcError) {
      if (e.maybeSent) return { hash, status: 'unknown' };
      if (e.code === 'rpc' && e.rpcCode !== undefined && ALREADY_KNOWN_CODES.has(e.rpcCode)) return { hash, status: 'accepted' };
      if (e.code === 'rpc') throw new TaoSendError('rejected', `The network refused this transfer. ${e.message}`);
    }
    throw e;
  }
}

function validityMessage(v: TransactionValidity): string {
  if (v.ok) return '';
  return `The network refused this transfer (${v.kind === 'invalid' ? 'invalid' : 'unknown'}: ${v.name}).`;
}

export interface TaoSendResult {
  /** The plan that was submitted: `plan` itself, or its rebuild. */
  plan: TaoSendPlan;
  hash: string;
  status: 'accepted' | 'unknown';
  rebuilt: boolean;
}

/**
 * The confirm step (§4.5 steps 5 to 7) for a plan the user reviewed:
 *
 *   1. A plan older than TAO_PLAN_MAX_AGE_MS is rebuilt (fresh nonce and
 *      checkpoint) before anything else.
 *   2. Pre-flight. Payment refuses ("not enough TAO for the fee");
 *      Stale/Future/BadProof/AncientBirthBlock rebuild ONCE and pre-flight
 *      again; anything else refuses with the code shown.
 *   3. A rebuild whose fee exceeds the reviewed one plus the margin refuses
 *      ('fee-changed'): the user confirms a new fee on a new review.
 *   4. Affordability on the plan about to go out: pre-flight only proves the
 *      FEE is payable, and a transfer larger than the balance would still be
 *      included and charged its fee before failing.
 *   5. Submit.
 */
export async function sendTaoPlan(args: TaoSendArgs, plan: TaoSendPlan, signal?: AbortSignal, now: () => number = Date.now): Promise<TaoSendResult> {
  let current = plan;
  let rebuilt = false;
  const rebuild = async () => {
    const next = await planTaoSend(args, signal);
    if (next.fee > taoFeeWithMargin(plan.fee)) {
      throw new TaoSendError(
        'fee-changed',
        `The network fee changed since review (now ${formatTao(next.fee)} TAO). Check the new fee and confirm again.`,
      );
    }
    current = next;
    rebuilt = true;
  };

  if (isTaoPlanStale(current, now())) await rebuild();

  let retried = false;
  for (;;) {
    const v = await preflightTaoSend(args.rpc, current, signal);
    if (v.ok) break;
    if (isPaymentValidity(v)) throw new TaoSendError('payment', 'Not enough TAO to pay the network fee.', v);
    if (isRebuildableValidity(v) && !retried) {
      retried = true;
      await rebuild();
      continue;
    }
    throw new TaoSendError('invalid', validityMessage(v), v);
  }

  if (current.shortfall > 0n) {
    const need = amountOf(current.call) + taoFeeWithMargin(current.fee);
    throw new TaoSendError(
      'insufficient',
      `Not enough TAO: this transfer and its fee need ${formatTao(need)} TAO, and ${formatTao(current.account.spendable)} TAO can be spent.`,
    );
  }

  const res = await submitTaoSend(args.rpc, current, signal);
  return { plan: current, hash: res.hash, status: res.status, rebuilt };
}

// ---------------------------------------------------------------------------
// Inclusion
// ---------------------------------------------------------------------------

export interface TaoInclusion {
  state: 'pending' | 'included' | 'expired';
  blockHash?: string;
  blockNumber?: number;
  /** Index of the extrinsic in its block (the explorer's `<block>-<index>`). */
  extrinsicIndex?: number;
  /** 'included': false when the nonce moved but the bounded walk did not reach
   *  the block (the send is almost certainly in, the block is not known).
   *  'expired': why. */
  matched?: boolean;
  reason?: 'era' | 'nonce-used';
  /** The last finalized block checked: pass it back as `scanFrom` to resume. */
  checkedThrough?: number;
}

/** What a poll needs from a send: a plan, or the fields a stored record keeps. */
export interface TaoInclusionTarget {
  signed: Pick<SignedExtrinsic, 'hash' | 'nonce' | 'eraPeriod' | 'checkpointNumber'> & { hex?: string };
}

export interface TaoPollOptions {
  intervalMs?: number;
  maxWaitMs?: number;
  scanMax?: number;
  /** The last finalized block already known NOT to carry the send (a resumed
   *  poll). Default: the checkpoint, before which the send cannot be. */
  scanFrom?: number;
  /** Called after every successful tick. */
  onTick?: (tick: { finalizedNumber: number; nonce: number }) => void;
  /** Injected in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

interface RpcBlock {
  block?: { header?: { parentHash?: unknown; number?: unknown }; extrinsics?: unknown };
}

function extrinsicMatches(xt: unknown, target: TaoInclusionTarget['signed']): boolean {
  if (typeof xt !== 'string' || !/^0x[0-9a-fA-F]*$/.test(xt)) return false;
  if (target.hex && xt.toLowerCase() === target.hex.toLowerCase()) return true;
  // Only extrinsics of the right size are hashed: a transfer is ~145 bytes and
  // a block carries a few inherents of other sizes.
  if (target.hex && xt.length !== target.hex.length) return false;
  const h = `0x${bytesToHex(blake2b(hexToBytes(xt.slice(2)), { dkLen: 32 }))}`;
  return h === target.hash.toLowerCase();
}

/**
 * Walk back from `fromHash` (number `fromNumber`) over blocks above `floor`,
 * at most `max` blocks, looking for the send. Returns the hit, or null and
 * whether the walk covered the whole range.
 */
async function findInBlocks(
  rpc: TaoRpc,
  target: TaoInclusionTarget['signed'],
  fromHash: string,
  fromNumber: number,
  floor: number,
  max: number,
  signal?: AbortSignal,
): Promise<{ hit: { blockHash: string; blockNumber: number; extrinsicIndex: number } | null; complete: boolean }> {
  let hash = fromHash;
  let number = fromNumber;
  let walked = 0;
  while (number > floor) {
    if (walked >= max) return { hit: null, complete: false };
    const blk = await rpc.call<RpcBlock | null>('chain_getBlock', [hash], signal);
    walked++;
    const xts = blk?.block?.extrinsics;
    if (Array.isArray(xts)) {
      const i = xts.findIndex((x) => extrinsicMatches(x, target));
      if (i >= 0) return { hit: { blockHash: hash, blockNumber: number, extrinsicIndex: i }, complete: true };
    }
    const parent = blk?.block?.header?.parentHash;
    if (typeof parent !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(parent)) return { hit: null, complete: false };
    hash = parent.toLowerCase();
    number -= 1;
  }
  return { hit: null, complete: true };
}

/**
 * Wait for a submitted send to land (§4.5 step 8). Every `intervalMs`: the
 * finalized head and `System.Account` at it. When the account nonce passes
 * the signed nonce, the send (or another extrinsic with that nonce) is in: a
 * walk over the finalized blocks since the previous poll finds which. When the
 * finalized head passes the era's death with the nonce unmoved, the send can
 * never be included ('expired', "not included, send again").
 *
 * Resolves 'pending' on abort or after `maxWaitMs`; network errors on a tick
 * are retried on the next one.
 */
export async function pollTaoInclusion(
  rpc: TaoRpc,
  address: string,
  plan: TaoInclusionTarget,
  signal?: AbortSignal,
  opts: TaoPollOptions = {},
): Promise<TaoInclusion> {
  const target = plan.signed;
  const { publicKey } = ss58Decode(address, 42);
  const interval = opts.intervalMs ?? TAO_POLL_INTERVAL_MS;
  const maxWait = opts.maxWaitMs ?? TAO_POLL_MAX_WAIT_MS;
  const scanMax = opts.scanMax ?? TAO_INCLUSION_SCAN_MAX;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  // The era's death: valid in blocks [birth, birth + period); one block of
  // margin so "expired" is never said while the send could still land.
  const death = target.checkpointNumber + target.eraPeriod;
  const started = now();
  let checked = opts.scanFrom ?? target.checkpointNumber;
  let first = true;

  for (;;) {
    if (signal?.aborted) return { state: 'pending', checkedThrough: checked };
    if (!first) {
      if (now() - started >= maxWait) return { state: 'pending', checkedThrough: checked };
      await sleep(interval, signal);
      if (signal?.aborted) return { state: 'pending', checkedThrough: checked };
    }
    first = false;
    try {
      const head = await readFinalizedHead(rpc, signal);
      const info = await readAccountInfoAt(rpc, publicKey, head.hash, signal);
      const nonce = info?.nonce ?? 0;
      opts.onTick?.({ finalizedNumber: head.number, nonce });
      if (nonce > target.nonce) {
        const { hit, complete } = await findInBlocks(rpc, target, head.hash, head.number, checked, scanMax, signal);
        if (hit) return { state: 'included', ...hit, matched: true, checkedThrough: head.number };
        if (complete) return { state: 'expired', reason: 'nonce-used', matched: false, checkedThrough: head.number };
        return { state: 'included', matched: false, checkedThrough: head.number };
      }
      if (head.number > checked) checked = head.number;
      if (head.number >= death) return { state: 'expired', reason: 'era', checkedThrough: head.number };
    } catch (e) {
      if (signal?.aborted || (e instanceof TaoRpcError && e.code === 'aborted')) return { state: 'pending', checkedThrough: checked };
      if (!(e instanceof TaoRpcError)) throw e;
      // A transient network error: the next tick tries again.
    }
  }
}
