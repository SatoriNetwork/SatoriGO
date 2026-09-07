// Chain picker for wallet create/import: a simple Evrmore/Ravencoin/Bitcoin
// Gold/Litecoin/WojakCoin/Bitcoin/Dogecoin selector, reusing the existing `Segmented`
// toggle pattern (same one used for the theme picker in Settings). Evrmore is
// always the default/preselected option. Scope decision for this phase: ONE
// chain per wallet entry, no "both" option (an EVM choice is one exception in
// letter only: it is still ONE row, because it is one account for every EVM
// chain, see the EVM engine design notes §1).
//
// Kept dependency-free of the live store/service (no store import) so it can be
// unit-tested in isolation as a plain controlled component; TokenIcon only
// depends on the (separate) branding store, already used the same way by every
// other Live screen. The EVM rows are opt-in data (the `evmChains` prop, empty
// or omitted in a build without the EVM engine), not a store read, so this stays
// exactly as store-free as before.

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
  NEOXA_MAINNET,
  BITCOIN_BLAKE2B_MAINNET,
} from '../../services/chain/chainParams';
// evmChains is plain data + string helpers (no store import, no service import),
// so pulling EvmChainTarget/isEvmChainTarget/evmChainTarget from it keeps this
// component exactly as store-free as before while it learns to widen its value
// type to cover an EVM chain.
import { evmChainTarget, isEvmChainTarget, type EvmChainInfo, type EvmChainTarget } from '../../store/evmChains';

/** One UTXO chain per wallet entry (scope decision for this phase: no "both"
 *  option). 'mainnet' is the legacy LiveNetworkId for Evrmore mainnet. */
export type UtxoChainChoice = Extract<
  LiveNetworkId,
  | 'mainnet'
  | 'ravencoin-mainnet'
  | 'bitcoingold-mainnet'
  | 'litecoin-mainnet'
  | 'wojakcoin-mainnet'
  | 'bitcoin-mainnet'
  | 'dogecoin-mainnet'
  | 'neoxa-mainnet'
  | 'bitcoinblake2b-mainnet'
>;

/** A pickable chain: any UTXO chain above, OR the `evm:<key>` target of an EVM
 *  chain this build carries. An EVM choice is ONE account that spans every EVM
 *  chain (see the EVM engine design notes §1), so it is a single extra row here,
 *  not one row per EVM chain the way UTXO chains are. */
export type ChainChoice = UtxoChainChoice | EvmChainTarget;

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
export const CHAIN_OPTIONS_BY_VALUE: Record<UtxoChainChoice, string> = {
  mainnet: EVRMORE_MAINNET.chainId,
  'ravencoin-mainnet': RAVENCOIN_MAINNET.chainId,
  'bitcoingold-mainnet': BITCOINGOLD_MAINNET.chainId,
  'litecoin-mainnet': LITECOIN_MAINNET.chainId,
  'wojakcoin-mainnet': WOJAKCOIN_MAINNET.chainId,
  'bitcoin-mainnet': BITCOIN_MAINNET.chainId,
  'dogecoin-mainnet': DOGECOIN_MAINNET.chainId,
  'neoxa-mainnet': NEOXA_MAINNET.chainId,
  'bitcoinblake2b-mainnet': BITCOIN_BLAKE2B_MAINNET.chainId,
};

/** UTXO chain rows only, kept exported as before for callers that only ever
 *  meant the UTXO list (PICKABLE_NETWORKS, the WIF version-byte check). Use
 *  `chainOptionsFor` for the full picker/switcher row list. */
export const CHAIN_OPTIONS: SegmentedOption<UtxoChainChoice>[] = (
  [
    ['bitcoin-mainnet', BITCOIN_MAINNET],
    ['litecoin-mainnet', LITECOIN_MAINNET],
    ['dogecoin-mainnet', DOGECOIN_MAINNET],
    ['mainnet', EVRMORE_MAINNET],
    ['ravencoin-mainnet', RAVENCOIN_MAINNET],
    ['bitcoingold-mainnet', BITCOINGOLD_MAINNET],
    ['wojakcoin-mainnet', WOJAKCOIN_MAINNET],
    // Neoxa is APPENDED, deliberately: the order above is the owner's and moving
    // an existing chain to make room would change what every user sees. Its
    // final position is the owner's call, like every other row here.
    ['neoxa-mainnet', NEOXA_MAINNET],
    // Bitcoin BLAKE2b is appended for the same reason (2026-09-07).
    ['bitcoinblake2b-mainnet', BITCOIN_BLAKE2B_MAINNET],
  ] as const
).map(([value, net]) => ({
  value,
  label: net.displayName,
  icon: <TokenIcon assetId={net.ticker} size={14} />,
}));

/** The UTXO rows, plus one row per EVM chain this build carries (value
 *  `evm:<key>`, appended after the UTXO rows so the existing display order is
 *  untouched). `evmChains` is normally `s.evm.chains` from the store; omitted
 *  or empty (a build without the EVM engine) yields the UTXO-only list, byte
 *  for byte what CHAIN_OPTIONS already was. */
export function chainOptionsFor(evmChains?: readonly EvmChainInfo[]): SegmentedOption<ChainChoice>[] {
  const evmOptions: SegmentedOption<ChainChoice>[] = (evmChains ?? []).map((c) => ({
    value: evmChainTarget(c.key),
    label: c.displayName,
    // The NETWORK mark for an EVM chain (Base's own, not its coin's: several
    // EVM chains share ETH as the native coin).
    icon: <TokenIcon assetId={`evm:${c.key}`} size={14} />,
  }));
  return [...CHAIN_OPTIONS, ...evmOptions];
}

/** Canonical chainId for a UTXO picker value. Evrmore's value is the legacy
 *  bare 'mainnet', so the two are not interchangeable and hiding must compare
 *  the canonical form. */
function chainIdOf(value: UtxoChainChoice): string {
  return CHAIN_OPTIONS_BY_VALUE[value];
}

export interface ChainPickerProps {
  /** Chains hidden in expert Settings: canonical UTXO chainIds and `evm:<key>`
   *  targets. Passed in rather than read from the store so this component
   *  stays store-free and unit-testable on its own. A hidden chain cannot be
   *  picked for a new wallet. */
  hidden?: readonly string[];
  /** The EVM chains this build carries (empty/omitted without the EVM engine),
   *  normally `s.evm.chains` from the store. Adds one row per chain, after the
   *  UTXO rows. */
  evmChains?: readonly EvmChainInfo[];
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
 *  a privacy note. Neoxa gets none either, and that is worth stating because it
 *  is the one row where the wrong guess is tempting: it is a RAVENCOIN FORK and
 *  carries Ravencoin's asset protocol, but its coin type is its own (1668), so
 *  one phrase derives unrelated keys on the two chains. The note is driven by
 *  chainsShareDerivation() in chainParams.ts, which computes that from the
 *  params rather than from any chain name. */
export function ChainPicker({
  hidden,
  evmChains,
  value,
  onChange,
  testIdPrefix,
  secretKind,
}: ChainPickerProps) {
  const allOptions = chainOptionsFor(evmChains);
  // The selected chain always stays listed: hiding the option the form is
  // currently set to would leave a picker with nothing selected.
  const options = hidden?.length
    ? allOptions.filter(
        (o) =>
          o.value === value ||
          (isEvmChainTarget(o.value) ? !hidden.includes(o.value) : !hidden.includes(chainIdOf(o.value as UtxoChainChoice))),
      )
    : allOptions;
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
      {isEvmChainTarget(value) && (
        <div
          className="banner info"
          data-testid={`${testIdPrefix}-evm-note`}
          style={{ marginTop: 8, alignItems: 'flex-start' }}
        >
          <Info size={14} />
          <span>
            One EVM account works on every EVM chain; you can switch chains later without a new phrase.
          </span>
        </div>
      )}
    </div>
  );
}
