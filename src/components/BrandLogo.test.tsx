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

  it('still falls back to a generic badge for an unrelated asset', () => {
    const { container } = render(<TokenIcon assetId="FOO" />);
    expect(container.querySelector('[data-token-badge="FOO"]')).not.toBeNull();
  });
});
