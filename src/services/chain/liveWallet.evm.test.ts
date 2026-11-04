// LiveWalletService with an EVM account (family 'evm'), phase 3 engine wiring.
//
// One account = one address on every EVM chain: create/import derive the
// MetaMask address for the same words (m/44'/60'/0'/0/0), the chain the UI
// shows is a persisted preference that never touches the address, and
// signEvmTransaction is the only place a key meets a transaction. Everything
// UTXO-shaped refuses on an EVM account instead of guessing. The Electrum client
// is a stub that never connects; the EVM engine is loaded through a mocked
// loadEvmModules (the test config has the flag off, like a shipped package,
// which the last test pins: no engine, no EVM wallet).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ evmEnabled: true }));

vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>();
  return {
    ...actual,
    loadEvmModules: async () => (hoisted.evmEnabled ? await import('./evm') : null),
  };
});

import { LiveWalletService, EVM_NETWORK, type WalletEntry } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import type { ElectrumClient } from './electrumTypes';
import { recoverTxPublicKey, decodeSignedTx, deriveEvrmoreKeyAsEvm, type EvmTxRequest } from './evm';
import { deriveAddress, encodeWif, mnemonicToSeed } from './keys';
import { EVRMORE_MAINNET } from './chainParams';
import * as secp256k1 from '@noble/secp256k1';
import { hexToBytes } from '@noble/hashes/utils';

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ADDRESS_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const VECTOR_PRIVATE_KEY_0 = '1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727';
const KEY_ONE_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const PW = 'password123';

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

async function storedWallets(): Promise<WalletEntry[]> {
  const store = await getStorage().get<{ wallets: WalletEntry[] }>('liveWallets');
  return store?.wallets ?? [];
}

const sampleTx = (chainId: number): EvmTxRequest => ({
  chainId,
  nonce: 0n,
  to: '0x3535353535353535353535353535353535353535',
  value: 10n ** 15n,
  data: new Uint8Array(),
  gasLimit: 21000n,
  fee: { type: 'eip1559', maxFeePerGas: 11_100_000n, maxPriorityFeePerGas: 1_100_000n },
});

beforeEach(() => {
  hoisted.evmEnabled = true;
  setStorageForTests(new MemoryStorageAdapter());
});

afterEach(() => {
  hoisted.evmEnabled = true;
});

describe('LiveWalletService: EVM account', () => {
  it('1. import(family evm) derives the MetaMask address for the words, stores family/network/evmChainKey, and is unlocked', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'My EVM', '', { family: 'evm', evmChainKey: 'base' });
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.activeWalletFamily()).toBe('evm');
    expect(svc.evmChainKey()).toBe('base');
    expect(svc.getAddress()).toBe(VECTOR_ADDRESS_0);
    expect(await svc.listAddresses()).toEqual([{ index: 0, address: VECTOR_ADDRESS_0 }]);

    const [entry] = await storedWallets();
    expect(entry.family).toBe('evm');
    expect(entry.network).toBe(EVM_NETWORK);
    expect(entry.evmChainKey).toBe('base');
    expect(entry.address).toBe(VECTOR_ADDRESS_0);
    expect(entry.kind).toBe('seed');
    const [summary] = await svc.listWallets();
    expect(summary.family).toBe('evm');
    expect(summary.evmChainKey).toBe('base');
    // The UTXO Electrum side was left alone (still the default chain).
    expect(svc.network()).toBe('mainnet');
  }, 30_000);

  it('2. lock/unlock round-trips the EVM account and refuses a wrong password', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', undefined, '', { family: 'evm' });
    svc.lock();
    expect(svc.isUnlocked()).toBe(false);
    expect(() => svc.getAddress()).toThrow();
    expect(await svc.unlock('wrong')).toBe(false);
    expect(await svc.unlock(PW)).toBe(true);
    expect(svc.getAddress()).toBe(VECTOR_ADDRESS_0);
    expect(svc.evmChainKey()).toBe('base'); // default chain when none was given
  }, 30_000);

  it('3. an unknown evmChainKey at creation falls back to the default chain', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.create(PW, { family: 'evm', evmChainKey: 'not-a-chain' });
    expect(svc.evmChainKey()).toBe('base');
  }, 30_000);

  it('4. setEvmChainKey persists the shown chain and NEVER changes the address; unknown keys are refused', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', undefined, '', { family: 'evm', evmChainKey: 'base' });
    await svc.setEvmChainKey('bsc');
    expect(svc.evmChainKey()).toBe('bsc');
    expect(svc.getAddress()).toBe(VECTOR_ADDRESS_0);
    expect((await storedWallets())[0].evmChainKey).toBe('bsc');
    await expect(svc.setEvmChainKey('polygon')).rejects.toThrow(/unknown EVM chain/);
    // Survives a lock/unlock (it is read back from the entry).
    svc.lock();
    await svc.unlock(PW);
    expect(svc.evmChainKey()).toBe('bsc');
  }, 30_000);

  it('5. signEvmTransaction signs with the account key (recovered signer = derived key), and refuses when locked', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', undefined, '', { family: 'evm' });
    const signed = svc.signEvmTransaction(sampleTx(8453));
    const expectedPub = secp256k1.getPublicKey(hexToBytes(VECTOR_PRIVATE_KEY_0), false);
    expect(Buffer.from(recoverTxPublicKey(signed.raw)).toString('hex')).toBe(Buffer.from(expectedPub).toString('hex'));
    const decoded = decodeSignedTx(signed.raw);
    expect(decoded.tx.chainId).toBe(8453);
    expect(decoded.tx.value).toBe(10n ** 15n);
    svc.lock();
    expect(() => svc.signEvmTransaction(sampleTx(8453))).toThrow(/locked/);
  }, 30_000);

  it('6. UTXO operations refuse on an EVM account, and a UTXO wallet refuses EVM signing', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', undefined, '', { family: 'evm' });
    expect(() => svc.deriveKey(0)).toThrow(/UTXO operation/);
    await expect(svc.addReceiveAddress()).rejects.toThrow('single-address-wallet');
    await expect(svc.keysHoldingAsset('SATORIEVR')).rejects.toThrow(/UTXO operation/);
    // Sibling UTXO wallet from the same words: a different family, a different address.
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVR');
    expect(svc.activeWalletFamily()).toBe('utxo');
    expect(svc.getAddress().startsWith('E')).toBe(true);
    expect(() => svc.signEvmTransaction(sampleTx(8453))).toThrow('not-an-evm-wallet');
    await expect(svc.setEvmChainKey('bsc')).rejects.toThrow('not-an-evm-wallet');
    expect(svc.evmChainKey()).toBe(null);
  }, 45_000);

  it('7. switchWallet between a UTXO wallet and an EVM account follows the family both ways', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'ravencoin-mainnet', 'RVN');
    const rvnId = svc.activeWalletId()!;
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm', evmChainKey: 'bsc' });
    const evmId = svc.activeWalletId()!;
    await svc.switchWallet(rvnId);
    expect(svc.activeWalletFamily()).toBe('utxo');
    expect(svc.network()).toBe('ravencoin-mainnet');
    await svc.unlock(PW);
    expect(svc.getAddress().startsWith('R')).toBe(true);
    await svc.switchWallet(evmId);
    expect(svc.activeWalletFamily()).toBe('evm');
    expect(svc.evmChainKey()).toBe('bsc');
    // The Electrum side stays on the last UTXO chain (idle), it is not re-pointed.
    expect(svc.network()).toBe('ravencoin-mainnet');
    await svc.unlock(PW);
    expect(svc.getAddress()).toBe(VECTOR_ADDRESS_0);
  }, 60_000);

  it('8. importPrivateKey(family evm) with a raw hex key: 0x7E5F… for key 1, kind pk', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.importPrivateKey('0x' + '0'.repeat(63) + '1', PW, 'mainnet', 'Imported', { family: 'evm' });
    expect(svc.getAddress()).toBe(KEY_ONE_ADDRESS);
    const [entry] = await storedWallets();
    expect(entry.kind).toBe('pk');
    expect(entry.family).toBe('evm');
    svc.lock();
    await svc.unlock(PW);
    expect(svc.getAddress()).toBe(KEY_ONE_ADDRESS);
    const signed = svc.signEvmTransaction(sampleTx(56));
    expect(Buffer.from(recoverTxPublicKey(signed.raw)).toString('hex')).toBe(
      Buffer.from(secp256k1.getPublicKey(hexToBytes('0'.repeat(63) + '1'), false)).toString('hex'),
    );
  }, 45_000);

  it('8b. a WIF imports as the same key: same address and signer as its hex, in every WIF form', async () => {
    const hex = '0'.repeat(63) + '1';
    const key = hexToBytes(hex);
    for (const wif of [encodeWif(key, EVRMORE_MAINNET, true), encodeWif(key, EVRMORE_MAINNET, false)]) {
      const svc = new LiveWalletService(offlineClient);
      await svc.importPrivateKey(wif, PW, 'mainnet', 'From Evrmore', { family: 'evm', evmChainKey: 'base' });
      expect(svc.getAddress()).toBe(KEY_ONE_ADDRESS);
      svc.lock();
      await svc.unlock(PW);
      expect(svc.getAddress()).toBe(KEY_ONE_ADDRESS);
      expect(Buffer.from(recoverTxPublicKey(svc.signEvmTransaction(sampleTx(8453)).raw)).toString('hex')).toBe(
        Buffer.from(secp256k1.getPublicKey(key, false)).toString('hex'),
      );
      // What the vault holds, and what reveal hands back, is the hex form.
      expect(await svc.revealPrivateKeyWif(PW)).toBe(hex);
      setStorageForTests(new MemoryStorageAdapter());
    }
  }, 60_000);

  it('8c. a seed\'s Evrmore WIF lands on the address the Rewards screen calls its old key', async () => {
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC, '');
    const evr = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0);
    const svc = new LiveWalletService(offlineClient);
    await svc.importPrivateKey(encodeWif(evr.privateKey, EVRMORE_MAINNET, true), PW, 'mainnet', undefined, { family: 'evm', evmChainKey: 'base' });
    expect(svc.getAddress()).toBe(deriveEvrmoreKeyAsEvm(seed, 0).address);
  }, 45_000);

  it('8d. a mistyped WIF or a short hex imports nothing', async () => {
    const svc = new LiveWalletService(offlineClient);
    const wif = encodeWif(hexToBytes('0'.repeat(63) + '1'), EVRMORE_MAINNET, true);
    const mistyped = wif.slice(0, -1) + (wif.endsWith('a') ? 'b' : 'a');
    await expect(svc.importPrivateKey(mistyped, PW, 'mainnet', undefined, { family: 'evm' })).rejects.toThrow();
    await expect(svc.importPrivateKey('abc123', PW, 'mainnet', undefined, { family: 'evm' })).rejects.toThrow();
    await expect(svc.importPrivateKey('0'.repeat(64), PW, 'mainnet', undefined, { family: 'evm' })).rejects.toThrow(/secp256k1/);
    expect(await storedWallets()).toHaveLength(0);
  }, 45_000);

  it('9. revealPrivateKeyWif on an EVM seed wallet returns the 0x hex key MetaMask imports', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', undefined, '', { family: 'evm' });
    expect(await svc.revealPrivateKeyWif(PW)).toBe('0x' + VECTOR_PRIVATE_KEY_0);
    expect(await svc.revealPrivateKeyWif('wrong')).toBe(null);
  }, 30_000);

  it('10. a passwordless EVM account unlocks with the empty password', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, '', 'mainnet', undefined, '', { family: 'evm' });
    svc.lock();
    expect(await svc.unlock('')).toBe(true);
    expect(svc.getAddress()).toBe(VECTOR_ADDRESS_0);
  }, 30_000);

  it('11. a build without the EVM engine cannot create, import or unlock an EVM account (and writes nothing)', async () => {
    hoisted.evmEnabled = false;
    const svc = new LiveWalletService(offlineClient);
    await expect(svc.create(PW, { family: 'evm' })).rejects.toThrow(/no EVM engine/);
    await expect(svc.import(VECTOR_MNEMONIC, PW, 'mainnet', undefined, '', { family: 'evm' })).rejects.toThrow(/no EVM engine/);
    expect(await storedWallets()).toEqual([]);
    // A UTXO wallet is unaffected.
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet');
    expect(svc.getAddress().startsWith('E')).toBe(true);
  }, 30_000);
});
