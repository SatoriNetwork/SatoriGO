// enableChain with NO password on an open app-protected wallet (owner request
// 2026-10-04), through the STORE: the flag the switcher reads, the no-password
// path for every family, and the fall-back to the password field.
//
// Real LiveWalletService + in-memory storage (the liveStore.evm.test.ts shape):
// a WebSocket that refuses to connect keeps every UTXO read offline, and fetch
// answers nothing useful, so no refresh ever reaches a network.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => await import('../services/chain/evm'),
    // The Monero row exists only in a --monero build; the barrel is real.
    loadMoneroModules: async () => {
      const real = await import('../services/chain/monero');
      return { ...real, deleteMoneroCache: async () => {}, deleteAllMoneroCaches: async () => {} };
    },
  };
});

// Zcash and Bittensor read through the gateway; a configured one keeps their
// first refresh from throwing (fetch below answers 503, which they handle).
vi.mock('../services/gateway', () => ({
  GATEWAY_URL: 'https://gw.test',
  HAS_GATEWAY: true,
  GATEWAY_CLIENT_TOKEN: 'sgw_test',
  gatewayUrl: () => 'https://gw.test',
  gatewayHeaders: () => ({ 'X-Satori-Client': 'sgw_test' }),
}));

import { MemoryStorageAdapter, setStorageForTests, getStorage, type KeyValueStorage } from '../services/storage';
import { LiveWalletService } from '../services/chain/liveWallet';
import { resetEvmProvidersForTests } from './evmBalances';
import type { MoneroChainInfo } from './moneroChains';
import { deriveAddress, mnemonicToSeed } from '../services/chain/keys';
import { RAVENCOIN_MAINNET } from '../services/chain/chainParams';
import type { ElectrumClient } from '../services/chain/electrumTypes';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const offlineClient = {
  connect: async () => {},
  isConnected: () => false,
  endpoint: () => 'wss://fake',
  close: () => {},
  request: async () => {
    throw new Error('no network in unit tests');
  },
  setPoolChain: () => {},
} as unknown as ElectrumClient;

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_EVM_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ZEC_ADDRESS = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F';
const TAO_ADDRESS = '5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH';
const PW = 'wallet-password-one';
const APP_PW = 'one password for the whole wallet';
const NEW_APP_PW = 'a different app password entirely';
const ENTER_PW = 'Enter your password to continue.';

const XMR: MoneroChainInfo = {
  key: 'monero',
  displayName: 'Monero',
  nativeTicker: 'XMR',
  nativeDecimals: 12,
  homepage: 'https://getmonero.org',
  explorerTxUrl: 'https://xmrchain.net/tx/{txid}',
  nodeSets: ['main'],
  defaultNodeSet: 'main',
  releaseHeight: 3772358,
  coinType: 128,
  scheme: 'cake-exodus',
  young: false,
  recentlyAdded: true,
};

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
let storage: KeyValueStorage;
const state = () => mod.useLiveStore.getState();

/** The raw `liveWallets` object, detached, for byte-for-byte comparisons. */
async function rawStore(): Promise<unknown> {
  return JSON.parse(JSON.stringify((await getStorage().get('liveWallets')) ?? null));
}

async function ravencoinAddress(): Promise<string> {
  return deriveAddress(await mnemonicToSeed(VECTOR_MNEMONIC), RAVENCOIN_MAINNET, 0, 0, 0).address;
}

async function settle(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

/** A wallet with its own password, an app password, then the lazy migration
 *  on the next unlock: an open, app-protected (v2) wallet, as a user has it. */
async function openAppProtectedWallet() {
  await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
  expect((await state().setAppPassword(APP_PW)).ok).toBe(true);
  state().lock();
  expect(await state().unlockApp(APP_PW)).toBe(true);
  expect(state().phase).toBe('locked'); // still v1: its own prompt, once
  expect(await state().unlock(PW)).toBe(true); // migrates
  await state().loadWallets();
  expect(state().wallets.find((w) => w.active)?.appProtected).toBe(true);
}

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  mod = await import('./liveStore');
});

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  resetEvmProvidersForTests();
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
  await state().resetLiveWallet();
  await state().init();
  for (let i = 0; i < 50 && (state().evm.chains.length === 0 || !state().monero.chain); i++) await settle(5);
});

afterEach(async () => {
  state().stopAutoRefresh();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await settle();
});

describe('enableChain with no password: an open app-protected wallet', () => {
  it('UTXO: the flag is on, the sibling is born app-protected, and after lock + app unlock it opens at the same address', async () => {
    await openAppProtectedWallet();
    expect(await state().refreshEnableChainWithoutPassword()).toBe(true);
    expect(state().canEnableChainWithoutPassword).toBe(true);

    expect(await state().enableChain('ravencoin-mainnet', '')).toEqual({ ok: true });
    const rvn = state().wallets.find((w) => w.network === 'ravencoin-mainnet')!;
    expect(rvn.appProtected).toBe(true);
    expect(rvn.passwordless).toBe(false);
    expect(rvn.name).toBe('Main (Ravencoin)');
    expect(state().address).toBe(await ravencoinAddress());

    // Round trip: access is not lost.
    state().lock();
    expect(state().canEnableChainWithoutPassword).toBe(false);
    expect(await state().unlockApp(APP_PW)).toBe(true);
    expect(state().phase).toBe('ready');
    expect(state().activeWalletId).toBe(rvn.id);
    expect(state().address).toBe(await ravencoinAddress());
    expect(await state().revealMnemonic(APP_PW)).toBe(VECTOR_MNEMONIC);
  }, 120_000);

  it('EVM: one account, app-protected, opens again with the app password', async () => {
    await openAppProtectedWallet();
    expect(await state().enableChain('evm:base', '')).toEqual({ ok: true });
    const evm = state().wallets.find((w) => w.family === 'evm')!;
    expect(evm.appProtected).toBe(true);
    expect(evm.address).toBe(VECTOR_EVM_ADDRESS);
    state().lock();
    expect(await state().unlockApp(APP_PW)).toBe(true);
    expect(state().address).toBe(VECTOR_EVM_ADDRESS);
  }, 120_000);

  it('Zcash and Bittensor: app-protected siblings, reopen with the app password', async () => {
    await openAppProtectedWallet();
    expect(await state().enableChain('zec:mainnet', '')).toEqual({ ok: true });
    expect(state().address).toBe(ZEC_ADDRESS);
    // From the Zcash sibling: no seed in memory, the vault opens with the key.
    expect(await state().enableChain('tao:mainnet', '')).toEqual({ ok: true });
    expect(state().address).toBe(TAO_ADDRESS);
    for (const w of state().wallets) expect(w.appProtected).toBe(true);

    state().lock();
    expect(await state().unlockApp(APP_PW)).toBe(true);
    expect(state().address).toBe(TAO_ADDRESS);
    const zec = state().wallets.find((w) => w.family === 'zcash')!;
    await state().switchWallet(zec.id);
    await settle();
    expect(state().address).toBe(ZEC_ADDRESS);
  }, 120_000);

  it('Monero: the proven key replaces the password check; a stale key asks for the password and adds nothing', async () => {
    await openAppProtectedWallet();
    expect(state().monero.chain?.key).toBe(XMR.key);
    const add = vi
      .spyOn(LiveWalletService.prototype, 'addMoneroAccount')
      .mockResolvedValue({} as Awaited<ReturnType<LiveWalletService['addMoneroAccount']>>);
    const verify = vi.spyOn(LiveWalletService.prototype, 'verifyPassword');
    const realOpen = state().openAddedMoneroWallet;
    mod.useLiveStore.setState({ openAddedMoneroWallet: async () => {} });
    try {
      expect(await state().enableChain('xmr:mainnet', '')).toEqual({ ok: true });
      expect(add).toHaveBeenCalledTimes(1);
      expect(verify).not.toHaveBeenCalled();

      // Another page changes the app password: this page's key is stale.
      const other = new LiveWalletService(offlineClient);
      expect(await other.unlockApp(APP_PW)).toBe(true);
      expect(await other.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });
      add.mockClear();
      expect(await state().enableChain('xmr:mainnet', '')).toEqual({ ok: false, error: ENTER_PW, needsPassword: true });
      expect(add).not.toHaveBeenCalled();
      expect(state().canEnableChainWithoutPassword).toBe(false);
    } finally {
      mod.useLiveStore.setState({ openAddedMoneroWallet: realOpen });
    }
  }, 120_000);
});

describe('enableChain with no password: every other case still asks', () => {
  it('a v1 wallet with its OWN password: flag off, "" refused with nothing created, the password path unchanged (sibling stays v1)', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    expect((await state().setAppPassword(APP_PW)).ok).toBe(true); // key held, wallet still v1
    await state().loadWallets();
    expect(await state().refreshEnableChainWithoutPassword()).toBe(false);

    const before = await rawStore();
    const refused = await state().enableChain('ravencoin-mainnet', '');
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('Incorrect password.'); // the answer it always gave
    expect(await rawStore()).toEqual(before);

    expect(await state().enableChain('ravencoin-mainnet', PW)).toEqual({ ok: true });
    const rvn = state().wallets.find((w) => w.network === 'ravencoin-mainnet')!;
    expect(rvn.appProtected).toBeUndefined(); // v1, exactly as before this change
    expect(rvn.passwordless).toBe(false);
  }, 120_000);

  it('a STALE key (another page changed the app password): "" asks for the password, writes nothing; the NEW password works', async () => {
    await openAppProtectedWallet();
    expect(await state().refreshEnableChainWithoutPassword()).toBe(true);
    const other = new LiveWalletService(offlineClient);
    expect(await other.unlockApp(APP_PW)).toBe(true);
    expect(await other.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });

    const before = await rawStore();
    expect(await state().enableChain('ravencoin-mainnet', '')).toEqual({ ok: false, error: ENTER_PW, needsPassword: true });
    expect(await rawStore()).toEqual(before); // no vault zeroed, nothing added
    expect(state().canEnableChainWithoutPassword).toBe(false);
    expect(state().error).toBeNull();

    expect(await state().enableChain('ravencoin-mainnet', NEW_APP_PW)).toEqual({ ok: true });
    expect(state().address).toBe(await ravencoinAddress());
  }, 120_000);

  it('after lock(): refused without a password, nothing created', async () => {
    await openAppProtectedWallet();
    state().lock();
    expect(state().canEnableChainWithoutPassword).toBe(false);
    const before = await rawStore();
    expect(await state().enableChain('ravencoin-mainnet', '')).toEqual({ ok: false, error: ENTER_PW, needsPassword: true });
    expect(await rawStore()).toEqual(before);
  }, 120_000);

  it('a passwordless wallet: unchanged (no password, the sibling stays passwordless)', async () => {
    await state().importWallet(VECTOR_MNEMONIC, '', 'Open', 'mainnet');
    await state().loadWallets();
    expect(await state().refreshEnableChainWithoutPassword()).toBe(false);
    expect(await state().enableChain('ravencoin-mainnet', '')).toEqual({ ok: true });
    const rvn = state().wallets.find((w) => w.network === 'ravencoin-mainnet')!;
    expect(rvn.passwordless).toBe(true);
    expect(rvn.appProtected).toBeUndefined();
  }, 60_000);
});

describe('review fixes: ordering, binding, and a lock during the write', () => {
  /** Replace a store action for one test; returns the restore function. */
  function overrideAction<K extends 'closeMoneroHost' | 'openMoneroHost'>(key: K, fn: () => Promise<void>): () => void {
    const real = state()[key];
    mod.useLiveStore.setState({ [key]: fn } as never);
    return () => mod.useLiveStore.setState({ [key]: real } as never);
  }

  it('M1: a failed key check tears nothing down (an active Monero worker is not closed)', async () => {
    await openAppProtectedWallet();
    // Pretend the hint check passed, then make the key stale: PREPARE refuses.
    vi.spyOn(LiveWalletService.prototype, 'sessionKeyOpensActive').mockResolvedValue(true);
    const other = new LiveWalletService(offlineClient);
    expect(await other.unlockApp(APP_PW)).toBe(true);
    expect(await other.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });
    const close = vi.fn(async () => {});
    const restore = overrideAction('closeMoneroHost', close);
    try {
      const before = await rawStore();
      expect(await state().enableChain('ravencoin-mainnet', '')).toEqual({ ok: false, error: ENTER_PW, needsPassword: true });
      expect(close).not.toHaveBeenCalled();
      expect(await rawStore()).toEqual(before);
    } finally {
      restore();
    }
  }, 120_000);

  it('M1: a key that goes stale between prepare and the write reopens the Monero worker and asks for the password', async () => {
    await openAppProtectedWallet();
    let beforeCommit: unknown = null;
    const realPrepare = LiveWalletService.prototype.prepareSiblingWithSessionKey;
    vi.spyOn(LiveWalletService.prototype, 'prepareSiblingWithSessionKey').mockImplementation(async function (
      this: LiveWalletService,
      id: string | null,
    ) {
      const prepared = await realPrepare.call(this, id);
      const other = new LiveWalletService(offlineClient);
      expect(await other.unlockApp(APP_PW)).toBe(true);
      expect(await other.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });
      beforeCommit = await rawStore();
      return prepared;
    });
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => {});
    const restoreClose = overrideAction('closeMoneroHost', close);
    const restoreOpen = overrideAction('openMoneroHost', open);
    try {
      expect(await state().enableChain('ravencoin-mainnet', '')).toEqual({ ok: false, error: ENTER_PW, needsPassword: true });
      expect(close).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalled();
      expect(await rawStore()).toEqual(beforeCommit); // the write-time proof refused: nothing added
      expect(state().error).toBeNull();
    } finally {
      restoreClose();
      restoreOpen();
    }
  }, 120_000);

  it('M2: when the store and the service disagree about the active wallet, it asks for the password and creates nothing', async () => {
    await openAppProtectedWallet();
    const mainId = state().activeWalletId!;
    expect(await state().enableChain('ravencoin-mainnet', '')).toEqual({ ok: true });
    // The service is now on the Ravencoin sibling; point the STORE back at Main.
    mod.useLiveStore.setState({
      activeWalletId: mainId,
      wallets: state().wallets.map((w) => ({ ...w, active: w.id === mainId })),
    });
    const before = await rawStore();
    expect(await state().enableChain('litecoin-mainnet', '')).toEqual({ ok: false, error: ENTER_PW, needsPassword: true });
    expect(await rawStore()).toEqual(before);
  }, 120_000);

  it('M3: a lock pressed while the sibling is being written leaves the app locked (the wallet exists and opens later)', async () => {
    await openAppProtectedWallet();
    const realPrepare = LiveWalletService.prototype.prepareSiblingWithSessionKey;
    vi.spyOn(LiveWalletService.prototype, 'prepareSiblingWithSessionKey').mockImplementation(async function (
      this: LiveWalletService,
      id: string | null,
    ) {
      const prepared = await realPrepare.call(this, id);
      return {
        discard: prepared.discard,
        commit: async (...args: Parameters<typeof prepared.commit>) => {
          await prepared.commit(...args);
          state().lock(); // the user presses Lock as the write lands
        },
      };
    });
    expect(await state().enableChain('ravencoin-mainnet', '')).toEqual({ ok: true });
    expect(state().phase).toBe('app-locked');
    expect(state().address).toBe('');
    expect(state().appUnlocked).toBe(false);
    vi.restoreAllMocks();
    // Nothing is lost: the sibling is there and opens with the app password.
    expect(await state().unlockApp(APP_PW)).toBe(true);
    expect(state().phase).toBe('ready');
    expect(state().address).toBe(await ravencoinAddress());
  }, 120_000);
});
