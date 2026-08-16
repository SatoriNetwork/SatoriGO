// Live-network zustand store — wraps LiveWalletService and exposes clean state
// for the Live UI surface. All network errors are caught; they set `offline`
// rather than crashing. The service instance is module-level (singleton).

import { create } from 'zustand';
import {
  LiveWalletService,
  BroadcastGatedError,
  type FeeEstimate,
  type LiveNetworkId,
  type LiveSendPlan,
  type WalletSummary,
} from '../services/chain/liveWallet';
import { buildFeeEstimate } from '../services/chain/feePolicy';
import { getStorage } from '../services/storage';
import { fetchPrices } from '../services/prices';
import { isValidAddress } from '../services/chain/keys';
import { feePolicyFor, networkFor, supportsAssets } from '../services/chain/chainParams';
import { checkElectrumServer } from '../services/chain/electrumClient';
import {
  DEFAULT_ELECTRUM_SERVER_URLS,
  ELECTRUM_SERVERS_STORAGE_KEY,
  electrumServersStorageKey,
  defaultServerUrlsFor,
  parseServerUrl,
  serverToUrl,
  setElectrumServers,
  type ElectrumEndpoint,
} from '../services/chain/network';
import type {
  LiveAssetBalance,
  LiveAssetMeta,
  LiveTransaction,
} from '../services/chain/electrumProvider';
import type { StakingEvent } from '../services/activityFeed';
import { normalizeApprovals } from '../background/approvals';
import {
  clearTransactionCaches,
  getCachedTransactions,
  refreshTransactionCache,
  type HistoryFetchFailure,
  type TransactionCacheProvider,
} from '../services/chain/txCache';
import type { NetworkStatus } from '../types/domain';
import {
  fetchOpenPools,
  getLenderStatus,
  joinPoolForKeys,
  leavePoolForKeys,
  type PoolInfo,
  type LenderStatus,
} from '../services/satoriPool';
import type { NativeTicker } from '../services/chain/chainParams';

// Module-level singleton — one service, one connection.
const svc = new LiveWalletService();

/** The active wallet's chain id (LiveNetworkId). Everything chain-dependent
 *  (native ticker, protected assets, server pool, explorer, price) reads this so
 *  it follows the active wallet. Exported so UI code (which chain is Send/Receive/
 *  Settings operating on right now) can read the same source of truth instead of
 *  re-deriving it from `wallets`/`activeWalletId` themselves. */
export function activeChainId(): LiveNetworkId {
  return svc.network();
}

/**
 * Human name of a chain (default = active chain), straight from its params.
 *
 * USE THIS IN UI COPY. The pattern it replaces was
 * `nativeTicker === 'RVN' ? 'Ravencoin' : 'EVRmore'`, a two-chain ternary that
 * silently mislabels EVERY chain added since: sending BTC announced the
 * "EVRmore network". A ternary cannot grow with the chain list; a lookup can.
 */
export function chainDisplayName(chainId: string = activeChainId()): string {
  return networkFor(chainId as Parameters<typeof networkFor>[0]).displayName;
}

/** Native coin ticker ('EVR' / 'RVN') of a chain (default = active chain).
 *  Exported for chain-aware UI labels (fee notes, error text, unit suffixes). */
export function nativeTickerFor(chainId: string = activeChainId()): NativeTicker {
  return networkFor(chainId as LiveNetworkId).ticker;
}

/** Whether `assetId` names the chain's NATIVE coin (EVR on Evrmore, RVN on
 *  Ravencoin) rather than an issued asset. Send dispatch MUST use this, never a
 *  hardcoded ticker: on a Ravencoin wallet the native coin arrives as 'RVN', and a
 *  literal `=== 'EVR'` check routed it down the ASSET path, asking the chain for
 *  an asset named "RVN" (which does not exist -> unknown-asset at review). */
export function isNativeAssetId(assetId: string, chainId: string = activeChainId()): boolean {
  return assetId.trim().toUpperCase() === nativeTickerFor(chainId);
}

/** Wallets that live on the SAME chain as `chainId` (default = active chain).
 *
 *  RULE (owner, applies to every future chain): cross-chain sends are impossible.
 *  An R... wallet cannot receive EVR and an E... wallet cannot receive RVN, so
 *  EVERY recipient picker (the My-wallets quick-pick, the address book, any
 *  future suggestion UI) must be scoped to the active wallet's chain with this
 *  helper, not shown unfiltered. */
export function walletsOnChain<T extends { network: string }>(
  wallets: T[],
  chainId: string = activeChainId(),
): T[] {
  const chain = networkFor(chainId as LiveNetworkId).chainId;
  return wallets.filter((w) => networkFor(w.network as LiveNetworkId).chainId === chain);
}

/** True when two chain ids name the SAME chain. Compares the CANONICAL chainId,
 *  so the legacy alias 'mainnet' and 'evrmore-mainnet' are recognised as one
 *  chain (a stored WalletEntry.network is 'mainnet' for Evrmore). */
function sameChain(a: string, b: string): boolean {
  return networkFor(a as LiveNetworkId).chainId === networkFor(b as LiveNetworkId).chainId;
}

/** Every id string that names the same chain as `id`: the canonical ChainId plus
 *  the legacy electrum-role id when that role id resolves BACK to this chain.
 *
 *  Only Evrmore satisfies the round-trip (networkFor('mainnet') IS Evrmore
 *  mainnet), which is exactly the aliasing that exists in stored data and in the
 *  UI's chain lists. Ravencoin also carries `id:'mainnet'` as its ELECTRUM ROLE,
 *  but networkFor('mainnet') is not Ravencoin, so it contributes no alias — the
 *  round-trip check is what keeps this param-driven instead of chain-name based. */
function chainIdAliases(id: string): string[] {
  const net = networkFor(id as LiveNetworkId);
  const aliases: string[] = [net.chainId];
  if (networkFor(net.id).chainId === net.chainId) aliases.push(net.id);
  return aliases;
}

/** The chain ids the user already has at least one wallet on — the "enabled"
 *  set behind the header chain switcher (a chain NOT in here needs enableChain).
 *
 *  ALIASING: each enabled chain contributes EVERY id that names it, so both
 *  `.has('mainnet')` (the LiveNetworkId the UI's chain list uses, and the value
 *  actually stored on an Evrmore WalletEntry) and `.has('evrmore-mainnet')` (the
 *  canonical ChainId) answer true for one Evrmore wallet. Membership is the
 *  contract; `.size` is NOT a chain count. */
export function chainsWithWallets(wallets: WalletSummary[]): Set<string> {
  const out = new Set<string>();
  for (const w of wallets) for (const alias of chainIdAliases(w.network)) out.add(alias);
  return out;
}

/** A wallet's name with its OWN chain's tag stripped off the end, e.g.
 *  "Wallet 1 (Ravencoin)" -> "Wallet 1". enableChain names a derived sibling
 *  `<base> (<target chain>)`, so stripping the tag recovers the shared base name
 *  that groups one seed's wallets across chains. Param-driven (the chain's own
 *  displayName/ticker), so it never needs a table of chain names. */
function baseWalletName(w: { name: string; network: string }): string {
  const net = networkFor(w.network as LiveNetworkId);
  const name = w.name.trim();
  for (const tag of [net.displayName, net.ticker]) {
    const suffix = ` (${tag})`;
    if (name.length > suffix.length && name.toLowerCase().endsWith(suffix.toLowerCase())) {
      return name.slice(0, name.length - suffix.length).trim();
    }
  }
  return name;
}

/** The wallet the chain switcher should switch to for `chainId`, or null when
 *  that chain has no wallet yet (the UI then offers enableChain).
 *
 *  Selection is DETERMINISTIC and input-order stable: among the wallets on that
 *  chain, prefer the SIBLING of the currently active wallet — the one whose
 *  chain-tag-stripped name matches the active wallet's (that is the entry
 *  enableChain derived from the same secret) — otherwise the FIRST one. */
export function walletOnChain(wallets: WalletSummary[], chainId: string): WalletSummary | null {
  const candidates = walletsOnChain(wallets, chainId);
  if (candidates.length === 0) return null;
  // `active` is carried on the summaries themselves, so this stays a pure
  // function of its arguments (no service/store read) and is safe in tests.
  const active = wallets.find((w) => w.active);
  if (active) {
    const base = baseWalletName(active).toLowerCase();
    if (base) {
      const sibling = candidates.find((c) => baseWalletName(c).toLowerCase() === base);
      if (sibling) return sibling;
    }
  }
  return candidates[0];
}

/** Whether Satori pool staking applies on this chain. SATORIEVR is an Evrmore
 *  asset, so staking is Evrmore-only; it is inert on Ravencoin. Exported so the
 *  UI can hide/guard the Stake action without re-deriving the chain check. */
export function stakingSupported(chainId: string = activeChainId()): boolean {
  return nativeTickerFor(chainId) === 'EVR';
}

/** Whether this chain (default = active chain) implements the Ravencoin-style
 *  asset protocol at all, i.e. whether token/asset UI makes sense on it —
 *  "Add token", the Assets list chrome, asset sends. FALSE on a plain UTXO
 *  chain like Bitcoin Gold (BTGS), which has no asset layer. Every asset
 *  affordance in the UI MUST gate on this CAPABILITY, never on a hardcoded
 *  chain name or ticker (`=== 'BTGS'`) — that is what lets a future plain
 *  chain drop in with no UI edits. */
export function assetsSupported(chainId: string = activeChainId()): boolean {
  return supportsAssets(networkFor(chainId as LiveNetworkId));
}

/** The SATORIEVR asset name — the ONLY asset eligible for Satori pool staking. */
const STAKING_ASSET = 'SATORIEVR';

/** Structural view of the dynamic-asset API that LiveWalletService.getProvider()
 *  returns (the ElectrumWalletDataProvider). Declared locally so we depend only
 *  on the verified public method shapes, never on the provider's private fields.
 *  (We must not import the concrete class from src/services/chain for this.) */
interface DynamicAssetProvider {
  getNetworkStatus(): Promise<NetworkStatus>;
  getAllAssetBalances(address: string): Promise<LiveAssetBalance[]>;
  getAssetMeta(name: string): Promise<LiveAssetMeta | null>;
  getAssetBalance(address: string, name: string): Promise<number>;
}

function dynProvider(): DynamicAssetProvider {
  return svc.getProvider() as unknown as DynamicAssetProvider;
}

/** The provider view the transaction cache needs (getAddressHistory +
 *  classifyTxHash). The concrete ElectrumWalletDataProvider implements both;
 *  we only depend on the verified public shapes via TransactionCacheProvider. */
function cacheProvider(): TransactionCacheProvider {
  return svc.getProvider() as unknown as TransactionCacheProvider;
}

export type LivePhase = 'boot' | 'onboarding' | 'locked' | 'ready';

/** Transient sync feedback: 'initial' while a wallet with no cached history runs
 *  its first full refresh (slim banner on home), 'switching' while the active
 *  wallet is being swapped (full-frame loading screen). Never persisted. */
export type LiveSyncing = 'idle' | 'initial' | 'switching';

/** Legacy GLOBAL pin/hide lists (pre-2.2). Kept only for one-time migration into
 *  the active wallet — they were shared across wallets, which is the bug we fix. */
const PINNED_ASSETS_KEY = 'pinnedAssets';
const HIDDEN_ASSETS_KEY = 'hiddenAssets';

/** Per-wallet pin/hide lists: each wallet curates its OWN tokens, so adding or
 *  removing an asset in one wallet never affects another. Keyed by wallet id. */
const pinnedKey = (walletId: string) => `pinnedAssets:${walletId}`;
const hiddenKey = (walletId: string) => `hiddenAssets:${walletId}`;

/** Per-wallet record of what the user has already SEEN in Activity. Anything not
 *  covered by it counts as "new" for the Activity badge. */
const seenTxKey = (walletId: string) => `activitySeen:${walletId}`;

/**
 * How much of Activity the user has already seen.
 *
 * A HIGH-WATER MARK plus a bounded boundary set, because a txid list ALONE
 * cannot work: it has to be capped (a pool-reward wallet has 40,000+ txs and the
 * whole extension shares a 10 MB quota), and the moment a wallet has more
 * transactions than the cap, the txs past it can never be marked seen. That was
 * the bug: the badge cleared to 0 on tap and came back as "9+" on the next 20s
 * refresh, forever, on exactly the wallets that are hardest to use.
 *
 *   height — the highest CONFIRMED block height the user has looked at.
 *            Everything at or below it is seen, no matter how much of it there
 *            is. This is what makes "mark as seen" stick on an unbounded history
 *            at a fixed storage cost. The trade: a genuinely old transaction that
 *            only classifies LATER (the first sync runs newest-first) lands below
 *            the mark and never raises the badge, which is the correct meaning of
 *            "new activity" anyway.
 *   txids  — the newest SEEN_TX_CAP txids. This is the boundary set that keeps
 *            the mark honest across the two ways a height moves under us:
 *              * a PENDING tx has no height at all, so it can only be remembered
 *                by txid — and when it later confirms ABOVE the mark it is still
 *                recognised as seen instead of re-arming the badge;
 *              * a REORG re-confirms recent txs at different heights; those txs
 *                are by definition the newest, so they are inside this set and
 *                stay seen even though their height jumped past the mark.
 */
export interface ActivitySeen {
  /** Highest confirmed height already seen. 0 = nothing seen yet. */
  height: number;
  /** Newest-first txids explicitly seen (pending + reorg boundary). */
  txids: string[];
}

/** Cap on the persisted boundary set. Matches STAKING_EVENTS_CAP / the tx cache
 *  in spirit: bounded storage. It is no longer load-bearing for correctness —
 *  `height` covers everything older — so it only has to be deep enough to span a
 *  realistic reorg, which it is by three orders of magnitude. */
const SEEN_TX_CAP = 400;

/** Nothing seen yet. */
function emptyActivitySeen(): ActivitySeen {
  return { height: 0, txids: [] };
}

/** Read + normalise the persisted seen-record for a wallet.
 *
 *  MIGRATION: builds before this stored a bare `string[]` of txids. That value
 *  is adopted as the boundary set with height 0, so the user's existing "seen"
 *  state survives the upgrade and the first mark-as-seen sets the water mark. */
async function readActivitySeen(walletId: string): Promise<ActivitySeen> {
  try {
    const raw = await getStorage().get<unknown>(seenTxKey(walletId));
    if (Array.isArray(raw)) {
      return { height: 0, txids: raw.filter((x): x is string => typeof x === 'string') };
    }
    if (raw && typeof raw === 'object') {
      const rec = raw as Partial<ActivitySeen>;
      const height = typeof rec.height === 'number' && rec.height > 0 ? Math.floor(rec.height) : 0;
      const txids = Array.isArray(rec.txids)
        ? rec.txids.filter((x): x is string => typeof x === 'string')
        : [];
      return { height, txids };
    }
    return emptyActivitySeen();
  } catch {
    return emptyActivitySeen();
  }
}

/** Per-wallet list of locally-recorded Satori pool staking events (join/leave).
 *  These are real user actions but have no server history endpoint, so we append
 *  them here the moment they succeed. Newest-first; capped when persisted. */
const stakingEventsKey = (walletId: string) => `stakingEvents:${walletId}`;
const STAKING_EVENTS_CAP = 200;

/** Read the persisted staking events for a wallet; defensively coerced so the
 *  Activity feed always gets clean records (drops anything malformed). */
async function readStakingEvents(walletId: string): Promise<StakingEvent[]> {
  try {
    const v = await getStorage().get<unknown>(stakingEventsKey(walletId));
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is StakingEvent =>
        !!e &&
        typeof e === 'object' &&
        ((e as StakingEvent).type === 'pool-join' || (e as StakingEvent).type === 'pool-leave') &&
        typeof (e as StakingEvent).poolAddress === 'string' &&
        typeof (e as StakingEvent).timestamp === 'number',
    );
  } catch {
    return [];
  }
}

/**
 * Count txs not yet marked seen: those ABOVE the water mark that are not in the
 * boundary set. Pure + exported so the badge behaviour is testable directly.
 *
 * A pending tx has no height, so it is unread until its txid is in the set — the
 * only way to keep it seen once it confirms above the mark.
 */
export function countUnread(txs: LiveTransaction[], seen: ActivitySeen): number {
  const set = new Set(seen.txids);
  return txs.reduce((n, t) => {
    if (set.has(t.txid)) return n;
    const height = t.status === 'confirmed' ? (t.blockHeight ?? 0) : 0;
    // height > 0 guards a confirmed tx whose height we never learned: unknown is
    // not "old", so it stays unread rather than being silently swallowed.
    if (height > 0 && height <= seen.height) return n;
    return n + 1;
  }, 0);
}

/**
 * The seen-record after the user has looked at `txs`, given the previous one.
 *
 * The mark only ever moves FORWARD (a reorg that shortens the chain must not
 * un-see history), and the boundary set is rebuilt from what is on screen plus
 * whatever of the previous set is still relevant — so it cannot grow without
 * bound, and a dropped/replaced mempool tx falls out of it on the next mark.
 * Pure + exported for tests.
 */
export function markSeen(txs: LiveTransaction[], prev: ActivitySeen): ActivitySeen {
  // Nothing on screen yet (opened Activity mid-sync): there is nothing to mark,
  // and rebuilding the boundary set from an empty list would DISCARD ids that are
  // still doing their job.
  if (txs.length === 0) return prev;
  let height = prev.height;
  for (const t of txs) {
    if (t.status === 'confirmed' && (t.blockHeight ?? 0) > height) height = t.blockHeight ?? 0;
  }
  // Newest-first (the list already is), capped. Previous ids are kept only while
  // they still name a tx we can see, so replaced mempool txs do not accumulate.
  const onScreen = new Set(txs.map((t) => t.txid));
  const txids = Array.from(
    new Set([...txs.map((t) => t.txid), ...prev.txids.filter((id) => onScreen.has(id))]),
  ).slice(0, SEEN_TX_CAP);
  return { height, txids };
}

/** Persisted live-wallet settings. */
const REQUIRE_PW_KEY = 'requirePasswordToSend';
const EXPLORER_URL_KEY = 'explorerUrlTemplate';
const AUTO_LOCK_MINUTES_KEY = 'autoLockMinutes';
const SETTINGS_MODE_KEY = 'settingsMode';
const HIDDEN_CHAINS_KEY = 'hiddenChains';

/** Chains the user has switched OFF in expert Settings, by canonical chainId.
 *
 *  Hiding is PRESENTATION ONLY. Nothing is deleted, no wallet is touched and no
 *  key is discarded: the chain simply stops appearing in the header switcher and
 *  in the chain picker at wallet creation, so it cannot be switched to or used
 *  for a new wallet. Un-hiding brings it, and any wallet on it, straight back.
 *
 *  STORED AS THE HIDDEN SET, NOT THE VISIBLE ONE, and that is the whole design:
 *  a chain shipped in a later version is then visible by default, with no
 *  migration and no user who silently never sees it. Storing the visible set
 *  would freeze the list at whatever existed the day it was written.
 *
 *  Two chains can never be hidden, enforced here rather than trusted from
 *  storage:
 *    - EVRMORE, the wallet's home chain. Staking lives there and it is the
 *      default every wallet falls back to, so it is not optional.
 *    - the chain currently IN USE. Hiding it would leave the user standing on a
 *      chain absent from their own switcher, with no way back to it. Switch away
 *      first, then hide it.
 */
export function isChainHideable(chainId: string, activeChain: string): boolean {
  return chainHideBlockedReason(chainId, activeChain) === null;
}

/** Why a chain cannot be hidden, or null when it can. The UI copy lives here so
 *  the reason shown and the rule enforced cannot drift apart. */
export function chainHideBlockedReason(chainId: string, activeChain: string): string | null {
  if (networkFor(chainId as LiveNetworkId).ticker === 'EVR') {
    return 'The home network is always available.';
  }
  if (sameChain(chainId, activeChain)) {
    return 'This is the network you are using. Switch to another one first.';
  }
  return null;
}

/** Settings visibility: 'basic' hides the expert-only sections. */
export type SettingsMode = 'basic' | 'expert';
// Read by the background worker (same key) to gate incoming-funds notifications.
const NOTIFY_DEPOSITS_KEY = 'notifyDeposits';

/** Default idle timeout (minutes) before the live wallet auto-locks. 0 = never. */
export const DEFAULT_AUTO_LOCK_MINUTES = 5;

/** Persisted address book (label + address contacts). */
const ADDRESS_BOOK_KEY = 'addressBook';

/** dApp origins the user approved via window.evrmore. MUST mirror
 *  APPROVED_ORIGINS_KEY in src/background/index.ts — the background worker
 *  writes this list on approval and re-reads it on every dApp request, so
 *  removing an origin here revokes its access immediately. */
const DAPP_APPROVED_ORIGINS_KEY = 'dappApprovedOrigins';

/** A saved recipient in the address book. */
export interface Contact {
  label: string;
  address: string;
}

/** One approved dApp connection for the Connected-sites UI: an origin bound to the
 *  wallet it was approved for (M2 fix — see src/background/approvals.ts). */
export interface ConnectedSite {
  origin: string;
  walletId: string;
}

/** One derived receive address of the active wallet ([0] = primary). */
export interface ReceiveAddress {
  index: number;
  address: string;
}

/** Live reachability of one Electrum server (for the online/offline dots). */
export interface ServerStatus {
  status: 'checking' | 'online' | 'offline';
  height?: number;
  latencyMs?: number;
}

/** Per-address Satori lender status: which pool (if any) this held-SATORIEVR
 *  address is registered with. Aggregated to drive the staking UI honestly when
 *  addresses are in different states. */
export interface AddressLenderStatus {
  address: string;
  poolAddress: string | null;
  isPool?: boolean;
}

/** Snapshot of the active wallet's Satori pool-staking state. Server truth is
 *  re-fetched whenever the staking screen opens (never persisted). */
export interface StakingState {
  /** Open pools to delegate to (sorted by commission ascending). */
  pools: PoolInfo[];
  /** Lender status per SATORIEVR-holding address (empty = holds none anywhere). */
  addressStatuses: AddressLenderStatus[];
  /** True while pools + statuses are (re)loading. */
  loading: boolean;
  /** True while a join/leave is in flight (disables the action buttons). */
  submitting: boolean;
  /** Last staking error (offline / server-rejected / partial failure), or null. */
  error: string | null;
  /** True once a refresh has completed at least once this session (drives the
   *  empty-vs-loading distinction). */
  loaded: boolean;
}

/** Default EVRMORE block-explorer URL template. `{txid}` is replaced with the
 *  real txid. */
export const DEFAULT_EXPLORER_URL = 'https://cryptoscope.io/evrmore/tx/?txid={txid}';

/** Default RAVENCOIN block-explorer URL template. Sister site of the Evrmore
 *  default (cryptoscope.io). VERIFIED LIVE 2026-07-21 with curl against the real
 *  txid d88d5229636e92f6602ec9d9ed8496198721e048ea49b63a25ddfe5aa126f2f6 (block
 *  4463131): https://cryptoscope.io/rvn/tx/?txid=<txid> answers HTTP 200 and the
 *  page contains that txid and block height. (https://rvn.cryptoscope.io/tx/?txid=
 *  301-redirects to this canonical /rvn/ URL, so we use the canonical form.) */
export const DEFAULT_EXPLORER_URL_RVN = 'https://cryptoscope.io/rvn/tx/?txid={txid}';

/** Default BITCOIN GOLD block-explorer URL template. VERIFIED LIVE 2026-08-13
 *  with curl against the real txid
 *  afd0d91bfb71d20ef74ea515db18a637fdc59ce0e18547c58c740f2fe0ff033c (block
 *  14,008): https://explore.bitcoingold.site/tx/<txid> answers HTTP 200 and the
 *  page contains that txid. Same host family as the BTGS Electrum pool
 *  (electrum.bitcoingold.site — see network.ts), an Iquidus-style explorer. */
export const DEFAULT_EXPLORER_URL_BTGS = 'https://explore.bitcoingold.site/tx/{txid}';

/** Default LITECOIN block-explorer URL template. VERIFIED LIVE 2026-08-13 with
 *  curl against the real mainnet txid
 *  e8571baab028b63a8c8e9e6724063de6257b2bed0b535d4217b3a0aec8361f74 (block
 *  3,159,489, confirmed 2026-08-13): https://litecoinspace.org/tx/<txid> answers
 *  HTTP 200. litecoinspace.org is a mempool.space-style single-page app (the
 *  txid is rendered client-side, not present in the served HTML shell), so the
 *  verification instead cross-checked its own API
 *  (litecoinspace.org/api/tx/<txid>/status), which returned the SAME block
 *  height/hash against the live chain tip -- confirming a real, working
 *  Litecoin explorer rather than just a 200 on an empty shell. */
export const DEFAULT_EXPLORER_URL_LTC = 'https://litecoinspace.org/tx/{txid}';

/** Default BITCOIN block-explorer URL template. VERIFIED LIVE 2026-08-14
 *  against the real mainnet txid
 *  6869395002ec527371a67a23b82948121b74f066f3908f1cb881fde38af0a5f7 (block
 *  962,407, hash 000000000000000000011e7080a6ce52c8410ae39b714c52858bde9fa7c63517):
 *  https://mempool.space/tx/<txid> answers HTTP 200. mempool.space is a
 *  single-page app (the txid is rendered client-side, not present in the
 *  served HTML shell), so the verification instead cross-checked its own API
 *  (mempool.space/api/tx/<txid>/status), which returned {confirmed:true,
 *  block_height:962407, block_hash:<the same hash>} against the live chain --
 *  confirming a real, working Bitcoin explorer rather than just a 200 on an
 *  empty shell. Same verification methodology as the Litecoin explorer above. */
export const DEFAULT_EXPLORER_URL_BTC = 'https://mempool.space/tx/{txid}';

/** Default DOGECOIN block-explorer URL template. VERIFIED LIVE 2026-08-15
 *  against the real mainnet txid
 *  900e1fd60505f280d133eedf86604334501bd4f8687cae9f194713bd92d79f67 (the
 *  coinbase of block 6,333,404, obtained from the chain itself via
 *  blockchain.transaction.id_from_pos on the verified DOGE ElectrumX pool):
 *  https://3xpl.com/dogecoin/transaction/<txid> answered HTTP 200 with the
 *  SERVED HTML already containing that txid (12 times) AND the block height
 *  6,333,404 -- i.e. server-rendered real data cross-checked against the live
 *  chain, a stronger check than the SPA-shell cases above. The obvious
 *  candidate dogechain.info sits behind a Cloudflare challenge (HTTP 403), and
 *  blockchair (401) / blockcypher (403) / sochain (403) all refused automated
 *  verification, so per the "only verified URLs" rule none of them may be
 *  listed. */
export const DEFAULT_EXPLORER_URL_DOGE = 'https://3xpl.com/dogecoin/transaction/{txid}';

/**
 * WOJAKCOIN's explorer, supplied and confirmed by the owner 2026-08-15 from a
 * real transaction page:
 *   https://explorer.wojakcoin.cash/tx/8d393b5a304d2ba25b9a50aaf817a784b992025fa7aec173943e268120790356
 *
 * It could NOT be verified from here, and that is worth recording rather than
 * hiding: the host sits behind a Cloudflare challenge that returns 403 to curl
 * AND to a real headless Chromium ("Performing security verification"). A user's
 * own browser passes that challenge, and the wallet opens this in a real tab, so
 * the link works where it matters. The evidence is therefore human, not machine
 * (unlike the other chains, each confirmed here against a live txid).
 */
export const DEFAULT_EXPLORER_URL_WJK = 'https://explorer.wojakcoin.cash/tx/{txid}';

/** Block-explorer template default for a chain (default = active chain). '' on
 *  a chain with no known explorer (see the WOJAKCOIN comment above) — callers
 *  must treat an empty template as "no explorer available", not fall through
 *  to another chain's URL.
 *
 *  This is the SINGLE place that knows which chains have an explorer; the
 *  absence of an entry IS the answer, so nothing else needs a chain check. */
function defaultExplorerFor(chainId: string = activeChainId()): string {
  const ticker = nativeTickerFor(chainId);
  if (ticker === 'RVN') return DEFAULT_EXPLORER_URL_RVN;
  if (ticker === 'BTGS') return DEFAULT_EXPLORER_URL_BTGS;
  if (ticker === 'LTC') return DEFAULT_EXPLORER_URL_LTC;
  if (ticker === 'BTC') return DEFAULT_EXPLORER_URL_BTC;
  if (ticker === 'DOGE') return DEFAULT_EXPLORER_URL_DOGE;
  if (ticker === 'WJK') return DEFAULT_EXPLORER_URL_WJK;
  if (ticker === 'EVR') return DEFAULT_EXPLORER_URL;
  // A chain with no known explorer fails closed rather than borrowing another
  // chain's, which would resolve a foreign txid on the wrong chain and read to
  // the user as "not found". Every chain shipped today has one.
  return '';
}

/** True when the chain ships a built-in explorer template. DERIVED from
 *  defaultExplorerFor so a new chain never needs a second edit here, and a
 *  chain can never claim an explorer it does not have. */
export function hasDefaultExplorer(chainId: string = activeChainId()): boolean {
  return defaultExplorerFor(chainId) !== '';
}

/** Per-chain storage key for the user-editable explorer template. Evrmore keeps
 *  the legacy bare key ('explorerUrlTemplate'); Ravencoin, Bitcoin Gold,
 *  Litecoin, WojakCoin, Bitcoin and Dogecoin are each suffixed with their own
 *  canonical chainId (WojakCoin's key exists so a user who later types in their
 *  own explorer URL still gets a chain-isolated slot, even though there is no
 *  built-in default). */
function explorerKeyForChain(chainId: string = activeChainId()): string {
  const ticker = nativeTickerFor(chainId);
  if (ticker === 'RVN') return `${EXPLORER_URL_KEY}:ravencoin-mainnet`;
  if (ticker === 'BTGS') return `${EXPLORER_URL_KEY}:bitcoingold-mainnet`;
  if (ticker === 'LTC') return `${EXPLORER_URL_KEY}:litecoin-mainnet`;
  if (ticker === 'WJK') return `${EXPLORER_URL_KEY}:wojakcoin-mainnet`;
  if (ticker === 'BTC') return `${EXPLORER_URL_KEY}:bitcoin-mainnet`;
  if (ticker === 'DOGE') return `${EXPLORER_URL_KEY}:dogecoin-mainnet`;
  return EXPLORER_URL_KEY;
}

/** Auto-refresh cadence for the quiet background poll. */
const AUTO_REFRESH_MS = 20_000;

/** Best-effort persist of a string list (same wrapper the app uses elsewhere). */
function persistList(key: string, value: string[]): void {
  try {
    void getStorage().set(key, value).catch(() => {});
  } catch {
    // ignore — storage unavailable
  }
}

/** Parse a list of wss:// URLs and make them the given CHAIN's Electrum pool (an
 *  empty or all-invalid list falls back to that chain's built-in defaults).
 *  Applied synchronously so a following reconnect/refresh already uses the new
 *  pool (no storage race). Default chain = the active chain. */
function activateServerUrls(urls: string[], chainId: string = activeChainId()): void {
  const parsed = urls
    .map(parseServerUrl)
    .filter((ep): ep is ElectrumEndpoint => ep !== null);
  setElectrumServers(parsed.length > 0 ? parsed : null, chainId);
}

/** Read a persisted string list; empty array on a fresh install / error. */
async function readList(key: string): Promise<string[]> {
  try {
    const v = await getStorage().get<string[]>(key);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Read the raw (possibly-legacy) dApp approvals list for migration by
 *  normalizeApprovals. Returns undefined on error/absence (treated as empty). */
async function readApprovalsRaw(): Promise<unknown> {
  try {
    return await getStorage().get<unknown>(DAPP_APPROVED_ORIGINS_KEY);
  } catch {
    return undefined;
  }
}

/** Best-effort persist of a single value (same wrapper the app uses elsewhere). */
function persistValue(key: string, value: unknown): void {
  try {
    void getStorage().set(key, value).catch(() => {});
  } catch {
    // ignore — storage unavailable
  }
}

/** Read a persisted value; undefined on a fresh install / error. */
async function readValue<T>(key: string): Promise<T | undefined> {
  try {
    return await getStorage().get<T>(key);
  } catch {
    return undefined;
  }
}

/** Read the persisted address book; empty array on a fresh install / error.
 *  Filters out any malformed entries so the UI always gets clean {label,address}. */
async function readAddressBook(): Promise<Contact[]> {
  try {
    const v = await getStorage().get<Contact[]>(ADDRESS_BOOK_KEY);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (c): c is Contact =>
        !!c && typeof c === 'object' && typeof c.label === 'string' && typeof c.address === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * The assets a wallet is FOR, per chain. Always shown, never removable:
 *  - Evrmore: EVR (pays every fee) + SATORIEVR (Satori GO is a Satori-Network
 *    wallet). Neither shows a remove control; `removeAsset` refuses them.
 *  - Ravencoin: RVN only (no SATORIEVR — that is an Evrmore asset).
 *  - A chain with no asset protocol at all (e.g. Bitcoin Gold / BTGS): just its
 *    native coin — nothing else can ever be pinned/held there, so there is
 *    nothing more to protect. Driven by the assetsSupported() CAPABILITY, so a
 *    future plain chain is covered with no edits here.
 * Default chain = Evrmore, so the exported constant/helpers keep their historical
 * behavior for every existing caller.
 */
export function protectedAssetsFor(chainId: string = activeChainId()): readonly string[] {
  const ticker = nativeTickerFor(chainId);
  if (!assetsSupported(chainId)) return [ticker];
  return ticker === 'EVR' ? ['EVR', 'SATORIEVR'] : [ticker];
}

/** Evrmore protected assets (historical default; kept for back-compat callers). */
export const PROTECTED_ASSETS: readonly string[] = ['EVR', 'SATORIEVR'];

/** False for a protected asset of the given chain (default active). The single
 *  source of truth for every remove control. */
export function isRemovableAsset(name: string, chainId: string = activeChainId()): boolean {
  return !protectedAssetsFor(chainId).includes(name.trim().toUpperCase());
}

/** Assets pinned out of the box for a chain, so nobody has to "Add token" for the
 *  asset the wallet exists for. The native coin is never listed: it is always
 *  first, by construction. Evrmore pins SATORIEVR; Ravencoin pins nothing; a
 *  chain with no asset protocol (BTGS) pins nothing — there is nothing it could
 *  pin. */
export function defaultPinsFor(chainId: string = activeChainId()): readonly string[] {
  if (!assetsSupported(chainId)) return [];
  return nativeTickerFor(chainId) === 'EVR' ? ['SATORIEVR'] : [];
}

/** Evrmore default pins (historical default; kept for back-compat callers). */
export const DEFAULT_PINNED_ASSETS = ['SATORIEVR'] as const;

/**
 * Ensure the chain's default assets are pinned. Returns the SAME array reference
 * when nothing changes, so callers can skip a pointless write to storage.
 */
export function applyDefaultPins(pinned: string[], chainId: string = activeChainId()): string[] {
  const missing = defaultPinsFor(chainId).filter((name) => !pinned.includes(name));
  return missing.length ? [...pinned, ...missing] : pinned;
}

/**
 * Drop protected assets from a hide-list.
 *
 * They are not removable now, but an EARLIER build let SATORIEVR be removed. Without
 * this, anyone who did that would keep an invisible SATORIEVR forever, with no
 * remove/restore control to undo it. Same reference back when there is nothing to do.
 */
export function unhideProtected(hidden: string[], chainId: string = activeChainId()): string[] {
  const kept = hidden.filter((n) => isRemovableAsset(n, chainId));
  return kept.length === hidden.length ? hidden : kept;
}

/**
 * Compute the DISPLAYED asset list = (held assets ∪ pinned) − hidden, with EVR
 * always first (never hidden/removed). A pinned-but-not-currently-held asset is
 * shown with amount 0. Pure + exported so the UI and tests can share it.
 */
export function computeDisplayedAssets(
  assets: LiveAssetBalance[],
  pinned: string[],
  hidden: string[],
  chainId: string = activeChainId(),
): LiveAssetBalance[] {
  // Native coin name for this chain (EVR / RVN) — always first, never hidden.
  const native = nativeTickerFor(chainId);
  const nativeRow =
    assets.find((a) => a.isNative || a.name === native) ??
    ({ name: native, amount: 0, decimals: 8, isNative: true } as LiveAssetBalance);

  // A protected asset can never be hidden, whatever the list says.
  const hiddenSet = new Set(hidden.filter((n) => isRemovableAsset(n, chainId)));

  // Held (non-native) assets keyed by name.
  const byName = new Map<string, LiveAssetBalance>();
  for (const a of assets) {
    if (a.isNative || a.name === native) continue;
    byName.set(a.name, a);
  }
  // Pinned-but-not-held show up with a 0 balance.
  for (const name of pinned) {
    if (name === native) continue;
    if (!byName.has(name)) {
      byName.set(name, { name, amount: 0, decimals: 8, isNative: false });
    }
  }

  const rest = Array.from(byName.values())
    .filter((a) => !hiddenSet.has(a.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [{ ...nativeRow, name: native, isNative: true }, ...rest];
}

/**
 * Merge per-address balance lists into one aggregated list: amounts are summed
 * per asset name (decimals kept from the first sighting), EVR stays first and
 * the rest sort alphabetically. Pure + exported for tests.
 */
export function mergeAssetBalances(lists: LiveAssetBalance[][]): LiveAssetBalance[] {
  const byName = new Map<string, LiveAssetBalance>();
  for (const list of lists) {
    for (const a of list) {
      const prev = byName.get(a.name);
      byName.set(a.name, prev ? { ...prev, amount: prev.amount + a.amount } : { ...a });
    }
  }
  // The native coin (flagged isNative — EVR or RVN) is always first; the rest
  // sort alphabetically. Chain-agnostic: never keys on a hardcoded 'EVR' name.
  const native = Array.from(byName.values()).find((a) => a.isNative);
  const rest = Array.from(byName.values())
    .filter((a) => !a.isNative)
    .sort((a, b) => a.name.localeCompare(b.name));
  return native ? [native, ...rest] : rest;
}

/** Sort classified txs: pending (mempool) first, then confirmed by height desc.
 *  (Mirrors the per-address cache ordering so the merged list matches it.) */
function compareLiveTx(a: LiveTransaction, b: LiveTransaction): number {
  const aPending = a.status === 'pending';
  const bPending = b.status === 'pending';
  if (aPending && !bPending) return -1;
  if (!aPending && bPending) return 1;
  return (b.blockHeight ?? 0) - (a.blockHeight ?? 0);
}

/**
 * Merge per-address transaction lists into ONE WALLET-LEVEL list, deduped by
 * txid and sorted.
 *
 * Each address classifies the same transaction independently and only ever sees
 * its own side of it. Picking one of those entries (the old behaviour) reported
 * that address's movement as if it were the wallet's: sending 1 EVR out of a
 * 100 EVR utxo with the change returning to another of our own addresses showed
 * "out 100". The wallet-level truth is the SUM of the per-address nets, so that
 * is what this computes. The same applies to the fee, which is per-address and
 * clamped at zero, hence the raw spentNative/totalOutNative fields.
 *
 * Amount keeps its existing meaning for a send: value that left the wallet,
 * fee included. A transfer between two of our OWN addresses therefore nets to
 * just the fee, which is what it actually cost.
 *
 * Pure + exported for tests.
 */
export function mergeTransactions(lists: LiveTransaction[][]): LiveTransaction[] {
  const EPS = 1e-9;
  const groups = new Map<string, LiveTransaction[]>();
  for (const list of lists) {
    for (const tx of list) {
      const group = groups.get(tx.txid);
      if (group) group.push(tx);
      else groups.set(tx.txid, [tx]);
    }
  }

  const merged: LiveTransaction[] = [];
  for (const entries of groups.values()) {
    // One address, nothing to aggregate: the classifier's view IS the wallet's.
    if (entries.length === 1) {
      merged.push(entries[0]);
      continue;
    }

    // Signed net per asset across every one of our addresses in this tx.
    const netByAsset = new Map<string, number>();
    for (const e of entries) {
      const signed = e.direction === 'in' ? e.amount : -e.amount;
      netByAsset.set(e.asset, (netByAsset.get(e.asset) ?? 0) + signed);
    }
    // Same dominance rule the classifier uses: the largest absolute movement is
    // the asset this transaction is "about".
    let asset = entries[0].asset;
    let net = netByAsset.get(asset) ?? 0;
    for (const [name, value] of netByAsset) {
      if (Math.abs(value) > Math.abs(net) + EPS) {
        asset = name;
        net = value;
      }
    }

    // Fee is a property of the whole transaction: our total inputs minus its
    // total outputs. Falls back to the largest per-address value when an older
    // cached entry has no raw fields, which is what it used to report anyway.
    const haveRaw = entries.every((e) => e.spentNative != null && e.totalOutNative != null);
    const feeEvr = haveRaw
      ? Math.max(
          0,
          entries.reduce((sum, e) => sum + (e.spentNative ?? 0), 0) - (entries[0].totalOutNative ?? 0),
        )
      : Math.max(...entries.map((e) => e.feeEvr));

    // Keep the sender's view for the descriptive fields: its counterparty is the
    // external recipient, which is the useful one to show.
    const representative = entries.find((e) => e.direction === 'out') ?? entries[0];
    merged.push({
      ...representative,
      asset,
      amount: Math.abs(net),
      direction: net >= 0 ? 'in' : 'out',
      feeEvr,
    });
  }

  return merged.sort(compareLiveTx);
}

/** USD value of `amount` at `price` (both in the same asset unit), or null when
 *  no price is known for the asset. Pure + exported so the UI and tests share it. */
export function usdValue(amount: number, price?: number): number | null {
  return price != null ? amount * price : null;
}

/** A server REFUSAL of one of the wallet's addresses, ready to render.
 *
 *  Deliberately NOT the `offline` flag: the wallet is online, balances are
 *  live, sending works. Only the transaction history of this address is
 *  unavailable, and it will stay unavailable on this server however long the
 *  user waits — which is precisely what they need to be told. */
export interface HistoryIssue {
  /** Which of the wallet's addresses the server refused. */
  address: string;
  /** Short, non-technical line for the UI. */
  message: string;
  /** The server's own words, for the tooltip / diagnostics. */
  serverMessage: string;
}

/** Turn a cache-layer history failure into UI copy. Chain-agnostic wording: no
 *  chain name, no ticker, so it reads correctly on every chain. Pure + exported
 *  for tests. Returns null for a plain unreachable server, which is ordinary
 *  offline and already has its own indicator. */
export function describeHistoryIssue(failure: HistoryFetchFailure): HistoryIssue | null {
  if (failure.reason === 'unreachable') return null;
  return {
    address: failure.address,
    message:
      failure.reason === 'too-large'
        ? 'Activity is incomplete: this address has too much history for the server. Try another server in Settings.'
        : 'Activity is incomplete: the server refused to return this address history.',
    serverMessage: failure.message,
  };
}

/**
 * Transactions this wallet just BROADCAST, held locally until a sync sees them.
 *
 * A send used to disappear into nothing: broadcast() fires refreshes at 0/3/8s,
 * but the tx-sync guard skips every one of them while a full classification is
 * running, so on a wallet with real history the user pressed Send and Activity
 * showed absolutely nothing until a sync that can take minutes finished. This is
 * the path that does not wait: the plan already knows the txid, asset, amount,
 * fee and recipient, so the pending row is built locally and shown immediately,
 * with no network call at all (it works even before the tx has propagated).
 *
 * Module scope (like txSyncRun) so it survives the `set` calls that replace
 * `txs` wholesale; keyed by the address that sent it so a wallet switch can
 * never show one wallet's send on another's screen.
 */
interface LocalPendingTx {
  /** Primary address of the wallet that broadcast it. */
  address: string;
  tx: LiveTransaction;
  /** When it was broadcast (for the expiry below). */
  at: number;
}
let localPendingTxs: LocalPendingTx[] = [];

/** How long an unconfirmed local entry is kept when no sync ever reports it.
 *  Long enough to cover a slow mempool and a long first sync, short enough that
 *  a tx the network genuinely dropped stops being displayed as pending. */
const LOCAL_PENDING_TTL_MS = 10 * 60_000;

/** Merge the local just-sent rows for `address` into a SERVER-DERIVED list
 *  (cache read or completed sync), dropping any the server now reports itself
 *  and any that expired. Never call this with a list that already contains them
 *  or an entry would retire itself on sight of its own row. */
function withLocalPending(address: string, txs: LiveTransaction[]): LiveTransaction[] {
  if (localPendingTxs.length === 0) return txs;
  const now = Date.now();
  const known = new Set(txs.map((t) => t.txid));
  localPendingTxs = localPendingTxs.filter(
    (p) => now - p.at < LOCAL_PENDING_TTL_MS && !(p.address === address && known.has(p.tx.txid)),
  );
  const mine = localPendingTxs.filter((p) => p.address === address).map((p) => p.tx);
  return mine.length > 0 ? [...mine, ...txs].sort(compareLiveTx) : txs;
}

/** Build the pending row for a just-broadcast plan, relative to the sending
 *  wallet. Mirrors what the classifier will report for the same transaction
 *  once the server has it, so the row does not visibly change when the real one
 *  replaces it: for a native send the amount is what LEFT the wallet (fee
 *  included, the per-address convention documented on mergeTransactions); for an
 *  asset send it is the asset amount, with the fee carried separately. Pure +
 *  exported for tests. */
export function localPendingFromPlan(plan: LiveSendPlan, chainId: string): LiveTransaction {
  const feeNative = Number(plan.feeSats) / 1e8;
  // On-chain base units are always 1e8, for the native coin AND every asset
  // (an asset's `decimals` is display precision only) — see electrumProvider.
  const sent = Number(plan.amountSats) / 1e8;
  const isAsset = !!plan.assetName;
  return {
    txid: plan.built.txid,
    asset: plan.assetName ?? nativeTickerFor(chainId),
    direction: 'out',
    amount: isAsset ? sent : sent + feeNative,
    feeEvr: feeNative,
    status: 'pending',
    timestamp: Date.now(),
    counterparty: plan.toAddress,
  };
}

interface LiveState {
  // --- wallet phase ---------------------------------------------------------
  phase: LivePhase;

  // --- wallet data ----------------------------------------------------------
  /** Primary receive address (= addresses[0].address) — kept for back-compat. */
  address: string;
  /** All derived receive addresses of the active wallet ([0] = primary). */
  addresses: ReceiveAddress[];
  /** Dynamically-detected balances aggregated across ALL addresses (EVR first). */
  assets: LiveAssetBalance[];
  /** User-added (pinned) asset names — persisted. */
  pinnedAssets: string[];
  /** User-removed (hidden) asset names — persisted. */
  hiddenAssets: string[];
  txs: LiveTransaction[];
  /** Latest USD (≈ USDT) prices for the priced assets. Absent key = no price yet.
   *  EVR + SATORIEVR (Evrmore), RVN (Ravencoin), LTC (Litecoin), BTC (Bitcoin)
   *  and DOGE (Dogecoin) are the only priced assets. */
  prices: { EVR?: number; SATORIEVR?: number; RVN?: number; LTC?: number; BTC?: number; DOGE?: number };
  /** Number of transactions not yet viewed in Activity (drives the tab badge). */
  unreadActivity: number;
  /** What the active wallet has already seen in Activity (persisted per wallet):
   *  a height water mark plus the newest txids. See ActivitySeen. */
  activitySeen: ActivitySeen;
  /** Set when a server ANSWERED and refused one of this wallet's addresses (e.g.
   *  "history too large"), so Activity is knowingly incomplete. Null when every
   *  address's history was read. Never persisted: it is re-learned every sync. */
  historyIssue: HistoryIssue | null;
  /** Locally-recorded Satori pool staking events for the active wallet (newest
   *  first; persisted per wallet). Merged into the Activity feed. */
  stakingEvents: StakingEvent[];
  network: NetworkStatus | null;

  // --- multi-wallet ---------------------------------------------------------
  /** All wallets (metadata only — never a secret). */
  wallets: WalletSummary[];
  /** Id of the currently-active wallet, or null when there are none. */
  activeWalletId: string | null;
  /** True while the "add wallet" onboarding flow is showing over a ready wallet. */
  addingWallet: boolean;

  // --- persisted live settings ----------------------------------------------
  /** When true, the wallet password must be re-entered before every broadcast. */
  requirePasswordToSend: boolean;
  /** Block-explorer URL template with a `{txid}` placeholder. */
  explorerUrlTemplate: string;
  /** Idle timeout (minutes) before the live wallet auto-locks. 0 = never. */
  autoLockMinutes: number;
  /** How much of Settings to show. 'basic' hides the sections a normal user has
   *  no reason to touch (servers, raw addresses, diagnostics); 'expert' shows
   *  everything. A view filter only: it never changes what the wallet does. */
  settingsMode: SettingsMode;
  /** Canonical chainIds the user has hidden from the switcher and the chain
   *  picker. Presentation only: no wallet or key is affected. */
  hiddenChains: string[];
  /** When true, the background worker notifies on incoming funds to any wallet. */
  notifyDeposits: boolean;
  /** User-managed Electrum server pool as `wss://host:port` URLs (persisted). */
  electrumServers: string[];
  /** Live reachability of each server (keyed by URL) for the online/offline dots. */
  serverStatus: Record<string, ServerStatus>;

  // --- address book ---------------------------------------------------------
  /** Persisted list of saved recipients ({label, address}). */
  addressBook: Contact[];

  // --- connected dApp sites ---------------------------------------------------
  /** {origin, walletId} approvals granted via window.evrmore (written by the
   *  background worker). Each entry is only active while its wallet is active. */
  connectedSites: ConnectedSite[];

  // --- transient mnemonic (shown once after create, never persisted) ---------
  pendingMnemonic: string | null;

  // --- pending send plan ----------------------------------------------------
  sendPlan: LiveSendPlan | null;

  // --- Satori pool staking (SATORIEVR only) ---------------------------------
  /** Live pool-staking state for the active wallet (server truth; not persisted). */
  staking: StakingState;

  // --- flags ----------------------------------------------------------------
  loadingRefresh: boolean;
  loadingSend: boolean;
  offline: boolean;
  error: string | null;
  /** Transient sync feedback (never persisted) — see LiveSyncing. */
  syncing: LiveSyncing;
  /** Progress of the background tx-history classification for the active wallet.
   *  Non-null (with total > 0) while a sync has txs left to classify this run;
   *  null when idle / complete. Session-only, never persisted. */
  syncProgress: { done: number; total: number } | null;
  /** Wall-clock time the last background tx sync completed for the active
   *  address, or null if none has this session. Session-only, never persisted;
   *  cleared alongside `txs` on lock / wallet switch / unlock start. */
  lastSyncAt: number | null;

  // --- actions --------------------------------------------------------------
  exists(): Promise<boolean>;
  init(): Promise<void>;
  // The optional `network` selects the wallet's chain (default 'mainnet' = Evrmore).
  // Phase-3 UI will pass it; plumbed through now so the chain reaches the service.
  createWallet(password: string, name?: string, network?: LiveNetworkId): Promise<void>;
  clearPendingMnemonic(): void;
  /** `passphrase` is the BIP39 passphrase (the "25th word"), part of the seed
   *  derivation and NOT the wallet password. Empty = today's behaviour. */
  importWallet(
    mnemonic: string,
    password: string,
    name?: string,
    network?: LiveNetworkId,
    passphrase?: string,
  ): Promise<void>;
  importPrivateKeyWallet(input: string, password: string, name?: string, network?: LiveNetworkId): Promise<void>;
  unlock(password: string): Promise<boolean>;
  lock(): void;

  // --- address book actions -------------------------------------------------
  addContact(label: string, address: string): { ok: true } | { ok: false; error: string };
  renameContact(address: string, label: string): { ok: true } | { ok: false; error: string };
  removeContact(address: string): void;

  // --- connected dApp site actions --------------------------------------------
  /** Reload the {origin, walletId} approval list from storage into state. */
  loadConnectedSites(): Promise<void>;
  /** Revoke ONE {origin, walletId} approval — the worker re-reads the list per
   *  request, so that site+wallet pair loses access immediately until re-approved. */
  disconnectSite(origin: string, walletId: string): Promise<void>;
  /** Revoke every approval at once. */
  disconnectAllSites(): Promise<void>;

  // --- multi-address actions ------------------------------------------------
  /** Reload all receive addresses of the active wallet (requires unlocked). */
  loadAddresses(): Promise<void>;
  /** Derive + persist one more receive address (seed wallets only). */
  addReceiveAddress(): Promise<{ ok: boolean; error?: string }>;

  // --- multi-wallet actions -------------------------------------------------
  loadWallets(): Promise<void>;
  switchWallet(id: string): Promise<void>;

  // --- chain switching (MetaMask-style network switcher) --------------------
  /** Make `chainId` the active chain by switching to the wallet that lives on
   *  it (walletOnChain picks which). No-op when that chain is already active, or
   *  when it has no wallet yet — call enableChain for that. */
  switchChain(chainId: string): Promise<void>;
  /** Derive a NEW wallet on `chainId` from the ACTIVE wallet's EXISTING secret,
   *  so the user never retypes their recovery phrase. `password` is the ACTIVE
   *  wallet's password ('' for a passwordless wallet). Returns {ok:false,error}
   *  on a wrong password, an already-enabled chain, or any failure — and creates
   *  nothing in those cases. */
  enableChain(chainId: string, password: string): Promise<{ ok: boolean; error?: string }>;

  addWalletStart(): void;
  cancelAddWallet(): void;
  renameWallet(id: string, name: string): Promise<void>;
  removeWallet(id: string): Promise<void>;

  // --- reveal secrets (password-gated) --------------------------------------
  revealMnemonic(password: string): Promise<string | null>;
  revealPrivateKey(password: string): Promise<string | null>;
  refresh(opts?: { silent?: boolean }): Promise<void>;
  /** Fetch live USD prices and merge them into `prices` (best-effort, never throws). */
  loadPrices(): Promise<void>;
  startAutoRefresh(): void;
  stopAutoRefresh(): void;
  addAsset(name: string): Promise<{ ok: true } | { ok: false; error: string }>;
  removeAsset(name: string): void;
  loadWalletAssets(): Promise<void>;
  /** Mark all current activity as seen (clears the badge); persists per wallet. */
  markActivitySeen(): void;
  // --- Satori pool staking (SATORIEVR only) ---------------------------------
  /** Reload open pools + per-address lender status for all SATORIEVR-holding
   *  addresses of the active wallet. Errors set staking.error (never throw). */
  refreshStaking(): Promise<void>;
  /** Register every SATORIEVR-holding address as a lender of `poolAddress`
   *  (leave-then-join handled server-side). Refreshes status after. */
  joinPool(poolAddress: string): Promise<{ ok: boolean; error?: string }>;
  /** Deregister every SATORIEVR-holding address from its pool. Refreshes after. */
  leavePool(): Promise<{ ok: boolean; error?: string }>;
  /** Append a staking event to the active wallet's persisted list (newest first,
   *  capped) and to in-memory state. Called on a successful join/leave. */
  recordStakingEvent(event: StakingEvent): void;

  /** Build a send plan. `feeRateSatPerByte` is the user's chosen rate from
   *  estimateFeeOptions() (option or custom); omitted = the wallet probes the
   *  server itself. The service re-clamps ANY passed rate into the chain's
   *  [floor, ceiling] policy band, so this can never drain funds or undercut
   *  the relay floor even with a poisoned value. */
  buildSend(
    to: string,
    amountDecimal: number,
    assetId: string,
    feeRateSatPerByte?: bigint,
  ): Promise<LiveSendPlan | null>;
  estimateMaxEvr(feeRateSatPerByte?: bigint): Promise<{ maxDecimal: number; feeDecimal: number }>;
  /** Fee options for the ACTIVE chain (speed curve where the chain really has
   *  one, plus floor/ceiling/default for display and custom-rate validation).
   *  NEVER rejects: if even the service's own degraded path throws, this
   *  resolves to the chain's static policy defaults (differentiated: false),
   *  so the send screen is never blocked and never silently unbounded. */
  estimateFeeOptions(): Promise<FeeEstimate>;
  clearSendPlan(): void;
  arm(on: boolean): void;
  broadcast(rawHex: string): Promise<string>;
  verifyPassword(password: string): Promise<boolean>;
  changePassword(oldPassword: string, newPassword: string): Promise<boolean>;
  setRequirePasswordToSend(on: boolean): void;
  setExplorerUrlTemplate(url: string): void;
  setAutoLockMinutes(minutes: number): void;
  setSettingsMode(mode: SettingsMode): void;
  /** Show or hide a chain. Refuses silently for a chain that must stay visible
   *  (see chainHideBlockedReason), so a stale UI cannot force a bad state. */
  setChainHidden(chainId: string, hidden: boolean): void;
  setNotifyDeposits(on: boolean): void;
  // --- Electrum server pool (user-managed) ----------------------------------
  addElectrumServer(url: string): { ok: true } | { ok: false; error: string };
  removeElectrumServer(url: string): void;
  resetElectrumServers(): void;
  /** Ping every configured server (wss connect + block height) and set the dots. */
  checkServers(): Promise<void>;
  resetLiveWallet(): Promise<void>;
}

/** Fresh (unloaded) staking snapshot — used to reset `staking` on lock/switch/
 *  remove so one wallet's server-truth staking data never leaks onto another's
 *  screen (the same reasoning as clearing pinnedAssets/hiddenAssets/txs there). */
function emptyStaking(): StakingState {
  return { pools: [], addressStatuses: [], loading: false, submitting: false, error: null, loaded: false };
}

/** LTC/USDT last price from the SAME CoinEx v2 spot-ticker endpoint family
 *  services/prices.ts already uses for EVR and RVN. Fetched here, self-
 *  contained, rather than plumbed through fetchPrices() there: it is a small,
 *  local addition, and api.coinex.com is already in host_permissions (EVR/RVN
 *  use it), so no manifest change is needed either. Self-caches for
 *  LTC_PRICE_CACHE_MS so the 20s auto-refresh tick doesn't hammer CoinEx on an
 *  LTC wallet -- mirrors fetchPrices()'s own cache window. Never throws;
 *  undefined on any failure (network / CORS / non-OK / malformed). */
const LTC_TICKER_URL = 'https://api.coinex.com/v2/spot/ticker?market=LTCUSDT';
const LTC_PRICE_CACHE_MS = 60_000;
let ltcPriceCache: { value: number; at: number } | null = null;

async function fetchLtcPrice(): Promise<number | undefined> {
  const now = Date.now();
  if (ltcPriceCache && now - ltcPriceCache.at < LTC_PRICE_CACHE_MS) return ltcPriceCache.value;
  try {
    const res = await fetch(LTC_TICKER_URL);
    if (!res.ok) return undefined;
    const json: unknown = await res.json();
    if (!json || typeof json !== 'object' || (json as { code?: unknown }).code !== 0) return undefined;
    const data = (json as { data?: unknown }).data;
    const first = Array.isArray(data) ? (data[0] as unknown) : undefined;
    const last = first && typeof first === 'object' ? (first as { last?: unknown }).last : undefined;
    const n = typeof last === 'string' ? parseFloat(last) : typeof last === 'number' ? last : NaN;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    ltcPriceCache = { value: n, at: now };
    return n;
  } catch {
    return undefined;
  }
}

/** BTC/USDT last price, the SAME self-contained CoinEx v2 spot-ticker approach
 *  as fetchLtcPrice() above (own market, own cache, own failure handling) --
 *  api.coinex.com is already in host_permissions, so this needs no manifest
 *  change either. Endpoint verified live 2026-08-14: GET
 *  https://api.coinex.com/v2/spot/ticker?market=BTCUSDT returned {"code":0,
 *  "data":[{"market":"BTCUSDT","last":"62752",...}]} -- a real, parseable
 *  price. Never throws; undefined on any failure (network / CORS / non-OK /
 *  malformed), exactly like the LTC fetch. */
const BTC_TICKER_URL = 'https://api.coinex.com/v2/spot/ticker?market=BTCUSDT';
const BTC_PRICE_CACHE_MS = 60_000;
let btcPriceCache: { value: number; at: number } | null = null;

async function fetchBtcPrice(): Promise<number | undefined> {
  const now = Date.now();
  if (btcPriceCache && now - btcPriceCache.at < BTC_PRICE_CACHE_MS) return btcPriceCache.value;
  try {
    const res = await fetch(BTC_TICKER_URL);
    if (!res.ok) return undefined;
    const json: unknown = await res.json();
    if (!json || typeof json !== 'object' || (json as { code?: unknown }).code !== 0) return undefined;
    const data = (json as { data?: unknown }).data;
    const first = Array.isArray(data) ? (data[0] as unknown) : undefined;
    const last = first && typeof first === 'object' ? (first as { last?: unknown }).last : undefined;
    const n = typeof last === 'string' ? parseFloat(last) : typeof last === 'number' ? last : NaN;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    btcPriceCache = { value: n, at: now };
    return n;
  } catch {
    return undefined;
  }
}

/** DOGE/USDT last price, the SAME self-contained CoinEx v2 spot-ticker approach
 *  as fetchLtcPrice() / fetchBtcPrice() above (own market, own cache, own
 *  failure handling) -- api.coinex.com is already in host_permissions, so this
 *  needs no manifest change either. Endpoint verified live 2026-08-15: GET
 *  https://api.coinex.com/v2/spot/ticker?market=DOGEUSDT returned {"code":0,
 *  "data":[{"market":"DOGEUSDT","last":"0.069897",...}]} -- a real, parseable
 *  price. Never throws; undefined on any failure (network / CORS / non-OK /
 *  malformed), exactly like the LTC and BTC fetches. */
const DOGE_TICKER_URL = 'https://api.coinex.com/v2/spot/ticker?market=DOGEUSDT';
const DOGE_PRICE_CACHE_MS = 60_000;
let dogePriceCache: { value: number; at: number } | null = null;

async function fetchDogePrice(): Promise<number | undefined> {
  const now = Date.now();
  if (dogePriceCache && now - dogePriceCache.at < DOGE_PRICE_CACHE_MS) return dogePriceCache.value;
  try {
    const res = await fetch(DOGE_TICKER_URL);
    if (!res.ok) return undefined;
    const json: unknown = await res.json();
    if (!json || typeof json !== 'object' || (json as { code?: unknown }).code !== 0) return undefined;
    const data = (json as { data?: unknown }).data;
    const first = Array.isArray(data) ? (data[0] as unknown) : undefined;
    const last = first && typeof first === 'object' ? (first as { last?: unknown }).last : undefined;
    const n = typeof last === 'string' ? parseFloat(last) : typeof last === 'number' ? last : NaN;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    dogePriceCache = { value: n, at: now };
    return n;
  } catch {
    return undefined;
  }
}

// Auto-refresh lives at module scope (not in state) so it never triggers a
// re-render and survives store selector churn. Guarded so it can't stack.
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let silentRefreshInFlight = false;

// The FULL background tx classification currently running (identified by the
// run OBJECT, not just its address). Both auto-refresh ticks and manual
// refreshes check this so they never start a second concurrent classification
// for the SAME wallet (which would just double the work). A refresh for a
// DIFFERENT address (wallet switch) is allowed to start — the old run's results
// are then discarded by its own address guard. Identity (not address) matters
// for the cleanup: after lock -> unlock of the SAME wallet, a late-finishing old
// run must not clear the marker owned by the newer run, or a third concurrent
// sync could start against the same address.
let txSyncRun: { address: string } | null = null;

// Which address flipped `syncing` to 'initial'. A late-finishing refresh for a
// PREVIOUS wallet must never clear (or leave stuck) the banner of the wallet
// that is now active, so clearing is guarded by this module-level marker.
let initialSyncAddress: string | null = null;

export const useLiveStore = create<LiveState>((set, get) => ({
  // --- initial state --------------------------------------------------------
  phase: 'boot',
  address: '',
  addresses: [],
  assets: [],
  pinnedAssets: [],
  hiddenAssets: [],
  txs: [],
  prices: {},
  unreadActivity: 0,
  activitySeen: emptyActivitySeen(),
  historyIssue: null,
  stakingEvents: [],
  network: null,
  wallets: [],
  activeWalletId: null,
  addingWallet: false,
  requirePasswordToSend: true,
  explorerUrlTemplate: DEFAULT_EXPLORER_URL,
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  settingsMode: 'basic',
  hiddenChains: [],
  notifyDeposits: true,
  electrumServers: [...DEFAULT_ELECTRUM_SERVER_URLS],
  serverStatus: {},
  addressBook: [],
  connectedSites: [],
  pendingMnemonic: null,
  sendPlan: null,
  staking: {
    pools: [],
    addressStatuses: [],
    loading: false,
    submitting: false,
    error: null,
    loaded: false,
  },
  loadingRefresh: false,
  loadingSend: false,
  offline: false,
  error: null,
  syncing: 'idle',
  syncProgress: null,
  lastSyncAt: null,

  // --- vault presence -------------------------------------------------------
  async exists() {
    try {
      return await svc.exists();
    } catch {
      return false;
    }
  },

  // --- init -----------------------------------------------------------------
  async init() {
    set({ phase: 'boot', error: null });
    // Kick a price fetch immediately (non-blocking) — prices are independent of the
    // wallet phase, so they can start loading before any unlock/refresh happens.
    void get().loadPrices();
    // Load the persisted pin/hide lists + live settings up-front so the first
    // refresh already reflects the user's curated set and preferences.
    const [
      storedRequirePw,
      storedExplorer,
      storedAutoLock,
      storedNotify,
      storedServers,
      addressBook,
      storedSettingsMode,
      storedHiddenChains,
    ] = await Promise.all([
      readValue<boolean>(REQUIRE_PW_KEY),
      readValue<string>(EXPLORER_URL_KEY),
      readValue<number>(AUTO_LOCK_MINUTES_KEY),
      readValue<boolean>(NOTIFY_DEPOSITS_KEY),
      readList(ELECTRUM_SERVERS_STORAGE_KEY),
      readAddressBook(),
      readValue<string>(SETTINGS_MODE_KEY),
      readList(HIDDEN_CHAINS_KEY),
    ]);
    set({
      addressBook,
      // Default TRUE — require the password before sending unless explicitly disabled.
      requirePasswordToSend: typeof storedRequirePw === 'boolean' ? storedRequirePw : true,
      // Default BASIC: the expert sections (servers, diagnostics, raw addresses)
      // are the ones where a wrong move costs something, so they are opt-in.
      settingsMode: storedSettingsMode === 'expert' ? 'expert' : 'basic',
      // Normalised through networkFor so a stale or renamed id cannot hide a
      // chain by accident, and the two never-hideable rules are re-applied on
      // read rather than trusted from disk.
      hiddenChains: storedHiddenChains
        .map((id) => networkFor(id as LiveNetworkId).chainId)
        .filter((id) => networkFor(id as LiveNetworkId).ticker !== 'EVR'),
      // Default TRUE — notify on incoming funds unless the user turned it off.
      notifyDeposits: typeof storedNotify === 'boolean' ? storedNotify : true,
      explorerUrlTemplate:
        typeof storedExplorer === 'string' && storedExplorer.trim()
          ? storedExplorer
          : DEFAULT_EXPLORER_URL,
      // Default 5 minutes; 0 means never. Guard against malformed stored values.
      autoLockMinutes:
        typeof storedAutoLock === 'number' && Number.isFinite(storedAutoLock) && storedAutoLock >= 0
          ? storedAutoLock
          : DEFAULT_AUTO_LOCK_MINUTES,
      // User-managed server pool (falls back to the built-in defaults).
      electrumServers:
        storedServers.length > 0 ? storedServers : [...DEFAULT_ELECTRUM_SERVER_URLS],
    });
    // The active chain's server pool + explorer template are loaded and applied
    // by loadWallets() below (it knows the active wallet's chain), BEFORE the
    // first connect/refresh, so the wallet honours the user's servers from the
    // start on whichever chain is active.
    try {
      const exists = await svc.exists();
      await get().loadWallets();
      // Load THIS wallet's own pin/hide lists (per-wallet; migrates any legacy
      // global list into the active wallet exactly once).
      await get().loadWalletAssets();
      if (!exists) {
        set({ phase: 'onboarding' });
      } else if (svc.isUnlocked()) {
        // Wallet was already unlocked in this session (re-open).
        const address = svc.getAddress(0);
        set({ phase: 'ready', address });
        await get().loadAddresses();
        await get().refresh();
      } else {
        // A passwordless active wallet has no password to ask for — auto-unlock
        // it with the empty passphrase and go straight to the ready wallet
        // instead of showing a lock screen.
        const active = get().wallets.find((w) => w.id === get().activeWalletId);
        if (active?.passwordless && (await get().unlock(''))) {
          // unlock() already advanced to `ready` and kicked a refresh.
        } else {
          set({ phase: 'locked' });
        }
      }
    } catch (err) {
      set({ phase: 'onboarding', error: String(err) });
    }
  },

  // --- create ---------------------------------------------------------------
  async createWallet(password: string, name?: string, network: LiveNetworkId = 'mainnet') {
    set({ error: null });
    try {
      const { mnemonic } = await svc.create(password, {
        network,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });
      const address = svc.getAddress(0);
      // Stay in `onboarding` so LiveOnboarding renders the one-time recovery-phrase
      // backup screen (MnemonicView shows while pendingMnemonic is set). Advancing
      // to `ready` happens in clearPendingMnemonic ("I saved it — Continue").
      set({
        phase: 'onboarding',
        address,
        addresses: [{ index: 0, address }],
        pendingMnemonic: mnemonic,
        assets: [],
        txs: [],
        network: null,
        addingWallet: false,
        syncProgress: null,
        lastSyncAt: null,
      });
      void get().loadWallets();
      void get().loadWalletAssets();
      // Fire-and-forget refresh; the mnemonic backup screen is shown first.
      void get()
        .loadAddresses()
        .then(() => get().refresh());
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  clearPendingMnemonic() {
    // The user acknowledged their backup — now enter the ready wallet.
    set({ pendingMnemonic: null, phase: 'ready' });
  },

  // --- import ---------------------------------------------------------------
  async importWallet(
    mnemonic: string,
    password: string,
    name?: string,
    network: LiveNetworkId = 'mainnet',
    passphrase = '',
  ) {
    set({ error: null });
    try {
      await svc.import(mnemonic, password, network, name?.trim() || undefined, passphrase);
      const address = svc.getAddress(0);
      set({
        phase: 'ready',
        address,
        addresses: [{ index: 0, address }],
        assets: [],
        txs: [],
        network: null,
        addingWallet: false,
        syncProgress: null,
        lastSyncAt: null,
      });
      void get().loadWallets();
      void get().loadWalletAssets();
      void get()
        .loadAddresses()
        .then(() => get().refresh());
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err; // re-throw so the UI form can detect failure
    }
  },

  // --- import a single private key (Satori-style single-address wallet) ------
  async importPrivateKeyWallet(input: string, password: string, name?: string, network: LiveNetworkId = 'mainnet') {
    set({ error: null });
    try {
      // A single WIF/hex key becomes a one-address 'pk' wallet (how Satori-network
      // wallets are generated). An empty password makes it passwordless.
      await svc.importPrivateKey(input.trim(), password, network, name?.trim() || undefined);
      const address = svc.getAddress(0);
      set({
        phase: 'ready',
        address,
        addresses: [{ index: 0, address }],
        assets: [],
        txs: [],
        network: null,
        addingWallet: false,
        syncProgress: null,
        lastSyncAt: null,
      });
      void get().loadWallets();
      void get().loadWalletAssets();
      void get()
        .loadAddresses()
        .then(() => get().refresh());
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err; // re-throw so the UI form can detect failure
    }
  },

  // --- address book ---------------------------------------------------------
  addContact(label: string, address: string) {
    const trimmedLabel = label.trim();
    const trimmedAddr = address.trim();
    if (!trimmedLabel) return { ok: false, error: 'Enter a name for this contact.' } as const;
    if (!isValidAddress(trimmedAddr)) {
      // Name the chain from its params, never from a ticker ladder: a hardcoded
      // list silently goes stale on the next chain (and on a rename), leaving the
      // user an error that points at the wrong network.
      return { ok: false, error: `Invalid ${chainDisplayName()} address.` } as const;
    }
    const { addressBook } = get();
    // Replace any existing contact with the same address, then sort by label.
    const next = [
      ...addressBook.filter((c) => c.address !== trimmedAddr),
      { label: trimmedLabel, address: trimmedAddr },
    ].sort((a, b) => a.label.localeCompare(b.label));
    persistValue(ADDRESS_BOOK_KEY, next);
    set({ addressBook: next });
    return { ok: true } as const;
  },

  renameContact(address: string, label: string) {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return { ok: false, error: 'Enter a name for this contact.' } as const;
    const { addressBook } = get();
    if (!addressBook.some((c) => c.address === address)) {
      return { ok: false, error: 'Contact not found.' } as const;
    }
    // Rename in place (address unchanged, already validated when added), re-sort.
    const next = addressBook
      .map((c) => (c.address === address ? { ...c, label: trimmedLabel } : c))
      .sort((a, b) => a.label.localeCompare(b.label));
    persistValue(ADDRESS_BOOK_KEY, next);
    set({ addressBook: next });
    return { ok: true } as const;
  },

  removeContact(address: string) {
    const next = get().addressBook.filter((c) => c.address !== address);
    persistValue(ADDRESS_BOOK_KEY, next);
    set({ addressBook: next });
  },

  // --- connected dApp sites ---------------------------------------------------
  // The background worker owns writes on approval; the UI here only reads and
  // revokes. Because the worker re-reads the key on EVERY dApp request, a
  // removal below takes effect immediately — no worker round-trip needed.
  // Entries are {origin, walletId} (M2 fix). Legacy bare-string entries are
  // migrated on read via the same normalizeApprovals used by the worker, binding
  // them to the current active wallet and pruning approvals for deleted wallets.
  async loadConnectedSites() {
    const raw = await readApprovalsRaw();
    const validIds = new Set(get().wallets.map((w) => w.id));
    const activeId = get().activeWalletId ?? '';
    const { entries, changed } = normalizeApprovals(raw, activeId, validIds);
    // Persist the migrated form so the store converges to the new shape.
    if (changed) persistValue(DAPP_APPROVED_ORIGINS_KEY, entries);
    set({ connectedSites: entries });
  },

  async disconnectSite(origin: string, walletId: string) {
    // Re-read + migrate from storage first so a just-approved entry (added by the
    // worker after our last load) is never clobbered by stale in-memory state. The
    // write is awaited (best-effort — errors swallowed) so the UI only shows
    // "disconnected" once the revocation is actually persisted.
    const raw = await readApprovalsRaw();
    const validIds = new Set(get().wallets.map((w) => w.id));
    const activeId = get().activeWalletId ?? '';
    const { entries } = normalizeApprovals(raw, activeId, validIds);
    const next = entries.filter((e) => !(e.origin === origin && e.walletId === walletId));
    try {
      await getStorage().set(DAPP_APPROVED_ORIGINS_KEY, next);
    } catch {
      // ignore — storage unavailable
    }
    set({ connectedSites: next });
  },

  async disconnectAllSites() {
    try {
      await getStorage().set(DAPP_APPROVED_ORIGINS_KEY, []);
    } catch {
      // ignore — storage unavailable
    }
    set({ connectedSites: [] });
  },

  // --- multi-address ----------------------------------------------------------
  async loadAddresses() {
    try {
      const addresses = await svc.listAddresses();
      if (addresses.length > 0) {
        set({ addresses, address: addresses[0].address });
      }
    } catch {
      // ignore — keep the primary address already in state (e.g. locked mid-call)
    }
  },

  async addReceiveAddress() {
    try {
      await svc.addReceiveAddress();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'address-limit-reached') {
        return { ok: false, error: 'Address limit reached. This wallet already has 20 addresses.' };
      }
      if (msg === 'single-address-wallet') {
        return { ok: false, error: 'This wallet uses a single fixed address.' };
      }
      return { ok: false, error: msg };
    }
    await get().loadAddresses();
    void get().refresh();
    return { ok: true };
  },

  // --- unlock ---------------------------------------------------------------
  async unlock(password: string) {
    set({ error: null });
    try {
      const ok = await svc.unlock(password);
      if (ok) {
        const address = svc.getAddress(0);
        set({
          phase: 'ready',
          address,
          addresses: [{ index: 0, address }],
          assets: [],
          txs: [],
          network: null,
          syncProgress: null,
          lastSyncAt: null,
        });
        void get().loadWallets();
        void get().loadWalletAssets();
        void get()
          .loadAddresses()
          .then(() => get().refresh());
        return true;
      }
      set({ error: 'Incorrect password' });
      return false;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  // --- lock -----------------------------------------------------------------
  lock() {
    get().stopAutoRefresh();
    // Abandon any in-flight background classification: the address guard would
    // discard its results anyway, but clear the marker so the next wallet's sync
    // can start immediately.
    txSyncRun = null;
    svc.lock();
    set({
      phase: 'locked',
      address: '',
      addresses: [],
      assets: [],
      // Clear the previous wallet's curated tokens so nothing leaks on-screen.
      pinnedAssets: [],
      hiddenAssets: [],
      txs: [],
      activitySeen: emptyActivitySeen(),
      unreadActivity: 0,
      historyIssue: null,
      network: null,
      sendPlan: null,
      error: null,
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      staking: emptyStaking(),
    });
  },

  // --- multi-wallet ---------------------------------------------------------
  async loadWallets() {
    try {
      const wallets = await svc.listWallets();
      set({ wallets, activeWalletId: svc.activeWalletId() });
      // The active chain may have just changed (init / switch / unlock / create /
      // import / remove all route through here). Load THIS chain's own server pool
      // + explorer template (per-chain storage keys; Evrmore uses the legacy keys)
      // and apply the pool to the network module so the next connect uses it.
      const chainId = activeChainId();
      const [servers, explorer] = await Promise.all([
        readList(electrumServersStorageKey(chainId)),
        readValue<string>(explorerKeyForChain(chainId)),
      ]);
      const serverUrls = servers.length > 0 ? servers : defaultServerUrlsFor(chainId);
      activateServerUrls(serverUrls, chainId);
      set({
        electrumServers: serverUrls,
        explorerUrlTemplate:
          typeof explorer === 'string' && explorer.trim() ? explorer : defaultExplorerFor(chainId),
      });
    } catch {
      // ignore — listing is best-effort
    }
  },

  // Switch the active wallet. The newly-active wallet starts LOCKED (the service
  // clears the in-memory seed): we drop the previous wallet's on-screen data and
  // move to 'locked' so LiveApp renders LiveLock for the new wallet's password.
  async switchWallet(id: string) {
    if (id === get().activeWalletId) return;
    // 'switching' drives a full-frame loading screen until the target wallet is
    // ready (passwordless auto-unlock) or locked (needs its own password). The
    // finally below guarantees it can never get stuck on errors.
    set({ error: null, syncing: 'switching' });
    try {
      try {
        await svc.switchWallet(id);
      } catch {
        return;
      }
      get().stopAutoRefresh();
      txSyncRun = null;
      set({
        phase: 'locked',
        address: '',
        addresses: [],
        assets: [],
        txs: [],
        // The badge and any history warning belong to the wallet being left.
        activitySeen: emptyActivitySeen(),
        unreadActivity: 0,
        historyIssue: null,
        stakingEvents: [],
        network: null,
        sendPlan: null,
        pendingMnemonic: null,
        addingWallet: false,
        error: null,
        syncProgress: null,
        lastSyncAt: null,
        staking: emptyStaking(),
      });
      await get().loadWallets();
      // Load the newly-active wallet's OWN token lists (isolated per wallet).
      await get().loadWalletAssets();
      // A passwordless wallet needs no password — auto-unlock it (skip the lock
      // screen) so switching to it lands straight on its ready home.
      const active = get().wallets.find((w) => w.id === get().activeWalletId);
      if (active?.passwordless) {
        await get().unlock('');
      }
    } finally {
      // Only clear our own marker — unlock() may already have started an
      // 'initial' first-sync for the freshly switched wallet.
      if (get().syncing === 'switching') set({ syncing: 'idle' });
    }
  },

  // --- chain switching --------------------------------------------------------
  // Switch the ACTIVE CHAIN by switching to a wallet that already lives on it.
  // The lightweight multi-chain model keeps ONE wallet entry per chain, so
  // "switch chain" is "switch wallet, chosen by chain" — all the existing
  // switchWallet plumbing (lock, per-chain server pool + explorer, per-wallet
  // token lists, passwordless auto-unlock, refresh) is reused unchanged.
  async switchChain(chainId: string) {
    // Already on this chain: nothing to do. Canonical compare, so the legacy
    // 'mainnet' alias and 'evrmore-mainnet' are correctly seen as one chain.
    if (sameChain(activeChainId(), chainId)) return;
    // The switcher may be the first thing touched after a cold open; make sure
    // we are choosing from a real list rather than an empty initial state.
    if (get().wallets.length === 0) await get().loadWallets();
    const target = walletOnChain(get().wallets, chainId);
    // No wallet on that chain yet -> no-op. Creating one is enableChain's job
    // (it needs the user's password), never a silent side effect of switching.
    if (!target) return;
    if (target.id === get().activeWalletId) return;
    await get().switchWallet(target.id);
  },

  // Enable a chain the user has no wallet on yet by DERIVING one from the
  // ACTIVE wallet's existing secret, so the recovery phrase is never retyped.
  //
  // SECRET HANDLING (safety-critical, see the per-step comments):
  //   * the plaintext is obtained from the password-gated reveal path only,
  //   * it lives in ONE narrowly scoped local, is never logged, never put in
  //     store state, and never persisted anywhere except the NEW wallet's own
  //     AES-GCM vault (which svc.import/importPrivateKey writes),
  //   * the reference is dropped in `finally` the moment the import returns.
  async enableChain(chainId: string, password: string) {
    if (get().wallets.length === 0) await get().loadWallets();
    const wallets = get().wallets;
    const activeId = get().activeWalletId;
    const active = wallets.find((w) => w.id === activeId) ?? wallets.find((w) => w.active);
    if (!active) return { ok: false, error: 'No wallet to derive from.' };

    const target = networkFor(chainId as LiveNetworkId);
    // Fail CLOSED when the chain is already enabled: deriving again would create
    // a second entry with an identical address (same secret, same chain), which
    // the user never asked for. Switching there is switchChain's job.
    if (walletOnChain(wallets, chainId)) {
      return { ok: false, error: `You already have a wallet on ${target.displayName}.` };
    }

    // A passwordless wallet's vault is keyed by the EMPTY passphrase, and its
    // derived sibling must stay passwordless too — so the vault password is a
    // property of the source wallet, not of whatever the caller passed in.
    const pw = active.passwordless ? '' : password;
    const name = `${baseWalletName(active)} (${target.displayName})`;

    // The ONLY variable that ever holds the plaintext. Typed nullable so it can
    // be released in `finally` (JS strings are immutable, so dropping the last
    // reference and letting GC reclaim it is the strongest available guarantee —
    // there is no buffer to zero, unlike the seed bytes the service wipes).
    let secret: string | null = null;
    let seedPassphrase = '';
    try {
      // Password-gated reveal of the ACTIVE wallet's own secret. Both calls
      // return null (never throw) on a wrong password, so a failed unlock can
      // never fall through into an import. A 'pk' wallet has no recovery phrase,
      // so its single WIF is what gets re-imported — capability of the wallet,
      // not a chain-specific branch. (decodeWif ignores the version byte, so a
      // WIF from one chain re-encodes cleanly under the target chain's params.)
      //
      // A seed wallet reveals its BIP39 passphrase alongside the words, and the
      // re-import below passes it on. Deriving the sibling without it would
      // produce a DIFFERENT wallet at a different address while looking like it
      // worked, which is the worst possible outcome here.
      if (active.kind === 'pk') {
        secret = await svc.revealPrivateKeyWif(pw);
      } else {
        const revealed = await svc.revealSeedSecret(pw);
        secret = revealed ? revealed.mnemonic : null;
        seedPassphrase = revealed ? revealed.passphrase : '';
      }
      if (!secret) return { ok: false, error: 'Incorrect password.' };

      // Reuse the normal import actions so the new chain's wallet goes through
      // exactly the same, already-tested path (encrypt vault, become active +
      // unlocked, reset on-screen data, load the chain's servers/explorer,
      // refresh). They throw on failure, leaving NOTHING created.
      if (active.kind === 'pk') {
        await get().importPrivateKeyWallet(secret, pw, name, chainId as LiveNetworkId);
      } else {
        await get().importWallet(secret, pw, name, chainId as LiveNetworkId, seedPassphrase);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Drop the plaintext as early as possible — before the awaits below, and
      // on every exit path including the error returns above.
      secret = null;
      seedPassphrase = '';
    }

    // Make the newly derived wallet visible to the caller synchronously (the
    // import actions only fire loadWallets off).
    await get().loadWallets();
    set({ error: null });
    return { ok: true };
  },

  // Show the onboarding flow in "add" mode over the still-unlocked active wallet.
  addWalletStart() {
    set({ addingWallet: true, phase: 'onboarding', pendingMnemonic: null, error: null });
  },

  // Abandon the add-wallet flow and return to the (still-unlocked) active wallet.
  cancelAddWallet() {
    set({
      addingWallet: false,
      pendingMnemonic: null,
      error: null,
      phase: svc.isUnlocked() ? 'ready' : 'locked',
    });
  },

  async renameWallet(id: string, name: string) {
    try {
      await svc.renameWallet(id, name);
    } catch {
      // ignore — invalid id / empty name keeps the old name
    }
    await get().loadWallets();
  },

  async removeWallet(id: string) {
    const wasActive = get().activeWalletId === id;

    // Which cached histories this wallet owns, read BEFORE the entry is deleted
    // (afterwards its chain and addresses are unrecoverable). Its primary address
    // is on the summary; the derived ones are only knowable while the wallet is
    // unlocked, which is exactly the case when it is the active one. Read from
    // the service rather than from state so a stale store list cannot make the
    // cleanup silently skip.
    const doomed = (await svc.listWallets().catch(() => [])).find((w) => w.id === id);
    const doomedAddresses = new Set<string>();
    if (doomed?.address) doomedAddresses.add(doomed.address);
    if (wasActive) for (const a of get().addresses) doomedAddresses.add(a.address);

    try {
      await svc.removeWallet(id);
    } catch {
      // ignore — unknown id is a no-op
    }

    const wallets = await svc.listWallets();

    // Reclaim the removed wallet's transaction caches. These are by far the
    // biggest values the extension writes (thousands of classified txs per
    // address) and nothing else ever deleted them, so a removed wallet used to
    // hold part of the shared 10 MB quota forever, with no way to get it back.
    //
    // Both spellings of the chain are swept: a stored WalletEntry.network is the
    // legacy electrum-role id ('mainnet') while the canonical ChainId is what
    // other paths key on. chainIdAliases keeps that param-driven, never a table
    // of chain names. Addresses a SURVIVING wallet still uses are excluded, so a
    // twice-imported secret cannot cost the remaining copy its cache.
    if (doomed && doomedAddresses.size > 0) {
      const kept = new Set(
        wallets.filter((w) => sameChain(w.network, doomed.network)).map((w) => w.address),
      );
      const addresses = Array.from(doomedAddresses).filter((a) => !kept.has(a));
      if (addresses.length > 0) {
        await clearTransactionCaches({ chainIds: chainIdAliases(doomed.network), addresses });
      }
    }

    // Removing the LAST wallet returns to onboarding (nothing left to unlock).
    if (wallets.length === 0) {
      get().stopAutoRefresh();
      txSyncRun = null;
      set({
        phase: 'onboarding',
        wallets: [],
        activeWalletId: null,
        address: '',
        addresses: [],
        assets: [],
        txs: [],
        activitySeen: emptyActivitySeen(),
        unreadActivity: 0,
        historyIssue: null,
        stakingEvents: [],
        network: null,
        sendPlan: null,
        pendingMnemonic: null,
        addingWallet: false,
        error: null,
        syncing: 'idle',
        syncProgress: null,
        lastSyncAt: null,
        staking: emptyStaking(),
      });
      return;
    }

    // Removing the ACTIVE wallet: the service promoted a new active one and
    // cleared the seed, so it is now locked and needs its own password.
    if (wasActive) {
      get().stopAutoRefresh();
      txSyncRun = null;
      set({
        phase: 'locked',
        address: '',
        addresses: [],
        assets: [],
        txs: [],
        activitySeen: emptyActivitySeen(),
        unreadActivity: 0,
        historyIssue: null,
        stakingEvents: [],
        network: null,
        sendPlan: null,
        pendingMnemonic: null,
        error: null,
        syncing: 'idle',
        syncProgress: null,
        lastSyncAt: null,
        staking: emptyStaking(),
      });
    }
    set({ wallets, activeWalletId: svc.activeWalletId() });
  },

  // --- reveal secrets (password-gated; never logged or persisted) -----------
  async revealMnemonic(password: string) {
    try {
      return await svc.revealMnemonic(password);
    } catch {
      return null;
    }
  },

  async revealPrivateKey(password: string) {
    try {
      return await svc.revealPrivateKeyWif(password);
    } catch {
      return null;
    }
  },

  // --- refresh --------------------------------------------------------------
  // Manual refresh flips the `loadingRefresh` skeleton; the auto-refresh poll
  // passes { silent: true } so periodic updates don't flash skeletons.
  async refresh(opts?: { silent?: boolean }) {
    const { address } = get();
    if (!address) return;
    const silent = opts?.silent === true;
    if (!silent) set({ loadingRefresh: true, error: null });

    // Every derived receive address of the active wallet — balances and activity
    // are aggregated across all of them (falls back to the primary alone until
    // loadAddresses has run).
    const addrs =
      get().addresses.length > 0 ? get().addresses.map((a) => a.address) : [address];

    // The cache is keyed per chain, so read it once here rather than at each use:
    // a chain switch mid-refresh must not mix one chain's key with another's.
    const chainId = activeChainId();

    // Fast path: when we have no transactions on screen yet (first load, or right
    // after a wallet switch/unlock), show the persisted caches INSTANTLY so the
    // list appears without waiting for the network round-trip below.
    if (get().txs.length === 0) {
      let cached: LiveTransaction[] = [];
      try {
        const cachedLists = await Promise.all(
          addrs.map((a) => getCachedTransactions(chainId, a)),
        );
        cached = mergeTransactions(cachedLists);
        if (cached.length > 0 && get().address === address) {
          // A just-sent tx the network has not reported yet must survive the
          // cache render, or a send would blink out of Activity on the next tick.
          // The badge counts SERVER activity only: your own send is not news.
          set({
            txs: withLocalPending(address, cached),
            unreadActivity: countUnread(cached, get().activitySeen),
          });
        }
      } catch {
        // ignore — cache read is best-effort
      }
      // An UNSEEN wallet (no cached history at all — fresh import/create/first
      // unlock on this device) is about to run its first full chain sync, which
      // can take a while for wallets with history. Surface a non-blocking
      // 'initial' sync banner until this refresh completes.
      if (!silent && cached.length === 0 && get().phase === 'ready' && get().syncing === 'idle') {
        initialSyncAddress = address;
        set({ syncing: 'initial' });
      }
    }

    // Clears the 'initial' banner, but only the one THIS refresh raised — a
    // late-finishing refresh of a previous wallet must not clear (or race) the
    // banner of the wallet that is active now.
    const clearInitial = () => {
      if (get().syncing === 'initial' && initialSyncAddress === address) {
        initialSyncAddress = null;
        set({ syncing: 'idle' });
      }
    };

    const provider = dynProvider();

    // BALANCE-FIRST: await ONLY the cheap network status + per-address balances
    // (one listunspent each), then commit them immediately so the balance shows
    // within seconds no matter how large the transaction history is. The full
    // history classification runs detached below — it must never gate the
    // balance appearing.
    try {
      const [networkStatus, assets] = await Promise.allSettled([
        provider.getNetworkStatus(),
        // Per-address balances fetched in parallel, then summed per asset name.
        Promise.all(addrs.map((a) => provider.getAllAssetBalances(a))).then(mergeAssetBalances),
      ]);

      // A wallet switch (address change) mid-flight must not clobber the new
      // wallet's state with the previous wallet's stale results.
      if (get().address !== address) {
        clearInitial();
        return;
      }

      const netOk = networkStatus.status === 'fulfilled';
      set({
        loadingRefresh: false,
        // A balances rejection still marks the wallet offline (as before); a
        // tx-sync failure alone never does (handled in the background block).
        offline: !netOk || networkStatus.value.state === 'offline' || assets.status === 'rejected',
        network: netOk ? networkStatus.value : get().network,
        assets: assets.status === 'fulfilled' ? assets.value : get().assets,
      });
    } catch {
      clearInitial();
      if (get().address !== address) return;
      set({ loadingRefresh: false, offline: true });
      return;
    }

    // BACKGROUND tx-history sync (detached). Only one full classification runs
    // per wallet at a time: an overlapping tick (auto-refresh or manual) for the
    // SAME wallet is skipped — the already-running sync will finish and update
    // txs + clear the banner. A different wallet (switch) is allowed to start.
    if (txSyncRun?.address === address) return;
    const run = { address };
    txSyncRun = run;

    // Per-address classification progress, summed for a single overall bar.
    const progressByAddr = new Map<string, { done: number; total: number }>();
    const reportProgress = () => {
      if (get().address !== address) return;
      let done = 0;
      let total = 0;
      for (const p of progressByAddr.values()) {
        done += p.done;
        total += p.total;
      }
      set({ syncProgress: total > 0 ? { done, total } : null });
    };

    // Per-address history outcomes. A REFUSAL (the server answered and declined
    // the address) is remembered so it can be shown; anything unreachable is
    // ordinary offline and only suppresses the "all clear" below.
    const historyOutcome: { refusal: HistoryIssue | null; anyFailure: boolean } = {
      refusal: null,
      anyFailure: false,
    };
    const noteHistoryFailure = (failure: HistoryFetchFailure) => {
      historyOutcome.anyFailure = true;
      historyOutcome.refusal = historyOutcome.refusal ?? describeHistoryIssue(failure);
    };

    void (async () => {
      try {
        // Incremental + checkpointed: only NEW / changed txs are classified; the
        // rest are reused from the per-address caches. The merged view dedupes
        // txs that touch several of our own addresses.
        const lists = await Promise.all(
          addrs.map((a) =>
            refreshTransactionCache(
              chainId,
              a,
              cacheProvider(),
              (done, total) => {
                progressByAddr.set(a, { done, total });
                reportProgress();
              },
              noteHistoryFailure,
            ),
          ),
        );
        // Discard stale results if the active wallet changed while we classified.
        if (get().address !== address) return;
        const nextTxs = mergeTransactions(lists);
        set({
          // Just-sent rows the server has not reported yet stay on top; the badge
          // still counts only what the network told us (see the cache path above).
          txs: withLocalPending(address, nextTxs),
          unreadActivity: countUnread(nextTxs, get().activitySeen),
          lastSyncAt: Date.now(),
          syncProgress: null,
          // Clear the warning ONLY when every address answered. A run where some
          // address was merely unreachable proves nothing about the refusal, so
          // the existing warning stands rather than flickering off and back on.
          ...(historyOutcome.refusal
            ? { historyIssue: historyOutcome.refusal }
            : historyOutcome.anyFailure
              ? {}
              : { historyIssue: null }),
        });
        clearInitial();
      } catch {
        // A tx-sync failure must NOT flip the wallet offline or wipe cached txs:
        // keep whatever is on screen and retry on the next tick. Just clear the
        // transient progress + first-sync banner so the UI doesn't hang on them.
        if (get().address === address) {
          set({ syncProgress: null });
          clearInitial();
        }
      } finally {
        // Only clear the marker if it still points at THIS run (a wallet switch
        // or lock/unlock cycle may have started a newer sync that now owns it).
        if (txSyncRun === run) txSyncRun = null;
      }
    })();
  },

  // --- prices ---------------------------------------------------------------
  // Best-effort USD price feed — never blocks or breaks a wallet flow. Merges so
  // an asset whose fetch failed this round keeps its previous value (a transient
  // blip must not blank a price already on screen). fetchPrices() self-caches for
  // 60s, so calling this on every auto-refresh tick still fetches at most once/min.
  async loadPrices() {
    try {
      // Only fetch the RVN/LTC/BTC/DOGE price when that wallet is active — other
      // users add no extra ticker chatter. Merge so an asset whose fetch failed
      // keeps its previous value. LTC, BTC and DOGE are fetched locally
      // (fetchLtcPrice / fetchBtcPrice / fetchDogePrice, above) rather than
      // through fetchPrices() — see their comments for why.
      const ticker = nativeTickerFor();
      const includeRvn = ticker === 'RVN';
      const includeLtc = ticker === 'LTC';
      const includeBtc = ticker === 'BTC';
      const includeDoge = ticker === 'DOGE';
      const [next, ltc, btc, doge] = await Promise.all([
        fetchPrices({ includeRvn }),
        includeLtc ? fetchLtcPrice() : Promise.resolve<number | undefined>(undefined),
        includeBtc ? fetchBtcPrice() : Promise.resolve<number | undefined>(undefined),
        includeDoge ? fetchDogePrice() : Promise.resolve<number | undefined>(undefined),
      ]);
      const prev = get().prices;
      set({
        prices: {
          EVR: next.EVR ?? prev.EVR,
          SATORIEVR: next.SATORIEVR ?? prev.SATORIEVR,
          RVN: next.RVN ?? prev.RVN,
          LTC: ltc ?? prev.LTC,
          BTC: btc ?? prev.BTC,
          DOGE: doge ?? prev.DOGE,
        },
      });
    } catch {
      // ignore — prices are decorative; never surface as a wallet error
    }
  },

  // --- auto-refresh ---------------------------------------------------------
  startAutoRefresh() {
    if (autoRefreshTimer !== null) return; // already running — don't stack
    if (typeof setInterval === 'undefined') return; // non-DOM env guard
    autoRefreshTimer = setInterval(() => {
      // Piggyback the price refresh on the poll tick (self-throttled to 60s).
      void get().loadPrices();
      if (silentRefreshInFlight) return; // don't overlap slow polls
      silentRefreshInFlight = true;
      void get()
        .refresh({ silent: true })
        .finally(() => {
          silentRefreshInFlight = false;
        });
    }, AUTO_REFRESH_MS);
  },

  stopAutoRefresh() {
    if (autoRefreshTimer !== null) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  },

  // --- add / remove asset (MetaMask-style pin/hide) -------------------------
  async addAsset(name: string) {
    const nativeTicker = nativeTickerFor();
    // Refuse outright on a chain with no asset protocol (e.g. Bitcoin Gold):
    // the UI already hides the "Add token" action, but the store refuses too
    // in case it is ever reached another way (same belt-and-suspenders pattern
    // as joinPool/leavePool refusing off-Evrmore).
    if (!assetsSupported()) {
      return { ok: false, error: `${nativeTicker} has no token support.` };
    }
    const normalized = name.trim().toUpperCase();
    // Reject the active chain's native coin (it is always shown first). Both 'EVR'
    // and 'RVN' are rejected defensively regardless of the active chain.
    if (!normalized || normalized === 'EVR' || normalized === 'RVN' || normalized === nativeTicker) {
      return { ok: false, error: `Enter an asset name other than ${nativeTicker}.` };
    }

    let meta: LiveAssetMeta | null;
    try {
      meta = await dynProvider().getAssetMeta(normalized);
    } catch {
      return { ok: false, error: 'Could not reach the network. Please try again.' };
    }
    if (!meta || !meta.exists) {
      return { ok: false, error: `Asset "${normalized}" was not found on the network.` };
    }

    const id = svc.activeWalletId();
    const { pinnedAssets, hiddenAssets } = get();
    const nextPinned = pinnedAssets.includes(normalized) ? pinnedAssets : [...pinnedAssets, normalized];
    const nextHidden = hiddenAssets.filter((n) => n !== normalized);
    // Persist to the ACTIVE wallet's OWN lists (per-wallet, not global).
    if (id) {
      persistList(pinnedKey(id), nextPinned);
      persistList(hiddenKey(id), nextHidden);
    }
    set({ pinnedAssets: nextPinned, hiddenAssets: nextHidden });
    await get().refresh();
    return { ok: true };
  },

  removeAsset(name: string) {
    const normalized = name.trim().toUpperCase();
    // The active chain's protected assets are never removable (Evrmore: EVR +
    // SATORIEVR; Ravencoin: RVN). The UI hides their remove controls; this refuses
    // the call regardless.
    if (!normalized || !isRemovableAsset(normalized, activeChainId())) return;
    const id = svc.activeWalletId();
    const { pinnedAssets, hiddenAssets } = get();
    const nextHidden = hiddenAssets.includes(normalized) ? hiddenAssets : [...hiddenAssets, normalized];
    const nextPinned = pinnedAssets.filter((n) => n !== normalized);
    if (id) {
      persistList(hiddenKey(id), nextHidden);
      persistList(pinnedKey(id), nextPinned);
    }
    set({ hiddenAssets: nextHidden, pinnedAssets: nextPinned });
  },

  // Load the ACTIVE wallet's own pin/hide lists. Migrates the legacy GLOBAL lists
  // (shared across wallets — the bug) into the active wallet exactly once, then
  // deletes the global keys so they can never leak into another wallet again.
  async loadWalletAssets() {
    const id = svc.activeWalletId();
    if (!id) {
      set({
        pinnedAssets: [],
        hiddenAssets: [],
        activitySeen: emptyActivitySeen(),
        unreadActivity: 0,
        stakingEvents: [],
      });
      return;
    }
    // Load THIS wallet's seen-activity record (for the Activity badge) + its
    // locally recorded staking events (merged into the feed, newest first).
    const [activitySeen, stakingEvents] = await Promise.all([
      readActivitySeen(id),
      readStakingEvents(id),
    ]);
    set({ activitySeen, unreadActivity: countUnread(get().txs, activitySeen), stakingEvents });
    let pinned = await readList(pinnedKey(id));
    let hidden = await readList(hiddenKey(id));
    const legacyPinned = await readList(PINNED_ASSETS_KEY);
    const legacyHidden = await readList(HIDDEN_ASSETS_KEY);
    if (legacyPinned.length || legacyHidden.length) {
      if (!pinned.length && !hidden.length) {
        pinned = legacyPinned;
        hidden = legacyHidden;
        persistList(pinnedKey(id), pinned);
        persistList(hiddenKey(id), hidden);
      }
      try {
        await getStorage().remove(PINNED_ASSETS_KEY);
        await getStorage().remove(HIDDEN_ASSETS_KEY);
      } catch {
        // ignore — best-effort cleanup
      }
    }
    // On Evrmore, SATORIEVR is pinned out of the box (nobody should have to "Add
    // token" for the one asset the wallet exists for). On Ravencoin there are no
    // default pins. Applied only when the user has expressed NO opinion about it:
    // removeAsset() moves a name into `hidden`, so a deleted asset is never
    // resurrected. Keyed to the ACTIVE chain.
    const chainId = activeChainId();
    const withDefaults = applyDefaultPins(pinned, chainId);
    if (withDefaults !== pinned) {
      pinned = withDefaults;
      persistList(pinnedKey(id), pinned);
    }
    // Undo any removal of a now-protected asset made by an older build.
    const visible = unhideProtected(hidden, chainId);
    if (visible !== hidden) {
      hidden = visible;
      persistList(hiddenKey(id), hidden);
    }
    set({ pinnedAssets: pinned, hiddenAssets: hidden });
  },

  markActivitySeen() {
    const id = svc.activeWalletId();
    // The water mark is what makes this STICK on a wallet with more txs than the
    // txid cap: the old version persisted 400 ids while the badge recounted the
    // whole (unbounded) list, so on a big wallet it re-armed 20 seconds later,
    // every time, forever. See ActivitySeen / markSeen.
    const next = markSeen(get().txs, get().activitySeen);
    if (id) persistValue(seenTxKey(id), next);
    set({ activitySeen: next, unreadActivity: countUnread(get().txs, next) });
  },

  // --- Satori pool staking (SATORIEVR only) ---------------------------------
  // Server truth: pools + per-address lender status are re-fetched here (called
  // when the staking screen opens). Errors set staking.error and never throw to
  // the UI. Requires the wallet unlocked (keysHoldingAsset derives per-address
  // keys); it is, in the ready phase where the screen lives.
  async refreshStaking() {
    // Staking is Evrmore-only (SATORIEVR). Inert on Ravencoin: report an empty,
    // loaded state without touching the Satori pool server.
    if (!stakingSupported()) {
      set({ staking: { ...emptyStaking(), loaded: true } });
      return;
    }
    set((s) => ({ staking: { ...s.staking, loading: true, error: null } }));
    try {
      // Fetch pools and figure out which of our addresses hold SATORIEVR (only
      // those can meaningfully stake) in parallel.
      const [pools, heldKeys] = await Promise.all([
        fetchOpenPools(),
        svc.keysHoldingAsset(STAKING_ASSET),
      ]);
      // Per-address lender status (sequential is fine — a handful of addresses).
      const addressStatuses: AddressLenderStatus[] = [];
      for (const key of heldKeys) {
        try {
          const st: LenderStatus = await getLenderStatus(key.address);
          addressStatuses.push({ address: key.address, poolAddress: st.poolAddress, isPool: st.isPool });
        } catch {
          // An address whose status couldn't be read is reported as unknown
          // (null pool) rather than blocking the whole screen.
          addressStatuses.push({ address: key.address, poolAddress: null });
        }
      }
      set((s) => ({
        staking: { ...s.staking, pools, addressStatuses, loading: false, loaded: true, error: null },
      }));
    } catch (err) {
      set((s) => ({
        staking: {
          ...s.staking,
          loading: false,
          loaded: true,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  },

  // Append a staking event to the active wallet's persisted list (newest first,
  // capped at STAKING_EVENTS_CAP) and to in-memory state. Best-effort persist;
  // never throws (a storage failure must not break a completed join/leave).
  recordStakingEvent(event: StakingEvent) {
    const id = svc.activeWalletId();
    const next = [event, ...get().stakingEvents].slice(0, STAKING_EVENTS_CAP);
    if (id) persistValue(stakingEventsKey(id), next);
    set({ stakingEvents: next });
  },

  async joinPool(poolAddress: string) {
    // Evrmore-only: the store refuses on Ravencoin even if the UI (phase 3) is hidden.
    if (!stakingSupported()) {
      const error = 'Staking is only available on Evrmore.';
      set((s) => ({ staking: { ...s.staking, error } }));
      return { ok: false, error };
    }
    set((s) => ({ staking: { ...s.staking, submitting: true, error: null } }));
    try {
      const keys = await svc.keysHoldingAsset(STAKING_ASSET);
      if (keys.length === 0) {
        const error = 'This wallet holds no SATORIEVR to stake.';
        set((s) => ({ staking: { ...s.staking, submitting: false, error } }));
        return { ok: false, error };
      }
      // Resolve the pool alias for the event label BEFORE refreshStaking (which
      // could change the open-pool list). Uses the alias currently on screen.
      const poolAlias = get().staking.pools.find((p) => p.address === poolAddress)?.alias ?? null;
      const results = await joinPoolForKeys(
        poolAddress,
        keys.map((k) => ({
          privateKey: k.privateKey,
          publicKey: k.publicKey,
          compressed: k.publicKey.length === 33,
          address: k.address,
        })),
      );
      const failed = results.filter((r) => !r.ok);
      const joined = results.length - failed.length;
      set((s) => ({ staking: { ...s.staking, submitting: false } }));
      // Record the join for Activity when at least one address succeeded.
      if (joined > 0) {
        get().recordStakingEvent({
          type: 'pool-join',
          poolAddress,
          poolAlias,
          addressCount: joined,
          timestamp: Date.now(),
        });
      }
      await get().refreshStaking();
      if (failed.length === results.length) {
        const error = failed[0]?.error || 'Joining the pool failed.';
        set((s) => ({ staking: { ...s.staking, error } }));
        return { ok: false, error };
      }
      if (failed.length > 0) {
        const error = `${failed.length} of ${results.length} address(es) could not join.`;
        set((s) => ({ staking: { ...s.staking, error } }));
        return { ok: false, error };
      }
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      set((s) => ({ staking: { ...s.staking, submitting: false, error } }));
      return { ok: false, error };
    }
  },

  async leavePool() {
    // Evrmore-only: the store refuses on Ravencoin even if the UI (phase 3) is hidden.
    if (!stakingSupported()) {
      const error = 'Staking is only available on Evrmore.';
      set((s) => ({ staking: { ...s.staking, error } }));
      return { ok: false, error };
    }
    set((s) => ({ staking: { ...s.staking, submitting: true, error: null } }));
    try {
      const keys = await svc.keysHoldingAsset(STAKING_ASSET);
      if (keys.length === 0) {
        // Nothing held anywhere -> nothing to leave; treat as a no-op success.
        set((s) => ({ staking: { ...s.staking, submitting: false } }));
        await get().refreshStaking();
        return { ok: true };
      }
      // The pool being left (for the Activity label): the address our held
      // addresses are currently registered with, resolved to its alias if known.
      const leftPoolAddress =
        get().staking.addressStatuses.find((a) => a.poolAddress)?.poolAddress ?? null;
      const leftPoolAlias = leftPoolAddress
        ? get().staking.pools.find((p) => p.address === leftPoolAddress)?.alias ?? null
        : null;
      const results = await leavePoolForKeys(
        keys.map((k) => ({
          privateKey: k.privateKey,
          publicKey: k.publicKey,
          compressed: k.publicKey.length === 33,
          address: k.address,
        })),
      );
      const failed = results.filter((r) => !r.ok);
      const left = results.length - failed.length;
      set((s) => ({ staking: { ...s.staking, submitting: false } }));
      // Record the leave for Activity when at least one address succeeded and we
      // actually knew which pool we were registered with (a no-op leave of an
      // unregistered wallet records nothing).
      if (left > 0 && leftPoolAddress) {
        get().recordStakingEvent({
          type: 'pool-leave',
          poolAddress: leftPoolAddress,
          poolAlias: leftPoolAlias,
          addressCount: left,
          timestamp: Date.now(),
        });
      }
      await get().refreshStaking();
      if (failed.length === results.length) {
        const error = failed[0]?.error || 'Leaving the pool failed.';
        set((s) => ({ staking: { ...s.staking, error } }));
        return { ok: false, error };
      }
      if (failed.length > 0) {
        const error = `${failed.length} of ${results.length} address(es) could not leave.`;
        set((s) => ({ staking: { ...s.staking, error } }));
        return { ok: false, error };
      }
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      set((s) => ({ staking: { ...s.staking, submitting: false, error } }));
      return { ok: false, error };
    }
  },

  // --- build send -----------------------------------------------------------
  async buildSend(to: string, amountDecimal: number, assetId: string, feeRateSatPerByte?: bigint) {
    set({ loadingSend: true, error: null, sendPlan: null });
    try {
      const amountSats = BigInt(Math.round(amountDecimal * 1e8));
      // The chosen rate rides through as SendFeeOptions; the service re-clamps
      // it into the chain's policy band, so no store value can escape bounds.
      const feeOpts = feeRateSatPerByte !== undefined ? { feeRateSatPerByte } : undefined;
      let plan: LiveSendPlan;
      // Chain-aware native check ('EVR' on Evrmore, 'RVN' on Ravencoin). A literal
      // 'EVR' here sent native RVN down the asset path (unknown-asset at review).
      if (isNativeAssetId(assetId)) {
        plan = await svc.buildEvrSend(to, amountSats, feeOpts);
      } else {
        plan = await svc.buildAssetSend(to, assetId, amountSats, feeOpts);
      }
      set({ loadingSend: false, sendPlan: plan });
      return plan;
    } catch (err) {
      set({ loadingSend: false, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  // Max sendable EVR (all UTXOs minus the fee to spend them) + that fee, both as
  // decimals — the "Max" button uses this so the tx actually fits. The optional
  // chosen rate keeps Max consistent with the fee the user picked: a Max amount
  // computed at one rate but built at another either fails coin selection (rate
  // went up) or silently leaves coins behind (rate went down).
  async estimateMaxEvr(feeRateSatPerByte?: bigint) {
    try {
      const { maxSats, feeSats } = await svc.estimateMaxEvr(
        feeRateSatPerByte !== undefined ? { feeRateSatPerByte } : undefined,
      );
      return { maxDecimal: Number(maxSats) / 1e8, feeDecimal: Number(feeSats) / 1e8 };
    } catch {
      return { maxDecimal: 0, feeDecimal: 0 };
    }
  },

  // Fee options for the active chain. The service itself never throws (each
  // failed target degrades to the chain default), so the catch here is pure
  // belt-and-braces: even an unexpected failure (e.g. a locked-wallet edge)
  // still yields the chain's static policy defaults, exactly the shape the
  // service's own fully-degraded probe returns. The send screen therefore
  // ALWAYS gets floor/ceiling/default to validate a custom rate against, and
  // is never blocked by an offline or useless server.
  async estimateFeeOptions() {
    try {
      return await svc.estimateFeeOptions();
    } catch {
      const net = networkFor(activeChainId());
      return buildFeeEstimate(net.chainId, feePolicyFor(net), [null, null, null]);
    }
  },

  clearSendPlan() {
    set({ sendPlan: null, error: null });
    svc.allowBroadcast = false;
  },

  // --- arm broadcast --------------------------------------------------------
  arm(on: boolean) {
    svc.allowBroadcast = on;
  },

  // --- broadcast ------------------------------------------------------------
  async broadcast(rawHex: string) {
    try {
      // Prefer the builder's own txid (already computed over the stripped
      // serialization) when the plan being broadcast is the one in state; the
      // service derives it defensively otherwise.
      const planned = get().sendPlan;
      const knownTxid = planned && planned.built.rawHex === rawHex ? planned.built.txid : undefined;
      const txid = await svc.broadcast(rawHex, knownTxid);

      // SHOW IT NOW. The refreshes below cannot: the tx-sync guard skips a
      // refresh whose wallet is already classifying, so on a wallet with real
      // history all three were no-ops and the user saw nothing at all until a
      // multi-minute sync finished. The plan holds everything the pending row
      // needs, so it is built locally and displayed with no network call, then
      // retired by whichever sync first reports the real transaction.
      const address = get().address;
      if (planned && planned.built.rawHex === rawHex && address) {
        const pending = localPendingFromPlan(planned, activeChainId());
        localPendingTxs = [
          { address, tx: pending, at: Date.now() },
          ...localPendingTxs.filter((p) => p.tx.txid !== pending.txid),
        ];
        set({
          txs: [pending, ...get().txs.filter((t) => t.txid !== pending.txid)].sort(compareLiveTx),
        });
      }

      // Refresh now, then a couple of delayed passes: the just-broadcast tx takes
      // a moment to appear in the Electrum mempool/history, so a single immediate
      // refresh (esp. for asset sends) often misses it. These silent passes pick
      // up the new pending tx without flashing the loading skeleton.
      void get().refresh({ silent: true });
      if (typeof setTimeout !== 'undefined') {
        setTimeout(() => void get().refresh({ silent: true }), 3000);
        setTimeout(() => void get().refresh({ silent: true }), 8000);
      }
      return txid;
    } catch (err) {
      if (err instanceof BroadcastGatedError) {
        throw err;
      }
      throw err;
    }
  },

  // --- password (verify / change) -------------------------------------------
  async verifyPassword(password: string) {
    try {
      return await svc.verifyPassword(password);
    } catch {
      return false;
    }
  },

  async changePassword(oldPassword: string, newPassword: string) {
    try {
      return await svc.changePassword(oldPassword, newPassword);
    } catch {
      return false;
    }
  },

  // --- persisted live settings ----------------------------------------------
  setRequirePasswordToSend(on: boolean) {
    persistValue(REQUIRE_PW_KEY, on);
    set({ requirePasswordToSend: on });
  },

  setExplorerUrlTemplate(url: string) {
    // Persist under the ACTIVE chain's key (Evrmore uses the legacy bare key).
    persistValue(explorerKeyForChain(activeChainId()), url);
    set({ explorerUrlTemplate: url });
  },

  setChainHidden(chainId: string, hidden: boolean) {
    const canonical = networkFor(chainId as LiveNetworkId).chainId;
    // Re-check the rule here, not only in the UI: a stale render or a future
    // caller must not be able to hide the home chain or the one in use.
    if (hidden && chainHideBlockedReason(canonical, activeChainId()) !== null) return;
    const current = get().hiddenChains;
    const next = hidden
      ? current.includes(canonical)
        ? current
        : [...current, canonical]
      : current.filter((id) => id !== canonical);
    if (next === current) return;
    persistValue(HIDDEN_CHAINS_KEY, next);
    set({ hiddenChains: next });
  },

  setSettingsMode(mode: SettingsMode) {
    persistValue(SETTINGS_MODE_KEY, mode);
    set({ settingsMode: mode });
  },

  setAutoLockMinutes(minutes: number) {
    // Normalize to a non-negative integer; anything invalid falls back to 0 (never).
    const normalized = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0;
    persistValue(AUTO_LOCK_MINUTES_KEY, normalized);
    set({ autoLockMinutes: normalized });
  },

  setNotifyDeposits(on: boolean) {
    // Persisted under the SAME key the background worker reads to gate the poll.
    persistValue(NOTIFY_DEPOSITS_KEY, on);
    set({ notifyDeposits: on });
  },

  // --- Electrum server pool (user-managed) ----------------------------------
  // Each mutation persists the list, re-points the live network pool (applied
  // synchronously to avoid a storage race), drops the current connection so the
  // next request reconnects using the new pool, and kicks a silent refresh. The
  // new server is only actually reached on that reconnect — if it can't connect
  // the client just fails over to the next entry, so these never throw.
  addElectrumServer(url: string) {
    const parsed = parseServerUrl(url);
    if (!parsed) {
      return {
        ok: false,
        error: 'Enter a valid wss:// server, e.g. wss://electrumx1.satorinet.io:50004',
      } as const;
    }
    const normalized = serverToUrl(parsed);
    const current = get().electrumServers;
    if (current.includes(normalized)) {
      return { ok: false, error: 'That server is already in the list.' } as const;
    }
    // Operate on the ACTIVE chain's pool (its own per-chain storage key).
    const chainId = activeChainId();
    const next = [...current, normalized];
    persistList(electrumServersStorageKey(chainId), next);
    activateServerUrls(next, chainId);
    svc.reconnect();
    set({ electrumServers: next });
    void get().refresh({ silent: true });
    return { ok: true } as const;
  },

  removeElectrumServer(url: string) {
    const current = get().electrumServers;
    // Never remove the LAST server — keep at least one so a pool always exists.
    if (current.length <= 1) return;
    const chainId = activeChainId();
    const filtered = current.filter((u) => u !== url);
    const next = filtered.length > 0 ? filtered : defaultServerUrlsFor(chainId);
    persistList(electrumServersStorageKey(chainId), next);
    activateServerUrls(next, chainId);
    svc.reconnect();
    set({ electrumServers: next });
    void get().refresh({ silent: true });
  },

  resetElectrumServers() {
    const chainId = activeChainId();
    const next = defaultServerUrlsFor(chainId);
    persistList(electrumServersStorageKey(chainId), next);
    activateServerUrls(next, chainId);
    svc.reconnect();
    set({ electrumServers: next });
    void get().refresh({ silent: true });
  },

  async checkServers() {
    const urls = get().electrumServers;
    // Mark all as 'checking' up-front so the dots show progress.
    set({ serverStatus: Object.fromEntries(urls.map((u) => [u, { status: 'checking' }])) });
    await Promise.all(
      urls.map(async (u) => {
        const r = await checkElectrumServer(u);
        set({
          serverStatus: {
            ...get().serverStatus,
            [u]: { status: r.online ? 'online' : 'offline', height: r.height, latencyMs: r.latencyMs },
          },
        });
      }),
    );
  },

  // --- reset ----------------------------------------------------------------
  async resetLiveWallet() {
    get().stopAutoRefresh();
    txSyncRun = null;
    localPendingTxs = [];
    try {
      await svc.reset();
    } catch {
      // ignore storage errors
    }
    // svc.reset() drops the vaults but knows nothing about the tx caches, so
    // without this a "reset wallet" left every cached history behind, occupying
    // the shared quota with data no wallet can ever reach again.
    await clearTransactionCaches();
    set({
      historyIssue: null,
      activitySeen: emptyActivitySeen(),
      unreadActivity: 0,
      phase: 'onboarding',
      address: '',
      addresses: [],
      assets: [],
      txs: [],
      stakingEvents: [],
      network: null,
      wallets: [],
      activeWalletId: null,
      addingWallet: false,
      sendPlan: null,
      pendingMnemonic: null,
      error: null,
      offline: false,
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      staking: emptyStaking(),
    });
  },
}));
