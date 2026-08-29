// EVM transaction model tests.
//
// Test 1 is the load bearing one: the EIP-155 example transaction, whose
// signing hash and fully signed bytes are published in the EIP text itself. If
// it passes, the field order, the RLP, the EIP-155 chain binding, the low-s
// normalization and the v encoding are all correct against an external
// authority rather than against this repo's own output. Nothing in it may be
// "adjusted to match": a difference means the code is wrong.
//
// The rest prove the properties that matter later: the same model carries an
// ERC-20 transfer with no special case (test 4), the chain is bound into the
// signature (test 5), and the decoder refuses anything malformed (test 7).

import { describe, it, expect } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import { rlpEncode, bigintToRlpBytes } from './rlp';
import {
  signTx,
  signingHash,
  serializeUnsignedTx,
  decodeSignedTx,
  recoverTxPublicKey,
  validateEvmTxRequest,
  EIP1559_TX_TYPE,
  type EvmTxRequest,
} from './tx';

const EIP155_PRIV = hexToBytes('4646464646464646464646464646464646464646464646464646464646464646');
// A second key, so the 1559 tests are not all the same signer.
const PRIV_B = hexToBytes('c87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3');

const ADDRESS_A = '0x3535353535353535353535353535353535353535';
const ADDRESS_B = '0x00000000219ab540356cbb839cbe05303d7705fa';
const ADDRESS_C = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // USDC on Base

const hex = (b: Uint8Array): string => bytesToHex(b);

/** The EIP-155 example transaction, byte for byte from the EIP text. */
const EIP155_TX: EvmTxRequest = {
  chainId: 1,
  nonce: 9n,
  to: ADDRESS_A,
  value: 10n ** 18n,
  data: new Uint8Array(0),
  gasLimit: 21000n,
  fee: { type: 'legacy', gasPrice: 20000000000n },
};

/** A plain EIP-1559 transfer on Base. */
const BASE_TX: EvmTxRequest = {
  chainId: 8453,
  nonce: 0n,
  to: ADDRESS_B,
  value: 1n * 10n ** 15n,
  data: new Uint8Array(0),
  gasLimit: 21000n,
  fee: { type: 'eip1559', maxFeePerGas: 100000000n, maxPriorityFeePerGas: 1000000n },
};

/** ERC-20 transfer(address,uint256) calldata, built by hand in the test. */
function erc20TransferData(to: string, amount: bigint): Uint8Array {
  const selector = hexToBytes('a9059cbb'); // keccak256("transfer(address,uint256)")[0..4]
  const toWord = new Uint8Array(32);
  toWord.set(hexToBytes(to.slice(2).toLowerCase()), 12); // left padded to 32 bytes
  const amountWord = new Uint8Array(32);
  const amountBytes = bigintToRlpBytes(amount);
  amountWord.set(amountBytes, 32 - amountBytes.length);
  return concatBytes(selector, toWord, amountWord);
}

describe('1. the EIP-155 vector', () => {
  it('produces the signing hash published in EIP-155', () => {
    expect('0x' + hex(signingHash(EIP155_TX))).toBe(
      '0xdaf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53',
    );
  });

  it('serializes the unsigned transaction with chainId, 0, 0 in the signature slots', () => {
    // rlp([9, 20 gwei, 21000, to, 1 ether, "", 1, 0, 0])
    expect('0x' + hex(serializeUnsignedTx(EIP155_TX))).toBe(
      '0xec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008' +
        '0018080',
    );
  });

  it('produces the signed bytes published in EIP-155', () => {
    const signed = signTx(EIP155_TX, EIP155_PRIV);
    const expected =
      '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080' +
      '25' +
      'a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276' +
      'a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83';
    expect(signed.rawHex).toBe(expected);
    expect('0x' + hex(signed.raw)).toBe(expected);
    expect(signed.v).toBe(37n); // 0x25 = chainId 1 * 2 + 35 + yParity 0
    expect(signed.yParity).toBe(0);
    expect(signed.r).toBe(
      0x28ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276n,
    );
    expect(signed.s).toBe(
      0x67cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83n,
    );
    expect(signed.hash).toBe('0x' + hex(keccak_256(signed.raw)));
  });
});

describe('2. legacy round trip', () => {
  it('decodes back to the request that was signed', () => {
    const signed = signTx(EIP155_TX, EIP155_PRIV);
    const decoded = decodeSignedTx(signed.raw);

    expect(decoded.tx).toEqual(EIP155_TX);
    expect(decoded.tx.value).toBe(10n ** 18n);
    expect(decoded.r).toBe(signed.r);
    expect(decoded.s).toBe(signed.s);
    expect(decoded.v).toBe(signed.v);
    expect(decoded.yParity).toBe(signed.yParity);
    expect(decoded.hash).toBe(signed.hash);
  });

  it('accepts the 0x hex form as well as bytes', () => {
    const signed = signTx(EIP155_TX, EIP155_PRIV);
    expect(decodeSignedTx(signed.rawHex).tx).toEqual(EIP155_TX);
  });

  it('recovers the signer public key', () => {
    const signed = signTx(EIP155_TX, EIP155_PRIV);
    expect(hex(recoverTxPublicKey(signed.raw))).toBe(
      hex(secp256k1.getPublicKey(EIP155_PRIV, false)),
    );
    expect(recoverTxPublicKey(signed.raw).length).toBe(65);
  });
});

describe('3. EIP-1559 on Base (chainId 8453)', () => {
  it('signs into a 0x02 typed envelope that round trips field for field', () => {
    const signed = signTx(BASE_TX, PRIV_B);

    expect(signed.raw[0]).toBe(0x02);
    expect(signed.raw[0]).toBe(EIP1559_TX_TYPE);
    expect(serializeUnsignedTx(BASE_TX)[0]).toBe(0x02);

    const decoded = decodeSignedTx(signed.raw);
    expect(decoded.tx).toEqual(BASE_TX);
    expect(decoded.tx.chainId).toBe(8453);
    expect(decoded.tx.nonce).toBe(0n);
    expect(decoded.tx.to).toBe(ADDRESS_B);
    expect(decoded.tx.value).toBe(10n ** 15n);
    expect(decoded.tx.gasLimit).toBe(21000n);
    expect(decoded.tx.fee).toEqual({
      type: 'eip1559',
      maxFeePerGas: 100000000n,
      maxPriorityFeePerGas: 1000000n,
    });

    expect(signed.hash).toBe('0x' + hex(keccak_256(signed.raw)));
    expect(decoded.hash).toBe(signed.hash);
    expect([0, 1]).toContain(signed.yParity);
    expect(signed.v).toBe(BigInt(signed.yParity));
    expect(decoded.v).toBe(signed.v);
    expect(hex(recoverTxPublicKey(signed.raw))).toBe(hex(secp256k1.getPublicKey(PRIV_B, false)));
  });

  it('puts the priority fee before the max fee, as EIP-1559 orders them', () => {
    // Rebuild the payload here rather than trusting tx.ts's own ordering.
    const expected = concatBytes(
      Uint8Array.of(0x02),
      rlpEncode([
        bigintToRlpBytes(8453n),
        bigintToRlpBytes(0n),
        bigintToRlpBytes(1000000n), // maxPriorityFeePerGas first
        bigintToRlpBytes(100000000n), // then maxFeePerGas
        bigintToRlpBytes(21000n),
        hexToBytes(ADDRESS_B.slice(2)),
        bigintToRlpBytes(10n ** 15n),
        new Uint8Array(0),
        [],
      ]),
    );
    expect(hex(serializeUnsignedTx(BASE_TX))).toBe(hex(expected));
  });
});

describe('4. the same model carries ERC-20 calldata', () => {
  const data = erc20TransferData(ADDRESS_A, 1234567890123456789n);
  const tokenTx: EvmTxRequest = {
    ...BASE_TX,
    to: ADDRESS_C, // the token contract, not the recipient
    value: 0n, // an ERC-20 transfer moves no native coin
    data,
    gasLimit: 65000n,
  };

  it('builds 68 bytes of calldata with the transfer selector', () => {
    expect(data.length).toBe(4 + 32 + 32);
    expect(hex(data.subarray(0, 4))).toBe('a9059cbb');
    expect(hex(data.subarray(4, 36))).toBe('0'.repeat(24) + ADDRESS_A.slice(2));
    expect(hex(data.subarray(36))).toBe('0'.repeat(48) + '112210f47de98115');
  });

  it('round trips with the data intact, through the same code path as a native send', () => {
    const signed = signTx(tokenTx, PRIV_B);
    const decoded = decodeSignedTx(signed.raw);

    expect(decoded.tx).toEqual(tokenTx);
    expect(hex(decoded.tx.data)).toBe(hex(data));
    expect(decoded.tx.value).toBe(0n);
    expect(hex(recoverTxPublicKey(signed.raw))).toBe(hex(secp256k1.getPublicKey(PRIV_B, false)));
  });

  it('signs a different hash than the same request with empty data', () => {
    const bare: EvmTxRequest = { ...tokenTx, data: new Uint8Array(0) };
    expect(hex(signingHash(tokenTx))).not.toBe(hex(signingHash(bare)));
  });
});

describe('5. the chain is bound into the signature', () => {
  it('gives a different signing hash and different bytes on 8453 vs 56', () => {
    const base: EvmTxRequest = BASE_TX;
    const bsc: EvmTxRequest = { ...BASE_TX, chainId: 56 };

    expect(hex(signingHash(base))).not.toBe(hex(signingHash(bsc)));

    const signedBase = signTx(base, PRIV_B);
    const signedBsc = signTx(bsc, PRIV_B);
    expect(signedBase.rawHex).not.toBe(signedBsc.rawHex);
    expect(signedBase.hash).not.toBe(signedBsc.hash);

    expect(decodeSignedTx(signedBase.raw).tx.chainId).toBe(8453);
    expect(decodeSignedTx(signedBsc.raw).tx.chainId).toBe(56);
  });

  it('derives a legacy chainId back out of v', () => {
    const bscLegacy: EvmTxRequest = {
      ...EIP155_TX,
      chainId: 56,
      fee: { type: 'legacy', gasPrice: 3000000000n },
    };
    const signed = signTx(bscLegacy, EIP155_PRIV);
    // v = 56*2 + 35 + yParity
    expect(signed.v).toBe(56n * 2n + 35n + BigInt(signed.yParity));

    const decoded = decodeSignedTx(signed.raw);
    expect(decoded.tx.chainId).toBe(56);
    expect(decoded.v).toBe(signed.v);
    expect(decoded.yParity).toBe(signed.yParity);
    expect(hex(recoverTxPublicKey(signed.raw))).toBe(
      hex(secp256k1.getPublicKey(EIP155_PRIV, false)),
    );
  });
});

describe('6. validateEvmTxRequest', () => {
  it('accepts the valid requests used above', () => {
    expect(() => validateEvmTxRequest(EIP155_TX)).not.toThrow();
    expect(() => validateEvmTxRequest(BASE_TX)).not.toThrow();
  });

  it('rejects chainId 0', () => {
    expect(() => validateEvmTxRequest({ ...BASE_TX, chainId: 0 })).toThrow(
      /chainId must be a positive integer/,
    );
    expect(() => validateEvmTxRequest({ ...BASE_TX, chainId: -1 })).toThrow(/chainId/);
    expect(() => validateEvmTxRequest({ ...BASE_TX, chainId: 1.5 })).toThrow(/chainId/);
  });

  it('rejects a negative value', () => {
    expect(() => validateEvmTxRequest({ ...BASE_TX, value: -1n })).toThrow(
      /value must not be negative/,
    );
  });

  it('rejects gasLimit 0', () => {
    expect(() => validateEvmTxRequest({ ...BASE_TX, gasLimit: 0n })).toThrow(
      /gasLimit must be greater than zero/,
    );
  });

  it('rejects a `to` without 0x and a `to` of 39 characters', () => {
    expect(() =>
      validateEvmTxRequest({ ...BASE_TX, to: '3535353535353535353535353535353535353535' }),
    ).toThrow(/to must be 0x followed by 40 hex characters/);
    expect(() =>
      validateEvmTxRequest({ ...BASE_TX, to: '0x' + '3'.repeat(39) }),
    ).toThrow(/to must be 0x followed by 40 hex characters/);
    expect(() => validateEvmTxRequest({ ...BASE_TX, to: '0x' + 'z'.repeat(40) })).toThrow(/to/);
  });

  it('accepts a mixed case (checksummed) address, since checksums are keys.ts work', () => {
    expect(() =>
      validateEvmTxRequest({ ...BASE_TX, to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }),
    ).not.toThrow();
  });

  it('rejects a priority fee above the max fee', () => {
    expect(() =>
      validateEvmTxRequest({
        ...BASE_TX,
        fee: { type: 'eip1559', maxFeePerGas: 1000n, maxPriorityFeePerGas: 1001n },
      }),
    ).toThrow(/maxPriorityFeePerGas must not exceed maxFeePerGas/);
  });

  it('rejects a nonce of 2^64 and a negative nonce', () => {
    expect(() => validateEvmTxRequest({ ...BASE_TX, nonce: 2n ** 64n })).toThrow(
      /nonce must be below 2\^64/,
    );
    expect(() => validateEvmTxRequest({ ...BASE_TX, nonce: -1n })).toThrow(
      /nonce must not be negative/,
    );
  });

  it('rejects a number where a bigint belongs, because wei does not fit in a number', () => {
    expect(() =>
      validateEvmTxRequest({ ...BASE_TX, value: 1000 as unknown as bigint }),
    ).toThrow(/value must be a bigint/);
    expect(() =>
      validateEvmTxRequest({
        ...BASE_TX,
        fee: { type: 'legacy', gasPrice: 20000000000 as unknown as bigint },
      }),
    ).toThrow(/gasPrice must be a bigint/);
  });

  it('rejects negative fee fields and an unknown fee type', () => {
    expect(() =>
      validateEvmTxRequest({ ...BASE_TX, fee: { type: 'legacy', gasPrice: -1n } }),
    ).toThrow(/gasPrice must not be negative/);
    expect(() =>
      validateEvmTxRequest({
        ...BASE_TX,
        fee: { type: 'eip1559', maxFeePerGas: -1n, maxPriorityFeePerGas: -2n },
      }),
    ).toThrow(/must not be negative/);
    expect(() =>
      validateEvmTxRequest({
        ...BASE_TX,
        fee: { type: 'eip4844' } as unknown as EvmTxRequest['fee'],
      }),
    ).toThrow(/fee.type must be eip1559 or legacy/);
  });

  it('is enforced by serializeUnsignedTx, so no caller can skip it', () => {
    expect(() => serializeUnsignedTx({ ...BASE_TX, gasLimit: 0n })).toThrow(/gasLimit/);
    expect(() => signTx({ ...BASE_TX, chainId: 0 }, PRIV_B)).toThrow(/chainId/);
  });
});

describe('7. decodeSignedTx strictness', () => {
  it('rejects an unknown type byte 0x03', () => {
    const signed = signTx(BASE_TX, PRIV_B);
    const blob = signed.raw.slice();
    blob[0] = 0x03;
    expect(() => decodeSignedTx(blob)).toThrow(/unsupported transaction type 0x03/);
  });

  it('rejects a legacy list with 8 items', () => {
    const eight = rlpEncode([
      bigintToRlpBytes(9n),
      bigintToRlpBytes(20000000000n),
      bigintToRlpBytes(21000n),
      hexToBytes(ADDRESS_A.slice(2)),
      bigintToRlpBytes(10n ** 18n),
      new Uint8Array(0),
      bigintToRlpBytes(37n),
      bigintToRlpBytes(1n),
    ]);
    expect(() => decodeSignedTx(eight)).toThrow(/legacy transaction must have 9 fields, got 8/);
  });

  it('rejects trailing bytes on both envelopes', () => {
    const legacy = signTx(EIP155_TX, EIP155_PRIV);
    expect(() => decodeSignedTx(concatBytes(legacy.raw, Uint8Array.of(0x00)))).toThrow(
      /trailing bytes/,
    );
    const typed = signTx(BASE_TX, PRIV_B);
    expect(() => decodeSignedTx(concatBytes(typed.raw, Uint8Array.of(0x00)))).toThrow(
      /trailing bytes/,
    );
  });

  it('rejects a non empty access list', () => {
    const withAccessList = concatBytes(
      Uint8Array.of(0x02),
      rlpEncode([
        bigintToRlpBytes(8453n),
        bigintToRlpBytes(0n),
        bigintToRlpBytes(1000000n),
        bigintToRlpBytes(100000000n),
        bigintToRlpBytes(21000n),
        hexToBytes(ADDRESS_B.slice(2)),
        bigintToRlpBytes(10n ** 15n),
        new Uint8Array(0),
        [[hexToBytes(ADDRESS_A.slice(2)), []]],
        bigintToRlpBytes(0n),
        bigintToRlpBytes(1n),
        bigintToRlpBytes(1n),
      ]),
    );
    expect(() => decodeSignedTx(withAccessList)).toThrow(/access lists are not supported/);
  });

  it('rejects a high-s signature and an out of range r', () => {
    const signed = signTx(BASE_TX, PRIV_B);
    const decoded = decodeSignedTx(signed.raw);
    const highS = secp256k1.CURVE.n - decoded.s; // the malleable twin
    const rebuild = (r: bigint, s: bigint): Uint8Array =>
      concatBytes(
        Uint8Array.of(0x02),
        rlpEncode([
          bigintToRlpBytes(8453n),
          bigintToRlpBytes(0n),
          bigintToRlpBytes(1000000n),
          bigintToRlpBytes(100000000n),
          bigintToRlpBytes(21000n),
          hexToBytes(ADDRESS_B.slice(2)),
          bigintToRlpBytes(10n ** 15n),
          new Uint8Array(0),
          [],
          bigintToRlpBytes(BigInt(decoded.yParity)),
          bigintToRlpBytes(r),
          bigintToRlpBytes(s),
        ]),
      );
    expect(() => decodeSignedTx(rebuild(decoded.r, highS))).toThrow(/not low-s/);
    expect(() => decodeSignedTx(rebuild(secp256k1.CURVE.n, decoded.s))).toThrow(/r out of range/);
    expect(() => decodeSignedTx(rebuild(0n, decoded.s))).toThrow(/r out of range/);
  });

  it('rejects a pre-EIP-155 legacy v of 27', () => {
    const noChain = rlpEncode([
      bigintToRlpBytes(9n),
      bigintToRlpBytes(20000000000n),
      bigintToRlpBytes(21000n),
      hexToBytes(ADDRESS_A.slice(2)),
      bigintToRlpBytes(10n ** 18n),
      new Uint8Array(0),
      bigintToRlpBytes(27n),
      bigintToRlpBytes(1n),
      bigintToRlpBytes(1n),
    ]);
    expect(() => decodeSignedTx(noChain)).toThrow(/legacy v must be EIP-155/);
  });

  it('rejects an empty `to` (contract creation) and a short `to`', () => {
    const build = (to: Uint8Array): Uint8Array =>
      rlpEncode([
        bigintToRlpBytes(9n),
        bigintToRlpBytes(20000000000n),
        bigintToRlpBytes(21000n),
        to,
        bigintToRlpBytes(10n ** 18n),
        new Uint8Array(0),
        bigintToRlpBytes(37n),
        bigintToRlpBytes(1n),
        bigintToRlpBytes(1n),
      ]);
    expect(() => decodeSignedTx(build(new Uint8Array(0)))).toThrow(/to must be 20 bytes/);
    expect(() => decodeSignedTx(build(new Uint8Array(19)))).toThrow(/to must be 20 bytes/);
  });

  it('rejects empty input, a top level RLP string, and non hex', () => {
    expect(() => decodeSignedTx(new Uint8Array(0))).toThrow(/empty raw transaction/);
    expect(() => decodeSignedTx('0x83646f67')).toThrow(/not a typed envelope or an RLP list/);
    expect(() => decodeSignedTx('0xzz')).toThrow(/not hex/);
    expect(() => decodeSignedTx('0xabc')).toThrow(/odd length/);
  });

  it('rejects a non canonical integer field (leading zero byte)', () => {
    // nonce 9 spelled as 0x0009 is a second encoding of the same transaction.
    const nonCanonical = rlpEncode([
      hexToBytes('0009'),
      bigintToRlpBytes(20000000000n),
      bigintToRlpBytes(21000n),
      hexToBytes(ADDRESS_A.slice(2)),
      bigintToRlpBytes(10n ** 18n),
      new Uint8Array(0),
      bigintToRlpBytes(37n),
      bigintToRlpBytes(1n),
      bigintToRlpBytes(1n),
    ]);
    expect(() => decodeSignedTx(nonCanonical)).toThrow(/non canonical integer/);
  });
});

describe('8. determinism', () => {
  it('signs the same request twice into identical bytes (RFC 6979)', () => {
    const a = signTx(EIP155_TX, EIP155_PRIV);
    const b = signTx(EIP155_TX, EIP155_PRIV);
    expect(a.rawHex).toBe(b.rawHex);
    expect(a.hash).toBe(b.hash);
    expect(a.r).toBe(b.r);
    expect(a.s).toBe(b.s);

    const c = signTx(BASE_TX, PRIV_B);
    const d = signTx(BASE_TX, PRIV_B);
    expect(c.rawHex).toBe(d.rawHex);
    expect(c.hash).toBe(d.hash);
  });

  it('rejects a private key that is not 32 bytes', () => {
    expect(() => signTx(BASE_TX, new Uint8Array(31))).toThrow(/private key must be 32 bytes/);
    expect(() => signTx(BASE_TX, 'deadbeef' as unknown as Uint8Array)).toThrow(
      /private key must be 32 bytes/,
    );
  });
});

describe('9. signatures are canonical low-s', () => {
  it('keeps s in the lower half of the curve order', () => {
    const half = secp256k1.CURVE.n / 2n;
    for (const [tx, priv] of [
      [EIP155_TX, EIP155_PRIV],
      [BASE_TX, PRIV_B],
      [{ ...BASE_TX, chainId: 56 }, PRIV_B],
      [{ ...EIP155_TX, nonce: 17n }, EIP155_PRIV],
    ] as Array<[EvmTxRequest, Uint8Array]>) {
      const signed = signTx(tx, priv);
      expect(signed.s > 0n).toBe(true);
      expect(signed.s <= half).toBe(true);
      expect(signed.r > 0n).toBe(true);
      expect(signed.r < secp256k1.CURVE.n).toBe(true);
      // A node checks the same thing, so prove it survives a decode too.
      expect(decodeSignedTx(signed.raw).s).toBe(signed.s);
    }
  });
});
