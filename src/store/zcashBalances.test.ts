import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ZcashSnapshot } from '../services/chain/zcash/reader';
import type { ZcashHistoryCache } from '../services/chain/zcash/historyCache';

const hoisted = vi.hoisted(() => ({
  wallets: [] as Array<{ id: string; family: string; zcashWatch?: string[] }>,
  zcashChain: null as unknown,
}));

vi.mock('./liveStore', () => ({
  useLiveStore: {
    getState: () => ({
      wallets: hoisted.wallets,
      zcash: { chain: hoisted.zcashChain },
    }),
  },
}));

const zcashRpcMock = vi.fn((..._args: unknown[]) => ({ marker: 'fake-rpc' }));
vi.mock('../services/chain/zcash/rpc', () => ({
  zcashRpc: (...args: unknown[]) => zcashRpcMock(...args),
}));

const refreshZcashMock = vi.fn();
vi.mock('../services/chain/zcash/reader', () => ({
  refreshZcash: (...args: unknown[]) => refreshZcashMock(...args),
  // The real rule (reader.ts classifySend): in history = confirmed, in the
  // mempool = pending, three blocks past expiry AND /tx found nothing =
  // expired, else unknown.
  classifySend: (record: { txid: string; expiryHeight: number }, snap: ZcashSnapshot) => {
    if (snap.history.some((r) => r.txid === record.txid && r.height !== null && r.height > 0)) return 'confirmed';
    if (snap.mempool.some((t) => t.txid === record.txid)) return 'pending';
    if (record.expiryHeight > 0 && snap.info.height >= record.expiryHeight + 3 && snap.sendLookups?.[record.txid] === 'gone') return 'expired';
    return 'unknown';
  },
}));

const localSends = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock('./zcashSend', () => ({
  loadLocalZcashSends: async (walletId: string) => (walletId === 'w1' ? localSends.rows : []),
}));

const loadZcashHistoryMock = vi.fn();
const saveZcashHistoryMock = vi.fn();
vi.mock('../services/chain/zcash/historyCache', () => ({
  emptyZcashHistory: () => ({ v: 1, scannedTo: 0, activeAddresses: [], txs: [] }),
  loadZcashHistory: (...args: unknown[]) => loadZcashHistoryMock(...args),
  saveZcashHistory: (...args: unknown[]) => saveZcashHistoryMock(...args),
}));

import { refreshZcashWallet } from './zcashBalances';
import { ZCASH_CHAIN } from './zcashChain';

const WATCH = ['t1a', 't1b', 't1c'];
const EMPTY_CACHE: ZcashHistoryCache = { v: 1, scannedTo: 0, activeAddresses: [], txs: [] };

function fakeSnapshot(overrides: Partial<ZcashSnapshot> = {}): ZcashSnapshot {
  return {
    info: { chainName: 'main', height: 3_500_000, estimatedHeight: 3_500_000, consensusBranchId: 0x37a5165b, upgradeName: 'NU6.3', upgradeHeight: 0, taddrSupport: true },
    confirmed: 150_000_00n,
    pendingIn: 0n,
    pendingOut: 0n,
    spendable: [],
    unspendable: [],
    utxosTruncated: false,
    history: [],
    mempool: [],
    pending: [],
    cache: EMPTY_CACHE,
    ...overrides,
  } as ZcashSnapshot;
}

describe('refreshZcashWallet', () => {
  beforeEach(() => {
    hoisted.wallets = [];
    hoisted.zcashChain = null;
    zcashRpcMock.mockClear();
    refreshZcashMock.mockReset();
    loadZcashHistoryMock.mockReset();
    saveZcashHistoryMock.mockReset();
    loadZcashHistoryMock.mockResolvedValue(null);
    saveZcashHistoryMock.mockResolvedValue(undefined);
    localSends.rows = [];
  });

  it('throws when no wallet with this id is active', async () => {
    await expect(refreshZcashWallet('w1')).rejects.toThrow('No Zcash wallet is open.');
    expect(refreshZcashMock).not.toHaveBeenCalled();
  });

  it('throws when the wallet exists but is not a zcash wallet', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'utxo' }];
    await expect(refreshZcashWallet('w1')).rejects.toThrow('No Zcash wallet is open.');
  });

  it('throws when the zcash wallet has no watch addresses cached yet', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [] }];
    await expect(refreshZcashWallet('w1')).rejects.toThrow('No Zcash wallet is open.');
  });

  it('builds the rpc client from the gateway + the chain default node set, with an empty cache when none was saved', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
    refreshZcashMock.mockResolvedValue(fakeSnapshot());

    await refreshZcashWallet('w1');

    expect(zcashRpcMock).toHaveBeenCalledWith('', '', ZCASH_CHAIN.defaultNodeSet);
    expect(refreshZcashMock).toHaveBeenCalledWith({ marker: 'fake-rpc' }, WATCH, EMPTY_CACHE, undefined, []);
  });

  it('falls back to ZCASH_CHAIN when the store has not filled zcash.chain yet', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
    hoisted.zcashChain = null;
    refreshZcashMock.mockResolvedValue(fakeSnapshot());
    await refreshZcashWallet('w1');
    expect(zcashRpcMock).toHaveBeenCalledWith(expect.any(String), expect.any(String), ZCASH_CHAIN.defaultNodeSet);
  });

  it('passes the saved cache through to refreshZcash when one exists', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
    const saved: ZcashHistoryCache = { v: 1, scannedTo: 3_490_000, activeAddresses: ['t1a'], txs: [] };
    loadZcashHistoryMock.mockResolvedValue(saved);
    refreshZcashMock.mockResolvedValue(fakeSnapshot());

    await refreshZcashWallet('w1');

    expect(refreshZcashMock).toHaveBeenCalledWith(expect.anything(), WATCH, saved, undefined, []);
  });

  it('returns the snapshot and one native ZEC asset row for the confirmed balance', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
    const snap = fakeSnapshot({ confirmed: 123_456_789n });
    refreshZcashMock.mockResolvedValue(snap);

    const result = await refreshZcashWallet('w1');

    expect(result.snapshot).toBe(snap);
    expect(result.assets).toEqual([{ name: 'ZEC', amountBase: 123_456_789n, scale: 8, decimals: 8, isNative: true }]);
  });

  it('the balance row is confirmed minus what our pending sends take out (never incoming unconfirmed)', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
    refreshZcashMock.mockResolvedValue(fakeSnapshot({ confirmed: 100_000n, pendingOut: 15_000n, pendingIn: 7_000n }));
    const result = await refreshZcashWallet('w1');
    expect(result.assets[0].amountBase).toBe(85_000n);
    refreshZcashMock.mockResolvedValue(fakeSnapshot({ confirmed: 10_000n, pendingOut: 15_000n }));
    expect((await refreshZcashWallet('w1')).assets[0].amountBase).toBe(0n);
  });

  it('hands the local send records to the reader as own sends (outpoints, amount + fee)', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
    refreshZcashMock.mockResolvedValue(fakeSnapshot());
    localSends.rows = [
      { txid: 'ours', expiryHeight: 3_500_040, sentAt: 1, hex: '', spent: ['aa:1'], amountZec: '0.0001', feeZec: '0.00005' },
      { txid: 'old', expiryHeight: 3_500_041, sentAt: 1, hex: '', spent: [] },
    ];
    await refreshZcashWallet('w1');
    expect(refreshZcashMock.mock.calls[0][4]).toEqual([
      { txid: 'ours', expiryHeight: 3_500_040, spent: ['aa:1'], outflowZat: 15_000n },
      { txid: 'old', expiryHeight: 3_500_041, spent: [], outflowZat: null },
    ]);
  });

  it('saves EXACTLY the cache the snapshot itself carries (reader.ts owns the activeAddresses/scannedTo bookkeeping)', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
    const freshCache: ZcashHistoryCache = { v: 1, scannedTo: 3_600_000, activeAddresses: ['t1a', 't1spend'], txs: [{ txid: 'h1' } as ZcashHistoryCache['txs'][number]] };
    const snap = fakeSnapshot({ cache: freshCache });
    refreshZcashMock.mockResolvedValue(snap);

    await refreshZcashWallet('w1');

    expect(saveZcashHistoryMock).toHaveBeenCalledWith('w1', freshCache);
  });

  it('never throws when saving the next cache fails, and still returns the fresh snapshot', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
    saveZcashHistoryMock.mockRejectedValue(new Error('quota exceeded'));
    const snap = fakeSnapshot();
    refreshZcashMock.mockResolvedValue(snap);

    await expect(refreshZcashWallet('w1')).resolves.toEqual({ snapshot: snap, assets: expect.any(Array) });
  });

  it('propagates a refresh failure (the caller decides how to show "offline")', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
    refreshZcashMock.mockRejectedValue(new Error('gateway unreachable'));
    await expect(refreshZcashWallet('w1')).rejects.toThrow('gateway unreachable');
    expect(saveZcashHistoryMock).not.toHaveBeenCalled();
  });
});

// The inputs of this wallet's OWN not-yet-seen sends are held back from the
// spendable set: the gateway caches its mempool snapshot for a few seconds
// while the success screen refreshes at once, so without this a second send
// built right away picked the same inputs and was refused as a conflict.
describe('refreshZcashWallet: own pending sends hold their inputs back', () => {
  const utxo = (txid: string, index: number) =>
    ({ txid, index, value: 100n, address: 't1a', height: 10, script: '', coinbase: false }) as unknown as ZcashSnapshot['spendable'][number];

  beforeEach(() => {
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: [...WATCH] }];
  });

  it('a send the chain has not seen yet (unknown) removes its outpoints from spendable', async () => {
    refreshZcashMock.mockResolvedValue(fakeSnapshot({ spendable: [utxo('aa', 0), utxo('aa', 1), utxo('bb', 0)] }));
    localSends.rows = [{ txid: 'ours', expiryHeight: 3_500_040, sentAt: 1, hex: '', spent: ['aa:1', 'bb:0'] }];
    const { snapshot } = await refreshZcashWallet('w1');
    expect(snapshot.spendable.map((u) => `${u.txid}:${u.index}`)).toEqual(['aa:0']);
    // The balance figure is untouched: only the input set is.
    expect(snapshot.confirmed).toBe(150_000_00n);
  });

  it('a send already in the mempool (pending) still holds them back; a confirmed or expired one does not', async () => {
    const base = { spendable: [utxo('aa', 0), utxo('bb', 0), utxo('cc', 0)] };
    refreshZcashMock.mockResolvedValue(
      fakeSnapshot({ ...base, mempool: [{ txid: 'inmempool' }] as ZcashSnapshot['mempool'], sendLookups: { expired: 'gone' } }),
    );
    localSends.rows = [
      { txid: 'inmempool', expiryHeight: 3_500_040, sentAt: 1, hex: '', spent: ['aa:0'] },
      { txid: 'expired', expiryHeight: 3_400_000, sentAt: 1, hex: '', spent: ['bb:0'] },
    ];
    let result = await refreshZcashWallet('w1');
    expect(result.snapshot.spendable.map((u) => u.txid)).toEqual(['bb', 'cc']);

    refreshZcashMock.mockResolvedValue(
      fakeSnapshot({ ...base, history: [{ txid: 'mined', height: 3_499_999 }] as ZcashSnapshot['history'] }),
    );
    localSends.rows = [{ txid: 'mined', expiryHeight: 3_500_040, sentAt: 1, hex: '', spent: ['cc:0'] }];
    result = await refreshZcashWallet('w1');
    expect(result.snapshot.spendable.map((u) => u.txid)).toEqual(['aa', 'bb', 'cc']);
  });

  it('a record from before the spent field parses its own hex for the inputs', async () => {
    // A v5 transaction with one input (prevout aa..aa:1) and no outputs,
    // laid out exactly as tx.ts parseZcashTx reads it.
    const txid = 'aa'.repeat(32);
    const hex =
      '050000800a27a726' + // header (v5, overwintered) + version group id
      'b4d0d6c2' + // branch id
      '00000000' + // lock time
      '29683500' + // expiry height
      '01' + txid + '01000000' + '00' + 'ffffffff' + // vin: one input, empty scriptSig
      '00' + // vout: none
      '00' + '00' + // sapling spends/outputs: none
      '00'; // orchard actions: none
    refreshZcashMock.mockResolvedValue(fakeSnapshot({ spendable: [utxo(txid, 1), utxo(txid, 2)] }));
    localSends.rows = [{ txid: 'old', expiryHeight: 3_500_040, sentAt: 1, hex }];
    const { snapshot } = await refreshZcashWallet('w1');
    expect(snapshot.spendable.map((u) => u.index)).toEqual([2]);
  });

  it('a record that cannot be parsed holds nothing back and never throws', async () => {
    refreshZcashMock.mockResolvedValue(fakeSnapshot({ spendable: [utxo('aa', 0)] }));
    localSends.rows = [{ txid: 'junk', expiryHeight: 3_500_040, sentAt: 1, hex: 'zz' }];
    const { snapshot } = await refreshZcashWallet('w1');
    expect(snapshot.spendable).toHaveLength(1);
  });
});
