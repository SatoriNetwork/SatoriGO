// Uniswap v3 for the in-wallet swap: pinned contracts, calldata, return data,
// and the price arithmetic. Pure. Nothing here fetches and nothing here signs;
// src/store/evmSwap.ts does the reading and planning.
//
// PINNED, like the Satori reward contracts (satoriRewards.ts): the wallet
// composes every byte of a swap itself and only ever calls the addresses in
// UNISWAP_V3 below. No routing API is involved, so no server can hand the
// wallet a contract or calldata to sign. A chain with no entry has no swap.
//
// One shape for every swap: a PATH (token, fee, token[, fee, token]) quoted by
// QuoterV2.quoteExactInput and executed by SwapRouter02.exactInput, wrapped in
// multicall(deadline, ...). A single hop is just the shortest path, so there is
// no second code path for it.
//
// The chain's own coin is swapped as its wrapped token: the router wraps the
// value attached to the call, and unwrapWETH9 turns the output back into coin.

import { hexToBytes } from '@noble/hashes/utils';
import { isEvmAddress, normalizeEvmAddress } from './keys';

export interface UniswapV3Deployment {
  factory: string;
  quoterV2: string;
  swapRouter02: string;
  /** The wrapped form of the chain's own coin (WETH, WBNB, WAVAX). */
  wrappedNative: string;
  /** The chain's main dollar token (USDC, or USDT on BNB Chain), the second
   *  routing intermediate. */
  stable: string;
}

/** Keyed by the wallet's chain key (chains.ts). Every entry is checked against
 *  the chain itself by scripts/uniswap-probe.ts: code at each address,
 *  and the router's own factory() and WETH9() equal to the pins. */
export const UNISWAP_V3: Readonly<Record<string, UniswapV3Deployment>> = Object.freeze({
  base: Object.freeze({
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    stable: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  }),
  ethereum: Object.freeze({
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    stable: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  }),
  bsc: Object.freeze({
    factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
    quoterV2: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    swapRouter02: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
    wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    stable: '0x55d398326f99059fF775485246999027B3197955', // USDT, the deep dollar token there
  }),
  avalanche: Object.freeze({
    factory: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
    quoterV2: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    swapRouter02: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
    wrappedNative: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    stable: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  }),
});

export function uniswapV3For(chainKey: string): UniswapV3Deployment | null {
  return Object.prototype.hasOwnProperty.call(UNISWAP_V3, chainKey) ? UNISWAP_V3[chainKey] : null;
}

/** Every fee tier a v3 pool can have, in hundredths of a basis point. */
export const UNISWAP_V3_FEES: readonly number[] = Object.freeze([100, 500, 3000, 10000]);

/** Pinned, and proven against selector(<signature>) in uniswapV3.test.ts. */
export const UNISWAP_V3_SELECTORS = Object.freeze({
  getPool: '0x1698ee82', // getPool(address,address,uint24), on the factory
  slot0: '0x3850c7bd', // slot0(), on a pool
  quoteExactInput: '0xcdca1753', // quoteExactInput(bytes,uint256), on QuoterV2
  exactInput: '0xb858183f', // exactInput((bytes,address,uint256,uint256))
  multicall: '0x5ae401dc', // multicall(uint256,bytes[])
  unwrapWETH9: '0x49404b7c', // unwrapWETH9(uint256,address)
  factory: '0xc45a0155', // factory(), on the router and the quoter
  WETH9: '0x4aa4a4fc', // WETH9(), on the router
});

/** One pool crossed by a swap. */
export interface SwapHop {
  tokenIn: string;
  tokenOut: string;
  fee: number;
}

const WORD_HEX = 64;
const Q192 = 1n << 192n;
const FEE_DENOMINATOR = 1_000_000n;

function uintWord(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new Error('uniswapV3: value does not fit uint256');
  return value.toString(16).padStart(WORD_HEX, '0');
}

function addressHex(value: string, label: string): string {
  if (!isEvmAddress(value)) throw new Error(`uniswapV3: ${label} is not an address`);
  return value.slice(2).toLowerCase();
}

function addressWord(value: string, label: string): string {
  return addressHex(value, label).padStart(WORD_HEX, '0');
}

/** ABI `bytes`: a length word, then the bytes right-padded to a whole word. */
function bytesTail(hex: string): string {
  const length = hex.length / 2;
  return uintWord(BigInt(length)) + hex.padEnd(Math.ceil(length / 32) * WORD_HEX, '0');
}

function strip(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function words(returnData: unknown, atLeast: number, label: string): string {
  if (typeof returnData !== 'string' || !/^0x[0-9a-fA-F]*$/.test(returnData)) {
    throw new Error(`uniswapV3: ${label} is not hex`);
  }
  const body = returnData.slice(2);
  if (body.length < atLeast * WORD_HEX) throw new Error(`uniswapV3: ${label} is too short`);
  return body;
}

/** The packed path the quoter and the router both read: 20-byte token, 3-byte
 *  fee, 20-byte token, and so on. Hops must chain (each tokenOut is the next
 *  tokenIn); one or two hops only, which is every route this wallet builds. */
export function encodeSwapPath(hops: readonly SwapHop[]): string {
  if (hops.length < 1 || hops.length > 2) throw new Error('uniswapV3: a path is one or two hops');
  let path = addressHex(hops[0].tokenIn, 'tokenIn');
  hops.forEach((hop, i) => {
    if (!UNISWAP_V3_FEES.includes(hop.fee)) throw new Error('uniswapV3: unknown fee tier');
    if (i > 0 && hop.tokenIn.toLowerCase() !== hops[i - 1].tokenOut.toLowerCase()) {
      throw new Error('uniswapV3: hops do not chain');
    }
    if (hop.tokenIn.toLowerCase() === hop.tokenOut.toLowerCase()) throw new Error('uniswapV3: a hop needs two tokens');
    path += hop.fee.toString(16).padStart(6, '0') + addressHex(hop.tokenOut, 'tokenOut');
  });
  return path;
}

/** eth_call data for factory.getPool(a, b, fee). */
export function encodeGetPool(tokenA: string, tokenB: string, fee: number): string {
  return UNISWAP_V3_SELECTORS.getPool + addressWord(tokenA, 'tokenA') + addressWord(tokenB, 'tokenB') + uintWord(BigInt(fee));
}

/** The pool address, or null for the zero address ("no such pool"). */
export function decodePoolAddress(returnData: unknown): string | null {
  const body = words(returnData, 1, 'getPool result');
  if (body.length !== WORD_HEX || !/^0{24}/.test(body)) throw new Error('uniswapV3: getPool result is not an address');
  const address = body.slice(24);
  return /^0{40}$/.test(address) ? null : normalizeEvmAddress(`0x${address}`);
}

/** eth_call data for pool.slot0(). */
export function encodeSlot0(): string {
  return UNISWAP_V3_SELECTORS.slot0;
}

/** slot0's first word: the pool's current sqrt price, Q64.96. */
export function decodeSqrtPriceX96(returnData: unknown): bigint {
  const price = BigInt(`0x${words(returnData, 1, 'slot0 result').slice(0, WORD_HEX)}`);
  if (price <= 0n || price >= 1n << 160n) throw new Error('uniswapV3: slot0 price is out of range');
  return price;
}

/** eth_call data for QuoterV2.quoteExactInput(path, amountIn). */
export function encodeQuoteExactInput(hops: readonly SwapHop[], amountIn: bigint): string {
  return UNISWAP_V3_SELECTORS.quoteExactInput + uintWord(64n) + uintWord(amountIn) + bytesTail(encodeSwapPath(hops));
}

/** The quote's first word, amountOut. The rest (prices after, ticks crossed,
 *  a gas guess) is not used: the fee comes from the wallet's own estimate. */
export function decodeQuoteAmountOut(returnData: unknown): bigint {
  return BigInt(`0x${words(returnData, 1, 'quote result').slice(0, WORD_HEX)}`);
}

/** Inner call: exactInput({path, recipient, amountIn, amountOutMinimum}). */
export function encodeExactInput(args: {
  hops: readonly SwapHop[];
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): string {
  return (
    UNISWAP_V3_SELECTORS.exactInput +
    uintWord(32n) + // the struct is dynamic: one offset to it
    uintWord(128n) + // inside it, the path sits after the four head words
    addressWord(args.recipient, 'recipient') +
    uintWord(args.amountIn) +
    uintWord(args.amountOutMinimum) +
    bytesTail(encodeSwapPath(args.hops))
  );
}

/** Inner call: unwrapWETH9(amountMinimum, recipient). */
export function encodeUnwrapWETH9(amountMinimum: bigint, recipient: string): string {
  return UNISWAP_V3_SELECTORS.unwrapWETH9 + uintWord(amountMinimum) + addressWord(recipient, 'recipient');
}

/** The transaction data: multicall(deadline, calls). The router reverts the
 *  whole thing once `deadline` (unix seconds) has passed. */
export function encodeMulticall(deadline: bigint, calls: readonly string[]): Uint8Array {
  if (calls.length === 0) throw new Error('uniswapV3: multicall needs a call');
  const tails = calls.map((call) => bytesTail(strip(call)));
  let offset = BigInt(calls.length * 32);
  let heads = '';
  for (const tail of tails) {
    heads += uintWord(offset);
    offset += BigInt(tail.length / 2);
  }
  return hexToBytes(
    strip(UNISWAP_V3_SELECTORS.multicall) + uintWord(deadline) + uintWord(64n) + uintWord(BigInt(calls.length)) + heads + tails.join(''),
  );
}

/**
 * The whole swap transaction for a route.
 *
 * `recipient` is always the user's own address. When the output is the chain's
 * coin the swap pays the ROUTER in wrapped coin and unwrapWETH9 forwards it,
 * with the same minimum, so the minimum holds for what the user receives.
 * When the input is the chain's coin the caller attaches `amountIn` as value.
 */
export function encodeSwap(args: {
  deployment: UniswapV3Deployment;
  hops: readonly SwapHop[];
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  nativeOut: boolean;
}): Uint8Array {
  const { deployment, hops, recipient, amountIn, amountOutMinimum, deadline, nativeOut } = args;
  if (amountIn <= 0n) throw new Error('uniswapV3: amountIn must be positive');
  if (amountOutMinimum <= 0n) throw new Error('uniswapV3: a swap needs a minimum output');
  const last = hops[hops.length - 1];
  if (nativeOut && last?.tokenOut.toLowerCase() !== deployment.wrappedNative.toLowerCase()) {
    throw new Error('uniswapV3: a swap to the coin must end in its wrapped token');
  }
  const swap = encodeExactInput({
    hops,
    recipient: nativeOut ? deployment.swapRouter02 : recipient,
    amountIn,
    amountOutMinimum,
  });
  return encodeMulticall(deadline, nativeOut ? [swap, encodeUnwrapWETH9(amountOutMinimum, recipient)] : [swap]);
}

/** `amountOut` less `slippageBps` hundredths of a percent, rounded down. */
export function minimumOut(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('uniswapV3: slippage is out of range');
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * What `amountIn` would fetch across `hops` at each pool's CURRENT price, pool
 * fees taken off, as if the trade moved nothing. The gap between this and the
 * real quote is the price impact.
 *
 * A pool prices token1 per token0 (token0 is the lower address) as
 * sqrtPriceX96^2 / 2^192.
 */
export function midPriceOut(amountIn: bigint, hops: readonly SwapHop[], sqrtPricesX96: readonly bigint[]): bigint {
  if (hops.length !== sqrtPricesX96.length) throw new Error('uniswapV3: one price per hop');
  let amount = amountIn;
  hops.forEach((hop, i) => {
    const squared = sqrtPricesX96[i] * sqrtPricesX96[i];
    const zeroForOne = BigInt(hop.tokenIn) < BigInt(hop.tokenOut);
    amount = zeroForOne ? (amount * squared) / Q192 : (amount * Q192) / squared;
    amount = (amount * (FEE_DENOMINATOR - BigInt(hop.fee))) / FEE_DENOMINATOR;
  });
  return amount;
}

/** Price impact in hundredths of a percent (150 = 1.5%), never negative. Null
 *  when the mid-price output is zero, which says nothing either way. */
export function priceImpactBps(quotedOut: bigint, midOut: bigint): number | null {
  if (midOut <= 0n) return null;
  if (quotedOut >= midOut) return 0;
  return Number(((midOut - quotedOut) * 10_000n) / midOut);
}
