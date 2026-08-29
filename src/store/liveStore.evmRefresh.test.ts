// The FAMILY-FIRST branch of liveStore.refresh(): an EVM account is read over
// JSON-RPC (evmBalances.ts), never over Electrum, and history is left alone
// until phase 4. A UTXO wallet (family absent or 'utxo') must never touch the
// EVM path. The real LiveWalletService is mocked (no WebSocket), evmBalances is
// mocked so this test pins the STORE's behaviour only; the EVM read path itself
// is covered by evmBalances.test.ts against fake fetch.

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
  refreshEvmWallet: vi.fn(),
  refreshEvmHistory: vi.fn(),
  family: 'evm' as 'evm' | 'utxo',
  evmChainKey: 'base' as string | null,
}));

vi.mock('../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    allowBroadcast = false;
    getProvider() {
      return hoisted.provider;
    }
    activeWalletId() {
      return 'w-evm';
    }
    isUnlocked() {
      return true;
    }
    network() {
      return 'mainnet';
    }
    activeWalletFamily() {
      return hoisted.family;
    }
    evmChainKey() {
      return hoisted.family === 'evm' ? hoisted.evmChainKey : null;
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

vi.mock('./evmBalances', () => ({
  refreshEvmWallet: hoisted.refreshEvmWallet,
}));

vi.mock('./evmHistory', () => ({
  refreshEvmHistory: hoisted.refreshEvmHistory,
}));

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { WalletSummary } from '../services/chain/liveWallet';
import type { NetworkStatus } from '../types/domain';

const EVM_ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const UTXO_ADDR = 'Ebalancefirst00000000000000000000';

const evmWallet: WalletSummary = {
  id: 'w-evm',
  name: 'EVM account',
  network: '',
  createdAt: 1,
  active: true,
  kind: 'seed',
  address: EVM_ADDR,
  passwordless: false,
  family: 'evm',
  evmChainKey: 'base',
};

const utxoWallet: WalletSummary = {
  id: 'w-evm', // same id on purpose: only the family differs between the two runs
  name: 'Wallet 1',
  network: 'mainnet',
  createdAt: 1,
  active: true,
  kind: 'seed',
  address: UTXO_ADDR,
  passwordless: false,
  family: 'utxo',
};

const baseConnected: NetworkStatus = {
  networkId: 'mainnet',
  state: 'connected',
  latencyMs: 40,
  blockHeight: 34_000_000,
  serverVersion: 'json-rpc',
  updatedAt: 1_700_000_000_000,
  tipTime: 1_700_000_000_000,
};

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
  indexer: { family: 'blockscout' as const, baseUrl: 'https://base.blockscout.com/api' },
  alchemy: false,
  trustWalletChain: null,
  tokenListSlug: null,
  defaultTokens: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  hoisted.family = 'evm';
  hoisted.evmChainKey = 'base';
  hoisted.refreshEvmHistory.mockResolvedValue(null);
  setStorageForTests(new MemoryStorageAdapter());
  useLiveStore.setState({ evm: { chains: [BASE_INFO], activeChainKey: 'base' }, historyIssue: null });
});

afterEach(() => {
  useLiveStore.setState({
    address: '',
    addresses: [],
    txs: [],
    assets: [],
    wallets: [],
    activeWalletId: null,
    offline: false,
    network: null,
    loadingRefresh: false,
  });
});

describe('liveStore.refresh: family-first EVM branch', () => {
  it('1. an EVM wallet is read through refreshEvmWallet with its chain key, and Electrum is never asked', async () => {
    useLiveStore.setState({
      phase: 'ready',
      address: EVM_ADDR,
      addresses: [{ index: 0, address: EVM_ADDR }],
      wallets: [evmWallet],
      activeWalletId: 'w-evm',
      txs: [],
      assets: [],
    });
    const assets = [
      { name: 'ETH', amountBase: 1_000_000_000_000_000n, scale: 18, decimals: 18, isNative: true },
      { name: 'USDC', amountBase: 12_340_000n, scale: 6, decimals: 6, isNative: false },
    ];
    hoisted.refreshEvmWallet.mockResolvedValue({ network: baseConnected, assets });

    await useLiveStore.getState().refresh();

    expect(hoisted.refreshEvmWallet).toHaveBeenCalledTimes(1);
    expect(hoisted.refreshEvmWallet).toHaveBeenCalledWith(EVM_ADDR, 'base', []);
    expect(hoisted.provider.getAllAssetBalances).not.toHaveBeenCalled();
    expect(hoisted.provider.getNetworkStatus).not.toHaveBeenCalled();
    expect(hoisted.provider.getAddressHistory).not.toHaveBeenCalled();
    const s = useLiveStore.getState();
    expect(s.assets).toEqual(assets);
    expect(s.network).toEqual(baseConnected);
    expect(s.offline).toBe(false);
    expect(s.loadingRefresh).toBe(false);
    // History is phase 4: nothing was written to txs.
    expect(s.txs).toEqual([]);
  });

  it('2. RPC unavailable: offline is set, previous assets are kept', async () => {
    const previous = [{ name: 'ETH', amountBase: 5n, scale: 18, decimals: 18, isNative: true }];
    useLiveStore.setState({
      phase: 'ready',
      address: EVM_ADDR,
      addresses: [{ index: 0, address: EVM_ADDR }],
      wallets: [evmWallet],
      activeWalletId: 'w-evm',
      assets: previous,
    });
    hoisted.refreshEvmWallet.mockResolvedValue({
      network: { ...baseConnected, state: 'offline' },
      assets: null,
    });

    await useLiveStore.getState().refresh();

    const s = useLiveStore.getState();
    expect(s.offline).toBe(true);
    expect(s.assets).toEqual(previous);
  });

  it('3. a build without the EVM engine (refreshEvmWallet -> null) reads as offline and touches nothing else', async () => {
    useLiveStore.setState({
      phase: 'ready',
      address: EVM_ADDR,
      addresses: [{ index: 0, address: EVM_ADDR }],
      wallets: [evmWallet],
      activeWalletId: 'w-evm',
      assets: [],
      network: null,
    });
    hoisted.refreshEvmWallet.mockResolvedValue(null);

    await useLiveStore.getState().refresh();

    const s = useLiveStore.getState();
    expect(s.offline).toBe(true);
    expect(s.assets).toEqual([]);
    expect(s.network).toBe(null);
    expect(hoisted.provider.getAllAssetBalances).not.toHaveBeenCalled();
  });

  it('4. a wallet switch mid-flight is discarded (the new wallet keeps its own state)', async () => {
    useLiveStore.setState({
      phase: 'ready',
      address: EVM_ADDR,
      addresses: [{ index: 0, address: EVM_ADDR }],
      wallets: [evmWallet],
      activeWalletId: 'w-evm',
      assets: [],
    });
    hoisted.refreshEvmWallet.mockImplementation(async () => {
      // The user switched wallets while the RPC round trip was in flight.
      useLiveStore.setState({ address: UTXO_ADDR, wallets: [utxoWallet] });
      return { network: baseConnected, assets: [{ name: 'ETH', amountBase: 1n, scale: 18, decimals: 18, isNative: true }] };
    });

    await useLiveStore.getState().refresh();

    expect(useLiveStore.getState().assets).toEqual([]);
    expect(useLiveStore.getState().network).toBe(null);
  });

  it('5. a UTXO wallet (family utxo) never enters the EVM path', async () => {
    hoisted.family = 'utxo';
    useLiveStore.setState({
      phase: 'ready',
      address: UTXO_ADDR,
      addresses: [{ index: 0, address: UTXO_ADDR }],
      wallets: [utxoWallet],
      activeWalletId: 'w-evm',
      txs: [],
      assets: [],
    });
    hoisted.provider.getNetworkStatus.mockResolvedValue({ ...baseConnected, serverVersion: 'ElectrumX' });
    hoisted.provider.getAllAssetBalances.mockResolvedValue([
      { name: 'EVR', amountBase: 1250000000n, scale: 8, decimals: 8, isNative: true },
    ]);
    hoisted.provider.getAddressHistory.mockResolvedValue([]);

    await useLiveStore.getState().refresh();

    expect(hoisted.refreshEvmWallet).not.toHaveBeenCalled();
    expect(hoisted.provider.getAllAssetBalances).toHaveBeenCalledWith(UTXO_ADDR);
    expect(useLiveStore.getState().assets[0]?.name).toBe('EVR');
  });

  it('6. a wallet whose summary carries no family (pre-EVM data) is utxo', async () => {
    hoisted.family = 'utxo';
    const legacy = { ...utxoWallet } as Partial<WalletSummary>;
    delete legacy.family;
    useLiveStore.setState({
      phase: 'ready',
      address: UTXO_ADDR,
      addresses: [{ index: 0, address: UTXO_ADDR }],
      wallets: [legacy as WalletSummary],
      activeWalletId: 'w-evm',
      assets: [],
    });
    hoisted.provider.getNetworkStatus.mockResolvedValue({ ...baseConnected, serverVersion: 'ElectrumX' });
    hoisted.provider.getAllAssetBalances.mockResolvedValue([]);
    hoisted.provider.getAddressHistory.mockResolvedValue([]);

    await useLiveStore.getState().refresh();

    expect(hoisted.refreshEvmWallet).not.toHaveBeenCalled();
    expect(hoisted.provider.getAllAssetBalances).toHaveBeenCalledTimes(1);
  });

  it('7. history (phase 4): indexer rows land in txs (local pending on top), and the honest issue is surfaced', async () => {
    useLiveStore.setState({
      phase: 'ready',
      address: EVM_ADDR,
      addresses: [{ index: 0, address: EVM_ADDR }],
      wallets: [evmWallet],
      activeWalletId: 'w-evm',
      txs: [],
      assets: [],
      activitySeen: { height: 0, txids: [] },
    });
    hoisted.refreshEvmWallet.mockResolvedValue({ network: baseConnected, assets: [] });
    const row = {
      txid: '0x' + '11'.repeat(32),
      asset: 'ETH',
      direction: 'in' as const,
      amount: 0.5,
      feeEvr: 0,
      status: 'confirmed' as const,
      blockHeight: 50_000_001,
      timestamp: 1_725_000_100_000,
      counterparty: '0x3535353535353535353535353535353535353535',
    };
    hoisted.refreshEvmHistory.mockResolvedValue({ txs: [row], issue: null, tokensSeen: [] });

    await useLiveStore.getState().refresh();
    await new Promise((r) => setTimeout(r, 10)); // the history read is detached

    expect(hoisted.refreshEvmHistory).toHaveBeenCalledWith(BASE_INFO, EVM_ADDR, 34_000_000);
    expect(useLiveStore.getState().txs).toEqual([row]);
    expect(useLiveStore.getState().historyIssue).toBe(null);

    // A chain without an indexer / a refusing one: keep the rows, show the issue.
    hoisted.refreshEvmHistory.mockResolvedValue({ txs: null, issue: { message: 'Activity may be incomplete: rate-limited', detail: 'Max rate limit reached' }, tokensSeen: [] });
    await useLiveStore.getState().refresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(useLiveStore.getState().txs).toEqual([row]);
    expect(useLiveStore.getState().historyIssue).toEqual({
      address: EVM_ADDR,
      message: 'Activity may be incomplete: rate-limited',
      serverMessage: 'Max rate limit reached',
    });
  });
});
