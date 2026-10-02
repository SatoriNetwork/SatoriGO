// Monero money rules: fee priority, the fee cap, and XMR <-> piconero text.
//
// Amounts are bigint piconero, never number (design §9): 1 XMR is 1e12
// piconero, already past 2^40, and a balance passes 2^53 at about 9,007 XMR.
// The text conversions route through amounts.ts with scale 12, the same exact
// string <-> bigint code every other chain's send path uses, so there is one
// parser to trust.
//
// The fee cap mirrors evm/feeCaps.ts: an absolute ceiling on ONE
// transaction's fee that REFUSES rather than clamps (a clamped fee is a
// transaction the user did not see). On Monero the fee is computed inside
// wallet2 from the daemon's get_fee_estimate, i.e. from an untrusted node
// through the gateway. Normal-priority fees are on the order of 0.0001 XMR
// (design §9), so 0.05 XMR is ~500x the norm: far above anything
// legitimate even at elevated priority in a spike, and it still catches a
// poisoned estimate, a wallet2 surprise or a priority mistake before relay.

import { formatAmount, parseAmount } from '../amounts';

/**
 * The three levels the send screen offers. Monero's own scale is 0 (default,
 * which wallet2 maps to its configured level), 1 unimportant, 2 normal,
 * 3 elevated, 4 priority. 0 is not offered because what it means depends on
 * wallet2's settings, and 4 is not offered because it multiplies the fee for
 * no benefit a wallet user needs.
 */
export type MoneroPriority = 'unimportant' | 'normal' | 'elevated';

/** Wire codes: wallet2 / monero-ts MoneroTxPriority (UNIMPORTANT 1, NORMAL 2, ELEVATED 3). */
export const MONERO_PRIORITY_CODE: Readonly<Record<MoneroPriority, 1 | 2 | 3>> = Object.freeze({
  unimportant: 1,
  normal: 2,
  elevated: 3,
});

export const MONERO_DECIMALS = 12;
export const PICONERO_PER_XMR = 1_000_000_000_000n;

/** 0.05 XMR. A fee above this is refused, never clamped. Owner-tunable. */
export const MONERO_MAX_FEE_PICO = 50_000_000_000n;

/** Monero amounts are uint64 on the wire; nothing larger can be sent or held. */
const MAX_UINT64 = (1n << 64n) - 1n;

export type MoneroFeeErrorReason = 'not-bigint' | 'not-positive' | 'above-cap';

/** Thrown, never clamped: the transaction is not relayed. */
export class MoneroFeeError extends Error {
  readonly reason: MoneroFeeErrorReason;
  readonly limit: bigint;
  readonly actual: bigint | null;
  constructor(reason: MoneroFeeErrorReason, actual: bigint | null) {
    super(
      reason === 'above-cap' && actual !== null
        ? `Refusing to send: the network fee of ${formatXmr(actual)} XMR is above this wallet's cap of ${formatXmr(MONERO_MAX_FEE_PICO)} XMR per transaction.`
        : reason === 'not-positive'
          ? 'Refusing to send: the fee quoted for this transaction is not a positive amount.'
          : 'Refusing to send: the fee quoted for this transaction is not a valid amount.',
    );
    this.name = 'MoneroFeeError';
    this.reason = reason;
    this.limit = MONERO_MAX_FEE_PICO;
    this.actual = actual;
  }
}

/**
 * Throws MoneroFeeError unless 0 < fee <= MONERO_MAX_FEE_PICO. A zero fee is
 * refused too: wallet2 never builds one, so a zero here means the number did
 * not come from where it should have. Takes bigint only; a JS number (a fee
 * that went through a float somewhere) is refused rather than converted.
 */
export function assertMoneroFeeSane(feePico: bigint): void {
  if (typeof feePico !== 'bigint') throw new MoneroFeeError('not-bigint', null);
  if (feePico <= 0n) throw new MoneroFeeError('not-positive', feePico);
  if (feePico > MONERO_MAX_FEE_PICO) throw new MoneroFeeError('above-cap', feePico);
}

/**
 * Piconero to XMR text, exact, trailing zeros dropped: 1_500_000_000_000n is
 * "1.5", 1n is "0.000000000001", 0n is "0". Never through a float.
 */
export function formatXmr(pico: bigint): string {
  return formatAmount(pico, MONERO_DECIMALS);
}

/**
 * XMR text to piconero, exact. Plain decimal notation only ("1", "0.5", ".5");
 * throws with a user-facing message on an empty or malformed amount, more than
 * 12 decimal places, or a value larger than a Monero amount can hold.
 */
export function parseXmr(text: string): bigint {
  const pico = parseAmount(text, MONERO_DECIMALS);
  if (pico > MAX_UINT64) throw new Error('This amount is larger than any Monero amount can be.');
  return pico;
}
