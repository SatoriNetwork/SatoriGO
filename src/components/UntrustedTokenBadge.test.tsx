// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  UntrustedTokenBadge,
  UntrustedTokenBanner,
  UNTRUSTED_TOKEN_NOTE,
  UNTRUSTED_TOKEN_LABEL,
  SANITISED_SYMBOL_NOTE,
  notePositionFor,
} from './UntrustedTokenBadge';
import { setTokenLogos } from '../store/tokenLogoRegistry';

afterEach(() => {
  cleanup();
  setTokenLogos([]);
});

describe('UntrustedTokenBadge / Banner', () => {
  it('shows the unlisted pill only for a token checked and NOT vouched for; clicking explains; vouched or unknown tokens get nothing', () => {
    setTokenLogos([
      { symbol: 'JUNK', trusted: false },
      { symbol: 'WETH', trusted: true, logo: 'data:image/png;base64,AAAA' },
    ]);
    render(
      <div>
        <UntrustedTokenBadge symbol="JUNK" />
        <UntrustedTokenBadge symbol="WETH" />
        <UntrustedTokenBadge symbol="USDC" />
      </div>,
    );
    expect(screen.getByTestId('live-untrusted-JUNK')).toBeInTheDocument();
    expect(screen.queryByTestId('live-untrusted-WETH')).toBeNull();
    expect(screen.queryByTestId('live-untrusted-USDC')).toBeNull();
    expect(screen.queryByTestId('live-untrusted-note-JUNK')).toBeNull();
    fireEvent.click(screen.getByTestId('live-untrusted-JUNK'));
    expect(screen.getByTestId('live-untrusted-note-JUNK')).toHaveTextContent(UNTRUSTED_TOKEN_NOTE);
    fireEvent.click(screen.getByTestId('live-untrusted-JUNK'));
    expect(screen.queryByTestId('live-untrusted-note-JUNK')).toBeNull();
  });

  it('the banner names the token and carries the same note; nothing for a trusted token', () => {
    setTokenLogos([{ symbol: 'JUNK', trusted: false }, { symbol: 'WETH', trusted: true }]);
    render(
      <div>
        <UntrustedTokenBanner symbol="JUNK" />
        <UntrustedTokenBanner symbol="WETH" />
      </div>,
    );
    expect(screen.getByTestId('live-untrusted-banner-JUNK')).toHaveTextContent('Satori GO cannot vouch for JUNK.');
    expect(screen.getByTestId('live-untrusted-banner-JUNK')).toHaveTextContent(UNTRUSTED_TOKEN_NOTE);
    expect(screen.queryByTestId('live-untrusted-banner-WETH')).toBeNull();
  });

  it('the pill reads as the wallet speaking: it carries the word, not only an icon', () => {
    setTokenLogos([{ symbol: 'JUNK', trusted: false }]);
    render(<UntrustedTokenBadge symbol="JUNK" />);
    expect(screen.getByTestId('live-untrusted-JUNK')).toHaveTextContent(UNTRUSTED_TOKEN_LABEL);
  });

  // The forgery the 2026-08-25 review found on a live Base account: the token
  // put a green check INSIDE its own symbol, and it out-shouted the wallet's
  // warning. The check must not be drawn, the pill must be, and the raw symbol
  // must still be what the registry and the data-testids are keyed on.
  it('a token that badges itself is drawn sanitised, and still gets the pill', () => {
    const RAW = 'www.badrp.co \u{2705}';
    setTokenLogos([{ symbol: RAW, trusted: false }]);
    render(<UntrustedTokenBanner symbol={RAW} />);
    const banner = screen.getByTestId(`live-untrusted-banner-${RAW}`);
    expect(banner).toHaveTextContent('Satori GO cannot vouch for www.badrp.co.');
    expect(banner.textContent).not.toContain('\u{2705}');
    expect(banner).toHaveTextContent(SANITISED_SYMBOL_NOTE);
  });

  it('a plain unlisted symbol gets no sanitising sentence', () => {
    setTokenLogos([{ symbol: 'JUNK', trusted: false }]);
    render(<UntrustedTokenBanner symbol="JUNK" />);
    expect(screen.getByTestId('live-untrusted-banner-JUNK').textContent).not.toContain(SANITISED_SYMBOL_NOTE);
  });

  it('a symbol shared by a listed and an unlisted token reads as listed (never a false alarm on a real token)', () => {
    setTokenLogos([{ symbol: 'USDT', trusted: false }, { symbol: 'USDT', trusted: true }]);
    render(<UntrustedTokenBadge symbol="USDT" />);
    expect(screen.queryByTestId('live-untrusted-USDT')).toBeNull();
  });
});

// The note grew when its copy did, and the popup frame is 400x600: a note
// anchored under a row near the bottom used to run off the screen with no way
// to scroll it, which is how the EVM smoke first caught it.
describe('notePositionFor', () => {
  const VIEWPORT = { width: 400, height: 600 };

  it('sits under the pill when there is room, and is capped to the space below', () => {
    const pos = notePositionFor({ top: 100, bottom: 114, left: 180 }, VIEWPORT);
    expect(pos.top).toBe(120);
    expect(pos.maxHeight).toBe(600 - 114 - 6 - 8);
    expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('flips above the pill for a row near the bottom of the frame', () => {
    const pos = notePositionFor({ top: 540, bottom: 554, left: 180 }, VIEWPORT);
    expect(pos.top).toBeLessThan(540);
    expect(pos.top).toBeGreaterThanOrEqual(8);
    expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(540);
  });

  it('never runs off the right edge', () => {
    const pos = notePositionFor({ top: 100, bottom: 114, left: 390 }, VIEWPORT);
    expect(pos.left).toBe(400 - 300 - 8);
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });

  it('stays on screen in a frame too small for either side', () => {
    const pos = notePositionFor({ top: 40, bottom: 54, left: 10 }, { width: 400, height: 100 });
    expect(pos.top).toBeGreaterThanOrEqual(8);
    expect(pos.maxHeight).toBeGreaterThan(0);
  });
});
