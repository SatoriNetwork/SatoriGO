/**
 * @vitest-environment jsdom
 *
 * The bottom nav's two pieces of live state: the unread-activity badge and the
 * warning strip for an address the server refuses to serve history for.
 *
 * The strip lives here, above the tab bar, because the bar is on every wallet
 * screen: an address the server will not serve is permanent, so the explanation
 * has to reach the user wherever they are, not only on the Activity tab.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    activeWalletId() {
      return null;
    }
    isUnlocked() {
      return false;
    }
    network() {
      return 'mainnet';
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { LiveNav, NavProvider } from './LiveNav';
import { useLiveStore } from '../../store/liveStore';

function renderNav() {
  return render(
    <NavProvider
      value={{ tab: 'assets', section: 'home', openTab: () => {}, openSettings: () => {} }}
    >
      <LiveNav />
    </NavProvider>,
  );
}

afterEach(() => {
  cleanup();
  useLiveStore.setState({ historyIssue: null, unreadActivity: 0 });
});

describe('LiveNav', () => {
  it('shows no warning strip while every address history reads fine', () => {
    useLiveStore.setState({ historyIssue: null });
    renderNav();
    expect(screen.queryByTestId('live-history-warning')).toBeNull();
  });

  it('explains a refused address instead of leaving Activity silently empty', () => {
    useLiveStore.setState({
      historyIssue: {
        address: 'Erefused0000000000000000000000000',
        message: 'Activity is incomplete: this address has too much history for the server.',
        serverMessage: 'history too large (code 1)',
      },
    });
    renderNav();

    const strip = screen.getByTestId('live-history-warning');
    expect(strip.textContent).toMatch(/too much history/i);
    // The server's own words stay available without cluttering the strip.
    expect(strip.getAttribute('title')).toBe('history too large (code 1)');
    // The tab bar is still rendered beside it (the strip is added, not swapped).
    expect(screen.getByTestId('live-tab-activity')).toBeTruthy();
  });

  it('still caps the unread badge at 9+', () => {
    useLiveStore.setState({ unreadActivity: 42 });
    renderNav();
    expect(screen.getByTestId('live-activity-badge').textContent).toBe('9+');
  });
});
