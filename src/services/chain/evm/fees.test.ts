// Tests for EVM fee quoting.
//
// NO NETWORK IS TOUCHED HERE, and none may be added: every test injects a
// hand-written EvmRpcClient (FakeRpcClient below) that answers by METHOD and,
// for eth_call, by the target address plus the 4-byte selector, exactly as a
// real node's answer depends only on what was asked. batch() records every
// call it received, which is how the "exactly two round trips" and "one oracle
// call per level" claims are checked rather than asserted.
//
// Numbers are hard-coded on purpose. A fee test that recomputes the fee with
// the same expression the module uses proves only that the expression is
// stable, not that it is right.

import { describe, it, expect } from 'vitest';
import {
  EVM_FEE_LEVELS,
  EvmFeeQuoteError,
  encodeGetL1Fee,
  feeSummary,
  quoteEvmFees,
  type EvmFeeQuote,
} from './fees';
import { evmChainByKey, type EvmChain } from './chains';
import { encodeTransfer, selector } from './erc20';
import {
  EvmRpcError,
  EvmRpcUnavailableError,
  type EvmRpcBatchResult,
  type EvmRpcCall,
  type EvmRpcClient,
} from './rpc';
import { decodeSignedTx } from './tx';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Base: eip1559 AND an L1 data fee, the chain that forces both strategies. */
const BASE: EvmChain = evmChainByKey('base')!;
/** BNB Chain: legacy gasPrice, no L1 surcharge. */
const BSC: EvmChain = evmChainByKey('bsc')!;
/** A 1559 chain WITHOUT the L1 surcharge, so the tip arithmetic can be tested
 *  in one round trip with no oracle script. Not a registry row: a synthetic
 *  chain proves the code reads the flag rather than the chain name. */
const BASE_NO_L1: EvmChain = { ...BASE, key: 'base-no-l1', l1DataFee: undefined };

/** The published "abandon ... about" vector addresses, lowercase (all-lower is
 *  checksum-free and accepted everywhere in this engine). */
const FROM = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const TO = '0x6fac4d18c912343bf86fa7049364dd4e424ab9c0';

/** The OP-stack GasPriceOracle predeploy, lowercased for script lookup. */
const ORACLE = '0x420000000000000000000000000000000000000f';
const GET_L1_FEE = '0x49948e0e';

/** 0.001 ETH, so `value` is a real quantity rather than 0x0. */
const VALUE = 1_000_000_000_000_000n;

const NATIVE_SEND = { from: FROM, to: TO, value: VALUE, data: new Uint8Array(0) };

type Answer = { ok: true; result: unknown } | { ok: false; error: EvmRpcError };

const ok = (result: unknown): Answer => ({ ok: true, result });
const refused = (method: string, message: string): Answer => ({
  ok: false,
  error: new EvmRpcError(method, 3, message),
});

interface Script {
  /** Keyed by JSON-RPC method name. */
  methods?: Record<string, Answer>;
  /** Keyed by `${to lowercase}:${4-byte selector}`. */
  calls?: Record<string, Answer>;
}

class FakeRpcClient implements EvmRpcClient {
  readonly chain: EvmChain;
  /** One entry per batch() invocation, in order. */
  readonly batches: EvmRpcCall[][] = [];
  /** When set, batch() rejects with this instead of consulting the script. */
  batchError: Error | null = null;

  private readonly script: Script;

  constructor(chain: EvmChain, script: Script) {
    this.chain = chain;
    this.script = script;
  }

  batch(calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> {
    this.batches.push(calls);
    if (this.batchError) return Promise.reject(this.batchError);
    return Promise.resolve(calls.map((c) => this.answer(c)));
  }

  /** fees.ts must do all of its work in batches; a single call() is a
   *  regression in the round-trip count and fails loudly here. */
  call<T = unknown>(): Promise<T> {
    return Promise.reject(new Error('fake rpc: fees.ts must use batch(), not call()'));
  }

  activeEndpoint(): string | null {
    return this.chain.rpc[0];
  }

  lastLatencyMs(): number | null {
    return 1;
  }

  private answer(spec: EvmRpcCall): EvmRpcBatchResult {
    if (spec.method === 'eth_call') {
      const target = spec.params?.[0] as { to: string; data: string };
      const key = `${target.to.toLowerCase()}:${target.data.slice(0, 10)}`;
      const scripted = this.script.calls?.[key];
      if (!scripted) throw new Error(`fake rpc: unscripted eth_call ${key}`);
      return scripted;
    }
    const scripted = this.script.methods?.[spec.method];
    if (!scripted) throw new Error(`fake rpc: unscripted method ${spec.method}`);
    return scripted;
  }
}

/** A uint256 return word: big-endian, left-padded to 32 bytes. */
function uintWord(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

/** An eth_feeHistory answer in the shape a node sends it. */
function feeHistory(baseFees: readonly bigint[], rewards: readonly (readonly bigint[])[]): unknown {
  return {
    oldestBlock: '0x1',
    baseFeePerGas: baseFees.map((v) => `0x${v.toString(16)}`),
    gasUsedRatio: rewards.map(() => 0.5),
    reward: rewards.map((row) => row.map((v) => `0x${v.toString(16)}`)),
  };
}

/** Every block reports the same three percentile rewards. */
function flatRewards(blocks: number, tips: readonly bigint[]): bigint[][] {
  return Array.from({ length: blocks }, () => [...tips]);
}

/** The oracle answers the same L1 fee for every level's candidate. */
function oracleAnswers(fee: bigint): Record<string, Answer> {
  return { [`${ORACLE}:${GET_L1_FEE}`]: ok(uintWord(fee)) };
}

/** The Base script of section 2, reused by several sections below. */
function baseScript(): Script {
  return {
    methods: {
      eth_estimateGas: ok('0x5208'),
      eth_feeHistory: ok({
        oldestBlock: '0x1',
        // Six entries for five blocks: the LAST one is the next block's base
        // fee, 5,000,000 wei.
        baseFeePerGas: ['0x4c4b40', '0x4c4b40', '0x4c4b40', '0x4c4b40', '0x4c4b40', '0x4c4b40'],
        gasUsedRatio: [0.5, 0.5, 0.5, 0.5, 0.5],
        // p10 / p50 / p90 = 1,000,000 / 1,100,000 / 3,000,000 wei, every block.
        reward: [
          ['0xf4240', '0x10c8e0', '0x2dc6c0'],
          ['0xf4240', '0x10c8e0', '0x2dc6c0'],
          ['0xf4240', '0x10c8e0', '0x2dc6c0'],
          ['0xf4240', '0x10c8e0', '0x2dc6c0'],
          ['0xf4240', '0x10c8e0', '0x2dc6c0'],
        ],
      }),
    },
    // 12045 wei of L1 data fee.
    calls: oracleAnswers(0x2f0dn),
  };
}

/** The `data` of one recorded eth_call. */
function callData(spec: EvmRpcCall): string {
  return (spec.params?.[0] as { data: string }).data;
}

function callTarget(spec: EvmRpcCall): string {
  return (spec.params?.[0] as { to: string }).to;
}

async function quoteError(promise: Promise<unknown>): Promise<EvmFeeQuoteError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof EvmFeeQuoteError) return err;
    throw err;
  }
  throw new Error('expected the quote to reject');
}

// ---------------------------------------------------------------------------
// 1. The GasPriceOracle calldata
// ---------------------------------------------------------------------------

describe('1. getL1Fee(bytes) encoding', () => {
  it('pins the selector against keccak, not against itself', () => {
    expect(selector('getL1Fee(bytes)')).toBe('0x49948e0e');
    // The neighbouring oracle function, so a copy-paste between the two is
    // visible rather than silent.
    expect(selector('getL1GasUsed(bytes)')).toBe('0xde26c4a1');
  });

  it('encodes a 3-byte payload as selector + offset + length + padded data', () => {
    expect(encodeGetL1Fee(Uint8Array.of(0xaa, 0xbb, 0xcc))).toBe(
      '0x49948e0e' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000003' +
        'aabbcc0000000000000000000000000000000000000000000000000000000000',
    );
  });

  it('encodes an empty payload with a zero length and no tail word', () => {
    expect(encodeGetL1Fee(new Uint8Array(0))).toBe(
      '0x49948e0e' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000000',
    );
  });

  it('does not add a padding word when the payload is already a whole word', () => {
    const payload = new Uint8Array(32).fill(0x11);
    const encoded = encodeGetL1Fee(payload);
    // selector (10 chars incl. 0x) + offset + length + exactly one data word.
    expect(encoded.length).toBe(10 + 64 * 3);
    expect(encoded.endsWith('11'.repeat(32))).toBe(true);
  });

  it('pads a 33-byte payload up to two words', () => {
    expect(encodeGetL1Fee(new Uint8Array(33).fill(0x11)).length).toBe(10 + 64 * 4);
  });
});

// ---------------------------------------------------------------------------
// 2. Base: EIP-1559 plus the L1 data fee
// ---------------------------------------------------------------------------

describe('2. Base (eip1559 + l1 data fee)', () => {
  it('prices three levels off feeHistory and the oracle', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    const q = await quoteEvmFees(rpc, NATIVE_SEND);

    expect(Object.keys(q)).toEqual(['slow', 'normal', 'fast']);

    // Gas: the raw estimate, and the same 20%-headroom limit for every level.
    for (const level of EVM_FEE_LEVELS) {
      const quote: EvmFeeQuote = q[level];
      expect(quote.level).toBe(level);
      expect(quote.gasEstimate).toBe(21_000n);
      expect(quote.gasLimit).toBe(25_200n);
      expect(quote.baseFeePerGas).toBe(5_000_000n);
      expect(quote.l1DataFee).toBe(12_045n);
    }

    // normal: tip = median p50 = 1,100,000; maxFee = 2*5,000,000 + tip.
    expect(q.normal.fee).toEqual({
      type: 'eip1559',
      maxFeePerGas: 11_100_000n,
      maxPriorityFeePerGas: 1_100_000n,
    });
    // 25200 * (5,000,000 + 1,100,000) + 12,045
    expect(q.normal.estimatedTotal).toBe(153_720_012_045n);
    // 25200 * 11,100,000 + 12,045
    expect(q.normal.maxTotal).toBe(279_720_012_045n);

    expect(q.slow.fee).toEqual({
      type: 'eip1559',
      maxFeePerGas: 11_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    expect(q.slow.estimatedTotal).toBe(151_200_012_045n);
    expect(q.slow.maxTotal).toBe(277_200_012_045n);

    expect(q.fast.fee).toEqual({
      type: 'eip1559',
      maxFeePerGas: 13_000_000n,
      maxPriorityFeePerGas: 3_000_000n,
    });
    expect(q.fast.estimatedTotal).toBe(201_600_012_045n);
    expect(q.fast.maxTotal).toBe(327_600_012_045n);

    // The two totals are not the same number, and the max is the larger one.
    for (const level of EVM_FEE_LEVELS) {
      expect(q[level].maxTotal).toBeGreaterThan(q[level].estimatedTotal);
      const fee = q[level].fee;
      // Asserted for every level: a node rejects a priority fee above the max
      // AFTER the user has signed.
      if (fee.type === 'eip1559') {
        expect(fee.maxPriorityFeePerGas <= fee.maxFeePerGas).toBe(true);
      }
    }
  });

  it('makes exactly two round trips: gas + market, then ONE oracle call shared by every level', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    await quoteEvmFees(rpc, NATIVE_SEND);

    expect(rpc.batches.length).toBe(2);

    const [first, second] = rpc.batches;
    expect(first.map((c) => c.method)).toEqual(['eth_estimateGas', 'eth_feeHistory']);
    expect(first[0].params?.[0]).toEqual({
      from: FROM,
      to: TO,
      value: '0x38d7ea4c68000',
      // Always sent, '0x' for a native transfer.
      data: '0x',
    });
    expect(first[1].params).toEqual(['0x5', 'latest', [10, 50, 90]]);

    // ONE call, not one per level: the public Base RPC rate-limits a burst,
    // and the levels differ by a byte or two of RLP at most. It is priced on
    // the level with the largest fee fields (fast), an upper bound for the rest.
    expect(second.length).toBe(1);
    const spec = second[0];
    expect(spec.method).toBe('eth_call');
    expect(callTarget(spec).toLowerCase()).toBe(ORACLE);
    expect(callData(spec).startsWith('0x49948e0e')).toBe(true);
    expect(spec.params?.[1]).toBe('latest');
    const priced = decodeSignedTx(oraclePayload(callData(spec)));
    const q = await quoteEvmFees(new FakeRpcClient(BASE, baseScript()), NATIVE_SEND);
    expect(priced.tx.fee).toEqual(q.fast.fee);
    expect(q.slow.l1DataFee).toBe(q.fast.l1DataFee);
  });

  it('carries ERC-20 calldata into both the estimate and the oracle payload', async () => {
    const data = encodeTransfer(TO, 1_234_567n);
    const rpc = new FakeRpcClient(BASE, baseScript());
    await quoteEvmFees(rpc, { from: FROM, to: TO, value: 0n, data });

    const estimate = rpc.batches[0][0].params?.[0] as { data: string; value: string };
    expect(estimate.value).toBe('0x0');
    expect(estimate.data.length).toBe(2 + 68 * 2);
    // The 68 bytes of calldata are inside the signed candidate the oracle
    // prices, so the payload is far longer than a bare native transfer's.
    expect(callData(rpc.batches[1][0]).length).toBeGreaterThan(10 + 64 * 2 + 68 * 2);
  });
});

// ---------------------------------------------------------------------------
// 3. BSC: legacy gasPrice, no L1 surcharge
// ---------------------------------------------------------------------------

describe('3. BNB Chain (legacy gasPrice)', () => {
  it('marks the node gasPrice up per level and makes ONE round trip', async () => {
    const rpc = new FakeRpcClient(BSC, {
      // 50,000,000 wei = 0.05 gwei, the live 2026-08-18 BSC figure.
      methods: { eth_estimateGas: ok('0x5208'), eth_gasPrice: ok('0x2faf080') },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND);

    expect(rpc.batches.length).toBe(1);
    expect(rpc.batches[0].map((c) => c.method)).toEqual(['eth_estimateGas', 'eth_gasPrice']);
    expect(rpc.batches[0][1].params).toEqual([]);

    expect(q.slow.fee).toEqual({ type: 'legacy', gasPrice: 50_000_000n });
    expect(q.normal.fee).toEqual({ type: 'legacy', gasPrice: 55_000_000n });
    expect(q.fast.fee).toEqual({ type: 'legacy', gasPrice: 62_500_000n });

    for (const level of EVM_FEE_LEVELS) {
      expect(q[level].baseFeePerGas).toBeNull();
      expect(q[level].l1DataFee).toBe(0n);
      // No ceiling above the price on legacy, so the two totals coincide.
      expect(q[level].maxTotal).toBe(q[level].estimatedTotal);
    }

    expect(q.slow.estimatedTotal).toBe(1_260_000_000_000n); // 25200 * 50,000,000
    expect(q.normal.estimatedTotal).toBe(1_386_000_000_000n); // 25200 * 55,000,000
    expect(q.fast.estimatedTotal).toBe(1_575_000_000_000n); // 25200 * 62,500,000
  });

  it('rounds a legacy markup down rather than inventing a fraction', async () => {
    const rpc = new FakeRpcClient(BSC, {
      // 7 wei: 7*110/100 = 7.7 -> 7, 7*125/100 = 8.75 -> 8.
      methods: { eth_estimateGas: ok('0x5208'), eth_gasPrice: ok('0x7') },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND);
    expect(q.slow.fee).toEqual({ type: 'legacy', gasPrice: 7n });
    expect(q.normal.fee).toEqual({ type: 'legacy', gasPrice: 7n });
    expect(q.fast.fee).toEqual({ type: 'legacy', gasPrice: 8n });
  });
});

// ---------------------------------------------------------------------------
// 4. The tip is a MEDIAN over blocks
// ---------------------------------------------------------------------------

describe('4. median tip', () => {
  it('takes the middle of an odd number of blocks, not the mean and not the last', async () => {
    const tips = [1_000_000n, 5_000_000n, 3_000_000n, 2_000_000n, 4_000_000n];
    const rpc = new FakeRpcClient(BASE_NO_L1, {
      methods: {
        eth_estimateGas: ok('0x5208'),
        eth_feeHistory: ok(
          feeHistory(
            [5_000_000n, 5_000_000n, 5_000_000n, 5_000_000n, 5_000_000n, 5_000_000n],
            tips.map((t) => [t, t, t]),
          ),
        ),
      },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND, { levels: ['normal'] });
    // sorted: 1, 2, 3, 4, 5 (millions) -> 3,000,000. The mean would be
    // 3,000,000 too here only by accident; the LAST block's 4,000,000 and the
    // maximum 5,000,000 are both excluded, which is the point.
    expect(q.normal?.fee).toEqual({
      type: 'eip1559',
      maxFeePerGas: 13_000_000n,
      maxPriorityFeePerGas: 3_000_000n,
    });
  });

  it('takes the LOWER middle on an even number of blocks', async () => {
    const tips = [1_000_000n, 5_000_000n, 3_000_000n, 2_000_000n];
    const rpc = new FakeRpcClient(BASE_NO_L1, {
      methods: {
        eth_estimateGas: ok('0x5208'),
        eth_feeHistory: ok(
          feeHistory(
            [5_000_000n, 5_000_000n, 5_000_000n, 5_000_000n, 5_000_000n],
            tips.map((t) => [t, t, t]),
          ),
        ),
      },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND, { levels: ['normal'] });
    // sorted: 1, 2, 3, 5 -> the lower middle is 2,000,000. Averaging the two
    // middles would invent 2,500,000, a tip nobody paid.
    expect(q.normal?.fee).toEqual({
      type: 'eip1559',
      maxFeePerGas: 12_000_000n,
      maxPriorityFeePerGas: 2_000_000n,
    });
  });

  it('sorts numerically, not as strings (9 wei is below 10 wei)', async () => {
    const tips = [10n, 9n, 10n];
    const rpc = new FakeRpcClient(BASE_NO_L1, {
      methods: {
        eth_estimateGas: ok('0x5208'),
        eth_feeHistory: ok(feeHistory([0n, 0n, 0n, 0n], tips.map((t) => [t, t, t]))),
      },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND, { levels: ['normal'] });
    // String order would put '9' last and pick 10n as the middle of
    // ['10','10','9'].
    expect(q.normal?.fee).toEqual({
      type: 'eip1559',
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 10n,
    });
  });

  it('reads each level from its own percentile column', async () => {
    const rpc = new FakeRpcClient(BASE_NO_L1, {
      methods: {
        eth_estimateGas: ok('0x5208'),
        eth_feeHistory: ok(feeHistory([100n, 100n], flatRewards(1, [7n, 8n, 9n]))),
      },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND);
    expect(q.slow.fee).toEqual({ type: 'eip1559', maxFeePerGas: 207n, maxPriorityFeePerGas: 7n });
    expect(q.normal.fee).toEqual({ type: 'eip1559', maxFeePerGas: 208n, maxPriorityFeePerGas: 8n });
    expect(q.fast.fee).toEqual({ type: 'eip1559', maxFeePerGas: 209n, maxPriorityFeePerGas: 9n });
  });
});

// ---------------------------------------------------------------------------
// 5. A zero median tip becomes 1 wei, never a gwei
// ---------------------------------------------------------------------------

describe('5. zero-tip floor', () => {
  it('uses 1 wei when the median tip is zero', async () => {
    const rpc = new FakeRpcClient(BASE_NO_L1, {
      methods: {
        eth_estimateGas: ok('0x5208'),
        eth_feeHistory: ok(feeHistory([5_000_000n, 5_000_000n], flatRewards(1, [0n, 0n, 0n]))),
      },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND);
    for (const level of EVM_FEE_LEVELS) {
      const fee = q[level].fee;
      expect(fee).toEqual({
        type: 'eip1559',
        maxFeePerGas: 10_000_001n,
        maxPriorityFeePerGas: 1n,
      });
      // The floor that must NOT exist: 1 gwei would be 1,000,000,000 wei, a
      // thousandfold overpayment on a chain whose going tip is 0.001 gwei.
      expect(fee.type === 'eip1559' && fee.maxPriorityFeePerGas < 1_000_000_000n).toBe(true);
    }
  });

  it('leaves a non-zero median alone', async () => {
    const rpc = new FakeRpcClient(BASE_NO_L1, {
      methods: {
        eth_estimateGas: ok('0x5208'),
        eth_feeHistory: ok(feeHistory([5_000_000n, 5_000_000n], flatRewards(1, [2n, 2n, 2n]))),
      },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND, { levels: ['slow'] });
    expect(q.slow?.fee).toEqual({
      type: 'eip1559',
      maxFeePerGas: 10_000_002n,
      maxPriorityFeePerGas: 2n,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Failure modes, and they stay distinguishable
// ---------------------------------------------------------------------------

describe('6. failures', () => {
  it('reports a reverting estimate with the node message in detail', async () => {
    const rpc = new FakeRpcClient(BASE, {
      methods: {
        eth_estimateGas: refused(
          'eth_estimateGas',
          'insufficient funds for gas * price + value: balance 0',
        ),
        eth_feeHistory: ok(feeHistory([1n, 1n], flatRewards(1, [1n, 1n, 1n]))),
      },
    });
    const err = await quoteError(quoteEvmFees(rpc, NATIVE_SEND));
    expect(err.reason).toBe('estimate-reverted');
    expect(err.detail).toContain('insufficient funds for gas * price + value');
    // No oracle round trip happens after a failed estimate.
    expect(rpc.batches.length).toBe(1);
  });

  it('reports execution reverted as estimate-reverted too', async () => {
    const rpc = new FakeRpcClient(BSC, {
      methods: {
        eth_estimateGas: refused('eth_estimateGas', 'execution reverted'),
        eth_gasPrice: ok('0x2faf080'),
      },
    });
    const err = await quoteError(quoteEvmFees(rpc, NATIVE_SEND));
    expect(err.reason).toBe('estimate-reverted');
    expect(err.detail).toContain('execution reverted');
  });

  it('reports a transport failure as unavailable', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    rpc.batchError = new EvmRpcUnavailableError('for batch [eth_estimateGas, eth_feeHistory]', [
      { url: 'https://mainnet.base.org', reason: 'timeout after 10000ms' },
    ]);
    const err = await quoteError(quoteEvmFees(rpc, NATIVE_SEND));
    expect(err.reason).toBe('unavailable');
    expect(err.detail).toContain('timeout after 10000ms');
  });

  it('reports a malformed baseFeePerGas as malformed-fee-data', async () => {
    const rpc = new FakeRpcClient(BASE_NO_L1, {
      methods: {
        eth_estimateGas: ok('0x5208'),
        eth_feeHistory: ok({
          oldestBlock: '0x1',
          // A leading zero is not a JSON-RPC quantity.
          baseFeePerGas: ['0x4c4b40', '0x04c4b40'],
          gasUsedRatio: [0.5],
          reward: [['0x1', '0x1', '0x1']],
        }),
      },
    });
    const err = await quoteError(quoteEvmFees(rpc, NATIVE_SEND));
    expect(err.reason).toBe('malformed-fee-data');
    expect(err.detail).toContain('baseFeePerGas');
  });

  it('refuses a feeHistory with no baseFeePerGas, no rewards, or a short reward row', async () => {
    const cases: unknown[] = [
      { oldestBlock: '0x1', gasUsedRatio: [0.5], reward: [['0x1', '0x1', '0x1']] },
      { oldestBlock: '0x1', baseFeePerGas: ['0x1', '0x1'], gasUsedRatio: [0.5], reward: [] },
      {
        oldestBlock: '0x1',
        baseFeePerGas: ['0x1', '0x1'],
        gasUsedRatio: [0.5],
        reward: [['0x1', '0x1']],
      },
      'not an object at all',
    ];
    for (const answer of cases) {
      const rpc = new FakeRpcClient(BASE_NO_L1, {
        methods: { eth_estimateGas: ok('0x5208'), eth_feeHistory: ok(answer) },
      });
      const err = await quoteError(quoteEvmFees(rpc, NATIVE_SEND));
      expect(err.reason).toBe('malformed-fee-data');
    }
  });

  it('reports a refused feeHistory or gasPrice as malformed-fee-data, not as offline', async () => {
    const noHistory = new FakeRpcClient(BASE, {
      methods: {
        eth_estimateGas: ok('0x5208'),
        eth_feeHistory: refused('eth_feeHistory', 'the method eth_feeHistory does not exist'),
      },
    });
    expect((await quoteError(quoteEvmFees(noHistory, NATIVE_SEND))).reason).toBe(
      'malformed-fee-data',
    );

    const noGasPrice = new FakeRpcClient(BSC, {
      methods: {
        eth_estimateGas: ok('0x5208'),
        eth_gasPrice: refused('eth_gasPrice', 'rate limit exceeded'),
      },
    });
    expect((await quoteError(quoteEvmFees(noGasPrice, NATIVE_SEND))).reason).toBe(
      'malformed-fee-data',
    );
  });

  it('refuses a malformed gasPrice and a malformed gas estimate', async () => {
    const badPrice = new FakeRpcClient(BSC, {
      methods: { eth_estimateGas: ok('0x5208'), eth_gasPrice: ok(50_000_000) },
    });
    expect((await quoteError(quoteEvmFees(badPrice, NATIVE_SEND))).reason).toBe(
      'malformed-fee-data',
    );

    const badGas = new FakeRpcClient(BSC, {
      methods: { eth_estimateGas: ok('21000'), eth_gasPrice: ok('0x2faf080') },
    });
    expect((await quoteError(quoteEvmFees(badGas, NATIVE_SEND))).reason).toBe('malformed-fee-data');
  });

  it('refuses to quote Base at all when the L1 oracle refuses', async () => {
    const script = baseScript();
    script.calls = {
      [`${ORACLE}:${GET_L1_FEE}`]: refused('eth_call', 'execution reverted'),
    };
    const rpc = new FakeRpcClient(BASE, script);
    const err = await quoteError(quoteEvmFees(rpc, NATIVE_SEND));
    // A Base preview without the L1 part is a wrong number, not a partial one.
    expect(err.reason).toBe('malformed-fee-data');
    expect(err.detail).toMatch(/^l1 fee oracle refused: /);
  });

  it('refuses an oracle answer that is not one word', async () => {
    const script = baseScript();
    script.calls = { [`${ORACLE}:${GET_L1_FEE}`]: ok('0x2f0d') };
    const rpc = new FakeRpcClient(BASE, script);
    const err = await quoteError(quoteEvmFees(rpc, NATIVE_SEND));
    expect(err.reason).toBe('malformed-fee-data');
    expect(err.detail).toContain('unreadable');
  });

  it('reports a transport failure during the ORACLE round trip as unavailable', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    const original = rpc.batch.bind(rpc);
    let seen = 0;
    rpc.batch = (calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> => {
      seen += 1;
      if (seen === 2) {
        return Promise.reject(
          new EvmRpcUnavailableError('for batch [eth_call]', [
            { url: 'https://mainnet.base.org', reason: 'HTTP 503' },
          ]),
        );
      }
      return original(calls);
    };
    const err = await quoteError(quoteEvmFees(rpc, NATIVE_SEND));
    expect(err.reason).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// 7. gasLimit: 20% headroom, ceiling division, protocol floor
// ---------------------------------------------------------------------------

describe('7. gasLimit', () => {
  const quoteWithEstimate = async (estimate: string): Promise<EvmFeeQuote> => {
    const rpc = new FakeRpcClient(BSC, {
      methods: { eth_estimateGas: ok(estimate), eth_gasPrice: ok('0x2faf080') },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND, { levels: ['normal'] });
    return q.normal!;
  };

  it('floors at the protocol minimum of 21000', async () => {
    const q = await quoteWithEstimate('0x1000'); // 4096 -> 4916, floored
    expect(q.gasEstimate).toBe(4_096n);
    expect(q.gasLimit).toBe(21_000n);
  });

  it('adds 20% above the floor', async () => {
    const q = await quoteWithEstimate('0x186a0'); // 100000
    expect(q.gasEstimate).toBe(100_000n);
    expect(q.gasLimit).toBe(120_000n);
  });

  it('rounds the headroom UP, never down', async () => {
    const q = await quoteWithEstimate('0x5209'); // 21001 * 1.2 = 25201.2
    expect(q.gasLimit).toBe(25_202n);
  });

  it('is exact when 1.2x divides evenly', async () => {
    const q = await quoteWithEstimate('0x5208'); // 21000 * 1.2 = 25200
    expect(q.gasLimit).toBe(25_200n);
  });
});

// ---------------------------------------------------------------------------
// 8. opts.levels
// ---------------------------------------------------------------------------

describe('8. requested levels', () => {
  it('prices one level and asks the oracle exactly once', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    const q = await quoteEvmFees(rpc, NATIVE_SEND, { levels: ['normal'] });

    expect(Object.keys(q)).toEqual(['normal']);
    expect(q.slow).toBeUndefined();
    expect(q.fast).toBeUndefined();
    expect(rpc.batches.length).toBe(2);
    expect(rpc.batches[1].length).toBe(1);
    // All three percentiles are still requested: one round trip either way.
    expect(rpc.batches[0][1].params).toEqual(['0x5', 'latest', [10, 50, 90]]);
    expect(q.normal?.fee).toEqual({
      type: 'eip1559',
      maxFeePerGas: 11_100_000n,
      maxPriorityFeePerGas: 1_100_000n,
    });
  });

  it('keeps the caller order and deduplicates', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    const q = await quoteEvmFees(rpc, NATIVE_SEND, { levels: ['fast', 'slow', 'fast'] });
    expect(Object.keys(q)).toEqual(['fast', 'slow']);
    expect(rpc.batches[1].length).toBe(1);
  });

  it('refuses an empty or unknown level list before any round trip', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    await expect(quoteEvmFees(rpc, NATIVE_SEND, { levels: [] })).rejects.toThrow(/must not be empty/);
    await expect(
      quoteEvmFees(rpc, NATIVE_SEND, { levels: ['instant' as unknown as 'fast'] }),
    ).rejects.toThrow(/unknown fee level/);
    expect(rpc.batches.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Local validation happens before any network work
// ---------------------------------------------------------------------------

describe('9. input validation', () => {
  const cases: Array<[string, { from: string; to: string; value: bigint; data: Uint8Array }]> = [
    ['a short to', { ...NATIVE_SEND, to: '0x123' }],
    ['a to without 0x', { ...NATIVE_SEND, to: '6fac4d18c912343bf86fa7049364dd4e424ab9c0' }],
    ['a non-hex to', { ...NATIVE_SEND, to: '0xzzzc4d18c912343bf86fa7049364dd4e424ab9c0' }],
    ['a short from', { ...NATIVE_SEND, from: '0xabc' }],
    ['a negative value', { ...NATIVE_SEND, value: -1n }],
  ];

  for (const [what, input] of cases) {
    it(`refuses ${what} with a plain Error and sends nothing`, async () => {
      const rpc = new FakeRpcClient(BASE, baseScript());
      const err: unknown = await quoteEvmFees(rpc, input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      // NOT an EvmFeeQuoteError: this is the caller's bug, not a network state
      // the UI should render as "the node said no".
      expect(err).not.toBeInstanceOf(EvmFeeQuoteError);
      expect(rpc.batches.length).toBe(0);
    });
  }

  it('refuses data that is not bytes', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    await expect(
      quoteEvmFees(rpc, { ...NATIVE_SEND, data: '0xdeadbeef' as unknown as Uint8Array }),
    ).rejects.toThrow(/Uint8Array/);
    expect(rpc.batches.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. feeSummary
// ---------------------------------------------------------------------------

describe('10. feeSummary', () => {
  it('names the max fee per gas on a 1559 quote', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    const q = await quoteEvmFees(rpc, NATIVE_SEND);
    expect(feeSummary(q.normal)).toEqual({ perGas: 11_100_000n, label: 'max fee per gas' });
    expect(feeSummary(q.fast)).toEqual({ perGas: 13_000_000n, label: 'max fee per gas' });
  });

  it('names the gas price on a legacy quote', async () => {
    const rpc = new FakeRpcClient(BSC, {
      methods: { eth_estimateGas: ok('0x5208'), eth_gasPrice: ok('0x2faf080') },
    });
    const q = await quoteEvmFees(rpc, NATIVE_SEND);
    expect(feeSummary(q.normal)).toEqual({ perGas: 55_000_000n, label: 'gas price' });
    expect(feeSummary(q.slow)).toEqual({ perGas: 50_000_000n, label: 'gas price' });
  });
});

// ---------------------------------------------------------------------------
// 11. The oracle prices THIS transaction
// ---------------------------------------------------------------------------

/** The `bytes` payload inside a getL1Fee(bytes) calldata. */
function oraclePayload(calldata: string): string {
  const length = Number(BigInt(`0x${calldata.slice(74, 138)}`));
  return `0x${calldata.slice(138, 138 + length * 2)}`;
}

describe('11. the signed candidate the oracle prices', () => {
  it('decodes back to the transaction the user will send', async () => {
    const data = encodeTransfer(TO, 5_000_000n);
    const input = { from: FROM, to: TO, value: 0n, data };
    const rpc = new FakeRpcClient(BASE, baseScript());
    const q = await quoteEvmFees(rpc, input);

    expect(rpc.batches[1].length).toBe(1);
    const calldata = callData(rpc.batches[1][0]);
    expect(calldata.slice(0, 10)).toBe(GET_L1_FEE);
    // Dynamic `bytes`: offset word, then length word, then the data.
    expect(BigInt(`0x${calldata.slice(10, 74)}`)).toBe(32n);
    const length = Number(BigInt(`0x${calldata.slice(74, 138)}`));
    const payload = `0x${calldata.slice(138, 138 + length * 2)}`;
    // The tail is padded to a whole word, so the encoded form is longer than
    // the payload it declares.
    expect(calldata.length).toBeGreaterThanOrEqual(138 + length * 2);

    const decoded = decodeSignedTx(payload);
    // Priced on the level with the largest fee fields: fast.
    const quote: EvmFeeQuote = q.fast;
    expect(decoded.tx.chainId).toBe(BASE.chainId);
    expect(decoded.tx.to).toBe(TO);
    expect(decoded.tx.value).toBe(0n);
    expect(Array.from(decoded.tx.data)).toEqual(Array.from(data));
    expect(decoded.tx.gasLimit).toBe(quote.gasLimit);
    expect(decoded.tx.fee).toEqual(quote.fee);
    // Only the nonce and the signature are not the user's: see TRAP 1.
    expect(decoded.tx.nonce).toBe(0n);
    expect(decoded.r).toBeGreaterThan(0n);
    // Every level carries that one figure.
    for (const level of EVM_FEE_LEVELS) expect(q[level].l1DataFee).toBe(q.fast.l1DataFee);
  });

  it('prices a native transfer with the value and gas limit it will carry', async () => {
    const rpc = new FakeRpcClient(BASE, baseScript());
    const q = await quoteEvmFees(rpc, NATIVE_SEND, { levels: ['slow'] });
    const calldata = callData(rpc.batches[1][0]);
    const length = Number(BigInt(`0x${calldata.slice(74, 138)}`));
    const decoded = decodeSignedTx(`0x${calldata.slice(138, 138 + length * 2)}`);
    expect(decoded.tx.value).toBe(VALUE);
    expect(decoded.tx.data.length).toBe(0);
    expect(decoded.tx.gasLimit).toBe(25_200n);
    expect(decoded.tx.fee).toEqual(q.slow?.fee);
  });
});
