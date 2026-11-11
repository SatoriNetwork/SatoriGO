// EIP-712 against the spec's own example (eips.ethereum.org/EIPS/eip-712,
// "Example" / Example.js): the Mail struct signed by keccak256("cow").

import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  encodeType,
  hashStruct,
  parseTypedData,
  signTypedData,
  typedDataChainId,
  typedDataDigest,
  TypedDataError,
} from './typedData';

const mail = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;

describe('EIP-712 typed data', () => {
  it('encodes the type string with dependencies sorted after the primary type', () => {
    const t = parseTypedData(mail);
    expect(encodeType('Mail', t.types)).toBe('Mail(Person from,Person to,string contents)Person(string name,address wallet)');
  });

  it('matches the spec vector: domain separator, message hash and digest', () => {
    const t = parseTypedData(mail);
    expect(hex(hashStruct('EIP712Domain', t.domain, t.types))).toBe(
      '0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f',
    );
    expect(hex(hashStruct('Mail', t.message, t.types))).toBe(
      '0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e',
    );
    expect(hex(typedDataDigest(t))).toBe('0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  });

  it('signs to the spec signature (v = 28)', () => {
    const priv = keccak_256(utf8ToBytes('cow'));
    expect(signTypedData(parseTypedData(JSON.stringify(mail)), priv)).toBe(
      '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d' +
        '07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562' +
        '1c',
    );
  });

  it('derives EIP712Domain from the domain when the site leaves it out', () => {
    const { EIP712Domain: _omit, ...rest } = mail.types;
    void _omit;
    const t = parseTypedData({ ...mail, types: rest });
    expect(hex(typedDataDigest(t))).toBe('0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  });

  it('reads the domain chain id', () => {
    expect(typedDataChainId(parseTypedData(mail))).toBe(1);
    expect(typedDataChainId(parseTypedData({ ...mail, domain: { ...mail.domain, chainId: '0x2105' } }))).toBe(8453);
  });

  it('refuses what it cannot encode exactly instead of guessing', () => {
    const bad = (message: Record<string, unknown>) => () => typedDataDigest(parseTypedData({ ...mail, message }));
    expect(bad({ ...mail.message, contents: 5 })).toThrow(TypedDataError);
    expect(bad({ ...mail.message, from: { name: 'Cow', wallet: '0x1234' } })).toThrow(TypedDataError);
    expect(bad({ from: mail.message.from, to: mail.message.to })).toThrow(/missing/);
    expect(() => parseTypedData('{not json')).toThrow(TypedDataError);
    expect(() => parseTypedData({ ...mail, primaryType: 'Nope' })).toThrow(TypedDataError);
  });

  it('range-checks integers', () => {
    const t = parseTypedData({
      types: { Thing: [{ name: 'n', type: 'uint8' }] },
      primaryType: 'Thing',
      domain: { name: 'x' },
      message: { n: 256 },
    });
    expect(() => typedDataDigest(t)).toThrow(/out of range/);
  });

  // Digests below were computed independently with ethers 6.13.4
  // (TypedDataEncoder.hash), not with this module.
  const vDomain = { name: 'Vectors', chainId: 8453, verifyingContract: '0x1111111111111111111111111111111111111111' };

  it('matches ethers on arrays: dynamic, fixed and nested arrays with negative ints', () => {
    const t = parseTypedData({
      types: { Order: [{ name: 'ids', type: 'uint256[]' }, { name: 'tags', type: 'string[2]' }, { name: 'grid', type: 'int8[][]' }] },
      primaryType: 'Order',
      domain: vDomain,
      message: { ids: ['1', '2', '300'], tags: ['a', 'b'], grid: [[-1, 2], [-128]] },
    });
    expect(hex(typedDataDigest(t))).toBe('0x53853de4243c704c35d77d495f6ddf26d9f092889f0865b7d73e9732206373c6');
  });

  it('matches ethers on nested struct arrays, bytes and bytesN', () => {
    const t = parseTypedData({
      types: {
        Leg: [{ name: 'who', type: 'address' }, { name: 'amt', type: 'int256' }],
        Trade: [{ name: 'legs', type: 'Leg[]' }, { name: 'memo', type: 'bytes' }, { name: 'ref', type: 'bytes4' }],
      },
      primaryType: 'Trade',
      domain: vDomain,
      message: {
        legs: [
          { who: '0x2222222222222222222222222222222222222222', amt: '-5' },
          { who: '0x3333333333333333333333333333333333333333', amt: '7' },
        ],
        memo: '0xdeadbeef00',
        ref: '0x01020304',
      },
    });
    expect(encodeType('Trade', t.types)).toBe('Trade(Leg[] legs,bytes memo,bytes4 ref)Leg(address who,int256 amt)');
    expect(hex(typedDataDigest(t))).toBe('0xfda256b1ecb033d32253ae48bea205be264ecda97fd0bde7549bd4aed175a085');
  });

  it('finds a struct dependency behind a multi-dimensional array', () => {
    const types = { Cell: [{ name: 'v', type: 'uint8' }], Board: [{ name: 'cells', type: 'Cell[][]' }] };
    expect(encodeType('Board', types)).toBe('Board(Cell[][] cells)Cell(uint8 v)');
  });

  it('matches ethers on a domain with only some fields', () => {
    const t = parseTypedData({ types: { Ping: [{ name: 'n', type: 'uint8' }] }, primaryType: 'Ping', domain: { name: 'Only', version: '2' }, message: { n: 1 } });
    expect(hex(typedDataDigest(t))).toBe('0xad64c1292999e5330ec1ff0b40bf84f517a95037aa81ef28dc6fd09481411cce');
  });

  it('refuses an EIP712Domain that does not describe the domain shown', () => {
    const lessListed = { ...mail, types: { ...mail.types, EIP712Domain: mail.types.EIP712Domain.slice(0, 2) } };
    expect(() => parseTypedData(lessListed)).toThrow(/does not match/);
    const moreListed = { ...mail, domain: { name: 'Ether Mail', version: '1', chainId: 1 } };
    expect(() => parseTypedData(moreListed)).toThrow(/does not match/);
    const wrongType = {
      ...mail,
      types: { ...mail.types, EIP712Domain: [...mail.types.EIP712Domain.slice(0, 3), { name: 'verifyingContract', type: 'string' }] },
    };
    expect(() => parseTypedData(wrongType)).toThrow(/does not match/);
    expect(() => parseTypedData({ ...mail, domain: { ...mail.domain, extra: 'x' } })).toThrow(/unknown field/);
  });

  it('refuses message values that have no field in the type', () => {
    const t = parseTypedData({ ...mail, message: { ...mail.message, note: 'not signed' } });
    expect(() => typedDataDigest(t)).toThrow(/not part of type Mail/);
    const nested = parseTypedData({ ...mail, message: { ...mail.message, to: { ...mail.message.to, extra: 1 } } });
    expect(() => typedDataDigest(nested)).toThrow(/not part of type Person/);
  });

  it('is not fooled by inherited object properties', () => {
    const t = parseTypedData({ types: { Thing: [{ name: 'toString', type: 'string' }] }, primaryType: 'Thing', domain: { name: 'x' }, message: {} });
    expect(() => typedDataDigest(t)).toThrow(/missing/);
    expect(() => parseTypedData({ types: {}, primaryType: 'constructor', domain: { name: 'x' }, message: {} })).toThrow(/not defined/);
  });
});
