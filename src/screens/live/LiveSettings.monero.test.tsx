/**
 * @vitest-environment jsdom
 *
 * Settings on a MONERO wallet, and the sub-screen scroll reset. What the 1.4.3
 * audit found: Servers & explorer listed the idle Evrmore Electrum pool,
 * Addresses offered UTXO controls that failed with an internal error,
 * Diagnostics printed Evrmore's chain id and coin type, the CSV export was
 * always "evrmore-transactions.csv" with a fee_evr column, and every
 * sub-screen opened pre-scrolled to wherever the root list had been.
 *
 * Real store and service (one Evrmore wallet imported offline); the Monero
 * wallet is a summary the service is spied to answer, so no worker is spawned.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/prices', () => ({ fetchPrices: async () => ({}) }));

import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import { NavProvider } from './LiveNav';
import type { MoneroChainInfo } from '../../store/moneroChains';
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
const XMR: MoneroChainInfo = {
  key: 'monero',
  displayName: 'Monero',
  nativeTicker: 'XMR',
  nativeDecimals: 12,
  homepage: 'https://getmonero.org',
  explorerTxUrl: 'https://xmrchain.net/tx/{txid}',
  nodeSets: ['main'],
  defaultNodeSet: 'main',
  releaseHeight: 3772358,
  coinType: 128,
  scheme: 'cake-exodus',
  young: false,
  recentlyAdded: true,
};

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

/** Make the ACTIVE wallet read as a Monero wallet: the service keeps answering
 *  its id as active, the summary it lists carries the Monero family. */
async function activateMoneroSummary(overrides: Partial<WalletSummary> = {}) {
  const svc = storeMod.liveService();
  const real = (await svc.listWallets()).find((w) => w.id === svc.activeWalletId())!;
  const xmr: WalletSummary = {
    ...real,
    name: 'My XMR',
    network: 'xmr:mainnet',
    family: 'monero',
    address: '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756',
    restoreHeight: 3772500,
    moneroNodeSet: 'main',
    moneroKeySource: 'phrase',
    ...overrides,
  };
  vi.spyOn(svc, 'listWallets').mockResolvedValue([xmr]);
  storeMod.useLiveStore.setState((s) => ({ monero: { ...s.monero, chain: XMR } }));
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
  state().setSettingsMode('expert');
});

afterEach(() => {
  state().stopAutoRefresh();
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings on a Monero wallet', () => {
  it('Servers & explorer shows the gateway node set, never the Electrum list', async () => {
    await activateMoneroSummary();
    renderSettings();
    fireEvent.click(screen.getByTestId('live-settings-row-network'));
    await waitFor(() => expect(screen.getByTestId('live-network-chain-caption').textContent).toBe('Servers for: Monero'));
    expect(screen.getByTestId('live-network-monero-node-set').textContent).toBe('main');
    expect(screen.getByTestId('live-network-monero-route')).toBeTruthy();
    expect(screen.queryByTestId('live-servers-list')).toBeNull();
    expect(screen.queryByTestId('live-server-input')).toBeNull();
    expect(screen.getByTestId('live-explorer-input')).toBeTruthy();
  }, 30_000);

  it('the Addresses row is not offered (subaddresses live on Receive)', async () => {
    await activateMoneroSummary();
    renderSettings();
    await waitFor(() => expect(screen.getByTestId('live-settings-row-network')).toBeTruthy());
    expect(screen.queryByTestId('live-settings-row-addresses')).toBeNull();
    // The Address book stays.
    expect(screen.getByTestId('live-address-book-btn')).toBeTruthy();
  }, 30_000);

  it('Diagnostics prints the Monero chain id, coin type 128 and the scheme', async () => {
    await activateMoneroSummary();
    renderSettings();
    fireEvent.click(screen.getByTestId('live-settings-row-diagnostics'));
    await waitFor(() => expect(screen.getByTestId('live-diag-chain-id').textContent).toBe('xmr:mainnet'));
    expect(screen.getByTestId('live-diag-coin-type').textContent).toContain('coin type 128');
    expect(screen.getByTestId('live-diag-coin-type').textContent).toContain('cake-exodus');
    expect(screen.getByTestId('live-diag-derivation-path').textContent).toBe("m/44'/128'/0'/0/0");
  }, 30_000);

  it('Diagnostics on a wallet IMPORTED from 25 words says so: no coin type, no scheme, no path (N-diag-vector-xmr-imported)', async () => {
    await activateMoneroSummary({ name: 'Vector XMR', moneroKeySource: 'words' });
    renderSettings();
    fireEvent.click(screen.getByTestId('live-settings-row-diagnostics'));
    await waitFor(() => expect(screen.getByTestId('live-diag-chain-id').textContent).toBe('xmr:mainnet'));
    const desc = screen.getByTestId('live-diag-coin-type').textContent ?? '';
    expect(desc).toContain('Imported from 25 Monero words');
    expect(desc).not.toContain('coin type');
    expect(desc).not.toContain('cake-exodus');
    expect(screen.getByTestId('live-diag-derivation-path').textContent).toBe('n/a');
  }, 30_000);

  it('Wallets lists a 25-word import as "Monero (25 words)" and a phrase sibling as "Seed"', async () => {
    await activateMoneroSummary({ name: 'Vector XMR', moneroKeySource: 'words' });
    renderSettings();
    fireEvent.click(screen.getByTestId('live-settings-row-wallets'));
    const id = storeMod.liveService().activeWalletId()!;
    await waitFor(() => expect(screen.getByTestId(`live-settings-wallet-${id}`)).toBeTruthy());
    expect(screen.getByTestId(`live-settings-wallet-${id}`).textContent).toContain('Monero (25 words)');
    expect(screen.getByTestId(`live-settings-wallet-${id}`).textContent).not.toContain('Seed');
    cleanup();
    await activateMoneroSummary({ name: 'My XMR', moneroKeySource: 'phrase' });
    renderSettings();
    fireEvent.click(screen.getByTestId('live-settings-row-wallets'));
    await waitFor(() => expect(screen.getByTestId(`live-settings-wallet-${id}`)).toBeTruthy());
    expect(screen.getByTestId(`live-settings-wallet-${id}`).textContent).toContain('Seed');
  }, 30_000);

  it('an Evrmore wallet still gets its Electrum list and its own diagnostics', async () => {
    renderSettings();
    fireEvent.click(screen.getByTestId('live-settings-row-network'));
    await waitFor(() => expect(screen.getByTestId('live-network-chain-caption').textContent).toBe('Servers for: Evrmore'));
    expect(screen.getByTestId('live-servers-list')).toBeTruthy();
    expect(screen.queryByTestId('live-network-monero')).toBeNull();
    fireEvent.click(screen.getByLabelText('Back'));
    fireEvent.click(screen.getByTestId('live-settings-row-diagnostics'));
    await waitFor(() => expect(screen.getByTestId('live-diag-chain-id').textContent).toBe('evrmore-mainnet'));
    expect(screen.getByTestId('live-diag-coin-type').textContent).toContain('coin type 175');
  }, 30_000);
});

describe('Settings sub-screens open at the top', () => {
  it('resets the content scroll when a section opens, and again on Back', async () => {
    renderSettings();
    const root = screen.getByTestId('live-settings');
    root.scrollTop = 240;
    fireEvent.click(screen.getByTestId('live-settings-row-about'));
    const about = await screen.findByTestId('live-settings-view-about');
    expect(about.scrollTop).toBe(0);
    about.scrollTop = 120;
    fireEvent.click(screen.getByLabelText('Back'));
    const rootAgain = await screen.findByTestId('live-settings');
    expect(rootAgain.scrollTop).toBe(0);
  }, 30_000);
});

describe('CSV export naming', () => {
  it('names the file and the fee column after the chain, not Evrmore', () => {
    const { csvFileNameFor, csvHeaderFor, buildTransactionsCsv } = settingsMod;
    expect(csvFileNameFor('Monero')).toBe('monero-transactions.csv');
    expect(csvFileNameFor('BNB Chain')).toBe('bnb-chain-transactions.csv');
    expect(csvFileNameFor('Evrmore')).toBe('evrmore-transactions.csv');
    expect(csvHeaderFor('XMR')[4]).toBe('fee_xmr');
    expect(csvHeaderFor('EVR')[4]).toBe('fee_evr');
    const csv = buildTransactionsCsv(
      [{ txid: 't1', asset: 'XMR', direction: 'in', amount: 0.5, feeEvr: 0, status: 'confirmed', timestamp: 0, counterparty: '' }],
      'XMR',
    );
    expect(csv.split('\r\n')[0]).toBe('date,direction,asset,amount,fee_xmr,status,block_height,txid,counterparty');
    expect(csv.split('\r\n')[1]).toContain(',in,XMR,0.5,0,confirmed,,t1,');
  });
});
