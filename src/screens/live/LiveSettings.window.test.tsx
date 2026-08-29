/**
 * @vitest-environment jsdom
 *
 * Settings > Appearance > Window.
 *
 * The side panel is the DEFAULT window mode (owner's request 2026-08-28), so
 * this row is the only way back to the toolbar popup: it must be reachable in
 * BASIC mode, it must read "on" on a fresh Chrome/Edge install where nothing is
 * stored yet, and turning it off must persist an explicit false (the value that
 * stops the default from taking the panel back on the next worker boot).
 *
 * Prices are stubbed because init() fires them and forgets.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/prices', () => ({ fetchPrices: async () => ({}) }));

import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import { NavProvider } from './LiveNav';
import { POPUP_PATH, SIDE_PANEL_PREF_KEY } from '../../services/sidePanel';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

type G = { chrome?: unknown };
type LiveStoreModule = typeof import('../../store/liveStore');
let storeMod: LiveStoreModule;
let LiveSettings: (typeof import('./LiveSettings'))['LiveSettings'];
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = {
  tab: 'assets' as const,
  section: 'settings' as const,
  openTab: () => {},
  openSettings: () => {},
};

/** Chrome / Edge: the side-panel API is there, so the default is the panel. */
function installChrome(stored: Record<string, unknown> = {}) {
  const calls: string[] = [];
  (globalThis as G).chrome = {
    sidePanel: {
      setOptions: vi.fn(async (o: { path?: string; enabled?: boolean }) => {
        calls.push(`setOptions:${JSON.stringify(o)}`);
      }),
      setPanelBehavior: vi.fn(async (b: { openPanelOnActionClick: boolean }) => {
        calls.push(`behavior:${b.openPanelOnActionClick}`);
      }),
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
  return { calls, stored };
}

/** A browser with neither a side panel nor a sidebar: popup only. */
function installPopupOnlyBrowser() {
  (globalThis as G).chrome = {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  };
}

function openWindowSection(mode: 'basic' | 'expert' = 'basic') {
  state().setSettingsMode(mode);
  render(
    <NavProvider value={NAV_VALUE}>
      <LiveSettings onBack={() => {}} onOpenAddressBook={() => {}} />
    </NavProvider>,
  );
  fireEvent.click(screen.getByTestId('live-settings-row-appearance'));
}

const toggle = () => screen.getByTestId('live-side-panel-toggle');

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  LiveSettings = (await import('./LiveSettings')).LiveSettings;
});

beforeEach(async () => {
  setStorageForTests(new MemoryStorageAdapter());
  await state().resetLiveWallet();
  await state().init();
});

afterEach(() => {
  state().stopAutoRefresh();
  delete (globalThis as G).chrome;
  cleanup();
});

describe('Settings > Appearance > Window (side panel by default)', () => {
  it('a fresh Chrome install reads as the side panel, and the row is there in BASIC mode', async () => {
    installChrome();
    openWindowSection('basic');

    expect(screen.getByTestId('live-side-panel-row')).toBeTruthy();
    expect(screen.queryByTestId('live-side-panel-unsupported')).toBeNull();
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    expect((toggle() as HTMLButtonElement).disabled).toBe(false);
  }, 30_000);

  it('turning it off stores an explicit false and puts the popup back', async () => {
    const { calls, stored } = installChrome();
    openWindowSection('basic');
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(toggle());

    await waitFor(() => expect(stored[SIDE_PANEL_PREF_KEY]).toBe(false));
    expect(calls).toContain(`popup:${POPUP_PATH}`);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('live-side-panel-note').textContent).toContain('popup');
  }, 30_000);

  it('a stored false survives: the row opens off, and switching back stores true', async () => {
    const { calls, stored } = installChrome({ [SIDE_PANEL_PREF_KEY]: false });
    openWindowSection('expert');
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));

    fireEvent.click(toggle());

    await waitFor(() => expect(stored[SIDE_PANEL_PREF_KEY]).toBe(true));
    expect(calls).toContain('popup:');
    expect(screen.getByTestId('live-side-panel-note').textContent).toContain('side panel');
  }, 30_000);

  it('a browser with no docking API says so and stays on the popup, with the toggle off and disabled', async () => {
    installPopupOnlyBrowser();
    openWindowSection('basic');

    await waitFor(() => expect(screen.getByTestId('live-side-panel-unsupported')).toBeTruthy());
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  }, 30_000);
});
