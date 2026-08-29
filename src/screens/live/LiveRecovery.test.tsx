/**
 * @vitest-environment jsdom
 *
 * THE RECOVERY SURFACE (the app-password design notes §13).
 *
 * These screens hand out, and accept, things that open a wallet without its
 * password. So the tests here are mostly about what must be SAID and what must
 * NOT be reachable:
 *
 *   * the code is shown once, and the screen showing it says plainly that it is
 *     a second key rather than a convenience;
 *   * "Done" is not available until the user says they wrote it down;
 *   * a restore names, by name, the wallets it would destroy, BEFORE the button
 *     that destroys them;
 *   * merge is offered only when the service says the two sides share a record;
 *   * nothing at all is offered without an app password to recover to.
 *
 * The store is a module singleton, so its actions are replaced per test and
 * restored afterwards.
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
      return true;
    }
    async hasRecoveryCode() {
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

import { RecoverySettings, AppRecoverPanel } from './LiveRecovery';
import { useLiveStore } from '../../store/liveStore';
import type { BackupPreview } from '../../services/chain/liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

const state = () => useLiveStore.getState();

const CODE = 'K7QM-4T1B-9XYZ-2WVT-5N3P-8HJD-6RSG-QM4A';

const realActions = {
  createRecoveryCode: state().createRecoveryCode,
  removeRecoveryCode: state().removeRecoveryCode,
  unlockWithRecoveryCode: state().unlockWithRecoveryCode,
  exportBackup: state().exportBackup,
  readBackupFile: state().readBackupFile,
  applyRestore: state().applyRestore,
  cancelRestore: state().cancelRestore,
};

function preview(over: Partial<BackupPreview> = {}): BackupPreview {
  return {
    createdAt: '2026-08-26T10:00:00.000Z',
    wallets: [{ id: 'w-1', name: 'My savings', network: 'mainnet', address: 'E1' }],
    losing: [],
    gaining: 1,
    canMerge: false,
    deviceEmpty: true,
    ...over,
  };
}

function seed(over: Partial<ReturnType<typeof state>> = {}) {
  useLiveStore.setState({
    appPasswordSet: true,
    recoveryCodeSet: false,
    createRecoveryCode: vi.fn(async () => ({ ok: true as const, code: CODE })),
    removeRecoveryCode: vi.fn(async () => ({ ok: true })),
    unlockWithRecoveryCode: vi.fn(async () => ({ ok: true })),
    exportBackup: vi.fn(async () => ({
      ok: true as const,
      text: '{}',
      fileName: 'satori-go-backup-2026-08-26.json',
    })),
    readBackupFile: vi.fn(async () => ({ ok: true as const, preview: preview() })),
    applyRestore: vi.fn(async () => ({ ok: true })),
    cancelRestore: vi.fn(() => {}),
    ...over,
  });
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  // jsdom has neither, and the download helper uses both.
  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
  }
});

afterEach(() => {
  useLiveStore.setState({ ...realActions, appPasswordSet: false, recoveryCodeSet: false });
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The section as a whole
// ---------------------------------------------------------------------------

describe('recovery settings: what is offered', () => {
  it('offers nothing to recover to without an app password, and says why', () => {
    seed({ appPasswordSet: false });
    render(<RecoverySettings />);
    expect(screen.getByTestId('live-rec-needs-app-password')).toBeTruthy();
    expect(screen.queryByTestId('live-rec-code-card')).toBeNull();
    expect(screen.queryByTestId('live-rec-backup-card')).toBeNull();
  });

  it('always states the floor: no code, no file, no reset we could send', () => {
    seed();
    render(<RecoverySettings />);
    const note = screen.getByTestId('live-rec-phrase-note').textContent ?? '';
    expect(note).toMatch(/recovery phrase/i);
    // The promise nobody can make must not be implied by omission.
    expect(note).toMatch(/no reset we could send/i);
  });

  it('reads Off before a code exists and On after', () => {
    seed();
    const { unmount } = render(<RecoverySettings />);
    expect(screen.getByTestId('live-rec-code-chip').textContent).toBe('Off');
    unmount();
    seed({ recoveryCodeSet: true });
    render(<RecoverySettings />);
    expect(screen.getByTestId('live-rec-code-chip').textContent).toBe('On');
  });
});

// ---------------------------------------------------------------------------
// Making a code
// ---------------------------------------------------------------------------

describe('recovery settings: the code', () => {
  it('asks for the app password, then shows the code once', async () => {
    seed();
    render(<RecoverySettings />);
    fireEvent.click(screen.getByTestId('live-rec-code-open'));
    fireEvent.change(screen.getByTestId('live-rec-code-pw'), { target: { value: 'app-pw' } });
    fireEvent.click(screen.getByTestId('live-rec-code-create'));

    await waitFor(() => expect(screen.getByTestId('live-rec-code-value')).toBeTruthy());
    expect(screen.getByTestId('live-rec-code-value').textContent).toBe(CODE);
    expect(state().createRecoveryCode).toHaveBeenCalledWith('app-pw');
  });

  it('says the code is a second key to the wallet, on the screen that hands it over', async () => {
    seed();
    render(<RecoverySettings />);
    fireEvent.click(screen.getByTestId('live-rec-code-open'));
    fireEvent.change(screen.getByTestId('live-rec-code-pw'), { target: { value: 'app-pw' } });
    fireEvent.click(screen.getByTestId('live-rec-code-create'));

    await waitFor(() => expect(screen.getByTestId('live-rec-code-shown')).toBeTruthy());
    const shown = screen.getByTestId('live-rec-code-shown').textContent ?? '';
    expect(shown).toMatch(/without your password/i);
    expect(shown).toMatch(/not be shown again/i);
    // Copying it must go through the SECRET path (auto-clearing clipboard), the
    // same one the seed-phrase reveal uses: this code opens the wallet alone.
    expect(screen.getByTestId('live-rec-code-copy')).toBeTruthy();
    expect(shown).toMatch(/clipboard clears itself/i);
  });

  it('will not let the user leave until they say they wrote it down', async () => {
    seed();
    render(<RecoverySettings />);
    fireEvent.click(screen.getByTestId('live-rec-code-open'));
    fireEvent.change(screen.getByTestId('live-rec-code-pw'), { target: { value: 'app-pw' } });
    fireEvent.click(screen.getByTestId('live-rec-code-create'));

    await waitFor(() => expect(screen.getByTestId('live-rec-code-done')).toBeTruthy());
    const done = screen.getByTestId('live-rec-code-done') as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('live-rec-code-saved'));
    expect((screen.getByTestId('live-rec-code-done') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the failure and never a code', async () => {
    seed({
      createRecoveryCode: vi.fn(async () => ({ ok: false as const, error: 'Incorrect app password.' })),
    });
    render(<RecoverySettings />);
    fireEvent.click(screen.getByTestId('live-rec-code-open'));
    fireEvent.change(screen.getByTestId('live-rec-code-pw'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('live-rec-code-create'));

    await waitFor(() => expect(screen.getByText('Incorrect app password.')).toBeTruthy());
    expect(screen.queryByTestId('live-rec-code-value')).toBeNull();
  });

  it('warns that a replacement kills the old code, and offers removal', () => {
    seed({ recoveryCodeSet: true });
    render(<RecoverySettings />);
    fireEvent.click(screen.getByTestId('live-rec-code-open'));
    expect(screen.getByTestId('live-rec-code-form').textContent).toMatch(
      /stops the old one from working/i,
    );
    expect(screen.getByTestId('live-rec-code-remove')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The backup file
// ---------------------------------------------------------------------------

describe('recovery settings: saving a backup', () => {
  it('refuses a short password and a mismatch before calling anything', async () => {
    seed();
    render(<RecoverySettings />);
    fireEvent.click(screen.getByTestId('live-rec-backup-open'));
    fireEvent.change(screen.getByTestId('live-rec-backup-pw'), { target: { value: 'short' } });
    fireEvent.change(screen.getByTestId('live-rec-backup-pw2'), { target: { value: 'short' } });
    fireEvent.click(screen.getByTestId('live-rec-backup-save'));
    await waitFor(() => expect(screen.getByText(/at least 8 characters/i)).toBeTruthy());
    expect(state().exportBackup).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('live-rec-backup-pw'), { target: { value: 'long enough' } });
    fireEvent.change(screen.getByTestId('live-rec-backup-pw2'), { target: { value: 'different!!' } });
    fireEvent.click(screen.getByTestId('live-rec-backup-save'));
    await waitFor(() => expect(screen.getByText(/do not match/i)).toBeTruthy());
    expect(state().exportBackup).not.toHaveBeenCalled();
  });

  it('says the file password is NOT the app password, and that nobody can open it without it', async () => {
    seed();
    render(<RecoverySettings />);
    fireEvent.click(screen.getByTestId('live-rec-backup-open'));
    expect(screen.getByTestId('live-rec-backup-form').textContent).toMatch(
      /not your app password/i,
    );

    fireEvent.change(screen.getByTestId('live-rec-backup-pw'), { target: { value: 'a good file password' } });
    fireEvent.change(screen.getByTestId('live-rec-backup-pw2'), { target: { value: 'a good file password' } });
    fireEvent.click(screen.getByTestId('live-rec-backup-save'));

    await waitFor(() => expect(screen.getByTestId('live-rec-backup-saved')).toBeTruthy());
    const saved = screen.getByTestId('live-rec-backup-saved').textContent ?? '';
    expect(saved).toMatch(/satori-go-backup-2026-08-26\.json/);
    expect(saved).toMatch(/including us/i);
  });
});

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

describe('recovery settings: restoring', () => {
  async function openPreview(p: BackupPreview) {
    seed({ readBackupFile: vi.fn(async () => ({ ok: true as const, preview: p })) });
    render(<RecoverySettings />);
    fireEvent.click(screen.getByTestId('live-rec-restore-open'));
    const input = screen.getByTestId('live-rec-restore-file') as HTMLInputElement;
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    // jsdom's File has no .text() in every version; give it one.
    Object.defineProperty(file, 'text', { value: async () => '{}' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('live-rec-restore-pw')).toBeTruthy());
    fireEvent.change(screen.getByTestId('live-rec-restore-pw'), { target: { value: 'file-pw' } });
    fireEvent.click(screen.getByTestId('live-rec-restore-read'));
    await waitFor(() => expect(screen.getByTestId('live-rec-restore-preview')).toBeTruthy());
  }

  it('NAMES the wallets a replace would destroy, before the button that does it', async () => {
    await openPreview(
      preview({
        deviceEmpty: false,
        losing: [
          { id: 'w-9', name: 'Only here', network: 'mainnet' },
          { id: 'w-8', name: 'Also only here', network: 'mainnet' },
        ],
      }),
    );
    const warning = screen.getByTestId('live-rec-restore-losing').textContent ?? '';
    expect(warning).toMatch(/Only here/);
    expect(warning).toMatch(/Also only here/);
    expect(screen.getByTestId('live-rec-restore-replace').textContent).toMatch(/Replace everything/);
  });

  it('calls the restore a Restore when there is nothing here to lose', async () => {
    await openPreview(preview({ deviceEmpty: true, losing: [] }));
    expect(screen.queryByTestId('live-rec-restore-losing')).toBeNull();
    expect(screen.getByTestId('live-rec-restore-replace').textContent).toMatch(/^Restore$/);
  });

  it('offers merge only when the service says the two sides share a record', async () => {
    await openPreview(preview({ canMerge: false, gaining: 2, deviceEmpty: false }));
    expect(screen.queryByTestId('live-rec-restore-merge')).toBeNull();
    // And explains the refusal rather than leaving one button unexplained.
    expect(screen.getByTestId('live-rec-restore-preview').textContent).toMatch(
      /different app password/i,
    );
    cleanup();

    await openPreview(preview({ canMerge: true, gaining: 2, deviceEmpty: false }));
    expect(screen.getByTestId('live-rec-restore-merge').textContent).toMatch(/Add 2 missing/);
  });

  it('applies the mode that was clicked', async () => {
    await openPreview(preview({ canMerge: true, gaining: 1, deviceEmpty: false }));
    fireEvent.click(screen.getByTestId('live-rec-restore-merge'));
    await waitFor(() => expect(state().applyRestore).toHaveBeenCalledWith('merge'));
  });

  it('drops the decoded backup when the user backs out', async () => {
    await openPreview(preview());
    fireEvent.click(screen.getByTestId('live-rec-restore-cancel'));
    expect(state().cancelRestore).toHaveBeenCalled();
  });

  it('reports a wrong file password without revealing anything', async () => {
    seed({
      readBackupFile: vi.fn(async () => ({
        ok: false as const,
        error: 'Wrong password for this backup file.',
      })),
    });
    render(<RecoverySettings />);
    fireEvent.click(screen.getByTestId('live-rec-restore-open'));
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => '{}' });
    fireEvent.change(screen.getByTestId('live-rec-restore-file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('live-rec-restore-pw')).toBeTruthy());
    fireEvent.change(screen.getByTestId('live-rec-restore-pw'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('live-rec-restore-read'));

    await waitFor(() =>
      expect(screen.getByText('Wrong password for this backup file.')).toBeTruthy(),
    );
    expect(screen.queryByTestId('live-rec-restore-preview')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The route from the lock screen
// ---------------------------------------------------------------------------

describe('forgot password: the panel behind the lock screen', () => {
  it('offers the code only when there is one, and says so when there is not', () => {
    seed({ recoveryCodeSet: false });
    render(<AppRecoverPanel onBack={() => {}} />);
    expect((screen.getByTestId('live-recover-use-code') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('live-recover-menu').textContent).toMatch(
      /No recovery code was ever made/i,
    );
  });

  it('does not offer a destructive reset (§13.10)', () => {
    seed({ recoveryCodeSet: true });
    render(<AppRecoverPanel onBack={() => {}} />);
    const menu = screen.getByTestId('live-recover-menu').textContent ?? '';
    expect(menu).not.toMatch(/erase|wipe|delete everything/i);
    // What it says instead: the honest floor.
    expect(menu).toMatch(/nothing we can reset for you/i);
  });

  it('takes a code and a NEW password, and refuses to skip the password', async () => {
    seed({ recoveryCodeSet: true });
    render(<AppRecoverPanel onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-recover-use-code'));
    fireEvent.change(screen.getByTestId('live-recover-code-input'), { target: { value: CODE } });
    fireEvent.change(screen.getByTestId('live-recover-new-pw'), { target: { value: 'short' } });
    fireEvent.change(screen.getByTestId('live-recover-new-pw2'), { target: { value: 'short' } });
    fireEvent.click(screen.getByTestId('live-recover-submit'));
    await waitFor(() => expect(screen.getByText(/at least 8 characters/i)).toBeTruthy());
    expect(state().unlockWithRecoveryCode).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('live-recover-new-pw'), { target: { value: 'a new password' } });
    fireEvent.change(screen.getByTestId('live-recover-new-pw2'), { target: { value: 'a new password' } });
    fireEvent.click(screen.getByTestId('live-recover-submit'));
    await waitFor(() =>
      expect(state().unlockWithRecoveryCode).toHaveBeenCalledWith(CODE, 'a new password'),
    );
  });

  it('clears the typed passwords when the code turns out to be wrong', async () => {
    seed({
      recoveryCodeSet: true,
      unlockWithRecoveryCode: vi.fn(async () => ({
        ok: false,
        error: 'That recovery code is not the one for this wallet.',
      })),
    });
    render(<AppRecoverPanel onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-recover-use-code'));
    fireEvent.change(screen.getByTestId('live-recover-code-input'), { target: { value: CODE } });
    fireEvent.change(screen.getByTestId('live-recover-new-pw'), { target: { value: 'a new password' } });
    fireEvent.change(screen.getByTestId('live-recover-new-pw2'), { target: { value: 'a new password' } });
    fireEvent.click(screen.getByTestId('live-recover-submit'));

    await waitFor(() => expect(screen.getByText(/not the one for this wallet/i)).toBeTruthy());
    expect((screen.getByTestId('live-recover-new-pw') as HTMLInputElement).value).toBe('');
  });
});
