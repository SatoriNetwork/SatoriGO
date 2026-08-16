// Pure selectors from liveStore, around the two assets the wallet is FOR: EVR and
// SATORIEVR are always shown and can never be removed.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PINNED_ASSETS,
  PROTECTED_ASSETS,
  applyDefaultPins,
  assetsSupported,
  computeDisplayedAssets,
  defaultPinsFor,
  isRemovableAsset,
  protectedAssetsFor,
  unhideProtected,
} from './liveStore';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';

const RVN = 'ravencoin-mainnet';
const BTGS = 'bitcoingold-mainnet';
const LTC = 'litecoin-mainnet';
const WJK = 'wojakcoin-mainnet';
const BTC = 'bitcoin-mainnet';

const asset = (name: string, amount = 0, isNative = false): LiveAssetBalance =>
  ({ name, amount, decimals: 8, isNative }) as LiveAssetBalance;

describe('isRemovableAsset', () => {
  it('protects EVR and SATORIEVR', () => {
    expect([...PROTECTED_ASSETS]).toEqual(['EVR', 'SATORIEVR']);
    expect(isRemovableAsset('EVR')).toBe(false);
    expect(isRemovableAsset('SATORIEVR')).toBe(false);
  });

  it('normalises case and whitespace, so no spelling sneaks past the guard', () => {
    expect(isRemovableAsset('satorievr')).toBe(false);
    expect(isRemovableAsset('  SatoriEvr  ')).toBe(false);
    expect(isRemovableAsset('evr')).toBe(false);
  });

  it('leaves every other asset removable, including the LEGACY SATORI token', () => {
    expect(isRemovableAsset('SATORI')).toBe(true); // the old token: still removable
    expect(isRemovableAsset('SATORIEVR/SUB')).toBe(true);
    expect(isRemovableAsset('FOO')).toBe(true);
  });
});

describe('applyDefaultPins', () => {
  it('pins SATORIEVR for a fresh wallet', () => {
    expect(applyDefaultPins([])).toEqual(['SATORIEVR']);
    expect([...DEFAULT_PINNED_ASSETS]).toEqual(['SATORIEVR']);
  });

  it('does not duplicate it, and keeps the user other pins', () => {
    expect(applyDefaultPins(['SATORIEVR'])).toEqual(['SATORIEVR']);
    expect(applyDefaultPins(['FOO'])).toEqual(['FOO', 'SATORIEVR']);
  });

  it('returns the SAME reference when nothing changes (so callers skip the write)', () => {
    const pinned = ['SATORIEVR'];
    expect(applyDefaultPins(pinned)).toBe(pinned);
  });
});

describe('unhideProtected', () => {
  it('undoes a SATORIEVR removal made by an older build', () => {
    // Before SATORIEVR became protected, users could remove it, which recorded the
    // name in `hidden`. Left alone, they would never see it again and would have no
    // control to undo it.
    expect(unhideProtected(['SATORIEVR'])).toEqual([]);
    expect(unhideProtected(['FOO', 'SATORIEVR', 'BAR'])).toEqual(['FOO', 'BAR']);
  });

  it('leaves a normal hide-list untouched, by reference', () => {
    const hidden = ['FOO', 'BAR'];
    expect(unhideProtected(hidden)).toBe(hidden);
  });
});

describe('computeDisplayedAssets', () => {
  it('shows SATORIEVR at zero on a brand-new wallet holding only EVR', () => {
    const displayed = computeDisplayedAssets([asset('EVR', 1.5, true)], applyDefaultPins([]), []);
    expect(displayed.map((a) => a.name)).toEqual(['EVR', 'SATORIEVR']);
    expect(displayed[1].amount).toBe(0);
  });

  it('shows the real balance once SATORIEVR is held, with no duplicate row', () => {
    const held = [asset('EVR', 1.5, true), asset('SATORIEVR', 42)];
    const displayed = computeDisplayedAssets(held, applyDefaultPins([]), []);
    expect(displayed.map((a) => a.name)).toEqual(['EVR', 'SATORIEVR']);
    expect(displayed[1].amount).toBe(42);
  });

  it('refuses to hide a protected asset even if the hide-list names one', () => {
    // Belt and braces: the store unhides these on load, but the selector must not
    // depend on that having happened.
    const held = [asset('EVR', 1.5, true), asset('SATORIEVR', 7)];
    const displayed = computeDisplayedAssets(held, [], ['EVR', 'SATORIEVR']);
    expect(displayed.map((a) => a.name)).toEqual(['EVR', 'SATORIEVR']);
  });

  it('still hides a removable asset', () => {
    const held = [asset('EVR', 1, true), asset('FOO', 5)];
    const displayed = computeDisplayedAssets(held, [], ['FOO']);
    expect(displayed.map((a) => a.name)).toEqual(['EVR']);
  });
});

// ---------------------------------------------------------------------------
// Per-chain protected assets / default pins (Ravencoin). Evrmore stays the
// default for every existing (no-chain) caller above; passing the RVN chain id
// switches the protected set to RVN-only with no default pins.
// ---------------------------------------------------------------------------
describe('per-chain protected assets (Ravencoin)', () => {
  it('protects RVN only (no EVR / SATORIEVR) on Ravencoin', () => {
    expect([...protectedAssetsFor(RVN)]).toEqual(['RVN']);
    expect(isRemovableAsset('RVN', RVN)).toBe(false);
    expect(isRemovableAsset('rvn', RVN)).toBe(false);
    // SATORIEVR and EVR are NOT protected on Ravencoin (Evrmore assets).
    expect(isRemovableAsset('SATORIEVR', RVN)).toBe(true);
    expect(isRemovableAsset('EVR', RVN)).toBe(true);
  });

  it('has NO default pins on Ravencoin (SATORIEVR is Evrmore-only)', () => {
    expect([...defaultPinsFor(RVN)]).toEqual([]);
    const pinned: string[] = [];
    // Same reference back (nothing to add) so callers skip a write.
    expect(applyDefaultPins(pinned, RVN)).toBe(pinned);
  });

  it('computeDisplayedAssets shows RVN first and pins nothing by default', () => {
    const held = [asset('RVN', 3, true)];
    const displayed = computeDisplayedAssets(held, applyDefaultPins([], RVN), [], RVN);
    expect(displayed.map((a) => a.name)).toEqual(['RVN']);
    expect(displayed[0].amount).toBe(3);
  });

  it('Evrmore default is unchanged when no chain id is passed', () => {
    expect([...protectedAssetsFor()]).toEqual(['EVR', 'SATORIEVR']);
    expect([...PROTECTED_ASSETS]).toEqual(['EVR', 'SATORIEVR']);
    expect([...DEFAULT_PINNED_ASSETS]).toEqual(['SATORIEVR']);
  });
});

// ---------------------------------------------------------------------------
// Per-chain protected assets / default pins (Bitcoin Gold). BTGS has no asset
// protocol at all (assetsSupported() is FALSE), so it protects and pins ONLY
// its native coin -- driven by the CAPABILITY, not a hardcoded 'BTGS' check.
// ---------------------------------------------------------------------------
describe('per-chain protected assets (Bitcoin Gold, no asset protocol)', () => {
  it('assetsSupported is false for Bitcoin Gold, true for Evrmore and Ravencoin', () => {
    expect(assetsSupported(BTGS)).toBe(false);
    expect(assetsSupported('mainnet')).toBe(true);
    expect(assetsSupported(RVN)).toBe(true);
  });

  it('protects BTGS only (nothing else can ever be held there)', () => {
    expect([...protectedAssetsFor(BTGS)]).toEqual(['BTGS']);
    expect(isRemovableAsset('BTGS', BTGS)).toBe(false);
    expect(isRemovableAsset('btgs', BTGS)).toBe(false);
    // Neither Evrmore's nor Ravencoin's native/asset names are protected here.
    expect(isRemovableAsset('SATORIEVR', BTGS)).toBe(true);
    expect(isRemovableAsset('EVR', BTGS)).toBe(true);
    expect(isRemovableAsset('RVN', BTGS)).toBe(true);
  });

  it('has NO default pins on Bitcoin Gold', () => {
    expect([...defaultPinsFor(BTGS)]).toEqual([]);
    const pinned: string[] = [];
    expect(applyDefaultPins(pinned, BTGS)).toBe(pinned);
  });

  it('computeDisplayedAssets shows only the native BTGS row', () => {
    const held = [asset('BTGS', 2.5, true)];
    const displayed = computeDisplayedAssets(held, applyDefaultPins([], BTGS), [], BTGS);
    expect(displayed.map((a) => a.name)).toEqual(['BTGS']);
    expect(displayed[0].amount).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// Per-chain protected assets / default pins (Litecoin). Litecoin has no asset
// protocol at all either (assetsSupported() is FALSE), so it protects and pins
// ONLY its native coin -- driven by the CAPABILITY, not a hardcoded 'LTC' check.
// ---------------------------------------------------------------------------
describe('per-chain protected assets (Litecoin, no asset protocol)', () => {
  it('assetsSupported is false for Litecoin, true for Evrmore and Ravencoin', () => {
    expect(assetsSupported(LTC)).toBe(false);
    expect(assetsSupported('mainnet')).toBe(true);
    expect(assetsSupported(RVN)).toBe(true);
  });

  it('protects LTC only (nothing else can ever be held there)', () => {
    expect([...protectedAssetsFor(LTC)]).toEqual(['LTC']);
    expect(isRemovableAsset('LTC', LTC)).toBe(false);
    expect(isRemovableAsset('ltc', LTC)).toBe(false);
    // Neither Evrmore's, Ravencoin's nor Bitcoin Gold's native/asset names are
    // protected here.
    expect(isRemovableAsset('SATORIEVR', LTC)).toBe(true);
    expect(isRemovableAsset('EVR', LTC)).toBe(true);
    expect(isRemovableAsset('RVN', LTC)).toBe(true);
    expect(isRemovableAsset('BTGS', LTC)).toBe(true);
  });

  it('has NO default pins on Litecoin', () => {
    expect([...defaultPinsFor(LTC)]).toEqual([]);
    const pinned: string[] = [];
    expect(applyDefaultPins(pinned, LTC)).toBe(pinned);
  });

  it('computeDisplayedAssets shows only the native LTC row', () => {
    const held = [asset('LTC', 1.25, true)];
    const displayed = computeDisplayedAssets(held, applyDefaultPins([], LTC), [], LTC);
    expect(displayed.map((a) => a.name)).toEqual(['LTC']);
    expect(displayed[0].amount).toBe(1.25);
  });
});

// ---------------------------------------------------------------------------
// Per-chain protected assets / default pins (WojakCoin). WojakCoin has no asset
// protocol at all either (assetsSupported() is FALSE), so it protects and pins
// ONLY its native coin -- driven by the CAPABILITY, not a hardcoded 'WJK' check.
// ---------------------------------------------------------------------------
describe('per-chain protected assets (WojakCoin, no asset protocol)', () => {
  it('assetsSupported is false for WojakCoin, true for Evrmore and Ravencoin', () => {
    expect(assetsSupported(WJK)).toBe(false);
    expect(assetsSupported('mainnet')).toBe(true);
    expect(assetsSupported(RVN)).toBe(true);
  });

  it('protects WJK only (nothing else can ever be held there)', () => {
    expect([...protectedAssetsFor(WJK)]).toEqual(['WJK']);
    expect(isRemovableAsset('WJK', WJK)).toBe(false);
    expect(isRemovableAsset('wjk', WJK)).toBe(false);
    // Neither Evrmore's, Ravencoin's, Bitcoin Gold's nor Litecoin's
    // native/asset names are protected here.
    expect(isRemovableAsset('SATORIEVR', WJK)).toBe(true);
    expect(isRemovableAsset('EVR', WJK)).toBe(true);
    expect(isRemovableAsset('RVN', WJK)).toBe(true);
    expect(isRemovableAsset('BTGS', WJK)).toBe(true);
    expect(isRemovableAsset('LTC', WJK)).toBe(true);
  });

  it('has NO default pins on WojakCoin', () => {
    expect([...defaultPinsFor(WJK)]).toEqual([]);
    const pinned: string[] = [];
    expect(applyDefaultPins(pinned, WJK)).toBe(pinned);
  });

  it('computeDisplayedAssets shows only the native WJK row', () => {
    const held = [asset('WJK', 4.5, true)];
    const displayed = computeDisplayedAssets(held, applyDefaultPins([], WJK), [], WJK);
    expect(displayed.map((a) => a.name)).toEqual(['WJK']);
    expect(displayed[0].amount).toBe(4.5);
  });
});

// ---------------------------------------------------------------------------
// Per-chain protected assets / default pins (Bitcoin). Bitcoin has no asset
// protocol at all either (assetsSupported() is FALSE), so it protects and pins
// ONLY its native coin -- driven by the CAPABILITY, not a hardcoded 'BTC' check.
// ---------------------------------------------------------------------------
describe('per-chain protected assets (Bitcoin, no asset protocol)', () => {
  it('assetsSupported is false for Bitcoin, true for Evrmore and Ravencoin', () => {
    expect(assetsSupported(BTC)).toBe(false);
    expect(assetsSupported('mainnet')).toBe(true);
    expect(assetsSupported(RVN)).toBe(true);
  });

  it('protects BTC only (nothing else can ever be held there)', () => {
    expect([...protectedAssetsFor(BTC)]).toEqual(['BTC']);
    expect(isRemovableAsset('BTC', BTC)).toBe(false);
    expect(isRemovableAsset('btc', BTC)).toBe(false);
    // Neither Evrmore's, Ravencoin's, Bitcoin Gold's, Litecoin's nor
    // WojakCoin's native/asset names are protected here.
    expect(isRemovableAsset('SATORIEVR', BTC)).toBe(true);
    expect(isRemovableAsset('EVR', BTC)).toBe(true);
    expect(isRemovableAsset('RVN', BTC)).toBe(true);
    expect(isRemovableAsset('BTGS', BTC)).toBe(true);
    expect(isRemovableAsset('LTC', BTC)).toBe(true);
    expect(isRemovableAsset('WJK', BTC)).toBe(true);
  });

  it('has NO default pins on Bitcoin', () => {
    expect([...defaultPinsFor(BTC)]).toEqual([]);
    const pinned: string[] = [];
    expect(applyDefaultPins(pinned, BTC)).toBe(pinned);
  });

  it('computeDisplayedAssets shows only the native BTC row', () => {
    const held = [asset('BTC', 0.5, true)];
    const displayed = computeDisplayedAssets(held, applyDefaultPins([], BTC), [], BTC);
    expect(displayed.map((a) => a.name)).toEqual(['BTC']);
    expect(displayed[0].amount).toBe(0.5);
  });
});
