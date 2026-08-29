// The engine seam: what the store may rely on from ANY wallet engine, and the
// wallet-family switch that decides which engine a stored wallet belongs to.
//
//   WalletEngine  (interface the store talks to)
//   ├── UtxoEngine  = LiveWalletService, unchanged (family 'utxo')
//   └── EvmEngine   = phase 2+ of the EVM rollout plan (family 'evm')
//
// THE MIGRATION IS THE DEFAULT. A stored WalletEntry without `family` is a
// UTXO wallet, so every wallet that exists today keeps working and no store
// version bump happens. Same trick as encodeSeedSecret's bare-mnemonic branch:
// the old shape IS a valid new shape. Read `family` ONLY through walletFamily();
// never compare `entry.family === 'utxo'` directly, that would misclassify every
// pre-EVM wallet as "not utxo".
//
// This interface is deliberately small: it is what both families share TODAY.
// Reads (phase 2) and the money path (phase 3) widen it; nothing chain-shaped
// (UTXO gathering, nonces, fee models) may ever surface above it.

import type { WalletDataProvider } from '../provider';

export type WalletFamily = 'utxo' | 'evm';

/** The `network` value stored on an EVM account. An EVM account is one address
 *  on EVERY EVM chain, so it has no single UTXO network; this sentinel keeps
 *  the field present (every reader expects a string) while making a family-blind
 *  read of it fail LOUDLY (it resolves to no chain params) instead of quietly
 *  masquerading as Evrmore. Which EVM chain the UI shows lives in `evmChainKey`. */
export const EVM_NETWORK = 'evm';

/** What an absent `family` means. Every wallet created before the EVM engine. */
export const DEFAULT_WALLET_FAMILY: WalletFamily = 'utxo';

/** The family of a stored wallet or its public summary. Absent = utxo. */
export function walletFamily(entry: { family?: WalletFamily } | null | undefined): WalletFamily {
  return entry?.family ?? DEFAULT_WALLET_FAMILY;
}

export function isEvmWallet(entry: { family?: WalletFamily } | null | undefined): boolean {
  return walletFamily(entry) === 'evm';
}

/** The contract every engine satisfies, regardless of chain family. */
export interface WalletEngine {
  readonly family: WalletFamily;
  isUnlocked(): boolean;
  lock(): void;
  /** Public address of the active wallet's key at `index` (0 = primary). */
  getAddress(index?: number): string;
  /** The read side (balances, history, status) for the active wallet. */
  getProvider(): WalletDataProvider;
}

/**
 * The EVM code is built into a package ONLY when `__EVM_ENABLED__` is true
 * (vite `define`, set by `scripts/build.mjs --evm`). A production build without
 * the flag must contain no EVM module at all: `main` stays releasable while the
 * rollout is in progress, and AMO reviewers who build from source get no
 * half-finished chain code to read. This is the ONE place a non-EVM module may
 * reach for the EVM modules, and it does so through a flag-guarded dynamic
 * import so Rollup drops both the branch and the chunk when the flag is off.
 * `scripts/build.mjs` verifies that instead of assuming it.
 */
export async function loadEvmModules(): Promise<typeof import('./evm') | null> {
  if (!__EVM_ENABLED__) return null;
  return import('./evm');
}
