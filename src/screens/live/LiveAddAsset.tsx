// Add-asset (MetaMask-style) modal for the Live surface. The user types an
// EVRmore asset name; the store validates it against the real chain via
// getAssetMeta before pinning it. On success the modal closes and the new row
// appears on LiveHome; on failure the error is shown inline.

import { useState, type FormEvent } from 'react';
import { Coins } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore, nativeTickerFor, assetsSupported, chainDisplayName } from '../../store/liveStore';

interface LiveAddAssetProps {
  onClose(): void;
}

export function LiveAddAsset({ onClose }: LiveAddAssetProps) {
  const addAsset = useLiveStore((s) => s.addAsset);
  const nativeTicker = nativeTickerFor();
  // Whether the active chain has an asset protocol at all — a plain chain
  // (e.g. Bitcoin Gold) has nothing to add. Capability-driven, never a
  // hardcoded ticker check.
  const canAdd = assetsSupported();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError('');
    if (!trimmed) {
      setError('Enter an asset name.');
      return;
    }
    setSubmitting(true);
    const res = await addAsset(trimmed);
    setSubmitting(false);
    if (res.ok) {
      onClose();
    } else {
      setError(res.error);
    }
  };

  // This chain has no asset protocol (e.g. Bitcoin Gold): there is nothing to
  // add. Reachable only defensively — LiveHome hides the "Add token" action
  // that opens this modal on such a chain — so this just explains why and
  // offers a close, instead of showing a form with nowhere useful to go.
  if (!canAdd) {
    return (
      <Modal title="Add a token" onClose={onClose} testId="live-add-asset-modal">
        <p className="text-dim" style={{ fontSize: 12, margin: '0 0 14px', lineHeight: 1.5 }}>
          {nativeTicker} has no token or asset support. This wallet only ever holds {nativeTicker}.
        </p>
        <Button type="button" block onClick={onClose} data-testid="live-add-asset-close">
          Close
        </Button>
      </Modal>
    );
  }

  return (
    <Modal title="Add a token" onClose={onClose} testId="live-add-asset-modal">
      <form onSubmit={submit}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          {/* Neutral placeholder until a name is typed — a "?" letter avatar in
              a random hue read as a real (broken) token. */}
          {trimmed ? (
            <TokenIcon assetId={trimmed} size={34} />
          ) : (
            <span className="row-icon neutral" aria-hidden="true">
              <Coins size={16} />
            </span>
          )}
          <p className="text-dim" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            {`Enter a ${chainDisplayName()} asset name. We verify it exists on-chain before adding it to your list.`}
          </p>
        </div>

        <TextField
          label="Asset name"
          placeholder="e.g. SATORI"
          value={name}
          onChange={(e) => {
            setName(e.target.value.toUpperCase());
            setError('');
          }}
          testId="live-add-asset-input"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
        />

        {error && (
          <div
            className="banner danger"
            data-testid="live-add-asset-error"
            style={{ marginTop: 4, marginBottom: 4 }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" block loading={submitting} data-testid="live-add-asset-submit">
            Add token
          </Button>
        </div>
      </form>
    </Modal>
  );
}
