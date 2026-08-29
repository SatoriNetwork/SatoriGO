// THE APP PASSWORD, at the service level (the app-password design notes §4-§6).
//
// The owner's binding constraint is that an update must never strand a wallet
// created before it, so most of this file is about what must NOT happen:
//   * a v1 record stays readable forever, and a wallet whose password is never
//     supplied stays v1, stays listed and still opens later;
//   * migration writes forward, VERIFIES, and only then replaces — with a
//     forced failure injected at every step, proving the entry is still v1 and
//     the secret still recoverable afterwards;
//   * a seed group moves as one, or not at all;
//   * an install with NO app password behaves byte for byte as it did before.
//
// Real scrypt (N=2^17) runs throughout. Do NOT lower it to speed this up.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- forced-failure injection ------------------------------------------------
// vi.mock is hoisted, so the switches live in a hoisted box. Both hooks sit on
// the boundary liveWallet.ts crosses (its imports from './vault'), which is the
// only way to corrupt a step from outside: an intra-module call inside vault.ts
// would not be intercepted.
const inject = vi.hoisted(() => ({
  /** Rewrite the v2 record createVaultV2 just built (bad wrap / bad ciphertext). */
  corruptNewRecord: null as null | ((record: Record<string, unknown>) => Record<string, unknown>),
  /** Make the verify-decrypt hand back the WRONG plaintext. */
  mismatchedRoundTrip: false,
}));

vi.mock('./vault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vault')>();
  return {
    ...actual,
    createVaultV2: async (secret: string | Uint8Array, masterKey: Uint8Array) => {
      const record = await actual.createVaultV2(secret, masterKey);
      return inject.corruptNewRecord
        ? (inject.corruptNewRecord({ ...record }) as unknown as typeof record)
        : record;
    },
    unlockVaultV2: async (record: import('./vault').VaultRecordV2, masterKey: Uint8Array) => {
      if (inject.mismatchedRoundTrip) return new TextEncoder().encode('this is not the secret');
      return actual.unlockVaultV2(record, masterKey);
    },
  };
});

// The EVM engine, so the seed-group test can build real EVM accounts (the build
// flag is off in tests; this is the same shim liveWallet.evmAccounts.test.ts uses).
vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>();
  return { ...actual, loadEvmModules: async () => await import('./evm') };
});

import { LiveWalletService, type WalletEntry } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { deriveMasterKey, zeroKey, type AppKeyRecord } from './appKey';
import { makeLegacyV1AppKey } from '../../test/legacyAppKey';
import { bytesToBase64 } from './base64';
import { createVault, isVaultRecordV2, unlockVaultString, type VaultRecord } from './vault';
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

/** A MemoryStorageAdapter that records every write and can be made to throw. */
class RecordingStorage extends MemoryStorageAdapter {
  readonly writes: Array<{ key: string; json: string }> = [];
  failWhen: ((key: string, value: unknown) => boolean) | null = null;

  override async set(key: string, value: unknown): Promise<void> {
    this.writes.push({ key, json: JSON.stringify(value) });
    if (this.failWhen?.(key, value)) throw new Error('storage-quota-exceeded');
    return super.set(key, value);
  }
}

let storage: RecordingStorage;

interface StoredShape {
  wallets: WalletEntry[];
  activeId: string;
  appKey?: AppKeyRecord;
}

/**
 * A DETACHED deep copy. MemoryStorageAdapter.get() hands back the object it
 * holds, so a "before" value captured by reference would be mutated in place by
 * the very code under test and every comparison against it would pass
 * vacuously. Every before/after assertion here goes through this.
 */
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

/** The address the given seed must derive on Evrmore, computed independently. */
async function vectorAddress(mnemonic = VECTOR_MNEMONIC): Promise<string> {
  const seed = await mnemonicToSeed(mnemonic);
  return deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address;
}

beforeEach(() => {
  inject.corruptNewRecord = null;
  inject.mismatchedRoundTrip = false;
  storage = new RecordingStorage();
  setStorageForTests(storage);
});

// ---------------------------------------------------------------------------
// 1. The no-app-password path is untouched
// ---------------------------------------------------------------------------

describe('app password: an install that never sets one', () => {
  it('behaves exactly as before — v1 records, own passwords, no new fields anywhere', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Wallet B');

    expect(await svc.hasAppPassword()).toBe(false);
    expect(svc.appUnlocked()).toBe(false);

    const store = await readStore();
    // No app record is written, and not so much as a key for one.
    expect(store.appKey).toBeUndefined();
    expect('appKey' in store).toBe(false);
    // Both vaults are v1, self-describing scrypt records, exactly as before.
    for (const w of store.wallets) {
      expect(w.vault.version).toBe(1);
      expect((w.vault as VaultRecord).kdf).toBe('scrypt');
      expect((w.vault as VaultRecord).N).toBe(2 ** 17);
      expect(w.noSendPassword).toBeUndefined();
    }

    // The summary keeps its EXACT historical key set: neither new field appears.
    const list = await svc.listWallets();
    expect(Object.keys(list[0]).sort()).toEqual(
      ['active', 'address', 'createdAt', 'family', 'id', 'kind', 'name', 'network', 'passwordless'].sort(),
    );
    expect(list.some((w) => 'appProtected' in w)).toBe(false);

    // And every password behaviour is the old one, per wallet.
    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.unlock(WALLET_PW)).toBe(false); // wallet B is active
    expect(await fresh.unlock(OTHER_PW)).toBe(true);
    expect(await fresh.verifyPassword(OTHER_PW)).toBe(true);
    expect(await fresh.verifyPassword(WALLET_PW)).toBe(false);
    expect(await fresh.revealMnemonic(OTHER_PW)).toBe(OTHER_MNEMONIC);
    expect(await fresh.revealMnemonic(WALLET_PW)).toBeNull();
  }, 120_000);

  it('unlock never migrates when there is no app password to migrate to', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    const before = snap(await entryNamed('Wallet A'));
    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.unlock(WALLET_PW)).toBe(true);
    expect(snap(await entryNamed('Wallet A'))).toEqual(before);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Setting the app password, and reading both record versions
// ---------------------------------------------------------------------------

describe('app password: setting it', () => {
  it('writes one record, migrates NOTHING, and leaves every wallet openable as before', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    const before = snap(await entryNamed('Wallet A'));

    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    expect(await svc.hasAppPassword()).toBe(true);
    expect(svc.appUnlocked()).toBe(true); // the user just proved it

    const store = await readStore();
    expect(store.appKey?.version).toBe(2);
    expect(store.appKey?.N).toBe(2 ** 17);
    // §5: "Setting it migrates nothing immediately. Nothing to fear at this step."
    expect(snap(await entryNamed('Wallet A'))).toEqual(before);
    expect(isVaultRecordV2((await entryNamed('Wallet A')).vault)).toBe(false);

    // A second set is refused: that is what changeAppPassword is for.
    expect(await svc.setAppPassword('another one')).toBe(false);
    expect(await svc.verifyAppPassword(APP_PW)).toBe(true);
    expect(await svc.verifyAppPassword('another one')).toBe(false);

    // The wallet still opens exactly as it did a moment ago.
    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.unlock(WALLET_PW, { migrate: false })).toBe(true);
  }, 150_000);

  it('refuses an empty app password', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    expect(await svc.setAppPassword('')).toBe(false);
    expect(await svc.hasAppPassword()).toBe(false);
  }, 60_000);

  it('unlockApp rejects the wrong password and holds no key after it', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);

    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.unlockApp('not it')).toBe(false);
    expect(fresh.appUnlocked()).toBe(false);
    expect(await fresh.unlockApp(APP_PW)).toBe(true);
    expect(fresh.appUnlocked()).toBe(true);
    fresh.lockApp();
    expect(fresh.appUnlocked()).toBe(false);
    expect(fresh.isUnlocked()).toBe(false);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. Migration: v1 -> v2, only on a successful unlock
// ---------------------------------------------------------------------------

describe('app password: lazy migration', () => {
  it('moves a wallet to v2 the moment it is opened with its OWN password, and never asks again', async () => {
    const address = await vectorAddress();
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);

    // A fresh session: app password first, then the wallet's own password once.
    const session = new LiveWalletService(offlineClient);
    expect(await session.unlockApp(APP_PW)).toBe(true);
    expect(await session.unlock(WALLET_PW)).toBe(true);
    expect(session.getAddress(0)).toBe(address);

    const migrated = await entryNamed('Wallet A');
    expect(migrated.vault.version).toBe(2);
    expect(isVaultRecordV2(migrated.vault)).toBe(true);
    if (!isVaultRecordV2(migrated.vault)) throw new Error('unreachable');
    expect(migrated.vault.keySource).toBe('app');
    expect(migrated.vault.wrappedKey).toBeTruthy();
    // No KDF material survives on the wallet record: the cost moved to the app record.
    expect(migrated.vault).not.toHaveProperty('salt');

    // The summary now says so.
    const summary = (await session.listWallets()).find((w) => w.name === 'Wallet A');
    expect(summary?.appProtected).toBe(true);

    // A LATER session opens it with the app password alone: no second prompt.
    const next = new LiveWalletService(offlineClient);
    expect(await next.unlockApp(APP_PW)).toBe(true);
    expect(await next.unlock('')).toBe(true);
    expect(next.getAddress(0)).toBe(address);
    // ...and the OLD wallet password is now meaningless for opening it.
    const wrong = new LiveWalletService(offlineClient);
    expect(await wrong.unlock(WALLET_PW)).toBe(false);
    // ...while the APP password alone opens it even in a session that never
    // called unlockApp (the dApp approval page's fresh service).
    const dapp = new LiveWalletService(offlineClient);
    expect(await dapp.unlock(APP_PW)).toBe(true);
    expect(dapp.getAddress(0)).toBe(address);
  }, 180_000);

  it('migrates a passwordless wallet and splits "do not ask when sending" out of it (§6)', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, '', 'mainnet', 'Open Wallet'); // passwordless
    expect((await entryNamed('Open Wallet')).passwordless).toBe(true);
    await svc.setAppPassword(APP_PW);

    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    expect(await session.unlock('')).toBe(true);

    const entry = await entryNamed('Open Wallet');
    expect(isVaultRecordV2(entry.vault)).toBe(true);
    // The seed IS protected now, so the flag that meant "empty passphrase" is
    // false; the convenience it also carried survives as its own property.
    expect(entry.passwordless).toBe(false);
    expect(entry.noSendPassword).toBe(true);

    const summary = (await session.listWallets())[0];
    expect(summary.passwordless).toBe(false);
    expect(summary.appProtected).toBe(true);
    expect(summary.noSendPassword).toBe(true);

    // Sending still asks for nothing...
    expect(await session.verifyPassword('anything at all')).toBe(true);
    // ...but the seed itself is behind the app password now.
    expect(await session.revealMnemonic('anything at all')).toBeNull();
    expect(await session.revealMnemonic(APP_PW)).toBe(VECTOR_MNEMONIC);
    // ...and a fresh session cannot open it with nothing.
    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.unlock('')).toBe(false);
    expect(await fresh.unlock(APP_PW)).toBe(true);
  }, 180_000);

  it('does NOT migrate when the user declines (migrate:false), and the wallet still opens', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const before = snap(await entryNamed('Wallet A'));

    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    expect(await session.unlock(WALLET_PW, { migrate: false })).toBe(true);
    expect(session.isUnlocked()).toBe(true);
    // Untouched, byte for byte.
    expect(snap(await entryNamed('Wallet A'))).toEqual(before);
    expect((await session.listWallets())[0].appProtected).toBeUndefined();
    // It is still listed and still opens with its own password.
    const later = new LiveWalletService(offlineClient);
    expect(await later.unlock(WALLET_PW, { migrate: false })).toBe(true);
  }, 150_000);

  it('never migrates from a REVEAL, only from an unlock', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const before = snap(await entryNamed('Wallet A'));

    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    // The plaintext is in hand here too, but consent for the move belongs to the
    // unlock prompt, so a reveal must leave the record alone.
    expect(await session.revealMnemonic(WALLET_PW)).toBe(VECTOR_MNEMONIC);
    expect(snap(await entryNamed('Wallet A'))).toEqual(before);
  }, 150_000);

  it('does not migrate when the app is LOCKED, even with the right wallet password', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const before = snap(await entryNamed('Wallet A'));

    const session = new LiveWalletService(offlineClient); // never unlockApp'd
    expect(session.appUnlocked()).toBe(false);
    expect(await session.unlock(WALLET_PW)).toBe(true);
    expect(snap(await entryNamed('Wallet A'))).toEqual(before);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. Write forward, VERIFY, then replace — with a forced failure at each step
// ---------------------------------------------------------------------------

describe('app password: verify-before-replace, forced failure at every step', () => {
  /** One migrated-ready wallet plus a session that already holds the master key. */
  async function armed(): Promise<LiveWalletService> {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    return session;
  }

  /** Every failure must look the same from outside: the unlock succeeded, the
   *  entry is still v1, and the secret is still recoverable with its own password. */
  async function expectStillV1AndRecoverable(unlockResult: boolean): Promise<void> {
    expect(unlockResult).toBe(true); // the user notices nothing
    const entry = await entryNamed('Wallet A');
    expect(entry.vault.version).toBe(1);
    expect(isVaultRecordV2(entry.vault)).toBe(false);
    expect(entry.passwordless).toBe(false);
    expect(entry.noSendPassword).toBeUndefined();
    // The v1 record is not merely PRESENT: it still decrypts to the seed.
    expect(await unlockVaultString(entry.vault as VaultRecord, WALLET_PW)).toBe(VECTOR_MNEMONIC);
    // ...and a later, ordinary session opens the wallet with it.
    const later = new LiveWalletService(offlineClient);
    expect(await later.unlock(WALLET_PW, { migrate: false })).toBe(true);
    expect(later.getAddress(0)).toBe(await vectorAddress());
  }

  it('STEP 2 — a bad WRAP (the wallet key cannot be unwrapped) aborts the migration', async () => {
    const session = await armed();
    inject.corruptNewRecord = (record) => {
      const wrapped = record.wrappedKey as string;
      // Flip a character inside the base64 so the GCM tag on the wrap fails.
      return { ...record, wrappedKey: (wrapped[0] === 'A' ? 'B' : 'A') + wrapped.slice(1) };
    };
    await expectStillV1AndRecoverable(await session.unlock(WALLET_PW));
  }, 180_000);

  it('STEP 2 — a bad CIPHERTEXT (the secret cannot be decrypted back) aborts the migration', async () => {
    const session = await armed();
    inject.corruptNewRecord = (record) => {
      const ct = record.ciphertext as string;
      return { ...record, ciphertext: (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1) };
    };
    await expectStillV1AndRecoverable(await session.unlock(WALLET_PW));
  }, 180_000);

  it('STEP 3 — a MISMATCHED plaintext on the verify decrypt aborts the migration', async () => {
    const session = await armed();
    // The record decrypts fine, but to something that is NOT the secret. This is
    // the case a GCM tag cannot catch, and the byte-for-byte compare is the only
    // thing standing between it and a wallet whose seed is gone.
    inject.mismatchedRoundTrip = true;
    await expectStillV1AndRecoverable(await session.unlock(WALLET_PW));
  }, 180_000);

  it('STEP 4 — a STORAGE WRITE that throws leaves v1 in place, in memory and on disk', async () => {
    const session = await armed();
    storage.failWhen = (_key, value) => {
      const wallets = (value as StoredShape).wallets ?? [];
      return wallets.some((w) => isVaultRecordV2(w.vault));
    };
    const ok = await session.unlock(WALLET_PW);
    storage.failWhen = null;
    // The v1 record is discarded only as part of the write, so a failed write
    // discards nothing. This adapter hands out the very object it holds, so a
    // half-applied mutation would be visible here: the roll-back is what keeps
    // it from being.
    await expectStillV1AndRecoverable(ok);
    const persisted = await readStore();
    expect(persisted.wallets.every((w) => !isVaultRecordV2(w.vault))).toBe(true);
    // The app record itself survived: it was written before any of this.
    expect(persisted.appKey).toBeDefined();
    // The migration DID try (so this is not a vacuous pass).
    expect(storage.writes.some((w) => w.json.includes('"version":2'))).toBe(true);
  }, 180_000);

  it('a failed migration is retried on the NEXT unlock and then succeeds', async () => {
    const session = await armed();
    inject.mismatchedRoundTrip = true;
    expect(await session.unlock(WALLET_PW)).toBe(true);
    expect(isVaultRecordV2((await entryNamed('Wallet A')).vault)).toBe(false);

    inject.mismatchedRoundTrip = false;
    const again = new LiveWalletService(offlineClient);
    await again.unlockApp(APP_PW);
    expect(await again.unlock(WALLET_PW)).toBe(true);
    expect(isVaultRecordV2((await entryNamed('Wallet A')).vault)).toBe(true);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 5. Nothing is stranded
// ---------------------------------------------------------------------------

describe('app password: a wallet whose password is never supplied', () => {
  it('stays v1 through set, change and a lock/unlock cycle, and still opens at the end', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Migrated');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Forgotten');
    const forgotten = snap(await entryNamed('Forgotten'));
    const migratedId = (await entryNamed('Migrated')).id;

    // 1. Set the app password.
    await svc.setAppPassword(APP_PW);
    expect(snap(await entryNamed('Forgotten'))).toEqual(forgotten);

    // 2. Open ONLY the first wallet, which migrates. The second is never opened.
    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    await session.switchWallet(migratedId);
    expect(await session.unlock(WALLET_PW)).toBe(true);
    expect(isVaultRecordV2((await entryNamed('Migrated')).vault)).toBe(true);
    expect(snap(await entryNamed('Forgotten'))).toEqual(forgotten);

    // 3. Change the app password. v1 wallets are not the app password's to move.
    expect(await session.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });
    expect(snap(await entryNamed('Forgotten'))).toEqual(forgotten);

    // 4. A lock/unlock cycle.
    const after = new LiveWalletService(offlineClient);
    after.lockApp();
    expect(await after.unlockApp(NEW_APP_PW)).toBe(true);
    expect(snap(await entryNamed('Forgotten'))).toEqual(forgotten);

    // Still listed...
    const list = await after.listWallets();
    expect(list.map((w) => w.name).sort()).toEqual(['Forgotten', 'Migrated']);
    expect(list.find((w) => w.name === 'Forgotten')?.appProtected).toBeUndefined();
    expect(list.find((w) => w.name === 'Migrated')?.appProtected).toBe(true);

    // ...and it still opens, with the password it always had.
    await after.switchWallet(forgotten.id);
    expect(await after.unlock('the wrong one', { migrate: false })).toBe(false);
    expect(await after.unlock(OTHER_PW, { migrate: false })).toBe(true);
    expect(after.getAddress(0)).toBe(await vectorAddress(OTHER_MNEMONIC));
    // ...and it is STILL v1, because that unlock declined the move.
    expect(isVaultRecordV2((await entryNamed('Forgotten')).vault)).toBe(false);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 6. A seed group migrates as one
// ---------------------------------------------------------------------------

describe('app password: seed groups', () => {
  it('migrates every account of one seed in a single write', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'My EVM', '', { family: 'evm' });
    await svc.addEvmAccount(); // Account 2
    await svc.addEvmAccount(); // Account 3
    let wallets = (await readStore()).wallets;
    expect(wallets).toHaveLength(3);
    const group = wallets[0].seedGroup;
    expect(group).toBeTruthy();
    expect(wallets.every((w) => w.seedGroup === group)).toBe(true);
    // They share one vault record: one seed, one ciphertext, one password.
    expect(wallets[1].vault).toEqual(wallets[0].vault);

    await svc.setAppPassword(APP_PW);
    // Open ACCOUNT 3 — the GROUP must move because of it, not just that entry.
    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    await session.switchWallet(wallets[2].id);
    const writesBefore = storage.writes.length;
    expect(await session.unlock(WALLET_PW)).toBe(true);

    wallets = (await readStore()).wallets;
    expect(wallets.every((w) => isVaultRecordV2(w.vault))).toBe(true);
    // ONE record, copied — as it was before, so the group stays one secret.
    expect(wallets[1].vault).toEqual(wallets[0].vault);
    expect(wallets[2].vault).toEqual(wallets[0].vault);
    // No half-migrated group was ever WRITTEN: every write in between had either
    // all three on v1 or all three on v2.
    const between = storage.writes.slice(writesBefore);
    expect(between.length).toBeGreaterThan(0);
    for (const w of between) {
      const parsed = JSON.parse(w.json) as StoredShape;
      const v2 = parsed.wallets.filter((x) => isVaultRecordV2(x.vault)).length;
      expect(v2 === 0 || v2 === parsed.wallets.length).toBe(true);
    }

    // Every account opens with the app password alone afterwards.
    for (const w of wallets) {
      const fresh = new LiveWalletService(offlineClient);
      await fresh.switchWallet(w.id);
      expect(await fresh.unlock(APP_PW)).toBe(true);
    }
  }, 240_000);

  it('refuses the whole group when a member is not the same secret', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'My EVM', '', { family: 'evm' });
    await svc.addEvmAccount();
    await svc.setAppPassword(APP_PW);

    // Forge the damage a bug (or a hand-edited profile) could do: a group member
    // whose vault is a DIFFERENT ciphertext. Handing it this plaintext's record
    // would silently replace its secret, so the migration must refuse outright
    // and leave every member exactly where it was.
    const store = await readStore();
    store.wallets[1].vault = await createVault('a completely different secret', WALLET_PW);
    await getStorage().set('liveWallets', store);
    const before = snap((await readStore()).wallets);

    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    await session.switchWallet(before[0].id);
    expect(await session.unlock(WALLET_PW)).toBe(true); // the unlock itself still works
    expect(snap((await readStore()).wallets)).toEqual(before);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 7. Changing the app password
// ---------------------------------------------------------------------------

describe('app password: changing it', () => {
  it('a LEGACY v1 record still re-wraps every v2 wallet, and is promoted to v2', async () => {
    // The path every existing install is on. Under v1 the master key IS
    // scrypt(password), so a new password means a NEW master key and every
    // wallet key must move to it — the work §13.3 removed for v2 records, and
    // the work these users still pay exactly once more.
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Migrated');
    const legacy = await makeLegacyV1AppKey(APP_PW);
    zeroKey(legacy.masterKey);
    const withRecord = await readStore();
    withRecord.appKey = legacy.record;
    await getStorage().set('liveWallets', withRecord);

    const session = new LiveWalletService(offlineClient);
    expect(await session.unlockApp(APP_PW)).toBe(true);
    await session.switchWallet((await entryNamed('Migrated')).id);
    await session.unlock(WALLET_PW); // migrates under the v1-derived master key

    const before = snap(await entryNamed('Migrated'));
    if (!isVaultRecordV2(before.vault)) throw new Error('expected v2');
    expect((await readStore()).appKey?.version).toBe(1);

    expect(await session.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });

    const after = await entryNamed('Migrated');
    if (!isVaultRecordV2(after.vault)) throw new Error('expected v2');
    // The seed ciphertext is copied across; only the 32-byte wrap moves.
    expect(after.vault.ciphertext).toBe(before.vault.ciphertext);
    expect(after.vault.iv).toBe(before.vault.iv);
    expect(after.vault.wrappedKey).not.toBe(before.vault.wrappedKey);
    // And the record itself is v2 afterwards, so this cost is not paid again.
    expect((await readStore()).appKey?.version).toBe(2);

    const reopened = new LiveWalletService(offlineClient);
    expect(await reopened.unlockApp(APP_PW)).toBe(false);
    expect(await reopened.unlockApp(NEW_APP_PW)).toBe(true);
    await reopened.switchWallet(before.id);
    expect(await reopened.unlock('')).toBe(true);
    expect(reopened.getAddress(0)).toBe(await vectorAddress());
  }, 240_000);

  it('re-wraps every v2 wallet, leaves v1 wallets alone, and both still open', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Migrated');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Still v1');
    await svc.setAppPassword(APP_PW);

    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    await session.switchWallet((await entryNamed('Migrated')).id);
    await session.unlock(WALLET_PW); // migrates

    const v2Before = snap(await entryNamed('Migrated'));
    const v1Before = snap(await entryNamed('Still v1'));
    if (!isVaultRecordV2(v2Before.vault)) throw new Error('expected v2');

    const writesBefore = storage.writes.length;
    expect(await session.changeAppPassword('wrong current', NEW_APP_PW)).toEqual({
      ok: false,
      reason: 'wrong-password',
    });
    // A mistyped CURRENT password changes nothing and must not lock the session.
    expect(session.appUnlocked()).toBe(true);
    expect(await session.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });
    // ONE write for the whole change: the record and every re-wrapped key.
    expect(storage.writes.length - writesBefore).toBe(1);
    // §5: the master key is dropped, so the wallet locks.
    expect(session.appUnlocked()).toBe(false);
    expect(session.isUnlocked()).toBe(false);

    const v2After = await entryNamed('Migrated');
    if (!isVaultRecordV2(v2After.vault)) throw new Error('expected v2');
    // NOTHING in the vault moved, not even the wrap. Under a v2 record
    // (§13.3) the master key is random and the password only wraps it, so a
    // password change rewrites 32 bytes INSIDE THE RECORD and never reads or
    // writes a vault at all. The strongest form of "a password change cannot
    // corrupt a seed" is that it does not touch the seed's record.
    expect(snap(v2After)).toEqual(v2Before);
    // The v1 wallet was not touched at all.
    expect(snap(await entryNamed('Still v1'))).toEqual(v1Before);

    // Both open afterwards: the migrated one under the NEW app password...
    const a = new LiveWalletService(offlineClient);
    expect(await a.unlockApp(APP_PW)).toBe(false);
    expect(await a.unlockApp(NEW_APP_PW)).toBe(true);
    await a.switchWallet(v2Before.id);
    expect(await a.unlock('')).toBe(true);
    expect(a.getAddress(0)).toBe(await vectorAddress());
    // ...and the untouched one under its own, which then migrates under the NEW key.
    await a.switchWallet(v1Before.id);
    expect(await a.unlock(OTHER_PW)).toBe(true);
    expect(a.getAddress(0)).toBe(await vectorAddress(OTHER_MNEMONIC));
    expect(isVaultRecordV2((await entryNamed('Still v1')).vault)).toBe(true);

    const b = new LiveWalletService(offlineClient);
    await b.unlockApp(NEW_APP_PW);
    await b.switchWallet(v1Before.id);
    expect(await b.unlock('')).toBe(true);
  }, 300_000);

  it('a failed write leaves the OLD password working and every wallet openable', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Migrated');
    await svc.setAppPassword(APP_PW);
    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    await session.unlock(WALLET_PW); // migrates
    const before = snap(await entryNamed('Migrated'));
    const recordBefore = snap((await readStore()).appKey);

    storage.failWhen = () => true;
    expect(await session.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({
      ok: false,
      reason: 'write-failed',
    });
    storage.failWhen = null;

    // Nothing moved: the record and the wrapped key are exactly as they were.
    expect(snap(await entryNamed('Migrated'))).toEqual(before);
    expect(snap((await readStore()).appKey)).toEqual(recordBefore);
    const after = new LiveWalletService(offlineClient);
    expect(await after.unlockApp(NEW_APP_PW)).toBe(false);
    expect(await after.unlockApp(APP_PW)).toBe(true);
    expect(await after.unlock('')).toBe(true);
    expect(after.getAddress(0)).toBe(await vectorAddress());
  }, 240_000);

  it('refuses an empty new app password, and refuses when none is set', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    expect(await svc.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({
      ok: false,
      reason: 'no-app-password',
    }); // none set
    await svc.setAppPassword(APP_PW);
    expect(await svc.changeAppPassword(APP_PW, '')).toEqual({ ok: false, reason: 'empty-password' });
    expect(await svc.verifyAppPassword(APP_PW)).toBe(true);
  }, 150_000);
});

// ---------------------------------------------------------------------------
// 8. Per-wallet password changes vs an app-key wallet
// ---------------------------------------------------------------------------

describe('app password: the per-wallet password of a migrated wallet', () => {
  it('changePassword refuses on a v2 wallet rather than writing a v1 record over it', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    await session.unlock(WALLET_PW);
    const migrated = snap(await entryNamed('Wallet A'));

    expect(await session.changePassword(APP_PW, 'something new')).toBe(false);
    expect(await session.changePassword(WALLET_PW, 'something new')).toBe(false);
    // Untouched, and still opening under the app password.
    expect(snap(await entryNamed('Wallet A'))).toEqual(migrated);
    const fresh = new LiveWalletService(offlineClient);
    expect(await fresh.unlock(APP_PW)).toBe(true);
  }, 210_000);
});

// ---------------------------------------------------------------------------
// 9. The master key never reaches storage
// ---------------------------------------------------------------------------

describe('app password: the master key is a memory-only secret', () => {
  it('nothing matching it (or the seed) is ever handed to the storage adapter', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    await session.unlock(WALLET_PW); // migrates
    await session.changeAppPassword(APP_PW, NEW_APP_PW); // re-wraps

    const record = (await readStore()).appKey;
    if (!record) throw new Error('expected an app record');
    const master = await deriveMasterKey(record, NEW_APP_PW);
    try {
      const b64 = bytesToBase64(master);
      const hex = Array.from(master).map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(storage.writes.length).toBeGreaterThan(0);
      for (const w of storage.writes) {
        expect(w.json).not.toContain(b64);
        expect(w.json).not.toContain(hex);
        // ...nor any password, nor the seed, in any write ever made.
        expect(w.json).not.toContain(APP_PW);
        expect(w.json).not.toContain(NEW_APP_PW);
        expect(w.json).not.toContain(WALLET_PW);
        expect(w.json).not.toContain(VECTOR_MNEMONIC);
        expect(w.json).not.toContain('abandon');
      }
      // Only ONE storage key is ever written: there is no side channel.
      expect([...new Set(storage.writes.map((w) => w.key))]).toEqual(['liveWallets']);
    } finally {
      zeroKey(master);
    }
  }, 240_000);

  it('lockApp zeroes it: after locking, an app-key wallet needs the password again', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Wallet A');
    await svc.setAppPassword(APP_PW);
    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    await session.unlock(WALLET_PW);
    expect(session.appUnlocked()).toBe(true);

    session.lockApp();
    expect(session.appUnlocked()).toBe(false);
    expect(session.isUnlocked()).toBe(false);
    expect(await session.unlock('')).toBe(false);
    expect(await session.unlock('wrong')).toBe(false);
    expect(await session.unlock(APP_PW)).toBe(true);
  }, 210_000);

  it('a WALLET SWITCH keeps the master key: choosing another migrated wallet asks nothing', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'One');
    await svc.import(OTHER_MNEMONIC, OTHER_PW, 'mainnet', 'Two');
    await svc.setAppPassword(APP_PW);
    const session = new LiveWalletService(offlineClient);
    await session.unlockApp(APP_PW);
    await session.switchWallet((await entryNamed('One')).id);
    await session.unlock(WALLET_PW);
    await session.switchWallet((await entryNamed('Two')).id);
    await session.unlock(OTHER_PW);
    // Both are v2 now. Switching between them locks the SEED but keeps the
    // master key, so re-opening needs no password at all.
    await session.switchWallet((await entryNamed('One')).id);
    expect(session.isUnlocked()).toBe(false);
    expect(session.appUnlocked()).toBe(true);
    expect(await session.unlock('')).toBe(true);
    expect(session.getAddress(0)).toBe(await vectorAddress());
  }, 300_000);
});
