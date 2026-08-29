// Tests for indexer rows -> LiveTransaction mapping. Pure, no network: every
// fixture below is hand-written, standing in for what an Etherscan-family
// indexer would return.

import { describe, it, expect } from 'vitest';
import { mapEvmActivity, localPendingEvmTx, type EvmActivityInput } from './activity';
import { toChecksumAddress } from '../keys';
import { encodeDelegate, encodeWithdrawDelegatorRewards } from '../cosmosStaking';
import { evmChainByKey } from '../chains';
import type { IndexedTx, IndexedTokenTransfer } from './etherscan';

// ---------------------------------------------------------------------------
// Fixtures. Indexer addresses are always lowercase 0x hex (the etherscan.ts
// contract); the wallet's OWN address is deliberately given to mapEvmActivity
// in mixed case, to exercise rule 1's case-insensitive identity.

const US_MIXED = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const US = US_MIXED.toLowerCase();

const RECIPIENT = '0x111111111111111111111111111111111111aaaa';
const SENDER_IN = '0x222222222222222222222222222222222222bbbb';
const USDC_CONTRACT = '0x333333333333333333333333333333333333cccc';
const SPENDER = '0x444444444444444444444444444444444444dddd';
const OTHER_UNRELATED = '0x555555555555555555555555555555555555eeee';
const USDC_SENDER = '0x666666666666666666666666666666666666ffff';
const UNKNOWN_TOKEN_CONTRACT = '0x7777777777777777777777777777777777771234';

const HASH_IN = '0x1111111111111111111111111111111111111111111111111111111111110001';
const HASH_OUT = '0x2222222222222222222222222222222222222222222222222222222222220002';
const HASH_USDC_OUT = '0x3333333333333333333333333333333333333333333333333333333333330003';
const HASH_USDC_IN = '0x4444444444444444444444444444444444444444444444444444444444440004';
const HASH_APPROVE = '0x5555555555555555555555555555555555555555555555555555555555550005';
const HASH_FAILED = '0x6666666666666666666666666666666666666666666666666666666666660006';
const HASH_UNRELATED = '0x7777777777777777777777777777777777777777777777777777777777770007';
const HASH_SELF = '0x8888888888888888888888888888888888888888888888888888888888880008';
const HASH_UNKNOWN_TOKEN = '0x9999999999999999999999999999999999999999999999999999999999990009';

const HASH_STAKE = '0xaaaa111111111111111111111111111111111111111111111111111111110010';
const HASH_CLAIM = '0xbbbb222222222222222222222222222222222222222222222222222222220011';

const GWEI = 1_000_000_000n;
const ETH = 1_000_000_000_000_000_000n;

// The REAL registry row and the REAL encoders: a fixture written by hand could
// agree with a decoder that is wrong. Epix is the only chain with staking today.
const EPIX_STAKING_CFG = evmChainByKey('epix')?.staking;
if (!EPIX_STAKING_CFG) throw new Error('epix staking row missing from the registry');
const STAKING_PRECOMPILE = EPIX_STAKING_CFG.stakingPrecompile;
const DISTRIBUTION_PRECOMPILE = EPIX_STAKING_CFG.distributionPrecompile;
const VALOPER = 'epixvaloper1qxt7awul3cyvgf2ku08k3n3nqn7lsqvsm7ryjw';
const asHex = (bytes: Uint8Array) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const DELEGATE_CALLDATA = asHex(encodeDelegate(EPIX_STAKING_CFG, US_MIXED, VALOPER, 1n));
const CLAIM_CALLDATA = asHex(encodeWithdrawDelegatorRewards(EPIX_STAKING_CFG, US_MIXED, VALOPER));

function tx(overrides: Partial<IndexedTx> & Pick<IndexedTx, 'hash' | 'from'>): IndexedTx {
  return {
    blockNumber: 100n,
    timestamp: 1_000_000,
    to: null,
    value: 0n,
    gasUsed: 21_000n,
    gasPrice: GWEI,
    isError: false,
    input: '0x',
    contractAddress: null,
    confirmations: 10n,
    ...overrides,
  };
}

function tokenTx(
  overrides: Partial<IndexedTokenTransfer> &
    Pick<IndexedTokenTransfer, 'hash' | 'from' | 'to' | 'contractAddress' | 'value'>,
): IndexedTokenTransfer {
  return {
    blockNumber: 100n,
    timestamp: 1_000_000,
    tokenSymbol: 'USDC',
    tokenName: 'USD Coin',
    tokenDecimal: 6,
    gasUsed: 50_000n,
    gasPrice: GWEI,
    confirmations: 10n,
    ...overrides,
  };
}

function baseInput(overrides: Partial<EvmActivityInput> = {}): EvmActivityInput {
  return {
    address: US_MIXED,
    nativeTicker: 'ETH',
    nativeDecimals: 18,
    txs: [],
    tokenTransfers: [],
    ...overrides,
  };
}

/** Finds the one row with this txid, failing loudly if there is not exactly one. */
function only(rows: ReturnType<typeof mapEvmActivity>, txid: string) {
  const matches = rows.filter((r) => r.txid === txid);
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe('mapEvmActivity', () => {
  it('rule 1+3: an incoming native transfer is case-insensitively ours, counterparty checksummed', () => {
    const incoming = tx({
      hash: HASH_IN,
      from: SENDER_IN,
      to: US, // lowercase, must still match US_MIXED
      value: ETH,
      blockNumber: 100n,
      timestamp: 1_000_000,
    });
    const rows = mapEvmActivity(baseInput({ txs: [incoming] }));
    const row = only(rows, HASH_IN);
    expect(row.asset).toBe('ETH');
    expect(row.direction).toBe('in');
    expect(row.amount).toBe(1);
    expect(row.feeEvr).toBe(0);
    expect(row.spentNative).toBe(0);
    expect(row.totalOutNative).toBe(1);
    expect(row.status).toBe('confirmed');
    expect(row.blockHeight).toBe(100);
    expect(row.counterparty).toBe(toChecksumAddress(SENDER_IN));
  });

  it('rule 3: an outgoing native transfer carries its fee and spentNative = value + fee', () => {
    const outgoing = tx({
      hash: HASH_OUT,
      from: US,
      to: RECIPIENT,
      value: 2n * ETH,
      gasUsed: 21_000n,
      gasPrice: GWEI, // fee = 21000 gwei = 0.000021 ETH
      blockNumber: 101n,
      timestamp: 1_000_100,
    });
    const rows = mapEvmActivity(baseInput({ txs: [outgoing] }));
    const row = only(rows, HASH_OUT);
    expect(row.asset).toBe('ETH');
    expect(row.direction).toBe('out');
    expect(row.amount).toBe(2);
    expect(row.feeEvr).toBeCloseTo(0.000021, 12);
    expect(row.spentNative).toBeCloseTo(2.000021, 12);
    expect(row.totalOutNative).toBe(2);
    expect(row.counterparty).toBe(toChecksumAddress(RECIPIENT));
  });

  it('rule 2: an outgoing token transfer becomes one row, fee taken from the enclosing tx', () => {
    const enclosing = tx({
      hash: HASH_USDC_OUT,
      from: US,
      to: USDC_CONTRACT,
      value: 0n,
      gasUsed: 50_000n,
      gasPrice: GWEI, // fee = 50000 gwei = 0.00005 ETH
      input: '0xa9059cbb000000000000000000000000000000000000000000000000000000000000',
      blockNumber: 102n,
      timestamp: 1_000_200,
    });
    const transfer = tokenTx({
      hash: HASH_USDC_OUT,
      from: US,
      to: RECIPIENT,
      contractAddress: USDC_CONTRACT,
      value: 5_000_000n, // 5 USDC at 6 decimals
      tokenDecimal: 6,
      blockNumber: 102n,
      timestamp: 1_000_200,
    });
    const rows = mapEvmActivity(baseInput({ txs: [enclosing], tokenTransfers: [transfer] }));

    // Exactly one row for this hash: the token row, no separate bare
    // "contract interaction" row even though the enclosing tx has value 0n
    // and real input data.
    expect(rows.filter((r) => r.txid === HASH_USDC_OUT)).toHaveLength(1);
    const row = only(rows, HASH_USDC_OUT);
    expect(row.asset).toBe('USDC');
    expect(row.direction).toBe('out');
    expect(row.amount).toBe(5);
    expect(row.feeEvr).toBeCloseTo(0.00005, 12);
    expect(row.status).toBe('confirmed');
    expect(row.blockHeight).toBe(102);
    expect(row.counterparty).toBe(toChecksumAddress(RECIPIENT));
  });

  it('rule 2: an incoming token transfer with no enclosing tx pays no fee', () => {
    const transfer = tokenTx({
      hash: HASH_USDC_IN,
      from: USDC_SENDER,
      to: US,
      contractAddress: USDC_CONTRACT,
      value: 3_000_000n,
      tokenDecimal: 6,
      blockNumber: 103n,
      timestamp: 1_000_300,
    });
    // Deliberately no matching IndexedTx: "tokentx only, we did not pay the fee".
    const rows = mapEvmActivity(baseInput({ tokenTransfers: [transfer] }));
    const row = only(rows, HASH_USDC_IN);
    expect(row.asset).toBe('USDC');
    expect(row.direction).toBe('in');
    expect(row.amount).toBe(3);
    expect(row.feeEvr).toBe(0);
    expect(row.counterparty).toBe(toChecksumAddress(USDC_SENDER));
  });

  it('rule 2: an empty token symbol falls back to a shortened contract address', () => {
    const transfer = tokenTx({
      hash: HASH_UNKNOWN_TOKEN,
      from: USDC_SENDER,
      to: US,
      contractAddress: UNKNOWN_TOKEN_CONTRACT,
      value: 10n ** 18n,
      tokenSymbol: '',
      tokenDecimal: 18,
      blockNumber: 104n,
      timestamp: 1_000_400,
    });
    const rows = mapEvmActivity(baseInput({ tokenTransfers: [transfer] }));
    const row = only(rows, HASH_UNKNOWN_TOKEN);
    expect(row.asset).toBe('0x7777…1234');
  });

  it('rule 2: a self-transfer (from === to === us) is out, counterparty is us', () => {
    const transfer = tokenTx({
      hash: HASH_SELF,
      from: US,
      to: US,
      contractAddress: USDC_CONTRACT,
      value: 1_000_000n,
      tokenDecimal: 6,
      blockNumber: 105n,
      timestamp: 1_000_500,
    });
    const rows = mapEvmActivity(baseInput({ tokenTransfers: [transfer] }));
    const row = only(rows, HASH_SELF);
    expect(row.direction).toBe('out');
    expect(row.counterparty).toBe(toChecksumAddress(US));
  });

  it('rule 4: an approve (value 0, real input, from us, no token row) shows amount 0 with the fee', () => {
    const approve = tx({
      hash: HASH_APPROVE,
      from: US,
      to: SPENDER,
      value: 0n,
      gasUsed: 46_000n,
      gasPrice: GWEI, // fee = 46000 gwei = 0.000046 ETH
      input: '0x095ea7b3000000000000000000000000000000000000000000000000000000000000',
      blockNumber: 106n,
      timestamp: 1_000_600,
    });
    const rows = mapEvmActivity(baseInput({ txs: [approve] }));
    const row = only(rows, HASH_APPROVE);
    expect(row.asset).toBe('ETH');
    expect(row.direction).toBe('out');
    expect(row.amount).toBe(0);
    expect(row.feeEvr).toBeCloseTo(0.000046, 12);
    expect(row.spentNative).toBeCloseTo(0.000046, 12);
    expect(row.totalOutNative).toBe(0);
    expect(row.counterparty).toBe(toChecksumAddress(SPENDER));
  });

  it('rule 5: a failed send keeps the row with amount 0 but the fee still charged', () => {
    const failed = tx({
      hash: HASH_FAILED,
      from: US,
      to: RECIPIENT,
      value: ETH,
      gasUsed: 21_000n,
      gasPrice: GWEI, // fee = 0.000021 ETH
      isError: true,
      blockNumber: 107n,
      timestamp: 1_000_700,
    });
    const rows = mapEvmActivity(baseInput({ txs: [failed] }));
    const row = only(rows, HASH_FAILED);
    expect(row.direction).toBe('out');
    expect(row.amount).toBe(0);
    expect(row.feeEvr).toBeCloseTo(0.000021, 12);
    // spentNative is the fee ONLY: the value never actually left, failure or not.
    expect(row.spentNative).toBeCloseTo(0.000021, 12);
    expect(row.totalOutNative).toBe(0);
    expect(row.counterparty).toBe(toChecksumAddress(RECIPIENT));
  });

  it('rule 4: someone else\'s zero-value call touching us is dropped', () => {
    const unrelated = tx({
      hash: HASH_UNRELATED,
      from: OTHER_UNRELATED,
      to: US,
      value: 0n,
      input: '0x12345678',
      blockNumber: 108n,
      timestamp: 1_000_800,
    });
    const rows = mapEvmActivity(baseInput({ txs: [unrelated] }));
    expect(rows.filter((r) => r.txid === HASH_UNRELATED)).toHaveLength(0);
  });

  it('rule 6: a duplicate row across pages collapses to one', () => {
    const outgoing = tx({
      hash: HASH_OUT,
      from: US,
      to: RECIPIENT,
      value: 2n * ETH,
      blockNumber: 101n,
      timestamp: 1_000_100,
    });
    // Same hash appears twice, as a repeated indexer page would produce.
    const rows = mapEvmActivity(baseInput({ txs: [outgoing, { ...outgoing }] }));
    expect(rows.filter((r) => r.txid === HASH_OUT)).toHaveLength(1);
  });

  it('rule 6: a duplicate token-transfer row across pages collapses to one', () => {
    const transfer = tokenTx({
      hash: HASH_USDC_IN,
      from: USDC_SENDER,
      to: US,
      contractAddress: USDC_CONTRACT,
      value: 3_000_000n,
      tokenDecimal: 6,
    });
    const rows = mapEvmActivity(baseInput({ tokenTransfers: [transfer, { ...transfer }] }));
    expect(rows.filter((r) => r.txid === HASH_USDC_IN)).toHaveLength(1);
  });

  it('rule 3: a native transfer and a token transfer on the same hash both survive (different assets)', () => {
    const swapTx = tx({
      hash: HASH_USDC_OUT,
      from: US,
      to: SPENDER,
      value: ETH, // sent ETH in
      input: '0x38ed1739',
      blockNumber: 109n,
      timestamp: 1_000_900,
    });
    const gotToken = tokenTx({
      hash: HASH_USDC_OUT,
      from: SPENDER,
      to: US,
      contractAddress: USDC_CONTRACT,
      value: 1_000_000n,
      tokenDecimal: 6,
      blockNumber: 109n,
      timestamp: 1_000_900,
    });
    const rows = mapEvmActivity(baseInput({ txs: [swapTx], tokenTransfers: [gotToken] }));
    const forHash = rows.filter((r) => r.txid === HASH_USDC_OUT);
    expect(forHash).toHaveLength(2);
    const nativeRow = forHash.find((r) => r.asset === 'ETH')!;
    const tokenRow = forHash.find((r) => r.asset === 'USDC')!;
    expect(nativeRow.direction).toBe('out');
    expect(nativeRow.amount).toBe(1);
    expect(tokenRow.direction).toBe('in');
    expect(tokenRow.amount).toBe(1);
  });

  it('rule 9: 1 wei on an 18-decimal chain reads as 1e-18, not 0', () => {
    const dust = tx({
      hash: HASH_IN,
      from: SENDER_IN,
      to: US,
      value: 1n,
      blockNumber: 100n,
      timestamp: 1_000_000,
    });
    const rows = mapEvmActivity(baseInput({ txs: [dust] }));
    const row = only(rows, HASH_IN);
    expect(row.amount).toBe(1e-18);
  });

  it('rule 7: sorts newest first by timestamp, then blockNumber desc, then hash', () => {
    const older = tx({ hash: HASH_IN, from: SENDER_IN, to: US, value: ETH, timestamp: 1000, blockNumber: 10n });
    const newer = tx({ hash: HASH_OUT, from: US, to: RECIPIENT, value: ETH, timestamp: 2000, blockNumber: 20n });
    // Same timestamp as `newer`, lower block: must sort after `newer`, before `older`.
    const sameTimeLowerBlock = tx({
      hash: HASH_APPROVE,
      from: US,
      to: SPENDER,
      value: ETH,
      timestamp: 2000,
      blockNumber: 15n,
    });
    const rows = mapEvmActivity(baseInput({ txs: [older, newer, sameTimeLowerBlock] }));
    expect(rows.map((r) => r.txid)).toEqual([HASH_OUT, HASH_APPROVE, HASH_IN]);
  });

  it('rule 7: same timestamp and blockNumber tie-break by hash', () => {
    const a = tx({ hash: HASH_IN, from: SENDER_IN, to: US, value: ETH, timestamp: 5000, blockNumber: 10n });
    const b = tx({ hash: HASH_OUT, from: SENDER_IN, to: US, value: ETH, timestamp: 5000, blockNumber: 10n });
    const rows = mapEvmActivity(baseInput({ txs: [b, a] }));
    // HASH_IN ('0x1111...0001') sorts before HASH_OUT ('0x2222...0002').
    expect(rows.map((r) => r.txid)).toEqual([HASH_IN, HASH_OUT]);
  });
});

describe('localPendingEvmTx', () => {
  it('builds a pending native send: spentNative = amount + fee, totalOutNative = amount', () => {
    const row = localPendingEvmTx({
      txid: HASH_OUT,
      from: US,
      to: RECIPIENT,
      asset: 'ETH',
      decimals: 18,
      amountBase: (3n * ETH) / 2n, // 1.5 ETH
      feeBase: 42_000_000_000_000n, // 0.000042 ETH
      nativeDecimals: 18,
      nativeTicker: 'ETH',
      timestamp: 2_000_000,
    });
    expect(row.status).toBe('pending');
    expect(row.direction).toBe('out');
    expect(row.blockHeight).toBeUndefined();
    expect(row.amount).toBe(1.5);
    expect(row.feeEvr).toBeCloseTo(0.000042, 12);
    expect(row.spentNative).toBeCloseTo(1.500042, 12);
    expect(row.totalOutNative).toBe(1.5);
    expect(row.counterparty).toBe(toChecksumAddress(RECIPIENT));
  });

  it('builds a pending token send: spentNative = fee only, totalOutNative = 0', () => {
    const row = localPendingEvmTx({
      txid: HASH_USDC_OUT,
      from: US,
      to: RECIPIENT,
      asset: 'USDC',
      decimals: 6,
      amountBase: 2_500_000n, // 2.5 USDC
      feeBase: 50_000_000_000_000n, // 0.00005 ETH
      nativeDecimals: 18,
      nativeTicker: 'ETH',
      timestamp: 2_000_100,
    });
    expect(row.status).toBe('pending');
    expect(row.direction).toBe('out');
    expect(row.amount).toBe(2.5);
    expect(row.feeEvr).toBeCloseTo(0.00005, 12);
    expect(row.spentNative).toBeCloseTo(0.00005, 12);
    expect(row.totalOutNative).toBe(0);
    expect(row.counterparty).toBe(toChecksumAddress(RECIPIENT));
    expect(row.staking).toBeUndefined();
  });

  it('carries a decoded staking call through, so the just-broadcast row is labelled at once', () => {
    const row = localPendingEvmTx({
      txid: HASH_STAKE,
      from: US,
      to: STAKING_PRECOMPILE,
      asset: 'EPIX',
      decimals: 18,
      amountBase: 0n, // a delegation moves coins through the module, not as value
      feeBase: 3_000_000_000_000_000n,
      nativeDecimals: 18,
      nativeTicker: 'EPIX',
      timestamp: 2_000_200,
      staking: { kind: 'stake', validator: VALOPER, amountBase: 10n * ETH },
    });
    expect(row.staking).toEqual({ kind: 'stake', validator: VALOPER, amountBase: 10n * ETH });
    expect(row.amount).toBe(0);
    expect(row.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Native staking rows (cosmos/evm precompiles). The registry's `staking` row is
// the capability test: without it nothing below changes any behaviour at all.

describe('mapEvmActivity: native staking', () => {
  const EPIX_STAKING = { stakingPrecompile: STAKING_PRECOMPILE, distributionPrecompile: DISTRIBUTION_PRECOMPILE };

  it('a delegation whose calldata the history source did NOT carry still becomes a row (it would otherwise vanish)', () => {
    // This is exactly what Epix's history looks like: value 0 (the coins move
    // through the Cosmos module), input '0x' (the source carries none). Under
    // the old rule 4 the row was dropped and the stake never appeared anywhere.
    const rows = mapEvmActivity(
      baseInput({
        nativeTicker: 'EPIX',
        staking: EPIX_STAKING,
        txs: [tx({ hash: HASH_STAKE, from: US, to: STAKING_PRECOMPILE, value: 0n, input: '0x', gasUsed: 120_000n })],
      }),
    );
    const row = only(rows, HASH_STAKE);
    expect(row.amount).toBe(0);
    expect(row.direction).toBe('out');
    expect(row.counterparty).toBe(toChecksumAddress(STAKING_PRECOMPILE));
    expect(row.feeEvr).toBeCloseTo(120_000 * 1e-9, 12);
    // Unlabelled here on purpose: the label is bought later with one
    // eth_getTransactionByHash (store/evmHistory.ts).
    expect(row.staking).toBeUndefined();
  });

  it('a row that DOES carry its calldata is decoded on the spot, with no extra request', () => {
    const rows = mapEvmActivity(
      baseInput({
        nativeTicker: 'EPIX',
        staking: EPIX_STAKING,
        txs: [
          tx({ hash: HASH_STAKE, from: US, to: STAKING_PRECOMPILE, value: 0n, input: DELEGATE_CALLDATA }),
          tx({ hash: HASH_CLAIM, from: US, to: DISTRIBUTION_PRECOMPILE, value: 0n, input: CLAIM_CALLDATA }),
        ],
      }),
    );
    expect(only(rows, HASH_STAKE).staking).toEqual({ kind: 'stake', validator: VALOPER, amountBase: 1n });
    expect(only(rows, HASH_CLAIM).staking).toEqual({ kind: 'claim', validator: VALOPER });
  });

  it('WITHOUT the chain\'s staking row nothing is labelled and the old drop still applies', () => {
    const rows = mapEvmActivity(
      baseInput({
        txs: [
          tx({ hash: HASH_STAKE, from: US, to: STAKING_PRECOMPILE, value: 0n, input: '0x' }),
          tx({ hash: HASH_CLAIM, from: US, to: DISTRIBUTION_PRECOMPILE, value: 0n, input: CLAIM_CALLDATA }),
        ],
      }),
    );
    // The empty-input one is dropped exactly as it always was...
    expect(rows.filter((r) => r.txid === HASH_STAKE)).toHaveLength(0);
    // ...and the one with real calldata is a plain contract interaction.
    expect(only(rows, HASH_CLAIM).staking).toBeUndefined();
  });

  it('a call somebody ELSE made to the precompile is still not ours', () => {
    const rows = mapEvmActivity(
      baseInput({
        nativeTicker: 'EPIX',
        staking: EPIX_STAKING,
        txs: [tx({ hash: HASH_STAKE, from: OTHER_UNRELATED, to: STAKING_PRECOMPILE, value: 0n, input: '0x' })],
      }),
    );
    expect(rows).toHaveLength(0);
  });

  it('a call to an ORDINARY contract with no calldata is still dropped on a staking chain', () => {
    const rows = mapEvmActivity(
      baseInput({
        nativeTicker: 'EPIX',
        staking: EPIX_STAKING,
        txs: [tx({ hash: HASH_APPROVE, from: US, to: USDC_CONTRACT, value: 0n, input: '0x' })],
      }),
    );
    expect(rows).toHaveLength(0);
  });
});
