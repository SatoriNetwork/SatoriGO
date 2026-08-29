// How an Activity row reads when the transaction was a NATIVE STAKING call.
//
// The owner's ask (2026-08-24): "w activity powinna byc historia co staked co
// nie i gdzie" - Activity must say which transaction staked, which unstaked,
// and WITH WHOM. A staking call has value 0 and a `to` that is a precompile, so
// without this it lists as "Sent 0 EPIX to 0x...0800", which says nothing.
//
// PURE, and shared by every surface that renders a row (the Activity list, the
// asset detail list, the transaction detail), so the three cannot disagree.
// The type import is erased at compile time: nothing here pulls the EVM engine
// into a build made without it.

import { formatListAmount } from '../../services/chain/amounts';
import type { StakingCallInfo } from '../../services/chain/evm/cosmosStaking';

/** What a row shows for a staking transaction. */
export interface StakingRowLabel {
  kind: StakingCallInfo['kind'];
  /** "Staked" / "Unstaked" / "Redelegated" / "Claimed rewards". */
  title: string;
  /** The validator, by name where the chain gave us one: a moniker, a shortened
   *  operator address otherwise, and "A to B" for a move between two. */
  subtitle: string;
  /** "12.5 EPIX", or '' when the amount is not known. A claim's amount is not
   *  in its calldata (the chain pays whatever accrued); it is read from the
   *  confirmed transaction's receipt, so it is missing while the transaction is
   *  pending and appears once it confirms. Zero also reads as '': a claim that
   *  withdrew nothing must not print "0 EPIX". */
  amountText: string;
  /** Which way the arrow points. Rewards come IN, the other three go out. It is
   *  never painted as a received payment: nothing arrived from a stranger. */
  incoming: boolean;
}

/** 'epixvaloper1qxt7awul3cyvgf2ku08k3n3nqn7lsqvsm7ryjw' ->
 *  'epixvaloper1qx...m7ryjw'. Same shape the review step uses
 *  (cosmosStaking.ts describeValidator), so one validator reads the same in
 *  both places. */
export function shortValoper(valoper: string): string {
  if (typeof valoper !== 'string') return '';
  return valoper.length > 22 ? `${valoper.slice(0, 14)}...${valoper.slice(-6)}` : valoper;
}

/** A validator's moniker when the validators cache holds one, else the
 *  shortened operator address. Never the empty string: a row with no name still
 *  has to say WHERE the stake went. */
export function validatorName(valoper: string, monikerOf?: (valoper: string) => string | undefined): string {
  const moniker = monikerOf?.(valoper)?.trim();
  return moniker ? moniker : shortValoper(valoper);
}

const TITLES: Readonly<Record<StakingCallInfo['kind'], string>> = Object.freeze({
  stake: 'Staked',
  unstake: 'Unstaked',
  redelegate: 'Redelegated',
  claim: 'Claimed rewards',
});

/**
 * The row text for one decoded staking call.
 *
 * `monikerOf` is the evmStaking validators cache. It is OPTIONAL and may answer
 * nothing: Activity can render before that list has loaded, and a row must read
 * correctly meanwhile (the operator address is the identity anyway; a moniker
 * is a label the validator chose for itself).
 */
export function stakingRowLabel(
  staking: StakingCallInfo,
  opts: { ticker: string; decimals: number; monikerOf?: (valoper: string) => string | undefined },
): StakingRowLabel {
  const from = validatorName(staking.validator, opts.monikerOf);
  const subtitle =
    staking.kind === 'redelegate' && staking.validatorDst
      ? `${from} to ${validatorName(staking.validatorDst, opts.monikerOf)}`
      : from;
  // Formatted from the exact base units, never from a float: the calldata's for
  // a stake / unstake / redelegate, the receipt's reward event for a claim. An
  // unknown amount and a zero one both print NOTHING: "Claimed rewards 0 EPIX"
  // would be a figure the transaction never carried.
  const amountText =
    staking.amountBase === undefined || staking.amountBase === 0n
      ? ''
      : `${formatListAmount(staking.amountBase, opts.decimals)} ${opts.ticker}`;
  return { kind: staking.kind, title: TITLES[staking.kind], subtitle, amountText, incoming: staking.kind === 'claim' };
}
