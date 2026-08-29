// The rule that stops a failed or partial balance read from blanking tokens
// the wallet already knew about (owner, 2026-08-25: "not all the tokens that
// were there always load, sometimes only the one main coin"), and the store
// that keeps those rows across a popup close.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  BALANCE_CACHE_MAX_ROWS,
  balanceCacheKey,
  clearBalanceCaches,
  loadBalanceCache,
  mergeBalanceRows,
  saveBalanceCache,
} from './balanceCache';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';

const eth = (amount: bigint): LiveAssetBalance => ({ name: 'ETH', amountBase: amount, scale: 18, decimals: 18, isNative: true });
const token = (name: string, amount: bigint, decimals = 6): LiveAssetBalance => ({
  name,
  amountBase: amount,
  scale: decimals,
  decimals,
  isNative: false,
});

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

describe('mergeBalanceRows', () => {
  it('a COMPLETE read replaces the list: a token it did not report is gone', () => {
    const previous = [eth(5n), token('USDC', 100n), token('WETH', 7n, 18)];
    const fresh = [eth(6n), token('USDC', 120n)];
    expect(mergeBalanceRows(previous, fresh, true)).toEqual(fresh);
  });

  it('a PARTIAL read never drops a known token: the unanswered one keeps its last figure', () => {
    const previous = [eth(5n), token('USDC', 100n), token('WETH', 7n, 18)];
    // The gateway answered for the native coin only (a 429 mid-batch).
    const fresh = [eth(6n)];
    const merged = mergeBalanceRows(previous, fresh, false);
    expect(merged.map((r) => r.name)).toEqual(['ETH', 'USDC', 'WETH']);
    // The answered row is the FRESH figure, the unanswered ones the old one.
    expect(merged[0].amountBase).toBe(6n);
    expect(merged[1].amountBase).toBe(100n);
    expect(merged[2].amountBase).toBe(7n);
  });

  it('a PARTIAL read still updates every token it DID answer for', () => {
    const previous = [eth(5n), token('USDC', 100n), token('DAI', 3n, 18)];
    const fresh = [eth(6n), token('USDC', 0n)];
    const merged = mergeBalanceRows(previous, fresh, false);
    expect(merged.find((r) => r.name === 'USDC')?.amountBase).toBe(0n);
    expect(merged.find((r) => r.name === 'DAI')?.amountBase).toBe(3n);
  });

  it('with nothing known before, a partial read is simply what it answered', () => {
    expect(mergeBalanceRows([], [eth(1n)], false)).toEqual([eth(1n)]);
  });

  it('never mutates its inputs', () => {
    const previous = [eth(5n), token('USDC', 100n)];
    const fresh = [eth(6n)];
    mergeBalanceRows(previous, fresh, false);
    expect(previous).toHaveLength(2);
    expect(fresh).toHaveLength(1);
  });
});

describe('the saved balance rows', () => {
  it('survive a round trip with their bigint amounts exact', async () => {
    const rows = [eth(123_456_789_012_345_678_901n), token('USDC', 999_999_999n)];
    await saveBalanceCache('evm:base', '0xAbC0000000000000000000000000000000000001', rows);
    const back = await loadBalanceCache('evm:base', '0xabc0000000000000000000000000000000000001');
    expect(back?.rows).toEqual(rows);
    expect(typeof back?.fetchedAt).toBe('number');
  });

  it('are keyed per chain, so switching chains never shows the other chain rows', async () => {
    await saveBalanceCache('evm:base', '0xA1', [eth(1n)]);
    await saveBalanceCache('evm:bsc', '0xA1', [eth(2n)]);
    expect((await loadBalanceCache('evm:base', '0xA1'))?.rows[0].amountBase).toBe(1n);
    expect((await loadBalanceCache('evm:bsc', '0xA1'))?.rows[0].amountBase).toBe(2n);
    expect(balanceCacheKey('evm:base', '0xA1')).toBe('balances:evm:base:0xa1');
  });

  it('read back as null when absent, and a corrupt row is dropped rather than shown at a made-up amount', async () => {
    expect(await loadBalanceCache('evm:base', '0xnope')).toBe(null);
    const storage = new MemoryStorageAdapter();
    setStorageForTests(storage);
    await storage.set(balanceCacheKey('evm:base', '0xA1'), {
      fetchedAt: 1,
      rows: [
        { name: 'ETH', amountBase: '5', scale: 18, decimals: 18, isNative: true },
        { name: 'BAD', amountBase: 'not-a-number', scale: 6, decimals: 6, isNative: false },
        { name: 'ALSOBAD', scale: 6, decimals: 6, isNative: false },
      ],
    });
    const back = await loadBalanceCache('evm:base', '0xA1');
    expect(back?.rows.map((r) => r.name)).toEqual(['ETH']);
  });

  it('are capped, so a spammy address cannot grow the entry without limit', async () => {
    const many = Array.from({ length: BALANCE_CACHE_MAX_ROWS + 20 }, (_, i) => token(`T${i}`, BigInt(i)));
    await saveBalanceCache('evm:base', '0xA1', many);
    expect((await loadBalanceCache('evm:base', '0xA1'))?.rows).toHaveLength(BALANCE_CACHE_MAX_ROWS);
  });

  it('are swept by ADDRESS on every chain when a wallet is removed, and another address is untouched', async () => {
    await saveBalanceCache('evm:base', '0xAA', [eth(1n)]);
    await saveBalanceCache('evm:bsc', '0xAA', [eth(2n)]);
    await saveBalanceCache('mainnet', 'Ekeepme', [eth(3n)]);
    const dropped = await clearBalanceCaches(['0xaa']);
    expect(dropped).toBe(2);
    expect(await loadBalanceCache('evm:base', '0xAA')).toBe(null);
    expect(await loadBalanceCache('evm:bsc', '0xAA')).toBe(null);
    expect((await loadBalanceCache('mainnet', 'Ekeepme'))?.rows).toHaveLength(1);
  });
});
