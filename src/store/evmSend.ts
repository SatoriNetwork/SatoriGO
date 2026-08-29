// The EVM send path (phase 3): plan, then broadcast. One builder, every caller.
//
// the EVM engine design notes, section 10, lesson 3: transactions are built HERE,
// never in a screen. The send screen hands over text (recipient, amount, which
// asset, which fee level) and gets back a plan it can only display and confirm.
// When the dApp surface arrives (phase 5) it becomes a second SOURCE of the same
// EvmTxRequest, not a second builder.
//
// The order inside broadcastEvmPlan is the order that keeps funds safe:
//   gate  -> caps -> nonce -> sign -> eth_sendRawTransaction -> nonce.sent()
// and any failure before the node accepted the bytes releases the nonce.
//
// Everything EVM is reached through loadEvmModules() (the build flag). The
// type-only imports below are erased at compile time.

import { loadEvmModules } from '../services/chain/engine';
import { formatAmount, parseAmount } from '../services/chain/amounts';
import { displaySymbol } from '../services/displaySymbol';
import type { EvmWalletDataProvider } from '../services/chain/evm/evmProvider';
import type { EvmFeeLevel, EvmFeeQuote } from '../services/chain/evm/fees';
import type { EvmTxRequest, SignedEvmTx } from '../services/chain/evm/tx';
import type { EvmNonceTracker } from '../services/chain/evm/nonce';
import type { EvmChainInfo } from './evmChains';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';

/** What the user is sending: the chain's coin, or an ERC-20 by CONTRACT. */
export type EvmSendAsset =
  | { kind: 'native'; ticker: string; decimals: number }
  | { kind: 'token'; address: string; symbol: string; decimals: number };

export interface EvmSendInput {
  to: string;
  /** As typed. Parsed exactly at the asset's decimals, never through a float. */
  amountText: string;
  /** The chain's native ticker (e.g. 'ETH'), or a token CONTRACT address. */
  assetId: string;
  level?: EvmFeeLevel;
}

export interface EvmSendPlan {
  chainKey: string;
  chainId: number;
  from: string;
  /** EIP-55 form of the recipient. */
  to: string;
  asset: EvmSendAsset;
  amountBase: bigint;
  amountText: string;
  level: EvmFeeLevel;
  /** Every level, so switching in the UI needs no new quote (the gas estimate
   *  and the fee market are the same for all three). */
  quotes: Record<EvmFeeLevel, EvmFeeQuote>;
  /** The quote for `level`. */
  quote: EvmFeeQuote;
  /** The transaction to sign, minus the nonce, which is reserved at broadcast. */
  unsigned: Omit<EvmTxRequest, 'nonce'>;
  /** Null when the balances cover amount + worst-case fee; else the reason. */
  shortfall: string | null;
  /** Fee-cap verdict for `level`: null when within caps, else the refusal text.
   *  A capped plan can be displayed but never broadcast. */
  capRefusal: string | null;
}

export class EvmSendError extends Error {
  readonly code:
    | 'no-engine'
    | 'invalid-address'
    | 'invalid-amount'
    | 'unknown-asset'
    | 'quote-failed'
    | 'insufficient'
    | 'fee-cap'
    | 'gated'
    | 'broadcast-failed';
  constructor(code: EvmSendError['code'], message: string) {
    super(message);
    this.name = 'EvmSendError';
    this.code = code;
  }
}

/** A node's revert text, without the raw ABI-encoded error data it appends
 *  ("…: 0x08c379a0000…" is the same message again, as bytes): the words are
 *  what the user can act on (e.g. a token's "Transfer amount exceeds the
 *  maxTxAmount", its own per-transaction limit). */
export function revertReason(detail: string): string {
  return detail.replace(/:?\s*0x[0-9a-fA-F]{8,}(\.\.\.)?(\s*\(\d+ chars\))?\s*$/, '').trim();
}

/** Resolve `assetId` against the chain and the balances on screen. */
export function resolveEvmSendAsset(
  chain: EvmChainInfo,
  assetId: string,
  assets: readonly LiveAssetBalance[],
  isAddress: (s: string) => boolean,
  /** Tokens the account tracks or discovered, besides the chain's defaults. */
  extraTokens: ReadonlyArray<{ address: string; symbol?: string; decimals?: number }> = [],
): EvmSendAsset | null {
  if (assetId.toUpperCase() === chain.nativeTicker.toUpperCase()) {
    return { kind: 'native', ticker: chain.nativeTicker, decimals: chain.nativeDecimals };
  }
  if (!isAddress(assetId)) return null;
  const lower = assetId.toLowerCase();
  const known =
    chain.defaultTokens.find((t) => t.address.toLowerCase() === lower) ??
    extraTokens.find((t) => t.address.toLowerCase() === lower) ??
    null;
  // The balance row (if the token is tracked and was read) carries the chain's
  // own symbol/decimals; the registry hint is the fallback; without either the
  // token cannot be scaled and is refused.
  const row = assets.find((a) => !a.isNative && a.name === (known?.symbol ?? '__none__'));
  const decimals = row?.decimals ?? known?.decimals;
  const symbol = row?.name ?? known?.symbol;
  if (decimals === undefined || symbol === undefined) return null;
  return { kind: 'token', address: assetId, symbol, decimals };
}

/**
 * Build a plan: parse, resolve the asset, quote every fee level (with the L1
 * surcharge where the chain has one), check the caps and the balances. Pure
 * apart from the two RPC round trips inside quoteEvmFees. Throws EvmSendError.
 */
export async function buildEvmSendPlan(args: {
  provider: EvmWalletDataProvider;
  chain: EvmChainInfo;
  from: string;
  assets: readonly LiveAssetBalance[];
  input: EvmSendInput;
  /** Tokens the account tracks or discovered (contract-keyed), so an imported
   *  or added token is sendable, not only the chain's defaults. */
  extraTokens?: ReadonlyArray<{ address: string; symbol?: string; decimals?: number }>;
}): Promise<EvmSendPlan> {
  const evm = await loadEvmModules();
  if (!evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
  const { provider, chain, from, assets, input, extraTokens = [] } = args;

  if (!evm.isEvmAddress(input.to.trim())) {
    throw new EvmSendError(
      'invalid-address',
      'Enter a valid EVM address: 0x followed by 40 hex characters (mixed case must carry a valid checksum).',
    );
  }
  const to = evm.normalizeEvmAddress(input.to.trim());

  const asset = resolveEvmSendAsset(chain, input.assetId, assets, evm.isEvmAddress, extraTokens);
  if (!asset) throw new EvmSendError('unknown-asset', `Unknown asset on ${chain.displayName}: ${input.assetId}`);

  let amountBase: bigint;
  try {
    amountBase = parseAmount(input.amountText, asset.decimals);
  } catch (err) {
    throw new EvmSendError('invalid-amount', err instanceof Error ? err.message : String(err));
  }
  if (amountBase <= 0n) throw new EvmSendError('invalid-amount', 'Enter an amount greater than zero.');

  // One model for both: an ERC-20 transfer is a zero-value call carrying data.
  const value = asset.kind === 'native' ? amountBase : 0n;
  const data = asset.kind === 'native' ? new Uint8Array() : evm.encodeTransfer(to, amountBase);
  const callTo = asset.kind === 'native' ? to : asset.address;

  let quotes: Record<EvmFeeLevel, EvmFeeQuote>;
  try {
    quotes = await evm.quoteEvmFees(provider.rpc, { from, to: callTo, value, data });
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

  const level: EvmFeeLevel = input.level ?? 'normal';
  const quote = quotes[level];
  const unsigned: Omit<EvmTxRequest, 'nonce'> = {
    chainId: chain.chainId,
    to: callTo,
    value,
    data,
    gasLimit: quote.gasLimit,
    fee: quote.fee,
  };

  return {
    chainKey: chain.key,
    chainId: chain.chainId,
    from,
    to,
    asset,
    amountBase,
    amountText: input.amountText.trim(),
    level,
    quotes,
    quote,
    unsigned,
    shortfall: shortfallFor(chain, asset, amountBase, quote, assets),
    capRefusal: capRefusalFor(evm, chain.key, quote),
  };
}

/** Re-derive the level-dependent parts of a plan without a new quote. */
export async function withEvmFeeLevel(plan: EvmSendPlan, level: EvmFeeLevel, chain: EvmChainInfo, assets: readonly LiveAssetBalance[]): Promise<EvmSendPlan> {
  const evm = await loadEvmModules();
  if (!evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
  const quote = plan.quotes[level];
  return {
    ...plan,
    level,
    quote,
    unsigned: { ...plan.unsigned, gasLimit: quote.gasLimit, fee: quote.fee },
    shortfall: shortfallFor(chain, plan.asset, plan.amountBase, quote, assets),
    capRefusal: capRefusalFor(evm, chain.key, quote),
  };
}

function nativeBalance(chain: EvmChainInfo, assets: readonly LiveAssetBalance[]): bigint | null {
  const row = assets.find((a) => a.isNative && a.name === chain.nativeTicker);
  return row ? row.amountBase : null;
}

function shortfallFor(
  chain: EvmChainInfo,
  asset: EvmSendAsset,
  amountBase: bigint,
  quote: EvmFeeQuote,
  assets: readonly LiveAssetBalance[],
): string | null {
  const native = nativeBalance(chain, assets);
  // Balances unknown (never refreshed): do not block, the node's estimateGas
  // already refused an unfunded native send, and the token contract will
  // refuse an unfunded token send at simulation. Say nothing rather than guess.
  if (native === null) return null;
  const t = chain.nativeTicker;
  const fmt = (v: bigint) => formatAmount(v, chain.nativeDecimals);
  if (asset.kind === 'native') {
    if (amountBase + quote.maxTotal > native) {
      // The numbers, so the user can see WHICH side is short: sending the whole
      // balance is the usual cause, and Max is the answer to that.
      return `Not enough ${t}: ${fmt(amountBase)} plus the maximum fee ${fmt(quote.maxTotal)} exceeds the balance ${fmt(native)} ${t}. Use Max to send the most that fits.`;
    }
    return null;
  }
  if (quote.maxTotal > native) {
    return `Not enough ${t} to pay the network fee: the fee can reach ${fmt(quote.maxTotal)} ${t}, the balance is ${fmt(native)} ${t}.`;
  }
  const tokenRow = assets.find((a) => !a.isNative && a.name === asset.symbol);
  if (tokenRow && amountBase > tokenRow.amountBase) {
    // The symbol is rendered into a sentence the wallet wrote, so it is drawn
    // safely; the lookup above still matches on the raw one.
    const shown = displaySymbol(asset.symbol);
    return `Not enough ${shown}: ${formatAmount(amountBase, asset.decimals)} exceeds the balance ${formatAmount(tokenRow.amountBase, asset.decimals)} ${shown}.`;
  }
  return null;
}

type EvmMods = NonNullable<Awaited<ReturnType<typeof loadEvmModules>>>;

function capRefusalFor(evm: EvmMods, chainKey: string, quote: EvmFeeQuote): string | null {
  try {
    evm.assertEvmFeeWithinCaps(chainKey, { fee: quote.fee, maxTotal: quote.maxTotal });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The subset of a plan the broadcast path actually reads. `EvmSendPlan`
 * satisfies it, and so does `EvmCallPlan` (store/evmCall.ts, the generic
 * contract call behind native staking and, later, the dApp surface): there is
 * ONE place where a key meets a nonce and a node, and widening this type is how
 * a second plan shape reuses it instead of copying it.
 */
export interface BroadcastableEvmPlan {
  chainKey: string;
  chainId: number;
  from: string;
  unsigned: Omit<EvmTxRequest, 'nonce'>;
  quote: Pick<EvmFeeQuote, 'maxTotal'>;
  /** Non-null when the account cannot cover this transaction; refuses here too,
   *  not only in the UI. */
  shortfall: string | null;
}

/**
 * Sign and broadcast a plan. `sign` is the service's signEvmTransaction (the
 * key never comes here); `allowBroadcast` is the same explicit arming gate the
 * UTXO path uses. Returns the txid the node accepted.
 */
export async function broadcastEvmPlan(args: {
  provider: EvmWalletDataProvider;
  plan: BroadcastableEvmPlan;
  nonces: EvmNonceTracker;
  sign: (request: EvmTxRequest) => SignedEvmTx;
  allowBroadcast: boolean;
}): Promise<{ txid: string; nonce: bigint; rawHex: string }> {
  const evm = await loadEvmModules();
  if (!evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
  const { provider, plan, nonces, sign, allowBroadcast } = args;

  if (!allowBroadcast) {
    throw new EvmSendError('gated', 'Broadcast is disabled. Live sending must be explicitly armed (mainnet safety gate).');
  }
  if (plan.shortfall) throw new EvmSendError('insufficient', plan.shortfall);
  // Re-check the caps at the moment of signing, never trust the plan's verdict
  // alone: the plan is data that crossed the UI.
  evm.assertEvmFeeWithinCaps(plan.chainKey, { fee: plan.unsigned.fee, maxTotal: plan.quote.maxTotal });

  const reservation = await nonces.reserve(provider.rpc, plan.from);
  let accepted = false;
  try {
    const request: EvmTxRequest = { ...plan.unsigned, nonce: reservation.nonce };
    evm.validateEvmTxRequest(request);
    const signed = sign(request);
    // Belt and braces on the money path: what we are about to broadcast decodes
    // back to what the user confirmed, and was signed by the account.
    const decoded = evm.decodeSignedTx(signed.raw);
    if (
      decoded.tx.chainId !== plan.chainId ||
      decoded.tx.to.toLowerCase() !== plan.unsigned.to.toLowerCase() ||
      decoded.tx.value !== plan.unsigned.value ||
      evm.toHexData(decoded.tx.data) !== evm.toHexData(plan.unsigned.data)
    ) {
      throw new EvmSendError('broadcast-failed', 'Signed transaction does not match the confirmed plan; nothing was sent.');
    }
    let txid: string;
    try {
      txid = (await provider.rpc.call<string>('eth_sendRawTransaction', [signed.rawHex])) ?? '';
    } catch (err) {
      if (err instanceof evm.EvmRpcError) {
        throw new EvmSendError('broadcast-failed', `${provider.chain.displayName} rejected the transaction: ${err.message}`);
      }
      if (err instanceof evm.EvmRpcUnavailableError) {
        throw new EvmSendError('broadcast-failed', `${provider.chain.displayName} is unreachable; the transaction was not sent.`);
      }
      throw err;
    }
    if (typeof txid !== 'string' || txid.toLowerCase() !== signed.hash.toLowerCase()) {
      // The node accepted SOMETHING but not under the hash we computed: treat as
      // sent (the bytes left us) and surface our own hash, which is what the
      // explorer will show for these bytes.
      txid = signed.hash;
    }
    accepted = true;
    reservation.sent();
    return { txid, nonce: reservation.nonce, rawHex: signed.rawHex };
  } finally {
    if (!accepted) reservation.release();
  }
}
