// The Monero side of LiveWalletService (the Monero engine design notes §8, §9,
// §12.1 "liveWallet.monero.test.ts"): "Add Monero" copies the vault and shares
// the seed group, an import stores the words, unlock derives the §2.3 row-1
// address from the `abandon` phrase, revealSecret answers the 25 words and the
// height (never the phrase), changePassword re-encrypts both entries,
// removeWallet deletes the cache, and a monero entry survives the backup file.
//
// The engine is loaded through a mocked loadMoneroModules() so this runs with
// the build flag OFF (the default): the barrel is real, only the flag gate is
// bypassed, exactly as store/moneroChains.test.ts does. The gateway is a
// mocked module plus a stubbed fetch answering get_info, so no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deleteMoneroCache = vi.fn(async () => {});
const deleteAllMoneroCaches = vi.fn(async () => {});

vi.mock('./engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine')>();
  return {
    ...actual,
    loadMoneroModules: async () => {
      const real = await import('./monero');
      return { ...real, deleteMoneroCache, deleteAllMoneroCaches };
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

import { LiveWalletService, MONERO_NETWORK, isLegacyMoneroSecret } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { unlockVaultString } from './vault';
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

// docs/design/monero-engine.md §2.3, cake-exodus row 1 (keys.test.ts pins the
// derivation itself; here they prove the SERVICE reaches the same wallet).
const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ADDRESS = '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756';
const VECTOR_WORDS =
  'subtly emerge cucumber wield jester neutral echo guide problems hiding necklace tapestry offend tell erase ugly envy turnip click iguana pebbles idols listen nail cucumber';
const MONERO_RELEASE_HEIGHT = 3772358;
const TIP = 3_800_000;
const PW = 'password-one';

interface StoredWallet {
  id: string;
  name: string;
  network: string;
  family?: string;
  kind?: string;
  vault: { iv: string; ciphertext: string; salt?: string };
  seedGroup?: string;
  restoreHeight?: number;
  moneroNodeSet?: string;
  moneroKeySource?: string;
  passwordless?: boolean;
}

async function rawWallets(): Promise<StoredWallet[]> {
  const store = await getStorage().get<{ wallets: StoredWallet[] }>('liveWallets');
  return store?.wallets ?? [];
}

function stubGetInfo(height = TIP) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
      if (body.method !== 'get_info') throw new Error(`unexpected rpc ${body.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: '0', result: { height, status: 'OK', nettype: 'mainnet', version: '0.18.4.3' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('LiveWalletService: Monero', () => {
  let svc: LiveWalletService;

  beforeEach(async () => {
    setStorageForTests(new MemoryStorageAdapter());
    deleteMoneroCache.mockClear();
    deleteAllMoneroCaches.mockClear();
    stubGetInfo();
    svc = new LiveWalletService(offlineClient);
    await svc.import(VECTOR_MNEMONIC, PW, 'mainnet', 'Wallet 1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isLegacyMoneroSecret tells 25 Monero words from a BIP39 phrase by length alone', () => {
    expect(isLegacyMoneroSecret(VECTOR_WORDS)).toBe(true);
    expect(isLegacyMoneroSecret(VECTOR_MNEMONIC)).toBe(false);
    expect(isLegacyMoneroSecret(`  ${VECTOR_WORDS}\n`)).toBe(true);
  });

  it('addMoneroAccount: a vault-copy sibling, shared seed group, tip-20 height for a phrase new to Monero, active and unlocked', async () => {
    const sourceId = svc.activeWalletId()!;
    const summary = await svc.addMoneroAccount(sourceId, undefined, { usedBefore: false });
    expect(summary.family).toBe('monero');
    expect(summary.network).toBe(MONERO_NETWORK);
    expect(summary.address).toBe(VECTOR_ADDRESS);
    expect(summary.restoreHeight).toBe(TIP - 20);
    expect(summary.moneroNodeSet).toBe('main');
    expect(summary.active).toBe(true);
    expect(summary.name).toBe('Wallet 1 (Monero)');
    expect(summary.kind).toBe('seed');

    // The service landed on it, unlocked: one primary address, no UTXO key.
    expect(svc.activeWalletId()).toBe(summary.id);
    expect(svc.activeWalletFamily()).toBe('monero');
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getAddress(0)).toBe(VECTOR_ADDRESS);
    expect(await svc.listAddresses()).toEqual([{ index: 0, address: VECTOR_ADDRESS }]);
    expect(() => svc.deriveKey(0)).toThrow(/Monero/);

    // Byte for byte the source's vault: no new secret was written (§9).
    const stored = await rawWallets();
    const source = stored.find((w) => w.id === sourceId)!;
    const sibling = stored.find((w) => w.id === summary.id)!;
    expect(sibling.vault).toEqual(source.vault);
    expect(sibling.family).toBe('monero');
    expect(sibling.network).toBe(MONERO_NETWORK);
    expect(sibling.restoreHeight).toBe(TIP - 20);
    // The group is shared and was backfilled onto the UTXO source.
    expect(sibling.seedGroup).toBeTruthy();
    expect(source.seedGroup).toBe(sibling.seedGroup);
    expect(source.seedGroup).toBe(source.vault && (await svc.listWallets()).find((w) => w.id === sourceId)!.address.toLowerCase());

    // The public summary carries the Monero fields and nothing secret.
    const listed = (await svc.listWallets()).find((w) => w.id === summary.id)!;
    expect(Object.keys(listed).sort()).toEqual(
      ['active', 'address', 'createdAt', 'family', 'id', 'kind', 'name', 'network', 'passwordless', 'seedGroup', 'restoreHeight', 'moneroNodeSet', 'moneroKeySource'].sort(),
    );
    expect(listed).not.toHaveProperty('vault');
    // A sibling is derived from the phrase, and says so.
    expect(listed.moneroKeySource).toBe('phrase');
    expect(sibling.moneroKeySource).toBe('phrase');
    // A UTXO summary did not sprout the Monero keys.
    const listedSource = (await svc.listWallets()).find((w) => w.id === sourceId)!;
    expect(listedSource).not.toHaveProperty('restoreHeight');
    expect(listedSource).not.toHaveProperty('moneroNodeSet');
  });

  it('addMoneroAccount: the restore height never goes below the release floor', async () => {
    stubGetInfo(MONERO_RELEASE_HEIGHT + 5);
    const summary = await svc.addMoneroAccount(svc.activeWalletId()!, undefined, { usedBefore: false });
    expect(summary.restoreHeight).toBe(MONERO_RELEASE_HEIGHT);
  });

  it('addMoneroAccount: an imported phrase starts at the release floor by default, a generated one at tip-20, and usedBefore overrides both', async () => {
    // The wallet from beforeEach was IMPORTED (svc.import): the same words may
    // already hold Monero from another device or from Cake, so the sibling
    // must scan from the floor unless the user says otherwise (§6.6).
    const importedId = svc.activeWalletId()!;
    expect((await svc.listWallets()).find((w) => w.id === importedId)!.origin).toBe('imported');
    const fromImport = await svc.addMoneroAccount(importedId);
    expect(fromImport.restoreHeight).toBe(MONERO_RELEASE_HEIGHT);
    await svc.removeWallet(fromImport.id);

    // A phrase GENERATED here has no history anywhere: today's tip is safe.
    await svc.create(PW, { name: 'Fresh' });
    const generatedId = svc.activeWalletId()!;
    expect((await svc.listWallets()).find((w) => w.id === generatedId)!.origin).toBe('generated');
    const fromCreate = await svc.addMoneroAccount(generatedId);
    expect(fromCreate.restoreHeight).toBe(TIP - 20);
    await svc.removeWallet(fromCreate.id);

    // The user's answer wins over the origin, both ways.
    await svc.switchWallet(generatedId);
    await svc.unlock(PW);
    const forced = await svc.addMoneroAccount(generatedId, undefined, { usedBefore: true });
    expect(forced.restoreHeight).toBe(MONERO_RELEASE_HEIGHT);
    await svc.removeWallet(forced.id);
    await svc.switchWallet(importedId);
    await svc.unlock(PW);
    const fast = await svc.addMoneroAccount(importedId, undefined, { usedBefore: false });
    expect(fast.restoreHeight).toBe(TIP - 20);
  });

  it('addMoneroAccount: a restore height from the user date wins, is clamped to the tip, and a bad one is refused', async () => {
    const id = svc.activeWalletId()!;
    const dated = await svc.addMoneroAccount(id, undefined, { usedBefore: true, restoreHeight: 3_000_000 });
    expect(dated.restoreHeight).toBe(3_000_000);
    await svc.removeWallet(dated.id);
    await svc.switchWallet(id);
    await svc.unlock(PW);
    const future = await svc.addMoneroAccount(id, undefined, { restoreHeight: TIP + 1_000 });
    expect(future.restoreHeight).toBe(TIP);
    await svc.removeWallet(future.id);
    await svc.switchWallet(id);
    await svc.unlock(PW);
    await expect(svc.addMoneroAccount(id, undefined, { restoreHeight: -1 })).rejects.toThrow('bad-restore-height');
    await expect(svc.addMoneroAccount(id, undefined, { restoreHeight: 1.5 })).rejects.toThrow('bad-restore-height');
  });

  it('an entry stored before the origin field is read as imported (floor), never as generated', async () => {
    const sourceId = svc.activeWalletId()!;
    const store = await getStorage().get<{ wallets: StoredWallet[] }>('liveWallets');
    for (const w of store!.wallets) delete (w as { origin?: string }).origin;
    await getStorage().set('liveWallets', store);
    expect((await svc.listWallets()).find((w) => w.id === sourceId)!).not.toHaveProperty('origin');
    const summary = await svc.addMoneroAccount(sourceId);
    expect(summary.restoreHeight).toBe(MONERO_RELEASE_HEIGHT);
  });

  it('reset() drops the whole Monero cache database along with the wallet records', async () => {
    await svc.addMoneroAccount(svc.activeWalletId()!);
    await svc.reset();
    expect(deleteAllMoneroCaches).toHaveBeenCalledTimes(1);
    expect(await svc.listWallets()).toEqual([]);
  });

  it('applyRestore(replace) deletes the caches of the Monero wallets the file does not carry', async () => {
    const sourceId = svc.activeWalletId()!;
    // A backup taken BEFORE Monero was added: restoring it replaces the store
    // with one that has no Monero entry, so the sibling's cache must go.
    const { text } = await svc.exportBackup('file-password-1');
    const { id } = await svc.addMoneroAccount(sourceId);
    deleteMoneroCache.mockClear();
    expect(await svc.readBackupFile(text, 'file-password-1')).toBeTruthy();
    const result = await svc.applyRestore('replace');
    expect(result.ok).toBe(true);
    expect(deleteMoneroCache).toHaveBeenCalledWith(id);
    expect((await svc.listWallets()).map((w) => w.id)).toEqual([sourceId]);
  });

  it('addMoneroAccount refuses a locked source, a second add, and writes nothing when the node is unreachable', async () => {
    const sourceId = svc.activeWalletId()!;
    // Unreachable gateway: nothing created.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(svc.addMoneroAccount(sourceId)).rejects.toThrow();
    expect((await rawWallets()).length).toBe(1);
    stubGetInfo();
    await svc.addMoneroAccount(sourceId);
    // Back on the source, add again: the address already exists.
    await svc.switchWallet(sourceId);
    await svc.unlock(PW);
    await expect(svc.addMoneroAccount(sourceId)).rejects.toThrow('already-added');
    // Locked source.
    svc.lock();
    await expect(svc.addMoneroAccount(sourceId)).rejects.toThrow('locked');
    // A Monero wallet is not a source for another one.
    const monero = (await svc.listWallets()).find((w) => w.family === 'monero')!;
    await svc.switchWallet(monero.id);
    await svc.unlock(PW);
    await expect(svc.addMoneroAccount(monero.id)).rejects.toThrow('not-a-seed-wallet');
  });

  it('unlock of the sibling derives the vector address; reveal answers the 25 words and height, never the phrase or a WIF', async () => {
    const sourceId = svc.activeWalletId()!;
    const { id } = await svc.addMoneroAccount(sourceId);
    // Switching locks; the sibling opens with the SAME password (vault copy).
    await svc.switchWallet(sourceId);
    expect(svc.isUnlocked()).toBe(false);
    await svc.switchWallet(id);
    expect(await svc.unlock('wrong')).toBe(false);
    expect(await svc.unlock(PW)).toBe(true);
    expect(svc.activeWalletFamily()).toBe('monero');
    expect(svc.getAddress(0)).toBe(VECTOR_ADDRESS);

    const keys = svc.moneroKeysOfActive();
    expect(keys.spendSec.length).toBe(32);
    // A copy: zeroing it does not touch the session's keys.
    keys.spendSec.fill(0);
    expect(svc.getAddress(0)).toBe(VECTOR_ADDRESS);

    const secret = await svc.revealSecret(PW);
    expect(secret).toEqual({ kind: 'monero-legacy-seed', words: VECTOR_WORDS.split(' '), restoreHeight: MONERO_RELEASE_HEIGHT });
    expect(await svc.revealSecret('wrong')).toBe(null);
    expect(await svc.revealMnemonic(PW)).toBe(null);
    expect(await svc.revealPrivateKeyWif(PW)).toBe(null);
    // The phrase is still reachable on the entry it belongs to.
    await svc.switchWallet(sourceId);
    await svc.unlock(PW);
    expect(await svc.revealMnemonic(PW)).toBe(VECTOR_MNEMONIC);
    expect(await svc.revealSecret(PW)).toEqual({ kind: 'mnemonic', mnemonic: VECTOR_MNEMONIC });
  });

  it('lock zeroes the Monero keys and the address is unreachable until the next unlock', async () => {
    const { id } = await svc.addMoneroAccount(svc.activeWalletId()!);
    const keys = svc.moneroKeysOfActive();
    svc.lock();
    expect(svc.isUnlocked()).toBe(false);
    expect(() => svc.getAddress(0)).toThrow(/locked/);
    expect(() => svc.moneroKeysOfActive()).toThrow(/locked/);
    keys.spendSec.fill(0);
    await svc.switchWallet(id);
    expect(await svc.unlock(PW)).toBe(true);
    expect(svc.getAddress(0)).toBe(VECTOR_ADDRESS);
  });

  it('importMoneroWallet stores the normalized 25 words under the given password and opens the same wallet', async () => {
    // Prefix-typed words (Monero accepts 3-letter prefixes) are stored whole.
    const typed = VECTOR_WORDS.split(' ')
      .map((w) => (w.length > 4 ? w.slice(0, 4) : w))
      .join(' ');
    const summary = await svc.importMoneroWallet(typed, 3_790_000, undefined, 'import-pw-1');
    expect(summary.family).toBe('monero');
    expect(summary.address).toBe(VECTOR_ADDRESS);
    expect(summary.restoreHeight).toBe(3_790_000);
    expect(summary.name).toBe('Monero wallet');
    expect(summary.seedGroup).toBeUndefined();
    // Imported from its words: no phrase, no derivation, no seed group, and
    // the summary says so (the UI's "25 words" tag and Diagnostics read it).
    expect(summary.moneroKeySource).toBe('words');
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getAddress(0)).toBe(VECTOR_ADDRESS);

    const stored = (await rawWallets()).find((w) => w.id === summary.id)!;
    expect(stored.moneroKeySource).toBe('words');
    expect(await unlockVaultString(stored.vault as never, 'import-pw-1')).toBe(VECTOR_WORDS);

    // Reveal answers the words as stored, with the height; a seed reveal
    // (enableChain's path) sees nothing to derive a sibling from.
    expect(await svc.revealSecret('import-pw-1')).toEqual({ kind: 'monero-legacy-seed', words: VECTOR_WORDS.split(' '), restoreHeight: 3_790_000 });
    expect(await svc.revealSeedSecret('import-pw-1')).toBe(null);

    // Duplicate address: refused. Bad words: refused before anything is written.
    await expect(svc.importMoneroWallet(VECTOR_WORDS, 1, undefined, 'x-pw-1234')).rejects.toThrow('already-added');
    await expect(svc.importMoneroWallet('not twenty five words', 1, undefined, 'x-pw-1234')).rejects.toThrow();
    expect((await rawWallets()).length).toBe(2);
  });

  it('a Monero entry stored before moneroKeySource is read from its seed group: sibling = phrase, import = words', async () => {
    const sourceId = svc.activeWalletId()!;
    const sibling = await svc.addMoneroAccount(sourceId, undefined, { usedBefore: false });
    // Strip the field off the stored records, as an entry written by an
    // earlier build would be.
    const raw = await getStorage().get<{ wallets: Record<string, unknown>[] }>('liveWallets');
    const legacy = {
      ...raw!,
      wallets: raw!.wallets.map((w) => {
        const copy = { ...w };
        delete copy.moneroKeySource;
        return copy;
      }),
    };
    // A second Monero entry with no group, as an import leaves it.
    legacy.wallets.push({
      ...legacy.wallets.find((w) => w.id === sibling.id)!,
      id: 'xmr-import-legacy',
      name: 'Old import',
      address: '4' + 'b'.repeat(94),
      seedGroup: undefined,
    });
    await getStorage().set('liveWallets', legacy);
    const listed = await new LiveWalletService(offlineClient).listWallets();
    expect(listed.find((w) => w.id === sibling.id)?.moneroKeySource).toBe('phrase');
    expect(listed.find((w) => w.id === 'xmr-import-legacy')?.moneroKeySource).toBe('words');
    // A UTXO summary did not sprout the field.
    expect(listed.find((w) => w.id === sourceId)).not.toHaveProperty('moneroKeySource');
  });

  it('importMoneroWallet refuses without a password when the session holds no app master key', async () => {
    await expect(svc.importMoneroWallet(VECTOR_WORDS, 1)).rejects.toThrow(/password/i);
    expect((await rawWallets()).length).toBe(1);
  });

  it('setMoneroRestoreHeight persists the height and drops the cache of a wallet that is not open', async () => {
    const { id } = await svc.addMoneroAccount(svc.activeWalletId()!);
    await svc.setMoneroRestoreHeight(id, 3_780_000);
    expect((await svc.listWallets()).find((w) => w.id === id)!.restoreHeight).toBe(3_780_000);
    expect(deleteMoneroCache).toHaveBeenCalledWith(id);
    expect(await svc.revealSecret(PW)).toMatchObject({ restoreHeight: 3_780_000 });
    await expect(svc.setMoneroRestoreHeight(id, -1)).rejects.toThrow();
    await expect(svc.setMoneroRestoreHeight('nope', 1)).rejects.toThrow('not-a-monero-wallet');
  });

  it('setMoneroRestoreHeight refuses a height above the daemon tip it is given, and rescans on the SAME height', async () => {
    const { id } = await svc.addMoneroAccount(svc.activeWalletId()!);
    await expect(svc.setMoneroRestoreHeight(id, TIP + 1, { daemonHeight: TIP })).rejects.toThrow(/at block 3,800,000/);
    expect(deleteMoneroCache).not.toHaveBeenCalled();
    await svc.setMoneroRestoreHeight(id, 3_780_000, { daemonHeight: TIP });
    expect(deleteMoneroCache).toHaveBeenCalledTimes(1);
    // The audit case: pressing Rescan again with the height already saved
    // used to do nothing (NO_WRITE short-circuit); it must rescan again.
    await svc.setMoneroRestoreHeight(id, 3_780_000, { daemonHeight: TIP });
    expect(deleteMoneroCache).toHaveBeenCalledTimes(2);
    expect((await svc.listWallets()).find((w) => w.id === id)!.restoreHeight).toBe(3_780_000);
  });

  it('changePassword re-encrypts the source and its Monero sibling together (one ciphertext)', async () => {
    const sourceId = svc.activeWalletId()!;
    const { id } = await svc.addMoneroAccount(sourceId);
    await svc.switchWallet(sourceId);
    await svc.unlock(PW);
    expect(await svc.changePassword(PW, 'password-two')).toBe(true);
    const stored = await rawWallets();
    const source = stored.find((w) => w.id === sourceId)!;
    const sibling = stored.find((w) => w.id === id)!;
    expect(sibling.vault).toEqual(source.vault);
    await svc.switchWallet(id);
    expect(await svc.unlock(PW)).toBe(false);
    expect(await svc.unlock('password-two')).toBe(true);
    expect(svc.getAddress(0)).toBe(VECTOR_ADDRESS);
  });

  it('removeWallet deletes the Monero scan cache and leaves the source intact', async () => {
    const sourceId = svc.activeWalletId()!;
    const { id } = await svc.addMoneroAccount(sourceId);
    await svc.removeWallet(id);
    expect(deleteMoneroCache).toHaveBeenCalledWith(id);
    expect((await svc.listWallets()).map((w) => w.id)).toEqual([sourceId]);
    expect(svc.isUnlocked()).toBe(false);
    // A UTXO removal never touches the Monero cache.
    deleteMoneroCache.mockClear();
    await svc.removeWallet(sourceId);
    expect(deleteMoneroCache).not.toHaveBeenCalled();
  });

  it('a Monero entry survives the encrypted backup file round trip', async () => {
    const sourceId = svc.activeWalletId()!;
    const { id } = await svc.addMoneroAccount(sourceId);
    const { text } = await svc.exportBackup('file-password-1');
    // Fresh install, restore.
    setStorageForTests(new MemoryStorageAdapter());
    const fresh = new LiveWalletService(offlineClient);
    const preview = await fresh.readBackupFile(text, 'file-password-1');
    expect(preview).toBeTruthy();
    await fresh.applyRestore('replace');
    const restored = (await fresh.listWallets()).find((w) => w.id === id)!;
    expect(restored.family).toBe('monero');
    expect(restored.restoreHeight).toBe(MONERO_RELEASE_HEIGHT);
    expect(restored.address).toBe(VECTOR_ADDRESS);
    await fresh.switchWallet(id);
    expect(await fresh.unlock(PW)).toBe(true);
    expect(fresh.getAddress(0)).toBe(VECTOR_ADDRESS);
  });
});
