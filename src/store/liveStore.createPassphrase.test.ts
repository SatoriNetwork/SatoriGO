// Store side of "set a BIP39 passphrase when CREATING a wallet"
// (KNOWN_LIMITATIONS item 16).
//
// The derivation itself is the service's job and is pinned in
// services/chain/liveWallet.createPassphrase.test.ts. What these tests pin is
// the wiring the form depends on: that createWallet's trailing `passphrase`
// reaches svc.create() as the SAME option the import path uses, that a create
// without one hands the service the exact options object it got before this
// existed, and that the backup screen is told which kind of wallet it is about
// to call "the ONLY backup".
//
// The real LiveWalletService is mocked (as in liveStore.addressScan.test.ts) so
// no scrypt vault is built; storage is the in-memory adapter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  provider: {
    getNetworkStatus: vi.fn(),
    getAllAssetBalances: vi.fn(),
    getAddressHistory: vi.fn(),
    classifyTxHash: vi.fn(),
    getAssetMeta: vi.fn(),
    getAssetBalance: vi.fn(),
  },
  listAddresses: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    allowBroadcast = false;
    getProvider() {
      return hoisted.provider;
    }
    activeWalletId() {
      return 'w1';
    }
    isUnlocked() {
      return true;
    }
    network() {
      return 'mainnet';
    }
    getAddress() {
      return ADDR;
    }
    async listWallets() {
      return [];
    }
    listAddresses(...args: unknown[]) {
      return hoisted.listAddresses(...args);
    }
    create(...args: unknown[]) {
      return hoisted.create(...args);
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError, MAX_RECEIVE_ADDRESSES: 100 };
});

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { NetworkStatus } from '../types/domain';

const ADDR = 'Ecreateprimary0000000000000000000';
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'correct horse battery staple';

const netConnected: NetworkStatus = {
  networkId: 'mainnet',
  state: 'connected',
  latencyMs: 5,
  blockHeight: 100,
  serverVersion: 'ElectrumX Evrmore',
  updatedAt: 1_700_000_000_000,
};

const state = () => useLiveStore.getState();

/** The options object svc.create() was handed on its only call. */
function createOptions(): Record<string, unknown> {
  expect(hoisted.create).toHaveBeenCalledTimes(1);
  return hoisted.create.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetAllMocks();
  setStorageForTests(new MemoryStorageAdapter());
  hoisted.provider.getNetworkStatus.mockResolvedValue(netConnected);
  hoisted.provider.getAllAssetBalances.mockResolvedValue([]);
  hoisted.provider.getAddressHistory.mockResolvedValue([]);
  hoisted.listAddresses.mockResolvedValue([{ index: 0, address: ADDR }]);
  hoisted.create.mockResolvedValue({ mnemonic: VECTOR_MNEMONIC });
  useLiveStore.setState({ phase: 'onboarding', pendingMnemonic: null, pendingMnemonicHasPassphrase: false });
});

afterEach(() => {
  useLiveStore.setState({ pendingMnemonic: null, pendingMnemonicHasPassphrase: false });
});

describe('liveStore.createWallet — BIP39 passphrase', () => {
  it('omits the passphrase option entirely when none was given', async () => {
    // Not "passes an empty string": ABSENT. Every wallet in the field was made
    // by this call, so the safest shape is the one that cannot have changed.
    await state().createWallet('pw', 'Savings');

    expect(createOptions()).toEqual({ network: 'mainnet', name: 'Savings' });
    expect('passphrase' in createOptions()).toBe(false);
    expect(state().pendingMnemonicHasPassphrase).toBe(false);
  });

  it('omits it for an empty string too, which is what the form sends when the opt-in is off', async () => {
    await state().createWallet('pw', undefined, 'mainnet', '');
    expect(createOptions()).toEqual({ network: 'mainnet' });
    expect(state().pendingMnemonicHasPassphrase).toBe(false);
  });

  it('forwards a passphrase as the same option the import path uses', async () => {
    await state().createWallet('pw', 'Deep storage', 'bitcoin-mainnet', PASSPHRASE);

    expect(createOptions()).toEqual({
      network: 'bitcoin-mainnet',
      name: 'Deep storage',
      passphrase: PASSPHRASE,
    });
  });

  it('flags the pending phrase so the backup screen stops calling it the only backup', async () => {
    await state().createWallet('pw', undefined, 'mainnet', PASSPHRASE);

    expect(state().pendingMnemonic).toBe(VECTOR_MNEMONIC);
    expect(state().pendingMnemonicHasPassphrase).toBe(true);

    // Cleared with the phrase it describes, so it can never be read as stale
    // truth about the NEXT wallet.
    state().clearPendingMnemonic();
    expect(state().pendingMnemonic).toBeNull();
    expect(state().pendingMnemonicHasPassphrase).toBe(false);
  });
});
