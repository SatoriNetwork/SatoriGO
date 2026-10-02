// The Zcash send path (docs/design/zcash-engine.md §4, §6.5, §15 Set C): plan,
// then broadcast. Mirrors moneroSend.ts's shape (validate -> build -> review;
// broadcast is a separate step the arming UI gates) but everything
// money-shaped happens in pure TS here rather than inside a worker: input
// selection, ZIP-317 fee, ZIP-244 signing all run inside Set A's
// `buildZcashTx` (services/chain/zcash/builder.ts), and this file's job is
// the same as moneroSend.ts's — turn screen-shaped text into that call, and
// turn its answer into a plan the review screen only displays, never
// re-derives.
//
// UNLIKE moneroSend.ts, there is no open host holding a live key: Zcash keys
// exist only for the moment a send is built (§9), read fresh via
// `zcashKeysOfActive()` — the store's thin wrapper around
// LiveWalletService.zcashKeysOfActive() (Set D's liveWallet.ts contract,
// §15), mirroring the `restoreHeight` / `moneroNodeSet` mirroring pattern
// WalletSummary already uses for Monero: this file never imports
// liveWallet.ts or the service singleton directly, only the store action.
//
// LOCAL SEND RECORD (§6.5): "A send records {txid, expiryHeight, sentAt, hex}
// locally." liveStore.ts's own local-pending mechanism (`localPendingTxs`) is
// private to that file and UTXO-shaped (built from a UTXO LiveSendPlan), so it
// is not reachable here; this file keeps ITS OWN small persisted list — the
// same `getStorage()` adapter evmHistoryCache.ts already uses for exactly this
// kind of small JSON-safe cache — which zcashHistory.ts reads back to render
// pending/expired rows (§6.5, §10).

import { useLiveStore } from './liveStore';
import { gatewayUrl, GATEWAY_CLIENT_TOKEN } from '../services/gateway';
import { getStorage } from '../services/storage';
import { ZCASH_CHAIN } from './zcashChain';
import { zcashRpc, ZcashRpcError } from '../services/chain/zcash/rpc';
import { decodeZcashAddress, ZcashAddressError } from '../services/chain/zcash/address';
import { buildZcashTx, ZcashBuildError, type ZcashSignedTx } from '../services/chain/zcash/builder';
import { assertZcashFeeSane, formatZec, parseZec } from '../services/chain/zcash/fees';
import { zeroZcashKeys, type ZcashKeys } from '../services/chain/zcash/keys';

export interface ZcashSendInput {
  to: string;
  /** As typed. Ignored when `sweep` is true, same convention as Monero's
   *  send input (Set B nothing to parse for a sweep of every spendable UTXO). */
  amount: string;
  sweep: boolean;
}

export interface ZcashSendPlan {
  signed: ZcashSignedTx;
  feeZec: string;
  amountZec: string;
  /** amount + fee, formatted — what leaves the confirmed balance. */
  totalZec: string;
  /** How many blocks from the current tip until this transaction expires and
   *  must be rebuilt (§4.5, §6.5): `signed.expiryHeight - tip`. */
  expiresInBlocks: number;
  warnings: string[];
}

export class ZcashSendError extends Error {
  readonly code:
    | 'no-wallet'
    | 'invalid-address'
    | 'invalid-amount'
    | 'build-failed'
    | 'fee-unsafe'
    | 'broadcast-failed'
    /** The gateway deviation from the design doc (2026-09-28): a Zcash send
     *  answers 504 on DEADLINE_EXCEEDED/CANCELLED, meaning "pending unknown,
     *  look up the txid via /tx or /mempool, never re-send" rather than a
     *  definite failure. */
    | 'broadcast-unknown';
  constructor(code: ZcashSendError['code'], message: string) {
    super(message);
    this.name = 'ZcashSendError';
    this.code = code;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** The active wallet's keys, fresh for this build only (§9: never cached
 *  beyond the moment a send needs them). Throws ZcashSendError('no-wallet')
 *  for every reason the store action itself can fail (locked, no active
 *  Zcash wallet, a non-zcash wallet active) — the store action's own message
 *  is passed through since it already says which. */
function keysOfActiveWallet(): ZcashKeys {
  try {
    return useLiveStore.getState().zcashKeysOfActive();
  } catch (err) {
    throw new ZcashSendError('no-wallet', describeError(err) || 'No Zcash wallet is open.');
  }
}

function activeChain() {
  return useLiveStore.getState().zcash.chain ?? ZCASH_CHAIN;
}

/**
 * Build a plan: validate the recipient (§3.2, refusing §3.3's shapes with
 * their exact message) and the amount, then sign a real transaction through
 * Set A's builder against the live snapshot already in the store (branch id
 * and tip come from nowhere else — see docs/design/zcash-engine.md §4.1: a
 * hardcoded branch id must never exist). Throws ZcashSendError for
 * everything a caller must show inline.
 */
export async function buildZcashSendPlan(input: ZcashSendInput): Promise<ZcashSendPlan> {
  const to = input.to.trim();
  if (!to) {
    throw new ZcashSendError('invalid-address', 'Recipient address is required.');
  }
  try {
    // decodeZcashAddress (Set A, address.ts) throws ZcashAddressError with the
    // exact §3.3 user-facing wording already on `.message` for every refusal
    // shape (shielded, unified, testnet, checksum, format) — isValidZcashRecipient
    // is exactly "this does not throw", so decoding directly here gets both
    // the validity check and the right message in one call.
    decodeZcashAddress(to);
  } catch (err) {
    if (err instanceof ZcashAddressError) throw new ZcashSendError('invalid-address', err.message);
    throw new ZcashSendError('invalid-address', 'This is not a valid Zcash address.');
  }

  let amountZat = 0n;
  if (!input.sweep) {
    if (!input.amount.trim()) {
      throw new ZcashSendError('invalid-amount', 'Enter an amount, or use Max to sweep your whole spendable balance.');
    }
    try {
      amountZat = parseZec(input.amount);
    } catch (err) {
      throw new ZcashSendError('invalid-amount', describeError(err) || 'Enter a valid amount.');
    }
    if (amountZat <= 0n) {
      throw new ZcashSendError('invalid-amount', 'Enter an amount greater than 0.');
    }
  }

  const zcashSlice = useLiveStore.getState().zcash;
  const snapshot = zcashSlice.snapshot;
  if (!snapshot) {
    throw new ZcashSendError('no-wallet', 'No Zcash balance loaded yet. Refresh and try again.');
  }
  // The last refresh failed: the snapshot still on screen may list coins that
  // are already spent, or a tip and branch id that moved on. Never build from
  // it; a fresh read first.
  if (zcashSlice.status === 'error') {
    throw new ZcashSendError('build-failed', 'The last Zcash refresh failed, so the balance may be out of date. Refresh first, then try again.');
  }

  const keys = keysOfActiveWallet();

  let signed: ZcashSignedTx;
  try {
    try {
      signed = buildZcashTx({
        utxos: snapshot.spendable,
        keys,
        to,
        amountZat,
        sweep: input.sweep,
        branchId: snapshot.info.consensusBranchId,
        tip: snapshot.info.height,
        upgradeHeight: snapshot.info.upgradeHeight || undefined,
      });
    } catch (err) {
      if (err instanceof ZcashBuildError && err.code === 'fee-cap') {
        throw new ZcashSendError('fee-unsafe', err.message);
      }
      throw new ZcashSendError('build-failed', describeError(err));
    }
  } finally {
    // §9: the fifteen private keys exist in page memory only for the moment a
    // send needs them; ZcashSignedTx carries no key material forward (hex,
    // txid, fee, amount, change, expiryHeight, spent ZcashUtxo rows, size),
    // so they are zeroed the instant the builder is done with them, success
    // or failure, the same discipline liveStore.ts applies to Monero's keys
    // right after opening its host.
    zeroZcashKeys(keys);
  }

  // Defense in depth (docs/design/zcash-engine.md §9): ZIP-317 is
  // deterministic, so this only ever catches a builder bug, exactly the way
  // moneroSend.ts re-checks a wallet2-built fee it did not itself compute.
  try {
    assertZcashFeeSane(signed.fee);
  } catch (err) {
    throw new ZcashSendError('fee-unsafe', describeError(err));
  }

  return {
    signed,
    feeZec: formatZec(signed.fee),
    amountZec: formatZec(signed.amount),
    totalZec: formatZec(signed.amount + signed.fee),
    expiresInBlocks: Math.max(0, signed.expiryHeight - snapshot.info.height),
    warnings: [],
  };
}

// --- local send record (§6.5) ------------------------------------------------

export interface ZcashLocalSend {
  txid: string;
  expiryHeight: number;
  sentAt: number;
  hex: string;
  /** Display fields from the plan that built this send, so Activity
   *  (zcashHistory.ts) can show a real amount/recipient for a row that has
   *  not reached the chain's own history yet, without re-parsing `hex`.
   *  Optional: the record's REQUIRED shape stays exactly {txid, expiryHeight,
   *  sentAt, hex} per docs/design/zcash-engine.md §6.5. */
  amountZec?: string;
  feeZec?: string;
  to?: string;
  /** The outpoints (`txid:index`) this send spends, so a refresh can hold
   *  them back from the spendable set until the network's own mempool
   *  snapshot catches up (the gateway caches it for a few seconds, and the
   *  success screen refreshes at once): without this, a second send built
   *  right after the first picks the same inputs and is refused as a
   *  conflict. Optional: a record written before the field existed is
   *  parsed from `hex` instead (zcashBalances.ts). */
  spent?: string[];
}

/** The outpoints a signed transaction spends, in `txid:index` form. */
export function spentOutpointsOf(signed: Pick<ZcashSignedTx, 'inputs'>): string[] {
  return signed.inputs.map((u) => `${u.txid}:${u.index}`);
}

/** Most local send records kept per wallet: enough to cover every send made
 *  while waiting on expiry (about 50 minutes each, §4.5), small enough to
 *  never weigh on extension storage. */
export const ZCASH_LOCAL_SENDS_MAX = 50;

function localSendsKey(walletId: string): string {
  return `zec:sends:${walletId}`;
}

/** Every send this wallet has made locally, newest first. Never throws: a
 *  storage read failure reads as "no local sends" the same way a missing
 *  history cache does elsewhere. */
export async function loadLocalZcashSends(walletId: string): Promise<ZcashLocalSend[]> {
  try {
    const v = await getStorage().get<ZcashLocalSend[]>(localSendsKey(walletId));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function recordLocalZcashSend(walletId: string, send: ZcashLocalSend): Promise<void> {
  try {
    const prior = await loadLocalZcashSends(walletId);
    const next = [send, ...prior.filter((s) => s.txid !== send.txid)].slice(0, ZCASH_LOCAL_SENDS_MAX);
    await getStorage().set(localSendsKey(walletId), next);
  } catch {
    /* best effort: Activity falls back to the chain's own history/mempool */
  }
}

/** Forget the local records with these txids (an expired send the user has
 *  seen and dismissed, §6.5). Best effort, never throws. */
export async function dropLocalZcashSends(walletId: string, txids: readonly string[]): Promise<void> {
  if (txids.length === 0) return;
  try {
    const gone = new Set(txids.map((t) => t.toLowerCase()));
    const prior = await loadLocalZcashSends(walletId);
    const next = prior.filter((s) => !gone.has(s.txid.toLowerCase()));
    if (next.length === prior.length) return;
    await getStorage().set(localSendsKey(walletId), next);
  } catch {
    /* best effort: the record is dropped on the next dismiss or by the cap */
  }
}

/**
 * Relay an already-built plan (§6.5). Fail closed: exactly two outcomes are a
 * definite "not sent" and record nothing: the node's own rejection (a
 * resolved `ok: false`), and a refusal made before any server was asked
 * (rpc.ts throws 'refused' or 'http' only for its own pre-fetch checks and the
 * gateway's pre-flight answer, stage 'precheck'). EVERYTHING else (rpc.ts's
 * 'unknown': no answer, a timeout, any 5xx, any other 4xx, the node already
 * has it; or any error this code did not expect) may have relayed the
 * transaction, so it is recorded as a local send (its inputs held back, its
 * txid polled) and never sent again automatically. The txid the wallet
 * computed itself (`plan.signed.txid`, a ZIP-244 digest, §4.4) is exactly what
 * a later `/tx` or `/mempool` lookup resolves.
 */
export async function broadcastZcashPlan(plan: ZcashSendPlan, opts?: { to?: string }): Promise<{ txid: string }> {
  const walletId = useLiveStore.getState().activeWalletId;
  if (!walletId) {
    throw new ZcashSendError('no-wallet', 'No Zcash wallet is open.');
  }
  const chain = activeChain();
  const rpc = zcashRpc(gatewayUrl(), GATEWAY_CLIENT_TOKEN, chain.defaultNodeSet);
  const record: ZcashLocalSend = {
    txid: plan.signed.txid,
    expiryHeight: plan.signed.expiryHeight,
    sentAt: Date.now(),
    hex: plan.signed.hex,
    amountZec: plan.amountZec,
    feeZec: plan.feeZec,
    // ZcashSignedTx carries no recipient (the screen's typed value is the
    // only copy), so the caller passes it for the Activity row.
    ...(opts?.to ? { to: opts.to } : {}),
    spent: spentOutpointsOf(plan.signed),
  };

  let result: { ok: boolean; errorCode: number; errorMessage: string };
  try {
    result = await rpc.send(plan.signed.hex);
  } catch (err) {
    if (err instanceof ZcashRpcError && (err.code === 'refused' || err.code === 'http')) {
      throw new ZcashSendError('broadcast-failed', describeError(err));
    }
    await recordLocalZcashSend(walletId, record);
    throw new ZcashSendError(
      'broadcast-unknown',
      'The network did not confirm this send was received. It may still go through: check Activity for this transaction before sending again.',
    );
  }

  if (!result.ok) {
    // A final application answer (§7): the node refused this transaction
    // outright, so nothing is recorded as pending.
    throw new ZcashSendError(
      'broadcast-failed',
      result.errorMessage || `The Zcash network rejected this transaction (code ${result.errorCode}).`,
    );
  }

  await recordLocalZcashSend(walletId, record);
  return { txid: plan.signed.txid };
}
