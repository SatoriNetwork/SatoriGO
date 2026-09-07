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
import {
  SIDE_PANEL_PREF_KEY,
  defaultSidePanelPreference,
  handleActionClickForSidebar,
  readSidePanelPreference,
  restoreSidePanelPreference,
} from '../services/sidePanel';
import { createElectrumClient } from '../services/chain/electrumClient';
import { ElectrumWalletDataProvider } from '../services/chain/electrumProvider';
import { applyAllStoredElectrumServers } from '../services/chain/network';
import { networkFor } from '../services/chain/chainParams';
import { diffDeposits, type BalanceMap } from './deposits';
import { formatAmount, amountToNumber } from '../services/chain/amounts';
import { displaySymbol } from '../services/displaySymbol';
import {
  normalizeApprovals,
  type ApprovedEntry,
  approvedWalletId,
  collapseToOnePerOrigin,
  setApproval,
} from './approvals';

// Best-effort: adopt the user's configured Electrum server pools so the dApp
// worker's watch-only reads (getBalances) and the deposit poll use the SAME
// servers as the wallet UI. Applied for EVERY chain via the params-derived
// helper, NOT a per-chain call list: the two hardcoded calls that used to sit
// here went stale when four chains were added, so those chains silently polled
// their built-in defaults and ignored the user's configured server. The
// provider resolves the pool lazily at connect time, so this just needs to run
// before the first read — awaiting is unnecessary.
void applyAllStoredElectrumServers();

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
  /** The wallet the user picked to connect (with approveOrigin). Validated here
   *  against the Evrmore wallets that exist; never trusted as-is. */
  walletId?: string;
}

/** A deferred request parked in chrome.storage.session until the user decides. */
export interface PendingDappRequest {
  id: string;
  /** For sign/send: the wallet the origin is connected to, so the approval
   *  page acts on THAT wallet whatever the wallet UI is showing. For connect:
   *  the wallet the site is currently connected to, preselected in the picker. */
  walletId?: string;
  /** When it was parked; see PENDING_TTL_MS. Absent on entries written before
   *  this field existed, which are treated as fresh. */
  createdAt?: number;
  /** The popup window showing this request, when one was opened (absent for a
   *  request hosted in an already-open wallet window). Closing that window
   *  without deciding is a rejection; see windows.onRemoved below. */
  popupWindowId?: number;
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
  /** Stored LiveNetworkId ('mainnet'|'testnet'|'ravencoin-mainnet'). Absent =
   *  legacy Evrmore. Used to poll each wallet against its own chain's pool. */
  network?: string;
  /** Chain family; absent means 'utxo'. An EVM account is never an Evrmore wallet. */
  family?: string;
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

/** `window.evrmore` is an EVRMORE provider, so a site only ever meets an
 *  Evrmore-mainnet wallet. Each chain is its own entry (enableChain creates
 *  "Wallet 1 (Bitcoin)" beside "Wallet 1"), so this is a plain filter. */
function isEvrmoreEntry(w: PublicWalletEntry): boolean {
  return (w.family ?? 'utxo') === 'utxo' && (w.network ?? 'mainnet') === 'mainnet';
}

/** The public wallet list, or [] when there is none. */
async function readWallets(): Promise<PublicWalletEntry[]> {
  const store = await getStorage().get<PublicWalletsRecord>(WALLETS_KEY);
  return store && Array.isArray(store.wallets) ? store.wallets : [];
}

/**
 * The Evrmore wallet `origin` is connected to, or null. The binding is to the
 * wallet the user PICKED in the approval, not to whatever the wallet UI is
 * showing: the owner switches chains all day, and a site that received a
 * Bitcoin address from an Evrmore provider (2026-09-04) is exactly the failure
 * this decides against. A binding to a wallet that no longer exists, or that
 * is not an Evrmore wallet, counts as not connected.
 */
async function connectedWalletFor(origin: string): Promise<PublicWalletEntry | null> {
  const { activeId, validIds } = await readWalletContext();
  const entries = await getApprovedEntries(activeId, validIds);
  const id = approvedWalletId(entries, origin);
  if (!id) return null;
  const wallets = await readWallets();
  const w = wallets.find((x) => x.id === id);
  return w && w.address && isEvrmoreEntry(w) ? w : null;
}

// --- approved origins --------------------------------------------------------

/** Read the approval list, migrating legacy bare-string origins to the active wallet
 *  and pruning entries for deleted wallets. The migrated form is persisted back once
 *  (only when it actually changed) so the on-disk list converges to the new shape and
 *  dead entries don't accumulate. This is the single place migration/pruning happens
 *  (housekeeping on read — see spec §5). */
async function getApprovedEntries(activeId: string, validIds: Set<string>): Promise<ApprovedEntry[]> {
  const raw = await getStorage().get<unknown>(APPROVED_ORIGINS_KEY);
  const normalized = normalizeApprovals(raw, activeId, validIds);
  // One wallet per origin (1.4.1): a 1.4.0 list that approved a site for two
  // wallets keeps the later consent, so Settings shows one row per site and
  // Disconnect there really disconnects it.
  const collapsed = collapseToOnePerOrigin(normalized.entries);
  const entries = collapsed.entries;
  const changed = normalized.changed || collapsed.changed;
  if (changed) {
    try {
      await getStorage().set(APPROVED_ORIGINS_KEY, entries);
    } catch {
      // storage unavailable — the gate still uses the in-memory `entries`.
    }
  }
  return entries;
}

/**
 * Persist the connection: `origin` -> the wallet the user picked. The id comes
 * from our own approval page, but it is still checked here against the Evrmore
 * wallets that exist, so a bad or stale id binds nothing (fails closed). With
 * no id (an approval page from before the picker) the active wallet is used IF
 * it is an Evrmore wallet, the one case that was correct before too. Replaces
 * any earlier binding for the origin: a site is connected to one wallet at a
 * time.
 */
async function bindOriginToWallet(origin: string, pickedId: string | undefined): Promise<void> {
  const { activeId, validIds } = await readWalletContext();
  const wallets = await readWallets();
  const candidate = wallets.find((w) => w.id === (pickedId || activeId));
  if (!candidate || !isEvrmoreEntry(candidate)) return;
  const entries = await getApprovedEntries(activeId, validIds);
  await getStorage().set(APPROVED_ORIGINS_KEY, setApproval(entries, origin, candidate.id));
}

// --- watch-only chain reads ----------------------------------------------------

// One provider (and its own Electrum client) PER CHAIN. The deposit poll can see
// a MIX of Evrmore and Ravencoin wallets, and a single ambient-chain client can't
// serve both concurrently (different hosts, and the native ticker differs). Each
// per-chain client resolves that chain's pool at connect time; each provider
// reports the right native name (EVR / RVN). Cached so we reuse one socket/chain.
const providersByChain = new Map<string, ElectrumWalletDataProvider>();
function getProviderForChain(chainId: string): ElectrumWalletDataProvider {
  let p = providersByChain.get(chainId);
  if (!p) {
    const net = networkFor(chainId as never);
    p = new ElectrumWalletDataProvider(createElectrumClient(undefined, { chainId }), {
      network: net,
    });
    providersByChain.set(chainId, p);
  }
  return p;
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
    if (typeof chrome === 'undefined') return false;
    // Chrome MV3 service worker: getContexts is the authoritative enumeration.
    // This branch is byte-for-byte the original code path and only runs when
    // getContexts exists; the Firefox fallback below is the only addition.
    if (chrome.runtime?.getContexts) {
      const ctxs = await chrome.runtime.getContexts({});
      return ctxs.some((c) => {
        const t = String(c.contextType);
        return t === 'POPUP' || t === 'TAB' || t === 'SIDE_PANEL';
      });
    }
    // Firefox has no runtime.getContexts. Its background is an event PAGE (a real
    // DOM context, unlike a Chrome service worker), so chrome.extension.getViews
    // enumerates every open extension page. Any view that is not the background
    // page itself is an open wallet UI (toolbar popup, detached window, or an
    // extension tab) - the same "foreground wallet is open" signal the Chrome
    // branch derives from POPUP/TAB/SIDE_PANEL contexts. This only gates the
    // deposit poll (a connection-contention optimization); it is not a security
    // control, so an imperfect result can at worst delay a notification.
    const ext = chrome.extension as typeof chrome.extension | undefined;
    if (ext?.getViews) {
      const bg = ext.getBackgroundPage ? ext.getBackgroundPage() : undefined;
      return ext.getViews({}).some((w) => w !== bg);
    }
    return false;
  } catch {
    return false; // enumeration unavailable - fall through and poll
  }
}

/** Unique { address, name, chainId } of every wallet's primary address (public
 *  record). chainId is the wallet's stored network so the poll hits the right
 *  chain's server pool + native ticker. */
async function getWatchTargets(): Promise<{ address: string; name: string; chainId: string }[]> {
  const store = await getStorage().get<PublicWalletsRecord>(WALLETS_KEY);
  if (!store || !Array.isArray(store.wallets)) return [];
  const seen = new Set<string>();
  const out: { address: string; name: string; chainId: string }[] = [];
  for (const w of store.wallets) {
    if (typeof w.address === 'string' && w.address && !seen.has(w.address)) {
      seen.add(w.address);
      out.push({ address: w.address, name: w.name || 'Wallet', chainId: w.network ?? 'mainnet' });
    }
  }
  return out;
}

function showDepositNotification(
  walletName: string,
  asset: string,
  deltaBase: bigint,
  scale: number,
): void {
  if (typeof chrome === 'undefined' || !chrome.notifications) return;
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Received funds',
      // The asset name reaches the OS notification centre, outside every CSS
      // guard the wallet has, so it is drawn through the same sanitiser the UI
      // uses (services/displaySymbol.ts).
      message: `+${formatAmount(deltaBase, scale)} ${displaySymbol(asset)} · ${walletName}`,
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

  // Group by chain so each group polls its OWN chain's pool via a per-chain
  // provider/client. A chain whose pool is unreachable fails silently for that
  // chain (the inner try/continue) WITHOUT affecting the other chain — no retry
  // loop, bounded to one attempt per address per tick.
  for (const { address, name, chainId } of targets) {
    let balances;
    try {
      balances = await getProviderForChain(chainId).getAllAssetBalances(address);
    } catch {
      continue; // address/chain unreachable this cycle — try again next tick
    }
    // Base units as strings: exact, and JSON-safe for storage (a BigInt would
    // throw in JSON.stringify).
    const current: BalanceMap = {};
    const scales = new Map<string, number>();
    for (const b of balances) {
      current[b.name] = b.amountBase.toString();
      scales.set(b.name, b.scale);
    }

    // First sight of an address => diffDeposits returns [] (baseline only).
    for (const { asset, deltaBase, scale } of diffDeposits(snapshot[address], current, (a) =>
      scales.get(a) ?? 8,
    )) {
      showDepositNotification(name, asset, deltaBase, scale);
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

/** How long a parked request may wait for a decision. An approval window that
 *  died without settling (a crash, a window killed by the OS, a worker that was
 *  gone when its close handler ran) used to leave its entry behind for the whole
 *  browser session, and "one approval per origin" then refused every later
 *  connect() from that site with approval-already-open until a restart. */
const PENDING_TTL_MS = 15 * 60_000;

/** All currently-parked (deferred) requests, from session storage. Entries past
 *  PENDING_TTL_MS are dropped (and removed) here, so a dead approval cannot
 *  wedge an origin. An entry without createdAt is treated as fresh. */
async function listPending(): Promise<PendingDappRequest[]> {
  const all = await chrome.storage.session.get(null);
  const now = Date.now();
  const live: PendingDappRequest[] = [];
  const stale: string[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(PENDING_PREFIX)) continue;
    const p = v as PendingDappRequest;
    if (typeof p.createdAt === 'number' && now - p.createdAt > PENDING_TTL_MS) stale.push(k);
    else live.push(p);
  }
  if (stale.length) {
    try { await chrome.storage.session.remove(stale); } catch { /* best-effort */ }
  }
  return live;
}

/** How long an open wallet window gets to claim a request before the popup
 *  opens instead. The preferred window claims within a few ms; any other open
 *  wallet window waits HOST_FALLBACK_DELAY_MS (App.tsx) before it tries. */
const HOST_CLAIM_MS = 400;

/** Offers out to open wallet windows, by request id: resolve(true) on the
 *  first claim, resolve(false) when HOST_CLAIM_MS passes with none. */
const hostOffers = new Map<string, (claimed: boolean) => void>();

/**
 * Show the approval INSIDE a wallet window that is already open (the side
 * panel, the toolbar popup or a detached window), instead of opening a popup
 * on top of it. Chrome only lets sidePanel.open() run from a user gesture, and
 * a page's message is not one, so the panel cannot be opened for the request;
 * but a panel or window that is already open can host it.
 *
 * Two steps, because a URL does not name ONE window: two wallet tabs share
 * `index.html`, and a single broadcast answered by "the page whose URL matches"
 * put the same approval on both (seen 2026-09-07; the second copy sat over the
 * wallet until it was closed by hand). So the worker broadcasts an OFFER naming
 * the preferred window's URL, pages answer with a CLAIM, and exactly one claim
 * is accepted (see the listener); the losers show nothing. Returns false when
 * nothing hosted it (no wallet window open, a browser without getContexts, no
 * claim in time), and the caller falls back to the popup.
 */
async function hostInOpenWalletUi(id: string): Promise<boolean> {
  try {
    const rt = chrome.runtime as typeof chrome.runtime & {
      getContexts?: (f: { contextTypes: string[] }) => Promise<Array<{ contextType: string; documentUrl?: string }>>;
    };
    if (typeof rt.getContexts !== 'function' || typeof rt.sendMessage !== 'function') return false;
    const ctxs = await rt.getContexts({ contextTypes: ['SIDE_PANEL', 'POPUP', 'TAB'] });
    const rank: Record<string, number> = { SIDE_PANEL: 0, POPUP: 1, TAB: 2 };
    const hosts = ctxs
      // An approval window is itself a TAB context; it must never host another.
      .filter((c) => typeof c.documentUrl === 'string' && !/[?&]dapp=/.test(c.documentUrl))
      .sort((a, b) => (rank[a.contextType] ?? 9) - (rank[b.contextType] ?? 9));
    const target = hosts[0]?.documentUrl;
    if (!target) return false;
    const claimed = new Promise<boolean>((resolve) => {
      hostOffers.set(id, resolve);
      setTimeout(() => {
        if (hostOffers.delete(id)) resolve(false);
      }, HOST_CLAIM_MS);
    });
    // Fire and forget: with no wallet page listening this rejects, which is
    // the same as no claim. Pages answer with their own evr-dapp-host-claim.
    void Promise.resolve(rt.sendMessage({ type: 'evr-dapp-host-offer', id, hostUrl: target })).catch(() => undefined);
    return await claimed;
  } catch {
    return false;
  }
}

/** A wallet page claims an offered request. Exactly one claim per request is
 *  accepted; the rest (and a claim for nothing on offer) are refused. */
function acceptHostClaim(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  const resolve = hostOffers.get(id);
  if (!resolve) return false;
  hostOffers.delete(id);
  resolve(true);
  return true;
}

/** Anti-DoS ceilings on approval popups: at most one open per origin, and a hard
 *  global cap. Without these, any website could loop window.evrmore.connect()
 *  and flood the desktop with OS popup windows / grow session storage forever. */
const MAX_PENDING_TOTAL = 20;

/** Park the request and open the explicit approval window for it. */
const POPUP_WIDTH = 400;
const POPUP_HEIGHT = 620;
const POPUP_INSET = 8;

/** A request younger than this is assumed to still be on screen even when no
 *  page answers the ping: the approval page is probably still booting. */
const APPROVAL_BOOT_GRACE_MS = 1500;
/** How long the liveness ping waits for an answer. */
const PING_TIMEOUT_MS = 1000;

/**
 * Is the approval for `pending` still on screen somewhere? Every approval page
 * (popup or hosted) answers evr-dapp-ping for its own request id while it is
 * undecided. The page's own "closed without deciding" message (pagehide) is
 * best effort: a wallet window torn down mid-flight does not always get it out
 * (seen 2026-09-07: the owner closed the wallet during a sign request, and the
 * site's next request was refused with approval-already-open until restart).
 * So the worker asks instead of trusting.
 */
async function approvalStillShown(pending: PendingDappRequest): Promise<boolean> {
  if (typeof pending.createdAt === 'number' && Date.now() - pending.createdAt < APPROVAL_BOOT_GRACE_MS) return true;
  try {
    const rt = chrome.runtime;
    if (typeof rt.sendMessage !== 'function') return false;
    // A page whose listener answers asynchronously and never replies would
    // hang this promise, and with it every later request from the site.
    const ping = Promise.resolve(rt.sendMessage({ type: 'evr-dapp-ping', id: pending.id })) as Promise<{ alive?: boolean } | undefined>;
    const silence = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), PING_TIMEOUT_MS));
    const r = await Promise.race([ping, silence]);
    return r?.alive === true;
  } catch {
    // No page listening at all: nothing shows this request.
    return false;
  }
}

/** Deliver a settled outcome to the tab that asked, if it still hosts the origin. */
async function deliverToTab(pending: PendingDappRequest, payload: { result?: unknown; error?: string }): Promise<void> {
  if (!(await tabMayReceive(pending.tabId, pending.origin))) return;
  try {
    await chrome.tabs.sendMessage(pending.tabId, {
      type: 'evr-dapp-result',
      id: pending.id,
      // Echo the requesting origin so the content script can refuse to relay
      // the result into a document with a different location.origin (the tab
      // may have navigated; see tabMayReceive for why the check cannot live
      // solely on this side).
      origin: pending.origin,
      result: payload.result,
      error: payload.error,
    });
  } catch {
    // The requesting tab is gone — nothing to deliver to.
  }
}

/** A request whose approval vanished undecided counts as rejected: forget it
 *  and tell the site, so its promise settles instead of hanging. */
async function abandonPending(pending: PendingDappRequest): Promise<void> {
  const taken = await takePending(pending.id);
  if (!taken) return; // settled meanwhile
  await deliverToTab(taken, { error: 'user-rejected' });
}

/** The popup for a request was closed: by the page after deciding (its entry
 *  is already gone, nothing to do) or by the user without deciding (reject). */
async function onApprovalWindowRemoved(windowId: number): Promise<void> {
  for (const p of await listPending()) {
    if (p.popupWindowId === windowId) await abandonPending(p);
  }
}
if (typeof chrome.windows?.onRemoved?.addListener === 'function') {
  chrome.windows.onRemoved.addListener((windowId) => {
    void onApprovalWindowRemoved(windowId);
  });
}

/**
 * Every approval page (popup or hosted) holds a port named
 * evr-dapp-approval:<id> open while it is on screen. A port disconnects the
 * moment its page is destroyed, however that happens (tab closed, side panel
 * closed, wallet window closed, navigation), which is what pagehide could not
 * promise. If the entry is still parked when the port goes, the user closed
 * the wallet without deciding: reject the request to the site. A short grace
 * covers a page that reconnects at once (React's development double-mount,
 * a worker restart the page recovers from).
 */
const PORT_PREFIX = 'evr-dapp-approval:';
const PORT_GONE_GRACE_MS = 300;
const approvalPorts = new Map<string, chrome.runtime.Port>();

async function onApprovalPortGone(id: string): Promise<void> {
  const raw = await chrome.storage.session.get(PENDING_PREFIX + id);
  const p = raw[PENDING_PREFIX + id] as PendingDappRequest | undefined;
  if (p) await abandonPending(p);
}
if (typeof chrome.runtime.onConnect?.addListener === 'function') {
  chrome.runtime.onConnect.addListener((port) => {
    if (typeof port.name !== 'string' || !port.name.startsWith(PORT_PREFIX)) return;
    if (!isFromExtensionPage(port.sender ?? {})) {
      port.disconnect();
      return;
    }
    const id = port.name.slice(PORT_PREFIX.length);
    approvalPorts.set(id, port);
    port.onDisconnect.addListener(() => {
      if (approvalPorts.get(id) === port) approvalPorts.delete(id);
      setTimeout(() => {
        if (approvalPorts.has(id)) return; // the page came back
        void onApprovalPortGone(id);
      }, PORT_GONE_GRACE_MS);
    });
  });
}

/**
 * Where the approval popup goes: the TOP-RIGHT corner of the browser window
 * the request came from, every time. Left to Chrome, the popup landed wherever
 * the window manager felt like (the owner saw it at the left edge), and a
 * password prompt that moves around is one the user has to hunt for. The
 * requesting tab's window is used, so it sits over the page that asked; with
 * no usable geometry (a browser without windows.get, a minimised window)
 * nothing is passed and Chrome places it as before.
 */
async function popupPlacement(sender: chrome.runtime.MessageSender): Promise<{ left?: number; top?: number }> {
  try {
    const wins = chrome.windows as typeof chrome.windows | undefined;
    if (!wins || typeof wins.get !== 'function') return {};
    const windowId = sender.tab?.windowId;
    const win = typeof windowId === 'number' ? await wins.get(windowId) : await wins.getLastFocused();
    if (typeof win.left !== 'number' || typeof win.top !== 'number' || typeof win.width !== 'number') return {};
    if (win.state === 'minimized' || win.width < POPUP_WIDTH) return {};
    return {
      left: Math.max(0, Math.round(win.left + win.width - POPUP_WIDTH - POPUP_INSET)),
      top: Math.max(0, Math.round(win.top + POPUP_INSET)),
    };
  } catch {
    return {};
  }
}

// --- the side panel as the approval surface ---------------------------------
//
// The owner's ask (2026-09-07): "MetaMask slides the extension out as a side
// panel for approvals; can we?" We can, with one constraint. Chrome's
// chrome.sidePanel.open() runs only in response to a user gesture, and the
// site's click reaches the worker as a content-script message that still
// carries that gesture, but only while the message handler runs SYNCHRONOUSLY:
// the first await loses it (verified: the same call succeeded before any await
// and was refused after one). So the decision to open the panel is made from
// what is known synchronously: the user's window mode (cached below) and the
// method. connect/sign/send are the calls that put an approval in front of the
// user; getAddress/getBalances never do and never open anything. A connect()
// on an already-connected site opens the panel and then answers silently, which
// is the wallet appearing when the user pressed "Connect wallet": acceptable.
// With no gesture (a site calling connect() on page load) open() rejects and
// the request falls through to the popup exactly as before.

/** The effective window mode, kept current for the synchronous decision.
 *  null until the first read completes; the platform default applies then. */
let sidePanelPreferred: boolean | null = null;
void readSidePanelPreference().then((v) => {
  sidePanelPreferred = v;
});
if (typeof chrome.storage?.onChanged?.addListener === 'function') {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, SIDE_PANEL_PREF_KEY)) {
      void readSidePanelPreference().then((v) => {
        sidePanelPreferred = v;
      });
    }
  });
}

/** How long the panel gets to boot and claim the request before the popup. */
const SIDE_PANEL_BOOT_MS = 4000;
const APPROVAL_METHODS = new Set(['connect', 'signMessage', 'sendEvr', 'sendAsset']);

/**
 * Called synchronously from the message listener. Returns a promise of whether
 * the side panel was opened for the requesting tab (null when not attempted).
 * Never throws; the rejection of open() is the "no gesture" case.
 */
function openSidePanelForRequest(msg: DappRequestMessage, sender: chrome.runtime.MessageSender): Promise<boolean> | null {
  const sp = (chrome as unknown as { sidePanel?: { open?: (o: { tabId: number }) => Promise<void> } }).sidePanel;
  const tabId = sender.tab?.id;
  if (typeof sp?.open !== 'function' || typeof tabId !== 'number') return null;
  if (!APPROVAL_METHODS.has(msg.method)) return null;
  if (!(sidePanelPreferred ?? defaultSidePanelPreference())) return null;
  try {
    return sp.open({ tabId }).then(
      () => true,
      () => false,
    );
  } catch {
    return null;
  }
}

async function deferToApproval(
  msg: DappRequestMessage,
  sender: chrome.runtime.MessageSender,
  walletId?: string,
  panelOpening: Promise<boolean> | null = null,
): Promise<DappResponse> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return { error: 'no-tab' };
  let pending = await listPending();
  // One approval per origin — collapses connect()/send() spam to a single
  // prompt the user must resolve before that origin can open another. But only
  // while that prompt is actually on screen: one whose window went away
  // undecided is treated as rejected and this request takes its place.
  const existing = pending.find((p) => p.origin === msg.origin);
  if (existing) {
    if (await approvalStillShown(existing)) return { error: 'approval-already-open' };
    await abandonPending(existing);
    pending = pending.filter((p) => p.id !== existing.id);
  }
  if (pending.length >= MAX_PENDING_TOTAL) {
    return { error: 'too-many-pending-requests' };
  }
  await savePending({
    id: msg.id,
    tabId,
    origin: msg.origin,
    method: msg.method,
    params: msg.params,
    createdAt: Date.now(),
    ...(walletId ? { walletId } : {}),
  });
  // The user's window mode first: a wallet that is already open shows the
  // request where the user is looking. Only when nothing is open does an OS
  // popup appear, which is the only window a page's message may cause.
  if (await hostInOpenWalletUi(msg.id)) return { deferred: true };
  // The side panel was opened for this request: it needs a moment to boot
  // before it can claim. Keep offering until it does or the time is up.
  if (panelOpening && (await panelOpening)) {
    const until = Date.now() + SIDE_PANEL_BOOT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      if (await hostInOpenWalletUi(msg.id)) return { deferred: true };
    }
  }
  const placement = await popupPlacement(sender);
  // A window partly off-screen makes the computed corner invalid ("Bounds must
  // be at least 50% within visible screen space"); then let Chrome place it.
  const create = (pos: { left?: number; top?: number }) => chrome.windows.create({
    ...pos,
    url: chrome.runtime.getURL(`index.html?dapp=${encodeURIComponent(msg.id)}`),
    type: 'popup',
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
  });
  let win: chrome.windows.Window | undefined;
  try {
    win = await create(placement);
  } catch {
    win = await create({});
  }
  if (win && typeof win.id === 'number') {
    const parked = (await chrome.storage.session.get(PENDING_PREFIX + msg.id))[PENDING_PREFIX + msg.id] as
      | PendingDappRequest
      | undefined;
    if (parked) await savePending({ ...parked, popupWindowId: win.id });
  }
  return { deferred: true };
}

// --- request handling ----------------------------------------------------------

async function handleDappRequest(
  msg: DappRequestMessage,
  sender: chrome.runtime.MessageSender,
  panelOpening: Promise<boolean> | null = null,
): Promise<DappResponse> {
  if (typeof msg.id !== 'string' || typeof msg.origin !== 'string' || !msg.origin) {
    return { error: 'bad-request' };
  }
  // "connected" = this origin is bound to an Evrmore wallet that still exists.
  // The binding is to the wallet the user picked, and it does not move when the
  // wallet UI switches wallet or chain: a site approved for Wallet 1 keeps
  // Wallet 1, and never sees any other wallet's address or balances.
  const connected = await connectedWalletFor(msg.origin);

  switch (msg.method) {
    case 'connect': {
      // connect() is the site's EXPLICIT ask (a button, not a page load), so
      // when there is a choice to make the user makes it: with several Evrmore
      // wallets the approval opens with the picker, the connected wallet
      // preselected, and a different pick re-binds the site. With one Evrmore
      // wallet a connected site is answered at once. Sites that only want to
      // restore a session use getAddress(), which never prompts.
      if (connected) {
        const evrmore = (await readWallets()).filter(isEvrmoreEntry);
        if (evrmore.length <= 1) return { result: { address: connected.address } };
        return deferToApproval(msg, sender, connected.id, panelOpening);
      }
      return deferToApproval(msg, sender, undefined, panelOpening);
    }
    case 'getAddress': {
      if (!connected) return { error: 'not-connected' };
      return { result: connected.address };
    }
    case 'getBalances': {
      if (!connected) return { error: 'not-connected' };
      const active = { address: connected.address as string, network: connected.network ?? 'mainnet' };
      // Watch-only: dynamic per-asset balances (incl. SATORIEVR) for the PUBLIC
      // address, read against the CONNECTED wallet's own chain (right pool +
      // native ticker). No unlock, no keys — the page gets [{name, amount, decimals}].
      const balances = await getProviderForChain(active.network).getAllAssetBalances(active.address);
      return {
        // `amount` stays a NUMBER: this is a public API that sites already
        // consume, and changing its type would break them. `amountBase` is
        // added alongside as an exact decimal string in base units, with the
        // `scale` to read it by, so a new consumer can be precise without any
        // existing one having to change.
        result: balances.map((b) => ({
          name: b.name,
          amount: amountToNumber(b.amountBase, b.scale),
          decimals: b.decimals,
          amountBase: b.amountBase.toString(),
          scale: b.scale,
        })),
      };
    }
    case 'sendEvr':
    case 'sendAsset':
    case 'signMessage': {
      // Sends AND message signing require a connected origin AND are ALWAYS
      // individually approved in the extension UI (keys never reach the worker).
      // The pending request names the CONNECTED wallet so the approval page
      // unlocks and signs with that one, not with whatever is active in the UI.
      if (!connected) return { error: 'not-connected' };
      return deferToApproval(msg, sender, connected.id, panelOpening);
    }
    default:
      return { error: `unsupported-method:${String(msg.method)}` };
  }
}

/**
 * True when the tab may still receive `origin`'s deferred result. The page that
 * made the request can navigate away while its approval window is open; whatever
 * page then occupies the tab must NOT receive the result (an address, txid or
 * signature meant for the approved origin).
 *
 * BEST-EFFORT ONLY: without the "tabs" permission (deliberately not requested —
 * it adds a "read your browsing history" install warning) `tab.url` is readable
 * only for hosts in host_permissions, so an unreadable URL cannot fail closed
 * here without breaking delivery to every ordinary dApp. The AUTHORITATIVE check
 * is in content.js, which relays a result only when this document deferred that
 * exact id AND `location.origin` matches the origin echoed in the message; this
 * layer just drops what it can already prove wrong (tab closed, or a readable
 * URL on a different origin).
 */
async function tabMayReceive(tabId: number, origin: string): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.url === 'string' && tab.url) {
      return new URL(tab.url).origin === origin;
    }
    return true; // URL unreadable — defer to the content script's own check
  } catch {
    return false; // tab is gone — nothing to deliver to
  }
}

/** Outcome from the approval page -> persist the approval, route to the tab. */
async function handleApproveResult(msg: DappApproveResultMessage): Promise<void> {
  if (msg.approveOrigin && !msg.error) await bindOriginToWallet(msg.approveOrigin, msg.walletId);
  const pending = await takePending(msg.id);
  if (!pending) return; // already settled (double-send guard) or unknown id
  await deliverToTab(pending, { result: msg.result, error: msg.error });
}

/** True when the message provably comes from one of OUR extension pages. */
function isFromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
    const msg = message as { type?: string } | null | undefined;
    if (msg?.type === 'evr-dapp') {
      // SYNCHRONOUSLY, before any await: the user's click on the site is the
      // gesture chrome.sidePanel.open() needs, and it does not survive an await.
      const panelOpening = openSidePanelForRequest(msg as DappRequestMessage, sender);
      handleDappRequest(msg as DappRequestMessage, sender, panelOpening)
        .then(sendResponse)
        .catch((err: unknown) =>
          sendResponse({ error: err instanceof Error ? err.message : String(err) }),
        );
      return true; // async sendResponse
    }
    if (msg?.type === 'evr-dapp-host-claim') {
      // Only the extension's own pages may host a request.
      const accepted = isFromExtensionPage(sender) && acceptHostClaim((msg as { id?: unknown }).id);
      sendResponse({ accepted });
      return undefined;
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
  // A fresh install has no stored window mode, and the side panel is the
  // default: this is where a Chrome/Edge install is switched over to it. An
  // update reloads the extension and can reset the action popup / panel
  // registration, so the same call puts an explicit choice back.
  void restoreSidePanelPreference();
});
// Every worker boot (browser start included): the window mode is re-applied
// from storage, so it does not depend on what the browser persists, and the
// default reaches users whose onInstalled fired before this code shipped.
void restoreSidePanelPreference();
// Firefox: with the popup cleared (side panel preference on) the toolbar click
// arrives here; toggle the sidebar. Chrome/Edge never fire this for the panel.
chrome.action?.onClicked?.addListener(() => {
  void handleActionClickForSidebar();
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
