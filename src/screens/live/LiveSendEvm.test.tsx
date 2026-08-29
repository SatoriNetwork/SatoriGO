/**
 * @vitest-environment jsdom
 *
 * LiveSendEvm: the EVM branch of the send screen (phase 3). Every store
 * action is mocked directly (vi.fn set into the REAL store via
 * useLiveStore.setState), this screen never builds a transaction or talks to
 * the network itself, it only displays what quoteEvmSend/confirmEvmSend hand
 * back, so there is nothing to exercise through a real service here (compare
 * LiveSend.fee.test.tsx, which DOES mock the service, because LiveSend calls
 * through to it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The store module constructs a real LiveWalletService singleton at import
// time; stub it exactly as LiveSend.fee.test.tsx does so that construction is
// inert. None of its methods are exercised by this screen (every action it
// calls is overridden directly below).
vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    allowBroadcast = false;
    network() {
      return 'mainnet';
    }
    async exists() {
      return true;
    }
    isUnlocked() {
      return true;
    }
    async listWallets() {
      return [];
    }
    getProvider() {
      return {};
    }
    async estimateFeeOptions() {
      return undefined;
    }
    async buildEvrSend() {
      throw new Error('not-used-in-these-tests');
    }
    async buildAssetSend() {
      throw new Error('not-used-in-these-tests');
    }
    async estimateMaxEvr() {
      return { maxSats: 0n, feeSats: 0n, totalSats: 0n };
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

// Bottom nav needs NavProvider context this screen doesn't set up; irrelevant here.
vi.mock('./LiveNav', () => ({ LiveNav: () => null }));

import { LiveSendEvm } from './LiveSendEvm';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

// --- fixtures ----------------------------------------------------------------

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WALLET_ADDRESS = '0x9858EfFD8358a6e59aC649c53F6e26311b4Cda94';
const RECIPIENT = '0x1234567890123456789012345678901234567890';

const BASE_INFO = {
  key: 'base',
  chainId: 8453,
  displayName: 'Base',
  nativeTicker: 'ETH',
  nativeDecimals: 18,
  explorerTxUrl: 'https://basescan.org/tx/{txid}',
  homepage: 'https://example.test',
  young: false,
  recentlyAdded: false,
  feeModel: 'eip1559' as const,
  l1DataFee: true,
  indexer: null,
  alchemy: false,
  trustWalletChain: null,
  tokenListSlug: null,
  defaultTokens: [{ address: USDC_ADDRESS, symbol: 'USDC', decimals: 6 }],
};

type FeeLevel = 'slow' | 'normal' | 'fast';

/** Round, easy-to-assert-on numbers, see the file's inline comments for how
 *  each one formats (18-decimal ETH, 9-decimal gwei). */
function makeQuote(level: FeeLevel) {
  const table: Record<FeeLevel, { maxFeePerGas: bigint; estimatedTotal: bigint; maxTotal: bigint }> = {
    slow: { maxFeePerGas: 1_000_000_000n, estimatedTotal: 100_000_000_000_000n, maxTotal: 150_000_000_000_000n },
    normal: { maxFeePerGas: 2_000_000_000n, estimatedTotal: 200_000_000_000_000n, maxTotal: 250_000_000_000_000n },
    fast: { maxFeePerGas: 4_000_000_000n, estimatedTotal: 400_000_000_000_000n, maxTotal: 500_000_000_000_000n },
  };
  const t = table[level];
  return {
    level,
    fee: { type: 'eip1559' as const, maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: 100_000_000n },
    gasLimit: 21000n,
    gasEstimate: 21000n,
    baseFeePerGas: 1_000_000_000n,
    l1DataFee: 50_000_000_000_000n, // 0.00005 ETH
    estimatedTotal: t.estimatedTotal,
    maxTotal: t.maxTotal,
  };
}

function makePlan(overrides: Record<string, unknown> = {}) {
  const quotes = { slow: makeQuote('slow'), normal: makeQuote('normal'), fast: makeQuote('fast') };
  const level = (overrides.level as FeeLevel) ?? 'normal';
  return {
    chainKey: 'base',
    chainId: 8453,
    from: WALLET_ADDRESS,
    to: RECIPIENT,
    asset: { kind: 'native' as const, ticker: 'ETH', decimals: 18 },
    amountBase: 1_000_000_000_000_000_000n, // 1 ETH
    amountText: '1',
    level,
    quotes,
    quote: quotes[level],
    unsigned: {
      chainId: 8453,
      to: RECIPIENT,
      value: 1_000_000_000_000_000_000n,
      data: new Uint8Array(),
      gasLimit: 21000n,
      fee: quotes[level].fee,
    },
    shortfall: null as string | null,
    capRefusal: null as string | null,
    ...overrides,
  };
}

function evmWallet(id: string, address: string, active = true) {
  return {
    id,
    name: id === 'w1' ? 'My Base Account' : id,
    network: 'evm',
    createdAt: 0,
    active,
    kind: 'seed' as const,
    address,
    passwordless: true,
    family: 'evm' as const,
    evmChainKey: 'base',
  };
}

const MNEB_ADDRESS = '0x4444444444444444444444444444444444444444';

// Recipient-risk fixtures: a counterparty this account really paid, and a
// vanity address that reproduces its first four and last four characters after
// the 0x while differing in the middle (the address-poisoning signature).
const KNOWN_COUNTERPARTY = '0x1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5678';
const POISON_LOOKALIKE = '0x1234bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb5678';

function historyTx(counterparty: string) {
  return {
    txid: `0x${'ab'.repeat(32)}`,
    asset: 'ETH',
    direction: 'out' as const,
    amount: 1,
    feeEvr: 0,
    status: 'confirmed' as const,
    timestamp: 1,
    counterparty,
  };
}

function baseState() {
  return {
    evm: { chains: [BASE_INFO], activeChainKey: 'base' },
    evmTokens: { tracked: [{ address: MNEB_ADDRESS, symbol: 'MNEB', decimals: 9 }], discovered: [] },
    evmSend: null,
    loadingEvmSend: false,
    error: null,
    assets: [
      { name: 'ETH', amountBase: 2_500_000_000_000_000_000n, scale: 18, decimals: 18, isNative: true },
      { name: 'USDC', amountBase: 5_000_000n, scale: 6, decimals: 6, isNative: false },
      { name: 'MNEB', amountBase: 7_000_000_000n, scale: 9, decimals: 9, isNative: false },
    ],
    wallets: [evmWallet('w1', WALLET_ADDRESS)],
    activeWalletId: 'w1',
    address: WALLET_ADDRESS,
    addresses: [{ index: 0, address: WALLET_ADDRESS }],
    txs: [],
    addressBook: [],
    requirePasswordToSend: false,
    // The only recipient warning that costs a round trip. Stubbed to a plain
    // account by default so no test reaches for the (absent) EVM engine.
    isEvmContractAddress: vi.fn(async () => false),
    verifyPassword: vi.fn(async () => true),
    arm: vi.fn(),
    quoteEvmSend: vi.fn(async () => null),
    selectEvmFeeLevel: vi.fn(async () => {}),
    estimateEvmMax: vi.fn(async () => ({ maxText: '0', feeText: '0' })),
    confirmEvmSend: vi.fn(async () => ({ txid: '0xabc', explorerUrl: 'https://basescan.org/tx/0xabc', chainKey: 'base' })),
    clearEvmSend: vi.fn(),
  };
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  useLiveStore.setState(baseState());
});

afterEach(cleanup);

// --- tests ---------------------------------------------------------------------

describe('LiveSendEvm, form step', () => {
  it('1. names the chain in the header and shows the available native balance', () => {
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    expect(screen.getByText('Send ETH on Base')).toBeInTheDocument();
    const available = screen.getByTestId('live-send-available');
    expect(available).toHaveTextContent('2.5');
    expect(available).toHaveTextContent('ETH');
  });

  it('2. Review quotes { to, amountText, assetId: native ticker, level: normal }, then shows the plan including the L1 line', async () => {
    const quoteEvmSend = vi.fn(async () => {
      const plan = makePlan();
      useLiveStore.setState({ evmSend: plan });
      return plan;
    });
    useLiveStore.setState({ quoteEvmSend });

    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    fireEvent.change(screen.getByTestId('live-send-to'), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByTestId('live-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));

    await waitFor(() => expect(quoteEvmSend).toHaveBeenCalledTimes(1));
    expect(quoteEvmSend).toHaveBeenCalledWith({
      to: RECIPIENT,
      amountText: '1',
      assetId: 'ETH',
      level: 'normal',
    });

    const review = await screen.findByTestId('live-send-review');
    expect(review).toHaveTextContent('1 ETH');
    const feeRow = screen.getByTestId('live-review-fee');
    expect(feeRow).toHaveTextContent('0.0002 ETH'); // estimatedTotal at 'normal'
    expect(review).toHaveTextContent('0.00025 ETH'); // maxTotal at 'normal'
    expect(screen.getByTestId('live-review-l1-fee')).toHaveTextContent('0.00005 ETH');
  });

  it('3. Token flow: assetId sent is the USDC contract address, and the amount label shows USDC', async () => {
    const quoteEvmSend = vi.fn(async () => {
      const plan = makePlan({
        asset: { kind: 'token' as const, address: USDC_ADDRESS, symbol: 'USDC', decimals: 6 },
        amountBase: 5_000_000n,
      });
      useLiveStore.setState({ evmSend: plan });
      return plan;
    });
    useLiveStore.setState({ quoteEvmSend });

    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} asset="usdc" />);
    expect(screen.getByText('Amount (USDC)')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('live-send-to'), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByTestId('live-send-amount'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));

    await waitFor(() => expect(quoteEvmSend).toHaveBeenCalledTimes(1));
    expect(quoteEvmSend).toHaveBeenCalledWith({
      to: RECIPIENT,
      amountText: '5',
      assetId: USDC_ADDRESS,
      level: 'normal',
    });
    const review = await screen.findByTestId('live-send-review');
    expect(review).toHaveTextContent('5 USDC');
  });

  it('9. Max (native) fills the amount field from estimateEvmMax', async () => {
    const estimateEvmMax = vi.fn(async () => ({ maxText: '2.499779', feeText: '0.000221' }));
    useLiveStore.setState({ estimateEvmMax });

    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('live-amt-max'));

    await waitFor(() => expect(estimateEvmMax).toHaveBeenCalledWith('normal', expect.any(String)));
    expect(screen.getByTestId('live-send-amount')).toHaveValue('2.499779');
  });
});

describe('LiveSendEvm, review step', () => {
  it('4. clicking a fee level on review calls selectEvmFeeLevel, not a new quote', () => {
    const selectEvmFeeLevel = vi.fn(async () => {});
    useLiveStore.setState({ evmSend: makePlan(), selectEvmFeeLevel });

    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('live-fee-option-fast'));

    expect(selectEvmFeeLevel).toHaveBeenCalledWith('fast');
  });

  it('5a. a shortfall disables Send and shows the banner', () => {
    useLiveStore.setState({ evmSend: makePlan({ shortfall: 'Not enough ETH: amount plus the maximum fee exceeds the balance.' }) });
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    expect(screen.getByTestId('live-send-shortfall')).toHaveTextContent('Not enough ETH');
    expect(screen.getByTestId('live-broadcast')).toBeDisabled();
  });

  it('5b. a capRefusal disables Send and shows "Refusing to sign"', () => {
    // The store's message already carries the prefix (EvmFeeCapError.message); the screen shows it verbatim.
    useLiveStore.setState({ evmSend: makePlan({ capRefusal: 'Refusing to sign: the base fee rate exceeds the per-chain fee ceiling' }) });
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    const banner = screen.getByTestId('live-send-cap-refusal');
    expect(banner).toHaveTextContent('Refusing to sign:');
    expect(banner).toHaveTextContent('exceeds the per-chain fee ceiling');
    expect(screen.getByTestId('live-broadcast')).toBeDisabled();
  });

  it('6. confirm: arm(true) precedes confirmEvmSend; success shows the txid and an explorer link', async () => {
    const callOrder: string[] = [];
    const arm = vi.fn((on: boolean) => callOrder.push(`arm:${on}`));
    const confirmEvmSend = vi.fn(async () => {
      callOrder.push('confirmEvmSend');
      return { txid: '0xdeadbeef', explorerUrl: 'https://basescan.org/tx/0xdeadbeef', chainKey: 'base' };
    });
    useLiveStore.setState({ evmSend: makePlan(), arm, confirmEvmSend });

    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('live-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-broadcast'));

    await waitFor(() => expect(confirmEvmSend).toHaveBeenCalledTimes(1));
    const armTrueIndex = callOrder.lastIndexOf('arm:true');
    const confirmIndex = callOrder.indexOf('confirmEvmSend');
    expect(armTrueIndex).toBeGreaterThanOrEqual(0);
    expect(armTrueIndex).toBeLessThan(confirmIndex);

    expect(await screen.findByTestId('live-review-txid')).toHaveTextContent('0xdeadbeef');
    const link = screen.getByTestId('live-explorer-link');
    expect(link).toHaveAttribute('href', 'https://basescan.org/tx/0xdeadbeef');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(callOrder).toContain('arm:false');
  });

  it('6b. confirm failure shows err.message and calls arm(false)', async () => {
    const arm = vi.fn();
    const confirmEvmSend = vi.fn(async () => {
      throw new Error('Base rejected the transaction: insufficient funds');
    });
    useLiveStore.setState({ evmSend: makePlan(), arm, confirmEvmSend });

    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('live-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-broadcast'));

    await waitFor(() => expect(confirmEvmSend).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('live-send-error')).toHaveTextContent('insufficient funds');
    expect(arm).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('live-review-txid')).toBeNull();
  });

  it('7. wrong password blocks the send: verifyPassword false shows an error and confirmEvmSend is never called', async () => {
    const verifyPassword = vi.fn(async () => false);
    const confirmEvmSend = vi.fn(async () => ({ txid: 'x', explorerUrl: 'x', chainKey: 'base' }));
    useLiveStore.setState({
      evmSend: makePlan(),
      requirePasswordToSend: true,
      wallets: [{ ...evmWallet('w1', WALLET_ADDRESS), passwordless: false }],
      verifyPassword,
      confirmEvmSend,
    });

    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('live-arm-checkbox'));
    fireEvent.change(screen.getByTestId('live-send-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('live-broadcast'));

    await waitFor(() => expect(verifyPassword).toHaveBeenCalledWith('wrong'));
    expect(await screen.findByTestId('live-send-password-error')).toHaveTextContent('Incorrect password');
    expect(confirmEvmSend).not.toHaveBeenCalled();
  });

  it('8. Back from review clears the plan (clearEvmSend) and arms off', () => {
    const clearEvmSend = vi.fn();
    const arm = vi.fn();
    useLiveStore.setState({ evmSend: makePlan(), clearEvmSend, arm });

    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByTestId('live-send-review-back'));

    expect(clearEvmSend).toHaveBeenCalled();
    expect(arm).toHaveBeenCalledWith(false);
  });

  it('3b. an imported (tracked) token resolves to its CONTRACT, not "Unknown asset"', async () => {
    const quoteEvmSend = vi.fn(async () => null);
    useLiveStore.setState({ quoteEvmSend });
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} asset="MNEB" />);
    expect(screen.getByText('Send MNEB on Base')).toBeInTheDocument();
    expect(screen.queryByText(/Unknown asset/)).toBeNull();
    fireEvent.change(screen.getByTestId('live-send-to'), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByTestId('live-send-amount'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));
    await waitFor(() => expect(quoteEvmSend).toHaveBeenCalledTimes(1));
    expect(quoteEvmSend).toHaveBeenCalledWith({ to: RECIPIENT, amountText: '2', assetId: MNEB_ADDRESS, level: 'normal' });
  });
});

describe('LiveSendEvm, my wallets picker', () => {
  const other = (n: number) => `0x${n.toString(16).padStart(4, '0')}${'c'.repeat(36)}`;
  it('up to 4 other accounts are chips; more become a dropdown that fills the recipient', () => {
    const four = [1, 2, 3, 4].map((n) => evmWallet(`acc${n}`, other(n), false));
    useLiveStore.setState({ wallets: [evmWallet('w1', WALLET_ADDRESS), ...four] });
    const { unmount } = render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    expect(screen.getByTestId('live-send-wallet-0')).toBeInTheDocument();
    expect(screen.queryByTestId('live-send-my-wallets-select')).toBeNull();
    unmount();

    const five = [1, 2, 3, 4, 5].map((n) => evmWallet(`acc${n}`, other(n), false));
    useLiveStore.setState({ wallets: [evmWallet('w1', WALLET_ADDRESS), ...five] });
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    expect(screen.queryByTestId('live-send-wallet-0')).toBeNull();
    const select = screen.getByTestId('live-send-my-wallets-select') as HTMLSelectElement;
    expect(select.options).toHaveLength(6); // placeholder + 5
    fireEvent.change(select, { target: { value: other(3) } });
    expect((screen.getByTestId('live-send-to') as HTMLInputElement).value).toBe(other(3));
    expect(select.value).toBe(other(3));
  });
});

describe('LiveSendEvm, recipient risk warnings', () => {
  /** Enter a well-formed recipient into the form. */
  function typeRecipient(address: string) {
    fireEvent.change(screen.getByTestId('live-send-to'), { target: { value: address } });
  }

  it('R1. an address never paid before gets the first-time warning (and only once it is well formed)', () => {
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    // Nothing typed: no warning to give yet.
    expect(screen.queryByTestId('live-send-first-time')).toBeNull();
    typeRecipient('0x1234');
    expect(screen.queryByTestId('live-send-first-time')).toBeNull();

    typeRecipient(RECIPIENT);
    expect(screen.getByTestId('live-send-first-time')).toHaveTextContent(
      'First time sending to this address',
    );
    // A first-time address is not automatically a look-alike or a contract.
    expect(screen.queryByTestId('live-send-lookalike')).toBeNull();
    expect(screen.queryByTestId('live-send-contract')).toBeNull();
  });

  it('R2. an address-book contact is not a first-time recipient', () => {
    useLiveStore.setState({ addressBook: [{ label: 'Exchange', address: RECIPIENT }] });
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    typeRecipient(RECIPIENT);
    expect(screen.queryByTestId('live-send-first-time')).toBeNull();
  });

  it('R2b. one of my own accounts, and a counterparty already in history, are not first-time either', () => {
    useLiveStore.setState({ txs: [historyTx(KNOWN_COUNTERPARTY)] });
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    typeRecipient(KNOWN_COUNTERPARTY);
    expect(screen.queryByTestId('live-send-first-time')).toBeNull();
    // Case only carries an EIP-55 checksum on EVM: the same address in another
    // case is still the same address.
    typeRecipient(WALLET_ADDRESS.toLowerCase());
    expect(screen.queryByTestId('live-send-first-time')).toBeNull();
  });

  it('R3. an address imitating the ends of a history counterparty raises the poisoning warning', () => {
    useLiveStore.setState({ txs: [historyTx(KNOWN_COUNTERPARTY)] });
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    typeRecipient(POISON_LOOKALIKE);

    const banner = screen.getByTestId('live-send-lookalike');
    expect(banner).toHaveTextContent('looks like one you have used before');
    // The known address is named in the app's own short form.
    expect(banner).toHaveTextContent('0x1234…5678');
    expect(banner).toHaveTextContent('compare every character before you send');
    // It IS also an address this wallet has never paid.
    expect(screen.getByTestId('live-send-first-time')).toBeInTheDocument();
  });

  it('R4. a recipient the chain reports code at raises the contract warning', async () => {
    const isEvmContractAddress = vi.fn(async () => true);
    useLiveStore.setState({ isEvmContractAddress });
    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    typeRecipient(USDC_ADDRESS);

    expect(await screen.findByTestId('live-send-contract', undefined, { timeout: 3000 })).toHaveTextContent(
      'This address is a contract, not a wallet',
    );
    expect(isEvmContractAddress).toHaveBeenCalledWith(USDC_ADDRESS);
  });

  it('R5. the review repeats the warnings the form showed', async () => {
    const quoteEvmSend = vi.fn(async () => {
      const plan = makePlan();
      useLiveStore.setState({ evmSend: plan });
      return plan;
    });
    useLiveStore.setState({ quoteEvmSend });

    render(<LiveSendEvm onBack={() => {}} onDone={() => {}} />);
    typeRecipient(RECIPIENT);
    fireEvent.change(screen.getByTestId('live-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));

    const review = await screen.findByTestId('live-send-review');
    expect(review).toContainElement(screen.getByTestId('live-send-first-time'));
  });
});
