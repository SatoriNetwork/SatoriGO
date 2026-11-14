// The in-wallet swap: find a Uniswap v3 route, quote it, and build the two
// priced plans a swap can need (an exact-amount approve, then the swap).
//
// The wallet does its own routing against the pinned contracts in
// src/services/chain/evm/uniswapV3.ts: no routing API, no calldata from a
// server. Both plans go through planEvmCall, so the node's simulation is the
// gate here as everywhere else, and broadcastEvmPlan sends them.
//
// Routes considered: the direct pool at each fee tier, and two hops through the
// chain's wrapped coin or its main dollar token. The best first leg and the
// best second leg make the best two-hop route, because a pool's output only
// grows with its input, so the legs are quoted separately and the tiers are
// never multiplied out.
//
// Everything EVM is reached through loadEvmModules() (the build flag).

import { loadEvmModules } from '../services/chain/engine';
import { formatAmount } from '../services/chain/amounts';
import { SATORI_BASE_TOKEN } from '../services/assetNotes';
import { planEvmCall, type EvmCallPlan } from './evmCall';
import { EvmSendError, refuseLockedSatori } from './evmSend';
import type { EvmWalletDataProvider } from '../services/chain/evm/evmProvider';
import type { EvmRpcCall, EvmRpcBatchResult } from '../services/chain/evm/rpc';
import type { SwapHop, UniswapV3Deployment } from '../services/chain/evm/uniswapV3';
import type { EvmChainInfo } from './evmChains';

type EvmMods = NonNullable<Awaited<ReturnType<typeof loadEvmModules>>>;

/** Slippage the screen starts with, in hundredths of a percent. */
export const SWAP_SLIPPAGE_DEFAULT_BPS = 50;
/** Past this the "minimum received" protects nothing. */
export const SWAP_SLIPPAGE_MAX_BPS = 5000;
/** The screen warns from here. */
export const SWAP_IMPACT_WARN_BPS = 300;
/** From here, and when the impact could not be measured, the user has to say
 *  they have seen it before the swap can be confirmed. */
export const SWAP_IMPACT_ACK_BPS = 1500;
/** The router refuses the swap once this long has passed since it was planned. */
export const SWAP_DEADLINE_SECONDS = 1200;

/** One side of a swap. `address` null is the chain's own coin. */
export interface SwapToken {
  address: string | null;
  symbol: string;
  decimals: number;
}

export interface SwapQuote {
  chainKey: string;
  from: string;
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  amountIn: bigint;
  /** What the route pays right now, before slippage. */
  amountOut: bigint;
  hops: SwapHop[];
  /** Hundredths of a percent, or null when it could not be measured. */
  impactBps: number | null;
  /** True when the router may not yet spend `amountIn` of the input token. */
  needsApproval: boolean;
  quotedAt: number;
}

export type SwapPlan = EvmCallPlan &
  (
    | { kind: 'approve'; tokenIn: SwapToken; amountIn: bigint }
    | {
        kind: 'swap';
        tokenIn: SwapToken;
        tokenOut: SwapToken;
        amountIn: bigint;
        amountOut: bigint;
        minimumOut: bigint;
        slippageBps: number;
        impactBps: number | null;
        hops: SwapHop[];
      }
  );

/** The swap under way, as the store keeps it. */
export interface SwapState {
  quote: SwapQuote | null;
  quoting: boolean;
  plan: SwapPlan | null;
  planning: boolean;
  error: string | null;
}

export const EMPTY_SWAP: SwapState = Object.freeze({ quote: null, quoting: false, plan: null, planning: false, error: null });

/** True when this chain has a pinned Uniswap deployment in this build. */
export async function swapSupported(chainKey: string): Promise<boolean> {
  const evm = await loadEvmModules();
  return !!evm && evm.uniswapV3For(chainKey) !== null;
}

/** True when the impact is high enough, or unknown, that the user must
 *  acknowledge it before confirming. */
export function swapNeedsImpactAck(impactBps: number | null): boolean {
  return impactBps === null || impactBps >= SWAP_IMPACT_ACK_BPS;
}

/** Exact, never rounded: these amounts go into the sentence the user approves,
 *  and a rounded minimum would read "at least 0" for a small swap. */
function amountText(base: bigint, token: SwapToken): string {
  return `${formatAmount(base, token.decimals)} ${token.symbol}`;
}

function setup(evm: EvmMods | null, chain: EvmChainInfo): { evm: EvmMods; deployment: UniswapV3Deployment } {
  if (!evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
  const deployment = evm.uniswapV3For(chain.key);
  if (!deployment) throw new EvmSendError('unknown-asset', `Swapping is not available on ${chain.displayName}.`);
  return { evm, deployment };
}

/** The token a pool actually holds for this side: the coin trades as its wrapped form. */
function poolToken(evm: EvmMods, deployment: UniswapV3Deployment, token: SwapToken, chain: EvmChainInfo): string {
  if (token.address === null) return deployment.wrappedNative;
  if (!evm.isEvmAddress(token.address)) {
    throw new EvmSendError('invalid-address', `Not a valid token address on ${chain.displayName}: ${token.address}`);
  }
  return evm.normalizeEvmAddress(token.address);
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function batch(provider: EvmWalletDataProvider, chain: EvmChainInfo, calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> {
  try {
    return await provider.rpc.batch(calls);
  } catch {
    throw new EvmSendError('quote-failed', `${chain.displayName} is unreachable right now. Try again.`);
  }
}

const ethCall = (to: string, data: string): EvmRpcCall => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });

/** A decoded batch entry, or null when the node refused it (no such pool) or
 *  the answer does not decode. */
function read<T>(entry: EvmRpcBatchResult | undefined, decode: (result: unknown) => T): T | null {
  if (!entry || !entry.ok) return null;
  try {
    return decode(entry.result);
  } catch {
    return null;
  }
}

interface Leg {
  hop: SwapHop;
  out: bigint;
}

/** Quote `amountIn` through the pool at every fee tier for each (tokenIn,
 *  tokenOut) pair, in one round trip, and keep the best tier per pair. */
async function bestLegs(
  evm: EvmMods,
  provider: EvmWalletDataProvider,
  chain: EvmChainInfo,
  deployment: UniswapV3Deployment,
  pairs: ReadonlyArray<{ tokenIn: string; tokenOut: string; amountIn: bigint }>,
  extra: EvmRpcCall[] = [],
): Promise<{ legs: Array<Leg | null>; extra: EvmRpcBatchResult[] }> {
  const calls: EvmRpcCall[] = [];
  for (const pair of pairs) {
    for (const fee of evm.UNISWAP_V3_FEES) {
      const hop = { tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, fee };
      calls.push(ethCall(deployment.quoterV2, evm.encodeQuoteExactInput([hop], pair.amountIn)));
    }
  }
  const results = await batch(provider, chain, [...calls, ...extra]);
  const tiers = evm.UNISWAP_V3_FEES.length;
  const legs = pairs.map((pair, p) => {
    let best: Leg | null = null;
    evm.UNISWAP_V3_FEES.forEach((fee, f) => {
      const out = read(results[p * tiers + f], evm.decodeQuoteAmountOut);
      if (out !== null && out > 0n && (!best || out > best.out)) {
        best = { hop: { tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, fee }, out };
      }
    });
    return best;
  });
  return { legs, extra: results.slice(calls.length) };
}

/** Price impact of `hops` for this trade, or null when a pool price could not
 *  be read. Never throws: an unmeasured impact is shown as such. */
async function measureImpact(
  evm: EvmMods,
  provider: EvmWalletDataProvider,
  chain: EvmChainInfo,
  deployment: UniswapV3Deployment,
  hops: SwapHop[],
  amountIn: bigint,
  amountOut: bigint,
): Promise<number | null> {
  try {
    const pools = (
      await batch(provider, chain, hops.map((hop) => ethCall(deployment.factory, evm.encodeGetPool(hop.tokenIn, hop.tokenOut, hop.fee))))
    ).map((entry) => read(entry, evm.decodePoolAddress));
    if (pools.some((pool) => pool === null)) return null;
    const prices = (await batch(provider, chain, pools.map((pool) => ethCall(pool as string, evm.encodeSlot0())))).map((entry) =>
      read(entry, evm.decodeSqrtPriceX96),
    );
    if (prices.some((price) => price === null)) return null;
    return evm.priceImpactBps(amountOut, evm.midPriceOut(amountIn, hops, prices as bigint[]));
  } catch {
    return null;
  }
}

/**
 * Find the best route for an exact input and say what it pays.
 * Throws EvmSendError, whose message the screen shows verbatim.
 */
export async function quoteSwap(args: {
  provider: EvmWalletDataProvider;
  chain: EvmChainInfo;
  from: string;
  tokenIn: SwapToken;
  tokenOut: SwapToken;
  amountIn: bigint;
}): Promise<SwapQuote> {
  const { provider, chain, from, tokenIn, tokenOut, amountIn } = args;
  const { evm, deployment } = setup(await loadEvmModules(), chain);
  if (amountIn <= 0n) throw new EvmSendError('invalid-amount', 'Enter an amount to swap.');
  const tin = poolToken(evm, deployment, tokenIn, chain);
  const tout = poolToken(evm, deployment, tokenOut, chain);
  if (sameAddress(tin, tout)) throw new EvmSendError('unknown-asset', 'Pick two different tokens to swap.');

  const middles = [deployment.wrappedNative, deployment.stable].filter((m) => !sameAddress(m, tin) && !sameAddress(m, tout));
  const allowanceCall = tokenIn.address === null ? [] : [ethCall(tin, evm.encodeAllowance(from, deployment.swapRouter02))];

  // Round trip 1: the direct pool, the first leg to each intermediate, and the allowance.
  const first = await bestLegs(
    evm,
    provider,
    chain,
    deployment,
    [{ tokenIn: tin, tokenOut: tout, amountIn }, ...middles.map((m) => ({ tokenIn: tin, tokenOut: m, amountIn }))],
    allowanceCall,
  );
  const direct = first.legs[0];
  const firstLegs = first.legs.slice(1).filter((leg): leg is Leg => leg !== null);

  // Round trip 2: from each intermediate on to the output.
  const second =
    firstLegs.length > 0
      ? (await bestLegs(evm, provider, chain, deployment, firstLegs.map((leg) => ({ tokenIn: leg.hop.tokenOut, tokenOut: tout, amountIn: leg.out })))).legs
      : [];

  let best: { hops: SwapHop[]; out: bigint } | null = direct ? { hops: [direct.hop], out: direct.out } : null;
  second.forEach((leg, i) => {
    // Strictly better only: at the same output the shorter route costs less gas.
    if (leg && (!best || leg.out > best.out)) best = { hops: [firstLegs[i].hop, leg.hop], out: leg.out };
  });
  if (!best) {
    throw new EvmSendError('quote-failed', `Uniswap has no route from ${tokenIn.symbol} to ${tokenOut.symbol} on ${chain.displayName} for this amount.`);
  }
  const route: { hops: SwapHop[]; out: bigint } = best;

  let needsApproval = false;
  if (tokenIn.address !== null) {
    const allowance = read(first.extra[0], (r) => evm.decodeUint256(r as string));
    if (allowance === null) throw new EvmSendError('quote-failed', `${tokenIn.symbol} could not be read right now. Try again.`);
    needsApproval = allowance < amountIn;
  }

  return {
    chainKey: chain.key,
    from,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut: route.out,
    hops: route.hops,
    impactBps: await measureImpact(evm, provider, chain, deployment, route.hops, amountIn, route.out),
    needsApproval,
    quotedAt: Date.now(),
  };
}

/** Refuse a swap the account cannot fund, in words, before the node does it
 *  with an opaque revert. The coin's own balance is planEvmCall's to check. */
async function refuseUnfunded(evm: EvmMods, provider: EvmWalletDataProvider, chain: EvmChainInfo, quote: SwapQuote): Promise<void> {
  if (quote.tokenIn.address === null) return;
  const [entry] = await batch(provider, chain, [ethCall(quote.tokenIn.address, evm.encodeBalanceOf(quote.from))]);
  const balance = read(entry, (r) => evm.decodeUint256(r as string));
  if (balance !== null && balance < quote.amountIn) {
    throw new EvmSendError('insufficient', `This address holds ${amountText(balance, quote.tokenIn)}, less than the ${amountText(quote.amountIn, quote.tokenIn)} to swap.`);
  }
}

async function refuseLocked(provider: EvmWalletDataProvider, chain: EvmChainInfo, quote: SwapQuote): Promise<void> {
  if (chain.key === 'base' && quote.tokenIn.address !== null && sameAddress(quote.tokenIn.address, SATORI_BASE_TOKEN)) {
    await refuseLockedSatori(provider, quote.from);
  }
}

function noFee(chain: EvmChainInfo): EvmSendError {
  return new EvmSendError(
    'insufficient',
    `This address has no ${chain.nativeTicker} on ${chain.displayName} to pay the network fee. Send it a little ${chain.nativeTicker} first.`,
  );
}

/**
 * Price the approval a token swap needs first: the pinned router may spend
 * EXACTLY the amount being swapped, never more.
 */
export async function buildSwapApprovePlan(args: {
  provider: EvmWalletDataProvider;
  chain: EvmChainInfo;
  quote: SwapQuote;
  nativeBalanceBase?: bigint;
}): Promise<SwapPlan> {
  const { provider, chain, quote, nativeBalanceBase } = args;
  const { evm, deployment } = setup(await loadEvmModules(), chain);
  if (quote.tokenIn.address === null) throw new EvmSendError('gated', `${chain.nativeTicker} needs no approval.`);
  if (nativeBalanceBase === 0n) throw noFee(chain);
  await refuseLocked(provider, chain, quote);
  await refuseUnfunded(evm, provider, chain, quote);
  const plan = await planEvmCall({
    provider,
    chain,
    from: quote.from,
    nativeBalanceBase,
    input: {
      to: quote.tokenIn.address,
      data: evm.encodeApprove(deployment.swapRouter02, quote.amountIn),
      value: 0n,
      description: `Allow Uniswap to take exactly ${amountText(quote.amountIn, quote.tokenIn)} from this address for your swap.`,
    },
  });
  return { ...plan, kind: 'approve', tokenIn: quote.tokenIn, amountIn: quote.amountIn };
}

/**
 * Price the swap itself along the quoted route. The route is quoted again here,
 * so the review shows this moment's figure and the minimum is taken from it.
 */
export async function buildSwapPlan(args: {
  provider: EvmWalletDataProvider;
  chain: EvmChainInfo;
  quote: SwapQuote;
  slippageBps: number;
  nativeBalanceBase?: bigint;
  nowMs?: number;
}): Promise<SwapPlan> {
  const { provider, chain, quote, slippageBps, nativeBalanceBase } = args;
  const { evm, deployment } = setup(await loadEvmModules(), chain);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > SWAP_SLIPPAGE_MAX_BPS) {
    throw new EvmSendError('invalid-amount', `Slippage must be between 0.01% and ${SWAP_SLIPPAGE_MAX_BPS / 100}%.`);
  }
  const nativeIn = quote.tokenIn.address === null;
  const nativeOut = quote.tokenOut.address === null;
  if (nativeBalanceBase === 0n) throw noFee(chain);
  await refuseLocked(provider, chain, quote);
  await refuseUnfunded(evm, provider, chain, quote);

  const calls = [ethCall(deployment.quoterV2, evm.encodeQuoteExactInput(quote.hops, quote.amountIn))];
  if (!nativeIn) calls.push(ethCall(quote.tokenIn.address as string, evm.encodeAllowance(quote.from, deployment.swapRouter02)));
  const [quoted, allowed] = await batch(provider, chain, calls);
  const amountOut = read(quoted, evm.decodeQuoteAmountOut);
  if (amountOut === null || amountOut <= 0n) {
    throw new EvmSendError('quote-failed', 'Uniswap could not quote this swap right now. Try again.');
  }
  if (!nativeIn) {
    const allowance = read(allowed, (r) => evm.decodeUint256(r as string));
    if (allowance === null || allowance < quote.amountIn) {
      throw new EvmSendError('gated', `Approve ${quote.tokenIn.symbol} first, then swap.`);
    }
  }
  const minimumOut = evm.minimumOut(amountOut, slippageBps);
  if (minimumOut <= 0n) throw new EvmSendError('invalid-amount', 'This amount is too small to swap.');
  const impactBps = await measureImpact(evm, provider, chain, deployment, quote.hops, quote.amountIn, amountOut);

  const plan = await planEvmCall({
    provider,
    chain,
    from: quote.from,
    nativeBalanceBase,
    input: {
      to: deployment.swapRouter02,
      data: evm.encodeSwap({
        deployment,
        hops: quote.hops,
        recipient: quote.from,
        amountIn: quote.amountIn,
        amountOutMinimum: minimumOut,
        deadline: BigInt(Math.floor((args.nowMs ?? Date.now()) / 1000) + SWAP_DEADLINE_SECONDS),
        nativeOut,
      }),
      value: nativeIn ? quote.amountIn : 0n,
      description: `Swap ${amountText(quote.amountIn, quote.tokenIn)} for at least ${amountText(minimumOut, quote.tokenOut)} on Uniswap.`,
    },
  });
  return {
    ...plan,
    kind: 'swap',
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountIn: quote.amountIn,
    amountOut,
    minimumOut,
    slippageBps,
    impactBps,
    hops: quote.hops,
  };
}
