// Two settings that must land under the right key for the ACTIVE TARGET, not
// the idle UTXO chain a Zcash/Bittensor/Monero/EVM wallet leaves behind in
// activeChainId():
//   * the block-explorer template (Settings > Servers & explorer), which used
//     to be saved under the last UTXO chain's key from an engine wallet, so a
//     Zcash explorer typed there rewrote Evrmore's link and vanished from the
//     Zcash field on the next reload;
//   * the hidden-chains list, which init() read back through networkFor() and
//     so collapsed every engine/EVM target to 'evrmore-mainnet' and dropped it.
//
// Real store and service (one Evrmore wallet imported offline); the engine
// family is what the service is spied to answer, so no gateway is touched.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageAdapter, setStorageForTests, type KeyValueStorage } from '../services/storage';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'password123';

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
let storage: KeyValueStorage;
const state = () => mod.useLiveStore.getState();

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  mod = await import('./liveStore');
});

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  await state().resetLiveWallet();
});

afterEach(() => {
  state().stopAutoRefresh();
  vi.restoreAllMocks();
});

describe('setExplorerUrlTemplate persists under the active TARGET', () => {
  it('from a Zcash wallet writes the zec-mainnet key and leaves the Evrmore key alone', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Wallet 1', 'mainnet');
    // The service still names Evrmore as its (idle) UTXO chain; only the
    // family says the active wallet is the Zcash sibling.
    vi.spyOn(mod.liveService(), 'activeWalletFamily').mockReturnValue('zcash');
    expect(mod.activeChainTarget()).toBe('zec:mainnet');

    state().setExplorerUrlTemplate('https://zec.example/tx/{txid}');

    expect(await storage.get<string>('explorerUrlTemplate:zec-mainnet')).toBe('https://zec.example/tx/{txid}');
    expect(await storage.get<string>('explorerUrlTemplate')).toBeUndefined();
    expect(state().explorerUrlTemplate).toBe('https://zec.example/tx/{txid}');
  }, 30_000);

  it('from a Bittensor wallet writes the tao-mainnet key; from Evrmore the legacy bare key', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Wallet 1', 'mainnet');
    const spy = vi.spyOn(mod.liveService(), 'activeWalletFamily').mockReturnValue('substrate');
    state().setExplorerUrlTemplate('https://tao.example/x/{txid}');
    expect(await storage.get<string>('explorerUrlTemplate:tao-mainnet')).toBe('https://tao.example/x/{txid}');

    spy.mockReturnValue('utxo');
    state().setExplorerUrlTemplate('https://evr.example/tx/{txid}');
    expect(await storage.get<string>('explorerUrlTemplate')).toBe('https://evr.example/tx/{txid}');
    // Neither write touched the other's slot.
    expect(await storage.get<string>('explorerUrlTemplate:tao-mainnet')).toBe('https://tao.example/x/{txid}');
    expect(await storage.get<string>('explorerUrlTemplate:zec-mainnet')).toBeUndefined();
  }, 30_000);
});

describe('hidden chains survive a reload', () => {
  it('setChainHidden then init() reads the same Zcash, Bittensor and EVM ids back', async () => {
    await state().init();
    state().setChainHidden('zec:mainnet', true);
    state().setChainHidden('tao:mainnet', true);
    state().setChainHidden('evm:avalanche', true);
    state().setChainHidden('ravencoin-mainnet', true);
    expect(await storage.get<string[]>('hiddenChains')).toEqual(['zec:mainnet', 'tao:mainnet', 'evm:avalanche', 'ravencoin-mainnet']);

    // The popup reopens: a fresh init() from the same storage.
    mod.useLiveStore.setState({ hiddenChains: [] });
    await state().init();
    expect(state().hiddenChains).toEqual(['zec:mainnet', 'tao:mainnet', 'evm:avalanche', 'ravencoin-mainnet']);

    // Showing one again removes exactly that one.
    state().setChainHidden('tao:mainnet', false);
    await state().init();
    expect(state().hiddenChains).toEqual(['zec:mainnet', 'evm:avalanche', 'ravencoin-mainnet']);
  }, 30_000);
});
