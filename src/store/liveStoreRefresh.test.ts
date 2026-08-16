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
    allowBroadcast = false;
    getProvider() {
      return hoisted.provider;
    }
    activeWalletId() {
      return 'w1';
    }
    isUnlocked() {
      return true;
    }
    // refresh() keys the tx cache by chain, so it asks the service which chain
    // is active. Evrmore's legacy id keeps these fixtures on the default chain.
    network() {
      return 'mainnet';
    }
    // NEVER touches a network: returns the txid the caller already computed, so
    // the send tests exercise the store's post-broadcast path and nothing else.
    async broadcast(_rawHex: string, knownTxid?: string) {
      return knownTxid ?? 'txid-from-service';
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import {
  AddressHistoryRefusedError,
  type LiveTransaction,
} from '../services/chain/electrumProvider';
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
    historyIssue: null,
    activitySeen: { height: 0, txids: [] },
    unreadActivity: 0,
    sendPlan: null,
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
      activitySeen: { height: 0, txids: [] },
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
      activitySeen: { height: 0, txids: [] },
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
    // Seed the persisted cache with a prior tx, so a history-fetch failure
    // returns it intact (the resilience contract). Key and version must match
    // the current format: the key is chain-scoped and the version tracks the
    // LiveTransaction shape, so a stale fixture here would read as "no cache"
    // and quietly stop testing the thing it is named after.
    await storage.set(`txcache:mainnet:${ADDR}`, {
      version: 2,
      txs: [mkTx('old', 90)],
      knownHeights: { old: 90 },
    });
    useLiveStore.setState({
      address: ADDR,
      addresses: [{ index: 0, address: ADDR }],
      phase: 'ready',
      txs: [mkTx('old', 90)],
      assets: [],
      activitySeen: { height: 0, txids: [] },
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
      activitySeen: { height: 0, txids: [] },
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

// ---------------------------------------------------------------------------
// A server that ANSWERS and refuses an address ("history too large") must be
// visible. It used to be swallowed by the cache, leaving an online wallet with
// a permanently empty Activity list, no error and no banner.

describe('liveStore.refresh - a refused address history is surfaced', () => {
  const ADDR = 'Erefused0000000000000000000000000';

  function readyWallet(): void {
    useLiveStore.setState({
      address: ADDR,
      addresses: [{ index: 0, address: ADDR }],
      phase: 'ready',
      txs: [],
      assets: [],
      activitySeen: { height: 0, txids: [] },
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      offline: false,
      historyIssue: null,
    });
    hoisted.provider.getNetworkStatus.mockResolvedValue(netConnected);
    hoisted.provider.getAllAssetBalances.mockResolvedValue([
      { name: 'EVR', amount: 4, decimals: 8, isNative: true },
    ]);
  }

  it('sets historyIssue (and stays ONLINE) when the server refuses the address', async () => {
    readyWallet();
    hoisted.provider.getAddressHistory.mockRejectedValue(
      new AddressHistoryRefusedError('history too large (code 1)', true),
    );

    await useLiveStore.getState().refresh();
    await vi.waitFor(() => expect(useLiveStore.getState().historyIssue).not.toBeNull());

    const s = useLiveStore.getState();
    // The wallet IS online: balances arrived, sending works. Only this address's
    // history is unavailable, which is what the warning has to say.
    expect(s.offline).toBe(false);
    expect(s.historyIssue?.address).toBe(ADDR);
    expect(s.historyIssue?.message).toMatch(/too much history/i);
    expect(s.historyIssue?.serverMessage).toMatch(/history too large/i);
  });

  it('leaves historyIssue null when the server is merely UNREACHABLE (that is just offline)', async () => {
    readyWallet();
    hoisted.provider.getAddressHistory.mockRejectedValue(new Error('network offline (fake)'));

    await useLiveStore.getState().refresh();
    await vi.waitFor(() => expect(useLiveStore.getState().lastSyncAt).not.toBeNull());

    expect(useLiveStore.getState().historyIssue).toBeNull();
  });

  it('clears the warning once the address reads normally again', async () => {
    readyWallet();
    hoisted.provider.getAddressHistory.mockRejectedValue(
      new AddressHistoryRefusedError('history too large', true),
    );
    await useLiveStore.getState().refresh();
    await vi.waitFor(() => expect(useLiveStore.getState().historyIssue).not.toBeNull());

    hoisted.provider.getAddressHistory.mockResolvedValue([{ tx_hash: 't1', height: 100 }]);
    hoisted.provider.classifyTxHash.mockResolvedValue(mkTx('t1'));
    await useLiveStore.getState().refresh({ silent: true });

    await vi.waitFor(() => {
      const s = useLiveStore.getState();
      expect(s.txs.map((t) => t.txid)).toEqual(['t1']);
      expect(s.historyIssue).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// The Activity badge, end to end through a real refresh. On a wallet with more
// transactions than the persisted txid cap, "mark as seen" used to be undone by
// the very next refresh, so the badge lived at "9+" permanently.

describe('liveStore.markActivitySeen - sticks across refreshes on a large wallet', () => {
  const ADDR = 'Ebigwallet00000000000000000000000';
  /** More txs than SEEN_TX_CAP (400) - the size where the old badge broke. */
  const TX_COUNT = 500;

  it('badge clears on mark and STAYS clear after the next sync', async () => {
    useLiveStore.setState({
      address: ADDR,
      addresses: [{ index: 0, address: ADDR }],
      phase: 'ready',
      txs: [],
      assets: [],
      activitySeen: { height: 0, txids: [] },
      unreadActivity: 0,
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      offline: false,
    });
    hoisted.provider.getNetworkStatus.mockResolvedValue(netConnected);
    hoisted.provider.getAllAssetBalances.mockResolvedValue([
      { name: 'EVR', amount: 1, decimals: 8, isNative: true },
    ]);
    const history = Array.from({ length: TX_COUNT }, (_, i) => ({
      tx_hash: `big${i}`,
      height: 900_000 - i,
    }));
    hoisted.provider.getAddressHistory.mockResolvedValue(history);
    hoisted.provider.classifyTxHash.mockImplementation(
      async (_addr: string, txHash: string, height: number) => mkTx(txHash, height),
    );

    await useLiveStore.getState().refresh();
    await vi.waitFor(() => expect(useLiveStore.getState().txs).toHaveLength(TX_COUNT));
    expect(useLiveStore.getState().unreadActivity).toBe(TX_COUNT);

    // The user opens Activity.
    useLiveStore.getState().markActivitySeen();
    expect(useLiveStore.getState().unreadActivity).toBe(0);

    // The 20s poll runs again over the SAME history. This is where the badge
    // used to come back as "9+" (500 txs, only 400 ids could be remembered).
    await useLiveStore.getState().refresh({ silent: true });
    await vi.waitFor(() => expect(useLiveStore.getState().lastSyncAt).not.toBeNull());
    expect(useLiveStore.getState().unreadActivity).toBe(0);

    // Persisted bounded, and a genuinely new tx still raises the badge.
    const persisted = await storage.get<{ height: number; txids: string[] }>('activitySeen:w1');
    expect(persisted?.height).toBe(900_000);
    expect(persisted?.txids.length).toBeLessThanOrEqual(400);

    hoisted.provider.getAddressHistory.mockResolvedValue([
      { tx_hash: 'brand-new', height: 900_001 },
      ...history,
    ]);
    await useLiveStore.getState().refresh({ silent: true });
    await vi.waitFor(() => expect(useLiveStore.getState().unreadActivity).toBe(1));
  });

  it('migrates the legacy string[] of seen txids instead of forgetting it', async () => {
    await storage.set('activitySeen:w1', ['legacy-1', 'legacy-2']);
    useLiveStore.setState({ txs: [mkTx('legacy-1', 10), mkTx('other', 11)] });

    await useLiveStore.getState().loadWalletAssets();

    const s = useLiveStore.getState();
    expect(s.activitySeen).toEqual({ height: 0, txids: ['legacy-1', 'legacy-2'] });
    expect(s.unreadActivity).toBe(1); // only 'other' is new
  });
});

// ---------------------------------------------------------------------------
// A just-sent transaction has to appear immediately. The post-broadcast
// refreshes cannot do it: the tx-sync guard skips every refresh whose wallet is
// already classifying, so on a wallet with real history the user saw nothing at
// all until a sync that takes minutes finished.

describe('liveStore.broadcast - the just-sent tx appears without waiting for the sync', () => {
  const ADDR = 'Esender00000000000000000000000000';
  const TO = 'Erecipient0000000000000000000000';
  const SENT_TXID = 'ff'.repeat(32);

  /** A wallet mid-sync: the classification is deferred, so txSyncRun is held and
   *  every later refresh skips the tx sync exactly like the real bug. */
  async function walletMidSync() {
    useLiveStore.setState({
      address: ADDR,
      addresses: [{ index: 0, address: ADDR }],
      phase: 'ready',
      txs: [],
      assets: [],
      activitySeen: { height: 0, txids: [] },
      unreadActivity: 0,
      syncing: 'idle',
      syncProgress: null,
      lastSyncAt: null,
      offline: false,
      sendPlan: {
        built: { rawHex: 'deadbeef', txid: SENT_TXID },
        toAddress: TO,
        amountSats: 250_000_000n,
        feeSats: 1_000_000n,
      } as never,
    });
    hoisted.provider.getNetworkStatus.mockResolvedValue(netConnected);
    hoisted.provider.getAllAssetBalances.mockResolvedValue([
      { name: 'EVR', amount: 10, decimals: 8, isNative: true },
    ]);
    hoisted.provider.getAddressHistory.mockResolvedValue([{ tx_hash: 'old', height: 100 }]);
    const d = deferred<LiveTransaction | null>();
    hoisted.provider.classifyTxHash.mockReturnValue(d.promise);
    await useLiveStore.getState().refresh();
    await vi.waitFor(() => expect(hoisted.provider.classifyTxHash).toHaveBeenCalled());
    return d;
  }

  it('shows the pending row immediately while a full classification is still running', async () => {
    const d = await walletMidSync();
    expect(useLiveStore.getState().txs).toEqual([]); // nothing yet: the sync is stuck

    const txid = await useLiveStore.getState().broadcast('deadbeef');

    expect(txid).toBe(SENT_TXID);
    const rows = useLiveStore.getState().txs;
    expect(rows.map((t) => t.txid)).toEqual([SENT_TXID]);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].direction).toBe('out');
    expect(rows[0].asset).toBe('EVR');
    expect(rows[0].counterparty).toBe(TO);
    // Native send: what LEFT the wallet is the amount plus the fee (the
    // convention the classifier reports for the same tx later).
    expect(rows[0].amount).toBeCloseTo(2.51, 8);
    expect(rows[0].feeEvr).toBeCloseTo(0.01, 8);

    d.resolve(null);
  });

  it('keeps the row when a sync that does not know the tx yet completes', async () => {
    const d = await walletMidSync();
    await useLiveStore.getState().broadcast('deadbeef');

    // The in-flight sync finishes; the server has NOT seen our tx yet. It must
    // not blink out of Activity.
    d.resolve(mkTx('old', 100));
    await vi.waitFor(() => expect(useLiveStore.getState().lastSyncAt).not.toBeNull());
    expect(useLiveStore.getState().txs.map((t) => t.txid)).toEqual([SENT_TXID, 'old']);
  });

  it('retires the local row (no duplicate) once a sync reports the real transaction', async () => {
    const d = await walletMidSync();
    await useLiveStore.getState().broadcast('deadbeef');
    d.resolve(mkTx('old', 100));
    await vi.waitFor(() => expect(useLiveStore.getState().lastSyncAt).not.toBeNull());

    // Next poll: the server now reports the broadcast tx in the mempool.
    hoisted.provider.getAddressHistory.mockResolvedValue([
      { tx_hash: SENT_TXID, height: 0 },
      { tx_hash: 'old', height: 100 },
    ]);
    hoisted.provider.classifyTxHash.mockImplementation(
      async (_a: string, txHash: string, height: number) => mkTx(txHash, height),
    );
    await useLiveStore.getState().refresh({ silent: true });

    await vi.waitFor(() => {
      const ids = useLiveStore.getState().txs.map((t) => t.txid);
      expect(ids).toEqual([SENT_TXID, 'old']); // exactly one entry for our tx
    });
  });
});
