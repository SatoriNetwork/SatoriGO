// taoSend.ts is a THIN wrapper over Set B's services/chain/substrate/sender.ts
// (planTaoSend, sendTaoPlan, pollTaoInclusion) and historyClient.ts
// (recordTaoSend, updateTaoSend, taoTransferFromPlan) — see the file header.
// Everything Set A/B is mocked down to the shapes this file actually calls,
// so this test exercises taoSend.ts's own logic (text validation before a
// call exists, the review numbers, the local-record/poll wiring) without
// depending on Set B's real network code.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubstrateAccount } from '../services/chain/substrate';

const hoisted = vi.hoisted(() => ({
  planTaoSendImpl: vi.fn(),
  sendTaoPlanImpl: vi.fn(),
  pollTaoInclusionImpl: vi.fn(),
  recordTaoSendImpl: vi.fn(async () => []),
  updateTaoSendImpl: vi.fn(async () => []),
  loadTaoHistoryImpl: vi.fn(async () => [] as unknown[]),
}));

// Honest, small stand-ins for Set B/A's real contracts, mirroring
// moneroSend.test.ts's approach: this file's own logic (address/amount text
// validation, warnings, the poll/record wiring) is what is under test, not
// Set A/B's cryptography or network code. recordTaoSend/updateTaoSend/
// taoTransferFromPlan live in Set B's historyClient.ts (re-exported through
// this same barrel), NOT this Set's taoHistory.ts — see taoSend.ts's header.
vi.mock('../services/chain/substrate', () => {
  class TaoSendError extends Error {
    code: string;
    validity?: unknown;
    constructor(code: string, message: string, validity?: unknown) {
      super(message);
      this.name = 'TaoSendError';
      this.code = code;
      if (validity) this.validity = validity;
    }
  }
  class TaoRuntimeChangedError extends Error {
    code = 'runtime-changed' as const;
    constructor() {
      super('Bittensor updated its network; update Satori GO to send.');
      this.name = 'TaoRuntimeChangedError';
    }
  }
  const formatTao = (rao: bigint) => {
    const neg = rao < 0n;
    const abs = neg ? -rao : rao;
    const s = abs.toString().padStart(10, '0');
    const whole = s.slice(0, -9) || '0';
    const frac = s.slice(-9).replace(/0+$/, '');
    return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole);
  };
  return {
    planTaoSend: hoisted.planTaoSendImpl,
    sendTaoPlan: hoisted.sendTaoPlanImpl,
    pollTaoInclusion: hoisted.pollTaoInclusionImpl,
    parseTao: (text: string) => {
      const t = text.trim();
      if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') throw new Error('Enter a valid amount.');
      const [w, f = ''] = t.split('.');
      if (f.length > 9) throw new Error('Too many decimal places.');
      return BigInt((w || '0') + f.padEnd(9, '0'));
    },
    formatTao,
    isValidTaoAddress: (a: string) => a.startsWith('5') && a.length > 10,
    ss58Decode: (a: string) => ({ prefix: 42, publicKey: new TextEncoder().encode(a.padEnd(32, '.')).slice(0, 32) }),
    recordTaoSend: hoisted.recordTaoSendImpl,
    updateTaoSend: hoisted.updateTaoSendImpl,
    loadTaoHistory: hoisted.loadTaoHistoryImpl,
    // Honest copies of Set B's two small pure helpers (historyClient.ts).
    pendingTaoSends: (rows: Array<Record<string, unknown>>) =>
      rows.filter(
        (r) =>
          r.status === 'pending' &&
          typeof r.nonce === 'number' &&
          typeof r.eraPeriod === 'number' &&
          typeof r.checkpointNumber === 'number',
      ),
    inclusionTargetOf: (row: { hash: string; nonce: number; eraPeriod: number; checkpointNumber: number }) => ({
      signed: { hash: row.hash, nonce: row.nonce, eraPeriod: row.eraPeriod, checkpointNumber: row.checkpointNumber },
    }),
    // A small, honest stand-in for Set B's real taoTransferFromPlan: enough of
    // its shape (hash/from/to/amount/fee/status) for this file's own logic to
    // be exercised, without pulling in Set B's ss58Encode.
    taoTransferFromPlan: (plan: { from: string; fee: bigint; signed: { hash: string } }, amountRao: bigint, hash: string) => ({
      hash,
      block: 0,
      timestamp: Date.now(),
      from: plan.from,
      to: '5DestFromPlan',
      amount: amountRao,
      fee: plan.fee,
      extrinsicId: '',
      status: 'pending' as const,
    }),
    TaoSendError,
    TaoRuntimeChangedError,
    TAO_PROFILE: { specVersion: 470, transactionVersion: 1 },
    TAO_SS58_PREFIX: 42,
  };
});

import {
  buildTaoSendPlan,
  broadcastTaoPlan,
  resumeTaoInclusionPolls,
  abortTaoInclusionPolls,
  trackTaoInclusion,
  taoPollsInFlight,
  resetTaoPollsForTests,
  TaoSendError,
  type TaoSendDeps,
  type TaoSendPlan,
} from './taoSend';

const FROM = '5FromAccountAddressXXXXXXXXXXXXXX';
const TO = '5ToRecipientAddressXXXXXXXXXXXXXX';

function fakeAccount(overrides: Partial<SubstrateAccount> = {}): SubstrateAccount {
  return {
    miniSecret: new Uint8Array(32),
    publicKey: new TextEncoder().encode(FROM.padEnd(32, '.')).slice(0, 32),
    address: FROM,
    ...overrides,
  } as SubstrateAccount;
}

function fakeDeps(overrides: Partial<TaoSendDeps> = {}): TaoSendDeps {
  return {
    rpc: { call: vi.fn(), runtime: vi.fn(), nodeSet: 'main' } as unknown as TaoSendDeps['rpc'],
    account: fakeAccount(),
    walletId: 'w1',
    ...overrides,
  };
}

function fakePlan(overrides: Record<string, unknown> = {}) {
  return {
    signed: { hex: '0xdead', hash: '0xhash', payload: new Uint8Array(), nonce: 7, eraPeriod: 64, checkpointNumber: 100 },
    fee: 83_124n,
    builtAt: Date.now(),
    from: FROM,
    call: { kind: 'transfer_keep_alive', dest: new Uint8Array(32), rao: 1_000_000_000n },
    profile: { specVersion: 470, transactionVersion: 1 },
    runtime: 'same',
    account: { exists: true, info: null, spendable: 5_000_000_000n, finalizedHash: '0xh', finalizedNumber: 100 },
    shortfall: 0n,
    ...overrides,
  };
}

/** Let a resolved poll's then/finally chain run to the end. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  resetTaoPollsForTests();
  hoisted.planTaoSendImpl.mockReset();
  hoisted.sendTaoPlanImpl.mockReset();
  hoisted.pollTaoInclusionImpl.mockReset();
  hoisted.recordTaoSendImpl.mockClear();
  hoisted.updateTaoSendImpl.mockClear();
  hoisted.loadTaoHistoryImpl.mockReset();
  hoisted.loadTaoHistoryImpl.mockResolvedValue([]);
  hoisted.planTaoSendImpl.mockResolvedValue(fakePlan());
  hoisted.pollTaoInclusionImpl.mockResolvedValue({ state: 'included', blockNumber: 9_168_516, extrinsicIndex: 2 });
});

describe('buildTaoSendPlan', () => {
  it('rejects an invalid address before calling planTaoSend at all', async () => {
    await expect(
      buildTaoSendPlan(fakeDeps(), { to: 'notanaddress', amount: '1', sweep: false }),
    ).rejects.toMatchObject({ code: 'bad-call' });
    expect(hoisted.planTaoSendImpl).not.toHaveBeenCalled();
  });

  it('rejects an unparsable amount before calling planTaoSend', async () => {
    await expect(
      buildTaoSendPlan(fakeDeps(), { to: TO, amount: 'garbage', sweep: false }),
    ).rejects.toMatchObject({ code: 'bad-call' });
    expect(hoisted.planTaoSendImpl).not.toHaveBeenCalled();
  });

  it('rejects a zero amount before calling planTaoSend', async () => {
    await expect(
      buildTaoSendPlan(fakeDeps(), { to: TO, amount: '0', sweep: false }),
    ).rejects.toMatchObject({ code: 'bad-call' });
    expect(hoisted.planTaoSendImpl).not.toHaveBeenCalled();
  });

  it('does NOT duplicate the below-minimum check (Set B does it): a small-but-positive amount reaches planTaoSend', async () => {
    await buildTaoSendPlan(fakeDeps(), { to: TO, amount: '0.0000001', sweep: false });
    expect(hoisted.planTaoSendImpl).toHaveBeenCalledTimes(1);
  });

  it('builds a transfer_keep_alive call with the recipient (not the sender!) as dest', async () => {
    await buildTaoSendPlan(fakeDeps(), { to: TO, amount: '1', sweep: false });
    const args = hoisted.planTaoSendImpl.mock.calls[0][0];
    expect(args.call.kind).toBe('transfer_keep_alive');
    expect(args.call.rao).toBe(1_000_000_000n);
    expect(args.call.dest).toEqual(new TextEncoder().encode(TO.padEnd(32, '.')).slice(0, 32));
  });

  it('a sweep builds transfer_all with keepAlive true and ignores the amount text', async () => {
    const plan = await buildTaoSendPlan(fakeDeps(), { to: TO, amount: 'ignored garbage', sweep: true });
    const args = hoisted.planTaoSendImpl.mock.calls[0][0];
    expect(args.call).toEqual({ kind: 'transfer_all', dest: expect.any(Uint8Array), keepAlive: true });
    expect(plan.amountTao).toBe('the rest of your balance');
    expect(plan.warnings[0]).toMatch(/rest of your balance/i);
  });

  it('a sweep estimates amountRao as spendable minus fee (for the local history record)', async () => {
    hoisted.planTaoSendImpl.mockResolvedValue(fakePlan({ fee: 83_124n, account: { exists: true, info: null, spendable: 5_000_000_000n, finalizedHash: '', finalizedNumber: 0 } }));
    const plan = await buildTaoSendPlan(fakeDeps(), { to: TO, amount: '', sweep: true });
    expect(plan.amountRao).toBe(5_000_000_000n - 83_124n);
  });

  it('formats fee/amount/total from the plan Set B returned', async () => {
    hoisted.planTaoSendImpl.mockResolvedValue(fakePlan({ fee: 83_124n }));
    const plan = await buildTaoSendPlan(fakeDeps(), { to: TO, amount: '1', sweep: false });
    expect(plan.feeTao).toBe('0.000083124');
    expect(plan.amountTao).toBe('1');
    expect(plan.totalTao).toBe('1.000083124');
    expect(plan.warnings).toEqual([]);
  });

  it('warns when the recipient is the sender itself', async () => {
    const plan = await buildTaoSendPlan(fakeDeps(), { to: FROM, amount: '1', sweep: false });
    expect(plan.warnings).toContain('The recipient is this same wallet.');
  });

  it('refuses a typed amount that leaves no room for the fee, and says how much does fit', async () => {
    // spendable 2.74768 mTAO typed in full (the owner's case, 2026-10-02): the fee does not fit.
    hoisted.planTaoSendImpl.mockResolvedValue(
      fakePlan({ shortfall: 90_000n, account: { exists: true, info: null, spendable: 2_747_680n, finalizedHash: '0xh', finalizedNumber: 100 } }),
    );
    await expect(buildTaoSendPlan(fakeDeps(), { to: TO, amount: '0.00274768', sweep: false })).rejects.toMatchObject({
      code: 'insufficient',
      message: expect.stringMatching(/You can send up to 0\.00\d+ TAO, or use Max/),
    });
  });

  it('still only warns on a sweep with a shortfall (Max never has one of its own)', async () => {
    hoisted.planTaoSendImpl.mockResolvedValue(fakePlan({ shortfall: 500_000n }));
    const plan = await buildTaoSendPlan(fakeDeps(), { to: TO, amount: '', sweep: true });
    expect(plan.warnings.some((w) => /spendable balance/i.test(w))).toBe(true);
  });

  it('propagates Set B errors (fee-too-high, below-minimum, bad-call) unchanged', async () => {
    hoisted.planTaoSendImpl.mockRejectedValue(new TaoSendError('below-minimum', 'The recipient must receive at least 0.0000005 TAO.'));
    await expect(
      buildTaoSendPlan(fakeDeps(), { to: TO, amount: '1', sweep: false }),
    ).rejects.toMatchObject({ code: 'below-minimum' });
  });

  it('defaults to TAO_PROFILE when no profile override is given', async () => {
    await buildTaoSendPlan(fakeDeps(), { to: TO, amount: '1', sweep: false });
    const args = hoisted.planTaoSendImpl.mock.calls[0][0];
    expect(args.profile).toEqual({ specVersion: 470, transactionVersion: 1 });
  });
});

describe('broadcastTaoPlan', () => {
  function fakeView(overrides: Partial<TaoSendPlan> = {}): TaoSendPlan {
    return {
      plan: fakePlan() as unknown as TaoSendPlan['plan'],
      to: TO,
      sweep: false,
      amountRao: 1_000_000_000n,
      feeTao: '0.000083124',
      amountTao: '1',
      totalTao: '1.000083124',
      warnings: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    hoisted.sendTaoPlanImpl.mockResolvedValue({ plan: fakePlan(), hash: '0xreal', status: 'accepted', rebuilt: false });
  });

  it('calls sendTaoPlan with the deps and the exact reviewed plan, and returns its hash', async () => {
    const view = fakeView();
    const result = await broadcastTaoPlan(fakeDeps(), view);
    expect(result).toEqual({ hash: '0xreal' });
    expect(hoisted.sendTaoPlanImpl).toHaveBeenCalledTimes(1);
    const [args, plan] = hoisted.sendTaoPlanImpl.mock.calls[0];
    expect(args.rpc).toBeTruthy();
    expect(args.account.address).toBe(FROM);
    expect(plan).toBe(view.plan);
  });

  it('records the send locally right after a successful send', async () => {
    await broadcastTaoPlan(fakeDeps(), fakeView());
    expect(hoisted.recordTaoSendImpl).toHaveBeenCalledWith('w1', expect.objectContaining({ hash: '0xreal', status: 'pending' }));
  });

  it('a local-history write failure does not fail an already-broadcast send', async () => {
    hoisted.recordTaoSendImpl.mockRejectedValueOnce(new Error('storage full'));
    await expect(broadcastTaoPlan(fakeDeps(), fakeView())).resolves.toEqual({ hash: '0xreal' });
  });

  it('propagates a sendTaoPlan failure (e.g. TaoSendError payment/insufficient/fee-changed) unchanged', async () => {
    hoisted.sendTaoPlanImpl.mockRejectedValue(new TaoSendError('payment', 'Not enough TAO to pay the network fee.'));
    await expect(broadcastTaoPlan(fakeDeps(), fakeView())).rejects.toMatchObject({ code: 'payment' });
    expect(hoisted.recordTaoSendImpl).not.toHaveBeenCalled();
  });

  it('starts pollTaoInclusion with the SENT plan (which may be a rebuild) and calls onInclusion once it resolves', async () => {
    const rebuiltPlan = fakePlan({ signed: { hex: '0xnew', hash: '0xnewhash', payload: new Uint8Array(), nonce: 8, eraPeriod: 64, checkpointNumber: 200 } });
    hoisted.sendTaoPlanImpl.mockResolvedValue({ plan: rebuiltPlan, hash: '0xnewhash', status: 'accepted', rebuilt: true });
    hoisted.pollTaoInclusionImpl.mockResolvedValue({ state: 'included', blockNumber: 42, extrinsicIndex: 1, checkedThrough: 42 });

    const onInclusion = vi.fn();
    await broadcastTaoPlan(fakeDeps(), fakeView(), onInclusion);
    await flush();

    expect(hoisted.pollTaoInclusionImpl).toHaveBeenCalledWith(
      expect.anything(),
      FROM,
      { signed: rebuiltPlan.signed },
      expect.any(AbortSignal),
      {},
    );
    expect(onInclusion).toHaveBeenCalledWith({ state: 'included', blockNumber: 42, extrinsicIndex: 1, checkedThrough: 42 });
    expect(hoisted.updateTaoSendImpl).toHaveBeenCalledWith(
      'w1',
      '0xnewhash',
      expect.objectContaining({ status: 'included', block: 42, extrinsicId: '42-1' }),
    );
  });

  it('does not touch the local record while the poll is still pending and learned nothing', async () => {
    hoisted.pollTaoInclusionImpl.mockResolvedValue({ state: 'pending' });
    await broadcastTaoPlan(fakeDeps(), fakeView());
    await flush();
    expect(hoisted.updateTaoSendImpl).not.toHaveBeenCalled();
  });

  it('a poll that exits pending after checking blocks writes ONLY its resume point back', async () => {
    hoisted.pollTaoInclusionImpl.mockResolvedValue({ state: 'pending', checkedThrough: 150 });
    await broadcastTaoPlan(fakeDeps(), fakeView());
    await flush();
    expect(hoisted.updateTaoSendImpl).toHaveBeenCalledWith('w1', '0xreal', { checkedThrough: 150 });
  });

  it('an EXPIRED result is written back with status expired (the "not included, send again" signal)', async () => {
    hoisted.pollTaoInclusionImpl.mockResolvedValue({ state: 'expired', reason: 'era', checkedThrough: 170 });
    await broadcastTaoPlan(fakeDeps(), fakeView());
    await flush();
    expect(hoisted.updateTaoSendImpl).toHaveBeenCalledWith(
      'w1',
      '0xreal',
      expect.objectContaining({ status: 'expired', block: 0, extrinsicId: '', checkedThrough: 170 }),
    );
  });

  it('a pollTaoInclusion failure never rejects broadcastTaoPlan (already returned)', async () => {
    hoisted.pollTaoInclusionImpl.mockRejectedValue(new Error('gateway down'));
    await expect(broadcastTaoPlan(fakeDeps(), fakeView())).resolves.toEqual({ hash: '0xreal' });
  });
});

describe('TaoSendError (re-exported from Set B)', () => {
  it('is a real Error subclass carrying its code', () => {
    const err = new TaoSendError('bad-call', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TaoSendError');
    expect(err.code).toBe('bad-call');
  });
});

// The registry that outlives the send screen: a poll started by a send that
// the popup then closed is resumed by the store's refresh tick, once per
// hash, from the block it had checked through.
describe('resumeTaoInclusionPolls / trackTaoInclusion', () => {
  const pendingRow = (over: Record<string, unknown> = {}) => ({
    hash: '0xpendinghash',
    block: 0,
    timestamp: 1,
    from: FROM,
    to: TO,
    amount: 1n,
    fee: 1n,
    extrinsicId: '',
    status: 'pending',
    nonce: 7,
    eraPeriod: 64,
    checkpointNumber: 100,
    checkedThrough: 130,
    ...over,
  });
  const deps = () => ({ rpc: fakeDeps().rpc, walletId: 'w1', address: FROM });

  it('starts one poll per pending row, from the row checkedThrough, and settles the row', async () => {
    hoisted.loadTaoHistoryImpl.mockResolvedValue([pendingRow(), pendingRow({ hash: '0xincluded', status: 'included' })]);
    hoisted.pollTaoInclusionImpl.mockResolvedValue({ state: 'included', blockNumber: 140, blockHash: '0xb', extrinsicIndex: 3, checkedThrough: 140 });
    const onInclusion = vi.fn();

    const started = await resumeTaoInclusionPolls(deps(), onInclusion);
    expect(started).toBe(1);
    expect(hoisted.pollTaoInclusionImpl).toHaveBeenCalledTimes(1);
    expect(hoisted.pollTaoInclusionImpl).toHaveBeenCalledWith(
      expect.anything(),
      FROM,
      { signed: { hash: '0xpendinghash', nonce: 7, eraPeriod: 64, checkpointNumber: 100 } },
      expect.any(AbortSignal),
      { scanFrom: 130 },
    );
    await flush();
    expect(hoisted.updateTaoSendImpl).toHaveBeenCalledWith(
      'w1',
      '0xpendinghash',
      expect.objectContaining({ status: 'included', block: 140, blockHash: '0xb', extrinsicId: '140-3' }),
    );
    expect(onInclusion).toHaveBeenCalledWith('0xpendinghash', expect.objectContaining({ state: 'included' }));
    // Settled: nothing is left in flight, so a later tick could start afresh.
    expect(taoPollsInFlight()).toEqual([]);
  });

  it('never starts a second poll for a hash already in flight (the send screen poll, or the last tick)', async () => {
    let release!: (v: unknown) => void;
    hoisted.pollTaoInclusionImpl.mockReturnValue(new Promise((r) => (release = r)));
    hoisted.loadTaoHistoryImpl.mockResolvedValue([pendingRow()]);

    expect(await resumeTaoInclusionPolls(deps())).toBe(1);
    expect(await resumeTaoInclusionPolls(deps())).toBe(0);
    trackTaoInclusion(deps(), { signed: { hash: '0xPENDINGHASH', nonce: 7, eraPeriod: 64, checkpointNumber: 100 } });
    expect(hoisted.pollTaoInclusionImpl).toHaveBeenCalledTimes(1);
    expect(taoPollsInFlight()).toEqual(['w1:0xpendinghash']);

    release({ state: 'pending', checkedThrough: 131 });
    await flush();
    expect(taoPollsInFlight()).toEqual([]);
    // Now it can be resumed again, from the new resume point the row carries.
    hoisted.loadTaoHistoryImpl.mockResolvedValue([pendingRow({ checkedThrough: 131 })]);
    expect(await resumeTaoInclusionPolls(deps())).toBe(1);
    expect(hoisted.pollTaoInclusionImpl).toHaveBeenLastCalledWith(expect.anything(), FROM, expect.anything(), expect.any(AbortSignal), { scanFrom: 131 });
  });

  it('a row without the fields a poll needs (an older record) is skipped, not guessed', async () => {
    hoisted.loadTaoHistoryImpl.mockResolvedValue([pendingRow({ nonce: undefined })]);
    expect(await resumeTaoInclusionPolls(deps())).toBe(0);
    expect(hoisted.pollTaoInclusionImpl).not.toHaveBeenCalled();
  });

  it('abortTaoInclusionPolls aborts the signal of every poll in flight', async () => {
    hoisted.pollTaoInclusionImpl.mockReturnValue(new Promise(() => {}));
    hoisted.loadTaoHistoryImpl.mockResolvedValue([pendingRow(), pendingRow({ hash: '0xother' })]);
    await resumeTaoInclusionPolls(deps());
    const signals = hoisted.pollTaoInclusionImpl.mock.calls.map((c) => c[3] as AbortSignal);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    abortTaoInclusionPolls();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('a poll that throws leaves the row alone and frees the hash for the next tick', async () => {
    hoisted.pollTaoInclusionImpl.mockRejectedValue(new Error('gateway down'));
    hoisted.loadTaoHistoryImpl.mockResolvedValue([pendingRow()]);
    await resumeTaoInclusionPolls(deps());
    await flush();
    expect(hoisted.updateTaoSendImpl).not.toHaveBeenCalled();
    expect(taoPollsInFlight()).toEqual([]);
  });
});
