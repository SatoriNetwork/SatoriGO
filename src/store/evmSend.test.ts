// evmSend.ts end to end THROUGH THE REAL EVM MODULES against a fake Base node:
// build a plan (fees at every level with the L1 surcharge, caps, balances),
// then broadcast it (gate, caps, nonce, sign, eth_sendRawTransaction, nonce
// bookkeeping). No network; the engine's flag-guarded import is mocked to
// return the barrel.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const hoisted = vi.hoisted(() => ({ evmEnabled: true }));

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => (hoisted.evmEnabled ? await import('../services/chain/evm') : null),
  };
});

import { broadcastEvmPlan, buildEvmSendPlan, withEvmFeeLevel, resolveEvmSendAsset } from './evmSend';
import { EvmWalletDataProvider, createEvmRpcClient, evmChainByKey, signTx, decodeSignedTx, EvmNonceTracker, encodeTransfer, toHexData } from '../services/chain/evm';
import type { EvmChainInfo } from './evmChains';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';

const FROM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const FROM_KEY = hexToBytes('1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727');
const TO = '0x3535353535353535353535353535353535353535';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ORACLE = '0x420000000000000000000000000000000000000f';

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
  indexer: null,
  alchemy: false,
  trustWalletChain: null,
  tokenListSlug: null,
  defaultTokens: [{ address: USDC, symbol: 'USDC', decimals: 6 }],
};

const ASSETS: LiveAssetBalance[] = [
  { name: 'ETH', amountBase: 10n ** 16n, scale: 18, decimals: 18, isNative: true }, // 0.01 ETH
  { name: 'USDC', amountBase: 5_000_000n, scale: 6, decimals: 6, isNative: false }, // 5 USDC
];

const word = (hex: string) => hex.padStart(64, '0');

interface Req { id: number; method: string; params: unknown[] }

/** A scripted Base node: chain id, fee market, gas estimate, L1 oracle, nonce
 *  and broadcast, all by METHOD; every request is recorded. */
function fakeBase(opts: { pending?: () => bigint; estimateReverts?: boolean; sendRejects?: boolean; gasPriceWei?: bigint } = {}) {
  const seen: Req[] = [];
  const baseFee = '0x4c4b40'; // 5,000,000 wei
  const answer = (req: Req): Record<string, unknown> => {
    seen.push(req);
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
    const err = (message: string, code = 3) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
    switch (req.method) {
      case 'eth_chainId':
        return ok('0x2105');
      case 'eth_estimateGas':
        return opts.estimateReverts ? err('execution reverted: ERC20: transfer amount exceeds balance') : ok('0x5208');
      case 'eth_feeHistory':
        return ok({
          baseFeePerGas: [baseFee, baseFee, baseFee, baseFee, baseFee, baseFee],
          reward: Array.from({ length: 5 }, () => ['0xf4240', '0x10c8e0', '0x2dc6c0']),
        });
      case 'eth_gasPrice':
        return ok('0x' + (opts.gasPriceWei ?? 6_000_000n).toString(16));
      case 'eth_call': {
        const call = req.params[0] as { to: string; data: string };
        if (call.to.toLowerCase() === ORACLE) return ok('0x' + word('2f0d')); // 12045 wei L1 fee
        return err('execution reverted');
      }
      case 'eth_getTransactionCount':
        return ok('0x' + (opts.pending ? opts.pending() : 7n).toString(16));
      case 'eth_sendRawTransaction': {
        if (opts.sendRejects) return err('nonce too low', -32000);
        const raw = hexToBytes((req.params[0] as string).slice(2));
        return ok('0x' + bytesToHex(keccak_256(raw)));
      }
      default:
        return err('method not found', -32601);
    }
  };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Req | Req[];
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const provider = new EvmWalletDataProvider(createEvmRpcClient(evmChainByKey('base')!, { fetchImpl }));
  return { provider, seen };
}

const sign = (request: Parameters<typeof signTx>[0]) => signTx(request, FROM_KEY);

beforeEach(() => {
  hoisted.evmEnabled = true;
});

describe('buildEvmSendPlan', () => {
  it('1. native ETH on Base: three priced levels, the L1 surcharge, an unsigned {to,value,data,gas} and no shortfall', async () => {
    const { provider, seen } = fakeBase();
    const plan = await buildEvmSendPlan({
      provider,
      chain: BASE,
      from: FROM,
      assets: ASSETS,
      input: { to: TO.toLowerCase(), amountText: '0.001', assetId: 'ETH' },
    });
    expect(plan.to).toBe(TO);
    expect(plan.asset).toEqual({ kind: 'native', ticker: 'ETH', decimals: 18 });
    expect(plan.amountBase).toBe(10n ** 15n);
    expect(plan.level).toBe('normal');
    expect(plan.quote.l1DataFee).toBe(12045n);
    expect(plan.quote.gasLimit).toBe(25200n);
    expect(plan.quote.fee).toEqual({ type: 'eip1559', maxFeePerGas: 11_100_000n, maxPriorityFeePerGas: 1_100_000n });
    expect(plan.quote.maxTotal).toBe(25200n * 11_100_000n + 12045n);
    expect(plan.quotes.slow.fee).toMatchObject({ maxPriorityFeePerGas: 1_000_000n });
    expect(plan.quotes.fast.fee).toMatchObject({ maxPriorityFeePerGas: 3_000_000n });
    expect(plan.unsigned).toEqual({
      chainId: 8453,
      to: TO,
      value: 10n ** 15n,
      data: new Uint8Array(),
      gasLimit: 25200n,
      fee: plan.quote.fee,
    });
    expect(plan.shortfall).toBe(null);
    expect(plan.capRefusal).toBe(null);
    // The gas estimate was asked for THIS transaction.
    const est = seen.find((r) => r.method === 'eth_estimateGas')!.params[0] as Record<string, string>;
    expect(est.from.toLowerCase()).toBe(FROM.toLowerCase());
    expect(est.to.toLowerCase()).toBe(TO.toLowerCase());
    expect(est.value).toBe('0x38d7ea4c68000');
  });

  it('2. USDC on Base: a zero-value call to the contract carrying transfer(to, amount) calldata', async () => {
    const { provider } = fakeBase();
    const plan = await buildEvmSendPlan({
      provider,
      chain: BASE,
      from: FROM,
      assets: ASSETS,
      input: { to: TO, amountText: '1.5', assetId: USDC, level: 'fast' },
    });
    expect(plan.asset).toEqual({ kind: 'token', address: USDC, symbol: 'USDC', decimals: 6 });
    expect(plan.amountBase).toBe(1_500_000n);
    expect(plan.unsigned.to).toBe(USDC);
    expect(plan.unsigned.value).toBe(0n);
    expect(toHexData(plan.unsigned.data)).toBe(toHexData(encodeTransfer(TO, 1_500_000n)));
    expect(plan.level).toBe('fast');
    expect(plan.shortfall).toBe(null);
  });

  it('3. shortfalls: amount + max fee above the native balance; token amount above the token balance; no gas for a token', async () => {
    const { provider } = fakeBase();
    const tooMuch = await buildEvmSendPlan({ provider, chain: BASE, from: FROM, assets: ASSETS, input: { to: TO, amountText: '0.01', assetId: 'ETH' } });
    expect(tooMuch.shortfall).toMatch(/Not enough ETH/);
    const tooManyTokens = await buildEvmSendPlan({ provider, chain: BASE, from: FROM, assets: ASSETS, input: { to: TO, amountText: '6', assetId: USDC } });
    expect(tooManyTokens.shortfall).toMatch(/Not enough USDC/);
    const noGas = await buildEvmSendPlan({
      provider,
      chain: BASE,
      from: FROM,
      assets: [{ ...ASSETS[0], amountBase: 0n }, ASSETS[1]],
      input: { to: TO, amountText: '1', assetId: USDC },
    });
    expect(noGas.shortfall).toMatch(/Not enough ETH to pay the network fee/);
  });

  it('4. refusals before any node call: bad address, unknown asset, bad amount', async () => {
    const { provider, seen } = fakeBase();
    const base = { provider, chain: BASE, from: FROM, assets: ASSETS };
    await expect(buildEvmSendPlan({ ...base, input: { to: '0x1234', amountText: '1', assetId: 'ETH' } })).rejects.toMatchObject({ code: 'invalid-address' });
    // Wrong-checksum mixed case is a typo, not an address.
    await expect(buildEvmSendPlan({ ...base, input: { to: '0x9858EfFD232B4033E47d90003D41EC34EcaEda9A', amountText: '1', assetId: 'ETH' } })).rejects.toMatchObject({ code: 'invalid-address' });
    await expect(buildEvmSendPlan({ ...base, input: { to: TO, amountText: '1', assetId: 'DOGE' } })).rejects.toMatchObject({ code: 'unknown-asset' });
    await expect(buildEvmSendPlan({ ...base, input: { to: TO, amountText: '0', assetId: 'ETH' } })).rejects.toMatchObject({ code: 'invalid-amount' });
    await expect(buildEvmSendPlan({ ...base, input: { to: TO, amountText: 'abc', assetId: 'ETH' } })).rejects.toMatchObject({ code: 'invalid-amount' });
    expect(seen.filter((r) => r.method !== 'eth_chainId')).toHaveLength(0);
  });

  it('5. a reverting estimate becomes quote-failed with the node message; no engine becomes no-engine', async () => {
    const { provider } = fakeBase({ estimateReverts: true });
    await expect(
      buildEvmSendPlan({ provider, chain: BASE, from: FROM, assets: ASSETS, input: { to: TO, amountText: '1', assetId: USDC } }),
    ).rejects.toMatchObject({ code: 'quote-failed', message: expect.stringMatching(/exceeds balance/) });
    hoisted.evmEnabled = false;
    await expect(
      buildEvmSendPlan({ provider, chain: BASE, from: FROM, assets: ASSETS, input: { to: TO, amountText: '1', assetId: 'ETH' } }),
    ).rejects.toMatchObject({ code: 'no-engine' });
  });

  it('6. withEvmFeeLevel re-prices without a new quote', async () => {
    const { provider, seen } = fakeBase();
    const plan = await buildEvmSendPlan({ provider, chain: BASE, from: FROM, assets: ASSETS, input: { to: TO, amountText: '0.001', assetId: 'ETH' } });
    const before = seen.length;
    const fast = await withEvmFeeLevel(plan, 'fast', BASE, ASSETS);
    expect(fast.level).toBe('fast');
    expect(fast.quote).toBe(plan.quotes.fast);
    expect(fast.unsigned.fee).toEqual(plan.quotes.fast.fee);
    expect(seen.length).toBe(before);
  });

  it('7. resolveEvmSendAsset: native by ticker (any case), token by contract (defaults AND tracked/discovered), unknown otherwise', () => {
    const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
    expect(resolveEvmSendAsset(BASE, 'eth', ASSETS, isAddr)).toEqual({ kind: 'native', ticker: 'ETH', decimals: 18 });
    expect(resolveEvmSendAsset(BASE, USDC, ASSETS, isAddr)).toEqual({ kind: 'token', address: USDC, symbol: 'USDC', decimals: 6 });
    expect(resolveEvmSendAsset(BASE, 'USDC', ASSETS, isAddr)).toBe(null); // symbols never identify a token
    expect(resolveEvmSendAsset(BASE, TO, ASSETS, isAddr)).toBe(null); // an untracked contract cannot be scaled
    // An imported / added token (owner's report: "Unknown asset on BNB Chain: MNEB").
    const MNEB = '0x4444444444444444444444444444444444444444';
    expect(resolveEvmSendAsset(BASE, MNEB, ASSETS, isAddr, [{ address: MNEB, symbol: 'MNEB', decimals: 9 }])).toEqual({
      kind: 'token',
      address: MNEB,
      symbol: 'MNEB',
      decimals: 9,
    });
  });

  it('7b. buildEvmSendPlan sends an imported token by contract with the tracked decimals', async () => {
    const { provider } = fakeBase();
    const MNEB = '0x4444444444444444444444444444444444444444';
    const plan = await buildEvmSendPlan({
      provider,
      chain: BASE,
      from: FROM,
      assets: [...ASSETS, { name: 'MNEB', amountBase: 10n ** 12n, scale: 9, decimals: 9, isNative: false }],
      input: { to: TO, amountText: '2.5', assetId: MNEB },
      extraTokens: [{ address: MNEB, symbol: 'MNEB', decimals: 9 }],
    });
    expect(plan.asset).toEqual({ kind: 'token', address: MNEB, symbol: 'MNEB', decimals: 9 });
    expect(plan.amountBase).toBe(2_500_000_000n);
    expect(plan.unsigned.to).toBe(MNEB);
    expect(plan.unsigned.value).toBe(0n);
    expect(toHexData(plan.unsigned.data)).toBe(toHexData(encodeTransfer(TO, 2_500_000_000n)));
    expect(plan.shortfall).toBe(null);
  });
});

describe('broadcastEvmPlan', () => {
  async function planFor(provider: EvmWalletDataProvider) {
    return buildEvmSendPlan({ provider, chain: BASE, from: FROM, assets: ASSETS, input: { to: TO, amountText: '0.001', assetId: 'ETH' } });
  }

  it('8. the gate: not armed => refused, no nonce read, nothing sent', async () => {
    const { provider, seen } = fakeBase();
    const plan = await planFor(provider);
    const nonces = new EvmNonceTracker();
    await expect(broadcastEvmPlan({ provider, plan, nonces, sign, allowBroadcast: false })).rejects.toMatchObject({ code: 'gated' });
    expect(seen.some((r) => r.method === 'eth_getTransactionCount' || r.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('9. armed: nonce reserved from the node, signed by the account, broadcast; the raw decodes to the plan; the nonce advances locally', async () => {
    const { provider, seen } = fakeBase({ pending: () => 7n });
    const plan = await planFor(provider);
    const nonces = new EvmNonceTracker();
    const result = await broadcastEvmPlan({ provider, plan, nonces, sign, allowBroadcast: true });
    expect(result.nonce).toBe(7n);
    const sent = seen.find((r) => r.method === 'eth_sendRawTransaction')!;
    expect(sent.params[0]).toBe(result.rawHex);
    const decoded = decodeSignedTx(result.rawHex);
    expect(decoded.tx).toEqual({ ...plan.unsigned, nonce: 7n });
    expect(result.txid).toBe(decoded.hash);
    // A second send while the node still says 7 gets 8: the tracker remembers.
    const again = await broadcastEvmPlan({ provider, plan: await planFor(provider), nonces, sign, allowBroadcast: true });
    expect(again.nonce).toBe(8n);
    expect(nonces.outstanding(8453, FROM)).toEqual([]);
  });

  it('10. a node that rejects the broadcast: broadcast-failed, and the nonce is released for reuse', async () => {
    const { provider } = fakeBase({ sendRejects: true });
    const plan = await planFor(provider);
    const nonces = new EvmNonceTracker();
    await expect(broadcastEvmPlan({ provider, plan, nonces, sign, allowBroadcast: true })).rejects.toMatchObject({
      code: 'broadcast-failed',
      message: expect.stringMatching(/rejected the transaction/),
    });
    expect(nonces.outstanding(8453, FROM)).toEqual([]);
    const ok = fakeBase();
    const next = await broadcastEvmPlan({ provider: ok.provider, plan: await planFor(ok.provider), nonces, sign, allowBroadcast: true });
    expect(next.nonce).toBe(7n);
  });

  it('11. a shortfall plan is refused before any node call; a poisoned fee is refused by the caps at signing time', async () => {
    const { provider, seen } = fakeBase();
    const plan = await planFor(provider);
    const nonces = new EvmNonceTracker();
    const before = seen.length;
    await expect(
      broadcastEvmPlan({ provider, plan: { ...plan, shortfall: 'Not enough ETH' }, nonces, sign, allowBroadcast: true }),
    ).rejects.toMatchObject({ code: 'insufficient' });
    // Tampered plan: 100 gwei max fee, over Base's 50 gwei ceiling.
    const poisoned = {
      ...plan,
      unsigned: { ...plan.unsigned, fee: { type: 'eip1559' as const, maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1n } },
      quote: { ...plan.quote, maxTotal: 25200n * 100_000_000_000n },
    };
    await expect(broadcastEvmPlan({ provider, plan: poisoned, nonces, sign, allowBroadcast: true })).rejects.toThrow(/Refusing to sign/);
    expect(seen.length).toBe(before);
    expect(nonces.outstanding(8453, FROM)).toEqual([]);
  });

  it('12. a signer that produces a different transaction than the plan is caught before broadcast', async () => {
    const { provider, seen } = fakeBase();
    const plan = await planFor(provider);
    const nonces = new EvmNonceTracker();
    const wrongSigner = (request: Parameters<typeof signTx>[0]) => signTx({ ...request, value: request.value + 1n }, FROM_KEY);
    await expect(broadcastEvmPlan({ provider, plan, nonces, sign: wrongSigner, allowBroadcast: true })).rejects.toMatchObject({
      code: 'broadcast-failed',
      message: expect.stringMatching(/does not match the confirmed plan/),
    });
    expect(seen.some((r) => r.method === 'eth_sendRawTransaction')).toBe(false);
    expect(nonces.outstanding(8453, FROM)).toEqual([]);
  });
});
