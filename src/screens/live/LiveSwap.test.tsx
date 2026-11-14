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
  feeBps: 0,
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
    feeBps: 0,
    feeAmount: 0n,
    plannedAt: Date.now(),
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
  const onDone = vi.fn();
  render(
    <NavProvider value={NAV_VALUE}>
      <LiveSwap onBack={onBack} onDone={onDone} />
    </NavProvider>,
  );
  return { onBack, onDone };
}

/** Open one side's token list and choose a token from it. */
const pick = (testId: string, value: string) => {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(screen.getByTestId(`live-swap-option-${value}`));
};
const USDC_KEY = USDC_ADDR.toLowerCase();
const SATORI_KEY = SATORI_ADDR.toLowerCase();
/** The form as a user leaves it before a quote: 2 USDC for SATORI. */
const fill = (amount = '2') => {
  pick('live-swap-token-in', USDC_KEY);
  pick('live-swap-token-out', SATORI_KEY);
  fireEvent.change(screen.getByTestId('live-swap-amount'), { target: { value: amount } });
};
const button = () => screen.getByTestId('live-swap-review-btn') as HTMLButtonElement;

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
    pick('live-swap-token-in', USDC_KEY);
    pick('live-swap-token-out', SATORI_KEY);
    fireEvent.change(screen.getByTestId('live-swap-amount'), { target: { value: '2' } });
    await waitFor(() => expect(spies.quoteSwap).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(spies.quoteSwap).toHaveBeenCalledWith(USDC, SATORI, 2_000_000n);
  });

  it('refuses an amount above the balance before any review', () => {
    setup({ quote: QUOTE });
    fill('6');
    expect(button().textContent).toBe('Not enough USDC');
    expect(button().disabled).toBe(true);
    expect(screen.getByTestId('live-swap-amount').getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the quote, and plans the next step with the chosen slippage', () => {
    setup({ quote: QUOTE });
    fill();
    expect(screen.getByTestId('live-swap-quote-out').textContent).toBe('6.5');
    expect(screen.getByTestId('live-swap-details-toggle').textContent).toContain('1 USDC ≈ 3.25 SATORI');
    expect(screen.getByTestId('live-swap-quote-impact').textContent).toContain('0.4%');
    expect(screen.queryByTestId('live-swap-impact-warning')).toBeNull();
    // Slippage sits behind the header control, the rest behind the rate line.
    expect(screen.queryByTestId('live-swap-slippage-100')).toBeNull();
    fireEvent.click(screen.getByTestId('live-swap-settings'));
    fireEvent.click(screen.getByTestId('live-swap-slippage-100'));
    expect(screen.queryByTestId('live-swap-details')).toBeNull();
    fireEvent.click(screen.getByTestId('live-swap-details-toggle'));
    expect(screen.getByTestId('live-swap-details').textContent).toContain('USDC › SATORI');
    expect(screen.getByTestId('live-swap-details').textContent).toContain('6.435 SATORI'); // 1% under 6.5
    expect(button().textContent).toBe('Review swap');
    fireEvent.click(button());
    expect(spies.planSwap).toHaveBeenCalledWith(100);
  });

  it('names the approval step when the token is not yet allowed, and warns about a thin pool', () => {
    setup({ quote: { ...QUOTE, needsApproval: true, impactBps: 850 } });
    fill();
    expect(button().textContent).toBe('Approve USDC');
    expect(screen.getByTestId('live-swap-quote-impact').className).toContain('warn');
    expect(screen.getByTestId('live-swap-impact-warning').textContent).toContain('8.5% less');
  });

  it('warns about a token the wallet cannot vouch for, with its contract', () => {
    setup();
    pick('live-swap-token-out', JUNK_ADDR.toLowerCase());
    expect(screen.getByTestId('live-swap-unverified').textContent).toContain(JUNK_ADDR);
    pick('live-swap-token-out', SATORI_KEY);
    expect(screen.queryByTestId('live-swap-unverified')).toBeNull();
  });

  it('review: leads with the trade, folds the rest, and a confirmed swap leaves for Home', async () => {
    spies.confirmSwap.mockResolvedValue({ txid: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc', chainKey: 'base', kind: 'swap' });
    const { onDone, onBack } = setup({ quote: QUOTE, plan: swapPlan(40) });
    expect(screen.getByTestId('live-swap-review-pay').textContent).toContain('2 USDC');
    expect(screen.getByTestId('live-swap-review-receive').textContent).toContain('6.5 SATORI');
    expect(screen.getByTestId('live-swap-review-minimum').textContent).toBe('At least 6.4 SATORI');
    expect(screen.getByTestId('live-swap-review-fee').textContent).toContain('Network fee');
    // The router address, the route and the speed are one tap away, not gone.
    expect(screen.getByTestId('live-swap-review').textContent).not.toContain(ROUTER);
    fireEvent.click(screen.getByTestId('live-swap-review-more'));
    expect(screen.getByTestId('live-swap-review-details').textContent).toContain(ROUTER);
    expect(screen.getByTestId('live-swap-review-details').textContent).toContain('USDC › SATORI');
    expect(screen.getByTestId('live-swap-review-details').textContent).toContain('Fast');
    expect(screen.queryByTestId('live-swap-ack-impact')).toBeNull();
    const confirm = screen.getByTestId('live-swap-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('live-swap-arm'));
    fireEvent.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onBack).not.toHaveBeenCalled();
    expect(spies.arm.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(spies.confirmSwap).toHaveBeenCalledWith(false);
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
    const view = setup({ quote: { ...QUOTE, needsApproval: true }, plan: APPROVE_PLAN });
    expect(screen.getByTestId('live-swap-step-note').textContent).toContain('Step 1 of 2');
    expect(screen.queryByTestId('live-swap-review-receive')).toBeNull();
    expect(screen.getByTestId('live-swap-confirm').textContent).toBe('Approve USDC');
    expect(screen.getByTestId('live-swap-review-pay').textContent).toContain('2 USDC');
    fireEvent.click(screen.getByTestId('live-swap-arm'));
    fireEvent.click(screen.getByTestId('live-swap-confirm'));
    await waitFor(() => expect(screen.getByTestId('live-swap-waiting-approval')).toBeTruthy());
    // Still on the swap page: the second step is done here.
    expect(view.onDone).not.toHaveBeenCalled();
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

  it('a look-alike token is named with its address and never borrows the real token\'s balance', () => {
    setup();
    // The same tracked, unvouched contract, now calling itself USDC.
    storeMod.useLiveStore.setState({
      evmTokens: { tracked: [{ address: JUNK_ADDR, symbol: 'USDC', decimals: 6, trusted: false }], discovered: [] },
    } as never);
    cleanup();
    render(
      <NavProvider value={NAV_VALUE}>
        <LiveSwap onBack={() => {}} />
      </NavProvider>,
    );
    fireEvent.click(screen.getByTestId('live-swap-token-in'));
    expect(screen.getByTestId(`live-swap-option-${USDC_KEY}`).textContent).toBe('USDC5');
    expect(screen.getByTestId(`live-swap-option-${JUNK_ADDR.toLowerCase()}`).textContent).toBe('UUSDC (0xfB69…d359)Not verified') // a letter badge, then the label;
    fireEvent.click(screen.getByTestId(`live-swap-option-${JUNK_ADDR.toLowerCase()}`));
    expect(screen.getByTestId('live-swap-token-in').textContent).toBe('UUSDC (0xfB69…d359)'); // a letter, not USDC's mark
    expect(screen.queryByTestId('live-swap-balance')).toBeNull();
    expect(screen.queryByTestId('live-swap-max')).toBeNull();
    // The real one still shows its own.
    pick('live-swap-token-in', USDC_KEY);
    expect(screen.getByTestId('live-swap-balance').textContent).toBe('Balance 5 · Max');
  });

  it('review: a swap priced more than two minutes ago cannot be confirmed until it is priced again', () => {
    setup({ quote: QUOTE, plan: { ...swapPlan(40), plannedAt: Date.now() - 121_000 } as SwapPlan });
    fireEvent.click(screen.getByTestId('live-swap-arm'));
    expect((screen.getByTestId('live-swap-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('live-swap-stale').textContent).toContain('out of date');
    fireEvent.click(screen.getByTestId('live-swap-replan'));
    expect(spies.planSwap).toHaveBeenCalledWith(50);
  });

  it('where pending swaps are public it says so and offers no wide slippage', () => {
    setup({}, { ...BASE, key: 'ethereum', displayName: 'Ethereum' });
    expect(screen.getByTestId('live-swap-mempool-note').textContent).toContain('trading bots');
    fireEvent.click(screen.getByTestId('live-swap-settings'));
    expect(screen.queryByTestId('live-swap-slippage-300')).toBeNull();
    expect(screen.getByTestId('live-swap-slippage-100')).toBeTruthy();
    cleanup();
    setup();
    expect(screen.queryByTestId('live-swap-mempool-note')).toBeNull();
    fireEvent.click(screen.getByTestId('live-swap-settings'));
    expect(screen.getByTestId('live-swap-slippage-300')).toBeTruthy();
  });

  it('shows the wallet fee only when there is one, and stops saying there is none', () => {
    setup({ quote: QUOTE });
    expect(screen.queryByTestId('live-swap-quote-wallet-fee')).toBeNull();
    expect(screen.getByTestId('live-swap').textContent).toContain('takes no fee');
    cleanup();
    setup({ quote: { ...QUOTE, feeBps: 25 } });
    expect(screen.getByTestId('live-swap-quote-wallet-fee').textContent).toContain('0.25%');
    expect(screen.getByTestId('live-swap').textContent).not.toContain('takes no fee');
    cleanup();
    setup({ quote: QUOTE, plan: { ...swapPlan(40), feeBps: 25, feeAmount: 16_000_000_000_000_000n } as SwapPlan });
    expect(screen.getByTestId('live-swap-review-wallet-fee').textContent).toContain('0.016 SATORI');
  });

  it('the button names what is still missing, one thing at a time', () => {
    setup();
    expect(button().textContent).toBe('Choose a token');
    expect(screen.getByTestId('live-swap-token-out').textContent).toBe('Choose token');
    pick('live-swap-token-out', SATORI_KEY);
    expect(button().textContent).toBe('Enter an amount');
    fireEvent.change(screen.getByTestId('live-swap-amount'), { target: { value: 'abc' } });
    expect(button().textContent).toBe('Enter a valid amount');
    fireEvent.change(screen.getByTestId('live-swap-amount'), { target: { value: '0.01' } });
    expect(button().textContent).toBe('Getting a price...');
    expect(button().disabled).toBe(true);
    expect(screen.getByTestId('live-swap-quote-out').textContent).toBe('0');
  });

  it('choosing the other side\'s token swaps the two, and the flip button does the same', () => {
    setup();
    pick('live-swap-token-out', SATORI_KEY);
    pick('live-swap-token-in', SATORI_KEY);
    expect(screen.getByTestId('live-swap-token-in').textContent).toContain('SATORI');
    expect(screen.getByTestId('live-swap-token-out').textContent).toContain('ETH');
    fireEvent.click(screen.getByTestId('live-swap-flip'));
    expect(screen.getByTestId('live-swap-token-in').textContent).toContain('ETH');
    expect(screen.getByTestId('live-swap-token-out').textContent).toContain('SATORI');
    // The list closes on a choice and on a click outside it.
    expect(screen.queryByTestId('live-swap-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId('live-swap-token-in'));
    fireEvent.click(screen.getByTestId('live-swap-sheet').parentElement!);
    expect(screen.queryByTestId('live-swap-sheet')).toBeNull();
  });

  it('the coin has no Max, a token does', () => {
    setup();
    expect(screen.queryByTestId('live-swap-max')).toBeNull();
    pick('live-swap-token-in', USDC_KEY);
    fireEvent.click(screen.getByTestId('live-swap-max'));
    expect((screen.getByTestId('live-swap-amount') as HTMLInputElement).value).toBe('5');
  });
});
