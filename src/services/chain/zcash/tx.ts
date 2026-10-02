// Zcash transaction parsing (v1 to v6) and transparent-only v5/v6
// serialization (design docs/design/zcash-engine.md §4.2, §4.3, §6.3).
//
// v5 transparent-only layout (ZIP-225), little-endian throughout:
//
//   header u32 = 0x80000005 | nVersionGroupId u32 = 0x26A7270A
//   nConsensusBranchId u32   | lock_time u32 | nExpiryHeight u32
//   compactSize tx_in_count,  per input: prevout txid (32, internal order)
//                             + index u32 + compactSize scriptSig + nSequence u32
//   compactSize tx_out_count, per output: int64 value + compactSize script
//   00 nSpendsSapling | 00 nOutputsSapling | 00 nActionsOrchard
//
// v6 (ZIP-229) differs for a transparent-only transaction only in the header
// (0x80000006), the version group (0xD884B698) and one trailing 00
// (nActionsIronwood).
//
// The parser reads v5 and v6 completely, shielded bundles included, because
// the ZIP-244 txid commits to them; v1 to v4 are read up to the transparent
// part and expiry, since their txid is SHA256d of the raw bytes. A version
// the parser does not know (librustzcash already has a v7 group) comes back
// as version 'unknown' with an empty txid instead of throwing, so one odd row
// never fails a history refresh. Malformed bytes of a KNOWN version throw
// ZcashTxParseError: that is corrupt data, not a new format.

import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { compactSize, i64le, u32le, varBytes, zcashTxDigests, zcashTxid } from './sighash';

export const ZCASH_V5_HEADER = 0x80000005;
export const ZCASH_V5_VERSION_GROUP_ID = 0x26a7270a;
export const ZCASH_V6_HEADER = 0x80000006;
export const ZCASH_V6_VERSION_GROUP_ID = 0xd884b698;
export const ZCASH_SEQUENCE_FINAL = 0xffffffff;

export interface ZcashTxIn {
  /** 32 bytes, internal byte order (the reverse of the displayed txid). */
  prevTxid: Uint8Array;
  prevIndex: number;
  scriptSig: Uint8Array;
  sequence: number;
}

export interface ZcashTxOut {
  value: bigint;
  script: Uint8Array;
}

export interface ZcashSaplingSpend {
  cv: Uint8Array;
  nf: Uint8Array;
  rk: Uint8Array;
}

export interface ZcashSaplingOutput {
  cv: Uint8Array;
  cmu: Uint8Array;
  epk: Uint8Array;
  /** 580-byte encCiphertext. */
  enc: Uint8Array;
  /** 80-byte outCiphertext. */
  out: Uint8Array;
}

export interface ZcashSaplingBundle {
  spends: ZcashSaplingSpend[];
  outputs: ZcashSaplingOutput[];
  valueBalance: bigint;
  anchor: Uint8Array | null;
  spendProofs: Uint8Array;
  spendAuthSigs: Uint8Array;
  outputProofs: Uint8Array;
  bindingSig: Uint8Array | null;
}

export interface ZcashOrchardAction {
  cv: Uint8Array;
  nf: Uint8Array;
  rk: Uint8Array;
  cmx: Uint8Array;
  epk: Uint8Array;
  enc: Uint8Array;
  out: Uint8Array;
}

/** An Orchard bundle, or (v6) an Ironwood bundle, which has the same shape. */
export interface ZcashOrchardBundle {
  actions: ZcashOrchardAction[];
  flags: number;
  valueBalance: bigint;
  anchor: Uint8Array | null;
  proofs: Uint8Array;
  spendAuthSigs: Uint8Array[];
  bindingSig: Uint8Array | null;
}

export interface ZcashParsedTx {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 'unknown';
  header: number;
  /** 0 for v1 and v2 (not overwintered). */
  versionGroupId: number;
  /** In the transaction only from v5; 0 for v1 to v4 and for 'unknown'. */
  branchId: number;
  lockTime: number;
  /** 0 for v1 and v2. */
  expiryHeight: number;
  vin: ZcashTxIn[];
  vout: ZcashTxOut[];
  coinbase: boolean;
  /** Display-order hex. Empty string for version 'unknown'. */
  txid: string;
  raw: Uint8Array;
  /** v5/v6 only. */
  sapling?: ZcashSaplingBundle;
  /** v5/v6 only. */
  orchard?: ZcashOrchardBundle;
  /** v6 only. */
  ironwood?: ZcashOrchardBundle;
  /** v5/v6 only: the ZIP-244 auth digest, hex (internal order). */
  authDigest?: string;
}

export class ZcashTxParseError extends Error {
  constructor(message: string) {
    super(`zcash: ${message}`);
    this.name = 'ZcashTxParseError';
  }
}

class Reader {
  private p = 0;
  private readonly dv: DataView;
  constructor(private readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  bytes(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || this.p + n > this.b.length) throw new ZcashTxParseError('transaction is truncated');
    const r = this.b.slice(this.p, this.p + n);
    this.p += n;
    return r;
  }
  u8(): number {
    return this.bytes(1)[0];
  }
  u32(): number {
    const b = this.bytes(4);
    return new DataView(b.buffer).getUint32(0, true);
  }
  i64(): bigint {
    const b = this.bytes(8);
    return new DataView(b.buffer).getBigInt64(0, true);
  }
  /** Canonical compactSize, bounded by the bytes left (every counted item is at least one byte). */
  cs(): number {
    const f = this.u8();
    let v: number;
    if (f < 0xfd) return f;
    if (f === 0xfd) {
      if (this.p + 2 > this.b.length) throw new ZcashTxParseError('transaction is truncated');
      v = this.dv.getUint16(this.p, true);
      this.p += 2;
      if (v < 0xfd) throw new ZcashTxParseError('non-canonical compactSize');
    } else if (f === 0xfe) {
      v = this.u32();
      if (v <= 0xffff) throw new ZcashTxParseError('non-canonical compactSize');
    } else {
      throw new ZcashTxParseError('compactSize too large');
    }
    if (v > this.b.length - this.p) throw new ZcashTxParseError('count larger than the transaction');
    return v;
  }
  vb(): Uint8Array {
    return this.bytes(this.cs());
  }
  done(): boolean {
    return this.p === this.b.length;
  }
}

function readTransparent(r: Reader): { vin: ZcashTxIn[]; vout: ZcashTxOut[] } {
  const vin: ZcashTxIn[] = [];
  const vout: ZcashTxOut[] = [];
  const nin = r.cs();
  for (let i = 0; i < nin; i++) {
    vin.push({ prevTxid: r.bytes(32), prevIndex: r.u32(), scriptSig: r.vb(), sequence: r.u32() });
  }
  const nout = r.cs();
  for (let i = 0; i < nout; i++) vout.push({ value: r.i64(), script: r.vb() });
  return { vin, vout };
}

function readOrchardLike(r: Reader, count: number): ZcashOrchardBundle {
  const actions: ZcashOrchardAction[] = [];
  for (let i = 0; i < count; i++) {
    actions.push({
      cv: r.bytes(32),
      nf: r.bytes(32),
      rk: r.bytes(32),
      cmx: r.bytes(32),
      epk: r.bytes(32),
      enc: r.bytes(580),
      out: r.bytes(80),
    });
  }
  if (count === 0) {
    return { actions, flags: 0, valueBalance: 0n, anchor: null, proofs: new Uint8Array(0), spendAuthSigs: [], bindingSig: null };
  }
  const flags = r.u8();
  const valueBalance = r.i64();
  const anchor = r.bytes(32);
  const proofs = r.vb();
  const spendAuthSigs: Uint8Array[] = [];
  for (let i = 0; i < count; i++) spendAuthSigs.push(r.bytes(64));
  return { actions, flags, valueBalance, anchor, proofs, spendAuthSigs, bindingSig: r.bytes(64) };
}

function readSapling(r: Reader): ZcashSaplingBundle {
  const ns = r.cs();
  const spends: ZcashSaplingSpend[] = [];
  for (let i = 0; i < ns; i++) spends.push({ cv: r.bytes(32), nf: r.bytes(32), rk: r.bytes(32) });
  const no = r.cs();
  const outputs: ZcashSaplingOutput[] = [];
  for (let i = 0; i < no; i++) {
    outputs.push({ cv: r.bytes(32), cmu: r.bytes(32), epk: r.bytes(32), enc: r.bytes(580), out: r.bytes(80) });
  }
  const valueBalance = ns + no > 0 ? r.i64() : 0n;
  const anchor = ns > 0 ? r.bytes(32) : null;
  const spendProofs = r.bytes(192 * ns);
  const spendAuthSigs = r.bytes(64 * ns);
  const outputProofs = r.bytes(192 * no);
  const bindingSig = ns + no > 0 ? r.bytes(64) : null;
  return { spends, outputs, valueBalance, anchor, spendProofs, spendAuthSigs, outputProofs, bindingSig };
}

export function isCoinbaseInputs(vin: readonly ZcashTxIn[]): boolean {
  return vin.length === 1 && vin[0].prevIndex === 0xffffffff && vin[0].prevTxid.every((b) => b === 0);
}

function unknownTx(raw: Uint8Array, header: number): ZcashParsedTx {
  return {
    version: 'unknown',
    header,
    versionGroupId: 0,
    branchId: 0,
    lockTime: 0,
    expiryHeight: 0,
    vin: [],
    vout: [],
    coinbase: false,
    txid: '',
    raw,
  };
}

/**
 * Parses a raw transaction of any version. Never throws on an unrecognised
 * version (it returns version 'unknown'); throws ZcashTxParseError on
 * truncated, trailing or otherwise malformed bytes of a known version.
 */
export function parseZcashTx(raw: Uint8Array): ZcashParsedTx {
  if (!(raw instanceof Uint8Array)) throw new ZcashTxParseError('raw transaction must be bytes');
  const bytes = Uint8Array.from(raw);
  const r = new Reader(bytes);
  const header = r.u32();
  const overwintered = header >>> 31 === 1;
  const v = header & 0x7fffffff;

  if ((!overwintered && (v === 1 || v === 2)) || (overwintered && (v === 3 || v === 4))) {
    const versionGroupId = overwintered ? r.u32() : 0;
    const { vin, vout } = readTransparent(r);
    const lockTime = r.u32();
    const expiryHeight = overwintered ? r.u32() : 0;
    const tx: ZcashParsedTx = {
      version: v as 1 | 2 | 3 | 4,
      header,
      versionGroupId,
      branchId: 0,
      lockTime,
      expiryHeight,
      vin,
      vout,
      coinbase: isCoinbaseInputs(vin),
      txid: '',
      raw: bytes,
    };
    tx.txid = zcashTxid(tx);
    return tx;
  }

  if (!overwintered || (v !== 5 && v !== 6)) return unknownTx(bytes, header);
  const versionGroupId = r.u32();
  if (versionGroupId !== (v === 5 ? ZCASH_V5_VERSION_GROUP_ID : ZCASH_V6_VERSION_GROUP_ID)) return unknownTx(bytes, header);

  const branchId = r.u32();
  const lockTime = r.u32();
  const expiryHeight = r.u32();
  const { vin, vout } = readTransparent(r);
  const sapling = readSapling(r);
  const orchard = readOrchardLike(r, r.cs());
  const ironwood = v === 6 ? readOrchardLike(r, r.cs()) : undefined;
  if (!r.done()) throw new ZcashTxParseError('trailing bytes after the transaction');
  const tx: ZcashParsedTx = {
    version: v,
    header,
    versionGroupId,
    branchId,
    lockTime,
    expiryHeight,
    vin,
    vout,
    coinbase: isCoinbaseInputs(vin),
    txid: '',
    raw: bytes,
    sapling,
    orchard,
    ...(ironwood ? { ironwood } : {}),
  };
  const d = zcashTxDigests(tx);
  tx.txid = bytesToHex(d.txid.slice().reverse());
  tx.authDigest = bytesToHex(d.auth);
  return tx;
}

export type ZcashSerializableTx = Omit<ZcashParsedTx, 'txid' | 'raw' | 'version' | 'coinbase'>;

function hasShielded(tx: ZcashSerializableTx): boolean {
  const s = tx.sapling;
  return (
    (s !== undefined && s.spends.length + s.outputs.length > 0) ||
    (tx.orchard !== undefined && tx.orchard.actions.length > 0) ||
    (tx.ironwood !== undefined && tx.ironwood.actions.length > 0)
  );
}

/**
 * Serializes a TRANSPARENT-ONLY v5 (default) or v6 transaction. The header
 * and version group must match the chosen version; a transaction carrying
 * any shielded part is refused (this wallet never builds one).
 */
export function serializeV5(tx: ZcashSerializableTx, version: 5 | 6 = 5): Uint8Array {
  const header = version === 6 ? ZCASH_V6_HEADER : ZCASH_V5_HEADER;
  const group = version === 6 ? ZCASH_V6_VERSION_GROUP_ID : ZCASH_V5_VERSION_GROUP_ID;
  if (tx.header !== header || tx.versionGroupId !== group) {
    throw new Error(`zcash: header and version group do not match a v${version} transaction`);
  }
  if (hasShielded(tx)) throw new Error('zcash: only transparent-only transactions are serialized');
  if (tx.branchId === 0) throw new Error('zcash: consensus branch id is missing');
  const parts: Uint8Array[] = [
    u32le(header),
    u32le(group),
    u32le(tx.branchId),
    u32le(tx.lockTime),
    u32le(tx.expiryHeight),
    compactSize(tx.vin.length),
  ];
  for (const i of tx.vin) {
    if (i.prevTxid.length !== 32) throw new Error('zcash: prevout txid must be 32 bytes');
    parts.push(i.prevTxid, u32le(i.prevIndex), varBytes(i.scriptSig), u32le(i.sequence));
  }
  parts.push(compactSize(tx.vout.length));
  for (const o of tx.vout) {
    if (o.value < 0n) throw new Error('zcash: output value is negative');
    parts.push(i64le(o.value), varBytes(o.script));
  }
  // nSpendsSapling, nOutputsSapling, nActionsOrchard (+ nActionsIronwood for v6).
  parts.push(version === 6 ? Uint8Array.of(0, 0, 0, 0) : Uint8Array.of(0, 0, 0));
  return concatBytes(...parts);
}
