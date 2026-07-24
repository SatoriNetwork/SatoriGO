import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, ExternalLink, Landmark, LogOut, Plus, RefreshCw, Search, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import { StatusPill } from '../../components/StatusPill';
import { CopyButton } from '../../components/CopyButton';
import { TokenIcon, BrandLogo } from '../../components/BrandLogo';
import { Skeleton, TokenRowSkeleton } from '../../components/Skeleton';
import { EmptyState } from '../../components/EmptyState';
import { ConfirmModal } from '../../components/Modal';
import { TextField } from '../../components/TextField';
import { LiveAddAsset } from './LiveAddAsset';
import { LiveNetwork } from './LiveNetwork';
import { LiveNav, useNav } from './LiveNav';
import { isDetachedWindow, openDetachedWindow } from '../../services/detachWindow';
import {
  useLiveStore,
  computeDisplayedAssets,
  isRemovableAsset,
  usdValue,
  nativeTickerFor,
  stakingSupported,
  type LiveSyncing,
} from '../../store/liveStore';
import { getAppVersion } from '../../services/constants';
import { isLegacyAsset, getAssetNote } from '../../services/assetNotes';
import type { LiveAssetBalance, LiveTransaction } from '../../services/chain/electrumProvider';
import type { NetworkStatus } from '../../types/domain';
import {
  mergeActivity,
  filterActivity,
  paginate,
  ACTIVITY_PER_PAGE,
  type ActivityItem,
  type StakingEvent,
} from '../../services/activityFeed';

interface LiveHomeProps {
  onReceive(): void;
  onSend(): void;
  onSelectAsset(name: string): void;
  onSelectTx(txid: string): void;
}

function shortenAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function fmtAmount(amount: number): string {
  if (amount === 0) return '0';
  if (amount >= 1000) return amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return amount.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/** Format a USD (≈ USDT) value. An exact 0 shows $0.00; a tiny positive value
 *  keeps more precision so a sub-cent amount never collapses to $0.00. */
function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value > 0 && value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** USD price for a given asset name (only EVR, SATORIEVR and RVN are ever priced). */
function priceForAsset(
  name: string,
  prices: { EVR?: number; SATORIEVR?: number; RVN?: number },
): number | undefined {
  if (name === 'EVR') return prices.EVR;
  if (name === 'SATORIEVR') return prices.SATORIEVR;
  if (name === 'RVN') return prices.RVN;
  return undefined;
}

/** Compact activity timestamp with the exact time, e.g. "12 Jul, 14:30:05". */
function fmtTxTime(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${date}, ${time}`;
}

type LedState = 'connected' | 'syncing' | 'offline';

/** Inputs the header sync status (and the LED next to it) is derived from.
 *  Kept as a plain struct rather than reading the store directly so the
 *  derivation itself stays a pure, unit-testable function. */
export interface SyncStatusInput {
  offline: boolean;
  loadingRefresh: boolean;
  syncing: LiveSyncing;
  network: NetworkStatus | null;
  syncProgress: { done: number; total: number } | null;
  lastSyncAt: number | null;
}

/** The compact header label + LED color it drives, plus a fuller tooltip
 *  string for the title attribute. */
export interface SyncStatus {
  ledState: LedState;
  /** Short text for the header, e.g. "Synced" / "Syncing 120/3400". */
  label: string;
  /** Fuller text for the title attribute, e.g. "Fully synced". */
  tooltip: string;
}

/**
 * Derive the header sync-status label (and the LED color it shares) from the
 * store's transient sync fields. Priority, highest first:
 *   1. offline                      -> red LED, "Offline"
 *   2. syncProgress non-null        -> yellow LED (pulses), "Syncing X/Y" —
 *      this fires EVEN IF none of the older "syncing" conditions below would,
 *      because a background classification can keep running quietly after
 *      the initial-load flags have all cleared.
 *   3. loadingRefresh / syncing !== 'idle' / no network yet -> "Syncing…"
 *   4. connected + idle + lastSyncAt set   -> green LED, "Synced" (the
 *      "fully synced" signal the owner asked for)
 *   5. connected + idle + lastSyncAt null  -> "Syncing…" (right after unlock,
 *      before the first background sync has completed this session)
 * Pure + exported so this can be unit-tested without mounting the screen.
 */
export function deriveSyncStatus(input: SyncStatusInput): SyncStatus {
  const { offline, loadingRefresh, syncing, network, syncProgress, lastSyncAt } = input;

  if (offline) {
    return { ledState: 'offline', label: 'Offline', tooltip: 'Offline' };
  }

  if (syncProgress) {
    const done = syncProgress.done.toLocaleString('en-US');
    const total = syncProgress.total.toLocaleString('en-US');
    return {
      ledState: 'syncing',
      label: `Syncing ${done}/${total}`,
      tooltip: `Syncing transaction history: ${done} of ${total}`,
    };
  }

  if (loadingRefresh || syncing !== 'idle' || !network) {
    return { ledState: 'syncing', label: 'Syncing…', tooltip: 'Syncing…' };
  }

  if (lastSyncAt != null) {
    return { ledState: 'connected', label: 'Synced', tooltip: 'Fully synced' };
  }

  // Connected + idle, but no background sync has completed yet this session
  // (e.g. right after unlock, before the detached classification finishes).
  return { ledState: 'syncing', label: 'Syncing…', tooltip: 'Syncing…' };
}

/**
 * First-sync banner copy. With a known delta (syncProgress set) it shows live
 * progress numbers; otherwise it keeps the original open-ended wording, since
 * the total isn't known yet (e.g. the classification hasn't reported its
 * first batch). Pure + exported for tests.
 */
export function formatSyncBannerText(syncProgress: { done: number; total: number } | null): string {
  if (!syncProgress) {
    return 'Syncing wallet data from the blockchain… this can take a while for wallets with history.';
  }
  const done = syncProgress.done.toLocaleString('en-US');
  const total = syncProgress.total.toLocaleString('en-US');
  return `Syncing wallet data from the blockchain… ${done} of ${total} transactions.`;
}

/** Small connection LED in the header: green = connected, yellow = downloading
 *  wallet data (refresh / initial or switching sync), red = offline. */
function ConnectionLed({ state, label }: { state: LedState; label: string }) {
  const color =
    state === 'offline' ? 'var(--danger)' : state === 'syncing' ? 'var(--warning)' : 'var(--success)';
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      data-testid="live-led"
      data-state={state}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 6px ${color}`,
        display: 'inline-block',
        flexShrink: 0,
        animation: state === 'syncing' ? 'pulse 1.1s ease-in-out infinite' : undefined,
      }}
    />
  );
}

function TxRow({ tx, onOpen }: { tx: LiveTransaction; onOpen?: (txid: string) => void }) {
  const isIn = tx.direction === 'in';
  const openId = tx.txid;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(openId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.(openId);
        }
      }}
      aria-label={`Open transaction ${openId.slice(0, 10)}`}
      data-testid={`live-tx-row-${openId.slice(0, 8)}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 2px',
        borderBottom: '1px solid var(--border)',
        cursor: onOpen ? 'pointer' : 'default',
        width: '100%',
        textAlign: 'left',
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isIn ? 'var(--success-bg)' : 'var(--card)',
          color: isIn ? 'var(--success)' : 'var(--text-dim)',
          flexShrink: 0,
        }}
      >
        {isIn ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isIn ? 'Received' : 'Sent'} {tx.asset}
          </span>
          {tx.status === 'pending' && (
            <span className="chip warning" style={{ fontSize: 9, padding: '1px 5px', flexShrink: 0 }}>pending</span>
          )}
        </div>
        <div className="text-dim mono" style={{ fontSize: 10.5, marginTop: 1 }}>
          {tx.txid ? `${tx.txid.slice(0, 10)}...` : 'n/a'}
        </div>
      </div>
      {/* Right-aligned amount: cap its width and single-line ellipsis so a long
          asset ticker (e.g. "+123.45 JACKDAWTOKEN.COM/WHITEPAPER") truncates from
          the ticker end while the numeric amount at the start stays visible and
          the left column keeps a readable share of the row. Short amounts fit
          under the cap and render exactly as before. */}
      <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 0, maxWidth: '60%' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: isIn ? 'var(--success)' : 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {isIn ? '+' : '-'}{fmtAmount(tx.amount)} {tx.asset}
        </div>
        <div className="text-dim" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
          {fmtTxTime(tx.timestamp)}
        </div>
      </div>
    </div>
  );
}

/** A staking-event row (pool join/leave). Non-clickable, detail-less: it is a
 *  local record of a Satori pool action, distinct from an on-chain tx (Landmark
 *  icon, dim pool address). */
function StakingEventRow({ event }: { event: StakingEvent }) {
  const joined = event.type === 'pool-join';
  const poolLabel = event.poolAlias || shortenAddr(event.poolAddress);
  return (
    <div
      data-testid={`live-staking-row-${event.timestamp}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 2px',
        borderBottom: '1px solid var(--border)',
        width: '100%',
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--card)',
          color: 'var(--text-dim)',
          flexShrink: 0,
        }}
      >
        <Landmark size={15} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {joined ? 'Joined pool' : 'Left pool'} {poolLabel}
        </div>
        <div className="text-dim mono" style={{ fontSize: 10.5, marginTop: 1 }}>
          {shortenAddr(event.poolAddress)}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div className="text-dim" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
          {fmtTxTime(event.timestamp)}
        </div>
      </div>
    </div>
  );
}

function BalanceRow({
  asset,
  price,
  onRemove,
  onSelect,
  staked,
  nativeTicker,
}: {
  asset: LiveAssetBalance;
  price?: number;
  onRemove?: (name: string) => void;
  onSelect?: (name: string) => void;
  /** Present only for SATORIEVR when the wallet is registered with a pool. */
  staked?: { poolAlias: string | null; poolAddress: string };
  /** Active chain's native ticker; gates the Evrmore-only "legacy SATORI" pill. */
  nativeTicker: 'EVR' | 'RVN';
}) {
  // Secondary USD value for this row — only when a price exists for the asset.
  const usd = usdValue(asset.amount, price);
  // The row is a clickable button surface (role=button, not a <button> element,
  // so the nested remove <button> stays valid HTML). Enter/Space activate it.
  return (
    <div
      className="token-row"
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(asset.name)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(asset.name);
        }
      }}
      aria-label={`Open ${asset.name} details`}
      data-testid={`live-asset-row-${asset.name}`}
      style={{ cursor: 'pointer', textAlign: 'left', width: '100%' }}
    >
      <TokenIcon assetId={asset.name} size={26} />
      <div
        className="token-name"
        style={{ flex: 1, minWidth: '3.5em', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.name}</span>
        {isLegacyAsset(asset.name, nativeTicker) && (
          <span
            data-testid="legacy-asset-pill"
            title={getAssetNote(asset.name, nativeTicker)?.note}
            style={{
              flexShrink: 0,
              fontSize: 9.5,
              padding: '1px 5px',
              borderRadius: 999,
              color: 'var(--warning)',
              background: 'var(--warning-bg)',
            }}
          >
            legacy
          </span>
        )}
        {staked && (
          <span
            data-testid="staked-asset-pill"
            title={`Staked with ${staked.poolAlias || shortenAddr(staked.poolAddress)}`}
            style={{
              flexShrink: 0,
              fontSize: 9.5,
              padding: '1px 5px',
              borderRadius: 999,
              color: 'var(--success)',
              background: 'var(--success-bg)',
            }}
          >
            staked
          </span>
        )}
      </div>
      {/* Compact single line: amount + USD side by side, right-aligned. The group
          may shrink (flexShrink:1) and clips its overflow, but its automatic
          min-content floor equals the bold amount, so the AMOUNT is never
          squeezed. Only the secondary USD gives way (it carries minWidth:0, so
          it contributes nothing to that floor and is the part that clips). The
          maxWidth cap and the name's minWidth floor keep a readable name + a real
          gap before the Remove button on a funded (very wide) balance. At a zero
          or normal balance the content fits, nothing clips, and it renders
          identically to before. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexShrink: 1, maxWidth: '62%', overflow: 'hidden', whiteSpace: 'nowrap' }}>
        <span
          style={{ fontWeight: 700, fontSize: 13, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
          data-testid={`live-balance-${asset.name}`}
        >
          {fmtAmount(asset.amount)}
        </span>
        {usd != null && (
          <span
            className="text-dim"
            data-testid={`live-asset-usd-${asset.name}`}
            style={{ fontSize: 11, minWidth: 0 }}
          >
            ≈ {fmtUsd(usd)}
          </span>
        )}
      </div>
      {isRemovableAsset(asset.name) && onRemove && (
        <button
          type="button"
          className="icon-btn"
          onClick={(e) => {
            // Removing must not also navigate into the asset-detail view.
            e.stopPropagation();
            onRemove(asset.name);
          }}
          aria-label={`Remove ${asset.name}`}
          title={`Hide ${asset.name}`}
          data-testid={`live-remove-asset-${asset.name}`}
          style={{ width: 26, height: 26, flexShrink: 0 }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function LiveHome({ onReceive, onSend, onSelectAsset, onSelectTx }: LiveHomeProps) {
  const address = useLiveStore((s) => s.address);
  const assets = useLiveStore((s) => s.assets);
  const pinnedAssets = useLiveStore((s) => s.pinnedAssets);
  const hiddenAssets = useLiveStore((s) => s.hiddenAssets);
  const txs = useLiveStore((s) => s.txs);
  const stakingEvents = useLiveStore((s) => s.stakingEvents);
  const prices = useLiveStore((s) => s.prices);
  const network = useLiveStore((s) => s.network);
  const loadingRefresh = useLiveStore((s) => s.loadingRefresh);
  const offline = useLiveStore((s) => s.offline);
  const lock = useLiveStore((s) => s.lock);
  const refresh = useLiveStore((s) => s.refresh);
  const removeAsset = useLiveStore((s) => s.removeAsset);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const switchWallet = useLiveStore((s) => s.switchWallet);
  const removeWallet = useLiveStore((s) => s.removeWallet);
  const addWalletStart = useLiveStore((s) => s.addWalletStart);
  const syncing = useLiveStore((s) => s.syncing);
  const syncProgress = useLiveStore((s) => s.syncProgress);
  const lastSyncAt = useLiveStore((s) => s.lastSyncAt);
  const unreadActivity = useLiveStore((s) => s.unreadActivity);
  const markActivitySeen = useLiveStore((s) => s.markActivitySeen);
  const staking = useLiveStore((s) => s.staking);
  const refreshStaking = useLiveStore((s) => s.refreshStaking);

  const [showAddAsset, setShowAddAsset] = useState(false);
  const [showWalletMenu, setShowWalletMenu] = useState(false);
  const [deleteWalletId, setDeleteWalletId] = useState<string | null>(null);
  // The tab lives in LiveApp now: the bottom nav is rendered on every screen, so it
  // must be able to switch tab AND navigate home from, say, Settings.
  const { tab } = useNav();
  // Already running as the detached window? Then hide the button that opens it.
  const detached = isDetachedWindow();
  // Activity tab: search query + 1-based page. Typing resets to page 1.
  const [activityQuery, setActivityQuery] = useState('');
  const [activityPage, setActivityPage] = useState(1);

  // Merge on-chain txs + local staking events into one timeline, filter by the
  // search query, then paginate — all via the pure helpers (unit-tested). The
  // page state is clamped inside paginate(), so a stale page after a search
  // narrows the list still resolves to a valid page.
  const mergedActivity = useMemo(() => mergeActivity(txs, stakingEvents), [txs, stakingEvents]);
  const filteredActivity = useMemo(
    () => filterActivity(mergedActivity, activityQuery),
    [mergedActivity, activityQuery],
  );
  const {
    items: activityItems,
    page: activityCurrentPage,
    totalPages: activityTotalPages,
  } = useMemo(() => paginate(filteredActivity, activityPage, ACTIVITY_PER_PAGE), [filteredActivity, activityPage]);

  // Viewing the Activity tab marks everything as seen — clears the badge (works
  // whether the user just switched to it or a new tx arrived while already there).
  useEffect(() => {
    if (tab === 'activity' && unreadActivity > 0) markActivitySeen();
  }, [tab, unreadActivity, markActivitySeen]);

  // Lazily refresh Satori staking status when the home asset list loads AND the
  // wallet actually holds SATORIEVR — never fired for wallets that don't, so we
  // add no extra network calls for the common case. Fire-and-forget (like the
  // other background refreshes in the store): never blocks or slows the balances
  // refresh, and a stale-but-cached value is fine between refreshes (only kicks
  // once per mount/holding-change, not on every render).
  const holdsSatori = assets.some((a) => a.name === 'SATORIEVR' && a.amount > 0);
  useEffect(() => {
    if (holdsSatori && !staking.loading && !staking.loaded) {
      void refreshStaking();
    }
  }, [holdsSatori, staking.loading, staking.loaded, refreshStaking]);

  // "Staked" pill next to SATORIEVR: true once any held address is registered
  // with a pool (server truth from the lazy refresh above, or from a prior visit
  // to the staking screen this session).
  const isStakedSatori = staking.addressStatuses.some((s) => s.poolAddress);
  const stakedPoolAddress = staking.addressStatuses.find((s) => s.poolAddress)?.poolAddress ?? null;
  const stakedPoolAlias = stakedPoolAddress
    ? staking.pools.find((p) => p.address === stakedPoolAddress)?.alias ?? null
    : null;

  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  // Native ticker of the ACTIVE chain (follows svc.network(), independent of
  // whether `activeWallet` was found in the list) — drives the hero label/unit.
  const nativeTicker = nativeTickerFor();
  const activeWalletName =
    activeWallet?.name ?? (nativeTicker === 'RVN' ? 'Real Ravencoin mainnet' : 'Real EVRmore mainnet');
  const activeIsPk = activeWallet?.kind === 'pk';
  const deleteTarget = wallets.find((w) => w.id === deleteWalletId) ?? null;

  const selectWallet = (id: string) => {
    setShowWalletMenu(false);
    if (id !== activeWalletId) void switchWallet(id);
  };

  // Dynamic (MetaMask-style) list: held ∪ pinned − hidden, the native coin always
  // first (EVR on Evrmore, RVN on Ravencoin — computeDisplayedAssets always flags
  // it `isNative`, so this reads correctly on either chain).
  const displayAssets = computeDisplayedAssets(assets, pinnedAssets, hiddenAssets);
  const evrBalance = displayAssets.find((a) => a.isNative)?.amount ?? 0;
  const firstLoad = loadingRefresh && assets.length === 0;

  // Total portfolio USD = sum of (amount × price) over the priced displayed assets
  // (only EVR + SATORIEVR ever contribute). `hasPrice` gates whether we show it at
  // all — with no prices loaded yet we render nothing rather than a bogus $0.00.
  const hasPrice = displayAssets.some((a) => priceForAsset(a.name, prices) != null);
  const totalUsd = displayAssets.reduce((sum, a) => {
    const v = usdValue(a.amount, priceForAsset(a.name, prices));
    return v != null ? sum + v : sum;
  }, 0);

  // Connection LED + header sync-status label share one derivation: red =
  // unreachable, yellow = downloading wallet data (manual refresh, first sync
  // of an unseen wallet, a background classification still in progress, or no
  // status yet), green = fully synced. See deriveSyncStatus for the priority
  // order between these signals.
  const syncStatus = deriveSyncStatus({ offline, loadingRefresh, syncing, network, syncProgress, lastSyncAt });
  const ledState = syncStatus.ledState;
  // The LED's own aria-label stays exactly as before (block height when
  // connected) — the new, separate sync-status text next to it is what
  // surfaces "Synced" / progress numbers.
  const ledLabel =
    ledState === 'offline'
      ? 'Offline'
      : ledState === 'syncing'
      ? 'Syncing…'
      : `Connected, block ${network ? network.blockHeight.toLocaleString('en-US') : 'n/a'}`;

  // Version + Satori Network identity footer. Shared by every tab. On the assets
  // tab it lives INSIDE the scrollable asset list (so it scrolls with the rows and
  // never steals height from them / hides the last row); on the other tabs it sits
  // at the end of the normally-scrolling panel exactly as before.
  const footer = (
    <div
      className="text-faint"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '18px 0 8px' }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600 }}>
        <BrandLogo slot="satori" size={13} alt="Satori Network" /> Satori Network
      </span>
      <span style={{ fontSize: 10 }}>Satori GO v{getAppVersion()}</span>
    </div>
  );

  return (
    <div className="app-frame screen-enter" data-testid="live-home">
      {/* Header: brand logo + wallet name, LED, wallet switcher. */}
      <div className="app-header">
        <div className="brand">
          <BrandLogo slot="satori" size={34} alt="Satori Network" />
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="brand-title" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              Satori GO
              <ConnectionLed state={ledState} label={ledLabel} />
              {/* Subtle sync-status text: tells the user "Synced" vs "Syncing"
                  (with live progress numbers) without needing to hover the LED.
                  It — not the brand name — is the element that shrinks/ellipses
                  if the popup is too narrow to fit everything. */}
              <span
                data-testid="sync-status"
                title={syncStatus.tooltip}
                style={{
                  fontSize: 9.5,
                  fontWeight: 400,
                  color: 'var(--text-faint)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                  flexShrink: 1,
                }}
              >
                {syncStatus.label}
              </span>
            </div>
            <button
              type="button"
              className="brand-sub"
              onClick={() => setShowWalletMenu((v) => !v)}
              data-testid="live-wallet-switcher"
              aria-label="Switch wallet"
              aria-expanded={showWalletMenu}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: 'var(--text-dim)',
                maxWidth: 140,
              }}
            >
              {activeIsPk && <BrandLogo slot="satori" size={12} alt="Satori" />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeWalletName}
              </span>
              <ChevronDown size={11} style={{ flexShrink: 0 }} />
            </button>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => refresh()}
            aria-label="Refresh"
            disabled={loadingRefresh}
          >
            <RefreshCw size={16} className={loadingRefresh ? 'spin' : ''} />
          </button>
          {/* A toolbar popup cannot be dragged (the browser pins it to the icon and
              offers no API to move it). Detaching into a real window is the only way
              to get a wallet the user can drag around; see services/detachWindow.ts.
              Hidden when we ARE the detached window. */}
          {!detached && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => void openDetachedWindow()}
              aria-label="Open in a separate window"
              title="Open in a separate window (drag it anywhere)"
              data-testid="live-detach-btn"
            >
              <ExternalLink size={16} />
            </button>
          )}
          {/* Direct lock/logout. Settings and Activity live in the bottom nav, so
              the old "⋮" menu (which only held Lock) is replaced by this button. */}
          <button
            type="button"
            className="icon-btn"
            onClick={() => lock()}
            aria-label="Lock wallet"
            title="Lock wallet"
            data-testid="live-lock-btn"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>

      {/* Wallet switcher dropdown */}
      {showWalletMenu && (
        <div className="menu-pop" style={{ left: 14, right: 'auto', top: 52 }}>
          {wallets.map((w, i) => (
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button
                type="button"
                onClick={() => selectWallet(w.id)}
                data-testid={`live-wallet-item-${i}`}
                style={{ gap: 7, flex: 1, minWidth: 0 }}
              >
                {w.kind === 'pk' && <BrandLogo slot="satori" size={16} alt="Satori" />}
                {w.network === 'ravencoin-mainnet' && <BrandLogo slot="rvn" size={16} alt="RVN" />}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {w.name}
                </span>
                <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>
                  {w.kind === 'pk' ? 'Satori' : 'Seed'}
                </span>
                {w.network === 'ravencoin-mainnet' && (
                  <span
                    className="chip neutral"
                    data-testid={`live-wallet-item-chain-${i}`}
                    style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}
                  >
                    RVN
                  </span>
                )}
                {w.passwordless && (
                  <span className="chip warning" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>No pw</span>
                )}
                {w.active && <Check size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />}
              </button>
              {!w.active && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => { setShowWalletMenu(false); setDeleteWalletId(w.id); }}
                  aria-label={`Remove ${w.name}`}
                  title={`Remove ${w.name}`}
                  data-testid={`live-wallet-delete-${i}`}
                  style={{ width: 30, flexShrink: 0, justifyContent: 'center', padding: '9px 6px' }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <button
            type="button"
            onClick={() => { setShowWalletMenu(false); addWalletStart(); }}
            data-testid="live-add-wallet"
          >
            <Plus size={14} /> Add wallet
          </button>
        </div>
      )}

      {showWalletMenu && (
        <div
          style={{ position: 'absolute', inset: 0, zIndex: 39 }}
          onClick={() => setShowWalletMenu(false)}
        />
      )}

      <div
        className={tab === 'assets' ? 'app-content home-pinned' : 'app-content'}
        data-testid={`live-tab-panel-${tab}`}
      >
        {/* First-sync banner: non-blocking — data streams in while it shows. */}
        {syncing === 'initial' && (
          <div className="banner info" style={{ marginBottom: 10 }} data-testid="live-sync-banner">
            <span className="spinner" style={{ width: 13, height: 13, flexShrink: 0 }} />
            {formatSyncBannerText(syncProgress)}
          </div>
        )}

        {/* Offline banner */}
        {offline && (
          <div className="banner warning" style={{ marginBottom: 10 }}>
            <WifiOff size={14} />
            Network unreachable. Data may be stale.
          </div>
        )}

        {tab === 'assets' ? (
          <>
            {/* Network status + address */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              {loadingRefresh && !network ? (
                <Skeleton width={110} height={26} radius={999} />
              ) : (
                <StatusPill
                  state={offline ? 'offline' : (network?.state ?? 'connecting')}
                  label={
                    offline
                      ? 'Offline'
                      : network
                      ? `Block ${network.blockHeight.toLocaleString()}`
                      : 'Connecting…'
                  }
                  testId="live-network-pill"
                />
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span
                  className="mono text-dim"
                  style={{ fontSize: 11 }}
                  data-testid="live-address"
                >
                  {shortenAddr(address)}
                </span>
                <CopyButton value={address} label="Copy address" size={12} />
              </div>
            </div>

            {/* Hero balance — the .hero pattern. The testid is parametrised by the
                native ticker: on an Evrmore wallet it still evaluates to the exact
                historical 'live-balance-EVR' the live smoke asserts on. */}
            <div className="hero">
              <div className="hero-label">{nativeTicker} Balance</div>
              {firstLoad ? (
                <Skeleton width={160} height={36} style={{ margin: '4px auto' }} />
              ) : (
                <div className="hero-value" data-testid={`live-balance-${nativeTicker}`}>
                  {fmtAmount(evrBalance)}
                  <span style={{ fontSize: 16, fontWeight: 500, marginLeft: 8, color: 'var(--text-dim)' }}>{nativeTicker}</span>
                </div>
              )}
              {!firstLoad && hasPrice && (
                <div
                  data-testid="live-total-usd"
                  style={{
                    marginTop: 6,
                    display: 'inline-flex',
                    alignItems: 'baseline',
                    gap: 6,
                    justifyContent: 'center',
                  }}
                >
                  <span className="text-dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    Total balance
                  </span>
                  <span
                    data-testid="total-balance"
                    style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {fmtUsd(totalUsd)}
                  </span>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="actions-row">
              <button
                type="button"
                className="action-round"
                onClick={onSend}
                data-testid="live-send"
              >
                <div className="action-circle">
                  <ArrowUpRight size={20} />
                </div>
                Send
              </button>
              <button
                type="button"
                className="action-round"
                onClick={onReceive}
                data-testid="live-receive"
              >
                <div className="action-circle">
                  <ArrowDownLeft size={20} />
                </div>
                Receive
              </button>
            </div>

            {/* Token rows */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="section-label">Assets</div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowAddAsset(true)}
                data-testid="live-add-asset"
                style={{ padding: '4px 8px' }}
              >
                <Plus size={13} /> Add token
              </button>
            </div>
            {/* ONLY this region scrolls when the asset list grows. The footer
                rides at its end so it scrolls with the rows and never hides the
                last row. Everything above (hero, Send/Receive, Assets + Add
                token) stays pinned in place. */}
            <div className="home-scroll">
              {firstLoad ? (
                <>
                  <TokenRowSkeleton />
                  <div style={{ marginTop: 9 }}>
                    <TokenRowSkeleton />
                  </div>
                </>
              ) : (
                <div className="stack">
                  {displayAssets.map((asset) => (
                    <BalanceRow
                      key={asset.name}
                      asset={asset}
                      price={priceForAsset(asset.name, prices)}
                      onRemove={removeAsset}
                      onSelect={onSelectAsset}
                      nativeTicker={nativeTicker}
                      staked={
                        asset.name === 'SATORIEVR' && isStakedSatori && stakedPoolAddress
                          ? { poolAlias: stakedPoolAlias, poolAddress: stakedPoolAddress }
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
              {footer}
            </div>
          </>
        ) : tab === 'network' ? (
          <>
            <LiveNetwork />
            {footer}
          </>
        ) : (
          <>
          <div data-testid="live-activity-list">
            <div className="section-label" style={{ marginTop: 2 }}>Activity</div>
            {loadingRefresh && mergedActivity.length === 0 ? (
              <div style={{ padding: '12px 0' }}>
                <Skeleton height={44} style={{ marginBottom: 4 }} />
                <Skeleton height={44} />
              </div>
            ) : mergedActivity.length === 0 ? (
              <EmptyState
                icon={<Wifi size={20} />}
                title="No transactions yet"
                description={
                  stakingSupported()
                    ? `Activity will appear here once you send or receive ${nativeTicker}, or stake to a pool.`
                    : `Activity will appear here once you send or receive ${nativeTicker}.`
                }
              />
            ) : (
              <>
                {/* Search filters the merged tx + staking-event list. Typing
                    resets to page 1. */}
                <div style={{ marginBottom: 8 }}>
                  <TextField
                    placeholder="Search by asset, address, tx id, or pool…"
                    value={activityQuery}
                    onChange={(e) => {
                      setActivityQuery(e.target.value);
                      setActivityPage(1);
                    }}
                    prefixEl={<Search size={14} className="text-dim" />}
                    testId="activity-search"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                {filteredActivity.length === 0 ? (
                  <EmptyState
                    icon={<Search size={20} />}
                    title="No matches"
                    description="Try a different asset, address, tx id, or pool name."
                  />
                ) : (
                  <>
                    <div>
                      {activityItems.map((item: ActivityItem) =>
                        item.kind === 'tx' ? (
                          <TxRow key={item.id} tx={item.tx} onOpen={onSelectTx} />
                        ) : (
                          <StakingEventRow key={item.id} event={item.event} />
                        ),
                      )}
                    </div>

                    {/* Pagination — 10 per page (ACTIVITY_PER_PAGE), same pattern
                        as the staking pool list. */}
                    {activityTotalPages > 1 && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 10,
                          marginTop: 12,
                        }}
                        data-testid="activity-pagination"
                      >
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setActivityPage((p) => Math.max(1, p - 1))}
                          disabled={activityCurrentPage <= 1}
                          data-testid="activity-page-prev"
                        >
                          Prev
                        </button>
                        <span className="text-dim" style={{ fontSize: 11.5 }} data-testid="activity-page-info">
                          page {activityCurrentPage} of {activityTotalPages}
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setActivityPage((p) => Math.min(activityTotalPages, p + 1))}
                          disabled={activityCurrentPage >= activityTotalPages}
                          data-testid="activity-page-next"
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
          {footer}
          </>
        )}
      </div>

      <LiveNav />

      {showAddAsset && <LiveAddAsset onClose={() => setShowAddAsset(false)} />}

      {deleteTarget && (
        <ConfirmModal
          title={`Remove "${deleteTarget.name}"?`}
          description="This deletes the wallet from this device. Without its recovery phrase/private key you will lose access."
          confirmLabel="Remove"
          cancelLabel="Cancel"
          danger
          onConfirm={() => {
            setDeleteWalletId(null);
            void removeWallet(deleteTarget.id);
          }}
          onCancel={() => setDeleteWalletId(null)}
        />
      )}
    </div>
  );
}
