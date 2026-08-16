// Wallet-level aggregation of per-address transaction classifications.
//
// Each of a wallet's addresses classifies the same transaction independently and
// only sees its own side of it. The old merge picked ONE of those entries and
// showed it as the wallet's movement, so a send of 1 coin out of a 100-coin utxo
// with the change returning to another of our own addresses read as "out 100".
// These fixtures are that failure and its neighbours.

import { describe, expect, it } from 'vitest';
import { mergeTransactions } from './liveStore';
import type { LiveTransaction } from '../services/chain/electrumProvider';

/** One address's view of a transaction. */
function view(
  over: Partial<LiveTransaction> & Pick<LiveTransaction, 'direction' | 'amount'>,
): LiveTransaction {
  return {
    txid: 'tx1',
    asset: 'EVR',
    feeEvr: 0,
    status: 'confirmed',
    blockHeight: 100,
    timestamp: 1_700_000_000_000,
    counterparty: 'Eexternal000000000000000000000000',
    ...over,
  };
}

describe('mergeTransactions', () => {
  it('reports the WALLET net, not one address, when change returns to another of our addresses', () => {
    // Send 1.0 to a stranger from a 100.0 utxo held at a secondary address;
    // 98.9999 change lands on the primary. Truth: 1.0001 left the wallet.
    const spender = view({
      direction: 'out',
      amount: 100,
      spentNative: 100,
      totalOutNative: 99.9999,
      feeEvr: 0.0001,
    });
    const changeReceiver = view({
      direction: 'in',
      amount: 98.9999,
      spentNative: 0,
      totalOutNative: 99.9999,
    });

    const [merged] = mergeTransactions([[spender], [changeReceiver]]);
    expect(merged.direction).toBe('out');
    expect(merged.amount).toBeCloseTo(1.0001, 8);
    expect(merged.feeEvr).toBeCloseTo(0.0001, 8);
  });

  it('sums inputs drawn from SEVERAL of our addresses, and the fee with them', () => {
    // Inputs 2.0 (secondary) + 0.5 (primary), 1.0 out, 1.4999 change to primary.
    const totalOut = 2.4999;
    const secondary = view({
      direction: 'out',
      amount: 2,
      spentNative: 2,
      totalOutNative: totalOut,
      feeEvr: 0,
    });
    // The primary both spends 0.5 and receives 1.4999 change: net +0.9999.
    const primary = view({
      direction: 'in',
      amount: 0.9999,
      spentNative: 0.5,
      totalOutNative: totalOut,
      feeEvr: 0,
    });

    const [merged] = mergeTransactions([[secondary], [primary]]);
    expect(merged.direction).toBe('out');
    expect(merged.amount).toBeCloseTo(1.0001, 8);
    // Per-address fees were both 0 (each clamped); the wallet really paid 0.0001.
    expect(merged.feeEvr).toBeCloseTo(0.0001, 8);
  });

  it('adds up an incoming payment split across two of our addresses', () => {
    // Someone pays us 10, split 5 + 5. Showing one entry would report half.
    const a = view({ direction: 'in', amount: 5, spentNative: 0, totalOutNative: 10 });
    const b = view({ direction: 'in', amount: 5, spentNative: 0, totalOutNative: 10 });

    const [merged] = mergeTransactions([[a], [b]]);
    expect(merged.direction).toBe('in');
    expect(merged.amount).toBeCloseTo(10, 8);
    expect(merged.feeEvr).toBe(0); // we sent nothing, so we paid no fee
  });

  it('nets a transfer between our OWN addresses down to what it actually cost', () => {
    // 4.0 moved from one of our addresses to another. The wallet is down only
    // the fee, and that is what the list should say.
    const from = view({
      direction: 'out',
      amount: 4.0001,
      spentNative: 4.0001,
      totalOutNative: 4,
      feeEvr: 0.0001,
    });
    const to = view({ direction: 'in', amount: 4, spentNative: 0, totalOutNative: 4 });

    const merged = mergeTransactions([[from], [to]]);
    expect(merged).toHaveLength(1); // still ONE row, not two
    expect(merged[0].direction).toBe('out');
    expect(merged[0].amount).toBeCloseTo(0.0001, 8);
  });

  it('leaves a single-address wallet exactly as the classifier saw it', () => {
    const only = view({ direction: 'out', amount: 5, spentNative: 5.5, totalOutNative: 5.4999, feeEvr: 0.0001 });
    expect(mergeTransactions([[only]])).toEqual([only]);
  });

  it('keeps the sender view for the descriptive fields', () => {
    const spender = view({
      direction: 'out',
      amount: 10,
      spentNative: 10,
      totalOutNative: 9.9999,
      counterparty: 'Erecipient00000000000000000000000',
    });
    const changeReceiver = view({
      direction: 'in',
      amount: 8.9999,
      spentNative: 0,
      totalOutNative: 9.9999,
      counterparty: 'Eourselves000000000000000000000000',
    });
    const [merged] = mergeTransactions([[spender], [changeReceiver]]);
    // The external recipient is the useful counterparty to show for a send.
    expect(merged.counterparty).toBe('Erecipient00000000000000000000000');
  });

  it('falls back to the per-address fee when an older cached entry has no raw fields', () => {
    // Entries written before the raw fields existed must not produce NaN or 0.
    const spender = view({ direction: 'out', amount: 100, feeEvr: 0.0001 });
    const changeReceiver = view({ direction: 'in', amount: 98.9999, feeEvr: 0 });
    const [merged] = mergeTransactions([[spender], [changeReceiver]]);
    expect(merged.amount).toBeCloseTo(1.0001, 8);
    expect(merged.feeEvr).toBeCloseTo(0.0001, 8);
  });

  it('dedupes by txid and sorts pending first, then by height descending', () => {
    const pending = view({ txid: 'p', direction: 'in', amount: 1, status: 'pending', blockHeight: undefined });
    const low = view({ txid: 'a', direction: 'in', amount: 1, blockHeight: 10 });
    const high = view({ txid: 'b', direction: 'in', amount: 1, blockHeight: 99 });
    const dupeOfHigh = view({ txid: 'b', direction: 'in', amount: 1, blockHeight: 99 });

    const merged = mergeTransactions([[low, high], [pending, dupeOfHigh]]);
    expect(merged.map((t) => t.txid)).toEqual(['p', 'b', 'a']);
  });
});
