// Store-level multichain plumbing (Phase A1): the optional `network` arg on the
// create/import actions reaches the service, and the active chain drives the
// per-chain server pool + explorer template state.
//
// The module-level LiveWalletService singleton owns a REAL Electrum client, so we
// stub a throwing WebSocket BEFORE importing the store (dynamic import) — the
// singleton then captures the fake, and the fire-and-forget refresh fails closed
// (offline) instead of opening a real socket. Storage is an in-memory adapter.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryStorageAdapter,
  setStorageForTests,
  type KeyValueStorage,
} from '../services/storage';
import { DEFAULT_ELECTRUM_SERVER_URLS } from '../services/chain/network';

// A WebSocket that refuses to connect: `new` throws, so the client's connect()
// fails fast and the watch-only reads resolve offline (no network in tests).
class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

// BIP39 test vector (no passphrase). Derives a known Evrmore 'E...' / Ravencoin
// 'R...' address depending on the wallet's chain.
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
let storage: KeyValueStorage;

interface StoredWallets {
  wallets: { network: string; address?: string }[];
  activeId: string;
}

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  mod = await import('./liveStore');
});

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  await mod.useLiveStore.getState().resetLiveWallet();
});

afterEach(() => {
  mod.useLiveStore.getState().stopAutoRefresh();
});

describe('createWallet / importWallet network plumbing', () => {
  it('imports an Evrmore wallet by default (no network arg) — persists mainnet, EVR pool + explorer', async () => {
    await mod.useLiveStore.getState().importWallet(VECTOR_MNEMONIC, 'password123', 'EVR wallet');
    await mod.useLiveStore.getState().loadWallets();

    const stored = (await storage.get<StoredWallets>('liveWallets'))!;
    expect(stored.wallets[0].network).toBe('mainnet');
    // Evrmore address begins with 'E'.
    expect(stored.wallets[0].address?.[0]).toBe('E');

    const s = mod.useLiveStore.getState();
    expect(s.electrumServers).toEqual([...DEFAULT_ELECTRUM_SERVER_URLS]);
    expect(s.explorerUrlTemplate).toBe(mod.DEFAULT_EXPLORER_URL);
  });

  it('imports a Ravencoin wallet when network=ravencoin-mainnet — persists it, RVN pool + explorer', async () => {
    await mod.useLiveStore
      .getState()
      .importWallet(VECTOR_MNEMONIC, 'password123', 'RVN wallet', 'ravencoin-mainnet');
    await mod.useLiveStore.getState().loadWallets();

    const stored = (await storage.get<StoredWallets>('liveWallets'))!;
    expect(stored.wallets[0].network).toBe('ravencoin-mainnet');
    // Ravencoin address begins with 'R' (version byte 60) — proves the chain
    // reached the service's derivation, not just a stored label.
    expect(stored.wallets[0].address?.[0]).toBe('R');

    const s = mod.useLiveStore.getState();
    // Active chain's pool + explorer follow the wallet.
    expect(s.electrumServers).toEqual(['wss://rvnx.satorinet.io:443']);
    expect(s.explorerUrlTemplate).toBe(mod.DEFAULT_EXPLORER_URL_RVN);
  });

  it('imports a Ravencoin single-key wallet (importPrivateKeyWallet) with the network arg', async () => {
    // A raw 32-byte hex private key -> single-address 'pk' wallet on Ravencoin.
    const HEX_KEY = '0'.repeat(63) + '1';
    await mod.useLiveStore
      .getState()
      .importPrivateKeyWallet(HEX_KEY, 'password123', 'RVN key', 'ravencoin-mainnet');

    const stored = (await storage.get<StoredWallets>('liveWallets'))!;
    expect(stored.wallets[0].network).toBe('ravencoin-mainnet');
    expect(stored.wallets[0].address?.[0]).toBe('R');
  });

  it('createWallet forwards the network arg to a brand-new Ravencoin wallet', async () => {
    await mod.useLiveStore.getState().createWallet('password123', 'new RVN', 'ravencoin-mainnet');
    const stored = (await storage.get<StoredWallets>('liveWallets'))!;
    expect(stored.wallets[0].network).toBe('ravencoin-mainnet');
    expect(stored.wallets[0].address?.[0]).toBe('R');
  });
});
