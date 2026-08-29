// Pure deposit-detection logic for the background worker's incoming-funds
// notifications. Kept free of any `chrome` API so it is unit-testable in
// isolation; background/index.ts wires it to storage + chrome.notifications.

/**
 * Per-asset balances keyed by asset name (the native coin + each asset), in
 * BASE UNITS carried as decimal STRINGS.
 *
 * Strings, not bigint, because this map is PERSISTED and extension storage goes
 * through JSON.stringify, which throws on a BigInt. Strings, not numbers,
 * because the whole point is that the value stays exact: a balance past 2^53
 * base units would come back from a number changed.
 */
export type BalanceMap = Record<string, string>;

/** A per-asset balance increase worth notifying about. */
export interface DepositIncrease {
  asset: string;
  /** Amount gained since the previous snapshot, in BASE UNITS. */
  deltaBase: bigint;
  /** Decimals to render `deltaBase` with. */
  scale: number;
}

/** Kept only so an older stored snapshot can be recognised and discarded. */
export const DEPOSIT_EPSILON = 1e-8 / 2;

/** Parse a stored base-unit string. A snapshot written by an older build held
 *  WHOLE-unit numbers, which are a different quantity entirely, so anything
 *  that is not a plain integer string is treated as absent: the address simply
 *  re-baselines and its next real deposit notifies. Silently comparing the two
 *  formats would either spam a notification or hide one. */
function readBase(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Compute the per-asset increases of `current` over `prev`.
 *
 * - `prev === undefined` (address seen for the first time) => [] : the caller
 *   only establishes a baseline, so pre-existing balances never notify.
 * - An asset present in `current` but not `prev` is treated as previously 0
 *   (a brand-new asset arriving IS a deposit).
 * - Decreases and unchanged balances are ignored.
 */
export function diffDeposits(
  prev: BalanceMap | undefined,
  current: BalanceMap,
  /** Decimals to report each delta with, per asset name. Defaults to 8. */
  scaleFor: (asset: string) => number = () => 8,
): DepositIncrease[] {
  if (!prev) return [];
  const out: DepositIncrease[] = [];
  for (const [asset, raw] of Object.entries(current)) {
    const now = readBase(raw);
    if (now === null) continue; // unreadable current value: say nothing
    const before = readBase(prev[asset]);
    // An asset absent from the previous snapshot was previously 0 (a brand-new
    // asset arriving IS a deposit). An UNREADABLE previous value is different:
    // that is an old-format entry, so treat it as no baseline and stay silent
    // rather than reporting the whole balance as a deposit.
    if (before === null && asset in prev) continue;
    const delta = now - (before ?? 0n);
    // Exact: no epsilon, because there is no float noise left to absorb.
    if (delta > 0n) out.push({ asset, deltaBase: delta, scale: scaleFor(asset) });
  }
  return out;
}
