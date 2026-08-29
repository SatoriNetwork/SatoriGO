// Per-chain Electrum server pool resolution + chain-keyed storage keys (Phase A1).
import { afterEach, describe, expect, it } from 'vitest';
import { CHAIN_FEE_POLICIES, type ChainId } from './chainParams';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import {
  applyAllStoredElectrumServers,
  PUBLIC_ELECTRUM_SERVERS,
  PUBLIC_RVN_ELECTRUM_SERVERS,
  PUBLIC_BTGS_ELECTRUM_SERVERS,
  PUBLIC_LTC_ELECTRUM_SERVERS,
  PUBLIC_WJK_ELECTRUM_SERVERS,
  PUBLIC_BTC_ELECTRUM_SERVERS,
  PUBLIC_DOGE_ELECTRUM_SERVERS,
  PUBLIC_NEOX_ELECTRUM_SERVERS,
  DEFAULT_ELECTRUM_SERVER_URLS,
  DEFAULT_RVN_ELECTRUM_SERVER_URLS,
  DEFAULT_BTGS_ELECTRUM_SERVER_URLS,
  DEFAULT_LTC_ELECTRUM_SERVER_URLS,
  DEFAULT_WJK_ELECTRUM_SERVER_URLS,
  DEFAULT_BTC_ELECTRUM_SERVER_URLS,
  DEFAULT_DOGE_ELECTRUM_SERVER_URLS,
  DEFAULT_NEOX_ELECTRUM_SERVER_URLS,
  ELECTRUM_SERVERS_STORAGE_KEY,
  electrumServersStorageKey,
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
  getElectrumServerPool,
  isGatewayElectrumUrl,
  setElectrumServers,
  parseServerUrl,
  withGatewayBridgeUrls,
} from './network';

// The module keeps per-chain pool state; reset all eight chains after each test
// so nothing leaks between cases (or into other suites sharing the module).
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

describe('per-chain default pools', () => {
  it('Evrmore default pool is the 3 built-in wss endpoints', () => {
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);
    expect(getElectrumServerPool('evrmore-mainnet')).toEqual(PUBLIC_ELECTRUM_SERVERS);
    // Legacy id resolves to Evrmore too.
    expect(getElectrumServerPool('mainnet')).toEqual(PUBLIC_ELECTRUM_SERVERS);
  });

  // This suite runs in the DEVELOPMENT shape (no gateway define, see
  // vitest.config.ts), so the lists here are the ones a dev build talks to
  // directly. The gateway shape is pinned by network.gateway.test.ts.
  it('with no gateway configured, nothing goes through a bridge: no chain carries a wss URL override or subprotocols', () => {
    const everyPool = [
      PUBLIC_ELECTRUM_SERVERS,
      PUBLIC_RVN_ELECTRUM_SERVERS,
      PUBLIC_BTGS_ELECTRUM_SERVERS,
      PUBLIC_LTC_ELECTRUM_SERVERS,
      PUBLIC_WJK_ELECTRUM_SERVERS,
      PUBLIC_BTC_ELECTRUM_SERVERS,
      PUBLIC_DOGE_ELECTRUM_SERVERS,
    ].flat();
    for (const ep of everyPool) {
      expect(ep.gateway).toBeUndefined();
      expect(ep.wssUrl).toBeUndefined();
      expect(ep.protocols).toBeUndefined();
    }
    // The owner's own nodes are reached DIRECTLY here, which is exactly what a
    // gateway build must not do.
    expect(PUBLIC_ELECTRUM_SERVERS[0].host).toBe('electrumx1.satorinet.io');
    expect(buildEvrElectrumPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);
    expect(buildRvnElectrumPool()).toEqual(PUBLIC_RVN_ELECTRUM_SERVERS);
    expect(isGatewayElectrumUrl('wss://network.satorigo.app/electrum/evr')).toBe(false);
    expect(withGatewayBridgeUrls(DEFAULT_ELECTRUM_SERVER_URLS)).toEqual(
      DEFAULT_ELECTRUM_SERVER_URLS,
    );
  });

  it('the pool builders still produce the gateway shape when handed a gateway', () => {
    // The build defines are empty here; the arguments are what a store build
    // passes. Proves the two shapes come from ONE code path.
    const evr = buildEvrElectrumPool('https://gw.test', 'tok');
    expect(evr.map(electrumWssUrl)).toEqual([
      'wss://gw.test/electrum/evr',
      'wss://electrum1-mainnet.evrmorecoin.org:50004',
      'wss://electrum2-mainnet.evrmorecoin.org:50004',
    ]);
    expect(evr[0].protocols).toEqual(['satori-v1', 'tok']);
    const rvn = buildRvnElectrumPool('https://gw.test', 'tok');
    expect(rvn.map(electrumWssUrl)).toEqual(['wss://gw.test/electrum/rvn']);
  });

  it('every remaining UTXO chain builds "bridge first, public pool behind it" when handed a gateway, and its public list alone without one', () => {
    // The 1.4.0 change, in the ONE code path both build shapes come from. Each
    // pair pins: (a) the dev shape is byte-for-byte the public list it always
    // was, and (b) the gateway shape is that same list with the chain's own
    // bridge prepended, in that order, subprotocols on the bridge only.
    const cases = [
      { build: buildBtgsElectrumPool, key: 'btgs', pub: DEFAULT_BTGS_ELECTRUM_SERVER_URLS },
      { build: buildLtcElectrumPool, key: 'ltc', pub: DEFAULT_LTC_ELECTRUM_SERVER_URLS },
      { build: buildWjkElectrumPool, key: 'wjk', pub: DEFAULT_WJK_ELECTRUM_SERVER_URLS },
      { build: buildBtcElectrumPool, key: 'btc', pub: DEFAULT_BTC_ELECTRUM_SERVER_URLS },
      { build: buildDogeElectrumPool, key: 'doge', pub: DEFAULT_DOGE_ELECTRUM_SERVER_URLS },
    ] as const;
    for (const { build, key, pub } of cases) {
      // Development build: unchanged, no bridge, no subprotocols anywhere.
      const dev = build('', '');
      expect(dev.map(electrumWssUrl)).toEqual([...pub]);
      expect(dev.every((ep) => ep.protocols === undefined && ep.gateway === undefined)).toBe(true);

      // Gateway build: the bridge first, the SAME public list behind it.
      const gw = build('https://gw.test', 'tok');
      expect(gw.map(electrumWssUrl)).toEqual([`wss://gw.test/electrum/${key}`, ...pub]);
      expect(gw[0].protocols).toEqual(['satori-v1', 'tok']);
      expect(gw[0].gateway).toBe(true);
      // The public entries stay PLAIN: a public ElectrumX that is offered a
      // subprotocol it does not echo back makes the browser fail the handshake.
      expect(gw.slice(1).every((ep) => ep.protocols === undefined && ep.wssUrl === undefined)).toBe(
        true,
      );
    }
  });

  it('pins the cipig TLS ports: BTC 20000 and LTC 20063 (corrected 2026-08-25), DOGE 20060', () => {
    // cipig's scheme is 10xxx PLAIN TCP / 20xxx TLS / 30xxx WebSocket. BTC was
    // listed as 10000 (the PLAINTEXT port: a TLS handshake there fails with
    // ERR_SSL_WRONG_VERSION_NUMBER) and LTC as 50002 (not open, connection
    // refused). Both were verified live from the gateway VM on 2026-08-25 with
    // a real server.version handshake: BTC ElectrumX 2.0.0 at tip 964002, LTC
    // ElectrumX 2.0.0 at tip 3166195. The wallet itself only ever opens the wss
    // port, so nothing was visibly broken; the field was simply untrue.
    expect(PUBLIC_BTC_ELECTRUM_SERVERS.map((s) => s.sslPort)).toEqual([20000, 20000]);
    expect(PUBLIC_LTC_ELECTRUM_SERVERS.map((s) => s.sslPort)).toEqual([20063, 20063]);
    expect(PUBLIC_DOGE_ELECTRUM_SERVERS.map((s) => s.sslPort)).toEqual([20060, 20060]);
    // Not cipig, and unchanged: verified correct as listed.
    expect(PUBLIC_BTGS_ELECTRUM_SERVERS.map((s) => s.sslPort)).toEqual([50002, 50002]);
    expect(PUBLIC_WJK_ELECTRUM_SERVERS.map((s) => s.sslPort)).toEqual([50102, 50002]);
  });

  it('Ravencoin default pool is EXACTLY ONE endpoint: rvnx.satorinet.io:443 (Cloudflare/443)', () => {
    expect(PUBLIC_RVN_ELECTRUM_SERVERS).toHaveLength(1);
    expect(PUBLIC_RVN_ELECTRUM_SERVERS[0]).toMatchObject({
      host: 'rvnx.satorinet.io',
      wssPort: 443,
    });
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(PUBLIC_RVN_ELECTRUM_SERVERS);
    expect(DEFAULT_RVN_ELECTRUM_SERVER_URLS).toEqual(['wss://rvnx.satorinet.io:443']);
  });

  it('Bitcoin Gold default pool is the 2 built-in wss endpoints', () => {
    expect(PUBLIC_BTGS_ELECTRUM_SERVERS).toHaveLength(2);
    expect(PUBLIC_BTGS_ELECTRUM_SERVERS[0]).toMatchObject({
      host: 'electrum.bitcoingold.site',
      wssPort: 50005,
    });
    expect(PUBLIC_BTGS_ELECTRUM_SERVERS[1]).toMatchObject({
      host: 'electrum.btgscoin.site',
      wssPort: 50005,
    });
    expect(getElectrumServerPool('bitcoingold-mainnet')).toEqual(PUBLIC_BTGS_ELECTRUM_SERVERS);
    expect(DEFAULT_BTGS_ELECTRUM_SERVER_URLS).toEqual([
      'wss://electrum.bitcoingold.site:50005',
      'wss://electrum.btgscoin.site:50005',
    ]);
  });

  it('Litecoin default pool is the 2 built-in wss endpoints', () => {
    expect(PUBLIC_LTC_ELECTRUM_SERVERS).toHaveLength(2);
    expect(PUBLIC_LTC_ELECTRUM_SERVERS[0]).toMatchObject({
      host: 'ltc.electrum1.cipig.net',
      wssPort: 30063,
      sslPort: 20063,
    });
    // electrum3 used to sit here but fails the wss handshake (probed dead
    // 2026-08-14); its verified sibling electrum2 replaced it so one host
    // outage cannot take Litecoin offline.
    expect(PUBLIC_LTC_ELECTRUM_SERVERS[1]).toMatchObject({
      host: 'ltc.electrum2.cipig.net',
      wssPort: 30063,
    });
    expect(PUBLIC_LTC_ELECTRUM_SERVERS.some((s) => s.host === 'ltc.electrum3.cipig.net')).toBe(false);
    expect(getElectrumServerPool('litecoin-mainnet')).toEqual(PUBLIC_LTC_ELECTRUM_SERVERS);
    expect(DEFAULT_LTC_ELECTRUM_SERVER_URLS).toEqual([
      'wss://ltc.electrum1.cipig.net:30063',
      'wss://ltc.electrum2.cipig.net:30063',
    ]);
  });

  it('WojakCoin default pool is the 2 built-in wss endpoints (different wss ports per host)', () => {
    expect(PUBLIC_WJK_ELECTRUM_SERVERS).toHaveLength(2);
    expect(PUBLIC_WJK_ELECTRUM_SERVERS[0]).toMatchObject({
      host: 'electrum1.wojakcoin.cash',
      wssPort: 50104,
    });
    expect(PUBLIC_WJK_ELECTRUM_SERVERS[1]).toMatchObject({
      host: 'electrum2.wojakcoin.cash',
      wssPort: 50003,
    });
    expect(getElectrumServerPool('wojakcoin-mainnet')).toEqual(PUBLIC_WJK_ELECTRUM_SERVERS);
    expect(DEFAULT_WJK_ELECTRUM_SERVER_URLS).toEqual([
      'wss://electrum1.wojakcoin.cash:50104',
      'wss://electrum2.wojakcoin.cash:50003',
    ]);
  });

  it('Bitcoin default pool is the 2 built-in wss endpoints (cipig, same operator as Litecoin)', () => {
    expect(PUBLIC_BTC_ELECTRUM_SERVERS).toHaveLength(2);
    expect(PUBLIC_BTC_ELECTRUM_SERVERS[0]).toMatchObject({
      host: 'btc.electrum1.cipig.net',
      wssPort: 30000,
      sslPort: 20000,
    });
    expect(PUBLIC_BTC_ELECTRUM_SERVERS[1]).toMatchObject({
      host: 'btc.electrum2.cipig.net',
      wssPort: 30000,
    });
    // The third cipig host (btc.electrum3.cipig.net) did not respond when probed
    // and must stay excluded.
    expect(PUBLIC_BTC_ELECTRUM_SERVERS.some((s) => s.host === 'btc.electrum3.cipig.net')).toBe(false);
    expect(getElectrumServerPool('bitcoin-mainnet')).toEqual(PUBLIC_BTC_ELECTRUM_SERVERS);
    expect(DEFAULT_BTC_ELECTRUM_SERVER_URLS).toEqual([
      'wss://btc.electrum1.cipig.net:30000',
      'wss://btc.electrum2.cipig.net:30000',
    ]);
  });

  it('Dogecoin default pool is the 2 built-in wss endpoints (cipig, same operator as LTC/BTC)', () => {
    expect(PUBLIC_DOGE_ELECTRUM_SERVERS).toHaveLength(2);
    expect(PUBLIC_DOGE_ELECTRUM_SERVERS[0]).toMatchObject({
      host: 'doge.electrum1.cipig.net',
      wssPort: 30060,
    });
    expect(PUBLIC_DOGE_ELECTRUM_SERVERS[1]).toMatchObject({
      host: 'doge.electrum2.cipig.net',
      wssPort: 30060,
    });
    // The third cipig host (doge.electrum3.cipig.net) failed the wss handshake
    // in both the 2026-08-14 and 2026-08-15 probes and must stay excluded.
    expect(PUBLIC_DOGE_ELECTRUM_SERVERS.some((s) => s.host === 'doge.electrum3.cipig.net')).toBe(false);
    expect(getElectrumServerPool('dogecoin-mainnet')).toEqual(PUBLIC_DOGE_ELECTRUM_SERVERS);
    expect(DEFAULT_DOGE_ELECTRUM_SERVER_URLS).toEqual([
      'wss://doge.electrum1.cipig.net:30060',
      'wss://doge.electrum2.cipig.net:30060',
    ]);
  });

  it('defaultServerUrlsFor returns the right chain default url list', () => {
    expect(defaultServerUrlsFor('mainnet')).toEqual(DEFAULT_ELECTRUM_SERVER_URLS);
    expect(defaultServerUrlsFor('ravencoin-mainnet')).toEqual(DEFAULT_RVN_ELECTRUM_SERVER_URLS);
    expect(defaultServerUrlsFor('bitcoingold-mainnet')).toEqual(DEFAULT_BTGS_ELECTRUM_SERVER_URLS);
    expect(defaultServerUrlsFor('litecoin-mainnet')).toEqual(DEFAULT_LTC_ELECTRUM_SERVER_URLS);
    expect(defaultServerUrlsFor('wojakcoin-mainnet')).toEqual(DEFAULT_WJK_ELECTRUM_SERVER_URLS);
    expect(defaultServerUrlsFor('bitcoin-mainnet')).toEqual(DEFAULT_BTC_ELECTRUM_SERVER_URLS);
    expect(defaultServerUrlsFor('dogecoin-mainnet')).toEqual(DEFAULT_DOGE_ELECTRUM_SERVER_URLS);
  });
});

describe('chain-keyed storage keys', () => {
  it('Evrmore keeps the legacy bare key; Ravencoin, Bitcoin Gold, Litecoin, WojakCoin, Bitcoin and Dogecoin are suffixed', () => {
    expect(ELECTRUM_SERVERS_STORAGE_KEY).toBe('electrumServers');
    expect(electrumServersStorageKey()).toBe('electrumServers');
    expect(electrumServersStorageKey('mainnet')).toBe('electrumServers');
    expect(electrumServersStorageKey('evrmore-mainnet')).toBe('electrumServers');
    expect(electrumServersStorageKey('ravencoin-mainnet')).toBe(
      'electrumServers:ravencoin-mainnet',
    );
    expect(electrumServersStorageKey('bitcoingold-mainnet')).toBe(
      'electrumServers:bitcoingold-mainnet',
    );
    expect(electrumServersStorageKey('litecoin-mainnet')).toBe(
      'electrumServers:litecoin-mainnet',
    );
    expect(electrumServersStorageKey('wojakcoin-mainnet')).toBe(
      'electrumServers:wojakcoin-mainnet',
    );
    expect(electrumServersStorageKey('bitcoin-mainnet')).toBe(
      'electrumServers:bitcoin-mainnet',
    );
    expect(electrumServersStorageKey('dogecoin-mainnet')).toBe(
      'electrumServers:dogecoin-mainnet',
    );
  });
});

describe('applyAllStoredElectrumServers', () => {
  // The whole point of the helper is that its chain set comes from the params
  // (CHAIN_FEE_POLICIES is an exhaustive Record over ChainId), so this test
  // iterates that same set rather than naming chains: adding a chain extends
  // both the helper and this assertion automatically, and the stale
  // hand-maintained apply list this replaced (background/index.ts used to apply
  // Evrmore + Ravencoin only) cannot come back unnoticed.
  it('activates the stored user pool of EVERY chain in the params-derived set', async () => {
    const storage = new MemoryStorageAdapter();
    setStorageForTests(storage);
    try {
      const ids = Object.keys(CHAIN_FEE_POLICIES) as ChainId[];
      expect(ids.length).toBeGreaterThan(0);
      // Seed one distinct user server per STORAGE KEY (Evrmore mainnet and
      // testnet share the legacy bare key, so they share one seeded pool).
      const hostForKey = new Map<string, string>();
      for (const id of ids) {
        const key = electrumServersStorageKey(id);
        if (!hostForKey.has(key)) hostForKey.set(key, `user-server-${hostForKey.size}.example`);
        await storage.set(key, [`wss://${hostForKey.get(key)!}:50004`]);
      }

      await applyAllStoredElectrumServers();

      for (const id of ids) {
        const expected = hostForKey.get(electrumServersStorageKey(id))!;
        expect(getElectrumServerPool(id).map((s) => s.host)).toEqual([expected]);
      }
    } finally {
      // Fresh empty storage so no other test in this file sees the seeds.
      setStorageForTests(new MemoryStorageAdapter());
    }
  });
});

describe('setElectrumServers is isolated per chain', () => {
  it('setting the RVN pool never touches the Evrmore pool, and vice versa', () => {
    const rvnOverride = [parseServerUrl('wss://my-rvn.example:443')!];
    setElectrumServers(rvnOverride, 'ravencoin-mainnet');

    // RVN pool now the override; Evrmore untouched (still its defaults).
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);

    const evrOverride = [parseServerUrl('wss://my-evr.example:50004')!];
    setElectrumServers(evrOverride);
    expect(getElectrumServerPool()).toEqual(evrOverride);
    // RVN override still stands.
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
  });

  it('clearing a chain (null) restores THAT chain default only', () => {
    setElectrumServers([parseServerUrl('wss://my-rvn.example:443')!], 'ravencoin-mainnet');
    setElectrumServers(null, 'ravencoin-mainnet');
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(PUBLIC_RVN_ELECTRUM_SERVERS);
  });

  it('Bitcoin Gold pool is isolated from both Evrmore and Ravencoin', () => {
    const rvnOverride = [parseServerUrl('wss://my-rvn.example:443')!];
    const btgsOverride = [parseServerUrl('wss://my-btgs.example:50005')!];
    setElectrumServers(rvnOverride, 'ravencoin-mainnet');
    setElectrumServers(btgsOverride, 'bitcoingold-mainnet');

    expect(getElectrumServerPool('bitcoingold-mainnet')).toEqual(btgsOverride);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);

    setElectrumServers(null, 'bitcoingold-mainnet');
    expect(getElectrumServerPool('bitcoingold-mainnet')).toEqual(PUBLIC_BTGS_ELECTRUM_SERVERS);
    // Ravencoin override still stands.
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
  });

  it('Litecoin pool is isolated from Evrmore, Ravencoin and Bitcoin Gold', () => {
    const rvnOverride = [parseServerUrl('wss://my-rvn.example:443')!];
    const btgsOverride = [parseServerUrl('wss://my-btgs.example:50005')!];
    const ltcOverride = [parseServerUrl('wss://my-ltc.example:30063')!];
    setElectrumServers(rvnOverride, 'ravencoin-mainnet');
    setElectrumServers(btgsOverride, 'bitcoingold-mainnet');
    setElectrumServers(ltcOverride, 'litecoin-mainnet');

    expect(getElectrumServerPool('litecoin-mainnet')).toEqual(ltcOverride);
    expect(getElectrumServerPool('bitcoingold-mainnet')).toEqual(btgsOverride);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);

    setElectrumServers(null, 'litecoin-mainnet');
    expect(getElectrumServerPool('litecoin-mainnet')).toEqual(PUBLIC_LTC_ELECTRUM_SERVERS);
    // The other overrides still stand.
    expect(getElectrumServerPool('bitcoingold-mainnet')).toEqual(btgsOverride);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
  });

  it('WojakCoin pool is isolated from Evrmore, Ravencoin, Bitcoin Gold and Litecoin', () => {
    const rvnOverride = [parseServerUrl('wss://my-rvn.example:443')!];
    const btgsOverride = [parseServerUrl('wss://my-btgs.example:50005')!];
    const ltcOverride = [parseServerUrl('wss://my-ltc.example:30063')!];
    const wjkOverride = [parseServerUrl('wss://my-wjk.example:50104')!];
    setElectrumServers(rvnOverride, 'ravencoin-mainnet');
    setElectrumServers(btgsOverride, 'bitcoingold-mainnet');
    setElectrumServers(ltcOverride, 'litecoin-mainnet');
    setElectrumServers(wjkOverride, 'wojakcoin-mainnet');

    expect(getElectrumServerPool('wojakcoin-mainnet')).toEqual(wjkOverride);
    expect(getElectrumServerPool('litecoin-mainnet')).toEqual(ltcOverride);
    expect(getElectrumServerPool('bitcoingold-mainnet')).toEqual(btgsOverride);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);

    setElectrumServers(null, 'wojakcoin-mainnet');
    expect(getElectrumServerPool('wojakcoin-mainnet')).toEqual(PUBLIC_WJK_ELECTRUM_SERVERS);
    // The other overrides still stand.
    expect(getElectrumServerPool('litecoin-mainnet')).toEqual(ltcOverride);
    expect(getElectrumServerPool('bitcoingold-mainnet')).toEqual(btgsOverride);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
  });

  it('Bitcoin pool is isolated from Evrmore, Ravencoin, Bitcoin Gold, Litecoin and WojakCoin', () => {
    const rvnOverride = [parseServerUrl('wss://my-rvn.example:443')!];
    const btgsOverride = [parseServerUrl('wss://my-btgs.example:50005')!];
    const ltcOverride = [parseServerUrl('wss://my-ltc.example:30063')!];
    const wjkOverride = [parseServerUrl('wss://my-wjk.example:50104')!];
    const btcOverride = [parseServerUrl('wss://my-btc.example:30000')!];
    setElectrumServers(rvnOverride, 'ravencoin-mainnet');
    setElectrumServers(btgsOverride, 'bitcoingold-mainnet');
    setElectrumServers(ltcOverride, 'litecoin-mainnet');
    setElectrumServers(wjkOverride, 'wojakcoin-mainnet');
    setElectrumServers(btcOverride, 'bitcoin-mainnet');

    expect(getElectrumServerPool('bitcoin-mainnet')).toEqual(btcOverride);
    expect(getElectrumServerPool('wojakcoin-mainnet')).toEqual(wjkOverride);
    expect(getElectrumServerPool('litecoin-mainnet')).toEqual(ltcOverride);
    expect(getElectrumServerPool('bitcoingold-mainnet')).toEqual(btgsOverride);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);

    setElectrumServers(null, 'bitcoin-mainnet');
    expect(getElectrumServerPool('bitcoin-mainnet')).toEqual(PUBLIC_BTC_ELECTRUM_SERVERS);
    // The other overrides (including the Litecoin one, same operator as BTC) still stand.
    expect(getElectrumServerPool('wojakcoin-mainnet')).toEqual(wjkOverride);
    expect(getElectrumServerPool('litecoin-mainnet')).toEqual(ltcOverride);
    expect(getElectrumServerPool('bitcoingold-mainnet')).toEqual(btgsOverride);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(rvnOverride);
  });

  it('Dogecoin pool is isolated from every other chain (including its cipig siblings LTC and BTC)', () => {
    const ltcOverride = [parseServerUrl('wss://my-ltc.example:30063')!];
    const btcOverride = [parseServerUrl('wss://my-btc.example:30000')!];
    const dogeOverride = [parseServerUrl('wss://my-doge.example:30060')!];
    setElectrumServers(ltcOverride, 'litecoin-mainnet');
    setElectrumServers(btcOverride, 'bitcoin-mainnet');
    setElectrumServers(dogeOverride, 'dogecoin-mainnet');

    expect(getElectrumServerPool('dogecoin-mainnet')).toEqual(dogeOverride);
    expect(getElectrumServerPool('litecoin-mainnet')).toEqual(ltcOverride);
    expect(getElectrumServerPool('bitcoin-mainnet')).toEqual(btcOverride);
    // Chains without an override keep their own defaults, untouched.
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(PUBLIC_RVN_ELECTRUM_SERVERS);

    setElectrumServers(null, 'dogecoin-mainnet');
    expect(getElectrumServerPool('dogecoin-mainnet')).toEqual(PUBLIC_DOGE_ELECTRUM_SERVERS);
    // The same-operator overrides still stand: three cipig pools, three slots.
    expect(getElectrumServerPool('litecoin-mainnet')).toEqual(ltcOverride);
    expect(getElectrumServerPool('bitcoin-mainnet')).toEqual(btcOverride);
  });
});

// ---------------------------------------------------------------------------
// Neoxa: bridge-only like Ravencoin, and isolated from every other chain.
//
// This suite runs in the DEVELOPMENT shape (no gateway define, see
// vitest.config.ts), where Neoxa has no direct node to list yet — the owner's is
// being stood up — so its pool is empty here. The gateway shape, where it is the
// bridge and nothing else, is covered in network.gateway.test.ts.
//
// The failure mode being guarded against is not a Neoxa that cannot connect (a
// chain whose server is down is an ordinary state, proven to degrade honestly in
// electrumClient.test.ts) but a Neoxa that quietly borrows SOMEBODY ELSE'S
// servers: poolKey() falls back to 'evrmore' for any id it does not recognise,
// and Evrmore's nodes speak the same asset dialect Neoxa does, so a missing pool
// key would hand a Neoxa client a working connection to the WRONG CHAIN whose
// replies have exactly the right shape.
// ---------------------------------------------------------------------------
describe('Neoxa pool (bridge-only; empty in a development build)', () => {
  it('has no direct node in the development shape', () => {
    expect(PUBLIC_NEOX_ELECTRUM_SERVERS).toEqual([]);
    expect(buildNeoxElectrumPool()).toEqual([]);
    expect(DEFAULT_NEOX_ELECTRUM_SERVER_URLS).toEqual([]);
    expect(getElectrumServerPool('neoxa-mainnet')).toEqual([]);
    expect(defaultServerUrlsFor('neoxa-mainnet')).toEqual([]);
  });

  it('does NOT fall back to the Evrmore pool (the whole point of its own pool key)', () => {
    // If 'neoxa-mainnet' ever stopped resolving to its own key, THIS is what
    // would happen instead, and it would look like it worked.
    expect(getElectrumServerPool('neoxa-mainnet')).not.toEqual(PUBLIC_ELECTRUM_SERVERS);
    expect(getElectrumServerPool('neoxa-mainnet')).not.toEqual(PUBLIC_RVN_ELECTRUM_SERVERS);
    expect(PUBLIC_ELECTRUM_SERVERS.length > 0).toBe(true); // the comparison is meaningful
  });

  it('keeps its own storage key, so a stored pool can never leak between chains', () => {
    expect(electrumServersStorageKey('neoxa-mainnet')).toBe(
      `${ELECTRUM_SERVERS_STORAGE_KEY}:neoxa-mainnet`,
    );
    expect(electrumServersStorageKey('neoxa-mainnet')).not.toBe(ELECTRUM_SERVERS_STORAGE_KEY);
    expect(electrumServersStorageKey('neoxa-mainnet')).not.toBe(
      electrumServersStorageKey('ravencoin-mainnet'),
    );
  });

  it('has NO public fallback, the Ravencoin shape (single dialect)', () => {
    // Asserted as a DECISION, not as an accident of the current data. Neoxa
    // carries the Ravencoin asset protocol, so a plain public ElectrumX would
    // answer server.version and then throw on every asset call; adding one as a
    // "fallback" would break asset balances silently instead of failing. If a
    // future edit puts a public host in this list, this is what should stop it.
    expect(buildNeoxElectrumPool('', '')).toEqual([]);
    expect(buildNeoxElectrumPool('https://gw.example', 'tok')).toHaveLength(1);
    expect(buildNeoxElectrumPool('https://gw.example', 'tok')[0].gateway).toBe(true);
    // Ravencoin, the chain this shape was copied from, is the same length.
    expect(buildRvnElectrumPool('https://gw.example', 'tok')).toHaveLength(1);
  });

  it('is included in applyAllStoredElectrumServers, which derives its list from CHAIN_FEE_POLICIES', async () => {
    // The chain set comes from the fee-policy Record, never a hand-written call
    // list, so a new chain cannot be forgotten here. Assert that Neoxa really is
    // in that set, and that applying an empty store leaves it empty.
    setStorageForTests(new MemoryStorageAdapter());
    expect((Object.keys(CHAIN_FEE_POLICIES) as ChainId[])).toContain('neoxa-mainnet');
    await applyAllStoredElectrumServers();
    expect(getElectrumServerPool('neoxa-mainnet')).toEqual([]);
  });

  it('a user-configured Neoxa server stays scoped to Neoxa', () => {
    // Nothing offers this in the UI today, but the pool machinery is live, and
    // the isolation property must hold before it is reachable rather than after.
    const neoxOverride = [parseServerUrl('wss://my-neox.example:50004')!];
    setElectrumServers(neoxOverride, 'neoxa-mainnet');
    expect(getElectrumServerPool('neoxa-mainnet')).toEqual(neoxOverride);
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);
    expect(getElectrumServerPool('ravencoin-mainnet')).toEqual(PUBLIC_RVN_ELECTRUM_SERVERS);
    setElectrumServers(null, 'neoxa-mainnet');
    expect(getElectrumServerPool('neoxa-mainnet')).toEqual([]);
  });
});
