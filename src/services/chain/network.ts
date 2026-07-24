// Live Evrmore network configuration: ElectrumX server pool and the SATORI
// asset registry. Every value here was verified against the live chain /
// official sources. This module is
// the config the future ElectrumWalletDataProvider consumes; it does not open
// any connection by itself.

import {
  EVRMORE_MAINNET,
  EVRMORE_TESTNET,
  networkFor,
  type ChainId,
  type EvrmoreNetwork,
} from './chainParams';
import { getStorage } from '../storage';

export interface ElectrumEndpoint {
  host: string;
  /** Browser-usable secure WebSocket port. Verified: TLS handshake + a
   *  `websockets/12.0` server banner on 50004. */
  wssPort: number;
  /** Raw SSL/TCP port (desktop clients only; not reachable from an extension). */
  sslPort: number;
  network: EvrmoreNetwork['id'];
}

/** Evrmore ElectrumX servers exposing browser-usable wss:// (valid TLS cert).
 *  The client tries them IN ORDER and uses the first that connects, so the
 *  Satori-operated node is listed first ("pinned" as preferred) with the public
 *  evrmorecoin.org nodes as fallback.
 *
 *  Probed live (browser-style TLS + real Electrum handshake):
 *   - electrumx1.satorinet.io:50004 — valid cert (CN/SAN electrumx1.satorinet.io),
 *     connected at mainnet block ~1,932,141.
 *   - electrum{1,2}-mainnet.evrmorecoin.org:50004 — `ElectrumX Evrmore 1.12`.
 *  (evrx-1.satoriog.com is NOT included: :50004 refuses connections and :50002
 *   still serves a self-signed cert the browser rejects — add it once it has a
 *   valid-cert wss endpoint.) */
export const PUBLIC_ELECTRUM_SERVERS: ElectrumEndpoint[] = [
  { host: 'electrumx1.satorinet.io', wssPort: 50004, sslPort: 50002, network: 'mainnet' },
  { host: 'electrum1-mainnet.evrmorecoin.org', wssPort: 50004, sslPort: 50002, network: 'mainnet' },
  { host: 'electrum2-mainnet.evrmorecoin.org', wssPort: 50004, sslPort: 50002, network: 'mainnet' },
];

/** Ravencoin ElectrumX servers exposing browser-usable wss:// (valid TLS cert).
 *  EXACTLY ONE endpoint: the owner's pending self-hosted, Cloudflare-fronted node
 *  on port 443 (rvnx.satorinet.io). It is being deployed by the owner.
 *
 *  DO NOT add cipig (electrum{1,2,3}.cipig.net) or any generic public Ravencoin
 *  ElectrumX as an RVN fallback: cipig runs PLAIN (upstream) ElectrumX which
 *  REJECTS the Evrmore/Ravencoin asset dialect (get_balance(sh, asset),
 *  listunspent(sh, true), asset.get_meta). Mixing a plain node into this failover
 *  pool would let a mid-failover reconnect land on a server that throws on every
 *  asset call, silently breaking asset balances/history. Verified by live probe
 *  2026-07-15 and 2026-07-21: cipig answers server.version but errors the asset
 *  methods. The pool must stay single-dialect. */
export const PUBLIC_RVN_ELECTRUM_SERVERS: ElectrumEndpoint[] = [
  { host: 'rvnx.satorinet.io', wssPort: 443, sslPort: 50002, network: 'mainnet' },
];

export function electrumWssUrl(endpoint: ElectrumEndpoint): string {
  return `wss://${endpoint.host}:${endpoint.wssPort}`;
}

// ---------------------------------------------------------------------------
// User-managed Electrum server pool (PER CHAIN)
//
// PUBLIC_ELECTRUM_SERVERS (Evrmore) / PUBLIC_RVN_ELECTRUM_SERVERS (Ravencoin) are
// the built-in defaults. The user may override a chain's pool (add/edit/remove/
// reset) in Settings → Network; those choices are persisted as `wss://host:port`
// strings under a chain-keyed storage key and applied to the per-chain module
// pool via applyStoredElectrumServers(chainId). The Electrum client reads
// getElectrumServerPool(chainId) lazily AT CONNECT TIME, so a change here is
// honoured on the next (re)connect without a page reload.
//
// The pool is keyed by chain (not by ambient "active chain" state) so the
// BACKGROUND worker can poll a MIX of Evrmore and Ravencoin wallets concurrently
// with a separate client per chain, each resolving its own pool. The two chains'
// ElectrumX servers speak the SAME asset dialect but are DIFFERENT hosts, and
// their pools must never be blended (see PUBLIC_RVN_ELECTRUM_SERVERS).

/** Storage key holding the user's EVRMORE server pool as `wss://host:port`
 *  strings. Kept as the bare 'electrumServers' for BACKWARD COMPATIBILITY with
 *  existing installs (pre-multichain, Evrmore-only). Ravencoin uses a suffixed
 *  key (see electrumServersStorageKey). */
export const ELECTRUM_SERVERS_STORAGE_KEY = 'electrumServers';

/** Canonical per-chain pool key: 'evrmore' (mainnet + testnet share the same
 *  server-role pool) or 'ravencoin-mainnet'. Ambient default = Evrmore. */
type PoolKey = 'evrmore' | 'ravencoin-mainnet';
function poolKey(chainId?: string): PoolKey {
  if (!chainId) return 'evrmore';
  // networkFor falls back to Evrmore mainnet for any unrecognised id, so an
  // arbitrary string safely resolves to the Evrmore pool.
  return networkFor(chainId as ChainId).chainId === 'ravencoin-mainnet'
    ? 'ravencoin-mainnet'
    : 'evrmore';
}

/** Storage key for a chain's user server pool. Evrmore keeps the legacy bare key
 *  ('electrumServers'); Ravencoin is suffixed ('electrumServers:ravencoin-mainnet'). */
export function electrumServersStorageKey(chainId?: string): string {
  return poolKey(chainId) === 'ravencoin-mainnet'
    ? `${ELECTRUM_SERVERS_STORAGE_KEY}:ravencoin-mainnet`
    : ELECTRUM_SERVERS_STORAGE_KEY;
}

/** The built-in default EVRMORE pool as `wss://host:port` URL strings (UI/reset). */
export const DEFAULT_ELECTRUM_SERVER_URLS: string[] = PUBLIC_ELECTRUM_SERVERS.map(electrumWssUrl);
/** The built-in default RAVENCOIN pool as `wss://host:port` URL strings (UI/reset). */
export const DEFAULT_RVN_ELECTRUM_SERVER_URLS: string[] = PUBLIC_RVN_ELECTRUM_SERVERS.map(electrumWssUrl);

/** Built-in default endpoints for a chain (Evrmore vs Ravencoin). */
function defaultPoolFor(key: PoolKey): ElectrumEndpoint[] {
  return key === 'ravencoin-mainnet' ? PUBLIC_RVN_ELECTRUM_SERVERS : PUBLIC_ELECTRUM_SERVERS;
}

/** The built-in default pool URLs for a chain (UI/reset). */
export function defaultServerUrlsFor(chainId?: string): string[] {
  return defaultPoolFor(poolKey(chainId)).map(electrumWssUrl);
}

/** Active user-configured pool PER CHAIN (absent key = fall back to that chain's
 *  built-in defaults). */
const activeServersByChain = new Map<PoolKey, ElectrumEndpoint[]>();

/** Set the active pool for a chain (default Evrmore). Passing null (or an empty
 *  array) restores that chain's defaults. */
export function setElectrumServers(
  endpoints: ElectrumEndpoint[] | null,
  chainId?: string,
): void {
  const key = poolKey(chainId);
  if (endpoints && endpoints.length > 0) activeServersByChain.set(key, endpoints);
  else activeServersByChain.delete(key);
}

/** The pool a chain's client should try, in order: the user's pool when
 *  configured, otherwise that chain's built-in defaults (default Evrmore). */
export function getElectrumServerPool(
  chainId?: string,
): ElectrumEndpoint[] {
  const key = poolKey(chainId);
  const active = activeServersByChain.get(key);
  return active && active.length > 0 ? active : defaultPoolFor(key);
}

/** Serialize an endpoint back to its `wss://host:port` URL. */
export function serverToUrl(ep: ElectrumEndpoint): string {
  return `wss://${ep.host}:${ep.wssPort}`;
}

/** Parse a user-typed server into an ElectrumEndpoint, or null if unparseable.
 *  Accepts `wss://host:port`, `host:port`, or a bare `host` (an optional
 *  `wss://`/`ws://` prefix and a trailing slash are stripped). The wss port
 *  defaults to 50004; the host must be a plausible dot-separated hostname. */
export function parseServerUrl(input: string): ElectrumEndpoint | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  // Strip an optional ws://|wss:// scheme and any trailing path/slash.
  s = s.replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
  if (!s) return null;

  let host = s;
  let port = 50004;
  const colon = s.indexOf(':');
  if (colon !== -1) {
    host = s.slice(0, colon);
    const portStr = s.slice(colon + 1);
    if (!/^\d+$/.test(portStr)) return null;
    port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }

  // Plausible hostname: dot-separated labels of [A-Za-z0-9-], each 1-63 chars,
  // not starting or ending with a hyphen (rejects spaces, empty labels, etc.).
  const label = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
  if (!new RegExp(`^${label}(?:\\.${label})*$`).test(host)) return null;

  return { host, wssPort: port, sslPort: 50002, network: 'mainnet' };
}

/** Load a CHAIN's persisted server pool from storage and make it active. Reads
 *  that chain's stored string[] (wss URLs), parses each, and sets the pool (null →
 *  defaults when none are valid). Default chain = Evrmore (legacy key). Best-effort:
 *  storage may be absent. */
export async function applyStoredElectrumServers(
  chainId?: string,
): Promise<void> {
  try {
    const urls = await getStorage().get<string[]>(electrumServersStorageKey(chainId));
    if (!Array.isArray(urls)) {
      setElectrumServers(null, chainId);
      return;
    }
    const parsed = urls
      .filter((u): u is string => typeof u === 'string')
      .map(parseServerUrl)
      .filter((ep): ep is ElectrumEndpoint => ep !== null);
    setElectrumServers(parsed.length > 0 ? parsed : null, chainId);
  } catch {
    // storage unavailable (jsdom/tests) — keep the current pool.
  }
}

// ---------------------------------------------------------------------------
// Assets

export interface EvrmoreAsset {
  /** EXACT on-chain name (case-sensitive, UPPERCASE). Confirmed via
   *  blockchain.asset.get_meta on the live chain. */
  name: string;
  /** Decimal places ("divisions" in Evrmore). */
  decimals: number;
  reissuable: boolean;
}

// blockchain.asset.get_meta("SATORI") -> divisions 8, reissuable true,
// sats_in_circulation 103389600000000. The name "SATOREVR" returned {} (does
// not exist) — the Satori Network token on Evrmore is named "SATORI".
export const SATORI_ASSET: EvrmoreAsset = {
  name: 'SATORI',
  decimals: 8,
  reissuable: true,
};

// ---------------------------------------------------------------------------
// Electrum protocol method names (Evrmore ElectrumX fork)

export const ELECTRUM_METHODS = {
  version: 'server.version',
  features: 'server.features',
  headersSubscribe: 'blockchain.headers.subscribe',
  estimateFee: 'blockchain.estimatefee',
  // EVR + asset balance / history / utxos by scripthash — VERIFIED live.
  // RESOLVED: the Evrmore fork has NO separate get_asset_balance. Instead
  // get_balance / listunspent take a second `asset` argument (session.py
  // scripthash_get_balance(scripthash, asset=False)):
  //   get_balance(sh)          -> EVR only  {confirmed, unconfirmed}
  //   get_balance(sh, "SATORI")-> that asset {confirmed, unconfirmed} (in sats)
  //   get_balance(sh, true)    -> dict of ALL balances keyed by asset (None=EVR)
  getBalance: 'blockchain.scripthash.get_balance',
  getHistory: 'blockchain.scripthash.get_history',
  listUnspent: 'blockchain.scripthash.listunspent',
  // Asset metadata — VERIFIED live.
  assetGetMeta: 'blockchain.asset.get_meta',
  // Transaction get / broadcast.
  txGet: 'blockchain.transaction.get',
  txBroadcast: 'blockchain.transaction.broadcast',
} as const;

/** Second arg to get_balance/listunspent to fetch a specific asset's balance. */
export function assetBalanceParam(assetName: string): string {
  return assetName;
}

export const LIVE_NETWORKS = { mainnet: EVRMORE_MAINNET, testnet: EVRMORE_TESTNET };
