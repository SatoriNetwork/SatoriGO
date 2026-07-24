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
    const header = officialLogoUrl('header');

    expect(rvn).not.toBe(evr);
    expect(rvn).not.toBe(satori);
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

  it('still falls back to a generic badge for an unrelated asset', () => {
    const { container } = render(<TokenIcon assetId="FOO" />);
    expect(container.querySelector('[data-token-badge="FOO"]')).not.toBeNull();
  });
});
