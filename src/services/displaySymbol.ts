// One sanitiser for every token symbol and token name this wallet DRAWS.
//
// WHY THIS EXISTS
// A token's symbol is a string the token's own author chose, and on an EVM
// chain anyone can deploy a token. Real rows seen on a live Base account:
//
//   www.badrp.co ✅
//   (t.me/s/US_POOL) *claim until 24.02.26
//   $TRUMP - Claim: t.ly/TRUMP - #45
//   5ETH Reward at web3eth.vip
//
// The first one is the dangerous shape: the token carries its OWN green check
// mark, and rendered verbatim that check is bigger and more colourful than any
// warning the wallet puts beside it. A token was therefore able to award itself
// a trust badge that outweighed ours. Right-to-left overrides are the same
// trick in reverse: U+202E inside a symbol reorders everything drawn after it,
// including text the wallet wrote itself.
//
// THE RULE: DISPLAY ONLY, NEVER IDENTITY
// Everything here changes what the user SEES. Nothing here may reach an
// identity: the raw symbol stays the storage key, the Map key, the comparison
// operand, the `data-testid`, and the value the balance is looked up by. A
// token's identity on an EVM chain is its contract address in any case (see
// EvmTokenRef); the symbol was never identity, and this module must not make it
// look like one. Sanitise at the point of RENDER, never before storing.
//
// WHAT IT DOES, IN ORDER
//  1. NFKC-normalises, which folds the decorative alphabets (fullwidth "ＵＳＤＣ",
//     mathematical bold "𝐔𝐒𝐃𝐂", enclosed and ligature forms) down to plain
//     letters. Those exist to render larger and louder than the surrounding UI,
//     which is exactly the advantage being taken away. A fake that folds to the
//     same letters as a real token is not a new risk: the unlisted pill, not the
//     spelling, is what tells the user the wallet cannot vouch for it.
//  2. Removes pictographs and emoji (✅, ⚠, ★), other symbols (✓, ✔), control
//     characters, private-use and format characters (which is where the bidi
//     overrides and the zero-width joiners live), and combining marks (Zalgo
//     stacking, which can make one row overflow the ones around it).
//  3. Collapses every remaining run of whitespace to one ordinary space and
//     trims the ends.
//  4. Caps the length, so a symbol cannot push the rest of a row, a title or a
//     confirmation sentence off the screen.
//
// A symbol made ENTIRELY of the characters above has nothing left to draw, and
// the wallet says so with `?` rather than rendering an empty gap.

/** Longest FREE-TEXT symbol drawn, in code points. Real ERC-20 symbols are
 *  short (the longest in the Base and BNB Chain token lists sit in the low
 *  teens); past this the string is a message, not a name. */
export const MAX_DISPLAY_SYMBOL_LENGTH = 16;

/** Longest CHAIN-ENFORCED asset name drawn. An Evrmore or Ravencoin asset name
 *  is 1..31 characters from a fixed alphabet (assetScript.ts encodeAssetName),
 *  so it is not free text and 31 of them is a legitimate name, not a lure.
 *  Cutting those at the free-text cap would truncate real assets. */
export const MAX_DISPLAY_ASSET_NAME_LENGTH = 32;

/** The alphabet an Evrmore/Ravencoin asset name is restricted to: upper case,
 *  digits, and the sub-asset (`/`), unique (`#`), owner (`!`) and channel (`~`)
 *  markers. A spam ERC-20 symbol never matches it: they carry lower case,
 *  spaces, brackets, `$` or `:` (see the pinned strings in the tests). */
const CHAIN_ASSET_NAME_RE = /^[A-Z0-9._/#!~]+$/;

/** Longest token NAME drawn. Names are legitimately sentences ("USD Coin",
 *  "Wrapped liquid staked Ether"), so the cap is looser than for a symbol. */
export const MAX_DISPLAY_NAME_LENGTH = 40;

/** What a symbol renders as when sanitising leaves nothing at all (a symbol
 *  that was only emoji, only bidi controls, only whitespace). */
export const UNRENDERABLE_SYMBOL = '?';

/**
 * Characters removed outright.
 *
 *  \p{Cc} control            C0/C1 controls, including newlines and NUL
 *  \p{Cf} format             bidi overrides (U+202E and friends), U+200B..U+200D,
 *                            U+FEFF, U+061C, the isolate controls U+2066..U+2069
 *  \p{Co} private use        glyphs only the attacker's own font can draw
 *  \p{Cs} surrogate          lone halves of a surrogate pair
 *  \p{M}  mark               combining marks; Zalgo stacking. Step 1 has already
 *                            composed the legitimate accented letters (é and its
 *                            kin are single code points after NFKC), so what is
 *                            left here is decoration, not spelling
 *  \p{So} symbol, other      ✓ ✔ ✅ ⚠ ★ ☑ and the rest of the fake-badge family,
 *                            including the check marks that are NOT emoji
 *  \p{Extended_Pictographic} the emoji proper, whether or not U+FE0F follows
 *  \p{Emoji_Modifier}        skin-tone modifiers
 *  \p{Regional_Indicator}    flag halves
 *
 * Currency signs (\p{Sc}: $, €) and maths symbols (\p{Sm}: +, =) are NOT in the
 * list: "$TRUMP" and "USD+" are shapes real tokens use, and neither can pass
 * itself off as a wallet-issued badge.
 */
const STRIP_RE =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{M}\p{So}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/gu;

/** Every Unicode space (\p{Zs} covers NBSP and the ideographic space) plus the
 *  ASCII whitespace \s already matches. Ogham space mark is \p{Zs} too. */
const WHITESPACE_RE = /[\s\p{Zs}]+/gu;

/** Cut to `max` code points (never mid surrogate pair), appending an ellipsis
 *  when anything was dropped. */
function capLength(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** Everything except the cap: the same for a symbol and for a name. */
function scrub(raw: string): string {
  let text: string;
  try {
    text = raw.normalize('NFKC');
  } catch {
    // A lone surrogate makes normalize throw on some engines; the strip below
    // removes those anyway, so fall back to the unnormalised string.
    text = raw;
  }
  // Whitespace FIRST, because a tab and a newline are also \p{Cc}: stripping
  // them would weld "USD\nCoin" into "USDCoin". They become a space, then the
  // second pass collapses whatever the strip left adjacent.
  return text.replace(WHITESPACE_RE, ' ').replace(STRIP_RE, '').replace(WHITESPACE_RE, ' ').trim();
}

/**
 * The safe rendering of a token symbol or asset name. Returns `?` when nothing
 * printable survives. NEVER use the result as a key, a comparison operand or a
 * lookup: see the module header.
 *
 * With no `max`, the cap depends on what the string is: a chain-enforced asset
 * name (Evrmore, Ravencoin) gets the 32-character allowance the chain itself
 * gives it, and anything else, which is to say every free-text ERC-20 symbol,
 * gets the tight one. Pass `max` to override both.
 */
export function displaySymbol(raw: string, max?: number): string {
  const text = scrub(raw ?? '');
  const cap =
    max ?? (CHAIN_ASSET_NAME_RE.test(text) ? MAX_DISPLAY_ASSET_NAME_LENGTH : MAX_DISPLAY_SYMBOL_LENGTH);
  return capLength(text, cap) || UNRENDERABLE_SYMBOL;
}

/**
 * The safe rendering of a token NAME (the long form beside the symbol). Same
 * treatment, a longer cap, and an empty result stays empty: a row with no name
 * simply shows its symbol, where a row with no symbol has nothing to show.
 */
export function displayTokenName(raw: string, max: number = MAX_DISPLAY_NAME_LENGTH): string {
  return capLength(scrub(raw ?? ''), max);
}

/** True when drawing `raw` verbatim would differ from drawing it safely, i.e.
 *  the symbol carries characters this module removes or is over the cap. Used
 *  by tests, and by the unlisted note to explain why a name shown here differs
 *  from the one a block explorer prints. */
export function isSymbolSanitised(raw: string, max?: number): boolean {
  return displaySymbol(raw, max) !== raw;
}
