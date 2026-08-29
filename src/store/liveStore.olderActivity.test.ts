// "There is no pagination in activities, I checked for USDT on EVM BNB"
// (owner, live testing 2026-08-25), at the level of the store.
//
// Two separate things were missing and only one of them was pagination:
//
//   1. The per-asset Activity list had NO paging at all (that half is in
//      LiveAssetDetail.test.tsx).
//   2. NOTHING could reach past the FIRST page the history source served. On
//      BNB Chain, verified live against the gateway the same day, the owner's
//      address had 100 transfers per direction on that page and the API held
//      at least two more pages behind it, reaching back from block 109,745,356
//      to 34,208,015. All of it existed; none of it was reachable.
//
// What this file pins is the store's half: one request per click, rows
// appended and deduped, an honest end, an honest failure, and a UTXO chain
// answering "there is nothing older" without asking anything (Electrum serves
// an address's whole history in one call: verified live 2026-08-25, 637 and
// 791 rows over ~400,000 blocks in a single get_history).

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
  loadOlderEvmHistory: vi.fn(),
  family: 'evm' as 'evm' | 'utxo',
  evmChainKey: 'bsc' as string,
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
  loadOlderEvmHistory: hoisted.loadOlderEvmHistory,
}));

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { WalletSummary } from '../services/chain/liveWallet';
import type { LiveTransaction } from '../services/chain/electrumProvider';
import type { NetworkStatus } from '../types/domain';

const EVM_ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const UTXO_ADDR = 'EolderActivity000000000000000000';
const OTHER = '0x3535353535353535353535353535353535353535';

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
  evmChainKey: 'bsc',
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
  blockHeight: 117_450_593,
  serverVersion: 'json-rpc',
  updatedAt: 1_700_000_000_000,
  tipTime: 1_700_000_000_000,
};

const BSC_INFO = {
  key: 'bsc',
  chainId: 56,
  displayName: 'BNB Chain',
  nativeTicker: 'BNB',
  nativeDecimals: 18,
  explorerTxUrl: 'https://bscscan.com/tx/{txid}',
  homepage: 'https://example.test',
  young: false,
  recentlyAdded: false,
  feeModel: 'legacy' as const,
  l1DataFee: false,
  indexer: null,
  alchemy: true,
  trustWalletChain: 'smartchain',
  tokenListSlug: 'binance-smart-chain',
  defaultTokens: [],
};

/** One Activity row, `n` blocks back from the tip. `asset` lets a test build a
 *  USDT row (the owner's example) as easily as a native one. */
const row = (n: number, asset = 'BNB'): LiveTransaction => ({
  txid: '0x' + n.toString(16).padStart(64, '0'),
  asset,
  direction: n % 2 === 0 ? 'in' : 'out',
  amount: n,
  feeEvr: 0,
  status: 'confirmed',
  blockHeight: 117_450_593 - n,
  timestamp: 1_725_000_000_000 - n * 1000,
  counterparty: OTHER,
});

const settle = () => new Promise((r) => setTimeout(r, 5));

function evmWalletOnScreen(txs: LiveTransaction[], olderHistory?: Partial<ReturnType<typeof useLiveStore.getState>['olderHistory']>) {
  useLiveStore.setState({
    phase: 'ready',
    address: EVM_ADDR,
    addresses: [{ index: 0, address: EVM_ADDR }],
    wallets: [evmWallet],
    activeWalletId: 'w-1',
    txs,
    network: connected,
    olderHistory: { canLoadOlder: true, cursor: null, loading: false, error: null, ...olderHistory },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  hoisted.family = 'evm';
  hoisted.evmChainKey = 'bsc';
  hoisted.refreshEvmHistory.mockResolvedValue(null);
  hoisted.readEvmDiscoveredBalances.mockResolvedValue({ rows: [], complete: true });
  setStorageForTests(new MemoryStorageAdapter());
  useLiveStore.setState({
    evm: { chains: [BSC_INFO], activeChainKey: 'bsc' },
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
    olderHistory: { canLoadOlder: null, cursor: null, loading: false, error: null },
  });
});

describe('loadOlderActivity on an EVM chain', () => {
  it('appends the older page under the rows already on screen and keeps the cursor', async () => {
    evmWalletOnScreen([row(1, 'USDT'), row(2, 'USDT')]);
    hoisted.loadOlderEvmHistory.mockResolvedValue({
      rows: [row(300, 'USDT'), row(301, 'USDT')],
      cursor: 'CURSOR-2',
      hasMore: true,
      issue: null,
    });

    await useLiveStore.getState().loadOlderActivity();
    await settle();

    const s = useLiveStore.getState();
    expect(s.txs.map((t) => t.txid)).toEqual([row(1).txid, row(2).txid, row(300).txid, row(301).txid]);
    expect(s.olderHistory).toEqual({ canLoadOlder: true, cursor: 'CURSOR-2', loading: false, error: null });
    // The tip is passed through, so an older row is dated against the same
    // chain height the newest ones were.
    // The oldest block on screen starts the first page BELOW it, so the click
    // adds rows instead of re-serving the ones the user is looking at.
    expect(hoisted.loadOlderEvmHistory).toHaveBeenCalledWith(BSC_INFO, EVM_ADDR, undefined, 117_450_593, 117_450_591);
  });

  it('passes the cursor it was given, so the second click continues rather than repeating', async () => {
    evmWalletOnScreen([row(1)], { cursor: 'CURSOR-2' });
    hoisted.loadOlderEvmHistory.mockResolvedValue({ rows: [row(400)], cursor: 'CURSOR-3', hasMore: true, issue: null });

    await useLiveStore.getState().loadOlderActivity();

    expect(hoisted.loadOlderEvmHistory).toHaveBeenCalledWith(BSC_INFO, EVM_ADDR, 'CURSOR-2', 117_450_593, 117_450_592);
  });

  it('deduplicates: the first older page overlaps the newest one on purpose', async () => {
    evmWalletOnScreen([row(1), row(2)]);
    hoisted.loadOlderEvmHistory.mockResolvedValue({
      rows: [row(1), row(2), row(300)],
      cursor: 'CURSOR-2',
      hasMore: true,
      issue: null,
    });

    await useLiveStore.getState().loadOlderActivity();

    expect(useLiveStore.getState().txs.map((t) => t.txid)).toEqual([row(1).txid, row(2).txid, row(300).txid]);
  });

  it('a page that comes back with no cursor closes the question for good', async () => {
    evmWalletOnScreen([row(1)], { cursor: 'CURSOR-9' });
    hoisted.loadOlderEvmHistory.mockResolvedValue({ rows: [row(900)], cursor: null, hasMore: false, issue: null });

    await useLiveStore.getState().loadOlderActivity();
    expect(useLiveStore.getState().olderHistory.canLoadOlder).toBe(false);

    // ...and a further click asks for nothing at all.
    hoisted.loadOlderEvmHistory.mockClear();
    await useLiveStore.getState().loadOlderActivity();
    expect(hoisted.loadOlderEvmHistory).not.toHaveBeenCalled();
  });

  it('NEVER fires two requests at once: paging must not become a burst at the gateway', async () => {
    evmWalletOnScreen([row(1)]);
    let release: (() => void) | null = null;
    hoisted.loadOlderEvmHistory.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ rows: [row(300)], cursor: 'C2', hasMore: true, issue: null });
        }),
    );

    const first = useLiveStore.getState().loadOlderActivity();
    await settle();
    // A second click while the first is in flight is dropped, not queued.
    await useLiveStore.getState().loadOlderActivity();
    expect(hoisted.loadOlderEvmHistory).toHaveBeenCalledTimes(1);
    release!();
    await first;
    expect(useLiveStore.getState().olderHistory.loading).toBe(false);
  });

  it('a failed page shows why, keeps the rows and keeps the cursor for a retry', async () => {
    evmWalletOnScreen([row(1), row(2)], { cursor: 'CURSOR-2' });
    hoisted.loadOlderEvmHistory.mockResolvedValue({
      rows: null,
      cursor: 'CURSOR-2',
      hasMore: true,
      issue: { message: 'Older BNB Chain activity could not be loaded: the history service is rate-limiting this wallet. Try again in a moment.', detail: 'HTTP 429' },
    });

    await useLiveStore.getState().loadOlderActivity();

    const s = useLiveStore.getState();
    expect(s.txs).toHaveLength(2);
    expect(s.olderHistory.cursor).toBe('CURSOR-2');
    expect(s.olderHistory.canLoadOlder).toBe(true);
    expect(s.olderHistory.error).toMatch(/rate-limiting/);
    expect(s.olderHistory.loading).toBe(false);
  });

  it('discards a page that arrived after the user switched chain', async () => {
    useLiveStore.setState({
      evm: { chains: [BSC_INFO, { ...BSC_INFO, key: 'base', chainId: 8453, displayName: 'Base', nativeTicker: 'ETH' }], activeChainKey: 'bsc' },
    });
    evmWalletOnScreen([row(1)]);
    hoisted.loadOlderEvmHistory.mockImplementation(async () => {
      hoisted.evmChainKey = 'base';
      useLiveStore.setState((s) => ({ evm: { ...s.evm, activeChainKey: 'base' }, txs: [] }));
      return { rows: [row(300)], cursor: 'C2', hasMore: true, issue: null };
    });

    await useLiveStore.getState().loadOlderActivity();

    expect(useLiveStore.getState().txs).toEqual([]);
  });
});

describe('loadOlderActivity on a UTXO chain', () => {
  it('asks nothing and settles the question: Electrum already served the whole history', async () => {
    hoisted.family = 'utxo';
    useLiveStore.setState({
      phase: 'ready',
      address: UTXO_ADDR,
      addresses: [{ index: 0, address: UTXO_ADDR }],
      wallets: [utxoWallet],
      activeWalletId: 'w-1',
      txs: [row(1, 'EVR')],
      olderHistory: { canLoadOlder: null, cursor: null, loading: false, error: null },
    });

    await useLiveStore.getState().loadOlderActivity();

    expect(hoisted.loadOlderEvmHistory).not.toHaveBeenCalled();
    expect(useLiveStore.getState().olderHistory.canLoadOlder).toBe(false);
    expect(useLiveStore.getState().txs).toHaveLength(1);
  });
});
