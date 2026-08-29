// Day headers for the Home activity list.
//
// Pure + exported (no store access, no I/O, `now` is passed in) so the UI and
// the unit tests share the exact same behavior, like activityFeed.ts next door.
//
// Two deliberate choices:
//
//   * The month names are HARDCODED English abbreviations rather than
//     toLocaleDateString(). The rest of this list already prints locale-free
//     text, and a locale-driven header would make the label depend on the
//     browser's language while the row under it does not — and would make the
//     unit test depend on the machine's ICU data.
//
//   * "Today" / "Yesterday" are decided by LOCAL midnight boundaries, not by a
//     24-hour subtraction. A transaction at 23:50 and one at 00:10 belong to
//     different days even though they are 20 minutes apart, and that is what a
//     user reading the list means by "yesterday". Comparing two local midnights
//     also survives a DST change (a 23- or 25-hour day still counts as one).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DAY_MS = 86_400_000;

/** Local midnight (epoch ms) of the day a timestamp falls in. */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** An item with no usable timestamp. In practice a row like this is a locally
 *  built pending send that has not been stamped yet: it belongs at the top of
 *  the list under its own header, not under a 1970 date. */
function isUndated(ts: number): boolean {
  return !Number.isFinite(ts) || ts <= 0;
}

/** Header text for one timestamp: "Pending", "Today", "Yesterday", or a
 *  locale-free date like "14 Aug 2026". */
export function dayLabel(timestamp: number, now: number): string {
  if (isUndated(timestamp)) return 'Pending';
  const d = new Date(timestamp);
  // Whole days between the two local midnights. Math.round (not floor) is what
  // absorbs the 1-hour DST wobble.
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(timestamp)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Testid-safe slug of a header label ("14 Aug 2026" -> "14-aug-2026"). */
export function daySlug(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '-');
}

/** One day's worth of consecutive activity rows, with the header above them. */
export interface ActivityDayGroup<T> {
  /** "Pending" | "Today" | "Yesterday" | "14 Aug 2026". */
  label: string;
  /** `daySlug(label)`, for the header's testid. */
  slug: string;
  items: T[];
}

/**
 * Split an ALREADY-ORDERED activity list into consecutive day groups, in the
 * order the rows are shown. Undated (pending) rows are pulled out into a
 * "Pending" group at the TOP, whatever position they held in the input — a send
 * that has not confirmed is the one row the user is looking for.
 *
 * Sorting is not this function's job: the caller passes the merged, filtered,
 * paginated list exactly as it will render, so a header can never claim a day
 * the rows under it do not belong to.
 */
export function groupActivityByDay<T extends { timestamp: number }>(
  items: T[],
  now: number,
): ActivityDayGroup<T>[] {
  const pending = items.filter((i) => isUndated(i.timestamp));
  const groups: ActivityDayGroup<T>[] = [];
  if (pending.length > 0) groups.push({ label: 'Pending', slug: 'pending', items: pending });
  for (const item of items) {
    if (isUndated(item.timestamp)) continue;
    const label = dayLabel(item.timestamp, now);
    const last = groups[groups.length - 1];
    // A dated item never yields "Pending", so a plain label match is enough to
    // decide whether it extends the previous group.
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, slug: daySlug(label), items: [item] });
  }
  return groups;
}
