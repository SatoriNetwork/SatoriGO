// MetaMask-style accounts on ONE EVM seed (the EVM accounts design notes).
//
// One recovery phrase carries Account 1, Account 2, ... at address indexes
// 0, 1, ... of m/44'/60'/0'/0. Each account is its own wallet ENTRY (own name,
// own token lists, own history) holding a COPY of the one vault record, so:
//   * every derive path uses the entry's own index, never a hardcoded 0,
//   * switching between accounts of one seed keeps the session unlocked,
//   * changePassword moves the whole group at once, and
//   * discovery finds the accounts the words already use elsewhere.
//
// Same harness as liveWallet.evm.test.ts: a stub Electrum client that never
// connects and the EVM engine loaded through a mocked loadEvmModules.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>();
  return { ...actual, loadEvmModules: async () => await import('./evm') };
});

import { EVM_ACCOUNT_SCAN_MAX, LiveWalletService, type WalletEntry } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { mnemonicToSeed } from './keys';
import type { ElectrumClient } from './electrumTypes';
import { deriveEvmKey, recoverTxPublicKey, type EvmTxRequest } from './evm';
import * as secp256k1 from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// A second, unrelated seed: switching to it must LOCK (different words, and by
// construction a different password).
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
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

const sampleTx = (chainId: number): EvmTxRequest => ({
  chainId,
  nonce: 0n,
  to: '0x3535353535353535353535353535353535353535',
  value: 10n ** 15n,
  data: new Uint8Array(),
  gasLimit: 21000n,
  fee: { type: 'eip1559', maxFeePerGas: 11_100_000n, maxPriorityFeePerGas: 1_100_000n },
});

async function storedWallets(): Promise<WalletEntry[]> {
  const store = await getStorage().get<{ wallets: WalletEntry[]; activeId: string }>('liveWallets');
  return store?.wallets ?? [];
}

/** The addresses/keys of the vector seed, derived independently of the service. */
async function vectorKeys(index: number): Promise<{ address: string; privateKey: string }> {
  const seed = await mnemonicToSeed(VECTOR_MNEMONIC, '');
  const key = deriveEvmKey(seed, index);
  return { address: key.address, privateKey: bytesToHex(key.privateKey) };
}

/** A probe that calls the given indexes (1-based) used and nothing else. */
function probeUsing(...usedIndexes: number[]) {
  const seen: string[][] = [];
  const probe = async (addresses: string[]): Promise<boolean[]> => {
    seen.push(addresses);
    return addresses.map((_, i) => usedIndexes.includes(i + 1));
  };
  return { probe, seen };
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

describe('LiveWalletService: EVM accounts on one seed', () => {
  it('1. import writes Account 1 as index 0 with its own address as the seed group', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'My EVM', '', { family: 'evm', evmChainKey: 'base' });
    const [entry] = await storedWallets();
    const zero = await vectorKeys(0);
    expect(entry.hdIndex).toBe(0);
    expect(entry.seedGroup).toBe(zero.address.toLowerCase());
    expect(entry.address).toBe(zero.address);
  }, 30_000);

  it('2. addEvmAccount derives index 1, names it Account 2, copies the vault and becomes active WITHOUT locking', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'My EVM', '', { family: 'evm', evmChainKey: 'bsc' });
    const first = svc.activeWalletId()!;
    const zero = await vectorKeys(0);
    const one = await vectorKeys(1);

    const added = await svc.addEvmAccount();
    expect(added.hdIndex).toBe(1);
    expect(added.address).toBe(one.address);
    expect(added.address).not.toBe(zero.address);

    // Active, and still unlocked: the same words, one index along.
    expect(svc.activeWalletId()).toBe(added.id);
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getAddress(0)).toBe(one.address);
    expect(await svc.listAddresses()).toEqual([{ index: 0, address: one.address }]);

    const wallets = await storedWallets();
    expect(wallets).toHaveLength(2);
    const account2 = wallets[1];
    expect(account2.name).toBe('Account 2');
    expect(account2.kind).toBe('seed');
    expect(account2.family).toBe('evm');
    expect(account2.hdIndex).toBe(1);
    expect(account2.seedGroup).toBe(zero.address.toLowerCase());
    expect(account2.evmChainKey).toBe('bsc'); // inherits what the source shows
    // Byte-for-byte the same ciphertext: one seed, one secret, one password.
    expect(account2.vault).toEqual(wallets[0].vault);

    // The copy really opens with the SAME password (and not with another one).
    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.unlock('wrong')).toBe(false);
    expect(await fresh.unlock(PW)).toBe(true);
    expect(fresh.getAddress(0)).toBe(one.address);

    // A third account takes the next free index and inherits the name pattern.
    await svc.switchWallet(first);
    const third = await svc.addEvmAccount();
    expect(third.hdIndex).toBe(2);
    expect((await storedWallets())[2].name).toBe('Account 3');
    // An explicit name wins.
    const named = await svc.addEvmAccount('Savings');
    expect(named.hdIndex).toBe(3);
    expect((await storedWallets())[3].name).toBe('Savings');
  }, 45_000);

  it('3. switching between accounts of one seed keeps the session unlocked; a different seed locks', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm' });
    const account1 = svc.activeWalletId()!;
    const account2 = (await svc.addEvmAccount()).id;
    const zero = await vectorKeys(0);
    const one = await vectorKeys(1);

    await svc.switchWallet(account1);
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getAddress(0)).toBe(zero.address);
    await svc.switchWallet(account2);
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getAddress(0)).toBe(one.address);

    // A DIFFERENT seed is a different secret under a different password: lock.
    await svc.import(OTHER_MNEMONIC, 'other-pw', 'mainnet', 'Other', '', { family: 'evm' });
    const otherId = svc.activeWalletId()!;
    await svc.switchWallet(account2);
    expect(svc.isUnlocked()).toBe(false);
    expect(await svc.unlock(PW)).toBe(true);
    await svc.switchWallet(otherId);
    expect(svc.isUnlocked()).toBe(false);

    // A UTXO wallet of the SAME words is another family: it locks too.
    expect(await svc.unlock('other-pw')).toBe(true);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVR');
    const utxoId = svc.activeWalletId()!;
    await svc.switchWallet(account1);
    expect(svc.isUnlocked()).toBe(false);
    expect(await svc.unlock(PW)).toBe(true);
    await svc.switchWallet(utxoId);
    expect(svc.isUnlocked()).toBe(false);
  }, 60_000);

  it('4. changePassword re-encrypts EVERY account of the seed, and only that seed', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm' });
    const account1 = svc.activeWalletId()!;
    const account2 = (await svc.addEvmAccount()).id;
    // A second, unrelated wallet that must NOT be touched.
    await svc.import(OTHER_MNEMONIC, 'other-pw', 'mainnet', 'Other', '', { family: 'evm' });
    const otherId = svc.activeWalletId()!;

    await svc.switchWallet(account1);
    expect(await svc.unlock(PW)).toBe(true);
    expect(await svc.changePassword(PW, 'new-password')).toBe(true);

    const one = await vectorKeys(1);
    const fresh = new LiveWalletService(offlineClient);
    await fresh.switchWallet(account2);
    expect(await fresh.unlock(PW)).toBe(false); // the old password is gone here too
    expect(await fresh.unlock('new-password')).toBe(true);
    expect(fresh.getAddress(0)).toBe(one.address);
    // Account 1 moved as well.
    await fresh.switchWallet(account1);
    expect(await fresh.unlock('new-password')).toBe(true);
    // The other seed kept its own password.
    await fresh.switchWallet(otherId);
    expect(await fresh.unlock('new-password')).toBe(false);
    expect(await fresh.unlock('other-pw')).toBe(true);
  }, 60_000);

  it('5. discoverEvmAccounts creates every index up to the highest used one, once', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm' });
    const account1 = svc.activeWalletId()!;
    const { probe, seen } = probeUsing(3);

    const res = await svc.discoverEvmAccounts(probe);
    expect(res).toEqual({ added: 3, highest: 3 });
    // ONE call, with every candidate index 1..MAX in order.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(EVM_ACCOUNT_SCAN_MAX);
    expect(seen[0][0]).toBe((await vectorKeys(1)).address);
    expect(seen[0][EVM_ACCOUNT_SCAN_MAX - 1]).toBe((await vectorKeys(EVM_ACCOUNT_SCAN_MAX)).address);

    const wallets = await storedWallets();
    expect(wallets.map((w) => `${w.name}@${w.hdIndex}`)).toEqual([
      'EVM@0',
      'Account 2@1',
      'Account 3@2',
      'Account 4@3',
    ]);
    for (let i = 1; i <= 3; i++) expect(wallets[i].address).toBe((await vectorKeys(i)).address);
    // The active account is untouched: discovery finds, it does not switch.
    expect(svc.activeWalletId()).toBe(account1);
    expect(svc.isUnlocked()).toBe(true);

    // Idempotent: the same answer a second time adds nothing.
    expect(await svc.discoverEvmAccounts(probeUsing(3).probe)).toEqual({ added: 0, highest: 3 });
    expect(await storedWallets()).toHaveLength(4);
    // Nothing used: nothing created.
    const empty = new LiveWalletService(offlineClient);
    setStorageForTests(new MemoryStorageAdapter());
    await empty.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm' });
    expect(await empty.discoverEvmAccounts(probeUsing().probe)).toEqual({ added: 0, highest: 0 });
    expect(await storedWallets()).toHaveLength(1);
  }, 60_000);

  it('6. account operations refuse clearly when locked, on a pk wallet and on a UTXO wallet', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm' });
    svc.lock();
    await expect(svc.addEvmAccount()).rejects.toThrow('locked');
    await expect(svc.discoverEvmAccounts(probeUsing(1).probe)).rejects.toThrow('locked');

    await svc.importPrivateKey('0x' + '0'.repeat(63) + '1', PW, 'mainnet', 'Key', { family: 'evm' });
    await expect(svc.addEvmAccount()).rejects.toThrow('not-evm-seed');

    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVR');
    await expect(svc.addEvmAccount()).rejects.toThrow('not-evm-seed');
    await expect(svc.discoverEvmAccounts(probeUsing(1).probe)).rejects.toThrow('not-evm-seed');
  }, 45_000);

  it('7. an entry stored BEFORE the feature gets its seed group backfilled on unlock', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm' });
    const zero = await vectorKeys(0);

    // Rewrite the record as an older build wrote it: no hdIndex, no seedGroup.
    const raw = await getStorage().get<{ version: 1; wallets: WalletEntry[]; activeId: string }>('liveWallets');
    const legacy = { ...raw!.wallets[0] };
    delete legacy.hdIndex;
    delete legacy.seedGroup;
    await getStorage().set('liveWallets', { ...raw!, wallets: [legacy] });

    const reopened = new LiveWalletService(offlineClient);
    // Before the unlock the summary carries neither field, and nothing pretends.
    const before = await reopened.listWallets();
    expect(before[0]).not.toHaveProperty('seedGroup');
    expect(before[0]).not.toHaveProperty('hdIndex');
    expect(await reopened.unlock(PW)).toBe(true);
    expect(reopened.getAddress(0)).toBe(zero.address);

    const [backfilled] = await storedWallets();
    expect(backfilled.hdIndex).toBe(0);
    expect(backfilled.seedGroup).toBe(zero.address.toLowerCase());
    // And it can grow accounts from there like any other.
    const added = await reopened.addEvmAccount();
    expect(added.hdIndex).toBe(1);
    expect(added.address).toBe((await vectorKeys(1)).address);
  }, 45_000);

  it('8. listWallets carries hdIndex/seedGroup for EVM seed accounts only', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVR'); // UTXO seed wallet
    await svc.importPrivateKey('0x' + '0'.repeat(63) + '1', PW, 'mainnet', 'Key', { family: 'evm' });
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm' });
    await svc.addEvmAccount();

    const list = await svc.listWallets();
    const byName = (name: string) => list.find((w) => w.name === name)!;
    expect(byName('EVR')).not.toHaveProperty('hdIndex');
    expect(byName('EVR')).not.toHaveProperty('seedGroup');
    expect(byName('Key')).not.toHaveProperty('hdIndex'); // EVM, but a single key
    expect(byName('Key')).not.toHaveProperty('seedGroup');
    const zero = await vectorKeys(0);
    expect(byName('EVM').hdIndex).toBe(0);
    expect(byName('EVM').seedGroup).toBe(zero.address.toLowerCase());
    expect(byName('Account 2').hdIndex).toBe(1);
    expect(byName('Account 2').seedGroup).toBe(zero.address.toLowerCase());
  }, 60_000);

  it('9. Account 2 reveals and SIGNS with the index-1 key, never the index-0 one', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm' });
    const zero = await vectorKeys(0);
    const one = await vectorKeys(1);
    await svc.addEvmAccount();

    expect(await svc.revealPrivateKeyWif(PW)).toBe('0x' + one.privateKey);
    expect(await svc.revealPrivateKeyWif(PW)).not.toBe('0x' + zero.privateKey);
    // The recovery phrase is the SAME for every account of the seed.
    expect(await svc.revealMnemonic(PW)).toBe(VECTOR_MNEMONIC);

    const signed = svc.signEvmTransaction(sampleTx(8453));
    const expectedPub = secp256k1.getPublicKey(
      Uint8Array.from(Buffer.from(one.privateKey, 'hex')),
      false,
    );
    expect(Buffer.from(recoverTxPublicKey(signed.raw)).toString('hex')).toBe(
      Buffer.from(expectedPub).toString('hex'),
    );
  }, 45_000);

  it('10. removing one account leaves the seed alive in the others', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'EVM', '', { family: 'evm' });
    const account1 = svc.activeWalletId()!;
    const account2 = (await svc.addEvmAccount()).id;

    await svc.removeWallet(account2);
    expect((await storedWallets()).map((w) => w.id)).toEqual([account1]);
    expect(svc.activeWalletId()).toBe(account1);
    expect(await svc.unlock(PW)).toBe(true);
    expect(svc.getAddress(0)).toBe((await vectorKeys(0)).address);
    // The index it freed is handed out again only because nothing holds it now.
    expect((await svc.addEvmAccount()).hdIndex).toBe(1);
  }, 45_000);

  it('switching between EVM accounts NEVER switches the chain: the target adopts the chain in use, whatever it last remembered', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'W1', '', { family: 'evm', evmChainKey: 'base' });
    const a2 = await svc.addEvmAccount();
    // Account 2 remembers Base; the user then views BNB Chain on Account 2.
    await svc.setEvmChainKey('bsc');
    expect(svc.evmChainKey()).toBe('bsc');
    // Switch to Account 1 (which remembers 'base'): the chain must stay bsc.
    const wallets = await svc.listWallets();
    const first = wallets.find((w) => (w.hdIndex ?? 0) === 0)!;
    await svc.switchWallet(first.id);
    expect(svc.evmChainKey()).toBe('bsc');
    // And back: still bsc.
    await svc.switchWallet(a2.id);
    expect(svc.evmChainKey()).toBe('bsc');
  });
});
