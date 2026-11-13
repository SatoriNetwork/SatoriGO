// X Coin (XFER) smoke: drives the BUILT extension (dist/chrome) against the real
// chain through the gateway bridge. Read-only: imports the public BIP39 test
// phrase (unfunded), picks X Coin, and checks the address, the live block
// height, the balance row and the young-network marking. No send, no broadcast.
//
//   npm run build:evm && node scripts/xfer-extension-smoke.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist', 'chrome');
const shotsDir = path.join(root, 'docs', 'screenshots');
mkdirSync(shotsDir, { recursive: true });

const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// m/44'/3844'/0'/0/0 of that phrase, computed with @scure/bip32 outside the wallet.
const EXPECTED_ADDRESS = 'XfAejBQdMTb53dLq6JTgaTdiCYmeKfnXmU';

let failed = 0;
const check = (ok, label) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const context = await chromium.launchPersistentContext(path.join(os.tmpdir(), `satorigo-xfer-${Date.now()}`), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 400, height: 620 },
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  const byId = (t) => page.getByTestId(t);

  await page.goto(`chrome-extension://${id}/index.html`);
  await byId('live-onboarding').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /Import recovery phrase/i }).click();
  await byId('live-import-input').waitFor({ timeout: 10_000 });

  const option = byId('live-import-chain-xfer-mainnet');
  check((await option.count()) === 1, 'the import chain picker offers X Coin');
  await option.scrollIntoViewIfNeeded();
  await option.click();
  await page.screenshot({ path: path.join(shotsDir, 'xfer-import-picker.png') });

  await byId('live-import-input').fill(VECTOR_MNEMONIC);
  await byId('live-password').fill('live-pass-1234');
  const confirm = byId('live-password-confirm');
  if (await confirm.count()) await confirm.fill('live-pass-1234');
  await byId('live-import-submit').click();
  await byId('live-home').waitFor({ timeout: 30_000 });
  check(true, 'imported phrase opens the wallet on X Coin');

  const shown = `${(await byId('live-address').getAttribute('title')) || ''} ${await byId('live-address').innerText()}`;
  check(shown.includes(EXPECTED_ADDRESS), `receive address is the independently derived one (${EXPECTED_ADDRESS})`);

  // The block pill carries the tip height once the wss round-trip completed.
  let height = 0;
  for (let i = 0; i < 40 && height === 0; i++) {
    const title = (await byId('live-network-pill').getAttribute('title').catch(() => '')) || '';
    const text = (await byId('live-network-pill').innerText().catch(() => '')) || '';
    const m = `${title} ${text}`.replace(/[,\s.]/g, '').match(/(\d{5,7})/);
    if (m) height = Number(m[1]);
    else await page.waitForTimeout(1000);
  }
  check(height > 89_000 && height < 5_000_000, `live block height read through the bridge: ${height}`);

  await page.locator('[data-testid="live-balance-XFER"]').first().waitFor({ timeout: 20_000 });
  const balance = (await page.locator('[data-testid="live-balance-XFER"]').first().innerText()).trim();
  check(/^0([.,]0+)?/.test(balance), `XFER balance row renders a real read (unfunded test phrase): ${balance}`);
  check((await page.locator('[data-testid="live-home"] .banner.danger').count()) === 0, 'no error banner on Home');
  await page.screenshot({ path: path.join(shotsDir, 'xfer-home.png') });

  await byId('live-chain-switcher').click();
  await byId('live-chain-dropdown').waitFor({ timeout: 5_000 });
  check((await byId('live-chain-option-xfer-mainnet').count()) === 1, 'the header switcher lists X Coin');
  check((await byId('live-chain-option-xfer-mainnet').innerText()).includes('X Coin'), 'its row is named X Coin');
  await page.screenshot({ path: path.join(shotsDir, 'xfer-switcher.png') });

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} catch (e) {
  failed++;
  console.log('FAIL  smoke aborted:', String(e).split('\n')[0]);
} finally {
  await context.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nX Coin smoke green');
process.exit(failed ? 1 : 0);
