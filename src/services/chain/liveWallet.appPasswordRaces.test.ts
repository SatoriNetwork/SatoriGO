// THE APP PASSWORD ACROSS SEVERAL PAGES, and the states an adversarial review
// found behind it (the app-password design notes §4-§6, "Implementation notes").
//
// WHY THIS FILE EXISTS SEPARATELY FROM liveWallet.appPassword.test.ts: that file
// asks whether ONE session does the right thing. Every finding here needed TWO
// LiveWalletService instances over ONE storage, because that is what the
// extension actually is. The toolbar popup, the side panel (`?panel=1`) and a
// detached window are three pages, each with its own service and its own cached
// master key, all reading and writing one `liveWallets` object. Nothing in the
// single-session suite could see any of it.
//
// It also depends on MemoryStorageAdapter CLONING ON READ. It used to return the
// object it held, so two services in one test shared object identity: a mutation
// in one appeared in the other with no write at all, which is precisely the
// difference these tests are about. Fixing the double is what made them able to
// fail.
//
// Real scrypt (N=2^17) runs throughout. Do NOT lower it to speed this up.

import { beforeEach, describe, expect, it } from 'vitest';

import { LiveWalletService, type WalletEntry } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
// The faithful double plus its ONE interleaving hook, shared with the other
// multi-page suites (src/test/interleavedStorage.ts documents both).
import { InterleavedStorage, interleaved } from '../../test/interleavedStorage';
import { createAppKeyRecord, zeroKey, type AppKeyRecord } from './appKey';
import { makeLegacyV1AppKey } from '../../test/legacyAppKey';

/**
 * Put a SHIPPED-1.4.0 v1 app-key record into the store, the way an install that
 * predates §13.3 has one. setAppPassword() writes v2 now, so this is the only
 * way to reach the v1 code paths that real users are on.
 */
async function installLegacyAppKey(password: string): Promise<void> {
  const legacy = await makeLegacyV1AppKey(password);
  zeroKey(legacy.masterKey); // the store derives its own; this copy is not needed
  const store = await readStore();
  store.appKey = legacy.record;
  await writeStore(store);
}
import { createVault, isVaultRecordV2, unlockVaultString, type VaultRecord } from './vault';
import { deriveAddress, mnemonicToSeed } from './keys';
import { EVRMORE_MAINNET } from './chainParams';
import type { ElectrumClient } from './electrumTypes';

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const THIRD_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const WALLET_PW = 'wallet-password-one';
const OTHER_PW = 'wallet-password-two';
const THIRD_PW = 'wallet-password-three';
const APP_PW = 'one password for the whole wallet';
const NEW_APP_PW = 'a different app password entirely';

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
  appKey?: AppKeyRecord;
}

/** A page: its own service instance, over the shared storage. */
function page(): LiveWalletService {
  return new LiveWalletService(offlineClient);
}

async function readStore(): Promise<StoredShape> {
  const s = await getStorage().get<StoredShape>('liveWallets');
  return s ?? { wallets: [], activeId: '' };
}

async function writeStore(store: StoredShape): Promise<void> {
  await getStorage().set('liveWallets', store);
}

async function entryNamed(name: string): Promise<WalletEntry> {
  const found = (await readStore()).wallets.find((w) => w.name === name);
  if (!found) throw new Error(`no wallet named ${name}`);
  return found;
}

async function vectorAddress(mnemonic = VECTOR_MNEMONIC): Promise<string> {
  const seed = await mnemonicToSeed(mnemonic);
  return deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address;
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

// ---------------------------------------------------------------------------
// F1 + F6. A cached master key is a claim about a record, not a fact.
// ---------------------------------------------------------------------------

describe('app password: a page holding a SUPERSEDED master key', () => {
  it('never migrates a wallet under it, and the seed stays recoverable', async () => {
    // Two wallets, an app password, and two pages open on them.
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await popup.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet B');
    expect(await popup.setAppPassword(APP_PW)).toBe(true);

    const panel = page();
    expect(await panel.unlockApp(APP_PW)).toBe(true);

    // The popup changes the app password. One atomic write: a new record, and
    // every v2 wallet re-wrapped. The panel is still on screen with the OLD key.
    expect(await popup.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });
    expect(panel.appUnlocked()).toBe(true); // it does not know yet

    // In the panel, the user opens Wallet B with its own password. That is the
    // lazy migration's trigger, and the key it would wrap with is the dead one.
    const walletB = (await panel.listWallets()).find((w) => w.name === 'Wallet B')!;
    await panel.switchWallet(walletB.id);
    expect(await panel.unlock(OTHER_PW)).toBe(true);

    // §4's fail-safe: not migrated. Migrating here discarded the v1 record in
    // the same write that wrapped the seed under a key the app record no longer
    // derives, so the words were reachable by NO password at all.
    const stored = await entryNamed('Wallet B');
    expect(isVaultRecordV2(stored.vault)).toBe(false);

    // And every route back is open.
    const fresh = page();
    await fresh.switchWallet(walletB.id);
    expect(await fresh.unlock(OTHER_PW)).toBe(true);
    expect(fresh.getAddress(0)).toBe(await vectorAddress(OTHER_MNEMONIC));
    expect(await unlockVaultString(stored.vault as VaultRecord, OTHER_PW)).toBe(OTHER_MNEMONIC);

    // Wallet A, which was never migrated either, is untouched too.
    expect(isVaultRecordV2((await entryNamed('Wallet A')).vault)).toBe(false);
  }, 300_000);

  it('drops the stale key, so the CORRECT new app password works again', async () => {
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await popup.setAppPassword(APP_PW);
    await popup.unlock(WALLET_PW); // migrate to v2 under APP_PW
    expect(isVaultRecordV2((await entryNamed('Wallet A')).vault)).toBe(true);

    const panel = page();
    expect(await panel.unlockApp(APP_PW)).toBe(true);
    expect(await popup.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });

    // masterKeyFor() used to short-circuit on ANY cached key and never fall back
    // to deriving, so the panel's own lock screen rejected the correct password
    // for the life of the page: the only escape was closing it.
    expect(await panel.unlock(NEW_APP_PW)).toBe(true);
    expect(panel.getAddress(0)).toBe(await vectorAddress());
  }, 300_000);

  it('the OLD app password stops opening a wallet in the stale page too', async () => {
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await popup.setAppPassword(APP_PW);
    await popup.unlock(WALLET_PW);

    const panel = page();
    await panel.unlockApp(APP_PW);
    await popup.changeAppPassword(APP_PW, NEW_APP_PW);

    // The stale key is not a back door either: the superseded password is dead
    // everywhere, including in the page that still had its key in memory.
    expect(await panel.unlock(APP_PW)).toBe(false);
    expect(panel.appUnlocked()).toBe(false);
  }, 300_000);

  it('refuses to migrate when the app record has vanished entirely', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet B');
    await svc.setAppPassword(APP_PW);

    // Something (a downgrade, a partial restore, a corrupted profile) removed
    // the record while this session still held its key.
    const store = await readStore();
    delete store.appKey;
    await writeStore(store);

    const walletB = (await svc.listWallets()).find((w) => w.name === 'Wallet B')!;
    await svc.switchWallet(walletB.id);
    expect(await svc.unlock(OTHER_PW)).toBe(true);
    // Wrapping under a key no stored record derives is exactly the fund-losing
    // write; there is nothing to verify the binding against, so it stays v1.
    expect(isVaultRecordV2((await entryNamed('Wallet B')).vault)).toBe(false);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// F2. saveStore() writes the WHOLE store, and unlock() takes ~300 ms of scrypt.
// ---------------------------------------------------------------------------

describe('app password: a concurrent write in another page', () => {
  it('a wallet imported mid-unlock survives the migration write', async () => {
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await popup.setAppPassword(APP_PW);

    const panel = page();
    await panel.unlockApp(APP_PW);

    // The panel starts an unlock (it reads the store, then spends ~300 ms in
    // scrypt). The popup imports a wallet inside that window.
    const unlocking = panel.unlock(WALLET_PW);
    await popup.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet C');
    expect(await unlocking).toBe(true);

    const after = await readStore();
    // The migration used to write back the snapshot it read BEFORE the scrypt,
    // and Wallet C, seed and all, simply ceased to exist.
    expect(after.wallets.map((w) => w.name).sort()).toEqual(['Wallet A', 'Wallet C']);
    expect(isVaultRecordV2((await entryNamed('Wallet A')).vault)).toBe(true);

    // ...and Wallet C is the wallet it was, not a husk.
    const fresh = page();
    await fresh.switchWallet((await entryNamed('Wallet C')).id);
    expect(await fresh.unlock(OTHER_PW)).toBe(true);
    expect(fresh.getAddress(0)).toBe(await vectorAddress(OTHER_MNEMONIC));
  }, 300_000);

  it('a wallet imported mid-unlock survives the ADDRESS BACKFILL write too', async () => {
    // Same race, on the path an install with no app password takes: unlock()
    // backfills a missing cached address, and that write was the same whole
    // store snapshot.
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    const store = await readStore();
    store.wallets[0].address = ''; // a wallet stored before addresses were cached
    await writeStore(store);

    const panel = page();
    const unlocking = panel.unlock(WALLET_PW);
    await popup.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet C');
    expect(await unlocking).toBe(true);

    const after = await readStore();
    expect(after.wallets.map((w) => w.name).sort()).toEqual(['Wallet A', 'Wallet C']);
    expect((await entryNamed('Wallet A')).address).toBe(await vectorAddress());
  }, 240_000);

  it('a wallet RENAMED in another page keeps its new name through a migration', async () => {
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await popup.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet B');
    await popup.setAppPassword(APP_PW);
    const idA = (await entryNamed('Wallet A')).id;

    const panel = page();
    await panel.unlockApp(APP_PW);
    await panel.switchWallet(idA);
    const unlocking = panel.unlock(WALLET_PW);
    await popup.renameWallet((await entryNamed('Wallet B')).id, 'Savings');
    expect(await unlocking).toBe(true);

    expect((await readStore()).wallets.map((w) => w.name).sort()).toEqual(['Savings', 'Wallet A']);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// N1. THE WHOLE-STORE WRITE, AT THE SOURCE.
//
// Four methods used to write a snapshot taken before their own scrypt, so a
// wallet another page imported in that window was erased outright: seed, vault
// and all. Two of them were new with the app password; two predate it. They are
// not fixed one at a time here, because they were never four bugs: saveStore()
// is a compare-and-swap on `store.rev` now, so a write computed from a store
// that has moved is REFUSED and re-applied to the current one, and a caller that
// forgot to re-read cannot exist.
//
// Every one of these is driven explicitly (InterleavedStorage), so none of them
// depends on scrypt being slower than an import.
// ---------------------------------------------------------------------------

describe('the whole-store write: a wallet imported in the window survives', () => {
  /** Import 'Wallet C' from another page, exactly once, at a named read. */
  function importAtRead(storage: InterleavedStorage, nth = 1): void {
    storage.afterRead(async () => {
      await page().import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet C');
    }, nth);
  }

  async function expectWalletCIntact(): Promise<void> {
    const after = await readStore();
    expect(after.wallets.map((w) => w.name).sort()).toEqual(['Wallet A', 'Wallet C']);
    // Not a husk: the seed is the one that was imported.
    const fresh = page();
    await fresh.switchWallet((await entryNamed('Wallet C')).id);
    expect(await fresh.unlock(OTHER_PW)).toBe(true);
    expect(fresh.getAddress(0)).toBe(await vectorAddress(OTHER_MNEMONIC));
  }

  it('changeAppPassword does not erase it', async () => {
    const storage = interleaved();
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await popup.setAppPassword(APP_PW);
    await popup.unlock(WALLET_PW); // Wallet A -> v2, so there is a key to re-wrap

    importAtRead(storage);
    expect(await page().changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });

    await expectWalletCIntact();
    // ...and the change really happened, on the wallet that had a wrapped key.
    const check = page();
    await check.switchWallet((await entryNamed('Wallet A')).id);
    expect(await check.unlockApp(NEW_APP_PW)).toBe(true);
    expect(await check.unlock('')).toBe(true);
  }, 300_000);

  it('changePassword does not erase it, on an install with NO app password', async () => {
    const storage = interleaved();
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');

    importAtRead(storage);
    expect(await popup.changePassword(WALLET_PW, 'a brand new wallet password')).toBe(true);

    await expectWalletCIntact();
    const check = page();
    await check.switchWallet((await entryNamed('Wallet A')).id);
    expect(await check.unlock('a brand new wallet password')).toBe(true);
  }, 300_000);

  it('setAppPassword does not erase it', async () => {
    const storage = interleaved();
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');

    importAtRead(storage);
    expect(await popup.setAppPassword(APP_PW)).toBe(true);

    await expectWalletCIntact();
    expect((await readStore()).appKey).toBeTruthy();
  }, 300_000);

  it('removeWallet of the LAST wallet does not erase it, and keeps the app record', async () => {
    const storage = interleaved();
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await popup.setAppPassword(APP_PW);
    const onlyId = (await entryNamed('Wallet A')).id;

    // The import lands after removeWallet has read the store: it is about to
    // write "no wallets left", which also drops the app-password record.
    importAtRead(storage);
    await page().removeWallet(onlyId);

    const after = await readStore();
    expect(after.wallets.map((w) => w.name)).toEqual(['Wallet C']);
    // A wallet is left, so the record it may yet protect is NOT dropped.
    expect(after.appKey).toBeTruthy();
    const fresh = page();
    await fresh.switchWallet(after.wallets[0].id);
    expect(await fresh.unlock(OTHER_PW)).toBe(true);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// N5. THE MIGRATION'S RE-READ WINDOW, which the hand-patched re-read narrowed
// but could not close: a write landing between that re-read and the write was
// still lost, sub-millisecond. Only the compare-and-swap catches these.
// ---------------------------------------------------------------------------

describe('the migration write: a page that writes inside its re-read window', () => {
  /** Two wallets, an app password, Wallet A active and still v1, the panel
   *  holding the master key and about to migrate A. */
  async function twoWalletsMidMigration() {
    const storage = interleaved();
    const popup = page();
    await popup.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet B');
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A'); // active
    await popup.setAppPassword(APP_PW);
    const panel = page();
    expect(await panel.unlockApp(APP_PW)).toBe(true);
    return { storage, popup, panel };
  }

  it('an IMPORT inside it is not erased by the migration write', async () => {
    const { storage, popup, panel } = await twoWalletsMidMigration();
    storage.afterRead(async () => {
      await popup.import(THIRD_MNEMONIC, THIRD_PW, 'mainnet', 'Wallet C');
    }, 2);

    expect(await panel.unlock(WALLET_PW)).toBe(true);

    const after = await readStore();
    expect(after.wallets.map((w) => w.name).sort()).toEqual(['Wallet A', 'Wallet B', 'Wallet C']);
    // The migration still happened, on the wallet it was about.
    expect(isVaultRecordV2((await entryNamed('Wallet A')).vault)).toBe(true);
    expect(isVaultRecordV2((await entryNamed('Wallet C')).vault)).toBe(false);
    const fresh = page();
    await fresh.switchWallet((await entryNamed('Wallet C')).id);
    expect(await fresh.unlock(THIRD_PW)).toBe(true);
  }, 300_000);

  it('an APP-PASSWORD CHANGE inside it is not silently undone', async () => {
    const { storage, popup, panel } = await twoWalletsMidMigration();
    storage.afterRead(async () => {
      expect(await popup.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });
    }, 2);

    expect(await panel.unlock(WALLET_PW)).toBe(true);

    // The migration write used to carry the OLD app record back onto disk, so
    // the password the user had just changed to stopped working and the one they
    // had replaced went on working, with nothing anywhere saying so.
    const fresh = page();
    expect(await fresh.unlockApp(NEW_APP_PW)).toBe(true);
    expect(await page().unlockApp(APP_PW)).toBe(false);
    // The migration itself is the fail-safe's business: whichever way it went,
    // Wallet A opens.
    const a = await entryNamed('Wallet A');
    const opener = page();
    await opener.switchWallet(a.id);
    expect(isVaultRecordV2(a.vault) ? await opener.unlock(NEW_APP_PW) : await opener.unlock(WALLET_PW)).toBe(true);
  }, 300_000);

  it('a RENAME inside it keeps the new name', async () => {
    const { storage, popup, panel } = await twoWalletsMidMigration();
    const idB = (await entryNamed('Wallet B')).id;
    storage.afterRead(async () => {
      await popup.renameWallet(idB, 'Savings');
    }, 2);

    expect(await panel.unlock(WALLET_PW)).toBe(true);
    expect((await readStore()).wallets.map((w) => w.name).sort()).toEqual(['Savings', 'Wallet A']);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// N3. The cached master key is bound to a RECORD, not to a check blob.
// ---------------------------------------------------------------------------

describe('app password: a record whose salt was swapped while its check was kept', () => {
  it('does not migrate a wallet under the cached key, and the seed stays openable', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    expect(await svc.setAppPassword(APP_PW)).toBe(true); // the session holds the key

    // ONE hostile edit of storage: replace the salt, keep the check blob. The
    // check blob still belongs to the live key, so proving the key against it
    // still says yes; the salt on disk now derives a DIFFERENT key.
    const decoy = await createAppKeyRecord('anything at all');
    zeroKey(decoy.masterKey);
    const tampered = await readStore();
    tampered.appKey = { ...tampered.appKey!, salt: decoy.record.salt };
    await writeStore(tampered);

    // The one moment it matters: an unlock that would migrate.
    expect(await svc.unlock(WALLET_PW)).toBe(true);

    // Migrating here would have wrapped the seed under the cached key and
    // discarded the v1 record in the same write, and NO password would open the
    // words again: not the app password (the salt derives another key), not the
    // wallet's own (the v1 record is gone).
    const stored = await entryNamed('Wallet A');
    expect(isVaultRecordV2(stored.vault)).toBe(false);
    expect(await unlockVaultString(stored.vault as VaultRecord, WALLET_PW)).toBe(VECTOR_MNEMONIC);

    const fresh = page();
    expect(await fresh.unlock(WALLET_PW)).toBe(true);
    expect(fresh.getAddress(0)).toBe(await vectorAddress());
  }, 300_000);
});

// ---------------------------------------------------------------------------
// TWO GUARDS THAT SURVIVED MUTATION TESTING WITH NOTHING TO CATCH THEM.
// ---------------------------------------------------------------------------

describe('the migration only replaces the v1 record it actually decrypted', () => {
  it('leaves a wallet on v1 when another page gave it a NEW password meanwhile', async () => {
    const storage = interleaved();
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await popup.setAppPassword(APP_PW);

    const panel = page();
    expect(await panel.unlockApp(APP_PW)).toBe(true);

    // The user, in the popup, gives Wallet A a NEW password of its own while the
    // panel is unlocking it. The panel's plaintext came out of the record that
    // password just replaced.
    const NEW_WALLET_PW = 'the password they just chose';
    storage.afterRead(async () => {
      const other = page();
      expect(await other.unlock(WALLET_PW, { migrate: false })).toBe(true);
      expect(await other.changePassword(WALLET_PW, NEW_WALLET_PW)).toBe(true);
    });

    expect(await panel.unlock(WALLET_PW)).toBe(true);

    // Migrating now would discard the record carrying the password the user had
    // just chosen, and answer a password they had already replaced. The state
    // this migration decided from is gone, so it takes the same fail-safe every
    // other failure here takes: stay v1.
    const stored = await entryNamed('Wallet A');
    expect(isVaultRecordV2(stored.vault)).toBe(false);
    expect(await unlockVaultString(stored.vault as VaultRecord, NEW_WALLET_PW)).toBe(VECTOR_MNEMONIC);

    const fresh = page();
    expect(await fresh.unlock(NEW_WALLET_PW)).toBe(true);
    expect(await page().unlock(WALLET_PW)).toBe(false);
  }, 300_000);
});

describe('unlock() re-asserts the wallet it actually opened', () => {
  it('stays on the unlocked wallet CHAIN when another page switches mid-unlock', async () => {
    // loadStore() points the service at whatever the store calls active, and the
    // migration re-reads the store, so another page's switch lands INSIDE this
    // unlock. Without the re-assert at the end of unlock(), the service is left
    // on the other wallet's chain while this wallet's seed is in memory: the
    // page would show, receive to and SIGN for the wrong chain.
    const storage = interleaved();
    const popup = page();
    await popup.import(OTHER_MNEMONIC, OTHER_PW, 'ravencoin-mainnet', 'RVN');
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'EVR'); // active
    await popup.setAppPassword(APP_PW);
    const rvnId = (await entryNamed('RVN')).id;

    const panel = page();
    expect(await panel.unlockApp(APP_PW)).toBe(true);
    storage.afterRead(async () => {
      await page().switchWallet(rvnId);
    });

    expect(await panel.unlock(WALLET_PW)).toBe(true);

    expect(panel.network()).toBe('mainnet');
    const address = panel.getAddress(0);
    expect(address).toBe(await vectorAddress());
    expect(address.startsWith('E')).toBe(true); // Evrmore, not Ravencoin's 'R'
  }, 300_000);
});

// ---------------------------------------------------------------------------
// F3. One seed, one ciphertext.
// ---------------------------------------------------------------------------

describe('seed groups: a password change keeps the group byte-identical', () => {
  /** Two entries sharing one vault record and one seedGroup, exactly the shape
   *  addEvmAccount() writes. Built through storage so this file needs no EVM
   *  engine shim: the invariant is about the records, not about the chain. */
  async function twoAccountsOfOneSeed(): Promise<void> {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Account 1');
    const store = await readStore();
    const first = store.wallets[0];
    first.seedGroup = 'group-x';
    store.wallets.push({
      ...first,
      id: 'w-account-2',
      name: 'Account 2',
      vault: { ...first.vault },
      seedGroup: 'group-x',
      hdIndex: 1,
    });
    await writeStore(store);
  }

  it('changePassword rewrites ONE record for the whole group', async () => {
    await twoAccountsOfOneSeed();
    const svc = page();
    await svc.unlock(WALLET_PW);
    expect(await svc.changePassword(WALLET_PW, OTHER_PW)).toBe(true);

    const after = await readStore();
    // It used to call changeVaultPassword() per member, and each call draws a
    // fresh salt and IV: the group came out byte-divergent holding one secret.
    expect(JSON.stringify(after.wallets[0].vault)).toBe(JSON.stringify(after.wallets[1].vault));
    // Both members open with the new password, and neither with the old one.
    for (const w of after.wallets) {
      expect(await unlockVaultString(w.vault as VaultRecord, OTHER_PW)).toBe(VECTOR_MNEMONIC);
      await expect(unlockVaultString(w.vault as VaultRecord, WALLET_PW)).rejects.toThrow();
    }
  }, 300_000);

  it('a group whose password was EVER changed still migrates to the app key', async () => {
    await twoAccountsOfOneSeed();
    const changer = page();
    await changer.unlock(WALLET_PW);
    await changer.changePassword(WALLET_PW, OTHER_PW);

    const svc = page();
    await svc.setAppPassword(APP_PW);
    expect(await svc.unlock(OTHER_PW)).toBe(true);

    // The migration identifies a group by its members' iv + ciphertext being
    // identical. A split group failed that check forever while the transitional
    // prompt kept promising the wallet would move to the app password.
    const after = await readStore();
    expect(after.wallets.map((w) => w.vault.version)).toEqual([2, 2]);
    expect(after.wallets[0].vault).toEqual(after.wallets[1].vault);
  }, 300_000);

  it('HEALS a group an older build already split, proving the plaintext first', async () => {
    await twoAccountsOfOneSeed();
    // Exactly what the old per-member changeVaultPassword left behind: the same
    // words, different bytes.
    const split = await readStore();
    split.wallets[1].vault = await createVault(VECTOR_MNEMONIC, WALLET_PW);
    expect(split.wallets[0].vault).not.toEqual(split.wallets[1].vault);
    await writeStore(split);

    const svc = page();
    await svc.unlock(WALLET_PW);
    expect(await svc.changePassword(WALLET_PW, OTHER_PW)).toBe(true);

    const after = await readStore();
    expect(after.wallets[0].vault).toEqual(after.wallets[1].vault);
    for (const w of after.wallets) {
      expect(await unlockVaultString(w.vault as VaultRecord, OTHER_PW)).toBe(VECTOR_MNEMONIC);
    }
  }, 300_000);

  it('REFUSES when a group member holds a different secret, rather than overwriting it', async () => {
    await twoAccountsOfOneSeed();
    const tampered = await readStore();
    // Not the same wallet at all: another seed, filed under the same group.
    tampered.wallets[1].vault = await createVault(OTHER_MNEMONIC, WALLET_PW);
    await writeStore(tampered);
    const before = JSON.parse(JSON.stringify(await readStore()));

    const svc = page();
    await svc.unlock(WALLET_PW);
    // One record for the group must never mean "hand this member someone else's
    // secret": the whole change is refused and nothing is written.
    expect(await svc.changePassword(WALLET_PW, OTHER_PW)).toBe(false);
    expect(await readStore()).toEqual(before);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// F5b / F7. The app record's lifetime.
// ---------------------------------------------------------------------------

describe('app password: the record only exists while wallets do', () => {
  it('removing the last wallet removes it, so a NEW wallet is not gated by it', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Old');
    await svc.setAppPassword(APP_PW);
    const id = (await entryNamed('Old')).id;

    await svc.removeWallet(id);
    expect((await readStore()).appKey).toBeUndefined();
    expect(await svc.hasAppPassword()).toBe(false);
    expect(svc.appUnlocked()).toBe(false);

    // The user onboards again, with a password of their own choosing.
    const next = page();
    await next.import(OTHER_MNEMONIC, 'brand-new-password', 'mainnet', 'New');
    expect(await next.hasAppPassword()).toBe(false);

    const fresh = page();
    expect(await fresh.hasAppPassword()).toBe(false); // no app lock screen
    expect(await fresh.unlock('brand-new-password')).toBe(true);
  }, 240_000);

  it('removing one of TWO wallets keeps the record (the other one needs it)', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Keep');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Drop');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(OTHER_PW); // 'Drop' is active, and migrates

    await svc.removeWallet((await entryNamed('Keep')).id);
    expect((await readStore()).appKey).toBeDefined();
    expect(await svc.hasAppPassword()).toBe(true);

    const fresh = page();
    expect(await fresh.unlockApp(APP_PW)).toBe(true);
    expect(await fresh.unlock('')).toBe(true);
  }, 300_000);

  it('setAppPassword REFUSES while a v2 wallet exists with no record', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW); // -> v2
    const migrated = JSON.parse(JSON.stringify(await entryNamed('Wallet A')));

    // The record disappears but the wallet's wrapped key does not.
    const store = await readStore();
    delete store.appKey;
    await writeStore(store);

    // Writing a fresh record here declares a master key that wallet's wrapped
    // key was never sealed to, and buries the evidence of what happened.
    const fresh = page();
    expect(await fresh.setAppPassword('a brand new app password')).toBe(false);
    expect((await readStore()).appKey).toBeUndefined();
    // The damaged wallet is left exactly as it was found.
    expect(await entryNamed('Wallet A')).toEqual(migrated);
  }, 240_000);

  it('setAppPassword still works normally on an install of only v1 wallets', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet B');
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    expect((await readStore()).appKey).toBeDefined();
  }, 240_000);
});

// ---------------------------------------------------------------------------
// F8. Failure is not one thing.
// ---------------------------------------------------------------------------

describe('app password: why a change failed', () => {
  it('names the wallet that could not be re-wrapped, and does not blame the password', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Good');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Bad');
    // A v1 RECORD ON PURPOSE. 'wallet-unreadable' is reported by the re-wrap
    // loop, and only a v1 record still re-wraps wallet keys on a password
    // change (§13.3 removed that work from v2). Installing the legacy record by
    // hand is what keeps this failure path covered for the users who have one.
    await installLegacyAppKey(APP_PW);
    // The record went straight into storage, so this session has never derived
    // its master key and would migrate nothing. setAppPassword() used to leave
    // the key in hand as a side effect; installing a record by hand does not.
    expect(await svc.unlockApp(APP_PW)).toBe(true);
    await svc.unlock(OTHER_PW); // 'Bad' migrates
    await svc.switchWallet((await entryNamed('Good')).id);
    await svc.unlock(WALLET_PW); // 'Good' migrates

    // 'Bad' loses its wrapped key (a truncated or corrupted profile write).
    const store = await readStore();
    const bad = store.wallets.find((w) => w.name === 'Bad')!;
    (bad.vault as { wrappedKey: string }).wrappedKey =
      'AAAA' + (bad.vault as { wrappedKey: string }).wrappedKey.slice(4);
    await writeStore(store);
    const beforeRecord = JSON.parse(JSON.stringify((await readStore()).appKey));

    const changer = page();
    const result = await changer.changeAppPassword(APP_PW, NEW_APP_PW);
    // It used to be a bare `false`, which the store rendered as "Incorrect
    // current password." The password was right; the user retyped it forever
    // and nothing ever named the wallet that was actually broken.
    expect(result).toEqual({ ok: false, reason: 'wallet-unreadable', wallet: 'Bad' });

    // Refusing the whole change is still correct: nothing moved.
    expect((await readStore()).appKey).toEqual(beforeRecord);
    const fresh = page();
    await fresh.switchWallet((await entryNamed('Good')).id);
    expect(await fresh.unlockApp(APP_PW)).toBe(true);
    expect(await fresh.unlock('')).toBe(true);
  }, 300_000);

  it('a genuinely wrong current password still says exactly that', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW);
    expect(await svc.changeAppPassword('not the app password', NEW_APP_PW)).toEqual({
      ok: false,
      reason: 'wrong-password',
    });
  }, 240_000);
});

// ---------------------------------------------------------------------------
// F9. The convenience half of `passwordless`, made visible and reversible.
// ---------------------------------------------------------------------------

describe('app password: "do not ask when sending" after a passwordless wallet migrates', () => {
  it('can be turned off, and then a send needs the app password', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, '', 'mainnet', 'Free'); // passwordless
    await svc.setAppPassword(APP_PW);
    await svc.unlock(''); // migrates, and §6 splits the flag

    expect((await svc.listWallets())[0].noSendPassword).toBe(true);
    // The pre-broadcast gate waves anything through while it is on.
    expect(await svc.verifyPassword('not the app password')).toBe(true);

    expect(await svc.setNoSendPassword(false)).toBe(true);
    // It was permanent and invisible: nothing anywhere could clear it.
    expect((await entryNamed('Free')).noSendPassword).toBeUndefined();
    expect((await svc.listWallets())[0].noSendPassword).toBeUndefined();
    expect(await svc.verifyPassword('not the app password')).toBe(false);
    expect(await svc.verifyPassword(APP_PW)).toBe(true);

    // And back on again, for a user who wanted the convenience — but it now
    // costs the app password, because it is the direction that REMOVES the gate.
    expect(await svc.setNoSendPassword(true, APP_PW)).toBe(true);
    expect(await svc.verifyPassword('anything at all')).toBe(true);
  }, 300_000);

  // -------------------------------------------------------------------------
  // N2. Turning the send gate OFF is a security decision, so it costs a password.
  // -------------------------------------------------------------------------

  it('cannot be turned ON with no password: the send gate is not a free switch', async () => {
    const svc = page();
    // A wallet that was NEVER passwordless, so nothing about it ever implied
    // "spendable with nothing typed".
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW); // migrates to v2
    expect(await svc.verifyPassword('guessed')).toBe(false);

    // No password at all, and a wrong one: both refused, on the store and in the
    // gate. This used to return true and switch the pre-broadcast check off for
    // every page, on a wallet whose owner had never asked for that.
    expect(await svc.setNoSendPassword(true)).toBe(false);
    expect(await svc.setNoSendPassword(true, 'guessed')).toBe(false);
    expect((await entryNamed('Wallet A')).noSendPassword).toBeUndefined();
    expect(await svc.verifyPassword('guessed')).toBe(false);

    // A page that is already app-unlocked gets no discount: the proof is
    // re-derived, exactly as the send gate itself re-derives it.
    expect(svc.appUnlocked()).toBe(true);
    expect(await svc.setNoSendPassword(true, 'guessed')).toBe(false);
    expect(await svc.verifyPassword('guessed')).toBe(false);

    // The real password does it, and only then does the gate stand down.
    expect(await svc.setNoSendPassword(true, APP_PW)).toBe(true);
    expect(await svc.verifyPassword('guessed')).toBe(true);

    // ...and another page sees the same thing, because the gate is a property of
    // the store, not of a session.
    const panel = page();
    expect(await panel.verifyPassword('guessed')).toBe(true);
    // Turning it back ON stays free: it only ever ADDS a check.
    expect(await panel.setNoSendPassword(false)).toBe(true);
    expect(await panel.verifyPassword('guessed')).toBe(false);
  }, 300_000);

  it('refuses on a v1 wallet, where the same convenience IS `passwordless`', async () => {
    const svc = page();
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    expect(await svc.setNoSendPassword(true)).toBe(false);
    expect((await entryNamed('Wallet A')).noSendPassword).toBeUndefined();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The guarantee none of the above is allowed to cost.
// ---------------------------------------------------------------------------

describe('app password: an install that never sets one, across two pages', () => {
  it('is byte-identical after every new read path runs in both', async () => {
    const popup = page();
    await popup.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await popup.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet B');
    const before = JSON.parse(JSON.stringify(await readStore()));

    const panel = page();
    expect(await panel.hasAppPassword()).toBe(false);
    expect(await panel.unlock(OTHER_PW)).toBe(true);
    expect(await panel.verifyPassword(OTHER_PW)).toBe(true);
    expect(await panel.revealMnemonic(OTHER_PW)).toBe(OTHER_MNEMONIC);
    await panel.listWallets();
    expect(await popup.unlock(OTHER_PW)).toBe(true);

    expect(await readStore()).toEqual(before);
    expect('appKey' in (await readStore())).toBe(false);
  }, 300_000);
});
