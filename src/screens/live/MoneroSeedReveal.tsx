// Monero export screen (Monero engine design §9, §10 "Export", §15 Set C).
//
// A SEPARATE component from RevealSecretModal, deliberately: that modal's
// `reveal` contract returns one plaintext STRING (a mnemonic or a private
// key), and a Monero export is two pieces of information a restoring wallet
// needs TOGETHER — the 25 words and the restore height (§9: "revealSecret for
// a monero entry returns the 25 words and the restore height, never the
// underlying BIP39 phrase"; §6.6/§10: Cake and Feather both ask for the
// height, and a user who does not have it rescans from genesis or from
// today). Squeezing that into one string would mean parsing it back apart to
// render the grid, or losing the height's own visual weight. This file is not
// owned by Set D (RevealSecretModal.tsx is), so it does not edit that
// component — it reuses the same building blocks (Modal, PasswordField,
// CopyButton, the clipboard auto-clear) and the same visual language (word
// grid, danger banner) LiveOnboarding's own recovery-phrase screen and
// RevealSecretModal already established, so this reads as one more instance
// of "the screen that shows a secret", not a different app.

import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { PasswordField } from '../../components/TextField';
import { CopyButton } from '../../components/CopyButton';
import { clearSecretClipboardNow } from '../../services/clipboard';

/** What LiveWalletService.revealSecret resolves for a monero entry (§15 Set D
 *  surface: `{ kind: 'monero-legacy-seed', words: string[]; restoreHeight: number }`).
 *  Only the two fields this screen draws are named here, so the caller's
 *  wrapper can hand this component exactly that shape (or a subset of it)
 *  without an extra mapping step. */
export interface MoneroSeedRevealSecret {
  words: string[];
  restoreHeight: number;
}

interface MoneroSeedRevealProps {
  /** True for a passwordless wallet: the reveal happens on open, no password
   *  field, same rule RevealSecretModal already applies. */
  noPassword: boolean;
  /** Verify the password (or accept '' when noPassword) and return the words +
   *  height, or null on a wrong password. */
  reveal(password: string): Promise<MoneroSeedRevealSecret | null>;
  onClose(): void;
  /** 'phrase' (default): a sibling derived from a recovery phrase, so the
   *  note names the derivation scheme. 'words': imported from its own 25
   *  words, so there is no phrase and no scheme to disclose. */
  keySource?: 'phrase' | 'words';
}

// THREE per row, not the design's five (§10 says "a 5 by 5 grid"): measured in
// the 400px popup on 2026-09-28, five tracks leave about 40px per word beside
// its number, and Monero's English words run to 12 letters ("cucumber",
// "necklace", "tapestry" all wrapped mid-word in the smoke screenshot). A
// recovery word that wraps or clips is a backup the user cannot write down;
// three tracks give each word about 80px, enough for the longest at this
// size. Nine rows fit the modal, which scrolls.
const WORDS_PER_ROW = 3;

export function MoneroSeedReveal({ noPassword, reveal, onClose, keySource = 'phrase' }: MoneroSeedRevealProps) {
  // The plaintext lives ONLY here and goes away with the component; never
  // logged, never persisted, never lifted into a store — same discipline as
  // RevealSecretModal.
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState<MoneroSeedRevealSecret | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!noPassword) return;
    let cancelled = false;
    setBusy(true);
    void (async () => {
      const value = await reveal('');
      if (cancelled) return;
      setBusy(false);
      if (value == null) setError('Could not reveal this wallet’s recovery words.');
      else setSecret(value);
    })();
    return () => {
      cancelled = true;
    };
    // Once per mount, exactly like RevealSecretModal: `reveal` is a fresh
    // closure on every render of the caller, and re-running this on every
    // keystroke elsewhere would re-decrypt the vault each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noPassword]);

  const close = () => {
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

  const wordsText = secret ? secret.words.join(' ') : '';

  return (
    <Modal title="Show Monero recovery words" onClose={close} testId="live-xmr-seed-reveal">
      <div className="banner danger" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
        <AlertTriangle size={14} />
        <span>Never share this. Anyone with these words and the restore height controls your Monero.</span>
      </div>

      {/* Owner-approved disclosure (§10 Export), verbatim: it names the three
          wallets a user might compare this against, and states the ONE thing
          that must never be silently different, the derivation scheme. */}
      <p className="text-dim" style={{ fontSize: 11.5, lineHeight: 1.5, marginBottom: 12 }} data-testid="live-xmr-seed-note">
        {keySource === 'words' ? (
          <>
            These are the 25 words this wallet was imported from; they are its spend key, not derived from a
            recovery phrase. They open this wallet in any Monero wallet.
          </>
        ) : (
          <>
            Derived from your recovery phrase the same way Cake Wallet&apos;s BIP39 option does. A Ledger or Trezor
            restored from the phrase shows a different Monero wallet. These 25 words open this wallet in any Monero
            wallet.
          </>
        )}
      </p>

      {secret ? (
        <div>
          <div
            data-testid="live-xmr-seed-grid"
            style={{
              display: 'grid',
              // minmax(0, 1fr), not a bare 1fr: a bare fr track can never shrink
              // below its content's min width, so five tracks holding words like
              // "necklace" grew past the 400px popup and the fifth column was cut
              // off (seen in the 2026-09-28 smoke screenshot). With a zero floor
              // the tracks share the width exactly and a long word wraps inside
              // its cell instead of pushing the grid out of view.
              gridTemplateColumns: `repeat(${WORDS_PER_ROW}, minmax(0, 1fr))`,
              gap: 5,
              background: 'var(--bg-elev)',
              borderRadius: 'var(--r-md)',
              border: '1px solid var(--border-strong)',
              padding: 10,
              marginBottom: 12,
            }}
          >
            {secret.words.map((word, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '5px 4px',
                  background: 'var(--card)',
                  borderRadius: 7,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  minWidth: 0,
                }}
              >
                <span style={{ fontSize: 9, color: 'var(--text-faint)', minWidth: 11, textAlign: 'right', flexShrink: 0 }}>{i + 1}.</span>
                {/* Wraps rather than truncates: a clipped recovery word is a
                    backup the user cannot write down. */}
                <span data-testid={`live-xmr-seed-word-${i + 1}`} style={{ minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.2 }}>
                  {word}
                </span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <CopyButton value={wordsText} label="Copy recovery words" size={14} secret testId="live-xmr-seed-copy" />
            <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 6, alignSelf: 'center' }}>
              Copy all 25 words
            </span>
          </div>

          <div
            className="card solid"
            style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <div>
              <div className="section-label" style={{ margin: 0 }}>Restore height</div>
              <p className="text-faint" style={{ fontSize: 10.5, margin: '2px 0 0' }}>
                Other Monero wallets need this alongside the words, or they rescan from genesis.
              </p>
            </div>
            <span className="mono" data-testid="live-xmr-seed-height" style={{ fontSize: 15, fontWeight: 700 }}>
              {secret.restoreHeight.toLocaleString('en-US')}
            </span>
          </div>

          <Button block variant="secondary" onClick={close} data-testid="live-xmr-seed-hide">
            Hide
          </Button>
        </div>
      ) : noPassword ? (
        <div>
          <p className="text-dim" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
            {busy ? 'Revealing…' : 'This wallet has no password, so the recovery words are revealed directly.'}
          </p>
          {error && (
            <span role="alert" data-testid="live-xmr-seed-error" style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginBottom: 8 }}>
              {error}
            </span>
          )}
          <Button block variant="secondary" onClick={close}>
            Close
          </Button>
        </div>
      ) : (
        <form onSubmit={(e) => { void submit(e); }}>
          <p className="text-dim" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
            Enter your wallet password to reveal your Monero recovery words.
          </p>
          <PasswordField
            label="Wallet password"
            showLabel="Show password"
            hideLabel="Hide password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            placeholder="Enter password"
            autoFocus
            testId="live-xmr-seed-password"
          />
          {error && (
            <span role="alert" data-testid="live-xmr-seed-password-error" style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 2 }}>
              {error}
            </span>
          )}
          <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" block loading={busy} data-testid="live-xmr-seed-reveal-submit">
              Reveal
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
