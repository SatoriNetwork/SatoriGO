/**
 * @vitest-environment jsdom
 *
 * The asset list's EDIT MODE (owner, 2026-08-25: an edit icon by the Assets
 * label; pressing it puts a drag handle and a tick on every token so the list
 * can be reordered and several tokens removed at once).
 *
 * What is proven here is what a user can actually do with it:
 *   - the toggle reveals handles and checkboxes, and hides them again,
 *   - the KEYBOARD moves a row (a drag-only control is unusable for some
 *     people, so this is not a nice-to-have),
 *   - the native coin can be neither moved nor ticked,
 *   - ticking two and removing them hides exactly those two,
 *   - Escape leaves the mode and clears the ticks,
 *   - normal mode is untouched: no handles, no ticks, no extra chrome.
 *
 * jsdom has no layout, so the DRAG itself (which is decided by row midpoints
 * from getBoundingClientRect) is not exercised here. It is checked in the
 * extension smoke, where there is a real popup with real geometry.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({ changes24h: {}, fetchedAt: 0 }),
  parseCoinexTicker: () => undefined,
}));

import { MemoryStorageAdapter, setStorageForTests, type KeyValueStorage } from '../../services/storage';
import { setTokenLogos } from '../../store/tokenLogoRegistry';
import type { LiveAssetBalance } from '../../services/chain/electrumProvider';
import { NavProvider } from './LiveNav';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

type LiveStoreModule = typeof import('../../store/liveStore');
type LiveHomeModule = typeof import('./LiveHome');
let storeMod: LiveStoreModule;
let LiveHome: LiveHomeModule['LiveHome'];
let storage: KeyValueStorage;
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = { tab: 'assets' as const, section: 'home' as const, openTab: () => {}, openSettings: () => {} };
function renderHome() {
  return render(
    <NavProvider value={NAV_VALUE}>
      <LiveHome onReceive={() => {}} onSend={() => {}} onSelectAsset={() => {}} onSelectTx={() => {}} />
    </NavProvider>,
  );
}

function asset(name: string, whole: number, isNative = false): LiveAssetBalance {
  return { name, amountBase: BigInt(Math.round(whole * 1e8)), scale: 8, decimals: 8, isNative };
}

/** The asset names currently rendered, in DOM order. */
function rowNames(): string[] {
  return screen
    .getAllByTestId(/^live-asset-row-/)
    .map((el) => el.getAttribute('data-testid')!.replace('live-asset-row-', ''));
}

const handleCount = () => screen.queryAllByTestId(/^live-asset-handle-/).length;
const tickCount = () => screen.queryAllByTestId(/^live-asset-select-/).length;
const enterEdit = () => fireEvent.click(screen.getByTestId('live-assets-edit'));

/** Four rows: the native coin plus three ordinary tokens, all held, so the
 *  automatic order is simply alphabetical after EVR and every move is visible. */
const FOUR_ROWS = {
  assets: [asset('EVR', 5, true), asset('AAA', 3), asset('BBB', 2), asset('CCC', 1)],
  pinnedAssets: [],
  hiddenAssets: [],
  assetOrder: [],
  prices: {},
};

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  LiveHome = (await import('./LiveHome')).LiveHome;
});

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  setTokenLogos([]);
  await state().resetLiveWallet();
  await state().init();
  storeMod.useLiveStore.setState(FOUR_ROWS);
});

afterEach(() => {
  state().stopAutoRefresh();
  setTokenLogos([]);
  cleanup();
});

describe('LiveHome asset list: entering and leaving edit mode', () => {
  it('is OFF by default: the rows carry no handle and no tick, and are still links', () => {
    renderHome();
    expect(screen.getByTestId('live-assets-edit')).toHaveAttribute('aria-pressed', 'false');
    expect(handleCount()).toBe(0);
    expect(tickCount()).toBe(0);
    expect(screen.queryByTestId('live-assets-edit-bar')).toBeNull();
    expect(screen.getByTestId('live-asset-row-AAA')).toHaveAttribute('role', 'button');
  });

  it('the toggle reveals a handle on every row and a tick on every REMOVABLE row', async () => {
    renderHome();
    enterEdit();

    await waitFor(() => expect(handleCount()).toBe(4));
    expect(screen.getByTestId('live-assets-edit')).toHaveAttribute('aria-pressed', 'true');
    // A tick on all four, but the native coin's is disabled: it can never be
    // selected, and hiding the control outright would misalign the columns.
    expect(tickCount()).toBe(4);
    expect(screen.getByTestId('live-asset-select-EVR')).toBeDisabled();
    expect(screen.getByTestId('live-asset-select-AAA')).not.toBeDisabled();
    // The native coin's handle is inert too.
    expect(screen.getByTestId('live-asset-handle-EVR')).toBeDisabled();
    expect(screen.getByTestId('live-asset-handle-AAA')).not.toBeDisabled();
    // The row stops being a link while the list is being arranged.
    expect(screen.getByTestId('live-asset-row-AAA')).not.toHaveAttribute('role');
    // The bar says what the mode can do before anything is ticked.
    expect(screen.getByTestId('live-assets-edit-bar')).toHaveTextContent(/Drag a handle to reorder/);
    expect(screen.queryByTestId('live-assets-remove-selected')).toBeNull();
  });

  it('the same button leaves the mode and puts the list back exactly as it was', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(handleCount()).toBe(4));

    fireEvent.click(screen.getByTestId('live-assets-edit'));
    await waitFor(() => expect(handleCount()).toBe(0));
    expect(tickCount()).toBe(0);
    expect(screen.queryByTestId('live-assets-edit-bar')).toBeNull();
    expect(screen.getByTestId('live-asset-row-AAA')).toHaveAttribute('role', 'button');
    expect(rowNames()).toEqual(['EVR', 'AAA', 'BBB', 'CCC']);
  });

  it('Escape leaves the mode AND clears the ticks', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(tickCount()).toBe(4));
    fireEvent.click(screen.getByTestId('live-asset-select-AAA'));
    await waitFor(() =>
      expect(screen.getByTestId('live-assets-selected-count')).toHaveTextContent('1 token selected'),
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(handleCount()).toBe(0));

    // Back in: nothing is ticked any more.
    enterEdit();
    await waitFor(() => expect(tickCount()).toBe(4));
    expect(screen.getByTestId('live-asset-select-AAA')).not.toBeChecked();
    expect(screen.queryByTestId('live-assets-selected-count')).toBeNull();
  });
});

describe('LiveHome asset list: reordering with the keyboard', () => {
  it('ArrowUp moves a row up, ArrowDown moves it back, and the order sticks', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(handleCount()).toBe(4));
    expect(rowNames()).toEqual(['EVR', 'AAA', 'BBB', 'CCC']);

    fireEvent.keyDown(screen.getByTestId('live-asset-handle-CCC'), { key: 'ArrowUp' });
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'AAA', 'CCC', 'BBB']));
    // The arrangement is the store's now, not a render-time accident.
    expect(state().assetOrder).toEqual(['AAA', 'CCC', 'BBB']);

    fireEvent.keyDown(screen.getByTestId('live-asset-handle-CCC'), { key: 'ArrowDown' });
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'AAA', 'BBB', 'CCC']));
  });

  it('keeps focus on the handle, so a row can be moved more than once', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(handleCount()).toBe(4));

    const handle = screen.getByTestId('live-asset-handle-CCC');
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'AAA', 'CCC', 'BBB']));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('live-asset-handle-CCC')),
    );

    fireEvent.keyDown(screen.getByTestId('live-asset-handle-CCC'), { key: 'ArrowUp' });
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'CCC', 'AAA', 'BBB']));
  });

  it('the native coin stays first: a row cannot be moved above it', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(handleCount()).toBe(4));

    // AAA is already the first reorderable row; pressing up must not displace EVR.
    fireEvent.keyDown(screen.getByTestId('live-asset-handle-AAA'), { key: 'ArrowUp' });
    await waitFor(() => expect(rowNames()[0]).toBe('EVR'));
    expect(rowNames()).toEqual(['EVR', 'AAA', 'BBB', 'CCC']);
  });

  it('Home and End send a row to the ends of the reorderable list', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(handleCount()).toBe(4));

    fireEvent.keyDown(screen.getByTestId('live-asset-handle-CCC'), { key: 'Home' });
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'CCC', 'AAA', 'BBB']));

    fireEvent.keyDown(screen.getByTestId('live-asset-handle-CCC'), { key: 'End' });
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'AAA', 'BBB', 'CCC']));
  });

  it('a token that arrives later lands AFTER the arranged rows, leaving them alone', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(handleCount()).toBe(4));
    fireEvent.keyDown(screen.getByTestId('live-asset-handle-CCC'), { key: 'Home' });
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'CCC', 'AAA', 'BBB']));

    storeMod.useLiveStore.setState({
      assets: [...FOUR_ROWS.assets, asset('NEW', 9)],
    });
    // NEW would sort second alphabetically among the holdings, but it has no
    // stored place, so it goes to the end rather than shuffling the arrangement.
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'CCC', 'AAA', 'BBB', 'NEW']));
  });

  it('an order entry for a token that is gone is ignored, not resurrected', async () => {
    storeMod.useLiveStore.setState({ assetOrder: ['GONE', 'CCC', 'AAA', 'BBB'] });
    renderHome();
    expect(rowNames()).toEqual(['EVR', 'CCC', 'AAA', 'BBB']);
  });
});

describe('LiveHome asset list: removing several tokens at once', () => {
  it('tick two, remove them, and exactly those two are gone', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(tickCount()).toBe(4));

    fireEvent.click(screen.getByTestId('live-asset-select-AAA'));
    fireEvent.click(screen.getByTestId('live-asset-select-CCC'));
    await waitFor(() =>
      expect(screen.getByTestId('live-assets-selected-count')).toHaveTextContent('2 tokens selected'),
    );
    expect(screen.getByTestId('live-assets-remove-selected')).toHaveTextContent(
      'Remove 2 from the list',
    );

    fireEvent.click(screen.getByTestId('live-assets-remove-selected'));
    // The confirmation says what removal actually means before anything happens.
    const modal = await screen.findByTestId('live-assets-remove-modal');
    expect(modal).toHaveTextContent('hidden from this list only');
    expect(modal).toHaveTextContent('stays on the blockchain');
    expect(modal).toHaveTextContent('Add token');
    expect(rowNames()).toEqual(['EVR', 'AAA', 'BBB', 'CCC']); // nothing yet

    fireEvent.click(screen.getByTestId('live-assets-remove-modal-confirm'));
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'BBB']));
    // Through the SAME mechanism the asset detail's remove uses.
    expect(state().hiddenAssets).toEqual(['AAA', 'CCC']);
    // The selection is spent; the bar goes back to its hint.
    expect(screen.queryByTestId('live-assets-selected-count')).toBeNull();
    expect(handleCount()).toBe(2); // still in edit mode
  });

  it('cancelling the confirmation removes nothing and keeps the ticks', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(tickCount()).toBe(4));
    fireEvent.click(screen.getByTestId('live-asset-select-AAA'));
    fireEvent.click(screen.getByTestId('live-assets-remove-selected'));
    await screen.findByTestId('live-assets-remove-modal');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('live-assets-remove-modal')).toBeNull());
    expect(rowNames()).toEqual(['EVR', 'AAA', 'BBB', 'CCC']);
    expect(state().hiddenAssets).toEqual([]);
    expect(screen.getByTestId('live-asset-select-AAA')).toBeChecked();
  });

  it('the native coin cannot be ticked, so it can never be in the batch', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(tickCount()).toBe(4));

    fireEvent.click(screen.getByTestId('live-asset-select-EVR'));
    // A disabled checkbox fires nothing; the model refuses it in any case.
    expect(screen.getByTestId('live-asset-select-EVR')).not.toBeChecked();
    expect(screen.queryByTestId('live-assets-selected-count')).toBeNull();
    expect(screen.queryByTestId('live-assets-remove-selected')).toBeNull();
  });

  it('says "1 token" for a single tick', async () => {
    renderHome();
    enterEdit();
    await waitFor(() => expect(tickCount()).toBe(4));
    fireEvent.click(screen.getByTestId('live-asset-select-BBB'));
    await waitFor(() =>
      expect(screen.getByTestId('live-assets-selected-count')).toHaveTextContent('1 token selected'),
    );
    expect(screen.getByTestId('live-assets-remove-selected')).toHaveTextContent(
      'Remove 1 from the list',
    );
  });
});
