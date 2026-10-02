// Bittensor as the STORE and the UI see it (the Bittensor engine design,
// docs/design/bittensor-engine.md §8/§15 Set C).
//
// Exactly one row, mirroring moneroChains.ts in shape: Bittensor has no
// second/third Substrate-family chain in this wallet yet (§8: "A second
// Substrate chain would add a profile, not an engine"), so this is a
// plain-data mirror of ONE fixed record, not a registry.
//
// UNLIKE moneroChains.ts, there is NO build flag and NO async loader (design
// §13, "No build flag": pure TS, one existing host, no worker, no CSP
// change — a static import like a UTXO chain). So this file, and everything
// it exports, is available synchronously and unconditionally.
//
// Chain id for the switcher/picker: Bittensor gets ONE fixed target string,
// 'tao:mainnet' (engine.ts's TAO_NETWORK, duplicated here as a literal so this
// file needs no import from Set D — the two are asserted equal in tests on
// both sides, the same discipline moneroChains.ts uses for MONERO_TARGET).

/** The chain id used everywhere a Bittensor row is addressed: the switcher,
 *  the picker, and WalletEntry.network on a Bittensor WalletEntry (engine.ts
 *  TAO_NETWORK, §8 table). Fixed forever in v1: no testnet wallet in this UI
 *  (§11 "Testnet: the `test` node set exists on the gateway for the smoke; no
 *  testnet wallet in the UI"). */
export const TAO_TARGET = 'tao:mainnet' as const;
export type TaoChainTarget = typeof TAO_TARGET;

export function isTaoChainTarget(id: string | null | undefined): id is TaoChainTarget {
  return id === TAO_TARGET;
}

/** Bittensor as plain data, the shape every UI helper (describeChain and
 *  friends) reads. Deliberately its own shape rather than EvmChainInfo or
 *  MoneroChainInfo (design §11: "A second Substrate chain would add a
 *  profile, not an engine" — this row names the FAMILY's one chain, not the
 *  family's mechanics, which live in services/chain/substrate/tao.ts,
 *  Set A). Field names and literal types match §15 Set C exactly. */
export interface TaoChainInfo {
  key: 'bittensor';
  displayName: 'Bittensor';
  nativeTicker: 'TAO';
  nativeDecimals: 9;
  /** The project's own site, shown under the name in the chain switcher. */
  homepage: string;
  /** '{txid}' replaced with the extrinsic hash. Candidate from design §6,
   *  NOT YET independently confirmed to resolve a real extrinsic page (the
   *  page is a client-rendered SPA; a plain fetch answers 200 for any path,
   *  proving nothing). Design §12.3 step 4 defers the final check to the
   *  owner's funded send ("the explorer link resolves — this settles the URL
   *  question of §6"); until then this is the documented candidate, with the
   *  account-page fallback (explorerAccountUrl) always usable regardless. */
  explorerTxUrl: string;
  /** '{address}' replaced with the SS58 address. This is the v1 "history"
   *  surface per the owner's 2026-09-28 OVERRIDE (design §1): no Taostats
   *  fetch in the wallet, only local sends plus this per-address link to
   *  taostats.io for full history. */
  explorerAccountUrl: string;
  /** Gateway node-set names this build can pick from (design §7); 'main'
   *  today, 'test' exists on the gateway for the smoke only (§11). */
  nodeSets: readonly string[];
  defaultNodeSet: string;
  /** Never a thin/new-chain caution banner: Bittensor itself is not new. */
  young: false;
  /** Always "New" in the switcher: new to THIS wallet (§10). */
  recentlyAdded: true;
}

export const TAO_HOMEPAGE = 'https://bittensor.com';

/** Candidate extrinsic explorer template (design §6). See the field doc on
 *  TaoChainInfo.explorerTxUrl for the verification caveat. */
export const TAO_EXPLORER_TX_URL = 'https://taostats.io/extrinsic/{txid}';

/** Account/history page: always resolves (it is the v1 Activity fallback
 *  itself, design §1 OVERRIDE and §6), independent of the extrinsic template
 *  above. */
export const TAO_EXPLORER_ACCOUNT_URL = 'https://taostats.io/account/{address}';

/** Bittensor as plain data. Unlike loadMoneroChainInfo, this is synchronous
 *  and never null: there is no build flag to gate it behind (design §13). */
export const TAO_CHAIN: TaoChainInfo = {
  key: 'bittensor',
  displayName: 'Bittensor',
  nativeTicker: 'TAO',
  nativeDecimals: 9,
  homepage: TAO_HOMEPAGE,
  explorerTxUrl: TAO_EXPLORER_TX_URL,
  explorerAccountUrl: TAO_EXPLORER_ACCOUNT_URL,
  // v1 ships one gateway node set (design §7); 'test' exists on the gateway
  // but is never offered in this UI (§11), so it is deliberately left out of
  // this list rather than merely unselected.
  nodeSets: ['main'],
  defaultNodeSet: 'main',
  young: false,
  recentlyAdded: true,
};

/** Explorer link for an extrinsic hash, same helper shape as
 *  moneroExplorerTxUrl/evmExplorerTxUrl. */
export function taoExplorerTxUrl(hash: string): string {
  return TAO_CHAIN.explorerTxUrl.replace('{txid}', hash);
}

/** Explorer link for an SS58 address: the "Full history on taostats.io" link
 *  the owner's OVERRIDE asks for on Activity (design §1), and used on the
 *  Receive screen here since this Set does not own any chain-agnostic
 *  Activity screen to wire it into directly (see the Set C report). */
export function taoExplorerAccountUrl(address: string): string {
  return TAO_CHAIN.explorerAccountUrl.replace('{address}', address);
}
