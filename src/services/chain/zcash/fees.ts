// Zcash money rules: the ZIP-317 fee, the fee cap, dust, and ZEC <-> zatoshi
// text (design docs/design/zcash-engine.md §4.6, §4.7).
//
// Amounts are bigint zatoshi, never number. 1 ZEC is 1e8 zat, the same scale
// as Bitcoin, and the text conversions route through amounts.ts with 8
// decimals so there is one exact parser to trust on every chain's send path.
//
// ZIP-317 (Revision 1, live at NU6.3) makes the fee a rule, not an estimate:
//
//   fee = MARGINAL_FEE * max(GRACE_ACTIONS, logical_actions)
//   transparent logical actions = max(ceil(tx_in_bytes / 150), ceil(tx_out_bytes / 34))
//
// For P2PKH inputs (a scriptSig of at most 107 bytes, so at most 148 bytes
// per input) and P2PKH or P2SH outputs (at most 34 bytes each) that reduces to
// 5000 * max(2, nIn, nOut). Zebra's BLOCK_UNPAID_ACTION_LIMIT is 0, so an
// underpaid transaction is rejected by the mempool: pay exactly the rule.
//
// The fee cap mirrors evm/feeCaps.ts and monero/fees.ts: an absolute ceiling
// on ONE transaction's fee that REFUSES rather than clamps. ZIP-317 is
// deterministic, so the cap can only ever catch a builder bug or a wallet
// with more than 200 inputs to spend (which is asked to send in parts).

import { formatAmount, parseAmount } from '../amounts';

export const ZCASH_DECIMALS = 8;
export const ZAT_PER_ZEC = 100_000_000n;

/** ZIP-317 marginal fee per logical action, in zatoshi. */
export const ZIP317_MARGINAL_FEE = 5000n;
/** ZIP-317 grace actions: every transaction pays for at least two. */
export const ZIP317_GRACE_ACTIONS = 2;
/** ZIP-317 per-action transparent sizes, in bytes. */
export const ZIP317_P2PKH_STANDARD_INPUT_SIZE = 150;
export const ZIP317_P2PKH_STANDARD_OUTPUT_SIZE = 34;

/**
 * Dust threshold for a P2PKH or P2SH output: 3 * (100 * (size + 148) / 1000)
 * with size 34, i.e. 54 zat. Below this a node refuses to relay the output;
 * change below it is folded into the fee.
 */
export const ZCASH_DUST_ZAT = 54n;

/** 0.01 ZEC, 200 logical actions. A fee above this is refused, never clamped. */
export const ZCASH_MAX_FEE_ZAT = 1_000_000n;

/** Zcash amounts are int64 on the wire; MAX_MONEY is 21e6 ZEC. */
export const ZCASH_MAX_MONEY_ZAT = 21_000_000n * ZAT_PER_ZEC;

function assertCount(name: string, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`zip317: ${name} must be a non-negative integer`);
}

/**
 * The general ZIP-317 fee for a transparent-only transaction from the total
 * serialized sizes of its inputs and outputs (each input: 36-byte outpoint +
 * compactSize scriptSig + 4-byte sequence; each output: 8-byte value +
 * compactSize script).
 */
export function zip317Fee(txInTotalSize: number, txOutTotalSize: number): bigint {
  assertCount('txInTotalSize', txInTotalSize);
  assertCount('txOutTotalSize', txOutTotalSize);
  const logical = Math.max(
    Math.ceil(txInTotalSize / ZIP317_P2PKH_STANDARD_INPUT_SIZE),
    Math.ceil(txOutTotalSize / ZIP317_P2PKH_STANDARD_OUTPUT_SIZE),
  );
  return ZIP317_MARGINAL_FEE * BigInt(Math.max(ZIP317_GRACE_ACTIONS, logical));
}

/** ZIP-317 for P2PKH inputs and P2PKH/P2SH outputs: 5000 * max(2, nIn, nOut). */
export function zip317FeeP2pkh(nIn: number, nOut: number): bigint {
  assertCount('nIn', nIn);
  assertCount('nOut', nOut);
  return ZIP317_MARGINAL_FEE * BigInt(Math.max(ZIP317_GRACE_ACTIONS, nIn, nOut));
}

export type ZcashFeeErrorReason = 'not-bigint' | 'not-positive' | 'above-cap';

/** Thrown, never clamped: the transaction is not broadcast. */
export class ZcashFeeError extends Error {
  readonly reason: ZcashFeeErrorReason;
  readonly limit: bigint;
  readonly actual: bigint | null;
  constructor(reason: ZcashFeeErrorReason, actual: bigint | null) {
    super(
      reason === 'above-cap' && actual !== null
        ? `Refusing to send: the network fee of ${formatZec(actual)} ZEC is above this wallet's cap of ${formatZec(ZCASH_MAX_FEE_ZAT)} ZEC per transaction. Send a smaller amount, or send in parts.`
        : reason === 'not-positive'
          ? 'Refusing to send: the fee for this transaction is not a positive amount.'
          : 'Refusing to send: the fee for this transaction is not a valid amount.',
    );
    this.name = 'ZcashFeeError';
    this.reason = reason;
    this.limit = ZCASH_MAX_FEE_ZAT;
    this.actual = actual;
  }
}

/**
 * Throws ZcashFeeError unless 0 < fee <= ZCASH_MAX_FEE_ZAT. bigint only: a JS
 * number (a fee that passed through a float somewhere) is refused, not
 * converted.
 */
export function assertZcashFeeSane(feeZat: bigint): void {
  if (typeof feeZat !== 'bigint') throw new ZcashFeeError('not-bigint', null);
  if (feeZat <= 0n) throw new ZcashFeeError('not-positive', feeZat);
  if (feeZat > ZCASH_MAX_FEE_ZAT) throw new ZcashFeeError('above-cap', feeZat);
}

/** Zatoshi to ZEC text, exact, trailing zeros dropped: 150000000n is "1.5". */
export function formatZec(zat: bigint): string {
  return formatAmount(zat, ZCASH_DECIMALS);
}

/**
 * ZEC text to zatoshi, exact. Throws a user-facing message on anything that is
 * not plain decimal notation, on more than 8 decimal places, and on an amount
 * above the 21 million ZEC supply.
 */
export function parseZec(text: string): bigint {
  const zat = parseAmount(text, ZCASH_DECIMALS);
  if (zat > ZCASH_MAX_MONEY_ZAT) throw new Error('That is more ZEC than can exist.');
  return zat;
}
