// EVM token management (after phase 4): add a token by contract address (symbol
// and decimals read from the chain), remove it, and discover tokens the indexer
// saw move through the address (shown while they hold a balance). Real store
// and service, in-memory storage, a fake Base node and a fake Blockscout.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ evmEnabled: true, alchemy: false }));

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => {
      if (!hoisted.evmEnabled) return null;
      const evm = await import('../services/chain/evm');
      // The "keyed provider" case: the registry reads through Alchemy (same
      // fake node here, answering the alchemy_* methods too).
      return hoisted.alchemy
        ? { ...evm, hasAlchemy: () => true, evmRpcEndpoints: (c: { rpc: readonly string[] }) => [...c.rpc] }
        : evm;
    },
  };
});

import { MemoryStorageAdapter, setStorageForTests, getStorage, type KeyValueStorage } from '../services/storage';
import { resetEvmProvidersForTests } from './evmBalances';
import { resetEvmIndexersForTests } from './evmHistory';
import { tokenLogoFor, tokenTrustFor } from './tokenLogoRegistry';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PW = 'password123';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006'; // added by hand
const AIRDROP = '0x1111111111111111111111111111111111111111'; // discovered, held, LISTED in Trust Wallet assets
const DUST = '0x2222222222222222222222222222222222222222'; // discovered, balance 0
const NOT_A_TOKEN = '0x3333333333333333333333333333333333333333';
const JUNK = '0x4444444444444444444444444444444444444444'; // discovered, held, NOT listed (spam)

const word = (hex: string) => hex.padStart(64, '0');
const abiString = (s: string) =>
  '0x' + word('20') + word(s.length.toString(16)) + Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0');

/** Token table: contract -> [symbol, decimals, balance of ME]. */
const TOKENS: Record<string, [string, number, bigint]> = {
  [USDC]: ['USDC', 6, 12_345_678n],
  [WETH]: ['WETH', 18, 3n * 10n ** 17n],
  [AIRDROP]: ['SPAM', 18, 1_000n * 10n ** 18n],
  [DUST]: ['GONE', 18, 0n],
  [JUNK]: ['JUNK', 18, 5n * 10n ** 18n],
};

function fakeNodes(opts: { indexerTokens?: string[] } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.startsWith('https://raw.githubusercontent.com/trustwallet/assets/')) {
      // Trust Wallet has a mark for WETH and for the AIRDROP contract on Base,
      // nothing for the others (JUNK, DUST, USDC in this fake).
      calls.push('logo');
      return u.includes('/base/assets/0x4200000000000000000000000000000000000006/') ||
        u.includes('/base/assets/0x1111111111111111111111111111111111111111/')
        ? new Response(PNG_BYTES, { status: 200 })
        : new Response('404: Not Found', { status: 404 });
    }
    if (u.startsWith('https://base.blockscout.com/api')) {
      const action = new URL(u).searchParams.get('action');
      calls.push(`indexer:${action}`);
      if (action === 'tokentx') {
        const rows = (opts.indexerTokens ?? []).map((c, i) => ({
          hash: '0x' + (i + 1).toString(16).padStart(64, '0'),
          blockNumber: String(50_000_000 + i),
          timeStamp: String(1_725_000_000 + i),
          from: '0x3535353535353535353535353535353535353535',
          to: ME.toLowerCase(),
          contractAddress: c,
          value: '1',
          tokenSymbol: TOKENS[c][0],
          tokenName: TOKENS[c][0],
          tokenDecimal: String(TOKENS[c][1]),
          gasUsed: '50000',
          gasPrice: '6000000',
          confirmations: '10',
        }));
        return new Response(JSON.stringify({ status: '1', message: 'OK', result: rows }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as Array<{ id: number; method: string; params: unknown[] }> | { id: number; method: string; params: unknown[] };
    const answer = (req: { id: number; method: string; params: unknown[] }) => {
      calls.push(`rpc:${req.method}`);
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
      switch (req.method) {
        case 'eth_chainId':
          return ok('0x2105');
        case 'eth_blockNumber':
          return ok('0x100');
        case 'eth_getBlockByNumber':
          return ok({ timestamp: '0x66f00000' });
        case 'eth_getBalance':
          // ONLY this wallet's own address holds anything. An address-blind
          // answer would make every candidate index of the seed look funded to
          // the account discovery an EVM import runs (evm-accounts.md), which
          // would quietly create 20 accounts behind every test in this file.
          return ok(String(req.params[0]).toLowerCase() === ME.toLowerCase() ? '0xde0b6b3a7640000' : '0x0');
        case 'alchemy_getTokenBalances': {
          const balances = Object.entries(TOKENS).map(([c, [, , bal]]) => ({ contractAddress: c, tokenBalance: '0x' + bal.toString(16) }));
          return ok({ address: req.params[0], tokenBalances: balances });
        }
        case 'alchemy_getTokenMetadata': {
          const t = TOKENS[(req.params[0] as string).toLowerCase()];
          return t ? ok({ decimals: t[1], symbol: t[0], name: t[0], logo: null }) : ok({ decimals: null, symbol: null, name: null, logo: null });
        }
        case 'alchemy_getAssetTransfers':
          return ok({ transfers: [] });
        case 'eth_call': {
          const call = req.params[0] as { to: string; data: string };
          const t = TOKENS[call.to.toLowerCase()];
          if (!t) return { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } };
          if (call.data.startsWith('0x70a08231')) return ok('0x' + word(t[2].toString(16)));
          if (call.data.startsWith('0x313ce567')) return ok('0x' + word(t[1].toString(16)));
          if (call.data.startsWith('0x95d89b41')) return ok(abiString(t[0]));
          return { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } };
        }
        default:
          return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } };
      }
    };
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetchImpl, calls };
}

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
let storage: KeyValueStorage;
const state = () => mod.useLiveStore.getState();
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  mod = await import('./liveStore');
});

beforeEach(async () => {
  hoisted.evmEnabled = true;
  hoisted.alchemy = false;
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  resetEvmProvidersForTests();
  resetEvmIndexersForTests();
  await state().resetLiveWallet();
  await state().init();
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await settle(5);
});

afterEach(() => {
  state().stopAutoRefresh();
  vi.unstubAllGlobals();
});

describe('EVM token management', () => {
  it('1. addEvmToken by contract: symbol/decimals from the chain, persisted per wallet+chain, row appears; refusals are specific', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    await settle();
    expect(state().assets.map((a) => a.name)).toEqual(['ETH', 'USDC']);

    // Through the generic addAsset (what the Add token modal calls).
    const res = await state().addAsset(WETH);
    expect(res.ok).toBe(true);
    expect(state().evmTokens.tracked).toMatchObject([{ address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }]);
    expect(state().assets.map((a) => `${a.name}=${a.amountBase}`)).toEqual(['ETH=1000000000000000000', 'USDC=12345678', 'WETH=300000000000000000']);
    const id = state().activeWalletId!;
    expect(await getStorage().get(`evmTokens:${id}:base`)).toMatchObject([{ symbol: 'WETH', decimals: 18 }]);

    expect(await state().addAsset('0x1234')).toMatchObject({ ok: false, error: expect.stringMatching(/contract address/) });
    expect(await state().addAsset(NOT_A_TOKEN)).toMatchObject({ ok: false, error: expect.stringMatching(/No ERC-20 token answers/) });
    expect(await state().addAsset(USDC)).toMatchObject({ ok: false, error: expect.stringMatching(/already shown by default/) });
    // Idempotent: adding WETH again does not duplicate.
    await state().addAsset(WETH);
    expect(state().evmTokens.tracked).toHaveLength(1);
  }, 30_000);

  it('2. the tracked list is per wallet AND per chain: switching to BSC shows none, back to Base shows WETH again', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    await settle();
    await state().addAsset(WETH);
    await state().switchChain('evm:bsc');
    expect(state().evmTokens.tracked).toEqual([]);
    await state().switchChain('evm:base');
    await settle();
    expect(state().evmTokens.tracked.map((t) => t.symbol)).toEqual(['WETH']);
    expect(state().assets.map((a) => a.name)).toContain('WETH');
  }, 30_000);

  it('3. removeAsset forgets a tracked token (row gone, list persisted) but never a default token', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    await settle();
    await state().addAsset(WETH);
    state().removeAsset('WETH');
    expect(state().evmTokens.tracked).toEqual([]);
    expect(state().assets.map((a) => a.name)).toEqual(['ETH', 'USDC']);
    await settle();
    expect(await getStorage().get(`evmTokens:${state().activeWalletId}:base`)).toEqual([]);
    state().removeAsset('USDC'); // protected default
    expect(state().assets.map((a) => a.name)).toContain('USDC');
    expect(mod.isRemovableAsset('USDC')).toBe(false);
    expect(mod.isRemovableAsset('WETH')).toBe(true);
  }, 30_000);

  it('4. discovery: tokens the indexer saw are checked against the trusted registry; only TRUSTED ones with a balance appear automatically', async () => {
    vi.stubGlobal('fetch', fakeNodes({ indexerTokens: [AIRDROP, DUST, JUNK] }).fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    // First refresh reads defaults; the detached history read discovers three
    // contracts, the trust check runs, and a second balance read follows.
    for (let i = 0; i < 60; i++) {
      const d = state().evmTokens.discovered;
      if (d.length === 3 && d.every((t) => t.trusted !== undefined) && state().assets.some((a) => a.name === 'SPAM')) break;
      await settle(100);
    }
    expect(state().evmTokens.discovered.map((t) => `${t.symbol}:${t.trusted}`).sort()).toEqual(['GONE:false', 'JUNK:false', 'SPAM:true']);
    const names = state().assets.map((a) => a.name);
    expect(names).toContain('SPAM'); // listed + held: shown, with its mark
    expect(names).not.toContain('JUNK'); // held but unlisted: NOT shown until imported
    expect(names).not.toContain('GONE'); // empty: not shown
    expect(tokenLogoFor('SPAM')).toMatch(/^data:image\/png/);
    expect(await getStorage().get(`evmDiscovered:${state().activeWalletId}:base`)).toHaveLength(3);
    // Discovered tokens are removable (hide + forget).
    expect(mod.isRemovableAsset('SPAM')).toBe(true);
    state().removeAsset('SPAM');
    expect(state().assets.map((a) => a.name)).not.toContain('SPAM');
    expect(state().evmTokens.discovered.map((t) => t.symbol).sort()).toEqual(['GONE', 'JUNK']);
  }, 45_000);

  it('5. importEvmTokens without a token index: a clear refusal, nothing changes', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    await settle();
    expect(state().evm.chains.find((c) => c.key === 'base')?.alchemy).toBe(false);
    const res = await state().importEvmTokens();
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/token index/) });
    expect(state().evmTokens.tracked).toEqual([]);
  }, 30_000);

  it('6. importEvmTokens with a keyed provider: every held token (balance > 0) becomes tracked, defaults skipped, rows appear, idempotent', async () => {
    hoisted.alchemy = true;
    await state().resetLiveWallet();
    await state().init();
    for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await settle(5);
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    await settle();
    expect(state().evm.chains.find((c) => c.key === 'base')?.alchemy).toBe(true);
    const res = await state().importEvmTokens();
    // USDC is a default (skipped), GONE has balance 0 (not held), so WETH + SPAM + JUNK.
    expect(res).toEqual({ ok: true, added: 3, skipped: 0, untrusted: 0 });
    expect(state().evmTokens.tracked.map((t) => t.symbol).sort()).toEqual(['JUNK', 'SPAM', 'WETH']);
    await settle();
    expect(state().assets.map((a) => a.name).sort()).toEqual(['ETH', 'JUNK', 'SPAM', 'USDC', 'WETH']);
    // Again: nothing new.
    expect(await state().importEvmTokens()).toEqual({ ok: true, added: 0, skipped: 0, untrusted: 0 });
    // Removing an imported token forgets it; a later import brings it back (the user asked for everything).
    state().removeAsset('SPAM');
    expect(state().evmTokens.tracked.map((t) => t.symbol).sort()).toEqual(['JUNK', 'WETH']);
  }, 45_000);

  it('7. logos: an added token gets its Trust Wallet mark (PNG data URL) fetched, persisted, and published to the icon registry; a token without one keeps none', async () => {
    const node = fakeNodes();
    vi.stubGlobal('fetch', node.fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    await settle();
    await state().addAsset(WETH);
    for (let i = 0; i < 40 && !state().evmTokens.tracked[0]?.logo; i++) await settle(50);
    const weth = state().evmTokens.tracked.find((t) => t.symbol === 'WETH')!;
    expect(weth.logo).toMatch(/^data:image\/png;base64,/);
    expect(tokenLogoFor('WETH')).toBe(weth.logo);
    expect(tokenLogoFor('weth')).toBe(weth.logo);
    const stored = (await getStorage().get(`evmTokens:${state().activeWalletId}:base`)) as Array<{ symbol: string; logo?: string }>;
    expect(stored.find((t) => t.symbol === 'WETH')?.logo).toBe(weth.logo);
    // The mark request went to the Trust Wallet path for the checksummed contract.
    expect(node.calls.filter((c) => c === 'logo').length).toBeGreaterThanOrEqual(1);
    // A token Trust Wallet does not know: no logo, no error, badge stays.
    hoisted.alchemy = true;
    await state().resetLiveWallet();
    await state().init();
    for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await settle(5);
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    await settle();
    await state().importEvmTokens();
    for (let i = 0; i < 40 && !state().evmTokens.tracked.find((t) => t.symbol === 'WETH')?.logo; i++) await settle(50);
    expect(state().evmTokens.tracked.find((t) => t.symbol === 'JUNK')?.logo).toBeUndefined();
    expect(tokenLogoFor('JUNK')).toBe(null);
    expect(state().evmTokens.tracked.find((t) => t.symbol === 'WETH')?.logo).toMatch(/^data:image\/png/);
    // Trust verdicts from the same probe: listed = trusted, 404 = untrusted (the UI warns).
    for (let i = 0; i < 40 && state().evmTokens.tracked.find((t) => t.symbol === 'JUNK')?.trusted === undefined; i++) await settle(50);
    expect(state().evmTokens.tracked.find((t) => t.symbol === 'JUNK')?.trusted).toBe(false);
    expect(state().evmTokens.tracked.find((t) => t.symbol === 'WETH')?.trusted).toBe(true);
    expect(tokenTrustFor('JUNK')).toBe(false);
    expect(tokenTrustFor('WETH')).toBe(true);
    expect(tokenTrustFor('USDC')).toBe(null); // a default token: no claim, no warning
  }, 45_000);

  it('8. Import trusted: only tokens listed in Trust Wallet assets (a mark exists) come in, with their marks; the rest are counted as unlisted', async () => {
    hoisted.alchemy = true;
    await state().resetLiveWallet();
    await state().init();
    for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await settle(5);
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    await settle();
    const res = await state().importEvmTokens({ trustedOnly: true });
    // Held and not default: WETH and SPAM have Trust Wallet marks, JUNK has none.
    expect(res).toEqual({ ok: true, added: 2, skipped: 0, untrusted: 1 });
    expect(state().evmTokens.tracked.map((t) => t.symbol).sort()).toEqual(['SPAM', 'WETH']);
    expect(state().evmTokens.tracked.every((t) => t.logo?.startsWith('data:image/png'))).toBe(true);
    // Import all afterwards still brings the unlisted one.
    expect(await state().importEvmTokens()).toEqual({ ok: true, added: 1, skipped: 0, untrusted: 0 });
    expect(state().evmTokens.tracked.map((t) => t.symbol).sort()).toEqual(['JUNK', 'SPAM', 'WETH']);
  }, 45_000);

  it('9. pins: SATORIEVR pinned on a non-Evrmore wallet by the legacy migration is dropped; an EVM account keeps no pins at all', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    const id = state().activeWalletId!;
    await getStorage().set(`pinnedAssets:${id}`, ['SATORIEVR', 'FOO']);
    await state().loadWalletAssets();
    expect(state().pinnedAssets).toEqual([]);
    expect(await getStorage().get(`pinnedAssets:${id}`)).toEqual([]);
    expect(mod.sanitizePins(['SATORIEVR', 'X'], 'ravencoin-mainnet')).toEqual(['X']);
    expect(mod.sanitizePins(['SATORIEVR', 'X'], 'mainnet')).toEqual(['SATORIEVR', 'X']);
    expect(mod.computeDisplayedAssets([], ['SATORIEVR'], [], 'evm:base').map((a) => a.name)).toEqual(['ETH']);
  }, 30_000);

  // The 2026-08-25 rule change: "trusted" used to mean "a mark came back", which
  // in a gateway build meant "the gateway returned a picture". Verdicts recorded
  // under that rule must not survive the upgrade as silent vouching.
  it('10. a trusted verdict from the OLD rule is retired on read, and a fresh one carries the rule version', async () => {
    vi.stubGlobal('fetch', fakeNodes().fetchImpl);
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', 'evm:base');
    await state().loadWallets();
    const id = state().activeWalletId!;
    await getStorage().set(`evmTokens:${id}:base`, [
      // Recorded by the old rule: trusted, with the mark it was trusted for.
      { address: WETH, symbol: 'WETH', decimals: 18, trusted: true, logo: 'data:image/png;base64,OLD' },
      // An old UNTRUSTED verdict is still correct under the new rule ("no mark"
      // fails it either way), so it is kept and not re-probed.
      { address: JUNK, symbol: 'JUNK', decimals: 18, trusted: false },
    ]);
    await state().loadEvmTokens();
    const weth = () => state().evmTokens.tracked.find((t) => t.address === WETH)!;
    const junk = () => state().evmTokens.tracked.find((t) => t.address === JUNK)!;
    expect(junk().trusted).toBe(false);
    // Until the re-check lands, the old claim is simply gone: no vouching, and
    // no warning it has not earned.
    await vi.waitFor(() => expect(weth().trustRule).toBe(mod.TOKEN_TRUST_RULE), { timeout: 10_000 });
    // This build has no gateway, so the mark alone decides and WETH (which has
    // one in the fake registry) is vouched for again, now stamped with the rule.
    expect(weth().trusted).toBe(true);
    expect(weth().logo?.startsWith('data:image/png')).toBe(true);
    expect(await getStorage().get(`evmTokens:${id}:base`)).toContainEqual(
      expect.objectContaining({ address: WETH, trustRule: mod.TOKEN_TRUST_RULE }),
    );
  }, 30_000);
});

describe('retireStaleTrust', () => {
  const token = { address: '0xabc', symbol: 'X', decimals: 18 };

  it('drops a trusted verdict (and its mark) recorded by an older rule', () => {
    const out = mod.retireStaleTrust({ ...token, trusted: true, logo: 'data:image/png;base64,OLD' });
    expect(out.trusted).toBeUndefined();
    expect(out.logo).toBeUndefined();
    expect(out.trustRule).toBeUndefined();
    expect(out.address).toBe('0xabc');
  });

  it('keeps a trusted verdict recorded by the current rule', () => {
    const current = { ...token, trusted: true as const, logo: 'data:x', trustRule: mod.TOKEN_TRUST_RULE };
    expect(mod.retireStaleTrust(current)).toBe(current);
  });

  it('keeps an untrusted verdict whatever the rule: no mark fails every version', () => {
    const old = { ...token, trusted: false as const };
    expect(mod.retireStaleTrust(old)).toBe(old);
  });

  it('leaves an unchecked token alone', () => {
    expect(mod.retireStaleTrust(token)).toBe(token);
  });
});
