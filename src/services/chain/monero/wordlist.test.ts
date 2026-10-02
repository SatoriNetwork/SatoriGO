// wordlist.test.ts: the word list is data whose ORDER is the encoding, so it
// is pinned as a whole, not just sampled.

import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { MONERO_ENGLISH_PREFIX_LENGTH, MONERO_ENGLISH_WORDLIST } from './wordlist';

describe('MONERO_ENGLISH_WORDLIST', () => {
  it('has 1626 words, abbey first and zoom last', () => {
    expect(MONERO_ENGLISH_WORDLIST).toHaveLength(1626);
    expect(MONERO_ENGLISH_WORDLIST[0]).toBe('abbey');
    expect(MONERO_ENGLISH_WORDLIST[1625]).toBe('zoom');
  });

  it('matches english.h exactly (SHA-256 of the newline-joined list)', () => {
    // Computed 2026-09-28 from the list extracted from monero-project
    // src/mnemonics/english.h, which was compared word for word with the
    // research copy xmr_english_wordlist.json.
    expect(bytesToHex(sha256(utf8ToBytes(MONERO_ENGLISH_WORDLIST.join('\n'))))).toBe(
      '998df55cb16d2318130c5cf7e9d4408247c8c4674935ee6e07d53f2f00ccf19b',
    );
  });

  it('spot-checks positions the published vectors depend on', () => {
    expect(MONERO_ENGLISH_WORDLIST.indexOf('adjust')).toBe(22);
    expect(MONERO_ENGLISH_WORDLIST.indexOf('zones')).toBe(1624);
  });

  it('every word is lowercase ASCII, at least 3 letters, and no two share a 3-letter prefix', () => {
    expect(MONERO_ENGLISH_PREFIX_LENGTH).toBe(3);
    for (const w of MONERO_ENGLISH_WORDLIST) expect(w).toMatch(/^[a-z]{3,}$/);
    const prefixes = new Set(MONERO_ENGLISH_WORDLIST.map((w) => w.slice(0, MONERO_ENGLISH_PREFIX_LENGTH)));
    expect(prefixes.size).toBe(1626);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MONERO_ENGLISH_WORDLIST)).toBe(true);
  });
});
