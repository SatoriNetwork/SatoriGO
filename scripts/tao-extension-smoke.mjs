// Bittensor smoke test (`npm run qa:tao`, the Bittensor engine design notes
// §12.2, with the owner's 2026-09-28 override: no Taostats, no /history).
// Loads the Chrome build (dist/chrome; Bittensor has no build flag, §13),
// imports a FRESH phrase generated for this run (never the public `abandon`
// vector: its Bittensor account is live and used by strangers), adds
// Bittensor through the chain switcher, and drives the REAL gateway route
// (https://network.satorigo.app/tao/main) end to end:
//
//   1. the address the wallet shows equals the pure derivation of the phrase
//      (entropy route, sr25519, SS58 42), computed here independently;
//   2. GET /tao/main/runtime: node-subtensor on the Finney genesis, layout
//      equal to the pinned profile (the spec version is printed; it moves);
//   3. the balance of the fresh account is 0 (no System.Account entry);
//   4. Receive shows the full address and the taostats.io account link;
//   5. a Polkadot address is refused in the form, with no request made;
//   6. a send of 0.001 TAO reaches review with a fee near 83,000 rao, and the
//      confirm step's pre-flight answers Invalid(Payment), shown as "not
//      enough TAO"; NOTHING IS SUBMITTED: every author_submitExtrinsic is
//      aborted by this script before it leaves the browser, and counted;
//   7. the signed extrinsic the wallet priced is pre-flighted from here with
//      one signature byte flipped: Invalid(BadProof), so the node checks what
//      the wallet signs; unflipped it is Invalid(Payment);
//   8. an old block's state through the gateway answers (the 4003 hop from a
//      pruned node to an archive node);
//   9. lock and unlock: the mini secret is re-derived, same address;
//  10. every /tao/ request carried X-Satori-Client, used /tao/main, and no
//      Substrate node or Taostats API was contacted directly.
//
// No funds: the account is created by this run and never funded. The funded
// send is the owner's manual checklist (§12.3).
//
//   npm run build:chrome && npm run qa:tao
//   SMOKE_HEADED=1 npm run qa:tao        (watch it)
//
// TESTIDS this script relies on (the switcher and lock ones already exist; the
// live-tao-* ones are Set C's screens, the ones marked (D) are the shared
// screens Set D wires):
//   live-chain-switcher, live-chain-option-tao:mainnet, live-chain-young-tao:mainnet,
//   live-chain-enable-panel, live-chain-enable-password, live-chain-enable-submit
//   (D) live-tao-home          the Bittensor home body (present only on a Bittensor wallet)
//   (D) live-tao-balance       data-free-rao, data-reserved-rao (decimal strings)
//   live-tao-receive, live-tao-receive-address, live-tao-receive-taostats-link
//   live-tao-send-to, live-tao-send-amount, live-tao-send-submit, live-tao-send-review,
//   live-tao-send-fee (data-fee-rao), live-tao-arm-checkbox, live-tao-send-password,
//   live-tao-broadcast, live-tao-send-error
//   live-send, live-receive, live-lock-btn, live-lock, live-unlock, live-address, live-home   (existing)
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { generateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha512 } from '@noble/hashes/sha512';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import * as sr25519 from '@scure/sr25519';
import { base58 } from '@scure/base';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, process.env.TAO_DIST_DIR || path.join('dist', 'chrome'));
const shotsDir = path.join(root, 'docs', 'screenshots');
mkdirSync(shotsDir, { recursive: true });
const userDataDir = path.join(os.tmpdir(), `evrdemo-tao-${Date.now()}`);

const TAO_TARGET = 'tao:mainnet';
const PASSWORD = 'live-pass-1234';
// A funded account that is not ours (§12.2 step 4); the send never happens.
const RECIPIENT = '5DvaFrBesD6jTWd3GEefcM72BSXaFRHqQuZtwBSZii1VMnuP';
// The pinned profile (src/services/chain/substrate/tao.ts, spec 470).
const PINNED = {
  specName: 'node-subtensor',
  genesis: '0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03',
  ss58: 42,
  decimals: 9,
  symbol: 'TAO',
  existentialDeposit: '500',
  extrinsicVersion: 4,
  balanceBytes: 8,
  balances: { pallet: 5, transfer_allow_death: 0, transfer_keep_alive: 3, transfer_all: 4 },
  signedExtensions: [
    'CheckNonZeroSender', 'CheckSpecVersion', 'CheckTxVersion', 'CheckGenesis', 'CheckMortality', 'CheckNonce',
    'CheckWeight', 'ChargeTransactionPayment', 'SudoTransactionExtension', 'CheckShieldedTxValidity',
    'SubtensorTransactionExtension', 'DrandPriority', 'CheckMetadataHash',
  ],
};
const SYSTEM_ACCOUNT_PREFIX = '0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9';
// Hosts the wallet must never contact directly: every Substrate call goes
// through the gateway, and there is no Taostats API in v1.
const FOREIGN_TAO_HOSTS = /opentensor\.ai|onfinality\.io|latent\.to|blockmachine\.io|api\.taostats\.io|dwellir|subscan/i;

// ---------------------------------------------------------------------------
// The pure derivation (§2.1), independent of the wallet's code.
// ---------------------------------------------------------------------------

function ss58(pub) {
  const body = concatBytes(Uint8Array.of(42), pub);
  const sum = blake2b(concatBytes(utf8ToBytes('SS58PRE'), body), { dkLen: 64 }).slice(0, 2);
  return base58.encode(concatBytes(body, sum));
}
function addressOf(phrase) {
  const entropy = mnemonicToEntropy(phrase, wordlist);
  const mini = pbkdf2(sha512, entropy, utf8ToBytes('mnemonic'), { c: 2048, dkLen: 64 }).slice(0, 32);
  const pub = sr25519.getPublicKey(sr25519.secretFromSeed(mini));
  mini.fill(0);
  return { address: ss58(pub), publicKey: pub };
}
function accountKey(pub) {
  return `${SYSTEM_ACCOUNT_PREFIX}${bytesToHex(blake2b(pub, { dkLen: 16 }))}${bytesToHex(pub)}`;
}

// ---------------------------------------------------------------------------
// Preconditions: a build, and a gateway that answers on /tao/main.
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
if (!gateway) fail('No gateway configured (platforms/evm-gateway.json or EVM_GATEWAY_URL); Bittensor has no other route.');
{
  let found = false;
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      if (found) return;
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js') && readFileSync(p, 'utf8').includes('TaggedTransactionQueue_validate_transaction')) found = true;
    }
  };
  walk(distDir);
  if (!found) fail(`${distDir} carries no Bittensor engine (no validate_transaction in its JS). Rebuild after the wiring lands.`);
}

const gwHeaders = { 'content-type': 'application/json', ...(clientToken ? { 'X-Satori-Client': clientToken } : {}) };
let rpcId = 0;
async function gatewayRpc(method, params = []) {
  const res = await fetch(`${gateway}/tao/main`, {
    method: 'POST',
    headers: gwHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`HTTP ${res.status} without JSON (${method})`);
  if (body.error) throw new Error(`${method}: ${body.error.code} ${String(body.error.message).slice(0, 120)}`);
  return body.result;
}

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

// §12.2 step 2: the runtime digest, before any browser.
let runtime;
try {
  const res = await fetch(`${gateway}/tao/main/runtime`, { headers: clientToken ? { 'X-Satori-Client': clientToken } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  runtime = await res.json();
} catch (e) {
  fail(`gateway /tao/main/runtime does not answer (${e.message}). The wallet cannot be tested before the route works.`);
}
console.log(`gateway: ${gateway}/tao/main answers, spec ${runtime.specVersion} tx ${runtime.transactionVersion}, finalized ${runtime.finalizedHeight} via ${runtime.node}`);
check(runtime.specName === PINNED.specName && runtime.genesis === PINNED.genesis, 'the gateway serves node-subtensor on the Finney genesis');
{
  const diffs = Object.keys(PINNED).filter((k) => JSON.stringify(runtime[k]) !== JSON.stringify(PINNED[k]));
  check(diffs.length === 0, `the live layout equals the pinned profile${diffs.length ? `: differs in ${diffs.join(', ')}` : ''}`);
}

// A fresh phrase, and proof its account is empty before the wallet sees it.
const phrase = generateMnemonic(wordlist, 128);
const expected = addressOf(phrase);
console.log(`fresh account for this run: ${expected.address}`);
try {
  const entry = await gatewayRpc('state_getStorage', [accountKey(expected.publicKey)]);
  check(entry === null, 'the fresh account has no System.Account entry (0 TAO) according to the gateway');
} catch (e) {
  check(false, `read the fresh account through the gateway (${e.message})`);
}

// ---------------------------------------------------------------------------

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: process.env.SMOKE_HEADED !== '1',
  viewport: { width: 400, height: 620 },
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
const id = new URL(sw.url()).host;

/** @type {Array<{url: string, method: string, token: boolean, rpc?: string, params?: unknown[], t: number, status?: number}>} */
const taoRequests = [];
const foreign = [];
let submitsBlocked = 0;
const submitsSeen = () => taoRequests.filter((r) => r.rpc === 'author_submitExtrinsic').length;

// THE STOP BEFORE SUBMIT. Every author_submitExtrinsic is aborted here before
// it leaves the browser, whatever the wallet decides. The fresh account is
// unfunded, so the node would refuse it anyway; this makes the smoke's "no
// broadcast" a property of the script, not of the account.
await context.route(`${gateway}/tao/**`, async (route) => {
  const body = route.request().postData() || '';
  if (body.includes('author_submitExtrinsic')) {
    submitsBlocked++;
    await route.abort('blockedbyclient');
    return;
  }
  await route.continue();
});

context.on('request', async (r) => {
  const url = r.url();
  if (FOREIGN_TAO_HOSTS.test(new URL(url).hostname)) foreign.push(url);
  if (!url.startsWith(`${gateway}/tao/`)) return;
  const rec = { url: url.slice(gateway.length), method: r.method(), token: false, t: Date.now() };
  try {
    rec.token = !!clientToken && (await r.allHeaders())['x-satori-client'] === clientToken;
  } catch {
    /* ignore */
  }
  try {
    const b = r.postData();
    if (b && b.startsWith('{')) {
      const j = JSON.parse(b);
      rec.rpc = j.method;
      rec.params = j.params;
    }
  } catch {
    /* ignore */
  }
  taoRequests.push(rec);
  r.response()
    .then((res) => {
      rec.status = res?.status();
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
const shot = (name) => page.screenshot({ path: path.join(shotsDir, name) }).catch(() => {});
const alerts = async () => (await page.locator('[role="alert"], [data-testid="live-tao-send-error"]').allInnerTexts()).join(' | ');

async function homeAddress() {
  return (await byId('live-address').innerText()).replace(/\s+/g, '').trim();
}
const looksLike = (shown, full) => shown === full || (shown.startsWith(full.slice(0, 6)) && shown.endsWith(full.slice(-4)));

try {
  // -------------------------------------------------------------------------
  // Seed wallet from the fresh phrase, then "Add Bittensor" from the switcher.
  // -------------------------------------------------------------------------
  await page.goto(`chrome-extension://${id}/index.html`);
  await byId('live-onboarding').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /Import recovery phrase/i }).click();
  await byId('live-import-input').waitFor({ timeout: 10_000 });
  await byId('live-import-input').fill(phrase);
  await byId('live-password').fill(PASSWORD);
  const confirm = byId('live-password-confirm');
  if (await confirm.count()) await confirm.fill(PASSWORD);
  await byId('live-import-submit').click();
  await byId('live-home').waitFor({ timeout: 25_000 });
  check(true, 'seed wallet imported from a phrase generated for this run');
  check(taoRequests.length === 0, 'no Bittensor request before Bittensor is added (never automatic)');

  await byId('live-chain-switcher').click();
  const row = byId(`live-chain-option-${TAO_TARGET}`);
  await row.waitFor({ timeout: 10_000 });
  check(true, 'the chain switcher offers Bittensor');
  check((await byId(`live-chain-young-${TAO_TARGET}`).count()) === 1, 'the Bittensor row carries the New chip');
  await shot('tao-switcher.png');
  await row.click();
  await byId('live-chain-enable-panel').waitFor({ timeout: 10_000 });
  const pw = byId('live-chain-enable-password');
  if (await pw.count()) await pw.fill(PASSWORD);
  await byId('live-chain-enable-submit').click();

  // -------------------------------------------------------------------------
  // Address and balance.
  // -------------------------------------------------------------------------
  await byId('live-tao-home').waitFor({ timeout: 30_000 });
  const shown = await homeAddress();
  check(looksLike(shown, expected.address), `home shows the derived SS58 address: ${shown}`);
  let bal = {};
  for (let i = 0; i < 60; i++) {
    const el = byId('live-tao-balance');
    if (await el.count()) {
      bal = await el.evaluate((n) => ({ free: n.getAttribute('data-free-rao'), reserved: n.getAttribute('data-reserved-rao') }));
      if (bal.free !== null && bal.free !== '') break;
    }
    await page.waitForTimeout(500);
  }
  check(bal.free === '0', `balance of the fresh account is 0 (free ${bal.free}, reserved ${bal.reserved})`);
  const reads = taoRequests.filter((r) => r.rpc === 'state_getStorage');
  check(reads.length > 0 && reads.every((r) => String(r.params?.[0]).toLowerCase() === accountKey(expected.publicKey)), 'the balance read is System.Account of this key');
  await shot('tao-home.png');

  // -------------------------------------------------------------------------
  // Receive: the full address and the taostats account link.
  // -------------------------------------------------------------------------
  await byId('live-receive').click();
  await byId('live-tao-receive').waitFor({ timeout: 10_000 });
  const recv = (await byId('live-tao-receive-address').innerText()).replace(/\s+/g, '').trim();
  check(recv === expected.address, `receive shows the address in full: ${recv}`);
  const link = byId('live-tao-receive-taostats-link');
  const href = (await link.count()) ? await link.getAttribute('href') : null;
  check(href === `https://taostats.io/account/${expected.address}`, `receive links the full history on taostats.io (${href})`);
  await shot('tao-receive.png');
  await page.getByRole('button', { name: 'Back' }).first().click({ timeout: 10_000 });
  await byId('live-tao-home').waitFor({ timeout: 10_000 });

  // -------------------------------------------------------------------------
  // Send: a Polkadot address is refused in the form, with no request.
  // -------------------------------------------------------------------------
  await byId('live-send').click();
  await byId('live-tao-send-to').waitFor({ timeout: 10_000 });
  const dot = base58.encode(
    concatBytes(Uint8Array.of(0), expected.publicKey, blake2b(concatBytes(utf8ToBytes('SS58PRE'), Uint8Array.of(0), expected.publicKey), { dkLen: 64 }).slice(0, 2)),
  );
  const tDot = Date.now();
  await byId('live-tao-send-to').fill(dot);
  await byId('live-tao-send-amount').fill('0.001');
  await byId('live-tao-send-submit').click();
  await page.waitForTimeout(1500);
  const dotRefusal = await alerts();
  check(/Bittensor address/i.test(dotRefusal) && (await byId('live-tao-send-review').count()) === 0, `a Polkadot address (${dot.slice(0, 8)}...) is refused: "${dotRefusal.slice(0, 90)}"`);
  const dotReqs = taoRequests.filter((r) => r.t >= tDot && r.rpc !== 'state_getStorage' && r.rpc !== 'chain_getFinalizedHead' && r.rpc !== 'chain_getHeader');
  check(dotReqs.length === 0, `no send request was made for it${dotReqs.length ? `: ${dotReqs.map((r) => r.rpc || r.url).join(', ')}` : ''}`);

  // -------------------------------------------------------------------------
  // Send 0.001 TAO: review with the runtime's fee, then the confirm step's
  // pre-flight refuses with Payment. Never submitted.
  // -------------------------------------------------------------------------
  await byId('live-tao-send-to').fill(RECIPIENT);
  await byId('live-tao-send-amount').fill('0.001');
  const tSend = Date.now();
  await byId('live-tao-send-submit').click();
  let reviewed = false;
  let early = '';
  for (let i = 0; i < 60 && !reviewed; i++) {
    reviewed = (await byId('live-tao-send-review').count()) > 0;
    if (!reviewed) {
      early = await alerts();
      if (/not enough TAO/i.test(early)) break;
      await page.waitForTimeout(500);
    }
  }
  const priced = taoRequests.find((r) => r.t >= tSend && r.rpc === 'payment_queryInfo');
  const signedHex = typeof priced?.params?.[0] === 'string' ? priced.params[0] : '';
  check(!!signedHex && (signedHex.length - 2) / 2 === 145, `the wallet built and priced a 145-byte transfer_keep_alive (${signedHex ? (signedHex.length - 2) / 2 : 0} bytes)`);
  let refusal = early;
  if (reviewed) {
    const feeEl = byId('live-tao-send-fee');
    const feeRao = (await feeEl.count()) ? Number(await feeEl.getAttribute('data-fee-rao')) : NaN;
    check(feeRao > 40_000 && feeRao < 400_000, `review shows the runtime's fee (${feeRao} rao; about 83,000 expected)`);
    await shot('tao-send-review.png');
    const arm = byId('live-tao-arm-checkbox');
    if (await arm.count()) await arm.click();
    const spw = byId('live-tao-send-password');
    if (await spw.count()) await spw.fill(PASSWORD);
    await byId('live-tao-broadcast').click();
    for (let i = 0; i < 60 && !/not enough TAO/i.test(refusal); i++) {
      await page.waitForTimeout(500);
      refusal = await alerts();
    }
  }
  // Since 2026-10-02 an amount the account cannot pay for (amount + fee over
  // what is spendable) is refused in the FORM with the most that fits, so an
  // unfunded wallet stops there; a funded-but-short one used to reach review
  // and fail only at Confirm. Either way it must be refused for the fee.
  check(/not enough TAO/i.test(refusal), `the send is refused for the fee: "${refusal.slice(0, 90)}"`);
  if (reviewed) {
    const preflights = taoRequests.filter((r) => r.t >= tSend && r.rpc === 'state_call' && r.params?.[0] === 'TaggedTransactionQueue_validate_transaction');
    check(preflights.length >= 1, `the confirm step pre-flighted with validate_transaction (${preflights.length} call${preflights.length === 1 ? '' : 's'})`);
  } else {
    check(/fee/i.test(early), `the form refused it before review, naming the fee: "${early.slice(0, 90)}"`);
  }
  check(submitsSeen() === 0 && submitsBlocked === 0, `nothing was submitted (author_submitExtrinsic seen ${submitsSeen()}, blocked ${submitsBlocked})`);
  await shot('tao-send-refused.png');

  // -------------------------------------------------------------------------
  // The node checks what the wallet signs: flip one signature byte.
  // -------------------------------------------------------------------------
  if (signedHex) {
    const head = await gatewayRpc('chain_getFinalizedHead');
    const validate = async (hex) =>
      gatewayRpc('state_call', ['TaggedTransactionQueue_validate_transaction', `0x02${hex.slice(2)}${head.slice(2)}`, head]);
    // 2 length + 1 version + 1 MultiAddress + 32 signer + 1 signature tag = 37 bytes in.
    const at = 2 + 2 * 37;
    const flipped = signedHex.slice(0, at) + (signedHex[at] === 'a' ? 'b' : 'a') + signedHex.slice(at + 1);
    try {
      const plain = await validate(signedHex);
      const bad = await validate(flipped);
      check(plain === '0x010001', `the wallet's own extrinsic validates as Invalid(Payment) (${plain})`);
      check(bad === '0x010004', `the same bytes with one signature byte flipped: Invalid(BadProof) (${bad})`);
    } catch (e) {
      // A plan older than its era would answer Stale/AncientBirthBlock; the
      // smoke runs well inside 64 blocks.
      check(false, `pre-flight the captured extrinsic from here (${e.message})`);
    }
  }

  // -------------------------------------------------------------------------
  // The 4003 hop: an old block's state through the gateway.
  // -------------------------------------------------------------------------
  try {
    const oldHash = await gatewayRpc('chain_getBlockHash', [1_000_000]);
    const entry = await gatewayRpc('state_getStorage', [accountKey(expected.publicKey), oldHash]);
    check(entry === null, `state at block 1,000,000 answers through the gateway (pruned node hands on to an archive node)`);
  } catch (e) {
    check(false, `state at block 1,000,000 through the gateway (${e.message})`);
  }

  await page.getByRole('button', { name: 'Back' }).first().click({ timeout: 5_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Back' }).first().click({ timeout: 2_000 }).catch(() => {});

  // -------------------------------------------------------------------------
  // Lock, unlock: same address (the mini secret is re-derived from the vault).
  // -------------------------------------------------------------------------
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-lock').waitFor({ timeout: 15_000 });
  await byId('live-unlock').fill(PASSWORD);
  await page.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  await byId('live-tao-home').waitFor({ timeout: 30_000 });
  const shown2 = await homeAddress();
  check(shown2 === shown && looksLike(shown2, expected.address), 'same address after lock and unlock');

  // -------------------------------------------------------------------------
  // Transport rules.
  // -------------------------------------------------------------------------
  check(taoRequests.length > 0, `${taoRequests.length} requests went to ${gateway}/tao/main`);
  const untagged = taoRequests.filter((r) => !r.token);
  check(untagged.length === 0, `every /tao/ request carried X-Satori-Client${untagged.length ? `: missing on ${untagged[0].url}` : ''}`);
  check(taoRequests.every((r) => r.url === '/tao/main' || r.url === '/tao/main/runtime'), 'every Bittensor request used the main node set');
  check(!taoRequests.some((r) => /history/.test(r.url)), 'no /history request (no Taostats in v1)');
  check(foreign.length === 0, `no Substrate node or Taostats API was contacted directly${foreign.length ? `: ${foreign[0]}` : ''}`);
  const refused = taoRequests.filter((r) => r.status && r.status >= 400);
  check(refused.length === 0, `the gateway accepted every call${refused.length ? `: ${refused.map((r) => `${r.rpc || r.url} ${r.status}`).join('; ')}` : ''}`);

  const agg = {};
  for (const r of taoRequests) {
    const k = r.rpc === 'state_call' ? `state_call ${r.params?.[0]}` : r.rpc || `GET ${r.url}`;
    agg[k] = (agg[k] || 0) + 1;
  }
  console.log('\nGateway calls this run:');
  for (const [k, n] of Object.entries(agg).sort()) console.log(`  ${String(n).padStart(3)}  ${k}`);
} catch (e) {
  failures++;
  console.log('FAIL  smoke aborted:', String(e?.message || e).split('\n')[0]);
  await shot('tao-smoke-failure.png');
} finally {
  await context.close();
}

check(submitsBlocked === 0, `no submit was attempted by the wallet during the run (${submitsBlocked} blocked)`);
console.log(failures === 0 ? '\nqa:tao PASSED' : `\nqa:tao FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
