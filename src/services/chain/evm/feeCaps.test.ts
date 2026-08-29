import { describe, expect, it } from 'vitest';
import { EVM_CHAINS } from './chains';
import { EVM_FEE_CAPS, EvmFeeCapError, assertEvmFeeWithinCaps, perGasOf } from './feeCaps';

const GWEI = 1_000_000_000n;

describe('EVM fee caps: refuse, never clamp', () => {
  it('1. every registered chain has caps, and no cap row is orphaned', () => {
    for (const chain of EVM_CHAINS) expect(EVM_FEE_CAPS[chain.key], chain.key).toBeDefined();
    for (const key of Object.keys(EVM_FEE_CAPS)) expect(EVM_CHAINS.some((c) => c.key === key), key).toBe(true);
  });

  it('2. a normal Base transfer passes: 25200 gas at 11.1 mwei max fee plus a 12045 wei L1 fee', () => {
    const fee = { type: 'eip1559' as const, maxFeePerGas: 11_100_000n, maxPriorityFeePerGas: 1_100_000n };
    expect(() => assertEvmFeeWithinCaps('base', { fee, maxTotal: 25_200n * 11_100_000n + 12_045n })).not.toThrow();
  });

  it('3. a normal BSC transfer passes: 25200 gas at 0.055 gwei', () => {
    const fee = { type: 'legacy' as const, gasPrice: 55_000_000n };
    expect(() => assertEvmFeeWithinCaps('bsc', { fee, maxTotal: 25_200n * 55_000_000n })).not.toThrow();
  });

  it('4. per-gas ceiling: a poisoned 51 gwei on Base is refused with the ceiling and the offending value', () => {
    const fee = { type: 'eip1559' as const, maxFeePerGas: 51n * GWEI, maxPriorityFeePerGas: 1n * GWEI };
    let caught: unknown;
    try {
      assertEvmFeeWithinCaps('base', { fee, maxTotal: 21_000n * 51n * GWEI });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvmFeeCapError);
    const err = caught as EvmFeeCapError;
    expect(err.reason).toBe('per-gas-ceiling');
    expect(err.limit).toBe(50n * GWEI);
    expect(err.actual).toBe(51n * GWEI);
    expect(err.message).toMatch(/Refusing to sign/);
  });

  it('5. total cap: a sane per-gas price with an absurd gas limit is refused on the total (L1 fee counted)', () => {
    const fee = { type: 'eip1559' as const, maxFeePerGas: 10n * GWEI, maxPriorityFeePerGas: 1n * GWEI };
    // 400k gas at 10 gwei = 0.004 ETH, under the cap; a 0.0011 ETH L1 fee pushes it over.
    expect(() => assertEvmFeeWithinCaps('base', { fee, maxTotal: 400_000n * 10n * GWEI })).not.toThrow();
    let caught: unknown;
    try {
      assertEvmFeeWithinCaps('base', { fee, maxTotal: 400_000n * 10n * GWEI + 1_100_000_000_000_000n });
    } catch (e) {
      caught = e;
    }
    expect((caught as EvmFeeCapError).reason).toBe('total-cap');
    expect((caught as EvmFeeCapError).limit).toBe(5_000_000_000_000_000n);
  });

  it('6. legacy: BSC 21 gwei gasPrice is refused (ceiling 20 gwei), 20 gwei exactly passes', () => {
    expect(() =>
      assertEvmFeeWithinCaps('bsc', { fee: { type: 'legacy', gasPrice: 21n * GWEI }, maxTotal: 21_000n * 21n * GWEI }),
    ).toThrow(EvmFeeCapError);
    expect(() =>
      assertEvmFeeWithinCaps('bsc', { fee: { type: 'legacy', gasPrice: 20n * GWEI }, maxTotal: 21_000n * 20n * GWEI }),
    ).not.toThrow();
  });

  it('7. an unknown chain is refused outright (a phase-6 chain must get a caps row)', () => {
    expect(() =>
      assertEvmFeeWithinCaps('polygon', { fee: { type: 'legacy', gasPrice: 1n }, maxTotal: 1n }),
    ).toThrow(/no fee caps are configured/);
  });

  it('7b. Epix: the live 22.5 gwei send passes, a 501 gwei quote is refused on the rate, and 0.1 EPIX is the exact total ceiling', () => {
    // Live 2026-08-20: base fee 20 gwei constant, gasPrice 22.5 gwei, reward 0.
    const real = { type: 'eip1559' as const, maxFeePerGas: 22_500_000_000n, maxPriorityFeePerGas: 0n };
    expect(() => assertEvmFeeWithinCaps('epix', { fee: real, maxTotal: 21_000n * 22_500_000_000n })).not.toThrow();
    expect(() =>
      assertEvmFeeWithinCaps('epix', {
        fee: { type: 'eip1559', maxFeePerGas: 501n * GWEI, maxPriorityFeePerGas: 0n },
        maxTotal: 21_000n * 501n * GWEI,
      }),
    ).toThrow(/fee rate/);
    // 200k gas at the 500 gwei ceiling is exactly the cap; one wei more is not.
    const atCeiling = { type: 'eip1559' as const, maxFeePerGas: 500n * GWEI, maxPriorityFeePerGas: 0n };
    expect(() => assertEvmFeeWithinCaps('epix', { fee: atCeiling, maxTotal: 200_000n * 500n * GWEI })).not.toThrow();
    expect(() => assertEvmFeeWithinCaps('epix', { fee: atCeiling, maxTotal: 200_000n * 500n * GWEI + 1n })).toThrow(
      /could reach/,
    );
    expect(EVM_FEE_CAPS.epix.totalCap).toBe(100_000_000_000_000_000n);
  });

  it('8. perGasOf reads maxFeePerGas for 1559 and gasPrice for legacy', () => {
    expect(perGasOf({ type: 'eip1559', maxFeePerGas: 7n, maxPriorityFeePerGas: 1n })).toBe(7n);
    expect(perGasOf({ type: 'legacy', gasPrice: 9n })).toBe(9n);
  });

  it('9. the caps table is frozen', () => {
    expect(Object.isFrozen(EVM_FEE_CAPS)).toBe(true);
    for (const row of Object.values(EVM_FEE_CAPS)) expect(Object.isFrozen(row)).toBe(true);
  });
});
