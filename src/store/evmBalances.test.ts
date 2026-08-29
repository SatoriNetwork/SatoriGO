// evmBalances.ts end to end THROUGH THE REAL EVM MODULES against a fake fetch:
// loadEvmModules() -> createEvmProvider (real rpc client + erc20 codec) ->
// balances + network status in the shape the store consumes. This is the
// "balances into the store" proof of phase 2 that needs no network. The store
// branch itself is pinned in liveStore.evmRefresh.test.ts.
//
// The engine's flag-guarded import is mocked to return the barrel, because in
// the test config the flag is off (as in a shipped package), which the last
// test pins as `null`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ evmEnabled: true }));

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => (hoisted.evmEnabled ? await import('../services/chain/evm') : null),
  };
});

import { evmProviderFor, refreshEvmWallet, resetEvmProvidersForTests } from './evmBalances';

const ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BAL_OF = '0x70a08231';
const DECIMALS = '0x313ce567';
const SYMBOL = '0x95d89b41';

const word = (hex: string) => hex.padStart(64, '0');
/** ABI dynamic string return data for a short ASCII symbol. */
function abiString(s: string): string {
  const bytes = Buffer.from(s, 'utf8').toString('hex');
  return '0x' + word('20') + word(s.length.toString(16)) + bytes.padEnd(64, '0');
}

interface RpcReq {
  id: number;
  method: string;
  params: unknown[];
}

/** A JSON-RPC server for Base with fixed answers, answering single and batch
 *  requests by METHOD (never by position), and recording every request. */
function fakeBaseNode(overrides: { chainId?: string; failBalance?: boolean; down?: boolean } = {}) {
  const seen: RpcReq[] = [];
  const answer = (req: RpcReq): Record<string, unknown> => {
    seen.push(req);
    switch (req.method) {
      case 'eth_chainId':
        return { jsonrpc: '2.0', id: req.id, result: overrides.chainId ?? '0x2105' };
      case 'eth_blockNumber':
        return { jsonrpc: '2.0', id: req.id, result: '0x2000000' };
      case 'eth_getBlockByNumber':
        return { jsonrpc: '2.0', id: req.id, result: { number: '0x2000000', timestamp: '0x66f00000' } };
      case 'eth_getBalance':
        if (overrides.failBalance) {
          return { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'header not found' } };
        }
        // 1.5 ETH exactly, in wei.
        return { jsonrpc: '2.0', id: req.id, result: '0x14d1120d7b160000' };
      case 'eth_call': {
        const call = req.params[0] as { to: string; data: string };
        if (call.to.toLowerCase() !== USDC_BASE) {
          return { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } };
        }
        if (call.data.startsWith(BAL_OF)) return { jsonrpc: '2.0', id: req.id, result: '0x' + word('bc614e') }; // 12345678
        if (call.data.startsWith(DECIMALS)) return { jsonrpc: '2.0', id: req.id, result: '0x' + word('6') };
        if (call.data.startsWith(SYMBOL)) return { jsonrpc: '2.0', id: req.id, result: abiString('USDC') };
        return { jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } };
      }
      default:
        return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } };
    }
  };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (overrides.down) throw new TypeError('fetch failed');
    const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, seen };
}

beforeEach(() => {
  hoisted.evmEnabled = true;
  resetEvmProvidersForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evmBalances: the store read path through the real EVM modules', () => {
  it('1. reads native + default-token balances for a Base account, exact in base units', async () => {
    const node = fakeBaseNode();
    vi.stubGlobal('fetch', node.fetchImpl);

    const result = await refreshEvmWallet(ADDR, 'base');
    expect(result).not.toBe(null);
    expect(result!.network.state).toBe('connected');
    expect(result!.network.blockHeight).toBe(0x2000000);
    expect(result!.network.tipTime).toBe(0x66f00000 * 1000);
    expect(result!.assets).toEqual([
      { name: 'ETH', amountBase: 1_500_000_000_000_000_000n, scale: 18, decimals: 18, isNative: true },
      { name: 'USDC', amountBase: 12_345_678n, scale: 6, decimals: 6, isNative: false },
    ]);
    // The chain was verified before anything was read from it.
    expect(node.seen[0].method).toBe('eth_chainId');
    // The account address went out exactly once for eth_getBalance.
    const bal = node.seen.filter((r) => r.method === 'eth_getBalance');
    expect(bal).toHaveLength(1);
    expect((bal[0].params[0] as string).toLowerCase()).toBe(ADDR.toLowerCase());
  });

  it('2. an unknown or absent chain key falls back to the default chain (Base) and the provider is reused', async () => {
    const node = fakeBaseNode();
    vi.stubGlobal('fetch', node.fetchImpl);
    const a = await evmProviderFor(undefined);
    const b = await evmProviderFor('not-a-chain');
    const c = await evmProviderFor('base');
    expect(a).not.toBe(null);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a!.chain.key).toBe('base');
  });

  it('3. every endpoint down: network offline, assets null (store keeps its previous assets)', async () => {
    const node = fakeBaseNode({ down: true });
    vi.stubGlobal('fetch', node.fetchImpl);
    const result = await refreshEvmWallet(ADDR, 'base');
    expect(result).not.toBe(null);
    expect(result!.network.state).toBe('offline');
    expect(result!.assets).toBe(null);
  });

  it('4. an endpoint serving the WRONG chain is never read from: offline, not a foreign balance', async () => {
    const node = fakeBaseNode({ chainId: '0x38' }); // BSC answering on the Base URL
    vi.stubGlobal('fetch', node.fetchImpl);
    const result = await refreshEvmWallet(ADDR, 'base');
    expect(result!.network.state).toBe('offline');
    expect(result!.assets).toBe(null);
    expect(node.seen.every((r) => r.method === 'eth_chainId')).toBe(true);
  });

  it('5. a native balance refusal degrades to assets null while network status still reports', async () => {
    const node = fakeBaseNode({ failBalance: true });
    vi.stubGlobal('fetch', node.fetchImpl);
    const result = await refreshEvmWallet(ADDR, 'base');
    expect(result!.network.state).toBe('connected');
    expect(result!.assets).toBe(null);
  });

  it('6. with the EVM flag off (a shipped package) nothing is loaded and the result is null', async () => {
    hoisted.evmEnabled = false;
    const node = fakeBaseNode();
    vi.stubGlobal('fetch', node.fetchImpl);
    expect(await refreshEvmWallet(ADDR, 'base')).toBe(null);
    expect(await evmProviderFor('base')).toBe(null);
    expect(node.seen).toHaveLength(0);
  });
});
