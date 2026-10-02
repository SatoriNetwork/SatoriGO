// The engine seam: what the store may rely on from ANY wallet engine, and the
// wallet-family switch that decides which engine a stored wallet belongs to.
//
//   WalletEngine  (interface the store talks to)
//   ├── UtxoEngine    = LiveWalletService, unchanged (family 'utxo')
//   ├── EvmEngine     = phase 2+ of the EVM rollout plan (family 'evm')
//   └── MoneroEngine  = the Monero engine design notes (family 'monero')
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

export type WalletFamily = 'utxo' | 'evm' | 'monero' | 'zcash' | 'substrate';

/** The `network` value stored on an EVM account. An EVM account is one address
 *  on EVERY EVM chain, so it has no single UTXO network; this sentinel keeps
 *  the field present (every reader expects a string) while making a family-blind
 *  read of it fail LOUDLY (it resolves to no chain params) instead of quietly
 *  masquerading as Evrmore. Which EVM chain the UI shows lives in `evmChainKey`. */
export const EVM_NETWORK = 'evm';

/** The `network` value stored on a Monero wallet, AND the chain id the
 *  switcher and picker address it by: one string, `xmr:mainnet`, in the same
 *  namespace as the UTXO ids and the `evm:<key>` targets (the Monero engine
 *  design notes §8). Like EVM_NETWORK it keeps the field present while making
 *  a family-blind read of it resolve to no UTXO chain params. There is exactly
 *  one Monero target: the wallet carries no stagenet or testnet wallet. */
export const MONERO_NETWORK = 'xmr:mainnet';

/** The `network` value stored on a Zcash wallet AND its switcher id, the
 *  Monero rule exactly (the Zcash engine design notes §8): one string,
 *  `zec:mainnet`, transparent-only, one target (no testnet wallet). The engine
 *  is pure TypeScript with no manifest, CSP or host consequence, so unlike
 *  Monero it has no build flag and no loader: src/services/chain/zcash/ is a
 *  static import wherever it is needed (§13). */
export const ZCASH_NETWORK = 'zec:mainnet';

/** The `network` value stored on a Bittensor wallet AND its switcher id (the
 *  Bittensor engine design notes §8). The FAMILY is 'substrate' (keys, SS58,
 *  SCALE, the extrinsic and the RPC set are Substrate's; a second Substrate
 *  chain would add a runtime profile, not an engine), the TARGET names the one
 *  chain: `tao:mainnet`. Static import, no build flag (§13). */
export const TAO_NETWORK = 'tao:mainnet';

/** What an absent `family` means. Every wallet created before the EVM engine. */
export const DEFAULT_WALLET_FAMILY: WalletFamily = 'utxo';

/** The family of a stored wallet or its public summary. Absent = utxo. */
export function walletFamily(entry: { family?: WalletFamily } | null | undefined): WalletFamily {
  return entry?.family ?? DEFAULT_WALLET_FAMILY;
}

export function isEvmWallet(entry: { family?: WalletFamily } | null | undefined): boolean {
  return walletFamily(entry) === 'evm';
}

export function isMoneroWallet(entry: { family?: WalletFamily } | null | undefined): boolean {
  return walletFamily(entry) === 'monero';
}

export function isZcashWallet(entry: { family?: WalletFamily } | null | undefined): boolean {
  return walletFamily(entry) === 'zcash';
}

export function isSubstrateWallet(entry: { family?: WalletFamily } | null | undefined): boolean {
  return walletFamily(entry) === 'substrate';
}

/** Where a seed wallet's phrase came from (WalletEntry.origin in liveWallet.ts):
 *  'generated' when create() made it on this install, 'imported' when the user
 *  typed it. Absent on entries stored before the field existed. */
export type WalletOrigin = 'generated' | 'imported';

/** Whether "Add Monero" must assume the phrase already carries Monero funds
 *  (the Monero engine design notes §6.6): everything but a phrase generated on
 *  this install, so an unknown origin counts as used. Lives here, not in
 *  liveWallet.ts, so the chain switcher can preset its checkbox by the same
 *  rule without pulling the whole service (and its chain registry) into a
 *  screen module. */
export function moneroPhraseUsedBefore(entry: { origin?: WalletOrigin } | null | undefined): boolean {
  return entry?.origin !== 'generated';
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

/**
 * The Monero engine, behind `__MONERO_ENABLED__` exactly as the EVM engine is
 * behind `__EVM_ENABLED__` (the Monero engine design notes §13): `scripts/
 * build.mjs --monero` sets it, and a build without the flag carries no module
 * from src/services/chain/monero/ and no monero-ts at all. The barrel
 * (monero/index.ts) is this dynamic import's single target; vite.config.ts
 * fails a flagless build in which any monero/ module reaches a chunk.
 */
export async function loadMoneroModules(): Promise<typeof import('./monero') | null> {
  if (!__MONERO_ENABLED__) return null;
  return import('./monero');
}
