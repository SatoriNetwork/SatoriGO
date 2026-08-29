// Pure sync-status derivation shared by every surface that shows a connection
// indicator: the wallet tab's block pill (LiveHome) and the compact pill on the
// Activity and Settings tabs (components/SyncStatusPill).
//
// Extracted from LiveHome so a second consumer does not have to import a
// screen. Everything here is a pure function of its arguments — no React, no
// store access — which is what keeps it unit-testable without mounting.

import type { LiveSyncing } from '../../store/liveStore';
import type { NetworkStatus } from '../../types/domain';

export type LedState = 'connected' | 'syncing' | 'offline' | 'stale';

/** How old the chain tip may get before the header says so.
 *
 *  Deliberately ONE conservative number rather than a per-chain target we have
 *  not verified: no chain shipped here aims slower than ten minutes, so this is
 *  at least nine missed blocks on the slowest of them, while a genuinely quiet
 *  stretch on a fast chain never trips it. The label states the AGE, which is a
 *  fact, instead of declaring the chain dead, which would be a guess. */
const TIP_STALE_AFTER_MS = 90 * 60 * 1000;

/** "6h 12m" / "48m" — coarse on purpose; the point is the order of magnitude. */
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Inputs the header sync status (and the LED next to it) is derived from.
 *  Kept as a plain struct rather than reading the store directly so the
 *  derivation itself stays a pure, unit-testable function. */
export interface SyncStatusInput {
  offline: boolean;
  loadingRefresh: boolean;
  syncing: LiveSyncing;
  network: NetworkStatus | null;
  syncProgress: { done: number; total: number } | null;
  lastSyncAt: number | null;
  /** Age of the CHAIN TIP in ms, or null when unknown. Passed in rather than
   *  computed here so this stays a pure function of its arguments. */
  tipAgeMs?: number | null;
}

/** The compact header label + LED color it drives, plus a fuller tooltip
 *  string for the title attribute. */
export interface SyncStatus {
  ledState: LedState;
  /** Short text for the header, e.g. "Synced" / "Syncing 120/3400". */
  label: string;
  /** Fuller text for the title attribute, e.g. "Fully synced". */
  tooltip: string;
}

/**
 * Derive the header sync-status label (and the LED color it shares) from the
 * store's transient sync fields. Priority, highest first:
 *   1. offline                      -> red LED, "Offline"
 *   2. syncProgress non-null        -> yellow LED (pulses), "Syncing X/Y" —
 *      this fires EVEN IF none of the older "syncing" conditions below would,
 *      because a background classification can keep running quietly after
 *      the initial-load flags have all cleared.
 *   3. loadingRefresh / syncing !== 'idle' / no network yet -> "Syncing…"
 *   4. connected + idle + lastSyncAt set   -> green LED, "Synced" (the
 *      "fully synced" signal the owner asked for)
 *   5. connected + idle + lastSyncAt null  -> "Syncing…" (right after unlock,
 *      before the first background sync has completed this session)
 * Pure + exported so this can be unit-tested without mounting the screen.
 */
export function deriveSyncStatus(input: SyncStatusInput): SyncStatus {
  const { offline, loadingRefresh, syncing, network, syncProgress, lastSyncAt } = input;

  if (offline) {
    return { ledState: 'offline', label: 'Offline', tooltip: 'Offline' };
  }

  if (syncProgress) {
    const done = syncProgress.done.toLocaleString('en-US');
    const total = syncProgress.total.toLocaleString('en-US');
    return {
      ledState: 'syncing',
      label: `Syncing ${done}/${total}`,
      tooltip: `Syncing transaction history: ${done} of ${total}`,
    };
  }

  if (loadingRefresh || syncing !== 'idle' || !network) {
    return { ledState: 'syncing', label: 'Syncing…', tooltip: 'Syncing…' };
  }

  if (lastSyncAt != null) {
    // Synced to a chain that has stopped producing blocks. The WALLET is fine,
    // which is exactly why this needs saying: a green "Synced" on a stalled
    // chain tells the user their payment is about to confirm when nothing is
    // going to confirm at all.
    if (input.tipAgeMs != null && input.tipAgeMs > TIP_STALE_AFTER_MS) {
      const age = formatAge(input.tipAgeMs);
      return {
        ledState: 'stale',
        label: `No block ${age}`,
        tooltip: `Synced, but this chain has not produced a block in ${age}. Transactions cannot confirm until it does.`,
      };
    }
    return { ledState: 'connected', label: 'Synced', tooltip: 'Fully synced' };
  }

  // Connected + idle, but no background sync has completed yet this session
  // (e.g. right after unlock, before the detached classification finishes).
  return { ledState: 'syncing', label: 'Syncing…', tooltip: 'Syncing…' };
}

/**
 * First-sync banner copy. With a known delta (syncProgress set) it shows live
 * progress numbers; otherwise it keeps the original open-ended wording, since
 * the total isn't known yet (e.g. the classification hasn't reported its
 * first batch). Pure + exported for tests.
 */
export function formatSyncBannerText(syncProgress: { done: number; total: number } | null): string {
  if (!syncProgress) {
    return 'Syncing wallet data from the blockchain… this can take a while for wallets with history.';
  }
  const done = syncProgress.done.toLocaleString('en-US');
  const total = syncProgress.total.toLocaleString('en-US');
  return `Syncing wallet data from the blockchain… ${done} of ${total} transactions.`;
}


/** Visual pill class for a derived LED state. 'syncing' reuses the pulsing
 *  'connecting' dot (same "in progress" meaning); 'stale' has its own warning
 *  style (global.css). A provider-reported 'degraded' is preserved when the
 *  derivation itself sees a healthy connection.
 *
 *  Shared so the wallet tab's pill and the compact pill on the other tabs can
 *  never drift into showing different colours for one state. */
export function pillStateFor(ledState: LedState, networkState?: string): string {
  if (ledState === 'syncing') return 'connecting';
  if (ledState === 'connected' && networkState === 'degraded') return 'degraded';
  return ledState;
}
