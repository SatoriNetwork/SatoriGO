/**
 * @vitest-environment jsdom
 *
 * LiveReceiveTao against a MOCKED store: the real liveStore.ts does not carry
 * `wallets`/`activeWalletId` wired for a substrate entry yet (Set D's wiring
 * lands separately, §15), so this test stands in a minimal fake with exactly
 * the generic shape every chain's Receive screen already reads
 * (`wallets`, `activeWalletId`), rather than pulling in the whole real store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

interface FakeWallet {
  id: string;
  address?: string;
}

const hoisted = vi.hoisted(() => ({
  state: { wallets: [] as FakeWallet[], activeWalletId: 'w1' },
}));

vi.mock('../../store/liveStore', () => {
  const useLiveStore = (selector: (s: typeof hoisted.state) => unknown) => selector(hoisted.state);
  useLiveStore.getState = () => hoisted.state;
  return { useLiveStore };
});

import { LiveReceiveTao } from './LiveReceiveTao';
import { NavProvider, type NavContextValue } from './LiveNav';

const NAV: NavContextValue = { tab: 'assets', section: 'home', openTab: vi.fn(), openSettings: vi.fn() };

function renderScreen() {
  return render(
    <NavProvider value={NAV}>
      <LiveReceiveTao onBack={vi.fn()} />
    </NavProvider>,
  );
}

const ADDR = '5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH';

describe('LiveReceiveTao', () => {
  beforeEach(() => {
    hoisted.state.wallets = [];
    hoisted.state.activeWalletId = 'w1';
  });
  afterEach(cleanup);

  it('shows a closed banner when the active wallet has no address yet', () => {
    hoisted.state.wallets = [{ id: 'w1' }];
    renderScreen();
    expect(screen.getByTestId('live-tao-receive-closed')).toBeTruthy();
  });

  it('shows the address in the QR/copy row', () => {
    hoisted.state.wallets = [{ id: 'w1', address: ADDR }];
    renderScreen();
    expect(screen.getByTestId('live-tao-receive-address').textContent).toBe(ADDR);
  });

  it('the copy button carries the real address', () => {
    hoisted.state.wallets = [{ id: 'w1', address: ADDR }];
    renderScreen();
    expect(screen.getByTestId('live-tao-receive-copy')).toBeTruthy();
  });

  it('links to taostats.io account history for THIS address (the v1 Activity surface)', () => {
    hoisted.state.wallets = [{ id: 'w1', address: ADDR }];
    renderScreen();
    const link = screen.getByTestId('live-tao-receive-taostats-link') as HTMLAnchorElement;
    expect(link.href).toBe(`https://taostats.io/account/${ADDR}`);
    expect(link.target).toBe('_blank');
  });

  it('names btcli and polkadot.js in the derivation line (owner-approval-needed copy, design §10)', () => {
    hoisted.state.wallets = [{ id: 'w1', address: ADDR }];
    renderScreen();
    expect(screen.getByText(/btcli and polkadot\.js/)).toBeTruthy();
  });

  it('uses no em dash anywhere on the screen (project copy rule)', () => {
    hoisted.state.wallets = [{ id: 'w1', address: ADDR }];
    const { container } = renderScreen();
    expect(container.textContent).not.toMatch(/—/);
  });
});
