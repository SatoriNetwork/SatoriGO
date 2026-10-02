// The Zcash and Bittensor sides of LiveWalletService (the Zcash engine design
// notes §8, §9, §12.1 "liveWallet.zcash.test.ts"; the Bittensor engine design
// notes §8, §9, §12.1): "Add Zcash" and "Add Bittensor" copy the vault and
// share the seed group, unlock derives the published `abandon` vectors from
// the phrase (Zcash /0/0 by the BIP39 seed, Bittensor by the ENTROPY route),
// revealMnemonic answers the phrase (the one secret either entry has), the
// keys are dropped on lock, removeWallet drops the histories, and a sibling
// survives the backup file. Neither engine has a build flag, so nothing is
// mocked but storage; no network is touched (no refresh runs here).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveWalletService, ZCASH_NETWORK, TAO_NETWORK } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { saveZcashHistory, emptyZcashHistory, zcashHistoryKey } from './zcash/historyCache';
import { saveTaoHistory, taoHistoryKey } from './substrate/historyClient';
import type { ElectrumClient } from './electrumTypes';

const offlineClient = {
  connect: async () => {},
  isConnected: () => false,
  endpoint: () => 'wss://fake',
  close: () => {},
  request: async () => {
    throw new Error('no network in unit tests');
  },
} as unknown as ElectrumClient;

// Published vectors, unit tests only (these accounts are live and used by
// strangers; they are never funded or shown with a Send here).
const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Zcash /0/0 of the abandon phrase (Trust Wallet Core, Zashi, keys.test.ts).
const ZEC_ADDRESS = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F';
// Bittensor root account by the entropy route (polkadot.js, btcli, keys.test.ts).
const TAO_ADDRESS = '5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH';
const PW = 'password-one';

interface StoredWallet {
  id: string;
  name: string;
  network: string;
  family?: string;
  kind?: string;
  vault: { iv: string; ciphertext: string; salt?: string };
  seedGroup?: string;
  zcashWatch?: string[];
  passwordless?: boolean;
}

async function rawWallets(): Promise<StoredWallet[]> {
  const store = await getStorage().get<{ wallets: StoredWallet[] }>('liveWallets');
  return store?.wallets ?? [];
}

describe('LiveWalletService: Zcash', () => {
  let svc: LiveWalletService;

  beforeEach(async () => {
    setStorageForTests(new MemoryStorageAdapter());
    svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'Wallet 1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('addZcashAccount: a vault-copy sibling with the public watch set, shared seed group, active and unlocked at /0/0', async () => {
    const sourceId = svc.activeWalletId()!;
    const summary = await svc.addZcashAccount(sourceId);
    expect(summary.family).toBe('zcash');
    expect(summary.network).toBe(ZCASH_NETWORK);
    expect(summary.address).toBe(ZEC_ADDRESS);
    expect(summary.active).toBe(true);
    expect(summary.name).toBe('Wallet 1 (Zcash)');
    expect(summary.kind).toBe('seed');
    // Fifteen public watch addresses, /0/0 first, all t1.
    expect(summary.zcashWatch).toHaveLength(15);
    expect(summary.zcashWatch?.[0]).toBe(ZEC_ADDRESS);
    expect(new Set(summary.zcashWatch).size).toBe(15);
    for (const a of summary.zcashWatch ?? []) expect(a).toMatch(/^t1/);

    // The service landed on it, unlocked: one shown address, no UTXO key.
    expect(svc.activeWalletId()).toBe(summary.id);
    expect(svc.activeWalletFamily()).toBe('zcash');
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getAddress(0)).toBe(ZEC_ADDRESS);
    expect(() => svc.deriveKey(0)).toThrow(/Zcash/);

    // zcashKeysOfActive hands out a COPY: zeroing it leaves the session's keys.
    const copy = svc.zcashKeysOfActive();
    expect(copy.primary.address).toBe(ZEC_ADDRESS);
    expect(copy.watch).toHaveLength(15);
    copy.primary.privateKey.fill(0);
    expect(svc.zcashKeysOfActive().primary.privateKey.some((b) => b !== 0)).toBe(true);

    // Byte for byte the source's vault: no new secret was written (§9).
    const stored = await rawWallets();
    const source = stored.find((w) => w.id === sourceId)!;
    const sibling = stored.find((w) => w.id === summary.id)!;
    expect(sibling.vault).toEqual(source.vault);
    expect(sibling.family).toBe('zcash');
    expect(sibling.network).toBe(ZCASH_NETWORK);
    expect(sibling.zcashWatch).toEqual(summary.zcashWatch);
    expect(sibling.seedGroup).toBeTruthy();
    expect(source.seedGroup).toBe(sibling.seedGroup);

    // The public summary carries the Zcash field and nothing secret.
    const listed = (await svc.listWallets()).find((w) => w.id === summary.id)!;
    expect(Object.keys(listed).sort()).toEqual(
      ['active', 'address', 'createdAt', 'family', 'id', 'kind', 'name', 'network', 'passwordless', 'seedGroup', 'zcashWatch', 'origin'].sort(),
    );
    expect(listed).not.toHaveProperty('vault');
    // A UTXO summary did not sprout the Zcash field.
    expect((await svc.listWallets()).find((w) => w.id === sourceId)!).not.toHaveProperty('zcashWatch');
  });

  it('addZcashAccount refuses a second Zcash sibling of the same phrase, and a pk source', async () => {
    const sourceId = svc.activeWalletId()!;
    await svc.addZcashAccount(sourceId);
    await svc.switchWallet(sourceId);
    await svc.unlock(PW);
    await expect(svc.addZcashAccount(sourceId)).rejects.toThrow('already-added');
    // Not the active wallet: locked.
    await expect(svc.addZcashAccount('nope')).rejects.toThrow('unknown-wallet');
  });

  it('addZcashAccount from a Bittensor sibling (no seed in memory) reads the phrase from the vault with the password', async () => {
    const sourceId = svc.activeWalletId()!;
    const tao = await svc.addSubstrateAccount(sourceId, PW);
    expect(svc.activeWalletFamily()).toBe('substrate');
    await expect(svc.addZcashAccount(tao.id)).rejects.toThrow('locked');
    await expect(svc.addZcashAccount(tao.id, undefined, { password: 'wrong' })).rejects.toThrow('wrong-password');
    const zec = await svc.addZcashAccount(tao.id, undefined, { password: PW });
    expect(zec.address).toBe(ZEC_ADDRESS);
    expect(svc.activeWalletFamily()).toBe('zcash');
  });

  it('lock drops the keys; unlock re-derives the same address and backfills a missing watch set', async () => {
    const sourceId = svc.activeWalletId()!;
    const summary = await svc.addZcashAccount(sourceId);
    svc.lock();
    expect(svc.isUnlocked()).toBe(false);
    expect(() => svc.zcashKeysOfActive()).toThrow(/locked/);
    // Strip the cached watch set, as a hand-edited backup could.
    const store = await getStorage().get<{ wallets: StoredWallet[] }>('liveWallets');
    for (const w of store!.wallets) if (w.id === summary.id) delete w.zcashWatch;
    await getStorage().set('liveWallets', store);
    svc = new LiveWalletService(offlineClient);
    await svc.switchWallet(summary.id);
    expect(await svc.unlock(PW)).toBe(true);
    expect(svc.getAddress(0)).toBe(ZEC_ADDRESS);
    expect(svc.zcashKeysOfActive().watch).toHaveLength(15);
    const after = (await rawWallets()).find((w) => w.id === summary.id)!;
    expect(after.zcashWatch).toHaveLength(15);
    expect(after.zcashWatch?.[0]).toBe(ZEC_ADDRESS);
  });

  it('revealMnemonic answers the phrase (the one secret a Zcash sibling has); no WIF is offered', async () => {
    await svc.addZcashAccount(svc.activeWalletId()!);
    expect(await svc.revealMnemonic(PW)).toBe(VECTOR_MNEMONIC);
    expect(await svc.revealMnemonic('wrong')).toBe(null);
    expect(await svc.revealPrivateKeyWif(PW)).toBe(null);
    const secret = await svc.revealSecret(PW);
    expect(secret).toEqual({ kind: 'mnemonic', mnemonic: VECTOR_MNEMONIC });
  });

  it('removeWallet drops the history cache and the local send records with the entry', async () => {
    const summary = await svc.addZcashAccount(svc.activeWalletId()!);
    await saveZcashHistory(summary.id, emptyZcashHistory());
    await getStorage().set(`zec:sends:${summary.id}`, [{ txid: 'aa', expiryHeight: 1, sentAt: 1, hex: '' }]);
    expect(await getStorage().get(zcashHistoryKey(summary.id))).not.toBeNull();
    await svc.removeWallet(summary.id);
    expect(await getStorage().get(zcashHistoryKey(summary.id))).toBeFalsy();
    expect(await getStorage().get(`zec:sends:${summary.id}`)).toBeFalsy();
    expect((await rawWallets()).some((w) => w.id === summary.id)).toBe(false);
  });

  it('changePassword re-encrypts the sibling with its source (shared seed group)', async () => {
    const sourceId = svc.activeWalletId()!;
    const summary = await svc.addZcashAccount(sourceId);
    await svc.switchWallet(sourceId);
    await svc.unlock(PW);
    expect(await svc.changePassword(PW, 'password-two')).toBe(true);
    svc.lock();
    await svc.switchWallet(summary.id);
    expect(await svc.unlock(PW)).toBe(false);
    expect(await svc.unlock('password-two')).toBe(true);
    expect(svc.getAddress(0)).toBe(ZEC_ADDRESS);
  });
});

describe('LiveWalletService: Bittensor (family substrate)', () => {
  let svc: LiveWalletService;

  beforeEach(async () => {
    setStorageForTests(new MemoryStorageAdapter());
    svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'Wallet 1');
  });

  it('addSubstrateAccount: a vault-copy sibling derived by the entropy route, shared seed group, active and unlocked', async () => {
    const sourceId = svc.activeWalletId()!;
    const summary = await svc.addSubstrateAccount(sourceId, PW);
    expect(summary.family).toBe('substrate');
    expect(summary.network).toBe(TAO_NETWORK);
    expect(summary.address).toBe(TAO_ADDRESS);
    expect(summary.active).toBe(true);
    expect(summary.name).toBe('Wallet 1 (Bittensor)');
    expect(summary.kind).toBe('seed');

    expect(svc.activeWalletId()).toBe(summary.id);
    expect(svc.activeWalletFamily()).toBe('substrate');
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getAddress(0)).toBe(TAO_ADDRESS);
    expect(() => svc.deriveKey(0)).toThrow(/Bittensor/);

    // substrateAccountOfActive hands out a COPY of the mini secret.
    const copy = svc.substrateAccountOfActive();
    expect(copy.address).toBe(TAO_ADDRESS);
    expect(copy.miniSecret).toHaveLength(32);
    copy.miniSecret.fill(0);
    expect(svc.substrateAccountOfActive().miniSecret.some((b) => b !== 0)).toBe(true);

    const stored = await rawWallets();
    const source = stored.find((w) => w.id === sourceId)!;
    const sibling = stored.find((w) => w.id === summary.id)!;
    expect(sibling.vault).toEqual(source.vault);
    expect(sibling.family).toBe('substrate');
    expect(sibling.seedGroup).toBe(source.seedGroup);
    expect(sibling).not.toHaveProperty('zcashWatch');

    const listed = (await svc.listWallets()).find((w) => w.id === summary.id)!;
    expect(Object.keys(listed).sort()).toEqual(
      ['active', 'address', 'createdAt', 'family', 'id', 'kind', 'name', 'network', 'passwordless', 'seedGroup', 'origin'].sort(),
    );
    expect(listed).not.toHaveProperty('vault');
  });

  it('addSubstrateAccount needs the password (the words, not the seed) and refuses a wrong one before writing', async () => {
    const sourceId = svc.activeWalletId()!;
    await expect(svc.addSubstrateAccount(sourceId, 'wrong')).rejects.toThrow('wrong-password');
    expect((await rawWallets()).length).toBe(1);
    await svc.addSubstrateAccount(sourceId, PW);
    await svc.switchWallet(sourceId);
    await svc.unlock(PW);
    await expect(svc.addSubstrateAccount(sourceId, PW)).rejects.toThrow('already-added');
  });

  it('lock drops the account; unlock re-derives the same SS58 address', async () => {
    const summary = await svc.addSubstrateAccount(svc.activeWalletId()!, PW);
    svc.lock();
    expect(svc.isUnlocked()).toBe(false);
    expect(() => svc.substrateAccountOfActive()).toThrow(/locked/);
    svc = new LiveWalletService(offlineClient);
    await svc.switchWallet(summary.id);
    expect(await svc.unlock(PW)).toBe(true);
    expect(svc.getAddress(0)).toBe(TAO_ADDRESS);
  });

  it('revealMnemonic answers the phrase; removeWallet drops the local send history', async () => {
    const summary = await svc.addSubstrateAccount(svc.activeWalletId()!, PW);
    expect(await svc.revealMnemonic(PW)).toBe(VECTOR_MNEMONIC);
    expect(await svc.revealPrivateKeyWif(PW)).toBe(null);
    await saveTaoHistory(summary.id, []);
    expect(await getStorage().get(taoHistoryKey(summary.id))).not.toBeNull();
    await svc.removeWallet(summary.id);
    expect(await getStorage().get(taoHistoryKey(summary.id))).toBeFalsy();
  });

  it('a phrase with a BIP39 passphrase derives a different account (the passphrase goes into the salt)', async () => {
    setStorageForTests(new MemoryStorageAdapter());
    svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'With passphrase', 'TREZOR');
    const summary = await svc.addSubstrateAccount(svc.activeWalletId()!, PW);
    expect(summary.address).not.toBe(TAO_ADDRESS);
    expect(summary.address).toMatch(/^5/);
  });
});
