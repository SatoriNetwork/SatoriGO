// ZIP-244 transaction identifiers and signature digests for Zcash v5 and v6
// (design docs/design/zcash-engine.md §4.4), ported from the research
// prototype zec.mjs and pinned by the 62 checks of zcash-test-vectors
// zip_0244.json, the four Trezor-signed testnet transactions, and live
// mainnet v5/v6 transactions (sighash.test.ts, tx.test.ts).
//
// The txid of a v5 or v6 transaction is NOT SHA256d. It is BLAKE2b-256 under
// the personalization "ZcashTxHash_" || branchId (4 bytes LE) over the header,
// transparent, Sapling and Orchard digests (v6 adds the Ironwood digest and
// the ZIP-229 "_v6" personalizations). v1 to v4 transactions still use
// SHA256d of the raw bytes.
//
// The signature digest for a transparent input (ZIP-244 S.2) commits to the
// amounts and scriptPubKeys of EVERY input being spent, so the signer must be
// handed the coins (value + script) in input order.
//
// Every BLAKE2b personalization here is 16 bytes exactly; pers() refuses any
// other length, so a typo cannot silently hash under a different domain.
//
// Pure TS on @noble/hashes (blake2b with personalization, sha256). This
// module also owns the little-endian and compactSize encoders tx.ts uses, so
// that tx.ts -> sighash.ts is the only import direction (no runtime cycle).

import { blake2b } from '@noble/hashes/blake2b';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import type { ZcashOrchardBundle, ZcashParsedTx, ZcashSaplingBundle } from './tx';

export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_ANYONECANPAY = 0x80;
/** The only hash types ZIP-244 accepts for a transparent input. */
export const ZCASH_VALID_HASH_TYPES: readonly number[] = Object.freeze([0x01, 0x02, 0x03, 0x81, 0x82, 0x83]);

// ---------------------------------------------------------------- encoders

const te = new TextEncoder();

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`zcash: ${n} is not a uint32`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function i64le(n: bigint): Uint8Array {
  if (typeof n !== 'bigint' || n < -(1n << 63n) || n >= 1n << 63n) throw new Error('zcash: value is not an int64');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
}

export function compactSize(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('zcash: compactSize must be a non-negative integer');
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  if (n <= 0xffffffff) return concatBytes(Uint8Array.of(0xfe), u32le(n));
  throw new Error('zcash: compactSize too large');
}

/** compactSize length prefix || bytes. */
export function varBytes(b: Uint8Array): Uint8Array {
  return concatBytes(compactSize(b.length), b);
}

export function sha256d(b: Uint8Array): Uint8Array {
  return sha256(sha256(b));
}

/** Internal byte order -> display-order (reversed) lowercase hex. */
export function displayHex(internal: Uint8Array): string {
  return bytesToHex(Uint8Array.from(internal).reverse());
}

// ---------------------------------------------------------------- BLAKE2b

const persCache = new Map<string, Uint8Array>();
function pers(s: string): Uint8Array {
  let p = persCache.get(s);
  if (!p) {
    p = te.encode(s);
    if (p.length !== 16) throw new Error(`zcash: personalization must be 16 bytes: ${s}`);
    persCache.set(s, p);
  }
  return p;
}

function branchPers(prefix: 'ZcashTxHash_' | 'ZTxAuthHash_', branchId: number): Uint8Array {
  return concatBytes(te.encode(prefix), u32le(branchId));
}

/** BLAKE2b-256 under a 16-byte personalization over the concatenated parts. */
function H(personal: string | Uint8Array, ...data: Uint8Array[]): Uint8Array {
  const personalization = typeof personal === 'string' ? pers(personal) : personal;
  if (personalization.length !== 16) throw new Error('zcash: personalization must be 16 bytes');
  return blake2b(concatBytes(...data), { dkLen: 32, personalization });
}

// ---------------------------------------------------------------- digests

type DigestTx = Pick<
  ZcashParsedTx,
  'version' | 'header' | 'versionGroupId' | 'branchId' | 'lockTime' | 'expiryHeight' | 'vin' | 'vout' | 'sapling' | 'orchard' | 'ironwood'
>;

function assertV5orV6(tx: DigestTx): void {
  if (tx.version !== 5 && tx.version !== 6) {
    throw new Error(`zcash: ZIP-244 digests apply to v5 and v6 transactions only (got v${String(tx.version)})`);
  }
}

function headerDigest(tx: DigestTx): Uint8Array {
  return H(
    'ZTxIdHeadersHash',
    u32le(tx.header),
    u32le(tx.versionGroupId),
    u32le(tx.branchId),
    u32le(tx.lockTime),
    u32le(tx.expiryHeight),
  );
}

const prevoutsDigest = (tx: DigestTx) =>
  H('ZTxIdPrevoutHash', ...tx.vin.map((i) => concatBytes(i.prevTxid, u32le(i.prevIndex))));
const sequenceDigest = (tx: DigestTx) => H('ZTxIdSequencHash', ...tx.vin.map((i) => u32le(i.sequence)));
const outputsDigest = (tx: DigestTx) =>
  H('ZTxIdOutputsHash', ...tx.vout.map((o) => concatBytes(i64le(o.value), varBytes(o.script))));

/** T.2: the transparent digest of the txid tree. */
function transparentDigest(tx: DigestTx): Uint8Array {
  if (tx.vin.length + tx.vout.length === 0) return H('ZTxIdTranspaHash');
  return H('ZTxIdTranspaHash', prevoutsDigest(tx), sequenceDigest(tx), outputsDigest(tx));
}

function saplingDigest(s: ZcashSaplingBundle | undefined, v6: boolean): Uint8Array {
  if (!s || s.spends.length + s.outputs.length === 0) return H('ZTxIdSaplingHash');
  const anchor = s.anchor ?? new Uint8Array(32);
  const spendsD =
    s.spends.length === 0
      ? H('ZTxIdSSpendsHash')
      : H(
          'ZTxIdSSpendsHash',
          H('ZTxIdSSpendCHash', ...s.spends.map((x) => x.nf)),
          v6
            ? H('ZTxIdSSpendNH_v6', ...s.spends.map((x) => concatBytes(x.cv, x.rk)))
            : H('ZTxIdSSpendNHash', ...s.spends.map((x) => concatBytes(x.cv, anchor, x.rk))),
        );
  const outsD =
    s.outputs.length === 0
      ? H('ZTxIdSOutputHash')
      : H(
          'ZTxIdSOutputHash',
          H('ZTxIdSOutC__Hash', ...s.outputs.map((o) => concatBytes(o.cmu, o.epk, o.enc.subarray(0, 52)))),
          H('ZTxIdSOutM__Hash', ...s.outputs.map((o) => o.enc.subarray(52, 564))),
          H('ZTxIdSOutN__Hash', ...s.outputs.map((o) => concatBytes(o.cv, o.enc.subarray(564), o.out))),
        );
  return H('ZTxIdSaplingHash', spendsD, outsD, i64le(s.valueBalance));
}

interface OrchardPers {
  top: string;
  c: string;
  m: string;
  n: string;
}
const ORCH_V5: OrchardPers = { top: 'ZTxIdOrchardHash', c: 'ZTxIdOrcActCHash', m: 'ZTxIdOrcActMHash', n: 'ZTxIdOrcActNHash' };
const ORCH_V6: OrchardPers = { top: 'ZTxIdOrchardH_v6', c: 'ZTxIdOrcActCHash', m: 'ZTxIdOrcActMHash', n: 'ZTxIdOrcActNHash' };
const IRON_V6: OrchardPers = { top: 'ZTxIdIronwd_H_v6', c: 'ZTxIdIrnActCH_v6', m: 'ZTxIdIrnActMH_v6', n: 'ZTxIdIrnActNH_v6' };

function orchardLikeDigest(b: ZcashOrchardBundle | undefined, p: OrchardPers, withAnchor: boolean): Uint8Array {
  if (!b || b.actions.length === 0) return H(p.top);
  return H(
    p.top,
    H(p.c, ...b.actions.map((a) => concatBytes(a.nf, a.cmx, a.epk, a.enc.subarray(0, 52)))),
    H(p.m, ...b.actions.map((a) => a.enc.subarray(52, 564))),
    H(p.n, ...b.actions.map((a) => concatBytes(a.cv, a.rk, a.enc.subarray(564), a.out))),
    Uint8Array.of(b.flags),
    i64le(b.valueBalance),
    ...(withAnchor ? [b.anchor ?? new Uint8Array(32)] : []),
  );
}

function shieldedDigests(tx: DigestTx): Uint8Array[] {
  const v6 = tx.version === 6;
  const out = [saplingDigest(tx.sapling, v6), orchardLikeDigest(tx.orchard, v6 ? ORCH_V6 : ORCH_V5, !v6)];
  if (v6) out.push(orchardLikeDigest(tx.ironwood, IRON_V6, false));
  return out;
}

function authDigest(tx: DigestTx): Uint8Array {
  const v6 = tx.version === 6;
  const s = tx.sapling;
  const tAuth =
    tx.vin.length === 0 ? H('ZTxAuthTransHash') : H('ZTxAuthTransHash', ...tx.vin.map((i) => varBytes(i.scriptSig)));
  const sPers = v6 ? 'ZTxAuthSapliH_v6' : 'ZTxAuthSapliHash';
  const sAuth =
    !s || s.spends.length + s.outputs.length === 0
      ? H(sPers)
      : H(
          sPers,
          s.spendProofs,
          s.spendAuthSigs,
          s.outputProofs,
          s.bindingSig ?? new Uint8Array(64),
          ...(v6 && s.spends.length ? [s.anchor ?? new Uint8Array(32)] : []),
        );
  const orchardAuth = (b: ZcashOrchardBundle | undefined, p: string) =>
    !b || b.actions.length === 0
      ? H(p)
      : H(p, b.proofs, ...b.spendAuthSigs, b.bindingSig ?? new Uint8Array(64), ...(v6 ? [b.anchor ?? new Uint8Array(32)] : []));
  const parts = [tAuth, sAuth, orchardAuth(tx.orchard, v6 ? 'ZTxAuthOrchaH_v6' : 'ZTxAuthOrchaHash')];
  if (v6) parts.push(orchardAuth(tx.ironwood, 'ZTxAuthIrnwdH_v6'));
  return H(branchPers('ZTxAuthHash_', tx.branchId), ...parts);
}

/** The raw 32-byte ZIP-244 txid digest and auth digest (internal byte order). */
export function zcashTxDigests(tx: DigestTx): { txid: Uint8Array; auth: Uint8Array } {
  assertV5orV6(tx);
  const txid = H(branchPers('ZcashTxHash_', tx.branchId), headerDigest(tx), transparentDigest(tx), ...shieldedDigests(tx));
  return { txid, auth: authDigest(tx) };
}

/**
 * Display-order txid: ZIP-244 for v5 and v6, SHA256d of the raw bytes for v1
 * to v4. Throws for an unrecognised version (there is no txid to compute).
 */
export function zcashTxid(tx: DigestTx & Pick<ZcashParsedTx, 'raw'>): string {
  if (tx.version === 5 || tx.version === 6) return displayHex(zcashTxDigests(tx).txid);
  if (tx.version === 1 || tx.version === 2 || tx.version === 3 || tx.version === 4) return displayHex(sha256d(tx.raw));
  throw new Error('zcash: cannot compute the txid of an unrecognised transaction version');
}

const isCoinbaseShape = (tx: DigestTx) =>
  tx.vin.length === 1 && tx.vin[0].prevIndex === 0xffffffff && tx.vin[0].prevTxid.every((b) => b === 0);

export interface ZcashCoin {
  value: bigint;
  script: Uint8Array;
}

/**
 * ZIP-244 signature digest (§4.10). `inputIndex` is the transparent input
 * being signed, or null for the digest Sapling and Orchard spends sign.
 * `coins` are the outputs being spent (value + scriptPubKey), one per input,
 * in input order.
 */
export function zcashSignatureDigest(
  tx: DigestTx,
  inputIndex: number | null,
  hashType: number,
  coins: readonly ZcashCoin[],
): Uint8Array {
  assertV5orV6(tx);
  let tDigest: Uint8Array;
  if (tx.vin.length === 0 || isCoinbaseShape(tx)) {
    if (inputIndex !== null) throw new Error('zcash: no transparent input to sign in this transaction');
    tDigest = transparentDigest(tx);
  } else {
    if (coins.length !== tx.vin.length) throw new Error('zcash: one spent coin per transparent input is required');
    if (inputIndex !== null && (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.vin.length)) {
      throw new Error(`zcash: input ${inputIndex} does not exist`);
    }
    const ht = inputIndex === null ? SIGHASH_ALL : hashType;
    if (!ZCASH_VALID_HASH_TYPES.includes(ht)) throw new Error(`zcash: hash type 0x${ht.toString(16)} is not valid under ZIP-244`);
    const acp = (ht & SIGHASH_ANYONECANPAY) !== 0;
    const base = ht & 0x1f;
    const prevouts = acp ? H('ZTxIdPrevoutHash') : prevoutsDigest(tx);
    const amounts = acp ? H('ZTxTrAmountsHash') : H('ZTxTrAmountsHash', ...coins.map((c) => i64le(c.value)));
    const scripts = acp ? H('ZTxTrScriptsHash') : H('ZTxTrScriptsHash', ...coins.map((c) => varBytes(c.script)));
    const sequences = acp ? H('ZTxIdSequencHash') : sequenceDigest(tx);
    let outs: Uint8Array;
    if (base !== SIGHASH_SINGLE && base !== SIGHASH_NONE) outs = outputsDigest(tx);
    else if (base === SIGHASH_SINGLE && inputIndex !== null && inputIndex < tx.vout.length) {
      const o = tx.vout[inputIndex];
      outs = H('ZTxIdOutputsHash', i64le(o.value), varBytes(o.script));
    } else outs = H('ZTxIdOutputsHash');
    const txin =
      inputIndex === null
        ? H('Zcash___TxInHash')
        : H(
            'Zcash___TxInHash',
            tx.vin[inputIndex].prevTxid,
            u32le(tx.vin[inputIndex].prevIndex),
            i64le(coins[inputIndex].value),
            varBytes(coins[inputIndex].script),
            u32le(tx.vin[inputIndex].sequence),
          );
    tDigest = H('ZTxIdTranspaHash', Uint8Array.of(ht), prevouts, amounts, scripts, sequences, outs, txin);
  }
  return H(branchPers('ZcashTxHash_', tx.branchId), headerDigest(tx), tDigest, ...shieldedDigests(tx));
}

/**
 * The 32-byte digest a transparent input's key signs (ZIP-244 S.2 wrapped in
 * the txid personalization). The builder signs it with SIGHASH_ALL.
 */
export function transparentSigDigest(
  tx: DigestTx,
  inputIndex: number,
  hashType: number,
  coins: readonly ZcashCoin[],
): Uint8Array {
  if (!Number.isInteger(inputIndex)) throw new Error('zcash: inputIndex must be an integer');
  return zcashSignatureDigest(tx, inputIndex, hashType, coins);
}
