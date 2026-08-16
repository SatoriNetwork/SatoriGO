// UTXO transaction builder + signer: LEGACY (pre-BIP143) P2PKH signing plus
// NATIVE-SEGWIT (BIP141/BIP143/BIP144) P2WPKH signing.
//
// SAFETY-CRITICAL: this spends real funds. Correctness is paramount. Every
// primitive here is pure-JS and CSP-safe (no Node APIs, no Buffer, no WASM, no
// eval) so it runs inside a Chrome MV3 service worker. Uint8Array is used
// throughout.
//
// PROTOCOL (legacy): Evrmore is a Ravencoin fork with NO SegWit. On those chains
// this module produces LEGACY-format transactions and uses the LEGACY
// (pre-BIP143) sighash algorithm. That path is untouched by the segwit support
// below and stays byte-for-byte identical.
//   - Transaction version = 2, nLockTime = 0, per-input sequence = 0xffffffff.
//   - SIGHASH_ALL (0x01): to sign input i, serialize the transaction with input
//     i's scriptSig set to the prevout scriptPubKey (the P2PKH script of the
//     owning address) and every OTHER input's scriptSig set to empty (0x00), all
//     outputs present, then append the 4-byte little-endian sighash type
//     (0x01000000), double-SHA256 the result, and sign that digest.
//   - ECDSA via @noble/secp256k1, RFC6979 deterministic k, canonical LOW-S.
//   - scriptSig = <push(DERsig || 0x01)> <push(compressedPubkey)>.
//
// PROTOCOL (segwit): a UTXO whose prevout scriptPubKey is P2WPKH
// (OP_0 <20-byte hash160>) MUST instead be signed with BIP143:
//   - preimage = nVersion | hashPrevouts | hashSequence | outpoint | scriptCode |
//     amount | nSequence | hashOutputs | nLockTime | sighashType, double-SHA256'd.
//   - The scriptCode for a P2WPKH input is the P2PKH script of that input's OWN
//     pubkey hash (BIP143: "the scriptCode is 0x1976a914{20-byte-pubkey-hash}88ac"),
//     NOT the P2WPKH script. This is the classic footgun: the wrong scriptCode
//     produces a signature every node rejects.
//   - BIP143 COMMITS TO THE INPUT'S VALUE, which the legacy algorithm does not.
//   - scriptSig stays EMPTY; the DER signature (+ sighash byte) and the
//     compressed pubkey move into a 2-item witness stack, and the transaction is
//     serialized with the BIP144 marker/flag (0x00 0x01) after nVersion.
//   - The TXID is computed over the STRIPPED (no-witness) serialization; the
//     wtxid over the full one. Fees are priced in VIRTUAL SIZE (BIP141), not in
//     raw bytes: vsize = ceil((base*3 + total)/4).
//
// ROUTING IS BY CAPABILITY, NEVER BY CHAIN NAME: the legacy-vs-BIP143 decision is
// made per input from the PREVOUT SCRIPT SHAPE alone (see spendKindOf), so a
// future bech32 chain works here with no edits — it only needs bech32Hrp set in
// chainParams. No ticker or hrp is hardcoded in this module.
//
// Fees are paid in the chain's native coin. An asset-transfer output carries 0
// native "value" on the wire; the asset script output itself is the transfer. The
// fee comes from native inputs, with native change back to the sender.

import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import { p2pkhScript, addressToHash160, addressToScript, hash160 } from './keys';
import { supportsSegwit, type ChainNetwork } from './chainParams';
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
 * the prevout scriptPubKey of the address that owns the UTXO, and its SHAPE
 * selects the signing algorithm (see spendKindOf):
 *   - P2WPKH (0014<h160>) -> BIP143 sighash; scriptSig stays empty and the
 *     signature moves into the witness;
 *   - anything else       -> the legacy path, where the script is substituted
 *     wholesale into this input's scriptSig to build the sighash preimage.
 *
 * `valueSats` is load-bearing for a segwit input: BIP143 commits to the amount,
 * so a wrong value yields a signature the network rejects (and, when the value
 * comes from an untrusted server, it is what makes an inflated fee impossible).
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
  /** FULL wire serialization — this is what gets broadcast. It carries the
   *  witness (marker/flag + witness stacks) when any input is segwit, and is
   *  identical to the stripped form when none is. */
  rawHex: string;
  /** Display txid, always computed over the STRIPPED (no-witness) serialization,
   *  so it is stable regardless of the witness (BIP141 malleability fix). */
  txid: string;
  /** Witness txid: the same hash over the FULL serialization. Equal to `txid`
   *  for a transaction with no witness data (BIP141). Declared optional so any
   *  pre-existing BuiltTx literal elsewhere still type-checks; every transaction
   *  this module builds populates it. */
  wtxid?: string;
  /** BIP141 virtual size, ceil((base*3 + total)/4). For a legacy transaction
   *  base === total, so this is exactly the raw byte length as before. */
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

// BIP144 witness marker + flag, emitted after nVersion ONLY when the transaction
// actually carries witness data. Emitting them on a witness-free transaction
// would make every parser read an input count of 0 and reject it.
const SEGWIT_MARKER = 0x00;
const SEGWIT_FLAG = 0x01;

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

/** One input, with the two mutually exclusive places a signature can live. */
export interface TxInput {
  txid: string; // big-endian display hex (as returned by nodes/explorers)
  vout: number;
  scriptSig: Uint8Array; // empty until signed; stays EMPTY for a segwit input
  sequence: number;
  /** Witness stack. Empty for a legacy input (serialized as a 0x00 count);
   *  [DERsig||sighashByte, compressedPubkey] for a signed P2WPKH input. */
  witness: Uint8Array[];
}

export interface TxOut {
  valueSats: bigint;
  scriptPubKey: Uint8Array;
}

export interface Tx {
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
 * Serialize the STRIPPED (legacy / no-witness) transaction. When
 * `scriptSigOverrides` is supplied, input i uses `scriptSigOverrides[i]` instead
 * of `input.scriptSig` — used to build the legacy sighash preimage (prevout
 * script in the input being signed, empty elsewhere).
 *
 * This is also the "base" serialization of a segwit transaction: the TXID and the
 * base size are both taken from it, exactly as BIP141 specifies.
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

/** Serialize one witness stack: varint(itemCount) || (varint(len) || item)*. */
function serializeWitness(stack: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [varint(stack.length)];
  for (const item of stack) {
    parts.push(varint(item.length), item);
  }
  return concatBytes(...parts);
}

/**
 * BIP144 serialization:
 *   nVersion | 0x00 0x01 | vin | vout | witness-per-input | nLockTime
 * EVERY input contributes a witness stack (a legacy input in a mixed transaction
 * contributes an empty one, i.e. a bare 0x00 count) — the stacks are positional,
 * so omitting one would misalign all the others.
 *
 * Callers must only use this when at least one input actually carries witness
 * data; see serializeSignedTx, which makes that decision.
 */
function serializeWitnessTx(tx: Tx): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(u32LE(tx.version));
  parts.push(Uint8Array.of(SEGWIT_MARKER, SEGWIT_FLAG));
  parts.push(varint(tx.inputs.length));
  for (const input of tx.inputs) {
    parts.push(serializeInput(input, input.scriptSig));
  }
  parts.push(varint(tx.outputs.length));
  for (const out of tx.outputs) {
    parts.push(serializeOutput(out));
  }
  for (const input of tx.inputs) {
    parts.push(serializeWitness(input.witness));
  }
  parts.push(u32LE(tx.locktime));
  return concatBytes(...parts);
}

/**
 * Compute the legacy SIGHASH_ALL digest for input `index`:
 *   preimage = serializeTx(tx, overrides) || LE_u32(SIGHASH_ALL)
 *   digest   = hash256(preimage)
 * where override[index] = prevout scriptPubKey and every other override = empty.
 *
 * Note this reads NONE of the inputs' current scriptSigs or witnesses (every one
 * is overridden), so a legacy input signs identically whether or not the same
 * transaction also contains segwit inputs.
 */
function legacySighash(tx: Tx, index: number, prevoutScript: Uint8Array): Uint8Array {
  const overrides: Uint8Array[] = tx.inputs.map((_, i) =>
    i === index ? prevoutScript : new Uint8Array(0),
  );
  const preimage = concatBytes(serializeTx(tx, overrides), u32LE(SIGHASH_ALL));
  return hash256(preimage);
}

// ---------------------------------------------------------------------------
// Prevout script shape -> spending algorithm (capability routing)
// ---------------------------------------------------------------------------

/** The algorithm an input must be spent with, derived from its prevout script. */
export type InputSpendKind = 'p2pkh' | 'p2wpkh';

/**
 * True for a native-segwit v0 P2WPKH scriptPubKey: OP_0 <push 20> <hash160>,
 * i.e. exactly 22 bytes of 0x00 0x14 || h160.
 *
 * Deliberately strict. P2WSH (0x0020 || 32 bytes) and witness v1 / taproot
 * (0x5120 || 32 bytes) are NOT matched: this builder cannot spend them, and it
 * must fail loudly rather than sign them with a P2WPKH witness.
 */
export function isP2wpkhScript(script: Uint8Array): boolean {
  return script.length === 22 && script[0] === 0x00 && script[1] === 0x14;
}

/**
 * Classify a prevout script by the algorithm needed to spend it.
 *
 * This is the ONLY place the segwit-vs-legacy decision is made, and it is made
 * from the script bytes alone — never from a chain name, ticker or hrp — so a
 * future bech32 chain drops in with no change here.
 *
 * Everything that is not P2WPKH falls back to the legacy path ON PURPOSE: on the
 * asset chains a UTXO's prevout script is a P2PKH script with an OP_x_ASSET
 * trailer, which the legacy sighash substitutes wholesale, so "not plain P2PKH"
 * must not be treated as "unknown/unspendable".
 */
export function spendKindOf(scriptPubKeyHex: string): InputSpendKind {
  return isP2wpkhScript(hexToBytes(scriptPubKeyHex)) ? 'p2wpkh' : 'p2pkh';
}

// ---------------------------------------------------------------------------
// BIP143 (segwit v0) sighash
// ---------------------------------------------------------------------------

/** The parts of a transaction a BIP143 preimage commits to. `Tx` satisfies it. */
export interface SighashTx {
  version: number;
  inputs: { txid: string; vout: number; sequence: number }[];
  outputs: { valueSats: bigint; scriptPubKey: Uint8Array }[];
  locktime: number;
}

/**
 * The three per-transaction midstate hashes of BIP143 under SIGHASH_ALL. They are
 * the same for every input, so they are computed once and reused (also what keeps
 * signing O(n) instead of O(n²) in the number of inputs).
 */
interface Bip143Midstate {
  /** dSHA256 of all input outpoints, concatenated. */
  hashPrevouts: Uint8Array;
  /** dSHA256 of all nSequence values, concatenated. */
  hashSequence: Uint8Array;
  /** dSHA256 of all serialized outputs, concatenated. */
  hashOutputs: Uint8Array;
}

function bip143Midstate(tx: SighashTx): Bip143Midstate {
  return {
    hashPrevouts: hash256(concatBytes(...tx.inputs.map((i) => serializeOutpoint(i.txid, i.vout)))),
    hashSequence: hash256(concatBytes(...tx.inputs.map((i) => u32LE(i.sequence)))),
    hashOutputs: hash256(concatBytes(...tx.outputs.map((o) => serializeOutput(o)))),
  };
}

/**
 * The BIP143 scriptCode of a P2WPKH input: the P2PKH script of the SAME pubkey
 * hash the witness program contains, i.e. 0x76a914{h160}88ac, which the preimage
 * carries with its 0x19 (25) length prefix.
 *
 * Named and exported because this is THE P2WPKH footgun: the intuitive choice —
 * the P2WPKH scriptPubKey itself — is wrong, and BIP143 states the rule
 * explicitly ("For P2WPKH witness program, the scriptCode is
 * 0x1976a914{20-byte-pubkey-hash}88ac").
 */
export function p2wpkhScriptCode(pubkeyHash160: Uint8Array): Uint8Array {
  return p2pkhScript(pubkeyHash160);
}

function bip143PreimageWith(
  tx: SighashTx,
  index: number,
  scriptCode: Uint8Array,
  valueSats: bigint,
  mid: Bip143Midstate,
): Uint8Array {
  const input = tx.inputs[index];
  if (!input) {
    throw new Error(`bip143: no input at index ${index}`);
  }
  return concatBytes(
    u32LE(tx.version), // nVersion
    mid.hashPrevouts, // hashPrevouts
    mid.hashSequence, // hashSequence
    serializeOutpoint(input.txid, input.vout), // outpoint of THIS input
    varint(scriptCode.length), // scriptCode, length-prefixed (0x19 for P2WPKH)
    scriptCode,
    u64LE(valueSats), // amount of THIS input, 8-byte LE
    u32LE(input.sequence), // nSequence of THIS input
    mid.hashOutputs, // hashOutputs
    u32LE(tx.locktime), // nLockTime
    u32LE(SIGHASH_ALL), // sighash type, 4-byte LE
  );
}

/**
 * The exact BIP143 SIGHASH_ALL preimage for segwit v0 input `index`. Exported so
 * it can be checked byte-for-byte against the BIP143 reference vector (the spec
 * publishes the preimage, not just the digest) and so a signing bug is
 * diagnosable without re-deriving the algorithm.
 *
 * `scriptCode` is passed RAW (no length prefix); the varint is added here. For a
 * P2WPKH input it MUST be p2wpkhScriptCode(pubkeyHash), not the P2WPKH script.
 */
export function bip143Preimage(
  tx: SighashTx,
  index: number,
  scriptCode: Uint8Array,
  valueSats: bigint,
): Uint8Array {
  return bip143PreimageWith(tx, index, scriptCode, valueSats, bip143Midstate(tx));
}

/**
 * BIP143 SIGHASH_ALL digest = dSHA256(preimage) for segwit v0 input `index`.
 *
 * Unlike the legacy algorithm this commits to the input's VALUE, so the amount
 * handed in must be the true prevout amount.
 */
export function bip143Sighash(
  tx: SighashTx,
  index: number,
  scriptCode: Uint8Array,
  valueSats: bigint,
): Uint8Array {
  return hash256(bip143Preimage(tx, index, scriptCode, valueSats));
}

// ---------------------------------------------------------------------------
// txid
// ---------------------------------------------------------------------------

/**
 * txid of a raw transaction: double-sha256 of the raw bytes, byte order
 * reversed, lowercase hex — the standard display txid.
 *
 * CAUTION on segwit: this hashes exactly the bytes it is given. Feed it a
 * STRIPPED serialization to get the txid and a witness serialization to get the
 * WTXID. BuiltTx already exposes both (`txid`, `wtxid`) computed correctly, so
 * prefer those over re-hashing `rawHex`, which is the witness form.
 */
export function txid(rawHex: string): string {
  const digest = hash256(hexToBytes(rawHex));
  return bytesToHex(reverseBytes(digest));
}

/**
 * BIP141 virtual size from the base (stripped) and total (witness) serialized
 * sizes: vsize = ceil((base * 3 + total) / 4) = ceil(weight / 4).
 *
 * A witness-free transaction has base === total, so this returns exactly the raw
 * byte length — the legacy value, unchanged.
 */
export function virtualSizeOf(baseSize: number, totalSize: number): number {
  return Math.ceil((baseSize * 3 + totalSize) / 4);
}

/** The wire forms + identifiers of a signed transaction. */
export interface SerializedTx {
  /** Full serialization (with witness when present). This is what is broadcast. */
  rawHex: string;
  /** Stripped (no-witness) serialization; the txid preimage. */
  strippedHex: string;
  txid: string;
  wtxid: string;
  virtualSize: number;
}

/**
 * Serialize a transaction whose inputs are ALREADY signed (each input carrying
 * its final scriptSig and/or witness) and derive its identifiers.
 *
 * The witness form is emitted only when some input actually has witness data;
 * otherwise the legacy bytes are produced, which is what keeps a no-segwit chain
 * byte-identical to the pre-BIP143 builder.
 *
 * Exported because the high-level builders below only produce P2PKH/P2WPKH input
 * shapes, while callers (and the BIP143 reference vector, whose first input is a
 * bare P2PK) may need to serialize others.
 */
export function serializeSignedTx(tx: Tx): SerializedTx {
  const hasWitness = tx.inputs.some((i) => i.witness.length > 0);
  const strippedBytes = serializeTx(tx);
  const rawBytes = hasWitness ? serializeWitnessTx(tx) : strippedBytes;
  const strippedHex = bytesToHex(strippedBytes);
  const rawHex = bytesToHex(rawBytes);
  return {
    rawHex,
    strippedHex,
    // BIP141: the txid always hashes the STRIPPED form, so a third party cannot
    // change it by mauling the witness. The wtxid hashes the full form; the two
    // coincide exactly when there is no witness.
    txid: txid(strippedHex),
    wtxid: txid(rawHex),
    virtualSize: virtualSizeOf(strippedBytes.length, rawBytes.length),
  };
}

// ---------------------------------------------------------------------------
// Size estimation + coin selection
// ---------------------------------------------------------------------------

// Fee sizing is done in WEIGHT UNITS (BIP141): every non-witness byte weighs 4
// WU, every witness byte 1 WU, and vsize = ceil(weight / 4). On a chain without
// segwit nothing is witness data, so weight/4 collapses back to the plain byte
// count and the historical numbers below are reproduced exactly.
//
//   P2PKH input : 148 non-witness bytes (outpoint 36 + script-len varint 1 +
//                 scriptSig ~107 + sequence 4) -> 592 WU = 148 vbytes.
//   P2WPKH input: 41 non-witness bytes (outpoint 36 + empty-script varint 1 +
//                 sequence 4) = 164 WU, plus a 108-byte witness (stack count 1 +
//                 1+72 signature + 1+33 pubkey) = 108 WU -> 272 WU = 68 vbytes.
const INPUT_WEIGHT: Record<InputSpendKind, number> = { p2pkh: 592, p2wpkh: 272 };

// version 4 + locktime 4 + the two count varints 2 = 10 non-witness bytes.
const TX_OVERHEAD_WEIGHT = 10 * 4;

// The BIP144 marker + flag exist only in the witness serialization, so the two
// bytes weigh 2 WU, not 8.
const SEGWIT_OVERHEAD_WEIGHT = 2;

// value 8 + script-len varint 1 + P2PKH script 25 = 34 bytes. A P2WPKH output is
// smaller (31), so charging 34 for every output keeps the legacy estimate
// byte-identical AND errs towards over-paying the fee, never under-paying it
// (an under-estimate risks a transaction no node will relay).
const OUTPUT_WEIGHT = 34 * 4;

/**
 * Estimate a transaction's VIRTUAL SIZE from the spend kind of each input and the
 * output count. Segwit inputs are charged their real ~68 vbytes rather than the
 * ~148 of a legacy input, so a segwit spend is not silently over-priced.
 */
export function estimateTxVBytes(
  inputKinds: readonly InputSpendKind[],
  numOutputs: number,
): number {
  let weight = TX_OVERHEAD_WEIGHT + OUTPUT_WEIGHT * numOutputs;
  let anySegwit = false;
  for (const kind of inputKinds) {
    weight += INPUT_WEIGHT[kind];
    if (kind === 'p2wpkh') anySegwit = true;
  }
  if (anySegwit) weight += SEGWIT_OVERHEAD_WEIGHT;
  return Math.ceil(weight / 4);
}

/**
 * Estimate the virtual size of a spend of these exact UTXOs, classifying each one
 * by its prevout script. This is what fee logic should use whenever the real
 * inputs are known — it is the only variant that can see segwit inputs.
 */
export function estimateSpendVBytes(
  utxos: readonly SignableUtxo[],
  numOutputs: number,
): number {
  return estimateTxVBytes(
    utxos.map((u) => spendKindOf(u.scriptPubKeyHex)),
    numOutputs,
  );
}

/**
 * Estimate the size of an ALL-LEGACY transaction with the given input and output
 * counts: 10 bytes of overhead + 148 per P2PKH input + 34 per output.
 *
 * Kept for callers that only know the counts. It cannot account for segwit (a
 * count carries no script), so it OVER-estimates a segwit spend — which costs a
 * little fee but never produces an unrelayable transaction. Prefer
 * estimateSpendVBytes when the UTXOs themselves are available.
 */
export function estimateTxBytes(numInputs: number, numOutputs: number): number {
  return estimateTxVBytes(new Array<InputSpendKind>(numInputs).fill('p2pkh'), numOutputs);
}

/**
 * Greedily accumulate inputs until they cover `targetSats` plus the fee. The fee
 * is derived from `feeRateSatPerByte` and the estimated size, and is recomputed
 * as inputs are added. The estimate assumes a change output is present (the
 * common case); if the actual change turns out to be dust the caller drops it.
 *
 * The size is the VIRTUAL size of the actually-selected UTXOs, so the rate is
 * sat/vbyte (identical to sat/byte on a chain with no segwit, where every input
 * is legacy and vsize === size).
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
    const feeSats = feeRateSatPerByte * BigInt(estimateSpendVBytes(selected, numOutputs));

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
  const feeNoChange = feeRateSatPerByte * BigInt(estimateSpendVBytes(selected, 1));
  if (selected.length > 0 && accumulated >= targetSats + feeNoChange) {
    return { inputs: selected, feeSats: accumulated - targetSats, changeSats: 0n };
  }

  return { error: 'insufficient-funds' };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Sign a digest and return DER || SIGHASH_ALL, the exact byte string that goes
 * into a scriptSig push or a witness item. RFC6979-deterministic k with canonical
 * low-S (malleability-safe).
 */
function signDigest(sighash: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(sighash, privateKey, { lowS: true });
  const der = derEncodeSignature(sig.r, sig.s);
  return concatBytes(der, Uint8Array.of(SIGHASH_ALL));
}

/**
 * Produce the scriptSig for a signed P2PKH input:
 *   <push(DERsig || SIGHASH_ALL)> <push(compressedPubkey)>
 */
function signInput(sighash: Uint8Array, privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return concatBytes(pushData(signDigest(sighash, privateKey)), pushData(publicKey));
}

/**
 * Sign one P2WPKH input and return its 2-item witness stack:
 *   [DERsig || SIGHASH_ALL, compressed pubkey]
 * The scriptCode is derived from the key itself (hash160(publicKey)), which is by
 * construction the witness program of a P2WPKH output that key can spend.
 */
function p2wpkhWitness(
  tx: SighashTx,
  index: number,
  valueSats: bigint,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  mid: Bip143Midstate,
): Uint8Array[] {
  const scriptCode = p2wpkhScriptCode(hash160(publicKey));
  const sighash = hash256(bip143PreimageWith(tx, index, scriptCode, valueSats, mid));
  return [signDigest(sighash, privateKey), publicKey];
}

/**
 * Public single-input BIP143 signer: produce the witness stack for segwit v0
 * input `index` of an otherwise-prepared transaction.
 *
 * Exported so a caller can sign one input of a transaction shape the high-level
 * builders do not produce (the BIP143 reference vector, whose other input is a
 * bare P2PK, is exactly that case). `valueSats` MUST be the true prevout amount:
 * BIP143 commits to it.
 */
export function signP2wpkhInput(
  tx: SighashTx,
  index: number,
  valueSats: bigint,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array[] {
  return p2wpkhWitness(tx, index, valueSats, privateKey, publicKey, bip143Midstate(tx));
}

/** Build the (unsigned) TxInput list from SignableUtxos. */
function toInputs(utxos: SignableUtxo[]): TxInput[] {
  return utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    scriptSig: new Uint8Array(0),
    sequence: SEQUENCE_FINAL,
    witness: [],
  }));
}

/**
 * Sign every input of `tx` in place, choosing the algorithm PER INPUT from that
 * input's prevout script:
 *   - P2WPKH -> BIP143 digest over the pubkey-hash's P2PKH scriptCode; the
 *     signature and pubkey become a 2-item witness and the scriptSig stays empty;
 *   - anything else -> the legacy sighash with the prevout script substituted
 *     into this input's scriptSig (unchanged behaviour).
 *
 * The BIP143 midstate is computed once, lazily, and only when a segwit input is
 * actually present — a legacy-only transaction does not hash anything extra and
 * therefore cannot be perturbed by this code path at all.
 */
function signAllInputs(tx: Tx, utxos: SignableUtxo[]): void {
  let midstate: Bip143Midstate | undefined;

  for (let i = 0; i < tx.inputs.length; i++) {
    const utxo = utxos[i];
    const prevoutScript = hexToBytes(utxo.scriptPubKeyHex);

    if (isP2wpkhScript(prevoutScript)) {
      const program = prevoutScript.slice(2); // the 20-byte hash160
      // The witness program MUST be hash160 of the pubkey we are about to put in
      // the witness; otherwise the script fails and the input is unspendable with
      // this key. Catch a mismatched key/UTXO pairing HERE, before broadcast.
      const keyHash = hash160(utxo.publicKey);
      if (bytesToHex(keyHash) !== bytesToHex(program)) {
        throw new Error(
          `input ${i}: P2WPKH witness program does not match hash160(publicKey); wrong key for this UTXO`,
        );
      }
      midstate ??= bip143Midstate(tx);
      // BIP141: a native-segwit input's scriptSig MUST be empty; the signature
      // lives in the witness as [sig||sighashType, compressed pubkey].
      tx.inputs[i].scriptSig = new Uint8Array(0);
      tx.inputs[i].witness = p2wpkhWitness(
        tx,
        i,
        utxo.valueSats,
        utxo.privateKey,
        utxo.publicKey,
        midstate,
      );
      continue;
    }

    const sighash = legacySighash(tx, i, prevoutScript);
    tx.inputs[i].scriptSig = signInput(sighash, utxo.privateKey, utxo.publicKey);
  }
}

/**
 * Reject a segwit input on a chain that has no segwit. Only enforceable when the
 * caller passes its network; the prevout shape alone cannot tell "P2WPKH" from
 * "an output nobody on this chain can parse". Cheap defence against a chain
 * mix-up feeding a bech32 UTXO to a legacy chain's builder.
 */
function assertInputsSpendableOn(utxos: SignableUtxo[], net?: ChainNetwork): void {
  if (!net || supportsSegwit(net)) return;
  for (const u of utxos) {
    if (spendKindOf(u.scriptPubKeyHex) === 'p2wpkh') {
      throw new Error(`${net.displayName} has no segwit: cannot spend a P2WPKH input`);
    }
  }
}

/** Finalize a signed Tx into the BuiltTx result. */
function finalize(tx: Tx, _allInputs: SignableUtxo[], feeSats: bigint): BuiltTx {
  // serializeSignedTx emits the legacy bytes when no input carries a witness, so
  // a no-segwit chain gets exactly the pre-BIP143 rawHex, txid and size.
  const serialized = serializeSignedTx(tx);
  return {
    rawHex: serialized.rawHex,
    txid: serialized.txid,
    wtxid: serialized.wtxid,
    virtualSize: serialized.virtualSize,
    feeSats,
  };
}

// ---------------------------------------------------------------------------
// Build + sign: plain EVR transfer
// ---------------------------------------------------------------------------

/**
 * Build and sign a plain native-coin transaction.
 *   change = sum(inputs) - sum(outputs) - fee
 * A change output (to `changeAddress`) is appended only when change exceeds the
 * dust threshold; a dust-sized change is left in the transaction as extra fee.
 * Throws if the inputs can't cover outputs + fee (negative change).
 *
 * Inputs may be legacy, segwit, or a mix: each one is routed by its own prevout
 * script. Outputs follow the ADDRESS format (base58 -> P2PKH, bech32 -> P2WPKH),
 * so paying a bech32 recipient needs no flag here.
 */
export function buildAndSignEvrTx(params: {
  inputs: SignableUtxo[];
  outputs: TxOutput[];
  changeAddress: string;
  feeSats: bigint;
  /** Optional active chain. When supplied it is used ONLY as a safety assertion
   *  (a P2WPKH input on a chain without segwit is refused); the signing path is
   *  still chosen per input from the prevout script, never from the chain. */
  net?: ChainNetwork;
}): BuiltTx {
  const { inputs, outputs, changeAddress, feeSats } = params;
  if (inputs.length === 0) {
    throw new Error('buildAndSignEvrTx: no inputs');
  }
  assertInputsSpendableOn(inputs, params.net);

  const inputSum = inputs.reduce((acc, u) => acc + u.valueSats, 0n);
  const outputSum = outputs.reduce((acc, o) => acc + o.valueSats, 0n);
  const change = inputSum - outputSum - feeSats;
  if (change < 0n) {
    throw new Error(
      `buildAndSignEvrTx: insufficient funds: inputs ${inputSum} < outputs ${outputSum} + fee ${feeSats}`,
    );
  }

  // addressToScript detects the format from the address itself: a base58 address
  // yields the SAME P2PKH script as before (byte-identical for the legacy
  // chains), a bech32 address yields P2WPKH. Callers must have already gated the
  // address with isSpendableAddress — this must never receive a P2SH or witness
  // v1 address, which it cannot construct and which would burn the output.
  const txOuts: TxOut[] = outputs.map((o) => ({
    valueSats: o.valueSats,
    scriptPubKey: addressToScript(o.address),
  }));

  // Emit change only if it clears dust; otherwise it is absorbed into the fee.
  if (change > DUST_THRESHOLD_SATS) {
    txOuts.push({
      valueSats: change,
      scriptPubKey: addressToScript(changeAddress),
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
