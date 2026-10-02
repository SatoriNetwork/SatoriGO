// Receive screen for a Bittensor wallet (Bittensor engine design §10, §15 Set
// C). Simpler than LiveReceiveMonero.tsx on purpose: a Substrate account is
// ONE SS58 address (design §2.1, "no derivation path" — this is the phrase's
// root account, not a subaddress scheme), so this is closer in shape to the
// generic LiveReceive.tsx (one address, QR, copy) than to Monero's
// subaddress picker.
//
// Carries the owner's 2026-09-28 OVERRIDE (design §1): with no Taostats fetch
// in v1, this screen is also where the "Full history on taostats.io" link
// lives (see the Set C report — no chain-agnostic Activity screen exists in
// this Set's owned files to wire it into instead).

import { CheckCircle, ExternalLink } from 'lucide-react';
import { ChevronLeft } from 'lucide-react';
import { QRCodeView } from '../../components/QRCodeView';
import { CopyButton } from '../../components/CopyButton';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore } from '../../store/liveStore';
import { TAO_CHAIN, taoExplorerAccountUrl } from '../../store/taoChain';
import { LiveNav } from './LiveNav';

interface LiveReceiveTaoProps {
  onBack(): void;
}

export function LiveReceiveTao({ onBack }: LiveReceiveTaoProps) {
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  const address = activeWallet?.address ?? '';

  if (!address) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Receive Bittensor</h2>
          <span />
        </div>
        <div className="app-content">
          <div className="banner danger" data-testid="live-tao-receive-closed">
            Your Bittensor wallet is not ready yet. Unlock it to receive.
          </div>
        </div>
        <LiveNav />
      </div>
    );
  }

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Receive</h2>
        <span />
      </div>
      <div className="app-content" data-testid="live-tao-receive">
        <div className="banner info" style={{ marginBottom: 14 }}>
          <CheckCircle size={14} />
          This is your real Bittensor address.
        </div>

        <div
          data-testid="live-tao-receive-network"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            marginBottom: 12,
            borderRadius: 'var(--r-md)',
            background: 'var(--card)',
            border: '1px solid var(--border)',
          }}
        >
          <TokenIcon assetId="TAO" size={26} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>TAO</div>
            <div className="text-dim" style={{ fontSize: 11 }}>{TAO_CHAIN.displayName} network</div>
          </div>
        </div>

        {/* Owner-approval-needed copy (design §10): the one line that names
            btcli and polkadot.js, so a reviewer of this send/receive pair can
            find it in one place. */}
        <p className="text-dim" style={{ fontSize: 12, margin: '0 2px 14px', lineHeight: 1.5 }}>
          Your Bittensor coldkey address, derived from your recovery phrase the way btcli and polkadot.js derive it.
          There is no subaddress or derivation path: this is the one address for the whole account.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div className="qr-card" data-testid="live-tao-receive-qr">
            <QRCodeView value={address} size={180} />
          </div>

          <div className="addr-box" style={{ width: '100%' }} data-testid="live-tao-receive-address">
            <span className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{address}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CopyButton value={address} label="Copy address" size={14} testId="live-tao-receive-copy" />
            <span className="text-dim" style={{ fontSize: 12 }}>Copy address</span>
          </div>

          {/* The v1 Activity surface (design §1 OVERRIDE): no incoming-transfer
              list in the wallet, only this per-address link to the third-party
              explorer for full history. */}
          <a
            href={taoExplorerAccountUrl(address)}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm"
            data-testid="live-tao-receive-taostats-link"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            Full history on taostats.io
            <ExternalLink size={12} />
          </a>
        </div>
      </div>
      <LiveNav />
    </div>
  );
}
