// The EVM transaction model, and the only place a transaction is serialized or
// signed. One shape serves every caller: a native transfer, an ERC-20
// transfer, and (later) whatever a connected site composes. They differ only in
// `data`, which is why there is no "native" branch and no "token" branch here.
// See the EVM engine design notes, section 10: writing those as two cases is what
// forces the builder and the signer to be rewritten when the dApp path lands.
//
// `chainId` is present from the start, not added later: EIP-155 binds it into
// the signature, and that binding is what stops a Base transaction being
// replayed on BSC (section 7).
//
// Everything here is pure and synchronous. Nothing estimates, fetches, or
// sends. This module SIGNS; broadcasting belongs to a later phase.
//
// Amounts are bigint throughout. One ETH is 10^18 wei, past
// Number.MAX_SAFE_INTEGER, so a `number` in a value or fee field is a bug and
// the validator refuses one.

import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import { bigintToRlpBytes, rlpBytesToBigint, rlpDecode, rlpEncode, type RlpInput } from './rlp';

// @noble/secp256k1 v2's synchronous `sign` needs a synchronous HMAC-SHA256 for
// RFC6979. Wire the same pure-JS hook message.ts and txBuilder.ts use so this
// module is self-contained (idempotent: assigning the same shape twice is
// harmless).
secp256k1.etc.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]): Uint8Array =>
  hmac(sha256, key, concatBytes(...msgs));

/** EIP-2718 type byte of an EIP-1559 (dynamic fee) transaction. */
export const EIP1559_TX_TYPE = 0x02;

const CURVE_N = secp256k1.CURVE.n;
/** low-s: s must be in the lower half of the curve order, or it is malleable. */
const HALF_CURVE_N = CURVE_N / 2n;
const MAX_UINT64 = 2n ** 64n;
const MAX_UINT256 = 2n ** 256n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * How a chain prices gas. EIP-1559 everywhere modern, legacy `gasPrice` on the
 * chains that never moved (see the design doc, section 4).
 */
export type EvmFee =
  | { type: 'eip1559'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { type: 'legacy'; gasPrice: bigint };

/** One transaction, whatever composed it. */
export interface EvmTxRequest {
  /** EIP-155 binding. Always present, always > 0. */
  chainId: number;
  nonce: bigint;
  /** 0x + 40 hex, any case. Checksum validation lives in keys.ts, not here. */
  to: string;
  /** wei */
  value: bigint;
  /** Calldata. Empty for a native transfer; an ERC-20 transfer is just data. */
  data: Uint8Array;
  gasLimit: bigint;
  fee: EvmFee;
}

/** The output of signing: bytes to broadcast, plus the signature parts. */
export interface SignedEvmTx {
  /** What eth_sendRawTransaction takes. */
  raw: Uint8Array;
  rawHex: string;
  /** 0x + keccak256(raw): the txid. */
  hash: string;
  yParity: 0 | 1;
  r: bigint;
  s: bigint;
  /** legacy: chainId*2 + 35 + yParity. eip1559: yParity. */
  v: bigint;
}

/** What a raw transaction says, once read back. */
export interface DecodedEvmTx {
  tx: EvmTxRequest;
  yParity: 0 | 1;
  r: bigint;
  s: bigint;
  v: bigint;
  hash: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function requireBigint(value: bigint, field: string): void {
  if (typeof value !== 'bigint') {
    throw new Error(`evm tx: ${field} must be a bigint (a number cannot hold wei)`);
  }
}

function requireUint256(value: bigint, field: string): void {
  requireBigint(value, field);
  if (value < 0n) throw new Error(`evm tx: ${field} must not be negative`);
  if (value >= MAX_UINT256) throw new Error(`evm tx: ${field} must be below 2^256`);
}

/**
 * Refuse anything that is not a well formed transaction, with a message that
 * says which field and why. Called by every entry point below, so no caller can
 * skip it, and callable on its own to check a request before showing it.
 */
export function validateEvmTxRequest(tx: EvmTxRequest): void {
  if (tx === null || typeof tx !== 'object') throw new Error('evm tx: request must be an object');

  if (typeof tx.chainId !== 'number' || !Number.isSafeInteger(tx.chainId) || tx.chainId <= 0) {
    throw new Error('evm tx: chainId must be a positive integer');
  }

  requireBigint(tx.nonce, 'nonce');
  if (tx.nonce < 0n) throw new Error('evm tx: nonce must not be negative');
  if (tx.nonce >= MAX_UINT64) throw new Error('evm tx: nonce must be below 2^64');

  if (typeof tx.to !== 'string' || !ADDRESS_RE.test(tx.to)) {
    throw new Error('evm tx: to must be 0x followed by 40 hex characters');
  }

  requireUint256(tx.value, 'value');

  if (!(tx.data instanceof Uint8Array)) throw new Error('evm tx: data must be a Uint8Array');

  requireBigint(tx.gasLimit, 'gasLimit');
  if (tx.gasLimit <= 0n) throw new Error('evm tx: gasLimit must be greater than zero');
  if (tx.gasLimit >= MAX_UINT64) throw new Error('evm tx: gasLimit must be below 2^64');

  const fee = tx.fee;
  if (fee === null || typeof fee !== 'object') throw new Error('evm tx: fee is required');
  if (fee.type === 'eip1559') {
    requireUint256(fee.maxFeePerGas, 'maxFeePerGas');
    requireUint256(fee.maxPriorityFeePerGas, 'maxPriorityFeePerGas');
    if (fee.maxPriorityFeePerGas > fee.maxFeePerGas) {
      throw new Error('evm tx: maxPriorityFeePerGas must not exceed maxFeePerGas');
    }
  } else if (fee.type === 'legacy') {
    requireUint256(fee.gasPrice, 'gasPrice');
  } else {
    throw new Error('evm tx: fee.type must be eip1559 or legacy');
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function addressToBytes(to: string): Uint8Array {
  return hexToBytes(to.slice(2).toLowerCase());
}

function bytesToAddress(b: Uint8Array): string {
  return '0x' + bytesToHex(b);
}

/** The nine fields an EIP-1559 transaction signs over, in EIP-1559's order. */
function eip1559Fields(tx: EvmTxRequest, fee: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): RlpInput[] {
  return [
    bigintToRlpBytes(BigInt(tx.chainId)),
    bigintToRlpBytes(tx.nonce),
    // Priority fee comes BEFORE max fee. Swapping them still produces valid
    // RLP and a signature, just for a different transaction.
    bigintToRlpBytes(fee.maxPriorityFeePerGas),
    bigintToRlpBytes(fee.maxFeePerGas),
    bigintToRlpBytes(tx.gasLimit),
    addressToBytes(tx.to),
    bigintToRlpBytes(tx.value),
    tx.data,
    [], // access list: always empty, and the decoder refuses a non empty one
  ];
}

/** The nine fields an EIP-155 legacy transaction signs over. */
function legacySigningFields(tx: EvmTxRequest, gasPrice: bigint): RlpInput[] {
  return [
    bigintToRlpBytes(tx.nonce),
    bigintToRlpBytes(gasPrice),
    bigintToRlpBytes(tx.gasLimit),
    addressToBytes(tx.to),
    bigintToRlpBytes(tx.value),
    tx.data,
    // EIP-155: chainId, 0, 0 replace the empty signature slots.
    bigintToRlpBytes(BigInt(tx.chainId)),
    bigintToRlpBytes(0n),
    bigintToRlpBytes(0n),
  ];
}

/**
 * The exact bytes that get hashed for signing: a typed 0x02 envelope for
 * EIP-1559, or the nine field EIP-155 list for legacy.
 */
export function serializeUnsignedTx(tx: EvmTxRequest): Uint8Array {
  validateEvmTxRequest(tx);
  if (tx.fee.type === 'eip1559') {
    return concatBytes(Uint8Array.of(EIP1559_TX_TYPE), rlpEncode(eip1559Fields(tx, tx.fee)));
  }
  return rlpEncode(legacySigningFields(tx, tx.fee.gasPrice));
}

/** keccak256 of the unsigned serialization: the 32 bytes secp256k1 signs. */
export function signingHash(tx: EvmTxRequest): Uint8Array {
  return keccak_256(serializeUnsignedTx(tx));
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Sign a transaction. RFC6979 deterministic, canonical low-s, so signing the
 * same request twice yields the same bytes and the same txid.
 */
export function signTx(tx: EvmTxRequest, privateKey: Uint8Array): SignedEvmTx {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new Error('evm tx: private key must be 32 bytes');
  }
  const hash = signingHash(tx);
  const sig = secp256k1.sign(hash, privateKey, { lowS: true });
  const recovery = sig.recovery;
  if (recovery !== 0 && recovery !== 1) {
    // Recovery bits 2 and 3 need r >= curve order, which no honest signature
    // reaches. Refuse rather than encode something a node will reject.
    throw new Error('evm tx: unexpected recovery bit');
  }
  const yParity: 0 | 1 = recovery;
  const { r, s } = sig;

  let raw: Uint8Array;
  let v: bigint;
  if (tx.fee.type === 'eip1559') {
    v = BigInt(yParity);
    raw = concatBytes(
      Uint8Array.of(EIP1559_TX_TYPE),
      rlpEncode([
        ...eip1559Fields(tx, tx.fee),
        bigintToRlpBytes(v),
        bigintToRlpBytes(r),
        bigintToRlpBytes(s),
      ]),
    );
  } else {
    v = BigInt(tx.chainId) * 2n + 35n + BigInt(yParity);
    const fields = legacySigningFields(tx, tx.fee.gasPrice).slice(0, 6);
    raw = rlpEncode([...fields, bigintToRlpBytes(v), bigintToRlpBytes(r), bigintToRlpBytes(s)]);
  }

  return {
    raw,
    rawHex: '0x' + bytesToHex(raw),
    hash: '0x' + bytesToHex(keccak_256(raw)),
    yParity,
    r,
    s,
    v,
  };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function toBytes(raw: Uint8Array | string): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw !== 'string') throw new Error('evm tx: raw must be a Uint8Array or a 0x hex string');
  const body = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (body.length % 2 !== 0) throw new Error('evm tx: raw hex has an odd length');
  if (!/^[0-9a-fA-F]*$/.test(body)) throw new Error('evm tx: raw is not hex');
  return hexToBytes(body.toLowerCase());
}

function asList(item: RlpInput, what: string): RlpInput[] {
  if (!Array.isArray(item)) throw new Error(`evm tx: ${what} must be an RLP list`);
  return item;
}

function asBytes(item: RlpInput, what: string): Uint8Array {
  if (!(item instanceof Uint8Array)) throw new Error(`evm tx: ${what} must be an RLP byte string`);
  return item;
}

function asAddress(item: RlpInput, what: string): string {
  const bytes = asBytes(item, what);
  if (bytes.length !== 20) {
    // An empty `to` is contract creation, which this wallet does not build or
    // read back. Refuse rather than present it as a transfer to nowhere.
    throw new Error(`evm tx: ${what} must be 20 bytes`);
  }
  return bytesToAddress(bytes);
}

function checkSignatureScalars(r: bigint, s: bigint): void {
  if (r <= 0n || r >= CURVE_N) throw new Error('evm tx: signature r out of range');
  if (s <= 0n || s >= CURVE_N) throw new Error('evm tx: signature s out of range');
  if (s > HALF_CURVE_N) throw new Error('evm tx: signature s is not low-s (malleable)');
}

function toChainIdNumber(chainId: bigint): number {
  if (chainId <= 0n) throw new Error('evm tx: chainId must be a positive integer');
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('evm tx: chainId too large');
  return Number(chainId);
}

function decodeEip1559(bytes: Uint8Array): DecodedEvmTx {
  const items = asList(rlpDecode(bytes.subarray(1)), 'eip1559 payload');
  if (items.length !== 12) {
    throw new Error(`evm tx: eip1559 transaction must have 12 fields, got ${items.length}`);
  }
  const accessList = asList(items[8], 'access list');
  if (accessList.length !== 0) throw new Error('evm tx: access lists are not supported');

  const yParityValue = rlpBytesToBigint(asBytes(items[9], 'yParity'));
  if (yParityValue !== 0n && yParityValue !== 1n) throw new Error('evm tx: yParity must be 0 or 1');
  const yParity: 0 | 1 = yParityValue === 0n ? 0 : 1;

  const r = rlpBytesToBigint(asBytes(items[10], 'signature r'));
  const s = rlpBytesToBigint(asBytes(items[11], 'signature s'));
  checkSignatureScalars(r, s);

  const tx: EvmTxRequest = {
    chainId: toChainIdNumber(rlpBytesToBigint(asBytes(items[0], 'chainId'))),
    nonce: rlpBytesToBigint(asBytes(items[1], 'nonce')),
    to: asAddress(items[5], 'to'),
    value: rlpBytesToBigint(asBytes(items[6], 'value')),
    data: asBytes(items[7], 'data'),
    gasLimit: rlpBytesToBigint(asBytes(items[4], 'gasLimit')),
    fee: {
      type: 'eip1559',
      maxPriorityFeePerGas: rlpBytesToBigint(asBytes(items[2], 'maxPriorityFeePerGas')),
      maxFeePerGas: rlpBytesToBigint(asBytes(items[3], 'maxFeePerGas')),
    },
  };
  validateEvmTxRequest(tx);

  return { tx, yParity, r, s, v: BigInt(yParity), hash: '0x' + bytesToHex(keccak_256(bytes)) };
}

function decodeLegacy(bytes: Uint8Array): DecodedEvmTx {
  const items = asList(rlpDecode(bytes), 'legacy transaction');
  if (items.length !== 9) {
    throw new Error(`evm tx: legacy transaction must have 9 fields, got ${items.length}`);
  }

  const v = rlpBytesToBigint(asBytes(items[6], 'v'));
  if (v < 35n) {
    // v of 27/28 is a pre-EIP-155 signature: no chain is bound into it, so it
    // is replayable on every chain. This wallet does not produce or read one.
    throw new Error('evm tx: legacy v must be EIP-155 (chainId*2 + 35 + yParity)');
  }
  const yParity: 0 | 1 = (v - 35n) % 2n === 0n ? 0 : 1;
  const chainId = toChainIdNumber((v - 35n - BigInt(yParity)) / 2n);

  const r = rlpBytesToBigint(asBytes(items[7], 'signature r'));
  const s = rlpBytesToBigint(asBytes(items[8], 'signature s'));
  checkSignatureScalars(r, s);

  const tx: EvmTxRequest = {
    chainId,
    nonce: rlpBytesToBigint(asBytes(items[0], 'nonce')),
    to: asAddress(items[3], 'to'),
    value: rlpBytesToBigint(asBytes(items[4], 'value')),
    data: asBytes(items[5], 'data'),
    gasLimit: rlpBytesToBigint(asBytes(items[2], 'gasLimit')),
    fee: { type: 'legacy', gasPrice: rlpBytesToBigint(asBytes(items[1], 'gasPrice')) },
  };
  validateEvmTxRequest(tx);

  return { tx, yParity, r, s, v, hash: '0x' + bytesToHex(keccak_256(bytes)) };
}

/**
 * Read a raw transaction back: the strict inverse of signTx for both
 * envelopes. Every deviation (an unknown type byte, the wrong field count, a
 * non empty access list, a high-s or out of range signature, trailing bytes)
 * throws instead of returning a best guess.
 */
export function decodeSignedTx(raw: Uint8Array | string): DecodedEvmTx {
  const bytes = toBytes(raw);
  if (bytes.length === 0) throw new Error('evm tx: empty raw transaction');
  const first = bytes[0];
  if (first <= 0x7f) {
    // EIP-2718 typed envelope: the first byte is the type.
    if (first !== EIP1559_TX_TYPE) {
      throw new Error(
        `evm tx: unsupported transaction type 0x${first.toString(16).padStart(2, '0')}`,
      );
    }
    return decodeEip1559(bytes);
  }
  if (first < 0xc0) throw new Error('evm tx: raw transaction is not a typed envelope or an RLP list');
  return decodeLegacy(bytes);
}

/**
 * The 65 byte uncompressed public key of whoever signed `raw`. Recovering it
 * and comparing to the wallet's own key is how a caller proves a raw
 * transaction is the one it just signed, without trusting this module.
 */
export function recoverTxPublicKey(raw: Uint8Array | string): Uint8Array {
  const decoded = decodeSignedTx(raw);
  const sig = new secp256k1.Signature(decoded.r, decoded.s, decoded.yParity);
  return sig.recoverPublicKey(signingHash(decoded.tx)).toRawBytes(false);
}
