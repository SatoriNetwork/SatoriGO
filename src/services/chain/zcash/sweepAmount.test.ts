// What Max shows on Zcash must be what the sweep sends: the same coins and the
// same ZIP-317 fee as buildZcashTx's sweep branch.
import { describe, expect, it } from 'vitest';
import { zcashSweepAmount, zcashSweepInfo, type ZcashUtxo } from './builder';

const coin = (valueZat: bigint, over: Partial<ZcashUtxo> = {}): ZcashUtxo => ({
  txid: 'aa'.repeat(32), index: 0, valueZat, script: new Uint8Array(25), height: 100, address: 't1x', coinbase: false, ...over,
});

describe('zcashSweepAmount', () => {
  it('is the confirmed coins minus 5000 * max(2, n) zat', () => {
    expect(zcashSweepAmount([coin(1_000_000n), coin(500_000n, { index: 1 })])).toBe(1_490_000n);
    expect(zcashSweepAmount([coin(1n), coin(1n, { index: 1 }), coin(100_000n, { index: 2 })])).toBe(100_002n - 15_000n);
  });
  it('skips unconfirmed and coinbase coins, exactly as the sweep does', () => {
    expect(zcashSweepAmount([coin(1_000_000n), coin(9_000_000n, { index: 1, height: 0 }), coin(9_000_000n, { index: 2, coinbase: true })])).toBe(990_000n);
  });
  it('is null when nothing would be left above dust', () => {
    expect(zcashSweepAmount([])).toBeNull();
    expect(zcashSweepAmount([coin(10_000n)])).toBeNull();
    expect(zcashSweepInfo([]).reason).toBe('none');
    expect(zcashSweepInfo([coin(10_000n)]).reason).toBe('dust');
  });
  it('applies the fee cap exactly as the sweep does: 200 coins fit, 201 do not', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => coin(100_000n, { index: i }));
    expect(zcashSweepAmount(many(200))).toBe(200n * 100_000n - 1_000_000n);
    expect(zcashSweepAmount(many(201))).toBeNull();
    expect(zcashSweepInfo(many(201))).toMatchObject({ reason: 'fee-cap', coins: 201, total: 201n * 100_000n });
  });
  it('total is the coins a sweep spends (what the form calls Available)', () => {
    expect(zcashSweepInfo([coin(1_000_000n), coin(9n, { index: 1, height: 0 }), coin(7n, { index: 2, coinbase: true })]).total).toBe(1_000_000n);
  });
});
