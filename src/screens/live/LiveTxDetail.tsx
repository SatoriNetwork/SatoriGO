// Live transaction detail — opened from a LiveHome activity row. Shows the
// direction, asset, amount, status, block height, fee (senders only) and the
// full txid, plus a "View in explorer" button that resolves the user's
// explorer URL template ({txid} placeholder) and opens it in a new tab.

import { ArrowDownLeft, ArrowUpRight, ChevronLeft, Clock, ExternalLink, XCircle } from 'lucide-react';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { EmptyState } from '../../components/EmptyState';
import { useLiveStore, nativeTickerFor } from '../../store/liveStore';
import { LiveNav } from './LiveNav';

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

  const header = (
    <div className="sub-header">
      <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
        <ChevronLeft size={20} />
      </button>
      <h2>Transaction</h2>
      <span />
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
  const statusChip = tx.status === 'confirmed' ? 'success' : 'warning';
  const icon =
    tx.status === 'pending' ? (
      <Clock size={26} />
    ) : incoming ? (
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
          <span
            className={`row-icon ${statusChip === 'success' ? (incoming ? 'success' : 'neutral') : statusChip}`}
            style={{ width: 54, height: 54, borderRadius: 18 }}
          >
            {icon}
          </span>
          <div className="hero-value tnum" style={{ fontSize: 24, marginTop: 10 }} data-testid="live-tx-amount">
            {incoming ? '+' : '−'}{fmtAmount(tx.amount)} {tx.asset}
          </div>
          <span className={`chip ${statusChip}`} style={{ marginTop: 9 }} data-testid="live-tx-status">
            {tx.status}
          </span>
        </div>

        <div className="card">
          <div className="summary-table">
            <div className="sum-row">
              <span className="sum-key">Direction</span>
              <span className="sum-val">{incoming ? 'Received' : 'Sent'}</span>
            </div>
            <div className="sum-row">
              <span className="sum-key">Asset</span>
              <span className="sum-val">{tx.asset}</span>
            </div>
            <div className="sum-row">
              <span className="sum-key">Amount</span>
              <span className="sum-val tnum">{fmtAmount(tx.amount)} {tx.asset}</span>
            </div>
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
