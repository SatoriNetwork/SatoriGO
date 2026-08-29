// EVM chain registry (phase 1 of the EVM rollout).
//
// SOURCE OF TRUTH: the EVM engine design notes, section 2.2, "The EVM chain
// registry". This file is the data row shape described there, populated with
// exactly the two chains phase 1 calls for. Read that document before editing
// this one: in particular section 1 ("one key is one address on every chain")
// is why `coinType` does not appear on this interface at all, see below.
//
// ---------------------------------------------------------------------------
// THREE THINGS TO KNOW BEFORE TOUCHING THE DATA BELOW:
//
// (a) THE RPC AND INDEXER HOSTS HERE ARE PROPOSALS, NOT PERMISSIONS.
//     Every URL in this file is a candidate for phase 2, when read access is
//     built. Per evm-engine.md section 8, "a new RPC or indexer host" is a
//     manifest change, which is a new store review. Nothing in this module
//     adds a host to the manifest, grants network access, or is fetched from:
//     this file is pure data. No request may be sent to any host named here
//     until the owner approves it and it lands in the manifest in phase 2.
//
// (b) BSC's `feeModel: 'legacy'` BELOW WAS CONFIRMED LIVE ON 2026-08-18, AND
//     IS STILL A CLAIM THAT AGES. `eth_feeHistory(4, latest, [25,75])` on
//     bsc-dataseed.bnbchain.org answered baseFeePerGas = 0 for every block and
//     eth_gasPrice = 0.05 gwei (= the p25 priority reward): the chain accepts
//     typed transactions but prices them as plain gasPrice, so 'legacy' is the
//     honest model. Base, same day: baseFeePerGas 5,000,000 wei with a 1 gwei
//     tip, a real 1559 market. Phase 3 re-runs this check before the first send
//     is built; a static value here never decides how a transaction is priced.
//
// (c) BASE IS LISTED FIRST ON PURPOSE.
//     Base is the chain that forces the registry to express a quirk: its
//     `l1DataFee: 'optimism'` field exists because Base (and Optimism) charge
//     a separate fee for posting calldata to Ethereum L1, on top of ordinary
//     L2 gas (evm-engine.md section 4, model 3). Leading with the chain that
//     needs the field, rather than the plain EIP-1559 case, is deliberate: it
//     keeps the shape honest about what a "chain row" actually has to carry.
// ---------------------------------------------------------------------------

/** How a chain prices gas. 'eip1559' is base fee + priority tip
 *  (eth_feeHistory); 'legacy' is a single gasPrice. See note (b) above:
 *  a chain's value here is not permanent and must be reconfirmed live. */
export type EvmFeeModel = 'eip1559' | 'legacy';

/** Family of address-history indexer API a chain's `indexer` field points at.
 *  'etherscan' covers Etherscan-shaped APIs (Etherscan itself, Basescan,
 *  BscScan, ...); 'blockscout' is the other common family. One client per
 *  family, not per chain (evm-engine.md section 5, option 2). */
export type EvmIndexerFamily = 'etherscan' | 'blockscout';

/**
 * Native staking on a chain that exposes the Cosmos SDK's staking and
 * distribution modules to EVM callers through STATIC PRECOMPILES (cosmos/evm).
 *
 * Present on EXACTLY the chains that have it (Epix, so far). Its absence is the
 * capability test the whole feature keys off: no row, no Stake screen, no nav
 * entry, no REST call. Nothing here is a chain-name check.
 *
 * A precompile is not a contract: `eth_getCode` at these addresses answers
 * `0x`, which proves nothing either way. What proves they are live is that
 * `eth_call` and `eth_estimateGas` answer for their selectors, and every write
 * selector below was verified that way against the live chain (see
 * cosmosStaking.ts, "verified live" table).
 */
export interface EvmCosmosStaking {
  /** Only shape so far. A second kind (a real staking CONTRACT, say) would be a
   *  different codec, so the discriminant exists from the first row. */
  kind: 'cosmos-evm';
  /** cosmos/evm static precompile for x/staking (delegate, undelegate,
   *  redelegate, delegation, unbondingDelegation). */
  stakingPrecompile: string;
  /** cosmos/evm static precompile for x/distribution (withdrawDelegatorRewards,
   *  delegationRewards, delegationTotalRewards). */
  distributionPrecompile: string;
  /** bech32 human-readable part of a VALIDATOR operator address
   *  ('epixvaloper1...'). Validators are named by this string in every call. */
  valoperPrefix: string;
  /** bech32 human-readable part of an ACCOUNT address ('epix1...'), derived
   *  from the SAME 20 bytes as the account's 0x address. The Cosmos REST paths
   *  take this form, the precompiles take the 0x form. */
  accountPrefix: string;
  /** The chain's bond denom, the base unit of the native coin as the Cosmos
   *  side names it ('aepix' = 1e-18 EPIX). Read from
   *  /cosmos/staking/v1beta1/params and pinned here so a reward or delegation
   *  amount in some other denom is never silently added to a total. */
  bondDenom: string;
  /** The chain's Cosmos REST (LCD) origin, used for the LISTS the precompiles
   *  cannot answer cheaply (bonded validators, my delegations, my unbonding
   *  entries, pending rewards). DEV SHAPE ONLY: a gateway build reaches the
   *  same paths through `<gateway>/evm/<key>/rest/...` and this origin is not
   *  in its manifest (see endpoints.ts cosmosRestBaseUrl). */
  restBaseUrl: string;
}

/** An ERC-20 token this wallet reads on a chain. Identity is the CONTRACT
 *  ADDRESS (EIP-55), never the symbol: two tokens can share a symbol, and a
 *  scam token usually does on purpose. `symbol` and `decimals` here are hints
 *  for display before the first read; the chain's own answers win. */
export interface EvmTokenRef {
  address: string;
  symbol?: string;
  decimals?: number;
}

/**
 * One EVM chain's row. Deliberately parallel to, and NOT sharing a type with,
 * `EvrmoreNetwork` in chainParams.ts: the two families have almost no fields
 * in common (evm-engine.md section 2.2).
 *
 * `coinType` IS DELIBERATELY ABSENT FROM THIS INTERFACE. On a UTXO chain,
 * `coinType` is a per-row field because each chain has its own derivation
 * path and its own address. On EVM every chain shares SLIP-44 coin type 60
 * and, per evm-engine.md section 1, one key IS one address on every EVM
 * chain: there is exactly one derivation, done once, for the whole family.
 * So 60 lives on the engine that derives the account, never on a row here;
 * putting it on this interface would suggest, wrongly, that a chain could
 * pick its own coin type the way an EVR/RVN/BTGS/... row does.
 */
export interface EvmChain {
  /** Stable id used in storage/settings, e.g. 'base', 'bsc'. Never shown to
   *  the user directly; see displayName for that. */
  key: string;
  /** EIP-155 chain id, also what eth_chainId returns (decimal here; see
   *  evmChainIdHex() for the 0x-hex form eth_chainId/wallet_switchEthereumChain
   *  actually use on the wire). */
  chainId: number;
  displayName: string;
  nativeTicker: string;
  /** Decimal places between one whole native coin and one base unit. A field,
   *  not a constant, for the same reason chainParams.ts documents on its own
   *  `decimals`: it is a property of the chain, and every EVM chain here
   *  happens to be 18, but the code must read it rather than assume it. */
  nativeDecimals: number;
  /** Ordered list of RPC endpoints, for failover: try [0], then [1], etc.
   *  Each distinct HOST costs a store review once phase 2 lands it in the
   *  manifest (evm-engine.md section 8). See note (a) above: nothing here is
   *  approved yet. */
  rpc: string[];
  /** Block-explorer transaction URL template, containing the literal
   *  substring '{txid}' exactly once, e.g. 'https://basescan.org/tx/{txid}'.
   *  Same convention as the UTXO registry's explorer links. */
  explorerTxUrl: string;
  /** The project's OWN site, shown under the name in the chain switcher for the
   *  same reason the UTXO registry carries one: that list is where a user
   *  decides which chain they mean, and a domain disambiguates where a name
   *  does not. Required, so a chain cannot be added without one. */
  homepage: string;
  feeModel: EvmFeeModel;
  /** Present only on chains that charge a separate L1 data fee on top of
   *  ordinary gas (Base, Optimism): see evm-engine.md section 4, model 3.
   *  Absent means "no separate L1 surcharge", not "unknown". */
  l1DataFee?: 'optimism';
  /** Address-history indexer for this chain, if one is proposed. See note
   *  (a): baseUrl is a candidate host, not a live integration. */
  indexer?: { family: EvmIndexerFamily; baseUrl: string };
  /** A young or thin network. Marked "New" beside its name in the chain
   *  switcher and carrying Home's caution notice, exactly as a UTXO chain with
   *  `young` does (chainParams.ts isYoungChain). Absent means established.
   *
   *  That notice used to be UTXO-only because it claimed "little mining power",
   *  which would be false here; the clause is gone (owner, 2026-08-26) and what
   *  remains is true of any thin chain: it can stop producing blocks, and a
   *  payment then waits. */
  young?: boolean;
  /** Recently added to this wallet. Shows the "New" chip WITHOUT claiming the
   *  network is thin; see chainParams.ts `recentlyAdded` for why the two are
   *  separate flags. */
  recentlyAdded?: boolean;
  /** Alchemy network slug (`<slug>.g.alchemy.com`) when Alchemy serves this
   *  chain. With a key present (endpoints.ts) Alchemy becomes the FIRST RPC
   *  endpoint and the history + token-balance source; without one this field
   *  is inert and the public `rpc[]` / `indexer` below are what runs. */
  alchemyNetwork?: string;
  /** Folder of this chain in the Trust Wallet assets repository, the public
   *  source of token logos (`blockchains/<folder>/assets/<address>/logo.png`).
   *  Absent = no logo source; tokens keep their letter badge. */
  trustWalletChain?: string;
  /** CoinGecko token-list slug for this chain, the keyless list behind "search
   *  a token by name or symbol" in Add token
   *  (`https://tokens.coingecko.com/<slug>/all.json`, see tokenSearch.ts).
   *  Absent = no search on this chain; the contract address still works. */
  tokenListSlug?: string;
  /** Tokens shown by default on this chain, before the user adds any. Each
   *  contract below was read live on 2026-08-18 (symbol, decimals, total
   *  supply) against the chain's RPC; a wrong address here would show a
   *  stranger's token as USDC, so never edit one without re-reading it. */
  defaultTokens?: readonly EvmTokenRef[];
  /** Native staking, when the chain has it (see EvmCosmosStaking). ABSENT on
   *  every other chain, and absence is the capability test: the Stake screen
   *  and its nav entry exist only where this row does. */
  staking?: EvmCosmosStaking;
}

/** Object.freeze is shallow; the rpc list and the indexer block are frozen too,
 *  so no caller can push a host into a shared row at runtime. */
function freezeChain(chain: EvmChain): EvmChain {
  Object.freeze(chain.rpc);
  if (chain.indexer) Object.freeze(chain.indexer);
  if (chain.staking) Object.freeze(chain.staking);
  if (chain.defaultTokens) {
    for (const t of chain.defaultTokens) Object.freeze(t);
    Object.freeze(chain.defaultTokens);
  }
  return Object.freeze(chain);
}

/**
 * The EVM chain registry. Exactly two rows for phase 1 (evm-engine.md
 * section 9, phase 1: "engine seam, registry, derivation, address. No
 * network at all."). Both the array and every row are frozen so a caller
 * cannot mutate shared registry state at runtime; see the frozen tests below.
 */
export const EVM_CHAINS: readonly EvmChain[] = Object.freeze([
  freezeChain({
    key: 'base',
    chainId: 8453,
    displayName: 'Base',
    nativeTicker: 'ETH',
    nativeDecimals: 18,
    rpc: ['https://mainnet.base.org'],
    alchemyNetwork: 'base-mainnet',
    trustWalletChain: 'base',
    // 2571 tokens, ~160 KB gzip, verified live 2026-08-19.
    tokenListSlug: 'base',
    explorerTxUrl: 'https://basescan.org/tx/{txid}',
    // verified 2026-08-26 (HTTP 200; Coinbase's own site for the network)
    homepage: 'https://base.org',
    feeModel: 'eip1559',
    l1DataFee: 'optimism',
    // Blockscout's Base instance speaks the Etherscan-shaped account API
    // (txlist / tokentx) WITHOUT an API key (verified live 2026-08-18).
    // Etherscan V2 would be one host for every chain but answers "Free API
    // access is not supported for this chain" without a key, and a key inside
    // an extension is public; that trade is the owner's to make (phase 4 record).
    indexer: { family: 'blockscout', baseUrl: 'https://base.blockscout.com/api' },
    // Circle's native USDC on Base: symbol USDC, 6 decimals, supply ~4.2e9
    // (read 2026-08-18 via eth_call symbol/decimals/totalSupply).
    defaultTokens: [{ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }],
  }),
  freezeChain({
    key: 'bsc',
    chainId: 56,
    displayName: 'BNB Chain',
    nativeTicker: 'BNB',
    nativeDecimals: 18,
    rpc: ['https://bsc-dataseed.bnbchain.org'],
    alchemyNetwork: 'bnb-mainnet',
    trustWalletChain: 'smartchain',
    // 3465 tokens, ~210 KB gzip, verified live 2026-08-19.
    tokenListSlug: 'binance-smart-chain',
    explorerTxUrl: 'https://bscscan.com/tx/{txid}',
    // verified 2026-08-26 (HTTP 200; the project's own site)
    homepage: 'https://www.bnbchain.org',
    // Confirmed live 2026-08-18 (note (b) above); phase 3 re-checks before
    // the first send.
    feeModel: 'legacy',
    // NO indexer yet: BscScan V1 is retired, Etherscan V2 needs an API key, and
    // Blockscout does not host BNB Chain, so this build cannot list history
    // here and says so (the EVM engine design notes, section 5, option 3). Sends
    // made from this wallet still show, recorded locally. Owner decision pending.
    // Binance-Peg BSC-USD (Tether): symbol USDT, 18 decimals (NOT 6 as on
    // Ethereum), supply ~9.2e9 (read 2026-08-18 via eth_call).
    defaultTokens: [{ address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 }],
  }),
  // Phase 6, first chain (owner's go 2026-08-19 after enabling eth-mainnet in
  // his Alchemy app; live-verified the same evening: eth_chainId 0x1,
  // eth_feeHistory carries baseFeePerGas so the fee model IS EIP-1559, the
  // Transfers and Token APIs answer, the ENS registry has code).
  freezeChain({
    key: 'ethereum',
    chainId: 1,
    displayName: 'Ethereum',
    nativeTicker: 'ETH',
    nativeDecimals: 18,
    // Keyless public fallback, verified live 2026-08-19 (cloudflare-eth.com
    // also answers; llamarpc was down when probed).
    rpc: ['https://ethereum-rpc.publicnode.com'],
    alchemyNetwork: 'eth-mainnet',
    trustWalletChain: 'ethereum',
    // 5093 tokens, verified live 2026-08-19.
    tokenListSlug: 'ethereum',
    explorerTxUrl: 'https://etherscan.io/tx/{txid}',
    // verified 2026-08-26 (HTTP 200; the Ethereum Foundation's own site)
    homepage: 'https://ethereum.org',
    feeModel: 'eip1559',
    // No l1DataFee: Ethereum IS the L1.
    // No keyless Etherscan-shaped indexer (same story as BNB Chain); with the
    // dev key, history and discovery come from Alchemy's Transfers API.
    // Circle's USDC and Tether's USDT, both 6 decimals (read 2026-08-19 via
    // eth_call symbol()/decimals() on mainnet).
    defaultTokens: [
      { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    ],
  }),
  // Phase 6, second chain, and the FIRST one Alchemy does not serve: EpixChain
  // (a cosmos/evm fork, partnership). It reaches the wallet the same way every
  // other chain does, through the gateway (`<gateway>/evm/epix/rpc` and
  // `<gateway>/evm/epix/indexer`), so the manifest still carries ONE EVM host;
  // the gateway forwards to the upstream named below instead of to Alchemy.
  // The absence of `alchemyNetwork` is load-bearing, not an omission: no
  // `alchemy_*` method exists on this route, so token balances go through
  // eth_call, history through the Blockscout proxy, and token discovery /
  // "Import all" stay hidden (endpoints.ts splits "routed through the gateway"
  // from "Alchemy-shaped").
  //
  // Live-verified 2026-08-20 against the endpoints below: eth_chainId 0x77c
  // (1916); eth_feeHistory carries baseFeePerGas 0x4a817c800 on every block
  // (20 gwei, constant) with reward 0, and eth_gasPrice answers 0x53d1ac100
  // (22.5 gwei), so the fee model IS EIP-1559 with a fixed base fee; the
  // Blockscout instance answers the Etherscan-shaped account API keyless
  // ({"status":"0","message":"No transactions found","result":[]} for an
  // address with none). Blocks land every ~5.6 s. The README's
  // rpc.epixchain.com is dead; evmrpc.epix.zone is the live public RPC
  // (batching OK, CORS *).
  freezeChain({
    key: 'epix',
    chainId: 1916,
    displayName: 'Epix',
    nativeTicker: 'EPIX',
    nativeDecimals: 18,
    rpc: ['https://evmrpc.epix.zone'],
    // No alchemyNetwork: Alchemy does not serve this chain (see above).
    // No trustWalletChain: EpixChain has no folder in the Trust Wallet assets
    // repository, so tokens here keep their letter badge.
    // No tokenListSlug: CoinGecko publishes no token list for this chain, so
    // Add token takes a contract address only.
    explorerTxUrl: 'https://scan.epix.zone/tx/{txid}',
    // verified 2026-08-26 (HTTP 200; the project's own site, same domain as
    // its RPC and explorer)
    homepage: 'https://epix.zone',
    feeModel: 'eip1559',
    // No l1DataFee: this is its own L1, it posts calldata nowhere.
    // Marked "New" in the chain list, and carrying Home's caution notice
    // (owner, 2026-08-26): the newest chain here, and a thin one.
    young: true,
    indexer: { family: 'blockscout', baseUrl: 'https://scan.epix.zone/api/v1' },
    // No ERC-20 contracts exist on this chain yet (checked 2026-08-20), so
    // there is nothing honest to put here. An empty list, not a guess.
    defaultTokens: [],
    // NATIVE STAKING (2026-08-24). Epix is a cosmos/evm chain, so x/staking and
    // x/distribution answer EVM calls at the static precompile addresses below.
    // Verified live against https://evmrpc.epix.zone on 2026-08-24 from the
    // owner's account 0x1Ed2c7D71FbEb281073343aC2d317433679D0153:
    //   eth_call delegation(address,string)          -> shares 0, Coin{"aepix",0}
    //   eth_call unbondingDelegation(address,string) -> empty entries tuple
    //   eth_call delegationTotalRewards(address)     -> two empty arrays
    //   eth_estimateGas delegate(address,string,uint256) of 1 aepix -> 0x1cf9f
    // and undelegate / redelegate / withdrawDelegatorRewards answered the
    // precompile's OWN business-logic revert ("no delegation for (address,
    // validator) tuple") rather than "invalid method", which is what proves the
    // selector reached the right method and its arguments decoded (the owner
    // held no delegation at the time). Full table in cosmosStaking.ts.
    staking: {
      kind: 'cosmos-evm',
      stakingPrecompile: '0x0000000000000000000000000000000000000800',
      distributionPrecompile: '0x0000000000000000000000000000000000000801',
      valoperPrefix: 'epixvaloper',
      accountPrefix: 'epix',
      // /cosmos/staking/v1beta1/params, read live 2026-08-24: bond_denom
      // "aepix", unbonding_time "1814400s". The unbonding time is deliberately
      // NOT pinned here: it is read from that endpoint every time the warning
      // is shown, because a chain can change it by governance.
      bondDenom: 'aepix',
      restBaseUrl: 'https://api.epix.zone',
    },
  }),
]);

/** The chain the UI shows for a new EVM account before the user picks one. */
export const DEFAULT_EVM_CHAIN_KEY = 'base';

/** Look up a chain row by its stable key, or undefined if it is not
 *  registered. */
export function evmChainByKey(key: string): EvmChain | undefined {
  return EVM_CHAINS.find((chain) => chain.key === key);
}

/** Look up a chain row by its numeric EIP-155 chain id, or undefined if it is
 *  not registered. */
export function evmChainById(chainId: number): EvmChain | undefined {
  return EVM_CHAINS.find((chain) => chain.chainId === chainId);
}

/** True when `key` names a chain in this registry. */
export function isEvmChainKey(key: string): boolean {
  return evmChainByKey(key) !== undefined;
}

/** Build this chain's block-explorer link for a transaction. `txid` is used
 *  exactly as given: EVM explorers expect the 0x-prefixed transaction hash,
 *  unlike the UTXO explorer convention, so no '0x' stripping happens here. */
export function evmExplorerTxUrl(chain: EvmChain, txid: string): string {
  return chain.explorerTxUrl.replace('{txid}', txid);
}

/** The minimal 0x-prefixed hex string EIP-1193 uses for eth_chainId and
 *  wallet_switchEthereumChain, e.g. 8453 -> '0x2105', 56 -> '0x38'. No
 *  leading zeros, lowercase hex digits. */
export function evmChainIdHex(chain: EvmChain): string {
  return `0x${chain.chainId.toString(16)}`;
}
