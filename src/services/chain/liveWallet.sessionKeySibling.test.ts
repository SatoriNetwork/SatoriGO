// "Enable <chain>" with NO password on an open app-protected wallet
// (owner request 2026-10-04), at the service level.
//
// The owner's constraint: fully compatible with existing wallets, no user may
// lose access to any wallet, no vault format changes, and when in doubt fail
// closed and keep asking for the password. So most of this file is about what
// must NOT happen:
//   * a v1 wallet with its own password never qualifies, and nothing is written;
//   * a STALE master key (another page changed the app password) never seals a
//     vault, and no existing vault is touched;
//   * the write-time guard holds even if the pre-check were bypassed;
//   * after lockApp nothing qualifies;
//   * a legacy v1 app record is used as-is and never migrated.
// And about the one thing that must: every sibling made this way opens again
// with the APP password from a fresh page, at the address it was created with.
//
// Real scrypt throughout. Do NOT lower it to speed this up.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The EVM engine (EVM targets) and the Monero engine (Add Monero) through the
// same shims liveWallet.evm*.test.ts and liveWallet.monero.test.ts use.
vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>();
  return {
    ...actual,
    loadEvmModules: async () => await import('./evm'),
    loadMoneroModules: async () => {
      const real = await import('./monero');
      return { ...real, deleteMoneroCache: async () => {}, deleteAllMoneroCaches: async () => {} };
    },
  };
});

vi.mock('../gateway', () => ({
  GATEWAY_URL: 'https://gw.test',
  HAS_GATEWAY: true,
  GATEWAY_CLIENT_TOKEN: 'sgw_test',
  gatewayUrl: () => 'https://gw.test',
  gatewayHeaders: () => ({ 'X-Satori-Client': 'sgw_test' }),
}));

import { LiveWalletService, SESSION_KEY_UNAVAILABLE, type WalletEntry } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { zeroKey, type AppKeyRecord } from './appKey';
import { makeLegacyV1AppKey } from '../../test/legacyAppKey';
import { isVaultRecordV2, unlockVaultString, type VaultRecord } from './vault';
import { deriveAddress, mnemonicToSeed, privateKeyToDerived, parsePrivateKey } from './keys';
import { RAVENCOIN_MAINNET } from './chainParams';
import type { ElectrumClient } from './electrumTypes';

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_EVM_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
// Zcash /0/0 and the Bittensor root of the same phrase (liveWallet.engines.test.ts).
const ZEC_ADDRESS = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F';
const TAO_ADDRESS = '5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH';
// The Monero sibling of the phrase (liveWallet.monero.test.ts, cake-exodus row 1).
const XMR_ADDRESS =
  '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756';
// Private key 1: its EVM address is the well-known 0x7E5F...5Bdf.
const KEY_ONE_HEX = '0'.repeat(63) + '1';
const KEY_ONE_EVM = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const WALLET_PW = 'wallet-password-one';
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

/** A detached deep copy, so a "before" can never be mutated by the code under test. */
function snap<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readStore(): Promise<StoredShape> {
  return (await getStorage().get<StoredShape>('liveWallets')) ?? { wallets: [], activeId: '' };
}

async function ravencoinAddress(mnemonic = VECTOR_MNEMONIC, passphrase = ''): Promise<string> {
  const seed = await mnemonicToSeed(mnemonic, passphrase);
  return deriveAddress(seed, RAVENCOIN_MAINNET, 0, 0, 0).address;
}

/** A seed wallet with its own password, then an app password, then moved to v2
 *  by an unlock (the lazy migration), exactly the way a real user gets there.
 *  Ends with the wallet open and the session holding the master key. */
async function appProtectedSeedWallet(svc: LiveWalletService, passphrase = ''): Promise<string> {
  await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Main', passphrase);
  expect(await svc.setAppPassword(APP_PW)).toBe(true);
  svc.lock(); // a wallet lock keeps the master key
  expect(await svc.unlock(WALLET_PW)).toBe(true); // migrates under the app key
  const id = svc.activeWalletId()!;
  const entry = (await readStore()).wallets.find((w) => w.id === id)!;
  expect(isVaultRecordV2(entry.vault)).toBe(true);
  return id;
}

/** A FRESH page: unlock the app with `password`, open whatever is active. */
async function freshPageOpen(password: string): Promise<LiveWalletService> {
  const page = new LiveWalletService(offlineClient);
  expect(await page.unlockApp(password)).toBe(true);
  expect(await page.unlock('')).toBe(true);
  return page;
}

function stubMoneroGetInfo(height = 3_800_000) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
      if (body.method !== 'get_info') throw new Error(`unexpected rpc ${body.method}`);
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: '0', result: { height, status: 'OK', nettype: 'mainnet', version: '0.18.4.3' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('session-key sibling: an open app-protected wallet', () => {
  it('UTXO target: born v2 under the app key, active and unlocked, and opens again from a fresh page with the APP password', async () => {
    const svc = new LiveWalletService(offlineClient);
    const sourceId = await appProtectedSeedWallet(svc);
    expect(await svc.sessionKeyOpensActive(svc.activeWalletId())).toBe(true);

    const before = snap(await readStore());
    await svc.addSiblingWithSessionKey(svc.activeWalletId(), 'ravencoin-mainnet', 'Main (Ravencoin)');

    const after = await readStore();
    expect(after.wallets).toHaveLength(2);
    const sibling = after.wallets.find((w) => w.id !== sourceId)!;
    expect(isVaultRecordV2(sibling.vault)).toBe(true);
    expect(sibling.passwordless).toBe(false);
    expect(sibling.network).toBe('ravencoin-mainnet');
    expect(sibling.address).toBe(await ravencoinAddress());
    // A fresh secret record: not a copy of the source's ciphertext.
    expect(sibling.vault.ciphertext).not.toBe(after.wallets.find((w) => w.id === sourceId)!.vault.ciphertext);
    // The source and the app record are untouched, byte for byte.
    expect(after.wallets.find((w) => w.id === sourceId)).toEqual(before.wallets.find((w) => w.id === sourceId));
    expect(after.appKey).toEqual(before.appKey);
    // Landed on it, unlocked.
    expect(svc.activeWalletId()).toBe(sibling.id);
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getAddress(0)).toBe(await ravencoinAddress());
    expect((await svc.listWallets()).find((w) => w.id === sibling.id)!.appProtected).toBe(true);

    // ACCESS IS NOT LOST: lock the app, open from a fresh page with the app password.
    svc.lockApp();
    const page = await freshPageOpen(APP_PW);
    expect(page.activeWalletId()).toBe(sibling.id);
    expect(page.getAddress(0)).toBe(await ravencoinAddress());
    // A reveal still costs the app password, and works with it.
    expect(await page.revealMnemonic(APP_PW)).toBe(VECTOR_MNEMONIC);
    expect(await page.revealMnemonic('wrong')).toBeNull();
  }, 120_000);

  it('a BIP39 passphrase rides along (a sibling without it would be a different wallet)', async () => {
    const svc = new LiveWalletService(offlineClient);
    await appProtectedSeedWallet(svc, 'my 25th word');
    await svc.addSiblingWithSessionKey(svc.activeWalletId(), 'ravencoin-mainnet', 'P');
    const expected = await ravencoinAddress(VECTOR_MNEMONIC, 'my 25th word');
    expect(expected).not.toBe(await ravencoinAddress());
    expect(svc.getAddress(0)).toBe(expected);
    svc.lockApp();
    const page = await freshPageOpen(APP_PW);
    expect(page.getAddress(0)).toBe(expected);
  }, 120_000);

  it('EVM target: one account at m/44/60/0/0/0, born v2, opens again with the app password', async () => {
    const svc = new LiveWalletService(offlineClient);
    await appProtectedSeedWallet(svc);
    await svc.addSiblingWithSessionKey(svc.activeWalletId(), 'mainnet', 'Main (EVM)', { family: 'evm', evmChainKey: 'base' });
    const evm = (await readStore()).wallets.find((w) => w.family === 'evm')!;
    expect(isVaultRecordV2(evm.vault)).toBe(true);
    expect(evm.address).toBe(VECTOR_EVM_ADDRESS);
    expect(evm.evmChainKey).toBe('base');
    svc.lockApp();
    const page = await freshPageOpen(APP_PW);
    expect(page.activeWalletId()).toBe(evm.id);
    expect(page.getAddress(0)).toBe(VECTOR_EVM_ADDRESS);
  }, 120_000);

  it('private-key wallet: the SAME key, as WIF on a UTXO target and as hex on an EVM target, both v2 and reopenable', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.importPrivateKey(KEY_ONE_HEX, WALLET_PW, 'mainnet', 'Key');
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    svc.lock();
    expect(await svc.unlock(WALLET_PW)).toBe(true);
    const keyId = svc.activeWalletId()!;
    expect(isVaultRecordV2((await readStore()).wallets[0].vault)).toBe(true);

    await svc.addSiblingWithSessionKey(svc.activeWalletId(), 'ravencoin-mainnet', 'Key (Ravencoin)');
    const { privateKey } = parsePrivateKey(KEY_ONE_HEX);
    const rvn = privateKeyToDerived(privateKey, RAVENCOIN_MAINNET, true).address;
    expect(svc.getAddress(0)).toBe(rvn);

    await svc.switchWallet(keyId);
    expect(await svc.unlock('')).toBe(true);
    await svc.addSiblingWithSessionKey(svc.activeWalletId(), 'mainnet', 'Key (EVM)', { family: 'evm', evmChainKey: 'base' });
    expect(svc.getAddress(0)).toBe(KEY_ONE_EVM);

    const all = (await readStore()).wallets;
    expect(all).toHaveLength(3);
    for (const w of all) expect(isVaultRecordV2(w.vault)).toBe(true);

    svc.lockApp();
    const page = await freshPageOpen(APP_PW);
    expect(page.getAddress(0)).toBe(KEY_ONE_EVM);
    const rvnEntry = all.find((w) => w.network === 'ravencoin-mainnet')!;
    await page.switchWallet(rvnEntry.id);
    expect(await page.unlock('')).toBe(true);
    expect(page.getAddress(0)).toBe(rvn);
  }, 120_000);

  it('Zcash and Bittensor siblings (vault copies) of a v2 wallet are v2 and reopen with the app password', async () => {
    const svc = new LiveWalletService(offlineClient);
    const sourceId = await appProtectedSeedWallet(svc);
    const zec = await svc.addZcashAccount(sourceId, 'Main (Zcash)', { password: '' });
    expect(zec.appProtected).toBe(true);
    // From the Zcash sibling (no seed in memory) the vault opens with the
    // session's key: the '' password is never what opens it.
    const tao = await svc.addSubstrateAccount(zec.id, '', 'Main (Bittensor)');
    expect(tao.appProtected).toBe(true);
    for (const w of (await readStore()).wallets) expect(isVaultRecordV2(w.vault)).toBe(true);

    svc.lockApp();
    const page = await freshPageOpen(APP_PW);
    expect(page.getAddress(0)).toBe(TAO_ADDRESS);
    await page.switchWallet(zec.id);
    expect(await page.unlock('')).toBe(true);
    expect(page.getAddress(0)).toBe(ZEC_ADDRESS);
  }, 120_000);

  it('Monero sibling (vault copy) of a v2 wallet is v2 and reopens with the app password', async () => {
    stubMoneroGetInfo();
    const svc = new LiveWalletService(offlineClient);
    const sourceId = await appProtectedSeedWallet(svc);
    expect(await svc.sessionKeyOpensActive(svc.activeWalletId())).toBe(true);
    const xmr = await svc.addMoneroAccount(sourceId, 'Main (Monero)', { usedBefore: false });
    expect(xmr.appProtected).toBe(true);
    expect(xmr.address).toBe(XMR_ADDRESS);
    svc.lockApp();
    const page = await freshPageOpen(APP_PW);
    expect(page.activeWalletId()).toBe(xmr.id);
    expect(page.getAddress(0)).toBe(XMR_ADDRESS);
  }, 120_000);
});

describe('session-key sibling: every other case is refused and writes NOTHING', () => {
  it('a v1 wallet with its OWN password does not qualify, even with the app unlocked', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Main');
    expect(await svc.setAppPassword(APP_PW)).toBe(true); // master key held, wallet still v1
    expect(svc.appUnlocked()).toBe(true);
    expect(await svc.sessionKeyOpensActive(svc.activeWalletId())).toBe(false);
    const before = snap(await readStore());
    await expect(svc.addSiblingWithSessionKey(svc.activeWalletId(), 'ravencoin-mainnet', 'X')).rejects.toThrow(SESSION_KEY_UNAVAILABLE);
    expect(await readStore()).toEqual(before);
  }, 120_000);

  it('a passwordless wallet does not qualify (it keeps its own no-password path)', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, '', 'mainnet', 'Open');
    expect(await svc.sessionKeyOpensActive(svc.activeWalletId())).toBe(false);
    const before = snap(await readStore());
    await expect(svc.addSiblingWithSessionKey(svc.activeWalletId(), 'ravencoin-mainnet', 'X')).rejects.toThrow(SESSION_KEY_UNAVAILABLE);
    expect(await readStore()).toEqual(before);
  }, 60_000);

  it('after lockApp nothing qualifies', async () => {
    const svc = new LiveWalletService(offlineClient);
    await appProtectedSeedWallet(svc);
    svc.lockApp();
    expect(await svc.sessionKeyOpensActive(svc.activeWalletId())).toBe(false);
    const before = snap(await readStore());
    await expect(svc.addSiblingWithSessionKey(svc.activeWalletId(), 'ravencoin-mainnet', 'X')).rejects.toThrow(SESSION_KEY_UNAVAILABLE);
    expect(await readStore()).toEqual(before);
  }, 120_000);

  it('a STALE key (another page changed the app password) is refused, dropped, and no vault is touched', async () => {
    const svc = new LiveWalletService(offlineClient);
    await appProtectedSeedWallet(svc);
    const other = new LiveWalletService(offlineClient);
    expect(await other.unlockApp(APP_PW)).toBe(true);
    expect(await other.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });

    const before = snap(await readStore());
    expect(await svc.sessionKeyOpensActive(svc.activeWalletId())).toBe(false);
    // The stale key was dropped, not kept.
    expect(svc.appUnlocked()).toBe(false);
    await expect(svc.addSiblingWithSessionKey(svc.activeWalletId(), 'ravencoin-mainnet', 'X')).rejects.toThrow(SESSION_KEY_UNAVAILABLE);
    expect(await readStore()).toEqual(before);

    // The wallet still opens with the NEW app password from a fresh page.
    const page = await freshPageOpen(NEW_APP_PW);
    expect(page.getAddress(0)).toBe(before.wallets[0].address);
  }, 120_000);

  it('THE WRITE-TIME GUARD: with the pre-check bypassed, a key gone stale is still refused inside the write', async () => {
    const svc = new LiveWalletService(offlineClient);
    await appProtectedSeedWallet(svc);
    const other = new LiveWalletService(offlineClient);
    expect(await other.unlockApp(APP_PW)).toBe(true);
    expect(await other.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });

    // Pretend the pre-check passed: hand back the (stale) cached key unproven.
    // On a v2 record the change re-wrapped the master key, so it still OPENS
    // the source vault: only the binding to the current record is wrong.
    const internals = svc as unknown as { masterKey: Uint8Array | null; sessionKeyForActive: unknown };
    vi.spyOn(internals as { sessionKeyForActive: () => Promise<Uint8Array | null> }, 'sessionKeyForActive').mockImplementation(
      async () => internals.masterKey,
    );
    const before = snap(await readStore());
    await expect(svc.addSiblingWithSessionKey(svc.activeWalletId(), 'ravencoin-mainnet', 'X')).rejects.toThrow(SESSION_KEY_UNAVAILABLE);
    expect(await readStore()).toEqual(before);
    expect(svc.appUnlocked()).toBe(false);
  }, 120_000);
});

describe('session-key sibling: a LEGACY v1 app record (the shipped 1.4.0 shape)', () => {
  it('is used as it is, never migrated, and the sibling opens with the app password', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Main');
    const legacy = await makeLegacyV1AppKey(APP_PW);
    zeroKey(legacy.masterKey);
    const withRecord = await readStore();
    withRecord.appKey = legacy.record;
    await getStorage().set('liveWallets', withRecord);

    const page = new LiveWalletService(offlineClient);
    expect(await page.unlockApp(APP_PW)).toBe(true);
    expect(await page.unlock(WALLET_PW)).toBe(true); // migrates under the v1-derived key
    expect(await page.sessionKeyOpensActive(page.activeWalletId())).toBe(true);
    await page.addSiblingWithSessionKey(page.activeWalletId(), 'ravencoin-mainnet', 'Main (Ravencoin)');

    const after = await readStore();
    expect(after.appKey).toEqual(legacy.record); // NOT migrated, byte for byte
    expect(after.wallets).toHaveLength(2);
    for (const w of after.wallets) expect(isVaultRecordV2(w.vault)).toBe(true);

    page.lockApp();
    const reopened = await freshPageOpen(APP_PW);
    expect(reopened.getAddress(0)).toBe(await ravencoinAddress());
    expect((await readStore()).appKey?.version).toBe(1);
  }, 120_000);
});

/** Make the FIRST crypto.subtle.encrypt after this call run `onFirst` (a lock)
 *  before it encrypts: the moment a record is being built. */
function lockOnFirstEncrypt(onFirst: () => void): { fired: () => boolean } {
  const subtle = crypto.subtle;
  const realEncrypt = subtle.encrypt.bind(subtle);
  let fired = false;
  vi.spyOn(subtle, 'encrypt').mockImplementation((async (...args: Parameters<SubtleCrypto['encrypt']>) => {
    if (!fired) {
      fired = true;
      onFirst();
    }
    return realEncrypt(...args);
  }) as SubtleCrypto['encrypt']);
  return { fired: () => fired };
}

describe('H1: a lock that lands WHILE a record is being sealed', () => {
  it('new entry: lockApp() mid-seal writes nothing (the key was zeroed in place under the old code)', async () => {
    const svc = new LiveWalletService(offlineClient);
    await appProtectedSeedWallet(svc);
    const before = snap(await readStore());
    const hook = lockOnFirstEncrypt(() => svc.lockApp());
    await expect(svc.addSiblingWithSessionKey(svc.activeWalletId(), 'ravencoin-mainnet', 'X')).rejects.toThrow(
      SESSION_KEY_UNAVAILABLE,
    );
    expect(hook.fired()).toBe(true);
    expect(await readStore()).toEqual(before);
    vi.restoreAllMocks();
    // The source still opens with the app password.
    const page = await freshPageOpen(APP_PW);
    expect(page.getAddress(0)).toBe(before.wallets[0].address);
  }, 120_000);

  it('lazy migration: lockApp() mid-seal leaves the v1 record in place, still opening with its own password', async () => {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Main');
    expect(await svc.setAppPassword(APP_PW)).toBe(true);
    svc.lock();
    const before = snap(await readStore());
    expect(isVaultRecordV2(before.wallets[0].vault)).toBe(false);
    const hook = lockOnFirstEncrypt(() => svc.lockApp());
    expect(await svc.unlock(WALLET_PW)).toBe(true); // the unlock succeeded; the migration must not
    expect(hook.fired()).toBe(true);
    vi.restoreAllMocks();
    const after = await readStore();
    expect(after.wallets[0].vault).toEqual(before.wallets[0].vault);
    expect(isVaultRecordV2(after.wallets[0].vault)).toBe(false);
    expect(await unlockVaultString(after.wallets[0].vault as VaultRecord, WALLET_PW)).toBe(VECTOR_MNEMONIC);
  }, 120_000);
});

describe('M2: bound to the wallet the caller means', () => {
  it('refuses when the expected id is not the service session wallet, and writes nothing', async () => {
    const svc = new LiveWalletService(offlineClient);
    await appProtectedSeedWallet(svc);
    expect(await svc.sessionKeyOpensActive('some-other-wallet')).toBe(false);
    expect(await svc.sessionKeyOpensActive(null)).toBe(false);
    const before = snap(await readStore());
    await expect(svc.prepareSiblingWithSessionKey('some-other-wallet')).rejects.toThrow(SESSION_KEY_UNAVAILABLE);
    await expect(svc.addSiblingWithSessionKey(null, 'ravencoin-mainnet', 'X')).rejects.toThrow(SESSION_KEY_UNAVAILABLE);
    expect(await readStore()).toEqual(before);
    // The right id still works.
    expect(await svc.sessionKeyOpensActive(svc.activeWalletId())).toBe(true);
  }, 120_000);
});

describe('L5: a sibling made without a password survives the app-key record changing', () => {
  async function legacyWithSibling(): Promise<{ page: LiveWalletService; legacyRecord: AppKeyRecord; siblingId: string; sourceId: string }> {
    const svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, WALLET_PW, 'mainnet', 'Main');
    const legacy = await makeLegacyV1AppKey(APP_PW);
    zeroKey(legacy.masterKey);
    const withRecord = await readStore();
    withRecord.appKey = legacy.record;
    await getStorage().set('liveWallets', withRecord);
    const page = new LiveWalletService(offlineClient);
    expect(await page.unlockApp(APP_PW)).toBe(true);
    expect(await page.unlock(WALLET_PW)).toBe(true); // migrates under the v1-derived key
    const sourceId = page.activeWalletId()!;
    await page.addSiblingWithSessionKey(page.activeWalletId(), 'ravencoin-mainnet', 'Main (Ravencoin)');
    return { page, legacyRecord: legacy.record, siblingId: page.activeWalletId()!, sourceId };
  }

  it('app-password change on a LEGACY v1 record (the re-wrap path): both wallets reopen with the NEW password', async () => {
    const { page, siblingId, sourceId } = await legacyWithSibling();
    expect(await page.changeAppPassword(APP_PW, NEW_APP_PW)).toEqual({ ok: true });
    expect((await readStore()).appKey?.version).toBe(2);
    page.lockApp();

    const reopened = await freshPageOpen(NEW_APP_PW);
    expect(reopened.activeWalletId()).toBe(siblingId);
    expect(reopened.getAddress(0)).toBe(await ravencoinAddress());
    await reopened.switchWallet(sourceId);
    expect(await reopened.unlock('')).toBe(true);
    expect(await reopened.revealMnemonic(NEW_APP_PW)).toBe(VECTOR_MNEMONIC);
    // The old password is out of reach.
    expect(await new LiveWalletService(offlineClient).unlockApp(APP_PW)).toBe(false);
  }, 180_000);

  it('createRecoveryCode (v1 -> v2 upgrade, master key ROTATED): reopens with the password AND with the recovery code', async () => {
    const { page, siblingId } = await legacyWithSibling();
    const created = await page.createRecoveryCode(APP_PW);
    if (!created.ok) throw new Error(`createRecoveryCode failed: ${created.reason}`);
    expect((await readStore()).appKey?.version).toBe(2);
    page.lockApp();

    const byPassword = await freshPageOpen(APP_PW);
    expect(byPassword.activeWalletId()).toBe(siblingId);
    expect(byPassword.getAddress(0)).toBe(await ravencoinAddress());
    byPassword.lockApp();

    const byCode = new LiveWalletService(offlineClient);
    expect(await byCode.unlockWithRecoveryCode(created.code, NEW_APP_PW)).toEqual({ ok: true });
    expect(await byCode.unlock('')).toBe(true);
    expect(byCode.activeWalletId()).toBe(siblingId);
    expect(byCode.getAddress(0)).toBe(await ravencoinAddress());
    expect(await byCode.revealMnemonic(NEW_APP_PW)).toBe(VECTOR_MNEMONIC);
  }, 180_000);
});
