import { describe, expect, it } from 'vitest';
import { estimateHeightForDate, MONERO_RELEASE_HEIGHT } from './rpc';
import { localIsoDate, MONERO_GENESIS_DATE, restoreHeightFromDate } from './restoreDate';

const NOW = new Date(2026, 8, 29, 12, 0, 0); // local noon, 2026-09-29

describe('localIsoDate', () => {
  it('formats the local calendar date, zero padded', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localIsoDate(NOW)).toBe('2026-09-29');
  });
});

describe('restoreHeightFromDate', () => {
  it('an empty value means no date', () => {
    expect(restoreHeightFromDate('', NOW)).toEqual({ kind: 'empty' });
    expect(restoreHeightFromDate('   ', NOW)).toEqual({ kind: 'empty' });
  });

  it('uses the shared estimator, which starts a week of blocks before the date', () => {
    const r = restoreHeightFromDate('2025-06-01', NOW);
    const expected = estimateHeightForDate(new Date(Date.UTC(2025, 5, 1)), NOW);
    expect(r).toEqual({ kind: 'ok', height: expected, clamped: false });
    // The estimator's one-week margin (5040 blocks at 120 s) is below the
    // plain block count for that date.
    expect(expected).toBeLessThan(MONERO_RELEASE_HEIGHT);
  });

  it('an older date gives a lower height', () => {
    const a = restoreHeightFromDate('2020-01-01', NOW);
    const b = restoreHeightFromDate('2024-01-01', NOW);
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    if (a.kind === 'ok' && b.kind === 'ok') expect(a.height).toBeLessThan(b.height);
  });

  it('accepts today', () => {
    expect(restoreHeightFromDate('2026-09-29', NOW).kind).toBe('ok');
  });

  it('refuses a future date', () => {
    expect(restoreHeightFromDate('2026-09-30', NOW)).toEqual({ kind: 'error', error: 'That date is in the future.' });
  });

  it('clamps a date before the genesis to height 0', () => {
    expect(restoreHeightFromDate('2010-01-01', NOW)).toEqual({ kind: 'ok', height: 0, clamped: true });
    expect(restoreHeightFromDate(MONERO_GENESIS_DATE, NOW)).toMatchObject({ kind: 'ok', clamped: false });
  });

  it('refuses malformed and impossible dates', () => {
    expect(restoreHeightFromDate('yesterday', NOW).kind).toBe('error');
    expect(restoreHeightFromDate('2024-02-31', NOW).kind).toBe('error');
  });
});
