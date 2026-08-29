import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import {
  EVM_HISTORY_CACHE_MAX_ROWS,
  EVM_HISTORY_REFETCH_OVERLAP_BLOCKS,
  evmHistoryCacheKey,
  highestBlockOf,
  loadEvmHistoryCache,
  mergeEvmHistory,
  saveEvmHistoryCache,
  sinceBlockFor,
} from './evmHistoryCache';
import type { LiveTransaction } from '../services/chain/electrumProvider';

function row(over: Partial<LiveTransaction> & { txid: string }): LiveTransaction {
  return {
    asset: 'ETH',
    direction: 'in',
    amount: 1,
    feeEvr: 0,
    status: 'confirmed',
    blockHeight: 100,
    timestamp: 1_700_000_000,
    counterparty: '0xabc',
    ...over,
  };
}

beforeEach(() => setStorageForTests(new MemoryStorageAdapter()));

describe('evmHistoryCache', () => {
  it('1. key is per chain + lowercased address; save/load round-trips; junk reads as null', async () => {
    expect(evmHistoryCacheKey('base', '0xABC')).toBe('evmHistory:base:0xabc');
    expect(await loadEvmHistoryCache('base', '0xabc')).toBe(null);
    await saveEvmHistoryCache('base', '0xABC', { rows: [row({ txid: 'a' })], highestBlock: 100, fetchedAt: 5 });
    const got = await loadEvmHistoryCache('base', '0xabc');
    expect(got?.rows).toHaveLength(1);
    expect(got?.highestBlock).toBe(100);
  });

  it('2. sinceBlock = watermark minus the overlap (never negative), undefined without a cache', () => {
    expect(sinceBlockFor(null)).toBe(undefined);
    expect(sinceBlockFor({ rows: [], highestBlock: 0, fetchedAt: 0 })).toBe(undefined);
    expect(sinceBlockFor({ rows: [], highestBlock: 1000, fetchedAt: 0 })).toBe(BigInt(1000 - EVM_HISTORY_REFETCH_OVERLAP_BLOCKS));
    expect(sinceBlockFor({ rows: [], highestBlock: 5, fetchedAt: 0 })).toBe(0n);
  });

  it('3. merge: fresh wins on identity, cached rows survive, a cached pending is replaced by its confirmed row, newest first, capped', () => {
    const cached = [
      row({ txid: 'p', status: 'pending', blockHeight: undefined, timestamp: 9 }),
      row({ txid: 'b', blockHeight: 90 }),
      row({ txid: 'a', blockHeight: 80 }),
    ];
    const fresh = [row({ txid: 'p', blockHeight: 120 }), row({ txid: 'c', blockHeight: 110 }), row({ txid: 'b', blockHeight: 90, amount: 1 })];
    const merged = mergeEvmHistory(cached, fresh);
    expect(merged.map((t) => t.txid)).toEqual(['p', 'c', 'b', 'a']);
    expect(merged[0].status).toBe('confirmed');
    expect(highestBlockOf(merged)).toBe(120);
    // Two legs of one tx are two rows (asset differs): both kept.
    const two = mergeEvmHistory([], [row({ txid: 'x', asset: 'ETH' }), row({ txid: 'x', asset: 'USDC' })]);
    expect(two).toHaveLength(2);
    // Cap.
    const many = Array.from({ length: EVM_HISTORY_CACHE_MAX_ROWS + 50 }, (_, i) => row({ txid: `t${i}`, blockHeight: i }));
    expect(mergeEvmHistory(many, [])).toHaveLength(EVM_HISTORY_CACHE_MAX_ROWS);
    expect(mergeEvmHistory(many, [])[0].blockHeight).toBe(EVM_HISTORY_CACHE_MAX_ROWS + 49);
  });

  // --- native-staking labels -------------------------------------------------
  // The label is bought with an extra RPC and must survive both the merge and
  // the trip through storage, or it would be re-bought on every single refresh.

  const staked = { kind: 'stake' as const, validator: 'epixvaloper1abc', amountBase: 2_500_000_000_000_000_000n };

  it('4. merge: a fresh indexer row with no label KEEPS the one the cache already had', () => {
    const cached = [row({ txid: 's', staking: staked })];
    // Same identity, freshly indexed, and (as this chain's source always does)
    // with no calldata to decode.
    const fresh = [row({ txid: 's' })];
    expect(mergeEvmHistory(cached, fresh)[0].staking).toEqual(staked);
    // A fresh row that DOES carry its own label keeps its own.
    const own = { kind: 'claim' as const, validator: 'epixvaloper1xyz' };
    expect(mergeEvmHistory(cached, [row({ txid: 's', staking: own })])[0].staking).toEqual(own);
    // A row that was never a staking row stays unlabelled.
    expect(mergeEvmHistory([row({ txid: 'n' })], [row({ txid: 'n' })])[0].staking).toBeUndefined();
  });

  it("4b. merge: a CLAIM's receipt-read amount survives a fresh row that has none, but never moves onto a different call", () => {
    const claimed = { kind: 'claim' as const, validator: 'epixvaloper1abc', amountBase: 44_008_664_215_885_200n };
    // The realistic case: the fresh indexer row for this chain carries no
    // calldata, so no label at all. The whole label, amount included, survives.
    expect(mergeEvmHistory([row({ txid: 'c', staking: claimed })], [row({ txid: 'c' })])[0].staking).toEqual(claimed);
    // A fresh row that DID decode its own calldata still has no amount (a claim
    // never carries one there). The cached figure fills it in, so the receipt is
    // not bought a second time.
    const fresh = row({ txid: 'c', staking: { kind: 'claim' as const, validator: 'epixvaloper1abc' } });
    expect(mergeEvmHistory([row({ txid: 'c', staking: claimed })], [fresh])[0].staking).toEqual(claimed);
    // A different validator, or a different kind: the amount stays behind.
    const elsewhere = row({ txid: 'c', staking: { kind: 'claim' as const, validator: 'epixvaloper1xyz' } });
    expect(mergeEvmHistory([row({ txid: 'c', staking: claimed })], [elsewhere])[0].staking!.amountBase).toBeUndefined();
  });

  it('4c. merge: the FEE is never inherited from the cache. The indexer row carries the real gasUsed x gasPrice and always wins', () => {
    // A just-broadcast row was built from a local fee ESTIMATE; the indexer's
    // confirmed row for the same txid carries what the chain actually charged.
    const local = row({ txid: 'f', status: 'pending', blockHeight: undefined, feeEvr: 0.00299538, staking: staked });
    const indexed = row({ txid: 'f', status: 'confirmed', blockHeight: 900_001, feeEvr: 0.0025284 });
    const merged = mergeEvmHistory([local], [indexed]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('confirmed');
    expect(merged[0].feeEvr).toBe(0.0025284);
    // Same when the two rows share an identity rather than only a txid (the
    // pending row is not dropped but merged over): still the indexer's fee.
    const sameKey = mergeEvmHistory([{ ...local, status: 'confirmed', blockHeight: 900_001 }], [indexed]);
    expect(sameKey[0].feeEvr).toBe(0.0025284);
    // ...and the label the cache paid for is still there.
    expect(sameKey[0].staking).toEqual(staked);
  });

  it('5. storage round-trip: the amount survives as an exact bigint, and the entry does not throw on save', async () => {
    await saveEvmHistoryCache('epix', '0xABC', {
      rows: [row({ txid: 's', staking: staked }), row({ txid: 'plain' })],
      highestBlock: 900,
      fetchedAt: 7,
    });
    const got = await loadEvmHistoryCache('epix', '0xabc');
    expect(got!.rows[0].staking).toEqual(staked);
    expect(typeof got!.rows[0].staking!.amountBase).toBe('bigint');
    expect(got!.rows[1].staking).toBeUndefined();

    // A CLAIM's amount, which the receipt read filled in, round-trips the same
    // way, INCLUDING an exact zero: "known to be nothing" must survive, or the
    // receipt is bought again in the next session.
    await saveEvmHistoryCache('epix', '0xdef', {
      rows: [
        row({ txid: 'c', staking: { kind: 'claim', validator: 'epixvaloper1abc', amountBase: 44_008_664_215_885_200n } }),
        row({ txid: 'z', staking: { kind: 'claim', validator: 'epixvaloper1abc', amountBase: 0n } }),
        row({ txid: 'u', staking: { kind: 'claim', validator: 'epixvaloper1abc' } }),
      ],
      highestBlock: 900,
      fetchedAt: 7,
    });
    const claims = await loadEvmHistoryCache('epix', '0xdef');
    expect(claims!.rows[0].staking!.amountBase).toBe(44_008_664_215_885_200n);
    expect(claims!.rows[1].staking!.amountBase).toBe(0n);
    expect(claims!.rows[2].staking!.amountBase).toBeUndefined();
  });

  it('6. a saved label this build cannot read comes back UNLABELLED rather than mislabelled', async () => {
    // Written straight into storage, bypassing the save path: an older or
    // corrupted shape.
    const storage = new MemoryStorageAdapter();
    setStorageForTests(storage);
    await storage.set(evmHistoryCacheKey('epix', '0xabc'), {
      rows: [
        { ...row({ txid: 'a' }), staking: { kind: 'nonsense', validator: 'x' } },
        { ...row({ txid: 'b' }), staking: { kind: 'stake', validator: '' } },
        { ...row({ txid: 'c' }), staking: { kind: 'stake', validator: 'epixvaloper1abc', amountBase: 'not a number' } },
      ],
      highestBlock: 1,
      fetchedAt: 1,
    });
    const got = await loadEvmHistoryCache('epix', '0xabc');
    expect(got!.rows[0].staking).toBeUndefined();
    expect(got!.rows[1].staking).toBeUndefined();
    // A readable label with an unreadable amount keeps the label and drops the
    // amount: the row says WHERE, and no figure is invented.
    expect(got!.rows[2].staking).toEqual({ kind: 'stake', validator: 'epixvaloper1abc' });
  });
});
