// Generates the extension icons (16/32/48/128) from the OFFICIAL Satori Network
// avatar (github.com/SatoriNetwork, src/assets/satori-avatar-512.png): the black
// Satori mark inside an enso ring on a white disc, with TRANSPARENT corners.
//
// Used full-bleed (the disc fills the whole canvas) on purpose. Chrome renders the
// toolbar action icon in a 16 CSS px box, so any padding we add is padding stolen
// from the mark — an earlier design lost real legibility that way. The artwork
// already carries its own interior breathing room, and because the corners are
// transparent it reads as a round badge rather than a white tile on both light and
// dark toolbars.
//
// Run: node scripts/generate-icons.mjs   (outputs -> public/icons)
import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(root, '..', 'src', 'assets', 'satori-avatar-512.png');
const outDir = path.join(root, '..', 'public', 'icons');

const SIZES = [16, 32, 48, 128];

await mkdir(outDir, { recursive: true });
const source = await readFile(sourcePath);

for (const size of SIZES) {
  await sharp(source)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }, // keep the corners transparent
      kernel: 'lanczos3',
    })
    .png()
    .toFile(path.join(outDir, `icon${size}.png`));
  console.log(`icon${size}.png written (official Satori avatar, full-bleed)`);
}
