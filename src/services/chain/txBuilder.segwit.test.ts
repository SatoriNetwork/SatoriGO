// Native-segwit (P2WPKH) signing in the transaction builder.
//
// The load-bearing test is the OFFICIAL BIP143 "Native P2WPKH" vector: the
// preimage, the sighash digest, the DER signature and the COMPLETE signed
// transaction published in the BIP are asserted byte-for-byte against what this
// builder produces. That is the anchor — every other test here (mixed
// legacy+segwit inputs, txid vs wtxid, virtual size) checks routing and
// bookkeeping against an independent, test-local serializer/parser rather than
// against txBuilder's own helpers.
//
// Source: BIP143, "Native P2WPKH" example
// (https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki).

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import {
  deriveAddress,
  addressToScript,
  hash160,
  p2pkhScript,
  p2wpkhScript,
  pubkeyToP2pkhAddress,
} from './keys';
import { BITCOINGOLD_MAINNET, EVRMORE_MAINNET } from './chainParams';
import {
  bip143Preimage,
  bip143Sighash,
  buildAndSignEvrTx,
  estimateSpendVBytes,
  estimateTxBytes,
  estimateTxVBytes,
  isP2wpkhScript,
  p2wpkhScriptCode,
  selectCoins,
  serializeSignedTx,
  signP2wpkhInput,
  spendKindOf,
  txid as computeTxid,
  virtualSizeOf,
  type SignableUtxo,
  type Tx,
} from './txBuilder';

// ---------------------------------------------------------------------------
// Independent (test-local) byte helpers + serializer/parser. Nothing below is
// imported from txBuilder, so the assertions are a genuine cross-check.
// ---------------------------------------------------------------------------

function u32LE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

function u64LE(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff);
  return concatBytes(Uint8Array.of(0xfe), u32LE(n));
}

function hash256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/** Display (big-endian) txid <-> internal (little-endian) outpoint hex. */
function flipHex(hex: string): string {
  return bytesToHex(hexToBytes(hex).slice().reverse());
}

/**
 * Independent STRIPPED (no-witness) serialization. With `overrides` it produces
 * the legacy sighash preimage body (prevout script in the signed input, empty
 * everywhere else).
 */
function independentStripped(tx: Tx, overrides?: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [u32LE(tx.version), varint(tx.inputs.length)];
  tx.inputs.forEach((inp, i) => {
    const ss = overrides ? overrides[i] : inp.scriptSig;
    parts.push(
      hexToBytes(inp.txid).slice().reverse(),
      u32LE(inp.vout),
      varint(ss.length),
      ss,
      u32LE(inp.sequence),
    );
  });
  parts.push(varint(tx.outputs.length));
  for (const o of tx.outputs) {
    parts.push(u64LE(o.valueSats), varint(o.scriptPubKey.length), o.scriptPubKey);
  }
  parts.push(u32LE(tx.locktime));
  return concatBytes(...parts);
}

/** Independent legacy SIGHASH_ALL digest (pre-BIP143). */
function independentLegacySighash(tx: Tx, index: number, prevoutScript: Uint8Array): Uint8Array {
  const overrides = tx.inputs.map((_, i) => (i === index ? prevoutScript : new Uint8Array(0)));
  return hash256(concatBytes(independentStripped(tx, overrides), u32LE(0x01)));
}

interface ParsedTx extends Tx {
  /** True when the BIP144 marker/flag were present. */
  hasWitness: boolean;
  /** Size of the stripped serialization, recomputed from the parsed fields. */
  baseSize: number;
  /** Size of the bytes handed in. */
  totalSize: number;
}

/** Segwit-aware raw-transaction parser (BIP144). Asserts nothing is left over. */
function parseRawTx(rawHex: string): ParsedTx {
  const bytes = hexToBytes(rawHex);
  let offset = 0;

  const readU32 = (): number => {
    const v =
      bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
    offset += 4;
    return v >>> 0;
  };
  const readU64 = (): bigint => {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
    offset += 8;
    return v;
  };
  const readVarint = (): number => {
    const first = bytes[offset++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = bytes[offset] | (bytes[offset + 1] << 8);
      offset += 2;
      return v;
    }
    if (first === 0xfe) return readU32();
    throw new Error('64-bit varint not supported in test parser');
  };
  const readBytes = (n: number): Uint8Array => {
    const out = bytes.slice(offset, offset + n);
    offset += n;
    return out;
  };

  const version = readU32();
  let hasWitness = false;
  if (bytes[offset] === 0x00) {
    // BIP144 marker must be followed by flag 0x01 (a real input count is never 0).
    expect(bytes[offset + 1]).toBe(0x01);
    hasWitness = true;
    offset += 2;
  }
  const numInputs = readVarint();
  const inputs: Tx['inputs'] = [];
  for (let i = 0; i < numInputs; i++) {
    const txidHex = bytesToHex(readBytes(32).slice().reverse());
    const vout = readU32();
    const scriptSig = readBytes(readVarint());
    const sequence = readU32();
    inputs.push({ txid: txidHex, vout, scriptSig, sequence, witness: [] });
  }
  const numOutputs = readVarint();
  const outputs: Tx['outputs'] = [];
  for (let i = 0; i < numOutputs; i++) {
    const valueSats = readU64();
    outputs.push({ valueSats, scriptPubKey: readBytes(readVarint()) });
  }
  if (hasWitness) {
    for (let i = 0; i < numInputs; i++) {
      const items = readVarint();
      const stack: Uint8Array[] = [];
      for (let j = 0; j < items; j++) stack.push(readBytes(readVarint()));
      inputs[i].witness = stack;
    }
  }
  const locktime = readU32();
  expect(offset).toBe(bytes.length); // no trailing bytes

  const tx: Tx = { version, inputs, outputs, locktime };
  return {
    ...tx,
    hasWitness,
    baseSize: independentStripped(tx).length,
    totalSize: bytes.length,
  };
}

/** Parse a strict-DER signature into the 64-byte compact form noble verifies. */
function derToCompact(der: Uint8Array): Uint8Array {
  let off = 0;
  expect(der[off++]).toBe(0x30);
  expect(der[off++]).toBe(der.length - 2);
  expect(der[off++]).toBe(0x02);
  const rLen = der[off++];
  const r = der.slice(off, off + rLen);
  off += rLen;
  expect(der[off++]).toBe(0x02);
  const sLen = der[off++];
  const s = der.slice(off, off + sLen);
  off += sLen;
  expect(off).toBe(der.length);
  const pad = (b: Uint8Array): Uint8Array => {
    const stripped = b[0] === 0x00 ? b.slice(1) : b;
    const out = new Uint8Array(32);
    out.set(stripped, 32 - stripped.length);
    return out;
  };
  return concatBytes(pad(r), pad(s));
}

/** Split a witness item of the form DER-signature || sighash-type byte. */
function splitSig(item: Uint8Array): { der: Uint8Array; sighashType: number } {
  return { der: item.slice(0, item.length - 1), sighashType: item[item.length - 1] };
}

// ---------------------------------------------------------------------------
// The OFFICIAL BIP143 "Native P2WPKH" vector, transcribed from the BIP.
// ---------------------------------------------------------------------------

const BIP143 = {
  unsignedHex:
    '0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffff' +
    'ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff' +
    '02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac' +
    '9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000',
  // Input 1 (the P2WPKH one) — the input this vector actually exercises.
  in1PrivateKey: '619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9',
  in1PublicKey: '025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357',
  in1ScriptPubKey: '00141d0f172a0ecb48aee1be1f2687d2963ae33f71a1',
  in1ScriptCode: '76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac',
  in1ValueSats: 600_000_000n, // 6 BTC
  hashPrevouts: '96b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd37',
  hashSequence: '52b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3b',
  hashOutputs: '863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e5',
  preimage:
    '0100000096b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd37' +
    '52b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3b' +
    'ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a01000000' +
    '1976a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac' +
    '0046c32300000000ffffffff' +
    '863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e5' +
    '1100000001000000',
  sighash: 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670',
  // DER signature || SIGHASH_ALL, i.e. exactly the first witness item.
  signature:
    '304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a' +
    '0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01',
  // Input 0 is a bare P2PK; the BIP publishes its finished scriptSig, which this
  // wallet never builds itself. Hardcoding it lets the whole signed transaction
  // be reproduced end to end.
  in0ScriptSig:
    '4830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be' +
    '022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01',
  signedHex:
    '01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000' +
    '494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be' +
    '022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffff' +
    'ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff' +
    '02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac' +
    '9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac' +
    '000247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a' +
    '0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee' +
    '0121025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee635711000000',
};

describe('BIP143 official "Native P2WPKH" test vector', () => {
  it('reproduces the published preimage, sighash, signature and signed transaction', () => {
    // The unsigned transaction is parsed from the BIP's own hex, so the skeleton
    // under test comes from the spec, not from this wallet's builders.
    const parsed = parseRawTx(BIP143.unsignedHex);
    expect(parsed.hasWitness).toBe(false);
    expect(parsed.version).toBe(1);
    expect(parsed.locktime).toBe(0x11);
    expect(parsed.inputs.length).toBe(2);
    expect(parsed.inputs[0].sequence).toBe(0xffffffee);
    expect(parsed.inputs[1].sequence).toBe(0xffffffff);
    expect(parsed.outputs.length).toBe(2);

    const tx: Tx = {
      version: parsed.version,
      inputs: parsed.inputs,
      outputs: parsed.outputs,
      locktime: parsed.locktime,
    };
    // Round-trip: with no witness data the builder must emit the legacy bytes.
    expect(serializeSignedTx(tx).rawHex).toBe(BIP143.unsignedHex);

    // Key material of input 1 (the P2WPKH input).
    const privateKey = hexToBytes(BIP143.in1PrivateKey);
    const publicKey = secp256k1.getPublicKey(privateKey, true);
    expect(bytesToHex(publicKey)).toBe(BIP143.in1PublicKey);

    const program = hash160(publicKey);
    expect(bytesToHex(p2wpkhScript(program))).toBe(BIP143.in1ScriptPubKey);
    expect(isP2wpkhScript(hexToBytes(BIP143.in1ScriptPubKey))).toBe(true);
    expect(spendKindOf(BIP143.in1ScriptPubKey)).toBe('p2wpkh');

    // THE footgun: the scriptCode is the P2PKH script of the pubkey hash, with
    // its 0x19 length prefix in the preimage — never the P2WPKH script.
    const scriptCode = p2wpkhScriptCode(program);
    expect(bytesToHex(scriptCode)).toBe(BIP143.in1ScriptCode);
    expect(bytesToHex(scriptCode)).not.toBe(BIP143.in1ScriptPubKey);
    expect(scriptCode.length).toBe(0x19);

    // (a) The full preimage, byte for byte. It embeds the spec's hashPrevouts,
    //     hashSequence and hashOutputs, so those are proven too.
    const preimage = bip143Preimage(tx, 1, scriptCode, BIP143.in1ValueSats);
    expect(bytesToHex(preimage)).toBe(BIP143.preimage);
    expect(bytesToHex(preimage)).toContain(BIP143.hashPrevouts);
    expect(bytesToHex(preimage)).toContain(BIP143.hashSequence);
    expect(bytesToHex(preimage)).toContain(BIP143.hashOutputs);

    // (b) The digest that gets signed.
    const sighash = bip143Sighash(tx, 1, scriptCode, BIP143.in1ValueSats);
    expect(bytesToHex(sighash)).toBe(BIP143.sighash);
    expect(bytesToHex(hash256(preimage))).toBe(BIP143.sighash);

    // (c) The signature (RFC6979 deterministic k, low-S) and the 2-item witness.
    const witness = signP2wpkhInput(tx, 1, BIP143.in1ValueSats, privateKey, publicKey);
    expect(witness.length).toBe(2);
    expect(bytesToHex(witness[0])).toBe(BIP143.signature);
    expect(bytesToHex(witness[1])).toBe(BIP143.in1PublicKey);

    // (d) The complete signed transaction, including the BIP144 marker/flag, the
    //     empty scriptSig on the segwit input and the empty witness on input 0.
    tx.inputs[0].scriptSig = hexToBytes(BIP143.in0ScriptSig);
    tx.inputs[1].witness = witness;
    const signed = serializeSignedTx(tx);
    expect(signed.rawHex).toBe(BIP143.signedHex);

    // The signature verifies against the BIP143 digest under the input's pubkey.
    const { der, sighashType } = splitSig(witness[0]);
    expect(sighashType).toBe(0x01); // SIGHASH_ALL
    expect(secp256k1.verify(derToCompact(der), sighash, publicKey, { lowS: true })).toBe(true);
  });

  it('a wrong scriptCode (the P2WPKH script) yields a DIFFERENT digest', () => {
    // Guards the most likely regression: someone "simplifying" the scriptCode to
    // the prevout script. It must not accidentally produce the same sighash.
    const parsed = parseRawTx(BIP143.unsignedHex);
    const tx: Tx = { ...parsed };
    const wrong = bip143Sighash(tx, 1, hexToBytes(BIP143.in1ScriptPubKey), BIP143.in1ValueSats);
    expect(bytesToHex(wrong)).not.toBe(BIP143.sighash);
  });

  it('the amount is committed: a wrong input value changes the digest', () => {
    // BIP143's whole point over the legacy algorithm. A signer that ignored the
    // value would produce the same digest for both.
    const parsed = parseRawTx(BIP143.unsignedHex);
    const tx: Tx = { ...parsed };
    const scriptCode = hexToBytes(BIP143.in1ScriptCode);
    const off = bip143Sighash(tx, 1, scriptCode, BIP143.in1ValueSats - 1n);
    expect(bytesToHex(off)).not.toBe(BIP143.sighash);
  });
});

// ---------------------------------------------------------------------------
// Fixtures for the builder-level tests (BTGS = the segwit-capable chain).
// ---------------------------------------------------------------------------

const FIXED_SEED = hexToBytes(
  '000102030405060708090a0b0c0d0e0f' +
    '101112131415161718191a1b1c1d1e1f' +
    '202122232425262728292a2b2c2d2e2f' +
    '303132333435363738393a3b3c3d3e3f',
);

const FAKE_TXID_1 = 'a'.repeat(64);
const FAKE_TXID_2 = 'b'.repeat(64);

function btgsKey(index: number) {
  return deriveAddress(FIXED_SEED, BITCOINGOLD_MAINNET, 0, 0, index);
}

/** A UTXO locked to the bech32 (P2WPKH) address of the key at `index`. */
function segwitUtxo(index: number, txidHex: string, vout: number, valueSats: bigint): SignableUtxo {
  const key = btgsKey(index);
  return {
    txid: txidHex,
    vout,
    valueSats,
    scriptPubKeyHex: bytesToHex(addressToScript(key.address)),
    privateKey: key.privateKey,
    publicKey: key.publicKey,
  };
}

/** A UTXO locked to the LEGACY ('G…') P2PKH address of the same key. */
function legacyUtxo(index: number, txidHex: string, vout: number, valueSats: bigint): SignableUtxo {
  const key = btgsKey(index);
  return {
    txid: txidHex,
    vout,
    valueSats,
    scriptPubKeyHex: bytesToHex(p2pkhScript(hash160(key.publicKey))),
    privateKey: key.privateKey,
    publicKey: key.publicKey,
  };
}

describe('segwit routing by prevout script (never by chain name)', () => {
  it('classifies prevout scripts by shape', () => {
    const key = btgsKey(0);
    expect(spendKindOf(bytesToHex(addressToScript(key.address)))).toBe('p2wpkh');
    expect(spendKindOf(bytesToHex(p2pkhScript(hash160(key.publicKey))))).toBe('p2pkh');
    // P2WSH (0x0020 || 32 bytes) is witness v0 but NOT P2WPKH: it must not be
    // routed into the P2WPKH witness path.
    expect(isP2wpkhScript(hexToBytes('0020' + '11'.repeat(32)))).toBe(false);
    // Witness v1 (taproot) likewise.
    expect(isP2wpkhScript(hexToBytes('5120' + '11'.repeat(32)))).toBe(false);
    // An asset-style script (P2PKH with an OP_x_ASSET trailer) stays legacy.
    expect(spendKindOf(bytesToHex(p2pkhScript(hash160(key.publicKey))) + 'c01572766e74')).toBe(
      'p2pkh',
    );
  });

  it('signs a P2WPKH input with BIP143 and leaves its scriptSig empty', () => {
    const key = btgsKey(0);
    const dest = btgsKey(1);
    const utxo = segwitUtxo(0, FAKE_TXID_1, 0, 500_000n);

    const built = buildAndSignEvrTx({
      inputs: [utxo],
      outputs: [{ address: dest.address, valueSats: 200_000n }],
      changeAddress: key.address,
      feeSats: 1_000n,
      net: BITCOINGOLD_MAINNET,
    });

    const parsed = parseRawTx(built.rawHex);
    expect(parsed.hasWitness).toBe(true);
    // Marker + flag sit directly after nVersion.
    expect(built.rawHex.slice(8, 12)).toBe('0001');
    expect(parsed.inputs[0].scriptSig.length).toBe(0);
    expect(parsed.inputs[0].witness.length).toBe(2);
    expect(bytesToHex(parsed.inputs[0].witness[1])).toBe(bytesToHex(key.publicKey));

    // Both outputs pay bech32 addresses, so both are P2WPKH scripts.
    expect(parsed.outputs.length).toBe(2);
    expect(bytesToHex(parsed.outputs[0].scriptPubKey)).toBe(
      bytesToHex(addressToScript(dest.address)),
    );
    expect(isP2wpkhScript(parsed.outputs[1].scriptPubKey)).toBe(true);

    // The witness signature verifies against the BIP143 digest for this input.
    const skeleton: Tx = { ...parsed };
    const sighash = bip143Sighash(
      skeleton,
      0,
      p2wpkhScriptCode(hash160(key.publicKey)),
      utxo.valueSats,
    );
    const { der, sighashType } = splitSig(parsed.inputs[0].witness[0]);
    expect(sighashType).toBe(0x01);
    expect(secp256k1.verify(derToCompact(der), sighash, key.publicKey, { lowS: true })).toBe(true);
  });

  it('refuses to sign a P2WPKH input with the wrong key', () => {
    // hash160(pubkey) must equal the witness program, otherwise the script fails
    // at relay time and the "signed" transaction is worthless.
    const utxo = segwitUtxo(0, FAKE_TXID_1, 0, 500_000n);
    const wrongKey = btgsKey(3);
    expect(() =>
      buildAndSignEvrTx({
        inputs: [{ ...utxo, privateKey: wrongKey.privateKey, publicKey: wrongKey.publicKey }],
        outputs: [{ address: btgsKey(1).address, valueSats: 200_000n }],
        changeAddress: btgsKey(0).address,
        feeSats: 1_000n,
      }),
    ).toThrow(/witness program/i);
  });

  it('refuses a segwit input on a chain that has no segwit', () => {
    const utxo = segwitUtxo(0, FAKE_TXID_1, 0, 500_000n);
    expect(() =>
      buildAndSignEvrTx({
        inputs: [utxo],
        outputs: [{ address: btgsKey(1).address, valueSats: 200_000n }],
        changeAddress: btgsKey(0).address,
        feeSats: 1_000n,
        net: EVRMORE_MAINNET,
      }),
    ).toThrow(/segwit/i);
  });
});

describe('txid vs wtxid', () => {
  it('computes the txid over the STRIPPED serialization and the wtxid over the full one', () => {
    const built = buildAndSignEvrTx({
      inputs: [segwitUtxo(0, FAKE_TXID_1, 0, 500_000n)],
      outputs: [{ address: btgsKey(1).address, valueSats: 200_000n }],
      changeAddress: btgsKey(0).address,
      feeSats: 1_000n,
    });

    const parsed = parseRawTx(built.rawHex);
    const strippedHex = bytesToHex(independentStripped({ ...parsed }));
    // The stripped form carries no marker/flag and no witness.
    expect(strippedHex.length).toBeLessThan(built.rawHex.length);
    expect(strippedHex.slice(8, 12)).not.toBe('0001');

    expect(built.txid).toBe(computeTxid(strippedHex));
    expect(built.wtxid).toBe(computeTxid(built.rawHex));
    expect(built.wtxid).not.toBe(built.txid);
    // Hashing the broadcast bytes would give the WTXID, not the txid: that is the
    // bug this assertion exists to catch.
    expect(computeTxid(built.rawHex)).not.toBe(built.txid);
  });

  it('leaves a legacy-only transaction byte-identical: no marker, wtxid === txid', () => {
    const evrKey = deriveAddress(FIXED_SEED, EVRMORE_MAINNET, 0, 0, 0);
    const evrDest = deriveAddress(FIXED_SEED, EVRMORE_MAINNET, 0, 0, 1);
    const utxo: SignableUtxo = {
      txid: FAKE_TXID_1,
      vout: 0,
      valueSats: 100_000_000n,
      scriptPubKeyHex: bytesToHex(p2pkhScript(hash160(evrKey.publicKey))),
      privateKey: evrKey.privateKey,
      publicKey: evrKey.publicKey,
    };

    const built = buildAndSignEvrTx({
      inputs: [utxo],
      outputs: [{ address: evrDest.address, valueSats: 40_000_000n }],
      changeAddress: evrKey.address,
      feeSats: 100_000n,
      net: EVRMORE_MAINNET,
    });

    const parsed = parseRawTx(built.rawHex);
    expect(parsed.hasWitness).toBe(false);
    expect(parsed.inputs[0].witness.length).toBe(0);
    // Without witness data the two identifiers coincide (BIP141) and the virtual
    // size is exactly the raw byte length — the pre-segwit behaviour.
    expect(built.wtxid).toBe(built.txid);
    expect(built.txid).toBe(computeTxid(built.rawHex));
    expect(built.virtualSize).toBe(built.rawHex.length / 2);
    // The legacy signature still verifies against the LEGACY sighash.
    const sig = parsed.inputs[0].scriptSig;
    const derLen = sig[0];
    const { der, sighashType } = splitSig(sig.slice(1, 1 + derLen));
    expect(sighashType).toBe(0x01);
    const sighash = independentLegacySighash({ ...parsed }, 0, hexToBytes(utxo.scriptPubKeyHex));
    expect(secp256k1.verify(derToCompact(der), sighash, evrKey.publicKey, { lowS: true })).toBe(
      true,
    );
  });
});

describe('mixed legacy + segwit inputs in one transaction', () => {
  it('signs each input with its own algorithm and serializes both witnesses', () => {
    const legacyKey = btgsKey(0);
    const segwitKey = btgsKey(1);
    const dest = btgsKey(2);
    // Input 0: legacy P2PKH ('G…'), input 1: native segwit ('bcg1…').
    const inLegacy = legacyUtxo(0, FAKE_TXID_1, 0, 400_000n);
    const inSegwit = segwitUtxo(1, FAKE_TXID_2, 1, 600_000n);

    const built = buildAndSignEvrTx({
      inputs: [inLegacy, inSegwit],
      outputs: [{ address: dest.address, valueSats: 700_000n }],
      changeAddress: pubkeyToP2pkhAddress(legacyKey.publicKey, BITCOINGOLD_MAINNET),
      feeSats: 2_000n,
      net: BITCOINGOLD_MAINNET,
    });

    const parsed = parseRawTx(built.rawHex);
    expect(parsed.hasWitness).toBe(true);
    expect(parsed.inputs.length).toBe(2);

    // Legacy input: scriptSig filled, witness EMPTY (serialized as a bare 0x00).
    expect(parsed.inputs[0].scriptSig.length).toBeGreaterThan(0);
    expect(parsed.inputs[0].witness.length).toBe(0);
    // Segwit input: scriptSig empty, 2-item witness.
    expect(parsed.inputs[1].scriptSig.length).toBe(0);
    expect(parsed.inputs[1].witness.length).toBe(2);

    // The change output follows the ADDRESS format: a 'G…' change address must
    // produce a P2PKH script even though the transaction is segwit.
    expect(parsed.outputs.length).toBe(2);
    expect(isP2wpkhScript(parsed.outputs[0].scriptPubKey)).toBe(true); // bech32 recipient
    expect(isP2wpkhScript(parsed.outputs[1].scriptPubKey)).toBe(false); // base58 change
    expect(bytesToHex(parsed.outputs[1].scriptPubKey)).toBe(
      bytesToHex(p2pkhScript(hash160(legacyKey.publicKey))),
    );

    const skeleton: Tx = { ...parsed };

    // Input 0 verifies under the LEGACY sighash (recomputed independently).
    const legacySig = parsed.inputs[0].scriptSig;
    const derLen = legacySig[0];
    const legacyParts = splitSig(legacySig.slice(1, 1 + derLen));
    expect(legacyParts.sighashType).toBe(0x01);
    const legacyDigest = independentLegacySighash(
      skeleton,
      0,
      hexToBytes(inLegacy.scriptPubKeyHex),
    );
    expect(
      secp256k1.verify(derToCompact(legacyParts.der), legacyDigest, legacyKey.publicKey, {
        lowS: true,
      }),
    ).toBe(true);

    // Input 1 verifies under the BIP143 digest, which commits to ITS value.
    const segwitParts = splitSig(parsed.inputs[1].witness[0]);
    expect(segwitParts.sighashType).toBe(0x01);
    const segwitDigest = bip143Sighash(
      skeleton,
      1,
      p2wpkhScriptCode(hash160(segwitKey.publicKey)),
      inSegwit.valueSats,
    );
    expect(
      secp256k1.verify(derToCompact(segwitParts.der), segwitDigest, segwitKey.publicKey, {
        lowS: true,
      }),
    ).toBe(true);
    // Signing the segwit input with the LEGACY algorithm would not verify.
    const wrongDigest = independentLegacySighash(skeleton, 1, hexToBytes(inSegwit.scriptPubKeyHex));
    expect(
      secp256k1.verify(derToCompact(segwitParts.der), wrongDigest, segwitKey.publicKey, {
        lowS: true,
      }),
    ).toBe(false);

    expect(built.wtxid).not.toBe(built.txid);
  });
});

describe('virtual size + fee estimation', () => {
  it('vsize = ceil((base*3 + total)/4) for a 1-in / 2-out P2WPKH transaction', () => {
    const built = buildAndSignEvrTx({
      inputs: [segwitUtxo(0, FAKE_TXID_1, 0, 500_000n)],
      outputs: [{ address: btgsKey(1).address, valueSats: 200_000n }],
      changeAddress: btgsKey(0).address,
      feeSats: 1_000n,
    });

    const parsed = parseRawTx(built.rawHex);
    const base = parsed.baseSize;
    const total = parsed.totalSize;

    // Structure of the base form: 4 version + 1 in-count + 41 input +
    // 1 out-count + 31 + 31 (two P2WPKH outputs) + 4 locktime = 113 bytes.
    expect(base).toBe(113);
    // Total adds the 2 marker/flag bytes and the witness (108-110 bytes: stack
    // count 1 + 1 + 71..73 signature + 1 + 33 pubkey).
    expect(total - base).toBeGreaterThanOrEqual(2 + 107);
    expect(total - base).toBeLessThanOrEqual(2 + 110);

    expect(built.virtualSize).toBe(Math.ceil((base * 3 + total) / 4));
    expect(built.virtualSize).toBe(virtualSizeOf(base, total));
    // ~141 vbytes vs ~223 raw bytes: the fee must be priced on the former.
    expect(built.virtualSize).toBeLessThan(total);
    expect(built.virtualSize).toBeGreaterThanOrEqual(140);
    expect(built.virtualSize).toBeLessThanOrEqual(142);
  });

  it('charges a P2WPKH input 68 vbytes and a P2PKH input 148', () => {
    // The marginal cost of one more input of each kind.
    expect(estimateTxVBytes(['p2wpkh', 'p2wpkh'], 2) - estimateTxVBytes(['p2wpkh'], 2)).toBe(68);
    expect(estimateTxVBytes(['p2pkh', 'p2pkh'], 2) - estimateTxVBytes(['p2pkh'], 2)).toBe(148);
    // 1-in/2-out P2WPKH: 10 overhead + 0.5 marker/flag + 68 + 2*34 = 146.5 -> 147.
    expect(estimateTxVBytes(['p2wpkh'], 2)).toBe(147);
    // And it never UNDER-estimates the real transaction.
    const built = buildAndSignEvrTx({
      inputs: [segwitUtxo(0, FAKE_TXID_1, 0, 500_000n)],
      outputs: [{ address: btgsKey(1).address, valueSats: 200_000n }],
      changeAddress: btgsKey(0).address,
      feeSats: 1_000n,
    });
    expect(estimateTxVBytes(['p2wpkh'], 2)).toBeGreaterThanOrEqual(built.virtualSize);
  });

  it('keeps the legacy estimate byte-identical', () => {
    // The historical formula: 10 + 148*inputs + 34*outputs.
    for (const [i, o] of [
      [0, 0],
      [1, 1],
      [1, 2],
      [2, 2],
      [3, 1],
      [7, 5],
    ] as const) {
      expect(estimateTxBytes(i, o)).toBe(10 + 148 * i + 34 * o);
      expect(estimateTxVBytes(new Array<'p2pkh'>(i).fill('p2pkh'), o)).toBe(10 + 148 * i + 34 * o);
    }
  });

  it('selectCoins prices segwit inputs by vsize (cheaper than legacy)', () => {
    const feeRate = 10n;
    const segwit = [segwitUtxo(0, FAKE_TXID_1, 0, 1_000_000n)];
    const legacy = [legacyUtxo(0, FAKE_TXID_1, 0, 1_000_000n)];

    const segwitSel = selectCoins(segwit, 500_000n, feeRate);
    const legacySel = selectCoins(legacy, 500_000n, feeRate);
    expect('error' in segwitSel).toBe(false);
    expect('error' in legacySel).toBe(false);
    if ('error' in segwitSel || 'error' in legacySel) return;

    expect(segwitSel.feeSats).toBe(feeRate * BigInt(estimateSpendVBytes(segwit, 2)));
    expect(legacySel.feeSats).toBe(feeRate * BigInt(estimateTxBytes(1, 2)));
    expect(segwitSel.feeSats).toBeLessThan(legacySel.feeSats);
    // Change absorbs the difference; nothing is created or destroyed.
    expect(segwitSel.changeSats).toBe(1_000_000n - 500_000n - segwitSel.feeSats);
  });

  it('estimateSpendVBytes classifies each UTXO from its own prevout script', () => {
    const mixed = [legacyUtxo(0, FAKE_TXID_1, 0, 1n), segwitUtxo(1, FAKE_TXID_2, 0, 1n)];
    expect(estimateSpendVBytes(mixed, 2)).toBe(estimateTxVBytes(['p2pkh', 'p2wpkh'], 2));
    expect(estimateSpendVBytes(mixed, 2)).toBeLessThan(estimateTxBytes(2, 2));
  });
});

describe('display/internal byte order sanity', () => {
  it('the vector\'s outpoints are stored reversed on the wire', () => {
    const parsed = parseRawTx(BIP143.unsignedHex);
    // The BIP prints the outpoint little-endian; the display txid is its reverse.
    expect(flipHex(parsed.inputs[1].txid)).toBe(
      'ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a',
    );
  });
});
