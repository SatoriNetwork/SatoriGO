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
// the header "more" menu (live-menu-btn). The lock screen has TWO views: the
// password view names the one wallet being unlocked (live-lock-selected) and
// opens the wallet list (live-lock-wallets, last-used preselected) behind
// "Change" (live-lock-change).
// No funds, no broadcast.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The STORE build (no EVM engine): dist/store/chrome since 2026-08-25. It used
// to share dist/chrome with the EVM build, which is how a gate could leave the
// owner's loaded extension without EVM for a minute (see scripts/build.mjs).
const distDir = path.join(root, 'dist', 'store', 'chrome');
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

// Every URL this extension asks for. Recorded on the CONTEXT, not the page, so
// it survives the "open in a separate window" step (which replaces `page`) and
// also sees what the service worker fetches. Used by the price checks below:
// a store build reads its prices through the Satori GO gateway now, and must
// contact no exchange directly.
const requested = [];
context.on('request', (r) => requested.push(r.url()));
const askedFor = (needle) => requested.filter((u) => u.includes(needle));
// The gateway this dist was built against (scripts/build.mjs stamps it).
const gateway = (() => {
  try {
    const g = JSON.parse(readFileSync(path.join(distDir, 'build-info.json'), 'utf8')).gatewayUrl;
    return typeof g === 'string' ? g.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
})();
console.log(gateway ? `build: prices via ${gateway}/prices` : 'build: no gateway (prices come from the direct sources)');

// Every WebSocket the wallet opens, in the order it opened them. This is the
// assertable surface for "which Electrum endpoint did it TRY first": Playwright
// exposes websockets per PAGE (there is no context-level event), so each page
// is wired as it appears — the run swaps `page` when it detaches the popup into
// its own window.
const sockets = [];
const watchSockets = (pg) => {
  pg.on('websocket', (ws) => {
    const rec = { url: ws.url(), failed: false, closed: false };
    ws.on('socketerror', () => { rec.failed = true; });
    ws.on('close', () => { rec.closed = true; });
    sockets.push(rec);
  });
};
watchSockets(page);
context.on('page', watchSockets);
const electrumSockets = () => sockets.filter((s) => /^wss?:/i.test(s.url));
/** The gateway's Electrum bridge for a chain in THIS build ('' without one). */
const bridgeUrl = (chainKey) => (gateway ? `${gateway.replace(/^http/i, 'ws')}/electrum/${chainKey}` : '');
const sameUrl = (a, b) => !!a && !!b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * WALLET CREATION: the recovery-phrase backup step, end to end.
 *
 * Every CREATED wallet (never an import) now shows the words, then asks three of
 * them back at positions it picks at random, before the wallet opens. This
 * drives that whole step: it reads the phrase off the screen while it is still
 * visible, ticks "I saved it", continues, works out which three blanks the quiz
 * is asking for from the live-mnemonic-slot-<position> testids, taps the
 * matching chips and submits.
 *
 * `wrongFirst` answers WRONG once on purpose first (the right words rotated into
 * the wrong blanks, since the position is part of the answer) and asserts the
 * inline error, the cleared blanks and that the wallet did NOT open. That is the
 * assertion that matters: a quiz which accepts anything is worse than no quiz,
 * because it tells the user their backup is good when nothing checked it.
 */
async function answerMnemonicQuiz(pg, { label = 'create', wrongFirst = false, shot = '' } = {}) {
  const id = (t) => pg.getByTestId(t);

  // The words, position by position, read BEFORE continuing: the quiz hides
  // them (that is the point of it), so this is the only chance to see them.
  await id('live-mnemonic').waitFor({ timeout: 30_000 });
  const words = new Map();
  for (const el of await pg.locator('[data-testid^="live-mnemonic-word-"]').all()) {
    const tid = (await el.getAttribute('data-testid')) || '';
    words.set(Number(tid.replace('live-mnemonic-word-', '')), (await el.innerText()).trim());
  }
  check(words.size >= 12, `${label}: recovery phrase shown once (${words.size} words)`);

  await id('live-mnemonic-saved').click({ timeout: 15_000 });
  await pg.getByRole('button', { name: /Continue to wallet/i }).click({ timeout: 10_000 });
  await id('live-mnemonic-verify').waitFor({ timeout: 20_000 });
  check((await id('live-mnemonic').count()) === 0, `${label}: the quiz hides the words while it asks for them`);

  const positions = [];
  for (const el of await pg.locator('[data-testid^="live-mnemonic-slot-"]').all()) {
    const tid = (await el.getAttribute('data-testid')) || '';
    positions.push(Number(tid.replace('live-mnemonic-slot-', '')));
  }
  const answers = positions.map((p) => words.get(p));
  check(
    positions.length === 3 && answers.every((w) => !!w),
    `${label}: quiz asks for 3 words of THIS phrase (#${positions.join(', #')})`,
  );
  // Untouched quiz: empty blanks + the full bank, which is what the user meets.
  if (shot) await pg.screenshot({ path: path.join(shotsDir, shot) });

  // Tap one chip per wanted word. Chips are re-read every time because a used
  // one is disabled, which is what makes a repeated word ('abandon' twice)
  // resolve to a second, still-available chip rather than the same one twice.
  const fill = async (wanted) => {
    for (const word of wanted) {
      let picked = null;
      for (const el of await pg.locator('[data-testid^="live-mnemonic-choice-"]').all()) {
        if ((await el.innerText()).trim() === word && !(await el.isDisabled())) { picked = el; break; }
      }
      if (!picked) throw new Error(`mnemonic quiz: no chip left in the bank for "${word}"`);
      await picked.click({ timeout: 10_000 });
    }
  };

  if (wrongFirst) {
    const rotated = [answers[1], answers[2], answers[0]];
    if (rotated.join(' ') !== answers.join(' ')) {
      await fill(rotated);
      await id('live-mnemonic-verify-submit').click({ timeout: 10_000 });
      await id('live-mnemonic-verify-error').waitFor({ timeout: 10_000 });
      check(true, `${label}: WRONG words are refused with an inline error`);
      check((await id('live-home').count()) === 0, `${label}: wrong words do NOT open the wallet`);
      const left = [];
      for (const p of positions) left.push((await id(`live-mnemonic-slot-${p}`).innerText()).trim());
      check(left.every((t) => t === ''), `${label}: a wrong answer clears the blanks for a retry`);
    } else {
      // Only reachable on a phrase whose three asked words are all identical.
      check(true, `${label}: wrong-answer check skipped (all three asked words are the same)`);
    }
  }

  await fill(answers);
  await id('live-mnemonic-verify-submit').click({ timeout: 10_000 });
  await id('live-mnemonic-verify').waitFor({ state: 'detached', timeout: 30_000 });
  check(true, `${label}: the right words confirm the backup and open the wallet`);
}

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

  // ONE address on Home (MetaMask): it lives in the header, under the wallet
  // name, and clicking it copies the WHOLE address (the line itself is
  // truncated). It is a SIBLING of the switcher button, never a child of it —
  // a button inside a button is invalid HTML, and copying must not also open
  // the wallet menu. The old duplicate (address + copy icon beside the block
  // pill) is gone; the chain homepage link stays there.
  check(
    (await page.locator('[data-testid="live-wallet-switcher"] [data-testid="live-address"]').count()) === 0,
    'one address: the header address is its own button, not inside the wallet-switcher button',
  );
  check(
    (await page.locator('.app-header [data-testid="live-address"]').count()) === 1 &&
      (await page.locator('[data-testid="live-chain-homepage"]').count()) === 1,
    'one address: it sits in the header, and the chain homepage link stays on the sync row',
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await page.bringToFront();
  await byId('live-address').click({ timeout: 10_000 });
  check(
    (await byId('live-wallet-dropdown').count()) === 0,
    'copy address: clicking it does NOT open the wallet menu',
  );
  // Read the confirmation FIRST — it reverts after ~1.2s. The write is async
  // (and only then does the label flip), so poll inside that window instead of
  // reading once and racing the clipboard.
  let copiedLabel = '';
  for (let i = 0; i < 16; i++) {
    copiedLabel = (await byId('live-address').innerText()).trim();
    if (/copied/i.test(copiedLabel)) break;
    await page.waitForTimeout(50);
  }
  const clip = (await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))).trim();
  check(/copied/i.test(copiedLabel), `copy address: the line confirms the copy ("${copiedLabel}")`);
  // The clipboard must hold the WHOLE address, i.e. the thing whose 8+6
  // truncation is exactly what the header shows.
  const shortOf = (full) => (full.length <= 16 ? full : `${full.slice(0, 8)}…${full.slice(-6)}`);
  check(
    clip.length > 16 && shortOf(clip) === addr,
    `copy address: the FULL address landed on the clipboard (${clip})`,
  );
  let revertedLabel = '';
  for (let i = 0; i < 20; i++) {
    revertedLabel = (await byId('live-address').innerText()).trim();
    if (revertedLabel === addr) break;
    await page.waitForTimeout(150);
  }
  check(
    revertedLabel === addr,
    'copy address: the line goes back to the address after the confirmation',
  );

  // Poll the pill text up to 30s for a real "Block <height>" label.
  let pill = '';
  for (let i = 0; i < 30; i++) {
    pill = (await page.locator('[data-testid="live-network-pill"]').innerText().catch(() => '')) || '';
    if (/block\s*[\d,]/i.test(pill)) break;
    await page.waitForTimeout(1000);
  }
  check(/block\s*[\d,]/i.test(pill), `live network reached real chain: "${pill.replace(/\s+/g, ' ').trim()}"`);

  // --- Electrum through the Satori GO gateway (1.4.0) -----------------------
  // A gateway build tries the BRIDGE first on Evrmore
  // (wss://<gateway>/electrum/evr) and keeps the two public evrmorecoin.org
  // nodes behind it. Both outcomes are a PASS here on purpose: if the bridge
  // answers it serves the sync, and if it does not, the public Evrmore pool
  // carries it — the block height just asserted above is that sync either way.
  // That failover IS the designed behaviour, not a degraded run. The line
  // printed below says which of the two actually happened, so a green run is
  // never ambiguous.
  const evrBridge = bridgeUrl('evr');
  const attempts = electrumSockets();
  console.log(
    `  [electrum] attempts: ${
      attempts.length
        ? attempts.map((s) => `${s.url}${s.failed ? ' (socket error)' : s.closed ? ' (closed)' : ''}`).join(' -> ')
        : 'none seen on this page'
    }`,
  );
  if (gateway) {
    check(
      attempts.length > 0 && sameUrl(attempts[0].url, evrBridge),
      `electrum: the FIRST connection attempt went to the gateway bridge (${attempts[0]?.url ?? 'no socket seen'})`,
    );
    const served = attempts.find((s) => !s.failed && !s.closed) ?? attempts[attempts.length - 1];
    check(!!served, `electrum: an endpoint served the EVR sync -> ${served?.url ?? 'none'}`);
    console.log(
      sameUrl(served?.url, evrBridge)
        ? '  [electrum] EVR was served by the GATEWAY BRIDGE'
        : '  [electrum] EVR was served by a PUBLIC FALLBACK; the bridge did not answer (designed failover)',
    );
  } else {
    check(true, 'electrum: no gateway in this build, the public pool is used directly (bridge checks skipped)');
  }

  // 1.9.0 replaced the shouting red LIVE banner with a connection LED; the
  // header cleanup then folded that LED into the block pill's own dot (the
  // brand-row copy duplicated it), so live-led now lives ON the pill. Same
  // testid + data-state contract; 'stale' joined the valid states when the
  // wallet learned to say a chain has stopped producing blocks.
  check((await byId('live-led').count()) === 1, 'connection LED present (on the block pill)');
  const ledState = (await byId('live-led').getAttribute('data-state')) || '';
  check(
    ['connected', 'syncing', 'offline', 'stale'].includes(ledState),
    `LED exposes a connection state (${ledState})`,
  );
  check(
    (await page.locator('[data-testid="live-home"] .banner.danger').count()) === 0,
    'red danger banner removed from live home',
  );
  const homeText = await byId('live-home').innerText();
  check(!/LIVE — Real EVRmore/i.test(homeText), 'red LIVE wording removed from live home');

  // Owner-authored notification banner. The live gateway may publish none (or
  // not carry the /notifications route yet), which the wallet handles by showing
  // NO banner and surfacing no error, so NOTHING here depends on live content:
  // it asserts that home renders clean whatever the feed says. The behaviour
  // that needs a notice on screen (the tightened spacing, the rotation between
  // several, the gateway image) is driven from a SEEDED feed in
  // scripts/evm-extension-smoke.mjs, where the answer is not up to the weather.
  const liveNotifCount = await page.locator('[data-testid="live-notification"]').count();
  check(liveNotifCount <= 1, `at most one notification banner on home (${liveNotifCount})`);
  if (liveNotifCount === 0) {
    check(true, 'no notification banner when the gateway publishes none (home renders clean)');
  } else {
    // A live notice sits between the Block/Synced status row and the centred
    // hero block (owner's placement 2026-08-25), as a direct child of the tab
    // panel, never as a stray or duplicated banner somewhere else.
    const placed = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="live-tab-panel-assets"]');
      const banner = document.querySelector('[data-testid="live-notification"]');
      const status = document.querySelector('[data-testid="live-home-status"]');
      const heroWrap = panel?.querySelector(':scope > .home-hero-wrap');
      if (!panel || !banner || !status || !heroWrap) return null;
      const kids = [...panel.children];
      return {
        directChild: banner.parentElement === panel,
        afterStatus: kids.indexOf(status) < kids.indexOf(banner),
        beforeHero: kids.indexOf(banner) < kids.indexOf(heroWrap),
        marked: /has-notice/.test(panel.className),
      };
    });
    check(
      !!placed && placed.directChild && placed.afterStatus && placed.beforeHero && placed.marked,
      `a live notification banner sits under the status row, above the hero, and marks the container has-notice (${JSON.stringify(placed)})`,
    );
  }

  // The "more below" scroll affordance is always in the DOM on the assets tab
  // and answers with an attribute; this asserts it agrees with the region's own
  // geometry, whatever this wallet happens to hold. The overflowing case is
  // measured in scripts/evm-extension-smoke.mjs, where an account with enough
  // tokens to overflow a 400x600 popup exists.
  const cueAgrees = await page.evaluate(() => {
    const region = document.querySelector('.home-scroll');
    const cue = document.querySelector('[data-testid="live-home-scroll-cue"]');
    if (!region || !cue) return null;
    const left = region.scrollHeight - region.scrollTop - region.clientHeight;
    return { left: Math.round(left), more: cue.getAttribute('data-more') === 'true' };
  });
  check(
    !!cueAgrees && cueAgrees.more === (cueAgrees.left > 2),
    `the "more below" chevron agrees with the list's own geometry (${cueAgrees?.left}px below the fold, chevron ${cueAgrees?.more ? 'shown' : 'hidden'})`,
  );

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
  // live-balance-EVR is the ASSET ROW and must be UNIQUE now (the hero above it
  // used to duplicate this testid and forced .first() workarounds everywhere;
  // the hero is live-balance-hero). The bare waitFor is strict-mode: it throws
  // if the duplicate ever comes back.
  await page.locator('[data-testid="live-balance-EVR"]').waitFor({ timeout: 20_000 });
  check((await page.locator('[data-testid="live-balance-EVR"]').count()) === 1, 'EVR balance row renders exactly once (real read)');
  check((await page.locator('[data-testid="live-balance-hero"]').count()) === 1, 'hero balance has its own testid (no duplicate with the EVR row)');
  check((await page.locator('[data-testid="live-balance-SATORI"]').count()) === 0, 'no phantom LEGACY SATORI row');
  await page.locator('[data-testid="live-balance-SATORIEVR"]').first().waitFor({ timeout: 20_000 });
  check(
    (await page.locator('[data-testid="live-balance-SATORIEVR"]').count()) === 1,
    'SATORIEVR is pinned by default (no "Add token" needed)',
  );

  // NO row carries a remove control any more: removing an asset lives on its
  // detail screen, one deliberate step away from a mis-tap in a scrolling list.
  check(
    (await page.locator('[data-testid^="live-remove-asset-"]').count()) === 0,
    'no asset row carries an inline remove (x) control',
  );

  // EVR and SATORIEVR are the two assets the wallet is FOR, so even their DETAIL
  // screens offer no remove: protection is a property of the asset, not of which
  // screen you are on.
  for (const protectedAsset of ['EVR', 'SATORIEVR']) {
    await page.locator(`[data-testid="live-asset-row-${protectedAsset}"]`).first().click({ timeout: 10_000 });
    await byId('live-asset-detail-receive').waitFor({ timeout: 10_000 });
    check(
      (await page.locator('[data-testid="live-asset-detail-remove"]').count()) === 0,
      `${protectedAsset} detail offers no Remove (protected asset)`,
    );
    await page.getByRole('button', { name: 'Back' }).click({ timeout: 10_000 });
    await page.locator('[data-testid="live-balance-EVR"]').waitFor({ timeout: 10_000 });
  }

  // "Hide zero balances": the empty vector seed holds nothing, so turning it on
  // must drop the pinned SATORIEVR row, keep the native EVR row (a wallet always
  // shows the coin it is for) and say how many rows it took out. Turned back OFF
  // afterwards so the rest of this run sees the full list.
  await byId('live-hide-zero').click({ timeout: 10_000 });
  await byId('live-hidden-zero-note').waitFor({ timeout: 10_000 });
  check(
    (await page.locator('[data-testid="live-balance-SATORIEVR"]').count()) === 0 &&
      (await page.locator('[data-testid="live-balance-EVR"]').count()) === 1,
    'hide zero balances: drops the empty rows, never the native coin',
  );
  check(
    /zero balance hidden/.test(await byId('live-hidden-zero-note').innerText()),
    'hide zero balances: the count of hidden rows is shown under the list',
  );
  await byId('live-hidden-zero-note').click({ timeout: 10_000 });
  await page.locator('[data-testid="live-balance-SATORIEVR"]').first().waitFor({ timeout: 10_000 });
  check(
    (await byId('live-hidden-zero-note').count()) === 0,
    'hide zero balances: the note itself puts the rows back',
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

  // USD prices. THE PATH CHANGED (2026-08-21): every price now comes from ONE
  // call to the Satori GO gateway, in this store build too, and the gateway
  // talks to CoinGecko and SafeTrade server-side. Two consequences checked
  // here: the wallet asks <gateway>/prices, and it asks no exchange directly.
  //
  // EVR: CoinEx delisted the market this wallet used to read, which is why EVR
  // showed no fiat value at all for a while. CoinGecko does quote EVR, so a
  // gateway build must show one again. A FAILURE HERE IS EITHER a wallet bug or
  // the gateway not serving GET /prices yet: the label says which to check.
  let priceCalls = [];
  for (let i = 0; i < 30; i++) {
    priceCalls = askedFor('/prices');
    if (priceCalls.length > 0) break;
    await page.waitForTimeout(500);
  }
  if (gateway) {
    check(
      priceCalls.some((u) => u.startsWith(`${gateway}/prices`)),
      `prices are requested from the gateway: ${priceCalls[0] ?? `NO /prices request (expected ${gateway}/prices)`}`,
    );
  }
  const directExchange = [...askedFor('api.coinex.com'), ...askedFor('safe.trade'), ...askedFor('safetrade.com')];
  check(
    directExchange.length === 0,
    `the wallet contacts no exchange directly${directExchange.length ? `: ${directExchange.slice(0, 3).join(', ')}` : ''}`,
  );

  let evrUsdShown = false;
  for (let i = 0; i < 24; i++) {
    if ((await byId('live-asset-usd-EVR').count()) > 0) { evrUsdShown = true; break; }
    await page.waitForTimeout(500);
  }
  if (gateway) {
    check(evrUsdShown, `EVR USD value loaded from ${gateway}/prices (CoinGecko behind it); a failure here means the gateway is not serving GET /prices yet`);
  } else {
    // Dev shape, no gateway: EVR genuinely has no direct source, so showing no
    // fiat value for it is the correct behaviour.
    check(!evrUsdShown, 'no EVR USD value is invented in a build with no gateway (its exchange market is delisted)');
  }
  // The balance itself must still render — a price must never cost the row.
  check(
    (await byId('live-asset-row-EVR').count()) === 1 || (await page.locator('text=EVR').count()) > 0,
    'the EVR balance row renders either way',
  );

  await page.screenshot({ path: path.join(shotsDir, '20-live-home.png') });

  // Home tabs: Assets ↔ Activity. Default is Assets (EVR row visible). Switching
  // to Activity hides the asset rows and (for the empty vector seed) shows the
  // "no transactions" empty state; switching back to Assets restores the EVR row.
  await byId('live-tab-activity').click({ timeout: 10_000 });
  await byId('live-activity-list').waitFor({ timeout: 10_000 });
  check((await page.locator('[data-testid="live-asset-row-EVR"]').count()) === 0, 'Activity tab hides the asset rows');
  check(/no transactions/i.test(await byId('live-activity-list').innerText()), 'Activity tab shows the empty state (empty seed)');
  await byId('live-tab-assets').click({ timeout: 10_000 });
  await page.locator('[data-testid="live-balance-EVR"]').waitFor({ timeout: 10_000 });
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

  // ...and it CAN be removed, unlike the two protected ones — from its DETAIL
  // screen, which is the only place a remove control lives now.
  await page.locator('[data-testid="live-asset-row-SATORI"]').first().click({ timeout: 10_000 });
  await byId('live-asset-detail-remove').click({ timeout: 10_000 });
  await page.locator('[data-testid="live-balance-SATORI"]').waitFor({ state: 'detached', timeout: 15_000 });
  check(
    (await page.locator('[data-testid="live-balance-SATORI"]').count()) === 0,
    'remove-asset: an ordinary asset still removes cleanly (from its detail screen)',
  );

  // With SATORIEVR now in the list, its USD price should load: through the
  // gateway in a gateway build (SafeTrade/satorinet behind it), directly from
  // satorinet.io otherwise. Tolerant: poll ~12s.
  let satUsd = false;
  for (let i = 0; i < 24; i++) {
    if ((await byId('live-asset-usd-SATORIEVR').count()) === 1) { satUsd = true; break; }
    await page.waitForTimeout(500);
  }
  check(satUsd, `SATORIEVR USD price loaded (${gateway ? `${gateway}/prices` : 'satorinet.io/SafeTrade'} reachable from the extension)`);

  // Add-asset validation: a bogus name must be rejected with an inline error.
  await byId('live-add-asset').click({ timeout: 10_000 });
  await byId('live-add-asset-input').waitFor({ timeout: 10_000 });
  await byId('live-add-asset-input').fill('SATOREVR');
  await byId('live-add-asset-submit').click();
  await byId('live-add-asset-error').waitFor({ timeout: 25_000 });
  const addErr = (await byId('live-add-asset-error').innerText()).trim();
  check(/not found/i.test(addErr), `add-asset: bogus name rejected -> "${addErr}"`);
  await page.getByRole('button', { name: /^Cancel$/i }).click({ timeout: 10_000 });

  // Receive: QR + full address + network header. Every asset on a chain shares ONE
  // receive address, so the screen shows the network (not clickable per-asset chips).
  await byId('live-receive').click();
  await byId('live-receive-qr').waitFor({ timeout: 10_000 });
  const full = (await byId('live-receive-address').innerText()).trim();
  check(full.startsWith('E') && full.length === 34, `receive shows full real address (${full.length} chars)`);
  check(
    (await page.locator('[data-testid^="live-receive-asset-"]').count()) === 0,
    'receive: per-asset token chips removed (one address for all assets)',
  );
  const netText = (await byId('live-receive-network').innerText()).replace(/\s+/g, ' ').trim();
  check(/EVR/.test(netText) && /EVRmore/i.test(netText), `receive shows the network header -> "${netText}"`);

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
  await page.locator('[data-testid="live-balance-EVR"]').waitFor({ timeout: 15_000 });
  await byId('live-settings-btn').click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });

  // Settings opens in BASIC mode, which deliberately hides the expert sections
  // (servers, addresses, connected sites, export, diagnostics). Assert that, then
  // switch to EXPERT for the rest of the walk, which exercises those screens.
  for (const row of ['appearance', 'wallets', 'security', 'about']) {
    check((await byId(`live-settings-row-${row}`).count()) === 1, `settings basic: ${row} row present`);
  }
  for (const row of ['addresses', 'network', 'sites', 'transactions', 'diagnostics']) {
    check((await byId(`live-settings-row-${row}`).count()) === 0, `settings basic: ${row} row hidden`);
  }
  await byId('live-settings-mode-expert').click({ timeout: 10_000 });
  for (const row of ['appearance', 'wallets', 'addresses', 'security', 'network', 'transactions', 'diagnostics', 'about']) {
    check((await byId(`live-settings-row-${row}`).count()) === 1, `settings expert: ${row} row present`);
  }
  // The detail-level label and the connection pill share one row at the top of
  // the root list (KNOWN_LIMITATIONS item 33): Settings must never be a screen
  // where the wallet can go offline unnoticed.
  const rootTop = await byId('live-settings').innerText();
  check(/Detail level/.test(rootTop), 'settings root: the detail-level label is on screen');
  await page.screenshot({ path: path.join(shotsDir, '40-live-settings-root.png') });
  check((await byId('live-address-book-btn').count()) === 1, 'settings root: Address book row present');
  // Grouped root list (2026-08-26): ten flat rows became three named groups.
  for (const group of ['wallet', 'security', 'app']) {
    check(
      (await byId(`live-settings-group-${group}`).count()) === 1,
      `settings root: "${group}" group present`,
    );
  }
  // Recovery and Notifications are NOT expert-only: a user who has lost their
  // password must not have to find a detail level first.
  for (const row of ['recovery', 'notifications']) {
    check(
      (await byId(`live-settings-row-${row}`).count()) === 1,
      `settings root: ${row} row present in expert mode`,
    );
  }
  await byId('live-settings-mode-basic').click({ timeout: 10_000 });
  for (const row of ['recovery', 'notifications', 'security', 'wallets']) {
    check(
      (await byId(`live-settings-row-${row}`).count()) === 1,
      `settings basic: ${row} row still present`,
    );
  }
  await byId('live-settings-mode-expert').click({ timeout: 10_000 });

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

  // The gateway bridge row (1.4.0): FIRST in the list (the list IS the try
  // order), labelled as the gateway, marked Required and with no Remove button.
  if (gateway) {
    const bridgeRow = byId('live-server-0');
    const bridgeText = (await bridgeRow.innerText()).replace(/\s+/g, ' ').trim();
    check(
      (await bridgeRow.getAttribute('data-gateway')) === 'true' && /\/electrum\/evr/.test(bridgeText),
      `settings: the gateway bridge is the FIRST Electrum server on EVR -> "${bridgeText}"`,
    );
    check(
      /Required/.test(bridgeText) && /Satori GO gateway/i.test(bridgeText),
      'settings: the bridge row reads as the Satori GO gateway and is marked Required',
    );
    check(
      (await bridgeRow.getByTestId(/^live-server-remove-\d+$/).count()) === 0,
      'settings: the gateway bridge row has no Remove button',
    );
    check(
      (await byId('live-server-gateway-note').count()) === 1,
      'settings: the note explaining the Required gateway row is shown',
    );
    check(
      serverCountBefore === 3,
      `settings: EVR keeps its two public evrmorecoin.org fallbacks behind the bridge (${serverCountBefore} rows)`,
    );
  }

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

  // Appearance: "Open as side panel" (services/sidePanel.ts).
  //
  // THE PANEL IS THE DEFAULT MODE since 2026-08-28 (owner's call), so this block
  // reads the other way round from the one it replaces: a fresh profile starts
  // docked, the first click turns it OFF, and the second puts it back. Turning
  // it off must restore the popup and store an EXPLICIT false, which is the
  // whole point of the tri-state: absent means "never chose" and now resolves to
  // on, so a stored false is the only thing that can keep a user in the popup
  // across a worker restart. The panel page itself (index.html?panel=1) must lay
  // out in a NARROW panel without a horizontal scrollbar. We are in the popup
  // page here, so "takes effect on the next open" is what the worker-side state
  // shows.
  await byId('live-settings-row-appearance').click({ timeout: 10_000 });
  await byId('live-side-panel-toggle').waitFor({ timeout: 10_000 });
  const swPanel =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const panelState = () =>
    swPanel.evaluate(async () => {
      const popup = await chrome.action.getPopup({});
      const behavior = await chrome.sidePanel.getPanelBehavior();
      const stored = await chrome.storage.local.get(['ui:sidePanel']);
      // The RAW stored value, not `=== true`. Absent and false are different
      // states now: absent is "never chose" (which resolves to the panel) and
      // false is "chose the popup". Collapsing them was fine when the default
      // was off; it would hide the entire feature now.
      return {
        popup,
        opens: behavior.openPanelOnActionClick,
        stored: stored['ui:sidePanel'] === undefined ? null : stored['ui:sidePanel'],
      };
    });
  /** The note text once it matches, or the last text seen. The worker-side state
   *  flips INSIDE setEnabled, before React has re-rendered the note, so polling
   *  the state and then reading the note once is a race the note loses. */
  const sidePanelNote = async (re) => {
    let text = '';
    for (let i = 0; i < 20; i++) {
      text = await byId('live-side-panel-note').innerText();
      if (re.test(text)) return text;
      await page.waitForTimeout(250);
    }
    return text;
  };

  // A FRESH PROFILE has never chosen, so nothing is stored and the wallet is
  // already docked.
  let before = await panelState();
  for (let i = 0; i < 20 && !(before.popup === '' && before.opens); i++) {
    await page.waitForTimeout(250);
    before = await panelState();
  }
  check(
    before.popup === '' && before.opens && before.stored === null,
    `side panel: ON by default on a fresh profile, with nothing stored (${JSON.stringify(before)})`,
  );

  // First click: OFF. The popup comes back AND an explicit false is written.
  await byId('live-side-panel-toggle').click();
  let afterOff = before;
  for (let i = 0; i < 20; i++) {
    afterOff = await panelState();
    if (afterOff.popup.endsWith('index.html') && !afterOff.opens && afterOff.stored === false) break;
    await page.waitForTimeout(250);
  }
  check(
    afterOff.popup.endsWith('index.html') && !afterOff.opens && afterOff.stored === false,
    `side panel OFF: popup restored and the choice stored as an explicit false (${JSON.stringify(afterOff)})`,
  );
  const offNote = await sidePanelNote(/popup/i);
  check(/popup/i.test(offNote), `side panel OFF: the note says the wallet will open in the popup ("${offNote}")`);

  // Back ON, which is where the rest of this run wants it: it is the shipped
  // default, so the run should look like a real install.
  await byId('live-side-panel-toggle').click();
  let afterOn = afterOff;
  for (let i = 0; i < 20; i++) {
    afterOn = await panelState();
    if (afterOn.popup === '' && afterOn.opens && afterOn.stored === true) break;
    await page.waitForTimeout(250);
  }
  check(
    afterOn.popup === '' && afterOn.opens && afterOn.stored === true,
    `side panel ON: popup cleared, icon opens the panel, preference stored (${JSON.stringify(afterOn)})`,
  );
  const onNote = await sidePanelNote(/side panel/i);
  check(/side panel/i.test(onNote), `side panel ON: the note says it applies on the next open ("${onNote}")`);
  await page.screenshot({ path: path.join(shotsDir, '29-live-side-panel-toggle.png') });
  // The panel page in a narrow panel: no horizontal overflow, the wallet renders.
  const panelPage = await context.newPage();
  await panelPage.setViewportSize({ width: 360, height: 720 });
  await panelPage.goto(`chrome-extension://${id}/index.html?panel=1`);
  await panelPage.getByTestId('live-home').or(panelPage.getByTestId('live-lock')).first().waitFor({ timeout: 20_000 });
  const panelMetrics = await panelPage.evaluate(() => ({
    stamped: document.documentElement.dataset.panel === 'true',
    scrollW: document.documentElement.scrollWidth,
    bodyW: document.body.getBoundingClientRect().width,
    bodyH: document.body.getBoundingClientRect().height,
  }));
  check(panelMetrics.stamped, 'panel page: data-panel stamped on <html>');
  check(panelMetrics.scrollW <= 360 && panelMetrics.bodyW <= 360, `panel page at 360px: no horizontal overflow (scrollWidth ${panelMetrics.scrollW}, body ${panelMetrics.bodyW})`);
  check(panelMetrics.bodyH >= 700, `panel page: the canvas follows the panel height (${panelMetrics.bodyH}px of 720)`);
  // Unlock INSIDE the panel (its own document, so its own session) and check the
  // home screen itself at the narrow width.
  if (await panelPage.getByTestId('live-lock').count()) {
    await panelPage.getByTestId('live-unlock').fill('live-pass-1234');
    await panelPage.getByRole('button', { name: /^Unlock$/ }).click();
  }
  await panelPage.getByTestId('live-home').waitFor({ timeout: 30_000 });
  await panelPage.waitForTimeout(800);
  const homeMetrics = await panelPage.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    frameW: document.querySelector('.app-frame')?.getBoundingClientRect().width ?? 0,
  }));
  check(homeMetrics.scrollW <= 360 && homeMetrics.frameW === 360, `panel home at 360px: fills the panel, no horizontal overflow (frame ${homeMetrics.frameW}, scrollWidth ${homeMetrics.scrollW})`);
  await panelPage.screenshot({ path: path.join(shotsDir, '30-live-side-panel-narrow.png') });

  // Header layout across the whole width the user can drag the panel to
  // (MetaMask's order: network LEFT, wallet CENTRE, actions RIGHT). The three
  // slots must never intersect and the page must never scroll sideways, at any
  // of these widths. The chain name is a safety surface, so it also has to stay
  // readable — whole, or at least ~9 characters — at the narrowest width.
  const headerMetrics = () =>
    panelPage.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      };
      // Visible characters of a label that ellipsises: clientWidth is what is
      // painted, scrollWidth what the full string would need.
      const label = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { chars: 0, whole: false };
        const len = (el.textContent || '').length;
        const whole = el.scrollWidth <= el.clientWidth + 1;
        return {
          chars: whole ? len : Math.floor((len * el.clientWidth) / Math.max(1, el.scrollWidth)),
          whole,
        };
      };
      return {
        chain: box('[data-testid="live-chain-switcher"]'),
        wallet: box('[data-testid="live-wallet-switcher"]'),
        actions: box('.app-header .header-actions'),
        chainLabel: label('.chain-trigger-text'),
        chainAria: document.querySelector('[data-testid="live-chain-switcher"]')?.getAttribute('aria-label') || '',
        chainTextShown: (() => {
          const t = document.querySelector('.chain-trigger-text');
          return !!t && getComputedStyle(t).display !== 'none';
        })(),
        walletLabel: label('.wallet-switcher-text'),
        headerH: Math.round(document.querySelector('.app-header')?.getBoundingClientRect().height ?? 0),
        scrollW: document.documentElement.scrollWidth,
      };
    });
  for (const w of [320, 360, 400, 480]) {
    await panelPage.setViewportSize({ width: w, height: 720 });
    await panelPage.waitForTimeout(200);
    const m = await headerMetrics();
    const ok = m.chain && m.wallet && m.actions;
    check(
      Boolean(ok) && m.chain.right <= m.wallet.left && m.wallet.right <= m.actions.left,
      `header at ${w}px: network | wallet | actions do not intersect (${
        ok
          ? `chain ${m.chain.left}-${m.chain.right}, wallet ${m.wallet.left}-${m.wallet.right}, actions ${m.actions.left}-${m.actions.right}`
          : 'a header slot is missing'
      })`,
    );
    check(m.scrollW <= w, `header at ${w}px: no horizontal overflow (scrollWidth ${m.scrollW})`);
    if (w < 360) {
      // Under 360px the pill shows the mark only; the name lives in its label.
      check(
        !m.chainTextShown && /Evrmore/.test(m.chainAria) && (m.walletLabel.whole || m.walletLabel.chars >= 6),
        `header at ${w}px: chain pill is mark-only but labelled (${m.chainAria}); wallet name ${
          m.walletLabel.whole ? 'whole' : `${m.walletLabel.chars} chars`
        }`,
      );
    } else {
      check(
        m.chainTextShown && (m.chainLabel.whole || m.chainLabel.chars >= 9),
        `header at ${w}px: the chain name stays readable (${
          m.chainLabel.whole ? 'whole' : `${m.chainLabel.chars} chars`
        }); wallet name ${m.walletLabel.whole ? 'whole' : `${m.walletLabel.chars} chars`}`,
      );
    }
    if (w === 320 || w === 480) {
      // Both popovers, at the extremes: opened, they must stay inside the frame
      // (the wallet menu is centred on it, the chain menu hangs off its left).
      // Measured against the HEADER's own box: it spans the column, so "inside
      // it" is "inside the wallet", and its centre is the centre the wallet
      // switcher button sits on. 250ms lets .menu-pop's popIn finish, otherwise
      // the picture catches a half-transparent menu.
      await panelPage.getByTestId('live-wallet-switcher').click();
      await panelPage.getByTestId('live-wallet-dropdown').waitFor({ timeout: 5_000 });
      await panelPage.waitForTimeout(250);
      const menus = await panelPage.evaluate(() => {
        const row = document.querySelector('.app-header').getBoundingClientRect();
        const menu = document.querySelector('[data-testid="live-wallet-dropdown"]').getBoundingClientRect();
        return {
          inside: menu.left >= row.left - 1 && menu.right <= row.right + 1,
          offCentre: Math.round(Math.abs((menu.left + menu.right) / 2 - (row.left + row.right) / 2)),
          top: Math.round(menu.top - row.bottom),
        };
      });
      check(
        menus.inside && menus.offCentre <= 1,
        `wallet menu at ${w}px: inside the column and centred under the button (off by ${menus.offCentre}px, ${menus.top}px under the header)`,
      );
      await panelPage.screenshot({ path: path.join(shotsDir, `32-live-header-${w}.png`) });
      await panelPage.keyboard.press('Escape');
      await panelPage.getByTestId('live-chain-switcher').click();
      await panelPage.getByTestId('live-chain-dropdown').waitFor({ timeout: 5_000 });
      await panelPage.waitForTimeout(250);
      const chainMenu = await panelPage.evaluate(() => {
        const row = document.querySelector('.app-header').getBoundingClientRect();
        const menu = document.querySelector('[data-testid="live-chain-dropdown"]').getBoundingClientRect();
        return {
          inside: menu.left >= row.left - 1 && menu.right <= row.right + 1,
          left: Math.round(menu.left - row.left),
        };
      });
      check(
        chainMenu.inside && chainMenu.left <= 16,
        `chain menu at ${w}px: inside the column, anchored under its own trigger (${chainMenu.left}px in)`,
      );
      await panelPage.screenshot({ path: path.join(shotsDir, `33-live-header-chain-menu-${w}.png`) });
      await panelPage.keyboard.press('Escape');
      await panelPage.waitForTimeout(200);
    }
  }
  await panelPage.setViewportSize({ width: 360, height: 720 });
  await panelPage.waitForTimeout(200);

  await panelPage.setViewportSize({ width: 560, height: 720 });
  await panelPage.waitForTimeout(300);
  const wideFrame = await panelPage.evaluate(() => {
    const f = document.querySelector('.app-frame');
    return f ? f.getBoundingClientRect().width : 0;
  });
  check(wideFrame > 0 && wideFrame <= 480, `panel page at 560px: the column is capped and centred (${wideFrame}px)`);
  await panelPage.screenshot({ path: path.join(shotsDir, '31-live-side-panel-wide.png') });
  await panelPage.close();
  // Left ON deliberately (it is the default), so the rest of the run exercises a
  // wallet in the state a real install is in. Nothing below clicks the toolbar
  // icon: every page this script opens is navigated to directly, so the action's
  // behaviour does not affect it.
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
  // Price attribution: CoinGecko's free API asks for a visible credit, and the
  // line names the gateway because that is the path the wallet actually takes.
  const pricesCredit = (await byId('live-about-prices').innerText()).replace(/\s+/g, ' ').trim();
  const cgHref = await byId('live-about-prices-coingecko').getAttribute('href');
  check(
    /CoinGecko/.test(pricesCredit) && /SafeTrade/.test(pricesCredit) && /gateway/i.test(pricesCredit),
    `about: prices credit names CoinGecko, SafeTrade and the gateway ("${pricesCredit}")`,
  );
  check(!!cgHref && /coingecko\.com/.test(cgHref), `about: the CoinGecko credit links to coingecko.com (${cgHref})`);
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
  // The Settings section just above resets the server pool, which drops the
  // socket, so Review can land in the seconds before the client is back up.
  // "Still connecting…" is the wallet's own deliberate not-yet guard (nothing
  // is built, nothing is sent), not the outcome under test: retry until the
  // send reaches a real verdict, the same way the RVN send check below does.
  let reviewShown = false;
  let evrErr = '';
  for (let i = 0; i < 20; i++) {
    await page.getByRole('button', { name: /Review transaction/i }).click({ timeout: 10_000 });
    reviewShown = await byId('live-send-review').isVisible().catch(() => false);
    if (reviewShown) break;
    evrErr = (await byId('live-send-error').innerText().catch(() => '')) || '';
    if (evrErr && !/still connecting/i.test(evrErr)) break;
    await page.waitForTimeout(1000);
  }
  if (reviewShown) {
    check(
      (await byId('live-send-password').count()) === 1,
      'EVR review shows the password field (require-password on)',
    );
  } else {
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
  // Escape must close this menu (parity with the chain switcher, which always
  // had it); it used to be a dead key here.
  await page.keyboard.press('Escape');
  await byId('live-wallet-item-0').waitFor({ state: 'detached', timeout: 5_000 });
  check((await page.locator('[data-testid^="live-wallet-item-"]').count()) === 0, 'wallet menu: Escape closes it');
  await byId('live-wallet-switcher').click({ timeout: 10_000 });
  await byId('live-wallet-item-0').waitFor({ timeout: 10_000 });
  await byId('live-add-wallet').click({ timeout: 10_000 });
  await byId('live-onboarding').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: /Create new wallet/i }).click({ timeout: 10_000 });
  await byId('live-wallet-name').waitFor({ timeout: 10_000 });
  await byId('live-wallet-name').fill('Second Wallet');
  await byId('live-password').fill('wallet2-pass');
  await byId('live-password-confirm').fill('wallet2-pass');
  await byId('live-create-submit').click();
  // New wallet shows its recovery phrase once, then asks three of the words
  // back before it opens. This is the run's ONE wrong-answer check.
  await answerMnemonicQuiz(page, { label: 'mnemonic quiz', wrongFirst: true, shot: '34-live-mnemonic-quiz.png' });
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

  // Lock-screen wallet picker, TWO VIEWS: lock via the header lock button (it
  // locks directly now — no "⋮" menu, Settings/Activity are in the bottom nav).
  // The password view names exactly ONE wallet (live-lock-selected) and hides
  // the list behind "Change"; the list is a view of its own that lists ALL
  // wallets with the LAST-USED (first) one preselected. Picking the other wallet
  // returns to the password view re-targeted at it (it stays locked); picking
  // back restores the first, whose own password unlocks it.
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-lock').waitFor({ timeout: 10_000 });
  await byId('live-lock-selected').waitFor({ timeout: 10_000 });
  const lockCardName = (await byId('live-lock-selected').innerText()).trim().split('\n')[0].trim();
  check(lockCardName.length > 0, `lock: password view names the wallet being unlocked ("${lockCardName}")`);
  check((await byId('live-lock-wallets').count()) === 0, 'lock: the wallet list is NOT stacked above the password field');
  check((await byId('live-lock-change').count()) === 1, 'lock: password view offers "Change" when there are several wallets');

  // Open the list view.
  await byId('live-lock-change').click({ timeout: 10_000 });
  await byId('live-lock-wallets').waitFor({ timeout: 10_000 });
  const lockEntries = await page.locator('[data-testid^="live-lock-wallet-"]').count();
  check(lockEntries >= 1, `lock screen lists wallets (${lockEntries} entries)`);
  const lockSel0 = await byId('live-lock-wallet-0').getAttribute('aria-pressed');
  check(lockSel0 === 'true', `lock: last-used wallet preselected (aria-pressed=${lockSel0})`);
  const lockRowName1 = (await byId('live-lock-wallet-1').innerText()).trim().split('\n')[0].trim();
  await page.screenshot({ path: path.join(shotsDir, '28-live-lock-picker.png') });

  // Pick the OTHER wallet — a brief "Switching wallet…" screen may pass by, so
  // poll until the lock screen settles back on the PASSWORD view, now naming
  // the wallet just picked.
  await byId('live-lock-wallet-1').click({ timeout: 10_000 });
  let lockCard1 = '';
  for (let i = 0; i < 20; i++) {
    const listGone = (await byId('live-lock-wallets').count()) === 0;
    lockCard1 = ((await byId('live-lock-selected').innerText().catch(() => '')) || '').trim();
    if (listGone && lockCard1.includes(lockRowName1)) break;
    await page.waitForTimeout(500);
  }
  check(
    lockCard1.includes(lockRowName1),
    `lock: picking a wallet closes the list and re-targets the password view ("${lockCard1.split('\n')[0]}")`,
  );
  // The list itself agrees: reopen it and the picked wallet is the pressed row.
  await byId('live-lock-change').click({ timeout: 10_000 });
  let lockSel1 = '';
  for (let i = 0; i < 20; i++) {
    lockSel1 = (await byId('live-lock-wallet-1').getAttribute('aria-pressed').catch(() => '')) || '';
    if (lockSel1 === 'true') break;
    await page.waitForTimeout(500);
  }
  check(lockSel1 === 'true', `lock: picking another wallet re-targets it (aria-pressed=${lockSel1})`);
  // ...and back to the first wallet.
  await byId('live-lock-wallet-0').click({ timeout: 10_000 });
  let lockCardBack = '';
  for (let i = 0; i < 20; i++) {
    const listGone = (await byId('live-lock-wallets').count()) === 0;
    lockCardBack = ((await byId('live-lock-selected').innerText().catch(() => '')) || '').trim();
    if (listGone && lockCardBack.includes(lockCardName)) break;
    await page.waitForTimeout(500);
  }
  check(lockCardBack.includes(lockCardName), `lock: picking back names the first wallet again ("${lockCardBack.split('\n')[0]}")`);
  await byId('live-lock-change').click({ timeout: 10_000 });
  let lockSelBack = '';
  for (let i = 0; i < 20; i++) {
    lockSelBack = (await byId('live-lock-wallet-0').getAttribute('aria-pressed').catch(() => '')) || '';
    if (lockSelBack === 'true') break;
    await page.waitForTimeout(500);
  }
  check(lockSelBack === 'true', `lock: picking back restores the first wallet (aria-pressed=${lockSelBack})`);
  // Back leaves the list without changing anything.
  await byId('live-lock-wallets-back').click({ timeout: 10_000 });
  await byId('live-lock-wallets').waitFor({ state: 'detached', timeout: 10_000 });
  check((await byId('live-unlock').count()) === 1, 'lock: Back returns to the password view');
  await page.screenshot({ path: path.join(shotsDir, '28b-live-lock-password.png') });
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
  // A passwordless seed wallet still shows its recovery phrase once, and is
  // still quizzed on it: no password makes the written backup MORE important.
  await answerMnemonicQuiz(page, { label: 'passwordless quiz' });
  await byId('live-home').waitFor({ timeout: 20_000 });
  check((await byId('live-lock').count()) === 0, 'passwordless: lands on the live home with NO lock screen');

  // A passwordless wallet's Send shows NO password field.
  await byId('live-send').click({ timeout: 10_000 });
  await byId('live-send-to').waitFor({ timeout: 10_000 });

  // My-wallets quick-pick: chips named after your OTHER wallets sit under the
  // recipient field; tapping one fills the address AND highlights that chip green
  // (aria-pressed) instead of adding a separate confirmation line that shifts the
  // layout.
  await byId('live-send-wallet-0').waitFor({ timeout: 10_000 });
  const chipName = (await byId('live-send-wallet-0').innerText()).trim();
  check(
    (await byId('live-send-wallet-0').getAttribute('aria-pressed')) !== 'true',
    'my-wallets chip is NOT highlighted before it is picked',
  );
  await byId('live-send-wallet-0').click();
  const pickedTo = (await byId('live-send-to').inputValue()).trim();
  check(/^E[a-zA-Z0-9]{20,40}$/.test(pickedTo), `my-wallets chip fills the recipient (${pickedTo})`);
  check(
    (await byId('live-send-wallet-0').getAttribute('aria-pressed')) === 'true',
    `my-wallets pick highlights the chosen chip ("${chipName}") instead of a shifting confirmation line`,
  );
  check(
    (await page.locator('[data-testid="live-send-wallet-selected"]').count()) === 0,
    'my-wallets: the old separate confirmation line is gone (no layout shift)',
  );
  check(
    (await page.locator('[data-testid="live-send-save-contact"]').count()) === 0,
    'my-wallets: no "Save to address book" for your own wallet (already in My wallets)',
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

  // --- Ravencoin wallet: chain scoping + the native-send dispatch ------------
  // Two regressions this section pins down, both found by the owner's live test:
  //   1. buildSend dispatched on a literal 'EVR', so native RVN went down the
  //      ASSET path -> `Asset "RVN" was not found on the Ravencoin network.`
  //      at review. The Review click below is the ONLY thing that exercises the
  //      dispatch; three earlier probe runs looked green because they never
  //      clicked it.
  //   2. Recipient pickers must be scoped to the active wallet's chain: the
  //      wallets created above are all Evrmore, so on this RVN wallet the
  //      My-wallets quick-pick and the EVR address-book contact must NOT appear.
  await backToHome();
  await byId('live-wallet-switcher').click({ timeout: 10_000 });
  await byId('live-add-wallet').click({ timeout: 10_000 });
  await byId('live-onboarding').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: /Create new wallet/i }).click();
  await byId('live-create').waitFor({ timeout: 10_000 });
  await page
    .locator('[data-testid^="live-create-chain"]')
    .filter({ hasText: /Ravencoin/i })
    .first()
    .click();
  await byId('live-wallet-name').fill('RVN Wallet');
  await byId('live-no-password').check();
  const rvnAck = byId('passwordless-ack');
  if (await rvnAck.count()) await rvnAck.check();
  await byId('live-create-submit').click();
  await answerMnemonicQuiz(page, { label: 'RVN quiz' });
  await byId('live-home').waitFor({ timeout: 30_000 });
  const rvnAddr = (await byId('live-address').innerText()).trim();
  check(/^R/.test(rvnAddr), `RVN wallet created -> R-address shown (${rvnAddr})`);

  // --- Ravencoin through the gateway: the server list, and a custom fallback -
  // RVN's pool in a gateway build is the bridge and NOTHING else: there is no
  // acceptable public Ravencoin ElectrumX to fall back to (they run plain
  // upstream ElectrumX and reject the asset dialect this wallet needs), so a
  // gateway outage takes RVN offline by design. That is asserted first.
  //
  // The bridge is NOT deployed on the live gateway yet, which means a gateway
  // build genuinely cannot reach Ravencoin: no sync check for RVN is added here
  // (it would fail honestly, with nothing to fail over to). To keep the
  // The bridge is LIVE (2026-08-24), so the RVN send below runs through it.
  // The custom-server step stays only as the check that a user-added server
  // works alongside a required gateway row, and it cleans up after itself so
  // the persisted pool remains bridge-only.
  await byId('live-settings-btn').click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  if ((await byId('live-settings-row-network').count()) === 0) {
    await byId('live-settings-mode-expert').click({ timeout: 10_000 });
  }
  await byId('live-settings-row-network').click({ timeout: 10_000 });
  await byId('live-servers-list').waitFor({ timeout: 10_000 });
  const rvnServerCount = await page.getByTestId(/^live-server-\d+$/).count();
  const rvnFirstRow = (await byId('live-server-0').innerText()).replace(/\s+/g, ' ').trim();
  if (gateway) {
    check(
      rvnServerCount === 1 && /\/electrum\/rvn/.test(rvnFirstRow),
      `settings (RVN): the gateway bridge is the ONLY server -> "${rvnFirstRow}"`,
    );
    check(
      (await byId('live-server-0').getAttribute('data-gateway')) === 'true' &&
        /Required/.test(rvnFirstRow) &&
        (await byId('live-server-0').getByTestId(/^live-server-remove-\d+$/).count()) === 0,
      'settings (RVN): the bridge row is Required and cannot be removed',
    );
    await page.screenshot({ path: path.join(shotsDir, '32-live-rvn-servers.png') });
    // Add the Ravencoin node as a custom extra fallback, behind the bridge.
    await byId('live-server-input').fill('wss://rvnx.satorinet.io:443');
    await byId('live-server-add').click({ timeout: 10_000 });
    await page.waitForTimeout(400);
    const rvnRowsAfter = await page.getByTestId(/^live-server-\d+$/).count();
    const rvnAddedRow = (await byId('live-server-1').innerText()).replace(/\s+/g, ' ').trim();
    check(
      rvnRowsAfter === 2 && /rvnx\.satorinet\.io/.test(rvnAddedRow),
      `settings (RVN): a custom server is added BEHIND the required bridge -> "${rvnAddedRow}"`,
    );
    check(
      (await byId('live-server-0').getAttribute('data-gateway')) === 'true' &&
        (await byId('live-server-1').getByTestId(/^live-server-remove-\d+$/).count()) === 1,
      'settings (RVN): the bridge stays first and required; the custom server is removable',
    );
    // Clean up: remove the custom row again, so the RVN pool this run persists
    // is exactly the bridge and the send below is served THROUGH the gateway.
    await byId('live-server-1').getByTestId(/^live-server-remove-\d+$/).click({ timeout: 10_000 });
    await page.waitForTimeout(300);
    check(
      (await page.getByTestId(/^live-server-\d+$/).count()) === 1,
      'settings (RVN): removing the custom server leaves the bridge alone again',
    );
  } else {
    check(
      rvnServerCount >= 1,
      `settings (RVN): ${rvnServerCount} server(s) listed (no gateway in this build)`,
    );
  }
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await backToHome();

  await byId('live-send').click({ timeout: 10_000 });
  await byId('live-send-to').waitFor({ timeout: 10_000 });
  check(
    (await byId('live-send-my-wallets').count()) === 0,
    'chain scoping: My-wallets hides the Evrmore wallets on a Ravencoin wallet',
  );
  check(
    (await byId('live-send-contacts').count()) === 0,
    'chain scoping: the EVR address-book contact is not offered on a Ravencoin wallet',
  );
  // Native RVN dispatch: review an unfunded send. The native path fails with
  // insufficient funds; the asset path would fail FIRST with unknown-asset
  // ("was not found"), so the two outcomes are unambiguous even at 0 balance.
  await byId('live-send-to').fill('R9aKqDufsEYFGFn4vp2KczgmFkGWiLMRxY');
  await byId('live-send-amount').fill('1');
  // The pool was just changed (bridge + the added fallback), so the first
  // Review can land while the socket is still coming up. "Still connecting…" is
  // the wallet's own not-yet guard, not a verdict: keep asking until the send
  // reaches one.
  let rvnSendErr = '';
  for (let i = 0; i < 25; i++) {
    await page.getByRole('button', { name: /Review transaction/i }).click({ timeout: 10_000 });
    rvnSendErr = (await byId('live-send-error').innerText().catch(() => '')) || '';
    if (rvnSendErr && !/still connecting/i.test(rvnSendErr)) break;
    await page.waitForTimeout(1000);
  }
  check(
    /insufficient rvn/i.test(rvnSendErr) && !/was not found/i.test(rvnSendErr),
    `native RVN send takes the NATIVE path -> "${rvnSendErr.trim()}"`,
  );
  await page.screenshot({ path: path.join(shotsDir, '31-live-rvn-send.png') });
  console.log(
    gateway
      ? '  [electrum] RVN goes through the gateway bridge alone; it has no public fallback by design'
      : '  [electrum] RVN used its built-in node directly (no gateway in this build)',
  );
  await backToHome();

  // --- Bitcoin, Litecoin and Dogecoin through the gateway bridge (1.4.0) ----
  // These three gained the SAME shape Evrmore has: the bridge first, their own
  // public wss servers unchanged behind it. This store build has a gateway, so
  // each of them now TRIES the bridge before anything else, and the point of
  // the section is that this cannot cost anyone their coins: whichever endpoint
  // answers, the wallet must still reach the real chain tip. A gateway outage
  // (or a route that does not exist yet) is a fallback, not an outage for the
  // user, and the line printed per chain says which endpoint actually served
  // so a green run is never ambiguous about it.
  //
  // Imported (not created) on purpose: it is the same vector seed, three more
  // chains, and it skips three recovery-phrase quizzes that prove nothing new
  // here. Passwordless so each new wallet lands straight on home.
  const BRIDGED_CHAINS = [
    {
      key: 'btc',
      pick: 'bitcoin-mainnet',
      label: 'BTC',
      name: 'BTC Wallet',
      // The header TRUNCATES the address (8+6), so the prefix is what is
      // assertable here: it is the chain-distinguishing part anyway.
      address: /^bc1[a-z0-9]/,
      publicHosts: ['btc.electrum1.cipig.net', 'btc.electrum2.cipig.net'],
    },
    {
      key: 'ltc',
      pick: 'litecoin-mainnet',
      label: 'LTC',
      name: 'LTC Wallet',
      address: /^ltc1[a-z0-9]/,
      publicHosts: ['ltc.electrum1.cipig.net', 'ltc.electrum2.cipig.net'],
    },
    {
      key: 'doge',
      pick: 'dogecoin-mainnet',
      label: 'DOGE',
      name: 'DOGE Wallet',
      address: /^D[a-km-zA-HJ-NP-Z1-9]/,
      publicHosts: ['doge.electrum1.cipig.net', 'doge.electrum2.cipig.net'],
    },
  ];

  for (const chain of BRIDGED_CHAINS) {
    // Everything this chain opens from here on. `sockets` is append-only and
    // shared, so the slice is what attributes an attempt to THIS chain, and the
    // host filter below keeps another chain's background poll out of the verdict.
    const socketsBefore = sockets.length;

    await byId('live-wallet-switcher').click({ timeout: 10_000 });
    await byId('live-add-wallet').click({ timeout: 10_000 });
    await byId('live-onboarding').waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: /Import recovery phrase/i }).click({ timeout: 10_000 });
    await byId('live-import-input').waitFor({ timeout: 10_000 });
    await byId(`live-import-chain-${chain.pick}`).click({ timeout: 10_000 });
    await byId('live-wallet-name').fill(chain.name);
    await byId('live-import-input').fill(VECTOR_MNEMONIC);
    await byId('live-no-password').check();
    const ack = byId('passwordless-ack');
    if (await ack.count()) await ack.check();
    await byId('live-import-submit').click();
    await byId('live-home').waitFor({ timeout: 30_000 });
    const chainAddr = (await byId('live-address').innerText()).trim();
    check(
      chain.address.test(chainAddr),
      `${chain.label}: wallet imported on its own chain (${chainAddr})`,
    );

    // THE assertion: the wallet still syncs. A real "Block <height>" on the pill
    // is a completed wss round-trip to that chain, through whichever endpoint
    // answered first.
    let chainPill = '';
    for (let i = 0; i < 40; i++) {
      chainPill =
        (await page.locator('[data-testid="live-network-pill"]').innerText().catch(() => '')) || '';
      if (/block\s*[\d,]/i.test(chainPill)) break;
      await page.waitForTimeout(1000);
    }
    check(
      /block\s*[\d,]/i.test(chainPill),
      `${chain.label}: still syncs with the bridge in front of the pool -> "${chainPill.replace(/\s+/g, ' ').trim()}"`,
    );

    // Which endpoint served it: the bridge, or one of that chain's own public
    // servers. Only this chain's endpoints count.
    const chainBridge = bridgeUrl(chain.key);
    const chainAttempts = sockets
      .slice(socketsBefore)
      .filter(
        (s) =>
          sameUrl(s.url, chainBridge) || chain.publicHosts.some((h) => s.url.includes(h)),
      );
    console.log(
      `  [electrum] ${chain.label} attempts: ${
        chainAttempts.length
          ? chainAttempts
              .map((s) => `${s.url}${s.failed ? ' (socket error)' : s.closed ? ' (closed)' : ''}`)
              .join(' -> ')
          : 'none seen on this page'
      }`,
    );
    if (gateway) {
      check(
        chainAttempts.length > 0 && sameUrl(chainAttempts[0].url, chainBridge),
        `${chain.label}: the FIRST connection attempt went to the gateway bridge (${chainAttempts[0]?.url ?? 'no socket seen'})`,
      );
      const chainServed =
        chainAttempts.find((s) => !s.failed && !s.closed) ?? chainAttempts[chainAttempts.length - 1];
      check(!!chainServed, `${chain.label}: an endpoint served the sync -> ${chainServed?.url ?? 'none'}`);
      console.log(
        sameUrl(chainServed?.url, chainBridge)
          ? `  [electrum] ${chain.label} was served by the GATEWAY BRIDGE`
          : `  [electrum] ${chain.label} was served by a PUBLIC FALLBACK; the bridge did not answer (designed failover)`,
      );
    } else {
      check(
        chainAttempts.length > 0,
        `${chain.label}: no gateway in this build, the public pool is used directly (${chainAttempts[0]?.url ?? 'no socket seen'})`,
      );
    }

    // Settings > Network for this chain: the bridge is the first row, reads as
    // the gateway, is Required and cannot be removed, and the chain's public
    // fallbacks are still listed behind it.
    await byId('live-settings-btn').click({ timeout: 10_000 });
    await byId('live-settings').waitFor({ timeout: 10_000 });
    if ((await byId('live-settings-row-network').count()) === 0) {
      await byId('live-settings-mode-expert').click({ timeout: 10_000 });
    }
    await byId('live-settings-row-network').click({ timeout: 10_000 });
    await byId('live-servers-list').waitFor({ timeout: 10_000 });
    const chainRows = await page.getByTestId(/^live-server-\d+$/).count();
    const chainListText = (await byId('live-servers-list').innerText()).replace(/\s+/g, ' ');
    if (gateway) {
      const chainFirstRow = (await byId('live-server-0').innerText()).replace(/\s+/g, ' ').trim();
      check(
        (await byId('live-server-0').getAttribute('data-gateway')) === 'true' &&
          new RegExp(`/electrum/${chain.key}`).test(chainFirstRow) &&
          /Required/.test(chainFirstRow) &&
          (await byId('live-server-0').getByTestId(/^live-server-remove-\d+$/).count()) === 0,
        `settings (${chain.label}): the bridge is the FIRST row, Required and not removable -> "${chainFirstRow}"`,
      );
      check(
        chainRows === 3 && chain.publicHosts.every((h) => chainListText.includes(h)),
        `settings (${chain.label}): both public fallbacks stay listed behind the bridge (${chainRows} rows)`,
      );
    } else {
      check(
        chainRows >= 1,
        `settings (${chain.label}): ${chainRows} server(s) listed (no gateway in this build)`,
      );
    }
    await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
    await byId('live-settings').waitFor({ timeout: 10_000 });
    await backToHome();
  }
  await page.screenshot({ path: path.join(shotsDir, '33-live-bridged-chains.png') });

  // The app password is still OFF at this point, and Settings > Security has to
  // say so. Asserted HERE because the very next step sets it, and this is the
  // last moment the run is in the state every install starts in.
  const APP_PASSWORD = 'one-password-for-all-1234';
  /** What the recovery-code flow sets instead, once the app password is
   *  "forgotten" (the app-password design notes §13). */
  const RECOVERED_PASSWORD = 'recovered-with-the-code-5678';
  await backToHome();
  await byId('live-settings-btn').click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await byId('live-settings-row-security').click({ timeout: 10_000 });
  await byId('live-settings-view-security').waitFor({ timeout: 10_000 });
  const appChipOff = (await byId('live-app-password-chip').innerText()).trim();
  check(appChipOff === 'Off', `app password: Settings > Security starts with it Off (${appChipOff})`);
  check(
    (await byId('live-change-pw-submit').count()) === 1,
    'app password off: the per-wallet password form is exactly where it was',
  );
  await backToHome();

  // --- THE FORCED APP-PASSWORD SETUP (the app-password design notes, section 12) -
  //
  // This profile is the case the screen exists for, and it is a MIXED install:
  // five wallets on it open with NO password at all (No Password Wallet, RVN,
  // BTC, LTC, DOGE) and three have their own (Wallet 1, Second Wallet, Key
  // Wallet). A passwordless vault is encrypted under an EMPTY passphrase, so
  // those five seeds are effectively at rest in the clear.
  //
  // Reopening the wallet used to land straight back on the home screen. It now
  // lands on a screen that will not let go until an app password is set, which
  // is both the new gate AND the old reopen-persistence proof: the wallets are
  // still here, and the app is still the wallet.
  await page.reload();
  const landing = await Promise.race([
    byId('live-force-app-password').waitFor({ timeout: 25_000 }).then(() => 'force').catch(() => ''),
    byId('live-home').waitFor({ timeout: 25_000 }).then(() => 'home').catch(() => ''),
    byId('live-lock').waitFor({ timeout: 25_000 }).then(() => 'lock').catch(() => ''),
  ]);
  check(
    landing === 'force',
    `reopen with an unprotected wallet lands on the forced app-password setup (${landing || 'neither'})`,
  );

  const forceText = (await byId('live-force-app-password').innerText()).replace(/\s+/g, ' ');
  check(
    /of your \w+ wallets open with no password at all/i.test(forceText),
    `forced setup: counts the wallets that open with no password -> "${forceText.slice(0, 90)}"`,
  );
  check(
    /anyone who can use this computer can open satori go and spend from them/i.test(forceText),
    'forced setup: says in plain language what that means',
  );
  check(/an app password fixes that/i.test(forceText), 'forced setup: says what fixes it');
  check(
    /No Password Wallet/.test(forceText) && /RVN Wallet/.test(forceText),
    'forced setup: names the wallets that open with no password',
  );
  check(
    /already have their own passwords and are not changed here/i.test(forceText),
    'forced setup (mixed install): says the wallets with their own passwords are not touched',
  );
  check(
    !/Second Wallet|Key Wallet/.test(forceText),
    'forced setup: never offers a wallet whose password the user has not typed',
  );
  check(
    /can only be restored from their recovery phrases/i.test(forceText),
    'forced setup: carries the loss warning the Settings setup screen has always shown',
  );
  check(
    /Removing the app password is not supported in this release/i.test(forceText),
    'forced setup: says removing it is not supported in this release',
  );
  check(!forceText.includes('—'), 'forced setup: no em-dash in the copy');
  // The screen fades in (screen-enter): shoot after it, or the capture is a
  // half-transparent screen.
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(shotsDir, '38-live-force-app-password.png') });

  // FORCED MEANS FORCED. Nothing here dismisses it, and it comes back at the
  // next launch.
  const escapeHatches = await page
    .locator('[data-testid="live-force-app-password"] button')
    .filter({ hasText: /^\s*(skip|later|not now|cancel|close|remind me)\s*$/i })
    .count();
  check(escapeHatches === 0, 'forced setup: offers no skip, cancel, later or close');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check(
    (await byId('live-force-app-password').count()) === 1,
    'forced setup: Escape does not dismiss it',
  );
  check(
    (await byId('live-home').count()) === 0 && (await byId('live-nav').count()) === 0,
    'forced setup: there is no wallet, and no navigation, behind it',
  );
  await page.reload();
  await byId('live-force-app-password').waitFor({ timeout: 25_000 });
  check(true, 'forced setup: closing the window brings it straight back at the next launch');

  // THE BACKUP, BEFORE IT IS TAKEN AWAY. It works because nothing protects the
  // wallet yet, which is the whole point of offering it first.
  await byId('live-force-app-password-reveal-0').click({ timeout: 10_000 });
  await byId('live-reveal-output').waitFor({ timeout: 20_000 });
  const revealedWords = (await byId('live-reveal-output').innerText()).trim().split(/\s+/);
  check(
    revealedWords.length >= 12,
    `forced setup: the recovery phrase is shown with NO password typed (${revealedWords.length} words)`,
  );
  check(
    (await byId('live-reveal-password').count()) === 0,
    'forced setup: the reveal asks for nothing, because nothing protects it yet',
  );
  const revealText = (await byId('live-reveal-modal').innerText()).replace(/\s+/g, ' ');
  check(
    /Never share this\. Anyone with it controls your funds\./i.test(revealText),
    "forced setup: the reveal carries the wallet's own existing warning",
  );
  await page.screenshot({ path: path.join(shotsDir, '39-live-force-reveal.png') });
  await byId('live-reveal-hide').click({ timeout: 10_000 });
  await byId('live-reveal-modal').waitFor({ state: 'detached', timeout: 10_000 });
  check(
    (await byId('live-force-app-pw-submit').count()) === 1,
    'forced setup: closing the phrase returns to setting the password',
  );

  // The password itself: refused when it is too short or mistyped, then set.
  await byId('live-force-app-pw-new').fill('short');
  await byId('live-force-app-pw-submit').click({ timeout: 10_000 });
  await byId('live-force-app-pw-error').waitFor({ timeout: 10_000 });
  check(
    /at least/i.test(await byId('live-force-app-pw-error').innerText()),
    'forced setup: a password that is too short is refused',
  );
  await byId('live-force-app-pw-new').fill(APP_PASSWORD);
  await byId('live-force-app-pw-confirm').fill(`${APP_PASSWORD}x`);
  await byId('live-force-app-pw-submit').click({ timeout: 10_000 });
  check(
    /do not match/i.test(await byId('live-force-app-pw-error').innerText()),
    'forced setup: a mismatched confirmation is refused',
  );
  await byId('live-force-app-pw-confirm').fill(APP_PASSWORD);
  await byId('live-force-app-pw-submit').click({ timeout: 10_000 });

  // The summary: a mixed install is told what it now has to remember.
  await byId('live-force-app-password-done').waitFor({ timeout: 120_000 });
  const doneText = (await byId('live-force-app-password-done').innerText()).replace(/\s+/g, ' ');
  check(
    /wallets are protected by it now/i.test(doneText) && /No Password Wallet/.test(doneText),
    `forced setup: names the wallets the app password now protects -> "${doneText.slice(0, 90)}"`,
  );
  check(
    /still have their own password/i.test(doneText) && /Key Wallet/.test(doneText),
    'forced setup (mixed install): names the wallets that still ask for their own password',
  );
  check(
    /asks for its own password once, the next time you open it/i.test(doneText),
    'forced setup (mixed install): says each of them asks once, and when',
  );
  check(
    /you need both/i.test(doneText),
    'forced setup (mixed install): says the user needs both for now, rather than letting them find out at a lock screen',
  );
  check(
    /Forgetting the app password does not lock you out of those wallets/i.test(doneText),
    'forced setup (mixed install): says the wallets it never protected are not at risk from it',
  );
  check(
    !/could not be moved/i.test(doneText),
    'forced setup: every wallet that opened with no password actually moved',
  );
  check(!doneText.includes('—'), 'forced setup summary: no em-dash in the copy');
  await page.screenshot({ path: path.join(shotsDir, '40-live-force-app-password-done.png') });

  await byId('live-force-app-password-continue').click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 60_000 });
  check(true, 'forced setup: the wallet opens straight afterwards, with nothing else typed');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(shotsDir, '41-live-force-app-password-open.png') });

  // The state is now VISIBLE, not inferred. The Home switcher is scoped to the
  // ACTIVE CHAIN (the owner's rule: crossing chains is the chain switcher's job),
  // so it can only speak for this chain's wallet here; the whole list is checked
  // on the lock screen and in Settings > Wallets below.
  await byId('live-wallet-switcher').click({ timeout: 10_000 });
  await byId('live-wallet-item-0').waitFor({ timeout: 10_000 });
  const walletRows = (await page.locator('[data-testid^="live-wallet-item-"]').allInnerTexts()).join(' | ');
  check(
    /App pw/.test(walletRows) && !/No pw/.test(walletRows),
    `wallet switcher: the wallet the forced setup moved is marked as opened by the app password -> "${walletRows.replace(/\s+/g, ' ').slice(0, 120)}"`,
  );
  await page.keyboard.press('Escape');
  await byId('live-home').waitFor({ timeout: 10_000 });

  // The run is back on a ready wallet, which is what the next sections need.
  const stillLive = 'home';

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
      // A DETACHED WINDOW IS ITS OWN PAGE, with its own service and no master
      // key, so with an app password set it opens on the APP lock screen. That
      // is the same launch gate the popup gets, in the window that used to be
      // the way to sidestep one.
      await detachedPage.locator('[data-testid="live-app-lock"]').waitFor({ timeout: 25_000 });
      check(true, 'detached window: asks for the app password like any other launch');
      await detachedPage.locator('[data-testid="live-app-unlock"]').fill(APP_PASSWORD);
      await detachedPage.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
      await detachedPage.locator('[data-testid="live-home"]').waitFor({ timeout: 40_000 });
      check(
        (await detachedPage.locator('[data-testid="live-detach-btn"]').count()) === 0,
        'detached window hides its own detach button',
      );
      await detachedPage.close();
    }

    // Reopen the popup so the remaining checks have a page to run against. Same
    // launch, same gate: it comes up on the app lock screen.
    page = await context.newPage();
    await page.goto(`chrome-extension://${id}/index.html`);
    await byId('live-app-lock').waitFor({ timeout: 25_000 });
    check(
      (await byId('live-force-app-password').count()) === 0,
      'popup relaunch: the forced setup does NOT come back once the password is set',
    );
    await byId('live-app-unlock').fill(APP_PASSWORD);
    await page.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
    await byId('live-home').waitFor({ timeout: 40_000 });
  }

  // The lock screen offers "Create new wallet" so a user can make a fresh wallet
  // without logging in. Reached through the app lock screen's escape hatch (the
  // design's "nothing is stranded" rule), which is also where a wallet that
  // still has its own password lives now.
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-app-lock').waitFor({ timeout: 15_000 });
  check(
    (await byId('live-app-lock-use-wallet-password').count()) === 1,
    'app lock: a wallet that still has its own password is never stranded behind it',
  );
  await byId('live-app-lock-use-wallet-password').click({ timeout: 10_000 });
  await byId('live-lock').waitFor({ timeout: 20_000 });
  check((await byId('live-lock-create').count()) === 1, 'lock screen offers "Create new wallet"');
  await page.screenshot({ path: path.join(shotsDir, '27-live-lock-create.png') });

  // --- app password: the rest of the flow (1.4.0) ----------------------------
  // the app-password design notes, sections 3-6, in a real build. The password
  // itself was set by the FORCED setup above, which is the only way this profile
  // could reach a wallet at all; what is left to drive is what it hands over to:
  // the APP lock screen, a wallet still on its own password asking ONCE (the
  // transitional prompt) and never again, and a wallet that has already moved
  // over opening with no second prompt at all.
  //
  // Everything before the forced screen ran with NO app password set, which is
  // the other half of the proof: the flow this build shipped before is what the
  // whole run up to there exercised.

  /** Type the app password on the app lock screen and submit it. */
  const submitAppPassword = async (value) => {
    await byId('live-app-unlock').fill(value);
    await page.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  };

  // 1. Back in through the APP lock screen. The escape hatch above put this page
  //    on a wallet that still has its own password, so the app password lands on
  //    that wallet's transitional prompt; switching to one the forced setup moved
  //    opens it on the master key alone.
  check(
    (await byId('live-lock-back-to-app-lock').count()) === 1,
    'wallet lock screen: offers the way back to the app password (the round trip, not a one-way door)',
  );
  await byId('live-lock-back-to-app-lock').click({ timeout: 10_000 });
  await byId('live-app-lock').waitFor({ timeout: 15_000 });
  await submitAppPassword(APP_PASSWORD);
  await byId('live-lock').waitFor({ timeout: 25_000 });
  check(
    (await byId('live-lock-migrate-note').count()) === 1,
    'app unlock: a wallet still on its own password gets the transitional prompt',
  );
  await byId('live-lock-change').click({ timeout: 10_000 });
  await byId('live-lock-wallets').waitFor({ timeout: 10_000 });
  const lockList = (await byId('live-lock-wallets').innerText()).replace(/\s+/g, ' ');
  check(
    /App pw/.test(lockList) && /Own pw/.test(lockList),
    `lock screen list: says which wallets the app password opens and which still carry their own -> "${lockList.slice(0, 120)}"`,
  );
  check(
    !/No pw/.test(lockList),
    'lock screen list: no wallet is still marked as opening with no password',
  );
  await page
    .locator('[data-testid^="live-lock-wallet-"]', { hasText: 'No Password Wallet' })
    .first()
    .click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 40_000 });

  //    Settings > Security reflects it, and a wallet that moved over no longer
  //    has a password of its own to change.
  await byId('live-settings-btn').click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await byId('live-settings-row-security').click({ timeout: 10_000 });
  await byId('live-settings-view-security').waitFor({ timeout: 10_000 });
  const appChipOn = (await byId('live-app-password-chip').innerText()).trim();
  check(appChipOn === 'On', `app password: the Settings card reads On after the forced setup (${appChipOn})`);
  check(
    /It opens every wallet that has moved over/i.test(await byId('live-app-password-state').innerText()),
    'app password: the Settings card says what it opens',
  );
  check(
    (await byId('live-change-pw-submit').count()) === 0,
    'migrated wallet: it has no password of its own left to change',
  );
  await page.screenshot({ path: path.join(shotsDir, '36-live-settings-security.png') });

  // Settings > Wallets says which password opens which, in full words there.
  await page.locator('button[aria-label="Back"]').first().click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  await byId('live-settings-row-wallets').click({ timeout: 10_000 });
  await byId('live-settings-view-wallets').waitFor({ timeout: 10_000 });
  const settingsWallets = (await byId('live-settings-view-wallets').innerText()).replace(/\s+/g, ' ');
  check(
    /App password/.test(settingsWallets) && /Own password/.test(settingsWallets),
    'settings > wallets: says which wallets the app password opens and which still carry their own',
  );
  check(
    !/No password/.test(settingsWallets),
    'settings > wallets: no wallet is still marked as having no password',
  );

  // 2. Lock: the APP lock screen, not a wallet's own.
  await backToHome();
  await page.waitForTimeout(200);
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-app-lock').waitFor({ timeout: 15_000 });
  check(
    (await byId('live-lock').count()) === 0 && (await byId('live-lock-selected').count()) === 0,
    'app lock: gates the APP, with no wallet card and no wallet picker on it',
  );
  // The screen fades in (screen-enter) and the mark has an arrival animation:
  // shoot after both, or the capture is a half-transparent screen.
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(shotsDir, '35-live-app-lock.png') });

  await submitAppPassword('definitely-not-the-app-password');
  await page.waitForTimeout(500);
  check(
    (await byId('live-app-lock').count()) === 1 &&
      /Incorrect password/i.test(await byId('live-app-lock').innerText()),
    'app lock: a wrong password is refused with the existing failure copy',
  );

  // 3. The right one opens the app, and the wallet the forced setup moved over
  //    opens with NO second prompt.
  await submitAppPassword(APP_PASSWORD);
  await byId('live-home').waitFor({ timeout: 40_000 });
  check(
    (await byId('live-lock').count()) === 0,
    'migrated wallet: the app password opens it with NO second prompt',
  );

  // 4. A wallet that kept its OWN password asks once, with the transitional
  //    prompt, and can decline. This is the mixed install's other half.
  await byId('live-wallet-switcher').click({ timeout: 10_000 });
  await page
    .locator('[data-testid^="live-wallet-item-"]', { hasText: 'Key Wallet' })
    .first()
    .click({ timeout: 10_000 });
  await byId('live-lock').waitFor({ timeout: 40_000 });
  await byId('live-lock-migrate-note').waitFor({ timeout: 25_000 });
  const migrateCopy = (await byId('live-lock-migrate-note').innerText()).replace(/\s+/g, ' ');
  check(
    /moves to your app password/i.test(migrateCopy),
    `transitional prompt: says what unlocking will do -> "${migrateCopy.slice(0, 80)}"`,
  );
  check(
    (await byId('live-lock-keep-own-password').count()) === 1,
    "transitional prompt: offers to keep the wallet's own password (declining is one click)",
  );
  check(!migrateCopy.includes('—'), 'transitional prompt: no em-dash in the copy');
  check(
    (await byId('live-lock-selected').innerText()).includes('Own pw'),
    'lock screen: the wallet card says this one still carries its own password',
  );
  await page.screenshot({ path: path.join(shotsDir, '37-live-lock-migrate.png') });

  // The app password is NOT this wallet's password, and is not accepted as one.
  await byId('live-unlock').fill(APP_PASSWORD);
  await page.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  await page.waitForTimeout(800);
  check(
    (await byId('live-lock').count()) === 1,
    "a wallet that kept its own password is NOT opened by the app password",
  );

  await byId('live-unlock').fill('pk-pass-1234');
  await page.getByRole('button', { name: /^Unlock$/i }).click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 40_000 });
  check(true, 'transitional prompt: the wallet opens with its own password, once');

  // 5. And never again: it has moved over now.
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-app-lock').waitFor({ timeout: 15_000 });
  await submitAppPassword(APP_PASSWORD);
  await byId('live-home').waitFor({ timeout: 40_000 });
  check(
    (await byId('live-lock').count()) === 0,
    'a wallet that kept its own password: once it has moved over, it never asks again',
  );

  // --- losing the app password: a code and a backup file (§13) ----------------
  // The two routes back into a wallet whose app password is gone. Everything
  // here runs against the REAL crypto in the built extension: the code is made,
  // the file is written to disk and read back, and the code is then used to
  // open a locked wallet with a new password.
  await byId('live-settings-btn').click({ timeout: 10_000 });
  await byId('live-settings').waitFor({ timeout: 10_000 });
  // Recovery is its own row and its own screen since 2026-08-26; it used to be
  // the last block of Settings > Security.
  await byId('live-settings-row-recovery').click({ timeout: 10_000 });
  await byId('live-settings-view-recovery').waitFor({ timeout: 10_000 });
  check(
    (await byId('live-rec-code-chip').innerText()).trim() === 'Off',
    'recovery: no code on a wallet that has never made one',
  );
  check(
    /no reset we could send/i.test(await byId('live-rec-phrase-note').innerText()),
    'recovery: the section says there is no reset anyone could send',
  );

  // 1. Make one.
  await byId('live-rec-code-open').click({ timeout: 10_000 });
  await byId('live-rec-code-pw').fill('the wrong app password');
  await byId('live-rec-code-create').click({ timeout: 10_000 });
  await page.waitForTimeout(2500); // a real scrypt runs before it can fail
  check(
    (await byId('live-rec-code-shown').count()) === 0,
    'recovery: a wrong app password makes no code',
  );
  await byId('live-rec-code-pw').fill(APP_PASSWORD);
  await byId('live-rec-code-create').click({ timeout: 10_000 });
  await byId('live-rec-code-shown').waitFor({ timeout: 60_000 });
  const recoveryCode = (await byId('live-rec-code-value').innerText()).trim();
  check(
    /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/.test(recoveryCode),
    `recovery: the code is 8 groups of Crockford base32 (${recoveryCode.slice(0, 9)}...)`,
  );
  check(
    /without your password/i.test(await byId('live-rec-code-shown').innerText()),
    'recovery: the screen that hands over the code says it is a second key',
  );
  await page.screenshot({ path: path.join(shotsDir, '36-live-recovery-code.png') });
  await byId('live-rec-code-saved').click({ timeout: 10_000 });
  await byId('live-rec-code-done').click({ timeout: 10_000 });
  check(
    (await byId('live-rec-code-chip').innerText()).trim() === 'On',
    'recovery: the card reads On once a code exists',
  );

  // 2. Save a backup file, and read the bytes that landed on disk.
  const BACKUP_PW = 'the-backup-file-password-1234';
  await page.screenshot({ path: path.join(shotsDir, '37-live-recovery-settings.png') });
  await byId('live-rec-backup-open').click({ timeout: 10_000 });
  await byId('live-rec-backup-pw').fill(BACKUP_PW);
  await byId('live-rec-backup-pw2').fill(BACKUP_PW);
  const [backupDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    byId('live-rec-backup-save').click({ timeout: 10_000 }),
  ]);
  const backupPath = path.join(os.tmpdir(), `evrdemo-backup-${Date.now()}.json`);
  await backupDownload.saveAs(backupPath);
  check(
    /^satori-go-backup-\d{4}-\d{2}-\d{2}\.json$/.test(backupDownload.suggestedFilename()),
    `recovery: the file is named by date (${backupDownload.suggestedFilename()})`,
  );
  const backupText = readFileSync(backupPath, 'utf8');
  const backupEnvelope = JSON.parse(backupText);
  check(
    backupEnvelope.format === 'satori-go-backup' && typeof backupEnvelope.ciphertext === 'string',
    'recovery: the saved file is a Satori GO backup envelope',
  );
  // §13.7: the envelope names NOTHING. A file someone finds must not tell them
  // whose wallets are in it or how many.
  check(
    !/Trezor|Satori key|wallets|address/i.test(JSON.stringify({ ...backupEnvelope, ciphertext: '' })),
    'recovery: the envelope names no wallet, address or count in the clear',
  );
  await byId('live-rec-backup-done').click({ timeout: 10_000 });

  // 3. Open that file again through the restore flow, and stop at the preview.
  //    Deliberately NOT applied: a replace would end this run's wallets, and
  //    what needs proving here is that the file decrypts to the real thing.
  await byId('live-rec-restore-open').click({ timeout: 10_000 });
  await byId('live-rec-restore-file').setInputFiles(backupPath);
  await byId('live-rec-restore-pw').waitFor({ timeout: 10_000 });
  await byId('live-rec-restore-pw').fill('not the file password');
  await byId('live-rec-restore-read').click({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  check(
    (await byId('live-rec-restore-preview').count()) === 0,
    'recovery: a wrong file password opens nothing',
  );
  await byId('live-rec-restore-pw').fill(BACKUP_PW);
  await byId('live-rec-restore-read').click({ timeout: 10_000 });
  await byId('live-rec-restore-preview').waitFor({ timeout: 60_000 });
  const restorePreview = await byId('live-rec-restore-preview').innerText();
  // The wallets this run has built by now, named on the confirmation because
  // that list is the only thing standing between the user and a replace.
  check(
    /Second Wallet/i.test(restorePreview) && /Key Wallet/i.test(restorePreview),
    `recovery: the backup decrypts to this device's wallets, named on the confirmation (${restorePreview.replace(/\s+/g, ' ').slice(0, 90)})`,
  );
  check(
    (await byId('live-rec-restore-merge').count()) === 0,
    'recovery: nothing to add from a backup of this very device',
  );
  await page.screenshot({ path: path.join(shotsDir, '38-live-recovery-restore.png') });
  await byId('live-rec-restore-cancel').click({ timeout: 10_000 });
  rmSync(backupPath, { force: true });

  // 4. THE POINT OF ALL OF IT: forget the password, and get back in.
  await backToHome();
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-app-lock').waitFor({ timeout: 15_000 });
  await byId('live-app-lock-forgot').click({ timeout: 10_000 });
  await byId('live-recover-menu').waitFor({ timeout: 10_000 });
  check(
    !/erase|wipe/i.test(await byId('live-recover-menu').innerText()),
    'recovery: the lock screen offers no destructive reset (§13.10)',
  );
  await page.screenshot({ path: path.join(shotsDir, '39-live-recovery-forgot.png') });
  await byId('live-recover-use-code').click({ timeout: 10_000 });
  await byId('live-recover-code-input').fill(recoveryCode.toLowerCase().replace(/-/g, ' '));
  await byId('live-recover-new-pw').fill(RECOVERED_PASSWORD);
  await byId('live-recover-new-pw2').fill(RECOVERED_PASSWORD);
  await byId('live-recover-submit').click({ timeout: 10_000 });
  await byId('live-home').waitFor({ timeout: 90_000 });
  check(
    true,
    'recovery: the code opens the wallet, typed in lower case with spaces for hyphens',
  );

  // 5. And the password it set is the password now.
  await byId('live-lock-btn').click({ timeout: 10_000 });
  await byId('live-app-lock').waitFor({ timeout: 15_000 });
  await submitAppPassword(APP_PASSWORD);
  await page.waitForTimeout(2500);
  check(
    (await byId('live-app-lock').count()) === 1,
    'recovery: the FORGOTTEN password no longer opens the wallet',
  );
  await submitAppPassword(RECOVERED_PASSWORD);
  await byId('live-home').waitFor({ timeout: 90_000 });
  check(true, 'recovery: the password chosen during the recovery is the password now');

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
