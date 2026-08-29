/**
 * @vitest-environment jsdom
 *
 * LiveHome's ASSET LIST: the three things that decide what the user sees in it
 * and in what order.
 *
 *   - ORDER (assetOrder.ts, unit-tested on its own): value and trust first, the
 *     alphabet only as a tie-break, and the list RE-SORTS when prices or trust
 *     verdicts land after the first render.
 *   - "Hide zero balances": a persisted view filter that never touches the
 *     native coin and always says how many rows it took out.
 *   - The 24h change chip beside a row's fiat value.
 *
 * No wallet is imported and no network is touched: LiveHome reads everything it
 * needs from the store, so injecting state is both faster and a more honest test
 * of the rendering than driving a real import would be.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

// Prices are decorative and hit the network — stub so init()'s fire-and-forget
// fetch is inert (the same stub the other LiveHome tests use).
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

/** Terse asset row. Amounts are whole units; assets are 1e8-scaled on-chain. */
function asset(name: string, whole: number, isNative = false): LiveAssetBalance {
  return {
    name,
    amountBase: BigInt(Math.round(whole * 1e8)),
    scale: 8,
    decimals: 8,
    isNative,
  };
}

/** The asset names currently rendered, in DOM order. */
function rowNames(): string[] {
  return screen
    .getAllByTestId(/^live-asset-row-/)
    .map((el) => el.getAttribute('data-testid')!.replace('live-asset-row-', ''));
}

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
});

afterEach(() => {
  state().stopAutoRefresh();
  setTokenLogos([]);
  cleanup();
});

describe('LiveHome asset list order', () => {
  it('puts the native coin first, then value, then holdings, and sinks spam and empties', async () => {
    storeMod.useLiveStore.setState({
      assets: [
        asset('(t.me/s/US_POOL) claim', 1),
        asset('EMPTYTOKEN', 0),
        asset('SATORIEVR', 100),
        asset('ZULU', 3),
        asset('EVR', 5, true),
      ],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: { SATORIEVR: 0.23 },
    });
    setTokenLogos([
      { symbol: '(t.me/s/US_POOL) claim', trusted: false },
      { symbol: 'ZULU', trusted: true },
    ]);

    renderHome();

    expect(rowNames()).toEqual([
      'EVR', // native, always first
      'SATORIEVR', // the only priced holding ($23)
      'ZULU', // held, listed
      '(t.me/s/US_POOL) claim', // held but NOT in the registry
      'EMPTYTOKEN', // zero balance
    ]);
  });

  it('re-sorts when a price arrives after the first render', async () => {
    storeMod.useLiveStore.setState({
      assets: [asset('EVR', 1, true), asset('AAA', 4), asset('SATORIEVR', 50)],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: {},
    });

    renderHome();
    // No prices yet: the two holdings are simply alphabetical.
    expect(rowNames()).toEqual(['EVR', 'AAA', 'SATORIEVR']);

    storeMod.useLiveStore.setState({ prices: { SATORIEVR: 0.23 } });
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'SATORIEVR', 'AAA']));
  });

  it('re-sorts when the trust registry answers after the first render', async () => {
    storeMod.useLiveStore.setState({
      assets: [asset('EVR', 1, true), asset('$CLAIM', 2), asset('WETH', 2)],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: {},
    });

    renderHome();
    // Nothing checked yet: both are "unknown", so the alphabet decides and the
    // spam name wins, exactly as it used to.
    expect(rowNames()).toEqual(['EVR', '$CLAIM', 'WETH']);

    // The registry probe lands — the list must re-sort without a re-render from
    // anywhere else (trust lives in an external store, not in the live store).
    setTokenLogos([
      { symbol: '$CLAIM', trusted: false },
      { symbol: 'WETH', trusted: true },
    ]);
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'WETH', '$CLAIM']));
  });
});

describe('LiveHome privacy mode (hide balances)', () => {
  it('the eye beside the hero masks the hero, the total, every row amount and the activity amounts; persists; the eye toggles back', async () => {
    storeMod.useLiveStore.setState({
      assets: [asset('EVR', 12.5, true), asset('HELD', 7)],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: { EVR: 2 },
      txs: [
        { txid: '0x' + 'ab'.repeat(32), asset: 'EVR', direction: 'in', amount: 3, feeEvr: 0, status: 'confirmed', blockHeight: 1, timestamp: 1_700_000_000, counterparty: 'EXabc' },
      ],
    });
    renderHome();
    expect(state().hideBalances).toBe(false);
    expect(screen.getByTestId('live-balance-hero')).toHaveTextContent('12.5');
    expect(screen.getByTestId('live-balance-HELD')).toHaveTextContent('7');

    fireEvent.click(screen.getByTestId('live-hide-balances'));
    await waitFor(() => expect(state().hideBalances).toBe(true));
    expect(screen.getByTestId('live-balance-hero')).not.toHaveTextContent('12.5');
    expect(screen.getByTestId('live-balance-hero')).toHaveTextContent('••••');
    expect(screen.getByTestId('live-balance-HELD')).toHaveTextContent('••••');
    expect(screen.getByTestId('total-balance')).toHaveTextContent('••••');
    expect(screen.getByTestId('live-hide-balances')).toHaveAttribute('aria-pressed', 'true');
    // Persisted under its own key.
    expect(await (await import('../../services/storage')).getStorage().get<boolean>('ui:hideBalances')).toBe(true);

    fireEvent.click(screen.getByTestId('live-hide-balances'));
    await waitFor(() => expect(state().hideBalances).toBe(false));
    expect(screen.getByTestId('live-balance-hero')).toHaveTextContent('12.5');
  });
});

describe('LiveHome "hide zero balances"', () => {
  const withEmpties = {
    assets: [asset('EVR', 0, true), asset('USDC', 0), asset('HELD', 7), asset('SPARE', 0)],
    pinnedAssets: [],
    hiddenAssets: [],
    prices: {},
  };

  it('is off by default: every row shows and there is no note', async () => {
    storeMod.useLiveStore.setState(withEmpties);
    renderHome();

    expect(state().hideZeroBalances).toBe(false);
    expect(rowNames()).toEqual(['EVR', 'HELD', 'SPARE', 'USDC']);
    expect(screen.queryByTestId('live-hidden-zero-note')).toBeNull();
    expect(screen.getByTestId('live-hide-zero')).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides the empty rows (never the native coin), counts them, and the note puts them back', async () => {
    storeMod.useLiveStore.setState(withEmpties);
    renderHome();

    fireEvent.click(screen.getByTestId('live-hide-zero'));

    // EVR is empty too, and stays: a wallet must show the coin it is a wallet for.
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'HELD']));
    expect(screen.getByTestId('live-hide-zero')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('live-hidden-zero-note')).toHaveTextContent(
      '2 tokens with zero balance hidden',
    );

    // The note is itself the way back.
    fireEvent.click(screen.getByTestId('live-hidden-zero-note'));
    await waitFor(() => expect(rowNames()).toEqual(['EVR', 'HELD', 'SPARE', 'USDC']));
    expect(screen.queryByTestId('live-hidden-zero-note')).toBeNull();
  });

  it('says "1 token" for a single hidden row', async () => {
    storeMod.useLiveStore.setState({
      assets: [asset('EVR', 2, true), asset('USDC', 0), asset('HELD', 7)],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: {},
    });
    renderHome();

    fireEvent.click(screen.getByTestId('live-hide-zero'));

    await waitFor(() =>
      expect(screen.getByTestId('live-hidden-zero-note')).toHaveTextContent(
        '1 token with zero balance hidden',
      ),
    );
  });

  it('persists globally: the flag is written, and init() reads it back', async () => {
    storeMod.useLiveStore.setState(withEmpties);
    renderHome();

    fireEvent.click(screen.getByTestId('live-hide-zero'));
    await waitFor(async () => expect(await storage.get('ui:hideZeroBalances')).toBe(true));

    // A fresh boot on the same storage starts with the rows already hidden.
    cleanup();
    await state().init();
    expect(state().hideZeroBalances).toBe(true);
  });
});

describe('LiveHome 24h change chip', () => {
  it('shows a signed, coloured percent beside the fiat value, only where one is known', async () => {
    storeMod.useLiveStore.setState({
      assets: [asset('EVR', 10, true), asset('SATORIEVR', 100), asset('OTHER', 5)],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: { SATORIEVR: 0.23 },
      priceChanges24h: { SATORIEVR: 2.4 },
    });

    renderHome();

    const chip = screen.getByTestId('live-asset-change-SATORIEVR');
    expect(chip).toHaveTextContent('+2.4%');
    expect(chip.getAttribute('style')).toContain('var(--success)');
    // It sits inside the SATORIEVR row, next to that row's fiat value.
    const row = screen.getByTestId('live-asset-row-SATORIEVR');
    expect(within(row).getByTestId('live-asset-usd-SATORIEVR')).toBeInTheDocument();

    // No change known for the others: no chip at all, never a "0.0%" stand-in.
    expect(screen.queryByTestId('live-asset-change-OTHER')).toBeNull();
    expect(screen.queryByTestId('live-asset-change-EVR')).toBeNull();
  });

  it('paints a loss in the danger colour', async () => {
    storeMod.useLiveStore.setState({
      assets: [asset('EVR', 10, true), asset('SATORIEVR', 100)],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: { SATORIEVR: 0.23 },
      priceChanges24h: { SATORIEVR: -0.83 },
    });

    renderHome();

    const chip = screen.getByTestId('live-asset-change-SATORIEVR');
    expect(chip).toHaveTextContent('-0.8%');
    expect(chip.getAttribute('style')).toContain('var(--danger)');
  });

  it('shows the chip even without a fiat value for the asset', async () => {
    storeMod.useLiveStore.setState({
      assets: [asset('EVR', 10, true), asset('SATORIEVR', 100)],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: {},
      priceChanges24h: { SATORIEVR: 5.56 },
    });

    renderHome();

    expect(screen.queryByTestId('live-asset-usd-SATORIEVR')).toBeNull();
    // One decimal on a row this size: 5.56 reads as +5.6%.
    expect(screen.getByTestId('live-asset-change-SATORIEVR')).toHaveTextContent('+5.6%');
  });
});

describe('LiveHome list balances: six significant digits, the full figure in the tooltip', () => {
  // 999.999579999999999979 EPIX: an 18-decimal balance that, printed in full,
  // pushed the fiat value under the 24h chip (owner, 2026-08-21).
  const epix: LiveAssetBalance = {
    name: 'EPIX',
    amountBase: 999_999_579_999_999_999_979n,
    scale: 18,
    decimals: 18,
    isNative: false,
  };

  it('the row and the hero show the truncated figure, the tooltip every digit', async () => {
    storeMod.useLiveStore.setState({
      // The hero is the chain's native row (8 decimals here): 999.99999999 EVR.
      assets: [asset('EVR', 999.99999999, true), epix],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: { EPIX: 0.00008828 },
      priceChanges24h: { EPIX: -2.3 },
    });

    renderHome();

    const row = screen.getByTestId('live-balance-EPIX');
    expect(row).toHaveTextContent(/^999\.999$/);
    expect(row).toHaveAttribute('title', '999.999579999999999979 EPIX');
    // (No fiat on this row: a non-native token is never priced by its name.)
    expect(screen.getByTestId('live-asset-change-EPIX')).toHaveTextContent('-2.3%');
    const hero = screen.getByTestId('live-balance-hero');
    expect(hero).toHaveTextContent(/^999\.999EVR$/);
    expect(hero.textContent).not.toContain('999.9999');
    expect(hero).toHaveAttribute('title', '999.99999999 EVR');
  });

  it('dust is "<0.00000001", never "0"', async () => {
    storeMod.useLiveStore.setState({
      assets: [asset('EVR', 1, true), { ...epix, amountBase: 1n }],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: {},
      priceChanges24h: {},
    });
    renderHome();
    expect(screen.getByTestId('live-balance-EPIX')).toHaveTextContent('<0.00000001');
  });
});

describe('LiveHome asset rows carry no remove control', () => {
  it('offers no inline x on any row (removing lives on the asset detail screen)', async () => {
    storeMod.useLiveStore.setState({
      assets: [asset('EVR', 1, true), asset('SATORIEVR', 2), asset('REMOVABLE', 3)],
      pinnedAssets: [],
      hiddenAssets: [],
      prices: {},
    });

    renderHome();

    expect(screen.queryByTestId(/^live-remove-asset-/)).toBeNull();
    expect(screen.queryByLabelText(/^Remove /)).toBeNull();
  });
});
