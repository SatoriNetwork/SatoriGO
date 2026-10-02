import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageAdapter, getStorage, setStorageForTests } from '../../storage';
import {
  ZCASH_HISTORY_CAP,
  capZcashHistory,
  deleteZcashHistory,
  emptyZcashHistory,
  loadZcashHistory,
  saveZcashHistory,
  zcashHistoryKey,
} from './historyCache';
import type { ZcashTxRecord } from './reader';

const A0 = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F';

function rec(i: number, over: Partial<ZcashTxRecord> = {}): ZcashTxRecord {
  return {
    txid: i.toString(16).padStart(64, '0'),
    height: 1_000_000 + i,
    version: 5,
    received: BigInt(i) * 1000n,
    sent: 0n,
    fee: null,
    addresses: [],
    coinbase: false,
    ...over,
  };
}

beforeEach(() => setStorageForTests(new MemoryStorageAdapter()));

describe('zcash history cache', () => {
  it('key is zec:history:<walletId>; no id, no key', () => {
    expect(zcashHistoryKey('w1')).toBe('zec:history:w1');
    expect(() => zcashHistoryKey('')).toThrow();
  });

  it('round-trips records with bigint amounts, null fee and own outputs', async () => {
    const cache = {
      ...emptyZcashHistory(),
      scannedTo: 3_499_700,
      activeAddresses: [A0, A0],
      txs: [
        rec(1, { sent: 250_000_000_000_000n, fee: 10_000n, addresses: [A0], ownOutputs: [{ index: 1, valueZat: 99n }] }),
        rec(2, { version: 'unknown', txid: `unrecognised:${'cd'.repeat(32)}`, height: 1_000_050 }),
      ],
    };
    await saveZcashHistory('w1', cache);
    // What storage holds is JSON-safe: no bigint anywhere.
    const stored = await getStorage().get<unknown>('zec:history:w1');
    expect(() => JSON.stringify(stored)).not.toThrow();
    expect(JSON.stringify(stored)).not.toMatch(/"hex"/);

    const back = await loadZcashHistory('w1');
    expect(back?.scannedTo).toBe(3_499_700);
    expect(back?.activeAddresses).toEqual([A0]);
    expect(back?.txs).toHaveLength(2);
    expect(back?.txs[0].version).toBe('unknown'); // newest first (higher height)
    const r1 = back?.txs[1] as ZcashTxRecord;
    expect(r1.sent).toBe(250_000_000_000_000n);
    expect(r1.fee).toBe(10_000n);
    expect(r1.ownOutputs).toEqual([{ index: 1, valueZat: 99n }]);
    expect(back?.txs[0].fee).toBeNull();
  });

  it('keeps at most 500 records, dropping the oldest', async () => {
    const txs = Array.from({ length: ZCASH_HISTORY_CAP + 20 }, (_, i) => rec(i + 1));
    await saveZcashHistory('w1', { ...emptyZcashHistory(), scannedTo: 5, txs });
    const back = await loadZcashHistory('w1');
    expect(back?.txs).toHaveLength(ZCASH_HISTORY_CAP);
    expect(back?.txs[0].height).toBe(1_000_000 + ZCASH_HISTORY_CAP + 20);
    expect(back?.txs.at(-1)?.height).toBe(1_000_000 + 21);
    expect(capZcashHistory(txs)).toHaveLength(ZCASH_HISTORY_CAP);
  });

  it('a missing, foreign or damaged entry reads as null', async () => {
    expect(await loadZcashHistory('none')).toBeNull();
    expect(await loadZcashHistory('')).toBeNull();
    const s = getStorage();
    await s.set('zec:history:a', { v: 2, scannedTo: 1, activeAddresses: [], txs: [] });
    await s.set('zec:history:b', { v: 1, scannedTo: -1, activeAddresses: [], txs: [] });
    await s.set('zec:history:c', { v: 1, scannedTo: 1, activeAddresses: [], txs: [{ txid: 'x', received: 5 }] });
    await s.set('zec:history:d', 'junk');
    for (const id of ['a', 'b', 'c', 'd']) expect(await loadZcashHistory(id)).toBeNull();
  });

  it('drops watch addresses that are not transparent mainnet', async () => {
    await getStorage().set('zec:history:w', { v: 1, scannedTo: 1, activeAddresses: [A0, 'u1xyz', 5], txs: [] });
    expect((await loadZcashHistory('w'))?.activeAddresses).toEqual([A0]);
  });

  it('delete removes the entry; a storage failure on save is swallowed', async () => {
    await saveZcashHistory('w1', emptyZcashHistory());
    expect(await loadZcashHistory('w1')).not.toBeNull();
    await deleteZcashHistory('w1');
    expect(await loadZcashHistory('w1')).toBeNull();

    const broken = new MemoryStorageAdapter();
    broken.set = async () => {
      throw new Error('quota');
    };
    setStorageForTests(broken);
    await expect(saveZcashHistory('w1', emptyZcashHistory())).resolves.toBeUndefined();
  });
});
