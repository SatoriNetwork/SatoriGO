// The swap planner end to end THROUGH THE REAL EVM MODULES against a fake Base
// node that holds a small world of Uniswap v3 pools: routing, the allowance
// step, the swap plan and its refusals. No network.

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

import { broadcastEvmPlan } from './evmSend';
import {
  quoteSwap,
  buildSwapApprovePlan,
  buildSwapPlan,
  swapSupported,
  swapNeedsImpactAck,
  swapFeeFor,
  SwapNeedsApprovalError,
  SWAP_DEADLINE_SECONDS,
  SWAP_FEE_BPS,
  SWAP_FEE_RECIPIENT,
  type SwapToken,
} from './evmSwap';
import {
  EvmWalletDataProvider,
  createEvmRpcClient,
  evmChainByKey,
  signTx,
  decodeSignedTx,
  EvmNonceTracker,
  UNISWAP_V3,
  UNISWAP_V3_SELECTORS,
  ERC20_SELECTORS,
  decodeErc20Calldata,
  encodeSwap,
  encodeSweepTokenWithFee,
  encodeSelfPermitIfNecessary,
  permitDomainSeparator,
  permitTypedData,
  splitPermitSignature,
  signTypedData,
  midPriceOut,
  type TypedData,
  type SwapHop,
} from '../services/chain/evm';
import type { EvmChainInfo } from './evmChains';

const FROM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const FROM_KEY = hexToBytes('1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727');
const ORACLE = '0x420000000000000000000000000000000000000f';
const D = UNISWAP_V3.base;
const WETH_ADDR = D.wrappedNative;
const USDC_ADDR = D.stable;
const SATORI_ADDR = '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17';
const OTHER_ADDR = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

const ETH: SwapToken = { address: null, symbol: 'ETH', decimals: 18 };
const WETH: SwapToken = { address: WETH_ADDR, symbol: 'WETH', decimals: 18 };
const USDC: SwapToken = { address: USDC_ADDR, symbol: 'USDC', decimals: 6 };
const SATORI: SwapToken = { address: SATORI_ADDR, symbol: 'SATORI', decimals: 18 };
const OTHER: SwapToken = { address: OTHER_ADDR, symbol: 'OTHER', decimals: 18 };

const BASE: EvmChainInfo = {
  key: 'base',
  chainId: 8453,
  displayName: 'Base',
  nativeTicker: 'ETH',
  nativeDecimals: 18,
  explorerTxUrl: 'https://basescan.org/tx/{txid}',
  homepage: 'https://example.test',
  young: false,
  recentlyAdded: false,
  feeModel: 'eip1559',
  l1DataFee: true,
  indexer: null,
  alchemy: false,
  trustWalletChain: null,
  tokenListSlug: null,
  defaultTokens: [],
};

const word = (n: bigint | number | string) => (typeof n === 'string' ? n : BigInt(n).toString(16)).padStart(64, '0');
const lower = (a: string) => a.slice(2).toLowerCase();

/** One pool of the fake world. `sqrt` is its slot0 price; quotes pay the mid
 *  price less the pool fee, less `impactBps` more to stand in for depth. */
interface FakePool {
  a: string;
  b: string;
  fee: number;
  sqrt: bigint;
  impactBps?: number;
  /** slot0 reverts: the price cannot be read. */
  noPrice?: boolean;
}

const Q96 = 1n << 96n;
/** What the fake chain's clock reads. */
const BLOCK_TIME = 1_800_000_000n;
/** The pools most tests share. USDC is token0 against SATORI, WETH is token0
 *  against USDC; a price of 4 and of 1 keep the arithmetic readable. */
const POOLS: FakePool[] = [
  { a: USDC_ADDR, b: SATORI_ADDR, fee: 3000, sqrt: 2n * Q96 },
  { a: WETH_ADDR, b: USDC_ADDR, fee: 500, sqrt: Q96 },
  { a: WETH_ADDR, b: USDC_ADDR, fee: 3000, sqrt: Q96 },
];

interface Req { id: number; method: string; params: unknown[] }

function fakeBase(
  opts: {
    pools?: FakePool[];
    allowance?: bigint;
    balance?: bigint;
    estimateReverts?: string;
    satoriLockRound?: bigint;
    /** The latest block's timestamp; null = the node will not say. */
    blockTime?: bigint | null;
    /** Tokens answer like ones with EIP-2612 permit, under this domain. */
    permit?: { name: string; version: string; nonce: bigint };
    /** The token refuses the signed permit when it is shown one. */
    permitRefused?: boolean;
  } = {},
) {
  const pools = opts.pools ?? POOLS;
  const seen: Req[] = [];
  const baseFee = '0x4c4b40';
  const poolAddress = (i: number) => `0x${(i + 1).toString(16).padStart(40, 'a')}`;
  const findPool = (x: string, y: string, fee: number) =>
    pools.findIndex((p) => p.fee === fee && [lower(p.a), lower(p.b)].sort().join() === [x, y].sort().join());

  const answer = (req: Req): Record<string, unknown> => {
    seen.push(req);
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
    const err = (message: string, code = 3) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
    switch (req.method) {
      case 'eth_chainId':
        return ok('0x2105');
      case 'eth_estimateGas':
        return opts.estimateReverts ? err(opts.estimateReverts) : ok('0x30d40');
      case 'eth_feeHistory':
        return ok({
          baseFeePerGas: [baseFee, baseFee, baseFee, baseFee, baseFee, baseFee],
          reward: Array.from({ length: 5 }, () => ['0xf4240', '0x10c8e0', '0x2dc6c0']),
        });
      case 'eth_gasPrice':
        return ok('0x5b8d80');
      case 'eth_getBlockByNumber':
        return opts.blockTime === null ? ok(null) : ok({ timestamp: '0x' + (opts.blockTime ?? BLOCK_TIME).toString(16) });
      case 'eth_call': {
        const call = req.params[0] as { to: string; data: string };
        const to = call.to.toLowerCase();
        const sel = call.data.slice(0, 10);
        const body = call.data.slice(10);
        if (to === ORACLE) return ok('0x' + word(0x2f0d));
        if (to === D.quoterV2.toLowerCase() && sel === UNISWAP_V3_SELECTORS.quoteExactInput) {
          const amountIn = BigInt('0x' + body.slice(64, 128));
          const length = Number(BigInt('0x' + body.slice(128, 192)));
          const path = body.slice(192, 192 + length * 2);
          let amount = amountIn;
          for (let at = 0; at + 86 <= path.length; at += 46) {
            const tokenIn = path.slice(at, at + 40);
            const fee = parseInt(path.slice(at + 40, at + 46), 16);
            const tokenOut = path.slice(at + 46, at + 86);
            const i = findPool(tokenIn, tokenOut, fee);
            if (i < 0) return err('execution reverted');
            amount = midPriceOut(amount, [{ tokenIn: `0x${tokenIn}`, tokenOut: `0x${tokenOut}`, fee }], [pools[i].sqrt]);
            amount = (amount * BigInt(10_000 - (pools[i].impactBps ?? 0))) / 10_000n;
          }
          return ok('0x' + word(amount) + word(0) + word(0) + word(0));
        }
        if (to === D.factory.toLowerCase() && sel === UNISWAP_V3_SELECTORS.getPool) {
          const i = findPool(body.slice(24, 64), body.slice(88, 128), Number(BigInt('0x' + body.slice(128, 192))));
          return ok('0x' + word(i < 0 ? 0 : poolAddress(i).slice(2)));
        }
        if (sel === UNISWAP_V3_SELECTORS.slot0) {
          const i = pools.findIndex((_, n) => poolAddress(n) === to);
          if (i < 0 || pools[i].noPrice) return err('execution reverted');
          return ok('0x' + word(pools[i].sqrt) + word(0));
        }
        if (opts.permit && sel === ERC20_SELECTORS.name) {
          const hex = bytesToHex(new TextEncoder().encode(opts.permit.name));
          return ok('0x' + word(32) + word(hex.length / 2) + hex.padEnd(64, '0'));
        }
        if (opts.permit && sel === UNISWAP_V3_SELECTORS.DOMAIN_SEPARATOR) {
          return ok(permitDomainSeparator(opts.permit.name, opts.permit.version, 8453, call.to));
        }
        if (opts.permit && sel === UNISWAP_V3_SELECTORS.nonces) return ok('0x' + word(opts.permit.nonce));
        if (opts.permit && to === D.swapRouter02.toLowerCase() && sel === UNISWAP_V3_SELECTORS.multicall) {
          return opts.permitRefused ? err('execution reverted: EIP2612: invalid signature') : ok('0x');
        }
        if (sel === ERC20_SELECTORS.allowance) return ok('0x' + word(opts.allowance ?? 0n));
        if (sel === ERC20_SELECTORS.balanceOf) return ok('0x' + word(opts.balance ?? 10n ** 30n));
        if (sel === '0x481d7b10' && opts.satoriLockRound !== undefined) return ok('0x' + word(opts.satoriLockRound));
        return err('execution reverted');
      }
      case 'eth_getTransactionCount':
        return ok('0x7');
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
  const provider = new EvmWalletDataProvider(createEvmRpcClient(evmChainByKey('base')!, { fetchImpl }));
  const calls = (selector: string) =>
    seen.filter((r) => r.method === 'eth_call' && (r.params[0] as { data: string }).data.startsWith(selector));
  return { provider, seen, calls };
}

const hop = (tokenIn: string, tokenOut: string, fee: number): SwapHop => ({ tokenIn, tokenOut, fee });
const sameHops = (got: SwapHop[], want: SwapHop[]) =>
  expect(got.map((h) => `${h.tokenIn}-${h.fee}-${h.tokenOut}`.toLowerCase())).toEqual(
    want.map((h) => `${h.tokenIn}-${h.fee}-${h.tokenOut}`.toLowerCase()),
  );

beforeEach(() => {
  hoisted.evmEnabled = true;
});

describe('quoteSwap: routing', () => {
  it('1. takes the direct pool when there is one, and says the token needs approving', async () => {
    const { provider } = fakeBase();
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    sameHops(quote.hops, [hop(USDC_ADDR, SATORI_ADDR, 3000)]);
    expect(quote.amountOut).toBe(3_988_000n); // price 4, less the 0.3% pool fee
    expect(quote.impactBps).toBe(0);
    expect(quote.needsApproval).toBe(true);
    expect(quote.chainKey).toBe('base');
  });

  it('2. needs no approval once the router is allowed the amount', async () => {
    const { provider } = fakeBase({ allowance: 1_000_000n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    expect(quote.needsApproval).toBe(false);
    const short = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_001n });
    expect(short.needsApproval).toBe(true);
  });

  it('3. routes the coin through the dollar token on the cheapest tier, and reads no allowance for it', async () => {
    const { provider, calls } = fakeBase();
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: ETH, tokenOut: SATORI, amountIn: 10n ** 12n });
    sameHops(quote.hops, [hop(WETH_ADDR, USDC_ADDR, 500), hop(USDC_ADDR, SATORI_ADDR, 3000)]);
    // 1e12 less 0.05% = 999_500_000_000; x4 less 0.3%.
    expect(quote.amountOut).toBe((999_500_000_000n * 4n * 997_000n) / 1_000_000n);
    expect(quote.needsApproval).toBe(false);
    expect(calls(ERC20_SELECTORS.allowance)).toHaveLength(0);
  });

  it('4. routes back out to the coin the same way', async () => {
    const { provider } = fakeBase({ allowance: 10n ** 30n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: SATORI, tokenOut: ETH, amountIn: 4_000_000n });
    sameHops(quote.hops, [hop(SATORI_ADDR, USDC_ADDR, 3000), hop(USDC_ADDR, WETH_ADDR, 500)]);
    expect(quote.needsApproval).toBe(false);
  });

  it('5. prefers two hops over a direct pool that pays less', async () => {
    const pools = [...POOLS, { a: WETH_ADDR, b: SATORI_ADDR, fee: 10000, sqrt: Q96 }]; // direct pays 1, the route pays 4
    const { provider } = fakeBase({ pools });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: ETH, tokenOut: SATORI, amountIn: 10n ** 12n });
    expect(quote.hops).toHaveLength(2);
  });

  it('6. keeps the direct pool when two hops pay no more', async () => {
    const pools = [...POOLS, { a: WETH_ADDR, b: SATORI_ADDR, fee: 100, sqrt: 2n * Q96 }];
    const { provider } = fakeBase({ pools });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: ETH, tokenOut: SATORI, amountIn: 10n ** 12n });
    sameHops(quote.hops, [hop(WETH_ADDR, SATORI_ADDR, 100)]);
  });

  it('7. measures price impact against the pool price', async () => {
    const pools = [{ a: USDC_ADDR, b: SATORI_ADDR, fee: 3000, sqrt: 2n * Q96, impactBps: 850 }];
    const { provider } = fakeBase({ pools });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    expect(quote.impactBps).toBe(850);
  });

  it('8. an impact it cannot measure is null, never zero', async () => {
    const pools = [{ a: USDC_ADDR, b: SATORI_ADDR, fee: 3000, sqrt: 2n * Q96, noPrice: true }];
    const { provider } = fakeBase({ pools });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    expect(quote.impactBps).toBeNull();
    expect(quote.amountOut).toBe(3_988_000n);
  });

  it('9. says so when Uniswap has no route', async () => {
    const { provider } = fakeBase();
    await expect(quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: OTHER, tokenOut: SATORI, amountIn: 1n })).rejects.toMatchObject({
      code: 'quote-failed',
      message: expect.stringContaining('no route from OTHER to SATORI on Base'),
    });
  });

  it('10. refuses the same token on both sides, the coin and its wrapped form included, and a zero amount', async () => {
    const { provider } = fakeBase();
    const base = { provider, chain: BASE, from: FROM, amountIn: 1n };
    await expect(quoteSwap({ ...base, tokenIn: USDC, tokenOut: USDC })).rejects.toMatchObject({ code: 'unknown-asset' });
    await expect(quoteSwap({ ...base, tokenIn: ETH, tokenOut: WETH })).rejects.toMatchObject({ code: 'unknown-asset' });
    await expect(quoteSwap({ ...base, tokenIn: USDC, tokenOut: SATORI, amountIn: 0n })).rejects.toMatchObject({ code: 'invalid-amount' });
    await expect(quoteSwap({ ...base, tokenIn: { ...USDC, address: '0x1234' }, tokenOut: SATORI })).rejects.toMatchObject({ code: 'invalid-address' });
  });

  it('11. has no swap on a chain with no pinned deployment, or without the engine', async () => {
    const { provider } = fakeBase();
    const epix = { ...BASE, key: 'epix', displayName: 'Epix' };
    await expect(quoteSwap({ provider, chain: epix, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1n })).rejects.toMatchObject({
      code: 'unknown-asset',
      message: 'Swapping is not available on Epix.',
    });
    expect(await swapSupported('base')).toBe(true);
    expect(await swapSupported('epix')).toBe(false);
    hoisted.evmEnabled = false;
    expect(await swapSupported('base')).toBe(false);
    await expect(quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1n })).rejects.toMatchObject({ code: 'no-engine' });
  });

  it('12. a high or unknown impact has to be acknowledged', () => {
    expect(swapNeedsImpactAck(0)).toBe(false);
    expect(swapNeedsImpactAck(1499)).toBe(false);
    expect(swapNeedsImpactAck(1500)).toBe(true);
    expect(swapNeedsImpactAck(null)).toBe(true);
  });
});

describe('buildSwapApprovePlan', () => {
  it('13. allows the pinned router exactly the amount being swapped', async () => {
    const { provider } = fakeBase();
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_500_000n });
    const plan = await buildSwapApprovePlan({ provider, chain: BASE, quote, nativeBalanceBase: 10n ** 16n });
    expect(plan.kind).toBe('approve');
    expect(plan.to.toLowerCase()).toBe(USDC_ADDR.toLowerCase());
    expect(plan.value).toBe(0n);
    expect(decodeErc20Calldata(plan.data)).toEqual({ kind: 'approve', spender: D.swapRouter02, amount: 1_500_000n, unlimited: false });
    expect(plan.description).toBe('Allow Uniswap to take exactly 1.5 USDC from this address for your swap.');
    expect(plan.shortfall).toBeNull();
  });

  it('14. refuses the coin, an address with no coin for the fee, and a balance below the amount', async () => {
    const { provider } = fakeBase({ balance: 1_000_000n });
    const coin = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: ETH, tokenOut: SATORI, amountIn: 10n ** 12n });
    await expect(buildSwapApprovePlan({ provider, chain: BASE, quote: coin })).rejects.toMatchObject({ code: 'gated' });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_500_000n });
    await expect(buildSwapApprovePlan({ provider, chain: BASE, quote, nativeBalanceBase: 0n })).rejects.toMatchObject({ code: 'insufficient' });
    await expect(buildSwapApprovePlan({ provider, chain: BASE, quote })).rejects.toMatchObject({
      code: 'insufficient',
      message: 'This address holds 1 USDC, less than the 1.5 USDC to swap.',
    });
  });
});

describe('buildSwapPlan', () => {

  it('15. a token swap: the pinned router, no value, the minimum from this moment\'s quote, paid to the sender', async () => {
    const { provider } = fakeBase({ allowance: 1_000_000n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    const plan = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50, nativeBalanceBase: 10n ** 16n });
    if (plan.kind !== 'swap') throw new Error('expected a swap plan');
    expect(plan.to).toBe(D.swapRouter02);
    expect(plan.value).toBe(0n);
    expect(plan.amountOut).toBe(3_988_000n);
    expect(plan.minimumOut).toBe(3_968_060n); // 0.5% under
    expect(plan.impactBps).toBe(0);
    expect(bytesToHex(plan.data)).toBe(
      bytesToHex(
        encodeSwap({
          deployment: D,
          hops: quote.hops,
          recipient: FROM,
          amountIn: 1_000_000n,
          amountOutMinimum: 3_968_060n,
          deadline: BLOCK_TIME + BigInt(SWAP_DEADLINE_SECONDS),
          nativeOut: false,
        }),
      ),
    );
    expect(plan.description).toBe('Swap 1 USDC for at least 0.00000000000396806 SATORI on Uniswap.');
    expect(plan.capRefusal).toBeNull();
  });

  it('16. coin in: the amount rides as value, and too little coin for amount plus fee is a shortfall', async () => {
    const { provider } = fakeBase();
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: ETH, tokenOut: SATORI, amountIn: 10n ** 15n });
    const plan = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 100, nativeBalanceBase: 10n ** 16n });
    expect(plan.value).toBe(10n ** 15n);
    expect(plan.shortfall).toBeNull();
    const poor = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 100, nativeBalanceBase: 10n ** 15n });
    expect(poor.shortfall).not.toBeNull();
  });

  it('17. coin out: the router is paid and unwraps to the sender', async () => {
    const { provider } = fakeBase({ allowance: 10n ** 30n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: SATORI, tokenOut: ETH, amountIn: 4_000_000_000n });
    const plan = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50 });
    if (plan.kind !== 'swap') throw new Error('expected a swap plan');
    const data = bytesToHex(plan.data);
    expect(data).toContain(UNISWAP_V3_SELECTORS.unwrapWETH9.slice(2) + word(plan.minimumOut) + word(lower(FROM)));
    expect(data).toContain(word(128) + word(lower(D.swapRouter02))); // exactInput's recipient is the router
    expect(plan.value).toBe(0n);
  });

  it('18. refuses to plan a token swap the router is not yet allowed', async () => {
    const { provider } = fakeBase({ allowance: 999_999n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    await expect(buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50 })).rejects.toMatchObject({
      code: 'gated',
      message: 'Approve USDC first, then swap.',
    });
  });

  it('19. HONEST REFUSAL: a swap the node will not simulate never becomes a plan', async () => {
    const { provider } = fakeBase({ allowance: 10n ** 30n, estimateReverts: 'execution reverted: Too little received' });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    await expect(buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50 })).rejects.toMatchObject({
      code: 'quote-failed',
      message: expect.stringContaining('Too little received'),
    });
  });

  it('20. refuses slippage outside the band, and an amount whose minimum rounds to nothing', async () => {
    const { provider } = fakeBase({ allowance: 10n ** 30n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    for (const slippageBps of [0, 5001, 0.5, Number.NaN]) {
      await expect(buildSwapPlan({ provider, chain: BASE, quote, slippageBps })).rejects.toMatchObject({ code: 'invalid-amount' });
    }
    const dust = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: SATORI, tokenOut: USDC, amountIn: 8n });
    expect(dust.amountOut).toBe(1n);
    await expect(buildSwapPlan({ provider, chain: BASE, quote: dust, slippageBps: 50 })).rejects.toMatchObject({ code: 'invalid-amount' });
  });

  it('21. locked SATORI is refused in words before anything is priced', async () => {
    const { provider, seen } = fakeBase({ allowance: 10n ** 30n, satoriLockRound: 0xffffffn });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: SATORI, tokenOut: USDC, amountIn: 4_000_000n });
    await expect(buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50 })).rejects.toMatchObject({ code: 'locked' });
    await expect(buildSwapApprovePlan({ provider, chain: BASE, quote })).rejects.toMatchObject({ code: 'locked' });
    expect(seen.some((r) => r.method === 'eth_estimateGas')).toBe(false);
  });

  it('22. the plan signs and broadcasts through the one chokepoint, to the router', async () => {
    const { provider, seen } = fakeBase({ allowance: 10n ** 30n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    const plan = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50, nativeBalanceBase: 10n ** 16n });
    const sign = (request: Parameters<typeof signTx>[0]) => signTx(request, FROM_KEY);
    await expect(broadcastEvmPlan({ provider, plan, nonces: new EvmNonceTracker(), sign, allowBroadcast: false })).rejects.toThrow();
    const sent = await broadcastEvmPlan({ provider, plan, nonces: new EvmNonceTracker(), sign, allowBroadcast: true });
    const raw = seen.find((r) => r.method === 'eth_sendRawTransaction')!.params[0] as string;
    const decoded = decodeSignedTx(raw);
    expect(decoded.tx.to?.toLowerCase()).toBe(D.swapRouter02.toLowerCase());
    expect(bytesToHex(decoded.tx.data)).toBe(bytesToHex(plan.data));
    expect(sent.txid).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('safety locks on the plan', () => {
  it('23. the deadline runs on the chain\'s clock, and no clock means no plan', async () => {
    const late = fakeBase({ allowance: 10n ** 30n, blockTime: 2_000_000_000n });
    const quote = await quoteSwap({ provider: late.provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    const plan = await buildSwapPlan({ provider: late.provider, chain: BASE, quote, slippageBps: 50 });
    expect(bytesToHex(plan.data).slice(8, 72)).toBe(word(2_000_000_000n + BigInt(SWAP_DEADLINE_SECONDS)));
    if (plan.kind !== 'swap') throw new Error('expected a swap plan');
    expect(Math.abs(Date.now() - plan.plannedAt)).toBeLessThan(5_000);

    const silent = fakeBase({ allowance: 10n ** 30n, blockTime: null });
    await expect(buildSwapPlan({ provider: silent.provider, chain: BASE, quote, slippageBps: 50 })).rejects.toMatchObject({ code: 'quote-failed' });
    expect(silent.seen.some((r) => r.method === 'eth_estimateGas')).toBe(false);
  });

  it('24. refuses a route the wallet could not have built', async () => {
    const { provider, seen } = fakeBase({ allowance: 10n ** 30n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: ETH, tokenOut: SATORI, amountIn: 10n ** 12n });
    const through = (middle: string) => [hop(WETH_ADDR, middle, 500), hop(middle, SATORI_ADDR, 3000)];
    const bad = [
      [hop(USDC_ADDR, SATORI_ADDR, 3000)], // does not start at the token paid
      [hop(WETH_ADDR, USDC_ADDR, 500)], // does not end at the token received
      through(OTHER_ADDR), // through a token that is not a pinned intermediate
      [hop(WETH_ADDR, USDC_ADDR, 500), hop(WETH_ADDR, SATORI_ADDR, 3000)], // hops do not chain
      [],
    ];
    for (const hops of bad) {
      await expect(buildSwapPlan({ provider, chain: BASE, quote: { ...quote, hops }, slippageBps: 50 })).rejects.toMatchObject({ code: 'gated' });
    }
    expect(seen.some((r) => r.method === 'eth_estimateGas')).toBe(false);
    await expect(buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50 })).resolves.toMatchObject({ kind: 'swap' });
  });
});

describe('the wallet fee', () => {
  const TREASURY = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  const ON = { bps: 25, recipient: TREASURY };

  it('25. ships switched off: a 0 rate and no address, so nothing is charged', async () => {
    expect(SWAP_FEE_BPS).toBe(0);
    expect(SWAP_FEE_RECIPIENT).toBeNull();
    expect(swapFeeFor('base', USDC)).toBeNull();
    const { provider } = fakeBase({ allowance: 10n ** 30n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: SATORI, tokenOut: USDC, amountIn: 4_000_000n });
    expect(quote.feeBps).toBe(0);
    const plan = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50 });
    expect(plan).toMatchObject({ feeBps: 0, feeAmount: 0n });
    expect(bytesToHex(plan.data)).not.toContain(UNISWAP_V3_SELECTORS.sweepTokenWithFee.slice(2));
  });

  it('26. needs a rate within the router cap AND an address, and buying SATORI on Base is free', () => {
    expect(swapFeeFor('base', USDC, ON)).toEqual({ bips: 25, recipient: TREASURY });
    expect(swapFeeFor('base', ETH, ON)).toEqual({ bips: 25, recipient: TREASURY });
    expect(swapFeeFor('base', SATORI, ON)).toBeNull();
    expect(swapFeeFor('ethereum', SATORI, ON)).not.toBeNull(); // only the official token, only on Base
    expect(swapFeeFor('base', USDC, { bps: 25, recipient: null })).toBeNull();
    for (const bps of [0, 101, -5, 2.5, Number.NaN]) expect(swapFeeFor('base', USDC, { bps, recipient: TREASURY })).toBeNull();
  });

  it('27. switched on: every figure shown is after the fee, and the router is given the pre-fee minimum', async () => {
    const { provider } = fakeBase({ allowance: 10n ** 30n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: SATORI, tokenOut: USDC, amountIn: 4_000_000_000n, feeConfig: ON });
    // 4e9 / 4 = 1e9, less the 0.3% pool fee = 997_000_000, less the 0.25% wallet fee.
    expect(quote.feeBps).toBe(25);
    expect(quote.amountOut).toBe(994_507_500n);
    expect(quote.impactBps).toBe(0); // the wallet fee is not price impact
    const plan = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 100, feeConfig: ON });
    if (plan.kind !== 'swap') throw new Error('expected a swap plan');
    expect(plan.amountOut).toBe(994_507_500n);
    expect(plan.feeAmount).toBe(2_492_500n);
    expect(plan.minimumOut).toBe(984_562_425n);
    expect(plan.description).toBe('Swap 0.000000004 SATORI for at least 984.562425 USDC on Uniswap.');
    const data = bytesToHex(plan.data);
    // The router's minimum is before the fee, so the user's holds after it.
    const gross = 987_030_000n; // less 0.25% is exactly the 984_562_425 minimum
    expect(gross - (gross * 25n) / 10_000n >= plan.minimumOut).toBe(true);
    expect(data).toContain(encodeSweepTokenWithFee(USDC_ADDR, gross, FROM, { bips: 25, recipient: TREASURY }).slice(2));
    expect(data).toContain(word(128) + word(lower(D.swapRouter02)));
  });

  it('28. switched on, a SATORI buy still carries no fee call', async () => {
    const { provider } = fakeBase({ allowance: 10n ** 30n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n, feeConfig: ON });
    expect(quote).toMatchObject({ feeBps: 0, amountOut: 3_988_000n });
    const plan = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50, feeConfig: ON });
    expect(bytesToHex(plan.data)).not.toContain(UNISWAP_V3_SELECTORS.sweepTokenWithFee.slice(2));
  });
});

describe('permit: a token swap in one transaction', () => {
  const signPermit = (data: TypedData) => signTypedData(data, FROM_KEY);
  const PERMIT = { name: 'USD Coin', version: '2', nonce: 5n };

  it('29. a token with permit is signed for exactly the amount and swapped in one transaction', async () => {
    const { provider, seen } = fakeBase({ permit: PERMIT });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    expect(quote.needsApproval).toBe(true);
    const plan = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50, signPermit });
    if (plan.kind !== 'swap') throw new Error('expected a swap plan');
    expect(plan.viaPermit).toBe(true);
    expect(plan.to).toBe(D.swapRouter02);
    // What was signed: the router, this amount, the token's own nonce, the swap's deadline.
    const deadline = BLOCK_TIME + BigInt(SWAP_DEADLINE_SECONDS);
    const data = permitTypedData({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      token: USDC_ADDR,
      owner: FROM,
      spender: D.swapRouter02,
      value: 1_000_000n,
      nonce: 5n,
      deadline,
    });
    const permit = { token: USDC_ADDR, value: 1_000_000n, deadline, ...splitPermitSignature(signTypedData(data, FROM_KEY)) };
    expect(bytesToHex(plan.data)).toBe(
      bytesToHex(
        encodeSwap({ deployment: D, hops: quote.hops, recipient: FROM, amountIn: 1_000_000n, amountOutMinimum: plan.minimumOut, deadline, nativeOut: false, permit }),
      ),
    );
    expect(bytesToHex(plan.data)).toContain(encodeSelfPermitIfNecessary(permit).slice(2));
    // The node simulated it, permit and all, before it became a plan.
    expect(seen.some((r) => r.method === 'eth_estimateGas')).toBe(true);
  });

  it('30. a token with no permit, or one whose domain the wallet cannot match, is not signed for', async () => {
    const sign = vi.fn(signPermit);
    const plain = fakeBase();
    const quote = await quoteSwap({ provider: plain.provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    await expect(buildSwapPlan({ provider: plain.provider, chain: BASE, quote, slippageBps: 50, signPermit: sign })).rejects.toMatchObject({
      code: 'gated',
      message: 'Approve USDC first, then swap.',
    });
    const odd = fakeBase({ permit: { ...PERMIT, version: '7' } });
    await expect(buildSwapPlan({ provider: odd.provider, chain: BASE, quote, slippageBps: 50, signPermit: sign })).rejects.toMatchObject({ code: 'gated' });
    expect(sign).not.toHaveBeenCalled();
  });

  it('31. with the allowance already there nothing is signed, and the coin never needs it', async () => {
    const sign = vi.fn(signPermit);
    const { provider } = fakeBase({ permit: PERMIT, allowance: 10n ** 30n });
    const quote = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    const plan = await buildSwapPlan({ provider, chain: BASE, quote, slippageBps: 50, signPermit: sign });
    expect(plan).toMatchObject({ kind: 'swap', viaPermit: false });
    const coin = await quoteSwap({ provider, chain: BASE, from: FROM, tokenIn: ETH, tokenOut: SATORI, amountIn: 10n ** 12n });
    expect(await buildSwapPlan({ provider, chain: BASE, quote: coin, slippageBps: 50, signPermit: sign })).toMatchObject({ viaPermit: false });
    expect(sign).not.toHaveBeenCalled();
  });

  it('32. a permit the token refuses means an approval; a swap that fails anyway is reported as that', async () => {
    const refused = fakeBase({ permit: PERMIT, permitRefused: true });
    const quote = await quoteSwap({ provider: refused.provider, chain: BASE, from: FROM, tokenIn: USDC, tokenOut: SATORI, amountIn: 1_000_000n });
    await expect(buildSwapPlan({ provider: refused.provider, chain: BASE, quote, slippageBps: 50, signPermit })).rejects.toBeInstanceOf(SwapNeedsApprovalError);
    expect(refused.seen.some((r) => r.method === 'eth_estimateGas')).toBe(false);
    // The token takes the permit, the swap itself will not simulate: an approval would not help.
    const broken = fakeBase({ permit: PERMIT, estimateReverts: 'execution reverted: Too little received' });
    const failure = await buildSwapPlan({ provider: broken.provider, chain: BASE, quote, slippageBps: 50, signPermit }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: 'quote-failed', message: expect.stringContaining('Too little received') });
    expect(failure).not.toBeInstanceOf(SwapNeedsApprovalError);
  });
});
