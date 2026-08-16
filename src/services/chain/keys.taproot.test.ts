// Paying TO taproot (P2TR, witness v1, `bc1p…`) addresses.
//
// SPENDING FROM taproot is deliberately out of scope: this wallet derives no
// taproot keys and signs no key-path/script-path spends. Paying to one only
// needs the output script, which is why this is a keys.ts-only change.
//
// Anchored on the OFFICIAL BIP350 test vectors (both the valid and the invalid
// lists) rather than on this wallet's own output, so the encoder and the two
// checksums are verified against the published standard.
//
// THE POINT OF THE INVALID LIST (BIP350): witness v0 uses the bech32 checksum
// constant and witness v1+ uses the bech32m one. They are NOT interchangeable.
// If either checksum were accepted for either version, a typo'd address that
// happened to satisfy the wrong constant would validate and the send would go to
// an address nobody controls. The two "Invalid checksum (Bech32 instead of
// Bech32m)" / "(Bech32m instead of Bech32)" vectors below are what prove that
// cannot happen here — they are byte-for-byte the SAME witness programs as the
// valid vectors, differing only in which constant signed them.

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import {
  addressToElectrumScripthash,
  addressToScript,
  decodeSegwitAddress,
  isSpendableAddress,
  isValidAddress,
  p2trScript,
  p2wpkhScript,
  parseWitnessAddress,
  witnessProgramScript,
} from './keys';
import {
  BITCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  EVRMORE_MAINNET,
  LITECOIN_MAINNET,
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  supportsSegwit,
  supportsTaproot,
} from './chainParams';

// The canonical BIP350 P2TR vector: the taproot output key is secp256k1's
// generator point x-coordinate, so the expected script is public knowledge.
const BIP350_P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
const BIP350_P2TR_PROGRAM = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const BIP350_P2TR_SCRIPT = `5120${BIP350_P2TR_PROGRAM}`;

// The BIP173 P2WPKH vector, re-asserted here to prove witness v0 is unchanged.
const BIP173_P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BIP173_P2WPKH_SCRIPT = '0014751e76e8199196d454941c45d1b3a323f1433bd6';

// A stand-in for a chain whose hrp is 'bc'. Built by overriding one field on a
// shipped chain rather than importing a Bitcoin entry, so this file stays
// independent of chainParams edits happening in parallel. Only bech32Hrp is read
// by the code under test.
const HRP_BC = { ...LITECOIN_MAINNET, bech32Hrp: 'bc' };

/** BIP350 "Valid segwit addresses": address -> scriptPubKey, verbatim. */
const BIP350_VALID: ReadonlyArray<readonly [string, string]> = [
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', '0014751e76e8199196d454941c45d1b3a323f1433bd6'],
  [
    'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
    '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262',
  ],
  [
    'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
    '5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6',
  ],
  ['BC1SW50QGDZ25J', '6002751e'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', '5210751e76e8199196d454941c45d1b3a323'],
  [
    'tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy',
    '0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433',
  ],
  [
    'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c',
    '5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433',
  ],
  [BIP350_P2TR, BIP350_P2TR_SCRIPT],
];

/**
 * BIP350 "Invalid segwit addresses", verbatim, with the BIP's own reason.
 *
 * `tc1p…` is excluded and handled separately: its stated reason is "Invalid
 * human-readable part", which is a CHAIN question, not an encoding one. Our
 * format layer is deliberately chain-agnostic (it has to be — every chain here
 * has a different hrp), so 'tc' is rejected one layer up by isSpendableAddress /
 * isValidAddress, which is what the dedicated test below asserts.
 */
const BIP350_INVALID: ReadonlyArray<readonly [string, string]> = [
  [
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',
    'Invalid checksum (Bech32 instead of Bech32m)',
  ],
  [
    'tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf',
    'Invalid checksum (Bech32 instead of Bech32m)',
  ],
  [
    'BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL',
    'Invalid checksum (Bech32 instead of Bech32m)',
  ],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', 'Invalid checksum (Bech32m instead of Bech32)'],
  [
    'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47',
    'Invalid checksum (Bech32m instead of Bech32)',
  ],
  [
    'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4',
    'Invalid character in checksum',
  ],
  ['BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R', 'Invalid witness version'],
  ['bc1pw5dgrnzv', 'Invalid program length (1 byte)'],
  [
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav',
    'Invalid program length (41 bytes)',
  ],
  [
    'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P',
    'Invalid program length for witness version 0 (per BIP141)',
  ],
  ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq', 'Mixed case'],
  [
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf',
    'zero padding of more than 4 bits',
  ],
  [
    'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j',
    'Non-zero padding in 8-to-5 conversion',
  ],
  ['bc1gmk9yu', 'Empty data section'],
];

describe('BIP350 published vectors', () => {
  it.each(BIP350_VALID)('decodes %s to its published scriptPubKey', (address, scriptPubKey) => {
    const decoded = parseWitnessAddress(address);
    expect(decoded).not.toBeNull();
    // Encoding the parsed program back out must reproduce the BIP's own hex,
    // which pins the version opcode (OP_0 = 0x00, OP_1..OP_16 = 0x51..0x60) and
    // the direct push length together.
    expect(bytesToHex(witnessProgramScript(decoded!.witnessVersion, decoded!.program))).toBe(
      scriptPubKey,
    );
    // The scriptPubKey's first byte is the version opcode; cross-check the
    // parsed version against it independently of the encoder.
    const versionOpcode = parseInt(scriptPubKey.slice(0, 2), 16);
    expect(decoded!.witnessVersion).toBe(versionOpcode === 0x00 ? 0 : versionOpcode - 0x50);
  });

  it.each(BIP350_INVALID)('rejects %s (%s)', (address) => {
    expect(parseWitnessAddress(address)).toBeNull();
    expect(decodeSegwitAddress(address)).toBeNull();
    // And it can never become a payment target on any chain, whatever the hrp.
    for (const net of [HRP_BC, BITCOINGOLD_MAINNET, LITECOIN_MAINNET, EVRMORE_MAINNET]) {
      expect(isSpendableAddress(address, net)).toBe(false);
    }
  });

  it('proves the two checksums are NOT interchangeable', () => {
    // Same 32-byte taproot program, same hrp — only the checksum constant
    // differs. bech32m is correct for v1, bech32 is not.
    const v1WithBech32m = BIP350_P2TR;
    const v1WithBech32 = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd';
    expect(v1WithBech32m.slice(0, -6)).toBe(v1WithBech32.slice(0, -6)); // only the checksum differs
    expect(parseWitnessAddress(v1WithBech32m)).not.toBeNull();
    expect(parseWitnessAddress(v1WithBech32)).toBeNull();

    // Same 20-byte P2WPKH program, same hrp — bech32 is correct for v0,
    // bech32m is not. This is the mirror image, and getting the pair backwards
    // is exactly the bug this test exists to catch.
    const v0WithBech32 = BIP173_P2WPKH;
    const v0WithBech32m = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh';
    expect(v0WithBech32.slice(0, -6)).toBe(v0WithBech32m.slice(0, -6));
    expect(parseWitnessAddress(v0WithBech32)).not.toBeNull();
    expect(parseWitnessAddress(v0WithBech32m)).toBeNull();
  });
});

describe('paying to taproot', () => {
  it('builds the published P2TR scriptPubKey for the BIP350 vector', () => {
    const decoded = decodeSegwitAddress(BIP350_P2TR);
    expect(decoded).not.toBeNull();
    expect(decoded!.hrp).toBe('bc');
    expect(decoded!.witnessVersion).toBe(1);
    expect(decoded!.program).toEqual(hexToBytes(BIP350_P2TR_PROGRAM));
    expect(decoded!.program.length).toBe(32);

    // OP_1 (0x51) PUSH32 (0x20) <x-only output key>.
    expect(bytesToHex(addressToScript(BIP350_P2TR))).toBe(BIP350_P2TR_SCRIPT);
    expect(addressToScript(BIP350_P2TR)).toEqual(p2trScript(hexToBytes(BIP350_P2TR_PROGRAM)));
    // The version opcode is the SMALL-INTEGER opcode, never a data push of 1.
    expect(addressToScript(BIP350_P2TR)[0]).toBe(0x51);
    expect(addressToScript(BIP350_P2TR)[1]).toBe(0x20);
    expect(addressToScript(BIP350_P2TR).length).toBe(34);
  });

  it('accepts a taproot recipient on a chain with segwit and a matching hrp', () => {
    expect(isSpendableAddress(BIP350_P2TR, HRP_BC)).toBe(true);
    expect(isValidAddress(BIP350_P2TR, HRP_BC)).toBe(true);
  });

  it('subscribes to the taproot script, not a P2PKH one, for Electrum', () => {
    // addressToElectrumScripthash hashes whatever addressToScript emits, so a
    // taproot address must hash the 5120… script. Recomputed here from the
    // published scriptPubKey hex so the expectation is independent of keys.ts.
    const expected = bytesToHex(sha256(hexToBytes(BIP350_P2TR_SCRIPT)).reverse());
    expect(addressToElectrumScripthash(BIP350_P2TR)).toBe(expected);
    expect(addressToElectrumScripthash(BIP350_P2TR)).not.toBe(
      addressToElectrumScripthash(BIP173_P2WPKH),
    );
  });
});

describe('taproot is still chain-scoped (funds-loss guard)', () => {
  it('rejects a bc1p recipient on every chain whose hrp is not bc', () => {
    // Segwit chains with a DIFFERENT hrp: the program is fine, the chain is not.
    expect(BITCOINGOLD_MAINNET.bech32Hrp).toBe('bcg');
    expect(LITECOIN_MAINNET.bech32Hrp).toBe('ltc');
    expect(isSpendableAddress(BIP350_P2TR, BITCOINGOLD_MAINNET)).toBe(false);
    expect(isSpendableAddress(BIP350_P2TR, LITECOIN_MAINNET)).toBe(false);
    expect(isValidAddress(BIP350_P2TR, BITCOINGOLD_MAINNET)).toBe(false);
    expect(isValidAddress(BIP350_P2TR, LITECOIN_MAINNET)).toBe(false);
  });

  it('rejects a bc1p recipient on legacy chains with no segwit at all', () => {
    // No bech32Hrp => no witness outputs of any version are constructible, and a
    // witness output on such a chain would be an anyone-can-spend bare script.
    for (const net of [EVRMORE_MAINNET, RAVENCOIN_MAINNET, WOJAKCOIN_MAINNET]) {
      expect(net.bech32Hrp).toBeUndefined();
      expect(isSpendableAddress(BIP350_P2TR, net)).toBe(false);
      expect(isValidAddress(BIP350_P2TR, net)).toBe(false);
    }
  });

  it("rejects BIP350's `tc1p…` vector, whose hrp belongs to no chain here", () => {
    // BIP350 calls this one "Invalid human-readable part". The format layer is
    // chain-agnostic and parses it; the CHAIN layer is what must refuse it.
    const tc1p = 'tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut';
    expect(parseWitnessAddress(tc1p)!.hrp).toBe('tc');
    for (const net of [HRP_BC, BITCOINGOLD_MAINNET, LITECOIN_MAINNET, EVRMORE_MAINNET]) {
      expect(isSpendableAddress(tc1p, net)).toBe(false);
    }
  });
});

describe('what stays rejected', () => {
  it('refuses a witness v1 program that is not 32 bytes (BIP341)', () => {
    // BIP350 lists this among its VALID ADDRESSES (a 40-byte v1 program), and it
    // is indeed a well-formed bech32m address — parseWitnessAddress returns it.
    // But BIP341 leaves a v1 output of any length other than 32 UNENCUMBERED, so
    // paying it is a gift to the first miner who notices. Address-valid is not
    // safe-to-pay, and the wallet-facing decoder draws that line.
    const v1WrongLength =
      'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y';
    expect(parseWitnessAddress(v1WrongLength)!.program.length).toBe(40);
    expect(decodeSegwitAddress(v1WrongLength)).toBeNull();
    expect(isSpendableAddress(v1WrongLength, HRP_BC)).toBe(false);
    expect(() => addressToScript(v1WrongLength)).toThrow();
  });

  it('refuses witness v2..v16, which are unencumbered under today’s consensus', () => {
    // Both are BIP350 VALID addresses on hrp 'bc'. They decode, and the encoder
    // can express them, but paying one would be anyone-can-spend.
    for (const address of ['BC1SW50QGDZ25J', 'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs']) {
      const decoded = decodeSegwitAddress(address);
      expect(decoded!.witnessVersion).toBeGreaterThan(1);
      expect(isSpendableAddress(address, HRP_BC)).toBe(false);
      expect(() => addressToScript(address)).toThrow(/not supported/);
    }
  });

  it('refuses P2WSH (32-byte witness program at version ZERO)', () => {
    // Unchanged from before taproot. A v0/32 program is the hash of a redeem
    // script the payer never sees, so a burn/vanity string is indistinguishable
    // from a real one — BTGS's published burn address below is exactly that. A
    // v1/32 program is not a hash but the taproot output KEY, which always has a
    // key-path spend; that asymmetry is why v1 is payable and v0/32 is not.
    const burn = 'bcg1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnmxfsvxdead';
    const decoded = decodeSegwitAddress(burn);
    expect(decoded!.witnessVersion).toBe(0);
    expect(decoded!.program.length).toBe(32);
    expect(isSpendableAddress(burn, BITCOINGOLD_MAINNET)).toBe(false);
    expect(() => addressToScript(burn)).toThrow(/P2WPKH/);

    // The BIP350 mainnet P2WSH vector behaves the same way on an 'bc' chain.
    const p2wsh = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';
    expect(decodeSegwitAddress(p2wsh)!.program.length).toBe(32);
    expect(isSpendableAddress(p2wsh, { ...LITECOIN_MAINNET, bech32Hrp: 'tb' })).toBe(false);
  });
});

describe('witness v0 behaviour is unchanged', () => {
  it('re-asserts the BIP173 P2WPKH vector end to end', () => {
    const h160 = hexToBytes('751e76e8199196d454941c45d1b3a323f1433bd6');
    const decoded = decodeSegwitAddress(BIP173_P2WPKH);
    expect(decoded).not.toBeNull();
    expect(decoded!.hrp).toBe('bc');
    expect(decoded!.witnessVersion).toBe(0);
    expect(decoded!.program).toEqual(h160);
    expect(bytesToHex(addressToScript(BIP173_P2WPKH))).toBe(BIP173_P2WPKH_SCRIPT);
    expect(addressToScript(BIP173_P2WPKH)).toEqual(p2wpkhScript(h160));
    expect(isSpendableAddress(BIP173_P2WPKH, HRP_BC)).toBe(true);
    // Uppercase is the same address (BIP173 allows either case, not both).
    expect(decodeSegwitAddress(BIP173_P2WPKH.toUpperCase())!.program).toEqual(h160);
    expect(decodeSegwitAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7Kv8f3t4')).toBeNull();
  });

  it('keeps witness v0 on the bech32 checksum only', () => {
    // A v0 program re-signed with bech32m must not decode — already covered by
    // the BIP350 vector, restated here as the v0 regression guard.
    expect(decodeSegwitAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh')).toBeNull();
    expect(isSpendableAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', HRP_BC)).toBe(false);
  });
});

describe('witnessProgramScript encoding rules (BIP141)', () => {
  it('uses OP_0 for v0 and the small-integer opcodes for v1..v16', () => {
    const p32 = hexToBytes(BIP350_P2TR_PROGRAM);
    expect(witnessProgramScript(0, hexToBytes('751e76e8199196d454941c45d1b3a323f1433bd6'))[0]).toBe(
      0x00,
    );
    for (let v = 1; v <= 16; v++) {
      expect(witnessProgramScript(v, p32)[0]).toBe(0x50 + v);
      expect(witnessProgramScript(v, p32)[1]).toBe(32); // direct push, no OP_PUSHDATA
    }
    expect(witnessProgramScript(16, hexToBytes('751e'))).toEqual(hexToBytes('6002751e'));
  });

  it('refuses out-of-range versions and program lengths', () => {
    const p32 = hexToBytes(BIP350_P2TR_PROGRAM);
    expect(() => witnessProgramScript(-1, p32)).toThrow(/0\.\.16/);
    expect(() => witnessProgramScript(17, p32)).toThrow(/0\.\.16/);
    expect(() => witnessProgramScript(1, new Uint8Array(1))).toThrow(/2\.\.40/);
    expect(() => witnessProgramScript(1, new Uint8Array(41))).toThrow(/2\.\.40/);
    expect(() => p2trScript(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => p2trScript(new Uint8Array(33))).toThrow(/32 bytes/);
  });
});

describe('taproot acceptance is gated on ACTIVATION, not on having segwit', () => {
  // BIP350 valid P2TR vector.
  const P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';

  it('accepts it on Bitcoin, where taproot is active', () => {
    expect(supportsTaproot(BITCOIN_MAINNET)).toBe(true);
    expect(isSpendableAddress(P2TR, BITCOIN_MAINNET)).toBe(true);
  });

  it('REJECTS it on a segwit chain where taproot is NOT active (funds-loss guard)', () => {
    // Same chain in every respect except the activation flag. On such a chain a
    // witness v1 output is unencumbered, so paying to it would gift the coins to
    // the first miner. Shape alone must never be enough.
    const dormant = { ...BITCOIN_MAINNET, taprootActive: false };
    expect(supportsSegwit(dormant)).toBe(true);
    expect(supportsTaproot(dormant)).toBe(false);
    expect(isSpendableAddress(P2TR, dormant)).toBe(false);
    // P2WPKH on that same chain is still fine: only v1 is gated.
    expect(isSpendableAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', dormant)).toBe(true);
  });

  it('treats an undeclared flag as NOT active (fails closed)', () => {
    const undeclared = { ...BITCOIN_MAINNET };
    delete (undeclared as { taprootActive?: boolean }).taprootActive;
    expect(supportsTaproot(undeclared)).toBe(false);
    expect(isSpendableAddress(P2TR, undeclared)).toBe(false);
  });
});
