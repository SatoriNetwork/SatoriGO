/**
 * The Monero home's sync progress line and its time-left estimate. Pure
 * functions: the component (MoneroSyncProgress.tsx) keeps the samples and
 * the clock, everything here is arithmetic on them.
 *
 * Where the numbers come from: the worker's wallet2 listener reports
 * (height, endHeight) once per getblocks batch, the scanner turns that into a
 * MoneroSyncProgress measured over THIS scan (toSyncProgress: startHeight is
 * where the scan began, percent is 0..100 over startHeight..endHeight), and
 * the store copies it into `monero.sync`. Each new report becomes one sample
 * here.
 */
import type { MoneroSyncProgress } from '../../services/chain/monero/scanner';

export interface SyncSample {
  /** ms timestamp the report arrived. */
  t: number;
  height: number;
}

/** How far back the rate looks: long enough to smooth over wallet2's batchy
 *  reports (about 600 blocks each), short enough to follow a slowdown. */
export const RATE_WINDOW_MS = 20_000;
/** A rate over less than this is not shown: the first batch or two land in a
 *  burst and would promise an ETA the next batch breaks. */
export const MIN_RATE_SPAN_MS = 8_000;
/** Above this the ETA is only "more than 1 h left". */
export const ETA_CAP_S = 3600;

/**
 * Add one report to the sample window. A height that went BACKWARDS (a rescan
 * started, or a checkpoint restart lost ground) starts the window over, since
 * the old samples describe a different scan. Samples older than the window
 * are dropped, but the newest of those is kept as the window's left edge so a
 * slow scan with reports further apart than the window still has two points.
 */
export function pushSyncSample(samples: readonly SyncSample[], next: SyncSample, windowMs = RATE_WINDOW_MS): SyncSample[] {
  if (!Number.isFinite(next.t) || !Number.isFinite(next.height)) return [...samples];
  const last = samples[samples.length - 1];
  if (last && (next.height < last.height || next.t < last.t)) return [next];
  if (last && next.height === last.height && next.t === last.t) return [...samples];
  const all = [...samples, next];
  const cutoff = next.t - windowMs;
  let firstInside = all.findIndex((s) => s.t >= cutoff);
  if (firstInside < 0) firstInside = all.length - 1;
  // Keep one sample at or before the cutoff as the left edge.
  const from = Math.max(0, firstInside - 1);
  return all.slice(from);
}

/**
 * Blocks per second over the window, or null when there is no stable rate yet:
 * fewer than two samples, a span shorter than MIN_RATE_SPAN_MS, or no forward
 * progress. Measured over at most the last `windowMs` (the left-edge sample
 * pushSyncSample keeps may sit a little before the window; it is used as is,
 * since it is the best point there is).
 */
export function estimateSyncRate(samples: readonly SyncSample[], minSpanMs = MIN_RATE_SPAN_MS): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanMs = last.t - first.t;
  const blocks = last.height - first.height;
  if (!(spanMs >= minSpanMs) || !(blocks > 0)) return null;
  const rate = blocks / (spanMs / 1000);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Seconds left at `rate`, or null when it cannot be said honestly. */
export function estimateSecondsLeft(remainingBlocks: number, rate: number | null): number | null {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null;
  if (!Number.isFinite(remainingBlocks) || remainingBlocks <= 0) return null;
  const s = remainingBlocks / rate;
  return Number.isFinite(s) && s > 0 ? s : null;
}

/** "about 3 min left", "less than a minute left", "more than 1 h left", or
 *  null (nothing shown) for no estimate. */
export function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds > ETA_CAP_S) return 'more than 1 h left';
  if (seconds < 60) return 'less than a minute left';
  const min = Math.min(60, Math.round(seconds / 60));
  return `about ${min} min left`;
}

/** Blocks done and to do in this scan, and a whole percent that never reads
 *  100 before the last block (floored), clamped to 0..100. */
export function syncCounts(p: MoneroSyncProgress): { done: number; total: number; percent: number; remaining: number } {
  const total = Math.max(0, p.endHeight - p.startHeight);
  const done = Math.min(total, Math.max(0, p.height - p.startHeight));
  const raw = total > 0 ? (done / total) * 100 : 100;
  const percent = Math.min(100, Math.max(0, Math.floor(raw)));
  return { done, total, percent, remaining: total - done };
}

/** "Syncing 1,234 / 5,678 blocks (22%)". */
export function formatSyncProgressLine(p: MoneroSyncProgress): string {
  const { done, total, percent } = syncCounts(p);
  return `Syncing ${done.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} blocks (${percent}%)`;
}
