// The Satori GO gateway: ONE host the wallet reads shared, non-wallet data
// through (prices today, the EVM RPC/indexer/token routes since 2026-08-20).
//
// This module is deliberately NOT under src/services/chain/evm/. That tree is
// gated behind `__EVM_ENABLED__` and must never be imported from code a store
// build ships (vite.config.ts fails the build if it is). Prices ship in EVERY
// build, so the two build defines are read here instead, and
// src/services/chain/evm/endpoints.ts keeps its own copies for the EVM-only
// routes. Both read the same two values, so they cannot disagree:
//
//   `__EVM_GATEWAY_URL__`   the gateway base URL, already normalised (no
//                           trailing slash) by scripts/evm-hosts.mjs, or ''
//                           when this build has no gateway (a dev build that
//                           talks to the third-party sources directly).
//   `__EVM_CLIENT_TOKEN__`  the shared client identifier the gateway wants as
//                           `X-Satori-Client` so it can gate GET requests
//                           (which carry no Origin) and Firefox (whose
//                           moz-extension origin is per-install). NOT a secret:
//                           the extension bundle is public.
//
// The names keep their `__EVM_` prefix for compatibility with the existing
// build plumbing (scripts/evm-hosts.mjs, platforms/evm-gateway.json); the host
// itself has not been EVM-specific since prices moved behind it.

/** Base URL of the gateway, '' when this build has none. */
export const GATEWAY_URL: string = __EVM_GATEWAY_URL__;

/**
 * Whether this build reads through the gateway. A BUILD-TIME literal: vite
 * replaces `__EVM_GATEWAY_URL__` with a string literal, so this folds to a
 * plain `true`/`false` and Rollup drops the branch that is not taken. That is
 * what lets a gateway build ship with no api.coinex.com / safe.trade URL in it
 * at all (scripts/build.mjs greps the emitted JS to prove it), and a dev build
 * ship with no dead gateway code.
 *
 * Compare here, at the definition, rather than calling a helper: Rollup can
 * only fold what it can see.
 */
export const HAS_GATEWAY: boolean = __EVM_GATEWAY_URL__ !== '';

/** The client token, '' when none. */
export const GATEWAY_CLIENT_TOKEN: string = __EVM_CLIENT_TOKEN__;

/** The gateway base URL without a trailing slash, '' when none. */
export function gatewayUrl(): string {
  return GATEWAY_URL;
}

/** Extra request headers for gateway calls: the client token, ONLY when both a
 *  gateway and a token are configured, so a build without a gateway adds no
 *  custom header to a third-party host (and so triggers no CORS preflight
 *  there). Mirrors `evmGatewayHeaders()` in chain/evm/endpoints.ts. */
export function gatewayHeaders(
  token: string = GATEWAY_CLIENT_TOKEN,
  gateway: string = GATEWAY_URL,
): Record<string, string> {
  return gateway && token ? { 'X-Satori-Client': token } : {};
}
