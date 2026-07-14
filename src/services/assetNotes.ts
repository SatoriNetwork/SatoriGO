// Asset notes: small, data-driven disclaimers for on-chain assets whose name
// could be confused with something else (e.g. a rebranded / deprecated
// token). Keyed by the EXACT on-chain asset name — sub-assets ('SATORI/SUB'),
// unique assets ('SATORI#1') and reissuable variants ('SATORI!') are
// deliberately distinct on-chain assets and are NOT covered by a parent note.
//
// English-only, hardcoded strings — this is a live-chain safety surface, not
// a translated UI surface, matching the rest of src/screens/live.

export interface AssetNote {
  /** Very short label for a compact pill, e.g. next to the asset name. */
  badge: string;
  /** Full explanatory sentence(s) for a banner / detail view. */
  note: string;
}

export const ASSET_NOTES: Record<string, AssetNote> = {
  SATORI: {
    badge: 'legacy',
    note:
      'This is the legacy SATORI token. It is no longer used by the Satori Network. ' +
      'The current Satori asset on Evrmore is SATORIEVR.',
  },
};

/** True only for the exact, case-sensitive asset name 'SATORI' — not
 *  'SATORIEVR', not sub-assets ('SATORI/SUB'), not unique assets ('SATORI#1'),
 *  not reissuable markers ('SATORI!'), not lowercase. */
export function isLegacyAsset(name: string): boolean {
  return name === 'SATORI';
}

/** Looks up the note for an asset name, if one exists (exact match only). */
export function getAssetNote(name: string): AssetNote | undefined {
  return ASSET_NOTES[name];
}
