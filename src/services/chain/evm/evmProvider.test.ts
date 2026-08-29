// Tests for the read-only EVM WalletDataProvider.
//
// NO NETWORK IS TOUCHED HERE. Most tests inject a hand-written EvmRpcClient
// (FakeRpcClient below) scripted per method, so evmProvider.ts's own logic is
// exercised in isolation from rpc.ts. One test at the bottom injects a fake
// `fetchImpl` through createEvmProvider(chain, { rpc: { fetchImpl } }) instead,
// proving the real client composes correctly end to end.

import { describe, it, expect } from 'vitest';
import { EvmWalletDataProvider, createEvmProvider } from './evmProvider';
import { evmChainByKey, type EvmChain, type EvmTokenRef } from './chains';
import {
  EvmRpcError,
  EvmRpcUnavailableError,
  toQuantity,
  type EvmRpcCall,
  type EvmRpcBatchResult,
  type EvmRpcClient,
} from './rpc';
import { encodeBalanceOf, encodeDecimals, encodeSymbol } from './erc20';
import { NetworkOfflineError } from '../../provider';
import type { TransactionRequest } from '../../../types/domain';

// ---------------------------------------------------------------------------
// Fixtures

/** Base: the chain phase 2 reads first (the EVM rollout plan, section 8),
 *  with its live-read default token (USDC). */
const CHAIN: EvmChain = evmChainByKey('base')!;
const USDC: EvmTokenRef = CHAIN.defaultTokens![0];

/** The published "abandon ... about" seed vector's address 0, already pinned
 *  elsewhere in the EVM engine's tests (keys.test.ts). */
const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

/** A well-formed eth_getBlockByNumber timestamp (a valid JSON-RPC QUANTITY:
 *  no leading zero). */
const TIMESTAMP_HEX = '0x668b2ac0';
const EXPECTED_TIP_TIME = Number(BigInt(TIMESTAMP_HEX)) * 1000;

/** symbol() returning "USDC" as the ABI DYNAMIC STRING form: offset word
 *  0x20, length word 4, then "USDC" padded to one word. Reused verbatim from
 *  erc20.test.ts's own proven fixture, so this vector is already covered by
 *  decodeString's own tests. */
const USDC_SYMBOL_HEX =
  '0x' +
  '0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000000000000000000000000000000000000000000004' +
  '5553444300000000000000000000000000000000000000000000000000000000';

/** A uint256/uint8 ABI return word: value, big-endian, left-padded to 32
 *  bytes (64 hex digits). What eth_call answers for balanceOf/decimals. */
function uintWord(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

/** symbol()/name() as the ABI BYTES32 form: ASCII bytes, right-padded with
 *  zeros to one word. Simpler to hand-build than the dynamic form, and
 *  decodeString supports it directly (erc20.ts, the MKR-era case). */
function bytes32String(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 32) throw new Error('bytes32String: text too long');
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex.padEnd(64, '0')}`;
}

const revertError = (method: string) => new EvmRpcError(method, 3, 'execution reverted');

// ---------------------------------------------------------------------------
// Fake EvmRpcClient
//
// Scripted per method, keyed by method name plus (for eth_call) the `to` and
// `data` of the call, exactly as the answers a real node gives depend only on
// what was asked, not on when it was asked. Answers are not consumed: the
// same script serves the same call any number of times, which is what lets a
// "second refresh" test reuse one FakeRpcClient's script across two calls.

class FakeRpcClient implements EvmRpcClient {
  readonly chain: EvmChain;

  /** One entry per batch() invocation, in order, for "one batch" assertions. */
  readonly batchCalls: EvmRpcCall[][] = [];
  /** One entry per call() invocation, in order. */
  readonly callLog: Array<{ method: string; params: unknown[] }> = [];

  /** When set, batch() throws this instead of consulting the script. */
  batchError: Error | null = null;
  /** When set, call() throws this instead of consulting the script. */
  callError: Error | null = null;

  private readonly answers = new Map<string, EvmRpcBatchResult>();
  private readonly activeEndpointValue: string | null;
  private readonly lastLatencyValue: number | null;

  constructor(chain: EvmChain, opts: { activeEndpoint?: string | null; lastLatencyMs?: number | null } = {}) {
    this.chain = chain;
    this.activeEndpointValue = opts.activeEndpoint ?? 'https://mainnet.base.org';
    this.lastLatencyValue = opts.lastLatencyMs ?? 42;
  }

  private key(method: string, params: unknown[]): string {
    if (method === 'eth_call') {
      const arg = params[0] as { to: string; data: string };
      return `eth_call:${arg.to.toLowerCase()}:${arg.data.toLowerCase()}`;
    }
    return `${method}:${JSON.stringify(params)}`;
  }

  /** Script a successful answer for one method+params. */
  mockOk(method: string, params: unknown[], result: unknown): this {
    this.answers.set(this.key(method, params), { ok: true, result });
    return this;
  }

  /** Script a node-level refusal (a revert) for one method+params. */
  mockRevert(method: string, params: unknown[], error: EvmRpcError): this {
    this.answers.set(this.key(method, params), { ok: false, error });
    return this;
  }

  activeEndpoint(): string | null {
    return this.activeEndpointValue;
  }

  lastLatencyMs(): number | null {
    return this.lastLatencyValue;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    this.callLog.push({ method, params });
    if (this.callError) throw this.callError;
    const entry = this.answers.get(this.key(method, params));
    if (!entry) throw new Error(`FakeRpcClient: no script for call ${this.key(method, params)}`);
    if (!entry.ok) throw entry.error;
    return entry.result as T;
  }

  async batch(calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> {
    this.batchCalls.push(calls);
    if (calls.length === 0) return [];
    if (this.batchError) throw this.batchError;
    return calls.map((c) => {
      const k = this.key(c.method, c.params ?? []);
      const entry = this.answers.get(k);
      if (!entry) throw new Error(`FakeRpcClient: no script for batch ${k}`);
      return entry;
    });
  }
}

/** A FakeRpcClient scripted for the Base-row happy path: native balance
 *  1 ETH, USDC balance 12345678 base units, decimals 6, symbol "USDC" (all
 *  answered from the chain, per the EVM rollout plan, section 3's
 *  worked example). */
function scriptedRpc(): FakeRpcClient {
  const rpc = new FakeRpcClient(CHAIN);
  rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(10n ** 18n));
  rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], uintWord(12345678));
  rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeDecimals() }, 'latest'], uintWord(6));
  rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeSymbol() }, 'latest'], USDC_SYMBOL_HEX);
  return rpc;
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------
// getNetworkStatus

describe('getNetworkStatus', () => {
  it('happy path: one batch, block height and tip time', async () => {
    const rpc = new FakeRpcClient(CHAIN, { activeEndpoint: 'https://mainnet.base.org', lastLatencyMs: 77 });
    rpc.mockOk('eth_blockNumber', [], toQuantity(0x2000000));
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], { timestamp: TIMESTAMP_HEX, number: toQuantity(0x2000000) });
    const provider = new EvmWalletDataProvider(rpc, { now: () => 999 });

    const status = await provider.getNetworkStatus();

    expect(status).toEqual({
      networkId: 'mainnet',
      state: 'connected',
      latencyMs: 77,
      blockHeight: 0x2000000,
      serverVersion: 'https://mainnet.base.org',
      updatedAt: 999,
      tipTime: EXPECTED_TIP_TIME,
    });
    expect(rpc.batchCalls).toHaveLength(1);
    expect(rpc.batchCalls[0]).toEqual([
      { method: 'eth_blockNumber' },
      { method: 'eth_getBlockByNumber', params: ['latest', false] },
    ]);
  });

  it('tipTime is null when the block is null', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_blockNumber', [], toQuantity(5));
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], null);
    const provider = new EvmWalletDataProvider(rpc, { now: () => 1 });

    const status = await provider.getNetworkStatus();
    expect(status.state).toBe('connected');
    expect(status.blockHeight).toBe(5);
    expect(status.tipTime).toBeNull();
  });

  it('tipTime is null when the block is malformed (no usable timestamp)', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_blockNumber', [], toQuantity(5));
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], { number: toQuantity(5) /* no timestamp */ });
    const provider = new EvmWalletDataProvider(rpc, { now: () => 1 });

    const status = await provider.getNetworkStatus();
    expect(status.tipTime).toBeNull();
  });

  it('never throws: EvmRpcUnavailableError degrades to offline', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.batchError = new EvmRpcUnavailableError('for batch [eth_blockNumber]', []);
    const provider = new EvmWalletDataProvider(rpc, { now: () => 123 });

    const status = await provider.getNetworkStatus();
    expect(status).toEqual({
      networkId: 'mainnet',
      state: 'offline',
      latencyMs: 0,
      blockHeight: 0,
      serverVersion: '',
      updatedAt: 123,
      tipTime: null,
    });
  });

  it('never throws: any other failure also degrades to offline', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.batchError = new Error('boom, something else entirely');
    const provider = new EvmWalletDataProvider(rpc, { now: () => 7 });

    const status = await provider.getNetworkStatus();
    expect(status.state).toBe('offline');
    expect(status.blockHeight).toBe(0);
    expect(status.latencyMs).toBe(0);
    expect(status.tipTime).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAllAssetBalances

describe('getAllAssetBalances', () => {
  it('happy path: native then USDC, in order, one batch of 4 calls', async () => {
    const rpc = scriptedRpc();
    const provider = new EvmWalletDataProvider(rpc);

    const rows = await provider.getAllAssetBalances(ADDRESS);

    expect(rows).toEqual([
      { name: 'ETH', amountBase: 10n ** 18n, scale: 18, decimals: 18, isNative: true },
      { name: 'USDC', amountBase: 12345678n, scale: 6, decimals: 6, isNative: false },
    ]);
    expect(rpc.batchCalls).toHaveLength(1);
    expect(rpc.batchCalls[0]).toHaveLength(4);
  });

  it('second refresh: metadata is cached, batch has exactly 2 items', async () => {
    const rpc = scriptedRpc();
    const provider = new EvmWalletDataProvider(rpc);

    await provider.getAllAssetBalances(ADDRESS);
    const rows = await provider.getAllAssetBalances(ADDRESS);

    expect(rows).toEqual([
      { name: 'ETH', amountBase: 10n ** 18n, scale: 18, decimals: 18, isNative: true },
      { name: 'USDC', amountBase: 12345678n, scale: 6, decimals: 6, isNative: false },
    ]);
    expect(rpc.batchCalls).toHaveLength(2);
    expect(rpc.batchCalls[1]).toEqual([
      { method: 'eth_getBalance', params: [ADDRESS, 'latest'] },
      { method: 'eth_call', params: [{ to: USDC.address, data: encodeBalanceOf(ADDRESS) }, 'latest'] },
    ]);
  });

  it('a token whose balanceOf reverts is skipped; the native row still returns', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(0));
    rpc.mockRevert('eth_call', [{ to: USDC.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], revertError('eth_call'));
    // Still scripted: the batch asks for these regardless of the balance outcome.
    rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeDecimals() }, 'latest'], uintWord(6));
    rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeSymbol() }, 'latest'], USDC_SYMBOL_HEX);
    const provider = new EvmWalletDataProvider(rpc);

    const rows = await provider.getAllAssetBalances(ADDRESS);

    expect(rows).toEqual([{ name: 'ETH', amountBase: 0n, scale: 18, decimals: 18, isNative: true }]);
  });

  it('a token whose balanceOf returns undecodable data is skipped, and nothing is cached for it', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(0));
    // 3 bytes: not a valid uint256 return width.
    rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], '0x010203');
    rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeDecimals() }, 'latest'], uintWord(6));
    rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeSymbol() }, 'latest'], USDC_SYMBOL_HEX);
    const provider = new EvmWalletDataProvider(rpc);

    const rows = await provider.getAllAssetBalances(ADDRESS);
    expect(rows).toEqual([{ name: 'ETH', amountBase: 0n, scale: 18, decimals: 18, isNative: true }]);
  });

  it('preserves tracked order across a skip: [native, A, C] when B reverts', async () => {
    const A: EvmTokenRef = { address: '0x1111111111111111111111111111111111111111', symbol: 'A', decimals: 8 };
    const B: EvmTokenRef = { address: '0x2222222222222222222222222222222222222222', symbol: 'B', decimals: 8 };
    const C: EvmTokenRef = { address: '0x3333333333333333333333333333333333333333', symbol: 'C', decimals: 8 };
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(0));
    for (const [token, amount] of [
      [A, 1n],
      [C, 3n],
    ] as const) {
      rpc.mockOk('eth_call', [{ to: token.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], uintWord(amount));
    }
    rpc.mockRevert('eth_call', [{ to: B.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], revertError('eth_call'));
    for (const token of [A, B, C]) {
      rpc.mockOk('eth_call', [{ to: token.address, data: encodeDecimals() }, 'latest'], uintWord(9));
      rpc.mockOk('eth_call', [{ to: token.address, data: encodeSymbol() }, 'latest'], bytes32String(token.symbol!));
    }
    const provider = new EvmWalletDataProvider(rpc, { tokens: [A, B, C] });

    const rows = await provider.getAllAssetBalances(ADDRESS);

    expect(rows.map((r) => r.name)).toEqual(['ETH', 'A', 'C']);
    expect(rows[1]).toEqual({ name: 'A', amountBase: 1n, scale: 9, decimals: 9, isNative: false });
    expect(rows[2]).toEqual({ name: 'C', amountBase: 3n, scale: 9, decimals: 9, isNative: false });
  });

  it('decimals/symbol fall back to the EvmTokenRef hint when the chain call reverts', async () => {
    const token: EvmTokenRef = { address: '0x4444444444444444444444444444444444444444', symbol: 'HINT', decimals: 11 };
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(0));
    rpc.mockOk('eth_call', [{ to: token.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], uintWord(42));
    rpc.mockRevert('eth_call', [{ to: token.address, data: encodeDecimals() }, 'latest'], revertError('eth_call'));
    rpc.mockRevert('eth_call', [{ to: token.address, data: encodeSymbol() }, 'latest'], revertError('eth_call'));
    const provider = new EvmWalletDataProvider(rpc, { tokens: [token] });

    const rows = await provider.getAllAssetBalances(ADDRESS);
    expect(rows[1]).toEqual({ name: 'HINT', amountBase: 42n, scale: 11, decimals: 11, isNative: false });
  });

  it('symbol falls back to a short address form with no hint and a reverting symbol()', async () => {
    const token: EvmTokenRef = { address: USDC.address }; // no symbol/decimals hint
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(0));
    rpc.mockOk('eth_call', [{ to: token.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], uintWord(1));
    rpc.mockOk('eth_call', [{ to: token.address, data: encodeDecimals() }, 'latest'], uintWord(6));
    rpc.mockRevert('eth_call', [{ to: token.address, data: encodeSymbol() }, 'latest'], revertError('eth_call'));
    const provider = new EvmWalletDataProvider(rpc, { tokens: [token] });

    const rows = await provider.getAllAssetBalances(ADDRESS);
    expect(rows[1].name).toBe('0x8335…2913');
  });

  it('a token whose decimals() reverts WITHOUT a hint is skipped (no safe scale) and nothing is cached, so it is retried', async () => {
    const token: EvmTokenRef = { address: '0x4444444444444444444444444444444444444444' }; // no hint at all
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(0));
    rpc.mockOk('eth_call', [{ to: token.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], uintWord(10n ** 18n));
    rpc.mockRevert('eth_call', [{ to: token.address, data: encodeDecimals() }, 'latest'], revertError('eth_call'));
    rpc.mockOk('eth_call', [{ to: token.address, data: encodeSymbol() }, 'latest'], bytes32String('WEIRD'));
    const provider = new EvmWalletDataProvider(rpc, { tokens: [token] });

    const first = await provider.getAllAssetBalances(ADDRESS);
    // Not shown as 1e18 whole tokens: the row is absent this refresh.
    expect(first).toHaveLength(1);
    expect(first[0].isNative).toBe(true);

    // The chain answers next time: the token appears with the real scale.
    rpc.mockOk('eth_call', [{ to: token.address, data: encodeDecimals() }, 'latest'], uintWord(18));
    const second = await provider.getAllAssetBalances(ADDRESS);
    expect(second[1]).toEqual({ name: 'WEIRD', amountBase: 10n ** 18n, scale: 18, decimals: 18, isNative: false });
  });

  it('native eth_getBalance failing throws NetworkOfflineError', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockRevert('eth_getBalance', [ADDRESS, 'latest'], revertError('eth_getBalance'));
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await expect(provider.getAllAssetBalances(ADDRESS)).rejects.toBeInstanceOf(NetworkOfflineError);
  });

  it('batch throwing EvmRpcUnavailableError throws NetworkOfflineError', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.batchError = new EvmRpcUnavailableError('for batch [eth_getBalance]', []);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await expect(provider.getAllAssetBalances(ADDRESS)).rejects.toBeInstanceOf(NetworkOfflineError);
  });

  it('an invalid address throws a plain Error, not NetworkOfflineError, before any call', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await expect(provider.getAllAssetBalances('not-an-address')).rejects.toThrow(/not a valid EVM address/);
    await expect(provider.getAllAssetBalances('not-an-address')).rejects.not.toBeInstanceOf(NetworkOfflineError);
    expect(rpc.batchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getAssetMeta

describe('getAssetMeta', () => {
  const TOKEN = '0x5555555555555555555555555555555555555555' as const;

  it('a valid ERC-20 contract: exists true, decimals from the chain', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_call', [{ to: TOKEN, data: encodeDecimals() }, 'latest'], uintWord(6));
    rpc.mockOk('eth_call', [{ to: TOKEN, data: encodeSymbol() }, 'latest'], USDC_SYMBOL_HEX);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    const meta = await provider.getAssetMeta(TOKEN);
    expect(meta).toEqual({ exists: true, decimals: 6, reissuable: false, supply: 0, hasIpfs: false });
  });

  it('serves the second lookup from cache: one batch total', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_call', [{ to: TOKEN, data: encodeDecimals() }, 'latest'], uintWord(6));
    rpc.mockOk('eth_call', [{ to: TOKEN, data: encodeSymbol() }, 'latest'], USDC_SYMBOL_HEX);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await provider.getAssetMeta(TOKEN);
    await provider.getAssetMeta(TOKEN);
    expect(rpc.batchCalls).toHaveLength(1);
  });

  it('a bare symbol, not an address, is unanswerable: null, with no call made', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await expect(provider.getAssetMeta('USDC')).resolves.toBeNull();
    expect(rpc.batchCalls).toHaveLength(0);
  });

  it('a reverting contract: exists false', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockRevert('eth_call', [{ to: TOKEN, data: encodeDecimals() }, 'latest'], revertError('eth_call'));
    rpc.mockOk('eth_call', [{ to: TOKEN, data: encodeSymbol() }, 'latest'], USDC_SYMBOL_HEX);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    const meta = await provider.getAssetMeta(TOKEN);
    expect(meta).toEqual({ exists: false, decimals: 0, reissuable: false, supply: 0, hasIpfs: false });
  });

  it('transport failure throws NetworkOfflineError', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.batchError = new EvmRpcUnavailableError('for batch [eth_call]', []);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await expect(provider.getAssetMeta(TOKEN)).rejects.toBeInstanceOf(NetworkOfflineError);
  });
});

// ---------------------------------------------------------------------------
// getAssetBalance

describe('getAssetBalance (whole units, display only)', () => {
  it('native ticker: 1.5 ETH (18 decimals)', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(1_500_000_000_000_000_000n));
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await expect(provider.getAssetBalance(ADDRESS, 'ETH')).resolves.toBe(1.5);
  });

  it('a token contract: 12.345678 (12345678 base units, 6 decimals)', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeDecimals() }, 'latest'], uintWord(6));
    rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], uintWord(12345678));
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await expect(provider.getAssetBalance(ADDRESS, USDC.address)).resolves.toBe(12.345678);
  });

  it('reuses cached decimals for a tracked token: only the balanceOf call is made', async () => {
    const rpc = scriptedRpc();
    const provider = new EvmWalletDataProvider(rpc); // default tokens = [USDC]
    await provider.getAllAssetBalances(ADDRESS); // populates the decimals cache
    const callsBefore = rpc.callLog.length;

    const balance = await provider.getAssetBalance(ADDRESS, USDC.address);
    expect(balance).toBe(12.345678);
    // No extra decimals() call: only one more (the balanceOf single call).
    expect(rpc.callLog.length).toBe(callsBefore + 1);
  });

  it('anything else resolves 0, with no call made', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await expect(provider.getAssetBalance(ADDRESS, 'NOT-A-TOKEN')).resolves.toBe(0);
    expect(rpc.callLog).toHaveLength(0);
  });

  it('transport failure throws NetworkOfflineError', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.callError = new EvmRpcUnavailableError('for eth_getBalance', []);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });

    await expect(provider.getAssetBalance(ADDRESS, 'ETH')).rejects.toBeInstanceOf(NetworkOfflineError);
  });
});

// ---------------------------------------------------------------------------
// getBalances (WalletDataProvider's closed-AssetId shape)

describe('getBalances', () => {
  it('maps getAllAssetBalances rows to AssetBalance[]', async () => {
    const rpc = scriptedRpc();
    const provider = new EvmWalletDataProvider(rpc);

    const balances = await provider.getBalances(ADDRESS);
    expect(balances).toEqual([
      { assetId: 'ETH', amountBase: 10n ** 18n, scale: 18 },
      { assetId: 'USDC', amountBase: 12345678n, scale: 6 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// setTokens / getTokens

describe('setTokens / getTokens', () => {
  it('constructor default: chain.defaultTokens', () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc);
    expect(provider.getTokens()).toEqual(CHAIN.defaultTokens);
  });

  it('constructor default: [] when the chain has no defaultTokens', () => {
    const chainWithNoTokens: EvmChain = { ...CHAIN, defaultTokens: undefined };
    const rpc = new FakeRpcClient(chainWithNoTokens);
    const provider = new EvmWalletDataProvider(rpc);
    expect(provider.getTokens()).toEqual([]);
  });

  it('an explicit tokens option overrides the chain defaults', () => {
    const only: EvmTokenRef = { address: '0x6666666666666666666666666666666666666666' };
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [only] });
    expect(provider.getTokens()).toEqual([only]);
  });

  it('dedupes by lowercase address, keeping the first occurrence', () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });
    const dup: EvmTokenRef = { address: USDC.address.toLowerCase(), symbol: 'DUPLICATE' };
    const other: EvmTokenRef = { address: '0x7777777777777777777777777777777777777777' };

    provider.setTokens([USDC, dup, other]);
    expect(provider.getTokens()).toEqual([USDC, other]);
  });

  it('throws on an invalid address and leaves the previous list intact', () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });
    const good: EvmTokenRef = { address: '0x8888888888888888888888888888888888888888' };
    provider.setTokens([good]);

    expect(() => provider.setTokens([{ address: 'not-an-address' }])).toThrow(/not a valid EVM address/);
    expect(provider.getTokens()).toEqual([good]);
  });

  it('does not clear the metadata cache', async () => {
    const rpc = scriptedRpc();
    const provider = new EvmWalletDataProvider(rpc); // default tokens = [USDC]
    await provider.getAllAssetBalances(ADDRESS); // caches USDC's decimals/symbol
    provider.setTokens([USDC]); // re-set the same (deduped) list

    const rows = await provider.getAllAssetBalances(ADDRESS);
    expect(rows[1]).toEqual({ name: 'USDC', amountBase: 12345678n, scale: 6, decimals: 6, isNative: false });
    // Two refreshes total; neither after the first should re-ask for metadata.
    expect(rpc.batchCalls[1]).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getTransactions / getAssets — phase 2 has no indexer.

describe('getTransactions / getAssets', () => {
  it('getTransactions resolves empty (no indexer until phase 4)', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });
    await expect(provider.getTransactions(ADDRESS)).resolves.toEqual([]);
  });

  it('getAssets resolves empty', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });
    await expect(provider.getAssets()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// simulateTransaction / submitTransaction — the send path is phase 3.

describe('simulateTransaction / submitTransaction', () => {
  const request: TransactionRequest = { from: ADDRESS, to: ADDRESS, assetId: 'EVR', amount: 1 };

  it('simulateTransaction rejects without pretending to have sent anything', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });
    await expect(provider.simulateTransaction(request)).rejects.toThrow(
      'EVM send is not available in this build (phase 3)',
    );
  });

  it('submitTransaction rejects without pretending to have sent anything', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    const provider = new EvmWalletDataProvider(rpc, { tokens: [] });
    await expect(provider.submitTransaction(request)).rejects.toThrow(
      'EVM send is not available in this build (phase 3)',
    );
  });
});

// ---------------------------------------------------------------------------
// createEvmProvider: real client wiring, through a fake fetch.

describe('createEvmProvider', () => {
  it('composes the real EvmRpcClient: a chainId probe, then one batched HTTP request', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as unknown;
      seen.push({ url, body });

      if (!Array.isArray(body)) {
        const req = body as { id: number; method: string };
        expect(req.method).toBe('eth_chainId');
        return jsonResponse({ jsonrpc: '2.0', id: req.id, result: toQuantity(CHAIN.chainId) });
      }

      const results = (body as Array<{ id: number; method: string }>).map((req) => {
        if (req.method === 'eth_blockNumber') {
          return { jsonrpc: '2.0', id: req.id, result: toQuantity(0x2000000) };
        }
        if (req.method === 'eth_getBlockByNumber') {
          return { jsonrpc: '2.0', id: req.id, result: { timestamp: TIMESTAMP_HEX } };
        }
        throw new Error(`unscripted method in fake fetch: ${req.method}`);
      });
      return jsonResponse(results);
    };

    const provider = createEvmProvider(CHAIN, { rpc: { fetchImpl } });
    const status = await provider.getNetworkStatus();

    expect(status.state).toBe('connected');
    expect(status.blockHeight).toBe(0x2000000);
    expect(status.tipTime).toBe(EXPECTED_TIP_TIME);

    // One single HTTP request for the chainId probe, then ONE more for the
    // whole batch (not one per call): exactly two fetches total.
    expect(seen).toHaveLength(2);
    expect(Array.isArray(seen[0].body)).toBe(false);
    expect(Array.isArray(seen[1].body)).toBe(true);
    expect((seen[1].body as unknown[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getSnapshot + 'alchemy' token reads (metered-provider economy)

describe('getSnapshot and the alchemy token-balance mode', () => {
  it('reads status + balances in ONE batch; the tip time is re-read only once a minute', async () => {
    let t = 1_000_000;
    const rpc = scriptedRpc();
    rpc.mockOk('eth_blockNumber', [], '0x2000000');
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], { timestamp: '0x66f00000' });
    const provider = new EvmWalletDataProvider(rpc, { now: () => t });
    const first = await provider.getSnapshot(ADDRESS);
    expect(rpc.batchCalls).toHaveLength(1);
    expect(rpc.batchCalls[0].map((c) => c.method)).toEqual(['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_call', 'eth_call', 'eth_call']);
    expect(first.network.state).toBe('connected');
    expect(first.network.blockHeight).toBe(0x2000000);
    expect(first.network.tipTime).toBe(0x66f00000 * 1000);
    expect(first.assets?.map((a) => a.name)).toEqual(['ETH', 'USDC']);
    // Second tick 20 s later: no block read, no metadata re-read, tip time cached.
    t += 20_000;
    const second = await provider.getSnapshot(ADDRESS);
    expect(rpc.batchCalls[1].map((c) => c.method)).toEqual(['eth_blockNumber', 'eth_getBalance', 'eth_call']);
    expect(second.network.tipTime).toBe(0x66f00000 * 1000);
    // After a minute the tip time is read again.
    t += 61_000;
    await provider.getSnapshot(ADDRESS);
    expect(rpc.batchCalls[2].map((c) => c.method)).toEqual(['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_call']);
  });

  it('alchemy mode: ONE alchemy_getTokenBalances for every tracked contract (+ metadata once), balances parsed from padded words', async () => {
    const other: EvmTokenRef = { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 };
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_blockNumber', [], '0x10');
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], { timestamp: '0x66f00000' });
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(10n ** 18n));
    rpc.mockOk('alchemy_getTokenBalances', [ADDRESS, [USDC.address, other.address]], {
      address: ADDRESS,
      tokenBalances: [
        { contractAddress: USDC.address.toLowerCase(), tokenBalance: '0x' + 'bc614e'.padStart(64, '0') },
        { contractAddress: other.address, tokenBalance: '0x' + '5'.padStart(64, '0') },
      ],
    });
    rpc.mockOk('alchemy_getTokenMetadata', [USDC.address], { decimals: 6, symbol: 'USDC', name: 'USD Coin', logo: null });
    rpc.mockOk('alchemy_getTokenMetadata', [other.address], { decimals: 18, symbol: 'WETH', name: 'Wrapped Ether', logo: null });
    const provider = new EvmWalletDataProvider(rpc, { tokens: [USDC, other], tokenBalances: 'alchemy' });
    const snap = await provider.getSnapshot(ADDRESS);
    expect(rpc.batchCalls[0].map((c) => c.method)).toEqual(['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBalance', 'alchemy_getTokenBalances', 'alchemy_getTokenMetadata', 'alchemy_getTokenMetadata']);
    expect(snap.assets).toEqual([
      { name: 'ETH', amountBase: 10n ** 18n, scale: 18, decimals: 18, isNative: true },
      { name: 'USDC', amountBase: 12345678n, scale: 6, decimals: 6, isNative: false },
      { name: 'WETH', amountBase: 5n, scale: 18, decimals: 18, isNative: false },
    ]);
    // Next read: one token-balances call, no metadata.
    await provider.getSnapshot(ADDRESS);
    expect(rpc.batchCalls[1].map((c) => c.method)).toEqual(['eth_blockNumber', 'eth_getBalance', 'alchemy_getTokenBalances']);
  });

  it('alchemy mode falls back to per-token eth_call when the endpoint refuses the method (e.g. after a failover)', async () => {
    const rpc = scriptedRpc();
    rpc.mockOk('eth_blockNumber', [], '0x10');
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], { timestamp: '0x66f00000' });
    rpc.mockRevert('alchemy_getTokenBalances', [ADDRESS, [USDC.address]], new EvmRpcError('alchemy_getTokenBalances', -32601, 'method not found'));
    rpc.mockRevert('alchemy_getTokenMetadata', [USDC.address], new EvmRpcError('alchemy_getTokenMetadata', -32601, 'method not found'));
    const provider = new EvmWalletDataProvider(rpc, { tokenBalances: 'alchemy' });
    const snap = await provider.getSnapshot(ADDRESS);
    expect(snap.assets?.map((a) => `${a.name}=${a.amountBase}`)).toEqual(['ETH=1000000000000000000', 'USDC=12345678']);
    expect(rpc.batchCalls).toHaveLength(2);
    expect(rpc.batchCalls[1].every((c) => c.method === 'eth_getBalance' || c.method === 'eth_call')).toBe(true);
  });

  it('a refused native balance leaves network connected and assets null', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_blockNumber', [], '0x10');
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], { timestamp: '0x66f00000' });
    rpc.mockRevert('eth_getBalance', [ADDRESS, 'latest'], new EvmRpcError('eth_getBalance', -32000, 'header not found'));
    rpc.mockRevert('eth_call', [{ to: USDC.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], new EvmRpcError('eth_call', 3, 'x'));
    rpc.mockRevert('eth_call', [{ to: USDC.address, data: encodeDecimals() }, 'latest'], new EvmRpcError('eth_call', 3, 'x'));
    rpc.mockRevert('eth_call', [{ to: USDC.address, data: encodeSymbol() }, 'latest'], new EvmRpcError('eth_call', 3, 'x'));
    const provider = new EvmWalletDataProvider(rpc);
    const snap = await provider.getSnapshot(ADDRESS);
    expect(snap.network.state).toBe('connected');
    expect(snap.assets).toBe(null);
    expect(snap.complete).toBe(false);
  });

  // A token that did not answer is left out of the rows (showing it as 0 would
  // be a lie), which used to make a rate-limited read indistinguishable from
  // "that token is gone". `complete` is the difference the store's merge needs.
  it('a read where every token answered is COMPLETE', async () => {
    const rpc = scriptedRpc();
    rpc.mockOk('eth_blockNumber', [], '0x10');
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], { timestamp: '0x66f00000' });
    const snap = await new EvmWalletDataProvider(rpc).getSnapshot(ADDRESS);
    expect(snap.assets?.map((a) => a.name)).toEqual(['ETH', 'USDC']);
    expect(snap.complete).toBe(true);
  });

  it('a token whose balanceOf refused makes the read PARTIAL, and the token is absent rather than zero', async () => {
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_blockNumber', [], '0x10');
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], { timestamp: '0x66f00000' });
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(10n ** 18n));
    rpc.mockRevert(
      'eth_call',
      [{ to: USDC.address, data: encodeBalanceOf(ADDRESS) }, 'latest'],
      new EvmRpcError('eth_call', -32005, 'limit exceeded'),
    );
    rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeDecimals() }, 'latest'], uintWord(6));
    rpc.mockOk('eth_call', [{ to: USDC.address, data: encodeSymbol() }, 'latest'], USDC_SYMBOL_HEX);
    const snap = await new EvmWalletDataProvider(rpc).getSnapshot(ADDRESS);
    expect(snap.assets?.map((a) => a.name)).toEqual(['ETH']);
    expect(snap.complete).toBe(false);
  });

  it('a token with no readable SCALE makes the read partial too (the row is skipped, not shown at a guessed scale)', async () => {
    // A token ref with no decimals hint: decimals() refusing leaves no safe
    // scale, so the row is skipped and the read is not complete.
    const unknown: EvmTokenRef = { address: '0x4200000000000000000000000000000000000006' };
    const rpc = new FakeRpcClient(CHAIN);
    rpc.mockOk('eth_blockNumber', [], '0x10');
    rpc.mockOk('eth_getBlockByNumber', ['latest', false], { timestamp: '0x66f00000' });
    rpc.mockOk('eth_getBalance', [ADDRESS, 'latest'], toQuantity(10n ** 18n));
    rpc.mockOk('eth_call', [{ to: unknown.address, data: encodeBalanceOf(ADDRESS) }, 'latest'], uintWord(5));
    rpc.mockRevert('eth_call', [{ to: unknown.address, data: encodeDecimals() }, 'latest'], new EvmRpcError('eth_call', 3, 'execution reverted'));
    rpc.mockRevert('eth_call', [{ to: unknown.address, data: encodeSymbol() }, 'latest'], new EvmRpcError('eth_call', 3, 'execution reverted'));
    const snap = await new EvmWalletDataProvider(rpc, { tokens: [unknown] }).getSnapshot(ADDRESS);
    expect(snap.assets?.map((a) => a.name)).toEqual(['ETH']);
    expect(snap.complete).toBe(false);
  });
});
