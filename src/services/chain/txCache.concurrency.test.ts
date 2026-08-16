// How many classify requests the tx cache puts on the wire at once.
//
// Two separate limits, and the distinction is the whole point:
//   - CLASSIFY_BATCH_SIZE is per ADDRESS. It was raised from 5 to 25 on measured
//     data (see the constant's comment in txCache.ts).
//   - MAX_CONCURRENT_CLASSIFY is per WALLET. A refresh runs one cache loop per
//     receive address, all at once, all over ONE socket, so without this the
//     batch size would multiply by the address count (up to 20) and a server
//     would see a burst five times larger than anything that was measured.
//
// These tests watch the FAKE PROVIDER, i.e. the requests that would actually
// reach a server, rather than asserting the constants back at themselves.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  refreshTransactionCache,
  type TransactionCacheProvider,
  type TxHistoryItem,
} from './txCache';
import type { LiveTransaction } from './electrumProvider';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';

const TEST_CHAIN = 'evrmore-mainnet';

/** The values txCache.ts declares. Duplicated here on purpose: a test that
 *  imported them could not fail if someone edited them by accident, and these
 *  two numbers are a promise made to other people's servers. */
const BATCH_PER_ADDRESS = 25;
const MAX_PER_WALLET = 100;

/** Highest number of classifyTxHash calls that were in flight simultaneously,
 *  measured across every address sharing this recorder. */
interface ConcurrencyRecorder {
  inFlight: number;
  peak: number;
  calls: number;
}

function makeHistory(n: number): TxHistoryItem[] {
  return Array.from({ length: n }, (_, i) => ({ tx_hash: `tx${i}`, height: 1000 - i }));
}

/** A provider whose classifyTxHash takes a real (tiny) turn of the event loop,
 *  so overlapping calls genuinely overlap and the peak is observable. */
function makeProvider(
  rec: ConcurrencyRecorder,
  history: TxHistoryItem[],
  behaviour: 'ok' | 'throw' = 'ok',
): TransactionCacheProvider {
  return {
    async getAddressHistory(): Promise<TxHistoryItem[]> {
      return history;
    },
    async classifyTxHash(_address, txHash, height): Promise<LiveTransaction | null> {
      rec.calls++;
      rec.inFlight++;
      rec.peak = Math.max(rec.peak, rec.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (behaviour === 'throw') throw new Error('classify failed');
        return {
          txid: txHash,
          asset: 'SATORIEVR',
          direction: 'in',
          amount: 1,
          feeEvr: 0,
          status: 'confirmed',
          blockHeight: height,
          timestamp: 1_700_000_000_000,
          counterparty: 'EcounterpartyAddress00000000000000',
        };
      } finally {
        rec.inFlight--;
      }
    },
  };
}

function newRecorder(): ConcurrencyRecorder {
  return { inFlight: 0, peak: 0, calls: 0 };
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

describe('classify concurrency', () => {
  it('ONE address never exceeds the per-address batch size', async () => {
    const rec = newRecorder();
    const history = makeHistory(BATCH_PER_ADDRESS * 3 + 7);
    await refreshTransactionCache(TEST_CHAIN, 'Eaddr0', makeProvider(rec, history));

    expect(rec.calls).toBe(history.length);
    expect(rec.peak).toBe(BATCH_PER_ADDRESS);
    expect(rec.inFlight).toBe(0);
  });

  it('a single-address wallet gets the FULL batch, never throttled by the wallet cap', async () => {
    // The common case (a Satori single-key wallet). Nothing should ever wait.
    const rec = newRecorder();
    await refreshTransactionCache(TEST_CHAIN, 'Eaddr0', makeProvider(rec, makeHistory(200)));
    expect(rec.peak).toBe(BATCH_PER_ADDRESS);
  });

  it('MANY addresses at once stay under the wallet-wide ceiling', async () => {
    // 20 addresses is MAX_RECEIVE_ADDRESSES: the worst case a real wallet can
    // reach. Without the ceiling this would be 20 x 25 = 500 concurrent requests.
    const rec = newRecorder();
    const addresses = Array.from({ length: 20 }, (_, i) => `Eaddr${i}`);
    await Promise.all(
      addresses.map((a) => refreshTransactionCache(TEST_CHAIN, a, makeProvider(rec, makeHistory(40)))),
    );

    expect(rec.calls).toBe(20 * 40);
    expect(rec.peak).toBeLessThanOrEqual(MAX_PER_WALLET);
    // And the ceiling is actually REACHED, so the test would notice a cap that
    // had been set uselessly low as well as one set too high.
    expect(rec.peak).toBe(MAX_PER_WALLET);
    expect(rec.inFlight).toBe(0);
  });

  it('the wallet-wide worst case is no larger than it was before the batch was raised', async () => {
    // The old behaviour was batch 5 x up to 20 addresses = 100 concurrent. That
    // number is the ceiling now, so no server sees a bigger burst than this
    // wallet already sent, whatever the address count.
    expect(MAX_PER_WALLET).toBe(5 * 20);
  });

  it('slots are released when classification FAILS, so a later refresh is not starved', async () => {
    // A leaked slot would not fail here, it would hang forever. The second
    // refresh completing at full batch width is the proof it did not leak.
    const failing = newRecorder();
    const addresses = Array.from({ length: 8 }, (_, i) => `Efail${i}`);
    await Promise.all(
      addresses.map((a) =>
        refreshTransactionCache(TEST_CHAIN, a, makeProvider(failing, makeHistory(30), 'throw')),
      ),
    );
    expect(failing.inFlight).toBe(0);

    const healthy = newRecorder();
    const result = await refreshTransactionCache(
      TEST_CHAIN,
      'Eafter',
      makeProvider(healthy, makeHistory(60)),
    );
    expect(result).toHaveLength(60);
    expect(healthy.peak).toBe(BATCH_PER_ADDRESS);
  });

  it('every address still finishes: a queued address is not starved by a busy one', async () => {
    // FIFO hand-off, so the address that queues first runs first. What matters
    // for correctness is only that all of them complete.
    const rec = newRecorder();
    const addresses = Array.from({ length: 12 }, (_, i) => `Equeue${i}`);
    const results = await Promise.all(
      addresses.map((a) => refreshTransactionCache(TEST_CHAIN, a, makeProvider(rec, makeHistory(30)))),
    );
    for (const r of results) expect(r).toHaveLength(30);
    expect(rec.inFlight).toBe(0);
  });
});
