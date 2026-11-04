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
  /** One line under the Send form. */
  sendNote: string;
}

/** The official SATORI ERC-20 on Base since the migration from Evrmore. */
export const SATORI_BASE_TOKEN = '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17';

export const ASSET_NOTES: Record<string, AssetNote> = {
  SATORI: {
    badge: 'legacy',
    note:
      'This is the legacy SATORI token. It is no longer used by the Satori Network. ' +
      `Satori now lives on Base, where the official SATORI token is ${SATORI_BASE_TOKEN}.`,
    sendNote: 'Legacy SATORI. The Satori Network now uses SATORI on Base.',
  },
  SATORIEVR: {
    badge: 'old token',
    note:
      `SATORIEVR is the old Satori token. Satori has moved to Base, where the official SATORI token is ${SATORI_BASE_TOKEN}. ` +
      'Pool staking on Evrmore has ended. Your SATORIEVR stays yours, and you can still send and receive it.',
    sendNote: 'SATORIEVR is the old Satori token. Satori now lives on Base.',
  },
};

/** True only for the exact, case-sensitive asset names 'SATORI' and 'SATORIEVR',
 *  AND only on Evrmore, where Satori no longer lives since the move to Base. On
 *  Ravencoin (nativeTicker 'RVN') SATORI is just an ordinary asset, so it is never
 *  flagged legacy there. Not sub-assets ('SATORI/SUB'), not unique assets
 *  ('SATORI#1'), not reissuable markers ('SATORI!'), not lowercase.
 *  `nativeTicker` defaults to 'EVR' so existing Evrmore callers/tests are unchanged. */
export function isLegacyAsset(name: string, nativeTicker: string = 'EVR'): boolean {
  return (name === 'SATORI' || name === 'SATORIEVR') && nativeTicker === 'EVR';
}

/** Looks up the note for an asset name, if one applies on the given chain (exact
 *  match only). Returns undefined where the asset is not legacy on that chain. */
export function getAssetNote(name: string, nativeTicker: string = 'EVR'): AssetNote | undefined {
  return isLegacyAsset(name, nativeTicker) ? ASSET_NOTES[name] : undefined;
}
