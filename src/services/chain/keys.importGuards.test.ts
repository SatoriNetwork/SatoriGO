// IMPORT / OUTPUT-ENCODING GUARDS — the two fail-closed rules added after the
// 2026-08-15 audit, plus the flows that must NOT be broken by them.
//
//   1. addressToScript() refuses a P2SH address instead of emitting a P2PKH
//      script over the SCRIPT hash (an output nobody can ever spend).
//   2. classifyPrivateKeyOrigin() reports what a WIF's version byte can and
//      cannot say about which chain a pasted key came from.
//
// The suite deliberately builds its P2SH fixtures FROM THE CHAIN PARAMS rather
// than from literal strings, so a chain whose prefix changes is checked against
// its new value and not against a copy of the old one.

import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { base58check } from '@scure/base';
import * as secp from '@noble/secp256k1';

import {
  BITCOINGOLD_MAINNET,
  BITCOIN_MAINNET,
  EVRMORE_MAINNET,
  EVRMORE_TESTNET,
  LITECOIN_MAINNET,
  NO_ACCEPTED_P2SH,
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  type EvrmoreNetwork,
} from './chainParams';
import {
  addressToElectrumScripthash,
  addressToScript,
  classifyPrivateKeyOrigin,
  encodeWif,
  isSpendableAddress,
  p2pkhScript,
  privateKeyToDerived,
  parsePrivateKey,
  wifVersionByte,
} from './keys';
import { LiveWalletService } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import type { ElectrumClient } from './electrumTypes';

const b58c = base58check(sha256);

/** Every chain the picker offers today. Kept local so this file states its own
 *  expectations instead of importing a UI module into a service test. */
const CHAINS: EvrmoreNetwork[] = [
  EVRMORE_MAINNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  BITCOIN_MAINNET,
];

const PRIV = Uint8Array.from(
  ('0101010101010101010101010101010101010101010101010101010101010101'.match(/../g) as string[]).map(
    (h) => parseInt(h, 16),
  ),
);

function hash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b));
}

/** A base58check address with an ARBITRARY version byte. Used to mint the P2SH
 *  strings a user could realistically paste. */
function base58Address(version: number, payload: Uint8Array): string {
  return b58c.encode(concatBytes(Uint8Array.of(version & 0xff), payload));
}

/** Every P2SH version byte any shipped chain uses, current and historical. */
function p2shVersionsOf(net: EvrmoreNetwork): number[] {
  return [net.scriptHash, net.scriptHashLegacy].filter(
    (v): v is number => v !== undefined && v !== NO_ACCEPTED_P2SH,
  );
}

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
// 1. addressToScript fails closed on P2SH
// ---------------------------------------------------------------------------

describe('addressToScript refuses P2SH', () => {
  const h160 = hash160(utf8ToBytes('some redeem script'));

  it("refuses EVERY shipped chain's P2SH prefix, current and historical", () => {
    const seen = new Set<number>();
    for (const net of [...CHAINS, EVRMORE_TESTNET]) {
      for (const version of p2shVersionsOf(net)) {
        seen.add(version);
        const address = base58Address(version, h160);
        expect(() => addressToScript(address)).toThrow(/P2SH/);
        // The scripthash used for READING balances is derived from the script,
        // so it fails with it. That is not a lost capability: it used to return
        // the scripthash of the WRONG script, i.e. a silent "no history" for an
        // address that may well have had one.
        expect(() => addressToElectrumScripthash(address)).toThrow(/P2SH/);
      }
    }
    // Sanity: the loop really covered the interesting bytes, including the '3…'
    // prefix three chains share and Evrmore's own 'e…'.
    expect(seen.has(BITCOIN_MAINNET.scriptHash)).toBe(true);
    expect(seen.has(EVRMORE_MAINNET.scriptHash)).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it("the classic case: a Bitcoin '3…' address no longer becomes a P2PKH script", () => {
    const p2sh = base58Address(BITCOIN_MAINNET.scriptHash, h160);
    expect(p2sh.startsWith('3')).toBe(true);
    expect(() => addressToScript(p2sh)).toThrow(/P2SH/);
    // What it used to return: a P2PKH script over the SCRIPT hash. Building that
    // output would have burned the coins, since no key hashes to that value.
    expect(bytesToHex(p2pkhScript(h160)).startsWith('76a914')).toBe(true);
  });

  it('NO false rejection: every chain still encodes its own derived address', () => {
    for (const net of CHAINS) {
      const derived = privateKeyToDerived(PRIV, net, true);
      const script = addressToScript(derived.address);
      // Legacy chains keep their P2PKH script; segwit chains keep P2WPKH.
      expect(bytesToHex(script)).toBe(
        net.addressFormat === 'p2wpkh'
          ? bytesToHex(concatBytes(Uint8Array.of(0x00, 0x14), hash160(secp.getPublicKey(PRIV, true))))
          : bytesToHex(p2pkhScript(hash160(secp.getPublicKey(PRIV, true)))),
      );
      expect(addressToElectrumScripthash(derived.address)).toMatch(/^[0-9a-f]{64}$/);
      expect(isSpendableAddress(derived.address, net)).toBe(true);
    }
  });

  it('a P2PKH version byte is never mistaken for a P2SH one', () => {
    // The guard subtracts every known pubKeyHash from the refused set, so even a
    // chain whose P2SH prefix collided with another chain's P2PKH prefix would
    // keep paying. Asserted directly on every shipped P2PKH byte.
    for (const net of [...CHAINS, EVRMORE_TESTNET]) {
      const address = base58Address(net.pubKeyHash, h160);
      expect(bytesToHex(addressToScript(address))).toBe(bytesToHex(p2pkhScript(h160)));
    }
  });

  it('an unrecognised base58 version byte is still encoded as P2PKH (fails OPEN)', () => {
    // Deliberate: the refusal is a DENY-list of bytes this module can name as
    // P2SH. A chain added to chainParams but not to KNOWN_NETWORKS keeps working
    // exactly as it does today rather than being broken by a missing list entry.
    const unknown = 0x2b; // 43: not a prefix of any shipped chain
    expect(bytesToHex(addressToScript(base58Address(unknown, h160)))).toBe(
      bytesToHex(p2pkhScript(h160)),
    );
  });

  it('the send path was already refusing these, and still does', () => {
    // The guard is defence in depth, not a replacement for the gate: nothing
    // about isSpendableAddress() changed.
    for (const net of CHAINS) {
      for (const version of p2shVersionsOf(net)) {
        expect(isSpendableAddress(base58Address(version, h160), net)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. WIF version byte: what it can and cannot tell us
// ---------------------------------------------------------------------------

describe('classifyPrivateKeyOrigin', () => {
  it('a raw hex key carries no version byte and is always "nothing to check"', () => {
    const hex = bytesToHex(PRIV);
    for (const net of CHAINS) {
      for (const form of [hex, `0x${hex}`, `0X${hex.toUpperCase()}`, `  ${hex}  `]) {
        const origin = classifyPrivateKeyOrigin(form, net, CHAINS);
        expect(origin.kind).toBe('no-version-byte');
        expect(origin.version).toBeNull();
        expect(wifVersionByte(form)).toBeNull();
      }
    }
  });

  it("a chain's OWN WIF is 'selected-chain', and reports the chains it collides with", () => {
    for (const net of CHAINS) {
      for (const compressed of [true, false]) {
        const origin = classifyPrivateKeyOrigin(encodeWif(PRIV, net, compressed), net, CHAINS);
        expect(origin.kind).toBe('selected-chain');
        expect(origin.version).toBe(net.wif);
        // The collision set is REPORTED, not hidden: byte 128 is three chains.
        expect(origin.chains.map((c) => c.chainId)).toContain(net.chainId);
      }
    }
    // The specific ambiguity that makes this check weak, pinned so nobody later
    // writes copy claiming the prefix identifies the chain.
    const evrView = classifyPrivateKeyOrigin(encodeWif(PRIV, BITCOIN_MAINNET, true), EVRMORE_MAINNET, CHAINS);
    expect(evrView.kind).toBe('selected-chain'); // a BITCOIN key, and we cannot tell
    expect(evrView.chains.map((c) => c.ticker).sort()).toEqual(['BTC', 'EVR', 'RVN']);
  });

  it("a key from a different FAMILY is 'other-chain' and names that family", () => {
    const origin = classifyPrivateKeyOrigin(
      encodeWif(PRIV, LITECOIN_MAINNET, true),
      BITCOIN_MAINNET,
      CHAINS,
    );
    expect(origin.kind).toBe('other-chain');
    expect(origin.version).toBe(LITECOIN_MAINNET.wif);
    expect(origin.chains.map((c) => c.ticker).sort()).toEqual(['BTGS', 'LTC']);
    // And the reverse direction, on the byte only WojakCoin uses.
    const wjk = classifyPrivateKeyOrigin(
      encodeWif(PRIV, WOJAKCOIN_MAINNET, true),
      EVRMORE_MAINNET,
      CHAINS,
    );
    expect(wjk.kind).toBe('other-chain');
    expect(wjk.chains.map((c) => c.ticker)).toEqual(['WJK']);
  });

  it("a byte belonging to NO offered chain is 'unknown-chain'", () => {
    // 0xEF: Bitcoin testnet (and Evrmore testnet). A testnet key currently
    // imports and produces a real, fundable MAINNET address.
    const testnetWif = b58c.encode(concatBytes(Uint8Array.of(0xef), PRIV, Uint8Array.of(1)));
    expect(testnetWif.startsWith('c')).toBe(true);
    expect(wifVersionByte(testnetWif)).toBe(0xef);
    for (const net of CHAINS) {
      const origin = classifyPrivateKeyOrigin(testnetWif, net, CHAINS);
      expect(origin.kind).toBe('unknown-chain');
      expect(origin.version).toBe(0xef);
      expect(origin.chains).toEqual([]);
    }
    // The same byte IS Evrmore testnet's, so it is only "unknown" relative to
    // the chains the caller offers. Passing testnet in makes it known again.
    expect(
      classifyPrivateKeyOrigin(testnetWif, EVRMORE_MAINNET, [...CHAINS, EVRMORE_TESTNET]).kind,
    ).toBe('other-chain');
  });

  it('uncompressed WIFs are classified the same way as compressed ones', () => {
    const uncompressed = encodeWif(PRIV, LITECOIN_MAINNET, false);
    expect(wifVersionByte(uncompressed)).toBe(LITECOIN_MAINNET.wif);
    expect(classifyPrivateKeyOrigin(uncompressed, BITCOIN_MAINNET, CHAINS).kind).toBe('other-chain');
  });

  it('malformed input reports "no version byte" and leaves the verdict to parsePrivateKey', () => {
    const good = encodeWif(PRIV, BITCOIN_MAINNET, true);
    const badChecksum = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    for (const bad of ['', '   ', 'not a key', badChecksum, '0x1234']) {
      expect(wifVersionByte(bad)).toBeNull();
      expect(classifyPrivateKeyOrigin(bad, EVRMORE_MAINNET, CHAINS).kind).toBe('no-version-byte');
    }
    // parsePrivateKey stays the single authority on validity.
    expect(() => parsePrivateKey(badChecksum)).toThrow();
  });

  it('classifying never mutates or rejects anything parsePrivateKey accepts', () => {
    // The classifier is advisory. Every WIF it flags still decodes to the same
    // key, so a caller that chooses to continue is not working with damaged
    // material.
    for (const from of CHAINS) {
      const wif = encodeWif(PRIV, from, true);
      classifyPrivateKeyOrigin(wif, BITCOIN_MAINNET, CHAINS);
      expect(bytesToHex(parsePrivateKey(wif).privateKey)).toBe(bytesToHex(PRIV));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. THE FLOW THAT MUST NOT BREAK: enableChain re-imports a wallet's own WIF
// ---------------------------------------------------------------------------

describe('enabling another chain on a single-key wallet', () => {
  it('re-imports the source-chain WIF onto the target chain, guard or no guard', async () => {
    // liveStore.enableChain() reveals the active wallet's secret and feeds it
    // straight back into importPrivateKeyWallet. For a 'pk' wallet that secret
    // is a WIF carrying the SOURCE chain's version byte, so the whole feature
    // depends on the decoders NOT enforcing it. This is the regression test for
    // putting the new check at the human-facing import boundary instead.
    setStorageForTests(new MemoryStorageAdapter());
    const svc = new LiveWalletService(offlineClient());
    const evrWif = encodeWif(PRIV, EVRMORE_MAINNET, true);
    await svc.importPrivateKey(evrWif, 'password123', 'mainnet');

    const revealed = (await svc.revealPrivateKeyWif('password123'))!;
    expect(revealed).toBe(evrWif);

    // The classifier WOULD have flagged this string on Litecoin...
    expect(classifyPrivateKeyOrigin(revealed, LITECOIN_MAINNET, CHAINS).kind).toBe('other-chain');
    // ...and the service still imports it, because the classifier is not on this
    // path. If this ever throws, the version-byte check has leaked into
    // decodeWif/parsePrivateKey and broken chain enabling.
    await svc.importPrivateKey(revealed, 'password123', 'litecoin-mainnet');
    expect(svc.getAddress(0)).toBe(privateKeyToDerived(PRIV, LITECOIN_MAINNET, true).address);
    expect(svc.getAddress(0).startsWith('ltc1')).toBe(true);
  });

  it('every cross-chain pairing still decodes to the same key and address', () => {
    // The all-pairs sweep is done WITHOUT the service on purpose: each import
    // builds a real scrypt vault (N=2^17), so 36 of them take minutes. The one
    // test above proves the real service path; this proves the decoder under it
    // is version-byte-blind in every direction, which is what that path needs.
    for (const from of CHAINS) {
      const wif = encodeWif(PRIV, from, true);
      for (const to of CHAINS) {
        const parsed = parsePrivateKey(wif);
        expect(bytesToHex(parsed.privateKey)).toBe(bytesToHex(PRIV));
        expect(privateKeyToDerived(parsed.privateKey, to, parsed.compressed).address).toBe(
          privateKeyToDerived(PRIV, to, true).address,
        );
      }
    }
  });
});
