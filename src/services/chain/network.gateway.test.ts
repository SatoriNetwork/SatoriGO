/**
 * Every UTXO chain's Electrum pool in a GATEWAY build.
 *
 * network.ts reads the gateway base URL and client token from services/gateway.ts,
 * which in turn reads the build defines (`__EVM_GATEWAY_URL__` /
 * `__EVM_CLIENT_TOKEN__`). Tests run with those empty, i.e. in the DEVELOPMENT
 * shape, and network.test.ts pins that shape. This file mocks services/gateway
 * so the module-level pools (PUBLIC_ELECTRUM_SERVERS, DEFAULT_*_URLS,
 * parseServerUrl, withGatewayBridge*) are evaluated the way a store build sees
 * them.
 *
 * The list shapes under test:
 *   EVR: [gateway bridge, electrum1-mainnet.evrmorecoin.org, electrum2-…]
 *        the owner's node is reached ONLY through the bridge, and the public
 *        Evrmore pool stays so a gateway outage does not brick EVR.
 *   RVN: [gateway bridge] and nothing else. No public Ravencoin fallback is
 *        acceptable (see the cipig note in network.ts), so RVN through the
 *        gateway has no fallback by design.
 *   BTC / LTC / DOGE / BTGS / WJK (1.4.0): [gateway bridge, ...that chain's
 *        public wss servers, unchanged and in the same order]. The bridge is
 *        preferred; the public pool is the fallback, because a gateway outage
 *        must never stop someone's Bitcoin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { GW, TOKEN } = vi.hoisted(() => ({
  GW: 'https://network.satorigo.app',
  TOKEN: 'sgw_test_token',
}));

vi.mock('../gateway', () => ({
  GATEWAY_URL: GW,
  HAS_GATEWAY: true,
  GATEWAY_CLIENT_TOKEN: TOKEN,
  gatewayUrl: () => GW,
  gatewayHeaders: () => ({ 'X-Satori-Client': TOKEN }),
}));

import {
  PUBLIC_ELECTRUM_SERVERS,
  PUBLIC_RVN_ELECTRUM_SERVERS,
  PUBLIC_BTGS_ELECTRUM_SERVERS,
  PUBLIC_LTC_ELECTRUM_SERVERS,
  PUBLIC_WJK_ELECTRUM_SERVERS,
  PUBLIC_BTC_ELECTRUM_SERVERS,
  PUBLIC_DOGE_ELECTRUM_SERVERS,
  PUBLIC_NEOX_ELECTRUM_SERVERS,
  PUBLIC_BTCB2_ELECTRUM_SERVERS,
  DEFAULT_ELECTRUM_SERVER_URLS,
  DEFAULT_RVN_ELECTRUM_SERVER_URLS,
  DEFAULT_BTGS_ELECTRUM_SERVER_URLS,
  DEFAULT_LTC_ELECTRUM_SERVER_URLS,
  DEFAULT_WJK_ELECTRUM_SERVER_URLS,
  DEFAULT_BTC_ELECTRUM_SERVER_URLS,
  DEFAULT_DOGE_ELECTRUM_SERVER_URLS,
  DEFAULT_NEOX_ELECTRUM_SERVER_URLS,
  DEFAULT_BTCB2_ELECTRUM_SERVER_URLS,
  GATEWAY_ELECTRUM_PROTOCOL,
  buildEvrElectrumPool,
  buildRvnElectrumPool,
  buildBtgsElectrumPool,
  buildLtcElectrumPool,
  buildWjkElectrumPool,
  buildBtcElectrumPool,
  buildDogeElectrumPool,
  buildNeoxElectrumPool,
  defaultServerUrlsFor,
  electrumWssUrl,
  gatewayElectrumEndpoint,
  gatewayElectrumProtocols,
  gatewayElectrumUrl,
  getElectrumServerPool,
  isGatewayElectrumUrl,
  parseServerUrl,
  serverToUrl,
  setElectrumServers,
  withGatewayBridge,
  withGatewayBridgeUrls,
} from './network';

const EVR_BRIDGE = 'wss://network.satorigo.app/electrum/evr';
const RVN_BRIDGE = 'wss://network.satorigo.app/electrum/rvn';
const BTC_BRIDGE = 'wss://network.satorigo.app/electrum/btc';
const LTC_BRIDGE = 'wss://network.satorigo.app/electrum/ltc';
const DOGE_BRIDGE = 'wss://network.satorigo.app/electrum/doge';
const BTGS_BRIDGE = 'wss://network.satorigo.app/electrum/btgs';
const WJK_BRIDGE = 'wss://network.satorigo.app/electrum/wjk';
const NEOX_BRIDGE = 'wss://network.satorigo.app/electrum/neox';
const BTCB2_BRIDGE = 'wss://network.satorigo.app/electrum/btcb2';
const EVR_FALLBACK_1 = 'wss://electrum1-mainnet.evrmorecoin.org:50004';
const EVR_FALLBACK_2 = 'wss://electrum2-mainnet.evrmorecoin.org:50004';

/** The public wss servers each chain keeps BEHIND its bridge, in order. These
 *  are exactly the lists a development build talks to directly, which is the
 *  point: the gateway change adds an entry, it does not edit the pool. */
const PUBLIC_BEHIND_BRIDGE = {
  btc: ['wss://btc.electrum1.cipig.net:30000', 'wss://btc.electrum2.cipig.net:30000'],
  ltc: ['wss://ltc.electrum1.cipig.net:30063', 'wss://ltc.electrum2.cipig.net:30063'],
  doge: ['wss://doge.electrum1.cipig.net:30060', 'wss://doge.electrum2.cipig.net:30060'],
  btgs: ['wss://electrum.bitcoingold.site:50005', 'wss://electrum.btgscoin.site:50005'],
  wjk: ['wss://electrum1.wojakcoin.cash:50104', 'wss://electrum2.wojakcoin.cash:50003'],
} as const;

afterEach(() => {
  setElectrumServers(null);
  setElectrumServers(null, 'ravencoin-mainnet');
  setElectrumServers(null, 'bitcoingold-mainnet');
  setElectrumServers(null, 'litecoin-mainnet');
  setElectrumServers(null, 'wojakcoin-mainnet');
  setElectrumServers(null, 'bitcoin-mainnet');
  setElectrumServers(null, 'dogecoin-mainnet');
  setElectrumServers(null, 'neoxa-mainnet');
});

describe('gateway bridge endpoint', () => {
  it('is wss://<gateway host>/electrum/<chainKey>, https folded to wss', () => {
    expect(gatewayElectrumUrl('evr')).toBe(EVR_BRIDGE);
    expect(gatewayElectrumUrl('rvn')).toBe(RVN_BRIDGE);
    // Explicit argument wins, and a trailing slash on the base is harmless.
    expect(gatewayElectrumUrl('evr', 'https://example.test/')).toBe(
      'wss://example.test/electrum/evr',
    );
    // A local http gateway during development folds to ws://.
    expect(gatewayElectrumUrl('rvn', 'http://localhost:8787')).toBe(
      'ws://localhost:8787/electrum/rvn',
    );
    // No gateway configured: no bridge URL at all.
    expect(gatewayElectrumUrl('evr', '')).toBe('');
  });

  it('offers the subprotocol pair [satori-v1, <clientToken>]', () => {
    expect(GATEWAY_ELECTRUM_PROTOCOL).toBe('satori-v1');
    expect(gatewayElectrumProtocols()).toEqual(['satori-v1', TOKEN]);
    expect(gatewayElectrumProtocols('other')).toEqual(['satori-v1', 'other']);
    // An EMPTY token is dropped rather than sent as an empty string, which a
    // browser rejects outright (SyntaxError from the WebSocket constructor).
    expect(gatewayElectrumProtocols('')).toEqual(['satori-v1']);
  });

  it('carries the gateway flag, the URL override and the protocols', () => {
    const ep = gatewayElectrumEndpoint('evr');
    expect(ep).toMatchObject({
      host: 'network.satorigo.app',
      wssPort: 443,
      gateway: true,
      wssUrl: EVR_BRIDGE,
      protocols: ['satori-v1', TOKEN],
    });
    expect(electrumWssUrl(ep!)).toBe(EVR_BRIDGE);
    expect(gatewayElectrumEndpoint('evr', '')).toBeNull();
  });
});

describe('gateway build: per-chain pool shapes', () => {
  it('EVR = [bridge, evrmorecoin1, evrmorecoin2]; the owner node is reached only through the bridge', () => {
    expect(PUBLIC_ELECTRUM_SERVERS.map(electrumWssUrl)).toEqual([
      EVR_BRIDGE,
      EVR_FALLBACK_1,
      EVR_FALLBACK_2,
    ]);
    expect(PUBLIC_ELECTRUM_SERVERS[0].gateway).toBe(true);
    // electrumx1.satorinet.io is NOT a direct entry in a gateway build.
    expect(PUBLIC_ELECTRUM_SERVERS.some((ep) => ep.host.includes('satorinet.io'))).toBe(false);
    // The public fallbacks stay plain: no gateway flag, no subprotocols.
    for (const ep of PUBLIC_ELECTRUM_SERVERS.slice(1)) {
      expect(ep.gateway).toBeUndefined();
      expect(ep.protocols).toBeUndefined();
      expect(ep.wssUrl).toBeUndefined();
    }
    expect(DEFAULT_ELECTRUM_SERVER_URLS).toEqual([EVR_BRIDGE, EVR_FALLBACK_1, EVR_FALLBACK_2]);
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);
  });

  it('RVN = [bridge] only: no public fallback, by design', () => {
    expect(PUBLIC_RVN_ELECTRUM_SERVERS).toHaveLength(1);
    expect(electrumWssUrl(PUBLIC_RVN_ELECTRUM_SERVERS[0])).toBe(RVN_BRIDGE);
    expect(PUBLIC_RVN_ELECTRUM_SERVERS[0].protocols).toEqual(['satori-v1', TOKEN]);
    expect(DEFAULT_RVN_ELECTRUM_SERVER_URLS).toEqual([RVN_BRIDGE]);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(PUBLIC_RVN_ELECTRUM_SERVERS);
    // The owner's node is never a direct entry in a gateway build.
    expect(PUBLIC_RVN_ELECTRUM_SERVERS.some((ep) => ep.host === 'rvnx.satorinet.io')).toBe(false);
  });

  it('NEOX = [bridge] only, the Ravencoin shape, and it is the whole chain (1.4.0)', () => {
    // Neoxa's backend is the owner's own node behind the gateway, exactly like
    // Ravencoin's, so its pool is one entry and has no public fallback. That is
    // a single-dialect decision, not a gap: Neoxa carries the Ravencoin asset
    // protocol, so a plain public ElectrumX would answer server.version and then
    // throw on every asset call, which is worse than no fallback at all.
    //
    // At the time of writing the gateway has no `neox` upstream configured yet
    // (the node is being stood up), so this single endpoint 404s. That is an
    // unreachable server, handled by the ordinary failover path, and the honest
    // degradation is pinned in electrumClient.test.ts ("2d-ter").
    expect(PUBLIC_NEOX_ELECTRUM_SERVERS).toHaveLength(1);
    expect(electrumWssUrl(PUBLIC_NEOX_ELECTRUM_SERVERS[0])).toBe(NEOX_BRIDGE);
    expect(PUBLIC_NEOX_ELECTRUM_SERVERS[0].protocols).toEqual(['satori-v1', TOKEN]);
    expect(PUBLIC_NEOX_ELECTRUM_SERVERS[0].gateway).toBe(true);
    expect(DEFAULT_NEOX_ELECTRUM_SERVER_URLS).toEqual([NEOX_BRIDGE]);
    expect(getElectrumServerPool('neoxa-mainnet')).toEqual(PUBLIC_NEOX_ELECTRUM_SERVERS);
    expect(defaultServerUrlsFor('neoxa-mainnet')).toEqual([NEOX_BRIDGE]);
    // Its own route, never another chain's. Sharing one would put a Neoxa client
    // on a different chain's node whose replies have the same shape.
    expect(NEOX_BRIDGE).not.toBe(RVN_BRIDGE);
    expect(NEOX_BRIDGE).not.toBe(EVR_BRIDGE);
    expect(gatewayElectrumUrl('neox')).toBe(NEOX_BRIDGE);
  });

  it('BTCB2 (Bitcoin BLAKE2b) = [bridge] alone: its one server has no wss listener (1.4.2)', () => {
    // electrum.bitcoinxor.org serves TCP 50001 / SSL 50002 only (verified
    // 2026-09-07), so a browser cannot reach it and the gateway bridge is the
    // whole pool, the Neoxa shape. Its own route, never another chain's.
    expect(PUBLIC_BTCB2_ELECTRUM_SERVERS).toHaveLength(1);
    expect(electrumWssUrl(PUBLIC_BTCB2_ELECTRUM_SERVERS[0])).toBe(BTCB2_BRIDGE);
    expect(PUBLIC_BTCB2_ELECTRUM_SERVERS[0].gateway).toBe(true);
    expect(DEFAULT_BTCB2_ELECTRUM_SERVER_URLS).toEqual([BTCB2_BRIDGE]);
    expect(getElectrumServerPool('bitcoinblake2b-mainnet')).toEqual(PUBLIC_BTCB2_ELECTRUM_SERVERS);
    expect(defaultServerUrlsFor('bitcoinblake2b-mainnet')).toEqual([BTCB2_BRIDGE]);
    expect(BTCB2_BRIDGE).not.toBe(BTC_BRIDGE);
    expect(gatewayElectrumUrl('btcb2')).toBe(BTCB2_BRIDGE);
  });

  it('BTC / LTC / DOGE / BTGS / WJK = [bridge, ...their public pool unchanged] (1.4.0)', () => {
    // "Mostek + publiczny zapas": the bridge is preferred, the public servers
    // stay exactly as they were, in exactly their old order, behind it. A
    // gateway outage must never stop someone's Bitcoin.
    const cases = [
      { pool: PUBLIC_BTC_ELECTRUM_SERVERS, bridge: BTC_BRIDGE, pub: PUBLIC_BEHIND_BRIDGE.btc, urls: DEFAULT_BTC_ELECTRUM_SERVER_URLS, chain: 'bitcoin-mainnet' },
      { pool: PUBLIC_LTC_ELECTRUM_SERVERS, bridge: LTC_BRIDGE, pub: PUBLIC_BEHIND_BRIDGE.ltc, urls: DEFAULT_LTC_ELECTRUM_SERVER_URLS, chain: 'litecoin-mainnet' },
      { pool: PUBLIC_DOGE_ELECTRUM_SERVERS, bridge: DOGE_BRIDGE, pub: PUBLIC_BEHIND_BRIDGE.doge, urls: DEFAULT_DOGE_ELECTRUM_SERVER_URLS, chain: 'dogecoin-mainnet' },
      { pool: PUBLIC_BTGS_ELECTRUM_SERVERS, bridge: BTGS_BRIDGE, pub: PUBLIC_BEHIND_BRIDGE.btgs, urls: DEFAULT_BTGS_ELECTRUM_SERVER_URLS, chain: 'bitcoingold-mainnet' },
      { pool: PUBLIC_WJK_ELECTRUM_SERVERS, bridge: WJK_BRIDGE, pub: PUBLIC_BEHIND_BRIDGE.wjk, urls: DEFAULT_WJK_ELECTRUM_SERVER_URLS, chain: 'wojakcoin-mainnet' },
    ] as const;

    for (const { pool, bridge, pub, urls, chain } of cases) {
      expect(pool).toHaveLength(3);
      expect(pool.map(electrumWssUrl)).toEqual([bridge, ...pub]);
      // The head IS the bridge: flagged, path-scoped to ITS OWN chain, and
      // carrying the subprotocol pair.
      expect(pool[0].gateway).toBe(true);
      expect(pool[0].protocols).toEqual(['satori-v1', TOKEN]);
      expect(isGatewayElectrumUrl(electrumWssUrl(pool[0]))).toBe(true);
      // The public fallbacks stay PLAIN: no flag, no subprotocols, no URL
      // override. Offering a subprotocol to a node that will not echo it back
      // makes the BROWSER fail the handshake, which would break the fallback.
      for (const ep of pool.slice(1)) {
        expect(ep.gateway).toBeUndefined();
        expect(ep.protocols).toBeUndefined();
        expect(ep.wssUrl).toBeUndefined();
        expect(ep.host.includes('satorigo.app')).toBe(false);
      }
      expect(urls).toEqual([bridge, ...pub]);
      expect(defaultServerUrlsFor(chain)).toEqual(urls);
      expect(getElectrumServerPool(chain)).toEqual(pool);
    }
  });

  it('each chain gets its OWN bridge path: the seven pools never share an endpoint', () => {
    const heads = [
      PUBLIC_ELECTRUM_SERVERS,
      PUBLIC_RVN_ELECTRUM_SERVERS,
      PUBLIC_BTC_ELECTRUM_SERVERS,
      PUBLIC_LTC_ELECTRUM_SERVERS,
      PUBLIC_DOGE_ELECTRUM_SERVERS,
      PUBLIC_BTGS_ELECTRUM_SERVERS,
      PUBLIC_WJK_ELECTRUM_SERVERS,
    ].map((p) => electrumWssUrl(p[0]));
    expect(heads).toEqual([
      EVR_BRIDGE,
      RVN_BRIDGE,
      BTC_BRIDGE,
      LTC_BRIDGE,
      DOGE_BRIDGE,
      BTGS_BRIDGE,
      WJK_BRIDGE,
    ]);
    // One host, seven paths: the single-dialect rule is untouched, a chain can
    // only ever reach its own upstream.
    expect(new Set(heads).size).toBe(7);
  });

  it('the builders produce the DEVELOPMENT shape when given no gateway', () => {
    expect(buildEvrElectrumPool('', '').map(electrumWssUrl)).toEqual([
      'wss://electrumx1.satorinet.io:50004',
      EVR_FALLBACK_1,
      EVR_FALLBACK_2,
    ]);
    expect(buildRvnElectrumPool('', '').map(electrumWssUrl)).toEqual([
      'wss://rvnx.satorinet.io:443',
    ]);
    // Neoxa has no direct node to fall back to yet: the owner's is being stood
    // up and no address has been published, and nothing may be invented here.
    // A development build therefore simply has no Neoxa server.
    expect(buildNeoxElectrumPool('', '')).toEqual([]);
    expect(buildEvrElectrumPool('', '').every((ep) => ep.protocols === undefined)).toBe(true);
    // ...and so do the five that gained a bridge in 1.4.0: with no gateway
    // configured each is its bare public list again, byte for byte.
    expect(buildBtcElectrumPool('', '').map(electrumWssUrl)).toEqual([...PUBLIC_BEHIND_BRIDGE.btc]);
    expect(buildLtcElectrumPool('', '').map(electrumWssUrl)).toEqual([...PUBLIC_BEHIND_BRIDGE.ltc]);
    expect(buildDogeElectrumPool('', '').map(electrumWssUrl)).toEqual([...PUBLIC_BEHIND_BRIDGE.doge]);
    expect(buildBtgsElectrumPool('', '').map(electrumWssUrl)).toEqual([...PUBLIC_BEHIND_BRIDGE.btgs]);
    expect(buildWjkElectrumPool('', '').map(electrumWssUrl)).toEqual([...PUBLIC_BEHIND_BRIDGE.wjk]);
    for (const build of [
      buildBtcElectrumPool,
      buildLtcElectrumPool,
      buildDogeElectrumPool,
      buildBtgsElectrumPool,
      buildWjkElectrumPool,
    ]) {
      expect(build('', '').every((ep) => ep.protocols === undefined && ep.gateway === undefined)).toBe(true);
    }
  });
});

describe('bridge URLs survive the persisted string round-trip', () => {
  it('parseServerUrl gives back the real bridge endpoint, path and subprotocols intact', () => {
    const ep = parseServerUrl(EVR_BRIDGE);
    expect(ep).toMatchObject({ gateway: true, wssUrl: EVR_BRIDGE, protocols: ['satori-v1', TOKEN] });
    expect(serverToUrl(ep!)).toBe(EVR_BRIDGE);
    // A trailing slash is tolerated, and the rvn bridge resolves too.
    expect(parseServerUrl(`${RVN_BRIDGE}/`)?.wssUrl).toBe(RVN_BRIDGE);
  });

  it('a plain server is still parsed as host:port with no subprotocols', () => {
    const ep = parseServerUrl('wss://electrum1-mainnet.evrmorecoin.org:50004');
    expect(ep).toMatchObject({ host: 'electrum1-mainnet.evrmorecoin.org', wssPort: 50004 });
    expect(ep?.protocols).toBeUndefined();
    expect(ep?.gateway).toBeUndefined();
    expect(ep?.wssUrl).toBeUndefined();
  });

  it('isGatewayElectrumUrl only matches this build gateway Electrum path', () => {
    expect(isGatewayElectrumUrl(EVR_BRIDGE)).toBe(true);
    expect(isGatewayElectrumUrl(RVN_BRIDGE)).toBe(true);
    expect(isGatewayElectrumUrl('wss://network.satorigo.app:443')).toBe(false);
    expect(isGatewayElectrumUrl('wss://evil.test/electrum/evr')).toBe(false);
    expect(isGatewayElectrumUrl(EVR_FALLBACK_1)).toBe(false);
    // With no gateway configured nothing is a bridge.
    expect(isGatewayElectrumUrl(EVR_BRIDGE, '')).toBe(false);
  });
});

describe('the bridge is a required member of the pool', () => {
  it('withGatewayBridgeUrls prepends it to a stored list that lacks it, keeping custom servers', () => {
    // Exactly the upgrade case: a pool persisted before this build had a gateway.
    const stored = ['wss://electrumx1.satorinet.io:50004', 'wss://mine.test:50004'];
    expect(withGatewayBridgeUrls(stored, 'evrmore-mainnet')).toEqual([EVR_BRIDGE, ...stored]);
    expect(withGatewayBridgeUrls(stored, 'ravencoin-mainnet')).toEqual([RVN_BRIDGE, ...stored]);
    // Never duplicated when it is already there, and always first.
    expect(withGatewayBridgeUrls([...stored, EVR_BRIDGE], 'evrmore-mainnet')).toEqual([
      EVR_BRIDGE,
      ...stored,
    ]);
    // Since 1.4.0 EVERY UTXO chain has a bridge, so the same upgrade path runs
    // on Bitcoin, Litecoin, Dogecoin, Bitcoin Gold and WojakCoin too: their
    // stored pools gain the bridge at the head, keeping the user's servers.
    expect(withGatewayBridgeUrls(stored, 'bitcoingold-mainnet')).toEqual([BTGS_BRIDGE, ...stored]);
    expect(withGatewayBridgeUrls(stored, 'bitcoin-mainnet')).toEqual([BTC_BRIDGE, ...stored]);
    expect(withGatewayBridgeUrls(stored, 'litecoin-mainnet')).toEqual([LTC_BRIDGE, ...stored]);
    expect(withGatewayBridgeUrls(stored, 'dogecoin-mainnet')).toEqual([DOGE_BRIDGE, ...stored]);
    expect(withGatewayBridgeUrls(stored, 'wojakcoin-mainnet')).toEqual([WJK_BRIDGE, ...stored]);
    // A chain's OWN bridge is the one asserted, never another chain's: a stored
    // list carrying the wrong bridge has it replaced, not appended to.
    expect(withGatewayBridgeUrls([EVR_BRIDGE, ...stored], 'bitcoin-mainnet')).toEqual([
      BTC_BRIDGE,
      ...stored,
    ]);
  });

  it('withGatewayBridge does the same on endpoints', () => {
    const custom = parseServerUrl('wss://mine.test:50004')!;
    const evr = withGatewayBridge([custom], 'evrmore-mainnet');
    expect(evr.map(electrumWssUrl)).toEqual([EVR_BRIDGE, 'wss://mine.test:50004']);
    const ltc = withGatewayBridge([custom], 'litecoin-mainnet');
    expect(ltc.map(electrumWssUrl)).toEqual([LTC_BRIDGE, 'wss://mine.test:50004']);
    expect(ltc[0].protocols).toEqual(['satori-v1', TOKEN]);
  });

  it('setElectrumServers re-asserts the bridge at the head of any user pool', () => {
    const custom = parseServerUrl('wss://mine.test:50004')!;
    setElectrumServers([custom], 'evrmore-mainnet');
    expect(getElectrumServerPool().map(electrumWssUrl)).toEqual([
      EVR_BRIDGE,
      'wss://mine.test:50004',
    ]);
    // ...and the custom server is a real extra fallback, tried after it.
    expect(getElectrumServerPool()[1].protocols).toBeUndefined();

    setElectrumServers([custom], 'ravencoin-mainnet');
    expect(getElectrumServerPool('ravencoin-mainnet').map(electrumWssUrl)).toEqual([
      RVN_BRIDGE,
      'wss://mine.test:50004',
    ]);

    // ...on every UTXO chain, including the five that gained a bridge in 1.4.0.
    setElectrumServers([custom], 'bitcoin-mainnet');
    expect(getElectrumServerPool('bitcoin-mainnet').map(electrumWssUrl)).toEqual([
      BTC_BRIDGE,
      'wss://mine.test:50004',
    ]);
    expect(getElectrumServerPool('bitcoin-mainnet')[1].protocols).toBeUndefined();

    setElectrumServers([custom], 'bitcoingold-mainnet');
    expect(getElectrumServerPool('bitcoingold-mainnet').map(electrumWssUrl)).toEqual([
      BTGS_BRIDGE,
      'wss://mine.test:50004',
    ]);
  });
});
