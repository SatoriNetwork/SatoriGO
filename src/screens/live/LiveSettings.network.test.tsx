/**
 * @vitest-environment jsdom
 *
 * Settings > Network on a UTXO chain in a GATEWAY build.
 *
 * The Satori GO gateway's Electrum bridge is a REQUIRED row: it reads as the
 * gateway, carries the same "Required" chip the EVM endpoint rows do, and has
 * no Remove button, because on Ravencoin it is the only server there is and on
 * Evrmore it is the only route to the owner's node. Servers the user adds are
 * ordinary rows: still addable, still removable, still tried after it.
 *
 * services/gateway is mocked so the build defines look like a store build (they
 * are empty in tests, see vitest.config.ts). Real store, real
 * LiveWalletService, a WebSocket that refuses to connect (so no read leaves the
 * machine) and prices stubbed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const { GW, TOKEN } = vi.hoisted(() => ({
  GW: 'https://network.satorigo.app',
  TOKEN: 'sgw_test_token',
}));

vi.mock('../../services/gateway', () => ({
  GATEWAY_URL: GW,
  HAS_GATEWAY: true,
  GATEWAY_CLIENT_TOKEN: TOKEN,
  gatewayUrl: () => GW,
  gatewayHeaders: () => ({ 'X-Satori-Client': TOKEN }),
}));

// Prices are decorative and hit the network; init() fires them and forgets.
vi.mock('../../services/prices', () => ({ fetchPrices: async () => ({}) }));

import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import { NavProvider } from './LiveNav';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const EVR_BRIDGE = 'wss://network.satorigo.app/electrum/evr';
const RVN_BRIDGE = 'wss://network.satorigo.app/electrum/rvn';
const BTC_BRIDGE = 'wss://network.satorigo.app/electrum/btc';
const LTC_BRIDGE = 'wss://network.satorigo.app/electrum/ltc';
const BTC_PUBLIC = ['wss://btc.electrum1.cipig.net:30000', 'wss://btc.electrum2.cipig.net:30000'];
const LTC_PUBLIC = ['wss://ltc.electrum1.cipig.net:30063', 'wss://ltc.electrum2.cipig.net:30063'];
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'password123';

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

function renderSettings() {
  return render(
    <NavProvider value={NAV_VALUE}>
      <LiveSettings onBack={() => {}} onOpenAddressBook={() => {}} />
    </NavProvider>,
  );
}

/** Open the Network sub-screen (expert only). */
function openNetworkSection() {
  state().setSettingsMode('expert');
  renderSettings();
  fireEvent.click(screen.getByTestId('live-settings-row-network'));
}

const serverRows = () =>
  Array.from(document.querySelectorAll('[data-testid^="live-server-"][data-gateway]'));

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

describe('Settings > Network with the gateway Electrum bridge', () => {
  it('lists the bridge first, as a Required Satori GO gateway row with no Remove button', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVR', 'mainnet');
    await state().loadWallets();
    expect(state().electrumServers[0]).toBe(EVR_BRIDGE);

    openNetworkSection();

    const rows = serverRows();
    expect(rows).toHaveLength(3);
    // The bridge is first, and it is the ONLY row flagged as the gateway.
    expect(rows[0].getAttribute('data-gateway')).toBe('true');
    expect(rows.slice(1).every((r) => r.getAttribute('data-gateway') === 'false')).toBe(true);
    expect(rows[0].textContent).toContain(EVR_BRIDGE);
    expect(rows[0].textContent).toContain('Required');
    expect(rows[0].textContent).toContain('Satori GO gateway');
    // No Remove button on the bridge row; the public fallbacks keep theirs.
    expect(rows[0].querySelector('[data-testid^="live-server-remove-"]')).toBeNull();
    expect(rows[1].querySelector('[data-testid^="live-server-remove-"]')).not.toBeNull();
    // The note explaining the Required row is shown.
    expect(screen.getByTestId('live-server-gateway-note').textContent).toContain(
      'Satori GO gateway',
    );
    // The two public Evrmore fallbacks are still there: a gateway outage must
    // not brick EVR.
    expect(state().electrumServers.slice(1)).toEqual([
      'wss://electrum1-mainnet.evrmorecoin.org:50004',
      'wss://electrum2-mainnet.evrmorecoin.org:50004',
    ]);
  }, 30_000);

  it('custom servers are still addable and removable, and never displace the bridge', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVR', 'mainnet');
    await state().loadWallets();
    openNetworkSection();

    fireEvent.change(screen.getByTestId('live-server-input'), {
      target: { value: 'wss://mine.test:50004' },
    });
    fireEvent.click(screen.getByTestId('live-server-add'));

    expect(state().electrumServers).toEqual([
      EVR_BRIDGE,
      'wss://electrum1-mainnet.evrmorecoin.org:50004',
      'wss://electrum2-mainnet.evrmorecoin.org:50004',
      'wss://mine.test:50004',
    ]);
    const added = serverRows()[3];
    expect(added.getAttribute('data-gateway')).toBe('false');
    expect(added.textContent).toContain('mine.test');

    // ...and removing it works, leaving the bridge at the head.
    fireEvent.click(added.querySelector('[data-testid^="live-server-remove-"]')!);
    expect(state().electrumServers).not.toContain('wss://mine.test:50004');
    expect(state().electrumServers[0]).toBe(EVR_BRIDGE);
  }, 30_000);

  it('the bridge cannot be removed, even by calling the store action directly', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVR', 'mainnet');
    await state().loadWallets();
    const before = [...state().electrumServers];

    state().removeElectrumServer(EVR_BRIDGE);

    expect(state().electrumServers).toEqual(before);
    expect(state().electrumServers[0]).toBe(EVR_BRIDGE);
  }, 30_000);

  it('a pool persisted before this build gained a gateway gets the bridge back on load', async () => {
    // The upgrade case: a user who edited their Evrmore servers when the wallet
    // still talked to the public nodes directly. Their servers are kept, the
    // bridge is re-asserted at the head.
    await state().importWallet(VECTOR_MNEMONIC, PW, 'EVR', 'mainnet');
    const legacy = ['wss://electrumx1.satorinet.io:50004', 'wss://mine.test:50004'];
    // Write the legacy list under the Evrmore key, then reload the wallet list:
    // that is what re-reads the pool.
    const { getStorage } = await import('../../services/storage');
    await getStorage().set('electrumServers', legacy);
    await state().loadWallets();

    expect(state().electrumServers).toEqual([EVR_BRIDGE, ...legacy]);
  }, 30_000);

  it('Bitcoin lists the bridge as a Required row and KEEPS both public cipig fallbacks (1.4.0)', async () => {
    // The owner's rule for every chain except Ravencoin: the bridge is
    // preferred and required, the public pool stays as the fallback, because a
    // gateway outage must never stop someone's Bitcoin.
    await state().importWallet(VECTOR_MNEMONIC, PW, 'BTC', 'bitcoin-mainnet');
    await state().loadWallets();
    expect(state().electrumServers).toEqual([BTC_BRIDGE, ...BTC_PUBLIC]);

    openNetworkSection();

    const rows = serverRows();
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('data-gateway')).toBe('true');
    expect(rows[0].textContent).toContain(BTC_BRIDGE);
    expect(rows[0].textContent).toContain('Required');
    expect(rows[0].textContent).toContain('Satori GO gateway');
    expect(rows[0].querySelector('[data-testid^="live-server-remove-"]')).toBeNull();
    // The two public fallbacks are ordinary, removable rows behind it.
    expect(rows.slice(1).every((r) => r.getAttribute('data-gateway') === 'false')).toBe(true);
    expect(rows[1].textContent).toContain('btc.electrum1.cipig.net');
    expect(rows[2].textContent).toContain('btc.electrum2.cipig.net');
    expect(rows[1].querySelector('[data-testid^="live-server-remove-"]')).not.toBeNull();
    expect(screen.getByTestId('live-server-gateway-note')).toBeTruthy();

    // And the bridge cannot be removed through the store either.
    state().removeElectrumServer(BTC_BRIDGE);
    expect(state().electrumServers).toEqual([BTC_BRIDGE, ...BTC_PUBLIC]);
  }, 30_000);

  it('a Litecoin pool persisted before the bridge existed gets it back, keeping the user own server', async () => {
    // Same upgrade path Evrmore has, now on a chain that only gained a bridge
    // in 1.4.0: without this the wallet would keep talking to the public nodes
    // directly forever.
    await state().importWallet(VECTOR_MNEMONIC, PW, 'LTC', 'litecoin-mainnet');
    const legacy = [...LTC_PUBLIC, 'wss://mine.test:50004'];
    const { getStorage } = await import('../../services/storage');
    await getStorage().set('electrumServers:litecoin-mainnet', legacy);
    await state().loadWallets();

    expect(state().electrumServers).toEqual([LTC_BRIDGE, ...legacy]);

    openNetworkSection();
    const rows = serverRows();
    expect(rows[0].getAttribute('data-gateway')).toBe('true');
    expect(rows[0].textContent).toContain(LTC_BRIDGE);
    // The user's own server survived and is still removable.
    expect(rows[3].textContent).toContain('mine.test');
    expect(rows[3].querySelector('[data-testid^="live-server-remove-"]')).not.toBeNull();
    fireEvent.click(rows[3].querySelector('[data-testid^="live-server-remove-"]')!);
    expect(state().electrumServers).toEqual([LTC_BRIDGE, ...LTC_PUBLIC]);
  }, 30_000);

  it('Ravencoin has exactly one server: the bridge, and it is not removable', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'RVN', 'ravencoin-mainnet');
    await state().loadWallets();
    expect(state().electrumServers).toEqual([RVN_BRIDGE]);

    openNetworkSection();

    const rows = serverRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-gateway')).toBe('true');
    expect(rows[0].textContent).toContain(RVN_BRIDGE);
    expect(rows[0].querySelector('[data-testid^="live-server-remove-"]')).toBeNull();
  }, 30_000);
});
