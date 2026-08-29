// The store with an EVM account (phase 3): creating/importing on an `evm:<key>`
// target, the EVM-aware chain helpers, switching chains WITHIN the account,
// enabling EVM from a UTXO wallet's seed, and the send actions' gating. Real
// LiveWalletService + in-memory storage; a WebSocket that refuses to connect
// keeps every UTXO read offline; JSON-RPC is a fake fetch for the Base node.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ evmEnabled: true }));

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => (hoisted.evmEnabled ? await import('../services/chain/evm') : null),
  };
});

import { MemoryStorageAdapter, setStorageForTests, type KeyValueStorage } from '../services/storage';
import { resetEvmProvidersForTests } from './evmBalances';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ADDRESS_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PW = 'password123';

const word = (hex: string) => hex.padStart(64, '0');
const abiString = (s: string) =>
  '0x' + word('20') + word(s.length.toString(16)) + Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0');

/** A fake node answering by method for Base (0x2105) and BSC (0x38), chosen by URL. */
function fakeNodes() {
  const seen: Array<{ url: string; method: string }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const isBase = u.includes('base.org');
    const body = JSON.parse(String(init?.body)) as Array<{ id: number; method: string; params: unknown[] }> | { id: number; method: string; params: unknown[] };
    const answer = (req: { id: number; method: string; params: unknown[] }) => {
      seen.push({ url: u, method: req.method });
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
      switch (req.method) {
        case 'eth_chainId':
          return ok(isBase ? '0x2105' : '0x38');
        case 'eth_blockNumber':
          return ok('0x100');
        case 'eth_getBlockByNumber':
          return ok({ timestamp: '0x66f00000' });
        case 'eth_getBalance':
          // ONLY the account under test holds anything. An address-blind
          // answer would make every candidate index of the seed look funded,
          // and the account discovery an EVM import runs (evm-accounts.md)
          // would create Account 2..21 in every test in this file.
          return ok(
            String(req.params[0]).toLowerCase() === VECTOR_ADDRESS_0.toLowerCase()
              ? isBase
                ? '0xde0b6b3a7640000' // 1 ETH
                : '0x1bc16d674ec80000' // 2 BNB
              : '0x0',
          );
        case 'eth_call': {
          const call = req.params[0] as { data: string };
          if (call.data.startsWith('0x70a08231')) return ok('0x' + word('bc614e'));
          if (call.data.startsWith('0x313ce567')) return ok('0x' + word(isBase ? '6' : '12'));
          if (call.data.startsWith('0x95d89b41')) return ok(abiString(isBase ? 'USDC' : 'USDT'));
          return { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } };
        }
        default:
          return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } };
      }
    };
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetchImpl, seen };
}

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
let storage: KeyValueStorage;
const state = () => mod.useLiveStore.getState();

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  mod = await import('./liveStore');
});

beforeEach(async () => {
  hoisted.evmEnabled = true;
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  resetEvmProvidersForTests();
  vi.stubGlobal('fetch', fakeNodes().fetchImpl);
  await state().resetLiveWallet();
  await state().init();
  // init() loads the EVM chains asynchronously; wait for them.
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
});

afterEach(() => {
  state().stopAutoRefresh();
  vi.unstubAllGlobals();
});

async function settle(ms = 60) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('EVM chains in the store', () => {
  it('1. init loads the EVM chains into state (empty without the engine)', async () => {
    expect(state().evm.chains.map((c) => c.key)).toEqual(['base', 'bsc', 'ethereum', 'epix']);
    expect(state().evm.activeChainKey).toBe(null);
    // Epix has an indexer but no Alchemy: Activity has a source (no "cannot be
    // listed" notice), while Import/discovery stay hidden (they need alchemy_*).
    const epix = state().evm.chains.find((c) => c.key === 'epix');
    expect(epix?.alchemy).toBe(false);
    expect(epix?.indexer).toEqual({ family: 'blockscout', baseUrl: 'https://scan.epix.zone/api/v1' });
    expect(epix?.tokenListSlug).toBe(null);
    expect(epix?.trustWalletChain).toBe(null);
    expect(mod.describeChain('evm:base', state().evm.chains)).toEqual({
      id: 'evm:base',
      family: 'evm',
      displayName: 'Base',
      ticker: 'ETH',
      decimals: 18,
      // The chain list shows the project's own domain and, for a young or
      // newly added chain, a "New" chip. Base is neither.
      homepage: 'https://base.org',
      young: false,
      isNew: false,
    });
    expect(mod.describeChain('evm:nope', state().evm.chains)).toBe(null);
    expect(mod.describeChain('ravencoin-mainnet', state().evm.chains)?.ticker).toBe('RVN');
  });

  it('2. importWallet on evm:base creates ONE EVM account at the MetaMask address; the helpers follow the family', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My EVM', 'evm:base');
    await state().loadWallets();
    expect(state().address).toBe(VECTOR_ADDRESS_0);
    expect(state().addresses).toEqual([{ index: 0, address: VECTOR_ADDRESS_0 }]);
    const w = state().wallets[0];
    expect(w.family).toBe('evm');
    expect(w.evmChainKey).toBe('base');
    expect(state().evm.activeChainKey).toBe('base');
    expect(mod.activeFamily()).toBe('evm');
    expect(mod.activeChainTarget()).toBe('evm:base');
    expect(mod.nativeTickerFor()).toBe('ETH');
    expect(mod.chainDisplayName()).toBe('Base');
    expect(mod.isNativeAssetId('eth')).toBe(true);
    expect(mod.assetsSupported()).toBe(true);
    expect(mod.stakingSupported()).toBe(false);
    expect(mod.activeEvmChain(state())?.chainId).toBe(8453);
    // The refresh path read balances over JSON-RPC (Base) for this address.
    await settle(150);
    expect(state().assets.map((a) => `${a.name}=${a.amountBase}`)).toEqual(['ETH=1000000000000000000', 'USDC=12345678']);
    expect(state().offline).toBe(false);
  }, 30_000);

  it('3. chainsWithWallets: an EVM account enables every EVM chain and no UTXO chain; walletsOnChain scopes recipients by family', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().importWallet(VECTOR_MNEMONIC, PW, 'RVN', 'ravencoin-mainnet');
    await state().loadWallets();
    const enabled = mod.chainsWithWallets(state().wallets, state().evm.chains.map((c) => c.key));
    expect(enabled.has('evm:base')).toBe(true);
    expect(enabled.has('evm:bsc')).toBe(true);
    expect(enabled.has('ravencoin-mainnet')).toBe(true);
    expect(enabled.has('mainnet')).toBe(false);
    expect(mod.walletsOnChain(state().wallets, 'evm:bsc').map((w) => w.name)).toEqual(['EVM']);
    expect(mod.walletsOnChain(state().wallets, 'ravencoin-mainnet').map((w) => w.name)).toEqual(['RVN']);
    expect(mod.walletOnChain(state().wallets, 'evm:base')?.name).toBe('EVM');
  }, 30_000);

  it('4. switchChain to another EVM chain stays on the account, changes the shown chain and re-reads balances', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    await settle(100);
    const id = state().activeWalletId;
    await state().switchChain('evm:bsc');
    expect(state().activeWalletId).toBe(id);
    expect(state().phase).toBe('ready'); // no re-lock: same wallet
    expect(state().address).toBe(VECTOR_ADDRESS_0);
    expect(state().evm.activeChainKey).toBe('bsc');
    expect(mod.activeChainTarget()).toBe('evm:bsc');
    expect(mod.nativeTickerFor()).toBe('BNB');
    expect(state().wallets[0].evmChainKey).toBe('bsc');
    await settle(150);
    expect(state().assets[0]).toMatchObject({ name: 'BNB', amountBase: 2n * 10n ** 18n });
    // Persisted: a fresh listing still says bsc.
    await state().loadWallets();
    expect(state().wallets[0].evmChainKey).toBe('bsc');
    // Same chain again: no-op.
    await state().switchChain('evm:bsc');
    expect(state().evm.activeChainKey).toBe('bsc');
  }, 30_000);

  it('5. switchChain from an EVM account to a UTXO chain switches WALLETS (and never reads as "already there")', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'RVN', 'ravencoin-mainnet');
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    const evmId = state().activeWalletId;
    // The idle Electrum side still says ravencoin; that must NOT short-circuit.
    expect(mod.activeChainId()).toBe('ravencoin-mainnet');
    await state().switchChain('ravencoin-mainnet');
    expect(state().activeWalletId).not.toBe(evmId);
    expect(state().wallets.find((w) => w.active)?.name).toBe('RVN');
    expect(mod.activeFamily()).toBe('utxo');
    expect(state().evm.activeChainKey).toBe(null);
    // And back to Base lands on the EVM account (locked: it needs its password).
    await state().switchChain('evm:base');
    expect(state().activeWalletId).toBe(evmId);
    expect(state().phase).toBe('locked');
    await state().unlock(PW);
    expect(state().address).toBe(VECTOR_ADDRESS_0);
    expect(state().evm.activeChainKey).toBe('base');
  }, 45_000);

  it('6. enableChain(evm:bsc) from a UTXO wallet derives the EVM account from the SAME seed, tagged (EVM), showing bsc; a second enable is refused', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();
    const res = await state().enableChain('evm:bsc', PW);
    expect(res.ok).toBe(true);
    const evmWallet = state().wallets.find((w) => w.family === 'evm')!;
    expect(evmWallet.name).toBe('Main (EVM)');
    expect(evmWallet.address).toBe(VECTOR_ADDRESS_0);
    expect(evmWallet.evmChainKey).toBe('bsc');
    expect(state().activeWalletId).toBe(evmWallet.id);
    const again = await state().enableChain('evm:base', PW);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already have an EVM account/);
    // Wrong password creates nothing.
    await state().switchWallet(state().wallets.find((w) => w.family === 'utxo')!.id);
    await state().unlock(PW);
    await state().removeWallet(evmWallet.id);
    const bad = await state().enableChain('evm:base', 'wrong');
    expect(bad.ok).toBe(false);
    expect(state().wallets.some((w) => w.family === 'evm')).toBe(false);
  }, 60_000);

  it('7. quoteEvmSend on a UTXO wallet refuses; confirmEvmSend with nothing to send refuses; both leave the gate closed', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();
    expect(await state().quoteEvmSend({ to: VECTOR_ADDRESS_0, amountText: '1', assetId: 'ETH' })).toBe(null);
    expect(state().error).toMatch(/not an EVM account/);
    await expect(state().confirmEvmSend()).rejects.toThrow(/Nothing to send/);
  }, 30_000);

  it('8. without the engine, evm.chains is empty, an evm target describes as nothing and cannot be enabled', async () => {
    hoisted.evmEnabled = false;
    await state().resetLiveWallet();
    await state().init();
    await settle(50);
    expect(state().evm.chains).toEqual([]);
    expect(mod.describeChain('evm:base', state().evm.chains)).toBe(null);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();
    const res = await state().enableChain('evm:base', PW);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not carry that chain/);
    expect(state().wallets.some((w) => w.family === 'evm')).toBe(false);
  }, 30_000);
});
