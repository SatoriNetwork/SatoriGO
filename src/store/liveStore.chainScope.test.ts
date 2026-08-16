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

  it('BTGS is native on Bitcoin Gold; the other chains\' tickers are not', () => {
    expect(isNativeAssetId('BTGS', 'bitcoingold-mainnet')).toBe(true);
    expect(isNativeAssetId(' btgs ', 'bitcoingold-mainnet')).toBe(true);
    expect(isNativeAssetId('EVR', 'bitcoingold-mainnet')).toBe(false);
    expect(isNativeAssetId('RVN', 'bitcoingold-mainnet')).toBe(false);
    expect(isNativeAssetId('BTGS', 'mainnet')).toBe(false);
  });

  it('LTC is native on Litecoin; the other chains\' tickers are not', () => {
    expect(isNativeAssetId('LTC', 'litecoin-mainnet')).toBe(true);
    expect(isNativeAssetId(' ltc ', 'litecoin-mainnet')).toBe(true);
    expect(isNativeAssetId('EVR', 'litecoin-mainnet')).toBe(false);
    expect(isNativeAssetId('RVN', 'litecoin-mainnet')).toBe(false);
    expect(isNativeAssetId('BTGS', 'litecoin-mainnet')).toBe(false);
    expect(isNativeAssetId('LTC', 'mainnet')).toBe(false);
  });

  it('WJK is native on WojakCoin; the other chains\' tickers are not', () => {
    expect(isNativeAssetId('WJK', 'wojakcoin-mainnet')).toBe(true);
    expect(isNativeAssetId(' wjk ', 'wojakcoin-mainnet')).toBe(true);
    expect(isNativeAssetId('EVR', 'wojakcoin-mainnet')).toBe(false);
    expect(isNativeAssetId('RVN', 'wojakcoin-mainnet')).toBe(false);
    expect(isNativeAssetId('BTGS', 'wojakcoin-mainnet')).toBe(false);
    expect(isNativeAssetId('LTC', 'wojakcoin-mainnet')).toBe(false);
    expect(isNativeAssetId('WJK', 'mainnet')).toBe(false);
  });

  it('BTC is native on Bitcoin; the other chains\' tickers are not', () => {
    expect(isNativeAssetId('BTC', 'bitcoin-mainnet')).toBe(true);
    expect(isNativeAssetId(' btc ', 'bitcoin-mainnet')).toBe(true);
    expect(isNativeAssetId('EVR', 'bitcoin-mainnet')).toBe(false);
    expect(isNativeAssetId('RVN', 'bitcoin-mainnet')).toBe(false);
    expect(isNativeAssetId('BTGS', 'bitcoin-mainnet')).toBe(false);
    expect(isNativeAssetId('LTC', 'bitcoin-mainnet')).toBe(false);
    expect(isNativeAssetId('WJK', 'bitcoin-mainnet')).toBe(false);
    expect(isNativeAssetId('BTC', 'mainnet')).toBe(false);
  });

  it('DOGE is native on Dogecoin; the other chains\' tickers are not', () => {
    expect(isNativeAssetId('DOGE', 'dogecoin-mainnet')).toBe(true);
    expect(isNativeAssetId(' doge ', 'dogecoin-mainnet')).toBe(true);
    expect(isNativeAssetId('EVR', 'dogecoin-mainnet')).toBe(false);
    expect(isNativeAssetId('RVN', 'dogecoin-mainnet')).toBe(false);
    expect(isNativeAssetId('BTGS', 'dogecoin-mainnet')).toBe(false);
    expect(isNativeAssetId('LTC', 'dogecoin-mainnet')).toBe(false);
    expect(isNativeAssetId('WJK', 'dogecoin-mainnet')).toBe(false);
    expect(isNativeAssetId('BTC', 'dogecoin-mainnet')).toBe(false);
    expect(isNativeAssetId('DOGE', 'mainnet')).toBe(false);
  });
});

describe('walletsOnChain', () => {
  const mixed = [
    { id: 'a', network: 'mainnet' },
    { id: 'b', network: 'ravencoin-mainnet' },
    { id: 'c', network: 'mainnet' },
    { id: 'd', network: 'testnet' },
    { id: 'e', network: 'bitcoingold-mainnet' },
    { id: 'f', network: 'litecoin-mainnet' },
    { id: 'g', network: 'wojakcoin-mainnet' },
    { id: 'h', network: 'bitcoin-mainnet' },
    { id: 'i', network: 'dogecoin-mainnet' },
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

  it('a Bitcoin Gold wallet only ever sees Bitcoin Gold wallets', () => {
    expect(walletsOnChain(mixed, 'bitcoingold-mainnet').map((w) => w.id)).toEqual(['e']);
  });

  it('a Litecoin wallet only ever sees Litecoin wallets', () => {
    expect(walletsOnChain(mixed, 'litecoin-mainnet').map((w) => w.id)).toEqual(['f']);
  });

  it('a WojakCoin wallet only ever sees WojakCoin wallets', () => {
    expect(walletsOnChain(mixed, 'wojakcoin-mainnet').map((w) => w.id)).toEqual(['g']);
  });

  it('a Bitcoin wallet only ever sees Bitcoin wallets', () => {
    expect(walletsOnChain(mixed, 'bitcoin-mainnet').map((w) => w.id)).toEqual(['h']);
  });

  it('a Dogecoin wallet only ever sees Dogecoin wallets', () => {
    expect(walletsOnChain(mixed, 'dogecoin-mainnet').map((w) => w.id)).toEqual(['i']);
  });
});
