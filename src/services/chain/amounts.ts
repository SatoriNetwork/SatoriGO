// Amounts, in ONE place: decimal coins <-> base units.
//
// Two rules this module exists to enforce.
//
// 1. THE SCALE IS A PROPERTY OF THE CHAIN, NOT OF THIS WALLET. Every chain
//    shipped today uses 8 decimals, and the code used to hardcode 1e8 in 34
//    places. `decimals` now comes from chain params, so a chain on another
//    scale is a data change rather than a hunt. An EVM chain would be 18, where
//    ONE coin (1e18 base units) already exceeds Number.MAX_SAFE_INTEGER.
//
// 2. PARSE FROM THE STRING, NEVER THROUGH A FLOAT. The send screen holds the
//    amount as text; the old path did parseFloat() and then multiplied, so the
//    value passed through a double before becoming base units and silently lost
//    precision past 2^53 base units (~90,071,992 coins at 8 decimals, a real
//    number on Dogecoin). parseAmount() goes text -> bigint directly, so there
//    is no boundary left to be wrong about.
//
// There are TWO send paths and they must not diverge: the wallet's own screen
// goes through liveStore, while the dApp approval window builds its transaction
// directly and deliberately never loads the store. Both import from here.

/** Longest fraction this module will format or accept, whatever `decimals` is.
 *  Guards a hostile/absurd `decimals` from producing a monstrous string. */
const MAX_SUPPORTED_DECIMALS = 36;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_SUPPORTED_DECIMALS) {
    throw new Error(`Unsupported decimals: ${decimals}`);
  }
}

/**
 * Exact text -> base units. No float anywhere on this path.
 *
 * Accepts plain decimal notation only ("1", "1.5", ".5", "1."). Exponent
 * notation and digit grouping are REFUSED rather than guessed at: "1e8" and
 * "1,000" both have more than one plausible reading, and this is the send path.
 *
 * Throws with a user-facing message; callers surface it as-is.
 */
export function parseAmount(input: string, decimals: number): bigint {
  assertDecimals(decimals);
  const text = input.trim();
  if (text === '') throw new Error('Enter an amount.');
  if (!/^\d*\.?\d*$/.test(text) || text === '.') {
    throw new Error('Enter a valid amount, digits and one decimal point only.');
  }

  const dot = text.indexOf('.');
  const whole = (dot === -1 ? text : text.slice(0, dot)) || '0';
  const fraction = dot === -1 ? '' : text.slice(dot + 1);

  if (fraction.length > decimals) {
    throw new Error(
      decimals === 0
        ? 'This coin cannot be divided, so enter a whole number.'
        : `Too many decimal places: this coin has at most ${decimals}.`,
    );
  }

  // Right-pad the fraction to exactly `decimals` digits, then read the whole
  // thing as one integer. BigInt() on a digit string is exact at any size.
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/**
 * Exact base units -> text. Never lossy: the digits come from BigInt, not from
 * a division.
 *
 * `trimZeros` (default true) drops a trailing run of zeros in the fraction, so
 * 100000000 at 8 decimals reads "1" rather than "1.00000000".
 */
export function formatAmount(
  base: bigint,
  decimals: number,
  opts?: { trimZeros?: boolean; grouping?: boolean; maxFractionDigits?: number },
): string {
  assertDecimals(decimals);
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  let whole = digits.slice(0, cut);
  let fraction = decimals > 0 ? digits.slice(cut) : '';

  const maxFraction = opts?.maxFractionDigits;
  if (maxFraction !== undefined && fraction.length > maxFraction) {
    // Truncate, never round: rounding a balance UP would show money that is
    // not there, and this is the only place the digits could gain a value.
    fraction = fraction.slice(0, maxFraction);
  }
  if (opts?.trimZeros !== false) fraction = fraction.replace(/0+$/, '');
  if (opts?.grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
}

/**
 * LIST-ROW text for a balance: the digits a one-line row can carry, so the
 * fiat value and the 24h chip beside it never get squeezed or overlapped by an
 * 18-decimal EVM balance (owner, 2026-08-21: "the price overlaps the up/down
 * percent on Epix"). MetaMask does the same on its asset list (a few
 * significant digits, "<0.000001" for dust, full precision on the detail
 * screen); this wallet's version:
 *
 *   0                        -> "0"
 *   >= 1000                  -> 2 fraction digits, grouped  ("12,345.67")
 *   otherwise                -> at most SIX significant digits, never more
 *                               than 8 fraction digits   ("999.999", "0.000123")
 *   > 0 but < 0.00000001     -> "<0.00000001" (dust is never shown as "0")
 *
 * Always TRUNCATED, never rounded up (MetaMask rounds to nearest; this wallet
 * never prints money that is not there). The full figure belongs on the asset
 * detail screen and in a `title` tooltip, both of which use formatAmount.
 */
export function formatListAmount(base: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (base === 0n) return '0';
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const unit = 10n ** BigInt(decimals);
  if (abs >= 1000n * unit) return formatAmount(base, decimals, { grouping: true, maxFractionDigits: 2 });
  const dustFloor = decimals > 8 ? 10n ** BigInt(decimals - 8) : 1n;
  if (abs < dustFloor) return `${negative ? '-' : ''}<0.00000001`;
  const digits = abs.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const SIGNIFICANT = 6;
  let maxFraction: number;
  if (whole !== '0') {
    maxFraction = Math.max(0, SIGNIFICANT - whole.length);
  } else {
    const leadingZeros = fraction.length - fraction.replace(/^0+/, '').length;
    maxFraction = leadingZeros + SIGNIFICANT;
  }
  maxFraction = Math.min(maxFraction, 8, decimals);
  return formatAmount(base, decimals, { grouping: true, maxFractionDigits: maxFraction });
}

/**
 * Base units -> a JS number, for DISPLAY ARITHMETIC ONLY (a fiat multiply, a
 * chart). LOSSY by construction above 2^53 base units. Never feed the result
 * back into a transaction; use bigint for that.
 */
export function amountToNumber(base: bigint, decimals: number): number {
  return Number(formatAmount(base, decimals, { trimZeros: false }));
}

/** Largest whole-coin amount a JS number can carry exactly at `decimals`.
 *  Only the number-shaped entry point below needs this; parseAmount has no
 *  such boundary because it never touches a float. */
export function maxSafeAmount(decimals: number): number {
  assertDecimals(decimals);
  return Number.MAX_SAFE_INTEGER / 10 ** decimals;
}

/**
 * Number -> base units, for the ONE caller that genuinely receives a number:
 * a transaction proposed by a website, whose JSON already parsed it as one.
 * Everything the user types goes through parseAmount instead.
 *
 * Refuses what it cannot convert exactly rather than returning a wrong figure.
 */
export function toBaseUnits(amountDecimal: number, decimals: number): bigint {
  assertDecimals(decimals);
  if (!Number.isFinite(amountDecimal) || amountDecimal < 0) {
    throw new Error('Enter a valid amount.');
  }
  const limit = maxSafeAmount(decimals);
  if (amountDecimal > limit) {
    throw new Error(
      `Amount is too large to convert exactly. The most that can be sent in one transaction this way is ${limit.toLocaleString('en-US', { maximumFractionDigits: decimals })}. Split it into smaller sends.`,
    );
  }
  // Route through the exact parser: toFixed gives a plain decimal string with
  // no exponent, so the bigint conversion below is still float-free.
  return parseAmount(amountDecimal.toFixed(decimals), decimals);
}

/**
 * Round a base-unit amount DOWN to a coarser display precision.
 *
 * An Evrmore asset is stored in 1e8 base units whatever its own divisions are,
 * so an asset with divisions 0 can still hold a value with a fraction. Filling
 * the send field from a percentage of such a balance must not produce an amount
 * the asset cannot express. Always DOWN: rounding up would offer to send more
 * than is held.
 */
export function floorToPrecision(base: bigint, scale: number, decimals: number): bigint {
  assertDecimals(scale);
  if (decimals >= scale) return base;
  const step = 10n ** BigInt(scale - decimals);
  return (base / step) * step;
}
