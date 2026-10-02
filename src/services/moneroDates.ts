// Monero date maths with no engine code behind it: the date -> restore-height
// estimator and the date-field rules. Lives OUTSIDE src/services/chain/monero/
// on purpose: the network switcher (main bundle) uses it, and a build without
// the Monero engine must not pull anything from that directory (vite.config.ts
// leak check). chain/monero/rpc.ts and restoreDate.ts re-export from here.

//
// "First used around <date>" -> a Monero restore height (§6.6).
//
// A thin, UI-facing wrapper over estimateHeightForDate (rpc.ts), which already
// does the arithmetic (the 120 s line since the anchor, the 60 s line before
// the v2 fork) and already starts one week of blocks EARLIER than the date as
// its safety margin. What this adds is the input rules the date fields share:
//   - the value is an <input type="date"> string, YYYY-MM-DD, read as UTC
//     midnight (the week of margin absorbs any time zone);
//   - a date after today is refused (a phrase cannot have been used tomorrow);
//   - a date before Monero's genesis clamps to it (height 0), never an error;
//   - an empty value means "no date", so the caller keeps its old behaviour.


/** A block every 120 s, Monero's target since v2. */
const BLOCK_SECONDS = 120;

/** The estimator's anchor: the gateway reported height 3772368 at about
 *  2026-09-28T13:50Z (measured during the research, §6.6). */
const ANCHOR_HEIGHT = 3772368;
const ANCHOR_TIME_MS = Date.UTC(2026, 8, 28, 13, 50, 0);

/** Before the v2 hard fork Monero targeted a block every 60 s, twice today's
 *  rate. The fork activated at height 1,009,827 on 2016-03-23. A single
 *  120 s line drawn back from today's anchor therefore lands ABOVE the real
 *  height for every date before the fork (the chain grew faster than the line
 *  assumes), which is the one direction an estimate must never err in: a
 *  wallet from 2015 would start scanning about 200,000 blocks after its first
 *  receipts. Dates before the fork are estimated from the fork itself at 60 s
 *  blocks instead. The fork's time of day is rounded down to midnight UTC,
 *  which only pushes the estimate lower (safer); the week of margin covers it. */
const V2_FORK_HEIGHT = 1009827;
const V2_FORK_TIME_MS = Date.UTC(2016, 2, 23, 0, 0, 0);
const V1_BLOCK_SECONDS = 60;

/** Safety margin subtracted from a date estimate: one week of blocks. The
 *  estimate drifts with real block times (a few percent either way over a
 *  year), and starting a week early costs about 5,000 blocks (a couple of
 *  minutes) while starting a day late loses funds from view. */
const ESTIMATE_MARGIN_BLOCKS = 5040;

/**
 * A restore height for an imported wallet created on `date` (§6.6).
 *
 *   height = anchorHeight + (date - anchorTime) / 120 s - one week of blocks
 *
 * clamped to [0, estimated tip at `now`]. A date in the future is read as
 * `now` (a wallet cannot have been created tomorrow). A local estimate rather
 * than monero-ts's getHeightByDate: that costs 12 round trips and 5 to 14 s,
 * and the week of margin already absorbs block-time drift.
 *
 * Two segments, because the block time halved at the v2 fork (see
 * V2_FORK_HEIGHT): the 120 s line from today's anchor, and a 60 s line from
 * the fork for the years before it. The answer is the LOWER of the two, which
 * is the accurate one on each side of the fork and keeps the function
 * monotonic through it (both lines rise with the date, so their minimum does).
 */
export function estimateHeightForDate(date: Date, now: Date = new Date()): number {
  const t = date instanceof Date ? date.getTime() : Number.NaN;
  const n = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(t)) throw new Error('Not a valid date.');
  const at = Number.isFinite(n) ? Math.min(t, n) : t;
  const sinceAnchor = ANCHOR_HEIGHT + Math.floor((at - ANCHOR_TIME_MS) / 1000 / BLOCK_SECONDS);
  const sinceFork = V2_FORK_HEIGHT + Math.floor((at - V2_FORK_TIME_MS) / 1000 / V1_BLOCK_SECONDS);
  const est = Math.min(sinceAnchor, sinceFork) - ESTIMATE_MARGIN_BLOCKS;
  return Math.max(0, est);
}

/** Monero's genesis block (2014-04-18): the earliest a date field accepts. */
export const MONERO_GENESIS_DATE = '2014-04-18';

/** Today as the date input reads it: the LOCAL calendar date, YYYY-MM-DD.
 *  Local, not UTC, because that is what the browser's picker offers as today. */
export function localIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export type RestoreDateResult =
  | { kind: 'empty' }
  | { kind: 'ok'; height: number; clamped: boolean }
  | { kind: 'error'; error: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Turns a date field's value into a restore height, or says why it cannot.
 * `now` is injectable for tests.
 */
export function restoreHeightFromDate(value: string, now: Date = new Date()): RestoreDateResult {
  const trimmed = value.trim();
  if (trimmed === '') return { kind: 'empty' };
  const m = ISO_DATE.exec(trimmed);
  if (!m) return { kind: 'error', error: 'Enter a valid date.' };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  // Rejects 2024-02-31 and friends, which Date.UTC would silently roll over.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return { kind: 'error', error: 'Enter a valid date.' };
  }
  // String compare is safe: both are zero-padded YYYY-MM-DD.
  if (trimmed > localIsoDate(now)) return { kind: 'error', error: 'That date is in the future.' };
  const clamped = trimmed < MONERO_GENESIS_DATE;
  // Genesis is height 0, and the estimator already floors there.
  const height = clamped ? 0 : estimateHeightForDate(check, now);
  return { kind: 'ok', height, clamped };
}
