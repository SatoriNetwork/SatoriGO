// Live transaction detail — opened from a LiveHome activity row. Shows the
// direction, asset, amount, status, block height, fee (senders only) and the
// full txid, plus a "View in explorer" button that resolves the user's
// explorer URL template ({txid} placeholder) and opens it in a new tab.

import { ArrowDownLeft, ArrowUpRight, ChevronLeft, Clock, ExternalLink, XCircle } from 'lucide-react';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { EmptyState } from '../../components/EmptyState';
import { useLiveStore, DEFAULT_EXPLORER_URL, nativeTickerFor } from '../../store/liveStore';
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

/** Resolve the explorer URL for a txid from a `{txid}`-templated setting.
 *  SECURITY: only http/https templates are honoured — a `javascript:`/`data:`
 *  template (however it got set) must never reach window.open. Falls back to the
 *  default explorer if the template is missing `{txid}` or has a bad scheme. */
export function resolveExplorerUrl(template: string, txid: string): string {
  const tpl = template && template.includes('{txid}') ? template : DEFAULT_EXPLORER_URL;
  const safeTpl = /^https?:\/\//i.test(tpl.trim()) ? tpl : DEFAULT_EXPLORER_URL;
  return safeTpl.replace('{txid}', encodeURIComponent(txid));
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

  const openExplorer = () => {
    const url = resolveExplorerUrl(explorerUrlTemplate, tx.txid);
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener');
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
      </div>
      <LiveNav />
    </div>
  );
}
