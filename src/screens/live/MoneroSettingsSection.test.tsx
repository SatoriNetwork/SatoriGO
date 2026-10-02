/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  state: {
    monero: { chain: { defaultNodeSet: 'main', releaseHeight: 3772358 } as unknown, host: null, balance: null, sync: null, error: null },
    wallets: [
      { id: 'w1', name: 'Monero', network: 'xmr:mainnet', createdAt: 0, active: true, kind: 'seed', address: '4primary', passwordless: false, family: 'monero', restoreHeight: 3772400, moneroNodeSet: 'main' },
    ],
    activeWalletId: 'w1',
    loadWallets: vi.fn(async () => {}),
  },
  setMoneroRestoreHeight: vi.fn(async () => {}),
}));

vi.mock('../../store/liveStore', () => {
  const useLiveStore = (selector: (s: typeof hoisted.state) => unknown) => selector(hoisted.state);
  useLiveStore.getState = () => hoisted.state;
  return {
    useLiveStore,
    liveService: () => ({ setMoneroRestoreHeight: hoisted.setMoneroRestoreHeight }),
  };
});

vi.mock('../../services/chain/monero/rpc', () => ({
  estimateHeightForDate: (date: Date) => {
    // A tiny stand-in for Set B's real estimator: further back => a lower
    // height, clamped at 0 — enough to prove the date field DRIVES the
    // height field, without depending on the real 120s-block-time formula.
    const days = Math.max(0, (Date.now() - date.getTime()) / 86_400_000);
    return Math.max(0, 3_772_358 - Math.round(days) * 720);
  },
}));

import { MoneroSettingsSection } from './MoneroSettingsSection';

describe('MoneroSettingsSection', () => {
  beforeEach(() => {
    hoisted.state.activeWalletId = 'w1';
    hoisted.state.monero.balance = null;
    hoisted.setMoneroRestoreHeight.mockClear();
    hoisted.state.loadWallets.mockClear();
  });
  afterEach(cleanup);

  it('shows a fallback when the active wallet is not a Monero wallet', () => {
    hoisted.state.wallets = [{ ...hoisted.state.wallets[0], family: 'utxo' } as never];
    render(<MoneroSettingsSection />);
    expect(screen.getByTestId('live-xmr-settings-no-wallet')).toBeTruthy();
    hoisted.state.wallets = [{ ...hoisted.state.wallets[0], family: 'monero' } as never];
  });

  it('shows the current node set and restore height', () => {
    render(<MoneroSettingsSection />);
    expect(screen.getByTestId('live-xmr-settings-node-set').textContent).toBe('main');
    expect(screen.getByTestId('live-xmr-settings-restore-height').textContent).toBe('3,772,400');
  });

  it('opens the rescan form pre-filled with the current height', () => {
    render(<MoneroSettingsSection />);
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-open'));
    expect((screen.getByTestId('live-xmr-settings-restore-height-input') as HTMLInputElement).value).toBe('3772400');
  });

  it('picking a date fills the height field via estimateHeightForDate', () => {
    render(<MoneroSettingsSection />);
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-open'));
    fireEvent.change(screen.getByTestId('live-xmr-settings-restore-date'), { target: { value: '2020-01-01' } });
    const input = screen.getByTestId('live-xmr-settings-restore-height-input') as HTMLInputElement;
    expect(Number(input.value)).toBeLessThan(3_772_358);
  });

  it('rejects a non-numeric height without calling the service', async () => {
    render(<MoneroSettingsSection />);
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-open'));
    fireEvent.change(screen.getByTestId('live-xmr-settings-restore-height-input'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-confirm'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-settings-error')).toBeTruthy());
    expect(hoisted.setMoneroRestoreHeight).not.toHaveBeenCalled();
  });

  it('confirming calls setMoneroRestoreHeight(walletId, height) and shows the rescanning banner', async () => {
    render(<MoneroSettingsSection />);
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-open'));
    fireEvent.change(screen.getByTestId('live-xmr-settings-restore-height-input'), { target: { value: '3772000' } });
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-confirm'));
    await waitFor(() => expect(hoisted.setMoneroRestoreHeight).toHaveBeenCalledWith('w1', 3772000, expect.anything()));
    await waitFor(() => expect(screen.getByTestId('live-xmr-settings-rescan-done').textContent).toContain('3,772,000'));
    // The card reads the height off the store's wallet list, which is
    // reloaded right after the write so it does not show the old value.
    expect(hoisted.state.loadWallets).toHaveBeenCalled();
  });

  it('refuses a height above the chain tip with a clear error, without calling the service', async () => {
    hoisted.state.monero.balance = { total: 0n, unlocked: 0n, height: 3772555, daemonHeight: 3772555 } as never;
    render(<MoneroSettingsSection />);
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-open'));
    fireEvent.change(screen.getByTestId('live-xmr-settings-restore-height-input'), { target: { value: '99999999' } });
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-confirm'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-settings-error').textContent).toContain('3,772,555'));
    expect(hoisted.setMoneroRestoreHeight).not.toHaveBeenCalled();
    // Exactly the tip is still allowed, and the tip travels with the call.
    fireEvent.change(screen.getByTestId('live-xmr-settings-restore-height-input'), { target: { value: '3772555' } });
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-confirm'));
    await waitFor(() => expect(hoisted.setMoneroRestoreHeight).toHaveBeenCalledWith('w1', 3772555, { daemonHeight: 3772555 }));
  });

  it('re-submitting the saved height still rescans and says the height is unchanged', async () => {
    render(<MoneroSettingsSection />);
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-open'));
    // The form is pre-filled with the saved height (3772400): press Rescan as is.
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-confirm'));
    await waitFor(() => expect(hoisted.setMoneroRestoreHeight).toHaveBeenCalledWith('w1', 3772400, expect.anything()));
    await waitFor(() => expect(screen.getByTestId('live-xmr-settings-rescan-done').textContent).toMatch(/unchanged/));
    expect(screen.getByTestId('live-xmr-settings-rescan-done').textContent).toContain('3,772,400');
  });

  it('shows an inline error when the service call fails', async () => {
    hoisted.setMoneroRestoreHeight.mockRejectedValueOnce(new Error('wallet locked'));
    render(<MoneroSettingsSection />);
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-open'));
    fireEvent.change(screen.getByTestId('live-xmr-settings-restore-height-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('live-xmr-settings-rescan-confirm'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-settings-error').textContent).toBe('wallet locked'));
  });
});
