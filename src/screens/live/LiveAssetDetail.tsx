// Per-asset detail screen — shown when a row on the Live home is clicked.
// Displays one asset's logo, name and balance, and offers Receive / Send.
// Sending is enabled for EVR and every issued asset (asset transfers pay an EVR fee).

import { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, Info, Landmark, Trash2 } from 'lucide-react';
import { ActivityPager } from '../../components/ActivityPager';
import { TokenIcon } from '../../components/BrandLogo';
import { UntrustedTokenBanner } from '../../components/UntrustedTokenBadge';
import { SyncStatusPill } from '../../components/SyncStatusPill';
import { formatAmount } from '../../services/chain/amounts';
import { EmptyState } from '../../components/EmptyState';
import { useLiveStore, isRemovableAsset, nativeTickerFor, chainDisplayName } from '../../store/liveStore';
import { isLegacyAsset, getAssetNote } from '../../services/assetNotes';
import { displaySymbol } from '../../services/displaySymbol';
import { ACTIVITY_PER_PAGE, paginate } from '../../services/activityFeed';
import type { LiveAssetBalance, LiveTransaction } from '../../services/chain/electrumProvider';
import { LiveNav } from './LiveNav';
import { stakingRowLabel } from './stakingRowLabel';

interface LiveAssetDetailProps {
  asset: LiveAssetBalance;
  onBack(): void;
  onReceive(): void;
  onSend(): void;
  onSelectTx(txid: string): void;
  /** Open the staking screen for this chain. Provided ONLY for the asset that
   *  can be staked on the ACTIVE chain (SATORIEVR for Satori pool staking on
   *  Evrmore; the native coin on a chain with native staking, e.g. EPIX), and
   *  LiveApp is what decides which. When absent, the Stake action is not
   *  shown, and its absence is the whole gate. */
  onStake?(): void;
}

/** Human sub-label for an asset row. The chain's own displayName is used rather
 *  than a per-chain ternary, which used to fall through to "EVRmore asset" on
 *  every chain added after Ravencoin. */
function assetSubLabel(asset: LiveAssetBalance, nativeTicker: string, chainName: string): string {
  if (asset.name === nativeTicker) return chainName;
  if (asset.name.includes('SATORI')) return 'Satori Network';
  return `${chainName} asset`;
}

/** Format a whole-unit amount using the asset's declared decimal precision. */
function fmtWithDecimals(amount: number, decimals: number): string {
  if (amount === 0) return '0';
  const maxFractionDigits = Math.max(0, Math.min(decimals, 8));
  return amount.toLocaleString('en-US', { maximumFractionDigits: maxFractionDigits });
}

/** Compact activity row for one of this asset's transactions. */
function AssetTxRow({
  tx,
  decimals,
  onOpen,
  monikerOf,
}: {
  tx: LiveTransaction;
  decimals: number;
  onOpen(txid: string): void;
  monikerOf?: (valoper: string) => string | undefined;
}) {
  const isIn = tx.direction === 'in';
  // The ticker as it is DRAWN: on an EVM chain `tx.asset` is the token's own
  // symbol, so it is sanitised before it reaches the screen, including where it
  // is laundered through stakingRowLabel's amountText.
  const shownAsset = displaySymbol(tx.asset);
  // Native staking: this asset's own list would otherwise show a delegation as
  // "Sent 0 EPIX", which is the one reading that is actively wrong.
  const staking = tx.staking ? stakingRowLabel(tx.staking, { ticker: shownAsset, decimals, monikerOf }) : null;
  const positiveTone = staking ? false : isIn;
  const arrowIn = staking ? staking.incoming : isIn;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(tx.txid)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(tx.txid);
        }
      }}
      aria-label={`Open transaction ${tx.txid.slice(0, 10)}`}
      data-testid={`live-tx-row-${tx.txid.slice(0, 8)}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 2px',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
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
          <span {...(staking ? { 'data-testid': `live-tx-staking-${tx.txid}` } : {})}>
            {staking ? staking.title : isIn ? 'Received' : 'Sent'}
          </span>
          {tx.status === 'pending' && (
            <span className="chip warning" style={{ fontSize: 9, padding: '1px 5px' }}>pending</span>
          )}
        </div>
        <div
          className="text-dim"
          style={{ fontSize: 10.5, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {staking ? staking.subtitle : new Date(tx.timestamp).toLocaleDateString()}
        </div>
      </div>
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          flexShrink: 0,
          color: positiveTone ? 'var(--success)' : 'var(--text)',
        }}
      >
        {staking
          ? staking.amountText
          : `${isIn ? '+' : '-'}${fmtWithDecimals(tx.amount, decimals)} ${shownAsset}`}
      </div>
    </div>
  );
}

export function LiveAssetDetail({ asset, onBack, onReceive, onSend, onSelectTx, onStake }: LiveAssetDetailProps) {
  const removeAsset = useLiveStore((s) => s.removeAsset);
  const txs = useLiveStore((s) => s.txs);
  const stakingStatuses = useLiveStore((s) => s.staking.addressStatuses);
  // Validator names for a native-staking row below, from the same cache the
  // Stake screen fills. Undefined on every chain without it, and a row then
  // names the validator by its shortened operator address.
  const stakeValidators = useLiveStore((s) => s.evmStaking.snapshot?.validators);
  const monikerOf = (valoper: string) => stakeValidators?.find((v) => v.valoper === valoper)?.moniker || undefined;
  const nativeTicker = nativeTickerFor();
  // The caller decides WHICH asset can be staked on this chain (see onStake):
  // re-checking the asset name here would hardcode Satori pool staking and hide
  // the action on every other kind, which is exactly what it used to do.
  const canStake = !!onStake;
  // "Staked" header chip when any SATORIEVR-holding address is registered with a
  // pool. Nice-to-have; only meaningful once the staking screen has fetched status.
  const isStaked = canStake && stakingStatuses.some((s) => s.poolAddress);

  // This asset's transactions only (case-insensitive on the on-chain name),
  // then one page of them. `paginate` clamps the page itself, so a page that
  // has gone out of range (the list shrank, or a chain switch emptied it)
  // resolves to a valid one rather than rendering blank.
  const assetName = asset.name.toUpperCase();
  // The asset as it is DRAWN. `asset.name` stays raw for the filter above, the
  // removal call, the data-testid and the icon lookup.
  const shownName = displaySymbol(asset.name);
  const assetTxs = useMemo(
    () => txs.filter((t) => t.asset.toUpperCase() === assetName),
    [txs, assetName],
  );
  const [page, setPage] = useState(1);
  const pageOfTxs = useMemo(() => paginate(assetTxs, page, ACTIVITY_PER_PAGE), [assetTxs, page]);

  const handleRemove = () => {
    removeAsset(asset.name);
    onBack();
  };

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>{shownName}</h2>
        {/* Connection state, same dot-only indicator as the rest of the wallet
            (KNOWN_LIMITATIONS item 33). */}
        <SyncStatusPill compact />
      </div>

      <div className="app-content" data-testid="live-asset-detail">
        {!asset.isNative && <UntrustedTokenBanner symbol={asset.name} />}
        {isLegacyAsset(asset.name, nativeTicker) && (
          <div
            className="banner info"
            data-testid="legacy-asset-banner"
            style={{ alignItems: 'flex-start' }}
          >
            <Info size={14} />
            <span>{getAssetNote(asset.name, nativeTicker)?.note}</span>
          </div>
        )}

        {/* Asset identity + balance hero */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: '10px 0 18px',
          }}
        >
          <TokenIcon assetId={asset.name} size={56} />
          {/* Title may wrap (a long asset name breaks onto lines instead of
              overflowing the centered header); the Staked chip stays on its own row. */}
          <div
            style={{
              fontWeight: 700,
              fontSize: 16,
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 8,
              maxWidth: '100%',
              wordBreak: 'break-word',
              textAlign: 'center',
            }}
          >
            {shownName}
            {isStaked && (
              <span className="chip" data-testid="live-asset-staked-chip" style={{ fontSize: 10 }}>
                Staked
              </span>
            )}
          </div>
          <div className="text-dim" style={{ fontSize: 12 }}>{assetSubLabel(asset, nativeTicker, chainDisplayName())}</div>
          <div
            className="hero-value"
            data-testid={`live-asset-detail-balance-${asset.name}`}
            style={{ marginTop: 4, maxWidth: '100%', textAlign: 'center', wordBreak: 'break-word' }}
          >
            {formatAmount(asset.amountBase, asset.scale, {
              grouping: true,
              // The asset's OWN divisions cap what is shown; `scale` is what the
              // number is stored in. They differ for an asset with divisions < 8.
              maxFractionDigits: Math.max(0, Math.min(asset.decimals, asset.scale)),
            })}
            <span style={{ fontSize: 15, fontWeight: 500, marginLeft: 8, color: 'var(--text-dim)' }}>
              {shownName}
            </span>
          </div>
        </div>

        {/* Primary actions */}
        {/* Send before Receive — the same order the Home screen uses. */}
        <div className="actions-row" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="action-round"
            onClick={onSend}
            data-testid="live-asset-detail-send"
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
            data-testid="live-asset-detail-receive"
          >
            <div className="action-circle">
              <ArrowDownLeft size={20} />
            </div>
            Receive
          </button>
          {canStake && (
            <button
              type="button"
              className="action-round"
              onClick={onStake}
              data-testid="live-stake-button"
            >
              <div className="action-circle">
                <Landmark size={20} />
              </div>
              Stake
            </button>
          )}
        </div>

        {/* EVR and SATORIEVR are never removable (PROTECTED_ASSETS). */}
        {isRemovableAsset(asset.name) && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleRemove}
            data-testid="live-asset-detail-remove"
            style={{ width: '100%', marginTop: 4 }}
          >
            <Trash2 size={13} /> Remove from list
          </button>
        )}

        {/* This asset's activity. PAGED, exactly like the main Activity tab
            (owner, live testing 2026-08-25: "there is no pagination in
            activities, I checked for USDT on EVM BNB" — this screen was the
            one that had none, and simply rendered every matching row in one
            unbroken scroll). Same page size, same controls, same "Load older"
            on the last page, because it is the same component. */}
        <div className="section-label" style={{ marginTop: 18 }}>Activity</div>
        <div data-testid="live-asset-activity">
          {assetTxs.length === 0 ? (
            <EmptyState
              icon={<ArrowDownLeft size={20} />}
              title={`No ${shownName} activity yet`}
              description={`Transactions involving ${shownName} will appear here.`}
            />
          ) : (
            <div>
              {pageOfTxs.items.map((tx) => (
                <AssetTxRow
                  key={tx.txid}
                  tx={tx}
                  decimals={asset.decimals}
                  onOpen={onSelectTx}
                  monikerOf={monikerOf}
                />
              ))}
            </div>
          )}
          <ActivityPager
            page={pageOfTxs.page}
            totalPages={pageOfTxs.totalPages}
            onPage={setPage}
            idPrefix="asset-activity"
          />
        </div>
      </div>
      <LiveNav />
    </div>
  );
}
