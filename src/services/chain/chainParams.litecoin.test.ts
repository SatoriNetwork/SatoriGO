// Litecoin (LTC) chain registration — parameter provenance + address derivation.
//
// Litecoin is the second NATIVE-SEGWIT chain in the wallet, so this suite has two
// jobs:
//   1. PIN the verified consensus values from litecoin-project/litecoin
//      src/chainparams.cpp so a future edit cannot silently change a version byte
//      (a wrong byte = addresses on the wrong chain, i.e. unspendable funds).
//   2. Prove the derivation actually lands on Litecoin's BIP84 account, WITHOUT
//      the test being self-referential. The anchor is the OFFICIAL BIP84 test
//      vector: Litecoin uses the STANDARD Bitcoin BIP32 version bytes and the
//      standard BIP84 scheme, so the same code with coinType 0 + hrp 'bc' must
//      reproduce the published Bitcoin address. If that holds, the only thing
//      separating LTC from BTC in this codebase is coinType/hrp/version bytes —
//      all asserted below.
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
  BITCOINGOLD_MAINNET,
  EVRMORE_MAINNET,
  LITECOIN_MAINNET,
  RAVENCOIN_MAINNET,
  assetMarkerPrefixOf,
  derivationPath,
  networkFor,
  supportsAssets,
  supportsSegwit,
} from './chainParams';
import { LiveWalletService } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import type { ElectrumClient } from './electrumTypes';

/** Standard BIP39/BIP84 test mnemonic (public, throwaway — never real funds). */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const b58c = base58check(sha256);

describe('LITECOIN_MAINNET parameters (litecoin-project/litecoin src/chainparams.cpp)', () => {
  it('carries the exact verified base58/bech32 values', () => {
    const net = LITECOIN_MAINNET;
    expect(net.pubKeyHash).toBe(48); // PUBKEY_ADDRESS  -> 'L'
    expect(net.scriptHash).toBe(50); // SCRIPT_ADDRESS2 -> 'M' (current P2SH)
    expect(net.scriptHashLegacy).toBe(5); // SCRIPT_ADDRESS -> '3' (historical)
    expect(net.wif).toBe(176); // SECRET_KEY
    expect(net.bech32Hrp).toBe('ltc');
    expect(net.coinType).toBe(2); // SLIP-44 (satoshilabs/slips slip-0044.md)
    expect(net.defaultPort).toBe(9333);
    expect(net.messageMagic).toBe('Litecoin Signed Message:\n'); // src/util/message.cpp
    expect(net.addressFormat).toBe('p2wpkh');
    expect(net.ticker).toBe('LTC');
    expect(net.displayName).toBe('Litecoin');
    expect(net.chainId).toBe('litecoin-mainnet');
    // Electrum server ROLE stays 'mainnet' (like RVN/BTGS); chainId is the identity.
    expect(net.id).toBe('mainnet');
  });

  it('uses the STANDARD Bitcoin BIP32 version bytes (unlike BTGS)', () => {
    // Guards against a future "tidy-up" that copies BTGS's non-standard 1F/E5.
    expect(LITECOIN_MAINNET.bip32.public).toBe(0x0488b21e);
    expect(LITECOIN_MAINNET.bip32.private).toBe(0x0488ade4);
    expect(LITECOIN_MAINNET.bip32.public).not.toBe(BITCOINGOLD_MAINNET.bip32.public);
    expect(LITECOIN_MAINNET.bip32.private).not.toBe(BITCOINGOLD_MAINNET.bip32.private);
    // Same bytes as the other standard chains, so xpub/xprv interop is plain.
    expect(LITECOIN_MAINNET.bip32).toEqual(EVRMORE_MAINNET.bip32);
  });

  it('resolves from its canonical chain id', () => {
    expect(networkFor('litecoin-mainnet')).toBe(LITECOIN_MAINNET);
    // Adding LTC must not disturb the existing resolutions.
    expect(networkFor('mainnet')).toBe(EVRMORE_MAINNET);
    expect(networkFor('ravencoin-mainnet')).toBe(RAVENCOIN_MAINNET);
    expect(networkFor('bitcoingold-mainnet')).toBe(BITCOINGOLD_MAINNET);
  });

  it('is segwit-capable and asset-free (capability flags, not chain names)', () => {
    expect(supportsSegwit(LITECOIN_MAINNET)).toBe(true);
    // Litecoin's ElectrumX is PLAIN: blockchain.asset.get_meta errors (verified live).
    expect(supportsAssets(LITECOIN_MAINNET)).toBe(false);
    expect(LITECOIN_MAINNET.assetMarkerPrefix).toBeUndefined();
    // Any asset code path must fail loudly rather than emit an OP_x_ASSET script.
    expect(() => assetMarkerPrefixOf(LITECOIN_MAINNET)).toThrow(/no asset protocol/i);
    // Unchanged for the existing chains.
    expect(supportsAssets(EVRMORE_MAINNET)).toBe(true);
    expect(supportsAssets(RAVENCOIN_MAINNET)).toBe(true);
    expect(supportsSegwit(EVRMORE_MAINNET)).toBe(false);
  });

  it('routes to the BIP84 purpose with coin type 2', () => {
    expect(derivationPath(LITECOIN_MAINNET, 0, 0, 0)).toBe("m/84'/2'/0'/0/0");
    expect(derivationPath(LITECOIN_MAINNET, 0, 1, 7)).toBe("m/84'/2'/0'/1/7");
  });
});

describe('Litecoin address derivation', () => {
  it('reproduces the OFFICIAL BIP84 vector with the same code path (coinType 0, hrp bc)', async () => {
    // Independent anchor: Litecoin's BIP32 bytes and BIP84 scheme are Bitcoin's,
    // so swapping only coinType + hrp on LITECOIN_MAINNET must yield BIP84's
    // published m/84'/0'/0'/0/0 address for this mnemonic. This proves the
    // standard bytes, the 84' purpose selection and the bech32 encoder at once.
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const asBitcoin = { ...LITECOIN_MAINNET, coinType: 0, bech32Hrp: 'bc' };
    const derived = deriveAddress(seed, asBitcoin, 0, 0, 0);
    expect(derived.path).toBe("m/84'/0'/0'/0/0");
    expect(bytesToHex(derived.publicKey)).toBe(
      '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c',
    );
    expect(derived.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  });

  it("derives an 'ltc1…' receive address at m/84'/2'/0'/0/0", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0);
    expect(derived.path).toBe("m/84'/2'/0'/0/0");
    expect(derived.address.startsWith('ltc1')).toBe(true);

    const decoded = decodeSegwitAddress(derived.address);
    expect(decoded).not.toBeNull();
    expect(decoded!.hrp).toBe('ltc');
    expect(decoded!.witnessVersion).toBe(0);
    expect(decoded!.program.length).toBe(20); // P2WPKH, not P2WSH
    // Round-trips through the chain-format-aware encoders.
    expect(pubkeyToP2wpkhAddress(derived.publicKey, LITECOIN_MAINNET)).toBe(derived.address);
    expect(pubkeyToAddress(derived.publicKey, LITECOIN_MAINNET)).toBe(derived.address);
  });

  it("encodes the same key's legacy P2PKH form as an 'L' address (version 48)", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0);
    const legacy = pubkeyToP2pkhAddress(derived.publicKey, LITECOIN_MAINNET);
    expect(legacy.startsWith('L')).toBe(true);
    expect(addressToHash160(legacy).version).toBe(48);
    expect(isP2pkhAddress(legacy, LITECOIN_MAINNET)).toBe(true);
    // Both forms must commit to the SAME hash160 — they are one key, two scripts.
    expect(addressToHash160(legacy).hash).toEqual(decodeSegwitAddress(derived.address)!.program);
  });

  it('encodes WIF with SECRET_KEY 176', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0);
    const payload = b58c.decode(derived.wif);
    expect(payload[0]).toBe(176); // base58Prefixes[SECRET_KEY]
    const { privateKey, compressed } = decodeWif(derived.wif);
    expect(compressed).toBe(true);
    expect(privateKey).toEqual(derived.privateKey);
  });

  it('derives a DIFFERENT key than the legacy chains (coin type 2 vs 175)', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const ltc = deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0);
    const evr = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0);
    expect(bytesToHex(ltc.privateKey)).not.toBe(bytesToHex(evr.privateKey));
  });
});

describe('isSpendableAddress on Litecoin (send-path safety gate)', () => {
  it('accepts its own bech32 and its own P2PKH', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const ltc = deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0);
    const legacy = pubkeyToP2pkhAddress(ltc.publicKey, LITECOIN_MAINNET);
    expect(isSpendableAddress(ltc.address, LITECOIN_MAINNET)).toBe(true);
    expect(isSpendableAddress(legacy, LITECOIN_MAINNET)).toBe(true);
  });

  it('rejects EVR / RVN / BTGS addresses as Litecoin recipients', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const evr = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address;
    const rvn = deriveAddress(seed, RAVENCOIN_MAINNET, 0, 0, 0).address;
    const btgs = deriveAddress(seed, BITCOINGOLD_MAINNET, 0, 0, 0).address;
    expect(evr.startsWith('E')).toBe(true);
    expect(rvn.startsWith('R')).toBe(true);
    expect(btgs.startsWith('bcg1')).toBe(true);
    for (const foreign of [evr, rvn, btgs]) {
      expect(isSpendableAddress(foreign, LITECOIN_MAINNET)).toBe(false);
      expect(isValidAddress(foreign, LITECOIN_MAINNET)).toBe(false);
    }
    // A Bitcoin bech32 must not pass either — same witness program, wrong hrp.
    expect(isSpendableAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', LITECOIN_MAINNET)).toBe(
      false,
    );
  });

  it('is rejected in the other direction on every existing chain', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const ltc = deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0).address;
    // Legacy chains have no segwit at all; BTGS has segwit but a different hrp.
    expect(isSpendableAddress(ltc, EVRMORE_MAINNET)).toBe(false);
    expect(isSpendableAddress(ltc, RAVENCOIN_MAINNET)).toBe(false);
    expect(isSpendableAddress(ltc, BITCOINGOLD_MAINNET)).toBe(false);
  });

  it('never treats either P2SH form as spendable, so the omitted legacy prefix cannot burn funds', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const h160 = addressToHash160(
      pubkeyToP2pkhAddress(deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0).publicKey, LITECOIN_MAINNET),
    ).hash;
    const p2shCurrent = b58c.encode(concatBytes(Uint8Array.of(50), h160)); // 'M…'
    const p2shLegacy = b58c.encode(concatBytes(Uint8Array.of(5), h160)); // '3…'
    expect(p2shCurrent.startsWith('M')).toBe(true);
    expect(p2shLegacy.startsWith('3')).toBe(true);

    // isValidAddress is the LENIENT check and knows the CURRENT prefix only.
    expect(isValidAddress(p2shCurrent, LITECOIN_MAINNET)).toBe(true);
    // The legacy '3…' form is deliberately not accepted: that version byte is also
    // Bitcoin's P2SH prefix, so honouring it would let BTC addresses pass as LTC.
    // Failing closed is stricter than consensus, never more permissive.
    expect(isValidAddress(p2shLegacy, LITECOIN_MAINNET)).toBe(false);

    // The SEND path uses isSpendableAddress, which refuses BOTH — the builder
    // cannot construct a P2SH output, so neither form can ever be paid to.
    expect(isSpendableAddress(p2shCurrent, LITECOIN_MAINNET)).toBe(false);
    expect(isSpendableAddress(p2shLegacy, LITECOIN_MAINNET)).toBe(false);
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

describe("LiveWalletService with the 'litecoin-mainnet' network id", () => {
  beforeEach(() => {
    setStorageForTests(new MemoryStorageAdapter());
  });

  it('resolves LITECOIN_MAINNET and derives the wallet its ltc1 address', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const expected = deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0).address;
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'litecoin-mainnet', 'LTC wallet');
    expect(svc.network()).toBe('litecoin-mainnet');
    expect(svc.getAddress(0)).toBe(expected);
    expect(svc.getAddress(0).startsWith('ltc1')).toBe(true);
    // The stored entry keeps the canonical id, so a reload resolves the chain.
    const [entry] = await svc.listWallets();
    expect(entry.network).toBe('litecoin-mainnet');
    expect(entry.address).toBe(expected);
  });

  it('leaves the existing chains resolving exactly as before', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'mainnet', 'EVR wallet');
    expect(svc.network()).toBe('mainnet');
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address);
  });
});
