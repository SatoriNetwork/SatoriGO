// window.ethereum connections: PURE logic, unit-tested (evmApprovals.test.ts).
//
// Kept apart from the Evrmore list (approvals.ts, key `dappApprovedOrigins`)
// on purpose: a site may be connected to an Evrmore wallet through
// window.evrmore AND to an EVM account through window.ethereum at the same
// time, and the Evrmore list allows one wallet per origin. Storage key
// `dappEvmApprovedOrigins` holds [{origin, walletId, chainKey}]: the EVM
// account the user picked, and the chain the site last switched to.

/** storage (local): the EVM connection list. MUST match liveStore.ts. */
export const EVM_APPROVED_ORIGINS_KEY = 'dappEvmApprovedOrigins';

export interface EvmApprovedEntry {
  origin: string;
  walletId: string;
  /** evm/chains.ts key (e.g. 'base'). */
  chainKey: string;
}

/**
 * Sanitize the raw stored list: drop malformed entries, entries for wallets
 * that no longer exist (when `validWalletIds` is given) and duplicate origins
 * (the LATER entry wins, one account per origin). A chain key the build does
 * not know falls back to `defaultChainKey`.
 */
export function normalizeEvmApprovals(
  raw: unknown,
  opts: { validWalletIds?: ReadonlySet<string>; isChainKey: (k: string) => boolean; defaultChainKey: string },
): { entries: EvmApprovedEntry[]; changed: boolean } {
  if (!Array.isArray(raw)) return { entries: [], changed: raw !== undefined && raw !== null };
  const byOrigin = new Map<string, EvmApprovedEntry>();
  let changed = false;
  for (const item of raw as unknown[]) {
    const e = item as Partial<EvmApprovedEntry> | null;
    if (!e || typeof e.origin !== 'string' || !e.origin || typeof e.walletId !== 'string' || !e.walletId) {
      changed = true;
      continue;
    }
    if (opts.validWalletIds && !opts.validWalletIds.has(e.walletId)) {
      changed = true;
      continue;
    }
    let chainKey = typeof e.chainKey === 'string' ? e.chainKey : '';
    if (!opts.isChainKey(chainKey)) {
      chainKey = opts.defaultChainKey;
      changed = true;
    }
    if (byOrigin.has(e.origin)) {
      changed = true;
      byOrigin.delete(e.origin); // re-insert so the later entry keeps its place
    }
    byOrigin.set(e.origin, { origin: e.origin, walletId: e.walletId, chainKey });
  }
  return { entries: [...byOrigin.values()], changed };
}

/** The entry for `origin`, or undefined. */
export function evmApprovalFor(entries: readonly EvmApprovedEntry[], origin: string): EvmApprovedEntry | undefined {
  return entries.find((e) => e.origin === origin);
}

/** Bind `origin` to `walletId` on `chainKey`, replacing any earlier binding. */
export function setEvmApproval(
  entries: readonly EvmApprovedEntry[],
  origin: string,
  walletId: string,
  chainKey: string,
): EvmApprovedEntry[] {
  return [...entries.filter((e) => e.origin !== origin), { origin, walletId, chainKey }];
}

/** Move a connected origin to another chain. Unchanged when not connected. */
export function setEvmApprovalChain(
  entries: readonly EvmApprovedEntry[],
  origin: string,
  chainKey: string,
): EvmApprovedEntry[] {
  return entries.map((e) => (e.origin === origin ? { ...e, chainKey } : e));
}
