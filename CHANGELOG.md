# What's new in Satori GO

Satori GO is a non-custodial multi-chain wallet made by Satori Network. Your keys
are generated and stored on your own device, encrypted with your password, and
they never leave it.

This file starts at 1.3.0. Earlier releases are recorded in the repository's tags
and release commits.

---

## 1.3.0

The release that turns Satori GO from a two-network wallet into a genuinely
multi-chain one.

### Seven networks, one wallet

Satori GO now carries Bitcoin, Litecoin, Dogecoin, Evrmore, Ravencoin,
Bitcoin Gold S and WojakCoin.

Switch between them from the header. Each network gets its own receiving
address, its own servers, its own block explorer and its own fee rules, and the
wallet keeps them apart: the address book, the recipient picker and the send
path all follow the network you are actually on. Adding a network to an existing
wallet takes one click and your password, and derives the new address from the
secret you already have.

Networks are described by their parameters rather than by name, so the next one
is a data entry rather than a rebuild.

### See the fee before you send

The send screen now shows what a transaction will cost, in the coin you are
sending, before you commit to anything.

Where a network genuinely offers a choice, you get fast, normal and slow with
the real price of each. Where it does not, you get one honest figure instead of
three invented ones. You can also set your own rate, checked against that
network's actual floor and ceiling so you cannot accidentally build a
transaction the network will refuse to carry.

### Settings that fit who is using them

Settings opens in a basic mode with the things most people need. Expert mode
adds servers, addresses, connected sites, transaction export and a diagnostics
page showing how much storage the wallet is using and what it is connected to.

### A wallet that tells you when something is wrong

A small network can slow down or stop producing blocks. When that happens the
wallet says so, with the age of the last block, instead of showing a confident
green "synced" while your payment waits for a chain that has stalled. Newer,
thinner networks are marked as such in the network list, with a plain
explanation of what that risk means for your coins.

### Fixed

- **Sending on native segwit networks.** Input verification compared the wrong
  form of a transaction, which stopped every send on those networks. This was
  the most serious fix in the release.
- **The amount shown for a transaction** on a wallet with more than one address.
  It reported one address's movement as if it were the whole wallet's, so a
  small payment out of a large coin could appear enormous. Balances were never
  affected.
- **A transaction reported as failed after it had actually been sent**, which
  invited paying twice.
- **The maximum sendable amount** on segwit networks, which reserved more fee
  than the transaction needed and paid the difference to miners.
- **Recovery phrases of 15, 18 and 21 words** now import. They are valid and
  were being refused.
- **A recovery phrase protected by a BIP39 passphrase** now restores the wallet
  it belongs to. Before, it quietly restored a different, empty one.
- A just-sent transaction appears immediately instead of waiting for a long
  history sync, and the unread badge stops reappearing on wallets with a lot of
  history.
- Wallet history no longer grows without limit, and the wallet says so when a
  server refuses to return the history of a very large address.
- Many smaller corrections across the interface, from a truncated status label
  to a lock screen that could hide its own "create wallet" button.

### Worth knowing

`KNOWN_LIMITATIONS.md` is kept deliberately honest and is worth a minute of your
time. Every one of the seven networks has had a funded send confirmed on mainnet
by the owner personally, but there is still no automated end-to-end send test,
and some of these networks are small. Test with a small amount first.
