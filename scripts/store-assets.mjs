// Generates Chrome Web Store listing assets into store/.
//
//   node scripts/store-assets.mjs
//
// CWS hard requirements (these are why this script exists):
//   - screenshots: EXACTLY 1280x800 or 640x400. Our popup is 400x620, so each
//     capture is composed onto a 1280x800 branded canvas with a caption.
//   - small promo tile: EXACTLY 440x280.
//
// SOURCE SCREENSHOTS: docs/screenshots/*.png are produced by the live smoke, which
// runs against an UNFUNDED test wallet — they show "0 EVR" / "No SATORIEVR to stake".
// Do NOT ship those to the store: they sell an empty product, and two of them are
// blank. Re-capture from a wallet that actually holds EVR + SATORIEVR, drop the PNGs
// in store/raw/ (400x620), and re-run this. We never fabricate balances.
import sharp from 'sharp';
import { mkdir, readdir, readFile } from 'node:fs/promises';
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
  ['home', 'Your EVR and assets, live', 'Real balances straight from the Evrmore network.'],
  ['send', 'Send with a real fee review', 'Every transaction is built, signed and confirmed by you.'],
  ['asset-send', 'Send any EVRmore asset', 'SATORIEVR and every other asset you hold.'],
  ['asset-detail', 'Assets, auto-detected', 'The wallet finds every EVRmore asset you own.'],
  ['receive', 'Receive', 'Multiple addresses per wallet.'],
  ['multiwallet', 'Multiple wallets', 'A recovery phrase, or import a Satori private key.'],
  ['staking', 'Stake SATORIEVR', 'Delegate to a Satori pool. No funds move — an off-chain signature.'],
  ['passwordless', 'Your keys, encrypted', 'Seeds never leave your machine unencrypted.'],
  ['lock', 'Locked by default', 'AES-256-GCM, unlocked only by your password.'],
];

function captionFor(file) {
  // longest key wins, so 'asset-send' beats 'send'
  const hit = [...CAPTIONS].sort((a, b) => b[0].length - a[0].length).find(([k]) => file.includes(k));
  return hit ? { title: hit[1], sub: hit[2] } : { title: 'Satori GO', sub: 'EVRmore wallet for the Satori Network.' };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// ---------------------------------------------------------------- screenshots
const files = (await readdir(srcDir)).filter((f) => f.endsWith('.png')).sort();
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

  await sharp(canvas)
    .composite([{ input: shot, left: shotLeft, top: shotTop }])
    .png()
    .toFile(path.join(shotOut, file.replace(/^\d+-/, '')));
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
          fill="#a6accd">EVRmore wallet for the</text>
    <text x="196" y="204" font-family="Segoe UI, Arial, sans-serif" font-size="16"
          fill="#a6accd">Satori Network</text>
  </svg>`);

await sharp(promo)
  .composite([{ input: icon, left: 26, top: 65 }])
  .png()
  .toFile(path.join(outDir, 'promo-440x280.png'));

console.log(`promo tile: store/promo-440x280.png`);
console.log(`\n${made} screenshot(s) written to store/screenshots (source: ${path.relative(repo, srcDir)})`);
if (srcDir.includes('docs')) {
  console.warn(
    '\nWARNING: sourced from docs/screenshots — those are captures of an UNFUNDED wallet\n' +
      '(0 EVR, "No SATORIEVR to stake"). They are NOT fit for the store listing.\n' +
      'Re-capture from a funded wallet into store/raw/ and re-run.',
  );
}
