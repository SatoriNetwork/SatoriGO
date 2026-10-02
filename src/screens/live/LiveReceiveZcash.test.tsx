/**
 * @vitest-environment jsdom
 *
 * LiveReceiveZcash against a MOCKED store: the real liveStore.ts does not
 * carry a `zcash` slice yet (Set D's wiring lands separately, §15), so this
 * test stands in a minimal fake with exactly the shape the Set D surface
 * promises (`zcash: { chain, snapshot, error, status }`, `wallets`,
 * `activeWalletId`), the same discipline LiveReceiveMonero.test.tsx already
 * uses for its own not-yet-wired `monero` slice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  state: {
    wallets: [] as Array<{ id: string; family: string; address: string }>,
    activeWalletId: null as string | null,
    zcash: { chain: { displayName: 'Zcash' } as unknown, snapshot: null, error: null, status: 'idle' },
  },
}));

vi.mock('../../store/liveStore', () => {
  const useLiveStore = (selector: (s: typeof hoisted.state) => unknown) => selector(hoisted.state);
  useLiveStore.getState = () => hoisted.state;
  return { useLiveStore };
});

import { LiveReceiveZcash } from './LiveReceiveZcash';
import { NavProvider, type NavContextValue } from './LiveNav';

const NAV: NavContextValue = { tab: 'assets', section: 'home', openTab: vi.fn(), openSettings: vi.fn() };

function renderScreen() {
  return render(
    <NavProvider value={NAV}>
      <LiveReceiveZcash onBack={vi.fn()} />
    </NavProvider>,
  );
}

describe('LiveReceiveZcash', () => {
  beforeEach(() => {
    hoisted.state.wallets = [];
    hoisted.state.activeWalletId = null;
  });
  afterEach(cleanup);

  it('shows a closed banner when no Zcash wallet is active', () => {
    renderScreen();
    expect(screen.getByTestId('live-zec-receive-closed')).toBeTruthy();
  });

  it('shows a closed banner when the active wallet is not a zcash wallet', () => {
    hoisted.state.wallets = [{ id: 'w1', family: 'utxo', address: 'EVRaddr' }];
    hoisted.state.activeWalletId = 'w1';
    renderScreen();
    expect(screen.getByTestId('live-zec-receive-closed')).toBeTruthy();
  });

  it('shows the one t1 address, no picker, no "new address"', () => {
    hoisted.state.wallets = [{ id: 'w1', family: 'zcash', address: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F' }];
    hoisted.state.activeWalletId = 'w1';
    renderScreen();
    expect(screen.getByTestId('live-zec-receive-address').textContent).toBe('t1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F');
    expect(screen.queryByTestId('live-zec-receive-new-address')).toBeNull();
    expect(screen.getByTestId('live-zec-receive-qr')).toBeTruthy();
  });

  it('shows the transparent-is-public disclosure line', () => {
    hoisted.state.wallets = [{ id: 'w1', family: 'zcash', address: 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F' }];
    hoisted.state.activeWalletId = 'w1';
    renderScreen();
    expect(screen.getByTestId('live-zec-receive').textContent).toContain('Shielded Zcash is not supported');
  });

  it('shows the chain display name from the store row', () => {
    hoisted.state.wallets = [{ id: 'w1', family: 'zcash', address: 't1addr' }];
    hoisted.state.activeWalletId = 'w1';
    hoisted.state.zcash.chain = { displayName: 'Zcash' } as unknown;
    renderScreen();
    expect(screen.getByTestId('live-zec-receive-network').textContent).toContain('Zcash');
  });
});
