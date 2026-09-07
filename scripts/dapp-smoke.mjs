// dApp-connect smoke test (2.0.1): serves a tiny web page on 127.0.0.1:8899,
// loads the BUILT extension into Playwright Chromium, sets up the live wallet
// (vector mnemonic), and proves the full window.evrmore flow end-to-end:
//   1. inpage provider is injected into a normal http page,
//   2. connect -> EXPLICIT approval window -> the page learns the address,
//   3. getBalances -> watch-only Electrum read through the background worker,
//   3b. signMessage -> approval window with password -> the returned Evrmore
//      signature RECOVERS to the wallet address (an independent verifier here),
//   4. sendEvr -> approval window with password -> unlock+build runs for real
//      (unfunded seed => insufficient-funds shown INSIDE the wallet window),
//      then Reject -> the page receives user-rejected,
//   5. sendEvr -> approval window -> Reject -> the page receives user-rejected,
//   6. WALLET-SWITCH (M2 fix): an approval is bound to ONE wallet. Create + switch
//      to a SECOND wallet; getAddress() then rejects not-connected and a fresh
//      connect() opens a NEW approval window (re-consent). Switch back to Wallet 1
//      and getAddress() works again with NO new approval,
//   7. Settings -> Connected sites lists BOTH per-wallet bindings by name;
//      Disconnect revokes them and a subsequent getAddress() rejects not-connected.
// No funds move; keys never leave the extension windows.
import { chromium } from 'playwright';
import http from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { concatBytes } from '@noble/hashes/utils';
import { hmac } from '@noble/hashes/hmac';
import { base64, base58check } from '@scure/base';
import * as secp from '@noble/secp256k1';

// Independent Evrmore signed-message VERIFIER (mirrors src/services/chain/message.ts
// but re-implemented here, so the smoke cross-checks the extension's signature
// against a second implementation). Recovers the signer's P2PKH address (EVR
// pubKeyHash = 33) from a base64 recoverable signature.
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const b58c = base58check(sha256);
const MSG_MAGIC = 'Evrmore Signed Message:\n';
const te = new TextEncoder();
const compactSize = (n) =>
  n < 0xfd
    ? Uint8Array.of(n)
    : n <= 0xffff
      ? Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff)
      : Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
const varstr = (b) => concatBytes(compactSize(b.length), b);
const msgHash = (m) => sha256(sha256(concatBytes(varstr(te.encode(MSG_MAGIC)), varstr(te.encode(m)))));
function recoverEvrAddress(message, sigB64) {
  const bytes = base64.decode(sigB64.trim());
  if (bytes.length !== 65) return '';
  const header = bytes[0];
  const recId = (header - 27) & 3;
  const compressed = ((header - 27) & 4) !== 0;
  const pub = secp.Signature.fromCompact(bytes.slice(1))
    .addRecoveryBit(recId)
    .recoverPublicKey(msgHash(message))
    .toRawBytes(compressed);
  return b58c.encode(concatBytes(Uint8Array.of(33), ripemd160(sha256(pub))));
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The dApp provider ships in every build, so this smoke runs against whichever
// package exists: the loaded EVM dist/chrome first, else the store build at
// dist/store/chrome (the two split on 2026-08-25, see scripts/build.mjs).
const distDir = existsSync(path.join(root, 'dist', 'chrome', 'manifest.json'))
  ? path.join(root, 'dist', 'chrome')
  : path.join(root, 'dist', 'store', 'chrome');
const userDataDir = path.join(os.tmpdir(), `evrdemo-dapp-${Date.now()}`);

const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'dapp-pass-1234';
const RECIPIENT = 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF';
const SIGN_MSG = 'Satori login challenge 42';
const PORT = 8899;
const SITE = `http://127.0.0.1:${PORT}`;

// --- tiny dApp test page -----------------------------------------------------
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>evr dapp test</title></head>
<body>
  <h1>Satori GO dApp test page</h1>
  <button id="connect">connect</button>
  <button id="balances">balances</button>
  <button id="sign">sign</button>
  <button id="send">send</button>
  <pre id="out"></pre>
  <script>
    const out = (v) => { document.getElementById('out').textContent = JSON.stringify(v); };
    const run = (fn) => fn().then(out).catch((e) => out({ error: String(e && e.message || e) }));
    document.getElementById('connect').onclick = () => run(() => window.evrmore.connect());
    document.getElementById('balances').onclick = () => run(() => window.evrmore.getBalances());
    document.getElementById('sign').onclick = () => run(() => window.evrmore.signMessage('${SIGN_MSG}'));
    document.getElementById('send').onclick = () =>
      run(async () => ({ txid: await window.evrmore.sendEvr('${RECIPIENT}', 1) }));
  </script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
const PORT2 = PORT + 1;
const SITE2 = `http://127.0.0.1:${PORT2}`;
const server2 = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});
await new Promise((resolve) => server2.listen(PORT2, '127.0.0.1', resolve));

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 400, height: 620 },
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
});

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

async function extId() {
  const w = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  // The worker's own errors are otherwise invisible to this script.
  w.on('console', (m) => { if (/error|warn/i.test(m.type())) console.log('  [worker]', m.text().slice(0, 240)); });
  return new URL(w.url()).host;
}

/**
 * WALLET CREATION: the recovery-phrase backup step (mirrors the helper in
 * live-extension-smoke.mjs). A created wallet shows its words, then asks three
 * of them back at random positions before it opens, so a smoke that creates a
 * wallet has to answer the quiz to get anywhere. Reads the phrase off the
 * screen while it is still visible, ticks "I saved it", continues, works out
 * which blanks are asked from the live-mnemonic-slot-<position> testids, taps
 * the matching chips and submits. The wrong-answer path is covered once, in
 * live-extension-smoke; here the point is only that creation still completes.
 */
async function answerMnemonicQuiz(pg, label = 'create') {
  const id = (t) => pg.getByTestId(t);
  await id('live-mnemonic').waitFor({ timeout: 30_000 });
  const words = new Map();
  for (const el of await pg.locator('[data-testid^="live-mnemonic-word-"]').all()) {
    const tid = (await el.getAttribute('data-testid')) || '';
    words.set(Number(tid.replace('live-mnemonic-word-', '')), (await el.innerText()).trim());
  }
  await id('live-mnemonic-saved').click({ timeout: 15_000 });
  await pg.getByRole('button', { name: /Continue to wallet/i }).click({ timeout: 10_000 });
  await id('live-mnemonic-verify').waitFor({ timeout: 20_000 });

  const positions = [];
  for (const el of await pg.locator('[data-testid^="live-mnemonic-slot-"]').all()) {
    const tid = (await el.getAttribute('data-testid')) || '';
    positions.push(Number(tid.replace('live-mnemonic-slot-', '')));
  }
  // Chips are re-read per word: a used one is disabled, which is what makes a
  // repeated word resolve to a second, still-available chip.
  for (const word of positions.map((p) => words.get(p))) {
    let picked = null;
    for (const el of await pg.locator('[data-testid^="live-mnemonic-choice-"]').all()) {
      if ((await el.innerText()).trim() === word && !(await el.isDisabled())) { picked = el; break; }
    }
    if (!picked) throw new Error(`mnemonic quiz: no chip left in the bank for "${word}"`);
    await picked.click({ timeout: 10_000 });
  }
  await id('live-mnemonic-verify-submit').click({ timeout: 10_000 });
  await id('live-mnemonic-verify').waitFor({ state: 'detached', timeout: 30_000 });
  check(positions.length === 3, `${label}: recovery-phrase quiz answered (#${positions.join(', #')})`);
}

/**
 * WHERE AN APPROVAL APPEARS. Since 1.4.1 the worker shows a site's request
 * INSIDE a wallet window that is already open (side panel, popup, tab) as an
 * overlay, and only opens the 400x620 popup when no wallet window is open.
 * `trigger` fires the request; this resolves with { kind, scope } where scope
 * is either the new approval page or the overlay locator inside the hosting
 * page (both answer getByTestId the same way). Times out if neither shows up.
 */
async function awaitApproval(trigger, { timeout = 20_000 } = {}) {
  const walletPages = context.pages().filter((p) => p.url().startsWith('chrome-extension://'));
  const never = new Promise(() => {});
  // An overlay for the PREVIOUS request can linger a few ms after it was
  // decided; only an overlay carrying a new request id counts.
  const seen = new Set();
  for (const page of walletPages) {
    if (page.isClosed()) continue;
    for (const el of await page.getByTestId('dapp-host-overlay').all()) seen.add(await el.getAttribute('data-request-id'));
  }
  const asWindow = context
    .waitForEvent('page', { timeout })
    .then((page) => ({ kind: 'window', scope: page, page }))
    .catch(() => never);
  await trigger();
  const asHosted = (async () => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      for (const page of walletPages) {
        if (page.isClosed()) continue;
        const overlay = page.getByTestId('dapp-host-overlay');
        if ((await overlay.count()) && !seen.has(await overlay.getAttribute('data-request-id'))) {
          return { kind: 'hosted', scope: overlay, page };
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return never;
  })();
  const bail = new Promise((_, reject) => setTimeout(() => reject(new Error('no approval appeared')), timeout + 1000));
  const found = await Promise.race([asWindow, asHosted, bail]);
  await found.scope.getByTestId('dapp-approval').waitFor({ timeout: 15_000 });
  return found;
}

/** Open a fresh wallet page and unlock it with `password` if the lock shows. */
async function openWalletPage(id, password) {
  const pg = await context.newPage();
  await pg.goto(`chrome-extension://${id}/index.html`);
  await pg.waitForSelector('[data-testid="live-unlock"], [data-testid="live-home"]', { timeout: 20_000 });
  if (await pg.getByTestId('live-unlock').count()) {
    await pg.getByTestId('live-unlock').fill(password);
    await pg.getByRole('button', { name: /^Unlock$/ }).click();
    await pg.getByTestId('live-home').waitFor({ timeout: 25_000 });
  }
  return pg;
}

/** Settings > Connected sites: read the rows, or disconnect every binding. */
async function openConnectedSites(pg) {
  await pg.getByTestId('live-settings-btn').click();
  // Connected sites is an EXPERT-mode section; Settings opens in basic.
  await pg.getByTestId('live-settings-mode-expert').click({ timeout: 10_000 });
  await pg.getByTestId('live-settings-row-sites').click();
  await pg.getByTestId('live-connected-sites').waitFor({ timeout: 10_000 });
}
async function disconnectAllSites(pg) {
  for (let i = 0; i < 8; i++) {
    if (await pg.getByTestId('live-sites-empty').count()) break;
    const btn = pg.getByTestId('live-site-disconnect-0');
    if (!(await btn.count())) break;
    await btn.click();
    await pg.waitForTimeout(400);
  }
  await pg.getByTestId('live-sites-empty').waitFor({ timeout: 10_000 });
}

/** Empty the page's #out so the NEXT result cannot be mistaken for the last one. */
const clearOut = (site) => site.evaluate(() => { document.querySelector('#out').textContent = ''; });

/** Does a shown address (possibly shortened to "EMc6LdHEHR…X2D9Ew") name `full`? */
function sameAddress(full, shown) {
  if (!full || !shown) return false;
  if (shown === full) return true;
  const parts = shown.split('…');
  return parts.length === 2 && full.startsWith(parts[0]) && full.endsWith(parts[1]);
}

/**
 * Does the approval fit WITHOUT scrolling at the popup's real inner size?
 * chrome.windows.create({height: 620}) is the OUTER height; on Windows the
 * title bar takes 30-40px, so the page gets about 580. Measured at 540 to
 * leave room for DPI scaling. The scroll container is .app-content.
 */
async function fitsWithoutScroll(found, label) {
  const page = found.page;
  const before = page.viewportSize();
  await page.setViewportSize({ width: 400, height: 540 });
  await page.waitForTimeout(150);
  const m = await found.scope.locator('.app-content').evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  if (before) await page.setViewportSize(before);
  check(
    m.scrollHeight <= m.clientHeight + 1,
    `${label} fits a 400x540 viewport without scrolling (content ${m.scrollHeight}px in ${m.clientHeight}px)`,
  );
}

/** The connect approval's wallet dropdown: option labels and the selected name. */
async function pickerState(scope) {
  return scope.getByTestId('dapp-wallet-select').evaluate((el) => ({
    labels: [...el.options].map((o) => o.text.split(' · ')[0].trim()),
    selected: el.selectedOptions[0] ? el.selectedOptions[0].text.split(' · ')[0].trim() : '(none)',
  }));
}
async function pickWallet(scope, re) {
  const value = await scope.getByTestId('dapp-wallet-select').evaluate((el, src) => {
    const rx = new RegExp(src, 'i');
    const o = [...el.options].find((x) => rx.test(x.text));
    return o ? o.value : '';
  }, re.source);
  if (!value) throw new Error(`no wallet matching ${re} in the dropdown`);
  await scope.getByTestId('dapp-wallet-select').selectOption(value);
}

/** Read the page's last #out once it matches `re` (or give up). */
async function outMatching(site, re, tries = 30) {
  let text = '';
  for (let i = 0; i < tries; i++) {
    text = (await site.locator('#out').innerText()).trim();
    if (re.test(text)) break;
    await site.waitForTimeout(500);
  }
  return text;
}

/** Side panel mode on/off, the way Settings stores it (the worker re-reads it
 *  on storage.onChanged). Playwright cannot see or drive Chrome's side panel,
 *  so every step that decides an approval runs in POPUP mode; the last step
 *  turns the panel on and checks, through the worker, that a site's click
 *  opens it and the request is hosted there. */
async function setSidePanelMode(on) {
  const sw = context.serviceWorkers()[0];
  await sw.evaluate((v) => chrome.storage.local.set({ 'ui:sidePanel': v }), on);
  await new Promise((r) => setTimeout(r, 200));
}

try {
  const id = await extId();
  check(true, `extension service worker alive (background.js built) — id ${id}`);
  await setSidePanelMode(false);

  // --- 1. Set up the live wallet in the extension popup ----------------------
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/index.html`);
  // The wallet is the whole app now (demo removed) — it boots straight into onboarding.
  await popup.getByTestId('live-onboarding').waitFor({ timeout: 15_000 });
  await popup.getByRole('button', { name: /Import recovery phrase/i }).click();
  await popup.getByTestId('live-import-input').waitFor({ timeout: 10_000 });
  await popup.getByTestId('live-import-input').fill(VECTOR_MNEMONIC);
  await popup.getByTestId('live-password').fill(PASSWORD);
  const confirm = popup.getByTestId('live-password-confirm');
  if (await confirm.count()) await confirm.fill(PASSWORD);
  await popup.getByTestId('live-import-submit').click();
  await popup.getByTestId('live-home').waitFor({ timeout: 25_000 });
  check(true, 'live wallet imported (vector mnemonic) -> live-home');

  // --- 2. Open the dApp page; the provider must be injected ------------------
  const site = await context.newPage();
  site.on('console', (m) => { const t = m.text(); if (/error|fail/i.test(t)) console.log('  [site]', t.slice(0, 160)); });
  await site.goto(SITE);
  let hasProvider = false;
  for (let i = 0; i < 20 && !hasProvider; i++) {
    hasProvider = await site.evaluate(() => Boolean(window.evrmore && window.evrmore.isEvrNexus));
    if (!hasProvider) await site.waitForTimeout(250);
  }
  check(hasProvider, 'window.evrmore provider injected into the http page');

  // --- 3. connect -> approval HOSTED in the open wallet page -> address -------
  // The wallet page from step 1 is still open, so the request must appear in
  // it (the user's window, not a popup on top of it).
  const wallet1Name = (await popup.getByTestId('live-wallet-switcher').innerText()).trim();
  const first = await awaitApproval(() => site.click('#connect'));
  check(first.kind === 'hosted', `approval appears INSIDE the open wallet window, no popup (${first.kind})`);
  const approval = first.scope;
  const shownOrigin = (await approval.getByTestId('dapp-origin').innerText()).trim();
  check(shownOrigin === SITE, `approval shows the requesting origin (${shownOrigin})`);
  check(
    (await approval.getByTestId('dapp-wallet-picker').count()) === 0,
    'a single Evrmore wallet: no picker, it is preselected',
  );
  await approval.getByTestId('dapp-approve').click({ timeout: 10_000 });
  let outText = await outMatching(site, /./);
  check(/"address"\s*:\s*"EMc6/.test(outText), `connect resolved with the wallet address on the page -> ${outText}`);
  await popup.getByTestId('dapp-host-overlay').waitFor({ state: 'detached', timeout: 10_000 });
  check(
    (await popup.getByTestId('live-home').count()) === 1,
    'after deciding, the overlay is gone and the wallet page is where it was',
  );
  // Wallet 1's address — used later to prove a wallet switch re-binds access.
  const wallet1Address = (() => {
    try { return JSON.parse(outText).address; } catch { return ''; }
  })();

  // --- 4. balances (watch-only read via the worker) ---------------------------
  await site.click('#balances');
  outText = '';
  for (let i = 0; i < 60; i++) {
    outText = (await site.locator('#out').innerText()).trim();
    if (outText && !/"address"/.test(outText)) break;
    await site.waitForTimeout(500);
  }
  check(/"EVR"/.test(outText), `getBalances returned the asset list incl. EVR -> ${outText.slice(0, 120)}`);

  // --- 4b. signMessage -> approval window -> page gets { address, signature }
  //         and the signature RECOVERS to the wallet address (Satori-valid) ------
  const signFound = await awaitApproval(() => site.click('#sign'));
  const signApproval = signFound.scope;
  await fitsWithoutScroll(signFound, 'sign approval (password + buttons in view)');
  const shownMsg = (await signApproval.getByTestId('dapp-sign-message').innerText()).trim();
  check(shownMsg === SIGN_MSG, `sign approval shows the exact message -> "${shownMsg}"`);
  check(
    (await signApproval.getByTestId('dapp-password').count()) === 0,
    'hosted in the UNLOCKED wallet: the signature asks for no password (the user unlocked it here already)',
  );
  await signApproval.getByTestId('dapp-approve').click({ timeout: 10_000 });
  outText = '';
  for (let i = 0; i < 30; i++) {
    outText = (await site.locator('#out').innerText()).trim();
    if (/"signature"/.test(outText)) break;
    await site.waitForTimeout(500);
  }
  let signed = {};
  try { signed = JSON.parse(outText); } catch { /* leave empty -> check fails */ }
  const recovered = signed.signature ? recoverEvrAddress(SIGN_MSG, signed.signature) : '';
  check(
    !!signed.signature && recovered === signed.address && /^EMc6/.test(String(signed.address)),
    `signMessage signature recovers to the wallet address -> ${recovered || outText.slice(0, 80)}`,
  );

  // --- 4c. WALLET LOCKED: a sign request does not put a password box over the
  //         lock screen. A strip says the site is waiting; unlocking the wallet
  //         brings the approval, which asks for no password (owner's flow:
  //         unlock once, sign, back in the wallet). ---------------------------
  await popup.getByTestId('live-lock-btn').click({ timeout: 10_000 });
  await popup.getByTestId('live-unlock').waitFor({ timeout: 15_000 });
  await clearOut(site);
  await site.click('#sign');
  await popup.getByTestId('dapp-unlock-wait').waitFor({ timeout: 15_000 });
  check(
    (await popup.getByTestId('dapp-approval').count()) === 0 && (await popup.getByTestId('live-unlock').count()) === 1,
    'locked wallet: the request waits behind the lock screen (strip shown, no approval, no second password box)',
  );
  await popup.getByTestId('live-unlock').fill(PASSWORD);
  await popup.getByRole('button', { name: /^Unlock$/ }).click();
  await popup.getByTestId('live-home').waitFor({ timeout: 25_000 });
  await popup.getByTestId('dapp-approval').waitFor({ timeout: 15_000 });
  check(
    (await popup.getByTestId('dapp-password').count()) === 0 && (await popup.getByTestId('dapp-unlock-wait').count()) === 0,
    'after unlocking, the sign approval appears without a password field',
  );
  await popup.getByTestId('dapp-approve').click({ timeout: 10_000 });
  outText = await outMatching(site, /"signature"/);
  let signedAfterUnlock = {};
  try { signedAfterUnlock = JSON.parse(outText); } catch { /* leave empty */ }
  check(
    !!signedAfterUnlock.signature && recoverEvrAddress(SIGN_MSG, signedAfterUnlock.signature) === signedAfterUnlock.address,
    `signed with the wallet unlocked in the page -> ${signedAfterUnlock.address || outText.slice(0, 60)}`,
  );
  await popup.getByTestId('dapp-host-overlay').waitFor({ state: 'detached', timeout: 10_000 });
  check((await popup.getByTestId('live-home').count()) === 1, 'and the wallet is back, still unlocked');

  // --- 5. sendEvr -> approval window -> unlock+build proves insufficient funds,
  //        then Reject -> the page gets user-rejected --------------------------
  const sendApproval = (await awaitApproval(() => site.click('#send'))).scope;
  check(
    (await sendApproval.getByTestId('dapp-send-to').innerText()).includes(RECIPIENT),
    'send approval shows the recipient',
  );
  if (await sendApproval.getByTestId('dapp-password').count()) await sendApproval.getByTestId('dapp-password').fill(PASSWORD);
  await sendApproval.getByTestId('dapp-approve').click({ timeout: 10_000 });
  await sendApproval.getByTestId('dapp-error').waitFor({ timeout: 30_000 });
  const errText = (await sendApproval.getByTestId('dapp-error').innerText()).trim();
  check(/insufficient|fund/i.test(errText), `unlock+build ran for real (unfunded) -> "${errText}"`);
  await sendApproval.getByTestId('dapp-reject').click({ timeout: 10_000 });
  outText = '';
  for (let i = 0; i < 30; i++) {
    outText = (await site.locator('#out').innerText()).trim();
    if (/user-rejected/.test(outText)) break;
    await site.waitForTimeout(500);
  }
  check(/user-rejected/.test(outText), `page received user-rejected after Reject -> ${outText}`);

  // --- 5b. WALLET CLOSED MID-REQUEST: a sign request is shown in the open
  //         wallet page; the page is closed without deciding. The site must get
  //         user-rejected, and the NEXT sign request must open a fresh approval
  //         (it used to be refused with approval-already-open, which the site
  //         shows as "Could not reach the wallet"). ------------------------------
  await clearOut(site);
  const midway = await awaitApproval(() => site.click('#sign'));
  check(midway.kind === 'hosted', `sign request shown in the open wallet page (${midway.kind})`);
  await midway.page.close();
  outText = await outMatching(site, /user-rejected/, 20);
  check(/user-rejected/.test(outText), `closing the wallet mid-request rejected it to the site -> ${outText}`);
  await clearOut(site);
  let afterClose;
  try {
    afterClose = await awaitApproval(() => site.click('#sign'));
  } catch (e) {
    console.log('  [debug] second sign: #out =', JSON.stringify(await site.locator('#out').innerText()), 'pages =', context.pages().map((p) => p.url()).join(' | '));
    throw e;
  }
  check(afterClose.kind === 'window', `the next sign request opens a fresh approval (${afterClose.kind}), not approval-already-open`);
  await afterClose.scope.getByTestId('dapp-reject').click({ timeout: 10_000 });
  outText = await outMatching(site, /user-rejected/);
  check(/user-rejected/.test(outText), 'and can be decided normally');

  // Page-side helper: resolve/reject window.evrmore.getAddress() to a plain object.
  const pageGetAddress = () =>
    site.evaluate(() =>
      window.evrmore.getAddress().then(
        (address) => ({ ok: true, address }),
        (e) => ({ ok: false, message: String((e && e.message) || e) }),
      ),
    );

  // --- 6. WALLET SWITCH: the connection is bound to the wallet the user PICKED
  // and it does not move when the wallet UI switches wallet. Create + switch to
  // a SECOND wallet in the extension UI, then prove from the page that:
  //   (a) getAddress() still answers with Wallet 1's address, and
  //   (b) connect() resolves at once with Wallet 1's address, NO new approval.
  // (Until 1.4.1 the binding followed the ACTIVE wallet, so a switch silently
  // disconnected the site and the next connect bound whatever was active.)
  const popupSw = await openWalletPage(id, PASSWORD);
  // Create a second wallet via the header switcher (mirrors live-extension-smoke).
  const WALLET2_PASS = 'wallet2-pass-9876';
  await popupSw.getByTestId('live-wallet-switcher').click({ timeout: 10_000 });
  await popupSw.getByTestId('live-add-wallet').click({ timeout: 10_000 });
  await popupSw.getByTestId('live-onboarding').waitFor({ timeout: 10_000 });
  await popupSw.getByRole('button', { name: /Create new wallet/i }).click({ timeout: 10_000 });
  await popupSw.getByTestId('live-wallet-name').waitFor({ timeout: 10_000 });
  await popupSw.getByTestId('live-wallet-name').fill('Second Wallet');
  await popupSw.getByTestId('live-password').fill(WALLET2_PASS);
  await popupSw.getByTestId('live-password-confirm').fill(WALLET2_PASS);
  await popupSw.getByTestId('live-create-submit').click();
  await answerMnemonicQuiz(popupSw, 'wallet 2');
  await popupSw.getByTestId('live-home').waitFor({ timeout: 20_000 });
  const activeName = (await popupSw.getByTestId('live-wallet-switcher').innerText()).trim();
  check(/second wallet/i.test(activeName), `created + switched to Wallet 2 (active switcher -> "${activeName}")`);
  const wallet2Shown = (await popupSw.getByTestId('live-address').innerText()).trim();

  // (a) getAddress() from the page still answers with Wallet 1: the binding stayed.
  let addrW2 = await pageGetAddress();
  for (let i = 0; i < 10 && !addrW2.ok; i++) { await site.waitForTimeout(300); addrW2 = await pageGetAddress(); }
  check(
    addrW2.ok === true && addrW2.address === wallet1Address,
    `after switching to Wallet 2, the site is STILL connected to Wallet 1 -> ${JSON.stringify(addrW2)}`,
  );

  // (b) connect() again, now that TWO Evrmore wallets exist: the approval
  // re-opens with the picker, the CONNECTED wallet (Wallet 1) preselected, and
  // picking Second Wallet re-binds the site to it. This is how a user switches
  // the wallet a site uses after a site-side "disconnect".
  await clearOut(site);
  const again = await awaitApproval(() => site.click('#connect'));
  check(again.kind === 'hosted', `re-connect on a connected site re-opens the approval in the open wallet (${again.kind})`);
  await fitsWithoutScroll(again, 'connect approval with the picker');
  const againState = await pickerState(again.scope);
  check(againState.selected === wallet1Name, `the CONNECTED wallet is preselected in the dropdown, not the active one (${againState.selected})`);
  await pickWallet(again.scope, /second wallet/);
  await again.scope.getByTestId('dapp-approve').click({ timeout: 10_000 });
  outText = await outMatching(site, /"address"/);
  let reAddr = '';
  try { reAddr = JSON.parse(outText).address; } catch { /* leave empty */ }
  check(
    !!reAddr && reAddr !== wallet1Address && sameAddress(reAddr, wallet2Shown),
    `picking Second Wallet re-binds the site to it (${reAddr}, shown in the wallet as ${wallet2Shown})`,
  );
  const wallet2Address = reAddr;

  // Switch back to Wallet 1 (unlock with its own password).
  await popupSw.getByTestId('live-wallet-switcher').click({ timeout: 10_000 });
  await popupSw.getByTestId('live-wallet-item-0').click({ timeout: 10_000 });
  await popupSw.getByTestId('live-lock').waitFor({ timeout: 15_000 });
  await popupSw.getByTestId('live-unlock').fill(PASSWORD);
  await popupSw.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  await popupSw.getByTestId('live-home').waitFor({ timeout: 25_000 });

  let addrBack = await pageGetAddress();
  for (let i = 0; i < 10 && !addrBack.ok; i++) { await site.waitForTimeout(300); addrBack = await pageGetAddress(); }
  check(
    addrBack.ok === true && addrBack.address === wallet2Address,
    `back on Wallet 1 in the UI, the site stays bound to Second Wallet -> ${JSON.stringify(addrBack)}`,
  );

  // --- 7. Reopen the popup: Settings -> Connected sites lists ONE binding ------
  const popup2 = await openWalletPage(id, PASSWORD);
  await openConnectedSites(popup2);
  await popup2.getByTestId('live-site-0').waitFor({ timeout: 10_000 });
  // One origin, one wallet: the site is connected to Wallet 1 and nothing else.
  const siteRowCount = await popup2.locator('[data-testid^="live-site-"]:not([data-testid*="disconnect"]):not([data-testid*="wallet"])').count();
  const siteRow0 = (await popup2.getByTestId('live-site-0').innerText()).trim();
  const boundNames = (await popup2.locator('[data-testid^="live-site-wallet-"]').allInnerTexts()).join(' | ');
  check(
    siteRow0.includes(SITE) && siteRowCount === 1 && /second wallet/i.test(boundNames) && !boundNames.includes(wallet1Name),
    `Connected sites lists exactly one binding, to Second Wallet (${siteRowCount} row; wallet: ${boundNames})`,
  );

  // --- 8. Disconnect -> the list empties (empty state shows) ------------------
  await disconnectAllSites(popup2);
  check(
    (await popup2.getByTestId('live-site-0').count()) === 0,
    'Disconnect removed the binding (empty state shown)',
  );

  // --- 9. Back on the page (Wallet 1 active): getAddress must now REJECT -------
  const addrOutcome = await pageGetAddress();
  check(
    addrOutcome.ok === false && /not-connected/.test(addrOutcome.message),
    `getAddress rejected with not-connected after disconnect -> ${JSON.stringify(addrOutcome)}`,
  );

  // --- 10. WALLET CLOSED: the request opens the popup, and the PICKER offers
  //         both Evrmore wallets; the user picks Wallet 2 ------------------------
  // This is the case the old smoke never covered (it kept the wallet open), and
  // the one the owner hit: with no wallet window open, a popup is the only
  // window a page's message may cause. Two Evrmore wallets exist now, so the
  // approval must let the user choose, and bind the site to the chosen one.
  for (const pg of context.pages()) {
    if (pg.url().startsWith('chrome-extension://')) await pg.close();
  }
  await clearOut(site);
  const closedCase = await awaitApproval(() => site.click('#connect'));
  check(closedCase.kind === 'window', `with every wallet window closed, the approval opens as a popup (${closedCase.kind})`);
  const picker = closedCase.scope.getByTestId('dapp-wallet-picker');
  check((await picker.count()) === 1, 'two Evrmore wallets: the approval shows a wallet picker');
  await fitsWithoutScroll(closedCase, 'popup connect approval with the picker');
  const closedState = await pickerState(closedCase.scope);
  check(
    closedState.labels.length === 2 && closedState.labels.some((t) => /second wallet/i.test(t)) && !closedState.labels.some((t) => /bc1q/.test(t)),
    `dropdown lists both Evrmore wallets (${closedState.labels.join(' | ')})`,
  );
  await pickWallet(closedCase.scope, /second wallet/);
  const pickedName = (await closedCase.scope.getByTestId('dapp-wallet-name').innerText()).trim();
  check(/second wallet/i.test(pickedName), `picking Wallet 2 updates the summary (${pickedName})`);
  await closedCase.scope.getByTestId('dapp-approve').click({ timeout: 10_000 });
  outText = await outMatching(site, /"address"/);
  let pickedAddr = '';
  try { pickedAddr = JSON.parse(outText).address; } catch { /* leave empty */ }
  check(
    !!pickedAddr && pickedAddr === wallet2Address,
    `connect resolved with the PICKED wallet's address (${pickedAddr})`,
  );

  // --- 11. CHAIN GATE: Bitcoin active in the wallet UI ------------------------
  // Enable Bitcoin on Wallet 1 so the active entry is "… (Bitcoin)" with a bc1q
  // address, which is what the owner had open on 2026-09-04. The site must keep
  // Wallet 2's Evrmore address, and a fresh connect must offer Evrmore wallets
  // only, never the Bitcoin entry.
  const popupBtc = await openWalletPage(id, PASSWORD);
  await popupBtc.getByTestId('live-chain-switcher').click({ timeout: 10_000 });
  await popupBtc.getByTestId('live-chain-option-bitcoin-mainnet').click({ timeout: 10_000 });
  await popupBtc.getByTestId('live-chain-enable-panel').waitFor({ timeout: 10_000 });
  if (await popupBtc.getByTestId('live-chain-enable-password').count()) {
    await popupBtc.getByTestId('live-chain-enable-password').fill(PASSWORD);
  }
  await popupBtc.getByTestId('live-chain-enable-submit').click({ timeout: 10_000 });
  await popupBtc.getByTestId('live-chain-enable-panel').waitFor({ state: 'detached', timeout: 30_000 });
  let btcAddr = '';
  for (let i = 0; i < 40 && !/^bc1q/.test(btcAddr); i++) {
    btcAddr = (await popupBtc.getByTestId('live-address').innerText()).trim();
    if (!/^bc1q/.test(btcAddr)) await popupBtc.waitForTimeout(500);
  }
  check(/^bc1q/.test(btcAddr), `Bitcoin enabled and active in the wallet UI (${btcAddr.slice(0, 12)}…)`);

  const addrOnBtc = await pageGetAddress();
  check(
    addrOnBtc.ok === true && addrOnBtc.address === pickedAddr,
    `with Bitcoin active, the site still gets its Evrmore wallet, never bc1q -> ${JSON.stringify(addrOnBtc)}`,
  );

  await openConnectedSites(popupBtc);
  await disconnectAllSites(popupBtc);
  await clearOut(site);
  const gated = await awaitApproval(() => site.click('#connect'));
  const gatedState = await pickerState(gated.scope);
  const gatedText = await gated.scope.getByTestId('dapp-approval').innerText();
  check(
    gatedState.labels.length === 2 && !/bc1q|bitcoin/i.test(gatedText) && !gatedState.labels.some((t) => /bitcoin/i.test(t)),
    `a fresh connect while Bitcoin is active offers the two Evrmore wallets and no Bitcoin entry (${gatedState.labels.join(' | ')})`,
  );
  await gated.scope.getByTestId('dapp-approve').click({ timeout: 10_000 });
  outText = await outMatching(site, /"address"/);
  let gatedAddr = '';
  try { gatedAddr = JSON.parse(outText).address; } catch { /* leave empty */ }
  check(gatedAddr === wallet1Address, `the site receives the preselected Evrmore wallet's address, Wallet 1 (${gatedAddr})`);

  // --- 12. SIDE PANEL MODE (the default on Chrome): a site's click opens the
  //         wallet in the side panel and the approval is hosted THERE, with no
  //         popup. Verified through the worker: Playwright has no handle on the
  //         panel, so this request is left parked on a second origin. ---------
  for (const pg of context.pages()) {
    if (pg.url().startsWith('chrome-extension://')) await pg.close();
  }
  await setSidePanelMode(true);
  const site2 = await context.newPage();
  await site2.goto(SITE2);
  let provider2 = false;
  for (let i = 0; i < 20 && !provider2; i++) {
    provider2 = await site2.evaluate(() => Boolean(window.evrmore && window.evrmore.isEvrNexus));
    if (!provider2) await site2.waitForTimeout(250);
  }
  let popped = false;
  const onPage = () => { popped = true; };
  context.on('page', onPage);
  await site2.click('#connect');
  await site2.waitForTimeout(5500);
  context.off('page', onPage);
  const sw = context.serviceWorkers()[0];
  const panelCtx = await sw.evaluate(async () =>
    (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((c) => c.documentUrl ?? ''),
  );
  const parked2 = await sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.values(all).filter((p) => p && p.origin);
  });
  const mine = parked2.filter((p) => p.origin === SITE2);
  check(panelCtx.some((u) => /panel=1/.test(u)), `the click opened the side panel (${panelCtx.join(' | ') || 'no panel context'})`);
  check(
    !popped && mine.length === 1 && mine[0].popupWindowId === undefined,
    `the request is hosted in the panel: no popup window, one parked request without a popup id (${JSON.stringify(mine.map((p) => p.method))})`,
  );
  await setSidePanelMode(false);
} catch (e) {
  console.log('FAIL  exception:', String(e).split('\n')[0]);
  failures++;
} finally {
  await context.close();
  server.close();
  server2.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nDAPP SMOKE: all checks passed' : `\nDAPP SMOKE: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
