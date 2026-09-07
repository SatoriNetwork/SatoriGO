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

The chain layer carries eight coin networks, each with its own Electrum server
pool, block explorer, fee policy and chain-aware address validation, plus four
EVM networks behind one account, and you can create or import a wallet on any
of them from the same onboarding flow. Chains
are described by parameters rather than by name, so support is a data entry
rather than a special case.

Every one of them has had a funded send confirmed on mainnet by the project
owner's own testing (the first seven coin networks on 2026-08-16, Base and BNB
Chain on 2026-08-18, and Neoxa, Ethereum and Epix on 2026-08-27), on top of the
automated verification of derivation, address validation, balance reading, fee
estimation and transaction building.
See `KNOWN_LIMITATIONS.md` for what is and is not covered by that.

### Supported networks

Listed in the order the wallet shows them. "Assets" means the chain has its own
on-chain token layer that the wallet reads; the others carry their native coin
only. "Funded send" records whether a real transaction has been sent and
confirmed by a person, which is the bar this project treats as proof. Every one
of them has been, by the owner's own testing rather than by an automated run.

**Coin networks.** Each derives its own address from the wallet you already
have, with its own servers, block explorer and fee rules.

| Network | Ticker | Addresses | Assets | Funded send | Project |
|---|---|---|---|---|---|
| Bitcoin | BTC | native segwit | no | **confirmed** | [bitcoin.org](https://bitcoin.org) |
| Litecoin | LTC | native segwit | no | **confirmed** | [litecoin.org](https://litecoin.org) |
| Dogecoin | DOGE | legacy | no | **confirmed** | [dogecoin.com](https://dogecoin.com) |
| Evrmore | EVR | legacy | yes | **confirmed** | [evrmore.com](https://evrmore.com) |
| Ravencoin | RVN | legacy | yes | **confirmed** | [ravencoin.org](https://ravencoin.org) |
| BitcoinGold | BTGS | native segwit | no | **confirmed** | [bitcoingold.site](https://bitcoingold.site) |
| WojakCoin | WJK | legacy | no | **confirmed** | [wojakcoin.cash](https://wojakcoin.cash) |
| Neoxa | NEOX | legacy | yes | **confirmed** | [neoxa.net](https://neoxa.net) |
| Bitcoin BLAKE2b | BTCB2 | native segwit | no | not yet | [bitcoin-blake2b.org](https://bitcoin-blake2b.org) |

**EVM networks.** One account across all of them: the same seed gives the same
address everywhere, so switching network changes what you are looking at and
never who you are. ERC-20 tokens can be added by contract address, found by
name, or imported from what the account already holds.

| Network | Coin | Chain id | Notes | Funded send | Project |
|---|---|---|---|---|---|
| Ethereum | ETH | 1 | | **confirmed** | [ethereum.org](https://ethereum.org) |
| Base | ETH | 8453 | L1 data fee on top of gas | **confirmed** | [base.org](https://base.org) |
| BNB Chain | BNB | 56 | | **confirmed** | [bnbchain.org](https://www.bnbchain.org) |
| Epix | EPIX | 1916 | native staking (cosmos/evm) | **confirmed** | [epix.zone](https://epix.zone) |

BitcoinGold is a new Bitcoin Core fork and is **not** the 2017 Bitcoin Gold
(BTG). It, WojakCoin, Epix and Bitcoin BLAKE2b are young or thin networks: such
a chain can stop producing blocks, leaving a payment unconfirmed until it
recovers, and the wallet marks them and says so when you open one. Neoxa is
marked as new here without that warning, because it is new to this wallet rather
than a young network.

Bitcoin BLAKE2b is the Bitcoin Knots proof-of-work fork (active from block
961640, 30 August 2026): Bitcoin's history under a different proof of work, so
a Bitcoin address is also an address there and a coin held before the fork sits
at the same address on both chains. Sends on it are signed with the fork's own
signature format (SIGHASH_UNIFIED), which Bitcoin does not accept, so nothing
sent there can be replayed onto Bitcoin. The reverse is outside the wallet's
control until the coins have been sent to yourself once on the BLAKE2b chain.
It reaches the wallet through a single server behind the gateway, is priced from
the NonKYC BTCB2/USDT market, and a funded send has not been confirmed by the
owner yet.

Any network can be hidden from the switcher in expert Settings, so a wallet that
only uses two of them need not scroll past the rest.

### How the wallet reaches them

Every network request goes through one host, `network.satorigo.app`, run by this
project. It serves three things: public exchange prices, read and broadcast
access to the EVM networks (JSON-RPC, transaction history, public token lists and
token logos), and a WebSocket bridge to the Electrum servers of the coin
networks.

It exists so your browser is not making requests to a list of third-party
providers directly, and so no API key has to ship inside the extension. It never
receives a key, a recovery phrase or a password: what reaches it is what any
blockchain node receives, public addresses to look up and transactions you have
already approved.

Each coin network keeps its usual public servers listed behind the gateway as a
fallback, so an outage there costs you the gateway and nothing more. Two are the
exception on purpose, Ravencoin and Neoxa: neither has a public server this
wallet can safely use, because the generally available ones do not speak the
asset protocol those chains need and falling back to one would report wrong
asset balances rather than failing. Both go through the gateway alone and are
offline while it is unreachable. You can add your own server for either in
Settings > Network. `KNOWN_LIMITATIONS.md` records which networks are currently
reaching the chain some other way and what that costs.

Version **1.4.2**. (The canonical version lives in each target's manifest under
`platforms/<target>/manifest.json`; this line is informational and can lag —
check the manifest if in doubt.)

## Official links

- **Source code:** https://github.com/SatoriNetwork/SatoriGO — the ONLY official repository.
- **Website:** https://satorigo.app (the wallet), and https://satorinet.io (the
  Satori Network; Satori GO is a community wallet built for it).
- **Releases:** installable builds come from this repository (`npm run package` →
  `release/satori-go-chrome.zip`, `release/satori-go-edge.zip`, `release/satori-go-firefox.zip`)
  and, in the future, the official Chrome Web Store listing (the only store listing that
  exists today; Edge Add-ons and Firefox AMO are not published yet). **Beware of forks
  or lookalike listings** — a wallet fork can trivially steal funds. Verify you install
  from the links above.

## ⚠️ Security status (read this)

This wallet moves **real funds on live networks**. It is **unaudited beta**
software (the code has had an internal adversarial review, not a formal external
audit). Use only amounts you can afford to lose, and **always do a small test send
first**. See the in‑app note under **Settings → About**.

- Seeds/keys are stored **only** as AES‑256‑GCM ciphertext (scrypt N=2¹⁷ for new
  vaults; older vaults upgrade on next password change); passwords are never stored.
- **One password for the whole wallet** is optional. Under it the master key is
  random and the password merely wraps it, so changing the password rewrites 32
  bytes and touches no vault. A **recovery code** holds a second wrapping of the
  same key, which is why it keeps working across password changes, and an
  **encrypted backup file** carries the whole store under a password of its own.
  Nothing about any of them reaches a server, so a forgotten password has no
  reset anyone can send you: the code, the file and your recovery phrase are the
  three ways back, and the wallet says so where you set the password.
- Mainnet transactions are built + signed locally and broadcast behind an explicit
  **Confirm & Send** step (with your password unless the wallet is passwordless).
- The network fee is clamped against a hostile server: an untrusted estimate is
  forced into that chain's own floor/ceiling band before it can be used, and the
  EVM networks carry a per-network cap of their own.
- **Input amounts are verified trustlessly** before signing: each spent output is
  re‑fetched and its bytes are checked to hash to the claimed txid, so a lying
  server can’t under‑report values to inflate the real fee (Evrmore’s legacy
  sighash doesn’t commit input amounts).
- Sends go to **P2PKH and native segwit** recipients, whichever the chain
  actually uses; P2SH and wrong-network addresses are rejected rather than
  silently built into an unspendable output.
- **The broadcast answer is checked, not trusted.** After a send the wallet
  compares what the server returned against the transaction id it computed
  itself, so a server cannot report a different transaction, or a success it did
  not perform, and have the wallet believe it.
- **A token has to earn the wallet's word.** It is vouched for only when it is on
  the network's public token list AND carries a registry mark; anything else is
  shown as unverified rather than dressed up as genuine, and a token cannot mark
  itself.
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
- **One password for the whole wallet** (optional) — type it once, then choose a
  wallet, instead of a password each. With two ways back if you forget it: a
  **recovery code** that keeps working across any number of password changes, and
  an **encrypted backup file** that survives losing the computer. Neither involves
  a server, because there is none to involve.
- **Dynamic assets (MetaMask‑style)** — auto‑detects the on‑chain assets you hold on
  a chain that has them, plus add any asset by name (validated on‑chain) and remove.
- **ERC‑20 tokens** on the EVM networks — add by contract address, search the
  network's public token list by name, or import what an account already holds. The
  wallet only vouches for a token that is on that list **and** carries a registry
  mark; anything else is shown as unverified rather than dressed up as genuine.
- **Multiple receive addresses** per HD wallet, with balances/UTXOs aggregated across
  them; multiple **accounts** per seed on the EVM networks.
- **Send coins, assets and tokens** with a real signed‑tx review; **quick send between
  your own wallets** by name; **address book**.
- **Staking** — native staking where the network supports it, with what you have
  staked, what it has earned and a sortable validator list. Plus **SATORIEVR pool
  staking**: delegate to a Satori pool with **no funds moving**, since your tokens
  stay on your address, which is registered as a pool *lender* on
  `network.satorinet.io`; the auth challenge is signed locally with your key.
- **Side panel** — on Chrome and Edge the wallet docks beside the page you are on and
  stays open while you browse. That is the default; the toolbar popup is one toggle
  away in Settings.
- **Live data** — real balances/history over ElectrumX, cached locally for fast
  incremental refresh; connection LED (green/yellow/red).
- **Reveal** recovery phrase / private key (password‑gated), **CSV export**,
  **auto‑lock**, editable block‑explorer link.
- **dApp connect** — `window.evrmore` provider so websites (e.g. the Satori neuron UI)
  can connect, request sends and **request message signatures** (`signMessage`, for
  Satori login / proof‑of‑address), each behind an explicit approval window.
- **Incoming‑funds notifications** — an opt‑in background poll shows a desktop
  notification when a coin, asset or token arrives in any of your wallets
  (Settings → Notifications).
- **Notices from Satori Network** — short messages can appear on the home screen
  (an update, a network's status). They are dismissible, they take turns when
  there is more than one, and one you closed comes back only if it is sent out
  again.
- **Several windows at once** — the popup, the side panel and a detached window
  are separate pages, and each stays on the wallet it opened rather than
  following the others.
- **A wallet with no password is asked to set one, once.** A passwordless wallet
  keeps its seed under an empty passphrase, so anyone with the computer can spend
  from it. On opening one the wallet asks for an app password and offers the
  recovery phrase first, since that is the last easy moment to write it down.

## Install (Load unpacked)

Build first if the target's `dist/` folder doesn't exist:

```bash
npm install
npm run build             # typecheck once + build all three STORE packages -> dist/store/{chrome,edge,firefox}
npm run build:evm         # the EVM build -> dist/chrome (the folder you load unpacked)
npm run build:chrome      # or just one target
npm run package           # build + zip all three -> release/satori-go-<target>.zip
```

**Chrome / Chromium (Brave, Opera, …):**

```text
1. Open chrome://extensions
2. Enable Developer mode
3. Click "Load unpacked"
4. Select the dist/chrome folder (always the EVM build; store packages live
   under dist/store/ and never overwrite it)
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
| `npm run build` | Typecheck once + production STORE build to `dist/store/chrome`, `dist/store/edge`, `dist/store/firefox` |
| `npm run check:dist` | Verify `dist/chrome` (the unpacked folder) is an EVM build |
| `npm run build:chrome` / `build:edge` / `build:firefox` | Build a single target |
| `npm run package` | Build all three + zip to `release/satori-go-<target>.zip` |
| `npm run package:chrome` / `package:edge` / `package:firefox` | Build + zip a single target |
| `npm test` | Unit tests (crypto engine + live wallet + tx cache) |
| `npm run typecheck` / `npm run lint` | TS / ESLint |
| `node scripts/live-extension-smoke.mjs` (`npm run qa:live`) | Playwright end‑to‑end against the **real chain** — loads the **Chrome** build only |
| `node scripts/dapp-smoke.mjs` (`npm run qa:dapp`) | End‑to‑end dApp‑connect proof — loads the **Chrome** build only |
| `npm run build:evm` | Build the EVM development target to `dist/chrome` (the folder you load unpacked) |
| `node scripts/evm-extension-smoke.mjs` (`npm run qa:evm`) | End‑to‑end against the real EVM networks |
| `node scripts/gateway-bridge-check.mjs [chain]` | Is every network reachable through the gateway right now: server, tip, latency, and the chain's identity where it is known |
| `npx vite-node scripts/electrumx-probe.ts -- <host> <port> <chainId> [tls]` | Is an ElectrumX server usable by this wallet: identity, the calls the wallet makes, and the asset dialect where the chain has one |

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

- **`src/services/chain/`** — the crypto engine: `chainParams` (per-network
  constants for every coin network, each source-verified against that chain's own
  `chainparams.cpp`), `keys` (BIP39/32/44, base58check, WIF), `vault`
  (AES‑GCM+scrypt) with `appKey` and `backup` above it (one password for the
  wallet, the recovery code and the encrypted backup file), `txBuilder` (legacy
  SIGHASH_ALL, RFC6979 low‑S, DER), `assetScript` (OP_EVR_ASSET/OP_RVN_ASSET),
  `electrumClient`/`electrumProvider` (wss, per-chain server pool), `txCache`,
  and `liveWallet` (the keystone service; each wallet carries its own chain id).
  All pure‑JS, CSP‑safe.
- **`src/services/chain/evm/`** — the EVM engine, behind a build flag: JSON‑RPC,
  RLP and transaction signing, the chain registry, ERC‑20, fee models per network,
  address‑history indexers, and the cosmos/evm staking precompiles. One account
  spans every EVM network, so `engine.ts` is the seam that decides which family a
  wallet belongs to.
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
| [`CHANGELOG.md`](CHANGELOG.md) | What each release added, in plain language. |
| [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) | Honest limitations of the shipping wallet. |
| [`REVIEWERS.md`](REVIEWERS.md) | Build environment and exact steps to reproduce the published add-on package. |
| [`PRIVACY.md`](PRIVACY.md) | What the wallet stores and what it talks to. |

## License

[MIT](LICENSE) © 2026 WilQSL. The Satori name and logo belong to the Satori
Network ([BrandingKit](https://github.com/SatoriNetwork/BrandingKit));
