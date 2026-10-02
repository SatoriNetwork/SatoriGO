// How long until Monero's locked amount becomes spendable. Monero locks every
// new output (a payment received, or the change of your own send) for 10
// blocks; at about 2 minutes a block that is ~20 minutes. Shown next to the
// "unlocking" amount on Home so it does not read as stuck (owner, 2026-10-02).

/** Blocks a new Monero output stays locked (the protocol's default). */
export const MONERO_UNLOCK_BLOCKS = 10;
/** Monero's target block time, in minutes. */
const BLOCK_MINUTES = 2;

/**
 * "about N min" until the newest confirmed Monero row unlocks, or a generic
 * hint when no height is known yet (a payment still in the mempool).
 * `heights` are the block heights of this wallet's Monero activity rows.
 */
export function moneroUnlockHint(heights: readonly number[], daemonHeight: number): string {
  const newest = heights.filter((h) => Number.isInteger(h) && h > 0).reduce((a, b) => Math.max(a, b), 0);
  if (newest === 0 || !(daemonHeight > 0)) return 'spendable after 10 confirmations, about 20 min';
  const blocksLeft = newest + MONERO_UNLOCK_BLOCKS - daemonHeight;
  if (blocksLeft <= 1) return 'spendable within a few minutes';
  return `spendable in about ${blocksLeft * BLOCK_MINUTES} min`;
}
