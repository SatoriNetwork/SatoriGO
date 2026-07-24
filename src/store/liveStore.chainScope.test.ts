// Chain scoping of the send path. Two rules proven here:
//
// 1. isNativeAssetId: the send dispatch decides native-vs-asset against the
//    ACTIVE CHAIN's ticker. The regression this guards: a literal `=== 'EVR'`
//    check sent native RVN down the ASSET path, which asked the chain for an
//    asset named "RVN" and failed with unknown-asset at review.
//
// 2. walletsOnChain: cross-chain sends are impossible (an R... wallet cannot
//    receive EVR and vice versa), so every recipient picker must be scoped to
//    the active wallet's chain. Owner rule; applies to every future chain.
//
// All calls pass the chainId explicitly, so these are pure (no service state).
import { describe, expect, it } from 'vitest';

import { isNativeAssetId, walletsOnChain } from './liveStore';

describe('isNativeAssetId', () => {
  it('EVR is native on Evrmore, an asset name is not', () => {
    expect(isNativeAssetId('EVR', 'mainnet')).toBe(true);
    expect(isNativeAssetId('SATORIEVR', 'mainnet')).toBe(false);
    expect(isNativeAssetId('SATORI', 'mainnet')).toBe(false);
  });

  it('RVN is native on Ravencoin (THE regression: it must never be an asset there)', () => {
    expect(isNativeAssetId('RVN', 'ravencoin-mainnet')).toBe(true);
    expect(isNativeAssetId('SATORI', 'ravencoin-mainnet')).toBe(false);
  });

  it('the OTHER chain\'s native ticker is just an asset name here', () => {
    // 'EVR' on Ravencoin / 'RVN' on Evrmore: not native, so the asset path (and
    // its on-chain existence check) is the correct route for them.
    expect(isNativeAssetId('EVR', 'ravencoin-mainnet')).toBe(false);
    expect(isNativeAssetId('RVN', 'mainnet')).toBe(false);
  });

  it('normalises case and whitespace', () => {
    expect(isNativeAssetId(' rvn ', 'ravencoin-mainnet')).toBe(true);
    expect(isNativeAssetId('evr', 'mainnet')).toBe(true);
  });

  it('testnet resolves to the EVR ticker', () => {
    expect(isNativeAssetId('EVR', 'testnet')).toBe(true);
    expect(isNativeAssetId('RVN', 'testnet')).toBe(false);
  });
});

describe('walletsOnChain', () => {
  const mixed = [
    { id: 'a', network: 'mainnet' },
    { id: 'b', network: 'ravencoin-mainnet' },
    { id: 'c', network: 'mainnet' },
    { id: 'd', network: 'testnet' },
  ];

  it('an Evrmore wallet only ever sees Evrmore-mainnet wallets', () => {
    expect(walletsOnChain(mixed, 'mainnet').map((w) => w.id)).toEqual(['a', 'c']);
  });

  it('a Ravencoin wallet only ever sees Ravencoin wallets', () => {
    expect(walletsOnChain(mixed, 'ravencoin-mainnet').map((w) => w.id)).toEqual(['b']);
  });

  it('testnet is its own chain: mainnet wallets are not valid recipients there', () => {
    expect(walletsOnChain(mixed, 'testnet').map((w) => w.id)).toEqual(['d']);
  });

  it('no same-chain wallets means an empty list, never a cross-chain fallback', () => {
    expect(walletsOnChain([{ id: 'x', network: 'mainnet' }], 'ravencoin-mainnet')).toEqual([]);
  });
});
