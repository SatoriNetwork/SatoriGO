// Per-asset detail screen — shown when a row on the Live home is clicked.
// Displays one asset's logo, name and balance, and offers Receive / Send.
// Sending is enabled for EVR and every issued asset (asset transfers pay an EVR fee).

import { ArrowDownLeft, ArrowUpRight, ChevronLeft, Info, Landmark, Trash2 } from 'lucide-react';
import { TokenIcon } from '../../components/BrandLogo';
import { EmptyState } from '../../components/EmptyState';
import { useLiveStore, isRemovableAsset } from '../../store/liveStore';
import { isLegacyAsset, getAssetNote } from '../../services/assetNotes';
import type { LiveAssetBalance, LiveTransaction } from '../../services/chain/electrumProvider';
import { LiveNav } from './LiveNav';

interface LiveAssetDetailProps {
  asset: LiveAssetBalance;
  onBack(): void;
  onReceive(): void;
  onSend(): void;
  onSelectTx(txid: string): void;
  /** Open the Satori staking screen. Provided ONLY for the SATORIEVR asset on
   *  mainnet; when absent, the Stake action is not shown. */
  onStake?(): void;
}

/** SATORIEVR is the only asset eligible for Satori pool staking. */
const STAKING_ASSET = 'SATORIEVR';

/** Human sub-label for an asset (mirrors LiveHome). */
function assetSubLabel(asset: LiveAssetBalance): string {
  if (asset.name === 'EVR') return 'EVRmore';
  if (asset.name.includes('SATORI')) return 'Satori Network';
  return 'EVRmore asset';
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
}: {
  tx: LiveTransaction;
  decimals: number;
  onOpen(txid: string): void;
}) {
  const isIn = tx.direction === 'in';
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
          background: isIn ? 'var(--success-bg)' : 'var(--card)',
          color: isIn ? 'var(--success)' : 'var(--text-dim)',
          flexShrink: 0,
        }}
      >
        {isIn ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          {isIn ? 'Received' : 'Sent'}
          {tx.status === 'pending' && (
            <span className="chip warning" style={{ fontSize: 9, padding: '1px 5px' }}>pending</span>
          )}
        </div>
        <div className="text-dim" style={{ fontSize: 10.5, marginTop: 1 }}>
          {new Date(tx.timestamp).toLocaleDateString()}
        </div>
      </div>
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          flexShrink: 0,
          color: isIn ? 'var(--success)' : 'var(--text)',
        }}
      >
        {isIn ? '+' : '-'}{fmtWithDecimals(tx.amount, decimals)} {tx.asset}
      </div>
    </div>
  );
}

export function LiveAssetDetail({ asset, onBack, onReceive, onSend, onSelectTx, onStake }: LiveAssetDetailProps) {
  const removeAsset = useLiveStore((s) => s.removeAsset);
  const txs = useLiveStore((s) => s.txs);
  const stakingStatuses = useLiveStore((s) => s.staking.addressStatuses);
  const canStake = asset.name === STAKING_ASSET && !!onStake;
  // "Staked" header chip when any SATORIEVR-holding address is registered with a
  // pool. Nice-to-have; only meaningful once the staking screen has fetched status.
  const isStaked = canStake && stakingStatuses.some((s) => s.poolAddress);

  // This asset's transactions only (case-insensitive on the on-chain name).
  const assetName = asset.name.toUpperCase();
  const assetTxs = txs.filter((t) => t.asset.toUpperCase() === assetName);

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
        <h2>{asset.name}</h2>
        <span />
      </div>

      <div className="app-content" data-testid="live-asset-detail">
        {isLegacyAsset(asset.name) && (
          <div
            className="banner info"
            data-testid="legacy-asset-banner"
            style={{ alignItems: 'flex-start' }}
          >
            <Info size={14} />
            <span>{getAssetNote(asset.name)?.note}</span>
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
          <div style={{ fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            {asset.name}
            {isStaked && (
              <span className="chip" data-testid="live-asset-staked-chip" style={{ fontSize: 10 }}>
                Staked
              </span>
            )}
          </div>
          <div className="text-dim" style={{ fontSize: 12 }}>{assetSubLabel(asset)}</div>
          <div
            className="hero-value"
            data-testid={`live-asset-detail-balance-${asset.name}`}
            style={{ marginTop: 4 }}
          >
            {fmtWithDecimals(asset.amount, asset.decimals)}
            <span style={{ fontSize: 15, fontWeight: 500, marginLeft: 8, color: 'var(--text-dim)' }}>
              {asset.name}
            </span>
          </div>
        </div>

        {/* Primary actions */}
        <div className="actions-row" style={{ marginBottom: 12 }}>
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

        {/* This asset's activity */}
        <div className="section-label" style={{ marginTop: 18 }}>Activity</div>
        <div data-testid="live-asset-activity">
          {assetTxs.length === 0 ? (
            <EmptyState
              icon={<ArrowDownLeft size={20} />}
              title={`No ${asset.name} activity yet`}
              description={`Transactions involving ${asset.name} will appear here.`}
            />
          ) : (
            <div>
              {assetTxs.map((tx) => (
                <AssetTxRow
                  key={tx.txid}
                  tx={tx}
                  decimals={asset.decimals}
                  onOpen={onSelectTx}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <LiveNav />
    </div>
  );
}
