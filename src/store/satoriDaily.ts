// Satori rewards per day, for the Rewards screen.
//
// The Merkle drop publishes one number per address: everything earned so far.
// What each day added is only in the central server's public audit files, one
// set per UTC date, covering every address on the network. So the wallet
// downloads a day's files (its address is not sent anywhere for this), works out
// its own figure here, and keeps only that figure.
//
// Checked 2026-11-04 against the live drop: these sums equal the Merkle
// entitlement for 169 of its 172 addresses. The drop starts at 2026-11-02; older
// dated files are Evrmore-era and are not claimable on Base. The other 3 are why
// the screen shows any difference from the contract's number instead of hiding it.

import { getStorage } from '../services/storage';
import { fetchSatoriAuditCsv } from '../services/satoriPool';

/** The first UTC day the Base Merkle drop counts. */
export const SATORI_DROP_FIRST_DAY = '2026-11-02';
export const SATORI_DAYS_PAGE = 14;

const DAY_MS = 86_400_000;
const SATORI_BASE = 18;
/** The drop rounds to 8 decimals and the audit files to 12. */
export const SATORI_DAY_TOLERANCE_BASE = 10n ** 12n;

export interface SatoriDayFigures {
  /** Earned by this address's neurons, after what a pool paid its lenders. */
  neuronsBase: bigint;
  /** Earned by lending to pools. */
  lendingBase: bigint;
  totalBase: bigint;
}

/** 'later': earned, but not in the drop yet. */
export type SatoriDayStatus = 'claimed' | 'part' | 'waiting' | 'later';

/** A plain decimal, or the exponent form a database may print, as base units. */
export function auditDecimalToBase(text: string): bigint {
  const m = /^(-?)(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m || (!m[2] && !m[3])) return 0n;
  const scale = SATORI_BASE + Number(m[4] ?? 0) - m[3].length;
  const digits = BigInt(`${m[2]}${m[3]}` || '0');
  const base = scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale);
  return m[1] ? -base : base;
}

/** The rows of an audit file, each handed over as a column lookup. Its columns
 *  are addresses and numbers, so there is no quoting to honour. Throws on anything
 *  else, say a proxy's error page sent with a 200: read as a file with no rows it
 *  would be kept as a day that earned nothing. */
function forEachAuditRow(
  csv: string,
  columns: readonly string[],
  visit: (get: (column: string) => string) => void,
): void {
  const lines = csv.split('\n');
  const index = new Map((lines[0] ?? '').trim().split(',').map((name, i) => [name, i] as const));
  if (columns.some((column) => !index.has(column))) throw new Error('satoriDaily: not an audit file');
  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    rows++;
    const cells = line.split(',');
    const at = (column: string) => cells[index.get(column) ?? -1] ?? '';
    visit(at);
  }
  if (rows === 0) throw new Error('satoriDaily: an audit file with no rows');
}

/**
 * One day's figures for `addresses`. A neuron's reward goes to its reward address
 * (its own wallet when none is set). A pool's lender is paid out of what the pool
 * earned, so the same amount moves from the pool's reward address (its wallet when
 * none is set) to the lender's (likewise).
 */
export function satoriDayFigures(
  predictorsCsv: string,
  stakersCsv: string,
  addresses: readonly string[],
): Map<string, SatoriDayFigures> {
  const out = new Map<string, SatoriDayFigures>(
    addresses.map((a) => [a.toLowerCase(), { neuronsBase: 0n, lendingBase: 0n, totalBase: 0n }]),
  );
  forEachAuditRow(predictorsCsv, ['reward_address', 'wallet_address', 'total'], (get) => {
    const row = out.get((get('reward_address') || get('wallet_address')).toLowerCase());
    if (row) row.neuronsBase += auditDecimalToBase(get('total'));
  });
  forEachAuditRow(stakersCsv, ['lender_reward', 'lender_wallet', 'pool_reward', 'pool_wallet', 'reward_calculated'], (get) => {
    const lender = out.get((get('lender_reward') || get('lender_wallet')).toLowerCase());
    const pool = out.get((get('pool_reward') || get('pool_wallet')).toLowerCase());
    if (!lender && !pool) return;
    const paid = auditDecimalToBase(get('reward_calculated'));
    if (lender) lender.lendingBase += paid;
    if (pool) pool.neuronsBase -= paid;
  });
  for (const row of out.values()) row.totalBase = row.neuronsBase + row.lendingBase;
  return out;
}

/** The drop's UTC days, newest first. */
export function satoriDropDays(nowMs: number): string[] {
  const first = Date.parse(`${SATORI_DROP_FIRST_DAY}T00:00:00Z`);
  const days: string[] = [];
  for (let t = Math.floor(nowMs / DAY_MS) * DAY_MS; t >= first; t -= DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Whether each day was claimed, with `days` newest first and null for a day not
 * read. A claim mints everything earned so far, so what was minted covers the
 * oldest days first.
 *
 * `fromFirstDay` says the list reaches back to the drop's first day. Then the sum
 * runs up from there and also shows a newest day the drop does not count yet.
 * Otherwise the only anchor is the lifetime figure at the newest end, and past a
 * gap in the list there is nothing to go on: those days get null, not a guess.
 */
export function satoriDayStatuses(
  days: readonly ({ totalBase: bigint } | null)[],
  lifetimeBase: bigint,
  claimedBase: bigint,
  fromFirstDay: boolean,
): (SatoriDayStatus | null)[] {
  const tol = SATORI_DAY_TOLERANCE_BASE;
  const statusOf = (before: bigint, after: bigint): SatoriDayStatus =>
    after <= claimedBase + tol ? 'claimed' : before + tol < claimedBase ? 'part' : 'waiting';
  if (fromFirstDay && days.every((day) => day !== null)) {
    const out: SatoriDayStatus[] = [];
    let upTo = 0n;
    for (let i = days.length - 1; i >= 0; i--) {
      const total = (days[i] as { totalBase: bigint }).totalBase;
      const after = upTo + total;
      out[i] = total > tol && upTo + tol >= lifetimeBase ? 'later' : statusOf(upTo, after);
      upTo = after;
    }
    return out;
  }
  let upTo = lifetimeBase;
  let gap = false;
  return days.map((day) => {
    if (day === null) gap = true;
    if (gap || day === null) return null;
    const before = upTo - day.totalBase;
    const status = statusOf(before, upTo);
    upTo = before;
    return status;
  });
}

const cacheKey = (address: string) => `satori.daily.${address.toLowerCase()}`;

type StoredDays = Record<string, { n: string; l: string }>;

async function readStored(address: string): Promise<StoredDays> {
  try {
    const v = await getStorage().get<StoredDays>(cacheKey(address));
    if (!v || typeof v !== 'object') return {};
    const digits = /^-?\d+$/;
    return Object.fromEntries(Object.entries(v).filter(([, e]) => digits.test(e?.n) && digits.test(e?.l)));
  } catch {
    return {};
  }
}

function fromStored(entry: { n: string; l: string }): SatoriDayFigures {
  const neuronsBase = BigInt(entry.n);
  const lendingBase = BigInt(entry.l);
  return { neuronsBase, lendingBase, totalBase: neuronsBase + lendingBase };
}

export type SatoriDayRead =
  /** `figures` is keyed by lowercase address. */
  | { date: string; state: 'ok'; figures: Map<string, SatoriDayFigures> }
  /** The server has no files for that date. */
  | { date: string; state: 'missing' }
  | { date: string; state: 'failed' };

/**
 * Read `dates` one at a time, reporting each as it lands. A finished day is kept
 * per address and never downloaded again. Today's is not kept: the day is young.
 */
export async function loadSatoriDays(args: {
  addresses: readonly string[];
  dates: readonly string[];
  nowMs: number;
  onDay(read: SatoriDayRead): void;
  isCancelled(): boolean;
}): Promise<void> {
  const { addresses, dates, nowMs, onDay, isCancelled } = args;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const stored = new Map<string, StoredDays>();
  for (const address of addresses) stored.set(address, await readStored(address));
  for (const date of dates) {
    if (isCancelled()) return;
    if (addresses.every((a) => stored.get(a)?.[date])) {
      onDay({
        date,
        state: 'ok',
        figures: new Map(addresses.map((a) => [a.toLowerCase(), fromStored((stored.get(a) as StoredDays)[date])])),
      });
      continue;
    }
    try {
      const predictors = await fetchSatoriAuditCsv('predictors', date);
      const stakers = predictors === null ? null : await fetchSatoriAuditCsv('stakers', date);
      if (predictors === null || stakers === null) {
        onDay({ date, state: 'missing' });
        continue;
      }
      const figures = satoriDayFigures(predictors, stakers, addresses);
      if (date !== today) {
        for (const address of addresses) {
          const row = figures.get(address.toLowerCase()) as SatoriDayFigures;
          const days = stored.get(address) as StoredDays;
          days[date] = { n: row.neuronsBase.toString(), l: row.lendingBase.toString() };
          try {
            await getStorage().set(cacheKey(address), days);
          } catch {
            /* ignore: the next open downloads the day again */
          }
        }
      }
      onDay({ date, state: 'ok', figures });
    } catch {
      onDay({ date, state: 'failed' });
    }
  }
}
