/**
 * The Monero home's progress indicator while wallet2 scans: a thin bar, the
 * "Syncing X / Y blocks (N%)" line and, once the rate is stable, the time
 * left. Rendered inside live-xmr-sync only while status is 'syncing' and a
 * progress report exists; it blocks nothing (balance and actions render as
 * before around it). The arithmetic is in moneroSyncEta.ts.
 */
import { useState } from 'react';
import type { MoneroSyncProgress as MoneroSyncProgressData } from '../../services/chain/monero/scanner';
import {
  estimateSecondsLeft,
  estimateSyncRate,
  formatEta,
  formatSyncProgressLine,
  pushSyncSample,
  syncCounts,
  type SyncSample,
} from './moneroSyncEta';

interface Props {
  sync: MoneroSyncProgressData;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export function MoneroSyncProgress({ sync, now = Date.now }: Props) {
  // One sample per progress report (the store hands a new object per
  // report). Updated during render when the report changes, React's
  // "adjust state on prop change" pattern, so no effect lag.
  const [track, setTrack] = useState<{ sync: MoneroSyncProgressData | null; start: number; samples: SyncSample[] }>(
    () => ({ sync, start: sync.startHeight, samples: [{ t: now(), height: sync.height }] }),
  );
  let samples = track.samples;
  if (track.sync !== sync) {
    const sample = { t: now(), height: sync.height };
    samples = sync.startHeight !== track.start ? [sample] : pushSyncSample(track.samples, sample);
    setTrack({ sync, start: sync.startHeight, samples });
  }

  const { percent, remaining } = syncCounts(sync);
  const eta = formatEta(estimateSecondsLeft(remaining, estimateSyncRate(samples)));

  return (
    <div data-testid="live-xmr-sync-progress" data-percent={percent}>
      <div
        role="progressbar"
        aria-label="Monero sync progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        style={{
          height: 3,
          borderRadius: 2,
          background: 'var(--border-strong)',
          overflow: 'hidden',
          margin: '2px auto 5px',
          maxWidth: 220,
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            background: 'var(--accent)',
            borderRadius: 2,
            transition: 'width 300ms ease-out',
          }}
        />
      </div>
      <div data-testid="live-xmr-sync-line">{formatSyncProgressLine(sync)}</div>
      <div data-testid="live-xmr-sync-eta">
        {eta ? `${eta[0].toUpperCase()}${eta.slice(1)}. ` : ''}Keep this window open.
      </div>
    </div>
  );
}
