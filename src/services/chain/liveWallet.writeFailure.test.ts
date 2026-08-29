// WHEN A STORE WRITE COULD NOT LAND AT ALL.
//
// Every write of `liveWallets` is a compare-and-swap, refused when another page
// wrote in between and then re-read and re-applied. That retries a bounded
// number of times (STORE_WRITE_ATTEMPTS), and running the budget out is a real
// outcome: NOTHING IS WRITTEN, and the user's action did not happen.
//
// Nothing was ever wrong with the writing. The reporting was: the exhaustion
// arrived as a bare `false` or as the raw string 'store-conflict', so
// changePassword told the user the password they had just typed correctly was
// incorrect, create and import printed 'store-conflict' at them, and rename,
// switch and remove reported success for something that had not happened. It is
// a distinguishable type now, and these tests are what pin that.
//
// The storm is deterministic, not timed: conflictOnEveryRead re-arms itself, so
// every read is followed by another page's write and no attempt can ever win,
// however many reads the path under test makes.
//
// Real scrypt (N=2^17) runs throughout. Do NOT lower it to speed this up.

import { beforeEach, describe, expect, it } from 'vitest';

import { LiveWalletService, type WalletEntry } from './liveWallet';
import { STORE_WRITE_FAILED_MESSAGE, StoreWriteFailedError } from './storeWrite';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { unlockVaultString, type VaultRecord } from './vault';
import { conflictOnEveryRead, interleaved } from '../../test/interleavedStorage';
import type { ElectrumClient } from './electrumTypes';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const WALLET_PW = 'the wallet password';
const APP_PW = 'one password for the whole wallet';

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

interface StoredShape {
  wallets: WalletEntry[];
  activeId: string;
  appKey?: unknown;
  rev?: number;
}

function page(): LiveWalletService {
  return new LiveWalletService(offlineClient);
}

async function readStore(): Promise<StoredShape> {
  const s = await getStorage().get<StoredShape>('liveWallets');
  return s ?? { wallets: [], activeId: '' };
}

async function opensWith(entry: WalletEntry, password: string): Promise<boolean> {
  try {
    await unlockVaultString(entry.vault as VaultRecord, password);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

describe('a store write that never lands', () => {
  it('gives up with a failure of its own type, and writes nothing', async () => {
    const storage = interleaved();
    const svc = page();
    await svc.import(MNEMONIC, WALLET_PW, 'mainnet', 'Only');
    const id = (await svc.listWallets())[0].id;

    const stop = conflictOnEveryRead(storage);
    const err = await svc.renameWallet(id, 'Renamed').then(
      () => null,
      (e: unknown) => e,
    );
    stop();

    expect(err).toBeInstanceOf(StoreWriteFailedError);
    expect((err as Error).message).toBe(STORE_WRITE_FAILED_MESSAGE);
    // Not the internal conflict, which is a retry signal and never an answer.
    expect((err as Error).message).not.toContain('store-conflict');
    // And the store really is untouched.
    const store = await readStore();
    expect(store.wallets.map((w) => w.name)).toEqual(['Only']);
  });

  it('still lands when the conflict clears, so the retry budget is intact', async () => {
    const storage = interleaved();
    const svc = page();
    await svc.import(MNEMONIC, WALLET_PW, 'mainnet', 'Only');
    const id = (await svc.listWallets())[0].id;

    // ONE conflicting write, not a storm: the second attempt must succeed.
    storage.afterRead(async () => {
      const store = await getStorage().get<StoredShape>('liveWallets');
      if (store) await getStorage().set('liveWallets', { ...store, rev: (store.rev ?? 0) + 1 });
    });
    await svc.renameWallet(id, 'Renamed');

    expect((await readStore()).wallets.map((w) => w.name)).toEqual(['Renamed']);
  });

  it('an import says it in words, never the raw conflict code', async () => {
    const storage = interleaved();
    const svc = page();
    await svc.import(MNEMONIC, WALLET_PW, 'mainnet', 'First');

    const stop = conflictOnEveryRead(storage);
    const err = await svc.import(OTHER_MNEMONIC, WALLET_PW, 'mainnet', 'Second').then(
      () => null,
      (e: unknown) => e,
    );
    stop();

    expect(err).toBeInstanceOf(StoreWriteFailedError);
    expect((err as Error).message).toBe(STORE_WRITE_FAILED_MESSAGE);
    expect((await readStore()).wallets.map((w) => w.name)).toEqual(['First']);
  });

  it('changePassword does not answer it as a wrong password', async () => {
    const storage = interleaved();
    const svc = page();
    await svc.import(MNEMONIC, WALLET_PW, 'mainnet', 'Only');

    const stop = conflictOnEveryRead(storage);
    const err = await svc.changePassword(WALLET_PW, 'a new password').then(
      (ok) => ok,
      (e: unknown) => e,
    );
    stop();

    // `false` here would be rendered as "Current password is incorrect.", about
    // a password that had just opened the vault.
    expect(err).toBeInstanceOf(StoreWriteFailedError);
    const entry = (await readStore()).wallets[0];
    expect(await opensWith(entry, WALLET_PW)).toBe(true);
    expect(await opensWith(entry, 'a new password')).toBe(false);
  });

  it('a genuinely wrong password is still just false', async () => {
    const svc = page();
    await svc.import(MNEMONIC, WALLET_PW, 'mainnet', 'Only');

    expect(await svc.changePassword('not the password', 'a new password')).toBe(false);
  });

  it('setAppPassword does not answer it as "a wallet is already protected"', async () => {
    const storage = interleaved();
    const svc = page();
    await svc.import(MNEMONIC, WALLET_PW, 'mainnet', 'Only');

    const stop = conflictOnEveryRead(storage);
    const err = await svc.setAppPassword(APP_PW).then(
      (ok) => ok,
      (e: unknown) => e,
    );
    stop();

    expect(err).toBeInstanceOf(StoreWriteFailedError);
    expect(await svc.hasAppPassword()).toBe(false);
    // Nothing was written, so nothing is holding a key derived from it.
    expect(svc.appUnlocked()).toBe(false);
  });

  it('setNoSendPassword does not answer it as a wrong app password', async () => {
    const storage = interleaved();
    const svc = page();
    await svc.import(MNEMONIC, WALLET_PW, 'mainnet', 'Only');
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    expect(await svc.unlock(WALLET_PW)).toBe(true); // migrates it to the app key

    const stop = conflictOnEveryRead(storage);
    const err = await svc.setNoSendPassword(true, APP_PW).then(
      (ok) => ok,
      (e: unknown) => e,
    );
    stop();

    expect(err).toBeInstanceOf(StoreWriteFailedError);
    // The send gate is exactly where it was: still asking.
    expect((await readStore()).wallets[0].noSendPassword).toBeUndefined();
    expect(await svc.verifyPassword('not the app password')).toBe(false);
  });
});
