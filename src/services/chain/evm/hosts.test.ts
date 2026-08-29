// The EVM RPC hosts live in two places that must agree: the registry (what the
// client will call) and platforms/evm-host-permissions.json (what
// `scripts/build.mjs --evm` injects into host_permissions). A host in the
// registry that the manifest does not permit fails silently at runtime in MV3;
// a host in the manifest that no chain uses is a store review paid for nothing.
// And the per-target manifests must NOT carry them: a package built without
// --evm has to stay permission-identical to 1.3.x (owner decision 2026-08-18,
// see the EVM rollout plan).
//
// RELEASE SHAPE (2026-08-20): with a gateway configured in
// platforms/evm-gateway.json (https://network.satorigo.app, owner decision
// 2026-08-19), the build injects exactly ONE EVM host and every URL the client
// builds (RPC, Alchemy APIs, token lists, token marks) sits on it. The per-host
// list above is then the DEV shape only. Both shapes are pinned below.
//
// Phase 6 added Epix, the first chain Alchemy does not serve: it is routed by
// the SAME gateway to its own node and its own Blockscout, so "one host" still
// holds. That is why the tests below separate being ROUTED by the gateway from
// being ALCHEMY-SHAPED; the second is what unlocks alchemy_* and it stays false
// for Epix in every build.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EVM_CHAINS } from './chains';
import {
  ALCHEMY_HOST_PATTERN,
  alchemyRpcUrl,
  cosmosRestBaseUrl,
  evmGatewayHeaders,
  evmRpcEndpoints,
  gatewayHostPattern,
  gatewayIndexerUrl,
  gatewayRestUrl,
  gatewayRpcUrl,
  hasAlchemy,
} from './endpoints';
import { TRUST_WALLET_ASSETS_HOST_PATTERN, trustWalletLogoUrl } from './tokenLogos';
import { TOKEN_LIST_HOST_PATTERN, tokenListUrl } from './tokenSearch';
import evmHosts from '../../../../platforms/evm-host-permissions.json';
import evmGateway from '../../../../platforms/evm-gateway.json';
import {
  allEvmHostPatterns as buildEvmOnlyHosts,
  evmGatewayUrl as buildGatewayUrl,
  evmHostPermissions as buildHostPermissions,
} from '../../../../scripts/evm-hosts.mjs';
import chromeManifest from '../../../../platforms/chrome/manifest.json';
import edgeManifest from '../../../../platforms/edge/manifest.json';
import firefoxManifest from '../../../../platforms/firefox/manifest.json';

/** The match pattern host_permissions needs for one RPC URL: its origin + '/*'. */
function patternFor(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/*`;
}

describe('EVM RPC hosts vs. manifest permissions', () => {
  const permitted = new Set<string>(evmHosts.host_permissions);
  const needed = new Set<string>();
  for (const chain of EVM_CHAINS) {
    for (const rpc of chain.rpc) needed.add(patternFor(rpc));
    if (chain.indexer) needed.add(patternFor(chain.indexer.baseUrl));
    // Native staking reads its LISTS from the chain's Cosmos REST (LCD); in a
    // gateway build that origin is proxied instead, so this entry is dev-only
    // exactly like the RPC and indexer ones above.
    if (chain.staking) needed.add(patternFor(chain.staking.restBaseUrl));
    // One wildcard covers every Alchemy network slug a dev key unlocks.
    if (chain.alchemyNetwork) needed.add(ALCHEMY_HOST_PATTERN);
    // Token logos for added/imported tokens (Trust Wallet assets on GitHub).
    if (chain.trustWalletChain) needed.add(TRUST_WALLET_ASSETS_HOST_PATTERN);
    // Token search by name/symbol in Add token (CoinGecko per-chain lists).
    if (chain.tokenListSlug) needed.add(TOKEN_LIST_HOST_PATTERN);
  }

  it('1. every registry RPC and indexer origin is in platforms/evm-host-permissions.json (and is https)', () => {
    for (const chain of EVM_CHAINS) {
      for (const rpc of chain.rpc) {
        expect(rpc.startsWith('https://')).toBe(true);
        expect(permitted.has(patternFor(rpc)), `${chain.key}: ${rpc} needs ${patternFor(rpc)}`).toBe(true);
      }
      if (chain.indexer) {
        expect(chain.indexer.baseUrl.startsWith('https://')).toBe(true);
        expect(permitted.has(patternFor(chain.indexer.baseUrl)), `${chain.key}: indexer needs ${patternFor(chain.indexer.baseUrl)}`).toBe(true);
      }
      if (chain.staking) {
        expect(chain.staking.restBaseUrl.startsWith('https://')).toBe(true);
        expect(
          permitted.has(patternFor(chain.staking.restBaseUrl)),
          `${chain.key}: staking LCD needs ${patternFor(chain.staking.restBaseUrl)}`,
        ).toBe(true);
      }
    }
  });

  it('2. no permitted EVM host is unused by the registry (each host is a store review)', () => {
    for (const p of permitted) expect(needed.has(p), `${p} is permitted but no chain uses it`).toBe(true);
  });

  it('3. the per-target manifests carry NO EVM host: only build --evm injects them', () => {
    for (const [name, manifest] of [
      ['chrome', chromeManifest],
      ['edge', edgeManifest],
      ['firefox', firefoxManifest],
    ] as const) {
      const hosts: string[] = manifest.host_permissions;
      for (const p of permitted) expect(hosts.includes(p), `${name} manifest lists ${p}`).toBe(false);
    }
  });

  it('4. the permitted hosts are exactly the per-chain public RPC fallbacks (Base + BNB named 2026-08-18, Ethereum added 2026-08-19, Epix 2026-08-20), the Base and Epix history indexers, the Epix staking LCD (2026-08-24), the Alchemy wildcard for the dev key, and the two keyless token-metadata hosts (marks, search lists)', () => {
    expect([...permitted].sort()).toEqual(
      [
        'https://*.g.alchemy.com/*',
        'https://api.epix.zone/*',
        'https://base.blockscout.com/*',
        'https://bsc-dataseed.bnbchain.org/*',
        'https://ethereum-rpc.publicnode.com/*',
        'https://evmrpc.epix.zone/*',
        'https://mainnet.base.org/*',
        'https://raw.githubusercontent.com/*',
        'https://scan.epix.zone/*',
        'https://tokens.coingecko.com/*',
      ].sort(),
    );
  });

  it('6. every chain with a token-list slug names a plain registry slug the URL builder accepts', () => {
    for (const chain of EVM_CHAINS) {
      if (!chain.tokenListSlug) continue;
      const url = tokenListUrl(chain.tokenListSlug);
      expect(url, `${chain.key}: slug ${chain.tokenListSlug} is not a usable list slug`).not.toBe(null);
      expect(new URL(url as string).host).toBe('tokens.coingecko.com');
    }
  });

  it('5. with a key, Alchemy is the FIRST endpoint of every chain that has a slug (its host under the wildcard); without a key the public list is unchanged', () => {
    for (const chain of EVM_CHAINS) {
      expect(evmRpcEndpoints(chain, '')).toEqual(chain.rpc);
      if (!chain.alchemyNetwork) continue;
      const withKey = evmRpcEndpoints(chain, 'k1');
      expect(withKey[0]).toBe(`https://${chain.alchemyNetwork}.g.alchemy.com/v2/k1`);
      expect(withKey.slice(1)).toEqual(chain.rpc);
      expect(new URL(withKey[0]).host.endsWith('.g.alchemy.com')).toBe(true);
    }
  });
});

describe('EVM gateway shape (one host for everything EVM)', () => {
  const GATEWAY = 'https://network.satorigo.app';
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

  it('1. with a gateway, EVERY registry chain reads through <gateway>/evm/<key>/rpc and NOTHING else (no public fallback hop, no key in any URL)', () => {
    for (const chain of EVM_CHAINS) {
      const url = `${GATEWAY}/evm/${chain.key}/rpc`;
      expect(gatewayRpcUrl(chain, GATEWAY), chain.key).toBe(url);
      expect(evmRpcEndpoints(chain, 'devkey123', GATEWAY), chain.key).toEqual([url]);
      expect(url.includes('devkey123')).toBe(false);
      if (chain.alchemyNetwork) {
        // The gateway wins even when a dev key is ALSO present: the key must never reach a URL.
        expect(alchemyRpcUrl(chain, 'devkey123', GATEWAY)).toBe(url);
        expect(hasAlchemy(chain, '', GATEWAY)).toBe(true);
      }
    }
  });

  it('1b. transport is not capability: a chain WITHOUT an Alchemy slug (epix) is routed by the gateway but is never treated as Alchemy-shaped, in any build', () => {
    const direct = EVM_CHAINS.filter((c) => !c.alchemyNetwork);
    expect(direct.map((c) => c.key)).toEqual(['epix']);
    for (const chain of direct) {
      // Routed: plain JSON-RPC goes to the gateway, which forwards to the
      // chain's own node.
      expect(gatewayRpcUrl(chain, GATEWAY)).toBe(`${GATEWAY}/evm/${chain.key}/rpc`);
      // NOT Alchemy-shaped: alchemy_* answers nowhere on that route, so
      // history must not ask for it and Import/discovery stay hidden.
      expect(alchemyRpcUrl(chain, 'devkey123', GATEWAY)).toBe(null);
      expect(hasAlchemy(chain, 'devkey123', GATEWAY)).toBe(false);
      expect(hasAlchemy(chain, '', GATEWAY)).toBe(false);
      expect(hasAlchemy(chain, 'devkey123', '')).toBe(false);
      // Its history source is the gateway's Blockscout proxy, one host again.
      expect(gatewayIndexerUrl(chain, GATEWAY)).toBe(`${GATEWAY}/evm/${chain.key}/indexer`);
    }
  });

  it('1c. gatewayIndexerUrl: only for chains that HAVE an indexer, only with a gateway, and never off the /evm/<key>/ path', () => {
    for (const chain of EVM_CHAINS) {
      expect(gatewayIndexerUrl(chain, '')).toBe(null);
      expect(gatewayIndexerUrl(chain, GATEWAY)).toBe(chain.indexer ? `${GATEWAY}/evm/${chain.key}/indexer` : null);
    }
    const indexer = { family: 'blockscout' as const, baseUrl: 'https://example.invalid/api' };
    expect(gatewayIndexerUrl({ key: '../evil', indexer }, GATEWAY)).toBe(null);
    expect(gatewayRpcUrl({ key: '../evil', rpc: ['https://example.invalid'] }, GATEWAY)).toBe(null);
  });

  it('1d. a chain with NATIVE STAKING reads its Cosmos REST through the gateway too, so the one-host shape survives the feature', () => {
    const staking = EVM_CHAINS.filter((c) => c.staking);
    expect(staking.map((c) => c.key)).toEqual(['epix']);
    for (const chain of EVM_CHAINS) {
      if (!chain.staking) {
        // No staking row, no REST route and no direct origin: the capability
        // test is the row's presence, everywhere.
        expect(gatewayRestUrl(chain, GATEWAY)).toBe(null);
        expect(cosmosRestBaseUrl(chain, GATEWAY)).toBe(null);
        expect(cosmosRestBaseUrl(chain, '')).toBe(null);
        continue;
      }
      expect(gatewayRestUrl(chain, GATEWAY)).toBe(`${GATEWAY}/evm/${chain.key}/rest`);
      expect(cosmosRestBaseUrl(chain, GATEWAY)).toBe(`${GATEWAY}/evm/${chain.key}/rest`);
      // Dev shape: the chain's own LCD, which is what the dev host list permits.
      expect(cosmosRestBaseUrl(chain, '')).toBe(chain.staking.restBaseUrl);
      expect(chain.staking.restBaseUrl.endsWith('/')).toBe(false);
    }
    // No path traversal into the gateway through a chain key.
    expect(gatewayRestUrl({ key: '../evil', staking: EVM_CHAINS.find((c) => c.key === 'epix')?.staking }, GATEWAY)).toBe(null);
  });

  it('2. with a gateway, token lists and token marks are on the gateway host too; without one they keep their keyless public hosts', () => {
    const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    for (const chain of EVM_CHAINS) {
      if (chain.tokenListSlug) {
        expect(tokenListUrl(chain.tokenListSlug, GATEWAY)).toBe(`${GATEWAY}/evm/tokenlist/${chain.tokenListSlug}`);
        expect(new URL(tokenListUrl(chain.tokenListSlug, '') as string).host).toBe('tokens.coingecko.com');
      }
      if (chain.trustWalletChain) {
        expect(trustWalletLogoUrl(chain.trustWalletChain, usdc, GATEWAY)).toBe(`${GATEWAY}/evm/marks/${chain.trustWalletChain}/${usdc}`);
        expect(new URL(trustWalletLogoUrl(chain.trustWalletChain, usdc, '') as string).host).toBe('raw.githubusercontent.com');
      }
    }
    // Malformed inputs stay null on both paths (no path traversal into the gateway).
    expect(tokenListUrl('../evil', GATEWAY)).toBe(null);
    expect(trustWalletLogoUrl('base', '0x1234', GATEWAY)).toBe(null);
    expect(trustWalletLogoUrl('../x', usdc, GATEWAY)).toBe(null);
  });

  it('2b. the client token rides as X-Satori-Client ONLY when both a gateway and a token are configured (so GET requests and Firefox are gated, and dev builds add no header to third-party hosts)', () => {
    const GATEWAY = 'https://network.satorigo.app';
    // gateway + token: header present (this is what a gateway build sends).
    expect(evmGatewayHeaders('sgw_tok', GATEWAY)).toEqual({ 'X-Satori-Client': 'sgw_tok' });
    // token but no gateway (dev build): no header, so no CORS preflight against a public RPC.
    expect(evmGatewayHeaders('sgw_tok', '')).toEqual({});
    // gateway but no token: no header.
    expect(evmGatewayHeaders('', GATEWAY)).toEqual({});
    // neither: no header.
    expect(evmGatewayHeaders('', '')).toEqual({});
  });

  it('3. a gateway build injects exactly ONE EVM host permission: the gateway origin, epix row included', () => {
    // The point of this test since phase 6: the registry holds a chain whose
    // upstream is NOT Alchemy and whose indexer is its own Blockscout, and the
    // injected permission list is still a single host. If adding a chain ever
    // adds a host, the release shape has been broken.
    expect(EVM_CHAINS.some((c) => c.key === 'epix' && !c.alchemyNetwork && !!c.indexer)).toBe(true);
    expect(gatewayHostPattern(GATEWAY)).toBe('https://network.satorigo.app/*');
    expect(gatewayHostPattern(`${GATEWAY}/`)).toBe('https://network.satorigo.app/*');
    expect(gatewayHostPattern('')).toBe(null);
    const prev = process.env.EVM_GATEWAY_URL;
    try {
      process.env.EVM_GATEWAY_URL = `${GATEWAY}/`;
      expect(buildGatewayUrl(repoRoot)).toBe(GATEWAY);
      expect(buildHostPermissions(repoRoot)).toEqual(['https://network.satorigo.app/*']);
      process.env.EVM_GATEWAY_URL = '';
      expect(buildGatewayUrl(repoRoot)).toBe('');
      expect(buildHostPermissions(repoRoot)).toEqual(evmHosts.host_permissions);
      process.env.EVM_GATEWAY_URL = 'http://network.satorigo.app';
      expect(() => buildGatewayUrl(repoRoot)).toThrow(/https/);
    } finally {
      if (prev === undefined) delete process.env.EVM_GATEWAY_URL;
      else process.env.EVM_GATEWAY_URL = prev;
    }
  });

  it('3b. the gateway host is ALREADY in every per-target manifest (prices use it in every build), so an --evm gateway build adds NOTHING', () => {
    // Since 2026-08-21 the wallet reads all its prices through the gateway, in
    // store packages too, so the origin lives in the committed manifests. The
    // consequence pinned here: turning --evm on does not widen the permission
    // set at all in the release shape, and the EVM-only patterns build.mjs
    // rejects in a store build no longer include the gateway (they would
    // otherwise reject every store build).
    const configured = evmGateway.gatewayUrl.trim().replace(/\/+$/, '');
    if (!configured) return; // dev shape: nothing to dedupe against
    const pattern = `${new URL(configured).origin}/*`;
    const prev = process.env.EVM_GATEWAY_URL;
    try {
      delete process.env.EVM_GATEWAY_URL;
      const injected: string[] = buildHostPermissions(repoRoot);
      expect(injected).toEqual([pattern]);
      expect(buildEvmOnlyHosts(repoRoot)).toEqual(evmHosts.host_permissions);
      expect(buildEvmOnlyHosts(repoRoot)).not.toContain(pattern);
      for (const [name, manifest] of [
        ['chrome', chromeManifest],
        ['edge', edgeManifest],
        ['firefox', firefoxManifest],
      ] as const) {
        const hosts: string[] = manifest.host_permissions;
        expect(hosts, `${name} manifest must permit the gateway for prices`).toContain(pattern);
        // Injecting into a Set, exactly as scripts/build.mjs does: net zero.
        const after = new Set([...hosts, ...injected]);
        expect(after.size, `${name}: an --evm gateway build must add no host`).toBe(hosts.length);
      }
    } finally {
      if (prev !== undefined) process.env.EVM_GATEWAY_URL = prev;
    }
  });

  it('3c. no per-target manifest permits an exchange directly any more: the gateway talks to them', () => {
    // The wallet used to fetch CoinEx and SafeTrade itself. Those hosts are
    // gone from host_permissions; satorinet.io (network statistics) and
    // network.satorinet.io (pool staking) are still direct and must stay.
    for (const [name, manifest] of [
      ['chrome', chromeManifest],
      ['edge', edgeManifest],
      ['firefox', firefoxManifest],
    ] as const) {
      const hosts: string[] = manifest.host_permissions;
      expect(hosts.some((h) => h.includes('api.coinex.com')), `${name} still permits CoinEx`).toBe(false);
      expect(hosts.some((h) => h.includes('safe.trade')), `${name} still permits SafeTrade`).toBe(false);
      expect(hosts).toContain('https://satorinet.io/*');
      expect(hosts).toContain('https://network.satorinet.io/*');
    }
  });

  it('4. platforms/evm-gateway.json is either empty (dev shape) or the decided https gateway; whichever it is, the build and this file agree', () => {
    const configured = evmGateway.gatewayUrl.trim();
    if (configured) {
      expect(configured.replace(/\/+$/, '')).toBe(GATEWAY);
      // A gateway build permits no other host, so ANY registry chain the
      // gateway cannot route would be unreachable in the shipped package.
      // Every chain must therefore have a /rpc route (Alchemy upstream or
      // direct), and every chain that claims an indexer must have the proxy
      // route too, otherwise its Activity would silently never load.
      for (const chain of EVM_CHAINS) {
        expect(gatewayRpcUrl(chain, GATEWAY), `${chain.key} has no gateway RPC route`).toBeTruthy();
        if (chain.indexer) {
          expect(gatewayIndexerUrl(chain, GATEWAY), `${chain.key} has no gateway indexer route`).toBeTruthy();
        }
        if (chain.staking) {
          expect(gatewayRestUrl(chain, GATEWAY), `${chain.key} has no gateway Cosmos REST route`).toBeTruthy();
        }
      }
      const prev = process.env.EVM_GATEWAY_URL;
      try {
        delete process.env.EVM_GATEWAY_URL;
        expect(buildHostPermissions(repoRoot)).toEqual(['https://network.satorigo.app/*']);
      } finally {
        if (prev !== undefined) process.env.EVM_GATEWAY_URL = prev;
      }
    } else {
      expect(configured).toBe('');
    }
  });
});
