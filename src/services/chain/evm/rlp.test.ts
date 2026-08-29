// RLP codec tests. Every expected value below is hard coded hex from the
// canonical Ethereum RLP test vectors (ethereum/wiki "RLP" + ethereum/tests
// RLPTests). They are NOT recomputed from the implementation, so a change in
// rlp.ts that alters a single byte fails here rather than silently changing a
// txid downstream.
//
// Note on vector 9: the well known "Lorem ipsum" vector is the 56 byte string
// "Lorem ipsum dolor sit amet, consectetur adipisicing elit", whose length is
// exactly what forces the 0xb8 long form. Its hex is asserted byte for byte
// below, and the 0x38 (56) length byte is checked against the string length so
// a typo in either half cannot pass.

import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import {
  rlpEncode,
  rlpDecode,
  bigintToRlpBytes,
  rlpBytesToBigint,
  type RlpInput,
} from './rlp';

const hex = (b: Uint8Array): string => bytesToHex(b);
const s = (text: string): Uint8Array => utf8ToBytes(text);

/** Every canonical vector, so encode and decode can be driven from one table. */
const VECTORS: Array<{ name: string; value: RlpInput; hex: string }> = [
  { name: '"dog"', value: s('dog'), hex: '83646f67' },
  { name: '["cat","dog"]', value: [s('cat'), s('dog')], hex: 'c88363617483646f67' },
  { name: 'the empty string', value: s(''), hex: '80' },
  { name: 'the empty list', value: [], hex: 'c0' },
  { name: 'integer 0', value: bigintToRlpBytes(0n), hex: '80' },
  { name: 'integer 15', value: bigintToRlpBytes(15n), hex: '0f' },
  { name: 'integer 1024', value: bigintToRlpBytes(1024n), hex: '820400' },
  {
    name: 'the set theoretic representation of three',
    value: [[], [[]], [[], [[]]]],
    hex: 'c7c0c1c0c3c0c1c0',
  },
  {
    name: 'the 56 byte Lorem ipsum string',
    value: s('Lorem ipsum dolor sit amet, consectetur adipisicing elit'),
    hex:
      'b8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e73656' +
      '37465747572206164697069736963696e6720656c6974',
  },
  { name: 'the single byte 0x00', value: Uint8Array.of(0x00), hex: '00' },
  { name: 'the single byte 0x7f', value: Uint8Array.of(0x7f), hex: '7f' },
  { name: 'the single byte 0x80', value: Uint8Array.of(0x80), hex: '8180' },
];

describe('rlpEncode: canonical vectors', () => {
  it('1. encodes "dog" as 83646f67', () => {
    expect(hex(rlpEncode(s('dog')))).toBe('83646f67');
  });

  it('2. encodes ["cat","dog"] as c88363617483646f67', () => {
    expect(hex(rlpEncode([s('cat'), s('dog')]))).toBe('c88363617483646f67');
  });

  it('3. encodes the empty string as 80', () => {
    expect(hex(rlpEncode(s('')))).toBe('80');
    expect(hex(rlpEncode(new Uint8Array(0)))).toBe('80');
  });

  it('4. encodes the empty list as c0', () => {
    expect(hex(rlpEncode([]))).toBe('c0');
  });

  it('5. encodes the integer 0 as 80 (empty string, NOT a 00 byte)', () => {
    expect(hex(bigintToRlpBytes(0n))).toBe('');
    expect(hex(rlpEncode(bigintToRlpBytes(0n)))).toBe('80');
  });

  it('6. encodes the integer 15 as 0f', () => {
    expect(hex(rlpEncode(bigintToRlpBytes(15n)))).toBe('0f');
  });

  it('7. encodes the integer 1024 as 820400', () => {
    expect(hex(rlpEncode(bigintToRlpBytes(1024n)))).toBe('820400');
  });

  it('8. encodes the set theoretic representation of three as c7c0c1c0c3c0c1c0', () => {
    expect(hex(rlpEncode([[], [[]], [[], [[]]]]))).toBe('c7c0c1c0c3c0c1c0');
  });

  it('9. encodes the 56 byte Lorem ipsum string with the 0xb8 long form', () => {
    const text = 'Lorem ipsum dolor sit amet, consectetur adipisicing elit';
    // The vector exists precisely because 56 is the first length past the short
    // form, so pin the length too: a one character typo would silently move it.
    expect(text.length).toBe(56);
    expect(hex(rlpEncode(s(text)))).toBe(
      'b8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e73656' +
        '37465747572206164697069736963696e6720656c6974',
    );
  });

  it('10. encodes the single byte 0x00 as 00', () => {
    expect(hex(rlpEncode(Uint8Array.of(0x00)))).toBe('00');
  });

  it('11. encodes the single byte 0x7f as 7f', () => {
    expect(hex(rlpEncode(Uint8Array.of(0x7f)))).toBe('7f');
  });

  it('12. encodes the single byte 0x80 as 8180 (0x80 is past the self encoding range)', () => {
    expect(hex(rlpEncode(Uint8Array.of(0x80)))).toBe('8180');
  });

  it('13. uses the long form only past 55 bytes', () => {
    const short = new Uint8Array(55).fill(0x61);
    const long = new Uint8Array(56).fill(0x61);
    expect(hex(rlpEncode(short)).slice(0, 2)).toBe('b7');
    expect(hex(rlpEncode(long)).slice(0, 4)).toBe('b838');

    const shortList = rlpEncode([new Uint8Array(54).fill(0x61)]);
    const longList = rlpEncode([new Uint8Array(55).fill(0x61)]);
    expect(hex(shortList).slice(0, 2)).toBe('f7');
    expect(hex(longList).slice(0, 4)).toBe('f838');
  });

  it('14. rejects a non Uint8Array / non array input', () => {
    expect(() => rlpEncode('dog' as unknown as RlpInput)).toThrow(/Uint8Array or an array/);
  });
});

describe('rlpDecode: round trips', () => {
  for (const vector of VECTORS) {
    it(`15. round trips ${vector.name}`, () => {
      const encoded = rlpEncode(vector.value);
      expect(hex(encoded)).toBe(vector.hex);
      expect(rlpDecode(encoded)).toEqual(vector.value);
      // Re encoding what we decoded must reproduce the identical bytes: that
      // is the property a strict decoder buys.
      expect(hex(rlpEncode(rlpDecode(encoded)))).toBe(vector.hex);
    });
  }

  it('16. decodes 80 to an empty byte string and c0 to an empty list', () => {
    expect(rlpDecode(hexToBytes('80'))).toEqual(new Uint8Array(0));
    expect(rlpDecode(hexToBytes('c0'))).toEqual([]);
  });

  it('17. decodes a nested list built from a long payload', () => {
    const inner = new Uint8Array(60).fill(0x41);
    const encoded = rlpEncode([inner, [s('cat')]]);
    expect(rlpDecode(encoded)).toEqual([inner, [s('cat')]]);
  });
});

describe('rlpDecode: strictness', () => {
  it('18. rejects 8100 (a byte below 0x80 wrapped as a 1 byte string)', () => {
    expect(() => rlpDecode(hexToBytes('8100'))).toThrow(/non canonical single byte/);
    expect(() => rlpDecode(hexToBytes('817f'))).toThrow(/non canonical single byte/);
    // 0x8180 is legitimate: 0x80 is NOT in the self encoding range.
    expect(rlpDecode(hexToBytes('8180'))).toEqual(Uint8Array.of(0x80));
  });

  it('19. rejects b80161 (long form used for a 1 byte string)', () => {
    expect(() => rlpDecode(hexToBytes('b80161'))).toThrow(/non canonical length/);
  });

  it('20. rejects a long form list whose length would fit the short form', () => {
    expect(() => rlpDecode(hexToBytes('f801c0'))).toThrow(/non canonical length/);
  });

  it('21. rejects a length with a leading zero byte', () => {
    // b9 = long string, 2 length bytes; 00 38 is 56 spelled non canonically.
    expect(() => rlpDecode(hexToBytes('b90038' + '61'.repeat(56)))).toThrow(
      /non canonical length \(leading zero byte\)/,
    );
  });

  it('22. rejects trailing garbage after a complete item', () => {
    expect(() => rlpDecode(hexToBytes('83646f6700'))).toThrow(/trailing bytes/);
    expect(() => rlpDecode(hexToBytes('c0c0'))).toThrow(/trailing bytes/);
  });

  it('23. rejects a truncated list', () => {
    // c8 promises an 8 byte payload and only 3 bytes follow.
    expect(() => rlpDecode(hexToBytes('c883636174'))).toThrow(/truncated list/);
  });

  it('24. rejects a truncated string and a truncated length prefix', () => {
    expect(() => rlpDecode(hexToBytes('83646f'))).toThrow(/truncated string/);
    expect(() => rlpDecode(hexToBytes('b8'))).toThrow(/truncated length prefix/);
  });

  it('25. rejects a list item that overruns its own list', () => {
    // c2 promises 2 payload bytes; the inner item claims 3 bytes of string.
    expect(() => rlpDecode(hexToBytes('c283646f67'))).toThrow(
      /overruns its list|trailing bytes/,
    );
  });

  it('26. rejects empty input and a non Uint8Array', () => {
    expect(() => rlpDecode(new Uint8Array(0))).toThrow(/empty input/);
    expect(() => rlpDecode('c0' as unknown as Uint8Array)).toThrow(/expects a Uint8Array/);
  });
});

describe('integer helpers', () => {
  it('27. encodes integers minimally, with 0 as the empty string', () => {
    expect(hex(bigintToRlpBytes(0n))).toBe('');
    expect(hex(bigintToRlpBytes(1n))).toBe('01');
    expect(hex(bigintToRlpBytes(15n))).toBe('0f');
    expect(hex(bigintToRlpBytes(255n))).toBe('ff');
    expect(hex(bigintToRlpBytes(256n))).toBe('0100');
    expect(hex(bigintToRlpBytes(1024n))).toBe('0400');
    expect(hex(bigintToRlpBytes(20000000000n))).toBe('04a817c800'); // 20 gwei
    expect(hex(bigintToRlpBytes(10n ** 18n))).toBe('0de0b6b3a7640000'); // 1 ether in wei
  });

  it('28. rejects negative integers and non bigints', () => {
    expect(() => bigintToRlpBytes(-1n)).toThrow(/negative/);
    expect(() => bigintToRlpBytes(1 as unknown as bigint)).toThrow(/must be a bigint/);
  });

  it('29. decodes integers and rejects a leading zero byte', () => {
    expect(rlpBytesToBigint(new Uint8Array(0))).toBe(0n);
    expect(rlpBytesToBigint(hexToBytes('0f'))).toBe(15n);
    expect(rlpBytesToBigint(hexToBytes('0400'))).toBe(1024n);
    expect(rlpBytesToBigint(hexToBytes('0de0b6b3a7640000'))).toBe(10n ** 18n);
    expect(() => rlpBytesToBigint(hexToBytes('0001'))).toThrow(/non canonical integer/);
    expect(() => rlpBytesToBigint(hexToBytes('00'))).toThrow(/non canonical integer/);
  });

  it('30. round trips a spread of magnitudes past 2^53', () => {
    const values = [0n, 1n, 127n, 128n, 255n, 256n, 65535n, 2n ** 53n, 2n ** 64n - 1n, 2n ** 255n];
    for (const v of values) {
      expect(rlpBytesToBigint(bigintToRlpBytes(v))).toBe(v);
    }
  });
});
