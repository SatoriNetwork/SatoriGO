// @vitest-environment jsdom
// Needs `document` for React Testing Library render, so this file opts into
// jsdom on its own (the project's default vitest environment is 'node').
//
// Covers KNOWN_LIMITATIONS item 33: the connection state used to exist only on
// the wallet tab, so an empty Activity list could not be told apart from a dead
// connection. The derivation itself is unit-tested in
// screens/live/LiveHome.syncStatus.test.ts; what matters HERE is that the pill
// reads the store, renders the derived label, and colours the dot from the same
// mapping the wallet tab uses.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

interface MockState {
  network: { blockHeight: number; state: string; tipTime?: number } | null;
  loadingRefresh: boolean;
  offline: boolean;
  syncing: string;
  syncProgress: { done: number; total: number } | null;
  lastSyncAt: number | null;
}

// vi.mock factories are hoisted above imports, so the shared mutable state they
// close over must be created via vi.hoisted.
const { getState, setState } = vi.hoisted(() => {
  let state: MockState;
  return {
    getState: () => state,
    setState: (s: MockState) => {
      state = s;
    },
  };
});

vi.mock('../store/liveStore', () => ({
  useLiveStore: (selector: (s: MockState) => unknown) => selector(getState()),
}));

import { SyncStatusPill } from './SyncStatusPill';

const SYNCED: MockState = {
  network: { blockHeight: 1_234_567, state: 'connected', tipTime: Date.now() },
  loadingRefresh: false,
  offline: false,
  syncing: 'idle',
  syncProgress: null,
  lastSyncAt: Date.now(),
};

afterEach(cleanup);

describe('SyncStatusPill', () => {
  it('shows a green dot and "Synced" when fully caught up', () => {
    setState({ ...SYNCED });
    render(<SyncStatusPill />);
    const pill = screen.getByTestId('live-sync-pill');
    expect(pill.textContent).toContain('Synced');
    expect(pill.className).toContain('state-connected');
    expect(pill.querySelector('.dot')?.getAttribute('data-state')).toBe('connected');
  });

  it('says Offline when the wallet has no connection', () => {
    setState({ ...SYNCED, offline: true, network: null });
    render(<SyncStatusPill />);
    const pill = screen.getByTestId('live-sync-pill');
    expect(pill.textContent).toContain('Offline');
    expect(pill.className).toContain('state-offline');
  });

  it('reports live progress while history is downloading', () => {
    setState({ ...SYNCED, syncProgress: { done: 120, total: 3400 } });
    render(<SyncStatusPill />);
    const pill = screen.getByTestId('live-sync-pill');
    expect(pill.textContent).toContain('Syncing 120/3,400');
    // 'syncing' rides on the pulsing 'connecting' style, like the wallet tab.
    expect(pill.className).toContain('state-connecting');
  });

  // The case the wallet tab's pill was rebuilt around: the WALLET is fine, the
  // CHAIN has stopped. Green here would tell the user a payment is about to
  // confirm when nothing is going to confirm.
  it('warns when the chain tip has gone stale', () => {
    setState({ ...SYNCED, network: { blockHeight: 42, state: 'connected', tipTime: Date.now() - 3 * 60 * 60 * 1000 } });
    render(<SyncStatusPill />);
    const pill = screen.getByTestId('live-sync-pill');
    expect(pill.textContent).toContain('No block');
    expect(pill.className).toContain('state-stale');
  });

  it('keeps a provider-reported degraded state visible', () => {
    setState({ ...SYNCED, network: { blockHeight: 42, state: 'degraded', tipTime: Date.now() } });
    render(<SyncStatusPill />);
    expect(screen.getByTestId('live-sync-pill').className).toContain('state-degraded');
  });

  // Unlike the wallet tab's pill, this one must NOT repeat the block height:
  // that is the wallet tab's job and would be noise in a sub-header.
  it('does not show the block height', () => {
    setState({ ...SYNCED });
    render(<SyncStatusPill />);
    expect(screen.getByTestId('live-sync-pill').textContent).not.toContain('1,234,567');
  });
});

// Dot-only variant for the Settings sub-screens' sub-header (KNOWN_LIMITATIONS
// item 33): that slot is a fixed 40px, too narrow for the labelled pill above,
// which clipped "Synced" down to "Sy" when tried there. `compact` must still
// expose the state (colour + accessible name) without ever rendering the label
// as visible text.
describe('SyncStatusPill compact', () => {
  it('renders no visible label text', () => {
    setState({ ...SYNCED });
    render(<SyncStatusPill compact />);
    const pill = screen.getByTestId('live-sync-pill');
    expect(pill.textContent).toBe('');
  });

  it('still colours the dot from the shared derivation', () => {
    setState({ ...SYNCED, syncProgress: { done: 120, total: 3400 } });
    render(<SyncStatusPill compact />);
    const pill = screen.getByTestId('live-sync-pill');
    expect(pill.className).toContain('state-connecting');
    expect(pill.querySelector('.dot')?.getAttribute('data-state')).toBe('syncing');
  });

  it('carries the full state as an accessible name and a hover tooltip', () => {
    setState({ ...SYNCED, syncProgress: { done: 120, total: 3400 } });
    render(<SyncStatusPill compact />);
    const pill = screen.getByRole('img', { name: 'Syncing 120/3,400' });
    expect(pill.getAttribute('title')).toBe('Syncing transaction history: 120 of 3,400');
  });

  it('exposes Offline and Synced the same way the labelled pill does', () => {
    setState({ ...SYNCED, offline: true, network: null });
    render(<SyncStatusPill compact />);
    expect(screen.getByRole('img', { name: 'Offline' }).className).toContain('state-offline');

    cleanup();
    setState({ ...SYNCED });
    render(<SyncStatusPill compact />);
    expect(screen.getByRole('img', { name: 'Synced' }).className).toContain('state-connected');
  });

  // Regression guard for the whole point of `compact`: since the label never
  // becomes a text child, the DOM node it produces is the same shape no matter
  // how long that label gets. Pinned with the longest realistic figure so a
  // future change that slips a text node back in gets caught here rather than
  // by eyeballing a screenshot at 400px again.
  it('stays label-length-independent at the longest realistic progress figure', () => {
    setState({ ...SYNCED, syncProgress: { done: 1204, total: 38110 } });
    render(<SyncStatusPill compact />);
    const pill = screen.getByRole('img', { name: 'Syncing 1,204/38,110' });
    expect(pill.textContent).toBe('');
    expect(pill.children).toHaveLength(1); // just the .dot span
  });
});
