// Chain picker for wallet create/import: a simple two-option Evrmore/Ravencoin
// selector, reusing the existing `Segmented` toggle pattern (same one used for
// the theme picker in Settings). Evrmore is always the default/preselected
// option. Scope decision for this phase: ONE chain per wallet entry, no "both"
// option.
//
// Kept dependency-free (no store import) so it can be unit-tested in isolation
// as a plain controlled component.

import { Info } from 'lucide-react';
import { Segmented } from '../../components/Segmented';
import type { LiveNetworkId } from '../../services/chain/liveWallet';

/** One chain per wallet entry (scope decision for this phase: no "both" option).
 *  'mainnet' is the legacy LiveNetworkId for Evrmore mainnet. */
export type ChainChoice = Extract<LiveNetworkId, 'mainnet' | 'ravencoin-mainnet'>;

export const CHAIN_OPTIONS: { value: ChainChoice; label: string }[] = [
  { value: 'mainnet', label: 'Evrmore' },
  { value: 'ravencoin-mainnet', label: 'Ravencoin' },
];

export interface ChainPickerProps {
  value: ChainChoice;
  onChange(v: ChainChoice): void;
  testIdPrefix: string;
  /** Adjusts the privacy-note wording for what's actually being reused. */
  secretKind: 'phrase' | 'key';
}

/** Chain picker shown at wallet create AND import (seed + private key): Evrmore
 *  is preselected. Selecting Ravencoin surfaces a short privacy note, because the
 *  two chains share key derivation (same seed/key -> same address on both, modulo
 *  the version byte) -- a fact the user should know before they treat the chains
 *  as unrelated for privacy purposes. */
export function ChainPicker({ value, onChange, testIdPrefix, secretKind }: ChainPickerProps) {
  return (
    <div className="field" style={{ marginBottom: 13 }}>
      <label>Chain</label>
      <Segmented<ChainChoice> options={CHAIN_OPTIONS} value={value} onChange={onChange} testIdPrefix={testIdPrefix} />
      {value === 'ravencoin-mainnet' && (
        <div
          className="banner info"
          data-testid={`${testIdPrefix}-privacy-note`}
          style={{ marginTop: 8, alignItems: 'flex-start' }}
        >
          <Info size={14} />
          <span>
            {secretKind === 'key'
              ? "Evrmore and Ravencoin share the same key derivation. This private key already has a matching address on the other chain: revealing your R address also reveals the matching E address (they share the same key). You can add the other chain later by importing the same private key again and picking the other network."
              : 'Evrmore and Ravencoin share the same key derivation. The same recovery phrase gives one wallet on each chain, and revealing your R address also reveals the matching E address (they share the same key). You can add the other chain later by importing the same phrase again and picking the other network.'}
          </span>
        </div>
      )}
    </div>
  );
}
