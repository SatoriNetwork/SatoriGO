// Live-network zustand store — wraps LiveWalletService and exposes clean state
// for the Live UI surface. All network errors are caught; they set `offline`
// rather than crashing. The service instance is module-level (singleton).

import { create } from 'zustand';
import { parseAmount, formatAmount, amountToNumber } from '../services/chain/amounts';
import {
  LiveWalletService,
  BroadcastGatedError,
  MAX_RECEIVE_ADDRESSES,
  type BackupPreview,
  type FeeEstimate,
  type LiveNetworkId,
  type LiveSendPlan,
  type WalletSummary,
} from '../services/chain/liveWallet';
import { buildFeeEstimate } from '../services/chain/feePolicy';
import { isStoreWriteFailed } from '../services/chain/storeWrite';
import { getStorage } from '../services/storage';
import { fetchPrices, type PriceMap, type PriceQuote } from '../services/prices';
import { HAS_GATEWAY } from '../services/gateway';
import {
  capDismissedKeys,
  fetchNotificationsResult,
  migrateDismissedKeys,
  normalizeDismissalKey,
  NOTIF_REFRESH_MS,
  type NotificationItem,
} from '../services/notifications';
import { isValidAddress } from '../services/chain/keys';
import {
  feePolicyFor,
  isNewChain,
  isYoungChain,
  networkFor,
  supportsAssets,
} from '../services/chain/chainParams';
import { EVM_NETWORK, loadEvmModules, walletFamily, type WalletFamily } from '../services/chain/engine';
import { evmProviderFor, readEvmDiscoveredBalances, refreshEvmWallet } from './evmBalances';
import { clearBalanceCaches, loadBalanceCache, mergeBalanceRows, saveBalanceCache } from './balanceCache';
import { setTokenLogos } from './tokenLogoRegistry';
import { loadOlderEvmHistory, refreshEvmHistory } from './evmHistory';
import { EVM_HISTORY_IN_MEMORY_MAX_ROWS, loadEvmHistoryCache, mergeEvmHistory } from './evmHistoryCache';
import {
  evmChainKeyOf,
  evmChainTarget,
  evmExplorerTxUrl,
  isEvmChainTarget,
  loadEvmChainInfos,
  type EvmChainInfo,
  type EvmChainTarget,
} from './evmChains';
import {
  broadcastEvmPlan,
  buildEvmSendPlan,
  withEvmFeeLevel,
  EvmSendError,
  type EvmSendInput,
  type EvmSendPlan,
} from './evmSend';
import {
  buildEvmStakePlan,
  loadEvmStakingSnapshot,
  readExactDelegation,
  readUnbondingEntryCount,
  type EvmStakeAction,
  type EvmStakeInput,
  type EvmStakePlan,
  type EvmStakingSnapshot,
} from './evmStaking';
import { withCallGasHeadroom, withEvmCallFeeLevel } from './evmCall';
import type { EvmFeeLevel } from '../services/chain/evm/fees';
import type { EvmNonceTracker } from '../services/chain/evm/nonce';
import { checkElectrumServer } from '../services/chain/electrumClient';
import {
  DEFAULT_ELECTRUM_SERVER_URLS,
  ELECTRUM_SERVERS_STORAGE_KEY,
  electrumServersStorageKey,
  defaultServerUrlsFor,
  isGatewayElectrumUrl,
  parseServerUrl,
  serverToUrl,
  setElectrumServers,
  withGatewayBridgeUrls,
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

// Module-level singleton — one service, one connection.
const svc = new LiveWalletService();

/** The page's one wallet service, for the dApp approval hosted in this page:
 *  once the user has unlocked the wallet here, a site's sign or send request
 *  is answered with THIS unlocked instance instead of asking for the password
 *  again in a fresh one (owner's rule, 2026-09-07). Read-only handle; the
 *  store stays the only thing that unlocks, locks or switches it. */
export function liveService(): LiveWalletService {
  return svc;
}

/** The active wallet's chain id (LiveNetworkId). Everything chain-dependent
 *  (native ticker, protected assets, server pool, explorer, price) reads this so
 *  it follows the active wallet. Exported so UI code (which chain is Send/Receive/
 *  Settings operating on right now) can read the same source of truth instead of
 *  re-deriving it from `wallets`/`activeWalletId` themselves. */
export function activeChainId(): LiveNetworkId {
  return svc.network();
}

/** Family of the ACTIVE wallet ('utxo' for every pre-EVM wallet). For an EVM
 *  account activeChainId() still names the LAST UTXO chain (the Electrum side
 *  is idle), so every chain-shaped read must consult this first. */
export function activeFamily(): WalletFamily {
  return svc.activeWalletFamily();
}

/** The chain id the UI should treat as active: the UTXO LiveNetworkId, or the
 *  `evm:<key>` target of the chain the active EVM account is showing. */
export function activeChainTarget(): string {
  const key = svc.evmChainKey();
  return activeFamily() === 'evm' && key ? evmChainTarget(key) : activeChainId();
}

/** Display facts for ANY chain id the switcher/picker can name: a UTXO
 *  LiveNetworkId/ChainId, or an `evm:<key>` target (resolved against the EVM
 *  chains this build knows). Null for an EVM target this build does not carry. */
export function describeChain(
  id: string,
  evmChains: readonly EvmChainInfo[],
): {
  id: string;
  family: WalletFamily;
  displayName: string;
  ticker: string;
  decimals: number;
  /** The project's own site. Both families carry one, so the chain list can
   *  show the domain that tells two similarly named chains apart. */
  homepage: string;
  /** A thin network: Home shows its caution notice. */
  young: boolean;
  /** Marked "New" beside the name in the chain list (young, or new here). */
  isNew: boolean;
} | null {
  const key = evmChainKeyOf(id);
  if (key !== null) {
    const c = evmChains.find((x) => x.key === key);
    return c
      ? {
          id,
          family: 'evm',
          displayName: c.displayName,
          ticker: c.nativeTicker,
          decimals: c.nativeDecimals,
          homepage: c.homepage,
          young: c.young,
          isNew: c.young || c.recentlyAdded,
        }
      : null;
  }
  const net = networkFor(id as LiveNetworkId);
  return {
    id,
    family: 'utxo',
    displayName: net.displayName,
    ticker: net.ticker,
    decimals: net.decimals,
    homepage: net.homepage,
    young: isYoungChain(net),
    isNew: isNewChain(net),
  };
}

/**
 * Human name of a chain (default = active chain), straight from its params.
 *
 * USE THIS IN UI COPY. The pattern it replaces was
 * `nativeTicker === 'RVN' ? 'Ravencoin' : 'EVRmore'`, a two-chain ternary that
 * silently mislabels EVERY chain added since: sending BTC announced the
 * "EVRmore network". A ternary cannot grow with the chain list; a lookup can.
 */
export function chainDisplayName(chainId: string = activeChainTarget()): string {
  const evm = evmChainInfoFor(chainId);
  if (evm) return evm.displayName;
  return networkFor(chainId as Parameters<typeof networkFor>[0]).displayName;
}

/** The EVM chains this build knows, mirrored here (module scope) so the pure
 *  chain helpers above the store can answer for `evm:<key>` ids without a
 *  store read. Filled by init() from loadEvmChainInfos(); empty without --evm. */
let evmChainInfos: readonly EvmChainInfo[] = [];

/** The EVM chain an id names: an `evm:<key>` target, or the stored 'evm'
 *  sentinel of an EVM summary (which means "the chain the active account is
 *  showing"). Null for a UTXO id or an unknown key. */
function evmChainInfoFor(chainId: string): EvmChainInfo | null {
  if (chainId === EVM_NETWORK) {
    const key = svc.evmChainKey();
    return key ? (evmChainInfos.find((c) => c.key === key) ?? null) : null;
  }
  const key = evmChainKeyOf(chainId);
  if (key === null) return null;
  return evmChainInfos.find((c) => c.key === key) ?? null;
}

/** Native coin ticker ('EVR' / 'RVN' / 'ETH' / 'BNB') of a chain (default =
 *  the active chain, EVM-aware). Exported for chain-aware UI labels (fee
 *  notes, error text, unit suffixes). */
export function nativeTickerFor(chainId: string = activeChainTarget()): string {
  const evm = evmChainInfoFor(chainId);
  if (evm) return evm.nativeTicker;
  return networkFor(chainId as LiveNetworkId).ticker;
}

/** The identifier the notification targeting matches THIS wallet's active chain
 *  against (services/notifications.ts). A UTXO chain is its native ticker,
 *  upper-cased (EVR, RVN, BTGS, LTC, WJK, BTC, DOGE); an EVM chain is
 *  `EVM:<KEY>` upper-cased (EVM:BASE, EVM:BSC, EVM:ETHEREUM, EVM:EPIX). Built
 *  from the SAME chain helpers the rest of the UI uses, so a chain added later
 *  is targetable with no change here. */
export function activeChainIdentifier(): string {
  const target = activeChainTarget();
  const key = evmChainKeyOf(target);
  if (key !== null) return `EVM:${key.toUpperCase()}`;
  return nativeTickerFor(target).toUpperCase();
}

/** Whether `assetId` names the chain's NATIVE coin (EVR on Evrmore, RVN on
 *  Ravencoin) rather than an issued asset. Send dispatch MUST use this, never a
 *  hardcoded ticker: on a Ravencoin wallet the native coin arrives as 'RVN', and a
 *  literal `=== 'EVR'` check routed it down the ASSET path, asking the chain for
 *  an asset named "RVN" (which does not exist -> unknown-asset at review). */
export function isNativeAssetId(assetId: string, chainId: string = activeChainTarget()): boolean {
  return assetId.trim().toUpperCase() === nativeTickerFor(chainId).toUpperCase();
}

/** Wallets that live on the SAME chain as `chainId` (default = active chain).
 *
 *  RULE (owner, applies to every future chain): cross-chain sends are impossible.
 *  An R... wallet cannot receive EVR and an E... wallet cannot receive RVN, so
 *  EVERY recipient picker (the My-wallets quick-pick, the address book, any
 *  future suggestion UI) must be scoped to the active wallet's chain with this
 *  helper, not shown unfiltered. */
export function walletsOnChain<T extends { network: string; family?: WalletFamily }>(
  wallets: T[],
  chainId: string = activeChainTarget(),
): T[] {
  // An EVM account is ONE address on every EVM chain, so every EVM wallet is
  // "on" every `evm:<key>` target: the recipient picker for a Base send may
  // offer the user's other EVM accounts, never a UTXO one.
  if (isEvmChainTarget(chainId)) return wallets.filter((w) => walletFamily(w) === 'evm');
  const chain = networkFor(chainId as LiveNetworkId).chainId;
  // Family first: an EVM account has no UTXO `network`, so it must never reach
  // networkFor(). Absent family = utxo, so every existing wallet is unaffected.
  return wallets.filter(
    (w) => walletFamily(w) === 'utxo' && networkFor(w.network as LiveNetworkId).chainId === chain,
  );
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
export function chainsWithWallets(wallets: WalletSummary[], evmChainKeys: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  for (const w of wallets) {
    if (walletFamily(w) === 'evm') {
      // One EVM account enables EVERY EVM chain this build knows: same address
      // on all of them, so there is nothing to derive per chain.
      for (const key of evmChainKeys) out.add(evmChainTarget(key));
      continue;
    }
    for (const alias of chainIdAliases(w.network)) out.add(alias);
  }
  return out;
}

/** A wallet's name with its OWN chain's tag stripped off the end, e.g.
 *  "Wallet 1 (Ravencoin)" -> "Wallet 1". enableChain names a derived sibling
 *  `<base> (<target chain>)`, so stripping the tag recovers the shared base name
 *  that groups one seed's wallets across chains. Param-driven (the chain's own
 *  displayName/ticker), so it never needs a table of chain names. */
function baseWalletName(w: { name: string; network: string; family?: WalletFamily }): string {
  const name = w.name.trim();
  // An EVM account is tagged with the family, not a chain (enableChain names
  // it "<base> (EVM)"), and has no UTXO params to consult.
  const tags = walletFamily(w) === 'evm' ? ['EVM'] : [networkFor(w.network as LiveNetworkId).displayName, networkFor(w.network as LiveNetworkId).ticker];
  for (const tag of tags) {
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
  // Switching to an EVM chain while an EVM account is active stays on THAT
  // account (the address is the same on every EVM chain); otherwise the
  // sibling rule below picks the EVM account derived from the active seed.
  if (isEvmChainTarget(chainId) && active && walletFamily(active) === 'evm') return active;
  // The sibling rule (chain-tagged names come from enableChain: "Name (Base)"
  // or "Name (Ravencoin)"); an active EVM account has no UTXO chain to strip,
  // so a UTXO target falls through to FIRST.
  if (active && (walletFamily(active) === 'utxo' || isEvmChainTarget(chainId))) {
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
export function stakingSupported(chainId: string = activeChainTarget()): boolean {
  return nativeTickerFor(chainId) === 'EVR';
}

/** Whether this chain has NATIVE staking, the kind a cosmos/evm chain exposes
 *  through precompiles (Epix). A different feature from Satori pool staking
 *  above, on a different family, with its own screen: the two are deliberately
 *  separate predicates so a chain can have either, both or neither, and no
 *  screen ever has to name a chain to decide.
 *
 *  Reads the registry mirror in state, so a build without the EVM engine (whose
 *  chain list is empty) answers false everywhere. */
export function evmStakingSupported(chainId: string = activeChainTarget()): boolean {
  return !!evmChainInfoFor(chainId)?.staking;
}

/** Whether this chain (default = active chain) implements the Ravencoin-style
 *  asset protocol at all, i.e. whether token/asset UI makes sense on it —
 *  "Add token", the Assets list chrome, asset sends. FALSE on a plain UTXO
 *  chain like Bitcoin Gold (BTGS), which has no asset layer. Every asset
 *  affordance in the UI MUST gate on this CAPABILITY, never on a hardcoded
 *  chain name or ticker (`=== 'BTGS'`) — that is what lets a future plain
 *  chain drop in with no UI edits. */
export function assetsSupported(chainId: string = activeChainTarget()): boolean {
  // Every EVM chain has a token layer (ERC-20).
  if (evmChainInfoFor(chainId)) return true;
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

/**
 * 'app-locked' is the APP lock screen (the app-password design notes §5): it only
 * ever appears once the user has SET an app password, and it gates the whole
 * application, with the choice of wallet coming after it. Without an app
 * password the phase never occurs and the flow is 'locked' -> 'ready' exactly as
 * it has always been.
 *
 * 'force-app-password' is the FORCED SETUP screen (§12), and it is the inverse
 * situation: it appears only for a user who has a wallet that opens with NO
 * password and no app password to protect it with. It is the one phase with no
 * way out but forward, so it can only ever be entered from init() and can only
 * be left by setting the password.
 */
export type LivePhase =
  | 'boot'
  | 'onboarding'
  | 'force-app-password'
  | 'app-locked'
  | 'locked'
  | 'ready';

/** A token this wallet reads on an EVM chain, identified by contract. */
export interface EvmTrackedToken {
  address: string;
  symbol: string;
  decimals: number;
  /** Its mark as a validated PNG data: URL (evm/tokenLogos.ts), once fetched;
   *  absent = not fetched yet, none exists, or the wallet will not vouch for
   *  the token (letter badge). A mark is kept ONLY for a token the trust rule
   *  says yes to: see evm/tokenTrust.ts. */
  logo?: string;
  /** Does the wallet vouch for this token (evm/tokenTrust.ts: in the chain's
   *  token list AND carrying a mark)? true = no warning, shown automatically
   *  while it holds a balance; false = drawn as unlisted, and a DISCOVERED one
   *  is kept out of the list (airdrop / spam) until the user imports it or adds
   *  it by contract; absent = not checked yet, no claim either way. */
  trusted?: boolean;
  /** Which version of the trust rule produced `trusted`. Absent means the
   *  pre-1.4.0 rule, which vouched for a token on a mark alone. See
   *  TOKEN_TRUST_RULE. */
  trustRule?: number;
}

/**
 * Version of the rule behind every persisted `trusted` verdict.
 *
 * 1 (implicit, pre-1.4.0): a mark existed for the contract. In a gateway build
 *   that read "the gateway returned a picture", which a hostile gateway can
 *   arrange for its own contract (2026-08-25 security review).
 * 2: evm/tokenTrust.ts, which also requires the contract to be in the chain's
 *   public token list.
 *
 * A stored verdict from an older rule that said TRUSTED is not one this build
 * will stand behind, so it is cleared on read and decided again. An older
 * `false` survives: "no mark" is untrusted under every rule, and re-asking
 * would cost a probe per spam token on every unlock.
 */
export const TOKEN_TRUST_RULE = 2;

/** One row of the Add token search on an EVM chain: a token from the chain's
 *  public token list. `symbol`/`name` label the ROW only; adding the token
 *  still goes through addEvmToken(address), which reads symbol and decimals
 *  from the chain (see src/services/chain/evm/tokenSearch.ts, rule (a)). */
export interface TokenSearchHit {
  /** EIP-55 checksummed contract address. */
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

/** How many indexer-discovered token contracts are remembered per account and
 *  chain (newest first). Each costs one balanceOf per refresh. */
const MAX_DISCOVERED_EVM_TOKENS = 40;

/** The history indexer is asked at most this often per (address, chain) on the
 *  20 s auto-refresh: public Blockscout rate-limits by IP and a wallet polling
 *  history six times a minute gets itself banned for a while. A MANUAL refresh
 *  (not silent) always asks. */
const EVM_HISTORY_MIN_INTERVAL_MS = 60_000;
const evmHistoryAskedAt = new Map<string, number>();

const evmTrackedKey = (walletId: string, chainKey: string) => `evmTokens:${walletId}:${chainKey}`;
const evmDiscoveredKey = (walletId: string, chainKey: string) => `evmDiscovered:${walletId}:${chainKey}`;

/** Read a persisted token list; malformed entries are dropped. */
async function readEvmTokens(key: string): Promise<EvmTrackedToken[]> {
  try {
    const v = await getStorage().get<unknown>(key);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (t): t is EvmTrackedToken =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as EvmTrackedToken).address === 'string' &&
          typeof (t as EvmTrackedToken).symbol === 'string' &&
          typeof (t as EvmTrackedToken).decimals === 'number',
      )
      .map(retireStaleTrust);
  } catch {
    return [];
  }
}

/** Drop a `trusted: true` (and the mark it came with) that an older, weaker
 *  rule recorded, so the current rule decides it again. See TOKEN_TRUST_RULE.
 *  Until the re-check lands the token simply carries no claim: no vouching, and
 *  no warning it has not earned. */
export function retireStaleTrust(token: EvmTrackedToken): EvmTrackedToken {
  if (token.trusted !== true || token.trustRule === TOKEN_TRUST_RULE) return token;
  const next: EvmTrackedToken = { ...token };
  delete next.trusted;
  delete next.logo;
  delete next.trustRule;
  return next;
}

/** Transient sync feedback: 'initial' while a wallet with no cached history runs
 *  its first full refresh (slim banner on home), 'switching' while the active
 *  wallet is being swapped (full-frame loading screen). Never persisted. */
export type LiveSyncing = 'idle' | 'initial' | 'switching';

/** Legacy GLOBAL pin/hide lists (pre-2.2). Kept only for one-time migration into
 *  the active wallet — they were shared across wallets, which is the bug we fix. */
const PINNED_ASSETS_KEY = 'pinnedAssets';
const HIDDEN_ASSETS_KEY = 'hiddenAssets';

/** Owner-authored notifications the user has dismissed: an array of DISMISSAL
 *  KEYS (`id@rev`, see services/notifications.ts dismissalKey). Global, not
 *  per-wallet: a dismissed notice stays dismissed on every account.
 *
 *  The storage key keeps its `.v1` name across the move from bare ids to
 *  `id@rev` on purpose: the shape is still an array of strings and the entries
 *  are migrated on READ (migrateDismissedKeys), so a user upgrading from a build
 *  that stored bare ids keeps every dismissal instead of having them all come
 *  back at once. A new key would have thrown that history away. */
const NOTIF_DISMISSED_KEY = 'notif.dismissed.v1';

/** Per-wallet pin/hide lists: each wallet curates its OWN tokens, so adding or
 *  removing an asset in one wallet never affects another. Keyed by wallet id. */
const pinnedKey = (walletId: string) => `pinnedAssets:${walletId}`;
const hiddenKey = (walletId: string) => `hiddenAssets:${walletId}`;

/** The user's manual row order, per wallet AND per chain. The chain is in the
 *  key because the ASSET SET is per chain: one EVM account holds a different
 *  list of tokens on Base than on BNB Chain, and an order shared between them
 *  would be a list of names that mostly do not exist on the other side. Same
 *  shape as the pin/hide keys, one segment longer. */
const assetOrderKey = (walletId: string, chainId: string) => `assetOrder:${walletId}:${chainId}`;

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

/** "We have not asked how far back this source goes." Every wallet switch,
 *  chain switch and lock resets to it, because the answer belongs to ONE
 *  account on ONE chain. */
function emptyOlderHistory(): LiveState['olderHistory'] {
  return { canLoadOlder: null, cursor: null, loading: false, error: null };
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
/** Home's "hide zero balances" toggle. GLOBAL, not per wallet or chain: it is a
 *  reading preference about lists, and someone who does not want to see empty
 *  rows does not want to see them on the next chain either. */
const HIDE_ZERO_BALANCES_KEY = 'ui:hideZeroBalances';
/** Privacy mode: amounts on Home are masked (owner, 2026-08-19: the eye on the
 *  main window should switch balances off, like MetaMask). */
const HIDE_BALANCES_KEY = 'ui:hideBalances';
/** Per seed + EVM chain: the account indexes known USED there (the EVM accounts
 *  design notes, per-chain visibility). Written by discovery and Add account;
 *  read into `evmAccountsOnChain` for the active chain. */
const evmSeenKey = (seedGroup: string, chainKey: string) => `evmAccountsSeen:${seedGroup}:${chainKey}`;

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
  // An EVM chain (`evm:<key>`): hideable unless it is the one in use. There is
  // no "home" EVM chain; the account exists on every EVM chain regardless.
  if (isEvmChainTarget(chainId)) {
    return chainId === activeChain ? 'This is the network you are using. Switch to another one first.' : null;
  }
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

/** What the last (or running) gap-limit address scan is doing / found. Session
 *  only, never persisted: the addresses it discovers ARE the persisted part. */
export interface AddressScanState {
  /** True while a scan is in flight (drives the spinner + disables the button). */
  scanning: boolean;
  /** Receive indices examined so far this run, out of at most MAX_SCAN_INDEX+1. */
  scanned: number;
  /** Result of the last finished scan, or null when none has run this session. */
  result: {
    /** How many receive addresses the scan ADDED (0 = nothing was found). */
    found: number;
    /** The wallet's address count after the scan. */
    addressCount: number;
    /** False when the answer is only a lower bound (see AddressScanResult). */
    complete: boolean;
    /** Addresses whose history could not be read (never counted as empty). */
    failedReads: number;
  } | null;
  /** Last scan error (locked wallet, no wallet), or null. */
  error: string | null;
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

/** Default NEOXA block-explorer URL template. VERIFIED LIVE 2026-08-25 against
 *  the real mainnet txid
 *  6015158b4ed814d31a16dbdf9810e28a84c33b664b32474878a921dd315d2704 (the
 *  coinbase of block 2,231,300, hash
 *  0000000000448c8880a3a2273258fadbd3823738b03b298b587b1a6140ed99b8, read from
 *  the chain itself through the explorer's own getblockhash/getblock API):
 *  https://explorer.neoxa.net/tx/<txid> answered HTTP 200 with the SERVED HTML
 *  already containing that txid (3 times) AND the block height 2,231,300 — i.e.
 *  server-rendered real data cross-checked against the live chain, the stronger
 *  of the two verification methods used in this file (the SPA cases above had to
 *  fall back to the explorer's API). It is the project's own explorer, linked
 *  from neoxa.net.
 *
 *  explorers.test.ts pins that no two chains share a template, a check that
 *  exists because a WojakCoin transaction once opened on Evrmore's explorer. */
export const DEFAULT_EXPLORER_URL_NEOX = 'https://explorer.neoxa.net/tx/{txid}';

/** Default BITCOIN BLAKE2b block-explorer URL template. VERIFIED LIVE 2026-09-07:
 *  mempool.guide is a mempool.space-style explorer indexing the BLAKE2b chain
 *  (its tip and raw headers match electrum.bitcoinxor.org block for block, and
 *  /api/block/<hash> carries the fork's header_v2 fields). Same URL shape as
 *  mempool.space, so a txid resolves at https://mempool.guide/tx/<txid>. */
export const DEFAULT_EXPLORER_URL_BTCB2 = 'https://mempool.guide/tx/{txid}';

/** Block-explorer template default for a chain (default = active chain). '' on
 *  a chain with no known explorer (see the WOJAKCOIN comment above) — callers
 *  must treat an empty template as "no explorer available", not fall through
 *  to another chain's URL.
 *
 *  This is the SINGLE place that knows which chains have an explorer; the
 *  absence of an entry IS the answer, so nothing else needs a chain check. */
function defaultExplorerFor(chainId: string = activeChainTarget()): string {
  const evm = evmChainInfoFor(chainId);
  if (evm) return evm.explorerTxUrl;
  const ticker = nativeTickerFor(chainId);
  if (ticker === 'RVN') return DEFAULT_EXPLORER_URL_RVN;
  if (ticker === 'BTGS') return DEFAULT_EXPLORER_URL_BTGS;
  if (ticker === 'LTC') return DEFAULT_EXPLORER_URL_LTC;
  if (ticker === 'BTC') return DEFAULT_EXPLORER_URL_BTC;
  if (ticker === 'DOGE') return DEFAULT_EXPLORER_URL_DOGE;
  if (ticker === 'WJK') return DEFAULT_EXPLORER_URL_WJK;
  if (ticker === 'NEOX') return DEFAULT_EXPLORER_URL_NEOX;
  if (ticker === 'BTCB2') return DEFAULT_EXPLORER_URL_BTCB2;
  if (ticker === 'EVR') return DEFAULT_EXPLORER_URL;
  // A chain with no known explorer fails closed rather than borrowing another
  // chain's, which would resolve a foreign txid on the wrong chain and read to
  // the user as "not found". Every chain shipped today has one.
  return '';
}

/** True when the chain ships a built-in explorer template. DERIVED from
 *  defaultExplorerFor so a new chain never needs a second edit here, and a
 *  chain can never claim an explorer it does not have. */
export function hasDefaultExplorer(chainId: string = activeChainTarget()): boolean {
  return defaultExplorerFor(chainId) !== '';
}

/** Per-chain storage key for the user-editable explorer template. Evrmore keeps
 *  the legacy bare key ('explorerUrlTemplate'); Ravencoin, Bitcoin Gold,
 *  Litecoin, WojakCoin, Bitcoin and Dogecoin are each suffixed with their own
 *  canonical chainId (WojakCoin's key exists so a user who later types in their
 *  own explorer URL still gets a chain-isolated slot, even though there is no
 *  built-in default). */
function explorerKeyForChain(chainId: string = activeChainTarget()): string {
  const ticker = nativeTickerFor(chainId);
  if (ticker === 'RVN') return `${EXPLORER_URL_KEY}:ravencoin-mainnet`;
  if (ticker === 'BTGS') return `${EXPLORER_URL_KEY}:bitcoingold-mainnet`;
  if (ticker === 'LTC') return `${EXPLORER_URL_KEY}:litecoin-mainnet`;
  if (ticker === 'WJK') return `${EXPLORER_URL_KEY}:wojakcoin-mainnet`;
  if (ticker === 'BTC') return `${EXPLORER_URL_KEY}:bitcoin-mainnet`;
  if (ticker === 'DOGE') return `${EXPLORER_URL_KEY}:dogecoin-mainnet`;
  if (ticker === 'NEOX') return `${EXPLORER_URL_KEY}:neoxa-mainnet`;
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
export function protectedAssetsFor(chainId: string = activeChainTarget()): readonly string[] {
  const ticker = nativeTickerFor(chainId);
  // An EVM chain protects its native coin and its DEFAULT tokens: those rows
  // come from the provider, not from pins, and until token management for EVM
  // exists (add by contract address) a removed default could not be restored.
  const evm = evmChainInfoFor(chainId);
  if (evm) return [ticker, ...evm.defaultTokens.map((t) => t.symbol ?? '').filter(Boolean)];
  if (!assetsSupported(chainId)) return [ticker];
  return ticker === 'EVR' ? ['EVR', 'SATORIEVR'] : [ticker];
}

/** Evrmore protected assets (historical default; kept for back-compat callers). */
export const PROTECTED_ASSETS: readonly string[] = ['EVR', 'SATORIEVR'];

/** False for a protected asset of the given chain (default active). The single
 *  source of truth for every remove control. */
export function isRemovableAsset(name: string, chainId: string = activeChainTarget()): boolean {
  return !protectedAssetsFor(chainId).includes(name.trim().toUpperCase());
}

/** Assets pinned out of the box for a chain, so nobody has to "Add token" for the
 *  asset the wallet exists for. The native coin is never listed: it is always
 *  first, by construction. Evrmore pins SATORIEVR; Ravencoin pins nothing; a
 *  chain with no asset protocol (BTGS) pins nothing — there is nothing it could
 *  pin. */
export function defaultPinsFor(chainId: string = activeChainTarget()): readonly string[] {
  if (!assetsSupported(chainId) || evmChainInfoFor(chainId)) return [];
  return nativeTickerFor(chainId) === 'EVR' ? ['SATORIEVR'] : [];
}

/** Evrmore default pins (historical default; kept for back-compat callers). */
export const DEFAULT_PINNED_ASSETS = ['SATORIEVR'] as const;

/**
 * Drop pins that cannot exist on `chainId`: every pin on an EVM chain (tokens
 * there are tracked by contract, not by name), and SATORIEVR anywhere but on an
 * Evrmore-ticker chain. Same reference back when nothing changes.
 */
export function sanitizePins(pinned: string[], chainId: string = activeChainTarget()): string[] {
  if (evmChainInfoFor(chainId)) return pinned.length === 0 ? pinned : [];
  const evrmore = nativeTickerFor(chainId) === 'EVR';
  const kept = pinned.filter((n) => evrmore || n.toUpperCase() !== 'SATORIEVR');
  return kept.length === pinned.length ? pinned : kept;
}

/**
 * Ensure the chain's default assets are pinned. Returns the SAME array reference
 * when nothing changes, so callers can skip a pointless write to storage.
 */
export function applyDefaultPins(pinned: string[], chainId: string = activeChainTarget()): string[] {
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
export function unhideProtected(hidden: string[], chainId: string = activeChainTarget()): string[] {
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
  chainId: string = activeChainTarget(),
): LiveAssetBalance[] {
  // Native coin name for this chain (EVR / RVN / ETH) — always first, never hidden.
  const native = nativeTickerFor(chainId);
  const evmInfo = evmChainInfoFor(chainId);
  const nativeDecimals = evmInfo ? evmInfo.nativeDecimals : networkFor(chainId as LiveNetworkId).decimals;
  const nativeRow =
    assets.find((a) => a.isNative || a.name === native) ??
    ({
      name: native,
      amountBase: 0n,
      scale: nativeDecimals,
      decimals: evmInfo ? nativeDecimals : 8,
      isNative: true,
    } as LiveAssetBalance);

  // A protected asset can never be hidden, whatever the list says.
  const hiddenSet = new Set(hidden.filter((n) => isRemovableAsset(n, chainId)));

  // Held (non-native) assets keyed by name.
  const byName = new Map<string, LiveAssetBalance>();
  for (const a of assets) {
    if (a.isNative || a.name === native) continue;
    byName.set(a.name, a);
  }
  // Pinned-but-not-held show up with a 0 balance. (Not on an EVM chain: pins
  // are UTXO asset names; EVM tokens arrive as rows from the provider.)
  for (const name of evmInfo ? [] : pinned) {
    if (name === native) continue;
    if (!byName.has(name)) {
      // Pinned but not held: an ASSET row, so its scale is the on-chain asset
      // base unit (always 8), not the chain's own.
      byName.set(name, { name, amountBase: 0n, scale: 8, decimals: 8, isNative: false });
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
      // bigint addition: summing across addresses is exactly where the old
      // whole-unit floats accumulated error, one rounding per address.
      byName.set(a.name, prev ? { ...prev, amountBase: prev.amountBase + a.amountBase } : { ...a });
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
  // Display figures for the optimistic row. The chain's own scale for the fee
  // (always the native coin); an ASSET amount stays on the chain's on-chain base
  // unit, which is 1e8 for every Evrmore/Ravencoin asset regardless of that
  // asset's own `divisions` — see ASSET_BASE_UNIT in electrumProvider.
  const chainDecimals = networkFor(chainId as LiveNetworkId).decimals;
  const feeNative = amountToNumber(plan.feeSats, chainDecimals);
  const sent = amountToNumber(plan.amountSats, chainDecimals);
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

  // --- app password (optional; the app-password design notes) ------------------
  /** True when an app password is configured on this device. False for every
   *  install that never opted in, which is what keeps the old flow intact. */
  appPasswordSet: boolean;
  /** True while the session holds the master key (page memory only). */
  appUnlocked: boolean;
  /** True when a recovery code exists on this device (the app-password design notes
   *  §13). Only ever true alongside `appPasswordSet`: the code is a second way
   *  to the app's master key, so there is nothing for it to open without one. */
  recoveryCodeSet: boolean;

  // --- wallet data ----------------------------------------------------------
  /** Primary receive address (= addresses[0].address) — kept for back-compat. */
  address: string;
  /** All derived receive addresses of the active wallet ([0] = primary). */
  addresses: ReceiveAddress[];
  /** Dynamically-detected balances aggregated across ALL addresses (EVR first). */
  assets: LiveAssetBalance[];
  /** User-added (pinned) asset names — persisted. MEMBERSHIP only: a pinned
   *  asset gets a row even at a zero balance. It has never meant "first", and
   *  `assetOrder` below is what owns position. */
  pinnedAssets: string[];
  /** User-removed (hidden) asset names — persisted. */
  hiddenAssets: string[];
  /** The user's own row order for the Home asset list, non-native names only,
   *  best first — persisted PER WALLET AND PER CHAIN (the asset set is). Empty
   *  = never arranged, so the automatic order decides everything. A name that
   *  is no longer displayed is ignored, not resurrected (applyManualOrder). */
  assetOrder: string[];
  txs: LiveTransaction[];
  /** Latest USD prices, keyed by ticker. Absent key = no price yet. NOT a closed
   *  set: the gateway publishes whatever tickers the owner configured sources
   *  for, so a chain added later shows fiat with no change here. */
  prices: PriceMap;
  /** 24h price move in PERCENT for the priced assets (2.4 = +2.4%), keyed by
   *  asset name. Kept exactly like `prices`: an absent key means "not known",
   *  and a failed fetch leaves the previous value in place rather than blanking
   *  it. Only the assets whose source publishes (or lets us derive) a 24h figure
   *  ever appear here. */
  priceChanges24h: Partial<Record<string, number>>;
  /** The FULL quote table as published (ticker -> { usd, eur, pln, change24h,
   *  source }). `prices` and `priceChanges24h` are the views of it the UI reads
   *  today; this is kept whole so a later currency switch or a "priced by"
   *  label needs no new plumbing, and so an unknown ticker is never dropped. */
  priceTable: Record<string, PriceQuote>;
  /** Owner-authored notifications from the gateway, ALREADY order-sorted (lowest
   *  first). Empty in a build with no gateway. Home picks the ones that apply to
   *  this wallet with selectNotifications and the banner rotates through them. */
  notifications: NotificationItem[];
  /** Epoch ms of the last SUCCESSFUL notifications fetch (0 = never). Drives the
   *  refetch throttle; a failed fetch leaves the list AND this untouched. */
  notificationsFetchedAt: number;
  /** Notifications the user dismissed, as DISMISSAL KEYS (`id@rev`, see
   *  services/notifications.ts dismissalKey), NOT bare ids: a notice the owner
   *  resubmits with a bumped rev is a key nobody has dismissed, so it comes back
   *  for everyone. Persisted, global across wallets; legacy bare ids from an
   *  older build are migrated to `id@0` when they are read. */
  dismissedNotificationKeys: string[];
  /** Number of transactions not yet viewed in Activity (drives the tab badge). */
  unreadActivity: number;
  /** What the active wallet has already seen in Activity (persisted per wallet):
   *  a height water mark plus the newest txids. See ActivitySeen. */
  activitySeen: ActivitySeen;
  /** Set when a server ANSWERED and refused one of this wallet's addresses (e.g.
   *  "history too large"), so Activity is knowingly incomplete. Null when every
   *  address's history was read. Never persisted: it is re-learned every sync. */
  historyIssue: HistoryIssue | null;
  /** True while the history source is being read (UTXO classification run or
   *  the EVM indexer). Activity shows a loading state instead of "No
   *  transactions yet" while this is on and nothing is listed (owner, 2026-08-19:
   *  "for a while Activity showed nothing although it was fetching"). */
  historyLoading: boolean;
  /**
   * How much further back this wallet's history source can go, for the "Load
   * older" control on Activity (owner, live testing 2026-08-25: "there is no
   * pagination in activities, I checked for USDT on EVM BNB").
   *
   * It is deliberately a THREE-state answer, because "we have not asked yet",
   * "there is more" and "that is everything this source has" are three
   * different things and only the last one may be shown as a full stop:
   *   - `canLoadOlder: null`  the question has not been settled yet.
   *   - `canLoadOlder: true`  there is another page to fetch.
   *   - `canLoadOlder: false` the source has nothing older, OR cannot page at
   *     all (a UTXO chain, where Electrum already served the WHOLE address
   *     history and there is nothing left to ask for).
   */
  olderHistory: {
    canLoadOlder: boolean | null;
    /** Opaque, source-specific; never read outside the history modules. */
    cursor: string | null;
    loading: boolean;
    /** Why the last "Load older" failed, in the wallet's own words. */
    error: string | null;
  };
  /** Locally-recorded Satori pool staking events for the active wallet (newest
   *  first; persisted per wallet). Merged into the Activity feed. */
  stakingEvents: StakingEvent[];
  network: NetworkStatus | null;

  // --- EVM (family 'evm') ------------------------------------------------------
  /** The EVM chains this build knows (EMPTY in a package built without --evm:
   *  every EVM affordance in the UI keys off this list) and the chain the
   *  ACTIVE EVM account is showing (null for a UTXO wallet). */
  evm: { chains: EvmChainInfo[]; activeChainKey: string | null };
  /** ERC-20 tokens of the ACTIVE account on the ACTIVE EVM chain, by CONTRACT:
   *  `tracked` = added by the user (always shown, even at 0), `discovered` =
   *  seen moving through the address by the history indexer (shown only while
   *  the balance is above 0). Both persisted per wallet and chain. */
  evmTokens: { tracked: EvmTrackedToken[]; discovered: EvmTrackedToken[] };
  /** The EVM send being reviewed (built by quoteEvmSend, sent by confirmEvmSend). */
  evmSend: EvmSendPlan | null;
  loadingEvmSend: boolean;
  /** Native staking on an EVM chain that has it (Epix): what the Stake screen
   *  shows, and the action under review. `snapshot` is null before the first
   *  read and on a chain with no staking; `plan` is the priced precompile call
   *  waiting for the arming gate, exactly as `evmSend` is for a send. */
  evmStaking: { snapshot: EvmStakingSnapshot | null; loading: boolean; plan: EvmStakePlan | null; planning: boolean };

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
  /** When true, the Home asset list leaves out every zero-balance row (the
   *  native coin excepted — it is the chain's own coin and always shows). A
   *  view filter only: nothing is unpinned, hidden or forgotten, and the count
   *  of what it left out is shown under the list so it is never a silent loss. */
  hideZeroBalances: boolean;
  /** Privacy mode: every amount on Home reads as dots. Persisted. */
  hideBalances: boolean;
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
  /** Whether the wallet behind `pendingMnemonic` was created WITH a BIP39
   *  passphrase. The backup screen calls the words "the ONLY backup", which is
   *  false and dangerous for such a wallet, so it needs to know. Only meaningful
   *  while `pendingMnemonic` is set, and cleared everywhere that is. */
  pendingMnemonicHasPassphrase: boolean;

  // --- pending send plan ----------------------------------------------------
  sendPlan: LiveSendPlan | null;

  // --- Satori pool staking (SATORIEVR only) ---------------------------------
  /** Live pool-staking state for the active wallet (server truth; not persisted). */
  staking: StakingState;

  // --- receive-address discovery (gap-limit scan) ---------------------------
  /** Progress + outcome of the last gap-limit scan for used receive addresses. */
  addressScan: AddressScanState;
  /** EVM accounts (the EVM accounts design notes): the last "discover accounts"
   *  run on the active seed. `added` = how many new account entries the last
   *  run created (null = no run yet / dismissed). */
  evmAccountScan: EvmAccountScanState;
  /** For the ACTIVE EVM chain: seedGroup -> hdIndexes known used there.
   *  A missing group means "no data yet" (everything shows). */
  evmAccountsOnChain: Record<string, number[] | undefined>;

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
  /** `passphrase` is the BIP39 passphrase (the "25th word"), the same trailing
   *  parameter importWallet() takes and with the same meaning: part of the seed
   *  derivation, NOT the wallet password. Empty = today's behaviour exactly. */
  createWallet(
    password: string,
    name?: string,
    /** A UTXO LiveNetworkId, or an `evm:<key>` target for ONE account that spans every EVM chain. */
    network?: LiveNetworkId | EvmChainTarget,
    passphrase?: string,
  ): Promise<void>;
  clearPendingMnemonic(): void;
  /** `passphrase` is the BIP39 passphrase (the "25th word"), part of the seed
   *  derivation and NOT the wallet password. Empty = today's behaviour. */
  importWallet(
    mnemonic: string,
    password: string,
    name?: string,
    network?: LiveNetworkId | EvmChainTarget,
    passphrase?: string,
  ): Promise<void>;
  importPrivateKeyWallet(
    input: string,
    password: string,
    name?: string,
    network?: LiveNetworkId | EvmChainTarget,
  ): Promise<void>;
  /** Point the ACTIVE EVM account at another EVM chain (persisted); the address
   *  is unchanged, balances refresh for the new chain. No-op for a UTXO wallet. */
  switchEvmChain(key: string): Promise<void>;
  /** Load the ACTIVE account's tracked + discovered token lists for the ACTIVE
   *  EVM chain (empty for a UTXO wallet). */
  loadEvmTokens(): Promise<void>;
  /** Fetch marks (Trust Wallet assets, PNG data URLs) for tracked tokens that
   *  have none yet; best-effort, persisted, published to the icon registry. */
  fetchEvmTokenLogos(): Promise<void>;
  /** Decide, for discovered tokens not yet checked, whether they are listed
   *  in the Trust Wallet registry (trusted: shown automatically) or not
   *  (kept out until imported). Best-effort, persisted. */
  checkDiscoveredEvmTokens(): Promise<void>;
  /** Build an EVM send plan for review (fee quoted at every level, caps and
   *  balances checked). Sets `evmSend`; returns null and sets `error` on failure. */
  quoteEvmSend(input: EvmSendInput): Promise<EvmSendPlan | null>;
  /** Re-price the plan under review at another level (no new quote). */
  selectEvmFeeLevel(level: EvmFeeLevel): Promise<void>;
  /** The largest native amount that fits with the worst-case fee at `level`, as
   *  exact text for the amount field ('0' when nothing fits or unknown). Pass
   *  the recipient when known: gas differs for a contract recipient, and the
   *  quote at Review must see the same gas this figure was built with. */
  estimateEvmMax(level?: EvmFeeLevel, to?: string): Promise<{ maxText: string; feeText: string }>;
  /** True when the ACTIVE EVM chain has contract code at `address`
   *  (eth_getCode), false when it is a plain account, null when the question
   *  could not be answered (no engine, no EVM chain, RPC failure). A warning
   *  input only: the send screens never block on it, so "unknown" must stay
   *  distinguishable from "not a contract". Cached per chain and address. */
  isEvmContractAddress(address: string): Promise<boolean | null>;
  /** Sign and broadcast the plan under review (requires arm(true), exactly as
   *  the UTXO path). Resolves with the txid and its explorer link. */
  confirmEvmSend(): Promise<{ txid: string; explorerUrl: string; chainKey: string }>;
  clearEvmSend(): void;

  // --- EVM native staking (a chain whose registry row has `staking`) ---------
  /** Read validators, my delegations, my unbonding entries and my rewards for
   *  the active EVM account. Never throws: failures land in `snapshot.issue`. */
  refreshEvmStaking(): Promise<void>;
  /** Price one staking action for review (delegate / undelegate / redelegate /
   *  claim). Sets `evmStaking.plan`; returns null and sets `error` on failure,
   *  including the node's honest refusal to simulate. */
  planEvmStake(input: EvmStakeInput): Promise<EvmStakePlan | null>;
  /** Re-price the plan under review at another fee level (no new quote). */
  selectEvmStakeFeeLevel(level: EvmFeeLevel): Promise<void>;
  /** The largest amount this action can carry, as exact text: the balance minus
   *  the worst-case fee and a margin for delegate, the exact delegation read
   *  from the precompile for undelegate and redelegate. */
  estimateEvmStakeMax(action: EvmStakeAction, valoper: string, level?: EvmFeeLevel): Promise<string>;
  /** How many unbonding entries the account already has with `valoper`, or null
   *  when unknown. The chain refuses an undelegate past its max_entries. */
  countEvmUnbondingEntries(valoper: string): Promise<number | null>;
  /** Sign and broadcast the staking plan under review (requires arm(true)). */
  confirmEvmStake(): Promise<{ txid: string; explorerUrl: string; chainKey: string }>;
  clearEvmStake(): void;
  /** Unlock the ACTIVE wallet. `password` is that wallet's own password on a v1
   *  vault and the APP password on a migrated one (ignored once the session
   *  holds the master key). `opts.migrate === false` declines the transitional
   *  move to the app password and leaves the wallet on v1. */
  unlock(password: string, opts?: { migrate?: boolean }): Promise<boolean>;
  lock(): void;

  // --- app password ---------------------------------------------------------
  /** Unlock the APP with the app password, then open the active wallet when it
   *  is already migrated (no second prompt) or show its own prompt when not. */
  unlockApp(password: string): Promise<boolean>;
  /** Set the app password for the first time. Migrates nothing. */
  setAppPassword(password: string): Promise<{ ok: boolean; error?: string }>;
  /** Change it: re-wrap every migrated wallet, then lock (the design's rule). */
  changeAppPassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }>;
  /** After the app password is accepted: open a migrated active wallet straight
   *  away, or fall through to its own transitional prompt when it is still v1. */
  openActiveWalletAfterAppUnlock(): Promise<void>;
  /** THE WAY OUT OF THE APP LOCK SCREEN (the app-password design notes §4 rule 5).
   *  Select a wallet that is still on its own password and show that wallet's
   *  own lock screen, so a forgotten app password never strands a wallet whose
   *  password still works. False when every wallet has already moved over. */
  openWithWalletPassword(): Promise<boolean>;
  /** Back to the app lock screen from a per-wallet one (the inverse route). It
   *  LOCKS: no seed and no master key are left behind that screen. */
  showAppLock(): void;

  // --- losing the app password (the app-password design notes §13) -------------
  /** Make a recovery code, replacing any existing one. The code comes back ONCE
   *  and is never retrievable again: show it, then let it go. */
  createRecoveryCode(appPassword: string): Promise<{ ok: true; code: string } | { ok: false; error: string }>;
  /** Drop the recovery code. Needs the app password, like making one. */
  removeRecoveryCode(appPassword: string): Promise<{ ok: boolean; error?: string }>;
  /** Open the app with the recovery code and set a new password in one act. */
  unlockWithRecoveryCode(code: string, newPassword: string): Promise<{ ok: boolean; error?: string }>;
  /** The whole store, encrypted under a password of the FILE's own. */
  exportBackup(filePassword: string): Promise<{ ok: true; text: string; fileName: string } | { ok: false; error: string }>;
  /** Open a backup file and describe what restoring it would do. Writes nothing. */
  readBackupFile(text: string, filePassword: string): Promise<{ ok: true; preview: BackupPreview } | { ok: false; error: string }>;
  /** Apply the backup that readBackupFile() decoded. */
  applyRestore(mode: 'replace' | 'merge'): Promise<{ ok: boolean; error?: string }>;
  /** Forget a decoded backup that was never confirmed. */
  cancelRestore(): void;

  // --- forced app-password setup (the app-password design notes §12) -----------
  /** The recovery phrase (seed) or private key (pk) of ONE wallet that opens
   *  with NO password, for the "back it up first" step of the forced setup. Null
   *  for any wallet that is not in exactly that state. Reveals nothing that is
   *  not already reachable today with nothing typed, and does NOT switch the
   *  wallet this page is on. */
  revealPasswordlessBackup(
    walletId: string,
  ): Promise<{ kind: 'seed' | 'pk'; secret: string } | null>;
  /** Set the app password from the FORCED setup screen and move every wallet
   *  that opens with no password onto it. Wallets with their own passwords are
   *  not touched: they migrate lazily, each asking its own password once.
   *  `migrated`/`kept` are wallet NAMES, for the summary the screen then shows. */
  completeForcedAppPassword(
    password: string,
  ): Promise<{ ok: boolean; error?: string; migrated: string[]; kept: string[] }>;
  /** Leave the forced setup screen once the password is set: open the active
   *  wallet, or fall through to its own prompt when it still has a password. */
  finishForcedAppPassword(): Promise<void>;
  /** Turn the ACTIVE wallet's "do not ask when sending" off or on (§6).
   *  Turning it ON switches off the pre-broadcast password check, so it costs
   *  the current app password; turning it off is free.
   *
   *  `{ok:false}` with no `error` means the app password given was wrong (the
   *  only thing the form can say about it); with an `error` it is a failure that
   *  is not about the password, and that string is what to show instead. */
  setNoSendPassword(
    enabled: boolean,
    password?: string,
  ): Promise<{ ok: boolean; error?: string }>;

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
  /** Gap-limit scan for receive addresses this seed has ALREADY used elsewhere,
   *  raising the wallet's address count to cover them (never lowering it) and
   *  refreshing balances when it found any. Requires an unlocked wallet; a 'pk'
   *  wallet is single-address and returns found:0. Never throws — failures land
   *  in addressScan.error and in the returned `error`. */
  scanForUsedAddresses(): Promise<{ ok: boolean; found?: number; error?: string }>;
  /** Add the next MetaMask-style account (next address index) on the ACTIVE,
   *  unlocked EVM seed wallet and switch to it without locking. */
  addEvmAccount(name?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** Find used accounts (balance or nonce on any configured EVM chain) on the
   *  active EVM seed and create the missing entries up to the highest used. */
  discoverEvmAccounts(): Promise<{ ok: boolean; added: number; error?: string }>;
  /** Dismiss the "found N accounts" notice. */
  clearEvmAccountScan(): void;
  /** Load (and lazily probe) the active chain's per-seed account visibility. */
  loadEvmAccountVisibility(): Promise<void>;
  refreshEvmAccountsOnChain(seedGroup: string, chainKey: string): Promise<void>;

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
  /**
   * Fetch ONE page of Activity older than what is already listed, and append
   * it (see `olderHistory`). One request per call, never two at once: the
   * gateway rate-limits a burst, and paging must not become one. A no-op on a
   * source that cannot go deeper, which is exactly what `canLoadOlder: false`
   * tells the UI to say instead of showing an empty page.
   */
  loadOlderActivity(): Promise<void>;
  /** Fetch live USD prices and merge them into `prices` (best-effort, never throws). */
  loadPrices(): Promise<void>;
  /** Fetch owner-authored notifications from the gateway (best-effort, never
   *  throws). No-op on a build with no gateway; throttled to NOTIF_REFRESH_MS
   *  unless `force` is set (Home mount forces); a failed fetch leaves the last
   *  list. */
  loadNotifications(opts?: { force?: boolean }): Promise<void>;
  /** Dismiss a notification: add its DISMISSAL KEY (`id@rev`, from
   *  services/notifications.ts dismissalKey) to the persisted set, so the banner
   *  moves on to the next matching notice (or hides). A bare id is accepted and
   *  read as revision 0, which is both what the old build stored and what a
   *  notice with no `rev` parses to. */
  dismissNotification(key: string): Promise<void>;
  startAutoRefresh(): void;
  stopAutoRefresh(): void;
  addAsset(name: string): Promise<{ ok: true } | { ok: false; error: string }>;
  removeAsset(name: string): void;
  /** Remove SEVERAL assets from the list in one action (the list's edit mode).
   *  Exactly what removeAsset does, in one write per storage key instead of one
   *  per name — removeAsset itself is a call to this with a single name, so the
   *  two can never drift apart. Protected assets in the list are ignored. */
  removeAssets(names: readonly string[]): void;
  /** Persist the user's manual row order for the ACTIVE wallet on the ACTIVE
   *  chain. `names` is the full non-native display order. */
  setAssetOrder(names: readonly string[]): void;
  /** Read the manual row order for the active wallet + chain into state. Called
   *  wherever either of those changes. */
  loadAssetOrder(): Promise<void>;
  /** Add an ERC-20 by CONTRACT ADDRESS on the active EVM chain: symbol and
   *  decimals are read from the chain (never trusted from the input), the token
   *  is tracked for this account and chain, and balances refresh. */
  addEvmToken(contractAddress: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Import EVERY ERC-20 the active account holds on the active EVM chain (via
   *  the provider's token index; needs a keyed provider, see `evm.chains[].alchemy`)
   *  as tracked tokens; the user removes what they do not want. Returns how
   *  many were added and how many the index listed without usable metadata. */
  importEvmTokens(opts?: {
    /** Only tokens with a Trust Wallet assets entry (a community-listed mark):
     *  airdrop/spam tokens have none. Their marks come along for free. */
    trustedOnly?: boolean;
  }): Promise<{ ok: true; added: number; skipped: number; untrusted: number } | { ok: false; error: string }>;
  /** Find tokens by name or symbol (or an address prefix) in the active EVM
   *  chain's public token list, for the Add token field. Purely a lookup: the
   *  caller adds a hit with addEvmToken(hit.address) like any pasted address. */
  searchEvmTokens(query: string): Promise<{ ok: true; results: TokenSearchHit[] } | { ok: false; error: string }>;
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
    /** The amount AS TYPED. Deliberately text, not a number: parsing it here
     *  with the chain's own `decimals` keeps the value off a float entirely,
     *  which is what the old parseFloat -> multiply path could not do. */
    amountText: string,
    to: string,
    assetId: string,
    feeRateSatPerByte?: bigint,
  ): Promise<LiveSendPlan | null>;
  estimateMaxEvr(
    feeRateSatPerByte?: bigint,
  ): Promise<{
    maxDecimal: number;
    feeDecimal: number;
    /** The same maximum as EXACT text, for putting straight into the amount
     *  field. maxDecimal is for arithmetic and display only. */
    maxText: string;
  }>;
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
  /** Change the ACTIVE wallet's own password. `{ok:false}` with no `error` means
   *  the current password was wrong (the only thing the form can say about it);
   *  with an `error` it is a failure that is NOT about the password, and that
   *  string is what the user must be shown instead. */
  changePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<{ ok: boolean; error?: string }>;
  setRequirePasswordToSend(on: boolean): void;
  setExplorerUrlTemplate(url: string): void;
  setAutoLockMinutes(minutes: number): void;
  setSettingsMode(mode: SettingsMode): void;
  /** Hide (or show again) the zero-balance rows on Home. Persisted globally. */
  setHideZeroBalances(hide: boolean): void;
  setHideBalances(hide: boolean): void;
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

/** Fresh (never-run) address-scan snapshot. Reset alongside `staking` on lock /
 *  switch / remove so one wallet's "found 3 addresses" never shows on another's. */
export interface EvmAccountScanState {
  scanning: boolean;
  added: number | null;
  error: string | null;
}

function emptyEvmAccountScan(): EvmAccountScanState {
  return { scanning: false, added: null, error: null };
}

function emptyAddressScan(): AddressScanState {
  return { scanning: false, scanned: 0, result: null, error: null };
}

// PRICES: every ticker (EVR, SATORIEVR, RVN, LTC, BTC, DOGE, the EVM natives,
// and whatever else the gateway is configured to publish) comes from ONE call
// in services/prices.ts. The LTC/BTC/DOGE CoinEx fetchers that used to live
// here went with it: a store build now talks to the Satori GO gateway like
// every other build, so there is no second price path to keep in step.

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

/** The EVM chain the ACTIVE EVM account is showing, from state (pure), or null
 *  for a UTXO wallet / a build without the engine. */
export function activeEvmChain(state: Pick<LiveState, 'evm'>): EvmChainInfo | null {
  const key = state.evm.activeChainKey;
  return key ? (state.evm.chains.find((c) => c.key === key) ?? null) : null;
}

/** One nonce tracker for the session (keyed by chain and account inside),
 *  created lazily through the flag-guarded modules on the first EVM send. */
let evmNonces: EvmNonceTracker | null = null;

/** eth_getCode answers, keyed `${chainKey}:${lowercased address}`. The send
 *  form asks on every recipient it sees, so without this a corrected typo
 *  re-asks the node for an address it already resolved. Only definitive
 *  answers are cached: a failure stays uncached so the next look retries.
 *  An address that HAS code keeps it forever (self-destruct was removed by
 *  EIP-6780), and an address that has none can only gain some through a
 *  deployment, which is not a change this wallet must catch mid-form. */
const evmCodeCache = new Map<string, boolean>();

export const useLiveStore = create<LiveState>((set, get) => ({
  // --- initial state --------------------------------------------------------
  phase: 'boot',
  appPasswordSet: false,
  appUnlocked: false,
  recoveryCodeSet: false,
  address: '',
  addresses: [],
  assets: [],
  pinnedAssets: [],
  hiddenAssets: [],
  assetOrder: [],
  txs: [],
  prices: {},
  priceChanges24h: {},
  priceTable: {},
  notifications: [],
  notificationsFetchedAt: 0,
  dismissedNotificationKeys: [],
  unreadActivity: 0,
  activitySeen: emptyActivitySeen(),
  historyIssue: null,
  historyLoading: false,
  olderHistory: emptyOlderHistory(),
  stakingEvents: [],
  network: null,
  evm: { chains: [], activeChainKey: null },
  evmTokens: { tracked: [], discovered: [] },
  evmSend: null,
  loadingEvmSend: false,
  evmStaking: { snapshot: null, loading: false, plan: null, planning: false },
  wallets: [],
  activeWalletId: null,
  addingWallet: false,
  requirePasswordToSend: true,
  explorerUrlTemplate: DEFAULT_EXPLORER_URL,
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  settingsMode: 'basic',
  hideZeroBalances: false,
  hideBalances: false,
  hiddenChains: [],
  notifyDeposits: true,
  electrumServers: [...DEFAULT_ELECTRUM_SERVER_URLS],
  serverStatus: {},
  addressBook: [],
  connectedSites: [],
  pendingMnemonic: null,
  pendingMnemonicHasPassphrase: false,
  sendPlan: null,
  staking: {
    pools: [],
    addressStatuses: [],
    loading: false,
    submitting: false,
    error: null,
    loaded: false,
  },
  addressScan: emptyAddressScan(),
  evmAccountScan: emptyEvmAccountScan(),
  evmAccountsOnChain: {},
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
    // The EVM chains this build carries (an empty list without --evm). Loaded
    // once here so every screen can key its EVM affordances off state and never
    // import the registry directly.
    void loadEvmChainInfos().then((chains) => {
      evmChainInfos = chains;
      set((s) => ({ evm: { ...s.evm, chains } }));
    });
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
      storedHideZeroBalances,
      storedHideBalances,
      storedDismissedNotifs,
    ] = await Promise.all([
      readValue<boolean>(REQUIRE_PW_KEY),
      readValue<string>(EXPLORER_URL_KEY),
      readValue<number>(AUTO_LOCK_MINUTES_KEY),
      readValue<boolean>(NOTIFY_DEPOSITS_KEY),
      readList(ELECTRUM_SERVERS_STORAGE_KEY),
      readAddressBook(),
      readValue<string>(SETTINGS_MODE_KEY),
      readList(HIDDEN_CHAINS_KEY),
      readValue<boolean>(HIDE_ZERO_BALANCES_KEY),
      readValue<boolean>(HIDE_BALANCES_KEY),
      readList(NOTIF_DISMISSED_KEY),
    ]);
    set({
      addressBook,
      // Default TRUE — require the password before sending unless explicitly disabled.
      requirePasswordToSend: typeof storedRequirePw === 'boolean' ? storedRequirePw : true,
      // Default BASIC: the expert sections (servers, diagnostics, raw addresses)
      // are the ones where a wrong move costs something, so they are opt-in.
      settingsMode: storedSettingsMode === 'expert' ? 'expert' : 'basic',
      // Default FALSE — nothing is hidden until the user asks for it. A wallet
      // that quietly drops rows on first run would be lying about what it holds.
      hideZeroBalances: storedHideZeroBalances === true,
      hideBalances: storedHideBalances === true,
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
      // Notifications the user has already dismissed (global across wallets).
      // MIGRATED on read: a bare id written by a build from before revisions
      // existed becomes `id@0`, so an upgrade does not bring every closed notice
      // back. The migrated shape is written back on the next dismissal.
      dismissedNotificationKeys: migrateDismissedKeys(storedDismissedNotifs),
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
      // Is there an app password, and does this session already hold its key?
      // FALSE on every install that never set one, and then nothing below this
      // line differs from what it has always done.
      const appPasswordSet = await svc.hasAppPassword();
      set({
        appPasswordSet,
        appUnlocked: svc.appUnlocked(),
        recoveryCodeSet: appPasswordSet && (await svc.hasRecoveryCode()),
      });
      // Does this device still have a wallet that opens with NO password, and no
      // app password to protect it with (the app-password design notes §12)? False
      // on every install that has neither, and then nothing below this line
      // differs from what it has always done.
      const forceAppPassword = exists && (await svc.appPasswordRequired());
      if (!exists) {
        set({ phase: 'onboarding' });
      } else if (forceAppPassword) {
        // BEFORE every other branch, deliberately, including `svc.isUnlocked()`:
        // a page whose service already holds a seed from earlier in its own
        // session must not walk past the screen either. This is the ONLY place
        // the phase is entered, and the only way out of it is setting the
        // password, so "closed the window" means "asked again at the next
        // launch", which is what forced has to mean.
        set({ phase: 'force-app-password' });
      } else if (svc.isUnlocked()) {
        // Wallet was already unlocked in this session (re-open).
        const address = svc.getAddress(0);
        set({ phase: 'ready', address });
        await get().loadAddresses();
        await get().refresh();
      } else if (appPasswordSet && !svc.appUnlocked()) {
        // §5: the app password gates the application; choosing a wallet comes
        // after it. Nothing about any individual wallet is decided here.
        set({ phase: 'app-locked' });
      } else if (appPasswordSet) {
        // The app is already open in this session (the popup was re-created but
        // the service instance survived): go straight to the per-wallet step.
        await get().openActiveWalletAfterAppUnlock();
      } else {
        // A passwordless active wallet has no password to ask for — auto-unlock
        // it with the empty passphrase and go straight to the ready wallet
        // instead of showing a lock screen.
        //
        // NARROW NOW, AND DELIBERATELY KEPT. Reaching here with a passwordless
        // wallet means the forced-setup branch above declined, which happens
        // only in the one damaged state where an app password CANNOT be set
        // (§12). Opening the wallet as it has always opened is the right answer
        // there: the alternative is a lock screen for a password that does not
        // exist, which is the brick this whole flow is written to avoid.
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
  async createWallet(
    password: string,
    name?: string,
    network: LiveNetworkId | EvmChainTarget = 'mainnet',
    passphrase = '',
  ) {
    set({ error: null });
    try {
      const evmKey = evmChainKeyOf(network);
      const { mnemonic } = await svc.create(password, {
        network: evmKey !== null ? 'mainnet' : (network as LiveNetworkId),
        ...(evmKey !== null ? { family: 'evm' as const, evmChainKey: evmKey } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
        // Spread rather than always-present, so a create WITHOUT a passphrase
        // hands the service the exact same options object it got before this
        // existed. The service treats absent and '' identically; this keeps the
        // no-passphrase path provably untouched instead of merely equivalent.
        ...(passphrase ? { passphrase } : {}),
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
        pendingMnemonicHasPassphrase: !!passphrase,
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
    set({ pendingMnemonic: null, pendingMnemonicHasPassphrase: false, phase: 'ready' });
  },

  // --- import ---------------------------------------------------------------
  async importWallet(
    mnemonic: string,
    password: string,
    name?: string,
    network: LiveNetworkId | EvmChainTarget = 'mainnet',
    passphrase = '',
  ) {
    set({ error: null });
    try {
      const evmKey = evmChainKeyOf(network);
      await svc.import(
        mnemonic,
        password,
        evmKey !== null ? 'mainnet' : (network as LiveNetworkId),
        name?.trim() || undefined,
        passphrase,
        evmKey !== null ? { family: 'evm', evmChainKey: evmKey } : undefined,
      );
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
        addressScan: emptyAddressScan(),
        // Staking figures belong to the account that was active a moment ago,
        // exactly like the balances cleared above. Home now shows a staked
        // total under the hero, so a leftover snapshot here would print another
        // account's stake under this one's balance.
        evmStaking: { snapshot: null, loading: false, plan: null, planning: false },
      });
      void get().loadWallets();
      void get().loadWalletAssets();
      // IMPORT is the one moment a gap-limit scan is worth its cost: the seed
      // may already have been used in another wallet, on addresses this one has
      // never derived, which is exactly the "my imported wallet shows a smaller
      // balance than I expect" case. Deliberately NOT run on unlock or on every
      // refresh (up to GAP_LIMIT+ sequential round-trips, and several of these
      // chains run on small volunteer servers), and NOT on create either: a
      // freshly generated seed has no history anywhere to find.
      //
      // Fire-and-forget and AFTER the first balance refresh, so the common case
      // (funds on the primary address) paints immediately and the scan only ever
      // adds to what is already on screen. scanForUsedAddresses never throws.
      void get()
        .loadAddresses()
        .then(() => get().refresh())
        // An EVM account is ONE address, so there is no gap to scan -- but the
        // same words may already carry Account 2, 3, ... in MetaMask, which is
        // the EVM shape of the exact same "my imported wallet is missing funds"
        // problem. One batched probe per chain, on import only, for the same
        // reason (the EVM accounts design notes).
        .then(() => (evmKey !== null ? get().discoverEvmAccounts() : get().scanForUsedAddresses()));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err; // re-throw so the UI form can detect failure
    }
  },

  // --- import a single private key (Satori-style single-address wallet) ------
  async importPrivateKeyWallet(
    input: string,
    password: string,
    name?: string,
    network: LiveNetworkId | EvmChainTarget = 'mainnet',
  ) {
    set({ error: null });
    try {
      // A single WIF/hex key becomes a one-address 'pk' wallet (how Satori-network
      // wallets are generated). An empty password makes it passwordless. A raw
      // hex key on an `evm:<key>` target becomes a single-address EVM account.
      const evmKey = evmChainKeyOf(network);
      await svc.importPrivateKey(
        input.trim(),
        password,
        evmKey !== null ? 'mainnet' : (network as LiveNetworkId),
        name?.trim() || undefined,
        evmKey !== null ? { family: 'evm', evmChainKey: evmKey } : undefined,
      );
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
        // The number comes from the constant, so the copy cannot go stale the
        // next time the cap moves.
        return {
          ok: false,
          error: `Address limit reached. This wallet already has ${MAX_RECEIVE_ADDRESSES} addresses.`,
        };
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

  async scanForUsedAddresses() {
    // One scan at a time: it is up to a hundred sequential round-trips, and two
    // in parallel would double that load on servers that are often one
    // volunteer's machine, for no extra information.
    if (get().addressScan.scanning) {
      return { ok: false, error: 'A scan is already running.' };
    }
    set({ addressScan: { scanning: true, scanned: 0, result: null, error: null } });
    try {
      const res = await svc.discoverUsedAddresses({
        onProgress: ({ scanned }) => {
          set((s) => ({ addressScan: { ...s.addressScan, scanned } }));
        },
      });
      const found = Math.max(0, res.addressCountAfter - res.addressCountBefore);
      set({
        addressScan: {
          scanning: false,
          scanned: res.scanned,
          result: {
            found,
            addressCount: res.addressCountAfter,
            complete: res.complete,
            failedReads: res.failedReads,
          },
          error: null,
        },
      });
      if (found > 0) {
        // Only when the address set actually GREW is there anything new to
        // fetch: a scan that found nothing leaves the wallet deriving exactly
        // the addresses it already had, so a refresh here would be pure load.
        await get().loadAddresses();
        void get().refresh();
      }
      return { ok: true, found };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const error =
        msg === 'Live wallet is locked'
          ? 'Unlock this wallet before scanning.'
          : msg === 'no-active-wallet'
            ? 'No wallet is active.'
            : msg;
      set((s) => ({ addressScan: { ...s.addressScan, scanning: false, error } }));
      return { ok: false, error };
    }
  },

  // --- unlock ---------------------------------------------------------------
  async unlock(password: string, opts?: { migrate?: boolean }) {
    set({ error: null });
    try {
      const ok = await svc.unlock(password, opts);
      if (ok) {
        const address = svc.getAddress(0);
        set({
          // Unlocking a v1 wallet with an app password set may have just derived
          // the master key from it (a fresh session), so re-read both flags.
          appUnlocked: svc.appUnlocked(),
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
    // This is the USER-FACING lock (the header lock button, the idle auto-lock),
    // so it drops the app master key too — leaving it would let the app lock
    // screen be walked straight past. A wallet SWITCH takes svc.lock() instead,
    // which deliberately keeps the master key so a migrated wallet opens without
    // asking again.
    svc.lockApp();
    set({
      appUnlocked: false,
      phase: get().appPasswordSet ? 'app-locked' : 'locked',
      address: '',
      addresses: [],
      assets: [],
      // Clear the previous wallet's curated tokens so nothing leaks on-screen.
      pinnedAssets: [],
      hiddenAssets: [],
      assetOrder: [],
      txs: [],
      activitySeen: emptyActivitySeen(),
      unreadActivity: 0,
      historyIssue: null,
      historyLoading: false,
      olderHistory: emptyOlderHistory(),
      network: null,
      sendPlan: null,
      evmSend: null,
      evmStaking: { snapshot: null, loading: false, plan: null, planning: false },
      evmTokens: { tracked: [], discovered: [] },
      error: null,
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      staking: emptyStaking(),
      addressScan: emptyAddressScan(),
    });
  },

  // --- multi-wallet ---------------------------------------------------------
  async loadWallets() {
    try {
      const wallets = await svc.listWallets();
      const active = wallets.find((w) => w.id === svc.activeWalletId());
      set((s) => ({
        wallets,
        activeWalletId: svc.activeWalletId(),
        // The chain the active EVM account is showing follows the wallet list.
        evm: { ...s.evm, activeChainKey: active && walletFamily(active) === 'evm' ? (active.evmChainKey ?? null) : null },
      }));
      // The active chain may have just changed (init / switch / unlock / create /
      // import / remove all route through here). Load THIS chain's own server pool
      // + explorer template (per-chain storage keys; Evrmore uses the legacy keys)
      // and apply the pool to the network module so the next connect uses it.
      const chainId = activeChainId();
      // Per-chain account visibility follows the wallet list (init, switch,
      // unlock, chain switch all route through here). Detached: it may probe.
      void get().loadEvmAccountVisibility();
      // The explorer follows the active TARGET (an EVM chain has its own); the
      // Electrum pool is UTXO-only and follows the last UTXO chain.
      const explorerChain = activeChainTarget();
      const [servers, explorer] = await Promise.all([
        readList(electrumServersStorageKey(chainId)),
        readValue<string>(explorerKeyForChain(explorerChain)),
      ]);
      // A pool persisted BEFORE this build has a gateway would have no bridge in
      // it, which would quietly leave that chain talking to the public nodes
      // direct. withGatewayBridgeUrls re-asserts it at the head (a no-op in a
      // build with no gateway, and on the chains that have no bridge), keeping
      // the user's own servers after it as extra fallbacks.
      const serverUrls = withGatewayBridgeUrls(
        servers.length > 0 ? servers : defaultServerUrlsFor(chainId),
        chainId,
      );
      activateServerUrls(serverUrls, chainId);
      set({
        electrumServers: serverUrls,
        explorerUrlTemplate:
          typeof explorer === 'string' && explorer.trim() ? explorer : defaultExplorerFor(explorerChain),
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
      } catch (err) {
        // An unknown id means the wallet is already gone from the list the user
        // clicked, and there is nothing to say. A write that could not land is
        // the switch NOT HAVING HAPPENED, which this used to leave looking like
        // it had, on a screen that then belonged to the other wallet.
        if (isStoreWriteFailed(err)) set({ error: err.message });
        return;
      }
      get().stopAutoRefresh();
      txSyncRun = null;
      // TWO ACCOUNTS OF ONE SEED (the EVM accounts design notes): the service kept
      // the words in memory because the target account decrypts with the very
      // password this session already used. So there is nothing to unlock, and
      // the switch lands on `ready` with the new account's address instead of on
      // a lock screen. Everything else below still resets: every piece of it
      // belongs to the account being left.
      let keptUnlocked = svc.isUnlocked();
      let address = '';
      if (keptUnlocked) {
        try {
          address = svc.getAddress(0);
        } catch {
          // Cannot derive the target account's address: lock rather than show a
          // ready wallet with no address on it.
          svc.lock();
          keptUnlocked = false;
        }
      }
      set({
        phase: keptUnlocked ? 'ready' : 'locked',
        // A wallet SWITCH keeps the master key on purpose (§5: choosing another
        // migrated wallet must not ask again), so 'locked' here can mean "the
        // app is still open". Report that honestly: LiveApp's idle auto-lock and
        // LiveLock's Lock button both read this flag, and a stale `false` is
        // what left the master key sitting behind a lock screen with no timer
        // running and no way to lock it.
        appUnlocked: svc.appUnlocked(),
        address,
        addresses: keptUnlocked ? [{ index: 0, address }] : [],
        assets: [],
        txs: [],
        // The badge and any history warning belong to the wallet being left.
        activitySeen: emptyActivitySeen(),
        unreadActivity: 0,
        historyIssue: null,
        historyLoading: false,
        olderHistory: emptyOlderHistory(),
        stakingEvents: [],
        network: null,
        sendPlan: null,
        evmSend: null,
        // Staking is per account AND per chain, exactly like the token lists.
        evmStaking: { snapshot: null, loading: false, plan: null, planning: false },
        // Token lists are per wallet AND per chain; loadWalletAssets below reads
        // the new account's own, so the old account's must not show meanwhile.
        evmTokens: { tracked: [], discovered: [] },
        // Same reasoning for the manual row order (loadWalletAssets reads it).
        assetOrder: [],
        pendingMnemonic: null,
        pendingMnemonicHasPassphrase: false,
        addingWallet: false,
        error: null,
        syncProgress: null,
        lastSyncAt: null,
        staking: emptyStaking(),
        addressScan: emptyAddressScan(),
      });
      await get().loadWallets();
      // Load the newly-active wallet's OWN token lists (isolated per wallet).
      await get().loadWalletAssets();
      if (keptUnlocked) {
        await get().loadAddresses();
        void get().refresh();
        return;
      }
      // A passwordless wallet needs no password — auto-unlock it (skip the lock
      // screen) so switching to it lands straight on its ready home.
      // A MIGRATED wallet is the same case for a different reason: the session
      // still holds the master key (svc.lock() keeps it), so its own vault opens
      // with nothing typed. §5: "wallet already migrated -> opens, no second
      // prompt". A wallet still on v1 falls through to the lock screen, which
      // shows the transitional prompt.
      const active = get().wallets.find((w) => w.id === get().activeWalletId);
      if (active?.appProtected && svc.appUnlocked()) {
        await get().unlock('');
      } else if (active?.passwordless && !get().appPasswordSet) {
        // ...but ONLY while there is no app password. Once there is one, opening
        // this wallet is what moves it to the app key, and §6 requires the user
        // to be told and allowed to decline. Falling through to the lock screen
        // is what shows them that prompt. Caught by the live smoke, which found
        // this branch migrating a passwordless wallet silently on a switch.
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
    const evmKey = evmChainKeyOf(chainId);
    if (evmKey !== null) {
      // An EVM chain: stay on the active EVM account (one address on every
      // chain) and only change what it shows; otherwise land on the EVM
      // account derived from the active seed, then point it at the chain.
      if (get().wallets.length === 0) await get().loadWallets();
      if (activeFamily() === 'evm') {
        await get().switchEvmChain(evmKey);
        return;
      }
      const target = walletOnChain(get().wallets, chainId);
      if (!target) return; // enableChain's job (needs the password)
      await get().switchWallet(target.id);
      if (get().activeWalletId === target.id && svc.evmChainKey() !== evmKey) {
        await get().switchEvmChain(evmKey);
      }
      return;
    }
    // Already on this chain: nothing to do. Canonical compare, so the legacy
    // 'mainnet' alias and 'evrmore-mainnet' are correctly seen as one chain.
    // Family first: for an active EVM account activeChainId() names an idle
    // UTXO chain, which must not read as "already there".
    if (activeFamily() === 'utxo' && sameChain(activeChainId(), chainId)) return;
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

  // --- EVM chain within the active account ------------------------------------
  async switchEvmChain(key: string) {
    if (activeFamily() !== 'evm') return;
    if (svc.evmChainKey() === key) return;
    if (!get().evm.chains.some((c) => c.key === key)) return;
    try {
      await svc.setEvmChainKey(key);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Same address, different chain: balances and the send under review belong
    // to the old chain and go; the address and the wallet list stay.
    set((s) => ({
      evm: { ...s.evm, activeChainKey: key },
      assets: [],
      txs: [],
      historyIssue: null,
      olderHistory: emptyOlderHistory(),
      unreadActivity: 0,
      network: null,
      evmSend: null,
      evmStaking: { snapshot: null, loading: false, plan: null, planning: false },
      // The manual row order belongs to the chain being left; the new chain's
      // own is read below. Cleared first so the old arrangement cannot briefly
      // reorder the new chain's rows.
      assetOrder: [],
      error: null,
    }));
    svc.allowBroadcast = false;
    await get().loadWallets();
    await get().loadAssetOrder();
    await get().loadEvmTokens();
    await get().refresh();
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

    const targetInfo = describeChain(chainId, get().evm.chains);
    if (!targetInfo) return { ok: false, error: 'This build does not carry that chain.' };
    // Fail CLOSED when the chain is already enabled: deriving again would create
    // a second entry with an identical address (same secret, same chain), which
    // the user never asked for. Switching there is switchChain's job. For an
    // EVM target ANY existing EVM account already covers it (one address on
    // every EVM chain).
    if (walletOnChain(wallets, chainId)) {
      return {
        ok: false,
        error:
          targetInfo.family === 'evm'
            ? 'You already have an EVM account; it works on every EVM chain.'
            : `You already have a wallet on ${targetInfo.displayName}.`,
      };
    }

    // A passwordless wallet's vault is keyed by the EMPTY passphrase, and its
    // derived sibling must stay passwordless too — so the vault password is a
    // property of the source wallet, not of whatever the caller passed in.
    const pw = active.passwordless ? '' : password;
    // An EVM account is tagged with the family, not a chain: it spans them all.
    const name = `${baseWalletName(active)} (${targetInfo.family === 'evm' ? 'EVM' : targetInfo.displayName})`;

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
        await get().importPrivateKeyWallet(secret, pw, name, chainId as LiveNetworkId | EvmChainTarget);
      } else {
        await get().importWallet(secret, pw, name, chainId as LiveNetworkId | EvmChainTarget, seedPassphrase);
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

  // --- EVM accounts on one seed (the EVM accounts design notes) ----------------

  // Add the next account of the active seed and land on it. The switch runs
  // through switchWallet on purpose: the service has already made the new entry
  // active WITHOUT locking, so switchWallet takes its kept-unlocked branch and
  // the on-screen reset is byte-for-byte the one a same-seed switch does. One
  // path, one behaviour, one set of tests.
  async addEvmAccount(name?: string) {
    try {
      const chainKey = svc.evmChainKey();
      const active = get().wallets.find((w) => w.id === get().activeWalletId);
      const group = active?.seedGroup;
      // "Add account" on a chain where some of this seed's accounts are not
      // yet SHOWN surfaces the lowest hidden one (same entry, same address as
      // on the other chains) instead of minting a new index; only when every
      // existing account is already on this chain does a new index get made.
      if (chainKey && group) {
        const seen = get().evmAccountsOnChain[group];
        if (seen !== undefined) {
          const hidden = get()
            .wallets.filter((w) => w.seedGroup === group && (w.hdIndex ?? 0) !== 0 && !seen.includes(w.hdIndex ?? 0))
            .sort((a, b) => (a.hdIndex ?? 0) - (b.hdIndex ?? 0));
          if (hidden.length > 0) {
            const target = hidden[0];
            const next = [...seen, target.hdIndex ?? 0].sort((a, b) => a - b);
            persistValue(evmSeenKey(group, chainKey), next);
            set((s) => ({ evmAccountsOnChain: { ...s.evmAccountsOnChain, [group]: next } }));
            await get().switchWallet(target.id);
            return { ok: true as const, id: target.id };
          }
        }
      }
      const { id } = await svc.addEvmAccount(name);
      if (chainKey && group) {
        const created = (await svc.listWallets()).find((w) => w.id === id);
        const idx = created?.hdIndex ?? 0;
        const seen = get().evmAccountsOnChain[group] ?? [];
        if (!seen.includes(idx)) {
          const next = [...seen, idx].sort((a, b) => a - b);
          persistValue(evmSeenKey(group, chainKey), next);
          set((s) => ({ evmAccountsOnChain: { ...s.evmAccountsOnChain, [group]: next } }));
        }
      }
      await get().switchWallet(id);
      return { ok: true as const, id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const error =
        msg === 'locked'
          ? 'Unlock this wallet before adding an account.'
          : msg === 'not-evm-seed'
            ? 'Accounts can only be added to a wallet made from a recovery phrase on an EVM chain.'
            : msg;
      set({ error });
      return { ok: false as const, error };
    }
  },

  // Ask every configured EVM chain which of this seed's next accounts are
  // already in use, and create the entries for the ones that are. The verdict
  // rule and the merge live in the engine (evm/accountDiscovery.ts) so they can
  // be tested against fixed answers; this action only supplies one batch
  // function per chain and reports the outcome.
  async discoverEvmAccounts() {
    if (get().evmAccountScan.scanning) {
      return { ok: false, added: 0, error: 'A scan is already running.' };
    }
    if (activeFamily() !== 'evm') {
      return { ok: false, added: 0, error: 'This is not an EVM wallet.' };
    }
    const evm = await loadEvmModules();
    if (!evm) return { ok: false, added: 0, error: 'This build has no EVM engine.' };
    const chains = get().evm.chains;
    set({ evmAccountScan: { scanning: true, added: null, error: null } });
    // Set by the probe when NO chain answered: the difference between "these
    // accounts are unused" and "nothing could be read" is the whole point.
    let unreachable = false;
    // Per-chain verdicts, recorded as that chain's visibility set (index 0 is
    // always in): the switcher on BNB Chain then lists the accounts used on
    // BNB Chain, not every account the seed has anywhere.
    const group = get().wallets.find((w) => w.id === get().activeWalletId)?.seedGroup ?? null;
    const probe = async (addresses: string[]): Promise<boolean[]> => {
      const providers = await Promise.all(chains.map((c) => evmProviderFor(c.key)));
      // One chain at a time, with a short gap: every chain is one 40-item
      // batch, and through the gateway they all come from ONE client IP, so
      // four chains at once tripped the per-IP burst limiter (and Alchemy's
      // compute-units-per-second) and reported "could not reach any network".
      // Sequential costs ~1 s more on import and stays under both limits.
      const perChain: Array<Awaited<ReturnType<typeof evm.probeEvmAccountsUsed>> | null> = [];
      for (let i = 0; i < chains.length; i++) {
        const p = providers[i];
        if (!p) {
          perChain.push(null);
          continue;
        }
        if (i > 0) await new Promise((r) => setTimeout(r, 350));
        perChain.push(await evm.probeEvmAccountsUsed(addresses, [(calls) => p.rpc.batch(calls)]));
      }
      if (group) {
        chains.forEach((c, i) => {
          const outcome = perChain[i];
          if (!outcome || !outcome.answered) return;
          // Probe address k is hdIndex k+1 (discovery scans 1..MAX).
          const seen = outcome.used.flatMap((u, k) => (u ? [k + 1] : []));
          const withMain = [0, ...seen];
          persistValue(evmSeenKey(group, c.key), withMain);
          if (activeFamily() === 'evm' && svc.evmChainKey() === c.key) {
            set((s) => ({ evmAccountsOnChain: { ...s.evmAccountsOnChain, [group]: withMain } }));
          }
        });
      }
      const answered = perChain.filter((o): o is NonNullable<typeof o> => o !== null && o.answered);
      unreachable = answered.length === 0;
      const used = addresses.map((_, k) => answered.some((o) => o.used[k]));
      return used;
    };
    try {
      const { added } = await svc.discoverEvmAccounts(probe);
      if (unreachable) {
        const error = 'Could not reach any EVM network to look for accounts.';
        set({ evmAccountScan: { scanning: false, added: null, error } });
        return { ok: false, added: 0, error };
      }
      set({ evmAccountScan: { scanning: false, added, error: null } });
      // New entries are new wallets in the list; the active account is unchanged.
      if (added > 0) await get().loadWallets();
      return { ok: true, added };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const error =
        msg === 'locked'
          ? 'Unlock this wallet before looking for accounts.'
          : msg === 'not-evm-seed'
            ? 'Only a wallet made from a recovery phrase on an EVM chain has accounts to find.'
            : msg;
      set({ evmAccountScan: { scanning: false, added: null, error } });
      return { ok: false, added: 0, error };
    }
  },

  async loadEvmAccountVisibility() {
    // UTXO chain (or no wallets): nothing to scope; clear the map.
    const chainKey = activeFamily() === 'evm' ? svc.evmChainKey() : null;
    if (!chainKey) {
      if (Object.keys(get().evmAccountsOnChain).length > 0) set({ evmAccountsOnChain: {} });
      return;
    }
    const groups = [...new Set(get().wallets.filter((w) => w.seedGroup).map((w) => w.seedGroup as string))];
    const next: Record<string, number[] | undefined> = {};
    await Promise.all(
      groups.map(async (g) => {
        const v = await readValue<number[]>(evmSeenKey(g, chainKey));
        next[g] = Array.isArray(v) && v.every((n) => typeof n === 'number') ? v : undefined;
      }),
    );
    if (svc.evmChainKey() !== chainKey) return;
    set({ evmAccountsOnChain: next });
    // A group with no record yet: ask THIS chain which of the existing
    // accounts are used (balance or nonce), once, in the background. Until it
    // answers everything shows (no data is not evidence of absence).
    for (const g of groups) {
      if (next[g] === undefined) void get().refreshEvmAccountsOnChain(g, chainKey);
    }
  },

  /** Probe the given chain for which EXISTING accounts of `seedGroup` are used
   *  there, and persist the answer. Creates no entries; display data only. */
  async refreshEvmAccountsOnChain(seedGroup: string, chainKey: string) {
    const evm = await loadEvmModules();
    if (!evm) return;
    const members = get()
      .wallets.filter((w) => w.seedGroup === seedGroup && w.address)
      .sort((a, b) => (a.hdIndex ?? 0) - (b.hdIndex ?? 0));
    if (members.length === 0) return;
    const provider = await evmProviderFor(chainKey);
    if (!provider) return;
    const outcome = await evm.probeEvmAccountsUsed(
      members.map((w) => w.address),
      [(calls) => provider.rpc.batch(calls)],
    );
    // An unanswered probe records NOTHING: better to keep showing everything
    // than to hide accounts because a node was down.
    if (!outcome.answered) return;
    const seen = members.filter((_, i) => outcome.used[i]).map((w) => w.hdIndex ?? 0);
    if (!seen.includes(0)) seen.unshift(0);
    seen.sort((a, b) => a - b);
    persistValue(evmSeenKey(seedGroup, chainKey), seen);
    if (activeFamily() === 'evm' && svc.evmChainKey() === chainKey) {
      set((s) => ({ evmAccountsOnChain: { ...s.evmAccountsOnChain, [seedGroup]: seen } }));
    }
  },

  clearEvmAccountScan() {
    set({ evmAccountScan: emptyEvmAccountScan() });
  },

  // Show the onboarding flow in "add" mode over the still-unlocked active wallet.
  addWalletStart() {
    set({ addingWallet: true, phase: 'onboarding', pendingMnemonic: null, pendingMnemonicHasPassphrase: false, error: null });
  },

  // Abandon the add-wallet flow and return to the (still-unlocked) active wallet.
  cancelAddWallet() {
    set({
      addingWallet: false,
      pendingMnemonic: null,
      pendingMnemonicHasPassphrase: false,
      error: null,
      phase: svc.isUnlocked() ? 'ready' : 'locked',
    });
  },

  async renameWallet(id: string, name: string) {
    try {
      await svc.renameWallet(id, name);
    } catch (err) {
      // An invalid id or an empty name genuinely keeps the old name, and saying
      // so would be noise. A write that could not land is different: the rename
      // did not happen, and this used to report it as done.
      if (isStoreWriteFailed(err)) set({ error: err.message });
      // else ignore — invalid id / empty name keeps the old name
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
    } catch (err) {
      // An unknown id is a no-op and there is nothing to say. A write that could
      // not land means THE WALLET IS STILL THERE, so everything below is wrong
      // for it: it reported the removal as done and then reclaimed the caches of
      // a wallet that still exists (caches only, rebuilt on the next sync, but
      // it is still work thrown away for something that did not happen).
      if (isStoreWriteFailed(err)) {
        set({ error: err.message });
        await get().loadWallets();
        return;
      }
      // else ignore — unknown id is a no-op
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
        // The saved balance rows for those addresses go with them. Swept by
        // address on every chain: one EVM account is the same address on all of
        // them, so a per-chain sweep would leave entries behind.
        await clearBalanceCaches(addresses);
      }
    }

    // Removing the LAST wallet returns to onboarding (nothing left to unlock).
    if (wallets.length === 0) {
      get().stopAutoRefresh();
      txSyncRun = null;
      set({
        phase: 'onboarding',
        // The service dropped the app-password record with the last wallet (an
        // app password with no wallets to open is only a lock on the next
        // wallet the user creates), so the UI must stop believing in one.
        appPasswordSet: false,
        appUnlocked: false,
        wallets: [],
        activeWalletId: null,
        address: '',
        addresses: [],
        assets: [],
        txs: [],
        activitySeen: emptyActivitySeen(),
        unreadActivity: 0,
        historyIssue: null,
        historyLoading: false,
        olderHistory: emptyOlderHistory(),
        stakingEvents: [],
        network: null,
        sendPlan: null,
        pendingMnemonic: null,
        pendingMnemonicHasPassphrase: false,
        addingWallet: false,
        error: null,
        syncing: 'idle',
        syncProgress: null,
        lastSyncAt: null,
        staking: emptyStaking(),
        addressScan: emptyAddressScan(),
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
        historyLoading: false,
        olderHistory: emptyOlderHistory(),
        stakingEvents: [],
        network: null,
        sendPlan: null,
        pendingMnemonic: null,
        pendingMnemonicHasPassphrase: false,
        error: null,
        syncing: 'idle',
        syncProgress: null,
        lastSyncAt: null,
        staking: emptyStaking(),
        addressScan: emptyAddressScan(),
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

    // LAST KNOWN BALANCES FIRST (owner, 2026-08-25: "not all the tokens that
    // were there always load, sometimes only the one main coin"). The popup is
    // a fresh page every time it opens, so `assets` starts EMPTY and every
    // "keep what we had" fallback below was keeping nothing on the first read
    // of a session: one 429 from the gateway and the list collapsed to the
    // single synthesized native row. The saved rows are put on screen before
    // the network is asked, exactly as the tx cache already does for Activity,
    // so a failed read now leaves the tokens where they were.
    //
    // `balanceCacheChain` doubles as the CHAIN half of the staleness guard
    // below. Every commit in this function used to check the address alone,
    // which is enough on UTXO (a chain switch there switches wallets) but not
    // on EVM: one EVM account is the SAME address on every chain, so a read
    // still in flight when the user switched chains passed the address check
    // and landed the old chain's balances on the new chain's screen.
    const balanceCacheChain = activeChainTarget();
    const stillCurrent = () => get().address === address && activeChainTarget() === balanceCacheChain;
    if (get().assets.length === 0) {
      void loadBalanceCache(balanceCacheChain, address).then((cached) => {
        if (!cached) return;
        // Only while nothing better has landed: a read that finished first
        // must never be overwritten by the cache behind it.
        if (!stillCurrent() || get().assets.length > 0) return;
        set({ assets: cached.rows });
      });
    }

    // FAMILY FIRST. An EVM account is one address across every EVM chain and is
    // read over JSON-RPC (src/store/evmBalances.ts), never over Electrum: none
    // of the UTXO machinery below (address scan, UTXO balances, tx cache) has a
    // meaning for it. Absent family = utxo, so every existing wallet takes the
    // path it always took. History for EVM arrives in phase 4; until then an
    // EVM refresh is balances + network status only, and `txs` is left alone.
    // Asked of the SERVICE, not of `wallets` in state: the summaries load
    // asynchronously and a refresh fired right after create/import/unlock must
    // not race them into the UTXO path.
    if (activeFamily() === 'evm') {
      const chainKey = svc.evmChainKey() ?? undefined;
      const { tracked, discovered } = get().evmTokens;
      // The main read: native + default + user-tracked tokens (a short list).
      // Discovered tokens are read afterwards, best-effort and chunked.
      const result = await refreshEvmWallet(address, chainKey, tracked);
      // A wallet OR chain switch mid-flight must not clobber the new state
      // (see stillCurrent above: the address alone cannot tell EVM chains
      // apart, because the account is the same address on all of them).
      if (!stillCurrent()) return;
      if (!result) {
        // This build carries no EVM engine (flag off): the account cannot be
        // read here. Offline is the honest state; nothing else is touched.
        set({ loadingRefresh: false, offline: true });
        return;
      }
      const ok = result.network.state !== 'offline' && result.assets !== null;
      // Discovered tokens (seen by the indexer, never added by the user): a
      // separate, chunked, best-effort read; shown automatically ONLY when
      // TRUSTED (listed in the Trust Wallet registry) and holding a balance.
      // Airdrop/spam contracts also move through an address, and without the
      // trust check they filled the list with tokens the user never asked for
      // (owner, 2026-08-19: "Chinese tokens keep appearing"). Untrusted ones
      // stay remembered for "Import all". Tracked and default tokens always
      // show. Skips contracts the user tracks or the chain lists by default.
      let discoveredRows: LiveAssetBalance[] = [];
      // A discovered token whose balance did not answer is MISSING from the
      // rows, not known to be gone: tracked separately so the merge below can
      // keep its last figure rather than dropping the row.
      let discoveredComplete = true;
      if (ok && discovered.length > 0) {
        const mainAddrs = new Set([
          ...tracked.map((t) => t.address.toLowerCase()),
          ...(activeEvmChain(get())?.defaultTokens ?? []).map((t) => t.address.toLowerCase()),
        ]);
        const extra = discovered.filter((d) => d.trusted === true && !mainAddrs.has(d.address.toLowerCase()));
        const read = await readEvmDiscoveredBalances(address, chainKey, extra);
        discoveredRows = read.rows.filter((r) => r.amountBase > 0n);
        discoveredComplete = read.complete;
        if (!stillCurrent()) return;
        // Trust check for discovered tokens not yet checked (best-effort,
        // detached): the mark fetch doubles as the listing check.
        if (discovered.some((d) => d.trusted === undefined)) void get().checkDiscoveredEvmTokens();
      }
      // THE RULE: a failed or partial read never blanks a token the wallet
      // already knew about (src/store/balanceCache.ts). `complete` says whether
      // this read is authoritative about every asset it was asked for; only
      // then does a missing row mean the balance is gone.
      const complete = result.complete && discoveredComplete;
      const nextAssets = result.assets
        ? mergeBalanceRows(get().assets, [...result.assets, ...discoveredRows], complete)
        : get().assets;
      set({
        loadingRefresh: false,
        offline: !ok,
        network: result.network,
        assets: nextAssets,
        // Balances are the sync on this family; a successful read is "Synced".
        ...(ok ? { lastSyncAt: Date.now() } : {}),
      });
      // Save what is on screen so the next popup opens with it, even if that
      // open is answered with a 429. Only when the read actually answered:
      // persisting a list built entirely from the cache would just rewrite it.
      if (ok && result.assets) void saveBalanceCache(balanceCacheChain, address, nextAssets);
      // History (phase 4): the indexer, when the chain has one, else the honest
      // "cannot list" notice. Detached, like the UTXO classification: it must
      // never gate the balance appearing. Local pending sends ride on top and
      // retire when the indexer reports them.
      const chain = activeEvmChain(get());
      const historyKey = `${chain?.key ?? ''}:${address.toLowerCase()}`;
      const historyDue =
        !silent || Date.now() - (evmHistoryAskedAt.get(historyKey) ?? 0) >= EVM_HISTORY_MIN_INTERVAL_MS;
      if (chain && historyDue) {
        evmHistoryAskedAt.set(historyKey, Date.now());
        set({ historyLoading: true });
        // Saved history first: a fresh popup or a just-switched account shows
        // what the indexer last answered at once, and the incremental read
        // below only adds to it. Skipped when rows are already on screen.
        if (get().txs.length === 0) {
          void loadEvmHistoryCache(chain.key, address).then((cached) => {
            if (!cached || cached.rows.length === 0) return;
            if (!stillCurrent() || get().txs.length > 0) return;
            set({ txs: withLocalPending(address, cached.rows), unreadActivity: countUnread(cached.rows, get().activitySeen) });
          });
        }
        void refreshEvmHistory(chain, address, result.network.blockHeight || undefined).then((history) => {
          if (stillCurrent()) set({ historyLoading: false });
          if (!history || !stillCurrent()) return;
          const next: Partial<LiveState> = {
            historyIssue: history.issue
              ? { address, message: history.issue.message, serverMessage: history.issue.detail }
              : null,
          };
          if (history.txs !== null) {
            // Older pages the user asked for live in memory only, so a refresh
            // that replaced `txs` outright would silently undo every "Load
            // older" click. Once any has been made, the fresh newest page is
            // MERGED over what is on screen instead (fresh wins on identity,
            // exactly as it does over the saved cache).
            const pagedBack = get().olderHistory.cursor !== null;
            const rows = pagedBack
              ? mergeEvmHistory(get().txs, history.txs, EVM_HISTORY_IN_MEMORY_MAX_ROWS)
              : history.txs;
            next.txs = withLocalPending(address, rows);
            next.unreadActivity = countUnread(rows, get().activitySeen);
            // Can this account go further back than the page just read? The
            // source knows only by being asked, so what is settled here is the
            // CAPABILITY: a chain with a history source can be paged, a chain
            // without one cannot and says so instead of offering the control.
            // A click that comes back with no cursor turns this to false.
            if (get().olderHistory.canLoadOlder === null) {
              const pageable = chain.alchemy || chain.indexer !== null;
              next.olderHistory = { ...get().olderHistory, canLoadOlder: pageable && rows.length > 0 };
            }
          }
          set(next);
          // Token discovery: contracts the indexer saw move through this
          // address that the wallet does not know yet. Persist them and read
          // their balances now, so a token that arrived shows without anyone
          // having to type its contract address.
          const id = svc.activeWalletId();
          if (id && chainKey && history.tokensSeen.length > 0) {
            const known = new Set(
              [...get().evmTokens.tracked, ...get().evmTokens.discovered].map((t) => t.address.toLowerCase()),
            );
            const fresh = history.tokensSeen.filter((t) => !known.has(t.address.toLowerCase()));
            if (fresh.length > 0) {
              // Newest first, capped: an address that collected fifty airdrop
              // contracts does not need fifty balanceOf calls per refresh.
              const discoveredNext = [...fresh, ...get().evmTokens.discovered].slice(0, MAX_DISCOVERED_EVM_TOKENS);
              persistValue(evmDiscoveredKey(id, chainKey), discoveredNext);
              set((s) => ({ evmTokens: { ...s.evmTokens, discovered: discoveredNext } }));
              void get().refresh({ silent: true });
            }
          }
        });
      }
      return;
    }

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
      // Electrum answers a balance read whole or not at all (one rejected
      // address rejects the Promise.all above), so a FULFILLED read here is
      // always complete: it may drop a token, and that is the truth about it.
      const nextAssets = assets.status === 'fulfilled' ? assets.value : get().assets;
      set({
        loadingRefresh: false,
        // A balances rejection still marks the wallet offline (as before); a
        // tx-sync failure alone never does (handled in the background block).
        offline: !netOk || networkStatus.value.state === 'offline' || assets.status === 'rejected',
        network: netOk ? networkStatus.value : get().network,
        assets: nextAssets,
      });
      // Saved for the next cold open, exactly as on the EVM path above.
      if (assets.status === 'fulfilled') void saveBalanceCache(balanceCacheChain, address, nextAssets);
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
    set({ historyLoading: true });

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
          // NOTHING OLDER EXISTS on this family. Electrum's
          // blockchain.scripthash.get_history answers with the address's WHOLE
          // history in one call (a server that will not is the
          // AddressHistoryRefusedError above, not a page boundary), and this
          // run classified all of it. So Activity here is complete and the UI
          // says so, rather than offering a "Load older" that has nowhere to go.
          olderHistory: { canLoadOlder: false, cursor: null, loading: false, error: null },
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
        if (txSyncRun === run) {
          txSyncRun = null;
          set({ historyLoading: false });
        }
      }
    })();
  },

  // --- older Activity -------------------------------------------------------
  //
  // "There is no pagination in activities, I checked for USDT on EVM BNB"
  // (owner, live testing 2026-08-25). Verified live against the gateway the
  // same day for his address on BNB Chain: the newest page is 100 transfers
  // per direction and the API had a second page of 100 more, reaching back
  // from block 109,745,356 to 34,208,015. All of it existed; none of it was
  // reachable, because nothing ever asked for a second page.
  //
  // ONE request per click, never two at once, and the answer is honest in both
  // directions: a page that comes back with no cursor sets `canLoadOlder` to
  // false, which is what makes the UI say "that is the whole history" rather
  // than keep offering a button that returns nothing.
  async loadOlderActivity() {
    const { address, olderHistory } = get();
    if (!address) return;
    // Rate-limit discipline: one page in flight at a time, and nothing at all
    // once the source has said it has no more.
    if (olderHistory.loading || olderHistory.canLoadOlder === false) return;

    if (activeFamily() !== 'evm') {
      // A UTXO chain has already served everything (see the sync commit
      // above). Settling the flag here too keeps the control correct even if
      // it is reached before the first sync has finished.
      set((s) => ({ olderHistory: { ...s.olderHistory, canLoadOlder: false, loading: false, error: null } }));
      return;
    }

    const chain = activeEvmChain(get());
    if (!chain) return;
    const chainTarget = activeChainTarget();
    const stillCurrent = () => get().address === address && activeChainTarget() === chainTarget;
    set((s) => ({ olderHistory: { ...s.olderHistory, loading: true, error: null } }));
    // The oldest CONFIRMED block on screen. It starts the first page below what
    // the wallet already holds, so the first click adds rows rather than
    // re-serving the ones in front of the user. Pending rows have no height and
    // are skipped.
    const heights = get()
      .txs.map((t) => t.blockHeight)
      .filter((h): h is number => typeof h === 'number' && h > 0);
    const result = await loadOlderEvmHistory(
      chain,
      address,
      olderHistory.cursor ?? undefined,
      get().network?.blockHeight || undefined,
      heights.length > 0 ? Math.min(...heights) : undefined,
    );
    if (!stillCurrent()) return;
    if (!result) {
      // No EVM engine in this build: there is nothing to page.
      set((s) => ({ olderHistory: { ...s.olderHistory, loading: false, canLoadOlder: false } }));
      return;
    }
    if (result.rows === null) {
      // The read failed. The cursor is untouched, so a retry resumes rather
      // than starting over, and the rows on screen are left alone.
      set((s) => ({
        olderHistory: { ...s.olderHistory, loading: false, error: result.issue?.message ?? null },
      }));
      return;
    }
    // Older rows are APPENDED to what is on screen (mergeEvmHistory dedupes:
    // the first older page deliberately overlaps the newest one, which is how
    // the source's own cursor is obtained). They are NOT written to the
    // history cache: paging back through years of transfers must not grow the
    // extension's stored footprint, so they last for the session.
    const merged = mergeEvmHistory(get().txs, result.rows, EVM_HISTORY_IN_MEMORY_MAX_ROWS);
    set({
      txs: withLocalPending(address, merged),
      olderHistory: { canLoadOlder: result.hasMore, cursor: result.cursor, loading: false, error: null },
    });
  },

  // --- prices ---------------------------------------------------------------
  // Best-effort USD price feed — never blocks or breaks a wallet flow. Merges so
  // an asset whose fetch failed this round keeps its previous value (a transient
  // blip must not blank a price already on screen). fetchPrices() self-caches for
  // 60s, so calling this on every auto-refresh tick still fetches at most once/min.
  async loadPrices() {
    try {
      // ONE call. A gateway build gets every configured ticker back in a single
      // document; a dev build with no gateway falls back to the direct sources
      // and only asks for the optional ticker the ACTIVE chain needs, so a user
      // who never touches RVN/LTC/BTC/DOGE adds no ticker chatter there.
      const ticker = nativeTickerFor();
      const next = await fetchPrices({
        includeRvn: ticker === 'RVN',
        includeLtc: ticker === 'LTC',
        includeBtc: ticker === 'BTC',
        includeDoge: ticker === 'DOGE',
      });
      // MERGE, never replace: a ticker this round could not fill keeps whatever
      // was on screen, so a transient blip never blanks a price or makes a
      // change chip flicker away. Driven by the quote TABLE, not a fixed field
      // list, so a ticker the gateway starts publishing needs no code here.
      const prices: PriceMap = { ...get().prices };
      const priceTable: Record<string, PriceQuote> = { ...get().priceTable };
      const priceChanges24h = { ...get().priceChanges24h, ...next.changes24h };
      for (const [name, quote] of Object.entries(next.quotes)) {
        priceTable[name] = { ...priceTable[name], ...quote };
        if (quote.usd !== undefined) prices[name] = quote.usd;
      }
      set({ prices, priceTable, priceChanges24h });
    } catch {
      // ignore — prices are decorative; never surface as a wallet error
    }
  },

  // --- notifications --------------------------------------------------------
  // Owner-authored notices from the gateway. Best-effort, exactly like prices:
  // never blocks or breaks a wallet flow. A build with NO gateway makes no
  // request and has no notifications at all (HAS_GATEWAY folds to a literal, so
  // the fetch code is dropped from that bundle).
  async loadNotifications(opts) {
    // Dev build: no gateway, no request, no notifications. Guarding here (not
    // only in the service) is what the "non-gateway build never fetches" test
    // pins — the store never even reaches the fetch.
    if (!HAS_GATEWAY) return;
    // Throttle: the auto-refresh tick fires every 20s, but a notice changes
    // rarely and the gateway caches, so refetch at most once per NOTIF_REFRESH_MS
    // (60s). `force` bypasses it: Home mount forces, so opening the popup right
    // after the owner edits a notice shows the change at once.
    if (!opts?.force && Date.now() - get().notificationsFetchedAt < NOTIF_REFRESH_MS) return;
    const res = await fetchNotificationsResult();
    // Only a SUCCESSFUL fetch replaces the list (and stamps the throttle clock):
    // a transient failure leaves the last list on screen rather than blanking
    // the banner.
    if (res.ok) set({ notifications: res.notifications, notificationsFetchedAt: Date.now() });
  },

  async dismissNotification(key) {
    // Normalised so a caller that still hands over a bare id (and every entry
    // already in state) is recorded in the one `id@rev` format the selection
    // compares against.
    const entry = normalizeDismissalKey(key);
    const current = get().dismissedNotificationKeys;
    if (current.includes(entry)) return;
    // Bounded (MAX_DISMISSED_KEYS, oldest dropped): every entry is a string the
    // feed chose, and this list used to grow forever.
    const next = capDismissedKeys([...current, entry]);
    set({ dismissedNotificationKeys: next });
    // This write is also what persists the migration: `current` is already the
    // migrated list, so the legacy bare ids are replaced on disk here.
    persistValue(NOTIF_DISMISSED_KEY, next);
  },

  // --- auto-refresh ---------------------------------------------------------
  startAutoRefresh() {
    if (autoRefreshTimer !== null) return; // already running — don't stack
    if (typeof setInterval === 'undefined') return; // non-DOM env guard
    autoRefreshTimer = setInterval(() => {
      // A hidden page (a detached window behind others, a background tab) has
      // nobody looking: skip the tick rather than spend metered provider calls
      // and public-node goodwill on a screen no one sees. The next visible tick
      // refreshes as usual.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      // Piggyback the price refresh on the poll tick (self-throttled to 60s).
      void get().loadPrices();
      // Notifications ride the same tick (self-throttled to NOTIF_REFRESH_MS,
      // and a no-op on a build with no gateway).
      void get().loadNotifications();
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
    if (activeFamily() === 'evm') return get().addEvmToken(name);
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

  async addEvmToken(contractAddress: string) {
    const chain = activeEvmChain(get());
    const id = svc.activeWalletId();
    if (!chain || !id || activeFamily() !== 'evm') {
      return { ok: false as const, error: 'The active wallet is not an EVM account.' };
    }
    const evm = await loadEvmModules();
    const provider = await evmProviderFor(chain.key);
    if (!evm || !provider) return { ok: false as const, error: 'This build of Satori GO has no EVM engine.' };
    const input = contractAddress.trim();
    if (!evm.isEvmAddress(input)) {
      return {
        ok: false as const,
        error: 'Enter the token contract address: 0x followed by 40 hex characters (mixed case must carry a valid checksum).',
      };
    }
    const address = evm.normalizeEvmAddress(input);
    if (chain.defaultTokens.some((t) => t.address.toLowerCase() === address.toLowerCase())) {
      return { ok: false as const, error: 'That token is already shown by default.' };
    }
    let ref: { address: string; symbol: string; decimals: number } | null;
    try {
      const resolved = await provider.resolveToken(address);
      ref = resolved && resolved.symbol && resolved.decimals !== undefined
        ? { address: resolved.address, symbol: resolved.symbol, decimals: resolved.decimals }
        : null;
    } catch {
      return { ok: false as const, error: `${chain.displayName} is unreachable right now; try again.` };
    }
    if (!ref) {
      return { ok: false as const, error: `No ERC-20 token answers at ${address} on ${chain.displayName}.` };
    }
    const { tracked, discovered } = get().evmTokens;
    const nextTracked = tracked.some((t) => t.address.toLowerCase() === ref.address.toLowerCase())
      ? tracked
      : [...tracked, ref];
    persistValue(evmTrackedKey(id, chain.key), nextTracked);
    // A user-added token is shown even at 0, and un-hidden if it was hidden by symbol.
    const nextHidden = get().hiddenAssets.filter((n) => n !== ref.symbol.toUpperCase() && n !== ref.symbol);
    persistList(hiddenKey(id), nextHidden);
    set({ evmTokens: { tracked: nextTracked, discovered }, hiddenAssets: nextHidden });
    setTokenLogos(nextTracked);
    void get().fetchEvmTokenLogos();
    await get().refresh();
    return { ok: true as const };
  },

  async searchEvmTokens(query: string) {
    const chain = activeEvmChain(get());
    if (!chain || activeFamily() !== 'evm') {
      return { ok: false as const, error: 'The active wallet is not an EVM account.' };
    }
    if (!chain.tokenListSlug) return { ok: false as const, error: 'No token list for this chain' };
    const evm = await loadEvmModules();
    if (!evm) return { ok: false as const, error: 'This build of Satori GO has no EVM engine.' };
    const list = await evm.fetchTokenList(chain.tokenListSlug);
    if (!list.ok) return { ok: false as const, error: list.error };
    return { ok: true as const, results: evm.searchTokenList(list.entries, query) };
  },

  async importEvmTokens(opts?: { trustedOnly?: boolean }) {
    const chain = activeEvmChain(get());
    const id = svc.activeWalletId();
    const address = get().address;
    if (!chain || !id || !address || activeFamily() !== 'evm') {
      return { ok: false as const, error: 'The active wallet is not an EVM account.' };
    }
    if (!chain.alchemy) {
      return {
        ok: false as const,
        error: `Importing tokens on ${chain.displayName} needs a token index this build's endpoint does not offer; add tokens by contract address instead.`,
      };
    }
    const evm = await loadEvmModules();
    const provider = await evmProviderFor(chain.key);
    if (!evm || !provider) return { ok: false as const, error: 'This build of Satori GO has no EVM engine.' };
    let held: { tokens: Array<{ address: string; symbol: string; decimals: number }>; skipped: number };
    try {
      held = await evm.listHeldTokens(provider.rpc, address);
    } catch (err) {
      const reason = err instanceof evm.EvmTokenApiError ? err.reason : 'unavailable';
      const text =
        reason === 'unsupported'
          ? `Importing tokens on ${chain.displayName} needs a token index this build's endpoint does not offer; add tokens by contract address instead.`
          : reason === 'rate-limited'
            ? `${chain.displayName} token index is rate-limiting this wallet; try again in a moment.`
            : `${chain.displayName} token index is unreachable right now; try again.`;
      return { ok: false as const, error: text };
    }
    const defaults = new Set(chain.defaultTokens.map((t) => t.address.toLowerCase()));
    const { tracked, discovered } = get().evmTokens;
    const known = new Set(tracked.map((t) => t.address.toLowerCase()));
    let fresh: EvmTrackedToken[] = held.tokens
      .filter((t) => !defaults.has(t.address.toLowerCase()) && !known.has(t.address.toLowerCase()))
      .map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals }));
    let untrusted = 0;
    if (opts?.trustedOnly) {
      // "Trusted" here means exactly what the unlisted badge means everywhere
      // else: the wallet is willing to vouch for the token under the rule in
      // evm/tokenTrust.ts. Importing on a weaker test than the one the warning
      // uses is how a button ends up adding tokens its own UI then warns about.
      if (!evm.canVouchOnChain(chain)) {
        return {
          ok: false as const,
          error: `Satori GO cannot vouch for tokens on ${chain.displayName} in this build; use Import all, or add a token by its contract address.`,
        };
      }
      const lookup = await evm.openTokenListLookup(chain);
      if (lookup.kind === 'unavailable') {
        return {
          ok: false as const,
          error: `The ${chain.displayName} token list is unreachable right now, so this cannot tell a listed token from an airdrop; try again, or use Import all.`,
        };
      }
      const vouched: EvmTrackedToken[] = [];
      for (let i = 0; i < fresh.length; i += 4) {
        const chunk = fresh.slice(i, i + 4);
        const got = await Promise.all(
          chunk.map(async (t) => {
            const v = await evm.probeTokenTrust(chain, t.address, lookup);
            return v.trusted === true ? { ...t, logo: v.logo, trusted: true, trustRule: TOKEN_TRUST_RULE } : null;
          }),
        );
        for (const t of got) if (t) vouched.push(t);
      }
      untrusted = fresh.length - vouched.length;
      fresh = vouched;
    }
    if (fresh.length > 0) {
      const nextTracked = [...tracked, ...fresh];
      persistValue(evmTrackedKey(id, chain.key), nextTracked);
      // Imported tokens are shown even if they were hidden by symbol before.
      const freshSymbols = new Set(fresh.map((t) => t.symbol.toUpperCase()));
      const nextHidden = get().hiddenAssets.filter((n) => !freshSymbols.has(n.toUpperCase()));
      persistList(hiddenKey(id), nextHidden);
      set({ evmTokens: { tracked: nextTracked, discovered }, hiddenAssets: nextHidden });
      setTokenLogos(nextTracked);
      void get().fetchEvmTokenLogos();
      await get().refresh();
    }
    return { ok: true as const, added: fresh.length, skipped: held.skipped, untrusted };
  },

  // ONE removal path. The asset detail screen's "Remove from list" and the
  // list's own multi-select both land here, so "removed" means exactly the same
  // thing wherever it is asked for.
  removeAsset(name: string) {
    get().removeAssets([name]);
  },

  removeAssets(names: readonly string[]) {
    const chainId = activeChainTarget();
    // The active chain's protected assets are never removable (Evrmore: EVR +
    // SATORIEVR; Ravencoin: RVN; an EVM chain: its coin and default tokens). The
    // UI hides their remove controls; this refuses them regardless.
    const targets = [...new Set(names.map((n) => n.trim().toUpperCase()).filter(Boolean))].filter((n) =>
      isRemovableAsset(n, chainId),
    );
    if (targets.length === 0) return;
    const removed = new Set(targets);
    const id = svc.activeWalletId();
    // On an EVM chain the row is a token known by contract: forget it in the
    // tracked and discovered lists too, so it does not come back on the next
    // read (hiding by symbol alone would still cost a balanceOf per refresh).
    const chainKey = svc.evmChainKey();
    if (activeFamily() === 'evm' && id && chainKey) {
      const { tracked, discovered } = get().evmTokens;
      const keep = (t: EvmTrackedToken) => !removed.has(t.symbol.toUpperCase());
      const nextTracked = tracked.filter(keep);
      const nextDiscovered = discovered.filter(keep);
      persistValue(evmTrackedKey(id, chainKey), nextTracked);
      persistValue(evmDiscoveredKey(id, chainKey), nextDiscovered);
      set({ evmTokens: { tracked: nextTracked, discovered: nextDiscovered } });
      setTokenLogos(nextTracked);
      set((s) => ({ assets: s.assets.filter((a) => a.isNative || !removed.has(a.name.toUpperCase())) }));
      return;
    }
    const { pinnedAssets, hiddenAssets } = get();
    const nextHidden = [...hiddenAssets, ...targets.filter((n) => !hiddenAssets.includes(n))];
    const nextPinned = pinnedAssets.filter((n) => !removed.has(n));
    if (id) {
      persistList(hiddenKey(id), nextHidden);
      persistList(pinnedKey(id), nextPinned);
    }
    set({ hiddenAssets: nextHidden, pinnedAssets: nextPinned });
  },

  setAssetOrder(names: readonly string[]) {
    const next = [...new Set(names)];
    const id = svc.activeWalletId();
    if (id) persistValue(assetOrderKey(id, activeChainTarget()), next);
    set({ assetOrder: next });
  },

  async loadAssetOrder() {
    const id = svc.activeWalletId();
    if (!id) {
      set({ assetOrder: [] });
      return;
    }
    const chainId = activeChainTarget();
    const order = await readList(assetOrderKey(id, chainId));
    // Guard against a wallet or chain switch that landed while the read was in
    // flight: the answer belongs to ONE account on ONE chain (the same guard
    // loadEvmTokens uses).
    if (svc.activeWalletId() !== id || activeChainTarget() !== chainId) return;
    set({ assetOrder: order });
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
        assetOrder: [],
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
    // resurrected. Keyed to the ACTIVE chain (family-aware: an EVM chain has no
    // default pins and protects only its native coin).
    const chainId = activeChainTarget();
    // Pins are UTXO asset NAMES. An EVM account has none (its tokens are the
    // contract-keyed lists in evmTokens), and SATORIEVR is an Evrmore asset,
    // so a pin of it that reached another chain (the one-time legacy migration
    // copied the global list into every wallet) is dropped rather than shown as
    // a phantom 0 row on Ravencoin or Base.
    const sanitized = sanitizePins(pinned, chainId);
    if (sanitized !== pinned) {
      pinned = sanitized;
      persistList(pinnedKey(id), pinned);
    }
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
    // The manual row order is per wallet AND per chain, so it is read here (a
    // wallet switch, an unlock) and again in switchEvmChain (same wallet, a
    // different token set).
    await get().loadAssetOrder();
    await get().loadEvmTokens();
  },

  async loadEvmTokens() {
    const id = svc.activeWalletId();
    const chainKey = svc.evmChainKey();
    if (!id || activeFamily() !== 'evm' || !chainKey) {
      set({ evmTokens: { tracked: [], discovered: [] } });
      return;
    }
    const [tracked, discovered] = await Promise.all([
      readEvmTokens(evmTrackedKey(id, chainKey)),
      readEvmTokens(evmDiscoveredKey(id, chainKey)),
    ]);
    // Guard against a chain switch that completed while the lists were read.
    if (svc.evmChainKey() !== chainKey || svc.activeWalletId() !== id) return;
    set({ evmTokens: { tracked, discovered } });
    setTokenLogos([...tracked, ...discovered.filter((d) => d.trusted)]);
    // Any tracked token still without a mark gets one fetched (best-effort).
    void get().fetchEvmTokenLogos();
  },

  async fetchEvmTokenLogos() {
    const chain = activeEvmChain(get());
    const id = svc.activeWalletId();
    if (!chain || !id || activeFamily() !== 'evm') return;
    const evm = await loadEvmModules();
    if (!evm) return;
    // Tokens without a verdict yet. The rule lives in evm/tokenTrust.ts and is
    // the same one "Import trusted" and the discovery check use.
    const missing = get().evmTokens.tracked.filter((t) => t.trusted === undefined);
    if (missing.length === 0) return;
    // One token-list read for the whole batch, then the marks a few at a time:
    // this is a popup talking to one host, not a crawler.
    const lookup = await evm.openTokenListLookup(chain);
    if (svc.activeWalletId() !== id || svc.evmChainKey() !== chain.key) return;
    const verdicts = new Map<string, { trusted: boolean; logo?: string }>();
    for (let i = 0; i < missing.length; i += 4) {
      const chunk = missing.slice(i, i + 4);
      const got = await Promise.all(
        chunk.map(async (t) => [t.address.toLowerCase(), await evm.probeTokenTrust(chain, t.address, lookup)] as const),
      );
      // An undefined verdict is NOT recorded: the question could not be
      // answered, so it is asked again next time.
      for (const [addr, v] of got) if (v.trusted !== undefined) verdicts.set(addr, { trusted: v.trusted, logo: v.logo });
      // The account or chain may have changed while fetching: stop, discard.
      if (svc.activeWalletId() !== id || svc.evmChainKey() !== chain.key) return;
    }
    if (verdicts.size === 0) return;
    const tracked = get().evmTokens.tracked.map((t) => {
      const v = verdicts.get(t.address.toLowerCase());
      return v ? { ...t, ...v, trustRule: TOKEN_TRUST_RULE } : t;
    });
    persistValue(evmTrackedKey(id, chain.key), tracked);
    set((s) => ({ evmTokens: { ...s.evmTokens, tracked } }));
    setTokenLogos([...tracked, ...get().evmTokens.discovered.filter((d) => d.trusted)]);
  },

  async checkDiscoveredEvmTokens() {
    const chain = activeEvmChain(get());
    const id = svc.activeWalletId();
    if (!chain || !id || activeFamily() !== 'evm') return;
    const evm = await loadEvmModules();
    if (!evm) return;
    const pending = get().evmTokens.discovered.filter((d) => d.trusted === undefined);
    if (pending.length === 0) return;
    const verdicts = new Map<string, { trusted: boolean; logo?: string }>();
    if (!evm.canVouchOnChain(chain)) {
      // This build has no way to vouch for anything on this chain (no mark
      // source, or no token list to corroborate one). Discovery therefore shows
      // nothing automatically here; import or the contract address is the way in.
      for (const d of pending) verdicts.set(d.address.toLowerCase(), { trusted: false });
    } else {
      const lookup = await evm.openTokenListLookup(chain);
      if (svc.activeWalletId() !== id || svc.evmChainKey() !== chain.key) return;
      for (let i = 0; i < pending.length; i += 4) {
        const chunk = pending.slice(i, i + 4);
        const got = await Promise.all(
          chunk.map(async (d) => [d.address.toLowerCase(), await evm.probeTokenTrust(chain, d.address, lookup)] as const),
        );
        for (const [addr, v] of got) if (v.trusted !== undefined) verdicts.set(addr, { trusted: v.trusted, logo: v.logo });
        if (svc.activeWalletId() !== id || svc.evmChainKey() !== chain.key) return;
      }
    }
    if (verdicts.size === 0) return;
    const discovered = get().evmTokens.discovered.map((d) => {
      const v = verdicts.get(d.address.toLowerCase());
      return v ? { ...d, ...v, trustRule: TOKEN_TRUST_RULE } : d;
    });
    persistValue(evmDiscoveredKey(id, chain.key), discovered);
    set((s) => ({ evmTokens: { ...s.evmTokens, discovered } }));
    // Newly trusted tokens with a balance should appear: one more (silent) read.
    if ([...verdicts.values()].some((v) => v.trusted)) {
      setTokenLogos([...get().evmTokens.tracked, ...discovered.filter((d) => d.trusted)]);
      void get().refresh({ silent: true });
    }
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
  async buildSend(amountText: string, to: string, assetId: string, feeRateSatPerByte?: bigint) {
    set({ loadingSend: true, error: null, sendPlan: null });
    try {
      // Text -> base units in one exact step, at the ACTIVE chain's scale.
      // parseAmount throws a user-facing message, which the catch below surfaces.
      const amountSats = parseAmount(amountText, networkFor(activeChainId()).decimals);
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
      const d = networkFor(activeChainId()).decimals;
      return {
        maxDecimal: amountToNumber(maxSats, d),
        feeDecimal: amountToNumber(feeSats, d),
        // The Max button needs the EXACT figure to put in the field: a number
        // round-trip here would be the very precision loss this layer removes.
        maxText: formatAmount(maxSats, d),
      };
    } catch {
      return { maxDecimal: 0, feeDecimal: 0, maxText: '0' };
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

  // --- EVM send (family 'evm') ---------------------------------------------------
  // Built and broadcast by src/store/evmSend.ts through the flag-guarded EVM
  // modules; this store only holds the plan under review and the arming gate.
  async quoteEvmSend(input: EvmSendInput) {
    set({ loadingEvmSend: true, error: null, evmSend: null });
    svc.allowBroadcast = false;
    try {
      const chain = activeEvmChain(get());
      if (!chain || activeFamily() !== 'evm') throw new EvmSendError('unknown-asset', 'The active wallet is not an EVM account.');
      const provider = await evmProviderFor(chain.key);
      if (!provider) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
      const from = get().address;
      if (!from) throw new EvmSendError('gated', 'The wallet is locked.');
      const { tracked, discovered } = get().evmTokens;
      const plan = await buildEvmSendPlan({
        provider,
        chain,
        from,
        assets: get().assets,
        input,
        extraTokens: [...tracked, ...discovered],
      });
      set({ loadingEvmSend: false, evmSend: plan });
      return plan;
    } catch (err) {
      set({ loadingEvmSend: false, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async selectEvmFeeLevel(level: EvmFeeLevel) {
    const plan = get().evmSend;
    const chain = activeEvmChain(get());
    if (!plan || !chain) return;
    try {
      set({ evmSend: await withEvmFeeLevel(plan, level, chain, get().assets) });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async estimateEvmMax(level: EvmFeeLevel = 'normal', to?: string) {
    const zero = { maxText: '0', feeText: '0' };
    try {
      const chain = activeEvmChain(get());
      const from = get().address;
      if (!chain || !from || activeFamily() !== 'evm') return zero;
      const provider = await evmProviderFor(chain.key);
      const evm = await loadEvmModules();
      if (!provider || !evm) return zero;
      const native = get().assets.find((a) => a.isNative && a.name === chain.nativeTicker);
      if (!native || native.amountBase <= 0n) return zero;
      // A plain transfer costs the same gas whatever the value, so quote for
      // half the balance (always fundable) and subtract the worst-case total at
      // the chosen level from the whole balance. The RECIPIENT matters when it
      // is a contract (more gas), so use it when the field already holds one.
      const target = to && evm.isEvmAddress(to.trim()) ? evm.normalizeEvmAddress(to.trim()) : from;
      const quotes = await evm.quoteEvmFees(provider.rpc, {
        from,
        to: target,
        value: native.amountBase / 2n,
        data: new Uint8Array(),
      });
      const q = quotes[level];
      // The fee market moves between this quote and the one at Review (Base's
      // base fee changes every block), and a Max amount that fitted here must
      // still fit there: leave the worst-case fee PLUS a 25% margin aside. The
      // margin is never charged, it stays in the account.
      const reserve = (q.maxTotal * 125n) / 100n;
      const max = native.amountBase - reserve;
      return {
        maxText: max > 0n ? formatAmount(max, chain.nativeDecimals) : '0',
        feeText: formatAmount(reserve, chain.nativeDecimals),
      };
    } catch {
      return zero;
    }
  },

  async isEvmContractAddress(address: string) {
    const addr = typeof address === 'string' ? address.trim() : '';
    if (!addr) return null;
    const chain = activeEvmChain(get());
    if (!chain) return null;
    const cacheKey = `${chain.key}:${addr.toLowerCase()}`;
    const cached = evmCodeCache.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
      const provider = await evmProviderFor(chain.key);
      if (!provider) return null;
      // eth_getCode returns the deployed bytecode as DATA: '0x' (or an empty
      // string on a sloppy node) means there is nothing there but a plain
      // account. Anything else is code, and coins sent to code are gone unless
      // the code was written to take them.
      const code = await provider.rpc.call<string>('eth_getCode', [addr, 'latest']);
      if (typeof code !== 'string') return null;
      // '0x' is the canonical empty answer; '0x0' / '0x00' are what a sloppier
      // node writes for the same thing, so an all-zero body is read as empty.
      const body = code.replace(/^0x/i, '');
      const isContract = /[^0]/.test(body);
      evmCodeCache.set(cacheKey, isContract);
      return isContract;
    } catch {
      // Offline, a refusing node, or a chain that does not know the method:
      // unknown, never "safe".
      return null;
    }
  },

  async confirmEvmSend() {
    const plan = get().evmSend;
    const chain = activeEvmChain(get());
    if (!plan || !chain) throw new EvmSendError('gated', 'Nothing to send.');
    if (plan.chainKey !== chain.key) throw new EvmSendError('gated', 'The chain changed since this send was reviewed.');
    const provider = await evmProviderFor(chain.key);
    const evm = await loadEvmModules();
    if (!provider || !evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
    evmNonces ??= new evm.EvmNonceTracker();
    const result = await broadcastEvmPlan({
      provider,
      plan,
      nonces: evmNonces,
      sign: (request) => svc.signEvmTransaction(request),
      allowBroadcast: svc.allowBroadcast,
    });
    // SHOW IT NOW, exactly as the UTXO path does: the indexer will not report
    // the transaction for a while (and BNB Chain has no indexer at all), so the
    // row is built from the plan and retired when a sync reports the real one.
    const address = get().address;
    if (address) {
      const pending = evm.localPendingEvmTx({
        txid: result.txid,
        from: plan.from,
        to: plan.to,
        asset: plan.asset.kind === 'native' ? plan.asset.ticker : plan.asset.symbol,
        decimals: plan.asset.decimals,
        amountBase: plan.amountBase,
        // The ESTIMATED total, not the worst case. maxTotal is what has to be
        // AVAILABLE (it guards the balance check and the caps); what the
        // transaction is expected to COST is estimatedTotal, and it is the
        // figure the indexer's real gasUsed x gasPrice will replace. Showing
        // maxTotal here made a fresh row claim a fee roughly twice the one the
        // chain then charged (owner, 2026-08-24).
        feeBase: plan.quote.estimatedTotal,
        nativeDecimals: chain.nativeDecimals,
        nativeTicker: chain.nativeTicker,
        timestamp: Date.now(),
      });
      localPendingTxs = [
        { address, tx: pending, at: Date.now() },
        ...localPendingTxs.filter((p) => p.tx.txid !== pending.txid),
      ];
      set({ txs: [pending, ...get().txs.filter((t) => t.txid !== pending.txid)].sort(compareLiveTx) });
    }
    // One send at a time: the plan is consumed, the gate closes, balances refresh.
    set({ evmSend: null });
    svc.allowBroadcast = false;
    void get().refresh({ silent: true });
    if (typeof setTimeout !== 'undefined') {
      setTimeout(() => void get().refresh({ silent: true }), 4000);
      setTimeout(() => void get().refresh({ silent: true }), 12000);
    }
    return { txid: result.txid, explorerUrl: evmExplorerTxUrl(chain, result.txid), chainKey: chain.key };
  },

  clearEvmSend() {
    set({ evmSend: null, error: null });
    svc.allowBroadcast = false;
  },

  // --- EVM native staking ---------------------------------------------------
  // A staking action is an ordinary EVM transaction to a precompile, so every
  // step below is the send path with different bytes: buildEvmStakePlan makes
  // the calldata and planEvmCall prices it, the same arming gate guards it, and
  // broadcastEvmPlan is the one place a key meets a node.
  async refreshEvmStaking() {
    const chain = activeEvmChain(get());
    const address = get().address;
    if (!chain || !chain.staking || !address || activeFamily() !== 'evm') {
      set({ evmStaking: { snapshot: null, loading: false, plan: get().evmStaking.plan, planning: false } });
      return;
    }
    set((s) => ({ evmStaking: { ...s.evmStaking, loading: true } }));
    const snapshot = await loadEvmStakingSnapshot(chain, address);
    // The chain or the account can change while this is in flight; a snapshot
    // for a chain the user has left must never land on screen.
    const now = activeEvmChain(get());
    if (!now || now.key !== chain.key || get().address !== address) {
      set((s) => ({ evmStaking: { ...s.evmStaking, loading: false } }));
      return;
    }
    set((s) => ({ evmStaking: { ...s.evmStaking, snapshot, loading: false } }));
  },

  async planEvmStake(input: EvmStakeInput) {
    set((s) => ({ evmStaking: { ...s.evmStaking, planning: true, plan: null }, error: null }));
    svc.allowBroadcast = false;
    try {
      const chain = activeEvmChain(get());
      if (!chain || !chain.staking || activeFamily() !== 'evm') {
        throw new EvmSendError('unknown-asset', 'The active account cannot stake on this chain.');
      }
      const provider = await evmProviderFor(chain.key);
      if (!provider) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
      const from = get().address;
      if (!from) throw new EvmSendError('gated', 'The wallet is locked.');
      const native = get().assets.find((a) => a.isNative && a.name === chain.nativeTicker);
      const plan = await buildEvmStakePlan({
        provider,
        chain,
        from,
        input,
        nativeBalanceBase: native?.amountBase,
      });
      set((s) => ({ evmStaking: { ...s.evmStaking, plan, planning: false } }));
      return plan;
    } catch (err) {
      set((s) => ({
        evmStaking: { ...s.evmStaking, planning: false },
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  },

  async selectEvmStakeFeeLevel(level: EvmFeeLevel) {
    const plan = get().evmStaking.plan;
    const chain = activeEvmChain(get());
    if (!plan || !chain) return;
    try {
      const native = get().assets.find((a) => a.isNative && a.name === chain.nativeTicker);
      const repriced = await withEvmCallFeeLevel(plan, level, chain, native?.amountBase);
      // withEvmCallFeeLevel is generic over a call plan, so the two staking
      // facts (which action, which validator) are carried across explicitly.
      set((s) => ({
        evmStaking: { ...s.evmStaking, plan: { ...repriced, action: plan.action, valoper: plan.valoper } },
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async estimateEvmStakeMax(action: EvmStakeAction, valoper: string, level: EvmFeeLevel = 'normal') {
    try {
      const chain = activeEvmChain(get());
      const from = get().address;
      if (!chain || !chain.staking || !from || activeFamily() !== 'evm') return '0';
      const provider = await evmProviderFor(chain.key);
      const evm = await loadEvmModules();
      if (!provider || !evm) return '0';

      if (action !== 'delegate') {
        // Unstaking and moving a stake are capped by the DELEGATION, not the
        // balance: read the exact figure from the precompile, because a Max one
        // base unit above it is a transaction the chain refuses after signing.
        const exact = await readExactDelegation(provider, chain.key, from, valoper);
        const fallback = get().evmStaking.snapshot?.delegations.find((d) => d.valoper === valoper)?.amountBase ?? 0n;
        const amount = exact ?? fallback;
        return amount > 0n ? formatAmount(amount, chain.nativeDecimals) : '0';
      }

      // Delegating is capped by the spendable balance minus what the fee can
      // reach. The gas of a delegate is not the gas of a transfer, so the
      // reserve is quoted on the REAL call: a 1 base-unit delegate to this
      // validator, which costs the same gas as the full one.
      const native = get().assets.find((a) => a.isNative && a.name === chain.nativeTicker);
      if (!native || native.amountBase <= 0n) return '0';
      const cfg = evm.evmChainByKey(chain.key)?.staking;
      if (!cfg) return '0';
      const quotes = await evm.quoteEvmFees(provider.rpc, {
        from,
        to: cfg.stakingPrecompile,
        value: 0n,
        data: evm.encodeDelegate(cfg, from, valoper, 1n),
      });
      // Same margin as the send path's Max: the fee market moves between this
      // quote and the one at Review, and a Max that fitted here must still fit
      // there. The margin is never charged, it stays in the account.
      const reserve = (withCallGasHeadroom(quotes[level]).maxTotal * 125n) / 100n;
      const max = native.amountBase - reserve;
      return max > 0n ? formatAmount(max, chain.nativeDecimals) : '0';
    } catch {
      return '0';
    }
  },

  async countEvmUnbondingEntries(valoper: string) {
    const chain = activeEvmChain(get());
    const from = get().address;
    if (!chain || !chain.staking || !from) return null;
    const provider = await evmProviderFor(chain.key);
    if (!provider) return null;
    return readUnbondingEntryCount(provider, chain.key, from, valoper);
  },

  async confirmEvmStake() {
    const plan = get().evmStaking.plan;
    const chain = activeEvmChain(get());
    if (!plan || !chain) throw new EvmSendError('gated', 'Nothing to confirm.');
    if (plan.chainKey !== chain.key) throw new EvmSendError('gated', 'The chain changed since this action was reviewed.');
    const provider = await evmProviderFor(chain.key);
    const evm = await loadEvmModules();
    if (!provider || !evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
    evmNonces ??= new evm.EvmNonceTracker();
    const result = await broadcastEvmPlan({
      provider,
      plan,
      nonces: evmNonces,
      sign: (request) => svc.signEvmTransaction(request),
      allowBroadcast: svc.allowBroadcast,
    });
    // SHOW IT NOW, and show it LABELLED, exactly as a send shows its own row.
    // The label is decoded from the bytes that were just broadcast, so Activity
    // says "Staked with <validator>" the moment the action is sent instead of
    // waiting for an indexer (whose row for this chain arrives with no calldata
    // at all, see store/evmHistory.ts). `amountBase` is 0n on purpose: a
    // delegation moves coins through the Cosmos module, not as the
    // transaction's value, and the staked amount is carried by the label.
    const address = get().address;
    if (address) {
      const decoded = evm.decodeStakingCall(plan.data);
      const pending = evm.localPendingEvmTx({
        txid: result.txid,
        from: plan.from,
        to: plan.to,
        asset: chain.nativeTicker,
        decimals: chain.nativeDecimals,
        amountBase: 0n,
        // The ESTIMATED total, exactly as the send path above: the pending row
        // must not show a worst-case fee the chain is not going to charge.
        feeBase: plan.quote.estimatedTotal,
        nativeDecimals: chain.nativeDecimals,
        nativeTicker: chain.nativeTicker,
        timestamp: Date.now(),
        ...(decoded ? { staking: decoded } : {}),
      });
      localPendingTxs = [
        { address, tx: pending, at: Date.now() },
        ...localPendingTxs.filter((p) => p.tx.txid !== pending.txid),
      ];
      set({ txs: [pending, ...get().txs.filter((t) => t.txid !== pending.txid)].sort(compareLiveTx) });
    }
    // One action at a time: the plan is consumed and the gate closes. The
    // staking figures and the balance both moved, so both are re-read (the
    // Cosmos LCD lags a block or two, hence the later ticks).
    set((s) => ({ evmStaking: { ...s.evmStaking, plan: null } }));
    svc.allowBroadcast = false;
    void get().refresh({ silent: true });
    void get().refreshEvmStaking();
    if (typeof setTimeout !== 'undefined') {
      setTimeout(() => void get().refreshEvmStaking(), 6000);
      setTimeout(() => void get().refresh({ silent: true }), 6000);
    }
    return { txid: result.txid, explorerUrl: evmExplorerTxUrl(chain, result.txid), chainKey: chain.key };
  },

  clearEvmStake() {
    set((s) => ({ evmStaking: { ...s.evmStaking, plan: null }, error: null }));
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
  // --- app password (the app-password design notes §5) --------------------------

  /**
   * The step AFTER the app password is accepted: open the active wallet when it
   * is already migrated, or hand over to its own (transitional) prompt when it
   * is not. Shared by unlockApp() and by init() re-entering an already-open app.
   */
  async openActiveWalletAfterAppUnlock() {
    await get().loadWallets();
    const active = get().wallets.find((w) => w.id === get().activeWalletId);
    // Already migrated: the master key opens it, nothing to type.
    if (active?.appProtected) {
      if (await get().unlock('')) return;
    }
    // Still v1 (including a passwordless one, which §6 says must be told about
    // the change rather than silently moved): LiveLock asks, once.
    //
    // NOTE THE STATE THIS LEAVES: phase 'locked' while the APP is unlocked, so
    // the master key is in memory behind a screen that says the wallet is
    // locked. That is deliberate (the wallet's own password is the next step),
    // which is exactly why LiveApp arms the idle auto-lock on `appUnlocked` and
    // not on `phase === 'ready'`, and why LiveLock offers a real Lock button
    // here. `appUnlocked` is re-read rather than assumed: the service drops a
    // stale key on its own.
    set({ phase: 'locked', appUnlocked: svc.appUnlocked() });
  },

  /**
   * §4 rule 5 applied to the APP lock screen: nothing is stranded.
   *
   * The design's rule says a wallet whose own password still works is never
   * unreachable. The app lock screen was the exact inverse of it: one field, no
   * wallet list, and no way to reach a wallet that never migrated, so a
   * forgotten app password locked the user out of wallets it had nothing to do
   * with. This selects a wallet that is still on its own password and hands over
   * to that wallet's own lock screen.
   *
   * It gives nothing away: a v1 wallet still needs its own password, and a
   * migrated wallet is not offered, because for one the app password IS the only
   * password and there is no second route to invent.
   */
  async openWithWalletPassword() {
    if (get().wallets.length === 0) await get().loadWallets();
    const wallets = get().wallets;
    const activeId = get().activeWalletId;
    const candidate =
      wallets.find((w) => w.id === activeId && !w.appProtected) ?? wallets.find((w) => !w.appProtected);
    if (!candidate) return false;
    set({ error: null });
    if (candidate.id !== activeId) await get().switchWallet(candidate.id);
    // switchWallet auto-opens a passwordless wallet, which lands on 'ready';
    // only a wallet that still needs a password goes to its lock screen.
    if (get().phase !== 'ready') set({ phase: 'locked' });
    return true;
  },

  /** Back to the app lock screen. The inverse of openWithWalletPassword(), so
   *  the two screens are a round trip rather than a one-way door.
   *
   *  IT REALLY LOCKS. This used to only set the phase, so the master key stayed
   *  in memory behind a screen that asks for the app password, and the screen
   *  was safe only by the convention that it renders under `!appUnlocked`. A
   *  convention is not a control: any future path that rendered it while the app
   *  was unlocked would be a lock screen with nothing behind it. Going to that
   *  screen now means what it looks like, by calling the same user-facing lock()
   *  the header button and the idle timer use: no seed, no master key. */
  showAppLock() {
    if (!get().appPasswordSet) return;
    get().lock(); // drops the seed AND the master key; lands on 'app-locked'
  },

  // --- the FORCED setup (the app-password design notes §12) ---------------------
  //
  // A wallet with `passwordless: true` holds its seed under an EMPTY passphrase,
  // i.e. effectively in the clear, and this is the flow that stops that from
  // being a state the wallet can be left in. It is entered from init() alone and
  // there is no action here that leaves it without setting the password.

  async revealPasswordlessBackup(walletId: string) {
    try {
      return await svc.revealNoPasswordBackup(walletId);
    } catch {
      return null;
    }
  },

  async completeForcedAppPassword(password: string) {
    const none = { migrated: [] as string[], kept: [] as string[] };
    try {
      if (!password) return { ok: false, error: 'Enter an app password.', ...none };
      // The wallets that open with no password, NAMED BEFORE THE MOVE: after it
      // they are ordinary app-protected wallets and nothing on the entry says
      // which ones this flow just protected.
      const before = get().wallets;
      const nameOf = new Map(before.map((w) => [w.id, w.name] as const));
      const ok = await svc.setAppPassword(password);
      if (!ok) {
        // setAppPassword refuses for exactly two reasons, and the trigger for
        // this screen rules both of them out, so reaching here means another
        // page did one of them in the meantime. Say what is true either way.
        const already = await svc.hasAppPassword();
        return {
          ok: false,
          error: already
            ? 'An app password was set in another window. Close this window and open the wallet again.'
            : 'Could not set an app password on this device. Your wallets are unchanged.',
          ...none,
        };
      }
      // The session now holds the master key (setAppPassword keeps it), which is
      // what lets these wallets move with nothing else typed.
      const moved = await svc.migratePasswordlessWallets();
      set({ appPasswordSet: true, appUnlocked: svc.appUnlocked() });
      await get().loadWallets();
      return {
        ok: true,
        migrated: moved.migrated.map((id) => nameOf.get(id) ?? 'Wallet'),
        kept: moved.kept.map((id) => nameOf.get(id) ?? 'Wallet'),
      };
    } catch (err) {
      // StoreWriteFailedError carries its own true sentence (nothing was
      // written), and every other failure is reported as itself rather than as a
      // guess about the password.
      return { ok: false, error: err instanceof Error ? err.message : String(err), ...none };
    }
  },

  async finishForcedAppPassword() {
    // FORCED MEANS FORCED: this is the only door out of the screen, and it opens
    // only once the password it demanded actually exists. The screen never calls
    // it before then, but "the screen never does that" is a convention and this
    // is a gate, so it is asked of the SERVICE (is there a record on disk?)
    // rather than of a flag this page set.
    if (!(await svc.hasAppPassword())) return;
    // The same handover the app lock screen makes: a wallet that is now app-key
    // protected opens with nothing typed, and one that still has its own
    // password lands on its own prompt, which is exactly what the summary above
    // this told the user to expect.
    await get().openActiveWalletAfterAppUnlock();
  },

  async unlockApp(password: string) {
    set({ error: null });
    try {
      const ok = await svc.unlockApp(password);
      if (!ok) {
        set({ error: 'Incorrect password' });
        return false;
      }
      set({ appUnlocked: true, appPasswordSet: true });
      await get().openActiveWalletAfterAppUnlock();
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  async setAppPassword(password: string) {
    try {
      if (!password) return { ok: false, error: 'Enter an app password.' };
      const ok = await svc.setAppPassword(password);
      if (!ok) {
        // Two reasons the service refuses, and they need different answers.
        const already = await svc.hasAppPassword();
        return {
          ok: false,
          error: already
            ? 'An app password is already set on this device. Change it instead.'
            : 'Could not set an app password: some wallets on this device are already protected by one. Their recovery phrases are the way back.',
        };
      }
      set({ appPasswordSet: true, appUnlocked: svc.appUnlocked() });
      await get().loadWallets();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async changeAppPassword(oldPassword: string, newPassword: string) {
    try {
      const result = await svc.changeAppPassword(oldPassword, newPassword);
      if (!result.ok) {
        // "Incorrect current password." used to be shown for EVERY failure,
        // including one that had nothing to do with the password: the user
        // retyped a correct password forever while the wallet that was actually
        // broken went unnamed.
        const named = result.wallet ? `"${result.wallet}"` : 'One of your wallets';
        const error =
          result.reason === 'wrong-password'
            ? 'Incorrect current password.'
            : result.reason === 'empty-password'
              ? 'Enter a new app password.'
              : result.reason === 'no-app-password'
                ? 'No app password is set on this device.'
                : result.reason === 'wallet-unreadable'
                  ? `${named} could not be moved to a new password, so nothing was changed. Your current app password still opens every other wallet.`
                  : 'Could not save the change, so nothing was changed. Your current app password still works.';
        return { ok: false, error };
      }
      // The service dropped the master key and locked, so the UI must follow it
      // to the app lock screen rather than sit on a wallet it can no longer read.
      get().lock();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  // --- losing the app password (the app-password design notes §13) -------------

  async createRecoveryCode(appPassword: string) {
    try {
      const result = await svc.createRecoveryCode(appPassword);
      if (!result.ok) {
        const named = result.wallet ? `"${result.wallet}"` : 'One of your wallets';
        return {
          ok: false as const,
          error:
            result.reason === 'wrong-password'
              ? 'Incorrect app password.'
              : result.reason === 'no-app-password'
                ? 'Set an app password first. The code is a second way to it.'
                : result.reason === 'wallet-unreadable'
                  ? `${named} could not be re-keyed, so no code was made and nothing was changed.`
                  : 'Could not save the code, so nothing was changed.',
        };
      }
      // The upgrade path re-keys the session, so read the flags back rather
      // than assuming them.
      set({ recoveryCodeSet: true, appUnlocked: svc.appUnlocked() });
      await get().loadWallets();
      return { ok: true as const, code: result.code };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async removeRecoveryCode(appPassword: string) {
    try {
      const ok = await svc.removeRecoveryCode(appPassword);
      if (!ok) return { ok: false, error: 'Incorrect app password.' };
      set({ recoveryCodeSet: false });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async unlockWithRecoveryCode(code: string, newPassword: string) {
    set({ error: null });
    try {
      const result = await svc.unlockWithRecoveryCode(code, newPassword);
      if (!result.ok) {
        return {
          ok: false,
          error:
            result.reason === 'wrong-code'
              ? 'That recovery code is not the one for this wallet.'
              : result.reason === 'no-recovery-code'
                ? 'There is no recovery code on this device.'
                : result.reason === 'empty-password'
                  ? 'Choose a new password.'
                  : result.reason === 'no-app-password'
                    ? 'No app password is set on this device.'
                    : 'Could not save the new password, so nothing was changed.',
        };
      }
      set({ appUnlocked: true, appPasswordSet: true, recoveryCodeSet: true });
      // Exactly what a correct password does from here: open the active wallet
      // when it has already moved over, or show its own prompt when it has not.
      await get().openActiveWalletAfterAppUnlock();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async exportBackup(filePassword: string) {
    try {
      const { text, fileName } = await svc.exportBackup(filePassword);
      return { ok: true as const, text, fileName };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async readBackupFile(text: string, filePassword: string) {
    try {
      const result = await svc.readBackupFile(text, filePassword);
      if (!result.ok) {
        return {
          ok: false as const,
          error:
            result.reason === 'wrong-password'
              ? 'Wrong password for this backup file.'
              : result.reason === 'malformed'
                ? 'This backup file is damaged, or it holds wallets nothing on this device could open.'
                : (result.message ?? 'That file is not a Satori GO backup.'),
        };
      }
      return { ok: true as const, preview: result.preview };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async applyRestore(mode: 'replace' | 'merge') {
    try {
      const result = await svc.applyRestore(mode);
      if (!result.ok) {
        return {
          ok: false,
          error:
            result.reason === 'merge-unsafe'
              ? 'These wallets were protected by a different app password, so they cannot be added alongside the ones here.'
              : result.reason === 'no-pending'
                ? 'Open the backup file again.'
                : 'Could not write the restore, so nothing was changed.',
        };
      }
      // Read every flag back from the service: after a replace this device's
      // app password, its recovery code and its wallets are all the file's now.
      const appPasswordSet = await svc.hasAppPassword();
      set({
        appPasswordSet,
        recoveryCodeSet: appPasswordSet && (await svc.hasRecoveryCode()),
        appUnlocked: svc.appUnlocked(),
      });
      await get().loadWallets();
      // The service locked (a replace ends the session it was made from), so
      // the UI follows it to the lock screen instead of sitting on a wallet it
      // can no longer read.
      if (mode === 'replace') get().lock();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  cancelRestore() {
    svc.cancelRestore();
  },

  async setNoSendPassword(enabled: boolean, password?: string) {
    try {
      const ok = await svc.setNoSendPassword(enabled, password);
      if (ok) await get().loadWallets();
      return { ok };
    } catch (err) {
      // A write that never happened is not a wrong password (see storeWrite.ts).
      if (isStoreWriteFailed(err)) return { ok: false, error: err.message };
      return { ok: false };
    }
  },

  async verifyPassword(password: string) {
    try {
      return await svc.verifyPassword(password);
    } catch {
      return false;
    }
  },

  async changePassword(oldPassword: string, newPassword: string) {
    try {
      return { ok: await svc.changePassword(oldPassword, newPassword) };
    } catch (err) {
      // The password screen renders a bare failure as "Current password is
      // incorrect.", so a store write that could not land must arrive with its
      // own words: nothing was changed, and the password was not the problem.
      if (isStoreWriteFailed(err)) return { ok: false, error: err.message };
      return { ok: false };
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
    // An `evm:<key>` target is stored as-is; a UTXO id in its canonical form.
    const canonical = isEvmChainTarget(chainId) ? chainId : networkFor(chainId as LiveNetworkId).chainId;
    // Re-check the rule here, not only in the UI: a stale render or a future
    // caller must not be able to hide the home chain or the one in use.
    if (hidden && chainHideBlockedReason(canonical, activeChainTarget()) !== null) return;
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

  setHideZeroBalances(hide: boolean) {
    persistValue(HIDE_ZERO_BALANCES_KEY, hide);
    set({ hideZeroBalances: hide });
  },

  setHideBalances(hide: boolean) {
    persistValue(HIDE_BALANCES_KEY, hide);
    set({ hideBalances: hide });
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
    // The Satori GO gateway bridge is not removable: on Ravencoin it is the only
    // server there is, and on Evrmore it is how the owner's node is reached at
    // all. Settings hides its Remove button; this is the same rule enforced
    // where the list actually changes.
    if (isGatewayElectrumUrl(url)) return;
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
      pinnedAssets: [],
      hiddenAssets: [],
      assetOrder: [],
      txs: [],
      stakingEvents: [],
      network: null,
      wallets: [],
      activeWalletId: null,
      addingWallet: false,
      sendPlan: null,
      pendingMnemonic: null,
      pendingMnemonicHasPassphrase: false,
      error: null,
      offline: false,
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      staking: emptyStaking(),
      addressScan: emptyAddressScan(),
      evmStaking: { snapshot: null, loading: false, plan: null, planning: false },
    });
  },
}));
