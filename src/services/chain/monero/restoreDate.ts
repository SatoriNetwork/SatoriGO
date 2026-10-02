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

import { estimateHeightForDate } from './rpc';

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
