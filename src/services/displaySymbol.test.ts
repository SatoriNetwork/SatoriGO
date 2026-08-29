import { describe, it, expect } from 'vitest';
import {
  displaySymbol,
  displayTokenName,
  isSymbolSanitised,
  MAX_DISPLAY_SYMBOL_LENGTH,
  MAX_DISPLAY_ASSET_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  UNRENDERABLE_SYMBOL,
} from './displaySymbol';

// Invisible characters are written as \u escapes on purpose: a literal bidi
// override or zero-width joiner in a source file is unreadable in review and
// survives a copy/paste unnoticed, which is the whole problem being tested.

/** Symbols read off a real Base account during the 2026-08-25 security review.
 *  Pinned verbatim: these are the strings the sanitiser exists for, and a
 *  regression here is a token drawing its own trust badge again. */
const REAL_SPAM_SYMBOLS = {
  fakeCheck: 'www.badrp.co ✅',
  telegram: '(t.me/s/US_POOL) *claim until 24.02.26',
  trump: '$TRUMP - Claim: t.ly/TRUMP - #45',
  reward: '5ETH Reward at web3eth.vip',
} as const;

describe('displaySymbol: the real spam symbols', () => {
  it('strips the fake green check a token gave itself', () => {
    expect(displaySymbol(REAL_SPAM_SYMBOLS.fakeCheck)).toBe('www.badrp.co');
    expect(displaySymbol(REAL_SPAM_SYMBOLS.fakeCheck)).not.toContain('✅');
  });

  it('caps the Telegram lure at the display length', () => {
    const out = displaySymbol(REAL_SPAM_SYMBOLS.telegram);
    expect(Array.from(out).length).toBe(MAX_DISPLAY_SYMBOL_LENGTH);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe('(t.me/s/US_POOL…');
  });

  it('caps the $TRUMP claim lure and keeps its leading currency sign', () => {
    const out = displaySymbol(REAL_SPAM_SYMBOLS.trump);
    expect(out.startsWith('$TRUMP')).toBe(true);
    expect(Array.from(out).length).toBe(MAX_DISPLAY_SYMBOL_LENGTH);
    expect(out).not.toContain('t.ly');
  });

  it('caps the web3eth.vip reward lure', () => {
    const out = displaySymbol(REAL_SPAM_SYMBOLS.reward);
    expect(Array.from(out).length).toBe(MAX_DISPLAY_SYMBOL_LENGTH);
    expect(out).not.toContain('web3eth.vip');
  });

  it('reports every one of them as sanitised', () => {
    for (const raw of Object.values(REAL_SPAM_SYMBOLS)) {
      expect(isSymbolSanitised(raw)).toBe(true);
    }
  });
});

describe('displaySymbol: real symbols pass through untouched', () => {
  const REAL = ['USDC', 'USDT', 'ETH', 'BNB', 'WETH', 'cbBTC', 'USDbC', 'SATORIEVR', 'stETH', 'Cake-LP', 'USD+', '1INCH', 'AAVE'];
  it.each(REAL)('leaves %s alone', (symbol) => {
    expect(displaySymbol(symbol)).toBe(symbol);
    expect(isSymbolSanitised(symbol)).toBe(false);
  });

  it('leaves a UTXO asset name with its markers alone', () => {
    expect(displaySymbol('SATORI/SUB')).toBe('SATORI/SUB');
    expect(displaySymbol('SATORI#1')).toBe('SATORI#1');
    expect(displaySymbol('SATORI!')).toBe('SATORI!');
  });

  it('does not truncate a full-length Evrmore asset name', () => {
    // assetScript.ts encodeAssetName allows 1..31 characters, so 31 of them is
    // a real asset, not a lure, and must survive whole.
    const longest = 'A'.repeat(31);
    expect(longest.length).toBe(31);
    expect(displaySymbol(longest)).toBe(longest);
    expect(displaySymbol('SATORI/SUBASSET/DEEPER#42')).toBe('SATORI/SUBASSET/DEEPER#42');
  });

  it('still caps a free-text symbol that merely looks long', () => {
    // Lower case takes it out of the chain-enforced alphabet, so the tight cap
    // applies: a token cannot buy 32 characters by padding with capitals.
    expect(Array.from(displaySymbol(`${'A'.repeat(30)}a`)).length).toBe(MAX_DISPLAY_SYMBOL_LENGTH);
  });
});

describe('displaySymbol: badge forgery', () => {
  it('strips the emoji check mark U+2705', () => {
    expect(displaySymbol('USDC✅')).toBe('USDC');
  });

  it('strips the plain check mark U+2713, which is not an emoji', () => {
    expect(displaySymbol('USDC✓')).toBe('USDC');
  });

  it('strips the heavy check mark U+2714 and the ballot box U+2611', () => {
    expect(displaySymbol('USDC✔')).toBe('USDC');
    expect(displaySymbol('USDC☑')).toBe('USDC');
  });

  it('strips a warning sign a token uses to imitate the wallet', () => {
    expect(displaySymbol('USDC⚠\u{fe0f}')).toBe('USDC');
  });

  it('strips a star, a shield and a lock', () => {
    expect(displaySymbol('A⭐B')).toBe('AB');
    expect(displaySymbol('A\u{1f6e1}B')).toBe('AB');
    expect(displaySymbol('A\u{1f512}B')).toBe('AB');
  });

  it('strips flags built from regional indicators', () => {
    expect(displaySymbol('US\u{1f1fa}\u{1f1f8}')).toBe('US');
  });

  it('strips skin-tone modifiers with their base emoji', () => {
    expect(displaySymbol('OK\u{1f44d}\u{1f3fd}')).toBe('OK');
  });
});

describe('displaySymbol: bidi and invisible characters', () => {
  it('strips a right-to-left override, the classic reordering trick', () => {
    expect(displaySymbol('USD\u{202e}CBA')).toBe('USDCBA');
    expect(displaySymbol('\u{202e}DCBA')).toBe('DCBA');
  });

  it('strips every bidi format control', () => {
    const CONTROLS = [
      '\u{61c}', // arabic letter mark
      '\u{200e}', // left-to-right mark
      '\u{200f}', // right-to-left mark
      '\u{202a}', // left-to-right embedding
      '\u{202b}', // right-to-left embedding
      '\u{202c}', // pop directional formatting
      '\u{202d}', // left-to-right override
      '\u{202e}', // right-to-left override
      '\u{2066}', // left-to-right isolate
      '\u{2067}', // right-to-left isolate
      '\u{2068}', // first strong isolate
      '\u{2069}', // pop directional isolate
    ];
    for (const ch of CONTROLS) {
      expect(displaySymbol(`AB${ch}CD`)).toBe('ABCD');
    }
  });

  it('strips zero-width characters and the byte order mark', () => {
    expect(displaySymbol('US\u{200b}D\u{200c}C\u{200d}\u{feff}')).toBe('USDC');
  });

  it('turns a newline or a tab into a space rather than welding words together', () => {
    expect(displaySymbol('USD\nCoin')).toBe('USD Coin');
    expect(displaySymbol('USD\tCoin')).toBe('USD Coin');
  });

  it('strips the remaining control characters, NUL included', () => {
    expect(displaySymbol('US\u{0}D\u{7}C')).toBe('USDC');
  });

  it('strips private-use characters', () => {
    expect(displaySymbol('US\u{e000}D\u{f0000}C')).toBe('USDC');
  });

  it('strips stacked combining marks (Zalgo)', () => {
    expect(displaySymbol('U\u{350}\u{351}\u{352}S\u{353}\u{354}D\u{355}C')).toBe('USDC');
  });
});

describe('displaySymbol: decorative alphabets fold to plain letters', () => {
  it('folds fullwidth letters', () => {
    expect(displaySymbol('ＵＳＤＣ')).toBe('USDC');
  });

  it('folds mathematical bold letters', () => {
    expect(displaySymbol('\u{1d414}\u{1d412}\u{1d403}\u{1d402}')).toBe('USDC');
  });

  it('folds enclosed and squared compatibility forms rather than drawing them', () => {
    // U+3372 SQUARE DA: one code point that renders as a box of letters, i.e.
    // exactly the oversized-glyph trick.
    expect(displaySymbol('㍲')).toBe('da');
  });
});

describe('displaySymbol: whitespace and length', () => {
  it('collapses runs of whitespace to one ordinary space', () => {
    expect(displaySymbol('A \t\n  B')).toBe('A B');
  });

  it('collapses non-breaking and ideographic spaces too', () => {
    expect(displaySymbol('A\u{a0}\u{a0}B')).toBe('A B');
    expect(displaySymbol('A\u{3000}B')).toBe('A B');
  });

  it('trims the ends', () => {
    expect(displaySymbol('  USDC  ')).toBe('USDC');
  });

  it('caps free text at MAX_DISPLAY_SYMBOL_LENGTH code points, ellipsis included', () => {
    const out = displaySymbol('a'.repeat(200));
    expect(Array.from(out).length).toBe(MAX_DISPLAY_SYMBOL_LENGTH);
    expect(out).toBe(`${'a'.repeat(MAX_DISPLAY_SYMBOL_LENGTH - 1)}…`);
  });

  it('caps a chain-alphabet name at MAX_DISPLAY_ASSET_NAME_LENGTH', () => {
    const out = displaySymbol('A'.repeat(200));
    expect(Array.from(out).length).toBe(MAX_DISPLAY_ASSET_NAME_LENGTH);
    expect(out).toBe(`${'A'.repeat(MAX_DISPLAY_ASSET_NAME_LENGTH - 1)}…`);
  });

  it('never cuts a surrogate pair in half', () => {
    // DESERET CAPITAL LETTER LONG I: two UTF-16 units, and NFKC leaves it alone.
    const raw = '\u{10400}'.repeat(40);
    const out = displaySymbol(raw);
    expect(Array.from(out).length).toBe(MAX_DISPLAY_SYMBOL_LENGTH);
    for (const ch of Array.from(out).slice(0, -1)) expect(ch).toBe('\u{10400}');
  });

  it('honours a caller-supplied cap', () => {
    expect(displaySymbol('ABCDEFGH', 4)).toBe('ABC…');
  });
});

describe('displaySymbol: nothing left to draw', () => {
  it.each(['✅', '✅✔✓', '\u{202e}', '   ', '\u{200b}\u{200c}', ''])(
    'renders %j as the unrenderable placeholder',
    (raw) => {
      expect(displaySymbol(raw)).toBe(UNRENDERABLE_SYMBOL);
    },
  );

  it('is a short, always-renderable placeholder', () => {
    expect(UNRENDERABLE_SYMBOL.length).toBe(1);
  });
});

describe('displaySymbol: identity is never touched', () => {
  it('is pure: the input string is unchanged', () => {
    const raw = REAL_SPAM_SYMBOLS.fakeCheck;
    const copy = `${raw}`;
    displaySymbol(raw);
    expect(raw).toBe(copy);
  });

  it('two different tokens that sanitise alike keep different raw symbols', () => {
    const a = 'USDC✅';
    const b = 'USDC✓';
    expect(displaySymbol(a)).toBe(displaySymbol(b));
    expect(a).not.toBe(b);
  });
});

describe('displayTokenName', () => {
  it('leaves a real token name alone', () => {
    expect(displayTokenName('USD Coin')).toBe('USD Coin');
    expect(displayTokenName('Wrapped Ether')).toBe('Wrapped Ether');
  });

  it('strips the same characters a symbol loses', () => {
    expect(displayTokenName('Verified ✅ USD Coin')).toBe('Verified USD Coin');
    expect(displayTokenName('USD\u{202e}Coin')).toBe('USDCoin');
  });

  it('caps at the longer name length', () => {
    const out = displayTokenName('N'.repeat(200));
    expect(Array.from(out).length).toBe(MAX_DISPLAY_NAME_LENGTH);
  });

  it('returns an empty string when nothing survives, so a row falls back to its symbol', () => {
    expect(displayTokenName('✅')).toBe('');
    expect(displayTokenName('')).toBe('');
  });
});
