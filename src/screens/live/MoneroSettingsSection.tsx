// Monero section of Settings (Monero engine design §6.6, §10, §15 Set C).
//
// A CONTENT fragment, not a whole screen: LiveSettings.tsx (Set D, "top-level
// registration only") renders this inside its own section body, the same way
// it already renders the Electrum server-row content for `section === 'network'`
// — this file owns none of that shell (no sub-header, no back button, no
// LiveNav), only what goes inside it. That split is why the node-set /
// restore-height UI below deliberately mirrors the Electrum server rows'
// layout (a "summary-table" card up top, a labelled action below it) instead
// of inventing a new look for one more settings section.
//
// NODE SET: v1 ships exactly one gateway set ("main", §7); the row here is
// READ-ONLY DISPLAY for that reason — there is no setter for it in the Set D
// surface this file codes against (only `setMoneroRestoreHeight` exists), so
// wiring a picker to actually SWITCH sets is out of scope until the gateway
// and the engine offer a second one (§14 open question 6) and a setter to
// go with it. Flagged in this Set's report rather than guessed at.

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { useLiveStore, liveService } from '../../store/liveStore';
import { estimateHeightForDate } from '../../services/chain/monero/rpc';

export function MoneroSettingsSection() {
  const chain = useLiveStore((s) => s.monero.chain);
  const balance = useLiveStore((s) => s.monero.balance);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const loadWallets = useLiveStore((s) => s.loadWallets);
  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  // The chain tip as the open wallet last saw it (0 = not known yet): a
  // restore height above it would sync instantly to an empty wallet.
  const daemonHeight = balance?.daemonHeight ?? 0;

  // restoreHeight/moneroNodeSet are the WalletEntry additions §15 describes as
  // "monero only, public data"; mirrored onto WalletSummary the same way
  // passwordless/noSendPassword/evmChainKey already are (§8 table). Falls back
  // to the chain's release height / default set for a wallet whose entry
  // predates this field (should not happen post-1.5.0, but a stored record
  // read by an older build's summary type must still render SOMETHING).
  const currentHeight = activeWallet?.restoreHeight ?? chain?.releaseHeight ?? 0;
  const nodeSet = activeWallet?.moneroNodeSet ?? chain?.defaultNodeSet ?? 'main';

  const [editing, setEditing] = useState(false);
  const [heightText, setHeightText] = useState(() => String(currentHeight));
  const [dateText, setDateText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rescannedFrom, setRescannedFrom] = useState<number | null>(null);
  const [rescanUnchanged, setRescanUnchanged] = useState(false);

  const openEditor = () => {
    setHeightText(String(currentHeight));
    setDateText('');
    setError('');
    setRescannedFrom(null);
    setEditing(true);
  };

  // A date is a convenience that FILLS the height field; the height field is
  // what actually gets sent (§6.6: "ask for the creation date or an explicit
  // height" — both routes end at one number).
  const applyDate = (value: string) => {
    setDateText(value);
    if (!value) return;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return;
    setHeightText(String(estimateHeightForDate(parsed)));
  };

  const handleRescan = async () => {
    if (!activeWallet) return;
    setError('');
    const trimmed = heightText.trim();
    const height = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(height) || !Number.isInteger(height) || height < 0) {
      setError('Enter a whole block height, 0 or greater.');
      return;
    }
    if (daemonHeight > 0 && height > daemonHeight) {
      setError(`The Monero network is at block ${daemonHeight.toLocaleString('en-US')}. Enter a height at or below it.`);
      return;
    }
    const unchanged = height === currentHeight;
    setBusy(true);
    try {
      // Persists the height AND drops the cache + resyncs the open wallet
      // from it (§6.6 "Rescan"); this file's job ends at the call. The same
      // height is still a rescan (the service restarts the scan either way).
      await liveService().setMoneroRestoreHeight(activeWallet.id, height, { daemonHeight });
      // The card above reads the height off the store's wallet summaries,
      // which nothing else reloads after this write.
      await loadWallets?.();
      setRescannedFrom(height);
      setRescanUnchanged(unchanged);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the restore height.');
    } finally {
      setBusy(false);
    }
  };

  if (!activeWallet || activeWallet.family !== 'monero') {
    return (
      <div className="banner info" data-testid="live-xmr-settings-no-wallet">
        Add a Monero wallet to see its settings here.
      </div>
    );
  }

  return (
    <div data-testid="live-xmr-settings">
      <div className="card solid" style={{ marginBottom: 12 }}>
        <div className="summary-table">
          <div className="sum-row">
            <span className="sum-key">Node set</span>
            <span className="sum-val" data-testid="live-xmr-settings-node-set">{nodeSet}</span>
          </div>
          <div className="sum-row">
            <span className="sum-key">Restore height</span>
            <span className="sum-val" data-testid="live-xmr-settings-restore-height">
              {currentHeight.toLocaleString('en-US')}
            </span>
          </div>
        </div>
      </div>
      <p className="text-faint" style={{ fontSize: 11, margin: '0 2px 10px', lineHeight: 1.5 }}>
        Monero blocks come through the Satori GO gateway's "{nodeSet}" node set. The restore height is where a
        scan starts: everything before it is assumed to hold none of this wallet's funds.
      </p>

      {!editing ? (
        <Button
          variant="secondary"
          size="sm"
          block
          icon={<RefreshCw size={14} />}
          onClick={openEditor}
          data-testid="live-xmr-settings-rescan-open"
        >
          Rescan from height
        </Button>
      ) : (
        <div className="card" data-testid="live-xmr-settings-rescan-form">
          <TextField
            label="Rescan from block height"
            type="number"
            min="0"
            max={daemonHeight > 0 ? String(daemonHeight) : undefined}
            step="1"
            inputMode="numeric"
            value={heightText}
            onChange={(e) => setHeightText(e.target.value)}
            testId="live-xmr-settings-restore-height-input"
          />
          <TextField
            label="Or estimate from a date"
            type="date"
            value={dateText}
            onChange={(e) => applyDate(e.target.value)}
            testId="live-xmr-settings-restore-date"
            hint="Roughly when this wallet's funds started arriving."
          />
          {error && (
            <span role="alert" data-testid="live-xmr-settings-error" style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}>
              {error}
            </span>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)} data-testid="live-xmr-settings-rescan-cancel">
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              block
              loading={busy}
              onClick={() => void handleRescan()}
              data-testid="live-xmr-settings-rescan-confirm"
            >
              Rescan
            </Button>
          </div>
          <p className="text-faint" style={{ fontSize: 10.5, margin: '8px 0 0', lineHeight: 1.5 }}>
            Restoring from today misses older funds; from a date long ago takes hours.
          </p>
        </div>
      )}

      {rescannedFrom !== null && (
        <div className="banner info" style={{ marginTop: 10 }} data-testid="live-xmr-settings-rescan-done">
          {rescanUnchanged
            ? `Restore height unchanged. Rescanning from block ${rescannedFrom.toLocaleString('en-US')} again.`
            : `Rescanning from block ${rescannedFrom.toLocaleString('en-US')}.`}
        </div>
      )}
    </div>
  );
}
