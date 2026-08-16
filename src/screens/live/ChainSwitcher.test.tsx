// @vitest-environment jsdom
// Needs `document` for React Testing Library render, so this file opts into
// jsdom on its own (the project's default vitest environment is 'node').
//
// The store + chainParams modules are fully mocked so this exercises
// ChainSwitcher in isolation, independent of the real store's own (separately
// landing) implementation of chainsWithWallets/walletOnChain/switchChain/
// enableChain/chainsShareDerivation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

interface MockWallet {
  id: string;
  name: string;
  network: string;
  createdAt: number;
  active: boolean;
  kind: 'seed' | 'pk';
  address: string;
  passwordless: boolean;
}

interface MockState {
  wallets: MockWallet[];
  activeChain: string;
  /** Chains hidden in expert Settings. Empty in every test but the one that
   *  covers hiding, which is the shipped default. */
  hiddenChains: string[];
  switchChain: (id: string) => Promise<void>;
  enableChain: (id: string, password: string) => Promise<{ ok: boolean; error?: string }>;
}

// vi.mock factories are hoisted above imports, so the shared mutable state
// they close over must be created via vi.hoisted (a plain module-scope `let`
// declared below would still be in its temporal dead zone when the factory
// itself runs at first import).
const { getState, setState } = vi.hoisted(() => {
  let state: MockState;
  return {
    getState: () => state,
    setState: (s: MockState) => {
      state = s;
    },
  };
});

vi.mock('../../store/liveStore', () => ({
  useLiveStore: (selector: (s: MockState) => unknown) => selector(getState()),
  activeChainId: () => getState().activeChain,
  chainsWithWallets: (wallets: MockWallet[]) => new Set(wallets.map((w) => w.network)),
  walletOnChain: (wallets: MockWallet[], chainId: string) => wallets.find((w) => w.network === chainId) ?? null,
}));

// Mirrors the real ChainNetwork fields this component reads. `homepage` is a
// REQUIRED field on the real type, so the mock must supply it or the component
// renders against undefined (which is exactly how this mock first broke).
// vi.hoisted because the mock factory below SPREADS these entries when the
// mocked module is first evaluated (during the hoisted ChainSwitcher import),
// i.e. before a plain module-scope const would be initialized.
const CHAIN_INFO = vi.hoisted(
  () =>
    ({
      mainnet: { ticker: 'EVR', displayName: 'Evrmore', homepage: 'https://evrmore.com' },
      'ravencoin-mainnet': { ticker: 'RVN', displayName: 'Ravencoin', homepage: 'https://ravencoin.org' },
      // young: true mirrors the real params for the two thin networks.
      'bitcoingold-mainnet': { ticker: 'BTGS', displayName: 'BitcoinGold', homepage: 'https://bitcoingold.site', young: true },
      'litecoin-mainnet': { ticker: 'LTC', displayName: 'Litecoin', homepage: 'https://litecoin.org' },
      'wojakcoin-mainnet': { ticker: 'WJK', displayName: 'WojakCoin', homepage: 'https://wojakcoin.cash', young: true },
      'bitcoin-mainnet': { ticker: 'BTC', displayName: 'Bitcoin', homepage: 'https://bitcoin.org' },
      'dogecoin-mainnet': { ticker: 'DOGE', displayName: 'Dogecoin', homepage: 'https://dogecoin.com' },
    }) as Record<
      string,
      { ticker: string; displayName: string; homepage: string; young?: boolean }
    >,
);

// Evrmore + Ravencoin share coinType 175 and standard BIP32 bytes (see
// chainParams.ts); Bitcoin Gold and Litecoin each use their own coin type, so
// neither shares derivation with anything else here. The mock accepts either
// a bare chain-id string or a resolved network object (whichever shape the
// real chainsShareDerivation ends up taking), keyed off `.id`.
const SHARED_DERIVATION_GROUP = new Set(['mainnet', 'ravencoin-mainnet']);

vi.mock('../../services/chain/chainParams', () => ({
  // `chainId` is the CANONICAL id and is what the hidden-chain filter compares
  // against. Evrmore's stored id is the legacy bare 'mainnet', so the two differ and
  // the mock must carry both, exactly like the real params do.
  networkFor: (id: string) => ({
    id,
    chainId: id === 'mainnet' ? 'evrmore-mainnet' : id,
    ...CHAIN_INFO[id],
  }),
  // Reads the `young` flag off the mocked chain record, so a test can mark a
  // chain young by adding it to CHAIN_INFO rather than by stubbing this.
  isYoungChain: (net: { young?: boolean }) => net?.young === true,
  chainsShareDerivation: (a: unknown, b: unknown) => {
    const idA = typeof a === 'string' ? a : (a as { id: string }).id;
    const idB = typeof b === 'string' ? b : (b as { id: string }).id;
    return idA !== idB && SHARED_DERIVATION_GROUP.has(idA) && SHARED_DERIVATION_GROUP.has(idB);
  },
  // ChainSwitcher imports CHAIN_OPTIONS from ChainPicker, which builds its rows
  // from these named network constants AT MODULE SCOPE — the mock must export
  // them or the whole suite fails at collection time.
  EVRMORE_MAINNET: { id: 'mainnet', ...CHAIN_INFO.mainnet },
  RAVENCOIN_MAINNET: { id: 'ravencoin-mainnet', ...CHAIN_INFO['ravencoin-mainnet'] },
  BITCOINGOLD_MAINNET: { id: 'bitcoingold-mainnet', ...CHAIN_INFO['bitcoingold-mainnet'] },
  LITECOIN_MAINNET: { id: 'litecoin-mainnet', ...CHAIN_INFO['litecoin-mainnet'] },
  WOJAKCOIN_MAINNET: { id: 'wojakcoin-mainnet', ...CHAIN_INFO['wojakcoin-mainnet'] },
  BITCOIN_MAINNET: { id: 'bitcoin-mainnet', ...CHAIN_INFO['bitcoin-mainnet'] },
  DOGECOIN_MAINNET: { id: 'dogecoin-mainnet', ...CHAIN_INFO['dogecoin-mainnet'] },
}));

import { ChainSwitcher } from './ChainSwitcher';

afterEach(cleanup);

function wallet(overrides: Partial<MockWallet> = {}): MockWallet {
  return {
    id: 'w1',
    name: 'My Wallet',
    network: 'mainnet',
    createdAt: 0,
    active: true,
    kind: 'seed',
    address: 'EAddr',
    passwordless: false,
    ...overrides,
  };
}

function setup(overrides: Partial<MockState> = {}) {
  const switchChain = vi.fn().mockResolvedValue(undefined);
  const enableChain = vi.fn().mockResolvedValue({ ok: true });
  setState({
    wallets: [wallet()],
    activeChain: 'mainnet',
    hiddenChains: [],
    switchChain,
    enableChain,
    ...overrides,
  });
  return { switchChain, enableChain };
}

function openSwitcher() {
  fireEvent.click(screen.getByTestId('live-chain-switcher'));
}

describe('ChainSwitcher', () => {
  it('shows the active chain on the trigger and marks it selected in the list', () => {
    setup({ wallets: [wallet({ network: 'ravencoin-mainnet' })], activeChain: 'ravencoin-mainnet' });
    render(<ChainSwitcher />);

    expect(screen.getByTestId('live-chain-switcher')).toHaveTextContent('Ravencoin');

    openSwitcher();
    const current = screen.getByTestId('live-chain-option-ravencoin-mainnet');
    expect(current.getAttribute('aria-selected')).toBe('true');
    expect(current.getAttribute('aria-current')).toBe('true');
    // A Check mark renders inside the selected row only.
    expect(current.querySelector('svg')).not.toBeNull();

    const other = screen.getByTestId('live-chain-option-mainnet');
    expect(other.getAttribute('aria-selected')).toBe('false');
  });

  it('switches straight to a chain the wallet already has, and closes the dropdown', () => {
    const { switchChain } = setup({
      wallets: [wallet({ network: 'mainnet' }), wallet({ id: 'w2', network: 'ravencoin-mainnet', active: false })],
      activeChain: 'mainnet',
    });
    render(<ChainSwitcher />);
    openSwitcher();

    fireEvent.click(screen.getByTestId('live-chain-option-ravencoin-mainnet'));

    expect(switchChain).toHaveBeenCalledWith('ravencoin-mainnet');
    expect(screen.queryByTestId('live-chain-dropdown')).toBeNull();
  });

  it('opens the enable panel (not a switch) for a chain with no wallet yet', () => {
    const { switchChain } = setup();
    render(<ChainSwitcher />);
    openSwitcher();

    fireEvent.click(screen.getByTestId('live-chain-option-bitcoingold-mainnet'));

    expect(switchChain).not.toHaveBeenCalled();
    const panel = screen.getByTestId('live-chain-enable-panel');
    expect(panel.textContent).toMatch(/Enable BitcoinGold for this wallet\?/);
    expect(panel.textContent).toMatch(/from the same recovery phrase/i);
  });

  it('shows the shared-derivation privacy sentence for Ravencoin (shares a key with the active Evrmore wallet)', () => {
    setup();
    render(<ChainSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-ravencoin-mainnet'));

    const note = screen.getByTestId('live-chain-privacy-note');
    expect(note.textContent).toMatch(/share the same key/i);
    expect(note.textContent).toMatch(/publicly linkable/i);
  });

  it('does NOT show the privacy sentence for Bitcoin Gold or Litecoin (no shared derivation)', () => {
    setup();
    render(<ChainSwitcher />);

    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-bitcoingold-mainnet'));
    expect(screen.queryByTestId('live-chain-privacy-note')).toBeNull();

    fireEvent.click(screen.getByTestId('live-chain-enable-cancel'));
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    expect(screen.queryByTestId('live-chain-privacy-note')).toBeNull();
  });

  it('shows the privacy note on EVERY pair for an imported-key (pk) wallet, even without shared derivation', () => {
    // A 'pk' wallet re-imports the SAME private key on the target chain, so the
    // addresses are linkable on every pair; the derivation-based predicate
    // (mocked to Evrmore<->Ravencoin only) cannot see that.
    setup({ wallets: [wallet({ kind: 'pk' })] });
    render(<ChainSwitcher />);
    openSwitcher();

    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    expect(screen.getByTestId('live-chain-privacy-note').textContent).toMatch(/publicly linkable/i);

    fireEvent.click(screen.getByTestId('live-chain-enable-cancel'));
    fireEvent.click(screen.getByTestId('live-chain-option-bitcoingold-mainnet'));
    expect(screen.getByTestId('live-chain-privacy-note').textContent).toMatch(/publicly linkable/i);
  });

  it("describes a pk wallet's enable step as reusing the imported key, never a recovery phrase", () => {
    setup({ wallets: [wallet({ kind: 'pk' })] });
    render(<ChainSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));

    const panel = screen.getByTestId('live-chain-enable-panel');
    expect(panel.textContent).toMatch(/imported private key/i);
    // A pk wallet has no recovery phrase; the seed wording would be false.
    expect(panel.textContent).not.toMatch(/recovery phrase/i);
    // House style: no em-dash in the pk copy either.
    expect(panel.textContent).not.toContain('—');
  });

  it('shows a password field for a normal (password-protected) active wallet', () => {
    setup({ wallets: [wallet({ passwordless: false })] });
    render(<ChainSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));

    expect(screen.getByTestId('live-chain-enable-password')).not.toBeNull();
  });

  it('skips the password field entirely for a passwordless active wallet', () => {
    setup({ wallets: [wallet({ passwordless: true })] });
    render(<ChainSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));

    expect(screen.queryByTestId('live-chain-enable-password')).toBeNull();
  });

  it('calls enableChain with an empty password for a passwordless wallet, and closes on success', async () => {
    const { enableChain } = setup({ wallets: [wallet({ passwordless: true })] });
    render(<ChainSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));

    await waitFor(() => expect(enableChain).toHaveBeenCalledWith('litecoin-mainnet', ''));
    await waitFor(() => expect(screen.queryByTestId('live-chain-enable-panel')).toBeNull());
  });

  it('shows the returned error and keeps the panel open when enableChain fails', async () => {
    const enableChain = vi.fn().mockResolvedValue({ ok: false, error: 'Incorrect password' });
    setup({ enableChain });
    render(<ChainSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    fireEvent.change(screen.getByTestId('live-chain-enable-password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));

    await waitFor(() => expect(screen.getByTestId('live-chain-enable-error')).toHaveTextContent('Incorrect password'));
    expect(screen.getByTestId('live-chain-enable-panel')).not.toBeNull();
    expect(enableChain).toHaveBeenCalledWith('litecoin-mainnet', 'hunter2');
  });

  it('never uses an em-dash in its copy (house style)', () => {
    setup();
    render(<ChainSwitcher />);
    openSwitcher();
    expect(screen.getByTestId('live-chain-dropdown').textContent).not.toContain('—');

    fireEvent.click(screen.getByTestId('live-chain-option-ravencoin-mainnet'));
    expect(screen.getByTestId('live-chain-enable-panel').textContent).not.toContain('—');
  });

  it('closes on Escape', () => {
    setup();
    render(<ChainSwitcher />);
    openSwitcher();
    expect(screen.getByTestId('live-chain-dropdown')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('live-chain-dropdown')).toBeNull();
  });

  it('closes on an outside click', () => {
    setup();
    render(<ChainSwitcher />);
    openSwitcher();
    expect(screen.getByTestId('live-chain-dropdown')).not.toBeNull();

    fireEvent.click(screen.getByTestId('live-chain-switcher-overlay'));
    expect(screen.queryByTestId('live-chain-dropdown')).toBeNull();
  });
});

describe('hidden networks', () => {
  it('leaves a hidden chain out of the switcher list', () => {
    setup({ hiddenChains: ['litecoin-mainnet', 'dogecoin-mainnet'] });
    render(<ChainSwitcher />);
    openSwitcher();

    expect(screen.queryByTestId('live-chain-option-litecoin-mainnet')).toBeNull();
    expect(screen.queryByTestId('live-chain-option-dogecoin-mainnet')).toBeNull();
    // Everything else is still offered.
    expect(screen.getByTestId('live-chain-option-bitcoin-mainnet')).toBeTruthy();
    expect(screen.getByTestId('live-chain-option-mainnet')).toBeTruthy();
  });

  it('still shows the chain IN USE even if it is somehow marked hidden', () => {
    // The store refuses to hide the active chain, but a stale render must not be
    // able to strand the user on a network missing from their own list.
    setup({ activeChain: 'bitcoin-mainnet', hiddenChains: ['bitcoin-mainnet'] });
    render(<ChainSwitcher />);
    openSwitcher();

    const row = screen.getByTestId('live-chain-option-bitcoin-mainnet');
    expect(row.getAttribute('aria-selected')).toBe('true');
  });
});
