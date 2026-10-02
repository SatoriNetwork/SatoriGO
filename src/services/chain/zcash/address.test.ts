// Zcash recipient formats (design §3): t1, t3 and ZIP-320 TEX round trips on
// published vectors, and every refusal Send shows.

import { describe, expect, it } from 'vitest';
import { base58check, bech32, bech32m } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import {
  ZcashAddressError,
  decodeZcashAddress,
  encodeP2pkh,
  encodeP2sh,
  encodeTex,
  isValidZcashRecipient,
  p2pkhScript,
  p2shScript,
  scriptToZcashAddress,
} from './address';
import zip320 from './testing/zip_0320.json';

const zip320Rows = (zip320 as unknown[]).slice(2) as [string, string, string, number, number][];
const b58c = base58check(sha256);

function refusal(address: string, net: 'main' | 'test' = 'main'): ZcashAddressError {
  try {
    decodeZcashAddress(address, net);
  } catch (err) {
    expect(err).toBeInstanceOf(ZcashAddressError);
    return err as ZcashAddressError;
  }
  throw new Error(`expected ${address} to be refused`);
}

describe('zcash address: published vectors', () => {
  it('zip_0320.json: all 15 TEX encodings and their decodes', () => {
    expect(zip320Rows).toHaveLength(15);
    for (const [taddr, p2pkhHex, tex] of zip320Rows) {
      const t = decodeZcashAddress(taddr);
      expect(t.kind).toBe('p2pkh');
      expect(t.net).toBe('main');
      expect(bytesToHex(t.hash)).toBe(p2pkhHex);
      expect(encodeTex(t.hash)).toBe(tex);
      const x = decodeZcashAddress(tex);
      expect(x.kind).toBe('tex');
      expect(bytesToHex(x.hash)).toBe(p2pkhHex);
      // Paying a TEX address is exactly a P2PKH output to the same hash.
      expect(bytesToHex(x.script)).toBe(bytesToHex(t.script));
      expect(encodeP2pkh(x.hash)).toBe(taddr);
    }
  });

  it('Trust Wallet Core: t1 lock script and TEX key hash', () => {
    expect(bytesToHex(decodeZcashAddress('t1bjVPEY8NbpGxT2PgayX3HevfJ2YU5X2DS').script)).toBe(
      '76a914c3e968851fdb2bb943662befdb8b8573ecd4d08e88ac',
    );
    expect(bytesToHex(decodeZcashAddress('tex1auz6gx89x2wcku6gswdvaz2nf9x3seex6px6v0').hash)).toBe(
      'ef05a418e5329d8b7348839ace8953494d186726',
    );
  });

  it('t3 (P2SH) round trip and script', () => {
    const h = hexToBytes('b8f771de8bbdcfee76e0dbf76f1005f2028bf3e7');
    const t3 = encodeP2sh(h);
    expect(t3.startsWith('t3')).toBe(true);
    const d = decodeZcashAddress(t3);
    expect(d.kind).toBe('p2sh');
    expect(bytesToHex(d.script)).toBe('a914b8f771de8bbdcfee76e0dbf76f1005f2028bf3e787');
    expect(bytesToHex(p2shScript(h))).toBe(bytesToHex(d.script));
  });

  it('testnet decode when asked for testnet (Trezor vectors)', () => {
    const t2 = decodeZcashAddress('t2PQpjcfpYHK1bcXZcSaTbg5cQRV93B2NRY', 'test');
    expect(t2.kind).toBe('p2sh');
    expect(bytesToHex(t2.script)).toBe('a914b8f771de8bbdcfee76e0dbf76f1005f2028bf3e787');
    const tm = decodeZcashAddress('tmBMyeJebzkP5naji8XUKqLyL1NDwNkgJFt', 'test');
    expect(tm.kind).toBe('p2pkh');
    expect(bytesToHex(tm.script)).toBe('76a9141215d421cb8cec1dea62cbd9e4e07c01520d873f88ac');
    const textest = encodeTex(tm.hash, 'test');
    expect(textest.startsWith('textest1')).toBe(true);
    expect(bytesToHex(decodeZcashAddress(textest, 'test').hash)).toBe(bytesToHex(tm.hash));
  });

  it('accepts surrounding whitespace and an all-uppercase TEX', () => {
    const [taddr, , tex] = zip320Rows[0];
    expect(decodeZcashAddress(`  ${taddr}\n`).kind).toBe('p2pkh');
    expect(decodeZcashAddress(tex.toUpperCase()).kind).toBe('tex');
  });

  it('scriptToZcashAddress maps P2PKH and P2SH scripts back, nothing else', () => {
    const [taddr, p2pkhHex] = zip320Rows[1];
    expect(scriptToZcashAddress(p2pkhScript(hexToBytes(p2pkhHex)))).toBe(taddr);
    const h = hexToBytes('b8f771de8bbdcfee76e0dbf76f1005f2028bf3e7');
    expect(scriptToZcashAddress(p2shScript(h))).toBe(encodeP2sh(h));
    expect(scriptToZcashAddress(hexToBytes('6a0474657374'))).toBeNull();
    expect(scriptToZcashAddress(new Uint8Array(0))).toBeNull();
  });
});

describe('zcash address: refusals, with the message the form shows', () => {
  const [taddr, p2pkhHex, tex] = zip320Rows[0];

  it('refuses unified addresses (u1) with the shielded message', () => {
    const e = refusal('u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf');
    expect(e.code).toBe('unified');
    expect(e.message).toContain('shielded Zcash address');
    expect(e.message).toContain('t1, t3 or tex1');
    expect(e.message).not.toMatch(/—/);
    expect(refusal('utest1abcdef').code).toBe('unified');
  });

  it('refuses Sapling and Sprout addresses', () => {
    expect(refusal('zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly').code).toBe('shielded');
    expect(refusal('zcU1Cd6zYyZCd2VJF8yKgmzjxdiiU1rgTTjEwoN1CGUWCziPkUTXUjXmX7TMqdMNsTfuiGN1jQoVN4kGxUR4sAPN4XZ7pxb').code).toBe(
      'shielded',
    );
    expect(refusal('ztestsapling1abc').code).toBe('shielded');
  });

  it('refuses testnet forms on mainnet (tm, t2, textest)', () => {
    expect(refusal('tmQoJ3PTXgQLaRRZZYT6xk8XtjRbr2kCqwu').code).toBe('testnet');
    expect(refusal('t2PQpjcfpYHK1bcXZcSaTbg5cQRV93B2NRY').code).toBe('testnet');
    expect(refusal(encodeTex(hexToBytes(p2pkhHex), 'test')).code).toBe('testnet');
    // And the reverse on testnet.
    expect(refusal(taddr, 'test').code).toBe('format');
    expect(refusal(tex, 'test').code).toBe('format');
  });

  it('refuses a flipped checksum character', () => {
    const last = taddr[taddr.length - 1];
    const flipped = taddr.slice(0, -1) + (last === 'W' ? 'X' : 'W');
    expect(refusal(flipped).code).toBe('checksum');
    // TEX with one character changed, and a TEX with a bech32 (not bech32m) checksum.
    const texFlip = tex.slice(0, -1) + (tex.endsWith('q') ? 'p' : 'q');
    expect(refusal(texFlip).code).toBe('checksum');
    const bech32Tex = bech32.encode('tex', bech32.toWords(hexToBytes(p2pkhHex)));
    expect(refusal(bech32Tex).code).toBe('checksum');
  });

  it('refuses a 21-byte payload, a 23-byte payload and an unknown prefix', () => {
    const h = hexToBytes(p2pkhHex);
    expect(refusal(b58c.encode(concatBytes(Uint8Array.of(0x1c), h))).code).toBe('format');
    expect(refusal(b58c.encode(concatBytes(Uint8Array.of(0x1c, 0xb8, 0x00), h))).code).toBe('format');
    expect(refusal(b58c.encode(concatBytes(Uint8Array.of(0x1c, 0xb9), h))).code).toBe('format');
    // A Bitcoin address (one-byte prefix, 21-byte payload).
    expect(refusal('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').code).toBe('format');
  });

  it('refuses a TEX whose program is not 20 bytes, mixed case, and junk', () => {
    expect(refusal(bech32m.encode('tex', bech32m.toWords(new Uint8Array(21)))).code).toBe('format');
    const mixed = tex.slice(0, 6) + tex.slice(6).toUpperCase();
    expect(refusal(mixed).code).toBe('checksum');
    expect(refusal('').code).toBe('format');
    expect(refusal('   ').code).toBe('format');
    expect(refusal('t1 not an address').code).toBe('format');
    expect(refusal('0x52908400098527886E0F7030069857D2E4169EE7').code).toBe('format');
  });

  it('isValidZcashRecipient mirrors decode', () => {
    expect(isValidZcashRecipient(taddr)).toBe(true);
    expect(isValidZcashRecipient(tex)).toBe(true);
    expect(isValidZcashRecipient(encodeP2sh(hexToBytes(p2pkhHex)))).toBe(true);
    expect(isValidZcashRecipient('u1abc')).toBe(false);
    expect(isValidZcashRecipient('tmQoJ3PTXgQLaRRZZYT6xk8XtjRbr2kCqwu')).toBe(false);
    expect(isValidZcashRecipient('tmQoJ3PTXgQLaRRZZYT6xk8XtjRbr2kCqwu', 'test')).toBe(true);
  });

  it('refusal messages carry no em dashes', () => {
    for (const code of ['shielded', 'unified', 'testnet', 'checksum', 'format'] as const) {
      expect(new ZcashAddressError(code).message).not.toMatch(/—/);
    }
  });
});
