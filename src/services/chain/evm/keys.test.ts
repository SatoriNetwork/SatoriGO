import { describe, it, expect } from 'vitest';
import * as secp256k1 from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { mnemonicToSeed } from '../keys';
import {
  EVM_COIN_TYPE,
  deriveEvmKey,
  evmDerivationPath,
  isEvmAddress,
  isSameEvmAddress,
  normalizeEvmAddress,
  privateKeyToEvmKey,
  publicKeyToEvmAddress,
  toChecksumAddress,
} from './keys';

// The Trezor/BIP39 all-"abandon" mnemonic with an EMPTY passphrase. This is the
// seed every EVM tool demos with, so the two addresses below are published in
// dozens of places (MetaMask, ethers, hardhat's default accounts) and can be
// checked against a wallet that has nothing to do with this code. They are the
// ground truth: if this module disagrees, this module is wrong.
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ADDRESS_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const VECTOR_ADDRESS_1 = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const VECTOR_PRIVATE_KEY_0 = '1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727';

function vectorSeed(): Promise<Uint8Array> {
  // EMPTY passphrase, unlike the UTXO tests which use the "TREZOR" vector. A
  // passphrase changes the seed and therefore every address below.
  return mnemonicToSeed(VECTOR_MNEMONIC, '');
}

describe('EVM derivation path', () => {
  it('1. is m/44\'/60\'/0\'/0/index for the whole family', () => {
    expect(EVM_COIN_TYPE).toBe(60);
    expect(evmDerivationPath(0)).toBe("m/44'/60'/0'/0/0");
    expect(evmDerivationPath(1)).toBe("m/44'/60'/0'/0/1");
    expect(evmDerivationPath(2147483647)).toBe("m/44'/60'/0'/0/2147483647");
  });

  it('2. rejects a negative, fractional or hardened index', () => {
    expect(() => evmDerivationPath(-1)).toThrow();
    expect(() => evmDerivationPath(0.5)).toThrow();
    // 2^31 is the hardened offset: a non-hardened child index must stay below it.
    expect(() => evmDerivationPath(2147483648)).toThrow();
    expect(() => evmDerivationPath(Number.NaN)).toThrow();
    expect(() => evmDerivationPath(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('EVM key derivation', () => {
  it('3. reproduces the published abandon-mnemonic addresses at index 0 and 1', async () => {
    const seed = await vectorSeed();

    const key0 = deriveEvmKey(seed, 0);
    expect(key0.path).toBe("m/44'/60'/0'/0/0");
    expect(key0.index).toBe(0);
    expect(bytesToHex(key0.privateKey)).toBe(VECTOR_PRIVATE_KEY_0);
    expect(key0.address).toBe(VECTOR_ADDRESS_0);

    const key1 = deriveEvmKey(seed, 1);
    expect(key1.path).toBe("m/44'/60'/0'/0/1");
    expect(key1.address).toBe(VECTOR_ADDRESS_1);
  });

  it('4. returns the UNCOMPRESSED 65-byte public key', async () => {
    const seed = await vectorSeed();
    const key = deriveEvmKey(seed, 0);
    expect(key.privateKey.length).toBe(32);
    expect(key.publicKey.length).toBe(65);
    expect(key.publicKey[0]).toBe(0x04);
  });

  it('5. is deterministic, and index 0 and 1 are different accounts', async () => {
    const seed = await vectorSeed();
    const a = deriveEvmKey(seed, 0);
    const b = deriveEvmKey(seed, 0);
    expect(bytesToHex(b.privateKey)).toBe(bytesToHex(a.privateKey));
    expect(b.address).toBe(a.address);

    const other = deriveEvmKey(seed, 1);
    expect(other.address).not.toBe(a.address);
    expect(bytesToHex(other.privateKey)).not.toBe(bytesToHex(a.privateKey));
  });

  it('6. derives the generator-point address from private key 1', () => {
    // secp256k1's smallest legal scalar, so the public key is G itself and the
    // address is a well-known constant.
    const key = privateKeyToEvmKey(
      hexToBytes('0000000000000000000000000000000000000000000000000000000000000001'),
    );
    expect(key.address).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
    expect(key.path).toBe('imported');
    expect(key.index).toBe(0);
  });

  it('7. refuses a private key that is not 32 bytes', () => {
    expect(() => privateKeyToEvmKey(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => privateKeyToEvmKey(new Uint8Array(33))).toThrow(/32 bytes/);
  });
});

describe('public key to address', () => {
  it('8. gives the same address for the compressed and uncompressed encoding', async () => {
    const seed = await vectorSeed();
    const key = deriveEvmKey(seed, 0);
    const compressed = secp256k1.getPublicKey(key.privateKey, true);
    expect(compressed.length).toBe(33);

    expect(publicKeyToEvmAddress(key.publicKey)).toBe(VECTOR_ADDRESS_0);
    expect(publicKeyToEvmAddress(compressed)).toBe(VECTOR_ADDRESS_0);
  });

  it('9. THE TRAP: hashing the compressed key, or keeping the 0x04 prefix, gives a different address', async () => {
    const seed = await vectorSeed();
    const key = deriveEvmKey(seed, 0);
    const compressed = secp256k1.getPublicKey(key.privateKey, true);

    // Both wrong variants are computed here rather than imported, so the test
    // documents exactly what "close but not the user's account" looks like.
    // Wrong 1: keccak over the 33-byte COMPRESSED key.
    const fromCompressed = toChecksumAddress(bytesToHex(keccak_256(compressed).subarray(12)));
    // Wrong 2: keccak over the 65-byte key WITH its 0x04 prefix still attached.
    const withPrefix = toChecksumAddress(bytesToHex(keccak_256(key.publicKey).subarray(12)));

    // Each is a perfectly well-formed, checksummed address. That is the danger:
    // nothing downstream can tell it is the wrong one, and coins sent there are
    // gone.
    expect(isEvmAddress(fromCompressed)).toBe(true);
    expect(isEvmAddress(withPrefix)).toBe(true);

    expect(key.address).toBe(VECTOR_ADDRESS_0);
    expect(fromCompressed).not.toBe(VECTOR_ADDRESS_0);
    expect(withPrefix).not.toBe(VECTOR_ADDRESS_0);
    expect(fromCompressed).not.toBe(withPrefix);
  });

  it('10. refuses a public key that is neither 33 nor 65 bytes, or off the curve', () => {
    expect(() => publicKeyToEvmAddress(new Uint8Array(64))).toThrow(/65 bytes|33 bytes/);
    // 65 bytes but the prefix says "compressed, y even", which is not an
    // uncompressed encoding at all.
    const badPrefix = new Uint8Array(65);
    badPrefix[0] = 0x02;
    expect(() => publicKeyToEvmAddress(badPrefix)).toThrow(/0x04/);
    // Right shape, right prefix, coordinates that are not on secp256k1.
    const offCurve = new Uint8Array(65);
    offCurve[0] = 0x04;
    offCurve[64] = 0x01;
    expect(() => publicKeyToEvmAddress(offCurve)).toThrow(/secp256k1/);
  });
});

describe('EIP-55 checksum', () => {
  // The vectors from EIP-55 itself. All-caps and all-lower forms are included
  // because their checksummed form happens to equal themselves, which is the
  // property that makes "is it already checksummed?" not a case test.
  const MIXED_CASE = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];
  const ALL_CAPS = [
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
  ];
  const ALL_LOWER = [
    '0xde709f2102306220921060314715629080e2fb77',
    '0x27b1fdb04752bbc536007a920d24acb045561c26',
  ];

  it('11. checksums the EIP-55 mixed-case vectors from their lowercase form', () => {
    for (const address of MIXED_CASE) {
      expect(toChecksumAddress(address.toLowerCase())).toBe(address);
      // Idempotent, and case-insensitive on the way in.
      expect(toChecksumAddress(address)).toBe(address);
      expect(toChecksumAddress(address.toUpperCase().replace('0X', '0x'))).toBe(address);
    }
  });

  it('12. leaves the all-caps and all-lower vectors equal to themselves', () => {
    for (const address of [...ALL_CAPS, ...ALL_LOWER]) {
      expect(toChecksumAddress(address)).toBe(address);
    }
  });

  it('13. accepts input with or without the 0x prefix', () => {
    expect(toChecksumAddress('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(MIXED_CASE[0]);
    expect(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(MIXED_CASE[0]);
    expect(toChecksumAddress('0X5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED')).toBe(MIXED_CASE[0]);
  });

  it('14. throws on anything that is not 40 hex characters', () => {
    expect(() => toChecksumAddress('')).toThrow();
    expect(() => toChecksumAddress('0x')).toThrow();
    expect(() => toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beae')).toThrow();
    expect(() => toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaedd')).toThrow();
    expect(() => toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeg')).toThrow();
  });
});

describe('address validation', () => {
  const LOWER = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
  const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const UPPER = '0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED';
  // The checksummed form with ONE letter's case flipped (5a -> 5A). Every hex
  // digit is still valid, so only the EIP-55 checksum can catch it.
  const WRONG_CHECKSUM = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

  it('15. accepts all-lower, all-upper and correctly checksummed addresses', () => {
    expect(isEvmAddress(LOWER)).toBe(true);
    expect(isEvmAddress(UPPER)).toBe(true);
    expect(isEvmAddress(CHECKSUMMED)).toBe(true);
  });

  it('16. REJECTS a mixed-case address whose checksum is wrong', () => {
    // A typo on EVM is a valid destination nobody controls, so this must fail
    // closed rather than fall back to a case-insensitive compare.
    expect(isEvmAddress(WRONG_CHECKSUM)).toBe(false);
    expect(() => normalizeEvmAddress(WRONG_CHECKSUM)).toThrow(/invalid EVM address/);
  });

  it('17. rejects a missing 0x, the wrong length, and non-hex characters', () => {
    expect(isEvmAddress('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(false);
    expect(isEvmAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beae')).toBe(false); // 39
    expect(isEvmAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaedd')).toBe(false); // 41
    expect(isEvmAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeg')).toBe(false);
    expect(isEvmAddress('')).toBe(false);
    expect(isEvmAddress('0x')).toBe(false);
    expect(isEvmAddress('0X5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(false);
  });

  it('18. normalizeEvmAddress returns the checksummed form', () => {
    expect(normalizeEvmAddress(LOWER)).toBe(CHECKSUMMED);
    expect(normalizeEvmAddress(UPPER)).toBe(CHECKSUMMED);
    expect(normalizeEvmAddress(CHECKSUMMED)).toBe(CHECKSUMMED);
    expect(() => normalizeEvmAddress('nonsense')).toThrow(/invalid EVM address/);
  });

  it('19. isSameEvmAddress ignores case but never compares invalid strings', () => {
    expect(isSameEvmAddress(LOWER, CHECKSUMMED)).toBe(true);
    expect(isSameEvmAddress(UPPER, LOWER)).toBe(true);
    expect(isSameEvmAddress(CHECKSUMMED, VECTOR_ADDRESS_0)).toBe(false);
    // Both sides must be valid: two typos are not "the same address".
    expect(isSameEvmAddress(WRONG_CHECKSUM, WRONG_CHECKSUM)).toBe(false);
    expect(isSameEvmAddress('', '')).toBe(false);
  });
});
