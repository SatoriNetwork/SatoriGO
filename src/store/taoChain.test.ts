import { describe, it, expect } from 'vitest';
import {
  TAO_TARGET,
  isTaoChainTarget,
  TAO_CHAIN,
  TAO_HOMEPAGE,
  TAO_EXPLORER_TX_URL,
  TAO_EXPLORER_ACCOUNT_URL,
  taoExplorerTxUrl,
  taoExplorerAccountUrl,
} from './taoChain';

describe('TAO_TARGET / isTaoChainTarget', () => {
  it('is the fixed target string', () => {
    expect(TAO_TARGET).toBe('tao:mainnet');
  });

  it('recognises only the exact target', () => {
    expect(isTaoChainTarget('tao:mainnet')).toBe(true);
    expect(isTaoChainTarget('tao:testnet')).toBe(false);
    expect(isTaoChainTarget('xmr:mainnet')).toBe(false);
    expect(isTaoChainTarget(undefined)).toBe(false);
    expect(isTaoChainTarget(null)).toBe(false);
    expect(isTaoChainTarget('')).toBe(false);
  });
});

describe('TAO_CHAIN', () => {
  it('is plain, synchronous data (no build flag, no async loader)', () => {
    expect(TAO_CHAIN.key).toBe('bittensor');
    expect(TAO_CHAIN.displayName).toBe('Bittensor');
    expect(TAO_CHAIN.nativeTicker).toBe('TAO');
    expect(TAO_CHAIN.nativeDecimals).toBe(9);
    expect(TAO_CHAIN.homepage).toBe(TAO_HOMEPAGE);
    expect(TAO_CHAIN.young).toBe(false);
    expect(TAO_CHAIN.recentlyAdded).toBe(true);
  });

  it('ships exactly one node set: main (test is smoke-only, never offered)', () => {
    expect(TAO_CHAIN.nodeSets).toEqual(['main']);
    expect(TAO_CHAIN.defaultNodeSet).toBe('main');
  });

  it('carries both explorer templates', () => {
    expect(TAO_CHAIN.explorerTxUrl).toBe(TAO_EXPLORER_TX_URL);
    expect(TAO_CHAIN.explorerAccountUrl).toBe(TAO_EXPLORER_ACCOUNT_URL);
  });
});

describe('taoExplorerTxUrl', () => {
  it('substitutes the hash into the extrinsic template', () => {
    expect(taoExplorerTxUrl('0xabc123')).toBe('https://taostats.io/extrinsic/0xabc123');
  });
});

describe('taoExplorerAccountUrl', () => {
  it('substitutes the address into the account template (the v1 Activity link)', () => {
    expect(taoExplorerAccountUrl('5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH')).toBe(
      'https://taostats.io/account/5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH',
    );
  });
});
