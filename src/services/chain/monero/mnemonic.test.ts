// mnemonic.test.ts: the 25-word encoding against every published seed the
// design cites (monero-engine.md §3), plus round trips and every refusal.

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  MONERO_ENGLISH_WORDS,
  MoneroMnemonicError,
  isValidLegacyMnemonic,
  legacyWordsToSpendKey,
  normalizeLegacyWords,
  spendKeyToLegacyWords,
  type MoneroMnemonicErrorCode,
} from './mnemonic';
import { MONERO_ENGLISH_WORDLIST } from './wordlist';
import { ED25519_L, scReduce32 } from './keys';

// PUBLISHED seeds (source in each row). hex = the spend key the words spell.
const PUBLISHED: Array<{ source: string; words: string; hex: string }> = [
  {
    source: 'monero-python tests/test_seed.py',
    words:
      'wedge going quick racetrack auburn physics lectures light waist axes whipped habitat square awkward together injury niece nugget guarded hive obnoxious waxing faked folding square',
    hex: '8ffa9f586b86d294d93731765d192765311bddc76a4fa60311f8af36bbf6fb06',
  },
  {
    source: 'monero-python tests/test_seed.py',
    words:
      'adjust mugged vaults atlas nasty mews damp toenail suddenly toxic possible framed succeed fuzzy return demonstrate nucleus album noises peculiar virtual rowboat inorganic jester fuzzy',
    hex: '482700617ba810f94035d7f4d7ccc1a29878e165b4867872b705204c85406906',
  },
  {
    source: 'monero-project tests/functional_tests/wallet.py',
    words:
      'velvet lymph giddy number token physics poetry unquoted nibs useful sabotage limits benches lifestyle eden nitrogen anvil fewest avoid batch vials washing fences goat unquoted',
    hex: '148d78d2aba7dbca5cd8f6abcfb0b3c009ffbdbea1ff373d50ed94d78286640e',
  },
];

// PUBLISHED: cake_wallet cw_monero/test/bip39_seed_test.dart, the four
// 25-word outputs (keys.test.ts derives them from the BIP39 phrases; here
// they pin the checksum and the round trip on their own).
const CAKE_WORDS = [
  'tasked eight afraid laboratory tail feline rift reinvest vane cafe bailed foggy dormant paper jigsaw king hazard suture king dapper dummy jolted dating dwindling king',
  'palace pairing axes mohawk rekindle excess awful juvenile shipped talent nibs efficient dapper biggest swung fight pact innocent emerge issued titans affair nearby noises emerge',
  'somewhere problems gauze gigantic intended foxes upcoming saved waffle pipeline lurk bogeys empty wipeout abbey italics novelty tucks rafts elite lunar obnoxious awful bugs elite',
  'playful toxic wildly eluded mesh fainted february mugged maps repent vigilant hitched seventh threaten clue fetches sample diet number alkaline future cottage tuition vegan alkaline',
];

const SUBTLY =
  'subtly emerge cucumber wield jester neutral echo guide problems hiding necklace tapestry offend tell erase ugly envy turnip click iguana pebbles idols listen nail cucumber';
const SUBTLY_HEX = 'bfafd1eb0e43da200c5c11537d355e458e7c326b3bc1b19f4546573d6bac9d0f';

function codeOf(fn: () => unknown): MoneroMnemonicErrorCode | 'no-throw' | 'other' {
  try {
    fn();
    return 'no-throw';
  } catch (e) {
    return e instanceof MoneroMnemonicError ? e.code : 'other';
  }
}

describe('word list', () => {
  it('is the wordlist.ts list, 1626 words', () => {
    expect(MONERO_ENGLISH_WORDS).toBe(MONERO_ENGLISH_WORDLIST);
    expect(MONERO_ENGLISH_WORDS).toHaveLength(1626);
  });
});

describe('published seeds', () => {
  for (const p of PUBLISHED) {
    it(`${p.source}: ${p.words.split(' ')[0]} ... decodes to the published key and re-encodes to the same words`, () => {
      const key = legacyWordsToSpendKey(p.words);
      expect(bytesToHex(key)).toBe(p.hex);
      expect(spendKeyToLegacyWords(key).join(' ')).toBe(p.words);
    });
  }

  for (const [i, words] of CAKE_WORDS.entries()) {
    it(`Cake published output ${i + 1} round-trips, checksum included`, () => {
      const key = legacyWordsToSpendKey(words);
      expect(spendKeyToLegacyWords(key).join(' ')).toBe(words);
      expect(isValidLegacyMnemonic(words)).toBe(true);
    });
  }

  it('the abandon x11 about Cake-scheme key spells the vectors_final.json words', () => {
    expect(spendKeyToLegacyWords(hexToBytes(SUBTLY_HEX)).join(' ')).toBe(SUBTLY);
    expect(bytesToHex(legacyWordsToSpendKey(SUBTLY))).toBe(SUBTLY_HEX);
  });

  it('accepts an array as well as a string', () => {
    expect(bytesToHex(legacyWordsToSpendKey(SUBTLY.split(' ')))).toBe(SUBTLY_HEX);
  });
});

describe('round trip', () => {
  it('1,000 reduced keys (deterministic keccak chain) survive words and back', () => {
    let state: Uint8Array = keccak_256(new TextEncoder().encode('satori-go monero mnemonic round trip'));
    for (let i = 0; i < 1000; i++) {
      state = keccak_256(state);
      const key = scReduce32(state);
      const words = spendKeyToLegacyWords(key);
      expect(words).toHaveLength(25);
      // The 25th word repeats one of the first 24.
      expect(words.slice(0, 24)).toContain(words[24]);
      expect(bytesToHex(legacyWordsToSpendKey(words))).toBe(bytesToHex(key));
    }
  });

  it('the largest canonical key (l - 1) and a key of 1 round-trip', () => {
    const lMinus1 = new Uint8Array(32);
    let x = ED25519_L - 1n;
    for (let i = 0; i < 32; i++) {
      lMinus1[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    expect(bytesToHex(legacyWordsToSpendKey(spendKeyToLegacyWords(lMinus1)))).toBe(bytesToHex(lMinus1));
    const one = new Uint8Array(32);
    one[0] = 1;
    expect(bytesToHex(legacyWordsToSpendKey(spendKeyToLegacyWords(one)))).toBe(bytesToHex(one));
  });
});

describe('prefix matching and normalisation (as monero-wallet-cli reads words)', () => {
  it('a 3 or 4 character prefix of each word is enough ("subt" for "subtly")', () => {
    const four = SUBTLY.split(' ').map((w) => w.slice(0, 4)).join(' ');
    const three = SUBTLY.split(' ').map((w) => w.slice(0, 3)).join(' ');
    expect(four.startsWith('subt ')).toBe(true);
    expect(bytesToHex(legacyWordsToSpendKey(four))).toBe(SUBTLY_HEX);
    expect(bytesToHex(legacyWordsToSpendKey(three))).toBe(SUBTLY_HEX);
  });

  it('case, surrounding and repeated whitespace, and newlines do not matter', () => {
    const messy = `  ${SUBTLY.toUpperCase().split(' ').join('  \n\t')}  `;
    expect(bytesToHex(legacyWordsToSpendKey(messy))).toBe(SUBTLY_HEX);
  });

  it('normalizeLegacyWords returns the full list words', () => {
    expect(normalizeLegacyWords(' SUBT emer\ncucu ')).toEqual(['subtly', 'emerge', 'cucumber']);
    expect(normalizeLegacyWords('')).toEqual([]);
  });

  it('normalizeLegacyWords refuses an unknown word or a fragment shorter than 3 characters', () => {
    expect(codeOf(() => normalizeLegacyWords('subtly qqqq'))).toBe('word');
    expect(codeOf(() => normalizeLegacyWords('su'))).toBe('word');
  });

  it('only the first 3 characters count, exactly as in electrum-words.cpp', () => {
    // "bitcoin" reads as "bite": Monero matches on the prefix alone, so only
    // the prefix is data. A typo past the third letter spells the same key,
    // and one inside the prefix changes the word, which the checksum word catches about 23 times in 24.
    expect(normalizeLegacyWords('bitcoin')).toEqual(['bite']);
  });
});

describe('refusals', () => {
  const words = SUBTLY.split(' ');

  it('a wrong checksum word', () => {
    const bad = [...words.slice(0, 24), words[0] === 'abbey' ? 'zoom' : 'abbey'];
    expect(codeOf(() => legacyWordsToSpendKey(bad))).toBe('checksum');
    expect(isValidLegacyMnemonic(bad.join(' '))).toBe(false);
  });

  it('a swapped pair of words (the checksum catches the reorder)', () => {
    const swapped = [...words];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(codeOf(() => legacyWordsToSpendKey(swapped))).toBe('checksum');
  });

  it('a word not in the list', () => {
    const bad = [...words];
    bad[6] = 'xylophone';
    let err: unknown;
    try {
      legacyWordsToSpendKey(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MoneroMnemonicError);
    expect((err as MoneroMnemonicError).code).toBe('word');
    // The message names the position, never the word (words are the key).
    expect((err as Error).message).toContain('Word 7');
    expect((err as Error).message).not.toContain('xylophone');
  });

  it('wrong lengths: 24 (no checksum word), 26, 13 (half seed), 12 (a BIP39 phrase), 0', () => {
    expect(codeOf(() => legacyWordsToSpendKey(words.slice(0, 24)))).toBe('length');
    expect(codeOf(() => legacyWordsToSpendKey([...words, words[0]]))).toBe('length');
    expect(codeOf(() => legacyWordsToSpendKey(words.slice(0, 13)))).toBe('length');
    expect(codeOf(() => legacyWordsToSpendKey(''))).toBe('length');
    // A BIP39 phrase fails on its words or its length, never decodes.
    expect(
      codeOf(() =>
        legacyWordsToSpendKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
      ),
    ).not.toBe('no-throw');
  });

  it('a word triple that no 32-bit value encodes (words_to_bytes range check)', () => {
    // abbey(0) zoom(1625) zones(1624) spells 1626*1625 + 1626^2*1625 > 2^32 - 1.
    expect(MONERO_ENGLISH_WORDS[1624]).toBe('zones');
    expect(MONERO_ENGLISH_WORDS[1625]).toBe('zoom');
    const body = ['abbey', 'zoom', 'zones', ...words.slice(3, 24)];
    // Exactly one of the 24 is the right checksum word; with it the checksum
    // passes and the group check must be what refuses.
    const codes = body.map((w) => codeOf(() => legacyWordsToSpendKey([...body, w])));
    expect(codes.filter((c) => c === 'range').length).toBeGreaterThan(0);
    expect(codes.every((c) => c === 'range' || c === 'checksum')).toBe(true);
  });

  it('spendKeyToLegacyWords refuses a non-canonical key (>= l) or a wrong length', () => {
    const l = new Uint8Array(32);
    let x = ED25519_L;
    for (let i = 0; i < 32; i++) {
      l[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    expect(codeOf(() => spendKeyToLegacyWords(l))).toBe('range');
    expect(codeOf(() => spendKeyToLegacyWords(new Uint8Array(31)))).toBe('range');
  });

  it('isValidLegacyMnemonic', () => {
    expect(isValidLegacyMnemonic(SUBTLY)).toBe(true);
    expect(isValidLegacyMnemonic(words.slice(0, 24).join(' '))).toBe(false);
    expect(isValidLegacyMnemonic('not a seed')).toBe(false);
  });
});
