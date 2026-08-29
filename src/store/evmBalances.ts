// The store's read path for an EVM account (phase 2 of the EVM rollout).
//
// An EVM wallet is ONE address on every EVM chain, so a refresh needs only the
// entry's cached public address and the chain the UI is showing: no unlock, no
// engine, no derivation. That is why balances can land in the store before the
// engine wiring (phase 3) exists.
//
// EVERYTHING EVM IS REACHED THROUGH loadEvmModules(). It is the flag-guarded
// dynamic import; a build without --evm gets `null` here and an EVM wallet reads
// as offline instead of pulling EVM code into the package. The type-only import
// below is erased at compile time and never reaches the bundler (the build guard
// in vite.config.ts would fail the build if it did).

import { loadEvmModules } from '../services/chain/engine';
import type { EvmWalletDataProvider } from '../services/chain/evm/evmProvider';
import type { EvmRpcBatchResult } from '../services/chain/evm/rpc';
import type { LiveAssetBalance } from '../services/chain/electrumProvider';
import type { NetworkStatus } from '../types/domain';

/** One provider per chain key, so the RPC client's endpoint stickiness and the
 *  token metadata cache survive across refresh ticks. */
const providers = new Map<string, EvmWalletDataProvider>();

/** The provider for `chainKey` (unknown or absent key falls back to the default
 *  chain), or null when this build has no EVM engine. */
export async function evmProviderFor(chainKey?: string): Promise<EvmWalletDataProvider | null> {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const key = chainKey && evm.isEvmChainKey(chainKey) ? chainKey : evm.DEFAULT_EVM_CHAIN_KEY;
  let provider = providers.get(key);
  if (!provider) {
    const chain = evm.evmChainByKey(key);
    if (!chain) return null;
    // Alchemy first when the build has a key, the public endpoints after it;
    // with a key, token balances come from ONE alchemy_getTokenBalances call
    // per refresh instead of one eth_call per token (metered cost).
    provider = evm.createEvmProvider(chain, {
      rpc: { endpoints: evm.evmRpcEndpoints(chain) },
      tokenBalances: evm.hasAlchemy(chain) ? 'alchemy' : 'eth_call',
    });
    providers.set(key, provider);
  }
  return provider;
}

export interface EvmRefreshResult {
  network: NetworkStatus;
  /** Null when the balances could not be read (RPC unavailable): the store then
   *  keeps what it had and marks the wallet offline, exactly as on UTXO. */
  assets: LiveAssetBalance[] | null;
  /** False when a tracked token did not answer and is therefore MISSING from
   *  `assets` rather than known to be gone. The store must not treat such a
   *  list as complete (src/store/balanceCache.ts). */
  complete: boolean;
}

/** Network status + balances for one EVM account on one chain. Never throws:
 *  a network failure degrades to `offline` / `assets: null`. Returns null only
 *  when the build has no EVM engine at all. */
export async function refreshEvmWallet(
  address: string,
  chainKey?: string,
  /** Tokens to read BESIDES the chain's defaults: the wallet's own tracked and
   *  discovered contracts. Deduped by address against the defaults. */
  extraTokens: ReadonlyArray<{ address: string; symbol?: string; decimals?: number }> = [],
): Promise<EvmRefreshResult | null> {
  const provider = await evmProviderFor(chainKey);
  if (!provider) return null;
  const defaults = provider.chain.defaultTokens ?? [];
  const seen = new Set(defaults.map((t) => t.address.toLowerCase()));
  const extras = extraTokens.filter((t) => {
    const k = t.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  try {
    provider.setTokens([...defaults, ...extras]);
  } catch {
    // An invalid tracked address (corrupt storage) must not stop the refresh:
    // read the defaults alone.
    provider.setTokens(defaults);
  }
  // ONE batch for status and balances (it used to be two round trips).
  try {
    const snapshot = await provider.getSnapshot(address);
    return { network: snapshot.network, assets: snapshot.assets, complete: snapshot.complete };
  } catch {
    return {
      network: {
        networkId: 'mainnet',
        state: 'offline',
        latencyMs: 0,
        blockHeight: 0,
        serverVersion: '',
        updatedAt: Date.now(),
        tipTime: null,
      },
      assets: null,
      complete: false,
    };
  }
}

/** What a discovered-token read answered. `complete` is false when a token was
 *  asked about and did not answer, so the caller can keep its last known row
 *  instead of dropping it (the same contract as EvmSnapshot.complete). */
export interface EvmDiscoveredBalances {
  rows: LiveAssetBalance[];
  complete: boolean;
}

/**
 * Balances of DISCOVERED tokens (contracts the indexer saw move through the
 * address), read separately from the main refresh and best-effort: chunked so a
 * spammy address with dozens of airdrop contracts never turns into one giant
 * batch that a public RPC rate-limits into "offline", and using the symbol and
 * decimals the indexer reported instead of two extra calls per token. A chunk
 * that fails is skipped; the caller shows only rows with a balance.
 *
 * A skipped chunk used to be silent, and a whole gateway 429 therefore looked
 * exactly like "every discovered token is gone". It is reported instead: see
 * `complete`.
 */
export async function readEvmDiscoveredBalances(
  address: string,
  chainKey: string | undefined,
  tokens: ReadonlyArray<{ address: string; symbol: string; decimals: number }>,
): Promise<EvmDiscoveredBalances> {
  if (tokens.length === 0) return { rows: [], complete: true };
  const evm = await loadEvmModules();
  const provider = await evmProviderFor(chainKey);
  if (!evm || !provider) return { rows: [], complete: false };
  const rows: LiveAssetBalance[] = [];
  let complete = true;
  // With a keyed provider: one call for the whole list (metered once).
  if (evm.hasAlchemy(provider.chain)) {
    try {
      const result = (await provider.rpc.call('alchemy_getTokenBalances', [address, tokens.map((t) => t.address)])) as {
        tokenBalances?: Array<{ contractAddress?: string; tokenBalance?: string | null; error?: string }>;
      };
      const byAddr = new Map<string, bigint>();
      for (const e of result?.tokenBalances ?? []) {
        if (typeof e.contractAddress !== 'string' || typeof e.tokenBalance !== 'string' || e.error) continue;
        if (!/^0x[0-9a-fA-F]+$/.test(e.tokenBalance)) continue;
        byAddr.set(e.contractAddress.toLowerCase(), BigInt(e.tokenBalance));
      }
      for (const t of tokens) {
        const amountBase = byAddr.get(t.address.toLowerCase());
        if (amountBase === undefined) {
          complete = false;
          continue;
        }
        rows.push({ name: t.symbol, amountBase, scale: t.decimals, decimals: t.decimals, isNative: false });
      }
      return { rows, complete };
    } catch {
      // fall through to the per-token chunks (e.g. failed over to a public node)
    }
  }
  const CHUNK = 10;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    let results: EvmRpcBatchResult[];
    try {
      results = await provider.rpc.batch(
        chunk.map((t) => ({
          method: 'eth_call',
          params: [{ to: t.address, data: evm.encodeBalanceOf(address) }, 'latest'],
        })),
      );
    } catch {
      complete = false;
      continue; // this chunk another time
    }
    results.forEach((r, j) => {
      if (!r.ok) {
        complete = false;
        return;
      }
      try {
        const amountBase = evm.decodeUint256(r.result as string);
        const t = chunk[j];
        rows.push({ name: t.symbol, amountBase, scale: t.decimals, decimals: t.decimals, isNative: false });
      } catch {
        // undecodable: not a token that answers like an ERC-20, skip
        complete = false;
      }
    });
  }
  return { rows, complete };
}

/** Tests only: drop the cached providers so a fresh fake fetch takes effect. */
export function resetEvmProvidersForTests(): void {
  providers.clear();
}
