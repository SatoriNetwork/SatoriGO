// Bitcoin (BTC) chain registration — parameter provenance + address derivation.
//
// Bitcoin is the sixth chain and a special case in this file: every other chain
// here is a fork of it, so its parameters are the ORIGIN the others deviated
// from. That gives this suite three jobs:
//   1. PIN the verified consensus values from bitcoin/bitcoin
//      src/kernel/chainparams.cpp (CMainParams) so a future edit cannot silently
//      change a version byte (a wrong byte = addresses on the wrong chain, i.e.
//      unspendable funds).
//   2. PIN THE DIRECTION OF THE DEVIATIONS. BTGS's BIP32 version bytes
//      (0x0488B21F/0x0488ADE5) are a departure FROM the canonical
//      0x0488B21E/0x0488ADE4 asserted here, never the other way round. If someone
//      later "harmonises" the file toward BTGS, these tests fail loudly.
//   3. Anchor derivation on a PUBLISHED standard rather than on our own output.
//      The Litecoin and WojakCoin suites had to synthesise a fake "as Bitcoin"
//      network to reach the official BIP84/BIP44 vectors; BITCOIN_MAINNET simply
//      IS that network, so the vectors are asserted against the shipped params
//      directly — the strongest form of the anchor.
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
  EVRMORE_MAINNET,
  LITECOIN_MAINNET,
  NO_ACCEPTED_P2SH,
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  assetMarkerPrefixOf,
  bip44Path,
  chainsShareDerivation,
  derivationPath,
  networkFor,
  supportsAssets,
  supportsSegwit,
  type EvrmoreNetwork,
} from './chainParams';
import { LiveWalletService } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import type { ElectrumClient } from './electrumTypes';

/**
 * The standard BIP39 test mnemonic used by the OFFICIAL BIP44/BIP49/BIP84 test
 * vectors (public, throwaway — never real funds). Everything asserted from it
 * below is a published value, not something this codebase produced.
 */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const b58c = base58check(sha256);

/** The other five chains, for cross-chain rejection sweeps. */
const OTHER_CHAINS: EvrmoreNetwork[] = [
  EVRMORE_MAINNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
];

describe('BITCOIN_MAINNET parameters (bitcoin/bitcoin src/kernel/chainparams.cpp)', () => {
  it('carries the exact verified base58/bech32 values', () => {
    const net = BITCOIN_MAINNET;
    expect(net.pubKeyHash).toBe(0); // PUBKEY_ADDRESS -> '1'
    expect(net.scriptHash).toBe(5); // SCRIPT_ADDRESS -> '3'
    expect(net.wif).toBe(128); // SECRET_KEY
    expect(net.bech32Hrp).toBe('bc');
    expect(net.coinType).toBe(0); // SLIP-44 (satoshilabs/slips slip-0044.md)
    expect(net.defaultPort).toBe(8333); // nDefaultPort
    expect(net.messageStart).toBe(0xf9); // pchMessageStart[0] of f9,be,b4,d9
    expect(net.messageMagic).toBe('Bitcoin Signed Message:\n'); // src/common/signmessage.cpp
    expect(net.addressFormat).toBe('p2wpkh');
    expect(net.ticker).toBe('BTC');
    expect(net.displayName).toBe('Bitcoin');
    expect(net.chainId).toBe('bitcoin-mainnet');
    // Electrum server ROLE stays 'mainnet' (like RVN/BTGS/LTC/WJK); chainId is the identity.
    expect(net.id).toBe('mainnet');
    // pubKeyHash 0 is a REAL version byte, not "unset" — nothing may treat it as
    // falsy/absent, or every Bitcoin address would be encoded on the wrong chain.
    expect(net.pubKeyHash).not.toBeUndefined();
  });

  it('holds THE canonical BIP32 version bytes that BTGS deviates from', () => {
    // These are the originals; four of the six chains simply kept them.
    expect(BITCOIN_MAINNET.bip32.public).toBe(0x0488b21e);
    expect(BITCOIN_MAINNET.bip32.private).toBe(0x0488ade4);
    expect(BITCOIN_MAINNET.bip32).toEqual(EVRMORE_MAINNET.bip32);
    expect(BITCOIN_MAINNET.bip32).toEqual(RAVENCOIN_MAINNET.bip32);
    expect(BITCOIN_MAINNET.bip32).toEqual(LITECOIN_MAINNET.bip32);
    expect(BITCOIN_MAINNET.bip32).toEqual(WOJAKCOIN_MAINNET.bip32);

    // BTGS is the lone outlier: its own chainparams.cpp bumps BOTH last bytes by
    // one. Pin the deviation AND its direction, so a future "harmonisation" can
    // only ever move BTGS, never Bitcoin. Copying 1F/E5 onto this entry would
    // break xpub/xprv interop with every other Bitcoin wallet in existence.
    expect(BITCOINGOLD_MAINNET.bip32.public).toBe(0x0488b21f);
    expect(BITCOINGOLD_MAINNET.bip32.private).toBe(0x0488ade5);
    expect(BITCOINGOLD_MAINNET.bip32.public).toBe(BITCOIN_MAINNET.bip32.public + 1);
    expect(BITCOINGOLD_MAINNET.bip32.private).toBe(BITCOIN_MAINNET.bip32.private + 1);
    expect(BITCOIN_MAINNET.bip32.public).not.toBe(BITCOINGOLD_MAINNET.bip32.public);
    expect(BITCOIN_MAINNET.bip32.private).not.toBe(BITCOINGOLD_MAINNET.bip32.private);
  });

  it('resolves from its canonical chain id', () => {
    expect(networkFor('bitcoin-mainnet')).toBe(BITCOIN_MAINNET);
    // Adding BTC must not disturb the existing resolutions. In particular the
    // legacy 'mainnet'/'testnet' ids still mean EVRMORE, not Bitcoin.
    expect(networkFor('mainnet')).toBe(EVRMORE_MAINNET);
    expect(networkFor('evrmore-mainnet')).toBe(EVRMORE_MAINNET);
    expect(networkFor('testnet')).toBe(networkFor('evrmore-testnet'));
    expect(networkFor('ravencoin-mainnet')).toBe(RAVENCOIN_MAINNET);
    expect(networkFor('bitcoingold-mainnet')).toBe(BITCOINGOLD_MAINNET);
    expect(networkFor('litecoin-mainnet')).toBe(LITECOIN_MAINNET);
    expect(networkFor('wojakcoin-mainnet')).toBe(WOJAKCOIN_MAINNET);
  });

  it('is segwit-capable and asset-free (capability flags, not chain names)', () => {
    expect(supportsSegwit(BITCOIN_MAINNET)).toBe(true);
    // Verified live: BTC's ElectrumX servers are plain 2.0.0 — no asset dialect.
    expect(supportsAssets(BITCOIN_MAINNET)).toBe(false);
    expect(BITCOIN_MAINNET.assetMarkerPrefix).toBeUndefined();
    // Any asset code path must fail loudly rather than emit an OP_x_ASSET script.
    expect(() => assetMarkerPrefixOf(BITCOIN_MAINNET)).toThrow(/no asset protocol/i);
    // Unchanged for the existing chains.
    expect(supportsAssets(EVRMORE_MAINNET)).toBe(true);
    expect(supportsAssets(RAVENCOIN_MAINNET)).toBe(true);
    expect(supportsAssets(BITCOINGOLD_MAINNET)).toBe(false);
    expect(supportsAssets(LITECOIN_MAINNET)).toBe(false);
    expect(supportsAssets(WOJAKCOIN_MAINNET)).toBe(false);
    expect(supportsSegwit(BITCOINGOLD_MAINNET)).toBe(true);
    expect(supportsSegwit(LITECOIN_MAINNET)).toBe(true);
    expect(supportsSegwit(EVRMORE_MAINNET)).toBe(false);
    expect(supportsSegwit(RAVENCOIN_MAINNET)).toBe(false);
    expect(supportsSegwit(WOJAKCOIN_MAINNET)).toBe(false);
  });

  it('routes to the BIP84 purpose with coin type 0', () => {
    // addressFormat 'p2wpkh' selects purpose 84'; the coin index is SLIP-44 0.
    expect(derivationPath(BITCOIN_MAINNET, 0, 0, 0)).toBe("m/84'/0'/0'/0/0");
    expect(derivationPath(BITCOIN_MAINNET, 0, 1, 7)).toBe("m/84'/0'/0'/1/7");
    // The BIP44 helper is unconditional by construction, so it still reports 44'.
    // Pinned to show the purpose split is driven by addressFormat, not by name.
    expect(bip44Path(BITCOIN_MAINNET, 0, 0, 0)).toBe("m/44'/0'/0'/0/0");
  });

  it('shares derivation with no other chain (SLIP-44 coin type 0 is its own)', () => {
    // Four chains share Bitcoin's BIP32 version bytes, so this is exactly the
    // case where a coinType-blind implementation would produce a false positive.
    for (const other of OTHER_CHAINS) {
      expect(chainsShareDerivation('bitcoin-mainnet', other.chainId)).toBe(false);
      expect(chainsShareDerivation(other.chainId, 'bitcoin-mainnet')).toBe(false);
    }
    // Reflexive, and the existing Evrmore <-> Ravencoin link (shared coinType 175
    // AND shared version bytes) is untouched.
    expect(chainsShareDerivation('bitcoin-mainnet', 'bitcoin-mainnet')).toBe(true);
    expect(chainsShareDerivation('evrmore-mainnet', 'ravencoin-mainnet')).toBe(true);
  });
});

describe('Bitcoin address derivation (official BIP84 test vectors)', () => {
  it("derives BIP84's published m/84'/0'/0'/0/0 address from the shipped params", async () => {
    // THE anchor for this suite. These values are published in BIP84 itself, so
    // the assertion is against a standard rather than against our own output —
    // and unlike the Litecoin/WojakCoin suites nothing is synthesised here: the
    // shipped BITCOIN_MAINNET is fed to the shipped deriveAddress unmodified.
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0);
    expect(derived.path).toBe("m/84'/0'/0'/0/0");
    expect(bytesToHex(derived.publicKey)).toBe(
      '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c',
    );
    expect(derived.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  });

  it("matches BIP84's second receive and first change vectors too", async () => {
    // Proves the index and the change branch are wired to the published scheme,
    // not just the single index-0 address.
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const receive1 = deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 1);
    expect(receive1.path).toBe("m/84'/0'/0'/0/1");
    expect(receive1.address).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');

    const change0 = deriveAddress(seed, BITCOIN_MAINNET, 0, 1, 0);
    expect(change0.path).toBe("m/84'/0'/0'/1/0");
    expect(change0.address).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  });

  it("produces a real bc1… P2WPKH, not merely a string starting with 'bc1'", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0);
    const decoded = decodeSegwitAddress(derived.address);
    expect(decoded).not.toBeNull();
    expect(decoded!.hrp).toBe('bc');
    expect(decoded!.witnessVersion).toBe(0);
    expect(decoded!.program.length).toBe(20); // P2WPKH, not P2WSH
    // Round-trips through the chain-format-aware encoders (which read
    // addressFormat/bech32Hrp, never a chain name).
    expect(pubkeyToP2wpkhAddress(derived.publicKey, BITCOIN_MAINNET)).toBe(derived.address);
    expect(pubkeyToAddress(derived.publicKey, BITCOIN_MAINNET)).toBe(derived.address);
  });

  it("encodes the same key's legacy P2PKH form as a '1…' address (version 0)", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0);
    const legacy = pubkeyToP2pkhAddress(derived.publicKey, BITCOIN_MAINNET);
    expect(legacy.startsWith('1')).toBe(true);
    expect(legacy).toBe('1JaUQDVNRdhfNsVncGkXedaPSM5Gc54Hso');
    // Version byte 0 is what makes it a '1' address — the encoder must not treat
    // the zero as "no prefix".
    expect(addressToHash160(legacy).version).toBe(0);
    expect(isP2pkhAddress(legacy, BITCOIN_MAINNET)).toBe(true);
    expect(isValidAddress(legacy, BITCOIN_MAINNET)).toBe(true);
    // Both forms must commit to the SAME hash160 — one key, two scripts.
    expect(addressToHash160(legacy).hash).toEqual(decodeSegwitAddress(derived.address)!.program);
  });

  it("encodes WIF with SECRET_KEY 128, matching BIP84's published private key", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0);
    // Published in BIP84 alongside the address above — another standards anchor.
    expect(derived.wif).toBe('KyZpNDKnfs94vbrwhJneDi77V6jF64PWPF8x5cdJb8ifgg2DUc9d');
    const payload = b58c.decode(derived.wif);
    expect(payload[0]).toBe(128); // base58Prefixes[SECRET_KEY]
    const { privateKey, compressed } = decodeWif(derived.wif);
    expect(compressed).toBe(true);
    expect(privateKey).toEqual(derived.privateKey);
  });

  it('derives DIFFERENT key material than every other chain (coin type 0)', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const btc = deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0);
    for (const other of OTHER_CHAINS) {
      const derived = deriveAddress(seed, other, 0, 0, 0);
      expect(bytesToHex(btc.privateKey)).not.toBe(bytesToHex(derived.privateKey));
    }
  });
});

describe('isSpendableAddress on Bitcoin (send-path safety gate)', () => {
  it('accepts its own bech32 and its own P2PKH', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const btc = deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0);
    const legacy = pubkeyToP2pkhAddress(btc.publicKey, BITCOIN_MAINNET);
    expect(isSpendableAddress(btc.address, BITCOIN_MAINNET)).toBe(true);
    expect(isSpendableAddress(legacy, BITCOIN_MAINNET)).toBe(true);
    // The canonical BIP173 example address is a well-formed Bitcoin P2WPKH too.
    expect(isSpendableAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', BITCOIN_MAINNET)).toBe(
      true,
    );
  });

  it('rejects EVR / RVN / BTGS / LTC / WJK addresses as Bitcoin recipients', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    for (const other of OTHER_CHAINS) {
      const foreign = deriveAddress(seed, other, 0, 0, 0).address;
      expect(isSpendableAddress(foreign, BITCOIN_MAINNET)).toBe(false);
      expect(isValidAddress(foreign, BITCOIN_MAINNET)).toBe(false);
    }
  });

  it('is rejected in the other direction on every existing chain', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const btc = deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0);
    const legacy = pubkeyToP2pkhAddress(btc.publicKey, BITCOIN_MAINNET);
    for (const other of OTHER_CHAINS) {
      // Legacy chains have no segwit at all; BTGS/LTC have it under another hrp.
      expect(isSpendableAddress(btc.address, other)).toBe(false);
      expect(isValidAddress(btc.address, other)).toBe(false);
      // And no chain's P2PKH/P2SH prefix is 0, so the '1…' form is foreign too.
      expect(isSpendableAddress(legacy, other)).toBe(false);
      expect(isValidAddress(legacy, other)).toBe(false);
    }
  });

  it("VALIDATES a '3…' P2SH address (prefix 5 is Bitcoin's own) but still refuses to pay it", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const h160 = addressToHash160(
      pubkeyToP2pkhAddress(deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0).publicKey, BITCOIN_MAINNET),
    ).hash;
    const p2sh = b58c.encode(concatBytes(Uint8Array.of(5), h160));
    expect(p2sh.startsWith('3')).toBe(true);

    // Unlike Litecoin (legacy 5 demoted) and WojakCoin (NO_ACCEPTED_P2SH), Bitcoin
    // ACCEPTS 5: the value is this chain's own, so there is no other chain it could
    // be confused with and nothing to fail closed against.
    expect(BITCOIN_MAINNET.scriptHash).toBe(5);
    expect(BITCOIN_MAINNET.scriptHash).not.toBe(NO_ACCEPTED_P2SH);
    expect(BITCOIN_MAINNET.scriptHashLegacy).toBeUndefined();
    expect(isValidAddress(p2sh, BITCOIN_MAINNET)).toBe(true);
    // The canonical Bitcoin P2SH example address validates as well.
    expect(isValidAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', BITCOIN_MAINNET)).toBe(true);

    // ...and accepting it changes NOTHING about safety. isValidAddress is the
    // lenient "does this look like an address on this chain?" check; the SEND path
    // gates on isSpendableAddress, which rejects every P2SH form on every chain
    // because the builder cannot construct a P2SH output at all.
    expect(isSpendableAddress(p2sh, BITCOIN_MAINNET)).toBe(false);
    expect(isSpendableAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', BITCOIN_MAINNET)).toBe(false);
  });

  it("keeps the other chains' P2SH handling exactly as it was", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const h160 = addressToHash160(
      pubkeyToP2pkhAddress(deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0).publicKey, BITCOIN_MAINNET),
    ).hash;
    const p2sh5 = b58c.encode(concatBytes(Uint8Array.of(5), h160)); // '3…'
    const ltcCurrent = b58c.encode(concatBytes(Uint8Array.of(50), h160)); // 'M…'

    // Litecoin still accepts its CURRENT prefix and still refuses the legacy one;
    // WojakCoin still refuses every P2SH form. Registering Bitcoin does not
    // loosen either — the '3…' ambiguity they guard against is precisely the fact
    // that such a string IS a Bitcoin address.
    expect(isValidAddress(ltcCurrent, LITECOIN_MAINNET)).toBe(true);
    expect(isValidAddress(p2sh5, LITECOIN_MAINNET)).toBe(false);
    expect(isValidAddress(p2sh5, WOJAKCOIN_MAINNET)).toBe(false);
    expect(LITECOIN_MAINNET.scriptHashLegacy).toBe(5);
    expect(WOJAKCOIN_MAINNET.scriptHash).toBe(NO_ACCEPTED_P2SH);
    // The same string is a valid Bitcoin address — the direction that matters.
    expect(isValidAddress(p2sh5, BITCOIN_MAINNET)).toBe(true);
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

describe("LiveWalletService with the 'bitcoin-mainnet' network id", () => {
  beforeEach(() => {
    setStorageForTests(new MemoryStorageAdapter());
  });

  it('resolves BITCOIN_MAINNET and derives the wallet its bc1 address', async () => {
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'bitcoin-mainnet', 'BTC wallet');
    expect(svc.network()).toBe('bitcoin-mainnet');
    // The published BIP84 vector, straight through the service path.
    expect(svc.getAddress(0)).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    // The stored entry keeps the canonical id, so a reload resolves the chain.
    const [entry] = await svc.listWallets();
    expect(entry.network).toBe('bitcoin-mainnet');
    expect(entry.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  });

  it('signs with the chain magic and refuses asset sends (no asset protocol)', async () => {
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'bitcoin-mainnet', 'BTC wallet');
    // signMessage uses net.messageMagic; assert the signing address, which is what
    // a verifier checks the signature against.
    expect(svc.signMessage('hello').address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    // The asset path is gated by supportsAssets(), not by a chain name, and fails
    // before any network access (so the stub client is never used).
    await expect(svc.buildAssetSend('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'X', 1n))
      .rejects.toThrow('assets-not-supported');
  });

  it('refuses a foreign-chain recipient before touching the network', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'bitcoin-mainnet', 'BTC wallet');
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
    await svc.import(TEST_MNEMONIC, 'pw', 'litecoin-mainnet', 'LTC wallet');
    expect(svc.network()).toBe('litecoin-mainnet');
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0).address);
    await svc.import(TEST_MNEMONIC, 'pw', 'wojakcoin-mainnet', 'WJK wallet');
    expect(svc.network()).toBe('wojakcoin-mainnet');
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0).address);
  });
});
