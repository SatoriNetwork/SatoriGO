// The EVM host permissions a `--evm` build injects, in ONE place so
// scripts/build.mjs and src/services/chain/evm/hosts.test.ts cannot disagree.
//
// Two modes, decided by platforms/evm-gateway.json (env EVM_GATEWAY_URL wins,
// an empty string meaning "no gateway"):
//   gateway set   -> exactly one host: the gateway's origin. RPC, Alchemy APIs,
//                    token lists and marks all go through it (endpoints.ts,
//                    tokenSearch.ts, tokenLogos.ts). The release shape. That
//                    origin is ALREADY in platforms/<target>/manifest.json
//                    (prices use it in every build), so injecting it adds
//                    nothing: build.mjs dedupes and the count comes out 0.
//   gateway empty -> the per-host dev list in platforms/evm-host-permissions.json
//                    (public RPCs, Blockscout, the Alchemy wildcard, CoinGecko,
//                    GitHub raw). The development shape.
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The configured gateway base URL without a trailing slash, or ''. */
export function evmGatewayUrl(root) {
  const fromEnv = process.env.EVM_GATEWAY_URL;
  let url = fromEnv !== undefined ? fromEnv.trim() : '';
  if (fromEnv === undefined) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(root, 'platforms', 'evm-gateway.json'), 'utf8'));
      url = typeof parsed.gatewayUrl === 'string' ? parsed.gatewayUrl.trim() : '';
    } catch {
      url = '';
    }
  }
  if (!url) return '';
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`EVM gateway URL must be https: ${url}`);
  return url.replace(/\/+$/, '');
}

/** host_permissions patterns for a --evm build. */
export function evmHostPermissions(root) {
  const gateway = evmGatewayUrl(root);
  if (gateway) return [`${new URL(gateway).origin}/*`];
  return JSON.parse(readFileSync(path.join(root, 'platforms', 'evm-host-permissions.json'), 'utf8')).host_permissions;
}

/**
 * The EVM-ONLY host patterns: what a build without --evm must NOT carry.
 *
 * The gateway origin is deliberately NOT in this list, even though a gateway
 * build "injects" it. Since 2026-08-21 the wallet reads its PRICES through the
 * same host in every build, so the gateway origin lives in
 * platforms/<target>/manifest.json for all three targets and a store build is
 * expected to have it. What must never appear in a store build is the per-host
 * DEV list: the public RPCs, the Blockscout indexers, the Alchemy wildcard and
 * the two token-metadata hosts.
 */
export function allEvmHostPatterns(root) {
  return JSON.parse(readFileSync(path.join(root, 'platforms', 'evm-host-permissions.json'), 'utf8')).host_permissions;
}
