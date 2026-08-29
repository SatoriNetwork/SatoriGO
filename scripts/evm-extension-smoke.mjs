// EVM smoke test (phase 3 of the EVM rollout): loads a `--evm` build of the
// extension, imports the public Trezor vector seed as an EVM account on Base,
// and verifies the account-above-chains model end to end against the REAL
// Base and BNB Chain RPCs: the MetaMask address for the words, balances over
// JSON-RPC, the chain switcher switching the chain WITHIN the account (same
// address), the receive screen, and the EVM send form up to the fee quote
// (the vector address is unfunded, so the node's refusal to simulate is the
// expected, honestly shown outcome). No funds, no broadcast: the arming
// checkbox is never touched.
//
// Phase 6 added Ethereum and then Epix. Epix is the first chain Alchemy does
// not serve: in a gateway build it depends on the gateway carrying a direct
// upstream /rpc route and a Blockscout /indexer proxy for it, so its checks
// probe the gateway first and label their own failures accordingly.
//
//   npm run build:evm && node scripts/evm-extension-smoke.mjs
//
// Refuses to run on a build without the EVM hosts in its manifest.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist', 'chrome');
const shotsDir = path.join(root, 'docs', 'screenshots');
mkdirSync(shotsDir, { recursive: true });
const userDataDir = path.join(os.tmpdir(), `evrdemo-evm-${Date.now()}`);

// A build carries the EVM host permissions in one of two shapes: the dev
// per-host list (mainnet.base.org ...) or the release shape, ONE gateway host
// (network.satorigo.app). Detect either. The gateway comes from
// EVM_GATEWAY_URL or platforms/evm-gateway.json, same source build.mjs uses.
function configuredGateway() {
  const fromEnv = process.env.EVM_GATEWAY_URL;
  if (fromEnv !== undefined) return fromEnv.trim().replace(/\/+$/, '');
  try {
    const g = JSON.parse(readFileSync(path.join(root, 'platforms', 'evm-gateway.json'), 'utf8')).gatewayUrl;
    return typeof g === 'string' ? g.trim().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}
const gateway = configuredGateway();
const gatewayHost = gateway ? new URL(gateway).host : '';
// The public client token a gateway build sends as X-Satori-Client. Read for
// ONE purpose: probing the gateway directly from node, so a failing Epix check
// can say whether the wallet is wrong or the gateway simply has no epix route
// yet. Not a secret (it ships inside the extension bundle).
function configuredClientToken() {
  if (process.env.EVM_CLIENT_TOKEN !== undefined) return process.env.EVM_CLIENT_TOKEN.trim();
  try {
    const t = JSON.parse(readFileSync(path.join(root, 'platforms', 'evm-gateway.json'), 'utf8')).clientToken;
    return typeof t === 'string' ? t.trim() : '';
  } catch {
    return '';
  }
}
const clientToken = configuredClientToken();
const manifest = JSON.parse(readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
const hostPerms = manifest.host_permissions ?? [];
const isDevShape = hostPerms.some((h) => h.includes('mainnet.base.org'));
const isGatewayShape = !!gatewayHost && hostPerms.some((h) => h.includes(gatewayHost));
if (!isDevShape && !isGatewayShape) {
  console.error('dist/chrome is not an EVM build. Run `npm run build:evm` first.');
  process.exit(2);
}

// Does this build read through an Alchemy-shaped endpoint (Alchemy first,
// history on every chain, Import tokens)? Read from the emitted JS, so the
// smoke asserts what the package actually does rather than what the
// workstation has configured. Two shapes: the direct Alchemy URL (dev key), or
// the gateway route (`<gateway>/evm/<chain>/rpc`), which is Alchemy-shaped too.
const assetsDir = path.join(distDir, 'assets');
const jsBlobs = readdirSync(assetsDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(path.join(assetsDir, f), 'utf8'));
const hasDirectAlchemy = jsBlobs.some((t) => t.includes('.g.alchemy.com/v2/'));
const hasGatewayRoute = !!gateway && jsBlobs.some((t) => t.includes(gateway));
const withAlchemy = hasDirectAlchemy || hasGatewayRoute;
console.log(
  hasGatewayRoute
    ? `build: EVM gateway (${gatewayHost}, Alchemy-shaped, no client key)`
    : withAlchemy
      ? 'build: dev provider key present (Alchemy)'
      : 'build: public endpoints only',
);

// PUBLIC BIP39 test vector; its EVM account is 0x9858EfFD232B4033E47d90003D41EC34EcaEda94.
const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const RECIPIENT = '0x3535353535353535353535353535353535353535';

// Headless by default (that is how the gate runs it). SMOKE_HEADED=1 opens a
// real window, which is the only way to SEE a Chromium scrollbar: headless
// Chromium paints overlay scrollbars that take no layout width and are absent
// from a screenshot, so the popup's asset-list scrollbar can only be captured
// from a headed run. Every check in this file passes in both modes.
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: process.env.SMOKE_HEADED !== '1',
  viewport: { width: 400, height: 620 },
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
});

async function extId() {
  const w = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  return new URL(w.url()).host;
}
const id = await extId();

// ---------------------------------------------------------------------------
// Owner-authored notifications: SEEDED, never live.
//
// The gateway serves zero or one real notice at any moment and its image routes
// may not be deployed yet, so a check that depended on live content would prove
// nothing on a good day and fail on a bad one. Every notification case below is
// driven by intercepting `<gateway>/notifications` and answering with a fixed
// document. `notifFeed` is what the route serves; changing it and reloading the
// page is how a case is set up. `/notifications/img/<id>` is answered with a
// real PNG (the extension's own 128px icon), which is what makes the CSP check
// meaningful: an extension page's img-src is enforced by the RENDERER before
// the request leaves it, so a policy that blocked the gateway host would fire a
// securitypolicyviolation and this route would never even be reached.
// ---------------------------------------------------------------------------
const NOTIF_IMAGE_ID = '0123456789abcdef0123456789abcdef';
const NOTIF_IMAGE_PATH = `/notifications/img/${NOTIF_IMAGE_ID}`;
const notifImagePng = readFileSync(path.join(root, 'public', 'icons', 'icon128.png'));
let notifFeed = { notifications: [] };
if (gateway) {
  await context.route(`${gateway}/notifications`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
      body: JSON.stringify(notifFeed),
    }),
  );
  await context.route(`${gateway}/notifications/img/*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
      body: notifImagePng,
    }),
  );
}
// Content Security Policy violations, collected from every page in the context.
// The banner's image is loaded from the gateway host, which the extension_pages
// policy has to allow explicitly (img-src is NOT unconstrained: it is
// `'self' data: blob:` plus the gateway). If that allowance is ever dropped,
// this array is where it shows up.
await context.addInitScript(() => {
  const w = /** @type {Record<string, unknown>} */ (globalThis);
  w.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    /** @type {string[]} */ (w.__cspViolations).push(`${e.violatedDirective} <- ${e.blockedURI}`);
  });
});

const page = await context.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/error|fail|refused/i.test(t)) console.log('  [page]', t.slice(0, 160));
});
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0].slice(0, 160)));

// Every URL the popup asks for, so the price path can be asserted rather than
// assumed: a gateway build must ask <gateway>/prices and must ask NO exchange
// directly. Recorded on the CONTEXT, not just the page, so a request the
// service worker makes is seen too.
const requested = [];
const recordRequest = (r) => requested.push(r.url());
context.on('request', recordRequest);
page.on('request', recordRequest);
const askedFor = (needle) => requested.filter((u) => u.includes(needle));
const byId = (t) => page.getByTestId(t);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};
const shot = (name) => page.screenshot({ path: path.join(shotsDir, name) });

try {
  await page.goto(`chrome-extension://${id}/index.html`);
  await byId('live-onboarding').waitFor({ timeout: 15_000 });

  // Import the vector seed as an EVM account on Base.
  await page.getByRole('button', { name: /Import recovery phrase/i }).click();
  await byId('live-import-input').waitFor({ timeout: 10_000 });
  await byId('live-import-chain-evm:base').waitFor({ timeout: 10_000 });
  check(true, 'chain picker offers Base (evm:base) in an --evm build');
  await byId('live-import-chain-evm:base').click();
  check((await byId('live-import-chain-evm-note').count()) === 1, 'picker explains one EVM account spans every EVM chain');
  await shot('evm-import-picker.png');
  await byId('live-import-input').fill(VECTOR_MNEMONIC);
  await byId('live-password').fill('live-pass-1234');
  const confirm = byId('live-password-confirm');
  if (await confirm.count()) await confirm.fill('live-pass-1234');
  await byId('live-import-submit').click();

  await byId('live-home').waitFor({ timeout: 25_000 });
  const addr = (await byId('live-address').innerText()).trim();
  // The home truncates the address (0x9858Ef…aEda94); the receive screen shows it whole.
  check(
    addr.startsWith(VECTOR_ADDRESS.slice(0, 8)) && addr.endsWith(VECTOR_ADDRESS.slice(-6)),
    `EVM account address is the MetaMask address for the words: ${addr}`,
  );

  // Balances over JSON-RPC (real Base): wait for the first read to land (the
  // LED turns green and the balance hero replaces its skeleton).
  // `expect` is a token/asset text that only the target chain's read produces,
  // so a stale green LED from the previous chain cannot satisfy the wait.
  const waitSynced = async (expect) => {
    const matches = (text) => (typeof expect === 'function' ? expect(text) : expect.test(text));
    for (let i = 0; i < 40; i++) {
      const led = (await byId('live-led').getAttribute('data-state').catch(() => '')) || '';
      const text = await byId('live-home').innerText().catch(() => '');
      // `matches` may be ASYNC (a predicate that asks the DOM a second question,
      // e.g. "is the row itself on screen yet"); awaiting a plain boolean yields
      // itself, so every existing caller is unchanged.
      if (led === 'connected' && (await byId('live-balance-hero').count()) === 1 && (await matches(text)))
        return led;
      await page.waitForTimeout(500);
    }
    return (await byId('live-led').getAttribute('data-state').catch(() => '')) || '';
  };
  const led = await waitSynced(/USDC/);
  check(led === 'connected', `balances read over JSON-RPC, LED ${led}`);
  const homeText = await byId('live-home').innerText();
  check(/Base/.test(homeText), 'home names the chain: Base');
  check(/\bETH\b/.test(homeText), 'home shows the native ETH row');
  check(/USDC/.test(homeText), 'home shows the default USDC token row');
  check(/Add token/i.test(homeText), 'Add token is offered on an EVM chain (by contract address)');
  // Base has no native staking, so Home must look exactly as it did before the
  // staking entry existed: no action button and no summary line. Asserted by
  // TESTID, not by hunting the word "stake" in the screen text.
  check(
    (await byId('live-action-stake').count()) === 0 && (await byId('live-stake-summary').count()) === 0,
    'no staking affordance on a chain without native staking (Base)',
  );
  await shot('evm-home-base.png');

  // PRICES: one host. The wallet asks <gateway>/prices and nothing else — the
  // gateway talks to CoinGecko and SafeTrade server-side. A build with no
  // gateway configured is the dev shape and keeps the direct sources, so the
  // assertion flips rather than being skipped.
  {
    let priceCalls = [];
    for (let i = 0; i < 30; i++) {
      priceCalls = askedFor('/prices');
      if (priceCalls.length > 0) break;
      await page.waitForTimeout(500);
    }
    if (gateway) {
      check(
        priceCalls.some((u) => u.startsWith(`${gateway}/prices`)),
        `prices are read from the gateway: ${priceCalls[0] ?? 'NO /prices request was made'}`,
      );
      const direct = [...askedFor('api.coinex.com'), ...askedFor('safe.trade'), ...askedFor('safetrade.com')];
      check(direct.length === 0, `no direct exchange request from a gateway build${direct.length ? `: ${direct.join(', ')}` : ''}`);
    } else {
      check(askedFor(`/prices`).length === 0, 'a build with no gateway does not ask for /prices (dev shape)');
    }
  }

  // The header itself, in MetaMask's order: the network on the LEFT, the wallet
  // in the CENTRE, the icon actions on the RIGHT. Measured (the three slots may
  // not intersect at the popup's 400px either) and then photographed on its own,
  // because "they overlap" is what this row was reorganised to stop.
  const header = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    return {
      chain: box('[data-testid="live-chain-switcher"]'),
      wallet: box('[data-testid="live-wallet-switcher"]'),
      actions: box('.app-header .header-actions'),
      row: box('.app-header'),
      // The wallet SLOT, not the switcher button: the address moved out of the
      // button into its own copy button beside it (a button cannot nest in a
      // button, and clicking the address must copy without opening the menu).
      walletText: (document.querySelector('.app-header')?.innerText || '').replace(/\n/g, ' / '),
      addressTag: document.querySelector('[data-testid="live-address"]')?.tagName || '',
      addressInsideSwitcher: !!document.querySelector(
        '[data-testid="live-wallet-switcher"] [data-testid="live-address"]',
      ),
    };
  });
  check(
    Boolean(header.chain && header.wallet && header.actions) &&
      header.chain.right <= header.wallet.left &&
      header.wallet.right <= header.actions.left,
    `header at 400px: network | wallet | actions do not intersect (chain ${header.chain?.right}, wallet ${header.wallet?.left}-${header.wallet?.right}, actions ${header.actions?.left})`,
  );
  check(/0x/.test(header.walletText), `wallet switcher names the account and its address: "${header.walletText}"`);
  check(
    header.addressTag === 'BUTTON' && !header.addressInsideSwitcher,
    `the address is its own copy button beside the switcher, not inside it (<${header.addressTag.toLowerCase()}>)`,
  );
  await page.screenshot({
    path: path.join(shotsDir, 'evm-home-header.png'),
    clip: { x: 0, y: 0, width: 400, height: (header.row?.bottom ?? 56) + 4 },
  });

  // Token management: add WETH (the predeploy at 0x4200…0006) by contract
  // address; symbol and decimals come from the chain, the row appears at 0.
  await byId('live-add-asset').click();
  await byId('live-add-asset-input').waitFor({ timeout: 5_000 });
  await byId('live-add-asset-input').fill('0x4200000000000000000000000000000000000006');
  await byId('live-add-asset-submit').click();
  let wethRow = false;
  for (let i = 0; i < 40; i++) {
    if (/\bWETH\b/.test(await byId('live-home').innerText())) {
      wethRow = true;
      break;
    }
    if (await byId('live-add-asset-error').count()) {
      console.log('  [add token error]', await byId('live-add-asset-error').innerText());
      break;
    }
    await page.waitForTimeout(500);
  }
  check(wethRow, 'a token added by contract address shows with the symbol the chain reports (WETH)');
  await shot('evm-home-base-weth.png');

  // Search by name/symbol: the same field takes "cbBTC" (Coinbase Wrapped BTC,
  // a real Base token) and lists matches from the chain's public token list.
  // Clicking a row adds it by the CONTRACT ADDRESS behind it, so the symbol on
  // the home row is still the one the chain reported, not the list's.
  await byId('live-add-asset').click();
  await byId('live-add-asset-input').waitFor({ timeout: 5_000 });
  /** Type a query and wait for a result row whose text matches `want`. The
   *  previous query's rows stay on screen until the new answer lands, so
   *  waiting for "any row" would happily match a stale one. */
  const searchTokens = async (query, want) => {
    await byId('live-add-asset-input').fill(query);
    for (let i = 0; i < 40; i++) {
      const rows = await page.locator('[data-testid^="live-token-search-result-"]').all();
      const texts = await Promise.all(rows.map((r) => r.innerText()));
      const hit = texts.findIndex((t) => want.test(t));
      if (hit >= 0) return { rows, texts, hit };
      if (await byId('live-token-search-error').count()) {
        console.log('  [token search error]', await byId('live-token-search-error').innerText());
        break;
      }
      await page.waitForTimeout(500);
    }
    return { rows: [], texts: [], hit: -1 };
  };
  // A broad query first, so the screenshot shows a real list of candidates.
  const broad = await searchTokens('usd', /USD/i);
  check(broad.hit >= 0, `searching "usd" lists matches from the token list (${broad.rows.length} rows)`);
  console.log('  rows for "usd":', broad.texts.map((t) => t.replace(/\n/g, ' ')).join(' | '));
  await page.screenshot({ path: path.join(shotsDir, 'evm-token-search.png') });
  // Then the exact token this check adds.
  const exact = await searchTokens('cbBTC', /cbBTC/i);
  const cbbtcRow = exact.hit >= 0 ? exact.rows[exact.hit] : null;
  check(cbbtcRow !== null, `a result names cbBTC: ${exact.texts.map((t) => t.replace(/\n/g, ' ')).join(' | ')}`);
  if (cbbtcRow) {
    await cbbtcRow.click();
    let cbbtcAdded = false;
    for (let i = 0; i < 40; i++) {
      if (await byId('live-asset-row-cbBTC').count()) {
        cbbtcAdded = true;
        break;
      }
      if (await byId('live-add-asset-error').count()) {
        console.log('  [add token error]', await byId('live-add-asset-error').innerText());
        break;
      }
      await page.waitForTimeout(500);
    }
    check(cbbtcAdded, 'clicking a search result adds that token by contract: the cbBTC row is on Home');
    await shot('evm-home-base-cbbtc.png');
  }
  // A successful add closes the modal itself; close it here only if it is still
  // open (a failed add), so the Import section below can reopen it from Home.
  if (await byId('live-add-asset-modal').count()) {
    await page.getByRole('button', { name: /^Cancel$/ }).click().catch(() => {});
  }

  // Import lives in the Add token modal (EVM, keyed builds): "Import trusted"
  // (only tokens the wallet will vouch for under the rule in
  // services/chain/evm/tokenTrust.ts: in the chain's public token list AND
  // carrying a registry mark) and "Import all".
  await byId('live-add-asset').click();
  await byId('live-add-asset-input').waitFor({ timeout: 5_000 });
  if (withAlchemy) {
    check((await byId('live-import-section').count()) === 1, 'Add token offers Import trusted / Import all (provider token index available)');
    const before = await page.locator('[data-testid^="live-asset-row-"]').count();
    await byId('live-import-trusted').click();
    // The import ends in ONE of two places: the note, or the error banner. This
    // used to wait only for the note, so a refusal timed out after 40 s and was
    // reported as an empty string: a failing check that named nothing.
    let note = '';
    // 90 s, not 40. "Import trusted" fetches the chain's public token list
    // through the gateway before it will vouch for anything, and 40 s was not
    // enough for it twice on 2026-08-26.
    for (let i = 0; i < 180; i++) {
      if (await byId('live-import-note').count()) {
        note = (await byId('live-import-note').innerText()).trim();
        break;
      }
      if (await byId('live-add-asset-error').count()) {
        note = `ERROR BANNER: ${(await byId('live-add-asset-error').innerText()).trim()}`;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!note) note = '(nothing appeared within 90 s)';
    // Any of: it imported some, there was nothing new, it could vouch for none
    // of them, or (a gateway build with the token list down) it refused to guess.
    check(
      /Imported \d+ token|No new tokens|cannot vouch for any of the tokens|token list is unreachable/.test(note),
      `Import trusted reports: ${note.slice(0, 140)}`,
    );
    await shot('evm-import-trusted.png');
    await byId('live-import-all').click();
    let noteAll = '';
    for (let i = 0; i < 80; i++) {
      const n = (await byId('live-import-note').count()) ? (await byId('live-import-note').innerText()).trim() : '';
      if (n && n !== note) {
        noteAll = n;
        break;
      }
      await page.waitForTimeout(500);
    }
    check(/Imported \d+ token/.test(noteAll), `Import all reports what it added: ${noteAll.slice(0, 120)}`);
    await page.getByRole('button', { name: /^Cancel$/ }).click().catch(() => {});
    let rowsAfter = before;
    for (let i = 0; i < 40; i++) {
      rowsAfter = await page.locator('[data-testid^="live-asset-row-"]').count();
      if (rowsAfter > before) break;
      await page.waitForTimeout(500);
    }
    check(rowsAfter > before, `the asset list grew after import (${before} -> ${rowsAfter} rows)`);
    // Unlisted-token warning: "Import all" brought tokens the wallet will not
    // vouch for; once the trust probe answers, each carries a filled "unlisted"
    // pill that explains itself on click.
    let badges = 0;
    for (let i = 0; i < 60; i++) {
      badges = await page.locator('[data-testid^="live-untrusted-"]:not([data-testid^="live-untrusted-note-"]):not([data-testid^="live-untrusted-banner-"])').count();
      if (badges > 0) break;
      await page.waitForTimeout(500);
    }
    check(badges > 0, `unlisted imported tokens carry the unlisted pill (${badges} on screen)`);

    // --- ORDER of the imported list ------------------------------------------
    // "Import all" is exactly the case plain alphabetical order got wrong:
    // airdropped spam named "(t.me/s/US_POOL) *claim…" and "$TRUMP … Claim" sorts
    // before every letter, so it used to sit directly under ETH, above what the
    // account really holds. Asserted only AFTER the trust badges land, because
    // the list re-sorts when those verdicts arrive.
    const rows = await page.locator('[data-testid^="live-asset-row-"]').all();
    const listed = [];
    for (const row of rows) {
      const symbol = (await row.getAttribute('data-testid')).replace('live-asset-row-', '');
      const balance = (await row.locator('[data-testid^="live-balance-"]').first().innerText()).trim();
      const unlisted = (await row.locator('[data-testid^="live-untrusted-"]').count()) > 0;
      listed.push({ symbol, zero: balance === '0', unlisted, spammy: /^[($]/.test(symbol) });
    }
    // Symbols of airdropped spam are long and contain "|" themselves, so print
    // one per line rather than joining them into an unreadable soup.
    console.log('  order after import (rank: 0 native, 1 valued, 2 held, 3 unlisted, 4 empty):');
    for (const [i, r] of listed.entries()) {
      const rank = i === 0 ? 0 : r.zero ? 4 : r.unlisted ? 3 : 2;
      console.log(`    ${String(i).padStart(2)} rank ${rank} ${r.zero ? '  0  ' : 'held '} ${r.symbol.slice(0, 60)}`);
    }
    check(listed[0]?.symbol === 'ETH', `the native coin is still first (${listed[0]?.symbol})`);
    // The native row is excluded from both rules below: it is pinned to the top
    // by design and is itself empty on this unfunded vector address.
    const tokens = listed.slice(1);
    const lastRealHolding = tokens.reduce((acc, r, i) => (!r.zero && !r.spammy && !r.unlisted ? i : acc), -1);
    const firstSpam = tokens.findIndex((r) => r.spammy);
    check(
      firstSpam === -1 || firstSpam > lastRealHolding,
      `no "(" / "$" row sorts above a real holding (first spammy row ${firstSpam}, last real holding ${lastRealHolding})`,
    );
    const firstZero = tokens.findIndex((r) => r.zero);
    check(
      firstZero === -1 || tokens.slice(firstZero).every((r) => r.zero),
      'zero balances are last: nothing with a balance sorts below an empty row',
    );
    // The whole ordering rule in one assertion: ranks never go back up the list.
    // (Rank 1, a holding with a known USD value, needs a price feed this build
    // has for no ERC-20, so it cannot appear here — the unit tests cover it.)
    const ranks = tokens.map((r) => (r.zero ? 4 : r.unlisted ? 3 : 2));
    check(
      ranks.every((rank, i) => i === 0 || ranks[i - 1] <= rank),
      `held > unlisted > empty holds across the whole list (ranks ${ranks.join('')})`,
    );
    await shot('evm-home-base-imported.png');
    // THE 2026-08-25 FIX, in one picture: the row for the token that put a green
    // check inside its own symbol. The check must not be drawn, and the wallet's
    // own filled "unlisted" pill must be the loudest thing on the row. Scrolled
    // to, because on this account it sits well down a 26-row list.
    const badgedRow = page.locator('[data-testid^="live-asset-row-"]').filter({ hasText: 'www.badrp.co' }).first();
    if (await badgedRow.count()) {
      await badgedRow.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const drawn = (await badgedRow.innerText()).replace(/\n/g, ' ');
      check(!/\u{2705}/u.test(drawn), `the token's own green check is not drawn (row reads "${drawn}")`);
      check(/unlisted/i.test(drawn), "the wallet's unlisted pill is on that row instead");
      await shot('evm-unlisted-sanitised-symbol.png');
    }
    if (badges > 0) {
      const badge = page.locator('[data-testid^="live-untrusted-"]:not([data-testid^="live-untrusted-note-"]):not([data-testid^="live-untrusted-banner-"])').first();
      const sym = (await badge.getAttribute('data-testid')).replace('live-untrusted-', '');
      // The asset row that holds this badge, found by walking up from the badge
      // rather than by interpolating `sym` into a selector: a spam token names
      // itself things like "(t.me/s/US_POOL) *claim until 24.02.26", and those
      // characters would break a data-testid match. Note and banner are located
      // by prefix for the same reason.
      const row = badge.locator('xpath=ancestor-or-self::*[starts-with(@data-testid,"live-asset-row-")]').first();
      // The note is a portal that closes on any outside click or scroll, and a
      // background refresh tick can re-render the row right after the click, so
      // poll for it and retry the click once rather than reading the count on
      // the same frame.
      const note = page.locator('[data-testid^="live-untrusted-note-"]');
      let noteText = '';
      for (let attempt = 0; attempt < 2 && !noteText; attempt++) {
        await badge.click();
        try {
          await note.first().waitFor({ state: 'visible', timeout: 2_000 });
          noteText = await note.first().innerText();
        } catch { /* retry once */ }
      }
      check(/Satori GO cannot vouch for/.test(noteText), `clicking the pill explains what the wallet does not know (${sym})`);
      // The pill has to read as the WALLET, not as an icon a token can out-shout
      // with a check mark inside its own symbol.
      check(/unlisted/i.test(await badge.innerText()), 'the pill carries the word "unlisted", not only an icon');
      await shot('evm-untrusted-badge.png');
      if (await note.count()) await badge.click();
      // The same disclaimer on the asset detail and the send form for that token.
      // Clicked near the row's LEFT EDGE (its coin mark), not its centre: the
      // unlisted pill is an interactive child that now sits close to the middle
      // of the row, and a centre click would toggle the note instead of opening
      // the token.
      await row.click({ position: { x: 12, y: 12 } });
      await byId('live-asset-detail').waitFor({ timeout: 5_000 });
      check((await page.locator('[data-testid^="live-untrusted-banner-"]').count()) >= 1, `asset detail for ${sym} shows the untrusted-token disclaimer`);
      await byId('live-asset-detail-send').click();
      await byId('live-send-to').waitFor({ timeout: 5_000 });
      check((await page.locator('[data-testid^="live-untrusted-banner-"]').count()) >= 1, `send screen for ${sym} shows the untrusted-token disclaimer`);
      await page.waitForTimeout(800); // let the screen-enter transition finish before the shot
      await shot('evm-untrusted-send.png');
      await page.getByRole('button', { name: /Back/i }).first().click();
      await byId('live-asset-detail').waitFor({ timeout: 5_000 });
      await page.getByRole('button', { name: /Back/i }).first().click();
      await byId('live-home').waitFor({ timeout: 5_000 });
    }
  } else {
    check((await byId('live-import-section').count()) === 0, 'no import section without a provider token index');
    await page.getByRole('button', { name: /^Cancel$/ }).click().catch(() => {});
  }

  // History (phase 4): Base has a keyless indexer (Blockscout) and the vector
  // account has real history there, so Activity must list rows with no warning.
  await byId('live-tab-activity').click();
  let rows = 0;
  for (let i = 0; i < 40; i++) {
    rows = await page.locator('[data-testid^="live-tx-row-"]').count();
    if (rows > 0) break;
    await page.waitForTimeout(500);
  }
  check(rows > 0, `Base activity lists indexed transactions (${rows} rows on screen)`);
  check((await byId('live-history-warning').count()) === 0, 'no history warning on Base (indexer answered)');
  // The Activity tab's own paging controls (the same ActivityPager the token
  // screen now uses, so a refactor of one cannot silently drop the other).
  {
    const pager = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      return {
        present: !!q('[data-testid="activity-pager"]'),
        info: q('[data-testid="activity-page-info"]')?.textContent?.trim() ?? null,
        next: !!q('[data-testid="activity-page-next"]'),
      };
    });
    check(
      rows < 10 || (pager.present && pager.next && /page \d+ of \d+/.test(pager.info ?? '')),
      `the Activity tab still pages its rows (${pager.info ?? 'one page'})`,
    );
  }
  // Day headers between the rows ("Today" / "Yesterday" / "14 Aug 2026"). Every
  // row on the page belongs to one, so there is at least one header and never
  // more headers than rows.
  const dayHeaders = await page.locator('[data-testid^="live-activity-day-"]').allInnerTexts();
  check(
    dayHeaders.length > 0 && dayHeaders.length <= rows,
    `activity is grouped by day (${dayHeaders.length} header(s) over ${rows} rows: ${dayHeaders.join(' | ')})`,
  );
  check(
    dayHeaders.every((h) => /^(Today|Yesterday|\d{1,2} [A-Za-z]{3} \d{4}|Pending)$/i.test(h.trim())),
    `day headers read as dates or Today/Yesterday/Pending (${dayHeaders.join(' | ')})`,
  );
  await shot('evm-activity-base.png');
  await byId('live-tab-assets').click();

  // Accounts on ONE seed (the EVM accounts design notes): the same words carry
  // Account 1, 2, ... exactly as MetaMask does. Adding one must land on it
  // WITHOUT asking for the password again (same seed, same session), and
  // switching back must return the first address just as silently.
  await byId('live-wallet-switcher').click();
  await byId('live-add-account').waitFor({ timeout: 10_000 });
  const groupHeading = await page
    .locator('[data-testid^="live-wallet-group-"]')
    .first()
    .innerText()
    .catch(() => '');
  check(
    /Seed/i.test(groupHeading),
    `switcher groups the accounts under their seed: ${groupHeading.replace(/\n/g, ' ').slice(0, 60)}`,
  );
  await byId('live-add-account').click();
  await byId('live-home').waitFor({ timeout: 25_000 });
  let accountName = '';
  for (let i = 0; i < 40; i++) {
    accountName = ((await byId('live-wallet-switcher').innerText().catch(() => '')) || '').trim();
    if (/Account 2/.test(accountName)) break;
    await page.waitForTimeout(500);
  }
  check(/Account 2/.test(accountName), `header names the new account: ${accountName.replace(/\n/g, ' ')}`);
  const addrAccount2 = (await byId('live-address').innerText()).trim();
  check(
    addrAccount2 !== addr,
    `Account 2 is a different address of the same seed: ${addrAccount2} (Account 1 was ${addr})`,
  );
  check(
    (await byId('live-lock').count()) === 0 && (await byId('live-unlock').count()) === 0,
    'adding an account did NOT lock the wallet (same seed, no re-unlock)',
  );
  // The switcher, open, with both accounts under one seed heading.
  await byId('live-wallet-switcher').click();
  await byId('live-wallet-item-1').waitFor({ timeout: 10_000 });
  check(
    (await page.locator('button[data-testid^="live-wallet-item-"]').count()) >= 2,
    'switcher lists both accounts of the seed',
  );
  await page.waitForTimeout(400); // let the popover's transition finish before the picture
  await shot('evm-accounts-switcher.png');
  // Inline rename in the switcher: the pencil on the ACTIVE (new) account's row,
  // type a name, Enter; the header follows, nothing locks, nothing switches.
  const activeRow = page.locator('button[data-testid^="live-wallet-item-"]').filter({ hasText: accountName.split('\n')[0].trim() }).first();
  const activeRowId = await activeRow.getAttribute('data-testid');
  const activeRowIndex = activeRowId ? activeRowId.replace('live-wallet-item-', '') : '';
  await byId(`live-wallet-rename-${activeRowIndex}`).click();
  await byId(`live-wallet-rename-input-${activeRowIndex}`).fill('Trading');
  await byId(`live-wallet-rename-input-${activeRowIndex}`).press('Enter');
  let renamedHeader = '';
  for (let i = 0; i < 20; i++) {
    renamedHeader = ((await byId('live-wallet-switcher').innerText().catch(() => '')) || '').trim();
    if (/Trading/.test(renamedHeader)) break;
    await page.waitForTimeout(250);
  }
  check(/Trading/.test(renamedHeader), `renamed the account inline from the switcher: header now "${renamedHeader.replace(/\n/g, ' ')}"`);
  check((await byId(`live-wallet-item-${activeRowIndex}`).innerText()).includes('Trading'), 'the renamed row shows the new name');
  // Long list: the search box filters by name (and address), ignoring folding.
  // It only renders once the list is long, which needs the seed's accounts to
  // have been discovered; a throttled provider legitimately leaves it absent.
  // Report that as a failed CHECK rather than letting a locator timeout abort
  // the run and take every check after this line with it.
  if (await byId('live-wallet-search').count()) {
    await byId('live-wallet-search').fill('Trading');
    await page.waitForTimeout(200);
    const filteredRows = await page.locator('button[data-testid^="live-wallet-item-"]').count();
    check(filteredRows === 1 && (await page.locator('button[data-testid^="live-wallet-item-"]').first().innerText()).includes('Trading'), `switcher search narrows 22 accounts to the match (${filteredRows} row)`);
    await byId('live-wallet-search').fill('');
    await page.waitForTimeout(200);
  } else {
    const rowCount = await page.locator('button[data-testid^="live-wallet-item-"]').count();
    check(false, `switcher search box is missing: the account list is only ${rowCount} row(s), so discovery did not enumerate the seed`);
  }
  await page.waitForTimeout(300);
  await shot('evm-accounts-renamed.png');
  // Back to Account 1 — again without a password prompt.
  await byId('live-wallet-item-0').click();
  await byId('live-home').waitFor({ timeout: 25_000 });
  let addrBack = '';
  for (let i = 0; i < 40; i++) {
    addrBack = ((await byId('live-address').innerText().catch(() => '')) || '').trim();
    if (addrBack === addr) break;
    await page.waitForTimeout(500);
  }
  check(addrBack === addr, `switching back shows the first account again: ${addrBack}`);
  check(
    (await byId('live-lock').count()) === 0 && (await byId('live-unlock').count()) === 0,
    'switching between accounts of one seed never asks for the password',
  );
  // Discover accounts: whatever it finds, it must not fail. An unreachable node
  // or a refused batch would surface as the inline "Could not check accounts"
  // note in the picker (or the store error banner) — neither may appear.
  await byId('live-wallet-switcher').click();
  await byId('live-discover-accounts').click({ timeout: 10_000 });
  let discoverError = '';
  for (let i = 0; i < 40; i++) {
    const scanning = await byId('live-discover-accounts').innerText().catch(() => '');
    if (await byId('live-discover-note').count()) {
      const note = (await byId('live-discover-note').innerText()).trim();
      if (/Could not check accounts/i.test(note)) discoverError = note;
      break;
    }
    if (await byId('live-accounts-found').count()) break;
    if (!/Checking accounts/i.test(scanning) && i > 2) break;
    await page.waitForTimeout(500);
  }
  check(discoverError === '', `Discover accounts finished without an error${discoverError ? `: ${discoverError}` : ''}`);
  await page.keyboard.press('Escape');

  // Chain switcher: EVM chains listed as enabled; switching to BNB Chain keeps the account.
  await byId('live-chain-switcher').click();
  await byId('live-chain-list').waitFor({ timeout: 5_000 });
  check((await byId('live-chain-option-evm:base').count()) === 1, 'switcher lists Base');
  check((await byId('live-chain-option-evm:bsc').count()) === 1, 'switcher lists BNB Chain');
  check((await byId('live-chain-option-evm:ethereum').count()) === 1, 'switcher lists Ethereum (phase 6, first chain)');
  check((await byId('live-chain-option-evm:epix').count()) === 1, 'switcher lists Epix (phase 6, first chain not on Alchemy)');
  await page.waitForTimeout(400); // let the popover's transition finish before the picture
  await shot('evm-chain-switcher.png');
  // Eleven chains do not fit the 600px popup: the dropdown must scroll inside
  // the viewport instead of running off the bottom (owner, 2026-08-20).
  const chainMenu = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="live-chain-dropdown"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { bottom: Math.round(r.bottom), scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: cs.overflowY, vh: window.innerHeight };
  });
  check(
    !!chainMenu && chainMenu.bottom <= chainMenu.vh && chainMenu.overflowY === 'auto' && (chainMenu.scrollH <= chainMenu.clientH + 1 || chainMenu.clientH < chainMenu.scrollH),
    `chain dropdown stays inside the popup and scrolls when taller (bottom ${chainMenu?.bottom}/${chainMenu?.vh}, ${chainMenu?.clientH}/${chainMenu?.scrollH}px)`,
  );
  if (chainMenu && chainMenu.scrollH > chainMenu.clientH) {
    await page.evaluate(() => { const el = document.querySelector('[data-testid="live-chain-dropdown"]'); el.scrollTop = el.scrollHeight; });
    check(await byId('live-chain-option-evm:epix').isVisible(), 'the last chain (Epix) is reachable by scrolling the dropdown');
  }
  await byId('live-chain-option-evm:bsc').click();
  const ledBnb = await waitSynced(/USDT/);
  const bnbText = await byId('live-home').innerText();
  check(/BNB Chain/.test(bnbText) && ledBnb === 'connected', `switched to BNB Chain within the same account (LED ${ledBnb})`);
  check(/USDT/.test(bnbText), 'BNB Chain shows its default USDT token row');
  const addrAfter = (await byId('live-address').innerText()).trim();
  check(addrAfter.toLowerCase() === addr.toLowerCase(), 'address unchanged after the chain switch (one account, every EVM chain)');
  await shot('evm-home-bsc.png');

  // Ethereum (phase 6, first chain): switch within the same account, balances
  // over the real mainnet RPC, the default USDC/USDT rows, the same address,
  // and (keyed) history through the Transfers API.
  await byId('live-chain-switcher').click();
  await byId('live-chain-option-evm:ethereum').click();
  const ledEth = await waitSynced(/USDC/);
  const ethText = await byId('live-home').innerText();
  check(/Ethereum/.test(ethText) && ledEth === 'connected', `switched to Ethereum within the same account (LED ${ledEth})`);
  check(/USDC/.test(ethText) && /USDT/.test(ethText), 'Ethereum shows its default USDC and USDT rows');
  const addrEth = (await byId('live-address').innerText()).trim();
  check(addrEth.toLowerCase() === addr.toLowerCase(), 'address unchanged on Ethereum (one account, every EVM chain)');
  // Switching ACCOUNTS never switches the chain: pick another account of the
  // seed while on Ethereum and assert the chain pill still says Ethereum.
  await byId('live-wallet-switcher').click();
  await byId('live-wallet-dropdown').waitFor({ timeout: 5_000 });
  const activeAccountName = (await byId('live-wallet-switcher').innerText()).split('\n')[0].trim();
  const otherRow = page.locator('button[data-testid^="live-wallet-item-"]').filter({ hasNotText: activeAccountName }).first();
  if (await otherRow.count()) {
    await otherRow.click();
    await byId('live-home').waitFor({ timeout: 25_000 });
    for (let i = 0; i < 20; i++) {
      if (/Ethereum/.test((await byId('live-chain-switcher').innerText().catch(() => '')) || '')) break;
      await page.waitForTimeout(300);
    }
    check(/Ethereum/.test(await byId('live-chain-switcher').innerText()), 'switching the account kept the chain (still Ethereum)');
    // Back to the vector account for everything below.
    await byId('live-wallet-switcher').click();
    await byId('live-wallet-dropdown').waitFor({ timeout: 5_000 });
    const backRow = page.locator('button[data-testid^="live-wallet-item-"]').filter({ hasText: '0x9858' }).first();
    await backRow.click();
    await byId('live-home').waitFor({ timeout: 25_000 });
    await waitSynced(/USDC/);
  }
  await shot('evm-home-ethereum.png');
  if (withAlchemy) {
    await byId('live-tab-activity').click();
    let ethRows = 0;
    for (let i = 0; i < 40; i++) {
      ethRows = await page.locator('[data-testid^="live-tx-row-"]').count();
      if (ethRows > 0) break;
      await page.waitForTimeout(500);
    }
    check(ethRows > 0, `Ethereum activity lists transfers through the provider (${ethRows} rows)`);
    await shot('evm-activity-ethereum.png');
    await byId('live-tab-assets').click();
  }

  // -------------------------------------------------------------------------
  // Epix (phase 6, second chain, and the FIRST one Alchemy does not serve).
  //
  // In a gateway build every EVM request goes to the one permitted host, so
  // Epix works only once the gateway carries an `epix` chain: a "direct
  // upstream" /rpc route to evmrpc.epix.zone and an /indexer proxy in front of
  // scan.epix.zone. Probe both from here FIRST, so a failure below reads as
  // "the gateway has no epix route yet" rather than as a wallet bug. The
  // probe is diagnostic only: it never turns a failing check into a pass.
  // -------------------------------------------------------------------------
  let epixNote = '';
  if (hasGatewayRoute) {
    const authHeaders = clientToken ? { 'X-Satori-Client': clientToken } : {};
    const probe = async (label, url, init) => {
      try {
        const res = await fetch(url, init);
        const body = (await res.text()).slice(0, 160);
        if (!res.ok || /unknown chain|not found/i.test(body)) return `${label} HTTP ${res.status} ${body}`;
        return '';
      } catch (e) {
        return `${label} probe failed: ${String(e).slice(0, 120)}`;
      }
    };
    const rpcProblem = await probe('rpc:', `${gateway}/evm/epix/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    const indexerProblem = await probe(
      'indexer:',
      `${gateway}/evm/epix/indexer?module=account&action=txlist&address=${VECTOR_ADDRESS.toLowerCase()}&sort=desc&page=1&offset=10`,
      { headers: authHeaders },
    );
    if (rpcProblem || indexerProblem) {
      epixNote = `  <-- GATEWAY HAS NO EPIX ROUTE YET (${[rpcProblem, indexerProblem].filter(Boolean).join(' | ')})`;
      console.log(`note: ${gatewayHost} does not route epix yet; the Epix checks below are expected to fail until it does.`);
    }
  }
  /** check(), with the gateway diagnosis appended to anything that fails. */
  const epixCheck = (ok, label) => check(ok, `${label}${ok ? '' : epixNote}`);

  await byId('live-chain-switcher').click();
  await byId('live-chain-option-evm:epix').click();
  // Epix has NO default tokens, so a predicate rather than a regex. The text
  // alone is not enough, and the comment that used to sit here was wrong about
  // why: the hero label flips to "EPIX BALANCE" and the previous chain's rows
  // are dropped in the SAME state update, the one the click applies, so both
  // halves of a text-only predicate can be true one frame after the click,
  // while the read is still in flight and the LED still carries the PREVIOUS
  // chain's "connected". This section measures the ROW, so it waits for the one
  // thing only a landed Epix read produces: the EPIX row in the list.
  const ledEpix = await waitSynced(
    async (t) =>
      /\bEPIX\b/.test(t) && !/USDC|USDT/.test(t) && (await byId('live-balance-EPIX').count()) === 1,
  );
  const epixText = await byId('live-home').innerText();
  epixCheck(/Epix/.test(epixText) && ledEpix === 'connected', `switched to Epix within the same account (LED ${ledEpix})`);
  epixCheck(/\bEPIX\b/.test(epixText), 'Epix shows the EPIX native balance hero');
  epixCheck(
    !/USDC|USDT/.test(epixText),
    'the Epix read REPLACED the previous chain\'s rows (no Ethereum USDC/USDT left on screen)',
  );
  const addrEpix = (await byId('live-address').innerText()).trim();
  epixCheck(addrEpix.toLowerCase() === addr.toLowerCase(), 'address unchanged on Epix (one account, every EVM chain)');
  await shot('evm-home-epix.png');

  // Asset rows: balance, fiat value and the 24h chip share ONE line and must
  // never overlap. An 18-decimal balance printed in full used to push the
  // price under the chip (owner, Epix, 2026-08-21); the list now shows at most
  // six significant digits (formatListAmount) and keeps the full figure in the
  // row's tooltip.
  // Wait for a row to EXIST before measuring one. This check reads the DOM
  // directly, so with no wait it happily measures an empty list and reports
  // "0 rows checked" as a pass-shaped failure whenever the chain read has not
  // landed yet. The assertion below is unchanged; this only stops it asking
  // the question too early.
  await page
    .locator('[data-testid^="live-balance-"]:not([data-testid="live-balance-hero"])')
    .first()
    .waitFor({ state: 'attached', timeout: 20_000 })
    .catch(() => {});
  const rowGeometry = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    };
    const rows = [];
    for (const bal of document.querySelectorAll('[data-testid^="live-balance-"]')) {
      const id = bal.getAttribute('data-testid');
      if (id === 'live-balance-hero') continue;
      const name = id.slice('live-balance-'.length);
      rows.push({
        name,
        text: bal.textContent || '',
        title: bal.getAttribute('title') || '',
        bal: box(bal),
        usd: box(document.querySelector(`[data-testid="live-asset-usd-${name}"]`)),
        chg: box(document.querySelector(`[data-testid="live-asset-change-${name}"]`)),
      });
    }
    return rows;
  });
  const overlapping = rowGeometry.filter(
    (r) => (r.usd && r.usd.left < r.bal.right - 0.5) || (r.chg && r.usd && r.chg.left < r.usd.right - 0.5) || (r.chg && r.chg.left < r.bal.right - 0.5),
  );
  epixCheck(
    rowGeometry.length > 0 && overlapping.length === 0,
    `asset rows keep balance, fiat and 24h chip apart (${rowGeometry.length} rows checked${overlapping.length ? `; overlapping: ${overlapping.map((r) => r.name).join(', ')}` : ''})`,
  );
  const tooManyDigits = rowGeometry.filter((r) => {
    const digits = r.text.replace(/[^0-9]/g, '').replace(/^0+/, '');
    return !r.text.includes(',') && !r.text.startsWith('<') && digits.length > 6;
  });
  epixCheck(
    tooManyDigits.length === 0,
    `list balances carry at most six significant digits${tooManyDigits.length ? ` (violations: ${tooManyDigits.map((r) => `${r.name}=${r.text}`).join(', ')})` : ''}`,
  );
  const squeezedUsd = rowGeometry.filter((r) => r.usd && r.usd.width < 20);
  epixCheck(squeezedUsd.length === 0, `no fiat value is squeezed to nothing${squeezedUsd.length ? ` (${squeezedUsd.map((r) => r.name).join(', ')})` : ''}`);

  // Activity: Epix HAS a history source (its Blockscout, proxied by the
  // gateway), so an account with nothing on chain must show the plain empty
  // state, never the "cannot be listed" notice and never a failing indexer.
  await byId('live-tab-activity').click();
  let epixRows = 0;
  let epixWarning = '';
  for (let i = 0; i < 20; i++) {
    epixRows = await page.locator('[data-testid^="live-tx-row-"]').count();
    if (await byId('live-history-warning').count()) {
      epixWarning = (await byId('live-history-warning').innerText()).trim();
      break;
    }
    if (epixRows > 0) break;
    await page.waitForTimeout(500);
  }
  // A "behind" notice is the indexer doing its job honestly (Epix's Blockscout
  // was 41k blocks behind on 2026-08-20): acceptable. "Cannot be listed" /
  // "refused" / "unreachable" would mean the proxy route is broken.
  const epixLagNotice = /is behind/.test(epixWarning);
  epixCheck(
    epixRows > 0 || epixWarning === '' || epixLagNotice,
    `Epix activity has a history source (${epixRows} rows, warning: ${epixWarning ? epixWarning.slice(0, 90) : 'none'})`,
  );
  // The STAKING LABEL on an Activity row (2026-08-24). The vector account has
  // never staked, so there is nothing to label here and nothing is broadcast to
  // create one: what this can honestly assert is that Activity RENDERS on a
  // staking chain (the label path runs for every row on it), and that any label
  // that does appear carries text rather than an empty element. The rendering
  // itself is pinned in jsdom (LiveHome.stakingActivity.test.tsx).
  const stakingLabels = await page.$$eval('[data-testid^="live-tx-staking-"]', (els) =>
    els.map((el) => (el.textContent || '').trim()),
  );
  epixCheck(
    (await byId('live-activity-list').count()) === 1 && stakingLabels.every((t) => t.length > 0),
    `Epix Activity renders on a staking chain${
      stakingLabels.length ? ` with ${stakingLabels.length} staking label(s): ${stakingLabels.join(', ')}` : ' (the vector account has no staking transactions)'
    }`,
  );
  await shot('evm-activity-epix.png');
  await byId('live-tab-assets').click();

  // -------------------------------------------------------------------------
  // NATIVE STAKING on Epix (cosmos/evm precompiles, 2026-08-24).
  //
  // The LISTS come from the chain's Cosmos REST (LCD). In a gateway build that
  // is <gateway>/evm/epix/rest/..., a route the gateway must carry: probe it
  // from here FIRST so a failing check below reads as "the gateway has no rest
  // route yet" rather than as a wallet bug, exactly as the indexer probe above.
  // The probe is diagnostic: it never turns a failing check into a pass.
  //
  // NOTHING IS BROADCAST. The run goes as far as the review step and asserts
  // the arming control is there; the vector account is unfunded, so the node's
  // honest refusal to simulate is an expected outcome and both are accepted,
  // with the run printing WHICH one it got.
  // -------------------------------------------------------------------------
  let restNote = '';
  if (hasGatewayRoute) {
    const authHeaders = clientToken ? { 'X-Satori-Client': clientToken } : {};
    try {
      const res = await fetch(`${gateway}/evm/epix/rest/cosmos/staking/v1beta1/params`, { headers: authHeaders });
      const body = (await res.text()).slice(0, 160);
      if (!res.ok || !/unbonding_time/.test(body)) {
        restNote = `  <-- GATEWAY HAS NO EPIX REST ROUTE YET (HTTP ${res.status} ${body})`;
      }
    } catch (e) {
      restNote = `  <-- EPIX REST PROBE FAILED (${String(e).slice(0, 120)})`;
    }
    if (restNote) {
      console.log(`note: ${gatewayHost} does not proxy the Epix Cosmos REST yet; the staking checks below are expected to degrade until it does.`);
    }
  }
  const stakeCheck = (ok, label) => check(ok, `${label}${ok ? '' : restNote}`);

  /** Every validator row on screen, in DOM order, with its commission. */
  const readValidatorRows = () =>
    page.$$eval('[data-testid^="live-stake-validator-"]', (els) =>
      els.map((el) => {
        const m = (el.innerText || '').match(/Commission\s+([\d.]+)%/);
        return {
          id: el.getAttribute('data-testid').replace('live-stake-validator-', ''),
          commission: m ? parseFloat(m[1]) : null,
        };
      }),
    );

  // -------------------------------------------------------------------------
  // The HOME entry (owner, 2026-08-24: "stake powinno byc dostepne z glownego
  // ekranu obok send receive"). Same screen as the asset detail's Stake button,
  // one route: this asserts the action is there and that it opens it.
  // -------------------------------------------------------------------------
  const homeStake = (await byId('live-action-stake').count()) === 1;
  stakeCheck(homeStake, 'Epix offers Stake on the home screen, beside Send and Receive');
  // The vector account has nothing delegated, so the hero must carry NO summary
  // line: a fresh account never sees a row of zeros.
  stakeCheck(
    (await byId('live-stake-summary').count()) === 0,
    'no staking summary under the hero for an account with nothing staked',
  );
  await shot('evm-home-epix-stake.png');
  if (homeStake) {
    await byId('live-action-stake').click();
    await byId('live-stake-evm').waitFor({ timeout: 15_000 });
    stakeCheck(true, 'the home Stake action opens the staking screen');

    // Sorting the validator list. Wait for rows (a live REST read) or for the
    // honest "could not be read" notice, then order by commission and check the
    // DOM really came back cheapest first.
    let sortRows = [];
    for (let i = 0; i < 40; i++) {
      sortRows = await readValidatorRows();
      if (sortRows.length > 0) break;
      if (await byId('live-stake-issue').count()) break;
      await page.waitForTimeout(500);
    }
    if (sortRows.length > 0) {
      const defaultPressed = await byId('live-stake-sort-power').getAttribute('aria-pressed');
      stakeCheck(defaultPressed === 'true', 'the validator list opens sorted by voting power');
      await byId('live-stake-sort-commission').click();
      const byCommission = await readValidatorRows();
      const known = byCommission.filter((r) => r.commission !== null);
      const ascending = known.every((r, i) => i === 0 || known[i - 1].commission <= r.commission);
      stakeCheck(
        byCommission.length === sortRows.length && known.length > 0 && ascending,
        `sorting by commission puts the cheapest validator first (${known.map((r) => `${r.commission}%`).slice(0, 5).join(' <= ')})`,
      );
      stakeCheck(
        (await byId('live-stake-sort-commission').getAttribute('aria-pressed')) === 'true',
        'the chosen sort is the pressed one',
      );
      await shot('evm-stake-sorted-commission.png');
      await byId('live-stake-sort-name').click();
      const byName = await readValidatorRows();
      stakeCheck(byName.length === sortRows.length, 'sorting by name keeps every row (a sort, never a filter)');
      await byId('live-stake-sort-power').click();
    } else {
      stakeCheck(
        (await byId('live-stake-issue').count()) > 0,
        'no validators to sort, and the screen says why (the sort control is covered by the unit tests)',
      );
    }
    // Back to Home through the bottom nav for the asset-detail path below.
    await byId('live-tab-assets').click();
    await byId('live-home').waitFor({ timeout: 10_000 });
  }

  // The Stake entry ALSO lives where the pool-staking one lives for EVR: on the
  // asset detail of the asset that can be staked. On a native-staking chain
  // that is the chain's own coin, so open the EPIX row.
  await byId('live-asset-row-EPIX').click();
  await byId('live-asset-detail-receive').waitFor({ timeout: 10_000 });
  const hasStakeButton = (await byId('live-stake-button').count()) === 1;
  stakeCheck(hasStakeButton, 'Epix offers Stake on its native asset (the registry row carries `staking`)');
  if (hasStakeButton) {
    await byId('live-stake-button').click();
    await byId('live-stake-evm').waitFor({ timeout: 15_000 });

    // The validator list is a live REST read: wait for rows or for the honest
    // "could not be read" notice, and say which arrived.
    let validatorRows = 0;
    let stakeIssue = '';
    for (let i = 0; i < 40; i++) {
      validatorRows = await page.locator('[data-testid^="live-stake-validator-"]').count();
      if (validatorRows > 0) break;
      if (await byId('live-stake-issue').count()) {
        stakeIssue = (await byId('live-stake-issue').innerText()).trim();
        break;
      }
      await page.waitForTimeout(500);
    }
    await shot('evm-stake-epix.png');
    stakeCheck(
      validatorRows > 0,
      `Epix lists bonded validators from the chain (${validatorRows} rows${stakeIssue ? `; notice: ${stakeIssue.slice(0, 100)}` : ''})`,
    );
    // Whatever happened, the screen must be HONEST: rows, or a stated reason.
    check(validatorRows > 0 || stakeIssue !== '', 'the Stake screen either lists validators or says why it cannot');

    if (validatorRows > 0) {
      // Delegate: open the form for the first validator, type 0.1 EPIX, reach
      // the review, and check the arming control is present. Nothing is armed.
      await page.locator('[data-testid="live-stake-delegate"]').first().click();
      await byId('live-stake-amount').waitFor({ timeout: 5_000 });
      await byId('live-stake-amount').fill('0.1');
      await byId('live-stake-review-submit').click();

      let reviewed = false;
      let refusal = '';
      for (let i = 0; i < 40; i++) {
        if (await byId('live-stake-review').count()) {
          reviewed = true;
          break;
        }
        if (await byId('live-stake-error').count()) {
          refusal = (await byId('live-stake-error').innerText()).trim();
          break;
        }
        await page.waitForTimeout(500);
      }
      await shot('evm-stake-review-epix.png');
      if (reviewed) {
        const armPresent = (await byId('live-stake-arm-checkbox').count()) === 1;
        const armed = await byId('live-stake-arm-checkbox').getAttribute('aria-checked');
        const confirmDisabled = await byId('live-stake-broadcast').isDisabled();
        check(armPresent, 'the delegate review carries the arming control');
        check(armed === 'false' && confirmDisabled, 'nothing is armed and Confirm is dead until it is (nothing was broadcast)');
        const fee = (await byId('live-stake-review-fee').innerText()).trim();
        const valoper = (await byId('live-stake-review-valoper').innerText()).trim();
        check(/^epixvaloper1/.test(valoper), `the review names the validator address in full (${valoper.slice(0, 20)}...)`);
        console.log(`  [stake review] quoted: ${fee.replace(/\s+/g, ' ')}`);
        await byId('live-stake-review-back').click();
      } else {
        // The vector account holds no EPIX, so "cannot simulate / not enough"
        // from the node is the correct, honest outcome.
        check(
          refusal !== '',
          `the unfunded account got the node's honest refusal instead of a quote: ${refusal.slice(0, 120) || '(nothing shown)'}`,
        );
      }
      // Back to the overview from the form (the review's Back lands here).
      await byId('live-stake-form-back').click();
      await byId('live-stake-evm').waitFor({ timeout: 5_000 });
    }

    // The unbonding note belongs on the Unstake form, and it must carry the
    // CHAIN'S figure. The vector account has no delegation, so there is no
    // Unstake button to press: assert what the screen does show, which is an
    // empty "My stake" section, and check the note's wording where it exists.
    const hasDelegation = (await page.locator('[data-testid^="live-stake-delegation-"]').count()) > 0;
    if (hasDelegation) {
      await page.locator('[data-testid="live-stake-undelegate"]').first().click();
      await byId('live-stake-unbonding-note').waitFor({ timeout: 5_000 });
      const note = (await byId('live-stake-unbonding-note').innerText()).trim();
      check(/locks the coins for \d+ (day|hour|minute)/.test(note), `the Unstake form warns about the real lock-up: "${note.slice(0, 90)}"`);
      await shot('evm-stake-unbonding-epix.png');
      await byId('live-stake-form-back').click();
      await byId('live-stake-evm').waitFor({ timeout: 5_000 });
    } else {
      check(
        (await page.locator('[data-testid^="live-stake-delegation-"]').count()) === 0,
        'the vector account has nothing staked, so no Unstake form exists to warn on (unbonding note covered by the unit tests)',
      );
    }
    // Back to Home through the bottom nav (the Assets tab is the home tab).
    await byId('live-tab-assets').click();
    await byId('live-home').waitFor({ timeout: 10_000 });
  }

  // Back to BNB Chain for the checks below (they read the BSC activity tab).
  await byId('live-chain-switcher').click();
  await byId('live-chain-option-evm:bsc').click();
  await waitSynced(/USDT/);
  await byId('live-tab-activity').click();
  if (withAlchemy) {
    // With a provider key, BNB Chain history comes from the Transfers API.
    let bnbRows = 0;
    for (let i = 0; i < 40; i++) {
      bnbRows = await page.locator('[data-testid^="live-tx-row-"]').count();
      if (bnbRows > 0) break;
      await page.waitForTimeout(500);
    }
    check(bnbRows > 0, `BNB Chain activity lists transfers through the provider (${bnbRows} rows)`);
  } else {
    // Without one, BNB Chain has no keyless indexer: the wallet must SAY so
    // rather than show an empty list that reads as "no transactions".
    let warning = '';
    for (let i = 0; i < 20; i++) {
      if (await byId('live-history-warning').count()) {
        warning = (await byId('live-history-warning').innerText()).trim();
        break;
      }
      await page.waitForTimeout(500);
    }
    check(/cannot be listed on BNB Chain/i.test(warning), `BNB Chain shows the honest no-indexer notice: ${warning.slice(0, 80)}`);
  }
  await shot('evm-activity-bsc.png');
  await byId('live-tab-assets').click();
  // And back to Base.
  await byId('live-chain-switcher').click();
  await byId('live-chain-option-evm:base').click();
  for (let i = 0; i < 20; i++) {
    if (/Base/.test(await byId('live-home').innerText())) break;
    await page.waitForTimeout(500);
  }

  // Settings > Network on an EVM chain: the gateway endpoints, read-only; no
  // Electrum pool, no "Add server" (owner, 2026-08-20).
  await byId('live-settings-btn').click();
  await byId('live-settings').waitFor({ timeout: 10_000 });
  if (await byId('live-settings-mode-expert').count()) await byId('live-settings-mode-expert').click();
  await byId('live-settings-row-network').click({ timeout: 10_000 });
  await byId('live-evm-endpoints').waitFor({ timeout: 10_000 });
  const netCaption = (await byId('live-network-chain-caption').innerText()).trim();
  check(/Servers for: Base/.test(netCaption), `Network settings name the EVM chain in use (${netCaption})`);
  const rpcRow = (await byId('live-evm-endpoint-rpc').innerText()).replace(/\n/g, ' ');
  check(/network\.satorigo\.app\/evm\/base\/rpc/.test(rpcRow) && /Required/.test(rpcRow), `gateway RPC endpoint listed as required (${rpcRow.slice(0, 80)})`);
  check((await byId('live-server-input').count()) === 0 && (await byId('live-servers-list').count()) === 0, 'no Electrum pool and no Add server on an EVM chain');
  await shot('evm-settings-network.png');
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 10_000 });

  // Settings > Visible networks lists the EVM chains too: BNB Chain (not in
  // use) can be hidden, which drops it from the switcher; Base (in use) is
  // blocked; showing it again restores the row.
  await byId('live-settings-btn').click();
  await byId('live-settings').waitFor({ timeout: 10_000 });
  if (await byId('live-settings-mode-expert').count()) await byId('live-settings-mode-expert').click();
  await byId('live-settings-row-networks').click({ timeout: 10_000 });
  await byId('live-settings-chain-evm:bsc').waitFor({ timeout: 10_000 });
  check((await byId('live-settings-chain-evm:base').count()) === 1 && (await byId('live-settings-chain-evm:bsc').count()) === 1, 'Visible networks lists Base and BNB Chain');
  check(await byId('live-settings-chain-evm:base').isDisabled(), 'the EVM chain in use (Base) cannot be hidden');
  await byId('live-settings-chain-evm:bsc').click();
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 10_000 });
  await byId('live-chain-switcher').click();
  await byId('live-chain-dropdown').waitFor({ timeout: 5_000 });
  check((await byId('live-chain-option-evm:bsc').count()) === 0 && (await byId('live-chain-option-evm:base').count()) === 1, 'a hidden EVM chain leaves the switcher; the one in use stays');
  await page.keyboard.press('Escape');
  await byId('live-settings-btn').click();
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await byId('live-settings-row-networks').click({ timeout: 10_000 });
  await byId('live-settings-chain-evm:bsc').waitFor({ timeout: 10_000 });
  await byId('live-settings-chain-evm:bsc').click();
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 10_000 });
  await byId('live-chain-switcher').click();
  await byId('live-chain-option-evm:bsc').waitFor({ timeout: 5_000 });
  check(true, 'showing BNB Chain again restores it in the switcher');
  await page.keyboard.press('Escape');

  // Receive: the 0x address.
  await byId('live-receive').click();
  await page.waitForTimeout(500);
  const receiveText = await page.locator('body').innerText();
  check(receiveText.toLowerCase().includes(VECTOR_ADDRESS.toLowerCase()), 'receive screen shows the 0x address');
  await shot('evm-receive.png');
  await page.getByRole('button', { name: /Back/i }).first().click();
  await byId('live-home').waitFor({ timeout: 5_000 });

  // Send form (EVM branch): the chain is named, the fee levels exist, and a
  // review of an unfunded transfer is refused HONESTLY by the node's simulation.
  await byId('live-send').click();
  await byId('live-send-to').waitFor({ timeout: 5_000 });
  const sendText = await page.locator('body').innerText();
  check(/on Base/i.test(sendText), 'send screen names the chain (on Base)');
  check((await byId('live-fee-option-normal').count()) === 1, 'fee level control present');
  await byId('live-send-to').fill(RECIPIENT);
  // Recipient risk warnings, answered against the REAL chain: this vector
  // account has never paid RECIPIENT (first-time warning), and RECIPIENT is a
  // plain account, so eth_getCode must NOT produce the contract warning. The
  // contract check is debounced ~400ms, so give it a real window before
  // concluding it stayed silent.
  check((await byId('live-send-first-time').count()) === 1, 'send form warns this is a first-time recipient');
  let contractBanner = 0;
  for (let i = 0; i < 6; i++) {
    contractBanner = await byId('live-send-contract').count();
    if (contractBanner) break;
    await page.waitForTimeout(500);
  }
  check(contractBanner === 0, 'no contract warning for a plain (EOA) recipient');
  await shot('evm-send-warnings.png');
  await byId('live-send-amount').fill('0.000001');
  await shot('evm-send-form.png');
  await page.getByRole('button', { name: /Review transaction/i }).click();
  let outcome = '';
  for (let i = 0; i < 30; i++) {
    if (await byId('live-send-review').count()) {
      outcome = 'review';
      break;
    }
    if (await byId('live-send-error').count()) {
      outcome = (await byId('live-send-error').innerText()).trim();
      break;
    }
    await page.waitForTimeout(500);
  }
  check(
    outcome === 'review' || /refused to simulate|insufficient|unreachable/i.test(outcome),
    `review outcome for an unfunded account is a real quote or an honest refusal: ${outcome.slice(0, 120)}`,
  );
  await shot('evm-send-review-or-refusal.png');
  check((await byId('live-broadcast').count()) === 0 || !(await byId('live-broadcast').isEnabled()), 'nothing can be broadcast without arming');

  // Lock screen with a seed of many accounts: "Choose wallet" lists the seed as
  // ONE row (unlocking any account unlocks them all), names the account it
  // unlocks, and the chevron expands the accounts. Picking the row goes back to
  // the password view; the password then opens the wallet.
  await page.locator('button[aria-label="Back"]').first().click().catch(() => {});
  await byId('live-home').waitFor({ timeout: 10_000 });
  await byId('live-lock-btn').click();
  await byId('live-lock').waitFor({ timeout: 10_000 });
  await byId('live-lock-change').click();
  await byId('live-lock-wallets').waitFor({ timeout: 10_000 });
  const groupText = (await byId('live-lock-group-0').innerText()).replace(/\n/g, ' ');
  check(/\d+ accounts · unlocks Account/.test(groupText), `choose wallet: the seed is one row naming its accounts and the one it unlocks (${groupText})`);
  const collapsedRows = await page.locator('[data-testid^="live-lock-wallet-"]').count();
  check(collapsedRows === 0, `choose wallet: accounts are collapsed by default (${collapsedRows} account rows shown)`);
  await byId('live-lock-group-toggle-0').click();
  const expandedRows = await page.locator('button[data-testid^="live-lock-wallet-"]').count();
  check(expandedRows >= 2, `choose wallet: the chevron expands the accounts (${expandedRows} rows)`);
  await shot('evm-lock-choose-wallet.png');
  await byId('live-lock-group-toggle-0').click();
  await byId('live-lock-group-0').click();
  await byId('live-unlock').waitFor({ timeout: 10_000 });
  await byId('live-unlock').fill('live-pass-1234');
  await page.getByRole('button', { name: /^Unlock$/ }).click();
  await byId('live-home').waitFor({ timeout: 25_000 });
  check(true, 'picking the seed row and typing the password opens the wallet');

  // -------------------------------------------------------------------------
  // HOME LAYOUT IN THE SIDE PANEL (owner, 2026-08-24: a whole browser window
  // tall, so a wallet holding one or two tokens left a large dead zone under
  // the list; "move the whole thing to the centre, and as tokens are added it
  // should move up"). The centring is pure CSS (flex auto margins, see
  // .home-centered in global.css), so it can only be verified by MEASURING
  // real boxes: jsdom computes no layout, and a screenshot alone proves
  // nothing about the two gaps being equal.
  //
  // The panel page is its own document (index.html?panel=1) with the popup's
  // fixed 400x600 canvas lifted, which is the only way to get a viewport this
  // tall. Two cases, one viewport each:
  //   (a) Epix, no default tokens, so one native row: SHORT content, and both
  //       gaps around the block must be equal and real (dead centre);
  //   (b) Ethereum at 420x500, USDC + USDT on top of the native row in half
  //       the height: OVERFLOWING content, and both auto margins must have
  //       collapsed to zero, leaving the hero at the top and the list scrolled
  //       to its first row.
  // -------------------------------------------------------------------------
  const panelPage = await context.newPage();
  await panelPage.setViewportSize({ width: 420, height: 900 });
  await panelPage.goto(`chrome-extension://${id}/index.html?panel=1`);
  await panelPage
    .getByTestId('live-home')
    .or(panelPage.getByTestId('live-lock'))
    .first()
    .waitFor({ timeout: 20_000 });
  if (await panelPage.getByTestId('live-lock').count()) {
    await panelPage.getByTestId('live-unlock').fill('live-pass-1234');
    await panelPage.getByRole('button', { name: /^Unlock$/ }).click();
  }
  await panelPage.getByTestId('live-home').waitFor({ timeout: 30_000 });
  const panelId = (t) => panelPage.getByTestId(t);
  /** Wait for THIS page's balance read to land, same contract as waitSynced. */
  const panelSynced = async (matches) => {
    for (let i = 0; i < 40; i++) {
      const led = (await panelId('live-led').getAttribute('data-state').catch(() => '')) || '';
      const text = await panelId('live-home').innerText().catch(() => '');
      if (led === 'connected' && (await panelId('live-balance-hero').count()) === 1 && matches(text)) return led;
      await panelPage.waitForTimeout(500);
    }
    return (await panelId('live-led').getAttribute('data-state').catch(() => '')) || '';
  };
  /**
   * The home block's geometry. `above`/`below` are the two AUTO MARGINS: the
   * free space between the status row and the top of the block, and between
   * the bottom of the block and the container's content edge. The status row's
   * own margin-bottom is subtracted so the two numbers are directly comparable
   * (equal = dead centre, both zero = top-anchored).
   */
  const homeGeometry = () =>
    panelPage.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const panel = q('[data-testid="live-tab-panel-assets"]');
      const status = q('[data-testid="live-home-status"]');
      const hero = q('.home-hero-wrap');
      const scroll = q('.home-scroll');
      if (!panel || !status || !hero || !scroll) return null;
      const cs = getComputedStyle(panel);
      const p = panel.getBoundingClientRect();
      const s = status.getBoundingClientRect();
      const h = hero.getBoundingClientRect();
      const sc = scroll.getBoundingClientRect();
      const statusMb = parseFloat(getComputedStyle(status).marginBottom) || 0;
      const rows = [...document.querySelectorAll('[data-testid^="live-asset-row-"]')];
      return {
        classes: panel.className,
        rows: rows.length,
        viewportH: window.innerHeight,
        above: Math.round(h.top - s.bottom - statusMb),
        below: Math.round(p.bottom - parseFloat(cs.paddingBottom) - sc.bottom),
        heroTop: Math.round(h.top),
        heroBottom: Math.round(h.bottom),
        scrollTop: Math.round(scroll.scrollTop),
        scrollH: scroll.scrollHeight,
        clientH: scroll.clientHeight,
        firstRowTop: rows.length ? Math.round(rows[0].getBoundingClientRect().top) : null,
        regionTop: Math.round(sc.top),
      };
    });

  // (a) Epix at 420x900: one native row, nothing else.
  await panelId('live-chain-switcher').click();
  await panelId('live-chain-option-evm:epix').click();
  const panelLedEpix = await panelSynced((t) => /\bEPIX\b/.test(t) && !/USDC|USDT/.test(t));
  await panelPage.waitForTimeout(600); // let the list settle before measuring
  const centered = await homeGeometry();
  epixCheck(panelLedEpix === 'connected', `side panel read Epix (LED ${panelLedEpix})`);
  check(
    !!centered && /home-centered/.test(centered.classes) && !/home-roomy/.test(centered.classes),
    `side panel home is the centred layout, not the roomy one (${centered?.classes})`,
  );
  // The density belongs to the SHORT viewport and nowhere else. A panel this
  // tall has room for the roomy hero and the roomy list at the same time, so
  // `home-tight` leaking up here would be a regression, not an improvement.
  check(
    !!centered && !/home-tight/.test(centered.classes),
    `the side panel is NOT compacted: the density is the short viewport's alone (${centered?.classes})`,
  );
  check(
    !!centered && centered.above > 40 && centered.below > 40 && Math.abs(centered.above - centered.below) <= 1,
    `short home is DEAD CENTRED at 420x900: ${centered?.above}px free above the block, ${centered?.below}px below (${centered?.rows} asset row(s))`,
  );
  check(
    !!centered && centered.scrollH <= centered.clientH + 1,
    `nothing scrolls while it fits (list ${centered?.scrollH}px in ${centered?.clientH}px)`,
  );
  await panelPage.screenshot({ path: path.join(shotsDir, 'side-panel-home-centered.png') });

  // (b) Ethereum: USDC + USDT + the native row. If that still fits in 900px the
  // block simply stays centred (which is the point), so the overflow case is
  // forced by halving the panel height rather than by inventing tokens.
  await panelId('live-chain-switcher').click();
  await panelId('live-chain-option-evm:ethereum').click();
  const panelLedEth = await panelSynced((t) => /USDC/.test(t) && /USDT/.test(t));
  check(panelLedEth === 'connected', `side panel read Ethereum with its default token rows (LED ${panelLedEth})`);
  const tallEth = await homeGeometry();
  console.log(
    `note: Ethereum at 420x900 -> ${tallEth?.rows} rows, ${tallEth?.above}px above / ${tallEth?.below}px below` +
      `${tallEth && tallEth.above > 0 ? ' (still fits, still centred: more tokens moved the block up)' : ' (already overflowing)'}`,
  );
  // ...and the roomy scale itself, on a panel that HAS rows. The popup's
  // density is a set of --token-* overrides on `.home-tight`; if one of them
  // ever escaped its container, this is where it would show up as a shrunken
  // side panel. Measured, so "the panel did not shrink" is a number rather
  // than an impression.
  const panelDensity = await panelPage.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid^="live-asset-row-"]')];
    const first = rows[0];
    const f = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null);
    const name = first ? (first.getAttribute('data-testid') || '').slice('live-asset-row-'.length) : '';
    return {
      rows: rows.length,
      pitch:
        rows.length > 1
          ? Math.round(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top)
          : null,
      rowH: first ? Math.round(first.getBoundingClientRect().height) : null,
      mark: first ? Math.round((first.querySelector('.logo-frame, [data-token-badge]')?.getBoundingClientRect().height ?? 0)) : null,
      symbol: f(first?.querySelector('.token-name')),
      amount: f(first?.querySelector('.token-amount')),
      fiat: f(document.querySelector(`[data-testid="live-asset-usd-${name}"]`)),
      hero: f(document.querySelector('.hero-value')),
      body: parseFloat(getComputedStyle(document.body).fontSize),
    };
  });
  console.log(
    `note: side-panel density at 420x900 -> row ${panelDensity.rowH}px (pitch ${panelDensity.pitch}px, mark ${panelDensity.mark}px), symbol ${panelDensity.symbol}px, amount ${panelDensity.amount}px, fiat ${panelDensity.fiat}px, hero ${panelDensity.hero}px, body ${panelDensity.body}px`,
  );
  check(
    panelDensity.body === 14 && panelDensity.symbol === 13 && panelDensity.amount === 13 && panelDensity.mark === 26,
    `the side panel keeps the ROOMY scale (body ${panelDensity.body}px, symbol ${panelDensity.symbol}px, amount ${panelDensity.amount}px, mark ${panelDensity.mark}px)`,
  );
  check(
    (panelDensity.rowH ?? 0) >= 40 && (panelDensity.pitch === null || panelDensity.pitch >= 44),
    `the side panel's rows are not the popup's dense ones (${panelDensity.rowH}px row, ${panelDensity.pitch}px pitch)`,
  );
  // And the hero balance is the hero balance here too. It was NOT: the row's
  // amount rule matched `live-balance-hero` by testid prefix and beat
  // `.live-scope .hero-value`, so this figure rendered at 12.5px in the side
  // panel and the detached window on every chain with an asset list.
  check(
    (panelDensity.hero ?? 0) >= 24,
    `the side panel's hero balance is the largest thing on it (${panelDensity.hero}px, not the row's ${panelDensity.amount}px)`,
  );
  // ...and the CHROME around it, for the same reason. The popup's chrome pass
  // rides on `frame-tight` (the header's padding, the address line's line box,
  // the screen's top padding and the tab bar); a panel this tall must keep the
  // roomy header and the roomy tab bar it was asked for.
  const panelChrome = await panelPage.evaluate(() => {
    const h = (s) => {
      const el = document.querySelector(s);
      return el ? Math.round(el.getBoundingClientRect().height) : null;
    };
    const content = document.querySelector('.app-content');
    return {
      frameClasses: document.querySelector('.app-frame')?.className ?? '',
      header: h('.app-header'),
      addressLine: h('.wallet-address'),
      nav: h('.bottom-nav'),
      padTop: content ? Math.round(parseFloat(getComputedStyle(content).paddingTop)) : null,
    };
  });
  console.log(
    `note: side-panel chrome -> header ${panelChrome.header}px (address line ${panelChrome.addressLine}px), content padding-top ${panelChrome.padTop}px, nav ${panelChrome.nav}px`,
  );
  check(
    !/frame-tight/.test(panelChrome.frameClasses) &&
      panelChrome.header >= 68 &&
      panelChrome.addressLine >= 22 &&
      panelChrome.nav >= 58 &&
      panelChrome.padTop === 16,
    `the side panel keeps the ROOMY chrome (header ${panelChrome.header}px, address ${panelChrome.addressLine}px, nav ${panelChrome.nav}px, top padding ${panelChrome.padTop}px, classes "${panelChrome.frameClasses}")`,
  );
  // Shrink until the content ACTUALLY overflows rather than assuming a fixed
  // height does it: how many rows this account holds on this chain is live data
  // (three Ethereum rows on some days), and a check that depends on the vector
  // account being rich is a check that fails for reasons that are not ours.
  let overflow = null;
  for (const h of [500, 420, 360, 320, 280]) {
    await panelPage.setViewportSize({ width: 420, height: h });
    await panelPage.waitForTimeout(600);
    overflow = await homeGeometry();
    if (overflow && overflow.scrollH > overflow.clientH) break;
  }
  const overflowH = overflow?.viewportH;
  check(
    !!overflow && overflow.scrollH > overflow.clientH,
    `at 420x${overflowH} the same content genuinely overflows (list ${overflow?.scrollH}px in ${overflow?.clientH}px, ${overflow?.rows} rows)`,
  );
  check(
    !!overflow && overflow.above <= 1 && overflow.below <= 1,
    `overflowing home is TOP-ANCHORED: both auto margins collapsed (${overflow?.above}px above, ${overflow?.below}px below)`,
  );
  check(
    !!overflow && overflow.heroTop > 0 && overflow.heroBottom < overflow.viewportH,
    `the hero is above the fold when it overflows (hero ${overflow?.heroTop}-${overflow?.heroBottom} of ${overflow?.viewportH}px)`,
  );
  check(
    !!overflow && overflow.scrollTop === 0 && overflow.firstRowTop !== null && overflow.firstRowTop >= overflow.regionTop - 1,
    `the list starts at its first row (scrollTop ${overflow?.scrollTop}, first row at ${overflow?.firstRowTop} vs region top ${overflow?.regionTop})`,
  );
  await panelPage.screenshot({ path: path.join(shotsDir, 'side-panel-home-overflow.png') });
  await panelPage.close();

  // -------------------------------------------------------------------------
  // POPUP MODE: the scroll affordance and the notification banner.
  //
  // Everything below runs in the TOOLBAR POPUP (index.html with no ?panel=1),
  // which is the fixed 400x600 window the owner was testing in. The side panel
  // above is a whole browser window tall and scrolls comfortably; the popup is
  // where an overflowing list had nothing to say for itself.
  // -------------------------------------------------------------------------
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 620 });
  const popupId = (t) => popup.getByTestId(t);
  /** Open (or reopen) the popup page and get past the lock screen. */
  const openPopup = async () => {
    await popup.goto(`chrome-extension://${id}/index.html`);
    await popup.getByTestId('live-home').or(popup.getByTestId('live-lock')).first().waitFor({ timeout: 20_000 });
    if (await popupId('live-lock').count()) {
      await popupId('live-unlock').fill('live-pass-1234');
      await popup.getByRole('button', { name: /^Unlock$/ }).click();
    }
    await popupId('live-home').waitFor({ timeout: 30_000 });
    await popup.waitForTimeout(1_200); // let the rows and the banner settle
  };
  await openPopup();
  check(
    await popup.evaluate(() => !document.documentElement.dataset.panel && !document.documentElement.dataset.detached),
    'popup mode: neither the side-panel nor the detached-window marker is stamped',
  );

  /** The asset list's scroll geometry and what the "more below" cue says about
   *  it, measured together so the two can be compared rather than assumed. */
  const scrollGeometry = () =>
    popup.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const region = q('.home-scroll');
      const cue = q('[data-testid="live-home-scroll-cue"]');
      if (!region || !cue) return null;
      const rows = [...document.querySelectorAll('[data-testid^="live-asset-row-"]')];
      const last = rows.length ? rows[rows.length - 1].getBoundingClientRect() : null;
      const c = cue.getBoundingClientRect();
      const r = region.getBoundingClientRect();
      const thumb = getComputedStyle(region, '::-webkit-scrollbar-thumb');
      return {
        rows: rows.length,
        scrollH: Math.round(region.scrollHeight),
        clientH: Math.round(region.clientHeight),
        scrollTop: Math.round(region.scrollTop),
        gutter: Math.round(region.offsetWidth - region.clientWidth),
        more: cue.getAttribute('data-more'),
        cueTop: Math.round(c.top),
        cueBottom: Math.round(c.bottom),
        cuePointerEvents: getComputedStyle(cue).pointerEvents,
        cueVisibility: getComputedStyle(cue).visibility,
        regionBottom: Math.round(r.bottom),
        lastRowBottom: last ? Math.round(last.bottom) : null,
        thumbBackground: thumb ? thumb.backgroundColor : '',
      };
    });

  // -------------------------------------------------------------------------
  // THE REBALANCED POPUP HOME (owner, live testing 2026-08-25: "you can see
  // only one token and have to scroll it, it looks very bad when someone has a
  // lot of tokens").
  //
  // Measured, never eyeballed. The popup is switched to Base, where the import
  // above left this account holding two dozen tokens, and then every box that
  // matters is read out of the real document: how many rows fit ENTIRELY
  // inside the scroll region, and whether the hero and the Send/Receive row are
  // still whole. Before the rebalance the same measurement at 400x600 gave a
  // 64px list with ONE visible row and a panel that had to scroll itself; the
  // first pass got that to 4 rows in a 209px region at a 48px pitch, the
  // density pass below to 6 rows in a 231px region at a 39px pitch, and the
  // chrome pass (`frame-tight`) to 7 rows in a 276px region at the same pitch
  // by taking 45px of padding off the header, the screen's top edge, the
  // status/hero/actions/ASSETS gaps and the tab bar.
  //
  // The checks assert the INVARIANT, not those numbers: at least seven rows
  // WHOLLY inside the region, nothing clipped, nothing overlapping, no
  // user-facing text under 10px, and the hero balance still the largest thing
  // on the screen. Pixel targets drift with every layout tweak; those five
  // statements are what the owner actually asked for, and a future change that
  // buys an eighth row honestly should not have to edit this file.
  // -------------------------------------------------------------------------
  await popup.setViewportSize({ width: 400, height: 600 });
  await popupId('live-chain-switcher').click();
  await popupId('live-chain-option-evm:base').click();
  for (let i = 0; i < 40; i++) {
    if ((await popup.locator('[data-testid^="live-asset-row-"]').count()) >= 6) break;
    await popup.waitForTimeout(500);
  }

  /** Every box the rebalance is about, from the live document. A row counts as
   *  visible only when it is WHOLLY inside the scroll region: half a row is the
   *  thing that made the old layout look broken. */
  const homeLayout = () =>
    popup.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
      };
      const panel = q('.app-content');
      const region = q('.home-scroll');
      const nav = q('.bottom-nav');
      const rows = [...document.querySelectorAll('[data-testid^="live-asset-row-"]')];
      const rr = region?.getBoundingClientRect();
      const navTop = nav ? nav.getBoundingClientRect().top : window.innerHeight;
      return {
        classes: panel?.className ?? '',
        // The chrome AROUND the panel: the header, the address line inside it,
        // the screen's own top padding and the tab bar. They are siblings of
        // .app-content, so the compaction that reaches them rides on a second
        // marker (`frame-tight`) stamped on the frame.
        frameClasses: q('.app-frame')?.className ?? '',
        header: box(q('.app-header')),
        addressLine: box(q('.wallet-address')),
        nav: box(nav),
        contentPadTop: panel ? Math.round(parseFloat(getComputedStyle(panel).paddingTop)) : null,
        contentPadBottom: panel ? Math.round(parseFloat(getComputedStyle(panel).paddingBottom)) : null,
        statusRow: box(q('[data-testid="live-home-status"]')),
        assetsLabelRow: box(q('.section-label')?.parentElement),
        cue: box(q('[data-testid="live-home-scroll-cue"]')),
        rows: rows.length,
        rowsFullyVisible: rr
          ? rows.filter((el) => {
              const b = el.getBoundingClientRect();
              return b.top >= rr.top - 0.5 && b.bottom <= rr.bottom + 0.5;
            }).length
          : 0,
        rowPitch:
          rows.length > 1
            ? Math.round(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top)
            : null,
        region: box(region),
        hero: box(q('.hero')),
        heroValueFont: q('.hero-value') ? parseFloat(getComputedStyle(q('.hero-value')).fontSize) : null,
        heroMark: box(q('.hero-mark')),
        actions: box(q('.actions-row')),
        navTop: Math.round(navTop),
        addToken: box(q('[data-testid="live-add-asset"]')),
        // The pinned block must fit: a block taller than the panel is CLIPPED,
        // not scrolled, which is how Send and Receive once went out of reach.
        panelOverflows: panel ? panel.scrollHeight > panel.clientHeight + 1 : false,
        // Every piece of TEXT on the screen, with the size it is painted at.
        // Two questions are asked of it. `text` (everything outside the hero)
        // answers "does the hero balance still tower over the rest", because a
        // denser list must not end up competing with the number the screen
        // exists for. `dense` is the narrower set the density pass actually
        // owns: the list, the Assets label and the Send/Receive labels. It
        // answers "did anything fall under the 10px legibility floor". The
        // status row above them is deliberately NOT in `dense`: its 9.5px
        // metadata predates this work and is not what was traded for rows.
        text: [...(panel?.querySelectorAll('*') ?? [])]
          .filter((el) => {
            if (el.closest('.hero')) return false;
            const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
            if (!own) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          })
          .map((el) => ({
            font: parseFloat(getComputedStyle(el).fontSize),
            what: el.getAttribute('data-testid') || el.className || el.tagName,
            sample: (el.textContent || '').trim().slice(0, 24),
            // The token badge's one or two letters are excluded: they are the
            // MARK for a token with no artwork, sized as a fraction of the coin
            // frame (9px at both the roomy 26 and the compact 24), not prose,
            // and the row spells the symbol out in full right beside them.
            dense:
              !!el.closest('.home-scroll, .actions-row, .section-label') && !el.closest('[data-token-badge]'),
          })),
        // Row internals, for the first six rows: the mark, the symbol, the
        // amount, the fiat value and the 24h chip. "Nothing clipped" means each
        // of those boxes sits inside its row; "nothing overlapping" means the
        // amount, the fiat and the chip keep to their own horizontal lane.
        rowParts: rows.slice(0, 6).map((row) => {
          const rb = row.getBoundingClientRect();
          const name = (row.getAttribute('data-testid') || '').slice('live-asset-row-'.length);
          const part = (sel) => {
            const el = row.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
          };
          return {
            name,
            row: { top: rb.top, bottom: rb.bottom, h: Math.round(rb.height) },
            mark: part('.logo-frame, [data-token-badge]'),
            symbol: part('.token-name'),
            amount: part('.token-amount'),
            fiat: part(`[data-testid="live-asset-usd-${name}"]`),
            chip: part(`[data-testid="live-asset-change-${name}"]`),
          };
        }),
      };
    });
  const layout = await homeLayout();
  console.log(
    `note: popup home at 400x600 with ${layout.rows} tokens -> list ${layout.region?.h}px, ${layout.rowsFullyVisible} rows fully visible (pitch ${layout.rowPitch}px), hero ${layout.hero?.h}px, actions ${layout.actions?.h}px`,
  );
  console.log(
    `note: popup chrome -> header ${layout.header?.h}px (address line ${layout.addressLine?.h}px), content padding ${layout.contentPadTop}/${layout.contentPadBottom}px, status row ${layout.statusRow?.h}px, ASSETS row ${layout.assetsLabelRow?.h}px, nav ${layout.nav?.h}px`,
  );
  check(layout.rows >= 8, `the popup is showing a long token list (${layout.rows} rows)`);
  check(
    /home-tight/.test(layout.classes),
    `a long list in a short viewport gets the compact hero (${layout.classes})`,
  );
  check(
    /frame-tight/.test(layout.frameClasses),
    `...and the chrome around it is compacted with it (${layout.frameClasses})`,
  );
  // THE decision: about seven rows in the fixed 600px popup. Seven is the
  // floor, not the target, so a later change that buys an eighth still passes.
  check(
    layout.rowsFullyVisible >= 7,
    `at least 7 token rows are fully visible without scrolling (${layout.rowsFullyVisible} of ${layout.rows}, list region ${layout.region?.h}px at a ${layout.rowPitch}px pitch)`,
  );
  check(
    !!layout.actions && layout.actions.bottom <= layout.navTop,
    `Send / Receive are whole and clear of the nav (actions bottom ${layout.actions?.bottom}, nav top ${layout.navTop})`,
  );
  // The chrome pass took padding, never a band: every control that was on this
  // screen is still on it, at its own height, and the bands still stack in
  // order with nothing overlapping. Read as boxes, because "I removed only
  // padding" is exactly the kind of claim that rots.
  check(
    !!layout.header &&
      !!layout.addressLine &&
      layout.addressLine.bottom <= layout.header.bottom &&
      layout.header.bottom <= (layout.statusRow?.top ?? 0),
    `the address line is still in the header and the header still clears the status row (address ${layout.addressLine?.bottom}, header ${layout.header?.bottom}, status ${layout.statusRow?.top})`,
  );
  check(
    !!layout.region && !!layout.nav && layout.region.bottom <= layout.nav.top,
    `the list region ends above the tab bar (list bottom ${layout.region?.bottom}, nav top ${layout.nav?.top})`,
  );
  // The "more below" chevron is anchored to .app-content's bottom padding band,
  // so that padding may never shrink below the cue's own height: the moment it
  // does, the chevron paints over the last row it is meant to sit under.
  check(
    !layout.cue || (!!layout.region && layout.cue.top >= layout.region.bottom - 0.5),
    `the "more below" chevron sits UNDER the last row, in the screen's own padding band (cue top ${layout.cue?.top}, list bottom ${layout.region?.bottom}, bottom padding ${layout.contentPadBottom}px)`,
  );
  check(
    !!layout.addToken && layout.addToken.bottom <= layout.region.top + 1,
    `the Assets header and its "Add token" stay pinned above the list (Add token bottom ${layout.addToken?.bottom}, list top ${layout.region?.top})`,
  );
  // The hero is allowed to be short; what it may not be is quiet. The balance
  // must still be the biggest text on the screen by a clear margin, and the
  // coin mark must still read as a coin rather than a favicon.
  const loudest = layout.text.reduce((m, t) => (t.font > m.font ? t : m), { font: 0, what: 'nothing', sample: '' });
  check(
    !!layout.heroValueFont && layout.heroValueFont >= 18 && layout.heroValueFont >= loudest.font + 4,
    `the hero balance is still clearly the largest thing on the screen (${layout.heroValueFont}px vs ${loudest.font}px for "${loudest.sample}")`,
  );
  check(
    !!layout.heroMark && layout.heroMark.h >= 32,
    `the coin mark is still the coin mark (${layout.heroMark?.h}px)`,
  );
  // The legibility floor the density was bought against: nothing the density
  // pass touched goes under 10px. Owner's rule, and the reason the list stops
  // where it does rather than squeezing a seventh row out of the type.
  const dense = layout.text.filter((t) => t.dense);
  const tooSmall = dense.filter((t) => t.font < 10);
  check(
    dense.length > 0 && tooSmall.length === 0,
    `no text in the compact list, its label or its actions is under 10px (${dense.length} checked, smallest ${Math.min(...dense.map((t) => t.font))}px${
      tooSmall.length ? `; offenders: ${tooSmall.map((t) => `${t.what}@${t.font}px`).join(', ')}` : ''
    })`,
  );
  // Denser rows are only worth having if the row still holds everything it
  // holds today. Two failures are possible and both are checked on the real
  // boxes: a part painted outside its own row (clipped by the row's rounding /
  // the region's edge), and the amount, fiat value or 24h chip climbing over
  // each other because the line ran out of width.
  const clipped = layout.rowParts.flatMap((r) =>
    ['mark', 'symbol', 'amount', 'fiat', 'chip']
      .filter((k) => r[k] && (r[k].top < r.row.top - 0.5 || r[k].bottom > r.row.bottom + 0.5))
      .map((k) => `${r.name}.${k}`),
  );
  check(
    layout.rowParts.length > 0 && clipped.length === 0,
    `every row holds its mark, symbol, amount, fiat and chip whole (${layout.rowParts.length} rows at ${layout.rowParts[0]?.row.h}px${
      clipped.length ? `; clipped: ${clipped.join(', ')}` : ''
    })`,
  );
  const collide = layout.rowParts.flatMap((r) => {
    const lane = [r.symbol, r.amount, r.fiat, r.chip].filter(Boolean);
    const bad = [];
    for (let i = 1; i < lane.length; i++) {
      if (lane[i].left < lane[i - 1].right - 0.5) bad.push(`${r.name}[${i}]`);
    }
    return bad;
  });
  check(
    collide.length === 0,
    `symbol, amount, fiat and 24h chip keep to one line without overlapping${collide.length ? ` (overlaps: ${collide.join(', ')})` : ''}`,
  );
  check(
    layout.panelOverflows === false,
    `the pinned block fits the popup, so nothing is clipped (panel overflows: ${layout.panelOverflows})`,
  );
  await popup.screenshot({ path: path.join(shotsDir, 'popup-home-many-tokens.png') });

  // -------------------------------------------------------------------------
  // THE ASSET LIST'S EDIT MODE (owner, 2026-08-25: "przy nazwie asset dodaj
  // jakas ikonke edycji ... ikonka za ktora mozna je przesowac zmieniajac
  // kolejnosc na liscie oraz tick ze mozna zaznaczyc kilka i je usunac").
  //
  // Run HERE, in the 400x600 popup, on Base, where the import above left this
  // account holding a couple of dozen tokens: an arrangement mode is only worth
  // anything on a list too long to read at a glance, and the density it must not
  // break is the popup's.
  //
  // Four claims, all measured or read from the real DOM:
  //   1. the toggle puts a handle and a tick on every row, and nothing in the
  //      row is clipped by it or climbs over its neighbour,
  //   2. a KEYBOARD move reorders a row and the new order survives closing and
  //      reopening the popup (it is persisted per wallet and per chain),
  //   3. ticking two and confirming removes exactly those two,
  //   4. leaving the mode gives back the list exactly as it was: seven whole
  //      rows, no handles, no ticks.
  // -------------------------------------------------------------------------
  {
    /** Row names in DOM order (edit mode or not). */
    const listNames = () =>
      popup.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="live-asset-row-"]')].map((el) =>
          el.getAttribute('data-testid').slice('live-asset-row-'.length),
        ),
      );
    /** Handles, ticks, and the geometry that says whether they fit. */
    const editGeometry = () =>
      popup.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid^="live-asset-row-"]')];
        const region = document.querySelector('.home-scroll');
        const rr = region?.getBoundingClientRect();
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
        };
        return {
          rows: rows.length,
          handles: document.querySelectorAll('[data-testid^="live-asset-handle-"]').length,
          ticks: document.querySelectorAll('[data-testid^="live-asset-select-"]').length,
          bar: box(document.querySelector('[data-testid="live-assets-edit-bar"]')),
          // A Satori Network notice takes list rows BY DESIGN (its own checks
          // further down prove that trade), so the density floor below has to
          // know whether one is up.
          notice: !!document.querySelector('[data-testid="live-notification"]'),
          scrollTop: region ? Math.round(region.scrollTop) : null,
          region: rr ? { top: rr.top, bottom: rr.bottom, h: rr.height } : null,
          rowsFullyVisible: rr
            ? rows.filter((el) => {
                const b = el.getBoundingClientRect();
                return b.top >= rr.top - 0.5 && b.bottom <= rr.bottom + 0.5;
              }).length
            : 0,
          rowH: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : null,
          pitch:
            rows.length > 1
              ? Math.round(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top)
              : null,
          // Every row's parts, in the order they are laid out left to right.
          // "Clipped" = a part painted outside its own row; "overlapping" = two
          // parts sharing horizontal space on the same line.
          parts: rows.slice(0, 8).map((row) => {
            const rb = row.getBoundingClientRect();
            const name = row.getAttribute('data-testid').slice('live-asset-row-'.length);
            const q = (sel) => box(row.querySelector(sel));
            return {
              name,
              row: { top: rb.top, bottom: rb.bottom, h: Math.round(rb.height) },
              handle: q('.asset-edit-grip'),
              mark: q('.logo-frame, [data-token-badge]'),
              symbol: q('.token-name'),
              amount: q('.token-amount'),
              tick: q('.asset-edit-tick'),
            };
          }),
        };
      });

    await popupId('live-assets-edit').click();
    await popup.getByTestId(/^live-asset-handle-/).first().waitFor({ timeout: 5_000 });
    const edit = await editGeometry();
    console.log(
      `note: popup edit mode -> ${edit.rows} rows, ${edit.handles} handles, ${edit.ticks} ticks, row ${edit.rowH}px (pitch ${edit.pitch}px), ${edit.rowsFullyVisible} rows fully visible in a ${Math.round(edit.region?.h ?? 0)}px region`,
    );
    check(
      edit.handles === edit.rows && edit.ticks === edit.rows,
      `edit mode puts a handle and a tick on every row (${edit.handles} handles, ${edit.ticks} ticks, ${edit.rows} rows)`,
    );
    check(
      (await popupId('live-assets-edit').getAttribute('aria-pressed')) === 'true',
      'the edit toggle shows its pressed state',
    );
    const editClipped = edit.parts.flatMap((r) =>
      ['handle', 'mark', 'symbol', 'amount', 'tick']
        .filter((k) => r[k] && (r[k].top < r.row.top - 0.5 || r[k].bottom > r.row.bottom + 0.5))
        .map((k) => `${r.name}.${k}`),
    );
    check(
      edit.parts.length > 0 && editClipped.length === 0,
      `every edit-mode row holds its handle, mark, symbol, amount and tick whole (${edit.parts.length} rows at ${edit.parts[0]?.row.h}px${
        editClipped.length ? `; clipped: ${editClipped.join(', ')}` : ''
      })`,
    );
    const editCollide = edit.parts.flatMap((r) => {
      const lane = [r.handle, r.mark, r.symbol, r.amount, r.tick].filter(Boolean);
      const bad = [];
      for (let i = 1; i < lane.length; i++) {
        if (lane[i].left < lane[i - 1].right - 0.5) bad.push(`${r.name}[${i}]`);
      }
      return bad;
    });
    check(
      editCollide.length === 0,
      `handle, mark, symbol, amount and tick keep to their own lanes${editCollide.length ? ` (overlaps: ${editCollide.join(', ')})` : ''}`,
    );
    // The controls must be comfortably tappable: 24px is the floor the owner's
    // brief set, even though the glyphs inside them are 14px and 16px.
    const smallest = edit.parts.reduce(
      (m, r) => Math.min(m, r.handle?.h ?? 99, r.handle?.w ?? 99, r.tick?.h ?? 99, r.tick?.w ?? 99),
      99,
    );
    check(smallest >= 24, `the handle and the tick are at least 24px of hit area (smallest ${smallest}px)`);
    // The controls are sized to the coin mark, so turning the mode on must not
    // cost the list a single row of height.
    check(
      edit.pitch === layout.rowPitch,
      `edit mode does not make the rows taller (pitch ${edit.pitch}px vs ${layout.rowPitch}px in normal mode, row ${edit.rowH}px)`,
    );
    check(
      !!edit.bar && !!edit.region && edit.bar.top >= edit.region.top - 0.5,
      `the edit bar rides inside the list region, never over a row (bar top ${edit.bar?.top}, region top ${edit.region?.top})`,
    );
    await popup.screenshot({ path: path.join(shotsDir, 'popup-assets-edit-mode.png') });

    // --- 2. KEYBOARD reorder, and it survives a reload -----------------------
    // The keyboard, not a synthetic drag: it is the alternative that has to work
    // for anyone who cannot drag, and it is the one a script can drive honestly.
    // Read the list immediately before the press, so a background refresh that
    // landed since the mode was entered cannot make this test lie.
    const beforeMove = await listNames();
    const moved = beforeMove[2]; // the second TOKEN (index 0 is the native coin)
    const handle = popupId(`live-asset-handle-${moved}`);
    await handle.focus();
    await handle.press('ArrowUp');
    await popup.waitForTimeout(300);
    const afterMove = await listNames();
    check(
      afterMove[1] === moved && afterMove[0] === beforeMove[0],
      `a keyboard press moved "${moved.slice(0, 24)}" up one place, the native coin still first (${afterMove
        .slice(0, 3)
        .map((n) => n.slice(0, 14))
        .join(' | ')})`,
    );
    await openPopup();
    await popup.waitForTimeout(1_500);
    const afterReload = await listNames();
    check(
      afterReload[1] === moved,
      `the new order survived closing and reopening the popup ("${moved.slice(0, 24)}" is still row 2; got "${(afterReload[1] ?? '').slice(0, 24)}")`,
    );
    check(
      (await popupId('live-assets-edit').getAttribute('aria-pressed')) === 'false' &&
        (await popup.locator('[data-testid^="live-asset-handle-"]').count()) === 0,
      'edit mode is OFF after a reload: it is a mode, not a setting',
    );

    // --- 3. tick two, remove them --------------------------------------------
    await popupId('live-assets-edit').click();
    await popup.getByTestId(/^live-asset-handle-/).first().waitFor({ timeout: 5_000 });
    const namesNow = await listNames();
    // The last two rows: zero-balance / spam tokens at the end of the list, so
    // the removal is on exactly the kind of row this feature exists for.
    const doomed = namesNow.slice(-2);
    for (const name of doomed) {
      // getByTestId, never an interpolated CSS selector: a spam token names
      // itself things like "(t.me/s/US_POOL) *claim until 24.02.26".
      await popupId(`live-asset-select-${name}`).check();
    }
    const countText = (await popupId('live-assets-selected-count').innerText()).trim();
    check(countText === '2 tokens selected', `the bar counts the ticks: "${countText}"`);
    await popup.screenshot({ path: path.join(shotsDir, 'popup-assets-edit-selected.png') });
    await popupId('live-assets-remove-selected').click();
    const modal = popupId('live-assets-remove-modal');
    await modal.waitFor({ timeout: 5_000 });
    const modalText = (await modal.innerText()).replace(/\n/g, ' ');
    check(
      /hidden from this list only/.test(modalText) && /stays on the blockchain/.test(modalText),
      `the confirmation says plainly what removal means: "${modalText.slice(0, 120)}"`,
    );
    await popupId('live-assets-remove-modal-confirm').click();
    await popup.waitForTimeout(800);
    const afterRemove = await listNames();
    check(
      doomed.every((n) => !afterRemove.includes(n)),
      `both ticked tokens are gone from the list (${doomed.map((n) => n.slice(0, 14)).join(', ')})`,
    );
    // EXACTLY those two: every other row that was on screen is still on screen.
    // (Asserted by name rather than by counting, because a background refresh
    // may legitimately have brought a row in while this ran.)
    const untouched = namesNow.filter((n) => !doomed.includes(n));
    const collateral = untouched.filter((n) => !afterRemove.includes(n));
    check(
      collateral.length === 0,
      `no other row was touched (${namesNow.length} -> ${afterRemove.length}${
        collateral.length ? `; also lost: ${collateral.map((n) => n.slice(0, 14)).join(', ')}` : ''
      })`,
    );
    check(
      (await popupId('live-assets-selected-count').count()) === 0,
      'the selection is spent: the count is gone with the rows',
    );

    // --- 4. leave the mode: the list is exactly what it was -------------------
    await popupId('live-assets-edit').click();
    await popup.waitForTimeout(400);
    // Measure from the TOP of the list, the way the user meets it: the rows
    // were scrolled during the arranging above, and half a row at the top edge
    // is a scroll position, not a density.
    await popup.evaluate(() => {
      const r = document.querySelector('.home-scroll');
      if (r) r.scrollTop = 0;
    });
    await popup.waitForTimeout(200);
    const normal = await editGeometry();
    console.log(
      `note: popup back in normal mode -> ${normal.rows} rows, row ${normal.rowH}px (pitch ${normal.pitch}px), ${normal.rowsFullyVisible} fully visible in a ${Math.round(normal.region?.h ?? 0)}px region, notice ${normal.notice ? 'up' : 'none'}`,
    );
    check(
      normal.handles === 0 && normal.ticks === 0 && !normal.bar,
      `leaving edit mode takes every control away (${normal.handles} handles, ${normal.ticks} ticks, bar ${normal.bar ? 'still there' : 'gone'})`,
    );
    // Seven whole rows is the floor the density pass bought and this feature
    // must not spend. A Satori Network notice legitimately costs two of them
    // (its own check above measures exactly that), so the floor follows it.
    const rowFloor = normal.notice ? 5 : 7;
    check(
      normal.rowsFullyVisible >= rowFloor,
      `the density is back: at least ${rowFloor} whole rows in the popup${
        normal.notice ? ' (a Satori Network notice is up, which costs rows by design)' : ''
      } (${normal.rowsFullyVisible} of ${normal.rows}, region ${Math.round(normal.region?.h ?? 0)}px at a ${normal.pitch}px pitch)`,
    );
    check(
      normal.pitch !== null && Math.abs(normal.pitch - layout.rowPitch) <= 1,
      `normal mode is the list it was before editing (pitch ${normal.pitch}px vs ${layout.rowPitch}px)`,
    );
    await popup.screenshot({ path: path.join(shotsDir, 'popup-assets-normal-mode.png') });
  }

  // -------------------------------------------------------------------------
  // PAGING on the per-asset Activity list (owner, live testing 2026-08-25:
  // "there is no pagination in activities, I checked for USDT on EVM BNB").
  // The main Activity tab has had prev/next for releases; THIS screen had no
  // controls at all and rendered every matching row in one scroll. Checked on
  // the token's own screen, in the popup, with the real chain behind it.
  // -------------------------------------------------------------------------
  {
    // The native row always exists and always has whatever history the chain
    // reports, so it is the honest subject here rather than a token that may
    // have none on this account.
    await popupId('live-asset-row-ETH').click();
    await popupId('live-asset-detail').waitFor({ timeout: 10_000 });
    await popup.waitForTimeout(800);
    const readDetail = () => popup.evaluate(() => {
      const q = (s) => document.querySelector(s);
      return {
        rows: document.querySelectorAll('[data-testid^="live-tx-row-"]').length,
        pager: !!q('[data-testid="asset-activity-pager"]'),
        pageInfo: q('[data-testid="asset-activity-page-info"]')?.textContent?.trim() ?? null,
        loadOlder: !!q('[data-testid="asset-activity-load-older"]'),
        noOlder: q('[data-testid="asset-activity-no-older"]')?.textContent?.trim() ?? null,
        error: q('[data-testid="asset-activity-older-error"]')?.textContent?.trim() ?? null,
        onLastPage: !!q('[data-testid="asset-activity-page-next"][disabled]') || !q('[data-testid="asset-activity-page-next"]'),
      };
    });
    const firstPage = await readDetail();
    // "Load older" belongs at the END of what is already held, so walk to the
    // last page before asking about it (which is also what a user does).
    for (let i = 0; i < 30; i++) {
      const next = popupId('asset-activity-page-next');
      if ((await next.count()) === 0 || (await next.isDisabled())) break;
      await next.click();
      await popup.waitForTimeout(120);
    }
    const detail = await readDetail();
    console.log(
      `note: asset detail Activity -> ${detail.rows} row(s) on screen, ${detail.pageInfo ?? 'one page'}, load-older ${detail.loadOlder}, end-note ${detail.noOlder ? 'shown' : 'none'}`,
    );
    check(
      firstPage.rows <= 10,
      `the per-asset Activity list shows ONE page, not every row it holds (${firstPage.rows} on screen${firstPage.pageInfo ? `, ${firstPage.pageInfo}` : ''})`,
    );
    // Something must be said about how far back this goes: either a way to go
    // deeper, or the plain statement that this is everything. An account with
    // no activity at all has neither, and shows no pager.
    check(
      detail.rows === 0 || detail.pager,
      `the per-asset Activity list carries the paging controls (pager ${detail.pager})`,
    );
    if (detail.loadOlder) {
      const before = await popup.locator('[data-testid^="live-tx-row-"]').count();
      await popupId('asset-activity-load-older').click();
      let settled = null;
      for (let i = 0; i < 40; i++) {
        settled = await popup.evaluate(() => {
          const q = (s) => document.querySelector(s);
          return {
            busy: !!q('[data-testid="asset-activity-load-older"][disabled]'),
            info: q('[data-testid="asset-activity-page-info"]')?.textContent?.trim() ?? null,
            end: !!q('[data-testid="asset-activity-no-older"]'),
            error: q('[data-testid="asset-activity-older-error"]')?.textContent?.trim() ?? null,
          };
        });
        if (!settled.busy) break;
        await popup.waitForTimeout(500);
      }
      // Honest either way: more pages, the end of the history, or a stated
      // reason it could not be read. Never a silently empty page.
      check(
        !!settled && (settled.end || settled.error !== null || settled.info !== detail.pageInfo),
        `"Load older" answers honestly: ${settled?.end ? 'the source has nothing older' : settled?.error ? `it said why not (${settled.error.slice(0, 60)})` : `more pages arrived (${detail.pageInfo} -> ${settled?.info})`} (${before} rows before)`,
      );
      await popup.screenshot({ path: path.join(shotsDir, 'popup-asset-activity-paged.png') });
    } else {
      check(
        detail.rows === 0 || detail.noOlder !== null || detail.pageInfo !== null,
        `with nothing older to fetch, the list still says where it stands (${detail.noOlder ?? detail.pageInfo ?? 'no rows'})`,
      );
      await popup.screenshot({ path: path.join(shotsDir, 'popup-asset-activity-paged.png') });
    }
    await popup.getByRole('button', { name: 'Back' }).first().click();
    await popupId('live-home').waitFor({ timeout: 10_000 });
  }

  // Back to the chain the popup was on before this block, so nothing after it
  // measures a list this section put there.
  await popupId('live-chain-switcher').click();
  await popupId('live-chain-option-evm:ethereum').click();
  for (let i = 0; i < 40; i++) {
    const t = await popupId('live-home').innerText().catch(() => '');
    if (/USDC/.test(t) && /USDT/.test(t)) break;
    await popup.waitForTimeout(500);
  }

  let popupScroll = await scrollGeometry();
  console.log(
    `note: popup asset list at 400x600 -> ${popupScroll?.rows} rows, ${popupScroll?.scrollH}px of content in ${popupScroll?.clientH}px`,
  );
  // If the account genuinely holds few enough tokens to fit, the overflowing
  // case is reached by SHORTENING THE CANVAS rather than by inventing rows: the
  // popup's 400x600 box is fixed in CSS, the wallet has whatever tokens the
  // chain reports, and a shorter box exercises exactly the same rules. Every
  // number measured afterwards is a real box in a real popup-mode document.
  let canvasHeight = 0;
  if (popupScroll && popupScroll.scrollH <= popupScroll.clientH) {
    // Take away JUST enough height that the rows no longer fit, and no more.
    // A fixed, much shorter canvas (this used to say a flat 430px) over-shoots
    // once the list is dense: it pushes the PINNED block past the panel as
    // well, which is a different case with its own fallback and would make the
    // measurements below say nothing about the chevron.
    //
    // How much is "just enough" cannot be read off the region: on a SHORT list
    // the centred layout hands the region exactly its content height and parks
    // the leftover in the two auto margins, so `clientH - scrollH` says 0 while
    // there is still slack to swallow the shortening (which is how a formula
    // here quietly stopped forcing the overflow the moment the popup's chrome
    // pass freed 45px). So step the canvas down and STOP at the first height
    // that genuinely overflows: minimal by construction, whatever the layout.
    await popup.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'canvas-probe';
      document.head.appendChild(s);
    });
    for (let h = 580; h >= 360; h -= 20) {
      await popup.evaluate((px) => {
        const s = document.getElementById('canvas-probe');
        if (s) s.textContent = `html, body, #root { height: ${px}px !important; min-height: ${px}px !important; }`;
      }, h);
      await popup.waitForTimeout(250);
      canvasHeight = h;
      popupScroll = await scrollGeometry();
      if (popupScroll && popupScroll.scrollH > popupScroll.clientH) break;
    }
  }
  check(
    !!popupScroll && popupScroll.scrollH > popupScroll.clientH,
    `popup asset list genuinely overflows (${popupScroll?.scrollH}px of rows in ${popupScroll?.clientH}px${canvasHeight ? `, canvas shortened to ${canvasHeight}px` : ' at the native 600px'})`,
  );
  check(
    popupScroll?.more === 'true' && popupScroll?.cueVisibility === 'visible',
    `the "more below" chevron is shown while the list has rows below the fold (data-more=${popupScroll?.more}, visibility ${popupScroll?.cueVisibility})`,
  );
  check(
    popupScroll?.cuePointerEvents === 'none',
    `the chevron is inert to the pointer, so it can never take a tap meant for a row (pointer-events: ${popupScroll?.cuePointerEvents})`,
  );
  check(
    !!popupScroll && popupScroll.cueTop >= popupScroll.regionBottom - 1,
    `the chevron sits BELOW the scroll region, in the screen's own padding band (cue top ${popupScroll?.cueTop} vs region bottom ${popupScroll?.regionBottom})`,
  );
  // The scrollbar itself: Chromium runs headless with OVERLAY scrollbars (no
  // layout width and auto-hidden), so a gutter cannot be asserted here — a
  // headed run of these same rules measures 8px. What IS assertable headless is
  // that the region no longer declares the standard scrollbar properties that
  // made Chromium ignore the ::-webkit-scrollbar rules, and that the thumb is
  // painted in the app accent rather than the near-invisible --border-strong.
  const scrollbarCss = await popup.evaluate(() => {
    const region = document.querySelector('.home-scroll');
    if (!region) return null;
    const cs = getComputedStyle(region);
    return { width: cs.scrollbarWidth, color: cs.scrollbarColor };
  });
  check(
    !!scrollbarCss && scrollbarCss.width !== 'thin',
    `the asset list leaves scrollbar-width alone so the ::-webkit-scrollbar rules apply in Chromium (scrollbar-width: ${scrollbarCss?.width})`,
  );
  await popup.screenshot({ path: path.join(shotsDir, 'popup-scroll-cue.png') });

  // Scrolled to the very end, the cue must be gone: nothing is below any more.
  await popup.evaluate(() => {
    const region = document.querySelector('.home-scroll');
    if (region) region.scrollTop = region.scrollHeight;
  });
  await popup.waitForTimeout(300);
  const atEnd = await scrollGeometry();
  check(
    atEnd?.more === 'false' && atEnd?.cueVisibility === 'hidden',
    `the chevron disappears at the end of the scroll (data-more=${atEnd?.more}, visibility ${atEnd?.cueVisibility}, scrollTop ${atEnd?.scrollTop} of ${atEnd?.scrollH - atEnd?.clientH})`,
  );
  await popup.screenshot({ path: path.join(shotsDir, 'popup-scroll-end.png') });

  // -------------------------------------------------------------------------
  // The notification banner: spacing, rotation, and the gateway image.
  // Driven entirely by the seeded feed (see notifFeed at the top of the file),
  // so none of it depends on what the live gateway happens to be publishing.
  // -------------------------------------------------------------------------
  /** Where the coin mark sits relative to the notice above it (or to the status
   *  row when there is none), plus the banner's own rotation state. */
  const heroGap = () =>
    popup.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const panel = q('[data-testid="live-tab-panel-assets"]');
      const status = q('[data-testid="live-home-status"]');
      const mark = q('[data-testid="live-hero-mark"]');
      const banner = q('[data-testid="live-notification"]');
      const counter = q('[data-testid="live-notification-count"]');
      if (!panel || !status || !mark) return null;
      const anchor = (banner ?? status).getBoundingClientRect();
      return {
        classes: panel.className,
        hasBanner: !!banner,
        gap: Math.round(mark.getBoundingClientRect().top - anchor.bottom),
        markTop: Math.round(mark.getBoundingClientRect().top),
        viewportH: window.innerHeight,
        index: counter ? Number(counter.getAttribute('data-index')) : null,
        total: counter ? Number(counter.getAttribute('data-total')) : null,
        banners: document.querySelectorAll('[data-testid="live-notification"]').length,
        title: q('[data-testid="live-notification-title"]')?.textContent ?? null,
      };
    });

  // (i) The baseline: no notice at all. The block is centred under the status
  //     row exactly as it was before this work, so the gap here is expected to
  //     be LARGE. It is measured only so the change below is a comparison
  //     rather than an assertion about a number in isolation.
  await popup.evaluate(() => {
    const region = document.querySelector('.home-scroll');
    if (region) region.scrollTop = 0;
  });
  const noNotice = await heroGap();
  check(
    !!noNotice && !noNotice.hasBanner && !/has-notice/.test(noNotice.classes),
    `with no notice the container carries no has-notice marker (${noNotice?.classes})`,
  );
  console.log(`note: with NO notice the coin mark sits ${noNotice?.gap}px under the status row (the centred layout)`);

  // (ii) Three notices, the first carrying a gateway image.
  notifFeed = {
    notifications: [
      {
        id: 'smoke-notice-1',
        title: 'Satori GO 1.4.0 is here',
        body: 'The one with a picture above it.',
        severity: 'info',
        dismissible: true,
        image: { id: NOTIF_IMAGE_ID, path: NOTIF_IMAGE_PATH, link: 'https://satorigo.app/' },
      },
      {
        id: 'smoke-notice-2',
        title: 'Scheduled maintenance',
        body: 'A deliberately longer body, so a rotation between notices of different lengths has something to jump on if the banner lets it.',
        severity: 'warning',
        dismissible: true,
      },
      {
        id: 'smoke-notice-3',
        title: 'New chain added',
        body: 'Short.',
        severity: 'update',
        dismissible: true,
        link: { url: 'https://satorigo.app/', label: 'Read more' },
      },
    ],
  };
  await openPopup();

  const withNotice = await heroGap();
  check(
    !!withNotice && withNotice.hasBanner && withNotice.banners === 1,
    `exactly one notice is on screen at a time (${withNotice?.banners} banner(s): "${withNotice?.title}")`,
  );
  check(
    !!withNotice && /has-notice/.test(withNotice.classes),
    `the container is marked has-notice while a notice is up (${withNotice?.classes})`,
  );
  check(
    !!withNotice && withNotice.gap < 80,
    `the coin mark hugs the notice instead of centring under it: ${withNotice?.gap}px between the banner's bottom and the mark's top (was ${noNotice?.gap}px of centred slack with no banner)`,
  );
  check(
    withNotice?.total === 3 && withNotice?.index === 0,
    `the banner says which of how many (${withNotice?.index !== null ? withNotice.index + 1 : '?'} of ${withNotice?.total})`,
  );

  // (iii) Pause on hover, and the image, measured while the rotation is held.
  await popup.getByTestId('live-notification').hover();
  await popup.waitForTimeout(4_200); // > NOTIF_ROTATE_MS (3s), so an unpaused banner would have moved on
  const hovered = await heroGap();
  check(
    hovered?.index === 0,
    `the rotation pauses while the pointer is over the banner (still notice ${hovered?.index !== null ? hovered.index + 1 : '?'} of ${hovered?.total} after 4.2s)`,
  );

  const imageState = await popup.evaluate(() => {
    const img = document.querySelector('[data-testid="live-notification-image"]');
    const anchor = document.querySelector('[data-testid="live-notification-image-link"]');
    if (!img) return { present: false };
    const r = img.getBoundingClientRect();
    const banner = document.querySelector('[data-testid="live-notification"]').getBoundingClientRect();
    return {
      present: true,
      src: img.getAttribute('src'),
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      loading: img.getAttribute('loading'),
      alt: img.getAttribute('alt'),
      objectFit: getComputedStyle(img).objectFit,
      height: Math.round(r.height),
      width: Math.round(r.width),
      bannerWidth: Math.round(banner.width),
      linked: !!anchor,
      target: anchor ? anchor.getAttribute('target') : null,
      rel: anchor ? anchor.getAttribute('rel') : null,
      csp: globalThis.__cspViolations ?? [],
    };
  });
  check(imageState.present, 'a notice carrying an image renders one');
  check(
    imageState.complete && imageState.naturalWidth > 0,
    `the image actually LOADED from the gateway host (naturalWidth ${imageState.naturalWidth}, src ${imageState.src})`,
  );
  check(
    (imageState.csp ?? []).length === 0,
    `no Content Security Policy violation on the page (${(imageState.csp ?? []).join('; ') || 'none'})`,
  );
  check(
    imageState.loading === 'lazy' && imageState.alt === '',
    `the image is lazy and decorative (loading=${imageState.loading}, alt="${imageState.alt}")`,
  );
  check(
    imageState.objectFit === 'cover' && imageState.height <= 122 && imageState.width >= imageState.bannerWidth - 30,
    `the image is a full-width cover band at the top of the banner (${imageState.width}x${imageState.height} in a ${imageState.bannerWidth}px banner, object-fit ${imageState.objectFit})`,
  );
  check(
    imageState.linked && imageState.target === '_blank' && /noopener/.test(imageState.rel ?? '') && /noreferrer/.test(imageState.rel ?? ''),
    `an image with a link opens it in a new tab with no opener (target ${imageState.target}, rel ${imageState.rel})`,
  );
  // THE CHECK THAT MATTERS MOST HERE. Send and Receive must never end up under
  // the bottom nav with no way to get at them. A picture on top of the coin
  // mark, the balance and the actions is exactly the pressure that can do it in
  // a fixed 600px popup: this column is PINNED, so before the fallback scroll
  // (see .app-content.home-pinned in global.css) anything that did not fit was
  // clipped outright. The invariant asserted is REACHABILITY, not "always in
  // view": whole where they sit, or whole once the panel is scrolled.
  const actionsReachable = async () =>
    popup.evaluate(() => {
      const panel = document.querySelector('[data-testid="live-tab-panel-assets"]');
      const send = document.querySelector('[data-testid="live-send"]');
      const receive = document.querySelector('[data-testid="live-receive"]');
      const nav = document.querySelector('.bottom-nav');
      if (!panel || !send || !receive) return null;
      const whole = () => {
        const p = panel.getBoundingClientRect();
        const b = Math.max(send.getBoundingClientRect().bottom, receive.getBoundingClientRect().bottom);
        const t = Math.min(send.getBoundingClientRect().top, receive.getBoundingClientRect().top);
        return { ok: t >= p.top - 1 && b <= p.bottom + 1, bottom: Math.round(b), panelBottom: Math.round(p.bottom) };
      };
      panel.scrollTop = 0;
      const atRest = whole();
      panel.scrollTop = panel.scrollHeight;
      const scrolled = whole();
      panel.scrollTop = 0;
      return {
        atRest: atRest.ok,
        scrolled: scrolled.ok,
        bottom: atRest.bottom,
        panelBottom: atRest.panelBottom,
        overflow: Math.round(panel.scrollHeight - panel.clientHeight),
        navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
      };
    });
  const actionsFit = await actionsReachable();
  check(
    !!actionsFit && (actionsFit.atRest || actionsFit.scrolled),
    `Send and Receive stay reachable with a picture on screen (${actionsFit?.atRest ? 'whole where they sit' : 'whole after scrolling'}: bottom ${actionsFit?.bottom}, panel ends ${actionsFit?.panelBottom}, ${actionsFit?.overflow}px of panel overflow, nav at ${actionsFit?.navTop})`,
  );
  // ...and nothing BELOW them is lost either. A 600px popup cannot show a
  // picture, the whole hero AND the token list at once, so the list is pushed
  // below the fold while the notice is up. What must not happen is that it
  // becomes unreachable: the panel falls back to scrolling (see
  // .app-content.home-pinned in global.css) and the list keeps a one-row floor,
  // so the Assets header, "Add token" and the rows are all a scroll away rather
  // than gone until the notice is closed.
  const reachable = await popup.evaluate(() => {
    const panel = document.querySelector('[data-testid="live-tab-panel-assets"]');
    if (!panel) return null;
    const overflow = Math.round(panel.scrollHeight - panel.clientHeight);
    panel.scrollTop = panel.scrollHeight;
    const p = panel.getBoundingClientRect();
    const add = document.querySelector('[data-testid="live-add-asset"]');
    const region = document.querySelector('.home-scroll');
    const a = add ? add.getBoundingClientRect() : null;
    return {
      panelOverflow: overflow,
      addVisible: !!a && a.top >= p.top - 1 && a.bottom <= p.bottom + 1,
      addTop: a ? Math.round(a.top) : null,
      panelTop: Math.round(p.top),
      panelBottom: Math.round(p.bottom),
      listHeight: region ? Math.round(region.clientHeight) : null,
    };
  });
  check(
    !!reachable && reachable.addVisible && (reachable.listHeight ?? 0) >= 60,
    `the token list is a scroll away, not gone: after scrolling the panel (${reachable?.panelOverflow}px of overflow) "Add token" is at ${reachable?.addTop} inside ${reachable?.panelTop}-${reachable?.panelBottom}, list region ${reachable?.listHeight}px`,
  );
  await popup.evaluate(() => {
    const panel = document.querySelector('[data-testid="live-tab-panel-assets"]');
    if (panel) panel.scrollTop = 0;
  });
  check(
    (await popup.getByTestId('live-notification-title').count()) === 1 &&
      (await popup.getByTestId('live-notification-dismiss').count()) === 1,
    'a notice with an image still shows its title and its close button',
  );
  await popup.screenshot({ path: path.join(shotsDir, 'popup-notification-image.png') });

  // (iv) Rotation, once the pointer leaves.
  await popup.mouse.move(0, 0);
  const seenIndexes = new Set([0]);
  for (let i = 0; i < 12; i++) {
    await popup.waitForTimeout(1_000);
    const g = await heroGap();
    if (g && g.index !== null) seenIndexes.add(g.index);
    if (seenIndexes.size === 3) break;
  }
  check(
    seenIndexes.size === 3,
    `the rotation cycles the whole matching set (saw ${[...seenIndexes].sort().map((i) => i + 1).join(', ')} of 3)`,
  );
  const rotated = await heroGap();
  check(rotated?.banners === 1, `still exactly one banner after rotating (${rotated?.banners})`);

  // (v) Dismissing the visible notice takes it out of the loop.
  const before = await heroGap();
  await popup.getByTestId('live-notification-dismiss').click();
  await popup.waitForTimeout(600);
  const after = await heroGap();
  check(
    after?.total === 2 && after?.banners === 1,
    `dismissing the visible notice drops it from the rotation (${before?.total} -> ${after?.total}), and one banner is still up`,
  );
  check(after?.title !== before?.title, `dismissal advances immediately ("${before?.title}" -> "${after?.title}")`);
  await popup.screenshot({ path: path.join(shotsDir, 'popup-notification-banner.png') });

  // (vi) NO LAYOUT JUMP ON ROTATION (owner, live with two notices: "the dots
  //      sit in different places as it rotates"). The cause was body length:
  //      a one-line notice and a three-line notice are different heights, the
  //      indicator rode at the end of the text, and the whole block moved every
  //      three seconds. So: three notices of deliberately different lengths, no
  //      pictures (a picture legitimately changes the height, and that case is
  //      covered above), and the indicator's own box is measured on each one.
  notifFeed = {
    notifications: [
      { id: 'smoke-jump-1', title: 'One line', body: 'Short.', severity: 'info', dismissible: true },
      {
        id: 'smoke-jump-2',
        title: 'Three lines',
        body: 'A middling body that wraps onto a second line and probably a third one as well, which is exactly the length difference the owner saw jumping.',
        severity: 'warning',
        dismissible: true,
      },
      {
        id: 'smoke-jump-3',
        title: 'Six lines',
        body: 'The longest of the three by a wide margin, long enough to wrap several times over in a 400px popup so that any height the banner takes from its body is unmistakable in the measurement, and long enough that a banner without a floor would be visibly taller here than on the one-line notice above.',
        severity: 'update',
        dismissible: true,
      },
    ],
  };
  await openPopup();
  /** The indicator's own box, the banner's box, and which notice is up. */
  const indicatorBox = () =>
    popup.evaluate(() => {
      const counter = document.querySelector('[data-testid="live-notification-count"]');
      const banner = document.querySelector('[data-testid="live-notification"]');
      if (!counter || !banner) return null;
      const c = counter.getBoundingClientRect();
      const b = banner.getBoundingClientRect();
      return {
        index: Number(counter.getAttribute('data-index')),
        total: Number(counter.getAttribute('data-total')),
        top: Math.round(c.top * 10) / 10,
        left: Math.round(c.left * 10) / 10,
        bannerTop: Math.round(b.top * 10) / 10,
        bannerHeight: Math.round(b.height * 10) / 10,
        title: document.querySelector('[data-testid="live-notification-title"]')?.textContent ?? '',
      };
    });
  const boxes = new Map();
  for (let i = 0; i < 24; i++) {
    const b = await indicatorBox();
    if (b && !boxes.has(b.index)) boxes.set(b.index, b);
    if (boxes.size === 3) break;
    await popup.waitForTimeout(600);
  }
  const sampled = [...boxes.values()];
  check(
    boxes.size === 3,
    `sampled all three notices of the jump test (${sampled.map((b) => `"${b.title}"`).join(', ') || 'none'})`,
  );
  const spread = (key) =>
    sampled.length ? Math.round((Math.max(...sampled.map((b) => b[key])) - Math.min(...sampled.map((b) => b[key]))) * 10) / 10 : -1;
  check(
    boxes.size === 3 && spread('top') <= 1 && spread('left') <= 1,
    `the rotation indicator does not move between notices (top varies by ${spread('top')}px, left by ${spread('left')}px across ${boxes.size} notices)`,
  );
  check(
    boxes.size === 3 && spread('bannerHeight') <= 1 && spread('bannerTop') <= 1,
    `and the banner itself does not resize or shift on a tick (height varies by ${spread('bannerHeight')}px, top by ${spread('bannerTop')}px)`,
  );
  // The price of a box that never jumps is that it is as tall as the LONGEST
  // notice in the set, permanently. That six-line body is deliberately more
  // than any real notice, so this is the worst case the layout has to survive,
  // and the invariant is the same one as above: reachable, not necessarily
  // in view. (Headed Chromium wraps that body onto one more line than headless
  // does, which is exactly the sort of margin a hard "always in view" assertion
  // could not survive.)
  const actionsFitTall = await actionsReachable();
  const tallBanner = await popup.evaluate(() => {
    const banner = document.querySelector('[data-testid="live-notification"]');
    return banner ? Math.round(banner.getBoundingClientRect().height) : null;
  });
  check(
    !!actionsFitTall && (actionsFitTall.atRest || actionsFitTall.scrolled),
    `Send and Receive stay reachable under a banner sized to a six-line notice (${tallBanner}px banner, ${actionsFitTall?.atRest ? 'whole where they sit' : `whole after scrolling ${actionsFitTall?.overflow}px`})`,
  );
  await popup.screenshot({ path: path.join(shotsDir, 'popup-notification-rotation.png') });

  // (vii) Reduced motion: no auto-advance at all. Emulated at the OS level,
  //       which is exactly what App.tsx folds into data-reduced-motion.
  await popup.emulateMedia({ reducedMotion: 'reduce' });
  await openPopup();
  check(
    await popup.evaluate(() => document.documentElement.dataset.reducedMotion === 'true'),
    'reduced motion is stamped on the document when the OS asks for it',
  );
  const reducedStart = await heroGap();
  await popup.waitForTimeout(7_000); // two full rotation periods
  const reducedLater = await heroGap();
  check(
    !!reducedStart && !!reducedLater && reducedStart.index === reducedLater.index && reducedLater.index === 0,
    `under reduced motion the banner does NOT auto-advance (index ${reducedStart?.index} -> ${reducedLater?.index} over 7s)`,
  );
  check(
    reducedLater?.banners === 1 && reducedLater?.total === 3,
    `and it still shows the first notice with its counter (${reducedLater?.index !== null ? reducedLater.index + 1 : '?'} of ${reducedLater?.total})`,
  );
  await popup.emulateMedia({ reducedMotion: null });

  // (viii) REV: the owner can resubmit a notice. Dismiss the one on screen at
  //        rev 0, then republish the same id at rev 1: it must come BACK, while
  //        the two the user never touched are unaffected. This is the whole
  //        point of keying the dismissed set by `id@rev` rather than by id.
  await popup.emulateMedia({ reducedMotion: null });
  await openPopup();
  const beforeRev = await heroGap();
  await popup.getByTestId('live-notification').hover(); // hold the rotation still
  await popup.waitForTimeout(300);
  const dismissTarget = await heroGap();
  await popup.getByTestId('live-notification-dismiss').click();
  await popup.mouse.move(0, 0);
  await popup.waitForTimeout(800);
  const afterRev = await heroGap();
  check(
    afterRev?.total === 2,
    `a dismissed notice leaves the rotation (${beforeRev?.total} -> ${afterRev?.total}, closed "${dismissTarget?.title}")`,
  );
  // Republish the SAME ids, bumping only the one that was closed.
  const bumpedId = ['smoke-jump-1', 'smoke-jump-2', 'smoke-jump-3'][dismissTarget?.index ?? 0];
  notifFeed = {
    notifications: notifFeed.notifications.map((n) => (n.id === bumpedId ? { ...n, rev: 1 } : n)),
  };
  await openPopup();
  const afterBump = await heroGap();
  check(
    afterBump?.total === 3,
    `bumping that notice's rev brings it back for a user who had closed it (${afterRev?.total} -> ${afterBump?.total} after rev 0 -> 1 on ${bumpedId})`,
  );

  // -------------------------------------------------------------------------
  // THE TIGHTEST CASE THERE IS: a banner AND the dense list, together, in the
  // fixed 400x600 popup. The banner is top-anchored and the list is what pays
  // for it, so this is where "six rows" turns into "however many are left" and
  // where Send / Receive would go under the nav first if the density had been
  // bought from the wrong place. A notice is already up from (viii); the chain
  // goes back to Base, which is the long list, and the feed is narrowed to ONE
  // ordinary notice so the measurement is not at the mercy of which of a
  // rotating three happens to be up when it runs.
  // -------------------------------------------------------------------------
  notifFeed = {
    notifications: [
      {
        id: 'smoke-dense-notice',
        title: 'A notice over the dense list',
        body: 'An ordinary two-line notice, which is what most of them are.',
        severity: 'info',
        dismissible: true,
      },
    ],
  };
  await openPopup();
  await popupId('live-chain-switcher').click();
  await popupId('live-chain-option-evm:base').click();
  for (let i = 0; i < 40; i++) {
    if ((await popup.locator('[data-testid^="live-asset-row-"]').count()) >= 6) break;
    await popup.waitForTimeout(500);
  }
  await popup.waitForTimeout(600);
  const banded = await homeLayout();
  const bandedGap = await heroGap();
  console.log(
    `note: popup home at 400x600 WITH a notice -> list ${banded.region?.h}px, ${banded.rowsFullyVisible} rows fully visible (pitch ${banded.rowPitch}px), hero ${banded.hero?.h}px`,
  );
  check(
    !!bandedGap && bandedGap.hasBanner && /home-tight/.test(banded.classes),
    `a notice and the dense list share the popup (banner ${bandedGap?.hasBanner}, ${banded.classes})`,
  );
  check(
    banded.rowsFullyVisible >= 3,
    `a notice costs rows but never the list: ${banded.rowsFullyVisible} rows still fully visible under it (${banded.region?.h}px of region)`,
  );
  // THE OWNER'S ASK, both halves in one comparison against the no-notice
  // measurement taken further up (same chain, same viewport, same tokens): with
  // nothing to announce the whole block sits higher and the list is longer;
  // when a notice arrives everything below it moves DOWN and the list, not the
  // hero and not the actions, is what pays. The chrome around it does not move
  // at all: `frame-tight` does not depend on whether there is a notice, so the
  // header and the tab bar are the same boxes in both states and the only shift
  // is the banner's own height entering the flow.
  check(
    !!banded.hero &&
      !!layout.hero &&
      banded.hero.top > layout.hero.top &&
      banded.region.h < layout.region.h &&
      Math.abs(banded.hero.h - layout.hero.h) <= 1 &&
      Math.abs(banded.actions.h - layout.actions.h) <= 1,
    `a notice moves the block DOWN and the list gives up the room (hero top ${layout.hero?.top} -> ${banded.hero?.top}, list ${layout.region?.h} -> ${banded.region?.h}px, hero and actions unchanged at ${banded.hero?.h}/${banded.actions?.h}px)`,
  );
  check(
    !!banded.header &&
      !!layout.header &&
      banded.header.h === layout.header.h &&
      banded.nav.h === layout.nav.h &&
      /frame-tight/.test(banded.frameClasses),
    `the chrome does not flinch when a notice arrives (header ${layout.header?.h} -> ${banded.header?.h}px, nav ${layout.nav?.h} -> ${banded.nav?.h}px)`,
  );
  check(
    !!banded.actions && banded.actions.bottom <= banded.navTop,
    `Send / Receive stay whole and clear of the nav under a notice (actions bottom ${banded.actions?.bottom}, nav top ${banded.navTop})`,
  );
  const bandedClipped = banded.rowParts.flatMap((r) =>
    ['mark', 'symbol', 'amount', 'fiat', 'chip']
      .filter((k) => r[k] && (r[k].top < r.row.top - 0.5 || r[k].bottom > r.row.bottom + 0.5))
      .map((k) => `${r.name}.${k}`),
  );
  check(
    bandedClipped.length === 0,
    `the rows under a notice are still whole${bandedClipped.length ? ` (clipped: ${bandedClipped.join(', ')})` : ''}`,
  );
  await popup.screenshot({ path: path.join(shotsDir, 'popup-home-banner-many-tokens.png') });
  // -------------------------------------------------------------------------
  // (viii-b) THE BANNER IS AN ATTRIBUTED MESSAGE, AND NEVER A TRAP
  //          (security review, 2026-08-25).
  //
  // The feed is published straight into the wallet's own chrome, so this runs
  // the worst notice the review produced: a full-screen "ACTION REQUIRED"
  // demand, a link labelled with OUR domain but pointing somewhere else, and
  // `dismissible: false` so it has no X. What must be true of it on a real
  // extension page: it says whose message it is, it says the sentence that
  // makes the phishing ask self-refuting, it shows where the button really
  // goes, and the user can always get back to their balance.
  // -------------------------------------------------------------------------
  notifFeed = {
    notifications: [
      {
        id: 'smoke-attribution',
        title: 'ACTION REQUIRED: verify your wallet to keep access to your funds',
        body: 'Your wallet must be verified within 24 hours or access will be suspended. This is the notice the security review produced, published verbatim.',
        severity: 'warning',
        dismissible: false,
        link: { url: 'https://claims.example.net/verify-wallet', label: 'satorigo.app' },
      },
    ],
  };
  await openPopup();
  /** What the banner SAYS about itself, plus how much room it is taking. */
  const bannerState = () =>
    popup.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const text = (s) => q(s)?.textContent ?? null;
      const banner = q('[data-testid="live-notification"]');
      const region = q('.home-scroll');
      const rows = [...document.querySelectorAll('[data-testid^="live-asset-row-"]')];
      const rr = region?.getBoundingClientRect();
      return {
        present: !!banner,
        collapsed: banner?.getAttribute('data-collapsed') ?? null,
        height: banner ? Math.round(banner.getBoundingClientRect().height) : null,
        from: text('[data-testid="live-notification-from"]'),
        safety: text('[data-testid="live-notification-safety"]'),
        title: text('[data-testid="live-notification-title"]'),
        linkLabel: text('[data-testid="live-notification-link"]'),
        linkHost: text('[data-testid="live-notification-link-host"]'),
        linkHref: q('[data-testid="live-notification-link"]')?.getAttribute('href') ?? null,
        hasDismiss: !!q('[data-testid="live-notification-dismiss"]'),
        hasCollapse: !!q('[data-testid="live-notification-collapse"]'),
        hasExpand: !!q('[data-testid="live-notification-expand"]'),
        rowsFullyVisible: rr
          ? rows.filter((el) => {
              const b = el.getBoundingClientRect();
              return b.top >= rr.top - 0.5 && b.bottom <= rr.bottom + 0.5;
            }).length
          : 0,
        regionH: rr ? Math.round(rr.height) : null,
      };
    });
  const hostile = await bannerState();
  check(
    hostile.from === 'Message from Satori Network',
    `the notice is attributed, in words the feed cannot write ("${hostile.from}")`,
  );
  check(
    hostile.safety === 'Satori GO will never ask for your recovery phrase.',
    `and carries the fixed safety line under it ("${hostile.safety}")`,
  );
  check(
    hostile.linkHost === 'claims.example.net' && hostile.linkHref === 'https://claims.example.net/verify-wallet',
    `the link shows the host it REALLY goes to, next to a label claiming otherwise (label "${hostile.linkLabel}", host shown "${hostile.linkHost}")`,
  );
  check(
    !hostile.hasDismiss && hostile.hasCollapse,
    `a dismissible:false notice has no X, but does have a way out (collapse ${hostile.hasCollapse})`,
  );
  await popup.screenshot({ path: path.join(shotsDir, 'popup-notification-attribution.png') });

  await popupId('live-notification-collapse').click();
  await popup.waitForTimeout(400);
  const folded = await bannerState();
  check(
    folded.collapsed === 'true' && folded.height <= 40 && folded.height < hostile.height / 2,
    `it collapses to a single line instead of holding the screen (${hostile.height}px -> ${folded.height}px)`,
  );
  check(
    folded.from === null && folded.safety === null && /Message from Satori Network/.test(
      (await popupId('live-notification').innerText()) || '',
    ),
    'the collapsed line is still attributed, so even one line is not the wallet talking',
  );
  check(
    folded.rowsFullyVisible > hostile.rowsFullyVisible,
    `and the balance list gets the room back (${hostile.rowsFullyVisible} -> ${folded.rowsFullyVisible} rows fully visible, region ${hostile.regionH} -> ${folded.regionH}px)`,
  );
  await popup.screenshot({ path: path.join(shotsDir, 'popup-notification-collapsed.png') });

  await popupId('live-notification-expand').click();
  await popup.waitForTimeout(400);
  const unfolded = await bannerState();
  check(
    unfolded.collapsed === 'false' && unfolded.from === 'Message from Satori Network',
    `and it comes back on a tap, whole (${folded.height}px -> ${unfolded.height}px)`,
  );

  // The no-notice baseline, captured for the record: the same popup on the same
  // dense chain, with an empty feed, still shows its seven rows. Nothing the
  // banner grew was paid for out of the list.
  notifFeed = { notifications: [] };
  await openPopup();
  for (let i = 0; i < 20; i++) {
    if ((await popup.locator('[data-testid^="live-asset-row-"]').count()) >= 7) break;
    await popup.waitForTimeout(500);
  }
  const noNoticeRows = await bannerState();
  check(
    !noNoticeRows.present && noNoticeRows.rowsFullyVisible >= 7,
    `with no notice the list is untouched: ${noNoticeRows.rowsFullyVisible} rows fully visible in ${noNoticeRows.regionH}px`,
  );
  await popup.screenshot({ path: path.join(shotsDir, 'popup-no-notice-rows.png') });

  // The active chain is shared with the side panel opened below, and that
  // section is about a SHORT list centring in 900px. Hand it back the chain it
  // was written against instead of Base's two dozen rows.
  await popupId('live-chain-switcher').click();
  await popupId('live-chain-option-evm:ethereum').click();
  for (let i = 0; i < 40; i++) {
    const t = await popupId('live-home').innerText().catch(() => '');
    if (/USDC/.test(t) && /USDT/.test(t)) break;
    await popup.waitForTimeout(500);
  }
  await popup.close();

  // -------------------------------------------------------------------------
  // (ix) THE SPACING FIX, WHERE IT IS ACTUALLY VISIBLE.
  //
  // The popup above cannot show it: four token rows already outgrow a 600px
  // box, so both auto margins are collapsed and the hero is top-anchored with
  // or without a notice. The complaint ("too much space between the banner and
  // the coin") is about SHORT content, where the centring is live: the notice
  // is top-anchored, so the block below it used to centre in ALL the height
  // left UNDER it, and half of that slack ended up between the two.
  //
  // So the same A/B is run in the side panel at 420x900, where the same four
  // rows fit with room to spare. `above` and `below` are the two auto margins.
  // -------------------------------------------------------------------------
  const tall = await context.newPage();
  await tall.setViewportSize({ width: 420, height: 900 });
  const tallGeometry = () =>
    tall.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const panel = q('[data-testid="live-tab-panel-assets"]');
      const status = q('[data-testid="live-home-status"]');
      const hero = q('.home-hero-wrap');
      const scroll = q('.home-scroll');
      const mark = q('[data-testid="live-hero-mark"]');
      const banner = q('[data-testid="live-notification"]');
      if (!panel || !status || !hero || !scroll || !mark) return null;
      const cs = getComputedStyle(panel);
      const p = panel.getBoundingClientRect();
      const h = hero.getBoundingClientRect();
      const sc = scroll.getBoundingClientRect();
      // `above` must be the AUTO MARGIN alone, so the element it is measured
      // from contributes its own authored margin-bottom and that is subtracted:
      // the status row's 6px, or the banner's 12px when one is up. Without that
      // the banner's own margin reads as leftover space that was never there.
      const anchorEl = banner ?? status;
      const anchorMb = parseFloat(getComputedStyle(anchorEl).marginBottom) || 0;
      const anchor = anchorEl.getBoundingClientRect();
      return {
        classes: panel.className,
        hasBanner: !!banner,
        above: Math.round(h.top - anchor.bottom - anchorMb),
        below: Math.round(p.bottom - parseFloat(cs.paddingBottom) - sc.bottom),
        gap: Math.round(mark.getBoundingClientRect().top - anchor.bottom),
      };
    });
  /** Open the side panel page and get past the lock. */
  const openTall = async () => {
    await tall.goto(`chrome-extension://${id}/index.html?panel=1`);
    await tall.getByTestId('live-home').or(tall.getByTestId('live-lock')).first().waitFor({ timeout: 20_000 });
    if (await tall.getByTestId('live-lock').count()) {
      await tall.getByTestId('live-unlock').fill('live-pass-1234');
      await tall.getByRole('button', { name: /^Unlock$/ }).click();
    }
    await tall.getByTestId('live-home').waitFor({ timeout: 30_000 });
    await tall.waitForTimeout(1_500);
  };

  notifFeed = { notifications: [] };
  await openTall();
  const tallPlain = await tallGeometry();
  check(
    !!tallPlain && !tallPlain.hasBanner && tallPlain.above > 40 && Math.abs(tallPlain.above - tallPlain.below) <= 1,
    `with no notice the block is still DEAD CENTRED at 420x900 (${tallPlain?.above}px above, ${tallPlain?.below}px below): yesterday's behaviour is untouched`,
  );

  notifFeed = {
    notifications: [
      {
        id: 'smoke-spacing-1',
        title: 'A notice, and the coin right under it',
        body: 'The block used to centre in everything left below this.',
        severity: 'info',
        dismissible: true,
      },
    ],
  };
  await openTall();
  const tallNotice = await tallGeometry();
  check(
    !!tallNotice && tallNotice.hasBanner && /has-notice/.test(tallNotice.classes),
    `the tall layout is marked has-notice too (${tallNotice?.classes})`,
  );
  check(
    !!tallNotice && tallNotice.above <= 1,
    `the top auto margin is gone with a notice up: the hero hugs it (${tallNotice?.above}px above, was ${tallPlain?.above}px)`,
  );
  check(
    !!tallNotice && tallNotice.gap < 80,
    `the coin mark sits ${tallNotice?.gap}px under the banner, not half the leftover height (${tallPlain?.above}px of it before)`,
  );
  check(
    !!tallNotice && tallNotice.below > 40,
    `and the bottom margin still absorbs all the slack (${tallNotice?.below}px below the block)`,
  );
  await tall.screenshot({ path: path.join(shotsDir, 'panel-notification-spacing.png') });
  await tall.close();
} catch (err) {
  console.log('FAIL  unexpected error:', String(err).split('\n')[0]);
  failures++;
  await shot('evm-smoke-failure.png').catch(() => {});
} finally {
  await context.close();
}

console.log(failures === 0 ? '\nEVM SMOKE: all checks passed' : `\nEVM SMOKE: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
