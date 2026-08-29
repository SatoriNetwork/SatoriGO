// EVM fee quoting: what one transaction will cost, priced before it is signed.
//
// Phase 3 of the EVM rollout (the EVM rollout plan, section 4;
// evm-engine.md section 4, "Fees, where all EVM chains are alike stops being
// true"). This module makes exactly two read-only round trips and returns
// numbers: it never signs with a real key, never reserves a nonce, and never
// broadcasts. The counterpart on the UTXO side is feePolicy.ts, and the reason
// both files are this heavily commented is the same: a fee is the one number a
// wallet computes that the user cannot check, and being wrong about it either
// strands a transaction or overpays with real money.
//
// ---------------------------------------------------------------------------
// TRAP 1: eth_estimateGas DOES NOT INCLUDE THE L1 DATA FEE.
//
//   On Base, Optimism and the rest of the OP-stack family, a transaction is
//   charged twice: ordinary L2 execution gas (what eth_estimateGas measures)
//   PLUS a separate fee for posting its calldata to Ethereum L1. The second
//   one is invisible to every standard fee method. A preview built from
//   estimateGas alone on those chains is not slightly low, it is WRONG, and
//   for a small transfer the L1 part can be the larger half.
//
//   So on a chain whose registry row carries l1DataFee: 'optimism', this
//   module reads the surcharge from the GasPriceOracle predeploy at
//   0x420000000000000000000000000000000000000F, function getL1Fee(bytes)
//   (selector 0x49948e0e, proven against selector('getL1Fee(bytes)') in
//   fees.test.ts section 1), and adds it to the total.
//
//   The bytes argument is THE RLP-SERIALIZED SIGNED TRANSACTION, not the
//   unsigned one. The oracle prices the SIZE of what gets posted, and what
//   gets posted includes the 65-byte signature, so quoting the unsigned form
//   understates every fee by the cost of that signature. There is no real key
//   here and there must not be, so the candidate transaction is signed with a
//   throwaway constant key (below) purely to produce a byte string of the
//   right shape and length. Two deliberate, documented inaccuracies remain,
//   both worth a few bytes of calldata and neither worth a real key:
//     - the throwaway signature's r and s are RLP-encoded with leading zero
//       bytes stripped, so a signature whose r or s happens to start with a
//       zero byte serializes 1-2 bytes shorter than the user's will (odds
//       about 1 in 128 per scalar);
//     - the candidate is serialized at nonce 0, which is 1 byte of RLP, while
//       a real nonce above 127 takes 2 and above 255 takes 3.
//   Every other field (to, value, data, gasLimit, fee) is byte for byte the
//   transaction the user will send: fees.test.ts section 11 decodes the oracle
//   payload back with decodeSignedTx and proves it.
//
// TRAP 2: "GAS" IS A LIMIT, SO THERE ARE TWO TOTALS AND BOTH ARE SHOWN.
//
//   Fee = per-gas price times gas used, plus the L1 surcharge, and the gas
//   figure in a transaction is a CEILING, not a measurement: unused gas is
//   refunded. Under EIP-1559 the per-gas price is a ceiling too (maxFeePerGas),
//   while what is actually charged is baseFee + tip at inclusion time. So this
//   module reports both, and the UI must show both rather than pick one:
//     estimatedTotal = gasLimit x (baseFee + tip) + l1   (the likely charge)
//     maxTotal       = gasLimit x maxFeePerGas    + l1   (the worst case, and
//                                                         what must be spendable)
//   On a legacy chain there is one price and no ceiling above it, so the two
//   are equal. Showing only maxTotal reads as a wallet that overcharges;
//   showing only estimatedTotal understates what has to be in the account.
// ---------------------------------------------------------------------------
//
// Everything below is pure except the two rpc.batch calls. All amounts are
// bigint wei: one ETH is 10^18 wei, far past Number.MAX_SAFE_INTEGER.

import { decodeUint256 } from './erc20';
import {
  EvmRpcUnavailableError,
  fromQuantity,
  toHexData,
  toQuantity,
  type EvmRpcBatchResult,
  type EvmRpcCall,
  type EvmRpcClient,
} from './rpc';
import { signTx, type EvmFee, type EvmTxRequest } from './tx';

// ---------------------------------------------------------------------------
// Levels and the constants that price them
// ---------------------------------------------------------------------------

/** The three speeds offered to the user, slowest first. */
export type EvmFeeLevel = 'slow' | 'normal' | 'fast';

/** Slowest first. The ORDER IS LOAD-BEARING: it is also the column order of
 *  the percentiles requested from eth_feeHistory (see TIP_PERCENTILES). */
export const EVM_FEE_LEVELS: readonly EvmFeeLevel[] = Object.freeze([
  'slow',
  'normal',
  'fast',
] as const);

/**
 * Which percentile of recent priority tips each level asks for. p10 is what
 * the cheapest tenth of recent transactions paid, p90 what the most eager
 * tenth paid.
 */
const LEVEL_TIP_PERCENTILE: Record<EvmFeeLevel, number> = { slow: 10, normal: 50, fast: 90 };

/**
 * The percentile list sent to eth_feeHistory, built from EVM_FEE_LEVELS so the
 * two can never drift: reward row column i is level EVM_FEE_LEVELS[i]. The
 * list must ascend, which it does because the levels are ordered slow to fast.
 * All three are always requested, even when the caller wants one level, so a
 * quote is always one round trip.
 */
const TIP_PERCENTILES: readonly number[] = EVM_FEE_LEVELS.map((l) => LEVEL_TIP_PERCENTILE[l]);

/** How many recent blocks eth_feeHistory summarises. Five is enough to median
 *  away one outlier block without pricing off stale data: at 2 seconds a block
 *  on Base that is the last 10 seconds. */
const FEE_HISTORY_BLOCKS = 5;

/**
 * Legacy per-level markup on eth_gasPrice, in percent. The node's answer is
 * already its own estimate of "what gets mined", so slow is that answer
 * unchanged rather than a discount off it: bidding BELOW what the node
 * suggests is how a transaction sits in the mempool for hours.
 */
const LEGACY_PERCENT: Record<EvmFeeLevel, bigint> = { slow: 100n, normal: 110n, fast: 125n };

/**
 * maxFeePerGas = BASE_FEE_HEADROOM x baseFee + tip. The base fee can rise at
 * most 12.5% per block, so 2x survives six consecutive completely full blocks
 * (1.125^6 = 2.03). It is a ceiling, not a charge: what is actually paid is
 * baseFee + tip, and the excess is never taken.
 */
const BASE_FEE_HEADROOM = 2n;

/**
 * The floor under a priority tip, in wei. A zero tip is legal and is what the
 * median reports on a quiet chain, but sequencers deprioritise it, so one wei
 * is used instead: it is not zero and it costs nothing (1 wei times 21000 gas
 * is 21000 wei, about 10^-13 of a cent).
 *
 * IT MUST NOT BE A GWEI FLOOR. On Base the going tip is around 0.001 gwei, so
 * a "sensible" 1 gwei minimum would overpay by roughly 1000x on every single
 * transaction. Mainnet intuitions about gas prices are wrong on an L2.
 */
const MIN_TIP_WEI = 1n;

/**
 * gasLimit = ceil(estimate x 12 / 10), floored at 21000. The 20% headroom is
 * the usual allowance for state that changes between the estimate and
 * inclusion (a first-time token recipient whose storage slot goes from zero to
 * non-zero is the classic one), and unused gas is refunded, so headroom costs
 * nothing when it is not needed and saves an out-of-gas revert when it is.
 * 21000 is the protocol minimum for any transaction at all.
 */
const GAS_LIMIT_NUMERATOR = 12n;
const GAS_LIMIT_DENOMINATOR = 10n;
const MIN_GAS_LIMIT = 21_000n;

/** The OP-stack GasPriceOracle predeploy. Identical on every chain in the
 *  family, which is why it is a constant here and not a registry field. */
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';

/** selector('getL1Fee(bytes)'), pinned as a literal for the same reason
 *  ERC20_SELECTORS are: it is a constant of the OP-stack contracts, readable
 *  against any block explorer, and fees.test.ts section 1 proves this file's
 *  literal equals what selector() computes. */
const L1_FEE_SELECTOR = '0x49948e0e';

/** One ABI word, in hex characters. */
const WORD_HEX = 64;

/** Shape only. EIP-55 checksum validation lives in keys.ts and happens where
 *  the user types an address; by the time a request reaches this module the
 *  address has already been through it, and re-deriving keccak here would just
 *  be a second place to get it wrong. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function buildThrowawayKey(): Uint8Array {
  const key = new Uint8Array(32);
  key[31] = 1;
  return key;
}

/**
 * The key that signs the candidate transaction whose SIZE the L1 oracle
 * prices. Private key 1: a valid secp256k1 scalar, the most published private
 * key in existence, and the point is that it is worthless. It exists only so
 * signTx produces a byte string of the right length (see TRAP 1).
 *
 * IT IS NOT EXPORTED, DELIBERATELY. Nothing outside this module may reach a
 * key-shaped constant, and nothing inside it signs anything a node could
 * broadcast: the candidate goes nowhere but into the oracle's bytes argument,
 * and at nonce 0 from a sender that holds nothing it could not execute even if
 * it did.
 */
const THROWAWAY_KEY = buildThrowawayKey();

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** What the caller wants priced. `from` is used for eth_estimateGas only (gas
 *  depends on the sender's state, e.g. an allowance); it is not part of a
 *  signed transaction and so never reaches the oracle payload. */
export interface EvmFeeQuoteInput {
  from: string;
  to: string;
  /** wei */
  value: bigint;
  /** Calldata. Empty for a native transfer; an ERC-20 transfer is just data. */
  data: Uint8Array;
}

/** One priced level. Every field is wei except gasLimit/gasEstimate, which are
 *  gas units, and level. */
export interface EvmFeeQuote {
  level: EvmFeeLevel;
  /** Goes straight into EvmTxRequest.fee, unmodified. */
  fee: EvmFee;
  /** ceil(gasEstimate x 1.2), never below 21000. */
  gasLimit: bigint;
  /** The raw eth_estimateGas answer, kept so the UI can show the headroom. */
  gasEstimate: bigint;
  /** EIP-1559: the NEXT block's base fee (the last entry of feeHistory's
   *  baseFeePerGas, which carries blockCount + 1 entries). Legacy: null. */
  baseFeePerGas: bigint | null;
  /** The L1 data-fee surcharge in wei; 0n on chains that do not charge one. */
  l1DataFee: bigint;
  /** gasLimit x (baseFee + tip) + l1, or gasLimit x gasPrice + l1. TRAP 2. */
  estimatedTotal: bigint;
  /** gasLimit x maxFeePerGas + l1, or, on legacy, the same as estimatedTotal. */
  maxTotal: bigint;
}

/**
 * A quote could not be produced. Three reasons, and they are not
 * interchangeable, because the UI has to say three different things:
 *
 *   'estimate-reverted'   the node executed the transaction and it failed
 *                         (insufficient funds, a reverting token transfer, a
 *                         bad recipient). The user's transaction is wrong, and
 *                         `detail` carries the node's own words.
 *   'malformed-fee-data'  the node answered, but not with usable fee data, or
 *                         the L1 oracle refused. Retrying may work; showing a
 *                         guessed fee must not happen.
 *   'unavailable'         no endpoint answered at all: offline for this chain.
 */
export class EvmFeeQuoteError extends Error {
  readonly reason: 'estimate-reverted' | 'malformed-fee-data' | 'unavailable';
  readonly detail?: string;

  constructor(reason: 'estimate-reverted' | 'malformed-fee-data' | 'unavailable', detail?: string) {
    super(detail === undefined ? `evm fee quote: ${reason}` : `evm fee quote: ${reason}: ${detail}`);
    this.name = 'EvmFeeQuoteError';
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function malformed(detail: string): EvmFeeQuoteError {
  return new EvmFeeQuoteError('malformed-fee-data', detail);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireAddress(value: string, field: string): void {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new Error(`evm fees: ${field} must be 0x followed by 40 hex characters`);
  }
}

/** A JSON-RPC quantity, or an EvmFeeQuoteError instead of fromQuantity's plain
 *  one: a node answering '0x04c4b40' (a leading zero, which the spec forbids)
 *  is malformed fee data, not a bug in this wallet. */
function quantity(raw: unknown, what: string): bigint {
  try {
    return fromQuantity(raw);
  } catch (err) {
    throw malformed(`${what}: ${errorText(err)}`);
  }
}

/**
 * The median of a set of tips.
 *
 * Median, not mean: one block with a single desperate transaction in it would
 * drag a mean up for every user of this wallet, and the whole point of asking
 * for five blocks is to be unmoved by one of them.
 *
 * On an EVEN count the LOWER of the two middles is taken, deliberately. The
 * alternative (averaging the two) invents a tip nobody actually paid, and
 * rounding that average needs a rule of its own; the lower middle is always a
 * real observed value. eth_feeHistory normally returns an odd count here (five
 * blocks) so this only matters when a node returns fewer blocks than asked.
 */
function medianOf(values: readonly bigint[]): bigint {
  // A comparator is required: Array.prototype.sort compares STRINGS by
  // default, which would order 9n after 10n.
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** ceil(estimate x 1.2), floored at the protocol minimum. Integer arithmetic
 *  throughout: (n x 12 + 9) / 10 is ceil(n x 1.2) on bigints. */
function gasLimitFor(gasEstimate: bigint): bigint {
  const padded =
    (gasEstimate * GAS_LIMIT_NUMERATOR + GAS_LIMIT_DENOMINATOR - 1n) / GAS_LIMIT_DENOMINATOR;
  return padded > MIN_GAS_LIMIT ? padded : MIN_GAS_LIMIT;
}

/** A uint256 as one ABI word of hex characters (no 0x prefix). */
function word(value: bigint): string {
  return value.toString(16).padStart(WORD_HEX, '0');
}

/**
 * ABI-encode getL1Fee(bytes) for one payload.
 *
 * `bytes` is a DYNAMIC type, so the encoding is not just the data: it is the
 * selector, then a head slot holding the OFFSET of the argument's tail
 * (0x20: the tail starts one word after the head begins), then the tail, which
 * is the LENGTH in bytes followed by the data right-padded with zeros to a
 * whole number of words. Passing the payload alone, or forgetting the padding,
 * produces a call the oracle either reverts on or prices for the wrong size.
 *
 * Exported for one reason: fees.test.ts section 1 pins the encoding against a
 * hand-written vector, which cannot be done through a quote because a real
 * payload is a whole signed transaction. It is pure and reaches no network.
 */
export function encodeGetL1Fee(payload: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil(payload.length / 32) * 32);
  padded.set(payload);
  return L1_FEE_SELECTOR + word(32n) + word(BigInt(payload.length)) + toHexData(padded).slice(2);
}

/**
 * The per-gas number the UI puts next to a level, and what to call it. Plain
 * English and no ticker: the caller formats the amount with the chain's own
 * nativeDecimals and nativeTicker, exactly as the UTXO side does.
 */
export function feeSummary(q: EvmFeeQuote): { perGas: bigint; label: string } {
  if (q.fee.type === 'eip1559') {
    return { perGas: q.fee.maxFeePerGas, label: 'max fee per gas' };
  }
  return { perGas: q.fee.gasPrice, label: 'gas price' };
}

// ---------------------------------------------------------------------------
// Round trip 1: gas, and the per-gas market
// ---------------------------------------------------------------------------

/** Which levels to price, in the caller's order, deduplicated. */
function resolveLevels(requested: readonly EvmFeeLevel[] | undefined): EvmFeeLevel[] {
  if (requested === undefined) return [...EVM_FEE_LEVELS];
  if (requested.length === 0) throw new Error('evm fees: levels must not be empty');
  const chosen: EvmFeeLevel[] = [];
  for (const level of requested) {
    if (!EVM_FEE_LEVELS.includes(level)) {
      throw new Error(`evm fees: unknown fee level ${String(level)}`);
    }
    if (!chosen.includes(level)) chosen.push(level);
  }
  return chosen;
}

async function sendBatch(rpc: EvmRpcClient, calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> {
  try {
    return await rpc.batch(calls);
  } catch (err) {
    // Only a transport failure becomes a quote error. Anything else out of the
    // client is a bug in this wallet and is allowed to surface as one rather
    // than being laundered into "the network is down".
    if (err instanceof EvmRpcUnavailableError) {
      throw new EvmFeeQuoteError('unavailable', err.message);
    }
    throw err;
  }
}

/** The per-gas market, already reduced to one number per requested level. */
interface MarketPrices {
  /** EIP-1559 only: the next block's base fee. Null on a legacy chain. */
  baseFeePerGas: bigint | null;
  /** EIP-1559: the tip for this level. Legacy: the marked-up gasPrice. */
  perLevel: Map<EvmFeeLevel, bigint>;
}

function readFeeHistory(result: unknown, levels: readonly EvmFeeLevel[]): MarketPrices {
  if (!isRecord(result)) throw malformed('eth_feeHistory did not answer with an object');

  const baseFees = result.baseFeePerGas;
  if (!Array.isArray(baseFees) || baseFees.length === 0) {
    throw malformed('eth_feeHistory returned no baseFeePerGas');
  }
  // The array carries blockCount + 1 entries and the LAST one is the base fee
  // of the block that has not been mined yet, which is the block this
  // transaction is aiming at. Using the first (or an average) prices it for
  // the past.
  const baseFeePerGas = quantity(baseFees[baseFees.length - 1], 'baseFeePerGas');

  const rewards = result.reward;
  if (!Array.isArray(rewards) || rewards.length === 0) {
    throw malformed('eth_feeHistory returned no reward rows');
  }

  const perLevel = new Map<EvmFeeLevel, bigint>();
  for (const level of levels) {
    const column = EVM_FEE_LEVELS.indexOf(level);
    const tips: bigint[] = [];
    for (const row of rewards) {
      if (!Array.isArray(row) || row.length !== TIP_PERCENTILES.length) {
        throw malformed(
          `eth_feeHistory reward row does not carry ${TIP_PERCENTILES.length} percentiles`,
        );
      }
      tips.push(quantity(row[column], 'reward'));
    }
    const median = medianOf(tips);
    perLevel.set(level, median > 0n ? median : MIN_TIP_WEI);
  }
  return { baseFeePerGas, perLevel };
}

function readGasPrice(result: unknown, levels: readonly EvmFeeLevel[]): MarketPrices {
  const gasPrice = quantity(result, 'eth_gasPrice');
  const perLevel = new Map<EvmFeeLevel, bigint>();
  for (const level of levels) {
    perLevel.set(level, (gasPrice * LEGACY_PERCENT[level]) / 100n);
  }
  return { baseFeePerGas: null, perLevel };
}

/** The fee this level signs with. Computed before the L1 oracle is asked,
 *  because the oracle has to be asked about the transaction AS PRICED. */
function feeFor(level: EvmFeeLevel, market: MarketPrices): EvmFee {
  const price = market.perLevel.get(level);
  if (price === undefined) throw malformed(`no price computed for level ${level}`);
  if (market.baseFeePerGas === null) {
    return { type: 'legacy', gasPrice: price };
  }
  const maxFeePerGas = BASE_FEE_HEADROOM * market.baseFeePerGas + price;
  if (price > maxFeePerGas) {
    // Unreachable while maxFeePerGas is 2 x baseFee + tip and baseFee >= 0, but
    // asserted anyway: a node that rejects maxPriorityFeePerGas > maxFeePerGas
    // does so AFTER the user has signed, and validateEvmTxRequest would only
    // catch it at signing time.
    throw malformed('priority fee exceeds max fee per gas');
  }
  return { type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas: price };
}

// ---------------------------------------------------------------------------
// Round trip 2: the L1 data fee (OP-stack chains only)
// ---------------------------------------------------------------------------

/** The per-gas price a fee commits to at most (the field the oracle sees). */
function perGasOf(fee: EvmFee): bigint {
  return fee.type === 'eip1559' ? fee.maxFeePerGas : fee.gasPrice;
}

/**
 * ONE oracle call for all requested levels, priced on the level with the
 * LARGEST fee fields. The fee fields are part of the serialized transaction,
 * so strictly each level has its own byte length; but the difference between
 * levels is at most a byte or two of RLP integer (16 L1 gas each), far below
 * the noise of the L1 base fee moving before inclusion, and the largest fields
 * make the single figure an upper bound for the others (never an
 * understatement). It was one call per level until the public Base RPC
 * answered the three-call batch with "-32016 over rate limit" on the owner's
 * first real send: two round trips of one and one call each is what a public
 * endpoint tolerates.
 */
async function readL1DataFees(
  rpc: EvmRpcClient,
  input: EvmFeeQuoteInput,
  gasLimit: bigint,
  fees: Map<EvmFeeLevel, EvmFee>,
  levels: readonly EvmFeeLevel[],
): Promise<Map<EvmFeeLevel, bigint>> {
  let priced: EvmFeeLevel = levels[0];
  for (const level of levels) {
    if (perGasOf(fees.get(level) as EvmFee) > perGasOf(fees.get(priced) as EvmFee)) priced = level;
  }
  const candidate: EvmTxRequest = {
    chainId: rpc.chain.chainId,
    // Nonce 0: this candidate is never broadcast, and the nonce is worth at
    // most 2 bytes of calldata (see TRAP 1).
    nonce: 0n,
    to: input.to,
    value: input.value,
    data: input.data,
    gasLimit,
    fee: fees.get(priced) as EvmFee,
  };
  const signed = signTx(candidate, THROWAWAY_KEY);
  const calls: EvmRpcCall[] = [
    { method: 'eth_call', params: [{ to: GAS_PRICE_ORACLE, data: encodeGetL1Fee(signed.raw) }, 'latest'] },
  ];

  const [result] = await sendBatch(rpc, calls);
  if (!result.ok) {
    // A Base preview without its L1 part is a wrong number, not a partial
    // one, so there is no "show what we have" branch here. The node's own
    // words ride along: a rate limit and a revert need different reactions.
    throw malformed(`l1 fee oracle refused: ${result.error.message}`);
  }
  let l1: bigint;
  try {
    l1 = decodeUint256(result.result as string);
  } catch (err) {
    throw malformed(`l1 fee oracle answered unreadable data: ${errorText(err)}`);
  }
  const out = new Map<EvmFeeLevel, bigint>();
  for (const level of levels) out.set(level, l1);
  return out;
}

// ---------------------------------------------------------------------------
// The quote
// ---------------------------------------------------------------------------

/**
 * Price one transaction at every requested level.
 *
 * Two round trips at most, both read-only:
 *   1. eth_estimateGas + (eth_feeHistory | eth_gasPrice), in one batch;
 *   2. on an l1DataFee chain only, ONE eth_call to the GasPriceOracle, priced
 *      on the level with the largest fee fields and shared by every level.
 *
 * The chain, and therefore the strategy, comes from rpc.chain: there is no
 * chain-name branching anywhere in this file, exactly as feePolicy.ts has none.
 */
export function quoteEvmFees(
  rpc: EvmRpcClient,
  input: EvmFeeQuoteInput,
): Promise<Record<EvmFeeLevel, EvmFeeQuote>>;
export function quoteEvmFees(
  rpc: EvmRpcClient,
  input: EvmFeeQuoteInput,
  opts: { levels?: readonly EvmFeeLevel[] },
): Promise<Partial<Record<EvmFeeLevel, EvmFeeQuote>>>;
export async function quoteEvmFees(
  rpc: EvmRpcClient,
  input: EvmFeeQuoteInput,
  opts: { levels?: readonly EvmFeeLevel[] } = {},
): Promise<Partial<Record<EvmFeeLevel, EvmFeeQuote>>> {
  // Local validation first, so a malformed request never becomes a request to
  // a public node. These are plain Errors: they are faults in the caller, not
  // a state of the network that the UI should render.
  requireAddress(input.from, 'from');
  requireAddress(input.to, 'to');
  if (typeof input.value !== 'bigint') throw new Error('evm fees: value must be a bigint');
  if (input.value < 0n) throw new Error('evm fees: value must not be negative');
  if (!(input.data instanceof Uint8Array)) throw new Error('evm fees: data must be a Uint8Array');

  const levels = resolveLevels(opts.levels);
  const chain = rpc.chain;
  const eip1559 = chain.feeModel === 'eip1559';

  const estimateCall: EvmRpcCall = {
    method: 'eth_estimateGas',
    params: [
      {
        from: input.from,
        to: input.to,
        value: toQuantity(input.value),
        // Always present, always valid: '0x' is the empty calldata of a native
        // transfer, and sending the field unconditionally is one shape instead
        // of two.
        data: toHexData(input.data),
      },
    ],
  };
  const marketCall: EvmRpcCall = eip1559
    ? {
        method: 'eth_feeHistory',
        params: [toQuantity(FEE_HISTORY_BLOCKS), 'latest', [...TIP_PERCENTILES]],
      }
    : { method: 'eth_gasPrice', params: [] };

  const [estimateResult, marketResult] = await sendBatch(rpc, [estimateCall, marketCall]);

  if (!estimateResult.ok) {
    // The node ran the transaction and it failed. Its message is the useful
    // half ("insufficient funds for gas * price + value", "execution
    // reverted"), so it is carried through verbatim rather than replaced.
    throw new EvmFeeQuoteError('estimate-reverted', estimateResult.error.message);
  }
  if (!marketResult.ok) {
    // A refusal here is not a revert (nothing was executed) and not offline
    // (the node answered). It is fee data that cannot be used.
    throw malformed(marketResult.error.message);
  }

  const gasEstimate = quantity(estimateResult.result, 'eth_estimateGas');
  const gasLimit = gasLimitFor(gasEstimate);
  const market = eip1559
    ? readFeeHistory(marketResult.result, levels)
    : readGasPrice(marketResult.result, levels);

  const fees = new Map<EvmFeeLevel, EvmFee>();
  for (const level of levels) fees.set(level, feeFor(level, market));

  const l1Fees =
    chain.l1DataFee === 'optimism'
      ? await readL1DataFees(rpc, input, gasLimit, fees, levels)
      : new Map<EvmFeeLevel, bigint>();

  const quotes: Partial<Record<EvmFeeLevel, EvmFeeQuote>> = {};
  for (const level of levels) {
    const fee = fees.get(level) as EvmFee;
    const l1DataFee = l1Fees.get(level) ?? 0n;
    // The likely charge uses baseFee + tip; the ceiling uses maxFeePerGas. On
    // legacy there is one price, so the two coincide (TRAP 2).
    const likelyPerGas =
      fee.type === 'eip1559' ? (market.baseFeePerGas ?? 0n) + fee.maxPriorityFeePerGas : fee.gasPrice;
    const maxPerGas = fee.type === 'eip1559' ? fee.maxFeePerGas : fee.gasPrice;
    quotes[level] = {
      level,
      fee,
      gasLimit,
      gasEstimate,
      baseFeePerGas: market.baseFeePerGas,
      l1DataFee,
      estimatedTotal: gasLimit * likelyPerGas + l1DataFee,
      maxTotal: gasLimit * maxPerGas + l1DataFee,
    };
  }
  return quotes;
}
