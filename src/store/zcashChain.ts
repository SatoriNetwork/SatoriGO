// Zcash as the STORE and the UI see it (docs/design/zcash-engine.md, §8/§15
// Set C). Mirrors moneroChains.ts in shape: a plain-data row every
// chain-scoped UI helper (describeChain and friends, Set D territory) reads.
//
// UNLIKE moneroChains.ts, this is not behind a build flag (§13: "no build
// flag ... a static import like a UTXO chain"), so there is no
// loadZcashChainInfo() / async mirror to keep in sync — ZCASH_CHAIN is a
// plain constant, always present, in every build.
//
// Chain id: ONE fixed target string, 'zec:mainnet' (engine.ts's
// ZCASH_NETWORK, duplicated here as a literal so this file needs no import
// from Set D — the two are asserted equal once engine.ts exists; see the
// note in zcashChain.test.ts). One string namespace with the UTXO ids,
// `evm:<key>` and `xmr:mainnet`.

/** The chain id used everywhere a Zcash row is addressed: the switcher, the
 *  picker, and WalletEntry.network on a Zcash WalletEntry (engine.ts
 *  ZCASH_NETWORK, FIXED DECISIONS: target 'zec:mainnet'). Fixed forever:
 *  Zcash has no testnet wallet in this UI (§11), so there is exactly one
 *  target. */
export const ZCASH_TARGET = 'zec:mainnet' as const;
export type ZcashChainTarget = typeof ZCASH_TARGET;

export function isZcashChainTarget(id: string | null | undefined): id is ZcashChainTarget {
  return id === ZCASH_TARGET;
}

/** Zcash as plain data, the shape every UI helper (describeChain and
 *  friends) reads. Deliberately its own shape rather than EvmChainInfo or
 *  MoneroChainInfo (design §11): transparent-only Zcash has no fee-market
 *  model and no locked/unlocked split, and forcing it into either existing
 *  shape would just grow optional fields nothing else uses. */
export interface ZcashChainInfo {
  key: 'zcash';
  displayName: 'Zcash';
  nativeTicker: 'ZEC';
  nativeDecimals: 8;
  /** The project's own site, shown under the name in the chain switcher. */
  homepage: string;
  /** '{txid}' replaced with the transaction hash (display-order hex, §5). */
  explorerTxUrl: string;
  /** Gateway node-set names this build can pick from (§7); 'main' today. */
  nodeSets: readonly string[];
  defaultNodeSet: string;
  /** Never a thin/new-chain caution banner: Zcash itself is not new. */
  young: false;
  /** Always "New" in the switcher: new to THIS wallet (§10). */
  recentlyAdded: true;
}

export const ZCASH_HOMEPAGE = 'https://z.cash';

/** mainnet.zcashexplorer.app, the community explorer the design settled on
 *  (§14 open question 4). Path verified 2026-09-28 (HTTP 200, real txids
 *  linked at exactly this pattern: /transactions/{txid}). */
export const ZCASH_EXPLORER_TX_URL = 'https://mainnet.zcashexplorer.app/transactions/{txid}';

/**
 * Zcash as plain data. Unlike loadMoneroChainInfo() this is NOT async and
 * NOT gated by a build flag or engine load — Zcash has neither (§13) — so a
 * single frozen constant is both the "loader" and the row every chain
 * dispatch table reads. Exported as a function too (zcashChainInfo()) for
 * call-site symmetry with the other chains' accessors; both answer the same
 * object.
 */
export const ZCASH_CHAIN: ZcashChainInfo = Object.freeze({
  key: 'zcash',
  displayName: 'Zcash',
  nativeTicker: 'ZEC',
  nativeDecimals: 8,
  homepage: ZCASH_HOMEPAGE,
  explorerTxUrl: ZCASH_EXPLORER_TX_URL,
  // v1 ships one gateway node set (§7); the shape is a list so the gateway
  // can expose more later with no change on this side.
  nodeSets: ['main'],
  defaultNodeSet: 'main',
  young: false,
  recentlyAdded: true,
});

export function zcashChainInfo(): ZcashChainInfo {
  return ZCASH_CHAIN;
}

/** Explorer link for a transaction id, same helper shape as
 *  moneroExplorerTxUrl / evmExplorerTxUrl. `txid` must already be
 *  display-order lowercase hex (Set A's zcashTxid / Set B's gateway answers
 *  it that way, §5, §7). */
export function zcashExplorerTxUrl(txid: string, chain: Pick<ZcashChainInfo, 'explorerTxUrl'> = ZCASH_CHAIN): string {
  return chain.explorerTxUrl.replace('{txid}', txid);
}
