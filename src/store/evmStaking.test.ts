// The staking store path, end to end THROUGH THE REAL EVM MODULES against a
// fake Epix node and a fake LCD: the generic contract-call plan (gas headroom,
// fee caps, the honest refusal when the node will not simulate), the staking
// plan builders on top of it, and the snapshot read that never throws.
//
// No network. The engine's flag-guarded import is mocked to return the barrel,
// exactly as evmSend.test.ts does.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const hoisted = vi.hoisted(() => ({ evmEnabled: true }));

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => (hoisted.evmEnabled ? await import('../services/chain/evm') : null),
  };
});

import { planEvmCall, withCallGasHeadroom, withEvmCallFeeLevel } from './evmCall';
import { broadcastEvmPlan } from './evmSend';
import {
  buildEvmStakePlan,
  loadEvmStakingSnapshot,
  readExactDelegation,
  readUnbondingEntryCount,
} from './evmStaking';
import {
  EvmWalletDataProvider,
  createEvmRpcClient,
  evmChainByKey,
  signTx,
  decodeSignedTx,
  EvmNonceTracker,
  COSMOS_STAKING_SELECTORS,
  COSMOS_DISTRIBUTION_SELECTORS,
} from '../services/chain/evm';
import type { EvmChainInfo } from './evmChains';

const FROM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const FROM_KEY = hexToBytes('1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727');
const VALOPER = 'epixvaloper1qxt7awul3cyvgf2ku08k3n3nqn7lsqvsm7ryjw';
const VALOPER_2 = 'epixvaloper1qjynz59x6c0y2l5cf7gtyl8arjpg0k0rejn0lk';
const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000000800';
const DISTRIBUTION_PRECOMPILE = '0x0000000000000000000000000000000000000801';

/** The store's plain-data mirror of the Epix row. */
const EPIX: EvmChainInfo = {
  key: 'epix',
  chainId: 1916,
  displayName: 'Epix',
  nativeTicker: 'EPIX',
  nativeDecimals: 18,
  explorerTxUrl: 'https://scan.epix.zone/tx/{txid}',
  homepage: 'https://example.test',
  young: false,
  recentlyAdded: false,
  feeModel: 'eip1559',
  l1DataFee: false,
  indexer: { family: 'blockscout', baseUrl: 'https://scan.epix.zone/api/v1' },
  alchemy: false,
  trustWalletChain: null,
  tokenListSlug: null,
  defaultTokens: [],
  staking: { valoperPrefix: 'epixvaloper', accountPrefix: 'epix' },
};

const ONE_EPIX = 10n ** 18n;

interface Req { id: number; method: string; params: unknown[] }

/**
 * A scripted Epix node. The base fee is the chain's real constant 20 gwei
 * (read live 2026-08-20), and eth_estimateGas answers the real 0x1cf9f a
 * delegate of 1 aepix returned on 2026-08-24.
 */
function fakeEpix(
  opts: {
    estimateReverts?: string;
    /** Override the gas estimate, e.g. to trip the fee caps. */
    gas?: string;
    /** eth_call return data by precompile, so the query paths can be scripted. */
    calls?: Record<string, string | { error: string }>;
    pending?: () => bigint;
  } = {},
) {
  const seen: Req[] = [];
  const baseFee = '0x4a817c800'; // 20 gwei
  const answer = (req: Req): Record<string, unknown> => {
    seen.push(req);
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
    const err = (message: string, code = 3) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
    switch (req.method) {
      case 'eth_chainId':
        return ok('0x77c');
      case 'eth_estimateGas':
        return opts.estimateReverts ? err(opts.estimateReverts) : ok(opts.gas ?? '0x1cf9f');
      case 'eth_feeHistory':
        return ok({
          baseFeePerGas: [baseFee, baseFee, baseFee, baseFee, baseFee, baseFee],
          // Epix reported reward 0 on every block; the fee module floors the
          // tip at 1 wei rather than signing a zero tip.
          reward: Array.from({ length: 5 }, () => ['0x0', '0x0', '0x0']),
        });
      case 'eth_call': {
        const call = req.params[0] as { to: string; data: string };
        const scripted = opts.calls?.[call.data.slice(0, 10)];
        if (scripted === undefined) return err('execution reverted: no delegation for (address, validator) tuple');
        if (typeof scripted === 'object') return err(scripted.error);
        return ok(scripted);
      }
      case 'eth_getTransactionCount':
        return ok('0x' + (opts.pending ? opts.pending() : 3n).toString(16));
      case 'eth_sendRawTransaction':
        return ok('0x' + bytesToHex(keccak_256(hexToBytes((req.params[0] as string).slice(2)))));
      default:
        return err('method not found', -32601);
    }
  };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Req | Req[];
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const provider = new EvmWalletDataProvider(createEvmRpcClient(evmChainByKey('epix')!, { fetchImpl }));
  return { provider, seen };
}

const sign = (request: Parameters<typeof signTx>[0]) => signTx(request, FROM_KEY);

beforeEach(() => {
  hoisted.evmEnabled = true;
});

// ---------------------------------------------------------------------------

describe('planEvmCall: the generic contract-call plan', () => {
  it('1. prices arbitrary calldata at every level, with 25% gas headroom over the RAW estimate', async () => {
    const { provider } = fakeEpix();
    const data = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01]);
    const plan = await planEvmCall({
      provider,
      chain: EPIX,
      from: FROM,
      input: { to: STAKING_PRECOMPILE, data, value: 0n, description: 'Do the thing.' },
    });
    // 0x1cf9f = 118687; ceil(118687 * 1.25) = 148359. NOT 1.2 x 1.25: the
    // headroom is recomputed from the raw estimate so the two never compound.
    expect(plan.quote.gasEstimate).toBe(118_687n);
    expect(plan.quote.gasLimit).toBe(148_359n);
    for (const level of ['slow', 'normal', 'fast'] as const) {
      expect(plan.quotes[level].gasLimit).toBe(148_359n);
    }
    expect(plan.level).toBe('normal');
    expect(plan.description).toBe('Do the thing.');
    expect(plan.value).toBe(0n);
    expect(plan.unsigned.gasLimit).toBe(148_359n);
    expect(plan.unsigned.data).toBe(data);
    expect(plan.capRefusal).toBe(null);
  });

  it('2. the totals follow the padded gas limit, both the likely charge and the ceiling', async () => {
    const { provider } = fakeEpix();
    const plan = await planEvmCall({
      provider,
      chain: EPIX,
      from: FROM,
      input: { to: STAKING_PRECOMPILE, data: Uint8Array.from([1, 2, 3, 4]), value: 0n, description: 'x' },
    });
    const q = plan.quote;
    if (q.fee.type !== 'eip1559') throw new Error('expected an eip1559 fee on Epix');
    const likely = (q.baseFeePerGas ?? 0n) + q.fee.maxPriorityFeePerGas;
    expect(q.estimatedTotal).toBe(q.gasLimit * likely);
    expect(q.maxTotal).toBe(q.gasLimit * q.fee.maxFeePerGas);
    // maxFeePerGas is 2 x baseFee + tip, and the tip floor is 1 wei.
    expect(q.baseFeePerGas).toBe(20n * 10n ** 9n);
    expect(q.fee.maxPriorityFeePerGas).toBe(1n);
  });

  it('3. HONEST REFUSAL: a node that will not simulate the call never becomes a plan, and its words are carried through', async () => {
    const { provider } = fakeEpix({ estimateReverts: 'execution reverted: no delegation for (address, validator) tuple' });
    await expect(
      planEvmCall({
        provider,
        chain: EPIX,
        from: FROM,
        input: { to: STAKING_PRECOMPILE, data: Uint8Array.from([1, 2, 3, 4]), value: 0n, description: 'x' },
      }),
    ).rejects.toMatchObject({
      code: 'quote-failed',
      message: expect.stringContaining('no delegation for (address, validator) tuple'),
    });
  });

  it('4. FEE CAP: an absurd gas limit is REFUSED, not clamped, and the plan says so instead of being sendable', async () => {
    // 0.1 EPIX is the Epix total cap. At 40 gwei maxFeePerGas (2 x 20 + 1 wei)
    // that is 2,500,000 gas, so an estimate above 2,000,000 (x1.25) trips it.
    const { provider } = fakeEpix({ gas: '0x2DC6C0' /* 3,000,000 */ });
    const plan = await planEvmCall({
      provider,
      chain: EPIX,
      from: FROM,
      input: { to: STAKING_PRECOMPILE, data: Uint8Array.from([1, 2, 3, 4]), value: 0n, description: 'x' },
    });
    expect(plan.quote.gasLimit).toBe(3_750_000n);
    expect(plan.capRefusal).toMatch(/refus|cap|exceed/i);
    // And the broadcast path refuses it too, not only the screen.
    await expect(
      broadcastEvmPlan({ provider, plan, nonces: new EvmNonceTracker(), sign, allowBroadcast: true }),
    ).rejects.toThrow();
  });

  it('5. shortfall: a fee the balance cannot cover is named, and an unknown balance says nothing', async () => {
    const { provider } = fakeEpix();
    const input = { to: STAKING_PRECOMPILE, data: Uint8Array.from([1, 2, 3, 4]), value: 0n, description: 'x' };
    const broke = await planEvmCall({ provider, chain: EPIX, from: FROM, input, nativeBalanceBase: 1n });
    expect(broke.shortfall).toMatch(/Not enough EPIX to pay the network fee/);
    const rich = await planEvmCall({ provider, chain: EPIX, from: FROM, input, nativeBalanceBase: ONE_EPIX });
    expect(rich.shortfall).toBe(null);
    const unknown = await planEvmCall({ provider, chain: EPIX, from: FROM, input });
    expect(unknown.shortfall).toBe(null);
  });

  it('6. empty calldata, a bad address and a negative value are refused before any request goes out', async () => {
    const { provider, seen } = fakeEpix();
    const base = { to: STAKING_PRECOMPILE, data: Uint8Array.from([1, 2, 3, 4]), value: 0n, description: 'x' };
    await expect(planEvmCall({ provider, chain: EPIX, from: FROM, input: { ...base, data: new Uint8Array() } })).rejects.toThrow(/calldata/);
    await expect(planEvmCall({ provider, chain: EPIX, from: FROM, input: { ...base, to: 'nope' } })).rejects.toThrow(/contract address/);
    await expect(planEvmCall({ provider, chain: EPIX, from: FROM, input: { ...base, value: -1n } })).rejects.toThrow(/non-negative/);
    expect(seen.filter((r) => r.method === 'eth_estimateGas')).toHaveLength(0);
  });

  it('7. switching the fee level re-prices without a new quote', async () => {
    const { provider, seen } = fakeEpix();
    const plan = await planEvmCall({
      provider,
      chain: EPIX,
      from: FROM,
      input: { to: STAKING_PRECOMPILE, data: Uint8Array.from([1, 2, 3, 4]), value: 0n, description: 'x' },
    });
    const before = seen.length;
    const fast = await withEvmCallFeeLevel(plan, 'fast', EPIX, ONE_EPIX);
    expect(fast.level).toBe('fast');
    expect(fast.unsigned.fee).toEqual(plan.quotes.fast.fee);
    expect(seen.length).toBe(before);
  });

  it('8. withCallGasHeadroom never LOWERS a gas limit the fee module already set higher', () => {
    const quote = {
      level: 'normal' as const,
      fee: { type: 'legacy' as const, gasPrice: 1_000_000_000n },
      gasLimit: 21_000n,
      gasEstimate: 1n, // the 21000 protocol floor is what actually applies
      baseFeePerGas: null,
      l1DataFee: 0n,
      estimatedTotal: 0n,
      maxTotal: 0n,
    };
    expect(withCallGasHeadroom(quote).gasLimit).toBe(21_000n);
  });
});

// ---------------------------------------------------------------------------

describe('buildEvmStakePlan: staking on top of the generic plan', () => {
  const call = (action: 'delegate' | 'undelegate' | 'redelegate' | 'claim', extra: Record<string, unknown> = {}) => ({
    provider: fakeEpix().provider,
    chain: EPIX,
    from: FROM,
    input: { action, valoper: VALOPER, amountText: '0.1', moniker: 'OneNov', ...extra },
  });

  it('1. delegate: the staking precompile, the delegate selector, zero value, and a sentence for the review', async () => {
    const plan = await buildEvmStakePlan(call('delegate'));
    expect(plan.to.toLowerCase()).toBe(STAKING_PRECOMPILE);
    expect(plan.value).toBe(0n);
    expect(plan.action).toBe('delegate');
    expect(plan.valoper).toBe(VALOPER);
    expect(`0x${bytesToHex(plan.data.subarray(0, 4))}`).toBe(COSMOS_STAKING_SELECTORS.delegate);
    expect(plan.description).toContain('Stake 0.1 EPIX');
    expect(plan.description).toContain('OneNov');
  });

  it('2. undelegate and redelegate carry their own selectors; claim goes to the DISTRIBUTION precompile', async () => {
    const un = await buildEvmStakePlan(call('undelegate'));
    expect(`0x${bytesToHex(un.data.subarray(0, 4))}`).toBe(COSMOS_STAKING_SELECTORS.undelegate);

    const re = await buildEvmStakePlan(call('redelegate', { dstValoper: VALOPER_2, dstMoniker: 'dnsarz' }));
    expect(`0x${bytesToHex(re.data.subarray(0, 4))}`).toBe(COSMOS_STAKING_SELECTORS.redelegate);
    expect(re.description).toContain('dnsarz');

    const claim = await buildEvmStakePlan(call('claim', { amountText: '81.24' }));
    expect(claim.to.toLowerCase()).toBe(DISTRIBUTION_PRECOMPILE);
    expect(`0x${bytesToHex(claim.data.subarray(0, 4))}`).toBe(COSMOS_DISTRIBUTION_SELECTORS.withdrawDelegatorRewards);
    expect(claim.description).toContain('Claim 81.24 EPIX');
  });

  it('3. the amount is parsed at 18 decimals, exactly, never through a float', async () => {
    const plan = await buildEvmStakePlan(call('delegate', { amountText: '0.000000000000000001' }));
    // The last word of the head is the amount: one aepix.
    const amount = BigInt(`0x${bytesToHex(plan.data.subarray(4 + 64, 4 + 96))}`);
    expect(amount).toBe(1n);
  });

  it('4. a bad amount, a bad validator and a missing redelegate destination all refuse before the node is asked', async () => {
    await expect(buildEvmStakePlan(call('delegate', { amountText: '0' }))).rejects.toThrow(/greater than zero/);
    await expect(buildEvmStakePlan(call('delegate', { amountText: '1e8' }))).rejects.toThrow(/valid amount/);
    await expect(buildEvmStakePlan(call('delegate', { amountText: '0.1', valoper: 'epix1notavalidator' }))).rejects.toThrow(/epixvaloper1/);
    await expect(buildEvmStakePlan(call('redelegate'))).rejects.toThrow(/move the stake to/);
    // Nineteen decimals on an 18-decimal coin is not a rounding matter.
    await expect(buildEvmStakePlan(call('delegate', { amountText: '0.0000000000000000001' }))).rejects.toThrow(/decimal places/);
  });

  it('5. a staking plan broadcasts through the SAME chokepoint a send does, and the bytes decode back to the plan', async () => {
    const { provider } = fakeEpix();
    const plan = await buildEvmStakePlan({
      provider,
      chain: EPIX,
      from: FROM,
      input: { action: 'delegate', valoper: VALOPER, amountText: '0.1', moniker: 'OneNov' },
      nativeBalanceBase: ONE_EPIX,
    });
    const nonces = new EvmNonceTracker();
    // The gate is real: without arming, nothing is signed.
    await expect(broadcastEvmPlan({ provider, plan, nonces, sign, allowBroadcast: false })).rejects.toThrow(/armed/);
    const result = await broadcastEvmPlan({ provider, plan, nonces, sign, allowBroadcast: true });
    expect(result.txid).toMatch(/^0x[0-9a-f]{64}$/);
    const decoded = decodeSignedTx(hexToBytes(result.rawHex.slice(2)));
    expect(decoded.tx.chainId).toBe(1916);
    expect(decoded.tx.to.toLowerCase()).toBe(STAKING_PRECOMPILE);
    expect(decoded.tx.value).toBe(0n);
    expect(bytesToHex(decoded.tx.data)).toBe(bytesToHex(plan.data));
    expect(decoded.tx.nonce).toBe(3n);
  });

  it('6. a build without the EVM engine refuses everything rather than half-working', async () => {
    hoisted.evmEnabled = false;
    const { provider } = fakeEpix();
    await expect(
      buildEvmStakePlan({ provider, chain: EPIX, from: FROM, input: { action: 'delegate', valoper: VALOPER, amountText: '1' } }),
    ).rejects.toThrow(/no EVM engine/);
    expect(await loadEvmStakingSnapshot(EPIX, FROM)).toBe(null);
  });
});

// ---------------------------------------------------------------------------

describe('precompile reads used by the forms', () => {
  it('1. readExactDelegation decodes the live delegation answer and returns base units', async () => {
    const { provider } = fakeEpix({
      calls: {
        [COSMOS_STAKING_SELECTORS.delegation]:
          '0x0000000000000000000000000000007b438609dd5921c5bbe9400724d2280000' +
          '0000000000000000000000000000000000000000000000000000000000000040' +
          '0000000000000000000000000000000000000000000000000000000000000040' +
          '0000000000000000000000000000000000000000000008e1d0aaf104d2cbc89a' +
          '0000000000000000000000000000000000000000000000000000000000000005' +
          '6165706978000000000000000000000000000000000000000000000000000000',
      },
    });
    expect(await readExactDelegation(provider, 'epix', FROM, VALOPER)).toBe(41944485374850759379098n);
  });

  it('2. a delegation in a FOREIGN denom is refused, never counted as the chain coin', async () => {
    const { provider } = fakeEpix({
      calls: {
        [COSMOS_STAKING_SELECTORS.delegation]:
          '0x0000000000000000000000000000000000000000000000000000000000000000' +
          '0000000000000000000000000000000000000000000000000000000000000040' +
          '0000000000000000000000000000000000000000000000000000000000000040' +
          '0000000000000000000000000000000000000000000000000000000000000063' +
          '0000000000000000000000000000000000000000000000000000000000000004' +
          '7573646300000000000000000000000000000000000000000000000000000000',
      },
    });
    expect(await readExactDelegation(provider, 'epix', FROM, VALOPER)).toBe(null);
  });

  it('3. the precompile reverting with "no delegation" is the answer null, not a thrown error', async () => {
    const { provider } = fakeEpix();
    expect(await readExactDelegation(provider, 'epix', FROM, VALOPER)).toBe(null);
    expect(await readUnbondingEntryCount(provider, 'epix', FROM, VALOPER)).toBe(null);
  });

  it('4. readUnbondingEntryCount counts the entries the chain reports', async () => {
    const { provider } = fakeEpix({
      calls: {
        [COSMOS_STAKING_SELECTORS.unbondingDelegation]:
          '0x0000000000000000000000000000000000000000000000000000000000000020' +
          '0000000000000000000000000000000000000000000000000000000000000060' +
          '0000000000000000000000000000000000000000000000000000000000000080' +
          '00000000000000000000000000000000000000000000000000000000000000a0' +
          '0000000000000000000000000000000000000000000000000000000000000000' +
          '0000000000000000000000000000000000000000000000000000000000000000' +
          '0000000000000000000000000000000000000000000000000000000000000000',
      },
    });
    expect(await readUnbondingEntryCount(provider, 'epix', FROM, VALOPER)).toBe(0);
  });

  it('5. a chain with no staking row answers null for both, whatever is asked', async () => {
    const { provider } = fakeEpix();
    expect(await readExactDelegation(provider, 'base', FROM, VALOPER)).toBe(null);
    expect(await readUnbondingEntryCount(provider, 'base', FROM, VALOPER)).toBe(null);
  });
});

// ---------------------------------------------------------------------------

describe('loadEvmStakingSnapshot: never throws, always says what it could not read', () => {
  /** A fake LCD keyed by the leading path segment of the request. */
  function fakeLcd(routes: Record<string, unknown>, fail: string[] = []): typeof fetch {
    return (async (url: string) => {
      const path = new URL(url).pathname;
      const key = Object.keys(routes).find((k) => path.includes(k));
      if (fail.some((f) => path.includes(f))) {
        return { ok: false, status: 503, json: async () => ({}), text: async () => 'upstream down' } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => (key ? routes[key] : {}),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const ROUTES = {
    '/params': { params: { unbonding_time: '1814400s', bond_denom: 'aepix', max_entries: 7, max_validators: 100 } },
    '/validators': {
      validators: [
        {
          operator_address: VALOPER_2,
          jailed: true,
          status: 'BOND_STATUS_BONDED',
          tokens: '10',
          description: { moniker: 'jailed one' },
          commission: { commission_rates: { rate: '0.050000000000000000' } },
        },
        {
          operator_address: VALOPER,
          jailed: false,
          status: 'BOND_STATUS_BONDED',
          tokens: '637226097873326284549745708',
          description: { moniker: 'OneNov | Restake' },
          commission: { commission_rates: { rate: '0.010000000000000000' } },
        },
      ],
    },
    '/delegations/': {
      delegation_responses: [
        { delegation: { validator_address: VALOPER }, balance: { denom: 'aepix', amount: '5000000000000000000' } },
      ],
    },
    '/unbonding_delegations': {
      unbonding_responses: [
        {
          validator_address: VALOPER,
          entries: [{ creation_height: '1', completion_time: '2026-09-14T09:00:00Z', initial_balance: '2', balance: '2' }],
        },
      ],
    },
    '/rewards': {
      rewards: [{ validator_address: VALOPER, reward: [{ denom: 'aepix', amount: '81240454787509949141.8427' }] }],
      total: [{ denom: 'aepix', amount: '81240454787509949141.8427' }],
    },
  };

  it('1. a healthy LCD produces the whole picture: params, validators, my stake, unbonding and rewards', async () => {
    vi.stubGlobal('fetch', fakeLcd(ROUTES));
    const snapshot = await loadEvmStakingSnapshot(EPIX, FROM);
    if (!snapshot) throw new Error('expected a snapshot');
    expect(snapshot.issue).toBe(null);
    expect(snapshot.unbondingSeconds).toBe(1_814_400);
    expect(snapshot.maxEntries).toBe(7);
    // The account's own bech32 form, derived from the same 20 bytes.
    expect(snapshot.bech32Address.startsWith('epix1')).toBe(true);
    // Sorted by voting power, jailed one carried through with its flag so the
    // screen (not the loader) decides whether to show it.
    expect(snapshot.validators.map((v) => v.valoper)).toEqual([VALOPER, VALOPER_2]);
    expect(snapshot.validators[1].jailed).toBe(true);
    expect(snapshot.validators[0].commissionRate).toBe(0.01);
    // My stake, with the moniker joined in from the validator list and the
    // reward joined in from the distribution answer.
    expect(snapshot.delegations).toEqual([
      { valoper: VALOPER, moniker: 'OneNov | Restake', amountBase: 5n * ONE_EPIX, rewardBase: 81240454787509949141n },
    ]);
    expect(snapshot.stakedTotalBase).toBe(5n * ONE_EPIX);
    expect(snapshot.rewardsTotalBase).toBe(81240454787509949141n);
    expect(snapshot.unbonding).toEqual([
      { valoper: VALOPER, moniker: 'OneNov | Restake', balanceBase: 2n, completionTime: Date.parse('2026-09-14T09:00:00Z') },
    ]);
    vi.unstubAllGlobals();
  });

  it('2. one failing list does not hide the others, and the failure is NAMED rather than shown as zero', async () => {
    vi.stubGlobal('fetch', fakeLcd(ROUTES, ['/rewards']));
    const snapshot = await loadEvmStakingSnapshot(EPIX, FROM);
    if (!snapshot) throw new Error('expected a snapshot');
    expect(snapshot.validators).toHaveLength(2);
    expect(snapshot.delegations).toHaveLength(1);
    expect(snapshot.issue).toMatch(/pending rewards could not be read/i);
    expect(snapshot.issue).toMatch(/could not be reached/i);
    vi.unstubAllGlobals();
  });

  it('3. an LCD that is entirely down produces an issue and empty lists, never a throw', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch);
    const snapshot = await loadEvmStakingSnapshot(EPIX, FROM);
    if (!snapshot) throw new Error('expected a snapshot');
    expect(snapshot.validators).toEqual([]);
    expect(snapshot.delegations).toEqual([]);
    expect(snapshot.stakedTotalBase).toBe(0n);
    expect(snapshot.issue).toBeTruthy();
    // The unbonding figure is unknown, and the screen must not print "0 days":
    // unbondingNoteText refuses to invent a period when this is 0.
    expect(snapshot.unbondingSeconds).toBe(0);
    vi.unstubAllGlobals();
  });

  it('4. a chain with no staking row answers an issue rather than reading anything', async () => {
    const noStaking: EvmChainInfo = { ...EPIX, key: 'base', staking: null };
    const snapshot = await loadEvmStakingSnapshot(noStaking, FROM);
    expect(snapshot?.issue).toMatch(/no native staking/i);
    expect(snapshot?.validators).toEqual([]);
  });
});
