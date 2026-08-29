// LOSING THE APP PASSWORD: the recovery code and the backup file
// (the app-password design notes §13).
//
// Two routes back into a wallet whose app password is gone, and the reason this
// file is long: both of them are, by construction, a SECOND FULL KEY to
// someone's coins. The tests that matter here are not "does the happy path
// work" but:
//
//   * a code keeps working across a password change (§13.2 — the property the
//     whole v2 record shape exists to buy, and the one a naive implementation
//     silently loses);
//   * regenerating a code REVOKES the old one;
//   * the v1 -> v2 upgrade leaves every wallet openable, on a real seed, with
//     the address checked against an independent derivation;
//   * a backup file cannot be opened with the wrong password, cannot be
//     tampered with, and a restore that would strand wallets is refused rather
//     than written.
//
// Real scrypt (N=2^17) runs throughout. Do NOT lower it to speed this up.

import { beforeEach, describe, expect, it } from 'vitest';
import { LiveWalletService, type WalletEntry } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import {
  formatRecoveryCode,
  generateRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_LENGTH,
  zeroKey,
  type AppKeyRecord,
} from './appKey';
import {
  createBackup,
  inspectBackup,
  readBackup,
  backupFileName,
  NotABackupFileError,
  WrongBackupPasswordError,
} from './backup';
import { makeLegacyV1AppKey } from '../../test/legacyAppKey';
import { isVaultRecordV2 } from './vault';
import { deriveAddress, mnemonicToSeed } from './keys';
import { EVRMORE_MAINNET } from './chainParams';
import type { ElectrumClient } from './electrumTypes';

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const WALLET_PW = 'wallet-password-one';
const OTHER_PW = 'wallet-password-two';
const APP_PW = 'one password for the whole wallet';
const NEW_APP_PW = 'a different app password entirely';
const FILE_PW = 'the backup file password';

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

function snap<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

/** The address the vector seed must derive on Evrmore, computed independently
 *  of everything under test. */
async function vectorAddress(mnemonic = VECTOR_MNEMONIC): Promise<string> {
  const seed = await mnemonicToSeed(mnemonic);
  return deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address;
}

/** Install a SHIPPED-1.4.0 v1 record, the shape every existing install has. */
async function installLegacyAppKey(password: string): Promise<void> {
  const legacy = await makeLegacyV1AppKey(password);
  zeroKey(legacy.masterKey);
  const store = await readStore();
  store.appKey = legacy.record;
  await getStorage().set('liveWallets', store);
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

// ---------------------------------------------------------------------------
// 1. The code as a string
// ---------------------------------------------------------------------------

describe('recovery code: the encoding', () => {
  it('is 160 bits of Crockford base32, shown in groups of four', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(normalizeRecoveryCode(code)).toHaveLength(RECOVERY_CODE_LENGTH);
    // Never the excluded letters: they are what people misread off paper.
    expect(code).not.toMatch(/[ILOU]/);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateRecoveryCode()));
    expect(seen.size).toBe(50);
  });

  it('forgives everything about how it was typed, and nothing about what it is', () => {
    const code = generateRecoveryCode();
    const canonical = normalizeRecoveryCode(code)!;
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(canonical);
    expect(normalizeRecoveryCode(code.replace(/-/g, ''))).toBe(canonical);
    expect(normalizeRecoveryCode(code.replace(/-/g, ' '))).toBe(canonical);
    expect(normalizeRecoveryCode(` ${code} `)).toBe(canonical);
    // The three misreadings the alphabet was chosen to make impossible.
    expect(normalizeRecoveryCode(canonical.replace(/1/g, 'I'))).toBe(canonical);
    expect(normalizeRecoveryCode(canonical.replace(/1/g, 'l'))).toBe(canonical);
    expect(normalizeRecoveryCode(canonical.replace(/0/g, 'O'))).toBe(canonical);
    // But not about length or alphabet: those mean it is not a code.
    expect(normalizeRecoveryCode(canonical.slice(1))).toBeNull();
    expect(normalizeRecoveryCode(`${canonical}A`)).toBeNull();
    expect(normalizeRecoveryCode(`${canonical.slice(1)}!`)).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
  });

  it('formats a normalized code back for display', () => {
    const code = generateRecoveryCode();
    expect(formatRecoveryCode(normalizeRecoveryCode(code)!)).toBe(code);
  });
});

// ---------------------------------------------------------------------------
// 2. Making one
// ---------------------------------------------------------------------------

describe('recovery code: creating it', () => {
  it('needs the app password, and refuses without an app password at all', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    expect(await svc.createRecoveryCode(APP_PW)).toEqual({ ok: false, reason: 'no-app-password' });

    await svc.setAppPassword(APP_PW);
    expect(await svc.createRecoveryCode('not the app password')).toEqual({
      ok: false,
      reason: 'wrong-password',
    });
    expect(await svc.hasRecoveryCode()).toBe(false);
  }, 240_000);

  it('on a v2 record it attaches a second wrap and rewrites NO wallet', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW); // migrates to v2
    const before = snap(await entryNamed('Wallet A'));
    expect(isVaultRecordV2(before.vault)).toBe(true);

    const made = await svc.createRecoveryCode(APP_PW);
    expect(made.ok).toBe(true);
    expect(await svc.hasRecoveryCode()).toBe(true);
    // The wallet is untouched, byte for byte.
    expect(snap(await entryNamed('Wallet A'))).toEqual(before);
    // And the session it was made from is still open.
    expect(svc.appUnlocked()).toBe(true);
  }, 240_000);

  it('opens the app, and the password still works too', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW);
    const made = await svc.createRecoveryCode(APP_PW);
    if (!made.ok) throw new Error('expected a code');

    const page = new LiveWalletService(offlineClient);
    expect(await page.unlockWithRecoveryCode(made.code, NEW_APP_PW)).toEqual({ ok: true });
    expect(page.appUnlocked()).toBe(true);
    await page.switchWallet((await entryNamed('Wallet A')).id);
    expect(await page.unlock('')).toBe(true);
    expect(page.getAddress(0)).toBe(await vectorAddress());

    // The password given during the recovery is now THE password...
    const after = new LiveWalletService(offlineClient);
    expect(await after.unlockApp(NEW_APP_PW)).toBe(true);
    // ...and the forgotten one is not.
    expect(await new LiveWalletService(offlineClient).unlockApp(APP_PW)).toBe(false);
  }, 240_000);

  it('a wrong code is refused and changes nothing', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const made = await svc.createRecoveryCode(APP_PW);
    if (!made.ok) throw new Error('expected a code');
    const before = snap(await readStore());

    const page = new LiveWalletService(offlineClient);
    expect(await page.unlockWithRecoveryCode(generateRecoveryCode(), NEW_APP_PW)).toEqual({
      ok: false,
      reason: 'wrong-code',
    });
    // Not even the shape of a code.
    expect(await page.unlockWithRecoveryCode('hello', NEW_APP_PW)).toEqual({
      ok: false,
      reason: 'wrong-code',
    });
    expect(page.appUnlocked()).toBe(false);
    expect(snap(await readStore())).toEqual(before);
    // The real password is untouched by any of it.
    expect(await new LiveWalletService(offlineClient).unlockApp(APP_PW)).toBe(true);
  }, 240_000);

  it('refuses to leave the user without a password', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const made = await svc.createRecoveryCode(APP_PW);
    if (!made.ok) throw new Error('expected a code');
    // A code is not a way to run without a password: it is a way to set one.
    expect(await new LiveWalletService(offlineClient).unlockWithRecoveryCode(made.code, '')).toEqual(
      { ok: false, reason: 'empty-password' },
    );
  }, 240_000);

  it('says so when there is no code on this device', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    expect(
      await new LiveWalletService(offlineClient).unlockWithRecoveryCode(
        generateRecoveryCode(),
        NEW_APP_PW,
      ),
    ).toEqual({ ok: false, reason: 'no-recovery-code' });
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 3. THE property: a code outlives a password change (§13.2)
// ---------------------------------------------------------------------------

describe('recovery code: surviving a password change', () => {
  it('still opens the wallet after the app password has been changed', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW);
    const made = await svc.createRecoveryCode(APP_PW);
    if (!made.ok) throw new Error('expected a code');

    // The user changes their password, twice, long after filing the code away.
    const changer = new LiveWalletService(offlineClient);
    await changer.unlockApp(APP_PW);
    expect(await changer.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });
    await changer.unlockApp(NEW_APP_PW);
    expect(await changer.changeAppPassword(NEW_APP_PW, 'a third app password')).toEqual({
      ok: true,
    });

    // The code from before any of that still works. This is the entire reason
    // the master key stopped being scrypt(password): under the old model this
    // code would open a key that no longer exists.
    const page = new LiveWalletService(offlineClient);
    expect(await page.unlockWithRecoveryCode(made.code, 'the recovered password')).toEqual({
      ok: true,
    });
    await page.switchWallet((await entryNamed('Wallet A')).id);
    expect(await page.unlock('')).toBe(true);
    expect(page.getAddress(0)).toBe(await vectorAddress());
  }, 300_000);

  it('regenerating REVOKES the previous code', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const first = await svc.createRecoveryCode(APP_PW);
    const second = await svc.createRecoveryCode(APP_PW);
    if (!first.ok || !second.ok) throw new Error('expected two codes');
    expect(first.code).not.toBe(second.code);

    expect(
      await new LiveWalletService(offlineClient).unlockWithRecoveryCode(first.code, NEW_APP_PW),
    ).toEqual({ ok: false, reason: 'wrong-code' });
    expect(
      await new LiveWalletService(offlineClient).unlockWithRecoveryCode(second.code, NEW_APP_PW),
    ).toEqual({ ok: true });
  }, 300_000);

  it('removing it needs the password, and then the code is dead', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const made = await svc.createRecoveryCode(APP_PW);
    if (!made.ok) throw new Error('expected a code');

    expect(await svc.removeRecoveryCode('the wrong password')).toBe(false);
    expect(await svc.hasRecoveryCode()).toBe(true);
    expect(await svc.removeRecoveryCode(APP_PW)).toBe(true);
    expect(await svc.hasRecoveryCode()).toBe(false);
    expect(
      await new LiveWalletService(offlineClient).unlockWithRecoveryCode(made.code, NEW_APP_PW),
    ).toEqual({ ok: false, reason: 'no-recovery-code' });
    // The wallet still opens with the password it always had.
    expect(await new LiveWalletService(offlineClient).unlockApp(APP_PW)).toBe(true);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 4. The v1 -> v2 upgrade (§13.4)
// ---------------------------------------------------------------------------

describe('recovery code: upgrading a legacy v1 record', () => {
  it('re-keys every wallet, keeps them all openable, and rotates the master key', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Migrated');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Still v1');
    await installLegacyAppKey(APP_PW);
    expect(await svc.unlockApp(APP_PW)).toBe(true);
    await svc.switchWallet((await entryNamed('Migrated')).id);
    await svc.unlock(WALLET_PW); // migrates to v2 under the v1-derived key

    const v2Before = snap(await entryNamed('Migrated'));
    const v1Before = snap(await entryNamed('Still v1'));
    if (!isVaultRecordV2(v2Before.vault)) throw new Error('expected v2');
    const oldRecord = snap((await readStore()).appKey!);
    expect(oldRecord.version).toBe(1);

    const made = await svc.createRecoveryCode(APP_PW);
    if (!made.ok) throw new Error('expected a code');

    const record = (await readStore()).appKey!;
    expect(record.version).toBe(2);
    // A FRESH master key, not the old bytes stored under a wrapper: the salt
    // moved, and the wallet's wrap had to move with it.
    expect(record.salt).not.toBe(oldRecord.salt);
    const v2After = await entryNamed('Migrated');
    if (!isVaultRecordV2(v2After.vault)) throw new Error('expected v2');
    expect(v2After.vault.wrappedKey).not.toBe(v2Before.vault.wrappedKey);
    // The seed ciphertext itself was copied, never rewritten.
    expect(v2After.vault.ciphertext).toBe(v2Before.vault.ciphertext);
    // The v1 wallet was not touched at all.
    expect(snap(await entryNamed('Still v1'))).toEqual(v1Before);

    // Everything opens: same password, and the wallet derives the same address.
    const page = new LiveWalletService(offlineClient);
    expect(await page.unlockApp(APP_PW)).toBe(true);
    await page.switchWallet(v2Before.id);
    expect(await page.unlock('')).toBe(true);
    expect(page.getAddress(0)).toBe(await vectorAddress());

    // And the wallet that never moved still opens with its own password.
    const other = new LiveWalletService(offlineClient);
    expect(await other.unlockApp(APP_PW)).toBe(true);
    await other.switchWallet(v1Before.id);
    expect(await other.unlock(OTHER_PW)).toBe(true);
    expect(other.getAddress(0)).toBe(await vectorAddress(OTHER_MNEMONIC));

    // The code made during the upgrade works.
    const rec = new LiveWalletService(offlineClient);
    expect(await rec.unlockWithRecoveryCode(made.code, NEW_APP_PW)).toEqual({ ok: true });
  }, 300_000);

  it('leaves the session holding the NEW master key, so the next migration is sound', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Migrated');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Later');
    await installLegacyAppKey(APP_PW);
    await svc.unlockApp(APP_PW);
    const made = await svc.createRecoveryCode(APP_PW);
    expect(made.ok).toBe(true);
    expect(svc.appUnlocked()).toBe(true);

    // A wallet migrated AFTER the upgrade, from the same session, must be
    // wrapped under the key the record now derives — not the key that session
    // was holding a moment ago.
    await svc.switchWallet((await entryNamed('Later')).id);
    expect(await svc.unlock(OTHER_PW)).toBe(true);
    expect(isVaultRecordV2((await entryNamed('Later')).vault)).toBe(true);

    const page = new LiveWalletService(offlineClient);
    expect(await page.unlockApp(APP_PW)).toBe(true);
    await page.switchWallet((await entryNamed('Later')).id);
    expect(await page.unlock('')).toBe(true);
    expect(page.getAddress(0)).toBe(await vectorAddress(OTHER_MNEMONIC));
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 5. The backup file, as bytes
// ---------------------------------------------------------------------------

describe('backup file: the envelope', () => {
  it('round-trips a store and names nothing in the clear', async () => {
    const store = { wallets: [{ id: 'w1', name: 'My savings' }], activeId: 'w1' };
    const text = await createBackup(store, FILE_PW, new Date('2026-08-26T10:00:00Z'));
    // Nothing identifying survives outside the ciphertext.
    expect(text).not.toContain('My savings');
    expect(text).not.toContain('w1');
    const envelope = JSON.parse(text);
    expect(envelope.format).toBe('satori-go-backup');
    expect(envelope.createdAt).toBe('2026-08-26T10:00:00.000Z');
    expect(Object.keys(envelope).sort()).toEqual(
      ['ciphertext', 'createdAt', 'format', 'iv', 'kdf', 'version'].sort(),
    );

    const back = await readBackup<typeof store>(text, FILE_PW);
    expect(back.store).toEqual(store);
    expect(back.createdAt).toBe('2026-08-26T10:00:00.000Z');
  }, 240_000);

  it('tells "wrong password" apart from "not a backup"', async () => {
    const text = await createBackup({ a: 1 }, FILE_PW, new Date('2026-08-26T10:00:00Z'));
    await expect(readBackup(text, 'nope')).rejects.toBeInstanceOf(WrongBackupPasswordError);
    await expect(readBackup('{"hello":1}', FILE_PW)).rejects.toBeInstanceOf(NotABackupFileError);
    await expect(readBackup('not json at all', FILE_PW)).rejects.toBeInstanceOf(
      NotABackupFileError,
    );
    expect(inspectBackup('not json at all')).toBeNull();
    expect(inspectBackup(text)?.createdAt).toBe('2026-08-26T10:00:00.000Z');
  }, 240_000);

  it('refuses a tampered ciphertext and hostile KDF parameters', async () => {
    const text = await createBackup({ a: 1 }, FILE_PW, new Date('2026-08-26T10:00:00Z'));
    const env = JSON.parse(text);

    const flipped = { ...env, ciphertext: `A${env.ciphertext.slice(1)}` };
    await expect(readBackup(JSON.stringify(flipped), FILE_PW)).rejects.toBeInstanceOf(
      WrongBackupPasswordError,
    );
    // An absurd N would ask scrypt for a terabyte before any auth check could
    // reject it, so it is refused as malformed instead of attempted.
    const huge = { ...env, kdf: { ...env.kdf, N: 2 ** 30 } };
    await expect(readBackup(JSON.stringify(huge), FILE_PW)).rejects.toBeInstanceOf(
      NotABackupFileError,
    );
    const notPow2 = { ...env, kdf: { ...env.kdf, N: 12345 } };
    await expect(readBackup(JSON.stringify(notPow2), FILE_PW)).rejects.toBeInstanceOf(
      NotABackupFileError,
    );
    // A file from a future build says so, rather than failing as a bad password.
    const future = { ...env, version: 99 };
    await expect(readBackup(JSON.stringify(future), FILE_PW)).rejects.toThrow(/newer version/i);
  }, 240_000);

  it('names the file by date', () => {
    expect(backupFileName(new Date(2026, 7, 26))).toBe('satori-go-backup-2026-08-26.json');
  });
});

// ---------------------------------------------------------------------------
// 6. Backup and restore, through the service
// ---------------------------------------------------------------------------

describe('backup file: exporting and restoring', () => {
  it('restores wallets onto an empty device, and they open', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW); // v2
    const exported = await svc.exportBackup(FILE_PW);
    expect(exported.fileName).toMatch(/^satori-go-backup-\d{4}-\d{2}-\d{2}\.json$/);

    // A brand-new device.
    setStorageForTests(new MemoryStorageAdapter());
    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.hasAppPassword()).toBe(false);

    const read = await fresh.readBackupFile(exported.text, FILE_PW);
    if (!read.ok) throw new Error('expected the file to open');
    expect(read.preview.wallets.map((w) => w.name)).toEqual(['Wallet A']);
    expect(read.preview.losing).toEqual([]);
    expect(read.preview.deviceEmpty).toBe(true);
    // Nothing is written until it is applied.
    expect((await readStore()).wallets).toEqual([]);

    expect(await fresh.applyRestore('replace')).toEqual({ ok: true, wallets: 1 });
    const page = new LiveWalletService(offlineClient);
    expect(await page.unlockApp(APP_PW)).toBe(true);
    await page.switchWallet((await entryNamed('Wallet A')).id);
    expect(await page.unlock('')).toBe(true);
    expect(page.getAddress(0)).toBe(await vectorAddress());
  }, 300_000);

  it('a wrong file password reveals nothing and writes nothing', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    const exported = await svc.exportBackup(FILE_PW);

    setStorageForTests(new MemoryStorageAdapter());
    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.readBackupFile(exported.text, 'wrong')).toEqual({
      ok: false,
      reason: 'wrong-password',
    });
    expect(fresh.pendingRestorePreview()).toBeNull();
    expect(await fresh.applyRestore('replace')).toEqual({ ok: false, reason: 'no-pending' });
    expect((await readStore()).wallets).toEqual([]);
  }, 300_000);

  it('names the wallets a replace would destroy', async () => {
    const first = new LiveWalletService(offlineClient);
    await first.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'In the file');
    const exported = await first.exportBackup(FILE_PW);

    // A different device with a wallet of its own.
    setStorageForTests(new MemoryStorageAdapter());
    const other = new LiveWalletService(offlineClient);
    await other.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Only here');

    const read = await other.readBackupFile(exported.text, FILE_PW);
    if (!read.ok) throw new Error('expected the file to open');
    expect(read.preview.losing.map((w) => w.name)).toEqual(['Only here']);
    expect(read.preview.gaining).toBe(1);
    expect(read.preview.deviceEmpty).toBe(false);
    // Neither side has an app record here, so every wallet on both sides opens
    // with its own password and merging cannot strand any of them: it IS
    // offered. The case where it is refused is the next test.
    expect(read.preview.canMerge).toBe(true);
  }, 300_000);

  it('offers merge only when the file and the device share an app record', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Shared');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW);
    const exported = await svc.exportBackup(FILE_PW);

    // Same install, one more wallet added after the backup was taken.
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Added later');
    const readSame = await svc.readBackupFile(exported.text, FILE_PW);
    if (!readSame.ok) throw new Error('expected the file to open');
    expect(readSame.preview.canMerge).toBe(true);
    expect(readSame.preview.losing.map((w) => w.name)).toEqual(['Added later']);
    // Merging adds nothing here: the file has no wallet this device lacks.
    expect(await svc.applyRestore('merge')).toEqual({ ok: true, wallets: 0 });
    expect((await readStore()).wallets).toHaveLength(2);

    // A DIFFERENT install: another app password, so another master key.
    setStorageForTests(new MemoryStorageAdapter());
    const stranger = new LiveWalletService(offlineClient);
    await stranger.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Theirs');
    await stranger.setAppPassword('a completely different app password');
    const readOther = await stranger.readBackupFile(exported.text, FILE_PW);
    if (!readOther.ok) throw new Error('expected the file to open');
    // Merging would drop a wallet wrapped to a master key this device does not
    // have: a wallet that opens with nothing. It is refused, not attempted.
    expect(readOther.preview.canMerge).toBe(false);
    expect(await stranger.applyRestore('merge')).toEqual({ ok: false, reason: 'merge-unsafe' });
    expect((await readStore()).wallets.map((w) => w.name)).toEqual(['Theirs']);
  }, 300_000);

  it('merge adds only what is missing, and leaves the rest alone', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Both');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'File only');
    const exported = await svc.exportBackup(FILE_PW);

    // Drop one wallet locally, as a second device would never have had it.
    const store = await readStore();
    const keep = store.wallets.filter((w) => w.name === 'Both');
    await getStorage().set('liveWallets', { ...store, wallets: keep, activeId: keep[0].id });

    const page = new LiveWalletService(offlineClient);
    const read = await page.readBackupFile(exported.text, FILE_PW);
    if (!read.ok) throw new Error('expected the file to open');
    expect(read.preview.canMerge).toBe(true);
    expect(await page.applyRestore('merge')).toEqual({ ok: true, wallets: 1 });
    expect((await readStore()).wallets.map((w) => w.name).sort()).toEqual(['Both', 'File only']);

    const opened = new LiveWalletService(offlineClient);
    await opened.switchWallet((await entryNamed('File only')).id);
    expect(await opened.unlock(OTHER_PW)).toBe(true);
    expect(opened.getAddress(0)).toBe(await vectorAddress(OTHER_MNEMONIC));
  }, 300_000);

  it('refuses a file whose v2 wallets have no app record to open them', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW); // v2
    const store = await readStore();
    delete store.appKey; // the record the wallets are wrapped to, removed
    const text = await createBackup(store, FILE_PW, new Date('2026-08-26T10:00:00Z'));

    setStorageForTests(new MemoryStorageAdapter());
    const fresh = new LiveWalletService(offlineClient);
    // Restoring it would hand the user wallets that open with nothing.
    expect(await fresh.readBackupFile(text, FILE_PW)).toEqual({ ok: false, reason: 'malformed' });
  }, 300_000);

  it('refuses a file whose wallets are not wallets', async () => {
    setStorageForTests(new MemoryStorageAdapter());
    const svc = new LiveWalletService(offlineClient);
    const now = new Date('2026-08-26T10:00:00Z');
    for (const bad of [
      { wallets: 'not an array', activeId: '' },
      { wallets: [{ name: 'no id', network: 'mainnet', vault: {} }], activeId: '' },
      { wallets: [{ id: 'a', name: 'no vault', network: 'mainnet' }], activeId: '' },
      { wallets: [{ id: 'a', name: 'x', network: 'mainnet', vault: {} }, { id: 'a', name: 'dup', network: 'mainnet', vault: {} }], activeId: '' },
    ]) {
      const text = await createBackup(bad, FILE_PW, now);
      expect(await svc.readBackupFile(text, FILE_PW)).toEqual({ ok: false, reason: 'malformed' });
    }
  }, 300_000);

  it('locks after a replace, because nothing it held governs the new store', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    await svc.unlock(WALLET_PW);
    const exported = await svc.exportBackup(FILE_PW);

    setStorageForTests(new MemoryStorageAdapter());
    const fresh = new LiveWalletService(offlineClient);
    await fresh.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Theirs');
    await fresh.setAppPassword('their app password');
    expect(fresh.appUnlocked()).toBe(true);

    const read = await fresh.readBackupFile(exported.text, FILE_PW);
    expect(read.ok).toBe(true);
    expect(await fresh.applyRestore('replace')).toEqual({ ok: true, wallets: 1 });
    // The record that governed every wallet has been replaced.
    expect(fresh.appUnlocked()).toBe(false);
    expect(fresh.isUnlocked()).toBe(false);
    expect(await fresh.verifyAppPassword('their app password')).toBe(false);
    expect(await fresh.verifyAppPassword(APP_PW)).toBe(true);
  }, 300_000);

  it('forgets a decoded backup that was never confirmed', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    const exported = await svc.exportBackup(FILE_PW);
    const read = await svc.readBackupFile(exported.text, FILE_PW);
    expect(read.ok).toBe(true);
    expect(svc.pendingRestorePreview()).not.toBeNull();
    svc.cancelRestore();
    expect(svc.pendingRestorePreview()).toBeNull();
    expect(await svc.applyRestore('replace')).toEqual({ ok: false, reason: 'no-pending' });
  }, 300_000);
});
