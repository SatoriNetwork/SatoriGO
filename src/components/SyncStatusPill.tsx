import { useLiveStore } from '../store/liveStore';
import { deriveSyncStatus, pillStateFor } from '../screens/live/syncStatus';

/**
 * Compact connection indicator for the tabs that are NOT the wallet tab.
 *
 * The wallet tab shows the chain tip ("Block 1,234,567") with this same dot
 * beside it; repeating the height on Activity and Settings would be noise, so
 * here it is dot + state only. Both surfaces derive from one function
 * (syncStatus.ts), so they can never disagree about the colour.
 *
 * Why it exists: KNOWN_LIMITATIONS item 33 — the connection state used to be
 * visible only on the wallet tab, so a user reading Activity had no way to tell
 * whether an empty list meant "no transactions" or "not connected".
 */
export function SyncStatusPill({
  style,
  compact,
}: {
  style?: React.CSSProperties;
  /** Dot only, no visible label. For spots too narrow for the labelled pill,
   *  e.g. the Settings sub-screens' sub-header, whose right-hand slot is a
   *  fixed 40px (see the Shell comment in LiveSettings.tsx) — the labelled
   *  pill was tried there first and clipped "Synced" down to "Sy". The state
   *  still reaches assistive tech and mouse users via aria-label and title;
   *  only the always-visible text is dropped. */
  compact?: boolean;
}) {
  const network = useLiveStore((s) => s.network);
  const loadingRefresh = useLiveStore((s) => s.loadingRefresh);
  const offline = useLiveStore((s) => s.offline);
  const syncing = useLiveStore((s) => s.syncing);
  const syncProgress = useLiveStore((s) => s.syncProgress);
  const lastSyncAt = useLiveStore((s) => s.lastSyncAt);

  // Tip age is computed here, not inside the derivation, so that stays pure.
  const tipAgeMs = network?.tipTime != null ? Date.now() - network.tipTime : null;
  const status = deriveSyncStatus({
    offline,
    loadingRefresh,
    syncing,
    network,
    syncProgress,
    lastSyncAt,
    tipAgeMs,
  });
  const pillState = pillStateFor(status.ledState, network?.state);

  if (compact) {
    return (
      <span
        className={`pill pill-dot state-${pillState}`}
        data-testid="live-sync-pill"
        title={status.tooltip}
        role="img"
        aria-label={status.label}
        style={{ flexShrink: 0, ...style }}
      >
        <span className="dot" data-state={status.ledState} aria-hidden />
      </span>
    );
  }

  return (
    <span
      className={`pill state-${pillState}`}
      data-testid="live-sync-pill"
      title={status.tooltip}
      style={{ flexShrink: 0, ...style }}
    >
      <span className="dot" data-state={status.ledState} aria-hidden />
      {status.label}
    </span>
  );
}
