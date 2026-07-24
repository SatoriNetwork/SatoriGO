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
// Markers (the 4 ASCII bytes immediately after the push length) are the chain's
// 3-char asset-marker prefix + a kind letter. The prefix is chain-dependent:
//   Evrmore   'evr' -> "evrq" issue, "evrt" transfer, "evrr" reissue, "evro" owner.
//   Ravencoin 'rvn' -> "rvnq" issue, "rvnt" transfer, "rvnr" reissue, "rvno" owner.
// (Ravencoin markers verified against RavenProject/Ravencoin src/assets/assets.cpp
//  and a REAL on-chain transfer, see assetScript.test.ts.)
//
// Amounts are carried as bigint sats (uint64, 8 implied decimals) to avoid float
// rounding error on 8-decimal values.

import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { p2pkhScript, addressToHash160 } from './keys';

export const OP_EVR_ASSET = 0xc0;
export const OP_DROP = 0x75;

/** The asset-marker family prefix. Evrmore = 'evr', Ravencoin = 'rvn'. */
export type AssetMarkerPrefix = 'evr' | 'rvn';

/** Default marker prefix, so pre-existing (Evrmore-only) callers/tests keep the
 *  exact same behavior without passing an argument. */
export const DEFAULT_MARKER_PREFIX: AssetMarkerPrefix = 'evr';

/** The 4-byte transfer marker string for a prefix, e.g. 'evr' -> "evrt". */
function transferMarker(prefix: AssetMarkerPrefix): string {
  return `${prefix}t`;
}

/** Map a prefix's four markers to their kinds (transfer/issue/reissue/owner). */
function markerToKind(prefix: AssetMarkerPrefix): Record<string, AssetTransfer['kind']> {
  return {
    [`${prefix}t`]: 'transfer',
    [`${prefix}q`]: 'issue',
    [`${prefix}r`]: 'reissue',
    [`${prefix}o`]: 'owner',
  };
}

const MAX_UINT64 = (1n << 64n) - 1n;

export interface AssetTransfer {
  kind: 'transfer' | 'issue' | 'reissue' | 'owner';
  name: string;
  /** amount in sats (integer, 8 implied decimals). */
  amount: bigint;
}

export interface DecodedAssetScript {
  p2pkhHash160: Uint8Array;
  transfer: AssetTransfer;
  /** Which marker family the on-chain script actually used (so callers can
   *  bind/reject by chain — e.g. verifyUtxo fails closed on a family mismatch). */
  markerPrefix: AssetMarkerPrefix;
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
 *   P2PKH(25) + 0xc0 + pushlen + <marker> + nameLen(1) + nameBytes + amount(8 LE) + 0x75
 * where <marker> is the chain's transfer marker ("evrt" for Evrmore, "rvnt" for
 * Ravencoin) and pushlen = 4 + 1 + name.length + 8 (blob length, excluding OP_DROP).
 * `markerPrefix` defaults to 'evr' so pre-existing callers keep byte-identical output.
 */
export function buildTransferAssetScriptFromHash160(
  hash160: Uint8Array,
  assetName: string,
  amountSats: bigint,
  markerPrefix: AssetMarkerPrefix = DEFAULT_MARKER_PREFIX,
): Uint8Array {
  if (!(hash160 instanceof Uint8Array) || hash160.length !== 20) {
    throw new Error(`hash160 must be 20 bytes, got ${hash160?.length ?? 'n/a'}`);
  }
  const name = assetNameBytes(assetName);
  const amount = amountLE(amountSats);

  const p2pkh = p2pkhScript(hash160);
  const marker = markerBytes(transferMarker(markerPrefix));

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
  markerPrefix: AssetMarkerPrefix = DEFAULT_MARKER_PREFIX,
): Uint8Array {
  const { hash } = addressToHash160(address);
  return buildTransferAssetScriptFromHash160(hash, assetName, amountSats, markerPrefix);
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

/**
 * Decode an asset scriptPubKey for ONE marker family.
 *
 * Parses the standard P2PKH prefix, locates OP_x_ASSET (0xc0), reads the push
 * length, the 4-byte marker, the asset name, and the 8-byte little-endian amount
 * (plus divisions/reissuable for reissue), and verifies the trailing OP_DROP.
 *
 * `markerPrefix` scopes which family is accepted (defaults to 'evr' so existing
 * callers are unchanged). A well-formed asset script whose marker belongs to a
 * DIFFERENT family (e.g. an "evrt" script decoded with prefix 'rvn') returns null
 * — this is the fail-closed hook the send path relies on to reject a prevout from
 * the wrong chain. Returns { p2pkhHash160, transfer, markerPrefix } or null if
 * `script` is not an asset script of this family (e.g. a plain P2PKH output).
 */
export function decodeAssetScript(
  script: Uint8Array | string,
  markerPrefix: AssetMarkerPrefix = DEFAULT_MARKER_PREFIX,
): DecodedAssetScript | null {
  const bytes = typeof script === 'string' ? hexToBytes(script.trim()) : script;
  const markerToKindMap = markerToKind(markerPrefix);

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
  const kind = markerToKindMap[marker];
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
    return { p2pkhHash160, transfer: { kind, name, amount: 0n }, markerPrefix };
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

  return { p2pkhHash160, transfer: { kind, name, amount }, markerPrefix };
}
