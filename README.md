# Satori GO

> **Non-custodial multi-chain browser wallet made by Satori Network**


A real, non-custodial multi-chain browser wallet made by Satori Network. Built as
Manifest V3, React + TypeScript + Vite, for **Chrome, Edge and Firefox** from one
shared codebase (see `platforms/` below). It runs its own pure‑JS crypto engine
(BIP39/BIP32/BIP44, base58check + legacy signing) inside the extension, talks to
the live network over ElectrumX (`wss://`), and lets web pages connect through an
injected `window.evrmore` provider. Chrome is the only target that is fully gated
and shipped-quality today; see `KNOWN_LIMITATIONS.md` for Firefox's unverified
runtime status.

The chain layer also carries **Ravencoin (RVN)** — the sister chain that shares
Evrmore's key derivation (same coin type, same address algorithm, only the
version byte differs) — with its own per-chain Electrum server pool, block
explorer and chain-aware address validation. You can create or import a
Ravencoin wallet from the same onboarding flow. It is built and unit-tested but
not yet verified end-to-end against the real Ravencoin network; see
`KNOWN_LIMITATIONS.md` (Platform section) for exactly what is and isn't proven.

Version **1.1.1**. (The canonical version lives in each target's manifest under
`platforms/<target>/manifest.json`; this line is informational and can lag —
check the manifest if in doubt.)

## Official links

- **Source code:** https://github.com/SatoriNetwork/SatoriGO — the ONLY official repository.
- **Website:** https://satorinet.io (the Satori Network; Satori GO is a community
  wallet built for it).
- **Releases:** installable builds come from this repository (`npm run package` →
  `release/satori-go-chrome.zip`, `release/satori-go-edge.zip`, `release/satori-go-firefox.zip`)
  and, in the future, the official Chrome Web Store listing (the only store listing that
  exists today; Edge Add-ons and Firefox AMO are not published yet). **Beware of forks
  or lookalike listings** — a wallet fork can trivially steal funds. Verify you install
  from the links above.

## ⚠️ Security status (read this)

This wallet moves **real funds on Evrmore mainnet**. It is **unaudited beta**
software (the code has had an internal adversarial review, not a formal external
audit). Use only amounts you can afford to lose, and **always do a small test send
first**. See the in‑app note under **Settings → About**.

- Seeds/keys are stored **only** as AES‑256‑GCM ciphertext (scrypt N=2¹⁷ for new
  vaults; older vaults upgrade on next password change); passwords are never stored.
- Mainnet transactions are built + signed locally and broadcast behind an explicit
  **Confirm & Send** step (with your password unless the wallet is passwordless).
- The network fee is clamped against a hostile Electrum server (rate cap + a hard
  1‑EVR ceiling per transaction).
- **Input amounts are verified trustlessly** before signing: each spent output is
  re‑fetched and its bytes are checked to hash to the claimed txid, so a lying
  server can’t under‑report values to inflate the real fee (Evrmore’s legacy
  sighash doesn’t commit input amounts).
- Sends are restricted to standard **P2PKH** recipients; P2SH / wrong‑network
  addresses are rejected rather than silently built into an unspendable output.
- Every website connection, send and **message signature** is individually
  approval‑gated; a site can’t spoof its origin or forge an approval, and at most
  one approval prompt per origin can be open (anti‑popup‑flood).
- New vaults use scrypt **N=2¹⁷**; secret fields (seed/private‑key entry, revealed
  password) suppress spellcheck/autocomplete so nothing leaks to a spellcheck
  service; clipboard copies of a secret are **force‑cleared** within 30 s
  regardless of the clipboard‑clear setting; a password‑strength meter is shown
  on new‑password fields (advisory only — it never blocks a weak‑but‑valid password).

## Features

- **Multiple wallets** — HD (BIP39 seed) or single **private‑key / Satori** wallets
  (import a WIF/hex key → one address, the way Satori‑network wallets are generated).
  Optional **passwordless** wallets. Switch, rename, remove; last‑used preselected on
  the lock screen; create/import straight from the lock screen.
- **Dynamic assets (MetaMask‑style)** — auto‑detects every EVRmore asset you hold
  (incl. **SATORIEVR**), plus add any asset by name (validated on‑chain) and remove.
- **Multiple receive addresses** per HD wallet, with balances/UTXOs aggregated across
  them.
- **Send EVR and assets** with a real signed‑tx review; **quick send between your own
  wallets** by name; **address book**.
- **SATORIEVR pool staking** — delegate your SATORIEVR to a Satori pool. **No funds
  move**: your tokens stay on your address, which is registered as a pool *lender*
  on `network.satorinet.io`; the auth challenge is signed locally with your key.
- **Live data** — real balances/history over ElectrumX, cached locally for fast
  incremental refresh; connection LED (green/yellow/red).
- **Reveal** recovery phrase / private key (password‑gated), **CSV export**,
  **auto‑lock**, editable block‑explorer link.
- **dApp connect** — `window.evrmore` provider so websites (e.g. the Satori neuron UI)
  can connect, request sends and **request message signatures** (`signMessage`, for
  Satori login / proof‑of‑address), each behind an explicit approval window.
- **Incoming‑funds notifications** — an opt‑in background poll shows a desktop
  notification when EVR or an asset arrives in any of your wallets (Settings → Security).

## Install (Load unpacked)

Build first if the target's `dist/` folder doesn't exist:

```bash
npm install
npm run build             # typecheck once + build all three -> dist/chrome, dist/edge, dist/firefox
npm run build:chrome      # or just one target
npm run package           # build + zip all three -> release/satori-go-<target>.zip
```

**Chrome / Chromium (Brave, Opera, …):**

```text
1. Open chrome://extensions
2. Enable Developer mode
3. Click "Load unpacked"
4. Select the dist/chrome folder
5. Pin "Satori GO" to the toolbar
```

**Edge:** the same Chromium MV3 build under a separate manifest/zip.

```text
1. Open edge://extensions
2. Enable Developer mode
3. Click "Load unpacked"
4. Select the dist/edge folder
```

**Firefox — load as a temporary add-on for testing only:**

```text
1. Open about:debugging#/runtime/this-firefox
2. Click "Load Temporary Add-on…"
3. Select any file inside the dist/firefox folder (e.g. manifest.json)
```

⚠️ The Firefox build passes `addons-linter` with 0 errors and a full manual
click-through on real Firefox (wallet lifecycle, send, dApp connect/sign, deposit
notifications), but there is **no automated Firefox smoke test** yet — the
Playwright smokes cover Chrome only; see `KNOWN_LIMITATIONS.md` items 18-20.
A temporary add-on also unloads on browser restart; permanent install requires
AMO signing, which hasn't happened yet.

After updating the extension, Chrome/Edge may re‑prompt for permissions (the
content‑script permission was added for dApp connect).

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Typecheck once + production build to `dist/chrome`, `dist/edge`, `dist/firefox` |
| `npm run build:chrome` / `build:edge` / `build:firefox` | Build a single target |
| `npm run package` | Build all three + zip to `release/satori-go-<target>.zip` |
| `npm run package:chrome` / `package:edge` / `package:firefox` | Build + zip a single target |
| `npm test` | Unit tests (crypto engine + live wallet + tx cache) |
| `npm run typecheck` / `npm run lint` | TS / ESLint |
| `node scripts/live-extension-smoke.mjs` (`npm run qa:live`) | Playwright end‑to‑end against the **real chain** — loads the **Chrome** build only |
| `node scripts/dapp-smoke.mjs` (`npm run qa:dapp`) | End‑to‑end dApp‑connect proof — loads the **Chrome** build only |

---

## Integrating a website with the wallet (`window.evrmore`)

When the extension is installed, it injects a provider into every page. A site talks
to the wallet through `window.evrmore`; **every connection and every send is gated by
an explicit approval window** — the site never sees your keys, only your address,
balances and txids.

### 1. Detect the provider

The provider may be injected slightly after your script runs, so wait for it:

```js
function getEvrmore(timeout = 3000) {
  if (window.evrmore) return Promise.resolve(window.evrmore);
  return new Promise((resolve, reject) => {
    window.addEventListener('evrmore#initialized', () => resolve(window.evrmore), { once: true });
    setTimeout(
      () => (window.evrmore ? resolve(window.evrmore) : reject(new Error('Satori GO wallet not found'))),
      timeout,
    );
  });
}
```

`window.evrmore.isEvrNexus === true` identifies this wallet (the `isEvrNexus` flag
name is a legacy code identifier kept for backward compatibility with existing
integrations; the product is now called **Satori GO**).

### 2. Connect (asks the user to approve your origin)

```js
const evrmore = await getEvrmore();
const { address } = await evrmore.connect();   // opens an approval window
console.log('connected address:', address);    // e.g. "EMc6Ld…X2D9Ew"
```

`connect()` resolves with the active wallet's address once the user approves your
site. If they reject or close the window it **rejects** with `user-rejected`.

### 3. Read the address and balances (approved sites only)

```js
const address  = await evrmore.getAddress();    // rejects "not-connected" if not approved
const balances = await evrmore.getBalances();
// -> [{ name: "EVR", amount: 12.5, decimals: 8 }, { name: "SATORIEVR", amount: 3, decimals: 8 }, …]
```

Amounts are already in whole units (not sats).

### 4. Request a send (always approval‑gated)

```js
// Amounts are decimal whole units. Both open an approval window where the user
// reviews the recipient, amount and the REAL network fee before it is broadcast.
const txid  = await evrmore.sendEvr('Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF', 1.25);
const txid2 = await evrmore.sendAsset('Ef4Ei…', 'SATORIEVR', 3);
console.log('broadcast txid:', txid);
```

The promise resolves with the broadcast **txid**, or rejects — common errors:
`user-rejected`, `not-connected`, `insufficient-funds`, `insufficient-asset`,
`invalid-amount`, `unknown-asset`.

### 5. Sign a message (login / proof‑of‑address)

```js
// Opens an approval window showing your origin + the exact message. Signing costs
// nothing, moves no funds and never exposes a key. Approval‑gated like a send.
const { address, signature } = await evrmore.signMessage('Login to Satori: <nonce>');
```

The signature is a base64, `evrmore-cli verifymessage`‑compatible recoverable
signature over `sha256d( varstr("Evrmore Signed Message:\n") || varstr(message) )`
— the same format Satori’s backend verifies. Verify it server‑side with
python‑evrmorelib / `evrmore-cli verifymessage "<address>" "<signature>" "<message>"`.
Rejects with `user-rejected` or `not-connected`.

### Full API

```ts
interface EvrmoreProvider {
  isEvrNexus: true;
  request(args: { method: string; params?: any }): Promise<any>; // low-level
  connect(): Promise<{ address: string }>;
  getAddress(): Promise<string>;
  getBalances(): Promise<Array<{ name: string; amount: number; decimals: number }>>;
  sendEvr(to: string, amount: number): Promise<string /* txid */>;
  sendAsset(to: string, assetName: string, amount: number): Promise<string /* txid */>;
  signMessage(message: string): Promise<{ address: string; signature: string }>;
}
```

### Minimal “Connect wallet” button

```html
<button id="connect">Connect Satori GO</button>
<pre id="out"></pre>
<script>
  document.getElementById('connect').onclick = async () => {
    try {
      const evrmore = window.evrmore;
      if (!evrmore) throw new Error('Satori GO wallet not installed');
      const { address } = await evrmore.connect();
      const balances = await evrmore.getBalances();
      out.textContent = 'Address: ' + address + '\n' + JSON.stringify(balances, null, 2);
    } catch (e) { out.textContent = 'Error: ' + (e.message || e); }
  };
</script>
```

### Security notes for integrators

- Your site's **origin** is stamped by the extension's content script (from
  `location.origin`) — you cannot spoof another site's origin, and the user sees the
  real origin in the approval window.
- The user approves your origin once (via `connect()`); you can then read the
  address/balances. **Every send still requires a fresh approval** — there is no
  silent‑send path.
- The user can revoke your site any time under **Settings → Connected sites**; the
  next call then rejects with `not-connected`.

---

## Architecture (short)

- **`src/services/chain/`** — the crypto engine: `chainParams` (Evrmore +
  Ravencoin network constants, source-verified), `keys` (BIP39/32/44,
  base58check, WIF), `vault` (AES‑GCM+scrypt), `txBuilder` (legacy
  SIGHASH_ALL, RFC6979 low‑S, DER), `assetScript` (OP_EVR_ASSET/OP_RVN_ASSET),
  `electrumClient`/`electrumProvider` (wss, per-chain server pool), `txCache`,
  and `liveWallet` (the keystone service; each wallet carries its own chain id).
  All pure‑JS, CSP‑safe.
- **`src/store/liveStore.ts`** — zustand state for the wallet UI.
- **`src/screens/live/`** — the wallet UI; **`src/screens/dapp/DappApproval.tsx`** —
  the approval window.
- **`public/inpage.js`** (injected `window.evrmore`), **`public/content.js`** (relay),
  **`src/background/index.ts`** (built module service worker / dApp broker).
- **`platforms/{chrome,edge,firefox}/manifest.json`** — one manifest per browser
  target (manifest.json no longer lives in `public/`); **`scripts/build.mjs`**
  builds shared `src/`/`public/` per target and copies in the right manifest,
  overlaying `platforms/<target>/overrides/` if present.

## Documentation

Start here if you're picking this project up (human or AI):

| Doc | What it's for |
|---|---|
| **[`AGENTS.md`](AGENTS.md)** | **Read first.** Onboarding: golden rules, commands, architecture map, invariants you must not break. |
| [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) | Honest limitations of the shipping wallet. |

## License

[MIT](LICENSE) © 2026 WilQSL. The Satori name and logo belong to the Satori
Network ([BrandingKit](https://github.com/SatoriNetwork/BrandingKit));
