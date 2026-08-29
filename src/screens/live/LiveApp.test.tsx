/**
 * @vitest-environment jsdom
 *
 * Auto-lock behaviour of LiveApp. The one new rule under test: the idle
 * auto-lock is HELD while the wallet runs its first full sync (syncing ===
 * 'initial'), so a user passively waiting for a large history to sync is not
 * locked out mid-sync. The heavy child screens + the wallet service are stubbed
 * so the test only exercises the idle timer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    async exists() {
      return true;
    }
    async listWallets() {
      return [];
    }
    activeWalletId() {
      return null;
    }
    isUnlocked() {
      return false;
    }
    getProvider() {
      return {};
    }
    lock() {}
    // The app password (the app-password design notes). This fake mirrors an
    // install that never set one, which is the case these auto-lock tests are
    // about: hasAppPassword() false means init() takes the identical path it
    // always took, and lockApp() is what the store's user-facing lock() calls.
    async hasAppPassword() {
      return false;
    }
    // No wallet here opens with no password, so the forced setup (§12) is never
    // owed and init() takes the identical path it always took.
    async appPasswordRequired() {
      return false;
    }
    // The tests below force the store's `appUnlocked` flag directly, and only
    // need lockApp() to be the thing that clears it, exactly as the real service
    // does (it zeroes the master key).
    appUnlocked() {
      return this.masterKeyHeld;
    }
    private masterKeyHeld = false;
    lockApp() {
      this.masterKeyHeld = false;
      this.lock();
    }
  }
  return { LiveWalletService, BroadcastGatedError };
});

// Prices are decorative and hit the network — stub so the auto-refresh tick is inert.
vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({}),
}));

// Stub the heavy screens actually rendered in our phases (locked, ready/home).
vi.mock('./LiveHome', () => ({ LiveHome: () => null }));
vi.mock('./LiveLock', () => ({ LiveLock: () => null }));

import { LiveApp } from './LiveApp';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

const IDLE_MS = 5 * 60_000;

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

afterEach(() => {
  useLiveStore.getState().stopAutoRefresh();
  vi.useRealTimers();
  cleanup();
});

async function mountReady(syncing: 'idle' | 'initial') {
  render(<LiveApp />);
  // Let init() settle to the locked phase before we force 'ready'.
  await waitFor(() => expect(useLiveStore.getState().phase).toBe('locked'));

  vi.useFakeTimers();
  act(() => {
    useLiveStore.setState({
      phase: 'ready',
      syncing,
      autoLockMinutes: 5,
      wallets: [],
      activeWalletId: null,
      address: '',
    });
  });
}

describe('LiveApp auto-lock', () => {
  it('locks after the idle timeout when NOT syncing', async () => {
    await mountReady('idle');

    act(() => {
      vi.advanceTimersByTime(IDLE_MS + 20_000);
    });

    expect(useLiveStore.getState().phase).toBe('locked');
  });

  it('does NOT lock while the first full sync is running (syncing === "initial")', async () => {
    await mountReady('initial');

    act(() => {
      vi.advanceTimersByTime(IDLE_MS + 60_000);
    });

    // Still ready: the idle timer is held for the duration of the initial sync.
    expect(useLiveStore.getState().phase).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// The state the app password creates, and the one the idle timer used to miss.
// ---------------------------------------------------------------------------

/**
 * Mount, then force the state the app password produces after its lock screen is
 * passed: the APP is unlocked (the master key is in page memory) while the
 * chosen wallet is still on its own password, so the phase is 'locked'.
 */
async function mountAppUnlockedAtWalletLock(over: Record<string, unknown> = {}) {
  render(<LiveApp />);
  await waitFor(() => expect(useLiveStore.getState().phase).toBe('locked'));

  vi.useFakeTimers();
  act(() => {
    useLiveStore.setState({
      phase: 'locked',
      appPasswordSet: true,
      appUnlocked: true,
      syncing: 'idle',
      autoLockMinutes: 5,
      wallets: [],
      activeWalletId: null,
      address: '',
      ...over,
    });
  });
}

describe('LiveApp auto-lock: the app is unlocked behind a wallet lock screen', () => {
  it('still runs the idle timer, and locking drops the master key', async () => {
    await mountAppUnlockedAtWalletLock();
    expect(useLiveStore.getState().appUnlocked).toBe(true);

    act(() => {
      vi.advanceTimersByTime(IDLE_MS + 20_000);
    });

    // The gate used to be `phase !== 'ready'`, so in this state the timer never
    // started at all: the master key sat in memory behind a screen headed
    // "Wallet Locked" until the page was closed.
    expect(useLiveStore.getState().appUnlocked).toBe(false);
    expect(useLiveStore.getState().phase).toBe('app-locked');
  });

  it('runs it even for a PASSWORDLESS wallet, because the APP has something to re-enter', async () => {
    await mountAppUnlockedAtWalletLock({
      wallets: [
        {
          id: 'w-1',
          name: 'Open',
          network: 'mainnet',
          createdAt: 1,
          active: true,
          kind: 'seed' as const,
          address: 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU',
          passwordless: true,
          family: 'utxo' as const,
        },
      ],
      activeWalletId: 'w-1',
    });

    act(() => {
      vi.advanceTimersByTime(IDLE_MS + 20_000);
    });

    expect(useLiveStore.getState().appUnlocked).toBe(false);
    expect(useLiveStore.getState().phase).toBe('app-locked');
  });

  it('leaves an install with NO app password exactly as it was: no timer at a lock screen', async () => {
    render(<LiveApp />);
    await waitFor(() => expect(useLiveStore.getState().phase).toBe('locked'));

    vi.useFakeTimers();
    act(() => {
      useLiveStore.setState({
        phase: 'locked',
        appPasswordSet: false,
        appUnlocked: false,
        syncing: 'idle',
        autoLockMinutes: 5,
      });
    });
    act(() => {
      vi.advanceTimersByTime(IDLE_MS + 20_000);
    });
    // Nothing to lock, nothing held: the screen simply stays where it is.
    expect(useLiveStore.getState().phase).toBe('locked');
  });
});
