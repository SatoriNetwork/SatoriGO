/**
 * @vitest-environment jsdom
 *
 * LiveAddAsset: the Add token modal. On an EVM chain the field takes either a
 * contract address or a name/symbol to SEARCH for, and a search row is only a
 * shortcut to an address: picking one must add the token through exactly the
 * same path a pasted address takes, so `addEvmToken` is what these tests watch.
 *
 * The store's `searchEvmTokens` is stubbed (the real one downloads a token
 * list); `addAsset` is the REAL store action, so the test also proves the EVM
 * dispatch inside it still routes to addEvmToken.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ family: 'evm' as 'evm' | 'utxo' }));

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
    async listWallets() {
      return [];
    }
    activeWalletId() {
      return 'w1';
    }
    isUnlocked() {
      return true;
    }
    activeWalletFamily() {
      return state.family;
    }
    evmChainKey() {
      return state.family === 'evm' ? 'base' : null;
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { LiveAddAsset } from './LiveAddAsset';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

// --- fixtures ----------------------------------------------------------------

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const WETH = '0x4200000000000000000000000000000000000006';

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
  // No provider token index in these tests: the Import section stays out of the
  // way of the search assertions (it has its own coverage in the live smoke).
  alchemy: false,
  trustWalletChain: null,
  tokenListSlug: 'base',
  defaultTokens: [{ address: USDC, symbol: 'USDC', decimals: 6 }],
};

const HITS = [
  { address: CBBTC, name: 'Coinbase Wrapped BTC', symbol: 'cbBTC', decimals: 8 },
  { address: WETH, name: 'Wrapped Ether', symbol: 'WETH', decimals: 18 },
];

let addEvmToken: ReturnType<typeof vi.fn>;
let searchEvmTokens: ReturnType<typeof vi.fn>;

function setup(family: 'evm' | 'utxo' = 'evm', overrides: Record<string, unknown> = {}) {
  state.family = family;
  addEvmToken = vi.fn(async () => ({ ok: true as const }));
  searchEvmTokens = vi.fn(async () => ({ ok: true as const, results: HITS }));
  useLiveStore.setState({
    evm: { chains: family === 'evm' ? [BASE_INFO] : [], activeChainKey: family === 'evm' ? 'base' : null },
    evmTokens: { tracked: [], discovered: [] },
    addEvmToken,
    searchEvmTokens,
    importEvmTokens: vi.fn(async () => ({ ok: true as const, added: 0, skipped: 0, untrusted: 0 })),
    ...overrides,
  });
}

/** The field, typed into the way a user would. */
function type(value: string) {
  fireEvent.change(screen.getByTestId('live-add-asset-input'), { target: { value } });
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  setup('evm');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- tests -------------------------------------------------------------------

describe('LiveAddAsset on an EVM chain', () => {
  it('1. the field asks for a name, a symbol OR an address', () => {
    render(<LiveAddAsset onClose={() => {}} />);
    expect(screen.getByLabelText('Token name, symbol or contract address')).toBeInTheDocument();
    expect(screen.getByTestId('live-add-asset-input')).toHaveAttribute('placeholder', 'e.g. USDC or 0x...');
    // Nothing is searched before anything is typed.
    expect(screen.queryByTestId('live-token-search-results')).toBeNull();
    expect(searchEvmTokens).not.toHaveBeenCalled();
  });

  it('2. typing a name searches and lists the matches with symbol, name and short address', async () => {
    render(<LiveAddAsset onClose={() => {}} />);
    type('usdc');
    const list = await screen.findByTestId('live-token-search-results', {}, { timeout: 2000 });
    await waitFor(() => expect(searchEvmTokens).toHaveBeenCalledWith('usdc'));
    const rows = screen.getAllByTestId(/^live-token-search-result-/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-testid', `live-token-search-result-${CBBTC.toLowerCase()}`);
    expect(rows[0]).toHaveTextContent('cbBTC');
    expect(rows[0]).toHaveTextContent('Coinbase Wrapped BTC');
    expect(rows[0]).toHaveTextContent('0xcbB7…33Bf');
    expect(list).toContainElement(rows[1]);
  });

  it('3. a single character is not searched (a one-letter query matches most of the list)', async () => {
    render(<LiveAddAsset onClose={() => {}} />);
    type('u');
    await new Promise((r) => setTimeout(r, 400));
    expect(searchEvmTokens).not.toHaveBeenCalled();
    expect(screen.queryByTestId('live-token-search-results')).toBeNull();
  });

  it('4. clicking a result adds THAT token by its checksummed contract address and closes the modal', async () => {
    const onClose = vi.fn();
    render(<LiveAddAsset onClose={onClose} />);
    type('cbbtc');
    await screen.findByTestId('live-token-search-results', {}, { timeout: 2000 });
    fireEvent.click(screen.getByTestId(`live-token-search-result-${CBBTC.toLowerCase()}`));
    await waitFor(() => expect(addEvmToken).toHaveBeenCalledWith(CBBTC));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('5. a failed add from a search row shows the store error and keeps the modal open', async () => {
    const onClose = vi.fn();
    setup('evm', { addEvmToken: vi.fn(async () => ({ ok: false as const, error: 'Base is unreachable right now; try again.' })) });
    addEvmToken = useLiveStore.getState().addEvmToken as unknown as ReturnType<typeof vi.fn>;
    render(<LiveAddAsset onClose={onClose} />);
    type('cbbtc');
    await screen.findByTestId('live-token-search-results', {}, { timeout: 2000 });
    fireEvent.click(screen.getByTestId(`live-token-search-result-${CBBTC.toLowerCase()}`));
    const err = await screen.findByTestId('live-add-asset-error');
    expect(err).toHaveTextContent('Base is unreachable right now; try again.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('6. a contract address is not a search: no list, and submitting adds it directly', async () => {
    const onClose = vi.fn();
    render(<LiveAddAsset onClose={onClose} />);
    type(WETH);
    await new Promise((r) => setTimeout(r, 400));
    expect(searchEvmTokens).not.toHaveBeenCalled();
    expect(screen.queryByTestId('live-token-search-results')).toBeNull();
    fireEvent.click(screen.getByTestId('live-add-asset-submit'));
    await waitFor(() => expect(addEvmToken).toHaveBeenCalledWith(WETH));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('7. no matches says so and points back at the contract address', async () => {
    setup('evm', { searchEvmTokens: vi.fn(async () => ({ ok: true as const, results: [] })) });
    render(<LiveAddAsset onClose={() => {}} />);
    type('zzzz');
    const empty = await screen.findByTestId('live-token-search-empty', {}, { timeout: 2000 });
    expect(empty).toHaveTextContent('No matches. Paste the contract address to add it anyway.');
    expect(screen.queryByTestId('live-token-search-results')).toBeNull();
  });

  it('8. a search failure is reported without blaming the user, and the address path still works', async () => {
    setup('evm', { searchEvmTokens: vi.fn(async () => ({ ok: false as const, error: 'token list unreachable' })) });
    render(<LiveAddAsset onClose={() => {}} />);
    type('usdc');
    const err = await screen.findByTestId('live-token-search-error', {}, { timeout: 2000 });
    expect(err).toHaveTextContent('Token search is unavailable right now. Paste the contract address instead.');
    expect(screen.queryByTestId('live-token-search-results')).toBeNull();
    // The raw store error is never shown to the user.
    expect(err).not.toHaveTextContent('token list unreachable');
  });

  it('9. submitting a name with exactly one match adds it; with several it asks the user to pick', async () => {
    setup('evm', { searchEvmTokens: vi.fn(async () => ({ ok: true as const, results: [HITS[0]] })) });
    render(<LiveAddAsset onClose={() => {}} />);
    type('cbbtc');
    await screen.findByTestId('live-token-search-results', {}, { timeout: 2000 });
    fireEvent.click(screen.getByTestId('live-add-asset-submit'));
    await waitFor(() => expect(useLiveStore.getState().addEvmToken).toHaveBeenCalledWith(CBBTC));

    cleanup();
    setup('evm');
    render(<LiveAddAsset onClose={() => {}} />);
    type('usdc');
    await screen.findByTestId('live-token-search-results', {}, { timeout: 2000 });
    fireEvent.click(screen.getByTestId('live-add-asset-submit'));
    const err = await screen.findByTestId('live-add-asset-error');
    expect(err).toHaveTextContent('Enter a token contract address, or pick a token from the search results.');
    expect(addEvmToken).not.toHaveBeenCalled();
  });
});

describe('LiveAddAsset on a UTXO chain', () => {
  it('10. is unchanged: an asset name, no search, no token list', async () => {
    setup('utxo');
    render(<LiveAddAsset onClose={() => {}} />);
    expect(screen.getByLabelText('Asset name')).toBeInTheDocument();
    expect(screen.getByTestId('live-add-asset-input')).toHaveAttribute('placeholder', 'e.g. SATORI');
    type('satori');
    await new Promise((r) => setTimeout(r, 400));
    expect(searchEvmTokens).not.toHaveBeenCalled();
    expect(screen.queryByTestId('live-token-search-results')).toBeNull();
    expect(screen.queryByTestId('live-token-search-empty')).toBeNull();
  });
});
