/**
 * @vitest-environment jsdom
 *
 * The EVM row on the onboarding chain picker (phase 3): absent when this
 * build carries no EVM chains (evm.chains is empty, exactly like a package
 * built without --evm), offered once the store has loaded them, and the
 * store action receives the `evm:<key>` target unchanged, same as it already
 * receives a UTXO LiveNetworkId.
 *
 * The store action is replaced with a spy, same pattern as
 * LiveOnboarding.createPassphrase.test.tsx, so this asserts what the FORM
 * does without building a real scrypt vault or an EVM key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    async exists() {
      return false;
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
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { LiveOnboarding } from './LiveOnboarding';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

const EVM_CHAINS = [
  {
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
    defaultTokens: [],
  },
];

let createSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  createSpy = vi.fn(async () => {});
  useLiveStore.setState({
    createWallet: createSpy,
    pendingMnemonic: null,
    pendingMnemonicHasPassphrase: false,
    addingWallet: false,
    error: null,
    evm: { chains: [], activeChainKey: null },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function byId(id: string): HTMLElement {
  return screen.getByTestId(id);
}

function openCreateForm() {
  render(<LiveOnboarding />);
  fireEvent.click(screen.getByText('Create new wallet'));
  return byId('live-create');
}

function fillPassword() {
  fireEvent.change(byId('live-password'), { target: { value: 'password123' } });
  fireEvent.change(byId('live-password-confirm'), { target: { value: 'password123' } });
}

describe('create form: the EVM chain row', () => {
  it('is absent from the picker when this build carries no EVM chains', () => {
    openCreateForm();
    expect(screen.queryByTestId('live-create-chain-evm:base')).toBeNull();
  });

  it('appears once evm.chains is loaded, and choosing it creates on the evm:<key> target', () => {
    useLiveStore.setState({ evm: { chains: EVM_CHAINS, activeChainKey: null } });
    openCreateForm();

    const baseOption = byId('live-create-chain-evm:base');
    expect(baseOption).toHaveTextContent('Base');
    fireEvent.click(baseOption);
    expect(baseOption.getAttribute('aria-pressed')).toBe('true');

    // Selecting it surfaces the one-EVM-account note, not the Ravencoin
    // shared-derivation privacy note.
    expect(byId('live-create-chain-evm-note').textContent).toMatch(/one evm account works on every evm chain/i);
    expect(screen.queryByTestId('live-create-chain-privacy-note')).toBeNull();

    fireEvent.change(byId('live-wallet-name'), { target: { value: 'My Base wallet' } });
    fillPassword();
    fireEvent.click(byId('live-create-submit'));

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith('password123', 'My Base wallet', 'evm:base', '');
  });
});
