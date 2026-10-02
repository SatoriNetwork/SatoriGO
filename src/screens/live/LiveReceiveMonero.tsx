// Receive screen for a Monero wallet (Monero engine design §10, §15 Set C).
//
// Deliberately its OWN screen rather than a branch inside LiveReceive.tsx:
// Monero has no single "the address" the way a UTXO/EVM wallet does — every
// subaddress receives into the same wallet, and "New address" here creates a
// genuinely new on-chain destination (createSubaddress, through the open
// wallet's own lookahead, §4) rather than picking among ADDRESSES ALREADY
// DERIVED the way LiveReceive's picker does. Same visual language (QR, addr
// box, copy row, New-address button) as LiveReceive.tsx on purpose — a
// Monero receive should feel like the rest of this wallet, not like a
// different app.

import { useEffect, useState } from 'react';
import { ChevronLeft, CheckCircle, Plus } from 'lucide-react';
import { QRCodeView } from '../../components/QRCodeView';
import { CopyButton } from '../../components/CopyButton';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore } from '../../store/liveStore';
import type { MoneroSubaddress } from '../../services/chain/monero/scanner';
import { LiveNav } from './LiveNav';

interface LiveReceiveMoneroProps {
  onBack(): void;
}

/** wallet2 keeps a subaddress label; the host caps it at 100 characters. */
const MAX_LABEL_LENGTH = 100;

/** Middle-truncate an address for the compact picker rows (same shape as
 *  LiveReceive.shortAddr). */
function shortAddr(address: string): string {
  return address.length > 22 ? `${address.slice(0, 10)}…${address.slice(-8)}` : address;
}

export function LiveReceiveMonero({ onBack }: LiveReceiveMoneroProps) {
  // The open wallet host (Set D surface, §6.3): null while locked, while a
  // non-Monero wallet is active, or before the worker has finished opening.
  const host = useLiveStore((s) => s.monero.host);
  const chain = useLiveStore((s) => s.monero.chain);
  const walletId = host?.walletId ?? null;

  // Subaddresses are not store state (§15: the `monero` slice carries only
  // chain/host/balance/sync/error) — they are read straight from the open
  // host, the same way this screen would ask wallet2 for anything else.
  const [subaddresses, setSubaddresses] = useState<MoneroSubaddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // The MINOR index currently shown in the QR/copy row. 0 = primary.
  const [selected, setSelected] = useState(0);
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState('');
  // The label the next "New address" is created with (design §10: "subaddress
  // list with add and label"). Optional; wallet2 keeps it with the wallet.
  const [newLabel, setNewLabel] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSelected(0);
    if (!host) {
      setSubaddresses([]);
      setLoading(false);
      setLoadError('');
      return;
    }
    setLoading(true);
    setLoadError('');
    // v1 is one account, major 0 (§4): every subaddress the UI ever shows or
    // creates is under it.
    void host
      .subaddresses(0)
      .then((rows: MoneroSubaddress[]) => {
        if (cancelled) return;
        setSubaddresses(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load your Monero addresses.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-run when the OPEN WALLET changes (walletId), not on every host
    // re-render: the host reference can change without the wallet changing
    // (e.g. a fresh worker after unlock, §6.5), and re-listing then is
    // harmless but re-keys `selected` back to primary, which reads odd if the
    // user had just picked #2. walletId is the right dependency either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId]);

  const primary = subaddresses.find((s) => s.minor === 0);
  const shown = subaddresses.find((s) => s.minor === selected) ?? primary;
  const shownAddress = shown?.address ?? '';

  const handleNewAddress = async () => {
    if (!host || newBusy) return;
    setNewError('');
    setNewBusy(true);
    try {
      const label = newLabel.trim().slice(0, MAX_LABEL_LENGTH);
      const created = await host.createSubaddress(0, label);
      // wallet2 echoes the label back; keep what the user typed if it did not
      // (an older host shape), so the row never shows blank for a named one.
      setSubaddresses((prev) => [...prev, { ...created, label: created.label || label }]);
      setSelected(created.minor);
      setNewLabel('');
    } catch (err) {
      setNewError(err instanceof Error ? err.message : 'Could not create a new address.');
    } finally {
      setNewBusy(false);
    }
  };

  if (!host) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Receive Monero</h2>
          <span />
        </div>
        <div className="app-content">
          <div className="banner danger" data-testid="live-xmr-receive-closed">
            Your Monero wallet is not open. Unlock it to receive.
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
      <div className="app-content" data-testid="live-xmr-receive">
        <div className="banner info" style={{ marginBottom: 14 }}>
          <CheckCircle size={14} />
          This is your real Monero address.
        </div>

        <div
          data-testid="live-xmr-receive-network"
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
          <TokenIcon assetId="XMR" size={26} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>XMR</div>
            <div className="text-dim" style={{ fontSize: 11 }}>{chain?.displayName ?? 'Monero'} network</div>
          </div>
        </div>

        {/* Monero habit, explained once: unlike a shared UTXO/EVM address, a
            fresh subaddress per sender is what keeps two payments from being
            linkable on-chain, and it costs the sender nothing extra to use. */}
        <p className="text-dim" style={{ fontSize: 12, margin: '0 2px 14px', lineHeight: 1.5 }}>
          Monero wallets give each sender a fresh subaddress so payments cannot be linked together on-chain.
          Every subaddress pays into this same wallet.
        </p>

        {loadError && (
          <div className="banner danger" style={{ marginBottom: 12 }} data-testid="live-xmr-receive-load-error">
            {loadError}
          </div>
        )}

        {!loading && subaddresses.length > 1 && (
          <div
            data-testid="live-xmr-receive-address-picker"
            style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}
          >
            {subaddresses.map((s) => {
              const isActive = s.minor === selected;
              return (
                <button
                  key={s.minor}
                  type="button"
                  onClick={() => setSelected(s.minor)}
                  data-testid={`live-xmr-receive-addr-${s.minor}`}
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
                  <span style={{ fontWeight: 700, flexShrink: 0 }}>{s.minor === 0 ? 'Primary' : `#${s.minor}`}</span>
                  {s.label && (
                    <span
                      data-testid={`live-xmr-receive-label-${s.minor}`}
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%', flexShrink: 1 }}
                    >
                      {s.label}
                    </span>
                  )}
                  <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                    {shortAddr(s.address)}
                  </span>
                  {s.used && (
                    <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>
                      Used
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div className="qr-card" data-testid="live-xmr-receive-qr">
            {shownAddress && <QRCodeView value={shownAddress} size={180} />}
          </div>

          <div className="addr-box" style={{ width: '100%' }} data-testid="live-xmr-receive-address">
            <span className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
              {loading ? 'Loading…' : shownAddress}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CopyButton value={shownAddress} label="Copy address" size={14} testId="live-xmr-receive-copy" />
            <span className="text-dim" style={{ fontSize: 12 }}>Copy address</span>
          </div>

          <div style={{ width: '100%' }}>
            <TextField
              label="Label for the new address (optional)"
              placeholder="e.g. Shop, Alice"
              value={newLabel}
              maxLength={MAX_LABEL_LENGTH}
              onChange={(e) => setNewLabel(e.target.value)}
              testId="live-xmr-receive-new-label"
              autoComplete="off"
            />
            <Button
              variant="secondary"
              size="sm"
              block
              icon={<Plus size={14} />}
              loading={newBusy}
              onClick={() => void handleNewAddress()}
              data-testid="live-xmr-receive-new-address"
              style={{ marginTop: 8 }}
            >
              New address
            </Button>
            {newError && (
              <span
                role="alert"
                data-testid="live-xmr-receive-new-address-error"
                style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 6 }}
              >
                {newError}
              </span>
            )}
          </div>
        </div>
      </div>
      <LiveNav />
    </div>
  );
}
