// THE ONE SCREEN THAT SHOWS A SECRET, wherever it is asked for.
//
// It was born inside LiveSettings and lived there alone. The forced app-password
// setup (the app-password design notes §12) has to offer the same act ("show me my
// recovery phrase before you take no-password access away"), and a second screen
// showing seed words is exactly the kind of thing that drifts: one of them grows
// a warning the other never gets, one clears the clipboard and the other does
// not. So the screen moved here whole, with its danger banner, its copy, its
// testids and its clipboard hygiene, and both callers render THIS.
//
// The caller decides only what this cannot know: which secret it is, whether a
// password is needed for it, and what extra sentence belongs above it.

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { PasswordField } from '../../components/TextField';
import { CopyButton } from '../../components/CopyButton';
import { clearSecretClipboardNow } from '../../services/clipboard';

/** Which secret is on screen. 'seed' = the recovery phrase; 'key' = a private key. */
export type RevealKind = 'seed' | 'key';

interface RevealSecretModalProps {
  kind: RevealKind;
  /** Title override. Defaults to the kind's own wording. */
  title?: string;
  /** True when this secret opens with NO password at all (a passwordless
   *  wallet): the reveal then happens on open, with no field to fill in. */
  noPassword: boolean;
  /** Extra lines under the danger banner (which account this key belongs to,
   *  what these words restore). Rendered exactly where the caller's own notes
   *  used to sit. */
  notes?: ReactNode;
  /** Label + placeholder for the password field. */
  passwordLabel?: string;
  /** The sentence shown while a passwordless reveal is running / has run. */
  noPasswordNote?: string;
  /** Verify and return the secret, or null when the password is wrong. */
  reveal: (password: string) => Promise<string | null>;
  onClose: () => void;
}

export function RevealSecretModal({
  kind,
  title,
  noPassword,
  notes,
  passwordLabel = 'Wallet password',
  noPasswordNote = 'This wallet has no password, so the secret is revealed directly.',
  reveal,
  onClose,
}: RevealSecretModalProps) {
  // The plaintext secret lives ONLY here and goes away with the component; it is
  // never logged, never persisted and never lifted into a store.
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // A passwordless wallet has no password to ask for: reveal on open, exactly as
  // the Settings screen has always done for one.
  useEffect(() => {
    if (!noPassword) return;
    let cancelled = false;
    setBusy(true);
    void (async () => {
      const value = await reveal('');
      if (cancelled) return;
      setBusy(false);
      if (value == null) setError('Could not reveal this secret.');
      else setSecret(value);
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately once per mount: `reveal` is a fresh closure on every render of
    // the caller, and re-running this would re-decrypt the vault on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noPassword]);

  const close = () => {
    // Clear the plaintext as the panel closes, AND wipe it from the clipboard if
    // that is where the user just put it. Done here, not on popup teardown,
    // because the Clipboard API needs a focused document and a closing popup no
    // longer has one (see services/clipboard.ts).
    void clearSecretClipboardNow();
    setPassword('');
    setSecret(null);
    setError('');
    setBusy(false);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    const value = await reveal(password);
    setBusy(false);
    if (value == null) {
      setError('Incorrect password.');
      return;
    }
    setSecret(value);
    setPassword('');
  };

  return (
    <Modal
      title={title ?? (kind === 'seed' ? 'Show recovery phrase' : 'Show private key')}
      onClose={close}
      testId="live-reveal-modal"
    >
      <div className="banner danger" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
        <AlertTriangle size={14} />
        <span>Never share this. Anyone with it controls your funds.</span>
      </div>

      {notes}

      {secret != null ? (
        <div>
          <div
            className="mono"
            data-testid="live-reveal-output"
            style={{
              fontSize: 12.5,
              wordBreak: 'break-all',
              lineHeight: 1.6,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--r-md)',
              padding: 12,
              marginBottom: 10,
            }}
          >
            {secret}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
            <CopyButton value={secret} label="Copy secret" size={14} secret />
            <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 6 }}>Copy</span>
          </div>
          <Button block variant="secondary" onClick={close} data-testid="live-reveal-hide">
            Hide
          </Button>
        </div>
      ) : noPassword ? (
        <div>
          <p className="text-dim" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
            {busy ? 'Revealing…' : noPasswordNote}
          </p>
          {error && (
            <span
              role="alert"
              data-testid="live-reveal-error"
              style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginBottom: 8 }}
            >
              {error}
            </span>
          )}
          <Button block variant="secondary" onClick={close}>
            Close
          </Button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <p className="text-dim" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
            Enter your wallet password to reveal your{' '}
            {kind === 'seed' ? 'recovery phrase' : 'private key'}.
          </p>
          <PasswordField
            label={passwordLabel}
            showLabel="Show password"
            hideLabel="Hide password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            placeholder="Enter password"
            autoFocus
            testId="live-reveal-password"
          />
          {error && (
            <span
              role="alert"
              data-testid="live-reveal-error"
              style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 2 }}
            >
              {error}
            </span>
          )}
          <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" block loading={busy} data-testid="live-reveal-submit">
              Reveal
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
