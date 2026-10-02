// address.test.ts: subaddress derivation against the published vectors, and
// the decoder the send form relies on to refuse a wrong destination.
//
// (The 0/1, 0/2, 1/0 and 1/1 subaddresses of every vectors_final.json row
// are pinned in keys.test.ts next to the row they belong to.)

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  MONERO_ADDRESS_PREFIXES,
  MoneroAddressError,
  decodeMoneroAddress,
  integratedAddress,
  isValidMoneroAddress,
  primaryAddress,
  subaddress,
} from './address';
import { moneroBase58Decode, moneroBase58Encode } from './base58';
import { moneroKeysFromLegacyWords, moneroKeysFromSpendKey, type MoneroNetwork } from './keys';

const VELVET =
  'velvet lymph giddy number token physics poetry unquoted nibs useful sabotage limits benches lifestyle eden nitrogen anvil fewest avoid batch vials washing fences goat unquoted';
const VELVET_PRIMARY =
  '42ey1afDFnn4886T7196doS9GPMzexD9gXpsZJDwVjeRVdFCSoHnv7KPbBeGpzJBzHRCAs9UxqeoyFQMYbqSWYTfJJQAWDm';

// monero-python test_seed.py; spendPub 4ee576f5..., viewPub e1ef99d6...
const PY_PRIMARY =
  '44cWztNFdAqNnycvZbUoj44vsbAEmKnx9aNgkjHdjtMsBrSeKiY8J4s2raH7EMawA2Fwo9utaRTV7Aw8EcTMNMxhH4YtKdH';

/** Re-wrap a decoded payload with a fresh checksum, to build malformed-but-checksummed inputs. */
function withChecksum(body: Uint8Array): string {
  const full = new Uint8Array(body.length + 4);
  full.set(body);
  full.set(keccak_256(body).subarray(0, 4), body.length);
  return moneroBase58Encode(full);
}

describe('PUBLISHED: monero-project tests/functional_tests/wallet.py subaddresses (velvet lymph)', () => {
  const k = moneroKeysFromLegacyWords(VELVET);
  const want: Record<string, string> = {
    '0/1': '84QRUYawRNrU3NN1VpFRndSukeyEb3Xpv8qZjjsoJZnTYpDYceuUTpog13D7qPxpviS7J29bSgSkR11hFFoXWk2yNdsR9WF',
    '1/0': '82pP87g1Vkd3LUMssBCumk3MfyEsFqLAaGDf6oxddu61EgSFzt8gCwUD4tr3kp9TUfdPs2CnpD7xLZzyC1Ei9UsW3oyCWDf',
    '1/1': '87qyoPVaEcWikVBmG1TaP1KumZ3hB3Q5f4wZRjuppNdwYjWzs2RgbLYQgtpdu2YdoTT3EZhiUGaPJQt2FsykeFZbCtaGXU4',
    '1/2': '87KfgTZ8ER5D3Frefqnrqif11TjVsTPaTcp37kqqKMrdDRUhpJRczeR7KiBmSHF32UJLP3HHhKUDmEQyJrv2mV8yFDCq8eB',
    '2/0': '8Bdb75y2MhvbkvaBnG7vYP6DCNneLWcXqNmfPmyyDkavAUUgrHQEAhTNK3jEq69kGPDrd3i5inPivCwTvvA12eQ4SJk9iyy',
    '0/999': '8BQKgTSSqJjP14AKnZUBwnXWj46MuNmLvHfPTpmry52DbfNjjHVvHUk4mczU8nj8yZ57zBhksTJ8kM5xKeJXw55kCMVqyG7',
  };
  it('primary address (0,0)', () => {
    expect(primaryAddress(k)).toBe(VELVET_PRIMARY);
    expect(subaddress(k, 0, 0)).toBe(VELVET_PRIMARY);
  });
  for (const [idx, addr] of Object.entries(want)) {
    it(`subaddress ${idx}`, () => {
      const [major, minor] = idx.split('/').map(Number);
      expect(subaddress(k, major, minor)).toBe(addr);
    });
  }
});

describe('PUBLISHED: bip_utils tests/monero/test_monero.py subaddresses', () => {
  const sets: Array<{ spend: string; net: MoneroNetwork; primary: string; subs: Record<string, string> }> = [
    {
      spend: 'b6514a29ff612189af1bba250606bb5b1e7846fe8f31a91fc0beb393cddb6101',
      net: 'mainnet',
      primary: '43XWXXDCyHwQ2oZtBc8LUm4pAs5koPg2kdBHgwQNJBKRNxbwRnYufB5CeQvnbkGiWE4thv1A7GptxGVDDPN4d8ehNpQv99J',
      subs: {
        '0/1': '87QhdsHjCjMdWax6htvM7P2jFP9JAVC2eUpFiVdewQSpPbg1M4WPVCdHvvxH18WgyDTkfQVCNQ8j23oBhJYoBEQiF8onTRb',
        '1/0': '82tUn7VxgpfYdsjn8PygwLf8PyvinAGoEZxVG98d1FEsVVqUsWkJBL92NMUJ28hkGDdsZNCdcPH7McwSDxKYQ2UX1sHnDqD',
        '1/1': '87XnCr9zqmpbkkydpbafUtbRbRrCwTRfKD9hRs387BCF4aFqJ9d3wRiEzstySVgcMuio513aEpgxKMQtyvy1HaHSUbb18ad',
      },
    },
    {
      spend: '2c9623882df4940a734b009e0732ce5a8de7a62c4c1a2a53767a8f6c04874117', // unreduced on purpose
      net: 'mainnet',
      primary: '4B23epeYLCj3aCTG8X83ZM1xunHBjWEB5jmzM1zfrAKcGokjBPvS7eAcadEQZEgDhDeweod9KEZ5L2mXYVthxdxy3CQiRDK',
      subs: {
        '0/1': '89EpSrB4wKB3UrLk8Zf4dHhvcfo1TqVfR6PAE8WPtwK9YuJhiEaU49y8w9fBaCTPUSCmaYTQbD3LhgbkHriuQLgDMM1dpsk',
        '1/0': '87zT4PHnBDUJodyx5gzbenceaByre9ijiHa9FkZnu2yJP2xLEv9ivMTcLtkzaFp6pffWwcZ2htGU94VGiXMsR67q9yenKYT',
        '1/1': '88gNnRiJ4q9BrcsaxoTxFMPeVHPuZELNwTZgqSNwbRKv9gSbfzJDgyKB1sKsH81mGVN991LaAaN9f5v8orhk6Yf64F2XmT8',
      },
    },
    {
      spend: 'b4d9eab56043b1f0ac82affae32cd58049536d2289ec948502076961ae7da50e',
      net: 'stagenet',
      primary: '5Aro6RZf2gc9AZGHkyVLkvU4Qonc8yQ8fR4PZTy9haCVe6NHSMH4TtNLyWhovaP75PFDSUC9cAML7MAGhXS56o16H7BmpEP',
      subs: {
        '0/1': '74oX2Dpt1g53S1AUVmcitNMaatEtSw4P79gi4Dnk8dYH7BAS9PFbcrQA27WWLurvzR9hL87soCikrb8oNvuW7bL8K2YVwh5',
        '1/0': '7BKMWuYs9JTbFsjQzDA2aB4orcscsgUY2ZyWVKpRCbZwVNBCjwpyFSqQDYp7mHE4oGRQDWJwj1KFJeEK1mF4397a8swKjK8',
        '1/1': '75VAUvDcD6mfSt61BgEhh7QxH3FxC1LoAawp3fM9nL4eS6a3ZXPzjq9j2fojYsurn4PtPBRJfnhg1J1NFnupHEyZLLbbKJC',
      },
    },
    {
      spend: 'a52d32df742c7ecf639be062ef4cd3d726117645542693fbfc44f5a186724307',
      net: 'testnet',
      primary: '9zSaACcBx3HbeizJiyvY5USNcoMNtPiQvExkCKzBGJQqA1xpKhWGjDjDQnzBbubxx3i51d9mZCNvrSHcQVRUAK3H2HmhC9w',
      subs: {
        '0/1': 'BgZvFFW75akXq6MUHv67NEaFoHoC1F8LM9djSm6akiV6azL1nv6xh949NwQQZYM438cBUWWjFHaUjSpgA9MtUhNdBZC4Mvw',
        '1/0': 'BbwepBiPBYUjCb6tF9d3a4Xi9y9FGgUMvEUh3hJcxqDBFNjmtHULoTiBzGHK9q6y3ZC7pzCUtNP9ueqmNXpMk6reQnCHMd7',
        '1/1': 'Bazi9dJJc9g4A4wmgGKFEGKUhEpTH2jeqhPccxDiR8qRE3BXAn5c3qMKxiJZVSBFNP5jiM1uyBj94B93msJZDFzG8GV8NQ4',
      },
    },
  ];
  for (const s of sets) {
    it(`${s.net} ${s.spend.slice(0, 8)}...: primary and subaddresses`, () => {
      const k = moneroKeysFromSpendKey(hexToBytes(s.spend));
      expect(primaryAddress(k, s.net)).toBe(s.primary);
      for (const [idx, addr] of Object.entries(s.subs)) {
        const [major, minor] = idx.split('/').map(Number);
        expect(subaddress(k, major, minor, s.net)).toBe(addr);
      }
    });
  }
});

describe('PUBLISHED: bip_utils integrated addresses (encode and decode)', () => {
  const rows: Array<{ spend: string; net: MoneroNetwork; paymentId: string; address: string }> = [
    {
      spend: '2c9623882df4940a734b009e0732ce5a8de7a62c4c1a2a53767a8f6c04874117',
      net: 'mainnet',
      paymentId: 'd6f093554c0daa94',
      address: '4LiifdU2wUF3aCTG8X83ZM1xunHBjWEB5jmzM1zfrAKcGokjBPvS7eAcadEQZEgDhDeweod9KEZ5L2mXYVthxdxy4KUCty2MEBbHiGc8eM',
    },
    {
      spend: 'b6514a29ff612189af1bba250606bb5b1e7846fe8f31a91fc0beb393cddb6101',
      net: 'mainnet',
      paymentId: 'ccc172c2ffcac9d8',
      address: '4DEBYL2haZTQ2oZtBc8LUm4pAs5koPg2kdBHgwQNJBKRNxbwRnYufB5CeQvnbkGiWE4thv1A7GptxGVDDPN4d8ehZR6s3aQNNzLRREzGFz',
    },
    {
      spend: 'b4d9eab56043b1f0ac82affae32cd58049536d2289ec948502076961ae7da50e',
      net: 'stagenet',
      paymentId: 'b11e1adb1b805574',
      address: '5LZU7EP9dx89AZGHkyVLkvU4Qonc8yQ8fR4PZTy9haCVe6NHSMH4TtNLyWhovaP75PFDSUC9cAML7MAGhXS56o16QsHp2B9FRB2E9gyPSR',
    },
    {
      spend: 'a52d32df742c7ecf639be062ef4cd3d726117645542693fbfc44f5a186724307',
      net: 'testnet',
      paymentId: 'c39fd3c0f1edeab6',
      address: 'AA9FB1RgZJobeizJiyvY5USNcoMNtPiQvExkCKzBGJQqA1xpKhWGjDjDQnzBbubxx3i51d9mZCNvrSHcQVRUAK3H2y8NSmq3dB7MZNsYJB',
    },
  ];
  for (const r of rows) {
    it(`${r.net} ${r.address.slice(0, 8)}...`, () => {
      const k = moneroKeysFromSpendKey(hexToBytes(r.spend));
      expect(integratedAddress(k, hexToBytes(r.paymentId), r.net)).toBe(r.address);
      const d = decodeMoneroAddress(r.address);
      expect(d.net).toBe(r.net);
      expect(d.kind).toBe('integrated');
      expect(bytesToHex(d.paymentId!)).toBe(r.paymentId);
      expect(bytesToHex(d.spendPub)).toBe(bytesToHex(k.spendPub));
      expect(bytesToHex(d.viewPub)).toBe(bytesToHex(k.viewPub));
    });
  }

  it('velvet lymph + payment id 0123456789abcdef (computed by monero-ts 0.11.16 MoneroUtils.getIntegratedAddress)', () => {
    const k = moneroKeysFromLegacyWords(VELVET);
    expect(integratedAddress(k, hexToBytes('0123456789abcdef'))).toBe(
      '4CMe2PUhs4J4886T7196doS9GPMzexD9gXpsZJDwVjeRVdFCSoHnv7KPbBeGpzJBzHRCAs9UxqeoyFQMYbqSWYTfSbLRB61BQVATzerHGj',
    );
  });
});

describe('decodeMoneroAddress: kinds on mainnet', () => {
  it('standard', () => {
    const d = decodeMoneroAddress(PY_PRIMARY);
    expect(d).toMatchObject({ net: 'mainnet', kind: 'standard' });
    expect(d.paymentId).toBeUndefined();
    expect(bytesToHex(d.spendPub)).toBe('4ee576f52b9c6a824a3d5c2832d117177d2bb9992507c2c78788bb8dbaf4b640');
    expect(bytesToHex(d.viewPub)).toBe('e1ef99d66312ec0b16b17c66c591ab59594e21621588b63b62fa69fe615a768e');
    expect(isValidMoneroAddress(PY_PRIMARY)).toBe(true);
  });

  it('subaddress', () => {
    const addr = '84QRUYawRNrU3NN1VpFRndSukeyEb3Xpv8qZjjsoJZnTYpDYceuUTpog13D7qPxpviS7J29bSgSkR11hFFoXWk2yNdsR9WF';
    expect(decodeMoneroAddress(addr)).toMatchObject({ net: 'mainnet', kind: 'subaddress' });
    expect(isValidMoneroAddress(addr)).toBe(true);
  });

  it('integrated', () => {
    const addr = '4LiifdU2wUF3aCTG8X83ZM1xunHBjWEB5jmzM1zfrAKcGokjBPvS7eAcadEQZEgDhDeweod9KEZ5L2mXYVthxdxy4KUCty2MEBbHiGc8eM';
    expect(decodeMoneroAddress(addr)).toMatchObject({ net: 'mainnet', kind: 'integrated' });
    expect(isValidMoneroAddress(addr)).toBe(true);
  });

  it('the prefix table is cryptonote_config.h', () => {
    expect(MONERO_ADDRESS_PREFIXES).toEqual({
      mainnet: { standard: 18, subaddress: 42, integrated: 19 },
      stagenet: { standard: 24, subaddress: 36, integrated: 25 },
      testnet: { standard: 53, subaddress: 63, integrated: 54 },
    });
  });
});

describe('isValidMoneroAddress: network', () => {
  const stagenet = [
    '5A8FgbMkmG2e3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVHCRUaE', // Ledger, published
    '74oX2Dpt1g53S1AUVmcitNMaatEtSw4P79gi4Dnk8dYH7BAS9PFbcrQA27WWLurvzR9hL87soCikrb8oNvuW7bL8K2YVwh5', // subaddress
    '5LZU7EP9dx89AZGHkyVLkvU4Qonc8yQ8fR4PZTy9haCVe6NHSMH4TtNLyWhovaP75PFDSUC9cAML7MAGhXS56o16QsHp2B9FRB2E9gyPSR', // integrated
  ];
  const testnet = [
    '9zSaACcBx3HbeizJiyvY5USNcoMNtPiQvExkCKzBGJQqA1xpKhWGjDjDQnzBbubxx3i51d9mZCNvrSHcQVRUAK3H2HmhC9w',
    'BgZvFFW75akXq6MUHv67NEaFoHoC1F8LM9djSm6akiV6azL1nv6xh949NwQQZYM438cBUWWjFHaUjSpgA9MtUhNdBZC4Mvw',
    'AA9FB1RgZJobeizJiyvY5USNcoMNtPiQvExkCKzBGJQqA1xpKhWGjDjDQnzBbubxx3i51d9mZCNvrSHcQVRUAK3H2y8NSmq3dB7MZNsYJB',
  ];

  it('refuses stagenet addresses on a mainnet check (the default)', () => {
    for (const a of stagenet) {
      expect(decodeMoneroAddress(a).net).toBe('stagenet');
      expect(isValidMoneroAddress(a)).toBe(false);
      expect(isValidMoneroAddress(a, 'mainnet')).toBe(false);
      expect(isValidMoneroAddress(a, 'stagenet')).toBe(true);
    }
  });

  it('refuses testnet addresses on a mainnet check', () => {
    for (const a of testnet) {
      expect(decodeMoneroAddress(a).net).toBe('testnet');
      expect(isValidMoneroAddress(a)).toBe(false);
      expect(isValidMoneroAddress(a, 'testnet')).toBe(true);
    }
  });

  it('refuses a mainnet address on a stagenet check', () => {
    expect(isValidMoneroAddress(PY_PRIMARY, 'stagenet')).toBe(false);
  });
});

describe('decodeMoneroAddress: refusals', () => {
  it('a flipped checksum byte', () => {
    const raw = moneroBase58Decode(PY_PRIMARY);
    raw[raw.length - 1] ^= 0x01;
    const bad = moneroBase58Encode(raw);
    expect(() => decodeMoneroAddress(bad)).toThrow(/checksum/);
    expect(isValidMoneroAddress(bad)).toBe(false);
  });

  it('a flipped key byte (the checksum catches it)', () => {
    const raw = moneroBase58Decode(PY_PRIMARY);
    raw[10] ^= 0x40;
    expect(() => decodeMoneroAddress(moneroBase58Encode(raw))).toThrow(/checksum/);
  });

  it('a one-character typo', () => {
    const typo = PY_PRIMARY.slice(0, 40) + (PY_PRIMARY[40] === 'a' ? 'b' : 'a') + PY_PRIMARY.slice(41);
    expect(isValidMoneroAddress(typo)).toBe(false);
  });

  // The next four addresses carry a valid checksum around a spend key that is
  // not a canonical curve point. monero-ts 0.11.16 (MoneroUtils.validateAddress,
  // i.e. Monero's own check_key) was asked about each on 2026-09-28 and
  // answered "Invalid address" for all four.
  const nonPoints: Array<[string, string]> = [
    ['y = p (zero, non-canonically encoded)', '4AeDcfvW4KgjpXCZedGfVQjpXCZedGfVQjpXCZedGfVQNPd2Ca8CbvT2raH7EMawA2Fwo9utaRTV7Aw8EcTMNMxhH5rEbLJ'],
    ['y = p + 1 (identity, non-canonically encoded)', '4AgR6YQKyUajpXCZedGfVQjpXCZedGfVQjpXCZedGfVQNPd2Ca8CbvT2raH7EMawA2Fwo9utaRTV7Aw8EcTMNMxhH54zhkz'],
    ['y = 2 (not on the curve)', '41hWDGhXn8711111111111111111111111111111111119ZbS48ZNwm2raH7EMawA2Fwo9utaRTV7Aw8EcTMNMxhH4QSckS'],
    ['identity with the sign bit set (x = 0, x_0 = 1)', '41fJjQDhryD111111111111111111111111111111111NZKhDNwhDBy2raH7EMawA2Fwo9utaRTV7Aw8EcTMNMxhH3CYnbK'],
  ];
  for (const [label, addr] of nonPoints) {
    it(`a key that is not a valid point: ${label}`, () => {
      expect(() => decodeMoneroAddress(addr)).toThrow(/valid point/);
      expect(isValidMoneroAddress(addr)).toBe(false);
    });
  }

  it('accepts a canonical small-order point, exactly as Monero does', () => {
    // y = 0 canonically encoded is on the curve (order 4). monero-ts accepted
    // this address on 2026-09-28; refusing it would be a different rule from
    // monero-wallet-cli's, not a safer one.
    const addr = '41d7FXjswpK11111111111111111111111111111111119ZbS48ZNwm2raH7EMawA2Fwo9utaRTV7Aw8EcTMNMxhH7trTAj';
    expect(decodeMoneroAddress(addr).kind).toBe('standard');
  });

  it('an unknown prefix (a valid checksum around prefix 17)', () => {
    const raw = moneroBase58Decode(PY_PRIMARY);
    const body = raw.slice(0, 65);
    body[0] = 17;
    expect(() => decodeMoneroAddress(withChecksum(body))).toThrow(/unknown prefix/);
  });

  it('an integrated prefix on a standard-length payload, and the reverse', () => {
    const raw = moneroBase58Decode(PY_PRIMARY);
    const asIntegrated = raw.slice(0, 65);
    asIntegrated[0] = 19;
    expect(() => decodeMoneroAddress(withChecksum(asIntegrated))).toThrow(/wrong length for its type/);
    const longStandard = new Uint8Array(73);
    longStandard.set(raw.slice(0, 65));
    expect(() => decodeMoneroAddress(withChecksum(longStandard))).toThrow(/wrong length for its type/);
  });

  it('wrong lengths, empty input, whitespace, and non-base58 text', () => {
    expect(() => decodeMoneroAddress('')).toThrow(MoneroAddressError);
    expect(() => decodeMoneroAddress(PY_PRIMARY.slice(0, 94))).toThrow(MoneroAddressError);
    expect(() => decodeMoneroAddress(PY_PRIMARY + '1')).toThrow(MoneroAddressError);
    expect(() => decodeMoneroAddress(` ${PY_PRIMARY}`)).toThrow(MoneroAddressError);
    expect(() => decodeMoneroAddress('0x52908400098527886E0F7030069857D2E4169EE7')).toThrow(MoneroAddressError);
    expect(isValidMoneroAddress('EVRmoreAddressNotMonero')).toBe(false);
    expect(isValidMoneroAddress(undefined as unknown as string)).toBe(false);
  });
});

describe('encode arguments', () => {
  it('refuses subaddress indices outside uint32', () => {
    const k = moneroKeysFromLegacyWords(VELVET);
    expect(() => subaddress(k, -1, 0)).toThrow(MoneroAddressError);
    expect(() => subaddress(k, 0, 2 ** 32)).toThrow(MoneroAddressError);
    expect(() => subaddress(k, 0, 1.5)).toThrow(MoneroAddressError);
    // The top of the range is fine.
    expect(decodeMoneroAddress(subaddress(k, 0xffffffff, 0xffffffff)).kind).toBe('subaddress');
  });

  it('refuses keys and payment ids of the wrong size', () => {
    const k = moneroKeysFromLegacyWords(VELVET);
    expect(() => primaryAddress({ spendPub: new Uint8Array(31), viewPub: k.viewPub })).toThrow(MoneroAddressError);
    expect(() => integratedAddress(k, new Uint8Array(32))).toThrow(MoneroAddressError);
  });

  it('every encoded address decodes back to its own keys', () => {
    const k = moneroKeysFromLegacyWords(VELVET);
    const d = decodeMoneroAddress(primaryAddress(k));
    expect(bytesToHex(d.spendPub)).toBe(bytesToHex(k.spendPub));
    expect(bytesToHex(d.viewPub)).toBe(bytesToHex(k.viewPub));
    for (const [major, minor] of [[0, 1], [3, 7], [0, 999]]) {
      expect(decodeMoneroAddress(subaddress(k, major, minor)).kind).toBe('subaddress');
    }
  });
});
