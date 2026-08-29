// cosmosStaking.ts: the codec, the address derivation, the REST parsing and the
// plan builders.
//
// EVERY LIVE VECTOR IN THIS FILE WAS TAKEN FROM THE CHAIN, not constructed.
// They were read on 2026-08-24 from https://evmrpc.epix.zone (chain id 1916)
// and https://api.epix.zone, and the exact commands and answers are recorded in
// the comments beside each. That is what makes this file a check on the codec
// rather than a check that the codec agrees with itself.

import { describe, expect, it } from 'vitest';
import {
  COSMOS_DISTRIBUTION_EVENTS,
  COSMOS_DISTRIBUTION_SELECTORS,
  COSMOS_STAKING_SELECTORS,
  CosmosRestError,
  bech32AddressFor,
  cosmosEventTopic,
  cosmosSelector,
  decodeDecCoins,
  decodeDelegationResult,
  decodeStakingCall,
  decodeStakingCallHex,
  decodeUnbondingDelegationResult,
  decodeWithdrawnRewards,
  describeValidator,
  encodeDelegate,
  encodeDelegationQuery,
  encodeDelegationRewardsQuery,
  encodeRedelegate,
  encodeUndelegate,
  encodeUnbondingDelegationQuery,
  encodeWithdrawDelegatorRewards,
  evmAddressFromBech32,
  fetchBondedValidators,
  fetchDelegations,
  fetchPendingRewards,
  fetchStakingParams,
  fetchUnbondingDelegations,
  isBech32AddressWithPrefix,
  isStakingPrecompileAddress,
  planClaimRewards,
  planDelegate,
  planRedelegate,
  planUndelegate,
} from './cosmosStaking';
import { evmChainByKey } from './chains';

const EPIX = evmChainByKey('epix');
if (!EPIX?.staking) throw new Error('epix staking row missing from the registry');
const CFG = EPIX.staking;

/** The owner's funded account, and the validator used for every live probe. */
const OWNER = '0x1Ed2c7D71FbEb281073343aC2d317433679D0153';
const VALOPER = 'epixvaloper1qxt7awul3cyvgf2ku08k3n3nqn7lsqvsm7ryjw';
const VALOPER_2 = 'epixvaloper1qjynz59x6c0y2l5cf7gtyl8arjpg0k0rejn0lk';

const hex = (bytes: Uint8Array) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

describe('1. selectors: every literal equals keccak of its canonical signature', () => {
  it.each([
    ['delegate(address,string,uint256)', COSMOS_STAKING_SELECTORS.delegate, '0x53266bbb'],
    ['undelegate(address,string,uint256)', COSMOS_STAKING_SELECTORS.undelegate, '0x3edab33c'],
    ['redelegate(address,string,string,uint256)', COSMOS_STAKING_SELECTORS.redelegate, '0x54b826f5'],
    ['delegation(address,string)', COSMOS_STAKING_SELECTORS.delegation, '0x241774e6'],
    ['unbondingDelegation(address,string)', COSMOS_STAKING_SELECTORS.unbondingDelegation, '0xa03ffee1'],
    ['withdrawDelegatorRewards(address,string)', COSMOS_DISTRIBUTION_SELECTORS.withdrawDelegatorRewards, '0xb46a8d61'],
    ['delegationRewards(address,string)', COSMOS_DISTRIBUTION_SELECTORS.delegationRewards, '0x9ad563b4'],
  ])('%s', (signature, pinned, expected) => {
    expect(pinned).toBe(expected);
    expect(cosmosSelector(signature)).toBe(expected);
  });

  it('a space in the signature produces a DIFFERENT selector (the classic ABI typo)', () => {
    expect(cosmosSelector('delegate(address, string, uint256)')).not.toBe(COSMOS_STAKING_SELECTORS.delegate);
  });
});

describe('2. bech32: one account, three envelopes', () => {
  it('LIVE VECTOR: the owner 0x address derives to the epix1 address whose bank balance matched eth_getBalance exactly', () => {
    // GET https://api.epix.zone/cosmos/bank/v1beta1/balances/epix1rmfv04clh6egzpengwkz6vt5xdne6q2nxxtg4x
    //   -> {"balances":[{"denom":"aepix","amount":"999998319999999947500"}]}
    // eth_getBalance(0x1Ed2...0153) -> 0x3635c3b5d2636632ec = 999998319999999947500
    expect(bech32AddressFor('epix', OWNER)).toBe('epix1rmfv04clh6egzpengwkz6vt5xdne6q2nxxtg4x');
  });

  it('LIVE VECTOR: a validator operator address decodes to the 0x address its self-delegation is held under', () => {
    // The precompile answered delegation() for this 0x form with the SAME
    // figures REST reported for epix1qxt7awul3cyvgf2ku08k3n3nqn7lsqvs8vnu2w.
    const { prefix, evmAddress } = evmAddressFromBech32(VALOPER);
    expect(prefix).toBe('epixvaloper');
    expect(evmAddress.toLowerCase()).toBe('0x0197eebb9f8e08c42556e3cf68ce3304fdf80190');
    expect(bech32AddressFor('epix', evmAddress)).toBe('epix1qxt7awul3cyvgf2ku08k3n3nqn7lsqvs8vnu2w');
    // Same 20 bytes, different prefix: the round trip is the point.
    expect(bech32AddressFor('epixvaloper', evmAddress)).toBe(VALOPER);
  });

  it('the derivation is the address, not the hash of it: EIP-55 casing does not change the answer', () => {
    expect(bech32AddressFor('epix', OWNER.toLowerCase())).toBe(bech32AddressFor('epix', OWNER));
  });

  it('a wrong checksum is refused, not silently corrected', () => {
    const broken = `${VALOPER.slice(0, -1)}${VALOPER.endsWith('w') ? 'x' : 'w'}`;
    expect(() => evmAddressFromBech32(broken)).toThrow(/bech32/i);
    expect(isBech32AddressWithPrefix(broken, 'epixvaloper')).toBe(false);
  });

  it('the prefix is part of the identity: an account address is not a validator address', () => {
    const account = bech32AddressFor('epix', OWNER);
    expect(isBech32AddressWithPrefix(account, 'epix')).toBe(true);
    expect(isBech32AddressWithPrefix(account, 'epixvaloper')).toBe(false);
  });

  it('a 32-byte cosmos address (a module account) is refused rather than truncated to 20', () => {
    // A well-formed bech32 string carrying 32 bytes: valid bech32, wrong shape.
    const thirtyTwo = 'epix1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0f6z0j';
    expect(() => evmAddressFromBech32(thirtyTwo)).toThrow();
  });

  it('a non-address string, an empty string and a bad prefix all throw rather than produce something', () => {
    expect(() => bech32AddressFor('epix', 'not-an-address')).toThrow(/valid EVM address/);
    expect(() => bech32AddressFor('EPIX', OWNER)).toThrow(/lowercase/);
    expect(() => evmAddressFromBech32('')).toThrow();
  });
});

describe('3. encoders: the exact bytes that answered on chain', () => {
  it('LIVE VECTOR: delegate of 1 aepix is the calldata eth_estimateGas answered 0x1cf9f for', () => {
    const data = hex(encodeDelegate(CFG, OWNER, VALOPER, 1n));
    expect(data).toBe(
      '0x53266bbb' +
        // delegator, left-padded to a word
        '0000000000000000000000001ed2c7d71fbeb281073343ac2d317433679d0153' +
        // offset of the validator string: three head words
        '0000000000000000000000000000000000000000000000000000000000000060' +
        // amount
        '0000000000000000000000000000000000000000000000000000000000000001' +
        // string length 0x32 = 50 characters, then the UTF-8 of
        // 'epixvaloper1qxt7awul3cyvgf2ku08k3n3nqn7lsqvsm7ryjw', right padded
        // to two whole words
        '0000000000000000000000000000000000000000000000000000000000000032' +
        '6570697876616c6f70657231717874376177756c336379766766326b7530386b' +
        '336e336e716e376c737176736d3772796a770000000000000000000000000000',
    );
    // 4 selector + 3 head words + 1 length word + 2 payload words = 228 bytes.
    expect(encodeDelegate(CFG, OWNER, VALOPER, 1n)).toHaveLength(4 + 3 * 32 + 32 + 64);
    // The string really is 50 characters: a length word of 44 (0x2c) would be
    // the classic off-by-a-prefix mistake, and the chain would decode a
    // truncated validator name.
    expect(VALOPER).toHaveLength(50);
  });

  it('undelegate has the same shape and only the selector differs', () => {
    const d = hex(encodeDelegate(CFG, OWNER, VALOPER, 12345n));
    const u = hex(encodeUndelegate(CFG, OWNER, VALOPER, 12345n));
    expect(u.slice(0, 10)).toBe('0x3edab33c');
    expect(u.slice(10)).toBe(d.slice(10));
  });

  it('redelegate: FOUR head words, and the second string offset accounts for the first tail', () => {
    const data = hex(encodeRedelegate(CFG, OWNER, VALOPER, VALOPER_2, 7n));
    expect(data.slice(0, 10)).toBe('0x54b826f5');
    const word = (i: number) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
    expect(BigInt(`0x${word(1)}`)).toBe(128n); // head is four words
    // The source tail is one length word plus two payload words (44 chars): 96
    // bytes, so the destination begins at 128 + 96.
    expect(BigInt(`0x${word(2)}`)).toBe(224n);
    expect(BigInt(`0x${word(3)}`)).toBe(7n);
  });

  it('redelegate refuses the same validator twice (a call the chain would only revert)', () => {
    expect(() => encodeRedelegate(CFG, OWNER, VALOPER, VALOPER, 1n)).toThrow(/two different validators/);
  });

  it('the query encoders produce the exact hex the live eth_calls carried', () => {
    expect(encodeDelegationQuery(CFG, OWNER, VALOPER).slice(0, 10)).toBe('0x241774e6');
    expect(encodeUnbondingDelegationQuery(CFG, OWNER, VALOPER).slice(0, 10)).toBe('0xa03ffee1');
    expect(encodeDelegationRewardsQuery(CFG, OWNER, VALOPER).slice(0, 10)).toBe('0x9ad563b4');
    expect(hex(encodeWithdrawDelegatorRewards(CFG, OWNER, VALOPER)).slice(0, 10)).toBe('0xb46a8d61');
    // All four are (address,string): head of two words, offset 64.
    for (const data of [
      encodeDelegationQuery(CFG, OWNER, VALOPER),
      encodeUnbondingDelegationQuery(CFG, OWNER, VALOPER),
      encodeDelegationRewardsQuery(CFG, OWNER, VALOPER),
      hex(encodeWithdrawDelegatorRewards(CFG, OWNER, VALOPER)),
    ]) {
      expect(BigInt(`0x${data.slice(74, 138)}`)).toBe(64n);
    }
  });

  it('a validator address under the wrong prefix never reaches calldata', () => {
    const account = bech32AddressFor('epix', OWNER);
    expect(() => encodeDelegate(CFG, OWNER, account, 1n)).toThrow(/epixvaloper1/);
    expect(() => encodeDelegate(CFG, OWNER, 'cosmosvaloper1abc', 1n)).toThrow(/epixvaloper1/);
    expect(() => encodeDelegate(CFG, OWNER, '', 1n)).toThrow(/epixvaloper1/);
  });

  it('a negative or absurd amount is refused, and the delegator must be an address', () => {
    expect(() => encodeDelegate(CFG, OWNER, VALOPER, -1n)).toThrow(/negative/);
    expect(() => encodeDelegate(CFG, OWNER, VALOPER, 2n ** 256n)).toThrow(/uint256/);
    expect(() => encodeDelegate(CFG, 'nope', VALOPER, 1n)).toThrow(/valid EVM address/);
  });
});

describe('4. decoders: the exact bytes the chain answered', () => {
  // eth_call delegation(0x0197eebb..., 'epixvaloper1qxt7...') on 0x...800.
  // REST for the same pair: shares "41944485374850759379098.000000000000000000",
  // balance {"denom":"aepix","amount":"41944485374850759379098"}.
  const DELEGATION_LIVE =
    '0x0000000000000000000000000000007b438609dd5921c5bbe9400724d2280000' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    '0000000000000000000000000000000000000000000008e1d0aaf104d2cbc89a' +
    '0000000000000000000000000000000000000000000000000000000000000005' +
    '6165706978000000000000000000000000000000000000000000000000000000';

  it('LIVE VECTOR: delegation() balance is the plain integer REST reports, and shares is that figure x 1e18', () => {
    const result = decodeDelegationResult(DELEGATION_LIVE);
    expect(result.balance.denom).toBe('aepix');
    expect(result.balance.amountBase).toBe(41944485374850759379098n);
    expect(result.sharesRaw).toBe(41944485374850759379098n * 10n ** 18n);
  });

  it('LIVE VECTOR: an empty delegation (the owner had none) reads as zero of the bond denom, not as an error', () => {
    // eth_call delegation(0x1Ed2..., 'epixvaloper1qxt7...') on 2026-08-24.
    const empty =
      '0x0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000040' +
      '0000000000000000000000000000000000000000000000000000000000000040' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000005' +
      '6165706978000000000000000000000000000000000000000000000000000000';
    expect(decodeDelegationResult(empty)).toEqual({
      sharesRaw: 0n,
      balance: { denom: 'aepix', amountBase: 0n },
    });
  });

  it('LIVE VECTOR: an empty unbondingDelegation() answers no entries', () => {
    const empty =
      '0x0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '0000000000000000000000000000000000000000000000000000000000000080' +
      '00000000000000000000000000000000000000000000000000000000000000a0' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000000';
    expect(decodeUnbondingDelegationResult(empty)).toEqual([]);
  });

  it('unbondingDelegation() with two entries: static six-word entries laid out inline, seconds turned into ms', () => {
    // Built to the ABI shape the live empty answer proved, with two entries.
    const w = (v: bigint) => v.toString(16).padStart(64, '0');
    const entry = (height: bigint, completion: bigint, initial: bigint, balance: bigint) =>
      w(height) + w(completion) + w(initial) + w(balance) + w(9n) + w(0n);
    const data =
      '0x' +
      w(32n) + // offset to the tuple
      w(96n) + // delegatorAddress offset, relative to the tuple
      w(128n) + // validatorAddress offset
      w(160n) + // entries offset
      w(0n) + // delegatorAddress length 0
      w(0n) + // validatorAddress length 0
      w(2n) + // two entries
      entry(100n, 1_800_000_000n, 5_000n, 4_900n) +
      entry(101n, 1_800_086_400n, 1_000n, 1_000n);
    expect(decodeUnbondingDelegationResult(data)).toEqual([
      { creationHeight: 100n, completionTime: 1_800_000_000_000, initialBalanceBase: 5_000n, balanceBase: 4_900n },
      { creationHeight: 101n, completionTime: 1_800_086_400_000, initialBalanceBase: 1_000n, balanceBase: 1_000n },
    ]);
  });

  it('LIVE VECTOR: delegationRewards() DecCoin amount is the TRUNCATED integer, and precision is the denom exponent', () => {
    // eth_call delegationRewards(0x0197eebb..., 'epixvaloper1qxt7...') on
    // 0x...801, at the same moment REST reported
    // "81240454787509949141.842793923993686798" aepix for that pair.
    const live =
      '0x0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000001' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '00000000000000000000000000000000000000000000000467701332e8b692d5' +
      '0000000000000000000000000000000000000000000000000000000000000012' +
      '0000000000000000000000000000000000000000000000000000000000000005' +
      '6165706978000000000000000000000000000000000000000000000000000000';
    expect(decodeDecCoins(live)).toEqual([{ denom: 'aepix', amountBase: 81240454787509949141n, precision: 18 }]);
    // Read as a 1e18-scaled Dec this would have been 81.24 aepix: eighteen
    // orders of magnitude out. The live cross-check is what settles it.
    expect(81240454787509949141n).toBeLessThan(81240454787509949141n * 10n ** 18n);
  });

  it('LIVE VECTOR: an empty DecCoin[] (no rewards) is an empty list', () => {
    const empty =
      '0x0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000000';
    expect(decodeDecCoins(empty)).toEqual([]);
  });

  it('truncated, misaligned and over-long answers all THROW rather than decode to something plausible', () => {
    expect(() => decodeDelegationResult('0x1234')).toThrow();
    expect(() => decodeDelegationResult('0x')).toThrow();
    expect(() => decodeDelegationResult('not hex')).toThrow(/0x-prefixed/);
    // An offset past the end of the data.
    const badOffset = `0x${''.padStart(64, '0')}${(999n).toString(16).padStart(64, '0')}`;
    expect(() => decodeDelegationResult(badOffset)).toThrow(/offset/);
    // An array length the data cannot hold.
    const badCount =
      `0x${(32n).toString(16).padStart(64, '0')}${(500n).toString(16).padStart(64, '0')}`;
    expect(() => decodeDecCoins(badCount)).toThrow(/elements/);
  });
});

describe('5. plan builders: the bytes, and the sentence the review shows', () => {
  it('delegate: value 0, the staking precompile, and a sentence naming the validator and the amount', () => {
    const plan = planDelegate({
      staking: CFG,
      delegator: OWNER,
      valoper: VALOPER,
      amountBase: 100000000000000000n,
      amountText: '0.1',
      ticker: 'EPIX',
      moniker: 'OneNov | Restake',
    });
    expect(plan.to).toBe('0x0000000000000000000000000000000000000800');
    expect(plan.value).toBe(0n);
    expect(plan.kind).toBe('delegate');
    expect(hex(plan.data).slice(0, 10)).toBe('0x53266bbb');
    expect(plan.description).toContain('Stake 0.1 EPIX');
    expect(plan.description).toContain('OneNov | Restake');
    // The address is in the sentence too: a moniker is chosen by the validator
    // and two can share one.
    expect(plan.description).toContain('epixvaloper1qx');
  });

  it('undelegate and redelegate name the right precompile and carry no value', () => {
    const un = planUndelegate({ staking: CFG, delegator: OWNER, valoper: VALOPER, amountBase: 1n, amountText: '0.000000000000000001', ticker: 'EPIX' });
    expect(un.to).toBe(CFG.stakingPrecompile);
    expect(un.value).toBe(0n);
    expect(un.kind).toBe('undelegate');
    expect(un.description).toContain('Unstake');

    const re = planRedelegate({
      staking: CFG,
      delegator: OWNER,
      srcValoper: VALOPER,
      dstValoper: VALOPER_2,
      amountBase: 5n,
      amountText: '5',
      ticker: 'EPIX',
      srcMoniker: 'A',
      dstMoniker: 'B',
    });
    expect(re.to).toBe(CFG.stakingPrecompile);
    expect(re.kind).toBe('redelegate');
    expect(re.description).toContain('Move 5 EPIX from A');
    expect(re.description).toContain('to B');
  });

  it('claim goes to the DISTRIBUTION precompile, not the staking one', () => {
    const claim = planClaimRewards({ staking: CFG, delegator: OWNER, valoper: VALOPER, ticker: 'EPIX', amountText: '81.24' });
    expect(claim.to).toBe('0x0000000000000000000000000000000000000801');
    expect(claim.to).not.toBe(CFG.stakingPrecompile);
    expect(claim.value).toBe(0n);
    expect(claim.kind).toBe('claim');
    expect(claim.description).toContain('Claim 81.24 EPIX');
  });

  it('a zero or negative amount never becomes a plan', () => {
    for (const amount of [0n, -1n]) {
      expect(() => planDelegate({ staking: CFG, delegator: OWNER, valoper: VALOPER, amountBase: amount, amountText: '0', ticker: 'EPIX' })).toThrow(/greater than zero/);
      expect(() => planUndelegate({ staking: CFG, delegator: OWNER, valoper: VALOPER, amountBase: amount, amountText: '0', ticker: 'EPIX' })).toThrow(/greater than zero/);
    }
  });

  it('describeValidator names both the moniker and the address, and copes without a moniker', () => {
    expect(describeValidator(VALOPER, 'OneNov')).toBe('OneNov (epixvaloper1qx...m7ryjw)');
    expect(describeValidator(VALOPER)).toBe('epixvaloper1qx...m7ryjw');
    expect(describeValidator(VALOPER, '   ')).toBe('epixvaloper1qx...m7ryjw');
  });
});

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

function jsonFetch(body: unknown, init: { status?: number; ok?: boolean } = {}): typeof fetch {
  const status = init.status ?? 200;
  return (async () =>
    ({
      ok: init.ok ?? status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof fetch;
}

const OPTS = (fetchImpl: typeof fetch) => ({ baseUrl: 'https://api.epix.zone', fetchImpl });

describe('6. REST parsing', () => {
  it('LIVE ANSWER: staking params carry the unbonding duration, the bond denom and max_entries', () => {
    // GET /cosmos/staking/v1beta1/params on 2026-08-24.
    const live = {
      params: {
        unbonding_time: '1814400s',
        max_validators: 100,
        max_entries: 7,
        historical_entries: 10000,
        bond_denom: 'aepix',
        min_commission_rate: '0.000000000000000000',
      },
    };
    return expect(fetchStakingParams(OPTS(jsonFetch(live)))).resolves.toEqual({
      unbondingTimeSeconds: 1_814_400, // 21 days
      bondDenom: 'aepix',
      maxEntries: 7,
      maxValidators: 100,
    });
  });

  it('an unbonding_time this wallet cannot read is REFUSED rather than shown as zero', async () => {
    await expect(fetchStakingParams(OPTS(jsonFetch({ params: { unbonding_time: 'soon', bond_denom: 'aepix' } })))).rejects.toThrow(
      /duration/,
    );
    await expect(fetchStakingParams(OPTS(jsonFetch({ params: { unbonding_time: '10s' } })))).rejects.toThrow(/bond_denom/);
  });

  it('LIVE ANSWER: bonded validators parse and come back sorted by voting power', async () => {
    // Two rows taken verbatim from GET
    // /cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED
    const live = {
      validators: [
        {
          operator_address: VALOPER_2,
          jailed: false,
          status: 'BOND_STATUS_BONDED',
          tokens: '599040785085680065334378005',
          description: { moniker: 'dnsarz | RESTAKE', website: 'https://dnsarz.xyz', details: 'x' },
          commission: { commission_rates: { rate: '0.020000000000000000' } },
        },
        {
          operator_address: VALOPER,
          jailed: false,
          status: 'BOND_STATUS_BONDED',
          tokens: '637226097873326284549745708',
          description: { moniker: 'OneNov | Restake' },
          commission: { commission_rates: { rate: '0.010000000000000000' } },
        },
      ],
      pagination: { next_key: null, total: '0' },
    };
    const rows = await fetchBondedValidators(OPTS(jsonFetch(live)));
    // Highest power first, whatever order the LCD listed them in.
    expect(rows.map((r) => r.operatorAddress)).toEqual([VALOPER, VALOPER_2]);
    expect(rows[0]).toEqual({
      operatorAddress: VALOPER,
      moniker: 'OneNov | Restake',
      jailed: false,
      status: 'BOND_STATUS_BONDED',
      tokensBase: 637226097873326284549745708n,
      commissionRate: 0.01,
      website: '',
      details: '',
    });
    expect(rows[1].commissionRate).toBe(0.02);
  });

  it('one unreadable validator row is skipped, the rest of the page still lists', async () => {
    const rows = await fetchBondedValidators(
      OPTS(
        jsonFetch({
          validators: [
            { operator_address: 'a', tokens: 'not-a-number', description: {} },
            { operator_address: VALOPER, tokens: '10', description: { moniker: 'ok' }, commission: {} },
            null,
          ],
        }),
      ),
    );
    expect(rows.map((r) => r.operatorAddress)).toEqual([VALOPER]);
    expect(rows[0].commissionRate).toBe(null);
  });

  it('the validators request asks for the bonded set and stays inside the proxy page cap', async () => {
    let seen = '';
    const spy = (async (url: string) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ validators: [] }), text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchBondedValidators(OPTS(spy));
    expect(seen).toContain('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED');
    expect(seen).toContain('pagination.limit=200');
    expect(seen.startsWith('https://api.epix.zone/')).toBe(true);
  });

  it('LIVE ANSWER: delegations parse, largest first, and the balance is the exact integer', async () => {
    const live = {
      delegation_responses: [
        {
          delegation: { delegator_address: 'epix1qxt', validator_address: VALOPER_2, shares: '5.000000000000000000' },
          balance: { denom: 'aepix', amount: '5' },
        },
        {
          delegation: { delegator_address: 'epix1qxt', validator_address: VALOPER, shares: '41944485374850759379098.000000000000000000' },
          balance: { denom: 'aepix', amount: '41944485374850759379098' },
        },
      ],
      pagination: { next_key: null, total: '2' },
    };
    const rows = await fetchDelegations(OPTS(jsonFetch(live)), 'epix1qxt');
    expect(rows).toEqual([
      { valoper: VALOPER, amountBase: 41944485374850759379098n },
      { valoper: VALOPER_2, amountBase: 5n },
    ]);
  });

  it('LIVE ANSWER: an account with nothing staked reads as empty lists, never as an error', async () => {
    await expect(fetchDelegations(OPTS(jsonFetch({ delegation_responses: [], pagination: {} })), 'epix1x')).resolves.toEqual([]);
    await expect(
      fetchUnbondingDelegations(OPTS(jsonFetch({ unbonding_responses: [], pagination: {} })), 'epix1x'),
    ).resolves.toEqual([]);
    await expect(fetchPendingRewards(OPTS(jsonFetch({ rewards: [], total: [] })), 'epix1x', 'aepix')).resolves.toEqual({
      perValidator: new Map(),
      totalBase: 0n,
    });
  });

  it('unbonding entries parse their RFC 3339 completion time and come back soonest first', async () => {
    const rows = await fetchUnbondingDelegations(
      OPTS(
        jsonFetch({
          unbonding_responses: [
            {
              validator_address: VALOPER,
              entries: [
                { creation_height: '200', completion_time: '2026-09-20T10:00:00Z', initial_balance: '10', balance: '10' },
                { creation_height: '100', completion_time: '2026-09-10T10:00:00Z', initial_balance: '5', balance: '4' },
                { creation_height: '300', completion_time: 'never', initial_balance: '1', balance: '1' },
              ],
            },
          ],
        }),
      ),
      'epix1x',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].entries.map((e) => e.creationHeight)).toEqual([100n, 200n]);
    expect(rows[0].entries[0].balanceBase).toBe(4n);
    expect(rows[0].entries[0].completionTime).toBe(Date.parse('2026-09-10T10:00:00Z'));
  });

  it('LIVE ANSWER: rewards are Dec strings, TRUNCATED to base units, and only the bond denom counts', async () => {
    // GET /cosmos/distribution/v1beta1/delegators/{addr}/rewards, 2026-08-24.
    const live = {
      rewards: [
        {
          validator_address: VALOPER,
          reward: [
            { denom: 'aepix', amount: '81240454787509949141.842793923993686798' },
            // A foreign denom must never be added into an EPIX figure.
            { denom: 'ibc/SOMETHING', amount: '999999999999999999999' },
          ],
        },
      ],
      total: [{ denom: 'aepix', amount: '81240454787509949141.842793923993686798' }],
    };
    const rewards = await fetchPendingRewards(OPTS(jsonFetch(live)), 'epix1x', 'aepix');
    expect(rewards.perValidator.get(VALOPER)).toBe(81240454787509949141n);
    expect(rewards.totalBase).toBe(81240454787509949141n);
  });

  it('transport failure, a 5xx and a 4xx are three different reasons the UI can act on', async () => {
    const boom = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(fetchStakingParams(OPTS(boom))).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(fetchStakingParams(OPTS(jsonFetch({}, { status: 503 })))).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(fetchStakingParams(OPTS(jsonFetch({}, { status: 404 })))).rejects.toMatchObject({ reason: 'refused' });
    await expect(fetchStakingParams(OPTS(jsonFetch({})))).rejects.toBeInstanceOf(CosmosRestError);
  });

  it('a gateway build sends its client token on every REST GET; a dev build sends no custom header', async () => {
    let headers: Record<string, string> = {};
    const spy = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({ validators: [] }), text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchBondedValidators({ baseUrl: 'https://network.satorigo.app/evm/epix/rest', headers: { 'X-Satori-Client': 'sgw_x' }, fetchImpl: spy });
    expect(headers['X-Satori-Client']).toBe('sgw_x');
    await fetchBondedValidators(OPTS(spy));
    expect(headers['X-Satori-Client']).toBeUndefined();
    expect(headers.accept).toBe('application/json');
  });
});

describe('7. decodeStakingCall: reading a staking transaction back from its calldata', () => {
  it('round-trips every write call the wallet can make, through the encoders above', () => {
    expect(decodeStakingCall(encodeDelegate(CFG, OWNER, VALOPER, 1n))).toEqual({
      kind: 'stake',
      validator: VALOPER,
      amountBase: 1n,
    });
    // A real amount, not a toy one: 12.5 EPIX in aepix.
    expect(decodeStakingCall(encodeUndelegate(CFG, OWNER, VALOPER, 12_500_000_000_000_000_000n))).toEqual({
      kind: 'unstake',
      validator: VALOPER,
      amountBase: 12_500_000_000_000_000_000n,
    });
    expect(decodeStakingCall(encodeRedelegate(CFG, OWNER, VALOPER, VALOPER_2, 7n))).toEqual({
      kind: 'redelegate',
      validator: VALOPER,
      validatorDst: VALOPER_2,
      amountBase: 7n,
    });
    // A claim carries NO amount: the chain pays whatever accrued, and a 0 here
    // would become a "0 EPIX" on a screen.
    const claim = decodeStakingCall(encodeWithdrawDelegatorRewards(CFG, OWNER, VALOPER));
    expect(claim).toEqual({ kind: 'claim', validator: VALOPER });
    expect(claim && 'amountBase' in claim).toBe(false);
  });

  it('the source and the destination of a redelegate are not swapped (the mistake that would move a stake the wrong way in the story)', () => {
    const info = decodeStakingCall(encodeRedelegate(CFG, OWNER, VALOPER_2, VALOPER, 3n));
    expect(info?.validator).toBe(VALOPER_2);
    expect(info?.validatorDst).toBe(VALOPER);
  });

  it('LIVE VECTOR: the exact delegate calldata that answered 0x1cf9f on chain decodes to that delegation', () => {
    expect(
      decodeStakingCallHex(
        '0x53266bbb' +
          '0000000000000000000000001ed2c7d71fbeb281073343ac2d317433679d0153' +
          '0000000000000000000000000000000000000000000000000000000000000060' +
          '0000000000000000000000000000000000000000000000000000000000000001' +
          '0000000000000000000000000000000000000000000000000000000000000032' +
          '6570697876616c6f70657231717874376177756c336379766766326b7530386b' +
          '336e336e716e376c737176736d3772796a770000000000000000000000000000',
      ),
    ).toEqual({ kind: 'stake', validator: VALOPER, amountBase: 1n });
  });

  it('a READ selector is not a transaction and decodes to null', () => {
    for (const query of [
      encodeDelegationQuery(CFG, OWNER, VALOPER),
      encodeUnbondingDelegationQuery(CFG, OWNER, VALOPER),
      encodeDelegationRewardsQuery(CFG, OWNER, VALOPER),
    ]) {
      expect(decodeStakingCallHex(query)).toBe(null);
    }
  });

  it('an unknown selector, empty calldata and a bare selector are all null, never a throw', () => {
    // ERC-20 transfer(address,uint256): a real selector, not one of ours.
    expect(decodeStakingCallHex('0xa9059cbb' + '00'.repeat(64))).toBe(null);
    expect(decodeStakingCallHex('0x')).toBe(null);
    expect(decodeStakingCall(new Uint8Array(0))).toBe(null);
    expect(decodeStakingCall(new Uint8Array([0x53, 0x26, 0x6b]))).toBe(null);
    // The right selector with no arguments at all.
    expect(decodeStakingCallHex('0x53266bbb')).toBe(null);
  });

  it('malformed offsets, lengths and payloads decode to null rather than to a plausible lie', () => {
    const good = hex(encodeDelegate(CFG, OWNER, VALOPER, 1n));
    const words = (h: string) => {
      const out: string[] = [];
      for (let i = 10; i < h.length; i += 64) out.push(h.slice(i, i + 64));
      return out;
    };
    const rebuild = (w: string[]) => `0x53266bbb${w.join('')}`;
    const w = words(good);
    expect(decodeStakingCallHex(rebuild(w))).not.toBe(null); // the control

    // Offset past the end of the calldata.
    const farOffset = [...w];
    farOffset[1] = (10n ** 30n).toString(16).padStart(64, '0');
    expect(decodeStakingCallHex(rebuild(farOffset))).toBe(null);

    // Offset that is not word aligned.
    const misaligned = [...w];
    misaligned[1] = (95n).toString(16).padStart(64, '0');
    expect(decodeStakingCallHex(rebuild(misaligned))).toBe(null);

    // String length word claiming more bytes than the calldata holds.
    const longString = [...w];
    longString[3] = (4096n).toString(16).padStart(64, '0');
    expect(decodeStakingCallHex(rebuild(longString))).toBe(null);

    // A zero-length validator: a well-formed call naming nobody is refused, so
    // no row can ever say "Staked with " and stop there.
    const noName = [...w];
    noName[3] = '0'.repeat(64);
    expect(decodeStakingCallHex(rebuild(noName))).toBe(null);

    // Truncated in the middle of the string payload.
    expect(decodeStakingCallHex(good.slice(0, good.length - 40))).toBe(null);

    // Invalid UTF-8 where the validator name should be.
    const badUtf8 = [...w];
    badUtf8[4] = 'ff'.repeat(32);
    expect(decodeStakingCallHex(rebuild(badUtf8))).toBe(null);

    // A redelegate whose SECOND string offset is broken keeps nothing.
    const redelegate = hex(encodeRedelegate(CFG, OWNER, VALOPER, VALOPER_2, 5n));
    const rw = words(redelegate);
    rw[2] = (10n ** 30n).toString(16).padStart(64, '0');
    expect(decodeStakingCallHex(`0x54b826f5${rw.join('')}`)).toBe(null);
  });

  it('anything that is not 0x hex is null, and nothing throws', () => {
    for (const bad of ['', 'not hex', '0xzz', '0x123', null, undefined, 42, {}]) {
      expect(decodeStakingCallHex(bad)).toBe(null);
    }
    expect(decodeStakingCall(undefined as unknown as Uint8Array)).toBe(null);
  });

  it('isStakingPrecompileAddress matches both precompiles in any case, and nothing else', () => {
    expect(isStakingPrecompileAddress(CFG, CFG.stakingPrecompile)).toBe(true);
    expect(isStakingPrecompileAddress(CFG, CFG.stakingPrecompile.toLowerCase())).toBe(true);
    expect(isStakingPrecompileAddress(CFG, CFG.distributionPrecompile.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isStakingPrecompileAddress(CFG, OWNER)).toBe(false);
    expect(isStakingPrecompileAddress(CFG, '')).toBe(false);
    expect(isStakingPrecompileAddress(CFG, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. decodeWithdrawnRewards: how much a CLAIM actually withdrew
//
// The calldata says which validator; only the RECEIPT says how much. Both
// vectors below are the owner's OWN claims, read from the gateway indexer and
// then from https://evmrpc.epix.zone with eth_getTransactionReceipt on
// 2026-08-24, and pasted here verbatim.
// ---------------------------------------------------------------------------

/** LIVE: tx 0xe82c12e1a8e4ab2cdfe4d64be11e5f5cf6a2f701346bba726551eaca8d10b2a4,
 *  block 5293592, status 0x1. Its calldata named
 *  epixvaloper1lxn5tg46sude4e0y568mu6ek89ljqjz3m0he4x, whose 20 bytes ARE
 *  topics[2]; the amount is 0.0440086 EPIX, the scale of the pending rewards
 *  the owner reported. */
const LIVE_CLAIM_LOG = Object.freeze({
  address: '0x0000000000000000000000000000000000000801',
  topics: [
    '0xcf871d3149ad677b268b0238a4ffc6d4008f48a11e73468d05ff00e75f204035',
    '0x0000000000000000000000001ed2c7d71fbeb281073343ac2d317433679d0153',
    '0x000000000000000000000000f9a745a2ba871b9ae5e4a68fbe6b36397f204851',
  ],
  data: '0x000000000000000000000000000000000000000000000000009c59a59da09590',
});
const LIVE_CLAIM_AMOUNT = 44_008_664_215_885_200n;

/** LIVE: tx 0x6bff1a373b36a8aa2b61f0113dbab6bf29483e77af569223515cf2a9400a4584,
 *  block 5293580, a second validator (epixvaloper1j4s5hgw...hjlrklv), 0.0811370
 *  EPIX. */
const LIVE_CLAIM_LOG_2 = Object.freeze({
  address: '0x0000000000000000000000000000000000000801',
  topics: [
    '0xcf871d3149ad677b268b0238a4ffc6d4008f48a11e73468d05ff00e75f204035',
    '0x0000000000000000000000001ed2c7d71fbeb281073343ac2d317433679d0153',
    '0x00000000000000000000000095614ba1d4e00e6d04fd4a527696bd0d4951bc77',
  ],
  data: '0x000000000000000000000000000000000000000000000000012041af4e930aa1',
});

const claim = (logs: unknown, delegator = OWNER) =>
  decodeWithdrawnRewards({ logs, distributionPrecompile: CFG.distributionPrecompile, delegator });

describe('8. decodeWithdrawnRewards: the amount a claim withdrew, from its receipt', () => {
  it('the pinned topics equal keccak of their canonical signatures (the event is SINGULAR, the method is plural)', () => {
    expect(COSMOS_DISTRIBUTION_EVENTS.withdrawDelegatorReward).toBe(
      cosmosEventTopic('WithdrawDelegatorReward(address,address,uint256)'),
    );
    expect(COSMOS_DISTRIBUTION_EVENTS.claimRewards).toBe(cosmosEventTopic('ClaimRewards(address,uint256)'));
    // The mistake this pin exists to prevent: the METHOD is
    // withdrawDelegatorRewards, the EVENT is WithdrawDelegatorReward. The
    // plural signature hashes to something that matches no log on chain.
    expect(cosmosEventTopic('WithdrawDelegatorRewards(address,address,uint256)')).not.toBe(
      COSMOS_DISTRIBUTION_EVENTS.withdrawDelegatorReward,
    );
  });

  it('LIVE VECTOR: the owner\'s real claim receipt decodes to 0.0440086 EPIX', () => {
    expect(claim([LIVE_CLAIM_LOG])).toBe(LIVE_CLAIM_AMOUNT);
    // The validator in topics[2] is the one the transaction's own calldata
    // named: the same 20 bytes the bech32 operator address carries.
    expect(evmAddressFromBech32('epixvaloper1lxn5tg46sude4e0y568mu6ek89ljqjz3m0he4x').evmAddress.toLowerCase()).toBe(
      `0x${LIVE_CLAIM_LOG.topics[2].slice(-40)}`,
    );
  });

  it('LIVE VECTOR: the second claim, a different validator, decodes to its own figure', () => {
    expect(claim([LIVE_CLAIM_LOG_2])).toBe(81_137_014_486_010_529n);
  });

  it('several reward logs in one receipt are SUMMED (what a multi-validator claim emits)', () => {
    expect(claim([LIVE_CLAIM_LOG, LIVE_CLAIM_LOG_2])).toBe(LIVE_CLAIM_AMOUNT + 81_137_014_486_010_529n);
  });

  it('a log for SOMEBODY ELSE is not counted, however well formed', () => {
    const other = { ...LIVE_CLAIM_LOG, topics: [LIVE_CLAIM_LOG.topics[0], `0x${'0'.repeat(24)}${'ab'.repeat(20)}`, LIVE_CLAIM_LOG.topics[2]] };
    expect(claim([other])).toBe(0n);
    expect(claim([LIVE_CLAIM_LOG, other])).toBe(LIVE_CLAIM_AMOUNT);
  });

  it('a log from any address but the distribution precompile is ignored (a token could forge the topic)', () => {
    const impostor = { ...LIVE_CLAIM_LOG, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
    expect(claim([impostor])).toBe(0n);
  });

  it('the aggregate ClaimRewards event is read when that is all the receipt carries, and never added to the per-validator ones', () => {
    const aggregate = {
      address: CFG.distributionPrecompile,
      topics: [COSMOS_DISTRIBUTION_EVENTS.claimRewards, LIVE_CLAIM_LOG.topics[1]],
      data: LIVE_CLAIM_LOG.data,
    };
    expect(claim([aggregate])).toBe(LIVE_CLAIM_AMOUNT);
    // Both present: the per-validator figure wins, they are not summed.
    expect(claim([LIVE_CLAIM_LOG, aggregate])).toBe(LIVE_CLAIM_AMOUNT);
  });

  it('a readable receipt with no reward event is 0n (a KNOWN nothing), an unreadable one is null (ask again)', () => {
    // A reverted claim: status 0, no logs. Answered, so it is never re-asked.
    expect(claim([])).toBe(0n);
    expect(claim([{ address: CFG.stakingPrecompile, topics: [], data: '0x' }])).toBe(0n);
    // Not a list at all: the node said nothing usable.
    for (const bad of [null, undefined, '0x', 42, {}]) expect(claim(bad)).toBe(null);
  });

  it('malformed logs are skipped, never guessed at, and nothing throws', () => {
    const short = { ...LIVE_CLAIM_LOG, data: '0x1234' };
    const noTopics = { ...LIVE_CLAIM_LOG, topics: [LIVE_CLAIM_LOG.topics[0]] };
    const twoTopics = { ...LIVE_CLAIM_LOG, topics: LIVE_CLAIM_LOG.topics.slice(0, 2) };
    expect(claim([short, noTopics, null, 'nonsense', 7])).toBe(0n);
    // WithdrawDelegatorReward has TWO indexed params: a two-topic log is not it.
    expect(claim([twoTopics])).toBe(0n);
    // A delegator that is not an address at all cannot match anything.
    expect(claim([LIVE_CLAIM_LOG], 'not-an-address')).toBe(null);
  });
});
