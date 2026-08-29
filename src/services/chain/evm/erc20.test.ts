// ERC-20 codec tests.
//
// Every expected value below is HARD CODED hex, written out in full and never
// produced by the code under test. The selectors are the published ERC-20 ones
// (any block explorer's "Read Contract" tab shows them), the EIP-55 addresses
// are the checksum vectors from the EIP itself, and the return-data blobs are
// written word by word so a reader can count the 32-byte boundaries.
//
// That matters more here than in most test files: this codec decides what a
// user is told a transaction does. A test that recomputed the answer with the
// same function would agree with any bug the function has.
//
// Layout note used throughout: an ABI word is 64 hex characters, an address
// argument is 24 zeros followed by the 40 hex characters of the address, and a
// transfer/approve payload is 8 (selector) + 64 + 64 = 136 hex characters.

import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  MAX_UINT256,
  ERC20_SELECTORS,
  selector,
  encodeBalanceOf,
  encodeDecimals,
  encodeSymbol,
  encodeName,
  encodeTotalSupply,
  encodeTransfer,
  decodeUint256,
  decodeUint8,
  decodeBool,
  decodeString,
  decodeErc20Calldata,
} from './erc20';

/** The EIP-155 example transaction's destination: 20 bytes of 0x35. It is all
 *  digits, so its EIP-55 form has no upper case at all, which keeps vector 2
 *  and 3 readable. */
const ADDR_35 = '0x3535353535353535353535353535353535353535';

/** An EIP-55 checksum vector from the EIP itself, used wherever the casing has
 *  to prove something (round trips), because it is heavily mixed case. */
const ADDR_EIP55 = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const ADDR_EIP55_LOWER = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';

/** Uniswap's Permit2, the spender in most real unlimited-allowance approvals.
 *  Its checksum casing is published and stable. */
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const hex = (b: Uint8Array): string => bytesToHex(b);

describe('erc20 selectors (1)', () => {
  // Signatures in canonical form: no spaces, no argument names. These strings
  // are the input, the literals in ERC20_SELECTORS are the answer, and this
  // table is what proves the keccak plumbing produces the published values.
  const SIGNATURES: Record<keyof typeof ERC20_SELECTORS, string> = {
    balanceOf: 'balanceOf(address)',
    decimals: 'decimals()',
    symbol: 'symbol()',
    name: 'name()',
    totalSupply: 'totalSupply()',
    transfer: 'transfer(address,uint256)',
    approve: 'approve(address,uint256)',
  };

  it('every pinned selector equals selector(signature)', () => {
    for (const [key, signature] of Object.entries(SIGNATURES)) {
      const pinned = ERC20_SELECTORS[key as keyof typeof ERC20_SELECTORS];
      expect(`${key}: ${selector(signature)}`).toBe(`${key}: ${pinned}`);
    }
  });

  it('holds exactly the published literals', () => {
    expect(ERC20_SELECTORS.balanceOf).toBe('0x70a08231');
    expect(ERC20_SELECTORS.decimals).toBe('0x313ce567');
    expect(ERC20_SELECTORS.symbol).toBe('0x95d89b41');
    expect(ERC20_SELECTORS.name).toBe('0x06fdde03');
    expect(ERC20_SELECTORS.totalSupply).toBe('0x18160ddd');
    expect(ERC20_SELECTORS.transfer).toBe('0xa9059cbb');
    expect(ERC20_SELECTORS.approve).toBe('0x095ea7b3');
  });

  it('is sensitive to the exact signature text', () => {
    // A space after the comma is a different function as far as keccak cares,
    // which is why the signatures above are pinned rather than built.
    expect(selector('transfer(address, uint256)')).not.toBe(ERC20_SELECTORS.transfer);
  });

  it('MAX_UINT256 is 2^256 - 1', () => {
    expect(MAX_UINT256.toString(16)).toBe(
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    );
  });
});

describe('encodeBalanceOf and the no-argument calls (2)', () => {
  it('encodes balanceOf(0x3535..35)', () => {
    expect(encodeBalanceOf(ADDR_35)).toBe(
      '0x70a08231' +
        '000000000000000000000000' +
        '3535353535353535353535353535353535353535',
    );
  });

  it('accepts a mixed-case address with a correct checksum, and lowercases the word', () => {
    expect(encodeBalanceOf(ADDR_EIP55)).toBe(
      '0x70a08231' +
        '000000000000000000000000' +
        'fb6916095ca1df60bb79ce92ce3ea74c37c5d359',
    );
    expect(encodeBalanceOf(ADDR_EIP55_LOWER)).toBe(encodeBalanceOf(ADDR_EIP55));
  });

  it('rejects a mixed-case address whose checksum is wrong', () => {
    // Same 20 bytes as ADDR_EIP55 with one letter's case flipped: valid hex,
    // invalid EIP-55, and exactly what a corrupted paste looks like.
    expect(() => encodeBalanceOf('0xFb6916095ca1df60bB79Ce92cE3Ea74c37c5d359')).toThrow(
      /not a valid EVM address/,
    );
  });

  it('encodes the four zero-argument calls as bare selectors', () => {
    expect(encodeDecimals()).toBe('0x313ce567');
    expect(encodeSymbol()).toBe('0x95d89b41');
    expect(encodeName()).toBe('0x06fdde03');
    expect(encodeTotalSupply()).toBe('0x18160ddd');
  });
});

describe('encodeTransfer (3)', () => {
  it('encodes transfer(0x3535..35, 1000000) byte for byte', () => {
    const data = encodeTransfer(ADDR_35, 1000000n);
    expect(hex(data)).toBe(
      'a9059cbb' +
        '000000000000000000000000' +
        '3535353535353535353535353535353535353535' +
        '00000000000000000000000000000000000000000000000000000000000f4240',
    );
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBe(68);
  });

  it('encodes zero and the maximum amount', () => {
    expect(hex(encodeTransfer(ADDR_35, 0n))).toBe(
      'a9059cbb' +
        '000000000000000000000000' +
        '3535353535353535353535353535353535353535' +
        '0000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(hex(encodeTransfer(ADDR_35, MAX_UINT256))).toBe(
      'a9059cbb' +
        '000000000000000000000000' +
        '3535353535353535353535353535353535353535' +
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    );
  });
});

describe('decodeUint256 (4)', () => {
  it('decodes a 32-byte word', () => {
    expect(
      decodeUint256('0x000000000000000000000000000000000000000000000000000000000000000f'),
    ).toBe(15n);
    expect(
      decodeUint256('0x0000000000000000000000000000000000000000000000000000000000000000'),
    ).toBe(0n);
    expect(
      decodeUint256('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
    ).toBe(MAX_UINT256);
  });

  it('decodes a value past 2^53, exactly', () => {
    // 0.25e18 base units. A Number would have rounded this; the string form is
    // asserted so a silent float round trip cannot pass.
    expect(
      decodeUint256('0x00000000000000000000000000000000000000000000000003782dace9d90000').toString(),
    ).toBe('250000000000000000');
  });

  it('accepts upper-case hex, since hex case carries no meaning here', () => {
    expect(
      decodeUint256('0x00000000000000000000000000000000000000000000000000000000000000FF'),
    ).toBe(255n);
  });

  it('rejects 31 bytes', () => {
    expect(() =>
      decodeUint256('0x0000000000000000000000000000000000000000000000000000000000000f'),
    ).toThrow(/exactly 32 bytes, got 31/);
  });

  it('rejects 33 bytes', () => {
    expect(() =>
      decodeUint256('0x00000000000000000000000000000000000000000000000000000000000000000f'),
    ).toThrow(/exactly 32 bytes, got 33/);
  });

  it('rejects a missing 0x prefix', () => {
    expect(() =>
      decodeUint256('000000000000000000000000000000000000000000000000000000000000000f'),
    ).toThrow(/0x-prefixed hex string/);
  });

  it('rejects an odd number of hex digits and non-hex characters', () => {
    expect(() => decodeUint256('0xf')).toThrow(/odd number of hex digits/);
    expect(() =>
      decodeUint256('0x00000000000000000000000000000000000000000000000000000000000000zz'),
    ).toThrow(/0x-prefixed hex string/);
    expect(() => decodeUint256('0x')).toThrow(/exactly 32 bytes, got 0/);
  });
});

describe('decodeUint8 and decodeBool (5)', () => {
  it('accepts 6 and 18, the two decimals values that matter most', () => {
    expect(
      decodeUint8('0x0000000000000000000000000000000000000000000000000000000000000006'),
    ).toBe(6);
    expect(
      decodeUint8('0x0000000000000000000000000000000000000000000000000000000000000012'),
    ).toBe(18);
    expect(
      decodeUint8('0x00000000000000000000000000000000000000000000000000000000000000ff'),
    ).toBe(255);
  });

  it('rejects 256', () => {
    expect(() =>
      decodeUint8('0x0000000000000000000000000000000000000000000000000000000000000100'),
    ).toThrow(/out of range: 256/);
  });

  it('rejects the wrong width', () => {
    expect(() => decodeUint8('0x12')).toThrow(/exactly 32 bytes, got 1/);
  });

  it('decodes bool 0 and 1 and rejects anything else', () => {
    expect(
      decodeBool('0x0000000000000000000000000000000000000000000000000000000000000000'),
    ).toBe(false);
    expect(
      decodeBool('0x0000000000000000000000000000000000000000000000000000000000000001'),
    ).toBe(true);
    expect(() =>
      decodeBool('0x0000000000000000000000000000000000000000000000000000000000000002'),
    ).toThrow(/neither 0 nor 1: 2/);
  });
});

describe('decodeString (6)', () => {
  it('decodes the dynamic form: symbol() returning "USDC"', () => {
    // offset word 0x20, length word 0x04, then 55534443 padded to a full word.
    const usdc =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000004' +
      '5553444300000000000000000000000000000000000000000000000000000000';
    expect(decodeString(usdc)).toBe('USDC');
  });

  it('decodes the bytes32 form: symbol() returning "MKR"', () => {
    const mkr = '0x4d4b520000000000000000000000000000000000000000000000000000000000';
    expect(decodeString(mkr)).toBe('MKR');
  });

  it('decodes an empty dynamic string', () => {
    const empty =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000000';
    expect(decodeString(empty)).toBe('');
  });

  it('decodes a name that spans two payload words', () => {
    // 38 bytes (0x26), so the payload is two words and the second one is mostly
    // padding. This is the shape name() returns for most real tokens.
    const name =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000026' +
      '4120746f6b656e206e616d65206c6f6e676572207468616e2074686972747932' +
      '2062797465730000000000000000000000000000000000000000000000000000';
    expect(decodeString(name)).toBe('A token name longer than thirty2 bytes');
  });

  it('rejects a dynamic length that overruns the data', () => {
    // Claims 0x40 = 64 bytes of payload but only one word follows.
    const overrun =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000040' +
      '5553444300000000000000000000000000000000000000000000000000000000';
    expect(() => decodeString(overrun)).toThrow(/declares 64 bytes/);
  });

  it('rejects an absurd length without narrowing it to a Number', () => {
    const absurd =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
      '5553444300000000000000000000000000000000000000000000000000000000';
    expect(() => decodeString(absurd)).toThrow(/does not match/);
  });

  it('rejects a trailing word past the end of the declared string', () => {
    // Canonical encoding of "USDC" is 96 bytes. This one carries a fourth word
    // the string does not account for, so it is data we would not be showing.
    const trailing =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000004' +
      '5553444300000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000000';
    expect(() => decodeString(trailing)).toThrow(/declares 4 bytes, which does not match the 64/);
  });

  it('rejects a non-canonical offset', () => {
    const badOffset =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000040' +
      '0000000000000000000000000000000000000000000000000000000000000004' +
      '5553444300000000000000000000000000000000000000000000000000000000';
    expect(() => decodeString(badOffset)).toThrow(/offset must be 0x20/);
  });

  it('rejects a payload with bytes hidden past the end of the string', () => {
    // Length says 4 ("USDC") but byte 5 of the payload is not zero.
    const dirty =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000004' +
      '5553444341000000000000000000000000000000000000000000000000000000';
    expect(() => decodeString(dirty)).toThrow(/non-zero padding byte/);
  });

  it('rejects a bytes32 form with an interior control byte', () => {
    // 'MK' NUL 'R' padded: stripping trailing zeros leaves a NUL inside, so
    // where the string ends is a guess, and guessing is refused.
    const interior = '0x4d4b005200000000000000000000000000000000000000000000000000000000';
    expect(() => decodeString(interior)).toThrow(/non-printable byte 0x00 at index 2/);
  });

  it('rejects widths that are neither bytes32 nor a whole number of words', () => {
    expect(() => decodeString('0x4d4b52')).toThrow(/must be 32 bytes/);
    expect(() =>
      decodeString(
        '0x0000000000000000000000000000000000000000000000000000000000000020' + '00',
      ),
    ).toThrow(/must be 32 bytes/);
  });

  it('rejects invalid UTF-8 in the dynamic form', () => {
    // 0xff is not a legal UTF-8 lead byte anywhere.
    const badUtf8 =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000002' +
      'ff41000000000000000000000000000000000000000000000000000000000000';
    expect(() => decodeString(badUtf8)).toThrow(/not valid UTF-8/);
  });
});

describe('decodeErc20Calldata (7)', () => {
  it('round-trips encodeTransfer with a checksummed recipient', () => {
    const data = encodeTransfer(ADDR_EIP55_LOWER, 250000000000000000n);
    // The bytes are asserted first, so the round trip cannot be two bugs
    // agreeing with each other.
    expect(hex(data)).toBe(
      'a9059cbb' +
        '000000000000000000000000' +
        'fb6916095ca1df60bb79ce92ce3ea74c37c5d359' +
        '00000000000000000000000000000000000000000000000003782dace9d90000',
    );
    expect(decodeErc20Calldata(data)).toEqual({
      kind: 'transfer',
      to: ADDR_EIP55,
      amount: 250000000000000000n,
    });
  });

  it('decodes a hand-built unlimited approve', () => {
    const approve = hexToBytes(
      '095ea7b3' +
        '000000000000000000000000' +
        '000000000022d473030f116ddee9f6b43ac78ba3' +
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    );
    expect(decodeErc20Calldata(approve)).toEqual({
      kind: 'approve',
      spender: PERMIT2,
      amount: MAX_UINT256,
      unlimited: true,
    });
  });

  it('does not call a merely large allowance unlimited', () => {
    // MAX_UINT256 - 1. One bit away, and still a finite allowance.
    const approve = hexToBytes(
      '095ea7b3' +
        '000000000000000000000000' +
        '000000000022d473030f116ddee9f6b43ac78ba3' +
        'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe',
    );
    expect(decodeErc20Calldata(approve)).toEqual({
      kind: 'approve',
      spender: PERMIT2,
      amount: 115792089237316195423570985008687907853269984665640564039457584007913129639934n,
      unlimited: false,
    });
  });

  it('THROWS on a transfer whose address padding is not zero', () => {
    // Byte 11 of the address word is 0xff. A decoder that reads only the low 20
    // bytes would happily show 0xfB69..d359 for calldata that is not that call.
    const dirty = hexToBytes(
      'a9059cbb' +
        '0000000000000000000000ff' +
        'fb6916095ca1df60bb79ce92ce3ea74c37c5d359' +
        '00000000000000000000000000000000000000000000000000000000000f4240',
    );
    expect(() => decodeErc20Calldata(dirty)).toThrow(
      /transfer address argument has a non-zero byte 0xff in its 12-byte padding/,
    );
  });

  it('THROWS on the same trick in an approve', () => {
    const dirty = hexToBytes(
      '095ea7b3' +
        '010000000000000000000000' +
        '000000000022d473030f116ddee9f6b43ac78ba3' +
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    );
    expect(() => decodeErc20Calldata(dirty)).toThrow(
      /approve address argument has a non-zero byte 0x01/,
    );
  });

  it('THROWS on 63 bytes after a transfer selector', () => {
    const short = hexToBytes(
      'a9059cbb' +
        '000000000000000000000000' +
        'fb6916095ca1df60bb79ce92ce3ea74c37c5d359' +
        '000000000000000000000000000000000000000000000000000000000f4240',
    );
    expect(short.length).toBe(67);
    expect(() => decodeErc20Calldata(short)).toThrow(/must be 68 bytes .*got 67/);
  });

  it('THROWS on 65 bytes after a transfer selector', () => {
    const long = hexToBytes(
      'a9059cbb' +
        '000000000000000000000000' +
        'fb6916095ca1df60bb79ce92ce3ea74c37c5d359' +
        '00000000000000000000000000000000000000000000000000000000000f4240' +
        '00',
    );
    expect(() => decodeErc20Calldata(long)).toThrow(/must be 68 bytes .*got 69/);
  });

  it('THROWS on a bare transfer selector with no arguments', () => {
    expect(() => decodeErc20Calldata(hexToBytes('a9059cbb'))).toThrow(/must be 68 bytes .*got 4/);
  });

  it('returns null for an unknown selector', () => {
    // totalSupply()'s selector with a transfer-shaped payload behind it.
    const unknown = hexToBytes(
      '18160ddd' +
        '000000000000000000000000' +
        'fb6916095ca1df60bb79ce92ce3ea74c37c5d359' +
        '00000000000000000000000000000000000000000000000000000000000f4240',
    );
    expect(decodeErc20Calldata(unknown)).toBeNull();
  });

  it('returns null for empty calldata and for fewer than 4 bytes', () => {
    expect(decodeErc20Calldata(new Uint8Array(0))).toBeNull();
    expect(decodeErc20Calldata(hexToBytes('a9059c'))).toBeNull();
  });

  it('reads a subarray view correctly, not the whole backing buffer', () => {
    // Guards the subarray arithmetic: a decoder that reached for .buffer would
    // see the two extra bytes in front and decode garbage.
    const framed = hexToBytes(
      'dead' +
        'a9059cbb' +
        '000000000000000000000000' +
        '3535353535353535353535353535353535353535' +
        '00000000000000000000000000000000000000000000000000000000000f4240',
    );
    expect(decodeErc20Calldata(framed.subarray(2))).toEqual({
      kind: 'transfer',
      to: ADDR_35,
      amount: 1000000n,
    });
  });

  it('rejects a non-Uint8Array', () => {
    // The dApp path in phase 5 receives calldata from a website, so the type
    // annotation is not a guarantee at runtime.
    expect(() => decodeErc20Calldata('0xa9059cbb' as unknown as Uint8Array)).toThrow(
      /must be a Uint8Array/,
    );
  });
});

describe('encodeTransfer rejects bad input (8)', () => {
  it('rejects a negative amount', () => {
    expect(() => encodeTransfer(ADDR_35, -1n)).toThrow(/must not be negative/);
  });

  it('rejects an amount above uint256', () => {
    expect(() => encodeTransfer(ADDR_35, MAX_UINT256 + 1n)).toThrow(/exceeds uint256/);
    expect(() => encodeTransfer(ADDR_35, 2n ** 256n)).toThrow(/exceeds uint256/);
  });

  it('rejects an amount that is not a bigint', () => {
    expect(() => encodeTransfer(ADDR_35, 1000000 as unknown as bigint)).toThrow(/must be a bigint/);
  });

  it('rejects malformed addresses', () => {
    expect(() => encodeTransfer('0x353535', 1n)).toThrow(/not a valid EVM address/);
    expect(() => encodeTransfer('3535353535353535353535353535353535353535', 1n)).toThrow(
      /not a valid EVM address/,
    );
    expect(() => encodeTransfer('0x35353535353535353535353535353535353535zz', 1n)).toThrow(
      /not a valid EVM address/,
    );
    expect(() => encodeTransfer('0x353535353535353535353535353535353535353535', 1n)).toThrow(
      /not a valid EVM address/,
    );
    expect(() => encodeTransfer('', 1n)).toThrow(/not a valid EVM address/);
    expect(() => encodeTransfer(null as unknown as string, 1n)).toThrow(/not a valid EVM address/);
  });
});
