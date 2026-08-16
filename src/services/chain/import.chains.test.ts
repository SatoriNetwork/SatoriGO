// CROSS-CHAIN IMPORT VERIFICATION — seed import, private-key import, enableChain.
//
// WHY THIS FILE EXISTS (and why it does not simply call our own helpers twice):
// every other suite in this directory checks that keys.ts agrees with keys.ts.
// That cannot catch a wrong derivation PURPOSE, a wrong coin type or a wrong
// address encoder, because both sides of the comparison share the bug. So this
// file carries a SECOND, INDEPENDENT implementation of the whole import stack —
//
//   BIP39 seed   : PBKDF2-HMAC-SHA512(mnemonic, "mnemonic"+passphrase, 2048)
//   BIP32        : HMAC-SHA512("Bitcoin seed") + CKDpriv, scalar add mod n
//   base58check  : bignum base58 + double-SHA256 checksum
//   bech32       : the BIP173 polymod/checksum written straight from the spec
//
// — none of which imports @scure/bip32, @scure/bip39, @scure/base or keys.ts.
// The independent stack is itself ANCHORED to published third-party vectors
// (BIP84 test vectors, the BIP173 vector, the Bitcoin genesis address, the
// Trezor BIP39 vector) in the first describe block, so a matching answer from
// both stacks is real evidence and not a shared mistake.
//
// TEST NAMES ARE THE REPORT. Tests here pin behaviour rather than describe an
// intention, so each carries a marker saying WHY the behaviour is what it is:
//   FIXED           — it used to be wrong; the test now pins the fix, and the
//                     comment keeps the old failure mode on record.
//   PERMANENT LIMIT — it looks wrong and cannot be fixed at any layer (shared
//                     WIF version bytes); pinned so nobody writes copy claiming
//                     otherwise.
//   BY DESIGN       — a deliberate lenience some other feature depends on.
// A test with no marker is an ordinary expectation. Adding a `BUG:` name is
// still the way to record a defect that is being left in place on purpose.

import { beforeAll, describe, expect, it } from 'vitest';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

import {
  BITCOINGOLD_MAINNET,
  BITCOIN_MAINNET,
  EVRMORE_MAINNET,
  LITECOIN_MAINNET,
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  derivationPath,
  supportsSegwit,
  type EvrmoreNetwork,
} from './chainParams';
import {
  addressToElectrumScripthash,
  addressToScript,
  decodeWif,
  deriveAddress,
  encodeWif,
  isSpendableAddress,
  isValidAddress,
  mnemonicToSeed,
  parsePrivateKey,
  privateKeyToDerived,
} from './keys';
import { LiveWalletService } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import type { ElectrumClient } from './electrumTypes';

// ---------------------------------------------------------------------------
// Independent reference implementation (no project code, no @scure/*)
// ---------------------------------------------------------------------------

/** BIP39 seed, straight from the spec: PBKDF2-HMAC-SHA512, 2048 iterations. */
function refSeed(mnemonic: string, passphrase = ''): Uint8Array {
  return pbkdf2(sha512, mnemonic.normalize('NFKD'), ('mnemonic' + passphrase).normalize('NFKD'), {
    c: 2048,
    dkLen: 64,
  });
}

interface RefXKey {
  key: Uint8Array;
  chainCode: Uint8Array;
}

function bytesToBig(b: Uint8Array): bigint {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}

function bigTo32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function ser32(i: number): Uint8Array {
  return Uint8Array.of((i >>> 24) & 0xff, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff);
}

/** BIP32 master key. NOTE: the version bytes play NO part here — that is the
 *  whole point of the BTGS non-standard-bytes test further down. */
function refMaster(seed: Uint8Array): RefXKey {
  const I = hmac(sha512, utf8ToBytes('Bitcoin seed'), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/** BIP32 CKDpriv. */
function refCkd(parent: RefXKey, index: number): RefXKey {
  const hardened = index >= 0x80000000;
  const data = hardened
    ? concatBytes(Uint8Array.of(0), parent.key, ser32(index))
    : concatBytes(secp.getPublicKey(parent.key, true), ser32(index));
  const I = hmac(sha512, parent.chainCode, data);
  const IL = bytesToBig(I.slice(0, 32));
  const n = secp.CURVE.n;
  if (IL >= n) throw new Error('IL >= n');
  const k = (IL + bytesToBig(parent.key)) % n;
  if (k === 0n) throw new Error('ki == 0');
  return { key: bigTo32(k), chainCode: I.slice(32) };
}

/** Derive a full BIP32 path such as "m/84'/0'/0'/0/0". */
function refDerive(seed: Uint8Array, path: string): RefXKey {
  let node = refMaster(seed);
  for (const part of path.split('/').slice(1)) {
    const hardened = part.endsWith("'") || part.endsWith('h');
    const idx = parseInt(hardened ? part.slice(0, -1) : part, 10);
    node = refCkd(node, hardened ? idx + 0x80000000 : idx);
  }
  return node;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function refBase58(bytes: Uint8Array): string {
  let n = bytesToBig(bytes);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

function refBase58Check(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return refBase58(concatBytes(payload, checksum));
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data: number[] | Uint8Array, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

/** BIP173 segwit address (witness v0 -> bech32 checksum constant 1). */
function refSegwitAddress(hrp: string, witnessVersion: number, program: Uint8Array): string {
  const data = [witnessVersion, ...convertBits(program, 8, 5, true)];
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ (witnessVersion === 0 ? 1 : 0x2bc830a3);
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map((d) => BECH32_CHARSET[d]).join('');
}

function refHash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b));
}

/** The address the CHAIN'S OWN RULES say a pubkey must produce, computed with
 *  zero project code: bech32 P2WPKH on a segwit chain, base58 P2PKH otherwise. */
function refAddress(pub: Uint8Array, net: EvrmoreNetwork): string {
  if (net.addressFormat === 'p2wpkh') {
    return refSegwitAddress(net.bech32Hrp!, 0, refHash160(pub));
  }
  return refBase58Check(concatBytes(Uint8Array.of(net.pubKeyHash), refHash160(pub)));
}

function refWif(priv: Uint8Array, net: EvrmoreNetwork, compressed: boolean): string {
  const parts = compressed
    ? concatBytes(Uint8Array.of(net.wif), priv, Uint8Array.of(1))
    : concatBytes(Uint8Array.of(net.wif), priv);
  return refBase58Check(parts);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The BIP39/BIP84 published test mnemonic. Chosen deliberately: BIP84's own
 *  test vectors are stated for THIS phrase, which is what lets the Bitcoin chain
 *  be checked against a third-party value rather than against ourselves. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** A second, unrelated 24-word phrase, to prove nothing is pinned to one seed. */
const MNEMONIC_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal will';

/** Published BIP84 vectors (bitcoin/bips, bip-0084.mediawiki, "Test vectors"),
 *  fetched from the BIP itself — NOT produced by this codebase. */
const BIP84_VECTOR = {
  path: "m/84'/0'/0'/0/0",
  wif: 'KyZpNDKnfs94vbrwhJneDi77V6jF64PWPF8x5cdJb8ifgg2DUc9d',
  pubkey: '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c',
  address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
};

/** Trezor BIP39 vector for the same phrase (trezor/python-mnemonic vectors.json,
 *  entropy 0x00…00). The published seed is stated for passphrase "TREZOR". */
const TREZOR_PASSPHRASE = 'TREZOR';
const TREZOR_SEED_HEX =
  'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04';
/** The SAME phrase with NO passphrase — the seed every BIP84 vector below uses. */
const NO_PASSPHRASE_SEED_HEX =
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4';

/** Every chain the wallet ships, in the order the task lists them. */
const CHAINS: EvrmoreNetwork[] = [
  EVRMORE_MAINNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  BITCOIN_MAINNET,
];

let seed: Uint8Array;
let seed24: Uint8Array;

beforeAll(async () => {
  seed = await mnemonicToSeed(MNEMONIC);
  seed24 = await mnemonicToSeed(MNEMONIC_24);
});

/** An offline Electrum client: every request throws, so the service's
 *  fire-and-forget reads fail closed instead of opening a socket. */
function offlineClient(): ElectrumClient {
  return {
    connect: async () => {},
    isConnected: () => false,
    endpoint: () => 'wss://offline',
    close: () => {},
    request: async () => {
      throw new Error('offline');
    },
  };
}

// ---------------------------------------------------------------------------
// 0. The independent stack is anchored to published third-party vectors
// ---------------------------------------------------------------------------

describe('reference implementation is anchored to published vectors', () => {
  it('BIP39: reproduces the Trezor seed vector for the test mnemonic', async () => {
    // Published vector (with its stated "TREZOR" passphrase): both stacks agree.
    expect(bytesToHex(refSeed(MNEMONIC, TREZOR_PASSPHRASE))).toBe(TREZOR_SEED_HEX);
    expect(bytesToHex(await mnemonicToSeed(MNEMONIC, TREZOR_PASSPHRASE))).toBe(TREZOR_SEED_HEX);
    // The no-passphrase seed used by every derivation test below.
    expect(bytesToHex(refSeed(MNEMONIC))).toBe(NO_PASSPHRASE_SEED_HEX);
    expect(bytesToHex(seed)).toBe(NO_PASSPHRASE_SEED_HEX);
  });

  it('base58check: reproduces the Bitcoin genesis address from its pubkey', () => {
    // The genesis coinbase output pubkey (UNCOMPRESSED, 65 bytes) -> 1A1zP1…
    const genesisPub =
      '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f';
    const pub = Uint8Array.from((genesisPub.match(/../g) as string[]).map((h) => parseInt(h, 16)));
    expect(refBase58Check(concatBytes(Uint8Array.of(0), refHash160(pub)))).toBe(
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    );
  });

  it('bech32: reproduces the BIP173 P2WPKH test vector', () => {
    const h160 = Uint8Array.from(
      ('751e76e8199196d454941c45d1b3a323f1433bd6'.match(/../g) as string[]).map((h) => parseInt(h, 16)),
    );
    expect(refSegwitAddress('bc', 0, h160)).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  });

  it('BIP32+BIP84: reproduces the published BIP84 first receive address', () => {
    const node = refDerive(refSeed(MNEMONIC), BIP84_VECTOR.path);
    expect(bytesToHex(secp.getPublicKey(node.key, true))).toBe(BIP84_VECTOR.pubkey);
    expect(refAddress(secp.getPublicKey(node.key, true), BITCOIN_MAINNET)).toBe(BIP84_VECTOR.address);
    expect(refWif(node.key, BITCOIN_MAINNET, true)).toBe(BIP84_VECTOR.wif);
  });
});

// ---------------------------------------------------------------------------
// 1. DERIVATION PATH + address format, per chain, on the REAL import path
// ---------------------------------------------------------------------------

describe('A) seed import: derivation path matches the advertised address format', () => {
  // deriveAddress() is what LiveWalletService.addWallet() calls (liveWallet.ts:441),
  // i.e. this is the path a real 12/24-word import takes, not a helper.
  const EXPECTED: Record<string, { purpose: 44 | 84; coin: number; prefix: string }> = {
    'evrmore-mainnet': { purpose: 44, coin: 175, prefix: 'E' },
    'ravencoin-mainnet': { purpose: 44, coin: 175, prefix: 'R' },
    'bitcoingold-mainnet': { purpose: 84, coin: 18888, prefix: 'bcg1' },
    'litecoin-mainnet': { purpose: 84, coin: 2, prefix: 'ltc1' },
    'wojakcoin-mainnet': { purpose: 44, coin: 20760, prefix: 'W' },
    'bitcoin-mainnet': { purpose: 84, coin: 0, prefix: 'bc1' },
  };

  for (const net of CHAINS) {
    it(`${net.ticker}: derives m/${EXPECTED[net.chainId].purpose}'/${EXPECTED[net.chainId].coin}' and renders the matching format`, () => {
      const want = EXPECTED[net.chainId];
      const k = deriveAddress(seed, net, 0, 0, 0);

      // (a) the path really is the purpose the address format implies
      expect(k.path).toBe(`m/${want.purpose}'/${want.coin}'/0'/0/0`);
      expect(k.path).toBe(derivationPath(net, 0, 0, 0));
      expect(want.purpose === 84).toBe(supportsSegwit(net));
      expect(want.purpose === 84).toBe(net.addressFormat === 'p2wpkh');

      // (b) the ADDRESS format matches the path's purpose (a 44'-derived key
      //     rendered as bech32, or an 84'-derived key rendered as base58, would
      //     put the funds where no other wallet looks)
      expect(k.address.startsWith(want.prefix)).toBe(true);
      if (net.addressFormat === 'p2wpkh') {
        expect(k.address.startsWith(`${net.bech32Hrp}1`)).toBe(true);
      } else {
        expect(net.bech32Hrp).toBeUndefined();
      }

      // (c) INDEPENDENT CHECK — same phrase, same path, own BIP32/base58/bech32
      const ref = refDerive(refSeed(MNEMONIC), k.path);
      expect(bytesToHex(k.privateKey)).toBe(bytesToHex(ref.key));
      expect(bytesToHex(k.publicKey)).toBe(bytesToHex(secp.getPublicKey(ref.key, true)));
      expect(k.address).toBe(refAddress(secp.getPublicKey(ref.key, true), net));
      expect(k.wif).toBe(refWif(ref.key, net, true));

      // (d) the wallet's own validators accept what it just derived
      expect(isValidAddress(k.address, net)).toBe(true);
      expect(isSpendableAddress(k.address, net)).toBe(true);
    });
  }

  it('BTC: the derived address IS the published BIP84 vector (third-party anchor)', () => {
    const k = deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0);
    expect(k.path).toBe(BIP84_VECTOR.path);
    expect(k.address).toBe(BIP84_VECTOR.address);
    expect(k.wif).toBe(BIP84_VECTOR.wif);
    expect(bytesToHex(k.publicKey)).toBe(BIP84_VECTOR.pubkey);
  });

  it('a 24-word phrase imports on every chain and matches the reference stack', () => {
    for (const net of CHAINS) {
      const k = deriveAddress(seed24, net, 0, 0, 0);
      const ref = refDerive(refSeed(MNEMONIC_24), k.path);
      expect(k.address).toBe(refAddress(secp.getPublicKey(ref.key, true), net));
    }
  });

  it('every chain lands on a DISTINCT address except EVR/RVN, which share key material', () => {
    const byChain = new Map(CHAINS.map((n) => [n.chainId, deriveAddress(seed, n, 0, 0, 0)]));
    const evr = byChain.get('evrmore-mainnet')!;
    const rvn = byChain.get('ravencoin-mainnet')!;
    // Same coinType (175) + same bip32 bytes -> identical key, different version byte.
    expect(bytesToHex(evr.privateKey)).toBe(bytesToHex(rvn.privateKey));
    expect(evr.address).not.toBe(rvn.address);
    const addresses = [...byChain.values()].map((k) => k.address);
    expect(new Set(addresses).size).toBe(CHAINS.length);
  });
});

describe('BTGS non-standard BIP32 version bytes do not corrupt derivation', () => {
  it("0x0488B21F/0x0488ADE5 change xpub SERIALIZATION only, never the derived key", () => {
    // The params really are the non-standard ones (chainParams.ts:426).
    expect(BITCOINGOLD_MAINNET.bip32.public).toBe(0x0488b21f);
    expect(BITCOINGOLD_MAINNET.bip32.private).toBe(0x0488ade5);

    const real = deriveAddress(seed, BITCOINGOLD_MAINNET, 0, 0, 0);
    // Same chain, but with STANDARD version bytes: key material must be identical.
    const standardised: EvrmoreNetwork = {
      ...BITCOINGOLD_MAINNET,
      bip32: { public: 0x0488b21e, private: 0x0488ade4 },
    };
    const alt = deriveAddress(seed, standardised, 0, 0, 0);
    expect(bytesToHex(real.privateKey)).toBe(bytesToHex(alt.privateKey));
    expect(real.address).toBe(alt.address);

    // And the reference stack (which has no concept of version bytes at all)
    // produces the same address, so nothing is being silently absorbed.
    const ref = refDerive(refSeed(MNEMONIC), "m/84'/18888'/0'/0/0");
    expect(real.address).toBe(refAddress(secp.getPublicKey(ref.key, true), BITCOINGOLD_MAINNET));
    expect(real.address.startsWith('bcg1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. WIF version bytes are NOT unique across these chains
// ---------------------------------------------------------------------------

describe('B) private-key import: what the WIF version byte can and cannot prove', () => {
  const PRIV = Uint8Array.from(
    ('0101010101010101010101010101010101010101010101010101010101010101'.match(/../g) as string[]).map(
      (h) => parseInt(h, 16),
    ),
  );

  it('the six chains collide on only THREE distinct WIF version bytes', () => {
    expect(EVRMORE_MAINNET.wif).toBe(128);
    expect(RAVENCOIN_MAINNET.wif).toBe(128);
    expect(BITCOIN_MAINNET.wif).toBe(128);
    expect(BITCOINGOLD_MAINNET.wif).toBe(176);
    expect(LITECOIN_MAINNET.wif).toBe(176);
    expect(WOJAKCOIN_MAINNET.wif).toBe(201);
  });

  it('a legitimate WIF for the chain is ALWAYS accepted (no false rejection)', () => {
    for (const net of CHAINS) {
      for (const compressed of [true, false]) {
        const wif = encodeWif(PRIV, net, compressed);
        expect(wif).toBe(refWif(PRIV, net, compressed));
        const parsed = parsePrivateKey(wif);
        expect(bytesToHex(parsed.privateKey)).toBe(bytesToHex(PRIV));
        expect(parsed.compressed).toBe(compressed);
      }
    }
  });

  it('WJK version byte 201 round-trips (it is > 128, the easy off-by-one)', () => {
    const wif = encodeWif(PRIV, WOJAKCOIN_MAINNET, true);
    expect(wif.startsWith('W')).toBe(true); // 201 -> 'W…' compressed, '7…' uncompressed
    expect(encodeWif(PRIV, WOJAKCOIN_MAINNET, false).startsWith('7')).toBe(true);
    expect(bytesToHex(decodeWif(wif).privateKey)).toBe(bytesToHex(PRIV));
  });

  // The user-visible consequence of the shared version bytes: the WIF STRING
  // itself is identical across the colliding chains, so no amount of squinting
  // at the prefix can tell a user which chain a key came from.
  it('the WIF STRING is byte-identical for EVR/RVN/BTC and for BTGS/LTC', () => {
    const evr = encodeWif(PRIV, EVRMORE_MAINNET, true);
    expect(encodeWif(PRIV, RAVENCOIN_MAINNET, true)).toBe(evr);
    expect(encodeWif(PRIV, BITCOIN_MAINNET, true)).toBe(evr);
    expect(evr.startsWith('K') || evr.startsWith('L')).toBe(true);
    const btgs = encodeWif(PRIV, BITCOINGOLD_MAINNET, true);
    expect(encodeWif(PRIV, LITECOIN_MAINNET, true)).toBe(btgs);
    expect(btgs.startsWith('T')).toBe(true);
    // Only WojakCoin's 201 is unique — and a WJK WIF starts with 'W', exactly
    // like a WJK ADDRESS does, which is its own UX hazard.
    expect(encodeWif(PRIV, WOJAKCOIN_MAINNET, true)).not.toBe(evr);
  });

  // *** PERMANENT LIMIT (was reported as a HIGH bug) *** decodeWif() and
  // parsePrivateKey() still never look at payload[0], deliberately: they are also
  // the decoders liveStore.enableChain() re-imports a wallet's own WIF through,
  // where the byte legitimately belongs to another chain. The check now lives at
  // the human-facing import boundary instead (classifyPrivateKeyOrigin, used by
  // LiveOnboarding's private-key form).
  //
  // THIS PARTICULAR CASE IS UNCATCHABLE ANYWHERE. Byte 128 is Evrmore, Ravencoin
  // AND Bitcoin, so a Bitcoin WIF pasted into Evrmore is the SAME STRING as the
  // Evrmore WIF for that key: no check at any layer can tell them apart. The test
  // stays as the pin on that fact, so nobody writes copy claiming otherwise.
  it('a Bitcoin WIF is indistinguishable from an Evrmore key (shared version byte)', () => {
    const btcWif = encodeWif(PRIV, BITCOIN_MAINNET, true);
    expect(btcWif.startsWith('K') || btcWif.startsWith('L')).toBe(true);

    const parsed = parsePrivateKey(btcWif); // does NOT throw
    const onEvrmore = privateKeyToDerived(parsed.privateKey, EVRMORE_MAINNET, parsed.compressed);

    expect(onEvrmore.address.startsWith('E')).toBe(true);
    expect(isValidAddress(onEvrmore.address, EVRMORE_MAINNET)).toBe(true);
    // The user's actual Bitcoin address for that key — where the funds they
    // expected to see actually live. Nothing in the UI ever mentions it.
    expect(privateKeyToDerived(parsed.privateKey, BITCOIN_MAINNET, true).address.startsWith('bc1')).toBe(true);
    // WORSE THAN "not checked": version 128 is shared, so the re-encoded WIF is
    // the SAME STRING. There is not even a stored artefact that differs.
    expect(onEvrmore.wif).toBe(btcWif);
    expect(onEvrmore.wif).toBe(encodeWif(PRIV, EVRMORE_MAINNET, true));
  });

  // BY DESIGN, not a defect: this lenience is what enableChain() runs on. The
  // UI-level notice is what tells a HUMAN their key looks like another chain's.
  it('every cross-chain WIF pairing is accepted by the decoder, in both directions', () => {
    for (const from of CHAINS) {
      for (const to of CHAINS) {
        const wif = encodeWif(PRIV, from, true);
        // No throw, no warning, whatever the source chain was.
        const parsed = parsePrivateKey(wif);
        const derived = privateKeyToDerived(parsed.privateKey, to, parsed.compressed);
        expect(derived.address).toBe(refAddress(secp.getPublicKey(PRIV, true), to));
      }
    }
  });

  // FIXED AT THE BOUNDARY: the DECODER still accepts this (it has to, see above),
  // but the private-key import form now refuses a version byte belonging to no
  // chain the picker offers — see LiveOnboarding.pkImport.test.tsx. This test
  // pins the decoder's deliberate lenience, not a user-reachable defect.
  it('a WIF whose version byte belongs to NO supported chain still DECODES', () => {
    // Version 0xEF is Bitcoin TESTNET. A testnet key pasted into the mainnet
    // import used to produce a real, fundable MAINNET address.
    const testnetWif = refBase58Check(concatBytes(Uint8Array.of(0xef), PRIV, Uint8Array.of(1)));
    expect(testnetWif.startsWith('c')).toBe(true);
    const parsed = parsePrivateKey(testnetWif);
    expect(bytesToHex(parsed.privateKey)).toBe(bytesToHex(PRIV));
    expect(privateKeyToDerived(parsed.privateKey, BITCOIN_MAINNET, true).address.startsWith('bc1')).toBe(true);
  });

  it('malformed input IS rejected (the checksum/scalar guards do work)', () => {
    expect(() => parsePrivateKey('')).toThrow(/empty/);
    // Corrupt the last char of a valid WIF -> checksum failure.
    const good = encodeWif(PRIV, BITCOIN_MAINNET, true);
    const bad = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    expect(() => parsePrivateKey(bad)).toThrow();
    // Out-of-range scalar (n itself) is refused.
    const nBytes = bigTo32(secp.CURVE.n);
    expect(() => parsePrivateKey(bytesToHex(nBytes))).toThrow(/secp256k1/);
    expect(() => parsePrivateKey('00'.repeat(32))).toThrow(/secp256k1/);
  });
});

// ---------------------------------------------------------------------------
// 3. Compressed vs uncompressed WIF, on every chain
// ---------------------------------------------------------------------------

describe('C) compressed vs uncompressed WIF', () => {
  const PRIV = Uint8Array.from(
    ('0000000000000000000000000000000000000000000000000000000000000001'.match(/../g) as string[]).map(
      (h) => parseInt(h, 16),
    ),
  );

  it('the 0x01 flag survives encode -> parse -> re-encode on every chain', () => {
    for (const net of CHAINS) {
      for (const compressed of [true, false]) {
        const wif = encodeWif(PRIV, net, compressed);
        const parsed = parsePrivateKey(wif);
        expect(parsed.compressed).toBe(compressed);
        expect(encodeWif(parsed.privateKey, net, parsed.compressed)).toBe(wif);
        // The flag genuinely changes the pubkey length that gets hashed. Only
        // legacy chains can DERIVE from an uncompressed key: segwit chains now
        // refuse it (an uncompressed P2WPKH address is unspendable in practice),
        // so asserting the length there would be asserting the old bug back.
        if (compressed || net.addressFormat !== 'p2wpkh') {
          const derived = privateKeyToDerived(parsed.privateKey, net, parsed.compressed);
          expect(derived.publicKey.length).toBe(compressed ? 33 : 65);
        }
      }
    }
  });

  it('legacy chains: an uncompressed key yields the standard uncompressed P2PKH address', () => {
    for (const net of [EVRMORE_MAINNET, RAVENCOIN_MAINNET, WOJAKCOIN_MAINNET]) {
      const un = privateKeyToDerived(PRIV, net, false);
      const co = privateKeyToDerived(PRIV, net, true);
      expect(un.address).not.toBe(co.address);
      expect(un.address).toBe(refAddress(secp.getPublicKey(PRIV, false), net));
      expect(co.address).toBe(refAddress(secp.getPublicKey(PRIV, true), net));
      expect(isSpendableAddress(un.address, net)).toBe(true);
    }
  });

  // FIXED (was a HIGH bug): an UNCOMPRESSED key on a segwit chain used to mint a
  // P2WPKH address from the 65-byte pubkey. BIP143 consensus permits it, but
  // SCRIPT_VERIFY_WITNESS_PUBKEYTYPE is standard relay policy, so no node would
  // accept a spend, and no other wallet derives that address from this WIF: the
  // address could only take coins, never return them. pubkeyToP2wpkhAddress now
  // fails closed on any non-33-byte key.
  it('segwit chains REFUSE to build a P2WPKH address from an uncompressed pubkey', () => {
    for (const net of [BITCOINGOLD_MAINNET, LITECOIN_MAINNET, BITCOIN_MAINNET]) {
      const uncompressedWif = encodeWif(PRIV, net, false);
      const parsed = parsePrivateKey(uncompressedWif);
      expect(parsed.compressed).toBe(false); // decoding the WIF still works

      expect(() => privateKeyToDerived(parsed.privateKey, net, parsed.compressed)).toThrow(
        /compressed \(33-byte\) public key/,
      );
      // The compressed key of the SAME secret is unaffected: it is the address
      // every other segwit wallet shows for this key, and it still builds.
      const ok = privateKeyToDerived(parsed.privateKey, net, true);
      expect(ok.publicKey.length).toBe(33);
      expect(ok.address).toBe(refAddress(secp.getPublicKey(PRIV, true), net));
      expect(isSpendableAddress(ok.address, net)).toBe(true);
    }
  });

});

// ---------------------------------------------------------------------------
// 4. Address -> script -> Electrum scripthash round trip
// ---------------------------------------------------------------------------

describe('D) addressToScript / addressToElectrumScripthash round trip', () => {
  for (const net of CHAINS) {
    it(`${net.ticker}: the scripthash is sha256(real scriptPubKey) reversed`, () => {
      const k = deriveAddress(seed, net, 0, 0, 0);
      const h160 = refHash160(k.publicKey);
      const expectedScript =
        net.addressFormat === 'p2wpkh'
          ? concatBytes(Uint8Array.of(0x00, 0x14), h160) // OP_0 <20>
          : concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), h160, Uint8Array.of(0x88, 0xac));

      expect(bytesToHex(addressToScript(k.address))).toBe(bytesToHex(expectedScript));

      const expectedSh = bytesToHex(sha256(expectedScript).slice().reverse());
      expect(addressToElectrumScripthash(k.address)).toBe(expectedSh);
      expect(addressToElectrumScripthash(k.address)).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it('the published BIP84 address hashes to the scripthash a server would index', () => {
    // Independent value: sha256(0014 || hash160(pubkey)) reversed, from the
    // BIP84 vector's own pubkey — nothing in the project touches this line.
    const pub = Uint8Array.from((BIP84_VECTOR.pubkey.match(/../g) as string[]).map((h) => parseInt(h, 16)));
    const want = bytesToHex(
      sha256(concatBytes(Uint8Array.of(0x00, 0x14), refHash160(pub))).slice().reverse(),
    );
    expect(addressToElectrumScripthash(BIP84_VECTOR.address)).toBe(want);
  });

  // FIXED (was a MEDIUM bug): addressToScript() used to take ANY base58 address
  // and emit a P2PKH script from its payload, with no P2SH check, so a '3…'
  // Bitcoin P2SH address became `76a914<SCRIPT hash>88ac` — a P2PKH script over
  // a hash that is nobody's key hash, i.e. an output that could never be spent.
  // It was unreachable (the send path gates on isSpendableAddress, which refuses
  // P2SH on every chain), but a function whose job is deciding output bytes must
  // not be correct only because of who calls it. Full coverage of the refusal,
  // including every chain's prefix, is in keys.importGuards.test.ts.
  it('addressToScript REFUSES a P2SH address instead of P2PKH-ifying it', () => {
    const p2sh = refBase58Check(concatBytes(Uint8Array.of(5), refHash160(utf8ToBytes('x'))));
    expect(p2sh.startsWith('3')).toBe(true);
    expect(() => addressToScript(p2sh)).toThrow(/P2SH/);
    // The Electrum scripthash goes with it. Nothing is lost: it used to hash the
    // WRONG script, i.e. report "no history" for an address that may have had one.
    expect(() => addressToElectrumScripthash(p2sh)).toThrow(/P2SH/);
    // The send path's own gate is unchanged and still refuses it first:
    expect(isSpendableAddress(p2sh, BITCOIN_MAINNET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. The real service: import + unlock + enableChain-equivalent re-import
// ---------------------------------------------------------------------------

describe('E) LiveWalletService import paths', () => {
  it('seed import stores the chain-correct address and re-derives it on unlock', async () => {
    for (const net of CHAINS) {
      setStorageForTests(new MemoryStorageAdapter());
      const svc = new LiveWalletService(offlineClient());
      const id = net.chainId === 'evrmore-mainnet' ? 'mainnet' : net.chainId;
      await svc.import(MNEMONIC, 'password123', id as never);
      const expected = deriveAddress(seed, net, 0, 0, 0).address;
      expect(svc.getAddress(0)).toBe(expected);

      const svc2 = new LiveWalletService(offlineClient());
      expect(await svc2.unlock('password123')).toBe(true);
      expect(svc2.getAddress(0)).toBe(expected);
      // The revealed WIF is the chain's own version byte.
      const wif = await svc2.revealPrivateKeyWif('password123');
      expect(wif).toBe(refWif(refDerive(refSeed(MNEMONIC), derivationPath(net, 0, 0, 0)).key, net, true));
    }
  });

  it('private-key import stores the chain-correct address and re-derives it on unlock', async () => {
    const PRIV = Uint8Array.from(
      ('0203040506070809000102030405060708090001020304050607080900010203'.match(/../g) as string[]).map(
        (h) => parseInt(h, 16),
      ),
    );
    for (const net of CHAINS) {
      setStorageForTests(new MemoryStorageAdapter());
      const svc = new LiveWalletService(offlineClient());
      const id = net.chainId === 'evrmore-mainnet' ? 'mainnet' : net.chainId;
      await svc.importPrivateKey(encodeWif(PRIV, net, true), 'password123', id as never);
      const expected = refAddress(secp.getPublicKey(PRIV, true), net);
      expect(svc.getAddress(0)).toBe(expected);

      const svc2 = new LiveWalletService(offlineClient());
      expect(await svc2.unlock('password123')).toBe(true);
      expect(svc2.getAddress(0)).toBe(expected);
    }
  });

  // STILL TRUE AT THIS LAYER, now warned about one layer up. importPrivateKey()
  // calls parsePrivateKey(), which ignores the version byte, so the chain the
  // user picked always wins over the chain the key came from — which is exactly
  // what enableChain() relies on. What changed is that the private-key FORM now
  // shows a warning naming the other chain before the user submits (see
  // pkChainNotice in LiveOnboarding.tsx). It warns rather than blocks: 176 is
  // BitcoinGold and Litecoin both, so the byte is a hint, never proof.
  it('importing a Litecoin WIF while "Bitcoin" is selected creates a Bitcoin wallet', async () => {
    const PRIV = Uint8Array.from(
      ('1112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30'.match(/../g) as string[]).map(
        (h) => parseInt(h, 16),
      ),
    );
    const ltcWif = encodeWif(PRIV, LITECOIN_MAINNET, true); // version 176, 'T…'
    setStorageForTests(new MemoryStorageAdapter());
    const svc = new LiveWalletService(offlineClient());

    await svc.importPrivateKey(ltcWif, 'password123', 'bitcoin-mainnet');

    expect(svc.getAddress(0)).toBe(refAddress(secp.getPublicKey(PRIV, true), BITCOIN_MAINNET));
    expect(svc.getAddress(0).startsWith('bc1')).toBe(true);
    // The user's real Litecoin address for that key is never mentioned:
    expect(refAddress(secp.getPublicKey(PRIV, true), LITECOIN_MAINNET).startsWith('ltc1')).toBe(true);
    // And the vault now holds a BITCOIN-version WIF, not the one they pasted.
    const stored = await svc.revealPrivateKeyWif('password123');
    expect(stored).toBe(encodeWif(PRIV, BITCOIN_MAINNET, true));
    expect(stored).not.toBe(ltcWif);
  });

  // The enableChain path in liveStore.ts:1533-1547: reveal the ACTIVE wallet's
  // secret, then re-import it on the target chain. For a 'pk' wallet the secret
  // is a WIF carrying the SOURCE chain's version byte — which only works BECAUSE
  // decodeWif ignores it. Same lenience, used deliberately here.
  it('enableChain (pk wallet): the source-chain WIF re-imports onto the target chain', async () => {
    const PRIV = Uint8Array.from(
      ('3132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f50'.match(/../g) as string[]).map(
        (h) => parseInt(h, 16),
      ),
    );
    setStorageForTests(new MemoryStorageAdapter());
    const svc = new LiveWalletService(offlineClient());
    await svc.importPrivateKey(encodeWif(PRIV, EVRMORE_MAINNET, true), 'password123', 'mainnet');
    const revealed = (await svc.revealPrivateKeyWif('password123'))!;
    expect(revealed).toBe(encodeWif(PRIV, EVRMORE_MAINNET, true)); // EVR version byte

    // enableChain feeds that string straight back into importPrivateKey.
    await svc.importPrivateKey(revealed, 'password123', 'litecoin-mainnet');
    expect(svc.getAddress(0)).toBe(refAddress(secp.getPublicKey(PRIV, true), LITECOIN_MAINNET));
    expect(svc.getAddress(0).startsWith('ltc1')).toBe(true);
  });

  // FIXED (was a HIGH bug): enabling a segwit chain on a pk wallet whose key is
  // UNCOMPRESSED used to hand the user a bcg1/ltc1/bc1 address built from the
  // 65-byte pubkey, which standard relay policy makes unspendable. It is now
  // refused at the import boundary, so enableChain surfaces the error and creates
  // nothing. The legacy source wallet is untouched and stays fully usable.
  it('enableChain of an UNCOMPRESSED pk wallet onto a segwit chain is REFUSED', async () => {
    const PRIV = Uint8Array.from(
      ('6162636465666768696a6b6c6d6e6f70717273747576777879707172737475aa'.match(/../g) as string[]).map(
        (h) => parseInt(h, 16),
      ),
    );
    setStorageForTests(new MemoryStorageAdapter());
    const svc = new LiveWalletService(offlineClient());
    await svc.importPrivateKey(encodeWif(PRIV, EVRMORE_MAINNET, false), 'password123', 'mainnet');
    const revealed = (await svc.revealPrivateKeyWif('password123'))!;
    const legacyAddress = svc.getAddress(0);

    await expect(
      svc.importPrivateKey(revealed, 'password123', 'bitcoin-mainnet'),
    ).rejects.toThrow(/uncompressed private key/i);

    // Nothing was created and the original wallet still works.
    expect(svc.getAddress(0)).toBe(legacyAddress);
  });

  // The same key COMPRESSED is the normal case and must keep working, otherwise
  // the guard above would have quietly broken cross-chain enable for everyone.
  it('enableChain of a COMPRESSED pk wallet onto a segwit chain still works', async () => {
    const PRIV = Uint8Array.from(
      ('6162636465666768696a6b6c6d6e6f70717273747576777879707172737475aa'.match(/../g) as string[]).map(
        (h) => parseInt(h, 16),
      ),
    );
    setStorageForTests(new MemoryStorageAdapter());
    const svc = new LiveWalletService(offlineClient());
    await svc.importPrivateKey(encodeWif(PRIV, EVRMORE_MAINNET, true), 'password123', 'mainnet');
    const revealed = (await svc.revealPrivateKeyWif('password123'))!;

    await svc.importPrivateKey(revealed, 'password123', 'bitcoin-mainnet');
    expect(svc.getAddress(0)).toBe(refAddress(secp.getPublicKey(PRIV, true), BITCOIN_MAINNET));
  });

  it('enableChain (seed wallet): the same phrase re-derives per-chain paths correctly', async () => {
    setStorageForTests(new MemoryStorageAdapter());
    const svc = new LiveWalletService(offlineClient());
    await svc.import(MNEMONIC, 'password123', 'mainnet');
    const phrase = (await svc.revealMnemonic('password123'))!;
    expect(phrase).toBe(MNEMONIC);

    for (const net of CHAINS.filter((n) => n.chainId !== 'evrmore-mainnet')) {
      await svc.import(phrase, 'password123', net.chainId as never);
      const ref = refDerive(refSeed(MNEMONIC), derivationPath(net, 0, 0, 0));
      expect(svc.getAddress(0)).toBe(refAddress(secp.getPublicKey(ref.key, true), net));
    }
  });
});
