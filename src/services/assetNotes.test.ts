import { describe, it, expect } from 'vitest';
import { isLegacyAsset, getAssetNote, ASSET_NOTES } from './assetNotes';

describe('isLegacyAsset', () => {
  it('is true for the exact legacy asset name SATORI', () => {
    expect(isLegacyAsset('SATORI')).toBe(true);
  });

  it('is false for the current asset SATORIEVR', () => {
    expect(isLegacyAsset('SATORIEVR')).toBe(false);
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

describe('getAssetNote / ASSET_NOTES', () => {
  it('returns the legacy note for SATORI with a badge and full explanatory note', () => {
    const note = getAssetNote('SATORI');
    expect(note).toBeDefined();
    expect(note?.badge).toBe('legacy');
    expect(note?.note).toBe(
      'This is the legacy SATORI token. It is no longer used by the Satori Network. ' +
        'The current Satori asset on Evrmore is SATORIEVR.',
    );
  });

  it('returns undefined for assets with no note', () => {
    expect(getAssetNote('SATORIEVR')).toBeUndefined();
    expect(getAssetNote('EVR')).toBeUndefined();
  });

  it('returns no note for SATORI on Ravencoin (not legacy there)', () => {
    expect(getAssetNote('SATORI', 'RVN')).toBeUndefined();
    expect(getAssetNote('SATORI', 'EVR')).toBeDefined();
  });

  it('is data-driven: ASSET_NOTES is keyed exactly by SATORI', () => {
    expect(Object.keys(ASSET_NOTES)).toEqual(['SATORI']);
  });
});
