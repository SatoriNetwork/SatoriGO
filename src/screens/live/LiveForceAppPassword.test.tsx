/**
 * @vitest-environment jsdom
 *
 * THE FORCED APP-PASSWORD SETUP SCREEN (the app-password design notes §12).
 *
 * The screen a user meets when a wallet on this device opens with NO password
 * and there is no app password to protect it with. It is the only screen in the
 * wallet with no way out but forward, so most of what is asserted here is what
 * it must NOT have: no skip, no cancel, no Escape, no route to any other screen.
 *
 * And the thing that makes forcing defensible: the backup is offered BEFORE the
 * password is taken, it works with nothing typed, it names exactly the wallets
 * whose phrase stops being reachable, and it comes back to the setup step.
 *
 * The wallet service is stubbed (this screen talks to no chain) and the store's
 * actions are replaced per test and restored after, because the store is a
 * module singleton.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    async exists() {
      return true;
    }
    async listWallets() {
      return [];
    }
    activeWalletId() {
      return null;
    }
    isUnlocked() {
      return false;
    }
    getProvider() {
      return {};
    }
    lock() {}
    async hasAppPassword() {
      return false;
    }
    async appPasswordRequired() {
      return false;
    }
    appUnlocked() {
      return false;
    }
    lockApp() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

vi.mock('../../services/prices', () => ({ fetchPrices: async () => ({}) }));

import { LiveForceAppPassword } from './LiveForceAppPassword';
import { useLiveStore } from '../../store/liveStore';
import type { WalletSummary } from '../../services/chain/liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

const state = () => useLiveStore.getState();

function wallet(over: Partial<WalletSummary> & { id: string }): WalletSummary {
  return {
    name: 'My Evrmore',
    network: 'mainnet',
    createdAt: 1,
    active: false,
    kind: 'seed',
    address: 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU',
    passwordless: false,
    family: 'utxo',
    ...over,
  } as WalletSummary;
}

const realActions = {
  completeForcedAppPassword: state().completeForcedAppPassword,
  finishForcedAppPassword: state().finishForcedAppPassword,
  revealPasswordlessBackup: state().revealPasswordlessBackup,
};

function seed(wallets: WalletSummary[], over: Partial<ReturnType<typeof state>> = {}) {
  useLiveStore.setState({
    wallets,
    activeWalletId: wallets[0]?.id ?? null,
    phase: 'force-app-password',
    appPasswordSet: false,
    appUnlocked: false,
    error: null,
    completeForcedAppPassword: vi.fn(async () => ({
      ok: true,
      migrated: wallets.filter((w) => w.passwordless).map((w) => w.name),
      kept: [] as string[],
    })),
    finishForcedAppPassword: vi.fn(async () => {}),
    revealPasswordlessBackup: vi.fn(async (id: string) => ({
      kind: 'seed' as const,
      secret: `phrase of ${wallets.find((w) => w.id === id)?.name ?? '?'}`,
    })),
    ...over,
  });
}

/** One passwordless wallet, nothing else. */
function single() {
  seed([wallet({ id: 'w-1', name: 'Open Wallet', passwordless: true, active: true })]);
}

/** TWO with no password and TWO with their own: the owner's mixed install. */
function mixed() {
  seed([
    wallet({ id: 'w-1', name: 'Open One', passwordless: true, active: true }),
    wallet({ id: 'w-2', name: 'Guarded One' }),
    wallet({ id: 'w-3', name: 'Open Two', passwordless: true }),
    wallet({ id: 'w-4', name: 'Guarded Two' }),
  ]);
}

const text = () => screen.getByTestId('live-force-app-password').textContent ?? '';

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

afterEach(() => {
  useLiveStore.setState({ ...realActions, wallets: [], activeWalletId: null, error: null });
  cleanup();
});

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

describe('the blocking screen', () => {
  it('explains what is wrong, what it costs, and what fixes it', async () => {
    single();
    render(<LiveForceAppPassword />);
    const body = text();
    expect(body).toMatch(/opens with no password at all/i);
    expect(body).toMatch(/anyone who can use this computer/i);
    expect(body).toMatch(/spend from it/i);
    expect(body).toMatch(/An app password fixes that/i);
    // The existing sentences from the Settings setup screen, verbatim in meaning.
    expect(body).toMatch(/can only be restored from their recovery phrases/i);
    expect(body).toMatch(/Removing the app password is not supported in this release/i);
  });

  it('counts correctly for ONE wallet and for the mixed install', async () => {
    single();
    render(<LiveForceAppPassword />);
    expect(text()).toMatch(/Your wallet opens with no password at all/i);
    expect(text()).not.toMatch(/of your/i);
    cleanup();

    mixed();
    render(<LiveForceAppPassword />);
    // Two of four, not "your wallet".
    expect(text()).toMatch(/Two of your four wallets open with no password at all/i);
    expect(text()).toMatch(/Open One and Open Two/);
    // And it says the guarded ones are not being changed.
    expect(text()).toMatch(/Two wallets already have their own passwords and are not changed here/i);
    expect(text()).not.toMatch(/Guarded One/);
  });

  it('uses no em-dash anywhere', () => {
    mixed();
    render(<LiveForceAppPassword />);
    expect(text()).not.toContain('—');
  });
});

// ---------------------------------------------------------------------------
// Forced means forced
// ---------------------------------------------------------------------------

describe('there is no way around it', () => {
  it('offers no skip, no cancel, no "later" and no close', () => {
    mixed();
    render(<LiveForceAppPassword />);
    for (const label of [/skip/i, /^cancel$/i, /later/i, /^close$/i, /not now/i, /remind/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    // Exactly one submit, and it is the password.
    expect(screen.getByTestId('live-force-app-pw-submit')).toBeTruthy();
  });

  it('Escape does nothing: the screen is still there', () => {
    single();
    render(<LiveForceAppPassword />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId('live-force-app-password')).toBeTruthy();
    expect(state().phase).toBe('force-app-password');
  });

  it('refuses a password that is too short, or that does not match, without calling the store', async () => {
    single();
    render(<LiveForceAppPassword />);
    const submit = screen.getByTestId('live-force-app-pw-submit');

    fireEvent.change(screen.getByTestId('live-force-app-pw-new'), { target: { value: 'short' } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId('live-force-app-pw-error').textContent).toMatch(/at least/i));
    expect(state().completeForcedAppPassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('live-force-app-pw-new'), {
      target: { value: 'a long enough password' },
    });
    fireEvent.change(screen.getByTestId('live-force-app-pw-confirm'), {
      target: { value: 'a different password' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByTestId('live-force-app-pw-error').textContent).toMatch(/do not match/i));
    expect(state().completeForcedAppPassword).not.toHaveBeenCalled();
  });

  it('stays put and says why when the store refuses', async () => {
    single();
    useLiveStore.setState({
      completeForcedAppPassword: vi.fn(async () => ({
        ok: false,
        error: 'Another window changed your wallets. Nothing was changed, please try again.',
        migrated: [],
        kept: [],
      })),
    });
    render(<LiveForceAppPassword />);
    fireEvent.change(screen.getByTestId('live-force-app-pw-new'), { target: { value: 'a long enough password' } });
    fireEvent.change(screen.getByTestId('live-force-app-pw-confirm'), { target: { value: 'a long enough password' } });
    fireEvent.click(screen.getByTestId('live-force-app-pw-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('live-force-app-pw-error').textContent).toMatch(/Nothing was changed/i),
    );
    expect(screen.getByTestId('live-force-app-password')).toBeTruthy();
    expect(state().finishForcedAppPassword).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The backup, offered before it is taken away
// ---------------------------------------------------------------------------

describe('show my recovery phrase first', () => {
  it('reveals with NO password and comes back to the setup step', async () => {
    single();
    render(<LiveForceAppPassword />);
    expect(screen.getByTestId('live-force-app-password-reveal-0').textContent).toMatch(
      /Show my recovery phrase first/i,
    );

    fireEvent.click(screen.getByTestId('live-force-app-password-reveal-0'));
    // No password field anywhere in the reveal: there is nothing to ask for yet.
    await waitFor(() => expect(screen.getByTestId('live-reveal-output').textContent).toBe('phrase of Open Wallet'));
    expect(screen.queryByTestId('live-reveal-password')).toBeNull();
    // The SAME warning the wallet's own reveal screen has always carried.
    expect(screen.getByTestId('live-reveal-modal').textContent).toMatch(/Never share this/i);

    fireEvent.click(screen.getByTestId('live-reveal-hide'));
    await waitFor(() => expect(screen.queryByTestId('live-reveal-modal')).toBeNull());
    // Back on the setup step, with the password still to set.
    expect(screen.getByTestId('live-force-app-pw-submit')).toBeTruthy();
    expect(state().phase).toBe('force-app-password');
  });

  it('stays reachable while the password is being typed', async () => {
    single();
    render(<LiveForceAppPassword />);
    fireEvent.change(screen.getByTestId('live-force-app-pw-new'), { target: { value: 'a long enough password' } });
    // The offer is not a step that gets consumed: it is still right there.
    expect(screen.getByTestId('live-force-app-password-reveal-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('live-force-app-password-reveal-0'));
    await waitFor(() => expect(screen.getByTestId('live-reveal-output')).toBeTruthy());
  });

  it('offers exactly the passwordless wallets, and never one whose password was not typed', async () => {
    mixed();
    render(<LiveForceAppPassword />);
    const buttons = screen.getAllByTestId(/^live-force-app-password-reveal-/);
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Open One: show recovery phrase',
      'Open Two: show recovery phrase',
    ]);
    // Nothing anywhere offers to show a guarded wallet's phrase.
    expect(text()).not.toMatch(/Guarded One: show/);

    fireEvent.click(buttons[1]);
    await waitFor(() => expect(screen.getByTestId('live-reveal-output').textContent).toBe('phrase of Open Two'));
    expect(state().revealPasswordlessBackup).toHaveBeenCalledWith('w-3');
  });

  it('says PRIVATE KEY for an imported-key wallet, which has no recovery phrase', async () => {
    seed([wallet({ id: 'w-1', name: 'Satori Key', passwordless: true, kind: 'pk', active: true })]);
    render(<LiveForceAppPassword />);
    expect(screen.getByTestId('live-force-app-password-reveal-0').textContent).toMatch(
      /Show my private key first/i,
    );
    expect(text()).toMatch(/see the private key of this wallet without typing anything/i);
    expect(text()).not.toMatch(/see the recovery phrase of this wallet/i);
  });
});

// ---------------------------------------------------------------------------
// What the user is told afterwards
// ---------------------------------------------------------------------------

describe('after the password is set', () => {
  async function setIt() {
    fireEvent.change(screen.getByTestId('live-force-app-pw-new'), { target: { value: 'a long enough password' } });
    fireEvent.change(screen.getByTestId('live-force-app-pw-confirm'), { target: { value: 'a long enough password' } });
    fireEvent.click(screen.getByTestId('live-force-app-pw-submit'));
  }

  it('a single-wallet install goes straight in with no extra step', async () => {
    single();
    render(<LiveForceAppPassword />);
    await setIt();
    await waitFor(() => expect(state().finishForcedAppPassword).toHaveBeenCalled());
    expect(screen.queryByTestId('live-force-app-password-done')).toBeNull();
  });

  it('THE MIXED INSTALL IS TOLD PLAINLY WHAT IT NOW HAS TO REMEMBER', async () => {
    mixed();
    render(<LiveForceAppPassword />);
    await setIt();
    await waitFor(() => expect(screen.getByTestId('live-force-app-password-done')).toBeTruthy());

    expect(screen.getByTestId('live-force-app-password-protected').textContent).toMatch(
      /Two wallets are protected by it now: Open One and Open Two\./,
    );
    const still = screen.getByTestId('live-force-app-password-still-own').textContent ?? '';
    expect(still).toMatch(/Two wallets still have their own password: Guarded One and Guarded Two\./);
    expect(still).toMatch(/asks for its own password once, the next time you open it/i);
    // MORE to remember, not less, and said before they meet it at a lock screen.
    const both = screen.getByTestId('live-force-app-password-both').textContent ?? '';
    expect(both).toMatch(/you need both/i);
    // And the property that makes forcing safe, stated where it matters.
    expect(both).toMatch(/Forgetting the app password does not lock you out of those wallets/i);

    // Nothing has opened yet: Continue is the door.
    expect(state().finishForcedAppPassword).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('live-force-app-password-continue'));
    await waitFor(() => expect(state().finishForcedAppPassword).toHaveBeenCalled());
  });

  it('names a wallet that could not be moved rather than pretending it was', async () => {
    seed(
      [
        wallet({ id: 'w-1', name: 'Open One', passwordless: true, active: true }),
        wallet({ id: 'w-2', name: 'Stuck', passwordless: true }),
      ],
      {
        completeForcedAppPassword: vi.fn(async () => ({
          ok: true,
          migrated: ['Open One'],
          kept: ['Stuck'],
        })),
      },
    );
    render(<LiveForceAppPassword />);
    await setIt();
    await waitFor(() => expect(screen.getByTestId('live-force-app-password-kept')).toBeTruthy());
    expect(screen.getByTestId('live-force-app-password-kept').textContent).toMatch(
      /"Stuck" could not be moved and still opens with no password/,
    );
  });
});
