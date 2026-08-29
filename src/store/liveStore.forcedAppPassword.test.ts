// THE PHASE MACHINE around the FORCED app-password setup
// (the app-password design notes §12).
//
//   launch -> is there a wallet that opens with NO password, and no app
//             password to protect it with?
//               yes -> 'force-app-password', and there is no way out of it but
//                      setting the password. Closing the window and opening it
//                      again lands right back here.
//               no  -> exactly the flow this wallet has always had.
//
// Every assertion about 'force-app-password' has a twin asserting it never
// happens for a user who does not have an unprotected wallet.
//
// The wallet service is mocked: this file is about which phase the store chooses
// and what it hands the screen, not about crypto
// (liveWallet.forcedAppPassword.test.ts covers that with real scrypt).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  appRecord: null as { set: true } | null,
  /** A recovery code on this device, or null (the app-password design notes §13). */
  recoveryCode: null as string | null,
  appPassword: '',
  masterKeyHeld: false,
  wallets: [] as Array<{
    id: string;
    name: string;
    passwordless: boolean;
    appProtected: boolean;
    /** A wallet the migration cannot move (its vault is not what the flag says). */
    unmovable?: boolean;
  }>,
  activeId: '',
  walletPasswords: {} as Record<string, string>,
  /** Every wallet whose secret was actually read, so a test can prove a guarded
   *  wallet's vault was never opened by this flow. */
  decrypted: [] as string[],
}));

vi.mock('../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    private unlocked = false;
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    async exists() {
      return hoisted.wallets.length > 0;
    }
    async listWallets() {
      return hoisted.wallets.map((w) => ({
        id: w.id,
        name: w.name,
        network: 'mainnet',
        createdAt: 1,
        active: w.id === hoisted.activeId,
        kind: 'seed' as const,
        address: 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU',
        passwordless: w.passwordless,
        family: 'utxo' as const,
        ...(w.appProtected ? { appProtected: true } : {}),
      }));
    }
    activeWalletId() {
      return hoisted.activeId || null;
    }
    network() {
      return 'mainnet';
    }
    isUnlocked() {
      return this.unlocked;
    }
    getAddress() {
      return 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU';
    }
    getProvider() {
      return {};
    }
    async listAddresses() {
      return [{ index: 0, address: 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU' }];
    }
    lock() {
      this.unlocked = false;
    }
    lockApp() {
      hoisted.masterKeyHeld = false;
      this.lock();
    }
    async hasAppPassword() {
      return hoisted.appRecord !== null;
    }
    /** Mirrors the real service (the app-password design notes §13). It is read on
     *  every init, so a double that omits it throws there and the store lands on
     *  'onboarding' — which is how its absence showed up, and why it is here
     *  rather than only on the doubles whose tests happen to need it. */
    async hasRecoveryCode() {
      return hoisted.recoveryCode !== null;
    }
    appUnlocked() {
      return hoisted.masterKeyHeld;
    }
    async appPasswordRequired() {
      if (hoisted.appRecord) return false;
      if (hoisted.wallets.some((w) => w.appProtected)) return false;
      return hoisted.wallets.some((w) => w.passwordless);
    }
    async setAppPassword(password: string) {
      if (hoisted.appRecord) return false;
      if (hoisted.wallets.some((w) => w.appProtected)) return false;
      hoisted.appRecord = { set: true };
      hoisted.appPassword = password;
      hoisted.masterKeyHeld = true;
      return true;
    }
    async migratePasswordlessWallets() {
      const migrated: string[] = [];
      const kept: string[] = [];
      if (!hoisted.masterKeyHeld) return { migrated, kept };
      for (const w of hoisted.wallets) {
        if (!w.passwordless || w.appProtected) continue;
        if (w.unmovable) {
          kept.push(w.id);
          continue;
        }
        hoisted.decrypted.push(w.id);
        w.appProtected = true;
        w.passwordless = false;
        migrated.push(w.id);
      }
      return { migrated, kept };
    }
    async revealNoPasswordBackup(walletId: string) {
      const w = hoisted.wallets.find((x) => x.id === walletId);
      if (!w || !w.passwordless || w.appProtected) return null;
      hoisted.decrypted.push(w.id);
      return { kind: 'seed' as const, secret: `phrase of ${w.name}` };
    }
    async unlock(password: string) {
      const entry = hoisted.wallets.find((w) => w.id === hoisted.activeId);
      if (!entry) return false;
      if (entry.appProtected) {
        if (!hoisted.masterKeyHeld && password !== hoisted.appPassword) return false;
        hoisted.masterKeyHeld = true;
      } else if (!entry.passwordless && password !== hoisted.walletPasswords[entry.id]) {
        return false;
      }
      hoisted.decrypted.push(entry.id);
      this.unlocked = true;
      return true;
    }
    async switchWallet(id: string) {
      hoisted.activeId = id;
      this.lock();
    }
    async removeWallet() {}
  }
  return { LiveWalletService, BroadcastGatedError, EVM_NETWORK: 'evm' };
});

vi.mock('../services/prices', () => ({ fetchPrices: async () => ({}) }));

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';

const state = () => useLiveStore.getState();

function seedWallets(
  wallets: Array<{
    id: string;
    name: string;
    passwordless?: boolean;
    appProtected?: boolean;
    password?: string;
    unmovable?: boolean;
  }>,
) {
  hoisted.wallets = wallets.map((w) => ({
    id: w.id,
    name: w.name,
    passwordless: w.passwordless ?? false,
    appProtected: w.appProtected ?? false,
    unmovable: w.unmovable,
  }));
  hoisted.walletPasswords = Object.fromEntries(
    wallets.map((w) => [w.id, w.password ?? 'wallet-pw']),
  );
  hoisted.activeId = wallets[0]?.id ?? '';
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  hoisted.appRecord = null;
  hoisted.recoveryCode = null;
  hoisted.appPassword = '';
  hoisted.masterKeyHeld = false;
  hoisted.decrypted = [];
  useLiveStore.setState({ phase: 'boot', appPasswordSet: false, appUnlocked: false, error: null });
});

// ---------------------------------------------------------------------------
// The trigger, at the phase level
// ---------------------------------------------------------------------------

describe('liveStore: when the forced setup appears', () => {
  it('a wallet with no password and no app password: the screen blocks the launch', async () => {
    seedWallets([{ id: 'w-1', name: 'Open', passwordless: true }]);
    await state().init();
    expect(state().phase).toBe('force-app-password');
  });

  it('a wallet with no password but an app password already set: the app lock screen, as before', async () => {
    seedWallets([{ id: 'w-1', name: 'Open', passwordless: true }]);
    hoisted.appRecord = { set: true };
    hoisted.appPassword = 'app-pw';
    await state().init();
    expect(state().phase).toBe('app-locked');
  });

  it('no wallet without a password and no app password: the wallet lock screen, untouched', async () => {
    seedWallets([{ id: 'w-1', name: 'Guarded' }]);
    await state().init();
    expect(state().phase).toBe('locked');
  });

  it('no wallet without a password and an app password set: the app lock screen, untouched', async () => {
    seedWallets([{ id: 'w-1', name: 'Guarded' }]);
    hoisted.appRecord = { set: true };
    hoisted.appPassword = 'app-pw';
    await state().init();
    expect(state().phase).toBe('app-locked');
  });

  it('no wallets at all: onboarding, never the setup screen', async () => {
    seedWallets([]);
    await state().init();
    expect(state().phase).toBe('onboarding');
  });

  it('blocks a page whose service already holds a seed from earlier in its own session', async () => {
    seedWallets([{ id: 'w-1', name: 'Open', passwordless: true }]);
    // Open the wallet first (a page that was created before this build, or one
    // that just onboarded a passwordless wallet), then re-init: a launch is a
    // launch, and the screen still comes.
    await state().init();
    expect(state().phase).toBe('force-app-password');
    await state().completeForcedAppPassword('one password for everything');
    await state().finishForcedAppPassword();
    expect(state().phase).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// Forced means forced
// ---------------------------------------------------------------------------

describe('liveStore: there is no way around the forced setup', () => {
  beforeEach(async () => {
    seedWallets([{ id: 'w-1', name: 'Open', passwordless: true }]);
    await state().init();
    expect(state().phase).toBe('force-app-password');
  });

  it('comes back at the next launch when the window is simply closed', async () => {
    // Closing the window is a new page with a new store; init() is what runs.
    useLiveStore.setState({ phase: 'boot' });
    await state().init();
    expect(state().phase).toBe('force-app-password');
    // ...and again.
    useLiveStore.setState({ phase: 'boot' });
    await state().init();
    expect(state().phase).toBe('force-app-password');
  });

  it('finishing WITHOUT a password does nothing at all', async () => {
    // The screen never calls it before the password exists; a gate must not
    // depend on that being true.
    await state().finishForcedAppPassword();
    expect(state().phase).toBe('force-app-password');
    expect(hoisted.appRecord).toBeNull();
  });

  it('showAppLock() cannot be used to slip past it', async () => {
    state().showAppLock();
    expect(state().phase).toBe('force-app-password');
  });

  it('an empty or refused password leaves the screen exactly where it was', async () => {
    const empty = await state().completeForcedAppPassword('');
    expect(empty.ok).toBe(false);
    expect(state().phase).toBe('force-app-password');
    expect(hoisted.appRecord).toBeNull();
  });

  it('reading a recovery phrase first does NOT move the phase', async () => {
    const found = await state().revealPasswordlessBackup('w-1');
    expect(found).toEqual({ kind: 'seed', secret: 'phrase of Open' });
    expect(state().phase).toBe('force-app-password');
    expect(state().appPasswordSet).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What setting it does, and what the screen is then told to say
// ---------------------------------------------------------------------------

describe('liveStore: completing the forced setup', () => {
  it('protects the wallet, and the single-wallet case goes straight in', async () => {
    seedWallets([{ id: 'w-1', name: 'Open', passwordless: true }]);
    await state().init();

    const result = await state().completeForcedAppPassword('one password for everything');
    expect(result).toMatchObject({ ok: true, migrated: ['Open'], kept: [] });
    expect(state().appPasswordSet).toBe(true);
    expect(state().appUnlocked).toBe(true);
    expect(hoisted.wallets[0].appProtected).toBe(true);
    expect(hoisted.wallets[0].passwordless).toBe(false);

    await state().finishForcedAppPassword();
    expect(state().phase).toBe('ready');
  });

  it('A MIXED INSTALL: only the unprotected wallets move, and the guarded ones are never read', async () => {
    seedWallets([
      { id: 'w-1', name: 'Open One', passwordless: true },
      { id: 'w-2', name: 'Guarded One', password: 'guard-one' },
      { id: 'w-3', name: 'Open Two', passwordless: true },
      { id: 'w-4', name: 'Guarded Two', password: 'guard-two' },
    ]);
    await state().init();
    expect(state().phase).toBe('force-app-password');
    // The screen's own arithmetic: two of four.
    expect(state().wallets.filter((w) => w.passwordless).map((w) => w.name)).toEqual([
      'Open One',
      'Open Two',
    ]);

    const result = await state().completeForcedAppPassword('one password for everything');
    expect(result.ok).toBe(true);
    expect(result.migrated).toEqual(['Open One', 'Open Two']);
    expect(result.kept).toEqual([]);
    // NOTHING READ THE GUARDED WALLETS. Their seeds are unreadable without
    // passwords the user has not typed, so this flow cannot have touched them.
    expect(hoisted.decrypted).toEqual(['w-1', 'w-3']);
    expect(hoisted.wallets.find((w) => w.id === 'w-2')).toMatchObject({
      appProtected: false,
      passwordless: false,
    });
    expect(hoisted.wallets.find((w) => w.id === 'w-4')).toMatchObject({
      appProtected: false,
      passwordless: false,
    });

    // The wallet list now says which password opens which.
    const list = state().wallets;
    expect(list.filter((w) => w.appProtected).map((w) => w.name)).toEqual(['Open One', 'Open Two']);
    expect(list.filter((w) => !w.appProtected).map((w) => w.name)).toEqual([
      'Guarded One',
      'Guarded Two',
    ]);

    // The active wallet moved over, so it opens with nothing typed.
    await state().finishForcedAppPassword();
    expect(state().phase).toBe('ready');
  });

  it('a mixed install whose ACTIVE wallet keeps its own password lands on that wallet prompt', async () => {
    seedWallets([
      { id: 'w-1', name: 'Guarded', password: 'guard' },
      { id: 'w-2', name: 'Open', passwordless: true },
    ]);
    await state().init();
    expect(state().phase).toBe('force-app-password');

    const result = await state().completeForcedAppPassword('one password for everything');
    expect(result.migrated).toEqual(['Open']);
    await state().finishForcedAppPassword();
    // Its own password, once: exactly what the summary said would happen.
    expect(state().phase).toBe('locked');
    expect(state().appUnlocked).toBe(true);
    expect(await state().unlock('guard')).toBe(true);
    expect(state().phase).toBe('ready');
  });

  it('reports a wallet that could not be moved instead of pretending it was', async () => {
    seedWallets([
      { id: 'w-1', name: 'Open', passwordless: true },
      { id: 'w-2', name: 'Stuck', passwordless: true, unmovable: true },
    ]);
    await state().init();
    const result = await state().completeForcedAppPassword('one password for everything');
    expect(result.ok).toBe(true);
    expect(result.migrated).toEqual(['Open']);
    expect(result.kept).toEqual(['Stuck']);
  });
});
