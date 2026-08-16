import { useMemo, useState } from 'react';
import { KeyRound, Download, AlertTriangle, Fingerprint } from 'lucide-react';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/TextField';
import { CopyButton } from '../../components/CopyButton';
import { BrandLogo } from '../../components/BrandLogo';
import { PasswordStrengthBar } from '../../components/PasswordStrengthBar';
import { useLiveStore, chainDisplayName } from '../../store/liveStore';
import { MIN_PASSWORD_LENGTH } from '../../services/constants';
import { networkFor, type EvrmoreNetwork } from '../../services/chain/chainParams';
import { classifyPrivateKeyOrigin } from '../../services/chain/keys';
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

/** "Litecoin", "Litecoin or Bitcoin Gold S", "A, B or C" — names from the chain
 *  params, never hardcoded. */
function joinChainNames(nets: readonly EvrmoreNetwork[]): string {
  const names = nets.map((n) => n.displayName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * What (if anything) to tell the user about the WIF version byte of the key they
 * pasted, given the chain they selected. Returns a hard `error` that blocks the
 * import, a soft `warning` that does not, or neither.
 *
 * REJECT vs WARN, and why the line is drawn here:
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
 *   - A byte matching the SELECTED chain says nothing worth saying, so nothing
 *     is said. 128 is Evrmore, Ravencoin AND Bitcoin, so "the prefix matches"
 *     would read as confirmation the wallet has not earned. The same collision
 *     is why the warning copy admits what it cannot distinguish instead of
 *     presenting itself as a chain check.
 *
 *   - A raw 64-character hex key carries no version byte at all and is always
 *     accepted in silence. There is nothing to compare.
 */
function pkChainNotice(
  input: string,
  network: ChainChoice,
): { error?: string; warning?: string } {
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

function CreateForm({ onBack }: { onBack(): void }) {
  const createWallet = useLiveStore((s) => s.createWallet);
  const addingWallet = useLiveStore((s) => s.addingWallet);
  const error = useLiveStore((s) => s.error);
  const [name, setName] = useState('');
  const [network, setNetwork] = useState<ChainChoice>('mainnet');
  // Chains switched off in expert Settings are not offered for a new wallet.
  const hiddenChains = useLiveStore((s) => s.hiddenChains);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [noPassword, setNoPassword] = useState(false);
  const [ack, setAck] = useState(false);
  const [localError, setLocalError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
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
    await createWallet(noPassword ? '' : password, name, network);
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

      <ChainPicker hidden={hiddenChains} value={network} onChange={setNetwork} testIdPrefix="live-create-chain" secretKind="phrase" />

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

      <div style={{ display: 'flex', gap: 9, marginTop: 20 }}>
        <Button type="button" variant="secondary" onClick={onBack}>Back</Button>
        <Button type="submit" block loading={loading} data-testid="live-create-submit">
          Create wallet
        </Button>
      </div>
    </form>
  );
}

function MnemonicView({ mnemonic }: { mnemonic: string }) {
  const clearPendingMnemonic = useLiveStore((s) => s.clearPendingMnemonic);
  const words = mnemonic.trim().split(/\s+/);
  const [saved, setSaved] = useState(false);

  return (
    <div data-testid="live-onboarding">
      <h3 style={{ marginBottom: 6 }}>Your recovery phrase</h3>
      <div
        className="banner danger"
        style={{ marginBottom: 14, alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}
      >
        <strong>Write this down. It is the ONLY backup.</strong>
        <span style={{ fontWeight: 400 }}>It will not be shown again. Anyone with this phrase controls your funds.</span>
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
            <span>{word}</span>
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
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>I have written down my recovery phrase and stored it safely.</span>
      </div>

      <Button block disabled={!saved} onClick={clearPendingMnemonic} icon={<Download size={15} />}>
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

      <ChainPicker hidden={hiddenChains} value={network} onChange={setNetwork} testIdPrefix="live-import-chain" secretKind="phrase" />

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

      <ChainPicker hidden={hiddenChains} value={network} onChange={setNetwork} testIdPrefix="live-pk-chain" secretKind="key" />

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
  const addingWallet = useLiveStore((s) => s.addingWallet);
  const cancelAddWallet = useLiveStore((s) => s.cancelAddWallet);
  const [step, setStep] = useState<Step>('choose');

  // If wallet was just created and mnemonic is pending, show it.
  if (pendingMnemonic) {
    return (
      <div className="app-frame screen-enter" data-testid="live-onboarding">
        <div className="app-content">
          <MnemonicView mnemonic={pendingMnemonic} />
        </div>
      </div>
    );
  }

  return (
    <div className="app-frame screen-enter" data-testid="live-onboarding">
      <div className="app-content">
        {step === 'choose' && (
          <div>
            <div style={{ textAlign: 'center', padding: '18px 0 22px' }}>
              {/* Same brand block as the lock screen (logo + wordmark + tagline). */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, marginBottom: 12 }}>
                <BrandLogo slot="satori" size={88} alt="Satori Network" />
                <span className="brand-title" style={{ fontSize: 19, marginTop: 10 }}>Satori GO</span>
                <span className="text-faint" style={{ fontSize: 10.5 }}>
                  Built for the Satori Network
                </span>
              </div>
              <h2 style={{ fontSize: 18, marginBottom: 6 }}>
                {addingWallet ? 'Add another wallet' : 'Your Satori GO Wallet'}
              </h2>
              <p className="text-dim" style={{ fontSize: 12.5 }}>
                Create a new wallet, restore a recovery phrase, or import a Satori private key.
              </p>
            </div>

            <Button
              block
              icon={<KeyRound size={15} />}
              onClick={() => setStep('create-form')}
              style={{ marginBottom: 10 }}
            >
              Create new wallet
            </Button>
            <Button
              block
              variant="secondary"
              icon={<Download size={15} />}
              onClick={() => setStep('import-form')}
              style={{ marginBottom: 10 }}
            >
              Import recovery phrase
            </Button>
            <Button
              block
              variant="secondary"
              icon={<Fingerprint size={15} />}
              onClick={() => setStep('pk-form')}
              data-testid="live-choose-pk"
            >
              Import private key (Satori)
            </Button>

            {addingWallet && (
              <Button
                block
                variant="ghost"
                onClick={cancelAddWallet}
                data-testid="live-add-wallet-cancel"
                style={{ marginTop: 10 }}
              >
                Cancel
              </Button>
            )}

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
