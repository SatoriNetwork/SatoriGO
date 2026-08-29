// MetaMask-style EVM accounts in the STORE (the EVM accounts design notes).
//
// Real store, real LiveWalletService, in-memory storage and fake Base/BSC nodes.
// What is pinned here is the part the service cannot see:
//   * the RPC probe (one batch per chain, balance or nonce) and what it does
//     with the answer,
//   * that adding or switching to an account of the SAME seed never falls back
//     to the lock screen, and
//   * that importing an EVM recovery phrase looks for its other accounts.

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
import { resetEvmIndexersForTests } from './evmHistory';
import { mnemonicToSeed } from '../services/chain/keys';
import { deriveEvmKey } from '../services/chain/evm/keys';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'password123';
const BSC_RPC = 'https://bsc-dataseed.bnbchain.org';

/** Addresses 0..20 of the vector seed, filled in beforeAll. */
const ADDR: string[] = [];

/**
 * Fake Base + BNB nodes. `used` names which ADDRESS INDEXES answer a positive
 * balance, and on which chain; everything else is a zero balance and a zero
 * nonce. `rpcCalls` records the methods so a test can prove the probe was ONE
 * batch and not one call per address.
 */
function fakeNodes(used: { base?: number[]; bsc?: number[]; nonce?: number[] } = {}) {
  const rpcCalls: string[] = [];
  const batches: number[] = [];
  const balance = (chain: 'base' | 'bsc', address: string): string => {
    const index = ADDR.findIndex((a) => a.toLowerCase() === address.toLowerCase());
    return (used[chain] ?? []).includes(index) ? '0xde0b6b3a7640000' : '0x0';
  };
  const nonce = (address: string): string => {
    const index = ADDR.findIndex((a) => a.toLowerCase() === address.toLowerCase());
    return (used.nonce ?? []).includes(index) ? '0x3' : '0x0';
  };
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    // No token marks and no history in these tests.
    if (u.startsWith('https://raw.githubusercontent.com/')) return new Response('404', { status: 404 });
    if (u.startsWith('https://base.blockscout.com/api')) {
      return new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }), { status: 200 });
    }
    const chain: 'base' | 'bsc' = u.startsWith(BSC_RPC) ? 'bsc' : 'base';
    const body = JSON.parse(String(init?.body)) as
      | Array<{ id: number; method: string; params: unknown[] }>
      | { id: number; method: string; params: unknown[] };
    if (Array.isArray(body)) batches.push(body.length);
    const answer = (req: { id: number; method: string; params: unknown[] }) => {
      rpcCalls.push(req.method);
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
      switch (req.method) {
        case 'eth_chainId':
          return ok(chain === 'bsc' ? '0x38' : '0x2105');
        case 'eth_blockNumber':
          return ok('0x100');
        case 'eth_getBlockByNumber':
          return ok({ timestamp: '0x66f00000' });
        case 'eth_getBalance':
          return ok(balance(chain, req.params[0] as string));
        case 'eth_getTransactionCount':
          return ok(nonce(req.params[0] as string));
        case 'eth_call':
          return ok('0x' + '0'.repeat(64)); // every token balance is zero
        default:
          return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } };
      }
    };
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetchImpl, rpcCalls, batches };
}

/** A node where every request fails: the "could not read any chain" case. */
const deadNode = async (): Promise<Response> => {
  throw new Error('network down');
};

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
let storage: KeyValueStorage;
const state = () => mod.useLiveStore.getState();
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  const seed = await mnemonicToSeed(VECTOR_MNEMONIC, '');
  for (let i = 0; i <= 20; i++) ADDR.push(deriveEvmKey(seed, i).address);
  mod = await import('./liveStore');
}, 30_000);

beforeEach(async () => {
  hoisted.evmEnabled = true;
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  resetEvmProvidersForTests();
  resetEvmIndexersForTests();
  await state().resetLiveWallet();
  await state().init();
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await settle(5);
});

afterEach(async () => {
  state().stopAutoRefresh();
  // A discovery kicked off by this test (import-time, fire-and-forget, now
  // sequential across chains) must not bleed into the next test's store.
  // It may not even have STARTED yet (it runs after the first refresh), so
  // wait for a verdict (added or error) and for scanning to clear.
  for (let i = 0; i < 120; i++) {
    const sc = state().evmAccountScan;
    if (!sc.scanning && (sc.added !== null || sc.error !== null)) break;
    await settle(50);
  }
  vi.unstubAllGlobals();
});

/** Import the vector phrase as an EVM account on Base and let the fire-and-
 *  forget refresh + discovery chain finish. */
async function importEvm(): Promise<void> {
  // resetLiveWallet() does not touch evmAccountScan, so a verdict left by the
  // previous test would satisfy the wait below before THIS import's discovery
  // even starts. Clear it first.
  mod.useLiveStore.setState({ evmAccountScan: { scanning: false, added: null, error: null } });
  await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
  await state().loadWallets();
  // The import-time discovery probes the chains one at a time with a short
  // gap (four chains ~ 1.2 s), so wait for it to FINISH, not just to start.
  for (let i = 0; i < 200 && (state().evmAccountScan.added === null || state().evmAccountScan.scanning); i++) await settle(50);
  await settle();
}

describe('EVM accounts in the store', () => {
  it('1. importing an EVM recovery phrase finds the accounts it already uses on chain', async () => {
    const node = fakeNodes({ base: [2] });
    vi.stubGlobal('fetch', node.fetchImpl);
    await importEvm();

    // Index 2 is used, so indexes 1 and 2 both exist: MetaMask numbers its
    // accounts contiguously and so does this.
    expect(state().evmAccountScan).toMatchObject({ scanning: false, added: 2, error: null });
    expect(state().wallets.map((w) => `${w.name}@${w.hdIndex}`)).toEqual(['EVM@0', 'Account 2@1', 'Account 3@2']);
    expect(state().wallets.map((w) => w.address)).toEqual([ADDR[0], ADDR[1], ADDR[2]]);
    // Every account of the seed shares one group id.
    expect(new Set(state().wallets.map((w) => w.seedGroup))).toEqual(new Set([ADDR[0].toLowerCase()]));
    // The import stays on Account 1: discovery finds, it does not switch.
    expect(state().address).toBe(ADDR[0]);
    expect(state().phase).toBe('ready');

    // ONE batch per chain, not one call per address (20 addresses x 2 calls).
    expect(node.batches).toContain(40);
    expect(node.rpcCalls.filter((m) => m === 'eth_getTransactionCount').length).toBeGreaterThanOrEqual(40);
  }, 60_000);

  it('2. discoverEvmAccounts on demand: a nonce alone counts, and a second run adds nothing', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl); // nothing used anywhere
    await importEvm();
    expect(state().evmAccountScan.added).toBe(0);
    expect(state().wallets).toHaveLength(1);

    // An account that spent everything it received still exists (nonce > 0),
    // and it counts on ANY chain: this one only answers on BNB Chain.
    vi.stubGlobal('fetch', fakeNodes({ nonce: [1] }).fetchImpl);
    resetEvmProvidersForTests();
    expect(await state().discoverEvmAccounts()).toEqual({ ok: true, added: 1 });
    expect(state().evmAccountScan).toMatchObject({ added: 1, error: null, scanning: false });
    expect(state().wallets.map((w) => w.name)).toEqual(['EVM', 'Account 2']);

    // Idempotent: the same chain answer a second time creates nothing new.
    expect(await state().discoverEvmAccounts()).toEqual({ ok: true, added: 0 });
    expect(state().wallets).toHaveLength(2);
  }, 60_000);

  it('3. every chain unreachable is reported as a failure, never as "no accounts"', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await importEvm();
    vi.stubGlobal('fetch', deadNode);
    resetEvmProvidersForTests();
    const res = await state().discoverEvmAccounts();
    expect(res.ok).toBe(false);
    expect(res.added).toBe(0);
    expect(res.error).toMatch(/reach any EVM network/);
    expect(state().evmAccountScan).toMatchObject({ scanning: false, added: null });
    expect(state().evmAccountScan.error).toMatch(/reach any EVM network/);
    expect(state().wallets).toHaveLength(1);
  }, 60_000);

  it('4. addEvmAccount lands on the new account WITHOUT a lock screen', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await importEvm();
    const account1 = state().activeWalletId;

    const res = await state().addEvmAccount();
    expect(res.ok).toBe(true);
    // Still ready, still the same session: only the address moved.
    expect(state().phase).toBe('ready');
    expect(state().address).toBe(ADDR[1]);
    expect(state().addresses).toEqual([{ index: 0, address: ADDR[1] }]);
    expect(state().activeWalletId).not.toBe(account1);
    expect(state().wallets.map((w) => w.name)).toEqual(['EVM', 'Account 2']);
    expect(state().wallets.find((w) => w.active)?.hdIndex).toBe(1);

    // And switching back the other way is just as seamless.
    await state().switchWallet(account1!);
    expect(state().phase).toBe('ready');
    expect(state().address).toBe(ADDR[0]);
    await settle();
  }, 60_000);

  it('5. discovery runs on an EVM seed IMPORT, never on create', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    const real = state().discoverEvmAccounts;
    const spy = vi.fn(async () => ({ ok: true, added: 0 }));
    mod.useLiveStore.setState({ discoverEvmAccounts: spy });
    try {
      await state().createWallet(PW, 'Fresh EVM', 'evm:base');
      await settle(300);
      // A freshly generated seed has no history anywhere to find.
      expect(spy).not.toHaveBeenCalled();

      await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
      for (let i = 0; i < 40 && spy.mock.calls.length === 0; i++) await settle(50);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      mod.useLiveStore.setState({ discoverEvmAccounts: real });
    }
    await settle();
  }, 60_000);

  it('6. a build without the EVM engine refuses discovery clearly instead of finding nothing', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await importEvm();
    hoisted.evmEnabled = false;
    resetEvmProvidersForTests();
    const noEngine = await state().discoverEvmAccounts();
    expect(noEngine).toMatchObject({ ok: false, added: 0 });
    expect(noEngine.error).toMatch(/no EVM engine/);
  }, 60_000);
});
