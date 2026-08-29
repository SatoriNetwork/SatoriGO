import { describe, expect, it } from 'vitest';
import { EvmNonceTracker } from './nonce';
import { EvmRpcUnavailableError, toQuantity, type EvmRpcClient } from './rpc';
import { evmChainByKey } from './chains';

const ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

/** A fake node whose pending count is scripted; every call is recorded. */
function fakeNode(chainKey: 'base' | 'bsc', pending: () => bigint | Promise<bigint>) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const client = {
    chain: evmChainByKey(chainKey)!,
    async call(method: string, params: unknown[] = []) {
      calls.push({ method, params });
      if (method !== 'eth_getTransactionCount') throw new Error(`unexpected ${method}`);
      return toQuantity(await pending());
    },
    async batch() {
      throw new Error('not used');
    },
    activeEndpoint: () => 'https://fake',
    lastLatencyMs: () => 1,
  } as unknown as EvmRpcClient;
  return { client, calls };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('EvmNonceTracker', () => {
  it('1. fresh: node 5 => 5, then 6, then 7 while outstanding', async () => {
    const { client } = fakeNode('base', () => 5n);
    const tracker = new EvmNonceTracker({ now: clock().now });
    const a = await tracker.reserve(client, ADDR);
    const b = await tracker.reserve(client, ADDR);
    const c = await tracker.reserve(client, ADDR);
    expect([a.nonce, b.nonce, c.nonce]).toEqual([5n, 6n, 7n]);
    expect(tracker.outstanding(8453, ADDR)).toEqual([5n, 6n, 7n]);
  });

  it('2. sent(): a lagging node still yields the next nonce; after sentTrustMs the node wins again', async () => {
    const c = clock();
    const { client } = fakeNode('base', () => 5n);
    const tracker = new EvmNonceTracker({ now: c.now, sentTrustMs: 1000 });
    const a = await tracker.reserve(client, ADDR);
    a.sent();
    expect(tracker.outstanding(8453, ADDR)).toEqual([]);
    expect((await tracker.reserve(client, ADDR)).nonce).toBe(6n);
    c.advance(5000);
    // Both the sent 5 and the outstanding 6 have aged past their windows... the
    // outstanding one is not stale (default 10 min), so it still counts:
    expect((await tracker.reserve(client, ADDR)).nonce).toBe(7n);
    // Fresh tracker path: only a sent nonce, then trust expires.
    const t2 = new EvmNonceTracker({ now: c.now, sentTrustMs: 1000 });
    (await t2.reserve(client, ADDR)).sent();
    c.advance(1001);
    expect((await t2.reserve(client, ADDR)).nonce).toBe(5n);
  });

  it('3. release(): the highest outstanding is reused; a lower one leaves a gap until the higher resolves', async () => {
    const { client } = fakeNode('base', () => 5n);
    const tracker = new EvmNonceTracker({ now: clock().now });
    const r5 = await tracker.reserve(client, ADDR);
    const r6 = await tracker.reserve(client, ADDR);
    r6.release();
    const again6 = await tracker.reserve(client, ADDR);
    expect(again6.nonce).toBe(6n);
    r5.release();
    // 6 still outstanding: the next is 7, the gap at 5 is not filled locally.
    const r7 = await tracker.reserve(client, ADDR);
    expect(r7.nonce).toBe(7n);
    again6.release();
    r7.release();
    expect((await tracker.reserve(client, ADDR)).nonce).toBe(5n);
  });

  it('4. concurrency: overlapping reserves are consecutive in call order, even with out-of-order node replies', async () => {
    let n = 0;
    const { client } = fakeNode('base', () => {
      n++;
      const delay = n === 1 ? 30 : 1; // first call answers last
      return new Promise<bigint>((res) => setTimeout(() => res(10n), delay));
    });
    const tracker = new EvmNonceTracker({ now: clock().now });
    const [a, b, c] = await Promise.all([
      tracker.reserve(client, ADDR),
      tracker.reserve(client, ADDR),
      tracker.reserve(client, ADDR),
    ]);
    expect([a.nonce, b.nonce, c.nonce]).toEqual([10n, 11n, 12n]);
  });

  it('5. chains are isolated: the same address on 8453 and 56 counts independently', async () => {
    const base = fakeNode('base', () => 0n);
    const bsc = fakeNode('bsc', () => 0n);
    const tracker = new EvmNonceTracker({ now: clock().now });
    const a = await tracker.reserve(base.client, ADDR);
    const b = await tracker.reserve(bsc.client, ADDR);
    expect(a.nonce).toBe(0n);
    expect(b.nonce).toBe(0n);
    a.sent();
    expect((await tracker.reserve(bsc.client, ADDR)).nonce).toBe(1n); // b outstanding
    expect((await tracker.reserve(base.client, ADDR)).nonce).toBe(1n); // a sent
    expect(tracker.outstanding(56, ADDR)).toEqual([0n, 1n]);
    expect(tracker.outstanding(8453, ADDR)).toEqual([1n]);
  });

  it('6. stale: an abandoned reservation is ignored and pruned after staleAfterMs', async () => {
    const c = clock();
    const { client } = fakeNode('base', () => 5n);
    const tracker = new EvmNonceTracker({ now: c.now, staleAfterMs: 1000 });
    await tracker.reserve(client, ADDR); // never sent nor released
    c.advance(1001);
    expect((await tracker.reserve(client, ADDR)).nonce).toBe(5n);
    expect(tracker.outstanding(8453, ADDR)).toEqual([5n]);
  });

  it('7. node advanced beyond local: node 9 after a sent 5 => 9', async () => {
    let pending = 5n;
    const { client } = fakeNode('base', () => pending);
    const tracker = new EvmNonceTracker({ now: clock().now });
    (await tracker.reserve(client, ADDR)).sent();
    pending = 9n;
    expect((await tracker.reserve(client, ADDR)).nonce).toBe(9n);
  });

  it('8. errors: a node failure rejects and records nothing; an invalid address throws before any call', async () => {
    const failing = fakeNode('base', () => {
      throw new EvmRpcUnavailableError('for eth_getTransactionCount', [{ url: 'https://fake', reason: 'down' }]);
    });
    const tracker = new EvmNonceTracker({ now: clock().now });
    await expect(tracker.reserve(failing.client, ADDR)).rejects.toBeInstanceOf(EvmRpcUnavailableError);
    expect(tracker.outstanding(8453, ADDR)).toEqual([]);
    // The chain is not wedged by the failure.
    const ok = fakeNode('base', () => 2n);
    expect((await tracker.reserve(ok.client, ADDR)).nonce).toBe(2n);
    const untouched = fakeNode('base', () => 0n);
    await expect(tracker.reserve(untouched.client, '0x1234')).rejects.toThrow();
    expect(untouched.calls).toHaveLength(0);
  });

  it('9. reset() clears one key only', async () => {
    const base = fakeNode('base', () => 3n);
    const bsc = fakeNode('bsc', () => 3n);
    const tracker = new EvmNonceTracker({ now: clock().now });
    await tracker.reserve(base.client, ADDR);
    await tracker.reserve(bsc.client, ADDR);
    tracker.reset(8453, ADDR);
    expect(tracker.outstanding(8453, ADDR)).toEqual([]);
    expect(tracker.outstanding(56, ADDR)).toEqual([3n]);
    expect((await tracker.reserve(base.client, ADDR)).nonce).toBe(3n);
  });

  it('10. sent() then release() keeps the nonce trusted; release() twice is a no-op', async () => {
    const { client } = fakeNode('base', () => 5n);
    const tracker = new EvmNonceTracker({ now: clock().now });
    const a = await tracker.reserve(client, ADDR);
    a.sent();
    a.release();
    expect((await tracker.reserve(client, ADDR)).nonce).toBe(6n);
    const b = await tracker.reserve(client, ADDR);
    b.release();
    b.release();
    expect(tracker.outstanding(8453, ADDR)).toEqual([6n]);
  });

  it('11. address identity is case-insensitive (one key per account)', async () => {
    const { client } = fakeNode('base', () => 0n);
    const tracker = new EvmNonceTracker({ now: clock().now });
    await tracker.reserve(client, ADDR.toLowerCase());
    expect((await tracker.reserve(client, ADDR)).nonce).toBe(1n);
  });
});
