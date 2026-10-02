import { describe, it, expect } from 'vitest';
import { ZCASH_TARGET, isZcashChainTarget, ZCASH_CHAIN, zcashChainInfo, zcashExplorerTxUrl } from './zcashChain';

describe('ZCASH_TARGET / isZcashChainTarget', () => {
  it('is the fixed engine.ts-shaped target string', () => {
    // engine.ts (Set D) is expected to define ZCASH_NETWORK = 'zec:mainnet'
    // (FIXED DECISIONS: target 'zec:mainnet'); this literal must match it.
    // Duplicated on purpose (moneroChains.ts does the same for MONERO_TARGET)
    // so this file needs no import from Set D.
    expect(ZCASH_TARGET).toBe('zec:mainnet');
  });

  it('recognises exactly the fixed target and nothing else', () => {
    expect(isZcashChainTarget('zec:mainnet')).toBe(true);
    expect(isZcashChainTarget('xmr:mainnet')).toBe(false);
    expect(isZcashChainTarget('evm:base')).toBe(false);
    expect(isZcashChainTarget('mainnet')).toBe(false);
    expect(isZcashChainTarget(null)).toBe(false);
    expect(isZcashChainTarget(undefined)).toBe(false);
    expect(isZcashChainTarget('')).toBe(false);
  });
});

describe('ZCASH_CHAIN', () => {
  it('matches the fixed decisions: ticker, decimals, family-shaped row', () => {
    expect(ZCASH_CHAIN.key).toBe('zcash');
    expect(ZCASH_CHAIN.displayName).toBe('Zcash');
    expect(ZCASH_CHAIN.nativeTicker).toBe('ZEC');
    expect(ZCASH_CHAIN.nativeDecimals).toBe(8);
    expect(ZCASH_CHAIN.homepage).toBe('https://z.cash');
    expect(ZCASH_CHAIN.young).toBe(false);
    expect(ZCASH_CHAIN.recentlyAdded).toBe(true);
    expect(ZCASH_CHAIN.nodeSets).toEqual(['main']);
    expect(ZCASH_CHAIN.defaultNodeSet).toBe('main');
  });

  it('uses the verified mainnet.zcashexplorer.app /transactions/{txid} path', () => {
    expect(ZCASH_CHAIN.explorerTxUrl).toBe('https://mainnet.zcashexplorer.app/transactions/{txid}');
  });

  it('is frozen: no chain-dispatch helper can accidentally mutate the shared row', () => {
    expect(Object.isFrozen(ZCASH_CHAIN)).toBe(true);
  });

  it('zcashChainInfo() returns the same singleton row', () => {
    expect(zcashChainInfo()).toBe(ZCASH_CHAIN);
  });
});

describe('zcashExplorerTxUrl', () => {
  it('substitutes the txid into the default chain row', () => {
    expect(zcashExplorerTxUrl('abc123')).toBe('https://mainnet.zcashexplorer.app/transactions/abc123');
  });

  it('accepts an explicit chain row (e.g. a future second explorer choice)', () => {
    expect(zcashExplorerTxUrl('deadbeef', { explorerTxUrl: 'https://blockchair.com/zcash/transaction/{txid}' })).toBe(
      'https://blockchair.com/zcash/transaction/deadbeef',
    );
  });
});
