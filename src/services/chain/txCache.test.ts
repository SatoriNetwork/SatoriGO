// vitest tests for the local transaction cache (node env).
// Uses a fake TransactionCacheProvider + an in-memory storage adapter, so no
// WebSocket and no chrome.storage are touched.

import { beforeEach, describe, expect, it } from 'vitest';
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
}

function makeFakeProvider(initialHistory: TxHistoryItem[]): {
  provider: TransactionCacheProvider;
  state: FakeProviderState;
} {
  const state: FakeProviderState = {
    history: initialHistory,
    classifyCalls: 0,
    historyCalls: 0,
  };
  const provider: TransactionCacheProvider = {
    async getAddressHistory(): Promise<TxHistoryItem[]> {
      state.historyCalls++;
      return state.history;
    },
    async classifyTxHash(_address, txHash, height): Promise<LiveTransaction | null> {
      state.classifyCalls++;
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

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

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
});
