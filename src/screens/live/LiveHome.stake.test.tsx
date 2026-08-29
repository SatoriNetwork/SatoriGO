/**
 * @vitest-environment jsdom
 *
 * LiveHome's STAKING entry (owner, 2026-08-24: "stake powinno byc dostepne z
 * glownego ekranu obok send receive, i informacja ile mamy stakowanych a ile
 * dostepnych").
 *
 * What these tests protect:
 *   - the Stake action sits beside Send and Receive on a chain whose registry
 *     row carries `staking`, and opens the SAME screen the asset detail does;
 *   - the summary line appears ONLY when there is something to say (a
 *     delegation or a pending reward), never as a row of zeros and never as a
 *     spinner in the hero while the read is in flight;
 *   - the hero "Available" figure is untouched: it stays the spendable
 *     balance, which is not the staked one;
 *   - a chain WITHOUT native staking (Base, and every UTXO chain) renders
 *     exactly as before and makes no staking request at all.
 *
 * Real store + real EVM chain registry (so `evmStakingSupported()` answers the
 * way the app sees it), with the EVM balance/RPC path neutralized and the
 * staking read replaced by a spy: no network is touched.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({ evmEnabled: true }));

vi.mock('../../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => (hoisted.evmEnabled ? await import('../../services/chain/evm') : null),
  };
});

// The store's own documented "this build carries no EVM engine" fallback, which
// keeps every EVM balance read off the network (same stub as LiveHome.evm).
vi.mock('../../store/evmBalances', () => ({
  evmProviderFor: async () => null,
  refreshEvmWallet: async () => null,
}));

vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({}),
}));

import { MemoryStorageAdapter, setStorageForTests, type KeyValueStorage } from '../../services/storage';
import type { EvmStakingSnapshot } from '../../store/evmStaking';
import { NavProvider } from './LiveNav';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'password123';
const VALOPER = 'epixvaloper1qxt7awul3cyvgf2ku08k3n3nqn7lsqvsm7ryjw';
const ONE = 10n ** 18n;

type LiveStoreModule = typeof import('../../store/liveStore');
type LiveState = ReturnType<LiveStoreModule['useLiveStore']['getState']>;
type LiveHomeModule = typeof import('./LiveHome');
let storeMod: LiveStoreModule;
let LiveHome: LiveHomeModule['LiveHome'];
let storage: KeyValueStorage;
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = { tab: 'assets' as const, section: 'home' as const, openTab: () => {}, openSettings: () => {} };
function renderHome(onStake: () => void = () => {}) {
  return render(
    <NavProvider value={NAV_VALUE}>
      <LiveHome
        onReceive={() => {}}
        onSend={() => {}}
        onSelectAsset={() => {}}
        onSelectTx={() => {}}
        onStake={onStake}
      />
    </NavProvider>,
  );
}

/** A staking snapshot as the store hands it to the screens. */
function snapshot(over: Partial<EvmStakingSnapshot> = {}): EvmStakingSnapshot {
  return {
    chainKey: 'epix',
    bech32Address: 'epix1rmfv04clh6egzpengwkz6vt5xdne6q2nxxtg4x',
    unbondingSeconds: 1_814_400,
    maxEntries: 7,
    validators: [],
    delegations: [{ valoper: VALOPER, moniker: 'OneNov | Restake', amountBase: 5n * ONE, rewardBase: ONE / 2n }],
    unbonding: [],
    stakedTotalBase: 5n * ONE,
    rewardsTotalBase: ONE / 2n,
    issue: null,
    ...over,
  };
}

/** The EPIX row as the balance read produces it: 12 EPIX SPENDABLE, which is a
 *  different figure from what is staked and must stay the hero's. */
const EPIX_ROW = { name: 'EPIX', amountBase: 12n * ONE, scale: 18, decimals: 18, isNative: true };

let realRefreshEvmStaking: LiveState['refreshEvmStaking'];
let refreshEvmStaking: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  LiveHome = (await import('./LiveHome')).LiveHome;
  realRefreshEvmStaking = state().refreshEvmStaking;
});

beforeEach(async () => {
  hoisted.evmEnabled = true;
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  await state().resetLiveWallet();
  await state().init();
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  // The one store action Home may fire by itself here. A spy, so the tests can
  // assert it is NOT fired on a chain without staking, and so no test ever
  // reaches a Cosmos REST endpoint.
  refreshEvmStaking = vi.fn(async () => {});
  storeMod.useLiveStore.setState({ refreshEvmStaking });
});

afterEach(() => {
  state().stopAutoRefresh();
  storeMod.useLiveStore.setState({ refreshEvmStaking: realRefreshEvmStaking });
  cleanup();
});

/** Import the vector seed as an EVM account on `chain` and settle the store. */
async function importEvm(chain: 'evm:epix' | 'evm:base') {
  await state().importWallet(VECTOR_MNEMONIC, PW, 'My EVM', chain);
  await state().loadWallets();
}

describe('LiveHome: the Stake action on a chain with native staking', () => {
  it('offers Stake beside Send and Receive, opens the staking screen, and reads the staking data in the background', async () => {
    await importEvm('evm:epix');
    storeMod.useLiveStore.setState({ assets: [EPIX_ROW], evmStaking: { snapshot: snapshot(), loading: false, plan: null, planning: false } });
    const onStake = vi.fn();

    renderHome(onStake);

    // Beside the other two, not instead of them.
    expect(screen.getByTestId('live-send')).toBeInTheDocument();
    expect(screen.getByTestId('live-receive')).toBeInTheDocument();
    const stake = screen.getByTestId('live-action-stake');
    expect(stake).toHaveTextContent('Stake');
    fireEvent.click(stake);
    expect(onStake).toHaveBeenCalledTimes(1);

    // A snapshot was already cached for this chain, so the mount read is not
    // repeated: the store's cache is reused, exactly as intended.
    expect(refreshEvmStaking).not.toHaveBeenCalled();
  }, 30_000);

  it('reads the staking data on mount when nothing is cached for this chain yet', async () => {
    await importEvm('evm:epix');
    storeMod.useLiveStore.setState({ assets: [EPIX_ROW] });

    renderHome();

    await waitFor(() => expect(refreshEvmStaking).toHaveBeenCalledTimes(1));
    // Nothing to show yet, and NEVER a spinner in the hero for it.
    expect(screen.queryByTestId('live-stake-summary')).toBeNull();
    expect(screen.getByTestId('live-balance-hero')).toHaveTextContent('12');
  }, 30_000);

  it('summarises what is staked and earned under the hero, leaves the spendable balance alone, and opens the screen when clicked', async () => {
    await importEvm('evm:epix');
    storeMod.useLiveStore.setState({ assets: [EPIX_ROW], evmStaking: { snapshot: snapshot(), loading: false, plan: null, planning: false } });
    const onStake = vi.fn();

    renderHome(onStake);

    const summary = screen.getByTestId('live-stake-summary');
    expect(summary).toHaveTextContent('Staked 5 EPIX');
    expect(summary).toHaveTextContent('Rewards 0.5');
    // The hero is the SPENDABLE balance and must not have absorbed the stake.
    expect(screen.getByTestId('live-balance-hero')).toHaveTextContent('12');
    fireEvent.click(summary);
    expect(onStake).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('shows nothing for an account with no delegation and no rewards (never a row of zeros)', async () => {
    await importEvm('evm:epix');
    storeMod.useLiveStore.setState({
      assets: [EPIX_ROW],
      evmStaking: {
        snapshot: snapshot({ delegations: [], stakedTotalBase: 0n, rewardsTotalBase: 0n }),
        loading: false,
        plan: null,
        planning: false,
      },
    });

    renderHome();

    expect(screen.queryByTestId('live-stake-summary')).toBeNull();
    // The action itself stays: staking is offered whether or not you already do it.
    expect(screen.getByTestId('live-action-stake')).toBeInTheDocument();
  }, 30_000);

  it('a failed staking read renders nothing in the hero, not an error', async () => {
    await importEvm('evm:epix');
    storeMod.useLiveStore.setState({
      assets: [EPIX_ROW],
      evmStaking: {
        snapshot: snapshot({
          delegations: [],
          stakedTotalBase: 0n,
          rewardsTotalBase: 0n,
          issue: 'Your delegations could not be read: Epix could not be reached.',
        }),
        loading: false,
        plan: null,
        planning: false,
      },
    });

    renderHome();

    expect(screen.queryByTestId('live-stake-summary')).toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  }, 30_000);

  it('never shows another chain’s snapshot: a stale one is ignored', async () => {
    await importEvm('evm:epix');
    storeMod.useLiveStore.setState({
      assets: [EPIX_ROW],
      evmStaking: { snapshot: snapshot({ chainKey: 'somewhere-else' }), loading: false, plan: null, planning: false },
    });

    renderHome();

    expect(screen.queryByTestId('live-stake-summary')).toBeNull();
  }, 30_000);
});

describe('LiveHome on a chain WITHOUT native staking renders exactly as before', () => {
  it('a non-staking EVM chain (Base) has no Stake action, no summary, and asks for no staking data', async () => {
    await importEvm('evm:base');
    storeMod.useLiveStore.setState({
      assets: [{ name: 'ETH', amountBase: ONE, scale: 18, decimals: 18, isNative: true }],
      // Even with a snapshot lying around, Base must render as before.
      evmStaking: { snapshot: snapshot(), loading: false, plan: null, planning: false },
    });

    renderHome();

    expect(screen.getByTestId('live-send')).toBeInTheDocument();
    expect(screen.getByTestId('live-receive')).toBeInTheDocument();
    expect(screen.queryByTestId('live-action-stake')).toBeNull();
    expect(screen.queryByTestId('live-stake-summary')).toBeNull();
    expect(refreshEvmStaking).not.toHaveBeenCalled();
  }, 30_000);

  it('a UTXO chain (Evrmore) has no Stake action, no summary, and asks for no staking data', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My Evrmore', 'mainnet');
    await state().loadWallets();
    storeMod.useLiveStore.setState({
      assets: [{ name: 'EVR', amountBase: 100_000_000n, scale: 8, decimals: 8, isNative: true }],
    });

    renderHome();

    expect(screen.getByTestId('live-send')).toBeInTheDocument();
    expect(screen.queryByTestId('live-action-stake')).toBeNull();
    expect(screen.queryByTestId('live-stake-summary')).toBeNull();
    expect(refreshEvmStaking).not.toHaveBeenCalled();
  }, 30_000);
});
