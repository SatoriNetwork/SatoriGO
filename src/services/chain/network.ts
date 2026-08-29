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
import { GATEWAY_CLIENT_TOKEN, GATEWAY_URL } from '../gateway';

export interface ElectrumEndpoint {
  host: string;
  /** Browser-usable secure WebSocket port. Verified: TLS handshake + a
   *  `websockets/12.0` server banner on 50004. */
  wssPort: number;
  /** Raw SSL/TCP port (desktop clients only; not reachable from an extension). */
  sslPort: number;
  network: EvrmoreNetwork['id'];
  /** FULL `wss://` URL, set ONLY on the Satori GO gateway bridge. The bridge
   *  lives at `wss://<gateway host>/electrum/<chainKey>`, i.e. behind a PATH,
   *  which `host` + `wssPort` cannot express, so electrumWssUrl() prefers this
   *  when it is present. Absent on every plain public node. */
  wssUrl?: string;
  /** WebSocket subprotocols to offer when opening the socket. Set ONLY on the
   *  gateway bridge. A plain ElectrumX node must be opened with NO subprotocol:
   *  a server that does not echo back a requested subprotocol makes the BROWSER
   *  fail the handshake, so offering one to a public node would break it. */
  protocols?: string[];
  /** True on the Satori GO gateway bridge row: Settings labels it as the
   *  gateway and refuses to remove it. */
  gateway?: boolean;
}

// ---------------------------------------------------------------------------
// The Satori GO gateway's Electrum bridge
//
// In a gateway build EVERY UTXO chain's Electrum traffic goes through the SAME
// host everything else shared goes through (prices, the EVM routes):
// `wss://<gateway host>/electrum/<chainKey>`. Inside that socket the wire
// format is exactly what ElectrumX speaks already (one JSON-RPC message per
// text frame), so nothing in the protocol layer changes: only the endpoint and
// the subprotocol pair below.
//
// The shape is the same on every chain that has a public pool (owner's
// decision, 2026-08-25): the BRIDGE FIRST, then that chain's public wss servers
// unchanged behind it. A gateway outage must never stop someone's Bitcoin, so
// the public pool is never dropped. Ravencoin is the ONE exception and it is
// deliberate: it has no acceptable public fallback at all (see the note on
// RVN_SATORI_NODE). A build with no gateway keeps every list exactly as it was.
//
// Auth is the WebSocket subprotocol list ['satori-v1', <clientToken>]: the
// server selects 'satori-v1' and reads the token from the second entry. The
// extension's Origin is accepted server-side too, but the pair is ALWAYS sent
// so Firefox (per-install moz-extension origin) and dev contexts behave the
// same as Chrome. The token is not a secret: the bundle is public.

/** The subprotocol the gateway selects. The token rides as a second entry. */
export const GATEWAY_ELECTRUM_PROTOCOL = 'satori-v1';

/** Chains reachable through the bridge, and their path segment. These are the
 *  SAME keys the gateway is configured with; adding a chain here without the
 *  matching gateway route just means the bridge attempt fails and the chain's
 *  public pool serves it, which is the designed fallback, not a breakage. */
export type GatewayElectrumChainKey = 'evr' | 'rvn' | 'btc' | 'ltc' | 'doge' | 'btgs' | 'wjk' | 'neox';
const GATEWAY_ELECTRUM_CHAIN_KEYS: readonly GatewayElectrumChainKey[] = [
  'evr',
  'rvn',
  'btc',
  'ltc',
  'doge',
  'btgs',
  'wjk',
  // 'neox' has carried an upstream since 2026-08-26; before that the route
  // simply refused, which the client handles as an unreachable server.
  'neox',
];

/** The bridge URL for a chain, '' when this build has no gateway. https -> wss
 *  (http -> ws, for a local gateway during development). */
export function gatewayElectrumUrl(
  chainKey: GatewayElectrumChainKey,
  gateway: string = GATEWAY_URL,
): string {
  const base = gateway.trim().replace(/\/+$/, '');
  if (!base) return '';
  return `${base.replace(/^http/i, 'ws')}/electrum/${chainKey}`;
}

/** The subprotocol pair offered to the bridge. An empty token is dropped rather
 *  than sent as an empty string, which browsers reject outright. */
export function gatewayElectrumProtocols(token: string = GATEWAY_CLIENT_TOKEN): string[] {
  const t = token.trim();
  return t ? [GATEWAY_ELECTRUM_PROTOCOL, t] : [GATEWAY_ELECTRUM_PROTOCOL];
}

/** The bridge endpoint for a chain, or null when this build has no gateway (a
 *  development build, which talks to the public nodes directly). */
export function gatewayElectrumEndpoint(
  chainKey: GatewayElectrumChainKey,
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint | null {
  const url = gatewayElectrumUrl(chainKey, gateway);
  if (!url) return null;
  const hostPort = gateway.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const colon = hostPort.indexOf(':');
  const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  // The gateway is https, so 443 unless it names a port. sslPort mirrors it:
  // the bridge has no raw-TCP Electrum port at all, and a made-up 50002 would
  // be a lie in the diagnostics readout.
  const port = colon === -1 ? 443 : Number(hostPort.slice(colon + 1)) || 443;
  return {
    host,
    wssPort: port,
    sslPort: port,
    network: 'mainnet',
    wssUrl: url,
    protocols: gatewayElectrumProtocols(token),
    gateway: true,
  };
}

/** Whether a persisted `wss://…` server URL is THIS build's gateway bridge (any
 *  chain). Used by Settings to label the row and refuse to remove it. */
export function isGatewayElectrumUrl(url: string, gateway: string = GATEWAY_URL): boolean {
  if (typeof url !== 'string') return false;
  const base = gateway.trim().replace(/\/+$/, '');
  if (!base) return false;
  const prefix = `${base.replace(/^http/i, 'ws')}/electrum/`.toLowerCase();
  return url.trim().toLowerCase().startsWith(prefix);
}

/** The bridge endpoint a `wss://…` URL denotes, or null when it is not one.
 *  Lets a pool round-tripped through the persisted URL-string list come back as
 *  a real bridge endpoint (subprotocols and all) instead of a host:port guess. */
function gatewayEndpointForUrl(
  url: string,
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint | null {
  const want = url.trim().replace(/\/+$/, '').toLowerCase();
  if (!want) return null;
  for (const key of GATEWAY_ELECTRUM_CHAIN_KEYS) {
    const ep = gatewayElectrumEndpoint(key, gateway, token);
    if (ep?.wssUrl && ep.wssUrl.toLowerCase() === want) return ep;
  }
  return null;
}

/** "Bridge first, the public pool unchanged behind it" — the one code path that
 *  produces both build shapes for a chain that keeps a public fallback pool.
 *  With no gateway configured it hands back the public list untouched, so a
 *  development build is bit-for-bit what it always was. */
function poolWithBridge(
  chainKey: GatewayElectrumChainKey,
  publicFallbacks: ElectrumEndpoint[],
  gateway: string,
  token: string,
): ElectrumEndpoint[] {
  const bridge = gatewayElectrumEndpoint(chainKey, gateway, token);
  return bridge ? [bridge, ...publicFallbacks] : publicFallbacks;
}

/** Evrmore ElectrumX servers exposing browser-usable wss:// (valid TLS cert).
 *  The client tries them IN ORDER and uses the first that connects, so the
 *  preferred entry is listed first: in a DEVELOPMENT build that is the
 *  Satori-operated node below, in a GATEWAY build it is the bridge (see
 *  buildEvrElectrumPool), with the public evrmorecoin.org nodes as fallback in
 *  both.
 *
 *  Probed live (browser-style TLS + real Electrum handshake):
 *   - electrumx1.satorinet.io:50004 — valid cert (CN/SAN electrumx1.satorinet.io),
 *     connected at mainnet block ~1,932,141.
 *   - electrum{1,2}-mainnet.evrmorecoin.org:50004 — `ElectrumX Evrmore 1.12`.
 *  (evrx-1.satoriog.com is NOT included: :50004 refuses connections and :50002
 *   still serves a self-signed cert the browser rejects — add it once it has a
 *   valid-cert wss endpoint.) */
const EVR_SATORI_NODE: ElectrumEndpoint = {
  host: 'electrumx1.satorinet.io', wssPort: 50004, sslPort: 50002, network: 'mainnet',
};
/** The public Evrmore pool. Stays in BOTH build shapes: a gateway outage must
 *  not brick EVR, it must only cost the wallet the owner's node. */
const EVR_PUBLIC_FALLBACKS: ElectrumEndpoint[] = [
  { host: 'electrum1-mainnet.evrmorecoin.org', wssPort: 50004, sslPort: 50002, network: 'mainnet' },
  { host: 'electrum2-mainnet.evrmorecoin.org', wssPort: 50004, sslPort: 50002, network: 'mainnet' },
];

/** The Evrmore pool for a given gateway configuration, most-preferred first.
 *
 *  GATEWAY BUILD: [bridge, evrmorecoin1, evrmorecoin2]. The owner's node
 *  (electrumx1.satorinet.io) is reached ONLY through the bridge, never as a
 *  direct host, so it is not listed separately; the two public evrmorecoin.org
 *  nodes stay as fallbacks.
 *  NO GATEWAY (development): unchanged, [satorinet, evrmorecoin1, evrmorecoin2].
 *
 *  Takes the gateway/token as arguments (defaulting to the build defines) so
 *  both shapes are testable without a rebuild, the same way gatewayHeaders()
 *  in services/gateway.ts does. */
export function buildEvrElectrumPool(
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint[] {
  const bridge = gatewayElectrumEndpoint('evr', gateway, token);
  return bridge ? [bridge, ...EVR_PUBLIC_FALLBACKS] : [EVR_SATORI_NODE, ...EVR_PUBLIC_FALLBACKS];
}

export const PUBLIC_ELECTRUM_SERVERS: ElectrumEndpoint[] = buildEvrElectrumPool();

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
const RVN_SATORI_NODE: ElectrumEndpoint = {
  host: 'rvnx.satorinet.io', wssPort: 443, sslPort: 50002, network: 'mainnet',
};

/** The Ravencoin pool for a given gateway configuration.
 *
 *  GATEWAY BUILD: [bridge] and nothing else. That single entry is deliberate
 *  and is NOT an oversight to be "fixed" by adding a public node: the note on
 *  RVN_SATORI_NODE above explains why there is no acceptable public Ravencoin
 *  fallback (every generic public RVN ElectrumX runs PLAIN upstream ElectrumX,
 *  which rejects the asset dialect this wallet depends on). Ravencoin through
 *  the gateway therefore has NO fallback by design: a gateway outage takes RVN
 *  offline rather than silently breaking asset balances.
 *  NO GATEWAY (development): unchanged, the owner's node direct. */
export function buildRvnElectrumPool(
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint[] {
  const bridge = gatewayElectrumEndpoint('rvn', gateway, token);
  return bridge ? [bridge] : [RVN_SATORI_NODE];
}

export const PUBLIC_RVN_ELECTRUM_SERVERS: ElectrumEndpoint[] = buildRvnElectrumPool();

/** Bitcoin Gold (BTGS) ElectrumX servers exposing browser-usable wss:// (valid
 *  TLS cert). Sourced from the project's official coins repo (BTGSCOINDEV/coins,
 *  electrums/BTGS) and verified live (browser-style TLS + real Electrum
 *  handshake) 2026-08-13: both run Fulcrum 2.1.0, protocol 1.4-1.6, and both
 *  report genesis 0000000d1c5a497963a46c0348cb4346779c52d9e1d7cc8b5efb1be0a4a0f964
 *  (matches BITCOINGOLD_MAINNET in chainParams.ts). sslPort 50002 is the
 *  operator's own raw-TLS port and is correct as listed. No preference order
 *  implied between the two; the client tries them in order and uses the first
 *  that connects. In a GATEWAY build they sit behind the bridge (see
 *  buildBtgsElectrumPool); the list itself is unchanged in both shapes. */
const BTGS_PUBLIC_FALLBACKS: ElectrumEndpoint[] = [
  { host: 'electrum.bitcoingold.site', wssPort: 50005, sslPort: 50002, network: 'mainnet' },
  { host: 'electrum.btgscoin.site', wssPort: 50005, sslPort: 50002, network: 'mainnet' },
];

/** The Bitcoin Gold pool: [bridge, ...public] in a gateway build, the public
 *  list alone in a development build. */
export function buildBtgsElectrumPool(
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint[] {
  return poolWithBridge('btgs', BTGS_PUBLIC_FALLBACKS, gateway, token);
}

export const PUBLIC_BTGS_ELECTRUM_SERVERS: ElectrumEndpoint[] = buildBtgsElectrumPool();

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
 *  the two; the client tries them in order and uses the first that connects.
 *  In a GATEWAY build they sit behind the bridge (see buildLtcElectrumPool);
 *  the list itself is unchanged in both shapes.
 *
 *  sslPort CORRECTED 2026-08-25 (50002 -> 20063), verified live from the
 *  gateway VM with a real TLS `server.version` handshake: ElectrumX 2.0.0 at
 *  tip 3,166,195. cipig's port scheme is 10xxx PLAIN TCP / 20xxx TLS / 30xxx
 *  WebSocket, and 50002 is not open on these hosts at all (connection
 *  refused). Nothing was visibly broken by the old value because the wallet
 *  only ever opens the wss port; the field was simply untrue, and it is the
 *  number a human reads out of the diagnostics. */
const LTC_PUBLIC_FALLBACKS: ElectrumEndpoint[] = [
  { host: 'ltc.electrum1.cipig.net', wssPort: 30063, sslPort: 20063, network: 'mainnet' },
  { host: 'ltc.electrum2.cipig.net', wssPort: 30063, sslPort: 20063, network: 'mainnet' },
];

/** The Litecoin pool: [bridge, ...public] in a gateway build, the public list
 *  alone in a development build. */
export function buildLtcElectrumPool(
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint[] {
  return poolWithBridge('ltc', LTC_PUBLIC_FALLBACKS, gateway, token);
}

export const PUBLIC_LTC_ELECTRUM_SERVERS: ElectrumEndpoint[] = buildLtcElectrumPool();

/** WojakCoin (WJK) ElectrumX servers. Probed live (browser-style TLS + real
 *  Electrum handshake) 2026-08-13: both answered ElectrumX 1.16.0, protocol max
 *  1.4.2, and both report genesis
 *  000000004536a4f8fa9d88f0001ca9f9825f8d9fd3ba6383a2f030c0427bf085 at tip
 *  177,012 (matches WOJAKCOIN_MAINNET in chainParams.ts). Plain (upstream)
 *  ElectrumX with no asset dialect (WojakCoin has no asset protocol at all —
 *  see supportsAssets() in chainParams.ts), same "plain is correct here" logic
 *  as the BTGS/LTC pools above. Source: the project's own coins repo,
 *  BTGSCOINDEV/coins, electrums/WJK. NOTE the two hosts use DIFFERENT wss
 *  ports (50104 vs 50003) — that is correct, not a typo. Their sslPorts
 *  (50102 / 50002) differ for the same reason and were re-confirmed correct on
 *  2026-08-25. No preference order implied between the two; the client tries
 *  them in order and uses the first that connects. In a GATEWAY build they sit
 *  behind the bridge (see buildWjkElectrumPool); the list itself is unchanged
 *  in both shapes.
 *
 *  THE GATEWAY'S ADDRESS IS RATE-LIMITED BY THIS OPERATOR, AND THAT IS NOT A
 *  PROPERTY OF EITHER HOST. Both hosts answer a browser perfectly well (probed
 *  over their real wss ports on 2026-08-28: tip 187,005 from both). From INSIDE
 *  the gateway container the answer to a plain `server.version` is
 *  `{"code":-101,"message":"excessive resource usage"}`, ElectrumX's per-source
 *  cost limit, applied before the session has done anything at all.
 *
 *  It moves, and it expires. Measured the same afternoon: electrum2 refused
 *  while electrum1 answered, so the gateway's list was cut to electrum1 and the
 *  bridge went healthy for a few minutes; twenty minutes later BOTH refused.
 *  Reading the first measurement as "electrum2 is the broken one" was wrong,
 *  and it was committed before the second measurement disproved it.
 *
 *  WHY IT HITS THE GATEWAY AND NOT USERS. The bridge is the whole point and
 *  also the cause: every wallet reaches this chain from ONE address, so a small
 *  public ElectrumX sees a single IP behaving like a crowd, which is exactly
 *  what a per-source limit exists to stop. A user on the public fallback below
 *  connects from their own address and never trips it, which is why WojakCoin
 *  works in the wallet while its bridge is down.
 *
 *  BOTH HOSTS ARE LISTED IN BOTH PLACES, in the gateway config and here. Two
 *  upstreams give the bridge two chances of finding one that is not currently
 *  penalised; one gives it none. Until that changes the fallback carries the
 *  chain, which is why WojakCoin works in the wallet while its bridge does not.
 *
 *  THE OWNER IS STANDING UP HIS OWN WJK NODE (2026-08-28), which ends this
 *  properly: our own node behind the gateway, the way Evrmore and Ravencoin
 *  already work, and no third party's per-source limit in the path. It goes in
 *  as a `wjk` upstream once it has finished syncing. When it does, probe it the
 *  way Neoxa's was and from BOTH vantage points (scripts/electrumx-probe.ts,
 *  and the same probe from inside the gateway container): the genesis check has
 *  a recorded value for this chain now, so a server that is not WojakCoin fails
 *  it rather than looking healthy. The public hosts below stay as the fallback
 *  either way. The operator has also been asked to raise the limit, which would
 *  restore the bridge in the meantime.
 *
 *  There is no third server to add. The WJK network advertises exactly one peer
 *  (electrum1, via server.peers.subscribe); electrum2 is not even peer-listed;
 *  no electrum3/4/electrumx hostname resolves under wojakcoin.cash; and the
 *  public KomodoPlatform coins repository carries no WJK entry. */
const WJK_PUBLIC_FALLBACKS: ElectrumEndpoint[] = [
  { host: 'electrum1.wojakcoin.cash', wssPort: 50104, sslPort: 50102, network: 'mainnet' },
  { host: 'electrum2.wojakcoin.cash', wssPort: 50003, sslPort: 50002, network: 'mainnet' },
];

/** The WojakCoin pool: [bridge, ...public] in a gateway build, the public list
 *  alone in a development build. */
export function buildWjkElectrumPool(
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint[] {
  return poolWithBridge('wjk', WJK_PUBLIC_FALLBACKS, gateway, token);
}

export const PUBLIC_WJK_ELECTRUM_SERVERS: ElectrumEndpoint[] = buildWjkElectrumPool();

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
 *  tries them in order and uses the first that connects. In a GATEWAY build
 *  they sit behind the bridge (see buildBtcElectrumPool); the list itself is
 *  unchanged in both shapes.
 *
 *  sslPort CORRECTED 2026-08-25 (10000 -> 20000), verified live from the
 *  gateway VM with a real TLS `server.version` handshake: ElectrumX 2.0.0 at
 *  tip 964,002. cipig's port scheme is 10xxx PLAIN TCP / 20xxx TLS / 30xxx
 *  WebSocket, so 10000 is the PLAINTEXT port: a TLS handshake against it fails
 *  with ERR_SSL_WRONG_VERSION_NUMBER. Nothing was visibly broken by the old
 *  value because the wallet only ever opens the wss port; the field was simply
 *  untrue, and it is the number a human reads out of the diagnostics. */
const BTC_PUBLIC_FALLBACKS: ElectrumEndpoint[] = [
  { host: 'btc.electrum1.cipig.net', wssPort: 30000, sslPort: 20000, network: 'mainnet' },
  { host: 'btc.electrum2.cipig.net', wssPort: 30000, sslPort: 20000, network: 'mainnet' },
];

/** The Bitcoin pool: [bridge, ...public] in a gateway build, the public list
 *  alone in a development build. A gateway outage must never stop someone's
 *  Bitcoin, which is exactly why the two cipig hosts stay listed behind it. */
export function buildBtcElectrumPool(
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint[] {
  return poolWithBridge('btc', BTC_PUBLIC_FALLBACKS, gateway, token);
}

export const PUBLIC_BTC_ELECTRUM_SERVERS: ElectrumEndpoint[] = buildBtcElectrumPool();

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
 *  and uses the first that connects. In a GATEWAY build they sit behind the
 *  bridge (see buildDogeElectrumPool); the list itself is unchanged in both
 *  shapes. */
const DOGE_PUBLIC_FALLBACKS: ElectrumEndpoint[] = [
  // sslPort 20060 verified live 2026-08-15 (TLS + server.version handshake) and
  // re-confirmed 2026-08-25; 10060 is the PLAINTEXT tcp port on this operator,
  // not SSL. This one was already right when the BTC and LTC values next to it
  // were not.
  { host: 'doge.electrum1.cipig.net', wssPort: 30060, sslPort: 20060, network: 'mainnet' },
  { host: 'doge.electrum2.cipig.net', wssPort: 30060, sslPort: 20060, network: 'mainnet' },
];

/** The Dogecoin pool: [bridge, ...public] in a gateway build, the public list
 *  alone in a development build. */
export function buildDogeElectrumPool(
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint[] {
  return poolWithBridge('doge', DOGE_PUBLIC_FALLBACKS, gateway, token);
}

export const PUBLIC_DOGE_ELECTRUM_SERVERS: ElectrumEndpoint[] = buildDogeElectrumPool();

/** Neoxa (NEOX) ElectrumX. Wired EXACTLY like Ravencoin: the gateway bridge and
 *  nothing else, with the owner's own node behind it. That node is being stood up
 *  by the owner; until its address reaches the gateway config the bridge route
 *  answers 404 and this chain simply has no reachable server. That is the same
 *  state any chain is in when its server is down, and it is handled by the same
 *  code path rather than by anything Neoxa-specific.
 *
 *  *** SINGLE DIALECT. DO NOT ADD A PUBLIC NODE HERE. ***
 *  This is the warning that sits above RVN_SATORI_NODE, and it applies to Neoxa
 *  for the same reason and with the same force. Neoxa carries the RAVENCOIN ASSET
 *  PROTOCOL: OP_NEOX_ASSET is 0xc0 and its on-wire markers are literally
 *  "rvnt"/"rvnq"/"rvnr"/"rvno" (assets.h renamed the macros and kept Ravencoin's
 *  byte values; see the NEOXA header block in chainParams.ts). So this wallet
 *  needs an ASSET-AWARE ElectrumX here. A plain (upstream) ElectrumX would answer
 *  server.version perfectly happily and then THROW on every asset call
 *  (get_balance(sh, asset), listunspent(sh, true), asset.get_meta), so dropping
 *  one in as a "fallback" would not fail loudly: it would let a mid-failover
 *  reconnect land on a server that silently breaks asset balances and history.
 *  Neoxa through the gateway therefore has NO fallback BY DESIGN, exactly like
 *  Ravencoin: a gateway outage takes the chain offline rather than reporting
 *  wrong asset data.
 *
 *  ALSO NOT A PLACE FOR A GUESS. Nothing may be listed here that has not been
 *  probed live. Two specific traps for whoever revisits this (both checked
 *  2026-08-25):
 *   - `electrum.neoxa.net` RESOLVES (128.140.14.2) and is NOT an Electrum server:
 *     a 42-port sweep found only 22 and 53 open, i.e. it is their DNS seeder.
 *   - `neox.electrum{1,2}.cipig.net` ANSWER `ElectrumX 2.0.0` and are BITCOIN.
 *     `*.cipig.net` is a DNS wildcard (zzzz-not-a-coin.electrum1.cipig.net
 *     resolves to the same host) and the server there reports genesis
 *     000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f. cipig
 *     does not run Neoxa.
 *
 *  VERIFYING A NODE: check server.features.genesis_hash against
 *  0000000a50fdaaf22f1c98b8c61559e15ab2269249aa1fb20683180703cdbf07, and do NOT
 *  try to derive it with sha256d of blockchain.block.header(0) the way the
 *  LTC/BTC/DOGE checks do. Neoxa's block id is a PoW hash (X16R before nTime
 *  1651444217, KawPoW after) over a header that changes length at that time, so
 *  sha256d of the header is not the block hash on this chain. Then confirm the
 *  dialect: blockchain.asset.get_meta must ANSWER, not error.
 *
 *  LIVE SINCE 2026-08-26, on a node the owner was given rather than one he runs.
 *  The gateway's `neox` row is 88.99.30.253:50011 (plain TCP), and every check
 *  above was run against it live with scripts/electrumx-probe.ts before it was
 *  wired, then repeated THROUGH the public bridge afterwards (tip 2,233,350,
 *  genesis matching, an asset-scoped get_balance answered, 327 ms for four
 *  round trips):
 *    server.version    "ElectrumX Ravencoin 1.12", protocol 1.4
 *    genesis_hash      0000000a50fd…cdbf07  <- Neoxa's, so not the cipig trap
 *    tip               2,233,323
 *    relayfee/estimatefee, scripthash get_balance / get_history / listunspent
 *    the ASSET-SCOPED forms get_balance(sh, asset) and listunspent(sh, asset)
 *    blockchain.asset.get_meta ANSWERED (returned {}), so the dialect is there
 *    blockchain.transaction.get is served
 *  It is usable. It is also THIRD-PARTY and IT HAS NO TLS PORT AT ALL, which was
 *  established three independent ways rather than assumed (2026-08-26):
 *    - a port sweep of 50000-50100 plus the usual alternates found exactly two
 *      open ports on the host, 50011 and 443;
 *    - 443 is not Electrum. It is an HTTPS app (Let's Encrypt certificate,
 *      CN assets.neoxa.net, the name itself behind Cloudflare); an Electrum
 *      handshake there times out and no WebSocket answers on /, /ws, /electrum,
 *      /electrumx or /wss;
 *    - the server publishes `hosts: {}` and `services: []` in server.features,
 *      i.e. its own operator advertises no hostname and no SSL port.
 *  So the gateway's hop to it is plaintext ACROSS THE INTERNET. Its `evr` and
 *  `rvn` rows are plaintext too, but those upstreams sit on the operator's own
 *  LAN, where the traffic never leaves the private network; this is the first
 *  row where it does. Whoever sits on that path cannot forge a signature and
 *  cannot make this wallet accept a bad broadcast (liveWallet compares the
 *  answer to the txid it computed itself), but they can
 *  lie about a balance or a history, and with no fallback (above) there is
 *  nothing to cross-check it against. Ask whoever runs it for an SSL port. */
const NEOX_PUBLIC_FALLBACKS: ElectrumEndpoint[] = [];

/** The Neoxa pool for a given gateway configuration.
 *
 *  GATEWAY BUILD: [bridge] and nothing else, the Ravencoin shape. That single
 *  entry is deliberate and is NOT an oversight to be "fixed" by adding a public
 *  node: read the single-dialect warning above first.
 *  NO GATEWAY (development): EMPTY, because the owner's node has no published
 *  address yet. The day it has one, a development build can list it directly here
 *  the way RVN_SATORI_NODE is listed, and a release build needs no change at all:
 *  it already goes through the bridge.
 *
 *  IF THE BRIDGE LOSES ITS UPSTREAM the gateway refuses /electrum/neox and the
 *  WebSocket handshake fails. Nothing special happens: the Electrum client
 *  exhausts this one-entry pool exactly as it would for a chain whose only server
 *  is down, reports not-connected, and the UI shows its usual offline state. No
 *  crash and no false "connected". Pinned in electrumClient.test.ts, and it is
 *  the state this chain was in for its first day. */
export function buildNeoxElectrumPool(
  gateway: string = GATEWAY_URL,
  token: string = GATEWAY_CLIENT_TOKEN,
): ElectrumEndpoint[] {
  const bridge = gatewayElectrumEndpoint('neox', gateway, token);
  return bridge ? [bridge] : NEOX_PUBLIC_FALLBACKS;
}

export const PUBLIC_NEOX_ELECTRUM_SERVERS: ElectrumEndpoint[] = buildNeoxElectrumPool();

/** The URL a client opens for an endpoint. The gateway bridge carries its own
 *  full URL (it lives behind a path); every plain node is `host:port`. */
export function electrumWssUrl(endpoint: ElectrumEndpoint): string {
  return endpoint.wssUrl ?? `wss://${endpoint.host}:${endpoint.wssPort}`;
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
//
// NEOXA IS THE THIRD ASSET-DIALECT CHAIN, and it is wired like Ravencoin, not
// like the five plain ones. It carries the Ravencoin asset protocol (see the
// NEOXA header in chainParams.ts), so the bridge-only, no-public-fallback shape
// is the SAME decision made for the same reason: a plain node would answer
// server.version and then throw on every asset call, so a "fallback" would break
// asset data silently instead of failing. Its pool holds the bridge alone, and
// while the gateway has no Neoxa upstream configured that bridge is simply an
// unreachable server. The one thing a future reader must not do is treat an
// empty-looking pool as an invitation to drop in "some Neoxa-ish node": if it is
// not asset-aware ElectrumX for Neoxa specifically, it does not go here. The
// live traps found while searching are listed above the NEOX pool.
//
// THE GATEWAY BRIDGE DOES NOT BLEND ANY OF THIS. It is chain-scoped by PATH:
// `/electrum/evr`, `/electrum/rvn`, `/electrum/btc`, `/electrum/ltc`,
// `/electrum/doge`, `/electrum/btgs`, `/electrum/wjk` are seven different
// upstreams behind one host, and each pool only ever gets its own. A Bitcoin
// wallet failing over from the bridge lands on btc.electrum{1,2}.cipig.net, not
// on some other chain's node. The single-dialect rules above are unchanged: the
// bridge is one more entry at the head of a chain's own pool, never a shared
// endpoint that several chains dip into.

/** Storage key holding the user's EVRMORE server pool as `wss://host:port`
 *  strings. Kept as the bare 'electrumServers' for BACKWARD COMPATIBILITY with
 *  existing installs (pre-multichain, Evrmore-only). Ravencoin, Bitcoin Gold
 *  and Litecoin each use their own suffixed key (see
 *  electrumServersStorageKey). */
export const ELECTRUM_SERVERS_STORAGE_KEY = 'electrumServers';

/** Canonical per-chain pool key: 'evrmore' (mainnet + testnet share the same
 *  server-role pool), 'ravencoin-mainnet', 'bitcoingold-mainnet',
 *  'litecoin-mainnet', 'wojakcoin-mainnet', 'bitcoin-mainnet',
 *  'dogecoin-mainnet' or 'neoxa-mainnet'. Ambient default = Evrmore. */
type PoolKey =
  | 'evrmore'
  | 'ravencoin-mainnet'
  | 'bitcoingold-mainnet'
  | 'litecoin-mainnet'
  | 'wojakcoin-mainnet'
  | 'bitcoin-mainnet'
  | 'dogecoin-mainnet'
  // Neoxa's own key is a safety requirement rather than tidiness: without it
  // poolKey() would fall through to 'evrmore' and a Neoxa client would silently
  // be handed the EVRMORE server pool — a different chain, on asset-aware
  // servers whose responses have the same SHAPE as Neoxa's would, so the
  // mistake would not announce itself. See the NEOX pool block above.
  | 'neoxa-mainnet';
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
  if (resolved === 'neoxa-mainnet') return 'neoxa-mainnet';
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
  if (key === 'neoxa-mainnet') return `${ELECTRUM_SERVERS_STORAGE_KEY}:neoxa-mainnet`;
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
/** The built-in default NEOXA pool as `wss://host:port` URL strings (UI/reset).
 *  EMPTY, like the pool it is derived from: no Neoxa ElectrumX server exists. */
export const DEFAULT_NEOX_ELECTRUM_SERVER_URLS: string[] = PUBLIC_NEOX_ELECTRUM_SERVERS.map(electrumWssUrl);

/** Built-in default endpoints for a chain (Evrmore vs Ravencoin vs Bitcoin Gold
 *  vs Litecoin vs WojakCoin vs Bitcoin vs Dogecoin). */
function defaultPoolFor(key: PoolKey): ElectrumEndpoint[] {
  if (key === 'ravencoin-mainnet') return PUBLIC_RVN_ELECTRUM_SERVERS;
  if (key === 'bitcoingold-mainnet') return PUBLIC_BTGS_ELECTRUM_SERVERS;
  if (key === 'litecoin-mainnet') return PUBLIC_LTC_ELECTRUM_SERVERS;
  if (key === 'wojakcoin-mainnet') return PUBLIC_WJK_ELECTRUM_SERVERS;
  if (key === 'bitcoin-mainnet') return PUBLIC_BTC_ELECTRUM_SERVERS;
  if (key === 'dogecoin-mainnet') return PUBLIC_DOGE_ELECTRUM_SERVERS;
  if (key === 'neoxa-mainnet') return PUBLIC_NEOX_ELECTRUM_SERVERS;
  return PUBLIC_ELECTRUM_SERVERS;
}

/** The built-in default pool URLs for a chain (UI/reset). */
export function defaultServerUrlsFor(chainId?: string): string[] {
  return defaultPoolFor(poolKey(chainId)).map(electrumWssUrl);
}

/** The gateway bridge chain key a pool key maps to. EVERY UTXO chain has one
 *  since 2026-08-25; the difference between them is only what sits BEHIND the
 *  bridge (a public pool everywhere except Ravencoin). Exhaustive over PoolKey
 *  by construction: the compiler flags a new pool key that lands in no branch
 *  because the function would then return a key for a chain it should not.
 *  Returns null only in a build with no gateway, which gatewayElectrumEndpoint
 *  handles anyway. */
function bridgeKeyFor(key: PoolKey): GatewayElectrumChainKey {
  switch (key) {
    case 'ravencoin-mainnet':
      return 'rvn';
    case 'bitcoingold-mainnet':
      return 'btgs';
    case 'litecoin-mainnet':
      return 'ltc';
    case 'wojakcoin-mainnet':
      return 'wjk';
    case 'bitcoin-mainnet':
      return 'btc';
    case 'dogecoin-mainnet':
      return 'doge';
    case 'neoxa-mainnet':
      return 'neox';
    case 'evrmore':
      return 'evr';
  }
}

/** The gateway bridge is a REQUIRED member of every UTXO chain's pool, so it is
 *  prepended to any list that lacks it. That is what makes "non-removable" true
 *  for pools that predate this build as well: a user who edited their Evrmore
 *  (or Bitcoin, or Litecoin…) servers before the bridge existed has a stored
 *  list without it, and without this their wallet would keep talking to the
 *  public nodes directly forever. Custom servers they added are kept, after it.
 *  A build with no gateway is untouched. */
export function withGatewayBridge(
  endpoints: ElectrumEndpoint[],
  chainId?: string,
): ElectrumEndpoint[] {
  const bridge = gatewayElectrumEndpoint(bridgeKeyFor(poolKey(chainId)));
  if (!bridge) return endpoints;
  const rest = endpoints.filter((ep) => !isGatewayElectrumUrl(electrumWssUrl(ep)));
  return [bridge, ...rest];
}

/** withGatewayBridge on the `wss://…` URL list Settings and storage speak. */
export function withGatewayBridgeUrls(urls: string[], chainId?: string): string[] {
  const bridge = gatewayElectrumUrl(bridgeKeyFor(poolKey(chainId)));
  if (!bridge) return urls;
  return [bridge, ...urls.filter((u) => !isGatewayElectrumUrl(u))];
}

/** Active user-configured pool PER CHAIN (absent key = fall back to that chain's
 *  built-in defaults). */
const activeServersByChain = new Map<PoolKey, ElectrumEndpoint[]>();

/** Set the active pool for a chain (default Evrmore). Passing null (or an empty
 *  array) restores that chain's defaults.
 *
 *  THE single chokepoint for the runtime pool (the store, the background
 *  worker's applyStoredElectrumServers and the tests all land here), so the
 *  gateway bridge is re-asserted at its head from exactly one place. */
export function setElectrumServers(
  endpoints: ElectrumEndpoint[] | null,
  chainId?: string,
): void {
  const key = poolKey(chainId);
  if (endpoints && endpoints.length > 0) {
    activeServersByChain.set(key, withGatewayBridge(endpoints, key));
  } else activeServersByChain.delete(key);
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

/** Serialize an endpoint back to the URL a client opens (bridge URL included,
 *  so a pool survives the round-trip through the persisted string list). */
export function serverToUrl(ep: ElectrumEndpoint): string {
  return electrumWssUrl(ep);
}

/** Parse a user-typed server into an ElectrumEndpoint, or null if unparseable.
 *  Accepts `wss://host:port`, `host:port`, or a bare `host` (an optional
 *  `wss://`/`ws://` prefix and a trailing slash are stripped). The wss port
 *  defaults to 50004; the host must be a plausible dot-separated hostname. */
export function parseServerUrl(input: string): ElectrumEndpoint | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  // The gateway bridge is a URL WITH A PATH, which the host:port form below
  // cannot express (it strips the path). Recognise it FIRST and hand back the
  // real bridge endpoint, subprotocols and all.
  const bridge = gatewayEndpointForUrl(s);
  if (bridge) return bridge;
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
