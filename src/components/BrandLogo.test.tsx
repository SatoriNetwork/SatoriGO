// @vitest-environment jsdom
// Needs `document` for React Testing Library render, so this file opts into
// jsdom on its own (the project's default vitest environment is 'node').
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { officialLogoUrl, TokenIcon } from './BrandLogo';

describe('officialLogoUrl', () => {
  it('maps each slot to a distinct bundled logo', () => {
    const evr = officialLogoUrl('evr');
    const satori = officialLogoUrl('satori');
    const rvn = officialLogoUrl('rvn');
    const wjk = officialLogoUrl('wjk');
    const btc = officialLogoUrl('btc');
    const doge = officialLogoUrl('doge');
    const neox = officialLogoUrl('neox');
    const header = officialLogoUrl('header');

    expect(rvn).not.toBe(evr);
    expect(rvn).not.toBe(satori);
    expect(wjk).not.toBe(evr);
    expect(wjk).not.toBe(rvn);
    expect(btc).not.toBe(evr);
    expect(btc).not.toBe(rvn);
    expect(btc).not.toBe(wjk);
    expect(doge).not.toBe(evr);
    expect(doge).not.toBe(btc);
    expect(doge).not.toBe(wjk);
    // Neoxa's mark must not collide with anyone else's, least of all with a
    // chain it could be confused for.
    expect(neox).not.toBe(evr);
    expect(neox).not.toBe(rvn);
    expect(neox).not.toBe(doge);
    expect(neox).not.toBe(officialLogoUrl('btgs'));
    // 'header' has no dedicated asset yet; falls back to the EVR logo.
    expect(header).toBe(evr);
  });
});

describe('TokenIcon', () => {
  it('renders the RVN slot for an RVN asset id', () => {
    const { container } = render(<TokenIcon assetId="RVN" />);
    const frame = container.querySelector('[data-logo-slot="rvn"]');
    expect(frame).not.toBeNull();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('RVN');
  });

  it('is case-insensitive for the RVN asset id', () => {
    const { container } = render(<TokenIcon assetId="rvn" />);
    expect(container.querySelector('[data-logo-slot="rvn"]')).not.toBeNull();
  });

  it('renders the WJK slot for a WJK asset id', () => {
    const { container } = render(<TokenIcon assetId="WJK" />);
    const frame = container.querySelector('[data-logo-slot="wjk"]');
    expect(frame).not.toBeNull();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('WJK');
  });

  it('is case-insensitive for the WJK asset id', () => {
    const { container } = render(<TokenIcon assetId="wjk" />);
    expect(container.querySelector('[data-logo-slot="wjk"]')).not.toBeNull();
  });

  it('renders the BTC slot for a BTC asset id', () => {
    const { container } = render(<TokenIcon assetId="BTC" />);
    const frame = container.querySelector('[data-logo-slot="btc"]');
    expect(frame).not.toBeNull();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('BTC');
  });

  it('is case-insensitive for the BTC asset id', () => {
    const { container } = render(<TokenIcon assetId="btc" />);
    expect(container.querySelector('[data-logo-slot="btc"]')).not.toBeNull();
  });

  it('renders the DOGE slot for a DOGE asset id', () => {
    const { container } = render(<TokenIcon assetId="DOGE" />);
    const frame = container.querySelector('[data-logo-slot="doge"]');
    expect(frame).not.toBeNull();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('DOGE');
  });

  it('is case-insensitive for the DOGE asset id', () => {
    const { container } = render(<TokenIcon assetId="doge" />);
    expect(container.querySelector('[data-logo-slot="doge"]')).not.toBeNull();
  });

  it('renders the NEOX slot for a NEOX asset id', () => {
    const { container } = render(<TokenIcon assetId="NEOX" />);
    const frame = container.querySelector('[data-logo-slot="neox"]');
    expect(frame).not.toBeNull();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('NEOX');
  });

  it('is case-insensitive for the NEOX asset id', () => {
    const { container } = render(<TokenIcon assetId="neox" />);
    expect(container.querySelector('[data-logo-slot="neox"]')).not.toBeNull();
  });

  it('still falls back to a generic badge for an unrelated asset', () => {
    const { container } = render(<TokenIcon assetId="FOO" />);
    expect(container.querySelector('[data-token-badge="FOO"]')).not.toBeNull();
  });
});

describe('TokenIcon: runtime token marks (EVM tokens added or imported)', () => {
  it('renders the registered PNG data URL for a symbol, the badge otherwise, and never lets it override a built-in mark', async () => {
    const { setTokenLogos } = await import('../store/tokenLogoRegistry');
    setTokenLogos([{ symbol: 'ZZZ', logo: 'data:image/png;base64,AAAA' }, { symbol: 'ETH', logo: 'data:image/png;base64,BBBB' }]);
    const { container } = render(<TokenIcon assetId="zzz" size={20} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    const badge = render(<TokenIcon assetId="NOPE" size={20} />);
    expect(badge.container.querySelector('img')).toBeNull();
    expect(badge.container.textContent).toBe('NO');
    // A built-in mark (ETH) wins over a runtime one under the same symbol.
    const eth = render(<TokenIcon assetId="ETH" size={20} />);
    expect(eth.container.querySelector('img')?.getAttribute('src')).not.toBe('data:image/png;base64,BBBB');
    setTokenLogos([]);
  });
});
