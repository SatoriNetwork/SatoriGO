import { describe, expect, it } from 'vitest';
import { DEFAULT_WALLET_FAMILY, isEvmWallet, loadEvmModules, walletFamily } from './engine';
import { LiveWalletService } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import type { ElectrumClient } from './electrumTypes';

// The utxo engine owns an Electrum client; a stub that never connects keeps this
// test offline (no socket is opened by the constructor, but no chance is taken).
const offlineClient = {
  connect: async () => {},
  isConnected: () => false,
  endpoint: () => 'wss://fake',
  close: () => {},
  request: async () => {
    throw new Error('no network in unit tests');
  },
} as unknown as ElectrumClient;

describe('walletFamily: absent means utxo (the whole migration)', () => {
  it('1. an entry without `family` is utxo, so every pre-EVM wallet keeps working', () => {
    expect(walletFamily({})).toBe('utxo');
    expect(walletFamily({ family: undefined })).toBe('utxo');
    expect(walletFamily(null)).toBe('utxo');
    expect(walletFamily(undefined)).toBe('utxo');
    expect(DEFAULT_WALLET_FAMILY).toBe('utxo');
  });

  it('2. an explicit family is returned as stored', () => {
    expect(walletFamily({ family: 'utxo' })).toBe('utxo');
    expect(walletFamily({ family: 'evm' })).toBe('evm');
    expect(isEvmWallet({ family: 'evm' })).toBe(true);
    expect(isEvmWallet({})).toBe(false);
  });

  it('3. LiveWalletService is the utxo engine and its summaries resolve family', async () => {
    setStorageForTests(new MemoryStorageAdapter());
    const svc = new LiveWalletService(offlineClient);
    expect(svc.family).toBe('utxo');
    // Fresh install: no wallets, but the summary shape is what the store scopes by.
    expect(await svc.listWallets()).toEqual([]);
  });
});

describe('EVM build flag', () => {
  it('4. with __EVM_ENABLED__ off (the default, what a store package ships) no EVM module loads', async () => {
    // vitest.config.ts mirrors vite.config.ts: EVM_ENABLED unset => false.
    expect(__EVM_ENABLED__).toBe(process.env.EVM_ENABLED === '1');
    if (!__EVM_ENABLED__) {
      expect(await loadEvmModules()).toBe(null);
    } else {
      const mods = await loadEvmModules();
      expect(mods).not.toBe(null);
      expect(mods!.EVM_CHAINS.length).toBe(2);
    }
  });
});
