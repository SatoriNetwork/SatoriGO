// profile.test.ts: the pinned profile equals the gateway's digest of the
// spec-470 metadata; a reordered extension list, a moved pallet,
// balanceBytes 16 and extrinsicVersion 5 each refuse; a spec bump with an
// equal layout accepts for the session.

import { describe, expect, it } from 'vitest';
import { ProfileError, compareProfiles, parseTaoRuntimeProfile, sameLayout, withVersions, type TaoRuntimeProfile } from './profile';
import {
  TAO_ERA_PERIOD,
  TAO_EXISTENTIAL_DEPOSIT,
  TAO_GENESIS,
  TAO_PROFILE,
  TAO_SIGNED_EXTENSIONS,
  TAO_SPEC_VERSION,
  TAO_TRANSACTION_VERSION,
} from './tao';
import { SPEC470_DIGEST } from './testing/fixtures';

describe('the pinned profile', () => {
  it('is spec 470 / tx 1 on the Finney genesis with Balances at 5 and thirteen extensions', () => {
    expect(TAO_PROFILE.specName).toBe('node-subtensor');
    expect(TAO_SPEC_VERSION).toBe(470);
    expect(TAO_TRANSACTION_VERSION).toBe(1);
    expect(TAO_GENESIS).toBe('0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03');
    expect(TAO_PROFILE.balances).toEqual({ pallet: 5, transfer_allow_death: 0, transfer_keep_alive: 3, transfer_all: 4 });
    expect(TAO_PROFILE.signedExtensions).toHaveLength(13);
    expect(TAO_PROFILE.signedExtensions[4]).toBe('CheckMortality');
    expect(TAO_PROFILE.signedExtensions[12]).toBe('CheckMetadataHash');
    expect(TAO_PROFILE.extrinsicVersion).toBe(4);
    expect(TAO_PROFILE.balanceBytes).toBe(8);
    expect(TAO_PROFILE.ss58).toBe(42);
    expect(TAO_PROFILE.decimals).toBe(9);
    expect(TAO_PROFILE.symbol).toBe('TAO');
    expect(TAO_PROFILE.existentialDeposit).toBe(500n);
    expect(TAO_EXISTENTIAL_DEPOSIT).toBe(500n);
    expect(TAO_ERA_PERIOD).toBe(64);
    expect(Object.isFrozen(TAO_PROFILE)).toBe(true);
    expect(Object.isFrozen(TAO_SIGNED_EXTENSIONS)).toBe(true);
  });

  it("equals the gateway's digest of the spec-470 metadata", () => {
    const live = parseTaoRuntimeProfile(SPEC470_DIGEST);
    expect(live).toEqual({ ...TAO_PROFILE, signedExtensions: [...TAO_SIGNED_EXTENSIONS] });
    expect(sameLayout(TAO_PROFILE, live)).toBe(true);
    expect(compareProfiles(TAO_PROFILE, live)).toBe('same');
  });
});

describe('compareProfiles', () => {
  const live = (): TaoRuntimeProfile => parseTaoRuntimeProfile(SPEC470_DIGEST);

  it('a spec bump (471) or tx bump with an equal layout is version-only', () => {
    expect(compareProfiles(TAO_PROFILE, { ...live(), specVersion: 471 })).toBe('version-only');
    expect(compareProfiles(TAO_PROFILE, { ...live(), transactionVersion: 2 })).toBe('version-only');
    expect(compareProfiles(TAO_PROFILE, withVersions(TAO_PROFILE, { specVersion: 999, transactionVersion: 1 }))).toBe('version-only');
    const patched = withVersions(TAO_PROFILE, { specVersion: 471, transactionVersion: 1 });
    expect(patched.specVersion).toBe(471);
    expect(patched.balances).toBe(TAO_PROFILE.balances);
  });

  it('a reordered extension list refuses', () => {
    const ext = [...TAO_SIGNED_EXTENSIONS];
    [ext[4], ext[5]] = [ext[5], ext[4]];
    expect(compareProfiles(TAO_PROFILE, { ...live(), signedExtensions: ext })).toBe('layout-changed');
  });

  it('an added or removed extension refuses, even a Null one', () => {
    expect(compareProfiles(TAO_PROFILE, { ...live(), signedExtensions: [...TAO_SIGNED_EXTENSIONS, 'CheckSomethingNew'] })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), signedExtensions: TAO_SIGNED_EXTENSIONS.slice(0, 12) })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), signedExtensions: TAO_SIGNED_EXTENSIONS.filter((e) => e !== 'DrandPriority') })).toBe('layout-changed');
  });

  it('a moved pallet or call index refuses', () => {
    expect(compareProfiles(TAO_PROFILE, { ...live(), balances: { ...TAO_PROFILE.balances, pallet: 6 } })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), balances: { ...TAO_PROFILE.balances, transfer_keep_alive: 2 } })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), balances: { ...TAO_PROFILE.balances, transfer_all: 5 } })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), balances: { ...TAO_PROFILE.balances, transfer_allow_death: 1 } })).toBe('layout-changed');
  });

  it('balanceBytes 16 and extrinsicVersion 5 refuse (the parser refuses them outright; a hand-built profile compares as changed)', () => {
    expect(() => parseTaoRuntimeProfile({ ...SPEC470_DIGEST, balanceBytes: 16 })).toThrow(ProfileError);
    expect(() => parseTaoRuntimeProfile({ ...SPEC470_DIGEST, extrinsicVersion: 5 })).toThrow(ProfileError);
    expect(compareProfiles(TAO_PROFILE, { ...live(), balanceBytes: 16 as 8 })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), extrinsicVersion: 5 as 4 })).toBe('layout-changed');
  });

  it('a different genesis, ss58, decimals, symbol, ED or spec name refuses', () => {
    expect(compareProfiles(TAO_PROFILE, { ...live(), genesis: '0x8f9cf856' + '00'.repeat(28) })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), ss58: 0 })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), decimals: 12 })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), symbol: 'DOT' })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), existentialDeposit: 1000n })).toBe('layout-changed');
    expect(compareProfiles(TAO_PROFILE, { ...live(), specName: 'polkadot' })).toBe('layout-changed');
  });

  it('a version bump AND a layout change is layout-changed, never version-only', () => {
    expect(compareProfiles(TAO_PROFILE, { ...live(), specVersion: 471, balances: { ...TAO_PROFILE.balances, pallet: 6 } })).toBe('layout-changed');
  });

  it('genesis comparison ignores hex case', () => {
    expect(compareProfiles(TAO_PROFILE, { ...live(), genesis: TAO_GENESIS.toUpperCase().replace('0X', '0x') })).toBe('same');
  });
});

describe('parseTaoRuntimeProfile', () => {
  it('reads the ED as a decimal string or a number, and ignores node and finalizedHeight', () => {
    const a = parseTaoRuntimeProfile(SPEC470_DIGEST);
    expect(a.existentialDeposit).toBe(500n);
    expect('node' in a).toBe(false);
    expect(parseTaoRuntimeProfile({ ...SPEC470_DIGEST, existentialDeposit: 500 }).existentialDeposit).toBe(500n);
  });

  it('refuses a missing or malformed field rather than comparing a guess', () => {
    const bad: unknown[] = [
      null,
      'digest',
      {},
      { ...SPEC470_DIGEST, genesis: '0x1234' },
      { ...SPEC470_DIGEST, specVersion: '470' },
      { ...SPEC470_DIGEST, specVersion: -1 },
      { ...SPEC470_DIGEST, existentialDeposit: '5e2' },
      { ...SPEC470_DIGEST, existentialDeposit: -1 },
      { ...SPEC470_DIGEST, balances: null },
      { ...SPEC470_DIGEST, balances: { pallet: 5 } },
      { ...SPEC470_DIGEST, signedExtensions: [] },
      { ...SPEC470_DIGEST, signedExtensions: 'CheckNonce' },
      { ...SPEC470_DIGEST, signedExtensions: ['CheckNonce', 3] },
      { ...SPEC470_DIGEST, symbol: '' },
      { ...SPEC470_DIGEST, ss58: 1.5 },
    ];
    for (const b of bad) expect(() => parseTaoRuntimeProfile(b), JSON.stringify(b)).toThrow(ProfileError);
  });

  it('returns a frozen extension list and a lowercase genesis', () => {
    const p = parseTaoRuntimeProfile({ ...SPEC470_DIGEST, genesis: SPEC470_DIGEST.genesis.toUpperCase().replace('0X', '0x') });
    expect(Object.isFrozen(p.signedExtensions)).toBe(true);
    expect(p.genesis).toBe(TAO_GENESIS);
  });
});
