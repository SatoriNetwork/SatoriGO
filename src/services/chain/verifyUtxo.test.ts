import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { parseTxOutputValues, parseTxOutputs, verifyInputAmounts } from './verifyUtxo';
import { txid as computeTxid } from './txBuilder';
import { buildTransferAssetScriptFromHash160 } from './assetScript';
import type { ElectrumClient } from './electrumTypes';
import { ELECTRUM_METHODS } from './network';

// --- helpers: build coherent legacy raw prevout txs -------------------------
function u64le(n: bigint): string {
  let s = '';
  for (let i = 0n; i < 8n; i++) s += Number((n >> (8n * i)) & 0xffn).toString(16).padStart(2, '0');
  return s;
}
/** One output as hex: 8-byte nValue + varint scriptLen (<253) + scriptPubKey. */
function outputHex(value: bigint, scriptHex: string): string {
  const bytes = scriptHex.length / 2;
  return u64le(value) + bytes.toString(16).padStart(2, '0') + scriptHex;
}
/** Legacy raw tx: 1 null input (seed as prevout hash) + the given outputs. */
function rawTxOuts(seedHash: string, outs: { value: bigint; scriptHex: string }[]): string {
  const seed = /^[0-9a-f]{64}$/i.test(seedHash) ? seedHash : '00'.repeat(32);
  let hex = '02000000' + '01' + seed + '00000000' + '00' + 'ffffffff';
  hex += outs.length.toString(16).padStart(2, '0');
  for (const o of outs) hex += outputHex(o.value, o.scriptHex);
  return hex + '00000000';
}
/** Legacy raw tx with OP_TRUE outputs carrying `values` (sats). */
function rawTx(seedHash: string, values: bigint[]): string {
  return rawTxOuts(seedHash, values.map((v) => ({ value: v, scriptHex: '51' })));
}

/** Client that serves blockchain.transaction.get from a txid->rawHex map. */
function txGetClient(raws: Map<string, string>): ElectrumClient {
  return {
    connect: async () => {},
    isConnected: () => true,
    endpoint: () => 'wss://fake',
    close: () => {},
    request: async (method: string, params: unknown[] = []) => {
      if (method === ELECTRUM_METHODS.txGet) {
        const raw = raws.get(params[0] as string);
        if (!raw) throw new Error('not-found');
        return raw as never;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const P2PKH = '76a9145865ae447b82872e393097ffdbfab548435a157b88ac';
const HASH160 = new Uint8Array([
  0x58, 0x65, 0xae, 0x44, 0x7b, 0x82, 0x87, 0x2e, 0x39, 0x30, 0x97, 0xff, 0xdb, 0xfa, 0xb5, 0x48,
  0x43, 0x5a, 0x15, 0x7b,
]);

describe('parseTxOutputs', () => {
  it('reads nValue AND scriptPubKey per output, in order', () => {
    const raw = rawTxOuts('a'.repeat(64), [
      { value: 0n, scriptHex: P2PKH },
      { value: 100_000_000n, scriptHex: '51' },
    ]);
    const outs = parseTxOutputs(raw);
    expect(outs).toHaveLength(2);
    expect(outs[0]).toEqual({ nValue: 0n, scriptHex: P2PKH });
    expect(outs[1]).toEqual({ nValue: 100_000_000n, scriptHex: '51' });
  });

  it('rejects a segwit-marked tx (Evrmore has no segwit)', () => {
    expect(() => parseTxOutputs('0200000000' + '01' + '00')).toThrow(/segwit/);
  });

  it('throws on a truncated tx', () => {
    expect(() => parseTxOutputs('0200000001')).toThrow(/malformed/);
  });
});

describe('parseTxOutputValues (nValue projection)', () => {
  it('reads output values in order', () => {
    const raw = rawTx('a'.repeat(64), [0n, 1n, 100_000_000n, 5_000_000_000n]);
    expect(parseTxOutputValues(raw)).toEqual([0n, 1n, 100_000_000n, 5_000_000_000n]);
  });
});

describe('verifyInputAmounts — EVR inputs', () => {
  it('passes when nValue AND scriptPubKey match the authentic prevout', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('c'.repeat(64), [
      { value: 7n, scriptHex: '51' },
      { value: 100_000_000n, scriptHex: P2PKH },
    ]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 1, valueSats: 100_000_000n, scriptPubKeyHex: P2PKH, kind: 'evr' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('THROWS when the server under-reports a value (the drain attack)', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('d'.repeat(64), [{ value: 100_000_000n, scriptHex: P2PKH }]); // real 1 EVR
    const id = computeTxid(raw);
    raws.set(id, raw);
    // Wallet was told this UTXO is only 1000 sats -> must be rejected.
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 0, valueSats: 1000n, scriptPubKeyHex: P2PKH, kind: 'evr' },
      ]),
    ).rejects.toThrow('input-value-mismatch');
  });

  it('THROWS when the prevout scriptPubKey does not match the claimed script', async () => {
    const raws = new Map<string, string>();
    // Authentic prevout pays a DIFFERENT script than the wallet claims to own.
    const other = '76a914' + '11'.repeat(20) + '88ac';
    const raw = rawTxOuts('e'.repeat(64), [{ value: 100_000_000n, scriptHex: other }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 0, valueSats: 100_000_000n, scriptPubKeyHex: P2PKH, kind: 'evr' },
      ]),
    ).rejects.toThrow('input-verify-failed');
  });

  it('THROWS when the returned prevout does not hash to the claimed txid', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('e'.repeat(64), [{ value: 100_000_000n, scriptHex: P2PKH }]);
    const lied = 'f'.repeat(64);
    raws.set(lied, raw);
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: lied, vout: 0, valueSats: 100_000_000n, scriptPubKeyHex: P2PKH, kind: 'evr' },
      ]),
    ).rejects.toThrow('input-verify-failed');
  });

  it('THROWS when the referenced vout is out of range', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('a'.repeat(64), [{ value: 100_000_000n, scriptHex: P2PKH }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 3, valueSats: 100_000_000n, scriptPubKeyHex: P2PKH, kind: 'evr' },
      ]),
    ).rejects.toThrow('input-verify-failed');
  });

  it('defaults to EVR verification when kind is omitted', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('b'.repeat(64), [{ value: 42n, scriptHex: P2PKH }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 0, valueSats: 42n, scriptPubKeyHex: P2PKH },
      ]),
    ).resolves.toBeUndefined();
  });

  it('fetches each prevout only once (cached across inputs of the same tx)', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('b'.repeat(64), [
      { value: 10n, scriptHex: P2PKH },
      { value: 20n, scriptHex: P2PKH },
    ]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    let calls = 0;
    const client: ElectrumClient = {
      connect: async () => {},
      isConnected: () => true,
      endpoint: () => 'wss://fake',
      close: () => {},
      request: async (method: string, params: unknown[] = []) => {
        if (method === ELECTRUM_METHODS.txGet) {
          calls++;
          return raws.get(params[0] as string) as never;
        }
        throw new Error('unexpected');
      },
    };
    await verifyInputAmounts(client, [
      { txid: id, vout: 0, valueSats: 10n, scriptPubKeyHex: P2PKH, kind: 'evr' },
      { txid: id, vout: 1, valueSats: 20n, scriptPubKeyHex: P2PKH, kind: 'evr' },
    ]);
    expect(calls).toBe(1);
  });
});

describe('verifyInputAmounts — ASSET inputs (nValue=0, amount in the script)', () => {
  const SATORI_AMT = 20_547_945_205n;
  const assetScriptHex = bytesToHex(buildTransferAssetScriptFromHash160(HASH160, 'SATORI', SATORI_AMT));

  it('passes for a real-shaped asset prevout (nValue=0, amount in OP_EVR_ASSET)', async () => {
    const raws = new Map<string, string>();
    // Real shape: asset output has nValue 0; a plain EVR output can sit alongside.
    const raw = rawTxOuts('c'.repeat(64), [
      { value: 0n, scriptHex: assetScriptHex },
      { value: 5000n, scriptHex: P2PKH },
    ]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 0, valueSats: SATORI_AMT, scriptPubKeyHex: assetScriptHex, kind: 'asset' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('THROWS when the prevout script encodes a DIFFERENT amount than claimed (drain)', async () => {
    const raws = new Map<string, string>();
    // Authentic prevout really holds only 10 units...
    const realScript = bytesToHex(buildTransferAssetScriptFromHash160(HASH160, 'SATORI', 1_000_000_000n));
    const raw = rawTxOuts('d'.repeat(64), [{ value: 0n, scriptHex: realScript }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    // ...but the wallet claims 100 units (server over-reported).
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 0, valueSats: 10_000_000_000n, scriptPubKeyHex: assetScriptHex, kind: 'asset' },
      ]),
    ).rejects.toThrow('input-value-mismatch');
  });

  it('THROWS when nValue is non-zero on an asset output (tampered)', async () => {
    const raws = new Map<string, string>();
    // Real asset outputs carry nValue 0; a non-zero nValue is anomalous -> reject.
    const raw = rawTxOuts('e'.repeat(64), [{ value: 12345n, scriptHex: assetScriptHex }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 0, valueSats: SATORI_AMT, scriptPubKeyHex: assetScriptHex, kind: 'asset' },
      ]),
    ).rejects.toThrow('input-value-mismatch');
  });

  it('THROWS when the prevout script is a DIFFERENT asset name than claimed', async () => {
    const raws = new Map<string, string>();
    const otherName = bytesToHex(buildTransferAssetScriptFromHash160(HASH160, 'OTHER', SATORI_AMT));
    const raw = rawTxOuts('a'.repeat(64), [{ value: 0n, scriptHex: otherName }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 0, valueSats: SATORI_AMT, scriptPubKeyHex: assetScriptHex, kind: 'asset' },
      ]),
    ).rejects.toThrow('input-verify-failed');
  });

  it('THROWS when the prevout is not an asset script at all (kind=asset, plain P2PKH)', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('b'.repeat(64), [{ value: 0n, scriptHex: P2PKH }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 0, valueSats: SATORI_AMT, scriptPubKeyHex: assetScriptHex, kind: 'asset' },
      ]),
    ).rejects.toThrow('input-verify-failed');
  });

  it('THROWS when the asset prevout does not hash to the claimed txid', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('c'.repeat(64), [{ value: 0n, scriptHex: assetScriptHex }]);
    const lied = 'e'.repeat(64);
    raws.set(lied, raw); // registered under a wrong txid
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: lied, vout: 0, valueSats: SATORI_AMT, scriptPubKeyHex: assetScriptHex, kind: 'asset' },
      ]),
    ).rejects.toThrow('input-verify-failed');
  });
});

describe('verifyInputAmounts — cross-chain marker family (fail closed)', () => {
  const AMT = 20_547_945_205n;
  const rvntScript = bytesToHex(buildTransferAssetScriptFromHash160(HASH160, 'SATORI', AMT, 'rvn'));
  const evrtScript = bytesToHex(buildTransferAssetScriptFromHash160(HASH160, 'SATORI', AMT, 'evr'));

  it('accepts an rvnt prevout when verifying as the rvn family', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('c'.repeat(64), [{ value: 0n, scriptHex: rvntScript }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(
        txGetClient(raws),
        [{ txid: id, vout: 0, valueSats: AMT, scriptPubKeyHex: rvntScript, kind: 'asset' }],
        'rvn',
      ),
    ).resolves.toBeUndefined();
  });

  it('REJECTS an evrt prevout while the wallet is sending on RVN (rvnt claimed, verify as rvn)', async () => {
    const raws = new Map<string, string>();
    // On-chain prevout is an Evrmore ("evrt") output; the RVN wallet built an
    // "rvnt" claimed script and verifies as 'rvn'. The wrong-family on-chain
    // script decodes to null under 'rvn' -> fail closed.
    const raw = rawTxOuts('d'.repeat(64), [{ value: 0n, scriptHex: evrtScript }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    await expect(
      verifyInputAmounts(
        txGetClient(raws),
        [{ txid: id, vout: 0, valueSats: AMT, scriptPubKeyHex: rvntScript, kind: 'asset' }],
        'rvn',
      ),
    ).rejects.toThrow('input-verify-failed');
  });

  it('REJECTS an rvnt prevout while the wallet is sending on EVR (evrt claimed, verify as evr default)', async () => {
    const raws = new Map<string, string>();
    const raw = rawTxOuts('e'.repeat(64), [{ value: 0n, scriptHex: rvntScript }]);
    const id = computeTxid(raw);
    raws.set(id, raw);
    // Default prefix is 'evr' — an rvnt on-chain output decodes to null under it.
    await expect(
      verifyInputAmounts(txGetClient(raws), [
        { txid: id, vout: 0, valueSats: AMT, scriptPubKeyHex: evrtScript, kind: 'asset' },
      ]),
    ).rejects.toThrow('input-verify-failed');
  });
});

// --- KNOWN-ANSWER: a REAL on-chain SATORI transfer output ---------------------
// Fetched live from the Evrmore chain on 2026-07-13 (scripts/verify-utxo-probe.ts):
//   txid  3bac2c022f35a0657e17f4d5ab758d5b107142462f7ad49f3ea93fd0fff4cec6
//   vout 0: nValue = 0, listunspent.value = 20547945205 (SATORI base units),
//   scriptPubKey = 76a914 5865ae44…157b 88ac  c0 13 65767274 06 5341544f5249
//                  f5c2c0c804000000 75  (OP_EVR_ASSET "evrt" SATORI amount LE).
describe('parseTxOutputs — real on-chain SATORI transfer output (known answer)', () => {
  const REAL_SCRIPT =
    '76a9145865ae447b82872e393097ffdbfab548435a157b88ac' +
    'c0' +
    '13' +
    '65767274' + // "evrt"
    '06' +
    '5341544f5249' + // "SATORI"
    'f5c2c0c804000000' + // 20547945205 LE
    '75';
  // Reconstruct the same output via our encoder and assert byte-equality (the
  // encoder is the source of truth the wallet actually uses to build/verify).
  it('our transfer-script encoder reproduces the real on-chain script byte-for-byte', () => {
    const rebuilt = bytesToHex(buildTransferAssetScriptFromHash160(HASH160, 'SATORI', 20_547_945_205n));
    expect(rebuilt).toBe(REAL_SCRIPT);
  });

  it('parses the real output as nValue=0 + the asset script', () => {
    const raw = rawTxOuts('a'.repeat(64), [{ value: 0n, scriptHex: REAL_SCRIPT }]);
    const outs = parseTxOutputs(raw);
    expect(outs[0].nValue).toBe(0n);
    expect(outs[0].scriptHex).toBe(REAL_SCRIPT);
  });
});
