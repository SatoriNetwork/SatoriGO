// ZIP-244 digests (design §4.4): the 62 checks of zcash-test-vectors
// zip_0244.json (10 txids, 10 auth digests, 10 shielded sighashes, 32
// transparent sighashes over every hash type), plus live mainnet v5 and v6
// P2PKH signatures verified under the NU6.3 branch.

import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  SIGHASH_ALL,
  compactSize,
  transparentSigDigest,
  zcashSignatureDigest,
  zcashTxDigests,
  zcashTxid,
  type ZcashCoin,
} from './sighash';
import { parseZcashTx } from './tx';
import zip244 from './testing/zip_0244.json';
import mainnet from './testing/mainnet_txs.json';

type Row = Record<string, unknown>;
const names = ((zip244 as unknown[])[1] as string[])[0].split(', ');
const rows: Row[] = ((zip244 as unknown[]).slice(2) as unknown[][]).map((r) =>
  Object.fromEntries(names.map((k, i) => [k, r[i]])),
);

const HASH_TYPES: Record<string, number> = {
  sighash_all: 0x01,
  sighash_none: 0x02,
  sighash_single: 0x03,
  sighash_all_anyone: 0x81,
  sighash_none_anyone: 0x82,
  sighash_single_anyone: 0x83,
};

function coinsOf(v: Row): ZcashCoin[] {
  return (v.amounts as number[]).map((a, i) => ({ value: BigInt(a), script: hexToBytes((v.script_pubkeys as string[])[i]) }));
}

describe('zip_0244.json (zcash-test-vectors)', () => {
  it('has the 10 vectors the design counts', () => {
    expect(rows).toHaveLength(10);
  });

  it('passes all 62 checks: txid, auth digest, shielded sighash, transparent sighashes', () => {
    let checks = 0;
    rows.forEach((v) => {
      const tx = parseZcashTx(hexToBytes(v.tx as string));
      const d = zcashTxDigests(tx);
      expect(bytesToHex(d.txid)).toBe(v.txid);
      expect(bytesToHex(d.auth)).toBe(v.auth_digest);
      expect(tx.authDigest).toBe(v.auth_digest);
      checks += 2;
      const coins = coinsOf(v);
      expect(bytesToHex(zcashSignatureDigest(tx, null, SIGHASH_ALL, coins))).toBe(v.sighash_shielded);
      checks += 1;
      if (v.transparent_input !== null) {
        const ti = v.transparent_input as number;
        for (const [key, ht] of Object.entries(HASH_TYPES)) {
          if (v[key] === null) continue;
          expect(bytesToHex(transparentSigDigest(tx, ti, ht, coins)), `${key} of input ${ti}`).toBe(v[key]);
          checks += 1;
        }
      }
    });
    expect(checks).toBe(62);
  });

  it('the vector txid (internal order) is the parser txid reversed', () => {
    for (const v of rows) {
      const tx = parseZcashTx(hexToBytes(v.tx as string));
      expect(tx.txid).toBe(bytesToHex(hexToBytes(v.txid as string).reverse()));
      expect(zcashTxid(tx)).toBe(tx.txid);
    }
  });
});

describe('live mainnet signatures verify under our digest (NU6.3, branch 37a5165b)', () => {
  for (const key of ['v5t', 'v6t'] as const) {
    const fx = (mainnet as unknown as Record<string, { txid: string; hex: string; branchId: string; coins: { value: string; script: string }[] }>)[key];
    it(`${key} ${fx.txid.slice(0, 12)}: every P2PKH input signature verifies`, () => {
      const tx = parseZcashTx(hexToBytes(fx.hex));
      expect(tx.txid).toBe(fx.txid);
      expect(tx.branchId.toString(16)).toBe(fx.branchId);
      const coins = fx.coins.map((c) => ({ value: BigInt(c.value), script: hexToBytes(c.script) }));
      expect(tx.vin.length).toBe(coins.length);
      tx.vin.forEach((inp, k) => {
        const ss = inp.scriptSig;
        const sigLen = ss[0];
        const sigAll = ss.subarray(1, 1 + sigLen);
        const pub = ss.subarray(2 + sigLen, 2 + sigLen + ss[1 + sigLen]);
        const hashType = sigAll[sigAll.length - 1];
        const digest = transparentSigDigest(tx, k, hashType, coins);
        const sig = secp256k1.Signature.fromDER(sigAll.subarray(0, -1));
        expect(secp256k1.verify(sig.toCompactRawBytes(), digest, pub, { lowS: false })).toBe(true);
        // And a digest under any other branch does not verify.
        const wrong = transparentSigDigest({ ...tx, branchId: 0x4dec4df0 }, k, hashType, coins);
        expect(secp256k1.verify(sig.toCompactRawBytes(), wrong, pub, { lowS: false })).toBe(false);
      });
    });
  }
});

describe('sighash guards', () => {
  const v5 = (mainnet as unknown as Record<string, { hex: string; coins: { value: string; script: string }[] }>).v5t;
  const tx = parseZcashTx(hexToBytes(v5.hex));
  const coins = v5.coins.map((c) => ({ value: BigInt(c.value), script: hexToBytes(c.script) }));

  it('refuses a hash type ZIP-244 does not define', () => {
    expect(() => transparentSigDigest(tx, 0, 0x00, coins)).toThrow(/hash type/);
    expect(() => transparentSigDigest(tx, 0, 0x04, coins)).toThrow(/hash type/);
    expect(() => transparentSigDigest(tx, 0, 0x41, coins)).toThrow(/hash type/);
  });

  it('needs one coin per input and an existing input', () => {
    expect(() => transparentSigDigest(tx, 0, SIGHASH_ALL, coins.slice(1))).toThrow(/one spent coin/);
    expect(() => transparentSigDigest(tx, tx.vin.length, SIGHASH_ALL, coins)).toThrow(/does not exist/);
  });

  it('commits to the amounts of every input (ZIP-244, unlike legacy)', () => {
    const base = bytesToHex(transparentSigDigest(tx, 0, SIGHASH_ALL, coins));
    const bumped = coins.map((c, i) => (i === coins.length - 1 ? { ...c, value: c.value + 1n } : c));
    expect(bytesToHex(transparentSigDigest(tx, 0, SIGHASH_ALL, bumped))).not.toBe(base);
  });

  it('refuses ZIP-244 digests of a v4 transaction', () => {
    const v4 = parseZcashTx(hexToBytes((mainnet as unknown as Record<string, { hex: string }>).v4.hex));
    expect(() => zcashTxDigests(v4)).toThrow(/v5 and v6/);
    expect(() => transparentSigDigest(v4, 0, SIGHASH_ALL, [])).toThrow(/v5 and v6/);
  });

  it('compactSize encodes the three widths', () => {
    expect(bytesToHex(compactSize(0))).toBe('00');
    expect(bytesToHex(compactSize(0xfc))).toBe('fc');
    expect(bytesToHex(compactSize(0xfd))).toBe('fdfd00');
    expect(bytesToHex(compactSize(0xffff))).toBe('fdffff');
    expect(bytesToHex(compactSize(0x10000))).toBe('fe00000100');
  });
});
