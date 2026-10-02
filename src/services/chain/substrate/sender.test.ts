import { afterEach, describe, expect, it } from 'vitest';
import { TaoRpcError, type TaoRpc, type TaoRuntimeDigest } from './rpc';
import { TaoRuntimeChangedError } from './reader';
import {
  TAO_PLAN_MAX_AGE_MS,
  TaoSendError,
  isTaoPlanStale,
  planTaoSend,
  pollTaoInclusion,
  preflightTaoSend,
  sendTaoPlan,
  submitTaoSend,
  taoShortfall,
  type TaoSendArgs,
  type TaoSendPlan,
} from './sender';
import { decodeSignedExtrinsic, signable, type TransferCall } from './extrinsic';
import { accountFromMnemonic, verifySubstrate, zeroSubstrateAccount, type SubstrateAccount } from './keys';
import { encodeAccountInfo, systemAccountKey, u32le, type AccountInfo } from './scale';
import { ss58Encode } from './ss58';
import { TAO_ERA_PERIOD, TAO_PROFILE } from './tao';

// A public BIP39 test vector (never the `abandon ... about` phrase, whose
// Bittensor account is live and used by strangers).
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const DEST = new Uint8Array(32).fill(7);
const FEE = 83_124n;

let accounts: SubstrateAccount[] = [];
function account(): SubstrateAccount {
  const a = accountFromMnemonic(PHRASE);
  accounts.push(a);
  return a;
}
afterEach(() => {
  for (const a of accounts) zeroSubstrateAccount(a);
  accounts = [];
});

const hashOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const hexNum = (n: number) => `0x${n.toString(16)}`;

interface Chain {
  spec: number;
  tx: number;
  finalized: number;
  info: AccountInfo | null;
  nextIndex: number;
  fee: bigint | string;
  validity: string[]; // answers to successive validate_transaction calls
  submit: (hex: string) => unknown;
  blocks: Map<string, { number: number; parent: string; extrinsics: string[] }>;
  digest?: TaoRuntimeDigest;
  failNext?: string; // method whose next call throws a transport error
}

function info(over: Partial<AccountInfo> = {}): AccountInfo {
  return { nonce: 3, consumers: 0, providers: 1, sufficients: 0, free: 5_000_000_000n, reserved: 0n, frozen: 0n, flags: 0n, ...over };
}

function chain(over: Partial<Chain> = {}): Chain {
  return {
    spec: 470,
    tx: 1,
    finalized: 9_168_516,
    info: info(),
    nextIndex: 3,
    fee: FEE.toString(),
    validity: ['0x00' + '00'.repeat(40)],
    submit: () => `0x${'ee'.repeat(32)}`,
    blocks: new Map(),
    ...over,
  };
}

function fakeRpc(c: Chain) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const rpc: TaoRpc = {
    nodeSet: 'main',
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push({ method, params });
      if (c.failNext === method) {
        c.failNext = undefined;
        throw new TaoRpcError('transport', method, 'The Bittensor network is unreachable.');
      }
      const r = ((): unknown => {
        switch (method) {
          case 'state_getRuntimeVersion':
            return { specName: 'node-subtensor', specVersion: c.spec, transactionVersion: c.tx };
          case 'chain_getFinalizedHead':
            return hashOf(c.finalized);
          case 'chain_getHeader': {
            const n = parseInt(String(params[0]).slice(2), 16);
            return { number: hexNum(n), parentHash: hashOf(n - 1) };
          }
          case 'state_getStorage':
            return c.info ? encodeAccountInfo(c.info) : null;
          case 'system_accountNextIndex':
            return c.nextIndex;
          case 'payment_queryInfo':
            return { weight: { ref_time: 1, proof_size: 1 }, class: 'normal', partialFee: c.fee };
          case 'state_call':
            if (params[0] !== 'TaggedTransactionQueue_validate_transaction') throw new Error('unexpected state_call');
            return c.validity.length > 1 ? c.validity.shift() : c.validity[0];
          case 'author_submitExtrinsic':
            return c.submit(String(params[0]));
          case 'chain_getBlock': {
            const b = c.blocks.get(String(params[0]));
            if (!b) {
              const n = parseInt(String(params[0]).slice(2), 16);
              return { block: { header: { number: hexNum(n), parentHash: hashOf(n - 1) }, extrinsics: ['0x280403000b'] } };
            }
            return { block: { header: { number: hexNum(b.number), parentHash: b.parent }, extrinsics: b.extrinsics } };
          }
          default:
            throw new Error(`unexpected call ${method}`);
        }
      })();
      return r as T;
    },
    async runtime() {
      if (!c.digest) throw new TaoRpcError('http', 'runtime', 'HTTP 404', { status: 404 });
      return c.digest;
    },
  };
  const count = (m: string) => calls.filter((x) => x.method === m).length;
  return { rpc, calls, count };
}

const keepAlive = (rao: bigint): TransferCall => ({ kind: 'transfer_keep_alive', dest: DEST, rao });

function args(rpc: TaoRpc, call: TransferCall = keepAlive(1_000_000n)): TaoSendArgs {
  return { rpc, account: account(), profile: TAO_PROFILE, call };
}

describe('substrate/sender planTaoSend', () => {
  it('guard, checkpoint, account, nonce, sign, fee: in that order; nothing is broadcast', async () => {
    const c = chain();
    const { rpc, calls } = fakeRpc(c);
    const a = args(rpc);
    const plan = await planTaoSend(a);
    expect(calls.map((x) => x.method)).toEqual([
      'state_getRuntimeVersion',
      'chain_getFinalizedHead',
      'chain_getHeader',
      'state_getStorage',
      'system_accountNextIndex',
      'payment_queryInfo',
    ]);
    expect(calls.find((x) => x.method === 'state_getStorage')!.params).toEqual([systemAccountKey(a.account.publicKey), hashOf(c.finalized)]);
    expect(calls.find((x) => x.method === 'system_accountNextIndex')!.params).toEqual([a.account.address]);
    expect(calls.find((x) => x.method === 'payment_queryInfo')!.params).toEqual([plan.signed.hex]);

    expect(plan.fee).toBe(FEE);
    expect(plan.runtime).toBe('same');
    expect(plan.from).toBe(a.account.address);
    expect(plan.signed.nonce).toBe(3);
    expect(plan.signed.eraPeriod).toBe(TAO_ERA_PERIOD);
    expect(plan.signed.checkpointNumber).toBe(c.finalized);
    expect(plan.account.finalizedNumber).toBe(c.finalized);
    expect(plan.shortfall).toBe(0n);

    const back = decodeSignedExtrinsic(plan.signed.hex, TAO_PROFILE);
    expect(back.nonce).toBe(3);
    expect(back.tip).toBe(0n);
    expect(back.era.period).toBe(64);
    expect(back.era.phase).toBe(c.finalized % 64);
    expect(back.call.kind).toBe('transfer_keep_alive');
    expect(back.call.rao).toBe(1_000_000n);
    expect([...back.call.dest]).toEqual([...DEST]);
    expect([...back.signer]).toEqual([...a.account.publicKey]);
    expect(verifySubstrate(a.account.publicKey, signable(plan.signed.payload), back.signature)).toBe(true);
    // A transfer_keep_alive is 145 bytes on the wire, length prefix included (§4.2).
    expect((plan.signed.hex.length - 2) / 2).toBe(145);
  });

  it('the nonce is never below the finalized one (a node that lost its pool)', async () => {
    const { rpc } = fakeRpc(chain({ nextIndex: 1, info: info({ nonce: 5 }) }));
    expect((await planTaoSend(args(rpc))).signed.nonce).toBe(5);
    const { rpc: rpc2 } = fakeRpc(chain({ nextIndex: 9, info: info({ nonce: 5 }) }));
    expect((await planTaoSend(args(rpc2))).signed.nonce).toBe(9);
  });

  it('below the existential deposit, u64 overflow, transfer_all without keep-alive: refused before any request', async () => {
    const { rpc, calls } = fakeRpc(chain());
    await expect(planTaoSend(args(rpc, keepAlive(499n)))).rejects.toMatchObject({ code: 'below-minimum' });
    await expect(planTaoSend(args(rpc, keepAlive(1n << 64n)))).rejects.toMatchObject({ code: 'bad-call' });
    await expect(planTaoSend(args(rpc, { kind: 'transfer_all', dest: DEST, keepAlive: false }))).rejects.toMatchObject({ code: 'bad-call' });
    await expect(planTaoSend(args(rpc, { kind: 'transfer_keep_alive', dest: new Uint8Array(31), rao: 1000n }))).rejects.toMatchObject({
      code: 'bad-call',
    });
    expect(calls).toHaveLength(0);
    await expect(planTaoSend(args(rpc, keepAlive(500n)))).resolves.toBeTruthy();
  });

  it('transfer_all(keep_alive) plans with the fee as its only need', async () => {
    const { rpc } = fakeRpc(chain());
    const plan = await planTaoSend(args(rpc, { kind: 'transfer_all', dest: DEST, keepAlive: true }));
    expect(decodeSignedExtrinsic(plan.signed.hex, TAO_PROFILE).call).toMatchObject({ kind: 'transfer_all', keepAlive: true });
    expect(plan.shortfall).toBe(0n);
  });

  it('a fee above the 0.01 TAO cap is refused, never clamped', async () => {
    const { rpc } = fakeRpc(chain({ fee: '10000001' }));
    await expect(planTaoSend(args(rpc))).rejects.toMatchObject({ code: 'fee-too-high' });
    const { rpc: ok } = fakeRpc(chain({ fee: '10000000' }));
    await expect(planTaoSend(args(ok))).resolves.toMatchObject({ fee: 10_000_000n });
    const { rpc: junk } = fakeRpc(chain({ fee: '1.5' }));
    await expect(planTaoSend(args(junk))).rejects.toBeInstanceOf(TaoRpcError);
  });

  it("a changed layout blocks the send before the nonce is read or anything is signed", async () => {
    const swapped = [...TAO_PROFILE.signedExtensions].reverse();
    const { rpc, count } = fakeRpc(chain({ spec: 471, digest: { ...TAO_PROFILE, specVersion: 471, signedExtensions: swapped, node: '', finalizedHeight: 0 } }));
    await expect(planTaoSend(args(rpc))).rejects.toBeInstanceOf(TaoRuntimeChangedError);
    expect(count('system_accountNextIndex')).toBe(0);
    expect(count('payment_queryInfo')).toBe(0);
  });

  it("'version-only' signs with the LIVE spec and tx versions", async () => {
    const { rpc } = fakeRpc(chain({ spec: 471, tx: 2, digest: { ...TAO_PROFILE, specVersion: 471, transactionVersion: 2, node: '', finalizedHeight: 0 } }));
    const plan = await planTaoSend(args(rpc));
    expect(plan.runtime).toBe('version-only');
    expect(plan.profile.specVersion).toBe(471);
    // payload = call || extra || additional, additional starting u32le(spec) || u32le(tx) || genesis.
    const needle = [...u32le(471), ...u32le(2)];
    const p = [...plan.signed.payload];
    const at = p.findIndex((_, i) => needle.every((b, j) => p[i + j] === b));
    expect(at).toBeGreaterThan(0);
  });

  it('shortfall: amount plus fee with the margin, against free - max(frozen, ED)', async () => {
    const { rpc } = fakeRpc(chain({ info: info({ free: 1_000_000n }) }));
    const plan = await planTaoSend(args(rpc, keepAlive(1_000_000n)));
    // spendable 999,500; need 1,000,000 + 91,436 (83,124 * 1.1)
    expect(plan.account.spendable).toBe(999_500n);
    expect(plan.shortfall).toBe(1_000_000n + (FEE * 1100n) / 1000n - 999_500n);
    expect(taoShortfall(keepAlive(1n), 0n, 10n)).toBe(0n);
  });
});

describe('substrate/sender preflight and submit', () => {
  it("pre-flight is validate_transaction(External, tx, head) at the finalized head", async () => {
    const c = chain();
    const { rpc, calls } = fakeRpc(c);
    const plan = await planTaoSend(args(rpc));
    c.finalized += 2;
    const v = await preflightTaoSend(rpc, plan);
    expect(v.ok).toBe(true);
    const sc = calls.filter((x) => x.method === 'state_call').at(-1)!;
    const head = hashOf(c.finalized);
    expect(sc.params).toEqual(['TaggedTransactionQueue_validate_transaction', `0x02${plan.signed.hex.slice(2)}${head.slice(2)}`, head]);
  });

  it('submit: accepted; "already imported" is accepted; an unknown outcome is not a failure; a refusal throws', async () => {
    const { rpc } = fakeRpc(chain());
    const plan = await planTaoSend(args(rpc));
    await expect(submitTaoSend(rpc, plan)).resolves.toEqual({ hash: plan.signed.hash, status: 'accepted' });

    const mk = (err: TaoRpcError): TaoRpc => ({ ...rpc, call: async () => Promise.reject(err) });
    await expect(submitTaoSend(mk(new TaoRpcError('rpc', 'author_submitExtrinsic', 'already', { rpcCode: 1013 })), plan)).resolves.toMatchObject({
      status: 'accepted',
    });
    await expect(
      submitTaoSend(mk(new TaoRpcError('http', 'author_submitExtrinsic', '504', { status: 504, maybeSent: true })), plan),
    ).resolves.toEqual({ hash: plan.signed.hash, status: 'unknown' });
    await expect(
      submitTaoSend(mk(new TaoRpcError('rpc', 'author_submitExtrinsic', 'Invalid Transaction', { rpcCode: 1010 })), plan),
    ).rejects.toMatchObject({ code: 'rejected' });
  });
});

describe('substrate/sender sendTaoPlan (§4.5 steps 5 to 7)', () => {
  async function planned(c: Chain, call?: TransferCall) {
    const f = fakeRpc(c);
    const a = args(f.rpc, call);
    const plan = await planTaoSend(a);
    f.calls.length = 0;
    return { ...f, a, plan };
  }

  it('valid: pre-flight then submit, the local hash returned', async () => {
    const { a, plan, count } = await planned(chain());
    const r = await sendTaoPlan(a, plan);
    expect(r).toMatchObject({ hash: plan.signed.hash, status: 'accepted', rebuilt: false });
    expect(count('state_call')).toBe(1);
    expect(count('author_submitExtrinsic')).toBe(1);
  });

  it('Invalid(Payment) (0x010001) refuses with "not enough TAO for the fee" and never submits', async () => {
    const { a, plan, count } = await planned(chain({ validity: ['0x010001'] }));
    const err = await sendTaoPlan(a, plan).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaoSendError);
    expect((err as TaoSendError).code).toBe('payment');
    expect((err as TaoSendError).message).toBe('Not enough TAO to pay the network fee.');
    expect(count('author_submitExtrinsic')).toBe(0);
  });

  it('Stale rebuilds ONCE with a fresh nonce and checkpoint, then submits the rebuild', async () => {
    const c = chain({ validity: ['0x010003', '0x00' + '00'.repeat(40)] });
    const { a, plan, count } = await planned(c);
    c.nextIndex = 4;
    c.finalized += 3;
    const r = await sendTaoPlan(a, plan);
    expect(r.rebuilt).toBe(true);
    expect(r.plan.signed.nonce).toBe(4);
    expect(r.plan.signed.checkpointNumber).toBe(c.finalized);
    expect(r.hash).toBe(r.plan.signed.hash);
    expect(r.hash).not.toBe(plan.signed.hash);
    expect(count('system_accountNextIndex')).toBe(1);
    expect(count('author_submitExtrinsic')).toBe(1);
  });

  it('BadProof twice: one rebuild, then a refusal with the code, never a submit', async () => {
    const { a, plan, count } = await planned(chain({ validity: ['0x010004'] }));
    const err = (await sendTaoPlan(a, plan).catch((e: unknown) => e)) as TaoSendError;
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/BadProof/);
    expect(count('state_call')).toBe(2);
    expect(count('author_submitExtrinsic')).toBe(0);
  });

  it('Invalid(Call) refuses without a rebuild', async () => {
    const { a, plan, count } = await planned(chain({ validity: ['0x010000'] }));
    await expect(sendTaoPlan(a, plan)).rejects.toMatchObject({ code: 'invalid' });
    expect(count('system_accountNextIndex')).toBe(0);
  });

  it('a plan older than 10 minutes is rebuilt before the pre-flight', async () => {
    const { a, plan, count } = await planned(chain());
    const later = plan.builtAt + TAO_PLAN_MAX_AGE_MS + 1;
    expect(isTaoPlanStale(plan, later)).toBe(true);
    expect(isTaoPlanStale(plan, plan.builtAt + 1000)).toBe(false);
    const r = await sendTaoPlan(a, plan, undefined, () => later);
    expect(r.rebuilt).toBe(true);
    expect(count('system_accountNextIndex')).toBe(1);
  });

  it('a rebuild whose fee rose past the margin refuses: the user reviews the new fee', async () => {
    const c = chain({ validity: ['0x010003', '0x00' + '00'.repeat(40)] });
    const { a, plan, count } = await planned(c);
    c.fee = ((FEE * 12n) / 10n).toString();
    await expect(sendTaoPlan(a, plan)).rejects.toMatchObject({ code: 'fee-changed' });
    expect(count('author_submitExtrinsic')).toBe(0);
  });

  it('fee payable but the amount is not: refused after a passing pre-flight, never submitted (the fee would be lost)', async () => {
    const { a, plan, count } = await planned(chain({ info: info({ free: 2_000_000n }) }), keepAlive(1_950_000n));
    expect(plan.shortfall).toBeGreaterThan(0n);
    const err = (await sendTaoPlan(a, plan).catch((e: unknown) => e)) as TaoSendError;
    expect(err.code).toBe('insufficient');
    expect(err.message).not.toMatch(/—/);
    expect(count('state_call')).toBe(1);
    expect(count('author_submitExtrinsic')).toBe(0);
  });
});

describe('substrate/sender pollTaoInclusion (§4.5 step 8)', () => {
  const noSleep = async () => {};

  function target(plan: TaoSendPlan) {
    return { signed: plan.signed };
  }

  async function setup(c: Chain) {
    const f = fakeRpc(c);
    const a = args(f.rpc);
    const plan = await planTaoSend(a);
    f.calls.length = 0;
    return { ...f, a, plan };
  }

  it('the nonce bump finds the block with a bounded walk from the finalized head', async () => {
    const c = chain();
    const { rpc, plan, a, count } = await setup(c);
    const start = c.finalized;
    let ticks = 0;
    const r = await pollTaoInclusion(rpc, a.account.address, target(plan), undefined, {
      sleep: async () => {
        ticks++;
        c.finalized += 1;
        if (ticks === 2) {
          // Included in start + 2, finalized with start + 3 on the next tick.
          c.blocks.set(hashOf(start + 2), { number: start + 2, parent: hashOf(start + 1), extrinsics: ['0x280403000b', plan.signed.hex] });
          c.finalized += 1;
          c.info = info({ nonce: 4 });
        }
      },
    });
    expect(r).toMatchObject({ state: 'included', blockNumber: start + 2, blockHash: hashOf(start + 2), extrinsicIndex: 1, matched: true });
    // Walked start + 3, then start + 2: two blocks, never the whole window.
    expect(count('chain_getBlock')).toBe(2);
  });

  it('a block that carries the extrinsic under a different hex spelling is matched by its hash', async () => {
    const c = chain();
    const { rpc, plan, a } = await setup(c);
    c.finalized += 1;
    c.blocks.set(hashOf(c.finalized), { number: c.finalized, parent: hashOf(c.finalized - 1), extrinsics: [plan.signed.hex.toUpperCase().replace('0X', '0x')] });
    c.info = info({ nonce: 4 });
    const r = await pollTaoInclusion(rpc, a.account.address, target(plan), undefined, { sleep: noSleep });
    expect(r).toMatchObject({ state: 'included', matched: true });
  });

  it('era expiry with the nonce unmoved: expired ("not included, send again")', async () => {
    const c = chain();
    const { rpc, plan, a, count } = await setup(c);
    const r = await pollTaoInclusion(rpc, a.account.address, target(plan), undefined, {
      sleep: async () => {
        c.finalized += 10;
      },
    });
    expect(r.state).toBe('expired');
    expect(r.reason).toBe('era');
    expect(r.checkedThrough).toBeGreaterThanOrEqual(plan.signed.checkpointNumber + TAO_ERA_PERIOD);
    expect(count('chain_getBlock')).toBe(0);
  });

  it('never says expired one block early', async () => {
    const c = chain();
    const { rpc, plan, a } = await setup(c);
    c.finalized = plan.signed.checkpointNumber + TAO_ERA_PERIOD - 1;
    const ctrl = new AbortController();
    const r = await pollTaoInclusion(rpc, a.account.address, target(plan), ctrl.signal, {
      sleep: async () => ctrl.abort(),
    });
    expect(r.state).toBe('pending');
  });

  it('the nonce went to another extrinsic (fully scanned, not found): expired, nonce-used', async () => {
    const c = chain();
    const { rpc, plan, a } = await setup(c);
    const r = await pollTaoInclusion(rpc, a.account.address, target(plan), undefined, {
      sleep: async () => {
        c.finalized += 1;
        c.info = info({ nonce: 4 });
      },
    });
    expect(r).toMatchObject({ state: 'expired', reason: 'nonce-used', matched: false });
  });

  it('a range past the scan cap: included, block unknown', async () => {
    const c = chain();
    const { rpc, plan, a, count } = await setup(c);
    c.finalized += 40;
    c.info = info({ nonce: 4 });
    const r = await pollTaoInclusion(rpc, a.account.address, target(plan), undefined, { sleep: noSleep, scanMax: 5 });
    expect(r).toMatchObject({ state: 'included', matched: false });
    expect(count('chain_getBlock')).toBe(5);
  });

  it('a transient network error is retried on the next tick; abort answers pending', async () => {
    const c = chain();
    const { rpc, plan, a } = await setup(c);
    c.failNext = 'chain_getFinalizedHead';
    let ticks = 0;
    const ctrl = new AbortController();
    const r = await pollTaoInclusion(rpc, a.account.address, target(plan), ctrl.signal, {
      onTick: () => {
        ticks++;
      },
      sleep: async () => {
        if (ticks >= 1) ctrl.abort();
      },
    });
    expect(ticks).toBe(1);
    expect(r.state).toBe('pending');
  });

  it('resumes from a stored record (hash, nonce, era) without the signed bytes', async () => {
    const c = chain();
    const { rpc, plan, a } = await setup(c);
    c.finalized += 2;
    c.blocks.set(hashOf(c.finalized), { number: c.finalized, parent: hashOf(c.finalized - 1), extrinsics: ['0x00', plan.signed.hex] });
    c.info = info({ nonce: 4 });
    const stored = { signed: { hash: plan.signed.hash, nonce: plan.signed.nonce, eraPeriod: 64, checkpointNumber: plan.signed.checkpointNumber } };
    const r = await pollTaoInclusion(rpc, a.account.address, stored, undefined, { sleep: noSleep, scanFrom: c.finalized - 1 });
    expect(r).toMatchObject({ state: 'included', blockNumber: c.finalized, matched: true });
  });

  it('gives up with pending after maxWaitMs', async () => {
    const c = chain();
    const { rpc, plan, a } = await setup(c);
    let t = 0;
    const r = await pollTaoInclusion(rpc, a.account.address, target(plan), undefined, {
      sleep: noSleep,
      now: () => (t += 1000),
      maxWaitMs: 5000,
    });
    expect(r.state).toBe('pending');
  });

  it('refuses an address that is not a Bittensor one', async () => {
    const c = chain();
    const { rpc, plan } = await setup(c);
    await expect(pollTaoInclusion(rpc, ss58Encode(DEST, 0), target(plan))).rejects.toThrow();
  });
});
