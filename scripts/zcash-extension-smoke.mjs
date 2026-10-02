// Zcash smoke test (`npm run qa:zcash`, the Zcash engine design notes §12.2).
// Two phases, both against the REAL gateway route
// (https://network.satorigo.app/zec/main/...):
//
// PHASE 1, the gateway, from node (no extension needed):
//   1. a FRESH BIP39 phrase is generated for the run (never the public
//      `abandon ... about` vector: that address is funded by strangers), and
//      its fifteen watch addresses are derived here, independently of the
//      wallet code (BIP44 m/44'/133'/0'/{0,1}/i, t1 prefix 1CB8);
//   2. /info: chainName main, height past 3,499,000, an 8-hex consensus branch
//      ID, transparent support;
//   3. /balance, /utxos, /txs, /mempool for the fresh watch set: all answer
//      200 through /zec/main, balance 0, nothing unspent, no history, nothing
//      pending;
//   4. the broadcast dry run: a v5 transaction spending a NON-EXISTENT
//      outpoint, signed here with the fresh key under the LIVE branch ID, sent
//      once through /zec/main/send. It cannot confirm (its input does not
//      exist). Accepted outcomes, per the live gateway's broadcast rule:
//        - HTTP 200 with errorCode -1 (the node's "could not find transparent
//          input UTXO", up to about 60 s), or
//        - HTTP 504 (lightwalletd DEADLINE_EXCEEDED / CANCELLED: "pending
//          unknown, look the txid up"; the gateway does NOT try another
//          server, and neither does this script).
//      Anything else (a consensus rejection such as a bad signature or wrong
//      branch ID, a 502) fails the step.
//
// PHASE 2, the extension (Playwright, the built dist/chrome):
//   5. import the fresh phrase, "Add Zcash" from the chain switcher, and the
//      home address equals the phase-1 derivation;
//   6. the first refresh settles with balance 0; Receive shows the same t1;
//   7. Send to t1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F (a public address, used
//      here as a RECIPIENT only) with 0.001 ZEC is refused for lack of funds
//      and no /send request is made;
//   8. a u1 recipient is refused with the shielded message, no request made;
//   9. lock, unlock: same address, and the history cache is reused
//      (`scannedTo` does not go backwards; the re-refresh reads only the
//      blocks since, not the chain from the Sapling floor);
//  10. every /zec/ request carried X-Satori-Client and used /zec/main/.
//
// No funds, no arming, no screenshot of a send to or from the vector phrase.
// The funded send is the owner's checklist (§12.3).
//
//   npm run build:chrome && npm run qa:zcash
//   ZCASH_GATEWAY_ONLY=1 npm run qa:zcash        (phase 1 only; no build needed)
//   SMOKE_HEADED=1 npm run qa:zcash               (watch phase 2)
//
// TESTIDS phase 2 relies on (live-zec-* are Set C's screens; (D) marks the
// shared screens Set D wires):
//   live-chain-option-zec:mainnet, live-chain-young-zec:mainnet   (switcher row + New chip)
//   live-chain-enable-panel, live-chain-enable-password,
//   live-chain-enable-submit                                         (existing enable panel)
//   (D) live-zec-home      the Zcash home body; data-state = refreshing | ready | error
//   (D) live-zec-balance   data-confirmed-zat (decimal string)
//   live-zec-receive, live-zec-receive-address                       (LiveReceiveZcash)
//   live-zec-send-to, live-zec-send-amount, live-zec-send-submit,
//   live-zec-send-review, live-zec-send-to-error                      (LiveSendZcash)
//   live-send, live-receive, live-lock-btn, live-lock, live-unlock,
//   live-address, live-home, live-onboarding, live-import-*           (existing)
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { blake2b } from '@noble/hashes/blake2b';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { base58check } from '@scure/base';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, process.env.ZCASH_DIST_DIR || path.join('dist', 'chrome'));
const shotsDir = path.join(root, 'docs', 'screenshots');
const gatewayOnly = process.env.ZCASH_GATEWAY_ONLY === '1';

const ZEC_TARGET = 'zec:mainnet';
const PASSWORD = 'live-pass-1234';
const MIN_TIP = 3_499_000;
const SAPLING_FLOOR = 419_200;
// A public mainnet address used as a send RECIPIENT only (the form never gets
// past the funds check, and nothing is armed or broadcast).
const RECIPIENT_T1 = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F';
// A syntactically plausible unified address: the form must refuse it as
// shielded before any request.
const RECIPIENT_U1 =
  'u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf';

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};
function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function gatewayConfig() {
  const envUrl = process.env.EVM_GATEWAY_URL;
  const envTok = process.env.EVM_CLIENT_TOKEN;
  let committed = {};
  try {
    committed = JSON.parse(readFileSync(path.join(root, 'platforms', 'evm-gateway.json'), 'utf8'));
  } catch {
    /* none */
  }
  const url = (envUrl !== undefined ? envUrl : committed.gatewayUrl || '').trim().replace(/\/+$/, '');
  const token = (envTok !== undefined ? envTok : committed.clientToken || '').trim();
  return { url, token };
}
const { url: gateway, token: clientToken } = gatewayConfig();
if (!gateway) fail('No gateway configured (platforms/evm-gateway.json or EVM_GATEWAY_URL); Zcash has no other route.');
const ZEC = `${gateway}/zec/main`;

// ---------------------------------------------------------------------------
// Keys and a transparent-only v5 transaction, written out here on purpose:
// the smoke checks the wallet against an implementation it does not share.
// (ZIP-32/BIP44 derivation, ZIP-225 layout, ZIP-244 digests, as in
// docs/design/zcash-engine.md §2 and §4.)
// ---------------------------------------------------------------------------

const b58c = base58check(sha256);
const hash160 = (b) => ripemd160(sha256(b));
const concat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of a) {
    out.set(x, p);
    p += x.length;
  }
  return out;
};
const u32le = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
const i64le = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(n), true);
  return b;
};
const compactSize = (n) => (n < 0xfd ? Uint8Array.of(n) : concat(Uint8Array.of(0xfd), Uint8Array.of(n & 0xff, n >> 8)));
const varbytes = (b) => concat(compactSize(b.length), b);
const te = new TextEncoder();
const H = (personal, ...data) =>
  blake2b(concat(...data), { dkLen: 32, personalization: typeof personal === 'string' ? te.encode(personal) : personal });
const branchPers = (prefix, branchId) => concat(te.encode(prefix), u32le(branchId));
const p2pkhScript = (h20) => concat(Uint8Array.of(0x76, 0xa9, 0x14), h20, Uint8Array.of(0x88, 0xac));
const t1Address = (pub) => b58c.encode(concat(Uint8Array.of(0x1c, 0xb8), hash160(pub)));

function deriveWatch(mnemonic) {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const keys = [];
  for (const [change, count] of [
    [0, 10],
    [1, 5],
  ]) {
    for (let i = 0; i < count; i++) {
      const node = master.derive(`m/44'/133'/0'/${change}/${i}`);
      keys.push({ path: `${change}/${i}`, privateKey: node.privateKey, publicKey: node.publicKey, address: t1Address(node.publicKey) });
    }
  }
  seed.fill(0);
  return keys;
}

const V5_HEADER = 0x80000005;
const V5_GROUP = 0x26a7270a;
function buildDryRunV5({ key, branchId, expiryHeight }) {
  // One input spending an outpoint that does not exist (random txid), one
  // output back to the same fresh address. 150,000 zat in, 140,000 out: a
  // 10,000 zat ZIP-317 fee (1 in, 1 out, grace 2).
  const script = p2pkhScript(hash160(key.publicKey));
  const tx = {
    branchId,
    expiryHeight,
    vin: [{ prevTxid: randomBytes(32), prevIndex: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }],
    vout: [{ value: 140_000n, script }],
  };
  const coins = [{ value: 150_000n, script }];
  const headerDigest = H('ZTxIdHeadersHash', u32le(V5_HEADER), u32le(V5_GROUP), u32le(branchId), u32le(0), u32le(expiryHeight));
  const prevouts = H('ZTxIdPrevoutHash', ...tx.vin.map((i) => concat(i.prevTxid, u32le(i.prevIndex))));
  const sequences = H('ZTxIdSequencHash', ...tx.vin.map((i) => u32le(i.sequence)));
  const outputs = H('ZTxIdOutputsHash', ...tx.vout.map((o) => concat(i64le(o.value), varbytes(o.script))));
  const sapling = H('ZTxIdSaplingHash');
  const orchard = H('ZTxIdOrchardHash');
  const txin = H(
    'Zcash___TxInHash',
    tx.vin[0].prevTxid,
    u32le(tx.vin[0].prevIndex),
    i64le(coins[0].value),
    varbytes(coins[0].script),
    u32le(tx.vin[0].sequence),
  );
  const tSig = H(
    'ZTxIdTranspaHash',
    Uint8Array.of(0x01),
    prevouts,
    H('ZTxTrAmountsHash', ...coins.map((c) => i64le(c.value))),
    H('ZTxTrScriptsHash', ...coins.map((c) => varbytes(c.script))),
    sequences,
    outputs,
    txin,
  );
  const sighash = H(branchPers('ZcashTxHash_', branchId), headerDigest, tSig, sapling, orchard);
  const sig = secp256k1.sign(sighash, key.privateKey, { lowS: true });
  const der = concat(sig.toDERRawBytes(), Uint8Array.of(0x01));
  tx.vin[0].scriptSig = concat(Uint8Array.of(der.length), der, Uint8Array.of(key.publicKey.length), key.publicKey);
  const raw = concat(
    u32le(V5_HEADER),
    u32le(V5_GROUP),
    u32le(branchId),
    u32le(0),
    u32le(expiryHeight),
    compactSize(1),
    tx.vin[0].prevTxid,
    u32le(0),
    varbytes(tx.vin[0].scriptSig),
    u32le(tx.vin[0].sequence),
    compactSize(1),
    i64le(tx.vout[0].value),
    varbytes(tx.vout[0].script),
    Uint8Array.of(0, 0, 0),
  );
  const tTxid = H('ZTxIdTranspaHash', prevouts, sequences, outputs);
  const txid = bytesToHex(H(branchPers('ZcashTxHash_', branchId), headerDigest, tTxid, sapling, orchard).reverse());
  return { hex: bytesToHex(raw), txid };
}

// ---------------------------------------------------------------------------
// Phase 1: the gateway
// ---------------------------------------------------------------------------

const headers = (post) => ({ ...(post ? { 'content-type': 'application/json' } : {}), ...(clientToken ? { 'X-Satori-Client': clientToken } : {}) });
async function zec(op, body, timeoutMs = 40_000) {
  const t0 = Date.now();
  const res = await fetch(`${ZEC}/${op}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: headers(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, ms: Date.now() - t0 };
}

const mnemonic = generateMnemonic(wordlist, 128);
const watchKeys = deriveWatch(mnemonic);
const watch = watchKeys.map((k) => k.address);
const primary = watch[0];
console.log(`fresh phrase generated for this run; /0/0 = ${primary}`);
check(
  watch.length === 15 && watch.every((a) => /^t1[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) && new Set(watch).size === 15,
  'fifteen distinct t1 watch addresses derived (m/44\'/133\'/0\'/{0,1}/i)',
);

let info = null;
try {
  const r = await zec('info');
  info = r.json;
  check(r.status === 200, `/info answers 200 (${r.ms} ms)`);
} catch (e) {
  fail(`gateway /zec/main/info does not answer (${e.message}). Nothing else can be tested before the route works.`);
}
check(info?.chainName === 'main', `/info chainName is main (${info?.chainName})`);
check(Number.isSafeInteger(info?.height) && info.height > MIN_TIP, `/info height ${info?.height} is past ${MIN_TIP}`);
check(/^[0-9a-f]{8}$/.test(info?.consensusBranchId || ''), `/info consensusBranchId is 8 hex characters (${info?.consensusBranchId})`);
check(info?.taddrSupport === true, '/info taddrSupport is true');
const branchId = parseInt(info?.consensusBranchId || '0', 16) >>> 0;
const tip = info?.height || 0;

{
  const b = await zec('balance', { addresses: watch });
  check(b.status === 200 && b.json?.zat === '0', `/balance of the fresh watch set is 0 (HTTP ${b.status}, ${b.json?.zat})`);
  const u = await zec('utxos', { addresses: watch });
  check(u.status === 200 && Array.isArray(u.json?.utxos) && u.json.utxos.length === 0, `/utxos is empty (HTTP ${u.status})`);
  const t = await zec('txs', { address: primary, start: Math.max(SAPLING_FLOOR, tip - 199_999), end: tip });
  check(t.status === 200 && Array.isArray(t.json?.txs) && t.json.txs.length === 0, `/txs of /0/0 over the last 200,000 blocks is empty (HTTP ${t.status}, ${t.ms} ms)`);
  const m = await zec('mempool', { addresses: watch });
  check(m.status === 200 && Array.isArray(m.json?.txs) && m.json.txs.length === 0, `/mempool has nothing for the watch set (HTTP ${m.status})`);
  const tx = await zec('tx', { txid: '00'.repeat(31) + '01' });
  check(tx.status === 404, `/tx of an unknown txid is 404 (HTTP ${tx.status})`);
  const bad = await zec('balance', { addresses: ['u1notatransparentaddress'] });
  check(bad.status === 400, `/balance refuses a non-transparent address with 400 (HTTP ${bad.status})`);
}

// The broadcast dry run.
{
  const expiryHeight = tip + 41;
  const built = buildDryRunV5({ key: watchKeys[0], branchId, expiryHeight });
  console.log(`dry-run send: v5, branch ${info?.consensusBranchId}, expiry ${expiryHeight}, txid ${built.txid}; up to 90 s`);
  let r;
  try {
    r = await zec('send', { hex: built.hex }, 120_000);
  } catch (e) {
    r = { status: 0, json: null, ms: 0, error: String(e.message) };
  }
  const msg = String(r.json?.errorMessage ?? r.json?.error ?? r.error ?? '').slice(0, 120);
  const accepted =
    (r.status === 200 && r.json?.errorCode === -1 && r.json?.ok === false) || r.status === 504;
  check(
    accepted,
    `the missing-input send is relayed and refused without a retry: HTTP ${r.status}` +
      `${r.json?.errorCode !== undefined ? `, errorCode ${r.json.errorCode}` : ''} "${msg}" (${Math.round(r.ms / 1000)} s; 504 = pending unknown, look the txid up)`,
  );
  if (r.status === 200 && r.json?.errorCode === -1) {
    check(/transparent input|could not find|missing|already queued/i.test(msg), `the node names the missing input ("${msg}")`);
  }
  if (r.status === 504) {
    // The broadcast rule: never send again, look the txid up. A missing-input
    // transaction must not be known anywhere.
    const look = await zec('tx', { txid: built.txid });
    check(look.status === 404, `after a 504 the txid is looked up, not re-sent: /tx answers ${look.status}`);
  }
}

watchKeys.forEach((k) => k.privateKey?.fill(0));

if (gatewayOnly) {
  console.log('SKIP  extension phase (ZCASH_GATEWAY_ONLY=1)');
  console.log(failures === 0 ? '\nqa:zcash (gateway only) PASSED' : `\nqa:zcash (gateway only) FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Phase 2: the extension
// ---------------------------------------------------------------------------

if (!existsSync(path.join(distDir, 'manifest.json'))) fail(`${distDir} has no manifest.json. Run \`npm run build:chrome\` first (or ZCASH_GATEWAY_ONLY=1).`);
{
  let hasZcash = false;
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      if (hasZcash) return;
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.js$/.test(f) && readFileSync(p, 'utf8').includes('/zec/')) hasZcash = true;
    }
  };
  walk(distDir);
  if (!hasZcash) fail(`${distDir} carries no Zcash code (no "/zec/" in its scripts): build after the Zcash wiring, or run ZCASH_GATEWAY_ONLY=1.`);
}
mkdirSync(shotsDir, { recursive: true });
const userDataDir = path.join(os.tmpdir(), `evrdemo-zec-${Date.now()}`);

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: process.env.SMOKE_HEADED !== '1',
  viewport: { width: 400, height: 620 },
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
const id = new URL(sw.url()).host;

/** @type {Array<{path: string, op: string, method: string, token: boolean, t: number, status?: number, body?: any}>} */
const zecRequests = [];
context.on('request', async (r) => {
  const url = r.url();
  if (!url.includes('/zec/')) return;
  const p = url.replace(/^https?:\/\/[^/]+/, '');
  const rec = { path: p, op: p.split('/').pop() || '', method: r.method(), token: false, t: Date.now() };
  try {
    rec.token = !!clientToken && (await r.allHeaders())['x-satori-client'] === clientToken;
  } catch {
    /* ignore */
  }
  try {
    const b = r.postData();
    if (b && b.startsWith('{')) rec.body = JSON.parse(b);
  } catch {
    /* ignore */
  }
  zecRequests.push(rec);
  r.response()
    .then((res) => {
      rec.status = res?.status();
    })
    .catch(() => {});
});

const page = await context.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0].slice(0, 160)));
const byId = (t) => page.getByTestId(t);
const shot = (name) => page.screenshot({ path: path.join(shotsDir, name) }).catch(() => {});

async function historyCacheEntry() {
  return sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const k = Object.keys(all).find((x) => x.includes('zec:history:'));
    return k ? { key: k, scannedTo: all[k]?.scannedTo, active: all[k]?.activeAddresses?.length ?? 0 } : null;
  });
}

async function waitZecReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = '';
  while (Date.now() < deadline) {
    const el = byId('live-zec-home');
    if (await el.count()) {
      state = (await el.getAttribute('data-state')) || '';
      if (state === 'ready' || state === 'error') return state;
    }
    await page.waitForTimeout(500);
  }
  return state || 'timeout';
}

try {
  await page.goto(`chrome-extension://${id}/index.html`);
  await byId('live-onboarding').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /Import recovery phrase/i }).click();
  await byId('live-import-input').waitFor({ timeout: 10_000 });
  await byId('live-import-input').fill(mnemonic);
  await byId('live-password').fill(PASSWORD);
  const confirm = byId('live-password-confirm');
  if (await confirm.count()) await confirm.fill(PASSWORD);
  await byId('live-import-submit').click();
  await byId('live-home').waitFor({ timeout: 25_000 });
  check(true, 'seed wallet imported from the fresh phrase');
  check(zecRequests.length === 0, `no Zcash request before Zcash is added (${zecRequests.length})`);

  await byId('live-chain-switcher').click();
  const row = byId(`live-chain-option-${ZEC_TARGET}`);
  await row.waitFor({ timeout: 10_000 });
  check(true, 'the chain switcher offers Zcash');
  check((await byId(`live-chain-young-${ZEC_TARGET}`).count()) === 1, 'the Zcash row carries the New chip');
  await shot('zec-switcher.png');
  await row.click();
  await byId('live-chain-enable-panel').waitFor({ timeout: 10_000 });
  const pw = byId('live-chain-enable-password');
  if (await pw.count()) await pw.fill(PASSWORD);
  const tAdd = Date.now();
  await byId('live-chain-enable-submit').click();

  await byId('live-zec-home').waitFor({ timeout: 30_000 });
  const homeAddr = (await byId('live-address').innerText()).trim();
  check(
    homeAddr === primary || (homeAddr.startsWith(primary.slice(0, 6)) && homeAddr.endsWith(primary.slice(-6))),
    `home shows the independently derived /0/0: ${homeAddr}`,
  );
  const s1 = await waitZecReady(90_000);
  check(s1 === 'ready', `the first refresh settles through the gateway (state ${s1}, ${Math.round((Date.now() - tAdd) / 1000)} s)`);
  const bal = byId('live-zec-balance');
  const zat = (await bal.count()) ? await bal.getAttribute('data-confirmed-zat') : null;
  check(zat === '0', `balance is 0 (data-confirmed-zat ${zat})`);
  const firstOps = [...new Set(zecRequests.filter((r) => r.t >= tAdd).map((r) => r.op))].sort().join(', ');
  check(['info', 'balance', 'utxos', 'mempool', 'txs'].every((op) => firstOps.includes(op)), `a refresh made the read calls (${firstOps})`);
  await shot('zec-home.png');

  // Receive.
  await byId('live-receive').click();
  await byId('live-zec-receive').waitFor({ timeout: 10_000 });
  const recv = (await byId('live-zec-receive-address').innerText()).trim();
  check(recv === primary, `receive shows the t1 address in full: ${recv.slice(0, 12)}...`);
  await shot('zec-receive.png');
  await page.getByRole('button', { name: 'Back' }).first().click({ timeout: 10_000 });
  await byId('live-zec-home').waitFor({ timeout: 10_000 });

  // Send: refused for lack of funds, nothing broadcast. The form is filled
  // with a RECIPIENT only; no screenshot of this step is kept.
  await byId('live-send').click();
  await byId('live-zec-send-to').waitFor({ timeout: 10_000 });
  await byId('live-zec-send-to').fill(RECIPIENT_T1);
  await byId('live-zec-send-amount').fill('0.001');
  await byId('live-zec-send-submit').click();
  let refusal = '';
  let reviewed = false;
  for (let i = 0; i < 60 && !refusal; i++) {
    const alerts = await page.locator('[role="alert"]').allInnerTexts();
    refusal = alerts.find((t) => /no spendable|not enough|insufficient|no funds/i.test(t)) || '';
    if (!reviewed && (await byId('live-zec-send-review').count())) reviewed = true;
    if (!refusal) await page.waitForTimeout(500);
  }
  check(!!refusal, `a send of 0.001 ZEC is refused for lack of funds: "${refusal.slice(0, 80)}"${reviewed ? ' (after review)' : ''}`);
  check(!zecRequests.some((r) => r.op === 'send'), 'nothing was broadcast (no /send from the extension)');

  // A unified address: refused as shielded before any request.
  const before = zecRequests.length;
  await byId('live-zec-send-to').fill(RECIPIENT_U1);
  await byId('live-zec-send-amount').fill('0.001');
  await byId('live-zec-send-submit').click().catch(() => {});
  let shielded = '';
  for (let i = 0; i < 20 && !shielded; i++) {
    const texts = [
      ...(await page.locator('[role="alert"]').allInnerTexts()),
      ...((await byId('live-zec-send-to-error').count()) ? [await byId('live-zec-send-to-error').innerText()] : []),
    ];
    shielded = texts.find((t) => /shielded|unified|transparent/i.test(t)) || '';
    if (!shielded) await page.waitForTimeout(250);
  }
  check(!!shielded, `a u1 recipient is refused: "${shielded.slice(0, 80)}"`);
  check(zecRequests.slice(before).every((r) => r.op !== 'send' && !JSON.stringify(r.body ?? '').includes('u1')), 'the u1 address never reached the gateway');
  await page.getByRole('button', { name: 'Back' }).first().click().catch(() => {});

  // Lock, unlock: same address, the cache is reused.
  const cache1 = await historyCacheEntry();
  check(!!cache1 && cache1.scannedTo >= tip, `the history cache was saved (scannedTo ${cache1?.scannedTo}, ${cache1?.active} active)`);
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-lock').waitFor({ timeout: 15_000 });
  const tUnlock = Date.now();
  await byId('live-unlock').fill(PASSWORD);
  await page.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  await byId('live-zec-home').waitFor({ timeout: 30_000 });
  const s2 = await waitZecReady(60_000);
  check(s2 === 'ready', `after unlock the refresh settles (state ${s2})`);
  const homeAddr2 = (await byId('live-address').innerText()).trim();
  check(homeAddr2 === homeAddr, 'same address after unlock');
  const cache2 = await historyCacheEntry();
  check(!!cache2 && cache2.scannedTo >= (cache1?.scannedTo ?? 0), `scannedTo did not go backwards (${cache1?.scannedTo} -> ${cache2?.scannedTo})`);
  const reTxs = zecRequests.filter((r) => r.t >= tUnlock && r.op === 'txs');
  check(
    reTxs.length > 0 && reTxs.every((r) => (r.body?.start ?? 0) > SAPLING_FLOOR),
    `the re-refresh read only recent blocks (${reTxs.length} /txs, lowest start ${Math.min(...reTxs.map((r) => r.body?.start ?? 0))})`,
  );

  // Transport rules.
  check(zecRequests.length > 0, `${zecRequests.length} requests went to ${gateway}/zec/main`);
  const untagged = zecRequests.filter((r) => !r.token);
  check(untagged.length === 0, `every /zec/ request carried X-Satori-Client${untagged.length ? `: missing on ${untagged[0].path}` : ''}`);
  check(zecRequests.every((r) => r.path.startsWith('/zec/main/')), 'every Zcash request used the main set prefix');
  const refused = zecRequests.filter((r) => r.status && r.status >= 400);
  check(refused.length === 0, `the gateway accepted every call${refused.length ? `: ${refused.map((r) => `${r.op} ${r.status}`).join('; ')}` : ''}`);
  const agg = {};
  for (const r of zecRequests) agg[r.op] = (agg[r.op] || 0) + 1;
  console.log('\nGateway calls this run (extension):');
  for (const [k, n] of Object.entries(agg).sort()) console.log(`  ${String(n).padStart(3)}  ${k}`);
} catch (e) {
  failures++;
  console.log('FAIL  smoke aborted:', String(e?.message || e).split('\n')[0]);
  await shot('zec-smoke-failure.png');
} finally {
  await context.close();
}

console.log(failures === 0 ? '\nqa:zcash PASSED' : `\nqa:zcash FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
