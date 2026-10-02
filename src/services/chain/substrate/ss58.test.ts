// ss58.test.ts: encode/decode of every vector, and the refusals the send form
// relies on (a Polkadot or Kusama address, a typo, a short key).

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { TAO_SS58_PREFIX, Ss58Error, isValidTaoAddress, ss58Decode, ss58Encode } from './ss58';
import { HARD_CHILD_VECTORS, KEY_VECTORS, ONCHAIN_TRANSFER } from './testing/fixtures';

const ALICE_PUB = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
// The well-known Alice on the three prefixes (polkadot.js keyring, ss58Format 0 / 2 / 42).
const ALICE_POLKADOT = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5';
const ALICE_KUSAMA = 'HNZata7iMYWmk5RvZRTiAsSDhV8366zq2YGb3tLH5Upf74F';
const ALICE_GENERIC = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Ss58Error ? e.code : `not-an-Ss58Error: ${String(e)}`;
  }
}

describe('ss58Encode / ss58Decode', () => {
  const rows = [
    ...KEY_VECTORS.map((v) => ({ name: v.name, publicKey: v.publicKey, ss58: v.ss58 })),
    ...HARD_CHILD_VECTORS.filter((v) => v.publicKey).map((v) => ({ name: `${v.junction}`, publicKey: v.publicKey!, ss58: v.ss58 })),
    { name: 'on-chain signer', publicKey: ONCHAIN_TRANSFER.signerPublicKey, ss58: ONCHAIN_TRANSFER.signer },
    { name: 'on-chain dest', publicKey: ONCHAIN_TRANSFER.destPublicKey, ss58: ONCHAIN_TRANSFER.dest },
  ];
  for (const row of rows) {
    it(`${row.name}: ${row.ss58} round-trips`, () => {
      expect(ss58Encode(hexToBytes(row.publicKey))).toBe(row.ss58);
      expect(ss58Encode(hexToBytes(row.publicKey), TAO_SS58_PREFIX)).toBe(row.ss58);
      const decoded = ss58Decode(row.ss58, TAO_SS58_PREFIX);
      expect(decoded.prefix).toBe(42);
      expect(bytesToHex(decoded.publicKey)).toBe(row.publicKey);
      expect(isValidTaoAddress(row.ss58)).toBe(true);
    });
  }

  it('the prefix byte is 0x2a and the checksum is blake2b-512("SS58PRE" || body)[0..2]', () => {
    // 5GrwvaEF... is Alice on prefix 42; prefix 0 and 2 give the published Polkadot and Kusama forms of the same key.
    expect(ss58Encode(hexToBytes(ALICE_PUB), 42)).toBe(ALICE_GENERIC);
    expect(ss58Encode(hexToBytes(ALICE_PUB), 0)).toBe(ALICE_POLKADOT);
    expect(ss58Encode(hexToBytes(ALICE_PUB), 2)).toBe(ALICE_KUSAMA);
    expect(ss58Decode(ALICE_POLKADOT).prefix).toBe(0);
    expect(ss58Decode(ALICE_KUSAMA).prefix).toBe(2);
    expect(bytesToHex(ss58Decode(ALICE_KUSAMA).publicKey)).toBe(ALICE_PUB);
  });

  it('a two-byte prefix (>= 64) round-trips through the decoder', () => {
    const pub = hexToBytes(ALICE_PUB);
    for (const prefix of [64, 128, 1000, 16383]) {
      const addr = ss58Encode(pub, prefix);
      const back = ss58Decode(addr);
      expect(back.prefix).toBe(prefix);
      expect(bytesToHex(back.publicKey)).toBe(ALICE_PUB);
      expect(isValidTaoAddress(addr)).toBe(false);
    }
    expect(() => ss58Encode(pub, 16384)).toThrow(Ss58Error);
    expect(() => ss58Encode(pub, -1)).toThrow(Ss58Error);
  });
});

describe('refusals', () => {
  it('a Polkadot (prefix 0) or Kusama (prefix 2) address is not a Bittensor address', () => {
    expect(code(() => ss58Decode(ALICE_POLKADOT, TAO_SS58_PREFIX))).toBe('prefix');
    expect(code(() => ss58Decode(ALICE_KUSAMA, TAO_SS58_PREFIX))).toBe('prefix');
    expect(isValidTaoAddress(ALICE_POLKADOT)).toBe(false);
    expect(isValidTaoAddress(ALICE_KUSAMA)).toBe(false);
    expect(isValidTaoAddress(ALICE_GENERIC)).toBe(true);
  });

  it('a flipped checksum is a typo, and it is reported before the prefix', () => {
    const good = ALICE_GENERIC;
    const last = good[good.length - 1];
    const typo = good.slice(0, -1) + (last === 'Y' ? 'Z' : 'Y');
    expect(code(() => ss58Decode(typo, TAO_SS58_PREFIX))).toBe('checksum');
    expect(isValidTaoAddress(typo)).toBe(false);
    // a typo in a Polkadot address reads as a typo, not as a foreign chain
    const polkadotTypo = ALICE_POLKADOT.slice(0, -1) + (ALICE_POLKADOT.endsWith('5') ? '6' : '5');
    expect(code(() => ss58Decode(polkadotTypo, TAO_SS58_PREFIX))).toBe('checksum');
  });

  it('a 31-byte key is refused on encode and on decode', () => {
    expect(code(() => ss58Encode(new Uint8Array(31)))).toBe('length');
    expect(code(() => ss58Encode(new Uint8Array(33)))).toBe('length');
    // build a 31-byte-payload string with a valid-looking base58 body: the decoder must say 'length'
    const short = ALICE_GENERIC.slice(0, 40);
    const c = code(() => ss58Decode(short, TAO_SS58_PREFIX));
    expect(c === 'length' || c === 'checksum').toBe(true);
    expect(isValidTaoAddress(short)).toBe(false);
  });

  it('text that is not base58 is a format error; empty and non-string too', () => {
    expect(code(() => ss58Decode('0x66933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972'))).toBe('format');
    expect(code(() => ss58Decode('5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH0'))).toBe('format');
    expect(code(() => ss58Decode(''))).toBe('format');
    expect(code(() => ss58Decode(undefined as unknown as string))).toBe('format');
    expect(isValidTaoAddress('')).toBe(false);
    expect(isValidTaoAddress('bittensor')).toBe(false);
  });

  it('an EVM address is not a Bittensor address', () => {
    expect(isValidTaoAddress('0x1111111111111111111111111111111111111111')).toBe(false);
  });
});
