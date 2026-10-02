import { describe, expect, it } from 'vitest';
import {
  ETA_CAP_S,
  estimateSecondsLeft,
  estimateSyncRate,
  formatEta,
  formatSyncProgressLine,
  pushSyncSample,
  syncCounts,
  type SyncSample,
} from './moneroSyncEta';

function feed(points: Array<[number, number]>): SyncSample[] {
  let s: SyncSample[] = [];
  for (const [t, height] of points) s = pushSyncSample(s, { t, height });
  return s;
}

describe('pushSyncSample', () => {
  it('drops samples outside the window but keeps one left edge', () => {
    const s = feed([
      [0, 100],
      [5_000, 200],
      [10_000, 300],
      [30_000, 700],
    ]);
    // cutoff = 10_000: the 10_000 sample is inside, 5_000 is the left edge.
    expect(s.map((x) => x.t)).toEqual([5_000, 10_000, 30_000]);
  });

  it('keeps a left edge when reports are further apart than the window', () => {
    const s = feed([
      [0, 100],
      [60_000, 1_000],
    ]);
    expect(s).toHaveLength(2);
    expect(estimateSyncRate(s)).toBe(15);
  });

  it('starts over when the height goes backwards (a rescan)', () => {
    const s = feed([
      [0, 5_000],
      [10_000, 6_000],
      [11_000, 100],
    ]);
    expect(s).toEqual([{ t: 11_000, height: 100 }]);
  });

  it('ignores a non-finite sample', () => {
    const s = feed([[0, 1]]);
    expect(pushSyncSample(s, { t: NaN, height: 5 })).toEqual(s);
  });
});

describe('estimateSyncRate', () => {
  it('is null until the span is long enough', () => {
    expect(estimateSyncRate([])).toBeNull();
    expect(estimateSyncRate(feed([[0, 0]]))).toBeNull();
    expect(estimateSyncRate(feed([[0, 0], [3_000, 600]]))).toBeNull();
  });

  it('is null with no forward progress', () => {
    expect(estimateSyncRate(feed([[0, 500], [10_000, 500]]))).toBeNull();
  });

  it('averages blocks per second over the window', () => {
    const s = feed([
      [0, 0],
      [4_000, 600],
      [10_000, 1_200],
    ]);
    expect(estimateSyncRate(s)).toBe(120);
  });
});

describe('estimateSecondsLeft / formatEta', () => {
  it('returns null without a rate or with nothing left', () => {
    expect(estimateSecondsLeft(1_000, null)).toBeNull();
    expect(estimateSecondsLeft(1_000, 0)).toBeNull();
    expect(estimateSecondsLeft(1_000, -5)).toBeNull();
    expect(estimateSecondsLeft(0, 10)).toBeNull();
    expect(estimateSecondsLeft(-10, 10)).toBeNull();
    expect(estimateSecondsLeft(1_000, Infinity)).toBeNull();
  });

  it('divides remaining blocks by the rate', () => {
    expect(estimateSecondsLeft(1_800, 10)).toBe(180);
  });

  it('formats minutes, sub-minute and the cap, never negative', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(-3)).toBeNull();
    expect(formatEta(NaN)).toBeNull();
    expect(formatEta(20)).toBe('less than a minute left');
    expect(formatEta(180)).toBe('about 3 min left');
    expect(formatEta(89)).toBe('about 1 min left');
    expect(formatEta(ETA_CAP_S)).toBe('about 60 min left');
    expect(formatEta(ETA_CAP_S + 1)).toBe('more than 1 h left');
    expect(formatEta(1e9)).toBe('more than 1 h left');
  });
});

describe('syncCounts / formatSyncProgressLine', () => {
  it('counts over this scan and floors the percent', () => {
    const p = { height: 101_234, startHeight: 100_000, endHeight: 105_678, percent: 21.7 };
    expect(syncCounts(p)).toEqual({ done: 1_234, total: 5_678, percent: 21, remaining: 4_444 });
    expect(formatSyncProgressLine(p)).toBe('Syncing 1,234 / 5,678 blocks (21%)');
  });

  it('never reads 100% before the last block, and clamps odd input', () => {
    expect(syncCounts({ height: 9_999, startHeight: 0, endHeight: 10_000, percent: 99.99 }).percent).toBe(99);
    expect(syncCounts({ height: 10_000, startHeight: 0, endHeight: 10_000, percent: 100 }).percent).toBe(100);
    expect(syncCounts({ height: 5, startHeight: 10, endHeight: 20, percent: 0 })).toMatchObject({ done: 0, percent: 0 });
    expect(syncCounts({ height: 50, startHeight: 10, endHeight: 20, percent: 100 })).toMatchObject({ done: 10, remaining: 0 });
    expect(syncCounts({ height: 10, startHeight: 10, endHeight: 10, percent: 100 })).toMatchObject({ total: 0, percent: 100 });
  });

  it('has no em-dash', () => {
    expect(formatSyncProgressLine({ height: 1, startHeight: 0, endHeight: 2, percent: 50 })).not.toContain('—');
  });
});
