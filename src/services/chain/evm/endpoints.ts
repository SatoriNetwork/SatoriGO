// Which endpoints a chain is actually read through, given the build's
// configuration. The registry (chains.ts) is pure data and public; the build
// injects two values (see vite.config.ts, scripts/evm-hosts.mjs):
//
//   `__EVM_GATEWAY_URL__`  the Satori GO EVM gateway (https://network.satorigo.app),
//                          ONE host that proxies Alchemy with the key kept
//                          server-side and also serves the token lists and marks.
//                          The release shape: with it set, every EVM request of
//                          the wallet goes to that host and nothing else, so
//                          host_permissions carries exactly one EVM entry.
//                          A chain Alchemy does not serve (Epix) is routed by
//                          the same gateway to its OWN node and its own
//                          Blockscout: same host, same auth, no alchemy_*
//                          methods. See gatewayRpcUrl vs hasAlchemy below,
//                          which is the whole point of them being separate.
//   `__ALCHEMY_API_KEY__`  a DEV key for builds without a gateway: Alchemy is
//                          called directly, first, with the chain's public
//                          endpoints after it for failover. Empty in tests, in
//                          store builds, and without platforms/evm-secrets.local.json.
//
// Both empty (tests, dev without secrets): the registry's public list.
// The rpc client still verifies eth_chainId on every endpoint before reading
// from it, so a wrong slug or gateway route can never hand back another
// chain's data.

import type { EvmChain } from './chains';

/** The gateway base URL without a trailing slash, '' when none. */
export function evmGatewayUrl(): string {
  try {
    const raw = typeof __EVM_GATEWAY_URL__ === 'string' ? __EVM_GATEWAY_URL__.trim() : '';
    return raw.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** The dev provider key, '' when none. */
export function alchemyApiKey(): string {
  try {
    return typeof __ALCHEMY_API_KEY__ === 'string' ? __ALCHEMY_API_KEY__ : '';
  } catch {
    return '';
  }
}

/** The gateway client token, '' when none. Baked into gateway builds; the
 *  wallet sends it as `X-Satori-Client` on every gateway request so the gateway
 *  can gate GET requests (which carry no Origin header) and Firefox (whose
 *  moz-extension origin is per-install), uniformly with POST/Chrome. It is a
 *  shared identifier, not a secret (the bundle is public); the real protections
 *  are the server-side key, per-IP limits and Cloudflare. */
export function gatewayClientToken(): string {
  try {
    return typeof __EVM_CLIENT_TOKEN__ === 'string' ? __EVM_CLIENT_TOKEN__ : '';
  } catch {
    return '';
  }
}

/** Extra request headers for gateway calls: the client token, ONLY when a
 *  gateway is configured (so dev builds hitting third-party public RPCs add no
 *  custom header and never trigger a CORS preflight against them). Empty object
 *  otherwise. Applied to RPC POSTs and to the token-list / marks GETs alike. */
export function evmGatewayHeaders(
  token: string = gatewayClientToken(),
  gateway: string = evmGatewayUrl(),
): Record<string, string> {
  return gateway && token ? { 'X-Satori-Client': token } : {};
}

/** What any of the helpers below needs off a registry row. Deliberately a
 *  structural subset, so a test (or the store's plain-data mirror) can pass a
 *  literal without building a whole `EvmChain`. */
type ChainRoute = Pick<EvmChain, 'key'> & Partial<Pick<EvmChain, 'alchemyNetwork' | 'rpc' | 'indexer' | 'staking'>>;

/** A chain key is a path segment on the gateway, so it must be one: lowercase
 *  letters, digits and hyphens, nothing that could climb out of /evm/<key>/. */
function isRoutableKey(key: string): boolean {
  return /^[a-z0-9-]+$/.test(key);
}

/**
 * The gateway's RPC URL for `chain` (`<gateway>/evm/<chainKey>/rpc`), or null
 * without a gateway.
 *
 * TRANSPORT, NOT CAPABILITY. The gateway exposes /rpc for EVERY chain it is
 * configured with, whether it forwards to Alchemy or straight to the chain's
 * own node (a "direct upstream" chain, e.g. Epix). So having a gateway route
 * says only where the JSON-RPC goes; whether `alchemy_*` methods answer there
 * is a separate question, answered by hasAlchemy() below. Conflating the two
 * is what would send `alchemy_getAssetTransfers` at a chain that has never
 * heard of it.
 *
 * The condition is "this row names somewhere to read from": a slug on Alchemy,
 * or at least one upstream RPC of its own. A row with neither is not a chain
 * the gateway can be configured for either.
 */
export function gatewayRpcUrl(chain: ChainRoute, gateway: string = evmGatewayUrl()): string | null {
  if (!gateway) return null;
  if (!chain.alchemyNetwork && !(chain.rpc && chain.rpc.length > 0)) return null;
  if (!isRoutableKey(chain.key)) return null;
  return `${gateway}/evm/${chain.key}/rpc`;
}

/**
 * The gateway's indexer proxy for `chain`
 * (`<gateway>/evm/<chainKey>/indexer`), or null without a gateway or on a
 * chain that has no Etherscan-shaped indexer to proxy. The proxy forwards the
 * module/action/address/sort/page/offset/startblock/contractaddress query and
 * returns the upstream's `{status, message, result}` body unchanged, so the
 * parsing in indexer/etherscan.ts is identical either way.
 */
export function gatewayIndexerUrl(chain: ChainRoute, gateway: string = evmGatewayUrl()): string | null {
  if (!gateway || !chain.indexer) return null;
  if (!isRoutableKey(chain.key)) return null;
  return `${gateway}/evm/${chain.key}/indexer`;
}

/**
 * The gateway's Cosmos REST proxy base for `chain`
 * (`<gateway>/evm/<chainKey>/rest`), or null without a gateway or on a chain
 * with no `staking` row. The proxy passes `cosmos/staking/v1beta1/...` and
 * `cosmos/distribution/v1beta1/...` paths (and their query) straight through to
 * the chain's LCD and returns the body unchanged, so the parsing in
 * cosmosStaking.ts is identical either way. `pagination.limit` is capped at 200
 * by the proxy, which is why the callers never ask for more.
 */
export function gatewayRestUrl(chain: ChainRoute, gateway: string = evmGatewayUrl()): string | null {
  if (!gateway || !chain.staking) return null;
  if (!isRoutableKey(chain.key)) return null;
  return `${gateway}/evm/${chain.key}/rest`;
}

/**
 * Where the Cosmos REST (LCD) lists are actually read from in THIS build: the
 * gateway proxy when one is configured, else the chain's own origin from the
 * registry. Null on a chain without a `staking` row.
 *
 * Same split as gatewayRpcUrl/gatewayIndexerUrl, and for the same reason: a
 * gateway build permits exactly one EVM host, so the chain's own LCD origin is
 * unreachable there and lives in platforms/evm-host-permissions.json for the
 * DEV shape only. No trailing slash; callers append '/cosmos/...'.
 */
export function cosmosRestBaseUrl(chain: ChainRoute, gateway: string = evmGatewayUrl()): string | null {
  if (!chain.staking) return null;
  const viaGateway = gatewayRestUrl(chain, gateway);
  if (viaGateway) return viaGateway;
  return chain.staking.restBaseUrl.replace(/\/+$/, '');
}

/** The ALCHEMY-SHAPED JSON-RPC URL for `chain`: the gateway route when a
 *  gateway is configured (no key involved), else Alchemy directly with the dev
 *  key, else null. "Alchemy-shaped" means the `alchemy_*` methods (Transfers
 *  API for history, Token API for import) answer on it, which is why a chain
 *  WITHOUT `alchemyNetwork` returns null even though the gateway does route
 *  its plain JSON-RPC: the gateway forwards those chains to their own node,
 *  where an `alchemy_*` call is a -32601. */
export function alchemyRpcUrl(
  chain: ChainRoute,
  key: string = alchemyApiKey(),
  gateway: string = evmGatewayUrl(),
): string | null {
  if (!chain.alchemyNetwork) return null;
  const viaGateway = gatewayRpcUrl(chain, gateway);
  if (viaGateway) return viaGateway;
  if (!key) return null;
  return `https://${chain.alchemyNetwork}.g.alchemy.com/v2/${key}`;
}

/** True when this chain reads through an Alchemy-shaped endpoint in this build
 *  (gateway, or dev key + slug): history and token import take the fast paths.
 *  False for a direct-upstream chain even in a gateway build. */
export function hasAlchemy(chain: ChainRoute, key: string = alchemyApiKey(), gateway: string = evmGatewayUrl()): boolean {
  return alchemyRpcUrl(chain, key, gateway) !== null;
}

/** Ordered RPC endpoints for `chain`.
 *  - gateway configured: the gateway route ONLY. The public fallbacks are not
 *    in the manifest of a gateway build, so listing them would only add a
 *    guaranteed-failing hop after every gateway error.
 *  - dev key: Alchemy first, then the registry's public list (deduped).
 *  - neither: the public list. */
export function evmRpcEndpoints(
  chain: Pick<EvmChain, 'key' | 'rpc'> & Partial<Pick<EvmChain, 'alchemyNetwork'>>,
  key: string = alchemyApiKey(),
  gateway: string = evmGatewayUrl(),
): string[] {
  const viaGateway = gatewayRpcUrl(chain, gateway);
  if (viaGateway) return [viaGateway];
  const alchemy = alchemyRpcUrl(chain, key, '');
  const out = alchemy ? [alchemy] : [];
  for (const url of chain.rpc) if (!out.includes(url)) out.push(url);
  return out;
}

/** The manifest match pattern Alchemy needs (one for every network slug). */
export const ALCHEMY_HOST_PATTERN = 'https://*.g.alchemy.com/*';

/** The manifest match pattern a gateway build needs: the gateway's origin. */
export function gatewayHostPattern(gateway: string = evmGatewayUrl()): string | null {
  if (!gateway) return null;
  return `${new URL(gateway).origin}/*`;
}
