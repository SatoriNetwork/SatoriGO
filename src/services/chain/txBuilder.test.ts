// Tests for the Evrmore legacy transaction builder + signer.
//
// The load-bearing proof is test #1: it independently recomputes the legacy
// SIGHASH_ALL preimage from first principles (not reusing txBuilder's internals),
// double-SHA256s it, extracts the DER signature + pubkey from the produced
// scriptSig, and asserts secp256k1.verify() is TRUE with a canonical low-S value.

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import { deriveAddress, p2pkhScript, addressToHash160, hash160, pubkeyToAddress } from './keys';
import { EVRMORE_MAINNET } from './chainParams';
import { decodeAssetScript } from './assetScript';
import {
  estimateTxBytes,
  selectCoins,
  buildAndSignEvrTx,
  buildAndSignAssetTransfer,
  txid,
  DUST_THRESHOLD_SATS,
  type SignableUtxo,
} from './txBuilder';

const COIN = 100_000_000n; // 1 EVR in sats

// ---------------------------------------------------------------------------
// Independent (test-local) serialization + legacy sighash — do NOT import from
// txBuilder, so this is a genuine cross-check of the production code.
// ---------------------------------------------------------------------------

function u32LE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

function u64LE(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff);
  return concatBytes(Uint8Array.of(0xfe), u32LE(n));
}

function reverseHexToBytes(txidHex: string): Uint8Array {
  return hexToBytes(txidHex).slice().reverse();
}

function hash256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

interface RawInput {
  txid: string;
  vout: number;
  scriptSig: Uint8Array;
  sequence: number;
}
interface RawOutput {
  valueSats: bigint;
  scriptPubKey: Uint8Array;
}

function serializeInput(inp: RawInput, scriptSig: Uint8Array): Uint8Array {
  return concatBytes(
    reverseHexToBytes(inp.txid),
    u32LE(inp.vout),
    varint(scriptSig.length),
    scriptSig,
    u32LE(inp.sequence),
  );
}

function serializeOutput(o: RawOutput): Uint8Array {
  return concatBytes(u64LE(o.valueSats), varint(o.scriptPubKey.length), o.scriptPubKey);
}

function serializeTx(
  version: number,
  inputs: RawInput[],
  outputs: RawOutput[],
  locktime: number,
  scriptSigOverrides?: Uint8Array[],
): Uint8Array {
  const parts: Uint8Array[] = [u32LE(version), varint(inputs.length)];
  for (let i = 0; i < inputs.length; i++) {
    const ss = scriptSigOverrides ? scriptSigOverrides[i] : inputs[i].scriptSig;
    parts.push(serializeInput(inputs[i], ss));
  }
  parts.push(varint(outputs.length));
  for (const o of outputs) parts.push(serializeOutput(o));
  parts.push(u32LE(locktime));
  return concatBytes(...parts);
}

/** Independent legacy SIGHASH_ALL digest computation. */
function independentLegacySighash(
  version: number,
  inputs: RawInput[],
  outputs: RawOutput[],
  locktime: number,
  index: number,
  prevoutScript: Uint8Array,
): Uint8Array {
  const overrides = inputs.map((_, i) => (i === index ? prevoutScript : new Uint8Array(0)));
  const preimage = concatBytes(
    serializeTx(version, inputs, outputs, locktime, overrides),
    u32LE(0x01), // SIGHASH_ALL, little-endian
  );
  return hash256(preimage);
}

// ---------------------------------------------------------------------------
// Raw-tx parser — used to assert the produced rawHex structure.
// ---------------------------------------------------------------------------

interface ParsedTx {
  version: number;
  inputs: { txid: string; vout: number; scriptSig: Uint8Array; sequence: number }[];
  outputs: { valueSats: bigint; scriptPubKey: Uint8Array }[];
  locktime: number;
}

function parseRawTx(rawHex: string): ParsedTx {
  const bytes = hexToBytes(rawHex);
  let offset = 0;

  const readU32 = (): number => {
    const v = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
    offset += 4;
    return v >>> 0;
  };
  const readU64 = (): bigint => {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
    offset += 8;
    return v;
  };
  const readVarint = (): number => {
    const first = bytes[offset++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = bytes[offset] | (bytes[offset + 1] << 8);
      offset += 2;
      return v;
    }
    if (first === 0xfe) {
      const v = readU32.call(null);
      return v;
    }
    throw new Error('64-bit varint not supported in test parser');
  };
  const readBytes = (n: number): Uint8Array => {
    const out = bytes.slice(offset, offset + n);
    offset += n;
    return out;
  };

  const version = readU32();
  const numInputs = readVarint();
  const inputs: ParsedTx['inputs'] = [];
  for (let i = 0; i < numInputs; i++) {
    const txidBytes = readBytes(32).slice().reverse();
    const txidHex = bytesToHex(txidBytes);
    const vout = readU32();
    const scriptLen = readVarint();
    const scriptSig = readBytes(scriptLen);
    const sequence = readU32();
    inputs.push({ txid: txidHex, vout, scriptSig, sequence });
  }
  const numOutputs = readVarint();
  const outputs: ParsedTx['outputs'] = [];
  for (let i = 0; i < numOutputs; i++) {
    const valueSats = readU64();
    const scriptLen = readVarint();
    const scriptPubKey = readBytes(scriptLen);
    outputs.push({ valueSats, scriptPubKey });
  }
  const locktime = readU32();
  expect(offset).toBe(bytes.length); // no trailing bytes
  return { version, inputs, outputs, locktime };
}

/**
 * Extract (DER sig bytes, sighash-type byte, pubkey bytes) from a P2PKH
 * scriptSig: <pushlen1><sig||type> <pushlen2><pubkey>.
 */
function parseP2pkhScriptSig(scriptSig: Uint8Array): {
  derSig: Uint8Array;
  sighashType: number;
  pubkey: Uint8Array;
} {
  let off = 0;
  const len1 = scriptSig[off++];
  const sigWithType = scriptSig.slice(off, off + len1);
  off += len1;
  const len2 = scriptSig[off++];
  const pubkey = scriptSig.slice(off, off + len2);
  off += len2;
  expect(off).toBe(scriptSig.length);
  const sighashType = sigWithType[sigWithType.length - 1];
  const derSig = sigWithType.slice(0, sigWithType.length - 1);
  return { derSig, sighashType, pubkey };
}

/** Parse a strict-DER ECDSA signature into (r, s) bigints. */
function parseDer(der: Uint8Array): { r: bigint; s: bigint } {
  let off = 0;
  expect(der[off++]).toBe(0x30); // SEQUENCE
  const totalLen = der[off++];
  expect(totalLen).toBe(der.length - 2);
  expect(der[off++]).toBe(0x02); // INTEGER (r)
  const rLen = der[off++];
  const rBytes = der.slice(off, off + rLen);
  off += rLen;
  expect(der[off++]).toBe(0x02); // INTEGER (s)
  const sLen = der[off++];
  const sBytes = der.slice(off, off + sLen);
  off += sLen;
  expect(off).toBe(der.length);
  const toBig = (b: Uint8Array): bigint => {
    let v = 0n;
    for (const byte of b) v = (v << 8n) | BigInt(byte);
    return v;
  };
  return { r: toBig(rBytes), s: toBig(sBytes) };
}

// secp256k1 curve order, for the low-S canonical check.
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const CURVE_N_HALF = CURVE_N >> 1n;

// ---------------------------------------------------------------------------
// Fixtures: derive a deterministic key from a fixed seed and fabricate UTXOs.
// ---------------------------------------------------------------------------

// Fixed 64-byte seed (deterministic; not a real wallet seed).
const FIXED_SEED = hexToBytes(
  '000102030405060708090a0b0c0d0e0f' +
    '101112131415161718191a1b1c1d1e1f' +
    '202122232425262728292a2b2c2d2e2f' +
    '303132333435363738393a3b3c3d3e3f',
);

function makeKey(index: number) {
  return deriveAddress(FIXED_SEED, EVRMORE_MAINNET, 0, 0, index);
}

/** Fabricate a P2PKH SignableUtxo owned by the derived key at `index`. */
function makeUtxo(index: number, txidHex: string, vout: number, valueSats: bigint): SignableUtxo {
  const key = makeKey(index);
  const scriptPubKey = p2pkhScript(addressToHash160(key.address).hash);
  return {
    txid: txidHex,
    vout,
    valueSats,
    scriptPubKeyHex: bytesToHex(scriptPubKey),
    privateKey: key.privateKey,
    publicKey: key.publicKey,
  };
}

const FAKE_TXID_1 = 'a'.repeat(64);
const FAKE_TXID_2 = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('txBuilder — legacy Evrmore signing', () => {
  it('1. canonical legacy signing self-consistency + independent verify', () => {
    const key = makeKey(0);
    const utxo = makeUtxo(0, FAKE_TXID_1, 0, COIN); // 1.0 EVR
    const destKey = makeKey(1);

    const built = buildAndSignEvrTx({
      inputs: [utxo],
      outputs: [{ address: destKey.address, valueSats: 40_000_000n }], // 0.4 EVR
      changeAddress: key.address,
      feeSats: 100_000n, // 0.001 EVR
    });

    // (a) Structure: version 2, 1 input, 2 outputs, locktime 0.
    const parsed = parseRawTx(built.rawHex);
    expect(parsed.version).toBe(2);
    expect(parsed.inputs.length).toBe(1);
    expect(parsed.outputs.length).toBe(2);
    expect(parsed.locktime).toBe(0);
    expect(parsed.inputs[0].sequence).toBe(0xffffffff);
    expect(parsed.inputs[0].txid).toBe(FAKE_TXID_1);
    expect(parsed.inputs[0].vout).toBe(0);

    // (b) Extract sig + pubkey, recompute sighash INDEPENDENTLY, verify.
    const { derSig, sighashType, pubkey } = parseP2pkhScriptSig(parsed.inputs[0].scriptSig);
    expect(sighashType).toBe(0x01); // SIGHASH_ALL

    // Recompute the legacy sighash from scratch using the parsed outputs and the
    // prevout script (the P2PKH script of the input's owning address).
    const prevoutScript = p2pkhScript(addressToHash160(key.address).hash);
    const rawInputs: RawInput[] = [
      { txid: FAKE_TXID_1, vout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff },
    ];
    const rawOutputs: RawOutput[] = parsed.outputs.map((o) => ({
      valueSats: o.valueSats,
      scriptPubKey: o.scriptPubKey,
    }));
    const sighash = independentLegacySighash(2, rawInputs, rawOutputs, 0, 0, prevoutScript);

    // secp256k1.verify must be TRUE (default lowS=true).
    const { r, s } = parseDer(derSig);
    const compactSig = concatBytes(
      hexToBytes(r.toString(16).padStart(64, '0')),
      hexToBytes(s.toString(16).padStart(64, '0')),
    );
    expect(secp256k1.verify(compactSig, sighash, pubkey)).toBe(true);
    // And with explicit lowS enforcement.
    expect(secp256k1.verify(compactSig, sighash, pubkey, { lowS: true })).toBe(true);

    // S value is low (canonical / non-malleable).
    expect(s <= CURVE_N_HALF).toBe(true);

    // The pubkey in scriptSig belongs to the input's owning address.
    expect(bytesToHex(pubkey)).toBe(bytesToHex(key.publicKey));
    expect(pubkeyToAddress(pubkey, EVRMORE_MAINNET)).toBe(key.address);

    // (c) Deterministic: identical builds -> identical txid + rawHex.
    const built2 = buildAndSignEvrTx({
      inputs: [makeUtxo(0, FAKE_TXID_1, 0, COIN)],
      outputs: [{ address: destKey.address, valueSats: 40_000_000n }],
      changeAddress: key.address,
      feeSats: 100_000n,
    });
    expect(built2.rawHex).toBe(built.rawHex);
    expect(built2.txid).toBe(built.txid);

    // txid() helper matches the BuiltTx txid.
    expect(txid(built.rawHex)).toBe(built.txid);
  });

  it('2. value math: 1.0 in, 0.4 out, 0.001 fee -> 0.599 change', () => {
    const key = makeKey(0);
    const destKey = makeKey(1);
    const utxo = makeUtxo(0, FAKE_TXID_1, 0, COIN); // 1.0 EVR

    const built = buildAndSignEvrTx({
      inputs: [utxo],
      outputs: [{ address: destKey.address, valueSats: 40_000_000n }],
      changeAddress: key.address,
      feeSats: 100_000n,
    });

    const parsed = parseRawTx(built.rawHex);
    expect(parsed.outputs.length).toBe(2);

    // Output 0 = payment (0.4), output 1 = change (0.599).
    expect(parsed.outputs[0].valueSats).toBe(40_000_000n);
    const changeOut = parsed.outputs[1];
    expect(changeOut.valueSats).toBe(59_900_000n); // 0.599 EVR

    // Change goes to the change address.
    const expectedChangeScript = p2pkhScript(addressToHash160(key.address).hash);
    expect(bytesToHex(changeOut.scriptPubKey)).toBe(bytesToHex(expectedChangeScript));

    // sum(outputs) + fee == sum(inputs).
    const outSum = parsed.outputs.reduce((a, o) => a + o.valueSats, 0n);
    expect(outSum + built.feeSats).toBe(COIN);
    expect(built.feeSats).toBe(100_000n);
  });

  it('3. no dust change: change <= 546 sats is dropped into the fee', () => {
    const key = makeKey(0);
    const destKey = makeKey(1);
    // inputs = output + fee + 500 (dust). 500 <= 546 => no change output.
    const inputVal = 40_000_000n + 100_000n + 500n;
    const utxo = makeUtxo(0, FAKE_TXID_1, 0, inputVal);

    const built = buildAndSignEvrTx({
      inputs: [utxo],
      outputs: [{ address: destKey.address, valueSats: 40_000_000n }],
      changeAddress: key.address,
      feeSats: 100_000n,
    });

    const parsed = parseRawTx(built.rawHex);
    // Only the single payment output; no change output emitted.
    expect(parsed.outputs.length).toBe(1);
    expect(parsed.outputs[0].valueSats).toBe(40_000_000n);

    // The dust was absorbed into the fee.
    expect(built.feeSats).toBe(100_000n + 500n);

    // Exactly-at-threshold (546) is also dropped (rule is change > dust to emit).
    const utxoAtThreshold = makeUtxo(0, FAKE_TXID_1, 0, 40_000_000n + 100_000n + 546n);
    const built2 = buildAndSignEvrTx({
      inputs: [utxoAtThreshold],
      outputs: [{ address: destKey.address, valueSats: 40_000_000n }],
      changeAddress: key.address,
      feeSats: 100_000n,
    });
    expect(parseRawTx(built2.rawHex).outputs.length).toBe(1);
    expect(built2.feeSats).toBe(100_000n + 546n);
    expect(DUST_THRESHOLD_SATS).toBe(546n);
  });

  it('4. insufficient funds: selectCoins reports the error', () => {
    const utxos = [makeUtxo(0, FAKE_TXID_1, 0, 10_000n), makeUtxo(1, FAKE_TXID_2, 0, 5_000n)];
    // target 20_000 + fee exceeds available 15_000.
    const result = selectCoins(utxos, 20_000n, 10n);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('insufficient-funds');
    }
  });

  it('5. selectCoins picks enough inputs with a fee consistent with estimateTxBytes', () => {
    const utxos = [
      makeUtxo(0, FAKE_TXID_1, 0, 60_000_000n),
      makeUtxo(1, FAKE_TXID_2, 0, 60_000_000n),
    ];
    const feeRate = 2n;
    const target = 100_000_000n; // needs both inputs

    const result = selectCoins(utxos, target, feeRate);
    expect('error' in result).toBe(false);
    if ('error' in result) throw new Error('unexpected insufficient-funds');

    // Both inputs required to cover the target.
    expect(result.inputs.length).toBe(2);

    // Fee equals feeRate * estimateTxBytes(numInputs, 2 outputs: target + change).
    const expectedFee = feeRate * BigInt(estimateTxBytes(result.inputs.length, 2));
    expect(result.feeSats).toBe(expectedFee);

    // Accounting closes: inputs = target + change + fee.
    const inputSum = result.inputs.reduce((a, u) => a + u.valueSats, 0n);
    expect(inputSum).toBe(target + result.changeSats + result.feeSats);

    // The estimator is the documented legacy formula.
    expect(estimateTxBytes(2, 2)).toBe(10 + 148 * 2 + 34 * 2);

    // A single large input should also satisfy a smaller target with 1 input.
    const single = selectCoins([makeUtxo(0, FAKE_TXID_1, 0, 60_000_000n)], 10_000_000n, feeRate);
    if ('error' in single) throw new Error('unexpected insufficient-funds (single)');
    expect(single.inputs.length).toBe(1);
    expect(single.feeSats).toBe(feeRate * BigInt(estimateTxBytes(1, 2)));
  });

  it('5b. send-max fallback: target = total − 1-output fee succeeds with no change', () => {
    // Two inputs; a Max send targets total − fee(2 inputs, 1 output). The greedy
    // loop (which assumes a change output) cannot cover target + fee(n, 2), so the
    // send-max fallback must kick in: no change, fee = accumulated − target.
    const feeRate = 2n;
    const utxos = [
      makeUtxo(0, FAKE_TXID_1, 0, 60_000_000n),
      makeUtxo(1, FAKE_TXID_2, 0, 40_000_000n),
    ];
    const total = 100_000_000n;
    const feeNoChange = feeRate * BigInt(estimateTxBytes(2, 1)); // spend both into 1 output
    const target = total - feeNoChange;

    const result = selectCoins(utxos, target, feeRate);
    expect('error' in result).toBe(false);
    if ('error' in result) throw new Error('unexpected insufficient-funds');

    // Both inputs consumed; NO change; fee absorbs the whole remainder.
    expect(result.inputs.length).toBe(2);
    expect(result.changeSats).toBe(0n);
    expect(result.feeSats).toBe(total - target);
    expect(result.feeSats).toBe(feeNoChange);

    // Accounting closes: inputs = target + fee (no change).
    const inputSum = result.inputs.reduce((a, u) => a + u.valueSats, 0n);
    expect(inputSum).toBe(target + result.feeSats);

    // Integration: buildAndSignEvrTx emits exactly ONE output (no change).
    const destKey = makeKey(2);
    const built = buildAndSignEvrTx({
      inputs: result.inputs,
      outputs: [{ address: destKey.address, valueSats: target }],
      changeAddress: makeKey(0).address,
      feeSats: result.feeSats,
    });
    const parsed = parseRawTx(built.rawHex);
    expect(parsed.outputs.length).toBe(1);
    expect(parsed.outputs[0].valueSats).toBe(target);
    expect(built.feeSats).toBe(feeNoChange);
  });

  it('5c. send-max boundary: one sat above the max still reports insufficient-funds', () => {
    const feeRate = 2n;
    const utxos = [
      makeUtxo(0, FAKE_TXID_1, 0, 60_000_000n),
      makeUtxo(1, FAKE_TXID_2, 0, 40_000_000n),
    ];
    const total = 100_000_000n;
    const feeNoChange = feeRate * BigInt(estimateTxBytes(2, 1));
    // One sat higher than the true max: total − feeNoChange + 1. Then
    // accumulated (total) < target + feeNoChange, so even the fallback fails.
    const tooHigh = total - feeNoChange + 1n;
    const result = selectCoins(utxos, tooHigh, feeRate);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe('insufficient-funds');
  });

  it('6. asset transfer: SATORI output decodes back, EVR change + all sigs verify', () => {
    const recipientKey = makeKey(1);
    const evrChangeKey = makeKey(0); // sender's own EVR change address

    const satoriAmount = 5_00000000n; // 5.00000000 SATORI (8 decimals)

    // Asset input carries the SATORI; its scriptPubKey is the sender's asset
    // script. The signer only needs a P2PKH prevout script for the legacy sighash,
    // and Evrmore signs the asset UTXO with the P2PKH script of the owning key, so
    // we use the P2PKH script here (the input's owning address).
    const assetUtxo = makeUtxo(0, FAKE_TXID_1, 0, 0n); // 0 EVR value on an asset UTXO
    const evrUtxo = makeUtxo(0, FAKE_TXID_2, 1, COIN); // 1.0 EVR to pay the fee

    const built = buildAndSignAssetTransfer({
      assetInputs: [assetUtxo],
      evrInputs: [evrUtxo],
      assetOut: { address: recipientKey.address, assetName: 'SATORI', amountSats: satoriAmount },
      evrChangeAddress: evrChangeKey.address,
      feeSats: 100_000n,
    });

    const parsed = parseRawTx(built.rawHex);
    // 2 inputs (asset + EVR), 2 outputs (asset transfer + EVR change).
    expect(parsed.inputs.length).toBe(2);
    expect(parsed.outputs.length).toBe(2);

    // Output 0 = asset transfer, value 0, decodes to SATORI + amount + recipient.
    const assetOut = parsed.outputs[0];
    expect(assetOut.valueSats).toBe(0n);
    const decoded = decodeAssetScript(assetOut.scriptPubKey);
    expect(decoded).not.toBeNull();
    expect(decoded!.transfer.kind).toBe('transfer');
    expect(decoded!.transfer.name).toBe('SATORI');
    expect(decoded!.transfer.amount).toBe(satoriAmount);
    // Recipient hash160 matches.
    expect(bytesToHex(decoded!.p2pkhHash160)).toBe(
      bytesToHex(addressToHash160(recipientKey.address).hash),
    );

    // Output 1 = EVR change (1.0 - fee) to the change address.
    const evrChangeOut = parsed.outputs[1];
    expect(evrChangeOut.valueSats).toBe(COIN - 100_000n);
    expect(bytesToHex(evrChangeOut.scriptPubKey)).toBe(
      bytesToHex(p2pkhScript(addressToHash160(evrChangeKey.address).hash)),
    );
    expect(built.feeSats).toBe(100_000n);

    // Both input signatures verify against their independently-recomputed sighash.
    const allUtxos = [assetUtxo, evrUtxo];
    const rawInputs: RawInput[] = allUtxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      scriptSig: new Uint8Array(0),
      sequence: 0xffffffff,
    }));
    const rawOutputs: RawOutput[] = parsed.outputs.map((o) => ({
      valueSats: o.valueSats,
      scriptPubKey: o.scriptPubKey,
    }));

    for (let i = 0; i < parsed.inputs.length; i++) {
      const { derSig, sighashType, pubkey } = parseP2pkhScriptSig(parsed.inputs[i].scriptSig);
      expect(sighashType).toBe(0x01);
      const prevoutScript = hexToBytes(allUtxos[i].scriptPubKeyHex);
      const sighash = independentLegacySighash(2, rawInputs, rawOutputs, 0, i, prevoutScript);
      const { r, s } = parseDer(derSig);
      const compactSig = concatBytes(
        hexToBytes(r.toString(16).padStart(64, '0')),
        hexToBytes(s.toString(16).padStart(64, '0')),
      );
      expect(secp256k1.verify(compactSig, sighash, pubkey, { lowS: true })).toBe(true);
      expect(s <= CURVE_N_HALF).toBe(true);
    }
  });

  it('7. multiple inputs: a 2-input tx signs BOTH inputs with their own prevout script', () => {
    const key0 = makeKey(0);
    const key1 = makeKey(1);
    const destKey = makeKey(2);

    // Two inputs owned by DIFFERENT keys, so each must sign with its own prevout
    // script and its own private key.
    const utxo0 = makeUtxo(0, FAKE_TXID_1, 0, 30_000_000n);
    const utxo1 = makeUtxo(1, FAKE_TXID_2, 3, 30_000_000n);

    const built = buildAndSignEvrTx({
      inputs: [utxo0, utxo1],
      outputs: [{ address: destKey.address, valueSats: 40_000_000n }],
      changeAddress: key0.address,
      feeSats: 100_000n,
    });

    const parsed = parseRawTx(built.rawHex);
    expect(parsed.inputs.length).toBe(2);

    const rawInputs: RawInput[] = [utxo0, utxo1].map((u) => ({
      txid: u.txid,
      vout: u.vout,
      scriptSig: new Uint8Array(0),
      sequence: 0xffffffff,
    }));
    const rawOutputs: RawOutput[] = parsed.outputs.map((o) => ({
      valueSats: o.valueSats,
      scriptPubKey: o.scriptPubKey,
    }));

    const owners = [key0, key1];
    for (let i = 0; i < 2; i++) {
      const { derSig, sighashType, pubkey } = parseP2pkhScriptSig(parsed.inputs[i].scriptSig);
      expect(sighashType).toBe(0x01);

      // Each input's sighash uses ITS OWN prevout script.
      const prevoutScript = p2pkhScript(addressToHash160(owners[i].address).hash);
      const sighash = independentLegacySighash(2, rawInputs, rawOutputs, 0, i, prevoutScript);

      const { r, s } = parseDer(derSig);
      const compactSig = concatBytes(
        hexToBytes(r.toString(16).padStart(64, '0')),
        hexToBytes(s.toString(16).padStart(64, '0')),
      );
      // Must verify against the owning key's pubkey.
      expect(bytesToHex(pubkey)).toBe(bytesToHex(owners[i].publicKey));
      expect(secp256k1.verify(compactSig, sighash, pubkey, { lowS: true })).toBe(true);
      expect(s <= CURVE_N_HALF).toBe(true);

      // Sanity: signing input i's sighash must NOT verify against the OTHER key.
      const otherPub = owners[1 - i].publicKey;
      expect(secp256k1.verify(compactSig, sighash, otherPub, { lowS: true })).toBe(false);
    }
  });

  it('extra: hash160 helper matches keys.ts address derivation', () => {
    const key = makeKey(0);
    const h = hash160(key.publicKey);
    expect(bytesToHex(h)).toBe(bytesToHex(addressToHash160(key.address).hash));
  });
});
