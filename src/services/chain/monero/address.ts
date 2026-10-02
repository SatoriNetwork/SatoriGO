// Monero addresses: encode (primary, subaddress) and decode/validate
// (standard, subaddress, integrated) for all three networks.
//
// SAFETY-CRITICAL twice over. Encoding decides where the user's incoming money
// is told to go; decoding is the send form's refusal of a wrong destination
// before anything reaches the worker or the daemon (design §9: "a stagenet or
// malformed address is refused in the form, not by the daemon").
//
// Layout (cryptonote_basic_impl.cpp, get_account_address_as_str):
//   base58( varint(prefix) || spendPub(32) || viewPub(32) [|| paymentId(8)] || keccak256(all before)[0:4] )
// Every Monero prefix is below 0x80, so the varint is one byte, and the
// decoded payload is exactly 69 bytes (standard, subaddress) or 77
// (integrated). Anything else is refused.
//
// Subaddresses (device_default.cpp get_subaddress_secret_key /
// get_subaddress_spend_public_key / get_subaddress), for account i, index j,
// private view key a, public spend key B:
//   m = Hs("SubAddr\0" || a || le32(i) || le32(j))
//   D = B + m*G   (subaddress spend public key)
//   C = a*D       (subaddress view public key)
// (0,0) is not a subaddress: it is the primary address, prefix 18.
//
// Point validity on decode matches crypto::check_key: the 32 bytes must be the
// canonical encoding of a point on the curve (y < p, not x = 0 with the sign
// bit set). @noble/curves' strict (RFC 8032, non-ZIP215) decoding is exactly
// that. Like Monero, it does not demand a torsion-free point: refusing
// something monero-wallet-cli accepts would be a different rule, not a safer
// one, and the daemon's own checks stand behind it.

import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import { moneroBase58Decode, moneroBase58Encode } from './base58';
import { hashToScalar, scalarToBigInt, type MoneroKeys, type MoneroNetwork } from './keys';

export type MoneroAddressKind = 'standard' | 'subaddress' | 'integrated';

export interface DecodedMoneroAddress {
  net: MoneroNetwork;
  kind: MoneroAddressKind;
  spendPub: Uint8Array;
  viewPub: Uint8Array;
  /** Integrated addresses only: the 8-byte short payment id. */
  paymentId?: Uint8Array;
}

/** Address prefixes, cryptonote_config.h (CRYPTONOTE_PUBLIC_*_BASE58_PREFIX). */
export const MONERO_ADDRESS_PREFIXES: Readonly<Record<MoneroNetwork, Readonly<Record<MoneroAddressKind, number>>>> =
  Object.freeze({
    mainnet: Object.freeze({ standard: 18, subaddress: 42, integrated: 19 }),
    stagenet: Object.freeze({ standard: 24, subaddress: 36, integrated: 25 }),
    testnet: Object.freeze({ standard: 53, subaddress: 63, integrated: 54 }),
  });

const PREFIX_LOOKUP: ReadonlyMap<number, { net: MoneroNetwork; kind: MoneroAddressKind }> = new Map(
  (Object.keys(MONERO_ADDRESS_PREFIXES) as MoneroNetwork[]).flatMap((net) =>
    (Object.keys(MONERO_ADDRESS_PREFIXES[net]) as MoneroAddressKind[]).map(
      (kind) => [MONERO_ADDRESS_PREFIXES[net][kind], { net, kind }] as const,
    ),
  ),
);

const PAYMENT_ID_BYTES = 8;
const CHECKSUM_BYTES = 4;
const BODY_BYTES = 1 + 32 + 32;
const SUBADDR_DOMAIN = new Uint8Array([0x53, 0x75, 0x62, 0x41, 0x64, 0x64, 0x72, 0x00]); // "SubAddr\0"
const MAX_INDEX = 0xffffffff;

export class MoneroAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneroAddressError';
  }
}

function encode(prefix: number, spendPub: Uint8Array, viewPub: Uint8Array, paymentId?: Uint8Array): string {
  const extra = paymentId ? PAYMENT_ID_BYTES : 0;
  const body = new Uint8Array(BODY_BYTES + extra);
  body[0] = prefix;
  body.set(spendPub, 1);
  body.set(viewPub, 33);
  if (paymentId) body.set(paymentId, BODY_BYTES);
  const full = new Uint8Array(body.length + CHECKSUM_BYTES);
  full.set(body);
  full.set(keccak_256(body).subarray(0, CHECKSUM_BYTES), body.length);
  return moneroBase58Encode(full);
}

function assertPoint32(name: string, bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new MoneroAddressError(`${name} must be 32 bytes.`);
  }
}

/** The primary (standard) address: spendPub and viewPub, prefix 18 on mainnet. */
export function primaryAddress(
  keys: Pick<MoneroKeys, 'spendPub' | 'viewPub'>,
  net: MoneroNetwork = 'mainnet',
): string {
  assertPoint32('spendPub', keys.spendPub);
  assertPoint32('viewPub', keys.viewPub);
  return encode(MONERO_ADDRESS_PREFIXES[net].standard, keys.spendPub, keys.viewPub);
}

function le32(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function assertIndex(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_INDEX) {
    throw new MoneroAddressError(`${name} must be an integer in 0..${MAX_INDEX}.`);
  }
}

/**
 * The address for account `major`, index `minor`. (0,0) returns the primary
 * address. Needs the private view key: subaddresses cannot be computed from
 * public keys alone.
 *
 * Computing an address here does NOT tell the scanner about it. Anything shown
 * to the user as a receive address must come from the wallet host
 * (createSubaddress), which is what makes wallet2 look for it; this function
 * is for display checks and tests (design §4).
 */
export function subaddress(
  keys: Pick<MoneroKeys, 'viewSec' | 'spendPub'>,
  major: number,
  minor: number,
  net: MoneroNetwork = 'mainnet',
): string {
  assertIndex('major', major);
  assertIndex('minor', minor);
  assertPoint32('spendPub', keys.spendPub);
  if (!(keys.viewSec instanceof Uint8Array) || keys.viewSec.length !== 32) {
    throw new MoneroAddressError('viewSec must be 32 bytes.');
  }
  const a = scalarToBigInt(keys.viewSec);
  if (major === 0 && minor === 0) {
    return encode(MONERO_ADDRESS_PREFIXES[net].standard, keys.spendPub, ed25519.Point.BASE.multiply(a).toBytes());
  }
  const data = new Uint8Array(SUBADDR_DOMAIN.length + 32 + 8);
  data.set(SUBADDR_DOMAIN, 0);
  data.set(keys.viewSec, SUBADDR_DOMAIN.length);
  data.set(le32(major), SUBADDR_DOMAIN.length + 32);
  data.set(le32(minor), SUBADDR_DOMAIN.length + 36);
  const m = hashToScalar(data);
  data.fill(0);
  // m is uniformly distributed mod l; zero has probability ~2^-252, and noble's
  // multiply refuses it, which is the right outcome for that index.
  const D = ed25519.Point.fromBytes(keys.spendPub).add(ed25519.Point.BASE.multiply(scalarToBigInt(m)));
  m.fill(0);
  const C = D.multiply(a);
  return encode(MONERO_ADDRESS_PREFIXES[net].subaddress, D.toBytes(), C.toBytes());
}

function isCanonicalPoint(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes, false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode any Monero address on any network. Throws MoneroAddressError with a
 * user-facing message on: a character or length base58 refuses, an unknown
 * prefix, a payload of the wrong size for its kind, a bad checksum, or a key
 * that is not a valid curve point. The address is used exactly as given (no
 * trimming): the caller trims what the user typed.
 */
export function decodeMoneroAddress(address: string): DecodedMoneroAddress {
  if (typeof address !== 'string' || address.length === 0) {
    throw new MoneroAddressError('Enter a Monero address.');
  }
  let raw: Uint8Array;
  try {
    raw = moneroBase58Decode(address);
  } catch {
    throw new MoneroAddressError('This is not a Monero address.');
  }
  if (raw.length !== BODY_BYTES + CHECKSUM_BYTES && raw.length !== BODY_BYTES + PAYMENT_ID_BYTES + CHECKSUM_BYTES) {
    throw new MoneroAddressError('This is not a Monero address: wrong length.');
  }
  const found = PREFIX_LOOKUP.get(raw[0]);
  if (!found) throw new MoneroAddressError('This is not a Monero address: unknown prefix.');
  const expected = BODY_BYTES + (found.kind === 'integrated' ? PAYMENT_ID_BYTES : 0) + CHECKSUM_BYTES;
  if (raw.length !== expected) {
    throw new MoneroAddressError('This is not a Monero address: wrong length for its type.');
  }
  const body = raw.subarray(0, raw.length - CHECKSUM_BYTES);
  const checksum = raw.subarray(raw.length - CHECKSUM_BYTES);
  const want = keccak_256(body).subarray(0, CHECKSUM_BYTES);
  for (let i = 0; i < CHECKSUM_BYTES; i++) {
    if (want[i] !== checksum[i]) {
      throw new MoneroAddressError('This Monero address has a typo: the checksum does not match.');
    }
  }
  const spendPub = raw.slice(1, 33);
  const viewPub = raw.slice(33, 65);
  if (!isCanonicalPoint(spendPub) || !isCanonicalPoint(viewPub)) {
    throw new MoneroAddressError('This is not a valid Monero address: a key is not a valid point.');
  }
  const decoded: DecodedMoneroAddress = { net: found.net, kind: found.kind, spendPub, viewPub };
  if (found.kind === 'integrated') decoded.paymentId = raw.slice(BODY_BYTES, BODY_BYTES + PAYMENT_ID_BYTES);
  return decoded;
}

/**
 * True when `address` decodes and belongs to `net`.
 *
 * `net` defaults to MAINNET, not "any network": this is the send form's
 * check, and a stagenet or testnet address there is a destination that can
 * never receive real XMR. A caller that genuinely wants any network uses
 * decodeMoneroAddress and reads `.net`.
 */
export function isValidMoneroAddress(address: string, net: MoneroNetwork = 'mainnet'): boolean {
  try {
    return decodeMoneroAddress(address).net === net;
  } catch {
    return false;
  }
}

/**
 * Encode an integrated address (standard address + 8-byte payment id). The
 * wallet never hands one out; this exists so the decoder's integrated branch
 * is tested against an encoder and the published vectors.
 */
export function integratedAddress(
  keys: Pick<MoneroKeys, 'spendPub' | 'viewPub'>,
  paymentId: Uint8Array,
  net: MoneroNetwork = 'mainnet',
): string {
  assertPoint32('spendPub', keys.spendPub);
  assertPoint32('viewPub', keys.viewPub);
  if (!(paymentId instanceof Uint8Array) || paymentId.length !== PAYMENT_ID_BYTES) {
    throw new MoneroAddressError('A payment id is 8 bytes.');
  }
  return encode(MONERO_ADDRESS_PREFIXES[net].integrated, keys.spendPub, keys.viewPub, paymentId);
}
