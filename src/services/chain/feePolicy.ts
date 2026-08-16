// Fee-policy LOGIC for the transaction-building path. The per-chain VALUES
// (floor / default / ceiling / absolute cap, chosen from the 2026-08-14
// measured probe of every chain's own ElectrumX) live with the other chain
// parameters in chainParams.ts (CHAIN_FEE_POLICIES); this module is the pure,
// unit-testable machinery around them.
//
// SECURITY MODEL: every fee number that enters this module is UNTRUSTED — it
// comes either from a remote Electrum server (which may be hostile or MITM'd)
// or from the UI layer (which may carry a poisoned store value). Every path
// out of this module therefore passes through clampFeeRate(), and the absolute
// fee of a built transaction is independently capped by assertFeeSane(). No
// chain-name branching anywhere: everything is driven by the ChainFeePolicy
// values, so a new chain only needs a policy entry, never new code.

import type { ChainFeePolicy, ChainId } from './chainParams';

/**
 * Confirmation targets probed by estimateFeeOptions(), fastest first:
 *   2  — "fast"   (next couple of blocks),
 *   6  — "normal" (the wallet's long-standing single-probe target),
 *   25 — "slow"   (economy; the farthest target the measured probe exercised).
 *
 * Three targets are enough to detect whether a chain differentiates at all:
 * the measured data shows five of the six chains answer ONE flat number for
 * every target (only Bitcoin returns a real curve), so probing more targets
 * buys nothing but round-trips to an untrusted server.
 */
export const FEE_OPTION_TARGET_BLOCKS = [2, 6, 25] as const;

/** One selectable fee option, aligned with FEE_OPTION_TARGET_BLOCKS. */
export interface FeeOption {
  /** Confirmation target (blocks) this rate was estimated for. */
  targetBlocks: number;
  /** Effective rate the wallet would ACTUALLY use: server estimate converted to
   *  integer sat/byte and clamped into the chain's [floor, ceiling] band — or
   *  the chain default when the server had no usable answer for this target. */
  satPerByte: bigint;
  /** True when satPerByte came from a real server estimate; false when this
   *  target degraded to the chain default (server error / -1 / garbage). */
  estimated: boolean;
}

/** Result of estimateFeeOptions(): everything the UI needs to offer (or
 *  honestly decline to offer) a fee-speed choice. All rates are sat/byte
 *  bigints — keep them out of JSON.stringify. */
export interface FeeEstimate {
  /** The chain these options were estimated for, so a store can drop a stale
   *  estimate when the active chain changes. */
  chainId: ChainId;
  /**
   * True ONLY when every target produced a real server estimate AND the
   * effective (clamped, integer) rates actually differ — the only case in
   * which a fast/normal/slow choice is real. Measured 2026-08-14: five of six
   * chains answer one flat number for every target, so this is false there and
   * the UI must not render three identical "choices". It is deliberately
   * computed from the FINAL rates: a curve that collapses under integer
   * rounding (Bitcoin's measured 1.00/0.47/0.35 all become 1 sat/byte) or
   * under the ceiling clamp offers no real choice either, and a probe where
   * some targets degraded to the default must not fake one.
   */
  differentiated: boolean;
  /** Fastest first, aligned with FEE_OPTION_TARGET_BLOCKS. */
  options: FeeOption[];
  /** The chain policy the options were clamped with, echoed for display. */
  defaultSatPerByte: bigint;
  floorSatPerByte: bigint;
  ceilingSatPerByte: bigint;
}

/**
 * Convert an untrusted `blockchain.estimatefee` answer (coin/kB) to integer
 * sat/byte, or null when the answer is unusable and the caller should degrade
 * to the chain default. Uses EXACTLY the arithmetic the wallet has always used
 * (× 1e8, ÷ 1000, ceil, min 1) so the measured table in chainParams.ts reads
 * 1:1 against this function's output.
 *
 * Unusable answers (→ null): the protocol's "no estimate available" -1, zero,
 * negatives, NaN, ±Infinity, non-numbers, and any magnitude whose conversion
 * overflows to Infinity (a hostile ~1e308 — a merely-huge finite value like
 * 1e9 coin/kB converts fine and is then bounded by clampFeeRate's ceiling).
 */
export function serverEstimateToSatPerByte(coinPerKb: unknown): bigint | null {
  if (typeof coinPerKb !== 'number' || !Number.isFinite(coinPerKb) || coinPerKb <= 0) return null;
  const satPerByte = (coinPerKb * 1e8) / 1000;
  if (!Number.isFinite(satPerByte)) return null; // overflowed on a hostile magnitude
  return BigInt(Math.max(1, Math.ceil(satPerByte)));
}

/**
 * Clamp an untrusted rate into the chain's [floor, ceiling] band.
 *
 *   - ceiling: the anti-drain guard — a hostile server (or poisoned UI value)
 *     cannot push the rate above what the chain's policy allows;
 *   - floor: never rate BELOW the chain's relay floor — an under-floor tx would
 *     be refused relay, so clamping low values UP is a correctness fix, not a
 *     fee grab (measured: EVR/RVN relay at 1000 sat/byte, so the old global
 *     10 sat/byte fallback could never relay there).
 */
export function clampFeeRate(satPerByte: bigint, policy: ChainFeePolicy): bigint {
  if (satPerByte < policy.floorSatPerByte) return policy.floorSatPerByte;
  if (satPerByte > policy.ceilingSatPerByte) return policy.ceilingSatPerByte;
  return satPerByte;
}

/**
 * Reject an implausibly large ABSOLUTE fee before it can ever be broadcast —
 * defence-in-depth against a hostile estimate even if the rate clamp were
 * bypassed. Per-chain: the old global 100_000_000-sat cap is one whole COIN on
 * every chain, i.e. a sane 1 EVR but an absurd 1 BTC; each chain's
 * maxTxFeeSats is sized to its own ceiling × a worst-case tx instead.
 */
export function assertFeeSane(feeSats: bigint, policy: ChainFeePolicy): void {
  if (feeSats > policy.maxTxFeeSats) {
    throw new Error(
      `fee-too-high: ${feeSats} sats exceeds the ${policy.maxTxFeeSats}-sat safety ceiling ` +
        `(possible hostile fee estimate)`,
    );
  }
}

/**
 * Shape per-target probe results into a FeeEstimate. `ratesByTarget` is
 * aligned with FEE_OPTION_TARGET_BLOCKS; null marks a target whose probe
 * failed or answered unusably (that option degrades to the chain default, so
 * this function NEVER lacks a usable rate to offer). Pure — the network probing
 * lives in liveWallet.estimateFeeOptions(), which makes every degraded/hostile
 * case directly unit-testable here.
 */
export function buildFeeEstimate(
  chainId: ChainId,
  policy: ChainFeePolicy,
  ratesByTarget: readonly (bigint | null)[],
): FeeEstimate {
  const options: FeeOption[] = FEE_OPTION_TARGET_BLOCKS.map((targetBlocks, i) => {
    const raw = ratesByTarget[i] ?? null;
    return {
      targetBlocks,
      satPerByte: raw === null ? policy.defaultSatPerByte : clampFeeRate(raw, policy),
      estimated: raw !== null,
    };
  });
  // A real choice requires BOTH: every target genuinely estimated (a partial
  // probe padded with defaults must not fake a curve) AND the final effective
  // rates differing (post-clamp, post-integer-rounding — see FeeEstimate docs).
  const allEstimated = options.every((o) => o.estimated);
  const distinctRates = new Set(options.map((o) => o.satPerByte));
  return {
    chainId,
    differentiated: allEstimated && distinctRates.size > 1,
    options,
    defaultSatPerByte: policy.defaultSatPerByte,
    floorSatPerByte: policy.floorSatPerByte,
    ceilingSatPerByte: policy.ceilingSatPerByte,
  };
}

/**
 * The options a speed selector should actually RENDER: duplicates by effective
 * rate collapsed, keeping the FASTEST target of each rate.
 *
 * Why collapse rather than demand all three rates differ: `differentiated`
 * only needs TWO distinct rates to be true, and that is deliberate — a
 * two-point spread is a real choice (seen live on Ravencoin: 1860 at 2 blocks
 * vs 1006 at both 6 and 25). Demanding three would hide that genuine choice;
 * rendering all three as-is shows two chips with identical amounts, a
 * "choice" between the same fee. Collapsing shows exactly the spread the
 * server reported and nothing more — we never fabricate a rate the server did
 * not answer.
 *
 * Why keep the FASTEST target of an equal-rate run: equal effective rates
 * mean the server predicts this price already confirms at the faster target,
 * so the faster label is the honest promise — nobody would pick "~25 blocks"
 * over "~6 blocks" at the same price. Pure + exported for tests; the UI
 * (LiveSend) calls this at render time, so the full aligned `options` array
 * (which pickedTarget/default-target resolution depends on) stays intact.
 */
export function distinctFeeOptions(options: readonly FeeOption[]): FeeOption[] {
  const seen = new Set<bigint>();
  const out: FeeOption[] = [];
  for (const o of options) {
    if (seen.has(o.satPerByte)) continue;
    seen.add(o.satPerByte);
    out.push(o);
  }
  return out;
}
