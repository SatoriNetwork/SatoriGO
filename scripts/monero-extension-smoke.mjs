// Monero smoke test (`npm run qa:monero`, the Monero engine design notes
// §12.2): loads the `--monero` Chrome build (dist/chrome), imports the public
// BIP39 vector seed, adds Monero through the chain switcher ("Add Monero" is
// an explicit action, never automatic), and drives the REAL gateway route
// (https://network.satorigo.app/xmr/main/...) end to end:
//
//   1. the primary address equals the cake-exodus vector for the words;
//   2. the first scan (restore height = tip minus 20, set by "Add Monero")
//      completes against the real node, balance 0;
//   3. a new subaddress is the 0/1 vector;
//   4. the 25 recovery words and the restore height are revealed;
//   5. a send of 0.001 XMR builds up to wallet2 and is refused with "not
//      enough money": proves the send path reaches the node (fee estimate,
//      hard-fork info) WITHOUT touching sendrawtransaction;
//   6. lock terminates the wallet worker; unlock spawns a fresh one and reopens
//      from the encrypted cache (a few KB of chain, not a rescan);
//   7. every /xmr/ request carried X-Satori-Client, none went to another host.
// Then prints the bytes the run cost through the gateway, so the cost per open
// is on record with each run, and optionally checks a build WITHOUT --monero
// for leaked Monero code.
//
// No funds, no broadcast: the arming checkbox is never reached. The funded
// send is the owner's manual checklist (§12.3).
//
//   npm run build:chrome && npm run qa:monero
//   MONERO_NEGATIVE_DIR=dist/store/chrome npm run qa:monero   (also check a non-Monero build)
//   SMOKE_HEADED=1 npm run qa:monero                            (watch it)
//
// TESTIDS this script relies on. Set C's screens already carry the live-xmr-*
// ones; the ones marked (D) are for the shared screens Set D wires:
//   live-chain-option-xmr:mainnet, live-chain-young-xmr:mainnet   (switcher row + New chip)
//   live-chain-enable-password, live-chain-enable-submit           (existing enable panel)
//   (D) live-xmr-home          the Monero home body (present only on a Monero wallet)
//   (D) live-xmr-sync          data-state = opening | syncing | synced | error | busy,
//                              data-height, data-daemon-height, data-percent
//   (D) live-xmr-balance       data-total-pico, data-unlocked-pico (decimal strings)
//   (D) live-xmr-reveal-open   Settings button that opens MoneroSeedReveal
//   live-xmr-receive, live-xmr-receive-address, live-xmr-receive-new-address,
//   live-xmr-receive-addr-<minor>, live-xmr-send-to, live-xmr-send-amount,
//   live-xmr-send-submit, live-xmr-send-review, live-xmr-seed-reveal,
//   live-xmr-seed-password, live-xmr-seed-reveal-submit, live-xmr-seed-word-<n>,
//   live-xmr-seed-height                                           (Set C)
//   live-send, live-receive, live-lock-btn, live-unlock, live-settings-btn,
//   live-address, live-home                                         (existing)
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, process.env.MONERO_DIST_DIR || path.join('dist', 'chrome'));
const shotsDir = path.join(root, 'docs', 'screenshots');
mkdirSync(shotsDir, { recursive: true });
const userDataDir = path.join(os.tmpdir(), `evrdemo-xmr-${Date.now()}`);

// PUBLIC vectors (docs/design/monero-engine.md §2.3, cake-exodus row 1).
const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ADDRESS =
  '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756';
const VECTOR_SUB_0_1 =
  '88DAExP6fh2iR45U7DJcFRP5YEQbg8T4EKhhYz7J5vg1YA17kxiQZyv6AMaMyW7yDhaKYTyDN6M5v8AAAVdtMEEB8AeZUEA';
const VECTOR_WORDS =
  'subtly emerge cucumber wield jester neutral echo guide problems hiding necklace tapestry offend tell erase ugly envy turnip click iguana pebbles idols listen nail cucumber';
// Any valid mainnet address that is not ours (the legal-winner vector).
const RECIPIENT =
  '4BCmqSJ5GVJ7cqoxcu5wXURMDfhgvw596Dp7mjtVoD8fcpuYR3gad8VHBgLBwC11HZ3eWM3DJqWk7UrSKDZ26RtBKwJccRo';
const MONERO_RELEASE_HEIGHT = 3772358;
const XMR_TARGET = 'xmr:mainnet';
const PASSWORD = 'live-pass-1234';
// Markers that must be absent from a build without --monero (§13).
const MONERO_MARKERS = ['xmr-worker.js', '/xmr/', 'SubAddr', 'monero.worker.js'];

// ---------------------------------------------------------------------------
// Preconditions: a Monero build, and a gateway that answers on /xmr/main.
// ---------------------------------------------------------------------------

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

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

if (!existsSync(path.join(distDir, 'manifest.json'))) fail(`${distDir} has no manifest.json. Run \`npm run build:chrome\` first.`);
const manifest = JSON.parse(readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
const csp = manifest.content_security_policy?.extension_pages || '';
if (!csp.includes("'wasm-unsafe-eval'")) fail(`${distDir} is not a --monero build: its CSP has no 'wasm-unsafe-eval'.`);
for (const f of ['monero.worker.js', 'xmr-worker.js']) {
  if (!existsSync(path.join(distDir, f))) fail(`${distDir} is missing ${f}: the build did not copy the Monero worker.`);
}
if (!gateway) fail('No gateway configured (platforms/evm-gateway.json or EVM_GATEWAY_URL); Monero has no other route.');

async function gatewayGetInfo() {
  const res = await fetch(`${gateway}/xmr/main/json_rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(clientToken ? { 'X-Satori-Client': clientToken } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.result?.height) throw new Error('no height in get_info');
  return body.result;
}
let tipAtStart = 0;
try {
  const info = await gatewayGetInfo();
  tipAtStart = info.height;
  console.log(`gateway: ${gateway}/xmr/main answers, tip ${tipAtStart} (${info.nettype || 'mainnet'})`);
  if (info.nettype && info.nettype !== 'mainnet') fail(`gateway node set main is on ${info.nettype}, not mainnet`);
} catch (e) {
  fail(`gateway /xmr/main does not answer get_info (${e.message}). The wallet cannot be tested before the route works.`);
}

// Best effort: the gateway's per-route byte counter, before and after (§12.2
// step 6). Not a check: the metrics route may be LAN-only or need admin auth.
async function xmrMetrics() {
  try {
    const res = await fetch(`${gateway}/evm/metrics`, { headers: clientToken ? { 'X-Satori-Client': clientToken } : {} });
    if (!res.ok) return null;
    const text = await res.text();
    const m = /xmr:main[^\n]*/.exec(text);
    return m ? m[0].slice(0, 200) : null;
  } catch {
    return null;
  }
}
const metricsBefore = await xmrMetrics();

// ---------------------------------------------------------------------------

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: process.env.SMOKE_HEADED !== '1',
  viewport: { width: 400, height: 620 },
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
const id = new URL(sw.url()).host;

// Count wallet workers from inside every extension page: lock must terminate
// the one holding the keys, unlock must spawn a fresh one.
await context.addInitScript(() => {
  const w = /** @type {any} */ (globalThis);
  if (!w.Worker || w.__xmrWorkers) return;
  w.__xmrWorkers = { created: 0, terminated: 0 };
  const Native = w.Worker;
  w.Worker = class extends Native {
    constructor(url, opts) {
      super(url, opts);
      if (String(url).includes('xmr-worker.js')) {
        w.__xmrWorkers.created++;
        const term = this.terminate.bind(this);
        this.terminate = () => {
          w.__xmrWorkers.terminated++;
          term();
        };
      }
    }
  };
});

// Every request the extension makes (pages, service worker AND the wallet's
// dedicated worker, which Playwright attributes to the page).
/** @type {Array<{url: string, method: string, token: boolean, rpc?: string, t: number, bytes?: number, status?: number}>} */
const xmrRequests = [];
const foreignFromWorker = [];
context.on('request', async (r) => {
  const url = r.url();
  if (!url.includes('/xmr/')) {
    if (/\/(json_rpc|getblocks\.bin|gethashes\.bin|get_outs\.bin|sendrawtransaction)(\?|$)/.test(url)) foreignFromWorker.push(url);
    return;
  }
  const rec = { url: url.replace(/^https?:\/\/[^/]+/, ''), method: r.method(), token: false, t: Date.now() };
  try {
    rec.token = (await r.allHeaders())['x-satori-client'] === clientToken && !!clientToken;
  } catch {
    /* ignore */
  }
  try {
    const b = r.postData();
    if (b && b.startsWith('{')) rec.rpc = JSON.parse(b).method;
  } catch {
    /* binary body */
  }
  xmrRequests.push(rec);
  r.response()
    .then(async (res) => {
      rec.status = res?.status();
      try {
        rec.bytes = (await r.sizes()).responseBodySize;
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
});

const page = await context.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/error|fail|refused/i.test(t)) console.log('  [page]', t.slice(0, 160));
});
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0].slice(0, 160)));

const byId = (t) => page.getByTestId(t);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};
const shot = (name) => page.screenshot({ path: path.join(shotsDir, name) }).catch(() => {});
const workers = () => page.evaluate(() => ({ .../** @type {any} */ (globalThis).__xmrWorkers }));
const mb = (bytes) => (bytes / 1048576).toFixed(2);
const bytesSince = (t0) => xmrRequests.filter((r) => r.t >= t0).reduce((a, r) => a + (r.bytes || 0), 0);

/** Wait for the Monero home to report a finished scan. Returns the sync
 *  element's attributes, or the last seen ones on timeout. */
async function waitSynced(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  let lastLog = 0;
  while (Date.now() < deadline) {
    const el = byId('live-xmr-sync');
    if (await el.count()) {
      last = await el.evaluate((n) => ({
        state: n.getAttribute('data-state'),
        height: Number(n.getAttribute('data-height')),
        daemonHeight: Number(n.getAttribute('data-daemon-height')),
        percent: n.getAttribute('data-percent'),
      }));
      if (last.state === 'synced' || last.state === 'error' || last.state === 'busy') return last;
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        console.log(`  ... ${last.state} ${last.height}/${last.daemonHeight} (${last.percent}%)`);
      }
    }
    await page.waitForTimeout(500);
  }
  return last;
}

try {
  // -------------------------------------------------------------------------
  // Seed wallet, then "Add Monero" from the chain switcher.
  // -------------------------------------------------------------------------
  await page.goto(`chrome-extension://${id}/index.html`);
  await byId('live-onboarding').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /Import recovery phrase/i }).click();
  await byId('live-import-input').waitFor({ timeout: 10_000 });
  await byId('live-import-input').fill(VECTOR_MNEMONIC);
  await byId('live-password').fill(PASSWORD);
  const confirm = byId('live-password-confirm');
  if (await confirm.count()) await confirm.fill(PASSWORD);
  await byId('live-import-submit').click();
  await byId('live-home').waitFor({ timeout: 25_000 });
  check(true, 'seed wallet imported from the public vector phrase');
  check((await workers()).created === 0, 'no Monero worker exists before Monero is added (never auto-created)');

  await byId('live-chain-switcher').click();
  const xmrRow = byId(`live-chain-option-${XMR_TARGET}`);
  await xmrRow.waitFor({ timeout: 10_000 });
  check(true, 'the chain switcher offers Monero');
  check((await byId(`live-chain-young-${XMR_TARGET}`).count()) === 1, 'the Monero row carries the New chip');
  check(/Add/.test(await xmrRow.innerText()), 'the Monero row offers Add (no Monero wallet yet)');
  await shot('xmr-switcher.png');
  await xmrRow.click();
  await byId('live-chain-enable-panel').waitFor({ timeout: 10_000 });
  const pw = byId('live-chain-enable-password');
  if (await pw.count()) await pw.fill(PASSWORD);
  // The vector phrase was IMPORTED, so the panel presets "used with Monero
  // before" (scan from the release floor, §6.6). This wallet has no history,
  // and the floor moves further from the tip every day; the smoke wants the
  // tip-20 scan the step list describes, so it answers "no" explicitly.
  const usedBefore = byId('live-chain-monero-used-before');
  check((await usedBefore.count()) === 1 && (await usedBefore.isChecked()), 'an imported phrase presets "used with Monero before"');
  await usedBefore.uncheck();
  const tAdd = Date.now();
  await byId('live-chain-enable-submit').click();

  // -------------------------------------------------------------------------
  // Address, first scan, balance.
  // -------------------------------------------------------------------------
  await byId('live-xmr-home').waitFor({ timeout: 30_000 });
  const homeAddr = (await byId('live-address').innerText()).trim();
  check(
    homeAddr.startsWith(VECTOR_ADDRESS.slice(0, 6)) && homeAddr.endsWith(VECTOR_ADDRESS.slice(-6)),
    `home shows the cake-exodus vector address: ${homeAddr}`,
  );
  const s1 = await waitSynced(5 * 60_000);
  check(s1.state === 'synced', `first scan completes through the gateway (state ${s1.state}, ${Math.round((Date.now() - tAdd) / 1000)} s)`);
  check(s1.daemonHeight > MONERO_RELEASE_HEIGHT, `daemon height ${s1.daemonHeight} is past the release height ${MONERO_RELEASE_HEIGHT}`);
  check(s1.height >= s1.daemonHeight - 1, `wallet scanned to the tip (${s1.height} of ${s1.daemonHeight})`);
  const firstOpenBytes = bytesSince(tAdd);
  const bal = byId('live-xmr-balance');
  const balAttrs = (await bal.count())
    ? await bal.evaluate((n) => ({ total: n.getAttribute('data-total-pico'), unlocked: n.getAttribute('data-unlocked-pico') }))
    : {};
  check(balAttrs.total === '0' && balAttrs.unlocked === '0', `balance is 0 (total ${balAttrs.total}, unlocked ${balAttrs.unlocked})`);
  await shot('xmr-home.png');

  // -------------------------------------------------------------------------
  // Receive: primary address in full, then a new subaddress = the 0/1 vector.
  // -------------------------------------------------------------------------
  await byId('live-receive').click();
  await byId('live-xmr-receive').waitFor({ timeout: 10_000 });
  let recvAddr = '';
  // The receive screen asks the worker for the address; under a busy machine
  // (a full test run beside it) that took over 10 s once, so allow 30.
  for (let i = 0; i < 120 && !/^4/.test(recvAddr); i++) {
    recvAddr = (await byId('live-xmr-receive-address').innerText()).trim();
    if (!/^4/.test(recvAddr)) await page.waitForTimeout(250);
  }
  check(recvAddr === VECTOR_ADDRESS, `receive shows the primary address in full: ${recvAddr.slice(0, 12)}...`);
  await byId('live-xmr-receive-new-address').click();
  await byId('live-xmr-receive-addr-1').waitFor({ timeout: 15_000 });
  await byId('live-xmr-receive-addr-1').click();
  let subAddr = '';
  for (let i = 0; i < 20 && subAddr !== VECTOR_SUB_0_1; i++) {
    subAddr = (await byId('live-xmr-receive-address').innerText()).trim();
    if (subAddr !== VECTOR_SUB_0_1) await page.waitForTimeout(250);
  }
  check(subAddr === VECTOR_SUB_0_1, `new subaddress is the 0/1 vector: ${subAddr.slice(0, 12)}...`);
  await shot('xmr-receive.png');
  // The wallet's OWN Back button, never page.goBack(): the popup is a single
  // document (screens are state, not history entries), so a browser back lands
  // on the tab's first entry, about:blank, and every step after it fails
  // (seen 2026-09-28: a blank failure screenshot).
  await page.getByRole('button', { name: 'Back' }).first().click({ timeout: 10_000 });
  await byId('live-xmr-home').waitFor({ timeout: 10_000 });

  // -------------------------------------------------------------------------
  // Reveal: the 25 words and the restore height.
  // -------------------------------------------------------------------------
  try {
    await byId('live-settings-btn').click({ timeout: 10_000 });
    await byId('live-xmr-reveal-open').click({ timeout: 10_000 });
    await byId('live-xmr-seed-reveal').waitFor({ timeout: 10_000 });
    const rp = byId('live-xmr-seed-password');
    if (await rp.count()) {
      await rp.fill(PASSWORD);
      await byId('live-xmr-seed-reveal-submit').click();
    }
    await byId('live-xmr-seed-word-25').waitFor({ timeout: 15_000 });
    const words = [];
    for (let i = 1; i <= 25; i++) words.push((await byId(`live-xmr-seed-word-${i}`).innerText()).trim().replace(/^\d+\.?\s*/, ''));
    check(words.join(' ') === VECTOR_WORDS, `reveal shows the 25-word vector (${words.slice(0, 3).join(' ')} ...)`);
    const height = Number((await byId('live-xmr-seed-height').innerText()).replace(/[^\d]/g, ''));
    check(
      height >= MONERO_RELEASE_HEIGHT && height <= tipAtStart + 100,
      `reveal shows the restore height beside the words (${height}; tip at start ${tipAtStart})`,
    );
    await shot('xmr-reveal.png');
    await byId('live-xmr-seed-hide').click();
  } catch (e) {
    check(false, `reveal the 25 words from Settings (${String(e.message).split('\n')[0]})`);
  }
  await byId('live-tab-assets').click({ timeout: 10_000 }).catch(() => {});
  await byId('live-xmr-home').waitFor({ timeout: 10_000 });

  // -------------------------------------------------------------------------
  // Send: wallet2 builds against the real node and refuses: not enough money.
  // -------------------------------------------------------------------------
  await byId('live-send').click();
  await byId('live-xmr-send-to').waitFor({ timeout: 10_000 });
  await byId('live-xmr-send-to').fill(RECIPIENT);
  await byId('live-xmr-send-amount').fill('0.001');
  const tSend = Date.now();
  await byId('live-xmr-send-submit').click();
  let refusal = '';
  for (let i = 0; i < 120 && !refusal; i++) {
    const alerts = await page.locator('[role="alert"]').allInnerTexts();
    refusal = alerts.find((t) => /not enough money|insufficient unlocked xmr/i.test(t)) || '';
    if (!refusal && (await byId('live-xmr-send-review').count())) break;
    if (!refusal) await page.waitForTimeout(500);
  }
  check(!!refusal, `send of 0.001 XMR is refused by wallet2 for lack of funds: "${refusal.slice(0, 80)}"`);
  check((await byId('live-xmr-send-review').count()) === 0, 'no review screen for an unfunded wallet');
  const sendReqs = xmrRequests.filter((r) => r.t >= tSend);
  check(
    sendReqs.some((r) => r.rpc === 'get_fee_estimate' || r.rpc === 'hard_fork_info' || /get_outs|get_output_distribution/.test(r.url)),
    `building the send reached the node (${[...new Set(sendReqs.map((r) => r.rpc || r.url.split('/').pop()))].join(', ') || 'no request'})`,
  );
  check(!xmrRequests.some((r) => /send_?raw_?transaction/.test(r.url)), 'nothing was broadcast (no sendrawtransaction)');
  await shot('xmr-send-refused.png');
  await page.getByRole('button', { name: 'Back' }).first().click().catch(() => {});

  // -------------------------------------------------------------------------
  // Lock terminates the worker; unlock reopens from the cache.
  // -------------------------------------------------------------------------
  const wBefore = await workers();
  check(wBefore.created >= 1, `one wallet worker is running (${wBefore.created} created, ${wBefore.terminated} terminated)`);
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-lock').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  const wLocked = await workers().catch(() => null);
  // The lock screen may be a fresh document (counter reset) or the same page.
  check(
    wLocked === null || wLocked.created === 0 || wLocked.terminated >= wBefore.terminated + 1,
    `lock terminates the wallet worker (${JSON.stringify(wLocked)})`,
  );
  const tUnlock = Date.now();
  await byId('live-unlock').fill(PASSWORD);
  await page.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  await byId('live-xmr-home').waitFor({ timeout: 30_000 });
  const s2 = await waitSynced(2 * 60_000);
  const wAfter = await workers();
  check(s2.state === 'synced', `after unlock the wallet reopens and syncs (state ${s2.state})`);
  check(
    wAfter.created > (wLocked?.created ?? 0) && wAfter.created - wAfter.terminated === 1,
    `unlock spawned a fresh worker (${JSON.stringify(wAfter)})`,
  );
  const reopenBytes = bytesSince(tUnlock);
  const reopenBlocks = xmrRequests.filter((r) => r.t >= tUnlock && /getblocks\.bin/.test(r.url)).length;
  check(
    reopenBytes < 3 * 1048576,
    `reopen came from the cache: ${mb(reopenBytes)} MB through the gateway, ${reopenBlocks} getblocks calls (a rescan would be ~17 MB/day of chain)`,
  );
  const homeAddr2 = (await byId('live-address').innerText()).trim();
  check(homeAddr2 === homeAddr, 'same address after unlock');

  // -------------------------------------------------------------------------
  // Transport rules.
  // -------------------------------------------------------------------------
  check(xmrRequests.length > 0, `${xmrRequests.length} requests went to ${gateway}/xmr/main`);
  const untagged = xmrRequests.filter((r) => !r.token);
  check(untagged.length === 0, `every /xmr/ request carried X-Satori-Client${untagged.length ? `: missing on ${untagged[0].url}` : ''}`);
  check(xmrRequests.every((r) => r.url.startsWith('/xmr/main/')), 'every Monero request used the main node set prefix');
  check(foreignFromWorker.length === 0, `no monerod path went to any other host${foreignFromWorker.length ? `: ${foreignFromWorker[0]}` : ''}`);
  const refused = xmrRequests.filter((r) => r.status && r.status >= 400);
  check(refused.length === 0, `the gateway accepted every call${refused.length ? `: ${refused.map((r) => `${r.url} ${r.rpc || ''} ${r.status}`).join('; ')}` : ''}`);

  const agg = {};
  for (const r of xmrRequests) {
    const k = `${r.url}${r.rpc ? ` ${r.rpc}` : ''}`;
    agg[k] = (agg[k] || 0) + 1;
  }
  console.log('\nGateway cost this run:');
  console.log(`  first open + scan: ${mb(firstOpenBytes)} MB; reopen after unlock: ${mb(reopenBytes)} MB; total ${mb(bytesSince(0))} MB`);
  for (const [k, n] of Object.entries(agg).sort()) console.log(`  ${String(n).padStart(3)}  ${k}`);
  const metricsAfter = await xmrMetrics();
  if (metricsBefore || metricsAfter) console.log(`  gateway metrics: before ${metricsBefore ?? 'n/a'}; after ${metricsAfter ?? 'n/a'}`);
} catch (e) {
  failures++;
  console.log('FAIL  smoke aborted:', String(e?.message || e).split('\n')[0]);
  await shot('xmr-smoke-failure.png');
} finally {
  await context.close();
}

// ---------------------------------------------------------------------------
// Negative build check (§12.2 step 7): a build WITHOUT --monero carries none of
// it. Points at an existing build; this script does not build.
// ---------------------------------------------------------------------------
const negDir = process.env.MONERO_NEGATIVE_DIR ? path.join(root, process.env.MONERO_NEGATIVE_DIR) : '';
if (negDir) {
  if (!existsSync(path.join(negDir, 'manifest.json'))) {
    check(false, `negative build dir ${negDir} has no manifest.json`);
  } else {
    const negManifest = JSON.parse(readFileSync(path.join(negDir, 'manifest.json'), 'utf8'));
    const negCsp = negManifest.content_security_policy?.extension_pages || '';
    check(!negCsp.includes('wasm-unsafe-eval'), 'a build without --monero keeps the CSP without wasm-unsafe-eval');
    check(
      !existsSync(path.join(negDir, 'xmr-worker.js')) && !existsSync(path.join(negDir, 'monero.worker.js')),
      'a build without --monero ships no Monero worker files',
    );
    const leaked = new Set();
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(js|html|json)$/.test(f)) {
          const text = readFileSync(p, 'utf8');
          for (const m of MONERO_MARKERS) if (text.includes(m)) leaked.add(`${m} in ${path.relative(negDir, p)}`);
        }
      }
    };
    walk(negDir);
    check(leaked.size === 0, `no Monero markers in a build without --monero${leaked.size ? `: ${[...leaked].join(', ')}` : ''}`);
  }
} else {
  console.log('SKIP  negative build check (set MONERO_NEGATIVE_DIR to a build made without --monero)');
}

console.log(failures === 0 ? '\nqa:monero PASSED' : `\nqa:monero FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
