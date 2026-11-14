// Read-only check of the pinned Uniswap v3 deployments (src/services/chain/evm/
// uniswapV3.ts) against the chains themselves. Signs nothing, sends nothing.
//
//   npx vite-node scripts/uniswap-probe.ts            every pinned chain
//   npx vite-node scripts/uniswap-probe.ts base       one chain
//
// For each chain: code exists at every pinned address, the router and the
// quoter name the pinned factory, the router names the pinned wrapped coin, a
// wallet-built quote decodes, and a wallet-built coin-in swap simulates
// (eth_call from the wrapped-coin contract, which always holds coin).
//
// RPC: UNISWAP_PROBE_RPC_<CHAINKEY> overrides the public default below.

import {
  UNISWAP_V3,
  UNISWAP_V3_SELECTORS,
  UNISWAP_V3_FEES,
  encodeQuoteExactInput,
  decodeQuoteAmountOut,
  encodeSwap,
  minimumOut,
  type SwapHop,
} from '../src/services/chain/evm/uniswapV3';
import { bytesToHex } from '@noble/hashes/utils';

const DEFAULT_RPC: Record<string, string> = {
  base: 'https://mainnet.base.org',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  bsc: 'https://bsc-rpc.publicnode.com',
  avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
};

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: string; error?: { message: string } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as { result?: string; error?: { message: string } };
}

const same = (word: string | undefined, address: string) => (word ?? '').slice(-40).toLowerCase() === address.slice(2).toLowerCase();

async function checkChain(key: string): Promise<boolean> {
  const d = UNISWAP_V3[key];
  const url = process.env[`UNISWAP_PROBE_RPC_${key.toUpperCase()}`] ?? DEFAULT_RPC[key];
  if (!url) {
    console.log(`${key}: no RPC url, set UNISWAP_PROBE_RPC_${key.toUpperCase()}`);
    return false;
  }
  let ok = true;
  const check = (label: string, pass: boolean, detail = '') => {
    if (!pass) ok = false;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  };
  console.log(`${key} (${url})`);
  for (const [name, address] of Object.entries(d)) {
    const code = (await rpc(url, 'eth_getCode', [address, 'latest'])).result ?? '0x';
    check(`code at ${name}`, code.length > 2, `${(code.length - 2) / 2} bytes`);
  }
  const call = (to: string, data: string, extra: object = {}) => rpc(url, 'eth_call', [{ to, data, ...extra }, 'latest']);
  check('router.factory()', same((await call(d.swapRouter02, UNISWAP_V3_SELECTORS.factory)).result, d.factory));
  check('quoter.factory()', same((await call(d.quoterV2, UNISWAP_V3_SELECTORS.factory)).result, d.factory));
  check('router.WETH9()', same((await call(d.swapRouter02, UNISWAP_V3_SELECTORS.WETH9)).result, d.wrappedNative));

  // Best coin -> dollar-token tier, by a wallet-built quote.
  const amountIn = 10n ** 15n;
  let best: { hops: SwapHop[]; out: bigint } | null = null;
  for (const fee of UNISWAP_V3_FEES) {
    const hops = [{ tokenIn: d.wrappedNative, tokenOut: d.stable, fee }];
    const answer = await call(d.quoterV2, encodeQuoteExactInput(hops, amountIn));
    if (!answer.result) continue;
    const out = decodeQuoteAmountOut(answer.result);
    if (!best || out > best.out) best = { hops, out };
  }
  check('quote 0.001 coin -> stable', best !== null && best.out > 0n, best ? `${best.out} base units at fee ${best.hops[0].fee}` : 'no pool answered');
  if (best) {
    const data = encodeSwap({
      deployment: d,
      hops: best.hops,
      recipient: d.wrappedNative,
      amountIn,
      amountOutMinimum: minimumOut(best.out, 100),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
      nativeOut: false,
    });
    const sim = await call(d.swapRouter02, `0x${bytesToHex(data)}`, { from: d.wrappedNative, value: `0x${amountIn.toString(16)}` });
    check('simulate coin-in swap', typeof sim.result === 'string', sim.error?.message ?? '');
  }
  return ok;
}

const wanted = process.argv.slice(2);
const keys = wanted.length > 0 ? wanted : Object.keys(UNISWAP_V3);
let allOk = true;
for (const key of keys) {
  if (!UNISWAP_V3[key]) {
    console.log(`${key}: not pinned`);
    allOk = false;
    continue;
  }
  if (!(await checkChain(key))) allOk = false;
}
process.exit(allOk ? 0 : 1);
