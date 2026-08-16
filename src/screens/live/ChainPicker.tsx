// Chain picker for wallet create/import: a simple Evrmore/Ravencoin/Bitcoin
// Gold/Litecoin/WojakCoin/Bitcoin/Dogecoin selector, reusing the existing `Segmented`
// toggle pattern (same one used for the theme picker in Settings). Evrmore is
// always the default/preselected option. Scope decision for this phase: ONE
// chain per wallet entry, no "both" option.
//
// Kept dependency-free of the live store/service (no store import) so it can be
// unit-tested in isolation as a plain controlled component; TokenIcon only
// depends on the (separate) branding store, already used the same way by every
// other Live screen.

import { Info } from 'lucide-react';
import { Segmented, type SegmentedOption } from '../../components/Segmented';
import { TokenIcon } from '../../components/BrandLogo';
import type { LiveNetworkId } from '../../services/chain/liveWallet';
// chainParams is a pure data module (it imports nothing), so reading the display
// names from it keeps this component free of the store/service while removing the
// duplicated name list that drifted when a chain was renamed.
import {
  EVRMORE_MAINNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  BITCOIN_MAINNET,
  DOGECOIN_MAINNET,
} from '../../services/chain/chainParams';

/** One chain per wallet entry (scope decision for this phase: no "both" option).
 *  'mainnet' is the legacy LiveNetworkId for Evrmore mainnet. */
export type ChainChoice = Extract<
  LiveNetworkId,
  | 'mainnet'
  | 'ravencoin-mainnet'
  | 'bitcoingold-mainnet'
  | 'litecoin-mainnet'
  | 'wojakcoin-mainnet'
  | 'bitcoin-mainnet'
  | 'dogecoin-mainnet'
>;

// The picker VALUE is the LiveNetworkId, which is not always the params' chainId:
// Evrmore's is the legacy bare 'mainnet' (kept so existing installs keep working),
// so the value is stated explicitly per row and only the name/ticker come from the
// chain params. Deriving the value too would silently send 'evrmore-mainnet' here.
// ORDER IS OWNER-SPECIFIED (2026-08-14; Dogecoin slotted third by the owner
// 2026-08-15) and is the display order everywhere the chain list appears: the
// header switcher reads this same array. It is NOT alphabetical and NOT the
// order chains were added, so do not "tidy" it.
/** value -> canonical chainId, built from the same table as CHAIN_OPTIONS so the
 *  two cannot disagree. */
export const CHAIN_OPTIONS_BY_VALUE: Record<ChainChoice, string> = {
  mainnet: EVRMORE_MAINNET.chainId,
  'ravencoin-mainnet': RAVENCOIN_MAINNET.chainId,
  'bitcoingold-mainnet': BITCOINGOLD_MAINNET.chainId,
  'litecoin-mainnet': LITECOIN_MAINNET.chainId,
  'wojakcoin-mainnet': WOJAKCOIN_MAINNET.chainId,
  'bitcoin-mainnet': BITCOIN_MAINNET.chainId,
  'dogecoin-mainnet': DOGECOIN_MAINNET.chainId,
};

export const CHAIN_OPTIONS: SegmentedOption<ChainChoice>[] = (
  [
    ['bitcoin-mainnet', BITCOIN_MAINNET],
    ['litecoin-mainnet', LITECOIN_MAINNET],
    ['dogecoin-mainnet', DOGECOIN_MAINNET],
    ['mainnet', EVRMORE_MAINNET],
    ['ravencoin-mainnet', RAVENCOIN_MAINNET],
    ['bitcoingold-mainnet', BITCOINGOLD_MAINNET],
    ['wojakcoin-mainnet', WOJAKCOIN_MAINNET],
  ] as const
).map(([value, net]) => ({
  value,
  label: net.displayName,
  icon: <TokenIcon assetId={net.ticker} size={14} />,
}));

/** Canonical chainId for a picker value. Evrmore's value is the legacy bare
 *  'mainnet', so the two are not interchangeable and hiding must compare the
 *  canonical form. */
function chainIdOf(value: ChainChoice): string {
  return CHAIN_OPTIONS_BY_VALUE[value];
}

export interface ChainPickerProps {
  /** Canonical chainIds hidden in expert Settings. Passed in rather than read
   *  from the store so this component stays store-free and unit-testable on its
   *  own. A hidden chain cannot be picked for a new wallet. */
  hidden?: readonly string[];
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
 *  as unrelated for privacy purposes. Bitcoin Gold and Litecoin each use their
 *  own coin type and a different derivation purpose (BIP84, native segwit),
 *  WojakCoin uses its own coin type too (20760, legacy BIP44 purpose), and
 *  Bitcoin and Dogecoin likewise each use their own coin type (0 and 3), so
 *  none of the five shares an address with any other chain here and none gets
 *  a privacy note. */
export function ChainPicker({
  hidden,
  value,
  onChange,
  testIdPrefix,
  secretKind,
}: ChainPickerProps) {
  // The selected chain always stays listed: hiding the option the form is
  // currently set to would leave a picker with nothing selected.
  const options = hidden?.length
    ? CHAIN_OPTIONS.filter((o) => !hidden.includes(chainIdOf(o.value)) || o.value === value)
    : CHAIN_OPTIONS;
  return (
    <div className="field" style={{ marginBottom: 13 }}>
      <label>Chain</label>
      <Segmented<ChainChoice>
        options={options}
        value={value}
        onChange={onChange}
        testIdPrefix={testIdPrefix}
        wrap
      />
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
