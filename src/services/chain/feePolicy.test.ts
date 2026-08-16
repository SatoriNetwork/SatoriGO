// Per-chain fee policy — unit tests around the 2026-08-14 measured probe of
// every chain's own ElectrumX (`blockchain.estimatefee` + `blockchain.relayfee`;
// the full table lives in the fee-policy header block of chainParams.ts).
// These tests pin the SAFETY properties: a hostile server cannot drain via the
// rate, a clamped tx still relays, a future edit cannot invert a chain's
// floor/ceiling, and a fake fast/normal/slow choice is never advertised.

import { describe, expect, it } from 'vitest';
import { CHAIN_FEE_POLICIES, type ChainFeePolicy, type ChainId } from './chainParams';
import {
  FEE_OPTION_TARGET_BLOCKS,
  assertFeeSane,
  buildFeeEstimate,
  clampFeeRate,
  distinctFeeOptions,
  serverEstimateToSatPerByte,
} from './feePolicy';

const ALL_CHAIN_IDS = Object.keys(CHAIN_FEE_POLICIES) as ChainId[];

/** Measured 2026-08-14: 6-block `blockchain.estimatefee`, already converted to
 *  sat/byte. Most chains answer this same number for EVERY target; only
 *  Bitcoin's curve varies (1.00 at 1-2 blocks down to 0.35 at 25), and
 *  Dogecoin's 2-block answer spikes ~52x above its 6-block one (see the DOGE
 *  describe block below). */
const MEASURED_ESTIMATE_SAT_PER_BYTE: Record<ChainId, number> = {
  'bitcoin-mainnet': 0.47,
  'litecoin-mainnet': 1.0,
  'bitcoingold-mainnet': 1.04,
  'wojakcoin-mainnet': 20.03,
  'ravencoin-mainnet': 1041.02,
  'evrmore-mainnet': 1626.74,
  'evrmore-testnet': 1626.74, // not separately measured; same daemon defaults as mainnet
  // 6-block estimate, re-probed 2026-08-15 (the 2026-08-14 probe read 801) —
  // BELOW Dogecoin's 1000 sat/byte params floor either day, which is exactly
  // why the DOGE policy must never take its floor from the server.
  'dogecoin-mainnet': 967.35,
};

/** Measured 2026-08-14: `blockchain.relayfee` in sat/byte. BTC, LTC and DOGE
 *  are absent because their servers ERRORED on the call ("unknown method") —
 *  the policy floor for BTC/LTC falls back to the 1 sat/byte protocol default,
 *  while DOGE pins Dogecoin Core's own RECOMMENDED_MIN_TX_FEE floor of 1000
 *  (see CHAIN_FEE_POLICIES in chainParams.ts). */
const MEASURED_RELAY_FLOOR_SAT_PER_BYTE: Partial<Record<ChainId, number>> = {
  'bitcoingold-mainnet': 0.1,
  'wojakcoin-mainnet': 1.0,
  'ravencoin-mainnet': 1000.0,
  'evrmore-mainnet': 1000.0,
  'evrmore-testnet': 1000.0,
};

/** Invert the wallet's conversion: sat/byte -> the coin/kB a server would send. */
const toCoinPerKb = (satPerByte: number) => (satPerByte * 1000) / 1e8;

/** A typical 1-input / 2-output legacy tx is 226 bytes (10 + 148 + 2×34). */
const TYPICAL_TX_BYTES = 226n;

describe('CHAIN_FEE_POLICIES invariants (all seven chains + testnet)', () => {
  it('covers every ChainId exactly once', () => {
    // Record<ChainId, …> already enforces this at compile time; this pins the
    // runtime count so a type-system workaround would still fail a test.
    expect(ALL_CHAIN_IDS).toHaveLength(8);
  });

  it.each(ALL_CHAIN_IDS)('%s: ceiling is never below the floor (inversion guard)', (id) => {
    const p = CHAIN_FEE_POLICIES[id];
    // THE core anti-outage property. The old global 1000 sat/byte ceiling sat
    // EXACTLY at EVR/RVN's measured relay floor: any relay-floor rise would
    // have silently produced unrelayable transactions. A future edit must not
    // reintroduce that inversion on any chain.
    expect(p.ceilingSatPerByte >= p.floorSatPerByte).toBe(true);
    expect(p.floorSatPerByte >= 1n).toBe(true);
  });

  it.each(ALL_CHAIN_IDS)('%s: default sits inside [floor, ceiling]', (id) => {
    const p = CHAIN_FEE_POLICIES[id];
    expect(p.defaultSatPerByte >= p.floorSatPerByte).toBe(true);
    expect(p.defaultSatPerByte <= p.ceilingSatPerByte).toBe(true);
  });

  it.each(ALL_CHAIN_IDS)('%s: default covers the measured estimate (a fallback tx confirms)', (id) => {
    const p = CHAIN_FEE_POLICIES[id];
    const measured = serverEstimateToSatPerByte(toCoinPerKb(MEASURED_ESTIMATE_SAT_PER_BYTE[id]));
    expect(measured).not.toBeNull();
    // The old global default (10 sat/byte) was BELOW the EVR/RVN relay floor:
    // an unrelayable fallback. Each chain's default must price at/above what
    // its own network was measured to ask for.
    expect(p.defaultSatPerByte >= measured!).toBe(true);
  });

  it.each(ALL_CHAIN_IDS)('%s: floor and ceiling respect the measured relay floor', (id) => {
    const p = CHAIN_FEE_POLICIES[id];
    const relay = MEASURED_RELAY_FLOOR_SAT_PER_BYTE[id];
    if (relay === undefined) return; // relayfee errored on this chain (BTC, LTC)
    const relayCeil = BigInt(Math.ceil(relay));
    expect(p.floorSatPerByte >= relayCeil).toBe(true);
    // The ceiling must never sit below the relay floor — and unlike the old
    // global cap it must keep real headroom ABOVE it, so a genuine relay-floor
    // rise does not instantly strand the wallet at the boundary again.
    expect(p.ceilingSatPerByte >= relayCeil).toBe(true);
    expect(p.ceilingSatPerByte >= 2n * p.floorSatPerByte).toBe(true);
  });

  it.each(ALL_CHAIN_IDS)('%s: the absolute cap never vetoes a typical rate-capped tx', (id) => {
    const p = CHAIN_FEE_POLICIES[id];
    // The two guards must not contradict: a typical tx priced at the rate
    // ceiling (which clampFeeRate explicitly allows) must pass assertFeeSane.
    expect(p.maxTxFeeSats >= p.ceilingSatPerByte * TYPICAL_TX_BYTES).toBe(true);
  });
});

describe('serverEstimateToSatPerByte (untrusted coin/kB -> integer sat/byte)', () => {
  it('converts each chain’s measured estimate to the expected integer', () => {
    // Same arithmetic the wallet has always used: ×1e8, ÷1000, ceil, min 1.
    expect(serverEstimateToSatPerByte(toCoinPerKb(1626.74))).toBe(1627n); // EVR
    expect(serverEstimateToSatPerByte(toCoinPerKb(1041.02))).toBe(1042n); // RVN
    expect(serverEstimateToSatPerByte(toCoinPerKb(20.03))).toBe(21n); // WJK
    expect(serverEstimateToSatPerByte(toCoinPerKb(1.04))).toBe(2n); // BTGS
    // LTC's flat 1.00: the float round-trip lands at 1.0000000000000002 and
    // ceil rounds UP, never down — one ulp of overshoot costs 1 sat/byte but
    // can never produce an under-relay-floor rate. Fee-safe by construction.
    expect(serverEstimateToSatPerByte(toCoinPerKb(1.0))).toBe(2n); // LTC
    // Bitcoin's measured sub-1 curve (0.47 at 6 blocks, 0.35 at 25) collapses
    // to the 1 sat/byte integer minimum — which is why `differentiated` is
    // computed from FINAL rates, not raw server numbers.
    expect(serverEstimateToSatPerByte(toCoinPerKb(0.47))).toBe(1n);
    expect(serverEstimateToSatPerByte(toCoinPerKb(0.35))).toBe(1n);
    expect(serverEstimateToSatPerByte(0.001)).toBe(100n); // the long-standing test fixture value
  });

  it('returns null for every unusable answer (-1, 0, negatives, NaN, Infinity, non-numbers)', () => {
    expect(serverEstimateToSatPerByte(-1)).toBeNull(); // Electrum's "no estimate available"
    expect(serverEstimateToSatPerByte(0)).toBeNull();
    expect(serverEstimateToSatPerByte(-0.5)).toBeNull();
    expect(serverEstimateToSatPerByte(Number.NaN)).toBeNull();
    expect(serverEstimateToSatPerByte(Number.POSITIVE_INFINITY)).toBeNull();
    expect(serverEstimateToSatPerByte('0.001')).toBeNull();
    expect(serverEstimateToSatPerByte(undefined)).toBeNull();
    expect(serverEstimateToSatPerByte(null)).toBeNull();
    // Finite input whose ×1e8 conversion overflows to Infinity: degrade, don't throw.
    expect(serverEstimateToSatPerByte(1e308)).toBeNull();
  });

  it('converts a hostile-but-finite 10^9 coin/kB without throwing (clamp bounds it later)', () => {
    expect(serverEstimateToSatPerByte(1e9)).toBe(100_000_000_000_000n); // 1e14 sat/byte
  });
});

describe('clampFeeRate — per-chain clamping with the measured numbers', () => {
  it('EVR/RVN: the measured estimates now SURVIVE the clamp (the old global-1000 live bug)', () => {
    // Under the old global 1000 sat/byte ceiling, EVR's 1626.74 and RVN's
    // 1041.02 were both clamped to 1000 — exactly their measured relay floor,
    // zero headroom. The per-chain ceilings must let the real estimates through.
    const evr = CHAIN_FEE_POLICIES['evrmore-mainnet'];
    const evrRate = serverEstimateToSatPerByte(toCoinPerKb(1626.74))!;
    expect(clampFeeRate(evrRate, evr)).toBe(1627n);
    expect(clampFeeRate(evrRate, evr) > 1000n).toBe(true); // no longer pinned at the relay floor

    const rvn = CHAIN_FEE_POLICIES['ravencoin-mainnet'];
    const rvnRate = serverEstimateToSatPerByte(toCoinPerKb(1041.02))!;
    expect(clampFeeRate(rvnRate, rvn)).toBe(1042n);
  });

  it('the small chains’ measured estimates pass through untouched', () => {
    expect(clampFeeRate(1n, CHAIN_FEE_POLICIES['bitcoin-mainnet'])).toBe(1n); // measured 6-blk 0.47 -> 1
    expect(clampFeeRate(1n, CHAIN_FEE_POLICIES['litecoin-mainnet'])).toBe(1n);
    expect(clampFeeRate(2n, CHAIN_FEE_POLICIES['bitcoingold-mainnet'])).toBe(2n);
    expect(clampFeeRate(21n, CHAIN_FEE_POLICIES['wojakcoin-mainnet'])).toBe(21n);
  });

  it.each(ALL_CHAIN_IDS)('%s: a hostile 10^14 sat/byte is clamped to THIS chain’s own ceiling', (id) => {
    const p = CHAIN_FEE_POLICIES[id];
    expect(clampFeeRate(10n ** 14n, p)).toBe(p.ceilingSatPerByte);
  });

  it('ceilings are genuinely per-chain: Bitcoin’s is far below Evrmore’s', () => {
    // The whole point of the change: 10_000 sat/byte is headroom on EVR but
    // would be a ~10_000× hostile inflation on BTC (measured next-block: 1.00).
    expect(CHAIN_FEE_POLICIES['bitcoin-mainnet'].ceilingSatPerByte).toBe(500n);
    expect(CHAIN_FEE_POLICIES['evrmore-mainnet'].ceilingSatPerByte).toBe(10_000n);
  });

  it('raises an under-floor rate UP to the chain relay floor (the tx must relay)', () => {
    const evr = CHAIN_FEE_POLICIES['evrmore-mainnet'];
    expect(clampFeeRate(1n, evr)).toBe(1000n); // e.g. a UI override of 1 sat/byte on EVR
    expect(clampFeeRate(0n, evr)).toBe(1000n);
    expect(clampFeeRate(-5n, evr)).toBe(1000n); // a poisoned override cannot go sub-zero either
  });
});

describe('Dogecoin fee trap — the floor comes from the params, never the server', () => {
  const doge: ChainFeePolicy = CHAIN_FEE_POLICIES['dogecoin-mainnet'];

  it('pins the params-derived policy values', () => {
    // 1000 sat/byte = Dogecoin Core's RECOMMENDED_MIN_TX_FEE (COIN/100 per kB,
    // src/policy/policy.h) — a CHAIN constant, deliberately NOT a probed server
    // value: the server has no relayfee method to probe.
    expect(doge.floorSatPerByte).toBe(1000n);
    expect(doge.ceilingSatPerByte).toBe(10_000n);
    expect(doge.defaultSatPerByte).toBe(1200n);
    expect(doge.maxTxFeeSats).toBe(100_000_000n); // 1 DOGE
  });

  it("RAISES the server's own under-floor 6/25-block estimate to the relay floor", () => {
    // THE trap this policy exists for: both probes' 6-block answers (801 on
    // 2026-08-14, 967.35 on 2026-08-15) convert to a rate BELOW 1000 sat/byte.
    // Building at the server's rate would produce transactions the network
    // refuses to relay, so the clamp must pull them UP to the params floor.
    for (const measured of [801, 967.35]) {
      const rate = serverEstimateToSatPerByte(toCoinPerKb(measured))!;
      expect(rate < 1000n).toBe(true); // proves the server data really is under-floor
      expect(clampFeeRate(rate, doge)).toBe(1000n);
    }
  });

  it('clamps the ~52-63x 2-block spike so a "fast" option is never absurd', () => {
    // Measured 2-block answers: 50,420 (2026-08-14) and 50,411.47 (2026-08-15)
    // sat/byte — ~52-63x the same server's 6-block figure. Passing that through
    // would price "fast" at ~0.114 DOGE on a typical 226-byte tx for no real
    // confirmation gain; the ceiling bounds it to 10,000 (~0.0226 DOGE).
    for (const measured of [50420, 50411.47]) {
      const rate = serverEstimateToSatPerByte(toCoinPerKb(measured))!;
      expect(clampFeeRate(rate, doge)).toBe(doge.ceilingSatPerByte);
    }
  });

  it('a fallback (server-error) estimate confirms AND relays', () => {
    // No usable server answer -> the default. It must sit above the floor (so
    // it relays) and above every measured 6/25-block estimate (so it confirms).
    expect(doge.defaultSatPerByte >= doge.floorSatPerByte).toBe(true);
    expect(doge.defaultSatPerByte >= serverEstimateToSatPerByte(toCoinPerKb(967.35))!).toBe(true);
    const est = buildFeeEstimate('dogecoin-mainnet', doge, [null, null, null]);
    expect(est.options.every((o) => o.satPerByte === doge.defaultSatPerByte)).toBe(true);
    expect(est.differentiated).toBe(false);
  });

  it('the live measured shape (spiked fast, floored normal/slow) yields a bounded two-point choice', () => {
    const fast = serverEstimateToSatPerByte(toCoinPerKb(50411.47))!;
    const normal = serverEstimateToSatPerByte(toCoinPerKb(967.35))!;
    const est = buildFeeEstimate('dogecoin-mainnet', doge, [fast, normal, normal]);
    // Fast is ceiling-clamped, normal/slow floor-raised: a real (server-driven)
    // spread survives, but both ends are bounded by the params.
    expect(est.options.map((o) => o.satPerByte)).toEqual([10_000n, 1000n, 1000n]);
    expect(est.differentiated).toBe(true);
    const shown = distinctFeeOptions(est.options);
    expect(shown.map((o) => o.satPerByte)).toEqual([10_000n, 1000n]);
  });
});

describe('assertFeeSane — per-chain absolute-fee ceiling', () => {
  it.each(ALL_CHAIN_IDS)('%s: passes at its cap and throws just above it', (id) => {
    const p = CHAIN_FEE_POLICIES[id];
    expect(() => assertFeeSane(p.maxTxFeeSats, p)).not.toThrow();
    expect(() => assertFeeSane(p.maxTxFeeSats + 1n, p)).toThrow(/fee-too-high/);
  });

  it('the old global cap (100_000_000 sats) is now REJECTED on Bitcoin — 1 whole BTC is not a sane fee', () => {
    expect(() => assertFeeSane(100_000_000n, CHAIN_FEE_POLICIES['bitcoin-mainnet'])).toThrow(/fee-too-high/);
    // …while on Evrmore, where 100_000_000 sats is 1 EVR, it remains the cap.
    expect(() => assertFeeSane(100_000_000n, CHAIN_FEE_POLICIES['evrmore-mainnet'])).not.toThrow();
  });
});

describe('buildFeeEstimate — options + honest differentiation', () => {
  const evr: ChainFeePolicy = CHAIN_FEE_POLICIES['evrmore-mainnet'];
  const btc: ChainFeePolicy = CHAIN_FEE_POLICIES['bitcoin-mainnet'];

  it('reports differentiated=false when every target returns the same value (the measured shape of 5/6 chains)', () => {
    const est = buildFeeEstimate('evrmore-mainnet', evr, [1627n, 1627n, 1627n]);
    expect(est.differentiated).toBe(false);
    expect(est.options.map((o) => o.satPerByte)).toEqual([1627n, 1627n, 1627n]);
    expect(est.options.map((o) => o.targetBlocks)).toEqual([...FEE_OPTION_TARGET_BLOCKS]);
    expect(est.options.every((o) => o.estimated)).toBe(true);
    // Policy echoed for the UI.
    expect(est.chainId).toBe('evrmore-mainnet');
    expect(est.defaultSatPerByte).toBe(evr.defaultSatPerByte);
    expect(est.floorSatPerByte).toBe(evr.floorSatPerByte);
    expect(est.ceilingSatPerByte).toBe(evr.ceilingSatPerByte);
  });

  it('reports a real curve as differentiated (congested-Bitcoin shape)', () => {
    const est = buildFeeEstimate('bitcoin-mainnet', btc, [100n, 47n, 35n]);
    expect(est.differentiated).toBe(true);
    expect(est.options.map((o) => o.satPerByte)).toEqual([100n, 47n, 35n]);
    expect(est.options.every((o) => o.estimated)).toBe(true);
  });

  it('degrades a failed target to the chain default and does NOT fake a choice from partial data', () => {
    // Target 2 answered; targets 6 and 25 errored/-1 (null). The padded
    // defaults make the values differ (100 vs 2), but that difference is OUR
    // fallback, not the server's curve — advertising it as a choice would lie.
    const est = buildFeeEstimate('bitcoin-mainnet', btc, [100n, null, null]);
    expect(est.options.map((o) => o.satPerByte)).toEqual([100n, btc.defaultSatPerByte, btc.defaultSatPerByte]);
    expect(est.options.map((o) => o.estimated)).toEqual([true, false, false]);
    expect(est.differentiated).toBe(false);
  });

  it('every target failing yields all-default options and never throws', () => {
    const est = buildFeeEstimate('evrmore-mainnet', evr, [null, null, null]);
    expect(est.options.map((o) => o.satPerByte)).toEqual([
      evr.defaultSatPerByte,
      evr.defaultSatPerByte,
      evr.defaultSatPerByte,
    ]);
    expect(est.options.every((o) => !o.estimated)).toBe(true);
    expect(est.differentiated).toBe(false);
  });

  it('a hostile curve that the ceiling flattens is not differentiated (and is bounded)', () => {
    // Three DIFFERENT hostile rates, all above Bitcoin's 500 ceiling: the
    // effective rates are identical, so there is no real choice to offer.
    const est = buildFeeEstimate('bitcoin-mainnet', btc, [10n ** 9n, 10n ** 6n, 10n ** 3n]);
    expect(est.options.map((o) => o.satPerByte)).toEqual([500n, 500n, 500n]);
    expect(est.differentiated).toBe(false);
  });

  it('clamps each option into the band (floor side too)', () => {
    // A sub-floor answer on EVR (floor 1000) is raised so the tx would relay.
    const est = buildFeeEstimate('evrmore-mainnet', evr, [100n, 1627n, 1627n]);
    expect(est.options[0].satPerByte).toBe(1000n);
    expect(est.options[0].estimated).toBe(true);
  });
});

describe('distinctFeeOptions — what a speed selector actually renders', () => {
  const rvn: ChainFeePolicy = CHAIN_FEE_POLICIES['ravencoin-mainnet'];

  it('collapses the live Ravencoin shape (fast 1860, normal = slow 1006) to two chips', () => {
    // Seen live 2026-08-14: differentiated is TRUE (a real two-point spread)
    // but rendering all three options showed Normal and Slow with the SAME
    // amount — a "choice" between identical fees.
    const est = buildFeeEstimate('ravencoin-mainnet', rvn, [1860n, 1006n, 1006n]);
    expect(est.differentiated).toBe(true);
    const shown = distinctFeeOptions(est.options);
    expect(shown.map((o) => o.targetBlocks)).toEqual([2, 6]);
    expect(shown.map((o) => o.satPerByte)).toEqual([1860n, 1006n]);
  });

  it('keeps the FASTEST target of an equal-rate run (same price never labels slower)', () => {
    // fast == normal: at the same price the server predicts ~2-block
    // confirmation, so the 2-block label is the one that survives.
    const est = buildFeeEstimate('ravencoin-mainnet', rvn, [1860n, 1860n, 1006n]);
    expect(est.differentiated).toBe(true);
    const shown = distinctFeeOptions(est.options);
    expect(shown.map((o) => o.targetBlocks)).toEqual([2, 25]);
    expect(shown.map((o) => o.satPerByte)).toEqual([1860n, 1006n]);
  });

  it('leaves a fully distinct curve untouched', () => {
    const btc = CHAIN_FEE_POLICIES['bitcoin-mainnet'];
    const est = buildFeeEstimate('bitcoin-mainnet', btc, [100n, 47n, 35n]);
    expect(distinctFeeOptions(est.options)).toEqual(est.options);
  });

  it('collapses an all-flat answer to one option (the UI hides the selector anyway)', () => {
    const est = buildFeeEstimate('ravencoin-mainnet', rvn, [1042n, 1042n, 1042n]);
    expect(est.differentiated).toBe(false);
    expect(distinctFeeOptions(est.options).map((o) => o.targetBlocks)).toEqual([2]);
  });
});
