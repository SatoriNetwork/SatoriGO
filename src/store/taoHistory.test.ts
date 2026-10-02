// taoHistory.ts is LOCAL ONLY (the owner's 2026-09-28 OVERRIDE, design §1: no
// Taostats fetch in v1) and is a thin mapper over Set B's real
// services/chain/substrate/historyClient.ts (loadTaoHistory already owns
// storage, normalization and the empty-on-failure contract) — see the file
// header for why recordTaoSend/updateTaoSend are NOT reimplemented here.
// loadTaoHistory/formatTao are mocked down to the shapes this file actually
// uses so this test does not depend on Set B's real storage backend.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaoTransfer } from '../services/chain/substrate';

const hoisted = vi.hoisted(() => ({
  store: new Map<string, TaoTransfer[]>(),
}));

vi.mock('../services/chain/substrate', () => ({
  loadTaoHistory: vi.fn(async (walletId: string) => hoisted.store.get(walletId) ?? []),
  formatTao: (rao: bigint) => {
    const s = rao.toString().padStart(10, '0');
    const whole = s.slice(0, -9) || '0';
    const frac = s.slice(-9).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  },
}));

import { refreshTaoHistory } from './taoHistory';

function transfer(overrides: Partial<TaoTransfer> = {}): TaoTransfer {
  return {
    hash: '0xh1',
    block: 0,
    timestamp: 1000,
    from: '5from',
    to: '5to',
    amount: 1_000_000_000n, // 1 TAO
    fee: 83_124n,
    extrinsicId: '',
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.store.clear();
});

describe('refreshTaoHistory', () => {
  it('returns an empty list when nothing was ever recorded', async () => {
    expect(await refreshTaoHistory('w1')).toEqual([]);
  });

  it('maps a pending send (status pending, no block yet) to a pending, outgoing LiveTransaction', async () => {
    hoisted.store.set('w1', [transfer({ status: 'pending' })]);
    const rows = await refreshTaoHistory('w1');
    expect(rows).toEqual([
      {
        txid: '0xh1',
        asset: 'TAO',
        direction: 'out',
        amount: 1,
        feeEvr: 0.000083124,
        status: 'pending',
        blockHeight: undefined,
        timestamp: 1000,
        counterparty: '5to',
      },
    ]);
  });

  it('maps an included send to a confirmed row with a block height', async () => {
    hoisted.store.set('w1', [transfer({ status: 'included', block: 9_168_516 })]);
    const [row] = await refreshTaoHistory('w1');
    expect(row.status).toBe('confirmed');
    expect(row.blockHeight).toBe(9_168_516);
  });

  it('maps an expired send to a pending row (never included; the wallet says "send again" elsewhere)', async () => {
    hoisted.store.set('w1', [transfer({ status: 'expired' })]);
    const [row] = await refreshTaoHistory('w1');
    expect(row.status).toBe('pending');
  });

  it('falls back to block > 0 for a row with no status field (pre-status local record)', async () => {
    hoisted.store.set('w1', [transfer({ status: undefined, block: 9_168_516 })]);
    const [row] = await refreshTaoHistory('w1');
    expect(row.status).toBe('confirmed');
  });

  it('sorts newest first', async () => {
    hoisted.store.set('w1', [
      transfer({ hash: '0xold', timestamp: 100 }),
      transfer({ hash: '0xnew', timestamp: 900 }),
    ]);
    const rows = await refreshTaoHistory('w1');
    expect(rows.map((r) => r.txid)).toEqual(['0xnew', '0xold']);
  });

  it('is scoped per wallet id', async () => {
    hoisted.store.set('w1', [transfer({ hash: '0xw1' })]);
    hoisted.store.set('w2', [transfer({ hash: '0xw2' })]);
    expect((await refreshTaoHistory('w1')).map((r) => r.txid)).toEqual(['0xw1']);
    expect((await refreshTaoHistory('w2')).map((r) => r.txid)).toEqual(['0xw2']);
  });
});
