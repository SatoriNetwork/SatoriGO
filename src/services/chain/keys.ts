// HD key derivation and address encoding for Evrmore (EVR).
//
// SAFETY-CRITICAL: a bug in this module can render funds unspendable or leak
// keys. Every primitive here is pure-JS and CSP-safe (no Node APIs, no Buffer,
// no WASM, no eval) so it runs inside a Chrome MV3 service worker. Uint8Array
// is used throughout.
//
// Chain parameters are imported from ./chainParams (already verified against the
// Evrmore source). Do NOT hardcode version bytes here.

import { generateMnemonic as bip39Generate, validateMnemonic as bip39Validate, mnemonicToSeed as bip39MnemonicToSeed } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { base58check, bech32, bech32m } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { concatBytes } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';
import type { EvrmoreNetwork } from './chainParams';
import {
  BITCOINGOLD_MAINNET,
  BITCOIN_MAINNET,
  DOGECOIN_MAINNET,
  EVRMORE_MAINNET,
  EVRMORE_TESTNET,
  LITECOIN_MAINNET,
  NO_ACCEPTED_P2SH,
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  derivationPath,
  supportsTaproot,
} from './chainParams';

// base58check helper. @scure/base's base58check takes the sha256 fn and does the
// double-sha256 checksum (sha256(sha256(payload))[0..4]) internally, so we get a
// single, well-tested code path for every base58check encode/decode below.
const b58c = base58check(sha256);

// ---------------------------------------------------------------------------
// Mnemonic / seed
// ---------------------------------------------------------------------------

/** Generate a fresh BIP39 mnemonic (English). strength in bits: 128 => 12 words, 256 => 24 words. */
export function generateMnemonic(strength: 128 | 256 = 128): string {
  return bip39Generate(wordlist, strength);
}

/** Validate a BIP39 mnemonic against the English wordlist + checksum. */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39Validate(mnemonic, wordlist);
}

/** BIP39 mnemonic -> 64-byte seed (PBKDF2-HMAC-SHA512, 2048 rounds). */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  return bip39MnemonicToSeed(mnemonic, passphrase);
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** hash160 = ripemd160(sha256(data)). Used for P2PKH address payloads. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

// ---------------------------------------------------------------------------
// Address / script encoding
// ---------------------------------------------------------------------------

/**
 * Encode a P2PKH address from a (compressed) public key.
 * base58check(version || hash160(pubkey)), version = net.pubKeyHash.
 */
export function pubkeyToP2pkhAddress(publicKey: Uint8Array, net: EvrmoreNetwork): string {
  const h160 = hash160(publicKey);
  const payload = concatBytes(Uint8Array.of(net.pubKeyHash & 0xff), h160);
  return b58c.encode(payload);
}

/**
 * Encode a native-segwit v0 (P2WPKH) address: bech32(hrp, 0 || hash160(pubkey)).
 * Only valid on chains that declare a bech32Hrp.
 */
export function pubkeyToP2wpkhAddress(publicKey: Uint8Array, net: EvrmoreNetwork): string {
  if (!net.bech32Hrp) {
    throw new Error(`${net.displayName} has no segwit (bech32Hrp unset)`);
  }
  // FAIL CLOSED on an uncompressed (65-byte) key. BIP143 consensus allows it, but
  // SCRIPT_VERIFY_WITNESS_PUBKEYTYPE is in Bitcoin Core's STANDARD policy set, so
  // no node relays a spend of the resulting output: the address would take coins
  // and never give them back. It is also not a real address anywhere else, since
  // every other wallet derives P2WPKH from the compressed key, so the user would
  // have no second tool to recover with. Hashing "whatever we were handed" here
  // is exactly how that address gets minted, so the check belongs at this layer.
  if (publicKey.length !== 33) {
    throw new Error(
      `segwit needs a compressed (33-byte) public key, got ${publicKey.length} bytes`,
    );
  }
  const words = bech32.toWords(hash160(publicKey));
  // Witness version 0 is prepended as a raw 5-bit word, NOT run through toWords.
  return bech32.encode(net.bech32Hrp, [0, ...words]);
}

/**
 * Encode the chain's OWN receive-address format for a public key. Legacy chains
 * (Evrmore, Ravencoin) get P2PKH; native-segwit chains (BTGS) get P2WPKH. This
 * is the single place address-type policy lives, so adding a bech32 chain needs
 * no new code here.
 */
export function pubkeyToAddress(publicKey: Uint8Array, net: EvrmoreNetwork): string {
  return net.addressFormat === 'p2wpkh'
    ? pubkeyToP2wpkhAddress(publicKey, net)
    : pubkeyToP2pkhAddress(publicKey, net);
}

/** A decoded native-segwit address. */
export interface DecodedSegwitAddress {
  hrp: string;
  /** Witness version: 0 for P2WPKH/P2WSH, 1 for P2TR (taproot), 2..16 reserved. */
  witnessVersion: number;
  /** Witness program: 20 bytes for P2WPKH, 32 for P2WSH and P2TR. */
  program: Uint8Array;
}

/**
 * The bech32 data charset (BIP173). Needed because the witness version is what
 * SELECTS the checksum constant, so it has to be read out of the raw string
 * BEFORE any checksum can be verified — see parseWitnessAddress().
 */
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * BIP141/BIP173 well-formedness of a witness program, by version.
 *
 * BIP141 defines a witness program as a 2..40 byte push, and pins version 0 to
 * exactly two shapes: 20 bytes (P2WPKH) and 32 bytes (P2WSH). Everything else at
 * v0 is invalid — that is the BIP350 vector
 * `BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P` (16-byte v0 program), which must not
 * decode. v1..v16 carry no length rule at the ADDRESS level; the taproot-specific
 * v1 == 32 rule is BIP341 policy and lives in decodeSegwitAddress().
 */
function isWellFormedWitnessProgram(witnessVersion: number, length: number): boolean {
  if (witnessVersion < 0 || witnessVersion > 16) return false;
  if (length < 2 || length > 40) return false;
  if (witnessVersion === 0) return length === 20 || length === 32;
  return true;
}

/**
 * FORMAT LAYER ONLY — parse any BIP173/BIP350 segwit address into its hrp,
 * witness version and witness program. Returns null (never throws) when the
 * string is not a well-formed witness address, so callers can use it as a probe.
 *
 * *** THIS IS NOT A PAYMENT-SAFETY CHECK. *** It happily returns witness
 * versions this wallet must never pay to (v2..v16 are consensus-UNENCUMBERED
 * today, i.e. anyone-can-spend). Use decodeSegwitAddress() for "is this an
 * address shape we understand" and isSpendableAddress() for "may we pay to it".
 * It is exported so tests can assert the published BIP173/BIP350 vectors —
 * including the ones this wallet deliberately refuses — against one decoder.
 *
 * CHECKSUM SELECTION IS THE WHOLE POINT (BIP350):
 *   witness v0   -> bech32   (checksum constant 1)
 *   witness v1+  -> bech32m  (checksum constant 0x2bc830a3)
 * These are NOT interchangeable, and accepting either one for either version
 * would let a typo whose checksum happens to satisfy the wrong constant through,
 * sending funds to an address nobody controls. So the version word is read
 * first, from the raw string, and EXACTLY ONE decoder is then applied — we never
 * "try both and keep whichever parses". A v0 address carrying a bech32m checksum
 * and a v1 address carrying a bech32 checksum both fail here, by construction.
 *
 * The hrp is NOT checked against any chain here (this layer is chain-agnostic);
 * that is isValidAddress()/isSpendableAddress()'s job. It is also why BIP350's
 * `tc1p…` "invalid human-readable part" vector parses at this layer and is
 * rejected one layer up, where the chain is known.
 */
export function parseWitnessAddress(address: string): DecodedSegwitAddress | null {
  try {
    // Lowercase only to LOCATE and read the version word. The original string is
    // handed to the decoder below, which enforces BIP173's "no mixed case" rule.
    const lowered = address.toLowerCase();
    const separator = lowered.lastIndexOf('1');
    // hrp must be non-empty and at least one data char must follow the separator.
    if (separator < 1 || separator + 1 >= lowered.length) return null;
    const witnessVersion = BECH32_CHARSET.indexOf(lowered[separator + 1]);
    // -1 = not a bech32 char; 17..31 = "invalid witness version" (BIP350 vector
    // `BC130XLXVLHEMJA…`, whose version word '3' decodes to 17).
    if (witnessVersion < 0 || witnessVersion > 16) return null;

    const coder = witnessVersion === 0 ? bech32 : bech32m; // BIP350
    const { prefix, words } = coder.decode(address as `${string}1${string}`);
    // Defensive: the version we selected the checksum with MUST be the version
    // the verified data actually carries.
    if (words.length < 1 || words[0] !== witnessVersion) return null;
    // fromWords rejects excess padding and non-zero padding bits (BIP173's
    // "zero padding of more than 4 bits" / "non-zero padding" vectors) by
    // throwing, which the catch below turns into a null.
    const program = Uint8Array.from(coder.fromWords(words.slice(1)));
    if (!isWellFormedWitnessProgram(witnessVersion, program.length)) return null;
    return { hrp: prefix, witnessVersion, program };
  } catch {
    return null;
  }
}

/**
 * Decode a segwit address into a witness program this wallet is willing to
 * REASON about, or return null when the string is not bech32/bech32m at all
 * (i.e. it is base58 or malformed). Never throws, so callers can use it as a
 * format probe.
 *
 * This is parseWitnessAddress() plus ONE policy rule, and it is the decoder every
 * caller in the wallet should use. Note that decoding is not permission: the
 * send path must still gate on isSpendableAddress(), which is stricter again.
 */
export function decodeSegwitAddress(address: string): DecodedSegwitAddress | null {
  const parsed = parseWitnessAddress(address);
  if (!parsed) return null;
  // BIP341: a taproot output key is an x-only public key, so a v1 witness
  // program is 32 bytes and nothing else. Consensus leaves a v1 program of ANY
  // other length UNENCUMBERED — the first miner to notice can take it — so such
  // a string is not an address as far as this wallet is concerned, even though
  // BIP350 lists one (`bc1pw508d6qejxtdg4y5r3zarvary0c5xw7k…`, a 40-byte v1
  // program) among its valid ADDRESS vectors. Address-valid != safe to pay.
  if (parsed.witnessVersion === 1 && parsed.program.length !== 32) return null;
  return parsed;
}

/**
 * Decode a base58check P2PKH address into its version byte + 20-byte hash160.
 * Throws if the checksum is invalid or the payload is not 1 + 20 bytes.
 */
export function addressToHash160(address: string): { version: number; hash: Uint8Array } {
  const payload = b58c.decode(address);
  if (payload.length !== 21) {
    throw new Error(`invalid P2PKH payload length: ${payload.length}`);
  }
  return { version: payload[0], hash: payload.slice(1) };
}

/**
 * Validate an address by base58check-decoding it. If a network is supplied the
 * version byte must match that network's P2PKH or P2SH prefix; otherwise any
 * well-formed 21-byte base58check payload is accepted.
 */
export function isValidAddress(address: string, net?: EvrmoreNetwork): boolean {
  const segwit = decodeSegwitAddress(address);
  if (segwit) {
    // A bech32 address is only valid on a chain that HAS segwit, and its hrp
    // must match that chain's (an 'bc1…' must never pass as a 'bcg1…' chain).
    if (!net) return true;
    return !!net.bech32Hrp && segwit.hrp === net.bech32Hrp;
  }
  try {
    const { version } = addressToHash160(address);
    if (net) {
      return version === net.pubKeyHash || version === net.scriptHash;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * True ONLY for a standard P2PKH address on `net` (the version byte equals
 * net.pubKeyHash). SAFETY-CRITICAL for the send path: the transaction builder
 * only ever emits P2PKH output scripts, so sending to a P2SH ('e…') or
 * wrong-network address — which isValidAddress() also accepts — would build an
 * output the recipient can NEVER spend (funds burned). Every recipient/change
 * address fed to the builder MUST pass this, not the looser isValidAddress().
 */
export function isP2pkhAddress(address: string, net: EvrmoreNetwork): boolean {
  try {
    return addressToHash160(address).version === net.pubKeyHash;
  } catch {
    return false;
  }
}

/**
 * True for any address this wallet can BUILD A SPENDABLE OUTPUT TO on `net`:
 * P2PKH on every chain, plus native-segwit P2WPKH and P2TR (taproot) on chains
 * that have segwit and whose hrp matches.
 *
 * SAFETY-CRITICAL and the check the send path must use. Paying to a script we
 * cannot construct correctly burns funds, so this is an ALLOW-LIST of exactly
 * three output shapes; everything else fails closed with a plain "unsupported
 * address" for the user, which is always recoverable. What it rejects and why:
 *
 *   - Any bech32 address whose hrp is not this chain's, and any witness address
 *     at all on a chain with no segwit (bech32Hrp unset). On such a chain a
 *     P2WPKH/P2TR output is a bare anyone-can-spend script — see the SEGWIT TRAP
 *     block in chainParams.ts (WojakCoin).
 *   - P2SH, on every chain: the builder emits no P2SH script (isP2pkhAddress
 *     matches pubKeyHash only, never scriptHash).
 *   - Witness v2..v16: reserved for future upgrades and consensus-UNENCUMBERED
 *     today. Constructing one is trivial and that is exactly the danger.
 *   - P2WSH, i.e. a 32-byte witness program at version ZERO. This one is a
 *     judgement call, because `0020<sha256>` is as easy to emit as any other
 *     script, so spell out the reasoning:
 *       * A v0/32 program is the hash of a redeem script the payer never sees
 *         and cannot check. Nothing distinguishes a real multisig/lightning
 *         P2WSH from a vanity or burn string — the existing test in
 *         keys.segwit.test.ts uses BTGS's own published burn address
 *         `bcg1qqqq…dead`, which is a checksum-valid P2WSH pointing at no script
 *         that will ever exist. Paying it destroys the coins.
 *       * A v1/32 program is NOT a hash: BIP341 makes it the taproot output KEY
 *         itself, and every taproot output has a mandatory key-path spend. Any
 *         correctly generated `bc1p…` is therefore spendable by whoever issued
 *         it, which is what makes accepting taproot cheap and safe while
 *         accepting P2WSH is not.
 *       * Failing closed here is also the status quo (this gate has always
 *         refused P2WSH); widening it is a separate change that deserves its own
 *         review, not a side effect of adding taproot.
 *
 * KNOWN LIMIT — bech32Hrp proves SEGWIT is active on a chain, not TAPROOT. Every
 * segwit chain shipped today has taproot active too (BTGS is Bitcoin Core v30,
 * Litecoin activated it in 0.21.2), so accepting v1 on "has segwit" is correct
 * as of now. Anyone adding a bech32 chain WITHOUT activated taproot must add an
 * explicit capability flag in chainParams and gate the v1 branch below on it —
 * on such a chain a `…1p…` output is anyone-can-spend, exactly the WojakCoin
 * trap one version up.
 */
export function isSpendableAddress(address: string, net: EvrmoreNetwork): boolean {
  const segwit = decodeSegwitAddress(address);
  if (segwit) {
    if (!net.bech32Hrp || segwit.hrp !== net.bech32Hrp) return false;
    // v0: P2WPKH only (20 bytes). A 32-byte v0 program is P2WSH — rejected.
    if (segwit.witnessVersion === 0) return segwit.program.length === 20;
    // v1: P2TR. decodeSegwitAddress already pinned the program to 32 bytes, but
    // shape is not enough: taproot must also be ACTIVE in this chain's consensus.
    // On a segwit chain where v1 is still dormant the output is unencumbered, so
    // paying to it would hand the coins to the first miner. Gate on the chain's
    // own verified capability, never on "it has segwit".
    return segwit.witnessVersion === 1 && supportsTaproot(net);
  }
  return isP2pkhAddress(address, net);
}

/**
 * P2PKH scriptPubKey for a hash160:
 *   OP_DUP OP_HASH160 <20-byte push> <hash160> OP_EQUALVERIFY OP_CHECKSIG
 *   0x76   0xa9        0x14          ...        0x88          0xac
 */
export function p2pkhScript(h160: Uint8Array): Uint8Array {
  if (h160.length !== 20) {
    throw new Error(`hash160 must be 20 bytes, got ${h160.length}`);
  }
  return concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), h160, Uint8Array.of(0x88, 0xac));
}

/**
 * P2WPKH (native segwit v0) scriptPubKey:
 *   OP_0 <20-byte push> <hash160(pubkey)>
 *   0x00 0x14           ...
 */
export function p2wpkhScript(h160: Uint8Array): Uint8Array {
  if (h160.length !== 20) {
    throw new Error(`hash160 must be 20 bytes, got ${h160.length}`);
  }
  return concatBytes(Uint8Array.of(0x00, 0x14), h160);
}

/**
 * Generic witness-program scriptPubKey (BIP141):
 *   <version opcode> <program length> <program>
 *
 * SAFETY-CRITICAL byte layout, and the easy place to get it wrong:
 *   - OP_0 is 0x00, but OP_1..OP_16 are the SMALL-INTEGER opcodes 0x51..0x60,
 *     NOT 0x01..0x10. Emitting 0x01 for version 1 would be a one-byte data push
 *     and the output would mean something entirely different.
 *   - A witness program is 2..40 bytes, and any push of 1..75 bytes is a direct
 *     push whose opcode IS the byte count, so the length byte alone is correct
 *     here and OP_PUSHDATA is never needed.
 * So P2WPKH is `0014<20>`, P2WSH is `0020<32>` and P2TR is `5120<32>`.
 */
export function witnessProgramScript(witnessVersion: number, program: Uint8Array): Uint8Array {
  if (!Number.isInteger(witnessVersion) || witnessVersion < 0 || witnessVersion > 16) {
    throw new Error(`witness version must be 0..16, got ${witnessVersion}`);
  }
  if (program.length < 2 || program.length > 40) {
    throw new Error(`witness program must be 2..40 bytes, got ${program.length}`);
  }
  const versionOpcode = witnessVersion === 0 ? 0x00 : 0x50 + witnessVersion;
  return concatBytes(Uint8Array.of(versionOpcode, program.length), program);
}

/**
 * P2TR (native segwit v1 / taproot) scriptPubKey — BIP341:
 *   OP_1 <32-byte push> <x-only output key>
 *   0x51 0x20           ...
 *
 * The 32 bytes are the taproot OUTPUT KEY (an x-only public key), not a hash.
 * This wallet only ever PAYS to these; it derives no taproot keys of its own and
 * cannot spend such an output.
 */
export function p2trScript(outputKey: Uint8Array): Uint8Array {
  if (outputKey.length !== 32) {
    throw new Error(`taproot output key must be 32 bytes, got ${outputKey.length}`);
  }
  return witnessProgramScript(1, outputKey);
}

/**
 * Every chain whose base58 version bytes this module can name WITHOUT being told
 * which chain an address belongs to. Used for exactly one thing: the P2SH
 * refusal in addressToScript() below.
 *
 * It is a LOOKUP TABLE, not a membership test, and nothing else may use it —
 * "is this address on my chain?" is isValidAddress(address, net), which takes
 * the chain explicitly and stays correct for chains added after this line.
 *
 * ADDING A CHAIN: append it here so its P2SH prefix is refused too. Forgetting
 * to is SAFE, just less useful; the reasoning is on KNOWN_P2SH_VERSIONS below.
 */
const KNOWN_NETWORKS: readonly EvrmoreNetwork[] = [
  EVRMORE_MAINNET,
  EVRMORE_TESTNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  BITCOIN_MAINNET,
  DOGECOIN_MAINNET,
];

/**
 * base58 version bytes that mean P2SH ("pay to the hash of a redeem script")
 * on some chain this wallet knows, and P2PKH on none of them.
 *
 * WHY A DENY-LIST AND NOT AN ALLOW-LIST OF P2PKH BYTES: addressToScript() is not
 * given a network (its callers detect the format from the address string alone),
 * so it cannot ask "is this byte THIS chain's pubKeyHash?". An allow-list would
 * therefore have to reject every byte it had not been told about, which would
 * break a chain added to chainParams but not added to KNOWN_NETWORKS above — a
 * live outage caused by a missing list entry. A deny-list fails the other way:
 * a chain missing from KNOWN_NETWORKS keeps working exactly as it does today and
 * merely does not get its P2SH form caught here. That is no worse than the
 * status quo for the new chain, and strictly better for every listed one.
 *
 * The pubKeyHash bytes are SUBTRACTED so this can never reject a legitimate
 * P2PKH address: if some chain's P2SH prefix ever equals another's P2PKH prefix,
 * the collision resolves in favour of paying, and the send path's own
 * isSpendableAddress() gate (which does know the chain) is what refuses it.
 * NO_ACCEPTED_P2SH is a sentinel, not a byte, so it drops out with the range
 * filter. `scriptHashLegacy` is included deliberately: Litecoin's historical
 * '3…' and WojakCoin's only P2SH prefix are both real P2SH forms a user can
 * paste, whatever address VALIDATION chooses to accept.
 */
const KNOWN_P2SH_VERSIONS: ReadonlySet<number> = (() => {
  const pubKeyHashes = new Set(KNOWN_NETWORKS.map((n) => n.pubKeyHash));
  const p2sh = new Set<number>();
  for (const net of KNOWN_NETWORKS) {
    for (const v of [net.scriptHash, net.scriptHashLegacy]) {
      if (v === undefined || v === NO_ACCEPTED_P2SH) continue;
      if (v < 0 || v > 0xff) continue;
      if (pubKeyHashes.has(v)) continue;
      p2sh.add(v);
    }
  }
  return p2sh;
})();

/**
 * The scriptPubKey an address pays to, for ANY supported address format.
 *
 * SAFETY-CRITICAL: this decides what bytes go into a transaction output, so a
 * wrong script burns funds. Format is detected from the address itself (bech32
 * carries its own hrp), which keeps every existing legacy caller working.
 *
 * FAILS CLOSED ON P2SH. A base58 address is otherwise treated as P2PKH, and it
 * used to be treated as P2PKH unconditionally: a '3…' or 'e…' P2SH address was
 * turned into `76a914<SCRIPT hash>88ac`, i.e. a P2PKH script paying a hash that
 * is nobody's key hash, so an output built from it could never be spent. The
 * send path does gate on isSpendableAddress(), which rejects P2SH on every
 * chain, so this was unreachable in the shipped wallet — but a function whose
 * documented job is deciding output bytes must not be correct only because of
 * who happens to call it. It now refuses a version byte it can name as P2SH
 * (KNOWN_P2SH_VERSIONS) instead of silently mis-encoding it.
 *
 * Refusing rather than emitting `a914<hash>87` is deliberate. Emitting the real
 * P2SH script would make addressToElectrumScripthash() able to READ a P2SH
 * balance, which is harmless, but it would also hand the transaction builder a
 * P2SH output it is not reviewed to produce, turning a UI-layer gate into the
 * only thing standing between a user and an output shape the wallet cannot
 * spend from or verify. Widening the wallet to P2SH is a deliberate change with
 * its own review, not a side effect of a decoder fix.
 *
 * Witness outputs are restricted to the same shapes isSpendableAddress() allows,
 * P2WPKH and P2TR, as a second line of defence: a throw is always recoverable,
 * an emitted anyone-can-spend script is not. witnessProgramScript() is the
 * unrestricted encoder for anything that legitimately needs the other versions.
 */
export function addressToScript(address: string): Uint8Array {
  const segwit = decodeSegwitAddress(address);
  if (segwit) {
    if (segwit.witnessVersion === 0) {
      // 32-byte v0 is P2WSH, which this wallet does not pay to — see the
      // reasoning on isSpendableAddress().
      if (segwit.program.length !== 20) {
        throw new Error('only P2WPKH (20-byte witness program) is supported at witness v0');
      }
      return p2wpkhScript(segwit.program);
    }
    if (segwit.witnessVersion === 1) {
      // P2TR. decodeSegwitAddress guarantees a 32-byte program here (BIP341).
      return p2trScript(segwit.program);
    }
    // v2..v16 are reserved for future soft forks and are unencumbered under
    // today's consensus rules, so an output paying one is anyone-can-spend.
    throw new Error(`witness v${segwit.witnessVersion} outputs are not supported`);
  }
  const { version, hash } = addressToHash160(address);
  if (KNOWN_P2SH_VERSIONS.has(version)) {
    throw new Error(
      `base58 version ${version} is a P2SH address prefix; this wallet builds no P2SH output script`,
    );
  }
  return p2pkhScript(hash);
}

/**
 * Electrum protocol scripthash for an address:
 *   sha256(scriptPubKey), byte order REVERSED, lowercase hex.
 * This is the subscription key used by ElectrumX servers. It MUST hash the
 * address's real scriptPubKey, so a bech32 address hashes its P2WPKH script —
 * hashing a P2PKH script instead would silently report an empty balance.
 *
 * Supports exactly what addressToScript() supports: P2PKH, P2WPKH and P2TR. It
 * therefore now THROWS for a P2SH address instead of returning the scripthash of
 * a P2PKH script built over the script hash. That is not a lost capability:
 * reading a P2SH balance never worked, it silently reported "no history" for an
 * address that may well have had some, which is the worse of the two failures.
 */
export function addressToElectrumScripthash(address: string): string {
  const digest = sha256(addressToScript(address));
  // Reverse byte order (Electrum uses little-endian display for the scripthash).
  const reversed = digest.slice().reverse();
  return bytesToHexLower(reversed);
}

// ---------------------------------------------------------------------------
// WIF (Wallet Import Format)
// ---------------------------------------------------------------------------

/**
 * Encode a 32-byte private key as WIF.
 * base58check(version || key || [0x01 if compressed]), version = net.wif.
 */
export function encodeWif(privateKey: Uint8Array, net: EvrmoreNetwork, compressed = true): string {
  if (privateKey.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKey.length}`);
  }
  const parts = [Uint8Array.of(net.wif & 0xff), privateKey];
  if (compressed) {
    parts.push(Uint8Array.of(0x01));
  }
  return b58c.encode(concatBytes(...parts));
}

/**
 * Decode a WIF string into its private key and compression flag.
 * Payload is version(1) || key(32) [|| 0x01]. Version byte is not checked
 * against a specific network so the same decoder works for mainnet/testnet.
 */
export function decodeWif(wif: string): { privateKey: Uint8Array; compressed: boolean } {
  const payload = b58c.decode(wif);
  // 1 (version) + 32 (key) => uncompressed; + 1 (0x01 flag) => compressed.
  if (payload.length === 34 && payload[33] === 0x01) {
    return { privateKey: payload.slice(1, 33), compressed: true };
  }
  if (payload.length === 33) {
    return { privateKey: payload.slice(1, 33), compressed: false };
  }
  throw new Error(`invalid WIF payload length: ${payload.length}`);
}

/**
 * The 64-hex-character body of a raw private key, or null when `input` is not in
 * that form. Shared by parsePrivateKey() and wifVersionByte() so both agree on
 * exactly which strings are "raw hex" — a raw hex key carries NO version byte,
 * so every chain check below has to treat it as "nothing to check", and the two
 * functions disagreeing about what counts as hex is how that would silently
 * become "nothing to check" for a WIF too.
 */
function rawHexKeyBody(input: string): string | null {
  const raw = input.trim();
  const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? hex : null;
}

/**
 * The base58check version byte a private-key string carries, or null when it
 * carries none: a raw hex key (no version byte exists), or a string that is not
 * a well-formed WIF at all (bad checksum / wrong payload length). Never throws —
 * validity is parsePrivateKey()'s job, and reporting "no version byte" for a
 * malformed string keeps the two from producing two different error messages for
 * the same bad paste.
 */
export function wifVersionByte(input: string): number | null {
  const raw = input.trim();
  if (rawHexKeyBody(raw)) return null;
  let payload: Uint8Array;
  try {
    payload = b58c.decode(raw);
  } catch {
    return null;
  }
  // Same two shapes decodeWif() accepts: version(1) || key(32) [|| 0x01].
  if (payload.length === 34 && payload[33] === 0x01) return payload[0];
  if (payload.length === 33) return payload[0];
  return null;
}

/** What a pasted private key's WIF version byte says about where it came from.
 *
 *  'no-version-byte' — raw hex, or not a decodable WIF. Nothing to check.
 *  'selected-chain'  — the byte IS the selected chain's. Says almost nothing:
 *                      see the collision note on classifyPrivateKeyOrigin().
 *  'other-chain'     — the byte belongs to a supported chain, but not to the
 *                      selected one. Worth telling the user about; NOT proof.
 *  'unknown-chain'   — the byte belongs to no supported chain at all.
 */
export type PrivateKeyOriginKind =
  | 'no-version-byte'
  | 'selected-chain'
  | 'other-chain'
  | 'unknown-chain';

export interface PrivateKeyOrigin {
  kind: PrivateKeyOriginKind;
  /** The WIF version byte, or null when the input carries none. */
  version: number | null;
  /** Every chain in `known` that uses this version byte. For 'selected-chain'
   *  this is how a caller sees the AMBIGUITY (three chains share byte 128), so
   *  it must never be presented as "this key is from X". Empty when the kind is
   *  'no-version-byte' or 'unknown-chain'. */
  chains: readonly EvrmoreNetwork[];
}

/**
 * Classify a pasted private key by its WIF version byte, relative to the chain
 * the user selected. PURE: it decides nothing, it only reports what the byte can
 * and cannot support, and the caller chooses the policy.
 *
 * WHAT THIS CANNOT DO, WHICH IS MOST OF IT. WIF version bytes are not unique
 * across the chains this wallet ships: 128 is Evrmore, Ravencoin AND Bitcoin;
 * 176 is BitcoinGold AND Litecoin. So the single most likely mistake a user
 * can make, pasting a Bitcoin WIF while Evrmore is selected, is INVISIBLE here
 * and always will be: the two keys are the same string, byte for byte. This
 * catches a key from a different FAMILY (Litecoin into Bitcoin) and a key from
 * no supported family at all (a testnet key). Nothing more. Copy built on this
 * must say so rather than implying the import was verified.
 *
 * WHY IT LIVES HERE AND NOT IN decodeWif()/parsePrivateKey(). Enabling a chain
 * on an existing single-key wallet DELIBERATELY re-imports that wallet's own WIF
 * onto another chain, and that WIF carries the SOURCE chain's version byte. The
 * decoders are on that path, so a check inside them would break the feature.
 * This function is for the boundary where a HUMAN pastes a key they believe
 * belongs somewhere; the internal re-import never goes near it.
 *
 * `known` is passed in rather than read from a table here so the caller can hand
 * over exactly the chains its own UI offers, and so a chain added to the picker
 * is covered without editing this module.
 */
export function classifyPrivateKeyOrigin(
  input: string,
  target: EvrmoreNetwork,
  known: readonly EvrmoreNetwork[],
): PrivateKeyOrigin {
  const version = wifVersionByte(input);
  if (version === null) return { kind: 'no-version-byte', version: null, chains: [] };
  const chains = known.filter((n) => (n.wif & 0xff) === version);
  if ((target.wif & 0xff) === version) return { kind: 'selected-chain', version, chains };
  if (chains.length > 0) return { kind: 'other-chain', version, chains };
  return { kind: 'unknown-chain', version, chains: [] };
}

// ---------------------------------------------------------------------------
// HD derivation
// ---------------------------------------------------------------------------

export interface DerivedKey {
  path: string;
  index: number;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
  wif: string;
}

/**
 * Derive a single BIP44 key for Evrmore: m/44'/coinType'/account'/change/index.
 *
 * The master HDKey is created WITH Evrmore's bip32 version bytes. @scure/bip32
 * supports custom versions, but note these bytes only affect xprv/xpub
 * serialization — the derived private key, public key, and therefore address
 * are identical regardless of the version bytes used. Addresses depend solely
 * on net.pubKeyHash, which pubkeyToAddress controls.
 *
 * The public key returned by @scure/bip32 is the COMPRESSED 33-byte form, which
 * is the BIP44 standard for address derivation.
 */
export function deriveAddress(
  seed: Uint8Array,
  net: EvrmoreNetwork,
  account: number,
  change: 0 | 1,
  index: number,
): DerivedKey {
  const master = HDKey.fromMasterSeed(seed, { public: net.bip32.public, private: net.bip32.private });
  // Purpose follows the chain's address format: 44' for legacy, 84' for segwit.
  const path = derivationPath(net, account, change, index);
  const child = master.derive(path);
  if (!child.privateKey || !child.publicKey) {
    throw new Error(`derivation produced no key material at ${path}`);
  }
  const privateKey = child.privateKey;
  const publicKey = child.publicKey; // compressed, 33 bytes
  return {
    path,
    index,
    privateKey,
    publicKey,
    address: pubkeyToAddress(publicKey, net),
    wif: encodeWif(privateKey, net, true),
  };
}

/**
 * Build a single-address DerivedKey directly from a raw 32-byte private key.
 * Used for PRIVATE-KEY imports (e.g. Satori-style single-key wallets), which have
 * exactly ONE address — there is no HD tree, so `index`/`path` are nominal.
 * The compression flag must match the key's origin (WIF carries it) so the
 * derived address matches the source wallet.
 */
export function privateKeyToDerived(
  privateKey: Uint8Array,
  net: EvrmoreNetwork,
  compressed = true,
): DerivedKey {
  if (privateKey.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKey.length}`);
  }
  const publicKey = secp256k1.getPublicKey(privateKey, compressed);
  return {
    path: 'imported',
    index: 0,
    privateKey,
    publicKey,
    address: pubkeyToAddress(publicKey, net),
    wif: encodeWif(privateKey, net, compressed),
  };
}

/**
 * Parse a user-supplied private key in WIF (base58check) or raw hex (64 chars,
 * optional 0x) form into its 32-byte value + compression flag. Validates the key
 * is a legal secp256k1 scalar. Throws on anything malformed.
 *
 * The WIF version byte is deliberately NOT checked here: this is also the
 * decoder the chain-enable path re-imports a wallet's own WIF through, where the
 * byte legitimately belongs to a different chain. See classifyPrivateKeyOrigin()
 * for the check that belongs at a human-facing import instead.
 */
export function parsePrivateKey(input: string): { privateKey: Uint8Array; compressed: boolean } {
  const raw = input.trim();
  if (!raw) throw new Error('empty private key');

  let privateKey: Uint8Array;
  let compressed = true;

  const hex = rawHexKeyBody(raw);
  if (hex) {
    // Raw hex private key (compression is unknown; default to compressed).
    privateKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) privateKey[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    // Assume WIF (base58check). decodeWif validates the checksum + length.
    const decoded = decodeWif(raw);
    privateKey = decoded.privateKey;
    compressed = decoded.compressed;
  }

  // Reject a key that is 0 or ≥ the curve order (getPublicKey throws for these).
  try {
    secp256k1.getPublicKey(privateKey, compressed);
  } catch {
    throw new Error('invalid private key (not a valid secp256k1 scalar)');
  }
  return { privateKey, compressed };
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

const HEX_CHARS = '0123456789abcdef';

/** Lowercase hex without depending on Buffer. */
function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX_CHARS[(b >> 4) & 0x0f] + HEX_CHARS[b & 0x0f];
  }
  return out;
}
