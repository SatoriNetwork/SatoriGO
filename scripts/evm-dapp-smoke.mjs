// window.ethereum smoke test: loads the BUILT `--evm` extension into Playwright
// Chromium, imports the public vector seed as an EVM account on Base, serves a
// tiny dApp page on 127.0.0.1 and drives the EIP-1193 provider end to end:
//   1. the provider is injected, announced via EIP-6963, and is window.ethereum
//      when no other wallet is installed;
//   2. before connecting: chain is Base, no accounts, signing is refused (4100);
//   3. eth_requestAccounts -> approval in the open wallet window -> the address;
//   4. personal_sign and eth_signTypedData_v4 -> approval -> signatures that
//      RECOVER to the account (verified here with @noble directly, not with the
//      wallet's own code);
//   5. wallet_switchEthereumChain on a connected site asks first (reject keeps
//      the chain, approve moves it), chainChanged reaches the page, an
//      unknown chain -> 4902;
//   6. read passthrough (eth_blockNumber, eth_getBalance) against the real RPC;
//   7. wallet_watchAsset knows SATORI on Base; eth_sign is refused;
//   8. eth_sendTransaction -> approval -> Review runs the real fee quote (the
//      vector account is unfunded, so a refusal is the expected outcome) ->
//      Reject -> the page gets 4001;
//   9. Settings > Connected sites lists the connection; Disconnect revokes it;
//  10. Default browser wallet: with another wallet on the page, Satori GO leaves
//      window.ethereum alone when off and takes it when on.
// No funds move: the account is unfunded and nothing is broadcast.
//
//   npm run build:evm && node scripts/evm-dapp-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist', 'chrome');
const userDataDir = path.join(os.tmpdir(), `satorigo-evm-dapp-${Date.now()}`);

const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PASSWORD = 'evm-dapp-pass-1234';
const SATORI_BASE = '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17';
const PORT = 8911;
const SITE = `http://127.0.0.1:${PORT}`;

// Independent verifiers: recover the signer from an EIP-191 / EIP-712 signature.
function recoverAddress(digest, sigHex) {
  const b = hexToBytes(sigHex.slice(2));
  const sig = secp.Signature.fromCompact(b.slice(0, 64)).addRecoveryBit(b[64] - 27);
  const pub = sig.recoverPublicKey(digest).toRawBytes(false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
}
const personalDigest = (bytes) =>
  keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes));
// A one-struct EIP-712 digest, written out by hand for the Login type below.
function loginDigest(domain, message) {
  const word = (n) => hexToBytes(BigInt(n).toString(16).padStart(64, '0'));
  const h = (s) => keccak_256(utf8ToBytes(s));
  const domainSep = keccak_256(
    concatBytes(h('EIP712Domain(string name,string version,uint256 chainId)'), h(domain.name), h(domain.version), word(domain.chainId)),
  );
  const struct = keccak_256(concatBytes(h('Login(string site,uint256 nonce)'), h(message.site), word(message.nonce)));
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domainSep, struct));
}

const TYPED = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    Login: [
      { name: 'site', type: 'string' },
      { name: 'nonce', type: 'uint256' },
    ],
  },
  primaryType: 'Login',
  domain: { name: 'Satori smoke', version: '1', chainId: 8453 },
  message: { site: SITE, nonce: 42 },
};

// The dApp page: every call goes through window.__call(method, params), and the
// page records EIP-6963 announcements and provider events.
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>evm dapp test</title></head>
<body>
  <h1>Satori GO window.ethereum test page</h1>
  <button id="connect">connect</button>
  <pre id="out"></pre>
  <script>
    window.__announced = [];
    window.__events = [];
    window.addEventListener('eip6963:announceProvider', (e) => window.__announced.push(e.detail));
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const sgo = () => (window.__announced.find((d) => d.info.rdns === 'io.satorinet.go') || {}).provider;
    window.__hooked = false;
    window.__hook = () => {
      if (window.__hooked || !sgo()) return;
      window.__hooked = true;
      sgo().on('chainChanged', (c) => window.__events.push(['chainChanged', c]));
      sgo().on('accountsChanged', (a) => window.__events.push(['accountsChanged', a]));
    };
    window.__call = (method, params) =>
      sgo().request({ method, params }).then(
        (result) => ({ result }),
        (e) => ({ error: { code: e.code, message: e.message } }),
      );
    // A click is a user gesture (the worker may open the side panel on one).
    window.__pending = null;
    document.getElementById('connect').onclick = () => {
      window.__pending = window.__call(window.__next.method, window.__next.params);
    };
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
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

async function worker() {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
}

/** Same as dapp-smoke.mjs: the approval shows up hosted in an open wallet
 *  window or as a new popup window. */
async function awaitApproval(trigger, { timeout = 20_000 } = {}) {
  const walletPages = context.pages().filter((p) => p.url().startsWith('chrome-extension://'));
  const never = new Promise(() => {});
  const seen = new Set();
  for (const page of walletPages) {
    if (page.isClosed()) continue;
    // A decided request's overlay can vanish between all() and the read; that
    // one is gone, not something to wait 30 s for.
    for (const el of await page.getByTestId('dapp-host-overlay').all()) {
      seen.add(await el.getAttribute('data-request-id', { timeout: 1000 }).catch(() => null));
    }
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

/** Fire an approval-gated call with a real click, and return the approval. */
async function clickCall(site, method, params) {
  await site.evaluate(([m, p]) => { window.__next = { method: m, params: p }; }, [method, params]);
  return awaitApproval(() => site.click('#connect'));
}
const pendingResult = (site) => site.evaluate(() => window.__pending);
const call = (site, method, params) => site.evaluate(([m, p]) => window.__call(m, p), [method, params]);

try {
  const sw = await worker();
  sw.on('console', (m) => { if (/error|warn/i.test(m.type())) console.log('  [worker]', m.text().slice(0, 240)); });
  const id = new URL(sw.url()).host;
  check(true, `extension service worker alive, id ${id}`);
  // Popup mode: Playwright cannot drive Chrome's side panel.
  await sw.evaluate(() => chrome.storage.local.set({ 'ui:sidePanel': false }));

  // --- 0. Import the vector seed as an EVM account on Base -------------------
  const wallet = await context.newPage();
  wallet.on('pageerror', (e) => console.log('  [wallet pageerror]', String(e).split('\n')[0].slice(0, 200)));
  await wallet.goto(`chrome-extension://${id}/index.html`);
  await wallet.getByTestId('live-onboarding').waitFor({ timeout: 15_000 });
  await wallet.getByRole('button', { name: /Import recovery phrase/i }).click();
  await wallet.getByTestId('live-import-chain-evm:base').click({ timeout: 10_000 });
  await wallet.getByTestId('live-import-input').fill(VECTOR_MNEMONIC);
  await wallet.getByTestId('live-password').fill(PASSWORD);
  const confirm = wallet.getByTestId('live-password-confirm');
  if (await confirm.count()) await confirm.fill(PASSWORD);
  await wallet.getByTestId('live-import-submit').click();
  await wallet.getByTestId('live-home').waitFor({ timeout: 30_000 });
  check(true, 'EVM account imported on Base (vector seed)');

  // --- 1. Injection, EIP-6963, window.ethereum --------------------------------
  const site = await context.newPage();
  site.on('pageerror', (e) => console.log('  [site pageerror]', String(e).split('\n')[0].slice(0, 200)));
  await site.goto(SITE);
  let announced = [];
  for (let i = 0; i < 20; i++) {
    await site.evaluate(() => window.dispatchEvent(new Event('eip6963:requestProvider')));
    announced = await site.evaluate(() => window.__announced.map((d) => d.info));
    if (announced.some((a) => a.rdns === 'io.satorinet.go')) break;
    await site.waitForTimeout(250);
  }
  const info = announced.find((a) => a.rdns === 'io.satorinet.go');
  check(!!info && info.name === 'Satori GO' && info.icon.startsWith('data:image/png;base64,'), `EIP-6963 announce: ${info ? `${info.name}, ${info.rdns}, icon data URI` : 'none'}`);
  check(await site.evaluate(() => window.ethereum && window.ethereum.isSatoriGO === true), 'window.ethereum is Satori GO (no other wallet installed)');
  check(await site.evaluate(() => window.ethereum.isMetaMask !== true), 'does not claim isMetaMask');
  await site.evaluate(() => window.__hook());

  // --- 2. Before connecting ----------------------------------------------------
  check((await call(site, 'eth_chainId')).result === '0x2105', 'eth_chainId is Base (0x2105) before connecting');
  check(JSON.stringify((await call(site, 'eth_accounts')).result) === '[]', 'eth_accounts is [] before connecting (no prompt)');
  const early = await call(site, 'personal_sign', ['0x00', VECTOR_ADDRESS]);
  check(early.error?.code === 4100, `personal_sign before connecting is refused with 4100 (${early.error?.code})`);

  // --- 3. Connect -----------------------------------------------------------------
  const conn = await clickCall(site, 'eth_requestAccounts', []);
  check(conn.kind === 'hosted', `connect approval appears inside the open wallet window (${conn.kind})`);
  check((await conn.scope.getByTestId('dapp-origin').innerText()).trim() === SITE, 'approval shows the requesting origin');
  check((await conn.scope.getByTestId('dapp-evm-chain').innerText()).trim() === 'Base', 'approval shows the chain: Base');
  await conn.scope.getByTestId('dapp-approve').click();
  const accounts = await pendingResult(site);
  check(
    Array.isArray(accounts.result) && accounts.result[0]?.toLowerCase() === VECTOR_ADDRESS.toLowerCase(),
    `eth_requestAccounts resolves with the account: ${JSON.stringify(accounts)}`,
  );
  check(
    (await call(site, 'eth_accounts')).result?.[0]?.toLowerCase() === VECTOR_ADDRESS.toLowerCase(),
    'eth_accounts now returns the account without a prompt',
  );
  check(
    (await site.evaluate(() => window.__events)).some(([e, a]) => e === 'accountsChanged' && a.length === 1),
    'accountsChanged reached the page',
  );

  // --- 4. Signatures ----------------------------------------------------------
  const helloHex = `0x${bytesToHex(utf8ToBytes('hello from the smoke'))}`;
  const ps = await clickCall(site, 'personal_sign', [helloHex, VECTOR_ADDRESS]);
  check((await ps.scope.getByTestId('dapp-sign-message').innerText()).trim() === 'hello from the smoke', 'personal_sign approval shows the decoded text');
  // Hosted in the unlocked wallet: the user already typed the password there.
  check((await ps.scope.getByTestId('dapp-password').count()) === 0, 'hosted in the unlocked wallet: no second password prompt');
  await ps.scope.getByTestId('dapp-approve').click();
  const psig = await pendingResult(site);
  const psSigner = psig.result ? recoverAddress(personalDigest(utf8ToBytes('hello from the smoke')), psig.result) : '';
  check(psSigner.toLowerCase() === VECTOR_ADDRESS.toLowerCase(), `personal_sign signature recovers to the account (${psSigner})`);

  const td = await clickCall(site, 'eth_signTypedData_v4', [VECTOR_ADDRESS, JSON.stringify(TYPED)]);
  check((await td.scope.getByTestId('dapp-sign-message').innerText()).includes('"nonce": 42'), 'typed data approval shows the message');
  check((await td.scope.getByTestId('dapp-permit-warning').count()) === 0, 'a login is not flagged as a permit');
  await td.scope.getByTestId('dapp-approve').click();
  const tsig = await pendingResult(site);
  const tdSigner = tsig.result ? recoverAddress(loginDigest(TYPED.domain, TYPED.message), tsig.result) : '';
  check(tdSigner.toLowerCase() === VECTOR_ADDRESS.toLowerCase(), `eth_signTypedData_v4 signature recovers to the account (${tdSigner})`);
  const wrongChain = await call(site, 'eth_signTypedData_v4', [VECTOR_ADDRESS, JSON.stringify({ ...TYPED, domain: { ...TYPED.domain, chainId: 1 } })]);
  check(wrongChain.error?.code === -32602, `typed data for another chain is refused before any window opens (${wrongChain.error?.code})`);

  // --- 5. Chains -----------------------------------------------------------------
  const sw1 = await clickCall(site, 'wallet_switchEthereumChain', [{ chainId: '0x1' }]);
  check(/from Base to Ethereum/.test((await sw1.scope.getByTestId('dapp-switch-text').innerText()).replace(/\s+/g, ' ')), 'a connected site asks before switching (Base to Ethereum)');
  await sw1.scope.getByTestId('dapp-reject').click();
  const sw1Out = await pendingResult(site);
  check(sw1Out.error?.code === 4001, `rejecting the switch gives the page 4001 (${JSON.stringify(sw1Out.error)})`);
  check((await call(site, 'eth_chainId')).result === '0x2105', 'after a rejected switch the site is still on Base');
  const sw2 = await clickCall(site, 'wallet_switchEthereumChain', [{ chainId: '0x1' }]);
  await sw2.scope.getByTestId('dapp-approve').click();
  check((await pendingResult(site)).result === null, 'an approved switch to Ethereum resolves null');
  check((await call(site, 'eth_chainId')).result === '0x1', 'eth_chainId is now 0x1');
  await site.waitForTimeout(300);
  check((await site.evaluate(() => window.__events)).some(([e, c]) => e === 'chainChanged' && c === '0x1'), 'chainChanged(0x1) reached the page');
  check((await site.evaluate(() => window.ethereum.chainId)) === '0x1', 'provider.chainId follows the switch');
  const unknown = await call(site, 'wallet_switchEthereumChain', [{ chainId: '0x89' }]);
  check(unknown.error?.code === 4902, `an unsupported chain answers 4902 (${unknown.error?.code})`);
  const sw3 = await clickCall(site, 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  await sw3.scope.getByTestId('dapp-approve').click();
  await pendingResult(site);
  check((await call(site, 'eth_chainId')).result === '0x2105', 'back on Base');

  // --- 6. Reads ------------------------------------------------------------------
  const block = await call(site, 'eth_blockNumber', []);
  check(/^0x[0-9a-f]+$/i.test(block.result ?? '') && BigInt(block.result) > 1_000_000n, `eth_blockNumber from the Base RPC: ${block.result ?? JSON.stringify(block.error)}`);
  const bal = await call(site, 'eth_getBalance', [VECTOR_ADDRESS, 'latest']);
  check(/^0x[0-9a-f]*$/i.test(bal.result ?? ''), `eth_getBalance answers: ${bal.result ?? JSON.stringify(bal.error)}`);

  // --- 7. watchAsset / eth_sign -----------------------------------------------
  const watch = await call(site, 'wallet_watchAsset', { type: 'ERC20', options: { address: SATORI_BASE, symbol: 'SATORI', decimals: 18 } });
  check(watch.result === true, 'wallet_watchAsset(SATORI on Base) -> true');
  check((await call(site, 'eth_sign', [VECTOR_ADDRESS, `0x${'00'.repeat(32)}`])).error?.code === 4200, 'eth_sign is refused (4200)');
  check((await call(site, 'eth_sendRawTransaction', ['0x00'])).error?.code === 4200, 'eth_sendRawTransaction is not forwarded (4200)');

  // --- 8. Transaction: review runs for real, then reject --------------------------
  const tx = await clickCall(site, 'eth_sendTransaction', [{ from: VECTOR_ADDRESS, to: SATORI_BASE, value: '0x1' }]);
  check((await tx.scope.getByTestId('dapp-send-to').innerText()).trim() === SATORI_BASE, 'transaction approval shows the recipient');
  await tx.scope.getByTestId('dapp-approve').click(); // Review: price + simulate
  let reviewed = '';
  for (let i = 0; i < 40; i++) {
    const err = tx.scope.getByTestId('dapp-error');
    const fee = (await tx.scope.getByTestId('dapp-send-fee').innerText()).trim();
    if (await err.count()) { reviewed = `refused: ${(await err.innerText()).trim()}`; break; }
    if (!/after review/.test(fee)) { reviewed = `priced: ${fee}`; break; }
    await site.waitForTimeout(500);
  }
  check(!!reviewed, `Review ran the real fee quote on Base (${reviewed.slice(0, 140) || 'no outcome'})`);
  check((await tx.scope.getByTestId('dapp-confirm').count()) === 0 || !(await tx.scope.getByTestId('dapp-confirm').isEnabled()) || /priced/.test(reviewed),
    'an unfunded account cannot reach an enabled Confirm unless it priced');
  await tx.scope.getByTestId('dapp-reject').click();
  const txOut = await pendingResult(site);
  check(txOut.error?.code === 4001, `rejecting the transaction gives the page 4001 (${JSON.stringify(txOut.error)})`);

  // An unlimited token approval is decoded and called out before Review.
  const spender = '0x000000000000000000000000000000000000dEaD';
  const approveData = `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}`;
  const ap = await clickCall(site, 'eth_sendTransaction', [{ from: VECTOR_ADDRESS, to: SATORI_BASE, data: approveData }]);
  const apWarn = ap.scope.getByTestId('dapp-allowance-warning');
  await apWarn.waitFor({ timeout: 15_000 }).catch(() => undefined);
  check((await apWarn.count()) === 1 && /UNLIMITED/.test(await apWarn.innerText()), 'an unlimited approve(spender) is decoded and flagged');
  const apRows = (await ap.scope.getByTestId('dapp-call-row').allInnerTexts()).join(' | ');
  check(/Unlimited/.test(apRows) && apRows.toLowerCase().includes(spender.slice(2).toLowerCase()), `approve rows show the spender and the amount (${apRows.slice(0, 120)})`);
  await ap.scope.getByTestId('dapp-reject').click();
  check((await pendingResult(site)).error?.code === 4001, 'rejecting the approve gives the page 4001');

  // --- 9. Connected sites -------------------------------------------------------
  await wallet.getByTestId('live-settings-btn').click();
  await wallet.getByTestId('live-settings-mode-expert').click({ timeout: 10_000 });
  await wallet.getByTestId('live-settings-row-sites').click();
  await wallet.getByTestId('live-connected-sites').waitFor({ timeout: 10_000 });
  const row = (await wallet.getByTestId('live-site-wallet-0').innerText()).trim();
  check(/Base\/Ethereum/.test(row), `Connected sites lists the EVM connection (${row})`);
  await wallet.getByTestId('live-site-disconnect-0').click();
  await wallet.getByTestId('live-sites-empty').waitFor({ timeout: 10_000 });
  check(JSON.stringify((await call(site, 'eth_accounts')).result) === '[]', 'after Disconnect, eth_accounts is [] again');
  await site.waitForTimeout(500);
  check(
    (await site.evaluate(() => window.__events)).some(([e, a]) => e === 'accountsChanged' && Array.isArray(a) && a.length === 0),
    'Disconnect in Settings sends accountsChanged([]) to the site',
  );

  // --- 10. Default browser wallet ----------------------------------------------
  const other = await context.newPage();
  // Another wallet that set window.ethereum first (as MetaMask does).
  await other.addInitScript(() => { window.ethereum = { isOtherWallet: true, request: async () => null }; });
  await other.goto(SITE);
  await other.waitForTimeout(1500);
  check(await other.evaluate(() => window.ethereum.isOtherWallet === true), 'setting off: the other wallet keeps window.ethereum');
  check(await other.evaluate(() => !!window.__satoriGoEvmProvider), 'setting off: Satori GO is still injected (reachable via EIP-6963)');
  // The toggle itself, as the user flips it.
  const toggle = wallet.getByTestId('live-set-evm-default-wallet');
  await toggle.click();
  await wallet.waitForTimeout(300);
  const stored = await sw.evaluate(() => chrome.storage.local.get('evrdemo:evmDefaultWallet'));
  check(stored['evrdemo:evmDefaultWallet'] === true, 'the toggle stores evmDefaultWallet = true');
  await other.reload();
  await other.waitForTimeout(1500);
  check(await other.evaluate(() => window.ethereum.isSatoriGO === true), 'setting on (after reload): Satori GO takes window.ethereum');
  check(await other.evaluate(() => { window.ethereum = { isOtherWallet: true }; return window.ethereum.isSatoriGO === true; }), 'setting on: a later assignment by another wallet does not replace it');
} catch (err) {
  failures++;
  console.log('FAIL  smoke aborted:', err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err);
} finally {
  await context.close();
  server.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
