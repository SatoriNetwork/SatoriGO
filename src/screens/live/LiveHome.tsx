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
import { useLiveStore, computeDisplayedAssets, isRemovableAsset, usdValue } from '../../store/liveStore';
import { getAppVersion } from '../../services/constants';
import { isLegacyAsset, getAssetNote } from '../../services/assetNotes';
import type { LiveAssetBalance, LiveTransaction } from '../../services/chain/electrumProvider';
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

/** USD price for a given asset name (only EVR + SATORIEVR are ever priced). */
function priceForAsset(name: string, prices: { EVR?: number; SATORIEVR?: number }): number | undefined {
  if (name === 'EVR') return prices.EVR;
  if (name === 'SATORIEVR') return prices.SATORIEVR;
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
          {isIn ? 'Received' : 'Sent'} {tx.asset}
          {tx.status === 'pending' && (
            <span className="chip warning" style={{ fontSize: 9, padding: '1px 5px' }}>pending</span>
          )}
        </div>
        <div className="text-dim mono" style={{ fontSize: 10.5, marginTop: 1 }}>
          {tx.txid ? `${tx.txid.slice(0, 10)}...` : 'n/a'}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: isIn ? 'var(--success)' : 'var(--text)' }}>
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
}: {
  asset: LiveAssetBalance;
  price?: number;
  onRemove?: (name: string) => void;
  onSelect?: (name: string) => void;
  /** Present only for SATORIEVR when the wallet is registered with a pool. */
  staked?: { poolAlias: string | null; poolAddress: string };
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
        style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.name}</span>
        {isLegacyAsset(asset.name) && (
          <span
            data-testid="legacy-asset-pill"
            title={getAssetNote(asset.name)?.note}
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
      {/* Compact single line: amount + USD side by side, right-aligned. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexShrink: 0, whiteSpace: 'nowrap' }}>
        <span
          style={{ fontWeight: 700, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
          data-testid={`live-balance-${asset.name}`}
        >
          {fmtAmount(asset.amount)}
        </span>
        {usd != null && (
          <span
            className="text-dim"
            data-testid={`live-asset-usd-${asset.name}`}
            style={{ fontSize: 11 }}
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
  const activeWalletName = activeWallet?.name ?? 'Real EVRmore mainnet';
  const activeIsPk = activeWallet?.kind === 'pk';
  const deleteTarget = wallets.find((w) => w.id === deleteWalletId) ?? null;

  const selectWallet = (id: string) => {
    setShowWalletMenu(false);
    if (id !== activeWalletId) void switchWallet(id);
  };

  // Dynamic (MetaMask-style) list: held ∪ pinned − hidden, EVR always first.
  const displayAssets = computeDisplayedAssets(assets, pinnedAssets, hiddenAssets);
  const evrBalance = displayAssets.find((a) => a.name === 'EVR')?.amount ?? 0;
  const firstLoad = loadingRefresh && assets.length === 0;

  // Total portfolio USD = sum of (amount × price) over the priced displayed assets
  // (only EVR + SATORIEVR ever contribute). `hasPrice` gates whether we show it at
  // all — with no prices loaded yet we render nothing rather than a bogus $0.00.
  const hasPrice = displayAssets.some((a) => priceForAsset(a.name, prices) != null);
  const totalUsd = displayAssets.reduce((sum, a) => {
    const v = usdValue(a.amount, priceForAsset(a.name, prices));
    return v != null ? sum + v : sum;
  }, 0);

  // Connection LED: red = unreachable, yellow = downloading wallet data (manual
  // refresh, first sync of an unseen wallet, or no status yet), green = synced.
  const ledState: LedState = offline
    ? 'offline'
    : loadingRefresh || syncing !== 'idle' || !network
    ? 'syncing'
    : 'connected';
  const ledLabel =
    ledState === 'offline'
      ? 'Offline'
      : ledState === 'syncing'
      ? 'Syncing…'
      : `Connected, block ${network ? network.blockHeight.toLocaleString('en-US') : 'n/a'}`;

  return (
    <div className="app-frame screen-enter" data-testid="live-home">
      {/* Header: brand logo + wallet name, LED, wallet switcher. */}
      <div className="app-header">
        <div className="brand">
          <BrandLogo slot="satori" size={34} alt="Satori Network" />
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="brand-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Satori GO
              <ConnectionLed state={ledState} label={ledLabel} />
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
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {w.name}
                </span>
                <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>
                  {w.kind === 'pk' ? 'Satori' : 'Seed'}
                </span>
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

      <div className="app-content" data-testid={`live-tab-panel-${tab}`}>
        {/* First-sync banner: non-blocking — data streams in while it shows. */}
        {syncing === 'initial' && (
          <div className="banner info" style={{ marginBottom: 10 }} data-testid="live-sync-banner">
            <span className="spinner" style={{ width: 13, height: 13, flexShrink: 0 }} />
            Syncing wallet data from the blockchain… this can take a while for wallets with history.
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

            {/* Hero balance — the .hero pattern. */}
            <div className="hero">
              <div className="hero-label">EVR Balance</div>
              {firstLoad ? (
                <Skeleton width={160} height={36} style={{ margin: '4px auto' }} />
              ) : (
                <div className="hero-value" data-testid="live-balance-EVR">
                  {fmtAmount(evrBalance)}
                  <span style={{ fontSize: 16, fontWeight: 500, marginLeft: 8, color: 'var(--text-dim)' }}>EVR</span>
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
                    staked={
                      asset.name === 'SATORIEVR' && isStakedSatori && stakedPoolAddress
                        ? { poolAlias: stakedPoolAlias, poolAddress: stakedPoolAddress }
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
          </>
        ) : tab === 'network' ? (
          <LiveNetwork />
        ) : (
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
                description="Activity will appear here once you send or receive EVR, or stake to a pool."
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
        )}

        {/* Version + Satori Network identity footer */}
        <div
          className="text-faint"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '18px 0 8px' }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600 }}>
            <BrandLogo slot="satori" size={13} alt="Satori Network" /> Satori Network
          </span>
          <span style={{ fontSize: 10 }}>Satori GO v{getAppVersion()}</span>
        </div>
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
