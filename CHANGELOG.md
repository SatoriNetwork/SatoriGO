# What's new in Satori GO

Satori GO is a non-custodial multi-chain wallet made by Satori Network. Your keys
are generated and stored on your own device, encrypted with your password, and
they never leave it.

This file starts at 1.3.0. Earlier releases are recorded in the repository's tags
and release commits.

---

## 1.4.0

### The wallet opens in the side panel now

On Chrome and Edge the wallet docks in the browser's side panel by default and
stays open while you browse, instead of closing the moment you click away. The
toolbar icon opens it there.

If you prefer the old popup, Settings > Appearance > Window turns it off, and
that choice sticks. The control is no longer hidden behind the expert detail
level, because it is now the only way back to the popup. Firefox still starts in
the popup: its sidebar works, but getting there depends on a background listener
in a way Chrome's does not, so it stays opt-in from the same row.

### If you forget your app password, there is now a way back

Until this release a forgotten app password had exactly one answer, and it was a
poor one: start again on a fresh install and re-import every wallet from its
recovery phrase. That brings back the coins and nothing else. It does not bring
back a wallet you imported from a private key you never wrote down, and it does
not bring back your wallet names, your token lists, your hidden assets or the
extra receive addresses you had derived.

There is still nothing on any server. Satori GO holds no account for you, has no
e-mail on file and stores nothing about your password anywhere but your own
computer, so a "reset my password" link of the kind every website has is not
merely missing, it is impossible. Both of the new routes are ones you keep
yourself.

**A recovery code.** In Settings, under Recovery, you can create a code of 32
characters. Enter it on the lock screen behind "Forgot your password?" and you
choose a new password and go straight in, with every wallet, every name and
every setting exactly as it was. The code is shown once and never again, and it
keeps working no matter how many times you change your password afterwards. It
is written in an alphabet with no I, no L, no O and no U, so the characters
people misread when copying by hand cannot appear, and you can type it in any
case, with or without the dashes.

Be clear about what it is: anyone holding that code can open your wallet without
your password. It is not a convenience. Keep it away from where you keep the
password, and do not photograph it.

**A backup file.** Also under Recovery, Satori GO can write a single encrypted
file holding every wallet on this device, with its own password that you choose
at the time. That password is deliberately not your app password: a file
encrypted with the thing you forgot would be useless in the one situation it
exists for. The file names nothing on the outside. Someone who finds it learns
that it is a Satori GO backup and when it was made, and not one thing more, not
even how many wallets are inside.

The recovery code answers "I forgot my password". The file answers "my computer
is gone", which the code cannot, because the code lives on the computer. Keep
the file somewhere else.

Restoring a file replaces everything currently in the extension, so before it
does anything Satori GO shows you what is in the file and names, one by one, the
wallets on this device that the file does not have. Those are what a restore
would remove. Where it is safe, and only where it can be proved safe, you are
offered the gentler option of adding just the wallets you are missing instead.

Your wallets' recovery phrases remain the final backup, and the one that works
even when the extension itself is gone. Settings says so plainly.

### The lock screen says less

The first screen you see now shows a larger Satori mark, the name, one line, and
one field called Password. The heading, the tagline and the sentence explaining
what the password was for are gone: the screen asks for one thing, and it no
longer spends four lines saying so. "Forgot your password?" sits under the
Unlock button.

### Settings is arranged in three groups

Settings had grown to ten rows in one flat column, which meant reading all of
them to find any of them. They are now grouped under Wallet, Security and App.

Recovery has a row and a screen of its own, instead of being the last block of
the longest screen in Settings, which is the worst place for the thing you go
looking for when something has gone wrong. It is not hidden behind the Expert
detail level either, because losing a password is not an expert activity.

A few names changed to say what they actually do. "Transactions" was a button
that exports your history, so it is now "Export history". "Network & Explorer"
and "Visible networks" both began with the same word for two unrelated jobs, so
they are now "Servers & explorer" and "Networks". The block that reveals your
recovery phrase and private key was called "Backup", which since this release
also means the backup file, so it is now called what it shows. The notification
for incoming funds moved out of Security, where it never belonged, into its own
Notifications screen. The address book joins the Wallet group.

### Two settings that asked the same question

Settings had a general "Require password to send" and, for a wallet opened by
your app password, a separate "Ask for the password when sending". They read as
a duplicate, and worse, turning the general one on did nothing for a wallet that
was set to send with nothing typed, with no word anywhere saying why.

Both are still there, because they govern different things and removing either
would change who gets asked for a password. What is new is that each now states
the other. The general setting says when the wallet you are on sits outside it,
and names that wallet; the wallet's own setting says that it overrides the
general one.

### A wallet with no password now asks you for one, once

Satori GO has always let you create a wallet with no password at all. It is
convenient, and it is also the one thing in the wallet that leaves your recovery
phrase readable by anyone who can use your computer: there is nothing to type, so
there is nothing stopping them opening it and spending from it.

From this release, if you have a wallet like that and no app password, Satori GO
asks you to set an app password when it opens, and waits until you do. The screen
says which wallets it is talking about and what it will change. Wallets that
already have their own passwords do not bring up this screen at all, and nothing
about them changes.

Because setting a password you might later forget is a real risk of its own, the
screen offers your recovery phrase FIRST. Those wallets can still be read with
nothing typed at that moment, which is exactly the problem being fixed, so this
is your last easy chance to write the words down. The offer stays on screen while
you choose the password, so you are never asked for a password without a way to
save what you have.

When you set it, only the wallets that had no password move over. They are then
opened by your app password, and they go on sending without asking for one, just
as they did. Wallets with their own passwords are not touched: each asks for its
own password once, the next time you open it, and then moves over too. In the
meantime you have both to remember, and the screen says so rather than leaving
you to find out at a lock screen. Forgetting the app password does not lock you
out of those wallets, because their own passwords still open them.

While that screen is up, a site asking Satori GO to connect, sign or send is
refused with a note telling you to set the password first. Nothing is approved
and nothing is sent.

### One password for the whole wallet, if you want it

Satori GO has always given every wallet its own password. That is still exactly
how it works, and nothing about your wallets changes unless you ask for it.

If you would rather type one password instead of several, Settings > Security
now offers an app password. Once it is set, opening Satori GO asks for that one
password, and you pick a wallet after it.

Your existing wallets move over one at a time, and only when you open them: the
next time you unlock a wallet with the password it already has, it moves to the
app password, and after that the app password opens it. A wallet you never open
stays exactly as it is, keeps its own password, stays in your list, and still
opens the day you come back to it. If you prefer to leave one where it is, the
prompt has a box for that.

Read this part before you set it: there is no way to recover an app password. If
you lose it, the wallets it protects can only be restored from their recovery
phrases, which is what those phrases have always been for. Removing the app
password is not supported in this release; you can change it at any time, and
changing it locks the wallet so you sign in again with the new one.

A wallet you created with no password at all is a real improvement here: once it
moves over it is protected by your app password like any other. It also keeps
sending without asking for a password, which the prompt now says before you
agree to it, the wallet list shows with a "Sends without pw" badge, and Settings
> Security lets you switch off whenever you want.

That switch runs one way for free and one way for a price. Turning the check
back ON, so a send asks for your app password again, takes one tap. Turning it
OFF means money can leave the wallet with nothing typed, so it asks for your
current app password and for you to tick that you understand the risk, which is
what removing a wallet's own password has always cost.

If you open the app lock screen from a wallet's own lock screen, the wallet now
locks properly on the way there, so that screen is a real gate rather than a
picture of one.

Two more things, both about not being locked out. If you set an app password and
some wallet never moved over, the app lock screen can hand you straight to that
wallet's own password, so a forgotten app password never strands a wallet it
never protected. And if you remove every wallet from the device, the app password
goes with them, so the next wallet you create is yours to give a password to
rather than being gated behind the old one.

### Two windows, each on its own wallet

Satori GO can be open in more than one place at once: the toolbar popup, the side
panel and a detached window are separate windows over the same wallets. If two of
them were on different wallets, the second one could change what the first one
did.

The one worth naming: asking for another receive address showed you an address
belonging to the wallet you were looking at, but counted it against the other
wallet, so the wallet that owns that address never knew it existed and never
looked for coins on it. Changing a wallet's password could land on the other
wallet instead. Removing a wallet could lock the wrong window, or leave one
holding a wallet that was no longer there.

Each window now stays on the wallet you opened in it, whatever the other windows
are doing, and every one of those actions goes to that wallet.

### When another window got there first

Two windows can also try to save a change at the same moment. One of them is
refused, and nothing of it is written, which is exactly right. What the wallet
told you about it was not.

Changing a wallet's password said your current password was wrong, when it was
not. Creating or importing a wallet showed you the word "store-conflict".
Renaming a wallet, switching wallet and removing a wallet reported success for
something that had not happened.

They all say the same true thing now: another window changed your wallets,
nothing was changed, please try again.

### A first screen with some life in it

The screen you meet before there is any wallet, and the lock screen behind it,
now sit on a slow drift of connected points in the Satori accent, and they hold
perfectly still if your system or the wallet is set to reduce motion.

### Satori GO reaches EVM networks

This is the largest addition in 1.4.0. Alongside the UTXO networks it has always
had, Satori GO now works on EVM networks: Ethereum, Base, BNB Chain and Epix.

**One account across all of them.** An EVM account is not per network. The same
seed gives you the same address on every EVM chain, exactly as MetaMask does, so
switching network changes what you are looking at and never which address you
are. One seed can hold several accounts (Account 1, Account 2 and so on), they
are added on demand, and Satori GO finds the ones you have already used rather
than making you remember how many there were. The wallet switcher folds each
seed into one row with its accounts underneath, and past eight rows it grows a
search box that matches on name or address.

**Tokens.** You can add an ERC-20 token by contract address, search the network's
public token list by name or symbol, or import what the account already holds.
Import offers two doors and says which is which: "Import trusted" takes only the
tokens Satori GO will vouch for, and "Import all" takes everything with a
balance, which on a busy address means airdrop and spam tokens too. Sending a
token works the same way as sending a coin, including the fee estimate and the
review step.

**Fees and history.** EVM fees are estimated per network with a cap, so a chain
having a bad minute cannot quietly propose an enormous fee. History comes from a
block explorer's API where the network has one, and where it does not, or where
it has fallen behind the chain, Activity says so instead of showing you an empty
list and letting you assume the worst.

Everything reaches these networks through the Satori GO gateway, on the same
terms as the coin networks: no third-party service sees your address directly
from your browser, and there is no API key on your machine to leak.

### The chain list says which chain you mean

Several networks share a name with a better known coin, so every row in the
network switcher now shows the project's own website under its name. That line
is often the only thing that tells two similarly named chains apart, and the EVM
networks carry one now as well.

Networks that are new here are marked "New" beside the name. Two different
things can earn that mark and the wallet does not confuse them: a network that
is genuinely young and thin also raises a caution notice when you open it,
because such a chain can stop producing blocks and leave a payment waiting,
while a network that is simply new to Satori GO gets the mark and no warning. A
mature chain is not called risky just because we added it recently.

With this many networks the list no longer fits the window, so it scrolls.

### Smaller things

Switching wallet, account or network takes you to the Wallet tab, because after
a switch the first thing you want is the balance rather than whatever screen you
happened to be on. Activity says it is loading instead of looking empty while it
reads. In Send, the list of your own wallets folds into a dropdown once there
are more than four, rather than filling the screen with chips.

### Adding a token no longer needs its contract address

The Add token screen searches the network's public token list as you type. Type
a name or a symbol, pick the match, and the contract address is filled in for
you. Adding by address still works, and is still the only way to add a token
that is not on any list.

### Stake EPIX in the wallet

Epix accounts can now stake from inside Satori GO. Open the EPIX asset and press
Stake: the screen shows what you have staked, what it has earned, and every
bonded validator with its commission and voting power, biggest first (jailed
validators are hidden until you ask for them).

Stake also sits beside Send and Receive on the main screen, with a line under
the balance saying how much you have staked and what it has earned once there
is any (your spendable balance stays the big figure), and the validator list can
be ordered by voting power, by commission (cheapest first) or by name.

You can stake with a validator, move a stake from one validator to another,
unstake, and claim your rewards. Every one of those is a real transaction, so
each goes through the same review step and the same confirmation control a send
does: you see the validator's name AND its full address, the amount, and the
exact fee before anything is signed.

Unstaking is the one to read twice. The coins are locked for the chain's
unbonding period (21 days on Epix today), they earn nothing while they are
locked, and they cannot be sent or moved until it ends. The wallet reads that
period from the chain and states it on both the form and the review, so the
figure you see is the chain's own, not a number we wrote down once.

Staked amounts and pending rewards are read from the chain and can lag a block
or two behind a transaction you just made.

Activity says which of your transactions staked, unstaked, moved a stake or
claimed rewards, with which validator and for how much, instead of listing them
as anonymous contract calls.

### Prices come from the Satori GO gateway

Prices come from the Satori GO gateway (CoinGecko and SafeTrade behind it); the
wallet no longer contacts those services directly. One request a minute, to one
host, instead of a separate call per market to two exchanges. The wallet asks
for no permission to reach any exchange any more: `api.coinex.com` and
`safe.trade` are gone from its permissions, replaced by the gateway.

Two things follow from it. EVR shows a fiat value again, which it lost when the
exchange market the wallet could read was delisted. And the credit line the
price sources ask for is in Settings > About.

### Your coins connect through the Satori GO gateway

The wallet's server connections now go through the Satori GO gateway, the same
single host the prices already come from. Our own node sits behind it, so the
wallet no longer reaches it directly, and Settings > Network lists the gateway
as a required server that cannot be removed. Servers you add yourself still work
exactly as before, and are tried after it.

Every coin now prefers the gateway and keeps its usual public servers listed
behind it as the fallback, so an outage on our side costs you the gateway and
nothing else. Ravencoin and Neoxa are the two exceptions, and it is deliberate:
neither has a public server this wallet can safely use, because the generally
available ones do not speak the asset protocol those two networks need, and
falling back to one would show wrong asset balances instead of failing. Both
therefore go through the gateway alone and are offline while it is unreachable.
If you run your own server for either, you can add it in Settings > Network.

### A token has to be listed, not only have a picture

Satori GO now vouches for a token only when it appears in its network's public
token list AND has a picture in the token registry, so a token that merely has an
image served for it is shown as unlisted and keeps its letter badge, and the
"Import trusted" button imports by exactly that same rule.

### A token cannot wear a badge it gave itself

Token names are now drawn without emoji, tick marks, invisible characters or
text-direction tricks and are cut to a sensible length everywhere the wallet
shows them, and the wallet's own warning has become a filled "unlisted" pill
instead of a small triangle, so a token that writes a green tick into its own
symbol can no longer shout louder than the wallet does.

### The privacy policy says what the wallet actually does

PRIVACY.md has been rewritten to describe every request the wallet makes today,
including the gateway's blockchain bridge, the notices and their pictures, and
what an EVM account sends, and it corrects two claims that had gone out of date.

### Balances on the list are readable again

A balance on the asset list and in the hero now shows at most six significant
digits (truncated, never rounded up), the way MetaMask rounds its list. An
18-decimal balance such as 999.999579999999999979 EPIX used to be printed in
full and pushed the fiat value under the 24h chip. Hover the figure for every
digit; the asset detail screen and Send keep the full precision.

### The transaction id you see is your own

When you send, the wallet now checks that the server's answer names the very transaction it signed, and if the answer names anything else it looks your transaction up on the network before deciding what to tell you, so a server can no longer hand you someone else's transaction id.

### Notices from Satori Network on your home screen

Satori Network can now show a short notice above the coin on your home screen, one at a time, with a colour for its kind and a link where it helps; you can close the ones that allow it, and a closed notice stays closed.

When there is more than one notice they take turns in the same spot every three seconds (they hold still while your pointer is on them, and while your system asks for less motion), a notice can carry a picture above its text, a notice you closed comes back only if Satori Network sends that one out again, the coin now sits just under a notice instead of floating in the space below it, and a token list too long for the window says so with a scrollbar and a small arrow that go away when you reach the end.

Every notice now says plainly that it is a message from Satori Network, shows the site a link really leads to next to whatever that link is called, ends with a fixed reminder that Satori GO will never ask for your recovery phrase, and can always be folded away to a single line, so a notice can never hold your screen or pass itself off as the wallet talking.

### Your tokens stay on screen when the network is busy

Your token list and its balances are now remembered on your device, so opening
the wallet shows what it last knew straight away instead of starting empty, and
a read that fails or comes back incomplete leaves every token where it was
(with the usual "network unreachable" notice above it) rather than dropping the
list to the coin alone; a token disappears only when a read that actually
answered for it says the balance is gone.

### More of your tokens fit on the small window

On the toolbar popup the coin, the balance and the Send / Receive row now take
less height once you hold a few tokens, so about six rows of the list are
visible at a glance instead of one, while the roomier layout stays exactly as it
was in the side panel and on a short list. The list is tighter there too, with
slightly smaller type and shorter rows, and nothing on that screen drops below a
size you can comfortably read. The header, the screen's edges and the tab bar
give up their spare padding on that window as well, which fits a seventh row
without shrinking a single letter, a control or the coin.

### Activity pages, and goes further back

A token's own Activity list is now paged the same way the main Activity tab is,
and on the last page both offer "Load older" to fetch history further back than
the first page your network's history service returns, one page per press, with
a plain line saying so when there is nothing older left to fetch.

### Put your token list in the order you want it

The pencil beside "Assets" turns the list into an edit mode where each token
gets a handle you can drag (or move with the arrow keys) to set the order, which
is remembered per account and per network, and a tick box so you can select
several and remove them from the list in one go.

### Neoxa joins the network list

Neoxa (NEOX) is now one of the networks you can pick when you create or import a
wallet. It works the way the others do: its own receiving address, its own block
explorer, its own fee rules, and its own place in the header switcher.

Neoxa carries the same kind of asset layer Evrmore and Ravencoin have, so like
Ravencoin it reaches the chain through one server rather than a public pool: a
server that got assets wrong would not fail loudly, it would show you a balance
of zero for something you hold. That server is now connected, so balances,
history and sending all work.

## 1.3.3

### Open the wallet in the browser's side panel (experimental)

Settings > Expert > Appearance > Window has a new switch, "Open as side panel".
With it on, the next click on the toolbar icon opens Satori GO docked in the
browser's side panel, where it stays open while you browse, instead of the
popup that closes when you click elsewhere. Turn it off to get the popup back.
Chrome and Edge only (Firefox has no such API for extensions). This adds the
`sidePanel` permission on Chrome and Edge; it carries no access to any site or
data, it only lets the wallet register itself as a side panel.

Firefox: the same switch uses Firefox's sidebar. With it on, the toolbar
icon toggles the Satori GO sidebar (it is also in View > Sidebar).

### A header in the usual order

The network picker sits on the left, the wallet name with its address in the
centre, the actions on the right, the way most wallets lay it out. Nothing
overlaps at any width, including a narrow side panel.

### A calmer lock screen

The lock screen shows the wallet you are about to unlock and the password
field, nothing else. "Change" opens the full list of wallets and accounts on
its own screen, with room to read every name.

### Confirm your recovery phrase

Creating a wallet now ends with a short check: three of the twelve words, in
their places, before the wallet opens. It takes ten seconds and catches the
backup that was never actually written down. Importing a phrase is unchanged.

### Warnings before you send

The send screen now tells you when you are sending to an address for the
first time, when an address looks like one you have used before but is not
the same (the pattern address-poisoning scams rely on), and, on EVM chains,
when the address is a contract rather than a wallet. They are warnings, not
blocks; the decision stays yours.

### A face for every account, one address, days in Activity

Every wallet and account has its own small round mark drawn from its address,
so two accounts never look alike in a list. The address sits once, under the
wallet name in the header, and a click copies it. Activity groups its rows by
day.

### A tidier token list

Tokens are ordered by what matters: the chain's own coin first, then holdings
with a known value, then the rest of your holdings, with unlisted tokens
after listed ones and empty balances at the end. An eye button next to "Add
token" (a filter mark) hides zero balances (and remembers); the eye beside
the balance hides every amount on the screen, for when someone is looking
over your shoulder. Rows no longer carry a remove
cross; a token is removed from its own screen. Where a price is known, a
24 hour change sits next to the fiat value.

### Rename wallets from the switcher

Every row in the wallet switcher has a pencil: rename a wallet right there,
Enter saves, Escape cancels. Settings > Wallets still renames too.

---

## 1.3.2

Work done while 1.3.0 was in store review. Nothing here changes what the
wallet asks of your browser: the permissions are untouched.

### The connection state follows you

Every screen in the wallet now shows whether it is actually connected. The main
tabs say it in words; the narrower screens, where a label would not fit, show a
coloured dot that names its state when you hover it. An empty Activity list used
to be ambiguous, since "you have no transactions" and "we could not reach the
network" looked exactly the same. They all read one signal, so they cannot
disagree with each other.

### A copied recovery phrase is cleared sooner

Copying your recovery phrase or a private key already started a 30 second
countdown to wipe it from the clipboard. Now leaving the screen wipes it
straight away, instead of waiting the countdown out. Copying something ordinary
afterwards, an address for instance, is never wiped by this: only the secret is.

Closing the wallet window immediately after copying still skips the wipe, and
that one is not fixable in an extension. The browser only lets a page touch the
clipboard while it is on screen and in focus, which is precisely what a closing
window is not.

### Amounts are exact, at each network's own scale

An amount beyond about 90 million coins could not be converted exactly, and the
send path quietly used the rounded figure. On the networks here that is a real
number rather than a theoretical one: Dogecoin's supply is measured in hundreds
of billions.

The amount you type is now converted straight from the text you entered, so
nothing is rounded on the way and any size is exact. The wallet also reads how
many decimal places a network actually has from that network's own settings,
instead of assuming eight everywhere, which is what makes the above true rather
than merely usually true.

Balances take the same route. They now travel from the network to the screen as
an exact count, instead of being turned into an ordinary decimal number on the
way, so a large balance keeps its last digits and a wallet holding the same coin
on several addresses adds them up exactly rather than nearly.

You get better refusals too. Typing more decimal places than a coin has now says
exactly that, instead of a general complaint about the amount. And a transaction
proposed by a website, the one case where the amount does not come from you, is
still checked before anything is built.

### Coins on addresses the wallet had not derived

Importing a recovery phrase now looks ahead for addresses of that same phrase
that already hold coins, stopping after twenty empty ones in a row, and Settings
has a "Scan for used addresses" button to run it again later. This was the most
likely reason an imported wallet showed a smaller balance than expected: coins
sat on addresses this wallet had simply never derived. Found coins are shown and
can be spent like any other. When the scan cannot finish, because addresses could
not be read or it reached its limit, it says the answer is incomplete rather than
reporting nothing found.

### A passphrase when you create a wallet, not only when you import one

You can add a BIP39 passphrase, sometimes called a 25th word, to a wallet you
create. It is off by default and behind an explicit opt-in, because it is not
for everyone: with a passphrase set, your recovery phrase alone will never
restore the wallet, and nobody can recover a forgotten one. It has to be typed
twice, and the screen that shows your recovery phrase stops calling that phrase
your only backup once you have set one.

### The import screen admits what it cannot check

Several networks share the same private-key prefix. Importing a key whose prefix
matches the selected network now says which other networks use that same prefix,
so a match is not mistaken for proof of where the key came from. It does not
block the import, because a shared prefix is not an error.

### No invented price for Evrmore

The exchange this wallet read the EVR price from delisted the market, so there
is no price to read. The wallet no longer asks for it once a minute. Balances
were never affected; only the dollar figure beside them, which is now simply
absent rather than wrong.

---

## 1.3.0

The release that turns Satori GO from a two-network wallet into a genuinely
multi-chain one.

### Seven networks, one wallet

Satori GO now carries Bitcoin, Litecoin, Dogecoin, Evrmore, Ravencoin,
BitcoinGold and WojakCoin.

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
