# AGENTS.md — read this first

Onboarding for the next agent (or human) working on this repo.

## What this is

**Satori GO** — a *real*, non-custodial **EVRmore (EVR) + assets** wallet, shipped
as a **Chrome MV3 extension**. It moves **real money on Evrmore mainnet**. It is
not a demo, not a simulation, not a testnet toy.

Some internal identifiers are **frozen legacy names** kept for compatibility and
must never be renamed: the `window.evrmore` provider API and its `isEvrNexus: true`
flag (integrations detect the wallet by it), the internal postMessage source tags
(`evr-nexus-inpage`/`evr-nexus-content`), and the `evrdemo:` storage namespace
(renaming it would orphan every existing user's encrypted vault). They are wire/
storage constants, not branding; the product name everywhere user-facing is
Satori GO.

## Design: match Satori, don't invent

The theme is **derived from the Satori neuron's own stylesheet** so the wallet and
the neuron look like one product. A Satori dev's review of the old theme was blunt:
it *"gives too much AI coded vibe"*. Read the header of `src/styles/global.css`
before changing any visual token, and do not reintroduce:

- a **navy/blue-tinted** background (the base is pure greyscale: `#0d0d0d`/`#141414`),
- a **two-hue accent gradient** (blue→violet). The accent is one hue, `#5a5aff`,
  shading to `#4040cc` — a tonal shift, never a rainbow,
- **translucent "glass" cards** or **accent-coloured glow** shadows,
- **gradient-filled headings**,
- big pill-like **radii** (the neuron's workhorse is 6px).

The ambient indigo/violet glow at the top of the frame **is** Satori — the neuron
has exactly that (`body::before`/`::after`). It was verified by screenshotting the
running neuron, not assumed.

**Inter must stay bundled** (`src/styles/fonts.css`). Extension pages run under
`font-src 'self'`, so the Google-Fonts CDN link the neuron uses would be blocked and
silently fall back to Segoe UI. Only the `latin` + `latin-ext` subsets ship (EN/PL);
adding a language in another script means adding its subset.

### Copy rule: no em-dashes

The owner's instruction: **do not use the "—" character in any user-facing string** in
the wallet, because it reads as AI-written. Use a full stop, a colon, a semicolon, or
"·" as a separator. A missing value renders as `n/a`, not as a dash. This applies to
UI text and i18n strings; code comments are not user-facing and are exempt.

Primary ecosystem target: the **Satori Network** (asset `SATORIEVR`), including a
`window.evrmore` provider so sites can connect, request sends, and request
message signatures (Satori login).

## Golden rules (non-negotiable)

1. **Never claim something was tested if you did not run it.** State plainly what
   you ran and what you did not. A green typecheck is not a test; a passing unit
   test is not proof the extension works.
2. **This handles real funds.** A bug here loses someone's money. Prefer failing
   closed (abort the send) over guessing.
3. **Never weaken a security control** to make a test pass. Fix the test, or the
   design. See `docs/SECURITY.md` for the controls and *why* each exists.
4. **Secrets:** seed/private key exist in memory only while unlocked, and on disk
   only as AES-256-GCM ciphertext. Never log them, never persist them in plaintext,
   never send them to the background worker, a content script, or a page.
5. **Verify against reality.** Chain facts get verified against the Evrmore source
   or a live server — not from memory. Several "obvious" assumptions were wrong
   (see `docs/GOTCHAS.md`).

## Commands

```bash
npm run typecheck          # tsc --noEmit
npm run lint               # eslint
npm test                   # vitest run  (296 tests)
npm run build              # typecheck + vite build -> dist/chrome
npm run package            # build + zip -> release/
npm run qa:live            # live smoke: drives the BUILT extension vs the REAL chain
npm run qa:dapp            # dApp smoke: real page + window.evrmore end-to-end
```

**Definition of done** for anything non-trivial: `typecheck` + `lint` + `test` +
`build` + **both smokes**. The smokes are the only thing that proves the actual
extension works; they load `dist/chrome` in Playwright Chromium and talk
to real ElectrumX servers. Run them. They take a couple of minutes.

Load unpacked in Chrome from `dist/chrome`.

## Architecture map

```
src/services/chain/     # SAFETY-CRITICAL. Read carefully before touching.
  chainParams.ts        #   Evrmore network constants (verified vs upstream source)
  keys.ts               #   BIP39/32/44 derivation, base58check, WIF, scripthash
  vault.ts              #   AES-256-GCM + scrypt(N=2^17) encrypted vault
  txBuilder.ts          #   tx serialize/sign (LEGACY sighash), coin selection, fee
  assetScript.ts        #   OP_EVR_ASSET (0xc0) transfer scripts
  verifyUtxo.ts         #   trustless prevout-amount verification (anti fund-drain)
  message.ts            #   Evrmore signed-message (Satori-compatible signMessage)
  liveWallet.ts         #   LiveWalletService: the single chokepoint for sends
  electrumClient.ts     #   wss JSON-RPC client + server pool
  electrumProvider.ts   #   watch-only reads (balances, history, asset meta)
src/services/satoriPool.ts # HTTP client for Satori pool staking (network.satorinet.io);
                        #   join/leave a pool = register the address as a lender (NOT a
                        #   tx). Signs the auth challenge via chain/message.ts. No crypto.
src/store/liveStore.ts  # zustand store; all UI state + persisted settings
src/screens/live/       # wallet UI
  LiveStaking.tsx       #   SATORIEVR pool staking screen (status, pools, join/leave)
src/screens/dapp/       # DappApproval — the explicit gate for connect/send/sign
src/background/         # MV3 service worker: dApp broker + deposit notifications
public/inpage.js        # window.evrmore provider (MAIN world)
public/content.js       # page <-> worker relay (stamps the true origin)
scripts/*-smoke.mjs     # end-to-end verification against the real chain
```

**Every send goes through `LiveWalletService.buildEvrSend` / `buildAssetSend`.**
That is the chokepoint where recipient validation and input-amount verification
live. Put new send-path safety checks there, not only in the UI.

## Invariants you must not break

- **Amounts:** every Evrmore asset — EVR *and* every issued asset — is stored
  on-chain in **1e8 base units**. An asset's `divisions` is a *display* property
  only. Do not scale by `divisions`.
- **Derivation:** `m/44'/175'/0'/0/i` (SLIP-44 coin type **175**), compressed
  pubkeys, P2PKH version byte **33** ('E'), WIF **128**.
- **Sighash is LEGACY** (pre-BIP143, no SegWit). Input amounts are **not** committed
  in the signature — hence `verifyUtxo.ts`. Do not remove it.
- **Outputs are P2PKH only.** Recipients must pass `isP2pkhAddress()`; a P2SH
  address would silently build an unspendable output. `isValidAddress()` is *not*
  sufficient — it also accepts P2SH.
- **dApp:** origin is stamped by `content.js` from `location.origin` (a page cannot
  forge it); the worker only accepts approval results from an extension page; every
  send *and* every signMessage is individually approval-gated even for a connected
  origin; **no keys in the worker**.

## Current state

- Version **1.0.0** (HELD at 1.0.0 until production launch — the owner bumps versions, not agents; pre-launch changes ship without a bump).
- 296 tests. Live + dApp smokes green.
- See `docs/SECURITY.md` for the audit: what was fixed and **what is still open**.
  **M2 is now FIXED** — a dApp's approval is bound to a specific `{origin, walletId}`
  (`src/background/approvals.ts`), so switching the active wallet no longer exposes it
  to a site approved only for a different wallet; it fails closed with `not-connected`
  and re-prompts. Proven by `scripts/dapp-smoke.mjs` (wallet-switch scenario).

## Where to learn the "why"

The `docs/` directory is **local-only** (gitignored, not published to the public
repo — the owner's decision). It exists on the development machine; do not commit
it, and do not link to it from files that are published.

- `docs/GOTCHAS.md` — verified chain facts and the **assumptions that turned out
  wrong and cost real debugging time**. Read it before you assume anything.
- `docs/CHAIN_PARAMS.md` — chain constants, with their upstream source.
- `docs/SECURITY.md` — threat model, controls, audit findings, open items.
- `docs/STORE_LISTING.md` — the Chrome Web Store submission pack.
- `docs/screenshots/` — funded-wallet captures that feed `scripts/store-assets.mjs`.
