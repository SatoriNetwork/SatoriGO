/**
 * @vitest-environment jsdom
 *
 * The Swap screen over the real store's STATE with its swap actions replaced by
 * spies: what the screen asks the store for, what it lets the user confirm, and
 * what it refuses to. The routing, the calldata and the broadcast are covered in
 * evmSwap.test.ts and liveStore.swap.test.ts; nothing here touches a network.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import { NavProvider } from './LiveNav';
import type { SwapPlan, SwapQuote, SwapState, SwapToken } from '../../store/evmSwap';
import type { EvmChainInfo } from '../../store/evmChains';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SATORI_ADDR = '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17';
const JUNK_ADDR = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const USDC: SwapToken = { address: USDC_ADDR, symbol: 'USDC', decimals: 6 };
const SATORI: SwapToken = { address: SATORI_ADDR, symbol: 'SATORI', decimals: 18 };

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
  tokenListSlug: 'base',
  defaultTokens: [
    { address: USDC_ADDR, symbol: 'USDC', decimals: 6 },
    { address: SATORI_ADDR, symbol: 'SATORI', decimals: 18 },
  ],
  swap: true,
};

const QUOTE: SwapQuote = {
  chainKey: 'base',
  from: ME,
  tokenIn: USDC,
  tokenOut: SATORI,
  amountIn: 2_000_000n,
  amountOut: 6_500_000_000_000_000_000n,
  hops: [{ tokenIn: USDC_ADDR, tokenOut: SATORI_ADDR, fee: 3000 }],
  impactBps: 40,
  needsApproval: false,
  quotedAt: 0,
};

const FEE = { type: 'eip1559' as const, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
const FEE_QUOTE = { fee: FEE, gasEstimate: 1n, gasLimit: 2n, baseFeePerGas: 5n, l1DataFee: 0n, estimatedTotal: 1_000n, maxTotal: 2_000n };
const CALL = {
  chainKey: 'base',
  chainId: 8453,
  from: ME,
  value: 0n,
  data: new Uint8Array([1, 2, 3, 4]),
  level: 'normal' as const,
  quotes: { slow: FEE_QUOTE, normal: FEE_QUOTE, fast: FEE_QUOTE },
  quote: FEE_QUOTE,
  unsigned: { chainId: 8453, to: ROUTER, value: 0n, data: new Uint8Array([1, 2, 3, 4]), gasLimit: 2n, fee: FEE },
  shortfall: null,
  capRefusal: null,
};
const swapPlan = (impactBps: number | null): SwapPlan =>
  ({
    ...CALL,
    to: ROUTER,
    description: 'Swap 2 USDC for at least 6.4 SATORI on Uniswap.',
    kind: 'swap',
    tokenIn: USDC,
    tokenOut: SATORI,
    amountIn: 2_000_000n,
    amountOut: 6_500_000_000_000_000_000n,
    minimumOut: 6_400_000_000_000_000_000n,
    slippageBps: 50,
    impactBps,
    hops: QUOTE.hops,
  }) as SwapPlan;
const APPROVE_PLAN = {
  ...CALL,
  to: USDC_ADDR,
  description: 'Allow Uniswap to take exactly 2 USDC from this address for your swap.',
  kind: 'approve',
  tokenIn: USDC,
  amountIn: 2_000_000n,
} as SwapPlan;

type LiveStoreModule = typeof import('../../store/liveStore');
let storeMod: LiveStoreModule;
let LiveSwap: typeof import('./LiveSwap')['LiveSwap'];
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = { tab: 'assets' as const, section: 'home' as const, openTab: () => {}, openSettings: () => {} };
const spies = {
  quoteSwap: vi.fn(async () => null),
  planSwap: vi.fn(async () => null),
  confirmSwap: vi.fn(),
  clearSwap: vi.fn(),
  clearSwapPlan: vi.fn(),
  selectSwapFeeLevel: vi.fn(async () => {}),
  arm: vi.fn(),
};

function setup(swap: Partial<SwapState> = {}, chain: EvmChainInfo = BASE) {
  storeMod.useLiveStore.setState({
    ...spies,
    evm: { ...state().evm, chains: [chain], activeChainKey: chain.key },
    address: ME,
    requirePasswordToSend: false,
    assets: [
      { name: 'ETH', amountBase: 10n ** 17n, scale: 18, decimals: 18, isNative: true },
      { name: 'USDC', amountBase: 5_000_000n, scale: 6, decimals: 6, isNative: false },
    ],
    evmTokens: { tracked: [{ address: JUNK_ADDR, symbol: 'JUNK', decimals: 18, trusted: false }], discovered: [] },
    swap: { quote: null, quoting: false, plan: null, planning: false, error: null, ...swap },
  } as never);
  const onBack = vi.fn();
  render(
    <NavProvider value={NAV_VALUE}>
      <LiveSwap onBack={onBack} />
    </NavProvider>,
  );
  return { onBack };
}

const pick = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  setStorageForTests(new MemoryStorageAdapter());
  storeMod = await import('../../store/liveStore');
  LiveSwap = (await import('./LiveSwap')).LiveSwap;
});

beforeEach(() => {
  Object.values(spies).forEach((spy) => spy.mockClear());
});

afterEach(() => {
  cleanup();
});

describe('LiveSwap', () => {
  it('says so on a chain with no pinned Uniswap deployment, and asks for nothing', () => {
    setup({}, { ...BASE, key: 'epix', displayName: 'Epix', swap: false });
    expect(screen.getByText('Swapping is not available on this network.')).toBeTruthy();
    expect(screen.queryByTestId('live-swap-amount')).toBeNull();
  });

  it('asks for a quote once two tokens and an amount are in, in base units of the token paid', async () => {
    setup();
    pick('live-swap-token-in', USDC_ADDR.toLowerCase());
    pick('live-swap-token-out', SATORI_ADDR.toLowerCase());
    fireEvent.change(screen.getByTestId('live-swap-amount'), { target: { value: '2' } });
    await waitFor(() => expect(spies.quoteSwap).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(spies.quoteSwap).toHaveBeenCalledWith(USDC, SATORI, 2_000_000n);
  });

  it('refuses an amount above the balance before any review', () => {
    setup({ quote: QUOTE });
    pick('live-swap-token-in', USDC_ADDR.toLowerCase());
    pick('live-swap-token-out', SATORI_ADDR.toLowerCase());
    fireEvent.change(screen.getByTestId('live-swap-amount'), { target: { value: '6' } });
    expect(screen.getByText('More than this address holds.')).toBeTruthy();
    expect((screen.getByTestId('live-swap-review-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the quote, and plans the next step with the chosen slippage', () => {
    setup({ quote: QUOTE });
    expect(screen.getByTestId('live-swap-quote-out').textContent).toContain('6.5 SATORI');
    expect(screen.getByTestId('live-swap-quote-impact').textContent).toContain('0.4%');
    expect(screen.queryByTestId('live-swap-impact-warning')).toBeNull();
    fireEvent.click(screen.getByTestId('live-swap-slippage-100'));
    const review = screen.getByTestId('live-swap-review-btn');
    expect(review.textContent).toBe('Review swap');
    fireEvent.click(review);
    expect(spies.planSwap).toHaveBeenCalledWith(100);
  });

  it('names the approval step when the token is not yet allowed, and warns about a thin pool', () => {
    setup({ quote: { ...QUOTE, needsApproval: true, impactBps: 850 } });
    expect(screen.getByTestId('live-swap-review-btn').textContent).toBe('Approve USDC');
    expect(screen.getByTestId('live-swap-impact-warning').textContent).toContain('8.5% less');
  });

  it('warns about a token the wallet cannot vouch for, with its contract', () => {
    setup();
    pick('live-swap-token-out', JUNK_ADDR.toLowerCase());
    expect(screen.getByTestId('live-swap-unverified').textContent).toContain(JUNK_ADDR);
    pick('live-swap-token-out', SATORI_ADDR.toLowerCase());
    expect(screen.queryByTestId('live-swap-unverified')).toBeNull();
  });

  it('review: the swap is confirmed only behind the tick, armed, and ends on the sent screen', async () => {
    spies.confirmSwap.mockResolvedValue({ txid: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc', chainKey: 'base', kind: 'swap' });
    setup({ quote: QUOTE, plan: swapPlan(40) });
    expect(screen.getByTestId('live-swap-review-minimum').textContent).toContain('6.4 SATORI');
    expect(screen.getByTestId('live-swap-review').textContent).toContain(ROUTER);
    expect(screen.queryByTestId('live-swap-ack-impact')).toBeNull();
    const confirm = screen.getByTestId('live-swap-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('live-swap-arm'));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByTestId('live-swap-done')).toBeTruthy());
    expect(spies.arm.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(spies.confirmSwap).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('live-swap-txid').textContent).toContain('0xabc');
  });

  it('review: a high or unmeasured price impact needs its own tick', () => {
    setup({ quote: QUOTE, plan: swapPlan(2100) });
    const confirm = screen.getByTestId('live-swap-confirm') as HTMLButtonElement;
    fireEvent.click(screen.getByTestId('live-swap-arm'));
    expect(confirm.disabled).toBe(true);
    expect(screen.getByTestId('live-swap-review').textContent).toContain('moves the price by 21%');
    fireEvent.click(screen.getByTestId('live-swap-ack-impact'));
    expect(confirm.disabled).toBe(false);
    cleanup();
    setup({ quote: QUOTE, plan: swapPlan(null) });
    expect(screen.getByTestId('live-swap-review-impact').textContent).toContain('Could not be measured');
    expect(screen.getByTestId('live-swap-ack-impact')).toBeTruthy();
  });

  it('review: a plan the account cannot pay for cannot be confirmed', () => {
    setup({ quote: QUOTE, plan: { ...swapPlan(40), shortfall: 'Not enough ETH for the fee.' } as SwapPlan });
    fireEvent.click(screen.getByTestId('live-swap-arm'));
    expect((screen.getByTestId('live-swap-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('live-swap-shortfall').textContent).toContain('Not enough ETH');
  });

  it('approval: says it is step 1 of 2, then waits for the chain instead of claiming the swap is done', async () => {
    spies.confirmSwap.mockImplementation(async () => {
      storeMod.useLiveStore.setState({ swap: { ...state().swap, plan: null } });
      return { txid: '0xdef', explorerUrl: 'x', chainKey: 'base', kind: 'approve' };
    });
    setup({ quote: { ...QUOTE, needsApproval: true }, plan: APPROVE_PLAN });
    expect(screen.getByTestId('live-swap-step-note').textContent).toContain('Step 1 of 2');
    expect(screen.getByTestId('live-swap-review-pay').textContent).toContain('2 USDC');
    fireEvent.click(screen.getByTestId('live-swap-arm'));
    fireEvent.click(screen.getByTestId('live-swap-confirm'));
    await waitFor(() => expect(screen.getByTestId('live-swap-waiting-approval')).toBeTruthy());
    expect(screen.queryByTestId('live-swap-done')).toBeNull();
    expect((screen.getByTestId('live-swap-review-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Back from the review drops the plan and keeps the quote; leaving clears everything', () => {
    const { onBack } = setup({ quote: QUOTE, plan: swapPlan(40) });
    fireEvent.click(screen.getByText('Back'));
    expect(spies.clearSwapPlan).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    cleanup();
    expect(spies.clearSwap).toHaveBeenCalled();
  });

  it('the coin has no Max, a token does', () => {
    setup();
    expect(screen.queryByTestId('live-swap-max')).toBeNull();
    pick('live-swap-token-in', USDC_ADDR.toLowerCase());
    fireEvent.click(screen.getByTestId('live-swap-max'));
    expect((screen.getByTestId('live-swap-amount') as HTMLInputElement).value).toBe('5');
  });
});
