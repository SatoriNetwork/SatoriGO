// Display ORDER for the Home asset list.
//
// `computeDisplayedAssets` (liveStore) decides WHICH rows exist — held ∪ pinned
// − hidden, native coin first. This module decides in WHAT ORDER the rest are
// shown, and it is a separate, pure step on purpose: the store's membership
// rules are persisted-state logic with their own tests, while ordering depends
// on things the store does not own (live USD prices, the token-trust registry)
// and changes underneath the list as those arrive.
//
// The problem it solves: plain alphabetical order put "(t.me/s/US_POOL) *claim
// until 24…" and "$TRUMP … Claim" — airdropped spam whose whole purpose is to
// be seen — ABOVE the tokens the user actually holds, because "(" and "$" sort
// before letters. Value and trust decide the order now; the alphabet only
// breaks ties.

import type { LiveAssetBalance } from '../../services/chain/electrumProvider';

/** What ordering needs to know about an asset beyond the row itself. */
export interface AssetOrderContext {
  /** USD value of THIS row's balance (amount × price), or null when the asset
   *  has no price. Not the unit price: a big balance of a cheap coin should
   *  outrank a dust balance of an expensive one. */
  usdFor(name: string): number | null;
  /** Trust verdict from the token registry: true = listed, false = checked and
   *  NOT listed (spam risk), null = unknown / not checked. */
  trustFor(name: string): boolean | null;
}

/** Ordering buckets, best first. The native coin is bucket 0 and always alone
 *  at the top; everything else is ranked by how likely the user is to want it. */
const RANK_NATIVE = 0;
const RANK_VALUED = 1; // non-zero balance with a known USD value
const RANK_HELD = 2; // non-zero balance, listed or not yet checked
const RANK_UNLISTED = 3; // non-zero balance, checked and NOT listed
const RANK_EMPTY = 4; // zero balance, whatever its trust

/**
 * Sort the displayed assets for the Home list. Pure, stable, and never mutates
 * the input (a new array comes back).
 *
 * Order:
 *   1. the native coin, always first
 *   2. anything with a known USD value, highest value first
 *   3. other non-zero balances that are listed or unchecked, A→Z
 *   4. other non-zero balances the registry says are NOT listed, A→Z
 *   5. zero balances last (listed/unchecked before unlisted), A→Z
 *
 * A zero balance never reaches bucket 2 even when its asset is priced: its USD
 * value is $0.00, which says nothing about how much the user cares about it.
 */
export function orderAssetsForDisplay(
  assets: readonly LiveAssetBalance[],
  ctx: AssetOrderContext,
): LiveAssetBalance[] {
  const decorated = assets.map((asset, index) => {
    const zero = asset.amountBase === 0n;
    const usd = asset.isNative || zero ? null : ctx.usdFor(asset.name);
    const trusted = ctx.trustFor(asset.name);
    const rank = asset.isNative
      ? RANK_NATIVE
      : zero
        ? RANK_EMPTY
        : usd != null && usd > 0
          ? RANK_VALUED
          : trusted === false
            ? RANK_UNLISTED
            : RANK_HELD;
    return { asset, index, rank, usd, unlisted: trusted === false };
  });

  decorated.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Inside the valued bucket: biggest holding first.
    if (a.rank === RANK_VALUED) {
      const av = a.usd ?? 0;
      const bv = b.usd ?? 0;
      if (av !== bv) return bv - av;
    }
    // Inside the empty bucket: an unlisted zero row sinks below a listed one.
    if (a.rank === RANK_EMPTY && a.unlisted !== b.unlisted) {
      return a.unlisted ? 1 : -1;
    }
    const byName = a.asset.name.localeCompare(b.asset.name);
    if (byName !== 0) return byName;
    // Stable: equal keys keep their incoming order.
    return a.index - b.index;
  });

  return decorated.map((d) => d.asset);
}

// ---------------------------------------------------------------------------
// MANUAL ORDER (the list's edit mode)
//
// `orderAssetsForDisplay` above is the wallet's OPINION about the order. Once
// the user has dragged a row, their opinion wins for the rows they touched, and
// only for those: everything else keeps falling where the automatic order puts
// it. That is what makes a newly-arrived token land somewhere sensible instead
// of at a random spot in a frozen list.
//
// WHAT HAPPENED TO `pinnedAssets`: nothing. It never meant "top" — it is a
// MEMBERSHIP list (computeDisplayedAssets shows a pinned asset even at a zero
// balance, and orderAssetsForDisplay then sinks a zero balance to the bottom
// like any other empty row). Position is now owned by the manual order, and
// membership stays where it always was, so the two never disagree. Folding pins
// into the order would have meant inventing a "pinned = first" rule that the
// wallet has never had, and it would have fought the user's own arrangement the
// first time they dragged a pinned row down.
// ---------------------------------------------------------------------------

/**
 * Apply the user's explicit order on top of an already-ordered list.
 *
 *   1. the native coin stays first, always (it is neither draggable nor
 *      removable, so it never appears in `order`),
 *   2. then every row named in `order`, in that order,
 *   3. then everything else, in the order it came in (the automatic one).
 *
 * An entry naming an asset that is no longer displayed is IGNORED, never
 * resurrected: the order is a preference about rows, not a list of rows.
 * Duplicates in `order` are collapsed to their first occurrence.
 *
 * Pure, and never mutates the input.
 */
export function applyManualOrder(
  assets: readonly LiveAssetBalance[],
  order: readonly string[],
): LiveAssetBalance[] {
  if (assets.length === 0) return [];
  const natives = assets.filter((a) => a.isNative);
  const rest = assets.filter((a) => !a.isNative);
  if (order.length === 0 || rest.length === 0) return [...natives, ...rest];

  const byName = new Map<string, LiveAssetBalance>();
  for (const a of rest) if (!byName.has(a.name)) byName.set(a.name, a);

  const placed: LiveAssetBalance[] = [];
  const used = new Set<string>();
  for (const name of order) {
    if (used.has(name)) continue;
    const row = byName.get(name);
    if (!row) continue; // gone from the list: the entry is dead weight, not a row
    used.add(name);
    placed.push(row);
  }
  // Anything the order says nothing about keeps its automatic position, AFTER
  // the arranged rows: a token added today has no stored place, and appending it
  // is the only answer that does not silently rearrange what the user set.
  const unplaced = rest.filter((a) => !used.has(a.name));
  return [...natives, ...placed, ...unplaced];
}

/** The names an order list is made of: the non-native rows, in display order. */
export function orderableNames(assets: readonly LiveAssetBalance[]): string[] {
  return assets.filter((a) => !a.isNative).map((a) => a.name);
}

/**
 * Move one entry of a name list from `from` to `to`, clamped to the list.
 * Returns the SAME array reference when the move is a no-op, so a caller can
 * skip a pointless persist. Pure.
 */
export function moveInOrder(names: string[], from: number, to: number): string[] {
  if (from < 0 || from >= names.length) return names;
  const target = Math.max(0, Math.min(names.length - 1, to));
  if (target === from) return names;
  const next = [...names];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}
