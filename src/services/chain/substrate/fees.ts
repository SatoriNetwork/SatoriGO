// Bittensor money rules: the fee cap, the fee margin, and TAO <-> rao text.
//
// Amounts are bigint rao, never number (design bittensor-engine.md §4.6):
// 1 TAO is 1e9 rao and a treasury-sized balance passes 2^53. The text
// conversions route through amounts.ts with scale 9, the same exact
// string <-> bigint code every other chain's send path uses.
//
// The fee cap mirrors evm/feeCaps.ts and monero/fees.ts: an absolute ceiling
// on ONE transaction's fee that REFUSES rather than clamps. On Bittensor the
// fee is answered by the runtime (payment_queryInfo through the gateway, an
// untrusted path) and is essentially flat: 83,124 rao (0.000083 TAO) for a
// transfer on 2026-09-28. 0.01 TAO is about 120 times that: a runtime whose
// fee comes back above it is a runtime the wallet does not understand.

import { formatAmount, parseAmount } from '../amounts';
import { MAX_U64 } from './scale';
import { TAO_DECIMALS } from './tao';

/** 0.01 TAO. A fee above this is refused, never clamped. Owner-tunable. */
export const TAO_MAX_FEE_RAO = 10_000_000n;

/**
 * Affordability margin in permille: the wallet checks the balance against
 * partialFee * (1000 + margin) / 1000 because the chain charges the real
 * number, which can move a little between the quote and inclusion.
 */
export const TAO_FEE_MARGIN_PERMILLE = 100n;

export type TaoFeeErrorReason = 'not-bigint' | 'not-positive' | 'above-cap';

/** Thrown, never clamped: the transaction is not submitted. */
export class TaoFeeError extends Error {
  readonly reason: TaoFeeErrorReason;
  readonly limit: bigint;
  readonly actual: bigint | null;
  constructor(reason: TaoFeeErrorReason, actual: bigint | null) {
    super(
      reason === 'above-cap' && actual !== null
        ? `Refusing to send: the network fee of ${formatTao(actual)} TAO is above this wallet's cap of ${formatTao(TAO_MAX_FEE_RAO)} TAO per transaction.`
        : reason === 'not-positive'
          ? 'Refusing to send: the fee quoted for this transaction is not a positive amount.'
          : 'Refusing to send: the fee quoted for this transaction is not a valid amount.',
    );
    this.name = 'TaoFeeError';
    this.reason = reason;
    this.limit = TAO_MAX_FEE_RAO;
    this.actual = actual;
  }
}

/**
 * Throws TaoFeeError unless 0 < fee <= TAO_MAX_FEE_RAO. A zero fee is refused
 * too: the runtime never quotes one for a signed transfer, so a zero here
 * means the number did not come from where it should have. Takes bigint
 * only; a JS number (a fee that went through a float) is refused rather
 * than converted.
 */
export function assertTaoFeeSane(feeRao: bigint): void {
  if (typeof feeRao !== 'bigint') throw new TaoFeeError('not-bigint', null);
  if (feeRao <= 0n) throw new TaoFeeError('not-positive', feeRao);
  if (feeRao > TAO_MAX_FEE_RAO) throw new TaoFeeError('above-cap', feeRao);
}

/** The fee with the affordability margin applied: what the balance must cover. */
export function taoFeeWithMargin(feeRao: bigint): bigint {
  if (typeof feeRao !== 'bigint' || feeRao < 0n) throw new TaoFeeError('not-bigint', null);
  return (feeRao * (1000n + TAO_FEE_MARGIN_PERMILLE)) / 1000n;
}

/**
 * Rao to TAO text, exact, trailing zeros dropped: 1_500_000_000n is "1.5",
 * 1n is "0.000000001", 0n is "0". Never through a float.
 */
export function formatTao(rao: bigint): string {
  return formatAmount(rao, TAO_DECIMALS);
}

/**
 * TAO text to rao, exact. Plain decimal notation only ("1", "0.5", ".5");
 * throws with a user-facing message on an empty or malformed amount, more
 * than 9 decimal places, or a value larger than a u64 (what the wire holds).
 */
export function parseTao(text: string): bigint {
  const rao = parseAmount(text, TAO_DECIMALS);
  if (rao > MAX_U64) throw new Error('This amount is larger than any Bittensor amount can be.');
  return rao;
}
