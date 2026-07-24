// Wallet settings. A clean root list of
// section rows (icon + title + chevron) that each open a focused sub-screen with
// a back header. Sections: Appearance, Wallets, Addresses, Security, Network &
// Explorer, Transactions (CSV export), Address Book, About (version, disclaimer,
// reset). All pre-existing testids keep working inside their sub-screens.

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  BookUser,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Globe,
  Info,
  KeyRound,
  Link2,
  List,
  Monitor,
  Moon,
  Palette,
  Pencil,
  Plus,
  Shield,
  Sun,
  Trash2,
  Unplug,
  Wallet,
} from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { PasswordStrengthBar } from '../../components/PasswordStrengthBar';
import { Toggle } from '../../components/Toggle';
import { Segmented } from '../../components/Segmented';
import { Modal, ConfirmModal } from '../../components/Modal';
import { CopyButton } from '../../components/CopyButton';
import { BrandLogo } from '../../components/BrandLogo';
import { EmptyState } from '../../components/EmptyState';
import { AccentSwatches } from '../settings/AppearanceSettings';
import { useSettingsStore } from '../../store/settingsStore';
import { useLiveStore, activeChainId } from '../../store/liveStore';
import { networkFor } from '../../services/chain/chainParams';
import { MIN_PASSWORD_LENGTH, getAppVersion } from '../../services/constants';
import type { ThemeMode } from '../../services/settings';
import type { LiveTransaction } from '../../services/chain/electrumProvider';
import { LiveNav } from './LiveNav';

interface LiveSettingsProps {
  onBack(): void;
  onOpenAddressBook(): void;
}

type RevealKind = 'seed' | 'key';

/** The focused sub-screens reachable from the settings root list. */
type SettingsSection =
  | 'appearance'
  | 'wallets'
  | 'addresses'
  | 'security'
  | 'network'
  | 'sites'
  | 'transactions'
  | 'about';

const SECTION_TITLES: Record<SettingsSection, string> = {
  appearance: 'Appearance',
  wallets: 'Wallets',
  addresses: 'Addresses',
  security: 'Security',
  network: 'Network & Explorer',
  sites: 'Connected sites',
  transactions: 'Transactions',
  about: 'About',
};

/** Auto-lock idle-timeout options (minutes). 0 = never. */
const AUTO_LOCK_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 0, label: 'Never' },
];

/** CSV column order for the transaction export. */
const CSV_HEADER = [
  'date',
  'direction',
  'asset',
  'amount',
  'fee_evr',
  'status',
  'block_height',
  'txid',
  'counterparty',
];

/** RFC-4180 field escaping: wrap in quotes and double embedded quotes when the
 *  field contains a comma, quote, or newline. */
function csvEscape(field: string): string {
  // SECURITY: neutralize spreadsheet formula injection. A server-controlled field
  // (asset name / counterparty from the Electrum verbose tx) that begins with
  // = + - @ or a control char would be executed as a formula by Excel/LibreOffice
  // on open. Prefix such fields with a single quote so they're treated as text.
  let value = field;
  if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Build a CSV document (header + one row per tx) from the live transactions. */
function buildTransactionsCsv(txs: LiveTransaction[]): string {
  const rows = txs.map((t) => [
    new Date(t.timestamp).toISOString(),
    t.direction,
    t.asset,
    String(t.amount),
    String(t.feeEvr),
    t.status,
    t.blockHeight != null ? String(t.blockHeight) : '',
    t.txid,
    t.counterparty,
  ]);
  return [CSV_HEADER, ...rows].map((cols) => cols.map(csvEscape).join(',')).join('\r\n');
}

/** Trigger a browser download of the transactions as a CSV file. No-op outside a
 *  DOM (jsdom / non-browser) and best-effort if object URLs are unavailable. */
function downloadTransactionsCsv(txs: LiveTransaction[]): void {
  if (typeof document === 'undefined') return; // guard for jsdom / non-DOM env
  const csv = buildTransactionsCsv(txs);
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'evrmore-transactions.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // ignore — download unavailable (object URLs not supported here)
  }
}

/** Short type label for a wallet-kind badge. */
function kindLabel(kind: 'seed' | 'pk'): string {
  return kind === 'pk' ? 'Satori (key)' : 'Seed';
}

/** Shared screen chrome: back header + scrollable content (local sub-screen
 *  chrome, since the wallet surface has no uiStore navigation stack). */
function Shell({
  title,
  onBack,
  testId,
  children,
  modals,
}: {
  title: string;
  onBack(): void;
  testId?: string;
  children: ReactNode;
  modals?: ReactNode;
}) {
  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>{title}</h2>
        <span />
      </div>
      <div className="app-content" data-testid={testId}>
        {children}
      </div>
      <LiveNav />
      {modals}
    </div>
  );
}

export function LiveSettings({ onBack, onOpenAddressBook }: LiveSettingsProps) {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);

  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const setRequirePasswordToSend = useLiveStore((s) => s.setRequirePasswordToSend);
  const autoLockMinutes = useLiveStore((s) => s.autoLockMinutes);
  const setAutoLockMinutes = useLiveStore((s) => s.setAutoLockMinutes);
  const notifyDeposits = useLiveStore((s) => s.notifyDeposits);
  const setNotifyDeposits = useLiveStore((s) => s.setNotifyDeposits);
  const explorerUrlTemplate = useLiveStore((s) => s.explorerUrlTemplate);
  const setExplorerUrlTemplate = useLiveStore((s) => s.setExplorerUrlTemplate);
  const electrumServers = useLiveStore((s) => s.electrumServers);
  const addElectrumServer = useLiveStore((s) => s.addElectrumServer);
  const removeElectrumServer = useLiveStore((s) => s.removeElectrumServer);
  const resetElectrumServers = useLiveStore((s) => s.resetElectrumServers);
  const serverStatus = useLiveStore((s) => s.serverStatus);
  const checkServers = useLiveStore((s) => s.checkServers);
  const txs = useLiveStore((s) => s.txs);
  const changePassword = useLiveStore((s) => s.changePassword);
  const network = useLiveStore((s) => s.network);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const loadWallets = useLiveStore((s) => s.loadWallets);
  const renameWallet = useLiveStore((s) => s.renameWallet);
  const removeWallet = useLiveStore((s) => s.removeWallet);
  const revealMnemonic = useLiveStore((s) => s.revealMnemonic);
  const revealPrivateKey = useLiveStore((s) => s.revealPrivateKey);
  const addresses = useLiveStore((s) => s.addresses);
  const loadAddresses = useLiveStore((s) => s.loadAddresses);
  const addReceiveAddress = useLiveStore((s) => s.addReceiveAddress);
  const connectedSites = useLiveStore((s) => s.connectedSites);
  const loadConnectedSites = useLiveStore((s) => s.loadConnectedSites);
  const disconnectSite = useLiveStore((s) => s.disconnectSite);
  const disconnectAllSites = useLiveStore((s) => s.disconnectAllSites);

  const [section, setSection] = useState<SettingsSection | null>(null);

  // Keep the wallet + address + connected-site lists fresh whenever Settings
  // mounts (the root row shows a live site count).
  useEffect(() => {
    void loadWallets();
    void loadAddresses();
    void loadConnectedSites();
  }, [loadWallets, loadAddresses, loadConnectedSites]);

  // Re-read the approved-origin list every time the sub-screen opens — the
  // background worker may have added an origin since Settings mounted.
  useEffect(() => {
    if (section === 'sites') void loadConnectedSites();
  }, [section, loadConnectedSites]);

  // Ping every configured server whenever the Network screen opens (and when the
  // list changes) so the online/offline dots reflect current reachability.
  useEffect(() => {
    if (section === 'network') void checkServers();
  }, [section, electrumServers.length, checkServers]);

  // The ACTIVE wallet decides which secrets are revealable and whether a password
  // is needed: a 'pk' (Satori) wallet has no recovery phrase; a passwordless
  // wallet reveals directly.
  const activeWallet = wallets.find((w) => w.id === activeWalletId) ?? null;
  const isPkWallet = activeWallet?.kind === 'pk';
  const isPasswordless = activeWallet?.passwordless ?? false;

  // Change-password local form state.
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  // Opting to DROP the password (go passwordless) requires ticking the same
  // explicit risk acknowledgement as onboarding — see PASSWORDLESS_ACK_REQUIRED.
  const [makePasswordless, setMakePasswordless] = useState(false);
  const [passwordlessAck, setPasswordlessAck] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState(false);


  // --- Addresses (derive new receive address) local state ---
  const [addrError, setAddrError] = useState('');
  const [addrBusy, setAddrBusy] = useState(false);
  const handleNewAddress = async () => {
    if (addrBusy) return;
    setAddrError('');
    setAddrBusy(true);
    const res = await addReceiveAddress();
    setAddrBusy(false);
    if (!res.ok) setAddrError(res.error ?? 'Could not add a new address.');
  };

  // --- Network (Electrum server pool) local state ---
  const [serverInput, setServerInput] = useState('');
  const [serverError, setServerError] = useState('');
  const handleAddServer = () => {
    const res = addElectrumServer(serverInput);
    if (res.ok) {
      setServerInput('');
      setServerError('');
    } else {
      setServerError(res.error);
    }
  };

  // --- Wallets (rename / remove) local state ---
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const removeTarget = wallets.find((w) => w.id === removeId) ?? null;
  const removingLast = wallets.length <= 1;

  const startRename = (id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  };
  const commitRename = async () => {
    if (renamingId) await renameWallet(renamingId, renameValue);
    setRenamingId(null);
    setRenameValue('');
  };
  const confirmRemove = async () => {
    const id = removeId;
    setRemoveId(null);
    if (id) await removeWallet(id);
  };

  // --- Reveal secret (recovery phrase / private key) local state ---
  // The plaintext secret lives ONLY here and is cleared on close; never logged
  // or persisted.
  const [revealKind, setRevealKind] = useState<RevealKind | null>(null);
  const [revealPw, setRevealPw] = useState('');
  const [revealSecret, setRevealSecret] = useState<string | null>(null);
  const [revealError, setRevealError] = useState('');
  const [revealBusy, setRevealBusy] = useState(false);

  const openReveal = async (kind: RevealKind) => {
    setRevealKind(kind);
    setRevealPw('');
    setRevealSecret(null);
    setRevealError('');
    setRevealBusy(false);
    // A passwordless wallet has no password to ask for — reveal directly with ''.
    if (isPasswordless) {
      setRevealBusy(true);
      const secret = kind === 'seed' ? await revealMnemonic('') : await revealPrivateKey('');
      setRevealBusy(false);
      if (secret == null) setRevealError('Could not reveal this secret.');
      else setRevealSecret(secret);
    }
  };
  const closeReveal = () => {
    // Clear the plaintext secret from memory as the panel closes.
    setRevealKind(null);
    setRevealPw('');
    setRevealSecret(null);
    setRevealError('');
    setRevealBusy(false);
  };
  const submitReveal = async (e: FormEvent) => {
    e.preventDefault();
    if (!revealKind || revealBusy) return;
    setRevealError('');
    setRevealBusy(true);
    const secret =
      revealKind === 'seed' ? await revealMnemonic(revealPw) : await revealPrivateKey(revealPw);
    setRevealBusy(false);
    if (secret == null) {
      setRevealError('Incorrect password.');
      return;
    }
    setRevealSecret(secret);
    setRevealPw('');
  };

  const handleChangePassword = async () => {
    setPwError('');
    setPwSuccess(false);
    // A passwordless wallet has no current password to confirm.
    if (!isPasswordless && !oldPw) {
      setPwError('Enter your current password.');
      return;
    }
    if (makePasswordless) {
      // Switching TO passwordless: require the explicit risk acknowledgement,
      // same as onboarding. Never proceed with an empty new password otherwise.
      if (!passwordlessAck) {
        setPwError('Check the box to confirm you understand the risk.');
        return;
      }
    } else {
      if (newPw.length < MIN_PASSWORD_LENGTH) {
        setPwError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (newPw !== confirmPw) {
        setPwError('New passwords do not match.');
        return;
      }
    }
    setPwBusy(true);
    const ok = await changePassword(isPasswordless ? '' : oldPw, makePasswordless ? '' : newPw);
    setPwBusy(false);
    if (!ok) {
      setPwError('Current password is incorrect.');
      return;
    }
    setOldPw('');
    setNewPw('');
    setConfirmPw('');
    setMakePasswordless(false);
    setPasswordlessAck(false);
    setPwSuccess(true);
  };

  // Modals live outside the section switch so they survive navigation.
  const modals = (
    <>

      {removeTarget && (
        <ConfirmModal
          title={`Remove "${removeTarget.name}"?`}
          description={
            removingLast
              ? 'This is your LAST wallet. Removing it deletes its encrypted vault and returns you to onboarding. You will need its recovery phrase to restore access. This cannot be undone.'
              : 'This removes the wallet and its encrypted vault from this device. You will need its recovery phrase to restore access. This cannot be undone.'
          }
          confirmLabel="Remove"
          cancelLabel="Cancel"
          danger
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoveId(null)}
        />
      )}

      {revealKind && (
        <Modal
          title={revealKind === 'seed' ? 'Show recovery phrase' : 'Show private key'}
          onClose={closeReveal}
          testId="live-reveal-modal"
        >
          <div className="banner danger" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
            <AlertTriangle size={14} />
            <span>Never share this. Anyone with it controls your funds.</span>
          </div>

          {revealSecret != null ? (
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
                {revealSecret}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <CopyButton value={revealSecret} label="Copy secret" size={14} secret />
                <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 6 }}>Copy</span>
              </div>
              <Button block variant="secondary" onClick={closeReveal} data-testid="live-reveal-hide">
                Hide
              </Button>
            </div>
          ) : isPasswordless ? (
            <div>
              <p className="text-dim" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
                {revealBusy
                  ? 'Revealing…'
                  : 'This wallet has no password, so the secret is revealed directly.'}
              </p>
              {revealError && (
                <span
                  role="alert"
                  data-testid="live-reveal-error"
                  style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginBottom: 8 }}
                >
                  {revealError}
                </span>
              )}
              <Button block variant="secondary" onClick={closeReveal}>
                Close
              </Button>
            </div>
          ) : (
            <form onSubmit={submitReveal}>
              <p className="text-dim" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
                Enter your wallet password to reveal your{' '}
                {revealKind === 'seed' ? 'recovery phrase' : 'private key'}.
              </p>
              <PasswordField
                label="Wallet password"
                showLabel="Show password"
                hideLabel="Hide password"
                value={revealPw}
                onChange={(e) => {
                  setRevealPw(e.target.value);
                  setRevealError('');
                }}
                placeholder="Enter password"
                autoFocus
                testId="live-reveal-password"
              />
              {revealError && (
                <span
                  role="alert"
                  data-testid="live-reveal-error"
                  style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 2 }}
                >
                  {revealError}
                </span>
              )}
              <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
                <Button type="button" variant="secondary" onClick={closeReveal}>
                  Cancel
                </Button>
                <Button type="submit" block loading={revealBusy} data-testid="live-reveal-submit">
                  Reveal
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </>
  );

  // --- Root list: section rows -----------------------------------------------
  if (section === null) {
    const sectionRow = (
      testId: string,
      icon: ReactNode,
      title: string,
      desc: string,
      onClick: () => void,
      iconClass?: string,
    ) => (
      <button type="button" className="list-row" onClick={onClick} data-testid={testId}>
        <span className={iconClass ? `row-icon ${iconClass}` : 'row-icon'}>{icon}</span>
        <span className="row-main">
          <span className="row-title">{title}</span>
          <span className="row-desc">{desc}</span>
        </span>
        <ChevronRight size={16} className="text-faint" />
      </button>
    );

    return (
      <Shell title="Settings" onBack={onBack} testId="live-settings" modals={modals}>
        {sectionRow(
          'live-settings-row-appearance',
          <Palette size={17} />,
          'Appearance',
          'Theme and accent color',
          () => setSection('appearance'),
        )}
        {sectionRow(
          'live-settings-row-wallets',
          <Wallet size={17} />,
          'Wallets',
          `${wallets.length} wallet${wallets.length === 1 ? '' : 's'} · rename or remove`,
          () => setSection('wallets'),
        )}
        {sectionRow(
          'live-settings-row-addresses',
          <List size={17} />,
          'Addresses',
          'Receive addresses of this wallet',
          () => setSection('addresses'),
        )}
        {sectionRow(
          'live-settings-row-security',
          <Shield size={17} />,
          'Security',
          'Password, auto-lock, reveal secrets',
          () => setSection('security'),
          'success',
        )}
        {sectionRow(
          'live-settings-row-network',
          <Globe size={17} />,
          'Network & Explorer',
          'Block explorer link and server status',
          () => setSection('network'),
        )}
        {sectionRow(
          'live-settings-row-sites',
          <Link2 size={17} />,
          'Connected sites',
          connectedSites.length === 0
            ? 'No dApps connected via window.evrmore'
            : `${connectedSites.length} site${connectedSites.length === 1 ? '' : 's'} can read your address`,
          () => setSection('sites'),
        )}
        {sectionRow(
          'live-settings-row-transactions',
          <Download size={17} />,
          'Transactions',
          'Export your history as CSV',
          () => setSection('transactions'),
        )}
        {sectionRow(
          'live-address-book-btn',
          <BookUser size={17} />,
          'Address Book',
          'Saved recipients',
          onOpenAddressBook,
        )}
        {sectionRow(
          'live-settings-row-about',
          <Info size={17} />,
          'About',
          'Version, disclaimer, reset',
          () => setSection('about'),
          'neutral',
        )}
      </Shell>
    );
  }

  // --- Focused sub-screens -----------------------------------------------------
  return (
    <Shell
      title={SECTION_TITLES[section]}
      onBack={() => setSection(null)}
      testId={`live-settings-view-${section}`}
      modals={modals}
    >
      {section === 'appearance' && (
        <>
          <div className="section-label" style={{ marginTop: 0 }}>Theme</div>
          <Segmented<ThemeMode>
            options={[
              { value: 'light', label: 'Light', icon: <Sun size={14} /> },
              { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
              { value: 'system', label: 'System', icon: <Monitor size={14} /> },
            ]}
            value={settings.theme}
            onChange={(theme) => void updateSettings({ theme })}
            testIdPrefix="live-theme"
          />
          <div className="section-label">Accent</div>
          <div style={{ padding: '2px 4px' }}>
            <AccentSwatches />
          </div>
        </>
      )}

      {section === 'wallets' && (
        <>
          <div className="stack" data-testid="live-wallets-list">
            {wallets.map((w) => (
              <div
                key={w.id}
                className="list-row"
                data-testid={`live-settings-wallet-${w.id}`}
                style={{ alignItems: 'center', gap: 8 }}
              >
                {renamingId === w.id ? (
                  <>
                    <span className="row-main" style={{ flex: 1 }}>
                      <TextField
                        label=""
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        testId={`live-wallet-rename-input-${w.id}`}
                        autoComplete="off"
                        autoFocus
                      />
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => void commitRename()}
                      aria-label="Save name"
                      data-testid={`live-wallet-rename-save-${w.id}`}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => { setRenamingId(null); setRenameValue(''); }}
                      aria-label="Cancel rename"
                    >
                      <ChevronLeft size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="row-main" style={{ flex: 1, minWidth: 0 }}>
                      <span
                        className="row-title"
                        style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {w.name}
                        </span>
                        {w.id === activeWalletId && (
                          <span className="chip success" style={{ fontSize: 9, padding: '1px 5px' }}>active</span>
                        )}
                        <span className="chip neutral" style={{ fontSize: 9, padding: '1px 5px' }}>
                          {kindLabel(w.kind)}
                        </span>
                        {w.passwordless && (
                          <span className="chip warning" style={{ fontSize: 9, padding: '1px 5px' }}>No password</span>
                        )}
                      </span>
                      <span className="row-desc">{w.network}</span>
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => startRename(w.id, w.name)}
                      aria-label={`Rename ${w.name}`}
                      data-testid={`live-wallet-rename-${w.id}`}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm danger"
                      onClick={() => setRemoveId(w.id)}
                      aria-label={`Remove ${w.name}`}
                      data-testid={`live-wallet-remove-${w.id}`}
                      style={{ padding: '4px 8px', flexShrink: 0 }}
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          <p className="text-faint" style={{ fontSize: 11, margin: '8px 2px 4px', lineHeight: 1.5 }}>
            Removing a wallet deletes its encrypted vault from this device. Without its recovery
            phrase or private key you will lose access.
          </p>
        </>
      )}

      {section === 'addresses' && (
        <>
          {isPkWallet ? (
            <p className="text-faint" style={{ fontSize: 11, margin: '0 2px 4px', lineHeight: 1.5 }}>
              This is a Satori (single-key) wallet. It has one fixed receive address.
            </p>
          ) : (
            <>
              <div className="stack" data-testid="live-addresses-list">
                {addresses.map((a) => (
                  <div
                    key={a.index}
                    className="list-row"
                    data-testid={`live-address-item-${a.index}`}
                    style={{ alignItems: 'center', gap: 8 }}
                  >
                    <span className="row-main" style={{ flex: 1, minWidth: 0 }}>
                      <span className="row-title">Address #{a.index}</span>
                      <span className="row-desc mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>
                        {a.address}
                      </span>
                    </span>
                    <CopyButton value={a.address} label={`Copy address #${a.index}`} size={13} />
                  </div>
                ))}
              </div>
              <Button
                variant="secondary"
                size="sm"
                block
                icon={<Plus size={14} />}
                loading={addrBusy}
                onClick={() => void handleNewAddress()}
                data-testid="live-settings-new-address"
                style={{ marginTop: 8 }}
              >
                New address
              </Button>
              {addrError && (
                <span
                  role="alert"
                  data-testid="live-settings-address-error"
                  style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 6 }}
                >
                  {addrError}
                </span>
              )}
              <p className="text-faint" style={{ fontSize: 11, margin: '8px 2px 4px', lineHeight: 1.5 }}>
                Balances and activity are aggregated across all derived addresses.
              </p>
            </>
          )}
        </>
      )}

      {section === 'security' && (
        <>
          {/* Reveal secrets. A seed wallet exposes BOTH its recovery phrase and its
              private key; a Satori (pk) wallet has no seed, so only the key shows.
              A passwordless wallet reveals directly (no password prompt). */}
          <div className="section-label" style={{ marginTop: 0 }}>Backup</div>
          <div style={{ display: 'flex', gap: 9, marginBottom: 10 }}>
            {!isPkWallet && (
              <Button
                variant="secondary"
                size="sm"
                block
                icon={<Eye size={14} />}
                onClick={() => void openReveal('seed')}
                data-testid="live-reveal-seed"
              >
                Show recovery phrase
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              block
              icon={<KeyRound size={14} />}
              onClick={() => void openReveal('key')}
              data-testid="live-reveal-key"
            >
              Show private key
            </Button>
          </div>
          {isPkWallet && (
            <p className="text-faint" style={{ fontSize: 11, margin: '0 2px 10px', lineHeight: 1.5 }}>
              This is a Satori (single-key) wallet. It has a private key but no recovery phrase.
            </p>
          )}

          <div className="section-label">Locking</div>
          <div className="list-row">
            <span className="row-main">
              <span className="row-title">Require password to send</span>
              <span className="row-desc">Ask for your wallet password before every broadcast.</span>
            </span>
            <Toggle
              checked={requirePasswordToSend}
              onChange={setRequirePasswordToSend}
              label="Require password to send"
              testId="live-set-require-pw"
            />
          </div>

          <div className="list-row">
            <span className="row-main">
              <span className="row-title">Auto-lock</span>
              <span className="row-desc">Lock the wallet automatically after a period of inactivity.</span>
            </span>
            <select
              data-testid="live-autolock-select"
              className="live-picker"
              value={String(autoLockMinutes)}
              onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
              aria-label="Auto-lock after inactivity"
            >
              {AUTO_LOCK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="section-label">Notifications</div>
          <div className="list-row">
            <span className="row-main">
              <span className="row-title">Notify on incoming funds</span>
              <span className="row-desc">Show a desktop notification when a coin or asset arrives in any wallet.</span>
            </span>
            <Toggle
              checked={notifyDeposits}
              onChange={setNotifyDeposits}
              label="Notify on incoming funds"
              testId="live-set-notify-deposits"
            />
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <div className="section-label" style={{ marginTop: 0 }}>
              {isPasswordless ? 'Set a password' : 'Change password'}
            </div>
            {isPasswordless ? (
              <p className="text-dim" style={{ fontSize: 11.5, margin: '0 0 8px', lineHeight: 1.5 }}>
                This wallet has no password. Set one to protect it on this device.
              </p>
            ) : (
              <PasswordField
                label="Current password"
                showLabel="Show password"
                hideLabel="Hide password"
                value={oldPw}
                onChange={(e) => {
                  setOldPw(e.target.value);
                  setPwError('');
                  setPwSuccess(false);
                }}
                testId="live-change-pw-old"
              />
            )}

            {!isPasswordless && (
              <label
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  cursor: 'pointer',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-md)',
                  padding: '10px 12px',
                  margin: '10px 0 12px',
                }}
              >
                <input
                  type="checkbox"
                  checked={makePasswordless}
                  onChange={(e) => {
                    setMakePasswordless(e.target.checked);
                    setPasswordlessAck(false);
                    setPwError('');
                    setPwSuccess(false);
                  }}
                  data-testid="live-change-pw-make-passwordless"
                  style={{ marginTop: 2, flexShrink: 0, accentColor: 'var(--danger)' }}
                />
                <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                  <strong>Remove password (less secure)</strong>
                  <span className="text-dim" style={{ display: 'block', fontWeight: 400, marginTop: 1 }}>
                    No password to unlock or send. Anyone using this browser could drain it.
                  </span>
                </span>
              </label>
            )}

            {makePasswordless ? (
              <>
                <div
                  className="banner danger"
                  data-testid="live-change-pw-passwordless-warning"
                  style={{ marginBottom: 10, alignItems: 'flex-start' }}
                >
                  <AlertTriangle size={14} />
                  <span>No password: anyone with access to this computer or your Chrome profile can take these funds.</span>
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
                  onClick={() => {
                    setPasswordlessAck((v) => !v);
                    setPwError('');
                  }}
                  role="checkbox"
                  aria-checked={passwordlessAck}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      setPasswordlessAck((v) => !v);
                      setPwError('');
                    }
                  }}
                  data-testid="passwordless-ack"
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 5,
                      border: `2px solid ${passwordlessAck ? 'var(--success)' : 'var(--border-strong)'}`,
                      background: passwordlessAck ? 'var(--success-bg)' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      transition: 'all 0.15s',
                    }}
                  >
                    {passwordlessAck && (
                      <span style={{ color: 'var(--success)', fontSize: 11, fontWeight: 700 }}>✓</span>
                    )}
                  </div>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>I understand the risk</span>
                </div>
              </>
            ) : (
              <>
                <PasswordField
                  label="New password"
                  showLabel="Show password"
                  hideLabel="Hide password"
                  value={newPw}
                  onChange={(e) => {
                    setNewPw(e.target.value);
                    setPwError('');
                    setPwSuccess(false);
                  }}
                  testId="live-change-pw-new"
                />
                <PasswordStrengthBar password={newPw} />
                <PasswordField
                  label="Confirm new password"
                  showLabel="Show password"
                  hideLabel="Hide password"
                  value={confirmPw}
                  onChange={(e) => {
                    setConfirmPw(e.target.value);
                    setPwError('');
                    setPwSuccess(false);
                  }}
                  testId="live-change-pw-confirm"
                />
              </>
            )}
            {pwError && (
              <span
                role="alert"
                data-testid="live-change-pw-error"
                style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 2 }}
              >
                {pwError}
              </span>
            )}
            {pwSuccess && (
              <span
                data-testid="live-change-pw-success"
                style={{ fontSize: 11.5, color: 'var(--success)', display: 'block', marginTop: 2 }}
              >
                Password changed successfully.
              </span>
            )}
            <Button
              block
              loading={pwBusy}
              onClick={handleChangePassword}
              data-testid="live-change-pw-submit"
              style={{ marginTop: 12 }}
            >
              {isPasswordless ? 'Set password' : makePasswordless ? 'Remove password' : 'Update password'}
            </Button>
          </div>
        </>
      )}

      {section === 'network' && (
        <>
          <p
            className="text-faint"
            data-testid="live-network-chain-caption"
            style={{ fontSize: 11, margin: '0 2px 10px', lineHeight: 1.5 }}
          >
            Servers for: {networkFor(activeChainId()).displayName}
          </p>
          <TextField
            label="Block explorer URL"
            placeholder="https://example.com/tx/{txid}"
            value={explorerUrlTemplate}
            onChange={(e) => setExplorerUrlTemplate(e.target.value)}
            testId="live-explorer-input"
            hint="Use {txid} where the transaction id should go."
          />
          <div className="card solid" style={{ marginTop: 8 }}>
            <div className="summary-table">
              <div className="sum-row">
                <span className="sum-key">Electrum server</span>
                <span className="sum-val mono" style={{ fontSize: 11 }}>
                  {network?.serverVersion ?? 'n/a'}
                </span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Block height</span>
                <span className="sum-val">
                  {network ? network.blockHeight.toLocaleString('en-US') : 'n/a'}
                </span>
              </div>
            </div>
          </div>

          {/* User-managed Electrum server pool: add/remove/reset the wss servers
              the wallet connects to. Changes reconnect the client on the next read. */}
          <div className="section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Electrum servers</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void checkServers()}
              data-testid="live-server-check"
              style={{ padding: '2px 8px', fontSize: 11 }}
            >
              Check
            </button>
          </div>
          <div className="stack" data-testid="live-servers-list">
            {electrumServers.map((url, i) => {
              const st = serverStatus[url];
              const dotColor =
                st?.status === 'online'
                  ? 'var(--success)'
                  : st?.status === 'offline'
                  ? 'var(--danger)'
                  : 'var(--text-faint)';
              const statusText =
                st?.status === 'online'
                  ? `Online${st.height ? ` · block ${st.height.toLocaleString('en-US')}` : ''}${st.latencyMs != null ? ` · ${st.latencyMs}ms` : ''}`
                  : st?.status === 'offline'
                  ? 'Offline / unreachable'
                  : st?.status === 'checking'
                  ? 'Checking…'
                  : 'Not checked';
              return (
              <div
                key={url}
                className="list-row"
                data-testid={`live-server-${i}`}
                style={{ alignItems: 'center', gap: 8 }}
              >
                <span
                  data-testid={`live-server-status-${i}`}
                  data-state={st?.status ?? 'unknown'}
                  title={statusText}
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: dotColor,
                    boxShadow: st?.status === 'online' ? `0 0 5px ${dotColor}` : undefined,
                    flexShrink: 0,
                    animation: st?.status === 'checking' ? 'pulse 1.1s ease-in-out infinite' : undefined,
                  }}
                />
                <span className="row-main" style={{ flex: 1, minWidth: 0 }}>
                  <span
                    className="row-title mono"
                    style={{ fontSize: 11.5, wordBreak: 'break-all' }}
                  >
                    {url}
                  </span>
                  <span className="row-desc" style={{ fontSize: 10 }}>{statusText}</span>
                </span>
                {electrumServers.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm danger"
                    onClick={() => removeElectrumServer(url)}
                    aria-label={`Remove ${url}`}
                    data-testid={`live-server-remove-${i}`}
                    style={{ padding: '4px 8px', flexShrink: 0 }}
                  >
                    <Trash2 size={13} /> Remove
                  </button>
                )}
              </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TextField
                label="Add server"
                placeholder="wss://host:50004"
                value={serverInput}
                onChange={(e) => {
                  setServerInput(e.target.value);
                  setServerError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddServer();
                  }
                }}
                testId="live-server-input"
                autoComplete="off"
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={14} />}
              onClick={handleAddServer}
              data-testid="live-server-add"
              style={{ flexShrink: 0, marginBottom: 2 }}
            >
              Add
            </Button>
          </div>
          {serverError && (
            <span
              role="alert"
              data-testid="live-server-error"
              style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}
            >
              {serverError}
            </span>
          )}

          <Button
            variant="secondary"
            size="sm"
            block
            onClick={() => resetElectrumServers()}
            data-testid="live-server-reset"
            style={{ marginTop: 8 }}
          >
            Reset to defaults
          </Button>

          <p className="text-faint" style={{ fontSize: 11, margin: '8px 2px 4px', lineHeight: 1.5 }}>
            The wallet tries servers top-to-bottom and uses the first that connects. A browser can
            only use a server with a VALID TLS certificate. A self-signed certificate won't work.
          </p>
        </>
      )}

      {section === 'sites' && (
        <div data-testid="live-connected-sites">
          {connectedSites.length === 0 ? (
            <div data-testid="live-sites-empty">
              <EmptyState
                icon={<Link2 size={22} />}
                title="No connected sites"
                description="Sites you approve via window.evrmore will appear here."
              />
            </div>
          ) : (
            <>
              <div className="stack">
                {connectedSites.map((site, i) => {
                  // Resolve the bound wallet's NAME; fall back to a shortened id if
                  // the wallet was deleted (should be pruned on read, but be safe).
                  const bound = wallets.find((w) => w.id === site.walletId);
                  const walletLabel =
                    bound?.name ?? `wallet ${site.walletId.slice(0, 6)}…`;
                  return (
                    <div
                      key={`${site.origin}|${site.walletId}`}
                      className="list-row"
                      data-testid={`live-site-${i}`}
                      style={{ alignItems: 'center', gap: 8 }}
                    >
                      <span className="row-icon neutral">
                        <Globe size={16} />
                      </span>
                      <span className="row-main" style={{ flex: 1, minWidth: 0 }}>
                        <span className="row-title mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                          {site.origin}
                        </span>
                        <span className="row-desc" data-testid={`live-site-wallet-${i}`}>
                          {walletLabel}
                        </span>
                      </span>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Unplug size={13} />}
                        onClick={() => void disconnectSite(site.origin, site.walletId)}
                        data-testid={`live-site-disconnect-${i}`}
                        aria-label={`Disconnect ${site.origin} from ${walletLabel}`}
                      >
                        Disconnect
                      </Button>
                    </div>
                  );
                })}
              </div>
              {connectedSites.length > 1 && (
                <Button
                  variant="secondary"
                  size="sm"
                  block
                  icon={<Unplug size={14} />}
                  onClick={() => void disconnectAllSites()}
                  data-testid="live-sites-disconnect-all"
                  style={{ marginTop: 8 }}
                >
                  Disconnect all
                </Button>
              )}
            </>
          )}
          <p className="text-faint" style={{ fontSize: 11, margin: '8px 2px 4px', lineHeight: 1.5 }}>
            Disconnecting a site revokes its access immediately. It can no longer read your
            address or balances until you approve it again from the site.
          </p>
        </div>
      )}

      {section === 'transactions' && (
        <>
          <Button
            variant="secondary"
            size="sm"
            block
            icon={<Download size={14} />}
            onClick={() => downloadTransactionsCsv(txs)}
            data-testid="live-export-csv"
          >
            Export transactions (CSV)
          </Button>
          <p className="text-faint" style={{ fontSize: 11, margin: '8px 2px 4px', lineHeight: 1.5 }}>
            {txs.length > 0
              ? `Download all ${txs.length} transaction${txs.length === 1 ? '' : 's'} as a CSV file.`
              : 'No transactions yet. Exports a header-only CSV file.'}
          </p>
        </>
      )}

      {section === 'about' && (
        <>
          <div className="card solid" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <BrandLogo slot="satori" size={40} alt="Satori Network" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Satori GO</div>
              <div className="text-dim" style={{ fontSize: 11 }}>
                Satori Network
              </div>
            </div>
            <span className="chip neutral">v{getAppVersion()}</span>
          </div>

          <p
            className="text-faint"
            data-testid="live-about-intro"
            style={{ fontSize: 11, margin: '0 2px 10px', lineHeight: 1.6 }}
          >
            Satori GO is a non-custodial wallet made by Satori Network, the decentralized AI network
            whose neurons predict the future and earn SATORIEVR for it. Your keys are encrypted and
            never leave this device.
          </p>

          <p
            className="text-faint"
            data-testid="live-about-multichain"
            style={{ fontSize: 11, margin: '0 2px 10px', lineHeight: 1.6 }}
          >
            This is a multi-chain wallet, not built around any single network. It is designed to
            carry several chains, including the smaller ones that rarely get a wallet of their own.
          </p>

          <p
            className="text-faint"
            data-testid="live-about-testfirst"
            style={{ fontSize: 11, margin: '0 2px 14px', lineHeight: 1.6 }}
          >
            As with any wallet, send a small test transaction before a large one.
          </p>

          <p className="text-faint" style={{ fontSize: 11, margin: '8px 2px 4px', lineHeight: 1.5 }}>
            To remove a single wallet, open the Wallets section. Each wallet has its own Remove
            action (guarded by a confirmation). Make sure you have its recovery phrase or private
            key first.
          </p>

          {/* Website + author credit. lucide-react has no X-brand mark, so the
              current X (Twitter) logo is inlined as a monochrome currentColor
              SVG. The satorinet.io link uses the same visual style. */}
          <div
            style={{
              marginTop: 16,
              paddingTop: 12,
              borderTop: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <a
              href="https://satorinet.io"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="live-about-website"
              className="text-dim"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 11.5,
                textDecoration: 'none',
              }}
            >
              <Globe size={14} />
              <span>satorinet.io</span>
            </a>
            <a
              href="https://x.com/WilQSL"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="live-about-x"
              className="text-dim"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 11.5,
                textDecoration: 'none',
              }}
            >
              <span>Built by WilQSL</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </div>
        </>
      )}
    </Shell>
  );
}
