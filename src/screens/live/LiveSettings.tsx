// Wallet settings. A clean root list of
// section rows (icon + title + chevron) that each open a focused sub-screen with
// a back header. Sections: Appearance, Wallets, Addresses, Security, Network &
// Explorer, Transactions (CSV export), Address Book, About (version, disclaimer,
// reset). All pre-existing testids keep working inside their sub-screens.

import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Bell,
  BookUser,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Globe,
  Info,
  KeyRound,
  Layers,
  LifeBuoy,
  Link2,
  List,
  Monitor,
  Moon,
  Palette,
  Pencil,
  Plus,
  Search,
  Shield,
  Sun,
  Trash2,
  Unplug,
  Wallet,
  Activity,
} from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { PasswordStrengthBar } from '../../components/PasswordStrengthBar';
import { Toggle } from '../../components/Toggle';
import { isSidePanelWindow, useSidePanelPreference } from '../../services/sidePanel';
import { Segmented } from '../../components/Segmented';
import { ConfirmModal } from '../../components/Modal';
import { CopyButton } from '../../components/CopyButton';
import { SyncStatusPill } from '../../components/SyncStatusPill';
import { BrandLogo } from '../../components/BrandLogo';
import { AccountAvatar } from '../../components/AccountAvatar';
import { EmptyState } from '../../components/EmptyState';
import { AccentSwatches } from '../settings/AppearanceSettings';
import { RecoverySettings } from './LiveRecovery';
import { useSettingsStore } from '../../store/settingsStore';
import {
  useLiveStore,
  activeChainId,
  activeChainTarget,
  activeFamily,
  chainDisplayName,
  chainHideBlockedReason,
  walletsOnChain,
} from '../../store/liveStore';
import type { SettingsMode } from '../../store/liveStore';
import {
  readStorageStats,
  formatBytes,
  type StorageStats,
} from '../../services/storageStats';
import { lastCacheWriteError, lastHistoryFetchError } from '../../services/chain/txCache';
import { networkFor } from '../../services/chain/chainParams';
import { isGatewayElectrumUrl } from '../../services/chain/network';
import { CHAIN_OPTIONS } from './ChainPicker';
import {
  groupWallets,
  accountNumberOf,
  isEvmSeedAccount,
  siblingAccounts,
  shortAccountAddress,
  memberLabel,
} from './walletGroups';
import { TokenIcon } from '../../components/BrandLogo';
import { MIN_PASSWORD_LENGTH, getAppVersion } from '../../services/constants';
import type { ThemeMode } from '../../services/settings';
import type { LiveTransaction } from '../../services/chain/electrumProvider';
import { LiveNav } from './LiveNav';
import { RevealSecretModal, type RevealKind } from './RevealSecretModal';

interface LiveSettingsProps {
  onBack(): void;
  onOpenAddressBook(): void;
}

/** The focused sub-screens reachable from the settings root list. */
type SettingsSection =
  | 'appearance'
  | 'wallets'
  | 'addresses'
  | 'security'
  | 'recovery'
  | 'notifications'
  | 'network'
  | 'sites'
  | 'transactions'
  | 'networks'
  | 'diagnostics'
  | 'about';

const SECTION_TITLES: Record<SettingsSection, string> = {
  appearance: 'Appearance',
  wallets: 'Wallets',
  addresses: 'Addresses',
  security: 'Security',
  // Its own screen since 2026-08-26. It used to be the last block of a Security
  // screen ~600 lines long, which is the worst possible place for the thing a
  // user goes looking for when something has gone wrong.
  recovery: 'Recovery',
  notifications: 'Notifications',
  // "Network & Explorer" and "Visible networks" both led with the same word for
  // unrelated jobs: one is which servers this wallet talks to, the other is
  // which chains appear in the switcher.
  network: 'Servers & explorer',
  sites: 'Connected sites',
  // "Transactions" promised a screen about transactions; it is an export button.
  transactions: 'Export history',
  networks: 'Networks',
  diagnostics: 'Diagnostics',
  about: 'About',
};

/** Every row of the root list. 'addressBook' is not a section: it opens a
 *  screen of its own that predates this list, and it is here because a user
 *  looking for saved recipients looks under Wallet, not under "other". */
type RootRowId = SettingsSection | 'addressBook';

/** One row of the settings root list. */
interface RootRow {
  testId: string;
  icon: ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  /** Tints the icon chip. Used sparingly, to mark Security and About. */
  iconClass?: string;
}

/** The three groups the root list is shown under, in order. A flat list of ten
 *  rows made the user read every one of them to find anything; the groups say
 *  where to start looking. */
const SECTION_GROUPS: ReadonlyArray<{ title: string; sections: readonly RootRowId[] }> = [
  { title: 'Wallet', sections: ['wallets', 'addresses', 'addressBook', 'transactions'] },
  { title: 'Security', sections: ['security', 'recovery'] },
  {
    title: 'App',
    sections: ['appearance', 'notifications', 'networks', 'network', 'sites', 'diagnostics', 'about'],
  },
];

/** Sections hidden in BASIC mode. Chosen by "can a wrong move here cost the user
 *  something, or is it meaningless without context": the server pool, the raw
 *  address list, dApp grants, the CSV export and the diagnostics page. Wallets,
 *  Security, Appearance and About stay visible always, because a user must
 *  always be able to reach their password, their secrets and the reset. */
const EXPERT_ONLY: ReadonlySet<SettingsSection> = new Set<SettingsSection>([
  'addresses',
  'network',
  'sites',
  'transactions',
  'networks',
  'diagnostics',
]);
// NOT expert-only, and deliberately: 'recovery' is what a user reaches for when
// they have lost their password, which is not a moment to discover the control
// was hidden behind a detail level; 'notifications' is one everyday toggle.

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
  showSync = true,
}: {
  title: string;
  onBack(): void;
  testId?: string;
  children: ReactNode;
  modals?: ReactNode;
  /** Show the dot-only connection indicator in the sub-header's right-hand
   *  slot. Defaults on for the focused sub-screens (Appearance, Wallets,
   *  Security, ... — KNOWN_LIMITATIONS item 33, they had no connection
   *  indicator at all). The settings ROOT screen passes false: it already
   *  shows the full labelled pill under "Detail level" below, and a second
   *  indicator up here would be redundant chrome. */
  showSync?: boolean;
}) {
  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>{title}</h2>
        {showSync ? (
          // The labelled pill was tried here first and clipped: at 400 px the
          // back button and the centred title squeeze this slot to about
          // 40 px, which cut "Synced" down to "Sy". The dot-only variant
          // fits: it drops the visible label but keeps the state reachable
          // via title/aria-label.
          <SyncStatusPill compact />
        ) : (
          <span />
        )}
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

  // Params of the chain in use, for the diagnostics readout.
  const activeNet = networkFor(activeChainId());
  const hiddenChains = useLiveStore((s) => s.hiddenChains);
  const setChainHidden = useLiveStore((s) => s.setChainHidden);
  const evmChainsForSettings = useLiveStore((s) => s.evm.chains);
  const activeEvmChainKey = useLiveStore((s) => s.evm.activeChainKey);
  // The EVM chain in use (null on a UTXO chain): the Network section shows its
  // gateway endpoints instead of the Electrum pool.
  const activeEvmChain =
    activeFamily() === 'evm' ? (evmChainsForSettings.find((c) => c.key === activeEvmChainKey) ?? null) : null;
  const evmGateway = (() => {
    try {
      return typeof __EVM_GATEWAY_URL__ === 'string' ? __EVM_GATEWAY_URL__.trim().replace(/\/+$/, '') : '';
    } catch {
      return '';
    }
  })();
  const evmEndpoints: Array<{ kind: string; url: string; label: string; required: boolean }> = activeEvmChain
    ? evmGateway
      ? [
          { kind: 'rpc', url: `${evmGateway}/evm/${activeEvmChain.key}/rpc`, label: 'JSON-RPC, balances, sending (Satori GO gateway)', required: true },
          ...(activeEvmChain.indexer || activeEvmChain.alchemy
            ? [{ kind: 'history', url: activeEvmChain.alchemy ? `${evmGateway}/evm/${activeEvmChain.key}/rpc` : `${evmGateway}/evm/${activeEvmChain.key}/indexer`, label: 'Transaction history (Satori GO gateway)', required: true }]
            : []),
        ]
      : [
          { kind: 'rpc', url: `public JSON-RPC of ${activeEvmChain.displayName}`, label: 'Development build: the public endpoints from the registry, no gateway', required: true },
          ...(activeEvmChain.indexer ? [{ kind: 'history', url: activeEvmChain.indexer.baseUrl, label: 'Transaction history (public explorer API)', required: false }] : []),
        ]
    : [];
  const settingsMode = useLiveStore((s) => s.settingsMode);
  // Window mode (services/sidePanel.ts): the side panel is the default on
  // Chrome and Edge, so this row is the way BACK to the toolbar popup and must
  // stay visible in basic mode too. The change applies on the NEXT open.
  const sidePanel = useSidePanelPreference();
  const [sidePanelNote, setSidePanelNote] = useState<string | null>(null);
  const onSidePanelToggle = async (next: boolean) => {
    const applied = await sidePanel.setEnabled(next);
    if (!applied) {
      setSidePanelNote('This browser could not apply the change. The choice is saved and the popup stays.');
    } else if (next) {
      setSidePanelNote(
        isSidePanelWindow()
          ? 'On. The wallet keeps opening in the side panel.'
          : 'On. Close this popup; the next click on the toolbar icon opens the wallet in the side panel.',
      );
    } else {
      setSidePanelNote(
        isSidePanelWindow()
          ? 'Off. Close this panel; the next click on the toolbar icon opens the wallet in the popup.'
          : 'Off. The next click on the toolbar icon opens the popup again.',
      );
    }
  };
  const setSettingsMode = useLiveStore((s) => s.setSettingsMode);
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
  const appPasswordSet = useLiveStore((s) => s.appPasswordSet);
  // Shown on the Recovery row so the state is readable without opening it: the
  // whole point of giving recovery its own row is that a user can see at a
  // glance whether they have a way back in.
  const recoveryCodeSet = useLiveStore((s) => s.recoveryCodeSet);
  const setAppPassword = useLiveStore((s) => s.setAppPassword);
  const changeAppPassword = useLiveStore((s) => s.changeAppPassword);
  const setNoSendPassword = useLiveStore((s) => s.setNoSendPassword);
  const network = useLiveStore((s) => s.network);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const loadWallets = useLiveStore((s) => s.loadWallets);
  const renameWallet = useLiveStore((s) => s.renameWallet);
  const removeWallet = useLiveStore((s) => s.removeWallet);
  const revealMnemonic = useLiveStore((s) => s.revealMnemonic);
  const revealPrivateKey = useLiveStore((s) => s.revealPrivateKey);
  const addresses = useLiveStore((s) => s.addresses);
  const addressScan = useLiveStore((s) => s.addressScan);
  const scanForUsedAddresses = useLiveStore((s) => s.scanForUsedAddresses);
  const loadAddresses = useLiveStore((s) => s.loadAddresses);
  const addReceiveAddress = useLiveStore((s) => s.addReceiveAddress);
  const connectedSites = useLiveStore((s) => s.connectedSites);
  const loadConnectedSites = useLiveStore((s) => s.loadConnectedSites);
  const disconnectSite = useLiveStore((s) => s.disconnectSite);
  const disconnectAllSites = useLiveStore((s) => s.disconnectAllSites);

  const [section, setSection] = useState<SettingsSection | null>(null);

  // Dropping to basic while an expert-only sub-screen is open would strand the
  // user on a page they can no longer navigate back to from the list.
  useEffect(() => {
    if (settingsMode === 'basic' && section !== null && EXPERT_ONLY.has(section)) {
      setSection(null);
    }
  }, [settingsMode, section]);

  // Storage diagnostics, read on entering the section (not on mount: it walks
  // every stored value, which is wasted work for anyone not looking at it).
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [storageError, setStorageError] = useState('');
  const [cacheWriteError, setCacheWriteError] = useState('');
  const [historyFetchError, setHistoryFetchError] = useState('');
  useEffect(() => {
    if (section !== 'diagnostics') return;
    let cancelled = false;
    setStorageError('');
    // A failed cache write is the symptom of a full quota, and it used to be
    // swallowed entirely. Reading it here is the only place it surfaces.
    const writeErr = lastCacheWriteError();
    setCacheWriteError(writeErr ? writeErr.message : '');
    // A server REFUSING an address (typically "history too large") is not a
    // connection problem, so it never shows as offline. This is where a
    // technical user goes to find out why an Activity list stays empty.
    const histErr = lastHistoryFetchError();
    setHistoryFetchError(histErr ? `${histErr.address}: ${histErr.message}` : '');
    readStorageStats()
      .then((stats) => {
        if (!cancelled) setStorageStats(stats);
      })
      .catch((err) => {
        if (!cancelled) setStorageError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [section]);

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
  // A wallet already moved to the app password has no password of its own left
  // to change, so the per-wallet card below is replaced by a line saying which
  // password does open it (the app-password design notes §5).
  const isAppProtected = activeWallet?.appProtected ?? false;
  // §6: the "do not ask when sending" half a passwordless wallet keeps when it
  // migrates. Shown and switchable on the card above, because it is what decides
  // whether a send needs proof.
  const noSendPassword = activeWallet?.noSendPassword ?? false;
  /** Is the ACTIVE wallet outside the app-wide "require password to send" rule?
   *  Both shapes count: a v1 wallet with no password at all, and one that kept
   *  the convenience when it moved to the app password. Mirrors LiveSend's own
   *  `isPasswordless` so the two screens cannot disagree about who is exempt. */
  const sendPasswordExempt = isPasswordless || noSendPassword;

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

  // --- App password (Settings > Security) local form state ---
  const [appCurrentPw, setAppCurrentPw] = useState('');
  const [appNewPw, setAppNewPw] = useState('');
  const [appConfirmPw, setAppConfirmPw] = useState('');
  const [appPwBusy, setAppPwBusy] = useState(false);
  const [appPwError, setAppPwError] = useState('');
  const [appPwSuccess, setAppPwSuccess] = useState('');
  const [appFormOpen, setAppFormOpen] = useState(false);
  const resetAppForm = () => {
    setAppCurrentPw('');
    setAppNewPw('');
    setAppConfirmPw('');
    setAppPwError('');
  };
  const onAppFieldChange = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setAppPwError('');
    setAppPwSuccess('');
  };

  // --- "Ask for the password when sending" (§6) local form state ---
  //
  // Turning that check OFF is the one switch on this screen that REMOVES a
  // control rather than adding one: afterwards a send from this wallet needs
  // nothing typed. The v1 route to exactly that state (changePassword to an
  // empty password) has always cost the current password AND an explicit risk
  // acknowledgement, so this one costs the same two things, in the same words.
  // Turning it back ON is free, and must be: asking for a password to make the
  // wallet safer is how a safety switch stops being used.
  const [sendPwFormOpen, setSendPwFormOpen] = useState(false);
  const [sendPwValue, setSendPwValue] = useState('');
  const [sendPwAck, setSendPwAck] = useState(false);
  const [sendPwError, setSendPwError] = useState('');
  const [sendPwBusy, setSendPwBusy] = useState(false);
  const closeSendPwForm = () => {
    setSendPwFormOpen(false);
    setSendPwValue('');
    setSendPwAck(false);
    setSendPwError('');
  };
  const handleStopAskingWhenSending = async () => {
    setSendPwError('');
    if (!sendPwValue) {
      setSendPwError('Enter your current app password.');
      return;
    }
    if (!sendPwAck) {
      setSendPwError('Check the box to confirm you understand the risk.');
      return;
    }
    setSendPwBusy(true);
    const res = await setNoSendPassword(true, sendPwValue);
    setSendPwBusy(false);
    if (!res.ok) {
      // A reason only ever arrives for a failure that is NOT the password, and
      // then it is the only true thing to show.
      setSendPwError(res.error ?? 'Incorrect app password.');
      return;
    }
    closeSendPwForm();
  };

  /** Set the app password for the first time, or change an existing one. Both
   *  go through the same validation, because both are the same promise to the
   *  user: this password, and nothing else, opens the wallets it protects. */
  const handleAppPassword = async () => {
    setAppPwError('');
    setAppPwSuccess('');
    if (appPasswordSet && !appCurrentPw) {
      setAppPwError('Enter your current app password.');
      return;
    }
    if (appNewPw.length < MIN_PASSWORD_LENGTH) {
      setAppPwError(`App password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (appNewPw !== appConfirmPw) {
      setAppPwError('App passwords do not match.');
      return;
    }
    setAppPwBusy(true);
    const result = appPasswordSet
      ? await changeAppPassword(appCurrentPw, appNewPw)
      : await setAppPassword(appNewPw);
    setAppPwBusy(false);
    if (!result.ok) {
      setAppPwError(result.error ?? 'Could not save the app password.');
      return;
    }
    resetAppForm();
    setAppFormOpen(false);
    // On a CHANGE the store has already locked the wallet (the design drops any
    // cached master key), so this success line is only ever read after a SET.
    setAppPwSuccess('App password set. Each wallet moves over the next time you open it with its current password.');
  };


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
  // Other accounts of the same seed as the removal target: while they exist the
  // seed does not leave this device, so the confirmation must not claim it does.
  const removeSiblings = siblingAccounts(wallets, removeTarget);
  // The wallets list uses the SAME grouping as the Home switcher, so a seed and
  // its accounts read identically wherever they are listed.
  const walletNodes = groupWallets(wallets);

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

  /** One row of the wallets list. Shared by standalone wallets and by the
   *  accounts nested under a seed, so both keep the same rename/remove
   *  affordances and the same testids (which are keyed by wallet id, not by
   *  position, so grouping moves nothing). An account's second line is its own
   *  address: that is what distinguishes "Account 1" from "Account 2". */
  const renderWalletRow = (w: (typeof wallets)[number], nested: boolean, label: string = w.name) => (
    <div
      key={w.id}
      className="list-row"
      data-testid={`live-settings-wallet-${w.id}`}
      style={{ alignItems: 'center', gap: 8, ...(nested ? { paddingLeft: 14 } : null) }}
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
          {/* The account's identicon, the same mark it carries in the Home
              switcher and on the lock screen — so a row here is recognisable as
              the same wallet without reading the address under it. */}
          <AccountAvatar address={w.address} seed={w.id} size={16} />
          <span className="row-main" style={{ flex: 1, minWidth: 0 }}>
            <span
              className="row-title"
              style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
              </span>
              {w.id === activeWalletId && (
                <span className="chip success" style={{ fontSize: 9, padding: '1px 5px' }}>active</span>
              )}
              {/* The seed is named once, by the group heading — repeating "Seed"
                  on every account of it says nothing new. */}
              {!nested && (
                <span className="chip neutral" style={{ fontSize: 9, padding: '1px 5px' }}>
                  {kindLabel(w.kind)}
                </span>
              )}
              {w.passwordless && (
                <span className="chip warning" style={{ fontSize: 9, padding: '1px 5px' }}>No password</span>
              )}
              {/* Which password opens it, once there is more than one answer.
                  After a migration some wallets open with the app password and
                  some still ask for their own; that state has to be readable
                  here, not discovered at a lock screen. */}
              {appPasswordSet && (
                <span
                  className="chip neutral"
                  style={{ fontSize: 9, padding: '1px 5px' }}
                  data-testid={`live-settings-wallet-pw-${w.id}`}
                >
                  {w.appProtected ? 'App password' : 'Own password'}
                </span>
              )}
            </span>
            {/* Chain name from the chain params — never the raw internal chain
                id ("mainnet"). An account of a seed names its ADDRESS instead:
                its siblings share the chain, so the chain does not tell them
                apart and the address does. */}
            <span className={nested && w.address ? 'row-desc mono' : 'row-desc'}>
              {nested && w.address ? shortAccountAddress(w.address) : chainDisplayName(w.network)}
            </span>
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
  );

  // --- Reveal secret (recovery phrase / private key) ---
  // The screen itself is RevealSecretModal, shared with the forced app-password
  // setup so there is exactly one screen in this wallet that shows a secret.
  // Only "which secret, and does it need a password" is decided here.
  const [revealKind, setRevealKind] = useState<RevealKind | null>(null);
  const openReveal = (kind: RevealKind) => setRevealKind(kind);

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
    const res = await changePassword(isPasswordless ? '' : oldPw, makePasswordless ? '' : newPw);
    setPwBusy(false);
    if (!res.ok) {
      // Same rule as the app-password form: only blame the password when the
      // password is what failed.
      setPwError(res.error ?? 'Current password is incorrect.');
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
            /* Removing ONE account of a seed that has others is not removing the
               seed: the words stay on this device in its siblings and bring this
               address back, so the backup warning would be a false alarm here. */
            removeSiblings.length > 0
              ? `Removes ${removeTarget.name} only. The seed stays in its other ${
                  removeSiblings.length === 1 ? 'account' : 'accounts'
                } and the same recovery phrase restores this account again.`
              : removingLast
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
        <RevealSecretModal
          kind={revealKind}
          noPassword={isPasswordless}
          reveal={(pw) => (revealKind === 'seed' ? revealMnemonic(pw) : revealPrivateKey(pw))}
          onClose={() => setRevealKind(null)}
          notes={
            <>
              {/* A seed holds one key PER ACCOUNT, so "the private key" is
                  ambiguous until it names which account it belongs to. */}
              {revealKind === 'key' && activeWallet?.hdIndex != null && (
                <p
                  className="text-dim"
                  style={{ fontSize: 12, margin: '0 0 10px', lineHeight: 1.5 }}
                  data-testid="live-reveal-key-account"
                >
                  Private key of Account {accountNumberOf(activeWallet)}.
                </p>
              )}
              {revealKind === 'seed' && isEvmSeedAccount(activeWallet) && (
                <p className="text-dim" style={{ fontSize: 12, margin: '0 0 10px', lineHeight: 1.5 }}>
                  These words restore every account of this wallet (Account 1, 2, ...).
                </p>
              )}
            </>
          }
        />
      )}
    </>
  );

  // --- Root list: section rows -----------------------------------------------
  if (section === null) {
    const sectionRow = (row: RootRow) => (
      <button
        type="button"
        className="list-row"
        onClick={row.onClick}
        data-testid={row.testId}
        key={row.testId}
      >
        <span className={row.iconClass ? `row-icon ${row.iconClass}` : 'row-icon'}>{row.icon}</span>
        <span className="row-main">
          <span className="row-title">{row.title}</span>
          <span className="row-desc">{row.desc}</span>
        </span>
        <ChevronRight size={16} className="text-faint" />
      </button>
    );

    // EVERY ROW OF THE ROOT LIST, as data. It used to be ten hand-written JSX
    // blocks in one flat column, which is why nothing could be grouped without
    // rewriting all of them, and why two rows could drift into near-identical
    // names without anyone seeing the pair.
    const rootRows: Record<RootRowId, RootRow> = {
      wallets: {
        testId: 'live-settings-row-wallets',
        icon: <Wallet size={17} />,
        title: 'Wallets',
        desc: `${wallets.length} wallet${wallets.length === 1 ? '' : 's'} · rename or remove`,
        onClick: () => setSection('wallets'),
      },
      addresses: {
        testId: 'live-settings-row-addresses',
        icon: <List size={17} />,
        title: 'Addresses',
        desc: 'Receive addresses of this wallet',
        onClick: () => setSection('addresses'),
      },
      addressBook: {
        testId: 'live-address-book-btn',
        icon: <BookUser size={17} />,
        title: 'Address book',
        desc: 'Saved recipients',
        onClick: onOpenAddressBook,
      },
      transactions: {
        testId: 'live-settings-row-transactions',
        icon: <Download size={17} />,
        title: SECTION_TITLES.transactions,
        desc: 'Your transaction history as a CSV file',
        onClick: () => setSection('transactions'),
      },
      security: {
        testId: 'live-settings-row-security',
        icon: <Shield size={17} />,
        title: 'Security',
        desc: 'Password, auto-lock, recovery phrase',
        onClick: () => setSection('security'),
        iconClass: 'success',
      },
      recovery: {
        testId: 'live-settings-row-recovery',
        icon: <LifeBuoy size={17} />,
        title: 'Recovery',
        desc: recoveryCodeSet
          ? 'Recovery code is set · backup file'
          : 'If you forget your password',
        onClick: () => setSection('recovery'),
      },
      appearance: {
        testId: 'live-settings-row-appearance',
        icon: <Palette size={17} />,
        title: 'Appearance',
        desc: 'Theme and accent color',
        onClick: () => setSection('appearance'),
      },
      notifications: {
        testId: 'live-settings-row-notifications',
        icon: <Bell size={17} />,
        title: 'Notifications',
        desc: 'Alerts when funds arrive',
        onClick: () => setSection('notifications'),
      },
      networks: {
        testId: 'live-settings-row-networks',
        icon: <Layers size={17} />,
        title: SECTION_TITLES.networks,
        desc: 'Show or hide networks in the switcher',
        onClick: () => setSection('networks'),
      },
      network: {
        testId: 'live-settings-row-network',
        icon: <Globe size={17} />,
        title: SECTION_TITLES.network,
        desc: 'Block explorer link and server status',
        onClick: () => setSection('network'),
      },
      sites: {
        testId: 'live-settings-row-sites',
        icon: <Link2 size={17} />,
        title: 'Connected sites',
        desc:
          connectedSites.length === 0
            ? 'No dApps connected via window.evrmore'
            : `${connectedSites.length} site${connectedSites.length === 1 ? '' : 's'} can read your address`,
        onClick: () => setSection('sites'),
      },
      diagnostics: {
        testId: 'live-settings-row-diagnostics',
        icon: <Activity size={17} />,
        title: 'Diagnostics',
        desc: 'Storage use, cache and connection details',
        onClick: () => setSection('diagnostics'),
      },
      about: {
        testId: 'live-settings-row-about',
        icon: <Info size={17} />,
        title: 'About',
        desc: 'Version, disclaimer, reset',
        onClick: () => setSection('about'),
        iconClass: 'neutral',
      },
    };

    /** Basic mode simply does not render the expert rows (one list, not two
     *  divergent ones). The address book is never expert-only. */
    const visible = (id: RootRowId) =>
      id === 'addressBook' || settingsMode === 'expert' || !EXPERT_ONLY.has(id as SettingsSection);

    return (
      <Shell title="Settings" onBack={onBack} testId="live-settings" modals={modals} showSync={false}>
        {/* Mode switch first: it explains why the list below is short. */}
        <div className="field" style={{ marginBottom: 12 }}>
          {/* The connection pill rides on this label's row rather than a row of
              its own, which would cost ~30 px of a 620 px popup. Settings is no
              longer a screen where the wallet can silently go offline
              (KNOWN_LIMITATIONS item 33); same pill, same derivation as the
              Activity tab. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <label>Detail level</label>
            <SyncStatusPill />
          </div>
          <Segmented<SettingsMode>
            options={[
              { value: 'basic', label: 'Basic' },
              { value: 'expert', label: 'Expert' },
            ]}
            value={settingsMode}
            onChange={setSettingsMode}
            testIdPrefix="live-settings-mode"
          />
          <span className="text-faint" style={{ fontSize: 10, display: 'block', marginTop: 6 }}>
            {settingsMode === 'basic'
              ? 'Everyday settings only. Expert adds servers, addresses, connected sites, export and diagnostics.'
              : 'Everything, including settings that can break your connection if set wrong.'}
          </span>
        </div>
        {SECTION_GROUPS.map((group, groupIndex) => {
          const ids = group.sections.filter(visible);
          // Basic mode can empty a group entirely. A heading over nothing is
          // worse than no heading, so the group goes with its rows.
          if (ids.length === 0) return null;
          return (
            <div key={group.title} data-testid={`live-settings-group-${group.title.toLowerCase()}`}>
              <div className="section-label" style={groupIndex === 0 ? { marginTop: 0 } : undefined}>
                {group.title}
              </div>
              {ids.map((id) => sectionRow(rootRows[id]))}
            </div>
          );
        })}
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
          <div className="section-label">Window</div>
          <div className="list-row" data-testid="live-side-panel-row">
            <span className="row-main">
              <span className="row-title">Open as side panel</span>
              <span className="row-desc">
                The wallet docks in the browser side panel and stays open while you browse. This is how Chrome and
                Edge open it by default; turn it off to use the toolbar popup, which closes as soon as you click
                away. Firefox uses its own sidebar and starts with the popup. Takes effect the next time you open
                the wallet.
              </span>
              {!sidePanel.supported && (
                <span className="row-desc" data-testid="live-side-panel-unsupported" style={{ color: 'var(--warning)' }}>
                  Not available here: this browser has no side panel or sidebar API for extensions, so the wallet
                  opens in the toolbar popup. If the extension was just updated, reload it in the browser's
                  extensions page and try again.
                </span>
              )}
            </span>
            <Toggle
              checked={sidePanel.enabled}
              onChange={(v) => void onSidePanelToggle(v)}
              label="Open as side panel"
              testId="live-side-panel-toggle"
              disabled={!sidePanel.loaded || !sidePanel.supported}
            />
          </div>
          {sidePanelNote && (
            <div className="banner info" data-testid="live-side-panel-note" style={{ marginTop: 8 }}>
              {sidePanelNote}
            </div>
          )}
        </>
      )}

      {section === 'wallets' && (
        <>
          <div className="stack" data-testid="live-wallets-list">
            {walletNodes.map((node, ni) =>
              node.kind === 'single' ? (
                renderWalletRow(node.wallet, false)
              ) : (
                <div key={`group-${node.key}`}>
                  {/* One seed, its accounts under it (the EVM accounts design notes).
                      The heading names the seed; the rows below are its addresses. */}
                  <div
                    data-testid={`live-settings-group-${ni}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 2px 2px', minWidth: 0 }}
                  >
                    <TokenIcon assetId="EVM" size={14} />
                    <span
                      className="text-faint"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 10,
                        letterSpacing: 0.3,
                        textTransform: 'uppercase',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {node.title}
                    </span>
                    <span className="chip neutral" style={{ fontSize: 9, padding: '1px 5px', flexShrink: 0 }}>
                      Seed
                    </span>
                  </div>
                  {node.members.map((m) => renderWalletRow(m, true, memberLabel(m, node.title, node.members.length)))}
                </div>
              ),
            )}
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
              {/* Gap-limit scan (KNOWN_LIMITATIONS item 15). A seed used in another
                  wallet may hold coins on addresses this one never derived, which
                  is the usual reason an imported wallet looks emptier than it is.
                  Import runs this automatically; the button is for wallets that
                  predate the scan, and for a seed that got used elsewhere later. */}
              <Button
                variant="secondary"
                size="sm"
                block
                icon={<Search size={14} />}
                loading={addressScan.scanning}
                onClick={() => void scanForUsedAddresses()}
                data-testid="live-settings-scan-addresses"
                style={{ marginTop: 8 }}
              >
                {addressScan.scanning ? 'Scanning…' : 'Scan for used addresses'}
              </Button>
              <p
                className="text-faint"
                style={{ fontSize: 11, margin: '6px 2px 0', lineHeight: 1.5 }}
                data-testid="live-settings-scan-status"
              >
                {addressScan.scanning
                  ? `Checking address ${addressScan.scanned}. This looks ahead for addresses of this same recovery phrase that already hold coins.`
                  : addressScan.error
                  ? addressScan.error
                  : addressScan.result
                  ? [
                      addressScan.result.found > 0
                        ? `Found ${addressScan.result.found} more used ${addressScan.result.found === 1 ? 'address' : 'addresses'}. Their balances are included now.`
                        : 'No further used addresses found.',
                      // A run that hit the ceiling or lost reads proved a LOWER
                      // BOUND, so saying "none" flatly would overclaim.
                      addressScan.result.complete
                        ? ''
                        : addressScan.result.failedReads > 0
                        ? `${addressScan.result.failedReads} ${addressScan.result.failedReads === 1 ? 'address' : 'addresses'} could not be checked, so run this again when the connection is better.`
                        : 'The scan stopped at its limit, so there may be more.',
                    ]
                      .filter(Boolean)
                      .join(' ')
                  : 'Looks ahead for addresses of this recovery phrase that already hold coins. Runs by itself after an import.'}
              </p>
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
              A passwordless wallet reveals directly (no password prompt).

              NOT called "Backup" any more: since the backup FILE exists
              (the app-password design notes §13.7) one screen had two different
              things under that word, and the two recover different things. */}
          <div className="section-label" style={{ marginTop: 0 }}>Recovery phrase and private key</div>
          <div style={{ display: 'flex', gap: 9, marginBottom: 10 }}>
            {!isPkWallet && (
              <Button
                variant="secondary"
                size="sm"
                block
                icon={<Eye size={14} />}
                onClick={() => openReveal('seed')}
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
              onClick={() => openReveal('key')}
              data-testid="live-reveal-key"
            >
              Show private key
            </Button>
          </div>
          {/* One seed carries every account of this wallet, so the phrase behind
              "Show recovery phrase" is not the phrase of THIS account only. Say
              so where the button is, not only after the words are on screen. */}
          {isEvmSeedAccount(activeWallet) && (
            <p
              className="text-faint"
              style={{ fontSize: 11, margin: '0 2px 10px', lineHeight: 1.5 }}
              data-testid="live-reveal-seed-accounts-note"
            >
              These words restore every account of this wallet (Account 1, 2, ...).
            </p>
          )}
          {isPkWallet && (
            <p className="text-faint" style={{ fontSize: 11, margin: '0 2px 10px', lineHeight: 1.5 }}>
              This is a Satori (single-key) wallet. It has a private key but no recovery phrase.
            </p>
          )}

          <div className="section-label">Locking</div>
          {/* This is the app-wide default. A single wallet can be exempt from it
              (a wallet that opens with no password, or one that kept "do not ask
              when sending" when it moved to the app password), and the send path
              is `requirePasswordToSend && !exempt`. Two switches asking the same
              question in two places read as a duplicate and hide that the
              general one simply does not apply here (owner, 2026-08-26), so the
              exemption is stated on the row it overrides, next to the setting it
              overrides, rather than only in the wallet's own card. */}
          <div className="list-row">
            <span className="row-main">
              <span className="row-title">Require password to send</span>
              <span className="row-desc">
                {sendPasswordExempt
                  ? `On for your other wallets. ${activeWallet?.name ?? 'This wallet'} is set to send with nothing typed, so this does not apply to it.`
                  : 'Ask for your password before every broadcast.'}
              </span>
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

          {/* ---- ONE PASSWORD FOR THE WHOLE WALLET (the app-password design notes)
              Optional, and off until the user turns it on. Nothing here changes
              anything about an existing wallet: setting it writes one record,
              and each wallet moves over the next time it is opened with the
              password it already has. */}
          <div className="section-label">App password</div>
          <div className="card" data-testid="live-app-password-card">
            <div className="list-row" style={{ padding: 0, border: 'none' }}>
              <span className="row-main">
                <span className="row-title">
                  {appPasswordSet ? 'One password for this wallet' : 'Use one password for this wallet'}
                </span>
              </span>
              <span
                className={`chip ${appPasswordSet ? 'success' : 'neutral'}`}
                data-testid="live-app-password-chip"
              >
                {appPasswordSet ? 'On' : 'Off'}
              </span>
            </div>
            {/* Deliberately NOT a `.row-desc`: that class clamps to two lines,
                and this sentence IS the explanation of the feature. A clipped
                "...its curre…" is exactly what a user must not be asked to
                decide from. */}
            <p
              className="text-dim"
              data-testid="live-app-password-state"
              style={{ fontSize: 11.5, margin: '3px 0 0', lineHeight: 1.55 }}
            >
              {appPasswordSet
                ? 'Set. It opens every wallet that has moved over.'
                : 'One password opens the whole wallet. Each wallet moves over the next time you open it with its current password.'}
            </p>

            {!appFormOpen && (
              <Button
                block
                variant={appPasswordSet ? 'secondary' : 'primary'}
                size="sm"
                icon={<KeyRound size={14} />}
                onClick={() => {
                  resetAppForm();
                  setAppPwSuccess('');
                  setAppFormOpen(true);
                }}
                data-testid="live-app-password-open"
                style={{ marginTop: 10 }}
              >
                {appPasswordSet ? 'Change app password' : 'Set an app password'}
              </Button>
            )}

            {appFormOpen && (
              <div style={{ marginTop: 10 }}>
                {appPasswordSet ? (
                  <PasswordField
                    label="Current app password"
                    showLabel="Show password"
                    hideLabel="Hide password"
                    value={appCurrentPw}
                    onChange={(e) => onAppFieldChange(setAppCurrentPw)(e.target.value)}
                    testId="live-app-pw-current"
                  />
                ) : (
                  <>
                    {/* Said BEFORE the password is set, not after: there is no
                        recovery for it, and the recovery phrase of each wallet
                        is the backup, as the wallet has always said. */}
                    <div
                      className="banner warning"
                      data-testid="live-app-password-warning"
                      style={{ marginBottom: 10, alignItems: 'flex-start' }}
                    >
                      <AlertTriangle size={14} />
                      <span>
                        If you lose this password, the wallets it protects can only be restored from
                        their recovery phrases.
                      </span>
                    </div>
                    <p
                      className="text-faint"
                      style={{ fontSize: 11, margin: '0 2px 10px', lineHeight: 1.5 }}
                      data-testid="live-app-password-no-removal"
                    >
                      Removing the app password is not supported in this release. You can change it at
                      any time.
                    </p>
                  </>
                )}
                <PasswordField
                  label={appPasswordSet ? 'New app password' : 'App password'}
                  showLabel="Show password"
                  hideLabel="Hide password"
                  value={appNewPw}
                  onChange={(e) => onAppFieldChange(setAppNewPw)(e.target.value)}
                  testId="live-app-pw-new"
                />
                <PasswordStrengthBar password={appNewPw} />
                <PasswordField
                  label="Confirm app password"
                  showLabel="Show password"
                  hideLabel="Hide password"
                  value={appConfirmPw}
                  onChange={(e) => onAppFieldChange(setAppConfirmPw)(e.target.value)}
                  testId="live-app-pw-confirm"
                />
                {appPasswordSet && (
                  <p className="text-faint" style={{ fontSize: 11, margin: '6px 2px 0', lineHeight: 1.5 }}>
                    Changing it locks the wallet, so you will sign in again with the new password.
                    Wallets that have not moved over keep their own passwords.
                  </p>
                )}
                {appPwError && (
                  <span
                    role="alert"
                    data-testid="live-app-pw-error"
                    style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}
                  >
                    {appPwError}
                  </span>
                )}
                <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
                  <Button
                    block
                    loading={appPwBusy}
                    onClick={() => void handleAppPassword()}
                    data-testid="live-app-pw-submit"
                  >
                    {appPasswordSet ? 'Update app password' : 'Set app password'}
                  </Button>
                  <Button
                    block
                    variant="ghost"
                    onClick={() => {
                      resetAppForm();
                      setAppFormOpen(false);
                    }}
                    data-testid="live-app-pw-cancel"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {appPwSuccess && !appFormOpen && (
              <span
                data-testid="live-app-pw-success"
                style={{ fontSize: 11.5, color: 'var(--success)', display: 'block', marginTop: 8, lineHeight: 1.5 }}
              >
                {appPwSuccess}
              </span>
            )}
          </div>

          {/* Recovery moved to a screen of its own (2026-08-26). It lived here,
              at the bottom of the longest screen in Settings, which is the
              worst place for the one thing a user goes looking for when they
              have lost their password. A pointer stays, because this IS where
              they will look first. */}
          <button
            type="button"
            className="list-row"
            onClick={() => setSection('recovery')}
            data-testid="live-security-to-recovery"
          >
            <span className="row-main">
              <span className="row-title">Forgot your password?</span>
              <span className="row-desc">
                {recoveryCodeSet
                  ? 'A recovery code is set. You can also save a backup file.'
                  : 'Make a recovery code, or save a backup file.'}
              </span>
            </span>
            <ChevronRight size={16} className="text-faint" />
          </button>

          {isAppProtected ? (
            <div className="card" style={{ marginTop: 10 }} data-testid="live-wallet-pw-app-managed">
              <div className="section-label" style={{ marginTop: 0 }}>Wallet password</div>
              <p className="text-dim" style={{ fontSize: 11.5, margin: 0, lineHeight: 1.5 }}>
                This wallet is opened by your app password. It no longer has a password of its own.
              </p>
              {/* §6's convenience half, made visible and reversible. A wallet
                  that was passwordless before it moved to the app password
                  keeps "do not ask when sending", and that used to be a
                  permanent, invisible property: the old badge belonged to the
                  flag the migration clears, and nothing anywhere could turn it
                  off. It decides whether money can leave with nothing typed, so
                  it says so and it has a switch. */}
              <div
                className="list-row"
                style={{ padding: '10px 0 0', border: 'none', marginTop: 8, borderTop: '1px solid var(--border)' }}
              >
                <span className="row-main">
                  <span className="row-title">Ask for the password when sending</span>
                  <span className="text-dim" style={{ fontSize: 10.5, display: 'block', marginTop: 1 }}>
                    For this wallet only. It overrides Require password to send above.
                  </span>
                  <span className="text-dim" style={{ fontSize: 11, display: 'block', marginTop: 2, lineHeight: 1.5 }}>
                    {noSendPassword
                      ? 'Off. Sends from this wallet go through with nothing typed.'
                      : 'On. Your app password is required before a send is broadcast.'}
                  </span>
                </span>
                <Toggle
                  checked={!noSendPassword}
                  onChange={(v) => {
                    setSendPwError('');
                    if (v) {
                      // Back ON: this only ADDS the check, so nothing to prove.
                      closeSendPwForm();
                      void setNoSendPassword(false);
                    } else {
                      // OFF: the switch does not move until the form below is
                      // answered, so it never shows a state that is not real.
                      setSendPwValue('');
                      setSendPwAck(false);
                      setSendPwFormOpen(true);
                    }
                  }}
                  label="Ask for the password when sending"
                  testId="live-set-send-password"
                />
              </div>
              {sendPwFormOpen && !noSendPassword && (
                <div style={{ marginTop: 10 }} data-testid="live-send-password-form">
                  <div
                    className="banner danger"
                    style={{ marginBottom: 10, alignItems: 'flex-start' }}
                    data-testid="live-send-password-warning"
                  >
                    <AlertTriangle size={14} />
                    <span>
                      Sends from this wallet will go through with nothing typed. Anyone who can open
                      this wallet on this computer could take these funds.
                    </span>
                  </div>
                  <PasswordField
                    label="Current app password"
                    showLabel="Show password"
                    hideLabel="Hide password"
                    value={sendPwValue}
                    onChange={(e) => {
                      setSendPwValue(e.target.value);
                      setSendPwError('');
                    }}
                    testId="live-send-password-current"
                  />
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      background: 'var(--card)',
                      borderRadius: 'var(--r-md)',
                      border: '1px solid var(--border)',
                      padding: '10px 12px',
                      margin: '10px 0 4px',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setSendPwAck((v) => !v);
                      setSendPwError('');
                    }}
                    role="checkbox"
                    aria-checked={sendPwAck}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        setSendPwAck((v) => !v);
                        setSendPwError('');
                      }
                    }}
                    data-testid="live-send-password-ack"
                  >
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        border: `2px solid ${sendPwAck ? 'var(--success)' : 'var(--border-strong)'}`,
                        background: sendPwAck ? 'var(--success-bg)' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        transition: 'all 0.15s',
                      }}
                    >
                      {sendPwAck && (
                        <span style={{ color: 'var(--success)', fontSize: 11, fontWeight: 700 }}>✓</span>
                      )}
                    </div>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>I understand the risk</span>
                  </div>
                  {sendPwError && (
                    <span
                      role="alert"
                      data-testid="live-send-password-error"
                      style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 6 }}
                    >
                      {sendPwError}
                    </span>
                  )}
                  <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
                    <Button
                      block
                      variant="danger"
                      loading={sendPwBusy}
                      onClick={() => void handleStopAskingWhenSending()}
                      data-testid="live-send-password-submit"
                    >
                      Stop asking
                    </Button>
                    <Button
                      block
                      variant="ghost"
                      onClick={closeSendPwForm}
                      data-testid="live-send-password-cancel"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
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
          )}
        </>
      )}

      {section === 'recovery' && <RecoverySettings />}

      {section === 'notifications' && (
        <>
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
          <p className="text-faint" style={{ fontSize: 11, margin: '10px 2px 0', lineHeight: 1.5 }}>
            Checked in the background every few minutes, across every wallet on this device, not
            only the one that is open.
          </p>
        </>
      )}

      {section === 'network' && activeEvmChain && (
        <>
          {/* An EVM chain has no Electrum pool: everything it reads goes through
              the Satori GO gateway (one host, the provider key stays on the
              server). That endpoint is shown, never edited: removing it would
              leave the chain with nothing to talk to. (Owner, 2026-08-20: "Epix
              has no Electrum server, it has our gateway, and that must not be
              editable".) */}
          <p
            className="text-faint"
            data-testid="live-network-chain-caption"
            style={{ fontSize: 11, margin: '0 2px 10px', lineHeight: 1.5 }}
          >
            Servers for: {activeEvmChain.displayName}
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
                <span className="sum-key">Chain id</span>
                <span className="sum-val mono" style={{ fontSize: 11 }}>{activeEvmChain.chainId}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Block height</span>
                <span className="sum-val">{network ? network.blockHeight.toLocaleString('en-US') : 'n/a'}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">History source</span>
                <span className="sum-val" style={{ fontSize: 11 }}>
                  {evmGateway
                    ? activeEvmChain.alchemy
                      ? 'Provider API via the gateway'
                      : activeEvmChain.indexer
                        ? 'Chain explorer via the gateway'
                        : 'None (local sends only)'
                    : activeEvmChain.indexer
                      ? activeEvmChain.indexer.baseUrl.replace(/^https?:\/\//, '')
                      : 'None (local sends only)'}
                </span>
              </div>
            </div>
          </div>

          <div className="section-label">Endpoints</div>
          <div className="stack" data-testid="live-evm-endpoints">
            {evmEndpoints.map((ep) => (
              <div className="list-row" key={ep.url} data-testid={`live-evm-endpoint-${ep.kind}`}>
                <span className="row-main" style={{ minWidth: 0 }}>
                  <span className="row-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ep.url}
                    </span>
                    {ep.required && (
                      <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>Required</span>
                    )}
                  </span>
                  <span className="row-desc" style={{ fontSize: 10 }}>{ep.label}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="text-faint" style={{ fontSize: 11, margin: '8px 2px 4px', lineHeight: 1.5 }} data-testid="live-evm-endpoints-note">
            {evmGateway
              ? 'EVM chains read through the Satori GO gateway, which keeps the provider key on the server and carries every EVM chain. The gateway endpoint cannot be removed or replaced here; custom RPC endpoints for EVM chains are not offered yet.'
              : 'This development build reads EVM chains from their public endpoints directly. Release builds go through the Satori GO gateway.'}
          </p>
        </>
      )}

      {section === 'network' && !activeEvmChain && (
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
              // The Satori GO gateway bridge. Shown as the gateway and marked
              // Required, exactly like the EVM endpoint rows above: on
              // Ravencoin it is the only server there is, and on Evrmore it is
              // the only way to the owner's node, so it has no Remove button.
              // Servers the user adds are ordinary rows and stay removable.
              const isBridge = isGatewayElectrumUrl(url);
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
                data-gateway={isBridge ? 'true' : 'false'}
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
                  {/* One line, middle never wraps ("…:500 / 04"): ellipsize and
                      put the full URL in the tooltip. display:block overrides
                      .row-title's flex so text-overflow can actually apply. */}
                  <span
                    className="row-title"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
                  >
                    <span
                      className="mono"
                      title={url}
                      style={{
                        fontSize: 11.5,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {url}
                    </span>
                    {isBridge && (
                      <span
                        className="chip neutral"
                        style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}
                      >
                        Required
                      </span>
                    )}
                  </span>
                  <span className="row-desc" style={{ fontSize: 10 }}>
                    {isBridge ? `Satori GO gateway · ${statusText}` : statusText}
                  </span>
                </span>
                {!isBridge && electrumServers.length > 1 && (
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

          {electrumServers.some((u) => isGatewayElectrumUrl(u)) && (
            <p
              className="text-faint"
              data-testid="live-server-gateway-note"
              style={{ fontSize: 11, margin: '8px 2px 0', lineHeight: 1.5 }}
            >
              The row marked Required is the Satori GO gateway: the wallet reaches this chain
              through one host of ours. It cannot be removed. Anything listed below it is a
              fallback, tried in order when the gateway cannot be reached, including servers you
              add yourself.
            </p>
          )}
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

      {section === 'networks' && (
        <>
          <p className="text-dim" style={{ fontSize: 11.5, margin: '0 2px 12px', lineHeight: 1.5 }}>
            Choose which networks appear in the switcher and when creating a
            wallet. This only changes what you see: hiding a network deletes
            nothing, and any wallet on it comes back the moment you show it
            again.
          </p>
          {CHAIN_OPTIONS.map((opt) => {
            const net = networkFor(opt.value);
            const blocked = chainHideBlockedReason(net.chainId, activeChainId());
            const hidden = hiddenChains.includes(net.chainId);
            const walletCount = walletsOnChain(wallets, net.chainId).length;
            return (
              <div className="list-row" key={opt.value}>
                <span className="row-icon">
                  <TokenIcon assetId={net.ticker} size={17} />
                </span>
                <span className="row-main">
                  <span className="row-title">{net.displayName}</span>
                  <span className="row-desc">
                    {blocked
                      ? blocked
                      : walletCount > 0
                      ? `${walletCount} wallet${walletCount === 1 ? '' : 's'} on this network`
                      : 'No wallet on this network'}
                  </span>
                </span>
                <Toggle
                  checked={!hidden}
                  onChange={(on) => setChainHidden(net.chainId, !on)}
                  disabled={blocked !== null}
                  testId={`live-settings-chain-${net.chainId}`}
                  label={`Show ${net.displayName}`}
                />
              </div>
            );
          })}
          {/* EVM chains (an --evm build): one row per chain, hideable like the
              UTXO ones except the one in use. Hiding a chain hides it from the
              switcher and the create/import picker; the account itself exists
              on every EVM chain regardless, so nothing is lost. */}
          {evmChainsForSettings.map((c) => {
            const target = `evm:${c.key}`;
            const blocked = chainHideBlockedReason(target, activeChainTarget());
            const hidden = hiddenChains.includes(target);
            const evmWalletCount = wallets.filter((w) => w.family === 'evm').length;
            return (
              <div className="list-row" key={target}>
                <span className="row-icon">
                  <TokenIcon assetId={target} size={17} />
                </span>
                <span className="row-main">
                  <span className="row-title">{c.displayName}</span>
                  <span className="row-desc">
                    {blocked
                      ? blocked
                      : evmWalletCount > 0
                        ? `${evmWalletCount} EVM account${evmWalletCount === 1 ? '' : 's'} (every EVM account is on this network)`
                        : 'No EVM account yet'}
                  </span>
                </span>
                <Toggle
                  checked={!hidden}
                  onChange={(on) => setChainHidden(target, !on)}
                  disabled={blocked !== null}
                  testId={`live-settings-chain-${target}`}
                  label={`Show ${c.displayName}`}
                />
              </div>
            );
          })}
        </>
      )}

      {section === 'diagnostics' && (
        <>
          {/* Storage first: it is the only number here that can silently break
              the wallet. chrome.storage.local caps the WHOLE extension, shared
              by vaults, settings and the transaction cache, and a write past the
              cap is swallowed, so the cache would freeze with no visible error.
              Showing the figure is what makes that state diagnosable at all. */}
          <div className="section-label" style={{ marginBottom: 6 }}>
            Storage
          </div>
          {storageError && (
            <div className="banner danger" style={{ marginBottom: 10 }} data-testid="live-diag-error">
              <AlertTriangle size={14} />
              Could not read storage usage. {storageError}
            </div>
          )}
          {!storageStats && !storageError && (
            <p className="text-faint" style={{ fontSize: 11, margin: '2px 2px 10px' }}>
              Reading…
            </p>
          )}
          {storageStats && (
            <>
              <div className="card solid" style={{ marginBottom: 10 }} data-testid="live-diag-storage">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 20, fontWeight: 700 }} data-testid="live-diag-storage-used">
                    {formatBytes(storageStats.usedBytes)}
                  </span>
                  <span className="text-dim" style={{ fontSize: 11 }}>
                    of {formatBytes(storageStats.quotaBytes)} ·{' '}
                    <span data-testid="live-diag-storage-pct">
                      {storageStats.percentUsed.toFixed(1)}%
                    </span>
                  </span>
                </div>
                {/* A bar reads faster than a number when the point is headroom. */}
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: 'var(--border)',
                    overflow: 'hidden',
                    margin: '8px 0 4px',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(1, storageStats.percentUsed)}%`,
                      height: '100%',
                      background:
                        storageStats.percentUsed >= 90
                          ? 'var(--danger)'
                          : storageStats.percentUsed >= 70
                          ? 'var(--warning)'
                          : 'var(--success)',
                    }}
                  />
                </div>
                <span className="text-faint" style={{ fontSize: 10 }}>
                  {storageStats.measured
                    ? 'Reported by the browser, including its own per-entry overhead.'
                    : 'Estimated by measuring stored values (browser total unavailable here).'}{' '}
                  {storageStats.entryCount} entries.
                </span>
              </div>

              {historyFetchError && (
                <div
                  className="banner warning"
                  style={{ marginBottom: 10, alignItems: 'flex-start' }}
                  data-testid="live-diag-history-error"
                >
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    The server refused to return this address's history, so Activity
                    may be incomplete. Balances are unaffected. ({historyFetchError})
                  </span>
                </div>
              )}

              {cacheWriteError && (
                <div
                  className="banner danger"
                  style={{ marginBottom: 10, alignItems: 'flex-start' }}
                  data-testid="live-diag-cache-write-error"
                >
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    The transaction cache could not be saved, so history will keep
                    being re-fetched and may not appear. This usually means storage
                    is full. ({cacheWriteError})
                  </span>
                </div>
              )}

              {storageStats.percentUsed >= 70 && (
                <div className="banner warning" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    Storage is filling up. The transaction cache is the part that grows;
                    once the limit is reached, new history stops being saved.
                  </span>
                </div>
              )}

              {storageStats.categories.map((cat) => (
                <div className="list-row" key={cat.id}>
                  <span className="row-main">
                    <span className="row-title">{cat.label}</span>
                    <span className="row-desc">
                      {cat.entries} {cat.entries === 1 ? 'entry' : 'entries'}
                    </span>
                  </span>
                  <span className="text-dim mono" style={{ fontSize: 11 }}>
                    {formatBytes(cat.bytes)}
                  </span>
                </div>
              ))}

              {storageStats.largest.length > 0 && (
                <>
                  <div className="section-label" style={{ margin: '14px 0 6px' }}>
                    Largest entries
                  </div>
                  {storageStats.largest.map((e) => (
                    <div className="list-row" key={e.key}>
                      <span className="row-main" style={{ minWidth: 0 }}>
                        <span
                          className="row-title mono"
                          style={{
                            fontSize: 10.5,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {e.key}
                        </span>
                      </span>
                      <span className="text-dim mono" style={{ fontSize: 11, flexShrink: 0 }}>
                        {formatBytes(e.bytes)}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          <div className="section-label" style={{ margin: '14px 0 6px' }}>
            Wallet
          </div>
          <div className="list-row">
            <span className="row-main">
              <span className="row-title">Chain</span>
              <span className="row-desc">{activeNet.chainId}</span>
            </span>
            <span className="text-dim" style={{ fontSize: 11 }}>
              {chainDisplayName()}
            </span>
          </div>
          <div className="list-row">
            <span className="row-main">
              <span className="row-title">Derivation</span>
              <span className="row-desc">SLIP-44 coin type {activeNet.coinType}</span>
            </span>
            <span className="text-dim mono" style={{ fontSize: 11 }}>
              {activeNet.addressFormat === 'p2wpkh' ? "m/84'" : "m/44'"}
            </span>
          </div>
          <div className="list-row">
            <span className="row-main">
              <span className="row-title">Wallets</span>
              <span className="row-desc">Across all chains</span>
            </span>
            <span className="text-dim" style={{ fontSize: 11 }}>
              {wallets.length}
            </span>
          </div>
          <div className="list-row">
            <span className="row-main">
              <span className="row-title">Transactions loaded</span>
              <span className="row-desc">Cached for the active wallet</span>
            </span>
            <span className="text-dim" style={{ fontSize: 11 }}>
              {txs.length}
            </span>
          </div>
          <div className="list-row">
            <span className="row-main">
              <span className="row-title">Version</span>
              <span className="row-desc">Satori GO</span>
            </span>
            <span className="text-dim mono" style={{ fontSize: 11 }}>
              {getAppVersion()}
            </span>
          </div>
          <p className="text-faint" style={{ fontSize: 10.5, margin: '10px 2px 4px', lineHeight: 1.5 }}>
            These figures describe this browser profile only. Nothing here is sent
            anywhere, and none of it reveals a key or a recovery phrase.
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

          {/* Price attribution. CoinGecko's free API asks for a visible credit,
              and naming the gateway is the honest description of the path: the
              wallet asks network.satorigo.app, which asks them. */}
          <p
            className="text-faint"
            data-testid="live-about-prices"
            style={{ fontSize: 11, margin: '8px 2px 4px', lineHeight: 1.5 }}
          >
            Prices powered by{' '}
            <a
              href="https://www.coingecko.com"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="live-about-prices-coingecko"
              style={{ color: 'inherit' }}
            >
              CoinGecko
            </a>{' '}
            and SafeTrade (via the Satori GO gateway).
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
