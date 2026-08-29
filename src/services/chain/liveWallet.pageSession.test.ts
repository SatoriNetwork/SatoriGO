// WHICH WALLET A PAGE IS ON, when two pages are on two different wallets.
//
// The extension is several pages over one `liveWallets` object: the toolbar
// popup, the side panel (`?panel=1`), a detached window, a dApp approval page.
// Each has its OWN LiveWalletService, and that service holds one wallet's seed,
// one chain and one derivation index in memory. `store.activeId` is a single
// shared field, so it names the wallet of whichever page switched LAST -- which
// is not necessarily this one.
//
// Every method here that says "the ACTIVE wallet" used to resolve it out of that
// shared field. An adversarial review turned that into:
//   * addReceiveAddress() showing an address derived from THIS page's seed while
//     raising the OTHER wallet's addressCount. The wallet that owns the address
//     never learns it exists, never scans it, and coins sent there go unseen.
//     That is the one in here that can cost a user money.
//   * changePassword() putting the new password on the other wallet.
//   * setEvmChainKey() writing the chain preference onto the other account.
//
// So "active" is now the wallet THIS page activated, adopted from the store only
// by a page that has activated nothing yet. These tests are two services over
// one faithful storage double, which is the only shape any of it is visible in.
//
// Real scrypt (N=2^17) runs throughout. Do NOT lower it to speed this up.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ evmEnabled: true }));

// Same shape as liveWallet.evm.test.ts: the shipped test config has the EVM
// build flag OFF, so the one EVM case here loads the engine through a mock.
vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>();
  return {
    ...actual,
    loadEvmModules: async () => (hoisted.evmEnabled ? await import('./evm') : null),
  };
});

import { LiveWalletService, type WalletEntry } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { unlockVaultString, type VaultRecord } from './vault';
import { deriveAddress, mnemonicToSeed } from './keys';
import { EVRMORE_MAINNET, RAVENCOIN_MAINNET } from './chainParams';
import type { ElectrumClient } from './electrumTypes';

const MINE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const MINE_PW = 'the password of my own wallet';
const OTHER_PW = 'the password of the other wallet';
const SHARED_PW = 'the same password on both wallets';
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
}

/** A page: its own service instance, over the shared storage. */
function page(): LiveWalletService {
  return new LiveWalletService(offlineClient);
}

async function readStore(): Promise<StoredShape> {
  const s = await getStorage().get<StoredShape>('liveWallets');
  return s ?? { wallets: [], activeId: '' };
}

async function stored(id: string): Promise<WalletEntry> {
  const found = (await readStore()).wallets.find((w) => w.id === id);
  if (!found) throw new Error(`no wallet ${id}`);
  return found;
}

async function addressOf(mnemonic: string, index = 0, net = EVRMORE_MAINNET): Promise<string> {
  return deriveAddress(await mnemonicToSeed(mnemonic), net, 0, 0, index).address;
}

async function opensWith(entry: WalletEntry, password: string): Promise<boolean> {
  try {
    await unlockVaultString(entry.vault as VaultRecord, password);
    return true;
  } catch {
    return false;
  }
}

/**
 * The setup every test below shares: ONE page imports the OTHER wallet first and
 * MINE second, so MINE is what the store calls active and what this page is on.
 * The page then unlocks MINE, i.e. it is holding MINE's seed.
 */
async function pageOnMine(
  minePw = MINE_PW,
  otherPw = OTHER_PW,
): Promise<{ a: LiveWalletService; mine: string; other: string }> {
  const a = page();
  await a.import(OTHER_MNEMONIC, otherPw, 'mainnet', 'OTHER');
  await a.import(MINE_MNEMONIC, minePw, 'mainnet', 'MINE');
  const ids = Object.fromEntries((await a.listWallets()).map((w) => [w.name, w.id]));
  expect(await a.unlock(minePw)).toBe(true);
  return { a, mine: ids.MINE, other: ids.OTHER };
}

/** Another window switches the SHARED active wallet to `id`. */
async function anotherWindowSwitchesTo(id: string): Promise<void> {
  await page().switchWallet(id);
  expect((await readStore()).activeId).toBe(id);
}

beforeEach(() => {
  hoisted.evmEnabled = true;
  setStorageForTests(new MemoryStorageAdapter());
});

describe('two pages, two wallets: the address a page hands out', () => {
  it('raises the count on THIS page\'s wallet, not on the one another window switched to', async () => {
    const { a, mine, other } = await pageOnMine();
    await anotherWindowSwitchesTo(other);

    const shown = await a.addReceiveAddress();

    // The address IS derived from this page's seed, which is why the count has
    // to be this page's wallet's count.
    expect(shown.index).toBe(1);
    expect(shown.address).toBe(await addressOf(MINE_MNEMONIC, 1));
    expect((await stored(mine)).addressCount).toBe(2);
    expect((await stored(other)).addressCount ?? 1).toBe(1);
  });

  it('is an address the wallet that owns it then scans', async () => {
    const { a, mine, other } = await pageOnMine();
    await anotherWindowSwitchesTo(other);
    const shown = await a.addReceiveAddress();

    // A page opening MINE afterwards must list the address the user was told to
    // send to. That is the whole point of the count: everything that looks for
    // funds iterates it.
    const fresh = page();
    await fresh.switchWallet(mine);
    expect(await fresh.unlock(MINE_PW)).toBe(true);
    const listed = (await fresh.listAddresses()).map((x) => x.address);
    expect(listed).toHaveLength(2);
    expect(listed).toContain(shown.address);
  });

  it('keeps counting up on the same wallet when the shared active id keeps moving', async () => {
    const { a, mine, other } = await pageOnMine();
    await anotherWindowSwitchesTo(other);
    await a.addReceiveAddress();
    await anotherWindowSwitchesTo(mine);
    await anotherWindowSwitchesTo(other);
    const third = await a.addReceiveAddress();

    expect(third.index).toBe(2);
    expect(third.address).toBe(await addressOf(MINE_MNEMONIC, 2));
    expect((await stored(mine)).addressCount).toBe(3);
    expect((await stored(other)).addressCount ?? 1).toBe(1);
  });
});

describe('two pages, two wallets: changing the wallet password', () => {
  it('changes the password of the wallet the user is looking at (same password on both)', async () => {
    // The same password on both is what makes the wrong target INVISIBLE: the
    // decrypt succeeds either way, so nothing fails and the wrong wallet quietly
    // gets a password its user never typed.
    const { a, mine, other } = await pageOnMine(SHARED_PW, SHARED_PW);
    await anotherWindowSwitchesTo(other);

    expect(await a.changePassword(SHARED_PW, 'a brand new password')).toBe(true);

    expect(await opensWith(await stored(mine), 'a brand new password')).toBe(true);
    expect(await opensWith(await stored(mine), SHARED_PW)).toBe(false);
    expect(await opensWith(await stored(other), SHARED_PW)).toBe(true);
    expect(await opensWith(await stored(other), 'a brand new password')).toBe(false);
  });

  it('does not report a correct password as wrong (different passwords)', async () => {
    // With different passwords the wrong target could not decrypt at all, so the
    // user was told the password they had just typed correctly was incorrect.
    const { a, mine } = await pageOnMine();
    await anotherWindowSwitchesTo((await readStore()).wallets.filter((w) => w.id !== mine)[0].id);

    expect(await a.changePassword(MINE_PW, 'my new password')).toBe(true);
    expect(await opensWith(await stored(mine), 'my new password')).toBe(true);
  });

  it('a page that has activated nothing still changes the STORE\'s active wallet', async () => {
    // The untouched case, and the one every single-window install is: a service
    // that has never switched adopts the store's active wallet on its first read.
    const { other } = await pageOnMine();
    await anotherWindowSwitchesTo(other);

    const fresh = page(); // a popup that just opened
    expect(await fresh.changePassword(OTHER_PW, 'other, renewed')).toBe(true);
    expect(await opensWith(await stored(other), 'other, renewed')).toBe(true);
  });
});

describe('two pages, two wallets: the send-password switch', () => {
  it('turns "do not ask when sending" off on THIS page\'s wallet', async () => {
    const a = page();
    await a.import(OTHER_MNEMONIC, SHARED_PW, 'mainnet', 'OTHER');
    await a.import(MINE_MNEMONIC, SHARED_PW, 'mainnet', 'MINE');
    const ids = Object.fromEntries((await a.listWallets()).map((w) => [w.name, w.id]));
    expect(await a.setAppPassword(APP_PW)).toBe(true);
    // Both wallets migrate to the app key (that is what makes the flag apply),
    // and this page ends up back on MINE.
    expect(await a.unlock(SHARED_PW)).toBe(true);
    await a.switchWallet(ids.OTHER);
    expect(await a.unlock(SHARED_PW)).toBe(true); // its own password: that is what migrates it
    await a.switchWallet(ids.MINE);
    expect(await a.unlock(APP_PW)).toBe(true);

    await anotherWindowSwitchesTo(ids.OTHER);
    expect(await a.setNoSendPassword(true, APP_PW)).toBe(true);

    expect((await stored(ids.MINE)).noSendPassword).toBe(true);
    expect((await stored(ids.OTHER)).noSendPassword).toBeUndefined();
    // And the gate this page enforces is its own wallet's.
    expect(await a.verifyPassword('not the app password')).toBe(true);
    expect(await page().verifyPassword('not the app password')).toBe(false); // fresh page: OTHER
  });
});

describe('two pages, two wallets: removing one', () => {
  it('does not lock this page when the wallet removed is another window\'s', async () => {
    const { a, mine, other } = await pageOnMine();
    await anotherWindowSwitchesTo(other);

    await a.removeWallet(other);

    expect(a.isUnlocked()).toBe(true);
    expect(a.activeWalletId()).toBe(mine);
    expect(a.getAddress(0)).toBe(await addressOf(MINE_MNEMONIC, 0));
  });

  it('does lock this page when the wallet removed is its own', async () => {
    const { a, mine, other } = await pageOnMine();
    await anotherWindowSwitchesTo(other);

    await a.removeWallet(mine);

    expect(a.isUnlocked()).toBe(false);
    expect(a.activeWalletId()).toBe(other);
    expect((await readStore()).wallets.map((w) => w.id)).toEqual([other]);
  });

  it('clears the session entirely when the last wallet goes', async () => {
    const a = page();
    await a.import(MINE_MNEMONIC, MINE_PW, 'mainnet', 'ONLY');
    const only = (await a.listWallets())[0].id;
    expect(await a.unlock(MINE_PW)).toBe(true);

    await a.removeWallet(only);

    expect(a.isUnlocked()).toBe(false);
    expect(a.activeWalletId()).toBeNull();
    expect(await a.listWallets()).toEqual([]);
  });
});

describe('two pages, two chains: the page keeps its own chain', () => {
  it('does not follow another window onto a different chain', async () => {
    const a = page();
    await a.import(OTHER_MNEMONIC, OTHER_PW, 'ravencoin-mainnet', 'RVN');
    await a.import(MINE_MNEMONIC, MINE_PW, 'mainnet', 'EVR');
    const ids = Object.fromEntries((await a.listWallets()).map((w) => [w.name, w.id]));
    expect(await a.unlock(MINE_PW)).toBe(true);

    await anotherWindowSwitchesTo(ids.RVN);
    await a.listWallets(); // any store read at all used to be enough

    expect(a.network()).toBe('mainnet');
    expect(a.getAddress(0)).toBe(await addressOf(MINE_MNEMONIC, 0));
    // Not the same seed on the other window's chain, which is what a repointed
    // page would have shown for it.
    expect(a.getAddress(0)).not.toBe(await addressOf(MINE_MNEMONIC, 0, RAVENCOIN_MAINNET));
    const shown = await a.addReceiveAddress();
    expect(shown.address).toBe(await addressOf(MINE_MNEMONIC, 1));
    expect((await stored(ids.EVR)).addressCount).toBe(2);
  });
});

describe('two pages, two EVM accounts: the chain preference', () => {
  it('lands on THIS page\'s account', async () => {
    const a = page();
    await a.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'EVM OTHER', '', { family: 'evm' });
    await a.import(MINE_MNEMONIC, MINE_PW, 'mainnet', 'EVM MINE', '', { family: 'evm' });
    const ids = Object.fromEntries((await a.listWallets()).map((w) => [w.name, w.id]));
    expect(await a.unlock(MINE_PW)).toBe(true);
    const before = (await stored(ids['EVM OTHER'])).evmChainKey;

    await anotherWindowSwitchesTo(ids['EVM OTHER']);
    await a.setEvmChainKey('ethereum');

    expect((await stored(ids['EVM MINE'])).evmChainKey).toBe('ethereum');
    expect((await stored(ids['EVM OTHER'])).evmChainKey).toBe(before);
    expect(a.evmChainKey()).toBe('ethereum');
  });
});

describe('an install with one wallet, and a page that has switched nothing', () => {
  it('is exactly what it always was', async () => {
    const a = page();
    await a.import(MINE_MNEMONIC, MINE_PW, 'mainnet', 'ONLY');
    const only = (await a.listWallets())[0].id;
    expect(await a.unlock(MINE_PW)).toBe(true);

    expect(a.activeWalletId()).toBe(only);
    expect((await a.listWallets())[0].active).toBe(true);
    expect((await a.addReceiveAddress()).address).toBe(await addressOf(MINE_MNEMONIC, 1));
    expect((await stored(only)).addressCount).toBe(2);
    expect(await a.changePassword(MINE_PW, 'renewed')).toBe(true);
    expect(await opensWith(await stored(only), 'renewed')).toBe(true);

    // A second page sees the same one wallet, active, and opens it.
    const b = page();
    expect(b.activeWalletId()).toBeNull(); // nothing read yet
    expect((await b.listWallets())[0].active).toBe(true);
    expect(b.activeWalletId()).toBe(only);
    expect(await b.unlock('renewed')).toBe(true);
  });

  it('a fresh page adopts whatever the store calls active', async () => {
    const { other } = await pageOnMine();
    await anotherWindowSwitchesTo(other);

    // What a dApp approval page is: constructed per request, holding nothing.
    const approval = page();
    expect((await approval.listWallets()).find((w) => w.active)?.id).toBe(other);
    expect(approval.activeWalletId()).toBe(other);
    expect(await approval.unlock(OTHER_PW)).toBe(true);
    expect(approval.getAddress(0)).toBe(await addressOf(OTHER_MNEMONIC, 0));
  });
});
