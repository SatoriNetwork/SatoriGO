// UTXO-legacy chain parameters (Evrmore + Ravencoin).
//
// SOURCE OF TRUTH: each chain's own chainparams.cpp / validation.cpp, fetched
// from the official repo (not guessed). Getting these wrong = incompatible or
// unspendable addresses, so every value below is annotated with its origin.
//
// EVRMORE — EvrmoreOrg/Evrmore, src/chainparams.cpp:
//   mainnet base58Prefixes[PUBKEY_ADDRESS] = 33   -> addresses begin with 'E'
//   mainnet base58Prefixes[SCRIPT_ADDRESS] = 92   -> addresses begin with 'e'
//   mainnet base58Prefixes[SECRET_KEY]     = 128  (WIF)
//   mainnet EXT_PUBLIC_KEY = 0x0488B21E  (xpub)
//   mainnet EXT_SECRET_KEY = 0x0488ADE4  (xprv)
//   mainnet nExtCoinType   = 175         (SLIP-44, shared with Ravencoin)
//   asset script opcode OP_EVR_ASSET = 0xc0 (src/script/script.h)
//   strMessageMagic = "Evrmore Signed Message:\n" (src/validation.cpp)
//
// RAVENCOIN — RavenProject/Ravencoin, verified 2026-07-21 against master:
//   src/chainparams.cpp (CMainParams):
//     line 195  base58Prefixes[PUBKEY_ADDRESS] = 60   -> addresses begin with 'R'
//     line 196  base58Prefixes[SCRIPT_ADDRESS] = 122
//     line 197  base58Prefixes[SECRET_KEY]     = 128  (WIF)
//     line 198  base58Prefixes[EXT_PUBLIC_KEY] = {0x04,0x88,0xB2,0x1E}
//     line 199  base58Prefixes[EXT_SECRET_KEY] = {0x04,0x88,0xAD,0xE4}
//     line 202  nExtCoinType = 175   (SLIP-44, SHARED with Evrmore)
//     line 177  pchMessageStart = 0x52,0x41,0x56,0x4e ("RAVN"); nDefaultPort 8767
//   src/script/script.h:188  OP_RVN_ASSET = 0xc0  (same opcode value as Evrmore)
//   src/assets/assets.cpp: transfer marker bytes RVN_R,RVN_V,RVN_N,RVN_T ("rvnt"),
//     issue "rvnq", reissue "rvnr", owner "rvno" (assets.h:19 RVN_R=114='r').
//   src/validation.cpp:129  strMessageMagic = "Raven Signed Message:\n"
//
// SHARED-KEY PROPERTY: because Evrmore and Ravencoin share coinType 175 and the
// same BIP32 mainnet version bytes, the same seed + path derives the SAME
// private/public key and therefore the SAME hash160 on both chains. Only the
// address VERSION byte differs (33 'E' vs 60 'R'). Verified in keys.test.ts.

// BITCOIN GOLD (BTGS) — BTGSCOINDEV/BTGS, verified 2026-08-13 against master.
//   NOTE: this is NOT the 2017 Bitcoin Gold (BTG, Equihash, coinType 156, which
//   signs with SIGHASH_FORKID). BTGS is a NEW SHA-256 Bitcoin Core v30.2.3 fork
//   with its OWN genesis, so it uses STANDARD Bitcoin signing (no fork id).
//   Confirmed empirically: the ElectrumX server at electrum.bitcoingold.site
//   reports genesis 0000000d1c5a…f964, matching the assert below.
//   src/kernel/chainparams.cpp (CMainParams):
//     base58Prefixes[PUBKEY_ADDRESS] = 38   -> addresses begin with 'G'
//     base58Prefixes[SCRIPT_ADDRESS] = 22   -> addresses begin with 'A'
//     base58Prefixes[SECRET_KEY]     = 176  (WIF)
//     base58Prefixes[EXT_PUBLIC_KEY] = {0x04,0x88,0xB2,0x1F}  <- NON-STANDARD
//     base58Prefixes[EXT_SECRET_KEY] = {0x04,0x88,0xAD,0xE5}  <- NON-STANDARD
//       (Bitcoin/Evrmore/Ravencoin use 0x0488B21E / 0x0488ADE4; BTGS bumped the
//        last byte by one. Only xpub/xprv SERIALIZATION is affected, never the
//        derived keys or addresses, but getting it wrong breaks xpub interop.)
//     bech32_hrp = "bcg"; nDefaultPort = 18888
//     assert(hashGenesisBlock == 0000000d1c5a497963a46c0348cb4346779c52d9e1d7cc8b5efb1be0a4a0f964)
//     DEPLOYMENT_TAPROOT / segwit = ALWAYS_ACTIVE -> native segwit from genesis.
//   src/common/signmessage.cpp: MESSAGE_MAGIC = "Bitcoin Signed Message:\n" (unchanged).
//   coinType 18888: supplied by the project (SLIP-44). It is NOT present in
//   chainparams.cpp — upstream Bitcoin Core hardcodes coin type 0 for mainnet in
//   descriptor wallets — so a seed exported to the official BTGS Core wallet may
//   derive DIFFERENT addresses. Flagged to the owner; ours is self-consistent.
//   BTGS has NO asset protocol (its "BCG-20" is an inscription meta-protocol,
//   not the Ravencoin asset model), hence assetMarkerPrefix is undefined.

// LITECOIN (LTC) — litecoin-project/litecoin, verified 2026-08-13 against master.
//   src/chainparams.cpp (CMainParams):
//     base58Prefixes[PUBKEY_ADDRESS]  = 48   -> addresses begin with 'L'
//     base58Prefixes[SCRIPT_ADDRESS]  = 5    -> LEGACY P2SH, begins with '3'
//     base58Prefixes[SCRIPT_ADDRESS2] = 50   -> CURRENT P2SH, begins with 'M'
//     base58Prefixes[SECRET_KEY]      = 176  (WIF)
//     base58Prefixes[EXT_PUBLIC_KEY]  = {0x04,0x88,0xB2,0x1E}  <- STANDARD
//     base58Prefixes[EXT_SECRET_KEY]  = {0x04,0x88,0xAD,0xE4}  <- STANDARD
//       UNLIKE BTGS (which bumped both last bytes to 0x1F/0xE5), Litecoin keeps the
//       SAME BIP32 version bytes as Bitcoin/Evrmore/Ravencoin, so xpub/xprv
//       serialization is plain-standard here. Do NOT "align" these with BTGS.
//     bech32_hrp = "ltc"; nDefaultPort = 9333
//     pchMessageStart = 0xfb,0xc0,0xb6,0xdb (informational only — this wallet
//       speaks Electrum, never the P2P protocol)
//     assert(hashGenesisBlock ==
//       12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2)
//   src/util/message.cpp: MESSAGE_MAGIC = "Litecoin Signed Message:\n"
//   coinType 2: SLIP-44, from the OFFICIAL satoshilabs/slips slip-0044.md registry
//     (a real registered value, unlike the project-supplied BTGS 18888).
//   Segwit is ACTIVE on Litecoin mainnet, so newly derived receive addresses are
//   native ltc1… P2WPKH under BIP84 (m/84'/2'/…), exactly like BTGS.
//   Litecoin has NO asset protocol. Verified live against its ElectrumX server,
//   which reports the genesis hash above (tip ~3,159,496) and ERRORS on
//   blockchain.asset.get_meta — i.e. PLAIN ElectrumX. assetMarkerPrefix is
//   therefore undefined, and supportsAssets() is what code must branch on.
//
//   TWO P2SH PREFIXES, ONE `scriptHash` FIELD. Litecoin migrated its P2SH version
//   byte from 5 ('3…', the value Bitcoin also uses) to 50 ('M…') to remove that
//   cross-chain ambiguity; both remain consensus-valid. `scriptHash` carries the
//   CURRENT form (50); the historical one is recorded in `scriptHashLegacy` (5)
//   but deliberately NOT consulted by address validation, because:
//     1. scriptHash is only read by isValidAddress(), whose job is LENIENCY ("does
//        this look like an address on this chain?"). The SEND path gates on
//        isSpendableAddress(), which accepts P2PKH + P2WPKH ONLY and rejects every
//        P2SH form outright — the builder cannot construct a P2SH output at all —
//        so no recipient address can become an unspendable output either way. The
//        omission cannot burn funds.
//     2. Honouring 5 would make every BITCOIN P2SH address ('3…', identical
//        version byte AND identical checksum algorithm) validate as a Litecoin
//        address. Omitting it fails CLOSED and keeps that confusion out of the UI.
//   Net effect: a legacy '3…' Litecoin P2SH address is reported "not a Litecoin
//   address". Stricter than consensus, never more permissive.

// WOJAKCOIN (WJK) — WojakCoinProj/wojakcore, verified 2026-08-13 against BOTH the
// `master` and the default `rebase-0.21.2` branch (the two agree on every value).
//   src/chainparams.cpp (CMainParams):
//     base58Prefixes[PUBKEY_ADDRESS] = 73   -> addresses begin with 'W'
//     base58Prefixes[SCRIPT_ADDRESS] = 5    -> P2SH '3…' (see the P2SH note below)
//     base58Prefixes[SECRET_KEY]     = 201  (WIF)
//     base58Prefixes[EXT_PUBLIC_KEY] = {0x04,0x88,0xB2,0x1E}  <- STANDARD
//     base58Prefixes[EXT_SECRET_KEY] = {0x04,0x88,0xAD,0xE4}  <- STANDARD
//       The same BIP32 version bytes as Bitcoin/Evrmore/Ravencoin/Litecoin, so
//       xpub/xprv serialization is plain-standard. Do NOT "align" these with
//       BTGS's non-standard 0x0488B21F / 0x0488ADE5.
//     bech32_hrp = "wj"   <-- PRESENT IN chainparams BUT DELIBERATELY UNUSED HERE.
//       Read the SEGWIT TRAP block below before touching this. It is a funds-loss
//       trap, not an oversight.
//     nDefaultPort = 20759; nSubsidyHalvingInterval = 210000
//     assert(hashGenesisBlock ==
//       000000004536a4f8fa9d88f0001ca9f9825f8d9fd3ba6383a2f030c0427bf085)
//   src/util/message.cpp: MESSAGE_MAGIC = "Bitcoin Signed Message:\n" — unchanged
//     from upstream Bitcoin Core (same as BTGS, unlike Evrmore/Ravencoin/Litecoin
//     which each customise it).
//   coinType 20760: SLIP-44, from the OFFICIAL satoshilabs/slips slip-0044.md
//     registry ("| 20760 | WJK | WojakCoin |") — a real registered value like
//     Litecoin's 2, unlike the project-supplied BTGS 18888.
//   NO ASSET PROTOCOL. Verified live 2026-08-13 against two ElectrumX 1.16.0
//     servers over wss: both report genesis 000000004536a4f8…bf085 (matching the
//     assert above) at tip 177,012, and both are PLAIN ElectrumX with no asset
//     dialect. assetMarkerPrefix is therefore undefined and supportsAssets() is
//     false — that predicate, never a chain name, is what code must branch on.
//
//   *** SEGWIT TRAP — DO NOT ADD `bech32Hrp: 'wj'` TO THIS CHAIN. ***
//   chainparams.cpp really does define bech32_hrp = "wj", so this entry looks
//   "incomplete" next to BTGS and Litecoin. It is not. WojakCoin NEVER ACTIVATES
//   SEGWIT:
//       consensus.SegwitHeight = std::numeric_limits<int>::max();
//       consensus.BIP65Height  = std::numeric_limits<int>::max();
//       consensus.BIP66Height  = std::numeric_limits<int>::max();
//       DEPLOYMENT_TAPROOT     = NEVER_ACTIVE
//   INT_MAX is Bitcoin Core's "never" sentinel: no block height ever reaches it,
//   so those rules never switch on. To a network of nodes that do not enforce
//   segwit, a P2WPKH output (OP_0 <20-byte program>) is NOT a witness program at
//   all — it is a bare, ANYONE-CAN-SPEND script that any miner or passing watcher
//   can sweep with an empty scriptSig. Coins sent to a `wj1…` address on this
//   chain are therefore STEALABLE BY ANYONE.
//   An hrp in chainparams is NOT evidence that segwit addresses are safe; only an
//   activated SegwitHeight at a real block height is. Concretely, if someone
//   "completed" these params by setting bech32Hrp:
//     - supportsSegwit() flips to true,
//     - addressFormat/derivationPath would move receive addresses to BIP84
//       (m/84'/20760'/…) and pubkeyToAddress() would emit `wj1…`,
//     - isSpendableAddress() would start ACCEPTING `wj1…` recipients,
//   i.e. the wallet would hand out and pay to addresses whose funds anyone can
//   take. So bech32Hrp is INTENTIONALLY LEFT UNDEFINED and addressFormat is
//   'p2pkh' (derivation m/44'/20760'/0'/0/0). Pinned by chainParams.wojak.test.ts.
//
//   P2SH PREFIX 5 IS BITCOIN'S OWN. WojakCoin's SCRIPT_ADDRESS is 5 — the exact
//   version byte Bitcoin uses for '3…' P2SH, with the exact same base58check
//   checksum — so a Bitcoin P2SH address and a WojakCoin one are byte-identical
//   and indistinguishable. This is the same ambiguity Litecoin removed by
//   migrating 5 -> 50, and it is handled the same way: the verified value is
//   recorded in `scriptHashLegacy` (so provenance is not lost) and is NOT
//   consulted by address validation. The difference from Litecoin is that
//   WojakCoin has NO second, unambiguous P2SH prefix to fall back on, so its
//   `scriptHash` is the NO_ACCEPTED_P2SH sentinel: this chain accepts NO P2SH
//   address form at all. Failing closed is correct here for the same two reasons
//   spelled out in the Litecoin block:
//     1. isValidAddress() is the LENIENT "does this look like our address?" check;
//        the SEND path gates on isSpendableAddress(), which accepts P2PKH (+
//        P2WPKH where the chain has segwit) ONLY and rejects every P2SH outright,
//        and the builder cannot construct a P2SH output at all. So omitting 5
//        cannot make any recipient unspendable — it can only refuse one.
//     2. Honouring 5 would make EVERY Bitcoin '3…' address validate as a
//        WojakCoin address, inviting exactly the cross-chain mix-up the check
//        exists to prevent.
//   Net effect: a '3…' WojakCoin P2SH address is reported "not a WojakCoin
//   address". Stricter than consensus, never more permissive.

// BITCOIN (BTC) — bitcoin/bitcoin, verified 2026-08-14 against master.
//
//   REGISTERED LAST, BUT CHRONOLOGICALLY FIRST. Every other chain in this file
//   descends from Bitcoin, so the values below are the ORIGIN that the others
//   forked and then modified — not one more variant to be reconciled with them.
//   Read every difference in that direction:
//     - EXT_PUBLIC_KEY/EXT_SECRET_KEY 0x0488B21E / 0x0488ADE4 are BITCOIN'S OWN.
//       Evrmore, Ravencoin, Litecoin and WojakCoin all kept them unchanged. BTGS
//       bumped both last bytes to 0x0488B21F / 0x0488ADE5, which is a DEVIATION
//       FROM THESE VALUES, not a correction of them. Anyone "harmonising" BIP32
//       version bytes across the file must therefore not touch this entry: BTGS is
//       the outlier because its own chainparams.cpp says so, and copying 1F/E5 onto
//       Bitcoin would break xpub/xprv interop with literally every other wallet.
//     - SECRET_KEY 128 is Bitcoin's (Evrmore/Ravencoin kept it; Litecoin and BTGS
//       use 176, WojakCoin 201).
//     - MESSAGE_MAGIC "Bitcoin Signed Message:\n" is Bitcoin's (BTGS and WojakCoin
//       left it untouched; Evrmore/Ravencoin/Litecoin each customised it).
//   src/kernel/chainparams.cpp (CMainParams):
//     base58Prefixes[PUBKEY_ADDRESS] = 0    -> addresses begin with '1'
//     base58Prefixes[SCRIPT_ADDRESS] = 5    -> P2SH, begins with '3'
//     base58Prefixes[SECRET_KEY]     = 128  (WIF)
//     base58Prefixes[EXT_PUBLIC_KEY] = {0x04,0x88,0xB2,0x1E}  (canonical xpub)
//     base58Prefixes[EXT_SECRET_KEY] = {0x04,0x88,0xAD,0xE4}  (canonical xprv)
//     bech32_hrp = "bc"; nDefaultPort = 8333
//     pchMessageStart = 0xf9,0xbe,0xb4,0xd9 (informational only — this wallet
//       speaks Electrum, never the P2P protocol)
//     assert(hashGenesisBlock ==
//       000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f)
//   src/common/signmessage.cpp: MESSAGE_MAGIC = "Bitcoin Signed Message:\n"
//   coinType 0: SLIP-44, the registry's CANONICAL Bitcoin entry (satoshilabs/slips
//     slip-0044.md). Coin type 0 *is* Bitcoin — which is why the published BIP44 /
//     BIP84 test vectors that the Litecoin and WojakCoin suites borrow as their
//     independent anchors are all rooted at m/44'/0' and m/84'/0'. Those suites
//     synthesised a fake "as Bitcoin" network to reach the vector; this entry IS
//     that network, so its test asserts the published address directly.
//   Segwit is ACTIVE on mainnet, so newly derived receive addresses are native
//     bc1… P2WPKH under BIP84 (m/84'/0'/0'/0/0), like BTGS and Litecoin.
//   NO ASSET PROTOCOL. Verified live 2026-08-14 against two ElectrumX 2.0.0 servers
//     over wss: both report genesis 000000000019d668…ce26f (matching the assert
//     above) at tip 962,405, and both are PLAIN ElectrumX with no asset dialect.
//     assetMarkerPrefix is therefore undefined and supportsAssets() is false —
//     that predicate, never a chain name, is what code must branch on.
//
//   P2SH PREFIX 5 IS THIS CHAIN'S OWN, SO IT IS ACCEPTED HERE (no sentinel).
//   Litecoin demotes 5 to `scriptHashLegacy` and WojakCoin sets `scriptHash` to
//   NO_ACCEPTED_P2SH. Both do so for ONE reason: 5 is BITCOIN'S prefix, so
//   honouring it would let Bitcoin '3…' addresses validate as theirs. That
//   reasoning is DIRECTIONAL and does not transfer to Bitcoin itself — there is no
//   other chain this value is being borrowed from. Applying NO_ACCEPTED_P2SH here
//   by reflex would reject genuine, unambiguous Bitcoin addresses and buy nothing,
//   so `scriptHash: 5` is correct and there is no `scriptHashLegacy`.
//   The ambiguity does exist, but it points the other way: a Litecoin-legacy or a
//   WojakCoin '3…' string also validates as Bitcoin here. That is right, not a
//   leak — those byte sequences ARE Bitcoin P2SH addresses (identical version byte,
//   identical base58check checksum, nothing to distinguish), and Bitcoin is the
//   chain that owns the prefix.
//   ACCEPTING IT STILL DOES NOT MAKE IT PAYABLE. `scriptHash` is read only by
//   isValidAddress(), the LENIENT "does this look like an address on this chain?"
//   check. The SEND path gates on isSpendableAddress(), which accepts P2PKH +
//   P2WPKH ONLY and rejects EVERY P2SH form on EVERY chain — the builder cannot
//   construct a P2SH output at all — so a '3…' recipient is refused here exactly as
//   it is everywhere else. The difference is only that Bitcoin says "that is a
//   Bitcoin address we cannot pay to" instead of "that is not our address".

// DOGECOIN (DOGE) — dogecoin/dogecoin, verified 2026-08-15 against master.
//   src/chainparams.cpp (CMainParams):
//     base58Prefixes[PUBKEY_ADDRESS] = 30   -> addresses begin with 'D'
//     base58Prefixes[SCRIPT_ADDRESS] = 22   -> P2SH, begins with '9' or 'A'
//     base58Prefixes[SECRET_KEY]     = 158  (WIF)
//     base58Prefixes[EXT_PUBLIC_KEY] = {0x02,0xfa,0xca,0xfd}  <- NON-STANDARD ("dgub")
//     base58Prefixes[EXT_SECRET_KEY] = {0x02,0xfa,0xc3,0x98}  <- NON-STANDARD ("dgpv")
//       (Like BTGS, Dogecoin does not use Bitcoin's 0x0488B21E/0x0488ADE4 — but its
//        deviation is its OWN, whole-prefix "dgub"/"dgpv" family, not BTGS's
//        last-byte bump. Version bytes only affect xpub/xprv SERIALIZATION, never
//        the derived keys or addresses. NOTE for interop: some third-party wallets
//        serialize Dogecoin xpubs with Bitcoin's bytes anyway; the values here are
//        what dogecoin/dogecoin itself ships, which is the source of truth.)
//     nDefaultPort = 22556; pchMessageStart = 0xc0,0xc0,0xc0,0xc0 (informational
//       only — this wallet speaks Electrum, never the P2P protocol)
//     assert(consensus.hashGenesisBlock ==
//       1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691)
//   src/validation.cpp: strMessageMagic = "Dogecoin Signed Message:\n"
//   coinType 3: SLIP-44, from the OFFICIAL satoshilabs/slips slip-0044.md registry
//     ("| 3 | DOGE | Dogecoin |") — one of the original registered entries.
//   NO ASSET PROTOCOL. Verified live 2026-08-15 against two ElectrumX 2.0.0
//     servers over wss (doge.electrum{1,2}.cipig.net:30060, protocol 1.6): both
//     report genesis 1a91e3dace36e2be…5691 — matched BOTH from server.features
//     AND by sha256d of blockchain.block.header(0) — at tip 6,333,464, and both
//     are PLAIN ElectrumX (blockchain.asset.get_meta -> "unknown method";
//     get_balance(sh, true) -> "at most 1" argument). assetMarkerPrefix is
//     therefore undefined and supportsAssets() is false.
//
//   *** SEGWIT IS DISABLED — DO NOT "COMPLETE" THIS CHAIN WITH A bech32 HRP. ***
//   chainparams.cpp sets consensus.vDeployments[DEPLOYMENT_SEGWIT].nTimeout = 0:
//   the deployment expired before it could ever signal, so segwit NEVER ACTIVATES
//   on Dogecoin mainnet, and chainparams defines no bech32_hrp at all. This is
//   the same class of trap documented in the WOJAKCOIN header (there via
//   SegwitHeight = INT_MAX): on a network that does not enforce witness rules a
//   P2WPKH output is a bare ANYONE-CAN-SPEND script. So bech32Hrp stays
//   undefined, addressFormat is 'p2pkh' and derivation is BIP44
//   (m/44'/3'/0'/0/0). Pinned by chainParams.dogecoin.test.ts.
//
//   P2SH PREFIX 22 IS DOGECOIN'S OWN — AND BTGS BORROWED IT. Dogecoin has used
//   SCRIPT_ADDRESS 22 since 2013; BTGS (a 2026 fork, registered above) ships the
//   same byte. Per the DIRECTIONAL rule spelled out in the BITCOIN header
//   (the chain that owns a prefix accepts it; the borrower is the one that fails
//   closed — WojakCoin vs Bitcoin's 5), Dogecoin keeps `scriptHash: 22` accepted:
//   there is no older chain this value was taken FROM, so refusing it would
//   reject genuine Dogecoin addresses and buy nothing. The overlap that remains
//   ('9…'/'A…' P2SH strings validating on both DOGE and BTGS) is leniency-only:
//   isValidAddress() is the lenient "looks like ours" check, while the SEND path
//   gates on isSpendableAddress(), which rejects EVERY P2SH form on EVERY chain —
//   the builder cannot construct a P2SH output at all — so the ambiguity cannot
//   misdirect funds. RESOLVED 2026-08-15 (owner decision): BTGS, as the
//   borrower, now demotes ITS 22 to scriptHashLegacy exactly as WojakCoin
//   demoted Bitcoin's 5, so the overlap is gone in the only direction that
//   could mislead. Dogecoin is unchanged.
//   The P2PKH prefixes do NOT collide: Dogecoin 'D' (30) vs BTGS 'G' (38).

/** Ticker of a chain's native coin. Widen this (and networkFor) to add a chain. */
export type NativeTicker = 'EVR' | 'RVN' | 'BTGS' | 'LTC' | 'WJK' | 'BTC' | 'DOGE';

/** Canonical identity of a supported chain+network. */
export type ChainId =
  | 'evrmore-mainnet'
  | 'evrmore-testnet'
  | 'ravencoin-mainnet'
  | 'bitcoingold-mainnet'
  | 'litecoin-mainnet'
  | 'wojakcoin-mainnet'
  | 'bitcoin-mainnet'
  | 'dogecoin-mainnet';

/**
 * `scriptHash` sentinel meaning "this chain accepts NO P2SH address form".
 *
 * A base58check version byte is `payload[0]`, i.e. always 0…255, so a NEGATIVE
 * value can never equal one: isValidAddress() then matches the chain's P2PKH
 * prefix only. Used by a chain whose ONLY consensus P2SH prefix is ambiguous with
 * another chain's — WojakCoin's is 5, which is Bitcoin's own '3…' prefix, and it
 * has no second, unambiguous form the way Litecoin does (5 -> 50). The verified
 * value still lives in `scriptHashLegacy`; see the WOJAKCOIN header block.
 *
 * Failing closed is safe: isValidAddress() is leniency-only, and the send path
 * gates on isSpendableAddress(), which rejects EVERY P2SH form on EVERY chain, so
 * a refused P2SH address can never become an unspendable output.
 */
export const NO_ACCEPTED_P2SH = -1;

export interface EvrmoreNetwork {
  /** Legacy electrum-network role ('mainnet'|'testnet'). Kept for the Electrum
   *  server pool + stored-wallet compatibility; NOT the cross-chain identity —
   *  Ravencoin mainnet also carries id:'mainnet'. Use `chainId` to distinguish. */
  id: 'mainnet' | 'testnet';
  /** Canonical cross-chain identity (chain + network). */
  chainId: ChainId;
  /** BIP32 version bytes. */
  bip32: { public: number; private: number };
  /** base58check version byte for P2PKH addresses. */
  pubKeyHash: number;
  /** base58check version byte for P2SH addresses. On a chain that has changed its
   *  P2SH prefix over time this is the CURRENT one (see scriptHashLegacy), and on
   *  a chain whose only P2SH prefix is ambiguous with another chain's it is the
   *  NO_ACCEPTED_P2SH sentinel (WojakCoin). */
  scriptHash: number;
  /** OPTIONAL P2SH version byte that is VERIFIED but deliberately NOT accepted by
   *  address validation: a chain's historical prefix (Litecoin: 5 '3…' -> 50 'M…')
   *  or its only prefix when that value is ambiguous (WojakCoin: 5). Recorded so
   *  the verified value is not lost — see the LITECOIN / WOJAKCOIN header blocks
   *  for the full reasoning (isValidAddress is leniency-only; isSpendableAddress
   *  rejects EVERY P2SH so nothing can be burned; and 5 is Bitcoin's own P2SH
   *  prefix, so honouring it would let Bitcoin '3…' addresses pass as ours). */
  scriptHashLegacy?: number;
  /** base58check version byte for WIF private keys. */
  wif: number;
  /** SLIP-44 coin type used in the BIP44 derivation path. */
  coinType: number;
  /** P2P network magic (first byte) + default port (informational; the wallet
   *  uses Electrum, never the P2P protocol). */
  messageStart: number;
  defaultPort: number;
  /** 3-char asset-marker family prefix appended inside OP_x_ASSET scripts:
   *  'evr' -> markers evrt/evrq/evrr/evro; 'rvn' -> rvnt/rvnq/rvnr/rvno.
   *  UNDEFINED on chains with no Ravencoin-style asset protocol (e.g. BTGS):
   *  use supportsAssets() rather than testing this field directly. */
  assetMarkerPrefix?: 'evr' | 'rvn';
  /** bech32 human-readable part (e.g. 'bcg'). PRESENT only on chains whose segwit
   *  is ACTIVATED; its presence is what enables P2WPKH addresses and BIP143
   *  signing. Undefined => legacy-only chain (Evrmore, Ravencoin, WojakCoin).
   *
   *  SET THIS FROM ACTIVATION, NOT FROM chainparams. A fork can define a bech32
   *  hrp while leaving consensus.SegwitHeight = INT_MAX (never active) — WojakCoin
   *  does exactly that. On such a chain a P2WPKH output is an ANYONE-CAN-SPEND
   *  bare script, so setting this field would make the wallet hand out stealable
   *  receive addresses. See the SEGWIT TRAP block in the WOJAKCOIN header. */
  bech32Hrp?: string;
  /** Address type produced for NEWLY derived receive addresses, which also picks
   *  the BIP44 purpose: 'p2pkh' -> m/44', 'p2wpkh' -> m/84' (BIP84). */
  addressFormat: 'p2pkh' | 'p2wpkh';
  /**
   * Whether TAPROOT (BIP341, witness v1) is ACTIVE on this chain's consensus.
   *
   * This is deliberately separate from bech32Hrp. A chain can ship segwit and a
   * bech32 prefix while taproot is still dormant, and on such a chain a witness
   * v1 output is UNENCUMBERED, i.e. anyone-can-spend: paying to a `…1p…` address
   * there hands the coins to the first miner who notices. It is the same class of
   * trap as WojakCoin's inactive segwit, one version up. Assuming taproot from
   * "has segwit" would therefore be a funds-loss bug on some future chain, so the
   * send path gates on THIS flag and it must be set only from a verified
   * activation in the chain's own consensus rules.
   */
  taprootActive?: boolean;
  /** Bitcoin-style signed-message magic (byte-exact; interoperability-critical). */
  messageMagic: string;
  /** Native-coin ticker symbol. */
  ticker: NativeTicker;
  /** Human-readable chain name (informational; not a user-facing i18n string). */
  displayName: string;
  /**
   * The project's own home page, shown in the UI so a user can tell WHICH project
   * a chain belongs to and go read about it. This is disambiguation, not
   * decoration: "Bitcoin Gold" here is a new Bitcoin Core v30 fork and NOT the
   * 2017 BTG, and several of these tickers collide with better-known coins.
   *
   * MUST be an https origin the wallet can safely open in a new tab. Every entry
   * below was fetched and confirmed to respond before being added; do not add one
   * that has not been checked.
   */
  homepage: string;
  /**
   * Set on a chain whose network is YOUNG and THIN: little mining power, few
   * independent nodes, short history. Drives a marker in the chain list and a
   * caution notice on entering, because the risk is real and not obvious from
   * the UI: such a chain can slow down or stop producing blocks entirely, which
   * strands funds in an unconfirmed state through no fault of the wallet. This
   * is a PROPERTY OF THE NETWORK, not a judgement about the project.
   *
   * Absent means established. Set it for a new chain unless its network is
   * demonstrably mature, and remove it once that stops being true.
   */
  young?: boolean;
}

/** Whether this chain's network is young/thin enough to warrant the caution
 *  marker. Params-driven so the UI never tests a chain id. */
export function isYoungChain(net: EvrmoreNetwork): boolean {
  return net.young === true;
}

/** Alias for the generalised (multi-chain) network type. The `EvrmoreNetwork`
 *  name is retained for the existing callers that import it; new code may prefer
 *  `ChainNetwork`. Both are the same shape. */
export type ChainNetwork = EvrmoreNetwork;

export const EVRMORE_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  chainId: 'evrmore-mainnet',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 33,
  scriptHash: 92,
  wif: 128,
  coinType: 175,
  messageStart: 0x45,
  defaultPort: 8820,
  assetMarkerPrefix: 'evr',
  addressFormat: 'p2pkh',
  messageMagic: 'Evrmore Signed Message:\n',
  ticker: 'EVR',
  displayName: 'Evrmore',
  homepage: 'https://evrmore.com', // verified 2026-08-14
};

export const EVRMORE_TESTNET: EvrmoreNetwork = {
  id: 'testnet',
  chainId: 'evrmore-testnet',
  bip32: { public: 0x043587cf, private: 0x04358394 },
  pubKeyHash: 111,
  scriptHash: 196,
  wif: 239,
  coinType: 1,
  messageStart: 0x45,
  defaultPort: 18820,
  assetMarkerPrefix: 'evr',
  addressFormat: 'p2pkh',
  messageMagic: 'Evrmore Signed Message:\n',
  ticker: 'EVR',
  displayName: 'Evrmore Testnet',
  homepage: 'https://evrmore.com', // same project as mainnet
};

// Ravencoin mainnet. `id:'mainnet'` keeps the Electrum-network role identical to
// Evrmore mainnet (asset-aware ElectrumX, same method dialect); `chainId`
// distinguishes it. Every value verified vs RavenProject/Ravencoin master (see
// the header block above for exact source lines).
export const RAVENCOIN_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  chainId: 'ravencoin-mainnet',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 }, // chainparams.cpp:198/199
  pubKeyHash: 60, // chainparams.cpp:195 -> 'R'
  scriptHash: 122, // chainparams.cpp:196
  wif: 128, // chainparams.cpp:197
  coinType: 175, // chainparams.cpp:202 (SLIP-44, shared with Evrmore)
  messageStart: 0x52, // chainparams.cpp:177 pchMessageStart[0] = 0x52 ('R' of "RAVN")
  defaultPort: 8767, // chainparams.cpp:181
  assetMarkerPrefix: 'rvn', // assets.cpp transfer marker RVN_R/V/N/T -> "rvnt"
  addressFormat: 'p2pkh',
  messageMagic: 'Raven Signed Message:\n', // validation.cpp:129
  ticker: 'RVN',
  displayName: 'Ravencoin',
  homepage: 'https://ravencoin.org', // verified 2026-08-14
};

// Bitcoin Gold (BTGS) mainnet. `id:'mainnet'` keeps the Electrum server ROLE,
// but unlike Evrmore/Ravencoin this is a PLAIN (non-asset) ElectrumX chain with
// NATIVE SEGWIT, so it carries bech32Hrp and addressFormat 'p2wpkh'. Every value
// is from BTGSCOINDEV/BTGS src/kernel/chainparams.cpp (see the header block).
export const BITCOINGOLD_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  chainId: 'bitcoingold-mainnet',
  bip32: { public: 0x0488b21f, private: 0x0488ade5 }, // NON-STANDARD, see header
  pubKeyHash: 38, // -> 'G'
  // BORROWED PREFIX, SO IT FAILS CLOSED. chainparams.cpp really does say
  // SCRIPT_ADDRESS 22, but Dogecoin has used 22 since 2013 and this chain is a
  // 2026 fork, so a '9…'/'A…' string is overwhelmingly more likely to be a
  // Dogecoin address than a BTGS one. Same directional rule, and the same
  // shape, as WojakCoin vs Bitcoin's 5: the owner accepts, the borrower does
  // not. The real value stays in scriptHashLegacy so provenance is not lost and
  // the address-script deny-list still refuses it.
  scriptHash: NO_ACCEPTED_P2SH,
  scriptHashLegacy: 22, // SCRIPT_ADDRESS (verified; deliberately not validated)
  wif: 176,
  coinType: 18888, // project-supplied SLIP-44 (not in chainparams.cpp)
  messageStart: 0x42,
  defaultPort: 18888,
  // assetMarkerPrefix intentionally omitted: BTGS has no asset protocol.
  bech32Hrp: 'bcg',
  addressFormat: 'p2wpkh', // segwit active from genesis; receive addrs are bcg1…
  messageMagic: 'Bitcoin Signed Message:\n', // src/common/signmessage.cpp
  ticker: 'BTGS',
  // "Bitcoin Gold S" (the project's own name), NOT "Bitcoin Gold": the trailing S
  // is what separates this new chain from the 2017 BTG it would otherwise be
  // mistaken for. Owner-specified 2026-08-14. Every user-facing label reads this
  // field, so this literal is the only place the name is spelled out.
  displayName: 'Bitcoin Gold S',
  taprootActive: true, // chainparams.cpp: DEPLOYMENT_TAPROOT = ALWAYS_ACTIVE
  // Verified 2026-08-14. Shown prominently BECAUSE the name is close to the
  // 2017 Bitcoin Gold (BTG): this is a different, newer chain.
  homepage: 'https://bitcoingold.site',
  // Genesis was 2026; the chain was at ~14,000 blocks in August 2026 and had
  // stopped producing them for hours at a time, leaving real deposits stuck as
  // unconfirmed. Exactly the condition this flag exists to warn about.
  young: true,
};

// Litecoin mainnet. Like BTGS this is a PLAIN (non-asset) ElectrumX chain with
// NATIVE SEGWIT, so it carries bech32Hrp + addressFormat 'p2wpkh' and no
// assetMarkerPrefix. UNLIKE BTGS its BIP32 version bytes are the STANDARD Bitcoin
// ones, and its coinType is a real registered SLIP-44 value. `id:'mainnet'` keeps
// the Electrum server ROLE; `chainId` is what identifies the chain. Every value is
// from litecoin-project/litecoin src/chainparams.cpp (see the header block).
export const LITECOIN_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  chainId: 'litecoin-mainnet',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 }, // STANDARD, not BTGS's 1F/E5
  pubKeyHash: 48, // -> 'L'
  scriptHash: 50, // SCRIPT_ADDRESS2 -> 'M' (current P2SH form)
  scriptHashLegacy: 5, // SCRIPT_ADDRESS -> '3' (historical; not validated, see header)
  wif: 176,
  coinType: 2, // SLIP-44 (satoshilabs/slips slip-0044.md)
  messageStart: 0xfb, // pchMessageStart[0] of fb,c0,b6,db
  defaultPort: 9333,
  // assetMarkerPrefix intentionally omitted: Litecoin has no asset protocol (its
  // ElectrumX errors on blockchain.asset.get_meta — verified live).
  bech32Hrp: 'ltc',
  addressFormat: 'p2wpkh', // segwit active on mainnet; receive addrs are ltc1…
  messageMagic: 'Litecoin Signed Message:\n', // src/util/message.cpp MESSAGE_MAGIC
  ticker: 'LTC',
  displayName: 'Litecoin',
  taprootActive: true, // chainparams.cpp: taproot nStartHeight 2161152, long since active (tip > 3.1M)
  homepage: 'https://litecoin.org', // verified 2026-08-14
};

// WojakCoin mainnet. A PLAIN (non-asset) ElectrumX chain like BTGS and Litecoin,
// but LEGACY-ONLY: its chainparams define bech32_hrp "wj" while SegwitHeight is
// INT_MAX (never activated), so `bech32Hrp` is intentionally ABSENT and receive
// addresses stay P2PKH at m/44'/20760'/0'/0/0. Read the SEGWIT TRAP block in the
// WOJAKCOIN header before changing anything here — adding the hrp would make this
// wallet issue anyone-can-spend `wj1…` addresses. `id:'mainnet'` is the Electrum
// server ROLE (as for RVN/BTGS/LTC); `chainId` is the identity. Every value is
// from WojakCoinProj/wojakcore src/chainparams.cpp (see the header block).
export const WOJAKCOIN_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  chainId: 'wojakcoin-mainnet',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 }, // STANDARD, not BTGS's 1F/E5
  pubKeyHash: 73, // PUBKEY_ADDRESS -> 'W'
  // SCRIPT_ADDRESS is 5, i.e. BITCOIN'S OWN '3…' P2SH prefix. Accepting it would
  // let every Bitcoin P2SH address validate as WojakCoin, and unlike Litecoin
  // there is no unambiguous second prefix, so validation accepts NO P2SH form.
  scriptHash: NO_ACCEPTED_P2SH,
  scriptHashLegacy: 5, // SCRIPT_ADDRESS (verified; deliberately not validated)
  wif: 201, // SECRET_KEY
  coinType: 20760, // SLIP-44 (satoshilabs/slips slip-0044.md: "20760 | WJK")
  // pchMessageStart was NOT part of the verified parameter set and is NOT guessed
  // here. It is informational only (this wallet speaks Electrum, never the P2P
  // protocol), so 0 records "unknown" rather than fabricating a magic byte.
  messageStart: 0x00,
  defaultPort: 20759, // nDefaultPort
  // assetMarkerPrefix intentionally omitted: WojakCoin has no asset protocol
  // (verified live — its ElectrumX servers are plain, no asset dialect).
  // bech32Hrp INTENTIONALLY OMITTED even though chainparams defines "wj":
  // consensus.SegwitHeight = INT_MAX, so segwit is never active and a wj1…
  // (P2WPKH) output would be anyone-can-spend. DO NOT ADD IT.
  addressFormat: 'p2pkh', // legacy chain -> BIP44 purpose 44'
  messageMagic: 'Bitcoin Signed Message:\n', // src/util/message.cpp MESSAGE_MAGIC
  ticker: 'WJK',
  displayName: 'WojakCoin',
  // The site itself sits behind a Cloudflare challenge that refuses automated
  // requests, so it could not be fetch-verified. The DOMAIN is confirmed as the
  // project's own: its ElectrumX servers run on electrum{1,2}.wojakcoin.cash.
  homepage: 'https://wojakcoin.cash',
  // Small, young network with a short history and no block explorer we could
  // verify, so a user has no independent way to check a transaction here.
  young: true,
};

// Bitcoin mainnet. A PLAIN (non-asset) ElectrumX chain with NATIVE SEGWIT, so it
// carries bech32Hrp 'bc' + addressFormat 'p2wpkh' and no assetMarkerPrefix —
// structurally the same shape as BTGS and Litecoin. It is registered LAST but is
// the chain the others forked FROM: the BIP32 version bytes, SECRET_KEY 128 and
// the message magic below are the ORIGINALS (see the header block, and note that
// BTGS's 0x0488B21F/0x0488ADE5 is a deviation from these, never the reverse).
// `id:'mainnet'` is the Electrum server ROLE (as for RVN/BTGS/LTC/WJK); `chainId`
// is the identity. Every value is from bitcoin/bitcoin src/kernel/chainparams.cpp.
export const BITCOIN_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  chainId: 'bitcoin-mainnet',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 }, // THE canonical xpub/xprv bytes
  pubKeyHash: 0, // PUBKEY_ADDRESS -> '1'
  // SCRIPT_ADDRESS 5 -> '3'. Kept as a REAL accepted prefix (no NO_ACCEPTED_P2SH):
  // 5 legitimately belongs to this chain, so the cross-chain ambiguity that makes
  // Litecoin/WojakCoin fail closed simply does not apply in this direction.
  // isSpendableAddress still refuses every P2SH — see the header block.
  scriptHash: 5,
  wif: 128, // SECRET_KEY
  coinType: 0, // SLIP-44 (satoshilabs/slips slip-0044.md) — the canonical Bitcoin entry
  messageStart: 0xf9, // pchMessageStart[0] of f9,be,b4,d9
  defaultPort: 8333, // nDefaultPort
  // assetMarkerPrefix intentionally omitted: Bitcoin has no asset protocol
  // (verified live — its ElectrumX servers are plain, no asset dialect).
  bech32Hrp: 'bc',
  addressFormat: 'p2wpkh', // segwit active on mainnet; receive addrs are bc1…
  messageMagic: 'Bitcoin Signed Message:\n', // src/common/signmessage.cpp MESSAGE_MAGIC
  ticker: 'BTC',
  displayName: 'Bitcoin',
  taprootActive: true, // activated at block 709632 (BIP341); chainparams cites 711648 as taproot activation + window
  homepage: 'https://bitcoin.org', // verified 2026-08-14 (responds; the project's own site)
};

// Dogecoin mainnet. A PLAIN (non-asset) ElectrumX chain that is LEGACY-ONLY like
// WojakCoin, but for a different reason worth keeping straight: WojakCoin defines
// an hrp while never activating segwit (SegwitHeight = INT_MAX), whereas Dogecoin
// disables the segwit DEPLOYMENT outright (nTimeout = 0) and defines no hrp at
// all. Either way the consequence is identical — a P2WPKH output would be
// anyone-can-spend — so `bech32Hrp` is absent and receive addresses stay P2PKH at
// m/44'/3'/0'/0/0. Its BIP32 version bytes are NON-STANDARD ("dgub"/"dgpv") the
// way BTGS's are non-standard, affecting only xpub/xprv serialization.
// `id:'mainnet'` is the Electrum server ROLE (as for RVN/BTGS/LTC/WJK/BTC);
// `chainId` is the identity. Every value is from dogecoin/dogecoin
// src/chainparams.cpp (see the DOGECOIN header block).
export const DOGECOIN_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  chainId: 'dogecoin-mainnet',
  bip32: { public: 0x02facafd, private: 0x02fac398 }, // NON-STANDARD "dgub"/"dgpv", see header
  pubKeyHash: 30, // PUBKEY_ADDRESS -> 'D'
  // SCRIPT_ADDRESS 22 -> '9…'/'A…'. Kept as a REAL accepted prefix: 22 is
  // Dogecoin's own (since 2013); BTGS is the later chain that adopted the same
  // byte, so the directional fail-closed rule (see the header) does not apply
  // here. isSpendableAddress still refuses every P2SH on every chain.
  scriptHash: 22,
  wif: 158, // SECRET_KEY
  coinType: 3, // SLIP-44 (satoshilabs/slips slip-0044.md: "| 3 | DOGE | Dogecoin |")
  messageStart: 0xc0, // pchMessageStart[0] of c0,c0,c0,c0
  defaultPort: 22556, // nDefaultPort
  // assetMarkerPrefix intentionally omitted: Dogecoin has no asset protocol
  // (verified live — its ElectrumX servers reject the asset dialect).
  // bech32Hrp INTENTIONALLY OMITTED: DEPLOYMENT_SEGWIT.nTimeout = 0, so segwit
  // never activates and a P2WPKH output would be anyone-can-spend. DO NOT ADD IT.
  addressFormat: 'p2pkh', // legacy chain -> BIP44 purpose 44'
  messageMagic: 'Dogecoin Signed Message:\n', // src/validation.cpp strMessageMagic
  ticker: 'DOGE',
  displayName: 'Dogecoin',
  homepage: 'https://dogecoin.com', // verified 2026-08-15 (HTTP 200; the project's own site)
  // NOT young: mainnet since 2013, tip past 6.3M blocks, deep independent mining.
};

/** Asset script opcode (OP_EVR_ASSET / OP_RVN_ASSET); marks an asset
 *  transfer/issuance output. Both chains use the SAME value 0xc0. */
export const OP_EVR_ASSET = 0xc0;

/** True when the chain implements the Ravencoin-style asset protocol, i.e. its
 *  ElectrumX speaks the asset dialect (get_balance(sh,true), listunspent(sh,asset),
 *  blockchain.asset.*) and OP_x_ASSET outputs are meaningful. FALSE for plain
 *  Bitcoin-derived chains such as BTGS, whose servers REJECT those calls. */
export function supportsAssets(net: EvrmoreNetwork): boolean {
  return net.assetMarkerPrefix !== undefined;
}

/** True when the chain has native segwit, i.e. P2WPKH addresses and BIP143
 *  signing are available. Drives the generic segwit paths in keys/txBuilder, so
 *  a future bech32 chain only needs bech32Hrp set, not new code. */
export function supportsSegwit(net: EvrmoreNetwork): boolean {
  return net.bech32Hrp !== undefined;
}

/** True when the chain can safely receive a TAPROOT (witness v1) payment, i.e.
 *  taproot is active in its consensus. NEVER infer this from segwit: see the
 *  taprootActive field for why that would burn funds on a chain where v1 is
 *  still unencumbered. */
export function supportsTaproot(net: EvrmoreNetwork): boolean {
  return net.taprootActive === true && supportsSegwit(net);
}

/**
 * TRUE when two chains derive the SAME key material from one seed/secret, i.e.
 * the same recovery phrase yields the SAME private key -> the SAME hash160 on
 * both, so the two addresses differ only by their version byte and are publicly
 * LINKABLE (anyone who learns one can compute the other).
 *
 * Definition (computed from the params, never a hardcoded chain pair):
 *   equal coinType  — the BIP44/BIP84 derivation path's coin index, AND
 *   equal bip32 version bytes — the master-key serialization the tree starts from.
 * Today that makes exactly Evrmore <-> Ravencoin true (both coinType 175, both
 * 0x0488B21E/0x0488ADE4). Bitcoin (0), Litecoin (2), Dogecoin (3), Bitcoin Gold
 * (18888) and WojakCoin (20760) each have their own coin type, so none is linkable this way —
 * and adding a future chain that reuses another's coin type will start returning
 * true here with no code change. Note that four of the six chains DO share
 * Bitcoin's BIP32 version bytes; that alone is not a link, because the coin index
 * still separates their derivation paths.
 *
 * Deliberately NOT part of the test: `addressFormat` (which picks purpose 44' vs
 * 84'). A differing purpose would in fact yield different keys, so including it
 * could only turn a `true` into a `false` — i.e. SUPPRESS a privacy warning. This
 * predicate is used to decide whether to WARN the user, so it must fail toward
 * over-warning, never under-warning. (Same reason it is reflexive: a chain always
 * shares derivation with itself, and unknown ids resolve to the EVRMORE_MAINNET
 * fallback rather than to "no link".)
 */
export function chainsShareDerivation(a: ChainId | string, b: ChainId | string): boolean {
  const na = networkFor(a as ChainId);
  const nb = networkFor(b as ChainId);
  return (
    na.coinType === nb.coinType &&
    na.bip32.public === nb.bip32.public &&
    na.bip32.private === nb.bip32.private
  );
}

/** The chain's asset-marker prefix, or a hard failure on a chain that has none.
 *  Asset code paths must be gated by supportsAssets() before calling this. */
export function assetMarkerPrefixOf(net: EvrmoreNetwork): 'evr' | 'rvn' {
  if (!net.assetMarkerPrefix) {
    throw new Error(`${net.displayName} has no asset protocol`);
  }
  return net.assetMarkerPrefix;
}

/** BIP44 account path, e.g. m/44'/175'/0'/0/0. */
export function bip44Path(net: EvrmoreNetwork, account: number, change: 0 | 1, index: number): string {
  return `m/44'/${net.coinType}'/${account}'/${change}/${index}`;
}

/**
 * Derivation path for the chain's OWN address format: BIP44 (m/44'/…) for legacy
 * P2PKH chains, BIP84 (m/84'/…) for native-segwit chains. Keeping the purpose
 * tied to addressFormat is what lets a new bech32 chain drop in without touching
 * derivation code.
 */
export function derivationPath(
  net: EvrmoreNetwork,
  account: number,
  change: 0 | 1,
  index: number,
): string {
  const purpose = net.addressFormat === 'p2wpkh' ? 84 : 44;
  return `m/${purpose}'/${net.coinType}'/${account}'/${change}/${index}`;
}

/**
 * Resolve a network from either a legacy id ('mainnet'|'testnet', which mean the
 * EVRMORE mainnet/testnet for backwards compatibility) or a canonical ChainId.
 * Unknown values fall back to EVRMORE_MAINNET (fail safe: the historical default).
 */
export function networkFor(id: ChainId | EvrmoreNetwork['id']): EvrmoreNetwork {
  switch (id) {
    case 'ravencoin-mainnet':
      return RAVENCOIN_MAINNET;
    case 'bitcoingold-mainnet':
      return BITCOINGOLD_MAINNET;
    case 'litecoin-mainnet':
      return LITECOIN_MAINNET;
    case 'wojakcoin-mainnet':
      return WOJAKCOIN_MAINNET;
    case 'bitcoin-mainnet':
      return BITCOIN_MAINNET;
    case 'dogecoin-mainnet':
      return DOGECOIN_MAINNET;
    case 'testnet':
    case 'evrmore-testnet':
      return EVRMORE_TESTNET;
    case 'mainnet':
    case 'evrmore-mainnet':
    default:
      return EVRMORE_MAINNET;
  }
}

// ---------------------------------------------------------------------------
// Per-chain fee policy
//
// MEASURED 2026-08-14 against every chain's OWN ElectrumX server
// (`blockchain.estimatefee [target]` + `blockchain.relayfee`, coin/kB converted
// to sat/byte exactly the way the liveWallet fee path does):
//
//               1blk     2blk     3blk     6blk    10blk    25blk    relayfee
//   BTC         1.00     1.00     0.72     0.47     0.47     0.35    (error)
//   LTC         1.00     1.00     1.00     1.00     1.00     1.00    (error)
//   BTGS        1.04     1.04     1.04     1.04     1.04     1.04     0.10
//   WJK        20.03    20.03    20.03    20.03    20.03    20.03     1.00
//   RVN      1041.02  1041.02  1041.02  1041.02  1041.02  1041.02  1000.00
//   EVR      1626.74  1626.74  1626.74  1626.74  1626.74  1626.74  1000.00
//
// DOGE (added 2026-08-15, probed 2026-08-14 and re-probed 2026-08-15; the
// estimates drift between probes, which is exactly why the floor is static):
//
//   DOGE    50411.47 50411.47     —      967.35     —      967.35   (error: unknown method)
//           (2026-08-14 probe: 2blk 50420, 6blk 801, 25blk 801)
//
// Two facts in that table drove this design:
//
//   1. ONLY Bitcoin returns a real curve. The other five answer one flat number
//      for every target, so a "fast/normal/slow" picker there would be three
//      identical options. feePolicy.buildFeeEstimate() therefore reports
//      `differentiated` so the UI can suppress a choice that does not exist.
//
//   2. THE OLD SINGLE GLOBAL CEILING (1000 sat/byte) WAS A LIVE BUG. Evrmore
//      estimates 1626.74 and Ravencoin 1041.02, so both were being clamped to
//      1000 — which is EXACTLY their measured relay floor. Zero headroom: had
//      either network raised its relay floor above 1000, the wallet would have
//      quietly built transactions the network refuses to relay, turning the
//      anti-drain ceiling into the cause of an outage. Meanwhile 1000 sat/byte
//      on Bitcoin (normal next-block rate: ~1) let a hostile server inflate a
//      fee 1000×. One number cannot serve both, hence a policy PER CHAIN.
//
// Field semantics (all rates are integer sat/byte bigints, like the fee math):
//
//   floorSatPerByte    Rates are never clamped below this. It sits at/above the
//                      chain's OWN measured relay floor so a floored tx still
//                      relays. Where `blockchain.relayfee` was unavailable
//                      (BTC, LTC errored) the protocol default of 1 sat/byte
//                      (Bitcoin Core's DEFAULT_MIN_RELAY_TX_FEE, 1000 sat/kvB)
//                      is used — consistent with every measured estimate on
//                      those chains rounding up to 1 in integer sat/byte.
//   defaultSatPerByte  Used when the server errors or answers -1. Sits ABOVE
//                      every measured estimate for the chain so a fallback-fee
//                      tx actually confirms, while staying a normal-fee value.
//                      (The old global default of 10 sat/byte was BELOW the
//                      EVR/RVN 1000 relay floor — an unrelayable fallback.)
//   ceilingSatPerByte  Anti-drain clamp on the UNTRUSTED server estimate. Set
//                      ~6-10× the measured estimate / relay floor: genuine
//                      headroom for a real network fee rise (exactly what the
//                      old cap lacked), while a hostile estimate stays bounded
//                      to a value-trivial amount for that chain.
//   maxTxFeeSats       INDEPENDENT absolute cap on one transaction's TOTAL fee
//                      (defence-in-depth even if the rate clamp were bypassed).
//                      Per-chain because the old global 100_000_000 sats is one
//                      whole COIN on every chain: a fine bound at 1 EVR, an
//                      absurd one at 1 BTC. Each value covers a worst-case
//                      ~20-input legacy tx (~3,000 bytes) priced at the chain's
//                      own ceiling, so the two guards can never contradict
//                      (feePolicy.test.ts asserts maxTxFeeSats ≥ ceiling × a
//                      typical tx for every chain).
//
// WHY relayfee IS NOT PROBED AT RUNTIME: the relay floor would come from the
// same untrusted server as the estimate, handing a hostile server a fee-RAISING
// lever (claim relayfee = ceiling and every tx pays the maximum). The floor is
// therefore static measured data; the ceiling's headroom covers a genuine floor
// rise, and if a network ever raises its relay floor ABOVE a chain's ceiling
// the fix is a reviewed edit here, never trusting the server.

/** Fee policy for one chain. All rates are integer sat/byte; see the header
 *  block above for the measured data and the reasoning behind each field. */
export interface ChainFeePolicy {
  /** Minimum rate — at/above the chain's measured relay floor (tx must relay). */
  floorSatPerByte: bigint;
  /** Fallback rate when the server has no usable estimate; above every measured
   *  estimate so a fallback-fee tx confirms. Always within [floor, ceiling]. */
  defaultSatPerByte: bigint;
  /** Anti-drain maximum rate for an untrusted server estimate. Never below the
   *  chain's relay floor, with headroom above it (the old global cap had none). */
  ceilingSatPerByte: bigint;
  /** Independent absolute cap on a single transaction's total fee, in sats. */
  maxTxFeeSats: bigint;
}

/** Keyed by ChainId (exhaustive: the compiler rejects a new chain without a
 *  policy). Values chosen from the 2026-08-14 measured table above. */
export const CHAIN_FEE_POLICIES: Record<ChainId, ChainFeePolicy> = {
  // Evrmore: measured estimate 1626.74 flat across targets, relayfee 1000.00.
  'evrmore-mainnet': {
    floorSatPerByte: 1000n, // measured blockchain.relayfee
    defaultSatPerByte: 1650n, // measured flat estimate 1626.74, rounded up
    ceilingSatPerByte: 10_000n, // 10× relay floor ≈ 6× estimate; ~0.023 EVR on a typical 226-B tx
    maxTxFeeSats: 100_000_000n, // 1 EVR — the historical global value, still right for EVR
  },
  // Evrmore testnet: not separately measured; same daemon defaults as mainnet.
  'evrmore-testnet': {
    floorSatPerByte: 1000n,
    defaultSatPerByte: 1650n,
    ceilingSatPerByte: 10_000n,
    maxTxFeeSats: 100_000_000n,
  },
  // Ravencoin: measured estimate 1041.02 flat, relayfee 1000.00.
  'ravencoin-mainnet': {
    floorSatPerByte: 1000n, // measured blockchain.relayfee
    defaultSatPerByte: 1050n, // measured flat estimate 1041.02, rounded up
    ceilingSatPerByte: 10_000n, // 10× relay floor; ~0.023 RVN on a typical tx
    maxTxFeeSats: 100_000_000n, // 1 RVN
  },
  // Bitcoin Gold (BTGS): measured estimate 1.04 flat, relayfee 0.10.
  'bitcoingold-mainnet': {
    floorSatPerByte: 1n, // integer sat/byte minimum already exceeds the 0.10 relay floor
    defaultSatPerByte: 2n, // measured flat estimate 1.04, rounded up
    ceilingSatPerByte: 500n, // ~500× measured; value-trivial on BTGS, bounded all the same
    maxTxFeeSats: 2_000_000n, // 0.02 BTGS ≈ ceiling × ~3-kB worst-case tx, rounded up
  },
  // Litecoin: measured estimate 1.00 flat; relayfee UNAVAILABLE (server errored),
  // so the floor is the 1 sat/byte protocol default, matching every measured target.
  'litecoin-mainnet': {
    floorSatPerByte: 1n,
    defaultSatPerByte: 2n, // above the measured flat 1.00
    ceilingSatPerByte: 500n,
    maxTxFeeSats: 2_000_000n, // 0.02 LTC
  },
  // WojakCoin: measured estimate 20.03 flat, relayfee 1.00.
  'wojakcoin-mainnet': {
    floorSatPerByte: 1n, // measured blockchain.relayfee
    defaultSatPerByte: 25n, // measured flat estimate 20.03, rounded up
    ceilingSatPerByte: 1000n, // ~50× measured; value-trivial on WJK
    maxTxFeeSats: 5_000_000n, // 0.05 WJK ≥ ceiling × ~3-kB worst-case tx
  },
  // Bitcoin: the ONLY chain whose server returned a real curve (1.00 → 0.35
  // across targets); relayfee UNAVAILABLE (errored), so the floor is Bitcoin
  // Core's own 1 sat/vB default minrelaytxfee.
  'bitcoin-mainnet': {
    floorSatPerByte: 1n,
    defaultSatPerByte: 2n, // above every measured target (1-block: 1.00)
    // 500 covers all but the most extreme historical congestion spikes while
    // bounding a hostile server to ~0.001 BTC on a typical tx. The old global
    // cap (1000 sat/byte) allowed ~1000× the measured next-block rate.
    ceilingSatPerByte: 500n,
    maxTxFeeSats: 2_000_000n, // 0.02 BTC — the old global cap here was 1 WHOLE BTC
  },
  // Dogecoin: THE ONLY chain whose server estimates come back BELOW the network's
  // own fee floor, so the floor here comes from the CHAIN PARAMS, never the server.
  //   - The server does not implement blockchain.relayfee at all ("unknown
  //     method"), and its 6/25-block estimates measured 801 sat/byte (2026-08-14)
  //     and 967.35 (2026-08-15) — both under Dogecoin Core's own floor of
  //     RECOMMENDED_MIN_TX_FEE = COIN / 100 per kB (src/policy/policy.h), i.e.
  //     0.01 DOGE/kB = 1000 sat/byte, which is also the DEFAULT_DUST_LIMIT.
  //     Trusting the server would build transactions the network refuses to
  //     relay, so floorSatPerByte pins the params value.
  //   - The 2-block estimate is a different pathology: ~50,412 sat/byte, ~52-63x
  //     the 6-block answer across both probes. Passing that through would price a
  //     "fast" option absurdly, so the ceiling (10x the params floor, the same
  //     headroom ratio as EVR/RVN) clamps it: fast tops out at 10,000 sat/byte,
  //     ~0.0226 DOGE on a typical 226-byte tx — bounded and value-trivial, while
  //     still leaving genuine room above the floor for a real network fee rise.
  'dogecoin-mainnet': {
    floorSatPerByte: 1000n, // RECOMMENDED_MIN_TX_FEE (COIN/100 per kB) from policy.h — NOT server data
    defaultSatPerByte: 1200n, // above the floor and above every measured 6/25-block estimate (801-968)
    ceilingSatPerByte: 10_000n, // 10x params floor; clamps the ~50,412 2-block spike (see above)
    maxTxFeeSats: 100_000_000n, // 1 DOGE ≥ ceiling x ~3-kB worst-case tx (30M); value-trivial on DOGE
  },
};

/** The active chain's fee policy. Total over ChainId, so this cannot miss. */
export function feePolicyFor(net: EvrmoreNetwork): ChainFeePolicy {
  return CHAIN_FEE_POLICIES[net.chainId];
}
