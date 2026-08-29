// Live transaction detail — opened from a LiveHome activity row. Shows the
// direction, asset, amount, status, block height, fee (senders only) and the
// full txid, plus a "View in explorer" button that resolves the user's
// explorer URL template ({txid} placeholder) and opens it in a new tab.

import { ArrowDownLeft, ArrowUpRight, ChevronLeft, Clock, ExternalLink, XCircle } from 'lucide-react';
import { Button } from '../../components/Button';
import { SyncStatusPill } from '../../components/SyncStatusPill';
import { CopyButton } from '../../components/CopyButton';
import { EmptyState } from '../../components/EmptyState';
import { useLiveStore, nativeTickerFor, activeEvmChain } from '../../store/liveStore';
import { LiveNav } from './LiveNav';
import { stakingRowLabel, validatorName } from './stakingRowLabel';
import { displaySymbol } from '../../services/displaySymbol';

interface LiveTxDetailProps {
  txid: string;
  onBack(): void;
}

function fmtAmount(amount: number): string {
  if (amount === 0) return '0';
  if (amount >= 1000) return amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return amount.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/**
 * Resolve a usable explorer URL for `txid`, or '' when this chain has none.
 *
 * SECURITY: only http/https templates are honoured, so a `javascript:`/`data:`
 * template (however it got set) can never reach window.open.
 *
 * The empty return matters: a chain with no known explorer (its default template
 * is '') must NOT fall back to the Evrmore one, which would open a foreign
 * chain's txid on Evrmore's explorer and show "not found" at best. Callers MUST
 * treat '' as "hide the explorer affordance".
 */
export function resolveExplorerUrl(template: string, txid: string): string {
  const usable = !!template && template.includes('{txid}') && /^https?:\/\//i.test(template.trim());
  // No usable template means NO explorer for this chain. It must never fall back
  // to another chain's URL (it used to fall back to Evrmore's), because that
  // resolves a foreign txid on the wrong explorer and reads as "not found".
  return usable ? template.replace('{txid}', encodeURIComponent(txid)) : '';
}

export function LiveTxDetail({ txid, onBack }: LiveTxDetailProps) {
  const tx = useLiveStore((s) => s.txs.find((t) => t.txid === txid));
  const explorerUrlTemplate = useLiveStore((s) => s.explorerUrlTemplate);
  // The fee is always paid in the active chain's native coin (EVR or RVN).
  const nativeTicker = nativeTickerFor();
  // Native staking (Epix and any future cosmos/evm chain). Null for every other
  // transaction, and everything below then renders exactly as it did before.
  const evm = useLiveStore((s) => s.evm);
  const stakeSnapshot = useLiveStore((s) => s.evmStaking.snapshot);
  const stakeChain = activeEvmChain({ evm });
  const monikerOf = (valoper: string) =>
    stakeSnapshot?.validators.find((v) => v.valoper === valoper)?.moniker || undefined;
  // The asset as it is DRAWN: on an EVM chain `tx.asset` is a symbol its own
  // author chose (services/displaySymbol.ts).
  const shownAsset = displaySymbol(tx?.asset ?? '');
  const stakingInfo = tx?.staking;
  const staking =
    stakingInfo && stakeChain
      ? stakingRowLabel(stakingInfo, {
          ticker: stakeChain.nativeTicker,
          decimals: stakeChain.nativeDecimals,
          monikerOf,
        })
      : null;

  const header = (
    <div className="sub-header">
      <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
        <ChevronLeft size={20} />
      </button>
      <h2>Transaction</h2>
      {/* Connection state, same dot-only indicator as the rest of the wallet
          (KNOWN_LIMITATIONS item 33). */}
      <SyncStatusPill compact />
    </div>
  );

  if (!tx) {
    return (
      <div className="app-frame screen-enter">
        {header}
        <div className="app-content" data-testid="live-tx-detail">
          <EmptyState
            icon={<XCircle size={20} />}
            title="Transaction not found"
            description="This transaction is no longer in your recent activity."
          />
          <Button block variant="secondary" onClick={onBack} style={{ marginTop: 12 }}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  const incoming = tx.direction === 'in';
  // A staking transaction is the user's own bookkeeping, never a payment from a
  // stranger: neutral tone both ways, with the arrow saying which direction the
  // coins moved (out to the module, back for a claim).
  const arrowIn = staking ? staking.incoming : incoming;
  const statusChip = tx.status === 'confirmed' ? 'success' : 'warning';
  const heroTone = statusChip === 'success' ? (staking ? 'neutral' : incoming ? 'success' : 'neutral') : statusChip;
  const icon =
    tx.status === 'pending' ? (
      <Clock size={26} />
    ) : arrowIn ? (
      <ArrowDownLeft size={26} />
    ) : (
      <ArrowUpRight size={26} />
    );

  // '' when this chain ships no explorer; drives BOTH the click and whether the
  // button renders at all.
  const explorerUrl = resolveExplorerUrl(explorerUrlTemplate, tx.txid);
  const openExplorer = () => {
    if (explorerUrl === '') return;
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(explorerUrl, '_blank', 'noopener');
    }
  };

  return (
    <div className="app-frame screen-enter">
      {header}
      <div className="app-content" data-testid="live-tx-detail">
        {/* Hero: direction icon + signed amount + status */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0 16px' }}>
          <span className={`row-icon ${heroTone}`} style={{ width: 54, height: 54, borderRadius: 18 }}>
            {icon}
          </span>
          <div className="hero-value tnum" style={{ fontSize: 24, marginTop: 10 }} data-testid="live-tx-amount">
            {staking
              ? staking.amountText === ''
                ? staking.title
                : staking.amountText
              : `${incoming ? '+' : '−'}${fmtAmount(tx.amount)} ${shownAsset}`}
          </div>
          <span className={`chip ${statusChip}`} style={{ marginTop: 9 }} data-testid="live-tx-status">
            {tx.status}
          </span>
        </div>

        <div className="card">
          <div className="summary-table">
            <div className="sum-row">
              <span className="sum-key">{staking ? 'Action' : 'Direction'}</span>
              <span className="sum-val" data-testid={staking ? `live-tx-staking-${tx.txid}` : undefined}>
                {staking ? staking.title : incoming ? 'Received' : 'Sent'}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-key">Asset</span>
              <span className="sum-val">{shownAsset}</span>
            </div>
            {/* A claim carries no amount: the chain pays whatever accrued, so
                the row is absent rather than showing a 0 that is not true. */}
            {(!staking || staking.amountText !== '') && (
              <div className="sum-row">
                <span className="sum-key">Amount</span>
                <span className="sum-val tnum">
                  {staking ? staking.amountText : `${fmtAmount(tx.amount)} ${shownAsset}`}
                </span>
              </div>
            )}
            {/* The FULL operator address, never only the moniker: a moniker is a
                name the validator chose for itself and two can share one, the
                address cannot be spoofed. Same rule as the review step. */}
            {stakingInfo && (
              <div className="sum-row">
                <span className="sum-key">{stakingInfo.validatorDst ? 'From validator' : 'Validator'}</span>
                <span
                  className="sum-val mono"
                  data-testid="live-tx-staking-validator"
                  style={{ fontSize: 11, wordBreak: 'break-all', textAlign: 'right' }}
                >
                  {validatorName(stakingInfo.validator, monikerOf)}
                  <br />
                  {stakingInfo.validator}
                </span>
              </div>
            )}
            {stakingInfo?.validatorDst && (
              <div className="sum-row">
                <span className="sum-key">To validator</span>
                <span
                  className="sum-val mono"
                  data-testid="live-tx-staking-validator-dst"
                  style={{ fontSize: 11, wordBreak: 'break-all', textAlign: 'right' }}
                >
                  {validatorName(stakingInfo.validatorDst, monikerOf)}
                  <br />
                  {stakingInfo.validatorDst}
                </span>
              </div>
            )}
            <div className="sum-row">
              <span className="sum-key">Date</span>
              <span className="sum-val">
                {new Date(tx.timestamp).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                })}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-key">{incoming ? 'From' : 'To'}</span>
              <span className="sum-val mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                {tx.counterparty ? `${tx.counterparty.slice(0, 10)}…${tx.counterparty.slice(-6)}` : 'n/a'}
                {tx.counterparty && <CopyButton value={tx.counterparty} label="Copy address" size={12} />}
              </span>
            </div>
            {!incoming && tx.feeEvr > 0 && (
              <div className="sum-row">
                <span className="sum-key">Network fee</span>
                <span className="sum-val tnum">{fmtAmount(tx.feeEvr)} {nativeTicker}</span>
              </div>
            )}
            {tx.blockHeight !== undefined && (
              <div className="sum-row">
                <span className="sum-key">Block height</span>
                <span className="sum-val tnum">{tx.blockHeight.toLocaleString('en-US')}</span>
              </div>
            )}
          </div>
        </div>

        {/* Full txid — monospace + copyable */}
        <div className="card" style={{ marginTop: 12 }}>
          <div className="section-label" style={{ marginTop: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Transaction ID</span>
            <CopyButton value={tx.txid} label="Copy transaction id" size={12} testId="live-tx-copy-txid" />
          </div>
          <span
            className="mono"
            data-testid="live-tx-txid"
            style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}
          >
            {tx.txid}
          </span>
        </div>

        {/* Hidden entirely on a chain with no known explorer: an inert or
            wrong-chain link is worse than no link at all. */}
        {explorerUrl !== '' && (
          <div style={{ marginTop: 12 }}>
            <Button
              variant="secondary"
              block
              icon={<ExternalLink size={15} />}
              onClick={openExplorer}
              data-testid="live-tx-explorer"
            >
              View in explorer
            </Button>
          </div>
        )}
      </div>
      <LiveNav />
    </div>
  );
}
