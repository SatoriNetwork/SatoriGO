// The store's read path for a Bittensor account (Bittensor engine design,
// docs/design/bittensor-engine.md §15 Set C). Mirrors evmBalances.ts's shape
// more than moneroBalances.ts's: like an EVM account, a Substrate account is
// ONE address read statelessly through the gateway (no worker, no persistent
// host to sync — design §13, "the gateway is HTTP and the wallet polls"), so
// a refresh needs only the cached public address and a stateless RPC client,
// not an open host held in the store.
//
// DEPENDS ON Set A (services/chain/substrate/tao.ts: TAO_PROFILE,
// TAO_EXISTENTIAL_DEPOSIT) and Set B (services/chain/substrate/rpc.ts,
// reader.ts: taoRpc, readTaoAccount, checkRuntime) through the barrel
// `services/chain/substrate` that Set D owns (index.ts). Those files do not
// exist yet at the time this file was written (Sets A/B/D land later, design
// §15: "Set D wires them in, one merge at a time, in the order A, B, C"), so
// this module will not type-check or run until they do. See the Set C report
// for the exact names this file expects from that barrel.

import { useLiveStore } from './liveStore';
import { taoRpc, readTaoAccount, checkRuntime } from '../services/chain/substrate';
import type { TaoRpc, TaoAccountState, ProfileVerdict, TaoRuntimeProfile } from '../services/chain/substrate';
import { TAO_PROFILE, TAO_EXISTENTIAL_DEPOSIT } from '../services/chain/substrate';
import { GATEWAY_CLIENT_TOKEN, gatewayUrl } from '../services/gateway';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';
import { TAO_CHAIN } from './taoChain';

/** One RPC client for the wallet's one Bittensor node set, cached the same
 *  way evmBalances.ts caches one EvmWalletDataProvider per chain key: the
 *  client itself carries no secret (the token is a public per-build client
 *  id, design §7's `X-Satori-Client`, not a wallet credential), so caching it
 *  module-wide is safe and avoids rebuilding it on every refresh tick. */
let cachedRpc: TaoRpc | null = null;

export function taoRpcClient(): TaoRpc {
  if (!cachedRpc) {
    cachedRpc = taoRpc(gatewayUrl(), GATEWAY_CLIENT_TOKEN, TAO_CHAIN.defaultNodeSet);
  }
  return cachedRpc;
}

/** Tests only: drop the cached client so a fresh fake fetch/RPC takes effect,
 *  mirroring evmBalances.ts's resetEvmProvidersForTests. */
export function resetTaoRpcForTests(): void {
  cachedRpc = null;
}

/** The active wallet's SS58 address, or null when `walletId` does not match
 *  an entry with one set (locked, not yet enabled, or a non-substrate
 *  wallet). Public data only (an address, never a secret), so — unlike the
 *  mini secret this chain also needs for SENDING — reading it here needs no
 *  involvement from LiveWalletService. */
function addressForWallet(walletId: string): string | null {
  const wallet = useLiveStore.getState().wallets.find((w) => w.id === walletId);
  return wallet?.address || null;
}

export interface TaoRefreshResult {
  account: TaoAccountState;
  assets: LiveAssetBalance[];
  runtime: ProfileVerdict;
  /**
   * Why the read did not complete, in plain words, or null when it did. NOT
   * in the design's literal §15 Set C snippet (`{ account, assets, runtime }`
   * has no error field) — added here because a caller (Set D's liveStore.ts)
   * needs to tell "this account genuinely has 0 TAO" apart from "the gateway
   * could not be reached", exactly the distinction moneroBalances.ts's
   * MoneroRefreshResult.error already draws for the Monero trio. Flagged in
   * the Set C report as an additive deviation from the literal type.
   */
  error: string | null;
}

function offlineAccount(): TaoAccountState {
  return { exists: false, info: null, spendable: 0n, finalizedHash: '', finalizedNumber: 0 };
}

function assetRowsFor(account: TaoAccountState): LiveAssetBalance[] {
  // One row: the native coin. Bittensor has no asset/token protocol in this
  // wallet (design §11), so there is never a second row.
  //
  // `free` (not `spendable`) is what Home shows (design §10: "`free` as the
  // balance; '0.5 TAO reserved' beneath it when `reserved > 0`"), matching
  // every other chain's LiveAssetBalance.amountBase meaning "the headline
  // balance". `spendable` (free minus the reserved/frozen floor) is what the
  // Send screen shows separately and checks against — see LiveSendTao.tsx and
  // taoSend.ts, which read TaoAccountState.spendable directly rather than
  // through this row.
  return [
    {
      name: 'TAO',
      amountBase: account.info?.free ?? 0n,
      scale: TAO_CHAIN.nativeDecimals,
      decimals: TAO_CHAIN.nativeDecimals,
      isNative: true,
    },
  ];
}

function describeError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Could not reach Bittensor through the gateway.';
}

/**
 * Read the balance/nonce state and the runtime guard verdict for the active
 * Bittensor wallet. Never throws: a read failure (gateway unreachable, node
 * refused) degrades to the offline shape with `error` set, exactly as
 * refreshMoneroWallet/refreshEvmWallet already do for their chains — the
 * caller (Set D) is expected to keep the LAST KNOWN account on an error
 * result rather than blank the screen, the same rule evmBalances.ts's
 * `assets: null` sentinel exists for.
 *
 * `profile` defaults to the pinned TAO_PROFILE (design §4.4); a caller never
 * needs to pass it in v1 (one chain, one profile), but accepting it keeps
 * this testable against a fixture profile without touching the module's
 * real pinned constant.
 */
export async function refreshTaoWallet(walletId: string, profile: TaoRuntimeProfile = TAO_PROFILE): Promise<TaoRefreshResult> {
  const address = addressForWallet(walletId);
  if (!address) {
    return { account: offlineAccount(), assets: assetRowsFor(offlineAccount()), runtime: 'same', error: 'No Bittensor address for this wallet.' };
  }
  const rpc = taoRpcClient();
  try {
    const [account, runtimeCheck] = await Promise.all([
      readTaoAccount(rpc, address, TAO_EXISTENTIAL_DEPOSIT),
      // A runtime check failure must not fail the whole refresh (the balance
      // read above may well have succeeded on a different node in the
      // failover order, design §7.1) — see the catch below, which keeps
      // 'same' rather than downgrading to a state the type has no room for.
      checkRuntime(rpc, profile).catch(() => null),
    ]);
    return {
      account,
      assets: assetRowsFor(account),
      // ProfileVerdict has no 'unknown' member (design §15 Set A): a failed
      // runtime read here is not treated as evidence of a layout change. The
      // authoritative guard is the one taoSend.ts runs fresh immediately
      // before every send (design §4.5 step 1); this value only drives the
      // Send screen's advance banner.
      runtime: runtimeCheck?.verdict ?? 'same',
      error: null,
    };
  } catch (err) {
    const error = describeError(err);
    return { account: offlineAccount(), assets: assetRowsFor(offlineAccount()), runtime: 'same', error };
  }
}

/** Balance alone (no runtime check), for a cheap re-read after e.g. a send. */
export async function readTaoBalance(walletId: string): Promise<TaoAccountState | null> {
  const address = addressForWallet(walletId);
  if (!address) return null;
  try {
    return await readTaoAccount(taoRpcClient(), address, TAO_EXISTENTIAL_DEPOSIT);
  } catch {
    return null;
  }
}
