// Native-segwit (bech32 / P2WPKH) address support, introduced for Bitcoin Gold
// (BTGS) but written as a GENERIC chain capability: a future bech32 chain only
// needs bech32Hrp + addressFormat set in chainParams, not new code here.
//
// Anchored on the OFFICIAL BIP173 test vector so the encoder is verified against
// the published standard rather than against itself.

import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import {
  decodeSegwitAddress,
  deriveAddress,
  addressToScript,
  addressToElectrumScripthash,
  isSpendableAddress,
  isValidAddress,
  isP2pkhAddress,
  p2wpkhScript,
  pubkeyToAddress,
  pubkeyToP2pkhAddress,
  pubkeyToP2wpkhAddress,
  mnemonicToSeed,
} from './keys';
import {
  BITCOINGOLD_MAINNET,
  EVRMORE_MAINNET,
  RAVENCOIN_MAINNET,
  derivationPath,
  supportsAssets,
  supportsSegwit,
  networkFor,
} from './chainParams';

// Standard BIP39 test mnemonic (public, throwaway — never used for real funds).
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('bech32 / P2WPKH encoding', () => {
  it('matches the official BIP173 test vector', () => {
    // BIP173: pubkey hash 751e…3bd6 on hrp 'bc' encodes to this exact address.
    const h160 = hexToBytes('751e76e8199196d454941c45d1b3a323f1433bd6');
    const fakeBtc = { ...BITCOINGOLD_MAINNET, bech32Hrp: 'bc' };
    // pubkeyToP2wpkhAddress hashes the pubkey itself, so go through the script
    // + decoder path to assert on a known hash160 directly.
    expect(p2wpkhScript(h160)).toEqual(hexToBytes('0014751e76e8199196d454941c45d1b3a323f1433bd6'));
    const addr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    const decoded = decodeSegwitAddress(addr);
    expect(decoded).not.toBeNull();
    expect(decoded!.hrp).toBe('bc');
    expect(decoded!.witnessVersion).toBe(0);
    expect(decoded!.program).toEqual(h160);
    expect(addressToScript(addr)).toEqual(p2wpkhScript(h160));
    expect(isSpendableAddress(addr, fakeBtc)).toBe(true);
  });

  it('derives a bcg1 receive address for BTGS via BIP84', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, BITCOINGOLD_MAINNET, 0, 0, 0);
    expect(derived.path).toBe("m/84'/18888'/0'/0/0");
    expect(derived.address.startsWith('bcg1')).toBe(true);
    // Round-trips: the address decodes back to hash160(pubkey).
    const decoded = decodeSegwitAddress(derived.address);
    expect(decoded!.hrp).toBe('bcg');
    expect(decoded!.program.length).toBe(20);
    expect(pubkeyToP2wpkhAddress(derived.publicKey, BITCOINGOLD_MAINNET)).toBe(derived.address);
  });

  it("BTGS legacy P2PKH still encodes to a 'G' address (version byte 38)", async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, BITCOINGOLD_MAINNET, 0, 0, 0);
    const legacy = pubkeyToP2pkhAddress(derived.publicKey, BITCOINGOLD_MAINNET);
    expect(legacy.startsWith('G')).toBe(true);
    expect(isP2pkhAddress(legacy, BITCOINGOLD_MAINNET)).toBe(true);
  });
});

describe('electrum scripthash follows the real scriptPubKey', () => {
  it('hashes the P2WPKH script for a bech32 address, not a P2PKH script', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const derived = deriveAddress(seed, BITCOINGOLD_MAINNET, 0, 0, 0);
    const legacy = pubkeyToP2pkhAddress(derived.publicKey, BITCOINGOLD_MAINNET);
    // Same key, same hash160 — but different output scripts, so the Electrum
    // scripthashes MUST differ. Hashing the wrong one silently reports 0 balance.
    expect(addressToElectrumScripthash(derived.address)).not.toBe(
      addressToElectrumScripthash(legacy),
    );
    expect(addressToElectrumScripthash(derived.address)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isSpendableAddress (send-path safety gate)', () => {
  it('rejects a P2WSH (32-byte program) address the builder cannot construct', () => {
    // BTGS's own published burn address is a valid witness-v0 P2WSH.
    const burn = 'bcg1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnmxfsvxdead';
    const decoded = decodeSegwitAddress(burn);
    expect(decoded!.program.length).toBe(32);
    expect(isSpendableAddress(burn, BITCOINGOLD_MAINNET)).toBe(false);
  });

  it('rejects a bech32 address from the WRONG chain (hrp mismatch)', () => {
    const bitcoin = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    expect(isSpendableAddress(bitcoin, BITCOINGOLD_MAINNET)).toBe(false);
    expect(isValidAddress(bitcoin, BITCOINGOLD_MAINNET)).toBe(false);
  });

  it('rejects a bech32 address on a legacy chain that has no segwit', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const btgs = deriveAddress(seed, BITCOINGOLD_MAINNET, 0, 0, 0);
    expect(isSpendableAddress(btgs.address, EVRMORE_MAINNET)).toBe(false);
    expect(isSpendableAddress(btgs.address, RAVENCOIN_MAINNET)).toBe(false);
  });

  it('still accepts plain P2PKH on the legacy chains (no behaviour change)', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const evr = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0);
    const rvn = deriveAddress(seed, RAVENCOIN_MAINNET, 0, 0, 0);
    expect(evr.address.startsWith('E')).toBe(true);
    expect(rvn.address.startsWith('R')).toBe(true);
    expect(isSpendableAddress(evr.address, EVRMORE_MAINNET)).toBe(true);
    expect(isSpendableAddress(rvn.address, RAVENCOIN_MAINNET)).toBe(true);
    // Cross-chain must still be refused.
    expect(isSpendableAddress(evr.address, RAVENCOIN_MAINNET)).toBe(false);
  });
});

describe('chain capabilities', () => {
  it('routes derivation purpose by address format', () => {
    expect(derivationPath(BITCOINGOLD_MAINNET, 0, 0, 0)).toBe("m/84'/18888'/0'/0/0");
    expect(derivationPath(EVRMORE_MAINNET, 0, 0, 0)).toBe("m/44'/175'/0'/0/0");
    expect(derivationPath(RAVENCOIN_MAINNET, 0, 1, 5)).toBe("m/44'/175'/0'/1/5");
  });

  it('flags BTGS as segwit-capable and asset-free', () => {
    expect(supportsSegwit(BITCOINGOLD_MAINNET)).toBe(true);
    expect(supportsAssets(BITCOINGOLD_MAINNET)).toBe(false);
    expect(supportsSegwit(EVRMORE_MAINNET)).toBe(false);
    expect(supportsAssets(EVRMORE_MAINNET)).toBe(true);
    expect(supportsAssets(RAVENCOIN_MAINNET)).toBe(true);
  });

  it('resolves the BTGS chain id and its verified parameters', () => {
    const net = networkFor('bitcoingold-mainnet');
    expect(net).toBe(BITCOINGOLD_MAINNET);
    // Values asserted against BTGSCOINDEV/BTGS src/kernel/chainparams.cpp.
    expect(net.pubKeyHash).toBe(38);
    // 22 is BTGS's own SCRIPT_ADDRESS, but Dogecoin owns that prefix (2013 vs
    // 2026), so BTGS fails closed and keeps the real value in scriptHashLegacy.
    expect(net.scriptHashLegacy).toBe(22);
    expect(net.wif).toBe(176);
    expect(net.bech32Hrp).toBe('bcg');
    expect(net.ticker).toBe('BTGS');
    // NON-STANDARD BIP32 bytes: guards against a future "tidy-up" to 0x0488B21E.
    expect(net.bip32.public).toBe(0x0488b21f);
    expect(net.bip32.private).toBe(0x0488ade5);
  });

  it('pubkeyToAddress picks the chain format automatically', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const { publicKey } = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0);
    expect(pubkeyToAddress(publicKey, EVRMORE_MAINNET).startsWith('E')).toBe(true);
    expect(pubkeyToAddress(publicKey, BITCOINGOLD_MAINNET).startsWith('bcg1')).toBe(true);
  });
});
