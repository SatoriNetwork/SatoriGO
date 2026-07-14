// Live Evrmore network configuration: ElectrumX server pool and the SATORI
// asset registry. Every value here was verified against the live chain /
// official sources. This module is
// the config the future ElectrumWalletDataProvider consumes; it does not open
// any connection by itself.

import { EVRMORE_MAINNET, EVRMORE_TESTNET, type EvrmoreNetwork } from './chainParams';
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

export function electrumWssUrl(endpoint: ElectrumEndpoint): string {
  return `wss://${endpoint.host}:${endpoint.wssPort}`;
}

// ---------------------------------------------------------------------------
// User-managed Electrum server pool
//
// PUBLIC_ELECTRUM_SERVERS above are the built-in defaults. The user may override
// the pool (add/edit/remove/reset) in Settings → Network; those choices are
// persisted as `wss://host:port` strings under the `electrumServers` storage
// key and applied to this module-level pool via applyStoredElectrumServers().
// The Electrum client reads getElectrumServerPool() lazily AT CONNECT TIME, so a
// change here is honoured on the next (re)connect without a page reload.

/** Storage key holding the user's server pool as `wss://host:port` strings. */
export const ELECTRUM_SERVERS_STORAGE_KEY = 'electrumServers';

/** The built-in default pool as `wss://host:port` URL strings (for the UI/reset). */
export const DEFAULT_ELECTRUM_SERVER_URLS: string[] = PUBLIC_ELECTRUM_SERVERS.map(electrumWssUrl);

/** Active user-configured pool (null = fall back to PUBLIC_ELECTRUM_SERVERS). */
let activeServers: ElectrumEndpoint[] | null = null;

/** Set the active pool. Passing null (or an empty array) restores the defaults. */
export function setElectrumServers(endpoints: ElectrumEndpoint[] | null): void {
  activeServers = endpoints && endpoints.length > 0 ? endpoints : null;
}

/** The pool the client should try, in order: the user's pool when configured,
 *  otherwise the built-in PUBLIC_ELECTRUM_SERVERS defaults. */
export function getElectrumServerPool(): ElectrumEndpoint[] {
  return activeServers && activeServers.length > 0 ? activeServers : PUBLIC_ELECTRUM_SERVERS;
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

/** Load the user's persisted server pool from storage and make it active. Reads
 *  the `electrumServers` string[] (wss URLs), parses each, and sets the pool
 *  (null → defaults when none are valid). Best-effort: storage may be absent. */
export async function applyStoredElectrumServers(): Promise<void> {
  try {
    const urls = await getStorage().get<string[]>(ELECTRUM_SERVERS_STORAGE_KEY);
    if (!Array.isArray(urls)) {
      setElectrumServers(null);
      return;
    }
    const parsed = urls
      .filter((u): u is string => typeof u === 'string')
      .map(parseServerUrl)
      .filter((ep): ep is ElectrumEndpoint => ep !== null);
    setElectrumServers(parsed.length > 0 ? parsed : null);
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
