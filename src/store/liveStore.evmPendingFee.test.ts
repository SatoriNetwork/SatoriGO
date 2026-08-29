// The FEE a just-broadcast EVM row shows, on both money paths.
//
// Owner's report (2026-08-24, live on Epix with 1000 EPIX): right after a claim
// or a stake, Activity showed a network fee well above what the chain charged,
// until the indexer's row replaced it. The cause was the same on the ordinary
// send path: the local pending row was built from `plan.quote.maxTotal`, the
// WORST case, rather than `estimatedTotal`, what the transaction is expected to
// cost. maxTotal is what must be AVAILABLE (the balance check and the fee caps
// keep using it); it is not a fee to display as if it had been charged.
//
// Real store, real EVM modules, real signing, against a fake node.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return { ...actual, loadEvmModules: async () => await import('../services/chain/evm') };
});

import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import { resetEvmProvidersForTests } from './evmBalances';
import { resetEvmIndexersForTests } from './evmHistory';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const TO = '0x3535353535353535353535353535353535353535';
const PW = 'password123';
/** A real Epix validator (the one the owner's own claim named). */
const VALOPER = 'epixvaloper1lxn5tg46sude4e0y568mu6ek89ljqjz3m0he4x';

const word = (hex: string) => hex.padStart(64, '0');

interface Req { id: number; method: string; params: unknown[] }

/**
 * One fake node for every chain, answering by method, with a per-chain fee
 * market (Epix's real one, a constant 20 gwei base fee with no priority reward;
 * Base's much smaller one, because that chain's fee cap refuses Epix numbers).
 *
 * On both, maxFeePerGas is 2x the base fee, which is exactly what makes maxTotal
 * and estimatedTotal differ by roughly a factor of two. That factor IS what the
 * owner saw on his pending rows.
 */
function fakeNode() {
  const seen: Req[] = [];
  const answer = (req: Req, url: string): Record<string, unknown> => {
    seen.push(req);
    const epix = url.includes('epix');
    // Epix's real market (20 gwei flat, no priority reward); Base's is orders
    // of magnitude smaller, and the wallet's per-chain fee caps say so.
    const baseFee = epix ? '0x4a817c800' : '0x4c4b40';
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
    const err = (message: string, code = 3) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
    switch (req.method) {
      case 'eth_chainId':
        return ok(epix ? '0x77c' : '0x2105');
      case 'eth_blockNumber':
        return ok('0x100');
      case 'eth_getBlockByNumber':
        return ok({ timestamp: '0x66f00000' });
      case 'eth_getBalance':
        return ok(String(req.params[0]).toLowerCase() === ME.toLowerCase() ? '0x3635c9adc5dea00000' : '0x0'); // 1000
      case 'eth_estimateGas':
        // 118687 is the gas Epix answered for a real delegate; 21000 on Base.
        return ok(epix ? '0x1cf9f' : '0x5208');
      case 'eth_feeHistory':
        return ok({
          baseFeePerGas: [baseFee, baseFee, baseFee, baseFee, baseFee, baseFee],
          reward: Array.from({ length: 5 }, () => (epix ? ['0x0', '0x0', '0x0'] : ['0xf4240', '0x10c8e0', '0x2dc6c0'])),
        });
      case 'eth_gasPrice':
        return ok(epix ? '0x53d1ac100' : '0x5b8d80'); // 22.5 gwei / 6,000,000 wei
      case 'eth_getTransactionCount':
        return ok('0x7');
      case 'eth_sendRawTransaction':
        return ok('0x' + bytesToHex(keccak_256(hexToBytes((req.params[0] as string).slice(2)))));
      case 'eth_call': {
        const call = req.params[0] as { to?: string; data?: string };
        // Base's L1 fee oracle: without an answer here the whole quote fails on
        // an OP-stack chain.
        if ((call.to ?? '').toLowerCase() === '0x420000000000000000000000000000000000000f') return ok('0x' + word('2f0d'));
        const data = call.data ?? '';
        if (data.startsWith('0x70a08231')) return ok('0x' + word('4c4b40')); // balanceOf: 5 USDC
        if (data.startsWith('0x313ce567')) return ok('0x' + word('6')); // decimals
        if (data.startsWith('0x95d89b41')) {
          return ok('0x' + word('20') + word('4') + Buffer.from('USDC', 'utf8').toString('hex').padEnd(64, '0'));
        }
        return err('execution reverted');
      }
      default:
        return err('method not found', -32601);
    }
  };
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    // Only JSON-RPC POSTs are answered; the Cosmos LCD and the indexer are not
    // reachable here, and neither is on the path under test.
    if (init?.method !== 'POST') return new Response('{}', { status: 503 });
    const body = JSON.parse(String(init.body)) as Req | Req[];
    const out = Array.isArray(body) ? body.map((r) => answer(r, u)) : answer(body, u);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetchImpl, seen };
}

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
const state = () => mod.useLiveStore.getState();

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  mod = await import('./liveStore');
});

beforeEach(async () => {
  setStorageForTests(new MemoryStorageAdapter());
  resetEvmProvidersForTests();
  resetEvmIndexersForTests();
  vi.stubGlobal('fetch', fakeNode().fetchImpl);
  await state().resetLiveWallet();
  await state().init();
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
});

afterEach(() => {
  state().stopAutoRefresh();
  vi.unstubAllGlobals();
});

/** Import on an EVM target and wait for the chain to become active: the store
 *  wires the chain and the first balance read asynchronously. */
async function importOn(target: `evm:${string}`): Promise<void> {
  await state().importWallet(VECTOR_MNEMONIC, PW, 'EVM', target);
  const key = target.slice('evm:'.length);
  for (let i = 0; i < 100 && state().evm.activeChainKey !== key; i++) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 100 && state().assets.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
}

/** The row this wallet just created for `txid`, from the store's own list. */
const rowFor = (txid: string) => state().txs.find((t) => t.txid === txid);

describe('the pending row a just-broadcast EVM transaction shows', () => {
  it('1. a plain send records the ESTIMATED fee, not the worst case (which is about twice as much here)', async () => {
    await importOn('evm:epix');
    const plan = await state().quoteEvmSend({ to: TO, amountText: '1', assetId: 'EPIX' });
    expect(plan).not.toBe(null);
    // The two figures are meaningfully different, or this test proves nothing.
    expect(plan!.quote.maxTotal).toBeGreaterThan(plan!.quote.estimatedTotal);

    state().arm(true);
    const { txid } = await state().confirmEvmSend();
    const row = rowFor(txid);
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.feeEvr).toBe(Number(plan!.quote.estimatedTotal) / 1e18);
    expect(row!.feeEvr).not.toBe(Number(plan!.quote.maxTotal) / 1e18);
    // spentNative follows the same fee: amount sent plus what it is expected to
    // cost, never plus the reservation.
    expect(row!.spentNative).toBeCloseTo(1 + Number(plan!.quote.estimatedTotal) / 1e18, 12);
  });

  it('2. an ERC-20 send takes the same figure (one code path, so a token send cannot drift from a native one)', async () => {
    await importOn('evm:base');
    // Base's USDC, from the registry's default token list.
    const plan = await state().quoteEvmSend({
      to: TO,
      amountText: '1',
      assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(plan).not.toBe(null);
    expect(plan!.asset.kind).toBe('token');
    expect(plan!.quote.maxTotal).toBeGreaterThan(plan!.quote.estimatedTotal);

    state().arm(true);
    const { txid } = await state().confirmEvmSend();
    const row = rowFor(txid);
    expect(row!.asset).toBe('USDC');
    expect(row!.feeEvr).toBe(Number(plan!.quote.estimatedTotal) / 1e18);
    // A token send moves no native coin: the fee IS the whole native spend.
    expect(row!.spentNative).toBe(Number(plan!.quote.estimatedTotal) / 1e18);
  });

  it('3. a STAKE records the same estimated fee, and the pending claim row carries no amount yet', async () => {
    await importOn('evm:epix');

    const stake = await state().planEvmStake({ action: 'delegate', valoper: VALOPER, amountText: '10' });
    expect(stake).not.toBe(null);
    expect(stake!.quote.maxTotal).toBeGreaterThan(stake!.quote.estimatedTotal);
    state().arm(true);
    const staked = await state().confirmEvmStake();
    const stakeRow = rowFor(staked.txid);
    expect(stakeRow!.feeEvr).toBe(Number(stake!.quote.estimatedTotal) / 1e18);
    expect(stakeRow!.feeEvr).not.toBe(Number(stake!.quote.maxTotal) / 1e18);
    // A delegation moves coins through the Cosmos module, so the row's own
    // amount is 0 and the staked figure lives on the label.
    expect(stakeRow!.staking).toEqual({ kind: 'stake', validator: VALOPER, amountBase: 10n * 10n ** 18n });
    expect(stakeRow!.spentNative).toBe(Number(stake!.quote.estimatedTotal) / 1e18);

    // A CLAIM: the calldata names a validator and no amount, so the pending row
    // says "Claimed rewards" with no figure. The amount arrives with the receipt
    // once the transaction confirms (store/evmHistory.ts), never invented here.
    const claim = await state().planEvmStake({ action: 'claim', valoper: VALOPER });
    expect(claim).not.toBe(null);
    state().arm(true);
    const claimed = await state().confirmEvmStake();
    const claimRow = rowFor(claimed.txid);
    expect(claimRow!.staking).toEqual({ kind: 'claim', validator: VALOPER });
    expect(claimRow!.staking!.amountBase).toBeUndefined();
    expect(claimRow!.feeEvr).toBe(Number(claim!.quote.estimatedTotal) / 1e18);
  });
});
