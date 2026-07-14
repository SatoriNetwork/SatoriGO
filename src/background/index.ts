// Satori GO background service worker (MV3, module) — the dApp-connect broker.
//
// Message flow:
//   page (inpage.js)  --postMessage-->  content.js  --runtime.sendMessage-->  HERE
//   HERE --{result|error}--> content.js (immediate), or --{deferred:true}--> and a
//   popup approval window (index.html?dapp=<id>) is opened. The approval page
//   answers with {type:'evr-dapp-approve-result'}; we route the outcome back to
//   the requesting tab as {type:'evr-dapp-result'} via chrome.tabs.sendMessage.
//
// SECURITY INVARIANTS
// - No key material here, ever: the worker reads only the PUBLIC `liveWallets`
//   record (active entry's cached address) and does watch-only Electrum reads.
//   Unlock/sign/broadcast happen exclusively in the approval page (extension UI).
// - Every `connect` from an unknown origin and EVERY send (even from an approved
//   origin) is deferred behind an explicit approval window. Nothing is silent.
// - Pending requests live in chrome.storage.session, so the approve-result route
//   still works if this worker is torn down and restarted in between.

import { getStorage } from '../services/storage';
import { createElectrumClient } from '../services/chain/electrumClient';
import { ElectrumWalletDataProvider } from '../services/chain/electrumProvider';
import { applyStoredElectrumServers } from '../services/chain/network';
import { diffDeposits, type BalanceMap } from './deposits';
import {
  addApproval,
  isOriginApproved,
  normalizeApprovals,
  type ApprovedEntry,
} from './approvals';

// Best-effort: adopt the user's configured Electrum server pool so the dApp
// worker's watch-only reads (getBalances) use the SAME servers as the wallet UI.
// The provider resolves the pool lazily at connect time, so this just needs to
// run before the first getBalances — awaiting is unnecessary.
void applyStoredElectrumServers();

/** storage (local, namespaced): list of {origin, walletId} approvals the user granted
 *  via Connect. An origin is "connected" only while an entry matches the request
 *  origin AND the currently-active wallet (M2 fix — see ./approvals.ts). Legacy bare
 *  strings are migrated on read. KEY is unchanged from the pre-M2 format. */
const APPROVED_ORIGINS_KEY = 'dappApprovedOrigins';
/** storage.session key prefix for pending (deferred) dApp requests. */
const PENDING_PREFIX = 'dappPending:';
/** Public multi-wallet record written by the live wallet (public fields only). */
const WALLETS_KEY = 'liveWallets';

// --- incoming-funds notifications --------------------------------------------
/** chrome.alarms name for the periodic deposit poll. */
const DEPOSIT_ALARM = 'evr-deposit-check';
/** How often (minutes) to poll watched addresses. 1 = the chrome.alarms floor. */
const DEPOSIT_PERIOD_MIN = 1;
/** storage: user toggle (Settings) — notify on incoming funds. Default ON. */
const NOTIFY_DEPOSITS_KEY = 'notifyDeposits';
/** storage: last seen per-asset balances, keyed by address, for delta detection. */
const DEPOSIT_SNAPSHOT_KEY = 'depositWatchSnapshot';

interface DappRequestMessage {
  type: 'evr-dapp';
  id: string;
  method: string;
  params?: Record<string, unknown>;
  origin: string;
}

interface DappApproveResultMessage {
  type: 'evr-dapp-approve-result';
  id: string;
  result?: unknown;
  error?: string;
  /** When set, the user approved a connection for this origin — persist it. */
  approveOrigin?: string;
}

/** A deferred request parked in chrome.storage.session until the user decides. */
export interface PendingDappRequest {
  id: string;
  tabId: number;
  origin: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Public (secret-free) subset of the persisted wallet entries we read. */
interface PublicWalletEntry {
  id: string;
  name?: string;
  address?: string;
  passwordless?: boolean;
}
interface PublicWalletsRecord {
  version: number;
  wallets: PublicWalletEntry[];
  activeId: string;
}

type DappResponse = { result?: unknown; error?: string; deferred?: boolean };

// --- wallet info (read-only, PUBLIC fields — never touches any vault) --------

/** The active wallet id (or '' when none), plus the set of all existing wallet ids.
 *  Read straight from the PUBLIC liveWallets record — no vault, no keys. Used both
 *  to bind/gate approvals and to prune approvals for deleted wallets. */
async function readWalletContext(): Promise<{ activeId: string; validIds: Set<string> }> {
  const store = await getStorage().get<PublicWalletsRecord>(WALLETS_KEY);
  if (!store || !Array.isArray(store.wallets)) return { activeId: '', validIds: new Set() };
  const validIds = new Set(
    store.wallets.map((w) => w.id).filter((id): id is string => typeof id === 'string' && id !== ''),
  );
  const activeId = typeof store.activeId === 'string' ? store.activeId : '';
  return { activeId, validIds };
}

async function getActiveWalletAddress(): Promise<string | null> {
  const store = await getStorage().get<PublicWalletsRecord>(WALLETS_KEY);
  if (!store || !Array.isArray(store.wallets)) return null;
  const entry = store.wallets.find((w) => w.id === store.activeId);
  return entry?.address ? entry.address : null;
}

// --- approved origins --------------------------------------------------------

/** Read the approval list, migrating legacy bare-string origins to the active wallet
 *  and pruning entries for deleted wallets. The migrated form is persisted back once
 *  (only when it actually changed) so the on-disk list converges to the new shape and
 *  dead entries don't accumulate. This is the single place migration/pruning happens
 *  (housekeeping on read — see spec §5). */
async function getApprovedEntries(activeId: string, validIds: Set<string>): Promise<ApprovedEntry[]> {
  const raw = await getStorage().get<unknown>(APPROVED_ORIGINS_KEY);
  const { entries, changed } = normalizeApprovals(raw, activeId, validIds);
  if (changed) {
    try {
      await getStorage().set(APPROVED_ORIGINS_KEY, entries);
    } catch {
      // storage unavailable — the gate still uses the in-memory `entries`.
    }
  }
  return entries;
}

/** Persist a fresh {origin, walletId} approval bound to the CURRENT active wallet.
 *  The wallet id is read inside the worker (never trusted from the page/approval msg).
 *  No active wallet => nothing to bind to, so this is a no-op (fails closed). */
async function addApprovedOrigin(origin: string): Promise<void> {
  const { activeId, validIds } = await readWalletContext();
  if (!activeId) return;
  const entries = await getApprovedEntries(activeId, validIds);
  const next = addApproval(entries, origin, activeId);
  if (next.length !== entries.length) {
    await getStorage().set(APPROVED_ORIGINS_KEY, next);
  }
}

// --- watch-only chain reads ----------------------------------------------------

let provider: ElectrumWalletDataProvider | null = null;
function getProvider(): ElectrumWalletDataProvider {
  if (!provider) provider = new ElectrumWalletDataProvider(createElectrumClient());
  return provider;
}

// --- incoming-funds notifications --------------------------------------------
// A watch-only background poll: every DEPOSIT_PERIOD_MIN it reads each wallet's
// PUBLIC primary address balances and, when an asset balance has grown since the
// last snapshot, fires a desktop notification. No keys, no unlock — purely the
// same public reads the dApp `getBalances` already does. First sight of an
// address only establishes a baseline (so existing balances never notify).

type DepositSnapshot = Record<string, BalanceMap>;

/** Whether the user has deposit notifications enabled (default ON when unset). */
async function notifyDepositsEnabled(): Promise<boolean> {
  const v = await getStorage().get<boolean>(NOTIFY_DEPOSITS_KEY);
  return v !== false; // undefined (never set) => ON
}

/** True when any wallet UI (action popup or an extension tab/window, incl. the
 *  approval window) is currently open. While it is, the foreground already shows
 *  live balances AND holds its own Electrum connection — so we skip the deposit
 *  poll to avoid a second connection contending with it on servers that cap
 *  connections per IP (which was dropping the popup's connection mid-send). */
async function walletUiOpen(): Promise<boolean> {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.getContexts) return false;
    const ctxs = await chrome.runtime.getContexts({});
    return ctxs.some((c) => {
      const t = String(c.contextType);
      return t === 'POPUP' || t === 'TAB' || t === 'SIDE_PANEL';
    });
  } catch {
    return false; // getContexts unavailable — fall through and poll
  }
}

/** Unique { address, name } of every wallet's primary address (public record). */
async function getWatchTargets(): Promise<{ address: string; name: string }[]> {
  const store = await getStorage().get<PublicWalletsRecord>(WALLETS_KEY);
  if (!store || !Array.isArray(store.wallets)) return [];
  const seen = new Set<string>();
  const out: { address: string; name: string }[] = [];
  for (const w of store.wallets) {
    if (typeof w.address === 'string' && w.address && !seen.has(w.address)) {
      seen.add(w.address);
      out.push({ address: w.address, name: w.name || 'Wallet' });
    }
  }
  return out;
}

/** Format a whole-unit amount with up to 8 decimals, trimming trailing zeros. */
function fmtAmount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8, useGrouping: false });
}

function showDepositNotification(walletName: string, asset: string, delta: number): void {
  if (typeof chrome === 'undefined' || !chrome.notifications) return;
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Received funds',
      message: `+${fmtAmount(delta)} ${asset} · ${walletName}`,
      priority: 1,
    });
  } catch {
    // notifications permission missing or platform unsupported — ignore.
  }
}

/** Poll every watched address; notify on any per-asset balance increase. */
async function checkDeposits(): Promise<void> {
  if (!(await notifyDepositsEnabled())) return;
  // Never contend with an open foreground wallet — it already shows balances.
  if (await walletUiOpen()) return;
  const targets = await getWatchTargets();
  if (targets.length === 0) return;

  const snapshot = (await getStorage().get<DepositSnapshot>(DEPOSIT_SNAPSHOT_KEY)) ?? {};
  let changed = false;

  for (const { address, name } of targets) {
    let balances;
    try {
      balances = await getProvider().getAllAssetBalances(address);
    } catch {
      continue; // address unreachable this cycle — try again next tick
    }
    const current: BalanceMap = {};
    for (const b of balances) current[b.name] = b.amount;

    // First sight of an address => diffDeposits returns [] (baseline only).
    for (const { asset, delta } of diffDeposits(snapshot[address], current)) {
      showDepositNotification(name, asset, delta);
    }
    // Always update the baseline (first sight sets it silently; later diffs alert).
    snapshot[address] = current;
    changed = true;
  }

  // Drop snapshots for addresses no longer present so the store can't grow forever.
  const live = new Set(targets.map((t) => t.address));
  for (const addr of Object.keys(snapshot)) {
    if (!live.has(addr)) {
      delete snapshot[addr];
      changed = true;
    }
  }
  if (changed) await getStorage().set(DEPOSIT_SNAPSHOT_KEY, snapshot);
}

/** Ensure the periodic deposit-poll alarm exists (idempotent). */
function ensureDepositAlarm(): void {
  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  try {
    chrome.alarms.create(DEPOSIT_ALARM, { periodInMinutes: DEPOSIT_PERIOD_MIN });
  } catch {
    // alarms permission missing — deposit notifications simply won't run.
  }
}

// --- pending (deferred) requests in session storage ---------------------------

async function savePending(pending: PendingDappRequest): Promise<void> {
  await chrome.storage.session.set({ [PENDING_PREFIX + pending.id]: pending });
}

async function takePending(id: string): Promise<PendingDappRequest | null> {
  const key = PENDING_PREFIX + id;
  const found = await chrome.storage.session.get(key);
  const pending = found[key] as PendingDappRequest | undefined;
  if (!pending) return null;
  await chrome.storage.session.remove(key);
  return pending;
}

/** All currently-parked (deferred) requests, from session storage. */
async function listPending(): Promise<PendingDappRequest[]> {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PENDING_PREFIX))
    .map(([, v]) => v as PendingDappRequest);
}

/** Anti-DoS ceilings on approval popups: at most one open per origin, and a hard
 *  global cap. Without these, any website could loop window.evrmore.connect()
 *  and flood the desktop with OS popup windows / grow session storage forever. */
const MAX_PENDING_TOTAL = 20;

/** Park the request and open the explicit approval window for it. */
async function deferToApproval(
  msg: DappRequestMessage,
  sender: chrome.runtime.MessageSender,
): Promise<DappResponse> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return { error: 'no-tab' };
  const pending = await listPending();
  // One approval window per origin — collapses connect()/send() spam to a single
  // prompt the user must resolve before that origin can open another.
  if (pending.some((p) => p.origin === msg.origin)) {
    return { error: 'approval-already-open' };
  }
  if (pending.length >= MAX_PENDING_TOTAL) {
    return { error: 'too-many-pending-requests' };
  }
  await savePending({ id: msg.id, tabId, origin: msg.origin, method: msg.method, params: msg.params });
  await chrome.windows.create({
    url: chrome.runtime.getURL(`index.html?dapp=${encodeURIComponent(msg.id)}`),
    type: 'popup',
    width: 400,
    height: 620,
  });
  return { deferred: true };
}

// --- request handling ----------------------------------------------------------

async function handleDappRequest(
  msg: DappRequestMessage,
  sender: chrome.runtime.MessageSender,
): Promise<DappResponse> {
  if (typeof msg.id !== 'string' || typeof msg.origin !== 'string' || !msg.origin) {
    return { error: 'bad-request' };
  }
  // "approved" = an entry matches BOTH this origin AND the currently-active wallet.
  // Approving site A for Wallet 1 does NOT grant it access while Wallet 2 is active.
  const { activeId, validIds } = await readWalletContext();
  const entries = await getApprovedEntries(activeId, validIds);
  const approved = isOriginApproved(entries, msg.origin, activeId);

  switch (msg.method) {
    case 'connect': {
      if (approved) {
        const address = await getActiveWalletAddress();
        if (!address) return { error: 'no-wallet' };
        return { result: { address } };
      }
      return deferToApproval(msg, sender);
    }
    case 'getAddress': {
      if (!approved) return { error: 'not-connected' };
      const address = await getActiveWalletAddress();
      if (!address) return { error: 'no-wallet' };
      return { result: address };
    }
    case 'getBalances': {
      if (!approved) return { error: 'not-connected' };
      const address = await getActiveWalletAddress();
      if (!address) return { error: 'no-wallet' };
      // Watch-only: dynamic per-asset balances (incl. SATORIEVR) for the PUBLIC
      // address. No unlock, no keys — the page gets [{name, amount, decimals}].
      const balances = await getProvider().getAllAssetBalances(address);
      return {
        result: balances.map((b) => ({ name: b.name, amount: b.amount, decimals: b.decimals })),
      };
    }
    case 'sendEvr':
    case 'sendAsset':
    case 'signMessage': {
      // Sends AND message signing require a connected origin AND are ALWAYS
      // individually approved in the extension UI (keys never reach the worker).
      if (!approved) return { error: 'not-connected' };
      return deferToApproval(msg, sender);
    }
    default:
      return { error: `unsupported-method:${String(msg.method)}` };
  }
}

/** Outcome from the approval page -> persist the approval, route to the tab. */
async function handleApproveResult(msg: DappApproveResultMessage): Promise<void> {
  if (msg.approveOrigin && !msg.error) await addApprovedOrigin(msg.approveOrigin);
  const pending = await takePending(msg.id);
  if (!pending) return; // already settled (double-send guard) or unknown id
  try {
    await chrome.tabs.sendMessage(pending.tabId, {
      type: 'evr-dapp-result',
      id: msg.id,
      result: msg.result,
      error: msg.error,
    });
  } catch {
    // The requesting tab is gone — nothing to deliver to.
  }
}

/** True when the message provably comes from one of OUR extension pages. */
function isFromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
    const msg = message as { type?: string } | null | undefined;
    if (msg?.type === 'evr-dapp') {
      handleDappRequest(msg as DappRequestMessage, sender)
        .then(sendResponse)
        .catch((err: unknown) =>
          sendResponse({ error: err instanceof Error ? err.message : String(err) }),
        );
      return true; // async sendResponse
    }
    if (msg?.type === 'evr-dapp-approve-result') {
      // Only the extension's own pages (the approval window) may settle requests.
      if (!isFromExtensionPage(sender)) {
        sendResponse({ error: 'forbidden' });
        return undefined;
      }
      handleApproveResult(msg as DappApproveResultMessage)
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) =>
          sendResponse({ error: err instanceof Error ? err.message : String(err) }),
        );
      return true; // async sendResponse
    }
    return undefined;
  },
);

chrome.runtime.onInstalled.addListener(() => {
  // Register the deposit-poll alarm on install/update.
  ensureDepositAlarm();
});

// Re-register the alarm when the browser (re)starts the worker, and fire the
// deposit poll whenever the alarm ticks.
chrome.runtime.onStartup?.addListener(() => ensureDepositAlarm());
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === DEPOSIT_ALARM) void checkDeposits();
});

// On every worker spin-up just (re)register the alarm — the poll itself runs
// ONLY on the alarm tick. We deliberately do NOT poll on spin-up: a service
// worker wakes often (every dApp message re-instantiates it), and opening a
// second Electrum connection each time would contend with the foreground
// wallet's connection on servers that cap connections per IP. The first alarm
// tick establishes the baseline silently (diffDeposits returns [] on first sight).
ensureDepositAlarm();
