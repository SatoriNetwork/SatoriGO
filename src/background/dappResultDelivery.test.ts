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

// Only the chrome surface background/index.ts touches on import + this path.
// alarms/notifications/windows are ABSENT on purpose: the worker guards them
// (typeof checks / optional chaining), and this suite never defers a request.
const chromeStub = {
  runtime: {
    getURL: (p: string) => `chrome-extension://test-ext/${p}`,
    onMessage: {
      addListener: (fn: MessageListener) => {
        messageListeners.push(fn);
      },
    },
    onInstalled: { addListener: () => undefined },
  },
  storage: {
    local: storageArea(localData),
    session: storageArea(sessionData),
  },
  tabs: { get: tabsGet, sendMessage: tabsSendMessage },
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
});

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
