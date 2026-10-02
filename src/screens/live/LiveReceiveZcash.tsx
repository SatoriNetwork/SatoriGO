// Receive screen for a Zcash wallet (docs/design/zcash-engine.md §3.1, §10,
// §15 Set C).
//
// Deliberately simpler than LiveReceiveMonero.tsx: Zcash v1 is
// transparent-only with exactly ONE address the wallet ever shows or spends
// from (`/0/0`, §2.1 — "reasons: transparent Zcash gains no privacy from
// rotation"), so there is no subaddress list, no "New address" and no async
// host to open. The address is already public data on the wallet summary
// (WalletSummary.address, populated by Set D's liveWallet.ts getAddress()
// for every wallet family, §8), so this screen needs nothing beyond the
// store's existing `wallets` list — same visual language (QR, addr box, copy
// row) as LiveReceive.tsx / LiveReceiveMonero.tsx on purpose.

import { ChevronLeft, CheckCircle } from 'lucide-react';
import { QRCodeView } from '../../components/QRCodeView';
import { CopyButton } from '../../components/CopyButton';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore } from '../../store/liveStore';
import { ZCASH_CHAIN } from '../../store/zcashChain';
import { LiveNav } from './LiveNav';

interface LiveReceiveZcashProps {
  onBack(): void;
}

export function LiveReceiveZcash({ onBack }: LiveReceiveZcashProps) {
  const chain = useLiveStore((s) => s.zcash.chain) ?? ZCASH_CHAIN;
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  const isOpen = !!activeWallet && activeWallet.family === 'zcash';
  const address = isOpen ? activeWallet!.address : '';

  if (!isOpen) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Receive Zcash</h2>
          <span />
        </div>
        <div className="app-content">
          <div className="banner danger" data-testid="live-zec-receive-closed">
            Your Zcash wallet is not open. Unlock it to receive.
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
      <div className="app-content" data-testid="live-zec-receive">
        <div className="banner info" style={{ marginBottom: 14 }}>
          <CheckCircle size={14} />
          This is your real Zcash address.
        </div>

        <div
          data-testid="live-zec-receive-network"
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
          <TokenIcon assetId="ZEC" size={26} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>ZEC</div>
            <div className="text-dim" style={{ fontSize: 11 }}>{chain.displayName} network</div>
          </div>
        </div>

        {/* §10's disclosure line: transparent Zcash carries no shielding, and
            the in-app copy must not suggest otherwise (§1). */}
        <p className="text-dim" style={{ fontSize: 12, margin: '0 2px 14px', lineHeight: 1.5 }}>
          Transparent Zcash address. Payments to it are public, like Bitcoin. Shielded Zcash is not supported.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div className="qr-card" data-testid="live-zec-receive-qr">
            {address && <QRCodeView value={address} size={180} />}
          </div>

          <div className="addr-box" style={{ width: '100%' }} data-testid="live-zec-receive-address">
            <span className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
              {address || 'Loading…'}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CopyButton value={address} label="Copy address" size={14} testId="live-zec-receive-copy" />
            <span className="text-dim" style={{ fontSize: 12 }}>Copy address</span>
          </div>
        </div>
      </div>
      <LiveNav />
    </div>
  );
}
