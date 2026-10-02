// The send builder (design §4.5, §4.6, §12.1): the Trezor-signed vectors
// rebuilt byte for byte through the signing layer, then every policy rule of
// buildZcashTx. Keys here come from a fixed 64-byte test seed, never from a
// phrase that holds live funds.

import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { decodeZcashAddress, encodeP2sh, encodeTex, p2shScript } from './address';
import { zip317FeeP2pkh } from './fees';
import { zcashKeysFromBip39, zcashKeysFromSeed, zeroZcashKeys, type ZcashKeys } from './keys';
import {
  ZCASH_EXPIRY_DELTA,
  ZCASH_MIN_EXPIRY_MARGIN,
  ZCASH_TX_VERSION,
  ZcashBuildError,
  buildZcashTx,
  signZcashTransparent,
  zcashExpiryHeight,
  type ZcashBuildArgs,
  type ZcashUtxo,
} from './builder';
import { transparentSigDigest } from './sighash';
import { parseZcashTx } from './tx';
import trezor from './testing/trezor_v5.json';

const NU63 = 0x37a5165b;
const TIP = 3_499_644;
const SEED = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
// A recipient that is not ours: the first ZIP-320 vector address.
const OTHER = 't1V9mnyk5Z5cTNMCkLbaDwSskgJZucTLdgW';

function keys(): ZcashKeys {
  return zcashKeysFromSeed(SEED);
}

let counter = 0;
function utxo(k: ZcashKeys, value: bigint, opts: Partial<ZcashUtxo> & { watch?: number } = {}): ZcashUtxo {
  const key = k.watch[opts.watch ?? 0];
  counter += 1;
  return {
    txid: counter.toString(16).padStart(64, '0'),
    index: 0,
    valueZat: value,
    script: key.script,
    height: 3_000_000,
    address: key.address,
    coinbase: false,
    ...opts,
  };
}

function args(k: ZcashKeys, utxos: ZcashUtxo[], amountZat: bigint, extra: Partial<ZcashBuildArgs> = {}): ZcashBuildArgs {
  return { utxos, keys: k, to: OTHER, amountZat, sweep: false, branchId: NU63, tip: TIP, ...extra };
}

function buildError(fn: () => unknown): ZcashBuildError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ZcashBuildError);
    return err as ZcashBuildError;
  }
  throw new Error('expected a ZcashBuildError');
}

/** Verifies every input signature of a built transaction against its coins. */
function verifySignatures(hex: string, inputs: ZcashUtxo[]): void {
  const tx = parseZcashTx(hexToBytes(hex));
  const coins = inputs.map((u) => ({ value: u.valueZat, script: u.script }));
  tx.vin.forEach((inp, i) => {
    const ss = inp.scriptSig;
    const sl = ss[0];
    const sigAll = ss.subarray(1, 1 + sl);
    const pub = ss.subarray(2 + sl);
    expect(sigAll[sigAll.length - 1]).toBe(0x01);
    const sig = secp256k1.Signature.fromDER(sigAll.subarray(0, -1));
    expect(sig.hasHighS()).toBe(false);
    const digest = transparentSigDigest(tx, i, 0x01, coins);
    expect(secp256k1.verify(sig.toCompactRawBytes(), digest, pub)).toBe(true);
  });
}

describe('signing layer: Trezor-signed testnet v5 transactions, byte for byte', () => {
  it.each(trezor.cases)('$name', async (c) => {
    const k = await zcashKeysFromBip39(trezor.mnemonic, '', 'test');
    const r = signZcashTransparent({
      inputs: c.inputs.map((i) => {
        const key = k.watch[i.keyIndex];
        return { txid: i.txid, index: i.index, value: BigInt(i.value), script: key.script, privateKey: key.privateKey };
      }),
      outputs: c.outputs.map((o) => ({ value: BigInt(o.value), script: decodeZcashAddress(o.address, 'test').script })),
      branchId: trezor.branchId,
      expiryHeight: 0,
      version: 5,
    });
    expect(r.hex).toBe(c.hex);
    expect(r.txid).toBe(c.txid);
    expect(parseZcashTx(r.raw).txid).toBe(c.txid);
    zeroZcashKeys(k);
  });

  it('refuses to sign an input whose key does not own the script', async () => {
    const k = await zcashKeysFromBip39(trezor.mnemonic, '', 'test');
    const c = trezor.cases[0];
    expect(() =>
      signZcashTransparent({
        inputs: [{ txid: c.inputs[0].txid, index: 0, value: 1000n, script: k.watch[1].script, privateKey: k.watch[7].privateKey }],
        outputs: [{ value: 500n, script: k.watch[0].script }],
        branchId: trezor.branchId,
        expiryHeight: 0,
      }),
    ).toThrow(/does not own/);
    zeroZcashKeys(k);
  });

  it('v6 switch: the same inputs signed as v6 parse as v6 with a verifying signature', () => {
    const k = keys();
    const u = utxo(k, 100_000n);
    const r = signZcashTransparent({
      inputs: [{ txid: u.txid, index: u.index, value: u.valueZat, script: u.script, privateKey: k.primary.privateKey }],
      outputs: [{ value: 90_000n, script: decodeZcashAddress(OTHER).script }],
      branchId: NU63,
      expiryHeight: TIP + 41,
      version: 6,
    });
    const tx = parseZcashTx(r.raw);
    expect(tx.version).toBe(6);
    expect(tx.txid).toBe(r.txid);
    expect(r.hex.startsWith('0600008098b684d8')).toBe(true);
    expect(r.hex.endsWith('00000000')).toBe(true);
    verifySignatures(r.hex, [u]);
    zeroZcashKeys(k);
  });
});

describe('buildZcashTx: shape and signatures', () => {
  it('ships v5', () => {
    expect(ZCASH_TX_VERSION).toBe(5);
  });

  it('1 in, 2 out: fee 10000, change to /0/0, 170 + DER bytes (241 with a 71-byte DER)', () => {
    const k = keys();
    let saw241 = false;
    for (let i = 0; i < 12; i++) {
      const u = utxo(k, 1_000_000n);
      const r = buildZcashTx(args(k, [u], 300_000n + BigInt(i)));
      expect(r.fee).toBe(10_000n);
      expect(r.amount).toBe(300_000n + BigInt(i));
      expect(r.change).toBe(1_000_000n - r.amount - 10_000n);
      const tx = parseZcashTx(hexToBytes(r.hex));
      expect(tx.version).toBe(5);
      expect(tx.branchId).toBe(NU63);
      expect(tx.expiryHeight).toBe(TIP + 1 + ZCASH_EXPIRY_DELTA);
      expect(r.expiryHeight).toBe(TIP + 41);
      expect(tx.txid).toBe(r.txid);
      expect(tx.vout).toHaveLength(2);
      expect(bytesToHex(tx.vout[0].script)).toBe(bytesToHex(decodeZcashAddress(OTHER).script));
      expect(bytesToHex(tx.vout[1].script)).toBe(bytesToHex(k.primary.script));
      const derLen = tx.vin[0].scriptSig[0] - 1;
      expect(r.sizeBytes).toBe(170 + derLen);
      expect(r.sizeBytes).toBeLessThanOrEqual(241);
      if (r.sizeBytes === 241) saw241 = true;
      verifySignatures(r.hex, r.inputs);
    }
    expect(saw241).toBe(true);
    zeroZcashKeys(k);
  });

  it('is deterministic (RFC 6979) and the branch id comes from the caller', () => {
    const k = keys();
    const u = utxo(k, 500_000n);
    const a = buildZcashTx(args(k, [u], 100_000n));
    const b = buildZcashTx(args(k, [u], 100_000n));
    expect(a.hex).toBe(b.hex);
    const c = buildZcashTx(args(k, [u], 100_000n, { branchId: 0x77190ad9 }));
    expect(c.txid).not.toBe(a.txid);
    expect(parseZcashTx(hexToBytes(c.hex)).branchId).toBe(0x77190ad9);
    expect(() => buildZcashTx(args(k, [u], 100_000n, { branchId: 0 }))).toThrow(/branch id/);
    zeroZcashKeys(k);
  });

  it('signs inputs from several watch addresses, each with its own key', () => {
    const k = keys();
    const us = [utxo(k, 40_000n, { watch: 0 }), utxo(k, 40_000n, { watch: 3 }), utxo(k, 40_000n, { watch: 11 })];
    const r = buildZcashTx(args(k, us, 100_000n));
    expect(r.inputs).toHaveLength(3);
    expect(r.fee).toBe(15_000n);
    verifySignatures(r.hex, r.inputs);
    zeroZcashKeys(k);
  });

  it('pays t3 and tex1 recipients with the right scripts', () => {
    const k = keys();
    const h = hexToBytes('b8f771de8bbdcfee76e0dbf76f1005f2028bf3e7');
    const t3 = buildZcashTx(args(k, [utxo(k, 500_000n)], 100_000n, { to: encodeP2sh(h) }));
    expect(bytesToHex(parseZcashTx(hexToBytes(t3.hex)).vout[0].script)).toBe(bytesToHex(p2shScript(h)));
    const texAddr = encodeTex(decodeZcashAddress(OTHER).hash);
    const tex = buildZcashTx(args(k, [utxo(k, 500_000n)], 100_000n, { to: texAddr }));
    expect(bytesToHex(parseZcashTx(hexToBytes(tex.hex)).vout[0].script)).toBe(bytesToHex(decodeZcashAddress(OTHER).script));
    zeroZcashKeys(k);
  });
});

describe('buildZcashTx: fee, dust, selection', () => {
  it('fee is 5000 * max(2, nIn, nOut) as inputs are added (1..25 inputs)', () => {
    const k = keys();
    for (let n = 1; n <= 25; n++) {
      const us = Array.from({ length: n }, () => utxo(k, 100_000n));
      // Needs every input: amount = n*100000 - fee(n) - 1000 leaves change 1000 (>= dust).
      const fee = zip317FeeP2pkh(n, 2);
      const r = buildZcashTx(args(k, us, BigInt(n) * 100_000n - fee - 1000n));
      expect(r.inputs).toHaveLength(n);
      expect(r.fee).toBe(5000n * BigInt(Math.max(2, n)));
      expect(r.change).toBe(1000n);
    }
    zeroZcashKeys(k);
  });

  it('largest first, and stops as soon as amount + fee is covered', () => {
    const k = keys();
    const small = utxo(k, 20_000n);
    const big = utxo(k, 900_000n);
    const mid = utxo(k, 300_000n);
    const r = buildZcashTx(args(k, [small, big, mid], 500_000n));
    expect(r.inputs.map((u) => u.valueZat)).toEqual([900_000n]);
    const r2 = buildZcashTx(args(k, [small, big, mid], 1_100_000n));
    expect(r2.inputs.map((u) => u.valueZat)).toEqual([900_000n, 300_000n]);
    zeroZcashKeys(k);
  });

  it('change below 54 zat is folded into the fee; 54 zat is kept', () => {
    const k = keys();
    const u = utxo(k, 100_000n);
    const folded = buildZcashTx(args(k, [u], 100_000n - 10_000n - 53n));
    expect(folded.change).toBe(0n);
    expect(folded.fee).toBe(10_053n);
    expect(parseZcashTx(hexToBytes(folded.hex)).vout).toHaveLength(1);
    const kept = buildZcashTx(args(k, [u], 100_000n - 10_000n - 54n));
    expect(kept.change).toBe(54n);
    expect(kept.fee).toBe(10_000n);
    expect(parseZcashTx(hexToBytes(kept.hex)).vout).toHaveLength(2);
    const exact = buildZcashTx(args(k, [u], 90_000n));
    expect(exact.change).toBe(0n);
    expect(exact.fee).toBe(10_000n);
    zeroZcashKeys(k);
  });

  it('MAX sweeps every spendable input to one output', () => {
    const k = keys();
    const us = [utxo(k, 70_000n), utxo(k, 30_000n), utxo(k, 50_000n, { watch: 12 })];
    const r = buildZcashTx(args(k, us, 0n, { sweep: true }));
    expect(r.inputs).toHaveLength(3);
    expect(r.fee).toBe(15_000n);
    expect(r.amount).toBe(150_000n - 15_000n);
    expect(r.change).toBe(0n);
    expect(parseZcashTx(hexToBytes(r.hex)).vout).toHaveLength(1);
    verifySignatures(r.hex, r.inputs);
    zeroZcashKeys(k);
  });

  it('the 0.01 ZEC cap: 200 inputs build, 201 are refused (send and MAX)', () => {
    const k = keys();
    const us200 = Array.from({ length: 200 }, () => utxo(k, 10_000n));
    const ok = buildZcashTx(args(k, us200, 0n, { sweep: true }));
    expect(ok.fee).toBe(1_000_000n);
    const us201 = [...us200, utxo(k, 10_000n)];
    expect(buildError(() => buildZcashTx(args(k, us201, 0n, { sweep: true }))).code).toBe('fee-cap');
    // 1,002,000 needs all 201 inputs (200 cover at most 1,000,000 after their fee).
    const e = buildError(() => buildZcashTx(args(k, us201, 1_002_000n)));
    expect(e.code).toBe('fee-cap');
    expect(e.message).toContain('send in parts');
    zeroZcashKeys(k);
  });

  it('refuses a dust amount, a zero amount and a sweep that cannot pay its fee', () => {
    const k = keys();
    const u = utxo(k, 100_000n);
    expect(buildError(() => buildZcashTx(args(k, [u], 53n))).code).toBe('dust');
    expect(buildError(() => buildZcashTx(args(k, [u], 0n))).code).toBe('insufficient');
    expect(buildError(() => buildZcashTx(args(k, [utxo(k, 10_050n)], 0n, { sweep: true }))).code).toBe('dust');
    zeroZcashKeys(k);
  });

  it('no funds: "No spendable funds", without touching a key', () => {
    const k = keys();
    const e = buildError(() => buildZcashTx(args(k, [], 100_000n)));
    expect(e.code).toBe('insufficient');
    expect(e.message).toMatch(/no spendable funds/i);
    expect(buildError(() => buildZcashTx(args(k, [], 0n, { sweep: true }))).message).toMatch(/no spendable funds/i);
    const short = buildError(() => buildZcashTx(args(k, [utxo(k, 50_000n)], 100_000n)));
    expect(short.code).toBe('insufficient');
    expect(short.message).toContain('0.0011 ZEC');
    zeroZcashKeys(k);
  });

  it('unconfirmed UTXOs are never spent', () => {
    const k = keys();
    const e = buildError(() => buildZcashTx(args(k, [utxo(k, 500_000n, { height: 0 })], 100_000n)));
    expect(e.code).toBe('insufficient');
    zeroZcashKeys(k);
  });
});

describe('buildZcashTx: coinbase, foreign inputs, recipients', () => {
  it('a coinbase UTXO is never selected', () => {
    const k = keys();
    const cb = utxo(k, 10_000_000n, { coinbase: true });
    const plain = utxo(k, 500_000n);
    const r = buildZcashTx(args(k, [cb, plain], 400_000n));
    expect(r.inputs).toEqual([plain]);
    const sweep = buildZcashTx(args(k, [cb, plain], 0n, { sweep: true }));
    expect(sweep.inputs).toEqual([plain]);
    // Enough only with the mining reward: refused with the coinbase reason.
    const e = buildError(() => buildZcashTx(args(k, [cb, plain], 1_000_000n)));
    expect(e.code).toBe('coinbase');
    expect(e.message).toContain('mining reward');
    // Only a mining reward: also the coinbase reason.
    expect(buildError(() => buildZcashTx(args(k, [cb], 100_000n))).code).toBe('coinbase');
    zeroZcashKeys(k);
  });

  it('a P2SH UTXO at our address (none can exist) is refused, not signed', () => {
    const k = keys();
    const p2sh = utxo(k, 500_000n, { script: p2shScript(new Uint8Array(20).fill(7)) });
    expect(buildError(() => buildZcashTx(args(k, [p2sh, utxo(k, 500_000n)], 100_000n))).code).toBe('input');
    zeroZcashKeys(k);
  });

  it('a UTXO whose script is not one of our keys, or whose address does not match, is refused', () => {
    const k = keys();
    const foreign = utxo(k, 500_000n, { script: decodeZcashAddress(OTHER).script, address: OTHER });
    expect(buildError(() => buildZcashTx(args(k, [foreign], 100_000n))).code).toBe('input');
    const mismatched = utxo(k, 500_000n, { address: k.watch[1].address });
    expect(buildError(() => buildZcashTx(args(k, [mismatched], 100_000n))).code).toBe('input');
    const u = utxo(k, 500_000n);
    expect(buildError(() => buildZcashTx(args(k, [u, { ...u }], 100_000n))).code).toBe('input');
    expect(buildError(() => buildZcashTx(args(k, [{ ...u, txid: 'nothex' }], 100_000n))).code).toBe('input');
    zeroZcashKeys(k);
  });

  it('refuses shielded, unified and testnet recipients before building', () => {
    const k = keys();
    const u = utxo(k, 500_000n);
    const e = buildError(() => buildZcashTx(args(k, [u], 100_000n, { to: 'u1qqqqqqqq' })));
    expect(e.code).toBe('recipient');
    expect(e.message).toContain('transparent addresses only');
    expect(buildError(() => buildZcashTx(args(k, [u], 100_000n, { to: 'zs1abc' }))).code).toBe('recipient');
    expect(buildError(() => buildZcashTx(args(k, [u], 100_000n, { to: 'tmQoJ3PTXgQLaRRZZYT6xk8XtjRbr2kCqwu' }))).code).toBe(
      'recipient',
    );
    zeroZcashKeys(k);
  });

  it('refuses to sign with zeroed (locked) keys', () => {
    const k = keys();
    const u = utxo(k, 500_000n);
    zeroZcashKeys(k);
    expect(() => buildZcashTx(args(k, [u], 100_000n))).toThrow(/locked/);
  });
});

describe('expiry (ZIP-203)', () => {
  it('is tip + 1 + 40 with no pending upgrade, or one already active', () => {
    expect(zcashExpiryHeight(1000)).toBe(1041);
    expect(zcashExpiryHeight(1000, 900)).toBe(1041);
    expect(zcashExpiryHeight(1000, 1000)).toBe(1041);
  });

  it('is capped at upgradeHeight - 1 under a pending upgrade', () => {
    expect(zcashExpiryHeight(1000, 1020)).toBe(1019);
    expect(zcashExpiryHeight(1000, 1042)).toBe(1041);
    expect(zcashExpiryHeight(1000, 5000)).toBe(1041);
  });

  it(`refuses when fewer than ${ZCASH_MIN_EXPIRY_MARGIN} blocks would remain after the next one`, () => {
    // next block 1001; expiry 1004 leaves 3: allowed. expiry 1003 leaves 2: refused.
    expect(zcashExpiryHeight(1000, 1005)).toBe(1004);
    const e = buildError(() => zcashExpiryHeight(1000, 1004));
    expect(e.code).toBe('expiry');
    expect(e.message).not.toMatch(/—/);
    expect(buildError(() => zcashExpiryHeight(1000, 1001)).code).toBe('expiry');
  });

  it('buildZcashTx applies the cap and the refusal', () => {
    const k = keys();
    const u = utxo(k, 500_000n);
    expect(buildZcashTx(args(k, [u], 100_000n, { upgradeHeight: TIP + 10 })).expiryHeight).toBe(TIP + 9);
    expect(buildError(() => buildZcashTx(args(k, [u], 100_000n, { upgradeHeight: TIP + 3 }))).code).toBe('expiry');
    expect(() => buildZcashTx(args(k, [u], 100_000n, { tip: 0 }))).toThrow(/tip/);
    zeroZcashKeys(k);
  });
});
