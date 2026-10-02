// The wallet-kind chip (Home switcher, lock screen, Settings > Wallets). The
// 1.4.3 audit found a Monero wallet imported from its 25 words tagged "Seed"
// (L08, N-diag-vector-xmr-imported): it is stored as kind:'seed' but has no
// phrase, so it gets its own tag, both forms.

import { describe, expect, it } from 'vitest';
import { walletKindTag } from './walletKindTag';

describe('walletKindTag', () => {
  it('a recovery-phrase wallet is Seed, on every chain', () => {
    expect(walletKindTag({ kind: 'seed' })).toBe('Seed');
    expect(walletKindTag({ kind: 'seed' }, 'long')).toBe('Seed');
    // A Monero sibling derived from the phrase is still the phrase.
    expect(walletKindTag({ kind: 'seed', moneroKeySource: 'phrase' })).toBe('Seed');
  });

  it('an imported private key is Satori, with (key) in the long form', () => {
    expect(walletKindTag({ kind: 'pk' })).toBe('Satori');
    expect(walletKindTag({ kind: 'pk' }, 'long')).toBe('Satori (key)');
  });

  it('a Monero wallet imported from 25 words is tagged as such, never Seed', () => {
    expect(walletKindTag({ kind: 'seed', moneroKeySource: 'words' })).toBe('25 words');
    expect(walletKindTag({ kind: 'seed', moneroKeySource: 'words' }, 'long')).toBe('Monero (25 words)');
  });

  it('never uses an em-dash (house style)', () => {
    for (const w of [{ kind: 'seed' as const }, { kind: 'pk' as const }, { kind: 'seed' as const, moneroKeySource: 'words' as const }]) {
      expect(walletKindTag(w)).not.toContain('—');
      expect(walletKindTag(w, 'long')).not.toContain('—');
    }
  });
});
