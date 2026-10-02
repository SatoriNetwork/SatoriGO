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

describe('Monero family (the Monero engine design notes §8)', () => {
  it('5. a monero entry resolves to its own family; absent still means utxo', async () => {
    const { isMoneroWallet, MONERO_NETWORK, loadMoneroModules } = await import('./engine');
    expect(walletFamily({ family: 'monero' })).toBe('monero');
    expect(isMoneroWallet({ family: 'monero' })).toBe(true);
    expect(isMoneroWallet({ family: 'evm' })).toBe(false);
    expect(isMoneroWallet({})).toBe(false);
    expect(isEvmWallet({ family: 'monero' })).toBe(false);
    // The entry's `network` and the switcher id are one string, in the same
    // namespace as the UTXO ids and the `evm:<key>` targets.
    expect(MONERO_NETWORK).toBe('xmr:mainnet');
    // vitest.config.ts mirrors vite.config.ts: MONERO_ENABLED unset => false,
    // and then no monero/ module loads (what a flagless package ships).
    expect(__MONERO_ENABLED__).toBe(process.env.MONERO_ENABLED === '1');
    if (!__MONERO_ENABLED__) {
      expect(await loadMoneroModules()).toBe(null);
    } else {
      const mods = await loadMoneroModules();
      expect(mods).not.toBe(null);
      expect(mods!.MONERO_RELEASE_HEIGHT).toBe(3772358);
    }
  });
});

describe('Zcash and Substrate families (their design notes §8), no build flag', () => {
  it('6. a zcash entry resolves to its own family and target; absent still means utxo', async () => {
    const { isZcashWallet, isMoneroWallet, ZCASH_NETWORK } = await import('./engine');
    expect(walletFamily({ family: 'zcash' })).toBe('zcash');
    expect(isZcashWallet({ family: 'zcash' })).toBe(true);
    expect(isZcashWallet({ family: 'monero' })).toBe(false);
    expect(isZcashWallet({})).toBe(false);
    expect(isMoneroWallet({ family: 'zcash' })).toBe(false);
    expect(isEvmWallet({ family: 'zcash' })).toBe(false);
    expect(ZCASH_NETWORK).toBe('zec:mainnet');
  });

  it('7. a substrate entry resolves to its own family; the target names the one chain, Bittensor', async () => {
    const { isSubstrateWallet, isZcashWallet, TAO_NETWORK } = await import('./engine');
    expect(walletFamily({ family: 'substrate' })).toBe('substrate');
    expect(isSubstrateWallet({ family: 'substrate' })).toBe(true);
    expect(isSubstrateWallet({ family: 'zcash' })).toBe(false);
    expect(isSubstrateWallet({})).toBe(false);
    expect(isZcashWallet({ family: 'substrate' })).toBe(false);
    expect(TAO_NETWORK).toBe('tao:mainnet');
  });

  it('8. the five families are distinct strings in one namespace with the UTXO ids and the evm targets', async () => {
    const { EVM_NETWORK, MONERO_NETWORK, ZCASH_NETWORK, TAO_NETWORK } = await import('./engine');
    const sentinels = [EVM_NETWORK, MONERO_NETWORK, ZCASH_NETWORK, TAO_NETWORK];
    expect(new Set(sentinels).size).toBe(sentinels.length);
    for (const s of sentinels) expect(s).not.toMatch(/-mainnet$|^mainnet$|^testnet$/);
  });
});
