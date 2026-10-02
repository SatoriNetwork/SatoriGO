// The store's read path for the open Monero wallet (the Monero engine design,
// §15 Set C). Mirrors evmBalances.ts's refreshEvmWallet in spirit: a refresh
// never throws, degrades to an offline-shaped result on failure, and reads
// through the ONE open host rather than opening a second one.
//
// UNLIKE evmBalances.ts, this file takes no address/provider argument: there is
// no re-derivation to do and no stateless RPC client to hand back. The single
// live MoneroWalletHost — the worker-backed wallet, unlocked in THIS page, with
// the private view key inside it — lives in the liveStore `monero` slice (Set D
// surface, §15), and every function here reads it from there. That is also why
// `walletId` is a parameter rather than assumed: a stale host (the wallet was
// switched or locked mid-flight) must not be read as if it were the one the
// caller asked about — see the guard in `withOpenHost` below.

import { useLiveStore } from './liveStore';
import type { MoneroBalance, MoneroSyncProgress, MoneroWalletHost } from '../services/chain/monero/scanner';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';

/** Native-coin decimals for XMR everywhere in this wallet (§8: `nativeDecimals:
 *  12`, piconero). Duplicated as a literal (not imported from moneroChains.ts)
 *  so this file has exactly one thing it needs from the open host, not two
 *  module dependencies for one number. */
const XMR_DECIMALS = 12;

/** The open host, but ONLY when it is genuinely the wallet `walletId` asked
 *  about: the store's `monero.host` is one shared slot (§6.3, one worker per UI
 *  page), so a caller from a screen that has since switched wallets, or a
 *  stale async continuation from before a lock, must read as "not open" rather
 *  than silently act on someone else's wallet. */
function openHostFor(walletId: string): MoneroWalletHost | null {
  const host = useLiveStore.getState().monero.host;
  return host && host.walletId === walletId ? host : null;
}

function offlineBalance(): MoneroBalance {
  return { total: 0n, unlocked: 0n, height: 0, daemonHeight: 0 };
}

function assetRowsFor(balance: MoneroBalance): LiveAssetBalance[] {
  // One row: the native coin. Monero has no asset protocol (§11), so there is
  // never a second row the way an Evrmore wallet lists issued assets. The
  // TOTAL balance is what LiveAssetBalance.amountBase means everywhere else in
  // this wallet (Send's "Available", Home's balance line); the locked/unlocked
  // split has no analogue on any other chain and is carried separately on
  // MoneroRefreshResult.balance for the family-aware Home branch (§10) to read.
  return [
    {
      name: 'XMR',
      amountBase: balance.total,
      scale: XMR_DECIMALS,
      decimals: XMR_DECIMALS,
      isNative: true,
    },
  ];
}

export interface MoneroRefreshResult {
  balance: MoneroBalance;
  assets: LiveAssetBalance[];
  sync: MoneroSyncProgress | null;
  /** Why the scan did not complete, in the host's own words, or null when it
   *  did. The balance beside it is then the LAST KNOWN one (or the offline
   *  shape), which the store shows as such rather than as current. Added by
   *  Set D: the store needs the reason for its sync status line, and a result
   *  that degrades silently could not carry it. */
  error: string | null;
}

function describeError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Could not reach the Monero node through the gateway.';
}

/**
 * Sync and read the balance of the OPEN Monero wallet. Never throws: a sync
 * failure (gateway unreachable, node refused) degrades to the last known
 * balance shape (0 when nothing was ever read) rather than crashing the
 * refresh loop the rest of the store shares across every chain.
 *
 * `walletId` must match the open host's own id (openMoneroWallet's
 * MoneroOpenArgs.walletId); a mismatch (or no host open at all — locked, or a
 * non-Monero wallet active) answers the same as "cannot read balances", which
 * is exactly how an offline UTXO/EVM wallet is already reported.
 */
export async function refreshMoneroWallet(
  walletId: string,
  onProgress?: (p: MoneroSyncProgress) => void,
): Promise<MoneroRefreshResult> {
  const host = openHostFor(walletId);
  if (!host) {
    return { balance: offlineBalance(), assets: assetRowsFor(offlineBalance()), sync: null, error: 'No Monero wallet is open.' };
  }
  try {
    const balance = await host.sync(onProgress);
    return { balance, assets: assetRowsFor(balance), sync: null, error: null };
  } catch (err) {
    // A sync failure (gateway down, node refused, a stale whitelist entry —
    // §7) is a network condition, not a reason to lose the wallet's last known
    // balance: read whatever the host already has cached rather than zeroing
    // the screen out from under the user.
    const error = describeError(err);
    try {
      const balance = await host.balance();
      return { balance, assets: assetRowsFor(balance), sync: null, error };
    } catch {
      return { balance: offlineBalance(), assets: assetRowsFor(offlineBalance()), sync: null, error };
    }
  }
}

/** Balance alone (no sync attempt), for a cheap re-read after e.g. a send. */
export async function readMoneroBalance(walletId: string): Promise<MoneroBalance | null> {
  const host = openHostFor(walletId);
  if (!host) return null;
  try {
    return await host.balance();
  } catch {
    return null;
  }
}
