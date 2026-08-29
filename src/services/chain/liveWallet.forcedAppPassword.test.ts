// THE FORCED APP-PASSWORD SETUP, at the service level
// (the app-password design notes §12).
//
// A wallet with `passwordless: true` holds its seed under an EMPTY passphrase:
// effectively in the clear, spendable by anyone who can use the computer. The
// owner's decision is that such an install must be REQUIRED to set an app
// password at launch, with no skip. This file pins the three things that makes
// safe or unsafe:
//
//   * THE TRIGGER is exactly "a wallet opens with no password AND there is no
//     app password", proved for all four combinations, plus the one damaged
//     state where the demand could not be satisfied and so is not made;
//   * THE BACKUP IS REACHABLE FIRST, per wallet, with nothing typed, and only
//     for a wallet that is already in exactly that state;
//   * ONLY THE UNPROTECTED WALLETS MOVE. In a mixed install the wallets that
//     already have their own passwords are not read, not rewritten and not
//     reachable by this flow, and forgetting the new app password does not cost
//     them, which is the property that makes forcing defensible at all.
//
// Real scrypt (N=2^17) runs throughout. Do NOT lower it to speed this up.

import { beforeEach, describe, expect, it } from 'vitest';
import { LiveWalletService, type WalletEntry } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { isVaultRecordV2, type VaultRecord } from './vault';
import type { AppKeyRecord } from './appKey';
import type { ElectrumClient } from './electrumTypes';
import { interleaved } from '../../test/interleavedStorage';

// BIP39 test vectors. Publicly known and deliberately unfunded.
const SEED_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SEED_C = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const SEED_D = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
// The m/44'/175'/0'/0/0 key of SEED_A. NOT A SECRET: derived from the public
// test vector above, on a deliberately unfunded path.
const PK_WIF = 'L37GeVaqwRDGoeHckfe8DmzsbDTBgmEuMBAZ7KDPDHN6RpUovWRP';

const PW_ONE = 'wallet-password-one';
const PW_TWO = 'wallet-password-two';
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
  appKey?: AppKeyRecord;
  rev?: number;
}

async function readStore(): Promise<StoredShape> {
  const s = await getStorage().get<StoredShape>('liveWallets');
  return s ?? { wallets: [], activeId: '' };
}

async function entryNamed(name: string): Promise<WalletEntry> {
  const found = (await readStore()).wallets.find((w) => w.name === name);
  if (!found) throw new Error(`no wallet named ${name}`);
  return found;
}

/** A DETACHED deep copy, so a "before" value cannot be mutated in place by the
 *  code under test and make every later comparison pass vacuously. */
function snap<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

// ---------------------------------------------------------------------------
// 1. The trigger, and nothing but the trigger
// ---------------------------------------------------------------------------

describe('forced app password: the trigger', () => {
  it('1. a passwordless wallet and NO app password: required', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, '', 'mainnet', 'Open Wallet');
    expect(await svc.hasAppPassword()).toBe(false);
    expect(await svc.appPasswordRequired()).toBe(true);
  }, 60_000);

  it('2. a passwordless wallet and an app password ALREADY set: not required', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, '', 'mainnet', 'Open Wallet');
    // Set the app password but decline the move, which is exactly what the
    // transitional prompt's "Open without changing it" leaves behind.
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    expect(await svc.unlock('', { migrate: false })).toBe(true);
    const still = await entryNamed('Open Wallet');
    expect(isVaultRecordV2(still.vault)).toBe(false);
    expect(still.passwordless).toBe(true);

    // The user HAS a password, was told what moving the wallet would do, and
    // said no. This screen does not re-ask a question already answered.
    expect(await svc.appPasswordRequired()).toBe(false);
  }, 90_000);

  it('3. no passwordless wallet and NO app password: not required (the untouched user)', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, PW_ONE, 'mainnet', 'Wallet A');
    await svc.import(SEED_B, PW_TWO, 'mainnet', 'Wallet B');
    const before = snap(await readStore());

    expect(await svc.appPasswordRequired()).toBe(false);

    // ASKING WRITES NOTHING. The trigger is a read, and an install that never
    // opted in must be byte for byte what it was.
    expect(await readStore()).toEqual(before);
  }, 60_000);

  it('4. no passwordless wallet and an app password set: not required', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, PW_ONE, 'mainnet', 'Wallet A');
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    expect(await svc.appPasswordRequired()).toBe(false);
  }, 60_000);

  it('is false with NO wallets at all: there is nothing to protect yet', async () => {
    const svc = new LiveWalletService(offlineClient);
    expect(await svc.appPasswordRequired()).toBe(false);
  }, 30_000);

  it('is false in the one state where setting a password could not work, so the screen is never a dead end', async () => {
    // A v2 wallet with NO app record on disk. setAppPassword() refuses there on
    // purpose (writing a fresh record declares a key those wrapped keys were
    // never sealed to), so demanding a password would be a demand nothing could
    // satisfy: a screen with no way out and no way to the wallet. Unreachable by
    // any path this code has; asserted because "must never brick a wallet" is
    // the rule this screen is measured against.
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, '', 'mainnet', 'Open Wallet');
    await svc.import(SEED_B, PW_ONE, 'mainnet', 'Protected');
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    // Migrate the protected one, then rip the app record out from under it.
    await svc.switchWallet((await entryNamed('Protected')).id);
    expect(await svc.unlock(PW_ONE)).toBe(true);
    expect(isVaultRecordV2((await entryNamed('Protected')).vault)).toBe(true);
    const damaged = await readStore();
    delete damaged.appKey;
    await getStorage().set('liveWallets', damaged);

    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.hasAppPassword()).toBe(false);
    // A passwordless wallet IS present, so only the third clause holds this back.
    expect((await readStore()).wallets.some((w) => w.passwordless)).toBe(true);
    expect(await fresh.appPasswordRequired()).toBe(false);
    // And the thing it would have demanded really is impossible, which is why.
    expect(await fresh.setAppPassword('another app password entirely')).toBe(false);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. The backup, offered before it is taken away
// ---------------------------------------------------------------------------

describe('forced app password: the reveal-first step', () => {
  it('hands back the phrase of a NAMED passwordless wallet with no password, without switching wallets', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, '', 'mainnet', 'Open One');
    await svc.import(SEED_B, '', 'mainnet', 'Open Two');
    await svc.import(SEED_C, PW_ONE, 'mainnet', 'Protected');
    // The page is on the LAST import; the wallets whose phrase this screen
    // offers are the other two.
    const activeBefore = svc.activeWalletId();
    const openOne = await entryNamed('Open One');
    const openTwo = await entryNamed('Open Two');

    const first = await svc.revealNoPasswordBackup(openOne.id);
    expect(first).toEqual({ kind: 'seed', secret: SEED_A });
    const second = await svc.revealNoPasswordBackup(openTwo.id);
    expect(second).toEqual({ kind: 'seed', secret: SEED_B });

    // A PAGE STAYS ON THE WALLET IT OPENED: reading another wallet's backup is
    // not an activation, and the shared active id has not moved either.
    expect(svc.activeWalletId()).toBe(activeBefore);
    expect((await readStore()).activeId).toBe(activeBefore);
  }, 90_000);

  it('hands back the PRIVATE KEY of a passwordless imported-key wallet (it has no phrase)', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.importPrivateKey(PK_WIF, '', 'mainnet', 'Key Wallet');
    const entry = await entryNamed('Key Wallet');
    expect(await svc.revealNoPasswordBackup(entry.id)).toEqual({ kind: 'pk', secret: PK_WIF });
  }, 60_000);

  it('refuses every wallet that is not already readable with no password', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, '', 'mainnet', 'Open One');
    await svc.import(SEED_B, PW_ONE, 'mainnet', 'Protected');

    // A wallet with its own password: its seed cannot be read here, and offering
    // it would be a promise this code cannot keep.
    const protectedEntry = await entryNamed('Protected');
    expect(await svc.revealNoPasswordBackup(protectedEntry.id)).toBeNull();
    // An unknown id.
    expect(await svc.revealNoPasswordBackup('no-such-wallet')).toBeNull();

    // And once the wallet has moved to the app key, the app password is what
    // opens it: this route is closed even though the entry once was passwordless.
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    const openOne = await entryNamed('Open One');
    await svc.switchWallet(openOne.id);
    expect(await svc.unlock('')).toBe(true);
    expect(isVaultRecordV2((await entryNamed('Open One')).vault)).toBe(true);
    expect(await svc.revealNoPasswordBackup(openOne.id)).toBeNull();
  }, 120_000);

  it('reveals nothing that is not already reachable today with nothing typed', async () => {
    // The equivalence the method rests on: the SAME words come out of the
    // ordinary reveal path (switch to the wallet, reveal with the empty
    // password) that a passwordless wallet has always had.
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, '', 'mainnet', 'Open One');
    const entry = await entryNamed('Open One');
    const viaScreen = await svc.revealMnemonic('');
    const viaSetup = await svc.revealNoPasswordBackup(entry.id);
    expect(viaScreen).toBe(SEED_A);
    expect(viaSetup?.secret).toBe(viaScreen);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. What setting the password actually does
// ---------------------------------------------------------------------------

describe('forced app password: setting it', () => {
  it('moves every passwordless wallet to the app key, keeping "sends without a password" as it was', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, '', 'mainnet', 'Open One');
    await svc.import(SEED_B, '', 'mainnet', 'Open Two');

    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    const moved = await svc.migratePasswordlessWallets();
    expect(moved.kept).toEqual([]);
    expect(moved.migrated).toHaveLength(2);

    for (const name of ['Open One', 'Open Two']) {
      const entry = await entryNamed(name);
      expect(isVaultRecordV2(entry.vault)).toBe(true);
      // §6: the seed is protected now, so `passwordless` stops being true, and
      // the CONVENIENCE half survives as a property of its own. PRESERVED, not
      // enabled: these wallets never asked for a password when sending.
      expect(entry.passwordless).toBe(false);
      expect(entry.noSendPassword).toBe(true);
    }

    // A FRESH PAGE opens them with the app password and nothing else.
    const fresh = new LiveWalletService(offlineClient);
    await fresh.switchWallet((await entryNamed('Open One')).id);
    expect(await fresh.unlock(APP_PW)).toBe(true);
    expect(await fresh.revealMnemonic(APP_PW)).toBe(SEED_A);
    await fresh.switchWallet((await entryNamed('Open Two')).id);
    expect(await fresh.unlock(APP_PW)).toBe(true);
    expect(await fresh.revealMnemonic(APP_PW)).toBe(SEED_B);

    // And the empty passphrase no longer opens either of them.
    const hostile = new LiveWalletService(offlineClient);
    await hostile.switchWallet((await entryNamed('Open One')).id);
    expect(await hostile.unlock('')).toBe(false);
  }, 180_000);

  it('does nothing at all without a master key in the session', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, '', 'mainnet', 'Open One');
    const before = snap(await readStore());
    // No app password, so no master key: the fail-safe is "leave it v1".
    expect(await svc.migratePasswordlessWallets()).toEqual({ migrated: [], kept: [] });
    expect(await readStore()).toEqual(before);
  }, 60_000);

  it('leaves a wallet on v1 when its own password is NOT the empty one, and says so', async () => {
    // The flag lying about the vault. Nothing here can read that seed, and
    // nothing here rewrites it: the design's fail-safe, reported rather than
    // hidden so the screen can tell the user.
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, PW_ONE, 'mainnet', 'Mislabelled');
    const store = await readStore();
    store.wallets[0].passwordless = true; // the flag alone, vault untouched
    await getStorage().set('liveWallets', store);
    const before = snap(await entryNamed('Mislabelled'));

    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.setAppPassword(APP_PW)).toBe(true);
    const moved = await fresh.migratePasswordlessWallets();
    expect(moved.migrated).toEqual([]);
    expect(moved.kept).toHaveLength(1);
    // Byte for byte what it was: no seed was read, so nothing was rewritten, and
    // whatever really opens this vault still opens it.
    expect(await entryNamed('Mislabelled')).toEqual(before);
    expect(isVaultRecordV2(before.vault)).toBe(false);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. THE MIXED INSTALL: two with no password, two with their own
// ---------------------------------------------------------------------------

describe('forced app password: a mixed install', () => {
  /** Two passwordless wallets and two with their own passwords. */
  async function mixed(): Promise<LiveWalletService> {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(SEED_A, '', 'mainnet', 'Open One');
    await svc.import(SEED_B, PW_ONE, 'mainnet', 'Guarded One');
    await svc.import(SEED_C, '', 'mainnet', 'Open Two');
    await svc.import(SEED_D, PW_TWO, 'mainnet', 'Guarded Two');
    return svc;
  }

  it('1. the trigger fires even though two wallets are already protected', async () => {
    const svc = await mixed();
    expect(await svc.appPasswordRequired()).toBe(true);
    const list = await svc.listWallets();
    expect(list.filter((w) => w.passwordless).map((w) => w.name).sort()).toEqual([
      'Open One',
      'Open Two',
    ]);
  }, 120_000);

  it('2. only the passwordless wallets migrate; the guarded ones are not touched at all', async () => {
    const svc = await mixed();
    const guardedBefore = [snap(await entryNamed('Guarded One')), snap(await entryNamed('Guarded Two'))];

    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    const moved = await svc.migratePasswordlessWallets();
    expect(moved.migrated).toHaveLength(2);
    expect(moved.kept).toEqual([]);

    // The two that had no password are now app-key protected.
    for (const name of ['Open One', 'Open Two']) {
      expect(isVaultRecordV2((await entryNamed(name)).vault)).toBe(true);
    }
    // The two that had their own are byte for byte what they were: same v1
    // record, same salt, same IV, same ciphertext, same flags. Their seeds are
    // unreadable without passwords the user has not typed, so this flow cannot
    // and must not have rewritten them.
    for (const before of guardedBefore) {
      const after = await entryNamed(before.name);
      expect(after).toEqual(before);
      expect(isVaultRecordV2(after.vault)).toBe(false);
      expect((after.vault as VaultRecord).version).toBe(1);
    }
  }, 180_000);

  it('3. the reveal-first step offers exactly the passwordless wallets, and no other', async () => {
    const svc = await mixed();
    const byName = new Map((await readStore()).wallets.map((w) => [w.name, w.id] as const));
    expect((await svc.revealNoPasswordBackup(byName.get('Open One')!))?.secret).toBe(SEED_A);
    expect((await svc.revealNoPasswordBackup(byName.get('Open Two')!))?.secret).toBe(SEED_C);
    expect(await svc.revealNoPasswordBackup(byName.get('Guarded One')!)).toBeNull();
    expect(await svc.revealNoPasswordBackup(byName.get('Guarded Two')!)).toBeNull();
  }, 120_000);

  it('4. after setup each guarded wallet still asks its OWN password once, and can decline', async () => {
    const svc = await mixed();
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    await svc.migratePasswordlessWallets();

    // A fresh page: app password first, then the guarded wallet's own, once.
    const page = new LiveWalletService(offlineClient);
    expect(await page.unlockApp(APP_PW)).toBe(true);
    await page.switchWallet((await entryNamed('Guarded One')).id);
    // The app password is NOT this wallet's password, and is not accepted as one.
    expect(await page.unlock(APP_PW)).toBe(false);
    expect(await page.unlock(PW_ONE)).toBe(true);
    expect(isVaultRecordV2((await entryNamed('Guarded One')).vault)).toBe(true);

    // The other one declines and stays exactly where it was.
    const guardedTwoBefore = snap(await entryNamed('Guarded Two'));
    await page.switchWallet(guardedTwoBefore.id);
    expect(await page.unlock(PW_TWO, { migrate: false })).toBe(true);
    expect(await entryNamed('Guarded Two')).toEqual(guardedTwoBefore);
  }, 240_000);

  it('5. FORGETTING THE APP PASSWORD DOES NOT COST THE WALLETS IT NEVER PROTECTED', async () => {
    // The property that makes forcing defensible in a mixed install. The two
    // wallets that kept their own passwords open with them, on a page that has
    // never seen the app password and cannot derive it.
    const svc = await mixed();
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    await svc.migratePasswordlessWallets();

    const amnesiac = new LiveWalletService(offlineClient);
    expect(await amnesiac.unlockApp('a password nobody remembers')).toBe(false);
    expect(amnesiac.appUnlocked()).toBe(false);

    await amnesiac.switchWallet((await entryNamed('Guarded One')).id);
    expect(await amnesiac.unlock(PW_ONE, { migrate: false })).toBe(true);
    expect(await amnesiac.revealMnemonic(PW_ONE)).toBe(SEED_B);

    await amnesiac.switchWallet((await entryNamed('Guarded Two')).id);
    expect(await amnesiac.unlock(PW_TWO, { migrate: false })).toBe(true);
    expect(await amnesiac.revealMnemonic(PW_TWO)).toBe(SEED_D);

    // And the migrated ones are genuinely behind the forgotten password, which
    // is what the screen said would happen.
    await amnesiac.switchWallet((await entryNamed('Open One')).id);
    expect(await amnesiac.unlock('')).toBe(false);
    expect(await amnesiac.unlock(PW_ONE)).toBe(false);
  }, 240_000);

  it('6. the wallet list says which password opens which wallet', async () => {
    const svc = await mixed();
    expect((await svc.listWallets()).some((w) => w.appProtected)).toBe(false);
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    await svc.migratePasswordlessWallets();

    const list = await svc.listWallets();
    const appProtected = list.filter((w) => w.appProtected).map((w) => w.name).sort();
    const ownPassword = list.filter((w) => !w.appProtected).map((w) => w.name).sort();
    expect(appProtected).toEqual(['Open One', 'Open Two']);
    expect(ownPassword).toEqual(['Guarded One', 'Guarded Two']);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 5. Two pages over one storage
// ---------------------------------------------------------------------------

describe('forced app password: two pages, one storage', () => {
  it('does not erase a wallet another page imports during the setup', async () => {
    // The forced setup spends two scrypts (setAppPassword, then each
    // migration) between reading the store and writing it, which is exactly the
    // window the compare-and-swap exists for. Driven, not hoped for: the other
    // page's whole import runs at the FIRST read of `liveWallets`.
    const storage = interleaved();
    const pageA = new LiveWalletService(offlineClient);
    await pageA.import(SEED_A, '', 'mainnet', 'Open One');

    const pageB = new LiveWalletService(offlineClient);
    storage.afterRead(async () => {
      await pageB.import(SEED_B, PW_ONE, 'mainnet', 'Imported Meanwhile');
    }, 1);

    expect(await pageA.setAppPassword(APP_PW)).toBe(true);
    const moved = await pageA.migratePasswordlessWallets();

    const store = await readStore();
    // Nothing was lost.
    expect(store.wallets.map((w) => w.name).sort()).toEqual(['Imported Meanwhile', 'Open One']);
    expect(store.appKey).toBeTruthy();
    // The unprotected wallet still moved.
    expect(moved.migrated).toHaveLength(1);
    expect(isVaultRecordV2((await entryNamed('Open One')).vault)).toBe(true);
    // And the wallet page B imported keeps its own password and its v1 record.
    const imported = await entryNamed('Imported Meanwhile');
    expect(isVaultRecordV2(imported.vault)).toBe(false);
    const check = new LiveWalletService(offlineClient);
    await check.switchWallet(imported.id);
    expect(await check.unlock(PW_ONE, { migrate: false })).toBe(true);
  }, 240_000);

  it('a second page that already held the wallet open still sees the new state on its next read', async () => {
    const pageA = new LiveWalletService(offlineClient);
    await pageA.import(SEED_A, '', 'mainnet', 'Open One');
    const pageB = new LiveWalletService(offlineClient);
    expect(await pageB.appPasswordRequired()).toBe(true);

    expect(await pageA.setAppPassword(APP_PW)).toBe(true);
    await pageA.migratePasswordlessWallets();

    // Page B holds no master key of its own, so the wallet is now behind the app
    // password there too, and the forced screen is no longer owed.
    expect(await pageB.appPasswordRequired()).toBe(false);
    expect(await pageB.hasAppPassword()).toBe(true);
    expect(pageB.appUnlocked()).toBe(false);
    expect(await pageB.unlock('')).toBe(false);
    expect(await pageB.unlock(APP_PW)).toBe(true);
  }, 180_000);
});
