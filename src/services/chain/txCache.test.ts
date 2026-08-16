// vitest tests for the local transaction cache (node env).
// Uses a fake TransactionCacheProvider + an in-memory storage adapter, so no
// WebSocket and no chrome.storage are touched.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTransactionCaches,
  getCachedTransactions,
  lastHistoryFetchError,
  refreshTransactionCache,
  type HistoryFetchFailure,
  type TransactionCacheProvider,
  type TxHistoryItem,
} from './txCache';
// The REAL error class the live provider throws. Imported on purpose: the cache
// recognises it structurally (by name + flag) to stay decoupled, and this import
// is what stops the two drifting apart silently.
import { AddressHistoryRefusedError } from './electrumProvider';

// The cache is keyed per chain; these tests all exercise one chain.
const TEST_CHAIN = 'evrmore-mainnet';
import type { LiveTransaction } from './electrumProvider';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';

const ADDR = 'EcacheTestAddress0000000000000000';

// ---------------------------------------------------------------------------
// Fake provider: getAddressHistory returns a MUTABLE history; classifyTxHash
// synthesizes a LiveTransaction and counts how many times it is invoked (so a
// test can assert exactly how many txs were (re)classified).

interface FakeProviderState {
  history: TxHistoryItem[];
  classifyCalls: number;
  historyCalls: number;
  /** tx_hashes in the order classifyTxHash was invoked (asserts newest-first). */
  classifiedOrder: string[];
}

function makeFakeProvider(initialHistory: TxHistoryItem[]): {
  provider: TransactionCacheProvider;
  state: FakeProviderState;
} {
  const state: FakeProviderState = {
    history: initialHistory,
    classifyCalls: 0,
    historyCalls: 0,
    classifiedOrder: [],
  };
  const provider: TransactionCacheProvider = {
    async getAddressHistory(): Promise<TxHistoryItem[]> {
      state.historyCalls++;
      return state.history;
    },
    async classifyTxHash(_address, txHash, height): Promise<LiveTransaction | null> {
      state.classifyCalls++;
      state.classifiedOrder.push(txHash);
      return {
        txid: txHash,
        asset: 'SATORIEVR',
        direction: 'in',
        amount: 1,
        feeEvr: 0,
        status: height > 0 ? 'confirmed' : 'pending',
        blockHeight: height > 0 ? height : undefined,
        timestamp: 1_700_000_000_000,
        counterparty: 'EcounterpartyAddress00000000000000',
      };
    },
  };
  return { provider, state };
}

let storage: MemoryStorageAdapter;
beforeEach(() => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
});

/** Build N distinct confirmed history items with STRICTLY DESCENDING heights, so
 *  the id order (h<N>..h1) is the same order refreshTransactionCache should
 *  classify them in (newest-first). */
function makeHistory(n: number): TxHistoryItem[] {
  const items: TxHistoryItem[] = [];
  for (let i = 1; i <= n; i++) items.push({ tx_hash: `h${i}`, height: i });
  return items;
}

describe('txCache', () => {
  it('getCachedTransactions returns [] when nothing is cached', async () => {
    expect(await getCachedTransactions(TEST_CHAIN, 'EnothingCached00000000000000000000')).toEqual([]);
  });

  it('first refresh classifies every tx in history and caches the sorted list', async () => {
    const { provider, state } = makeFakeProvider([
      { tx_hash: 't1', height: 100 },
      { tx_hash: 't2', height: 200 },
      { tx_hash: 't3', height: 0 }, // mempool / pending
    ]);

    const first = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    // Every tx was classified exactly once.
    expect(state.classifyCalls).toBe(3);
    expect(first).toHaveLength(3);

    // Sorted: pending first, then confirmed by height desc.
    expect(first.map((t) => t.txid)).toEqual(['t3', 't2', 't1']);
    expect(first[0].status).toBe('pending');

    // The same list is now cached (no provider needed to read it back).
    const cached = await getCachedTransactions(TEST_CHAIN, ADDR);
    expect(cached).toEqual(first);
  });

  it('second refresh with identical history classifies 0 NEW txs and returns the same list', async () => {
    const history: TxHistoryItem[] = [
      { tx_hash: 't1', height: 100 },
      { tx_hash: 't2', height: 200 },
    ];
    const { provider, state } = makeFakeProvider(history);

    const first = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    const callsAfterFirst = state.classifyCalls;
    expect(callsAfterFirst).toBe(2);

    const second = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    // No NEW classification happened — only the light history was read.
    expect(state.classifyCalls - callsAfterFirst).toBe(0);
    expect(state.historyCalls).toBe(2); // history fetched on each refresh
    expect(second).toEqual(first);
  });

  it('a new tx_hash in history triggers exactly ONE new classification', async () => {
    const { provider, state } = makeFakeProvider([{ tx_hash: 't1', height: 100 }]);

    await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    const before = state.classifyCalls;

    // A new tx appears in history.
    state.history = [
      { tx_hash: 't1', height: 100 },
      { tx_hash: 't2', height: 150 },
    ];
    const result = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    expect(state.classifyCalls - before).toBe(1); // only t2 reclassified
    expect(result.map((t) => t.txid).sort()).toEqual(['t1', 't2']);
  });

  it('a cached pending tx that gains a height is reclassified (pending -> confirmed)', async () => {
    const { provider, state } = makeFakeProvider([{ tx_hash: 't1', height: 0 }]); // pending

    const first = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    expect(first[0].status).toBe('pending');
    expect(first[0].blockHeight).toBeUndefined();
    const before = state.classifyCalls;

    // t1 gets mined — its height changes.
    state.history = [{ tx_hash: 't1', height: 500 }];
    const second = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    expect(state.classifyCalls - before).toBe(1); // reclassified exactly once
    expect(second).toHaveLength(1);
    expect(second[0].status).toBe('confirmed');
    expect(second[0].blockHeight).toBe(500);
  });

  it('prunes a tx that dropped out of history (replaced / dropped mempool tx)', async () => {
    const { provider, state } = makeFakeProvider([
      { tx_hash: 't1', height: 0 }, // pending
      { tx_hash: 't2', height: 100 },
    ]);
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    // t1 disappears (dropped / replaced); only t2 remains in history.
    state.history = [{ tx_hash: 't2', height: 100 }];
    const result = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    expect(result.map((t) => t.txid)).toEqual(['t2']);
    expect(await getCachedTransactions(TEST_CHAIN, ADDR)).toEqual(result);
  });

  it('returns the existing cache intact when the history fetch fails (resilience)', async () => {
    const { provider } = makeFakeProvider([
      { tx_hash: 't1', height: 100 },
      { tx_hash: 't2', height: 200 },
    ]);
    const first = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    // Next history fetch throws — the cache must survive untouched.
    provider.getAddressHistory = async () => {
      throw new Error('network offline (fake)');
    };
    const second = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    expect(second).toEqual(first);
    expect(await getCachedTransactions(TEST_CHAIN, ADDR)).toEqual(first);
  });

  it('a per-tx classification failure does not wipe already-cached txs', async () => {
    const { provider, state } = makeFakeProvider([{ tx_hash: 't1', height: 100 }]);
    const first = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    expect(first).toHaveLength(1);

    // A new tx appears but its classification throws.
    state.history = [
      { tx_hash: 't1', height: 100 },
      { tx_hash: 'tBad', height: 150 },
    ];
    provider.classifyTxHash = async (_a, txHash) => {
      if (txHash === 'tBad') throw new Error('classify boom');
      return null;
    };
    const second = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    // t1 survives; the failed tBad is simply omitted (retried next refresh).
    expect(second.map((t) => t.txid)).toEqual(['t1']);
  });

  it('classifies the delta NEWEST-first (mempool, then height descending)', async () => {
    // Deliberately give history in an out-of-order shape (old, mempool, new) to
    // prove the classifier re-orders it rather than following history order.
    const { provider, state } = makeFakeProvider([
      { tx_hash: 'old', height: 10 },
      { tx_hash: 'mempool', height: 0 },
      { tx_hash: 'newer', height: 300 },
      { tx_hash: 'newest', height: 500 },
    ]);

    await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    // Mempool first, then confirmed by height DESC.
    expect(state.classifiedOrder).toEqual(['mempool', 'newest', 'newer', 'old']);
  });

  it('CHECKPOINTS the cache mid-run (persists every 25 classified, not only at end)', async () => {
    // 45 new txs => a checkpoint after the 25th classified tx, plus the final
    // write = 2 storage.set calls (the old serial code wrote exactly once).
    const { provider } = makeFakeProvider(makeHistory(45));
    const setSpy = vi.spyOn(storage, 'set');

    await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    expect(setSpy).toHaveBeenCalledTimes(2);
    // The FIRST persisted checkpoint already holds 25 classified txs — proof the
    // cache is durable mid-run, so an interruption resumes instead of restarting.
    const firstEntry = setSpy.mock.calls[0][1] as { txs: LiveTransaction[] };
    expect(firstEntry.txs).toHaveLength(25);
    const lastEntry = setSpy.mock.calls[1][1] as { txs: LiveTransaction[] };
    expect(lastEntry.txs).toHaveLength(45);
  });

  it('a checkpointed run RESUMES: a crash after a checkpoint re-classifies only the rest', async () => {
    // First run: classify only the first 20 (fail hard after that) to simulate an
    // interruption right after the first checkpoint.
    const { provider, state } = makeFakeProvider(makeHistory(45));
    let allow = 20;
    const original = provider.classifyTxHash.bind(provider);
    provider.classifyTxHash = async (a, h, height) => {
      if (allow-- <= 0) throw new Error('interrupted');
      return original(a, h, height);
    };
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider).catch(() => {});
    // 20 succeeded and were checkpointed; the rest threw (swallowed per-tx).
    const cached = await getCachedTransactions(TEST_CHAIN, ADDR);
    expect(cached.length).toBeGreaterThanOrEqual(20);

    // Second run with a healthy provider: only the NOT-yet-classified txs run.
    const before = state.classifyCalls;
    provider.classifyTxHash = original;
    const result = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    // The 20 already-known txs are NOT re-classified; only the remaining 25 are.
    expect(state.classifyCalls - before).toBe(25);
    expect(result).toHaveLength(45);
  });

  it('reports progress via onProgress: (0,total) first, then after each batch, ending (total,total)', async () => {
    const { provider } = makeFakeProvider(makeHistory(45));
    const calls: Array<[number, number]> = [];

    await refreshTransactionCache(TEST_CHAIN, ADDR, provider, (done, total) => calls.push([done, total]));

    // One priming (0,total) call, then one per batch of 25 (ceil(45/25) = 2).
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([0, 45]);
    expect(calls[calls.length - 1]).toEqual([45, 45]);
    // done is monotonically non-decreasing and never exceeds total.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i][0]).toBeGreaterThanOrEqual(calls[i - 1][0]);
      expect(calls[i][0]).toBeLessThanOrEqual(45);
    }
  });

  it('does not call onProgress at all when there is nothing to classify', async () => {
    const { provider } = makeFakeProvider(makeHistory(3));
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider); // first run classifies the 3

    const calls: Array<[number, number]> = [];
    // Identical history => no delta => total 0 => no progress calls.
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider, (done, total) => calls.push([done, total]));
    expect(calls).toHaveLength(0);
  });

  it('one failing tx in a batch does not block the other txs in the same batch', async () => {
    // These five all land in one batch; put a thrower in the middle of it.
    const { provider } = makeFakeProvider([
      { tx_hash: 'a', height: 5 },
      { tx_hash: 'b', height: 4 },
      { tx_hash: 'boom', height: 3 },
      { tx_hash: 'c', height: 2 },
      { tx_hash: 'd', height: 1 },
    ]);
    provider.classifyTxHash = async (_a, txHash, height) => {
      if (txHash === 'boom') throw new Error('classify boom');
      return {
        txid: txHash,
        asset: 'SATORIEVR',
        direction: 'in',
        amount: 1,
        feeEvr: 0,
        status: height > 0 ? 'confirmed' : 'pending',
        blockHeight: height > 0 ? height : undefined,
        timestamp: 1_700_000_000_000,
        counterparty: 'EcounterpartyAddress00000000000000',
      };
    };

    const result = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    // Every sibling of the failed tx still classified; only 'boom' is missing.
    expect(result.map((t) => t.txid).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ---------------------------------------------------------------------------
// A server that ANSWERS and REFUSES an address is not the same as being offline.
// This is the state a real Evrmore/Ravencoin address hits: get_history replies
// {"code":1,"message":"history too large"} forever, and the wallet used to show
// an empty, frozen Activity list with no error at all.

describe('txCache — a refused history is distinguishable from being offline', () => {
  it('reports reason "too-large" for the REAL provider refusal, and keeps the cache', async () => {
    const { provider } = makeFakeProvider([{ tx_hash: 't1', height: 100 }]);
    const first = await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    expect(first).toHaveLength(1);

    provider.getAddressHistory = async () => {
      throw new AddressHistoryRefusedError('history too large (code 1)', true);
    };
    const failures: HistoryFetchFailure[] = [];
    const second = await refreshTransactionCache(TEST_CHAIN, ADDR, provider, undefined, (f) =>
      failures.push(f),
    );

    expect(failures).toEqual([
      { address: ADDR, reason: 'too-large', message: expect.stringContaining('history too large') },
    ]);
    // Resilience is unchanged: the cached view still comes back intact.
    expect(second).toEqual(first);
    // ...and the reason outlives the call, like lastCacheWriteError does.
    expect(lastHistoryFetchError()?.reason).toBe('too-large');
    expect(lastHistoryFetchError()?.address).toBe(ADDR);
  });

  it('reports a NON-too-large server refusal as "refused" (still actionable, still not offline)', async () => {
    const { provider } = makeFakeProvider([]);
    provider.getAddressHistory = async () => {
      throw new AddressHistoryRefusedError('unknown method "blockchain.scripthash.get_history"', false);
    };
    const failures: HistoryFetchFailure[] = [];
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider, undefined, (f) => failures.push(f));

    expect(failures[0].reason).toBe('refused');
    expect(lastHistoryFetchError()?.reason).toBe('refused');
  });

  it('reports a TRANSPORT failure as "unreachable" and does NOT remember it', async () => {
    // Clear any refusal remembered by a previous test in this file.
    const { provider } = makeFakeProvider([{ tx_hash: 't1', height: 100 }]);
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    expect(lastHistoryFetchError()).toBeNull();

    provider.getAddressHistory = async () => {
      throw new Error('network offline (fake)');
    };
    const failures: HistoryFetchFailure[] = [];
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider, undefined, (f) => failures.push(f));

    expect(failures[0].reason).toBe('unreachable');
    // Ordinary offline: nothing to nag about, so nothing is remembered.
    expect(lastHistoryFetchError()).toBeNull();
  });

  it('a later SUCCESSFUL read clears the remembered refusal', async () => {
    const { provider, state } = makeFakeProvider([{ tx_hash: 't1', height: 100 }]);
    const healthy = provider.getAddressHistory.bind(provider);
    provider.getAddressHistory = async () => {
      throw new AddressHistoryRefusedError('history too large', true);
    };
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    expect(lastHistoryFetchError()).not.toBeNull();

    provider.getAddressHistory = healthy;
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider);

    expect(lastHistoryFetchError()).toBeNull();
    expect(state.historyCalls).toBeGreaterThan(0);
  });

  it('does not call onHistoryError when the history reads fine', async () => {
    const { provider } = makeFakeProvider(makeHistory(3));
    const failures: HistoryFetchFailure[] = [];
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider, undefined, (f) => failures.push(f));
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deleting cached histories. Nothing outside this module used to touch the
// `txcache:` keys, so a removed wallet's history sat in the shared 10 MB quota
// forever.

describe('clearTransactionCaches', () => {
  const OTHER_ADDR = 'EotherCachedAddress0000000000000';
  const OTHER_CHAIN = 'ravencoin-mainnet';

  async function seed(): Promise<void> {
    const { provider } = makeFakeProvider([{ tx_hash: 't1', height: 100 }]);
    await refreshTransactionCache(TEST_CHAIN, ADDR, provider);
    await refreshTransactionCache(TEST_CHAIN, OTHER_ADDR, provider);
    await refreshTransactionCache(OTHER_CHAIN, ADDR, provider);
  }

  it('removes only the entries for the given chain AND address', async () => {
    await seed();

    const removed = await clearTransactionCaches({
      chainIds: [TEST_CHAIN],
      addresses: [ADDR],
    });

    expect(removed).toBe(1);
    expect(await getCachedTransactions(TEST_CHAIN, ADDR)).toEqual([]);
    // A sibling wallet's cache (same chain, other address) is untouched, and so
    // is the SAME address on another chain — re-syncing either would be costly.
    expect(await getCachedTransactions(TEST_CHAIN, OTHER_ADDR)).toHaveLength(1);
    expect(await getCachedTransactions(OTHER_CHAIN, ADDR)).toHaveLength(1);
  });

  it('with no filter, removes every cached history and nothing else', async () => {
    await seed();
    await storage.set('liveWallets', { keep: true });

    const removed = await clearTransactionCaches();

    expect(removed).toBe(3);
    expect(await storage.keys()).toEqual(['liveWallets']);
  });

  it('is a no-op (0) when there is nothing to remove', async () => {
    expect(await clearTransactionCaches({ chainIds: [TEST_CHAIN], addresses: [ADDR] })).toBe(0);
  });
});
