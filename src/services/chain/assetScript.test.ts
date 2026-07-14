import { describe, it, expect } from 'vitest';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import {
  OP_EVR_ASSET,
  OP_DROP,
  buildTransferAssetScriptFromHash160,
  buildTransferAssetScript,
  decodeAssetScript,
} from './assetScript';

// ---------------------------------------------------------------------------
// Real on-chain vectors, decoded from live Evrmore tx 85060ed6...472467.
// Whitespace is stripped by hexToBytes(script.trim()) via the decoder, but we
// pre-join here so the raw bytes are unambiguous.
// ---------------------------------------------------------------------------

// Transfer output: type "transfer_asset", asset {name:"SATORI!", amount:1.0}.
const TRANSFER_HEX =
  '76a91472e8ba9b5b0bd9cf46398f35155a9faf10e5e3eb88ac' + // P2PKH (25 bytes)
  'c0' + // OP_EVR_ASSET
  '14' + // pushlen = 20
  '65767274' + // "evrt"
  '07' + // name length 7
  '5341544f524921' + // "SATORI!"
  '00e1f50500000000' + // amount 100000000 LE
  '75'; // OP_DROP

// Reissue output: type "reissue_asset", {name:"SATORI", amount:45000, divisions:255, reissuable:1}.
const REISSUE_HEX =
  '76a9140262bfb0ac9a63e74a32f27aad59c435d2ddd75788ac' + // P2PKH (25 bytes)
  'c0' + // OP_EVR_ASSET
  '15' + // pushlen = 21
  '65767272' + // "evrr"
  '06' + // name length 6
  '5341544f5249' + // "SATORI"
  '00c8e6bc17040000' + // amount 4500000000000 LE
  'ff' + // divisions 255 (unchanged)
  '01' + // reissuable 1
  '75'; // OP_DROP

const TRANSFER_HASH160 = '72e8ba9b5b0bd9cf46398f35155a9faf10e5e3eb';

// A plain P2PKH scriptPubKey with NO asset payload.
const PLAIN_P2PKH_HEX = '76a91472e8ba9b5b0bd9cf46398f35155a9faf10e5e3eb88ac';

describe('decodeAssetScript — real on-chain vectors', () => {
  it('1. decodes the real transfer output', () => {
    const result = decodeAssetScript(TRANSFER_HEX);
    expect(result).not.toBeNull();
    expect(result!.transfer.kind).toBe('transfer');
    expect(result!.transfer.name).toBe('SATORI!');
    expect(result!.transfer.amount).toBe(100000000n);
    expect(bytesToHex(result!.p2pkhHash160)).toBe(TRANSFER_HASH160);
  });

  it('2. decodes the real reissue output', () => {
    const result = decodeAssetScript(REISSUE_HEX);
    expect(result).not.toBeNull();
    expect(result!.transfer.kind).toBe('reissue');
    expect(result!.transfer.name).toBe('SATORI');
    expect(result!.transfer.amount).toBe(4500000000000n);
  });
});

describe('buildTransferAssetScriptFromHash160 — round-trip', () => {
  it('3. build then decode preserves name, amount, kind, and hash160', () => {
    const h = hexToBytes(TRANSFER_HASH160);
    const script = buildTransferAssetScriptFromHash160(h, 'SATORI', 250000000n);
    const hex = bytesToHex(script);

    const decoded = decodeAssetScript(script);
    expect(decoded).not.toBeNull();
    expect(decoded!.transfer.kind).toBe('transfer');
    expect(decoded!.transfer.name).toBe('SATORI');
    expect(decoded!.transfer.amount).toBe(250000000n);
    expect(bytesToHex(decoded!.p2pkhHash160)).toBe(TRANSFER_HASH160);

    // Structural checks on the produced hex.
    expect(hex.endsWith('75')).toBe(true); // OP_DROP
    expect(hex.includes('c0')).toBe(true); // OP_EVR_ASSET
    expect(hex.includes('65767274')).toBe(true); // "evrt"

    // buildTransferAssetScript (address form) must agree with the hash160 form.
    // (We reuse the hash160 path indirectly by confirming the exported symbol
    // exists and produces the same layout for a decoded address is covered in
    // keys.test.ts; here we assert the constants are wired.)
    expect(OP_EVR_ASSET).toBe(0xc0);
    expect(OP_DROP).toBe(0x75);
    expect(typeof buildTransferAssetScript).toBe('function');
  });
});

describe('amount little-endian encoding', () => {
  it('4. building amount 100000000n yields amount bytes 00e1f50500000000', () => {
    const h = hexToBytes(TRANSFER_HASH160);
    const script = buildTransferAssetScriptFromHash160(h, 'SATORI', 100000000n);
    const hex = bytesToHex(script);
    // The 8-byte LE amount must appear verbatim in the script.
    expect(hex.includes('00e1f50500000000')).toBe(true);
  });
});

describe('push length correctness', () => {
  it('5. pushlen is 0x13 for a 6-char name and 0x14 for a 7-char name', () => {
    const h = hexToBytes(TRANSFER_HASH160);

    // Name "SATORI" (6): pushlen = 4 + 1 + 6 + 8 = 19 = 0x13.
    const s6 = buildTransferAssetScriptFromHash160(h, 'SATORI', 100000000n);
    // P2PKH is 25 bytes; byte[25] is OP_EVR_ASSET, byte[26] is the push length.
    expect(s6[25]).toBe(0xc0);
    expect(s6[26]).toBe(0x13);

    // Name "SATORI!" (7): pushlen = 4 + 1 + 7 + 8 = 20 = 0x14.
    const s7 = buildTransferAssetScriptFromHash160(h, 'SATORI!', 100000000n);
    expect(s7[25]).toBe(0xc0);
    expect(s7[26]).toBe(0x14);
  });
});

describe('non-asset scripts', () => {
  it('6. decodeAssetScript returns null for a plain P2PKH script', () => {
    expect(decodeAssetScript(PLAIN_P2PKH_HEX)).toBeNull();
  });
});

describe('validation', () => {
  it('7. building with an empty name or amount 0n throws', () => {
    const h = hexToBytes(TRANSFER_HASH160);
    expect(() => buildTransferAssetScriptFromHash160(h, '', 100000000n)).toThrow();
    expect(() => buildTransferAssetScriptFromHash160(h, 'SATORI', 0n)).toThrow();
  });
});
