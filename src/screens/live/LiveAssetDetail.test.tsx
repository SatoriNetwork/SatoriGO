/**
 * @vitest-environment jsdom
 *
 * The per-asset Activity list (owner, live testing 2026-08-25: "there is no
 * pagination in activities, I checked for USDT on EVM BNB"). This screen is
 * the surface he meant: the main Activity tab has had prev/next since 1.2, and
 * THIS one rendered every matching transaction in one unbroken scroll with no
 * controls at all.
 *
 * It now uses the same ActivityPager as the Activity tab, so both the pages and
 * the "Load older" control below them are the same component and cannot drift.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({ changes24h: {}, fetchedAt: 0 }),
  parseCoinexTicker: () => undefined,
}));

import { LiveAssetDetail } from './LiveAssetDetail';
import { NavProvider } from './LiveNav';
import { useLiveStore } from '../../store/liveStore';
import { ACTIVITY_PER_PAGE } from '../../services/activityFeed';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import type { LiveAssetBalance, LiveTransaction } from '../../services/chain/electrumProvider';

const USDT: LiveAssetBalance = {
  name: 'USDT',
  amountBase: 12_500_000_000_000_000_000n,
  scale: 18,
  decimals: 18,
  isNative: false,
};
const OTHER = '0x3535353535353535353535353535353535353535';

// The row's testid is the txid's first 8 characters, so the hashes vary at
// the FRONT: a zero-padded id would give every row the same testid.
const tx = (n: number, asset = 'USDT'): LiveTransaction => ({
  txid: '0x' + n.toString(16).padStart(2, '0').repeat(32),
  asset,
  direction: n % 2 === 0 ? 'in' : 'out',
  amount: n,
  feeEvr: 0,
  status: 'confirmed',
  blockHeight: 117_450_593 - n,
  timestamp: 1_725_000_000_000 - n * 86_400_000,
  counterparty: OTHER,
});

const NAV_VALUE = { tab: 'assets' as const, section: 'home' as const, openTab: () => {}, openSettings: () => {} };

function renderDetail() {
  return render(
    <NavProvider value={NAV_VALUE}>
      <LiveAssetDetail
        asset={USDT}
        onBack={() => {}}
        onReceive={() => {}}
        onSend={() => {}}
        onSelectTx={() => {}}
      />
    </NavProvider>,
  );
}

const rowIds = () =>
  screen
    .queryAllByTestId(/^live-tx-row-/)
    .map((el) => el.getAttribute('data-testid'));

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  useLiveStore.setState({
    txs: [],
    stakingEvents: [],
    staking: { ...useLiveStore.getState().staking, addressStatuses: [] },
    olderHistory: { canLoadOlder: null, cursor: null, loading: false, error: null },
  });
});

afterEach(() => {
  cleanup();
  useLiveStore.setState({ txs: [], olderHistory: { canLoadOlder: null, cursor: null, loading: false, error: null } });
});

describe('the per-asset Activity list', () => {
  it('shows ONE page of rows, not every transaction the wallet holds', () => {
    useLiveStore.setState({ txs: Array.from({ length: 25 }, (_, i) => tx(i + 1)) });
    renderDetail();

    expect(rowIds()).toHaveLength(ACTIVITY_PER_PAGE);
    expect(screen.getByTestId('asset-activity-page-info')).toHaveTextContent('page 1 of 3');
    expect(screen.getByTestId('asset-activity-page-prev')).toBeDisabled();
  });

  it('walks pages, and the last page carries the remainder', () => {
    useLiveStore.setState({ txs: Array.from({ length: 25 }, (_, i) => tx(i + 1)) });
    renderDetail();
    const first = rowIds();

    fireEvent.click(screen.getByTestId('asset-activity-page-next'));
    expect(screen.getByTestId('asset-activity-page-info')).toHaveTextContent('page 2 of 3');
    const second = rowIds();
    expect(second).toHaveLength(ACTIVITY_PER_PAGE);
    expect(second).not.toEqual(first);

    fireEvent.click(screen.getByTestId('asset-activity-page-next'));
    expect(screen.getByTestId('asset-activity-page-info')).toHaveTextContent('page 3 of 3');
    expect(rowIds()).toHaveLength(5);
    expect(screen.getByTestId('asset-activity-page-next')).toBeDisabled();
  });

  it('lists only THIS asset transactions, so the page count is the asset own', () => {
    useLiveStore.setState({
      txs: [...Array.from({ length: 12 }, (_, i) => tx(i + 1)), ...Array.from({ length: 30 }, (_, i) => tx(100 + i, 'BNB'))],
    });
    renderDetail();

    expect(screen.getByTestId('asset-activity-page-info')).toHaveTextContent('page 1 of 2');
  });

  it('shows no controls at all for a list that fits on one page and a source that has not answered yet', () => {
    useLiveStore.setState({ txs: [tx(1), tx(2)] });
    renderDetail();

    expect(rowIds()).toHaveLength(2);
    expect(screen.queryByTestId('asset-activity-pagination')).toBeNull();
    // canLoadOlder is null: the question is not settled, so nothing is offered
    // and nothing is claimed.
    expect(screen.queryByTestId('asset-activity-load-older')).toBeNull();
    expect(screen.queryByTestId('asset-activity-no-older')).toBeNull();
  });
});

describe('the "Load older" control on the per-asset list', () => {
  it('is offered on the LAST page once the source says it can go deeper', async () => {
    useLiveStore.setState({
      txs: Array.from({ length: 15 }, (_, i) => tx(i + 1)),
      olderHistory: { canLoadOlder: true, cursor: null, loading: false, error: null },
    });
    renderDetail();

    // Not on page 1: asking for older rows while looking at the newest ones is
    // a control with no relationship to what is on screen.
    expect(screen.queryByTestId('asset-activity-load-older')).toBeNull();

    fireEvent.click(screen.getByTestId('asset-activity-page-next'));
    expect(screen.getByTestId('asset-activity-load-older')).toBeEnabled();
  });

  it('asks the store for one more page when clicked', async () => {
    const loadOlderActivity = vi.fn().mockResolvedValue(undefined);
    useLiveStore.setState({
      txs: [tx(1)],
      olderHistory: { canLoadOlder: true, cursor: 'C1', loading: false, error: null },
      loadOlderActivity,
    });
    renderDetail();

    await act(async () => {
      fireEvent.click(screen.getByTestId('asset-activity-load-older'));
    });
    expect(loadOlderActivity).toHaveBeenCalledTimes(1);
  });

  it('says the history is complete instead of offering a button that returns nothing', () => {
    useLiveStore.setState({
      txs: [tx(1), tx(2)],
      olderHistory: { canLoadOlder: false, cursor: null, loading: false, error: null },
    });
    renderDetail();

    expect(screen.queryByTestId('asset-activity-load-older')).toBeNull();
    expect(screen.getByTestId('asset-activity-no-older')).toHaveTextContent('whole history');
  });

  it('shows why a page failed, without touching the rows', () => {
    useLiveStore.setState({
      txs: [tx(1), tx(2)],
      olderHistory: {
        canLoadOlder: true,
        cursor: 'C1',
        loading: false,
        error: 'Older BNB Chain activity could not be loaded: the history service is rate-limiting this wallet. Try again in a moment.',
      },
    });
    renderDetail();

    expect(screen.getByTestId('asset-activity-older-error')).toHaveTextContent('rate-limiting');
    expect(rowIds()).toHaveLength(2);
  });
});
