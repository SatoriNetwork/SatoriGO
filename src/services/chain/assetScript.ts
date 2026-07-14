// Evrmore asset (OP_EVR_ASSET) scriptPubKey encoder/decoder.
//
// SAFETY-CRITICAL: this produces the scriptPubKey for SATORI asset transfers, so
// it must match the chain byte-for-byte. Every primitive here is pure-JS and
// CSP-safe (no Node APIs, no Buffer, no WASM, no eval) so it runs inside a
// Chrome MV3 service worker. Uint8Array is used throughout.
//
// Asset script layout (appended after a standard P2PKH scriptPubKey):
//   <P2PKH 25 bytes> OP_EVR_ASSET(0xc0) <pushlen> <blob...> OP_DROP(0x75)
// where <blob> = 4-byte marker + varfields, and <pushlen> is the length of the
// blob (up to and NOT including OP_DROP).
//
// Markers (the 4 ASCII bytes immediately after the push length):
//   "evrq" = issue (new asset), "evrt" = transfer, "evrr" = reissue, "evro" = owner.
//
// Amounts are carried as bigint sats (uint64, 8 implied decimals) to avoid float
// rounding error on 8-decimal values.

import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { p2pkhScript, addressToHash160 } from './keys';

export const OP_EVR_ASSET = 0xc0;
export const OP_DROP = 0x75;

// 4-byte ASCII markers. "evr" + kind letter.
const MARKER_TRANSFER = 'evrt';
const MARKER_ISSUE = 'evrq';
const MARKER_REISSUE = 'evrr';
const MARKER_OWNER = 'evro';

const MARKER_TO_KIND: Record<string, AssetTransfer['kind']> = {
  [MARKER_TRANSFER]: 'transfer',
  [MARKER_ISSUE]: 'issue',
  [MARKER_REISSUE]: 'reissue',
  [MARKER_OWNER]: 'owner',
};

const MAX_UINT64 = (1n << 64n) - 1n;

export interface AssetTransfer {
  kind: 'transfer' | 'issue' | 'reissue' | 'owner';
  name: string;
  /** amount in sats (integer, 8 implied decimals). */
  amount: bigint;
}

// ---------------------------------------------------------------------------
// hex helpers (re-exported from @noble/hashes/utils for callers/tests)
// ---------------------------------------------------------------------------

export { hexToBytes, bytesToHex };

// ---------------------------------------------------------------------------
// internal encoding helpers
// ---------------------------------------------------------------------------

/** Encode a 4-char ASCII marker string as 4 bytes. */
function markerBytes(marker: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    out[i] = marker.charCodeAt(i) & 0xff;
  }
  return out;
}

/** Encode an ASCII asset name as bytes, validating charset and length. */
function assetNameBytes(assetName: string): Uint8Array {
  if (typeof assetName !== 'string' || assetName.length < 1 || assetName.length > 31) {
    throw new Error(`asset name must be 1..31 chars, got length ${assetName?.length ?? 0}`);
  }
  const out = new Uint8Array(assetName.length);
  for (let i = 0; i < assetName.length; i++) {
    const code = assetName.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new Error(`asset name must be printable ASCII, got char code ${code} at ${i}`);
    }
    out[i] = code;
  }
  return out;
}

/** Encode a uint64 amount as 8 little-endian bytes. Validates range and > 0. */
function amountLE(amountSats: bigint): Uint8Array {
  if (typeof amountSats !== 'bigint') {
    throw new Error('amount must be a bigint');
  }
  if (amountSats <= 0n) {
    throw new Error(`amount must be > 0, got ${amountSats}`);
  }
  if (amountSats > MAX_UINT64) {
    throw new Error(`amount does not fit in uint64: ${amountSats}`);
  }
  const out = new Uint8Array(8);
  let v = amountSats;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Decode 8 little-endian bytes at offset into a bigint. */
function readAmountLE(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[offset + i]);
  }
  return v;
}

/** Decode `len` bytes at offset into an ASCII string. */
function readAscii(bytes: Uint8Array, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(bytes[offset + i]);
  }
  return s;
}

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

/**
 * Build a transfer_asset scriptPubKey from a raw 20-byte hash160.
 *
 * Layout:
 *   P2PKH(25) + 0xc0 + pushlen + "evrt" + nameLen(1) + nameBytes + amount(8 LE) + 0x75
 * where pushlen = 4 + 1 + name.length + 8 (blob length, excluding OP_DROP).
 */
export function buildTransferAssetScriptFromHash160(
  hash160: Uint8Array,
  assetName: string,
  amountSats: bigint,
): Uint8Array {
  if (!(hash160 instanceof Uint8Array) || hash160.length !== 20) {
    throw new Error(`hash160 must be 20 bytes, got ${hash160?.length ?? 'n/a'}`);
  }
  const name = assetNameBytes(assetName);
  const amount = amountLE(amountSats);

  const p2pkh = p2pkhScript(hash160);
  const marker = markerBytes(MARKER_TRANSFER);

  // blob = marker(4) + nameLen(1) + name + amount(8)
  const pushlen = 4 + 1 + name.length + 8;
  if (pushlen > 0x4b) {
    // Direct single-byte push only. Transfers are always well under this, but be safe.
    throw new Error(`asset blob too long for a direct push: ${pushlen}`);
  }

  return concatBytes(
    p2pkh,
    Uint8Array.of(OP_EVR_ASSET, pushlen),
    marker,
    Uint8Array.of(name.length),
    name,
    amount,
    Uint8Array.of(OP_DROP),
  );
}

/**
 * Build a transfer_asset scriptPubKey for a base58check address (decodes to
 * hash160 first).
 */
export function buildTransferAssetScript(
  address: string,
  assetName: string,
  amountSats: bigint,
): Uint8Array {
  const { hash } = addressToHash160(address);
  return buildTransferAssetScriptFromHash160(hash, assetName, amountSats);
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

/**
 * Decode an Evrmore asset scriptPubKey.
 *
 * Parses the standard P2PKH prefix, locates OP_EVR_ASSET (0xc0), reads the push
 * length, the 4-byte marker, the asset name, and the 8-byte little-endian amount
 * (plus divisions/reissuable for reissue), and verifies the trailing OP_DROP.
 *
 * Returns { p2pkhHash160, transfer } or null if `script` is not an asset script
 * (e.g. a plain P2PKH output).
 */
export function decodeAssetScript(
  script: Uint8Array | string,
): { p2pkhHash160: Uint8Array; transfer: AssetTransfer } | null {
  const bytes = typeof script === 'string' ? hexToBytes(script.trim()) : script;

  // Must at least hold the 25-byte P2PKH prefix + OP_EVR_ASSET + pushlen.
  if (bytes.length < 27) {
    return null;
  }

  // Standard P2PKH prefix: 76 a9 14 <20> 88 ac.
  if (
    bytes[0] !== 0x76 ||
    bytes[1] !== 0xa9 ||
    bytes[2] !== 0x14 ||
    bytes[23] !== 0x88 ||
    bytes[24] !== 0xac
  ) {
    return null;
  }
  const p2pkhHash160 = bytes.slice(3, 23);

  // OP_EVR_ASSET immediately follows the P2PKH script.
  if (bytes[25] !== OP_EVR_ASSET) {
    return null;
  }

  // Push length: the size of the asset blob (up to, not including, OP_DROP).
  const pushlen = bytes[26];
  const blobStart = 27;
  const blobEnd = blobStart + pushlen;
  // Blob + trailing OP_DROP must be present.
  if (blobEnd >= bytes.length || bytes[blobEnd] !== OP_DROP) {
    return null;
  }

  // Marker: 4 ASCII bytes.
  if (pushlen < 5) {
    return null;
  }
  const marker = readAscii(bytes, blobStart, 4);
  const kind = MARKER_TO_KIND[marker];
  if (!kind) {
    return null;
  }

  // Owner assets carry only a name (no amount); everything else has name + amount.
  let cursor = blobStart + 4;
  const nameLen = bytes[cursor];
  cursor += 1;
  if (nameLen < 1 || cursor + nameLen > blobEnd) {
    return null;
  }
  const name = readAscii(bytes, cursor, nameLen);
  cursor += nameLen;

  if (kind === 'owner') {
    // Owner token: name only, no amount field.
    return { p2pkhHash160, transfer: { kind, name, amount: 0n } };
  }

  // amount: 8 little-endian bytes.
  if (cursor + 8 > blobEnd) {
    return null;
  }
  const amount = readAmountLE(bytes, cursor);
  cursor += 8;

  // reissue additionally carries divisions(1) + reissuable(1); issue carries
  // divisions(1) + reissuable(1) + hasIPFS(1) [+ 34-byte IPFS hash]. We only
  // need the amount for the wallet, but we consumed the fields for correctness.
  // Any trailing bytes up to blobEnd are the extra fields; we do not reject them.

  return { p2pkhHash160, transfer: { kind, name, amount } };
}
