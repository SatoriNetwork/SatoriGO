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
});
