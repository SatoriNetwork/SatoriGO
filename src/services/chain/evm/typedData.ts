// EIP-712 typed data (eth_signTypedData_v4): hashing and signing.
//
// A website asks the wallet to sign a structured message (a login, a permit, an
// order). The signature is over keccak256(0x19 0x01 || domainSeparator ||
// hashStruct(message)), so it can never be replayed as a transaction, but it CAN
// authorise a contract to move tokens (an ERC-20 permit), which is why the
// approval screen shows the domain and the message in full.
//
// Encoding follows the EIP-712 spec and MetaMask's v4 (arrays and nested
// structs supported). Anything this module cannot encode exactly is REFUSED with
// a TypedDataError instead of guessed: a wrong hash would be a signature over
// something the user never saw.
//
// Pure and synchronous, no Node APIs, so it runs in the approval page as is.

import * as secp256k1 from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

// Synchronous signing needs this RFC6979 hook (the same one keys.ts and tx.ts set).
secp256k1.etc.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]): Uint8Array =>
  hmac(sha256, key, concatBytes(...msgs));

export class TypedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypedDataError';
  }
}

export interface TypedDataField {
  name: string;
  type: string;
}

export interface TypedData {
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

/** The domain fields in the order EIP-712 defines them, used when a site leaves
 *  EIP712Domain out of `types` (ethers and viem derive it the same way). */
const DOMAIN_FIELDS: readonly TypedDataField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
];

/** Parse what a site passed (a JSON string, or an object) into TypedData, or
 *  throw. Checks the shape only; encoding checks every value. */
export function parseTypedData(input: unknown): TypedData {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new TypedDataError('The typed data is not valid JSON.');
    }
  }
  if (!raw || typeof raw !== 'object') throw new TypedDataError('The typed data must be an object.');
  const t = raw as Partial<TypedData>;
  if (!t.types || typeof t.types !== 'object') throw new TypedDataError('The typed data has no types.');
  if (typeof t.primaryType !== 'string' || !t.primaryType) throw new TypedDataError('The typed data has no primaryType.');
  if (!t.domain || typeof t.domain !== 'object') throw new TypedDataError('The typed data has no domain.');
  if (t.primaryType !== 'EIP712Domain' && (!t.message || typeof t.message !== 'object')) {
    throw new TypedDataError('The typed data has no message.');
  }
  const types: Record<string, TypedDataField[]> = {};
  for (const [name, fields] of Object.entries(t.types)) {
    if (!Array.isArray(fields)) throw new TypedDataError(`Type ${name} is not a field list.`);
    types[name] = fields.map((f) => {
      if (!f || typeof f.name !== 'string' || typeof f.type !== 'string') {
        throw new TypedDataError(`Type ${name} has a malformed field.`);
      }
      return { name: f.name, type: f.type };
    });
  }
  if (!types.EIP712Domain) {
    types.EIP712Domain = DOMAIN_FIELDS.filter((f) => t.domain![f.name] !== undefined);
  }
  if (t.primaryType !== 'EIP712Domain' && !types[t.primaryType]) {
    throw new TypedDataError(`The primary type ${t.primaryType} is not defined.`);
  }
  return {
    types,
    primaryType: t.primaryType,
    domain: t.domain as Record<string, unknown>,
    message: (t.message ?? {}) as Record<string, unknown>,
  };
}

/** `Foo[]` or `Foo[3]` -> { base: 'Foo', length: undefined | 3 }, else null. */
function arrayType(type: string): { base: string; length?: number } | null {
  const m = /^(.*)\[(\d*)\]$/.exec(type);
  if (!m) return null;
  return { base: m[1], length: m[2] === '' ? undefined : Number(m[2]) };
}

/** Every struct type `primary` depends on (itself first). */
function dependencies(primary: string, types: Record<string, TypedDataField[]>, found = new Set<string>()): Set<string> {
  const base = arrayType(primary)?.base ?? primary;
  if (found.has(base) || !types[base]) return found;
  found.add(base);
  for (const f of types[base]) dependencies(f.type, types, found);
  return found;
}

/** e.g. `Mail(Person from,Person to,string contents)Person(string name,address wallet)`. */
export function encodeType(primary: string, types: Record<string, TypedDataField[]>): string {
  const deps = [...dependencies(primary, types)].filter((d) => d !== primary).sort();
  return [primary, ...deps].map((name) => `${name}(${types[name].map((f) => `${f.type} ${f.name}`).join(',')})`).join('');
}

function typeHash(primary: string, types: Record<string, TypedDataField[]>): Uint8Array {
  return keccak_256(utf8ToBytes(encodeType(primary, types)));
}

function toBytes(value: unknown, what: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(value)) return hexToBytes(value.slice(2));
  throw new TypedDataError(`${what} must be 0x-prefixed hex bytes.`);
}

function toBigInt(value: unknown, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypedDataError(`${what} is not an exact integer.`);
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^-?0x[0-9a-fA-F]+$/.test(s)) return s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s);
    if (/^-?\d+$/.test(s)) return BigInt(s);
  }
  throw new TypedDataError(`${what} is not an integer.`);
}

function word(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function encodeValue(type: string, value: unknown, types: Record<string, TypedDataField[]>, path: string): Uint8Array {
  if (types[type]) {
    if (!value || typeof value !== 'object') throw new TypedDataError(`${path} must be a ${type} object.`);
    return hashStruct(type, value as Record<string, unknown>, types, path);
  }
  const arr = arrayType(type);
  if (arr) {
    if (!Array.isArray(value)) throw new TypedDataError(`${path} must be an array.`);
    if (arr.length !== undefined && value.length !== arr.length) {
      throw new TypedDataError(`${path} must have exactly ${arr.length} items.`);
    }
    return keccak_256(concatBytes(...value.map((v, i) => encodeValue(arr.base, v, types, `${path}[${i}]`))));
  }
  if (type === 'string') {
    if (typeof value !== 'string') throw new TypedDataError(`${path} must be a string.`);
    return keccak_256(utf8ToBytes(value));
  }
  if (type === 'bytes') return keccak_256(toBytes(value, path));
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new TypedDataError(`${path} must be true or false.`);
    return word(value ? 1n : 0n);
  }
  if (type === 'address') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new TypedDataError(`${path} must be a 20-byte 0x address.`);
    }
    return word(BigInt(value));
  }
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) {
    const size = Number(fixed[1]);
    if (size < 1 || size > 32) throw new TypedDataError(`${path} has an invalid type ${type}.`);
    const b = toBytes(value, path);
    if (b.length !== size) throw new TypedDataError(`${path} must be exactly ${size} bytes.`);
    const out = new Uint8Array(32);
    out.set(b);
    return out;
  }
  const int = /^(u?)int(\d*)$/.exec(type);
  if (int) {
    const unsigned = int[1] === 'u';
    const bits = int[2] === '' ? 256 : Number(int[2]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) throw new TypedDataError(`${path} has an invalid type ${type}.`);
    const n = toBigInt(value, path);
    const min = unsigned ? 0n : -(1n << BigInt(bits - 1));
    const max = unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
    if (n < min || n > max) throw new TypedDataError(`${path} is out of range for ${type}.`);
    return word(n < 0n ? (1n << 256n) + n : n);
  }
  throw new TypedDataError(`${path} has an unsupported type ${type}.`);
}

/** hashStruct(s) = keccak256(typeHash || encodeData(s)). */
export function hashStruct(
  primary: string,
  data: Record<string, unknown>,
  types: Record<string, TypedDataField[]>,
  path = primary,
): Uint8Array {
  const fields = types[primary];
  if (!fields) throw new TypedDataError(`Type ${primary} is not defined.`);
  const parts = [typeHash(primary, types)];
  for (const f of fields) {
    const v = data[f.name];
    if (v === undefined || v === null) throw new TypedDataError(`${path}.${f.name} is missing.`);
    parts.push(encodeValue(f.type, v, types, `${path}.${f.name}`));
  }
  return keccak_256(concatBytes(...parts));
}

/** The 32-byte digest the wallet signs. */
export function typedDataDigest(data: TypedData): Uint8Array {
  const domainSeparator = hashStruct('EIP712Domain', data.domain, data.types, 'domain');
  const parts = [new Uint8Array([0x19, 0x01]), domainSeparator];
  if (data.primaryType !== 'EIP712Domain') {
    parts.push(hashStruct(data.primaryType, data.message, data.types, 'message'));
  }
  return keccak_256(concatBytes(...parts));
}

/** The domain's chainId as a number, or null when the domain names none. */
export function typedDataChainId(data: TypedData): number | null {
  if (data.domain.chainId === undefined || data.domain.chainId === null) return null;
  const n = toBigInt(data.domain.chainId, 'domain.chainId');
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(n);
}

/** Sign typed data: 0x + r || s || v (v 27/28, low s), the form every dApp
 *  library recovers. The caller owns `privateKey` and zeroes it. */
export function signTypedData(data: TypedData, privateKey: Uint8Array): string {
  const sig = secp256k1.sign(typedDataDigest(data), privateKey, { lowS: true });
  return `0x${bytesToHex(sig.toCompactRawBytes())}${(27 + sig.recovery).toString(16)}`;
}
