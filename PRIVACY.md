# Privacy Policy: Satori GO

**Last updated: 25 August 2026**

Satori GO is a non-custodial multi-chain wallet distributed as a browser extension.
This policy describes exactly what data the extension handles, what leaves your
device, and who can see it.

Every statement below was checked against the source code, which is public at
<https://github.com/SatoriNetwork/SatoriGO>. You can verify all of it yourself.

## The short version

- **We do not collect anything.** Satori GO has no accounts, no sign-up, no
  analytics, no telemetry, no tracking, no advertising, and no cookies. We keep no
  database of users and nothing you do here is tied to an identity.
- **Your keys never leave your device.** Your recovery phrase and private keys are
  stored only on your own computer, only as AES-256-GCM ciphertext, and are never
  transmitted anywhere: not to us, not to a website, not even to the extension's
  own background process.
- **We do run one server.** It is a relay, described in full below. It never sees
  your keys or your password, but it does see which addresses the wallet is asking
  about, because that is what a relay does.
- **We do not sell, rent, or transfer your data to anyone**, because we never
  receive anything to sell.

## What is stored on your device

All data is kept in your browser's local extension storage (`chrome.storage.local`)
and never synced to a cloud by us:

| Data | How it is stored |
|---|---|
| Recovery phrase / private key | **Encrypted only**: AES-256-GCM, key derived with scrypt (N=2¹⁷) from your password. The plaintext exists in memory only while the wallet is unlocked, and is wiped on lock. |
| Your password | **Never stored**, in any form. It is used to derive the decryption key and then discarded. |
| Wallet names, addresses, address book, settings, cached balances and transaction history | In plain form (this is not secret data), locally only. |
| Sites you have approved for dApp connect | Locally, as an `{origin, wallet}` pair. |

If you uninstall the extension, the browser deletes this storage. **If you have not
backed up your recovery phrase, your funds are unrecoverable.** We cannot recover
them for you: we have never had access to them.

## What leaves your device, and to whom

A wallet cannot show your balance without asking the network about your addresses,
and it cannot send a transaction without handing it to somebody who will broadcast
it. Everything in this section follows from that.

### 1. The Satori GO gateway (`network.satorigo.app`)

Almost all of the wallet's traffic now goes through one host that we run. It is a
**relay**: it forwards the wallet's questions to blockchain servers and public data
sources, and passes the answers back. It exists so the extension needs permission
for one address instead of a dozen, and so that no service key has to be shipped
inside a public extension where anyone could read it.

The gateway never receives your recovery phrase, your private keys or your
password. It does receive whatever a given question is about, and, like any server
on the internet, your IP address and the time you asked.

| What | When it happens | What the request tells the gateway |
|---|---|---|
| Prices | About once a minute while a wallet window is open and visible | Nothing about you. It is the same lookup for every user. |
| Notices from us (the message banner) | About once a minute while a wallet window is open | Nothing about you. |
| Pictures inside a notice | When a notice with a picture is shown | Which notice was displayed. See the correction below. |
| Blockchain bridge for Evrmore, Ravencoin, Bitcoin, Litecoin, Dogecoin, Bitcoin Gold S and Wojak | Whenever balances or history are read, and when you broadcast a transaction. Also once a minute in the background if you leave "notify me about incoming funds" on | Identifiers derived from your wallet addresses, the asset names you hold, transaction ids, and the signed transactions you confirmed. |
| EVM networks (Base, BNB Chain, Ethereum, Epix), if you have an account on one | Balance and history refreshes, and while you fill in a send form | Your address; the recipient address you type, because the wallet checks whether it is a contract before you send; and the signed transaction. |
| Staking information on Epix | Only on the staking screen | Your Epix account address. |
| The token list behind "search for a token" | Once a day per network, when you use the search | Which network's list it wants. **What you type never leaves your device**: the search runs locally over the downloaded list. |
| Token pictures | Once per token the wallet shows | The token's contract address. Not yours. |

**A correction to what this policy used to say.** An earlier version claimed of the
gateway that "the request carries no parameters at all: it is one plain public
lookup, the same for every user". That was written when prices were the only thing
the gateway served, and it is no longer true of the gateway as a whole. Two things
to be clear about:

- The picture inside a notice is fetched at an address containing a long random
  identifier for that notice. It carries no identifier for you, but it does mean the
  gateway can see that *some install at your IP address displayed that particular
  notice, at that moment*. Notices are targeted by network and by version, so that
  is a small amount of information about your wallet, and we would rather write it
  down than let you discover it.
- Every request the wallet code makes to the gateway carries a short build
  identifier so the gateway can tell its own extension apart from random traffic. It
  is the same value in every copy of a given release. It is not a user id and it
  does not distinguish you from anybody else running the same version.

### 2. Blockchain servers we do not run

If the gateway cannot be reached, the wallet falls back to public blockchain servers
for most networks, so your wallet keeps working when our relay does not:
`electrum1-mainnet.evrmorecoin.org` and `electrum2-mainnet.evrmorecoin.org` for
Evrmore, `btc.electrum1.cipig.net` and `btc.electrum2.cipig.net` for Bitcoin,
`ltc.electrum1.cipig.net` and `ltc.electrum2.cipig.net` for Litecoin,
`doge.electrum1.cipig.net` and `doge.electrum2.cipig.net` for Dogecoin,
`electrum.bitcoingold.site` and `electrum.btgscoin.site` for Bitcoin Gold S,
`electrum1.wojakcoin.cash` and `electrum2.wojakcoin.cash` for Wojak.

They see the same thing the bridge sees: identifiers derived from your addresses,
the transactions you broadcast, and your IP address. This is inherent to how every
light wallet works, on every chain. **We do not control these servers and their own
policies apply.**

**Ravencoin has no public fallback** in this build, because there is no Ravencoin
server we are willing to point you at by default. Ravencoin reads go through the
gateway or not at all.

You can add your own servers, including your own machine, in **Settings > Network**.
The gateway bridge itself cannot be removed from that list, but anything you add is
used the same way.

### 3. Satori Network (`satorinet.io`, `network.satorinet.io`)

- **The SATORIEVR price.** When the gateway's price table does not include
  SATORIEVR, the wallet asks `satorinet.io` for it directly. The request says
  nothing about you.
- **The Network tab.** Opening it fetches the public Satori network statistics
  (predictions, holders, distribution). Nothing about you is sent, and nothing is
  fetched unless you open that tab.
- **The Satori pool API (`network.satorinet.io`), if you hold SATORIEVR.** The
  wallet asks which pool your addresses are lending to. This sends **your Evrmore
  address**. An earlier version of this policy said this only happened if you opened
  the staking screen; that is no longer true, and the check now runs as soon as the
  wallet sees a SATORIEVR balance. Joining or leaving a pool additionally sends a
  signature proving you control the address. It is not a blockchain transaction and
  it moves no funds. If you hold no SATORIEVR, this endpoint is never contacted.

### That is the whole list

There are no other outbound requests. In particular Satori GO has **no analytics,
no telemetry, no crash or error reporting, no advertising, and no update or
licence check**. Fonts and images are inside the package, so nothing is loaded from
a content delivery network. Links to block explorers and project websites are
ordinary links: nothing is fetched unless you click one, and clicking one opens your
normal browser tab, where that site sees you as any visitor.

## What websites can see

Websites can request a connection through the `window.evrmore` provider. A site gets
**nothing** until you explicitly approve it in a wallet window, and:

- an approval is bound to **one specific wallet**: switching to a different wallet
  does not expose it to that site; the site must ask again;
- an approved site can read the **address and balances** of the wallet you approved;
- an approved site **can never move funds silently**: every single transaction and
  every message signature opens an approval window that you must confirm;
- a site can never read your recovery phrase or private key. They are not present in
  any part of the extension a website can reach.

You can revoke any site at any time in **Settings > Connected sites**.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | To save your encrypted wallet and settings on your device. |
| `alarms` | To run the optional check for incoming funds. While it is on, the wallet contacts the blockchain bridge about once a minute even with the window closed. It is off-switchable. |
| `notifications` | To show a desktop notification when funds arrive (opt-in, off-switchable). |
| Access to `network.satorigo.app` | The gateway described above: prices, notices, the blockchain bridge, and, on an EVM network, everything the wallet reads and broadcasts. |
| Access to `satorinet.io` and `network.satorinet.io` | The SATORIEVR price, the Satori network statistics on the Network tab, and the Satori pool API if you hold SATORIEVR. These sites do not send the headers a web page would need to read them, so an extension host permission is the only way. |
| Access to all websites (content script) | Required so the wallet can offer the `window.evrmore` provider to any page that wants to connect, the same mechanism every browser wallet uses. The injected script only relays connection requests; **it does not read page content, and it does not run any code on your behalf.** It also stamps each request with the site's true origin, so a malicious page cannot pretend to be another site. |

## Children

Satori GO is not directed at children under 13 and we do not knowingly handle their
data (we handle no personal data at all).

## Security, honestly stated

Satori GO is open-source and has had an internal adversarial security review, but it
**has not had a formal external audit**. It handles real funds on a real blockchain.
Use amounts you can afford to lose, and make a small test transaction first. Known
limitations are published at
<https://github.com/SatoriNetwork/SatoriGO/blob/main/KNOWN_LIMITATIONS.md>.

## Changes to this policy

Material changes will be published in this file, with the date at the top updated.
The file's full history is public in the Git repository.

## Contact

Questions about this policy, or a security issue:
**satori@satorinet.io**

For anything exploitable, please report it privately first.
