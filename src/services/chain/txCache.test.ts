// vitest tests for the local transaction cache (node env).
// Uses a fake TransactionCacheProvider + an in-memory storage adapter, so no
// WebSocket and no chrome.storage are touched.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCachedTransactions,
  refreshTransactionCache,
  type TransactionCacheProvider,
  type TxHistoryItem,
} from './txCache';
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
    expect(await getCachedTransactions('EnothingCached00000000000000000000')).toEqual([]);
  });

  it('first refresh classifies every tx in history and caches the sorted list', async () => {
    const { provider, state } = makeFakeProvider([
      { tx_hash: 't1', height: 100 },
      { tx_hash: 't2', height: 200 },
      { tx_hash: 't3', height: 0 }, // mempool / pending
    ]);

    const first = await refreshTransactionCache(ADDR, provider);

    // Every tx was classified exactly once.
    expect(state.classifyCalls).toBe(3);
    expect(first).toHaveLength(3);

    // Sorted: pending first, then confirmed by height desc.
    expect(first.map((t) => t.txid)).toEqual(['t3', 't2', 't1']);
    expect(first[0].status).toBe('pending');

    // The same list is now cached (no provider needed to read it back).
    const cached = await getCachedTransactions(ADDR);
    expect(cached).toEqual(first);
  });

  it('second refresh with identical history classifies 0 NEW txs and returns the same list', async () => {
    const history: TxHistoryItem[] = [
      { tx_hash: 't1', height: 100 },
      { tx_hash: 't2', height: 200 },
    ];
    const { provider, state } = makeFakeProvider(history);

    const first = await refreshTransactionCache(ADDR, provider);
    const callsAfterFirst = state.classifyCalls;
    expect(callsAfterFirst).toBe(2);

    const second = await refreshTransactionCache(ADDR, provider);

    // No NEW classification happened — only the light history was read.
    expect(state.classifyCalls - callsAfterFirst).toBe(0);
    expect(state.historyCalls).toBe(2); // history fetched on each refresh
    expect(second).toEqual(first);
  });

  it('a new tx_hash in history triggers exactly ONE new classification', async () => {
    const { provider, state } = makeFakeProvider([{ tx_hash: 't1', height: 100 }]);

    await refreshTransactionCache(ADDR, provider);
    const before = state.classifyCalls;

    // A new tx appears in history.
    state.history = [
      { tx_hash: 't1', height: 100 },
      { tx_hash: 't2', height: 150 },
    ];
    const result = await refreshTransactionCache(ADDR, provider);

    expect(state.classifyCalls - before).toBe(1); // only t2 reclassified
    expect(result.map((t) => t.txid).sort()).toEqual(['t1', 't2']);
  });

  it('a cached pending tx that gains a height is reclassified (pending -> confirmed)', async () => {
    const { provider, state } = makeFakeProvider([{ tx_hash: 't1', height: 0 }]); // pending

    const first = await refreshTransactionCache(ADDR, provider);
    expect(first[0].status).toBe('pending');
    expect(first[0].blockHeight).toBeUndefined();
    const before = state.classifyCalls;

    // t1 gets mined — its height changes.
    state.history = [{ tx_hash: 't1', height: 500 }];
    const second = await refreshTransactionCache(ADDR, provider);

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
    await refreshTransactionCache(ADDR, provider);

    // t1 disappears (dropped / replaced); only t2 remains in history.
    state.history = [{ tx_hash: 't2', height: 100 }];
    const result = await refreshTransactionCache(ADDR, provider);

    expect(result.map((t) => t.txid)).toEqual(['t2']);
    expect(await getCachedTransactions(ADDR)).toEqual(result);
  });

  it('returns the existing cache intact when the history fetch fails (resilience)', async () => {
    const { provider } = makeFakeProvider([
      { tx_hash: 't1', height: 100 },
      { tx_hash: 't2', height: 200 },
    ]);
    const first = await refreshTransactionCache(ADDR, provider);

    // Next history fetch throws — the cache must survive untouched.
    provider.getAddressHistory = async () => {
      throw new Error('network offline (fake)');
    };
    const second = await refreshTransactionCache(ADDR, provider);

    expect(second).toEqual(first);
    expect(await getCachedTransactions(ADDR)).toEqual(first);
  });

  it('a per-tx classification failure does not wipe already-cached txs', async () => {
    const { provider, state } = makeFakeProvider([{ tx_hash: 't1', height: 100 }]);
    const first = await refreshTransactionCache(ADDR, provider);
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
    const second = await refreshTransactionCache(ADDR, provider);

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

    await refreshTransactionCache(ADDR, provider);

    // Mempool first, then confirmed by height DESC.
    expect(state.classifiedOrder).toEqual(['mempool', 'newest', 'newer', 'old']);
  });

  it('CHECKPOINTS the cache mid-run (persists every 20 classified, not only at end)', async () => {
    // 45 new txs => checkpoints after the 20th and 40th classified tx, plus the
    // final write = 3 storage.set calls (the old serial code wrote exactly once).
    const { provider } = makeFakeProvider(makeHistory(45));
    const setSpy = vi.spyOn(storage, 'set');

    await refreshTransactionCache(ADDR, provider);

    expect(setSpy).toHaveBeenCalledTimes(3);
    // The FIRST persisted checkpoint already holds 20 classified txs — proof the
    // cache is durable mid-run, so an interruption resumes instead of restarting.
    const firstEntry = setSpy.mock.calls[0][1] as { txs: LiveTransaction[] };
    expect(firstEntry.txs).toHaveLength(20);
    const lastEntry = setSpy.mock.calls[2][1] as { txs: LiveTransaction[] };
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
    await refreshTransactionCache(ADDR, provider).catch(() => {});
    // 20 succeeded and were checkpointed; the rest threw (swallowed per-tx).
    const cached = await getCachedTransactions(ADDR);
    expect(cached.length).toBeGreaterThanOrEqual(20);

    // Second run with a healthy provider: only the NOT-yet-classified txs run.
    const before = state.classifyCalls;
    provider.classifyTxHash = original;
    const result = await refreshTransactionCache(ADDR, provider);
    // The 20 already-known txs are NOT re-classified; only the remaining 25 are.
    expect(state.classifyCalls - before).toBe(25);
    expect(result).toHaveLength(45);
  });

  it('reports progress via onProgress: (0,total) first, then after each batch, ending (total,total)', async () => {
    const { provider } = makeFakeProvider(makeHistory(45));
    const calls: Array<[number, number]> = [];

    await refreshTransactionCache(ADDR, provider, (done, total) => calls.push([done, total]));

    // One priming (0,total) call, then one per batch of 5 (ceil(45/5) = 9).
    expect(calls).toHaveLength(10);
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
    await refreshTransactionCache(ADDR, provider); // first run classifies the 3

    const calls: Array<[number, number]> = [];
    // Identical history => no delta => total 0 => no progress calls.
    await refreshTransactionCache(ADDR, provider, (done, total) => calls.push([done, total]));
    expect(calls).toHaveLength(0);
  });

  it('one failing tx in a batch does not block the other txs in the same batch', async () => {
    // Batch size is 5; put a thrower in the middle of the first batch.
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

    const result = await refreshTransactionCache(ADDR, provider);
    // Every sibling of the failed tx still classified; only 'boom' is missing.
    expect(result.map((t) => t.txid).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
