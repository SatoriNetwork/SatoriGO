# Known limitations

Current, honest limitations of the wallet (v1.4.2).

Satori GO is a non-custodial multi-chain wallet. Eight coin networks and four
EVM networks ship in this version, and every one of them has had a funded send
confirmed by the owner on mainnet (item 7). Nothing below is marketing.

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
   within 30 seconds, and leaving the screen that revealed it now clears it
   immediately rather than waiting the timer out. What remains: the timer runs
   in the popup, so closing the popup before it fires leaves the secret in the
   clipboard. That case cannot be fixed here. The Clipboard API only works while
   the document is FOCUSED, which a closing popup no longer is, so a
   clear-on-close handler would always fail; the real fix is an offscreen
   document, which is Chrome-only and needs another permission. OS clipboard
   history or cloud sync may also capture the value before any clear fires.
6. **Public metadata is stored unencrypted** in extension storage: wallet
   addresses, the address book, cached transaction history, approved dApp
   origins and the deposit snapshot. No secrets, but someone with disk access
   learns your addresses, balances and contacts without a password. Partly
   unavoidable, since the background worker needs addresses without an unlock.

## Chains

7. **Every network has an owner-verified funded send.** The seven coin
   networks that shipped in 1.3.x were confirmed 2026-08-16; Neoxa, Ethereum
   and Epix were confirmed 2026-08-27, which is what let this release call them
   supported rather than present. Each
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
    Bitcoin, Evrmore and Ravencoin all use WIF version byte 128, and BitcoinGold
    and Litecoin both use 176. When you import a private key the wallet checks
    that byte, but it cannot distinguish chains that share it. The check catches
    a key from another family, never one from inside the same family. The import
    screen now SAYS SO when the byte is shared: it names the chain the key will
    be imported as and the other chains that use the same prefix, so a matching
    byte is not mistaken for proof. It does not block the import, because a
    shared byte is not an error.
11. **Mainnet only in practice.** Testnet parameters exist in the source, but
    wallet creation and import are mainnet and no UI exposes a testnet toggle.
12. **Amounts in the ACTIVITY list are the one place a float remains.** Balances
    and the send path are exact: a balance travels from the chain to the screen
    as an integer count of base units, and an amount you type is converted from
    the text directly, both at the chain's own declared scale. Neither rounds at
    any size (the send path used to, silently, past about 90,071,992 coins,
    which is reachable on Dogecoin).

    What is still a number, and why it is not simply "not done yet": an asset
    amount inside a TRANSACTION arrives from the server as a JSON decimal, so it
    has already passed through a double before this wallet sees it. Carrying it
    as an integer from that point on would look rigorous while recovering
    nothing that was lost in transit. Fixing it properly needs the raw response
    text, which the Electrum client does not expose. It affects what an activity
    row DISPLAYS, never what is spent: coin selection reads UTXO values, which
    are integers and are separately verified against the chain.

    One more number by choice: a transaction proposed by a WEBSITE arrives as a
    JSON number, so that path keeps a guard and refuses what it cannot convert
    exactly rather than guessing.
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

15. **One account, one purpose.** Each wallet derives from a single account and
    purpose (BIP44 on legacy chains, BIP84 on segwit ones). Within that, the
    wallet now performs a standard gap-limit scan: importing a seed looks ahead
    for receive addresses that already have history, stopping after 20
    consecutive empty ones, and Settings has a "Scan for used addresses" button
    to run it again. Coins on those addresses are found, shown and spendable.
    What is still NOT discovered: a different account (`.../1'/...`) or a
    different purpose than the one this wallet uses for that chain, so a seed
    used elsewhere under BIP44 on a chain where this wallet uses BIP84 will
    still look empty. The scan reports when its answer is only a lower bound
    (addresses it could not read, or a run that hit its ceiling) instead of
    claiming there is nothing more.
16. **A BIP39 passphrase is stored with the wallet, so it buys less than one
    kept outside.** You can now set a passphrase when you CREATE a wallet as
    well as when you import one. It is off by default, behind an explicit
    opt-in, must be typed twice, and the recovery-phrase screen stops calling
    the phrase your only backup once you set one. What it does NOT give you is
    deniability: the passphrase is stored encrypted alongside the mnemonic under
    your wallet password, so anyone who can open the vault sees both. A
    passphrase you keep in your head and out of the wallet is a different, and
    stronger, thing. There is also no in-app way to read a passphrase back: the
    reveal screen returns the recovery words only, by design, so a forgotten
    passphrase cannot be recovered from the wallet even with your password.
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
22. **Assets are Evrmore-only, and there are two unrelated kinds of staking.**
    Five of the eight UTXO chains have no asset layer at all, and the wallet says
    so rather than showing an empty asset list. (Neoxa has one, but the wallet
    cannot read it until its server is live, item 35.) *Pool* staking (items 20 and 21)
    is Evrmore-only. *Native* staking is a different feature on a different
    family: it exists only on an EVM chain whose registry row declares it, which
    today is Epix alone, and the wallet offers no Stake action anywhere else.
    Both are gated on a capability, never on a chain name, so a chain that gains
    either gets it by adding a row.
    - **Native staking figures come from the chain's LCD and can lag a block or
      two.** Staked amounts, unbonding entries and above all pending rewards are
      read from the chain's Cosmos REST endpoint, which indexes slightly behind
      the head: right after a stake, unstake or claim the numbers on screen can
      still be the previous block's. They catch up on the next refresh. Amounts
      that go INTO a transaction are not taken from there: the unstake and move
      amounts are read from the staking module itself at the moment the action is
      built, so a figure that is one block stale can never become the amount that
      is signed.
    - **Rewards are shown, not compounded.** Claiming withdraws the pending
      rewards to the account; the wallet does not restake them for you, and it
      has no automatic or scheduled claiming.
    - **An Activity row says which validator only once the wallet has read the
      transaction itself.** The chain's history source reports a staking
      transaction without its instructions, so the wallet reads the transaction
      from the chain to find out what it did, and remembers the answer. A
      staking action you make in the wallet is labelled at once. One that the
      wallet cannot read right now (the chain unreachable at that moment) is
      still listed, without the label, and is labelled on a later refresh. The
      validator's name comes from the chain's validator list; before that list
      has loaded, the row shows the validator's address instead.
    - **Unbonding cannot be cancelled from the wallet.** The chain supports
      cancelling an unbonding entry, and Satori GO does not expose it yet. Once
      an unstake is confirmed, the coins are locked for the chain's unbonding
      period (21 days on Epix today) and the wallet offers no way to reverse it.
    - **A validator's behaviour is not verified.** The commission, voting power
      and jailed flag are what the chain reports. A validator can raise its
      commission, be jailed, or be slashed after you stake with it, and the value
      of a delegation moves with that. The wallet reports; it does not advise.

## Wallet behaviour

23. **Deposit notifications watch only each wallet's primary address**, and the
    poll is skipped while a wallet window is open, to avoid competing with the
    foreground for the server connection. Funds arriving at a secondary address
    raise no notification, though the balance still shows.
24. **Notification latency** is up to about a minute, and only while the browser
    is running.
25. **USD prices are third-party and incomplete.** They come from the Satori GO
    gateway, which reads CoinGecko and SafeTrade on its side; the wallet itself
    contacts no exchange. A ticker the gateway has no source configured for
    still has no price, and a ticker missing from one answer keeps the value
    already on screen rather than blanking. Balances are unaffected either way;
    only the fiat figure is missing. The gateway is a single point of failure
    for prices: while it is unreachable, no price refreshes.
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
33. **The dApp approval window shows no standing connection state.** Every
    screen of the wallet itself now shows one: the wallet, Activity and Settings
    tabs with a label, and the narrower screens (Send, Receive, transaction and
    asset detail, staking, the address book, every Settings sub-screen) with a
    dot, because at 400 px wide their header slot is about 40 px and a labelled
    pill clipped "Synced" down to "Sy". Hovering it, or a screen reader, gives
    the full state, and all of them derive from one function so they cannot
    disagree. The approval window is the exception and stays one on purpose: it
    is a separate surface that never loads the wallet store and opens its own
    connection, so this indicator would report the state of an empty store,
    which is worse than none in the window where you authorise a transaction.
    It reports connection trouble in its own words instead, but only when you
    act, so an offline wallet is not visible there until you try.

## Connectivity

34. **Ravencoin reaches the chain only through the Satori GO gateway, and has no
    fallback.** In a release build every chain's server connections go through
    the gateway, one host, with our own node behind it rather than contacted
    directly, and each chain keeps its usual public servers listed behind the
    gateway as the fallback, so an outage there costs it the gateway and nothing
    more. Ravencoin has none, and that is deliberate: every generally available
    Ravencoin server runs plain upstream ElectrumX, which rejects the asset
    calls this wallet depends on, so a mid-failover reconnect onto one would
    silently report wrong asset balances and history instead of failing. While
    the gateway is unreachable, Ravencoin is offline: balances do not refresh
    and sends cannot be built. The gateway row in Settings > Network cannot be
    removed; adding your own Ravencoin server there is the only fallback
    available today.
35. **Neoxa reaches the chain through ONE server, which is not ours, over a
    hop that is not encrypted.** Neoxa carries the Ravencoin asset protocol, so
    it needs an asset-aware server: a plain one answers the first call and then
    fails every asset call, which is worse than none. There is no public
    asset-aware server to borrow (the project publishes a Blockbook indexer and
    an asset API instead, and the host named `electrum.neoxa.net` answers on no
    Electrum port), so like Ravencoin it is wired to the Satori GO gateway alone,
    with no fallback (item 34).

    The server behind that gateway route was supplied to the owner rather than
    run by him. It was probed before it was trusted: it reports Neoxa's own
    genesis hash, so it is not the wildcard host that answers Neoxa hostnames
    with Bitcoin, and it answers the asset dialect including the asset-scoped
    balance reads. It also offers no TLS port, which was established three ways
    (a port sweep, an attempted Electrum handshake on the only other open port,
    and the server's own advertised service list), so the gateway's hop to it is
    plaintext across the internet.

    What that does and does not mean: nobody on that path can forge a signature,
    and none of them can make this wallet accept a bad broadcast, because the
    wallet compares the answer to the transaction id it computed itself. They
    can lie about a balance or a history, and with no fallback there is nothing
    to cross-check against. The owner accepted this knowingly (2026-08-27) while
    an SSL port is requested from the operator.
36. **Neoxa and BitcoinGold share an address prefix, and no check can see
    through it.** Both use base58 version byte 38, so a Neoxa address and a
    legacy BitcoinGold address are indistinguishable strings: pasted into the
    wrong network's send screen, either is accepted as well-formed. This is
    unlike the shared prefixes in item 10, which affect only key import. Three
    things limit it: BitcoinGold hands out native segwit addresses, so its
    legacy form almost never appears; the two chains derive different keys from
    one recovery phrase, so no wallet holds both silently; and coins sent this
    way are not destroyed, since the recipient's key controls that address on
    either chain, though recovering them means importing the key by hand. Check
    the network before you paste.

37. **WojakCoin reaches the chain WITHOUT the gateway, so it does not get the
    privacy the other networks do.** Its operator rate-limits our gateway's
    address: from that one address a plain `server.version` is answered with
    ElectrumX's `excessive resource usage` before the session does any work.
    That is the per-source limit working as intended rather than a fault, and
    our design is what trips it, because every wallet reaches a network from
    the gateway's single address and a small public server sees one IP behaving
    like a crowd. It is not stable either: measured on 2026-08-28, one of the
    two hosts refused while the other answered, and twenty minutes later both
    refused.

    What this costs you: WojakCoin works, because the wallet falls back to
    connecting to its public servers directly from your own browser, which is
    the same path it used before the gateway existed. What is lost is the
    privacy benefit, since those servers see your address and your IP. Every
    other coin network prefers the gateway and only falls back on an outage.

    Two fixes are in motion. The operator has been asked to raise the limit for
    the gateway's address, which would restore the bridge as it stands. And the
    project owner is standing up his own WojakCoin node, which removes the
    problem rather than negotiating with it: our own server behind the gateway,
    the way Evrmore and Ravencoin already work, with no third party's per-source
    limit in the path. It goes in once it has finished syncing. Until one of
    those lands, this is where WojakCoin stands, and it is written down rather
    than left for someone to infer from a listing that promises otherwise.

## Not implemented (ideas, not promises)

38. **Bitcoin BLAKE2b is new and thin, and its replay protection is one-way.**
    The chain is Bitcoin's history under the Knots BLAKE2b proof of work, with
    little mining power behind it, one public Electrum server (Fulcrum, reached
    only through the gateway bridge: it has no browser-usable listener), one
    thin price source (the NonKYC BTCB2/USDT market), and a ticker that only
    that exchange uses so far. Every send
    the wallet makes there is signed with SIGHASH_UNIFIED, so it is invalid on
    Bitcoin; but a Bitcoin spend of a pre-fork coin, from any wallet, also moves
    the BLAKE2b twin of that coin until the BLAKE2b side has been sent to
    yourself once.

Real P2SH output support, taproot key ownership, inscription and BGC-20
awareness, gap-limit address discovery, BIP39 passphrases at wallet creation,
QR-code scanning, 24 h price change, an in-wallet asset explorer,
hardware-wallet support, and an automated Firefox end-to-end suite.
