import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Copy, Eye, EyeOff, ExternalLink, GripVertical, Landmark, LogOut, Pencil, Plus, RefreshCw, Search, Trash2, Wifi, WifiOff, X, ListFilter } from 'lucide-react';
import { AccountAvatar } from '../../components/AccountAvatar';
import { ActivityPager } from '../../components/ActivityPager';
import { SyncStatusPill } from '../../components/SyncStatusPill';
import { formatAmount, formatListAmount, amountToNumber } from '../../services/chain/amounts';
import { deriveSyncStatus, formatSyncBannerText, pillStateFor } from './syncStatus';
import { TokenIcon, BrandLogo } from '../../components/BrandLogo';
import { NotificationBanner } from '../../components/NotificationBanner';
import { ScrollMoreCue, useMoreBelow } from '../../components/ScrollMoreCue';
import { UntrustedTokenBadge } from '../../components/UntrustedTokenBadge';
import { displaySymbol } from '../../services/displaySymbol';
import { Skeleton, TokenRowSkeleton } from '../../components/Skeleton';
import { EmptyState } from '../../components/EmptyState';
import { ConfirmModal } from '../../components/Modal';
import { TextField } from '../../components/TextField';
import { LiveAddAsset } from './LiveAddAsset';
import { LiveNetwork } from './LiveNetwork';
import { LiveNav, useNav } from './LiveNav';
import { ChainSwitcher } from './ChainSwitcher';
import { isDetachedWindow, openDetachedWindow } from '../../services/detachWindow';
import {
  groupWallets,
  flattenGroups,
  isEvmSeedAccount,
  siblingAccounts,
  shortAccountAddress,
  memberLabel,
  filterAccountsForChain,
} from './walletGroups';
import { orderAssetsForDisplay, applyManualOrder, moveInOrder, orderableNames } from './assetOrder';
import {
  toggleAssetSelection,
  pruneSelection,
  clearSelection,
  selectionLabel,
  removalDescription,
} from './assetSelection';
import { tokenTrustFor, useTokenRegistryVersion } from '../../store/tokenLogoRegistry';
import {
  useLiveStore,
  computeDisplayedAssets,
  usdValue,
  nativeTickerFor,
  stakingSupported,
  evmStakingSupported,
  activeEvmChain,
  assetsSupported,
  activeChainId,
  activeChainIdentifier,
  activeFamily,
  chainDisplayName,
  walletsOnChain,
  isRemovableAsset,
} from '../../store/liveStore';
import { selectNotifications } from '../../services/notifications';
import type { PriceMap } from '../../services/prices';
import { networkFor, isYoungChain } from '../../services/chain/chainParams';
import { copyText } from '../../services/clipboard';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import { useT } from '../../i18n/useT';
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
import { groupActivityByDay } from './activityDays';
import { stakingRowLabel } from './stakingRowLabel';
import { useShortViewport } from './shortViewport';

/**
 * How many token rows make the list the thing worth the screen's height, at
 * which point Home compacts its hero in a short viewport (`home-tight`, and
 * the `@media (max-height: 700px)` rules in global.css that act on it).
 *
 * THREE, because that is where the popup starts losing: the fixed 400x600
 * toolbar popup has 394px under the header, the pinned hero + actions block
 * took 270 of them, and the asset list was left at its 64px floor with room
 * for one 42px row. Two rows still fit the roomy look; three do not.
 */
export const TIGHT_LIST_ROWS = 3;

/** How close to the top/bottom edge of the asset list a drag has to get before
 *  the list scrolls itself, and how far it moves per tick. 30px is about one
 *  fingertip, and 12px a tick is fast enough to cross a 25-token list without
 *  overshooting a drop by a row. */
const DRAG_EDGE_BAND = 30;
const DRAG_EDGE_STEP = 12;

interface LiveHomeProps {
  onReceive(): void;
  onSend(): void;
  onSelectAsset(name: string): void;
  onSelectTx(txid: string): void;
  /** Opens the staking screen (the SAME route the asset detail uses). Offered
   *  from Home only on a chain that actually has native staking, which this
   *  screen decides for itself with evmStakingSupported() — the handler may be
   *  passed unconditionally. */
  onStake?(): void;
}

function shortenAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

/** How long the header address reads "Copied" before returning to the address. */
const COPIED_MS = 1200;

/**
 * The header's address line: the wallet's ONE address on Home, and clicking it
 * copies the whole thing (MetaMask). It used to be printed twice — once here in
 * a 6+4 short form, once beside the block pill with a copy button next to it —
 * which is one address more than a user ever needs to read.
 *
 * It is a SIBLING of the wallet-switcher button, never a child: a button inside
 * a button is invalid HTML, and clicking the address must copy WITHOUT opening
 * the wallet menu. `shortenAddr` (8+6), not the switcher's old 6+4 form: this is
 * now the only place the address is shown, and it is what the QA smokes read out
 * of `live-address`.
 */
function HeaderAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const clearAfter = useSettingsStore((s) => s.settings.clipboardClearSeconds);
  const toast = useUiStore((s) => s.toast);
  const t = useT();
  // Same clipboard path as <CopyButton>: honours the clipboard-clear setting and
  // reports a failed write instead of pretending it worked.
  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const ok = await copyText(address, clearAfter);
    if (!ok) {
      toast(t('toast.copyFailed'), 'error');
      return;
    }
    setCopied(true);
    toast(t('toast.copied'));
    setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <button
      type="button"
      className="wallet-address"
      data-testid="live-address"
      onClick={(e) => void handleCopy(e)}
      aria-label="Copy address"
      title={`Copy address ${address}`}
    >
      {/* The address text is what the smokes read, so the transient "Copied"
          replaces it rather than sitting beside it. */}
      <span className="wallet-address-text mono">{copied ? 'Copied' : shortenAddr(address)}</span>
      {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
    </button>
  );
}

/** Activity-row text for a TRANSACTION amount, which is still a number.
 *  Deliberate: a transaction's asset amounts arrive from the server as JSON
 *  decimals, so they have already passed through a double before this wallet
 *  sees them. Carrying them as bigint from here on would look rigorous while
 *  recovering nothing. Balances are different: they arrive as integer base
 *  units, so those ARE exact and use fmtBase below. */
function fmtAmount(amount: number): string {
  if (amount === 0) return '0';
  if (amount >= 1000) return amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return amount.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/** Balance row / hero text, straight from base units: the list-row shape (six
 *  significant digits, truncated; see formatListAmount). The full figure is on
 *  the asset detail screen and in the row's tooltip (fmtFull). */
function fmtBase(base: bigint, scale: number): string {
  return formatListAmount(base, scale);
}

/** The complete balance, for a tooltip: every digit the chain holds. */
function fmtFull(base: bigint, scale: number): string {
  return formatAmount(base, scale, { grouping: true });
}

/** Format a USD (≈ USDT) value. An exact 0 shows $0.00; a tiny positive value
 *  keeps more precision so a sub-cent amount never collapses to $0.00. */
function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value > 0 && value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a 24h move as a signed percent: 2.4 -> "+2.4%", -0.83 -> "-0.8%".
 *  One decimal is all a 24h move earns on a row this size, and the sign is
 *  always printed so a gain never reads as a plain number. */
/** What an amount reads as in privacy mode. */
const MASKED = '\u2022\u2022\u2022\u2022';

function fmtChange(percent: number): string {
  if (!Number.isFinite(percent)) return '';
  const rounded = percent.toFixed(1);
  // -0.04 rounds to "-0.0"; print that as a flat 0.0% rather than a fake loss.
  const normalized = rounded === '-0.0' ? '0.0' : rounded;
  if (normalized === '0.0') return '0.0%';
  return `${normalized.startsWith('-') ? '' : '+'}${normalized}%`;
}

/** USD price for one displayed asset row.
 *
 *  NOT a hardcoded ticker list: the row that IS the chain's own coin is priced
 *  by its ticker (so a chain added later is priced the moment the gateway
 *  publishes that ticker, with no change here), plus SATORIEVR, which is an
 *  issued asset rather than anyone's native coin.
 *
 *  It takes the ROW, not just a name, because `isNative` is the only
 *  trustworthy answer to "is this the chain's coin". An issued asset or an
 *  ERC-20 must never be priced off a name collision: a token calling itself
 *  "BTC" is not Bitcoin, and pricing it as one would invent portfolio value. */
function priceForAsset(asset: Pick<LiveAssetBalance, 'name' | 'isNative'>, prices: PriceMap): number | undefined {
  const ticker = asset.name.trim().toUpperCase();
  if (!asset.isNative && ticker !== 'SATORIEVR') return undefined;
  return prices[ticker];
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

/** What a staking row needs to name its validator and format its amount. Null
 *  on every chain without native staking, which is what keeps this row exactly
 *  as it was everywhere else. */
export interface StakingRowContext {
  ticker: string;
  decimals: number;
  monikerOf(valoper: string): string | undefined;
}

function TxRow({
  tx,
  onOpen,
  masked,
  stakingCtx,
}: {
  tx: LiveTransaction;
  onOpen?: (txid: string) => void;
  masked?: boolean;
  stakingCtx?: StakingRowContext | null;
}) {
  const isIn = tx.direction === 'in';
  const openId = tx.txid;
  // The asset as it is DRAWN. On an EVM chain `tx.asset` is the token symbol the
  // indexer reported, i.e. a string its author chose, so it never reaches the
  // screen unsanitised (services/displaySymbol.ts). `tx.asset` itself stays the
  // identity used for filtering and dedupe.
  const shownAsset = displaySymbol(tx.asset);
  // A NATIVE STAKING row (Epix and any future cosmos/evm chain). Absent on every
  // other row, and everything below then reads exactly as it did before.
  const staking = tx.staking && stakingCtx ? stakingRowLabel(tx.staking, stakingCtx) : null;
  // Green is reserved for coins that actually arrived from someone else. A
  // stake leaves for the staking module and a claim comes back from it: both
  // are the user's own bookkeeping, so both stay in the neutral tone, with the
  // arrow the only thing that says which way it went.
  const positiveTone = staking ? false : isIn;
  const arrowIn = staking ? staking.incoming : isIn;
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
          background: positiveTone ? 'var(--success-bg)' : 'var(--card)',
          color: positiveTone ? 'var(--success)' : 'var(--text-dim)',
          flexShrink: 0,
        }}
      >
        {arrowIn ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            {...(staking ? { 'data-testid': `live-tx-staking-${openId}` } : {})}
          >
            {staking ? staking.title : `${isIn ? 'Received' : 'Sent'} ${shownAsset}`}
          </span>
          {tx.status === 'pending' && (
            <span className="chip warning" style={{ fontSize: 9, padding: '1px 5px', flexShrink: 0 }}>pending</span>
          )}
        </div>
        {/* WHERE it went, for a staking row: the validator, by name when the
            chain gave us one. The txid stays the second line everywhere else. */}
        <div
          className={staking ? 'text-dim' : 'text-dim mono'}
          style={{ fontSize: 10.5, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {staking ? staking.subtitle : tx.txid ? `${tx.txid.slice(0, 10)}...` : 'n/a'}
        </div>
      </div>
      {/* Right-aligned amount: cap its width and single-line ellipsis so a long
          asset ticker (e.g. "+123.45 JACKDAWTOKEN.COM/WHITEPAPER") truncates from
          the ticker end while the numeric amount at the start stays visible and
          the left column keeps a readable share of the row. Short amounts fit
          under the cap and render exactly as before. */}
      <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 0, maxWidth: '60%' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: positiveTone ? 'var(--success)' : 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {staking
            ? staking.amountText === ''
              ? ''
              : masked
                ? MASKED
                : staking.amountText
            : `${isIn ? '+' : '-'}${masked ? MASKED : fmtAmount(tx.amount)} ${shownAsset}`}
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

/**
 * The list's EDIT MODE, per row. Off = the row is the plain tappable row it has
 * always been, byte for byte; on = a drag handle appears on the left and a
 * checkbox on the right, and the row itself stops being a link (an accidental
 * tap while arranging a list must not navigate away).
 */
interface RowEditProps {
  /** Edit mode is on for the list. */
  editing: boolean;
  /** May this row be dragged / moved? False for the native coin, which is first
   *  by construction (computeDisplayedAssets) and cannot be anywhere else. */
  draggable: boolean;
  /** May this row be ticked for removal? False for a protected asset
   *  (isRemovableAsset), which is also the rule the asset detail's remove
   *  button follows. */
  selectable: boolean;
  selected: boolean;
  onToggleSelect(name: string): void;
  /** Keyboard alternative to dragging: Up/Down (or Alt+Up/Down) on the handle
   *  moves the row. A drag-only control is unusable with a keyboard, a switch,
   *  or a screen reader. */
  onHandleKeyDown(e: React.KeyboardEvent, name: string): void;
  onHandlePointerDown(e: React.PointerEvent, name: string): void;
  /** Registers the handle element so a keyboard move can put focus back on it
   *  after the row has been re-rendered in its new place. */
  handleRef(name: string, el: HTMLButtonElement | null): void;
  /** 1-based position among the reorderable rows, and how many there are, for
   *  the handle's accessible name ("Move USDC, position 2 of 9"). */
  position: number;
  total: number;
  /** True while THIS row is the one being dragged. */
  dragging: boolean;
}

function BalanceRow({
  asset,
  price,
  change24h,
  masked,
  onSelect,
  staked,
  nativeTicker,
  compact,
  edit,
}: {
  asset: LiveAssetBalance;
  price?: number;
  /** 24h move in percent for this asset (2.4 = +2.4%), when the feed knows one. */
  change24h?: number;
  /** Privacy mode: amounts read as dots. */
  masked?: boolean;
  onSelect?: (name: string) => void;
  /** Absent on every screen that does not offer the list's edit mode. */
  edit?: RowEditProps;
  /** Present only for SATORIEVR when the wallet is registered with a pool. */
  staked?: { poolAlias: string | null; poolAddress: string };
  /** Active chain's native ticker; gates the Evrmore-only "legacy SATORI" pill. */
  nativeTicker: string;
  /** The dense list of a short viewport (`home-tight`). Everything else about
   *  the density is CSS (the --token-* scale in global.css); the MARK has to be
   *  a prop because TokenIcon sizes its frame inline, exactly like the hero
   *  mark above. The mark is the tallest thing in the row, so 24 rather than 26,
   *  with the 4px padding and 5px gap from that same scale, is what puts the row
   *  at 34px and the list at a 39px pitch (it was 42 and 48). */
  compact?: boolean;
}) {
  // Secondary USD value for this row — only when a price exists for the asset.
  const usd = usdValue(amountToNumber(asset.amountBase, asset.scale), price);
  // The name as it is DRAWN. On an EVM chain `asset.name` IS the ERC-20's own
  // symbol() answer, so every visible use of it goes through the sanitiser
  // (services/displaySymbol.ts). `asset.name` stays raw everywhere it is an
  // IDENTITY: the data-testids (the drag-reorder code parses the row name back
  // out of live-asset-row-*), the registry lookups, the selection set and every
  // callback below.
  const shownName = displaySymbol(asset.name);
  const editing = !!edit?.editing;
  // Edit mode drops the SECONDARY numbers (the ≈ fiat value and the 24h chip)
  // and keeps the bold amount. The handle and the checkbox need about 58px of
  // the row's width, and taking them from decoration rather than from the
  // symbol is what keeps a long spam name from colliding with the balance at
  // 400px. Nothing is lost: this mode is for arranging and pruning the list,
  // and one tap on the same button brings the full row back.
  const showSecondary = !editing;
  // The row is a clickable button surface (role=button rather than a <button>
  // element, which keeps it free to hold interactive children). Enter/Space
  // activate it. In EDIT MODE it is inert: the handle and the checkbox are the
  // only live things in it, so a mis-tap while dragging cannot navigate away.
  return (
    <div
      className={editing ? 'token-row token-row-edit' : 'token-row'}
      role={editing ? undefined : 'button'}
      tabIndex={editing ? undefined : 0}
      onClick={editing ? undefined : () => onSelect?.(asset.name)}
      onKeyDown={
        editing
          ? undefined
          : (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect?.(asset.name);
              }
            }
      }
      aria-label={editing ? undefined : `Open ${shownName} details`}
      data-testid={`live-asset-row-${asset.name}`}
      data-dragging={edit?.dragging ? 'true' : undefined}
      style={{
        cursor: editing ? 'default' : 'pointer',
        textAlign: 'left',
        width: '100%',
        // The row being dragged rides above its neighbours and dims slightly, so
        // the drop position reads at a glance.
        opacity: edit?.dragging ? 0.75 : undefined,
        borderColor: edit?.dragging ? 'var(--accent)' : undefined,
      }}
    >
      {editing && (
        <button
          type="button"
          ref={(el) => {
            edit?.handleRef(asset.name, el);
          }}
          disabled={!edit?.draggable}
          className="asset-edit-grip"
          data-testid={`live-asset-handle-${asset.name}`}
          aria-label={
            edit?.draggable
              ? `Move ${shownName}, position ${edit.position} of ${edit.total}. Use the up and down arrow keys.`
              : `${shownName} is always first and cannot be moved`
          }
          title={edit?.draggable ? `Drag to reorder ${shownName}` : `${shownName} is always first`}
          onPointerDown={(e) => edit?.onHandlePointerDown(e, asset.name)}
          onKeyDown={(e) => edit?.onHandleKeyDown(e, asset.name)}
          onClick={(e) => e.stopPropagation()}
          // Exactly the size of the coin mark beside it (the --token-* scale's
          // 24 in the dense popup, 26 elsewhere), which is what keeps edit mode
          // from making a single row taller than the list already is.
          style={{ width: compact ? 24 : 26, height: compact ? 24 : 26 }}
        >
          <GripVertical size={14} />
        </button>
      )}
      <TokenIcon assetId={asset.name} size={compact ? 24 : 26} />
      <div
        className="token-name"
        style={{ flex: 1, minWidth: '3.5em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shownName}</span>
        <UntrustedTokenBadge symbol={asset.name} />
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
          maxWidth cap and the name's minWidth floor keep a readable name beside
          a funded (very wide) balance. At a zero or normal balance the content
          fits and nothing clips. The cap is 68% rather than the old 62%: the
          row's remove button is gone (removing lives on the asset's detail
          screen now), so that space belongs to the numbers. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexShrink: 1, maxWidth: editing ? '40%' : '68%', overflow: 'hidden', whiteSpace: 'nowrap' }}>
        <span
          className="token-amount"
          style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
          data-testid={`live-balance-${asset.name}`}
          title={masked ? undefined : `${fmtFull(asset.amountBase, asset.scale)} ${shownName}`}
        >
          {masked ? MASKED : fmtBase(asset.amountBase, asset.scale)}
        </span>
        {showSecondary && usd != null && (
          <span
            className="text-dim token-meta"
            data-testid={`live-asset-usd-${asset.name}`}
            style={{ minWidth: 0 }}
          >
            ≈ {masked ? MASKED : fmtUsd(usd)}
          </span>
        )}
        {/* 24h move, only for an asset whose feed publishes one. Never a "0.0%"
            placeholder when the change is unknown: that would read as a flat
            day, which is a different claim. The hero total stays unchanged —
            one number cannot honestly summarise a mixed portfolio's day. */}
        {showSecondary && change24h != null && (
          <span
            className="token-meta"
            data-testid={`live-asset-change-${asset.name}`}
            title={`24h change: ${fmtChange(change24h)}`}
            style={{
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
              // Rounded, so the colour agrees with the digits shown: a -0.04%
              // day prints "0.0%" and is painted neutral, not as a loss or a gain.
              color:
                Math.round(change24h * 10) / 10 < 0
                  ? 'var(--danger)'
                  : Math.round(change24h * 10) / 10 > 0
                    ? 'var(--success)'
                    : 'var(--text-dim)',
            }}
          >
            {fmtChange(change24h)}
          </span>
        )}
      </div>
      {editing && (
        // A REAL checkbox: it carries its own checked state, its own keyboard
        // behaviour and its own accessible role for free. The 16px box sits in
        // a 26px tappable label so the target clears the 24px floor even though
        // the mark itself is small.
        <label
          className="asset-edit-tick"
          style={{ width: compact ? 24 : 26, height: compact ? 24 : 26 }}
          title={
            edit?.selectable
              ? `Select ${shownName} for removal`
              : `${shownName} cannot be removed from this list`
          }
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            data-testid={`live-asset-select-${asset.name}`}
            checked={!!edit?.selected}
            disabled={!edit?.selectable}
            onChange={() => edit?.onToggleSelect(asset.name)}
            aria-label={
              edit?.selectable
                ? `Select ${shownName} for removal`
                : `${shownName} cannot be removed from this list`
            }
          />
        </label>
      )}
    </div>
  );
}

export function LiveHome({ onReceive, onSend, onSelectAsset, onSelectTx, onStake }: LiveHomeProps) {
  const address = useLiveStore((s) => s.address);
  const assets = useLiveStore((s) => s.assets);
  const pinnedAssets = useLiveStore((s) => s.pinnedAssets);
  const hiddenAssets = useLiveStore((s) => s.hiddenAssets);
  // The user's own row order (per wallet + per chain) and the two actions the
  // list's edit mode drives.
  const assetOrder = useLiveStore((s) => s.assetOrder);
  const setAssetOrder = useLiveStore((s) => s.setAssetOrder);
  const removeAssets = useLiveStore((s) => s.removeAssets);
  const txs = useLiveStore((s) => s.txs);
  const stakingEvents = useLiveStore((s) => s.stakingEvents);
  const prices = useLiveStore((s) => s.prices);
  const priceChanges24h = useLiveStore((s) => s.priceChanges24h);
  const network = useLiveStore((s) => s.network);
  const loadingRefresh = useLiveStore((s) => s.loadingRefresh);
  const offline = useLiveStore((s) => s.offline);
  const lock = useLiveStore((s) => s.lock);
  const refresh = useLiveStore((s) => s.refresh);
  const hideZeroBalances = useLiveStore((s) => s.hideZeroBalances);
  const hideBalances = useLiveStore((s) => s.hideBalances);
  const setHideBalances = useLiveStore((s) => s.setHideBalances);
  const setHideZeroBalances = useLiveStore((s) => s.setHideZeroBalances);
  const wallets = useLiveStore((s) => s.wallets);
  // Which password opens each wallet, for the switcher chips below. False on an
  // install that never set an app password, and then no such chip is rendered.
  const appPasswordSet = useLiveStore((s) => s.appPasswordSet);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const switchWallet = useLiveStore((s) => s.switchWallet);
  const removeWallet = useLiveStore((s) => s.removeWallet);
  const addWalletStart = useLiveStore((s) => s.addWalletStart);
  // EVM accounts on one seed (the EVM accounts design notes): adding the next
  // BIP44 index of the active seed, and scanning the chain for indexes that are
  // already in use (a MetaMask user importing their words expects Account 2+ to
  // be here without importing anything else).
  const addEvmAccount = useLiveStore((s) => s.addEvmAccount);
  const discoverEvmAccounts = useLiveStore((s) => s.discoverEvmAccounts);
  const clearEvmAccountScan = useLiveStore((s) => s.clearEvmAccountScan);
  const evmAccountScan = useLiveStore((s) => s.evmAccountScan);
  const syncing = useLiveStore((s) => s.syncing);
  const syncProgress = useLiveStore((s) => s.syncProgress);
  const lastSyncAt = useLiveStore((s) => s.lastSyncAt);
  const unreadActivity = useLiveStore((s) => s.unreadActivity);
  const markActivitySeen = useLiveStore((s) => s.markActivitySeen);
  const staking = useLiveStore((s) => s.staking);
  const refreshStaking = useLiveStore((s) => s.refreshStaking);
  // Native (cosmos/evm) staking, the OTHER staking: subscribed so the summary
  // line under the hero follows the store's cache. Both are read on every
  // chain; what they render is gated below.
  const evm = useLiveStore((s) => s.evm);
  const evmStaking = useLiveStore((s) => s.evmStaking);
  const refreshEvmStaking = useLiveStore((s) => s.refreshEvmStaking);
  // Owner-authored notifications: the list (already order-sorted by the gateway),
  // the dismissed set (dismissal KEYS, `id@rev`), and the actions to fetch and
  // dismiss. selectNotifications below narrows the list to this chain + version.
  const notifications = useLiveStore((s) => s.notifications);
  const dismissedNotificationKeys = useLiveStore((s) => s.dismissedNotificationKeys);
  const loadNotifications = useLiveStore((s) => s.loadNotifications);
  const dismissNotification = useLiveStore((s) => s.dismissNotification);

  const [showAddAsset, setShowAddAsset] = useState(false);
  const [showWalletMenu, setShowWalletMenu] = useState(false);
  const [deleteWalletId, setDeleteWalletId] = useState<string | null>(null);
  // Inline rename in the switcher (owner, 2026-08-19: "let the user rename
  // these accounts right in the list, simply"). One row at a time; Enter or
  // the check saves, Escape or the X cancels; an empty name is ignored (keeps
  // the old one), same as Settings.
  const renameWallet = useLiveStore((s) => s.renameWallet);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameValue(current);
  };
  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };
  const commitRename = async () => {
    const id = renamingId;
    const value = renameValue.trim();
    cancelRename();
    if (id && value) await renameWallet(id, value);
  };
  /** The editor that replaces a switcher row while it is being renamed. */
  const renameEditor = (i: number) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, padding: '4px 2px' }}>
      <input
        autoFocus
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commitRename();
          } else if (e.key === 'Escape') {
            // Escape here cancels the rename only; the menu's own Escape
            // (document listener) must not also close the menu under it.
            e.preventDefault();
            e.stopPropagation();
            cancelRename();
          }
        }}
        maxLength={40}
        aria-label="Account name"
        data-testid={`live-wallet-rename-input-${i}`}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          fontWeight: 600,
          padding: '7px 9px',
          borderRadius: 8,
          border: '1px solid var(--accent)',
          background: 'var(--card)',
          outline: 'none',
        }}
      />
      <button
        type="button"
        className="icon-btn"
        onClick={() => void commitRename()}
        aria-label="Save name"
        data-testid={`live-wallet-rename-save-${i}`}
        style={{ width: 30, height: 30, flexShrink: 0 }}
      >
        <Check size={14} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={cancelRename}
        aria-label="Cancel rename"
        data-testid={`live-wallet-rename-cancel-${i}`}
        style={{ width: 30, height: 30, flexShrink: 0 }}
      >
        <X size={14} />
      </button>
    </div>
  );
  /** The pencil next to a switcher row. */
  const renameButton = (id: string, name: string, i: number) => (
    <button
      type="button"
      className="icon-btn"
      onClick={() => startRename(id, name)}
      aria-label={`Rename ${name}`}
      title={`Rename ${name}`}
      data-testid={`live-wallet-rename-${i}`}
      style={{ width: 30, height: 30, flexShrink: 0, color: 'var(--text-dim)' }}
    >
      <Pencil size={13} />
    </button>
  );
  // Feedback for the two account actions inside the switcher. Local (not store)
  // state: both are answers to a click the user just made in this popover, and
  // they are meaningless once it closes — see the reset effect below.
  const [addAccountError, setAddAccountError] = useState<string | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);
  // The tab lives in LiveApp now: the bottom nav is rendered on every screen, so it
  // must be able to switch tab AND navigate home from, say, Settings.
  const { tab, openTab } = useNav();
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
  // Day headers for THIS page's rows. Grouped after pagination on purpose: the
  // header sits above the first row of its day *within the page*, so it can
  // never announce a day whose remaining rows are on the next page. `now` is
  // read here (not inside the helper) to keep that helper pure and testable.
  const activityDayGroups = useMemo(
    () => groupActivityByDay(activityItems, Date.now()),
    [activityItems],
  );

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
  const holdsSatori = assets.some((a) => a.name === 'SATORIEVR' && a.amountBase > 0n);
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

  // --- native staking on this chain (Epix and any future cosmos/evm chain) ---
  //
  // CAPABILITY, never a chain name: the SAME predicate LiveApp gates the Stake
  // screen with. On every other chain (Base, BSC, Ethereum, every UTXO chain)
  // this is null, and Home renders exactly as it did before: no action button,
  // no summary line, and the effect below makes no request at all.
  const stakeChain = evmStakingSupported() ? activeEvmChain({ evm }) : null;
  const stakeChainKey = stakeChain?.staking ? stakeChain.key : null;
  // A snapshot belongs to ONE chain: the store clears it on a chain or account
  // switch, but a read still in flight when the user leaves would otherwise
  // print another chain's figures under this hero.
  const stakeSnapshot =
    stakeChainKey && evmStaking.snapshot?.chainKey === stakeChainKey ? evmStaking.snapshot : null;
  const stakedBase = stakeSnapshot?.stakedTotalBase ?? 0n;
  const stakeRewardsBase = stakeSnapshot?.rewardsTotalBase ?? 0n;
  // Nothing staked and nothing earned means nothing to say: a fresh account
  // gets no row of zeros, and while the read is in flight it gets no spinner
  // in the hero either (the row simply is not there yet).
  const showStakeSummary = !!stakeSnapshot && (stakedBase > 0n || stakeRewardsBase > 0n);
  // What an Activity row needs to name a validator and format a staked amount.
  // Null on every chain without native staking, so TxRow behaves exactly as it
  // always did there. The monikers come from the SAME validators cache the
  // Stake screen fills; while it is empty a row falls back to the shortened
  // operator address and re-renders on its own when the read below lands.
  const stakingRowCtx = useMemo<StakingRowContext | null>(() => {
    if (!stakeChain) return null;
    const monikers = new Map((stakeSnapshot?.validators ?? []).map((v) => [v.valoper, v.moniker]));
    return {
      ticker: stakeChain.nativeTicker,
      decimals: stakeChain.nativeDecimals,
      monikerOf: (valoper: string) => monikers.get(valoper) || undefined,
    };
  }, [stakeChain, stakeSnapshot]);
  // One background read per (chain, account) while this screen is mounted.
  // Fire-and-forget, exactly like the Satori pool refresh above: it never
  // blocks or delays the balance read, and a REST failure lands in the
  // snapshot's own `issue` (which Home does not show) rather than anywhere
  // near the hero. No polling: the Stake screen refreshes on open, the store
  // re-reads after a staking transaction, and the manual Refresh in the header
  // is the deliberate way to ask again.
  const stakeReadFor = useRef<string | null>(null);
  useEffect(() => {
    if (!stakeChainKey || !address) return;
    const key = `${stakeChainKey}|${address}`;
    if (stakeReadFor.current === key) return;
    stakeReadFor.current = key;
    // A snapshot already cached for this chain and account is reused as it is.
    if (useLiveStore.getState().evmStaking.snapshot?.chainKey === stakeChainKey) return;
    void refreshEvmStaking();
  }, [stakeChainKey, address, refreshEvmStaking]);

  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  // Native ticker of the ACTIVE chain (follows svc.network(), independent of
  // whether `activeWallet` was found in the list) — drives the hero label/unit.
  const historyIssue = useLiveStore((s) => s.historyIssue);
  const historyLoading = useLiveStore((s) => s.historyLoading);
  const nativeTicker = nativeTickerFor();
  // EVERY owner-authored notice that applies right now, in the gateway's own
  // order. Matched against THIS wallet's active chain (activeChainIdentifier: a
  // UTXO ticker or EVM:<KEY>) and its own version (the same getAppVersion() the
  // footer shows), minus the ones already dismissed. The banner shows ONE at a
  // time and rotates through the rest itself (see NotificationBanner), so what
  // it needs is the whole matching set, not just the first of it.
  // `nativeTicker` is in the deps because it changes on every chain switch,
  // which is exactly when the chain identifier changes.
  const appVersion = getAppVersion();
  const activeNotifications = useMemo(
    () =>
      selectNotifications(notifications, {
        chainId: activeChainIdentifier(),
        version: appVersion,
        dismissedKeys: dismissedNotificationKeys,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notifications, dismissedNotificationKeys, appVersion, nativeTicker],
  );
  const hasNotice = activeNotifications.length > 0;
  // The asset list's scroll region, and whether it currently has rows below the
  // fold. Both feed the "more below" chevron under the list (the other half of
  // the affordance is the visible scrollbar the region now carries). Measured,
  // never guessed: the popup is a fixed 400x600 box, so whether the list
  // overflows depends on how many tokens this wallet holds.
  const { ref: assetScrollRef, more: moreAssetsBelow } = useMoreBelow();
  // Fetch notifications when Home mounts. FORCED (bypasses the throttle): the
  // popup remounts Home on every open, so opening the wallet after the owner
  // edits a notice shows the change at once. The auto-refresh tick keeps a
  // wallet left open current too. A no-op with no gateway.
  useEffect(() => {
    void loadNotifications({ force: true });
  }, [loadNotifications]);
  // Whether the active chain has an asset/token protocol at all — gates every
  // token affordance below (Add token, the Assets list chrome). Capability-
  // driven (never a hardcoded ticker check), so a future plain chain needs no
  // edits here.
  const canHoldAssets = assetsSupported();
  // Family of the ACTIVE wallet. An EVM account has no project homepage and no
  // young-chain notion in this build's registry (EvmChainInfo carries neither
  // field), and activeChainId() would otherwise name a STALE, idle UTXO chain
  // for it (see activeChainId's own doc comment) — so both are skipped outright
  // rather than computed from the wrong chain.
  const isEvmActive = activeFamily() === 'evm';
  // Human name of the chain in use (banners, wallet-name fallback). EVM-aware:
  // comes from the store's chain helper so a new chain (UTXO or EVM) names
  // itself with no edit here.
  const activeChainName = chainDisplayName();
  // Bare host (no scheme) reads better in a 400px popup than a full URL.
  const activeChainHomepage = isEvmActive ? null : networkFor(activeChainId()).homepage;
  const activeChainHomepageHost = activeChainHomepage
    ? activeChainHomepage.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    : '';
  const openChainHomepage = () => {
    // Only ever open an https origin, and never hand the new tab a window opener.
    if (!activeChainHomepage || !/^https:\/\//i.test(activeChainHomepage)) return;
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(activeChainHomepage, '_blank', 'noopener,noreferrer');
    }
  };
  // Caution notice for a young/thin network. Dismissal is deliberately NOT
  // persisted: it resets whenever the chain changes (and on every popup open),
  // so entering such a chain always says so once. The permanent record is the
  // "New" chip in the chain list, which never goes away.
  // BOTH FAMILIES. It used to be UTXO-only because the sentence said "little
  // mining power", which is a proof-of-WORK claim and would have been simply
  // untrue on a proof-of-stake chain like Epix. The owner's call (2026-08-26)
  // was to drop that clause rather than the notice: what the user needs to know
  // is that a young network can stop producing blocks and strand a payment,
  // which is true of a thin chain however it reaches consensus.
  const activeChainIsYoung = isEvmActive
    ? (activeEvmChain({ evm })?.young ?? false)
    : isYoungChain(networkFor(activeChainId()));
  const [youngNoticeDismissed, setYoungNoticeDismissed] = useState(false);
  useEffect(() => {
    setYoungNoticeDismissed(false);
  }, [activeChainName]);
  const activeWalletName = activeWallet?.name ?? `Real ${activeChainName} mainnet`;
  const activeIsPk = activeWallet?.kind === 'pk';
  const deleteTarget = wallets.find((w) => w.id === deleteWalletId) ?? null;
  // Accounts of the SAME seed as the wallet about to be deleted. Non-empty means
  // the seed survives this deletion in its other accounts, which changes what
  // the confirmation is allowed to claim (see the ConfirmModal below).
  const deleteSiblings = siblingAccounts(wallets, deleteTarget);

  // The switcher's rows, grouped: EVM seed accounts sit under one seed heading,
  // everything else is a row of its own. `rowIndexById` is the FLATTENED index
  // (headings take none) that `live-wallet-item-${i}` carries, so the ids stay
  // exactly what they were before grouping existed.
  // Chain scope twice over: only this chain's wallets, and within an EVM seed
  // only the accounts KNOWN on this chain (walletGroups.filterAccountsForChain:
  // index 0 and the active account always; a group with no data shows all).
  const evmAccountsOnChain = useLiveStore((s) => s.evmAccountsOnChain);
  const visibleWallets = filterAccountsForChain(walletsOnChain(wallets), evmAccountsOnChain, activeWalletId);
  const walletNodes = groupWallets(visibleWallets);
  const rowIndexById = new Map<string, number>(
    flattenGroups(walletNodes).map((w, i) => [w.id, i] as const),
  );
  const activeIsEvmSeed = isEvmSeedAccount(activeWallet);
  // Keeping a long switcher usable (owner, 2026-08-19: "after login the list is
  // a mass"): the seed you are IN shows its accounts; every OTHER seed is one
  // collapsed row ("N accounts") with a chevron, like the lock screen; and past
  // a handful of rows a search box filters by name or address (the filter
  // ignores collapsing). Toggles and the query reset when the menu closes.
  const totalRows = rowIndexById.size;
  const [walletQuery, setWalletQuery] = useState('');
  const [toggledGroups, setToggledGroups] = useState<Set<string>>(() => new Set());
  const WALLET_SEARCH_MIN_ROWS = 8;
  const walletSearchOn = totalRows > WALLET_SEARCH_MIN_ROWS;
  const query = walletQuery.trim().toLowerCase();
  const matchesQuery = (w: { name: string; address: string }, label?: string) =>
    !query ||
    w.name.toLowerCase().includes(query) ||
    (label ?? '').toLowerCase().includes(query) ||
    w.address.toLowerCase().includes(query);
  const toggleGroup = (key: string) =>
    setToggledGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const closeWalletMenu = () => {
    setShowWalletMenu(false);
    setWalletQuery('');
    setToggledGroups(new Set());
  };

  const selectWallet = (id: string) => {
    setShowWalletMenu(false);
    if (id !== activeWalletId) {
      // Switching the wallet/account lands on the WALLET tab (owner,
      // 2026-08-19: it is the wallet's main page): staying on Activity showed
      // the new account through the lens of the old question.
      if (tab !== 'assets') openTab('assets');
      void switchWallet(id);
    }
  };

  // Add the next account of the active seed. Stays on this screen (same seed =
  // no re-unlock), so the popover closes onto a Home already showing it.
  const handleAddAccount = async () => {
    if (addingAccount) return;
    setAddAccountError(null);
    setAddingAccount(true);
    const res = await addEvmAccount();
    setAddingAccount(false);
    if (!res.ok) {
      setAddAccountError(res.error);
      return;
    }
    setShowWalletMenu(false);
  };

  // Ask the chain which accounts of this seed are already in use. A find is
  // reported by the Home banner (the switcher closes so it is visible); "nothing
  // found" and a failed check are answered right here, where the click was.
  const handleDiscoverAccounts = async () => {
    if (evmAccountScan.scanning) return;
    setDiscoverNote(null);
    const res = await discoverEvmAccounts();
    if (!res.ok) {
      setDiscoverNote(`Could not check accounts: ${res.error ?? 'unknown error'}`);
      return;
    }
    if (res.added > 0) {
      setShowWalletMenu(false);
      return;
    }
    setDiscoverNote('No other used accounts found on this seed.');
  };

  // Both notices answer a click in the popover, so closing it clears them.
  useEffect(() => {
    if (!showWalletMenu) {
      setAddAccountError(null);
      setDiscoverNote(null);
    }
  }, [showWalletMenu]);

  // Escape closes the wallet menu — parity with the chain switcher's popover,
  // which already does this. Without it Escape was a dead key on this menu
  // while working one control to the right, which reads as a bug.
  useEffect(() => {
    if (!showWalletMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowWalletMenu(false);
        setWalletQuery('');
        setToggledGroups(new Set());
        setRenamingId(null);
        setRenameValue('');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showWalletMenu]);

  // Dynamic (MetaMask-style) list: held ∪ pinned − hidden, the native coin always
  // first (EVR on Evrmore, RVN on Ravencoin — computeDisplayedAssets always flags
  // it `isNative`, so this reads correctly on either chain).
  //
  // MEMBERSHIP comes from the store (persisted pins/hides, one set of rules,
  // its own tests); ORDER is decided here by orderAssetsForDisplay, because it
  // depends on two things the store does not own: live USD values and the token
  // trust registry. `registryVersion` is what makes the list re-sort when those
  // verdicts land — trustFor reads many symbols, so there is no single symbol to
  // subscribe to.
  const registryVersion = useTokenRegistryVersion();
  const displayAssets = useMemo(() => {
    const rows = computeDisplayedAssets(assets, pinnedAssets, hiddenAssets);
    const byName = new Map(rows.map((r) => [r.name, r]));
    const auto = orderAssetsForDisplay(rows, {
      usdFor: (name) => {
        const row = byName.get(name);
        return row
          ? usdValue(amountToNumber(row.amountBase, row.scale), priceForAsset(row, prices))
          : null;
      },
      trustFor: (name) => tokenTrustFor(name),
    });
    // The user's arrangement LAST, so it overrides the automatic one for the
    // rows it names and leaves every other row exactly where the automatic
    // order put it (a token that arrived after the last drag lands after the
    // arranged rows, in today's default position among them).
    return applyManualOrder(auto, assetOrder);
    // `registryVersion` is in the list for its EFFECT, not its value: it changes
    // when the trust registry is replaced, which is what makes trustFor answer
    // differently. `nativeTicker` stands in for the active chain, which
    // computeDisplayedAssets reads from the service rather than from props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, pinnedAssets, hiddenAssets, assetOrder, prices, nativeTicker, registryVersion]);
  const nativeRow = displayAssets.find((a) => a.isNative);
  const firstLoad = loadingRefresh && assets.length === 0;

  // "Hide zero balances": a VIEW filter over the rows above, applied last so
  // pins, hides and ordering are unaffected. The native coin is never dropped —
  // an empty wallet must still show the coin it is a wallet for, and hiding it
  // would leave a chain-less blank list. The totals below deliberately keep
  // counting every displayed asset: what the wallet is worth cannot depend on
  // how the list is filtered.
  const visibleAssets = hideZeroBalances
    ? displayAssets.filter((a) => a.isNative || a.amountBase !== 0n)
    : displayAssets;
  const hiddenZeroCount = displayAssets.length - visibleAssets.length;

  // -------------------------------------------------------------------------
  // EDIT MODE for the asset list (owner, 2026-08-25: an edit icon beside the
  // Assets label; pressing it puts a drag handle and a tick beside every token,
  // so the list can be REORDERED and several tokens removed in one action).
  //
  // Off by default and never sticky: it is a mode you are in for a few seconds,
  // so it ends on the same button, on Escape, on leaving the tab, and on any
  // wallet or chain switch (the rows underneath would be a different set).
  // -------------------------------------------------------------------------
  const [editingAssets, setEditingAssets] = useState(false);
  const [selectedAssets, setSelectedAssets] = useState<ReadonlySet<string>>(() => clearSelection());
  const [confirmRemoveAssets, setConfirmRemoveAssets] = useState(false);
  // The row being dragged right now, and the arrangement the drag is building.
  // Both are LOCAL and last only until the pointer is released: an unfinished
  // drag is not state the store, or storage, has any business seeing. The
  // committed order goes to the store once, on drop.
  const [draggingAsset, setDraggingAsset] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const assetHandleRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusHandle, setFocusHandle] = useState<string | null>(null);
  // The scroll region's real node, for the drag's edge auto-scroll. useMoreBelow
  // hands back a CALLBACK ref, so the node is captured on the way through.
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const setAssetScrollNode = useCallback(
    (el: HTMLDivElement | null) => {
      listRegionRef.current = el;
      assetScrollRef(el);
    },
    [assetScrollRef],
  );

  // What the list actually renders. Identical to `visibleAssets` except while a
  // drag is in flight, when the half-finished arrangement is shown instead (the
  // same pure function the committed order goes through, so what you see during
  // the drag is exactly what is saved at the end of it).
  const listAssets = useMemo(
    () => (dragOrder ? applyManualOrder(visibleAssets, dragOrder) : visibleAssets),
    [visibleAssets, dragOrder],
  );
  // Names in the order the list currently shows them, native excluded (the
  // native coin is first by construction and is not part of any arrangement).
  const orderableVisible = useMemo(() => orderableNames(listAssets), [listAssets]);
  const selectedNames = useMemo(
    () => orderableVisible.filter((name) => selectedAssets.has(name)),
    [orderableVisible, selectedAssets],
  );

  const exitAssetEdit = useCallback(() => {
    setEditingAssets(false);
    // Functional updates so an exit that changes nothing (the effect below fires
    // on mount too) does not schedule a pointless render.
    setSelectedAssets((prev) => (prev.size === 0 ? prev : clearSelection()));
    setConfirmRemoveAssets(false);
    setDraggingAsset(null);
    setDragOrder(null);
  }, []);

  // Leaving the tab, switching account, or switching EVM chain all end the mode.
  // (A UTXO chain switch IS an account switch, so activeWalletId covers it.)
  const evmChainKey = evm.activeChainKey;
  useEffect(() => {
    exitAssetEdit();
  }, [tab, activeWalletId, evmChainKey, exitAssetEdit]);

  // Escape leaves edit mode. Registered only while it is on, so it cannot steal
  // the key from the wallet menu or a modal.
  useEffect(() => {
    if (!editingAssets) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A confirmation on top owns Escape first: one press closes it, a second
      // leaves the mode.
      if (confirmRemoveAssets) {
        setConfirmRemoveAssets(false);
        return;
      }
      exitAssetEdit();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editingAssets, confirmRemoveAssets, exitAssetEdit]);

  // A row can vanish under an open selection (a refresh, a removal made
  // elsewhere): never keep a tick for something that is no longer on screen.
  useEffect(() => {
    if (!editingAssets) return;
    setSelectedAssets((prev) => pruneSelection(prev, orderableVisible));
  }, [editingAssets, orderableVisible]);

  // Put focus back on the handle after a KEYBOARD move: the row is re-rendered
  // in its new place, and a control that loses focus after every press cannot
  // be used to move a row more than once.
  useEffect(() => {
    if (!focusHandle) return;
    assetHandleRefs.current.get(focusHandle)?.focus();
    setFocusHandle(null);
  }, [focusHandle, visibleAssets]);

  /** Persist an arrangement of the VISIBLE rows. Rows the "hide zero balances"
   *  filter is holding back keep their entries, appended, so toggling that
   *  filter never silently discards part of the order. */
  const commitAssetOrder = useCallback(
    (nextVisible: string[]) => {
      const seen = new Set(nextVisible);
      const rest = orderableNames(displayAssets).filter((n) => !seen.has(n));
      setAssetOrder([...nextVisible, ...rest]);
    },
    [displayAssets, setAssetOrder],
  );

  /** Move one row by `delta` places (the keyboard alternative to dragging). */
  const moveAssetBy = useCallback(
    (name: string, delta: number) => {
      const from = orderableVisible.indexOf(name);
      if (from < 0) return;
      const next = moveInOrder(orderableVisible, from, from + delta);
      if (next === orderableVisible) return;
      commitAssetOrder(next);
      setFocusHandle(name);
    },
    [orderableVisible, commitAssetOrder],
  );

  const handleAssetHandleKey = useCallback(
    (e: React.KeyboardEvent, name: string) => {
      // Alt+Arrow is the convention MOST reorderable lists use; the bare arrows
      // are accepted too, because the handle is a button and arrows do nothing
      // else on it. Home/End jump to the ends of the list.
      if (e.key === 'ArrowUp') moveAssetBy(name, -1);
      else if (e.key === 'ArrowDown') moveAssetBy(name, 1);
      else if (e.key === 'Home') moveAssetBy(name, -orderableVisible.length);
      else if (e.key === 'End') moveAssetBy(name, orderableVisible.length);
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    [moveAssetBy, orderableVisible.length],
  );

  // --- pointer drag (mouse AND touch, one code path) -------------------------
  // No library, and no HTML5 drag-and-drop either: `dragstart` does not exist on
  // touch, and this has to work with a finger in a 400px popup. Pointer events
  // are the one API that covers mouse, touch and pen at once.
  //
  // A pointer down on a handle starts a drag; every move compares the pointer
  // against the MIDPOINTS of the rows on screen and splices the dragged name
  // into its new place (locally, so the list follows the finger); the release
  // commits that arrangement to the store, which persists it. Auto-scroll runs
  // while the pointer sits in a band at the top or bottom edge of the scroll
  // region, so a list longer than the popup can be rearranged end to end.
  //
  // The window listeners are STABLE (deps: []) and reach anything that changes
  // through refs. A handler that changed identity with `displayAssets` would be
  // torn down and re-added by its own effect mid-drag, on the next background
  // refresh, and the drag would die under the user's finger.
  const dragState = useRef<{ name: string; order: string[]; y: number } | null>(null);
  const autoScrollTimer = useRef<number | null>(null);
  const commitOrderRef = useRef(commitAssetOrder);
  commitOrderRef.current = commitAssetOrder;
  // The identities the window listeners are registered under. Declared here so
  // both callbacks below can reach each other's current value.
  const onAssetDragMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const endAssetDragRef = useRef<() => void>(() => {});

  const stopAutoScroll = useCallback(() => {
    if (autoScrollTimer.current !== null) {
      clearInterval(autoScrollTimer.current);
      autoScrollTimer.current = null;
    }
  }, []);

  /** Where each row's vertical middle is right now, read from the live DOM
   *  (the rows may have just moved). Keyed by asset name, taken off the row's
   *  own testid so a token whose name is full of "(" and "$" needs no escaping. */
  const rowMidpoints = useCallback(() => {
    const mids = new Map<string, number>();
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid^="live-asset-row-"]')) {
      const name = (el.dataset.testid ?? '').slice('live-asset-row-'.length);
      const r = el.getBoundingClientRect();
      mids.set(name, r.top + r.height / 2);
    }
    return mids;
  }, []);

  const endAssetDrag = useCallback(() => {
    stopAutoScroll();
    const state = dragState.current;
    dragState.current = null;
    window.removeEventListener('pointermove', onAssetDragMoveRef.current);
    window.removeEventListener('pointerup', endAssetDragRef.current);
    window.removeEventListener('pointercancel', endAssetDragRef.current);
    setDraggingAsset(null);
    setDragOrder(null);
    // ONE write, at the end of the gesture: dragging past twenty rows must not
    // mean twenty writes to storage.
    if (state) commitOrderRef.current(state.order);
  }, [stopAutoScroll]);

  const onAssetDragMove = useCallback(
    (e: PointerEvent) => {
      const state = dragState.current;
      const region = listRegionRef.current;
      if (!state) return;
      state.y = e.clientY;
      // Edge auto-scroll: inside the band, scroll away from the edge on a timer
      // (the pointer may sit perfectly still there and still need to travel).
      if (region) {
        const r = region.getBoundingClientRect();
        const inBand = e.clientY < r.top + DRAG_EDGE_BAND || e.clientY > r.bottom - DRAG_EDGE_BAND;
        if (inBand && autoScrollTimer.current === null) {
          autoScrollTimer.current = window.setInterval(() => {
            const cur = dragState.current;
            const box = listRegionRef.current;
            if (!cur || !box) {
              stopAutoScroll();
              return;
            }
            const rr = box.getBoundingClientRect();
            const dir =
              cur.y < rr.top + DRAG_EDGE_BAND ? -1 : cur.y > rr.bottom - DRAG_EDGE_BAND ? 1 : 0;
            if (dir === 0) {
              stopAutoScroll();
              return;
            }
            box.scrollTop += dir * DRAG_EDGE_STEP;
          }, 16);
        } else if (!inBand) {
          stopAutoScroll();
        }
      }
      const mids = rowMidpoints();
      const from = state.order.indexOf(state.name);
      if (from < 0) return;
      let to = from;
      // Walk towards whichever neighbour's midpoint the pointer has passed.
      const midOf = (i: number) => mids.get(state.order[i]) ?? Number.NaN;
      while (to > 0 && e.clientY < midOf(to - 1)) to -= 1;
      while (to < state.order.length - 1 && e.clientY > midOf(to + 1)) to += 1;
      if (to === from) return;
      state.order = moveInOrder(state.order, from, to);
      setDragOrder(state.order);
    },
    [rowMidpoints, stopAutoScroll],
  );

  onAssetDragMoveRef.current = onAssetDragMove;
  endAssetDragRef.current = endAssetDrag;

  const onAssetHandlePointerDown = useCallback(
    (e: React.PointerEvent, name: string) => {
      // Primary button / touch / pen only: a right-click must not start a drag.
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = { name, order: [...orderableVisible], y: e.clientY };
      setDraggingAsset(name);
      window.addEventListener('pointermove', onAssetDragMoveRef.current);
      window.addEventListener('pointerup', endAssetDragRef.current);
      window.addEventListener('pointercancel', endAssetDragRef.current);
    },
    [orderableVisible],
  );

  // Never leave listeners (or an auto-scroll timer) behind on unmount.
  useEffect(
    () => () => {
      stopAutoScroll();
      window.removeEventListener('pointermove', onAssetDragMoveRef.current);
      window.removeEventListener('pointerup', endAssetDragRef.current);
      window.removeEventListener('pointercancel', endAssetDragRef.current);
    },
    [stopAutoScroll],
  );

  const registerAssetHandle = useCallback((name: string, el: HTMLButtonElement | null) => {
    if (el) assetHandleRefs.current.set(name, el);
    else assetHandleRefs.current.delete(name);
  }, []);

  const toggleAssetSelected = useCallback((name: string) => {
    setSelectedAssets((prev) => toggleAssetSelection(prev, name, isRemovableAsset(name)));
  }, []);

  /** Hide every ticked token, through the SAME store path the asset detail
   *  screen's "Remove from list" uses (removeAsset is one call to removeAssets),
   *  so "removed" cannot come to mean two different things. */
  const removeSelectedAssets = () => {
    const names = selectedNames;
    setConfirmRemoveAssets(false);
    if (names.length === 0) return;
    removeAssets(names);
    setSelectedAssets(clearSelection());
  };

  // A LIST WORTH MAKING ROOM FOR (owner, live testing 2026-08-25: "you can see
  // only one token and have to scroll it, it looks very bad when someone has a
  // lot of tokens"). Measured in the 400x600 toolbar popup before the change:
  // the coin mark, the balance, the total and the Send/Receive row take 270 of
  // the 394px the screen has, the list is squeezed to its 64px floor and
  // exactly ONE 42px row is visible. Three rows is where that starts to hurt,
  // so from there the hero gives way and the list takes the pixels back; below
  // it the roomy hero is kept, which is the short-list look the owner asked for
  // yesterday.
  //
  // BOTH conditions, never one: a SHORT viewport is what makes the trade
  // necessary (a side panel is a whole browser window tall and has room for the
  // roomy hero AND the rows), and a LONG list is what makes it worth making.
  const shortViewport = useShortViewport();
  const tightList = canHoldAssets && shortViewport && visibleAssets.length >= TIGHT_LIST_ROWS;

  // Total portfolio USD = sum of (amount × price) over the priced displayed
  // assets (the chain's own coin, plus SATORIEVR on Evrmore). `hasPrice` gates
  // whether we show it at all — with no prices loaded yet we render nothing
  // rather than a bogus $0.00.
  const hasPrice = displayAssets.some((a) => priceForAsset(a, prices) != null);
  const totalUsd = displayAssets.reduce((sum, a) => {
    const v = usdValue(amountToNumber(a.amountBase, a.scale), priceForAsset(a, prices));
    return v != null ? sum + v : sum;
  }, 0);

  // ONE status surface: the block pill's dot + the sync-status text beside it,
  // both driven by deriveSyncStatus. The separate brand-row LED was removed
  // (owner request): it repeated the exact state this dot already shows. That
  // makes driving the pill from the DERIVED ledState — not from the raw
  // network.state as before — load-bearing: 'stale' (chain stopped producing
  // blocks) used to ride only on that LED, and it must stay visible here.
  // Red = unreachable, pulsing yellow = downloading wallet data, steady
  // yellow = stale chain tip, green = fully synced. See deriveSyncStatus for
  // the priority order between these signals.
  // Tip age is computed HERE, not inside the derivation, so that stays pure.
  const tipAgeMs = network?.tipTime != null ? Date.now() - network.tipTime : null;
  const syncStatus = deriveSyncStatus({
    offline,
    loadingRefresh,
    syncing,
    network,
    syncProgress,
    lastSyncAt,
    tipAgeMs,
  });
  const ledState = syncStatus.ledState;
  // Mapping lives in syncStatus.ts so the compact pill on the Activity and
  // Settings tabs cannot drift from this one.
  const pillState = pillStateFor(ledState, network?.state);

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
    /* `frame-tight` is `home-tight`'s other half. The compact rules that buy
       the asset list its height live on .app-content, and the header and the
       bottom nav are that element's SIBLINGS, so no selector rooted there can
       reach them. Stamping the frame under the SAME condition keeps it one
       decision instead of two that can drift: see the .frame-tight block in
       global.css for what it actually trims (padding, a row gap and a line
       box; no control, label or glyph). Unlike `home-tight` it is not scoped to
       the assets tab, so switching tabs never moves the header or the nav. */
    <div
      className={`app-frame screen-enter${tightList ? ' frame-tight' : ''}`}
      data-testid="live-home"
    >
      {/* Header, in MetaMask's order: NETWORK left, WALLET centre, ACTIONS
          right. The 34px Satori mark and the "Satori GO" wordmark left this row
          when the wallet became its centrepiece: the two pickers used to sit
          side by side and collided as soon as the side panel was dragged
          narrow, and the wordmark was spending exactly the width the chain name
          and the wallet name need at 320px. The brand still names itself on the
          lock screen and in the footer at the bottom of this screen.
          NO status LED here (owner request): it duplicated the state dot the
          block pill below already shows, and the sync-status text sits on that
          same pill row — one status surface instead of two. */}
      <div className="app-header">
        {/* Network switcher: mounted here only. Self-contained (own trigger +
            popover) — see ChainSwitcher.tsx. */}
        <ChainSwitcher />
        {/* Centre: the wallet switcher, ONE line tall like the chain pill and
            the icon buttons beside it (the header is a grid: row 1 is the three
            controls at one height, row 2 is the address centred under them).
            The address is a SEPARATE button: clicking it copies and must not
            open the wallet menu, and a button cannot live inside a button. */}
        <button
          type="button"
          className="wallet-switcher"
          onClick={() => (showWalletMenu ? closeWalletMenu() : (setWalletQuery(''), setToggledGroups(new Set()), setShowWalletMenu(true)))}
          data-testid="live-wallet-switcher"
          /* The name is in the label, not only in the button's text: this is
             now the header's identity control, so a screen reader has to say
             WHICH wallet it would switch away from. */
          aria-label={`Switch wallet, ${activeWalletName}`}
          aria-haspopup="true"
          aria-expanded={showWalletMenu}
        >
          {/* The account's own identicon, the same mark its row carries in
              every list (switcher, lock screen, Settings) — the thing the eye
              matches on before it reads the name. */}
          <AccountAvatar address={address} seed={activeWalletId ?? undefined} size={20} />
          {activeIsPk && <BrandLogo slot="satori" size={12} alt="Satori" />}
          <span className="wallet-switcher-text">{activeWalletName}</span>
          <ChevronDown size={12} style={{ flexShrink: 0 }} />
        </button>
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
        {/* Row 2: THE address of this wallet, the only one on Home, centred
            under the name. Click to copy the whole thing (shown truncated). */}
        {address && <HeaderAddress address={address} />}
      </div>

      {/* Wallet switcher dropdown. SCOPED TO THE ACTIVE CHAIN: the chain you are
          on decides which wallets exist here, so this lists siblings you can
          switch between without leaving the chain. Crossing chains is the chain
          switcher's job, and it already lands on that chain's wallet, so an
          unscoped list here offered a second, silent way to change chain from a
          control that does not say it changes chain. */}
      {showWalletMenu && (
        /* Anchored under the CENTRED trigger. Centring is done with
           left:0/right:0 + margin:0 auto, never translateX(-50%): .menu-pop
           animates popIn, whose keyframes own `transform`, so a transform set
           here would be dropped for the length of the animation and the menu
           would visibly fly in from the wrong place. The containing block is
           .app-frame (position:absolute), so this is the frame's centre at every
           panel width, and `calc(100% - 64px)` is still the frame's height. */
        <div
          className="menu-pop"
          data-testid="live-wallet-dropdown"
          style={{
            left: 0,
            right: 0,
            margin: '0 auto',
            width: 'min(360px, calc(100% - 28px))',
            top: 52,
            maxHeight: 'calc(100% - 64px)',
            overflowY: 'auto',
          }}
        >
          {walletSearchOn && (
            <div style={{ padding: '2px 4px 6px' }}>
              <input
                value={walletQuery}
                onChange={(e) => setWalletQuery(e.target.value)}
                placeholder="Search name or address"
                aria-label="Search wallets and accounts"
                data-testid="live-wallet-search"
                autoComplete="off"
                style={{
                  width: '100%',
                  fontSize: 12,
                  padding: '7px 9px',
                  borderRadius: 8,
                  border: '1px solid var(--border-strong)',
                  background: 'var(--card)',
                  outline: 'none',
                }}
              />
            </div>
          )}
          {walletNodes.map((node, ni) => {
            if (node.kind === 'single') {
              const w = node.wallet;
              const i = rowIndexById.get(w.id) ?? 0;
              if (!matchesQuery(w)) return null;
              // Each row's OWN chain (not the active chain) drives its badge: any
              // wallet whose native ticker isn't the default (Evrmore) gets an
              // icon + ticker chip, so a Ravencoin, Bitcoin Gold, or future
              // non-Evrmore wallet is distinguishable in the switcher.
              //
              // An EVM wallet's stored `network` is the 'evm' sentinel, never a
              // real chain id, so nativeTickerFor(w.network) must NEVER be called
              // for one — it would resolve against the ACTIVE EVM chain instead
              // of this row's own wallet. 'EVM' is shown directly instead.
              const isEvmRow = w.family === 'evm';
              const walletTicker = isEvmRow ? 'EVM' : nativeTickerFor(w.network);
              const isOtherChain = isEvmRow || walletTicker !== 'EVR';
              if (renamingId === w.id) {
                return (
                  <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    {renameEditor(i)}
                  </div>
                );
              }
              return (
                <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <button
                    type="button"
                    onClick={() => selectWallet(w.id)}
                    data-testid={`live-wallet-item-${i}`}
                    style={{ gap: 7, flex: 1, minWidth: 0 }}
                  >
                    {/* Identicon first on EVERY row: it is the per-account mark
                        the eye matches on. A Satori (pk) wallet keeps its brand
                        mark next to it — that says which KIND of wallet it is,
                        which the identicon cannot. */}
                    <AccountAvatar address={w.address} seed={w.id} size={16} />
                    {w.kind === 'pk' && <BrandLogo slot="satori" size={16} alt="Satori" />}
                    {isOtherChain && <TokenIcon assetId={walletTicker} size={16} />}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {w.name}
                    </span>
                    <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>
                      {w.kind === 'pk' ? 'Satori' : 'Seed'}
                    </span>
                    {isOtherChain && (
                      <span
                        className="chip neutral"
                        data-testid={`live-wallet-item-chain-${i}`}
                        style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}
                      >
                        {walletTicker}
                      </span>
                    )}
                    {w.passwordless && (
                      <span className="chip warning" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>No pw</span>
                    )}
                    {/* §6: a wallet that migrated from passwordless keeps "do
                        not ask when sending" but loses `passwordless`, so this
                        row showed nothing at all for a wallet that still spends
                        with nothing typed. */}
                    {!w.passwordless && w.noSendPassword && (
                      <span className="chip warning" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>Sends without pw</span>
                    )}
                    {appPasswordSet && (
                      <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>
                        {w.appProtected ? 'App pw' : 'Own pw'}
                      </span>
                    )}
                    {w.active && <Check size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />}
                  </button>
                  {renameButton(w.id, w.name, i)}
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
              );
            }
            // One seed, its accounts under it. The heading is not selectable (it
            // is the seed, not an address), so it takes no row index.
            const isActiveGroup = activeIsEvmSeed && node.members.some((m) => m.id === activeWalletId);
            // The seed you are in is open unless you fold it; any other seed is
            // folded unless you open it. A search overrides both.
            const collapsible = node.members.length > 1;
            const expanded = query || !collapsible ? true : isActiveGroup ? !toggledGroups.has(node.key) : toggledGroups.has(node.key);
            const visibleMembers = node.members.filter((w) => matchesQuery(w, memberLabel(w, node.title, node.members.length)));
            if (query && visibleMembers.length === 0) return null;
            return (
              <div key={`group-${node.key}`}>
                <button
                  type="button"
                  data-testid={`live-wallet-group-${ni}`}
                  aria-expanded={collapsible ? expanded : undefined}
                  aria-label={collapsible ? `${expanded ? 'Fold' : 'Unfold'} the accounts of ${node.title}` : node.title}
                  onClick={() => { if (collapsible) toggleGroup(node.key); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 8px 3px',
                    minWidth: 0,
                    width: '100%',
                    background: 'none',
                    border: 'none',
                    cursor: collapsible ? 'pointer' : 'default',
                  }}
                >
                  <TokenIcon assetId="EVM" size={14} />
                  <span
                    className="text-faint"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 9.5,
                      letterSpacing: 0.3,
                      textTransform: 'uppercase',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textAlign: 'left',
                    }}
                  >
                    {node.title}
                  </span>
                  {!expanded && (
                    <span className="text-faint" style={{ fontSize: 9.5, flexShrink: 0 }} data-testid={`live-wallet-group-count-${ni}`}>
                      {node.members.length} {node.members.length === 1 ? 'account' : 'accounts'}
                    </span>
                  )}
                  <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>
                    Seed
                  </span>
                  {collapsible && (
                    <ChevronDown
                      size={13}
                      className="text-faint"
                      style={{ flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
                    />
                  )}
                </button>
                {expanded && visibleMembers.map((w) => {
                  const i = rowIndexById.get(w.id) ?? 0;
                  if (renamingId === w.id) {
                    return (
                      <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 8 }}>
                        {renameEditor(i)}
                      </div>
                    );
                  }
                  return (
                    <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 8 }}>
                      <button
                        type="button"
                        onClick={() => selectWallet(w.id)}
                        data-testid={`live-wallet-item-${i}`}
                        style={{ gap: 7, flex: 1, minWidth: 0 }}
                      >
                        {/* Accounts of one seed differ ONLY by address, so the
                            identicon is the fastest way to tell them apart. */}
                        <AccountAvatar address={w.address} seed={w.id} size={16} />
                        <span
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'flex-start',
                            gap: 1,
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          <span
                            style={{
                              maxWidth: '100%',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {memberLabel(w, node.title, node.members.length)}
                          </span>
                          {w.address && (
                            <span
                              className="mono"
                              style={{ fontSize: 9, color: 'var(--text-faint)' }}
                              data-testid={`live-account-address-${i}`}
                            >
                              {shortAccountAddress(w.address)}
                            </span>
                          )}
                        </span>
                        <span
                          className="chip neutral"
                          data-testid={`live-wallet-item-chain-${i}`}
                          style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}
                        >
                          EVM
                        </span>
                        {w.passwordless && (
                          <span className="chip warning" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>No pw</span>
                        )}
                        {!w.passwordless && w.noSendPassword && (
                          <span className="chip warning" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>Sends without pw</span>
                        )}
                        {appPasswordSet && (
                          <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>
                            {w.appProtected ? 'App pw' : 'Own pw'}
                          </span>
                        )}
                        {w.active && <Check size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />}
                      </button>
                      {renameButton(w.id, w.name, i)}
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
                  );
                })}
                {/* Account actions belong to the seed you are IN: adding or
                    scanning needs that seed unlocked, and only the active one
                    is. "Add wallet" below stays the way to a different seed. */}
                {isActiveGroup && expanded && !query && (
                  <div style={{ paddingLeft: 8 }}>
                    <button
                      type="button"
                      onClick={() => void handleAddAccount()}
                      data-testid="live-add-account"
                      disabled={addingAccount}
                      style={{ gap: 7 }}
                    >
                      {addingAccount ? (
                        <span className="spinner" style={{ width: 13, height: 13, flexShrink: 0 }} />
                      ) : (
                        <Plus size={14} />
                      )}
                      Add account
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDiscoverAccounts()}
                      data-testid="live-discover-accounts"
                      disabled={evmAccountScan.scanning}
                      style={{ gap: 7 }}
                    >
                      {evmAccountScan.scanning ? (
                        <span className="spinner" style={{ width: 13, height: 13, flexShrink: 0 }} />
                      ) : (
                        <Search size={14} />
                      )}
                      {evmAccountScan.scanning ? 'Checking accounts…' : 'Discover accounts'}
                    </button>
                    {addAccountError && (
                      <p
                        role="alert"
                        data-testid="live-add-account-error"
                        style={{ fontSize: 10, color: 'var(--danger)', margin: '2px 8px 4px', lineHeight: 1.4 }}
                      >
                        {addAccountError}
                      </p>
                    )}
                    {discoverNote && (
                      <p
                        data-testid="live-discover-note"
                        className="text-faint"
                        style={{ fontSize: 10, margin: '2px 8px 4px', lineHeight: 1.4 }}
                      >
                        {discoverNote}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
        /* Outside-click closer. FIXED (not absolute) for the same reason as
           the chain switcher's overlay: absolute anchors to whichever ancestor
           happens to be positioned and did not cover the whole popup, leaving
           dead zones where a click neither closed the menu nor did anything
           else. z-index below the menu-pop (50) so the menu itself stays
           clickable. */
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 49 }}
          onClick={() => { closeWalletMenu(); cancelRename(); }}
        />
      )}

      <div
        /* `home-roomy` on a chain with no token list: the balance and the two
           primary actions grow into the space the list would have occupied,
           instead of leaving the screen looking half-empty.
           `home-centered` is the same idea for a chain that DOES have a list:
           the whole block (hero, actions, Assets label, list) is centred in the
           leftover height with flex auto margins, rises as tokens are added and
           flows from the top the moment it outgrows the panel. See the
           .home-centered rules in global.css; both classes are presentational
           only and the markup is identical on every chain.
           `has-notice` is the third of the same kind: while an owner-authored
           notice is on screen it drops the centred block's TOP auto margin, so
           the hero hugs the notice instead of centring in the height left under
           it (owner, 2026-08-25). Absent when there is no notice, which is what
           keeps the plain case exactly as it was. */
        className={
          tab === 'assets'
            ? `app-content home-pinned${canHoldAssets ? ' home-centered' : ' home-roomy'}${
                hasNotice ? ' has-notice' : ''
              }${tightList ? ' home-tight' : ''}`
            : 'app-content'
        }
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

        {/* Young-network caution. Stated in terms of what can actually happen to
            the user's coins, not as a vague "be careful": a thin chain can stop
            producing blocks, and then a transaction simply never confirms. */}
        {activeChainIsYoung && !youngNoticeDismissed && (
          <div
            className="banner warning"
            style={{ marginBottom: 10, alignItems: 'flex-start' }}
            data-testid="live-young-chain-notice"
          >
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              {activeChainName} is a young network. It can stop producing blocks,
              and a payment then stays unconfirmed until it recovers. Keep only
              what you can afford to lose here.
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setYoungNoticeDismissed(true)}
              aria-label="Dismiss"
              data-testid="live-young-chain-dismiss"
              style={{ flexShrink: 0 }}
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Accounts found on this seed. Only a FIND is announced here: it added
            entries the user never asked for by name, so it has to say where they
            went. "Nothing found" and a failed check are answered inside the
            switcher, next to the button that asked. */}
        {evmAccountScan.added != null && evmAccountScan.added > 0 && (
          <div
            className="banner info"
            style={{ marginBottom: 10, alignItems: 'flex-start' }}
            data-testid="live-accounts-found"
          >
            <Search size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              Found {evmAccountScan.added} more{' '}
              {evmAccountScan.added === 1 ? 'account' : 'accounts'} on this seed. They are in the
              wallet switcher.
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => clearEvmAccountScan()}
              aria-label="Dismiss"
              data-testid="live-accounts-found-dismiss"
              style={{ flexShrink: 0 }}
            >
              <X size={13} />
            </button>
          </div>
        )}

        {tab === 'assets' ? (
          <>
            {/* Network status + address. The chain-name line that used to sit
                under the pill is GONE (owner request): the chain is already
                named — with its coin mark — in the header's chain-switcher
                chip, so stating it twice bought nothing. */}
            {/* This row is the top edge of the assets tab and stays put: the
                centred block below (see .home-centered) is centred in the space
                UNDER it, which is also where it sits on a chain with no list.
                Its testid is what the smoke measures that free space from. */}
            <div
              data-testid="live-home-status"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                // The break under the status row. On the compact popup the pill
                // already carries 4px of its own padding, so 6 more is a band
                // of nothing between two things that belong together.
                marginBottom: tightList ? 3 : 6,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                {/* Sync text beside the block pill (owner's placement): the
                    pill says where the chain tip is, the label says whether
                    THIS wallet is caught up to it, so one glance answers
                    both. minWidth:0 + ellipsis is a last-resort guard against
                    implausible digit widths, not an expected state. When
                    offline the pill itself already reads "Offline", so the
                    label (whose derivation would also say "Offline") is
                    skipped instead of echoed beside it. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  {loadingRefresh && !network ? (
                    <Skeleton width={110} height={26} radius={999} />
                  ) : (
                    /* Inline .pill markup rather than <StatusPill>: the pill's
                       dot IS the app's one connection LED now (the brand-row
                       LED is gone), so it needs the live-led testid, a
                       data-state, and the derived 'stale' state — none of
                       which StatusPill's NetworkState contract carries. */
                    <span
                      className={`pill state-${pillState}`}
                      data-testid="live-network-pill"
                      title={syncStatus.tooltip}
                    >
                      <span
                        className="dot"
                        data-testid="live-led"
                        data-state={ledState}
                        aria-hidden
                      />
                      {offline
                        ? 'Offline'
                        : network
                        ? `Block ${network.blockHeight.toLocaleString()}`
                        : 'Connecting…'}
                    </span>
                  )}
                  {!offline && (
                    <>
                      <span aria-hidden="true" style={{ fontSize: 9.5, color: 'var(--text-faint)', flexShrink: 0 }}>
                        ·
                      </span>
                      <span
                        data-testid="sync-status"
                        title={syncStatus.tooltip}
                        style={{
                          fontSize: 9.5,
                          // A stalled chain must not read like routine faint
                          // metadata: "No block 6h 12m" gets the warning color
                          // to match the pill dot beside it.
                          fontWeight: ledState === 'stale' ? 600 : 400,
                          color: ledState === 'stale' ? 'var(--warning)' : 'var(--text-faint)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          minWidth: 0,
                        }}
                      >
                        {syncStatus.label}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* The project's own site. The address that used to sit above it
                  (with its own copy button) is GONE from this row: Home printed
                  the same address twice, and the header's line is now the one
                  address — click it to copy. Several chain names sit close to
                  better-known coins ("BitcoinGold" is NOT the 2017 BTG), so the
                  domain is what actually tells the user which project they are
                  on, and where to go read about it. */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flexShrink: 0 }}>
                {/* No project homepage for an EVM account: it is one address
                    across every EVM chain, not a single chain's own project. */}
                {activeChainHomepage && (
                  <button
                    type="button"
                    className="text-faint"
                    onClick={openChainHomepage}
                    title={`Open ${activeChainHomepageHost} in a new tab`}
                    data-testid="live-chain-homepage"
                    style={{
                      fontSize: 9.5,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      whiteSpace: 'nowrap',
                      background: 'none',
                      border: 0,
                      cursor: 'pointer',
                      textAlign: 'right',
                    }}
                  >
                    {activeChainHomepageHost}
                    <ExternalLink size={9} />
                  </button>
                )}
              </div>
            </div>

            {/* Owner-authored notice, right under the Block / Synced row (owner's
                placement 2026-08-25: more room here than over the coin, and the
                centred block below just shifts down). Top-anchored above the
                centred hero, not inside it. Renders nothing when there is none,
                so nothing shifts on a wallet with no notice. Shown regardless of
                privacy mode: a notice is not balance data. It takes the WHOLE
                matching set and rotates through it one at a time; the container
                also carries `has-notice` above, which pulls the hero up to it
                instead of letting it float in the middle of what is left. */}
            {hasNotice && (
              <NotificationBanner
                notifications={activeNotifications}
                onDismiss={(key) => void dismissNotification(key)}
              />
            )}

            {/* Wrapper exists so a chain with no token list can centre the whole
                balance + actions block in the leftover height (see .home-roomy).
                On a chain WITH assets it is an inert div and changes nothing. */}
            <div className="home-hero-wrap">
            {/* Hero balance — the .hero pattern. Its testid is the fixed
                'live-balance-hero', NOT live-balance-<ticker>: the asset row
                below also emits live-balance-<ticker> for the native coin, so
                the parametrised id here made every strict-mode locator on the
                native balance throw on a duplicate. The name never collides
                with an asset row either: asset names are uppercase on-chain
                tickers, never 'hero'.
                The id no longer affects how this value LOOKS. It used to: the
                row's amount was sized by `.live-scope [data-testid^=
                'live-balance-']`, which matched the hero as well and, at equal
                specificity but later in global.css, beat `.live-scope
                .hero-value`, so on a chain with an asset list the side panel
                and the detached window rendered this figure at 12.5px. That
                rule is now scoped to `.token-row .token-amount`, and sizing
                here is `.hero-value`'s job alone. */}
            <div className="hero">
              {/* On a chain with no token list the coin's own mark leads the hero:
                  it fills space the list would have used and names the chain at a
                  glance. Chains WITH a list already show the coin in its row, so
                  repeating it there would just be noise. */}
              {/* The big coin mark above the hero, on EVERY chain. It used to
                  show only where no asset list follows (BTC/LTC/DOGE); the
                  owner wanted the same face on Epix and the rest (2026-08-25):
                  one look, whatever the chain. */}
              {/* The mark's size is a PROP, not a stylesheet rule (TokenIcon
                  sizes its frame inline), so the compact figure lives here
                  beside the class that names the same state. 36 keeps the coin
                  recognisable while giving the list back 28px of its 74. */}
              <div className="hero-mark" data-testid="live-hero-mark">
                <TokenIcon assetId={nativeTicker} size={tightList ? 36 : 64} />
              </div>
              <div className="hero-label">{nativeTicker} Balance</div>
              {firstLoad ? (
                <Skeleton width={160} height={36} style={{ margin: '4px auto' }} />
              ) : (
                <div
                  className="hero-value"
                  data-testid="live-balance-hero"
                  title={hideBalances || !nativeRow ? undefined : `${fmtFull(nativeRow.amountBase, nativeRow.scale)} ${nativeTicker}`}
                >
                  {hideBalances ? MASKED : nativeRow ? fmtBase(nativeRow.amountBase, nativeRow.scale) : '0'}
                  {/* Ticker scales with the roomy hero so it stays proportional. */}
                  <span
                    style={{
                      fontSize: canHoldAssets ? 16 : 18,
                      fontWeight: 500,
                      marginLeft: 8,
                      color: 'var(--text-dim)',
                    }}
                  >
                    {nativeTicker}
                  </span>
                  {/* Privacy mode (MetaMask's eye): one tap masks every amount
                      on Home (hero, total, rows, activity); persisted. */}
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setHideBalances(!hideBalances)}
                    aria-pressed={hideBalances}
                    aria-label={hideBalances ? 'Show balances' : 'Hide balances'}
                    title={hideBalances ? 'Show balances' : 'Hide balances'}
                    data-testid="live-hide-balances"
                    // The eye rides INSIDE the balance line, so its box is what
                    // sets that line's height: at 26px it, not the 21px figure,
                    // was the tallest thing in the compact hero.
                    style={{
                      width: tightList ? 22 : 26,
                      height: tightList ? 22 : 26,
                      marginLeft: 6,
                      verticalAlign: 'middle',
                      color: 'var(--text-faint)',
                    }}
                  >
                    {hideBalances ? <EyeOff size={tightList ? 13 : 14} /> : <Eye size={tightList ? 13 : 14} />}
                  </button>
                </div>
              )}
              {!firstLoad && hasPrice && (
                <div
                  data-testid="live-total-usd"
                  style={{
                    // INLINE, and therefore the only place this value can be
                    // set: a `.home-tight [data-testid='live-total-usd']` rule
                    // in global.css lost to this declaration every time and
                    // shipped as dead weight for two releases. The compact
                    // figure sits beside the roomy one instead.
                    marginTop: tightList ? 1 : 6,
                    display: 'inline-flex',
                    alignItems: 'baseline',
                    gap: 6,
                    justifyContent: 'center',
                  }}
                >
                  {/* Same micro-label treatment as the hero label above it
                      (uppercase comes from CSS text-transform, so innerText
                      keeps the authored casing). */}
                  <span className="hero-label">Total balance</span>
                  <span
                    data-testid="total-balance"
                    style={{ fontSize: tightList ? 13.5 : 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {hideBalances ? MASKED : fmtUsd(totalUsd)}
                  </span>
                </div>
              )}
              {/* What this account has STAKED, under the balance it can spend.
                  The hero figure above is untouched: it is the spendable
                  balance, and staked coins are not spendable. Shown only when
                  there is something to say (a delegation or a pending reward),
                  so a fresh account sees no row of zeros and a read in flight
                  shows nothing rather than a spinner in the hero. */}
              {showStakeSummary && stakeChain && (
                <button
                  type="button"
                  className="text-dim"
                  data-testid="live-stake-summary"
                  onClick={() => onStake?.()}
                  aria-label="Open staking"
                  title={
                    hideBalances
                      ? undefined
                      : `Staked ${fmtFull(stakedBase, stakeChain.nativeDecimals)} ${stakeChain.nativeTicker} · Rewards ${fmtFull(stakeRewardsBase, stakeChain.nativeDecimals)} ${stakeChain.nativeTicker}`
                  }
                  style={{
                    display: 'block',
                    margin: tightList ? '4px auto 0' : '8px auto 0',
                    background: 'none',
                    border: 0,
                    padding: '2px 4px',
                    cursor: 'pointer',
                    fontSize: tightList ? 11 : 11.5,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  Staked {hideBalances ? MASKED : fmtBase(stakedBase, stakeChain.nativeDecimals)} {stakeChain.nativeTicker}
                  {' · '}
                  Rewards {hideBalances ? MASKED : fmtBase(stakeRewardsBase, stakeChain.nativeDecimals)}
                </button>
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
              {/* Stake, beside Send and Receive and with the same weight, on a
                  chain whose registry row carries `staking` (owner, 2026-08-24:
                  it belongs on the main screen, not only inside the coin's
                  detail). It opens the SAME screen the asset detail does. */}
              {stakeChainKey && (
                <button
                  type="button"
                  className="action-round"
                  onClick={() => onStake?.()}
                  data-testid="live-action-stake"
                >
                  <div className="action-circle">
                    <Landmark size={20} />
                  </div>
                  Stake
                </button>
              )}
            </div>
            </div>{/* /home-hero-wrap */}

            {/* Token rows — only on a chain with an asset protocol. On a plain
                chain (e.g. Bitcoin Gold) there is no "Add token" action and no
                asset-list chrome to imply tokens exist: the hero above already
                shows the whole balance, so this section is skipped entirely. */}
            {canHoldAssets && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="section-label">Assets</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  {/* Edit the list: reorder by dragging (or with the keyboard),
                      and tick several tokens to remove them in one action. A
                      MODE, not a screen, so the same button leaves it and its
                      pressed state is the only thing saying you are in it. */}
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => (editingAssets ? exitAssetEdit() : setEditingAssets(true))}
                    aria-pressed={editingAssets}
                    title={editingAssets ? 'Done editing the list' : 'Edit the list: reorder or remove tokens'}
                    aria-label={editingAssets ? 'Done editing the list' : 'Edit the list: reorder or remove tokens'}
                    data-testid="live-assets-edit"
                    style={{
                      width: tightList ? 24 : 26,
                      height: tightList ? 24 : 26,
                      color: editingAssets ? 'var(--accent-text)' : undefined,
                      background: editingAssets ? 'var(--accent-soft)' : undefined,
                    }}
                  >
                    {editingAssets ? <Check size={14} /> : <Pencil size={13} />}
                  </button>
                  {/* Hide zero balances. Persisted globally through the store, so
                      the choice survives a lock, a chain switch and a restart. */}
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setHideZeroBalances(!hideZeroBalances)}
                    aria-pressed={hideZeroBalances}
                    title={hideZeroBalances ? 'Show zero balances' : 'Hide zero balances'}
                    aria-label={hideZeroBalances ? 'Show zero balances' : 'Hide zero balances'}
                    data-testid="live-hide-zero"
                    // The ASSETS band is as tall as the tallest control in it,
                    // so both of them have to give for the row to give: this
                    // one loses 2px of box around a 14px glyph, "Add token"
                    // below loses 2px of vertical padding.
                    style={{ width: tightList ? 24 : 26, height: tightList ? 24 : 26 }}
                  >
                    <ListFilter size={14} style={{ color: hideZeroBalances ? 'var(--accent-text)' : undefined }} />
                  </button>
                  {/* Add token: an asset NAME on a Ravencoin-family chain (verified via
                      Electrum get_meta), a token CONTRACT ADDRESS on an EVM chain
                      (symbol and decimals read from the chain). LiveAddAsset and
                      the store's addAsset branch on the family. */}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowAddAsset(true)}
                    data-testid="live-add-asset"
                    style={{ padding: tightList ? '2px 8px' : '4px 8px' }}
                  >
                    <Plus size={13} /> Add token
                  </button>
                </div>
              </div>
            )}
            {/* ONLY this region scrolls when the asset list grows. The footer
                rides at its end so it scrolls with the rows and never hides the
                last row. Everything above (hero, Send/Receive, Assets + Add
                token) stays pinned in place. */}
            {/* With no asset list the scroll area would be empty and the footer
                would float at its top, leaving a large dead gap above the nav.
                `no-assets` pushes the footer to the bottom instead. */}
            <div ref={setAssetScrollNode} className={canHoldAssets ? 'home-scroll' : 'home-scroll no-assets'}>
              {!canHoldAssets ? null : firstLoad ? (
                <>
                  <TokenRowSkeleton />
                  <div style={{ marginTop: 9 }}>
                    <TokenRowSkeleton />
                  </div>
                </>
              ) : (
                <div className="stack">
                  {listAssets.map((asset, i) => (
                    <BalanceRow
                      masked={hideBalances}
                      key={asset.name}
                      asset={asset}
                      price={priceForAsset(asset, prices)}
                      change24h={priceChanges24h[asset.name]}
                      onSelect={onSelectAsset}
                      nativeTicker={nativeTicker}
                      compact={tightList}
                      edit={
                        editingAssets
                          ? {
                              editing: true,
                              // The native coin is first by construction and is
                              // neither draggable nor removable; a protected
                              // token (SATORIEVR, an EVM default) can be moved
                              // but not removed, which is the same rule the
                              // asset detail's remove button follows.
                              draggable: !asset.isNative,
                              selectable: !asset.isNative && isRemovableAsset(asset.name),
                              selected: selectedAssets.has(asset.name),
                              onToggleSelect: toggleAssetSelected,
                              onHandleKeyDown: handleAssetHandleKey,
                              onHandlePointerDown: onAssetHandlePointerDown,
                              handleRef: registerAssetHandle,
                              position: i, // 1-based among the reorderable rows (native is row 0)
                              total: orderableVisible.length,
                              dragging: draggingAsset === asset.name,
                            }
                          : undefined
                      }
                      staked={
                        asset.name === 'SATORIEVR' && isStakedSatori && stakedPoolAddress
                          ? { poolAlias: stakedPoolAlias, poolAddress: stakedPoolAddress }
                          : undefined
                      }
                    />
                  ))}
                  {/* The edit mode's own bar, INSIDE the scroll region so it
                      rides at the end of the rows and never covers the last one.
                      It appears only once something is ticked: an empty bar
                      would just be a band of dead chrome above the footer. */}
                  {editingAssets && (
                    <div className="asset-edit-bar" data-testid="live-assets-edit-bar">
                      {selectedNames.length === 0 ? (
                        <span className="text-dim">
                          Drag a handle to reorder. Tick tokens to remove them.
                        </span>
                      ) : (
                        <>
                          <span data-testid="live-assets-selected-count">
                            {selectionLabel(selectedNames.length)}
                          </span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm danger"
                            onClick={() => setConfirmRemoveAssets(true)}
                            data-testid="live-assets-remove-selected"
                          >
                            <Trash2 size={13} /> Remove {selectedNames.length} from the list
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {/* Never a silent loss: say how many rows the filter took out,
                      and let that line put them back. */}
                  {hiddenZeroCount > 0 && (
                    <button
                      type="button"
                      className="text-dim"
                      onClick={() => setHideZeroBalances(false)}
                      data-testid="live-hidden-zero-note"
                      style={{
                        display: 'block',
                        width: '100%',
                        marginTop: 6,
                        padding: '4px 2px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 11,
                        textAlign: 'center',
                      }}
                    >
                      {hiddenZeroCount} token{hiddenZeroCount === 1 ? '' : 's'} with zero balance hidden
                    </button>
                  )}
                </div>
              )}
              {footer}
            </div>
            {/* "More below" chevron. Anchored to the BOTTOM of this container
                (the screen's own padding band), so it sits under the last row
                rather than over it, and it is inert to the pointer. It shows
                only while the region above genuinely has content below the
                fold. See components/ScrollMoreCue.tsx. */}
            <ScrollMoreCue more={moreAssetsBelow} testId="live-home-scroll-cue" />
          </>
        ) : tab === 'network' ? (
          <>
            <LiveNetwork />
            {footer}
          </>
        ) : (
          <>
          <div data-testid="live-activity-list">
            {/* Section label + connection state on one row. Without the pill an
                empty Activity list is ambiguous: "no transactions" and "not
                connected" look identical (KNOWN_LIMITATIONS item 33). */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginTop: 2,
              }}
            >
              <div className="section-label" style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                Activity
                {historyLoading && mergedActivity.length > 0 && (
                  <span
                    className="spinner"
                    style={{ width: 10, height: 10, flexShrink: 0 }}
                    data-testid="live-activity-refreshing"
                    title="Checking for new activity"
                    aria-label="Checking for new activity"
                  />
                )}
              </div>
              <SyncStatusPill />
            </div>
            {(loadingRefresh || historyLoading) && mergedActivity.length === 0 ? (
              <div style={{ padding: '12px 0' }} data-testid="live-activity-loading">
                <Skeleton height={44} style={{ marginBottom: 4 }} />
                <Skeleton height={44} />
                <div
                  className="text-faint"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 11, marginTop: 10 }}
                >
                  <span className="spinner" style={{ width: 12, height: 12, flexShrink: 0 }} />
                  Loading activity…
                </div>
              </div>
            ) : mergedActivity.length === 0 ? (
              historyIssue ? (
                // History is knowingly unavailable (no indexer for this chain, or
                // the server refused): say that, never "no transactions yet".
                <EmptyState
                  icon={<Wifi size={20} />}
                  title={/ is behind:/.test(historyIssue.message) ? 'Activity delayed' : 'Activity unavailable'}
                  description={historyIssue.message}
                />
              ) : (
                <EmptyState
                  icon={<Wifi size={20} />}
                  title="No transactions yet"
                  description={
                    stakingSupported()
                      ? `Activity will appear here once you send or receive ${nativeTicker}, or stake to a pool.`
                      : `Activity will appear here once you send or receive ${nativeTicker}.`
                  }
                />
              )
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
                    {/* Day headers between the rows: "Today" / "Yesterday" /
                        "14 Aug 2026", grouped over THIS page's rows only (the
                        grouping is applied after pagination, so a header never
                        promises rows that live on the next page). Every row
                        keeps its own testid and the pagination is untouched. */}
                    <div>
                      {activityDayGroups.map((group) => (
                        <div className="activity-day-group" key={`${group.slug}-${group.items[0].id}`}>
                          <div
                            className="section-label activity-day"
                            data-testid={`live-activity-day-${group.slug}`}
                          >
                            {group.label}
                          </div>
                          {group.items.map((item: ActivityItem) =>
                            item.kind === 'tx' ? (
                              <TxRow
                                key={item.id}
                                tx={item.tx}
                                onOpen={onSelectTx}
                                masked={hideBalances}
                                stakingCtx={stakingRowCtx}
                              />
                            ) : (
                              <StakingEventRow key={item.id} event={item.event} />
                            ),
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Pages over the rows already held (10 per page,
                        ACTIVITY_PER_PAGE), plus "Load older", which asks the
                        chain's history source for a page it has not served
                        yet. Both live in ActivityPager so this tab and the
                        per-asset list on the token screen stay identical. */}
                    <ActivityPager
                      page={activityCurrentPage}
                      totalPages={activityTotalPages}
                      onPage={setActivityPage}
                      idPrefix="activity"
                    />
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
          /* An account of a seed that has other accounts is NOT the seed: the
             words stay on this device in its siblings, and re-adding the index
             brings this address back. Saying "you will lose access" there would
             be false. The last account of a seed IS the seed, so that case keeps
             the backup warning. */
          description={
            deleteSiblings.length > 0
              ? `Removes ${deleteTarget.name} only. The seed stays in its other ${
                  deleteSiblings.length === 1 ? 'account' : 'accounts'
                } and the same recovery phrase restores this account again.`
              : 'This deletes the wallet from this device. Without its recovery phrase/private key you will lose access.'
          }
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

      {/* Multi-remove confirmation. It says in plain words what "remove" means
          here, because the word is frightening next to a balance: the row is
          hidden from THIS list, the coins are untouched on chain, and "Add
          token" brings the row back. Same mechanism as the asset detail
          screen's own remove (both go through removeAssets). */}
      {confirmRemoveAssets && selectedNames.length > 0 && (
        <ConfirmModal
          title={`Remove ${selectedNames.length} token${selectedNames.length === 1 ? '' : 's'} from the list?`}
          description={removalDescription(selectedNames)}
          confirmLabel={`Remove ${selectedNames.length}`}
          cancelLabel="Cancel"
          danger
          testId="live-assets-remove-modal"
          onConfirm={removeSelectedAssets}
          onCancel={() => setConfirmRemoveAssets(false)}
        />
      )}
    </div>
  );
}
