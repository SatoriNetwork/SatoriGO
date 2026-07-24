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
