// Indexer rows -> LiveTransaction rows, for ONE account on ONE EVM chain.
//
// This is the EVM counterpart of the Electrum tx classifier: it takes the raw
// shape an Etherscan-family indexer returns (a list of mined transactions plus
// a list of ERC-20 Transfer log rows) and turns it into the same
// `LiveTransaction` shape the UTXO chains already produce, so the Activity list
// and its merge/sort code do not need to know which chain family a wallet is
// on.
//
// PURE. No network, no store import. `amountToNumber` is DISPLAY-ONLY (see
// `amounts.ts`): every `amount`/`feeEvr`/`spentNative`/`totalOutNative` below
// is a JS number meant for the Activity list and nowhere else. Never feed one
// back into building a transaction; the send path works in bigint base units.

import type { LiveTransaction } from '../../electrumProvider';
import { amountToNumber } from '../../amounts';
import { toChecksumAddress } from '../keys';
import { decodeStakingCallHex, isStakingPrecompileAddress, type StakingCallInfo } from '../cosmosStaking';
import type { IndexedTx, IndexedTokenTransfer } from './etherscan';

/** The two precompile addresses of a chain with native staking, all this
 *  module needs from the registry's `staking` row. */
export type EvmStakingPrecompiles = { stakingPrecompile: string; distributionPrecompile: string };

export interface EvmActivityInput {
  /** The account this activity is being classified relative to, any case. */
  address: string;
  /** 'ETH' / 'BNB': the chain's native coin ticker. */
  nativeTicker: string;
  /** The native coin's decimals (18 on every chain today). */
  nativeDecimals: number;
  txs: readonly IndexedTx[];
  tokenTransfers: readonly IndexedTokenTransfer[];
  /** Block height of the chain tip, if known.
   *
   *  Unused by this function on purpose: the indexer's txlist/tokentx
   *  endpoints only ever return MINED rows, so every row `mapEvmActivity`
   *  produces is 'confirmed' already. 'pending' only ever comes from
   *  `localPendingEvmTx`, for a send this wallet just broadcast that no
   *  indexer has reported yet. Kept on the input so a future caller that
   *  wants a "N confirmations" style computation has the tip on hand without
   *  a signature change. */
  tipBlock?: bigint;
  /** The chain's native-staking precompiles, when it has them (Epix). ABSENT on
   *  every other chain, and its absence is the capability test: without it this
   *  function behaves exactly as it did before, and no row can ever be labelled
   *  a staking row. Never a chain-name check. */
  staking?: EvmStakingPrecompiles;
}

/** True when this transaction was sent to one of the chain's staking
 *  precompiles. False on every chain without a `staking` row, which is the
 *  capability test the whole label keys off. */
function isStakingCall(input: EvmActivityInput, tx: IndexedTx): boolean {
  return input.staking !== undefined && isStakingPrecompileAddress(input.staking, tx.to);
}

/**
 * Indexer rows for `input.address` -> wallet-Activity rows for that one
 * account, deduped and sorted newest first.
 *
 * See the numbered rules in this file's tests for the exact per-row mapping;
 * this docstring only covers the shape.
 */
export function mapEvmActivity(input: EvmActivityInput): LiveTransaction[] {
  const us = input.address.trim().toLowerCase();

  // Hash -> tx, so a token-transfer row can find the transaction that carried
  // it (for fee attribution) and so a repeated txlist page collapses for
  // free. Etherscan-family hashes are lowercase hex already; lowercasing here
  // too is just defence against a host that is not.
  const txByHash = new Map<string, IndexedTx>();
  for (const tx of input.txs) txByHash.set(tx.hash.toLowerCase(), tx);

  // Hashes that already produced a token row: rule 4 must not ALSO emit a
  // bare "contract interaction" row for the same tx (the token row already
  // carries the fee it needs).
  const hashesWithTokenRows = new Set<string>();
  for (const t of input.tokenTransfers) hashesWithTokenRows.add(t.hash.toLowerCase());

  const rows: LiveTransaction[] = [];

  // --- Rule 2: token transfers, one row per IndexedTokenTransfer touching us.
  for (const t of input.tokenTransfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from !== us && to !== us) continue; // not ours, should not happen but stay honest

    // General case: direction follows which side we are on. Special case: a
    // self-transfer (from === to === us) has no "other side" to be 'in' from,
    // so it is reported as 'out' with counterparty us, same as the general
    // formula would give for an ordinary send.
    const direction: 'in' | 'out' = from === us && to === us ? 'out' : to === us ? 'in' : 'out';
    const counterparty = toChecksumAddress(direction === 'in' ? t.from : t.to);

    const asset =
      t.tokenSymbol !== ''
        ? t.tokenSymbol
        : `0x${t.contractAddress.slice(2, 6)}…${t.contractAddress.slice(-4)}`;
    const amount = amountToNumber(t.value, t.tokenDecimal);

    // We only ever pay the native fee when WE sent the enclosing transaction,
    // never merely because a transfer we received happened to be inside one.
    const enclosing = txByHash.get(t.hash.toLowerCase());
    const feeEvr =
      enclosing != null && enclosing.from.toLowerCase() === us
        ? amountToNumber(
            enclosing.gasUsed * enclosing.gasPrice + (enclosing.l1Fee ?? 0n),
            input.nativeDecimals,
          )
        : 0;

    rows.push({
      txid: t.hash,
      asset,
      direction,
      amount,
      feeEvr,
      status: 'confirmed',
      blockHeight: Number(t.blockNumber),
      timestamp: t.timestamp,
      counterparty,
    });
  }

  // --- Rules 3-5: native transfers and contract interactions, one row per
  // mined transaction (deduped by hash first, so a repeated txlist page never
  // doubles up here even before the final dedupe pass).
  for (const tx of txByHash.values()) {
    const from = tx.from.toLowerCase();
    const isSender = from === us;
    const fee = tx.gasUsed * tx.gasPrice + (tx.l1Fee ?? 0n);
    const feeEvr = isSender ? amountToNumber(fee, input.nativeDecimals) : 0;
    const hasTokenRows = hashesWithTokenRows.has(tx.hash.toLowerCase());

    if (tx.value > 0n) {
      // Rule 3: native transfer. Kept alongside any token row(s) for the same
      // hash (different asset, so dedupe below never collapses them).
      const direction: 'in' | 'out' = isSender ? 'out' : 'in';
      const counterpartyRaw =
        direction === 'out' ? (tx.to ?? tx.contractAddress ?? tx.from) : tx.from;
      const counterparty = toChecksumAddress(counterpartyRaw);

      // Rule 5: a failed tx moved nothing on chain, however big `value` reads.
      // The fee is still real (it is what failure cost the sender), so only
      // the moved-value fields collapse to zero/fee-only; direction and
      // counterparty describe what the transaction ATTEMPTED and stay as
      // computed above.
      const moved = !tx.isError;
      const amount = moved ? amountToNumber(tx.value, input.nativeDecimals) : 0;
      const spentNative = isSender
        ? amountToNumber(fee + (moved ? tx.value : 0n), input.nativeDecimals)
        : 0;
      const totalOutNative = moved ? amountToNumber(tx.value, input.nativeDecimals) : 0;

      rows.push({
        txid: tx.hash,
        asset: input.nativeTicker,
        direction,
        amount,
        feeEvr,
        spentNative,
        totalOutNative,
        status: 'confirmed',
        blockHeight: Number(tx.blockNumber),
        timestamp: tx.timestamp,
        counterparty,
      });
    } else if (isSender && !hasTokenRows && (tx.input.length > 2 || isStakingCall(input, tx))) {
      // Rule 4: a contract interaction with no value and no token row of its
      // own (an approve, or a plain call) still shows up, because a fee was
      // paid for it. Failed here means amount stays 0 same as success (there
      // was never a moved amount to zero out); the fee line is what matters.
      //
      // A NATIVE-STAKING call is the one case where an EMPTY `input` still
      // earns a row: a delegation moves coins through the Cosmos module, so
      // `value` is 0, and the source Epix history comes through carries no
      // calldata at all. Dropping it would hide a stake, an unstake and a claim
      // from Activity entirely. The label is filled in later (the store fetches
      // the real calldata once per transaction, see store/evmHistory.ts); when
      // the row DOES arrive with its calldata it is decoded right here, with no
      // extra request.
      const counterparty = toChecksumAddress(tx.to ?? tx.contractAddress ?? tx.from);
      const staking = isStakingCall(input, tx) ? decodeStakingCallHex(tx.input) : null;
      rows.push({
        txid: tx.hash,
        asset: input.nativeTicker,
        direction: 'out',
        amount: 0,
        feeEvr,
        spentNative: amountToNumber(fee, input.nativeDecimals),
        totalOutNative: 0,
        status: 'confirmed',
        blockHeight: Number(tx.blockNumber),
        timestamp: tx.timestamp,
        counterparty,
        ...(staking ? { staking } : {}),
      });
    }
    // Else: value === 0n and (from !== us, or input is empty, or a token row
    // already covers this hash). Nothing moved, we did not pay for it, or it
    // is already represented: dropped.
  }

  // --- Rule 6: dedupe by (hash, asset, direction), first occurrence wins.
  const deduped = new Map<string, LiveTransaction>();
  for (const row of rows) {
    const key = `${row.txid.toLowerCase()}|${row.asset}|${row.direction}`;
    if (!deduped.has(key)) deduped.set(key, row);
  }

  // --- Rule 7: newest first.
  return [...deduped.values()].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    const bh = b.blockHeight ?? 0;
    const ah = a.blockHeight ?? 0;
    if (bh !== ah) return bh - ah;
    if (a.txid < b.txid) return -1;
    if (a.txid > b.txid) return 1;
    return 0;
  });
}

/**
 * A `LiveTransaction` for a send this wallet just broadcast, before any
 * indexer has reported it. Mirrors what `mapEvmActivity` will eventually
 * produce for the same transaction, so the Activity row does not visibly
 * change shape when the real one replaces it.
 */
export function localPendingEvmTx(args: {
  txid: string;
  from: string;
  to: string;
  /** Ticker or token symbol. */
  asset: string;
  decimals: number;
  amountBase: bigint;
  /** What this transaction is EXPECTED to cost in native fee (the quote's
   *  estimatedTotal), never the worst case it reserved: this row is replaced by
   *  the indexer's real gasUsed x gasPrice within a block or two, and until then
   *  the closer figure is the honest one. */
  feeBase: bigint;
  nativeDecimals: number;
  nativeTicker: string;
  timestamp: number;
  /** Native staking only: what the call this wallet just broadcast does. Passed
   *  in already decoded, so the Activity label is right the moment the
   *  transaction is sent instead of waiting for an indexer that has not seen
   *  it yet (and, on Epix, would report it without its calldata anyway). */
  staking?: StakingCallInfo;
}): LiveTransaction {
  const isNative = args.asset === args.nativeTicker;
  const amount = amountToNumber(args.amountBase, args.decimals);
  const feeEvr = amountToNumber(args.feeBase, args.nativeDecimals);

  return {
    txid: args.txid,
    asset: args.asset,
    direction: 'out',
    amount,
    feeEvr,
    spentNative: isNative ? amount + feeEvr : feeEvr,
    totalOutNative: isNative ? amount : 0,
    status: 'pending',
    timestamp: args.timestamp,
    counterparty: toChecksumAddress(args.to),
    ...(args.staking ? { staking: args.staking } : {}),
  };
}
