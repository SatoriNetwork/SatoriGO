// Builds every target (or the ones passed via --target) and packs each
// dist/<target> into release/satori-go-<target>.zip.
//
//   node scripts/package.mjs                 # all three
//   node scripts/package.mjs --target=chrome # just one
//
// Assumes the dist output already exists is NOT safe here, so it invokes
// scripts/build.mjs first for the requested target(s).
import AdmZip from 'adm-zip';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['chrome', 'edge', 'firefox'];

const arg = process.argv.find((a) => a.startsWith('--target='));
const requested = (arg ? arg.slice('--target='.length) : 'all').toLowerCase();
const targets = requested === 'all' ? ALL : [requested];

for (const t of targets) {
  if (!ALL.includes(t)) {
    console.error(`Unknown target: ${t} (expected ${ALL.join(', ')} or all)`);
    process.exit(1);
  }
}

// Build first (typecheck runs once inside build.mjs).
const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), `--target=${requested}`], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const releaseDir = path.join(root, 'release');
mkdirSync(releaseDir, { recursive: true });

for (const target of targets) {
  const dist = path.join(root, 'dist', target);
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    console.error(`dist/${target}/manifest.json not found after build.`);
    process.exit(1);
  }
  const zipPath = path.join(releaseDir, `satori-go-${target}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(dist);
  zip.writeZip(zipPath);
  const sizeKb = Math.round(statSync(zipPath).size / 1024);
  console.log(`Created release/satori-go-${target}.zip (${sizeKb} KB)`);
}
