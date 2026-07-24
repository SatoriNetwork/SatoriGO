// Live-network zustand store — wraps LiveWalletService and exposes clean state
// for the Live UI surface. All network errors are caught; they set `offline`
// rather than crashing. The service instance is module-level (singleton).

import { create } from 'zustand';
import {
  LiveWalletService,
  BroadcastGatedError,
  type LiveNetworkId,
  type LiveSendPlan,
  type WalletSummary,
} from '../services/chain/liveWallet';
import { getStorage } from '../services/storage';
import { fetchPrices } from '../services/prices';
import { isValidAddress } from '../services/chain/keys';
import { networkFor } from '../services/chain/chainParams';
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
  getCachedTransactions,
  refreshTransactionCache,
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

/** Native coin ticker ('EVR' / 'RVN') of a chain (default = active chain).
 *  Exported for chain-aware UI labels (fee notes, error text, unit suffixes). */
export function nativeTickerFor(chainId: string = activeChainId()): 'EVR' | 'RVN' {
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

/** Whether Satori pool staking applies on this chain. SATORIEVR is an Evrmore
 *  asset, so staking is Evrmore-only; it is inert on Ravencoin. Exported so the
 *  UI can hide/guard the Stake action without re-deriving the chain check. */
export function stakingSupported(chainId: string = activeChainId()): boolean {
  return nativeTickerFor(chainId) === 'EVR';
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

/** Per-wallet set of txids the user has already SEEN in Activity. Anything not in
 *  here counts as "new" for the Activity badge. Capped when persisted. */
const seenTxKey = (walletId: string) => `activitySeen:${walletId}`;
const SEEN_TX_CAP = 400;

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

/** Count txs not yet marked seen. */
function countUnread(txs: LiveTransaction[], seen: string[]): number {
  const set = new Set(seen);
  return txs.reduce((n, t) => (set.has(t.txid) ? n : n + 1), 0);
}

/** Persisted live-wallet settings. */
const REQUIRE_PW_KEY = 'requirePasswordToSend';
const EXPLORER_URL_KEY = 'explorerUrlTemplate';
const AUTO_LOCK_MINUTES_KEY = 'autoLockMinutes';
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

/** Block-explorer template default for a chain (default = active chain). */
function defaultExplorerFor(chainId: string = activeChainId()): string {
  return nativeTickerFor(chainId) === 'RVN' ? DEFAULT_EXPLORER_URL_RVN : DEFAULT_EXPLORER_URL;
}

/** Per-chain storage key for the user-editable explorer template. Evrmore keeps
 *  the legacy bare key ('explorerUrlTemplate'); Ravencoin is suffixed. */
function explorerKeyForChain(chainId: string = activeChainId()): string {
  return nativeTickerFor(chainId) === 'RVN'
    ? `${EXPLORER_URL_KEY}:ravencoin-mainnet`
    : EXPLORER_URL_KEY;
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
 * Default chain = Evrmore, so the exported constant/helpers keep their historical
 * behavior for every existing caller.
 */
export function protectedAssetsFor(chainId: string = activeChainId()): readonly string[] {
  return nativeTickerFor(chainId) === 'RVN' ? ['RVN'] : ['EVR', 'SATORIEVR'];
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
 *  first, by construction. Evrmore pins SATORIEVR; Ravencoin pins nothing. */
export function defaultPinsFor(chainId: string = activeChainId()): readonly string[] {
  return nativeTickerFor(chainId) === 'RVN' ? [] : ['SATORIEVR'];
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
 * Merge per-address transaction lists into one deduped, sorted list. A tx that
 * moves funds between our OWN addresses appears in several per-address caches
 * ('out' at the sender, 'in' at the receiver) — keep exactly one entry,
 * preferring the 'out' classification. Pure + exported for tests.
 */
export function mergeTransactions(lists: LiveTransaction[][]): LiveTransaction[] {
  const byTxid = new Map<string, LiveTransaction>();
  for (const list of lists) {
    for (const tx of list) {
      const prev = byTxid.get(tx.txid);
      if (!prev || (prev.direction === 'in' && tx.direction === 'out')) {
        byTxid.set(tx.txid, tx);
      }
    }
  }
  return Array.from(byTxid.values()).sort(compareLiveTx);
}

/** USD value of `amount` at `price` (both in the same asset unit), or null when
 *  no price is known for the asset. Pure + exported so the UI and tests share it. */
export function usdValue(amount: number, price?: number): number | null {
  return price != null ? amount * price : null;
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
   *  EVR + SATORIEVR (Evrmore) and RVN (Ravencoin) are the only priced assets. */
  prices: { EVR?: number; SATORIEVR?: number; RVN?: number };
  /** Number of transactions not yet viewed in Activity (drives the tab badge). */
  unreadActivity: number;
  /** Txids the active wallet has already seen (persisted per wallet). */
  seenTxids: string[];
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
  importWallet(mnemonic: string, password: string, name?: string, network?: LiveNetworkId): Promise<void>;
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

  buildSend(to: string, amountDecimal: number, assetId: string): Promise<LiveSendPlan | null>;
  estimateMaxEvr(): Promise<{ maxDecimal: number; feeDecimal: number }>;
  clearSendPlan(): void;
  arm(on: boolean): void;
  broadcast(rawHex: string): Promise<string>;
  verifyPassword(password: string): Promise<boolean>;
  changePassword(oldPassword: string, newPassword: string): Promise<boolean>;
  setRequirePasswordToSend(on: boolean): void;
  setExplorerUrlTemplate(url: string): void;
  setAutoLockMinutes(minutes: number): void;
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
  seenTxids: [],
  stakingEvents: [],
  network: null,
  wallets: [],
  activeWalletId: null,
  addingWallet: false,
  requirePasswordToSend: true,
  explorerUrlTemplate: DEFAULT_EXPLORER_URL,
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
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
    const [storedRequirePw, storedExplorer, storedAutoLock, storedNotify, storedServers, addressBook] =
      await Promise.all([
        readValue<boolean>(REQUIRE_PW_KEY),
        readValue<string>(EXPLORER_URL_KEY),
        readValue<number>(AUTO_LOCK_MINUTES_KEY),
        readValue<boolean>(NOTIFY_DEPOSITS_KEY),
        readList(ELECTRUM_SERVERS_STORAGE_KEY),
        readAddressBook(),
      ]);
    set({
      addressBook,
      // Default TRUE — require the password before sending unless explicitly disabled.
      requirePasswordToSend: typeof storedRequirePw === 'boolean' ? storedRequirePw : true,
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
  async importWallet(mnemonic: string, password: string, name?: string, network: LiveNetworkId = 'mainnet') {
    set({ error: null });
    try {
      await svc.import(mnemonic, password, network, name?.trim() || undefined);
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
      return {
        ok: false,
        error: nativeTickerFor() === 'RVN' ? 'Invalid Ravencoin address.' : 'Invalid EVRmore address.',
      } as const;
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
      seenTxids: [],
      unreadActivity: 0,
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
    try {
      await svc.removeWallet(id);
    } catch {
      // ignore — unknown id is a no-op
    }
    const wallets = await svc.listWallets();

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

    // Fast path: when we have no transactions on screen yet (first load, or right
    // after a wallet switch/unlock), show the persisted caches INSTANTLY so the
    // list appears without waiting for the network round-trip below.
    if (get().txs.length === 0) {
      let cached: LiveTransaction[] = [];
      try {
        const cachedLists = await Promise.all(addrs.map((a) => getCachedTransactions(a)));
        cached = mergeTransactions(cachedLists);
        if (cached.length > 0 && get().address === address) {
          set({ txs: cached, unreadActivity: countUnread(cached, get().seenTxids) });
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

    void (async () => {
      try {
        // Incremental + checkpointed: only NEW / changed txs are classified; the
        // rest are reused from the per-address caches. The merged view dedupes
        // txs that touch several of our own addresses.
        const lists = await Promise.all(
          addrs.map((a) =>
            refreshTransactionCache(a, cacheProvider(), (done, total) => {
              progressByAddr.set(a, { done, total });
              reportProgress();
            }),
          ),
        );
        // Discard stale results if the active wallet changed while we classified.
        if (get().address !== address) return;
        const nextTxs = mergeTransactions(lists);
        set({
          txs: nextTxs,
          unreadActivity: countUnread(nextTxs, get().seenTxids),
          lastSyncAt: Date.now(),
          syncProgress: null,
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
      // Only fetch the RVN price when an RVN wallet is active — EVR-only users add
      // no extra ticker chatter. Merge so an asset whose fetch failed keeps its
      // previous value.
      const includeRvn = nativeTickerFor() === 'RVN';
      const next = await fetchPrices({ includeRvn });
      const prev = get().prices;
      set({
        prices: {
          EVR: next.EVR ?? prev.EVR,
          SATORIEVR: next.SATORIEVR ?? prev.SATORIEVR,
          RVN: next.RVN ?? prev.RVN,
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
    const normalized = name.trim().toUpperCase();
    // Reject the active chain's native coin (it is always shown first). Both 'EVR'
    // and 'RVN' are rejected defensively regardless of the active chain.
    const nativeTicker = nativeTickerFor();
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
      set({ pinnedAssets: [], hiddenAssets: [], seenTxids: [], unreadActivity: 0, stakingEvents: [] });
      return;
    }
    // Load THIS wallet's seen-activity set (for the Activity badge) + its locally
    // recorded staking events (merged into the Activity feed, newest first).
    const [seenTxids, stakingEvents] = await Promise.all([
      readList(seenTxKey(id)),
      readStakingEvents(id),
    ]);
    set({ seenTxids, unreadActivity: countUnread(get().txs, seenTxids), stakingEvents });
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
    const current = get().txs.map((t) => t.txid);
    const merged = Array.from(new Set([...current, ...get().seenTxids])).slice(0, SEEN_TX_CAP);
    if (id) persistList(seenTxKey(id), merged);
    set({ seenTxids: merged, unreadActivity: 0 });
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
  async buildSend(to: string, amountDecimal: number, assetId: string) {
    set({ loadingSend: true, error: null, sendPlan: null });
    try {
      const amountSats = BigInt(Math.round(amountDecimal * 1e8));
      let plan: LiveSendPlan;
      // Chain-aware native check ('EVR' on Evrmore, 'RVN' on Ravencoin). A literal
      // 'EVR' here sent native RVN down the asset path (unknown-asset at review).
      if (isNativeAssetId(assetId)) {
        plan = await svc.buildEvrSend(to, amountSats);
      } else {
        plan = await svc.buildAssetSend(to, assetId, amountSats);
      }
      set({ loadingSend: false, sendPlan: plan });
      return plan;
    } catch (err) {
      set({ loadingSend: false, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  // Max sendable EVR (all UTXOs minus the fee to spend them) + that fee, both as
  // decimals — the "Max" button uses this so the tx actually fits.
  async estimateMaxEvr() {
    try {
      const { maxSats, feeSats } = await svc.estimateMaxEvr();
      return { maxDecimal: Number(maxSats) / 1e8, feeDecimal: Number(feeSats) / 1e8 };
    } catch {
      return { maxDecimal: 0, feeDecimal: 0 };
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
      const txid = await svc.broadcast(rawHex);
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
    try {
      await svc.reset();
    } catch {
      // ignore storage errors
    }
    set({
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
