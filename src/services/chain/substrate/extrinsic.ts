// The extrinsic, by hand: Balances transfer calls, the v4 signed-extrinsic
// wire format, the signing payload, and the decoders for the runtime's fee
// and validity answers (design bittensor-engine.md §4).
//
// Verified against the live runtime (spec 470) and a real on-chain transfer
// (block 9,168,516, fixtures in testing/fixtures.ts), and the node validated
// a transfer built and signed this way without broadcasting it.
//
//   extrinsic = compact(len) || 0x84 || 0x00 || signer(32) || 0x01 || sig(64)
//               || era || compact(nonce) || compact(tip) || mode(0x00) || call
//   call      = pallet || index || 0x00 (MultiAddress::Id) || dest(32) || compact(rao)
//               (transfer_all: ... || dest(32) || keep_alive(u8))
//   payload   = call || era || compact(nonce) || compact(tip) || 0x00 (mode)
//               || u32le(specVersion) || u32le(txVersion) || genesis(32)
//               || eraCheckpoint(32) || 0x00 (Option<[u8;32]>::None)
//   sign(blake2b-256(payload)) when payload > 256 bytes, else sign(payload)
//
// The layout is what the profile says (extrinsic v4, the thirteen signed
// extensions of which five contribute bytes, Balance u64). Nothing here reads
// the profile's extension list: profile.ts refuses to sign when it differs
// from the pinned one, which is what makes the fixed byte layout below safe.
//
// Balance is u64: Compact<u64> for the amount and the tip. A rao above 2^64-1
// is refused before encoding (a u128 example copied from Polkadot would
// otherwise encode and be rejected, or not, by a runtime we did not model).

import { blake2b } from '@noble/hashes/blake2b';
import { concatBytes } from '@noble/hashes/utils';
import { signSubstrate, type SubstrateAccount } from './keys';
import type { TaoRuntimeProfile } from './profile';
import {
  MAX_U32,
  MAX_U64,
  ScaleError,
  bytesToHex0x,
  compact,
  decodeEra,
  hexToBytes0x,
  mortalEra,
  readCompact,
  u32le,
} from './scale';

const EXTRINSIC_V4_SIGNED = 0x84;
const MULTI_ADDRESS_ID = 0x00;
/** MultiSignature tags. The wallet signs sr25519 only; the decoder also reads ed25519 (btcli's opt-in coldkey type). */
const MULTI_SIGNATURE_ED25519 = 0x00;
const MULTI_SIGNATURE_SR25519 = 0x01;
export type SignatureType = 'sr25519' | 'ed25519';
const METADATA_HASH_MODE_DISABLED = 0x00;
const OPTION_NONE = 0x00;
/** Above this many bytes the payload is signed through blake2b-256 (sp_runtime). */
const PAYLOAD_HASH_THRESHOLD = 256;

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface TransferCall {
  kind: 'transfer_keep_alive' | 'transfer_allow_death' | 'transfer_all';
  /** 32-byte public key of the recipient. */
  dest: Uint8Array;
  /** rao, for the two amount calls; ignored by transfer_all. */
  rao?: bigint;
  /** transfer_all only: keep the sender alive with the existential deposit (the wallet always says true). */
  keepAlive?: boolean;
}

function assertDest(dest: Uint8Array): void {
  if (!(dest instanceof Uint8Array) || dest.length !== 32) throw new ScaleError('A recipient is a 32-byte public key.');
}

/** SCALE bytes of a Balances call under `profile`'s pallet and call indices. */
export function encodeCall(profile: TaoRuntimeProfile, call: TransferCall): Uint8Array {
  assertDest(call.dest);
  const pallet = profile.balances.pallet;
  if (call.kind === 'transfer_all') {
    if (typeof call.keepAlive !== 'boolean') throw new ScaleError('transfer_all needs keepAlive.');
    return concatBytes(
      Uint8Array.of(pallet, profile.balances.transfer_all, MULTI_ADDRESS_ID),
      call.dest,
      Uint8Array.of(call.keepAlive ? 1 : 0),
    );
  }
  const index = call.kind === 'transfer_keep_alive' ? profile.balances.transfer_keep_alive : profile.balances.transfer_allow_death;
  if (call.kind !== 'transfer_keep_alive' && call.kind !== 'transfer_allow_death') {
    throw new ScaleError('Unknown transfer call.');
  }
  if (typeof call.rao !== 'bigint') throw new ScaleError('The amount must be a bigint of rao.');
  if (call.rao <= 0n) throw new ScaleError('The amount must be positive.');
  if (call.rao > MAX_U64) throw new ScaleError('The amount does not fit a u64: Bittensor balances are 64-bit.');
  return concatBytes(Uint8Array.of(pallet, index, MULTI_ADDRESS_ID), call.dest, compact(call.rao));
}

/** The inverse of encodeCall for the three transfer calls; anything else throws. */
export function decodeCall(profile: TaoRuntimeProfile, buf: Uint8Array, off = 0): { call: TransferCall; next: number } {
  if (off + 2 > buf.length) throw new ScaleError('Unexpected end of data reading the call.');
  const pallet = buf[off];
  const index = buf[off + 1];
  if (pallet !== profile.balances.pallet) throw new ScaleError(`Not a Balances call (pallet ${pallet}).`);
  const b = profile.balances;
  const kind: TransferCall['kind'] | null =
    index === b.transfer_keep_alive ? 'transfer_keep_alive' : index === b.transfer_allow_death ? 'transfer_allow_death' : index === b.transfer_all ? 'transfer_all' : null;
  if (kind === null) throw new ScaleError(`Not a transfer call (index ${index}).`);
  let p = off + 2;
  if (buf[p] !== MULTI_ADDRESS_ID) throw new ScaleError('Recipient is not MultiAddress::Id.');
  p += 1;
  if (p + 32 > buf.length) throw new ScaleError('Unexpected end of data reading the recipient.');
  const dest = buf.slice(p, p + 32);
  p += 32;
  if (kind === 'transfer_all') {
    if (p >= buf.length || (buf[p] !== 0 && buf[p] !== 1)) throw new ScaleError('transfer_all keep_alive is not a bool.');
    return { call: { kind, dest, keepAlive: buf[p] === 1 }, next: p + 1 };
  }
  const amount = readCompact(buf, p);
  if (amount.value > MAX_U64) throw new ScaleError('The amount does not fit a u64.');
  return { call: { kind, dest, rao: amount.value }, next: amount.next };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SignArgs {
  profile: TaoRuntimeProfile;
  account: SubstrateAccount;
  /** encodeCall's bytes. */
  call: Uint8Array;
  nonce: number;
  tip?: bigint;
  /** Blocks the extrinsic stays valid for, from the checkpoint (TAO_ERA_PERIOD). */
  eraPeriod: number;
  /** The finalized block the era starts at (its number and hash). */
  checkpointNumber: number;
  checkpointHash: Uint8Array;
  /** Tests only: a 32-byte nonce seed for a deterministic signature. */
  random?: Uint8Array;
}

export interface SignedExtrinsic {
  /** The full extrinsic, length prefix included, as 0x hex: what author_submitExtrinsic takes. */
  hex: string;
  /** blake2b-256 of the full extrinsic bytes, 0x hex: the extrinsic hash, computed locally. */
  hash: string;
  /** What was signed (before the >256-byte hashing rule, which a transfer never reaches). */
  payload: Uint8Array;
  nonce: number;
  eraPeriod: number;
  checkpointNumber: number;
}

/** The `extra` bytes: era || compact(nonce) || compact(tip) || mode. */
function encodeExtra(era: Uint8Array, nonce: number, tip: bigint): Uint8Array {
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > MAX_U32) throw new ScaleError('The nonce must be a u32.');
  if (typeof tip !== 'bigint' || tip < 0n || tip > MAX_U64) throw new ScaleError('The tip must be a u64 of rao.');
  return concatBytes(era, compact(nonce), compact(tip), Uint8Array.of(METADATA_HASH_MODE_DISABLED));
}

/** The `additional` (implicit) bytes: specVersion || txVersion || genesis || checkpoint || None. */
function encodeAdditional(profile: TaoRuntimeProfile, checkpointHash: Uint8Array): Uint8Array {
  if (!(checkpointHash instanceof Uint8Array) || checkpointHash.length !== 32) throw new ScaleError('The era checkpoint hash is 32 bytes.');
  if (profile.extrinsicVersion !== 4) throw new ScaleError('Only extrinsic version 4 is supported.');
  if (profile.balanceBytes !== 8) throw new ScaleError('Only a 64-bit balance is supported.');
  return concatBytes(
    u32le(profile.specVersion),
    u32le(profile.transactionVersion),
    hexToBytes0x(profile.genesis),
    checkpointHash,
    Uint8Array.of(OPTION_NONE),
  );
}

/**
 * The signing payload of a call under `profile`, before the >256-byte
 * hashing rule: call || extra || additional. Exported so a test can pin it
 * against polkadot.js's ExtrinsicPayload bytes without a signature in the way.
 */
export function signingPayload(args: Omit<SignArgs, 'account' | 'random'>): Uint8Array {
  const era = mortalEra(args.eraPeriod, args.checkpointNumber).bytes;
  const extra = encodeExtra(era, args.nonce, args.tip ?? 0n);
  return concatBytes(args.call, extra, encodeAdditional(args.profile, args.checkpointHash));
}

/** What actually goes under the signature: the payload, or its blake2b-256 when longer than 256 bytes. */
export function signable(payload: Uint8Array): Uint8Array {
  return payload.length > PAYLOAD_HASH_THRESHOLD ? blake2b(payload, { dkLen: 32 }) : payload;
}

/**
 * Assembles the signed extrinsic from its parts (no signing): exported so
 * the on-chain transfer can be decoded and re-encoded byte for byte.
 */
export function assembleExtrinsic(parts: {
  signer: Uint8Array;
  signature: Uint8Array;
  /** Defaults to sr25519, the only scheme the wallet signs with. */
  signatureType?: SignatureType;
  era: Uint8Array;
  nonce: number;
  tip: bigint;
  call: Uint8Array;
}): Uint8Array {
  if (!(parts.signer instanceof Uint8Array) || parts.signer.length !== 32) throw new ScaleError('The signer is a 32-byte public key.');
  if (!(parts.signature instanceof Uint8Array) || parts.signature.length !== 64) throw new ScaleError('A signature is 64 bytes.');
  const sigType = parts.signatureType ?? 'sr25519';
  if (sigType !== 'sr25519' && sigType !== 'ed25519') throw new ScaleError('Unknown signature type.');
  const body = concatBytes(
    Uint8Array.of(EXTRINSIC_V4_SIGNED, MULTI_ADDRESS_ID),
    parts.signer,
    Uint8Array.of(sigType === 'sr25519' ? MULTI_SIGNATURE_SR25519 : MULTI_SIGNATURE_ED25519),
    parts.signature,
    encodeExtra(parts.era, parts.nonce, parts.tip),
    parts.call,
  );
  return concatBytes(compact(body.length), body);
}

/** blake2b-256 of the full extrinsic bytes, the hash the chain reports for it. */
export function extrinsicHash(fullBytes: Uint8Array): string {
  return bytesToHex0x(blake2b(fullBytes, { dkLen: 32 }));
}

/**
 * Builds, signs and encodes the extrinsic. The mini secret is read from
 * `args.account` and the expanded secret lives only inside the signature
 * call (keys.ts). The hash is computed locally, never parsed from an answer.
 */
export function buildSignedExtrinsic(args: SignArgs): SignedExtrinsic {
  const tip = args.tip ?? 0n;
  const era = mortalEra(args.eraPeriod, args.checkpointNumber);
  const payload = signingPayload({
    profile: args.profile,
    call: args.call,
    nonce: args.nonce,
    tip,
    eraPeriod: args.eraPeriod,
    checkpointNumber: args.checkpointNumber,
    checkpointHash: args.checkpointHash,
  });
  const signature = signSubstrate(args.account.miniSecret, signable(payload), args.random);
  const full = assembleExtrinsic({
    signer: args.account.publicKey,
    signature,
    era: era.bytes,
    nonce: args.nonce,
    tip,
    call: args.call,
  });
  return {
    hex: bytesToHex0x(full),
    hash: extrinsicHash(full),
    payload,
    nonce: args.nonce,
    eraPeriod: era.period,
    checkpointNumber: args.checkpointNumber,
  };
}

export interface DecodedExtrinsic {
  signer: Uint8Array;
  signature: Uint8Array;
  signatureType: SignatureType;
  era: { period: number; phase: number };
  nonce: number;
  tip: bigint;
  call: TransferCall;
}

/**
 * Decodes a signed v4 extrinsic (sr25519 or ed25519 signature) carrying one
 * of the three transfer calls; anything else (unsigned, an ecdsa signature,
 * another call, trailing bytes, a length prefix that lies) throws ScaleError.
 */
export function decodeSignedExtrinsic(hex: string, profile: TaoRuntimeProfile): DecodedExtrinsic {
  const buf = hexToBytes0x(hex);
  const len = readCompact(buf, 0);
  let off = len.next;
  if (Number(len.value) !== buf.length - off) throw new ScaleError('Extrinsic length prefix does not match.');
  if (buf[off] !== EXTRINSIC_V4_SIGNED) throw new ScaleError(`Not a signed v4 extrinsic (0x${buf[off]?.toString(16) ?? ''}).`);
  off += 1;
  if (buf[off] !== MULTI_ADDRESS_ID) throw new ScaleError('Signer is not MultiAddress::Id.');
  off += 1;
  if (off + 32 > buf.length) throw new ScaleError('Unexpected end of data reading the signer.');
  const signer = buf.slice(off, off + 32);
  off += 32;
  const signatureType: SignatureType | null =
    buf[off] === MULTI_SIGNATURE_SR25519 ? 'sr25519' : buf[off] === MULTI_SIGNATURE_ED25519 ? 'ed25519' : null;
  if (signatureType === null) throw new ScaleError('Signature is not sr25519 or ed25519.');
  off += 1;
  if (off + 64 > buf.length) throw new ScaleError('Unexpected end of data reading the signature.');
  const signature = buf.slice(off, off + 64);
  off += 64;
  const era = decodeEra(buf, off);
  off = era.next;
  const nonce = readCompact(buf, off);
  off = nonce.next;
  if (nonce.value > BigInt(MAX_U32)) throw new ScaleError('Nonce does not fit a u32.');
  const tip = readCompact(buf, off);
  off = tip.next;
  if (tip.value > MAX_U64) throw new ScaleError('Tip does not fit a u64.');
  if (buf[off] !== METADATA_HASH_MODE_DISABLED) throw new ScaleError('CheckMetadataHash mode is not Disabled.');
  off += 1;
  const call = decodeCall(profile, buf, off);
  off = call.next;
  if (off !== buf.length) throw new ScaleError(`Trailing bytes after the call: ${buf.length - off}.`);
  return {
    signer,
    signature,
    signatureType,
    era: { period: era.period, phase: era.phase },
    nonce: Number(nonce.value),
    tip: tip.value,
    call: call.call,
  };
}

// ---------------------------------------------------------------------------
// Runtime answers
// ---------------------------------------------------------------------------

export interface RuntimeDispatchInfo {
  refTime: bigint;
  proofSize: bigint;
  /** 0 Normal, 1 Operational, 2 Mandatory. */
  class: number;
  partialFee: bigint;
}

/**
 * state_call TransactionPaymentApi_query_info answer:
 * RuntimeDispatchInfo { weight { compact ref_time, compact proof_size }, class u8, partial_fee Balance }.
 * `balanceBytes` is the profile's (8): a 16-byte fee is a runtime this engine
 * does not model and is refused by the length check.
 */
export function decodeRuntimeDispatchInfo(hex: string, balanceBytes: 8): RuntimeDispatchInfo {
  if (balanceBytes !== 8) throw new ScaleError('Only a 64-bit balance is supported.');
  const b = hexToBytes0x(hex);
  const rt = readCompact(b, 0);
  const ps = readCompact(b, rt.next);
  const classOff = ps.next;
  if (classOff >= b.length) throw new ScaleError('Unexpected end of data reading the dispatch class.');
  const cls = b[classOff];
  if (cls > 2) throw new ScaleError(`Unknown dispatch class ${cls}.`);
  const feeOff = classOff + 1;
  if (b.length - feeOff !== balanceBytes) {
    throw new ScaleError(`RuntimeDispatchInfo fee is ${b.length - feeOff} bytes, expected ${balanceBytes}.`);
  }
  let fee = 0n;
  for (let i = balanceBytes - 1; i >= 0; i -= 1) fee = (fee << 8n) | BigInt(b[feeOff + i]);
  return { refTime: rt.value, proofSize: ps.value, class: cls, partialFee: fee };
}

/** sp_runtime InvalidTransaction variants, by index. */
export const INVALID_TRANSACTION = Object.freeze([
  'Call',
  'Payment',
  'Future',
  'Stale',
  'BadProof',
  'AncientBirthBlock',
  'ExhaustsResources',
  'Custom',
  'BadMandatory',
  'MandatoryValidation',
  'BadSigner',
  'IndeterminateImplicit',
  'UnknownOrigin',
]);

/** sp_runtime UnknownTransaction variants, by index. */
export const UNKNOWN_TRANSACTION = Object.freeze(['CannotLookup', 'NoUnsignedValidator', 'Custom']);

export type TransactionValidity =
  | { ok: true }
  | { ok: false; kind: 'invalid' | 'unknown'; code: number; name: string };

/**
 * state_call TaggedTransactionQueue_validate_transaction answer:
 * Result<ValidTransaction, TransactionValidityError>. 0x00... is Ok (the
 * ValidTransaction body is not decoded: the wallet only needs "valid");
 * 0x01 0x00 <i> is Invalid(i), 0x01 0x01 <i> is Unknown(i). `name` is the
 * variant name, or "#n" for one this engine does not know; Custom carries
 * its byte as "Custom(n)".
 */
export function decodeTransactionValidity(hex: string): TransactionValidity {
  const b = hexToBytes0x(hex);
  if (b.length === 0) throw new ScaleError('Empty TransactionValidity.');
  if (b[0] === 0) return { ok: true };
  if (b[0] !== 1 || b.length < 3) throw new ScaleError('Not a TransactionValidity.');
  const code = b[2];
  if (b[1] === 0) {
    const base = INVALID_TRANSACTION[code] ?? `#${code}`;
    const name = base === 'Custom' && b.length > 3 ? `Custom(${b[3]})` : base;
    return { ok: false, kind: 'invalid', code, name };
  }
  if (b[1] === 1) {
    const base = UNKNOWN_TRANSACTION[code] ?? `#${code}`;
    const name = base === 'Custom' && b.length > 3 ? `Custom(${b[3]})` : base;
    return { ok: false, kind: 'unknown', code, name };
  }
  throw new ScaleError('Not a TransactionValidity.');
}
