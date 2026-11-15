// Read-only check of the pinned Uniswap v3 deployments (src/services/chain/evm/
// uniswapV3.ts) against the chains themselves. Signs nothing, sends nothing.
//
//   npx vite-node scripts/uniswap-probe.ts            every pinned chain
//   npx vite-node scripts/uniswap-probe.ts base       one chain
//
// For each chain: code exists at every pinned address (Multicall3 included, and
// a wallet-built packed read decodes), the router and the
// quoter name the pinned factory, the router names the pinned wrapped coin, a
// wallet-built quote decodes, and a wallet-built coin-in swap simulates
// (eth_call from the wrapped-coin contract, which always holds coin), with and
// without the wallet fee.
//
// RPC: UNISWAP_PROBE_RPC_<CHAINKEY> overrides the public default below.

import {
  UNISWAP_V3,
  UNISWAP_V3_SELECTORS,
  UNISWAP_V3_FEES,
  MULTICALL3,
  encodeAggregate3,
  decodeAggregate3,
  encodeQuoteExactInput,
  decodeQuoteAmountOut,
  encodeSwap,
  minimumOut,
  afterSwapFee,
  encodeMulticall,
  encodeSelfPermitIfNecessary,
  permitDomainSeparator,
  permitTypedData,
  splitPermitSignature,
  type SwapHop,
} from '../src/services/chain/evm/uniswapV3';
import { bytesToHex } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { publicKeyToEvmAddress } from '../src/services/chain/evm/keys';
import { decodeString, decodeUint256, encodeName } from '../src/services/chain/evm/erc20';
import { signTypedData } from '../src/services/chain/evm/typedData';
import { evmChainByKey } from '../src/services/chain/evm/chains';

/** Stands in for a fee recipient in simulations. Nothing is ever sent. */
const FEE_PROBE_ADDRESS = '0x00000000000000000000000000000000000000fe';

/** A key made for this run and thrown away. It holds nothing; it only signs
 *  permits that are simulated and never sent. Fresh on purpose: a well-known
 *  test key can carry an EIP-7702 delegation on some chains, and a token such
 *  as USDC then treats it as a contract wallet and refuses its signature. */
const PROBE_KEY = secp256k1.utils.randomPrivateKey();
const PROBE_OWNER = publicKeyToEvmAddress(secp256k1.getPublicKey(PROBE_KEY, false));
/** Tokens whose permit the wallet is expected to use, beyond each chain's dollar token. */
const PERMIT_TOKENS: Record<string, Record<string, string>> = {
  base: { SATORI: '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17' },
};

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

  // Multicall3: code at the pinned address, and a wallet-built aggregate of
  // the four tier quotes plus one pool that cannot exist answers in one call,
  // the missing pool failing alone.
  const multicallCode = (await rpc(url, 'eth_getCode', [MULTICALL3, 'latest'])).result ?? '0x';
  check('code at multicall3', multicallCode.length > 2, `${(multicallCode.length - 2) / 2} bytes`);
  const reads = [
    ...UNISWAP_V3_FEES.map((fee) => ({ to: d.quoterV2, data: encodeQuoteExactInput([{ tokenIn: d.wrappedNative, tokenOut: d.stable, fee }], 10n ** 15n) })),
    { to: d.quoterV2, data: encodeQuoteExactInput([{ tokenIn: d.wrappedNative, tokenOut: FEE_PROBE_ADDRESS, fee: 3000 }], 10n ** 15n) },
  ];
  const packed = await call(MULTICALL3, encodeAggregate3(reads));
  let together: Array<string | null> | null = null;
  try {
    together = decodeAggregate3(packed.result, reads.length);
  } catch {
    together = null;
  }
  check(
    'multicall3 packs the quotes, a missing pool fails alone',
    together !== null && together[reads.length - 1] === null && together.slice(0, -1).some((answer) => answer !== null && decodeQuoteAmountOut(answer) > 0n),
    packed.error?.message ?? '',
  );

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
    // The same swap with the wallet fee switched on: the router pays itself, then
    // sweeps to the recipient and the fee address. The fee is off in the wallet
    // (evmSwap.ts); this proves the path is there for the day it is not.
    for (const bips of [25, 100]) {
      const withFee = encodeSwap({
        deployment: d,
        hops: best.hops,
        recipient: d.wrappedNative,
        amountIn,
        amountOutMinimum: minimumOut(afterSwapFee(best.out, bips), 100),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
        nativeOut: false,
        fee: { bips, recipient: FEE_PROBE_ADDRESS },
      });
      const feeSim = await call(d.swapRouter02, `0x${bytesToHex(withFee)}`, { from: d.wrappedNative, value: `0x${amountIn.toString(16)}` });
      check(`simulate coin-in swap with a ${bips / 100}% fee`, typeof feeSim.result === 'string', feeSim.error?.message ?? '');
    }
  }
  // Permit: the wallet's own detection (the version whose domain hash equals
  // the token's DOMAIN_SEPARATOR), then a permit signed by the probe key and
  // presented to the REAL token through the router, simulated. It needs no
  // balance, so it proves the signature is one the token accepts.
  const chainId = evmChainByKey(key)?.chainId ?? 0;
  for (const [symbol, token] of Object.entries({ ...(PERMIT_TOKENS[key] ?? {}), stable: d.stable })) {
    const name = await call(token, encodeName());
    const separator = (await call(token, UNISWAP_V3_SELECTORS.DOMAIN_SEPARATOR)).result?.toLowerCase();
    const nonce = await call(token, UNISWAP_V3_SELECTORS.nonces + PROBE_OWNER.slice(2).toLowerCase().padStart(64, '0'));
    let version: string | undefined;
    let tokenName = '';
    try {
      tokenName = decodeString(name.result ?? '');
      version = ['1', '2'].find((v) => permitDomainSeparator(tokenName, v, chainId, token) === separator);
    } catch {
      version = undefined;
    }
    if (!version || !nonce.result) {
      console.log(`  info permit ${symbol}: none the wallet can use (it will ask for an approval instead)`);
      continue;
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    const data = permitTypedData({
      name: tokenName,
      version,
      chainId,
      token,
      owner: PROBE_OWNER,
      spender: d.swapRouter02,
      value: 1_000_000n,
      nonce: decodeUint256(nonce.result),
      deadline,
    });
    const permit = { token, value: 1_000_000n, deadline, ...splitPermitSignature(signTypedData(data, PROBE_KEY)) };
    const sim = await call(d.swapRouter02, `0x${bytesToHex(encodeMulticall(deadline, [encodeSelfPermitIfNecessary(permit)]))}`, { from: PROBE_OWNER });
    check(`permit ${symbol} ("${tokenName}" v${version}) accepted by the token through the router`, typeof sim.result === 'string', sim.error?.message ?? '');
    const forged = { ...permit, value: 1_000_001n };
    const bad = await call(d.swapRouter02, `0x${bytesToHex(encodeMulticall(deadline, [encodeSelfPermitIfNecessary(forged)]))}`, { from: PROBE_OWNER });
    check(`permit ${symbol} for another amount is refused`, typeof bad.result !== 'string');
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
