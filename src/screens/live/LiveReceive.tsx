import { useState } from 'react';
import { QRCodeView } from '../../components/QRCodeView';
import { CopyButton } from '../../components/CopyButton';
import { Button } from '../../components/Button';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore, nativeTickerFor } from '../../store/liveStore';
import { networkFor } from '../../services/chain/chainParams';
import type { LiveNetworkId } from '../../services/chain/liveWallet';
import { ChevronLeft, CheckCircle, Plus } from 'lucide-react';
import { LiveNav } from './LiveNav';

interface LiveReceiveProps {
  onBack(): void;
  /** Kept for call-site compatibility; the receive address is chain-wide, so the
   *  screen no longer branches on a specific asset. */
  initialAsset?: string;
}

/** Middle-truncate an address for the compact picker rows. */
function shortAddr(address: string): string {
  return address.length > 22 ? `${address.slice(0, 10)}…${address.slice(-8)}` : address;
}

export function LiveReceive({ onBack }: LiveReceiveProps) {
  const address = useLiveStore((s) => s.address);
  const addresses = useLiveStore((s) => s.addresses);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const addReceiveAddress = useLiveStore((s) => s.addReceiveAddress);

  // The active chain's native ticker (EVR on Evrmore, RVN on Ravencoin) and full
  // network name. Every asset on a chain shares ONE receive address, so the screen
  // shows the network, not a per-asset picker.
  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  const nativeTicker = nativeTickerFor();
  const networkName = nativeTicker === 'RVN' ? 'Ravencoin' : 'EVRmore';
  // Kept for potential future use of the resolved chain params (no branch today).
  void networkFor((activeWallet?.network as LiveNetworkId | undefined) ?? 'mainnet');

  // The active wallet's kind gates the add-address affordance: only seed wallets
  // can derive more addresses (a pk / Satori wallet has one fixed address).
  const isSeedWallet = activeWallet?.kind === 'seed';

  // Which derived address the QR / copy row shows. Default = primary (index 0);
  // falls back to the primary when the selection is stale (e.g. wallet switch).
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = addresses.find((a) => a.index === selectedIndex);
  const shownAddress = selected?.address ?? address;
  const shownIndex = selected?.index ?? 0;

  const [addrError, setAddrError] = useState('');
  const [addrBusy, setAddrBusy] = useState(false);

  const handleNewAddress = async () => {
    if (addrBusy) return;
    setAddrError('');
    setAddrBusy(true);
    const res = await addReceiveAddress();
    setAddrBusy(false);
    if (!res.ok) {
      setAddrError(res.error ?? 'Could not add a new address.');
      return;
    }
    // Select the freshly derived address (always the last in the list).
    const list = useLiveStore.getState().addresses;
    const last = list[list.length - 1];
    if (last) setSelectedIndex(last.index);
  };

  // One address receives the native coin AND every asset on this chain.
  const helper = `Send ${nativeTicker} or any ${networkName} asset to this address. They all share it.`;

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Receive</h2>
        <span />
      </div>
      <div className="app-content" data-testid="live-receive">
        <div className="banner info" style={{ marginBottom: 14 }}>
          <CheckCircle size={14} />
          {nativeTicker === 'RVN'
            ? 'Ready to receive. This is your real Ravencoin address.'
            : 'Ready to receive. This is your real EVRmore address.'}
        </div>

        {/* Network header: which chain this address is on. Assets are not listed
            here, because every asset on the chain shares this one address. */}
        <div
          data-testid="live-receive-network"
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
          <TokenIcon assetId={nativeTicker} size={26} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{nativeTicker}</div>
            <div className="text-dim" style={{ fontSize: 11 }}>{networkName} network</div>
          </div>
        </div>

        <p className="text-dim" style={{ fontSize: 12, margin: '0 2px 14px', lineHeight: 1.5 }}>
          {helper}
        </p>

        {/* Address picker — only when the wallet has derived MORE than one. */}
        {addresses.length > 1 && (
          <div
            data-testid="live-receive-address-picker"
            style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}
          >
            {addresses.map((a) => {
              const isActive = a.index === shownIndex;
              return (
                <button
                  key={a.index}
                  type="button"
                  onClick={() => setSelectedIndex(a.index)}
                  data-testid={`live-receive-addr-${a.index}`}
                  aria-pressed={isActive}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderRadius: 'var(--r-md)',
                    cursor: 'pointer',
                    fontSize: 11.5,
                    textAlign: 'left',
                    background: isActive ? 'var(--accent-soft)' : 'var(--card)',
                    color: isActive ? 'var(--accent-text)' : 'var(--text-dim)',
                    border: isActive
                      ? '1px solid color-mix(in srgb, var(--accent) 45%, transparent)'
                      : '1px solid var(--border)',
                    transition: 'all 0.15s',
                  }}
                >
                  <span style={{ fontWeight: 700, flexShrink: 0 }}>#{a.index}</span>
                  <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {shortAddr(a.address)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div className="qr-card" data-testid="live-receive-qr">
            <QRCodeView value={shownAddress} size={180} />
          </div>

          <div className="addr-box" style={{ width: '100%' }} data-testid="live-receive-address">
            <span className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{shownAddress}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CopyButton value={shownAddress} label="Copy address" size={14} />
            <span className="text-dim" style={{ fontSize: 12 }}>Copy address</span>
          </div>

          {/* New address — seed wallets only (pk wallets have one fixed address). */}
          {isSeedWallet && (
            <div style={{ width: '100%' }}>
              <Button
                variant="secondary"
                size="sm"
                block
                icon={<Plus size={14} />}
                loading={addrBusy}
                onClick={() => void handleNewAddress()}
                data-testid="live-receive-new-address"
              >
                New address
              </Button>
              {addrError && (
                <span
                  role="alert"
                  data-testid="live-receive-address-error"
                  style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 6 }}
                >
                  {addrError}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <LiveNav />
    </div>
  );
}
