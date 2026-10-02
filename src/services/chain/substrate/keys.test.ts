// keys.test.ts: the sr25519 derivation against every vector the design pins
// (bittensor-engine.md §2.3) plus the two rows Set A computed (passphrase
// pass-through, non-zero 24-word entropy), each cross-checked with
// polkadot.js in the same run (testing/fixtures.ts has the provenance).
//
// What the set distinguishes, so a wrong implementation cannot pass: the
// seed route instead of the entropy route (every address, and the explicit
// 5Eqg != 5EPC assertion), Ed25519 expansion mode instead of uniform (the
// raw mini-secret row), the wrong SS58 prefix or checksum (every address),
// hard versus soft derivation (the two Alice rows), the passphrase salt
// (the TREZOR rows) and the wrong signing context (the round trip).

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as sr25519 from '@scure/sr25519';
import {
  SubstrateKeyError,
  accountFromMiniSecret,
  accountFromMnemonic,
  deriveHard,
  deriveSoft,
  junctionChainCode,
  miniSecretFromMnemonic,
  publicKeyOfExpandedSecret,
  signSubstrate,
  verifySubstrate,
  zeroSubstrateAccount,
} from './keys';
import { ss58Encode } from './ss58';
import {
  ABANDON_12,
  ABANDON_12_SEED_ROUTE_SS58,
  DEV_PHRASE,
  HARD_CHILD_VECTORS,
  KEY_VECTORS,
  SOFT_ALICE_PUBLIC_KEY,
  SP_CORE_MINI_SECRET,
  SP_CORE_PUBLIC_KEY,
  SP_CORE_SEEDED_PUBLIC_KEY,
} from './testing/fixtures';

describe('miniSecretFromMnemonic (entropy route)', () => {
  for (const v of KEY_VECTORS.filter((v) => v.miniSecret)) {
    it(`${v.name}: PBKDF2 over the entropy with salt "mnemonic${v.passphrase}"`, () => {
      const mini = miniSecretFromMnemonic(v.mnemonic, v.passphrase);
      expect(mini.length).toBe(32);
      expect(bytesToHex(mini)).toBe(v.miniSecret);
    });
  }

  it('is not the BIP39 seed route: abandon-12 by the seed is 5Eqg..., by the entropy 5EPC...', () => {
    const seedRoute = mnemonicToSeedSync(ABANDON_12).slice(0, 32);
    const seedRouteAddress = ss58Encode(sr25519.getPublicKey(sr25519.secretFromSeed(seedRoute)));
    expect(seedRouteAddress).toBe(ABANDON_12_SEED_ROUTE_SS58);
    const entropyRouteAddress = accountFromMnemonic(ABANDON_12).address;
    expect(entropyRouteAddress).toBe('5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH');
    expect(entropyRouteAddress).not.toBe(seedRouteAddress);
    // and the mini secret itself differs from the seed's first 32 bytes
    expect(bytesToHex(miniSecretFromMnemonic(ABANDON_12))).not.toBe(bytesToHex(seedRoute));
  });

  it('refuses a phrase that is not valid BIP39 English, before any PBKDF2', () => {
    expect(() => miniSecretFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon')).toThrow(SubstrateKeyError);
    expect(() => miniSecretFromMnemonic('')).toThrow(SubstrateKeyError);
    expect(() => miniSecretFromMnemonic('not a phrase at all')).toThrow(SubstrateKeyError);
    expect(() => miniSecretFromMnemonic(ABANDON_12, 5 as unknown as string)).toThrow(SubstrateKeyError);
  });

  it('a passphrase changes the account (salt pass-through)', () => {
    expect(accountFromMnemonic(ABANDON_12, 'TREZOR').address).not.toBe(accountFromMnemonic(ABANDON_12).address);
    expect(accountFromMnemonic(ABANDON_12, '').address).toBe(accountFromMnemonic(ABANDON_12).address);
  });
});

describe('accountFromMnemonic (root, SS58 42)', () => {
  for (const v of KEY_VECTORS) {
    it(`${v.name}: ${v.ss58}`, () => {
      const account = accountFromMnemonic(v.mnemonic, v.passphrase);
      expect(bytesToHex(account.publicKey)).toBe(v.publicKey);
      expect(account.address).toBe(v.ss58);
      expect(account.miniSecret.length).toBe(32);
      if (v.miniSecret) expect(bytesToHex(account.miniSecret)).toBe(v.miniSecret);
      zeroSubstrateAccount(account);
    });
  }

  it('24 words with non-zero entropy are not the 16-byte path padded', () => {
    const v24 = KEY_VECTORS.find((v) => v.name === 'legal-winner-24')!;
    const first12 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    expect(accountFromMnemonic(v24.mnemonic).address).toBe(v24.ss58);
    expect(accountFromMnemonic(first12).address).not.toBe(v24.ss58);
  });

  it('honours an explicit SS58 prefix (the wallet only ever asks for 42)', () => {
    const polkadot = accountFromMnemonic(DEV_PHRASE, '', 0);
    expect(polkadot.address.startsWith('1')).toBe(true);
    expect(accountFromMnemonic(DEV_PHRASE).address.startsWith('5')).toBe(true);
    expect(bytesToHex(polkadot.publicKey)).toBe(bytesToHex(accountFromMnemonic(DEV_PHRASE).publicKey));
  });
});

describe('accountFromMiniSecret (published sp_core vectors)', () => {
  it('sr_test_vector_should_work: the raw mini secret expands in Ed25519 mode', () => {
    const account = accountFromMiniSecret(hexToBytes(SP_CORE_MINI_SECRET));
    expect(bytesToHex(account.publicKey)).toBe(SP_CORE_PUBLIC_KEY);
  });

  it('seeded_pair_should_work: the ASCII seed', () => {
    const account = accountFromMiniSecret(utf8ToBytes('12345678901234567890123456789012'));
    expect(bytesToHex(account.publicKey)).toBe(SP_CORE_SEEDED_PUBLIC_KEY);
  });

  it('copies the mini secret rather than keeping the caller\'s bytes', () => {
    const mini = hexToBytes(SP_CORE_MINI_SECRET);
    const account = accountFromMiniSecret(mini);
    expect(account.miniSecret).not.toBe(mini);
    mini.fill(0);
    expect(bytesToHex(account.miniSecret)).toBe(SP_CORE_MINI_SECRET);
  });

  it('refuses anything but 32 bytes', () => {
    expect(() => accountFromMiniSecret(new Uint8Array(31))).toThrow(SubstrateKeyError);
    expect(() => accountFromMiniSecret(new Uint8Array(64))).toThrow(SubstrateKeyError);
    expect(() => accountFromMiniSecret('9d61' as unknown as Uint8Array)).toThrow(SubstrateKeyError);
  });
});

describe('derivation junctions (not offered by v1, pinned for a later Account 2)', () => {
  for (const v of HARD_CHILD_VECTORS) {
    it(`hard ${v.junction} of "${v.mnemonic.split(' ').slice(0, 2).join(' ')}...": ${v.ss58}`, () => {
      const mini = miniSecretFromMnemonic(v.mnemonic);
      const child = deriveHard(mini, v.junction);
      expect(child.length).toBe(64);
      const publicKey = publicKeyOfExpandedSecret(child);
      if (v.publicKey) expect(bytesToHex(publicKey)).toBe(v.publicKey);
      expect(ss58Encode(publicKey)).toBe(v.ss58);
      child.fill(0);
      mini.fill(0);
    });
  }

  it('soft /Alice of DEV_PHRASE: sp_core derive_soft_known_pair_should_work', () => {
    const mini = miniSecretFromMnemonic(DEV_PHRASE);
    const child = deriveSoft(mini, '/Alice');
    expect(bytesToHex(publicKeyOfExpandedSecret(child))).toBe(SOFT_ALICE_PUBLIC_KEY);
    // and hard //Alice is a different key: the two Alice rows separate the modes
    expect(bytesToHex(publicKeyOfExpandedSecret(deriveHard(mini, '//Alice')))).not.toBe(SOFT_ALICE_PUBLIC_KEY);
  });

  it('accepts the bare junction and a number, refuses the wrong kind of slash', () => {
    const mini = miniSecretFromMnemonic(ABANDON_12);
    const a = ss58Encode(publicKeyOfExpandedSecret(deriveHard(mini, '//0')));
    expect(ss58Encode(publicKeyOfExpandedSecret(deriveHard(mini, '0')))).toBe(a);
    expect(ss58Encode(publicKeyOfExpandedSecret(deriveHard(mini, 0)))).toBe(a);
    expect(() => deriveHard(mini, '/0')).toThrow(SubstrateKeyError);
    expect(() => deriveSoft(mini, '//0')).toThrow(SubstrateKeyError);
    expect(() => deriveHard(mini, '//0//1')).toThrow(SubstrateKeyError);
    expect(() => deriveHard(mini, '')).toThrow(SubstrateKeyError);
  });

  it('chain codes: a number is u64 LE, a name is compact-length-prefixed utf8, both zero padded', () => {
    expect(bytesToHex(junctionChainCode(0))).toBe('00'.repeat(32));
    expect(bytesToHex(junctionChainCode('1'))).toBe('01' + '00'.repeat(31));
    expect(bytesToHex(junctionChainCode('Alice'))).toBe('14416c696365' + '00'.repeat(26));
    // longer than 32 bytes once prefixed: blake2b-256 of the encoding
    expect(junctionChainCode('a'.repeat(40)).length).toBe(32);
    expect(bytesToHex(junctionChainCode('a'.repeat(40)))).not.toContain('0000000000');
  });
});

describe('signing under the "substrate" context', () => {
  it('signs 64 bytes with the Schnorrkel marker and verifies; a changed message or key does not', () => {
    const account = accountFromMnemonic(ABANDON_12);
    const message = utf8ToBytes('satori go tao');
    const signature = signSubstrate(account.miniSecret, message);
    expect(signature.length).toBe(64);
    expect(signature[63] & 0x80).toBe(0x80);
    expect(verifySubstrate(account.publicKey, message, signature)).toBe(true);
    expect(verifySubstrate(account.publicKey, utf8ToBytes('satori go tao!'), signature)).toBe(false);
    expect(verifySubstrate(accountFromMnemonic(DEV_PHRASE).publicKey, message, signature)).toBe(false);
    const flipped = signature.slice();
    flipped[10] ^= 1;
    expect(verifySubstrate(account.publicKey, message, flipped)).toBe(false);
    // the raw library agrees (same context "substrate")
    expect(sr25519.verify(message, signature, account.publicKey)).toBe(true);
  });

  it('is deterministic with a fixed nonce seed and random without one', () => {
    const account = accountFromMnemonic(ABANDON_12);
    const message = utf8ToBytes('m');
    const random = new Uint8Array(32).fill(7);
    expect(bytesToHex(signSubstrate(account.miniSecret, message, random))).toBe(bytesToHex(signSubstrate(account.miniSecret, message, random)));
    expect(bytesToHex(signSubstrate(account.miniSecret, message))).not.toBe(bytesToHex(signSubstrate(account.miniSecret, message)));
  });

  it('verifySubstrate answers false, never throws, on malformed input', () => {
    const account = accountFromMnemonic(ABANDON_12);
    expect(verifySubstrate(account.publicKey, utf8ToBytes('m'), new Uint8Array(63))).toBe(false);
    expect(verifySubstrate(new Uint8Array(31), utf8ToBytes('m'), new Uint8Array(64))).toBe(false);
    expect(verifySubstrate(account.publicKey, utf8ToBytes('m'), new Uint8Array(64))).toBe(false);
  });

  it('refuses to sign with anything but a 32-byte mini secret', () => {
    expect(() => signSubstrate(new Uint8Array(64), utf8ToBytes('m'))).toThrow(SubstrateKeyError);
    expect(() => signSubstrate(new Uint8Array(32), 'm' as unknown as Uint8Array)).toThrow(SubstrateKeyError);
  });
});

describe('zeroSubstrateAccount', () => {
  it('zeroes the mini secret in place; a zeroed account cannot sign for the old key', () => {
    const account = accountFromMnemonic(ABANDON_12);
    const before = account.miniSecret.slice();
    expect(before.some((b) => b !== 0)).toBe(true);
    zeroSubstrateAccount(account);
    expect(account.miniSecret.every((b) => b === 0)).toBe(true);
    expect(account.publicKey.every((b) => b === 0)).toBe(true);
    const publicOfOld = accountFromMiniSecret(before).publicKey;
    const signature = signSubstrate(account.miniSecret, utf8ToBytes('m'));
    expect(verifySubstrate(publicOfOld, utf8ToBytes('m'), signature)).toBe(false);
  });
});
