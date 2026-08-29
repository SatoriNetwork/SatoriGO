// Native staking on a cosmos/evm chain, reached through STATIC PRECOMPILES.
//
// A cosmos/evm chain runs the Cosmos SDK's x/staking and x/distribution modules
// and exposes them to EVM callers at fixed addresses (0x...800 and 0x...801).
// From this wallet's point of view a delegation is therefore an ordinary EVM
// transaction with calldata: same signer, same nonce tracker, same fee quote,
// same broadcast. Nothing in this file signs, and nothing in it broadcasts; it
// produces bytes and reads data, exactly like erc20.ts.
//
// ---------------------------------------------------------------------------
// TRAP 1: A PRECOMPILE IS NOT A CONTRACT.
//
//   `eth_getCode` at 0x...800 answers `0x`. That is not evidence of anything:
//   precompiles need not report code. The only honest verification is to CALL
//   them, so every selector below was checked against the live chain and the
//   evidence is written next to it. A selector computed from a signature that
//   looks right is not verified; the same call answering on chain is.
//
// TRAP 2: TWO ADDRESS FORMS FOR ONE ACCOUNT, AND THE CALLS MIX THEM.
//
//   The precompiles take the caller's account as a 20-byte EVM `address`, but a
//   VALIDATOR is named by its bech32 operator string ('epixvaloper1...') as an
//   ABI `string`, and the Cosmos REST paths take the account's own bech32 form
//   ('epix1...'). All three are the SAME 20 bytes with different envelopes.
//   Confusing them does not fail loudly: it produces a well-formed call naming
//   somebody else. Hence bech32AddressFor / evmAddressFromBech32 here, both
//   pinned to a live cross-check (see the vectors in cosmosStaking.test.ts).
//
// TRAP 3: THE COSMOS SIDE SPEAKS TWO NUMBER SHAPES.
//
//   A `Coin` amount is a plain integer in the base denom ("41944485374850759379098"
//   aepix). A `Dec` (shares, a commission rate, a pending reward over REST) is a
//   DECIMAL STRING with 18 fractional digits, and over the precompile ABI the
//   same value arrives as an integer already TRUNCATED to the base denom. Both
//   are handled explicitly below; neither is ever read through a float.
// ---------------------------------------------------------------------------
//
// Environment: MV3 service worker and popup. fetch + AbortController, no Node
// APIs, no eval, no WASM. bech32 comes from @scure/base, which this repo
// already depends on for the UTXO chains' segwit addresses (keys.ts): the
// polymod and charset are the same BIP-173 ones, and reusing the audited
// implementation beats a second hand-rolled copy. Only the witness-version
// layer of a segwit address is NOT reused, because a Cosmos address has none.

import { bech32 } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { EvmCosmosStaking } from './chains';
import { isEvmAddress, normalizeEvmAddress } from './keys';

// ---------------------------------------------------------------------------
// Selectors, every one verified against the live chain
// ---------------------------------------------------------------------------

/**
 * '0x' plus the first 4 bytes of keccak-256 over the canonical signature. Same
 * function as erc20.ts's `selector`, re-declared rather than imported so this
 * module's pinned literals are proven against a computation that lives beside
 * them (cosmosStaking.test.ts section 1 asserts every literal equals this).
 */
export function cosmosSelector(signature: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8)}`;
}

/**
 * x/staking precompile selectors. Signatures taken verbatim from
 * github.com/cosmos/evm `precompiles/staking/abi.json` (fetched 2026-08-24).
 *
 * VERIFIED LIVE on 2026-08-24 against https://evmrpc.epix.zone (chain id 1916),
 * from the owner's account 0x1Ed2c7D71FbEb281073343aC2d317433679D0153, which
 * held ~999.998 EPIX and NO delegation at the time:
 *
 *   delegate             eth_estimateGas of 1 aepix to a bonded validator
 *                        answered 0x1cf9f (118687 gas). A gas NUMBER, not a
 *                        revert: the call is real and executable.
 *   undelegate           eth_estimateGas answered the precompile's own
 *   redelegate           business-logic revert, "execution reverted: no
 *   withdrawDelegatorRewards
 *                        delegation for (address, validator) tuple". That
 *                        message is the proof: an unknown selector or an
 *                        argument list the precompile could not decode never
 *                        reaches the module's own check. The owner held no
 *                        delegation, so this is the correct answer.
 *   delegation           eth_call answered shares 0 and Coin{"aepix", 0} for
 *                        the owner, and for a validator's own self-delegation
 *                        it answered shares 41944485374850759379098e18 and
 *                        Coin{"aepix", 41944485374850759379098}, matching that
 *                        validator's REST delegation response EXACTLY.
 *   unbondingDelegation  eth_call answered a well-formed empty tuple (no
 *                        entries) for both accounts.
 */
export const COSMOS_STAKING_SELECTORS = Object.freeze({
  /** delegate(address,string,uint256) */
  delegate: '0x53266bbb',
  /** undelegate(address,string,uint256) */
  undelegate: '0x3edab33c',
  /** redelegate(address,string,string,uint256) */
  redelegate: '0x54b826f5',
  /** delegation(address,string) */
  delegation: '0x241774e6',
  /** unbondingDelegation(address,string) */
  unbondingDelegation: '0xa03ffee1',
} as const);

/**
 * x/distribution precompile selectors, from `precompiles/distribution/abi.json`.
 *
 *   withdrawDelegatorRewards  same live evidence as undelegate above: the
 *                             precompile's own "no delegation for (address,
 *                             validator) tuple" revert.
 *   delegationRewards         eth_call on a validator's self-delegation
 *                             answered DecCoin[]{ "aepix", 81240454787509949141,
 *                             precision 18 }, whose amount is exactly the
 *                             INTEGER part of what REST reported for the same
 *                             account and validator at the same moment
 *                             ("81240454787509949141.842793923993686798").
 */
export const COSMOS_DISTRIBUTION_SELECTORS = Object.freeze({
  /** withdrawDelegatorRewards(address,string) */
  withdrawDelegatorRewards: '0xb46a8d61',
  /** delegationRewards(address,string) */
  delegationRewards: '0x9ad563b4',
} as const);

// ---------------------------------------------------------------------------
// bech32: one account, two envelopes (TRAP 2)
// ---------------------------------------------------------------------------

/** A Cosmos address is the same 20 bytes an EVM address is. */
const ADDRESS_BYTES = 20;

/** bech32's own length ceiling is 90 characters; a Cosmos address with a long
 *  prefix ('epixvaloper1' + 38 + 6) stays well inside it, but the limit is
 *  passed explicitly so a future longer prefix fails loudly here rather than
 *  producing a string some other implementation refuses. */
const BECH32_LIMIT = 90;

/**
 * The bech32 form of an EVM address under `prefix` ('epix' -> 'epix1...',
 * 'epixvaloper' -> 'epixvaloper1...').
 *
 * NO witness-version byte and NO bech32m: a Cosmos address is the plain
 * BIP-173 encoding of the 20 bytes, unlike the segwit addresses in keys.ts
 * which prepend a version and switch checksum constants above v0.
 *
 * CROSS-CHECKED LIVE (2026-08-24): the owner's 0x1Ed2c7D71FbEb281073343aC2d317433679D0153
 * derives to epix1rmfv04clh6egzpengwkz6vt5xdne6q2nxxtg4x, and the chain's bank
 * module reported that address holding 999998319999999947500 aepix, the exact
 * wei figure eth_getBalance answered for the 0x form in the same second.
 */
export function bech32AddressFor(prefix: string, evmAddress: string): string {
  if (typeof prefix !== 'string' || !/^[a-z][a-z0-9]*$/.test(prefix)) {
    throw new Error(`cosmos staking: bech32 prefix must be lowercase alphanumeric, got: ${String(prefix)}`);
  }
  if (typeof evmAddress !== 'string' || !isEvmAddress(evmAddress)) {
    throw new Error(`cosmos staking: not a valid EVM address: ${String(evmAddress)}`);
  }
  const body = normalizeEvmAddress(evmAddress).slice(2).toLowerCase();
  const bytes = new Uint8Array(ADDRESS_BYTES);
  for (let i = 0; i < ADDRESS_BYTES; i++) bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return bech32.encode(prefix, bech32.toWords(bytes), BECH32_LIMIT);
}

/**
 * The reverse: a bech32 Cosmos address back to its EIP-55 EVM form, with the
 * prefix it carried. Used to turn a VALIDATOR operator address into the 0x
 * address its self-delegation is held under, and to validate anything the user
 * or a REST answer hands over.
 *
 * Throws when the string is not bech32, its checksum is wrong, or it does not
 * carry exactly 20 bytes. A 32-byte Cosmos address (a module account) is
 * refused rather than truncated.
 */
export function evmAddressFromBech32(address: string): { prefix: string; evmAddress: string } {
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error('cosmos staking: bech32 address must be a non-empty string');
  }
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(address as `${string}1${string}`, BECH32_LIMIT);
  } catch (err) {
    throw new Error(`cosmos staking: not a valid bech32 address: ${err instanceof Error ? err.message : String(err)}`);
  }
  const bytes = bech32.fromWords(decoded.words);
  if (bytes.length !== ADDRESS_BYTES) {
    throw new Error(`cosmos staking: bech32 address carries ${bytes.length} bytes, expected ${ADDRESS_BYTES}`);
  }
  return { prefix: decoded.prefix, evmAddress: normalizeEvmAddress(`0x${bytesToHex(Uint8Array.from(bytes))}`) };
}

/** True when `address` is a well-formed bech32 address under exactly `prefix`
 *  carrying 20 bytes. Never throws: this is the form check a UI runs on input. */
export function isBech32AddressWithPrefix(address: string, prefix: string): boolean {
  try {
    return evmAddressFromBech32(address).prefix === prefix;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ABI codec: the small subset these calls need
// ---------------------------------------------------------------------------

const WORD = 32;
const HEX_RE = /^0x[0-9a-fA-F]*$/;

function parseHex(hex: string, label: string): Uint8Array {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) {
    throw new Error(`cosmos staking: ${label} must be a 0x-prefixed hex string`);
  }
  const body = hex.slice(2);
  if (body.length % 2 !== 0) throw new Error(`cosmos staking: ${label} has an odd number of hex digits`);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** A validated address as a 32-byte left-padded word. */
function addressWord(value: string, label: string): Uint8Array {
  if (typeof value !== 'string' || !isEvmAddress(value)) {
    throw new Error(`cosmos staking: ${label} is not a valid EVM address: ${String(value)}`);
  }
  const body = normalizeEvmAddress(value).slice(2).toLowerCase();
  const word = new Uint8Array(WORD);
  for (let i = 0; i < ADDRESS_BYTES; i++) word[WORD - ADDRESS_BYTES + i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return word;
}

/** A non-negative uint256 as one big-endian word. */
function uintWord(value: bigint, label: string): Uint8Array {
  if (typeof value !== 'bigint') throw new Error(`cosmos staking: ${label} must be a bigint`);
  if (value < 0n) throw new Error(`cosmos staking: ${label} must not be negative`);
  if (value > 2n ** 256n - 1n) throw new Error(`cosmos staking: ${label} exceeds uint256`);
  const word = new Uint8Array(WORD);
  let rest = value;
  for (let i = WORD - 1; i >= 0; i--) {
    word[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return word;
}

/** The TAIL of a dynamic `string`: its byte length, then the UTF-8 bytes right
 *  padded with zeros to a whole number of words. */
function stringTail(value: string, label: string): Uint8Array {
  if (typeof value !== 'string') throw new Error(`cosmos staking: ${label} must be a string`);
  const utf8 = utf8ToBytes(value);
  const padded = Math.ceil(utf8.length / WORD) * WORD;
  const out = new Uint8Array(WORD + padded);
  out.set(uintWord(BigInt(utf8.length), `${label} length`), 0);
  out.set(utf8, WORD);
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A validator operator address, checked to be bech32 under the chain's own
 *  valoper prefix BEFORE it goes into calldata. A validator string is the one
 *  argument here that names WHO the coins go to, so a typo must not survive to
 *  the node: the precompile would answer "validator does not exist", but only
 *  after the user armed and signed. */
function requireValoper(valoper: string, cfg: EvmCosmosStaking, label = 'validator'): string {
  if (!isBech32AddressWithPrefix(valoper, cfg.valoperPrefix)) {
    throw new Error(
      `cosmos staking: ${label} must be a ${cfg.valoperPrefix}1... address with a valid checksum, got: ${String(valoper)}`,
    );
  }
  return valoper;
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

/** delegate(delegator, validator, amount) / undelegate(...): identical shapes,
 *  head of three words with the string's tail after it (offset 96). */
function encodeAddressStringUint(selector: string, delegator: string, valoper: string, amountBase: bigint): Uint8Array {
  return concatBytes([
    parseHex(selector, 'selector'),
    addressWord(delegator, 'delegator'),
    uintWord(96n, 'validator offset'),
    uintWord(amountBase, 'amount'),
    stringTail(valoper, 'validator'),
  ]);
}

/** Calldata for `delegate(address,string,uint256)`. */
export function encodeDelegate(cfg: EvmCosmosStaking, delegator: string, valoper: string, amountBase: bigint): Uint8Array {
  return encodeAddressStringUint(COSMOS_STAKING_SELECTORS.delegate, delegator, requireValoper(valoper, cfg), amountBase);
}

/** Calldata for `undelegate(address,string,uint256)`. */
export function encodeUndelegate(cfg: EvmCosmosStaking, delegator: string, valoper: string, amountBase: bigint): Uint8Array {
  return encodeAddressStringUint(COSMOS_STAKING_SELECTORS.undelegate, delegator, requireValoper(valoper, cfg), amountBase);
}

/**
 * Calldata for `redelegate(address,string,string,uint256)`. Head of FOUR words:
 * the two string offsets are not both 128, because the destination's tail
 * begins after the source's, whose length depends on the source string.
 */
export function encodeRedelegate(
  cfg: EvmCosmosStaking,
  delegator: string,
  srcValoper: string,
  dstValoper: string,
  amountBase: bigint,
): Uint8Array {
  const src = requireValoper(srcValoper, cfg, 'source validator');
  const dst = requireValoper(dstValoper, cfg, 'destination validator');
  if (src === dst) throw new Error('cosmos staking: redelegate needs two different validators');
  const srcTail = stringTail(src, 'source validator');
  const head = 4 * WORD;
  return concatBytes([
    parseHex(COSMOS_STAKING_SELECTORS.redelegate, 'selector'),
    addressWord(delegator, 'delegator'),
    uintWord(BigInt(head), 'source offset'),
    uintWord(BigInt(head + srcTail.length), 'destination offset'),
    uintWord(amountBase, 'amount'),
    srcTail,
    stringTail(dst, 'destination validator'),
  ]);
}

/** delegation / unbondingDelegation / withdrawDelegatorRewards /
 *  delegationRewards: all `(address,string)`, head of two words, offset 64. */
function encodeAddressString(selector: string, delegator: string, valoper: string): Uint8Array {
  return concatBytes([
    parseHex(selector, 'selector'),
    addressWord(delegator, 'delegator'),
    uintWord(64n, 'validator offset'),
    stringTail(valoper, 'validator'),
  ]);
}

/** Calldata for `withdrawDelegatorRewards(address,string)`. */
export function encodeWithdrawDelegatorRewards(cfg: EvmCosmosStaking, delegator: string, valoper: string): Uint8Array {
  return encodeAddressString(
    COSMOS_DISTRIBUTION_SELECTORS.withdrawDelegatorRewards,
    delegator,
    requireValoper(valoper, cfg),
  );
}

/** eth_call data for `delegation(address,string)`, as a hex string. */
export function encodeDelegationQuery(cfg: EvmCosmosStaking, delegator: string, valoper: string): string {
  return `0x${bytesToHex(encodeAddressString(COSMOS_STAKING_SELECTORS.delegation, delegator, requireValoper(valoper, cfg)))}`;
}

/** eth_call data for `unbondingDelegation(address,string)`. */
export function encodeUnbondingDelegationQuery(cfg: EvmCosmosStaking, delegator: string, valoper: string): string {
  return `0x${bytesToHex(encodeAddressString(COSMOS_STAKING_SELECTORS.unbondingDelegation, delegator, requireValoper(valoper, cfg)))}`;
}

/** eth_call data for `delegationRewards(address,string)`. */
export function encodeDelegationRewardsQuery(cfg: EvmCosmosStaking, delegator: string, valoper: string): string {
  return `0x${bytesToHex(encodeAddressString(COSMOS_DISTRIBUTION_SELECTORS.delegationRewards, delegator, requireValoper(valoper, cfg)))}`;
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/** A cursor over ABI return data that refuses to read past the end, so a short
 *  or truncated answer throws instead of silently reading zeros. */
class AbiReader {
  constructor(private readonly bytes: Uint8Array) {}

  word(at: number): bigint {
    if (at < 0 || at + WORD > this.bytes.length) {
      throw new Error(`cosmos staking: return data ends before offset ${at + WORD} (have ${this.bytes.length})`);
    }
    return bytesToBigint(this.bytes.subarray(at, at + WORD));
  }

  /** A word read as a byte OFFSET: must fit in the data and be word aligned. */
  offset(at: number, base = 0): number {
    const raw = this.word(at);
    if (raw > BigInt(this.bytes.length)) {
      throw new Error(`cosmos staking: offset ${raw.toString()} is past the ${this.bytes.length} bytes of return data`);
    }
    const value = base + Number(raw);
    if (value % WORD !== 0) throw new Error(`cosmos staking: offset ${value} is not word aligned`);
    if (value < 0 || value >= this.bytes.length) {
      throw new Error(`cosmos staking: offset ${value} is outside the return data`);
    }
    return value;
  }

  /** A dynamic `string` whose LENGTH word sits at `at`. */
  string(at: number): string {
    const length = Number(this.word(at));
    const start = at + WORD;
    if (!Number.isSafeInteger(length) || length < 0 || start + length > this.bytes.length) {
      throw new Error(`cosmos staking: string at ${at} declares ${length} bytes, which the return data does not hold`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(start, start + length));
  }

  /** An array's element COUNT at `at`, refused when the data cannot hold it. */
  count(at: number, minBytesPerElement: number): number {
    const raw = this.word(at);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('cosmos staking: array length is not a usable number');
    if (at + WORD + value * minBytesPerElement > this.bytes.length) {
      throw new Error(`cosmos staking: array declares ${value} elements, which the return data does not hold`);
    }
    return value;
  }
}

/** One `Coin`: an integer amount in a base denom. */
export interface CosmosCoin {
  denom: string;
  /** Base units (aepix), exact. */
  amountBase: bigint;
}

/** What `delegation(address,string)` answers. */
export interface CosmosDelegationResult {
  /** The delegation's shares as the chain reports them: a Dec, so scaled by
   *  1e18. Kept raw and NEVER shown: shares are not coins, and the ratio to
   *  coins moves when a validator is slashed. `balance` is the figure to use. */
  sharesRaw: bigint;
  /** What those shares are worth right now, in the bond denom. */
  balance: CosmosCoin;
}

/**
 * Decode `delegation(address,string)` return data: `(uint256 shares, Coin balance)`.
 *
 * PINNED to live bytes (cosmosStaking.test.ts): a validator's own
 * self-delegation answered shares 41944485374850759379098000000000000000000
 * and Coin{"aepix", 41944485374850759379098}, and the chain's REST reported
 * shares "41944485374850759379098.000000000000000000" with balance amount
 * "41944485374850759379098" for the same pair. The Coin amount is the plain
 * integer; the shares word is that same figure times 1e18.
 */
export function decodeDelegationResult(returnData: string): CosmosDelegationResult {
  const reader = new AbiReader(parseHex(returnData, 'delegation return data'));
  const sharesRaw = reader.word(0);
  // Head word 1 is the offset of the Coin tuple, measured from the start of the
  // return data. The tuple is dynamic (it carries a string), so its own head
  // words hold offsets measured from the start of the TUPLE, not of the data.
  const tuple = reader.offset(WORD);
  const denomAt = reader.offset(tuple, tuple);
  const amountBase = reader.word(tuple + WORD);
  return { sharesRaw, balance: { denom: reader.string(denomAt), amountBase } };
}

/** One entry of an unbonding delegation: a fixed amount that becomes spendable
 *  at a fixed moment. Several can be in flight at once, up to the chain's
 *  `max_entries` per (delegator, validator) pair. */
export interface CosmosUnbondingEntry {
  /** The block the undelegate was made in. Needed to cancel one. */
  creationHeight: bigint;
  /** Unix MILLISECONDS. The ABI carries seconds as an int64. */
  completionTime: number;
  /** What was undelegated, in base units. */
  initialBalanceBase: bigint;
  /** What is still to be released (slashing can reduce it), in base units. */
  balanceBase: bigint;
}

/** int64 is two's complement in a 32-byte word: read the sign. */
function asInt64(word: bigint): bigint {
  const limit = 2n ** 255n;
  return word >= limit ? word - 2n ** 256n : word;
}

/**
 * Decode `unbondingDelegation(address,string)` return data: one dynamic tuple
 * `(string delegatorAddress, string validatorAddress, UnbondingDelegationEntry[] entries)`
 * where each entry is a STATIC tuple of six words, so the array is a count
 * followed by the entries laid out inline with no per-element offsets.
 *
 * PINNED to the live empty answer (both accounts checked on 2026-08-24 held no
 * unbonding delegation) and to a hand-built two-entry vector.
 */
export function decodeUnbondingDelegationResult(returnData: string): CosmosUnbondingEntry[] {
  const reader = new AbiReader(parseHex(returnData, 'unbondingDelegation return data'));
  const tuple = reader.offset(0);
  const entriesAt = reader.offset(tuple + 2 * WORD, tuple);
  const ENTRY_WORDS = 6;
  const count = reader.count(entriesAt, ENTRY_WORDS * WORD);
  const out: CosmosUnbondingEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = entriesAt + WORD + i * ENTRY_WORDS * WORD;
    out.push({
      creationHeight: asInt64(reader.word(at)),
      // int64 seconds since the epoch, as x/staking stores it.
      completionTime: Number(asInt64(reader.word(at + WORD))) * 1000,
      initialBalanceBase: reader.word(at + 2 * WORD),
      balanceBase: reader.word(at + 3 * WORD),
      // Words 4 and 5 are unbondingId (uint64) and unbondingOnHoldRefCount
      // (int64): consensus bookkeeping, nothing the user acts on.
    });
  }
  return out;
}

/**
 * Decode a `DecCoin[]` return value (`delegationRewards`).
 *
 * DecCoin in this ABI is `(string denom, uint256 amount, uint8 precision)`, a
 * DYNAMIC tuple, so the array is a count followed by one offset per element.
 * `amount` arrives already TRUNCATED to the base denom, and `precision` is that
 * denom's exponent (18 for aepix). Established live rather than assumed: for a
 * validator's self-delegation this answered {"aepix", 81240454787509949141, 18}
 * at the same moment REST reported "81240454787509949141.842793923993686798",
 * so the word is the integer part and NOT a 1e18-scaled Dec. Reading it as the
 * latter would have understated every reward by eighteen orders of magnitude.
 */
export function decodeDecCoins(returnData: string): Array<CosmosCoin & { precision: number }> {
  const reader = new AbiReader(parseHex(returnData, 'DecCoin[] return data'));
  const arrayAt = reader.offset(0);
  const count = reader.count(arrayAt, WORD);
  const headAt = arrayAt + WORD;
  const out: Array<CosmosCoin & { precision: number }> = [];
  for (let i = 0; i < count; i++) {
    const tuple = reader.offset(headAt + i * WORD, headAt);
    const denomAt = reader.offset(tuple, tuple);
    out.push({
      denom: reader.string(denomAt),
      amountBase: reader.word(tuple + WORD),
      precision: Number(reader.word(tuple + 2 * WORD)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading a staking transaction BACK from its calldata
//
// The encoders above turn an intention into bytes. This turns bytes back into
// the intention, so Activity can say what a transaction did and to whom rather
// than listing it as an anonymous "contract interaction" (owner, 2026-08-24:
// "w activity powinna byc historia co staked co nie i gdzie").
//
// NEVER THROWS. Everything it is handed is foreign data: an indexer's row, a
// node's answer, a transaction somebody else composed. Anything it cannot read
// with certainty is `null`, which the UI renders as an ordinary unlabelled row.
// A half-decoded label naming the wrong validator would be worse than none.
// ---------------------------------------------------------------------------

/** What one staking precompile call did. `amountBase` is in the bond denom's
 *  base units (aepix). For a redelegate `validator` is the SOURCE and
 *  `validatorDst` the destination. */
export interface StakingCallInfo {
  kind: 'stake' | 'unstake' | 'redelegate' | 'claim';
  /** Operator address ('epixvaloper1...'), verbatim from the calldata. */
  validator: string;
  /** Redelegate only: where the stake moved TO. */
  validatorDst?: string;
  /** For stake / unstake / redelegate: read straight out of the calldata.
   *
   *  For a CLAIM it is absent at first and filled in later: the calldata carries
   *  no amount (the chain pays whatever accrued), so the figure comes from the
   *  confirmed transaction's RECEIPT via `decodeWithdrawnRewards`. Absent means
   *  "not known yet", and the label prints no amount rather than 0. */
  amountBase?: bigint;
}

/** Selector -> what the call does. Built from the pinned selectors above, so a
 *  change there cannot leave the decoder reading the old bytes. */
const STAKING_CALL_KINDS: Readonly<Record<string, StakingCallInfo['kind']>> = Object.freeze({
  [COSMOS_STAKING_SELECTORS.delegate]: 'stake',
  [COSMOS_STAKING_SELECTORS.undelegate]: 'unstake',
  [COSMOS_STAKING_SELECTORS.redelegate]: 'redelegate',
  [COSMOS_DISTRIBUTION_SELECTORS.withdrawDelegatorRewards]: 'claim',
});

/**
 * Decode the calldata of a staking / distribution precompile WRITE call.
 *
 * Returns null for a selector this wallet does not know, for calldata shorter
 * than its own head, and for any offset or length the bytes do not actually
 * hold. The read-only selectors (delegation, unbondingDelegation,
 * delegationRewards) decode to null on purpose: they are eth_call queries, not
 * transactions, and one never appears in a history row.
 */
export function decodeStakingCall(data: Uint8Array): StakingCallInfo | null {
  if (!(data instanceof Uint8Array) || data.length < 4) return null;
  const kind = STAKING_CALL_KINDS[`0x${bytesToHex(data.subarray(0, 4))}`];
  if (!kind) return null;
  // Offsets inside the argument block are measured from the end of the
  // selector, so the reader is given exactly that block.
  const reader = new AbiReader(data.subarray(4));
  try {
    if (kind === 'claim') {
      // withdrawDelegatorRewards(address,string): head of two words.
      const validator = reader.string(reader.offset(WORD));
      return validator ? { kind, validator } : null;
    }
    if (kind === 'redelegate') {
      // redelegate(address,string,string,uint256): head of four words, and the
      // two string offsets differ (the second tail follows the first).
      const srcAt = reader.offset(WORD);
      const dstAt = reader.offset(2 * WORD);
      const amountBase = reader.word(3 * WORD);
      const validator = reader.string(srcAt);
      const validatorDst = reader.string(dstAt);
      return validator && validatorDst ? { kind, validator, validatorDst, amountBase } : null;
    }
    // delegate / undelegate(address,string,uint256): head of three words.
    const at = reader.offset(WORD);
    const amountBase = reader.word(2 * WORD);
    const validator = reader.string(at);
    return validator ? { kind, validator, amountBase } : null;
  } catch {
    return null;
  }
}

/** decodeStakingCall over a 0x hex string, as an indexer row or a node answer
 *  carries it. '0x', a non-hex string and an odd digit count are all null. */
export function decodeStakingCallHex(input: unknown): StakingCallInfo | null {
  if (typeof input !== 'string') return null;
  let bytes: Uint8Array;
  try {
    bytes = parseHex(input, 'calldata');
  } catch {
    return null;
  }
  return decodeStakingCall(bytes);
}

// ---------------------------------------------------------------------------
// Reading a CLAIM's amount back from its RECEIPT
//
// A claim's calldata carries no amount: `withdrawDelegatorRewards(address,string)`
// names a validator and the chain pays whatever has accrued. The amount exists
// only after execution, in the receipt, as an event the distribution precompile
// emits. So Activity can say HOW MUCH a claim withdrew, but only for a CONFIRMED
// transaction, and only at the cost of one eth_getTransactionReceipt.
//
// VERIFIED ON CHAIN before a line of this was written (2026-08-24), against the
// owner's two real claims on Epix from 0x1Ed2c7D71FbEb281073343aC2d317433679D0153:
//
//   0xe82c12e1...b2a4  log[0] from 0x...0801
//     topics[0] 0xcf871d3149ad677b268b0238a4ffc6d4008f48a11e73468d05ff00e75f204035
//     topics[1] 0x...1ed2c7d71fbeb281073343ac2d317433679d0153   (the delegator)
//     topics[2] 0x...f9a745a2ba871b9ae5e4a68fbe6b36397f204851   (the validator)
//     data      0x...009c59a59da09590  = 44008664215885200 aepix = 0.0440086 EPIX
//
// topics[2] is the 0x form of `epixvaloper1lxn5tg46sude4e0y568mu6ek89ljqjz3m0he4x`,
// the very validator named in that transaction's own calldata, and the magnitude
// matches the ~0.03 EPIX the owner had pending. The second claim decoded to
// 81137014486010529 aepix (0.0811 EPIX) for a second validator, same shape.
// ---------------------------------------------------------------------------

/**
 * '0x' plus the FULL keccak-256 of a canonical event signature: an EVM log's
 * `topics[0]`. Same computation as `cosmosSelector` without the 4-byte cut, and
 * the literals below are asserted against it in the tests, so a wrong pin cannot
 * survive.
 */
export function cosmosEventTopic(signature: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}`;
}

/**
 * x/distribution precompile events, signatures verbatim from github.com/cosmos/evm
 * `precompiles/distribution/abi.json` (fetched 2026-08-24).
 *
 * `withdrawDelegatorRewards` emits WithdrawDelegatorReward, ONE per call, which
 * is the only one this wallet can produce today. `claimRewards` (claim from N
 * validators at once) emits the aggregate ClaimRewards; it is decoded too so a
 * receipt made by another wallet, or by a later version of this one, still reads
 * correctly. The two are emitted by different methods and never together.
 *
 * NOTE the singular: the EVENT is `WithdrawDelegatorReward`, the METHOD is
 * `withdrawDelegatorRewards`. Pinning the plural would have matched nothing.
 */
export const COSMOS_DISTRIBUTION_EVENTS = Object.freeze({
  /** WithdrawDelegatorReward(address indexed, address indexed, uint256).
   *  MATCHED AGAINST THE OWNER'S REAL CLAIM (see the block above). */
  withdrawDelegatorReward: '0xcf871d3149ad677b268b0238a4ffc6d4008f48a11e73468d05ff00e75f204035',
  /** ClaimRewards(address indexed, uint256). */
  claimRewards: '0x1f89f96333d3133000ee447473151fa9606543368f02271c9d95ae14f13bcc67',
} as const);

/** A 32-byte indexed topic holds a 20-byte address in its LOW bytes. */
function topicIsAddress(topic: unknown, address: string): boolean {
  if (typeof topic !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return false;
  return topic.slice(-40).toLowerCase() === address.replace(/^0x/, '').toLowerCase();
}

/** The FIRST 32-byte word of a log's data as a uint256, or null when the data
 *  cannot hold one. */
function firstDataWord(data: unknown): bigint | null {
  if (typeof data !== 'string' || !HEX_RE.test(data)) return null;
  const body = data.slice(2);
  if (body.length < 64) return null;
  return BigInt(`0x${body.slice(0, 64)}`);
}

/**
 * How much a confirmed claim actually withdrew, from its receipt's logs.
 *
 * Returns:
 *   - the amount in the bond denom's base units, SUMMED over every matching log
 *     (a receipt from `claimRewards` carries one per validator);
 *   - `0n` when the logs were readable but carry no reward event for this
 *     account: a claim the chain reverted, or one where nothing had accrued.
 *     That is a KNOWN answer, not a missing one, so the caller can record it and
 *     stop asking; the label prints no amount for it either way (never "0");
 *   - `null` only when `logs` is not a list this function can read at all, which
 *     is the caller's signal to try again later.
 *
 * NEVER THROWS: every input is foreign data (a node's answer).
 */
export function decodeWithdrawnRewards(args: {
  /** `receipt.logs`, verbatim. */
  logs: unknown;
  /** The chain's distribution precompile; logs from anywhere else are ignored. */
  distributionPrecompile: string;
  /** The account whose claim this is: topics[1] of the event. */
  delegator: string;
}): bigint | null {
  const { logs, distributionPrecompile, delegator } = args;
  if (!Array.isArray(logs)) return null;
  if (typeof distributionPrecompile !== 'string' || typeof delegator !== 'string' || !isEvmAddress(delegator)) {
    return null;
  }
  const precompile = distributionPrecompile.toLowerCase();
  let withdrawn: bigint | null = null;
  let claimed: bigint | null = null;
  for (const log of logs) {
    if (!log || typeof log !== 'object') continue;
    const o = log as Record<string, unknown>;
    if (typeof o.address !== 'string' || o.address.toLowerCase() !== precompile) continue;
    if (!Array.isArray(o.topics) || o.topics.length === 0) continue;
    const topic0 = typeof o.topics[0] === 'string' ? o.topics[0].toLowerCase() : '';
    // topics[1] is the delegator on BOTH events: a receipt can carry a log for
    // somebody else (a precompile call made inside the same transaction), and
    // adding that into this row's figure would invent money.
    if (!topicIsAddress(o.topics[1], delegator)) continue;
    const amount = firstDataWord(o.data);
    if (amount === null) continue;
    if (topic0 === COSMOS_DISTRIBUTION_EVENTS.withdrawDelegatorReward && o.topics.length >= 3) {
      withdrawn = (withdrawn ?? 0n) + amount;
    } else if (topic0 === COSMOS_DISTRIBUTION_EVENTS.claimRewards) {
      claimed = (claimed ?? 0n) + amount;
    }
  }
  // The per-validator events are the precise answer; the aggregate is the
  // fallback for a receipt that carries only it. Never both added together.
  return withdrawn ?? claimed ?? 0n;
}

/** True when `address` is one of a chain's two staking precompiles. Case
 *  insensitive: an indexer answers lowercase, the registry is checksummed, and
 *  a case-sensitive compare here would silently label nothing. */
export function isStakingPrecompileAddress(
  precompiles: Pick<EvmCosmosStaking, 'stakingPrecompile' | 'distributionPrecompile'>,
  address: string | null | undefined,
): boolean {
  if (typeof address !== 'string' || address === '') return false;
  const a = address.toLowerCase();
  return a === precompiles.stakingPrecompile.toLowerCase() || a === precompiles.distributionPrecompile.toLowerCase();
}

// ---------------------------------------------------------------------------
// Plan builders: the bytes a transaction carries, and the words for the user
// ---------------------------------------------------------------------------

/** One contract (here: precompile) call, ready for the generic EVM call plan.
 *  `value` is always 0n on this path: a delegation moves coins through the
 *  module, never by attaching them to the transaction. */
export interface CosmosStakingCall {
  to: string;
  data: Uint8Array;
  value: bigint;
  /** What this call does, in words, for the review step. */
  description: string;
  /** Which action it is, so the UI can attach the right warning. */
  kind: 'delegate' | 'undelegate' | 'redelegate' | 'claim';
}

/** Delegate `amountBase` of the bond denom to `valoper`. */
export function planDelegate(args: {
  staking: EvmCosmosStaking;
  delegator: string;
  valoper: string;
  amountBase: bigint;
  /** For the sentence only. */
  amountText: string;
  ticker: string;
  moniker?: string;
}): CosmosStakingCall {
  const { staking, delegator, valoper, amountBase, amountText, ticker } = args;
  if (amountBase <= 0n) throw new Error('cosmos staking: enter an amount greater than zero.');
  return {
    to: staking.stakingPrecompile,
    data: encodeDelegate(staking, delegator, valoper, amountBase),
    value: 0n,
    kind: 'delegate',
    description: `Stake ${amountText} ${ticker} with ${describeValidator(valoper, args.moniker)}.`,
  };
}

/** Undelegate `amountBase` from `valoper`. The coins are locked for the chain's
 *  unbonding time; the CALLER supplies that sentence, because the real value is
 *  read from the chain's params and never hardcoded here. */
export function planUndelegate(args: {
  staking: EvmCosmosStaking;
  delegator: string;
  valoper: string;
  amountBase: bigint;
  amountText: string;
  ticker: string;
  moniker?: string;
}): CosmosStakingCall {
  const { staking, delegator, valoper, amountBase, amountText, ticker } = args;
  if (amountBase <= 0n) throw new Error('cosmos staking: enter an amount greater than zero.');
  return {
    to: staking.stakingPrecompile,
    data: encodeUndelegate(staking, delegator, valoper, amountBase),
    value: 0n,
    kind: 'undelegate',
    description: `Unstake ${amountText} ${ticker} from ${describeValidator(valoper, args.moniker)}.`,
  };
}

/** Move `amountBase` from one validator to another without unbonding. */
export function planRedelegate(args: {
  staking: EvmCosmosStaking;
  delegator: string;
  srcValoper: string;
  dstValoper: string;
  amountBase: bigint;
  amountText: string;
  ticker: string;
  srcMoniker?: string;
  dstMoniker?: string;
}): CosmosStakingCall {
  const { staking, delegator, srcValoper, dstValoper, amountBase, amountText, ticker } = args;
  if (amountBase <= 0n) throw new Error('cosmos staking: enter an amount greater than zero.');
  return {
    to: staking.stakingPrecompile,
    data: encodeRedelegate(staking, delegator, srcValoper, dstValoper, amountBase),
    value: 0n,
    kind: 'redelegate',
    description:
      `Move ${amountText} ${ticker} from ${describeValidator(srcValoper, args.srcMoniker)} ` +
      `to ${describeValidator(dstValoper, args.dstMoniker)}.`,
  };
}

/** Withdraw the pending rewards of ONE validator. */
export function planClaimRewards(args: {
  staking: EvmCosmosStaking;
  delegator: string;
  valoper: string;
  moniker?: string;
  /** The pending figure as shown, for the sentence. */
  amountText?: string;
  ticker: string;
}): CosmosStakingCall {
  const { staking, delegator, valoper, ticker } = args;
  const amount = args.amountText ? `${args.amountText} ${ticker}` : `your pending ${ticker} rewards`;
  return {
    to: staking.distributionPrecompile,
    data: encodeWithdrawDelegatorRewards(staking, delegator, valoper),
    value: 0n,
    kind: 'claim',
    description: `Claim ${amount} from ${describeValidator(valoper, args.moniker)}.`,
  };
}

/** "Moniker (epixvaloper1abcd...wxyz)", or just the address when unnamed. A
 *  review step names BOTH: a moniker is chosen by the validator and two can
 *  share one, the address cannot be spoofed. */
export function describeValidator(valoper: string, moniker?: string): string {
  const short = valoper.length > 22 ? `${valoper.slice(0, 14)}...${valoper.slice(-6)}` : valoper;
  const name = moniker?.trim();
  return name ? `${name} (${short})` : short;
}

// ---------------------------------------------------------------------------
// Cosmos REST (LCD): the lists the precompiles cannot answer cheaply
// ---------------------------------------------------------------------------

/** Per REST request. The LCD is not on the critical path of a balance read. */
const REST_TIMEOUT_MS = 15_000;

/** The gateway proxy caps `pagination.limit` at 200, so nothing here asks for
 *  more. The chain's max_validators is 100, so one page covers the set. */
export const REST_PAGE_LIMIT = 200;

/** Length cap on any text this module did not write (an LCD error body), so
 *  nothing unbounded reaches an error message or a log. */
const MAX_DETAIL = 200;

/** Why a REST read failed. The UI says different things for each: 'unavailable'
 *  is "we could not reach the chain", 'refused' is "it answered, badly". */
export class CosmosRestError extends Error {
  readonly reason: 'unavailable' | 'refused' | 'malformed';
  constructor(reason: 'unavailable' | 'refused' | 'malformed', detail: string) {
    super(`cosmos rest: ${reason}: ${detail.slice(0, MAX_DETAIL)}`);
    this.name = 'CosmosRestError';
    this.reason = reason;
  }
}

export interface CosmosRestOptions {
  /** Origin or gateway proxy base, no trailing slash (endpoints.ts
   *  cosmosRestBaseUrl decides which). */
  baseUrl: string;
  /** `X-Satori-Client` on a gateway build, empty against the chain's own LCD
   *  (so no CORS preflight is provoked on a third-party host). */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One GET against the LCD, JSON in, JSON out. `path` starts with '/'. */
async function restGet(opts: CosmosRestOptions, path: string): Promise<Record<string, unknown>> {
  if (!path.startsWith('/cosmos/')) {
    // The gateway proxy only passes cosmos/... through, and a path built from
    // anything but a literal here would be a bug worth catching locally.
    throw new CosmosRestError('malformed', `path must start with /cosmos/, got ${path}`);
  }
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${opts.baseUrl}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...(opts.headers ?? {}) },
      signal: controller.signal,
    });
  } catch (err) {
    throw new CosmosRestError('unavailable', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let body = '';
    try {
      body = (await response.text()).slice(0, MAX_DETAIL);
    } catch {
      body = '';
    }
    throw new CosmosRestError(response.status >= 500 ? 'unavailable' : 'refused', `HTTP ${response.status} ${body}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new CosmosRestError('malformed', err instanceof Error ? err.message : String(err));
  }
  if (!isRecord(parsed)) throw new CosmosRestError('malformed', 'the LCD did not answer with an object');
  return parsed;
}

/** A decimal STRING in base units ("41944485374850759379098") to bigint.
 *  Anything else is refused rather than guessed at: this is money. */
function integerString(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new CosmosRestError('malformed', `${label} is not an integer string`);
  }
  return BigInt(value);
}

/**
 * A Cosmos `Dec` string ("81240454787509949141.842793923993686798") to base
 * units, TRUNCATED at the decimal point. Truncation, never rounding: a reward
 * shown one base unit above what the chain will pay is money that is not there.
 * (One aepix is 1e-18 EPIX, so the discarded part is invisible either way; the
 * rule is what matters.)
 */
function decTruncatedToBase(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^-?[0-9]+(\.[0-9]+)?$/.test(value)) {
    throw new CosmosRestError('malformed', `${label} is not a decimal string`);
  }
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const dot = body.indexOf('.');
  const whole = BigInt(dot === -1 ? body : body.slice(0, dot));
  return negative ? -whole : whole;
}

/** A Dec RATE ("0.010000000000000000") as a fraction, for a commission percent.
 *  Returned as a number on purpose: it is a display figure with two meaningful
 *  digits, never an amount, and nothing is computed from it. */
function decRateToNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[0-9]+(\.[0-9]+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The staking module's parameters. Read, never hardcoded: a chain can change
 *  its unbonding time by governance, and the warning the user reads must be the
 *  chain's actual answer. */
export interface CosmosStakingParams {
  /** Seconds. The chain reports "1814400s"; Epix answered exactly that (21
   *  days) on 2026-08-24. */
  unbondingTimeSeconds: number;
  bondDenom: string;
  /** How many unbonding entries one (delegator, validator) pair may have in
   *  flight. Epix: 7. An eighth undelegate fails at the node. */
  maxEntries: number;
  maxValidators: number;
}

export async function fetchStakingParams(opts: CosmosRestOptions): Promise<CosmosStakingParams> {
  const body = await restGet(opts, '/cosmos/staking/v1beta1/params');
  const params = body.params;
  if (!isRecord(params)) throw new CosmosRestError('malformed', 'params missing');
  const raw = params.unbonding_time;
  // "1814400s" (a protobuf Duration as JSON). A value without the 's', or one
  // this wallet cannot read, is refused: showing "0 days" would be worse than
  // showing that the figure is unknown.
  if (typeof raw !== 'string' || !/^[0-9]+(\.[0-9]+)?s$/.test(raw)) {
    throw new CosmosRestError('malformed', `unbonding_time is not a duration: ${String(raw)}`);
  }
  const bondDenom = typeof params.bond_denom === 'string' ? params.bond_denom : '';
  if (!bondDenom) throw new CosmosRestError('malformed', 'bond_denom missing');
  return {
    unbondingTimeSeconds: Math.trunc(Number(raw.slice(0, -1))),
    bondDenom,
    maxEntries: Number(params.max_entries) || 0,
    maxValidators: Number(params.max_validators) || 0,
  };
}

/** One validator, as the list screen shows it. */
export interface CosmosValidator {
  /** 'epixvaloper1...'. The identity; the moniker is a label. */
  operatorAddress: string;
  moniker: string;
  jailed: boolean;
  /** 'BOND_STATUS_BONDED' and friends, verbatim. */
  status: string;
  /** Voting power, in the bond denom's base units. */
  tokensBase: bigint;
  /** Commission as a fraction (0.01 = 1%), or null when unreadable. */
  commissionRate: number | null;
  website: string;
  details: string;
}

/**
 * Bonded validators, newest page only (one page covers the set: max_validators
 * is 100 and the limit here is 200).
 *
 * `status=BOND_STATUS_BONDED` is sent as a query rather than filtered here,
 * because unbonded and unbonding validators earn nothing and delegating to them
 * is almost never what a user means. Jailed validators CAN still appear in the
 * bonded set right after being jailed, so the flag is carried through and the
 * screen filters on it.
 */
export async function fetchBondedValidators(opts: CosmosRestOptions): Promise<CosmosValidator[]> {
  const body = await restGet(
    opts,
    `/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=${REST_PAGE_LIMIT}`,
  );
  const rows = body.validators;
  if (!Array.isArray(rows)) throw new CosmosRestError('malformed', 'validators missing');
  const out: CosmosValidator[] = [];
  for (const row of rows) {
    // One unreadable validator must not hide the other ninety-nine (the same
    // rule the Etherscan indexer follows for a bad row).
    if (!isRecord(row)) continue;
    try {
      const description = isRecord(row.description) ? row.description : {};
      const commission = isRecord(row.commission) && isRecord(row.commission.commission_rates)
        ? row.commission.commission_rates
        : {};
      out.push({
        operatorAddress: String(row.operator_address ?? ''),
        moniker: typeof description.moniker === 'string' ? description.moniker : '',
        jailed: row.jailed === true,
        status: typeof row.status === 'string' ? row.status : '',
        tokensBase: integerString(row.tokens, 'validator tokens'),
        commissionRate: decRateToNumber(commission.rate),
        website: typeof description.website === 'string' ? description.website : '',
        details: typeof description.details === 'string' ? description.details : '',
      });
    } catch {
      continue;
    }
  }
  // Highest voting power first: that is the order the screen shows, and sorting
  // here keeps the screen free of amount arithmetic.
  return out.sort((a, b) => (a.tokensBase === b.tokensBase ? 0 : a.tokensBase > b.tokensBase ? -1 : 1));
}

/** What this account has staked with one validator. */
export interface CosmosDelegation {
  valoper: string;
  /** In the bond denom's base units. */
  amountBase: bigint;
}

export async function fetchDelegations(opts: CosmosRestOptions, bech32Address: string): Promise<CosmosDelegation[]> {
  const body = await restGet(
    opts,
    `/cosmos/staking/v1beta1/delegations/${encodeURIComponent(bech32Address)}?pagination.limit=${REST_PAGE_LIMIT}`,
  );
  const rows = body.delegation_responses;
  if (!Array.isArray(rows)) throw new CosmosRestError('malformed', 'delegation_responses missing');
  const out: CosmosDelegation[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !isRecord(row.delegation) || !isRecord(row.balance)) continue;
    try {
      out.push({
        valoper: String(row.delegation.validator_address ?? ''),
        amountBase: integerString(row.balance.amount, 'delegation balance'),
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => (a.amountBase === b.amountBase ? 0 : a.amountBase > b.amountBase ? -1 : 1));
}

/** One in-flight unbonding, per validator. */
export interface CosmosUnbonding {
  valoper: string;
  entries: CosmosUnbondingEntry[];
}

export async function fetchUnbondingDelegations(
  opts: CosmosRestOptions,
  bech32Address: string,
): Promise<CosmosUnbonding[]> {
  const body = await restGet(
    opts,
    `/cosmos/staking/v1beta1/delegators/${encodeURIComponent(bech32Address)}/unbonding_delegations?pagination.limit=${REST_PAGE_LIMIT}`,
  );
  const rows = body.unbonding_responses;
  if (!Array.isArray(rows)) throw new CosmosRestError('malformed', 'unbonding_responses missing');
  const out: CosmosUnbonding[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !Array.isArray(row.entries)) continue;
    const entries: CosmosUnbondingEntry[] = [];
    for (const entry of row.entries) {
      if (!isRecord(entry)) continue;
      try {
        // completion_time is RFC 3339 here (the ABI carries seconds); an
        // unparseable stamp drops the entry rather than showing "Invalid Date".
        const at = Date.parse(String(entry.completion_time ?? ''));
        if (!Number.isFinite(at)) continue;
        entries.push({
          creationHeight: integerString(entry.creation_height, 'creation_height'),
          completionTime: at,
          initialBalanceBase: integerString(entry.initial_balance, 'initial_balance'),
          balanceBase: integerString(entry.balance, 'unbonding balance'),
        });
      } catch {
        continue;
      }
    }
    if (entries.length > 0) {
      out.push({ valoper: String(row.validator_address ?? ''), entries: entries.sort((a, b) => a.completionTime - b.completionTime) });
    }
  }
  return out;
}

/** Pending rewards, per validator and in total, in the bond denom. */
export interface CosmosRewards {
  /** Keyed by validator operator address. */
  perValidator: Map<string, bigint>;
  totalBase: bigint;
}

/**
 * `/cosmos/distribution/v1beta1/delegators/{addr}/rewards`.
 *
 * Amounts are Dec strings and are truncated to base units (see
 * decTruncatedToBase). Only the BOND DENOM is counted: a chain can pay rewards
 * in several denoms, and adding a foreign denom into an EPIX total would be a
 * fabricated number.
 */
export async function fetchPendingRewards(
  opts: CosmosRestOptions,
  bech32Address: string,
  bondDenom: string,
): Promise<CosmosRewards> {
  const body = await restGet(
    opts,
    `/cosmos/distribution/v1beta1/delegators/${encodeURIComponent(bech32Address)}/rewards`,
  );
  const perValidator = new Map<string, bigint>();
  const rows = Array.isArray(body.rewards) ? body.rewards : [];
  for (const row of rows) {
    if (!isRecord(row) || !Array.isArray(row.reward)) continue;
    let sum = 0n;
    for (const coin of row.reward) {
      if (!isRecord(coin) || coin.denom !== bondDenom) continue;
      try {
        sum += decTruncatedToBase(coin.amount, 'reward amount');
      } catch {
        continue;
      }
    }
    const valoper = String(row.validator_address ?? '');
    if (valoper) perValidator.set(valoper, sum);
  }
  let totalBase = 0n;
  const totals = Array.isArray(body.total) ? body.total : [];
  for (const coin of totals) {
    if (!isRecord(coin) || coin.denom !== bondDenom) continue;
    try {
      totalBase += decTruncatedToBase(coin.amount, 'total reward amount');
    } catch {
      continue;
    }
  }
  return { perValidator, totalBase };
}
