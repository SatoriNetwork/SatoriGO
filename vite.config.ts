import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { evmGatewayUrl } from './scripts/evm-hosts.mjs';

const rootDir = dirname(fileURLToPath(import.meta.url));

// Two build entries share one output: the popup (index.html) and the background
// service worker (src/background/index.ts), emitted as a stable `background.js`
// at the dist root so the MV3 manifest can point at it. `public/` carries the
// icons and the content/inpage scripts verbatim; the per-target manifest.json
// lives under `platforms/<target>/` and is copied in by `scripts/build.mjs`
// after this build, so `dist/<target>` becomes directly loadable via
// "Load unpacked". TARGET selects the output dir (default: chrome).
const target = process.env.TARGET || 'chrome';

// EVM build flag. The EVM engine (src/services/chain/evm/) is being built on
// `main` behind this flag (the EVM rollout plan, "Trunk with a build
// flag"). Off by default: a store submission is cut from `main` at any moment
// and AMO reviewers build from source, so a shipped package must carry no EVM
// module at all until the release that carries EVM (2.0.0). `scripts/build.mjs
// --evm` turns it on. `__EVM_ENABLED__` is replaced with a literal boolean, so
// Rollup drops every guarded branch and every module reachable only through it.
const evmEnabled = process.env.EVM_ENABLED === '1';
const EVM_DIR = '/src/services/chain/evm/';

// A provider API key for DEV EVM builds only (Alchemy: RPC + history + token
// balances on every chain with an `alchemyNetwork` in the registry). Read from
// the environment or from platforms/evm-secrets.local.json (gitignored); empty
// otherwise, and ALWAYS empty without --evm. Anything in an extension bundle
// is public, so this is a development convenience; the release path is the
// gateway on network.satorigo.app that keeps keys server-side (platforms/
// evm-gateway.json; with it set this key is not needed by the client at all).
function alchemyApiKey(): string {
  if (!evmEnabled) return '';
  // A gateway build carries NO key: the gateway adds it server-side, and the
  // direct-Alchemy path is unreachable anyway (its host is not permitted).
  if (evmGatewayUrl(rootDir)) return '';
  const fromEnv = process.env.ALCHEMY_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(resolve(rootDir, 'platforms', 'evm-secrets.local.json'), 'utf8');
    const parsed = JSON.parse(raw) as { alchemyApiKey?: unknown };
    return typeof parsed.alchemyApiKey === 'string' ? parsed.alchemyApiKey.trim() : '';
  } catch {
    return '';
  }
}

// The gateway client token, baked into gateway builds only (a non-gateway build
// talks to third-party hosts and must add no custom header). Read from
// EVM_CLIENT_TOKEN or platforms/evm-secrets.local.json (gitignored). It is a
// shared identifier, not a secret: the bundle is public.
//
// NOT gated on --evm (since 2026-08-21): prices go through the gateway in every
// build, store packages included, so every build needs the token. Only the
// ALCHEMY DEV KEY above stays EVM-only.
function evmClientToken(): string {
  if (!evmGatewayUrl(rootDir)) return '';
  const fromEnv = process.env.EVM_CLIENT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  // Rotation override without a commit: platforms/evm-secrets.local.json.
  try {
    const raw = readFileSync(resolve(rootDir, 'platforms', 'evm-secrets.local.json'), 'utf8');
    const local = (JSON.parse(raw) as { clientToken?: unknown }).clientToken;
    if (typeof local === 'string' && local.trim()) return local.trim();
  } catch {
    /* no local secrets file */
  }
  // Committed default so a build from source (AMO reviewers) is reproducible;
  // the token is not a secret (the bundle is public). platforms/evm-gateway.json.
  try {
    const raw = readFileSync(resolve(rootDir, 'platforms', 'evm-gateway.json'), 'utf8');
    const committed = (JSON.parse(raw) as { clientToken?: unknown }).clientToken;
    return typeof committed === 'string' ? committed.trim() : '';
  } catch {
    return '';
  }
}

/** With the flag off, FAIL the build if any module under src/services/chain/evm/
 *  made it into any chunk. Tree-shaking is checked, not assumed. */
function evmGuard(): Plugin {
  return {
    name: 'satori-evm-guard',
    generateBundle(_opts, bundle) {
      if (evmEnabled) return;
      const leaked = new Set<string>();
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue;
        for (const id of Object.keys(out.modules)) {
          if (id.replace(/\\/g, '/').includes(EVM_DIR)) leaked.add(`${out.fileName} <- ${id}`);
        }
      }
      if (leaked.size > 0) {
        throw new Error(
          `EVM modules leaked into a build with EVM_ENABLED off:\n  ${[...leaked].join('\n  ')}\n` +
            'Every reference to src/services/chain/evm/ from shipped code must go through a ' +
            '`__EVM_ENABLED__`-guarded dynamic import (see src/services/chain/engine.ts).',
        );
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), evmGuard()],
  define: {
    __EVM_ENABLED__: JSON.stringify(evmEnabled),
    __ALCHEMY_API_KEY__: JSON.stringify(alchemyApiKey()),
    // The Satori GO gateway base URL ('' = none): platforms/evm-gateway.json,
    // env EVM_GATEWAY_URL overrides. See scripts/evm-hosts.mjs.
    //
    // Injected into EVERY build since 2026-08-21, not only --evm ones: the
    // wallet reads all its PRICES through this host (src/services/gateway.ts,
    // src/services/prices.ts), and prices ship in the store packages too. The
    // EVM-only part is the Alchemy dev key above, which stays blank without
    // --evm. The name keeps its __EVM_ prefix so the build plumbing and
    // platforms/evm-gateway.json need no rename.
    __EVM_GATEWAY_URL__: JSON.stringify(evmGatewayUrl(rootDir)),
    __EVM_CLIENT_TOKEN__: JSON.stringify(evmClientToken()),
  },
  build: {
    // OUT_DIR lets scripts/build.mjs send a STORE build somewhere other than
    // dist/<target>. It does: a store build (no EVM engine) goes to
    // dist/store/<target>, so it can never overwrite the dist/chrome the owner
    // has loaded unpacked. See the comment above STORE_DIR in build.mjs.
    outDir: process.env.OUT_DIR || `dist/${target}`,
    emptyOutDir: true,
    target: 'chrome110',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(rootDir, 'index.html'),
        background: resolve(rootDir, 'src/background/index.ts'),
      },
      output: {
        // The worker must sit at a stable root path; everything else keeps the
        // default hashed assets layout. A module worker may import emitted
        // chunks (shared with the popup), which MV3 allows.
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
