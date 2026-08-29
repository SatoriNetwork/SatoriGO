// Tests for the EVM JSON-RPC client.
//
// NO NETWORK IS TOUCHED HERE, ever: every test injects `fetchImpl`, and the
// fake below throws if a request arrives for a url the test did not script.
// The chains used are fictional hosts (rpc-a.example / rpc-b.example), not the
// real ones in chains.ts, so a bug that ignored fetchImpl would fail DNS rather
// than reach a public node.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { type EvmChain } from './chains';
import {
  createEvmRpcClient,
  EvmRpcError,
  EvmRpcUnavailableError,
  toQuantity,
  fromQuantity,
  toHexData,
  fromHexData,
  type EvmRpcCall,
} from './rpc';

const URL_A = 'https://rpc-a.example/';
const URL_B = 'https://rpc-b.example/';
/** 8453 = Base, the chain phase 2 reads first. */
const CHAIN_ID = 8453;
const CHAIN_ID_HEX = '0x2105';

function testChain(rpc: string[]): EvmChain {
  return {
    key: 'test',
    chainId: CHAIN_ID,
    displayName: 'Test Chain',
    nativeTicker: 'ETH',
    nativeDecimals: 18,
    rpc,
    explorerTxUrl: 'https://explorer.example/tx/{txid}',
    homepage: 'https://example.test',
    young: false,
    recentlyAdded: false,
    feeModel: 'eip1559',
  };
}

const PAIR = testChain([URL_A, URL_B]);
const SOLO = testChain([URL_A]);

// ---------------------------------------------------------------------------
// Fake fetch
//
// Each url gets an ordered queue of replies, one consumed per HTTP request, so
// a test states exactly how many round trips it expects (including the
// eth_chainId verification, which is a round trip like any other). A request
// with no reply left is recorded in `overflow` AND rejected, so an unexpected
// extra request can never be silently absorbed by the failover logic.
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: unknown[];
}

interface Sent {
  url: string;
  raw: string;
  httpMethod: string | undefined;
  headers: Record<string, string> | undefined;
  isBatch: boolean;
  requests: RpcRequest[];
  signal: AbortSignal | null | undefined;
}

type Reply = (sent: Sent) => Response | Promise<Response>;

interface FakeNet {
  fetchImpl: typeof fetch;
  sent: Sent[];
  overflow: string[];
  to(url: string): Sent[];
  methodsTo(url: string): string[];
}

function makeFetch(script: Record<string, Reply[]>): FakeNet {
  const sent: Sent[] = [];
  const overflow: string[] = [];
  const queues = new Map<string, Reply[]>(
    Object.entries(script).map(([url, replies]) => [url, replies.slice()]),
  );

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(raw) as RpcRequest | RpcRequest[];
    const record: Sent = {
      url,
      raw,
      httpMethod: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      isBatch: Array.isArray(parsed),
      requests: Array.isArray(parsed) ? parsed : [parsed],
      signal: init?.signal,
    };
    sent.push(record);
    const queue = queues.get(url);
    if (!queue || queue.length === 0) {
      overflow.push(`${url} ${record.requests.map((r) => r.method).join(',')}`);
      throw new Error('test script has no reply left for this url');
    }
    const reply = queue.splice(0, 1)[0];
    return reply(record);
  };

  return {
    fetchImpl,
    sent,
    overflow,
    to: (url) => sent.filter((s) => s.url === url),
    methodsTo: (url) => sent.filter((s) => s.url === url).flatMap((s) => s.requests.map((r) => r.method)),
  };
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Correct eth_chainId answer for the test chain. */
const chainIdOk: Reply = (sent) =>
  jsonResponse({ jsonrpc: '2.0', id: sent.requests[0].id, result: CHAIN_ID_HEX });

/** eth_chainId answering for some other network. */
const chainIdIs = (hex: string): Reply => (sent) =>
  jsonResponse({ jsonrpc: '2.0', id: sent.requests[0].id, result: hex });

const resultReply =
  (value: unknown): Reply =>
  (sent) =>
    jsonResponse({ jsonrpc: '2.0', id: sent.requests[0].id, result: value });

/** Echoes the method name back as the result, so a test can assert which call
 *  got which answer without depending on completion order. */
const echoMethod: Reply = (sent) =>
  jsonResponse({ jsonrpc: '2.0', id: sent.requests[0].id, result: sent.requests[0].method });

const errorReply =
  (code: number, message: string, data?: unknown): Reply =>
  (sent) =>
    jsonResponse({
      jsonrpc: '2.0',
      id: sent.requests[0].id,
      error: data === undefined ? { code, message } : { code, message, data },
    });

const httpStatus =
  (status: number): Reply =>
  () =>
    new Response('the gateway is unhappy', { status });

const networkFails =
  (message: string): Reply =>
  () => {
    throw new Error(message);
  };

const rawBody =
  (body: string): Reply =>
  () =>
    new Response(body, { status: 200 });

/** Any literal JSON payload, for the malformed-envelope cases. */
const literal =
  (payload: unknown): Reply =>
  () =>
    jsonResponse(payload);

/** Never settles until the request is aborted, then rejects the way fetch does. */
const hangsUntilAborted: Reply = (sent) =>
  new Promise<Response>((_resolve, reject) => {
    sent.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Quantity and data helpers
// ---------------------------------------------------------------------------

describe('toQuantity', () => {
  it('encodes the canonical vectors', () => {
    expect(toQuantity(0n)).toBe('0x0');
    expect(toQuantity(0)).toBe('0x0');
    expect(toQuantity(8453)).toBe('0x2105');
    expect(toQuantity(8453n)).toBe('0x2105');
    expect(toQuantity(255n)).toBe('0xff');
    // One whole ether, far past Number.MAX_SAFE_INTEGER: the reason the amount
    // layer is bigint end to end.
    expect(toQuantity(10n ** 18n)).toBe('0xde0b6b3a7640000');
  });

  it('never emits leading zeros', () => {
    expect(toQuantity(1n)).toBe('0x1');
    expect(toQuantity(16n)).toBe('0x10');
  });

  it('throws on a negative value', () => {
    expect(() => toQuantity(-1n)).toThrow(/negative/);
    expect(() => toQuantity(-1)).toThrow(/negative/);
  });

  it('throws on a non-integer or unsafe number', () => {
    expect(() => toQuantity(1.5)).toThrow(/safe integer/);
    expect(() => toQuantity(Number.NaN)).toThrow(/safe integer/);
    expect(() => toQuantity(Number.POSITIVE_INFINITY)).toThrow(/safe integer/);
    // 2**60 is an integer-valued double but not an exact one.
    expect(() => toQuantity(2 ** 60)).toThrow(/safe integer/);
  });
});

describe('fromQuantity', () => {
  it('decodes the canonical vectors', () => {
    expect(fromQuantity('0x2105')).toBe(8453n);
    expect(fromQuantity('0x0')).toBe(0n);
    expect(fromQuantity('0xff')).toBe(255n);
    expect(fromQuantity('0xFF')).toBe(255n);
    expect(fromQuantity('0xde0b6b3a7640000')).toBe(10n ** 18n);
  });

  it('rejects a non-canonical or non-string quantity', () => {
    expect(() => fromQuantity('0x02105')).toThrow(/quantity/); // leading zero
    expect(() => fromQuantity('2105')).toThrow(/quantity/); // no 0x
    expect(() => fromQuantity('0x')).toThrow(/quantity/); // no digits
    expect(() => fromQuantity('0xzz')).toThrow(/quantity/); // not hex
    expect(() => fromQuantity('0x21 05')).toThrow(/quantity/);
    expect(() => fromQuantity(8453)).toThrow(/expected a string/);
    expect(() => fromQuantity(null)).toThrow(/expected a string/);
    expect(() => fromQuantity(undefined)).toThrow(/expected a string/);
    expect(() => fromQuantity(['0x1'])).toThrow(/expected a string/);
  });

  it('round trips with toQuantity', () => {
    for (const value of [0n, 1n, 255n, 8453n, 10n ** 18n, 2n ** 200n]) {
      expect(fromQuantity(toQuantity(value))).toBe(value);
    }
  });
});

describe('toHexData / fromHexData', () => {
  it('encodes bytes as even-length lowercase hex', () => {
    expect(toHexData(new Uint8Array())).toBe('0x');
    expect(toHexData(new Uint8Array([0, 1, 171]))).toBe('0x0001ab');
    expect(toHexData(new Uint8Array([255, 16]))).toBe('0xff10');
  });

  it('decodes data, empty included', () => {
    expect(Array.from(fromHexData('0x'))).toEqual([]);
    expect(Array.from(fromHexData('0x0001ab'))).toEqual([0, 1, 171]);
    expect(Array.from(fromHexData('0xFF10'))).toEqual([255, 16]);
  });

  it('rejects odd length, non-hex and non-strings', () => {
    expect(() => fromHexData('0xabc')).toThrow(/data/); // half a byte
    expect(() => fromHexData('0xzz')).toThrow(/data/);
    expect(() => fromHexData('abcd')).toThrow(/data/); // no 0x
    expect(() => fromHexData('')).toThrow(/data/);
    expect(() => fromHexData(0x10)).toThrow(/expected a string/);
    expect(() => fromHexData(new Uint8Array([1]))).toThrow(/expected a string/);
  });

  it('round trips', () => {
    const bytes = new Uint8Array([0, 127, 128, 255, 1, 2, 3]);
    expect(Array.from(fromHexData(toHexData(bytes)))).toEqual(Array.from(bytes));
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('request shape', () => {
  it('posts a JSON-RPC 2.0 envelope with a json content type', async () => {
    const net = makeFetch({ [URL_A]: [chainIdOk, resultReply('0x1234')] });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    await client.call('eth_getBalance', ['0xabc', 'latest']);

    expect(net.sent).toHaveLength(2);
    const [check, real] = net.sent;
    expect(check.httpMethod).toBe('POST');
    expect(check.headers).toEqual({ 'content-type': 'application/json' });
    expect(check.requests[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
    expect(real.httpMethod).toBe('POST');
    expect(real.requests[0]).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_getBalance',
      params: ['0xabc', 'latest'],
    });
  });

  it('defaults params to an empty array', async () => {
    const net = makeFetch({ [URL_A]: [chainIdOk, resultReply('0x1')] });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    await client.call('eth_blockNumber');

    expect(net.sent[1].requests[0].params).toEqual([]);
  });

  it('uses unique, increasing ids per client', async () => {
    const net = makeFetch({ [URL_A]: [chainIdOk, resultReply('0x1'), resultReply('0x2')] });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    await client.call('eth_blockNumber');
    await client.call('eth_gasPrice');

    const ids = net.sent.flatMap((s) => s.requests.map((r) => r.id));
    expect(ids).toEqual([1, 2, 3]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses to build a client for a chain with no endpoints', () => {
    expect(() => createEvmRpcClient(testChain([]))).toThrow(/no RPC endpoints/);
  });
});

// ---------------------------------------------------------------------------
// Happy path, endpoint state
// ---------------------------------------------------------------------------

describe('call', () => {
  it('returns the node result and records the endpoint and latency', async () => {
    const net = makeFetch({ [URL_A]: [chainIdOk, resultReply('0x2540be400')] });
    let clock = 0;
    const client = createEvmRpcClient(SOLO, {
      fetchImpl: net.fetchImpl,
      now: () => (clock += 7),
    });

    expect(client.activeEndpoint()).toBeNull();
    expect(client.lastLatencyMs()).toBeNull();
    expect(client.chain.key).toBe('test');

    const result = await client.call<string>('eth_getBalance', ['0xabc', 'latest']);

    expect(result).toBe('0x2540be400');
    expect(fromQuantity(result)).toBe(10000000000n);
    expect(client.activeEndpoint()).toBe(URL_A);
    // now() is called once before and once after each round trip, so the
    // injected clock (7 ms per tick) makes the latency exactly one tick.
    expect(client.lastLatencyMs()).toBe(7);
  });

  it('returns a null result as null (an unknown receipt is not an error)', async () => {
    const net = makeFetch({ [URL_A]: [chainIdOk, resultReply(null)] });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    await expect(client.call('eth_getTransactionReceipt', ['0xdead'])).resolves.toBeNull();
  });

  it('throws EvmRpcError on a JSON-RPC error and does NOT fail over', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, errorReply(3, 'execution reverted', '0x08c379a0')],
      [URL_B]: [],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    const err = await client.call('eth_call', [{ to: '0xabc' }]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcError);
    const rpcErr = err as EvmRpcError;
    expect(rpcErr.code).toBe(3);
    expect(rpcErr.method).toBe('eth_call');
    expect(rpcErr.data).toBe('0x08c379a0');
    expect(rpcErr.message).toContain('eth_call');
    expect(rpcErr.message).toContain('execution reverted');
    // A revert on endpoint A reverts on endpoint B too: the second endpoint is
    // never contacted, and A stays the endpoint in use because it answered.
    expect(net.to(URL_B)).toHaveLength(0);
    expect(client.activeEndpoint()).toBe(URL_A);
  });

  it('accepts a node that sends a bare string as its error', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, literal({ jsonrpc: '2.0', id: 2, error: 'nope' })],
      [URL_B]: [],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    const err = await client.call('eth_call').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcError);
    expect((err as EvmRpcError).code).toBe(0);
    expect((err as EvmRpcError).message).toContain('nope');
    expect(net.to(URL_B)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

describe('failover', () => {
  it('moves to the next endpoint when fetch rejects', async () => {
    const net = makeFetch({
      [URL_A]: [networkFails('getaddrinfo ENOTFOUND')],
      [URL_B]: [chainIdOk, resultReply('0x7b')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    await expect(client.call('eth_blockNumber')).resolves.toBe('0x7b');
    expect(client.activeEndpoint()).toBe(URL_B);
  });

  it('moves to the next endpoint on a non-2xx status', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, httpStatus(502)],
      [URL_B]: [chainIdOk, resultReply('0x7b')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    await expect(client.call('eth_blockNumber')).resolves.toBe('0x7b');
    expect(client.activeEndpoint()).toBe(URL_B);
  });

  it('moves to the next endpoint when the body is not JSON', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, rawBody('<html>rate limited</html>')],
      [URL_B]: [chainIdOk, resultReply('0x7b')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    await expect(client.call('eth_blockNumber')).resolves.toBe('0x7b');
  });

  it('moves to the next endpoint when the response id does not match', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, literal({ jsonrpc: '2.0', id: 99, result: '0xdeadbeef' })],
      [URL_B]: [chainIdOk, resultReply('0x7b')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    await expect(client.call('eth_blockNumber')).resolves.toBe('0x7b');
  });

  it('moves to the next endpoint when the response carries neither result nor error', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, literal({ jsonrpc: '2.0', id: 2 })],
      [URL_B]: [chainIdOk, resultReply('0x7b')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    await expect(client.call('eth_blockNumber')).resolves.toBe('0x7b');
  });

  it('throws EvmRpcUnavailableError naming every endpoint when all fail', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, httpStatus(502)],
      [URL_B]: [chainIdOk, networkFails('socket hang up')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    const err = await client.call('eth_blockNumber').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcUnavailableError);
    const unavailable = err as EvmRpcUnavailableError;
    expect(unavailable.attempts).toHaveLength(2);
    expect(unavailable.attempts[0].url).toBe(URL_A);
    expect(unavailable.attempts[0].reason).toContain('HTTP 502');
    expect(unavailable.attempts[1].url).toBe(URL_B);
    expect(unavailable.attempts[1].reason).toContain('socket hang up');
    expect(unavailable.message).toContain('eth_blockNumber');
    expect(client.activeEndpoint()).toBeNull();
    expect(net.overflow).toEqual([]);
  });

  it('is sticky: the next call goes straight to the endpoint that answered', async () => {
    const net = makeFetch({
      [URL_A]: [networkFails('down')],
      [URL_B]: [chainIdOk, resultReply('0x1'), resultReply('0x2')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    await expect(client.call('eth_blockNumber')).resolves.toBe('0x1');
    await expect(client.call('eth_gasPrice')).resolves.toBe('0x2');

    // Endpoint A was tried once (and failed); the second call never touched it,
    // and endpoint B was verified once, not twice.
    expect(net.to(URL_A)).toHaveLength(1);
    expect(net.methodsTo(URL_B)).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_gasPrice']);
  });
});

// ---------------------------------------------------------------------------
// Chain-id verification
// ---------------------------------------------------------------------------

describe('chain-id verification', () => {
  it('checks eth_chainId before the first real request reaches an endpoint', async () => {
    const net = makeFetch({ [URL_A]: [chainIdOk, resultReply('0x1')] });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    await client.call('eth_getBalance', ['0xabc', 'latest']);

    expect(net.methodsTo(URL_A)).toEqual(['eth_chainId', 'eth_getBalance']);
  });

  it('never reads from an endpoint serving a different chain', async () => {
    const net = makeFetch({
      // Answers for Ethereum mainnet (0x1) while we asked for 8453.
      [URL_A]: [chainIdIs('0x1')],
      [URL_B]: [chainIdOk, resultReply('0x7b'), resultReply('0x7c')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    await expect(client.call('eth_getBalance', ['0xabc', 'latest'])).resolves.toBe('0x7b');
    // The real request never went to A: A saw eth_chainId and nothing else.
    expect(net.methodsTo(URL_A)).toEqual(['eth_chainId']);
    expect(client.activeEndpoint()).toBe(URL_B);

    // Struck off for the life of the client: a later call does not re-probe it.
    await expect(client.call('eth_gasPrice')).resolves.toBe('0x7c');
    expect(net.to(URL_A)).toHaveLength(1);
    expect(net.overflow).toEqual([]);
  });

  it('reports every endpoint as unavailable when they all serve another chain', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdIs('0x1')],
      [URL_B]: [chainIdIs('0x38')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    const err = await client.call('eth_blockNumber').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcUnavailableError);
    const attempts = (err as EvmRpcUnavailableError).attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].reason).toContain('wrong chain');
    expect(attempts[0].reason).toContain('1,');
    expect(attempts[1].reason).toContain('56,');
    expect(net.overflow).toEqual([]);
  });

  it('treats a refused chain check as this endpoint failing, not as the caller answer', async () => {
    const net = makeFetch({
      [URL_A]: [errorReply(-32601, 'the method eth_chainId does not exist')],
      [URL_B]: [chainIdOk, resultReply('0x7b')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    // The caller asked for eth_blockNumber, so it gets an answer or an
    // unavailable, never an EvmRpcError about eth_chainId.
    await expect(client.call('eth_blockNumber')).resolves.toBe('0x7b');
    expect(net.methodsTo(URL_A)).toEqual(['eth_chainId']);
  });

  it('treats a malformed chain id as a transport failure', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdIs('8453')], // decimal string, not a quantity
      [URL_B]: [chainIdOk, resultReply('0x7b')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    await expect(client.call('eth_blockNumber')).resolves.toBe('0x7b');
  });

  it('sends one eth_chainId for two overlapping first calls, and answers both', async () => {
    const net = makeFetch({ [URL_A]: [chainIdOk, echoMethod, echoMethod] });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    const [a, b] = await Promise.all([
      client.call<string>('eth_blockNumber'),
      client.call<string>('eth_gasPrice'),
    ]);

    expect(a).toBe('eth_blockNumber');
    expect(b).toBe('eth_gasPrice');
    expect(net.methodsTo(URL_A).filter((m) => m === 'eth_chainId')).toHaveLength(1);
    expect(net.sent).toHaveLength(3);
    expect(net.overflow).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

describe('timeouts', () => {
  it('aborts a request that never answers and fails over', async () => {
    vi.useFakeTimers();
    const net = makeFetch({
      [URL_A]: [hangsUntilAborted],
      [URL_B]: [chainIdOk, resultReply('0x7b')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl, timeoutMs: 5_000 });

    const pending = client.call('eth_blockNumber');
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(pending).resolves.toBe('0x7b');
    expect(net.to(URL_A)[0].signal?.aborted).toBe(true);
  });

  it('reports the timeout as the reason when every endpoint hangs', async () => {
    vi.useFakeTimers();
    const net = makeFetch({
      [URL_A]: [hangsUntilAborted],
      [URL_B]: [hangsUntilAborted],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl, timeoutMs: 5_000 });

    const pending = client.call('eth_blockNumber');
    const settled = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = await settled;

    expect(err).toBeInstanceOf(EvmRpcUnavailableError);
    const attempts = (err as EvmRpcUnavailableError).attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].reason).toBe('timeout after 5000ms');
    expect(attempts[1].reason).toBe('timeout after 5000ms');
  });
});

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

describe('batch', () => {
  const CALLS: EvmRpcCall[] = [
    { method: 'eth_getBalance', params: ['0xaaa', 'latest'] },
    { method: 'eth_call', params: [{ to: '0xbbb' }, 'latest'] },
    { method: 'eth_blockNumber' },
  ];

  it('sends one array request and defaults each params to []', async () => {
    const net = makeFetch({
      [URL_A]: [
        chainIdOk,
        (sent) => jsonResponse(sent.requests.map((r) => ({ jsonrpc: '2.0', id: r.id, result: r.method }))),
      ],
    });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    await client.batch(CALLS);

    expect(net.sent).toHaveLength(2);
    const batchRequest = net.sent[1];
    expect(batchRequest.isBatch).toBe(true);
    expect(batchRequest.requests.map((r) => r.method)).toEqual([
      'eth_getBalance',
      'eth_call',
      'eth_blockNumber',
    ]);
    expect(batchRequest.requests[2].params).toEqual([]);
    expect(new Set(batchRequest.requests.map((r) => r.id)).size).toBe(3);
  });

  it('restores input order when the server reorders the responses', async () => {
    const net = makeFetch({
      [URL_A]: [
        chainIdOk,
        (sent) =>
          jsonResponse(
            sent.requests
              .slice()
              .reverse()
              .map((r) => ({ jsonrpc: '2.0', id: r.id, result: `answer:${r.method}` })),
          ),
      ],
    });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    const out = await client.batch(CALLS);

    expect(out).toEqual([
      { ok: true, result: 'answer:eth_getBalance' },
      { ok: true, result: 'answer:eth_call' },
      { ok: true, result: 'answer:eth_blockNumber' },
    ]);
  });

  it('returns a per-item JSON-RPC error as data, keeping the other results', async () => {
    const net = makeFetch({
      [URL_A]: [
        chainIdOk,
        (sent) =>
          jsonResponse(
            sent.requests.map((r, i) =>
              i === 1
                ? { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted' } }
                : { jsonrpc: '2.0', id: r.id, result: `answer:${r.method}` },
            ),
          ),
      ],
    });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    const out = await client.batch(CALLS);

    expect(out[0]).toEqual({ ok: true, result: 'answer:eth_getBalance' });
    expect(out[2]).toEqual({ ok: true, result: 'answer:eth_blockNumber' });
    expect(out[1].ok).toBe(false);
    const failed = out[1];
    if (failed.ok) throw new Error('expected the second entry to carry an error');
    expect(failed.error).toBeInstanceOf(EvmRpcError);
    expect(failed.error.code).toBe(3);
    expect(failed.error.method).toBe('eth_call');
  });

  it('resolves an empty batch to [] without any HTTP request', async () => {
    const net = makeFetch({ [URL_A]: [] });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    await expect(client.batch([])).resolves.toEqual([]);
    expect(net.sent).toHaveLength(0);
  });

  it('treats a non-array answer to an array request as a transport failure', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, literal({ jsonrpc: '2.0', id: 2, result: '0x1' })],
    });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    const err = await client.batch(CALLS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcUnavailableError);
    expect((err as EvmRpcUnavailableError).attempts[0].reason).toContain('not an array');
  });

  it('treats a missing id as a transport failure', async () => {
    const net = makeFetch({
      [URL_A]: [
        chainIdOk,
        (sent) =>
          jsonResponse(
            sent.requests.slice(1).map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x1' })),
          ),
      ],
    });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    const err = await client.batch(CALLS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcUnavailableError);
    expect((err as EvmRpcUnavailableError).attempts[0].reason).toContain('missing a requested id');
  });

  it('treats an unknown id as a transport failure', async () => {
    const net = makeFetch({
      [URL_A]: [
        chainIdOk,
        (sent) =>
          jsonResponse([
            ...sent.requests.map((r) => ({ jsonrpc: '2.0', id: r.id, result: '0x1' })),
            { jsonrpc: '2.0', id: 4242, result: '0x1' },
          ]),
      ],
    });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    const err = await client.batch(CALLS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcUnavailableError);
    expect((err as EvmRpcUnavailableError).attempts[0].reason).toContain('not requested');
  });

  it('fails the whole batch over to the next endpoint on a transport failure', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, httpStatus(429)],
      [URL_B]: [
        chainIdOk,
        (sent) => jsonResponse(sent.requests.map((r) => ({ jsonrpc: '2.0', id: r.id, result: r.method }))),
      ],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    const out = await client.batch(CALLS);

    expect(out.map((r) => (r.ok ? r.result : 'error'))).toEqual([
      'eth_getBalance',
      'eth_call',
      'eth_blockNumber',
    ]);
    expect(client.activeEndpoint()).toBe(URL_B);
  });
});

// ---------------------------------------------------------------------------
// The request body never appears in an error
// ---------------------------------------------------------------------------

describe('error text', () => {
  // Stands in for a signed transaction: from phase 3 this is what the params of
  // eth_sendRawTransaction hold, and it must never be copied into an error.
  const RAW_TX =
    '0x02f8730182013a8459682f008459682f0e82520894c0ffee254729296a45a3885639ac7e10f9d5497988016345785d8a000080c001a0deadbeef';

  it('keeps the request body out of EvmRpcUnavailableError', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, httpStatus(500)],
      [URL_B]: [chainIdOk, networkFails('connection reset')],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    const err = await client.call('eth_sendRawTransaction', [RAW_TX]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcUnavailableError);
    const unavailable = err as EvmRpcUnavailableError;
    expect(unavailable.message).toContain('eth_sendRawTransaction');
    expect(unavailable.message).not.toContain(RAW_TX);
    for (const attempt of unavailable.attempts) {
      expect(attempt.reason).not.toContain(RAW_TX);
    }
    // The body did go on the wire, exactly once per endpoint: this test proves
    // the error text is clean, not that the request was never sent.
    expect(net.sent[1].raw).toContain(RAW_TX);
  });

  it('keeps the request body out of EvmRpcError', async () => {
    const net = makeFetch({
      [URL_A]: [chainIdOk, errorReply(-32000, 'already known')],
      [URL_B]: [],
    });
    const client = createEvmRpcClient(PAIR, { fetchImpl: net.fetchImpl });

    const err = await client.call('eth_sendRawTransaction', [RAW_TX]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcError);
    expect((err as EvmRpcError).message).toBe(
      'eth_sendRawTransaction failed: -32000 already known',
    );
    expect((err as EvmRpcError).message).not.toContain(RAW_TX);
  });

  it('caps a node message that echoes a large payload back', async () => {
    const echoed = `invalid transaction ${RAW_TX.repeat(20)}`;
    const net = makeFetch({ [URL_A]: [chainIdOk, errorReply(-32000, echoed)] });
    const client = createEvmRpcClient(SOLO, { fetchImpl: net.fetchImpl });

    const err = await client.call('eth_sendRawTransaction', [RAW_TX]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmRpcError);
    const message = (err as EvmRpcError).message;
    expect(message.length).toBeLessThan(300);
    expect(message).toContain('invalid transaction');
    expect(message).toContain('chars)');
  });

  it('keeps a rejected value short in the thrown text', () => {
    // '0z' + 400 hex characters: rejected, and the message must not carry the
    // whole thing (a value this shape could be calldata).
    const rejected = `0z${'ab'.repeat(200)}`;
    expect(() => fromQuantity(rejected)).toThrow(/chars\)/);
    expect(() => fromHexData(rejected)).toThrow(/chars\)/);
  });
});
