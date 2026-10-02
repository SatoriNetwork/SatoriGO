// extrinsic.test.ts: the on-chain transfer of block 9,168,516 decoded field
// by field and re-encoded byte for byte; the reference's 145-byte
// transfer_keep_alive with its signing payload equal to polkadot.js's
// ExtrinsicPayload bytes and its signature verified; transfer_all; the u64
// refusal; and the RuntimeDispatchInfo / TransactionValidity decoders.

import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { accountFromMnemonic, deriveHard, publicKeyOfExpandedSecret, verifySubstrate } from './keys';
import {
  INVALID_TRANSACTION,
  assembleExtrinsic,
  buildSignedExtrinsic,
  decodeCall,
  decodeRuntimeDispatchInfo,
  decodeSignedExtrinsic,
  decodeTransactionValidity,
  encodeCall,
  extrinsicHash,
  signable,
  signingPayload,
} from './extrinsic';
import { MAX_U64, ScaleError, hexToBytes0x } from './scale';
import { ss58Decode, ss58Encode } from './ss58';
import { TAO_ERA_PERIOD, TAO_PROFILE } from './tao';
import { ABANDON_12, FEE_ANSWERS, ONCHAIN_TRANSFER, PJS_PAYLOADS, PROTO_SIGNED_HEX } from './testing/fixtures';

const me = accountFromMnemonic(ABANDON_12);
const destChild = deriveHard(me.miniSecret, '//0');
const dest = publicKeyOfExpandedSecret(destChild);

describe('encodeCall', () => {
  it('transfer_keep_alive is 05 03 00 || dest || compact(rao) (the fixture call)', () => {
    const call = encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest, rao: 1_000_000n });
    expect(bytesToHex(call)).toBe(PJS_PAYLOADS[0].call);
    expect(call.length).toBe(2 + 1 + 32 + 4);
  });

  it('transfer_allow_death is 05 00, transfer_all is 05 04 with a keep_alive bool', () => {
    expect(bytesToHex(encodeCall(TAO_PROFILE, { kind: 'transfer_allow_death', dest, rao: 1_000_000n }))).toBe(
      '050000' + bytesToHex(dest) + '02093d00',
    );
    expect(bytesToHex(encodeCall(TAO_PROFILE, { kind: 'transfer_all', dest, keepAlive: true }))).toBe('050400' + bytesToHex(dest) + '01');
    expect(bytesToHex(encodeCall(TAO_PROFILE, { kind: 'transfer_all', dest, keepAlive: false }))).toBe('050400' + bytesToHex(dest) + '00');
    expect(() => encodeCall(TAO_PROFILE, { kind: 'transfer_all', dest })).toThrow(ScaleError);
  });

  it('follows the profile indices, not constants', () => {
    const moved = { ...TAO_PROFILE, balances: { pallet: 7, transfer_allow_death: 1, transfer_keep_alive: 2, transfer_all: 9 } };
    expect(bytesToHex(encodeCall(moved, { kind: 'transfer_keep_alive', dest, rao: 1n })).slice(0, 6)).toBe('070200');
    expect(bytesToHex(encodeCall(moved, { kind: 'transfer_all', dest, keepAlive: true })).slice(0, 6)).toBe('070900');
  });

  it('refuses an amount above u64 (a u128 example copied from Polkadot), zero, negative, a number, and a bad dest', () => {
    expect(() => encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest, rao: MAX_U64 })).not.toThrow();
    expect(() => encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest, rao: MAX_U64 + 1n })).toThrow(/u64/);
    expect(() => encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest, rao: 1n << 127n })).toThrow(ScaleError);
    expect(() => encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest, rao: 0n })).toThrow(ScaleError);
    expect(() => encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest, rao: -1n })).toThrow(ScaleError);
    expect(() => encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest, rao: 1e6 as unknown as bigint })).toThrow(ScaleError);
    expect(() => encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest })).toThrow(ScaleError);
    expect(() => encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest: new Uint8Array(20), rao: 1n })).toThrow(ScaleError);
    expect(() => encodeCall(TAO_PROFILE, { kind: 'burn' as 'transfer_all', dest, rao: 1n })).toThrow(ScaleError);
  });

  it('decodeCall inverts all three', () => {
    for (const call of [
      { kind: 'transfer_keep_alive' as const, dest, rao: 187_825_400n },
      { kind: 'transfer_allow_death' as const, dest, rao: MAX_U64 },
      { kind: 'transfer_all' as const, dest, keepAlive: true },
    ]) {
      const bytes = encodeCall(TAO_PROFILE, call);
      const back = decodeCall(TAO_PROFILE, bytes);
      expect(back.next).toBe(bytes.length);
      expect(back.call.kind).toBe(call.kind);
      expect(bytesToHex(back.call.dest)).toBe(bytesToHex(dest));
      if ('rao' in call) expect(back.call.rao).toBe(call.rao);
      else expect(back.call.keepAlive).toBe(call.keepAlive);
    }
    expect(() => decodeCall(TAO_PROFILE, hexToBytes('0502' + '00' + '00'.repeat(32)))).toThrow(/Not a transfer call/);
    expect(() => decodeCall(TAO_PROFILE, hexToBytes('0603' + '00' + '00'.repeat(32) + '04'))).toThrow(/Not a Balances call/);
    expect(() => decodeCall(TAO_PROFILE, hexToBytes('0503' + '01' + '00'.repeat(32) + '04'))).toThrow(/MultiAddress::Id/);
  });
});

describe('the on-chain transfer of block 9,168,516', () => {
  it('decodes field by field to what polkadot.js reported', () => {
    const d = decodeSignedExtrinsic(ONCHAIN_TRANSFER.hex, TAO_PROFILE);
    expect(ss58Encode(d.signer)).toBe(ONCHAIN_TRANSFER.signer);
    expect(bytesToHex(d.signer)).toBe(ONCHAIN_TRANSFER.signerPublicKey);
    expect(d.signature.length).toBe(64);
    expect(d.signatureType).toBe('ed25519');
    expect(d.era).toEqual({ period: ONCHAIN_TRANSFER.era.period, phase: ONCHAIN_TRANSFER.era.phase });
    expect(d.nonce).toBe(ONCHAIN_TRANSFER.nonce);
    expect(d.tip).toBe(ONCHAIN_TRANSFER.tip);
    expect(d.call.kind).toBe(ONCHAIN_TRANSFER.kind);
    expect(ss58Encode(d.call.dest)).toBe(ONCHAIN_TRANSFER.dest);
    expect(d.call.rao).toBe(ONCHAIN_TRANSFER.rao);
  });

  it('re-encodes byte for byte (148 bytes) and hashes to the hash the chain reported', () => {
    const d = decodeSignedExtrinsic(ONCHAIN_TRANSFER.hex, TAO_PROFILE);
    const full = assembleExtrinsic({
      signer: d.signer,
      signature: d.signature,
      signatureType: d.signatureType,
      era: hexToBytes(ONCHAIN_TRANSFER.era.bytes),
      nonce: d.nonce,
      tip: d.tip,
      call: encodeCall(TAO_PROFILE, d.call),
    });
    expect(full.length).toBe(148);
    expect(`0x${bytesToHex(full)}`).toBe(ONCHAIN_TRANSFER.hex);
    expect(extrinsicHash(full)).toBe(ONCHAIN_TRANSFER.hash);
    // the default (what the wallet signs) is the sr25519 tag, which is the one byte that differs
    const asSr = assembleExtrinsic({ signer: d.signer, signature: d.signature, era: hexToBytes('0928'), nonce: d.nonce, tip: d.tip, call: encodeCall(TAO_PROFILE, d.call) });
    expect(asSr[1 + 2 + 1 + 32]).toBe(0x01);
    expect(full[1 + 2 + 1 + 32]).toBe(0x00);
  });

  it('its ed25519 signature verifies over the payload this engine rebuilds with the era checkpoint at block 9,168,512', () => {
    // period 1024, phase 640: the checkpoint is the last block with number % 1024 == 640 at or before inclusion.
    const checkpointNumber = ONCHAIN_TRANSFER.checkpointNumber;
    expect(checkpointNumber % 1024).toBe(640);
    expect(ONCHAIN_TRANSFER.blockNumber - checkpointNumber).toBeLessThan(1024);
    const d = decodeSignedExtrinsic(ONCHAIN_TRANSFER.hex, TAO_PROFILE);
    const payload = signingPayload({
      profile: TAO_PROFILE,
      call: encodeCall(TAO_PROFILE, d.call),
      nonce: d.nonce,
      tip: d.tip,
      eraPeriod: 1024,
      checkpointNumber,
      checkpointHash: hexToBytes0x(ONCHAIN_TRANSFER.checkpointHash),
    });
    expect(`0x${bytesToHex(payload)}`).toBe(ONCHAIN_TRANSFER.payload);
    expect(payload.length).toBe(120);
    expect(signable(payload)).toBe(payload);
    // Independent of sr25519 and of polkadot.js: plain ed25519 over exactly these bytes.
    expect(ed25519.verify(d.signature, payload, d.signer)).toBe(true);
    // and a neighbouring checkpoint (wrong hash in the payload) does not verify
    const wrong = signingPayload({
      profile: TAO_PROFILE,
      call: encodeCall(TAO_PROFILE, d.call),
      nonce: d.nonce,
      tip: d.tip,
      eraPeriod: 1024,
      checkpointNumber,
      checkpointHash: hexToBytes0x(ONCHAIN_TRANSFER.blockHash),
    });
    expect(ed25519.verify(d.signature, wrong, d.signer)).toBe(false);
    // a spec 471 payload does not verify either: the version numbers are signed
    const bumped = signingPayload({
      profile: { ...TAO_PROFILE, specVersion: 471 },
      call: encodeCall(TAO_PROFILE, d.call),
      nonce: d.nonce,
      tip: d.tip,
      eraPeriod: 1024,
      checkpointNumber,
      checkpointHash: hexToBytes0x(ONCHAIN_TRANSFER.checkpointHash),
    });
    expect(ed25519.verify(d.signature, bumped, d.signer)).toBe(false);
  });
});

describe('the reference 145-byte transfer_keep_alive', () => {
  for (const p of PJS_PAYLOADS) {
    it(`${p.name}: the signing payload equals polkadot.js's ExtrinsicPayload bytes`, () => {
      const call = encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest, rao: p.rao });
      expect(bytesToHex(call)).toBe(p.call);
      const payload = signingPayload({
        profile: TAO_PROFILE,
        call,
        nonce: p.nonce,
        tip: p.tip,
        eraPeriod: TAO_ERA_PERIOD,
        checkpointNumber: p.checkpointNumber,
        checkpointHash: hexToBytes0x(p.checkpointHash),
      });
      expect(`0x${bytesToHex(payload)}`).toBe(p.payload);
      expect(payload.length).toBeLessThan(256);
      expect(signable(payload)).toBe(payload);
    });

    it(`${p.name}: the recorded signature verifies and re-assembles to the recorded 145 bytes`, () => {
      const payload = hexToBytes0x(p.payload);
      const signature = hexToBytes(p.signature);
      expect(verifySubstrate(me.publicKey, payload, signature)).toBe(true);
      const d = decodeSignedExtrinsic(p.signedHex, TAO_PROFILE);
      expect(bytesToHex(d.signature)).toBe(p.signature);
      expect(ss58Encode(d.signer)).toBe(me.address);
      expect(d.nonce).toBe(p.nonce);
      expect(d.tip).toBe(p.tip);
      expect(d.era).toEqual({ period: 64, phase: p.era.phase });
      expect(d.call).toEqual({ kind: 'transfer_keep_alive', dest, rao: p.rao });
      const full = assembleExtrinsic({
        signer: me.publicKey,
        signature,
        era: hexToBytes(p.era.bytes),
        nonce: p.nonce,
        tip: p.tip,
        call: hexToBytes(p.call),
      });
      expect(full.length).toBe(145);
      expect(`0x${bytesToHex(full)}`).toBe(p.signedHex);
    });
  }

  it('proto_run.txt: the transfer the live node validated verifies over the same payload', () => {
    const d = decodeSignedExtrinsic(PROTO_SIGNED_HEX, TAO_PROFILE);
    expect(verifySubstrate(me.publicKey, hexToBytes0x(PJS_PAYLOADS[1].payload), d.signature)).toBe(true);
    expect((PROTO_SIGNED_HEX.length - 2) / 2).toBe(145);
    // one flipped signature bit no longer verifies (what the node reported as Invalid(BadProof))
    const flipped = d.signature.slice();
    flipped[0] ^= 0x01;
    expect(verifySubstrate(me.publicKey, hexToBytes0x(PJS_PAYLOADS[1].payload), flipped)).toBe(false);
  });

  it('buildSignedExtrinsic produces a 145-byte transfer whose signature verifies and which decodes back', () => {
    const p = PJS_PAYLOADS[1];
    const call = encodeCall(TAO_PROFILE, { kind: 'transfer_keep_alive', dest, rao: p.rao });
    const signed = buildSignedExtrinsic({
      profile: TAO_PROFILE,
      account: me,
      call,
      nonce: p.nonce,
      tip: p.tip,
      eraPeriod: TAO_ERA_PERIOD,
      checkpointNumber: p.checkpointNumber,
      checkpointHash: hexToBytes0x(p.checkpointHash),
    });
    expect((signed.hex.length - 2) / 2).toBe(145);
    expect(`0x${bytesToHex(signed.payload)}`).toBe(p.payload);
    expect(signed.nonce).toBe(7);
    expect(signed.eraPeriod).toBe(64);
    expect(signed.checkpointNumber).toBe(p.checkpointNumber);
    expect(signed.hash).toBe(extrinsicHash(hexToBytes0x(signed.hex)));
    expect(signed.hash).toMatch(/^0x[0-9a-f]{64}$/);
    const d = decodeSignedExtrinsic(signed.hex, TAO_PROFILE);
    expect(verifySubstrate(me.publicKey, signed.payload, d.signature)).toBe(true);
    // everything outside the (randomised) signature is byte-identical to the fixture
    const sigStart = 2 + 2 * (2 + 1 + 1 + 32 + 1);
    const sigEnd = sigStart + 128;
    expect(signed.hex.slice(0, sigStart)).toBe(p.signedHex.slice(0, sigStart));
    expect(signed.hex.slice(sigEnd)).toBe(p.signedHex.slice(sigEnd));
  });

  it('is deterministic with a fixed nonce seed, byte-exact', () => {
    const p = PJS_PAYLOADS[0];
    const call = hexToBytes(p.call);
    const args = {
      profile: TAO_PROFILE,
      account: me,
      call,
      nonce: p.nonce,
      tip: p.tip,
      eraPeriod: TAO_ERA_PERIOD,
      checkpointNumber: p.checkpointNumber,
      checkpointHash: hexToBytes0x(p.checkpointHash),
      random: new Uint8Array(32).fill(1),
    };
    const a = buildSignedExtrinsic(args);
    const b = buildSignedExtrinsic(args);
    expect(a.hex).toBe(b.hex);
    expect(a.hash).toBe(b.hash);
    expect(buildSignedExtrinsic({ ...args, random: new Uint8Array(32).fill(2) }).hex).not.toBe(a.hex);
  });

  it('transfer_all signs and decodes', () => {
    const call = encodeCall(TAO_PROFILE, { kind: 'transfer_all', dest, keepAlive: true });
    const signed = buildSignedExtrinsic({
      profile: TAO_PROFILE,
      account: me,
      call,
      nonce: 8,
      eraPeriod: TAO_ERA_PERIOD,
      checkpointNumber: 9_168_527,
      checkpointHash: hexToBytes0x(PJS_PAYLOADS[1].checkpointHash),
    });
    expect((signed.hex.length - 2) / 2).toBe(145 - 4 + 1);
    const d = decodeSignedExtrinsic(signed.hex, TAO_PROFILE);
    expect(d.call).toEqual({ kind: 'transfer_all', dest, keepAlive: true });
    expect(d.nonce).toBe(8);
    expect(d.tip).toBe(0n);
    expect(verifySubstrate(me.publicKey, signed.payload, d.signature)).toBe(true);
  });

  it('a payload over 256 bytes is signed through blake2b-256', () => {
    const big = new Uint8Array(257).fill(9);
    expect(signable(big).length).toBe(32);
    expect(signable(new Uint8Array(256)).length).toBe(256);
  });

  it('refuses a profile this layout cannot serve, a bad checkpoint, a bad nonce or tip', () => {
    const call = hexToBytes(PJS_PAYLOADS[0].call);
    const base = {
      profile: TAO_PROFILE,
      account: me,
      call,
      nonce: 7,
      eraPeriod: TAO_ERA_PERIOD,
      checkpointNumber: 9_168_516,
      checkpointHash: hexToBytes0x(PJS_PAYLOADS[0].checkpointHash),
    };
    expect(() => buildSignedExtrinsic({ ...base, profile: { ...TAO_PROFILE, extrinsicVersion: 5 as 4 } })).toThrow(ScaleError);
    expect(() => buildSignedExtrinsic({ ...base, profile: { ...TAO_PROFILE, balanceBytes: 16 as 8 } })).toThrow(ScaleError);
    expect(() => buildSignedExtrinsic({ ...base, checkpointHash: new Uint8Array(31) })).toThrow(ScaleError);
    expect(() => buildSignedExtrinsic({ ...base, nonce: -1 })).toThrow(ScaleError);
    expect(() => buildSignedExtrinsic({ ...base, nonce: 2 ** 32 })).toThrow(ScaleError);
    expect(() => buildSignedExtrinsic({ ...base, tip: -1n })).toThrow(ScaleError);
    expect(() => buildSignedExtrinsic({ ...base, tip: 5 as unknown as bigint })).toThrow(ScaleError);
  });
});

describe('decodeSignedExtrinsic refusals', () => {
  const good = PJS_PAYLOADS[0].signedHex;
  it('a lying length prefix, an unsigned or v5 version byte, a non-sr25519 signature, trailing bytes', () => {
    expect(() => decodeSignedExtrinsic('0x3902' + good.slice(6), TAO_PROFILE)).toThrow(/length prefix/);
    expect(() => decodeSignedExtrinsic(good.slice(0, 6) + '04' + good.slice(8), TAO_PROFILE)).toThrow(/signed v4/);
    expect(() => decodeSignedExtrinsic(good.slice(0, 6) + '85' + good.slice(8), TAO_PROFILE)).toThrow(/signed v4/);
    const sigTypeAt = 2 + 2 * (2 + 1 + 1 + 32);
    expect(good.slice(sigTypeAt, sigTypeAt + 2)).toBe('01');
    expect(() => decodeSignedExtrinsic(good.slice(0, sigTypeAt) + '02' + good.slice(sigTypeAt + 2), TAO_PROFILE)).toThrow(/sr25519 or ed25519/);
    expect(decodeSignedExtrinsic(good.slice(0, sigTypeAt) + '00' + good.slice(sigTypeAt + 2), TAO_PROFILE).signatureType).toBe('ed25519');
    expect(decodeSignedExtrinsic(good, TAO_PROFILE).signatureType).toBe('sr25519');
    expect(() => decodeSignedExtrinsic(good.slice(0, 2) + '41' + good.slice(4) + '00', TAO_PROFILE)).toThrow(/Trailing/);
    expect(() => decodeSignedExtrinsic('0x', TAO_PROFILE)).toThrow(ScaleError);
  });

  it('a metadata-hash mode other than Disabled', () => {
    const modeAt = 2 + 2 * (2 + 1 + 1 + 32 + 1 + 64 + 2 + 1 + 1);
    expect(good.slice(modeAt, modeAt + 2)).toBe('00');
    expect(() => decodeSignedExtrinsic(good.slice(0, modeAt) + '01' + good.slice(modeAt + 2), TAO_PROFILE)).toThrow(/CheckMetadataHash/);
  });

  it('the signer of a decoded extrinsic is a real SS58 account', () => {
    const d = decodeSignedExtrinsic(good, TAO_PROFILE);
    expect(bytesToHex(ss58Decode(ss58Encode(d.signer), 42).publicKey)).toBe(bytesToHex(me.publicKey));
  });
});

describe('decodeRuntimeDispatchInfo', () => {
  it('the measured answer: refTime 224051000, proofSize 7791, Normal, partialFee 83124 rao (8 bytes)', () => {
    const info = decodeRuntimeDispatchInfo(FEE_ANSWERS.runtimeDispatchInfo, 8);
    expect(info).toEqual({ refTime: FEE_ANSWERS.refTime, proofSize: FEE_ANSWERS.proofSize, class: 0, partialFee: FEE_ANSWERS.partialFee });
  });

  it('refuses a 16-byte fee (a u128 runtime), a truncated answer, an unknown class', () => {
    expect(() => decodeRuntimeDispatchInfo(FEE_ANSWERS.runtimeDispatchInfo + '0000000000000000', 8)).toThrow(/expected 8/);
    expect(() => decodeRuntimeDispatchInfo(FEE_ANSWERS.runtimeDispatchInfo.slice(0, -2), 8)).toThrow(ScaleError);
    expect(() => decodeRuntimeDispatchInfo('0x' + 'e2fc6a35' + 'bd79' + '03' + 'b444010000000000', 8)).toThrow(/class/);
    expect(() => decodeRuntimeDispatchInfo('0x' + 'e2fc6a35' + 'bd79', 8)).toThrow(ScaleError);
    expect(() => decodeRuntimeDispatchInfo(FEE_ANSWERS.runtimeDispatchInfo, 16 as 8)).toThrow(ScaleError);
  });
});

describe('decodeTransactionValidity', () => {
  it('0x010001 is Invalid(Payment), 0x010004 is Invalid(BadProof)', () => {
    expect(decodeTransactionValidity(FEE_ANSWERS.validity.payment)).toEqual({ ok: false, kind: 'invalid', code: 1, name: 'Payment' });
    expect(decodeTransactionValidity(FEE_ANSWERS.validity.badProof)).toEqual({ ok: false, kind: 'invalid', code: 4, name: 'BadProof' });
    expect(INVALID_TRANSACTION[2]).toBe('Future');
    expect(decodeTransactionValidity('0x010002')).toEqual({ ok: false, kind: 'invalid', code: 2, name: 'Future' });
    expect(decodeTransactionValidity('0x010003')).toEqual({ ok: false, kind: 'invalid', code: 3, name: 'Stale' });
    expect(decodeTransactionValidity('0x010005')).toEqual({ ok: false, kind: 'invalid', code: 5, name: 'AncientBirthBlock' });
  });

  it('0x00... is Valid', () => {
    expect(decodeTransactionValidity(FEE_ANSWERS.validity.valid)).toEqual({ ok: true });
    expect(decodeTransactionValidity('0x00')).toEqual({ ok: true });
  });

  it('Unknown, Custom with its byte, and variants this engine does not name', () => {
    expect(decodeTransactionValidity('0x010100')).toEqual({ ok: false, kind: 'unknown', code: 0, name: 'CannotLookup' });
    expect(decodeTransactionValidity('0x01000707')).toEqual({ ok: false, kind: 'invalid', code: 7, name: 'Custom(7)' });
    expect(decodeTransactionValidity('0x010063')).toEqual({ ok: false, kind: 'invalid', code: 99, name: '#99' });
  });

  it('refuses an empty or malformed answer', () => {
    expect(() => decodeTransactionValidity('0x')).toThrow(ScaleError);
    expect(() => decodeTransactionValidity('0x01')).toThrow(ScaleError);
    expect(() => decodeTransactionValidity('0x0102')).toThrow(ScaleError);
    expect(() => decodeTransactionValidity('0x010200')).toThrow(ScaleError);
    expect(() => decodeTransactionValidity('0x02')).toThrow(ScaleError);
  });
});

describe('hygiene', () => {
  it('signing never mutates the account or the call bytes', () => {
    const before = bytesToHex(me.miniSecret);
    const call = hexToBytes(PJS_PAYLOADS[0].call);
    const copy = call.slice();
    buildSignedExtrinsic({
      profile: TAO_PROFILE,
      account: me,
      call,
      nonce: 7,
      eraPeriod: TAO_ERA_PERIOD,
      checkpointNumber: 9_168_516,
      checkpointHash: hexToBytes0x(PJS_PAYLOADS[0].checkpointHash),
    });
    expect(bytesToHex(me.miniSecret)).toBe(before);
    expect(bytesToHex(call)).toBe(bytesToHex(copy));
    expect(utf8ToBytes('substrate').length).toBe(9);
  });
});
