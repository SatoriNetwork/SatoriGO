// "Sometimes only the one main coin loads" (owner, live testing 2026-08-25),
// at the level of the store that produced it.
//
// Reproduced live on 2026-08-25 against the real gateway: with the popup open,
// eight token rows; a fresh popup opened while the gateway answered HTTP 429
// showed exactly one row, the native coin. Two things caused that and both are
// pinned here:
//
//   1. The popup is a new page every time, so `assets` started EMPTY and the
//      refresh path's "keep what we had" fallbacks kept nothing.
//   2. A PARTIAL read (the native balance answered, a token's balanceOf did
//      not) was committed as if it were the whole list, so a token that simply
//      failed to answer read as a token that is gone.
//
// The rule, both ways round: a failed or partial read never blanks a token the
// wallet already knew about; a COMPLETE read that no longer reports one does.

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
  readEvmDiscoveredBalances: vi.fn(),
  refreshEvmHistory: vi.fn(),
  family: 'evm' as 'evm' | 'utxo',
  evmChainKey: 'base' as string,
}));

vi.mock('../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    allowBroadcast = false;
    getProvider() {
      return hoisted.provider;
    }
    activeWalletId() {
      return 'w-1';
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
  readEvmDiscoveredBalances: hoisted.readEvmDiscoveredBalances,
  evmProviderFor: vi.fn(async () => null),
}));

vi.mock('./evmHistory', () => ({
  refreshEvmHistory: hoisted.refreshEvmHistory,
}));

import { useLiveStore } from './liveStore';
import { loadBalanceCache, saveBalanceCache } from './balanceCache';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { WalletSummary } from '../services/chain/liveWallet';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';
import type { NetworkStatus } from '../types/domain';

const EVM_ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const UTXO_ADDR = 'EbalanceCache0000000000000000000';

const evmWallet: WalletSummary = {
  id: 'w-1',
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
  id: 'w-1',
  name: 'Wallet 1',
  network: 'mainnet',
  createdAt: 1,
  active: true,
  kind: 'seed',
  address: UTXO_ADDR,
  passwordless: false,
  family: 'utxo',
};

const connected: NetworkStatus = {
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
  indexer: null,
  alchemy: false,
  trustWalletChain: null,
  tokenListSlug: null,
  defaultTokens: [],
};

const eth = (amount: bigint): LiveAssetBalance => ({ name: 'ETH', amountBase: amount, scale: 18, decimals: 18, isNative: true });
const usdc = (amount: bigint): LiveAssetBalance => ({ name: 'USDC', amountBase: amount, scale: 6, decimals: 6, isNative: false });
const weth = (amount: bigint): LiveAssetBalance => ({ name: 'WETH', amountBase: amount, scale: 18, decimals: 18, isNative: false });

/** A popup that has just opened: no rows in memory, whatever is on disk. */
function coldEvmPopup() {
  useLiveStore.setState({
    phase: 'ready',
    address: EVM_ADDR,
    addresses: [{ index: 0, address: EVM_ADDR }],
    wallets: [evmWallet],
    activeWalletId: 'w-1',
    txs: [],
    assets: [],
    offline: false,
  });
}

/** The cache read is detached (it must never gate the network read). */
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  vi.resetAllMocks();
  hoisted.family = 'evm';
  hoisted.evmChainKey = 'base';
  hoisted.refreshEvmHistory.mockResolvedValue(null);
  hoisted.readEvmDiscoveredBalances.mockResolvedValue({ rows: [], complete: true });
  setStorageForTests(new MemoryStorageAdapter());
  useLiveStore.setState({
    evm: { chains: [BASE_INFO], activeChainKey: 'base' },
    evmTokens: { tracked: [], discovered: [] },
    historyIssue: null,
  });
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

describe('a fresh popup with no network', () => {
  it('shows the tokens it last knew instead of collapsing to the native coin', async () => {
    const known = [eth(5n), usdc(120n), weth(3n)];
    await saveBalanceCache('evm:base', EVM_ADDR, known);
    coldEvmPopup();
    // The gateway rate-limited the opening burst: nothing came back.
    hoisted.refreshEvmWallet.mockResolvedValue({
      network: { ...connected, state: 'offline' },
      assets: null,
      complete: false,
    });

    await useLiveStore.getState().refresh();
    await settle();

    const s = useLiveStore.getState();
    expect(s.assets.map((a) => a.name)).toEqual(['ETH', 'USDC', 'WETH']);
    // ...and the wallet still says plainly that it could not reach the chain.
    expect(s.offline).toBe(true);
  });

  it('the saved rows never overwrite a read that already landed', async () => {
    await saveBalanceCache('evm:base', EVM_ADDR, [eth(5n), usdc(999n)]);
    coldEvmPopup();
    hoisted.refreshEvmWallet.mockResolvedValue({ network: connected, assets: [eth(7n)], complete: true });

    await useLiveStore.getState().refresh();
    await settle();

    // The complete read said there is only ETH now, and it wins.
    expect(useLiveStore.getState().assets).toEqual([eth(7n)]);
  });

  it('saves what a successful read produced, so the NEXT cold open has it', async () => {
    coldEvmPopup();
    hoisted.refreshEvmWallet.mockResolvedValue({ network: connected, assets: [eth(7n), usdc(42n)], complete: true });

    await useLiveStore.getState().refresh();
    await settle();

    const saved = await loadBalanceCache('evm:base', EVM_ADDR);
    expect(saved?.rows).toEqual([eth(7n), usdc(42n)]);
  });

  it('does not save a list that came only from the cache (a failed read rewrites nothing)', async () => {
    await saveBalanceCache('evm:base', EVM_ADDR, [eth(5n), usdc(120n)]);
    const before = await loadBalanceCache('evm:base', EVM_ADDR);
    coldEvmPopup();
    hoisted.refreshEvmWallet.mockResolvedValue({ network: { ...connected, state: 'offline' }, assets: null, complete: false });

    await useLiveStore.getState().refresh();
    await settle();

    const after = await loadBalanceCache('evm:base', EVM_ADDR);
    expect(after?.fetchedAt).toBe(before?.fetchedAt);
  });
});

describe('a partial read', () => {
  it('keeps the token whose balance did not answer, at its last known figure', async () => {
    useLiveStore.setState({
      phase: 'ready',
      address: EVM_ADDR,
      addresses: [{ index: 0, address: EVM_ADDR }],
      wallets: [evmWallet],
      activeWalletId: 'w-1',
      assets: [eth(5n), usdc(120n), weth(3n)],
    });
    // The native balance answered; both token calls did not.
    hoisted.refreshEvmWallet.mockResolvedValue({ network: connected, assets: [eth(6n)], complete: false });

    await useLiveStore.getState().refresh();
    await settle();

    const s = useLiveStore.getState();
    expect(s.assets.map((a) => a.name)).toEqual(['ETH', 'USDC', 'WETH']);
    expect(s.assets[0].amountBase).toBe(6n);
    expect(s.assets[1].amountBase).toBe(120n);
  });

  it('a failed DISCOVERED-token read alone is enough to make the read partial', async () => {
    useLiveStore.setState({
      phase: 'ready',
      address: EVM_ADDR,
      addresses: [{ index: 0, address: EVM_ADDR }],
      wallets: [evmWallet],
      activeWalletId: 'w-1',
      assets: [eth(5n), usdc(120n), weth(3n)],
      evmTokens: {
        tracked: [],
        discovered: [{ address: '0x' + '11'.repeat(20), symbol: 'WETH', decimals: 18, trusted: true }],
      },
    });
    hoisted.refreshEvmWallet.mockResolvedValue({ network: connected, assets: [eth(6n), usdc(130n)], complete: true });
    // The chunk was rate-limited: no rows, and it says so.
    hoisted.readEvmDiscoveredBalances.mockResolvedValue({ rows: [], complete: false });

    await useLiveStore.getState().refresh();
    await settle();

    expect(useLiveStore.getState().assets.map((a) => a.name)).toEqual(['ETH', 'USDC', 'WETH']);
  });

  it('a COMPLETE read that no longer reports a token DOES remove it', async () => {
    useLiveStore.setState({
      phase: 'ready',
      address: EVM_ADDR,
      addresses: [{ index: 0, address: EVM_ADDR }],
      wallets: [evmWallet],
      activeWalletId: 'w-1',
      assets: [eth(5n), usdc(120n), weth(3n)],
    });
    hoisted.refreshEvmWallet.mockResolvedValue({ network: connected, assets: [eth(6n), usdc(130n)], complete: true });

    await useLiveStore.getState().refresh();
    await settle();

    expect(useLiveStore.getState().assets.map((a) => a.name)).toEqual(['ETH', 'USDC']);
  });
});

describe('an EVM chain switch mid-read', () => {
  // One EVM account is the SAME address on every chain, so the address alone
  // could never tell a stale read from a current one: a Base read still in
  // flight when the user switched to BNB Chain landed Base's balances on BNB
  // Chain's screen.
  it('discards the read that belonged to the chain the user left', async () => {
    useLiveStore.setState({
      evm: { chains: [BASE_INFO, { ...BASE_INFO, key: 'bsc', chainId: 56, displayName: 'BNB Chain', nativeTicker: 'BNB' }], activeChainKey: 'base' },
    });
    coldEvmPopup();
    let switched = false;
    hoisted.refreshEvmWallet.mockImplementation(async () => {
      // The user changed chain while the RPC round trip was in flight. Only
      // the store's view of the active chain moves here: the address, which is
      // all the old guard looked at, does not.
      switched = true;
      hoisted.evmChainKey = 'bsc';
      useLiveStore.setState((s) => ({ evm: { ...s.evm, activeChainKey: 'bsc' } }));
      return { network: connected, assets: [eth(9n), usdc(1n)], complete: true };
    });

    await useLiveStore.getState().refresh();
    await settle();

    expect(switched).toBe(true);
    expect(useLiveStore.getState().assets).toEqual([]);
  });
});

describe('the same protection on a UTXO chain', () => {
  it('a fresh popup whose Electrum read fails shows the assets it last knew', async () => {
    hoisted.family = 'utxo';
    await saveBalanceCache('mainnet', UTXO_ADDR, [
      { name: 'EVR', amountBase: 1_250_000_000n, scale: 8, decimals: 8, isNative: true },
      { name: 'SATORIEVR', amountBase: 700_000_000n, scale: 8, decimals: 8, isNative: false },
    ]);
    useLiveStore.setState({
      phase: 'ready',
      address: UTXO_ADDR,
      addresses: [{ index: 0, address: UTXO_ADDR }],
      wallets: [utxoWallet],
      activeWalletId: 'w-1',
      txs: [],
      assets: [],
    });
    hoisted.provider.getNetworkStatus.mockResolvedValue({ ...connected, serverVersion: 'ElectrumX' });
    hoisted.provider.getAllAssetBalances.mockRejectedValue(new Error('server closed the connection'));
    hoisted.provider.getAddressHistory.mockResolvedValue([]);

    await useLiveStore.getState().refresh();
    await settle();

    const s = useLiveStore.getState();
    expect(s.assets.map((a) => a.name)).toEqual(['EVR', 'SATORIEVR']);
    expect(s.offline).toBe(true);
  });

  it('a successful Electrum read is saved for the next open', async () => {
    hoisted.family = 'utxo';
    useLiveStore.setState({
      phase: 'ready',
      address: UTXO_ADDR,
      addresses: [{ index: 0, address: UTXO_ADDR }],
      wallets: [utxoWallet],
      activeWalletId: 'w-1',
      txs: [],
      assets: [],
    });
    hoisted.provider.getNetworkStatus.mockResolvedValue({ ...connected, serverVersion: 'ElectrumX' });
    hoisted.provider.getAllAssetBalances.mockResolvedValue([
      { name: 'EVR', amountBase: 1_250_000_000n, scale: 8, decimals: 8, isNative: true },
    ]);
    hoisted.provider.getAddressHistory.mockResolvedValue([]);

    await useLiveStore.getState().refresh();
    await settle();

    expect((await loadBalanceCache('mainnet', UTXO_ADDR))?.rows.map((r) => r.name)).toEqual(['EVR']);
  });
});
