// Per-chain Electrum server pool resolution + chain-keyed storage keys (Phase A1).
import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLIC_ELECTRUM_SERVERS,
  PUBLIC_RVN_ELECTRUM_SERVERS,
  DEFAULT_ELECTRUM_SERVER_URLS,
  DEFAULT_RVN_ELECTRUM_SERVER_URLS,
  ELECTRUM_SERVERS_STORAGE_KEY,
  electrumServersStorageKey,
  defaultServerUrlsFor,
  getElectrumServerPool,
  setElectrumServers,
  parseServerUrl,
} from './network';

// The module keeps per-chain pool state; reset both chains after each test so
// nothing leaks between cases (or into other suites sharing the module).
afterEach(() => {
  setElectrumServers(null);
  setElectrumServers(null, 'ravencoin-mainnet');
});

describe('per-chain default pools', () => {
  it('Evrmore default pool is the 3 built-in wss endpoints', () => {
    expect(getElectrumServerPool()).toEqual(PUBLIC_ELECTRUM_SERVERS);
    expect(getElectrumServerPool('evrmore-mainnet')).toEqual(PUBLIC_ELECTRUM_SERVERS);
    // Legacy id resolves to Evrmore too.
    expect(getElectrumServerPool('mainnet')).toEqual(PUBLIC_ELECTRUM_SERVERS);
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

  it('defaultServerUrlsFor returns the right chain default url list', () => {
    expect(defaultServerUrlsFor('mainnet')).toEqual(DEFAULT_ELECTRUM_SERVER_URLS);
    expect(defaultServerUrlsFor('ravencoin-mainnet')).toEqual(DEFAULT_RVN_ELECTRUM_SERVER_URLS);
  });
});

describe('chain-keyed storage keys', () => {
  it('Evrmore keeps the legacy bare key; Ravencoin is suffixed', () => {
    expect(ELECTRUM_SERVERS_STORAGE_KEY).toBe('electrumServers');
    expect(electrumServersStorageKey()).toBe('electrumServers');
    expect(electrumServersStorageKey('mainnet')).toBe('electrumServers');
    expect(electrumServersStorageKey('evrmore-mainnet')).toBe('electrumServers');
    expect(electrumServersStorageKey('ravencoin-mainnet')).toBe(
      'electrumServers:ravencoin-mainnet',
    );
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
});
