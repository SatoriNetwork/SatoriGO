// Rate limits are the one JSON-RPC error the client retries: the public Base
// RPC answered the owner's first real send with "-32016 over rate limit" on
// the fee oracle batch, and a "slow down" is not an answer about the request.
import { describe, expect, it } from 'vitest';
import { EvmRpcError, EvmRpcUnavailableError, createEvmRpcClient } from './rpc';
import type { EvmChain } from './chains';

const CHAIN: EvmChain = {
  key: 'base',
  chainId: 8453,
  displayName: 'Base',
  nativeTicker: 'ETH',
  nativeDecimals: 18,
  rpc: ['https://a.example', 'https://b.example'],
  explorerTxUrl: 'https://basescan.org/tx/{txid}',
  homepage: 'https://example.test',
  young: false,
  recentlyAdded: false,
  feeModel: 'eip1559',
};

interface Req { id: number; method: string; params: unknown[] }

/** A node whose eth_getBalance answers are scripted per call, per host. */
function node(script: Record<string, Array<'ok' | 'limit' | 'limit5' | 'http429' | 'revert'>>) {
  const seen: Array<{ host: string; method: string }> = [];
  const sleeps: number[] = [];
  const counters: Record<string, number> = {};
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const host = new URL(String(url)).host;
    const body = JSON.parse(String(init?.body)) as Req | Req[];
    // HTTP-level rate limit (Alchemy: "exceeded its compute units per second
    // capacity"): counted per real request, chain checks excluded.
    const first = Array.isArray(body) ? body[0] : body;
    if (first.method !== 'eth_chainId') {
      const n = counters[host] ?? 0;
      if (script[host]?.[n] === 'http429') {
        counters[host] = n + 1;
        seen.push({ host, method: first.method });
        return new Response(JSON.stringify({ error: { code: 429, message: 'Your app has exceeded its compute units per second capacity' } }), { status: 429 });
      }
    }
    const answer = (req: Req) => {
      seen.push({ host, method: req.method });
      if (req.method === 'eth_chainId') return { jsonrpc: '2.0', id: req.id, result: '0x2105' };
      const n = counters[host] ?? 0;
      counters[host] = n + 1;
      const kind = script[host]?.[n] ?? 'ok';
      if (kind === 'ok') return { jsonrpc: '2.0', id: req.id, result: '0x1' };
      if (kind === 'limit') return { jsonrpc: '2.0', id: req.id, error: { code: -32016, message: 'over rate limit' } };
      if (kind === 'limit5') return { jsonrpc: '2.0', id: req.id, error: { code: -32005, message: 'limit exceeded' } };
      return { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } };
    };
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const client = createEvmRpcClient(CHAIN, {
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, seen, sleeps };
}

describe('rate-limit retries', () => {
  it('1. a rate-limited call is retried on the same endpoint after a backoff and then answers', async () => {
    const { client, seen, sleeps } = node({ 'a.example': ['limit', 'ok'] });
    expect(await client.call('eth_getBalance', ['0x00', 'latest'])).toBe('0x1');
    expect(sleeps).toEqual([600]);
    expect(seen.filter((s) => s.method === 'eth_getBalance').map((s) => s.host)).toEqual(['a.example', 'a.example']);
    expect(client.activeEndpoint()).toBe('https://a.example');
  });

  it('2. still limited after every backoff: the client fails over to the next endpoint', async () => {
    const { client, seen, sleeps } = node({ 'a.example': ['limit', 'limit5', 'limit'], 'b.example': ['ok'] });
    expect(await client.call('eth_getBalance', ['0x00', 'latest'])).toBe('0x1');
    expect(sleeps).toEqual([600, 1500]);
    expect(seen.filter((s) => s.method === 'eth_getBalance').map((s) => s.host)).toEqual([
      'a.example',
      'a.example',
      'a.example',
      'b.example',
    ]);
    expect(client.activeEndpoint()).toBe('https://b.example');
  });

  it('3. every endpoint limited: EvmRpcUnavailableError naming the rate limit per endpoint', async () => {
    const { client } = node({ 'a.example': ['limit', 'limit', 'limit'], 'b.example': ['limit', 'limit', 'limit'] });
    let caught: unknown;
    try {
      await client.call('eth_getBalance', ['0x00', 'latest']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvmRpcUnavailableError);
    const attempts = (caught as EvmRpcUnavailableError).attempts;
    expect(attempts.map((a) => a.url)).toEqual(['https://a.example', 'https://b.example']);
    for (const a of attempts) expect(a.reason).toMatch(/rate limited/);
  });

  it('3b. HTTP 429 (a keyed provider over its per-second capacity) is retried on the SAME endpoint, not failed over', async () => {
    const { client, seen, sleeps } = node({ 'a.example': ['http429', 'ok'] });
    expect(await client.call('eth_getBalance', ['0x00', 'latest'])).toBe('0x1');
    expect(sleeps).toEqual([600]);
    expect(seen.filter((s) => s.method === 'eth_getBalance').map((s) => s.host)).toEqual(['a.example', 'a.example']);
    expect(client.activeEndpoint()).toBe('https://a.example');
  });

  it('4. a batch with one rate-limited item is retried whole; a revert is NOT retried', async () => {
    const { client, sleeps } = node({ 'a.example': ['limit', 'ok', 'ok'] });
    const results = await client.batch([
      { method: 'eth_getBalance', params: ['0x00', 'latest'] },
      { method: 'eth_getBalance', params: ['0x01', 'latest'] },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(sleeps).toEqual([600]);

    const revert = node({ 'a.example': ['revert'] });
    await expect(revert.client.call('eth_call', [{ to: '0x00', data: '0x' }, 'latest'])).rejects.toBeInstanceOf(EvmRpcError);
    expect(revert.sleeps).toEqual([]);
  });
});
