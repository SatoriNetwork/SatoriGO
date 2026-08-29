/**
 * @vitest-environment jsdom
 *
 * LiveStakeEvm: the native-staking screen. Like LiveSendEvm, this screen never
 * builds a transaction and never talks to a chain: it displays the snapshot and
 * the plan the store hands back, so every store action is a vi.fn set into the
 * REAL store through useLiveStore.setState.
 *
 * What the tests below are actually protecting:
 *   - the validator list renders, sorted and filterable, from live-shaped data;
 *   - the unbonding warning appears on the Unstake path and carries the CHAIN'S
 *     figure, never a hardcoded 21 days, and says so honestly when unknown;
 *   - the review step names the validator and the amount in words;
 *   - the arming gate really gates: Confirm is dead until the box is ticked,
 *     and a fee-cap refusal keeps it dead even then.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// The store module constructs a real LiveWalletService at import time; stub it
// so that construction is inert (same reason as LiveSendEvm.test.tsx).
vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    allowBroadcast = false;
    network() {
      return 'mainnet';
    }
    async exists() {
      return true;
    }
    isUnlocked() {
      return true;
    }
    async listWallets() {
      return [];
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

vi.mock('./LiveNav', () => ({ LiveNav: () => null }));

import { LiveStakeEvm, formatUnbondingPeriod, sortValidators, unbondingNoteText } from './LiveStakeEvm';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import type { EvmStakingSnapshot } from '../../store/evmStaking';

const WALLET_ADDRESS = '0x9858EfFD8358a6e59aC649c53F6e26311b4Cda94';
const VALOPER = 'epixvaloper1qxt7awul3cyvgf2ku08k3n3nqn7lsqvsm7ryjw';
const VALOPER_2 = 'epixvaloper1qjynz59x6c0y2l5cf7gtyl8arjpg0k0rejn0lk';
const VALOPER_JAILED = 'epixvaloper1zlxdl376qfele4hgncdyd6y7a8du9wqqhtj28d';
const ONE = 10n ** 18n;

const EPIX_INFO = {
  key: 'epix',
  chainId: 1916,
  displayName: 'Epix',
  nativeTicker: 'EPIX',
  nativeDecimals: 18,
  explorerTxUrl: 'https://scan.epix.zone/tx/{txid}',
  homepage: 'https://example.test',
  young: false,
  recentlyAdded: false,
  feeModel: 'eip1559' as const,
  l1DataFee: false,
  indexer: { family: 'blockscout' as const, baseUrl: 'https://scan.epix.zone/api/v1' },
  alchemy: false,
  trustWalletChain: null,
  tokenListSlug: null,
  defaultTokens: [],
  staking: { valoperPrefix: 'epixvaloper', accountPrefix: 'epix' },
};

/** Monikers, commissions and voting powers as the live LCD reported them. */
const SNAPSHOT = {
  chainKey: 'epix',
  bech32Address: 'epix1rmfv04clh6egzpengwkz6vt5xdne6q2nxxtg4x',
  unbondingSeconds: 1_814_400, // 21 days, from /cosmos/staking/v1beta1/params
  maxEntries: 7,
  validators: [
    { valoper: VALOPER, moniker: 'OneNov | Restake', jailed: false, commissionRate: 0.01, tokensBase: 637226097873326284549745708n },
    { valoper: VALOPER_2, moniker: 'dnsarz | RESTAKE', jailed: false, commissionRate: 0.02, tokensBase: 599040785085680065334378005n },
    { valoper: VALOPER_JAILED, moniker: 'BonyNode', jailed: true, commissionRate: 0.05, tokensBase: 53489842000000000000000000n },
  ],
  delegations: [{ valoper: VALOPER, moniker: 'OneNov | Restake', amountBase: 5n * ONE, rewardBase: ONE / 2n }],
  unbonding: [],
  stakedTotalBase: 5n * ONE,
  rewardsTotalBase: ONE / 2n,
  issue: null as string | null,
};

function makeQuote() {
  return {
    level: 'normal' as const,
    fee: { type: 'eip1559' as const, maxFeePerGas: 40_000_000_000n, maxPriorityFeePerGas: 1n },
    gasLimit: 148_359n,
    gasEstimate: 118_687n,
    baseFeePerGas: 20_000_000_000n,
    l1DataFee: 0n,
    estimatedTotal: 2_967_180_000_000_000n,
    maxTotal: 5_934_360_000_000_000n,
  };
}

function makePlan(overrides: Record<string, unknown> = {}) {
  const quote = makeQuote();
  return {
    chainKey: 'epix',
    chainId: 1916,
    from: WALLET_ADDRESS,
    to: '0x0000000000000000000000000000000000000800',
    value: 0n,
    data: Uint8Array.from([0x53, 0x26, 0x6b, 0xbb]),
    description: 'Stake 0.1 EPIX with OneNov | Restake (epixvaloper1qx...m7ryjw).',
    action: 'delegate' as const,
    valoper: VALOPER,
    level: 'normal' as const,
    quotes: { slow: quote, normal: quote, fast: quote },
    quote,
    unsigned: { chainId: 1916, to: '0x0000000000000000000000000000000000000800', value: 0n, data: Uint8Array.from([0x53]), gasLimit: 148_359n, fee: quote.fee },
    shortfall: null as string | null,
    capRefusal: null as string | null,
    ...overrides,
  };
}

function evmWallet() {
  return {
    id: 'w1',
    name: 'My Epix Account',
    network: 'evm',
    createdAt: 0,
    active: true,
    kind: 'seed' as const,
    address: WALLET_ADDRESS,
    passwordless: true,
    family: 'evm' as const,
    evmChainKey: 'epix',
  };
}

function baseState(snapshot: EvmStakingSnapshot | null = SNAPSHOT) {
  return {
    evm: { chains: [EPIX_INFO], activeChainKey: 'epix' },
    evmStaking: { snapshot, loading: false, plan: null, planning: false },
    error: null,
    assets: [{ name: 'EPIX', amountBase: 100n * ONE, scale: 18, decimals: 18, isNative: true }],
    wallets: [evmWallet()],
    activeWalletId: 'w1',
    address: WALLET_ADDRESS,
    requirePasswordToSend: false,
    verifyPassword: vi.fn(async () => true),
    arm: vi.fn(),
    refreshEvmStaking: vi.fn(async () => {}),
    planEvmStake: vi.fn(async () => null),
    selectEvmStakeFeeLevel: vi.fn(async () => {}),
    estimateEvmStakeMax: vi.fn(async () => '0'),
    countEvmUnbondingEntries: vi.fn(async () => 0),
    confirmEvmStake: vi.fn(async () => ({ txid: '0xabc', explorerUrl: 'https://scan.epix.zone/tx/0xabc', chainKey: 'epix' })),
    clearEvmStake: vi.fn(),
  };
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  useLiveStore.setState(baseState());
});

afterEach(cleanup);

// ---------------------------------------------------------------------------

describe('1. the unbonding period is the chain’s figure, never a constant', () => {
  it('formats the real 1814400 seconds as 21 days, and smaller periods honestly', () => {
    expect(formatUnbondingPeriod(1_814_400)).toBe('21 days');
    expect(formatUnbondingPeriod(86_400)).toBe('1 day');
    expect(formatUnbondingPeriod(7_200)).toBe('2 hours');
    expect(formatUnbondingPeriod(90)).toBe('2 minutes');
    expect(formatUnbondingPeriod(0)).toBe('');
  });

  it('an unknown period produces an HONEST sentence, never "0 days" and never an invented 21', () => {
    const known = unbondingNoteText(1_814_400, 'EPIX');
    expect(known).toContain('locks the coins for 21 days');
    const unknown = unbondingNoteText(0, 'EPIX');
    expect(unknown).toContain('could not be read');
    expect(unknown).not.toContain('21');
    expect(unknown).toContain('EPIX');
  });

  it('no user-facing string on this screen uses an em-dash (repo copy rule)', () => {
    expect(unbondingNoteText(1_814_400, 'EPIX')).not.toContain('—');
    expect(unbondingNoteText(0, 'EPIX')).not.toContain('—');
  });
});

describe('2. overview: totals, validators, jailed filter', () => {
  it('reads the staking data once on open and shows the staked total and pending rewards', async () => {
    const state = baseState();
    useLiveStore.setState(state);
    render(<LiveStakeEvm onBack={() => {}} />);
    expect(screen.getByTestId('live-stake-evm')).toBeInTheDocument();
    expect(state.refreshEvmStaking).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('live-stake-total')).toHaveTextContent('5 EPIX');
    expect(screen.getByTestId('live-stake-rewards-total')).toHaveTextContent('0.5 EPIX');
  });

  it('lists the bonded validators with moniker, commission and voting power, most power first', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    const first = screen.getByTestId(`live-stake-validator-${VALOPER}`);
    expect(first).toHaveTextContent('OneNov | Restake');
    expect(first).toHaveTextContent('Commission 1%');
    expect(screen.getByTestId(`live-stake-validator-${VALOPER_2}`)).toHaveTextContent('dnsarz | RESTAKE');
    // Rendered in the order the store handed them (already sorted by power).
    const rows = screen.getAllByTestId(/^live-stake-validator-/);
    expect(rows[0]).toBe(first);
  });

  it('a JAILED validator is hidden by default and can be shown, but never offered a Stake button', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    expect(screen.queryByTestId(`live-stake-validator-${VALOPER_JAILED}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('live-stake-jailed-filter'));
    const jailed = screen.getByTestId(`live-stake-validator-${VALOPER_JAILED}`);
    expect(jailed).toHaveTextContent('Jailed');
    expect(jailed.querySelector('[data-testid="live-stake-delegate"]')).toBeDisabled();
  });

  it('my delegation shows its amount and rewards, with Unstake, Move and Claim', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    const row = screen.getByTestId(`live-stake-delegation-${VALOPER}`);
    expect(row).toHaveTextContent('5 EPIX');
    expect(row).toHaveTextContent('Rewards: 0.5 EPIX');
    expect(screen.getByTestId('live-stake-undelegate')).toBeInTheDocument();
    expect(screen.getByTestId('live-stake-redelegate')).toBeInTheDocument();
    expect(screen.getByTestId('live-stake-claim')).toBeEnabled();
  });

  it('Claim is dead when there is nothing to claim (no fee paid for a zero withdrawal)', () => {
    useLiveStore.setState(
      baseState({ ...SNAPSHOT, delegations: [{ ...SNAPSHOT.delegations[0], rewardBase: 0n }], rewardsTotalBase: 0n }),
    );
    render(<LiveStakeEvm onBack={() => {}} />);
    expect(screen.getByTestId('live-stake-claim')).toBeDisabled();
  });

  it('a failed read is SAID, not shown as an empty validator list that reads as "no validators"', () => {
    useLiveStore.setState(
      baseState({ ...SNAPSHOT, validators: [], delegations: [], stakedTotalBase: 0n, issue: 'The validator list could not be read: Epix could not be reached.' }),
    );
    render(<LiveStakeEvm onBack={() => {}} />);
    expect(screen.getByTestId('live-stake-issue')).toHaveTextContent('could not be read');
    expect(screen.getByText('Validators unavailable')).toBeInTheDocument();
  });

  it('a chain without native staking renders a refusal, not a half-working screen', () => {
    useLiveStore.setState({ ...baseState(), evm: { chains: [{ ...EPIX_INFO, staking: null }], activeChainKey: 'epix' } });
    render(<LiveStakeEvm onBack={() => {}} />);
    expect(screen.getByTestId('live-stake-evm')).toHaveTextContent('Staking is not available on this chain');
  });
});

describe('3. forms: Delegate, and the unbonding warning on Unstake', () => {
  it('Stake opens the delegate form with the validator named and the balance available', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId(`live-stake-validator-${VALOPER}`).querySelector('[data-testid="live-stake-delegate"]')!);
    expect(screen.getByTestId('live-stake-available')).toHaveTextContent('Available: 100 EPIX');
    // No unbonding warning on the way IN: nothing is being locked.
    expect(screen.queryByTestId('live-stake-unbonding-note')).not.toBeInTheDocument();
  });

  it('Review passes the typed amount, the validator and the action to the store', async () => {
    const state = baseState();
    useLiveStore.setState(state);
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId(`live-stake-validator-${VALOPER}`).querySelector('[data-testid="live-stake-delegate"]')!);
    fireEvent.change(screen.getByTestId('live-stake-amount'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByTestId('live-stake-review-submit'));
    await waitFor(() => expect(state.planEvmStake).toHaveBeenCalled());
    expect(state.planEvmStake).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delegate', valoper: VALOPER, amountText: '0.1', level: 'normal' }),
    );
  });

  it('an empty amount is refused in the form and never reaches the store', async () => {
    const state = baseState();
    useLiveStore.setState(state);
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId(`live-stake-validator-${VALOPER}`).querySelector('[data-testid="live-stake-delegate"]')!);
    fireEvent.click(screen.getByTestId('live-stake-review-submit'));
    await waitFor(() => expect(screen.getByText('Enter an amount.')).toBeInTheDocument());
    expect(state.planEvmStake).not.toHaveBeenCalled();
  });

  it('UNSTAKE shows the unbonding warning with the chain’s real 21 days, and the cap is the delegation', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-undelegate'));
    const note = screen.getByTestId('live-stake-unbonding-note');
    expect(note).toHaveTextContent('Unstaking locks the coins for 21 days');
    expect(note).toHaveTextContent('cannot be sent or moved until it ends');
    // The amount cap on the way out is what is staked, not the wallet balance.
    expect(screen.getByTestId('live-stake-available')).toHaveTextContent('Staked with this validator: 5 EPIX');
  });

  it('the unbonding warning says so honestly when the chain’s params could not be read', () => {
    useLiveStore.setState(baseState({ ...SNAPSHOT, unbondingSeconds: 0 }));
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-undelegate'));
    const note = screen.getByTestId('live-stake-unbonding-note');
    expect(note).toHaveTextContent('could not be read');
    expect(note).not.toHaveTextContent('21 days');
  });

  it('a validator already at the chain’s unbonding-entry limit is called out before signing', async () => {
    const state = baseState();
    state.countEvmUnbondingEntries = vi.fn(async () => 7);
    useLiveStore.setState(state);
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-undelegate'));
    await waitFor(() => expect(screen.getByTestId('live-stake-entry-limit')).toBeInTheDocument());
    expect(screen.getByTestId('live-stake-entry-limit')).toHaveTextContent('7 unstaking entries in flight');
  });

  it('Move offers every other bonded validator as a destination, and never the source or a jailed one', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-redelegate'));
    const options = [...screen.getByTestId('live-stake-redelegate-dst').querySelectorAll('option')].map((o) => o.value);
    expect(options).toContain(VALOPER_2);
    expect(options).not.toContain(VALOPER);
    expect(options).not.toContain(VALOPER_JAILED);
  });

  it('Claim plans straight from the overview: no amount to type, the pending figure is the amount', async () => {
    const state = baseState();
    useLiveStore.setState(state);
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-claim'));
    await waitFor(() => expect(state.planEvmStake).toHaveBeenCalled());
    expect(state.planEvmStake).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'claim', valoper: VALOPER, amountText: '0.5' }),
    );
  });
});

describe('4. review: the words, the figures, and the arming gate', () => {
  const withPlan = (planOverrides: Record<string, unknown> = {}) => {
    const state = baseState();
    const s = { ...state, evmStaking: { snapshot: SNAPSHOT, loading: false, plan: makePlan(planOverrides), planning: false } };
    useLiveStore.setState(s);
    return s;
  };

  it('says what will happen in words, and names the validator ADDRESS as well as the moniker', () => {
    withPlan();
    render(<LiveStakeEvm onBack={() => {}} />);
    const review = screen.getByTestId('live-stake-review');
    expect(review).toHaveTextContent('Stake 0.1 EPIX with OneNov | Restake');
    expect(review).toHaveTextContent('cannot be undone');
    expect(screen.getByTestId('live-stake-review-valoper')).toHaveTextContent(VALOPER);
    expect(screen.getByTestId('live-stake-review-fee')).toHaveTextContent('0.00296718 EPIX');
  });

  it('the ARMING GATE is real: Confirm is dead until the box is ticked, and ticking it arms the service', () => {
    const state = withPlan();
    render(<LiveStakeEvm onBack={() => {}} />);
    const confirm = screen.getByTestId('live-stake-broadcast');
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId('live-stake-arm-checkbox'));
    expect(state.arm).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('live-stake-broadcast')).toBeEnabled();
  });

  it('an unstake review repeats the unbonding warning: it is the last screen before the lock-up is real', () => {
    withPlan({ action: 'undelegate', description: 'Unstake 1 EPIX from OneNov | Restake (epixvaloper1qx...m7ryjw).' });
    render(<LiveStakeEvm onBack={() => {}} />);
    expect(screen.getByTestId('live-stake-unbonding-note')).toHaveTextContent('21 days');
  });

  it('a FEE-CAP refusal keeps Confirm dead even when the box is ticked', () => {
    withPlan({ capRefusal: 'Refusing to sign: the fee on Epix exceeds the cap.' });
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-arm-checkbox'));
    expect(screen.getByTestId('live-stake-cap-refusal')).toHaveTextContent('exceeds the cap');
    expect(screen.getByTestId('live-stake-broadcast')).toBeDisabled();
  });

  it('a shortfall keeps Confirm dead too', () => {
    withPlan({ shortfall: 'Not enough EPIX to pay the network fee.' });
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-arm-checkbox'));
    expect(screen.getByTestId('live-stake-shortfall')).toBeInTheDocument();
    expect(screen.getByTestId('live-stake-broadcast')).toBeDisabled();
  });

  it('Confirm broadcasts once armed and lands on the transaction hash with an explorer link', async () => {
    const state = withPlan();
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-stake-broadcast'));
    await waitFor(() => expect(state.confirmEvmStake).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('live-stake-txid')).toHaveTextContent('0xabc'));
    expect(screen.getByTestId('live-stake-explorer-link')).toHaveAttribute('href', 'https://scan.epix.zone/tx/0xabc');
  });

  it('Back off the review clears the plan and disarms', () => {
    const state = withPlan();
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-stake-review-back'));
    expect(state.clearEvmStake).toHaveBeenCalled();
    expect(state.arm).toHaveBeenLastCalledWith(false);
  });
});

describe('5. sorting the validator list (owner, 2026-08-24)', () => {
  // Four validators whose three orders are all DIFFERENT, so a test that passes
  // is proving the sort and not an accident of the fixture. The diacritic and
  // the lowercase moniker are there on purpose: "A-Z" must mean the alphabet a
  // reader sees, not the code points.
  const V_ZETA = 'epixvaloper1zeta00000000000000000000000000000000000';
  const V_ALPHA = 'epixvaloper1alpha0000000000000000000000000000000000';
  const V_MID = 'epixvaloper1mid000000000000000000000000000000000000';
  const V_JAIL = 'epixvaloper1jail00000000000000000000000000000000000';
  const SORT_SNAPSHOT = {
    ...SNAPSHOT,
    delegations: [],
    stakedTotalBase: 0n,
    rewardsTotalBase: 0n,
    validators: [
      { valoper: V_ZETA, moniker: 'zeta node', jailed: false, commissionRate: 0.01, tokensBase: 100n * ONE },
      { valoper: V_ALPHA, moniker: 'Ålpha One', jailed: false, commissionRate: 0.1, tokensBase: 300n * ONE },
      { valoper: V_MID, moniker: 'Mid Node', jailed: false, commissionRate: 0.05, tokensBase: 200n * ONE },
      { valoper: V_JAIL, moniker: 'AAA Jailed', jailed: true, commissionRate: 0.001, tokensBase: 400n * ONE },
    ],
  };

  /** The valopers of the rendered validator rows, in DOM order. */
  const order = () =>
    screen
      .getAllByTestId(/^live-stake-validator-/)
      .map((el) => el.getAttribute('data-testid')!.replace('live-stake-validator-', ''));

  beforeEach(() => {
    useLiveStore.setState(baseState(SORT_SNAPSHOT));
  });

  it('sorts by voting power by default, descending, with that option pressed', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    expect(screen.getByTestId('live-stake-sort')).toBeInTheDocument();
    expect(screen.getByTestId('live-stake-sort-power')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('live-stake-sort-commission')).toHaveAttribute('aria-pressed', 'false');
    expect(order()).toEqual([V_ALPHA, V_MID, V_ZETA]);
  });

  it('sorts by commission, CHEAPEST first', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-sort-commission'));
    expect(screen.getByTestId('live-stake-sort-commission')).toHaveAttribute('aria-pressed', 'true');
    expect(order()).toEqual([V_ZETA, V_MID, V_ALPHA]);
  });

  it('sorts by name A-Z, ignoring case and diacritics', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('live-stake-sort-name'));
    // "Ålpha One" (diacritic) < "Mid Node" < "zeta node" (lowercase).
    expect(order()).toEqual([V_ALPHA, V_MID, V_ZETA]);
    fireEvent.click(screen.getByTestId('live-stake-sort-power'));
    expect(order()).toEqual([V_ALPHA, V_MID, V_ZETA]);
  });

  it('the jailed filter keeps working under every sort, and a shown jailed validator is sorted with the rest', () => {
    render(<LiveStakeEvm onBack={() => {}} />);
    for (const key of ['power', 'commission', 'name'] as const) {
      fireEvent.click(screen.getByTestId(`live-stake-sort-${key}`));
      expect(order()).not.toContain(V_JAIL);
    }
    fireEvent.click(screen.getByTestId('live-stake-jailed-filter'));
    // Jailed is the cheapest AND the biggest AND first in the alphabet here, so
    // it leads every one of the three orders once it is shown.
    for (const key of ['power', 'commission', 'name'] as const) {
      fireEvent.click(screen.getByTestId(`live-stake-sort-${key}`));
      expect(order()[0]).toBe(V_JAIL);
      expect(order()).toHaveLength(4);
    }
    // ...and hiding them again leaves the chosen sort alone.
    fireEvent.click(screen.getByTestId('live-stake-jailed-filter'));
    expect(order()).toEqual([V_ALPHA, V_MID, V_ZETA]);
    expect(screen.getByTestId('live-stake-sort-name')).toHaveAttribute('aria-pressed', 'true');
  });

  it('sortValidators never mutates its input, and an unreadable commission sorts LAST rather than as "free"', () => {
    const rows = [
      { valoper: 'a', moniker: 'A', jailed: false, commissionRate: null, tokensBase: 10n },
      { valoper: 'b', moniker: 'B', jailed: false, commissionRate: 0.5, tokensBase: 20n },
      { valoper: 'c', moniker: 'C', jailed: false, commissionRate: null, tokensBase: 30n },
    ];
    const before = rows.map((r) => r.valoper);
    expect(sortValidators(rows, 'commission').map((r) => r.valoper)).toEqual(['b', 'c', 'a']);
    // Equal (null) commissions fall back to voting power, and the caller's array
    // is untouched.
    expect(rows.map((r) => r.valoper)).toEqual(before);
    expect(sortValidators(rows, 'power').map((r) => r.valoper)).toEqual(['c', 'b', 'a']);
  });
});
