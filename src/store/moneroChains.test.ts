// moneroChains.ts is a thin plain-data mirror; the only real behaviour is
// "null without the engine, a filled-in row with it", so the tests exercise
// exactly that plus the id helpers and the explorer template.

import { describe, it, expect, vi, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({ moneroEnabled: true }));

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return {
    ...actual,
    loadMoneroModules: async () =>
      hoisted.moneroEnabled ? { MONERO_RELEASE_HEIGHT: 3772358, MONERO_COIN_TYPE: 128, MONERO_BIP39_SCHEME: 'cake-exodus' } : null,
  };
});

import {
  MONERO_TARGET,
  isMoneroChainTarget,
  loadMoneroChainInfo,
  moneroExplorerTxUrl,
} from './moneroChains';

describe('moneroChains', () => {
  afterEach(() => {
    hoisted.moneroEnabled = true;
  });

  it('MONERO_TARGET is the fixed xmr:mainnet id', () => {
    expect(MONERO_TARGET).toBe('xmr:mainnet');
  });

  it('isMoneroChainTarget recognises only the exact id', () => {
    expect(isMoneroChainTarget('xmr:mainnet')).toBe(true);
    expect(isMoneroChainTarget('evm:base')).toBe(false);
    expect(isMoneroChainTarget('mainnet')).toBe(false);
    expect(isMoneroChainTarget(undefined)).toBe(false);
    expect(isMoneroChainTarget(null)).toBe(false);
  });

  it('loadMoneroChainInfo returns null when the build has no Monero engine', async () => {
    hoisted.moneroEnabled = false;
    expect(await loadMoneroChainInfo()).toBeNull();
  });

  it('loadMoneroChainInfo returns the fixed row, reading the release height from the engine', async () => {
    const chain = await loadMoneroChainInfo();
    expect(chain).not.toBeNull();
    expect(chain).toMatchObject({
      key: 'monero',
      displayName: 'Monero',
      nativeTicker: 'XMR',
      nativeDecimals: 12,
      defaultNodeSet: 'main',
      nodeSets: ['main'],
      releaseHeight: 3772358,
      coinType: 128,
      scheme: 'cake-exodus',
      young: false,
      recentlyAdded: true,
    });
    expect(chain?.homepage).toMatch(/^https:\/\//);
    expect(chain?.explorerTxUrl).toContain('{txid}');
  });

  it('moneroExplorerTxUrl substitutes the txid', () => {
    const url = moneroExplorerTxUrl({ explorerTxUrl: 'https://xmrchain.net/tx/{txid}' }, 'abc123');
    expect(url).toBe('https://xmrchain.net/tx/abc123');
  });
});
