/**
 * @vitest-environment jsdom
 *
 * The lock screen's two views (owner request: "when I pick a wallet with a
 * password, the other wallets appear above the password field, truncated").
 * With EVM accounts one seed can contribute 20+ entries, so the wallet list
 * moved OUT of the password view into a view of its own:
 *
 *  - password view: one card naming the wallet being unlocked + the password
 *    field. Nothing scrolls, nothing is truncated.
 *  - list view (behind "Change"): every wallet, grouped by seed exactly as the
 *    Home switcher groups them; picking one returns to the password view.
 *
 * The wallet service is stubbed (this screen never talks to a chain: it renders
 * from `wallets` + `activeWalletId` and calls switchWallet/unlock), and the
 * store's actions are replaced per test and restored after, because the store
 * is a module singleton.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    async exists() {
      return true;
    }
    async listWallets() {
      return [];
    }
    activeWalletId() {
      return null;
    }
    isUnlocked() {
      return false;
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

// Prices are decorative and hit the network — stub so nothing reaches out.
vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({}),
}));

import { LiveLock } from './LiveLock';
import { useLiveStore } from '../../store/liveStore';
import type { WalletSummary } from '../../services/chain/liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

const state = () => useLiveStore.getState();

const ADDR_1 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ADDR_2 = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const SEED_GROUP = ADDR_1.toLowerCase();

function evmAccount(over: Partial<WalletSummary> & { id: string }): WalletSummary {
  return {
    name: 'My EVM',
    network: 'evm',
    createdAt: 1,
    active: false,
    kind: 'seed',
    address: ADDR_1,
    passwordless: false,
    family: 'evm',
    hdIndex: 0,
    seedGroup: SEED_GROUP,
    ...over,
  } as WalletSummary;
}

const UTXO_WALLET = {
  id: 'w-utxo',
  name: 'My Evrmore',
  network: 'mainnet',
  createdAt: 1,
  active: false,
  kind: 'seed',
  address: 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU',
  passwordless: false,
  family: 'utxo',
} as unknown as WalletSummary;

/** One UTXO wallet plus TWO accounts of one EVM seed: the shape that made the
 *  old in-place strip unusable, and the one the grouping has to render. */
const THREE_WALLETS: WalletSummary[] = [
  UTXO_WALLET,
  evmAccount({ id: 'a1', name: 'My EVM', hdIndex: 0, address: ADDR_1 }),
  evmAccount({ id: 'a2', name: 'Account 2', hdIndex: 1, address: ADDR_2 }),
];

const realActions = {
  switchWallet: state().switchWallet,
  loadWallets: state().loadWallets,
  unlock: state().unlock,
};

function seed(wallets: WalletSummary[], activeWalletId: string) {
  useLiveStore.setState({
    wallets,
    activeWalletId,
    phase: 'locked',
    error: null,
    // Never let a test hit the real implementations: this screen's job is to
    // CALL them with the right id, not to run a wallet switch.
    switchWallet: vi.fn(async () => {}),
    loadWallets: vi.fn(async () => {}),
    unlock: vi.fn(async () => true),
  });
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

afterEach(() => {
  useLiveStore.setState({ ...realActions, wallets: [], activeWalletId: null, error: null });
  cleanup();
});

describe('LiveLock password view', () => {
  it('names the ONE wallet being unlocked and keeps the list off this view', () => {
    seed(THREE_WALLETS, 'w-utxo');
    render(<LiveLock />);

    const card = screen.getByTestId('live-lock-selected');
    expect(card).toHaveTextContent('My Evrmore');
    // Identity at a glance: short address + type + chain chips.
    expect(card).toHaveTextContent('EXfUwz…uGqU');
    expect(card).toHaveTextContent('Seed');
    expect(screen.getByTestId('live-lock-selected-chain')).toHaveTextContent('EVR');
    // The password field is here, the wallet list is NOT.
    expect(screen.getByTestId('live-unlock')).toBeTruthy();
    expect(screen.queryByTestId('live-lock-wallets')).toBeNull();
    expect(screen.queryByTestId('live-lock-wallet-0')).toBeNull();
    // Creating/importing stays on this view.
    expect(screen.getByTestId('live-lock-create')).toBeTruthy();
  });

  it('names an EVM account by BOTH its seed and its account number', () => {
    seed(THREE_WALLETS, 'a2');
    render(<LiveLock />);

    const card = screen.getByTestId('live-lock-selected');
    expect(card).toHaveTextContent('My EVM · Account 2');
    expect(card).toHaveTextContent('0x6Fac…b9C0');
    expect(screen.getByTestId('live-lock-selected-chain')).toHaveTextContent('EVM');
  });

  it('hides "Change" when there is nothing to change to (one wallet)', () => {
    seed([UTXO_WALLET], 'w-utxo');
    render(<LiveLock />);

    // The card still shows — it names what the password below opens.
    expect(screen.getByTestId('live-lock-selected')).toHaveTextContent('My Evrmore');
    expect(screen.queryByTestId('live-lock-change')).toBeNull();
    expect(screen.getByTestId('live-unlock')).toBeTruthy();
  });
});

describe('LiveLock wallet list view', () => {
  it('"Change" opens the full list, grouped by seed, with the active wallet pressed', () => {
    seed(THREE_WALLETS, 'w-utxo');
    render(<LiveLock />);

    fireEvent.click(screen.getByTestId('live-lock-change'));

    expect(screen.getByTestId('live-lock-wallets')).toBeTruthy();
    // The UTXO wallet is a row; the seed is ONE row too (collapsed): unlocking
    // any of its accounts unlocks them all, so the list stays one-row-per-seed.
    expect(screen.getAllByTestId(/^live-lock-wallet-\d+$/)).toHaveLength(1);
    const group = screen.getByTestId('live-lock-group-1');
    expect(group).toHaveTextContent('My EVM');
    expect(group).toHaveTextContent('2 accounts');
    // It names the account it unlocks (the first, since the active wallet is the UTXO one).
    expect(screen.getByTestId('live-lock-group-sub-1')).toHaveTextContent('2 accounts · unlocks Account 1');
    expect(group).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('live-lock-wallet-0')).toHaveAttribute('aria-pressed', 'true');
    // The chevron expands the accounts for a specific pick.
    fireEvent.click(screen.getByTestId('live-lock-group-toggle-1'));
    expect(screen.getAllByTestId(/^live-lock-wallet-\d+$/)).toHaveLength(3);
    expect(screen.getByTestId('live-lock-wallet-2')).toHaveTextContent('Account 2');
    expect(screen.getByTestId('live-lock-wallet-1')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('live-lock-group-toggle-1'));
    expect(screen.getAllByTestId(/^live-lock-wallet-\d+$/)).toHaveLength(1);
    // The password field belongs to the other view.
    expect(screen.queryByTestId('live-unlock')).toBeNull();
  });

  it('picking the seed row unlocks its active account when one is active, else its first account', async () => {
    seed(THREE_WALLETS, 'a2');
    render(<LiveLock />);
    fireEvent.click(screen.getByTestId('live-lock-change'));
    const group = screen.getByTestId('live-lock-group-1');
    expect(group).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('live-lock-group-sub-1')).toHaveTextContent('2 accounts · unlocks Account 2');
    // Already the active account: no switch, back to the password view.
    fireEvent.click(group);
    expect(state().switchWallet).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('live-lock-wallets')).toBeNull());

    cleanup();
    seed(THREE_WALLETS, 'w-utxo');
    render(<LiveLock />);
    fireEvent.click(screen.getByTestId('live-lock-change'));
    fireEvent.click(screen.getByTestId('live-lock-group-1'));
    expect(state().switchWallet).toHaveBeenCalledWith('a1');
  });

  it('picking a wallet switches the store and returns to the password view', async () => {
    seed(THREE_WALLETS, 'w-utxo');
    render(<LiveLock />);

    fireEvent.click(screen.getByTestId('live-lock-change'));
    fireEvent.click(screen.getByTestId('live-lock-group-toggle-1'));
    fireEvent.click(screen.getByTestId('live-lock-wallet-2'));

    expect(state().switchWallet).toHaveBeenCalledWith('a2');
    await waitFor(() => {
      expect(screen.queryByTestId('live-lock-wallets')).toBeNull();
    });
    expect(screen.getByTestId('live-unlock')).toBeTruthy();
  });

  it('Back and Escape both return to the password view without switching', async () => {
    seed(THREE_WALLETS, 'w-utxo');
    render(<LiveLock />);

    fireEvent.click(screen.getByTestId('live-lock-change'));
    fireEvent.click(screen.getByTestId('live-lock-wallets-back'));
    await waitFor(() => expect(screen.getByTestId('live-unlock')).toBeTruthy());

    fireEvent.click(screen.getByTestId('live-lock-change'));
    expect(screen.getByTestId('live-lock-wallets')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('live-unlock')).toBeTruthy());

    expect(state().switchWallet).not.toHaveBeenCalled();
  });
});
