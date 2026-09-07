// Generates Chrome Web Store listing assets into store/.
//
//   node scripts/store-assets.mjs
//
// CWS hard requirements (these are why this script exists):
//   - screenshots: EXACTLY 1280x800 or 640x400. Our popup is 400x620, so each
//     capture is composed onto a 1280x800 branded canvas with a caption.
//   - JPEG or 24-BIT PNG, NO ALPHA. sharp writes RGBA by default even when the
//     canvas underneath is opaque, so every output is flattened onto the
//     background and its alpha channel removed. A 32-bit PNG is rejected at
//     upload, and the rejection does not say which of the five files was wrong.
//   - AT MOST FIVE screenshots. The listing takes no more, so the script picks
//     them in a deliberate order (PICK below) instead of shipping whatever
//     happened to sort first.
//   - small promo tile: EXACTLY 440x280.
//
// SOURCE SCREENSHOTS: docs/screenshots/*.png are produced by the live smoke, which
// runs against an UNFUNDED test wallet — they show "0 EVR" / "No SATORIEVR to stake".
// Do NOT ship those to the store: they sell an empty product, and two of them are
// blank. Re-capture from a wallet that actually holds EVR + SATORIEVR, drop the PNGs
// in store/raw/ (400x620), and re-run this. We never fabricate balances.
import sharp from 'sharp';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(root, '..');
const iconPath = path.join(repo, 'src', 'assets', 'satori-avatar-512.png');
const outDir = path.join(repo, 'store');
const shotOut = path.join(outDir, 'screenshots');

// Prefer hand-picked, funded captures from store/raw; fall back to the smoke's.
const rawDir = path.join(outDir, 'raw');
const srcDir = existsSync(rawDir) ? rawDir : path.join(repo, 'docs', 'screenshots');

const BG = '#0b0d17';
const ACCENT = '#7c6cf5';

/** Caption per source file. Keys are matched as a substring of the filename. */
const CAPTIONS = [
  ['home', 'Many networks, one wallet', 'Coins, assets and tokens, with live balances from each network.'],
  ['send', 'Send with a real fee review', 'Every transaction is built, signed and confirmed by you.'],
  ['asset-send', 'Send what you hold', 'Coins, on-chain assets and tokens, all through the same review.'],
  ['asset-detail', 'Assets and tokens, found for you', 'What an account holds is detected; add anything else yourself.'],
  ['receive', 'Receive', 'Multiple addresses per wallet.'],
  ['multiwallet', 'Several wallets at once', 'From a recovery phrase, or import an existing key.'],
  ['recovery-settings', 'A way back if you forget', 'A recovery code and an encrypted backup file, both kept by you.'],
  ['recovery-code', 'Your recovery code', 'Shown once. It opens the wallet if the password is gone.'],
  ['staking', 'Stake where the network allows it', 'See what is staked and what it earned, and choose a validator.'],
  ['side-panel', 'Docked beside your work', 'The wallet stays open while you browse, instead of closing.'],
  ['settings-root', 'Settings that stay out of the way', 'Everyday choices up front, the rest behind an expert switch.'],
  ['app-lock', 'One password for the whole wallet', 'Optional. You type it once, then choose which wallet to open.'],
  ['lock', 'Locked by default', 'AES-256-GCM, unlocked only by your password.'],
];

/**
 * The five that get shipped, in listing order, matched as a filename substring.
 *
 * A deliberate list rather than "the first five alphabetically": the listing
 * allows five and the source directory holds twenty, so without this the choice
 * is made by a numeric prefix nobody thought about. First one wins per slot.
 */
const PICK = ['live-home', 'app-lock', 'recovery-settings', 'staking', 'side-panel-narrow'];
const MAX_SHOTS = 5;

function captionFor(file) {
  // longest key wins, so 'asset-send' beats 'send'
  const hit = [...CAPTIONS].sort((a, b) => b[0].length - a[0].length).find(([k]) => file.includes(k));
  return hit ? { title: hit[1], sub: hit[2] } : { title: 'Satori GO', sub: 'EVRmore wallet for the Satori Network.' };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Write a composed image as a 24-bit PNG with NO alpha channel.
 *
 * IT HAS TO BE A SECOND PASS, which is the whole reason this exists. sharp
 * applies operations in a fixed internal order rather than the order they are
 * chained: `flatten` runs at the input stage, BEFORE `composite`, so an overlay
 * carrying alpha puts the channel straight back and the file lands as 32-bit
 * RGBA. The store rejects that at upload and does not say which file was wrong.
 * Re-opening the composed buffer is the only way to be certain, so this checks
 * its own output before returning.
 */
async function writeOpaquePng(pipeline, dest) {
  const composed = await pipeline.png().toBuffer();
  await sharp(composed).flatten({ background: BG }).removeAlpha().png({ compressionLevel: 9 }).toFile(dest);
  const meta = await sharp(dest).metadata();
  if (meta.hasAlpha || meta.channels !== 3) {
    throw new Error(`${dest} still carries alpha (${meta.channels} channels)`);
  }
}

/** Greedy word-wrap. The caption column is narrow — unwrapped text ran under the
 *  screenshot and got clipped. maxChars is tuned for 24px Segoe UI in ~620px. */
function wrap(text, maxChars) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

await mkdir(shotOut, { recursive: true });
// CLEAR THE OUTPUT FIRST. A previous release left eleven files here while this
// listing takes five, and the extra ones look exactly as finished as the real
// ones. Uploading last release's screenshot is a quiet mistake, so make it
// impossible rather than obvious.
for (const stale of await readdir(shotOut)) {
  await rm(path.join(shotOut, stale), { force: true });
}

// ---------------------------------------------------------------- screenshots
const allFiles = (await readdir(srcDir)).filter((f) => f.endsWith('.png')).sort();
// Take PICK in order, then top up from whatever is left if a pick is missing,
// so a renamed capture degrades to "one fewer deliberate choice" rather than to
// an empty listing.
const picked = PICK.map((k) => allFiles.find((f) => f.includes(k))).filter(Boolean);
const files = [...new Set([...picked, ...allFiles])].slice(0, MAX_SHOTS);
console.log(`source: ${srcDir}`);
console.log(`picked ${files.length} of ${allFiles.length}: ${files.join(', ')}`);
let made = 0;

for (const file of files) {
  const src = path.join(srcDir, file);
  const meta = await sharp(src).metadata();

  // Skip the blank captures the smoke sometimes emits (solid colour => stdev ~0).
  const stats = await sharp(src).stats();
  const stdev = stats.channels.slice(0, 3).reduce((a, c) => a + c.stdev, 0) / 3;
  if (stdev < 6) {
    console.warn(`SKIP ${file}: blank capture (stdev ${stdev.toFixed(1)})`);
    continue;
  }

  const { title, sub } = captionFor(file);

  // Popup scaled to 700px tall, right-hand side; caption on the left.
  const shotH = 700;
  const shotW = Math.round((meta.width / meta.height) * shotH);
  const shotTop = Math.round((800 - shotH) / 2);
  const shotLeft = 1280 - shotW - 110;

  // Rounded corners, so the capture reads as a device rather than a pasted rectangle.
  const roundMask = Buffer.from(
    `<svg width="${shotW}" height="${shotH}" xmlns="http://www.w3.org/2000/svg">
       <rect width="${shotW}" height="${shotH}" rx="18" ry="18" fill="#fff"/>
     </svg>`,
  );
  const shot = await sharp(src)
    .resize(shotW, shotH, { kernel: 'lanczos3' })
    .composite([{ input: roundMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // Caption column: everything left of the screenshot, minus margins.
  const colWidth = shotLeft - 90 - 40;
  const titleLines = wrap(title, Math.floor(colWidth / 27)); // ~27px per char at 52px bold
  const subLines = wrap(sub, Math.floor(colWidth / 12)); // ~12px per char at 24px

  const titleY = 400 - (titleLines.length - 1) * 30;
  const titleSvg = titleLines
    .map(
      (l, i) =>
        `<text x="90" y="${titleY + i * 62}" font-family="Segoe UI, Arial, sans-serif"
               font-size="52" font-weight="700" fill="#ffffff">${esc(l)}</text>`,
    )
    .join('');
  const subTop = titleY + (titleLines.length - 1) * 62 + 50;
  const subSvg = subLines
    .map(
      (l, i) =>
        `<text x="90" y="${subTop + i * 32}" font-family="Segoe UI, Arial, sans-serif"
               font-size="24" fill="#a6accd">${esc(l)}</text>`,
    )
    .join('');
  const ruleY = subTop + (subLines.length - 1) * 32 + 34;

  const canvas = Buffer.from(`
    <svg width="1280" height="800" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="g" cx="72%" cy="18%" r="85%">
          <stop offset="0%" stop-color="#1b1f3a"/>
          <stop offset="100%" stop-color="${BG}"/>
        </radialGradient>
      </defs>
      <rect width="1280" height="800" fill="url(#g)"/>
      ${titleSvg}
      ${subSvg}
      <rect x="90" y="${ruleY}" width="64" height="4" rx="2" fill="${ACCENT}"/>
    </svg>`);

  await writeOpaquePng(
    sharp(canvas).composite([{ input: shot, left: shotLeft, top: shotTop }]),
    path.join(shotOut, file.replace(/^\d+-/, '')),
  );
  made++;
  console.log(`screenshot: ${file} -> 1280x800 ("${title}")`);
}

// --------------------------------------------------------------- promo tile
const icon = await sharp(await readFile(iconPath)).resize(150, 150).png().toBuffer();
const promo = Buffer.from(`
  <svg width="440" height="280" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="p" cx="20%" cy="15%" r="95%">
        <stop offset="0%" stop-color="#1b1f3a"/>
        <stop offset="100%" stop-color="${BG}"/>
      </radialGradient>
    </defs>
    <rect width="440" height="280" fill="url(#p)"/>
    <text x="196" y="150" font-family="Segoe UI, Arial, sans-serif" font-size="40"
          font-weight="700" fill="#ffffff">Satori GO</text>
    <text x="196" y="182" font-family="Segoe UI, Arial, sans-serif" font-size="16"
          fill="#a6accd">Multi-chain wallet made</text>
    <text x="196" y="204" font-family="Segoe UI, Arial, sans-serif" font-size="16"
          fill="#a6accd">by Satori Network</text>
  </svg>`);

await writeOpaquePng(
  sharp(promo).composite([{ input: icon, left: 26, top: 65 }]),
  path.join(outDir, 'promo-440x280.png'),
);

console.log(`promo tile: store/promo-440x280.png`);
console.log(`\n${made} screenshot(s) written to store/screenshots (source: ${path.relative(repo, srcDir)})`);
if (srcDir.includes('docs')) {
  console.warn(
    '\nWARNING: sourced from docs/screenshots — those are captures of an UNFUNDED wallet\n' +
      '(0 EVR, "No SATORIEVR to stake"). They are NOT fit for the store listing.\n' +
      'Re-capture from a funded wallet into store/raw/ and re-run.',
  );
}
