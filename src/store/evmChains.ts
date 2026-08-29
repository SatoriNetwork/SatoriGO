// EVM chains as the STORE and the UI see them (phase 3).
//
// The registry itself (src/services/chain/evm/chains.ts) sits behind the build
// flag, so a screen can never import it: a static import would pull EVM code
// into a package built without --evm. Instead the store loads the registry once
// at init through loadEvmModules() and keeps a plain-data mirror in state
// (`evm.chains`). A build without the engine has an EMPTY list, and every EVM
// affordance in the UI keys off that list: no chains, no EVM options anywhere.
//
// Chain ids for the switcher/picker: UTXO chains keep their LiveNetworkId; an
// EVM chain is `evm:<key>` ('evm:base'). One string namespace, no collisions,
// and `isEvmChainTarget` is the family test for a chain id.

import { loadEvmModules } from '../services/chain/engine';

export interface EvmChainInfo {
  key: string;
  chainId: number;
  displayName: string;
  nativeTicker: string;
  nativeDecimals: number;
  explorerTxUrl: string;
  /** The project's own site, shown under the name in the chain switcher. */
  homepage: string;
  /** A thin network: raises Home's caution notice, and marks "New". */
  young: boolean;
  /** New in this wallet: marks "New" and claims nothing about the network. */
  recentlyAdded: boolean;
  feeModel: 'eip1559' | 'legacy';
  l1DataFee: boolean;
  defaultTokens: ReadonlyArray<{ address: string; symbol?: string; decimals?: number }>;
  /** History source, when this build has one for the chain. Absent = the wallet
   *  cannot list history here and says so (sends made here still show). */
  indexer: { family: 'etherscan' | 'blockscout'; baseUrl: string } | null;
  /** True when this build reads the chain through Alchemy (dev key present):
   *  history and "Import tokens" then come from Alchemy's APIs, on every chain
   *  with a slug, and the public indexer above is not used. */
  alchemy: boolean;
  /** Trust Wallet assets folder for token logos, or null. */
  trustWalletChain: string | null;
  /** CoinGecko token-list slug, or null. Null = Add token cannot search by name
   *  or symbol on this chain; a contract address still works. */
  tokenListSlug: string | null;
  /** Native staking, when the chain has it (cosmos/evm precompiles). Null or
   *  absent on every other chain, and the UI keys off exactly this: no row, no
   *  Stake entry anywhere. The two bech32 prefixes are all a screen needs; the
   *  precompile addresses stay behind the build flag with the codec.
   *
   *  OPTIONAL, unlike the other nullable fields here, so the many plain-object
   *  chain fixtures in the tests stay valid: a chain without staking is the
   *  overwhelming default and `!chain.staking` is the capability test either
   *  way. loadEvmChainInfos always writes it explicitly. */
  staking?: { valoperPrefix: string; accountPrefix: string } | null;
}

export const EVM_TARGET_PREFIX = 'evm:';
export type EvmChainTarget = `evm:${string}`;

export function isEvmChainTarget(id: string | null | undefined): id is EvmChainTarget {
  return typeof id === 'string' && id.startsWith(EVM_TARGET_PREFIX) && id.length > EVM_TARGET_PREFIX.length;
}

/** 'evm:base' -> 'base'; anything else -> null. */
export function evmChainKeyOf(id: string | null | undefined): string | null {
  return isEvmChainTarget(id) ? id.slice(EVM_TARGET_PREFIX.length) : null;
}

export function evmChainTarget(key: string): EvmChainTarget {
  return `${EVM_TARGET_PREFIX}${key}`;
}

/** The registry as plain data, or [] when this build has no EVM engine. */
export async function loadEvmChainInfos(): Promise<EvmChainInfo[]> {
  const evm = await loadEvmModules();
  if (!evm) return [];
  return evm.EVM_CHAINS.map((c) => ({
    key: c.key,
    chainId: c.chainId,
    displayName: c.displayName,
    nativeTicker: c.nativeTicker,
    nativeDecimals: c.nativeDecimals,
    explorerTxUrl: c.explorerTxUrl,
    homepage: c.homepage,
    young: c.young === true,
    recentlyAdded: c.recentlyAdded === true,
    feeModel: c.feeModel,
    l1DataFee: c.l1DataFee !== undefined,
    indexer: c.indexer ? { family: c.indexer.family, baseUrl: c.indexer.baseUrl } : null,
    alchemy: evm.hasAlchemy(c),
    trustWalletChain: c.trustWalletChain ?? null,
    tokenListSlug: c.tokenListSlug ?? null,
    staking: c.staking ? { valoperPrefix: c.staking.valoperPrefix, accountPrefix: c.staking.accountPrefix } : null,
    defaultTokens: (c.defaultTokens ?? []).map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals })),
  }));
}

/** Explorer link for a transaction hash (0x-prefixed, kept as given). */
export function evmExplorerTxUrl(chain: EvmChainInfo, txid: string): string {
  return chain.explorerTxUrl.replace('{txid}', txid);
}
