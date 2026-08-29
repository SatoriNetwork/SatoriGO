import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POPUP_PATH,
  SIDE_PANEL_PATH,
  SIDE_PANEL_PREF_KEY,
  applySidePanelPreference,
  defaultSidePanelPreference,
  handleActionClickForSidebar,
  isSidePanelWindow,
  sidePanelFlavor,
  readSidePanelPreference,
  readStoredSidePanelPreference,
  restoreSidePanelPreference,
  sidePanelSupported,
  writeSidePanelPreference,
} from './sidePanel';

type G = { chrome?: unknown };

const PANEL_ON_CALLS = [`setOptions:${JSON.stringify({ path: SIDE_PANEL_PATH, enabled: true })}`, 'behavior:true', 'popup:'];
const PANEL_OFF_CALLS = [`popup:${POPUP_PATH}`, 'behavior:false', `setOptions:${JSON.stringify({ enabled: false })}`];

function fakeChrome(stored: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const api = {
    sidePanel: {
      setOptions: vi.fn(async (o: { path?: string; enabled?: boolean }) => {
        calls.push(`setOptions:${JSON.stringify(o)}`);
      }),
      setPanelBehavior: vi.fn(async (b: { openPanelOnActionClick: boolean }) => {
        calls.push(`behavior:${b.openPanelOnActionClick}`);
      }),
      getPanelBehavior: vi.fn(async () => ({ openPanelOnActionClick: false })),
    },
    action: {
      setPopup: vi.fn(async (d: { popup: string }) => {
        calls.push(`popup:${d.popup}`);
      }),
      getPopup: vi.fn(async () => POPUP_PATH),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]]))),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(stored, items);
        }),
      },
    },
  };
  (globalThis as G).chrome = api;
  return { api, calls, stored };
}

/** Firefox: sidebarAction instead of sidePanel. */
function fakeFirefox(stored: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const api = {
    sidebarAction: {
      open: vi.fn(async () => {
        calls.push('open');
      }),
      toggle: vi.fn(async () => {
        calls.push('toggle');
      }),
      setPanel: vi.fn(async () => undefined),
    },
    action: {
      setPopup: vi.fn(async (d: { popup: string }) => {
        calls.push(`popup:${d.popup}`);
      }),
      getPopup: vi.fn(async () => POPUP_PATH),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]]))),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(stored, items);
        }),
      },
    },
  };
  (globalThis as G).chrome = api;
  return { api, calls, stored };
}

afterEach(() => {
  delete (globalThis as G).chrome;
});

describe('side panel preference (services/sidePanel.ts)', () => {
  it('1. the panel document is told apart by ?panel=1 only', () => {
    expect(isSidePanelWindow('?panel=1')).toBe(true);
    expect(isSidePanelWindow('?detached=1')).toBe(false);
    expect(isSidePanelWindow('')).toBe(false);
  });

  it('2. a browser with no docking API at all: not supported, apply is a no-op that reports false, and the default is the popup', async () => {
    const local = { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) };
    (globalThis as G).chrome = { storage: { local } };
    expect(sidePanelFlavor()).toBe('none');
    expect(sidePanelSupported()).toBe(false);
    expect(defaultSidePanelPreference()).toBe(false);
    expect(await applySidePanelPreference(true)).toBe(false);
    // Nothing stored, no API: the wallet stays the popup the manifest gives it.
    expect(await readSidePanelPreference()).toBe(false);
    local.get.mockClear();
    // The boot path bails out before it even looks at storage: no API to drive.
    await expect(restoreSidePanelPreference()).resolves.toBeUndefined();
    expect(local.get).not.toHaveBeenCalled();
  });

  it('3. ON: registers the panel page, makes the icon open it, and clears the popup LAST; OFF: restores the popup first, then the behaviour, then hides the panel', async () => {
    const { calls } = fakeChrome();
    expect(sidePanelSupported()).toBe(true);
    expect(await applySidePanelPreference(true)).toBe(true);
    expect(calls).toEqual(PANEL_ON_CALLS);
    calls.length = 0;
    expect(await applySidePanelPreference(false)).toBe(true);
    expect(calls).toEqual(PANEL_OFF_CALLS);
  });

  it('4. a browser API failure while turning ON leaves the popup in place (reported as not applied)', async () => {
    const { api, calls } = fakeChrome();
    api.sidePanel.setPanelBehavior.mockRejectedValueOnce(new Error('nope'));
    expect(await applySidePanelPreference(true)).toBe(false);
    expect(calls.some((c) => c === 'popup:')).toBe(false);
  });

  it('5. UNSET on Chrome/Edge means the side panel: nothing stored reads as on and a fresh install boots into the panel', async () => {
    const { calls, api } = fakeChrome();
    expect(defaultSidePanelPreference()).toBe(true);
    expect(await readStoredSidePanelPreference()).toBe(null);
    expect(await readSidePanelPreference()).toBe(true);
    await restoreSidePanelPreference();
    expect(calls).toEqual(PANEL_ON_CALLS);
    // The default is applied, never written: the row still reads "not chosen".
    expect(api.storage.local.set).not.toHaveBeenCalled();
    expect(await readStoredSidePanelPreference()).toBe(null);
  });

  it('6. a stored TRUE is the panel: read, write and every later boot agree', async () => {
    const { stored, calls } = fakeChrome();
    expect(await writeSidePanelPreference(true)).toBe(true);
    expect(stored[SIDE_PANEL_PREF_KEY]).toBe(true);
    expect(await readStoredSidePanelPreference()).toBe(true);
    expect(await readSidePanelPreference()).toBe(true);
    calls.length = 0;
    await restoreSidePanelPreference();
    expect(calls).toEqual(PANEL_ON_CALLS);
  });

  it('7. a stored FALSE keeps the popup across boots: the default never overrides a choice the user made', async () => {
    const { stored, calls } = fakeChrome({ [SIDE_PANEL_PREF_KEY]: false });
    expect(await readStoredSidePanelPreference()).toBe(false);
    expect(await readSidePanelPreference()).toBe(false);
    await restoreSidePanelPreference();
    // The popup is re-asserted, because an update can reload the extension with
    // the panel still registered.
    expect(calls).toEqual(PANEL_OFF_CALLS);
    calls.length = 0;
    await restoreSidePanelPreference();
    expect(calls).toEqual(PANEL_OFF_CALLS);
    expect(stored[SIDE_PANEL_PREF_KEY]).toBe(false);
  });

  it('8. unreadable or junk storage falls back to the default, not to the popup', async () => {
    const { api } = fakeChrome({ [SIDE_PANEL_PREF_KEY]: 'yes' });
    // A value that is not a boolean was never a choice this code wrote.
    expect(await readStoredSidePanelPreference()).toBe(null);
    expect(await readSidePanelPreference()).toBe(true);
    api.storage.local.get.mockRejectedValueOnce(new Error('storage gone'));
    expect(await readStoredSidePanelPreference()).toBe(null);
    api.storage.local.get.mockRejectedValueOnce(new Error('storage gone'));
    expect(await readSidePanelPreference()).toBe(true);
  });

  it('9. Firefox (sidebarAction, no sidePanel): supported as "sidebar" but the default stays the popup, so a fresh install keeps a working toolbar icon', async () => {
    const { calls } = fakeFirefox();
    expect(sidePanelFlavor()).toBe('sidebar');
    expect(sidePanelSupported()).toBe(true);
    expect(defaultSidePanelPreference()).toBe(false);
    expect(await readSidePanelPreference()).toBe(false);
    await restoreSidePanelPreference();
    expect(calls).toEqual([`popup:${POPUP_PATH}`]);
  });

  it('10. Firefox opt-in: ON clears the popup only, the toolbar click toggles the sidebar, OFF restores the popup', async () => {
    const { calls, stored } = fakeFirefox();
    expect(await writeSidePanelPreference(true)).toBe(true);
    expect(calls).toEqual(['popup:']);
    expect(stored[SIDE_PANEL_PREF_KEY]).toBe(true);
    calls.length = 0;
    await restoreSidePanelPreference();
    expect(calls).toEqual(['popup:']);
    calls.length = 0;
    expect(await handleActionClickForSidebar()).toBe(true);
    expect(calls).toEqual(['toggle']);
    calls.length = 0;
    expect(await applySidePanelPreference(false)).toBe(true);
    expect(calls).toEqual([`popup:${POPUP_PATH}`]);
  });

  it('11. Chrome never routes the toolbar click to a sidebar (the panel behaviour owns it)', async () => {
    fakeChrome();
    expect(sidePanelFlavor()).toBe('sidePanel');
    expect(await handleActionClickForSidebar()).toBe(false);
  });
});
