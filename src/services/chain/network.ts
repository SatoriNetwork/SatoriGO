// Live Evrmore network configuration: ElectrumX server pool and the SATORI
// asset registry. Every value here was verified against the live chain /
// official sources. This module is
// the config the future ElectrumWalletDataProvider consumes; it does not open
// any connection by itself.

import {
  CHAIN_FEE_POLICIES,
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

/** Bitcoin Gold (BTGS) ElectrumX servers exposing browser-usable wss:// (valid
 *  TLS cert). Sourced from the project's official coins repo (BTGSCOINDEV/coins,
 *  electrums/BTGS) and verified live (browser-style TLS + real Electrum
 *  handshake) 2026-08-13: both run Fulcrum 2.1.0, protocol 1.4-1.6, and both
 *  report genesis 0000000d1c5a497963a46c0348cb4346779c52d9e1d7cc8b5efb1be0a4a0f964
 *  (matches BITCOINGOLD_MAINNET in chainParams.ts). No preference order implied
 *  between the two; the client tries them in order and uses the first that
 *  connects. */
export const PUBLIC_BTGS_ELECTRUM_SERVERS: ElectrumEndpoint[] = [
  { host: 'electrum.bitcoingold.site', wssPort: 50005, sslPort: 50002, network: 'mainnet' },
  { host: 'electrum.btgscoin.site', wssPort: 50005, sslPort: 50002, network: 'mainnet' },
];

/** Litecoin (LTC) ElectrumX servers. Probed live (browser-style TLS + real
 *  Electrum handshake) 2026-08-14: both run ElectrumX 2.0.0, negotiate
 *  protocol 1.6, answer blockchain.scripthash.get_balance, and both report
 *  genesis 12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2
 *  (verified by sha256d of blockchain.block.header(0) — Litecoin mainnet) at
 *  tip 3,160,025. Plain (upstream) ElectrumX with no asset dialect: see the
 *  note above electrumServersStorageKey() for why that is CORRECT for
 *  Litecoin, unlike Ravencoin.
 *
 *  ltc.electrum3.cipig.net:30063 was listed here but FAILS the WebSocket
 *  handshake (re-confirmed dead in the same 2026-08-14 probe), which left
 *  Litecoin with a single working host — one outage from offline. It was
 *  replaced with its verified sibling ltc.electrum2.cipig.net; do not re-add
 *  electrum3 without a fresh live probe. No preference order implied between
 *  the two; the client tries them in order and uses the first that connects. */
export const PUBLIC_LTC_ELECTRUM_SERVERS: ElectrumEndpoint[] = [
  { host: 'ltc.electrum1.cipig.net', wssPort: 30063, sslPort: 50002, network: 'mainnet' },
  { host: 'ltc.electrum2.cipig.net', wssPort: 30063, sslPort: 50002, network: 'mainnet' },
];

/** WojakCoin (WJK) ElectrumX servers. Probed live (browser-style TLS + real
 *  Electrum handshake) 2026-08-13: both answered ElectrumX 1.16.0, protocol max
 *  1.4.2, and both report genesis
 *  000000004536a4f8fa9d88f0001ca9f9825f8d9fd3ba6383a2f030c0427bf085 at tip
 *  177,012 (matches WOJAKCOIN_MAINNET in chainParams.ts). Plain (upstream)
 *  ElectrumX with no asset dialect (WojakCoin has no asset protocol at all —
 *  see supportsAssets() in chainParams.ts), same "plain is correct here" logic
 *  as the BTGS/LTC pools above. Source: the project's own coins repo,
 *  BTGSCOINDEV/coins, electrums/WJK. NOTE the two hosts use DIFFERENT wss
 *  ports (50104 vs 50003) — that is correct, not a typo. No preference order
 *  implied between the two; the client tries them in order and uses the first
 *  that connects. */
export const PUBLIC_WJK_ELECTRUM_SERVERS: ElectrumEndpoint[] = [
  { host: 'electrum1.wojakcoin.cash', wssPort: 50104, sslPort: 50102, network: 'mainnet' },
  { host: 'electrum2.wojakcoin.cash', wssPort: 50003, sslPort: 50002, network: 'mainnet' },
];

/** Bitcoin (BTC) ElectrumX servers. Probed live (browser-style TLS + real
 *  Electrum handshake) 2026-08-14: both answered ElectrumX 2.0.0, protocol max
 *  1.4.2, and both report genesis
 *  000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f (the REAL
 *  Bitcoin mainnet genesis) at tip 962,405. Plain (upstream) ElectrumX with no
 *  asset dialect -- Bitcoin has no asset protocol at all, same "plain is
 *  correct here" logic as the BTGS/LTC/WJK pools above. Source: the project's
 *  own coins repo, KomodoPlatform/coins, electrums/BTC.
 *
 *  SAME OPERATOR AS LITECOIN: these are cipig hosts, like
 *  PUBLIC_LTC_ELECTRUM_SERVERS above -- see the "PLAIN ElectrumX vs the asset
 *  dialect" note further down for why that is fine here (Bitcoin has no asset
 *  dialect to blend with) but must never be read as license to blend the BTC
 *  and LTC pools themselves: they are different chains with different
 *  genesis hashes, kept in separate exports/keys like every other chain here.
 *
 *  A THIRD cipig host, btc.electrum3.cipig.net:30000, did NOT respond when
 *  probed and is deliberately NOT included -- only hosts actually verified
 *  live are listed. No preference order implied between the two; the client
 *  tries them in order and uses the first that connects. */
export const PUBLIC_BTC_ELECTRUM_SERVERS: ElectrumEndpoint[] = [
  { host: 'btc.electrum1.cipig.net', wssPort: 30000, sslPort: 10000, network: 'mainnet' },
  { host: 'btc.electrum2.cipig.net', wssPort: 30000, sslPort: 10000, network: 'mainnet' },
];

/** Dogecoin (DOGE) ElectrumX servers. Probed live (browser-style TLS + real
 *  Electrum handshake) 2026-08-14 and re-probed 2026-08-15: both answered
 *  ElectrumX 2.0.0, negotiated protocol 1.6, and both report genesis
 *  1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691 (the REAL
 *  Dogecoin mainnet genesis, matching DOGECOIN_MAINNET in chainParams.ts) —
 *  verified BOTH from server.features AND by sha256d of
 *  blockchain.block.header(0) — at tip 6,333,464. Plain (upstream) ElectrumX
 *  with no asset dialect (blockchain.asset.get_meta -> "unknown method") —
 *  correct for Dogecoin, which has no asset protocol; same "plain is correct
 *  here" logic as the BTGS/LTC/WJK/BTC pools above.
 *
 *  SAME OPERATOR AS LITECOIN AND BITCOIN (cipig) — and the same rule: fine for
 *  an asset-free chain, never a license to blend pools. A THIRD cipig host,
 *  doge.electrum3.cipig.net:30060, FAILED the WebSocket handshake in BOTH
 *  probes and is deliberately NOT included — only hosts actually verified live
 *  are listed; do not add it back without a fresh probe.
 *
 *  FEE WARNING for this pool (full analysis in CHAIN_FEE_POLICIES): these
 *  servers do NOT implement blockchain.relayfee, and their 6/25-block
 *  estimatefee answers sit BELOW Dogecoin's own 1000 sat/byte fee floor, so the
 *  fee floor must always come from the chain params, never from these hosts.
 *  No preference order implied between the two; the client tries them in order
 *  and uses the first that connects. */
export const PUBLIC_DOGE_ELECTRUM_SERVERS: ElectrumEndpoint[] = [
  // sslPort 20060 verified live 2026-08-15 (TLS + server.version handshake);
  // 10060 is the PLAINTEXT tcp port on this operator, not SSL.
  { host: 'doge.electrum1.cipig.net', wssPort: 30060, sslPort: 20060, network: 'mainnet' },
  { host: 'doge.electrum2.cipig.net', wssPort: 30060, sslPort: 20060, network: 'mainnet' },
];

export function electrumWssUrl(endpoint: ElectrumEndpoint): string {
  return `wss://${endpoint.host}:${endpoint.wssPort}`;
}

// ---------------------------------------------------------------------------
// User-managed Electrum server pool (PER CHAIN)
//
// PUBLIC_ELECTRUM_SERVERS (Evrmore) / PUBLIC_RVN_ELECTRUM_SERVERS (Ravencoin) /
// PUBLIC_BTGS_ELECTRUM_SERVERS (Bitcoin Gold) / PUBLIC_LTC_ELECTRUM_SERVERS
// (Litecoin) / PUBLIC_WJK_ELECTRUM_SERVERS (WojakCoin) / PUBLIC_BTC_ELECTRUM_SERVERS
// (Bitcoin) / PUBLIC_DOGE_ELECTRUM_SERVERS (Dogecoin) are the built-in defaults. The user may override a chain's pool
// (add/edit/remove/reset) in Settings → Network; those choices are persisted
// as `wss://host:port` strings under a chain-keyed storage key and applied to
// the per-chain module pool via applyStoredElectrumServers(chainId). The
// Electrum client reads getElectrumServerPool(chainId) lazily AT CONNECT TIME,
// so a change here is honoured on the next (re)connect without a page reload.
//
// The pool is keyed by chain (not by ambient "active chain" state) so the
// BACKGROUND worker can poll a MIX of Evrmore, Ravencoin, Bitcoin Gold,
// Litecoin, WojakCoin, Bitcoin and Dogecoin wallets concurrently with a
// separate client per chain, each resolving its own pool. Evrmore and
// Ravencoin ElectrumX servers speak the SAME asset dialect but are DIFFERENT
// hosts, and their pools must never be blended (see
// PUBLIC_RVN_ELECTRUM_SERVERS). Bitcoin Gold, Litecoin, WojakCoin, Bitcoin and
// Dogecoin are a STRICTER case, not just further instances of the same rule:
// all five are PLAIN Bitcoin-style ElectrumX chains with NO asset protocol at
// all (no get_balance(sh,asset), no listunspent(sh,true), no
// blockchain.asset.get_meta, see supportsAssets() in chainParams.ts), so a
// mid-failover reconnect landing a BTGS/LTC/WJK/BTC/DOGE wallet on an
// Evrmore/Ravencoin host (or vice versa) wouldn't just answer with the wrong
// chain's data, it would 404/error-out entirely on protocol-level method
// mismatches, or worse, silently misinterpret a same-shaped response from the
// wrong chain. The BTGS, LTC, WJK, BTC and DOGE pools must stay just as
// single-dialect and unblended as the Ravencoin one.
//
// PLAIN ElectrumX vs the asset dialect: do not "fix" one chain by breaking the
// other. cipig (ltc.electrum{1,2}.cipig.net, PUBLIC_LTC_ELECTRUM_SERVERS; also
// btc.electrum{1,2}.cipig.net, PUBLIC_BTC_ELECTRUM_SERVERS, and
// doge.electrum{1,2}.cipig.net, PUBLIC_DOGE_ELECTRUM_SERVERS) runs PLAIN
// (upstream) ElectrumX. That is EXACTLY CORRECT for Litecoin, Bitcoin and
// Dogecoin, because none of them has an asset protocol at all: there is no
// dialect to reject. It remains WRONG for Ravencoin (see the warning on
// PUBLIC_RVN_ELECTRUM_SERVERS above): cipig's Ravencoin/Evrmore listings speak
// the same plain dialect and REJECT the asset calls (get_balance(sh, asset),
// listunspent(sh, true), asset.get_meta) that Ravencoin/Evrmore wallets depend
// on. Same operator, same server software, opposite correctness verdict
// depending on the chain's asset support: a future reader must not read
// "cipig is banned" as a blanket rule and strip it from the Litecoin/Bitcoin
// pools, nor read "cipig works for Litecoin/Bitcoin" and add it back to the
// Ravencoin pool. Litecoin and Bitcoin being the SAME operator does not mean
// their pools may ever be blended with EACH OTHER either -- different chains,
// different genesis hashes, separate exports and separate storage keys, same
// as every other chain here. WojakCoin's electrum{1,2}.wojakcoin.cash
// (PUBLIC_WJK_ELECTRUM_SERVERS) is likewise plain ElectrumX, which is correct
// for the same no-asset-protocol reason, on yet another operator entirely.

/** Storage key holding the user's EVRMORE server pool as `wss://host:port`
 *  strings. Kept as the bare 'electrumServers' for BACKWARD COMPATIBILITY with
 *  existing installs (pre-multichain, Evrmore-only). Ravencoin, Bitcoin Gold
 *  and Litecoin each use their own suffixed key (see
 *  electrumServersStorageKey). */
export const ELECTRUM_SERVERS_STORAGE_KEY = 'electrumServers';

/** Canonical per-chain pool key: 'evrmore' (mainnet + testnet share the same
 *  server-role pool), 'ravencoin-mainnet', 'bitcoingold-mainnet',
 *  'litecoin-mainnet', 'wojakcoin-mainnet', 'bitcoin-mainnet' or
 *  'dogecoin-mainnet'. Ambient default = Evrmore. */
type PoolKey =
  | 'evrmore'
  | 'ravencoin-mainnet'
  | 'bitcoingold-mainnet'
  | 'litecoin-mainnet'
  | 'wojakcoin-mainnet'
  | 'bitcoin-mainnet'
  | 'dogecoin-mainnet';
function poolKey(chainId?: string): PoolKey {
  if (!chainId) return 'evrmore';
  // networkFor falls back to Evrmore mainnet for any unrecognised id, so an
  // arbitrary string safely resolves to the Evrmore pool.
  const resolved = networkFor(chainId as ChainId).chainId;
  if (resolved === 'ravencoin-mainnet') return 'ravencoin-mainnet';
  if (resolved === 'bitcoingold-mainnet') return 'bitcoingold-mainnet';
  if (resolved === 'litecoin-mainnet') return 'litecoin-mainnet';
  if (resolved === 'wojakcoin-mainnet') return 'wojakcoin-mainnet';
  if (resolved === 'bitcoin-mainnet') return 'bitcoin-mainnet';
  if (resolved === 'dogecoin-mainnet') return 'dogecoin-mainnet';
  return 'evrmore';
}

/** Storage key for a chain's user server pool. Evrmore keeps the legacy bare key
 *  ('electrumServers'); Ravencoin ('electrumServers:ravencoin-mainnet'), Bitcoin
 *  Gold ('electrumServers:bitcoingold-mainnet'), Litecoin
 *  ('electrumServers:litecoin-mainnet'), WojakCoin
 *  ('electrumServers:wojakcoin-mainnet'), Bitcoin
 *  ('electrumServers:bitcoin-mainnet') and Dogecoin
 *  ('electrumServers:dogecoin-mainnet') are each suffixed with their own
 *  chainId, so a user's saved pool for one chain never leaks into another's. */
export function electrumServersStorageKey(chainId?: string): string {
  const key = poolKey(chainId);
  if (key === 'ravencoin-mainnet') return `${ELECTRUM_SERVERS_STORAGE_KEY}:ravencoin-mainnet`;
  if (key === 'bitcoingold-mainnet') return `${ELECTRUM_SERVERS_STORAGE_KEY}:bitcoingold-mainnet`;
  if (key === 'litecoin-mainnet') return `${ELECTRUM_SERVERS_STORAGE_KEY}:litecoin-mainnet`;
  if (key === 'wojakcoin-mainnet') return `${ELECTRUM_SERVERS_STORAGE_KEY}:wojakcoin-mainnet`;
  if (key === 'bitcoin-mainnet') return `${ELECTRUM_SERVERS_STORAGE_KEY}:bitcoin-mainnet`;
  if (key === 'dogecoin-mainnet') return `${ELECTRUM_SERVERS_STORAGE_KEY}:dogecoin-mainnet`;
  return ELECTRUM_SERVERS_STORAGE_KEY;
}

/** The built-in default EVRMORE pool as `wss://host:port` URL strings (UI/reset). */
export const DEFAULT_ELECTRUM_SERVER_URLS: string[] = PUBLIC_ELECTRUM_SERVERS.map(electrumWssUrl);
/** The built-in default RAVENCOIN pool as `wss://host:port` URL strings (UI/reset). */
export const DEFAULT_RVN_ELECTRUM_SERVER_URLS: string[] = PUBLIC_RVN_ELECTRUM_SERVERS.map(electrumWssUrl);
/** The built-in default BITCOIN GOLD pool as `wss://host:port` URL strings (UI/reset). */
export const DEFAULT_BTGS_ELECTRUM_SERVER_URLS: string[] = PUBLIC_BTGS_ELECTRUM_SERVERS.map(electrumWssUrl);
/** The built-in default LITECOIN pool as `wss://host:port` URL strings (UI/reset). */
export const DEFAULT_LTC_ELECTRUM_SERVER_URLS: string[] = PUBLIC_LTC_ELECTRUM_SERVERS.map(electrumWssUrl);
/** The built-in default WOJAKCOIN pool as `wss://host:port` URL strings (UI/reset). */
export const DEFAULT_WJK_ELECTRUM_SERVER_URLS: string[] = PUBLIC_WJK_ELECTRUM_SERVERS.map(electrumWssUrl);
/** The built-in default BITCOIN pool as `wss://host:port` URL strings (UI/reset). */
export const DEFAULT_BTC_ELECTRUM_SERVER_URLS: string[] = PUBLIC_BTC_ELECTRUM_SERVERS.map(electrumWssUrl);
/** The built-in default DOGECOIN pool as `wss://host:port` URL strings (UI/reset). */
export const DEFAULT_DOGE_ELECTRUM_SERVER_URLS: string[] = PUBLIC_DOGE_ELECTRUM_SERVERS.map(electrumWssUrl);

/** Built-in default endpoints for a chain (Evrmore vs Ravencoin vs Bitcoin Gold
 *  vs Litecoin vs WojakCoin vs Bitcoin vs Dogecoin). */
function defaultPoolFor(key: PoolKey): ElectrumEndpoint[] {
  if (key === 'ravencoin-mainnet') return PUBLIC_RVN_ELECTRUM_SERVERS;
  if (key === 'bitcoingold-mainnet') return PUBLIC_BTGS_ELECTRUM_SERVERS;
  if (key === 'litecoin-mainnet') return PUBLIC_LTC_ELECTRUM_SERVERS;
  if (key === 'wojakcoin-mainnet') return PUBLIC_WJK_ELECTRUM_SERVERS;
  if (key === 'bitcoin-mainnet') return PUBLIC_BTC_ELECTRUM_SERVERS;
  if (key === 'dogecoin-mainnet') return PUBLIC_DOGE_ELECTRUM_SERVERS;
  return PUBLIC_ELECTRUM_SERVERS;
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

/**
 * Load and activate the persisted server pool of EVERY supported chain.
 *
 * The chain set is derived from CHAIN_FEE_POLICIES — a Record over ChainId that
 * the compiler keeps exhaustive (a new chain cannot be added without a fee
 * policy) — NEVER from a hand-maintained call list. The background worker used
 * to apply exactly two chains by name, and that list silently went stale when
 * four chains were added: their deposit polls and dApp reads kept hitting the
 * built-in default servers while the user's deliberately configured server was
 * ignored. Deriving the set here makes forgetting a future chain impossible.
 *
 * (Evrmore mainnet and testnet share one pool key, so that pool is applied
 * twice — harmless: the same stored value is read and set both times.)
 */
export async function applyAllStoredElectrumServers(): Promise<void> {
  await Promise.all(
    (Object.keys(CHAIN_FEE_POLICIES) as ChainId[]).map((id) => applyStoredElectrumServers(id)),
  );
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
