/**
 * @vitest-environment jsdom
 *
 * LiveReceiveMonero against a MOCKED store: the real liveStore.ts does not
 * carry a `monero` slice yet (Set D's wiring lands separately, §15), so this
 * test stands in a minimal fake with exactly the shape the Set D surface
 * promises (`monero: { chain, host, balance, sync, error }`) and a fake
 * MoneroWalletHost, rather than pulling in the whole real store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { MoneroSubaddress, MoneroWalletHost } from '../../services/chain/monero/scanner';

const hoisted = vi.hoisted(() => ({
  state: { monero: { chain: null as unknown, host: null as MoneroWalletHost | null, balance: null, sync: null, error: null } },
}));

vi.mock('../../store/liveStore', () => {
  const useLiveStore = (selector: (s: typeof hoisted.state) => unknown) => selector(hoisted.state);
  useLiveStore.getState = () => hoisted.state;
  return { useLiveStore };
});

import { LiveReceiveMonero } from './LiveReceiveMonero';
import { NavProvider, type NavContextValue } from './LiveNav';

const NAV: NavContextValue = { tab: 'assets', section: 'home', openTab: vi.fn(), openSettings: vi.fn() };

function fakeHost(subaddresses: MoneroSubaddress[]): MoneroWalletHost {
  return {
    walletId: 'w1',
    primaryAddress: vi.fn(async () => subaddresses[0]?.address ?? ''),
    subaddresses: vi.fn(async () => subaddresses),
    createSubaddress: vi.fn(async (major: number, label = '') => ({ major, minor: subaddresses.length, address: `8new${subaddresses.length}`, label, used: false })),
    sync: vi.fn(),
    balance: vi.fn(),
    history: vi.fn(),
    buildTx: vi.fn(),
    relay: vi.fn(),
    setRestoreHeight: vi.fn(),
    save: vi.fn(),
    close: vi.fn(),
  } as unknown as MoneroWalletHost;
}

function renderScreen() {
  return render(
    <NavProvider value={NAV}>
      <LiveReceiveMonero onBack={vi.fn()} />
    </NavProvider>,
  );
}

describe('LiveReceiveMonero', () => {
  beforeEach(() => {
    hoisted.state.monero.host = null;
    hoisted.state.monero.chain = { displayName: 'Monero' } as never;
  });
  afterEach(cleanup);

  it('shows a closed banner when no Monero wallet is open', () => {
    renderScreen();
    expect(screen.getByTestId('live-xmr-receive-closed')).toBeTruthy();
  });

  it('shows the primary address in the QR/copy row once loaded, with no picker for a single address', async () => {
    hoisted.state.monero.host = fakeHost([{ major: 0, minor: 0, address: '4primaryAddress', label: '', used: false }]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('live-xmr-receive-address').textContent).toBe('4primaryAddress'));
    expect(screen.queryByTestId('live-xmr-receive-address-picker')).toBeNull();
  });

  it('shows a picker with a Primary label + Used chip when more than one subaddress exists', async () => {
    hoisted.state.monero.host = fakeHost([
      { major: 0, minor: 0, address: '4primaryAddress', label: '', used: true },
      { major: 0, minor: 1, address: '8subOne', label: '', used: false },
    ]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('live-xmr-receive-address-picker')).toBeTruthy());
    expect(screen.getByTestId('live-xmr-receive-addr-0').textContent).toContain('Primary');
    expect(screen.getByTestId('live-xmr-receive-addr-0').textContent).toContain('Used');
    expect(screen.getByTestId('live-xmr-receive-addr-1').textContent).toContain('#1');
  });

  it('selecting a row in the picker switches the shown address', async () => {
    hoisted.state.monero.host = fakeHost([
      { major: 0, minor: 0, address: '4primaryAddress', label: '', used: false },
      { major: 0, minor: 1, address: '8subOne', label: '', used: false },
    ]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('live-xmr-receive-addr-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-xmr-receive-addr-1'));
    expect(screen.getByTestId('live-xmr-receive-address').textContent).toBe('8subOne');
  });

  it('"New address" calls createSubaddress and selects the freshly created one', async () => {
    const host = fakeHost([{ major: 0, minor: 0, address: '4primaryAddress', label: '', used: false }]);
    hoisted.state.monero.host = host;
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('live-xmr-receive-address').textContent).toBe('4primaryAddress'));
    fireEvent.click(screen.getByTestId('live-xmr-receive-new-address'));
    await waitFor(() => expect(host.createSubaddress).toHaveBeenCalledWith(0, ''));
    await waitFor(() => expect(screen.getByTestId('live-xmr-receive-address').textContent).toBe('8new1'));
  });

  it('shows an inline error when subaddresses() fails', async () => {
    hoisted.state.monero.host = {
      ...fakeHost([]),
      subaddresses: vi.fn(async () => { throw new Error('gateway unreachable'); }),
    } as unknown as MoneroWalletHost;
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('live-xmr-receive-load-error').textContent).toBe('gateway unreachable'));
  });

  it('"New address" is created with the typed label, and the label is shown on its row', async () => {
    const host = fakeHost([{ major: 0, minor: 0, address: '4primaryAddress', label: '', used: false }]);
    hoisted.state.monero.host = host;
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('live-xmr-receive-address').textContent).toBe('4primaryAddress'));
    fireEvent.change(screen.getByTestId('live-xmr-receive-new-label'), { target: { value: '  Shop  ' } });
    fireEvent.click(screen.getByTestId('live-xmr-receive-new-address'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-receive-address-picker')).toBeTruthy());
    expect(host.createSubaddress).toHaveBeenCalledWith(0, 'Shop');
    expect(screen.getByTestId('live-xmr-receive-label-1').textContent).toBe('Shop');
    // The field clears for the next one.
    expect((screen.getByTestId('live-xmr-receive-new-label') as HTMLInputElement).value).toBe('');
  });

  it('renders the label AND the used marker of an existing subaddress', async () => {
    hoisted.state.monero.host = fakeHost([
      { major: 0, minor: 0, address: '4primaryAddress', label: '', used: false },
      { major: 0, minor: 1, address: '8subOne', label: 'Alice', used: true },
    ]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('live-xmr-receive-address-picker')).toBeTruthy());
    const row = screen.getByTestId('live-xmr-receive-addr-1');
    expect(row.textContent).toContain('Alice');
    expect(row.textContent).toContain('Used');
    expect(screen.queryByTestId('live-xmr-receive-label-0')).toBeNull();
  });
});
