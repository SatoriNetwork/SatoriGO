// Packs dist/chrome-extension into release/satori-go-chrome.zip.
import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, '..', 'dist', 'chrome-extension');
const releaseDir = path.join(root, '..', 'release');
const zipPath = path.join(releaseDir, 'satori-go-chrome.zip');

if (!existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/chrome-extension/manifest.json not found — run `npm run build` first.');
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
const zip = new AdmZip();
zip.addLocalFolder(dist);
zip.writeZip(zipPath);
const sizeKb = Math.round(statSync(zipPath).size / 1024);
console.log(`Created ${zipPath} (${sizeKb} KB)`);
