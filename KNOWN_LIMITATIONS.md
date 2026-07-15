# Known limitations

Current, honest limitations of the **real** wallet (v1.1.1).

## Security / trust

1. **No formal external audit.** The code has had an internal adversarial review —
   not a professional third-party audit. It moves real mainnet funds. **Do a small
   test send before a large one.**
2. **Message signing is not origin-bound.** A malicious site can ask you to sign a
   message worded for a *different* site and reuse the signature there. The approval
   window shows the exact message — read it. (Inherent to the Evrmore signmessage
   format, which must stay byte-compatible with Satori.)
3. **Passwordless wallets** are a deliberate convenience trade-off: they auto-unlock,
   and sends/signatures require only click-throughs. Opt-in, behind an explicit
   "I understand the risk" acknowledgement (v0.0.18).
   Their vault is AES-GCM under an **empty** passphrase — anyone with access to
   the Chrome profile on disk can decrypt it without any password.
4. **Clipboard clearing is best-effort.** Copying a secret force-schedules a
   clear (≤ 30 s), but the timer runs in the popup — close the popup first and
   the clipboard is never cleared. OS clipboard history (Win+V) or cloud
   clipboard sync may capture the value before the clear fires.
5. **Public metadata is stored unencrypted** in `chrome.storage.local`: wallet
   addresses, the address book, cached tx history, approved dApp origins and the
   deposit-notification snapshot. No secrets — but someone with disk access
   learns your addresses, balances and contacts without a password (partly
   unavoidable: the background worker needs addresses without an unlock).

## Chain / protocol

6. **P2PKH only.** You can only send to standard `E…` addresses. P2SH (`e…`) and
   other-network addresses are **rejected on purpose**, and this rejection is a
   safety feature, not a missing one. Re-verified against the code on 2026-07-14:

   - `txBuilder.ts` builds every output as
     `p2pkhScript(addressToHash160(address).hash)` — it takes the 20-byte hash out of
     whatever address you give it and **always** wraps it in a P2PKH script
     (`76 a9 14 <hash> 88 ac` = `OP_DUP OP_HASH160 … OP_EQUALVERIFY OP_CHECKSIG`).
   - An Evrmore P2SH address (version byte **92**, `e…`) carries a *script* hash, not a
     *public-key* hash. Encoding it into a P2PKH output produces a script that demands
     a signature from a private key whose public key hashes to a **script** hash. No
     such key exists. **The coins would be permanently unspendable.**
   - Demonstrated with two real addresses built from the same 20-byte hash:
     `EYochGYSdC8eFjeZ2Q1C1aL6rLbNZrWGta` (v33) and
     `eHkCng8SWqULWJsfU9ezcyPWz6o2aG34zW` (v92) both produce the byte-identical script
     `76a914abab…ab88ac`. The P2SH-ness is silently lost.
   - **`isValidAddress()` accepts a P2SH address** — it only checks the checksum and
     the network. The real guard is `isP2pkhAddress()` (version must equal
     `net.pubKeyHash` = 33), enforced inside **both** `buildEvrSend` and
     `buildAssetSend` before anything is signed, plus in the Send form and the dApp
     approval window for an early, readable error.

   So: not a bug, and not a risk to you. It only means the wallet refuses to send to
   multisig / script addresses at all, rather than burning the funds. Emitting genuine
   P2SH outputs is simply not implemented.
7. **EVRmore only.** The wallet is architected to carry more than one chain, but today
   it speaks EVRmore and nothing else. Adding a network is not a config switch yet.
8. **Mainnet only in practice.** `chainParams.ts` defines testnet, but wallet
   creation/import hardcodes mainnet and no UI exposes a testnet toggle.
9. **Amounts above ~90,071,992 EVR** lose precision in the decimal→sats conversion
   (`BigInt(Math.round(amount * 1e8))`, float 2⁵³ limit). Not reachable with realistic
   balances.

## Satori Network features

10. **Pool staking is an off-chain registration, not a transaction.** Joining or
    leaving a Satori pool signs a challenge and registers your address as a lender on
    `network.satorinet.io`. **No funds move and your SATORIEVR never leaves your
    wallet**, so nothing is at risk on-chain — but it also means the wallet cannot
    verify the pool's behaviour or your rewards. It shows what that server reports. If
    the service is down or changes its API, staking stops working.
11. **The Satori Network tab reports, it does not verify.** The six figures come from
    `satorinet.io` (predictions, connected neurons, wallet holders, price, and the 24 h
    average from a plain-text distribution report; the stake cost is derived as
    250 × price, the way satorinet.io itself computes it). They are cached for a
    minute, and a failing endpoint leaves its own tile showing `n/a` rather than
    blanking the screen. Nothing here is cross-checked against the chain.

## Wallet behaviour

12. **Deposit notifications only watch each wallet's primary (index-0) address**, and
    the poll is **skipped while any wallet window is open** (it would otherwise fight
    the foreground for the Electrum connection). Funds arriving at a secondary derived
    address won't raise a notification, though the balance still shows in the UI.
13. **Notification latency** is up to ~1 minute (`chrome.alarms` minimum period), and
    only while Chrome is running.
14. **Fee estimation** relies on the server's `estimatefee`, clamped to a sane ceiling.
    It is not a mempool-aware fee market.
15. **EVR and SATORIEVR cannot be removed** from the asset list. Deliberate: EVR pays
    every fee and SATORIEVR is the asset this wallet exists for.
16. **The toolbar popup cannot be dragged.** Chrome pins it under the extension icon
    and offers no API to move it, which is why there is an "open in a separate window"
    button: that window is a real OS window you can drag anywhere. **A
    password-protected wallet must be unlocked again in it** — each browsing context
    decrypts its own copy of the key in memory, and keys are deliberately never shared
    through the background worker.
17. **Popup height** — Chrome caps extension popups at 600 px; the layout targets
    400 × 620 and clamps to the available height.

## Platform

18. **Firefox MV3 works but has no automated smoke.** `npm run build:firefox`
    produces `dist/firefox` with a real Gecko manifest: id `satori-go@satorinet.io`,
    `strict_min_version` **128.0**, an event-page background (`background.scripts` +
    `"type": "module"`, since Firefox has no MV3 service worker) rather than a service
    worker. 128.0 was chosen from verified compat data, not guessed: `storage.session`
    (used by the dApp broker) lands in Firefox 115, module background scripts in 112,
    and from Firefox 127 host permissions are actually granted at install (so the price
    and pool fetches work without a permission-request flow we do not ship a UI for);
    128 is the ESR baseline that clears all three. The manifest also declares
    `data_collection_permissions: { required: ["none"] }` (the wallet collects no
    data) because AMO submission validation requires the key; Firefox older than
    140 simply ignores it. What is **verified**: `addons-linter` passes with
    **0 errors** (4 warnings, all benign: two say the data-collection key is
    unknown below Firefox 140/142, which is exactly the ignored-when-older case
    above; two `innerHTML` notices come from React's bundled DOM runtime, not our
    code, and cannot execute under the pages' `script-src 'self'` CSP). The build also **installs as a temporary add-on** on real Firefox
    152.0.6 (headless, via `web-ext run`) with no manifest rejection. On 2026-07-15
    the owner ran a **full manual click-through on real Firefox** and everything
    passed: wallet create/import/unlock, live balances and prices, a real send,
    dApp connect and signMessage, staking read, deposit notification, detached
    window, and persistence across a browser restart. What is still missing: an
    **automated** Firefox smoke; the Chrome live/dApp smokes remain the only
    automated end-to-end gate, so Firefox regressions rely on manual re-testing.
19. **Firefox host permissions can be revoked per site.** On Firefox 127+ the four
    `host_permissions` (api.coinex.com, satorinet.io, network.satorinet.io, safe.trade)
    are granted at install, but the user can revoke any of them from the extensions
    button. A revoked host makes only that host's `fetch` fail: the EVR/SATORIEVR USD
    prices and the Satori Network tab render `n/a`, and a pool join/leave surfaces an
    error, none of which crash or retry-loop (the price poll is a bounded 60 s cadence
    that swallows failures). Balance reads and the deposit poller use Electrum over
    `wss:`, which is gated by CSP `connect-src`, not `host_permissions`, so they keep
    working regardless. We do not build a permissions.request() flow for this.
20. **The Firefox deposit-poll gate uses a different mechanism than Chrome.** The
    worker skips the deposit poll while a wallet window is open to avoid fighting the
    foreground for the Electrum connection. Chrome does this with
    `chrome.runtime.getContexts`, which Firefox lacks; the Firefox path feature-detects
    and falls back to `chrome.extension.getViews` on the event page. It is a
    connection-contention optimization, not a security control; the owner's 2026-07-15
    manual run-through saw a deposit notification arrive on Firefox. Worst case if it
    misbehaves: a notification is delayed, or a second Electrum connection briefly
    contends. No funds are affected.
21. **Price sources are third-party** (CoinEx for EVR; satorinet.io with a SafeTrade
    fallback for SATORIEVR) and reached via `host_permissions`. If they are down or
    block the request, the USD figures simply don't render — balances are unaffected.

## Not implemented (ideas, not promises)

Additional chains (the architecture is aimed at them; only EVRmore is wired up today),
real P2SH output support, QR-code scanning, 24 h price change %, an in-wallet asset
explorer, hardware-wallet support, a self-hosted Electrum node.
