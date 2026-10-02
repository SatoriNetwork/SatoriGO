import { describe, expect, it } from 'vitest';
import { moneroUnlockHint } from './moneroUnlock';

describe('moneroUnlockHint', () => {
  it('counts down from the newest confirmed row', () => {
    expect(moneroUnlockHint([100, 105], 107)).toBe('spendable in about 16 min');
  });
  it('says "a few minutes" at the last block and past it', () => {
    expect(moneroUnlockHint([100], 109)).toBe('spendable within a few minutes');
    expect(moneroUnlockHint([100], 130)).toBe('spendable within a few minutes');
  });
  it('falls back to the rule when nothing has a height yet', () => {
    expect(moneroUnlockHint([], 107)).toBe('spendable after 10 confirmations, about 20 min');
    expect(moneroUnlockHint([0], 0)).toBe('spendable after 10 confirmations, about 20 min');
  });
  it('never uses an em-dash', () => {
    expect(moneroUnlockHint([100], 101)).not.toMatch(/—/);
  });
});
