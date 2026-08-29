// @vitest-environment jsdom
// Needs `document` for React Testing Library render, so this file opts into
// jsdom on its own (the project's default vitest environment is 'node').
//
// Every query below is scoped to its own render's `container`: this project
// does not enable vitest globals, so RTL registers no auto-cleanup and the
// renders of one file share a document.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AccountAvatar, avatarCells, avatarColors } from './AccountAvatar';

const EVR = 'EMc6Y9DkH5T4rG1qUqTz2xJ8oPqW3vNfBd';
const EVR_2 = 'EMc6Y9DkH5T4rG1qUqTz2xJ8oPqW3vNfBe';
const EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

function markup(props: Parameters<typeof AccountAvatar>[0]): string {
  const { container } = render(<AccountAvatar {...props} />);
  return container.innerHTML;
}

function svgOf(props: Parameters<typeof AccountAvatar>[0]): SVGSVGElement {
  const { container } = render(<AccountAvatar {...props} />);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('no svg rendered');
  return svg;
}

describe('avatarColors', () => {
  it('is deterministic and keeps every colour in the readable band', () => {
    expect(avatarColors(EVR)).toEqual(avatarColors(EVR));
    for (const c of avatarColors(EVR)) {
      const m = /^hsl\((\d+) 65% (\d+)%\)$/.exec(c);
      expect(m).not.toBeNull();
      const lightness = Number(m![2]);
      // The 45-60% band is what has contrast on BOTH themes.
      expect(lightness).toBeGreaterThanOrEqual(45);
      expect(lightness).toBeLessThanOrEqual(60);
    }
  });

  it('pushes the three hues apart so a mark is never three shades of one colour', () => {
    const hueOf = (c: string) => Number(/^hsl\((\d+)/.exec(c)![1]);
    for (const key of [EVR, EVR_2, EVM, 'wallet-id-1', '']) {
      const [a, b, c] = avatarColors(key).map(hueOf);
      const gap = (x: number, y: number) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));
      expect(gap(a, b)).toBeGreaterThanOrEqual(40);
      expect(gap(a, c)).toBeGreaterThanOrEqual(40);
      expect(gap(b, c)).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('avatarCells', () => {
  it('returns a 5x5 grid mirrored horizontally', () => {
    const cells = avatarCells(EVM);
    expect(cells).toHaveLength(25);
    for (let y = 0; y < 5; y++) {
      expect(cells[y * 5 + 0]).toBe(cells[y * 5 + 4]);
      expect(cells[y * 5 + 1]).toBe(cells[y * 5 + 3]);
    }
    for (const v of cells) expect([0, 1, 2]).toContain(v);
  });

  it('is not a single flat colour (the mark actually distinguishes accounts)', () => {
    expect(new Set(avatarCells(EVM)).size).toBeGreaterThan(1);
  });
});

describe('AccountAvatar', () => {
  it('renders the same SVG for the same address', () => {
    expect(markup({ address: EVR })).toBe(markup({ address: EVR }));
  });

  it('renders a different SVG for a different address', () => {
    expect(markup({ address: EVR })).not.toBe(markup({ address: EVR_2 }));
    expect(markup({ address: EVR })).not.toBe(markup({ address: EVM }));
  });

  it('ignores address case, so one account never gets two marks', () => {
    // The testid keeps the address as given; the drawing must not change.
    const upper = svgOf({ address: EVM });
    const lower = svgOf({ address: EVM.toLowerCase() });
    expect(lower.innerHTML).toBe(upper.innerHTML);
  });

  it('falls back to the seed when there is no address', () => {
    expect(markup({ seed: 'wallet-1' })).toBe(markup({ seed: 'wallet-1' }));
    expect(markup({ seed: 'wallet-1' })).not.toBe(markup({ seed: 'wallet-2' }));
  });

  it('renders at the requested size, round, with the address-derived testid', () => {
    const svg = svgOf({ address: EVR, size: 28 });
    expect(svg.getAttribute('data-testid')).toBe(`account-avatar-${EVR.slice(0, 6)}`);
    expect(svg.getAttribute('width')).toBe('28');
    expect(svg.getAttribute('height')).toBe('28');
    expect(svg.getAttribute('viewBox')).toBe('0 0 5 5');
    expect(svg.style.borderRadius).toBe('50%');
  });

  it('is decorative by default and named when a label is given', () => {
    const bare = svgOf({ address: EVR });
    expect(bare.getAttribute('role')).toBe('img');
    expect(bare.getAttribute('aria-hidden')).toBe('true');
    expect(bare.getAttribute('aria-label')).toBeNull();

    const named = svgOf({ address: EVM, label: 'Account 1' });
    expect(named.getAttribute('aria-label')).toBe('Account 1');
    expect(named.getAttribute('aria-hidden')).toBeNull();
  });

  it('does not throw with no address and no seed', () => {
    expect(svgOf({}).getAttribute('data-testid')).toBe('account-avatar-');
  });
});
