// dApp approval bookkeeping — PURE logic, unit-tested (see approvals.test.ts).
//
// SECURITY (M2 fix): a site's approval is bound to a SPECIFIC wallet, not just an
// origin. Storage key `dappApprovedOrigins` holds an array of {origin, walletId}.
// An origin is "connected" only while an entry matches BOTH the request origin AND
// the CURRENTLY ACTIVE wallet id. Switching the active wallet therefore invalidates
// a site's access until the user re-consents for the new wallet — the new wallet's
// address and balances are never served silently.
//
// This module owns three things, all pure and side-effect free:
//   1. normalizeApprovals — one-time migration of the on-disk list (legacy strings
//      -> {origin, activeId}), dropping malformed entries and pruning entries whose
//      wallet no longer exists.
//   2. isOriginApproved — the (origin, activeId) match test the worker gates on.
//   3. addApproval — append a {origin, walletId} entry (dedup).

/** One approved connection: an origin bound to the wallet it was approved for. */
export interface ApprovedEntry {
  origin: string;
  walletId: string;
}

/** A raw on-disk entry: either the LEGACY bare-origin string, or an {origin,walletId}
 *  object. Anything else is malformed and dropped on read. */
export type RawApprovedEntry = string | { origin?: unknown; walletId?: unknown } | null | undefined;

/** True when `e` is a well-formed {origin, walletId} entry (both non-empty strings). */
function isEntry(e: unknown): e is ApprovedEntry {
  if (typeof e !== 'object' || e === null) return false;
  const o = (e as { origin?: unknown }).origin;
  const w = (e as { walletId?: unknown }).walletId;
  return typeof o === 'string' && o !== '' && typeof w === 'string' && w !== '';
}

/**
 * Migrate + sanitize the raw persisted list into canonical {origin, walletId} entries.
 *
 * - A legacy bare-string entry is rebound to `activeId` (the wallet the user is
 *   actually using) — preserving the pre-M2 behavior for that one wallet. When there
 *   is no active wallet (`activeId` empty/undefined) a legacy string cannot be bound
 *   to any wallet and is dropped (fail closed: it will simply re-prompt on next use).
 * - Malformed entries (non-string, missing/empty fields) are dropped.
 * - When `validWalletIds` is provided, entries whose walletId is not in that set are
 *   pruned (dead approvals for a deleted wallet). Pass `undefined` to skip pruning.
 * - Duplicate (origin, walletId) pairs are collapsed to one.
 *
 * Returns the canonical list AND whether it differs from the input shape, so the
 * caller can persist the migrated form back exactly once.
 */
export function normalizeApprovals(
  raw: unknown,
  activeId: string | undefined | null,
  validWalletIds?: ReadonlySet<string>,
): { entries: ApprovedEntry[]; changed: boolean } {
  if (!Array.isArray(raw)) {
    // Missing / corrupt list => empty. "changed" only matters when there WAS data
    // to rewrite; an absent key needs no write-back.
    return { entries: [], changed: raw !== undefined && raw !== null };
  }

  const out: ApprovedEntry[] = [];
  const seen = new Set<string>();
  let changed = false;

  for (const item of raw as RawApprovedEntry[]) {
    let entry: ApprovedEntry | null = null;
    if (typeof item === 'string' && item !== '') {
      // Legacy: bind to the active wallet, or drop if there is none.
      if (activeId) entry = { origin: item, walletId: activeId };
      changed = true; // shape changed (string -> object, or dropped)
    } else if (isEntry(item)) {
      entry = { origin: item.origin, walletId: item.walletId };
    } else {
      changed = true; // malformed -> dropped
    }

    if (!entry) continue;

    // Prune approvals bound to a wallet that no longer exists.
    if (validWalletIds && !validWalletIds.has(entry.walletId)) {
      changed = true;
      continue;
    }

    const key = `${entry.origin}\u0000${entry.walletId}`;
    if (seen.has(key)) {
      changed = true; // duplicate collapsed
      continue;
    }
    seen.add(key);
    out.push(entry);
  }

  return { entries: out, changed };
}

/** True when some entry approves this exact origin for the given (active) wallet. */
export function isOriginApproved(
  entries: readonly ApprovedEntry[],
  origin: string,
  activeId: string | undefined | null,
): boolean {
  if (!activeId) return false;
  return entries.some((e) => e.origin === origin && e.walletId === activeId);
}

/** Append an {origin, walletId} approval, de-duplicating an existing exact match. */
export function addApproval(
  entries: readonly ApprovedEntry[],
  origin: string,
  walletId: string,
): ApprovedEntry[] {
  if (entries.some((e) => e.origin === origin && e.walletId === walletId)) {
    return entries.slice();
  }
  return [...entries, { origin, walletId }];
}
