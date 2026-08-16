// Dogecoin (DOGE) chain registration — parameter provenance, legacy-only address
// derivation, the disabled-segwit guard, and the P2SH-22 overlap with BTGS.
//
// Dogecoin is the seventh chain. Three properties make it worth its own suite:
//   1. NON-STANDARD BIP32 version bytes ("dgub" 0x02facafd / "dgpv" 0x02fac398),
//      like BTGS but a different, whole-prefix deviation. These must be PINNED in
//      both directions (not Bitcoin's, not BTGS's) so no future "harmonisation"
//      can move them — and the derivation tests prove the claim in the params
//      header that version bytes affect xpub/xprv SERIALIZATION only, never the
//      derived keys.
//   2. SEGWIT IS DISABLED (chainparams.cpp: DEPLOYMENT_SEGWIT.nTimeout = 0, and
//      no bech32_hrp is defined at all). Same funds-loss class as WojakCoin's
//      INT_MAX SegwitHeight: a P2WPKH output on this chain would be
//      anyone-can-spend, so the chain must stay legacy-only and every bech32
//      recipient must be refused.
//   3. SCRIPT_ADDRESS 22 is the SAME byte BTGS ships. Dogecoin has used it since
//      2013 (BTGS is a 2026 fork), so per the directional ownership rule from the
//      BITCOIN header, Dogecoin ACCEPTS its own prefix and BTGS, the borrower,
//      fails closed. Both halves are pinned here, along with the proof that
//      neither chain can actually PAY such an address.
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
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  NO_ACCEPTED_P2SH,
  assetMarkerPrefixOf,
  chainsShareDerivation,
  derivationPath,
  isYoungChain,
  networkFor,
  supportsAssets,
  supportsSegwit,
  type EvrmoreNetwork,
} from './chainParams';
import { LiveWalletService } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import type { ElectrumClient } from './electrumTypes';

/** Standard BIP39 test mnemonic (public, throwaway — never real funds). */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const b58c = base58check(sha256);

/** The other six chains, for cross-chain rejection sweeps. */
const OTHER_CHAINS: EvrmoreNetwork[] = [
  EVRMORE_MAINNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  BITCOIN_MAINNET,
];

describe('DOGECOIN_MAINNET parameters (dogecoin/dogecoin src/chainparams.cpp)', () => {
  it('carries the exact verified base58 values', () => {
    const net = DOGECOIN_MAINNET;
    expect(net.pubKeyHash).toBe(30); // PUBKEY_ADDRESS -> 'D'
    expect(net.scriptHash).toBe(22); // SCRIPT_ADDRESS -> '9…'/'A…' (own prefix, accepted)
    expect(net.scriptHashLegacy).toBeUndefined(); // no historical second prefix
    expect(net.wif).toBe(158); // SECRET_KEY
    expect(net.coinType).toBe(3); // SLIP-44 (satoshilabs/slips slip-0044.md: "| 3 | DOGE |")
    expect(net.defaultPort).toBe(22556); // nDefaultPort
    expect(net.messageStart).toBe(0xc0); // pchMessageStart[0] of c0,c0,c0,c0
    expect(net.messageMagic).toBe('Dogecoin Signed Message:\n'); // src/validation.cpp
    expect(net.addressFormat).toBe('p2pkh');
    expect(net.ticker).toBe('DOGE');
    expect(net.displayName).toBe('Dogecoin');
    expect(net.chainId).toBe('dogecoin-mainnet');
    // Electrum server ROLE stays 'mainnet' (like RVN/BTGS/LTC/WJK/BTC); chainId is the identity.
    expect(net.id).toBe('mainnet');
    // Mainnet since 2013 at 6.3M+ blocks: NOT a young/thin network, so no caution marker.
    expect(isYoungChain(net)).toBe(false);
  });

  it('carries the NON-STANDARD "dgub"/"dgpv" BIP32 bytes — not Bitcoin\'s, not BTGS\'s', () => {
    // Dogecoin's own chainparams.cpp values. A whole-prefix deviation, unlike
    // BTGS's last-byte bump; pinned in both directions so a future "tidy-up"
    // can neither copy Bitcoin's bytes here nor copy these anywhere else.
    expect(DOGECOIN_MAINNET.bip32.public).toBe(0x02facafd);
    expect(DOGECOIN_MAINNET.bip32.private).toBe(0x02fac398);
    expect(DOGECOIN_MAINNET.bip32.public).not.toBe(BITCOIN_MAINNET.bip32.public);
    expect(DOGECOIN_MAINNET.bip32.private).not.toBe(BITCOIN_MAINNET.bip32.private);
    expect(DOGECOIN_MAINNET.bip32.public).not.toBe(BITCOINGOLD_MAINNET.bip32.public);
    expect(DOGECOIN_MAINNET.bip32.private).not.toBe(BITCOINGOLD_MAINNET.bip32.private);
    // And the canonical chains keep the canonical bytes — registering Dogecoin
    // must not have moved anything.
    expect(BITCOIN_MAINNET.bip32.public).toBe(0x0488b21e);
    expect(BITCOIN_MAINNET.bip32.private).toBe(0x0488ade4);
  });

  it('resolves from its canonical chain id', () => {
    expect(networkFor('dogecoin-mainnet')).toBe(DOGECOIN_MAINNET);
    // Adding DOGE must not disturb the existing resolutions. In particular the
    // legacy 'mainnet'/'testnet' ids still mean EVRMORE, not anything newer.
    expect(networkFor('mainnet')).toBe(EVRMORE_MAINNET);
    expect(networkFor('evrmore-mainnet')).toBe(EVRMORE_MAINNET);
    expect(networkFor('testnet')).toBe(networkFor('evrmore-testnet'));
    expect(networkFor('ravencoin-mainnet')).toBe(RAVENCOIN_MAINNET);
    expect(networkFor('bitcoingold-mainnet')).toBe(BITCOINGOLD_MAINNET);
    expect(networkFor('litecoin-mainnet')).toBe(LITECOIN_MAINNET);
    expect(networkFor('wojakcoin-mainnet')).toBe(WOJAKCOIN_MAINNET);
    expect(networkFor('bitcoin-mainnet')).toBe(BITCOIN_MAINNET);
  });

  it('is asset-free (capability flags, not chain names)', () => {
    // Verified live 2026-08-15: DOGE's ElectrumX servers are PLAIN 2.0.0 — the
    // asset dialect is rejected ("unknown method").
    expect(supportsAssets(DOGECOIN_MAINNET)).toBe(false);
    expect(DOGECOIN_MAINNET.assetMarkerPrefix).toBeUndefined();
    // Any asset code path must fail loudly rather than emit an OP_x_ASSET script.
    expect(() => assetMarkerPrefixOf(DOGECOIN_MAINNET)).toThrow(/no asset protocol/i);
    // Unchanged for the existing chains.
    expect(supportsAssets(EVRMORE_MAINNET)).toBe(true);
    expect(supportsAssets(RAVENCOIN_MAINNET)).toBe(true);
    expect(supportsAssets(BITCOIN_MAINNET)).toBe(false);
  });

  it('routes to the BIP44 purpose with coin type 3', () => {
    expect(derivationPath(DOGECOIN_MAINNET, 0, 0, 0)).toBe("m/44'/3'/0'/0/0");
    expect(derivationPath(DOGECOIN_MAINNET, 0, 1, 7)).toBe("m/44'/3'/0'/1/7");
  });

  it('shares derivation with no other chain (its own SLIP-44 coin type AND its own version bytes)', () => {
    for (const other of OTHER_CHAINS) {
      expect(chainsShareDerivation('dogecoin-mainnet', other.chainId)).toBe(false);
      expect(chainsShareDerivation(other.chainId, 'dogecoin-mainnet')).toBe(false);
    }
    // Reflexive, and the existing Evrmore <-> Ravencoin link is untouched.
    expect(chainsShareDerivation('dogecoin-mainnet', 'dogecoin-mainnet')).toBe(true);
    expect(chainsShareDerivation('evrmore-mainnet', 'ravencoin-mainnet')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Segwit is DISABLED on Dogecoin: DEPLOYMENT_SEGWIT.nTimeout = 0 means the
// deployment expired without ever activating, and chainparams defines no bech32
// hrp at all. To a network that does not enforce witness rules a P2WPKH output
// is a bare ANYONE-CAN-SPEND script, so the wallet must neither produce a
// bech32 address here nor pay to one. (WojakCoin documents the same trap via a
// different mechanism — SegwitHeight = INT_MAX with an hrp defined.)
// ---------------------------------------------------------------------------
describe('Dogecoin has NO segwit — legacy-only, like WojakCoin', () => {
  it('declares no bech32Hrp, so supportsSegwit() is false', () => {
    expect(DOGECOIN_MAINNET.bech32Hrp).toBeUndefined();
    expect(supportsSegwit(DOGECOIN_MAINNET)).toBe(false);
    expect(DOGECOIN_MAINNET.taprootActive).toBeUndefined();
    // Unchanged for the chains that really do have activated segwit.
    expect(supportsSegwit(BITCOIN_MAINNET)).toBe(true);
    expect(supportsSegwit(LITECOIN_MAINNET)).toBe(true);
    expect(supportsSegwit(BITCOINGOLD_MAINNET)).toBe(true);
  });

  it('produces NO bech32 address for a key — every form is base58 P2PKH', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 0);
    expect(derived.address.startsWith('D')).toBe(true);
    expect(decodeSegwitAddress(derived.address)).toBeNull();
    // The chain-format-aware encoder agrees (it reads addressFormat, not a name).
    expect(pubkeyToAddress(derived.publicKey, DOGECOIN_MAINNET)).toBe(derived.address);
    expect(pubkeyToP2pkhAddress(derived.publicKey, DOGECOIN_MAINNET)).toBe(derived.address);
    // And asking for a segwit address outright is a hard error.
    expect(() => pubkeyToP2wpkhAddress(derived.publicKey, DOGECOIN_MAINNET)).toThrow(/no segwit/i);
  });

  it('REJECTS well-formed bech32 recipients on Dogecoin (funds-loss guard)', () => {
    // The canonical BIP173 example is a checksum-valid, genuinely decodable
    // P2WPKH address, so the rejection below is proven to come from "this chain
    // has no segwit", not from a malformed string.
    const bc1 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    expect(decodeSegwitAddress(bc1)).not.toBeNull();
    expect(isSpendableAddress(bc1, DOGECOIN_MAINNET)).toBe(false);
    expect(isValidAddress(bc1, DOGECOIN_MAINNET)).toBe(false);
  });
});

describe('Dogecoin address derivation', () => {
  it("reproduces the OFFICIAL BIP44 Bitcoin vector through the same params object (version bytes don't change keys)", async () => {
    // Independent anchor, doing double duty:
    //  (a) proves the 44' purpose selection + base58check encoding against a
    //      PUBLISHED standard vector rather than our own output, and
    //  (b) proves the params-header claim that BIP32 version bytes affect
    //      serialization only: this object still carries Dogecoin's dgub/dgpv
    //      bytes, yet with coinType 0 + pubKeyHash 0 + wif 128 it must yield
    //      the exact published Bitcoin address. If derivation ever consulted
    //      the version bytes, this test would fail first.
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const asBitcoin: EvrmoreNetwork = { ...DOGECOIN_MAINNET, coinType: 0, pubKeyHash: 0, wif: 128 };
    const derived = deriveAddress(seed, asBitcoin, 0, 0, 0);
    expect(derived.path).toBe("m/44'/0'/0'/0/0");
    expect(bytesToHex(derived.publicKey)).toBe(
      '03aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e',
    );
    expect(derived.address).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  });

  it("derives a 'D…' receive address at m/44'/3'/0'/0/0", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 0);
    expect(derived.path).toBe("m/44'/3'/0'/0/0");
    expect(derived.address.startsWith('D')).toBe(true);
    // Fixture computed INDEPENDENTLY of keys.ts (raw @scure/bip32 +
    // base58check over version byte 30) for this mnemonic; pinned so a
    // version-byte or coin-type edit cannot slip through unnoticed.
    expect(bytesToHex(derived.publicKey)).toBe(
      '02cc6b0dc33aabcf3a23643e5e2919a80c50fb3dd2129ce409bbc5f0d4643d05e0',
    );
    expect(derived.address).toBe('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC');
    // Version byte 30 is what makes it a 'D' address.
    expect(addressToHash160(derived.address).version).toBe(30);
    expect(isP2pkhAddress(derived.address, DOGECOIN_MAINNET)).toBe(true);
    expect(isValidAddress(derived.address, DOGECOIN_MAINNET)).toBe(true);
    // Second receive index, same independent-fixture provenance.
    const receive1 = deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 1);
    expect(receive1.path).toBe("m/44'/3'/0'/0/1");
    expect(receive1.address).toBe('DAcDAtJRztxBHyA6D6h8du1HguyTR43Mas');
  });

  it('encodes WIF with SECRET_KEY 158', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 0);
    // Independent fixture (same provenance as the addresses above). Version
    // byte 158 is what makes a compressed Dogecoin WIF start with 'Q'.
    expect(derived.wif).toBe('QPkeC1ZfHx3c9g7WTj9cQ8gnvk2iSAfAcbq1aVAWjNTwDAKfZUzx');
    const payload = b58c.decode(derived.wif);
    expect(payload[0]).toBe(158); // base58Prefixes[SECRET_KEY]
    const { privateKey, compressed } = decodeWif(derived.wif);
    expect(compressed).toBe(true);
    expect(privateKey).toEqual(derived.privateKey);
  });

  it('derives DIFFERENT key material than every other chain (coin type 3)', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const doge = deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 0);
    for (const other of OTHER_CHAINS) {
      const derived = deriveAddress(seed, other, 0, 0, 0);
      expect(bytesToHex(doge.privateKey)).not.toBe(bytesToHex(derived.privateKey));
    }
  });
});

describe('isSpendableAddress on Dogecoin (send-path safety gate)', () => {
  it('accepts its own P2PKH address', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const doge = deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 0).address;
    expect(isSpendableAddress(doge, DOGECOIN_MAINNET)).toBe(true);
  });

  it('rejects EVR / RVN / BTGS / LTC / WJK / BTC addresses as Dogecoin recipients', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    for (const other of OTHER_CHAINS) {
      const foreign = deriveAddress(seed, other, 0, 0, 0).address;
      expect(isSpendableAddress(foreign, DOGECOIN_MAINNET)).toBe(false);
      expect(isValidAddress(foreign, DOGECOIN_MAINNET)).toBe(false);
    }
  });

  it('is rejected in the other direction on every existing chain', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const doge = deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 0).address;
    for (const other of OTHER_CHAINS) {
      expect(isSpendableAddress(doge, other)).toBe(false);
      expect(isValidAddress(doge, other)).toBe(false);
    }
  });

  it("VALIDATES its own 22-prefix P2SH (Dogecoin's byte since 2013) but still refuses to pay it", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const h160 = addressToHash160(deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 0).address).hash;
    const p2sh22 = b58c.encode(concatBytes(Uint8Array.of(22), h160));
    expect(addressToHash160(p2sh22).version).toBe(22);

    // 22 is Dogecoin's OWN prefix (BTGS is the 2026 fork that adopted the same
    // byte), so like Bitcoin-with-5 it is accepted by the lenient check…
    expect(isValidAddress(p2sh22, DOGECOIN_MAINNET)).toBe(true);
    // …and the same string is NO LONGER accepted on BTGS. BTGS ships
    // SCRIPT_ADDRESS 22 in its own chainparams, but Dogecoin has used 22 since
    // 2013 and BTGS is a 2026 fork, so BTGS is the borrower and fails closed
    // (the same rule, and the same shape, as WojakCoin vs Bitcoin's 5). The
    // real byte is kept in scriptHashLegacy so provenance is not lost.
    expect(BITCOINGOLD_MAINNET.scriptHash).toBe(NO_ACCEPTED_P2SH);
    expect(BITCOINGOLD_MAINNET.scriptHashLegacy).toBe(22);
    expect(isValidAddress(p2sh22, BITCOINGOLD_MAINNET)).toBe(false);

    // What keeps the overlap harmless: the SEND path gates on
    // isSpendableAddress, which rejects EVERY P2SH form on EVERY chain — the
    // builder cannot construct a P2SH output at all.
    expect(isSpendableAddress(p2sh22, DOGECOIN_MAINNET)).toBe(false);
    expect(isSpendableAddress(p2sh22, BITCOINGOLD_MAINNET)).toBe(false);
  });

  it("never accepts a '3…' (version 5) P2SH — that prefix is Bitcoin's, not Dogecoin's", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const h160 = addressToHash160(deriveAddress(seed, DOGECOIN_MAINNET, 0, 0, 0).address).hash;
    const p2sh5 = b58c.encode(concatBytes(Uint8Array.of(5), h160));
    expect(isValidAddress(p2sh5, DOGECOIN_MAINNET)).toBe(false);
    expect(isSpendableAddress(p2sh5, DOGECOIN_MAINNET)).toBe(false);
    // …while it still validates (never pays) on Bitcoin, whose prefix it is.
    expect(isValidAddress(p2sh5, BITCOIN_MAINNET)).toBe(true);
    expect(isSpendableAddress(p2sh5, BITCOIN_MAINNET)).toBe(false);
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

describe("LiveWalletService with the 'dogecoin-mainnet' network id", () => {
  beforeEach(() => {
    setStorageForTests(new MemoryStorageAdapter());
  });

  it('resolves DOGECOIN_MAINNET and derives the wallet its D address', async () => {
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'dogecoin-mainnet', 'DOGE wallet');
    expect(svc.network()).toBe('dogecoin-mainnet');
    // The independent fixture, straight through the service path.
    expect(svc.getAddress(0)).toBe('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC');
    // Never a bech32 address, even through the service path.
    expect(decodeSegwitAddress(svc.getAddress(0))).toBeNull();
    // The stored entry keeps the canonical id, so a reload resolves the chain.
    const [entry] = await svc.listWallets();
    expect(entry.network).toBe('dogecoin-mainnet');
    expect(entry.address).toBe('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC');
  });

  it('signs with the Dogecoin magic address and refuses asset sends (no asset protocol)', async () => {
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'dogecoin-mainnet', 'DOGE wallet');
    // signMessage uses net.messageMagic; assert the signing address, which is
    // what a verifier checks the signature against.
    expect(svc.signMessage('hello').address).toBe('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC');
    // The asset path is gated by supportsAssets(), not by a chain name, and
    // fails before any network access (so the stub client is never used).
    await expect(svc.buildAssetSend('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', 'X', 1n))
      .rejects.toThrow('assets-not-supported');
  });

  it('refuses a foreign-chain recipient before touching the network', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'dogecoin-mainnet', 'DOGE wallet');
    for (const other of OTHER_CHAINS) {
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
    await svc.import(TEST_MNEMONIC, 'pw', 'bitcoin-mainnet', 'BTC wallet');
    expect(svc.network()).toBe('bitcoin-mainnet');
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0).address);
    await svc.import(TEST_MNEMONIC, 'pw', 'wojakcoin-mainnet', 'WJK wallet');
    expect(svc.network()).toBe('wojakcoin-mainnet');
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0).address);
  });
});
