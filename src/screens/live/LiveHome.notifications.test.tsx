/**
 * @vitest-environment jsdom
 *
 * The owner-authored notification banner on Home (LiveHome).
 *
 * What these pin:
 *   - the banner renders under the Block / Synced row, above the coin mark (live-hero-mark), not in the
 *     hero flow, when a notice matches this chain + version;
 *   - a chain-targeted notice for another chain is filtered out;
 *   - an empty list renders no banner and no empty box;
 *   - Home hands the banner the WHOLE matching set (the banner rotates through
 *     it itself), so the rotation counter shows how many apply;
 *   - dismissing a notice persists its `id@rev` key and reveals the next match;
 *   - bumping a notice's rev (the owner resubmitting it) brings it back, and a
 *     legacy bare id in storage still hides revision 0 after the migration;
 *   - a NON-GATEWAY build (the test default) makes no network request when the
 *     store is asked to load notifications.
 *
 * Real store, prices stubbed inert (same as the other LiveHome tests). No
 * network is touched: HAS_GATEWAY is false in tests, so loadNotifications is a
 * no-op and the list is seeded directly via setState.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({ changes24h: {}, fetchedAt: 0 }),
  parseCoinexTicker: () => undefined,
}));

import { MemoryStorageAdapter, setStorageForTests, type KeyValueStorage } from '../../services/storage';
import type { NotificationItem } from '../../services/notifications';
import { NavProvider } from './LiveNav';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const NOTIF_DISMISSED_KEY = 'notif.dismissed.v1';

type LiveStoreModule = typeof import('../../store/liveStore');
type LiveHomeModule = typeof import('./LiveHome');
let storeMod: LiveStoreModule;
let LiveHome: LiveHomeModule['LiveHome'];
let storage: KeyValueStorage;
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = { tab: 'assets' as const, section: 'home' as const, openTab: () => {}, openSettings: () => {} };
function renderHome() {
  return render(
    <NavProvider value={NAV_VALUE}>
      <LiveHome onReceive={() => {}} onSend={() => {}} onSelectAsset={() => {}} onSelectTx={() => {}} />
    </NavProvider>,
  );
}

function notif(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    rev: 0,
    title: 'Title',
    body: 'Body',
    severity: 'info',
    link: null,
    dismissible: true,
    image: null,
    target: { chains: null, minVersion: null, maxVersion: null },
    ...over,
  };
}

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  LiveHome = (await import('./LiveHome')).LiveHome;
});

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  await state().resetLiveWallet();
  await state().init();
});

afterEach(() => {
  state().stopAutoRefresh();
  cleanup();
});

describe('LiveHome notification banner', () => {
  it('renders the matching notice under the Block / Synced row, above the coin mark', () => {
    storeMod.useLiveStore.setState({
      notifications: [notif({ id: 'welcome', title: 'Welcome', severity: 'update' })],
    });
    renderHome();

    const banner = screen.getByTestId('live-notification');
    const status = screen.getByTestId('live-home-status');
    const mark = screen.getByTestId('live-hero-mark');
    expect(banner).toHaveAttribute('data-severity', 'update');
    // Owner's placement (2026-08-25): right under the status row, NOT inside the
    // hero. It comes AFTER the Block / Synced row and BEFORE the coin mark.
    expect(banner.parentElement?.classList.contains('hero')).toBe(false);
    expect(status.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('filters a notice targeted at another chain (EVR wallet, RVN-only notice)', () => {
    storeMod.useLiveStore.setState({
      notifications: [
        notif({ id: 'rvn', target: { chains: ['RVN'], minVersion: null, maxVersion: null } }),
        notif({ id: 'evr', title: 'For EVR', target: { chains: ['EVR'], minVersion: null, maxVersion: null } }),
      ],
    });
    renderHome();
    expect(screen.getByTestId('live-notification-title')).toHaveTextContent('For EVR');
  });

  it('renders no banner (and no empty box) when the list is empty', () => {
    storeMod.useLiveStore.setState({ notifications: [] });
    renderHome();
    expect(screen.queryByTestId('live-notification')).toBeNull();
    // The coin mark is still there — the hero did not reserve space for a banner.
    expect(screen.getByTestId('live-hero-mark')).toBeInTheDocument();
  });

  it('hands the banner every matching notice, so it can rotate through them', () => {
    storeMod.useLiveStore.setState({
      notifications: [
        notif({ id: 'a', title: 'First' }),
        notif({ id: 'b', title: 'Second', target: { chains: ['RVN'], minVersion: null, maxVersion: null } }),
        notif({ id: 'c', title: 'Third' }),
      ],
    });
    renderHome();
    // Two of the three apply to this EVR wallet, and the first is on screen.
    expect(screen.getByTestId('live-notification-title')).toHaveTextContent('First');
    const count = screen.getByTestId('live-notification-count');
    expect(count).toHaveAttribute('data-index', '0');
    expect(count).toHaveAttribute('data-total', '2');
  });

  it('shows no rotation counter when only one notice applies', () => {
    storeMod.useLiveStore.setState({ notifications: [notif({ id: 'a', title: 'Alone' })] });
    renderHome();
    expect(screen.queryByTestId('live-notification-count')).toBeNull();
  });

  it('dismissing a notice persists the id and shows the next match', async () => {
    storeMod.useLiveStore.setState({
      notifications: [
        notif({ id: 'a', title: 'First' }),
        notif({ id: 'b', title: 'Second' }),
      ],
    });
    renderHome();

    expect(screen.getByTestId('live-notification-title')).toHaveTextContent('First');
    fireEvent.click(screen.getByTestId('live-notification-dismiss'));

    // The next match takes its place.
    await waitFor(() => {
      expect(screen.getByTestId('live-notification-title')).toHaveTextContent('Second');
    });
    // ...and the dismissal is persisted, keyed by id@rev.
    expect(state().dismissedNotificationKeys).toContain('a@0');
    expect(await storage.get<string[]>(NOTIF_DISMISSED_KEY)).toEqual(['a@0']);
  });

  it('a notice the owner RESUBMITS (a bumped rev) comes back after being dismissed', async () => {
    storeMod.useLiveStore.setState({ notifications: [notif({ id: 'a', title: 'First run' })] });
    const { unmount } = renderHome();
    fireEvent.click(screen.getByTestId('live-notification-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('live-notification')).toBeNull());
    unmount();

    // The gateway now serves the same notice at revision 1.
    storeMod.useLiveStore.setState({
      notifications: [notif({ id: 'a', rev: 1, title: 'Resubmitted' })],
    });
    renderHome();
    expect(screen.getByTestId('live-notification-title')).toHaveTextContent('Resubmitted');
    // Closing it again hides that revision too.
    fireEvent.click(screen.getByTestId('live-notification-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('live-notification')).toBeNull());
    expect(state().dismissedNotificationKeys).toEqual(['a@0', 'a@1']);
  });

  it('a LEGACY bare id in storage still hides revision 0, but not revision 1', async () => {
    // What a build from before revisions wrote.
    await storage.set(NOTIF_DISMISSED_KEY, ['a']);
    await state().init();
    // Migrated on read, so nothing the user closed comes back on upgrade.
    expect(state().dismissedNotificationKeys).toEqual(['a@0']);

    storeMod.useLiveStore.setState({ notifications: [notif({ id: 'a', title: 'Old' })] });
    const { unmount } = renderHome();
    expect(screen.queryByTestId('live-notification')).toBeNull();
    unmount();

    storeMod.useLiveStore.setState({ notifications: [notif({ id: 'a', rev: 1, title: 'Resubmitted' })] });
    renderHome();
    expect(screen.getByTestId('live-notification-title')).toHaveTextContent('Resubmitted');
  });

  it('a non-gateway build makes no request when asked to load notifications', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ notifications: [] }) }) as unknown as Response);
    vi.stubGlobal('fetch', spy);
    await state().loadNotifications();
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
