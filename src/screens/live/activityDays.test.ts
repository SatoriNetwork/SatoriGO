import { describe, expect, it } from 'vitest';
import { dayLabel, daySlug, groupActivityByDay } from './activityDays';

/** Local-time epoch ms — the helper works on LOCAL midnights, so the fixtures
 *  must be built in local time too or the test would only pass in UTC. */
const at = (y: number, m: number, d: number, hh = 12, mm = 0, ss = 0) =>
  new Date(y, m - 1, d, hh, mm, ss).getTime();

const NOW = at(2026, 8, 19, 14, 30);

const row = (timestamp: number, id = String(timestamp)) => ({ id, timestamp });

describe('dayLabel', () => {
  it('names today, yesterday, and an older day', () => {
    expect(dayLabel(at(2026, 8, 19, 9, 5), NOW)).toBe('Today');
    expect(dayLabel(at(2026, 8, 18, 23, 59), NOW)).toBe('Yesterday');
    expect(dayLabel(at(2026, 8, 14, 10, 0), NOW)).toBe('14 Aug 2026');
  });

  it('uses English month abbreviations and no leading zero on the day', () => {
    expect(dayLabel(at(2026, 1, 3), NOW)).toBe('3 Jan 2026');
    expect(dayLabel(at(2025, 12, 31), NOW)).toBe('31 Dec 2025');
  });

  it('breaks at LOCAL midnight, not on a 24-hour window', () => {
    // 20 minutes apart, but on either side of midnight -> different days.
    expect(dayLabel(at(2026, 8, 19, 0, 10), NOW)).toBe('Today');
    expect(dayLabel(at(2026, 8, 18, 23, 50), NOW)).toBe('Yesterday');
    // Exactly local midnight belongs to the day it starts.
    expect(dayLabel(at(2026, 8, 19, 0, 0, 0), NOW)).toBe('Today');
    expect(dayLabel(at(2026, 8, 18, 0, 0, 0), NOW)).toBe('Yesterday');
    // One millisecond earlier is the day before that.
    expect(dayLabel(at(2026, 8, 18, 0, 0, 0) - 1, NOW)).toBe('17 Aug 2026');
  });

  it('is relative to `now`, not to the wall clock', () => {
    const laterNow = at(2026, 8, 20, 1, 0);
    expect(dayLabel(at(2026, 8, 19, 9, 5), laterNow)).toBe('Yesterday');
    expect(dayLabel(at(2026, 8, 18, 9, 5), laterNow)).toBe('18 Aug 2026');
  });

  it('calls an undated row Pending', () => {
    expect(dayLabel(0, NOW)).toBe('Pending');
    expect(dayLabel(-1, NOW)).toBe('Pending');
    expect(dayLabel(Number.NaN, NOW)).toBe('Pending');
  });
});

describe('daySlug', () => {
  it('makes a testid-safe slug', () => {
    expect(daySlug('Today')).toBe('today');
    expect(daySlug('Yesterday')).toBe('yesterday');
    expect(daySlug('14 Aug 2026')).toBe('14-aug-2026');
    expect(daySlug('Pending')).toBe('pending');
  });
});

describe('groupActivityByDay', () => {
  it('returns nothing for an empty list', () => {
    expect(groupActivityByDay([], NOW)).toEqual([]);
  });

  it('groups consecutive rows of one day under one header, in list order', () => {
    const items = [
      row(at(2026, 8, 19, 18, 0), 'a'),
      row(at(2026, 8, 19, 8, 0), 'b'),
      row(at(2026, 8, 18, 20, 0), 'c'),
      row(at(2026, 8, 14, 11, 0), 'd'),
      row(at(2026, 8, 14, 9, 0), 'e'),
    ];
    const groups = groupActivityByDay(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', '14 Aug 2026']);
    expect(groups.map((g) => g.slug)).toEqual(['today', 'yesterday', '14-aug-2026']);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a', 'b'], ['c'], ['d', 'e']]);
  });

  it('keeps every input row exactly once', () => {
    const items = [
      row(at(2026, 8, 19, 18, 0), 'a'),
      row(0, 'p'),
      row(at(2026, 8, 14, 9, 0), 'e'),
    ];
    const flat = groupActivityByDay(items, NOW).flatMap((g) => g.items.map((i) => i.id));
    expect(flat.slice().sort()).toEqual(['a', 'e', 'p']);
  });

  it('hoists undated (pending) rows to a Pending group on top', () => {
    const items = [
      row(at(2026, 8, 19, 18, 0), 'a'),
      row(0, 'p1'),
      row(at(2026, 8, 14, 9, 0), 'e'),
      row(0, 'p2'),
    ];
    const groups = groupActivityByDay(items, NOW);
    expect(groups[0].label).toBe('Pending');
    expect(groups[0].items.map((i) => i.id)).toEqual(['p1', 'p2']);
    expect(groups.slice(1).map((g) => g.label)).toEqual(['Today', '14 Aug 2026']);
  });

  it('does not open a Pending group when every row is dated', () => {
    const groups = groupActivityByDay([row(at(2026, 8, 19, 1, 0), 'a')], NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today']);
  });

  it('re-opens a day header when a later day comes back around', () => {
    // The caller passes rows in display order; if that order is not sorted the
    // headers must still describe the rows under them, never merge across.
    const items = [
      row(at(2026, 8, 19, 18, 0), 'a'),
      row(at(2026, 8, 14, 9, 0), 'b'),
      row(at(2026, 8, 19, 2, 0), 'c'),
    ];
    expect(groupActivityByDay(items, NOW).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['a']],
      ['14 Aug 2026', ['b']],
      ['Today', ['c']],
    ]);
  });
});
