// Store side of gap-limit receive-address discovery (KNOWN_LIMITATIONS item 15).
//
// The scan itself is the service's job and is pinned in
// services/chain/liveWallet.gapScan.test.ts. What these tests pin is the STORE
// contract a UI depends on: the loading flag, the live progress counter, the
// result shape ("found N more addresses" vs "nothing found"), that a scan which
// found nothing costs no extra network reads, that two scans cannot overlap, and
// that an import auto-scans exactly once while a create never does.
//
// The real LiveWalletService is mocked (as in liveStoreRefresh.test.ts) so the
// scan's outcome can be scripted; storage is the in-memory adapter, so no
// WebSocket or chrome.storage is touched.

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
  discoverUsedAddresses: vi.fn(),
  listAddresses: vi.fn(),
  importSeed: vi.fn(),
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
    discoverUsedAddresses(...args: unknown[]) {
      return hoisted.discoverUsedAddresses(...args);
    }
    import(...args: unknown[]) {
      return hoisted.importSeed(...args);
    }
    create(...args: unknown[]) {
      return hoisted.create(...args);
    }
    lock() {}
  }
  // liveStore reads the cap for its "address limit reached" copy, so the mocked
  // module has to carry it too.
  return { LiveWalletService, BroadcastGatedError, MAX_RECEIVE_ADDRESSES: 100 };
});

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { NetworkStatus } from '../types/domain';

const ADDR = 'Escanprimary000000000000000000000';
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const netConnected: NetworkStatus = {
  networkId: 'mainnet',
  state: 'connected',
  latencyMs: 5,
  blockHeight: 100,
  serverVersion: 'ElectrumX Evrmore',
  updatedAt: 1_700_000_000_000,
};

/** A full AddressScanResult with sensible defaults, overridable per test. */
function scanResult(over: Partial<{
  scanned: number;
  highestUsedIndex: number;
  addressCountBefore: number;
  addressCountAfter: number;
  failedReads: number;
  complete: boolean;
}>) {
  return {
    scanned: 20,
    highestUsedIndex: -1,
    addressCountBefore: 1,
    addressCountAfter: 1,
    failedReads: 0,
    complete: true,
    ...over,
  };
}

function addressList(n: number) {
  return Array.from({ length: n }, (_, i) => ({ index: i, address: `${ADDR}-${i}` }));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const state = () => useLiveStore.getState();

beforeEach(() => {
  vi.resetAllMocks();
  setStorageForTests(new MemoryStorageAdapter());
  hoisted.provider.getNetworkStatus.mockResolvedValue(netConnected);
  hoisted.provider.getAllAssetBalances.mockResolvedValue([]);
  hoisted.provider.getAddressHistory.mockResolvedValue([]);
  useLiveStore.setState({
    phase: 'ready',
    address: ADDR,
    addresses: [{ index: 0, address: ADDR }],
    assets: [],
    txs: [],
    addressScan: { scanning: false, scanned: 0, result: null, error: null },
  });
});

afterEach(() => {
  useLiveStore.setState({
    address: '',
    addresses: [],
    txs: [],
    assets: [],
    addressScan: { scanning: false, scanned: 0, result: null, error: null },
  });
});

describe('liveStore.scanForUsedAddresses', () => {
  it('reports how many addresses it found and reloads them', async () => {
    hoisted.discoverUsedAddresses.mockResolvedValue(
      scanResult({ scanned: 26, highestUsedIndex: 5, addressCountAfter: 6 }),
    );
    hoisted.listAddresses.mockResolvedValue(addressList(6));

    const res = await state().scanForUsedAddresses();

    expect(res).toEqual({ ok: true, found: 5 });
    const s = state();
    expect(s.addressScan.scanning).toBe(false);
    expect(s.addressScan.error).toBeNull();
    expect(s.addressScan.result).toEqual({
      found: 5,
      addressCount: 6,
      complete: true,
      failedReads: 0,
    });
    // The newly covered addresses are on screen, and their balances were fetched.
    expect(s.addresses.length).toBe(6);
    await vi.waitFor(() => expect(hoisted.provider.getAllAssetBalances).toHaveBeenCalled());
  });

  it('reports "nothing found" without spending a single extra network read', async () => {
    // Nothing grew, so the wallet derives exactly the addresses it already had:
    // re-reading them would be pure load on the server for no new information.
    hoisted.discoverUsedAddresses.mockResolvedValue(scanResult({ highestUsedIndex: 0 }));

    const res = await state().scanForUsedAddresses();

    expect(res).toEqual({ ok: true, found: 0 });
    expect(state().addressScan.result).toEqual({
      found: 0,
      addressCount: 1,
      complete: true,
      failedReads: 0,
    });
    expect(hoisted.listAddresses).not.toHaveBeenCalled();
    expect(hoisted.provider.getAllAssetBalances).not.toHaveBeenCalled();
  });

  it('exposes live progress while the scan runs', async () => {
    const gate = deferred<ReturnType<typeof scanResult>>();
    hoisted.discoverUsedAddresses.mockImplementation(
      (opts: { onProgress?: (p: { scanned: number; highestUsedIndex: number }) => void }) => {
        opts.onProgress?.({ scanned: 1, highestUsedIndex: 0 });
        opts.onProgress?.({ scanned: 7, highestUsedIndex: 0 });
        return gate.promise;
      },
    );

    const pending = state().scanForUsedAddresses();
    await vi.waitFor(() => expect(state().addressScan.scanned).toBe(7));
    expect(state().addressScan.scanning).toBe(true);
    expect(state().addressScan.result).toBeNull();

    gate.resolve(scanResult({ scanned: 21, highestUsedIndex: 0 }));
    await pending;
    expect(state().addressScan.scanning).toBe(false);
    expect(state().addressScan.scanned).toBe(21);
  });

  it('surfaces a PARTIAL result so the UI can say the answer is a lower bound', async () => {
    hoisted.discoverUsedAddresses.mockResolvedValue(
      scanResult({ scanned: 42, highestUsedIndex: -1, failedReads: 3, complete: false }),
    );

    await state().scanForUsedAddresses();

    expect(state().addressScan.result).toEqual({
      found: 0,
      addressCount: 1,
      complete: false,
      failedReads: 3,
    });
  });

  it('fails cleanly on a locked wallet and never leaves the flag stuck', async () => {
    hoisted.discoverUsedAddresses.mockRejectedValue(new Error('Live wallet is locked'));

    const res = await state().scanForUsedAddresses();

    expect(res).toEqual({ ok: false, error: 'Unlock this wallet before scanning.' });
    expect(state().addressScan.scanning).toBe(false);
    expect(state().addressScan.error).toBe('Unlock this wallet before scanning.');
    expect(state().addressScan.result).toBeNull();
  });

  it('refuses a second scan while one is running', async () => {
    const gate = deferred<ReturnType<typeof scanResult>>();
    hoisted.discoverUsedAddresses.mockReturnValue(gate.promise);

    const first = state().scanForUsedAddresses();
    const second = await state().scanForUsedAddresses();

    expect(second.ok).toBe(false);
    expect(hoisted.discoverUsedAddresses).toHaveBeenCalledTimes(1);

    gate.resolve(scanResult({}));
    await first;
  });
});

describe('liveStore — when the scan runs by itself', () => {
  it('scans ONCE after a seed IMPORT (the case the limitation describes)', async () => {
    hoisted.importSeed.mockResolvedValue(undefined);
    hoisted.listAddresses.mockResolvedValue(addressList(1));
    hoisted.discoverUsedAddresses.mockResolvedValue(scanResult({ highestUsedIndex: 0 }));

    await state().importWallet(VECTOR_MNEMONIC, 'pw');

    await vi.waitFor(() => expect(hoisted.discoverUsedAddresses).toHaveBeenCalledTimes(1));
  });

  it('does NOT scan after CREATE — a freshly generated seed has no history to find', async () => {
    hoisted.create.mockResolvedValue({ mnemonic: VECTOR_MNEMONIC });
    hoisted.listAddresses.mockResolvedValue(addressList(1));

    await state().createWallet('pw');
    // Let the fire-and-forget loadAddresses -> refresh chain settle.
    await vi.waitFor(() => expect(hoisted.provider.getAllAssetBalances).toHaveBeenCalled());

    expect(hoisted.discoverUsedAddresses).not.toHaveBeenCalled();
  });
});
