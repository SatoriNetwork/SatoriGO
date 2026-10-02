import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageAdapter, getStorage, setStorageForTests } from '../../storage';
import {
  TAO_HISTORY_CAP,
  deleteTaoHistory,
  inclusionTargetOf,
  loadTaoHistory,
  normalizeTaoHistory,
  pendingTaoSends,
  recordTaoSend,
  saveTaoHistory,
  taoHistoryKey,
  taoTransferFromPlan,
  updateTaoSend,
  type TaoTransfer,
} from './historyClient';
import type { TaoSendPlan } from './sender';
import { ss58Encode } from './ss58';
import { TAO_PROFILE } from './tao';

const W = 'wallet-1';
const A = ss58Encode(new Uint8Array(32).fill(1));
const B = ss58Encode(new Uint8Array(32).fill(2));
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function row(n: number, over: Partial<TaoTransfer> = {}): TaoTransfer {
  return {
    hash: h(n),
    block: 0,
    timestamp: 1_000 + n,
    from: A,
    to: B,
    amount: 1_000_000n * BigInt(n),
    fee: 83_124n,
    extrinsicId: '',
    status: 'pending',
    nonce: n,
    eraPeriod: 64,
    checkpointNumber: 9_000_000 + n,
    ...over,
  };
}

beforeEach(() => setStorageForTests(new MemoryStorageAdapter()));

describe('substrate/historyClient (local sends only, no network)', () => {
  it('save/load round-trips bigint amounts through decimal strings', async () => {
    const big = row(1, { amount: (1n << 63n) + 5n });
    await saveTaoHistory(W, [big]);
    const stored = (await getStorage().get<unknown[]>(taoHistoryKey(W)))!;
    expect((stored[0] as Record<string, unknown>).amount).toBe(((1n << 63n) + 5n).toString());
    const back = await loadTaoHistory(W);
    expect(back).toHaveLength(1);
    expect(back[0].amount).toBe((1n << 63n) + 5n);
    expect(back[0].fee).toBe(83_124n);
    expect(back[0]).toMatchObject({ status: 'pending', nonce: 1, eraPeriod: 64 });
  });

  it('newest first, one row per hash, capped at 200', async () => {
    const rows = Array.from({ length: TAO_HISTORY_CAP + 25 }, (_, i) => row(i + 1));
    rows.push(row(3, { status: 'included' }));
    await saveTaoHistory(W, rows);
    const back = await loadTaoHistory(W);
    expect(back).toHaveLength(TAO_HISTORY_CAP);
    expect(back[0].hash).toBe(h(TAO_HISTORY_CAP + 25));
    expect(new Set(back.map((r) => r.hash)).size).toBe(back.length);
    expect(normalizeTaoHistory([row(1), row(1)])).toHaveLength(1);
  });

  it('junk and foreign shapes read as nothing, never as a guessed row', async () => {
    await getStorage().set(taoHistoryKey(W), [
      { hash: 'nope' },
      { ...row(1), amount: 1.5 },
      { ...row(2), amount: '2000000', fee: '83124', status: 'weird', blockHash: 'x' },
      42,
    ]);
    const back = await loadTaoHistory(W);
    expect(back).toHaveLength(1);
    expect(back[0].hash).toBe(h(2));
    expect(back[0].status).toBeUndefined();
    expect(back[0].blockHash).toBeUndefined();
    await getStorage().set(taoHistoryKey(W), { not: 'an array' });
    expect(await loadTaoHistory(W)).toEqual([]);
  });

  it('record, then settle by hash; concurrent writes do not drop each other', async () => {
    await Promise.all([recordTaoSend(W, row(1)), recordTaoSend(W, row(2)), recordTaoSend(W, row(3))]);
    expect((await loadTaoHistory(W)).map((r) => r.hash)).toEqual([h(3), h(2), h(1)]);
    await Promise.all([
      updateTaoSend(W, h(2), { status: 'included', block: 9_000_010, blockHash: h(99), extrinsicId: '9000010-1' }),
      recordTaoSend(W, row(4)),
      updateTaoSend(W, h(1), { status: 'expired' }),
    ]);
    const back = await loadTaoHistory(W);
    expect(back.map((r) => r.hash)).toEqual([h(4), h(3), h(2), h(1)]);
    expect(back.find((r) => r.hash === h(2))).toMatchObject({ status: 'included', block: 9_000_010, extrinsicId: '9000010-1' });
    expect(back.find((r) => r.hash === h(1))!.status).toBe('expired');
    // Unknown hash: no-op.
    await updateTaoSend(W, h(77), { status: 'included' });
    expect(await loadTaoHistory(W)).toHaveLength(4);
  });

  it('wallets are separate; delete removes only its own rows', async () => {
    await recordTaoSend(W, row(1));
    await recordTaoSend('wallet-2', row(2));
    await deleteTaoHistory(W);
    expect(await loadTaoHistory(W)).toEqual([]);
    expect(await loadTaoHistory('wallet-2')).toHaveLength(1);
    expect(() => taoHistoryKey('')).toThrow();
  });

  it('pending rows with what a resumed poll needs', () => {
    const rows = [row(1), row(2, { status: 'included' }), row(3, { nonce: undefined })];
    const p = pendingTaoSends(rows);
    expect(p.map((r) => r.hash)).toEqual([h(1)]);
    expect(inclusionTargetOf(p[0])).toEqual({ signed: { hash: h(1), nonce: 1, eraPeriod: 64, checkpointNumber: 9_000_001 } });
  });

  it('taoTransferFromPlan records a pending send with its era', () => {
    const plan = {
      signed: { hex: '0x00', hash: h(5).toUpperCase().replace('0X', '0x'), payload: new Uint8Array(), nonce: 9, eraPeriod: 64, checkpointNumber: 123 },
      fee: 83_124n,
      builtAt: 0,
      from: A,
      call: { kind: 'transfer_all', dest: new Uint8Array(32).fill(2), keepAlive: true },
      profile: TAO_PROFILE,
    } as unknown as TaoSendPlan;
    const r = taoTransferFromPlan(plan, 4_000n, undefined, 777);
    expect(r).toEqual({
      hash: h(5),
      block: 0,
      timestamp: 777,
      from: A,
      to: B,
      amount: 4_000n,
      fee: 83_124n,
      extrinsicId: '',
      status: 'pending',
      nonce: 9,
      eraPeriod: 64,
      checkpointNumber: 123,
      checkedThrough: 123,
      sweep: true,
    });
  });
});
