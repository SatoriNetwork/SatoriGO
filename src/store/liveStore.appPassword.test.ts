// The PHASE MACHINE around the app password (the app-password design notes §5).
//
// The flow the owner confirmed:
//
//   launch -> APP LOCK SCREEN ('app-locked')
//               |- wrong -> stay
//               \- right -> already migrated  -> 'ready', no second prompt
//                           still on v1       -> 'locked', its own prompt once
//
// ...and, for a user who never set an app password, the identical flow the
// wallet has always had. Every assertion below about 'app-locked' has a twin
// asserting it never happens without an app password.
//
// The wallet service is mocked: this file is about which phase the store chooses,
// not about crypto (liveWallet.appPassword.test.ts covers that with real scrypt).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  appRecord: null as { set: true } | null,
  /** A recovery code on this device, or null (the app-password design notes §13). */
  recoveryCode: null as string | null,
  masterKeyHeld: false,
  appPassword: 'app-pw',
  /** Per-wallet: is its vault v2 (app-key protected) yet? */
  wallets: [] as Array<{
    id: string;
    name: string;
    passwordless: boolean;
    appProtected: boolean;
  }>,
  activeId: '',
  unlockCalls: [] as Array<{ password: string; migrate: boolean | undefined }>,
  /** Which wallet password opens which wallet, for the v1 branch. */
  walletPasswords: {} as Record<string, string>,
  /** Name of a wallet whose wrapped key cannot be re-wrapped, or null. */
  unwrappableWallet: null as string | null,
  /** Wallets whose "do not ask when sending" is on (§6). */
  noSendPassword: new Set<string>(),
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
        ...(hoisted.noSendPassword.has(w.id) ? { noSendPassword: true } : {}),
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
    /** The forced-setup trigger (the app-password design notes §12), mirroring the
     *  real service: a wallet that opens with no password, and no app record. */
    async appPasswordRequired() {
      if (hoisted.appRecord) return false;
      if (hoisted.wallets.some((w) => w.appProtected)) return false;
      return hoisted.wallets.some((w) => w.passwordless);
    }
    async migratePasswordlessWallets() {
      const migrated: string[] = [];
      if (!hoisted.masterKeyHeld) return { migrated, kept: [] as string[] };
      for (const w of hoisted.wallets) {
        if (!w.passwordless || w.appProtected) continue;
        w.appProtected = true;
        w.passwordless = false;
        hoisted.noSendPassword.add(w.id);
        migrated.push(w.id);
      }
      return { migrated, kept: [] as string[] };
    }
    async revealNoPasswordBackup(walletId: string) {
      const w = hoisted.wallets.find((x) => x.id === walletId);
      if (!w || !w.passwordless || w.appProtected) return null;
      return { kind: 'seed' as const, secret: `phrase of ${w.name}` };
    }
    appUnlocked() {
      return hoisted.masterKeyHeld;
    }
    async unlockApp(password: string) {
      if (!hoisted.appRecord || password !== hoisted.appPassword) return false;
      hoisted.masterKeyHeld = true;
      return true;
    }
    async setAppPassword(password: string) {
      if (hoisted.appRecord) return false;
      hoisted.appPassword = password;
      hoisted.appRecord = { set: true };
      hoisted.masterKeyHeld = true;
      return true;
    }
    async changeAppPassword(oldPassword: string, newPassword: string) {
      // Mirrors the real service's typed result: the store has to tell a wrong
      // password apart from a wallet it could not re-wrap.
      if (!newPassword) return { ok: false as const, reason: 'empty-password' as const };
      if (!hoisted.appRecord) return { ok: false as const, reason: 'no-app-password' as const };
      if (oldPassword !== hoisted.appPassword) {
        return { ok: false as const, reason: 'wrong-password' as const };
      }
      if (hoisted.unwrappableWallet) {
        return {
          ok: false as const,
          reason: 'wallet-unreadable' as const,
          wallet: hoisted.unwrappableWallet,
        };
      }
      hoisted.appPassword = newPassword;
      this.lockApp();
      return { ok: true as const };
    }
    async unlock(password: string, opts?: { migrate?: boolean }) {
      hoisted.unlockCalls.push({ password, migrate: opts?.migrate });
      const entry = hoisted.wallets.find((w) => w.id === hoisted.activeId);
      if (!entry) return false;
      if (entry.appProtected) {
        if (!hoisted.masterKeyHeld && password !== hoisted.appPassword) return false;
        hoisted.masterKeyHeld = true;
      } else if (!entry.passwordless && password !== hoisted.walletPasswords[entry.id]) {
        return false;
      }
      this.unlocked = true;
      // The service's own lazy migration, in miniature.
      if (!entry.appProtected && hoisted.masterKeyHeld && opts?.migrate !== false) {
        entry.appProtected = true;
        entry.passwordless = false;
      }
      return true;
    }
    async switchWallet(id: string) {
      hoisted.activeId = id;
      this.lock(); // the SEED only: the master key survives a switch
    }
    async setNoSendPassword(enabled: boolean) {
      const entry = hoisted.wallets.find((w) => w.id === hoisted.activeId);
      if (!entry || !entry.appProtected) return false;
      if (enabled) hoisted.noSendPassword.add(entry.id);
      else hoisted.noSendPassword.delete(entry.id);
      return true;
    }
    async removeWallet(id: string) {
      hoisted.wallets = hoisted.wallets.filter((w) => w.id !== id);
      if (hoisted.activeId === id) {
        hoisted.activeId = hoisted.wallets[0]?.id ?? '';
        this.lock();
      }
      // The service drops the app record with the LAST wallet: an app password
      // with no wallets to open is only a lock on the next wallet created.
      if (hoisted.wallets.length === 0 && hoisted.appRecord) {
        hoisted.appRecord = null;
  hoisted.recoveryCode = null;
        hoisted.masterKeyHeld = false;
      }
    }
  }
  return { LiveWalletService, BroadcastGatedError, EVM_NETWORK: 'evm' };
});

vi.mock('../services/prices', () => ({ fetchPrices: async () => ({}) }));

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';

const state = () => useLiveStore.getState();

function seedWallets(
  wallets: Array<{ id: string; name: string; passwordless?: boolean; appProtected?: boolean; password?: string }>,
) {
  hoisted.wallets = wallets.map((w) => ({
    id: w.id,
    name: w.name,
    passwordless: w.passwordless ?? false,
    appProtected: w.appProtected ?? false,
  }));
  hoisted.walletPasswords = Object.fromEntries(
    wallets.map((w) => [w.id, w.password ?? 'wallet-pw']),
  );
  hoisted.activeId = wallets[0]?.id ?? '';
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  hoisted.appRecord = null;
  hoisted.masterKeyHeld = false;
  hoisted.appPassword = 'app-pw';
  hoisted.unlockCalls = [];
  hoisted.unwrappableWallet = null;
  hoisted.noSendPassword = new Set<string>();
  useLiveStore.setState({ phase: 'boot', appPasswordSet: false, appUnlocked: false, error: null });
});

describe('liveStore: no app password (the unchanged flow)', () => {
  it('init lands on the WALLET lock screen, never on the app one', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1' }]);
    await state().init();
    expect(state().phase).toBe('locked');
    expect(state().appPasswordSet).toBe(false);
    expect(state().appUnlocked).toBe(false);
  });

  it('a passwordless wallet is now BLOCKED on the forced setup instead of auto-unlocking', async () => {
    // The one deliberate behaviour change of §12: this install used to open
    // straight to the wallet, because there was no password to ask for. That is
    // exactly the state the forced setup exists to end, so it stops here.
    seedWallets([{ id: 'w-1', name: 'Open', passwordless: true }]);
    await state().init();
    expect(state().phase).toBe('force-app-password');
  });

  it('a wallet WITH its own password is untouched by that change', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1' }]);
    await state().init();
    expect(state().phase).toBe('locked');
  });

  it('lock() returns to the wallet lock screen', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1' }]);
    await state().init();
    await state().unlock('wallet-pw');
    expect(state().phase).toBe('ready');
    state().lock();
    expect(state().phase).toBe('locked');
  });
});

describe('liveStore: with an app password', () => {
  it('init goes to the APP lock screen, whatever the active wallet is', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1', passwordless: true }]);
    await state().setAppPassword('app-pw');
    hoisted.masterKeyHeld = false; // a fresh page
    await state().init();
    expect(state().phase).toBe('app-locked');
    expect(state().appPasswordSet).toBe(true);
    // Even a PASSWORDLESS wallet is not opened before the app password: it is
    // exactly the wallet whose behaviour is about to change (§6).
    expect(state().appUnlocked).toBe(false);
  });

  it('a wrong app password keeps the app locked', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1' }]);
    await state().setAppPassword('app-pw');
    hoisted.masterKeyHeld = false;
    await state().init();
    expect(await state().unlockApp('not it')).toBe(false);
    expect(state().phase).toBe('app-locked');
    expect(state().appUnlocked).toBe(false);
  });

  it('the right app password opens a MIGRATED wallet with no second prompt', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1', appProtected: true }]);
    await state().setAppPassword('app-pw');
    hoisted.masterKeyHeld = false;
    await state().init();
    expect(state().phase).toBe('app-locked');

    expect(await state().unlockApp('app-pw')).toBe(true);
    expect(state().phase).toBe('ready');
    // Nothing was typed for the wallet itself.
    expect(hoisted.unlockCalls).toEqual([{ password: '', migrate: undefined }]);
  });

  it('the right app password hands a STILL-v1 wallet to its own prompt, once', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1' }]);
    await state().setAppPassword('app-pw');
    hoisted.masterKeyHeld = false;
    await state().init();

    expect(await state().unlockApp('app-pw')).toBe(true);
    expect(state().phase).toBe('locked'); // the transitional prompt
    expect(hoisted.unlockCalls).toEqual([]);

    // Its own password, once. That unlock migrates it.
    expect(await state().unlock('wallet-pw', { migrate: true })).toBe(true);
    expect(state().phase).toBe('ready');
    expect(hoisted.wallets[0].appProtected).toBe(true);

    // Lock, and the SECOND time round it opens with the app password alone.
    state().lock();
    expect(state().phase).toBe('app-locked');
    expect(await state().unlockApp('app-pw')).toBe(true);
    expect(state().phase).toBe('ready');
  });

  it('declining leaves the wallet on its own password and asks again next time', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1' }]);
    await state().setAppPassword('app-pw');
    hoisted.masterKeyHeld = false;
    await state().init();
    await state().unlockApp('app-pw');

    expect(await state().unlock('wallet-pw', { migrate: false })).toBe(true);
    expect(state().phase).toBe('ready');
    expect(hoisted.wallets[0].appProtected).toBe(false);

    state().lock();
    expect(await state().unlockApp('app-pw')).toBe(true);
    expect(state().phase).toBe('locked'); // asked again, exactly as promised
  });

  it('lock() drops the master key and returns to the APP lock screen', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1', appProtected: true }]);
    await state().setAppPassword('app-pw');
    hoisted.masterKeyHeld = false;
    await state().init();
    await state().unlockApp('app-pw');
    expect(state().appUnlocked).toBe(true);

    state().lock();
    expect(state().phase).toBe('app-locked');
    expect(state().appUnlocked).toBe(false);
    expect(hoisted.masterKeyHeld).toBe(false);
  });

  it('switching to a migrated wallet asks for nothing; switching to a v1 one asks once', async () => {
    seedWallets([
      { id: 'w-1', name: 'Migrated', appProtected: true },
      { id: 'w-2', name: 'Still v1', password: 'other-pw' },
    ]);
    await state().setAppPassword('app-pw');
    hoisted.masterKeyHeld = false;
    await state().init();
    await state().unlockApp('app-pw');
    expect(state().phase).toBe('ready');

    await state().switchWallet('w-2');
    expect(state().phase).toBe('locked'); // its own password, once
    expect(await state().unlock('other-pw', { migrate: true })).toBe(true);
    expect(state().phase).toBe('ready');

    // Now BOTH are migrated: switching between them never asks again.
    await state().switchWallet('w-1');
    expect(state().phase).toBe('ready');
  });

  it('switching to a PASSWORDLESS wallet still on v1 prompts instead of migrating it silently', async () => {
    // REGRESSION THIS EXISTS FOR: the switch path auto-unlocked any passwordless
    // wallet, which under an app password migrated it with nothing said and no
    // way to decline. §6 requires the opposite. Found by the live smoke.
    seedWallets([
      { id: 'w-1', name: 'Migrated', appProtected: true },
      { id: 'w-2', name: 'Open', passwordless: true },
    ]);
    await state().setAppPassword('app-pw');
    hoisted.masterKeyHeld = false;
    await state().init();
    await state().unlockApp('app-pw');

    await state().switchWallet('w-2');
    expect(state().phase).toBe('locked'); // the transitional prompt, not 'ready'
    expect(hoisted.wallets[1].appProtected).toBe(false); // nothing moved
    expect(hoisted.unlockCalls).toEqual([{ password: '', migrate: undefined }]); // only w-1's

    // Declining opens it and leaves it on v1.
    expect(await state().unlock('', { migrate: false })).toBe(true);
    expect(state().phase).toBe('ready');
    expect(hoisted.wallets[1].appProtected).toBe(false);
  });

  it('with NO app password, switching to a passwordless wallet still opens it straight away', async () => {
    seedWallets([
      { id: 'w-1', name: 'Wallet 1' },
      { id: 'w-2', name: 'Open', passwordless: true },
    ]);
    await state().init();
    await state().unlock('wallet-pw');
    await state().switchWallet('w-2');
    expect(state().phase).toBe('ready');
  });

  it('changing the app password locks the wallet (any cached master key is dropped)', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1', appProtected: true }]);
    await state().setAppPassword('app-pw');
    hoisted.masterKeyHeld = false;
    await state().init();
    await state().unlockApp('app-pw');
    expect(state().phase).toBe('ready');

    expect(await state().changeAppPassword('wrong', 'new-app-pw')).toEqual({
      ok: false,
      error: 'Incorrect current password.',
    });
    expect(state().phase).toBe('ready'); // a typo must not lock anyone out

    expect(await state().changeAppPassword('app-pw', 'new-app-pw')).toEqual({ ok: true });
    expect(state().phase).toBe('app-locked');
    expect(state().appUnlocked).toBe(false);
    expect(await state().unlockApp('app-pw')).toBe(false);
    expect(await state().unlockApp('new-app-pw')).toBe(true);
    expect(state().phase).toBe('ready');
  });

  it('setting the app password migrates nothing and does not lock the session', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1' }]);
    await state().init();
    await state().unlock('wallet-pw');
    expect(state().phase).toBe('ready');

    expect(await state().setAppPassword('app-pw')).toEqual({ ok: true });
    expect(state().phase).toBe('ready');
    expect(state().appPasswordSet).toBe(true);
    expect(hoisted.wallets[0].appProtected).toBe(false); // nothing moved
  });
});

// ---------------------------------------------------------------------------
// The states an adversarial review found in this phase machine.
// ---------------------------------------------------------------------------

describe('liveStore: the app is UNLOCKED while a wallet lock screen shows', () => {
  it('reports appUnlocked at phase "locked" after the app password is accepted', async () => {
    seedWallets([
      { id: 'w-1', name: 'Migrated', appProtected: true },
      { id: 'w-2', name: 'Still v1' },
    ]);
    await state().setAppPassword('app-pw');
    // The mocked service is a module singleton that outlives each test, so drop
    // whatever session an earlier one left on it before asserting a phase.
    state().lock();
    hoisted.activeId = 'w-2'; // the still-v1 wallet is the one that opens
    await state().init();
    expect(state().phase).toBe('app-locked');

    expect(await state().unlockApp('app-pw')).toBe(true);
    // §5: the app password is accepted, and the wallet asks for its own next.
    expect(state().phase).toBe('locked');
    // The master key IS in memory here. It used to be reported as locked, which
    // is what left LiveApp's idle timer disarmed (it keyed on phase 'ready') and
    // the screen with no way to lock: the key simply stayed until the page died.
    expect(state().appUnlocked).toBe(true);
  });

  it('a SWITCH to a still-v1 wallet keeps reporting the app as unlocked', async () => {
    seedWallets([
      { id: 'w-1', name: 'Migrated', appProtected: true },
      { id: 'w-2', name: 'Still v1' },
    ]);
    await state().setAppPassword('app-pw');
    // The mocked service is a module singleton that outlives each test, so drop
    // whatever session an earlier one left on it before asserting a phase.
    state().lock();
    await state().init();
    await state().unlockApp('app-pw');
    expect(state().phase).toBe('ready');

    await state().switchWallet('w-2');
    expect(state().phase).toBe('locked');
    expect(state().appUnlocked).toBe(true); // svc.lock() keeps the master key
  });

  it('lock() from there drops the key and returns to the app lock screen', async () => {
    seedWallets([{ id: 'w-1', name: 'Still v1' }]);
    await state().setAppPassword('app-pw');
    // The mocked service is a module singleton that outlives each test, so drop
    // whatever session an earlier one left on it before asserting a phase.
    state().lock();
    await state().init();
    await state().unlockApp('app-pw');
    expect(state().phase).toBe('locked');
    expect(state().appUnlocked).toBe(true);

    state().lock();
    expect(state().phase).toBe('app-locked');
    expect(state().appUnlocked).toBe(false);
    expect(hoisted.masterKeyHeld).toBe(false);
  });
});

describe('liveStore: nothing is stranded behind the APP lock screen (§4 rule 5)', () => {
  it('openWithWalletPassword reaches a wallet that never migrated', async () => {
    seedWallets([
      { id: 'w-1', name: 'Migrated', appProtected: true },
      { id: 'w-2', name: 'Still v1', password: 'its-own-pw' },
    ]);
    await state().setAppPassword('app-pw');
    // The mocked service is a module singleton that outlives each test, so drop
    // whatever session an earlier one left on it before asserting a phase.
    state().lock();
    await state().init();
    expect(state().phase).toBe('app-locked');

    // The app password is forgotten. The v1 wallet's own password still works,
    // and this screen used to be one field with no route to it at all.
    expect(await state().openWithWalletPassword()).toBe(true);
    expect(state().phase).toBe('locked');
    expect(state().activeWalletId).toBe('w-2');

    expect(await state().unlock('its-own-pw', { migrate: false })).toBe(true);
    expect(state().phase).toBe('ready');
    expect(hoisted.wallets[1].appProtected).toBe(false); // still v1, as asked
    expect(state().appUnlocked).toBe(false); // no app password was proven
  });

  it('refuses when every wallet has already moved over (there is nothing to reach)', async () => {
    seedWallets([{ id: 'w-1', name: 'Migrated', appProtected: true }]);
    await state().setAppPassword('app-pw');
    // The mocked service is a module singleton that outlives each test, so drop
    // whatever session an earlier one left on it before asserting a phase.
    state().lock();
    await state().init();
    expect(state().phase).toBe('app-locked');

    expect(await state().openWithWalletPassword()).toBe(false);
    expect(state().phase).toBe('app-locked'); // no half-open state
  });

  it('showAppLock goes back, so the two screens are a round trip', async () => {
    seedWallets([
      { id: 'w-1', name: 'Migrated', appProtected: true },
      { id: 'w-2', name: 'Still v1' },
    ]);
    await state().setAppPassword('app-pw');
    // The mocked service is a module singleton that outlives each test, so drop
    // whatever session an earlier one left on it before asserting a phase.
    state().lock();
    await state().init();
    await state().openWithWalletPassword();
    expect(state().phase).toBe('locked');

    state().showAppLock();
    expect(state().phase).toBe('app-locked');
  });

  it('showAppLock LOCKS: no master key is left sitting behind that screen', async () => {
    seedWallets([
      { id: 'w-1', name: 'Migrated', appProtected: true },
      { id: 'w-2', name: 'Still v1' },
    ]);
    await state().setAppPassword('app-pw');
    state().lock();
    await state().init();
    expect(await state().unlockApp('app-pw')).toBe(true);
    // The state it is offered from: the app is unlocked, and a wallet that never
    // migrated is showing its own lock screen (§5's third state).
    await state().openWithWalletPassword();
    expect(state().phase).toBe('locked');
    expect(state().appUnlocked).toBe(true);

    state().showAppLock();

    expect(state().phase).toBe('app-locked');
    // It used to only set the phase, which left the master key in memory behind
    // a screen asking for the app password: safe only by the convention that the
    // screen renders under `!appUnlocked`. A convention is not a control.
    expect(state().appUnlocked).toBe(false);
    expect(hoisted.masterKeyHeld).toBe(false);
  });

  it('showAppLock does nothing when no app password exists', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1' }]);
    await state().init();
    expect(state().phase).toBe('locked');
    state().showAppLock();
    expect(state().phase).toBe('locked'); // there is no such screen to go to
  });
});

describe('liveStore: removing the last wallet clears the app password', () => {
  it('lands on onboarding with no app password believed in', async () => {
    seedWallets([{ id: 'w-1', name: 'Only', appProtected: true }]);
    await state().setAppPassword('app-pw');
    await state().init();
    expect(state().appPasswordSet).toBe(true);

    await state().removeWallet('w-1');
    expect(state().phase).toBe('onboarding');
    // The next wallet the user creates used to be gated behind the OLD app
    // password, which it had never had anything to do with, with no reset.
    expect(state().appPasswordSet).toBe(false);
    expect(state().appUnlocked).toBe(false);
  });
});

describe('liveStore: what a failed app-password change says', () => {
  it('names the wallet when a re-wrap fails, instead of blaming the password', async () => {
    seedWallets([
      { id: 'w-1', name: 'Good', appProtected: true },
      { id: 'w-2', name: 'Bad', appProtected: true },
    ]);
    await state().setAppPassword('app-pw');
    // The mocked service is a module singleton that outlives each test, so drop
    // whatever session an earlier one left on it before asserting a phase.
    state().lock();
    await state().init();
    await state().unlockApp('app-pw');

    hoisted.unwrappableWallet = 'Bad';
    const result = await state().changeAppPassword('app-pw', 'new-app-pw');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"Bad"');
    expect(result.error).not.toContain('Incorrect current password');
    // Nothing changed and nothing locked: the session is still valid.
    expect(state().phase).toBe('ready');
    expect(hoisted.appPassword).toBe('app-pw');
  });

  it('an empty new password says so, instead of blaming the current one', async () => {
    seedWallets([{ id: 'w-1', name: 'Wallet 1', appProtected: true }]);
    await state().setAppPassword('app-pw');
    // The mocked service is a module singleton that outlives each test, so drop
    // whatever session an earlier one left on it before asserting a phase.
    state().lock();
    await state().init();
    await state().unlockApp('app-pw');

    const result = await state().changeAppPassword('app-pw', '');
    expect(result).toEqual({ ok: false, error: 'Enter a new app password.' });
  });
});

describe('liveStore: "do not ask when sending" is switchable (§6)', () => {
  it('turns off, and the summary stops carrying it', async () => {
    seedWallets([{ id: 'w-1', name: 'Was passwordless', appProtected: true }]);
    hoisted.noSendPassword.add('w-1');
    await state().setAppPassword('app-pw');
    await state().init();
    await state().unlockApp('app-pw');
    expect(state().wallets[0].noSendPassword).toBe(true);

    expect(await state().setNoSendPassword(false)).toEqual({ ok: true });
    // It was permanent and invisible before: nothing could clear it.
    expect(state().wallets[0].noSendPassword).toBeUndefined();

    expect(await state().setNoSendPassword(true)).toEqual({ ok: true });
    expect(state().wallets[0].noSendPassword).toBe(true);
  });
});
