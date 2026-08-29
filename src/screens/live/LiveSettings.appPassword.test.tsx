/**
 * @vitest-environment jsdom
 *
 * Settings > Security: the app password card (the app-password design notes §5).
 *
 * Real store, REAL LiveWalletService and real scrypt, because the thing being
 * checked is that this screen actually sets an app password and that the wallet
 * it was set from is untouched by it. A WebSocket that refuses to connect keeps
 * every read off the network.
 *
 * The rule this file holds down hardest: an install with no app password sees a
 * card that says "Off" and one button, and everything else on the screen is what
 * it has always been.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/prices', () => ({ fetchPrices: async () => ({}) }));

import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import { NavProvider } from './LiveNav';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

/** Every assertion that follows a click which runs a REAL scrypt (N=2^17, ~128
 *  MB) waits this long. waitFor's 1 s default is far too short for it under the
 *  full suite's parallel load. Do NOT lower the KDF to make this quicker. */
const SCRYPT_WAIT = 25_000;

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PW = 'wallet-password-one';
const APP_PW = 'one password for the whole wallet';

type LiveStoreModule = typeof import('../../store/liveStore');
let storeMod: LiveStoreModule;
let LiveSettings: (typeof import('./LiveSettings'))['LiveSettings'];
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = {
  tab: 'assets' as const,
  section: 'settings' as const,
  openTab: () => {},
  openSettings: () => {},
};

function openSecuritySection() {
  render(
    <NavProvider value={NAV_VALUE}>
      <LiveSettings onBack={() => {}} onOpenAddressBook={() => {}} />
    </NavProvider>,
  );
  fireEvent.click(screen.getByTestId('live-settings-row-security'));
}

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  LiveSettings = (await import('./LiveSettings')).LiveSettings;
});

beforeEach(async () => {
  setStorageForTests(new MemoryStorageAdapter());
  await state().resetLiveWallet();
  await state().init();
});

afterEach(() => {
  state().stopAutoRefresh();
  cleanup();
});

describe('Settings > Security: the app password', () => {
  it('reads Off, and setting it states the loss risk and that removal is unsupported', async () => {
    await state().importWallet(VECTOR_MNEMONIC, WALLET_PW, 'EVR', 'mainnet');
    await state().loadWallets();
    openSecuritySection();

    const card = screen.getByTestId('live-app-password-card');
    expect(screen.getByTestId('live-app-password-chip')).toHaveTextContent('Off');
    expect(screen.getByTestId('live-app-password-state')).toHaveTextContent(
      'Each wallet moves over the next time you open it with its current password',
    );
    // The repo's copy rule: no em-dash in any user-facing string.
    expect(card.textContent ?? '').not.toContain('—');
    // Nothing is said about the risk until the user opens the form.
    expect(screen.queryByTestId('live-app-password-warning')).toBeNull();

    fireEvent.click(screen.getByTestId('live-app-password-open'));

    // BEFORE the password is set, not after.
    expect(screen.getByTestId('live-app-password-warning')).toHaveTextContent(
      'can only be restored from their recovery phrases',
    );
    expect(screen.getByTestId('live-app-password-no-removal')).toHaveTextContent(
      'Removing the app password is not supported in this release',
    );
    // Setting one asks for no CURRENT password: there is none yet.
    expect(screen.queryByTestId('live-app-pw-current')).toBeNull();
  }, 60_000);

  it('rejects a short or mismatched password without touching anything', async () => {
    await state().importWallet(VECTOR_MNEMONIC, WALLET_PW, 'EVR', 'mainnet');
    await state().loadWallets();
    openSecuritySection();
    fireEvent.click(screen.getByTestId('live-app-password-open'));

    fireEvent.change(screen.getByTestId('live-app-pw-new'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByTestId('live-app-pw-confirm'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('live-app-pw-submit'));
    await waitFor(() => expect(screen.getByTestId('live-app-pw-error')).toHaveTextContent('at least'), {
      timeout: SCRYPT_WAIT,
    });
    expect(state().appPasswordSet).toBe(false);

    fireEvent.change(screen.getByTestId('live-app-pw-new'), { target: { value: APP_PW } });
    fireEvent.change(screen.getByTestId('live-app-pw-confirm'), { target: { value: 'something else' } });
    fireEvent.click(screen.getByTestId('live-app-pw-submit'));
    await waitFor(() => expect(screen.getByTestId('live-app-pw-error')).toHaveTextContent('do not match'), {
      timeout: SCRYPT_WAIT,
    });
    expect(state().appPasswordSet).toBe(false);
  }, 60_000);

  it('sets it, flips the chip to On, and MIGRATES NOTHING', async () => {
    await state().importWallet(VECTOR_MNEMONIC, WALLET_PW, 'EVR', 'mainnet');
    await state().loadWallets();
    const before = JSON.parse(JSON.stringify(state().wallets));
    openSecuritySection();

    fireEvent.click(screen.getByTestId('live-app-password-open'));
    fireEvent.change(screen.getByTestId('live-app-pw-new'), { target: { value: APP_PW } });
    fireEvent.change(screen.getByTestId('live-app-pw-confirm'), { target: { value: APP_PW } });
    fireEvent.click(screen.getByTestId('live-app-pw-submit'));

    // A REAL scrypt at N=2^17 runs behind this click, and under full-suite load
    // that is seconds, not milliseconds: waitFor's 1 s default would flake.
    await waitFor(() => expect(state().appPasswordSet).toBe(true), { timeout: SCRYPT_WAIT });
    await waitFor(() => expect(screen.getByTestId('live-app-password-chip')).toHaveTextContent('On'), {
      timeout: SCRYPT_WAIT,
    });
    expect(screen.getByTestId('live-app-pw-success')).toHaveTextContent(
      'moves over the next time you open it',
    );
    // §5: nothing migrated. The wallet is byte for byte what it was, and it is
    // still opened by its own password.
    expect(JSON.parse(JSON.stringify(state().wallets))).toEqual(before);
    expect(state().wallets[0].appProtected).toBeUndefined();
    // The session stays open: setting a password is not a lock.
    expect(state().phase).toBe('ready');
  }, 90_000);

  it('once set, the form asks for the CURRENT app password and says what a change costs', async () => {
    await state().importWallet(VECTOR_MNEMONIC, WALLET_PW, 'EVR', 'mainnet');
    await state().loadWallets();
    await state().setAppPassword(APP_PW);
    openSecuritySection();

    expect(screen.getByTestId('live-app-password-chip')).toHaveTextContent('On');
    expect(screen.getByTestId('live-app-password-open')).toHaveTextContent('Change app password');
    fireEvent.click(screen.getByTestId('live-app-password-open'));

    expect(screen.getByTestId('live-app-pw-current')).toBeInTheDocument();
    // No loss warning on a CHANGE: the password already exists, and the warning
    // belongs where the decision is made.
    expect(screen.queryByTestId('live-app-password-warning')).toBeNull();
    expect(screen.getByTestId('live-app-password-card').textContent).toContain(
      'Wallets that have not moved over keep their own passwords',
    );

    // A wrong current password is refused, and the session is left alone.
    fireEvent.change(screen.getByTestId('live-app-pw-current'), { target: { value: 'not it' } });
    fireEvent.change(screen.getByTestId('live-app-pw-new'), { target: { value: 'a brand new app password' } });
    fireEvent.change(screen.getByTestId('live-app-pw-confirm'), { target: { value: 'a brand new app password' } });
    fireEvent.click(screen.getByTestId('live-app-pw-submit'));
    await waitFor(
      () => expect(screen.getByTestId('live-app-pw-error')).toHaveTextContent('Incorrect current password'),
      { timeout: SCRYPT_WAIT },
    );
    expect(state().phase).toBe('ready');
  }, 120_000);

  it('a MIGRATED wallet shows no per-wallet password form, only what opens it', async () => {
    await state().importWallet(VECTOR_MNEMONIC, WALLET_PW, 'EVR', 'mainnet');
    await state().setAppPassword(APP_PW);
    // Open it once with its own password: that is what moves it.
    state().lock();
    await state().unlockApp(APP_PW);
    await state().unlock(WALLET_PW, { migrate: true });
    await state().loadWallets();
    expect(state().wallets[0].appProtected).toBe(true);

    openSecuritySection();
    expect(screen.getByTestId('live-wallet-pw-app-managed')).toHaveTextContent(
      'opened by your app password',
    );
    // The per-wallet change form is gone: there is no wallet password to change.
    expect(screen.queryByTestId('live-change-pw-submit')).toBeNull();
    expect(screen.queryByTestId('live-change-pw-old')).toBeNull();
  }, 150_000);

  it('leaves the per-wallet password form exactly as it was when no app password is set', async () => {
    await state().importWallet(VECTOR_MNEMONIC, WALLET_PW, 'EVR', 'mainnet');
    await state().loadWallets();
    openSecuritySection();
    expect(screen.getByTestId('live-change-pw-old')).toBeInTheDocument();
    expect(screen.getByTestId('live-change-pw-new')).toBeInTheDocument();
    expect(screen.getByTestId('live-change-pw-submit')).toHaveTextContent('Update password');
    expect(screen.queryByTestId('live-wallet-pw-app-managed')).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §6's convenience half, made visible and reversible.
// ---------------------------------------------------------------------------

describe('Settings > Security: "do not ask when sending" after a passwordless wallet migrates', () => {
  it('shows it, and turning it off makes a send require the app password', async () => {
    // A passwordless wallet, then an app password, then the one unlock that
    // moves it: §6 keeps "do not ask when sending" and clears `passwordless`.
    await state().importWallet(VECTOR_MNEMONIC, '', 'EVR', 'mainnet');
    await state().setAppPassword(APP_PW);
    state().lock();
    await state().unlockApp(APP_PW);
    await state().unlock('', { migrate: true });
    await state().loadWallets();
    expect(state().wallets[0].appProtected).toBe(true);
    expect(state().wallets[0].noSendPassword).toBe(true);

    openSecuritySection();
    const toggle = screen.getByTestId('live-set-send-password');
    // The badge that used to say "No pw" belongs to `passwordless`, which the
    // migration clears, so this property had NO surface at all and no way off.
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('live-wallet-pw-app-managed').textContent).toContain(
      'Sends from this wallet go through with nothing typed',
    );

    fireEvent.click(toggle);
    await waitFor(() => expect(state().wallets[0].noSendPassword).toBeUndefined(), {
      timeout: SCRYPT_WAIT,
    });
    // The pre-broadcast gate now actually gates.
    expect(await state().verifyPassword('not the app password')).toBe(false);
    expect(await state().verifyPassword(APP_PW)).toBe(true);
  }, 200_000);

  it('a migrated wallet that always had a password shows the switch already on', async () => {
    await state().importWallet(VECTOR_MNEMONIC, WALLET_PW, 'EVR', 'mainnet');
    await state().setAppPassword(APP_PW);
    state().lock();
    await state().unlockApp(APP_PW);
    await state().unlock(WALLET_PW, { migrate: true });
    await state().loadWallets();

    openSecuritySection();
    expect(screen.getByTestId('live-set-send-password')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('live-wallet-pw-app-managed').textContent).toContain(
      'Your app password is required before a send is broadcast',
    );
  }, 200_000);

  it('turning the send check OFF costs the app password and the risk acknowledgement', async () => {
    // A wallet that was NEVER passwordless: nothing about it ever implied
    // "spendable with nothing typed", so switching that on is a decision.
    await state().importWallet(VECTOR_MNEMONIC, WALLET_PW, 'EVR', 'mainnet');
    await state().setAppPassword(APP_PW);
    state().lock();
    await state().unlockApp(APP_PW);
    await state().unlock(WALLET_PW, { migrate: true });
    await state().loadWallets();

    openSecuritySection();
    const toggle = screen.getByTestId('live-set-send-password');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // No form until it is asked for.
    expect(screen.queryByTestId('live-send-password-form')).toBeNull();

    fireEvent.click(toggle);
    // The switch has NOT moved: it never shows a state that is not real.
    expect(screen.getByTestId('live-set-send-password')).toHaveAttribute('aria-checked', 'true');
    expect(state().wallets[0].noSendPassword).toBeUndefined();
    expect(screen.getByTestId('live-send-password-form')).toBeInTheDocument();

    // The password alone is not enough: the same acknowledgement the v1 route to
    // this state (a password removed with changePassword) has always required.
    fireEvent.change(screen.getByTestId('live-send-password-current'), {
      target: { value: APP_PW },
    });
    fireEvent.click(screen.getByTestId('live-send-password-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('live-send-password-error')).toHaveTextContent(
        'Check the box to confirm you understand the risk.',
      ),
    );
    expect(state().wallets[0].noSendPassword).toBeUndefined();

    // The acknowledgement alone is not enough either: a WRONG password is
    // refused by the service, which re-derives it exactly as the send gate does.
    fireEvent.click(screen.getByTestId('live-send-password-ack'));
    fireEvent.change(screen.getByTestId('live-send-password-current'), {
      target: { value: 'not the app password' },
    });
    fireEvent.click(screen.getByTestId('live-send-password-submit'));
    await waitFor(
      () =>
        expect(screen.getByTestId('live-send-password-error')).toHaveTextContent(
          'Incorrect app password.',
        ),
      { timeout: SCRYPT_WAIT },
    );
    expect(state().wallets[0].noSendPassword).toBeUndefined();
    expect(await state().verifyPassword('not the app password')).toBe(false);

    // Both together, and only then.
    fireEvent.change(screen.getByTestId('live-send-password-current'), {
      target: { value: APP_PW },
    });
    fireEvent.click(screen.getByTestId('live-send-password-submit'));
    await waitFor(() => expect(state().wallets[0].noSendPassword).toBe(true), {
      timeout: SCRYPT_WAIT,
    });
    await waitFor(() => expect(screen.queryByTestId('live-send-password-form')).toBeNull());
    expect(screen.getByTestId('live-set-send-password')).toHaveAttribute('aria-checked', 'false');
  }, 300_000);

  it('is absent on a wallet that never migrated (there the flag IS `passwordless`)', async () => {
    await state().importWallet(VECTOR_MNEMONIC, WALLET_PW, 'EVR', 'mainnet');
    await state().loadWallets();
    openSecuritySection();
    expect(screen.queryByTestId('live-set-send-password')).toBeNull();
  }, 60_000);
});
