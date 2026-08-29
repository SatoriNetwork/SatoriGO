/**
 * @vitest-environment jsdom
 *
 * Activity rows for a NATIVE STAKING transaction (owner, 2026-08-24: "w
 * activity powinna byc historia co staked co nie i gdzie").
 *
 * A staking call has value 0 and a precompile for a recipient, so without a
 * label it reads as "Sent 0 EPIX to 0x...0800", which tells the user nothing.
 * These pin what it reads as instead: the action, the validator (by name where
 * the chain gave us one), and the amount for the three actions that carry one.
 *
 * The last test is the one that matters most for everything else in the wallet:
 * a row WITHOUT the new field renders exactly as it always did.
 *
 * Real store, real EVM registry, no network (the EVM balance path is stubbed
 * out and prices are inert, same harness as LiveHome.evm.test.tsx).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/chain/engine')>();
  return { ...actual, loadEvmModules: async () => await import('../../services/chain/evm') };
});

vi.mock('../../store/evmBalances', () => ({
  evmProviderFor: async () => null,
  refreshEvmWallet: async () => null,
  readEvmDiscoveredBalances: async () => ({ rows: [], complete: true }),
  resetEvmProvidersForTests: () => {},
}));

vi.mock('../../services/prices', () => ({ fetchPrices: async () => ({}) }));

import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import type { LiveTransaction } from '../../services/chain/electrumProvider';
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
const VALOPER_2 = 'epixvaloper1qjynz59x6c0y2l5cf7gtyl8arjpg0k0rejn0lk';
const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000000800';
const H = (n: string) => `0x${n.repeat(32)}`;

type LiveStoreModule = typeof import('../../store/liveStore');
type LiveHomeModule = typeof import('./LiveHome');
let storeMod: LiveStoreModule;
let LiveHome: LiveHomeModule['LiveHome'];
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = { tab: 'activity' as const, section: 'home' as const, openTab: () => {}, openSettings: () => {} };
function renderActivity() {
  return render(
    <NavProvider value={NAV_VALUE}>
      <LiveHome onReceive={() => {}} onSend={() => {}} onSelectAsset={() => {}} onSelectTx={() => {}} />
    </NavProvider>,
  );
}

/** A staking Activity row, in the shape the store holds it. */
function stakingRow(txid: string, staking: NonNullable<LiveTransaction['staking']>): LiveTransaction {
  return {
    txid,
    asset: 'EPIX',
    direction: 'out',
    amount: 0,
    feeEvr: 0.003,
    status: 'confirmed',
    blockHeight: 900_001,
    timestamp: 1_725_100_100_000,
    counterparty: STAKING_PRECOMPILE,
    staking,
  };
}

/** The validators cache the Stake screen fills, as a snapshot for one chain. */
function withValidators(validators: Array<{ valoper: string; moniker: string }>) {
  storeMod.useLiveStore.setState({
    evmStaking: {
      loading: false,
      plan: null,
      planning: false,
      snapshot: {
        chainKey: 'epix',
        bech32Address: 'epix1rmfv04clh6egzpengwkz6vt5xdne6q2nxxtg4x',
        unbondingSeconds: 1_814_400,
        maxEntries: 7,
        validators: validators.map((v) => ({ ...v, jailed: false, commissionRate: 0.05, tokensBase: 1n })),
        delegations: [],
        unbonding: [],
        stakedTotalBase: 0n,
        rewardsTotalBase: 0n,
        issue: null,
      },
    },
  });
}

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  LiveHome = (await import('./LiveHome')).LiveHome;
});

beforeEach(async () => {
  setStorageForTests(new MemoryStorageAdapter());
  await state().resetLiveWallet();
  await state().init();
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
});

afterEach(() => {
  state().stopAutoRefresh();
  cleanup();
});

async function onEpix() {
  await state().importWallet(VECTOR_MNEMONIC, PW, 'My EVM', 'evm:epix');
  await state().loadWallets();
}

describe('Activity rows for a native staking transaction', () => {
  it('names the action, the validator by its moniker, and the exact amount', async () => {
    await onEpix();
    withValidators([{ valoper: VALOPER, moniker: 'OneNov' }]);
    storeMod.useLiveStore.setState({
      historyLoading: false,
      txs: [stakingRow(H('a1'), { kind: 'stake', validator: VALOPER, amountBase: 12_500_000_000_000_000_000n })],
    });
    renderActivity();

    expect(screen.getByTestId(`live-tx-staking-${H('a1')}`)).toHaveTextContent('Staked');
    expect(screen.getByText('OneNov')).toBeInTheDocument();
    expect(screen.getByText('12.5 EPIX')).toBeInTheDocument();
    // Never the old reading.
    expect(screen.queryByText(/Sent EPIX/)).toBeNull();
    expect(screen.queryByText(/-0 EPIX/)).toBeNull();
  }, 30_000);

  it('falls back to the shortened operator address when the validators cache has not loaded', async () => {
    await onEpix();
    storeMod.useLiveStore.setState({
      historyLoading: false,
      txs: [stakingRow(H('b2'), { kind: 'unstake', validator: VALOPER, amountBase: 1_000_000_000_000_000_000n })],
    });
    renderActivity();

    expect(screen.getByTestId(`live-tx-staking-${H('b2')}`)).toHaveTextContent('Unstaked');
    expect(screen.getByText('epixvaloper1qx...m7ryjw')).toBeInTheDocument();
    expect(screen.getByText('1 EPIX')).toBeInTheDocument();
  }, 30_000);

  it('a redelegate names BOTH validators, source first', async () => {
    await onEpix();
    withValidators([
      { valoper: VALOPER, moniker: 'OneNov' },
      { valoper: VALOPER_2, moniker: 'Stakecito' },
    ]);
    storeMod.useLiveStore.setState({
      historyLoading: false,
      txs: [
        stakingRow(H('c3'), {
          kind: 'redelegate',
          validator: VALOPER,
          validatorDst: VALOPER_2,
          amountBase: 5_000_000_000_000_000_000n,
        }),
      ],
    });
    renderActivity();

    expect(screen.getByTestId(`live-tx-staking-${H('c3')}`)).toHaveTextContent('Redelegated');
    expect(screen.getByText('OneNov to Stakecito')).toBeInTheDocument();
    expect(screen.getByText('5 EPIX')).toBeInTheDocument();
  }, 30_000);

  it('a claim shows NO amount (never a fake 0), and a mixed name/address pair still reads', async () => {
    await onEpix();
    withValidators([{ valoper: VALOPER_2, moniker: 'Stakecito' }]);
    storeMod.useLiveStore.setState({
      historyLoading: false,
      txs: [stakingRow(H('d4'), { kind: 'claim', validator: VALOPER })],
    });
    renderActivity();

    const label = screen.getByTestId(`live-tx-staking-${H('d4')}`);
    expect(label).toHaveTextContent('Claimed rewards');
    // The validator this account claimed from is not in the cache: the address.
    expect(screen.getByText('epixvaloper1qx...m7ryjw')).toBeInTheDocument();
    // No amount anywhere on the row, and above all no "0 EPIX" and no "+0".
    expect(screen.queryByText(/0 EPIX/)).toBeNull();
    expect(screen.queryByText(/^[+-]/)).toBeNull();
  }, 30_000);

  it('a row WITHOUT the field renders exactly as before, on the same screen and on a UTXO wallet', async () => {
    // 1. On the staking chain itself, beside a labelled row.
    await onEpix();
    withValidators([{ valoper: VALOPER, moniker: 'OneNov' }]);
    const plain: LiveTransaction = {
      txid: H('e5'),
      asset: 'EPIX',
      direction: 'in',
      amount: 2.25,
      feeEvr: 0,
      status: 'confirmed',
      blockHeight: 900_000,
      timestamp: 1_725_100_000_000,
      counterparty: '0x3535353535353535353535353535353535353535',
    };
    storeMod.useLiveStore.setState({
      historyLoading: false,
      txs: [stakingRow(H('a1'), { kind: 'stake', validator: VALOPER, amountBase: 1n }), plain],
    });
    const first = renderActivity();
    expect(screen.getByText('Received EPIX')).toBeInTheDocument();
    expect(screen.getByText('+2.25 EPIX')).toBeInTheDocument();
    expect(screen.getByText(`${H('e5').slice(0, 10)}...`)).toBeInTheDocument();
    expect(screen.queryByTestId(`live-tx-staking-${H('e5')}`)).toBeNull();
    first.unmount();
    cleanup();

    // 2. And on a UTXO wallet, where the field can never exist at all.
    setStorageForTests(new MemoryStorageAdapter());
    await state().resetLiveWallet();
    await state().init();
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My Evrmore', 'mainnet');
    await state().loadWallets();
    storeMod.useLiveStore.setState({
      historyLoading: false,
      txs: [
        {
          txid: 'f6'.repeat(32),
          asset: 'EVR',
          direction: 'out',
          amount: 10,
          feeEvr: 0.01,
          status: 'confirmed',
          blockHeight: 500,
          timestamp: 1_725_000_000_000,
          counterparty: 'EXXaddressXX',
        },
      ],
    });
    renderActivity();
    expect(screen.getByText('Sent EVR')).toBeInTheDocument();
    expect(screen.getByText('-10 EVR')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid^="live-tx-staking-"]')).toHaveLength(0);
  }, 60_000);
});
