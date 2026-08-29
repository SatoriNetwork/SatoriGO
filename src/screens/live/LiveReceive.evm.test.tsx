/**
 * @vitest-environment jsdom
 *
 * LiveReceive with an EVM active wallet (phase 3): the 0x address renders
 * (nativeTickerFor/assetsSupported/chainDisplayName are already EVM-aware —
 * see the store), and "New address" is hidden (an EVM account is ONE address
 * on every EVM chain by design, see the EVM engine design notes §1; the store
 * would refuse a second one anyway). A UTXO active wallet is asserted
 * alongside it to pin the pre-existing behaviour is untouched.
 *
 * Same real-store + neutralized-EVM-balances + no-network setup as
 * LiveHome.evm.test.tsx — see that file's header comment for the rationale.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ evmEnabled: true }));

vi.mock('../../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => (hoisted.evmEnabled ? await import('../../services/chain/evm') : null),
  };
});

vi.mock('../../store/evmBalances', () => ({
  evmProviderFor: async () => null,
  refreshEvmWallet: async () => null,
}));

vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({}),
}));

import { MemoryStorageAdapter, setStorageForTests, type KeyValueStorage } from '../../services/storage';
import { NavProvider } from './LiveNav';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ADDRESS_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PW = 'password123';

type LiveStoreModule = typeof import('../../store/liveStore');
type LiveReceiveModule = typeof import('./LiveReceive');
let storeMod: LiveStoreModule;
let LiveReceive: LiveReceiveModule['LiveReceive'];
let storage: KeyValueStorage;
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = { tab: 'assets' as const, section: 'home' as const, openTab: () => {}, openSettings: () => {} };
function renderReceive() {
  return render(
    <NavProvider value={NAV_VALUE}>
      <LiveReceive onBack={() => {}} />
    </NavProvider>,
  );
}

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  LiveReceive = (await import('./LiveReceive')).LiveReceive;
});

beforeEach(async () => {
  hoisted.evmEnabled = true;
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  await state().resetLiveWallet();
  await state().init();
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
});

afterEach(() => {
  state().stopAutoRefresh();
  cleanup();
});

describe('LiveReceive with an EVM active wallet', () => {
  it('shows the 0x address, the EVM chain name, and hides "New address"', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My EVM', 'evm:base');
    await state().loadWallets();
    expect(state().wallets[0]?.family).toBe('evm');
    expect(state().address).toBe(VECTOR_ADDRESS_0);

    renderReceive();

    expect(screen.getByTestId('live-receive-address')).toHaveTextContent(VECTOR_ADDRESS_0);
    expect(screen.getByTestId('live-receive-network').textContent).toMatch(/Base/);
    expect(screen.getByTestId('live-receive-network').textContent).toMatch(/ETH/);
    expect(screen.queryByTestId('live-receive-new-address')).toBeNull();
  }, 30_000);
});

describe('LiveReceive with a UTXO active wallet renders as before', () => {
  it('keeps "New address" for a seed wallet on Evrmore', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My Evrmore', 'mainnet');
    await state().loadWallets();
    expect(state().wallets[0]?.family).toBe('utxo');

    renderReceive();

    expect(screen.getByTestId('live-receive-network').textContent).toMatch(/Evrmore/);
    expect(screen.getByTestId('live-receive-new-address')).toBeTruthy();
  }, 30_000);
});
