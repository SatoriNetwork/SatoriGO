// Pure deposit-detection logic for the background worker's incoming-funds
// notifications. Kept free of any `chrome` API so it is unit-testable in
// isolation; background/index.ts wires it to storage + chrome.notifications.

/** Per-asset balances in WHOLE units, keyed by asset name (EVR + each asset). */
export type BalanceMap = Record<string, number>;

/** A per-asset balance increase worth notifying about. */
export interface DepositIncrease {
  asset: string;
  /** Amount gained since the previous snapshot, in whole units. */
  delta: number;
}

/** Ignore sub-satoshi float noise when comparing whole-unit balances. */
export const DEPOSIT_EPSILON = 1e-8 / 2;

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
  epsilon = DEPOSIT_EPSILON,
): DepositIncrease[] {
  if (!prev) return [];
  const out: DepositIncrease[] = [];
  for (const [asset, amount] of Object.entries(current)) {
    const before = prev[asset] ?? 0;
    const delta = amount - before;
    if (delta > epsilon) out.push({ asset, delta });
  }
  return out;
}
