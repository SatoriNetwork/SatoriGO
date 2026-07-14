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
import { rmSync } from 'node:fs';
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
const distDir = path.join(root, 'dist', 'chrome-extension');
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
  return new URL(w.url()).host;
}

try {
  const id = await extId();
  check(true, `extension service worker alive (background.js built) — id ${id}`);

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

  // --- 3. connect -> approval window -> address on the page ------------------
  const approvalPromise = context.waitForEvent('page', { timeout: 20_000 });
  await site.click('#connect');
  const approval = await approvalPromise;
  await approval.getByTestId('dapp-approval').waitFor({ timeout: 15_000 });
  const shownOrigin = (await approval.getByTestId('dapp-origin').innerText()).trim();
  check(shownOrigin === SITE, `approval window shows the requesting origin (${shownOrigin})`);
  await approval.getByTestId('dapp-approve').click({ timeout: 10_000 });
  let outText = '';
  for (let i = 0; i < 30; i++) {
    outText = (await site.locator('#out').innerText()).trim();
    if (outText) break;
    await site.waitForTimeout(500);
  }
  check(/"address"\s*:\s*"EMc6/.test(outText), `connect resolved with the wallet address on the page -> ${outText}`);
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
  const signApprovalPromise = context.waitForEvent('page', { timeout: 20_000 });
  await site.click('#sign');
  const signApproval = await signApprovalPromise;
  await signApproval.getByTestId('dapp-approval').waitFor({ timeout: 15_000 });
  const shownMsg = (await signApproval.getByTestId('dapp-sign-message').innerText()).trim();
  check(shownMsg === SIGN_MSG, `sign approval shows the exact message -> "${shownMsg}"`);
  await signApproval.getByTestId('dapp-password').fill(PASSWORD);
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

  // --- 5. sendEvr -> approval window -> unlock+build proves insufficient funds,
  //        then Reject -> the page gets user-rejected --------------------------
  const sendApprovalPromise = context.waitForEvent('page', { timeout: 20_000 });
  await site.click('#send');
  const sendApproval = await sendApprovalPromise;
  await sendApproval.getByTestId('dapp-approval').waitFor({ timeout: 15_000 });
  check(
    (await sendApproval.getByTestId('dapp-send-to').innerText()).includes(RECIPIENT),
    'send approval shows the recipient',
  );
  await sendApproval.getByTestId('dapp-password').fill(PASSWORD);
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

  // Page-side helper: resolve/reject window.evrmore.getAddress() to a plain object.
  const pageGetAddress = () =>
    site.evaluate(() =>
      window.evrmore.getAddress().then(
        (address) => ({ ok: true, address }),
        (e) => ({ ok: false, message: String((e && e.message) || e) }),
      ),
    );

  // --- 6. WALLET-SWITCH (M2 fix): a connection is bound to ONE wallet ---------
  // The site is connected while Wallet 1 is active. Create + switch to a SECOND
  // wallet in the extension UI, then prove from the page that:
  //   (a) getAddress() rejects not-connected (Wallet 2 was never approved), and
  //   (b) a fresh connect() opens a NEW approval window (re-consent for Wallet 2).
  // Then switch back to Wallet 1 and prove getAddress() works again with NO new
  // approval — the original approval still stands for its own wallet.
  const popupSw = await context.newPage();
  await popupSw.goto(`chrome-extension://${id}/index.html`);
  await popupSw.waitForSelector('[data-testid="live-unlock"], [data-testid="live-home"]', { timeout: 20_000 });
  if (await popupSw.getByTestId('live-unlock').count()) {
    await popupSw.getByTestId('live-unlock').fill(PASSWORD);
    await popupSw.getByRole('button', { name: /^Unlock$/ }).click();
    await popupSw.getByTestId('live-home').waitFor({ timeout: 25_000 });
  }
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
  await popupSw.getByTestId('live-mnemonic-saved').click({ timeout: 15_000 });
  await popupSw.getByRole('button', { name: /Continue to wallet/i }).click({ timeout: 10_000 });
  await popupSw.getByTestId('live-home').waitFor({ timeout: 20_000 });
  const activeName = (await popupSw.getByTestId('live-wallet-switcher').innerText()).trim();
  check(/second wallet/i.test(activeName), `created + switched to Wallet 2 (active switcher -> "${activeName}")`);

  // (a) getAddress() from the page must now fail — Wallet 2 is not approved.
  let addrW2 = await pageGetAddress();
  for (let i = 0; i < 10 && addrW2.ok; i++) { await site.waitForTimeout(300); addrW2 = await pageGetAddress(); }
  check(
    addrW2.ok === false && /not-connected/.test(addrW2.message),
    `getAddress rejects not-connected after switching to an UNAPPROVED wallet -> ${JSON.stringify(addrW2)}`,
  );

  // (b) A fresh connect() must open a NEW approval window (re-consent for Wallet 2).
  const w2ApprovalPromise = context.waitForEvent('page', { timeout: 20_000 });
  await site.click('#connect');
  const w2Approval = await w2ApprovalPromise;
  await w2Approval.getByTestId('dapp-approval').waitFor({ timeout: 15_000 });
  check(true, 'connect() from an unapproved wallet opens a NEW approval window (fresh consent)');
  const w2WalletName = (await w2Approval.getByTestId('dapp-wallet-name').innerText()).trim();
  check(/second wallet/i.test(w2WalletName), `new approval window binds to the ACTIVE wallet -> "${w2WalletName}"`);
  await w2Approval.getByTestId('dapp-approve').click({ timeout: 10_000 });
  outText = '';
  for (let i = 0; i < 30; i++) {
    outText = (await site.locator('#out').innerText()).trim();
    if (/"address"/.test(outText)) break;
    await site.waitForTimeout(500);
  }
  let w2Addr = '';
  try { w2Addr = JSON.parse(outText).address; } catch { /* leave empty */ }
  check(
    !!w2Addr && w2Addr !== wallet1Address,
    `connect approved -> page now sees Wallet 2's DIFFERENT address (${w2Addr})`,
  );

  // Switch back to Wallet 1 (unlock with its own password).
  await popupSw.getByTestId('live-wallet-switcher').click({ timeout: 10_000 });
  await popupSw.getByTestId('live-wallet-item-0').click({ timeout: 10_000 });
  await popupSw.getByTestId('live-lock').waitFor({ timeout: 15_000 });
  await popupSw.getByTestId('live-unlock').fill(PASSWORD);
  await popupSw.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  await popupSw.getByTestId('live-home').waitFor({ timeout: 25_000 });

  // Back on Wallet 1: getAddress() works again with NO new approval window.
  let addrBack = await pageGetAddress();
  for (let i = 0; i < 10 && !addrBack.ok; i++) { await site.waitForTimeout(300); addrBack = await pageGetAddress(); }
  check(
    addrBack.ok === true && addrBack.address === wallet1Address,
    `after switching back to Wallet 1, getAddress works again WITHOUT re-approval -> ${JSON.stringify(addrBack)}`,
  );

  // --- 7. Reopen the popup: Settings -> Connected sites lists BOTH bindings ---
  const popup2 = await context.newPage();
  await popup2.goto(`chrome-extension://${id}/index.html`);
  // Reopening lands on the live surface; a fresh page means the wallet service
  // is locked again, so unlock first when the lock screen shows.
  await popup2.waitForSelector('[data-testid="live-unlock"], [data-testid="live-home"]', { timeout: 20_000 });
  if (await popup2.getByTestId('live-unlock').count()) {
    await popup2.getByTestId('live-unlock').fill(PASSWORD);
    await popup2.getByRole('button', { name: /^Unlock$/ }).click();
    await popup2.getByTestId('live-home').waitFor({ timeout: 25_000 });
  }
  await popup2.getByTestId('live-settings-btn').click();
  await popup2.getByTestId('live-settings-row-sites').click();
  await popup2.getByTestId('live-connected-sites').waitFor({ timeout: 10_000 });
  await popup2.getByTestId('live-site-0').waitFor({ timeout: 10_000 });
  // The same origin is now approved for BOTH wallets -> two rows, each labelled
  // with its bound wallet's name.
  const siteRowCount = await popup2.locator('[data-testid^="live-site-"]:not([data-testid*="disconnect"]):not([data-testid*="wallet"])').count();
  const siteRow0 = (await popup2.getByTestId('live-site-0').innerText()).trim();
  const boundNames = (await popup2.locator('[data-testid^="live-site-wallet-"]').allInnerTexts()).join(' | ');
  check(
    siteRow0.includes(SITE) && siteRowCount >= 2 && /second wallet/i.test(boundNames),
    `Connected sites lists per-wallet bindings (${siteRowCount} rows; wallets: ${boundNames})`,
  );

  // --- 8. Disconnect every binding -> the list empties (empty state shows) ----
  // Each row's Disconnect removes only THAT {origin, wallet} entry, so click until
  // the empty state appears.
  for (let i = 0; i < 5; i++) {
    if (await popup2.getByTestId('live-sites-empty').count()) break;
    const btn = popup2.getByTestId('live-site-disconnect-0');
    if (!(await btn.count())) break;
    await btn.click();
    await popup2.waitForTimeout(400);
  }
  await popup2.getByTestId('live-sites-empty').waitFor({ timeout: 10_000 });
  check(
    (await popup2.getByTestId('live-site-0').count()) === 0,
    'Disconnect removed every binding (empty state shown)',
  );

  // --- 9. Back on the page (Wallet 1 active): getAddress must now REJECT -------
  const addrOutcome = await pageGetAddress();
  check(
    addrOutcome.ok === false && /not-connected/.test(addrOutcome.message),
    `getAddress rejected with not-connected after disconnect -> ${JSON.stringify(addrOutcome)}`,
  );
} catch (e) {
  console.log('FAIL  exception:', String(e).split('\n')[0]);
  failures++;
} finally {
  await context.close();
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nDAPP SMOKE: all checks passed' : `\nDAPP SMOKE: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
