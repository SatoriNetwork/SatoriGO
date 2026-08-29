/**
 * @vitest-environment jsdom
 *
 * Setting a BIP39 passphrase while CREATING a wallet (KNOWN_LIMITATIONS #16).
 *
 * Everything here is about the two ways this feature destroys funds rather than
 * about the feature working:
 *
 *   - setting one BY ACCIDENT. Someone who does not know what a passphrase is
 *     must not be able to end up with one, so it is off by default, hidden until
 *     an explicit opt-in, and cleared if that opt-in is switched back off.
 *
 *   - MISTYPING one. There is no wrong-passphrase error to hit, ever: a typo
 *     silently mints a different wallet at a different address that the recovery
 *     phrase alone will never reopen, and the mistyped string is never written
 *     down anywhere. The confirmation field is the only defence that can exist,
 *     so a mismatch must REFUSE, not warn.
 *
 * Plus the recovery-phrase screen, which tells the user the words are "the ONLY
 * backup" and must not say that about a wallet where they are not.
 *
 * The store action is replaced with a spy, so these assert what the FORM does
 * without building a real scrypt vault (the derivation itself is pinned in
 * services/chain/liveWallet.createPassphrase.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    async exists() {
      return false;
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
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { LiveOnboarding } from './LiveOnboarding';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

const PASSPHRASE = 'correct horse battery staple';
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let createSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  createSpy = vi.fn(async () => {});
  useLiveStore.setState({
    createWallet: createSpy,
    pendingMnemonic: null,
    pendingMnemonicHasPassphrase: false,
    addingWallet: false,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function byId(id: string): HTMLElement {
  return screen.getByTestId(id);
}

/** Render the onboarding screen and walk to the create form. */
function openCreateForm() {
  render(<LiveOnboarding />);
  fireEvent.click(screen.getByText('Create new wallet'));
  return byId('live-create');
}

/** Fill a valid wallet-password pair, so nothing but the passphrase can block. */
function fillPassword() {
  fireEvent.change(byId('live-password'), { target: { value: 'password123' } });
  fireEvent.change(byId('live-password-confirm'), { target: { value: 'password123' } });
}

/** The BIP39 passphrase argument createWallet was called with. */
function passphraseArg(): unknown {
  expect(createSpy).toHaveBeenCalledTimes(1);
  return createSpy.mock.calls[0][3];
}

describe('create form: the BIP39 passphrase opt-in', () => {
  it('is OFF by default, with no field to type into and no passphrase sent', () => {
    openCreateForm();
    expect(screen.queryByTestId('live-create-passphrase')).toBeNull();
    expect(screen.queryByTestId('live-create-passphrase-warning')).toBeNull();
    expect(byId('live-create-passphrase-optin')).toHaveAttribute('aria-checked', 'false');

    fillPassword();
    fireEvent.click(byId('live-create-submit'));
    expect(passphraseArg()).toBe('');
  });

  it('reveals two fields and the warning only after the explicit opt-in', () => {
    openCreateForm();
    fireEvent.click(byId('live-create-passphrase-optin'));

    expect(byId('live-create-passphrase-optin')).toHaveAttribute('aria-checked', 'true');
    expect(byId('live-create-passphrase')).toBeTruthy();
    expect(byId('live-create-passphrase-confirm')).toBeTruthy();

    // The three things the user has to be told, in the warning next to the field.
    const warning = byId('live-create-passphrase-warning').textContent ?? '';
    expect(warning).toContain('recovery phrase alone will no longer restore this wallet');
    expect(warning).toContain('Nobody, including us, can recover it');
    // ...and the limitation this feature does NOT escape, said out loud.
    expect(byId('live-create').textContent).toContain(
      'does not give you the deniability a passphrase kept outside the wallet would',
    );
  });

  it('REFUSES to create when the two passphrases differ', () => {
    // The single most important assertion in this file. A mismatch that slipped
    // through would create a wallet at an address the recovery phrase does not
    // reach, with nothing on screen to say so.
    openCreateForm();
    fireEvent.click(byId('live-create-passphrase-optin'));
    fireEvent.change(byId('live-create-passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.change(byId('live-create-passphrase-confirm'), { target: { value: `${PASSPHRASE} ` } });
    fillPassword();
    fireEvent.click(byId('live-create-submit'));

    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Passphrases do not match.');
  });

  it('REFUSES an empty passphrase rather than quietly creating a plain wallet', () => {
    // Silently treating this as "no passphrase" would leave the user believing
    // they had one, and looking for it on every future restore.
    openCreateForm();
    fireEvent.click(byId('live-create-passphrase-optin'));
    fillPassword();
    fireEvent.click(byId('live-create-submit'));

    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      'Enter a passphrase, or switch this option back off.',
    );
  });

  it('checks the passphrase BEFORE the wallet password, so the fatal error is the one shown', () => {
    // A password complaint is recoverable noise; the passphrase mismatch is the
    // one mistake on this form that cannot be undone afterwards.
    openCreateForm();
    fireEvent.click(byId('live-create-passphrase-optin'));
    fireEvent.change(byId('live-create-passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.change(byId('live-create-passphrase-confirm'), { target: { value: 'something else' } });
    fireEvent.change(byId('live-password'), { target: { value: 'short' } });
    fireEvent.click(byId('live-create-submit'));

    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Passphrases do not match.');
  });

  it('sends the passphrase through when both fields match', () => {
    openCreateForm();
    fireEvent.click(byId('live-create-passphrase-optin'));
    fireEvent.change(byId('live-create-passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.change(byId('live-create-passphrase-confirm'), { target: { value: PASSPHRASE } });
    fillPassword();
    fireEvent.click(byId('live-create-submit'));

    expect(passphraseArg()).toBe(PASSPHRASE);
  });

  it('switching the opt-in back OFF forgets what was typed', () => {
    // The reason this is a controlled checkbox rather than a <details>: a
    // collapsed disclosure keeps its contents, so a user could believe they had
    // cancelled and still get a passphrase wallet.
    openCreateForm();
    fireEvent.click(byId('live-create-passphrase-optin'));
    fireEvent.change(byId('live-create-passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.change(byId('live-create-passphrase-confirm'), { target: { value: PASSPHRASE } });
    fireEvent.click(byId('live-create-passphrase-optin'));

    fillPassword();
    fireEvent.click(byId('live-create-submit'));
    expect(passphraseArg()).toBe('');

    // And re-opening it shows empty fields, not the old value.
    fireEvent.click(byId('live-create-passphrase-optin'));
    expect(byId('live-create-passphrase')).toHaveValue('');
    expect(byId('live-create-passphrase-confirm')).toHaveValue('');
  });

  it('says something different about storage when the wallet has no password', () => {
    // "under your wallet password" is simply untrue when there is not one.
    openCreateForm();
    fireEvent.click(byId('live-create-passphrase-optin'));
    expect(byId('live-create').textContent).toContain('under your wallet password');

    fireEvent.click(byId('live-no-password'));
    const text = byId('live-create').textContent ?? '';
    expect(text).not.toContain('under your wallet password');
    expect(text).toContain('with no wallet password anyone using this browser can read both');
  });
});

describe('recovery-phrase screen: what it calls the backup', () => {
  it('calls the words the ONLY backup for an ordinary wallet', () => {
    useLiveStore.setState({ pendingMnemonic: VECTOR_MNEMONIC, pendingMnemonicHasPassphrase: false });
    render(<LiveOnboarding />);

    expect(byId('live-mnemonic-warning').textContent).toContain('It is the ONLY backup.');
    expect(byId('live-mnemonic-saved').textContent).toBe(
      'I have written down my recovery phrase and stored it safely.',
    );
  });

  it('does NOT, for a wallet created with a passphrase, because there it is false', () => {
    useLiveStore.setState({ pendingMnemonic: VECTOR_MNEMONIC, pendingMnemonicHasPassphrase: true });
    render(<LiveOnboarding />);

    const warning = byId('live-mnemonic-warning').textContent ?? '';
    expect(warning).not.toContain('ONLY backup');
    expect(warning).toContain('This phrase alone will NOT restore this wallet.');
    expect(warning).toContain('needs the phrase and that passphrase together');
    // The acknowledgement is part of the same claim, so it moves with it.
    expect(byId('live-mnemonic-saved').textContent).toBe(
      'I have written down my recovery phrase and my passphrase, and stored them safely.',
    );
    // The words themselves are still shown; only what is said about them changed.
    expect(byId('live-mnemonic').textContent).toContain('abandon');
  });
});
