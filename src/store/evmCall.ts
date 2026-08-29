// The GENERIC EVM contract-call plan: price arbitrary calldata, refuse rather
// than guess, hand back something a review screen can only display and confirm.
//
// evmSend.ts does this for a send, where the shape is fixed (a recipient, an
// amount, an asset). This module is the same discipline with the shape opened
// up: `{to, data, value}` chosen by the caller. Native staking (the first
// caller, src/store/evmStaking.ts) is a precompile call, and the dApp surface
// (phase 5) is a call a WEBSITE composed. Both need exactly this, so it lives
// here once rather than being written twice.
//
// What it does NOT do, deliberately:
//   - it never decodes the calldata to decide anything. `description` is
//     supplied by the caller, which is the only party that knows what the bytes
//     mean. A decoder that guessed here would put a sentence on a review screen
//     that the transaction does not carry.
//   - it never signs and never broadcasts. broadcastEvmPlan (evmSend.ts) is the
//     single broadcast chokepoint for both shapes: gate, caps, nonce, sign,
//     decode-back check, send.
//
// Everything EVM is reached through loadEvmModules() (the build flag). The
// type-only imports below are erased at compile time.

import { loadEvmModules } from '../services/chain/engine';
import { formatAmount } from '../services/chain/amounts';
import { revertReason, EvmSendError } from './evmSend';
import type { EvmWalletDataProvider } from '../services/chain/evm/evmProvider';
import type { EvmFeeLevel, EvmFeeQuote } from '../services/chain/evm/fees';
import type { EvmTxRequest } from '../services/chain/evm/tx';
import type { EvmChainInfo } from './evmChains';

/**
 * EXTRA gas headroom on top of what the fee module already applies.
 *
 * quoteEvmFees pads eth_estimateGas by 20%, which is the right allowance for a
 * transfer whose cost is known to the gas unit. A precompile call is not that:
 * on a cosmos/evm chain the EVM gas an operation reports is a projection of the
 * Cosmos gas the module will actually consume, and that consumption depends on
 * state that moves between the estimate and inclusion (a validator's delegation
 * record being created rather than updated, a distribution period rolling over).
 * 25% total is the allowance used here, and unused gas is refunded, so the
 * headroom costs nothing when it is not needed and prevents an out-of-gas
 * revert when it is.
 *
 * Applied by recomputing from the quote's RAW gasEstimate, so the two paddings
 * do not compound (1.2 x 1.25 would be 1.5).
 */
const CALL_GAS_HEADROOM_NUMERATOR = 125n;
const CALL_GAS_HEADROOM_DENOMINATOR = 100n;

/** What the caller wants priced and, eventually, sent. */
export interface EvmCallInput {
  to: string;
  data: Uint8Array;
  /** wei attached to the call. 0n for every staking call. */
  value: bigint;
  /** What this transaction does, in words, for the review step. The caller owns
   *  this sentence; nothing here inspects the calldata to invent one. */
  description: string;
  level?: EvmFeeLevel;
}

/**
 * A priced call. Structurally a superset of what broadcastEvmPlan needs, which
 * is why the same broadcast path serves this and a send.
 */
export interface EvmCallPlan {
  chainKey: string;
  chainId: number;
  from: string;
  to: string;
  value: bigint;
  data: Uint8Array;
  description: string;
  level: EvmFeeLevel;
  /** Every level, so switching in the UI needs no new quote. */
  quotes: Record<EvmFeeLevel, EvmFeeQuote>;
  quote: EvmFeeQuote;
  unsigned: Omit<EvmTxRequest, 'nonce'>;
  /** Null when the native balance covers value + the worst-case fee. */
  shortfall: string | null;
  /** Null when within the chain's fee caps, else the refusal text. A capped
   *  plan can be displayed but never broadcast. */
  capRefusal: string | null;
}

/** The quote with `percent`% headroom over the RAW estimate instead of the fee
 *  module's 20%, and both totals recomputed to match.
 *
 *  `l1DataFee` is carried through unchanged: it prices the CALLDATA posted to
 *  L1, which the gas limit does not change beyond a byte or two of RLP. (No
 *  chain with native staking is an OP-stack chain today, so on this path it is
 *  0n either way; the field is handled rather than assumed away.) */
export function withCallGasHeadroom(quote: EvmFeeQuote): EvmFeeQuote {
  const padded =
    (quote.gasEstimate * CALL_GAS_HEADROOM_NUMERATOR + CALL_GAS_HEADROOM_DENOMINATOR - 1n) /
    CALL_GAS_HEADROOM_DENOMINATOR;
  const gasLimit = padded > quote.gasLimit ? padded : quote.gasLimit;
  const likelyPerGas =
    quote.fee.type === 'eip1559' ? (quote.baseFeePerGas ?? 0n) + quote.fee.maxPriorityFeePerGas : quote.fee.gasPrice;
  const maxPerGas = quote.fee.type === 'eip1559' ? quote.fee.maxFeePerGas : quote.fee.gasPrice;
  return {
    ...quote,
    gasLimit,
    estimatedTotal: gasLimit * likelyPerGas + quote.l1DataFee,
    maxTotal: gasLimit * maxPerGas + quote.l1DataFee,
  };
}

/**
 * Price one call at every fee level and check it against the chain's caps and
 * the account's balance.
 *
 * SIMULATION IS THE GATE. quoteEvmFees runs eth_estimateGas, so a call the
 * chain would revert never becomes a plan: it throws EvmSendError('quote-failed')
 * carrying the node's own words. That is the honest refusal, and it is why no
 * separate "simulate" step exists here. A wallet that showed a Confirm button
 * for a transaction the node already refused would be charging a fee for a
 * failure.
 */
export async function planEvmCall(args: {
  provider: EvmWalletDataProvider;
  chain: EvmChainInfo;
  from: string;
  input: EvmCallInput;
  /** The account's native balance, when known, so a call it cannot pay for is
   *  named before the review rather than at the node. Undefined = not read yet,
   *  which says nothing and blocks nothing. */
  nativeBalanceBase?: bigint;
}): Promise<EvmCallPlan> {
  const evm = await loadEvmModules();
  if (!evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
  const { provider, chain, from, input, nativeBalanceBase } = args;

  if (!evm.isEvmAddress(input.to)) {
    throw new EvmSendError('invalid-address', `Not a valid contract address on ${chain.displayName}: ${input.to}`);
  }
  if (!(input.data instanceof Uint8Array) || input.data.length === 0) {
    throw new EvmSendError('unknown-asset', 'A contract call must carry calldata.');
  }
  if (typeof input.value !== 'bigint' || input.value < 0n) {
    throw new EvmSendError('invalid-amount', 'The value attached to a call must be a non-negative amount.');
  }
  const to = evm.normalizeEvmAddress(input.to);

  let rawQuotes: Record<EvmFeeLevel, EvmFeeQuote>;
  try {
    rawQuotes = await evm.quoteEvmFees(provider.rpc, { from, to, value: input.value, data: input.data });
  } catch (err) {
    if (err instanceof evm.EvmFeeQuoteError) {
      const text =
        err.reason === 'estimate-reverted'
          ? `${chain.displayName} refused to simulate this transaction${err.detail ? `: ${revertReason(err.detail)}` : ''}.`
          : err.reason === 'unavailable'
            ? `${chain.displayName} is unreachable right now; the fee cannot be quoted.`
            : `${chain.displayName} returned unusable fee data${err.detail ? ` (${err.detail})` : ''}; try again.`;
      throw new EvmSendError('quote-failed', text);
    }
    throw new EvmSendError('quote-failed', err instanceof Error ? err.message : String(err));
  }

  const quotes = {
    slow: withCallGasHeadroom(rawQuotes.slow),
    normal: withCallGasHeadroom(rawQuotes.normal),
    fast: withCallGasHeadroom(rawQuotes.fast),
  };
  const level: EvmFeeLevel = input.level ?? 'normal';
  const quote = quotes[level];

  return {
    chainKey: chain.key,
    chainId: chain.chainId,
    from,
    to,
    value: input.value,
    data: input.data,
    description: input.description,
    level,
    quotes,
    quote,
    unsigned: {
      chainId: chain.chainId,
      to,
      value: input.value,
      data: input.data,
      gasLimit: quote.gasLimit,
      fee: quote.fee,
    },
    shortfall: callShortfall(chain, input.value, quote, nativeBalanceBase),
    capRefusal: callCapRefusal(evm, chain.key, quote),
  };
}

/** Re-derive the level-dependent parts of a plan without a new quote. */
export async function withEvmCallFeeLevel(
  plan: EvmCallPlan,
  level: EvmFeeLevel,
  chain: EvmChainInfo,
  nativeBalanceBase?: bigint,
): Promise<EvmCallPlan> {
  const evm = await loadEvmModules();
  if (!evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
  const quote = plan.quotes[level];
  return {
    ...plan,
    level,
    quote,
    unsigned: { ...plan.unsigned, gasLimit: quote.gasLimit, fee: quote.fee },
    shortfall: callShortfall(chain, plan.value, quote, nativeBalanceBase),
    capRefusal: callCapRefusal(evm, chain.key, quote),
  };
}

function callShortfall(
  chain: EvmChainInfo,
  value: bigint,
  quote: EvmFeeQuote,
  nativeBalanceBase?: bigint,
): string | null {
  if (nativeBalanceBase === undefined) return null;
  const needed = value + quote.maxTotal;
  if (needed <= nativeBalanceBase) return null;
  const fmt = (v: bigint) => formatAmount(v, chain.nativeDecimals);
  const t = chain.nativeTicker;
  return value > 0n
    ? `Not enough ${t}: ${fmt(value)} plus the maximum fee ${fmt(quote.maxTotal)} exceeds the balance ${fmt(nativeBalanceBase)} ${t}.`
    : `Not enough ${t} to pay the network fee: the fee can reach ${fmt(quote.maxTotal)} ${t}, the balance is ${fmt(nativeBalanceBase)} ${t}.`;
}

type EvmMods = NonNullable<Awaited<ReturnType<typeof loadEvmModules>>>;

function callCapRefusal(evm: EvmMods, chainKey: string, quote: EvmFeeQuote): string | null {
  try {
    evm.assertEvmFeeWithinCaps(chainKey, { fee: quote.fee, maxTotal: quote.maxTotal });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
