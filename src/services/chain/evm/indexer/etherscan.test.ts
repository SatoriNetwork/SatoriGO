// Tests for the Etherscan-shaped indexer client.
//
// NO NETWORK IS TOUCHED HERE, ever: every test injects `fetchImpl`, and the
// fake below throws if a request arrives with no scripted reply left. The
// base URL used throughout is a fictional host (indexer.example), not any
// real one from chains.ts, so a bug that ignored fetchImpl would fail DNS
// rather than reach a public API.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createEtherscanIndexer,
  EvmIndexerError,
  type IndexedTx,
  type IndexedTokenTransfer,
} from './etherscan';

const BASE_URL = 'https://indexer.example/api';
const ADDRESS = '0x1234567890AbcdEF1234567890aBcdef12345678';
const ADDRESS_LOWER = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER_ADDRESS = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const TOKEN_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HASH_A = `0x${'a1'.repeat(32)}`;
const HASH_B = `0x${'b2'.repeat(32)}`;
const HASH_C = `0x${'c3'.repeat(32)}`;

// ---------------------------------------------------------------------------
// Fake fetch: one queue of scripted replies, consumed in order. GET requests
// carry no body, so a captured request is just its full URL and init.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

type Reply = (req: CapturedRequest) => Response | Promise<Response>;

interface FakeNet {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
}

function makeFetch(replies: Reply[]): FakeNet {
  const requests: CapturedRequest[] = [];
  let next = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req: CapturedRequest = { url: String(input), init };
    requests.push(req);
    const reply = replies[next++];
    if (!reply) {
      throw new Error(`test script has no reply left for request #${requests.length} (${req.url})`);
    }
    return reply(req);
  };
  return { fetchImpl, requests };
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

const okRows =
  (result: unknown[]): Reply =>
  () =>
    jsonResponse({ status: '1', message: 'OK', result });

const notOk =
  (message: string, result: unknown): Reply =>
  () =>
    jsonResponse({ status: '0', message, result });

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

const literal =
  (payload: unknown): Reply =>
  () =>
    jsonResponse(payload);

/** Never settles until the request is aborted, then rejects the way fetch does. */
const hangsUntilAborted: Reply = (req) =>
  new Promise<Response>((_resolve, reject) => {
    req.init?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Request shape: params, address lowercased, chainid/apikey opt-in.
// ---------------------------------------------------------------------------

describe('request shape', () => {
  it('builds a txlist request with the right params, no chainid/apikey when not configured', async () => {
    const net = makeFetch([okRows([])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    await indexer.listTransactions(ADDRESS);

    expect(net.requests).toHaveLength(1);
    const url = new URL(net.requests[0].url);
    expect(url.origin + url.pathname).toBe(BASE_URL);
    expect(url.searchParams.get('module')).toBe('account');
    expect(url.searchParams.get('action')).toBe('txlist');
    expect(url.searchParams.get('address')).toBe(ADDRESS_LOWER);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('offset')).toBe('100');
    expect(url.searchParams.get('sort')).toBe('desc');
    expect(url.searchParams.has('startblock')).toBe(false);
    expect(url.searchParams.has('chainid')).toBe(false);
    expect(url.searchParams.has('apikey')).toBe(false);
    expect(net.requests[0].init?.method).toBe('GET');
  });

  it('sends startblock, chainid, apikey and a custom page when configured', async () => {
    const net = makeFetch([okRows([])]);
    const indexer = createEtherscanIndexer({
      baseUrl: BASE_URL,
      chainId: 8453,
      apiKey: 'SEKRIT',
      pageSize: 25,
      fetchImpl: net.fetchImpl,
    });

    await indexer.listTransactions(ADDRESS, { sinceBlock: 123n, page: 3 });

    const url = new URL(net.requests[0].url);
    expect(url.searchParams.get('startblock')).toBe('123');
    expect(url.searchParams.get('chainid')).toBe('8453');
    expect(url.searchParams.get('apikey')).toBe('SEKRIT');
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('offset')).toBe('25');
  });

  it('clamps pageSize to the documented maximum of 1000', async () => {
    const net = makeFetch([okRows([])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, pageSize: 5000, fetchImpl: net.fetchImpl });

    await indexer.listTransactions(ADDRESS);

    expect(new URL(net.requests[0].url).searchParams.get('offset')).toBe('1000');
  });
});

// ---------------------------------------------------------------------------
// 2. txlist rows parse into IndexedTx.
// ---------------------------------------------------------------------------

describe('listTransactions row parsing', () => {
  it('parses two rows: bigint fields, ms timestamps, to:null for contract creation, isError from either field', async () => {
    const rowA = {
      // Mixed-case hex digits after the '0x' prefix (a real indexer can send
      // either case); the prefix itself is always lowercase '0x', same
      // convention as rpc.ts's QUANTITY_RE.
      hash: `0x${'A1'.repeat(32)}`,
      blockNumber: '49208124',
      timeStamp: '1725000000',
      from: ADDRESS, // already mixed-case, see the constant above
      to: OTHER_ADDRESS,
      value: '299547810951',
      gasUsed: '21000',
      gasPrice: '1000000000',
      isError: '1',
      input: '0x',
      contractAddress: '',
      confirmations: '1500',
    };
    const rowB = {
      hash: HASH_B,
      blockNumber: '49208130',
      timeStamp: '1725000060',
      from: ADDRESS,
      to: '', // contract creation
      value: '0',
      gasUsed: '500000',
      gasPrice: '2000000000',
      txreceipt_status: '0', // isError via the OTHER field, isError itself absent
      input: '0x6080604052',
      contractAddress: TOKEN_CONTRACT,
      confirmations: '1499',
    };
    const net = makeFetch([okRows([rowA, rowB])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const rows = await indexer.listTransactions(ADDRESS);

    expect(rows).toHaveLength(2);
    const [a, b]: IndexedTx[] = rows;

    expect(a.hash).toBe(HASH_A);
    expect(a.blockNumber).toBe(49208124n);
    expect(a.timestamp).toBe(1725000000000);
    expect(a.from).toBe(ADDRESS_LOWER);
    expect(a.to).toBe(OTHER_ADDRESS.toLowerCase());
    expect(a.value).toBe(299547810951n);
    expect(a.gasUsed).toBe(21000n);
    expect(a.gasPrice).toBe(1000000000n);
    expect(a.isError).toBe(true);
    expect(a.contractAddress).toBeNull();
    expect(a.confirmations).toBe(1500n);

    expect(b.to).toBeNull();
    expect(b.isError).toBe(true);
    expect(b.contractAddress).toBe(TOKEN_CONTRACT.toLowerCase());
  });

  it('defaults isError to false and input to 0x when both are absent', async () => {
    const row = {
      hash: HASH_A,
      blockNumber: '1',
      timeStamp: '1000',
      from: ADDRESS,
      to: OTHER_ADDRESS,
      value: '0',
      gasUsed: '21000',
      gasPrice: '1000000000',
      contractAddress: '',
      confirmations: '10',
      // no isError, no txreceipt_status, no input
    };
    const net = makeFetch([okRows([row])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const [tx] = await indexer.listTransactions(ADDRESS);

    expect(tx.isError).toBe(false);
    expect(tx.input).toBe('0x');
  });

  it('keeps l1Fee when the API reports it and omits it when absent (Blockscout on Base)', async () => {
    const withFee = {
      hash: HASH_A,
      blockNumber: '1',
      timeStamp: '1000',
      from: ADDRESS,
      to: OTHER_ADDRESS,
      value: '0',
      gasUsed: '21000',
      gasPrice: '1000000000',
      contractAddress: '',
      confirmations: '10',
      l1Fee: '42000',
    };
    const withoutFee = { ...withFee, hash: HASH_B, l1Fee: undefined };
    delete (withoutFee as Record<string, unknown>).l1Fee;

    const net = makeFetch([okRows([withFee, withoutFee])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const [a, b] = await indexer.listTransactions(ADDRESS);
    expect(a.l1Fee).toBe(42000n);
    expect(b.l1Fee).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. tokentx rows parse into IndexedTokenTransfer; contract filter.
// ---------------------------------------------------------------------------

describe('listTokenTransfers', () => {
  it('parses rows: contractAddress lowercase, tokenDecimal a number, value a bigint', async () => {
    const row = {
      hash: HASH_C,
      blockNumber: '49208124',
      timeStamp: '1725000000',
      from: ADDRESS,
      to: OTHER_ADDRESS,
      contractAddress: TOKEN_CONTRACT,
      value: '6494927775530',
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimal: '6',
      gasUsed: '65000',
      gasPrice: '1000000000',
      confirmations: '1500',
    };
    const net = makeFetch([okRows([row])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const [t]: IndexedTokenTransfer[] = await indexer.listTokenTransfers(ADDRESS);

    expect(t.contractAddress).toBe(TOKEN_CONTRACT.toLowerCase());
    expect(typeof t.tokenDecimal).toBe('number');
    expect(t.tokenDecimal).toBe(6);
    expect(t.value).toBe(6494927775530n);
    expect(t.tokenSymbol).toBe('USDC');
    expect(t.tokenName).toBe('USD Coin');
  });

  it('adds contractaddress to the request when a contract filter is given', async () => {
    const net = makeFetch([okRows([])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    await indexer.listTokenTransfers(ADDRESS, { contract: TOKEN_CONTRACT });

    const url = new URL(net.requests[0].url);
    expect(url.searchParams.get('action')).toBe('tokentx');
    expect(url.searchParams.get('contractaddress')).toBe(TOKEN_CONTRACT.toLowerCase());
  });

  it('omits contractaddress when no filter is given', async () => {
    const net = makeFetch([okRows([])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    await indexer.listTokenTransfers(ADDRESS);

    expect(new URL(net.requests[0].url).searchParams.has('contractaddress')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. "No transactions found" and empty result both mean [].
// ---------------------------------------------------------------------------

describe('empty history', () => {
  it('status 0, "No transactions found" => []', async () => {
    const net = makeFetch([notOk('No transactions found', [])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    await expect(indexer.listTransactions(ADDRESS)).resolves.toEqual([]);
  });

  it('status 1 with an empty result array => [] (Blockscout tolerance)', async () => {
    const net = makeFetch([okRows([])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    await expect(indexer.listTransactions(ADDRESS)).resolves.toEqual([]);
  });

  it('status 0 with an empty result array and an unfamiliar message => [] too', async () => {
    const net = makeFetch([notOk('OK', [])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    await expect(indexer.listTransactions(ADDRESS)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Rate limit vs refusal.
// ---------------------------------------------------------------------------

describe('rate limit and refusal', () => {
  it('a rate-limit result string => reason rate-limited', async () => {
    const net = makeFetch([notOk('NOTOK', 'Max rate limit reached')]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTransactions(ADDRESS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmIndexerError);
    expect((err as EvmIndexerError).reason).toBe('rate-limited');
    expect((err as EvmIndexerError).detail).toBe('Max rate limit reached');
  });

  it('a deprecated-endpoint / plan-restriction result string => reason refused, with detail', async () => {
    const net = makeFetch([
      notOk('NOTOK', 'Free API access is not supported for this chain, contact us for a business plan'),
    ]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTransactions(ADDRESS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmIndexerError);
    expect((err as EvmIndexerError).reason).toBe('refused');
    expect((err as EvmIndexerError).detail).toContain('Free API access is not supported');
  });

  it('clips a very long refusal string to 200 chars', async () => {
    const long = 'x'.repeat(500);
    const net = makeFetch([notOk('NOTOK', long)]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = (await indexer.listTransactions(ADDRESS).catch((e: unknown) => e)) as EvmIndexerError;

    expect(err.detail?.length).toBeLessThanOrEqual(200 + 20);
    expect(err.detail?.startsWith('x'.repeat(200))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Transport failures => unavailable; a non-array result => malformed.
// ---------------------------------------------------------------------------

describe('transport and shape failures', () => {
  it('HTTP 502 => unavailable', async () => {
    const net = makeFetch([httpStatus(502)]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTransactions(ADDRESS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmIndexerError);
    expect((err as EvmIndexerError).reason).toBe('unavailable');
    expect((err as Error).message).toContain('HTTP 502');
  });

  it('a thrown/rejected fetch => unavailable', async () => {
    const net = makeFetch([networkFails('ECONNRESET')]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTransactions(ADDRESS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmIndexerError);
    expect((err as EvmIndexerError).reason).toBe('unavailable');
  });

  it('a body that is not JSON => unavailable', async () => {
    const net = makeFetch([rawBody('<html>not json</html>')]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTransactions(ADDRESS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmIndexerError);
    expect((err as EvmIndexerError).reason).toBe('unavailable');
  });

  it('status 1 with a non-array result => malformed', async () => {
    const net = makeFetch([literal({ status: '1', message: 'OK', result: 'not an array' })]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTransactions(ADDRESS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmIndexerError);
    expect((err as EvmIndexerError).reason).toBe('malformed');
  });

  it('a response that is not a JSON object at all => malformed', async () => {
    const net = makeFetch([literal([1, 2, 3])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTransactions(ADDRESS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EvmIndexerError);
    expect((err as EvmIndexerError).reason).toBe('malformed');
  });
});

// ---------------------------------------------------------------------------
// 7. One bad row is skipped, the rest are kept.
// ---------------------------------------------------------------------------

describe('per-row tolerance', () => {
  it('skips a row whose value is not a decimal string, keeps the others', async () => {
    const good = (hash: string) => ({
      hash,
      blockNumber: '1',
      timeStamp: '1000',
      from: ADDRESS,
      to: OTHER_ADDRESS,
      value: '100',
      gasUsed: '21000',
      gasPrice: '1000000000',
      contractAddress: '',
      confirmations: '10',
    });
    const bad = { ...good(HASH_B), value: 'abc' };
    const net = makeFetch([okRows([good(HASH_A), bad, good(HASH_C)])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const rows = await indexer.listTransactions(ADDRESS);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.hash)).toEqual([HASH_A, HASH_C]);
  });

  it('skips a row whose value is the empty string too', async () => {
    const good = {
      hash: HASH_A,
      blockNumber: '1',
      timeStamp: '1000',
      from: ADDRESS,
      to: OTHER_ADDRESS,
      value: '',
      gasUsed: '21000',
      gasPrice: '1000000000',
      contractAddress: '',
      confirmations: '10',
    };
    const net = makeFetch([okRows([good])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    await expect(indexer.listTransactions(ADDRESS)).resolves.toEqual([]);
  });

  it('skips a tokentx row missing a required field (tokenDecimal), keeps a good one', async () => {
    const good = {
      hash: HASH_A,
      blockNumber: '1',
      timeStamp: '1000',
      from: ADDRESS,
      to: OTHER_ADDRESS,
      contractAddress: TOKEN_CONTRACT,
      value: '100',
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimal: '6',
      gasUsed: '21000',
      gasPrice: '1000000000',
      confirmations: '10',
    };
    const bad = { ...good, hash: HASH_B, tokenDecimal: undefined };
    delete (bad as Record<string, unknown>).tokenDecimal;

    const net = makeFetch([okRows([good, bad])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const rows = await indexer.listTokenTransfers(ADDRESS);
    expect(rows.map((r) => r.hash)).toEqual([HASH_A]);
  });
});

// ---------------------------------------------------------------------------
// 8. Invalid address throws a plain Error before any fetch.
// ---------------------------------------------------------------------------

describe('address validation', () => {
  it('rejects a malformed address before touching the network', async () => {
    const net = makeFetch([]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTransactions('not-an-address').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EvmIndexerError);
    expect(net.requests).toHaveLength(0);
  });

  it('rejects a too-short address too, and for listTokenTransfers', async () => {
    const net = makeFetch([]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTokenTransfers('0x1234').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EvmIndexerError);
    expect(net.requests).toHaveLength(0);
  });

  it('rejects an invalid contract filter before touching the network', async () => {
    const net = makeFetch([]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = await indexer.listTokenTransfers(ADDRESS, { contract: 'nope' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EvmIndexerError);
    expect(net.requests).toHaveLength(0);
  });

  it('accepts any letter case and sends the address lowercased', async () => {
    const net = makeFetch([okRows([])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    await indexer.listTransactions(ADDRESS.toUpperCase().replace('0X', '0x'));

    expect(new URL(net.requests[0].url).searchParams.get('address')).toBe(ADDRESS_LOWER);
  });
});

// ---------------------------------------------------------------------------
// 9. Timeout aborts the request and reports unavailable.
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('aborts via the signal after timeoutMs and reports unavailable', async () => {
    vi.useFakeTimers();
    const net = makeFetch([hangsUntilAborted]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, timeoutMs: 5_000, fetchImpl: net.fetchImpl });

    const pending = indexer.listTransactions(ADDRESS);
    const settled = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_001);
    const err = await settled;

    expect(err).toBeInstanceOf(EvmIndexerError);
    expect((err as EvmIndexerError).reason).toBe('unavailable');
    expect((err as Error).message).toContain('timeout after 5000ms');
    expect(net.requests[0].init?.signal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. apikey never appears in any thrown message.
// ---------------------------------------------------------------------------

describe('apikey never leaks', () => {
  const SECRET = 'VERY-SECRET-API-KEY-42';

  async function collectMessages(reply: Reply): Promise<string> {
    const net = makeFetch([reply]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, apiKey: SECRET, fetchImpl: net.fetchImpl });
    const err = await indexer.listTransactions(ADDRESS).catch((e: unknown) => e);
    const asError = err as EvmIndexerError;
    return JSON.stringify({ message: asError.message, detail: asError.detail, name: asError.name });
  }

  it('is absent from an HTTP-failure message', async () => {
    expect(await collectMessages(httpStatus(502))).not.toContain(SECRET);
  });

  it('is absent from a network-failure message', async () => {
    // The mocked failure text itself never contains SECRET: the only way it
    // could appear in the thrown message is if the client embedded the
    // request URL (which carries apikey=...), which is exactly what this
    // guards against.
    expect(await collectMessages(networkFails('connection reset'))).not.toContain(SECRET);
  });

  it('is absent from a malformed-body message', async () => {
    expect(await collectMessages(rawBody('not json'))).not.toContain(SECRET);
  });

  it('is absent from a refused-response message and detail', async () => {
    expect(await collectMessages(notOk('NOTOK', 'Invalid API key supplied'))).not.toContain(SECRET);
  });

  it('is absent from a rate-limited message and detail', async () => {
    expect(await collectMessages(notOk('NOTOK', 'Max rate limit reached'))).not.toContain(SECRET);
  });

  it('is absent from a malformed-shape message', async () => {
    expect(await collectMessages(literal({ status: '1', message: 'OK', result: 'nope' }))).not.toContain(SECRET);
  });

  it('is absent from a timeout message', async () => {
    vi.useFakeTimers();
    const net = makeFetch([hangsUntilAborted]);
    const indexer = createEtherscanIndexer({
      baseUrl: BASE_URL,
      apiKey: SECRET,
      timeoutMs: 1_000,
      fetchImpl: net.fetchImpl,
    });
    const pending = indexer.listTransactions(ADDRESS).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_001);
    const err = (await pending) as EvmIndexerError;
    expect(err.message).not.toContain(SECRET);
    expect(err.detail ?? '').not.toContain(SECRET);
  });

  it('is absent from the invalid-address message even when configured', async () => {
    const net = makeFetch([]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, apiKey: SECRET, fetchImpl: net.fetchImpl });
    const err = (await indexer.listTransactions('bad-address').catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// listOlder: walking BACK through the API's own page parameter.
//
// The newest read is page 1, so the first older page is page 2, and the two
// lists page independently (an address can have 400 native transactions and
// 30 token transfers). Both facts are what the cursor carries.
// ---------------------------------------------------------------------------

describe('listOlder (Etherscan-shaped paging)', () => {
  const txRow = (n: number) => ({
    hash: `0x${n.toString(16).padStart(2, '0').repeat(32)}`,
    blockNumber: String(1_000_000 - n),
    timeStamp: String(1_725_000_000 - n),
    from: ADDRESS,
    to: OTHER_ADDRESS,
    value: '1',
    gasUsed: '21000',
    gasPrice: '1000000000',
    isError: '0',
    input: '0x',
    contractAddress: '',
    confirmations: '10',
  });
  const tokenRow = (n: number) => ({
    hash: `0x${((n + 128) % 256).toString(16).padStart(2, '0').repeat(32)}`,
    blockNumber: String(1_000_000 - n),
    timeStamp: String(1_725_000_000 - n),
    from: OTHER_ADDRESS,
    to: ADDRESS,
    contractAddress: TOKEN_CONTRACT,
    value: '5',
    tokenSymbol: 'USDC',
    tokenName: 'USD Coin',
    tokenDecimal: '6',
    gasUsed: '50000',
    gasPrice: '1000000000',
    confirmations: '10',
  });
  const full = (make: (n: number) => unknown, count = 100) => Array.from({ length: count }, (_, i) => make(i + 1));

  it('asks for PAGE 2 of both lists with no startblock, and hands back a cursor for page 3', async () => {
    const net = makeFetch([okRows(full(txRow)), okRows(full(tokenRow))]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const page = await indexer.listOlder!(ADDRESS);

    expect(net.requests).toHaveLength(2);
    for (const req of net.requests) {
      const url = new URL(req.url);
      expect(url.searchParams.get('page')).toBe('2');
      expect(url.searchParams.get('sort')).toBe('desc');
      expect(url.searchParams.get('offset')).toBe('100');
      // A window, not a watermark: `startblock` is what the INCREMENTAL read
      // uses, and it would pin this query to the newest blocks.
      expect(url.searchParams.has('startblock')).toBe(false);
    }
    expect(net.requests.map((r) => new URL(r.url).searchParams.get('action'))).toEqual(['txlist', 'tokentx']);
    expect(page.txs).toHaveLength(100);
    expect(page.tokenTransfers).toHaveLength(100);
    expect(JSON.parse(page.cursor!)).toEqual({ tx: 3, token: 3 });
  });

  it('stops asking for a list that answered with a SHORT page, and keeps asking for the other', async () => {
    // txlist is exhausted (30 rows), tokentx is not (a full 100).
    const net = makeFetch([okRows(full(txRow, 30)), okRows(full(tokenRow))]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const first = await indexer.listOlder!(ADDRESS);
    expect(JSON.parse(first.cursor!)).toEqual({ tx: null, token: 3 });

    // The next call must not spend a request on the finished list.
    const net2 = makeFetch([okRows(full(tokenRow, 4))]);
    const indexer2 = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net2.fetchImpl });
    const second = await indexer2.listOlder!(ADDRESS, { cursor: first.cursor! });
    expect(net2.requests).toHaveLength(1);
    expect(new URL(net2.requests[0].url).searchParams.get('action')).toBe('tokentx');
    expect(new URL(net2.requests[0].url).searchParams.get('page')).toBe('3');
    expect(second.txs).toEqual([]);
    expect(second.tokenTransfers).toHaveLength(4);
    // Both lists finished: no cursor at all, which is what lets the UI say
    // "that is the whole history" instead of offering an empty page.
    expect(second.cursor).toBe(null);
  });

  it('an empty page from both lists ends the walk', async () => {
    const net = makeFetch([notOk('No transactions found', []), notOk('No token transfers found', [])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const page = await indexer.listOlder!(ADDRESS, { cursor: JSON.stringify({ tx: 7, token: 7 }) });

    expect(page.txs).toEqual([]);
    expect(page.tokenTransfers).toEqual([]);
    expect(page.cursor).toBe(null);
  });

  it('an unreadable cursor restarts at the first older page rather than asking for a wrong one', async () => {
    const net = makeFetch([okRows([]), okRows([])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    await indexer.listOlder!(ADDRESS, { cursor: 'not json at all' });

    expect(net.requests.map((r) => new URL(r.url).searchParams.get('page'))).toEqual(['2', '2']);
  });

  it('a refusal propagates as an EvmIndexerError, so the caller can say the page failed', async () => {
    const net = makeFetch([httpStatus(429), okRows([])]);
    const indexer = createEtherscanIndexer({ baseUrl: BASE_URL, fetchImpl: net.fetchImpl });

    const err = (await indexer.listOlder!(ADDRESS).catch((e: unknown) => e)) as EvmIndexerError;
    expect(err).toBeInstanceOf(EvmIndexerError);
  });
});
