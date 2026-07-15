// Multi-target build orchestrator.
//
//   node scripts/build.mjs --target=chrome|edge|firefox|all
//
// Runs typecheck ONCE, then a vite build per requested target. Each target's
// manifest.json lives under platforms/<target>/ (public/ no longer carries it),
// so after vite emits dist/<target> we copy the manifest in. If
// platforms/<target>/overrides/ holds files, they are overlaid (recursively)
// on top of the dist output last, so a target can override any built file.
import { spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['chrome', 'edge', 'firefox'];

const arg = process.argv.find((a) => a.startsWith('--target='));
const requested = (arg ? arg.slice('--target='.length) : 'chrome').toLowerCase();
const targets = requested === 'all' ? ALL : [requested];

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

for (const target of targets) {
  console.log(`build ${target}...`);
  run(node, [viteBin, 'build'], { TARGET: target });

  const dist = path.join(root, 'dist', target);
  copyFileSync(path.join(root, 'platforms', target, 'manifest.json'), path.join(dist, 'manifest.json'));

  const overrides = path.join(root, 'platforms', target, 'overrides');
  if (existsSync(overrides) && readdirSync(overrides).some((f) => f !== '.gitkeep')) {
    cpSync(overrides, dist, { recursive: true, filter: (src) => path.basename(src) !== '.gitkeep' });
  }
  console.log(`  -> dist/${target}`);
}
