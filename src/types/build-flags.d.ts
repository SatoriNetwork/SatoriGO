// Compile-time build flags injected by vite `define` (see vite.config.ts and
// vitest.config.ts). They are literal booleans after replacement, so Rollup can
// drop the guarded branches and every module they alone reach.

/** True only for `scripts/build.mjs --evm` builds. Default: false. */
declare const __EVM_ENABLED__: boolean;

/** Alchemy API key for DEV EVM builds (empty in tests, in store builds, and
 *  when platforms/evm-secrets.local.json is absent). See vite.config.ts. */
declare const __ALCHEMY_API_KEY__: string;

/** Base URL of the Satori GO gateway (https://network.satorigo.app): ONE host
 *  for the price feed (every build, see src/services/gateway.ts) and, in an
 *  --evm build, for RPC, the Alchemy APIs, token lists and token marks, with no
 *  client-side key. '' when no gateway is configured (tests, dev builds on the
 *  per-host fallbacks). Source: platforms/evm-gateway.json via
 *  scripts/evm-hosts.mjs. The `__EVM_` prefix is historical: the host has not
 *  been EVM-specific since prices moved behind it (2026-08-21). */
declare const __EVM_GATEWAY_URL__: string;

/** The gateway client token, sent as `X-Satori-Client` on every gateway
 *  request (the /prices GET, RPC POSTs, the token-list / marks GETs). Baked
 *  into gateway builds only; '' otherwise. A shared identifier, not a secret:
 *  the extension bundle is public. See platforms/evm-gateway.json and
 *  evm-secrets.local.json. */
declare const __EVM_CLIENT_TOKEN__: string;
