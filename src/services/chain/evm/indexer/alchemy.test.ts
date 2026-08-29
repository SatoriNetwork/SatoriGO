// Tests for the Alchemy Transfers API indexer.
//
// NO NETWORK IS TOUCHED HERE, ever: `EvmRpcClient` is a hand-written fake
// (FakeRpc below) whose `batch` consumes a scripted queue and records every
// call it received. There is no real fetch anywhere in this file.

import { describe, it, expect } from 'vitest';
import { createAlchemyIndexer } from './alchemy';
import { EvmIndexerError } from './etherscan';
import {
  EvmRpcError,
  EvmRpcUnavailableError,
  type EvmRpcBatchResult,
  type EvmRpcCall,
  type EvmRpcClient,
} from '../rpc';
import type { EvmChain } from '../chains';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const ADDRESS_MIXED = '0x1234567890AbcdEF1234567890aBcdef12345678';
const OTHER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HASH_A = `0x${'a1'.repeat(32)}`;
const HASH_B = `0x${'b2'.repeat(32)}`;
const HASH_C = `0x${'c3'.repeat(32)}`;
const HASH_D = `0x${'d4'.repeat(32)}`;

const CHAIN: EvmChain = Object.freeze({
  key: 'base',
  chainId: 8453,
  displayName: 'Base',
  nativeTicker: 'ETH',
  nativeDecimals: 18,
  rpc: ['https://example.invalid/alchemy/secret-key'],
  explorerTxUrl: 'https://basescan.org/tx/{txid}',
  homepage: 'https://example.test',
  young: false,
  recentlyAdded: false,
  feeModel: 'eip1559',
});

// ---------------------------------------------------------------------------
// Fake EvmRpcClient: batch() replies from a scripted queue, one script entry
// per rpc.batch() CALL (not per JSON-RPC item inside it). call() is unused by
// this indexer and throws if it is ever invoked, so a stray use is caught.
// ---------------------------------------------------------------------------

type BatchReply = EvmRpcBatchResult[] | Error;

interface FakeRpc {
  client: EvmRpcClient;
  batchCalls: EvmRpcCall[][];
}

function ok(result: unknown): EvmRpcBatchResult {
  return { ok: true, result };
}

function errItem(err: EvmRpcError): EvmRpcBatchResult {
  return { ok: false, error: err };
}

function makeFakeRpc(replies: BatchReply[]): FakeRpc {
  const batchCalls: EvmRpcCall[][] = [];
  let next = 0;
  const client: EvmRpcClient = {
    chain: CHAIN,
    async call<T = unknown>(): Promise<T> {
      throw new Error('unexpected call() on FakeRpc: alchemy.ts should only use batch()');
    },
    async batch(calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> {
      batchCalls.push(calls);
      const reply = replies[next++];
      if (!reply) {
        throw new Error(`test script has no batch reply left for call #${batchCalls.length}`);
      }
      if (reply instanceof Error) throw reply;
      return reply;
    },
    activeEndpoint(): string | null {
      return CHAIN.rpc[0];
    },
    lastLatencyMs(): number | null {
      return null;
    },
  };
  return { client, batchCalls };
}

function transfersResult(transfers: unknown[], pageKey?: string): EvmRpcBatchResult {
  return ok(pageKey !== undefined ? { transfers, pageKey } : { transfers });
}

/** A minimal, valid external transfer row, overridable per test. */
function extTransfer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    blockNum: '0x2fc1623',
    uniqueId: `${HASH_A}:external`,
    hash: HASH_A,
    from: ADDRESS,
    to: OTHER,
    value: 0.001,
    asset: 'ETH',
    category: 'external',
    rawContract: { value: '0x38d7ea4c68000', address: null, decimal: null },
    metadata: { blockTimestamp: '2025-08-19T10:00:00.000Z' },
    ...overrides,
  };
}

/** A minimal, valid erc20 transfer row, overridable per test. */
function tokenTransfer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    blockNum: '0x2fc1623',
    uniqueId: `${HASH_A}:log:0`,
    hash: HASH_A,
    from: ADDRESS,
    to: OTHER,
    value: 1.5,
    asset: 'USDC',
    category: 'erc20',
    rawContract: { value: '0x16e360', address: TOKEN_CONTRACT, decimal: '0x6' },
    metadata: { blockTimestamp: '2025-08-19T10:00:00.000Z' },
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gasUsed: '0x5208',
    effectiveGasPrice: '0x3b9aca00',
    status: '0x1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. baseUrl: a stable label, never the URL/key.
// ---------------------------------------------------------------------------

describe('baseUrl', () => {
  it('is alchemy://<chain.key>, not the RPC endpoint', () => {
    const { client } = makeFakeRpc([]);
    const indexer = createAlchemyIndexer(client);
    expect(indexer.baseUrl).toBe('alchemy://base');
    expect(indexer.baseUrl).not.toContain('example.invalid');
    expect(indexer.baseUrl).not.toContain('secret-key');
  });
});

// ---------------------------------------------------------------------------
// 2. listTransactions: request shape, merge, mapping, sort.
// ---------------------------------------------------------------------------

describe('listTransactions request shape', () => {
  it('sends one rpc.batch with two alchemy_getAssetTransfers calls (fromAddress, toAddress)', async () => {
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    await indexer.listTransactions(ADDRESS);

    expect(batchCalls).toHaveLength(1); // one rpc.batch call
    const [fromCall, toCall] = batchCalls[0];
    expect(fromCall.method).toBe('alchemy_getAssetTransfers');
    expect(toCall.method).toBe('alchemy_getAssetTransfers');

    const fromParams = (fromCall.params as unknown[])[0] as Record<string, unknown>;
    const toParams = (toCall.params as unknown[])[0] as Record<string, unknown>;

    expect(fromParams).toMatchObject({
      fromBlock: '0x0',
      toBlock: 'latest',
      category: ['external'],
      withMetadata: true,
      excludeZeroValue: false,
      order: 'desc',
      maxCount: '0x64',
      fromAddress: ADDRESS,
    });
    expect(fromParams.toAddress).toBeUndefined();

    expect(toParams).toMatchObject({
      fromBlock: '0x0',
      toBlock: 'latest',
      category: ['external'],
      withMetadata: true,
      excludeZeroValue: false,
      order: 'desc',
      maxCount: '0x64',
      toAddress: ADDRESS,
    });
    expect(toParams.fromAddress).toBeUndefined();
  });

  it('turns opts.sinceBlock into a fromBlock quantity', async () => {
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    await indexer.listTransactions(ADDRESS, { sinceBlock: 1000n });

    const params = (batchCalls[0][0].params as unknown[])[0] as Record<string, unknown>;
    expect(params.fromBlock).toBe('0x3e8');
  });

  it('lowercases a mixed-case input address in the request and in the rows', async () => {
    // extTransfer()'s `from` is ADDRESS (lowercase), so the address IS a
    // sender once normalized: script a receipts batch reply too.
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([extTransfer()]), transfersResult([])],
      [ok(receipt())],
    ]);
    const indexer = createAlchemyIndexer(client);

    const txs = await indexer.listTransactions(ADDRESS_MIXED);

    const params = (batchCalls[0][0].params as unknown[])[0] as Record<string, unknown>;
    expect(params.fromAddress).toBe(ADDRESS);
    expect(txs[0].from).toBe(ADDRESS);
  });

  it('ignores opts.page (page 1 only, no pageKey follow-up)', async () => {
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([], 'next-page-key'), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    await indexer.listTransactions(ADDRESS, { page: 5 });

    expect(batchCalls).toHaveLength(1); // still exactly one batch, no follow-up call
  });

  it('throws a plain Error for an invalid address before any call', async () => {
    const { client, batchCalls } = makeFakeRpc([]);
    const indexer = createAlchemyIndexer(client);

    await expect(indexer.listTransactions('not-an-address')).rejects.toThrow(/valid EVM address/);
    expect(batchCalls).toHaveLength(0);
  });
});

describe('listTransactions mapping', () => {
  it('maps a transfer row to IndexedTx with wei read from rawContract.value, not the decimal value field', async () => {
    const { client } = makeFakeRpc([
      [
        transfersResult([
          extTransfer({ from: OTHER, to: ADDRESS, value: 0.999999, rawContract: { value: '0x38d7ea4c68000', address: null, decimal: null } }),
        ]),
        transfersResult([]),
      ],
    ]);
    const indexer = createAlchemyIndexer(client);

    const [tx] = await indexer.listTransactions(ADDRESS);

    expect(tx.hash).toBe(HASH_A);
    expect(tx.blockNumber).toBe(0x2fc1623n);
    expect(tx.timestamp).toBe(Date.parse('2025-08-19T10:00:00.000Z'));
    expect(tx.from).toBe(OTHER);
    expect(tx.to).toBe(ADDRESS);
    expect(tx.value).toBe(0x38d7ea4c68000n); // NOT derived from 0.999999
    expect(tx.gasUsed).toBe(0n);
    expect(tx.gasPrice).toBe(0n);
    expect(tx.isError).toBe(false);
    expect(tx.input).toBe('0x');
    expect(tx.contractAddress).toBeNull();
    expect(tx.confirmations).toBe(0n);
  });

  it('maps rawContract.value absent (or null) to value 0n, never throwing', async () => {
    const { client } = makeFakeRpc([
      [
        transfersResult([extTransfer({ rawContract: { value: null, address: null, decimal: null } })]),
        transfersResult([]),
      ],
    ]);
    const indexer = createAlchemyIndexer(client);

    const [tx] = await indexer.listTransactions(ADDRESS);
    expect(tx.value).toBe(0n);
  });

  it('maps to: null when the row\'s to is null or empty', async () => {
    const { client } = makeFakeRpc([
      [transfersResult([extTransfer({ to: null })]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const [tx] = await indexer.listTransactions(ADDRESS);
    expect(tx.to).toBeNull();
  });

  it('merges both directions and dedupes by hash: a self-transfer appears once', async () => {
    const self = extTransfer({ from: ADDRESS, to: ADDRESS });
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([self]), transfersResult([self])],
      [ok(receipt())], // one send: ADDRESS -> ADDRESS
    ]);
    const indexer = createAlchemyIndexer(client);

    const txs = await indexer.listTransactions(ADDRESS);

    expect(txs).toHaveLength(1);
    expect(txs[0].hash).toBe(HASH_A);
    void batchCalls;
  });

  it('sorts newest first by timestamp, then by blockNumber', async () => {
    const older = extTransfer({
      hash: HASH_A,
      uniqueId: `${HASH_A}:external`,
      blockNum: '0x1',
      metadata: { blockTimestamp: '2025-08-19T09:00:00.000Z' },
    });
    const newer = extTransfer({
      hash: HASH_B,
      uniqueId: `${HASH_B}:external`,
      blockNum: '0x2',
      metadata: { blockTimestamp: '2025-08-19T11:00:00.000Z' },
    });
    const sameTimeLowerBlock = extTransfer({
      hash: HASH_C,
      uniqueId: `${HASH_C}:external`,
      blockNum: '0x2',
      metadata: { blockTimestamp: '2025-08-19T11:00:00.000Z' },
    });
    const { client } = makeFakeRpc([
      [transfersResult([older, newer, sameTimeLowerBlock]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const txs = await indexer.listTransactions(ADDRESS);

    expect(txs.map((t) => t.hash)).toEqual([HASH_B, HASH_C, HASH_A]);
  });

  it('skips a row whose hash is not 0x+64hex, without failing the rest of the page', async () => {
    const bad = extTransfer({ hash: '0xdeadbeef', uniqueId: 'bad:external' });
    const good = extTransfer({ hash: HASH_B, uniqueId: `${HASH_B}:external` });
    const { client } = makeFakeRpc([
      [transfersResult([bad, good]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const txs = await indexer.listTransactions(ADDRESS);
    expect(txs.map((t) => t.hash)).toEqual([HASH_B]);
  });

  it('skips a row whose blockNum is not a JSON-RPC quantity, without failing the rest of the page', async () => {
    const bad = extTransfer({ blockNum: '49208124', uniqueId: 'bad2:external' });
    const good = extTransfer({ hash: HASH_B, uniqueId: `${HASH_B}:external` });
    const { client } = makeFakeRpc([
      [transfersResult([bad, good]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const txs = await indexer.listTransactions(ADDRESS);
    expect(txs.map((t) => t.hash)).toEqual([HASH_B]);
  });

  it('skips a row whose metadata.blockTimestamp does not parse', async () => {
    const bad = extTransfer({ metadata: { blockTimestamp: 'not-a-date' } });
    const { client } = makeFakeRpc([
      [transfersResult([bad]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const txs = await indexer.listTransactions(ADDRESS);
    expect(txs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Fee fill via eth_getTransactionReceipt.
// ---------------------------------------------------------------------------

describe('fee fill', () => {
  it('requests receipts only for rows the address SENT, not received', async () => {
    const sent = extTransfer({ from: ADDRESS, to: OTHER, hash: HASH_A, uniqueId: `${HASH_A}:external` });
    const received = extTransfer({ from: OTHER, to: ADDRESS, hash: HASH_B, uniqueId: `${HASH_B}:external` });
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([sent]), transfersResult([received])],
      [ok(receipt())],
    ]);
    const indexer = createAlchemyIndexer(client);

    await indexer.listTransactions(ADDRESS);

    expect(batchCalls).toHaveLength(2);
    const receiptCalls = batchCalls[1];
    expect(receiptCalls).toHaveLength(1);
    expect(receiptCalls[0]).toEqual({ method: 'eth_getTransactionReceipt', params: [HASH_A] });
  });

  it('applies gasUsed, effectiveGasPrice as gasPrice, and isError from status', async () => {
    const sent = extTransfer({ from: ADDRESS, to: OTHER });
    const { client } = makeFakeRpc([
      [transfersResult([sent]), transfersResult([])],
      [ok(receipt({ gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', status: '0x1' }))],
    ]);
    const indexer = createAlchemyIndexer(client);

    const [tx] = await indexer.listTransactions(ADDRESS);
    expect(tx.gasUsed).toBe(0x5208n);
    expect(tx.gasPrice).toBe(0x3b9aca00n);
    expect(tx.isError).toBe(false);
  });

  it('marks isError true on a failed receipt (status 0x0)', async () => {
    const sent = extTransfer({ from: ADDRESS, to: OTHER });
    const { client } = makeFakeRpc([
      [transfersResult([sent]), transfersResult([])],
      [ok(receipt({ status: '0x0' }))],
    ]);
    const indexer = createAlchemyIndexer(client);

    const [tx] = await indexer.listTransactions(ADDRESS);
    expect(tx.isError).toBe(true);
  });

  it('reads l1Fee from an OP-stack receipt', async () => {
    const sent = extTransfer({ from: ADDRESS, to: OTHER });
    const { client } = makeFakeRpc([
      [transfersResult([sent]), transfersResult([])],
      [ok(receipt({ l1Fee: '0x2710' }))],
    ]);
    const indexer = createAlchemyIndexer(client);

    const [tx] = await indexer.listTransactions(ADDRESS);
    expect(tx.l1Fee).toBe(0x2710n);
  });

  it('leaves gasUsed/gasPrice/isError at zero defaults on a missing (ok:false) receipt', async () => {
    const sent = extTransfer({ from: ADDRESS, to: OTHER });
    const { client } = makeFakeRpc([
      [transfersResult([sent]), transfersResult([])],
      [errItem(new EvmRpcError('eth_getTransactionReceipt', -32000, 'not found'))],
    ]);
    const indexer = createAlchemyIndexer(client);

    const [tx] = await indexer.listTransactions(ADDRESS);
    expect(tx.gasUsed).toBe(0n);
    expect(tx.gasPrice).toBe(0n);
    expect(tx.isError).toBe(false);
  });

  it('leaves every row at zero defaults when the receipts batch itself fails (best-effort)', async () => {
    const sent = extTransfer({ from: ADDRESS, to: OTHER });
    const { client } = makeFakeRpc([
      [transfersResult([sent]), transfersResult([])],
      new EvmRpcUnavailableError('for batch [eth_getTransactionReceipt]', [
        { url: 'https://example.invalid', reason: 'network error' },
      ]),
    ]);
    const indexer = createAlchemyIndexer(client);

    const txs = await indexer.listTransactions(ADDRESS);
    expect(txs).toHaveLength(1);
    expect(txs[0].gasUsed).toBe(0n);
    expect(txs[0].gasPrice).toBe(0n);
  });

  it('caps receipts requested at receiptLimit, newest sends first', async () => {
    const sends = [HASH_A, HASH_B, HASH_C, HASH_D].map((hash, i) =>
      extTransfer({
        hash,
        uniqueId: `${hash}:external`,
        from: ADDRESS,
        to: OTHER,
        blockNum: `0x${(10 - i).toString(16)}`,
        metadata: { blockTimestamp: `2025-08-19T1${i}:00:00.000Z` },
      }),
    );
    // sends[] is oldest-to-newest in construction order (i=0..3), timestamps
    // increase with i, so newest is HASH_D (i=3), then HASH_C, HASH_B, HASH_A.
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult(sends), transfersResult([])],
      [ok(receipt()), ok(receipt())],
    ]);
    const indexer = createAlchemyIndexer(client, { receiptLimit: 2 });

    await indexer.listTransactions(ADDRESS);

    const receiptCalls = batchCalls[1];
    expect(receiptCalls).toHaveLength(2);
    expect(receiptCalls.map((c) => c.params?.[0])).toEqual([HASH_D, HASH_C]);
  });

  it('defaults receiptLimit to 10 when not given (throughput: receipts land in the same second as the transfers batch)', async () => {
    const sends = Array.from({ length: 30 }, (_, i) => {
      const hash = `0x${i.toString(16).padStart(2, '0')}${'e'.repeat(62)}`;
      return extTransfer({
        hash,
        uniqueId: `${hash}:external`,
        from: ADDRESS,
        to: OTHER,
        blockNum: `0x${(1000 - i).toString(16)}`,
        metadata: { blockTimestamp: new Date(2025, 7, 19, 0, i).toISOString() },
      });
    });
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult(sends), transfersResult([])],
      [...Array(10)].map(() => ok(receipt())),
    ]);
    const indexer = createAlchemyIndexer(client);

    await indexer.listTransactions(ADDRESS);

    expect(batchCalls[1]).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// 4. listTokenTransfers.
// ---------------------------------------------------------------------------

describe('listTokenTransfers', () => {
  it('sends category erc20, and contractAddresses when opts.contract is given', async () => {
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    await indexer.listTokenTransfers(ADDRESS, { contract: TOKEN_CONTRACT });

    const params = (batchCalls[0][0].params as unknown[])[0] as Record<string, unknown>;
    expect(params.category).toEqual(['erc20']);
    expect(params.contractAddresses).toEqual([TOKEN_CONTRACT]);
  });

  it('omits contractAddresses when opts.contract is not given', async () => {
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    await indexer.listTokenTransfers(ADDRESS);

    const params = (batchCalls[0][0].params as unknown[])[0] as Record<string, unknown>;
    expect(params.contractAddresses).toBeUndefined();
  });

  it('maps a transfer row to IndexedTokenTransfer', async () => {
    const { client } = makeFakeRpc([
      [transfersResult([tokenTransfer({ from: OTHER, to: ADDRESS })]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const [t] = await indexer.listTokenTransfers(ADDRESS);

    expect(t.hash).toBe(HASH_A);
    expect(t.contractAddress).toBe(TOKEN_CONTRACT);
    expect(t.value).toBe(0x16e360n);
    expect(t.tokenDecimal).toBe(6);
    expect(t.tokenSymbol).toBe('USDC');
    expect(t.tokenName).toBe('USDC');
    expect(t.from).toBe(OTHER);
    expect(t.to).toBe(ADDRESS);
    expect(t.gasUsed).toBe(0n);
    expect(t.gasPrice).toBe(0n);
    expect(t.confirmations).toBe(0n);
  });

  it('skips a row whose rawContract.address is null', async () => {
    const bad = tokenTransfer({ rawContract: { value: '0x1', address: null, decimal: '0x6' } });
    const { client } = makeFakeRpc([
      [transfersResult([bad]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const list = await indexer.listTokenTransfers(ADDRESS);
    expect(list).toHaveLength(0);
  });

  it('skips a row whose rawContract.value is missing', async () => {
    const bad = tokenTransfer({ rawContract: { value: null, address: TOKEN_CONTRACT, decimal: '0x6' } });
    const { client } = makeFakeRpc([
      [transfersResult([bad]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const list = await indexer.listTokenTransfers(ADDRESS);
    expect(list).toHaveLength(0);
  });

  it('skips a row whose rawContract.decimal is missing', async () => {
    const bad = tokenTransfer({ rawContract: { value: '0x1', address: TOKEN_CONTRACT, decimal: null } });
    const { client } = makeFakeRpc([
      [transfersResult([bad]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const list = await indexer.listTokenTransfers(ADDRESS);
    expect(list).toHaveLength(0);
  });

  it('merges both directions and dedupes by uniqueId (distinct from a hash-only dedupe)', async () => {
    const log0 = tokenTransfer({ uniqueId: `${HASH_A}:log:0`, from: ADDRESS, to: OTHER });
    const log1 = tokenTransfer({ uniqueId: `${HASH_A}:log:1`, from: ADDRESS, to: OTHER, rawContract: { value: '0x1', address: TOKEN_CONTRACT, decimal: '0x6' } });
    const { client } = makeFakeRpc([
      [transfersResult([log0, log1]), transfersResult([log0])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const list = await indexer.listTokenTransfers(ADDRESS);
    // Two distinct log rows for the same tx hash both survive; log0 is not
    // doubled just because it appeared in both directions' pages.
    expect(list).toHaveLength(2);
  });

  it('sorts newest first', async () => {
    const older = tokenTransfer({
      hash: HASH_A,
      uniqueId: `${HASH_A}:log:0`,
      metadata: { blockTimestamp: '2025-08-19T09:00:00.000Z' },
    });
    const newer = tokenTransfer({
      hash: HASH_B,
      uniqueId: `${HASH_B}:log:0`,
      metadata: { blockTimestamp: '2025-08-19T11:00:00.000Z' },
    });
    const { client } = makeFakeRpc([
      [transfersResult([older, newer]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const list = await indexer.listTokenTransfers(ADDRESS);
    expect(list.map((t) => t.hash)).toEqual([HASH_B, HASH_A]);
  });

  it('does not fetch receipts (gasUsed/gasPrice always 0n)', async () => {
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([tokenTransfer({ from: ADDRESS, to: OTHER })]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    await indexer.listTokenTransfers(ADDRESS);
    expect(batchCalls).toHaveLength(1); // no second (receipts) batch
  });
});

// ---------------------------------------------------------------------------
// 5. Errors.
// ---------------------------------------------------------------------------

describe('errors', () => {
  it('EvmRpcUnavailableError from rpc.batch becomes EvmIndexerError(unavailable)', async () => {
    const { client } = makeFakeRpc([
      new EvmRpcUnavailableError('for batch [alchemy_getAssetTransfers]', [
        { url: 'https://example.invalid', reason: 'timeout after 10000ms' },
      ]),
    ]);
    const indexer = createAlchemyIndexer(client);

    await expect(indexer.listTransactions(ADDRESS)).rejects.toMatchObject({
      name: 'EvmIndexerError',
      reason: 'unavailable',
    });
  });

  it('an EvmRpcError matching rate-limit text becomes EvmIndexerError(rate-limited)', async () => {
    const { client } = makeFakeRpc([
      [
        errItem(new EvmRpcError('alchemy_getAssetTransfers', -32005, 'Too many requests, please slow down')),
        transfersResult([]),
      ],
    ]);
    const indexer = createAlchemyIndexer(client);

    let caught: unknown;
    try {
      await indexer.listTransactions(ADDRESS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EvmIndexerError);
    expect((caught as EvmIndexerError).reason).toBe('rate-limited');
  });

  it('an EvmRpcError matching 429 text becomes EvmIndexerError(rate-limited)', async () => {
    const { client } = makeFakeRpc([
      [errItem(new EvmRpcError('alchemy_getAssetTransfers', -32000, 'HTTP 429')), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);

    let caught: unknown;
    try {
      await indexer.listTransactions(ADDRESS);
    } catch (err) {
      caught = err;
    }
    expect((caught as EvmIndexerError).reason).toBe('rate-limited');
  });

  it('a "method not found" EvmRpcError (a node without the Transfers API) becomes EvmIndexerError(unavailable) carrying the node text', async () => {
    const { client } = makeFakeRpc([
      [
        errItem(
          new EvmRpcError(
            'alchemy_getAssetTransfers',
            -32601,
            'the method alchemy_getAssetTransfers does not exist',
          ),
        ),
        transfersResult([]),
      ],
    ]);
    const indexer = createAlchemyIndexer(client);

    let caught: unknown;
    try {
      await indexer.listTransactions(ADDRESS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EvmIndexerError);
    const indexerErr = caught as EvmIndexerError;
    expect(indexerErr.reason).toBe('unavailable');
    expect(indexerErr.detail).toContain('does not exist');
  });

  it('Alchemy\'s "exceeded its compute units per second capacity" (a per-item error OR every endpoint failing after the rpc retries) is rate-limited, never refused', async () => {
    const cu = 'Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message.';
    const { client } = makeFakeRpc([[errItem(new EvmRpcError('alchemy_getAssetTransfers', 429, cu)), transfersResult([])]]);
    let caught: unknown;
    try {
      await createAlchemyIndexer(client).listTransactions(ADDRESS);
    } catch (err) {
      caught = err;
    }
    expect((caught as EvmIndexerError).reason).toBe('rate-limited');

    const { client: failing } = makeFakeRpc([
      new EvmRpcUnavailableError('for batch [alchemy_getAssetTransfers]', [
        { url: 'https://bnb-mainnet.g.alchemy.com/v2/k', reason: 'rate limited: HTTP 429' },
      ]),
    ]);
    await expect(createAlchemyIndexer(failing).listTransactions(ADDRESS)).rejects.toMatchObject({
      name: 'EvmIndexerError',
      reason: 'rate-limited',
    });
  });

  it('a result with no transfers array becomes EvmIndexerError(malformed)', async () => {
    const { client } = makeFakeRpc([[ok({ notTransfers: [] }), transfersResult([])]]);
    const indexer = createAlchemyIndexer(client);

    let caught: unknown;
    try {
      await indexer.listTransactions(ADDRESS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EvmIndexerError);
    expect((caught as EvmIndexerError).reason).toBe('malformed');
  });
});

describe('receipt cache (metered-provider economy)', () => {
  it('re-reads receipts only for sends it has not seen: the second listTransactions asks for none', async () => {
    const send = extTransfer({
      hash: `0x${'ab'.repeat(32)}`,
      uniqueId: `0x${'ab'.repeat(32)}:external`,
      from: ADDRESS,
      to: OTHER,
      blockNum: '0x100',
      metadata: { blockTimestamp: '2025-08-19T10:00:00.000Z' },
    });
    const { client, batchCalls } = makeFakeRpc([
      [transfersResult([send]), transfersResult([])],
      [ok(receipt())],
      [transfersResult([send]), transfersResult([])],
    ]);
    const indexer = createAlchemyIndexer(client);
    const first = await indexer.listTransactions(ADDRESS);
    const second = await indexer.listTransactions(ADDRESS);
    // Batches: transfers, receipts, transfers (no second receipt batch).
    expect(batchCalls.map((b) => b[0].method)).toEqual(['alchemy_getAssetTransfers', 'eth_getTransactionReceipt', 'alchemy_getAssetTransfers']);
    expect(second[0].gasUsed).toBe(first[0].gasUsed);
    expect(second[0].gasPrice).toBe(first[0].gasPrice);
    expect(second[0].gasUsed > 0n).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listOlder: the API's own pageKey, per direction, with both categories on the
// same page.
//
// Verified live against the gateway on 2026-08-25 (BNB Chain, the owner's
// address): three pages of 200 rows each, reaching from block 117,450,593 back
// to 9,234,327, every row carrying its own `category`. On Base the same walk
// runs out and the cursor comes back null.
// ---------------------------------------------------------------------------

describe('listOlder (Alchemy pageKey paging)', () => {
  it('asks BOTH directions for external+erc20 in ONE batch and splits the answer by the row category', async () => {
    const { client, batchCalls } = makeFakeRpc([
      [
        transfersResult([extTransfer(), tokenTransfer()], 'KEY-FROM-2'),
        transfersResult([extTransfer({ hash: HASH_C, uniqueId: `${HASH_C}:external` })], 'KEY-TO-2'),
      ],
      // fillFees: the address's own sends get a receipt lookup.
      [ok(receipt())],
    ]);
    const indexer = createAlchemyIndexer(client);

    const page = await indexer.listOlder!(ADDRESS_MIXED);

    // ONE round trip for the page itself: paging must not become a burst.
    const params = batchCalls[0].map((c) => c.params?.[0] as Record<string, unknown>);
    expect(batchCalls[0]).toHaveLength(2);
    expect(batchCalls[0].every((c) => c.method === 'alchemy_getAssetTransfers')).toBe(true);
    expect(params[0].fromAddress).toBe(ADDRESS);
    expect(params[1].toAddress).toBe(ADDRESS);
    for (const p of params) {
      expect(p.category).toEqual(['external', 'erc20']);
      expect(p.order).toBe('desc');
      expect(p.maxCount).toBe('0x64');
      // The FIRST older page carries no pageKey: it is the API's own page 1,
      // which is where the key that leads further back comes from.
      expect(p.pageKey).toBeUndefined();
    }
    // The categories arrive mixed and are split by the ROW, never guessed: an
    // erc20 row read as a native transfer would show a token amount in ETH.
    expect(page.txs.map((t) => t.hash)).toEqual([HASH_A, HASH_C]);
    expect(page.tokenTransfers).toHaveLength(1);
    expect(page.tokenTransfers[0].contractAddress).toBe(TOKEN_CONTRACT);
    expect(JSON.parse(page.cursor!)).toEqual({ from: 'KEY-FROM-2', to: 'KEY-TO-2', toBlock: 'latest' });
  });

  it('starts the first page BELOW the caller oldest known block, and pins that window in the cursor', async () => {
    const { client, batchCalls } = makeFakeRpc([[transfersResult([], 'K1'), transfersResult([], 'K2')]]);
    const indexer = createAlchemyIndexer(client);

    // Without this the first click would spend a whole page re-serving rows
    // already on screen: the newest read asks for 100 external AND 100 erc20,
    // while one page here is 100 of the two combined.
    const page = await indexer.listOlder!(ADDRESS, { beforeBlock: 0x2fc1600n });

    for (const c of batchCalls[0]) {
      expect((c.params?.[0] as Record<string, unknown>).toBlock).toBe('0x2fc1600');
    }
    // The window is carried forward: a pageKey is only valid for the query it
    // was issued against.
    expect(JSON.parse(page.cursor!).toBlock).toBe('0x2fc1600');

    const { client: c2, batchCalls: calls2 } = makeFakeRpc([[transfersResult([])]]);
    await createAlchemyIndexer(c2).listOlder!(ADDRESS, {
      cursor: JSON.stringify({ from: 'K1', to: null, toBlock: '0x2fc1600' }),
      // A later call must NOT move the window, even when told a newer block.
      beforeBlock: 0x3000000n,
    });
    expect((calls2[0][0].params?.[0] as Record<string, unknown>).toBlock).toBe('0x2fc1600');
  });

  it('carries each direction pageKey forward, and stops asking a direction that ran out', async () => {
    const { client, batchCalls } = makeFakeRpc([
      // Only the `to` direction has a key left, so only it is asked.
      [transfersResult([tokenTransfer({ hash: HASH_D, uniqueId: `${HASH_D}:log:0`, from: OTHER, to: ADDRESS })])],
    ]);
    const indexer = createAlchemyIndexer(client);

    const page = await indexer.listOlder!(ADDRESS, {
      cursor: JSON.stringify({ from: null, to: 'KEY-TO-2' }),
    });

    expect(batchCalls[0]).toHaveLength(1);
    const p = batchCalls[0][0].params?.[0] as Record<string, unknown>;
    expect(p.toAddress).toBe(ADDRESS);
    expect(p.fromAddress).toBeUndefined();
    expect(p.pageKey).toBe('KEY-TO-2');
    // No key came back: this direction is finished, and with the other one
    // already finished there is nothing older at all.
    expect(page.cursor).toBe(null);
    expect(page.tokenTransfers).toHaveLength(1);
  });

  it('a cursor with both directions finished makes no request at all', async () => {
    const { client, batchCalls } = makeFakeRpc([]);
    const indexer = createAlchemyIndexer(client);

    const page = await indexer.listOlder!(ADDRESS, { cursor: JSON.stringify({ from: null, to: null }) });

    expect(batchCalls).toHaveLength(0);
    expect(page).toEqual({ txs: [], tokenTransfers: [], cursor: null });
  });

  it('an unreadable cursor starts over at the first older page rather than sending a bogus pageKey', async () => {
    const { client, batchCalls } = makeFakeRpc([[transfersResult([]), transfersResult([])]]);
    const indexer = createAlchemyIndexer(client);

    const page = await indexer.listOlder!(ADDRESS, { cursor: '{"from":42}' });

    expect(batchCalls[0]).toHaveLength(2);
    for (const c of batchCalls[0]) {
      expect((c.params?.[0] as Record<string, unknown>).pageKey).toBeUndefined();
    }
    expect(page.cursor).toBe(null);
  });

  it('a throttled page is reported as rate-limited, not as "there is nothing older"', async () => {
    const { client } = makeFakeRpc([
      new EvmRpcUnavailableError('for alchemy_getAssetTransfers', [
        { url: 'https://example.invalid', reason: 'rate limited: HTTP 429' },
      ]),
    ]);
    const indexer = createAlchemyIndexer(client);

    const err = (await indexer.listOlder!(ADDRESS).catch((e: unknown) => e)) as EvmIndexerError;
    expect(err).toBeInstanceOf(EvmIndexerError);
    expect(err.reason).toBe('rate-limited');
  });

  it('a per-item refusal is a refusal of the page, not an empty page', async () => {
    const { client } = makeFakeRpc([
      [
        transfersResult([]),
        errItem(new EvmRpcError('alchemy_getAssetTransfers', -32602, 'bad pageKey')),
      ],
    ]);
    const indexer = createAlchemyIndexer(client);

    const err = (await indexer.listOlder!(ADDRESS).catch((e: unknown) => e)) as EvmIndexerError;
    expect(err).toBeInstanceOf(EvmIndexerError);
    expect(err.reason).toBe('refused');
  });
});
