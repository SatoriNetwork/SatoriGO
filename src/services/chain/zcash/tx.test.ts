// Parser and serializer (design §4.2, §4.3, §6.3): the four Trezor-signed
// testnet v5 transactions, live mainnet v4/v5/v6/coinbase transactions whose
// txids the network assigned, and the "unrecognised" and malformed paths.

import { describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import {
  ZCASH_V5_HEADER,
  ZCASH_V5_VERSION_GROUP_ID,
  ZCASH_V6_HEADER,
  ZCASH_V6_VERSION_GROUP_ID,
  ZcashTxParseError,
  parseZcashTx,
  serializeV5,
} from './tx';
import { u32le } from './sighash';
import trezor from './testing/trezor_v5.json';
import mainnet from './testing/mainnet_txs.json';

interface Fx {
  txid: string;
  hex: string;
  height: number;
}
const live = mainnet as unknown as Record<'v4' | 'v5t' | 'v6t' | 'cb' | 'v5s' | 'v6s', Fx>;

describe('parse: Trezor-signed testnet v5 transactions', () => {
  it.each(trezor.cases)('$name', (c) => {
    const tx = parseZcashTx(hexToBytes(c.hex));
    expect(tx.version).toBe(5);
    expect(tx.header).toBe(ZCASH_V5_HEADER);
    expect(tx.versionGroupId).toBe(ZCASH_V5_VERSION_GROUP_ID);
    expect(tx.branchId).toBe(trezor.branchId);
    expect(tx.expiryHeight).toBe(0);
    expect(tx.txid).toBe(c.txid);
    expect(tx.coinbase).toBe(false);
    expect(tx.vin).toHaveLength(c.inputs.length);
    expect(bytesToHex(tx.vin[0].prevTxid.slice().reverse())).toBe(c.inputs[0].txid);
    expect(tx.vout.map((o) => o.value.toString())).toEqual(c.outputs.map((o) => o.value));
    // Re-serializing the parsed transaction gives the same bytes.
    expect(bytesToHex(serializeV5(tx, 5))).toBe(c.hex);
  });
});

describe('parse: live mainnet transactions (txids as the network assigned them)', () => {
  it('v4 transaction: txid is SHA256d of the raw bytes', () => {
    const tx = parseZcashTx(hexToBytes(live.v4.hex));
    expect(tx.version).toBe(4);
    expect(tx.txid).toBe(live.v4.txid);
    expect(tx.branchId).toBe(0);
    expect(tx.expiryHeight).toBeGreaterThan(0);
  });

  it('v5 transparent-only: ZIP-244 txid and a byte-identical re-serialization', () => {
    const tx = parseZcashTx(hexToBytes(live.v5t.hex));
    expect(tx.version).toBe(5);
    expect(tx.txid).toBe(live.v5t.txid);
    expect(tx.branchId).toBe(0x37a5165b);
    expect(bytesToHex(serializeV5(tx, 5))).toBe(live.v5t.hex);
  });

  it('v6 transparent-only: ZIP-244/229 txid and a byte-identical v6 re-serialization', () => {
    const tx = parseZcashTx(hexToBytes(live.v6t.hex));
    expect(tx.version).toBe(6);
    expect(tx.header).toBe(ZCASH_V6_HEADER);
    expect(tx.versionGroupId).toBe(ZCASH_V6_VERSION_GROUP_ID);
    expect(tx.txid).toBe(live.v6t.txid);
    expect(tx.ironwood?.actions).toHaveLength(0);
    expect(bytesToHex(serializeV5(tx, 6))).toBe(live.v6t.hex);
  });

  it('v5 and v6 with shielded bundles: the txid commits to them', () => {
    const v5 = parseZcashTx(hexToBytes(live.v5s.hex));
    expect(v5.version).toBe(5);
    expect(v5.txid).toBe(live.v5s.txid);
    const v6 = parseZcashTx(hexToBytes(live.v6s.hex));
    expect(v6.version).toBe(6);
    expect(v6.txid).toBe(live.v6s.txid);
    const shielded = (t: typeof v5) =>
      (t.sapling?.spends.length ?? 0) + (t.sapling?.outputs.length ?? 0) + (t.orchard?.actions.length ?? 0) + (t.ironwood?.actions.length ?? 0);
    expect(shielded(v5)).toBeGreaterThan(0);
    expect(shielded(v6)).toBeGreaterThan(0);
    // The transparent-only serializer refuses them.
    expect(() => serializeV5(v5, 5)).toThrow(/transparent-only/);
  });

  it('coinbase transaction is flagged', () => {
    const tx = parseZcashTx(hexToBytes(live.cb.hex));
    expect(tx.coinbase).toBe(true);
    expect(tx.txid).toBe(live.cb.txid);
    for (const k of ['v4', 'v5t', 'v6t', 'v5s', 'v6s'] as const) expect(parseZcashTx(hexToBytes(live[k].hex)).coinbase).toBe(false);
  });
});

describe('parse: unrecognised versions never throw', () => {
  it('a v7 ("NuTachyon" group 0x74616368) is version unknown with no txid', () => {
    const raw = concatBytes(u32le(0x80000007), u32le(0x74616368), new Uint8Array(40));
    const tx = parseZcashTx(raw);
    expect(tx.version).toBe('unknown');
    expect(tx.txid).toBe('');
    expect(tx.header).toBe(0x80000007);
    expect(tx.vin).toHaveLength(0);
  });

  it('a v5 header with a foreign version group is unknown, as is a non-overwintered v5', () => {
    const v5 = hexToBytes(live.v5t.hex);
    const wrongGroup = Uint8Array.from(v5);
    wrongGroup.set(u32le(0x12345678), 4);
    expect(parseZcashTx(wrongGroup).version).toBe('unknown');
    const notOverwintered = Uint8Array.from(v5);
    notOverwintered.set(u32le(5), 0);
    expect(parseZcashTx(notOverwintered).version).toBe('unknown');
  });
});

describe('parse: malformed bytes of a known version throw ZcashTxParseError', () => {
  const v5 = hexToBytes(live.v5t.hex);
  it('truncated', () => {
    expect(() => parseZcashTx(v5.slice(0, v5.length - 1))).toThrow(ZcashTxParseError);
    expect(() => parseZcashTx(v5.slice(0, 3))).toThrow(ZcashTxParseError);
  });
  it('trailing bytes', () => {
    expect(() => parseZcashTx(concatBytes(v5, Uint8Array.of(0)))).toThrow(ZcashTxParseError);
  });
  it('non-canonical compactSize', () => {
    // Input count 1 encoded as fd 01 00.
    const bad = concatBytes(v5.slice(0, 20), Uint8Array.of(0xfd, v5[20], 0x00), v5.slice(21));
    expect(() => parseZcashTx(bad)).toThrow(/non-canonical/);
  });
  it('a count larger than the transaction', () => {
    const bad = concatBytes(v5.slice(0, 20), Uint8Array.of(0xfe, 0xff, 0xff, 0xff, 0x00), v5.slice(21));
    expect(() => parseZcashTx(bad)).toThrow(ZcashTxParseError);
  });
});

describe('serializeV5 guards', () => {
  const tx = parseZcashTx(hexToBytes(live.v5t.hex));
  it('header and version group must match the chosen version', () => {
    expect(() => serializeV5(tx, 6)).toThrow(/do not match/);
  });
  it('a missing branch id is refused', () => {
    expect(() => serializeV5({ ...tx, branchId: 0 }, 5)).toThrow(/branch id/);
  });
  it('a 1-in 2-out P2PKH transaction with a 71-byte DER signature is 241 bytes', () => {
    // Shape check without a key: scriptSig = push(72) + push(33) = 107 bytes.
    const shaped = {
      ...tx,
      vin: [{ prevTxid: new Uint8Array(32), prevIndex: 0, scriptSig: new Uint8Array(107), sequence: 0xffffffff }],
      vout: [
        { value: 1n, script: new Uint8Array(25) },
        { value: 2n, script: new Uint8Array(25) },
      ],
    };
    expect(serializeV5(shaped, 5).length).toBe(241);
  });
});
