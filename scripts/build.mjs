// Multi-target build orchestrator.
//
//   node scripts/build.mjs --target=chrome|edge|firefox|all [--evm]
//
// Runs typecheck ONCE, then a vite build per requested target. Each target's
// manifest.json lives under platforms/<target>/ (public/ no longer carries it),
// so after vite emits dist/<target> we copy the manifest in. If
// platforms/<target>/overrides/ holds files, they are overlaid (recursively)
// on top of the dist output last, so a target can override any built file.
//
// --evm sets EVM_ENABLED=1 for vite, which flips the `__EVM_ENABLED__` define
// and lets the EVM engine (src/services/chain/evm/) into the bundle. WITHOUT it
// (the default, and what every store package is built with until the release
// that carries EVM) the bundle must contain no EVM code: vite.config.ts fails
// the build if an evm/ module reaches any chunk, and this script additionally
// greps the emitted JS for EVM-only markers, so the tree-shake is verified twice
// rather than assumed.
import { spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { allEvmHostPatterns, evmGatewayUrl, evmHostPermissions } from './evm-hosts.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['chrome', 'edge', 'firefox'];
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const arg = process.argv.find((a) => a.startsWith('--target='));
const requested = (arg ? arg.slice('--target='.length) : 'chrome').toLowerCase();
const targets = requested === 'all' ? ALL : [requested];
const evm = process.argv.includes('--evm');
// Where the output goes, which since 2026-08-27 is NO LONGER decided by --evm.
// It used to be: a build without the engine was "the store build" and went to
// dist/store/<target>. The owner's call that EVM ships to the store removed the
// thing those two directories were distinguishing, so the flag that picks the
// directory is now the one that says what the build is FOR.
//   --package  -> dist/store/<target>, the three packages that get uploaded
//   (default)  -> dist/<target>, and dist/chrome is the directory the owner has
//                 loaded in the browser
const pkg = process.argv.includes('--package');

// Strings that exist ONLY inside src/services/chain/evm/ (registry hosts, the
// L1 fee oracle predeploy, an RPC client error text). If any of them shows up
// in a non-EVM build, EVM code shipped. The primary check is the module-id
// guard in vite.config.ts; this grep is the independent second look. NOTE the
// store and the UI legitimately carry words like 'eip1559' or the derivation
// path in copy, so those are NOT markers.
const EVM_MARKERS = [
  'basescan.org',
  'bsc-dataseed',
  '0x420000000000000000000000000000000000000F',
  'serves a chain id other than',
  // The staking dev host (Epix's Cosmos LCD, added 2026-08-24). It is a
  // registry string, present in an --evm build whether or not a gateway is
  // configured, and it must never appear in a store package: a build without
  // --evm carries no staking code at all.
  'api.epix.zone',
];

// The EVM hosts. Injected into the target manifest's host_permissions ONLY
// with --evm; a build without it must not carry them (checked below), so a
// 1.3.x/1.4.x store package stays permission-identical while EVM is in progress.
// Which hosts: scripts/evm-hosts.mjs decides (ONE gateway host when
// platforms/evm-gateway.json names the gateway, the per-host dev list otherwise).
//
// THE GATEWAY HOST IS NOT ONE OF THEM any more (2026-08-21). Every build reads
// its prices through network.satorigo.app, so that origin sits in
// platforms/<target>/manifest.json for all three targets and a store build is
// SUPPOSED to have it. A gateway --evm build therefore injects a host the
// manifest already lists and adds nothing (the count below prints 0), while the
// per-host dev list and the Alchemy wildcard are still rejected in a build made
// without --evm.
const evmGateway = evmGatewayUrl(root);
const evmHosts = evmHostPermissions(root);
const everyEvmHost = allEvmHostPatterns(root);

// Price sources the wallet must NOT contact directly once a gateway is
// configured: the gateway talks to them server-side instead. Greps the emitted
// JS, so "the dev path was tree-shaken out" is verified rather than assumed
// (services/prices.ts branches on a build-time literal exactly so it can be).
const DIRECT_PRICE_HOSTS = ['api.coinex.com', 'safe.trade'];

function injectEvmHosts(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const have = new Set(manifest.host_permissions ?? []);
  const added = evmHosts.filter((h) => !have.has(h));
  for (const h of evmHosts) have.add(h);
  manifest.host_permissions = [...have];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `  manifest: +${added.length} EVM host permission(s)` +
      (evmGateway
        ? ` (gateway ${evmGateway}${added.length === 0 ? ', already permitted for prices' : ''})`
        : ' (dev per-host list, no gateway)'),
  );
}

function assertNoEvmHosts(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const leaked = (manifest.host_permissions ?? []).filter((h) => everyEvmHost.includes(h));
  if (leaked.length > 0) {
    console.error(`EVM hosts found in a manifest built WITHOUT --evm: ${leaked.join(', ')}`);
    process.exit(1);
  }
}

/** With a gateway configured, the manifest must permit it (prices need it in
 *  EVERY build) and the emitted JS must contain no direct price-source URL. */
function assertGatewayPrices(dist, manifestPath) {
  if (!evmGateway) return;
  const pattern = `${new URL(evmGateway).origin}/*`;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!(manifest.host_permissions ?? []).includes(pattern)) {
    console.error(
      `The gateway host ${pattern} is missing from ${path.relative(root, manifestPath)}. ` +
        'Prices are read through it in every build, so every target manifest must permit it.',
    );
    process.exit(1);
  }
  const hits = [];
  for (const file of jsFiles(dist)) {
    const text = readFileSync(file, 'utf8');
    for (const host of DIRECT_PRICE_HOSTS) {
      if (text.includes(host)) hits.push(`${path.relative(root, file)}: ${host}`);
    }
  }
  if (hits.length > 0) {
    console.error('A GATEWAY build still carries a direct price-source URL (it must read every price through the gateway):');
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log(`  prices: via ${evmGateway}/prices (no ${DIRECT_PRICE_HOSTS.join(' / ')} URL in dist)`);
}

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** A gateway build must not carry the dev Alchemy key: vite.config.ts blanks
 *  it, and this greps the emitted JS for the actual key value (from the env or
 *  the local secrets file) so the blanking is verified, not assumed. */
function assertNoDevKey(dist, secretsPath) {
  const keys = new Set();
  if (process.env.ALCHEMY_API_KEY?.trim()) keys.add(process.env.ALCHEMY_API_KEY.trim());
  if (existsSync(secretsPath)) {
    try {
      const k = JSON.parse(readFileSync(secretsPath, 'utf8')).alchemyApiKey;
      if (typeof k === 'string' && k.trim()) keys.add(k.trim());
    } catch { /* unreadable secrets file: nothing to check against */ }
  }
  if (keys.size === 0) return;
  for (const file of jsFiles(dist)) {
    const text = readFileSync(file, 'utf8');
    for (const k of keys) {
      if (text.includes(k)) {
        console.error(`Alchemy dev key found in a GATEWAY build: ${path.relative(root, file)}. A gateway build must carry no key.`);
        process.exit(1);
      }
    }
  }
}

function assertNoEvmSymbols(dist) {
  const hits = [];
  for (const file of jsFiles(dist)) {
    const text = readFileSync(file, 'utf8');
    for (const marker of EVM_MARKERS) {
      if (text.includes(marker)) hits.push(`${path.relative(root, file)}: ${marker}`);
    }
  }
  if (hits.length > 0) {
    console.error('EVM symbols found in a build made WITHOUT --evm:');
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log(`  no EVM symbols in dist (checked ${EVM_MARKERS.length} markers), no EVM hosts in manifest`);
}

/** The POSITIVE guard, symmetric to assertNoEvmSymbols: a `--evm` build MUST
 *  carry the EVM engine. If tree-shaking, a broken dynamic import, or a bad
 *  merge dropped it, the popup would silently fall back to "This build of Satori
 *  GO has no EVM engine." at runtime (liveWallet.ts). Fail the build loudly here
 *  instead. Every registry marker has to be present in the emitted JS. */
function assertEvmSymbols(dist) {
  const files = jsFiles(dist);
  const present = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const marker of EVM_MARKERS) if (text.includes(marker)) present.add(marker);
  }
  const missing = EVM_MARKERS.filter((m) => !present.has(m));
  if (missing.length > 0) {
    console.error('EVM engine MISSING from a build made WITH --evm (the popup would show "no EVM engine"):');
    for (const m of missing) console.error(`  marker not found: ${m}`);
    console.error('The EVM engine did not make it into the bundle. Check the __EVM_ENABLED__ guard and the dynamic import in src/services/chain/engine.ts.');
    process.exit(1);
  }
  console.log(`  EVM engine present in dist (all ${EVM_MARKERS.length} markers found)`);
}

/** Stamp each dist with its shape, so which build is loaded is never a guess:
 *  read dist/<target>/build-info.json, or the popup's About/version. */
function writeBuildInfo(dist, target) {
  const info = {
    target,
    version: pkgVersion,
    evm,
    // Not gated on --evm: prices go through the gateway in every build.
    gatewayUrl: evmGateway || '',
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
}

for (const t of targets) {
  if (!ALL.includes(t)) {
    console.error(`Unknown target: ${t} (expected ${ALL.join(', ')} or all)`);
    process.exit(1);
  }
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const node = process.execPath;
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

console.log('typecheck...');
run(node, [tscBin, '--noEmit']);

// WHERE A BUILD LANDS, and why the two kinds do not share a directory.
//
// `dist/<target>` is what a developer (and the owner) loads unpacked, and an
// unpacked extension's id is derived from its PATH: changing the directory
// changes the id, which would orphan the wallet data already in that profile.
// So dist/chrome must keep its name AND must always be the EVM build.
//
// Package builds go to dist/store/<target>, and they carry the EVM engine now
// like every other build does. The separate directory is still worth keeping:
// writing ANY build over dist/chrome mid-gate reloads the owner's extension
// under it, and a build without the engine landing there used to make the EVM
// chains vanish from the wallet (it happened repeatedly, 2026-08-25). The
// refusal below is what keeps that impossible; the directory split is what
// keeps a package build from disturbing the loaded one at all.
function outDirFor(target) {
  return pkg ? path.join('dist', 'store', target) : path.join('dist', target);
}

for (const target of targets) {
  console.log(`build ${target}${evm ? ' (EVM enabled)' : ''}...`);
  const relOut = outDirFor(target);
  // The guard, stated as a rule rather than a convention: a build with no EVM
  // engine may never land in the directory the owner has loaded.
  if (!evm && path.normalize(relOut) === path.normalize(path.join('dist', target))) {
    console.error(`refusing to write a build with no EVM engine into dist/${target}: that is the loaded directory`);
    process.exit(1);
  }
  run(node, [viteBin, 'build'], { TARGET: target, EVM_ENABLED: evm ? '1' : '0', OUT_DIR: relOut.split(path.sep).join('/') });

  const dist = path.join(root, relOut);
  copyFileSync(path.join(root, 'platforms', target, 'manifest.json'), path.join(dist, 'manifest.json'));

  const overrides = path.join(root, 'platforms', target, 'overrides');
  if (existsSync(overrides) && readdirSync(overrides).some((f) => f !== '.gitkeep')) {
    cpSync(overrides, dist, { recursive: true, filter: (src) => path.basename(src) !== '.gitkeep' });
  }
  const manifestOut = path.join(dist, 'manifest.json');
  if (evm) {
    injectEvmHosts(manifestOut);
    assertEvmSymbols(dist);
    const secrets = path.join(root, 'platforms', 'evm-secrets.local.json');
    const hasKey = !!process.env.ALCHEMY_API_KEY || (existsSync(secrets) && /"alchemyApiKey"\s*:\s*"[^"]+"/.test(readFileSync(secrets, 'utf8')));
    if (evmGateway) {
      assertNoDevKey(dist, secrets);
      console.log(`  gateway: ${evmGateway} (RPC, history, token import, lists and marks; no client key, verified absent from dist)`);
    }
    else console.log(hasKey ? '  alchemy: dev key injected (RPC first, history + token import)' : '  alchemy: no key (public RPCs, Blockscout history on Base only)');
  }
  else {
    assertNoEvmSymbols(dist);
    assertNoEvmHosts(manifestOut);
  }
  assertGatewayPrices(dist, manifestOut);
  writeBuildInfo(dist, target);
  console.log(`  -> ${relOut.split(path.sep).join('/')} (v${pkgVersion}, ${evm ? `EVM${evmGateway ? ' + gateway' : ''}` : 'no EVM'})`);
}

// After ANY build, say plainly what the loaded directory now holds. A store
// build cannot have touched it (refused above), but a stale or missing
// dist/chrome is worth naming here rather than discovering in the browser.
{
  const loaded = path.join(root, 'dist', 'chrome', 'build-info.json');
  if (existsSync(loaded)) {
    try {
      const info = JSON.parse(readFileSync(loaded, 'utf8'));
      console.log(`  dist/chrome (the loaded directory) holds v${info.version}, ${info.evm ? 'EVM' : 'NO EVM'}, built ${info.builtAt}`);
      if (!info.evm) console.log('  WARNING: dist/chrome has no EVM engine. Run `npm run build:evm`.');
    } catch { /* an unreadable build-info is not worth failing a build over */ }
  }
}
