import { describe, it, expect } from 'vitest';
import { isLegacyAsset, getAssetNote, pricedTickerFor, ASSET_NOTES } from './assetNotes';

describe('isLegacyAsset', () => {
  it('is true for the exact legacy asset name SATORI', () => {
    expect(isLegacyAsset('SATORI')).toBe(true);
  });

  it('is true for the old Evrmore token SATORIEVR', () => {
    expect(isLegacyAsset('SATORIEVR')).toBe(true);
  });

  it('is false for a reissuable marker SATORI!', () => {
    expect(isLegacyAsset('SATORI!')).toBe(false);
  });

  it('is false for a sub-asset SATORI/SUB', () => {
    expect(isLegacyAsset('SATORI/SUB')).toBe(false);
  });

  it('is false for a unique asset SATORI#1', () => {
    expect(isLegacyAsset('SATORI#1')).toBe(false);
  });

  it('is case-sensitive: lowercase satori is not legacy', () => {
    expect(isLegacyAsset('satori')).toBe(false);
  });

  it('is false for unrelated assets like EVR', () => {
    expect(isLegacyAsset('EVR')).toBe(false);
  });

  it('is false for an empty string', () => {
    expect(isLegacyAsset('')).toBe(false);
  });

  it('defaults to Evrmore: SATORI is legacy when no chain is given', () => {
    expect(isLegacyAsset('SATORI')).toBe(true);
    expect(isLegacyAsset('SATORI', 'EVR')).toBe(true);
  });

  it('is NOT legacy on Ravencoin: there SATORI is just an ordinary asset', () => {
    expect(isLegacyAsset('SATORI', 'RVN')).toBe(false);
    // SATORIEVR is not a normal RVN asset name but still never "legacy" anywhere.
    expect(isLegacyAsset('SATORIEVR', 'RVN')).toBe(false);
  });
});

describe('pricedTickerFor', () => {
  it('prices the Base SATORI token at the SATORIEVR quote only when it is the official contract', () => {
    expect(pricedTickerFor('SATORI', false, true)).toBe('SATORIEVR');
    expect(pricedTickerFor('SATORI', false, false)).toBeNull();
  });

  it('keeps the chain coin and SATORIEVR, and never prices another token by name', () => {
    expect(pricedTickerFor('ETH', true, false)).toBe('ETH');
    expect(pricedTickerFor('SATORIEVR', false, false)).toBe('SATORIEVR');
    expect(pricedTickerFor('BTC', false, true)).toBeNull();
  });
});

describe('getAssetNote / ASSET_NOTES', () => {
  it('returns the legacy note for SATORI with a badge and full explanatory note', () => {
    const note = getAssetNote('SATORI');
    expect(note).toBeDefined();
    expect(note?.badge).toBe('legacy');
    expect(note?.note).toBe(
      'This is the legacy SATORI token. It is no longer used by the Satori Network. ' +
        'Satori now lives on Base, where the official SATORI token is 0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17.',
    );
  });

  it('marks SATORIEVR as the old token, says staking ended and that it can still be sent', () => {
    const note = getAssetNote('SATORIEVR');
    expect(note?.badge).toBe('old token');
    expect(note?.note).toContain('0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17');
    expect(note?.note).toContain('Pool staking on Evrmore has ended');
    expect(note?.note).toContain('send and receive');
  });

  it('returns undefined for assets with no note', () => {
    expect(getAssetNote('EVR')).toBeUndefined();
  });

  it('returns no note for SATORI on Ravencoin (not legacy there)', () => {
    expect(getAssetNote('SATORI', 'RVN')).toBeUndefined();
    expect(getAssetNote('SATORI', 'EVR')).toBeDefined();
  });

  it('is data-driven: ASSET_NOTES is keyed exactly by SATORI and SATORIEVR', () => {
    expect(Object.keys(ASSET_NOTES)).toEqual(['SATORI', 'SATORIEVR']);
  });
});
