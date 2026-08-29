// Neoxa (NEOX) chain registration — parameter provenance, legacy-only address
// derivation, the Ravencoin asset dialect, and the two prefix overlaps.
//
// Neoxa is the eighth chain. It is wired like Ravencoin (bridge only, no public
// fallback, single asset dialect) and its backend is the owner's own node, which
// is being stood up; until it is, the bridge route answers 404 and the chain
// reads as offline through the ordinary failover path. Nothing here depends on
// that node: this suite is the chain's verification, and it is offline by
// construction.
//
// Four properties make it worth its own suite:
//   1. IT CARRIES THE RAVENCOIN ASSET PROTOCOL, which no chain added since
//      Ravencoin does. src/assets/ is the full suite, src/rpc/assets.cpp exposes
//      the RPCs, OP_NEOX_ASSET is 0xc0, and — the part that is easy to get wrong
//      — the marker macros were REBRANDED while the BYTES were not: assets.h
//      defines NEOX_N 114 / NEOX_E 118 / NEOX_X 110, which is ASCII 'r','v','n'.
//      So the on-wire markers are literally "rvnt"/"rvnq"/"rvnr"/"rvno". That is
//      asserted here against the real script builder, not just as a string field.
//   2. SCRIPT_ADDRESS 122 IS RAVENCOIN'S OWN byte. Neoxa is the 2022 fork, so by
//      the directional ownership rule it fails closed (NO_ACCEPTED_P2SH) exactly
//      as WojakCoin does with Bitcoin's 5 and BTGS with Dogecoin's 22. Both
//      halves are pinned, along with the proof that neither chain can PAY one.
//   3. PUBKEY_ADDRESS 38 IS THE SAME BYTE BTGS USES, and unlike a P2SH overlap
//      this one CANNOT be failed closed: it is each chain's own address format.
//      It is pinned here in BOTH directions as a known, measured property, so
//      that nobody later "discovers" it and tries to fix it by breaking one of
//      the two chains' own address validation.
//   4. STANDARD BIP32 version bytes with a UNIQUE coin type (1668). It is a
//      Ravencoin fork that shares Ravencoin's asset protocol and P2SH prefix and
//      yet shares NO key material with it, which is exactly the distinction
//      chainsShareDerivation exists to make.
//
// No chain-name branching anywhere: capabilities come from supportsAssets() /
// supportsSegwit(), exactly as the send path uses them.

import { beforeEach, describe, expect, it } from 'vitest';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  addressToHash160,
  decodeSegwitAddress,
  decodeWif,
  deriveAddress,
  isP2pkhAddress,
  isSpendableAddress,
  isValidAddress,
  mnemonicToSeed,
  pubkeyToAddress,
  pubkeyToP2pkhAddress,
  pubkeyToP2wpkhAddress,
} from './keys';
import {
  BITCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  DOGECOIN_MAINNET,
  EVRMORE_MAINNET,
  LITECOIN_MAINNET,
  NEOXA_MAINNET,
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  NO_ACCEPTED_P2SH,
  assetMarkerPrefixOf,
  chainsShareDerivation,
  derivationPath,
  isNewChain,
  isYoungChain,
  networkFor,
  supportsAssets,
  supportsSegwit,
  type EvrmoreNetwork,
} from './chainParams';
import { buildTransferAssetScript, decodeAssetScript } from './assetScript';
import { LiveWalletService } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import type { ElectrumClient } from './electrumTypes';

/** Standard BIP39 test mnemonic (public, throwaway — never real funds). */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const b58c = base58check(sha256);

/** The other seven chains, for cross-chain rejection sweeps. */
const OTHER_CHAINS: EvrmoreNetwork[] = [
  EVRMORE_MAINNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  BITCOIN_MAINNET,
  DOGECOIN_MAINNET,
];

// ---------------------------------------------------------------------------
// FIXTURES, and where they came from.
//
// The derived values below were computed INDEPENDENTLY of keys.ts, from raw
// @scure/bip32 + @scure/base with version byte 38 (addresses) and 112 (WIF), so
// they are a second implementation rather than a recording of our own output.
//
// The three REAL addresses were harvested from a real Neoxa mainnet transaction
// page on the project's own explorer
// (https://explorer.neoxa.net/tx/6015158b4ed814d31a16dbdf9810e28a84c33b664b32474878a921dd315d2704,
// the coinbase of block 2,231,300). They are the "does the wallet accept what
// the chain actually uses?" half of the proof; the derived address is the
// "does the chain accept what the wallet produces?" half, and that half was
// confirmed against the project's own backend: assets.neoxa.net answered
// HTTP 200 with {"address":"Gddw…Nzm","neox":{"balance":0,...}} for the derived
// address, while a one-character checksum corruption of it, a real Bitcoin
// address and a real Ravencoin address each came back 404 "Invalid address".
// ---------------------------------------------------------------------------

const NEOX_RECEIVE_0 = 'GddwJKkPxARviA6BmWbuyamqC5kT6SDNzm';
const NEOX_RECEIVE_1 = 'GJFNx3WBhd97QEDAWqeKv3HtaqCT9hQajE';
const NEOX_CHANGE_0 = 'GfZfVnviAHUDZ9NWSozGiH5QR6jexKxTKi';
const NEOX_WIF_0 = 'HiLy8mnLCBbQWRgn2tMFSABuQpU8G4PwnwGbo8HKzgE73JYPndUh';
const NEOX_PUB_0 = '03fa39680a90f5bb6cf25e454ee263d77979325d62cc0ba0cd7816616e12e490fb';

/** Real, on-chain Neoxa addresses read off explorer.neoxa.net (see above). */
const REAL_ONCHAIN_ADDRESSES = [
  'GTbBCJzqRWyFBMrap2fY39eZaXnLnojJ3F',
  'GUN6HinJLSdu2PBSozgRfxDMt4rJZ93zWE',
  'GbtmeetYFahx2sKbsmsVfBHrhQsiJX5b11',
];

describe('NEOXA_MAINNET parameters (NeoxaChain/Neoxa src/chainparams.cpp)', () => {
  it('carries the exact verified base58 values', () => {
    const net = NEOXA_MAINNET;
    expect(net.pubKeyHash).toBe(38); // chainparams.cpp:454 PUBKEY_ADDRESS -> 'G'
    // SCRIPT_ADDRESS 122 is Ravencoin's own byte; Neoxa is the later fork, so it
    // fails closed. The verified value is kept, unvalidated, in scriptHashLegacy.
    expect(net.scriptHash).toBe(NO_ACCEPTED_P2SH);
    expect(net.scriptHashLegacy).toBe(122); // chainparams.cpp:455
    expect(net.wif).toBe(112); // chainparams.cpp:456 SECRET_KEY
    expect(net.coinType).toBe(1668); // chainparams.cpp:461 + SLIP-44 "1668 | NEOX | Neoxa"
    expect(net.defaultPort).toBe(8788); // chainparams.cpp:438
    expect(net.messageStart).toBe(0x47); // chainparams.cpp:434, 'G' of "GAME"
    expect(net.messageMagic).toBe('Neoxa Signed Message:\n'); // src/validation.cpp:119
    expect(net.addressFormat).toBe('p2pkh');
    expect(net.ticker).toBe('NEOX');
    expect(net.displayName).toBe('Neoxa');
    expect(net.chainId).toBe('neoxa-mainnet');
    expect(net.decimals).toBe(8);
    // Electrum server ROLE stays 'mainnet' (like RVN/BTGS/LTC/WJK/BTC/DOGE);
    // chainId is the identity.
    expect(net.id).toBe('mainnet');
    // Mainnet since 2022, tip past 2.2M blocks: not a young/thin network. What
    // this chain is waiting on is its own server, not network maturity, so the
    // caution NOTICE would be the wrong signal, and it is not raised.
    expect(isYoungChain(net)).toBe(false);
    // It IS marked "New" in the chain list, because it is new HERE (owner,
    // 2026-08-26). That is the whole reason the two flags are separate: the
    // label is about this wallet, the warning is a claim about the network,
    // and reusing one for the other would have told users something false
    // about a chain that has been running for years.
    expect(isNewChain(net)).toBe(true);
    expect(net.recentlyAdded).toBe(true);
  });

  it("carries the STANDARD BIP32 bytes — Bitcoin's, not BTGS's and not Dogecoin's", () => {
    // chainparams.cpp:457/458. Pinned in both directions so no future
    // "harmonisation" can move them onto BTGS's 1F/E5 or Dogecoin's dgub/dgpv,
    // and so registering Neoxa cannot have moved anyone else's.
    expect(NEOXA_MAINNET.bip32.public).toBe(0x0488b21e);
    expect(NEOXA_MAINNET.bip32.private).toBe(0x0488ade4);
    expect(NEOXA_MAINNET.bip32.public).toBe(BITCOIN_MAINNET.bip32.public);
    expect(NEOXA_MAINNET.bip32.private).toBe(BITCOIN_MAINNET.bip32.private);
    expect(NEOXA_MAINNET.bip32.public).not.toBe(BITCOINGOLD_MAINNET.bip32.public);
    expect(NEOXA_MAINNET.bip32.public).not.toBe(DOGECOIN_MAINNET.bip32.public);
    expect(BITCOINGOLD_MAINNET.bip32.public).toBe(0x0488b21f);
    expect(DOGECOIN_MAINNET.bip32.public).toBe(0x02facafd);
  });

  it('resolves from its canonical chain id', () => {
    expect(networkFor('neoxa-mainnet')).toBe(NEOXA_MAINNET);
    // Adding NEOX must not disturb the existing resolutions. In particular the
    // legacy 'mainnet'/'testnet' ids still mean EVRMORE, not anything newer.
    expect(networkFor('mainnet')).toBe(EVRMORE_MAINNET);
    expect(networkFor('evrmore-mainnet')).toBe(EVRMORE_MAINNET);
    expect(networkFor('testnet')).toBe(networkFor('evrmore-testnet'));
    expect(networkFor('ravencoin-mainnet')).toBe(RAVENCOIN_MAINNET);
    expect(networkFor('bitcoingold-mainnet')).toBe(BITCOINGOLD_MAINNET);
    expect(networkFor('litecoin-mainnet')).toBe(LITECOIN_MAINNET);
    expect(networkFor('wojakcoin-mainnet')).toBe(WOJAKCOIN_MAINNET);
    expect(networkFor('bitcoin-mainnet')).toBe(BITCOIN_MAINNET);
    expect(networkFor('dogecoin-mainnet')).toBe(DOGECOIN_MAINNET);
  });

  it('routes to the BIP44 purpose with coin type 1668', () => {
    expect(derivationPath(NEOXA_MAINNET, 0, 0, 0)).toBe("m/44'/1668'/0'/0/0");
    expect(derivationPath(NEOXA_MAINNET, 0, 1, 7)).toBe("m/44'/1668'/0'/1/7");
  });

  it('shares derivation with NO other chain, Ravencoin included', () => {
    // The point of this one: Neoxa is a Ravencoin FORK and carries Ravencoin's
    // asset protocol and Ravencoin's P2SH prefix, so "it must share keys with
    // Ravencoin" is the natural wrong guess. It does not — coinType 1668 vs 175
    // separates the derivation paths — and this predicate is computed from the
    // params, so it says so without being told.
    for (const other of OTHER_CHAINS) {
      expect(chainsShareDerivation('neoxa-mainnet', other.chainId)).toBe(false);
      expect(chainsShareDerivation(other.chainId, 'neoxa-mainnet')).toBe(false);
    }
    // Reflexive, and the existing Evrmore <-> Ravencoin link is untouched.
    expect(chainsShareDerivation('neoxa-mainnet', 'neoxa-mainnet')).toBe(true);
    expect(chainsShareDerivation('evrmore-mainnet', 'ravencoin-mainnet')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The asset protocol. This is the fact that decides what a future ElectrumX for
// this chain has to be, so it is asserted against the real script builder rather
// than trusted as a string field.
// ---------------------------------------------------------------------------
describe('Neoxa carries the Ravencoin asset protocol (the "rvn" marker family)', () => {
  it('is asset-capable, unlike every chain added since Ravencoin', () => {
    expect(supportsAssets(NEOXA_MAINNET)).toBe(true);
    expect(NEOXA_MAINNET.assetMarkerPrefix).toBe('rvn');
    expect(assetMarkerPrefixOf(NEOXA_MAINNET)).toBe('rvn');
    // Unchanged for everyone else: two asset chains before, three now, and the
    // five plain ones still plain.
    expect(supportsAssets(EVRMORE_MAINNET)).toBe(true);
    expect(supportsAssets(RAVENCOIN_MAINNET)).toBe(true);
    for (const plain of [
      BITCOINGOLD_MAINNET,
      LITECOIN_MAINNET,
      WOJAKCOIN_MAINNET,
      BITCOIN_MAINNET,
      DOGECOIN_MAINNET,
    ]) {
      expect(supportsAssets(plain)).toBe(false);
    }
  });

  it('emits BYTE-IDENTICAL "rvnt" transfer scripts, because the macros were renamed and the bytes were not', () => {
    // src/assets/assets.h:21-26 defines NEOX_N 114, NEOX_E 118, NEOX_X 110 —
    // ASCII 'r','v','n' — and assets.cpp pushes them in the order N,E,X + type.
    // So a Neoxa transfer output carries the same four bytes a Ravencoin one
    // does. Proven end to end: build with Neoxa's prefix, decode with
    // Ravencoin's, and get the same script Ravencoin itself would build.
    const script = buildTransferAssetScript(
      NEOX_RECEIVE_0,
      'TESTASSET',
      12_345n,
      assetMarkerPrefixOf(NEOXA_MAINNET),
    );
    const hex = bytesToHex(script);
    // 0xc0 is OP_NEOX_ASSET (src/script/script.h:185) — the same value as
    // OP_EVR_ASSET / OP_RVN_ASSET.
    expect(hex).toContain('c0');
    // "rvnt" = 72 76 6e 74.
    expect(hex).toContain('72766e74');
    const decoded = decodeAssetScript(script, 'rvn');
    expect(decoded).not.toBeNull();
    expect(decoded?.transfer?.name).toBe('TESTASSET');
    expect(decoded?.transfer?.amount).toBe(12_345n);
    expect(decoded?.transfer?.kind).toBe('transfer');
    expect(decoded?.markerPrefix).toBe('rvn');
    // And it is genuinely the 'rvn' family, not the 'evr' one: decoding with the
    // wrong family fails closed, which is what stops a prevout from the wrong
    // chain being spent.
    expect(decodeAssetScript(script, 'evr')).toBeNull();
  });

  it('builds the same asset script Ravencoin would, from the same hash160', () => {
    // Same hash160 under both chains' builders -> identical bytes, because the
    // marker family is the same. This is the concrete form of "single dialect":
    // a server that can serve Ravencoin's asset calls can serve Neoxa's shape.
    const { hash } = addressToHash160(NEOX_RECEIVE_0);
    const rvnAddress = b58c.encode(concatBytes(Uint8Array.of(RAVENCOIN_MAINNET.pubKeyHash), hash));
    const fromNeox = buildTransferAssetScript(NEOX_RECEIVE_0, 'A', 1n, 'rvn');
    const fromRvn = buildTransferAssetScript(rvnAddress, 'A', 1n, 'rvn');
    expect(bytesToHex(fromNeox)).toBe(bytesToHex(fromRvn));
  });
});

// ---------------------------------------------------------------------------
// No bech32 address form. NOTE this is NOT the WojakCoin/Dogecoin trap and the
// comment must not drift into calling it one: chainparams.cpp:374 really does set
// consensus.nSegwitEnabled = true and validation.cpp gates SCRIPT_VERIFY_WITNESS
// on it, so witness rules ARE enforced. The reason there is no segwit address is
// that the chain defines no bech32_hrp and the tree contains no bech32 encoder at
// all, so there is nothing to encode to.
// ---------------------------------------------------------------------------
describe('Neoxa has no bech32 address form — legacy P2PKH only', () => {
  it('declares no bech32Hrp, so supportsSegwit() is false', () => {
    expect(NEOXA_MAINNET.bech32Hrp).toBeUndefined();
    expect(supportsSegwit(NEOXA_MAINNET)).toBe(false);
    expect(NEOXA_MAINNET.taprootActive).toBeUndefined();
    // Unchanged for the chains that really do have activated segwit.
    expect(supportsSegwit(BITCOIN_MAINNET)).toBe(true);
    expect(supportsSegwit(LITECOIN_MAINNET)).toBe(true);
    expect(supportsSegwit(BITCOINGOLD_MAINNET)).toBe(true);
  });

  it('produces NO bech32 address for a key — every form is base58 P2PKH', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, NEOXA_MAINNET, 0, 0, 0);
    expect(derived.address.startsWith('G')).toBe(true);
    expect(decodeSegwitAddress(derived.address)).toBeNull();
    // The chain-format-aware encoder agrees (it reads addressFormat, not a name).
    expect(pubkeyToAddress(derived.publicKey, NEOXA_MAINNET)).toBe(derived.address);
    expect(pubkeyToP2pkhAddress(derived.publicKey, NEOXA_MAINNET)).toBe(derived.address);
    // And asking for a segwit address outright is a hard error.
    expect(() => pubkeyToP2wpkhAddress(derived.publicKey, NEOXA_MAINNET)).toThrow(/no segwit/i);
  });

  it('REJECTS well-formed bech32 recipients on Neoxa', () => {
    // The canonical BIP173 example is a checksum-valid, genuinely decodable
    // P2WPKH address, so the rejection is proven to come from "this chain has no
    // segwit address form", not from a malformed string.
    const bc1 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    expect(decodeSegwitAddress(bc1)).not.toBeNull();
    expect(isSpendableAddress(bc1, NEOXA_MAINNET)).toBe(false);
    expect(isValidAddress(bc1, NEOXA_MAINNET)).toBe(false);
  });
});

describe('Neoxa address derivation', () => {
  it("reproduces the OFFICIAL BIP44 Bitcoin vector through the same params object (version bytes don't change keys)", async () => {
    // Independent anchor: proves the 44' purpose selection + base58check
    // encoding against a PUBLISHED standard vector rather than our own output.
    // This object still carries Neoxa's asset prefix and P2SH sentinel, yet with
    // coinType 0 + pubKeyHash 0 + wif 128 it must yield the exact published
    // Bitcoin address.
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const asBitcoin: EvrmoreNetwork = { ...NEOXA_MAINNET, coinType: 0, pubKeyHash: 0, wif: 128 };
    const derived = deriveAddress(seed, asBitcoin, 0, 0, 0);
    expect(derived.path).toBe("m/44'/0'/0'/0/0");
    expect(bytesToHex(derived.publicKey)).toBe(
      '03aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e',
    );
    expect(derived.address).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  });

  it("derives a 'G…' receive address at m/44'/1668'/0'/0/0", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, NEOXA_MAINNET, 0, 0, 0);
    expect(derived.path).toBe("m/44'/1668'/0'/0/0");
    expect(bytesToHex(derived.publicKey)).toBe(NEOX_PUB_0);
    expect(derived.address).toBe(NEOX_RECEIVE_0);
    // Version byte 38 is what makes it a 'G' address.
    expect(addressToHash160(derived.address).version).toBe(38);
    expect(isP2pkhAddress(derived.address, NEOXA_MAINNET)).toBe(true);
    expect(isValidAddress(derived.address, NEOXA_MAINNET)).toBe(true);
    // Second receive index and the change branch, same independent provenance.
    const receive1 = deriveAddress(seed, NEOXA_MAINNET, 0, 0, 1);
    expect(receive1.path).toBe("m/44'/1668'/0'/0/1");
    expect(receive1.address).toBe(NEOX_RECEIVE_1);
    const change0 = deriveAddress(seed, NEOXA_MAINNET, 0, 1, 0);
    expect(change0.path).toBe("m/44'/1668'/0'/1/0");
    expect(change0.address).toBe(NEOX_CHANGE_0);
  });

  it('encodes WIF with SECRET_KEY 112', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, NEOXA_MAINNET, 0, 0, 0);
    // Independent fixture (same provenance as the addresses above). Version byte
    // 112 is what makes a compressed Neoxa WIF start with 'H'.
    expect(derived.wif).toBe(NEOX_WIF_0);
    expect(derived.wif.startsWith('H')).toBe(true);
    const payload = b58c.decode(derived.wif);
    expect(payload[0]).toBe(112); // base58Prefixes[SECRET_KEY]
    const { privateKey, compressed } = decodeWif(derived.wif);
    expect(compressed).toBe(true);
    expect(privateKey).toEqual(derived.privateKey);
  });

  it('derives DIFFERENT key material than every other chain (coin type 1668)', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const neox = deriveAddress(seed, NEOXA_MAINNET, 0, 0, 0);
    for (const other of OTHER_CHAINS) {
      const derived = deriveAddress(seed, other, 0, 0, 0);
      expect(bytesToHex(neox.privateKey)).not.toBe(bytesToHex(derived.privateKey));
    }
  });

  it('accepts REAL on-chain Neoxa addresses read off the project explorer', () => {
    // The other half of the derivation proof. These three were harvested from a
    // real mainnet transaction page on explorer.neoxa.net (see the fixture note
    // above): if our params were wrong, addresses the chain actually uses would
    // not validate here.
    for (const address of REAL_ONCHAIN_ADDRESSES) {
      expect(addressToHash160(address).version).toBe(38);
      expect(isValidAddress(address, NEOXA_MAINNET)).toBe(true);
      expect(isP2pkhAddress(address, NEOXA_MAINNET)).toBe(true);
      // And they are payable, which is the property that actually matters.
      expect(isSpendableAddress(address, NEOXA_MAINNET)).toBe(true);
    }
  });
});

describe('isSpendableAddress on Neoxa (send-path safety gate)', () => {
  it('accepts its own P2PKH address', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const neox = deriveAddress(seed, NEOXA_MAINNET, 0, 0, 0).address;
    expect(isSpendableAddress(neox, NEOXA_MAINNET)).toBe(true);
  });

  it('rejects every other chain\'s DERIVED address as a Neoxa recipient', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    for (const other of OTHER_CHAINS) {
      const foreign = deriveAddress(seed, other, 0, 0, 0).address;
      expect(isSpendableAddress(foreign, NEOXA_MAINNET)).toBe(false);
      expect(isValidAddress(foreign, NEOXA_MAINNET)).toBe(false);
    }
  });

  it('is rejected in the other direction on every existing chain EXCEPT Bitcoin Gold', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const neox = deriveAddress(seed, NEOXA_MAINNET, 0, 0, 0).address;
    for (const other of OTHER_CHAINS) {
      // BTGS ships the SAME PUBKEY_ADDRESS byte (38), so a Neoxa 'G…' address is
      // byte-for-byte a well-formed BTGS P2PKH address and no address-only check
      // can say otherwise. That exception is asserted POSITIVELY in the dedicated
      // overlap suite below rather than quietly skipped here, and the reason it
      // cannot be failed closed is written out in the NEOXA header block of
      // chainParams.ts. Everything else is refused.
      if (other === BITCOINGOLD_MAINNET) continue;
      expect(isSpendableAddress(neox, other)).toBe(false);
      expect(isValidAddress(neox, other)).toBe(false);
    }
    // Pinned explicitly so the skip above can never silently widen: BTGS is the
    // ONLY chain that accepts it, and it accepts it for exactly this reason.
    expect(isValidAddress(neox, BITCOINGOLD_MAINNET)).toBe(true);
    expect(BITCOINGOLD_MAINNET.pubKeyHash).toBe(NEOXA_MAINNET.pubKeyHash);
  });

  it("never accepts a 122-prefix P2SH — that byte is Ravencoin's, and Neoxa is the later fork", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const h160 = addressToHash160(deriveAddress(seed, NEOXA_MAINNET, 0, 0, 0).address).hash;
    const p2sh122 = b58c.encode(concatBytes(Uint8Array.of(122), h160));
    expect(addressToHash160(p2sh122).version).toBe(122);

    // Neoxa's chainparams really does say SCRIPT_ADDRESS 122, and the value is
    // recorded — it is just not validated, because honouring it would make every
    // Ravencoin P2SH address validate as Neoxa. Same directional rule, same
    // shape, as WojakCoin vs Bitcoin's 5 and BTGS vs Dogecoin's 22.
    expect(NEOXA_MAINNET.scriptHashLegacy).toBe(122);
    expect(isValidAddress(p2sh122, NEOXA_MAINNET)).toBe(false);
    // …while it still validates (and is still never payable) on Ravencoin, whose
    // prefix it is. Registering Neoxa must not have changed that.
    expect(RAVENCOIN_MAINNET.scriptHash).toBe(122);
    expect(isValidAddress(p2sh122, RAVENCOIN_MAINNET)).toBe(true);
    expect(isSpendableAddress(p2sh122, RAVENCOIN_MAINNET)).toBe(false);

    // What keeps the overlap harmless either way: the SEND path gates on
    // isSpendableAddress, which rejects EVERY P2SH form on EVERY chain — the
    // builder cannot construct a P2SH output at all.
    expect(isSpendableAddress(p2sh122, NEOXA_MAINNET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The PUBKEY_ADDRESS 38 overlap with Bitcoin Gold.
//
// Unlike the P2SH overlaps above, this one cannot be failed closed: 38 is how
// BOTH chains write their own addresses, so refusing it on either side would
// refuse that chain's own users. It is pinned here as a KNOWN, MEASURED property
// so that a future reader finds it documented rather than discovering it, and
// does not "fix" it by breaking one of the two chains.
// ---------------------------------------------------------------------------
describe('PUBKEY_ADDRESS 38 is shared with Bitcoin Gold (documented, not fixable)', () => {
  it('uses the same P2PKH version byte as BTGS', () => {
    expect(NEOXA_MAINNET.pubKeyHash).toBe(38);
    expect(BITCOINGOLD_MAINNET.pubKeyHash).toBe(38);
  });

  it('makes a Neoxa address structurally valid on BTGS and vice versa', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const neox = deriveAddress(seed, NEOXA_MAINNET, 0, 0, 0).address;
    // Both directions, stated plainly. The two byte strings are indistinguishable
    // (same version byte, same base58check checksum, same length), so no check
    // that looks only at the address can separate them.
    expect(isValidAddress(neox, BITCOINGOLD_MAINNET)).toBe(true);
    expect(isSpendableAddress(neox, BITCOINGOLD_MAINNET)).toBe(true);

    // The other direction, built explicitly: BTGS's own receive addresses are
    // bech32 (segwit is active there from genesis), so a 'G…' BTGS address has
    // to be constructed to make the point at all — which is itself the first of
    // the three things that bound the risk.
    const btgsDerived = deriveAddress(seed, BITCOINGOLD_MAINNET, 0, 0, 0);
    expect(btgsDerived.address.startsWith('bcg1')).toBe(true);
    const btgsLegacy = pubkeyToP2pkhAddress(btgsDerived.publicKey, BITCOINGOLD_MAINNET);
    expect(btgsLegacy.startsWith('G')).toBe(true);
    expect(isValidAddress(btgsLegacy, NEOXA_MAINNET)).toBe(true);
    expect(isSpendableAddress(btgsLegacy, NEOXA_MAINNET)).toBe(true);
  });

  it('still derives different keys on the two chains, so no wallet owns both', async () => {
    // The second thing that bounds the risk: the coin types differ (1668 vs
    // 18888), so one seed does NOT produce the same hash160 on both. This is a
    // paste-the-wrong-address hazard, never a case of one wallet silently
    // holding the other chain's coins.
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const neox = deriveAddress(seed, NEOXA_MAINNET, 0, 0, 0);
    const btgs = deriveAddress(seed, BITCOINGOLD_MAINNET, 0, 0, 0);
    expect(bytesToHex(neox.publicKey)).not.toBe(bytesToHex(btgs.publicKey));
    expect(chainsShareDerivation('neoxa-mainnet', 'bitcoingold-mainnet')).toBe(false);
    // And the WIF version bytes differ too, so recovering a misdirected payment
    // is a deliberate key import rather than a copy-paste.
    expect(NEOXA_MAINNET.wif).toBe(112);
    expect(BITCOINGOLD_MAINNET.wif).toBe(176);
  });
});

/** Offline stub: registering a wallet derives locally and never hits the network. */
function stubClient(): ElectrumClient {
  return {
    connect: async () => {},
    request: async () => {
      throw new Error('no network access in this test');
    },
    close: () => {},
    isConnected: () => false,
    endpoint: () => null,
  };
}

describe("LiveWalletService with the 'neoxa-mainnet' network id", () => {
  beforeEach(() => {
    setStorageForTests(new MemoryStorageAdapter());
  });

  it('resolves NEOXA_MAINNET and derives the wallet its G address', async () => {
    // netFor()'s `default` arm silently falls back to EVRMORE, so a missing case
    // here would make a Neoxa wallet sign with Evrmore's params rather than
    // fail. That exact bug shipped once, for Dogecoin.
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'neoxa-mainnet', 'NEOX wallet');
    expect(svc.network()).toBe('neoxa-mainnet');
    expect(svc.getAddress(0)).toBe(NEOX_RECEIVE_0);
    expect(svc.getAddress(0)).not.toBe(
      deriveAddress(await mnemonicToSeed(TEST_MNEMONIC), EVRMORE_MAINNET, 0, 0, 0).address,
    );
    expect(decodeSegwitAddress(svc.getAddress(0))).toBeNull();
    // The stored entry keeps the canonical id, so a reload resolves the chain.
    const [entry] = await svc.listWallets();
    expect(entry.network).toBe('neoxa-mainnet');
    expect(entry.address).toBe(NEOX_RECEIVE_0);
  });

  it('signs with the Neoxa magic address and ACCEPTS the asset path (unlike the plain chains)', async () => {
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'neoxa-mainnet', 'NEOX wallet');
    // signMessage uses net.messageMagic; assert the signing address, which is
    // what a verifier checks the signature against.
    expect(svc.signMessage('hello').address).toBe(NEOX_RECEIVE_0);
    // The asset path is gated by supportsAssets(), not by a chain name. On Neoxa
    // it must NOT throw 'assets-not-supported' the way BTC/LTC/DOGE do; it gets
    // past that gate and then fails on the offline stub client, which is the
    // proof that the gate opened.
    // 'Network is offline' comes from the transport, i.e. from AFTER the
    // capability gate; the plain chains never get that far.
    await expect(svc.buildAssetSend(NEOX_RECEIVE_0, 'X', 1n)).rejects.toThrow(/offline|network/i);
    await expect(svc.buildAssetSend(NEOX_RECEIVE_0, 'X', 1n)).rejects.not.toThrow(
      'assets-not-supported',
    );
  });

  it('refuses a foreign-chain recipient before touching the network', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'neoxa-mainnet', 'NEOX wallet');
    for (const other of OTHER_CHAINS) {
      // BTGS is the one chain whose 'G…' legacy form Neoxa cannot refuse (the
      // documented PUBKEY_ADDRESS-38 overlap). It is still refused HERE, because
      // its DERIVED address is bech32 — segwit is active on BTGS from genesis —
      // so this sweep stays total. The overlap suite above covers the hand-built
      // legacy form, which is the only way to reach it.
      const foreign = deriveAddress(seed, other, 0, 0, 0).address;
      await expect(svc.buildEvrSend(foreign, 1000n)).rejects.toThrow('unsupported-address-type');
    }
  });

  it('leaves the existing chains resolving exactly as before', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'mainnet', 'EVR wallet');
    expect(svc.network()).toBe('mainnet');
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address);
    await svc.import(TEST_MNEMONIC, 'pw', 'ravencoin-mainnet', 'RVN wallet');
    expect(svc.network()).toBe('ravencoin-mainnet');
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, RAVENCOIN_MAINNET, 0, 0, 0).address);
    await svc.import(TEST_MNEMONIC, 'pw', 'dogecoin-mainnet', 'DOGE wallet');
    expect(svc.network()).toBe('dogecoin-mainnet');
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 0).address);
  });
});
