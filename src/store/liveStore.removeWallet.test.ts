// Removing a wallet (or resetting the extension) must reclaim its cached
// transaction history (node env; in-memory storage, mocked wallet service).
//
// REGRESSION THIS FILE EXISTS FOR: nothing outside txCache ever referenced the
// `txcache:` keys, so a deleted wallet's thousands of classified transactions
// stayed in the shared 10 MB chrome.storage.local quota forever, with no way for
// the user to get that space back.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// A mutable wallet list the mocked service reads from, so a test can watch the
// list shrink exactly the way the real service does.
const hoisted = vi.hoisted(() => ({
  wallets: [] as Array<{
    id: string;
    name: string;
    network: string;
    createdAt: number;
    active: boolean;
    kind: 'seed' | 'pk';
    address: string;
    passwordless: boolean;
  }>,
  activeId: null as string | null,
  resetCalls: 0,
}));

vi.mock('../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    async listWallets() {
      return hoisted.wallets.map((w) => ({ ...w, active: w.id === hoisted.activeId }));
    }
    async removeWallet(id: string) {
      hoisted.wallets = hoisted.wallets.filter((w) => w.id !== id);
      if (hoisted.activeId === id) {
        hoisted.activeId = hoisted.wallets[0]?.id ?? null;
      }
    }
    async reset() {
      hoisted.resetCalls++;
      hoisted.wallets = [];
      hoisted.activeId = null;
    }
    activeWalletId() {
      return hoisted.activeId;
    }
    network() {
      // Evrmore's legacy electrum-role id, which is what a real Evrmore
      // WalletEntry.network carries and therefore what the cache keys use.
      return 'mainnet';
    }
    isUnlocked() {
      return true;
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { LiveTransaction } from '../services/chain/electrumProvider';

const A1 = 'Eactiveprimary000000000000000000';
const A2 = 'Eactivederived000000000000000000';
const B1 = 'Eotherwallet00000000000000000000';
const R1 = 'RravencoinWallet0000000000000000';

function mkTx(txid: string): LiveTransaction {
  return {
    txid,
    asset: 'EVR',
    direction: 'in',
    amount: 1,
    feeEvr: 0,
    status: 'confirmed',
    blockHeight: 100,
    timestamp: 1_700_000_000_000,
    counterparty: 'Ecounterparty000000000000000000000',
  };
}

let storage: MemoryStorageAdapter;

/** Write a cache entry in the CURRENT persisted format (version 2, chain-scoped
 *  key). A stale fixture here would read as "no cache" and stop testing this. */
async function seedCache(chainId: string, address: string): Promise<void> {
  await storage.set(`txcache:${chainId}:${address}`, {
    version: 2,
    txs: [mkTx(`tx-${address}`)],
    knownHeights: { [`tx-${address}`]: 100 },
  });
}

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  hoisted.resetCalls = 0;
  hoisted.wallets = [
    { id: 'w1', name: 'One', network: 'mainnet', createdAt: 1, active: true, kind: 'seed', address: A1, passwordless: false },
    { id: 'w2', name: 'Two', network: 'mainnet', createdAt: 2, active: false, kind: 'seed', address: B1, passwordless: false },
    { id: 'w3', name: 'Three', network: 'ravencoin-mainnet', createdAt: 3, active: false, kind: 'seed', address: R1, passwordless: false },
  ];
  hoisted.activeId = 'w1';
  await seedCache('mainnet', A1);
  await seedCache('mainnet', A2);
  await seedCache('mainnet', B1);
  await seedCache('ravencoin-mainnet', R1);
  useLiveStore.setState({
    wallets: hoisted.wallets.map((w) => ({ ...w })),
    activeWalletId: 'w1',
    address: A1,
    // The ACTIVE wallet is unlocked, so its derived addresses are known — the
    // only moment they can be known, since deriving them needs the seed.
    addresses: [
      { index: 0, address: A1 },
      { index: 1, address: A2 },
    ],
  });
});

/** Cache keys still present, sorted for stable comparison. */
async function cacheKeys(): Promise<string[]> {
  return (await storage.keys()).filter((k) => k.startsWith('txcache:')).sort();
}

describe('liveStore.removeWallet — reclaims the removed wallet cache', () => {
  it('deletes every known address of the ACTIVE wallet, and nothing else', async () => {
    await useLiveStore.getState().removeWallet('w1');

    expect(await cacheKeys()).toEqual([
      'txcache:mainnet:' + B1,
      'txcache:ravencoin-mainnet:' + R1,
    ]);
  });

  it('deletes the primary address cache of a NON-active wallet', async () => {
    await useLiveStore.getState().removeWallet('w3');

    // The active wallet's caches (both addresses) survive untouched.
    expect(await cacheKeys()).toEqual(
      ['txcache:mainnet:' + A1, 'txcache:mainnet:' + A2, 'txcache:mainnet:' + B1].sort(),
    );
  });

  it('never deletes a cache a SURVIVING wallet still uses (same address, twice imported)', async () => {
    // w2 was imported from the same secret, so it holds the same address on the
    // same chain. Removing w1 must not cost w2 its (expensive) history.
    hoisted.wallets = hoisted.wallets.map((w) => (w.id === 'w2' ? { ...w, address: A1 } : w));
    useLiveStore.setState({ addresses: [{ index: 0, address: A1 }] });

    await useLiveStore.getState().removeWallet('w1');

    expect(await cacheKeys()).toContain('txcache:mainnet:' + A1);
  });

  it('leaves unrelated storage keys alone', async () => {
    await storage.set('liveWallets', { keep: true });
    await storage.set('addressBook', []);

    await useLiveStore.getState().removeWallet('w1');

    const keys = await storage.keys();
    expect(keys).toContain('liveWallets');
    expect(keys).toContain('addressBook');
  });
});

describe('liveStore.resetLiveWallet — reclaims every cache', () => {
  it('sweeps all txcache entries (the service reset only drops the vaults)', async () => {
    await storage.set('liveWallets', { keep: true });

    await useLiveStore.getState().resetLiveWallet();

    expect(hoisted.resetCalls).toBe(1);
    expect(await cacheKeys()).toEqual([]);
    expect(useLiveStore.getState().unreadActivity).toBe(0);
  });
});
