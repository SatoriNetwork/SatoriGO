// The multi-select model behind the asset list's edit mode. Pure, so the rules
// (protected assets can never be ticked; a selection never outlives its rows;
// leaving the mode clears it) are proven without rendering a screen.

import { describe, expect, it } from 'vitest';
import {
  toggleAssetSelection,
  pruneSelection,
  clearSelection,
  selectionLabel,
  removalDescription,
} from './assetSelection';

const set = (...names: string[]) => new Set(names);
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('toggleAssetSelection', () => {
  it('ticks and unticks a removable row', () => {
    const a = toggleAssetSelection(set(), 'WETH', true);
    expect(sorted(a)).toEqual(['WETH']);
    expect(sorted(toggleAssetSelection(a, 'WETH', true))).toEqual([]);
  });

  it('REFUSES a protected asset: the native coin can never be selected', () => {
    expect(sorted(toggleAssetSelection(set(), 'ETH', false))).toEqual([]);
    // ...and cannot be smuggled in on top of an existing selection either.
    expect(sorted(toggleAssetSelection(set('WETH'), 'ETH', false))).toEqual(['WETH']);
  });

  it('never mutates the set it was given', () => {
    const before = set('AAA');
    const after = toggleAssetSelection(before, 'BBB', true);
    expect(sorted(before)).toEqual(['AAA']);
    expect(sorted(after)).toEqual(['AAA', 'BBB']);
  });

  it('counts what is ticked', () => {
    let s: ReadonlySet<string> = set();
    for (const name of ['AAA', 'BBB', 'CCC']) s = toggleAssetSelection(s, name, true);
    expect(s.size).toBe(3);
    s = toggleAssetSelection(s, 'BBB', true);
    expect(s.size).toBe(2);
  });
});

describe('pruneSelection', () => {
  it('drops a tick whose row is gone', () => {
    expect(sorted(pruneSelection(set('AAA', 'GONE'), ['AAA', 'BBB']))).toEqual(['AAA']);
  });

  it('returns the SAME set when every tick still has a row', () => {
    const s = set('AAA');
    expect(pruneSelection(s, ['AAA', 'BBB'])).toBe(s);
  });

  it('returns the same empty set untouched', () => {
    const s = set();
    expect(pruneSelection(s, [])).toBe(s);
  });
});

describe('clearSelection', () => {
  it('is empty, and a fresh set each time (leaving edit mode clears the ticks)', () => {
    const a = clearSelection();
    expect(a.size).toBe(0);
    expect(clearSelection()).not.toBe(a);
  });
});

describe('selectionLabel', () => {
  it('agrees with itself about singular and plural', () => {
    expect(selectionLabel(1)).toBe('1 token selected');
    expect(selectionLabel(2)).toBe('2 tokens selected');
  });
});

describe('removalDescription', () => {
  it('says plainly that removal is a HIDE, not a loss', () => {
    const text = removalDescription(['WETH']);
    expect(text).toContain('WETH is');
    expect(text).toContain('hidden from this list');
    expect(text).toContain('stays on the blockchain');
    expect(text).toContain('Add token');
  });

  it('names up to three tokens, then counts the rest', () => {
    expect(removalDescription(['A', 'B'])).toContain('A, B are');
    expect(removalDescription(['A', 'B', 'C', 'D', 'E'])).toContain('A, B, C and 2 more are');
  });

  it('carries no em-dash (owner copy rule)', () => {
    expect(removalDescription(['A', 'B', 'C', 'D'])).not.toContain('—');
  });
});
