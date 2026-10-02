import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ZcashSnapshot, ZcashTxRecord } from '../services/chain/zcash/reader';
import type { ZcashLocalSend } from './zcashSend';

const hoisted = vi.hoisted(() => ({
  activeWalletId: 'w1' as string | null,
  wallets: [] as Array<{ id: string; family: string; zcashWatch?: string[] }>,
  snapshot: null as unknown,
  localSends: [] as ZcashLocalSend[],
}));

vi.mock('./liveStore', () => ({
  useLiveStore: {
    getState: () => ({
      activeWalletId: hoisted.activeWalletId,
      wallets: hoisted.wallets,
      zcash: { snapshot: hoisted.snapshot },
    }),
  },
}));

const classifySendMock = vi.fn();
vi.mock('../services/chain/zcash/reader', () => ({
  classifySend: (...args: unknown[]) => classifySendMock(...args),
}));

vi.mock('../services/chain/zcash/fees', () => ({
  parseZec: (s: string) => {
    if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error('bad amount');
    const [w, f = ''] = s.split('.');
    return BigInt(w) * 100_000_000n + BigInt(f.padEnd(8, '0'));
  },
  formatZec: (zat: bigint) => {
    const s = zat.toString().padStart(9, '0');
    const whole = s.slice(0, -8) || '0';
    const frac = s.slice(-8).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  },
}));

// zcashHistory.ts only needs loadLocalZcashSends + the ZcashLocalSend type
// from zcashSend.ts; mocked here (rather than exercised for real) so this
// file does not also have to stand in for zcashSend.ts's OWN dependencies
// (rpc.ts, address.ts, builder.ts — covered by zcashSend.test.ts instead).
vi.mock('./zcashSend', () => ({
  loadLocalZcashSends: async (walletId: string) => (walletId === 'w1' ? hoisted.localSends : []),
}));

import { refreshZcashHistory, expiredZcashSends, toLiveTransaction } from './zcashHistory';

function fakeSnapshot(history: ZcashTxRecord[] = []): ZcashSnapshot {
  return {
    info: { chainName: 'main', height: 3_500_000, estimatedHeight: 3_500_000, consensusBranchId: 1, upgradeName: '', upgradeHeight: 0, taddrSupport: true },
    confirmed: 0n,
    pendingIn: 0n,
    pendingOut: 0n,
    spendable: [],
    unspendable: [],
    utxosTruncated: false,
    history,
    mempool: [],
    pending: [],
    cache: { v: 1, scannedTo: 0, activeAddresses: [], txs: [] },
  } as ZcashSnapshot;
}

function txRecord(overrides: Partial<ZcashTxRecord> = {}): ZcashTxRecord {
  return {
    txid: 'tx1',
    height: 3_499_000,
    version: 5,
    received: 100_000_000n,
    sent: 0n,
    fee: null,
    addresses: ['t1counterparty', 't1primary'],
    coinbase: false,
    ...overrides,
  };
}

describe('toLiveTransaction', () => {
  it('a pure receipt: direction in, net amount, no fee, counterparty is the non-owned address', () => {
    const row = toLiveTransaction(txRecord(), new Set(['t1primary']));
    expect(row).toMatchObject({
      txid: 'tx1',
      asset: 'ZEC',
      direction: 'in',
      amount: 1,
      feeEvr: 0,
      status: 'confirmed',
      blockHeight: 3_499_000,
      counterparty: 't1counterparty',
    });
  });

  it('a send: direction out, net = sent - received, fee shown', () => {
    const row = toLiveTransaction(
      txRecord({ sent: 100_010_000n, received: 0n, fee: 10_000n, addresses: ['t1primary', 't1recipient'] }),
      new Set(['t1primary']),
    );
    expect(row.direction).toBe('out');
    expect(row.amount).toBe(1.0001);
    expect(row.feeEvr).toBe(0.0001);
    expect(row.counterparty).toBe('t1recipient');
  });

  it('a self-transfer (every address ours) falls back to the first address', () => {
    const row = toLiveTransaction(
      txRecord({ sent: 10_000n, received: 0n, fee: 10_000n, addresses: ['t1primary'] }),
      new Set(['t1primary']),
    );
    expect(row.counterparty).toBe('t1primary');
  });

  it('an unconfirmed row (height null) reports pending', () => {
    const row = toLiveTransaction(txRecord({ height: null }), new Set(['t1primary']));
    expect(row.status).toBe('pending');
    expect(row.blockHeight).toBeUndefined();
  });
});

describe('refreshZcashHistory', () => {
  beforeEach(() => {
    hoisted.activeWalletId = 'w1';
    hoisted.wallets = [{ id: 'w1', family: 'zcash', zcashWatch: ['t1primary'] }];
    hoisted.snapshot = fakeSnapshot();
    hoisted.localSends = [];
    classifySendMock.mockReset();
  });

  it('returns [] when this wallet is not the active zcash wallet', async () => {
    hoisted.activeWalletId = 'other';
    expect(await refreshZcashHistory('w1')).toEqual([]);
  });

  it('returns [] when the active wallet is not a zcash wallet', async () => {
    hoisted.wallets = [{ id: 'w1', family: 'utxo' }];
    expect(await refreshZcashHistory('w1')).toEqual([]);
  });

  it('returns [] when no snapshot has loaded yet', async () => {
    hoisted.snapshot = null;
    expect(await refreshZcashHistory('w1')).toEqual([]);
  });

  it('maps the snapshot history rows, newest (by height) first', async () => {
    hoisted.snapshot = fakeSnapshot([txRecord({ txid: 'old', height: 100 }), txRecord({ txid: 'new', height: 200 })]);
    const rows = await refreshZcashHistory('w1');
    expect(rows.map((r) => r.txid)).toEqual(['new', 'old']);
  });

  it('adds a pending row for a local send not yet in the chain history', async () => {
    hoisted.localSends = [{ txid: 'pending1', expiryHeight: 3_500_050, sentAt: 555, hex: 'aa', amountZec: '0.5', feeZec: '0.0001' }];
    classifySendMock.mockReturnValue('pending');

    const rows = await refreshZcashHistory('w1');
    expect(rows).toHaveLength(1);
    // amount + fee (what left), the same figure the confirmed chain row shows.
    expect(rows[0]).toMatchObject({ txid: 'pending1', status: 'pending', direction: 'out', amount: 0.5001, feeEvr: 0.0001, timestamp: 555 });
    expect(classifySendMock).toHaveBeenCalledWith({ txid: 'pending1', expiryHeight: 3_500_050 }, hoisted.snapshot);
  });

  it('does not duplicate a local send whose txid already landed in history, and never classifies it', async () => {
    hoisted.snapshot = fakeSnapshot([txRecord({ txid: 'landed', height: 100 })]);
    hoisted.localSends = [{ txid: 'landed', expiryHeight: 999, sentAt: 1, hex: 'aa' }];
    const rows = await refreshZcashHistory('w1');
    expect(rows).toHaveLength(1);
    expect(classifySendMock).not.toHaveBeenCalled();
  });

  it('drops a local send the snapshot now reports EXPIRED from the rows; expiredZcashSends is what surfaces it', async () => {
    hoisted.localSends = [
      { txid: 'expired1', expiryHeight: 1, sentAt: 1, hex: 'aa', amountZec: '0.5' },
      { txid: 'stillpending', expiryHeight: 999, sentAt: 2, hex: 'bb' },
    ];
    classifySendMock.mockImplementation((record: { txid: string }) => (record.txid === 'expired1' ? 'expired' : 'pending'));
    const rows = await refreshZcashHistory('w1');
    expect(rows.map((r) => r.txid)).toEqual(['stillpending']);
    const expired = await expiredZcashSends('w1');
    expect(expired.map((s) => s.txid)).toEqual(['expired1']);
    expect(expired[0].amountZec).toBe('0.5');
  });

  it('expiredZcashSends answers [] for a non-active wallet or before a snapshot loaded', async () => {
    hoisted.localSends = [{ txid: 'expired1', expiryHeight: 1, sentAt: 1, hex: 'aa' }];
    classifySendMock.mockReturnValue('expired');
    expect(await expiredZcashSends('other')).toEqual([]);
    hoisted.snapshot = null;
    expect(await expiredZcashSends('w1')).toEqual([]);
  });

  it('drops a local send reported confirmed-but-not-yet-parsed-into-history (avoids a transient duplicate)', async () => {
    hoisted.localSends = [{ txid: 'confirmedElsewhere', expiryHeight: 999, sentAt: 1, hex: 'aa' }];
    classifySendMock.mockReturnValue('confirmed');
    const rows = await refreshZcashHistory('w1');
    expect(rows).toEqual([]);
  });

  it('sorts pending rows before confirmed rows', async () => {
    hoisted.snapshot = fakeSnapshot([txRecord({ txid: 'confirmed1', height: 100 })]);
    hoisted.localSends = [{ txid: 'pending1', expiryHeight: 999, sentAt: 1, hex: 'aa' }];
    classifySendMock.mockReturnValue('pending');
    const rows = await refreshZcashHistory('w1');
    expect(rows.map((r) => r.txid)).toEqual(['pending1', 'confirmed1']);
  });

  it('the pending row and the confirmed row of the same send show the same amount', async () => {
    hoisted.localSends = [{ txid: 'same', expiryHeight: 3_500_050, sentAt: 1, hex: 'aa', amountZec: '0.0006', feeZec: '0.0001' }];
    classifySendMock.mockReturnValue('pending');
    const [pendingRow] = await refreshZcashHistory('w1');
    // On chain: 100,000 zat in, 30,000 change back: 70,000 left (60,000 sent + 10,000 fee).
    const chainRow = toLiveTransaction(txRecord({ txid: 'same', height: 100, sent: 100_000n, received: 30_000n, fee: 10_000n }), new Set());
    expect(pendingRow.amount).toBe(chainRow.amount);
    expect(pendingRow.feeEvr).toBe(chainRow.feeEvr);
  });

  it('a local send with no recorded display figures shows amount/fee 0 rather than throwing', async () => {
    hoisted.localSends = [{ txid: 'bare', expiryHeight: 999, sentAt: 1, hex: 'aa' }];
    classifySendMock.mockReturnValue('pending');
    const rows = await refreshZcashHistory('w1');
    expect(rows[0]).toMatchObject({ amount: 0, feeEvr: 0, counterparty: '' });
  });
});
