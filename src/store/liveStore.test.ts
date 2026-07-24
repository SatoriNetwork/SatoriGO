// Pure selectors from liveStore, around the two assets the wallet is FOR: EVR and
// SATORIEVR are always shown and can never be removed.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PINNED_ASSETS,
  PROTECTED_ASSETS,
  applyDefaultPins,
  computeDisplayedAssets,
  defaultPinsFor,
  isRemovableAsset,
  protectedAssetsFor,
  unhideProtected,
} from './liveStore';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';

const RVN = 'ravencoin-mainnet';

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
