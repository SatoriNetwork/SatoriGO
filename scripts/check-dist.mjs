#!/usr/bin/env node
// Is the directory the owner loads unpacked (dist/chrome) an EVM build?
//
// It always should be: scripts/build.mjs REFUSES to write a store build there
// (store builds go to dist/store/<target>). This is the cheap check that says
// so out loud, for a gate, a hook, or a quick answer to "where did the EVM
// chains go?". Exit 0 when dist/chrome is an EVM build, 1 otherwise.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const info = path.join(root, 'dist', 'chrome', 'build-info.json');

if (!existsSync(info)) {
  console.error('dist/chrome does not exist yet. Run `npm run build:evm`.');
  process.exit(1);
}
let parsed;
try {
  parsed = JSON.parse(readFileSync(info, 'utf8'));
} catch (err) {
  console.error(`dist/chrome/build-info.json is unreadable: ${err.message}`);
  process.exit(1);
}
if (!parsed.evm) {
  console.error(`dist/chrome is a NO-EVM build (v${parsed.version}, built ${parsed.builtAt}).`);
  console.error('The wallet would show no EVM chains. Run `npm run build:evm`.');
  process.exit(1);
}
console.log(`dist/chrome: v${parsed.version}, EVM${parsed.gatewayUrl ? ` + gateway ${parsed.gatewayUrl}` : ''}, built ${parsed.builtAt}`);
