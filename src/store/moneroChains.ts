// Monero as the STORE and the UI see it (the Monero engine design, §8/§15 Set C).
//
// Exactly one row: Monero has no chain family of its own the way EVM does (no
// second/third Monero-shaped chain is coming), so this is a plain-data mirror
// of ONE fixed record, not a registry. It is loaded through loadMoneroModules()
// (the build flag), same discipline as evmChains.ts: a build without --monero
// gets `null` here, and every Monero affordance in the UI keys off that. This
// file itself is ALWAYS in the bundle (it has no monero/ import of its own — the
// module-id guard in vite.config.ts only forbids `monero/` reaching a chunk when
// the flag is off, and this file never reaches into that directory except
// through the flag-guarded dynamic import), so a plain build still contains this
// tiny mirror; it simply always resolves to null.
//
// Chain id for the switcher/picker: Monero gets ONE fixed target string,
// 'xmr:mainnet' (engine.ts's MONERO_NETWORK, duplicated here as a literal so
// this file needs no import from Set D — the two are asserted equal in tests
// on both sides). One string namespace with the UTXO ids and `evm:<key>`,
// exactly like the EVM prefix.

import { loadMoneroModules } from '../services/chain/engine';

/** The chain id used everywhere a Monero row is addressed: the switcher, the
 *  picker, and WalletEntry.network on a Monero WalletEntry (engine.ts
 *  MONERO_NETWORK). Fixed forever: Monero has no testnet/stagenet wallet in
 *  this UI (§11), so there is exactly one target. */
export const MONERO_TARGET = 'xmr:mainnet' as const;
export type MoneroChainTarget = typeof MONERO_TARGET;

export function isMoneroChainTarget(id: string | null | undefined): id is MoneroChainTarget {
  return id === MONERO_TARGET;
}

/** Monero as plain data, the shape every UI helper (describeChain and friends)
 *  reads. Deliberately NOT `EvmChainInfo`: almost no fields are shared (no
 *  chainId, no fee model, no tokens), so forcing one into the other's shape
 *  would just grow optional fields nothing else uses (design doc §11). */
export interface MoneroChainInfo {
  key: 'monero';
  displayName: 'Monero';
  nativeTicker: 'XMR';
  nativeDecimals: 12;
  /** The project's own site, shown under the name in the chain switcher. */
  homepage: string;
  /** '{txid}' replaced with the transaction hash. */
  explorerTxUrl: string;
  /** Gateway node-set names this build can pick from (§7); 'main' today. */
  nodeSets: readonly string[];
  defaultNodeSet: string;
  /** MONERO_RELEASE_HEIGHT (§6.6): the floor a restore height can never go
   *  below, since no Satori-derived key existed before this release. */
  releaseHeight: number;
  /** SLIP-44 coin type (128) and the BIP39-to-Monero scheme the engine ships
   *  ('cake-exodus'), for the Diagnostics readout: the UI must not import a
   *  value from monero/ itself, so the two facts travel on this row. */
  coinType: number;
  scheme: string;
  /** Never a thin/new-chain caution banner: Monero itself is not new. */
  young: false;
  /** Always "New" in the switcher: new to THIS wallet (§10). */
  recentlyAdded: true;
}

export const MONERO_HOMEPAGE = 'https://getmonero.org';
/** xmrchain.net is a public Monero block explorer that resolves a tx hash
 *  without an API key or account, matching how explorerTxUrl works for every
 *  other chain in this wallet. */
export const MONERO_EXPLORER_TX_URL = 'https://xmrchain.net/tx/{txid}';

/**
 * Monero as plain data, or null when this build has no Monero engine
 * (`__MONERO_ENABLED__` off) — same contract as loadEvmChainInfos(): the
 * dynamic import is the only place this file reaches into monero/, and it is
 * dropped from a plain build by the flag, not by a runtime check.
 *
 * releaseHeight/nodeSets are read from the engine's own modules rather than
 * duplicated here, so the one gateway-verified constant (§6.6, §7) has one
 * source: Set B's rpc.ts, re-exported through the monero/ barrel Set D owns.
 */
export async function loadMoneroChainInfo(): Promise<MoneroChainInfo | null> {
  const monero = await loadMoneroModules();
  if (!monero) return null;
  return {
    key: 'monero',
    displayName: 'Monero',
    nativeTicker: 'XMR',
    nativeDecimals: 12,
    homepage: MONERO_HOMEPAGE,
    explorerTxUrl: MONERO_EXPLORER_TX_URL,
    // v1 ships one gateway node set (§7); the shape is a list so the gateway
    // can expose more later (e.g. a stagenet set, §14 open question 6) with no
    // change on this side.
    nodeSets: ['main'],
    defaultNodeSet: 'main',
    releaseHeight: monero.MONERO_RELEASE_HEIGHT,
    coinType: monero.MONERO_COIN_TYPE,
    scheme: monero.MONERO_BIP39_SCHEME,
    young: false,
    recentlyAdded: true,
  };
}

/** Explorer link for a transaction hash, same helper shape as evmExplorerTxUrl. */
export function moneroExplorerTxUrl(chain: Pick<MoneroChainInfo, 'explorerTxUrl'>, txid: string): string {
  return chain.explorerTxUrl.replace('{txid}', txid);
}
