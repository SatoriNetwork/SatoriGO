// evmHistory.ts through the REAL indexer client and activity mapping against a
// fake Blockscout: rows land as Activity rows, a chain without an indexer gets
// the honest notice, and every indexer failure degrades to an issue instead of
// an empty list that reads as "no transactions".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ evmEnabled: true, gateway: '' }));

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => {
      if (!hoisted.evmEnabled) return null;
      const mod = await import('../services/chain/evm');
      if (!hoisted.gateway) return mod;
      // A GATEWAY build, simulated: __EVM_GATEWAY_URL__ is a build-time define
      // and cannot be changed per test, so the two endpoint helpers this module
      // reads are bound to a gateway here instead. Everything else, including
      // the indexer client itself, is the real code.
      return {
        ...mod,
        gatewayIndexerUrl: (chain: Parameters<typeof mod.gatewayIndexerUrl>[0]) => mod.gatewayIndexerUrl(chain, hoisted.gateway),
        evmGatewayHeaders: () => ({ 'X-Satori-Client': 'sgw_test_token' }),
      };
    },
  };
});

import { loadOlderEvmHistory, refreshEvmHistory, resetEvmIndexersForTests, STAKING_ENRICH_MAX_PER_REFRESH } from './evmHistory';
import { resetEvmProvidersForTests } from './evmBalances';
import type { EvmChainInfo } from './evmChains';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import { loadEvmHistoryCache, saveEvmHistoryCache } from './evmHistoryCache';
import { encodeDelegate, encodeWithdrawDelegatorRewards } from '../services/chain/evm/cosmosStaking';
import { evmChainByKey } from '../services/chain/evm/chains';

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const OTHER = '0x3535353535353535353535353535353535353535';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const BASE: EvmChainInfo = {
  key: 'base',
  chainId: 8453,
  displayName: 'Base',
  nativeTicker: 'ETH',
  nativeDecimals: 18,
  explorerTxUrl: 'https://basescan.org/tx/{txid}',
  homepage: 'https://example.test',
  young: false,
  recentlyAdded: false,
  feeModel: 'eip1559',
  l1DataFee: true,
  indexer: { family: 'blockscout', baseUrl: 'https://base.blockscout.com/api' },
  alchemy: false,
  trustWalletChain: null,
  tokenListSlug: null,
  defaultTokens: [{ address: USDC, symbol: 'USDC', decimals: 6 }],
};
const BSC: EvmChainInfo = { ...BASE, key: 'bsc', chainId: 56, displayName: 'BNB Chain', nativeTicker: 'BNB', indexer: null, defaultTokens: [] };
/** Phase 6: a chain with an indexer but NO Alchemy. Mirrors the registry row. */
const EPIX: EvmChainInfo = {
  ...BASE,
  key: 'epix',
  chainId: 1916,
  displayName: 'Epix',
  nativeTicker: 'EPIX',
  l1DataFee: false,
  indexer: { family: 'blockscout', baseUrl: 'https://scan.epix.zone/api/v1' },
  defaultTokens: [],
};

const H1 = '0x' + '11'.repeat(32);
const H2 = '0x' + '22'.repeat(32);
const H3 = '0x' + '33'.repeat(32);

/** A Blockscout answering by `action`, recording requests. */
function fakeBlockscout(mode: 'ok' | 'empty' | 'ratelimit' | 'http429' | 'refused' | 'down' | 'badjson' = 'ok', head?: number) {
  const urls: string[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    urls.push(u);
    headers.push(init?.headers as Record<string, string> | undefined);
    // The indexer's own head block (module=block&action=eth_block_number), in
    // the JSON-RPC shape Blockscout uses; without `head` the generic "unknown
    // action" answer below stands in for an indexer that cannot say.
    if (head !== undefined && /action=eth_block_number/.test(u)) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + head.toString(16) }), { status: 200 });
    }
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'http429') return new Response('Too Many Requests', { status: 429 });
    if (mode === 'badjson') return new Response('<html>', { status: 200 });
    if (mode === 'ratelimit') return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }), { status: 200 });
    if (mode === 'refused') return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain' }), { status: 200 });
    if (mode === 'empty') return new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }), { status: 200 });
    const action = new URL(u).searchParams.get('action');
    const me = ME.toLowerCase();
    if (action === 'txlist') {
      return new Response(
        JSON.stringify({
          status: '1',
          message: 'OK',
          result: [
            // Outgoing USDC transfer: the enclosing tx (value 0, to the contract, we paid the fee).
            { hash: H3, blockNumber: '50000003', timeStamp: '1725000300', from: me, to: USDC, value: '0', gasUsed: '50000', gasPrice: '6000000', isError: '0', txreceipt_status: '1', input: '0xa9059cbb', contractAddress: '', confirmations: '10' },
            // Outgoing 0.001 ETH.
            { hash: H2, blockNumber: '50000002', timeStamp: '1725000200', from: me, to: OTHER, value: '1000000000000000', gasUsed: '21000', gasPrice: '6000000', isError: '0', txreceipt_status: '1', input: '0x', contractAddress: '', confirmations: '11' },
            // Incoming 0.5 ETH.
            { hash: H1, blockNumber: '50000001', timeStamp: '1725000100', from: OTHER, to: me, value: '500000000000000000', gasUsed: '21000', gasPrice: '6000000', isError: '0', txreceipt_status: '1', input: '0x', contractAddress: '', confirmations: '12' },
          ],
        }),
        { status: 200 },
      );
    }
    if (action === 'tokentx') {
      return new Response(
        JSON.stringify({
          status: '1',
          message: 'OK',
          result: [
            { hash: H3, blockNumber: '50000003', timeStamp: '1725000300', from: me, to: OTHER, contractAddress: USDC, value: '2500000', tokenSymbol: 'USDC', tokenName: 'USD Coin', tokenDecimal: '6', gasUsed: '50000', gasPrice: '6000000', confirmations: '10' },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'unknown action' }), { status: 200 });
  };
  return { fetchImpl, urls, headers };
}

beforeEach(() => {
  hoisted.evmEnabled = true;
  hoisted.gateway = '';
  resetEvmIndexersForTests();
  // The rpc client captures its fetch at construction, and the staking-label
  // read below goes through the cached per-chain provider.
  resetEvmProvidersForTests();
  // A fresh cache per test: the history cache persists rows across reads.
  setStorageForTests(new MemoryStorageAdapter());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshEvmHistory', () => {
  it('1. maps txlist + tokentx into Activity rows, newest first, with fees where we paid them', async () => {
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);
    const r = await refreshEvmHistory(BASE, ME, 50_000_020);
    expect(r).not.toBe(null);
    expect(r!.issue).toBe(null);
    const rows = r!.txs!;
    expect(rows.map((t) => `${t.direction}:${t.asset}:${t.amount}`)).toEqual([
      'out:USDC:2.5',
      'out:ETH:0.001',
      'in:ETH:0.5',
    ]);
    // Fee on the rows we sent (gasUsed x gasPrice, whole ETH), none on the incoming one.
    expect(rows[0].feeEvr).toBeCloseTo(50000 * 6_000_000 / 1e18, 25);
    expect(rows[1].feeEvr).toBeCloseTo(21000 * 6_000_000 / 1e18, 25);
    expect(rows[2].feeEvr).toBe(0);
    expect(rows.every((t) => t.status === 'confirmed')).toBe(true);
    expect(rows[1].counterparty).toBe(OTHER);
    // Two list requests (txlist and tokentx, our address, newest first) plus
    // the indexer head probe that the lag check asks for when a tip is known.
    expect(node.urls.map((u) => new URL(u).searchParams.get('action')).sort()).toEqual(['eth_block_number', 'tokentx', 'txlist']);
    for (const u of node.urls) {
      const p = new URL(u).searchParams;
      if (p.get('action') === 'eth_block_number') continue; // the head probe carries no address
      expect(p.get('address')).toBe(ME.toLowerCase());
      expect(p.get('sort')).toBe('desc');
    }
  });

  it('2. an empty history is an empty list with NO issue', async () => {
    vi.stubGlobal('fetch', fakeBlockscout('empty').fetchImpl);
    const r = await refreshEvmHistory(BASE, ME);
    expect(r).toEqual({ txs: [], issue: null, tokensSeen: [] });
  });

  it('3. a chain without an indexer: empty list plus the honest notice, and no request', async () => {
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);
    const r = await refreshEvmHistory(BSC, ME);
    expect(r!.txs).toEqual([]);
    expect(r!.issue?.message).toMatch(/cannot be listed on BNB Chain/);
    expect(node.urls).toHaveLength(0);
  });

  it('4. rate limit / refusal / unreachable / bad JSON: txs null (keep what we had) and a specific issue', async () => {
    for (const [mode, re] of [
      ['ratelimit', /rate-limiting/],
      ['http429', /rate-limiting/],
      ['refused', /refused the request/],
      ['down', /unreachable/],
      ['badjson', /unreachable/],
    ] as const) {
      resetEvmIndexersForTests();
      vi.stubGlobal('fetch', fakeBlockscout(mode).fetchImpl);
      const r = await refreshEvmHistory(BASE, ME);
      expect(r!.txs, mode).toBe(null);
      expect(r!.issue?.message, mode).toMatch(re);
      expect(r!.issue?.detail, mode).toBeTruthy();
    }
  });

  it('5. the indexer client is reused per chain (one instance, sticky config)', async () => {
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);
    await refreshEvmHistory(BASE, ME);
    await refreshEvmHistory(BASE, ME);
    expect(node.urls).toHaveLength(4);
    expect(node.urls.every((u) => u.startsWith('https://base.blockscout.com/api?'))).toBe(true);
  });

  it('7. cache: a successful read is saved; the next read asks only past the watermark (startblock) and merges; a failing indexer returns the SAVED rows as stale with a "saved history" notice', async () => {
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);
    const first = await refreshEvmHistory(BASE, ME);
    expect(first!.txs!.length).toBeGreaterThan(0);
    expect(node.urls.some((u) => /startblock=/.test(u))).toBe(false);
    const saved = await loadEvmHistoryCache('base', ME);
    expect(saved?.rows.length).toBe(first!.txs!.length);
    expect(saved?.highestBlock).toBe(50000003);

    // Second read: incremental (startblock = watermark - overlap), same rows after the merge.
    node.urls.length = 0;
    const second = await refreshEvmHistory(BASE, ME);
    expect(node.urls.every((u) => /startblock=49999983/.test(u))).toBe(true);
    expect(second!.txs!.map((t) => t.txid)).toEqual(first!.txs!.map((t) => t.txid));
    expect(second!.stale).toBeFalsy();

    // Indexer down now: the saved rows come back, flagged stale, with the notice.
    resetEvmIndexersForTests();
    vi.stubGlobal('fetch', fakeBlockscout('refused').fetchImpl);
    const third = await refreshEvmHistory(BASE, ME);
    expect(third!.txs!.length).toBe(first!.txs!.length);
    expect(third!.stale).toBe(true);
    expect(third!.issue?.message).toMatch(/^Showing saved history; newer items may be missing\. Activity cannot be refreshed right now/);

    // No cache at all: still null + the plain notice (rule 4).
    setStorageForTests(new MemoryStorageAdapter());
    resetEvmIndexersForTests();
    const fourth = await refreshEvmHistory(BASE, ME);
    expect(fourth!.txs).toBe(null);
    expect(fourth!.issue?.message).toMatch(/^Activity cannot be listed right now/);
    await saveEvmHistoryCache('base', ME, { rows: [], highestBlock: 0, fetchedAt: 0 });
  });

  it('6. without the engine: null', async () => {
    hoisted.evmEnabled = false;
    expect(await refreshEvmHistory(BASE, ME)).toBe(null);
  });

  it('8. Epix without a gateway (dev build): the chain\'s own Blockscout, chainid sent, no custom header', async () => {
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);
    const r = await refreshEvmHistory(EPIX, ME, 50_000_020);
    expect(r!.issue).toBe(null);
    expect(r!.txs!.length).toBeGreaterThan(0);
    for (const u of node.urls) {
      expect(u.startsWith('https://scan.epix.zone/api/v1?')).toBe(true);
      expect(new URL(u).searchParams.get('chainid')).toBe('1916');
    }
    // No X-Satori-Client against a third-party host: a header there would only
    // buy a CORS preflight.
    expect(node.headers.every((h) => h === undefined)).toBe(true);
  });

  it('9. Epix in a GATEWAY build: the indexer is the gateway proxy, authed, offset <= 100, and NO chainid (the proxy allows a fixed parameter set)', async () => {
    hoisted.gateway = 'https://network.satorigo.app';
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);
    const r = await refreshEvmHistory(EPIX, ME, 50_000_020);
    expect(r!.issue).toBe(null);
    // Same rows: the proxy returns Blockscout's body unchanged, so the parsing
    // does not care which of the two answered.
    expect(r!.txs!.map((t) => `${t.direction}:${t.asset}`)).toEqual(['out:USDC', 'out:EPIX', 'in:EPIX']);
    // Two list requests + the head probe, all through the proxy, all authed.
    expect(node.urls.length).toBe(3);
    for (const u of node.urls) {
      const parsed = new URL(u);
      expect(parsed.origin).toBe('https://network.satorigo.app');
      expect(parsed.pathname).toBe('/evm/epix/indexer');
      expect(parsed.searchParams.get('chainid')).toBe(null);
      expect(parsed.searchParams.get('apikey')).toBe(null);
      // Only the parameters the proxy accepts.
      if (parsed.searchParams.get('action') === 'eth_block_number') {
        expect([...parsed.searchParams.keys()].sort()).toEqual(['action', 'module']);
      } else {
        expect(Number(parsed.searchParams.get('offset'))).toBeLessThanOrEqual(100);
        expect([...parsed.searchParams.keys()].sort()).toEqual(['action', 'address', 'module', 'offset', 'page', 'sort']);
      }
    }
    expect(node.headers.every((h) => h && h['X-Satori-Client'] === 'sgw_test_token')).toBe(true);
  });

  it('12. an indexer that trails the chain tip by more than INDEXER_LAG_BLOCKS says so (rows still listed); a fresh one does not; one that cannot say is left alone', async () => {
    // Explorer at 50,000,100; chain tip 50,041,600 (Epix's Blockscout, 2026-08-20).
    vi.stubGlobal('fetch', fakeBlockscout('ok', 50_000_100).fetchImpl);
    const behind = await refreshEvmHistory(BASE, ME, 50_041_600);
    expect(behind!.txs!.length).toBeGreaterThan(0);
    expect(behind!.issue?.message).toMatch(/Activity on Base is behind/);
    expect(behind!.issue?.message).toMatch(/41,500 blocks behind/);
    expect(behind!.issue?.detail).toMatch(/indexer head 50000100 vs chain tip 50041600/);

    resetEvmIndexersForTests();
    setStorageForTests(new MemoryStorageAdapter());
    vi.stubGlobal('fetch', fakeBlockscout('ok', 50_041_550).fetchImpl);
    const fresh = await refreshEvmHistory(BASE, ME, 50_041_600);
    expect(fresh!.issue).toBe(null);

    resetEvmIndexersForTests();
    setStorageForTests(new MemoryStorageAdapter());
    vi.stubGlobal('fetch', fakeBlockscout('ok').fetchImpl); // no head answer
    const unknown = await refreshEvmHistory(BASE, ME, 50_041_600);
    expect(unknown!.issue).toBe(null);
  });

  it('10. in a GATEWAY build no Etherscan-shaped read ever leaves the gateway host: Base takes the proxy too when it falls back to its public indexer', async () => {
    // A gateway build permits exactly one EVM host, so reaching
    // base.blockscout.com directly would simply fail in MV3. Whichever chain
    // ends up on the Etherscan-shaped path there, the proxy is where it goes.
    hoisted.gateway = 'https://network.satorigo.app';
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);
    await refreshEvmHistory(BASE, ME);
    expect(node.urls.length).toBe(2);
    expect(node.urls.every((u) => u.startsWith('https://network.satorigo.app/evm/base/indexer?'))).toBe(true);
  });

  it('11. a chain the registry does not know keeps its own indexer base URL even with a gateway (no route can be invented for it)', async () => {
    hoisted.gateway = 'https://network.satorigo.app';
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);
    await refreshEvmHistory({ ...EPIX, key: 'not-in-registry' }, ME);
    expect(node.urls.every((u) => u.startsWith('https://scan.epix.zone/api/v1?'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Staking labels (owner, 2026-08-24: "w activity powinna byc historia co staked
// co nie i gdzie"). Epix's history source reports a delegation with `input:
// '0x'`, so the calldata is bought with one eth_getTransactionByHash, decoded,
// and PERSISTED on the row: fetched once ever, not once per refresh.

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000000800';
const DISTRIBUTION_PRECOMPILE = '0x0000000000000000000000000000000000000801';
const VALOPER = 'epixvaloper1qxt7awul3cyvgf2ku08k3n3nqn7lsqvsm7ryjw';
const H_STAKE = '0x' + 'ab'.repeat(32);
const H_CLAIM = '0x' + 'cd'.repeat(32);

const EPIX_CFG = evmChainByKey('epix')?.staking;
if (!EPIX_CFG) throw new Error('epix staking row missing from the registry');
const asHex = (bytes: Uint8Array) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const DELEGATE_CALLDATA = asHex(encodeDelegate(EPIX_CFG, ME, VALOPER, 2_500_000_000_000_000_000n));
const CLAIM_CALLDATA = asHex(encodeWithdrawDelegatorRewards(EPIX_CFG, ME, VALOPER));

/** The distribution precompile's own reward event, in the exact shape the
 *  owner's real claim carried on 2026-08-24 (see cosmosStaking.test.ts section
 *  8 for the verbatim receipt). 0.0440086 EPIX. */
const CLAIMED_BASE = 44_008_664_215_885_200n;
const rewardLog = (delegator: string) => ({
  address: DISTRIBUTION_PRECOMPILE,
  topics: [
    '0xcf871d3149ad677b268b0238a4ffc6d4008f48a11e73468d05ff00e75f204035',
    `0x000000000000000000000000${delegator.slice(2).toLowerCase()}`,
    '0x000000000000000000000000f9a745a2ba871b9ae5e4a68fbe6b36397f204851',
  ],
  data: `0x${CLAIMED_BASE.toString(16).padStart(64, '0')}`,
});

/** An Epix-shaped history source PLUS a JSON-RPC node behind the same fetch.
 *  Records every hash the node was asked about, per method, and the size of
 *  each batch. */
function fakeEpixWithNode(node: 'ok' | 'down' | 'refuse' = 'ok', receipts: 'ok' | 'refuse' | 'no-logs' = 'ok', extraClaims: string[] = []) {
  const asked: string[] = [];
  const askedReceipts: string[] = [];
  const batches: number[] = [];
  const me = ME.toLowerCase();
  const row = (hash: string, to: string, block: number, ts: number) => ({
    hash,
    blockNumber: String(block),
    timeStamp: String(ts),
    from: me,
    to,
    // Exactly what the real source reports for a cosmos/evm staking call: no
    // value, and NO CALLDATA.
    value: '0',
    input: '0x',
    gasUsed: '120000',
    gasPrice: '20000000000',
    isError: '0',
    txreceipt_status: '1',
    contractAddress: '',
    confirmations: '5',
  });
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST') {
      if (node === 'down') throw new TypeError('fetch failed');
      const body: unknown = JSON.parse(String(init.body));
      const calls = (Array.isArray(body) ? body : [body]) as Array<{ id: number; method: string; params: string[] }>;
      // The client verifies an endpoint with eth_chainId before its first real
      // request; that probe is not a history read and is not counted.
      if (calls.some((c) => c.method === 'eth_getTransactionByHash' || c.method === 'eth_getTransactionReceipt')) {
        batches.push(calls.length);
      }
      const answers = calls.map((c) => {
        if (c.method === 'eth_chainId') return { jsonrpc: '2.0', id: c.id, result: '0x77c' }; // 1916
        if (c.method === 'eth_getTransactionReceipt') {
          const hash = c.params[0];
          askedReceipts.push(hash);
          if (receipts === 'refuse') return { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: 'not found' } };
          const logs = receipts === 'no-logs' ? [] : [rewardLog(ME)];
          return { jsonrpc: '2.0', id: c.id, result: { transactionHash: hash, status: '0x1', logs } };
        }
        if (c.method !== 'eth_getTransactionByHash') return { jsonrpc: '2.0', id: c.id, result: null };
        const hash = c.params[0];
        asked.push(hash);
        if (node === 'refuse') return { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: 'not found' } };
        const input = hash === H_STAKE ? DELEGATE_CALLDATA : hash === H_CLAIM || extraClaims.includes(hash) ? CLAIM_CALLDATA : '0x';
        return { jsonrpc: '2.0', id: c.id, result: { hash, input } };
      });
      return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
    }
    const action = new URL(String(url)).searchParams.get('action');
    if (action === 'txlist') {
      return new Response(
        JSON.stringify({
          status: '1',
          message: 'OK',
          result: [
            ...extraClaims.map((hash, i) => row(hash, DISTRIBUTION_PRECOMPILE, 900_100 + i, 1_725_200_000 + i)),
            row(H_CLAIM, DISTRIBUTION_PRECOMPILE, 900_002, 1_725_100_200),
            row(H_STAKE, STAKING_PRECOMPILE, 900_001, 1_725_100_100),
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }), { status: 200 });
  };
  return { fetchImpl, asked, askedReceipts, batches };
}

describe('refreshEvmHistory: native-staking labels', () => {
  it('13. a staking row the source reports with no calldata is LISTED and LABELLED, from one batched eth_getTransactionByHash', async () => {
    const epix = fakeEpixWithNode();
    vi.stubGlobal('fetch', epix.fetchImpl);
    const r = await refreshEvmHistory(EPIX, ME);
    const rows = r!.txs!;
    // Both rows exist at all: under the old rule 4 a value-0 call with an empty
    // input was dropped, so a stake never reached Activity.
    expect(rows.map((t) => t.txid)).toEqual([H_CLAIM, H_STAKE]);
    expect(rows.find((t) => t.txid === H_STAKE)!.staking).toEqual({
      kind: 'stake',
      validator: VALOPER,
      amountBase: 2_500_000_000_000_000_000n,
    });
    // A claim's calldata carries no amount, so the amount comes from the
    // RECEIPT: the second pass, in the same refresh (see test 17).
    expect(rows.find((t) => t.txid === H_CLAIM)!.staking).toEqual({
      kind: 'claim',
      validator: VALOPER,
      amountBase: CLAIMED_BASE,
    });
    // ONE HTTP round trip for both calldata reads, not one per transaction,
    // then one more for the single claim's receipt.
    expect(epix.batches).toEqual([2, 1]);
    expect(epix.asked.sort()).toEqual([H_STAKE, H_CLAIM].sort());
    expect(epix.askedReceipts).toEqual([H_CLAIM]);
  });

  it('14. the decoded label is PERSISTED, so a second refresh asks the node nothing (fetched once ever, across sessions)', async () => {
    const first = fakeEpixWithNode();
    vi.stubGlobal('fetch', first.fetchImpl);
    await refreshEvmHistory(EPIX, ME);
    expect(first.asked).toHaveLength(2);

    // What went to storage carries the label, with the amount as a string: a
    // bigint would make JSON.stringify throw and lose the WHOLE entry.
    const saved = await loadEvmHistoryCache('epix', ME);
    expect(saved!.rows.find((t) => t.txid === H_STAKE)!.staking!.amountBase).toBe(2_500_000_000_000_000_000n);

    // The claim's amount round-trips through storage the same way.
    expect(saved!.rows.find((t) => t.txid === H_CLAIM)!.staking).toEqual({
      kind: 'claim',
      validator: VALOPER,
      amountBase: CLAIMED_BASE,
    });

    // Second refresh, fresh client: the indexer answers the same rows with no
    // calldata, the merge keeps the label, and the node is not asked again.
    // NEITHER read: no calldata, and no receipt for the already-priced claim.
    resetEvmIndexersForTests();
    resetEvmProvidersForTests();
    const second = fakeEpixWithNode();
    vi.stubGlobal('fetch', second.fetchImpl);
    const r = await refreshEvmHistory(EPIX, ME);
    expect(second.asked).toEqual([]);
    expect(second.askedReceipts).toEqual([]);
    expect(second.batches).toEqual([]);
    expect(r!.txs!.find((t) => t.txid === H_STAKE)!.staking).toEqual({
      kind: 'stake',
      validator: VALOPER,
      amountBase: 2_500_000_000_000_000_000n,
    });
    expect(r!.txs!.find((t) => t.txid === H_CLAIM)!.staking!.amountBase).toBe(CLAIMED_BASE);
  });

  it('15. a node that is unreachable or refuses leaves the rows unlabelled and listed, never an error', async () => {
    for (const mode of ['down', 'refuse'] as const) {
      resetEvmIndexersForTests();
      resetEvmProvidersForTests();
      setStorageForTests(new MemoryStorageAdapter());
      const epix = fakeEpixWithNode(mode);
      vi.stubGlobal('fetch', epix.fetchImpl);
      const r = await refreshEvmHistory(EPIX, ME);
      expect(r!.issue, mode).toBe(null);
      expect(r!.txs!.map((t) => t.txid), mode).toEqual([H_CLAIM, H_STAKE]);
      expect(r!.txs!.every((t) => t.staking === undefined), mode).toBe(true);
    }
  });

  it('16. a chain with no staking row never asks the node anything (the capability test, not a chain name)', async () => {
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);
    await refreshEvmHistory(BASE, ME);
    expect(node.urls.every((u) => u.startsWith('https://base.blockscout.com/api?'))).toBe(true);
    expect(node.urls.some((u) => /rpc/i.test(u))).toBe(false);
  });

  it('17. ONLY a claim gets a receipt read: a stake already carries its amount in its calldata', async () => {
    const epix = fakeEpixWithNode();
    vi.stubGlobal('fetch', epix.fetchImpl);
    await refreshEvmHistory(EPIX, ME);
    expect(epix.askedReceipts).toEqual([H_CLAIM]);
    expect(epix.askedReceipts).not.toContain(H_STAKE);
  });

  it('18. a receipt read that fails, or that carries no reward event, never breaks the row: the first is retried, the second is answered once', async () => {
    // Refused: the label stands without an amount, and the NEXT refresh asks
    // again (nothing was recorded, so nothing is "known").
    const refusing = fakeEpixWithNode('ok', 'refuse');
    vi.stubGlobal('fetch', refusing.fetchImpl);
    const r = await refreshEvmHistory(EPIX, ME);
    expect(r!.issue).toBe(null);
    expect(r!.txs!.find((t) => t.txid === H_CLAIM)!.staking).toEqual({ kind: 'claim', validator: VALOPER });
    resetEvmIndexersForTests();
    resetEvmProvidersForTests();
    const retry = fakeEpixWithNode('ok', 'refuse');
    vi.stubGlobal('fetch', retry.fetchImpl);
    await refreshEvmHistory(EPIX, ME);
    expect(retry.askedReceipts).toEqual([H_CLAIM]);

    // No reward event (a claim the chain reverted, or one where nothing had
    // accrued): 0n is a KNOWN answer, so it is recorded and never asked again.
    setStorageForTests(new MemoryStorageAdapter());
    resetEvmIndexersForTests();
    resetEvmProvidersForTests();
    const empty = fakeEpixWithNode('ok', 'no-logs');
    vi.stubGlobal('fetch', empty.fetchImpl);
    const first = await refreshEvmHistory(EPIX, ME);
    expect(first!.txs!.find((t) => t.txid === H_CLAIM)!.staking!.amountBase).toBe(0n);
    resetEvmIndexersForTests();
    resetEvmProvidersForTests();
    const again = fakeEpixWithNode('ok', 'no-logs');
    vi.stubGlobal('fetch', again.fetchImpl);
    await refreshEvmHistory(EPIX, ME);
    expect(again.askedReceipts).toEqual([]);
  });

  it('19. calldata reads and receipt reads share ONE 20-per-refresh budget: a page of claims cannot double the traffic', async () => {
    // 25 claims + the two fixed rows: pass 1 spends the whole budget on
    // calldata, so pass 2 buys NO receipts this refresh.
    const many = Array.from({ length: 25 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}`);
    const epix = fakeEpixWithNode('ok', 'ok', many);
    vi.stubGlobal('fetch', epix.fetchImpl);
    await refreshEvmHistory(EPIX, ME);
    expect(epix.asked).toHaveLength(STAKING_ENRICH_MAX_PER_REFRESH);
    expect(epix.askedReceipts).toEqual([]);
    expect(epix.asked.length + epix.askedReceipts.length).toBe(STAKING_ENRICH_MAX_PER_REFRESH);

    // Next refresh: 20 rows are labelled and need receipts, 7 still need their
    // calldata. The 7 calldata reads go first (newest first) and the remaining
    // 13 of the budget go to receipts. Still exactly 20 requests.
    resetEvmIndexersForTests();
    resetEvmProvidersForTests();
    const second = fakeEpixWithNode('ok', 'ok', many);
    vi.stubGlobal('fetch', second.fetchImpl);
    await refreshEvmHistory(EPIX, ME);
    expect(second.asked).toHaveLength(7);
    expect(second.askedReceipts).toHaveLength(13);
    expect(second.asked.length + second.askedReceipts.length).toBe(STAKING_ENRICH_MAX_PER_REFRESH);
  });
});

// ---------------------------------------------------------------------------
// loadOlderEvmHistory: one page further back, through the same client.
// ---------------------------------------------------------------------------

describe('loadOlderEvmHistory', () => {
  /** A Blockscout with `count` full pages of native rows, then nothing. */
  function pagedBlockscout(count: number) {
    const urls: string[] = [];
    const me = ME.toLowerCase();
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      urls.push(u);
      const sp = new URL(u).searchParams;
      const action = sp.get('action');
      const page = Number(sp.get('page') ?? '1');
      if (action === 'txlist' && page <= count) {
        const rows = Array.from({ length: 100 }, (_, i) => {
          const n = page * 1000 + i;
          return {
            hash: '0x' + n.toString(16).padStart(64, '0'),
            blockNumber: String(50_000_000 - n),
            timeStamp: String(1_725_000_000 - n),
            from: OTHER,
            to: me,
            value: '1000000000000000',
            gasUsed: '21000',
            gasPrice: '6000000',
            isError: '0',
            txreceipt_status: '1',
            input: '0x',
            contractAddress: '',
            confirmations: '10',
          };
        });
        return new Response(JSON.stringify({ status: '1', message: 'OK', result: rows }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }), { status: 200 });
    };
    return { fetchImpl, urls };
  }

  it('serves an older page and hands back a cursor while there is more', async () => {
    const node = pagedBlockscout(3);
    vi.stubGlobal('fetch', node.fetchImpl);

    const first = await loadOlderEvmHistory(BASE, ME, undefined, 50_000_020);
    expect(first!.rows).toHaveLength(100);
    expect(first!.hasMore).toBe(true);
    expect(first!.issue).toBe(null);
    // The rows are Activity rows, mapped exactly as the newest page is.
    expect(first!.rows![0].asset).toBe('ETH');
    expect(first!.rows![0].direction).toBe('in');
    // Page 2 first: page 1 is what the ordinary refresh already showed.
    expect(node.urls.map((u) => new URL(u).searchParams.get('page'))).toContain('2');

    const second = await loadOlderEvmHistory(BASE, ME, first!.cursor!, 50_000_020);
    expect(second!.rows).toHaveLength(100);
    expect(second!.hasMore).toBe(true);
    // ...and its rows are OLDER than the first page's.
    expect(second!.rows![0].blockHeight!).toBeLessThan(first!.rows![0].blockHeight!);
  });

  it('says plainly when the source has nothing older, instead of an empty page with a button', async () => {
    // Two pages exist, so the first older call is full and the next one is not.
    const node = pagedBlockscout(2);
    vi.stubGlobal('fetch', node.fetchImpl);

    const first = await loadOlderEvmHistory(BASE, ME, undefined, 50_000_020);
    expect(first!.hasMore).toBe(true);
    const second = await loadOlderEvmHistory(BASE, ME, first!.cursor!, 50_000_020);
    expect(second!.rows).toEqual([]);
    expect(second!.hasMore).toBe(false);
    expect(second!.cursor).toBe(null);
  });

  it('an address whose history ends inside the FIRST older page reports it at once', async () => {
    vi.stubGlobal('fetch', pagedBlockscout(0).fetchImpl);

    const only = await loadOlderEvmHistory(BASE, ME, undefined, 50_000_020);
    expect(only!.rows).toEqual([]);
    expect(only!.hasMore).toBe(false);
    expect(only!.cursor).toBe(null);
  });

  it('a chain with NO history source cannot page, and says so without a request', async () => {
    const node = fakeBlockscout();
    vi.stubGlobal('fetch', node.fetchImpl);

    const r = await loadOlderEvmHistory(BSC, ME, undefined);

    expect(r).toEqual({ rows: [], cursor: null, hasMore: false, issue: null });
    expect(node.urls).toHaveLength(0);
  });

  it('a failed page keeps its cursor and stays "there may be more", so a retry resumes', async () => {
    vi.stubGlobal('fetch', fakeBlockscout('http429').fetchImpl);

    const r = await loadOlderEvmHistory(BASE, ME, JSON.stringify({ tx: 4, token: 4 }));

    expect(r!.rows).toBe(null);
    expect(r!.cursor).toBe(JSON.stringify({ tx: 4, token: 4 }));
    expect(r!.hasMore).toBe(true);
    expect(r!.issue?.message).toMatch(/rate-limiting/i);
  });

  it('a build with no EVM engine answers null, exactly like the newest-page read', async () => {
    hoisted.evmEnabled = false;
    expect(await loadOlderEvmHistory(BASE, ME, undefined)).toBe(null);
  });
});
