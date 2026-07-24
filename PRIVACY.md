# Privacy Policy — Satori GO

**Last updated: 13 July 2026**

Satori GO is a non-custodial multi-chain wallet distributed as a Chrome extension.
This policy describes exactly what data the extension handles, what leaves your
device, and who can see it.

Every statement below was checked against the source code, which is public at
<https://github.com/SatoriNetwork/SatoriGO>. You can verify all of it yourself.

## The short version

- **We do not collect anything.** Satori GO has no accounts, no sign-up, no servers
  of our own, no analytics, no telemetry, no tracking, no advertising, and no
  cookies. There is no backend that belongs to us.
- **Your keys never leave your device.** Your recovery phrase and private keys are
  stored only on your own computer, only as AES-256-GCM ciphertext, and are never
  transmitted anywhere — not to us, not to a website, not even to the extension's
  own background process.
- **We do not sell, rent, or transfer your data to anyone**, because we never receive
  it in the first place.

## What is stored on your device

All data is kept in your browser's local extension storage (`chrome.storage.local`)
and never synced to a cloud by us:

| Data | How it is stored |
|---|---|
| Recovery phrase / private key | **Encrypted only** — AES-256-GCM, key derived with scrypt (N=2¹⁷) from your password. The plaintext exists in memory only while the wallet is unlocked, and is wiped on lock. |
| Your password | **Never stored**, in any form. It is used to derive the decryption key and then discarded. |
| Wallet names, addresses, address book, settings, cached balances and transaction history | In plain form (this is not secret data), locally only. |
| Sites you have approved for dApp connect | Locally, as an `{origin, wallet}` pair. |

If you uninstall the extension, Chrome deletes this storage. **If you have not backed
up your recovery phrase, your funds are unrecoverable.** We cannot recover them for
you — we have never had access to them.

## What leaves your device, and to whom

A wallet cannot show your balance without asking the network about your addresses.
Satori GO talks to the following third parties. **We do not control them, and their
own privacy policies apply.**

**1. EVRmore ElectrumX servers** — to read balances and transaction history, and to
broadcast transactions you have explicitly confirmed.
Default servers: `electrumx1.satorinet.io`, `electrum1-mainnet.evrmorecoin.org`,
`electrum2-mainnet.evrmorecoin.org`. You can change or replace this list in
**Settings → Network**, including pointing it at your own server.
*What they can see:* the script hashes derived from your wallet addresses, the
transactions you broadcast, and your IP address. This is inherent to how every light
wallet works. Running your own Electrum server avoids it.

**2. Ravencoin ElectrumX server:** to read balances and transaction history, and to
broadcast transactions you have explicitly confirmed, for any Ravencoin wallet you
create. Default server: `rvnx.satorinet.io`. You can change or replace this in
**Settings → Network**, including pointing it at your own server.
*What they can see:* the script hashes derived from your wallet addresses, the
transactions you broadcast, and your IP address. This is inherent to how every light
wallet works. Running your own Electrum server avoids it.

**3. Price sources** — to display an approximate USD value.
`api.coinex.com` (EVR price), `satorinet.io` (SATORIEVR price), `safe.trade`
(fallback SATORIEVR price).
*What they can see:* your IP address. **No wallet data, address, or balance is sent
to them** — these are plain public price lookups.

**4. The Satori pool API (`network.satorinet.io`)** — **only if you use SATORIEVR
staking.** Joining or leaving a pool registers your address as a pool lender; it is
not a blockchain transaction and moves no funds. To do this, the extension sends your
EVRmore address and a signature proving you control it.
*What they can see:* your EVRmore address and IP. If you never open the staking
screen, this endpoint is never contacted.

**5. A logo URL you type in yourself** — if you add a custom logo for an asset, the
extension fetches that exact URL once, at the moment you save it. If you never do
this, no such request is made.

That is the complete list. There are no other outbound requests.

## What websites can see

Websites can request a connection through the `window.evrmore` provider. A site gets
**nothing** until you explicitly approve it in a wallet window, and:

- an approval is bound to **one specific wallet** — switching to a different wallet
  does not expose it to that site; the site must ask again;
- an approved site can read the **address and balances** of the wallet you approved;
- an approved site **can never move funds silently** — every single transaction and
  every message signature opens an approval window that you must confirm;
- a site can never read your recovery phrase or private key. They are not present in
  any part of the extension a website can reach.

You can revoke any site at any time in **Settings → Connected sites**.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | To save your encrypted wallet and settings on your device. |
| `alarms` | To run the optional periodic check for incoming funds. |
| `notifications` | To show a desktop notification when funds arrive (opt-in, off-switchable). |
| Access to `api.coinex.com`, `satorinet.io`, `network.satorinet.io`, `safe.trade` | To fetch prices and, if you use staking, to talk to the Satori pool API. These sites do not send CORS headers, so an extension host permission is the only way to read them. |
| Access to all websites (content script) | Required so the wallet can offer the `window.evrmore` provider to any page that wants to connect — the same mechanism every browser wallet uses. The injected script only relays connection requests; **it does not read page content, and it does not run any code on your behalf.** It also stamps each request with the site's true origin, so a malicious page cannot pretend to be another site. |

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
