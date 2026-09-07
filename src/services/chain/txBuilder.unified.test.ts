// SIGHASH_UNIFIED: the Bitcoin Knots opt-in signature hash Bitcoin BLAKE2b
// signs with (doc/unified-sighash.md, bitcoinknots/bitcoin v29.4.1.knots20260508).
//
// Two things are pinned here. First, the digest itself, against the vectors
// Knots ships (src/test/data/unified_sighash.json, copied to testdata/): every
// script-type 0 (bare/P2SH) and 1 (segwit v0) row, which is what this builder
// can spend; the 24 taproot rows are skipped on purpose. Second, that a send on
// the BLAKE2b chain actually uses it: the witness carries hash type 0x21, the
// signature verifies against the unified digest and NOT against BIP143, and the
// same build on Bitcoin still signs SIGHASH_ALL. That second half is the replay
// protection: a signature over the unified message does not verify on Bitcoin.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import {
  buildAndSignEvrTx,
  bip143Sighash,
  p2wpkhScriptCode,
  unifiedSighash,
  SIGHASH_UNIFIED,
  type SighashTx,
  type SpentOutput,
  type UnifiedScriptType,
} from './txBuilder';
import { hash160, pubkeyToAddress } from './keys';
import { BITCOIN_BLAKE2B_MAINNET, BITCOIN_MAINNET } from './chainParams';

// --- a minimal raw transaction parser (segwit-aware), for the vectors and for
//     reading back what the builder produced ---------------------------------
interface ParsedTx extends SighashTx {
  witnesses: Uint8Array[][];
}

function parseRawTx(hex: string): ParsedTx {
  const b = hexToBytes(hex);
  let o = 0;
  const u32 = () => {
    const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
    o += 4;
    return v >>> 0;
  };
  const u64 = () => {
    let v = 0n;
    for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[o + i]);
    o += 8;
    return v;
  };
  const varint = () => {
    const first = b[o];
    o += 1;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = b[o] | (b[o + 1] << 8);
      o += 2;
      return v;
    }
    if (first === 0xfe) return u32();
    throw new Error('varint too large for these vectors');
  };
  const bytes = (n: number) => {
    const v = b.slice(o, o + n);
    o += n;
    return v;
  };
  const version = u32();
  let segwit = false;
  if (b[o] === 0x00 && b[o + 1] === 0x01) {
    segwit = true;
    o += 2;
  }
  const nIn = varint();
  const inputs: SighashTx['inputs'] = [];
  for (let i = 0; i < nIn; i += 1) {
    const txid = bytesToHex(bytes(32).reverse());
    const vout = u32();
    bytes(varint()); // scriptSig, not part of any sighash here
    const sequence = u32();
    inputs.push({ txid, vout, sequence });
  }
  const nOut = varint();
  const outputs: SighashTx['outputs'] = [];
  for (let i = 0; i < nOut; i += 1) {
    const valueSats = u64();
    const scriptPubKey = bytes(varint());
    outputs.push({ valueSats, scriptPubKey });
  }
  const witnesses: Uint8Array[][] = [];
  if (segwit) {
    for (let i = 0; i < nIn; i += 1) {
      const items = varint();
      const stack: Uint8Array[] = [];
      for (let j = 0; j < items; j += 1) stack.push(bytes(varint()));
      witnesses.push(stack);
    }
  }
  const locktime = u32();
  if (o !== b.length) throw new Error(`trailing bytes: ${b.length - o}`);
  return { version, inputs, outputs, locktime, witnesses };
}

/** DER (as it sits in a scriptSig/witness) -> the 64-byte compact form noble verifies. */
function derToCompact(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('not a DER sequence');
  let o = 2;
  const readInt = () => {
    if (der[o] !== 0x02) throw new Error('DER: expected INTEGER');
    const len = der[o + 1];
    let v = der.slice(o + 2, o + 2 + len);
    o += 2 + len;
    while (v.length > 32 && v[0] === 0x00) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = readInt();
  const sv = readInt();
  return new Uint8Array([...r, ...sv]);
}

type VectorRow = [string, string, number, number, number, [number, string][], string];

function loadVectors(): VectorRow[] {
  const path = fileURLToPath(new URL('./testdata/unified_sighash.json', import.meta.url));
  const rows = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
  // Row 0 is the column header.
  return rows.slice(1) as VectorRow[];
}

describe('SIGHASH_UNIFIED digest against the Knots vectors', () => {
  const rows = loadVectors();
  const usable = rows.filter((r) => Number(r[4]) === 0 || Number(r[4]) === 1);

  it('ships the vector file with the expected shape', () => {
    expect(rows).toHaveLength(166);
    expect(usable.length).toBe(142); // 76 bare/P2SH + 66 segwit v0
  });

  it.each(usable.map((r, i) => [i, Number(r[3]), Number(r[4]), r] as const))(
    'vector %i (hashType 0x%s, script type %i) reproduces the published digest',
    (_i, _ht, _st, row) => {
      const [scriptCodeHex, rawTx, inIdx, hashType, scriptType, spentRows, expected] = row;
      const tx = parseRawTx(rawTx);
      const spent: SpentOutput[] = spentRows.map(([value, spk]) => ({
        valueSats: BigInt(value),
        scriptPubKey: hexToBytes(spk),
      }));
      const digest = unifiedSighash(
        tx,
        spent,
        Number(inIdx),
        Number(hashType),
        Number(scriptType) as UnifiedScriptType,
        hexToBytes(scriptCodeHex),
      );
      expect(bytesToHex(digest)).toBe(expected);
    },
  );

  it('refuses a hash type without the opt-in bit, a missing spent output, and SINGLE with no output', () => {
    const [scriptCodeHex, rawTx, inIdx, , , spentRows] = usable[0];
    const tx = parseRawTx(rawTx);
    const spent: SpentOutput[] = spentRows.map(([value, spk]) => ({ valueSats: BigInt(value), scriptPubKey: hexToBytes(spk) }));
    expect(() => unifiedSighash(tx, spent, Number(inIdx), 0x01, 0, hexToBytes(scriptCodeHex))).toThrow(/SIGHASH_UNIFIED/);
    expect(() => unifiedSighash(tx, spent.slice(1), Number(inIdx), 0x21, 0, hexToBytes(scriptCodeHex))).toThrow(/spent outputs/);
    const single = { ...tx, outputs: [] };
    expect(() => unifiedSighash(single, spent, 0, 0x23, 0, hexToBytes(scriptCodeHex))).toThrow(/SIGHASH_SINGLE/);
  });
});

describe('a send on Bitcoin BLAKE2b signs the unified message', () => {
  const priv = hexToBytes('1111111111111111111111111111111111111111111111111111111111111111');
  const pub = secp256k1.getPublicKey(priv, true);
  const spk = new Uint8Array([0x00, 0x14, ...hash160(pub)]);
  const utxo = {
    txid: 'ab'.repeat(32),
    vout: 1,
    valueSats: 50_000n,
    scriptPubKeyHex: bytesToHex(spk),
    privateKey: priv,
    publicKey: pub,
  };
  const to = pubkeyToAddress(secp256k1.getPublicKey(hexToBytes('22'.repeat(32)), true), BITCOIN_MAINNET);

  function build(net: typeof BITCOIN_MAINNET) {
    const built = buildAndSignEvrTx({
      inputs: [utxo],
      outputs: [{ address: to, valueSats: 20_000n }],
      changeAddress: pubkeyToAddress(pub, net),
      feeSats: 1_000n,
      net,
    });
    return { built, parsed: parseRawTx(built.rawHex) };
  }

  it('witness hash type is ALL|UNIFIED (0x21) and the signature verifies against the unified digest only', () => {
    const { parsed } = build(BITCOIN_BLAKE2B_MAINNET);
    const [sig, witPub] = parsed.witnesses[0];
    expect(bytesToHex(witPub)).toBe(bytesToHex(pub));
    expect(sig[sig.length - 1]).toBe(0x01 | SIGHASH_UNIFIED);
    const der = derToCompact(sig.slice(0, -1));
    const scriptCode = p2wpkhScriptCode(hash160(pub));
    const unified = unifiedSighash(parsed, [{ valueSats: utxo.valueSats, scriptPubKey: spk }], 0, 0x21, 1, scriptCode);
    expect(secp256k1.verify(der, unified, pub)).toBe(true);
    // The very same signature is NOT a valid BIP143 signature: a Bitcoin node
    // (which reads 0x21 under the legacy rules) computes a different message.
    const bip143 = bip143Sighash(parsed, 0, scriptCode, utxo.valueSats);
    expect(secp256k1.verify(der, bip143, pub)).toBe(false);
  });

  it('the same build on Bitcoin still signs plain SIGHASH_ALL under BIP143', () => {
    const { parsed } = build(BITCOIN_MAINNET);
    const [sig] = parsed.witnesses[0];
    expect(sig[sig.length - 1]).toBe(0x01);
    const der = derToCompact(sig.slice(0, -1));
    const bip143 = bip143Sighash(parsed, 0, p2wpkhScriptCode(hash160(pub)), utxo.valueSats);
    expect(secp256k1.verify(der, bip143, pub)).toBe(true);
  });

  it('the two chains produce the same addresses from the same key', () => {
    expect(pubkeyToAddress(pub, BITCOIN_BLAKE2B_MAINNET)).toBe(pubkeyToAddress(pub, BITCOIN_MAINNET));
  });
});
