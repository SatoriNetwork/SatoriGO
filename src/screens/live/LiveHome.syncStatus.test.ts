/**
 * Unit tests for the pure sync-status derivation used by LiveHome's header
 * label (data-testid="sync-status") and the first-sync banner
 * (data-testid="live-sync-banner"). Extracted as plain functions so this can
 * be tested thoroughly without mounting the (heavy) LiveHome screen — see
 * deriveSyncStatus / formatSyncBannerText in LiveHome.tsx.
 */

import { describe, expect, it } from 'vitest';
import { deriveSyncStatus, formatSyncBannerText, type SyncStatusInput } from './LiveHome';
import type { NetworkStatus } from '../../types/domain';

const NETWORK: NetworkStatus = {
  networkId: 'mainnet',
  state: 'connected',
  latencyMs: 40,
  blockHeight: 123456,
  serverVersion: 'electrs',
  updatedAt: Date.now(),
};

/** Base "everything is fine and settled" input — each test overrides only
 *  the fields it cares about. */
function baseInput(overrides: Partial<SyncStatusInput> = {}): SyncStatusInput {
  return {
    offline: false,
    loadingRefresh: false,
    syncing: 'idle',
    network: NETWORK,
    syncProgress: null,
    lastSyncAt: Date.now(),
    ...overrides,
  };
}

describe('deriveSyncStatus', () => {
  it('shows "Offline" with a red LED when offline, regardless of other fields', () => {
    const status = deriveSyncStatus(
      baseInput({ offline: true, syncProgress: { done: 1, total: 2 }, lastSyncAt: null }),
    );
    expect(status).toEqual({ ledState: 'offline', label: 'Offline', tooltip: 'Offline' });
  });

  it('shows live progress numbers (localized) while a background classification is running', () => {
    const status = deriveSyncStatus(baseInput({ syncProgress: { done: 120, total: 3400 } }));
    expect(status.ledState).toBe('syncing');
    expect(status.label).toBe('Syncing 120/3,400');
    expect(status.tooltip).toBe('Syncing transaction history: 120 of 3,400');
  });

  it('progress takes priority even when loadingRefresh/syncing/network would otherwise say "connected"', () => {
    // All the "settled" conditions are true (idle, has network, not loading) —
    // only syncProgress being non-null should force the syncing LED + label.
    const status = deriveSyncStatus(
      baseInput({ syncProgress: { done: 5, total: 10 }, loadingRefresh: false, syncing: 'idle' }),
    );
    expect(status.ledState).toBe('syncing');
    expect(status.label).toBe('Syncing 5/10');
  });

  it('falls back to "Syncing…" while loadingRefresh is true (no progress numbers yet)', () => {
    const status = deriveSyncStatus(baseInput({ loadingRefresh: true, syncProgress: null }));
    expect(status).toEqual({ ledState: 'syncing', label: 'Syncing…', tooltip: 'Syncing…' });
  });

  it('falls back to "Syncing…" while syncing is "initial" or "switching"', () => {
    expect(deriveSyncStatus(baseInput({ syncing: 'initial' })).label).toBe('Syncing…');
    expect(deriveSyncStatus(baseInput({ syncing: 'switching' })).label).toBe('Syncing…');
  });

  it('falls back to "Syncing…" when there is no network status yet', () => {
    const status = deriveSyncStatus(baseInput({ network: null }));
    expect(status).toEqual({ ledState: 'syncing', label: 'Syncing…', tooltip: 'Syncing…' });
  });

  it('shows "Synced" with a green LED once connected, idle, and a sync has completed this session', () => {
    const status = deriveSyncStatus(baseInput({ lastSyncAt: 1_700_000_000_000 }));
    expect(status).toEqual({ ledState: 'connected', label: 'Synced', tooltip: 'Fully synced' });
  });

  it('shows "Syncing…" when connected + idle but no sync has completed yet this session', () => {
    // e.g. right after unlock, before the first background classification finishes.
    const status = deriveSyncStatus(baseInput({ lastSyncAt: null }));
    expect(status).toEqual({ ledState: 'syncing', label: 'Syncing…', tooltip: 'Syncing…' });
  });
});

describe('formatSyncBannerText', () => {
  it('keeps the original open-ended wording when the delta is not known yet', () => {
    expect(formatSyncBannerText(null)).toBe(
      'Syncing wallet data from the blockchain… this can take a while for wallets with history.',
    );
  });

  it('shows localized live progress numbers once a delta is known', () => {
    expect(formatSyncBannerText({ done: 120, total: 3400 })).toBe(
      'Syncing wallet data from the blockchain… 120 of 3,400 transactions.',
    );
  });

  it('formats small numbers without thousands separators', () => {
    expect(formatSyncBannerText({ done: 0, total: 7 })).toBe(
      'Syncing wallet data from the blockchain… 0 of 7 transactions.',
    );
  });
});

// A wallet can be perfectly synced to a chain that has stopped producing blocks.
// BitcoinGold did exactly that for hours while real deposits sat unconfirmed,
// and the header still read a green "Synced".
describe('stale chain tip', () => {
  const HOUR = 60 * 60 * 1000;

  it('says how old the tip is instead of claiming everything is fine', () => {
    const status = deriveSyncStatus(
      baseInput({ lastSyncAt: 1_700_000_000_000, tipAgeMs: 6 * HOUR + 12 * 60 * 1000 }),
    );
    expect(status.ledState).toBe('stale');
    expect(status.label).toBe('No block 6h 12m');
    // The tooltip must make clear the WALLET is fine and the chain is not.
    expect(status.tooltip).toMatch(/cannot confirm/i);
  });

  it('stays "Synced" for a quiet but normal gap', () => {
    const status = deriveSyncStatus(
      baseInput({ lastSyncAt: 1_700_000_000_000, tipAgeMs: 20 * 60 * 1000 }),
    );
    expect(status.ledState).toBe('connected');
    expect(status.label).toBe('Synced');
  });

  it('stays "Synced" when the tip age is unknown, rather than accusing the chain', () => {
    for (const tipAgeMs of [null, undefined]) {
      const status = deriveSyncStatus(baseInput({ lastSyncAt: 1_700_000_000_000, tipAgeMs }));
      expect(status.ledState).toBe('connected');
    }
  });

  it('offline still wins: no point reporting tip age we cannot trust', () => {
    const status = deriveSyncStatus(
      baseInput({ offline: true, lastSyncAt: 1_700_000_000_000, tipAgeMs: 9 * HOUR }),
    );
    expect(status.ledState).toBe('offline');
  });

  it('an in-progress sync still wins, since that is the more actionable state', () => {
    const status = deriveSyncStatus(
      baseInput({
        lastSyncAt: 1_700_000_000_000,
        syncProgress: { done: 5, total: 50 },
        tipAgeMs: 9 * HOUR,
      }),
    );
    expect(status.ledState).toBe('syncing');
  });

  it('formats a long outage in days rather than a huge minute count', () => {
    const status = deriveSyncStatus(
      baseInput({ lastSyncAt: 1_700_000_000_000, tipAgeMs: 50 * HOUR }),
    );
    expect(status.label).toBe('No block 2d 2h');
  });
});
