// Grouping of wallet entries into the MetaMask-style "one seed, many accounts"
// shape the pickers render (the EVM accounts design notes).
//
// An EVM seed entry IS an account: one address index of one seed. Several such
// entries share a `seedGroup` (the seed's index-0 address, lowercased), and the
// UI must show them as "Account 1, Account 2, ..." under one seed heading
// rather than as unrelated wallets. Everything else (UTXO wallets, imported
// private keys) keeps rendering as a single row.
//
// Pure on purpose: Home, the lock screen and Settings all render the same
// structure, and the flattened row order this returns is what the
// `live-wallet-item-${i}` / `live-lock-wallet-${i}` indexes count, so it is
// worth pinning in unit tests instead of re-deriving it three times inline.

/** The minimum a wallet entry must expose to be grouped. `WalletSummary`
 *  satisfies it, so callers pass their summaries straight through. */
export interface GroupableWallet {
  id: string;
  name: string;
  /** Absent = 'utxo' (an entry stored before families existed). */
  family?: string;
  kind?: string;
  /** EVM seed accounts only: address index (absent = 0). */
  hdIndex?: number;
  /** EVM seed accounts only: the seed's index-0 address, lowercased. */
  seedGroup?: string;
}

/** One node of the grouped list: either a standalone wallet row, or a seed with
 *  its accounts. A seed with a single account is STILL a group: that is where
 *  "Add account" hangs, and a freshly imported seed has exactly one. */
export type WalletGroupNode<T> =
  | { kind: 'single'; wallet: T }
  | { kind: 'group'; key: string; title: string; members: T[] };

/** True for an entry that is one account of an EVM seed (never a private-key
 *  import, never a UTXO wallet: those keep multi-address inside one entry). */
export function isEvmSeedAccount(w: GroupableWallet | null | undefined): boolean {
  return !!w && w.family === 'evm' && w.kind === 'seed';
}

/** Group key for an EVM seed account. Entries stored before this feature carry
 *  no `seedGroup` (it is backfilled at their next unlock), so they are keyed by
 *  their own id: a group of one, which is exactly what they are as far as this
 *  device can prove. */
function groupKeyOf(w: GroupableWallet): string {
  return w.seedGroup ?? `id:${w.id}`;
}

/** MetaMask's account number for an entry: address index + 1. */
export function accountNumberOf(w: GroupableWallet): number {
  return (w.hdIndex ?? 0) + 1;
}

/**
 * Per-chain account visibility (owner, 2026-08-19: "one wallet on BNB has 14
 * accounts, the same wallet on Ethereum only 1; the list must follow the
 * chain"). `seen` maps a seedGroup to the hdIndexes known USED on the ACTIVE
 * chain (persisted by the store; written by discovery and by Add account).
 *
 * Rules: a group with NO recorded set shows everything (no data is not
 * evidence of absence); index 0 always shows (the seed's main account IS the
 * wallet); the ACTIVE account always shows (the list may never hide the row
 * you are on). Non-EVM entries pass through untouched.
 */
export function filterAccountsForChain<T extends GroupableWallet>(
  wallets: readonly T[],
  seen: Readonly<Record<string, readonly number[] | undefined>>,
  activeWalletId: string | null,
): T[] {
  return wallets.filter((w) => {
    if (!isEvmSeedAccount(w) || !w.seedGroup) return true;
    const set = seen[w.seedGroup];
    if (set === undefined) return true;
    const index = w.hdIndex ?? 0;
    return index === 0 || w.id === activeWalletId || set.includes(index);
  });
}

/** The row label for a member of a seed group. The seed's first account keeps
 *  the wallet's own name ("Wallet 1"), which is also the group's title; under
 *  that title, in a group with several accounts, it reads as "Account 1" so the
 *  list is "Account 1, Account 2, ..." and the name is not printed twice. A lone
 *  account and every other member keep their own name. Display only: the
 *  entry's stored name is untouched. */
export function memberLabel(w: GroupableWallet, groupTitle: string, memberCount: number): string {
  if (memberCount > 1 && w.name === groupTitle) return `Account ${accountNumberOf(w)}`;
  return w.name;
}

/**
 * Group EVM seed accounts under their seed, leaving every other entry alone.
 *
 * - Overall order follows FIRST APPEARANCE: a group takes the position of its
 *   earliest member, so re-ordering never surprises a user who just added an
 *   account.
 * - Inside a group, members are sorted by `hdIndex` ascending (absent = 0),
 *   ties broken by their original order, so "Account 1, 2, 3" always reads in
 *   order no matter how the entries were stored.
 * - The group title is the name of the lowest-index member (the seed's first
 *   account), which is the name the user gave the wallet when importing it.
 */
export function groupWallets<T extends GroupableWallet>(wallets: T[]): WalletGroupNode<T>[] {
  const nodes: WalletGroupNode<T>[] = [];
  // key -> index into `nodes`, so a later member joins the group already placed
  // at its first member's position.
  const groupAt = new Map<string, number>();
  // Original position of each entry, for the stable tiebreak below.
  const order = new Map<T, number>();

  wallets.forEach((w, i) => {
    order.set(w, i);
    if (!isEvmSeedAccount(w)) {
      nodes.push({ kind: 'single', wallet: w });
      return;
    }
    const key = groupKeyOf(w);
    const at = groupAt.get(key);
    if (at == null) {
      groupAt.set(key, nodes.length);
      nodes.push({ kind: 'group', key, title: w.name, members: [w] });
      return;
    }
    const node = nodes[at];
    if (node.kind === 'group') node.members.push(w);
  });

  for (const node of nodes) {
    if (node.kind !== 'group') continue;
    node.members.sort((a, b) => {
      const d = (a.hdIndex ?? 0) - (b.hdIndex ?? 0);
      return d !== 0 ? d : (order.get(a) ?? 0) - (order.get(b) ?? 0);
    });
    node.title = node.members[0]?.name ?? node.title;
  }

  return nodes;
}

/** The flattened, selectable rows of a grouped list, in render order. The index
 *  of a wallet here IS the `i` in `live-wallet-item-${i}`: group headings are
 *  not selectable and take no index. */
export function flattenGroups<T extends GroupableWallet>(nodes: WalletGroupNode<T>[]): T[] {
  const out: T[] = [];
  for (const node of nodes) {
    if (node.kind === 'single') out.push(node.wallet);
    else out.push(...node.members);
  }
  return out;
}

/** Accounts of the SAME seed as `wallet`, excluding `wallet` itself. Empty for a
 *  UTXO wallet, a private-key wallet, and a seed with only this one account.
 *  Drives the delete copy: removing an account that has siblings leaves the
 *  seed on this device, removing the last one does not. */
export function siblingAccounts<T extends GroupableWallet>(
  wallets: T[],
  wallet: T | null | undefined,
): T[] {
  if (!wallet || !isEvmSeedAccount(wallet)) return [];
  const key = groupKeyOf(wallet);
  return wallets.filter((w) => w.id !== wallet.id && isEvmSeedAccount(w) && groupKeyOf(w) === key);
}

/** Short 0x form for a picker row: `0x9858…da94` (6 + 4). Non-EVM or short
 *  strings come back untouched, so this is safe to call on any address. */
export function shortAccountAddress(address: string): string {
  if (!address || address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
