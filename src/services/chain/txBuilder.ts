// Evrmore (EVR) legacy transaction builder + signer.
//
// SAFETY-CRITICAL: this spends real funds. Correctness is paramount. Every
// primitive here is pure-JS and CSP-safe (no Node APIs, no Buffer, no WASM, no
// eval) so it runs inside a Chrome MV3 service worker. Uint8Array is used
// throughout.
//
// PROTOCOL: Evrmore is a Ravencoin fork with NO SegWit. This module produces
// LEGACY-format transactions and uses the LEGACY (pre-BIP143) sighash algorithm.
//   - Transaction version = 2, nLockTime = 0, per-input sequence = 0xffffffff.
//   - SIGHASH_ALL (0x01): to sign input i, serialize the transaction with input
//     i's scriptSig set to the prevout scriptPubKey (the P2PKH script of the
//     owning address) and every OTHER input's scriptSig set to empty (0x00), all
//     outputs present, then append the 4-byte little-endian sighash type
//     (0x01000000), double-SHA256 the result, and sign that digest.
//   - ECDSA via @noble/secp256k1, RFC6979 deterministic k, canonical LOW-S.
//   - scriptSig = <push(DERsig || 0x01)> <push(compressedPubkey)>.
//
// Fees are paid in EVR. An asset-transfer output carries 0 EVR "value" on the
// wire; the asset script output itself is the transfer. The EVR fee comes from
// EVR inputs, with EVR change back to the sender.

import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import { p2pkhScript, addressToHash160 } from './keys';
import {
  buildTransferAssetScriptFromHash160,
  DEFAULT_MARKER_PREFIX,
  type AssetMarkerPrefix,
} from './assetScript';

// @noble/secp256k1 v2's synchronous `sign` needs a synchronous HMAC-SHA256 for
// its RFC6979 deterministic-k generation. The library ships an async HMAC (via
// WebCrypto's SubtleCrypto) but leaves the sync hook unset, so we wire it to
// @noble/hashes' pure-JS HMAC — CSP-safe, no WebCrypto, works in an MV3 service
// worker. Signature: (key, ...msgs) => Uint8Array over the concatenated msgs.
secp256k1.etc.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]): Uint8Array =>
  hmac(sha256, key, concatBytes(...msgs));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A spendable UTXO plus the key material needed to sign it. `scriptPubKeyHex` is
 * the P2PKH scriptPubKey of the address that owns the UTXO (the script that gets
 * substituted into scriptSig when computing this input's legacy sighash).
 */
export interface SignableUtxo {
  txid: string;
  vout: number;
  valueSats: bigint;
  scriptPubKeyHex: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** A plain EVR payment output. */
export interface TxOutput {
  address: string;
  valueSats: bigint;
}

/** An asset-transfer output (0 EVR value on the wire; the script is the transfer). */
export interface AssetTxOutput {
  address: string;
  assetName: string;
  amountSats: bigint;
}

/** A fully built + signed transaction, ready to serialize/broadcast. */
export interface BuiltTx {
  rawHex: string;
  txid: string;
  virtualSize: number;
  feeSats: bigint;
}

/** Outputs below this many sats are considered dust and are not emitted as change. */
export const DUST_THRESHOLD_SATS = 546n;

// SIGHASH_ALL, appended as a 4-byte little-endian uint32 to the preimage.
const SIGHASH_ALL = 0x01;

const TX_VERSION = 2;
const SEQUENCE_FINAL = 0xffffffff;
const LOCKTIME = 0;

// ---------------------------------------------------------------------------
// Byte / serialization helpers (Uint8Array based, no Buffer)
// ---------------------------------------------------------------------------

/** Little-endian 32-bit unsigned integer -> 4 bytes. */
function u32LE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

/** Little-endian 64-bit unsigned integer (bigint) -> 8 bytes. */
function u64LE(n: bigint): Uint8Array {
  if (n < 0n) {
    throw new Error(`u64LE: value must be non-negative, got ${n}`);
  }
  if (n > (1n << 64n) - 1n) {
    throw new Error(`u64LE: value does not fit in uint64: ${n}`);
  }
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Bitcoin/Evrmore CompactSize (varint) encoder. */
function varint(n: number | bigint): Uint8Array {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n) {
    throw new Error(`varint: value must be non-negative, got ${v}`);
  }
  if (v < 0xfdn) {
    return Uint8Array.of(Number(v));
  }
  if (v <= 0xffffn) {
    return Uint8Array.of(0xfd, Number(v & 0xffn), Number((v >> 8n) & 0xffn));
  }
  if (v <= 0xffffffffn) {
    return concatBytes(Uint8Array.of(0xfd + 1), u32LE(Number(v)));
  }
  return concatBytes(Uint8Array.of(0xff), u64LE(v));
}

/**
 * A canonical data push: <len><bytes>. Only supports direct pushes (len < 0x4c)
 * and OP_PUSHDATA1 (0x4c). scriptSig components (DER sig ~71-72 bytes, 33-byte
 * pubkey) and prevout scripts (25-33 bytes) all fit comfortably.
 */
function pushData(data: Uint8Array): Uint8Array {
  const len = data.length;
  if (len < 0x4c) {
    return concatBytes(Uint8Array.of(len), data);
  }
  if (len <= 0xff) {
    return concatBytes(Uint8Array.of(0x4c, len), data);
  }
  throw new Error(`pushData: data too long for supported push encodings: ${len}`);
}

/** Reverse a byte array (returns a new array). */
function reverseBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice().reverse();
}

/** Double-SHA256. */
function hash256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/**
 * Encode an ECDSA signature (r, s) as strict DER:
 *   0x30 <totalLen> 0x02 <rLen> <r> 0x02 <sLen> <s>
 * with each integer minimally encoded and a leading 0x00 prepended when the high
 * bit of the first byte is set (to keep the value positive per DER).
 */
function derEncodeSignature(r: bigint, s: bigint): Uint8Array {
  const encodeInt = (value: bigint): Uint8Array => {
    if (value <= 0n) {
      throw new Error(`derEncodeSignature: integer must be positive, got ${value}`);
    }
    // Big-endian minimal magnitude.
    let hex = value.toString(16);
    if (hex.length % 2 === 1) {
      hex = '0' + hex;
    }
    let bytes = hexToBytes(hex);
    // Strip any leading zero bytes (there should be none from the above, but be safe).
    while (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1] & 0x80) === 0) {
      bytes = bytes.slice(1);
    }
    // Prepend 0x00 if the high bit is set so the integer is interpreted as positive.
    if ((bytes[0] & 0x80) !== 0) {
      bytes = concatBytes(Uint8Array.of(0x00), bytes);
    }
    return bytes;
  };

  const rb = encodeInt(r);
  const sb = encodeInt(s);
  const rSeq = concatBytes(Uint8Array.of(0x02, rb.length), rb);
  const sSeq = concatBytes(Uint8Array.of(0x02, sb.length), sb);
  const body = concatBytes(rSeq, sSeq);
  return concatBytes(Uint8Array.of(0x30, body.length), body);
}

// ---------------------------------------------------------------------------
// Transaction model + serialization
// ---------------------------------------------------------------------------

interface TxInput {
  txid: string; // big-endian display hex (as returned by nodes/explorers)
  vout: number;
  scriptSig: Uint8Array; // empty until signed
  sequence: number;
}

interface TxOut {
  valueSats: bigint;
  scriptPubKey: Uint8Array;
}

interface Tx {
  version: number;
  inputs: TxInput[];
  outputs: TxOut[];
  locktime: number;
}

/** Serialize a single outpoint: reversed(txid) || vout(LE u32). */
function serializeOutpoint(txidHex: string, vout: number): Uint8Array {
  const txidBytes = hexToBytes(txidHex);
  if (txidBytes.length !== 32) {
    throw new Error(`txid must be 32 bytes (64 hex chars), got ${txidBytes.length}`);
  }
  return concatBytes(reverseBytes(txidBytes), u32LE(vout));
}

/** Serialize one input using the supplied scriptSig (may be empty). */
function serializeInput(input: TxInput, scriptSig: Uint8Array): Uint8Array {
  return concatBytes(
    serializeOutpoint(input.txid, input.vout),
    varint(scriptSig.length),
    scriptSig,
    u32LE(input.sequence),
  );
}

/** Serialize one output: value(LE u64) || varint(scriptLen) || script. */
function serializeOutput(out: TxOut): Uint8Array {
  return concatBytes(u64LE(out.valueSats), varint(out.scriptPubKey.length), out.scriptPubKey);
}

/**
 * Serialize the full transaction. When `scriptSigOverrides` is supplied, input i
 * uses `scriptSigOverrides[i]` instead of `input.scriptSig` — used to build the
 * legacy sighash preimage (prevout script in the input being signed, empty
 * elsewhere).
 */
function serializeTx(tx: Tx, scriptSigOverrides?: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(u32LE(tx.version));
  parts.push(varint(tx.inputs.length));
  for (let i = 0; i < tx.inputs.length; i++) {
    const scriptSig = scriptSigOverrides ? scriptSigOverrides[i] : tx.inputs[i].scriptSig;
    parts.push(serializeInput(tx.inputs[i], scriptSig));
  }
  parts.push(varint(tx.outputs.length));
  for (const out of tx.outputs) {
    parts.push(serializeOutput(out));
  }
  parts.push(u32LE(tx.locktime));
  return concatBytes(...parts);
}

/**
 * Compute the legacy SIGHASH_ALL digest for input `index`:
 *   preimage = serializeTx(tx, overrides) || LE_u32(SIGHASH_ALL)
 *   digest   = hash256(preimage)
 * where override[index] = prevout scriptPubKey and every other override = empty.
 */
function legacySighash(tx: Tx, index: number, prevoutScript: Uint8Array): Uint8Array {
  const overrides: Uint8Array[] = tx.inputs.map((_, i) =>
    i === index ? prevoutScript : new Uint8Array(0),
  );
  const preimage = concatBytes(serializeTx(tx, overrides), u32LE(SIGHASH_ALL));
  return hash256(preimage);
}

// ---------------------------------------------------------------------------
// txid
// ---------------------------------------------------------------------------

/**
 * txid of a raw (legacy) transaction: double-sha256 of the raw bytes, byte order
 * reversed, lowercase hex — the standard display txid.
 */
export function txid(rawHex: string): string {
  const digest = hash256(hexToBytes(rawHex));
  return bytesToHex(reverseBytes(digest));
}

// ---------------------------------------------------------------------------
// Size estimation + coin selection
// ---------------------------------------------------------------------------

/**
 * Estimate the serialized byte size of a legacy transaction with the given input
 * and output counts. Legacy P2PKH inputs are ~148 bytes each (outpoint 36 +
 * scriptSig ~107 incl. push bytes + sequence 4 + length byte), outputs ~34 bytes
 * each (value 8 + varint 1 + P2PKH script 25), plus ~10 bytes of overhead
 * (version 4 + locktime 4 + input/output count varints).
 */
export function estimateTxBytes(numInputs: number, numOutputs: number): number {
  return 10 + 148 * numInputs + 34 * numOutputs;
}

/**
 * Greedily accumulate inputs until they cover `targetSats` plus the fee. The fee
 * is derived from `feeRateSatPerByte` and the estimated size, and is recomputed
 * as inputs are added. The estimate assumes a change output is present (the
 * common case); if the actual change turns out to be dust the caller drops it.
 *
 * Returns the selected inputs, the computed fee, and the resulting change, or an
 * `insufficient-funds` error if the available inputs can't cover target + fee.
 */
export function selectCoins(
  utxos: SignableUtxo[],
  targetSats: bigint,
  feeRateSatPerByte: bigint,
):
  | { inputs: SignableUtxo[]; feeSats: bigint; changeSats: bigint }
  | { error: 'insufficient-funds' } {
  // Largest-first greedy: fewer inputs -> smaller tx -> lower fee.
  const sorted = [...utxos].sort((a, b) => (a.valueSats < b.valueSats ? 1 : a.valueSats > b.valueSats ? -1 : 0));

  const selected: SignableUtxo[] = [];
  let accumulated = 0n;

  for (const utxo of sorted) {
    selected.push(utxo);
    accumulated += utxo.valueSats;

    // Assume one target output + one change output while accumulating.
    const numOutputs = 2;
    const feeSats = feeRateSatPerByte * BigInt(estimateTxBytes(selected.length, numOutputs));

    if (accumulated >= targetSats + feeSats) {
      const changeSats = accumulated - targetSats - feeSats;
      return { inputs: selected, feeSats, changeSats };
    }
  }

  // Send-max fallback. The greedy loop above assumes a change output (numOutputs
  // = 2) while accumulating, so a "Max" send — target = total − fee(n, 1 output)
  // — never covers target + fee(n, 2 outputs) and would wrongly report
  // insufficient-funds. If every input is now selected and the total covers the
  // target plus the fee WITHOUT a change output (fee(n, 1)), build with no change
  // and absorb the entire remainder into the fee. The absorbed remainder is
  // bounded by fee₂ − fee₁ (≈ one 34-byte output × the fee rate), so it cannot
  // silently overpay by much, and assertFeeSane() in liveWallet still enforces
  // the 1-EVR absolute-fee ceiling downstream. buildAndSignEvrTx computes
  // change = sum − outputs − fee and only emits change above the dust threshold,
  // so feeSats = accumulated − target yields change = 0 → no change output.
  const feeNoChange = feeRateSatPerByte * BigInt(estimateTxBytes(selected.length, 1));
  if (selected.length > 0 && accumulated >= targetSats + feeNoChange) {
    return { inputs: selected, feeSats: accumulated - targetSats, changeSats: 0n };
  }

  return { error: 'insufficient-funds' };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Produce the scriptSig for a signed P2PKH input:
 *   <push(DERsig || SIGHASH_ALL)> <push(compressedPubkey)>
 * The signature is RFC6979-deterministic with canonical low-S (malleability-safe).
 */
function signInput(sighash: Uint8Array, privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(sighash, privateKey, { lowS: true });
  const der = derEncodeSignature(sig.r, sig.s);
  const sigWithType = concatBytes(der, Uint8Array.of(SIGHASH_ALL));
  return concatBytes(pushData(sigWithType), pushData(publicKey));
}

/** Build the (unsigned) TxInput list from SignableUtxos. */
function toInputs(utxos: SignableUtxo[]): TxInput[] {
  return utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    scriptSig: new Uint8Array(0),
    sequence: SEQUENCE_FINAL,
  }));
}

/**
 * Sign every input of `tx` in place using each UTXO's own prevout scriptPubKey as
 * that input's legacy sighash script.
 */
function signAllInputs(tx: Tx, utxos: SignableUtxo[]): void {
  for (let i = 0; i < tx.inputs.length; i++) {
    const utxo = utxos[i];
    const prevoutScript = hexToBytes(utxo.scriptPubKeyHex);
    const sighash = legacySighash(tx, i, prevoutScript);
    tx.inputs[i].scriptSig = signInput(sighash, utxo.privateKey, utxo.publicKey);
  }
}

/** Finalize a signed Tx into the BuiltTx result. */
function finalize(tx: Tx, _allInputs: SignableUtxo[], feeSats: bigint): BuiltTx {
  const rawBytes = serializeTx(tx);
  const rawHex = bytesToHex(rawBytes);
  return {
    rawHex,
    txid: txid(rawHex),
    virtualSize: rawBytes.length,
    feeSats,
  };
}

// ---------------------------------------------------------------------------
// Build + sign: plain EVR transfer
// ---------------------------------------------------------------------------

/**
 * Build and sign a plain EVR transaction.
 *   change = sum(inputs) - sum(outputs) - fee
 * A change output (to `changeAddress`) is appended only when change exceeds the
 * dust threshold; a dust-sized change is left in the transaction as extra fee.
 * Throws if the inputs can't cover outputs + fee (negative change).
 */
export function buildAndSignEvrTx(params: {
  inputs: SignableUtxo[];
  outputs: TxOutput[];
  changeAddress: string;
  feeSats: bigint;
}): BuiltTx {
  const { inputs, outputs, changeAddress, feeSats } = params;
  if (inputs.length === 0) {
    throw new Error('buildAndSignEvrTx: no inputs');
  }

  const inputSum = inputs.reduce((acc, u) => acc + u.valueSats, 0n);
  const outputSum = outputs.reduce((acc, o) => acc + o.valueSats, 0n);
  const change = inputSum - outputSum - feeSats;
  if (change < 0n) {
    throw new Error(
      `buildAndSignEvrTx: insufficient funds: inputs ${inputSum} < outputs ${outputSum} + fee ${feeSats}`,
    );
  }

  const txOuts: TxOut[] = outputs.map((o) => ({
    valueSats: o.valueSats,
    scriptPubKey: p2pkhScript(addressToHash160(o.address).hash),
  }));

  // Emit change only if it clears dust; otherwise it is absorbed into the fee.
  if (change > DUST_THRESHOLD_SATS) {
    txOuts.push({
      valueSats: change,
      scriptPubKey: p2pkhScript(addressToHash160(changeAddress).hash),
    });
  }

  const tx: Tx = {
    version: TX_VERSION,
    inputs: toInputs(inputs),
    outputs: txOuts,
    locktime: LOCKTIME,
  };

  signAllInputs(tx, inputs);

  // Effective fee = everything not paid out to explicit outputs.
  const emittedOutputSum = txOuts.reduce((acc, o) => acc + o.valueSats, 0n);
  const effectiveFee = inputSum - emittedOutputSum;
  return finalize(tx, inputs, effectiveFee);
}

// ---------------------------------------------------------------------------
// Build + sign: asset transfer (e.g. SATORI)
// ---------------------------------------------------------------------------

/**
 * Build and sign an asset transfer. Asset inputs supply the asset being sent;
 * EVR inputs supply the fee. The asset output is an OP_EVR_ASSET script output
 * (0 EVR value) to the recipient; an optional asset-change output returns the
 * remaining asset to the sender. EVR change (sum(evrInputs) - fee) goes to
 * `evrChangeAddress` when above dust.
 *
 * NOTE: no separate dust EVR output is added for the recipient — the asset
 * script output IS the transfer.
 */
export function buildAndSignAssetTransfer(params: {
  assetInputs: SignableUtxo[];
  evrInputs: SignableUtxo[];
  assetOut: AssetTxOutput;
  assetChange?: AssetTxOutput;
  evrChangeAddress: string;
  feeSats: bigint;
  /** Active chain's asset-marker family ('evr'|'rvn'). Defaults to 'evr' so
   *  pre-existing Evrmore callers/tests build byte-identical scripts. */
  assetMarkerPrefix?: AssetMarkerPrefix;
}): BuiltTx {
  const { assetInputs, evrInputs, assetOut, assetChange, evrChangeAddress, feeSats } = params;
  const markerPrefix = params.assetMarkerPrefix ?? DEFAULT_MARKER_PREFIX;
  if (assetInputs.length === 0) {
    throw new Error('buildAndSignAssetTransfer: no asset inputs');
  }
  if (evrInputs.length === 0) {
    throw new Error('buildAndSignAssetTransfer: no EVR inputs to pay the fee');
  }

  const evrInputSum = evrInputs.reduce((acc, u) => acc + u.valueSats, 0n);
  const evrChange = evrInputSum - feeSats;
  if (evrChange < 0n) {
    throw new Error(
      `buildAndSignAssetTransfer: EVR inputs ${evrInputSum} cannot cover fee ${feeSats}`,
    );
  }

  const txOuts: TxOut[] = [];

  // Asset transfer output (value 0; the script carries the transfer).
  const assetRecipientHash = addressToHash160(assetOut.address).hash;
  txOuts.push({
    valueSats: 0n,
    scriptPubKey: buildTransferAssetScriptFromHash160(
      assetRecipientHash,
      assetOut.assetName,
      assetOut.amountSats,
      markerPrefix,
    ),
  });

  // Optional asset change back to the sender (value 0; asset script output).
  if (assetChange) {
    const assetChangeHash = addressToHash160(assetChange.address).hash;
    txOuts.push({
      valueSats: 0n,
      scriptPubKey: buildTransferAssetScriptFromHash160(
        assetChangeHash,
        assetChange.assetName,
        assetChange.amountSats,
        markerPrefix,
      ),
    });
  }

  // EVR change (plain P2PKH), only if above dust.
  if (evrChange > DUST_THRESHOLD_SATS) {
    txOuts.push({
      valueSats: evrChange,
      scriptPubKey: p2pkhScript(addressToHash160(evrChangeAddress).hash),
    });
  }

  // Order: asset inputs first, then EVR inputs. Each input signs with its own
  // prevout script, so ordering only needs to stay consistent with the UTXO list.
  const allInputs = [...assetInputs, ...evrInputs];
  const tx: Tx = {
    version: TX_VERSION,
    inputs: toInputs(allInputs),
    outputs: txOuts,
    locktime: LOCKTIME,
  };

  signAllInputs(tx, allInputs);

  // Effective EVR fee = EVR inputs minus emitted EVR (P2PKH) change. ONLY EVR
  // inputs count here — asset inputs carry the ASSET amount in `valueSats`, not
  // EVR, and asset outputs carry 0 EVR on the wire — so including asset inputs
  // would massively over-report the fee (e.g. show the whole asset amount as fee).
  const emittedEvr = txOuts.reduce((acc, o) => acc + o.valueSats, 0n);
  const totalEvrIn = evrInputs.reduce((acc, u) => acc + u.valueSats, 0n);
  const effectiveFee = totalEvrIn - emittedEvr;
  return finalize(tx, allInputs, effectiveFee);
}
