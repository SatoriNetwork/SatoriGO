# Known limitations

Current, honest limitations of the wallet (v1.3.0).

Satori GO is a non-custodial multi-chain wallet. Seven chains ship in this
version, and each has had a funded send confirmed by the owner on mainnet
(item 7). Nothing below is marketing.

## Security / trust

1. **No formal external audit.** The code has had repeated internal adversarial
   review, including a multi-agent security pass over the 1.3.0 changes, but not
   a professional third-party audit. It moves real mainnet funds. **Do a small
   test send before a large one.**
2. **Message signing is not origin-bound.** A malicious site can ask you to sign
   a message worded for a *different* site and reuse the signature there. The
   approval window shows the exact message, so read it. This is inherent to the
   signmessage format, which must stay byte-compatible with Satori.
3. **The Satori pool challenge is validated by shape, not by origin.** Staking
   signs a nonce the pool server supplies. The wallet refuses anything that is
   not a bare UUID, which excludes every human-readable or structured message,
   but another service whose challenges are also bare UUIDs under the same
   signing scheme could not be told apart. Only server-side domain binding can
   close that, and it is outside the wallet.
4. **Passwordless wallets** are a deliberate convenience trade-off: they
   auto-unlock, and sends and signatures require only click-throughs. Opt-in,
   behind an explicit acknowledgement. Their vault is AES-GCM under an **empty**
   passphrase, so anyone with access to the browser profile on disk can decrypt
   it without a password.
5. **Clipboard clearing is best-effort.** Copying a secret schedules a clear
   within 30 seconds, but the timer runs in the popup: close the popup first and
   the clipboard is never cleared. OS clipboard history or cloud sync may capture
   the value before the clear fires.
6. **Public metadata is stored unencrypted** in extension storage: wallet
   addresses, the address book, cached transaction history, approved dApp
   origins and the deposit snapshot. No secrets, but someone with disk access
   learns your addresses, balances and contacts without a password. Partly
   unavoidable, since the background worker needs addresses without an unlock.

## Chains

7. **All seven chains have an owner-verified funded send (2026-08-16).** Each
   was also verified for parameters, address derivation, address validation,
   balance reading, fee estimation and transaction building against live servers
   and independent sources, and the segwit signing path is proven against a real
   on-chain transaction. The funded sends were run by the project owner
   personally, not by an automated suite, so they are recorded here as
   owner-verified. There is still no automated end-to-end send test on any
   chain, because that would mean broadcasting real transactions from CI. Test
   small first on any chain you have not used yourself.
8. **Sending is P2PKH and native segwit only.** P2SH addresses are refused on
   every chain, on purpose: the builder cannot construct a P2SH output, so
   accepting one would strand the coins. Taproot recipients are accepted only on
   chains where taproot is actually active. The wallet derives no taproot keys of
   its own, so it cannot hold a taproot output.
9. **Two chains have no segwit at all** (Dogecoin and WojakCoin, by their own
   consensus rules), so a bech32 recipient is refused there. That refusal is a
   safety feature: such an output would be anyone-can-spend.
10. **Some chains share address prefixes, and one check cannot see through it.**
    Bitcoin, Evrmore and Ravencoin all use WIF version byte 128, and Bitcoin Gold
    S and Litecoin both use 176. When you import a private key the wallet checks
    that byte, but it cannot distinguish chains that share it. The check catches
    a key from another family, never one from inside the same family.
11. **Mainnet only in practice.** Testnet parameters exist in the source, but
    wallet creation and import are mainnet and no UI exposes a testnet toggle.
12. **Amounts above about 90,071,992 coins** lose precision in the decimal to
    base-unit conversion (a float 2^53 limit). Not reachable with realistic
    balances.
13. **BitcoinGold and WojakCoin are young, thin networks** and the wallet
    marks them as such. BitcoinGold stopped producing blocks for hours at a
    time during development, which leaves a payment unconfirmed through no fault
    of the wallet. The header now reports the age of the chain tip when it goes
    stale, so a stalled chain no longer looks healthy.
14. **No inscription or token-meta-protocol support** (BGC-20 on BitcoinGold,
    or anything ordinals-based). Those balances live in an off-chain indexer, not
    in the UTXO set, so the wallet cannot see them. **Consequence you should
    know: coin selection treats every UTXO as ordinary money**, so an inscription
    held on a wallet address could be spent as an input. Do not hold inscriptions
    on a Satori GO address.

## Derivation and history

15. **One account, one derivation path, no gap limit.** Each wallet derives from
    a single account and purpose (BIP44 on legacy chains, BIP84 on segwit ones)
    and only the addresses it has created. Funds sent to a different derivation
    path of the same seed are **not discovered and not shown**. This is the most
    likely reason an imported wallet shows a smaller balance than you expect.
16. **BIP39 passphrases are supported on import only, not on wallet creation.**
    A passphrase-protected seed imports correctly, and the passphrase is stored
    encrypted alongside the mnemonic under your wallet password, which means it
    does not give you the deniability a passphrase kept out of the wallet would.
17. **Transaction history is capped at the newest 2000 entries per address.**
    Extension storage is a shared 10 MB budget, and an address with tens of
    thousands of transactions would exhaust it and freeze the cache. Balances are
    unaffected: they come from the server, not the cache. The Diagnostics screen
    in expert Settings shows current storage use.
18. **Some servers refuse very large addresses** with "history too large". The
    wallet now says so instead of showing an empty list, but it cannot work
    around it: that address's history is unavailable from that server.
19. **Fee estimation is server-reported, then clamped per chain.** It is not a
    mempool-aware fee market. Several chains return the same figure for every
    target, so no fast/normal/slow choice is offered there, and at least three
    chains report estimates *below* their own relay floor, which is why the floor
    comes from the chain parameters instead.

## Satori Network features

20. **Pool staking is an off-chain registration, not a transaction.** Joining or
    leaving signs a challenge and registers your address as a lender on
    network.satorinet.io. **No funds move and your SATORIEVR never leaves your
    wallet.** Nothing is at risk on-chain, but the wallet cannot verify the
    pool's behaviour or your rewards; it shows what that server reports. If the
    service changes or goes down, staking stops working.
21. **The Satori Network tab reports, it does not verify.** Its figures come from
    satorinet.io, are cached briefly, and a failing endpoint leaves its own tile
    showing "n/a" rather than blanking the screen. Nothing there is cross-checked
    against the chain.
22. **Staking and assets are Evrmore-only.** Five of the seven chains have no
    asset layer at all, and the wallet says so rather than showing an empty asset
    list.

## Wallet behaviour

23. **Deposit notifications watch only each wallet's primary address**, and the
    poll is skipped while a wallet window is open, to avoid competing with the
    foreground for the server connection. Funds arriving at a secondary address
    raise no notification, though the balance still shows.
24. **Notification latency** is up to about a minute, and only while the browser
    is running.
25. **USD prices are third-party and incomplete.** They come from CoinEx and
    satorinet.io. Three chains have no price source at all, and **EVR currently
    shows no USD value because its CoinEx market was delisted**. Balances are
    unaffected; only the fiat figure is missing.
26. **WojakCoin's explorer link is verified by a human, not by this project's
    tooling.** Its host answers 403 to automated requests, including a real
    headless browser, so the URL format was confirmed by the owner opening a
    transaction page. Every other chain's explorer was verified here against a
    live transaction.
27. **The native coin and SATORIEVR cannot be removed** from the Evrmore asset
    list. The native coin pays every fee, and SATORIEVR is the asset this wallet
    exists for.
28. **The toolbar popup cannot be dragged.** The browser pins it under the
    extension icon, which is why there is an "open in a separate window" button.
    **A password-protected wallet must be unlocked again in that window**: each
    browsing context decrypts its own copy of the key in memory, and keys are
    deliberately never shared through the background worker.
29. **Popup height** is capped at 600 px by the browser; the layout targets
    400 x 620 and clamps to the available height.

## Platform

30. **Firefox MV3 works but has no automated smoke.** The Firefox build has a
    real Gecko manifest with an event-page background rather than a service
    worker, `strict_min_version` 128.0 chosen from verified compatibility data,
    and it declares that the wallet collects no data. `addons-linter` passes with
    zero errors, and the build installs as a temporary add-on on real Firefox.
    The owner has manually clicked through a full release on Firefox. What is
    missing is an **automated** Firefox end-to-end gate: the Chrome live and dApp
    smokes remain the only automated ones, so Firefox regressions rely on manual
    re-testing.
31. **Firefox host permissions can be revoked per site.** A revoked host makes
    only that host's requests fail: prices and the Satori tab render "n/a" and a
    pool join surfaces an error, none of which crash or retry-loop. Balance reads
    use the Electrum protocol over `wss:`, gated by CSP rather than host
    permissions, so they keep working regardless. There is no permission-request
    UI.
32. **The Firefox deposit-poll gate uses a different mechanism than Chrome**,
    because Firefox lacks the API Chrome uses to detect an open wallet window.
    It is a connection-contention optimization, not a security control. Worst
    case: a notification is delayed. No funds are affected.
33. **Sync status is shown only on the wallet tab.** The Activity and Settings
    tabs have no connection indicator.

## Not implemented (ideas, not promises)

Real P2SH output support, taproot key ownership, inscription and BGC-20
awareness, gap-limit address discovery, BIP39 passphrases at wallet creation,
QR-code scanning, 24 h price change, an in-wallet asset explorer,
hardware-wallet support, and an automated Firefox end-to-end suite.
