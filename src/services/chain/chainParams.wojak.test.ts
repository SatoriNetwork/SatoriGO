// WojakCoin (WJK) chain registration — parameter provenance, legacy-only address
// derivation, and the SEGWIT TRAP guard.
//
// WojakCoin is the fifth chain and the first one whose chainparams.cpp defines a
// bech32 hrp ("wj") that MUST NOT BE USED: consensus.SegwitHeight is INT_MAX, so
// segwit never activates and a P2WPKH output on this chain is an ANYONE-CAN-SPEND
// bare script. This suite therefore has three jobs:
//   1. PIN the verified consensus values from WojakCoinProj/wojakcore
//      src/chainparams.cpp so a future edit cannot silently change a version byte
//      (a wrong byte = addresses on the wrong chain, i.e. unspendable funds).
//   2. PROVE the chain stays legacy: no bech32Hrp, supportsSegwit() false, no
//      bech32 address is ever produced, and a checksum-VALID 'wj1…' string is
//      rejected by isSpendableAddress() and by the send path itself. That is the
//      funds-loss guard — if someone "completes" the params with bech32Hrp,
//      these tests fail loudly instead of the wallet handing out stealable
//      receive addresses.
//   3. Prove the derivation lands on WojakCoin's BIP44 account WITHOUT being
//      self-referential. The anchor is the OFFICIAL BIP44 Bitcoin vector:
//      WojakCoin uses the STANDARD Bitcoin BIP32 version bytes, so the same code
//      with coinType 0 + pubKeyHash 0 must reproduce the published Bitcoin
//      address for the standard test mnemonic. If that holds, the only thing
//      separating WJK from BTC in this codebase is coinType + version bytes —
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
  NO_ACCEPTED_P2SH,
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  assetMarkerPrefixOf,
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

/** Standard BIP39 test mnemonic (public, throwaway — never real funds). */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const b58c = base58check(sha256);

/** The other four chains, for cross-chain rejection sweeps. */
const OTHER_CHAINS: EvrmoreNetwork[] = [
  EVRMORE_MAINNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
];

/**
 * WojakCoin as it WOULD be if someone "completed" the params with the hrp that
 * chainparams.cpp defines. Used ONLY to (a) manufacture a checksum-valid 'wj1…'
 * string the real chain must reject, and (b) demonstrate, in code, exactly what
 * the trap would change. It must never be exported or used as real params.
 */
const WOJAK_IF_SEGWIT_WERE_ACTIVE: EvrmoreNetwork = {
  ...WOJAKCOIN_MAINNET,
  bech32Hrp: 'wj',
  addressFormat: 'p2wpkh',
};

describe('WOJAKCOIN_MAINNET parameters (WojakCoinProj/wojakcore src/chainparams.cpp)', () => {
  it('carries the exact verified base58 values', () => {
    const net = WOJAKCOIN_MAINNET;
    expect(net.pubKeyHash).toBe(73); // PUBKEY_ADDRESS -> 'W'
    expect(net.wif).toBe(201); // SECRET_KEY
    expect(net.coinType).toBe(20760); // SLIP-44 (satoshilabs/slips slip-0044.md)
    expect(net.defaultPort).toBe(20759); // nDefaultPort
    expect(net.messageMagic).toBe('Bitcoin Signed Message:\n'); // src/util/message.cpp
    expect(net.addressFormat).toBe('p2pkh');
    expect(net.ticker).toBe('WJK');
    expect(net.displayName).toBe('WojakCoin');
    expect(net.chainId).toBe('wojakcoin-mainnet');
    // Electrum server ROLE stays 'mainnet' (like RVN/BTGS/LTC); chainId is the identity.
    expect(net.id).toBe('mainnet');
  });

  it('records SCRIPT_ADDRESS 5 without letting it validate (Bitcoin ambiguity)', () => {
    // The verified value is preserved so provenance is not lost...
    expect(WOJAKCOIN_MAINNET.scriptHashLegacy).toBe(5); // SCRIPT_ADDRESS -> '3…'
    // ...but validation accepts NO P2SH form: 5 is Bitcoin's own P2SH prefix and
    // WojakCoin has no unambiguous second one (Litecoin migrated 5 -> 50).
    expect(WOJAKCOIN_MAINNET.scriptHash).toBe(NO_ACCEPTED_P2SH);
    // The sentinel works because a base58check version byte is always 0…255.
    expect(NO_ACCEPTED_P2SH).toBeLessThan(0);
    // Litecoin's handling is unchanged: it still accepts its CURRENT prefix.
    expect(LITECOIN_MAINNET.scriptHash).toBe(50);
    expect(LITECOIN_MAINNET.scriptHashLegacy).toBe(5);
  });

  it('uses the STANDARD Bitcoin BIP32 version bytes (unlike BTGS)', () => {
    // Guards against a future "tidy-up" that copies BTGS's non-standard 1F/E5.
    expect(WOJAKCOIN_MAINNET.bip32.public).toBe(0x0488b21e);
    expect(WOJAKCOIN_MAINNET.bip32.private).toBe(0x0488ade4);
    expect(WOJAKCOIN_MAINNET.bip32.public).not.toBe(BITCOINGOLD_MAINNET.bip32.public);
    expect(WOJAKCOIN_MAINNET.bip32.private).not.toBe(BITCOINGOLD_MAINNET.bip32.private);
    // Same bytes as the other standard chains, so xpub/xprv interop is plain.
    expect(WOJAKCOIN_MAINNET.bip32).toEqual(EVRMORE_MAINNET.bip32);
    expect(WOJAKCOIN_MAINNET.bip32).toEqual(LITECOIN_MAINNET.bip32);
  });

  it('resolves from its canonical chain id', () => {
    expect(networkFor('wojakcoin-mainnet')).toBe(WOJAKCOIN_MAINNET);
    // Adding WJK must not disturb the existing resolutions.
    expect(networkFor('mainnet')).toBe(EVRMORE_MAINNET);
    expect(networkFor('evrmore-mainnet')).toBe(EVRMORE_MAINNET);
    expect(networkFor('testnet')).toBe(networkFor('evrmore-testnet'));
    expect(networkFor('ravencoin-mainnet')).toBe(RAVENCOIN_MAINNET);
    expect(networkFor('bitcoingold-mainnet')).toBe(BITCOINGOLD_MAINNET);
    expect(networkFor('litecoin-mainnet')).toBe(LITECOIN_MAINNET);
  });

  it('is asset-free (capability flags, not chain names)', () => {
    // Verified live: WJK's ElectrumX servers are PLAIN 1.16.0 — no asset dialect.
    expect(supportsAssets(WOJAKCOIN_MAINNET)).toBe(false);
    expect(WOJAKCOIN_MAINNET.assetMarkerPrefix).toBeUndefined();
    // Any asset code path must fail loudly rather than emit an OP_x_ASSET script.
    expect(() => assetMarkerPrefixOf(WOJAKCOIN_MAINNET)).toThrow(/no asset protocol/i);
    // Unchanged for the existing chains.
    expect(supportsAssets(EVRMORE_MAINNET)).toBe(true);
    expect(supportsAssets(RAVENCOIN_MAINNET)).toBe(true);
    expect(supportsAssets(BITCOINGOLD_MAINNET)).toBe(false);
    expect(supportsAssets(LITECOIN_MAINNET)).toBe(false);
  });

  it('routes to the BIP44 purpose with coin type 20760', () => {
    expect(derivationPath(WOJAKCOIN_MAINNET, 0, 0, 0)).toBe("m/44'/20760'/0'/0/0");
    expect(derivationPath(WOJAKCOIN_MAINNET, 0, 1, 7)).toBe("m/44'/20760'/0'/1/7");
  });

  it('shares derivation with no other chain (its own SLIP-44 coin type)', () => {
    for (const other of OTHER_CHAINS) {
      expect(chainsShareDerivation('wojakcoin-mainnet', other.chainId)).toBe(false);
      expect(chainsShareDerivation(other.chainId, 'wojakcoin-mainnet')).toBe(false);
    }
    // The existing Evrmore <-> Ravencoin link (shared coinType 175) is untouched.
    expect(chainsShareDerivation('evrmore-mainnet', 'ravencoin-mainnet')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The whole point of this chain: segwit is DEFINED but NEVER ACTIVATED.
// consensus.SegwitHeight = INT_MAX, so nodes do not enforce witness rules and a
// P2WPKH output is a bare ANYONE-CAN-SPEND script. Funds sent to a 'wj1…'
// address could be swept by anyone, so the wallet must neither produce one nor
// pay to one.
// ---------------------------------------------------------------------------
describe('WojakCoin has NO segwit — bech32_hrp "wj" is a trap, not a feature', () => {
  it('declares no bech32Hrp, so supportsSegwit() is false', () => {
    expect(WOJAKCOIN_MAINNET.bech32Hrp).toBeUndefined();
    expect(supportsSegwit(WOJAKCOIN_MAINNET)).toBe(false);
    // Unchanged for the chains that really do have activated segwit.
    expect(supportsSegwit(BITCOINGOLD_MAINNET)).toBe(true);
    expect(supportsSegwit(LITECOIN_MAINNET)).toBe(true);
    expect(supportsSegwit(EVRMORE_MAINNET)).toBe(false);
    expect(supportsSegwit(RAVENCOIN_MAINNET)).toBe(false);
  });

  it('produces NO bech32 address for a key — every form is base58 P2PKH', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0);
    // The receive address is legacy, not bech32.
    expect(derived.address.startsWith('W')).toBe(true);
    expect(derived.address.startsWith('wj1')).toBe(false);
    expect(decodeSegwitAddress(derived.address)).toBeNull();
    // The chain-format-aware encoder agrees (it reads addressFormat, not a name).
    expect(pubkeyToAddress(derived.publicKey, WOJAKCOIN_MAINNET)).toBe(derived.address);
    expect(pubkeyToP2pkhAddress(derived.publicKey, WOJAKCOIN_MAINNET)).toBe(derived.address);
    // And asking for a segwit address outright is a hard error, not a silent wj1.
    expect(() => pubkeyToP2wpkhAddress(derived.publicKey, WOJAKCOIN_MAINNET)).toThrow(/no segwit/i);
  });

  it("REJECTS a checksum-valid 'wj1…' address as a recipient (funds-loss guard)", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0);
    // A REAL, well-formed wj1 address (built with the hrp chainparams defines), so
    // the rejection below is proven to come from "this chain has no segwit" and
    // not from a malformed string that would fail any decode.
    const wj1 = pubkeyToP2wpkhAddress(derived.publicKey, WOJAK_IF_SEGWIT_WERE_ACTIVE);
    expect(wj1.startsWith('wj1')).toBe(true);
    const decoded = decodeSegwitAddress(wj1);
    expect(decoded).not.toBeNull();
    expect(decoded!.hrp).toBe('wj');
    expect(decoded!.witnessVersion).toBe(0);
    expect(decoded!.program.length).toBe(20); // a genuine P2WPKH program

    // The send-path gate refuses it: on WojakCoin such an output is
    // anyone-can-spend, so the wallet must never pay to one.
    expect(isSpendableAddress(wj1, WOJAKCOIN_MAINNET)).toBe(false);
    // The lenient check refuses it too — it is not a WojakCoin address at all.
    expect(isValidAddress(wj1, WOJAKCOIN_MAINNET)).toBe(false);
    // And no other chain accepts it either (wrong hrp / no segwit).
    for (const other of OTHER_CHAINS) {
      expect(isSpendableAddress(wj1, other)).toBe(false);
    }
  });

  it('documents exactly what adding bech32Hrp would break', async () => {
    // This test does not assert current behaviour so much as PIN the danger: the
    // only difference between the real params and the trap variant is the hrp +
    // addressFormat, and that difference alone moves the wallet to BIP84 and makes
    // it hand out (and accept) wj1 addresses on a chain where they are stealable.
    expect(supportsSegwit(WOJAK_IF_SEGWIT_WERE_ACTIVE)).toBe(true);
    expect(derivationPath(WOJAK_IF_SEGWIT_WERE_ACTIVE, 0, 0, 0)).toBe("m/84'/20760'/0'/0/0");
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const trapAddress = deriveAddress(seed, WOJAK_IF_SEGWIT_WERE_ACTIVE, 0, 0, 0).address;
    expect(trapAddress.startsWith('wj1')).toBe(true);
    expect(isSpendableAddress(trapAddress, WOJAK_IF_SEGWIT_WERE_ACTIVE)).toBe(true);
    // The SHIPPED chain must be the safe one: legacy purpose, legacy address.
    expect(derivationPath(WOJAKCOIN_MAINNET, 0, 0, 0)).toBe("m/44'/20760'/0'/0/0");
    expect(isSpendableAddress(trapAddress, WOJAKCOIN_MAINNET)).toBe(false);
  });
});

describe('WojakCoin address derivation', () => {
  it('reproduces the OFFICIAL BIP44 Bitcoin vector with the same code path (coinType 0, version 0)', async () => {
    // Independent anchor: WojakCoin's BIP32 bytes and BIP44 scheme are Bitcoin's,
    // so swapping only coinType + pubKeyHash on WOJAKCOIN_MAINNET must yield the
    // published m/44'/0'/0'/0/0 address for this mnemonic. This proves the
    // standard version bytes, the 44' purpose selection and the base58check
    // encoder at once, without the test deriving its expectation from our params.
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const asBitcoin: EvrmoreNetwork = { ...WOJAKCOIN_MAINNET, coinType: 0, pubKeyHash: 0 };
    const derived = deriveAddress(seed, asBitcoin, 0, 0, 0);
    expect(derived.path).toBe("m/44'/0'/0'/0/0");
    expect(bytesToHex(derived.publicKey)).toBe(
      '03aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e',
    );
    expect(derived.address).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  });

  it("derives a 'W…' receive address at m/44'/20760'/0'/0/0", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0);
    expect(derived.path).toBe("m/44'/20760'/0'/0/0");
    expect(derived.address.startsWith('W')).toBe(true);
    // Regression fixture for this mnemonic (recomputed independently of the
    // params only by the anchor test above; pinned here so a version-byte or
    // coin-type edit cannot slip through unnoticed).
    expect(bytesToHex(derived.publicKey)).toBe(
      '03b8bdb49472e8590688f3314df3721673ecd4f7512d6d8db3abbe9bbe84cfae6a',
    );
    expect(derived.address).toBe('WQiBta4DKnS8UatUvRLpG2P67UcuZ6WNsr');
    // Version byte 73 is what makes it a 'W' address.
    expect(addressToHash160(derived.address).version).toBe(73);
    expect(isP2pkhAddress(derived.address, WOJAKCOIN_MAINNET)).toBe(true);
    expect(isValidAddress(derived.address, WOJAKCOIN_MAINNET)).toBe(true);
  });

  it('encodes WIF with SECRET_KEY 201', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0);
    const payload = b58c.decode(derived.wif);
    expect(payload[0]).toBe(201); // base58Prefixes[SECRET_KEY]
    const { privateKey, compressed } = decodeWif(derived.wif);
    expect(compressed).toBe(true);
    expect(privateKey).toEqual(derived.privateKey);
  });

  it('derives DIFFERENT key material than every other chain (coin type 20760)', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const wjk = deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0);
    for (const other of OTHER_CHAINS) {
      const derived = deriveAddress(seed, other, 0, 0, 0);
      expect(bytesToHex(wjk.privateKey)).not.toBe(bytesToHex(derived.privateKey));
    }
  });
});

describe('isSpendableAddress on WojakCoin (send-path safety gate)', () => {
  it('accepts its own P2PKH address', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const wjk = deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0).address;
    expect(isSpendableAddress(wjk, WOJAKCOIN_MAINNET)).toBe(true);
  });

  it('rejects EVR / RVN / BTGS / LTC addresses as WojakCoin recipients', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    for (const other of OTHER_CHAINS) {
      const foreign = deriveAddress(seed, other, 0, 0, 0).address;
      expect(isSpendableAddress(foreign, WOJAKCOIN_MAINNET)).toBe(false);
      expect(isValidAddress(foreign, WOJAKCOIN_MAINNET)).toBe(false);
    }
    // A Bitcoin bech32 must not pass either — this chain has no segwit at all.
    expect(
      isSpendableAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', WOJAKCOIN_MAINNET),
    ).toBe(false);
  });

  it('is rejected in the other direction on every existing chain', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const wjk = deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0).address;
    for (const other of OTHER_CHAINS) {
      expect(isSpendableAddress(wjk, other)).toBe(false);
      expect(isValidAddress(wjk, other)).toBe(false);
    }
  });

  it("never accepts a '3…' P2SH address, so Bitcoin's prefix cannot pass as WojakCoin", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const h160 = addressToHash160(deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0).address).hash;
    // WojakCoin's OWN P2SH form, built from its verified SCRIPT_ADDRESS = 5.
    const ownP2sh = b58c.encode(concatBytes(Uint8Array.of(5), h160));
    expect(ownP2sh.startsWith('3')).toBe(true);
    expect(addressToHash160(ownP2sh).version).toBe(WOJAKCOIN_MAINNET.scriptHashLegacy);

    // Deliberately NOT accepted: version byte 5 is Bitcoin's own P2SH prefix with
    // the same checksum algorithm, so honouring it would make every Bitcoin '3…'
    // address validate as WojakCoin. Failing closed is stricter than consensus,
    // never more permissive.
    expect(isValidAddress(ownP2sh, WOJAKCOIN_MAINNET)).toBe(false);
    // The canonical Bitcoin P2SH example address must not validate either.
    expect(isValidAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', WOJAKCOIN_MAINNET)).toBe(false);

    // The SEND path uses isSpendableAddress, which refuses every P2SH form on
    // every chain — the builder cannot construct a P2SH output — so the omitted
    // prefix can only refuse an address, never burn funds.
    expect(isSpendableAddress(ownP2sh, WOJAKCOIN_MAINNET)).toBe(false);
    expect(isSpendableAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', WOJAKCOIN_MAINNET)).toBe(false);
    // Litecoin's existing behaviour is untouched: it still accepts its 'M…' form.
    const ltcCurrent = b58c.encode(concatBytes(Uint8Array.of(50), h160));
    expect(isValidAddress(ltcCurrent, LITECOIN_MAINNET)).toBe(true);
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

describe("LiveWalletService with the 'wojakcoin-mainnet' network id", () => {
  beforeEach(() => {
    setStorageForTests(new MemoryStorageAdapter());
  });

  it('resolves WOJAKCOIN_MAINNET and derives the wallet its W address', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const expected = deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0).address;
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'wojakcoin-mainnet', 'WJK wallet');
    expect(svc.network()).toBe('wojakcoin-mainnet');
    expect(svc.getAddress(0)).toBe(expected);
    expect(svc.getAddress(0).startsWith('W')).toBe(true);
    // Never a bech32 address, even through the service path.
    expect(decodeSegwitAddress(svc.getAddress(0))).toBeNull();
    // The stored entry keeps the canonical id, so a reload resolves the chain.
    const [entry] = await svc.listWallets();
    expect(entry.network).toBe('wojakcoin-mainnet');
    expect(entry.address).toBe(expected);
  });

  it("refuses to build a send to a 'wj1…' recipient", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const wj1 = pubkeyToP2wpkhAddress(
      deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0).publicKey,
      WOJAK_IF_SEGWIT_WERE_ACTIVE,
    );
    const svc = new LiveWalletService(stubClient());
    await svc.import(TEST_MNEMONIC, 'pw', 'wojakcoin-mainnet', 'WJK wallet');
    // The gate runs before any network access, so the stub client is never used.
    await expect(svc.buildEvrSend(wj1, 1000n)).rejects.toThrow('unsupported-address-type');
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
  });
});
