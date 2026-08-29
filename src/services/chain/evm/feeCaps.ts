// Fee caps for the EVM family: the last line of defence on a chain where the
// UTXO anti-drain (verifyInputAmounts) has no analogue.
//
// On UTXO the fee is what is left over between inputs and outputs, so the
// wallet independently re-derives every input amount and refuses to sign when
// the implied fee is absurd. On EVM there are no prevouts to verify: the fee is
// gasLimit x price (+ the L1 surcharge), and every one of those numbers came
// from an UNTRUSTED node (eth_estimateGas, eth_feeHistory, eth_gasPrice, the
// GasPriceOracle). A hostile or broken RPC that answers a 1000x gas price would
// otherwise be signed for without complaint. So, exactly as feePolicy.ts does
// per UTXO chain, two independent guards per EVM chain, both REFUSING rather
// than clamping (a clamped fee is a transaction the user did not see):
//
//   1. a ceiling on the per-gas price (maxFeePerGas for 1559, gasPrice for
//      legacy): protects against a poisoned fee market reading;
//   2. an absolute cap on ONE transaction's worst-case total (maxTotal from
//      fees.ts, which already includes the L1 data fee): protects against a
//      poisoned gas estimate, or an honest one on a contract call gone wrong.
//
// The values are deliberately generous against a real spike (a stuck user is a
// bad outcome too) and deliberately far below "drains the account". They were
// set on 2026-08-18 against live readings: Base base fee ~0.005 gwei with a
// ~0.001 gwei tip, BSC gasPrice 0.05 gwei. Owner-tunable; a chain added in
// phase 6 MUST get a row here (feeCaps.test.ts pins registry == caps).

import type { EvmFee } from './tx';

export interface EvmFeeCaps {
  /** Highest per-gas price this wallet will sign for, in wei per gas. */
  perGasCeiling: bigint;
  /** Highest worst-case total fee (gasLimit x price + L1) for one transaction, wei. */
  totalCap: bigint;
}

const GWEI = 1_000_000_000n;

export const EVM_FEE_CAPS: Readonly<Record<string, EvmFeeCaps>> = Object.freeze({
  // Base: a real fee market at ~0.005 gwei. 50 gwei is 10,000x the norm and
  // still under Ethereum L1 levels; 0.005 ETH covers a 500k-gas contract call
  // at 10 gwei with the L1 part, and is a hard stop far below anything a
  // transfer could honestly cost.
  base: Object.freeze({ perGasCeiling: 50n * GWEI, totalCap: 5_000_000_000_000_000n /* 0.005 ETH */ }),
  // BNB Chain: validators run a 0.05 gwei floor and it barely moves. 20 gwei is
  // 400x that; 0.01 BNB covers a 500k-gas call at 20 gwei with room to spare.
  bsc: Object.freeze({ perGasCeiling: 20n * GWEI, totalCap: 10_000_000_000_000_000n /* 0.01 BNB */ }),
  // Ethereum L1: base fee read live 2026-08-19 at ~0.07 gwei, but the L1 fee
  // market has real spikes (tens of gwei in congestion). 150 gwei is above any
  // level a user should confirm blind; 0.03 ETH covers a 200k-gas send at
  // 150 gwei and is a hard stop against a poisoned quote.
  ethereum: Object.freeze({ perGasCeiling: 150n * GWEI, totalCap: 30_000_000_000_000_000n /* 0.03 ETH */ }),
  // EpixChain: read live 2026-08-20, eth_feeHistory answered baseFeePerGas
  // 0x4a817c800 = 20 gwei on EVERY block of the window with reward 0, and
  // eth_gasPrice 0x53d1ac100 = 22.5 gwei (= base fee + the 12.5% headroom a
  // 1559 quote adds). So the base fee here is a CONSTANT set by the chain, not
  // a market that moves with demand, and 22.5 gwei is what a send actually
  // costs. The ceiling is nonetheless generous rather than tight: the constant
  // is a governance parameter and can be raised, and a stuck user is a bad
  // outcome too. 500 gwei is 25x the current base fee, far above any honest
  // move and far below a poisoned quote. The total cap follows from it:
  // 200,000 gas (a token transfer with room to spare) at 500 gwei is exactly
  // 0.1 EPIX, so a quote that exceeds 0.1 EPIX is refused whatever combination
  // of gas limit and price produced it.
  epix: Object.freeze({ perGasCeiling: 500n * GWEI, totalCap: 100_000_000_000_000_000n /* 0.1 EPIX */ }),
});

export type EvmFeeCapReason = 'per-gas-ceiling' | 'total-cap' | 'no-caps-for-chain';

/** Thrown, never clamped: the transaction is not built. */
export class EvmFeeCapError extends Error {
  readonly reason: EvmFeeCapReason;
  readonly chainKey: string;
  readonly limit: bigint;
  readonly actual: bigint;
  constructor(reason: EvmFeeCapReason, chainKey: string, limit: bigint, actual: bigint) {
    super(
      reason === 'per-gas-ceiling'
        ? `Refusing to sign: the ${chainKey} fee rate ${actual} wei/gas is above this wallet's ceiling of ${limit} wei/gas.`
        : reason === 'total-cap'
          ? `Refusing to sign: the ${chainKey} fee could reach ${actual} wei, above this wallet's cap of ${limit} wei per transaction.`
          : `Refusing to sign: no fee caps are configured for chain ${chainKey}.`,
    );
    this.name = 'EvmFeeCapError';
    this.reason = reason;
    this.chainKey = chainKey;
    this.limit = limit;
    this.actual = actual;
  }
}

/** The per-gas price a fee commits to at most. */
export function perGasOf(fee: EvmFee): bigint {
  return fee.type === 'eip1559' ? fee.maxFeePerGas : fee.gasPrice;
}

/**
 * Refuse a quote that breaks either cap. `maxTotal` must be the WORST-CASE
 * total (gasLimit x per-gas + L1 data fee), never the estimate: the cap is on
 * what the user could pay, not on what they probably will.
 */
export function assertEvmFeeWithinCaps(chainKey: string, quote: { fee: EvmFee; maxTotal: bigint }): void {
  const caps = EVM_FEE_CAPS[chainKey];
  if (!caps) throw new EvmFeeCapError('no-caps-for-chain', chainKey, 0n, 0n);
  const perGas = perGasOf(quote.fee);
  if (perGas > caps.perGasCeiling) throw new EvmFeeCapError('per-gas-ceiling', chainKey, caps.perGasCeiling, perGas);
  if (quote.maxTotal > caps.totalCap) throw new EvmFeeCapError('total-cap', chainKey, caps.totalCap, quote.maxTotal);
}
