// WHAT THE UI SAYS WHEN A WALLET-STORE WRITE COULD NOT LAND.
//
// The service reports it as one distinguishable failure (see
// src/services/chain/storeWrite.ts and liveWallet.writeFailure.test.ts, which
// prove the real service raises exactly this). What is under test HERE is the
// answer the store turns it into, which used to be four different wrong ones:
//
//   * changePassword returned a bare false, and the password form renders that
//     as "Current password is incorrect." about a correct password.
//   * import and createWallet surfaced the raw string 'store-conflict'.
//   * renameWallet and switchWallet swallowed it in `catch {}` and reported
//     success for something that had not happened.
//   * removeWallet swallowed it and then reclaimed the transaction caches of a
//     wallet that is still in storage.
//
// The service is mocked (this is about the store's reporting, not the CAS), but
// the failure type is the real one: storeWrite.ts is deliberately its own module
// so mocking the wallet service cannot replace it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORE_WRITE_FAILED_MESSAGE, StoreWriteFailedError } from '../services/chain/storeWrite';

type WalletRow = {
  id: string;
  name: string;
  network: string;
  createdAt: number;
  active: boolean;
  kind: 'seed' | 'pk';
  address: string;
  passwordless: boolean;
  family: 'utxo' | 'evm';
};

const hoisted = vi.hoisted(() => ({
  wallets: [] as Array<{
    id: string;
    name: string;
    network: string;
    createdAt: number;
    active: boolean;
    kind: 'seed' | 'pk';
    address: string;
    passwordless: boolean;
    family: 'utxo' | 'evm';
  }>,
  activeId: null as string | null,
  /** Method names that answer with a store-write failure instead of working. */
  failing: new Set<string>(),
}));

vi.mock('../services/chain/liveWallet', async () => {
  const { StoreWriteFailedError: Failed } = await import('../services/chain/storeWrite');
  class BroadcastGatedError extends Error {}
  const refuse = (name: string): void => {
    if (hoisted.failing.has(name)) throw new Failed();
  };
  class LiveWalletService {
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    async listWallets() {
      return hoisted.wallets.map((w) => ({ ...w, active: w.id === hoisted.activeId }));
    }
    activeWalletId() {
      return hoisted.activeId;
    }
    async renameWallet(id: string, name: string) {
      refuse('renameWallet');
      const found = hoisted.wallets.find((w) => w.id === id);
      if (found) found.name = name;
    }
    async switchWallet(id: string) {
      refuse('switchWallet');
      hoisted.activeId = id;
    }
    async removeWallet(id: string) {
      refuse('removeWallet');
      hoisted.wallets = hoisted.wallets.filter((w) => w.id !== id);
      if (hoisted.activeId === id) hoisted.activeId = hoisted.wallets[0]?.id ?? null;
    }
    async changePassword() {
      refuse('changePassword');
      return true;
    }
    async setNoSendPassword() {
      refuse('setNoSendPassword');
      return true;
    }
    async import() {
      refuse('import');
    }
    async create() {
      refuse('create');
      return { mnemonic: 'never returned' };
    }
    network() {
      return 'mainnet';
    }
    isUnlocked() {
      return true;
    }
    appUnlocked() {
      return false;
    }
    getAddress() {
      return 'Eneverreached00000000000000000000';
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { LiveTransaction } from '../services/chain/electrumProvider';

const A1 = 'Eactiveprimary000000000000000000';
const A2 = 'Eactivederived000000000000000000';

const state = () => useLiveStore.getState();

let storage: MemoryStorageAdapter;

function mkTx(txid: string): LiveTransaction {
  return {
    txid,
    asset: 'EVR',
    direction: 'in',
    amount: 1,
    feeEvr: 0,
    status: 'confirmed',
    blockHeight: 100,
    timestamp: 1_700_000_000_000,
    counterparty: 'Ecounterparty000000000000000000000',
  };
}

async function seedCache(address: string): Promise<void> {
  await storage.set(`txcache:mainnet:${address}`, {
    version: 2,
    txs: [mkTx(`tx-${address}`)],
    knownHeights: { [`tx-${address}`]: 100 },
  });
}

async function cacheKeys(): Promise<string[]> {
  return (await storage.keys()).filter((k) => k.startsWith('txcache:')).sort();
}

const row = (id: string, name: string, address: string): WalletRow => ({
  id,
  name,
  network: 'mainnet',
  createdAt: 1,
  active: false,
  kind: 'seed',
  address,
  passwordless: false,
  family: 'utxo',
});

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  hoisted.failing = new Set();
  hoisted.wallets = [row('w1', 'One', A1), row('w2', 'Two', 'Eotherwallet0000000000000000000')];
  hoisted.activeId = 'w1';
  await seedCache(A1);
  await seedCache(A2);
  useLiveStore.setState({
    wallets: hoisted.wallets.map((w) => ({ ...w, active: w.id === 'w1' })),
    activeWalletId: 'w1',
    address: A1,
    addresses: [
      { index: 0, address: A1 },
      { index: 1, address: A2 },
    ],
    error: null,
  });
});

describe('the one honest line', () => {
  it('is what changePassword answers with, instead of a bare failure', async () => {
    hoisted.failing.add('changePassword');

    const res = await state().changePassword('right', 'new one');

    expect(res).toEqual({ ok: false, error: STORE_WRITE_FAILED_MESSAGE });
    // The form only says "Current password is incorrect." when there is no
    // reason to show instead.
    expect(res.error).not.toContain('password');
  });

  it('is what a failed import shows, not the raw conflict code', async () => {
    hoisted.failing.add('import');

    await expect(state().importWallet('some words', 'pw')).rejects.toBeInstanceOf(
      StoreWriteFailedError,
    );

    expect(state().error).toBe(STORE_WRITE_FAILED_MESSAGE);
    expect(state().error).not.toContain('store-conflict');
  });

  it('is what a failed create shows, not the raw conflict code', async () => {
    hoisted.failing.add('create');

    await state().createWallet('pw');

    expect(state().error).toBe(STORE_WRITE_FAILED_MESSAGE);
    expect(state().error).not.toContain('store-conflict');
  });
});

describe('the actions that used to report success', () => {
  it('renameWallet says the rename did not happen', async () => {
    hoisted.failing.add('renameWallet');

    await state().renameWallet('w1', 'A better name');

    expect(state().error).toBe(STORE_WRITE_FAILED_MESSAGE);
    expect(state().wallets.find((w) => w.id === 'w1')?.name).toBe('One');
  });

  it('switchWallet says the switch did not happen', async () => {
    hoisted.failing.add('switchWallet');

    await state().switchWallet('w2');

    expect(state().error).toBe(STORE_WRITE_FAILED_MESSAGE);
    expect(state().activeWalletId).toBe('w1');
    expect(state().syncing).toBe('idle');
  });

  it('a rename that WORKS still says nothing and still renames', async () => {
    await state().renameWallet('w1', 'A better name');

    expect(state().error).toBeNull();
    expect(state().wallets.find((w) => w.id === 'w1')?.name).toBe('A better name');
  });
});

describe('a removal that could not be written', () => {
  it('keeps the wallet, says so, and does NOT reclaim its caches', async () => {
    hoisted.failing.add('removeWallet');

    await state().removeWallet('w1');

    expect(state().error).toBe(STORE_WRITE_FAILED_MESSAGE);
    expect(state().wallets.map((w) => w.id)).toEqual(['w1', 'w2']);
    // The wallet is still in storage, so its history is still its own. These
    // are only caches, rebuilt on the next sync, but throwing them away for a
    // removal that did not happen is work spent on nothing.
    expect(await cacheKeys()).toEqual([`txcache:mainnet:${A1}`, `txcache:mainnet:${A2}`].sort());
  });

  it('a removal that WORKS still reclaims them', async () => {
    await state().removeWallet('w1');

    expect(state().error).toBeNull();
    expect(await cacheKeys()).toEqual([]);
  });
});
