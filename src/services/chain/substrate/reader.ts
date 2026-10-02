// Reads for a Bittensor account (the Bittensor engine design notes §5.2, §4.4):
// the balance and nonce from `System.Account`, and the runtime guard that
// decides whether the wallet's hand-rolled extrinsic still matches the chain.
//
// Everything is read at the FINALIZED head, not the best block: Substrate
// finality is the wallet's confirmation (§10, "no unconfirmed incoming"), a
// finalized balance never goes backwards on a reorg, and the nonce polling of
// sender.ts compares nonces read the same way.
//
// Amounts are `bigint` rao (u64 on the wire, §3), never `number`.

import type { TaoRpc } from './rpc';
import { TaoRpcError } from './rpc';
import { ss58Decode } from './ss58';
import { decodeAccountInfo, systemAccountKey, type AccountInfo } from './scale';
import { compareProfiles, withVersions, type ProfileVerdict, type TaoRuntimeProfile } from './profile';

export interface TaoAccountState {
  /** false: `System.Account` has no entry (never funded, or reaped). 0 TAO. */
  exists: boolean;
  info: AccountInfo | null;
  /** What a `transfer_keep_alive` may move before fees:
   *  `free - max(frozen, existentialDeposit)`, never below 0 (§5.2). */
  spendable: bigint;
  finalizedHash: string;
  finalizedNumber: number;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** A block number as a node sends it in a header: `"0x8be5a4"`. */
export function parseBlockNumber(value: unknown): number {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{1,8}$/.test(value)) return parseInt(value.slice(2), 16);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return value;
  throw new TaoRpcError('format', 'chain_getHeader', 'The Bittensor node sent a block header without a valid number.');
}

/** The finalized head: hash and number (two calls: the head, then its header). */
export async function readFinalizedHead(rpc: TaoRpc, signal?: AbortSignal): Promise<{ hash: string; number: number }> {
  const hash = await rpc.call<unknown>('chain_getFinalizedHead', [], signal);
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
    throw new TaoRpcError('format', 'chain_getFinalizedHead', 'The Bittensor node sent an invalid finalized head.');
  }
  const header = await rpc.call<{ number?: unknown } | null>('chain_getHeader', [hash], signal);
  if (!header || typeof header !== 'object') {
    throw new TaoRpcError('format', 'chain_getHeader', 'The Bittensor node has no header for its own finalized head.');
  }
  return { hash: hash.toLowerCase(), number: parseBlockNumber(header.number) };
}

/** `free - max(frozen, ed)`, clamped at 0. */
export function spendableOf(info: AccountInfo | null, ed: bigint): bigint {
  if (!info) return 0n;
  const floor = info.frozen > ed ? info.frozen : ed;
  return info.free > floor ? info.free - floor : 0n;
}

/** `System.Account` of a public key at `blockHash`, decoded; null = no entry. */
export async function readAccountInfoAt(
  rpc: TaoRpc,
  publicKey: Uint8Array,
  blockHash: string,
  signal?: AbortSignal,
): Promise<AccountInfo | null> {
  const raw = await rpc.call<unknown>('state_getStorage', [systemAccountKey(publicKey), blockHash], signal);
  if (raw !== null && typeof raw !== 'string') {
    throw new TaoRpcError('format', 'state_getStorage', 'The Bittensor node sent an account entry that is not hex.');
  }
  try {
    return decodeAccountInfo(raw);
  } catch (e) {
    // A wrong length is the u64/u128 guard of §3 firing: a runtime whose
    // AccountInfo is not 56 bytes is one this wallet does not understand.
    throw new TaoRpcError('format', 'state_getStorage', `The Bittensor account entry has an unexpected layout (${(e as Error).message}).`);
  }
}

/**
 * Balance and nonce of `address` (SS58, prefix 42) at the finalized head.
 * Three calls: finalized head, its header, the storage entry. Throws
 * `Ss58Error` for an address that is not a Bittensor one (no request is made)
 * and `TaoRpcError` for anything the network does wrong.
 */
export async function readTaoAccount(rpc: TaoRpc, address: string, ed: bigint, signal?: AbortSignal): Promise<TaoAccountState> {
  const { publicKey } = ss58Decode(address, 42);
  const head = await readFinalizedHead(rpc, signal);
  const info = await readAccountInfoAt(rpc, publicKey, head.hash, signal);
  return {
    exists: info !== null,
    info,
    spendable: spendableOf(info, ed),
    finalizedHash: head.hash,
    finalizedNumber: head.number,
  };
}

export async function readRuntimeVersion(
  rpc: TaoRpc,
  signal?: AbortSignal,
): Promise<{ specName: string; specVersion: number; transactionVersion: number }> {
  const v = await rpc.call<Record<string, unknown> | null>('state_getRuntimeVersion', [], signal);
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;
  if (!v || typeof v !== 'object' || typeof v.specName !== 'string' || !ok(v.specVersion) || !ok(v.transactionVersion)) {
    throw new TaoRpcError('format', 'state_getRuntimeVersion', 'The Bittensor node sent an invalid runtime version.');
  }
  return { specName: v.specName.slice(0, 64), specVersion: v.specVersion, transactionVersion: v.transactionVersion };
}

export interface TaoRuntimeCheck {
  verdict: ProfileVerdict;
  live: { specVersion: number; transactionVersion: number };
}

/**
 * The runtime guard, §4.4:
 *
 *   1. `state_getRuntimeVersion` (one cheap call). Same spec name, spec and tx
 *      versions as the pin: 'same', sign with the pin.
 *   2. Otherwise `GET /tao/<set>/runtime`, the gateway's digest of the live
 *      metadata. The digest must describe THIS runtime (its versions equal the
 *      ones just read; the gateway caches it for 5 minutes, so right after an
 *      upgrade it can still describe the old one) and then is compared with
 *      the pin: equal in every field but the versions is 'version-only' (sign,
 *      with the LIVE versions in the payload); anything else, including a
 *      digest that is stale or unreachable, is 'layout-changed' and Send stays
 *      blocked. Balance and receive never depend on this.
 *
 * The wallet only ever accepts equality with what it ships, so a gateway
 * cannot redirect a call index through this path.
 */
export async function checkRuntime(rpc: TaoRpc, pinned: TaoRuntimeProfile, signal?: AbortSignal): Promise<TaoRuntimeCheck> {
  const v = await readRuntimeVersion(rpc, signal);
  const live = { specVersion: v.specVersion, transactionVersion: v.transactionVersion };
  if (v.specName === pinned.specName && v.specVersion === pinned.specVersion && v.transactionVersion === pinned.transactionVersion) {
    return { verdict: 'same', live };
  }
  if (v.specName !== pinned.specName) return { verdict: 'layout-changed', live };
  let digest: TaoRuntimeProfile;
  try {
    digest = await rpc.runtime(signal);
  } catch (e) {
    if (e instanceof TaoRpcError && e.code === 'aborted') throw e;
    // No digest, no signing on a runtime the wallet was not built for.
    return { verdict: 'layout-changed', live };
  }
  if (digest.specVersion !== v.specVersion || digest.transactionVersion !== v.transactionVersion) {
    return { verdict: 'layout-changed', live };
  }
  const verdict = compareProfiles(pinned, digest);
  return { verdict: verdict === 'same' ? 'version-only' : verdict, live };
}

/** The profile to sign with after a guard: the pin, with the live versions
 *  when the guard said 'version-only'. Throws on 'layout-changed'. */
export function profileForSigning(pinned: TaoRuntimeProfile, check: TaoRuntimeCheck): TaoRuntimeProfile {
  if (check.verdict === 'layout-changed') throw new TaoRuntimeChangedError();
  if (check.verdict === 'same') return pinned;
  return withVersions(pinned, check.live);
}

/** Send is blocked because the chain's runtime no longer matches the layout
 *  this build signs (§4.4). The message is the runtime banner of §10. */
export class TaoRuntimeChangedError extends Error {
  readonly code = 'runtime-changed' as const;
  constructor() {
    super('Bittensor updated its network; update Satori GO to send.');
    this.name = 'TaoRuntimeChangedError';
  }
}
