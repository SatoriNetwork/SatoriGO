// The "is this account used?" rule, against fixed JSON-RPC answers.
//
// What is pinned here is the part that decides whether a restored recovery
// phrase keeps or loses an account: balance OR nonce, on ANY chain, and a chain
// that could not be read is never evidence of an unused account.

import { describe, expect, it, vi } from 'vitest';
import {
  EVM_ACCOUNT_PROBE_CALLS_PER_ADDRESS,
  evmAccountProbeBatch,
  mergeEvmAccountProbes,
  probeEvmAccountsUsed,
  type EvmAccountChainProbe,
} from './accountDiscovery';
import { EvmRpcError, type EvmRpcBatchResult, type EvmRpcCall } from './rpc';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

/** A chain answer built from [balance, nonce] pairs, one pair per address. */
function chainAnswer(pairs: Array<[string, string]>): EvmAccountChainProbe {
  const results: EvmRpcBatchResult[] = [];
  for (const [balance, nonce] of pairs) {
    results.push({ ok: true, result: balance });
    results.push({ ok: true, result: nonce });
  }
  return { ok: true, results };
}

const failedItem = (): EvmRpcBatchResult => ({
  ok: false,
  error: new EvmRpcError('eth_getBalance', -32005, 'rate limited'),
});

describe('evmAccountProbeBatch', () => {
  it('1. asks balance and nonce at "latest" for every address, in address order', () => {
    const calls = evmAccountProbeBatch([A, B]);
    expect(EVM_ACCOUNT_PROBE_CALLS_PER_ADDRESS).toBe(2);
    expect(calls).toEqual([
      { method: 'eth_getBalance', params: [A, 'latest'] },
      { method: 'eth_getTransactionCount', params: [A, 'latest'] },
      { method: 'eth_getBalance', params: [B, 'latest'] },
      { method: 'eth_getTransactionCount', params: [B, 'latest'] },
    ]);
    expect(evmAccountProbeBatch([])).toEqual([]);
  });
});

describe('mergeEvmAccountProbes', () => {
  it('2. a positive balance OR a positive nonce marks an address used', () => {
    const out = mergeEvmAccountProbes(3, [
      chainAnswer([
        ['0x0', '0x0'], // never touched
        ['0x1', '0x0'], // holds something
        ['0x0', '0x7'], // spent everything it ever had, but it EXISTS
      ]),
    ]);
    expect(out).toEqual({ answered: true, used: [false, true, true] });
  });

  it('3. used on ANY chain is used: chains are OR-ed, not required to agree', () => {
    const out = mergeEvmAccountProbes(2, [
      chainAnswer([
        ['0x0', '0x0'],
        ['0x0', '0x0'],
      ]),
      chainAnswer([
        ['0x0', '0x0'],
        ['0x2386f26fc10000', '0x0'],
      ]),
    ]);
    expect(out).toEqual({ answered: true, used: [false, true] });
  });

  it('4. a chain that could not be read is not an answer, and all-failed says so', () => {
    // One dead chain beside a live one: the live one still decides.
    const mixed = mergeEvmAccountProbes(1, [{ ok: false }, chainAnswer([['0x1', '0x0']])]);
    expect(mixed).toEqual({ answered: true, used: [true] });
    // Every chain dead: nothing was learned, and NOTHING reads as unused.
    const dead = mergeEvmAccountProbes(2, [{ ok: false }, { ok: false }]);
    expect(dead).toEqual({ answered: false, used: [false, false] });
    // No chains at all is the same kind of nothing.
    expect(mergeEvmAccountProbes(1, [])).toEqual({ answered: false, used: [false] });
  });

  it('5. a per-item error or a malformed quantity proves nothing about that address', () => {
    const results: EvmRpcBatchResult[] = [
      failedItem(), // balance unreadable
      { ok: true, result: '0x0' }, // nonce says nothing
      { ok: true, result: 8453 }, // a node answering a NUMBER is not a quantity
      { ok: true, result: '0x3' }, // ... but its nonce still counts
    ];
    const out = mergeEvmAccountProbes(2, [{ ok: true, results }]);
    // The chain DID answer, so this is a real (if partial) result.
    expect(out).toEqual({ answered: true, used: [false, true] });
  });

  it('6. a short or over-long batch is tolerated: missing entries are simply no evidence', () => {
    const short = mergeEvmAccountProbes(3, [chainAnswer([['0x5', '0x0']])]);
    expect(short).toEqual({ answered: true, used: [true, false, false] });
    const long = mergeEvmAccountProbes(1, [
      chainAnswer([
        ['0x0', '0x0'],
        ['0x9', '0x9'],
      ]),
    ]);
    expect(long).toEqual({ answered: true, used: [false] });
  });
});

describe('probeEvmAccountsUsed', () => {
  it('7. sends ONE batch per chain and merges what comes back', async () => {
    const seen: EvmRpcCall[][] = [];
    const base = vi.fn(async (calls: EvmRpcCall[]) => {
      seen.push(calls);
      return [
        { ok: true as const, result: '0x0' },
        { ok: true as const, result: '0x0' },
        { ok: true as const, result: '0x0' },
        { ok: true as const, result: '0x1' },
        { ok: true as const, result: '0x0' },
        { ok: true as const, result: '0x0' },
      ];
    });
    const bsc = vi.fn(async (calls: EvmRpcCall[]) => {
      seen.push(calls);
      return [
        { ok: true as const, result: '0x0' },
        { ok: true as const, result: '0x0' },
        { ok: true as const, result: '0x0' },
        { ok: true as const, result: '0x0' },
        { ok: true as const, result: '0xde0b6b3a7640000' },
        { ok: true as const, result: '0x0' },
      ];
    });
    const out = await probeEvmAccountsUsed([A, B, C], [base, bsc]);
    expect(out).toEqual({ answered: true, used: [false, true, true] });
    expect(base).toHaveBeenCalledTimes(1);
    expect(bsc).toHaveBeenCalledTimes(1);
    expect(seen[0]).toHaveLength(6);
    expect(seen[0]).toEqual(seen[1]);
  });

  it('8. a batcher that throws is a failed chain, not a set of unused accounts', async () => {
    const dead = async () => {
      throw new Error('no endpoint answered');
    };
    const live = async (): Promise<EvmRpcBatchResult[]> => [
      { ok: true, result: '0x0' },
      { ok: true, result: '0x2' },
    ];
    expect(await probeEvmAccountsUsed([A], [dead, live])).toEqual({ answered: true, used: [true] });
    expect(await probeEvmAccountsUsed([A], [dead])).toEqual({ answered: false, used: [false] });
    // Nothing to probe: no request goes out at all.
    const never = vi.fn(async () => []);
    expect(await probeEvmAccountsUsed([], [never])).toEqual({ answered: true, used: [] });
    expect(never).not.toHaveBeenCalled();
  });
});
