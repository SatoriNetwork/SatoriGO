/**
 * @vitest-environment jsdom
 *
 * Settings > Security on a Zcash or Bittensor wallet. Neither has a single
 * private key to show (fifteen transparent keys; an sr25519 mini secret), and
 * the service answers null for those families, which the reveal modal read
 * as "Incorrect password" against a RIGHT password. The button is gone for
 * them and a line says why; the recovery phrase button stays, and every
 * other wallet keeps both buttons.
 *
 * Real store and service (one Evrmore wallet imported offline); the engine
 * wallet is a summary the service is spied to answer, the same way
 * LiveSettings.monero.test.tsx does it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/prices', () => ({ fetchPrices: async () => ({}) }));

import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import { NavProvider } from './LiveNav';
import type { WalletSummary } from '../../services/chain/liveWallet';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'password123';

type LiveStoreModule = typeof import('../../store/liveStore');
let storeMod: LiveStoreModule;
let settingsMod: typeof import('./LiveSettings');
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = { tab: 'assets' as const, section: 'settings' as const, openTab: () => {}, openSettings: () => {} };

function renderSettings() {
  const LiveSettings = settingsMod.LiveSettings;
  return render(
    <NavProvider value={NAV_VALUE}>
      <LiveSettings onBack={() => {}} onOpenAddressBook={() => {}} />
    </NavProvider>,
  );
}

async function activateSummary(overrides: Partial<WalletSummary>) {
  const svc = storeMod.liveService();
  const real = (await svc.listWallets()).find((w) => w.id === svc.activeWalletId())!;
  vi.spyOn(svc, 'listWallets').mockResolvedValue([{ ...real, ...overrides }]);
  await state().loadWallets();
}

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  settingsMod = await import('./LiveSettings');
});

beforeEach(async () => {
  setStorageForTests(new MemoryStorageAdapter());
  await state().resetLiveWallet();
  await state().init();
  await state().importWallet(VECTOR_MNEMONIC, PW, 'Wallet 1', 'mainnet');
  await state().loadWallets();
});

afterEach(() => {
  state().stopAutoRefresh();
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings > Security on an engine wallet', () => {
  it('a Zcash wallet offers the recovery phrase but no private key, and says why', async () => {
    await activateSummary({ name: 'Wallet 1 (Zcash)', network: 'zec:mainnet', family: 'zcash', address: 't1primary' });
    renderSettings();
    fireEvent.click(screen.getByTestId('live-settings-row-security'));
    await waitFor(() => expect(screen.getByTestId('live-reveal-seed')).toBeTruthy());
    expect(screen.queryByTestId('live-reveal-key')).toBeNull();
    expect(screen.getByTestId('live-reveal-engine-note').textContent).toMatch(/no separate private key/);
  }, 30_000);

  it('a Bittensor wallet the same way', async () => {
    await activateSummary({ name: 'Wallet 1 (Bittensor)', network: 'tao:mainnet', family: 'substrate', address: '5FakeAddress' });
    renderSettings();
    fireEvent.click(screen.getByTestId('live-settings-row-security'));
    await waitFor(() => expect(screen.getByTestId('live-reveal-seed')).toBeTruthy());
    expect(screen.queryByTestId('live-reveal-key')).toBeNull();
    expect(screen.getByTestId('live-reveal-engine-note')).toBeTruthy();
  }, 30_000);

  it('a UTXO wallet keeps both buttons and no note', async () => {
    renderSettings();
    fireEvent.click(screen.getByTestId('live-settings-row-security'));
    await waitFor(() => expect(screen.getByTestId('live-reveal-seed')).toBeTruthy());
    expect(screen.getByTestId('live-reveal-key')).toBeTruthy();
    expect(screen.queryByTestId('live-reveal-engine-note')).toBeNull();
  }, 30_000);
});
