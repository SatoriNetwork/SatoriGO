// Tests for the BALANCE-FIRST refresh + detached, checkpointed background tx
// sync in liveStore (node env). The real LiveWalletService is mocked so we can
// inject a fake data provider and drive classification timing deterministically;
// storage is the in-memory adapter, so no WebSocket / chrome.storage is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A single mutable fake provider shared with the mocked service. Hoisted so the
// vi.mock factory (also hoisted) can close over it.
const hoisted = vi.hoisted(() => ({
  provider: {
    getNetworkStatus: vi.fn(),
    getAllAssetBalances: vi.fn(),
    getAddressHistory: vi.fn(),
    classifyTxHash: vi.fn(),
    getAssetMeta: vi.fn(),
    getAssetBalance: vi.fn(),
  },
}));

vi.mock('../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    getProvider() {
      return hoisted.provider;
    }
    activeWalletId() {
      return 'w1';
    }
    isUnlocked() {
      return true;
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { LiveTransaction } from '../services/chain/electrumProvider';
import type { NetworkStatus } from '../types/domain';

const netConnected: NetworkStatus = {
  networkId: 'mainnet',
  state: 'connected',
  latencyMs: 5,
  blockHeight: 100,
  serverVersion: 'ElectrumX Evrmore',
  updatedAt: 1_700_000_000_000,
};

function mkTx(txid: string, height = 100): LiveTransaction {
  return {
    txid,
    asset: 'SATORIEVR',
    direction: 'in',
    amount: 1,
    feeEvr: 0,
    status: height > 0 ? 'confirmed' : 'pending',
    blockHeight: height > 0 ? height : undefined,
    timestamp: 1_700_000_000_000,
    counterparty: 'Ecounterparty000000000000000000000',
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let storage: MemoryStorageAdapter;

beforeEach(() => {
  vi.resetAllMocks();
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
});

afterEach(() => {
  // Return to a benign state so a leftover in-flight sync can't leak across tests.
  useLiveStore.setState({
    address: '',
    addresses: [],
    txs: [],
    assets: [],
    syncing: 'idle',
    syncProgress: null,
    lastSyncAt: null,
    offline: false,
  });
});

describe('liveStore.refresh — balance-first + background tx sync', () => {
  it('shows the balance immediately, then fills txs (progress + lastSyncAt lifecycle)', async () => {
    const ADDR = 'Ebalancefirst00000000000000000000';
    useLiveStore.setState({
      address: ADDR,
      addresses: [{ index: 0, address: ADDR }],
      phase: 'ready',
      txs: [],
      assets: [],
      seenTxids: [],
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      offline: false,
    });

    hoisted.provider.getNetworkStatus.mockResolvedValue(netConnected);
    hoisted.provider.getAllAssetBalances.mockResolvedValue([
      { name: 'EVR', amount: 12.5, decimals: 8, isNative: true },
    ]);
    hoisted.provider.getAddressHistory.mockResolvedValue([{ tx_hash: 't1', height: 100 }]);
    const d = deferred<LiveTransaction | null>();
    hoisted.provider.classifyTxHash.mockReturnValue(d.promise);

    await useLiveStore.getState().refresh();

    // Balance is on screen the moment refresh() resolves — the (slow) tx sync is
    // still pending, so txs are empty and lastSyncAt is unset.
    const s1 = useLiveStore.getState();
    expect(s1.assets.find((a) => a.name === 'EVR')?.amount).toBe(12.5);
    expect(s1.loadingRefresh).toBe(false);
    expect(s1.offline).toBe(false);
    expect(s1.txs).toEqual([]);
    expect(s1.lastSyncAt).toBeNull();

    // Progress becomes visible (0, total) before the first batch resolves.
    await vi.waitFor(() =>
      expect(useLiveStore.getState().syncProgress).toEqual({ done: 0, total: 1 }),
    );

    // Resolve classification -> txs land, progress clears, lastSyncAt is set.
    d.resolve(mkTx('t1'));
    await vi.waitFor(() => {
      const s = useLiveStore.getState();
      expect(s.txs.map((t) => t.txid)).toEqual(['t1']);
      expect(s.syncProgress).toBeNull();
      expect(typeof s.lastSyncAt).toBe('number');
    });
  });

  it('never starts a second concurrent full sync for the same wallet', async () => {
    const ADDR = 'Econcurrent0000000000000000000000';
    useLiveStore.setState({
      address: ADDR,
      addresses: [{ index: 0, address: ADDR }],
      phase: 'ready',
      txs: [],
      assets: [],
      seenTxids: [],
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      offline: false,
    });

    hoisted.provider.getNetworkStatus.mockResolvedValue(netConnected);
    hoisted.provider.getAllAssetBalances.mockResolvedValue([
      { name: 'EVR', amount: 1, decimals: 8, isNative: true },
    ]);
    hoisted.provider.getAddressHistory.mockResolvedValue([{ tx_hash: 't1', height: 100 }]);
    const d = deferred<LiveTransaction | null>();
    hoisted.provider.classifyTxHash.mockReturnValue(d.promise);

    await useLiveStore.getState().refresh(); // starts background sync #1
    await useLiveStore.getState().refresh({ silent: true }); // guard skips sync #2

    d.resolve(mkTx('t1'));
    await vi.waitFor(() => expect(useLiveStore.getState().txs.map((t) => t.txid)).toEqual(['t1']));

    // Only ONE full classification ran despite two refreshes (the second was
    // guarded). Balances were fetched twice (they are cheap and not guarded).
    expect(hoisted.provider.getAddressHistory).toHaveBeenCalledTimes(1);
    expect(hoisted.provider.classifyTxHash).toHaveBeenCalledTimes(1);
    expect(hoisted.provider.getAllAssetBalances).toHaveBeenCalledTimes(2);
  });

  it('a tx-sync failure does not flip the wallet offline and keeps prior cached txs', async () => {
    const ADDR = 'Etxsyncfail0000000000000000000000';
    // Seed the persisted per-address cache with a prior tx, so a history-fetch
    // failure returns it intact (the resilience contract).
    await storage.set(`txcache:${ADDR}`, {
      version: 1,
      txs: [mkTx('old', 90)],
      knownHeights: { old: 90 },
    });
    useLiveStore.setState({
      address: ADDR,
      addresses: [{ index: 0, address: ADDR }],
      phase: 'ready',
      txs: [mkTx('old', 90)],
      assets: [],
      seenTxids: [],
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      offline: false,
    });

    hoisted.provider.getNetworkStatus.mockResolvedValue(netConnected);
    hoisted.provider.getAllAssetBalances.mockResolvedValue([
      { name: 'EVR', amount: 3, decimals: 8, isNative: true },
    ]);
    // The tx history fetch fails — this must NOT mark the wallet offline.
    hoisted.provider.getAddressHistory.mockRejectedValue(new Error('history offline (fake)'));

    await useLiveStore.getState().refresh();

    // Balances arrived, so the wallet is online despite the tx-sync failure.
    expect(useLiveStore.getState().offline).toBe(false);

    await vi.waitFor(() => expect(useLiveStore.getState().lastSyncAt).not.toBeNull());
    const s = useLiveStore.getState();
    expect(s.offline).toBe(false);
    expect(s.txs.map((t) => t.txid)).toEqual(['old']); // prior txs preserved
    expect(s.syncProgress).toBeNull();
  });

  it('discards a completed background sync whose wallet was switched away', async () => {
    const A = 'Ewalletaaa00000000000000000000000';
    const B = 'Ewalletbbb00000000000000000000000';
    useLiveStore.setState({
      address: A,
      addresses: [{ index: 0, address: A }],
      phase: 'ready',
      txs: [],
      assets: [],
      seenTxids: [],
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      offline: false,
    });

    hoisted.provider.getNetworkStatus.mockResolvedValue(netConnected);
    hoisted.provider.getAllAssetBalances.mockResolvedValue([
      { name: 'EVR', amount: 1, decimals: 8, isNative: true },
    ]);
    hoisted.provider.getAddressHistory.mockResolvedValue([{ tx_hash: 't1', height: 100 }]);
    const d = deferred<LiveTransaction | null>();
    hoisted.provider.classifyTxHash.mockReturnValue(d.promise);

    await useLiveStore.getState().refresh(); // background sync for A pending
    await vi.waitFor(() => expect(hoisted.provider.classifyTxHash).toHaveBeenCalledTimes(1));

    // Simulate a wallet switch: the active address is now B, txs cleared.
    useLiveStore.setState({ address: B, addresses: [{ index: 0, address: B }], txs: [] });

    // A's classification finishes AFTER the switch — its results must be dropped.
    d.resolve(mkTx('t1'));
    await new Promise((r) => setTimeout(r, 20));

    const s = useLiveStore.getState();
    expect(s.txs).toEqual([]); // A's tx never lands on B
    expect(s.lastSyncAt).toBeNull();
  });
});
