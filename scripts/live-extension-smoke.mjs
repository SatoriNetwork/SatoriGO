// Live-mode smoke test: loads the built extension, opens the popup, enters the
// Live surface, imports the Trezor vector seed, and verifies the wallet talks
// to the REAL Evrmore chain over wss (network status, dynamic balances, receive)
// and that the real send path reaches coin selection. Also exercises the dynamic
// MetaMask-style asset flow: the empty seed shows EVR ONLY (no phantom SATORI),
// EVR + SATORIEVR are pinned and NOT removable; adding/removing is exercised with the
// legacy SATORI asset, and a bogus name is rejected.
// Multi-address (1.8.0): the seed wallet derives a second receive address via
// the Receive picker; the pk (Satori) wallet stays single-address.
// 1.9.0: connection LED replaces the red LIVE banner, demo-style settings with
// section rows -> sub-screens, wallet-switcher delete affordance, my-wallets
// quick-pick by name in Send, wallet-switch loading screen, and the demo<->live
// round-trip through the new home entry point.
// Demo-layout home: a bottom tab bar (Wallet / Activity / Settings) replaces the
// inline pill tabs + header gear — live-tab-assets / live-tab-activity /
// live-settings-btn are the bottom tabs now. Lock + Switch-to-Demo moved into
// the header "more" menu (live-menu-btn). The lock screen lists all wallets
// (live-lock-wallets) with the last-used one preselected.
// No funds, no broadcast.
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist', 'chrome-extension');
const shotsDir = path.join(root, 'docs', 'screenshots');
mkdirSync(shotsDir, { recursive: true });
const userDataDir = path.join(os.tmpdir(), `evrdemo-live-${Date.now()}`);

const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECIPIENT = 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF';
// A known-valid compressed WIF (Bitcoin's). The key material is a legal secp256k1
// scalar, so importing it derives a valid EVRmore E-address (we assert the address
// shape + Satori badge, not an exact vector address).
// A real Evrmore WIF (the test vector's m/44'/175'/0'/0/0 key) -> address
// EMc6LdHEHRtTLRZgPQEJoEtUonJbX2D9Ew. Importing it must reproduce that address.
// NOT A SECRET: derived from the PUBLIC BIP39 test-vector mnemonic above
// ("abandon ... about") — a publicly known, deliberately unfunded key. Secret
// scanners flagging this line can safely ignore it.
const PK_WIF = 'L37GeVaqwRDGoeHckfe8DmzsbDTBgmEuMBAZ7KDPDHN6RpUovWRP';

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 400, height: 620 },
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
});

async function extId() {
  const w = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  return new URL(w.url()).host;
}
const id = await extId();
// `let`, not `const`: the "open in a separate window" button CLOSES the page it is
// clicked from (that is the whole point of it), so the run has to reopen one.
let page = await context.newPage();
page.on('console', (m) => { const t = m.text(); if (/error|fail|refused|csp|websocket|electrum/i.test(t)) console.log('  [page]', t.slice(0, 160)); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0].slice(0, 160)));
const byId = (t) => page.getByTestId(t);
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

try {
  await page.goto(`chrome-extension://${id}/index.html`);
  // The real wallet is the whole app now (demo removed) — it boots straight into
  // the live onboarding choose screen.
  await byId('live-onboarding').waitFor({ timeout: 15_000 });
  check(true, 'app boots directly into the live wallet (no demo)');

  // Import the vector seed (the choose-screen button is labelled, not test-id'd).
  await page.getByRole('button', { name: /Import recovery phrase/i }).click();
  await byId('live-import-input').waitFor({ timeout: 10_000 });
  await byId('live-import-input').fill(VECTOR_MNEMONIC);
  await byId('live-password').fill('live-pass-1234');
  const confirm = byId('live-password-confirm');
  if (await confirm.count()) await confirm.fill('live-pass-1234');
  await byId('live-import-submit').click();

  // Real network: wait for the LiveHome, then for the network pill to reflect a
  // real block height (proves the wss round-trip completed inside the extension).
  await byId('live-home').waitFor({ timeout: 25_000 });
  check(true, 'imported seed -> Live home renders');
  const addr = (await byId('live-address').innerText()).trim();
  check(/^E[a-zA-Z0-9]/.test(addr), `real receive address shown: ${addr}`);

  // Poll the pill text up to 30s for a real "Block <height>" label.
  let pill = '';
  for (let i = 0; i < 30; i++) {
    pill = (await page.locator('[data-testid="live-network-pill"]').innerText().catch(() => '')) || '';
    if (/block\s*[\d,]/i.test(pill)) break;
    await page.waitForTimeout(1000);
  }
  check(/block\s*[\d,]/i.test(pill), `live network reached real chain: "${pill.replace(/\s+/g, ' ').trim()}"`);

  // 1.9.0: the shouting red LIVE banner is GONE from home; a small connection
  // LED (green/yellow/red) in the header carries the status instead.
  check((await byId('live-led').count()) === 1, 'connection LED present in the header');
  const ledState = (await byId('live-led').getAttribute('data-state')) || '';
  check(
    ['connected', 'syncing', 'offline'].includes(ledState),
    `LED exposes a connection state (${ledState})`,
  );
  check(
    (await page.locator('[data-testid="live-home"] .banner.danger').count()) === 0,
    'red danger banner removed from live home',
  );
  const homeText = await byId('live-home').innerText();
  check(!/LIVE — Real EVRmore/i.test(homeText), 'red LIVE wording removed from live home');

  // Demo-layout home: the bottom tab bar exists with Wallet / Activity / Settings.
  check((await page.locator('[data-testid="live-home"] .bottom-nav').count()) === 1, 'bottom tab bar present on live home');
  check(await byId('live-tab-assets').isVisible(), 'bottom tab: Wallet (assets) visible');
  check(await byId('live-tab-activity').isVisible(), 'bottom tab: Activity visible');
  check(await byId('live-tab-network').isVisible(), 'bottom tab: Network (Satori) visible');
  check(await byId('live-settings-btn').isVisible(), 'bottom tab: Settings visible');
  check(await byId('live-detach-btn').isVisible(), 'header: "open in a separate window" button present');

  // Dynamic assets: the imported vector seed holds nothing. The list therefore shows
  // EVR plus SATORIEVR, which is pinned by default (a Satori wallet should not make
  // you "Add token" for the Satori asset). There must still be NO row for the LEGACY
  // 'SATORI' asset — that phantom row was the bug dynamic detection fixed, and the
  // default pin must not bring it back.
  await page.locator('[data-testid="live-balance-EVR"]').first().waitFor({ timeout: 20_000 });
  check((await page.locator('[data-testid="live-balance-EVR"]').count()) >= 1, 'EVR balance row renders (real read)');
  check((await page.locator('[data-testid="live-balance-SATORI"]').count()) === 0, 'no phantom LEGACY SATORI row');
  await page.locator('[data-testid="live-balance-SATORIEVR"]').first().waitFor({ timeout: 20_000 });
  check(
    (await page.locator('[data-testid="live-balance-SATORIEVR"]').count()) === 1,
    'SATORIEVR is pinned by default (no "Add token" needed)',
  );

  // EVR and SATORIEVR are the two assets the wallet is FOR, so neither offers a
  // remove control: no "x" on their rows.
  check(
    (await page.locator('[data-testid="live-remove-asset-EVR"]').count()) === 0,
    'EVR has no remove (x) control',
  );
  check(
    (await page.locator('[data-testid="live-remove-asset-SATORIEVR"]').count()) === 0,
    'SATORIEVR has no remove (x) control',
  );

  // --- Satori Network statistics tab ---------------------------------------
  // Proves the six figures are really fetched from satorinet.io FROM INSIDE the
  // extension (host_permissions + no CORS), not just parsed in a unit test.
  await byId('live-tab-network').click();
  await byId('live-network-grid').waitFor({ timeout: 25_000 });
  check((await page.locator('.stat-tile').count()) === 6, 'Network tab shows the 6 satorinet.io stat tiles');

  // The grid paints IMMEDIATELY with "n/a" placeholders and fills in when the fetch
  // resolves, so reading it the moment it appears would test nothing. Wait for real
  // data to land first.
  await page
    .locator('[data-testid="live-stat-predictions"] .stat-value:not(:has(.stat-value-missing))')
    .waitFor({ timeout: 30_000 });

  /** The big number only, without the label/caption around it. */
  const statValue = async (caption) =>
    (await page.locator(`[data-testid="live-stat-${caption}"] .stat-value`).innerText())
      .replace(/\s+/g, ' ')
      .trim();
  /** Digits as a number, or NaN when the tile is showing "n/a". NEVER 0: a missing
   *  value used to strip down to '' and Number('') === 0, which made the stake-cost
   *  cross-check pass while every tile was empty. */
  const statNumber = async (caption) => {
    const raw = (await statValue(caption)).replace(/[^0-9.]/g, '');
    return raw === '' ? NaN : Number(raw);
  };

  const predictions = await statNumber('predictions');
  const neurons = await statNumber('neurons');
  const holders = await statNumber('wallet-holders');
  const price = await statNumber('satorievr-token');
  const stakeCost = await statNumber('stake-a-neuron');

  check(predictions > 0, `predictions fetched live -> ${predictions}`);
  check(neurons > 0, `connected neurons fetched live -> ${neurons}`);
  check(holders > 0, `wallet holders fetched live -> ${holders}`);
  check(price > 0, `SATORIEVR price fetched live -> $${price}`);
  // satorinet.io derives the stake cost as 250 x price. Cross-check ours against the
  // price we just read, and require both to be real numbers so this cannot pass on
  // two empty tiles.
  check(
    price > 0 && stakeCost > 0 && Math.abs(stakeCost - 250 * price) < 0.02,
    `stake cost is 250 x price ($${stakeCost} vs 250 x $${price})`,
  );
  await page.screenshot({ path: path.join(shotsDir, '30-live-network.png') });

  await byId('live-tab-assets').click();

  // ("Open in a separate window" is exercised at the END of this file: it CLOSES the
  // page it was clicked from, so it would take the rest of the run down with it.)

  // USD prices (0.0.9): the seed is UNFUNDED (0 balances) but prices should still
  // LOAD — CoinEx has no Cloudflare, so the EVR price fetches even headless. Poll
  // up to ~12s for the total-USD hero line AND the EVR row's USD value (both prove
  // the EVR price came through). SATORIEVR (SafeTrade) can be blocked in headless,
  // so we do NOT hard-require the SAT price here.
  let pricesLoaded = false;
  for (let i = 0; i < 24; i++) {
    const totalOk = (await byId('live-total-usd').count()) === 1;
    const evrUsdOk = (await byId('live-asset-usd-EVR').count()) === 1;
    if (totalOk && evrUsdOk) { pricesLoaded = true; break; }
    await page.waitForTimeout(500);
  }
  check(pricesLoaded, 'USD prices loaded: live-total-usd + live-asset-usd-EVR present (EVR price fetched)');

  await page.screenshot({ path: path.join(shotsDir, '20-live-home.png') });

  // Home tabs: Assets ↔ Activity. Default is Assets (EVR row visible). Switching
  // to Activity hides the asset rows and (for the empty vector seed) shows the
  // "no transactions" empty state; switching back to Assets restores the EVR row.
  await byId('live-tab-activity').click({ timeout: 10_000 });
  await byId('live-activity-list').waitFor({ timeout: 10_000 });
  check((await page.locator('[data-testid="live-asset-row-EVR"]').count()) === 0, 'Activity tab hides the asset rows');
  check(/no transactions/i.test(await byId('live-activity-list').innerText()), 'Activity tab shows the empty state (empty seed)');
  await byId('live-tab-assets').click({ timeout: 10_000 });
  await page.locator('[data-testid="live-balance-EVR"]').first().waitFor({ timeout: 10_000 });
  check((await page.locator('[data-testid="live-asset-row-EVR"]').count()) >= 1, 'Assets tab restores the EVR row');

  // Add-asset happy path. SATORIEVR is pinned by default now, so adding it would
  // prove nothing. Use the LEGACY 'SATORI' asset instead: it is real on-chain (so the
  // add flow's on-chain validation is genuinely exercised) and, unlike EVR/SATORIEVR,
  // it is removable, which lets the same step prove the remove control still works
  // for an ordinary asset.
  await byId('live-add-asset').click({ timeout: 10_000 });
  await byId('live-add-asset-input').waitFor({ timeout: 10_000 });
  await byId('live-add-asset-input').fill('SATORI');
  await byId('live-add-asset-submit').click();
  await page.locator('[data-testid="live-balance-SATORI"]').waitFor({ timeout: 25_000 });
  check(true, 'add-asset: real (legacy) asset SATORI added -> row appears');

  // ...and it CAN be removed, unlike the two protected ones.
  await byId('live-remove-asset-SATORI').click({ timeout: 10_000 });
  await page.locator('[data-testid="live-balance-SATORI"]').waitFor({ state: 'detached', timeout: 15_000 });
  check(
    (await page.locator('[data-testid="live-balance-SATORI"]').count()) === 0,
    'remove-asset: an ordinary asset still removes cleanly',
  );

  // With SATORIEVR now in the list, its USD price should load from satorinet.io
  // (primary; SafeTrade fallback). Proves the (Cloudflare-fronted) fetch works
  // from the extension. Tolerant: poll ~12s; log if it doesn't come through.
  let satUsd = false;
  for (let i = 0; i < 24; i++) {
    if ((await byId('live-asset-usd-SATORIEVR').count()) === 1) { satUsd = true; break; }
    await page.waitForTimeout(500);
  }
  check(satUsd, 'SATORIEVR USD price loaded (satorinet.io/SafeTrade reachable from the extension)');

  // Add-asset validation: a bogus name must be rejected with an inline error.
  await byId('live-add-asset').click({ timeout: 10_000 });
  await byId('live-add-asset-input').waitFor({ timeout: 10_000 });
  await byId('live-add-asset-input').fill('SATOREVR');
  await byId('live-add-asset-submit').click();
  await byId('live-add-asset-error').waitFor({ timeout: 25_000 });
  const addErr = (await byId('live-add-asset-error').innerText()).trim();
  check(/not found/i.test(addErr), `add-asset: bogus name rejected -> "${addErr}"`);
  await page.getByRole('button', { name: /^Cancel$/i }).click({ timeout: 10_000 });

  // Receive: QR + full address. Every displayed asset shares ONE receive address,
  // so the SATORIEVR chip must show the identical real EVR address.
  await byId('live-receive').click();
  await byId('live-receive-qr').waitFor({ timeout: 10_000 });
  const full = (await byId('live-receive-address').innerText()).trim();
  check(full.startsWith('E') && full.length === 34, `receive shows full real address (${full.length} chars)`);
  await byId('live-receive-asset-SATORIEVR').click({ timeout: 10_000 });
  const assetAddr = (await byId('live-receive-address').innerText()).trim();
  check(
    assetAddr === full && assetAddr.startsWith('E') && assetAddr.length === 34,
    `SATORIEVR receive uses same real address (${assetAddr})`,
  );

  // Multi-address (new in 1.8.0): a seed wallet starts with ONE address (no
  // picker yet); "New address" derives a second, the picker appears with two
  // entries, and switching entries swaps the shown/QR address.
  check((await byId('live-receive-new-address').count()) === 1, 'multi-address: seed wallet offers New address on Receive');
  check((await byId('live-receive-address-picker').count()) === 0, 'multi-address: no picker while only one address exists');
  await byId('live-receive-new-address').click({ timeout: 10_000 });
  await byId('live-receive-address-picker').waitFor({ timeout: 15_000 });
  const pickerEntries = await page.locator('[data-testid^="live-receive-addr-"]').count();
  check(pickerEntries === 2, `multi-address: picker lists 2 addresses after adding (${pickerEntries})`);
  await byId('live-receive-addr-1').click({ timeout: 10_000 });
  const addr1 = (await byId('live-receive-address').innerText()).trim();
  check(
    addr1.startsWith('E') && addr1.length === 34 && addr1 !== full,
    `multi-address: address #1 is a different valid E-address (${addr1})`,
  );
  await byId('live-receive-addr-0').click({ timeout: 10_000 });
  const addr0 = (await byId('live-receive-address').innerText()).trim();
  check(addr0 === full, `multi-address: switching back to #0 restores the original address (${addr0})`);
  await page.screenshot({ path: path.join(shotsDir, '21-live-receive.png') });
  // back to home (the Live screens use an aria-label'd back button, no test-id)
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 10_000 });

  // Remove-asset: hide SATORIEVR and assert its row disappears.
  // (This used to remove SATORIEVR. It is now a PROTECTED asset with no remove
  // control, so the row must SURVIVE. Removal of an ordinary asset is covered above
  // with the legacy SATORI token.)
  check(
    (await page.locator('[data-testid="live-balance-SATORIEVR"]').count()) === 1,
    'SATORIEVR row survives: it cannot be removed',
  );

  // Send: real path reaches coin selection; unfunded -> insufficient-funds.
  await byId('live-send').click({ timeout: 10_000 });
  await byId('live-send-to').waitFor({ timeout: 10_000 });

  // 2.4.0: the EVR send form shows an "Available" line, quick-amount chips
  // (25/50/75/Max) and a network-fee note. The vector seed is unfunded (balance
  // 0), so Max resolves to 0 or an empty field — assert the controls are present
  // and that clicking Max never throws (tolerant of the unfunded seed).
  check((await byId('live-send-available').count()) === 1, 'send: Available balance line present');
  for (const chip of ['25', '50', '75', 'max']) {
    check((await byId(`live-amt-${chip}`).count()) === 1, `send: quick-amount chip live-amt-${chip} present`);
  }
  check((await byId('live-send-fee-note').count()) === 1, 'send: network fee note present');
  let maxThrew = false;
  try {
    await byId('live-amt-max').click({ timeout: 10_000 });
    await page.waitForTimeout(500);
  } catch (e) {
    maxThrew = true;
    console.log('  [max click]', String(e).split('\n')[0].slice(0, 120));
  }
  check(!maxThrew, 'send: clicking live-amt-max does not throw (unfunded -> Max 0/empty)');
  const maxAmt = (await byId('live-send-amount').inputValue()).trim();
  const availText = (await byId('live-send-available').innerText()).trim();
  const availNum = parseFloat((availText.match(/[\d.]+/) || ['0'])[0]);
  const maxNum = parseFloat(maxAmt || '0');
  // Unfunded: Max fills 0 or leaves it empty; if a positive number ever appears
  // (a funded wallet), it must not exceed the shown available balance.
  check(
    maxAmt === '' || maxAmt === '0' || (maxNum > 0 && maxNum <= availNum + 1e-8),
    `send: Max amount within available (max="${maxAmt}", available="${availText}")`,
  );

  await byId('live-send-to').fill(RECIPIENT);
  await byId('live-send-amount').fill('1');
  // The form submit button is labelled (no test-id); building queries live UTXOs.
  await page.getByRole('button', { name: /Review transaction/i }).click({ timeout: 10_000 });
  // Unfunded address -> the real coin-selection path reports insufficient-funds.
  const err = byId('live-send-error');
  await err.waitFor({ timeout: 20_000 }).catch(() => {});
  const errText = (await err.count()) ? await err.innerText() : '';
  check(/insufficient|fund/i.test(errText), `real send path reached coin selection -> "${errText.trim()}"`);
  await page.screenshot({ path: path.join(shotsDir, '22-live-send.png') });

  // Asset detail: from Live home, click an asset row to open its detail screen,
  // then use its Receive action to reach the real receive address. EVR is always
  // present for any address, so click the EVR row (test seed holds only EVR).
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 10_000 });
  await byId('live-asset-row-EVR').click({ timeout: 10_000 });
  await byId('live-asset-detail').waitFor({ timeout: 10_000 });
  check(true, 'asset row -> per-asset detail screen opens');
  await page.screenshot({ path: path.join(shotsDir, '23-live-asset-detail.png') });
  await byId('live-asset-detail-receive').click({ timeout: 10_000 });
  await byId('live-receive-qr').waitFor({ timeout: 10_000 });
  const detailAddr = (await byId('live-receive-address').innerText()).trim();
  check(
    detailAddr.startsWith('E') && detailAddr.length === 34,
    `asset-detail Receive shows real address (${detailAddr})`,
  );

  // Return to home. Receive was opened from the EVR asset detail, so getting
  // home takes up to two backs (receive -> asset detail -> home).
  const backToHome = async () => {
    for (let i = 0; i < 3 && !(await byId('live-home').isVisible().catch(() => false)); i++) {
      await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
      await page.waitForTimeout(300);
    }
    await byId('live-home').waitFor({ timeout: 10_000 });
  };
  await backToHome();

  // Live Settings (restyled in 1.9.0 like the demo): the gear opens a ROOT LIST
  // of section rows; each row opens a focused sub-screen with a back header.
  await byId('live-settings-btn').click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  check(true, 'live-settings-btn opens the Live Settings screen');

  // The bottom nav used to live inside LiveHome, so opening Settings stranded you
  // with nothing but a Back arrow. It must be present on EVERY wallet screen now,
  // with Settings itself shown as the current tab.
  // NOTE: `live-settings` is the .app-content, and the nav is its SIBLING inside the
  // .app-frame, so the nav is not *inside* that element.
  check(
    (await page.locator('.app-frame .bottom-nav').count()) === 1 &&
      (await byId('live-settings').isVisible()),
    'bottom nav stays visible inside Settings',
  );
  check(
    (await byId('live-settings-btn').getAttribute('aria-selected')) === 'true',
    'Settings tab is highlighted while in Settings',
  );
  // ...and it still navigates: jump straight from Settings to the Satori Network tab.
  await byId('live-tab-network').click({ timeout: 10_000 });
  await byId('live-network-grid').waitFor({ timeout: 25_000 });
  check(true, 'nav works from Settings: jumped straight to the Network tab');
  // Back to the Wallet tab, then into Settings again to resume the settings run.
  // (The home tab now PERSISTS across navigation, which is the point: leaving Activity
  // for a tx detail and coming back should not dump you on Wallet. So the tab has to
  // be put back deliberately rather than relying on a remount to reset it.)
  await byId('live-tab-assets').click({ timeout: 10_000 });
  await page.locator('[data-testid="live-balance-EVR"]').first().waitFor({ timeout: 15_000 });
  await byId('live-settings-btn').click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  for (const row of ['appearance', 'wallets', 'addresses', 'security', 'network', 'transactions', 'about']) {
    check((await byId(`live-settings-row-${row}`).count()) === 1, `settings root: ${row} row present`);
  }
  check((await byId('live-address-book-btn').count()) === 1, 'settings root: Address Book row present');

  // Network & Explorer sub-screen: the explorer template defaults to cryptoscope.io.
  await byId('live-settings-row-network').click({ timeout: 10_000 });
  await byId('live-explorer-input').waitFor({ timeout: 10_000 });
  const explorerVal = await byId('live-explorer-input').inputValue();
  check(/cryptoscope\.io/i.test(explorerVal), `settings: explorer default -> "${explorerVal}"`);

  // Electrum server pool (2.6.0): the built-in defaults are listed; add a (fake)
  // server and it appears; an invalid input shows an inline error; remove the
  // added one; reset to defaults. The fake server never actually connects — the
  // wallet fails over to the still-listed real defaults — so we only exercise
  // LIST management + that the reconnect-on-change never throws.
  await byId('live-servers-list').waitFor({ timeout: 10_000 });
  // Match ONLY the numeric server ROWS (live-server-<n>), not the input/add/reset
  // controls that share the live-server- prefix.
  const serverRows = page.getByTestId(/^live-server-\d+$/);
  const serverCountBefore = await serverRows.count();
  check(serverCountBefore >= 1, `settings: default Electrum servers listed (${serverCountBefore})`);

  // Health check: opening Network pings each server. At least one default server
  // (satorinet/evrmorecoin) must report ONLINE within a few seconds.
  let anyOnline = false;
  for (let i = 0; i < 15; i++) {
    const states = await page.getByTestId(/^live-server-status-\d+$/).evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-state')),
    );
    if (states.includes('online')) { anyOnline = true; break; }
    await page.waitForTimeout(1000);
  }
  check(anyOnline, 'settings: a default server reports ONLINE (health check works)');

  await byId('live-server-input').fill('wss://example-electrum.test:50004');
  await byId('live-server-add').click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const listAfterAdd = await byId('live-servers-list').innerText();
  check(/example-electrum\.test:50004/.test(listAfterAdd), 'settings: added Electrum server appears in the list');

  await byId('live-server-input').fill('not a url');
  await byId('live-server-add').click({ timeout: 10_000 });
  await byId('live-server-error').waitFor({ timeout: 10_000 });
  check((await byId('live-server-error').count()) === 1, 'settings: invalid server input shows live-server-error');

  // Remove the server we added (appended last, so it's the last remove button).
  await page.getByTestId(/^live-server-remove-\d+$/).last().click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const listAfterRemove = await byId('live-servers-list').innerText();
  check(!/example-electrum\.test/.test(listAfterRemove), 'settings: removed the added Electrum server');

  // Reset to defaults must not throw (reconnect is best-effort).
  let resetThrew = false;
  try {
    await byId('live-server-reset').click({ timeout: 10_000 });
    await page.waitForTimeout(400);
  } catch (e) {
    resetThrew = true;
    console.log('  [server reset]', String(e).split('\n')[0].slice(0, 120));
  }
  check(!resetThrew, 'settings: reset Electrum servers to defaults (no throw)');

  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });

  // About sub-screen: the "Built by WilQSL" credit is a real X (Twitter) link.
  await byId('live-settings-row-about').click({ timeout: 10_000 });
  await byId('live-about-x').waitFor({ timeout: 10_000 });
  const xHref = await byId('live-about-x').getAttribute('href');
  check(
    !!xHref && /x\.com\/WilQSL/i.test(xHref),
    `about: "Built by WilQSL" links to x.com/WilQSL (${xHref})`,
  );
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });

  // Security sub-screen: require-password default, auto-lock select, reveals.
  await byId('live-settings-row-security').click({ timeout: 10_000 });
  await byId('live-set-require-pw').waitFor({ timeout: 10_000 });
  const reqPwChecked = await byId('live-set-require-pw').getAttribute('aria-checked');
  check(reqPwChecked === 'true', `settings: require-password defaults on (aria-checked=${reqPwChecked})`);

  // Auto-lock (new in 1.7.0): the select exists and defaults to 5 minutes.
  check((await byId('live-autolock-select').count()) === 1, 'settings: auto-lock select present');
  const autoLockVal = await byId('live-autolock-select').inputValue();
  check(autoLockVal === '5', `settings: auto-lock defaults to 5 minutes (value=${autoLockVal})`);

  // Seed wallet: BOTH reveal options are offered (recovery phrase + private key).
  check(
    (await byId('live-reveal-seed').count()) === 1 && (await byId('live-reveal-key').count()) === 1,
    'reveal (seed wallet): both recovery-phrase and private-key options shown',
  );

  // Reveal recovery phrase: the correct wallet password reveals the imported
  // vector's 12-word phrase.
  await byId('live-reveal-seed').click({ timeout: 10_000 });
  await byId('live-reveal-password').waitFor({ timeout: 10_000 });
  await byId('live-reveal-password').fill('live-pass-1234');
  await byId('live-reveal-submit').click();
  await byId('live-reveal-output').waitFor({ timeout: 10_000 });
  const seedText = (await byId('live-reveal-output').innerText()).trim();
  const seedWords = seedText.split(/\s+/).filter(Boolean);
  check(seedWords.length === 12 && /\babout\b/.test(seedText), `reveal: recovery phrase shows 12 words -> "${seedWords.slice(0, 2).join(' ')} … ${seedWords[11]}"`);
  await byId('live-reveal-hide').click({ timeout: 10_000 });

  // Reveal private key with a WRONG password must surface an inline error.
  await byId('live-reveal-key').click({ timeout: 10_000 });
  await byId('live-reveal-password').waitFor({ timeout: 10_000 });
  await byId('live-reveal-password').fill('definitely-wrong-pw');
  await byId('live-reveal-submit').click();
  await byId('live-reveal-error').waitFor({ timeout: 10_000 });
  check((await byId('live-reveal-error').count()) === 1, 'reveal: wrong password shows live-reveal-error');
  await page.locator('[data-testid="live-reveal-modal"]').getByRole('button', { name: /^Cancel$/i }).click({ timeout: 10_000 });
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });

  // Transactions sub-screen: export CSV exists and clicking it (empty vector
  // seed -> header-only export) must not raise a page error. We can't observe
  // the file download from Playwright, only that the control works.
  await byId('live-settings-row-transactions').click({ timeout: 10_000 });
  await byId('live-export-csv').waitFor({ timeout: 10_000 });
  check((await byId('live-export-csv').count()) === 1, 'settings: export-CSV button present');
  let exportError = null;
  const onExportError = (e) => { exportError = e; };
  page.on('pageerror', onExportError);
  await byId('live-export-csv').click({ timeout: 10_000 });
  await page.waitForTimeout(500);
  page.off('pageerror', onExportError);
  check(
    exportError === null,
    `settings: clicking export-CSV raises no page error${exportError ? ` -> ${String(exportError).split('\n')[0]}` : ''}`,
  );

  await backToHome();

  // EVR send review must carry the password field when require-password is on.
  // The vector seed is EMPTY, so a real EVR build stops at coin selection
  // (insufficient funds) and the review isn't reached; if it ever is (funded),
  // the password field must be present.
  await byId('live-send').click({ timeout: 10_000 });
  await byId('live-send-to').fill(RECIPIENT);
  await byId('live-send-amount').fill('1');
  await page.getByRole('button', { name: /Review transaction/i }).click({ timeout: 10_000 });
  const reviewShown = await byId('live-send-review').isVisible().catch(() => false);
  if (reviewShown) {
    check(
      (await byId('live-send-password').count()) === 1,
      'EVR review shows the password field (require-password on)',
    );
  } else {
    const evrErr = (await byId('live-send-error').innerText().catch(() => '')) || '';
    check(/insufficient|fund/i.test(evrErr), `EVR send (empty seed) gated at coin selection -> "${evrErr.trim()}"`);
  }
  await backToHome();

  // Asset send path: re-add SATORIEVR, open its detail, Send, and submit an
  // amount. The empty seed holds no SATORIEVR, so the real asset-send path
  // (buildAssetSend) must report insufficient-asset — proving it is wired.
  await byId('live-add-asset').click({ timeout: 10_000 });
  await byId('live-add-asset-input').waitFor({ timeout: 10_000 });
  await byId('live-add-asset-input').fill('SATORIEVR');
  await byId('live-add-asset-submit').click();
  await page.locator('[data-testid="live-balance-SATORIEVR"]').waitFor({ timeout: 25_000 });
  await byId('live-asset-row-SATORIEVR').click({ timeout: 10_000 });
  await byId('live-asset-detail').waitFor({ timeout: 10_000 });

  // Satori pool staking (SATORIEVR only): the asset detail must offer a third
  // "Stake" action; opening it reaches the staking screen, which must resolve to
  // a loaded pool list OR a clean empty/error state (network-tolerant — the
  // central server may be slow/unreachable headless). We do NOT join/leave here
  // (that would mutate real server state for a test wallet).
  check((await byId('live-stake-button').count()) === 1, 'SATORIEVR detail offers a Stake action');
  await byId('live-stake-button').click({ timeout: 10_000 });
  await byId('live-staking').waitFor({ timeout: 10_000 });
  check(true, 'Stake -> staking screen opens');
  // Poll ~20s for the screen to settle into pools, an empty state, or an error
  // banner — any of these is a valid, non-hung outcome.
  let stakingSettled = false;
  for (let i = 0; i < 40; i++) {
    const hasPools = (await page.locator('[data-testid^="staking-pool-row-"]').count()) > 0;
    const hasStatus = (await byId('staking-status').count()) > 0;
    const hasError = (await byId('staking-error').count()) > 0;
    const stakingText = (await byId('live-staking').innerText().catch(() => '')) || '';
    const hasEmpty = /No SATORIEVR to stake|No open pools/i.test(stakingText);
    if (hasPools || hasStatus || hasError || hasEmpty) { stakingSettled = true; break; }
    await page.waitForTimeout(500);
  }
  check(stakingSettled, 'staking screen reaches a loaded pool list or a clean empty/error state');
  await page.screenshot({ path: path.join(shotsDir, '29-live-staking.png') });
  // Back to the SATORIEVR detail to continue with the asset-send path.
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-asset-detail').waitFor({ timeout: 10_000 });

  await byId('live-asset-detail-send').click({ timeout: 10_000 });
  await byId('live-send-to').waitFor({ timeout: 10_000 });
  await byId('live-send-to').fill(RECIPIENT);
  await byId('live-send-amount').fill('1');
  // EVR-gas guard (new): every asset transfer pays its network fee exclusively
  // from EVR UTXOs, and this test wallet holds 0 EVR. The UI now blocks the send
  // BEFORE build/broadcast instead of letting it reach coin selection, so assert
  // the no-evr-gas-banner is shown and the submit button is disabled — the
  // build-time 'insufficient-evr-for-fee' path itself stays covered by
  // liveWallet.test.ts (unit tests), which is the actual chain-side logic.
  await byId('no-evr-gas-banner').waitFor({ timeout: 10_000 });
  check((await byId('no-evr-gas-banner').count()) === 1, 'asset send (0 EVR): no-evr-gas-banner is shown');
  const reviewBtn = page.getByRole('button', { name: /Review transaction/i });
  check(await reviewBtn.isDisabled(), 'asset send (0 EVR): submit/review button is disabled');
  await page.screenshot({ path: path.join(shotsDir, '24-live-asset-send.png') });

  // Multi-wallet: from the header switcher, add a SECOND wallet (create), verify
  // the switcher then lists two wallets with the new one active, then switch back
  // to the first wallet (unlock with its own password) and confirm its address
  // returns — proving each wallet keeps its own seed + password.
  await backToHome();
  await byId('live-wallet-switcher').click({ timeout: 10_000 });
  await byId('live-wallet-item-0').waitFor({ timeout: 10_000 });
  check((await page.locator('[data-testid^="live-wallet-item-"]').count()) === 1, 'switcher lists one wallet before adding');
  await byId('live-add-wallet').click({ timeout: 10_000 });
  await byId('live-onboarding').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: /Create new wallet/i }).click({ timeout: 10_000 });
  await byId('live-wallet-name').waitFor({ timeout: 10_000 });
  await byId('live-wallet-name').fill('Second Wallet');
  await byId('live-password').fill('wallet2-pass');
  await byId('live-password-confirm').fill('wallet2-pass');
  await byId('live-create-submit').click();
  // New wallet shows its recovery phrase once — acknowledge and continue.
  await byId('live-mnemonic-saved').click({ timeout: 15_000 });
  await page.getByRole('button', { name: /Continue to wallet/i }).click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 20_000 });
  const newName = (await byId('live-wallet-switcher').innerText()).trim();
  check(/second wallet/i.test(newName), `multi-wallet: created 2nd wallet, active switcher shows -> "${newName}"`);

  await byId('live-wallet-switcher').click({ timeout: 10_000 });
  await byId('live-wallet-item-1').waitFor({ timeout: 10_000 });
  check((await page.locator('[data-testid^="live-wallet-item-"]').count()) === 2, 'switcher lists two wallets after adding');

  // 1.9.0: every NON-active switcher row carries a delete affordance; the
  // active wallet (index 1, just created) has none.
  check((await byId('live-wallet-delete-0').count()) === 1, 'switcher: non-active wallet shows a delete affordance');
  check((await byId('live-wallet-delete-1').count()) === 0, 'switcher: active wallet has no delete affordance');

  // Switch back to the first wallet — a full-frame "Switching wallet…" screen
  // (live-syncing) may show while the target spins up, then it lands LOCKED
  // (needs its own password). The switch can be near-instant, so accept EITHER
  // catching the transient syncing screen OR landing directly on the target.
  await byId('live-wallet-item-0').click({ timeout: 10_000 });
  const switchLanded = await Promise.race([
    byId('live-syncing').waitFor({ timeout: 15_000 }).then(() => 'syncing'),
    byId('live-lock').waitFor({ timeout: 15_000 }).then(() => 'lock'),
  ]).catch(() => 'none');
  check(switchLanded !== 'none', `switching shows the loading screen or lands on the target (${switchLanded})`);
  await byId('live-lock').waitFor({ timeout: 15_000 });
  await byId('live-unlock').fill('live-pass-1234');
  await page.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 20_000 });
  const backAddr = (await byId('live-address').innerText()).trim();
  check(backAddr === addr, `multi-wallet: switched back to first wallet, address restored (${backAddr})`);
  await page.screenshot({ path: path.join(shotsDir, '25-live-multiwallet.png') });

  // Lock-screen wallet picker: lock via the header "more" menu, then the lock
  // screen lists ALL wallets with the LAST-USED (first) one preselected. Picking
  // the other wallet re-targets the password field (it stays locked); picking
  // back restores the first, whose own password unlocks it.
  // The header lock button locks directly now (no "⋮" menu — Settings/Activity
  // are in the bottom nav).
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-lock').waitFor({ timeout: 10_000 });
  await byId('live-lock-wallets').waitFor({ timeout: 10_000 });
  const lockEntries = await page.locator('[data-testid^="live-lock-wallet-"]').count();
  check(lockEntries >= 1, `lock screen lists wallets (${lockEntries} entries)`);
  const lockSel0 = await byId('live-lock-wallet-0').getAttribute('aria-pressed');
  check(lockSel0 === 'true', `lock: last-used wallet preselected (aria-pressed=${lockSel0})`);
  // Pick the OTHER wallet — a brief "Switching wallet…" screen may pass by, so
  // poll until the picker re-renders with the new selection.
  await byId('live-lock-wallet-1').click({ timeout: 10_000 });
  let lockSel1 = '';
  for (let i = 0; i < 20; i++) {
    lockSel1 = (await byId('live-lock-wallet-1').getAttribute('aria-pressed').catch(() => '')) || '';
    if (lockSel1 === 'true') break;
    await page.waitForTimeout(500);
  }
  check(lockSel1 === 'true', `lock: picking another wallet re-targets it (aria-pressed=${lockSel1})`);
  // ...and back to the first wallet.
  await byId('live-lock-wallet-0').click({ timeout: 10_000 });
  let lockSelBack = '';
  for (let i = 0; i < 20; i++) {
    lockSelBack = (await byId('live-lock-wallet-0').getAttribute('aria-pressed').catch(() => '')) || '';
    if (lockSelBack === 'true') break;
    await page.waitForTimeout(500);
  }
  check(lockSelBack === 'true', `lock: picking back restores the first wallet (aria-pressed=${lockSelBack})`);
  await page.screenshot({ path: path.join(shotsDir, '28-live-lock-picker.png') });
  // Unlock the re-selected first wallet with ITS password.
  await byId('live-unlock').fill('live-pass-1234');
  await page.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 20_000 });
  const unlockedAddr = (await byId('live-address').innerText()).trim();
  check(unlockedAddr === addr, `lock: unlock after picking returns the first wallet (${unlockedAddr})`);

  // Address book: save a contact from Settings, then pick it in Send. The active
  // (seed) wallet is fine for this — no new wallet is created.
  await byId('live-settings-btn').click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await byId('live-address-book-btn').click({ timeout: 10_000 });
  await byId('live-address-book').waitFor({ timeout: 10_000 });
  await byId('live-contact-label').fill('My Exchange');
  await byId('live-contact-address').fill(RECIPIENT);
  await byId('live-contact-save').click();
  const contactId = `live-contact-${RECIPIENT.slice(0, 8)}`;
  await byId(contactId).waitFor({ timeout: 10_000 });
  check((await byId(contactId).count()) === 1, 'address book: saved contact appears in the list');
  // Edit the contact's label in place -> the new name shows, address unchanged.
  const short = RECIPIENT.slice(0, 8);
  await byId(`live-contact-edit-${short}`).click({ timeout: 10_000 });
  await byId(`live-contact-edit-input-${short}`).fill('Renamed Exchange');
  await byId(`live-contact-edit-save-${short}`).click({ timeout: 10_000 });
  await byId(contactId).waitFor({ timeout: 10_000 });
  const renamedText = (await byId(contactId).innerText()).trim();
  check(
    /Renamed Exchange/.test(renamedText) && renamedText.includes(RECIPIENT),
    `address book: label edited in place (name updated, address kept) -> "${renamedText.split('\n')[0]}"`,
  );
  // Back to Settings, then Home.
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 10_000 });
  // In Send, pick the saved contact from the address-book dropdown -> recipient fills.
  await byId('live-send').click({ timeout: 10_000 });
  await byId('live-send-to').waitFor({ timeout: 10_000 });
  await byId('live-send-contacts').selectOption(RECIPIENT);
  const filledTo = await byId('live-send-to').inputValue();
  check(filledTo === RECIPIENT, `address book: picking a contact fills the recipient (${filledTo})`);
  await backToHome();

  // Import private key: add a Satori single-address wallet from a known WIF.
  await byId('live-wallet-switcher').click({ timeout: 10_000 });
  await byId('live-add-wallet').click({ timeout: 10_000 });
  await byId('live-onboarding').waitFor({ timeout: 10_000 });
  await byId('live-choose-pk').click({ timeout: 10_000 });
  await byId('live-pk-input').waitFor({ timeout: 10_000 });
  await byId('live-pk-input').fill(PK_WIF);
  await byId('live-wallet-name').fill('Key Wallet');
  await byId('live-password').fill('pk-pass-1234');
  await byId('live-password-confirm').fill('pk-pass-1234');
  await byId('live-pk-submit').click();
  await byId('live-home').waitFor({ timeout: 20_000 });
  const pkAddr = (await byId('live-address').innerText()).trim();
  check(pkAddr.startsWith('EMc6'), `pk import: Satori wallet shows the WIF's derived address (${pkAddr})`);

  // A pk (Satori) wallet is single-address by construction: its Receive screen
  // must offer NO "New address" button and NO address picker.
  await byId('live-receive').click({ timeout: 10_000 });
  await byId('live-receive-qr').waitFor({ timeout: 10_000 });
  check((await byId('live-receive-new-address').count()) === 0, 'pk wallet: Receive shows no New-address button');
  check((await byId('live-receive-address-picker').count()) === 0, 'pk wallet: Receive shows no address picker');
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 10_000 });

  // The Satori/key badge shows in the switcher for the pk wallet ("Key Wallet"
  // has no "Satori" in its name, so a /satori/ match proves the badge).
  await byId('live-wallet-switcher').click({ timeout: 10_000 });
  await byId('live-wallet-item-0').waitFor({ timeout: 10_000 });
  const switcherText = await page.locator('.menu-pop').innerText();
  check(/satori/i.test(switcherText), 'pk import: switcher shows a Satori/key badge for the pk wallet');

  // Passwordless: create a wallet with the "no password" checkbox (menu is open).
  await byId('live-add-wallet').click({ timeout: 10_000 });
  await byId('live-onboarding').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: /Create new wallet/i }).click({ timeout: 10_000 });
  await byId('live-wallet-name').waitFor({ timeout: 10_000 });
  await byId('live-wallet-name').fill('No Password Wallet');
  await byId('live-no-password').check();
  check((await byId('live-password').count()) === 0, 'passwordless: password fields hidden when "no password" is checked');
  await byId('live-create-submit').click();
  // Submitting without the required risk acknowledgement must be blocked.
  check(
    (await byId('live-mnemonic').count()) === 0,
    'passwordless: create is blocked until the risk acknowledgement is checked',
  );
  await byId('passwordless-ack').click({ timeout: 10_000 });
  await byId('live-create-submit').click();
  // A passwordless seed wallet still shows its recovery phrase once — acknowledge.
  await byId('live-mnemonic-saved').click({ timeout: 15_000 });
  await page.getByRole('button', { name: /Continue to wallet/i }).click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 20_000 });
  check((await byId('live-lock').count()) === 0, 'passwordless: lands on the live home with NO lock screen');

  // A passwordless wallet's Send shows NO password field.
  await byId('live-send').click({ timeout: 10_000 });
  await byId('live-send-to').waitFor({ timeout: 10_000 });

  // My-wallets quick-pick (1.9.0): chips named after your OTHER wallets sit
  // under the recipient field; tapping one fills the address and confirms
  // "→ <name>" next to the field.
  await byId('live-send-wallet-0').waitFor({ timeout: 10_000 });
  const chipName = (await byId('live-send-wallet-0').innerText()).trim();
  await byId('live-send-wallet-0').click();
  const pickedTo = (await byId('live-send-to').inputValue()).trim();
  check(/^E[a-zA-Z0-9]{20,40}$/.test(pickedTo), `my-wallets chip fills the recipient (${pickedTo})`);
  const pickedLabel = (await byId('live-send-wallet-selected').innerText().catch(() => '')).trim();
  check(
    chipName.length > 0 && pickedLabel.includes(chipName),
    `my-wallets pick confirms by name -> "${pickedLabel}" (chip "${chipName}")`,
  );

  await byId('live-send-to').fill(RECIPIENT);
  await byId('live-send-amount').fill('1');
  await page.getByRole('button', { name: /Review transaction/i }).click({ timeout: 10_000 });
  const pwlReview = await byId('live-send-review').isVisible().catch(() => false);
  if (pwlReview) {
    check((await byId('live-send-password').count()) === 0, 'passwordless: send review has NO password field');
  } else {
    const pwlErr = (await byId('live-send-error').innerText().catch(() => '')) || '';
    check(/insufficient|fund/i.test(pwlErr), `passwordless: send gated at coin selection, no password step -> "${pwlErr.trim()}"`);
  }
  await page.screenshot({ path: path.join(shotsDir, '26-live-passwordless.png') });

  // Reopen persistence: reload the popup and confirm the wallet is still there
  // (locked or home) — i.e. the real wallet is the app, no demo fallback.
  await backToHome();
  await page.reload();
  const stillLive = await Promise.race([
    byId('live-home').waitFor({ timeout: 20_000 }).then(() => 'home').catch(() => ''),
    byId('live-lock').waitFor({ timeout: 20_000 }).then(() => 'lock').catch(() => ''),
  ]);
  check(stillLive === 'home' || stillLive === 'lock', `reopen lands back in the live wallet (${stillLive || 'neither'})`);

  // --- "Open in a separate window" -----------------------------------------
  // A toolbar popup cannot be dragged: Chrome pins it to the icon and exposes no API
  // to move it. Detaching into a real browser window is the only way to get a wallet
  // the user can drag, so prove the button (a) opens that window and (b) DISMISSES
  // the popup, instead of leaving two wallets on screen.
  // Runs here because the active wallet is the passwordless one, so we are reliably
  // on the home screen, where the button lives.
  if (stillLive === 'home') {
    const popupClosed = new Promise((r) => page.once('close', () => r(true)));
    const [detachedPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }).catch(() => null),
      byId('live-detach-btn').click(),
    ]);

    check(!!detachedPage, 'detach button opens a NEW browser window');
    check(
      await Promise.race([popupClosed, new Promise((r) => setTimeout(() => r(false), 8_000))]),
      'detach button CLOSES the popup (one wallet on screen, not two)',
    );

    if (detachedPage) {
      await detachedPage.waitForLoadState('domcontentloaded');
      check(detachedPage.url().includes('detached=1'), 'detached window loads the wallet');
      await detachedPage
        .locator('[data-testid="live-home"], [data-testid="live-lock"]')
        .first()
        .waitFor({ timeout: 20_000 });
      check(
        (await detachedPage.locator('[data-testid="live-detach-btn"]').count()) === 0,
        'detached window hides its own detach button',
      );
      await detachedPage.close();
    }

    // Reopen the popup so the remaining checks have a page to run against.
    page = await context.newPage();
    await page.goto(`chrome-extension://${id}/index.html`);
    await Promise.race([
      byId('live-home').waitFor({ timeout: 20_000 }).catch(() => {}),
      byId('live-lock').waitFor({ timeout: 20_000 }).catch(() => {}),
    ]);
  }

  // The lock screen offers "Create new wallet" so a user can make a fresh wallet
  // without logging in.
  if (stillLive === 'home') {
    await byId('live-lock-btn').click({ timeout: 10_000 });
  }
  await byId('live-lock').waitFor({ timeout: 15_000 });
  check((await byId('live-lock-create').count()) === 1, 'lock screen offers "Create new wallet"');
  await page.screenshot({ path: path.join(shotsDir, '27-live-lock-create.png') });

  // --- background: incoming-funds notifications wiring ------------------------
  // The deposit-poll alarm must be REGISTERED and the "notifications" permission
  // must be EFFECTIVE in the built extension. (The pure balance-diff detection is
  // covered by src/background/deposits.test.ts.)
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const alarm = await sw.evaluate(
    () =>
      new Promise((res) => {
        try {
          chrome.alarms.get('evr-deposit-check', (a) => res(a || null));
        } catch {
          res(null);
        }
      }),
  );
  check(
    !!alarm && alarm.name === 'evr-deposit-check',
    `deposit-poll alarm registered in the worker -> ${alarm ? alarm.periodInMinutes + 'min' : 'missing'}`,
  );
  const notifOk = await sw.evaluate(async () => {
    try {
      const id = await new Promise((res) =>
        chrome.notifications.create(
          'evr-smoke-notif',
          { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: 't', message: 't' },
          (nid) => res(nid),
        ),
      );
      const all = await new Promise((res) => chrome.notifications.getAll((m) => res(m || {})));
      chrome.notifications.clear('evr-smoke-notif');
      return Boolean(id) && Object.prototype.hasOwnProperty.call(all, id);
    } catch {
      return false;
    }
  });
  check(notifOk, 'notifications permission effective: create + getAll round-trips in the worker');
} catch (e) {
  // Print enough of the error to locate it. A one-line "TimeoutError: click" tells
  // you nothing about WHICH click.
  console.log('FAIL  exception:', String(e).split('\n').slice(0, 12).join('\n    '));
  if (e && e.stack) console.log('    at:', e.stack.split('\n').slice(1, 4).join('\n        '));
  failures++;
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nLIVE SMOKE: all checks passed' : `\nLIVE SMOKE: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
