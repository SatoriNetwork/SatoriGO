// "Import Monero wallet" (Monero engine design §6.6, §10, §15 Set C).
//
// The only genuinely NEW onboarding screen Monero needs (§10): every other
// way to get a Monero wallet is "Add Monero" on an existing seed (a sibling
// action, like EVM's "Add account" — no form at all, Set D wires that button
// where LiveHome already has "Add account"). This screen exists only for
// restoring a Monero wallet that was NOT derived from this wallet's own
// phrase: 25 words from Feather, Cake (its "legacy"/25-word mode), or
// monero-wallet-cli.
//
// Unlike LiveOnboarding's generic recovery-phrase import (12/15/18/21/24-word
// BIP39, one password per wallet), this one asks for NO password: Monero
// joined the wallet after the app-password system (v2), and every entry this
// screen creates is protected the same way any other wallet created while the
// app is unlocked already is — importMoneroWallet takes no password argument
// (§15 Set D surface), matching addEvmAccount's shape exactly.

import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { liveService, useLiveStore } from '../../store/liveStore';
import { MIN_PASSWORD_LENGTH } from '../../services/constants';
import { isValidLegacyMnemonic, normalizeLegacyWords, MoneroMnemonicError } from '../../services/chain/monero/mnemonic';
import { MONERO_RELEASE_HEIGHT } from '../../services/chain/monero/rpc';
import { localIsoDate, MONERO_GENESIS_DATE, restoreHeightFromDate } from '../../services/chain/monero/restoreDate';

interface LiveImportMoneroProps {
  onBack(): void;
  /** Called with the id of the freshly imported wallet, which importMoneroWallet
   *  also makes the active one (same contract as addEvmAccount, §8 table). */
  onImported(walletId: string): void;
}

const LEGACY_MNEMONIC_WORD_COUNT = 25;

/** Live, word-by-word feedback as the user types: how many of the 25 slots
 *  are filled, and — once all 25 are — whether the checksum word (§3) agrees.
 *  Prefix-tolerant (normalizeLegacyWords), so "subt" reads as "subtly" the
 *  same way Monero's own wallets accept a partial word. */
function mnemonicHint(raw: string): { text: string; ok: boolean } {
  const trimmed = raw.trim();
  if (trimmed === '') return { text: `Paste your 25-word Monero recovery phrase.`, ok: false };
  let words: string[];
  try {
    words = normalizeLegacyWords(trimmed);
  } catch {
    words = trimmed.split(/\s+/).filter(Boolean);
  }
  if (words.length !== LEGACY_MNEMONIC_WORD_COUNT) {
    return { text: `${words.length} of ${LEGACY_MNEMONIC_WORD_COUNT} words.`, ok: false };
  }
  if (isValidLegacyMnemonic(trimmed)) {
    return { text: '25 words, checksum verified.', ok: true };
  }
  return { text: 'That checksum word does not match the other 24. Check for a typo.', ok: false };
}

export function LiveImportMonero({ onBack, onImported }: LiveImportMoneroProps) {
  const [name, setName] = useState('');
  const [words, setWords] = useState('');
  const [wordsError, setWordsError] = useState('');

  // Creation date OR an explicit height (§6.6: the words carry no birthday).
  // The date field is a convenience that FILLS the height field via the same
  // estimator MoneroSettingsSection's rescan form uses; the height field is
  // what is actually sent.
  const [dateText, setDateText] = useState('');
  const [heightText, setHeightText] = useState('');
  const [heightError, setHeightError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // THE VAULT PASSWORD (added by Set D when wiring importMoneroWallet). With an
  // app password set, the imported words are sealed under the app's master key
  // and no field is shown, exactly where an unlock would migrate them anyway.
  // Without one, the words need a wallet password of their own, asked here with
  // the same rule the recovery-phrase import applies (MIN_PASSWORD_LENGTH plus
  // a confirmation). A passwordless import is never offered: 25 Monero words
  // under an empty passphrase is the state the app-password design ends.
  const appPasswordSet = useLiveStore((s) => s.appPasswordSet);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const hint = mnemonicHint(words);

  const applyDate = (value: string) => {
    setDateText(value);
    setHeightError('');
    // Same rules as the switcher's "First used around" field: a future date is
    // refused, a date before Monero's genesis clamps to height 0, and the
    // estimate already starts a week early.
    const parsed = restoreHeightFromDate(value);
    if (parsed.kind === 'error') {
      setHeightError(parsed.error);
      return;
    }
    if (parsed.kind === 'ok') setHeightText(String(parsed.height));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setWordsError('');
    setHeightError('');

    const trimmedWords = words.trim();
    if (!isValidLegacyMnemonic(trimmedWords)) {
      setWordsError(
        hint.text.includes('words.')
          ? `Enter all ${LEGACY_MNEMONIC_WORD_COUNT} words.`
          : 'This does not look like a valid 25-word Monero recovery phrase. Check the checksum (last) word.',
      );
      return;
    }

    const heightTrimmed = heightText.trim();
    if (heightTrimmed === '') {
      setHeightError('Enter the creation date, or the exact block height, this wallet was created at.');
      return;
    }
    const height = Number(heightTrimmed);
    if (!Number.isFinite(height) || !Number.isInteger(height) || height < 0) {
      setHeightError('Enter a whole block height, 0 or greater.');
      return;
    }
    setPasswordError('');
    if (!appPasswordSet) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirm) {
        setPasswordError('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const summary = await liveService().importMoneroWallet(
        trimmedWords,
        height,
        name.trim() || undefined,
        appPasswordSet ? undefined : password,
      );
      setPassword('');
      setConfirm('');
      onImported(summary.id);
    } catch (err) {
      if (err instanceof MoneroMnemonicError) setWordsError(err.message);
      else setFormError(err instanceof Error ? err.message : 'Could not import this wallet.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Import Monero wallet</h2>
        <span />
      </div>
      <div className="app-content">
        {/* noValidate: the date field's min/max only steer the picker; every
            field is checked in handleSubmit, and a native range bubble on the
            date would block a pre-genesis date the rules clamp to 0. */}
        <form onSubmit={(e) => { void handleSubmit(e); }} noValidate data-testid="live-xmr-import">
          <p className="text-dim" style={{ fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
            Restore an existing Monero wallet from its 25-word recovery phrase (Feather, Cake's 25-word/legacy
            mode, or monero-wallet-cli).
          </p>

          <TextField
            label="Wallet name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Imported Monero"
            testId="live-xmr-import-name"
            autoComplete="off"
          />

          <div className="field" style={{ marginBottom: 13 }}>
            <label>25-word recovery phrase</label>
            <div className={`control${wordsError ? ' invalid' : ''}`} style={{ alignItems: 'flex-start', padding: '10px 12px' }}>
              <textarea
                rows={4}
                placeholder="word1 word2 word3 ..."
                value={words}
                onChange={(e) => { setWords(e.target.value); setWordsError(''); }}
                data-testid="live-xmr-import-words"
                aria-invalid={!!wordsError}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', resize: 'none', fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5 }}
              />
            </div>
            {wordsError ? (
              <span className="error" role="alert" data-testid="live-xmr-import-words-error">{wordsError}</span>
            ) : (
              <span className="hint" data-testid="live-xmr-import-words-hint" style={{ color: hint.ok ? 'var(--success)' : undefined }}>
                {hint.text}
              </span>
            )}
          </div>

          <TextField
            label="Creation date (approximate)"
            type="date"
            value={dateText}
            onChange={(e) => applyDate(e.target.value)}
            min={MONERO_GENESIS_DATE}
            max={localIsoDate()}
            testId="live-xmr-import-date"
            hint="Fills the block height below. Restoring from today misses older funds; from a date long ago takes hours."
          />

          <TextField
            label="Or exact block height"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={heightText}
            onChange={(e) => { setHeightText(e.target.value); setHeightError(''); }}
            placeholder={String(MONERO_RELEASE_HEIGHT)}
            testId="live-xmr-import-height"
            error={heightError || undefined}
          />

          {!appPasswordSet && (
            <>
              <PasswordField
                label="Wallet password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError('');
                }}
                testId="live-xmr-import-password"
                showLabel="Show password"
                hideLabel="Hide password"
                hint="Protects the 25 words on this device. You will need it to unlock and to send."
              />
              <PasswordField
                label="Confirm password"
                placeholder="Repeat the password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setPasswordError('');
                }}
                testId="live-xmr-import-password-confirm"
                showLabel="Show password"
                hideLabel="Hide password"
                error={passwordError || undefined}
              />
            </>
          )}

          {formError && (
            <div className="banner danger" style={{ margin: '10px 0' }} data-testid="live-xmr-import-error">
              {formError}
            </div>
          )}

          <Button type="submit" block loading={submitting} data-testid="live-xmr-import-submit" style={{ marginTop: 8 }}>
            Import wallet
          </Button>
        </form>
      </div>
    </div>
  );
}
