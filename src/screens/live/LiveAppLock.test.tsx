/**
 * @vitest-environment jsdom
 *
 * The APP LOCK SCREEN and the TRANSITIONAL per-wallet prompt
 * (the app-password design notes §5, §6).
 *
 * The rule these tests exist to hold: NONE of this appears for a user who has
 * not set an app password. The lock screen they see is the one they have always
 * seen, and the app lock screen is never rendered at all.
 *
 * The wallet service is stubbed (neither screen talks to a chain) and the
 * store's actions are replaced per test and restored after, because the store is
 * a module singleton.
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
    appUnlocked() {
      return false;
    }
    lockApp() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({}),
}));

import { LiveAppLock } from './LiveAppLock';
import { LiveLock } from './LiveLock';
import { useLiveStore } from '../../store/liveStore';
import type { WalletSummary } from '../../services/chain/liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

const state = () => useLiveStore.getState();

function wallet(over: Partial<WalletSummary> & { id: string }): WalletSummary {
  return {
    name: 'My Evrmore',
    network: 'mainnet',
    createdAt: 1,
    active: true,
    kind: 'seed',
    address: 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU',
    passwordless: false,
    family: 'utxo',
    ...over,
  } as WalletSummary;
}

const realActions = {
  unlock: state().unlock,
  unlockApp: state().unlockApp,
  switchWallet: state().switchWallet,
  loadWallets: state().loadWallets,
  openWithWalletPassword: state().openWithWalletPassword,
  showAppLock: state().showAppLock,
  lock: state().lock,
};

function seed(over: Partial<ReturnType<typeof state>> = {}) {
  useLiveStore.setState({
    wallets: [wallet({ id: 'w-1' })],
    activeWalletId: 'w-1',
    phase: 'locked',
    appPasswordSet: false,
    appUnlocked: false,
    error: null,
    unlock: vi.fn(async () => true),
    unlockApp: vi.fn(async () => true),
    switchWallet: vi.fn(async () => {}),
    loadWallets: vi.fn(async () => {}),
    openWithWalletPassword: vi.fn(async () => true),
    showAppLock: vi.fn(() => {}),
    lock: vi.fn(() => {}),
    ...over,
  });
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

afterEach(() => {
  useLiveStore.setState({
    ...realActions,
    wallets: [],
    activeWalletId: null,
    error: null,
    appPasswordSet: false,
    appUnlocked: false,
  });
  cleanup();
});

// ---------------------------------------------------------------------------
// The app lock screen
// ---------------------------------------------------------------------------

describe('LiveAppLock', () => {
  it('asks for ONE password and names no wallet: the app is what it gates', () => {
    seed({ appPasswordSet: true, wallets: [wallet({ id: 'w-1' }), wallet({ id: 'w-2', name: 'Savings' })] });
    render(<LiveAppLock />);

    expect(screen.getByTestId('live-app-lock')).toBeInTheDocument();
    expect(screen.getByTestId('live-app-unlock')).toBeInTheDocument();
    // No wallet card, no wallet picker: choosing a wallet comes AFTER this.
    expect(screen.queryByTestId('live-lock-selected')).toBeNull();
    expect(screen.queryByTestId('live-lock-wallets')).toBeNull();
    expect(screen.queryByTestId('live-lock-change')).toBeNull();
    // The line under the name is a tagline (owner, 2026-08-26), so it is shown
    // whatever the wallet count is and says nothing about a wallet.
    expect(screen.getByTestId('live-app-lock-sub')).toHaveTextContent('The future is here');
  });

  it('submits the password to unlockApp', async () => {
    seed({ appPasswordSet: true });
    render(<LiveAppLock />);
    fireEvent.change(screen.getByTestId('live-app-unlock'), { target: { value: 'the app password' } });
    fireEvent.click(screen.getByRole('button', { name: /^Unlock$/i }));
    await waitFor(() => expect(state().unlockApp).toHaveBeenCalledWith('the app password'));
  });

  it('keeps the existing failure copy on a wrong password and clears the field', async () => {
    seed({ appPasswordSet: true, unlockApp: vi.fn(async () => false) });
    render(<LiveAppLock />);
    const field = screen.getByTestId('live-app-unlock') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^Unlock$/i }));
    await waitFor(() => expect(screen.getByText('Incorrect password. Try again.')).toBeInTheDocument());
    expect(field.value).toBe('');
  });

  it('refuses an empty submission without calling the store', async () => {
    seed({ appPasswordSet: true });
    render(<LiveAppLock />);
    fireEvent.click(screen.getByRole('button', { name: /^Unlock$/i }));
    await waitFor(() => expect(screen.getByText('Enter your password.')).toBeInTheDocument());
    expect(state().unlockApp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The transitional per-wallet prompt on the ordinary lock screen
// ---------------------------------------------------------------------------

describe('LiveLock: the transitional prompt', () => {
  it('is ABSENT when no app password is set (the unchanged flow)', () => {
    seed({ appPasswordSet: false });
    render(<LiveLock />);
    expect(screen.queryByTestId('live-lock-migrate-note')).toBeNull();
    expect(screen.queryByTestId('live-lock-keep-own-password')).toBeNull();
  });

  it('is absent for a wallet that has ALREADY moved to the app password', () => {
    seed({
      appPasswordSet: true,
      appUnlocked: true,
      wallets: [wallet({ id: 'w-1', appProtected: true })],
    });
    render(<LiveLock />);
    expect(screen.queryByTestId('live-lock-migrate-note')).toBeNull();
  });

  it('explains the move for a wallet still on its own password, and migrates by default', async () => {
    seed({ appPasswordSet: true, appUnlocked: true });
    render(<LiveLock />);

    const note = screen.getByTestId('live-lock-migrate-note');
    expect(note).toHaveTextContent('this wallet moves to your app password');
    // No em-dash anywhere in the copy (the repo's copy rule).
    expect(note.textContent ?? '').not.toContain('—');

    fireEvent.change(screen.getByTestId('live-unlock'), { target: { value: 'its own password' } });
    fireEvent.click(screen.getByRole('button', { name: /^Unlock$/i }));
    await waitFor(() =>
      expect(state().unlock).toHaveBeenCalledWith('its own password', { migrate: true }),
    );
  });

  it('lets the user DECLINE and stay on the wallet\'s own password', async () => {
    seed({ appPasswordSet: true, appUnlocked: true });
    render(<LiveLock />);

    fireEvent.click(screen.getByTestId('live-lock-keep-own-password'));
    fireEvent.change(screen.getByTestId('live-unlock'), { target: { value: 'its own password' } });
    fireEvent.click(screen.getByRole('button', { name: /^Unlock$/i }));
    await waitFor(() =>
      expect(state().unlock).toHaveBeenCalledWith('its own password', { migrate: false }),
    );
  });

  it('tells a PASSWORDLESS wallet what will change and offers both answers (§6)', async () => {
    seed({
      appPasswordSet: true,
      appUnlocked: true,
      wallets: [wallet({ id: 'w-1', passwordless: true })],
    });
    render(<LiveLock />);

    expect(screen.getByTestId('live-lock-migrate-note')).toHaveTextContent(
      'your app password will protect it from then on',
    );
    // Declining is one click away, not buried.
    fireEvent.click(screen.getByTestId('live-lock-open-keep-v1'));
    await waitFor(() => expect(state().unlock).toHaveBeenCalledWith('', { migrate: false }));

    (state().unlock as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(screen.getByTestId('live-lock-open-passwordless'));
    await waitFor(() => expect(state().unlock).toHaveBeenCalledWith('', { migrate: true }));
  });

  it('a passwordless wallet with NO app password keeps its single, unchanged button', async () => {
    seed({ appPasswordSet: false, wallets: [wallet({ id: 'w-1', passwordless: true })] });
    render(<LiveLock />);
    expect(screen.queryByTestId('live-lock-open-keep-v1')).toBeNull();
    expect(screen.getByTestId('live-lock-open-passwordless')).toHaveTextContent('Open wallet');
    fireEvent.click(screen.getByTestId('live-lock-open-passwordless'));
    await waitFor(() => expect(state().unlock).toHaveBeenCalledWith('', { migrate: false }));
  });
});

// ---------------------------------------------------------------------------
// What an adversarial review found MISSING from these two screens.
// ---------------------------------------------------------------------------

describe('LiveAppLock: the way through to a wallet that never migrated (§4 rule 5)', () => {
  it('offers it while a still-v1 wallet exists, and hands over to that wallet', async () => {
    seed({
      appPasswordSet: true,
      wallets: [wallet({ id: 'w-1', appProtected: true }), wallet({ id: 'w-2', name: 'Savings' })],
    });
    render(<LiveAppLock />);

    // The design's rule is that a wallet whose own password still works is
    // never unreachable. This screen was the exact inverse of it: one field,
    // no list, and a forgotten app password locked the user out of a wallet it
    // had nothing to do with.
    const way = screen.getByTestId('live-app-lock-use-wallet-password');
    expect(screen.getByTestId('live-app-lock-own-password')).toHaveTextContent(
      'One wallet has not moved to your app password yet',
    );
    fireEvent.click(way);
    await waitFor(() => expect(state().openWithWalletPassword).toHaveBeenCalled());
  });

  it('is ABSENT once every wallet has moved over', () => {
    seed({
      appPasswordSet: true,
      wallets: [wallet({ id: 'w-1', appProtected: true }), wallet({ id: 'w-2', appProtected: true })],
    });
    render(<LiveAppLock />);
    expect(screen.queryByTestId('live-app-lock-own-password')).toBeNull();
    expect(screen.queryByTestId('live-app-lock-use-wallet-password')).toBeNull();
  });

  it('counts the wallets it is talking about', () => {
    seed({
      appPasswordSet: true,
      wallets: [wallet({ id: 'w-1' }), wallet({ id: 'w-2', name: 'Savings' })],
    });
    render(<LiveAppLock />);
    const note = screen.getByTestId('live-app-lock-own-password');
    expect(note).toHaveTextContent('2 wallets have not moved to your app password yet');
    expect(note.textContent ?? '').not.toContain('—'); // the repo's copy rule
  });
});

describe('LiveLock: a screen that says "Locked" can now actually lock', () => {
  it('offers a Lock button while the APP is still unlocked behind it', async () => {
    seed({ appPasswordSet: true, appUnlocked: true });
    render(<LiveLock />);

    // phase 'locked' with the master key in memory: the wallet is locked and
    // the app is not. There was no way to say so and no way to undo it, because
    // the header lock button lives on the wallet screen, which is not showing.
    expect(screen.getByTestId('live-lock-app-state')).toHaveTextContent(
      'Your app password is still open in this window',
    );
    fireEvent.click(screen.getByTestId('live-lock-lock-app'));
    await waitFor(() => expect(state().lock).toHaveBeenCalled());
    expect(screen.queryByTestId('live-lock-back-to-app-lock')).toBeNull();
  });

  it('offers the way BACK to the app lock screen when the app is locked', async () => {
    seed({ appPasswordSet: true, appUnlocked: false });
    render(<LiveLock />);
    expect(screen.queryByTestId('live-lock-lock-app')).toBeNull();
    fireEvent.click(screen.getByTestId('live-lock-back-to-app-lock'));
    await waitFor(() => expect(state().showAppLock).toHaveBeenCalled());
  });

  it('shows neither on an install with no app password (the unchanged screen)', () => {
    seed({ appPasswordSet: false });
    render(<LiveLock />);
    expect(screen.queryByTestId('live-lock-app-state')).toBeNull();
    expect(screen.queryByTestId('live-lock-lock-app')).toBeNull();
    expect(screen.queryByTestId('live-lock-back-to-app-lock')).toBeNull();
  });

  it('does NOT promise a move while the app is locked (the escape-hatch route)', () => {
    // Reached from the app lock screen's "Use a wallet's own password": there is
    // no master key, so nothing can migrate. Promising it would be exactly the
    // lie the seed-group defect told for months.
    seed({ appPasswordSet: true, appUnlocked: false });
    render(<LiveLock />);
    expect(screen.queryByTestId('live-lock-migrate-note')).toBeNull();
    expect(screen.queryByTestId('live-lock-keep-own-password')).toBeNull();
  });

  it('a passwordless wallet reached that way gets ONE plain Open button', () => {
    seed({
      appPasswordSet: true,
      appUnlocked: false,
      wallets: [wallet({ id: 'w-1', passwordless: true })],
    });
    render(<LiveLock />);
    expect(screen.getByTestId('live-lock-open-passwordless')).toHaveTextContent('Open wallet');
    expect(screen.queryByTestId('live-lock-open-keep-v1')).toBeNull();
    expect(screen.queryByTestId('live-lock-migrate-send-note')).toBeNull();
  });
});

describe('LiveLock: "sends without a password" is visible again (§6)', () => {
  it('badges a migrated wallet that still spends with nothing typed', () => {
    seed({
      appPasswordSet: true,
      appUnlocked: true,
      wallets: [wallet({ id: 'w-1', appProtected: true, noSendPassword: true })],
    });
    render(<LiveLock />);
    // The "No pw" badge belongs to `passwordless`, which the migration clears,
    // so this wallet used to show no badge at all while still sending freely.
    expect(screen.getByTestId('live-lock-selected-no-send-pw')).toHaveTextContent(
      'Sends without pw',
    );
  });

  it('does not badge a wallet that does ask', () => {
    seed({
      appPasswordSet: true,
      appUnlocked: true,
      wallets: [wallet({ id: 'w-1', appProtected: true })],
    });
    render(<LiveLock />);
    expect(screen.queryByTestId('live-lock-selected-no-send-pw')).toBeNull();
  });

  it('the transitional prompt SAYS a passwordless wallet keeps sending freely', () => {
    seed({
      appPasswordSet: true,
      appUnlocked: true,
      wallets: [wallet({ id: 'w-1', passwordless: true })],
    });
    render(<LiveLock />);
    const note = screen.getByTestId('live-lock-migrate-send-note');
    expect(note).toHaveTextContent('Sending from it will still not ask for a password');
    expect(note.textContent ?? '').not.toContain('—');
  });
});
