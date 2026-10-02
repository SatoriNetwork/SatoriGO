// The store's read path for the active Zcash wallet (docs/design/zcash-engine.md
// §6, §15 Set C). Mirrors refreshMoneroWallet in spirit (a refresh reads
// through the ONE open gateway host) but UNLIKE Monero there is no worker /
// MoneroWalletHost to hold open: Zcash's key and transaction layer is pure TS
// with no WASM (§13), so there is nothing to "open" — a refresh derives
// nothing itself, it just reads the fifteen PUBLIC watch addresses already
// cached on the wallet entry (§6.2: "the background never needs a key") and
// asks the gateway.
//
// UNLIKE refreshMoneroWallet, this does NOT degrade to a fabricated offline
// snapshot on failure: ZcashSnapshot.info carries the live consensus branch
// id and tip height that a later send signs against (§4.1), and a snapshot
// with an invented branch id would be actively dangerous to build a
// transaction from. A read failure THROWS instead, and the caller (Set D's
// refresh() action, which owns the `zcash` slice's status/error fields) is
// the one that turns that into "offline" for the UI — the same shape
// evmSend.ts's and moneroSend.ts's own Error subclasses already use for the
// money path, just applied to the read path here because there is no safe
// synthetic snapshot to fall back to.

import { useLiveStore } from './liveStore';
import { gatewayUrl, GATEWAY_CLIENT_TOKEN } from '../services/gateway';
import { ZCASH_CHAIN, type ZcashChainInfo } from './zcashChain';
import { zcashRpc } from '../services/chain/zcash/rpc';
import { refreshZcash, classifySend, type ZcashOwnSend, type ZcashSnapshot } from '../services/chain/zcash/reader';
import { parseZec } from '../services/chain/zcash/fees';
import { loadZcashHistory, saveZcashHistory, emptyZcashHistory } from '../services/chain/zcash/historyCache';
import { parseZcashTx } from '../services/chain/zcash/tx';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { loadLocalZcashSends, type ZcashLocalSend } from './zcashSend';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';

const ZEC_DECIMALS = 8;

/**
 * The active wallet's public watch-address list (§6.2, fifteen addresses,
 * `/0/0..9` and `/1/0..4`), or null when `walletId` is not the active, open,
 * Zcash wallet. Reads `WalletSummary.zcashWatch` — the mirror of
 * `WalletEntry.zcashWatch` Set D's liveWallet.ts keeps public on the entry,
 * the same "Monero only" mirroring pattern WalletSummary already uses for
 * `restoreHeight` / `moneroNodeSet` (liveWallet.ts) — rather than a live host
 * object, because reading a balance never needs a key here.
 */
function activeZcashWatch(walletId: string): readonly string[] | null {
  const state = useLiveStore.getState();
  const wallet = state.wallets.find((w) => w.id === walletId);
  if (!wallet || wallet.family !== 'zcash') return null;
  const watch = (wallet as { zcashWatch?: string[] }).zcashWatch;
  return Array.isArray(watch) && watch.length > 0 ? watch : null;
}

/** The one Zcash row: null build-flag gate the way Monero has (§13 — Zcash
 *  ships in every build), so this only ever falls back when the store's own
 *  `zcash.chain` has not been set yet (e.g. mid-init). */
function activeZcashChain(): ZcashChainInfo {
  return useLiveStore.getState().zcash.chain ?? ZCASH_CHAIN;
}

/** What Home shows as the balance: confirmed minus what our pending sends
 *  take out (they are spoken for), never below zero. Incoming unconfirmed is
 *  never added (§6.4); Home names it on its own line. */
export function zcashDisplayBalance(snapshot: Pick<ZcashSnapshot, 'confirmed' | 'pendingOut'>): bigint {
  const v = snapshot.confirmed - snapshot.pendingOut;
  return v > 0n ? v : 0n;
}

function assetRowsFor(confirmedZat: bigint): LiveAssetBalance[] {
  // One row: the native coin. Zcash v1 is transparent-only with no asset
  // protocol (§11), so there is never a second row the way an Evrmore wallet
  // lists issued assets.
  return [
    {
      name: 'ZEC',
      amountBase: confirmedZat,
      scale: ZEC_DECIMALS,
      decimals: ZEC_DECIMALS,
      isNative: true,
    },
  ];
}

export interface ZcashRefreshResult {
  snapshot: ZcashSnapshot;
  assets: LiveAssetBalance[];
}

/**
 * Sync and read the balance of `walletId`, which must be the active, open
 * Zcash wallet (§9: keys/watch addresses live only in this page's memory
 * while unlocked). Throws when that is not the case, or when the gateway
 * read itself fails — see the file header for why this never invents an
 * offline snapshot instead.
 */
export async function refreshZcashWallet(walletId: string): Promise<ZcashRefreshResult> {
  const watch = activeZcashWatch(walletId);
  if (!watch) {
    throw new Error('No Zcash wallet is open.');
  }
  const chain = activeZcashChain();
  const rpc = zcashRpc(gatewayUrl(), GATEWAY_CLIENT_TOKEN, chain.defaultNodeSet);
  const priorCache = (await loadZcashHistory(walletId).catch(() => null)) ?? emptyZcashHistory();

  // refreshZcash never modifies `priorCache`; the next cache to persist is
  // `snapshot.cache` (reader.ts owns the activeAddresses/scannedTo bookkeeping
  // — it alone knows which addresses were actually scanned from the floor).
  // This wallet's own sends: the reader counts one as OUTGOING even when the
  // mempool answer carries no inputs for it (its change is not income).
  const sends = await loadLocalZcashSends(walletId);
  const read = await refreshZcash(rpc, [...watch], priorCache, undefined, sends.map(toOwnSend));

  // Persist best-effort: a storage failure here must not fail a refresh that
  // already has a good, live snapshot in hand.
  try {
    await saveZcashHistory(walletId, read.cache);
  } catch {
    /* ignore: the next successful refresh saves again */
  }

  const snapshot = withOwnSendsHeldBack(sends, read);
  return { snapshot, assets: assetRowsFor(zcashDisplayBalance(snapshot)) };
}

function toOwnSend(send: ZcashLocalSend): ZcashOwnSend {
  let outflowZat: bigint | null = null;
  try {
    if (typeof send.amountZec === 'string' && typeof send.feeZec === 'string') {
      outflowZat = parseZec(send.amountZec) + parseZec(send.feeZec);
    }
  } catch {
    outflowZat = null;
  }
  return { txid: send.txid, expiryHeight: send.expiryHeight, spent: outpointsOf(send), outflowZat };
}

/**
 * The reader only excludes UTXOs the gateway's mempool snapshot shows as
 * spent, and the gateway caches that snapshot for a few seconds while the
 * success screen refreshes at once. So the inputs of this wallet's OWN sends
 * that the chain has not yet seen (pending or unknown, §6.5) are held back
 * here too: a second send built right after the first would otherwise pick
 * the same inputs (largest first) and be refused as a conflict a minute
 * later. A confirmed or expired record holds nothing back. The outpoints
 * come from the record (`spent`); a record from before that field parses
 * its own hex. Never throws: a bad record simply holds nothing back.
 */
function withOwnSendsHeldBack(sends: readonly ZcashLocalSend[], snapshot: ZcashSnapshot): ZcashSnapshot {
  if (sends.length === 0) return snapshot;
  const held = new Set<string>();
  for (const send of sends) {
    const state = classifySend({ txid: send.txid, expiryHeight: send.expiryHeight }, snapshot);
    if (state === 'confirmed' || state === 'expired') continue;
    for (const o of outpointsOf(send)) held.add(o);
  }
  if (held.size === 0) return snapshot;
  const spendable = snapshot.spendable.filter((u) => !held.has(`${u.txid}:${u.index}`));
  return spendable.length === snapshot.spendable.length ? snapshot : { ...snapshot, spendable };
}

function outpointsOf(send: ZcashLocalSend): string[] {
  if (Array.isArray(send.spent)) return send.spent.filter((o) => typeof o === 'string');
  try {
    // prevTxid is in internal byte order; the displayed txid is its reverse.
    return parseZcashTx(hexToBytes(send.hex)).vin.map(
      (i) => `${bytesToHex(Uint8Array.from(i.prevTxid).reverse())}:${i.prevIndex}`,
    );
  } catch {
    return [];
  }
}
