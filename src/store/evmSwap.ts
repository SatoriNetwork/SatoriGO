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
import type { SwapFee, SwapHop, SwapPermit, UniswapV3Deployment } from '../services/chain/evm/uniswapV3';
import type { TypedData } from '../services/chain/evm/typedData';
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
/** The router refuses the swap once this long has passed since it was planned,
 *  counted from the chain's own clock (the latest block), not the computer's. */
export const SWAP_DEADLINE_SECONDS = 1200;
/** A reviewed swap older than this is priced again before it can be confirmed:
 *  its minimum was taken from a quote that no longer says much. */
export const SWAP_PLAN_MAX_AGE_MS = 120_000;
/** Chains whose pending transactions are public, where bots can trade around a
 *  swap up to its slippage. The screen says so and offers no wide slippage there. */
export const SWAP_PUBLIC_MEMPOOL_CHAINS: readonly string[] = Object.freeze(['ethereum', 'bsc']);

// --- Satori GO's own fee ------------------------------------------------------
// OFF: the rate is a 0 placeholder and no treasury address is set. To turn it
// on, set both constants below, and nothing else: they are compiled in, never
// read from a server, and the router itself refuses more than 1%. The fee comes
// off the OUTPUT token inside the swap transaction (uniswapV3.ts, encodeSwap).

/** The wallet's swap fee, in hundredths of a percent (25 = 0.25%). */
export const SWAP_FEE_BPS = 0;
/** Where the fee goes: one address the project controls on every swap chain. */
export const SWAP_FEE_RECIPIENT: string | null = null;
/** The router's own cap. A rate above it is treated as a mistake and charges nothing. */
export const SWAP_FEE_MAX_BPS = 100;

export interface SwapFeeConfig {
  bps: number;
  recipient: string | null;
}

/**
 * The fee one swap pays, or null for none. None when the rate is 0, the address
 * is missing or the rate is out of range, and none when the token received is
 * the official SATORI on Base: buying SATORI is free.
 */
export function swapFeeFor(
  chainKey: string,
  tokenOut: SwapToken,
  config: SwapFeeConfig = { bps: SWAP_FEE_BPS, recipient: SWAP_FEE_RECIPIENT },
): SwapFee | null {
  if (!config.recipient || !Number.isInteger(config.bps) || config.bps < 1 || config.bps > SWAP_FEE_MAX_BPS) return null;
  if (chainKey === 'base' && tokenOut.address !== null && tokenOut.address.toLowerCase() === SATORI_BASE_TOKEN.toLowerCase()) return null;
  return { bips: config.bps, recipient: config.recipient };
}

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
  /** What the user receives right now, before slippage and AFTER the wallet's
   *  fee when there is one. */
  amountOut: bigint;
  /** The wallet's fee on this swap in hundredths of a percent, 0 for none. */
  feeBps: number;
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
        /** After the wallet's fee, like `minimumOut`. */
        amountOut: bigint;
        minimumOut: bigint;
        /** The wallet's fee: its rate, and what it comes to at this quote, in the
         *  output token. Both 0 when there is none. */
        feeBps: number;
        feeAmount: bigint;
        /** When this was priced, on this computer's clock (SWAP_PLAN_MAX_AGE_MS). */
        plannedAt: number;
        /** True when the allowance rides inside this transaction as a signed
         *  permit, so no separate approval was needed. */
        viaPermit: boolean;
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
  /** The token can take its allowance as a signed permit, and the user has not
   *  yet been asked whether to sign one. Nothing is signed while this is set. */
  permitAsk: boolean;
  error: string | null;
}

export const EMPTY_SWAP: SwapState = Object.freeze({ quote: null, quoting: false, plan: null, planning: false, permitAsk: false, error: null });

/** A swap this wallet just sent, followed until the chain answers. Home shows it. */
export interface SwapStatus {
  txid: string;
  /** The account that sent it: the bar is that account's, on that network. */
  from: string;
  chainKey: string;
  chainName: string;
  explorerUrl: string;
  /** Amounts as text ("10", "32.52") and the raw token symbols, kept apart so
   *  the screen can make each symbol safe to draw. What is received is the
   *  quote, not a figure read back from the chain. */
  payAmount: string;
  paySymbol: string;
  receiveAmount: string;
  receiveSymbol: string;
  /** `late`: no answer within SWAP_FOLLOW_MAX_MS; it may still confirm. */
  state: 'pending' | 'confirmed' | 'failed' | 'late';
}

/** How often, and for how long, a sent swap is watched for its receipt. */
export const SWAP_FOLLOW_POLL_MS = 4_000;
export const SWAP_FOLLOW_MAX_MS = 180_000;

/** The one refusal an approval fixes: the router may not yet take the input
 *  token, and no signed permit can stand in. Its own class so the store falls
 *  back to the approval step for this and for nothing else. */
export class SwapNeedsApprovalError extends EvmSendError {
  constructor(symbol: string) {
    super('gated', `Approve ${symbol} first, then swap.`);
    this.name = 'SwapNeedsApprovalError';
  }
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

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

/** Many reads in ONE request, through Multicall3, answered in order:
 *  each read's return data, or null for one that failed inside (no
 *  such pool). The whole request failing is the node being unreachable. This
 *  keeps a quote to a few requests, which is what a shared RPC allowance can
 *  carry. Reads only: nothing is ever sent to Multicall3. */
async function readTogether(
  evm: EvmMods,
  provider: EvmWalletDataProvider,
  chain: EvmChainInfo,
  reads: ReadonlyArray<{ to: string; data: string }>,
): Promise<Array<string | null>> {
  if (reads.length === 0) return [];
  const [entry] = await batch(provider, chain, [ethCall(evm.MULTICALL3, evm.encodeAggregate3(reads))]);
  const answers = read(entry, (r) => evm.decodeAggregate3(r, reads.length));
  if (answers === null) throw new EvmSendError('quote-failed', `${chain.displayName} is unreachable right now. Try again.`);
  return answers;
}

/** One answer of readTogether decoded, or null when it failed or does not decode. */
function decoded<T>(answer: string | null | undefined, decode: (result: string) => T): T | null {
  if (answer === null || answer === undefined) return null;
  try {
    return decode(answer);
  } catch {
    return null;
  }
}

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
 *  tokenOut) pair, in one request, and keep the best tier per pair. */
async function bestLegs(
  evm: EvmMods,
  provider: EvmWalletDataProvider,
  chain: EvmChainInfo,
  deployment: UniswapV3Deployment,
  pairs: ReadonlyArray<{ tokenIn: string; tokenOut: string; amountIn: bigint }>,
  extra: Array<{ to: string; data: string }> = [],
): Promise<{ legs: Array<Leg | null>; extra: Array<string | null> }> {
  const calls: Array<{ to: string; data: string }> = [];
  for (const pair of pairs) {
    for (const fee of evm.UNISWAP_V3_FEES) {
      const hop = { tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, fee };
      calls.push({ to: deployment.quoterV2, data: evm.encodeQuoteExactInput([hop], pair.amountIn) });
    }
  }
  const results = await readTogether(evm, provider, chain, [...calls, ...extra]);
  const tiers = evm.UNISWAP_V3_FEES.length;
  const legs = pairs.map((pair, p) => {
    let best: Leg | null = null;
    evm.UNISWAP_V3_FEES.forEach((fee, f) => {
      const out = decoded(results[p * tiers + f], evm.decodeQuoteAmountOut);
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
      await readTogether(evm, provider, chain, hops.map((hop) => ({ to: deployment.factory, data: evm.encodeGetPool(hop.tokenIn, hop.tokenOut, hop.fee) })))
    ).map((answer) => decoded(answer, evm.decodePoolAddress));
    if (pools.some((pool) => pool === null)) return null;
    const prices = (await readTogether(evm, provider, chain, pools.map((pool) => ({ to: pool as string, data: evm.encodeSlot0() })))).map((answer) =>
      decoded(answer, evm.decodeSqrtPriceX96),
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
  /** Tests only: the compiled-in fee constants are used when absent. */
  feeConfig?: SwapFeeConfig;
}): Promise<SwapQuote> {
  const { provider, chain, from, tokenIn, tokenOut, amountIn } = args;
  const { evm, deployment } = setup(await loadEvmModules(), chain);
  if (amountIn <= 0n) throw new EvmSendError('invalid-amount', 'Enter an amount to swap.');
  const tin = poolToken(evm, deployment, tokenIn, chain);
  const tout = poolToken(evm, deployment, tokenOut, chain);
  if (sameAddress(tin, tout)) throw new EvmSendError('unknown-asset', 'Pick two different tokens to swap.');

  const middles = [deployment.wrappedNative, deployment.stable].filter((m) => !sameAddress(m, tin) && !sameAddress(m, tout));
  const allowanceCall = tokenIn.address === null ? [] : [{ to: tin, data: evm.encodeAllowance(from, deployment.swapRouter02) }];

  // Request 1: the direct pool, the first leg to each intermediate, and the allowance.
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

  // Request 2, only when an intermediate has a first leg: on to the output.
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

  const fee = swapFeeFor(chain.key, tokenOut, args.feeConfig);

  let needsApproval = false;
  if (tokenIn.address !== null) {
    const allowance = decoded(first.extra[0], evm.decodeUint256);
    if (allowance === null) throw new EvmSendError('quote-failed', `${tokenIn.symbol} could not be read right now. Try again.`);
    needsApproval = allowance < amountIn;
  }

  return {
    chainKey: chain.key,
    from,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut: evm.afterSwapFee(route.out, fee?.bips ?? 0),
    feeBps: fee?.bips ?? 0,
    hops: route.hops,
    impactBps: await measureImpact(evm, provider, chain, deployment, route.hops, amountIn, route.out),
    needsApproval,
    quotedAt: Date.now(),
  };
}

/** Whether the router may now take the quote's amount: the one read the wait
 *  for an approval repeats, so waiting costs one small request at a time and
 *  the full quote runs once, when this turns true. Never throws: a node that
 *  did not answer is "not yet". */
export async function swapAllowanceReady(args: { provider: EvmWalletDataProvider; chain: EvmChainInfo; quote: SwapQuote }): Promise<boolean> {
  const { provider, chain, quote } = args;
  if (quote.tokenIn.address === null) return true;
  try {
    const { evm, deployment } = setup(await loadEvmModules(), chain);
    const [entry] = await batch(provider, chain, [ethCall(quote.tokenIn.address, evm.encodeAllowance(quote.from, deployment.swapRouter02))]);
    const allowance = read(entry, (r) => evm.decodeUint256(r as string));
    return allowance !== null && allowance >= quote.amountIn;
  } catch {
    return false;
  }
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

/**
 * A signed allowance for the router: exactly the amount being swapped, good
 * until the swap's own deadline. Null when the token has no permit this wallet
 * can use, which sends the caller back to an ordinary approval.
 *
 * Nothing is taken on trust. The token's name and nonce are read from the
 * chain, and its version is whichever one makes the standard's domain hash
 * equal the DOMAIN_SEPARATOR the token itself publishes; a token that matches
 * none is not signed for at all. The signed permit is then shown to the token
 * in a simulation, and one it refuses is dropped.
 *
 * The signature only allows Uniswap's router, which only ever moves the
 * tokens of whoever calls it, so a plan that is reviewed and then abandoned
 * leaves nothing behind that anyone else can use.
 */
async function permitTerms(
  evm: EvmMods,
  provider: EvmWalletDataProvider,
  chain: EvmChainInfo,
  quote: SwapQuote,
): Promise<{ name: string; version: string; nonce: bigint } | null> {
  const token = quote.tokenIn.address;
  if (token === null) return null;
  const [nameAnswer, separatorAnswer, nonceAnswer] = await batch(provider, chain, [
    ethCall(token, evm.encodeName()),
    ethCall(token, evm.UNISWAP_V3_SELECTORS.DOMAIN_SEPARATOR),
    ethCall(token, evm.UNISWAP_V3_SELECTORS.nonces + quote.from.slice(2).toLowerCase().padStart(64, '0')),
  ]);
  const name = read(nameAnswer, (r) => evm.decodeString(r as string));
  const separator = read(separatorAnswer, (r) => (typeof r === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r) ? r.toLowerCase() : null));
  const nonce = read(nonceAnswer, (r) => evm.decodeUint256(r as string));
  if (!name || !separator || nonce === null) return null;
  const version = PERMIT_VERSIONS.find((v) => evm.permitDomainSeparator(name, v, chain.chainId, token) === separator);
  return version ? { name, version, nonce } : null;
}

/** Whether the token paid can take its allowance as a signed permit this
 *  wallet knows how to build. Reads only, signs nothing: it is what decides
 *  whether the user is ASKED to sign one. Never throws. */
export async function swapPermitAvailable(args: { provider: EvmWalletDataProvider; chain: EvmChainInfo; quote: SwapQuote }): Promise<boolean> {
  try {
    const { evm } = setup(await loadEvmModules(), args.chain);
    return (await permitTerms(evm, args.provider, args.chain, args.quote)) !== null;
  } catch {
    return false;
  }
}

async function signSwapPermit(
  evm: EvmMods,
  provider: EvmWalletDataProvider,
  chain: EvmChainInfo,
  deployment: UniswapV3Deployment,
  quote: SwapQuote,
  deadline: bigint,
  sign: (data: TypedData) => string,
): Promise<SwapPermit | null> {
  const token = quote.tokenIn.address;
  if (token === null) return null;
  try {
    const terms = await permitTerms(evm, provider, chain, quote);
    if (!terms) return null;
    const { name, version, nonce } = terms;
    const data = evm.permitTypedData({
      name,
      version,
      chainId: chain.chainId,
      token,
      owner: quote.from,
      spender: deployment.swapRouter02,
      value: quote.amountIn,
      nonce,
      deadline,
    });
    const permit = { token, value: quote.amountIn, deadline, ...evm.splitPermitSignature(sign(data)) };
    // Ask the token itself, through the router, before building a swap on it.
    // A permit it refuses (its own dialect, an account it treats as a contract
    // wallet) means an approval; and a swap that then fails to simulate has
    // failed for a reason an approval would not fix, so it is reported, not
    // papered over with a first step the user would pay for.
    const [accepted] = await batch(provider, chain, [
      {
        method: 'eth_call',
        params: [
          { from: quote.from, to: deployment.swapRouter02, data: `0x${hex(evm.encodeMulticall(deadline, [evm.encodeSelfPermitIfNecessary(permit)]))}` },
          'latest',
        ],
      },
    ]);
    return accepted && accepted.ok ? permit : null;
  } catch {
    return null;
  }
}

/** The permit domain versions in use: OpenZeppelin tokens say "1", USDC says "2". */
const PERMIT_VERSIONS: readonly string[] = ['1', '2'];

/** The route must be one this wallet could have built: from the token paid to
 *  the token received, through nothing but the pinned intermediates. The quote
 *  only ever comes from quoteSwap, so this is a second lock, not the first. */
function refuseForeignRoute(evm: EvmMods, deployment: UniswapV3Deployment, chain: EvmChainInfo, quote: SwapQuote): void {
  const hops = quote.hops;
  const ok =
    hops.length >= 1 &&
    hops.length <= 2 &&
    sameAddress(hops[0].tokenIn, poolToken(evm, deployment, quote.tokenIn, chain)) &&
    sameAddress(hops[hops.length - 1].tokenOut, poolToken(evm, deployment, quote.tokenOut, chain)) &&
    (hops.length === 1 ||
      (sameAddress(hops[0].tokenOut, hops[1].tokenIn) &&
        (sameAddress(hops[0].tokenOut, deployment.wrappedNative) || sameAddress(hops[0].tokenOut, deployment.stable))));
  if (!ok) throw new EvmSendError('gated', 'This swap route is not one Satori GO built. Start the swap again.');
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
  /** Signs typed data with the sending account, returning 0x r||s||v. When
   *  given, a token the router is not yet allowed is covered by a signed permit
   *  inside the swap, if the token supports one, instead of being refused. */
  signPermit?: (data: TypedData) => string;
  /** Tests only: the compiled-in fee constants are used when absent. */
  feeConfig?: SwapFeeConfig;
}): Promise<SwapPlan> {
  const { provider, chain, quote, slippageBps, nativeBalanceBase } = args;
  const { evm, deployment } = setup(await loadEvmModules(), chain);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > SWAP_SLIPPAGE_MAX_BPS) {
    throw new EvmSendError('invalid-amount', `Slippage must be between 0.01% and ${SWAP_SLIPPAGE_MAX_BPS / 100}%.`);
  }
  const nativeIn = quote.tokenIn.address === null;
  const nativeOut = quote.tokenOut.address === null;
  refuseForeignRoute(evm, deployment, chain, quote);
  if (nativeBalanceBase === 0n) throw noFee(chain);
  await refuseLocked(provider, chain, quote);
  await refuseUnfunded(evm, provider, chain, quote);

  const calls: EvmRpcCall[] = [
    ethCall(deployment.quoterV2, evm.encodeQuoteExactInput(quote.hops, quote.amountIn)),
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
  ];
  if (!nativeIn) calls.push(ethCall(quote.tokenIn.address as string, evm.encodeAllowance(quote.from, deployment.swapRouter02)));
  const [quoted, block, allowed] = await batch(provider, chain, calls);
  const grossOut = read(quoted, evm.decodeQuoteAmountOut);
  // The chain's clock, so a computer whose own clock is wrong cannot stretch
  // the deadline. No answer means no plan rather than a guess.
  const chainTime = read(block, (r) => BigInt((r as { timestamp: string }).timestamp));
  if (grossOut === null || grossOut <= 0n || chainTime === null || chainTime <= 0n) {
    throw new EvmSendError('quote-failed', 'Uniswap could not quote this swap right now. Try again.');
  }
  const deadline = chainTime + BigInt(SWAP_DEADLINE_SECONDS);
  let permit: SwapPermit | null = null;
  if (!nativeIn) {
    const allowance = read(allowed, (r) => evm.decodeUint256(r as string));
    if (allowance === null || allowance < quote.amountIn) {
      permit = args.signPermit ? await signSwapPermit(evm, provider, chain, deployment, quote, deadline, args.signPermit) : null;
      if (!permit) throw new SwapNeedsApprovalError(quote.tokenIn.symbol);
    }
  }
  const fee = swapFeeFor(chain.key, quote.tokenOut, args.feeConfig);
  const amountOut = evm.afterSwapFee(grossOut, fee?.bips ?? 0);
  const minimumOut = evm.minimumOut(amountOut, slippageBps);
  if (minimumOut <= 0n) throw new EvmSendError('invalid-amount', 'This amount is too small to swap.');
  const impactBps = await measureImpact(evm, provider, chain, deployment, quote.hops, quote.amountIn, grossOut);

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
        deadline,
        nativeOut,
        fee,
        permit,
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
    feeBps: fee?.bips ?? 0,
    feeAmount: grossOut - amountOut,
    plannedAt: Date.now(),
    viaPermit: permit !== null,
    slippageBps,
    impactBps,
    hops: quote.hops,
  };
}
