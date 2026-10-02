// Favourite networks in the chain switcher: an ordered list of chain target
// ids (a UTXO LiveNetworkId, `evm:<key>`, `xmr:mainnet`, ...), oldest star
// first. A per-device UI preference stored inside Settings (see settings.ts),
// so it is independent of which wallet is open and survives reload and lock.
//
// Ids this build does not know are NOT pruned from storage: the EVM chain list
// arrives from the gateway after boot, so pruning at load would drop a starred
// EVM chain on every cold start. The switcher simply skips ids it has no row
// for, and the toggles below leave such ids where they are.

/** A stored value as a clean list: strings only, no blanks, no duplicates
 *  (first occurrence wins). Anything else reads as no favourites. */
export function normalizeFavouriteChains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Star or unstar `id`: a new star goes to the END (newest at the bottom). */
export function toggleFavouriteChain(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Move `id` one place up (-1) or down (+1) among the ids in `among` (the
 *  favourites the user can actually see), swapping it with that neighbour in
 *  the stored list. Ids outside `among` (unknown to this build, hidden, or
 *  filtered out by the search) keep their slots. No neighbour = unchanged. */
export function moveFavouriteChain(
  list: readonly string[],
  id: string,
  dir: -1 | 1,
  among: readonly string[] = list,
): string[] {
  const visible = list.filter((x) => among.includes(x));
  const at = visible.indexOf(id);
  const neighbour = visible[at + dir];
  if (at < 0 || neighbour === undefined) return [...list];
  const out = [...list];
  const i = out.indexOf(id);
  const j = out.indexOf(neighbour);
  out[i] = neighbour;
  out[j] = id;
  return out;
}
