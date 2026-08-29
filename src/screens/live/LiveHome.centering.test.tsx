/**
 * @vitest-environment jsdom
 *
 * Home's VERTICAL CENTRING contract (owner, 2026-08-24: the side panel is a
 * whole browser window tall, so a wallet holding one or two tokens left a large
 * dead zone under the list; "move the whole thing to the centre, and as tokens
 * are added it should move up").
 *
 * The centring itself is pure CSS (flex auto margins on .home-hero-wrap and
 * .home-scroll, see the .home-centered rules in global.css) and jsdom computes
 * NO layout, so there is nothing here that could honestly assert a pixel. What
 * this file pins is the part jsdom CAN see and the part a refactor would break:
 * WHICH element carries the marker class, that the two blocks the auto margins
 * hang off are still there in the right order, and that neither the Activity
 * tab nor a chain without an asset list is dragged into the pattern.
 *
 * The geometry (dead centre when short, top-anchored and scrolling when it
 * overflows) is asserted with real boxes in scripts/evm-extension-smoke.mjs.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';

// Prices are decorative and hit the network. Stub so init()'s fire-and-forget
// fetch is inert (the same stub the other LiveHome tests use).
vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({ changes24h: {}, fetchedAt: 0 }),
  parseCoinexTicker: () => undefined,
}));

import { MemoryStorageAdapter, setStorageForTests, type KeyValueStorage } from '../../services/storage';
import { parseNotificationItem } from '../../services/notifications';
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
let TIGHT_LIST_ROWS: number;
let storage: KeyValueStorage;
const state = () => storeMod.useLiveStore.getState();

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'password123';

const NAV_VALUE = { tab: 'assets' as const, section: 'home' as const, openTab: () => {}, openSettings: () => {} };
function renderHome(tab: 'assets' | 'activity' = 'assets') {
  return render(
    <NavProvider value={{ ...NAV_VALUE, tab }}>
      <LiveHome onReceive={() => {}} onSend={() => {}} onSelectAsset={() => {}} onSelectTx={() => {}} />
    </NavProvider>,
  );
}

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  const mod = await import('./LiveHome');
  LiveHome = mod.LiveHome;
  TIGHT_LIST_ROWS = mod.TIGHT_LIST_ROWS;
});

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  await state().resetLiveWallet();
  await state().init();
});

afterEach(() => {
  state().stopAutoRefresh();
  cleanup();
});

describe('LiveHome vertical centring (assets tab, chain with a token list)', () => {
  it('marks the scrolling container .home-centered and keeps the two blocks the auto margins hang off', () => {
    renderHome();

    const panel = screen.getByTestId('live-tab-panel-assets');
    expect(panel.classList.contains('app-content')).toBe(true);
    expect(panel.classList.contains('home-pinned')).toBe(true);
    expect(panel.classList.contains('home-centered')).toBe(true);
    // Never both: .home-roomy is the OTHER layout (a chain with no list), and
    // stacking them would centre the hero twice.
    expect(panel.classList.contains('home-roomy')).toBe(false);

    // margin-top:auto hangs off .home-hero-wrap, margin-bottom:auto off
    // .home-scroll; both must be DIRECT flex children of the container, or the
    // auto margins take their space from a nested box instead of this one.
    const heroWrap = panel.querySelector(':scope > .home-hero-wrap');
    const scroll = panel.querySelector(':scope > .home-scroll');
    expect(heroWrap).not.toBeNull();
    expect(scroll).not.toBeNull();
    // ...and in this order, with the status row above them both (it is the top
    // edge of the tab: the block is centred in the space UNDER it).
    const statusRow = screen.getByTestId('live-home-status');
    const order = [...panel.children];
    expect(order.indexOf(statusRow)).toBeLessThan(order.indexOf(heroWrap!));
    expect(order.indexOf(heroWrap!)).toBeLessThan(order.indexOf(scroll!));

    // The footer rides at the END of the scroll region (so it scrolls with the
    // rows), which is what makes it part of the centred block.
    expect(scroll!.textContent).toContain('Satori Network');
  });

  it('leaves the Activity tab out of it', () => {
    renderHome('activity');

    const panel = screen.getByTestId('live-tab-panel-activity');
    expect(panel.classList.contains('app-content')).toBe(true);
    expect(panel.classList.contains('home-centered')).toBe(false);
    expect(panel.classList.contains('home-pinned')).toBe(false);
  });
});

describe('LiveHome with an owner-authored notice on screen', () => {
  /** A notice that targets everyone, built through the real parser so this test
   *  never has to restate the NotificationItem shape. */
  const anyNotice = (id: string, title: string) =>
    parseNotificationItem({ id, title, body: 'Body text.', severity: 'info' })!;

  it('adds no has-notice marker when there is nothing to show', () => {
    renderHome();
    const panel = screen.getByTestId('live-tab-panel-assets');
    expect(panel.classList.contains('home-centered')).toBe(true);
    expect(panel.classList.contains('has-notice')).toBe(false);
    expect(screen.queryByTestId('live-notification')).toBeNull();
  });

  it('marks the container has-notice so the hero hugs the banner instead of centring under it', async () => {
    renderHome();
    await act(async () => {
      storeMod.useLiveStore.setState({ notifications: [anyNotice('n1', 'Heads up')] });
    });

    const panel = screen.getByTestId('live-tab-panel-assets');
    // The centring itself is untouched: the marker only drops the TOP auto
    // margin (see .home-centered.has-notice in global.css), so the block still
    // hangs off the same two elements.
    expect(panel.classList.contains('home-centered')).toBe(true);
    expect(panel.classList.contains('has-notice')).toBe(true);

    // ...and the banner is still a DIRECT child of the container, above the
    // hero wrap the (now zero) top margin hangs off. If it ever moved inside
    // the wrap, the rule would be pulling on the wrong box.
    const banner = screen.getByTestId('live-notification');
    const heroWrap = panel.querySelector(':scope > .home-hero-wrap');
    const order = [...panel.children];
    expect(order.indexOf(banner)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(banner)).toBeLessThan(order.indexOf(heroWrap!));
  });

  it('drops the marker again once the notice is dismissed', async () => {
    renderHome();
    await act(async () => {
      storeMod.useLiveStore.setState({ notifications: [anyNotice('n1', 'Heads up')] });
    });
    expect(screen.getByTestId('live-tab-panel-assets').classList.contains('has-notice')).toBe(true);

    await act(async () => {
      await state().dismissNotification('n1');
    });
    expect(screen.getByTestId('live-tab-panel-assets').classList.contains('has-notice')).toBe(false);
    expect(screen.queryByTestId('live-notification')).toBeNull();
  });
});

describe('LiveHome scroll affordance', () => {
  it('renders the "more below" cue as a sibling of the scroll region, not inside it', () => {
    renderHome();
    const panel = screen.getByTestId('live-tab-panel-assets');
    const scroll = panel.querySelector(':scope > .home-scroll');
    const cue = screen.getByTestId('live-home-scroll-cue');

    // Inside the region it would scroll away with the rows and be clipped by
    // the region's own mask; as a sibling it is anchored to the container's
    // bottom padding band, under the last row.
    expect(scroll!.contains(cue)).toBe(false);
    expect([...panel.children].indexOf(cue)).toBeGreaterThan([...panel.children].indexOf(scroll!));
    // jsdom has no layout, so nothing overflows and the cue must be off.
    expect(cue).toHaveAttribute('data-more', 'false');
    expect(cue).toHaveAttribute('aria-hidden');
  });

  it('leaves the Activity tab without one (it is the plain full-panel scroll)', () => {
    renderHome('activity');
    expect(screen.queryByTestId('live-home-scroll-cue')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The COMPACT home (owner, live testing 2026-08-25: "you can see only one token
// and have to scroll it, it looks very bad when someone has a lot of tokens").
//
// Same division of labour as the centring above: the pixels are asserted with
// real boxes in scripts/evm-extension-smoke.mjs (measured there at 400x600:
// the asset list went from 64px with ONE visible row, to 209px with FOUR, to
// 231px with SIX once the density pass shrank the row pitch and the type scale
// under `home-tight`). What jsdom can honestly pin is WHEN the marker is
// applied, which is the whole decision.

describe('LiveHome compact layout (home-tight)', () => {
  /** Pretend the viewport is / is not short. The default test stub answers
   *  `matches: false` for every query, which is why every other test in this
   *  file sees the roomy layout unchanged. */
  const setShortViewport = (short: boolean) => {
    window.matchMedia = ((query: string) =>
      ({
        matches: short && query.includes('max-height'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  };

  /** `n` rows that all carry a balance, with "hide zero balances" on, so the
   *  list the screen shows is exactly `n` and no default pin can pad it. */
  const showRows = async (n: number) => {
    await act(async () => {
      storeMod.useLiveStore.setState({
        hideZeroBalances: true,
        assets: Array.from({ length: n }, (_, i) => ({
          name: i === 0 ? 'EVR' : `TOKEN${i}`,
          amountBase: BigInt(i + 1) * 100_000_000n,
          scale: 8,
          decimals: 8,
          isNative: i === 0,
        })),
      });
    });
    expect(screen.getAllByTestId(/^live-asset-row-/)).toHaveLength(n);
  };

  afterEach(() => setShortViewport(false));

  it('compacts the hero in a SHORT viewport once the list is long enough', async () => {
    setShortViewport(true);
    renderHome();
    await showRows(TIGHT_LIST_ROWS);

    const panel = screen.getByTestId('live-tab-panel-assets');
    expect(panel.classList.contains('home-tight')).toBe(true);
    // The centring is NOT replaced: the compact rules ride on top of it, and
    // the block still hangs off the same two elements.
    expect(panel.classList.contains('home-centered')).toBe(true);
    expect(panel.querySelector(':scope > .home-hero-wrap')).not.toBeNull();
    expect(panel.querySelector(':scope > .home-scroll')).not.toBeNull();
  });

  // The chrome around the panel (owner, 2026-08-25: with no notice the whole
  // block should move up and give the list the room). The header and the bottom
  // nav are SIBLINGS of .app-content, so no selector rooted at `home-tight` can
  // reach them; `frame-tight` on .app-frame is the second half of the same one
  // decision, and these two tests are what stop the halves drifting apart.
  it('stamps frame-tight on the frame with it, so the header and the tab bar compact too', async () => {
    setShortViewport(true);
    renderHome();
    await showRows(TIGHT_LIST_ROWS);

    const frame = screen.getByTestId('live-home');
    expect(frame.classList.contains('app-frame')).toBe(true);
    expect(frame.classList.contains('frame-tight')).toBe(true);
    // Compacted, never removed: the header and the tab bar are both still on
    // screen. What they LOOK like is asserted with real boxes in the EVM smoke.
    expect(frame.querySelector('.app-header')).not.toBeNull();
    expect(frame.querySelector('.bottom-nav')).not.toBeNull();
  });

  it('leaves the chrome roomy wherever the list is not compacted', async () => {
    setShortViewport(false);
    renderHome();
    await showRows(TIGHT_LIST_ROWS + 6);

    expect(screen.getByTestId('live-home').classList.contains('frame-tight')).toBe(false);
  });

  it('keeps the roomy hero for a SHORT list, which is the look the owner asked for', async () => {
    setShortViewport(true);
    renderHome();
    await showRows(TIGHT_LIST_ROWS - 1);

    expect(screen.getByTestId('live-tab-panel-assets').classList.contains('home-tight')).toBe(false);
  });

  it('never compacts a TALL viewport, however long the list is: the side panel has room for both', async () => {
    setShortViewport(false);
    renderHome();
    await showRows(TIGHT_LIST_ROWS + 6);

    expect(screen.getByTestId('live-tab-panel-assets').classList.contains('home-tight')).toBe(false);
  });

  it('Send, Receive and Add token stay pinned, never inside the scroll region', async () => {
    setShortViewport(true);
    renderHome();
    await showRows(TIGHT_LIST_ROWS + 5);

    const panel = screen.getByTestId('live-tab-panel-assets');
    const scroll = panel.querySelector(':scope > .home-scroll')!;
    for (const id of ['live-send', 'live-receive', 'live-add-asset']) {
      expect(scroll.contains(screen.getByTestId(id))).toBe(false);
    }
  });
});

describe('isShortViewport', () => {
  it('answers from matchMedia when it exists, and falls back to innerHeight when it does not', async () => {
    const { isShortViewport, SHORT_VIEWPORT_MAX_HEIGHT } = await import('./shortViewport');
    const saved = window.matchMedia;
    try {
      window.matchMedia = ((q: string) => ({ matches: true, media: q }) as MediaQueryList) as typeof window.matchMedia;
      expect(isShortViewport()).toBe(true);
      // No matchMedia at all (a non-DOM context): the height decides.
      (window as { matchMedia?: unknown }).matchMedia = undefined;
      window.innerHeight = SHORT_VIEWPORT_MAX_HEIGHT - 100;
      expect(isShortViewport()).toBe(true);
      window.innerHeight = SHORT_VIEWPORT_MAX_HEIGHT + 100;
      expect(isShortViewport()).toBe(false);
    } finally {
      window.matchMedia = saved;
      window.innerHeight = 768;
    }
  });
});

describe('LiveHome vertical centring on a chain with NO token list', () => {
  it('keeps the existing .home-roomy layout and never adds .home-centered', async () => {
    // Bitcoin: supportsAssets() is false, so Home renders the compact centred
    // layout it always did (big coin mark, no Assets section). Importing is the
    // honest way to get there: it is what actually moves the service's active
    // chain, which is where assetsSupported() reads from.
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My Bitcoin', 'bitcoin-mainnet');
    await state().loadWallets();

    renderHome();

    const panel = screen.getByTestId('live-tab-panel-assets');
    expect(panel.classList.contains('home-roomy')).toBe(true);
    expect(panel.classList.contains('home-centered')).toBe(false);
    // No asset list on this chain, so the scroll region holds only the footer
    // and keeps its `no-assets` marker (which pins that footer to the bottom).
    expect(panel.querySelector(':scope > .home-scroll.no-assets')).not.toBeNull();
  }, 30_000);
});
