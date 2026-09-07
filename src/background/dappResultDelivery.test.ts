// Deferred dApp result delivery (background/index.ts, handleApproveResult).
//
// A deferred request's outcome (address / txid / signature) is routed back to
// the ORIGINATING TAB once the user decides in the approval window. The page
// may have navigated while that window was open, so the worker must not hand
// the result to whatever page now occupies the tab: when the tab's URL is
// readable its origin must still match the requesting origin, and when the tab
// is gone nothing is sent at all. (When the URL is NOT readable — the manifest
// deliberately omits the "tabs" permission — the worker delivers and the
// content script performs the authoritative origin/deferred-id check; that
// side lives in public/content.js, which is plain JS outside this suite.)
//
// The worker module wires itself to `chrome` at import time, so this suite
// stubs the chrome surface it touches BEFORE importing and then drives the
// captured onMessage listener exactly the way the approval page would.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type MessageListener = (
  message: unknown,
  sender: { url?: string },
  sendResponse: (r?: unknown) => void,
) => unknown;

const messageListeners: MessageListener[] = [];
const localData = new Map<string, unknown>();
const sessionData = new Map<string, unknown>();
const tabsGet = vi.fn();
const tabsSendMessage = vi.fn();
const windowsCreate = vi.fn();
const windowsGet = vi.fn();
const runtimeGetContexts = vi.fn();
const runtimeSendMessage = vi.fn();
const sidePanelOpen = vi.fn();
const storageChangedListeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
const windowRemovedListeners: Array<(windowId: number) => void> = [];
type FakePort = {
  name: string;
  sender?: { url?: string };
  disconnect: ReturnType<typeof vi.fn>;
  onDisconnect: { addListener: (fn: () => void) => void };
  fire: () => void;
};
const connectListeners: Array<(port: FakePort) => void> = [];

/** A port as an approval page would open it; `fire()` simulates the page dying. */
function fakePort(name: string, url = 'chrome-extension://test-ext/index.html?dapp=x'): FakePort {
  const handlers: Array<() => void> = [];
  return {
    name,
    sender: { url },
    disconnect: vi.fn(),
    onDisconnect: { addListener: (fn) => { handlers.push(fn); } },
    fire: () => { for (const h of handlers) h(); },
  };
}

/** chrome.storage-style get: {key: value} for every present requested key. */
function grab(store: Map<string, unknown>, key: string | string[] | null): Record<string, unknown> {
  const keys = key === null ? [...store.keys()] : Array.isArray(key) ? key : [key];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (store.has(k)) out[k] = store.get(k);
  return out;
}

function storageArea(store: Map<string, unknown>) {
  return {
    get: async (key: string | string[] | null) => grab(store, key),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    remove: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
  };
}

// Only the chrome surface background/index.ts touches on import + these paths.
// alarms/notifications are ABSENT on purpose: the worker guards them (typeof
// checks / optional chaining). `windows` carries only create/get, for the
// deferral tests below. runtime.getContexts answers [] by default (no wallet
// window open), so every deferral goes to the popup unless a test says so.
const chromeStub = {
  runtime: {
    getURL: (p: string) => `chrome-extension://test-ext/${p}`,
    onMessage: {
      addListener: (fn: MessageListener) => {
        messageListeners.push(fn);
      },
    },
    onInstalled: { addListener: () => undefined },
    getContexts: runtimeGetContexts,
    sendMessage: runtimeSendMessage,
    onConnect: {
      addListener: (fn: (port: FakePort) => void) => {
        connectListeners.push(fn);
      },
    },
  },
  storage: {
    local: storageArea(localData),
    session: storageArea(sessionData),
    onChanged: {
      addListener: (fn: (changes: Record<string, unknown>, area: string) => void) => {
        storageChangedListeners.push(fn);
      },
    },
  },
  sidePanel: { open: sidePanelOpen },
  tabs: { get: tabsGet, sendMessage: tabsSendMessage },
  windows: {
    create: windowsCreate,
    get: windowsGet,
    onRemoved: {
      addListener: (fn: (windowId: number) => void) => {
        windowRemovedListeners.push(fn);
      },
    },
  },
};

/** Sender that passes isFromExtensionPage (only extension pages may settle). */
const APPROVAL_PAGE_SENDER = { url: 'chrome-extension://test-ext/index.html?dapp=x' };

/** Drive the captured listener as the approval page would; resolves when the
 *  worker calls sendResponse (i.e. handleApproveResult has fully finished). */
function settleFromApprovalPage(msg: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    messageListeners[0]({ type: 'evr-dapp-approve-result', ...msg }, APPROVAL_PAGE_SENDER, resolve);
  });
}

/** Park a deferred request the way deferToApproval does (session storage). */
function parkPending(id: string, tabId: number, origin: string): void {
  sessionData.set(`dappPending:${id}`, { id, tabId, origin, method: 'connect' });
}

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeStub);
  await import('./index');
  // The worker registers exactly one onMessage listener.
  expect(messageListeners).toHaveLength(1);
});

beforeEach(() => {
  localData.clear();
  sessionData.clear();
  tabsGet.mockReset();
  tabsSendMessage.mockReset();
  tabsSendMessage.mockResolvedValue(undefined);
  windowsCreate.mockReset();
  windowsCreate.mockResolvedValue({ id: 99 });
  windowsGet.mockReset();
  windowsGet.mockResolvedValue({ id: 3, left: 100, top: 50, width: 1200, height: 800, state: 'normal' });
  runtimeGetContexts.mockReset();
  runtimeGetContexts.mockResolvedValue([]);
  runtimeSendMessage.mockReset();
  runtimeSendMessage.mockResolvedValue(undefined);
  sidePanelOpen.mockReset();
  sidePanelOpen.mockResolvedValue(undefined);
});

/** Flip the cached window mode the way Settings does: write + storage.onChanged. */
async function setSidePanelMode(on: boolean): Promise<void> {
  localData.set('ui:sidePanel', on);
  for (const fn of storageChangedListeners) fn({ 'ui:sidePanel': { newValue: on } }, 'local');
  await new Promise((r) => setTimeout(r, 0));
}

/** A wallet page claims an offered request (its own runtime message). */
function claimFromWalletPage(id: string, sender: { url?: string } = { url: 'chrome-extension://test-ext/index.html' }): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    messageListeners[0]({ type: 'evr-dapp-host-claim', id }, sender, (r?: unknown) => resolve(r as Record<string, unknown>));
  });
}

/** Drive the captured listener as the CONTENT SCRIPT of a page would. */
function requestFromPage(
  msg: Record<string, unknown>,
  sender: Record<string, unknown> = { tab: { id: 7, windowId: 3 }, url: 'https://satorisignals.app/forecasts' },
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    messageListeners[0](
      { type: 'evr-dapp', ...msg },
      sender as { url?: string },
      (r?: unknown) => resolve(r as Record<string, unknown>),
    );
  });
}

describe('deferred result delivery re-checks the tab', () => {
  it('delivers to the tab (echoing the requesting origin) while it still hosts that origin', async () => {
    parkPending('req-1', 7, 'https://dapp.example');
    tabsGet.mockResolvedValue({ url: 'https://dapp.example/checkout?step=2' });

    await settleFromApprovalPage({ id: 'req-1', result: { address: 'Eaddr' } });

    expect(tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(tabsSendMessage).toHaveBeenCalledWith(7, {
      type: 'evr-dapp-result',
      id: 'req-1',
      // The echoed origin is what lets content.js refuse cross-origin relay.
      origin: 'https://dapp.example',
      result: { address: 'Eaddr' },
      error: undefined,
    });
  });

  it('drops the result when the tab navigated to a DIFFERENT origin, and consumes the pending entry', async () => {
    parkPending('req-2', 7, 'https://dapp.example');
    tabsGet.mockResolvedValue({ url: 'https://evil.example/landing' });

    await settleFromApprovalPage({ id: 'req-2', result: { address: 'Eaddr' } });

    expect(tabsSendMessage).not.toHaveBeenCalled();
    // The request is settled (taken from session storage), so the result
    // cannot be re-delivered later either.
    expect(sessionData.has('dappPending:req-2')).toBe(false);
  });

  it('drops the result when the tab no longer exists', async () => {
    parkPending('req-3', 7, 'https://dapp.example');
    tabsGet.mockRejectedValue(new Error('No tab with id: 7.'));

    await settleFromApprovalPage({ id: 'req-3', error: 'user-rejected' });

    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it('still delivers when the tab URL is unreadable (no "tabs" permission) — content.js is the authority then', async () => {
    parkPending('req-4', 9, 'https://dapp.example');
    // tabs.get succeeds but exposes no url: the extension lacks host access to
    // whatever the tab shows. Failing closed here would break delivery to every
    // ordinary dApp, so the worker sends and content.js gates on the echoed
    // origin plus its own deferred-id set.
    tabsGet.mockResolvedValue({});

    await settleFromApprovalPage({ id: 'req-4', result: { txid: 'ab'.repeat(32) } });

    expect(tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(tabsSendMessage.mock.calls[0][1]).toMatchObject({
      id: 'req-4',
      origin: 'https://dapp.example',
    });
  });

  it('does nothing for an id that was never parked (double-send guard still first)', async () => {
    await settleFromApprovalPage({ id: 'never-parked', result: { address: 'Eaddr' } });

    expect(tabsGet).not.toHaveBeenCalled();
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });
});

// --- the connection binding written on approval (bindOriginToWallet) ---------
//
// getStorage() namespaces chrome.storage.local keys with 'evrdemo:'.
const WALLETS = 'evrdemo:liveWallets';
const APPROVALS = 'evrdemo:dappApprovedOrigins';
const EVR_1 = 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU';
const EVR_2 = 'EMc6Wq7hT5kX2vZyQ8cRnJ3pL9sB4dF1aG';
const BTC = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const ORIGIN = 'https://satorisignals.app';

function wallets(activeId: string) {
  localData.set(WALLETS, {
    version: 1,
    activeId,
    wallets: [
      { id: 'w-1', name: 'Wallet 1', address: EVR_1, network: 'mainnet' },
      { id: 'w-2', name: 'Second Wallet', address: EVR_2, network: 'mainnet' },
      { id: 'w-1-btc', name: 'Wallet 1 (Bitcoin)', address: BTC, network: 'bitcoin-mainnet' },
      { id: 'w-eth', name: 'Wallet 1 (Ethereum)', address: '0xabc', network: 'ethereum', family: 'evm' },
    ],
  });
}

describe('an approved connect binds the origin to the PICKED wallet', () => {
  it('binds to the wallet the approval names, not to the active one', async () => {
    wallets('w-1-btc'); // Bitcoin is what the wallet UI shows
    parkPending('req-b1', 7, ORIGIN);
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/forecasts` });
    await settleFromApprovalPage({ id: 'req-b1', result: { address: EVR_2 }, approveOrigin: ORIGIN, walletId: 'w-2' });
    expect(localData.get(APPROVALS)).toEqual([{ origin: ORIGIN, walletId: 'w-2' }]);
    // The result still reaches the page.
    expect(tabsSendMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses to bind a NON-Evrmore wallet (Bitcoin, EVM), and the site is left unconnected', async () => {
    wallets('w-1-btc');
    parkPending('req-b2', 7, ORIGIN);
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    await settleFromApprovalPage({ id: 'req-b2', result: { address: BTC }, approveOrigin: ORIGIN, walletId: 'w-1-btc' });
    expect(localData.get(APPROVALS)).toBeUndefined();
    parkPending('req-b3', 7, ORIGIN);
    await settleFromApprovalPage({ id: 'req-b3', result: { address: '0xabc' }, approveOrigin: ORIGIN, walletId: 'w-eth' });
    expect(localData.get(APPROVALS)).toBeUndefined();
  });

  it('an id that names no wallet binds nothing (fails closed)', async () => {
    wallets('w-1');
    parkPending('req-b4', 7, ORIGIN);
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    await settleFromApprovalPage({ id: 'req-b4', result: { address: EVR_1 }, approveOrigin: ORIGIN, walletId: 'nope' });
    expect(localData.get(APPROVALS)).toBeUndefined();
  });

  it('without a walletId (an older approval page) uses the active wallet ONLY when that is an Evrmore wallet', async () => {
    wallets('w-1');
    parkPending('req-b5', 7, ORIGIN);
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    await settleFromApprovalPage({ id: 'req-b5', result: { address: EVR_1 }, approveOrigin: ORIGIN });
    expect(localData.get(APPROVALS)).toEqual([{ origin: ORIGIN, walletId: 'w-1' }]);

    localData.delete(APPROVALS);
    wallets('w-1-btc');
    parkPending('req-b6', 7, ORIGIN);
    await settleFromApprovalPage({ id: 'req-b6', result: { address: BTC }, approveOrigin: ORIGIN });
    expect(localData.get(APPROVALS)).toBeUndefined();
  });

  it('REPLACES an earlier binding for the origin: a site is connected to one wallet at a time', async () => {
    wallets('w-1');
    localData.set(APPROVALS, [{ origin: ORIGIN, walletId: 'w-1' }, { origin: 'https://other.example', walletId: 'w-1' }]);
    parkPending('req-b7', 7, ORIGIN);
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    await settleFromApprovalPage({ id: 'req-b7', result: { address: EVR_2 }, approveOrigin: ORIGIN, walletId: 'w-2' });
    expect(localData.get(APPROVALS)).toEqual([
      { origin: 'https://other.example', walletId: 'w-1' },
      { origin: ORIGIN, walletId: 'w-2' },
    ]);
  });

  it('a rejection binds nothing even when the message carries approveOrigin', async () => {
    wallets('w-1');
    parkPending('req-b8', 7, ORIGIN);
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    await settleFromApprovalPage({ id: 'req-b8', error: 'user-rejected', approveOrigin: ORIGIN, walletId: 'w-1' });
    expect(localData.get(APPROVALS)).toBeUndefined();
  });
});

describe('connect() on an already-connected site', () => {
  it('with ONE Evrmore wallet answers at once, no window', async () => {
    localData.set(WALLETS, {
      version: 1,
      activeId: 'w-1-btc',
      wallets: [
        { id: 'w-1', name: 'Wallet 1', address: EVR_1, network: 'mainnet' },
        { id: 'w-1-btc', name: 'Wallet 1 (Bitcoin)', address: BTC, network: 'bitcoin-mainnet' },
      ],
    });
    localData.set(APPROVALS, [{ origin: ORIGIN, walletId: 'w-1' }]);
    const r = await requestFromPage({ id: 'c-1', method: 'connect', origin: ORIGIN });
    expect(r).toEqual({ result: { address: EVR_1 } });
    expect(windowsCreate).not.toHaveBeenCalled();
  });

  it('with SEVERAL Evrmore wallets re-opens the approval, naming the connected wallet for preselection', async () => {
    wallets('w-1');
    localData.set(APPROVALS, [{ origin: ORIGIN, walletId: 'w-1' }]);
    const r = await requestFromPage({ id: 'c-2', method: 'connect', origin: ORIGIN });
    expect(r).toEqual({ deferred: true });
    expect(windowsCreate).toHaveBeenCalledTimes(1);
    const parked = sessionData.get('dappPending:c-2') as Record<string, unknown>;
    expect(parked).toMatchObject({ id: 'c-2', tabId: 7, origin: ORIGIN, method: 'connect', walletId: 'w-1' });
    expect(typeof parked.createdAt).toBe('number');
  });

  it('getAddress() never prompts: a session restore stays silent', async () => {
    wallets('w-1');
    localData.set(APPROVALS, [{ origin: ORIGIN, walletId: 'w-2' }]);
    const r = await requestFromPage({ id: 'c-3', method: 'getAddress', origin: ORIGIN });
    expect(r).toEqual({ result: EVR_2 });
    expect(windowsCreate).not.toHaveBeenCalled();
  });
});

describe('the approval popup', () => {
  it('opens at the TOP-RIGHT of the window the request came from, 400x620', async () => {
    wallets('w-1');
    const r = await requestFromPage({ id: 'p-1', method: 'connect', origin: ORIGIN });
    expect(r).toEqual({ deferred: true });
    expect(windowsGet).toHaveBeenCalledWith(3);
    expect(windowsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'popup',
        width: 400,
        height: 620,
        left: 100 + 1200 - 400 - 8,
        top: 50 + 8,
      }),
    );
  });

  it('passes no position when the window geometry is unusable, so Chrome places it as before', async () => {
    wallets('w-1');
    windowsGet.mockResolvedValue({ id: 3, state: 'minimized', left: 0, top: 0, width: 1200 });
    await requestFromPage({ id: 'p-2', method: 'connect', origin: ORIGIN });
    const arg = windowsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('left');
    expect(arg).not.toHaveProperty('top');
  });

  it('a request with no tab is refused before any window opens', async () => {
    wallets('w-1');
    const r = await requestFromPage({ id: 'p-3', method: 'connect', origin: ORIGIN }, { url: ORIGIN });
    expect(r).toEqual({ error: 'no-tab' });
    expect(windowsCreate).not.toHaveBeenCalled();
  });
});

describe('a parked request that never got an answer', () => {
  /** The approval page for `id` is on screen: it answers the worker's ping. */
  function approvalOnScreen(id: string) {
    runtimeSendMessage.mockImplementation(async (m: { type?: string; id?: string }) =>
      m?.type === 'evr-dapp-ping' && m.id === id ? { alive: true } : undefined,
    );
  }

  it('blocks a second request from the origin while its approval is ON SCREEN (one approval per site)', async () => {
    wallets('w-1');
    localData.set(APPROVALS, [{ origin: ORIGIN, walletId: 'w-1' }]); // sign needs a connected site
    sessionData.set('dappPending:old-1', { id: 'old-1', tabId: 7, origin: ORIGIN, method: 'signMessage', createdAt: Date.now() - 60_000 });
    approvalOnScreen('old-1');
    const r = await requestFromPage({ id: 't-1', method: 'signMessage', origin: ORIGIN });
    expect(r).toEqual({ error: 'approval-already-open' });
    expect(windowsCreate).not.toHaveBeenCalled();
    expect(sessionData.has('dappPending:old-1')).toBe(true);
  });

  it('when the approval is GONE (wallet closed without deciding), rejects the old request to its tab and lets the new one through', async () => {
    // The owner's case: sign requested, wallet window closed, sign requested
    // again -> used to be approval-already-open ("Could not reach the wallet").
    wallets('w-1');
    localData.set(APPROVALS, [{ origin: ORIGIN, walletId: 'w-1' }]);
    sessionData.set('dappPending:old-2', { id: 'old-2', tabId: 7, origin: ORIGIN, method: 'signMessage', createdAt: Date.now() - 60_000 });
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/forecasts` });
    // Nobody answers the ping (runtimeSendMessage resolves undefined).
    const r = await requestFromPage({ id: 't-2', method: 'signMessage', origin: ORIGIN, params: { message: 'm' } });
    expect(r).toEqual({ deferred: true });
    expect(sessionData.has('dappPending:old-2')).toBe(false);
    expect(sessionData.has('dappPending:t-2')).toBe(true);
    expect(tabsSendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'evr-dapp-result', id: 'old-2', error: 'user-rejected' }));
    expect(windowsCreate).toHaveBeenCalledTimes(1);
  });

  it('gives a just-opened approval a moment to boot before judging it gone', async () => {
    wallets('w-1');
    sessionData.set('dappPending:old-3', { id: 'old-3', tabId: 7, origin: ORIGIN, method: 'connect', createdAt: Date.now() - 200 });
    const r = await requestFromPage({ id: 't-3', method: 'connect', origin: ORIGIN });
    expect(r).toEqual({ error: 'approval-already-open' });
    expect(runtimeSendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'evr-dapp-ping' }));
  });

  it('is swept after 15 minutes regardless', async () => {
    wallets('w-1');
    sessionData.set('dappPending:old-4', { id: 'old-4', tabId: 7, origin: ORIGIN, method: 'connect', createdAt: Date.now() - 16 * 60_000 });
    approvalOnScreen('old-4');
    const r = await requestFromPage({ id: 't-4', method: 'connect', origin: ORIGIN });
    expect(r).toEqual({ deferred: true });
    expect(sessionData.has('dappPending:old-4')).toBe(false);
  });

  it('an entry without createdAt (written before the field existed) is judged by the ping like any other', async () => {
    wallets('w-1');
    sessionData.set('dappPending:old-5', { id: 'old-5', tabId: 7, origin: ORIGIN, method: 'connect' });
    approvalOnScreen('old-5');
    expect(await requestFromPage({ id: 't-5', method: 'connect', origin: ORIGIN })).toEqual({ error: 'approval-already-open' });
  });
});

describe('closing the approval popup without deciding', () => {
  it('remembers the popup window, and its removal rejects the request to the site', async () => {
    wallets('w-1');
    windowsCreate.mockResolvedValue({ id: 4242 });
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    expect(await requestFromPage({ id: 'w-1x', method: 'connect', origin: ORIGIN })).toEqual({ deferred: true });
    expect((sessionData.get('dappPending:w-1x') as Record<string, unknown>).popupWindowId).toBe(4242);
    expect(windowRemovedListeners).toHaveLength(1);
    windowRemovedListeners[0](4242);
    await vi.waitFor(() => expect(sessionData.has('dappPending:w-1x')).toBe(false));
    expect(tabsSendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ id: 'w-1x', error: 'user-rejected' }));
  });

  it('ignores the removal of an unrelated window, and a popup closed AFTER deciding delivers nothing twice', async () => {
    wallets('w-1');
    windowsCreate.mockResolvedValue({ id: 5151 });
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    await requestFromPage({ id: 'w-2x', method: 'connect', origin: ORIGIN });
    windowRemovedListeners[0](999);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionData.has('dappPending:w-2x')).toBe(true);
    // The user decides; the page settles, then closes its window.
    await settleFromApprovalPage({ id: 'w-2x', result: { address: EVR_1 }, approveOrigin: ORIGIN, walletId: 'w-1' });
    tabsSendMessage.mockClear();
    windowRemovedListeners[0](5151);
    await new Promise((r) => setTimeout(r, 20));
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });
});

describe('hosting the approval in an open wallet window', () => {
  const PANEL = 'chrome-extension://test-ext/index.html?panel=1';
  const TAB = 'chrome-extension://test-ext/index.html';

  it('offers the request to the open wallet windows, preferring the side panel, and accepts ONE claim: no popup', async () => {
    wallets('w-1');
    runtimeGetContexts.mockResolvedValue([
      { contextType: 'TAB', documentUrl: TAB },
      { contextType: 'SIDE_PANEL', documentUrl: PANEL },
      { contextType: 'TAB', documentUrl: `${TAB}?dapp=other` }, // an approval window never hosts
    ]);
    // When the offer goes out, two wallet pages claim it.
    let claims: Promise<Record<string, unknown>>[] = [];
    runtimeSendMessage.mockImplementation(async (m: { type?: string; id?: string }) => {
      if (m?.type === 'evr-dapp-host-offer' && m.id) claims = [claimFromWalletPage(m.id), claimFromWalletPage(m.id)];
      return undefined;
    });
    const r = await requestFromPage({ id: 'h-1', method: 'connect', origin: ORIGIN });
    expect(r).toEqual({ deferred: true });
    expect(runtimeSendMessage).toHaveBeenCalledWith({ type: 'evr-dapp-host-offer', id: 'h-1', hostUrl: PANEL });
    expect(await Promise.all(claims)).toEqual([{ accepted: true }, { accepted: false }]);
    expect(windowsCreate).not.toHaveBeenCalled();
    expect(sessionData.has('dappPending:h-1')).toBe(true);
  });

  it('falls back to the popup when no wallet window claims in time', async () => {
    wallets('w-1');
    runtimeGetContexts.mockResolvedValue([{ contextType: 'TAB', documentUrl: TAB }]);
    const r = await requestFromPage({ id: 'h-2', method: 'connect', origin: ORIGIN });
    expect(r).toEqual({ deferred: true });
    expect(windowsCreate).toHaveBeenCalledTimes(1);
    // A late claim is refused: the popup already owns the request.
    expect(await claimFromWalletPage('h-2')).toEqual({ accepted: false });
  });

  it('with no wallet window open goes straight to the popup without an offer', async () => {
    wallets('w-1');
    await requestFromPage({ id: 'h-3', method: 'connect', origin: ORIGIN });
    expect(runtimeSendMessage).not.toHaveBeenCalled();
    expect(windowsCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses a claim from anything that is not an extension page, and a claim for nothing on offer', async () => {
    expect(await claimFromWalletPage('h-9', { url: 'https://evil.example/' })).toEqual({ accepted: false });
    expect(await claimFromWalletPage('never-offered')).toEqual({ accepted: false });
  });
});

describe('the approval page holds a port open while it is on screen', () => {
  it('when the port goes away with the request undecided, the request is rejected to the site', async () => {
    wallets('w-1');
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    expect(await requestFromPage({ id: 'pt-1', method: 'connect', origin: ORIGIN })).toEqual({ deferred: true });
    const port = fakePort('evr-dapp-approval:pt-1');
    expect(connectListeners).toHaveLength(1);
    connectListeners[0](port);
    expect(port.disconnect).not.toHaveBeenCalled();
    port.fire(); // the wallet window was closed
    await vi.waitFor(() => expect(sessionData.has('dappPending:pt-1')).toBe(false), { timeout: 2000 });
    expect(tabsSendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ id: 'pt-1', error: 'user-rejected' }));
  });

  it('a page that reconnects within the grace (a worker restart it recovered from) is NOT judged gone', async () => {
    wallets('w-1');
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    await requestFromPage({ id: 'pt-2', method: 'connect', origin: ORIGIN });
    const first = fakePort('evr-dapp-approval:pt-2');
    connectListeners[0](first);
    first.fire();
    connectListeners[0](fakePort('evr-dapp-approval:pt-2')); // reconnect at once
    await new Promise((r) => setTimeout(r, 500));
    expect(sessionData.has('dappPending:pt-2')).toBe(true);
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it('a port going away AFTER the request was decided changes nothing', async () => {
    wallets('w-1');
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    await requestFromPage({ id: 'pt-3', method: 'connect', origin: ORIGIN });
    const port = fakePort('evr-dapp-approval:pt-3');
    connectListeners[0](port);
    await settleFromApprovalPage({ id: 'pt-3', result: { address: EVR_1 }, approveOrigin: ORIGIN, walletId: 'w-1' });
    tabsSendMessage.mockClear();
    port.fire();
    await new Promise((r) => setTimeout(r, 500));
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it('refuses a port from anything that is not an extension page', async () => {
    const port = fakePort('evr-dapp-approval:pt-4', 'https://evil.example/');
    connectListeners[0](port);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it('the liveness ping gives up after a second rather than waiting on a page that never answers', async () => {
    wallets('w-1');
    localData.set(APPROVALS, [{ origin: ORIGIN, walletId: 'w-1' }]);
    sessionData.set('dappPending:hang-1', { id: 'hang-1', tabId: 7, origin: ORIGIN, method: 'signMessage', createdAt: Date.now() - 60_000 });
    tabsGet.mockResolvedValue({ id: 7, url: `${ORIGIN}/` });
    runtimeSendMessage.mockImplementation((m: { type?: string }) =>
      m?.type === 'evr-dapp-ping' ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    const started = Date.now();
    const r = await requestFromPage({ id: 'hang-2', method: 'signMessage', origin: ORIGIN, params: { message: 'm' } });
    expect(r).toEqual({ deferred: true });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(sessionData.has('dappPending:hang-1')).toBe(false);
  });
});

describe('side panel mode: a site request opens the wallet in the side panel', () => {
  const PANEL = 'chrome-extension://test-ext/index.html?panel=1';

  it('opens the panel for the requesting tab SYNCHRONOUSLY on connect, then hosts the approval there once it boots', async () => {
    await setSidePanelMode(true);
    wallets('w-1');
    // The panel is not there yet on the first look, then it is and it claims.
    let looks = 0;
    runtimeGetContexts.mockImplementation(async () => (++looks < 3 ? [] : [{ contextType: 'SIDE_PANEL', documentUrl: PANEL }]));
    runtimeSendMessage.mockImplementation(async (m: { type?: string; id?: string }) => {
      if (m?.type === 'evr-dapp-host-offer' && m.id) void claimFromWalletPage(m.id, { url: PANEL });
      return undefined;
    });
    const r = await requestFromPage({ id: 'sp-1', method: 'connect', origin: ORIGIN });
    expect(r).toEqual({ deferred: true });
    expect(sidePanelOpen).toHaveBeenCalledWith({ tabId: 7 });
    expect(windowsCreate).not.toHaveBeenCalled();
    expect(sessionData.has('dappPending:sp-1')).toBe(true);
  });

  it('falls back to the popup at once when open() is refused (no user gesture)', async () => {
    await setSidePanelMode(true);
    wallets('w-1');
    sidePanelOpen.mockRejectedValue(new Error('`sidePanel.open()` may only be called in response to a user gesture.'));
    const started = Date.now();
    const r = await requestFromPage({ id: 'sp-2', method: 'connect', origin: ORIGIN });
    expect(r).toEqual({ deferred: true });
    expect(windowsCreate).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('never opens the panel for the silent reads, nor in popup mode', async () => {
    await setSidePanelMode(true);
    wallets('w-1');
    localData.set(APPROVALS, [{ origin: ORIGIN, walletId: 'w-1' }]);
    await requestFromPage({ id: 'sp-3', method: 'getAddress', origin: ORIGIN });
    await requestFromPage({ id: 'sp-4', method: 'getBalances', origin: ORIGIN }).catch(() => undefined);
    expect(sidePanelOpen).not.toHaveBeenCalled();
    await setSidePanelMode(false);
    await requestFromPage({ id: 'sp-5', method: 'signMessage', origin: ORIGIN, params: { message: 'm' } });
    expect(sidePanelOpen).not.toHaveBeenCalled();
    expect(windowsCreate).toHaveBeenCalledTimes(1);
  });

  it('a sign request opens the panel too, and a panel that never claims still ends in the popup', async () => {
    await setSidePanelMode(true);
    wallets('w-1');
    localData.set(APPROVALS, [{ origin: ORIGIN, walletId: 'w-1' }]);
    runtimeGetContexts.mockResolvedValue([{ contextType: 'SIDE_PANEL', documentUrl: PANEL }]);
    const r = await requestFromPage({ id: 'sp-6', method: 'signMessage', origin: ORIGIN, params: { message: 'm' } });
    expect(r).toEqual({ deferred: true });
    expect(sidePanelOpen).toHaveBeenCalledTimes(1);
    expect(windowsCreate).toHaveBeenCalledTimes(1);
  }, 15_000);
});
