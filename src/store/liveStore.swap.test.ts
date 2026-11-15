// The in-wallet swap through the real store and the real EVM modules, against a
// fake Base node with two Uniswap v3 pools. No network. The routing and plan
// arithmetic are covered in evmSwap.test.ts; this file is the store's part: the
// two-step flow, the arming gate, the impact acknowledgement, the pending row.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return { ...actual, loadEvmModules: async () => await import('../services/chain/evm') };
});

import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import { MULTICALL3, UNISWAP_V3, UNISWAP_V3_SELECTORS, decodeErc20Calldata, decodeSignedTx, midPriceOut, permitDomainSeparator } from '../services/chain/evm';
import { answerAggregate3 } from '../services/chain/evm/testing/multicall3';
import { resetEvmProvidersForTests } from './evmBalances';
import { resetEvmIndexersForTests } from './evmHistory';
import type { SwapToken } from './evmSwap';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PW = 'password123';
const D = UNISWAP_V3.base;
const SATORI_ADDR = '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17';
const ETH: SwapToken = { address: null, symbol: 'ETH', decimals: 18 };
const USDC: SwapToken = { address: D.stable, symbol: 'USDC', decimals: 6 };
const SATORI: SwapToken = { address: SATORI_ADDR, symbol: 'SATORI', decimals: 18 };

const word = (value: bigint | number | string) => (typeof value === 'string' ? value : BigInt(value).toString(16)).padStart(64, '0');
const lower = (a: string) => a.slice(2).toLowerCase();
const Q96 = 1n << 96n;
/** USDC/SATORI at 0.3% and WETH/USDC at 0.05%, by sorted token pair. */
const POOLS: Record<string, { sqrt: bigint; address: string }> = {
  [[lower(D.stable), lower(SATORI_ADDR)].sort().join() + ':3000']: { sqrt: 2n * Q96, address: `0x${'a1'.repeat(20)}` },
  [[lower(D.wrappedNative), lower(D.stable)].sort().join() + ':500']: { sqrt: Q96, address: `0x${'a2'.repeat(20)}` },
};
const pool = (x: string, y: string, fee: number) => POOLS[`${[x, y].sort().join()}:${fee}`];

interface Req { id: number; method: string; params: unknown[] }

/** How many signed permits the fake chain has been shown. */
let permitsShown = 0;
let world: { allowance: bigint; pricesReadable: boolean; receipt: null | '0x1' | '0x0'; permit: boolean; permitRefused: boolean; estimateReverts: boolean };
let sentRaw: string[];

function answer(req: Req): Record<string, unknown> {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
  const err = (message: string, code = 3) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
  switch (req.method) {
    case 'eth_chainId':
      return ok('0x2105');
    case 'eth_blockNumber':
      return ok('0x100');
    case 'eth_getBlockByNumber':
      return ok({ timestamp: '0x66f00000' });
    case 'eth_getBalance':
      return ok(`0x${(10n ** 18n).toString(16)}`);
    case 'eth_estimateGas': {
      // Only the swap can be made to fail: the approval that follows must still price.
      const { to = '' } = req.params[0] as { to?: string };
      return world.estimateReverts && to.toLowerCase() === D.swapRouter02.toLowerCase() ? err('execution reverted: invalid signature') : ok('0x30d40');
    }
    case 'eth_feeHistory':
      return ok({
        baseFeePerGas: Array.from({ length: 6 }, () => '0x4c4b40'),
        reward: Array.from({ length: 5 }, () => ['0xf4240', '0x10c8e0', '0x2dc6c0']),
      });
    case 'eth_gasPrice':
      return ok('0x5b8d80');
    case 'eth_getTransactionCount':
      return ok('0x7');
    case 'eth_getTransactionReceipt':
      return ok(world.receipt ? { status: world.receipt } : null);
    case 'eth_sendRawTransaction':
      sentRaw.push(req.params[0] as string);
      return ok(`0x${bytesToHex(keccak_256(hexToBytes((req.params[0] as string).slice(2))))}`);
    case 'eth_call': {
      const { to = '', data = '' } = req.params[0] as { to?: string; data?: string };
      const sel = data.slice(0, 10);
      const body = data.slice(10);
      if (to.toLowerCase() === '0x420000000000000000000000000000000000000f') return ok(`0x${word(0x2f0d)}`);
      if (to.toLowerCase() === MULTICALL3.toLowerCase() && sel === UNISWAP_V3_SELECTORS.aggregate3) {
        return ok(
          answerAggregate3(data, (innerTo, innerData) => {
            const inner = answer({ id: 0, method: 'eth_call', params: [{ to: innerTo, data: innerData }, 'latest'] });
            return 'result' in inner ? (inner.result as string) : null;
          }),
        );
      }
      if (sel === UNISWAP_V3_SELECTORS.quoteExactInput) {
        const path = body.slice(192, 192 + Number(BigInt(`0x${body.slice(128, 192)}`)) * 2);
        let out = BigInt(`0x${body.slice(64, 128)}`);
        for (let at = 0; at + 86 <= path.length; at += 46) {
          const [tokenIn, fee, tokenOut] = [path.slice(at, at + 40), parseInt(path.slice(at + 40, at + 46), 16), path.slice(at + 46, at + 86)];
          const p = pool(tokenIn, tokenOut, fee);
          if (!p) return err('execution reverted');
          out = midPriceOut(out, [{ tokenIn: `0x${tokenIn}`, tokenOut: `0x${tokenOut}`, fee }], [p.sqrt]);
        }
        return ok(`0x${word(out)}${word(0)}${word(0)}${word(0)}`);
      }
      if (sel === UNISWAP_V3_SELECTORS.getPool) {
        const p = pool(body.slice(24, 64), body.slice(88, 128), Number(BigInt(`0x${body.slice(128, 192)}`)));
        return ok(`0x${word(p ? p.address.slice(2) : 0)}`);
      }
      if (sel === UNISWAP_V3_SELECTORS.slot0) {
        const p = Object.values(POOLS).find((x) => x.address === to.toLowerCase());
        return p && world.pricesReadable ? ok(`0x${word(p.sqrt)}${word(0)}`) : err('execution reverted');
      }
      if (world.permit && sel === '0x06fdde03') {
        const hex = bytesToHex(new TextEncoder().encode('USD Coin'));
        return ok(`0x${word(32)}${word(hex.length / 2)}${hex.padEnd(64, '0')}`);
      }
      if (world.permit && sel === UNISWAP_V3_SELECTORS.DOMAIN_SEPARATOR) return ok(permitDomainSeparator('USD Coin', '2', 8453, to));
      if (world.permit && sel === UNISWAP_V3_SELECTORS.nonces) return ok(`0x${word(3)}`);
      if (world.permit && to.toLowerCase() === D.swapRouter02.toLowerCase() && sel === UNISWAP_V3_SELECTORS.multicall) {
        permitsShown += 1;
        return world.permitRefused ? err('execution reverted: invalid signature') : ok('0x');
      }
      if (sel === '0xdd62ed3e') return ok(`0x${word(world.allowance)}`);
      if (sel === '0x70a08231') return ok(`0x${word(10n ** 24n)}`);
      if (sel === '0x313ce567') return ok(`0x${word(18)}`);
      if (sel === '0x481d7b10') return ok(`0x${word(0)}`);
      return err('execution reverted');
    }
    default:
      return err('method not found', -32601);
  }
}

const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  if (init?.method !== 'POST') return new Response('{}', { status: 503 });
  const body = JSON.parse(String(init.body)) as Req | Req[];
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { status: 200 });
};

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
const state = () => mod.useLiveStore.getState();
const swap = () => state().swap;
const sent = (i: number) => decodeSignedTx(hexToBytes(sentRaw[i].slice(2))).tx;

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  mod = await import('./liveStore');
});

beforeEach(async () => {
  permitsShown = 0;
  world = { allowance: 0n, pricesReadable: true, receipt: null, permit: false, permitRefused: false, estimateReverts: false };
  sentRaw = [];
  setStorageForTests(new MemoryStorageAdapter());
  resetEvmProvidersForTests();
  resetEvmIndexersForTests();
  vi.stubGlobal('fetch', fakeFetch);
  await state().resetLiveWallet();
  await state().init();
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  await state().importWallet(MNEMONIC, PW, 'EVM', 'evm:base');
  for (let i = 0; i < 100 && state().evm.activeChainKey !== 'base'; i++) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 100 && state().assets.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
});

afterEach(() => {
  state().stopAutoRefresh();
  vi.unstubAllGlobals();
});

describe('in-wallet swap on Base', () => {
  it('marks the chains that have a pinned Uniswap deployment', () => {
    const chains = state().evm.chains;
    expect(chains.find((c) => c.key === 'base')?.swap).toBe(true);
    expect(chains.find((c) => c.key === 'ethereum')?.swap).toBe(true);
    expect(chains.find((c) => c.key === 'epix')?.swap).toBe(false);
  });

  it('a token swap is two steps: an exact approval, then the swap, each behind the gate', async () => {
    const quote = await state().quoteSwap(USDC, SATORI, 2_000_000n);
    expect(quote).toMatchObject({ from: ME, amountOut: 7_976_000n, needsApproval: true, impactBps: 0 });

    // Step 1: the approval.
    const approve = await state().planSwap(50);
    expect(approve?.kind).toBe('approve');
    state().arm(true);
    const first = await state().confirmSwap();
    expect(first.kind).toBe('approve');
    expect(sent(0).to.toLowerCase()).toBe(D.stable.toLowerCase());
    expect(decodeErc20Calldata(sent(0).data)).toEqual({ kind: 'approve', spender: D.swapRouter02, amount: 2_000_000n, unlimited: false });
    // The quote stays for the second step, the plan is spent, the gate is closed again.
    expect(swap().plan).toBe(null);
    expect(swap().quote).not.toBe(null);
    await expect(state().confirmSwap()).rejects.toThrow(/Nothing to confirm/);

    // The approval is mined: the same quote, asked again, no longer needs it.
    world.allowance = 2_000_000n;
    expect((await state().quoteSwap(USDC, SATORI, 2_000_000n))?.needsApproval).toBe(false);

    // Step 2: the swap.
    const plan = await state().planSwap(50);
    if (plan?.kind !== 'swap') throw new Error('expected the swap step');
    expect(plan.minimumOut).toBe(7_936_120n);
    await expect(state().confirmSwap()).rejects.toThrow(/armed/);
    expect(sentRaw).toHaveLength(1);
    state().arm(true);
    const { txid, kind } = await state().confirmSwap();
    expect(kind).toBe('swap');
    expect(sent(1).to.toLowerCase()).toBe(D.swapRouter02.toLowerCase());
    expect(sent(1).value).toBe(0n);
    expect(bytesToHex(sent(1).data)).toBe(bytesToHex(plan.data));

    // Shown at once as what left the account; the swap is over.
    expect(state().txs.find((t) => t.txid === txid)).toMatchObject({ asset: 'USDC', direction: 'out', status: 'pending', amount: 2 });
    expect(swap()).toEqual({ quote: null, quoting: false, plan: null, planning: false, permitAsk: false, error: null });
  });

  it('the coin needs no approval and rides as value, through the dollar token', async () => {
    const quote = await state().quoteSwap(ETH, SATORI, 10n ** 15n);
    expect(quote?.needsApproval).toBe(false);
    expect(quote?.hops).toHaveLength(2);
    const plan = await state().planSwap(100);
    expect(plan?.kind).toBe('swap');
    state().arm(true);
    const { txid } = await state().confirmSwap();
    expect(sent(0).to.toLowerCase()).toBe(D.swapRouter02.toLowerCase());
    expect(sent(0).value).toBe(10n ** 15n);
    expect(state().txs.find((t) => t.txid === txid)).toMatchObject({ asset: 'ETH', direction: 'out' });
  });

  it('a price impact that could not be measured has to be acknowledged', async () => {
    world.allowance = 10n ** 30n;
    world.pricesReadable = false;
    expect((await state().quoteSwap(USDC, SATORI, 2_000_000n))?.impactBps).toBe(null);
    await state().planSwap(50);
    state().arm(true);
    await expect(state().confirmSwap()).rejects.toThrow(/price impact/);
    expect(sentRaw).toHaveLength(0);
    await state().confirmSwap(true);
    expect(sentRaw).toHaveLength(1);
  });

  it('a swap reviewed more than two minutes ago is refused until it is priced again', async () => {
    world.allowance = 10n ** 30n;
    await state().quoteSwap(USDC, SATORI, 2_000_000n);
    await state().planSwap(50);
    const real = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(real + 121_000);
    try {
      state().arm(true);
      await expect(state().confirmSwap()).rejects.toThrow(/out of date/);
      expect(sentRaw).toHaveLength(0);
      // Priced again at the new time, it goes.
      await state().planSwap(50);
      state().arm(true);
      await state().confirmSwap();
      expect(sentRaw).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  const settled = async () => {
    // Generous: the receipt is polled every 1.5 s, and the suite runs many files at once.
    for (let i = 0; i < 300 && state().swapStatus?.state === 'pending'; i++) await new Promise((r) => setTimeout(r, 50));
    return state().swapStatus?.state;
  };
  const sendSwap = async () => {
    world.allowance = 10n ** 30n;
    await state().quoteSwap(USDC, SATORI, 2_000_000n);
    await state().planSwap(50);
    state().arm(true);
    return state().confirmSwap();
  };

  it('a sent swap is followed: pending at once, confirmed when the chain says so', async () => {
    const { txid } = await sendSwap();
    expect(state().swapStatus).toMatchObject({
      txid,
      chainKey: 'base',
      chainName: 'Base',
      from: ME,
      payAmount: '2',
      paySymbol: 'USDC',
      receiveAmount: '<0.00000001',
      receiveSymbol: 'SATORI',
      state: 'pending',
    });
    expect(state().swapStatus?.explorerUrl).toContain(txid);
    world.receipt = '0x1';
    expect(await settled()).toBe('confirmed');
    state().dismissSwapStatus();
    expect(state().swapStatus).toBeNull();
  }, 30_000);

  it('a swap the chain reverted is reported as failed, never as done', async () => {
    await sendSwap();
    world.receipt = '0x0';
    expect(await settled()).toBe('failed');
  }, 30_000);

  it('an approval is not followed on Home: its second step is still on the swap page', async () => {
    await state().quoteSwap(USDC, SATORI, 2_000_000n);
    await state().planSwap(50);
    state().arm(true);
    const { txid } = await state().confirmSwap();
    expect(state().swapStatus).toBeNull();
    // Activity still shows it straight away, as a pending call that moves nothing.
    expect(state().txs.find((t) => t.txid === txid)).toMatchObject({ asset: 'ETH', direction: 'out', status: 'pending' });
  });

  it('a token with permit swaps in ONE transaction: no approval is sent', async () => {
    world.permit = true;
    expect((await state().quoteSwap(USDC, SATORI, 2_000_000n))?.needsApproval).toBe(true);
    const plan = await state().planSwap(50, 'sign');
    expect(plan).toMatchObject({ kind: 'swap', viaPermit: true });
    state().arm(true);
    const { kind } = await state().confirmSwap();
    expect(kind).toBe('swap');
    expect(sentRaw).toHaveLength(1);
    expect(sent(0).to.toLowerCase()).toBe(D.swapRouter02.toLowerCase());
    expect(bytesToHex(sent(0).data)).toContain(UNISWAP_V3_SELECTORS.selfPermitIfNecessary.slice(2));
    expect(state().swapStatus?.state).toBe('pending');
  });

  it('a permit is never signed unasked: the first review only asks, and the answer decides', async () => {
    world.permit = true;
    await state().quoteSwap(USDC, SATORI, 2_000_000n);
    expect(await state().planSwap(50)).toBe(null);
    expect(swap()).toMatchObject({ permitAsk: true, plan: null, planning: false, error: null });
    expect(permitsShown).toBe(0);
    // "Approve first": the ordinary approval, still nothing signed.
    expect((await state().planSwap(50, 'approve'))?.kind).toBe('approve');
    expect(swap().permitAsk).toBe(false);
    expect(permitsShown).toBe(0);
    // Asked again, then "Sign": one transaction.
    await state().planSwap(50);
    expect(swap().permitAsk).toBe(true);
    expect(await state().planSwap(50, 'sign')).toMatchObject({ kind: 'swap', viaPermit: true });
    expect(swap().permitAsk).toBe(false);
    expect(permitsShown).toBe(1);
    // Closing the question leaves nothing behind.
    await state().planSwap(50);
    state().clearSwapPlan();
    expect(swap()).toMatchObject({ permitAsk: false, plan: null });
  });

  it('a token without permit is not asked about one', async () => {
    await state().quoteSwap(USDC, SATORI, 2_000_000n);
    expect((await state().planSwap(50))?.kind).toBe('approve');
    expect(swap().permitAsk).toBe(false);
  });

  it('a permit the token refuses falls back to the approval step', async () => {
    world.permit = true;
    world.permitRefused = true;
    await state().quoteSwap(USDC, SATORI, 2_000_000n);
    expect((await state().planSwap(50, 'sign'))?.kind).toBe('approve');
    expect(swap().error).toBe(null);
  });

  it('a swap that fails for another reason is reported, not turned into an approval the user would pay for', async () => {
    world.permit = true;
    world.estimateReverts = true;
    await state().quoteSwap(USDC, SATORI, 2_000_000n);
    expect(await state().planSwap(50, 'sign')).toBe(null);
    expect(swap().error).toMatch(/invalid signature|refused to simulate/);
    expect(sentRaw).toHaveLength(0);
  });

  it('a failed quote lands as an error, and a new quote discards the plan under review', async () => {
    expect(await state().quoteSwap(USDC, { address: `0x${'11'.repeat(20)}`, symbol: 'NOPE', decimals: 18 }, 1n)).toBe(null);
    expect(swap().error).toMatch(/no route from USDC to NOPE on Base/);
    expect(await state().planSwap(50)).toBe(null);
    expect(swap().error).toMatch(/Nothing to swap yet/);

    world.allowance = 10n ** 30n;
    await state().quoteSwap(USDC, SATORI, 2_000_000n);
    expect(await state().planSwap(50)).not.toBe(null);
    await state().quoteSwap(USDC, SATORI, 3_000_000n);
    expect(swap().plan).toBe(null);
    expect(swap().error).toBe(null);
  });

  it('changing the fee level keeps the swap fields, and clearing drops everything', async () => {
    world.allowance = 10n ** 30n;
    await state().quoteSwap(USDC, SATORI, 2_000_000n);
    await state().planSwap(50);
    await state().selectSwapFeeLevel('fast');
    const plan = swap().plan;
    expect(plan).toMatchObject({ level: 'fast', kind: 'swap', minimumOut: 7_936_120n });
    state().clearSwapPlan();
    expect(swap().plan).toBe(null);
    expect(swap().quote).not.toBe(null);
    state().clearSwap();
    expect(swap().quote).toBe(null);
  });
});
