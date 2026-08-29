// MULTI-SELECT for the Home asset list's edit mode.
//
// Small and pure on purpose: the component owns WHEN the set changes (a tick,
// an exit, a refresh that dropped a row), this module owns WHAT the set becomes,
// so the rules can be tested without rendering a screen.
//
// The one rule that is safety-adjacent: the native coin (and any other protected
// asset of the chain) can never enter the set. `isRemovableAsset` in the store
// is the single source of truth for "protected"; this module takes its verdict
// as a parameter rather than re-deriving it, so there is exactly one such list.

import { displaySymbol } from '../../services/displaySymbol';

/**
 * Tick / untick one row. A row the caller says is NOT removable is refused
 * outright and the same set comes back, so a protected asset cannot be selected
 * even if a stray click reaches it.
 */
export function toggleAssetSelection(
  selected: ReadonlySet<string>,
  name: string,
  removable: boolean,
): Set<string> {
  if (!removable) return new Set(selected);
  const next = new Set(selected);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/**
 * Drop names that are no longer on screen. A background refresh can take a row
 * away (a token removed on another surface, a chain switch, an import undone)
 * and a selection that outlives its row would remove something the user cannot
 * see. Returns the SAME set reference when nothing had to go.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  present: readonly string[],
): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const on = new Set(present);
  let dropped = false;
  const next = new Set<string>();
  for (const name of selected) {
    if (on.has(name)) next.add(name);
    else dropped = true;
  }
  return dropped ? next : selected;
}

/** The empty selection. Leaving edit mode always ends here. */
export function clearSelection(): Set<string> {
  return new Set<string>();
}

/** "1 token selected" / "3 tokens selected". No em-dashes, no "0 selected"
 *  (the bar that shows it is not rendered at all when nothing is ticked). */
export function selectionLabel(count: number): string {
  return `${count} token${count === 1 ? '' : 's'} selected`;
}

/**
 * The confirmation's plain-language sentence about what removal means. Names up
 * to three of the tokens, then counts the rest, so a 20-token removal does not
 * render a wall of spam symbols.
 *
 * The names are DRAWN here, so they go through the display sanitiser: this
 * sentence is one of the places a token used to be able to put its own emoji
 * and text-direction controls inside copy the wallet wrote. Removal itself is
 * keyed off the raw names the caller holds, which this never touches.
 */
export function removalDescription(names: readonly string[]): string {
  const shown = names.slice(0, 3).map((n) => displaySymbol(n));
  const extra = names.length - shown.length;
  const list = extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
  const subject = names.length === 1 ? `${list} is` : `${list} are`;
  return `${subject} hidden from this list only. Nothing is sold, burned or moved: the balance stays on the blockchain and you can put the row back at any time with "Add token".`;
}
