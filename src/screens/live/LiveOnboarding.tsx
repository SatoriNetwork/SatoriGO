import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Download, AlertTriangle, Fingerprint, Info, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/TextField';
import { CopyButton } from '../../components/CopyButton';
import { clearSecretClipboardNow } from '../../services/clipboard';
import { BrandLogo } from '../../components/BrandLogo';
import { ConstellationField } from '../../components/ConstellationField';
import { PasswordStrengthBar } from '../../components/PasswordStrengthBar';
import { useLiveStore, chainDisplayName } from '../../store/liveStore';
import { MIN_PASSWORD_LENGTH } from '../../services/constants';
import {
  buildQuiz,
  checkQuiz,
  pickQuizPositions,
  type Quiz,
  type QuizChoice,
} from '../../services/mnemonicQuiz';
import { networkFor, type EvrmoreNetwork } from '../../services/chain/chainParams';
import { classifyPrivateKeyOrigin } from '../../services/chain/keys';
import { isEvmChainTarget } from '../../store/evmChains';
import { ChainPicker, CHAIN_OPTIONS, type ChainChoice } from './ChainPicker';

type Step = 'choose' | 'create-form' | 'mnemonic' | 'import-form' | 'pk-form';

const PASSWORDLESS_ACK_WARNING =
  'No password: anyone with access to this computer or your Chrome profile can take these funds.';

const PASSWORDLESS_ACK_REQUIRED = 'Check the box to confirm you understand the risk.';

/** The five phrase lengths BIP39 defines (128, 160, 192, 224 and 256 bits of
 *  entropy). validateMnemonic accepts every one of them, so the form must too. */
const BIP39_WORD_COUNTS = [12, 15, 18, 21, 24];

/** Map raw key-parsing errors to a clear message for the private-key form. */
function mapPkError(msg: string): string {
  if (/empty/i.test(msg)) return 'Enter a private key (WIF or hex).';
  if (/secp256k1|scalar|payload length|checksum|base58|invalid/i.test(msg)) {
    return "That doesn't look like a valid private key. Paste a WIF or a 64-character hex key.";
  }
  return msg;
}

/** The chains a user can actually PICK, as network params, read from the picker's
 *  own option list so a chain added there is covered here without a second edit.
 *  This is what the WIF version byte gets compared against below: a byte outside
 *  this set belongs to nothing the user could have selected. */
const PICKABLE_NETWORKS: EvrmoreNetwork[] = CHAIN_OPTIONS.map((o) => networkFor(o.value));

/** "Litecoin", "Litecoin or BitcoinGold", "A, B or C" — names from the chain
 *  params, never hardcoded. */
function joinChainNames(nets: readonly EvrmoreNetwork[]): string {
  const names = nets.map((n) => n.displayName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * What (if anything) to tell the user about the WIF version byte of the key they
 * pasted, given the chain they selected. Returns a hard `error` that blocks the
 * import, a soft `warning` that does not, an informational `notice` that also
 * does not, or neither.
 *
 * REJECT vs WARN vs NOTICE, and why the line is drawn here:
 *
 *   - A byte belonging to NO pickable chain is REJECTED. There is no reading of
 *     that paste under which this wallet is the right home for the key: the most
 *     likely case is a testnet key (Bitcoin testnet is 0xEF), which today
 *     imports happily and hands the user a real, fundable MAINNET address that
 *     none of their coins are on. Nothing is lost by refusing, because the key
 *     cannot belong to a chain the picker offers.
 *
 *   - A byte belonging to a DIFFERENT pickable chain only WARNS. Re-using one
 *     key across chains is a thing this wallet supports on purpose (enabling a
 *     chain on a single-key wallet does exactly that), so the user may know
 *     precisely what they are doing, and blocking would break a legitimate flow
 *     to protect against a guess.
 *
 *   - A byte matching the SELECTED chain, but ALSO matching other pickable
 *     chains, gets a NOTICE, not silence. 128 is Evrmore, Ravencoin AND
 *     Bitcoin, so "the prefix matches" is not proof the key was made for this
 *     one; the honest thing is to say the check cannot see past the shared
 *     byte, before the import rather than never. This is item 10 of
 *     KNOWN_LIMITATIONS.md made visible at the one screen it affects. It must
 *     never read as a warning: nothing here suggests the key is wrong, and the
 *     import proceeds exactly as it would without this notice.
 *
 *   - A byte matching the SELECTED chain and NO other pickable chain says
 *     nothing worth saying, so nothing is said.
 *
 *   - A raw 64-character hex key carries no version byte at all and is always
 *     accepted in silence. There is nothing to compare.
 */
function pkChainNotice(
  input: string,
  network: ChainChoice,
): { error?: string; warning?: string; notice?: string } {
  // This whole check is about a WIF version byte, a UTXO-only encoding: an EVM
  // account takes a raw secp256k1 key with no chain-tagged prefix at all (see
  // importPrivateKeyWallet's EVM branch in the store), so there is nothing here
  // to compare and nothing to say. Also guards the networkFor() call below,
  // which does not know an `evm:<key>` target.
  if (isEvmChainTarget(network)) return {};
  const target = networkFor(network);
  const origin = classifyPrivateKeyOrigin(input, target, PICKABLE_NETWORKS);
  if (origin.kind === 'unknown-chain') {
    return {
      // "a new <name>" rather than "a <name>": chain names come from the params
      // and some of them start with a vowel, so no bare article can be correct
      // for all of them.
      error:
        `This private key is for another network: its WIF prefix (version byte ${origin.version}) ` +
        `is not used by any chain in this wallet. Importing it here would create a new ` +
        `${target.displayName} address that none of its coins are on.`,
    };
  }
  if (origin.kind === 'other-chain') {
    return {
      warning:
        `This key's WIF prefix belongs to ${joinChainNames(origin.chains)}, not ${target.displayName}. ` +
        `Importing it here derives a new ${target.displayName} address, which is not the address its ` +
        `coins are on. Chains share WIF prefixes, so this cannot always tell them apart.`,
    };
  }
  if (origin.kind === 'selected-chain' && origin.chains.length > 1) {
    // `chains` includes the selected chain itself (that is what made it
    // 'selected-chain'); compare on chainId, not object identity or the legacy
    // `id` field, since Ravencoin mainnet also carries id:'mainnet'.
    const others = origin.chains.filter((n) => n.chainId !== target.chainId);
    return {
      notice:
        `This key will be imported as ${target.displayName}. Its WIF prefix is also used by ` +
        `${joinChainNames(others)}, so the wallet cannot tell which of these chains it was actually ` +
        `created for. If it did not come from ${target.displayName}, this import will still succeed ` +
        `and will not find the coins.`,
    };
  }
  return {};
}

/** The shared "Create without a password" opt-in + the password fields it hides.
 *  Used identically by every create/import form so the passwordless behaviour is
 *  consistent. When checked the password fields are replaced by a warning banner
 *  and the caller submits with an empty password (''). */
function PasswordSection({
  noPassword,
  onToggleNoPassword,
  password,
  setPassword,
  confirm,
  setConfirm,
  error,
  passwordLabel,
  ack,
  onToggleAck,
}: {
  noPassword: boolean;
  onToggleNoPassword(v: boolean): void;
  password: string;
  setPassword(v: string): void;
  confirm: string;
  setConfirm(v: string): void;
  error?: string;
  passwordLabel: string;
  /** Required confirmation ("I understand the risk") once noPassword is on. */
  ack: boolean;
  onToggleAck(v: boolean): void;
}) {
  return (
    <>
      {/* Same custom check-tile design as the ack tile below (one checkbox
          design per screen). role="checkbox" + aria-checked kept: the smoke
          drives this via Playwright .check(), which needs the checkbox role. */}
      <div
        role="checkbox"
        aria-checked={noPassword}
        tabIndex={0}
        data-testid="live-no-password"
        onClick={() => onToggleNoPassword(!noPassword)}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onToggleNoPassword(!noPassword);
          }
        }}
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          cursor: 'pointer',
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
          padding: '10px 12px',
          margin: '4px 0 12px',
        }}
      >
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 5,
            border: `2px solid ${noPassword ? 'var(--danger)' : 'var(--border-strong)'}`,
            background: noPassword ? 'var(--danger-bg)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: 1,
            transition: 'all 0.15s',
          }}
        >
          {noPassword && <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 700 }}>✓</span>}
        </div>
        <span style={{ fontSize: 12, lineHeight: 1.5 }}>
          <strong>Create without a password (less secure)</strong>
          <span className="text-dim" style={{ display: 'block', fontWeight: 400, marginTop: 1 }}>
            No password to unlock or send. Convenient, but anyone using this browser can drain it.
          </span>
        </span>
      </div>

      {noPassword ? (
        <>
          <div
            className="banner danger"
            data-testid="live-no-password-warning"
            style={{ marginBottom: 10, alignItems: 'flex-start' }}
          >
            <AlertTriangle size={14} />
            <span>{PASSWORDLESS_ACK_WARNING}</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'var(--card)',
              borderRadius: 'var(--r-md)',
              border: '1px solid var(--border)',
              padding: '10px 12px',
              marginBottom: 4,
              cursor: 'pointer',
            }}
            onClick={() => onToggleAck(!ack)}
            role="checkbox"
            aria-checked={ack}
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggleAck(!ack); } }}
            data-testid="passwordless-ack"
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 5,
                border: `2px solid ${ack ? 'var(--success)' : 'var(--border-strong)'}`,
                background: ack ? 'var(--success-bg)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'all 0.15s',
              }}
            >
              {ack && <span style={{ color: 'var(--success)', fontSize: 11, fontWeight: 700 }}>✓</span>}
            </div>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>I understand the risk</span>
          </div>
        </>
      ) : (
        <>
          <PasswordField
            label={passwordLabel}
            showLabel="Show"
            hideLabel="Hide"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            testId="live-password"
          />
          <PasswordStrengthBar password={password} />
          <PasswordField
            label="Confirm password"
            showLabel="Show"
            hideLabel="Hide"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repeat password"
            testId="live-password-confirm"
            error={error}
          />
        </>
      )}
    </>
  );
}

/**
 * The optional BIP39 passphrase ("25th word") on a NEWLY CREATED wallet.
 *
 * Built as the same explicit check-tile as "Create without a password" above,
 * deliberately NOT as the <details> disclosure the import form uses. A <details>
 * keeps whatever was typed inside it when it is collapsed again, so a user could
 * type a passphrase, close it believing they had cancelled, and walk away with a
 * wallet their recovery phrase alone will never reopen. Toggling this off clears
 * both fields, so there is no invisible state.
 *
 * Typed TWICE, unlike the import form's single field, because the two cases are
 * not symmetric. On import the passphrase already exists, so a typo shows up
 * immediately as an empty wallet the user can retry. On creation there is
 * nothing to compare against, ever: a typo silently mints a different wallet at
 * a different address, and the mistyped string is never written down anywhere.
 * The confirmation field is the only check that can exist here.
 */
function CreatePassphraseSection({
  enabled,
  onToggle,
  passphrase,
  setPassphrase,
  confirm,
  setConfirm,
  error,
  noPassword,
}: {
  enabled: boolean;
  onToggle(v: boolean): void;
  passphrase: string;
  setPassphrase(v: string): void;
  confirm: string;
  setConfirm(v: string): void;
  error?: string;
  /** The wallet is being created without a password, which changes what can
   *  honestly be said about how the passphrase is stored. */
  noPassword: boolean;
}) {
  return (
    <>
      <div
        role="checkbox"
        aria-checked={enabled}
        tabIndex={0}
        data-testid="live-create-passphrase-optin"
        onClick={() => onToggle(!enabled)}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onToggle(!enabled);
          }
        }}
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          cursor: 'pointer',
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
          padding: '10px 12px',
          margin: '4px 0 12px',
        }}
      >
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 5,
            border: `2px solid ${enabled ? 'var(--danger)' : 'var(--border-strong)'}`,
            background: enabled ? 'var(--danger-bg)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: 1,
            transition: 'all 0.15s',
          }}
        >
          {enabled && <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 700 }}>✓</span>}
        </div>
        <span style={{ fontSize: 12, lineHeight: 1.5 }}>
          <strong>Add a BIP39 passphrase (advanced)</strong>
          <span className="text-dim" style={{ display: 'block', fontWeight: 400, marginTop: 1 }}>
            A 25th word folded into your recovery phrase. Leave this off unless you already know you want one.
          </span>
        </span>
      </div>

      {enabled && (
        <>
          <div
            className="banner danger"
            data-testid="live-create-passphrase-warning"
            style={{ marginBottom: 12, alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}
          >
            <strong>Your recovery phrase alone will no longer restore this wallet.</strong>
            <span style={{ fontWeight: 400 }}>
              Restoring needs the phrase and this passphrase together. Nobody, including us, can
              recover it or reset it. Lose it and these coins are gone for good.
            </span>
          </div>

          <PasswordField
            label="BIP39 passphrase"
            showLabel="Show"
            hideLabel="Hide"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter passphrase"
            testId="live-create-passphrase"
          />
          <PasswordField
            label="Confirm passphrase"
            showLabel="Show"
            hideLabel="Hide"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repeat passphrase"
            testId="live-create-passphrase-confirm"
            error={error}
          />
          {/* Item 16 of KNOWN_LIMITATIONS.md, said at the one screen where the
              user is choosing to take it on rather than buried in a document. */}
          <span className="text-faint" style={{ fontSize: 10.5, display: 'block', marginTop: -6, marginBottom: 12 }}>
            {noPassword
              ? 'It is stored next to your recovery phrase, and with no wallet password anyone using this browser can read both. It does not give you the deniability a passphrase kept outside the wallet would.'
              : 'It is stored encrypted next to your recovery phrase, under your wallet password, so this wallet can unlock later. That means it does not give you the deniability a passphrase kept outside the wallet would.'}
          </span>
        </>
      )}
    </>
  );
}

function CreateForm({ onBack }: { onBack(): void }) {
  const createWallet = useLiveStore((s) => s.createWallet);
  const addingWallet = useLiveStore((s) => s.addingWallet);
  const error = useLiveStore((s) => s.error);
  const [name, setName] = useState('');
  const [network, setNetwork] = useState<ChainChoice>('mainnet');
  // Chains switched off in expert Settings are not offered for a new wallet.
  const hiddenChains = useLiveStore((s) => s.hiddenChains);
  // Empty in a build without the EVM engine, which drops the picker back to
  // its UTXO-only rows (see ChainPicker's own doc comment).
  const evmChains = useLiveStore((s) => s.evm.chains);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [noPassword, setNoPassword] = useState(false);
  const [ack, setAck] = useState(false);
  // Opt-in BIP39 passphrase, off by default. Its own error slot, routed under the
  // Confirm passphrase field: painting it on the wallet-password pair would
  // redden the wrong field, the same trap the import form's phraseError avoids.
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [passphraseError, setPassphraseError] = useState('');
  const [localError, setLocalError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setPassphraseError('');
    // Checked BEFORE the password fields. A password complaint is recoverable
    // noise; a mistyped passphrase is the one mistake on this form that cannot
    // be undone afterwards, so it must never be buried under "min 8 characters".
    if (usePassphrase) {
      if (!passphrase) {
        setPassphraseError('Enter a passphrase, or switch this option back off.');
        return;
      }
      if (passphrase !== passphraseConfirm) {
        setPassphraseError('Passphrases do not match.');
        return;
      }
    }
    if (!noPassword) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirm) {
        setLocalError('Passwords do not match.');
        return;
      }
    } else if (!ack) {
      setLocalError(PASSWORDLESS_ACK_REQUIRED);
      return;
    }
    setLoading(true);
    // `usePassphrase &&` is the second guard: the toggle already clears the
    // fields, so a value can only survive here as a bug, and this is a bug that
    // would create a wallet the user cannot restore.
    await createWallet(noPassword ? '' : password, name, network, usePassphrase ? passphrase : '');
    setLoading(false);
  };

  const displayError = localError || error;

  return (
    <form onSubmit={handleSubmit} data-testid="live-create" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <h3 style={{ marginBottom: 4 }}>{addingWallet ? 'Add a wallet' : 'Create live wallet'}</h3>
      <p className="text-dim" style={{ fontSize: 12, marginBottom: 18 }}>
        {`A new wallet will be created on the real ${chainDisplayName(network)} mainnet. Your recovery phrase will be shown once. Write it down.`}
      </p>

      <TextField
        label="Wallet name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Savings"
        testId="live-wallet-name"
        autoComplete="off"
      />

      <ChainPicker
        hidden={hiddenChains}
        evmChains={evmChains}
        value={network}
        onChange={setNetwork}
        testIdPrefix="live-create-chain"
        secretKind="phrase"
      />

      <PasswordSection
        noPassword={noPassword}
        onToggleNoPassword={(v) => { setNoPassword(v); setAck(false); setLocalError(''); }}
        password={password}
        setPassword={setPassword}
        confirm={confirm}
        setConfirm={setConfirm}
        error={displayError ?? undefined}
        passwordLabel={`Password (min ${MIN_PASSWORD_LENGTH} chars)`}
        ack={ack}
        onToggleAck={(v) => { setAck(v); setLocalError(''); }}
      />

      {noPassword && displayError && (
        <span role="alert" style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 2 }}>
          {displayError}
        </span>
      )}

      {/* Below the password choice on purpose: what can honestly be said about
          where the passphrase is stored is a statement ABOUT that choice, so it
          reads correctly only once the choice is already on screen. */}
      <div style={{ marginTop: 14 }}>
        <CreatePassphraseSection
          enabled={usePassphrase}
          onToggle={(v) => {
            setUsePassphrase(v);
            // Switching it off must leave nothing behind: a remembered value
            // would silently derive a different wallet on submit.
            setPassphrase('');
            setPassphraseConfirm('');
            setPassphraseError('');
          }}
          passphrase={passphrase}
          setPassphrase={setPassphrase}
          confirm={passphraseConfirm}
          setConfirm={setPassphraseConfirm}
          error={passphraseError || undefined}
          noPassword={noPassword}
        />
      </div>

      <div style={{ display: 'flex', gap: 9, marginTop: 6 }}>
        <Button type="button" variant="secondary" onClick={onBack}>Back</Button>
        <Button type="submit" block loading={loading} data-testid="live-create-submit">
          Create wallet
        </Button>
      </div>
    </form>
  );
}

/**
 * "Confirm your recovery phrase": the second half of the backup step, between
 * the words and the wallet, on CREATED wallets only.
 *
 * A checkbox saying "I saved it" is a promise, not evidence, and the phrase is
 * never shown again after this screen. Asking for three words back at positions
 * the user could not have predicted is the only moment where a phrase that was
 * never actually written down can still be caught, while the words are one tap
 * away behind "Back to the phrase".
 *
 * A wrong answer clears the blanks and says so, and that is all it does: there
 * is no lockout and no limit, because the user is not an attacker here and the
 * only thing a hard failure mode would achieve is pushing them to screenshot the
 * phrase. Import never sees this screen (the phrase came from the user).
 */
function MnemonicVerify({
  words,
  quiz,
  onBack,
  onConfirmed,
}: {
  words: string[];
  /** Owned by MnemonicView, so stepping back to the words and returning asks
   *  for the SAME positions. Re-rolling them there would look like the wallet
   *  moving the goalposts while the user is trying to comply. */
  quiz: Quiz;
  onBack(): void;
  onConfirmed(): void;
}) {
  const [answers, setAnswers] = useState<(QuizChoice | null)[]>(() => quiz.positions.map(() => null));
  const [error, setError] = useState('');

  const usedIds = new Set(answers.filter((a): a is QuizChoice => !!a).map((a) => a.id));
  const complete = answers.every((a) => !!a);

  /** A tapped chip drops into the first empty blank, left to right. */
  const place = (choice: QuizChoice) => {
    setError('');
    setAnswers((prev) => {
      const idx = prev.findIndex((a) => !a);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = choice;
      return next;
    });
  };

  /** A tapped blank empties itself and returns its chip to the bank. */
  const clearSlot = (idx: number) => {
    setError('');
    setAnswers((prev) => {
      if (!prev[idx]) return prev;
      const next = [...prev];
      next[idx] = null;
      return next;
    });
  };

  const submit = () => {
    if (checkQuiz(words, quiz.positions, answers.map((a) => a?.word ?? null))) {
      onConfirmed();
      return;
    }
    // Clearing on a wrong answer is deliberate: leaving three wrong words in
    // place invites re-submitting the same guess.
    setAnswers(quiz.positions.map(() => null));
    setError('Those are not the right words. Check your backup and try again.');
  };

  return (
    <div data-testid="live-mnemonic-verify">
      <h3 style={{ marginBottom: 6 }}>Confirm your recovery phrase</h3>
      <p className="text-dim" style={{ fontSize: 12, marginBottom: 14 }}>
        Tap the words that belong in these spots, using the phrase you just wrote down.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${quiz.positions.length}, 1fr)`,
          gap: 8,
          marginBottom: 12,
        }}
      >
        {quiz.positions.map((position, idx) => {
          const filled = answers[idx];
          return (
            <div key={position} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="text-faint" style={{ fontSize: 10.5, fontWeight: 600 }}>
                Word #{position}
              </span>
              <button
                type="button"
                data-testid={`live-mnemonic-slot-${position}`}
                aria-label={`Word number ${position}${filled ? `: ${filled.word}, tap to clear` : ', empty'}`}
                onClick={() => clearSlot(idx)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  minHeight: 34,
                  padding: '6px 6px',
                  borderRadius: 8,
                  cursor: filled ? 'pointer' : 'default',
                  color: 'var(--text)',
                  background: filled ? 'var(--card)' : 'transparent',
                  border: filled
                    ? '1px solid var(--border-strong)'
                    : '1px dashed var(--border-strong)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {filled?.word ?? ''}
              </button>
            </div>
          );
        })}
      </div>

      {error && (
        <div
          className="banner danger"
          role="alert"
          data-testid="live-mnemonic-verify-error"
          style={{ marginBottom: 12, alignItems: 'flex-start' }}
        >
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div
        data-testid="live-mnemonic-choices"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 7,
          justifyContent: 'center',
          background: 'var(--bg-elev)',
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--border-strong)',
          padding: 12,
          marginBottom: 14,
        }}
      >
        {quiz.bank.map((choice) => {
          const used = usedIds.has(choice.id);
          return (
            <button
              key={choice.id}
              type="button"
              disabled={used}
              data-testid={`live-mnemonic-choice-${choice.id}`}
              onClick={() => place(choice)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 11px',
                borderRadius: 7,
                border: '1px solid var(--border-strong)',
                background: 'var(--card)',
                color: 'var(--text)',
                cursor: used ? 'default' : 'pointer',
                opacity: used ? 0.28 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {choice.word}
            </button>
          );
        })}
      </div>

      <Button
        block
        disabled={!complete}
        onClick={submit}
        data-testid="live-mnemonic-verify-submit"
        icon={<ShieldCheck size={15} />}
      >
        Confirm
      </Button>
      <Button
        block
        variant="ghost"
        onClick={onBack}
        data-testid="live-mnemonic-verify-back"
        style={{ marginTop: 8 }}
      >
        Back to the phrase
      </Button>
    </div>
  );
}

function MnemonicView({ mnemonic, hasPassphrase }: { mnemonic: string; hasPassphrase: boolean }) {
  const clearPendingMnemonic = useLiveStore((s) => s.clearPendingMnemonic);
  const words = mnemonic.trim().split(/\s+/);
  const [saved, setSaved] = useState(false);
  // The words themselves are gone from the screen while the quiz is up: leaving
  // them visible would turn "confirm your backup" into a copying exercise.
  const [verifying, setVerifying] = useState(false);
  // Rolled once for this wallet, and held above the quiz view so it survives
  // "Back to the phrase" (see MnemonicVerify's `quiz` prop).
  const [quiz] = useState<Quiz>(() => buildQuiz(words, pickQuizPositions(words.length)));

  // Leaving this screen wipes the phrase from the clipboard if the user copied
  // it, without waiting out the 30 s timer. It runs here rather than on popup
  // teardown because the Clipboard API needs a focused document, which a
  // closing popup does not have (see services/clipboard.ts). A no-op unless a
  // SECRET is what we last put there, so an address copied afterwards survives.
  useEffect(() => () => { void clearSecretClipboardNow(); }, []);

  if (verifying) {
    return (
      <div data-testid="live-onboarding">
        <MnemonicVerify
          words={words}
          quiz={quiz}
          onBack={() => setVerifying(false)}
          onConfirmed={clearPendingMnemonic}
        />
      </div>
    );
  }

  return (
    <div data-testid="live-onboarding">
      <h3 style={{ marginBottom: 6 }}>Your recovery phrase</h3>
      {/* "the ONLY backup" is true for the overwhelming majority of wallets and
          FALSE for a passphrase one, where these words restore nothing on their
          own. Getting that wrong here is not a wording nit: it is the sentence
          the user acts on when deciding what to write down. */}
      <div
        className="banner danger"
        data-testid="live-mnemonic-warning"
        style={{ marginBottom: 14, alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}
      >
        {hasPassphrase ? (
          <>
            <strong>Write this down. This phrase alone will NOT restore this wallet.</strong>
            <span style={{ fontWeight: 400 }}>
              You set a BIP39 passphrase, so restoring needs the phrase and that passphrase
              together. The phrase will not be shown again and nobody, including us, can recover
              either one. Anyone with both controls your funds.
            </span>
          </>
        ) : (
          <>
            <strong>Write this down. It is the ONLY backup.</strong>
            <span style={{ fontWeight: 400 }}>It will not be shown again. Anyone with this phrase controls your funds.</span>
          </>
        )}
      </div>

      <div
        data-testid="live-mnemonic"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 7,
          background: 'var(--bg-elev)',
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--border-strong)',
          padding: 12,
          marginBottom: 12,
        }}
      >
        {words.map((word, i) => (
          <div
            key={i}
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: '5px 8px',
              background: 'var(--card)',
              borderRadius: 7,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ fontSize: 10, color: 'var(--text-faint)', minWidth: 14, textAlign: 'right' }}>{i + 1}.</span>
            {/* Per-word testid (1-based, matching the number shown): the quiz
                below asks for words by POSITION, so the tests and the smokes
                need to read the phrase position by position, not as one blob. */}
            <span data-testid={`live-mnemonic-word-${i + 1}`}>{word}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <CopyButton value={mnemonic} label="Copy recovery phrase" size={14} secret />
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 6, alignSelf: 'center' }}>
          Copy all words
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'var(--card)',
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--border)',
          padding: '10px 12px',
          marginBottom: 14,
          cursor: 'pointer',
        }}
        onClick={() => setSaved((v) => !v)}
        role="checkbox"
        aria-checked={saved}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') setSaved((v) => !v); }}
        data-testid="live-mnemonic-saved"
      >
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 5,
            border: `2px solid ${saved ? 'var(--success)' : 'var(--border-strong)'}`,
            background: saved ? 'var(--success-bg)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'all 0.15s',
          }}
        >
          {saved && <span style={{ color: 'var(--success)', fontSize: 11, fontWeight: 700 }}>✓</span>}
        </div>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>
          {hasPassphrase
            ? 'I have written down my recovery phrase and my passphrase, and stored them safely.'
            : 'I have written down my recovery phrase and stored it safely.'}
        </span>
      </div>

      {/* Goes to the confirmation quiz, not to the wallet. The label is unchanged
          because what it promises is unchanged: this is still the way out of the
          phrase screen, and the step behind it takes seconds. */}
      <Button block disabled={!saved} onClick={() => setVerifying(true)} icon={<Download size={15} />}>
        I saved it, continue to wallet
      </Button>
    </div>
  );
}

function ImportForm({ onBack }: { onBack(): void }) {
  const importWallet = useLiveStore((s) => s.importWallet);
  const addingWallet = useLiveStore((s) => s.addingWallet);
  const [name, setName] = useState('');
  const [network, setNetwork] = useState<ChainChoice>('mainnet');
  // Chains switched off in expert Settings are not offered for a new wallet.
  const hiddenChains = useLiveStore((s) => s.hiddenChains);
  // Empty in a build without the EVM engine, which drops the picker back to
  // its UTXO-only rows (see ChainPicker's own doc comment).
  const evmChains = useLiveStore((s) => s.evm.chains);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [noPassword, setNoPassword] = useState(false);
  const [ack, setAck] = useState(false);
  // Two error slots, routed to the field each is ABOUT: phrase-shape/import
  // errors under the Recovery phrase textarea, password errors on the password
  // pair. One shared slot used to paint "Recovery phrase must be 12 or 24
  // words." under Confirm password and redden the wrong field.
  const [passphrase, setPassphrase] = useState('');
  const [phraseError, setPhraseError] = useState('');
  const [localError, setLocalError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setPhraseError('');
    const trimmed = phrase.trim().replace(/\s+/g, ' ');
    const wordCount = trimmed.split(' ').length;
    // BIP39 defines FIVE lengths (128 to 256 bits of entropy). The core accepts
    // all five; this form used to reject three of them, so a valid 15, 18 or
    // 21-word phrase could not be imported at all.
    if (!BIP39_WORD_COUNTS.includes(wordCount)) {
      setPhraseError('Recovery phrase must be 12, 15, 18, 21 or 24 words.');
      return;
    }
    if (!noPassword) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirm) {
        setLocalError('Passwords do not match.');
        return;
      }
    } else if (!ack) {
      setLocalError(PASSWORDLESS_ACK_REQUIRED);
      return;
    }
    setLoading(true);
    try {
      await importWallet(trimmed, noPassword ? '' : password, name, network, passphrase);
    } catch (err) {
      // importWallet only throws about the secret itself (e.g. an invalid
      // BIP39 checksum), so this belongs to the phrase field too.
      setPhraseError(err instanceof Error ? err.message : 'Import failed');
    }
    setLoading(false);
  };

  return (
    <form onSubmit={handleSubmit} data-testid="live-import" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <h3 style={{ marginBottom: 4 }}>{addingWallet ? 'Add a wallet' : 'Import wallet'}</h3>
      <p className="text-dim" style={{ fontSize: 12, marginBottom: 16 }}>
        {`Enter your BIP39 recovery phrase (12, 15, 18, 21 or 24 words) to restore an existing ${chainDisplayName(network)} wallet.`}
      </p>

      <TextField
        label="Wallet name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Imported"
        testId="live-wallet-name"
        autoComplete="off"
      />

      <ChainPicker
        hidden={hiddenChains}
        evmChains={evmChains}
        value={network}
        onChange={setNetwork}
        testIdPrefix="live-import-chain"
        secretKind="phrase"
      />

      <div className="field" style={{ marginBottom: 13 }}>
        <label>Recovery phrase</label>
        <div className={`control${phraseError ? ' invalid' : ''}`} style={{ alignItems: 'flex-start', padding: '10px 12px' }}>
          <textarea
            rows={4}
            placeholder="word1 word2 word3 ..."
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            data-testid="live-import-input"
            aria-invalid={!!phraseError}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', resize: 'none', fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5 }}
          />
        </div>
        {phraseError && <span className="error" role="alert">{phraseError}</span>}
      </div>

      {/* BIP39 passphrase. Optional, and NOT the wallet password: it feeds the
          seed derivation, so leaving it empty when the phrase actually has one
          silently restores a DIFFERENT, empty wallet. That failure is why this
          field exists, so the copy names the consequence rather than the
          feature. Hidden behind a disclosure so it cannot be mistaken for a
          required step by the overwhelming majority who do not have one. */}
      <details style={{ marginBottom: 13 }}>
        <summary
          className="text-dim"
          style={{ fontSize: 11.5, cursor: 'pointer', padding: '2px 0' }}
          data-testid="live-import-passphrase-toggle"
        >
          My phrase has a passphrase (25th word)
        </summary>
        <div style={{ marginTop: 8 }}>
          <TextField
            label="BIP39 passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Leave empty if you did not set one"
            testId="live-import-passphrase"
            autoComplete="off"
          />
          <span className="text-faint" style={{ fontSize: 10.5, display: 'block', marginTop: -6 }}>
            Part of your recovery phrase, not a password for this app. A different
            passphrase restores a different wallet. It is stored encrypted with your
            wallet password so this wallet can unlock later.
          </span>
        </div>
      </details>

      <PasswordSection
        noPassword={noPassword}
        onToggleNoPassword={(v) => { setNoPassword(v); setAck(false); setLocalError(''); }}
        password={password}
        setPassword={setPassword}
        confirm={confirm}
        setConfirm={setConfirm}
        error={localError || undefined}
        passwordLabel={`New password (min ${MIN_PASSWORD_LENGTH} chars)`}
        ack={ack}
        onToggleAck={(v) => { setAck(v); setLocalError(''); }}
      />

      {noPassword && localError && (
        <span role="alert" style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 2 }}>
          {localError}
        </span>
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 20 }}>
        <Button type="button" variant="secondary" onClick={onBack}>Back</Button>
        <Button type="submit" block loading={loading} data-testid="live-import-submit">
          Import wallet
        </Button>
      </div>
    </form>
  );
}

function PkImportForm({ onBack }: { onBack(): void }) {
  const importPrivateKeyWallet = useLiveStore((s) => s.importPrivateKeyWallet);
  const addingWallet = useLiveStore((s) => s.addingWallet);
  const [name, setName] = useState('');
  const [network, setNetwork] = useState<ChainChoice>('mainnet');
  // Chains switched off in expert Settings are not offered for a new wallet.
  const hiddenChains = useLiveStore((s) => s.hiddenChains);
  // Empty in a build without the EVM engine, which drops the picker back to
  // its UTXO-only rows (see ChainPicker's own doc comment).
  const evmChains = useLiveStore((s) => s.evm.chains);
  const [pk, setPk] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [noPassword, setNoPassword] = useState(false);
  const [ack, setAck] = useState(false);
  const [localError, setLocalError] = useState('');
  const [loading, setLoading] = useState(false);

  // Recomputed as the user types or switches chain, so the warning is on screen
  // BEFORE they submit rather than arriving as a surprise at the last click.
  const notice = useMemo(() => pkChainNotice(pk, network), [pk, network]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    if (!pk.trim()) {
      setLocalError('Enter a private key (WIF or hex).');
      return;
    }
    // Checked before the password fields: this is about the key they pasted, and
    // nagging about password length first would bury it.
    if (notice.error) {
      setLocalError(notice.error);
      return;
    }
    if (!noPassword) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirm) {
        setLocalError('Passwords do not match.');
        return;
      }
    } else if (!ack) {
      setLocalError(PASSWORDLESS_ACK_REQUIRED);
      return;
    }
    setLoading(true);
    try {
      await importPrivateKeyWallet(pk.trim(), noPassword ? '' : password, name, network);
    } catch (err) {
      setLocalError(mapPkError(err instanceof Error ? err.message : 'Import failed'));
    }
    setLoading(false);
  };

  return (
    <form onSubmit={handleSubmit} data-testid="live-pk-import" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <h3 style={{ marginBottom: 4 }}>{addingWallet ? 'Import a Satori wallet' : 'Import private key'}</h3>
      <p className="text-dim" style={{ fontSize: 12, marginBottom: 12 }}>
        Paste a single private key (WIF or 64-char hex). This creates a{' '}
        <strong>single-address Satori-style wallet</strong>: one key, one address, no recovery phrase.
      </p>

      <div className="banner info" style={{ marginBottom: 14, alignItems: 'flex-start' }}>
        <Fingerprint size={14} />
        <span>Satori Network wallets are single private keys. You can reveal the key later, but there is no seed phrase to back up.</span>
      </div>

      <TextField
        label="Wallet name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Satori"
        testId="live-wallet-name"
        autoComplete="off"
      />

      <ChainPicker
        hidden={hiddenChains}
        evmChains={evmChains}
        value={network}
        onChange={setNetwork}
        testIdPrefix="live-pk-chain"
        secretKind="key"
      />

      <div className="field" style={{ marginBottom: 13 }}>
        <label>Private key (WIF or hex)</label>
        <div className="control" style={{ alignItems: 'flex-start', padding: '10px 12px' }}>
          <textarea
            rows={3}
            placeholder="Kx... / L... / 5... or 64-char hex"
            value={pk}
            onChange={(e) => setPk(e.target.value)}
            data-testid="live-pk-input"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', resize: 'none', fontSize: 12.5, fontFamily: 'var(--mono, monospace)', lineHeight: 1.5, wordBreak: 'break-all' }}
          />
        </div>
      </div>

      {/* Soft warning only: the import still goes through. See pkChainNotice()
          for why a cross-chain key warns instead of being blocked. */}
      {notice.warning && (
        <div
          className="banner warning"
          data-testid="live-pk-chain-warning"
          style={{ marginBottom: 14, alignItems: 'flex-start' }}
        >
          <AlertTriangle size={14} />
          <span>{notice.warning}</span>
        </div>
      )}

      {/* .banner.info, not .banner.warning: the byte matches the selected chain,
          this is not a mismatch. Purely informational, so it must look nothing
          like the warning above or the refusal below (KNOWN_LIMITATIONS.md #10). */}
      {notice.notice && (
        <div
          className="banner info"
          data-testid="live-pk-chain-notice"
          style={{ marginBottom: 14, alignItems: 'flex-start' }}
        >
          <Info size={14} />
          <span>{notice.notice}</span>
        </div>
      )}

      <PasswordSection
        noPassword={noPassword}
        onToggleNoPassword={(v) => { setNoPassword(v); setAck(false); setLocalError(''); }}
        password={password}
        setPassword={setPassword}
        confirm={confirm}
        setConfirm={setConfirm}
        error={undefined}
        passwordLabel={`New password (min ${MIN_PASSWORD_LENGTH} chars)`}
        ack={ack}
        onToggleAck={(v) => { setAck(v); setLocalError(''); }}
      />

      {localError && (
        <span
          role="alert"
          data-testid="live-pk-error"
          style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 2 }}
        >
          {localError}
        </span>
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 20 }}>
        <Button type="button" variant="secondary" onClick={onBack}>Back</Button>
        <Button type="submit" block loading={loading} data-testid="live-pk-submit">
          Import private key
        </Button>
      </div>
    </form>
  );
}

/** Small "Satori Network" identity strip. */
function BrandStrip() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginTop: 18,
        paddingTop: 14,
        borderTop: '1px solid var(--border)',
      }}
    >
      <BrandLogo slot="satori" size={22} alt="Satori Network" />
      <span style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.3 }}>
        <a
          href="https://satorinet.io"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--text)', fontWeight: 700, textDecoration: 'none' }}
          data-testid="brand-strip-link"
        >
          Satori Network
        </a>
      </span>
    </div>
  );
}

export function LiveOnboarding() {
  const pendingMnemonic = useLiveStore((s) => s.pendingMnemonic);
  // The arrival class is dropped the moment its animation finishes: keeping it
  // would keep the mark composited as a GPU texture rasterised at CSS size,
  // which Windows display scaling then stretches into standing pixelation
  // (owner, lock screen, 2026-08-25). Plain DOM after arrival = native-DPI crisp.
  const [markArrived, setMarkArrived] = useState(false);
  const markProps = {
    className: markArrived ? 'welcome-mark' : 'welcome-mark welcome-mark-arrive',
    // Any animationend from this element will do: the arrival (780ms) ends
    // before the glow swell (1100ms, and that one lives on ::before, which the
    // class removal does not touch), and jsdom's event carries no animationName.
    onAnimationEnd: () => setMarkArrived(true),
  };

  const pendingMnemonicHasPassphrase = useLiveStore((s) => s.pendingMnemonicHasPassphrase);
  const addingWallet = useLiveStore((s) => s.addingWallet);
  const cancelAddWallet = useLiveStore((s) => s.cancelAddWallet);
  const [step, setStep] = useState<Step>('choose');

  // If wallet was just created and mnemonic is pending, show it.
  if (pendingMnemonic) {
    return (
      <div className="app-frame screen-enter" data-testid="live-onboarding">
        <div className="app-content">
          <MnemonicView mnemonic={pendingMnemonic} hasPassphrase={pendingMnemonicHasPassphrase} />
        </div>
      </div>
    );
  }

  const welcome = step === 'choose';

  return (
    <div className="app-frame screen-enter" data-testid="live-onboarding">
      {/* The animated Satori network, behind everything. Welcome step only: the
          create/import forms are work surfaces and the mnemonic screen above is
          the most serious screen in the wallet. */}
      {welcome && <ConstellationField />}
      <div className={welcome ? 'app-content welcome-centered' : 'app-content'}>
        {welcome && (
          <div className="welcome-wow">
            {/* Each element carries its own delay, so the block arrives as one
                movement rather than as one flash. See .wow-in in global.css. */}
            <div {...markProps}>
              <BrandLogo slot="satori" size={88} alt="Satori Network" />
            </div>
            <h2 className="welcome-wow-title wow-in" style={{ animationDelay: '90ms' }}>
              {addingWallet ? 'Add another wallet' : 'Satori GO'}
            </h2>
            {/* The brand line, not a feature list: no chain is named here, and
                no chain ever should be (house rule: identity is multi-chain). */}
            <p className="welcome-wow-sub wow-in" style={{ animationDelay: '180ms' }}>
              {addingWallet
                ? 'Create a new wallet, restore a recovery phrase, or import a Satori private key.'
                : 'A non-custodial multi-chain wallet made by Satori Network. Your keys are created on this device and never leave it.'}
            </p>

            <div className="welcome-wow-actions">
              <Button
                block
                icon={<KeyRound size={15} />}
                onClick={() => setStep('create-form')}
                className="wow-in"
                style={{ animationDelay: '270ms' }}
              >
                Create new wallet
              </Button>
              <Button
                block
                variant="secondary"
                icon={<Download size={15} />}
                onClick={() => setStep('import-form')}
                className="wow-in"
                style={{ animationDelay: '350ms' }}
              >
                Import recovery phrase
              </Button>
              <Button
                block
                variant="secondary"
                icon={<Fingerprint size={15} />}
                onClick={() => setStep('pk-form')}
                data-testid="live-choose-pk"
                className="wow-in"
                style={{ animationDelay: '430ms' }}
              >
                Import private key (Satori)
              </Button>

              {addingWallet && (
                <Button
                  block
                  variant="ghost"
                  onClick={cancelAddWallet}
                  data-testid="live-add-wallet-cancel"
                  className="wow-in"
                  style={{ animationDelay: '510ms' }}
                >
                  Cancel
                </Button>
              )}
            </div>

            <BrandStrip />
          </div>
        )}

        {step === 'create-form' && <CreateForm onBack={() => setStep('choose')} />}
        {step === 'import-form' && <ImportForm onBack={() => setStep('choose')} />}
        {step === 'pk-form' && <PkImportForm onBack={() => setStep('choose')} />}
      </div>
    </div>
  );
}
