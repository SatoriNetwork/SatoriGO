// The bar on Home that follows the swap just sent (store: `swapStatus`).
//
// Sending a swap lands on Home, and this says what became of it: waiting,
// confirmed, reverted by the chain, or no answer yet. A confirmed swap clears
// itself; anything the user may need to act on stays until they close it.

import { useEffect } from 'react';
import { AlertTriangle, CheckCircle, X } from 'lucide-react';
import { displaySymbol } from '../../services/displaySymbol';
import { useLiveStore } from '../../store/liveStore';

/** How long a confirmed swap stays on screen before it clears itself. */
export const SWAP_STATUS_CLEAR_MS = 8000;

export function SwapStatusBar() {
  const status = useLiveStore((s) => s.swapStatus);
  const dismiss = useLiveStore((s) => s.dismissSwapStatus);
  const activeChainKey = useLiveStore((s) => s.evm.activeChainKey);
  const address = useLiveStore((s) => s.address);

  const txid = status?.txid;
  const state = status?.state;
  useEffect(() => {
    if (!txid || state !== 'confirmed') return;
    const timer = setTimeout(dismiss, SWAP_STATUS_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [txid, state, dismiss]);

  // A swap belongs to the account that sent it, on the network it was sent on.
  if (!status || status.chainKey !== activeChainKey || status.from !== address) return null;
  const receiveSymbol = displaySymbol(status.receiveSymbol);
  const pay = `${status.payAmount} ${displaySymbol(status.paySymbol)}`;
  const receive = `${status.receiveAmount} ${receiveSymbol}`;
  const text = {
    pending: { title: `Swapping ${pay} for ${receiveSymbol}`, detail: `Waiting for ${status.chainName} to confirm` },
    confirmed: { title: 'Swap complete', detail: `${pay} for about ${receive}` },
    failed: { title: 'Swap failed', detail: 'Nothing was swapped. The network fee was still paid.' },
    late: { title: 'Swap still pending', detail: `${status.chainName} has not confirmed it yet. It may still go through.` },
  }[status.state];

  return (
    <div className={`swap-status ${status.state}`} role="status" aria-live="polite" data-testid="live-swap-status">
      <span className="swap-status-icon" aria-hidden="true">
        {status.state === 'pending' && <span className="spinner" />}
        {status.state === 'confirmed' && <CheckCircle size={18} />}
        {(status.state === 'failed' || status.state === 'late') && <AlertTriangle size={18} />}
      </span>
      <span className="swap-status-text">
        <strong>{text.title}</strong>
        <span>{text.detail}</span>
      </span>
      <a href={status.explorerUrl} target="_blank" rel="noreferrer" className="swap-link" data-testid="live-swap-status-view">
        View
      </a>
      {status.state !== 'pending' && (
        <button type="button" className="icon-btn" onClick={dismiss} aria-label="Close" data-testid="live-swap-status-close">
          <X size={15} />
        </button>
      )}
    </div>
  );
}
