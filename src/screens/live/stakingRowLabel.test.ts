// The shared text of a native-staking Activity row.
//
// Pure, and used by three surfaces (the Activity list, the asset detail list,
// the transaction detail), so what it decides is what all three show.

import { describe, expect, it } from 'vitest';
import { stakingRowLabel, shortValoper, validatorName } from './stakingRowLabel';
import type { StakingCallInfo } from '../../services/chain/evm/cosmosStaking';

const VALOPER = 'epixvaloper1lxn5tg46sude4e0y568mu6ek89ljqjz3m0he4x';
const VALOPER_2 = 'epixvaloper1j4s5hgw5uq8x6p8afff8d94ap4y4r0rhjlrklv';
const EPIX = { ticker: 'EPIX', decimals: 18 };
const label = (staking: StakingCallInfo, monikerOf?: (v: string) => string | undefined) =>
  stakingRowLabel(staking, { ...EPIX, ...(monikerOf ? { monikerOf } : {}) });

describe('stakingRowLabel', () => {
  it('names the action and the validator, and a redelegate reads "A to B" in that order', () => {
    expect(label({ kind: 'stake', validator: VALOPER, amountBase: 10n ** 19n })).toMatchObject({
      title: 'Staked',
      amountText: '10 EPIX',
      incoming: false,
    });
    expect(label({ kind: 'unstake', validator: VALOPER, amountBase: 10n ** 19n }).title).toBe('Unstaked');
    const moved = label({ kind: 'redelegate', validator: VALOPER, validatorDst: VALOPER_2, amountBase: 1n }, (v) =>
      v === VALOPER ? 'Alpha' : 'Beta',
    );
    expect(moved.title).toBe('Redelegated');
    expect(moved.subtitle).toBe('Alpha to Beta');
  });

  it("a claim shows the amount its RECEIPT reported, and points the arrow inwards", () => {
    // The owner's real claim: 0.0440086 EPIX, read from the receipt's
    // WithdrawDelegatorReward event (store/evmHistory.ts fills this in).
    const claimed = label({ kind: 'claim', validator: VALOPER, amountBase: 44_008_664_215_885_200n });
    expect(claimed.title).toBe('Claimed rewards');
    expect(claimed.amountText).toBe('0.0440086 EPIX');
    expect(claimed.incoming).toBe(true);
  });

  it('an unknown amount and an exact zero both print NOTHING, never "0 EPIX"', () => {
    // Pending, or the receipt not read yet: the row says what happened, with no
    // figure. A claim of nothing (a reverted call, or no rewards accrued) reads
    // the same, because "0 EPIX" is a figure the transaction never carried.
    expect(label({ kind: 'claim', validator: VALOPER }).amountText).toBe('');
    expect(label({ kind: 'claim', validator: VALOPER, amountBase: 0n }).amountText).toBe('');
    // The title still stands on its own, which is what the detail screen shows
    // in place of an amount.
    expect(label({ kind: 'claim', validator: VALOPER, amountBase: 0n }).title).toBe('Claimed rewards');
  });

  it('the validator is named by its moniker when one is known, and by a shortened operator address otherwise', () => {
    expect(label({ kind: 'claim', validator: VALOPER }).subtitle).toBe(shortValoper(VALOPER));
    expect(label({ kind: 'claim', validator: VALOPER }, () => 'Satori').subtitle).toBe('Satori');
    // A blank moniker is not a name.
    expect(validatorName(VALOPER, () => '   ')).toBe(shortValoper(VALOPER));
    expect(shortValoper(VALOPER)).toBe(`${VALOPER.slice(0, 14)}...${VALOPER.slice(-6)}`);
  });
});
