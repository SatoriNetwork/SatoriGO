// Zcash transparent send builder: input selection, ZIP-317 fee, dust, ZIP-203
// expiry, and ZIP-244 signing (design docs/design/zcash-engine.md §4.5, §4.6).
//
// Rules, each pinned by builder.test.ts:
//
// - Spend only confirmed, non-coinbase P2PKH UTXOs of the watch set. A
//   coinbase output may only be spent by a transaction with NO transparent
//   outputs (protocol spec §7.1.2), so a transparent-only wallet can never
//   spend one; it is never selected.
// - Largest-first until amount + fee is covered, recomputing the fee as
//   inputs are added; change to /0/0. MAX spends every spendable input to one
//   output.
// - Fee = ZIP-317 exactly (5000 * max(2, nIn, nOut)); change below the 54-zat
//   dust threshold is folded into the fee. A fee above 0.01 ZEC is refused.
// - nExpiryHeight = tip + 1 + 40, capped at upgradeHeight - 1 when a network
//   upgrade is pending, and the send is refused when fewer than 3 blocks
//   would remain after the next one (zcashd's "expiring soon" rule).
// - The consensus branch id is an ARGUMENT, always taken from /zec/main/info
//   by the caller. Nothing here hardcodes one.
// - Every input's key must own the input's P2PKH script, or nothing is signed.
// - Signatures are RFC 6979 with low-S, DER || SIGHASH_ALL.
//
// Keys are borrowed, never copied or zeroed here: their owner zeroes them.

import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { hash160 } from '../keys';
import { ZcashAddressError, decodeZcashAddress, p2pkhScript, type ZcashNetwork } from './address';
import {
  ZCASH_DUST_ZAT,
  ZCASH_MAX_FEE_ZAT,
  ZcashFeeError,
  assertZcashFeeSane,
  formatZec,
  zip317FeeP2pkh,
} from './fees';
import type { ZcashKey, ZcashKeys } from './keys';
import { SIGHASH_ALL, displayHex, zcashTxDigests, transparentSigDigest, type ZcashCoin } from './sighash';
import {
  ZCASH_SEQUENCE_FINAL,
  ZCASH_V5_HEADER,
  ZCASH_V5_VERSION_GROUP_ID,
  ZCASH_V6_HEADER,
  ZCASH_V6_VERSION_GROUP_ID,
  serializeV5,
  type ZcashParsedTx,
} from './tx';

/** v5 now; flipping to 6 is a wallet release (design §4.2, §14). */
export const ZCASH_TX_VERSION: 5 | 6 = 5;
/** Blocks after the next one that a transaction stays valid (post-Blossom default). */
export const ZCASH_EXPIRY_DELTA = 40;
/** Refuse to build when fewer blocks than this would remain before expiry. */
export const ZCASH_MIN_EXPIRY_MARGIN = 3;
/** ZIP-203: nExpiryHeight must be below 500,000,000. */
export const ZCASH_MAX_EXPIRY_HEIGHT = 499_999_999;

export interface ZcashUtxo {
  /** Display-order hex. */
  txid: string;
  index: number;
  valueZat: bigint;
  script: Uint8Array;
  /** Confirmed height; 0 or less means unconfirmed and is never spent. */
  height: number;
  address: string;
  coinbase: boolean;
}

export interface ZcashBuildArgs {
  utxos: readonly ZcashUtxo[];
  keys: ZcashKeys;
  to: string;
  /** Ignored when `sweep` is true. */
  amountZat: bigint;
  sweep: boolean;
  /** From /zec/main/info `consensusBranchId`. Never a constant. */
  branchId: number;
  /** Chain tip height from /zec/main/info. */
  tip: number;
  /** /zec/main/info `upgradeHeight`, when an upgrade is pending above the tip. */
  upgradeHeight?: number;
  /** Mainnet unless a test says otherwise. */
  net?: ZcashNetwork;
}

export interface ZcashSignedTx {
  hex: string;
  /** Display-order hex, computed by this wallet (never parsed from a node's reply). */
  txid: string;
  fee: bigint;
  /** What the recipient receives. */
  amount: bigint;
  /** 0n when there is no change output. */
  change: bigint;
  expiryHeight: number;
  /** The UTXOs spent, in transaction input order. */
  inputs: ZcashUtxo[];
  sizeBytes: number;
}

export type ZcashBuildErrorCode = 'insufficient' | 'dust' | 'fee-cap' | 'expiry' | 'recipient' | 'coinbase' | 'input';

/** Every build refusal carries a user-facing message. */
export class ZcashBuildError extends Error {
  readonly code: ZcashBuildErrorCode;
  constructor(code: ZcashBuildErrorCode, message: string) {
    super(message);
    this.name = 'ZcashBuildError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- signing

export interface ZcashSigningInput {
  /** Display-order hex of the transaction being spent. */
  txid: string;
  index: number;
  value: bigint;
  /** The P2PKH script of the output being spent. */
  script: Uint8Array;
  privateKey: Uint8Array;
}

export interface ZcashSigningArgs {
  inputs: readonly ZcashSigningInput[];
  outputs: readonly { value: bigint; script: Uint8Array }[];
  branchId: number;
  expiryHeight: number;
  lockTime?: number;
  version?: 5 | 6;
}

export interface ZcashSignResult {
  raw: Uint8Array;
  hex: string;
  txid: string;
  tx: ZcashParsedTx;
}

const TXID_RE = /^[0-9a-f]{64}$/i;

function pushData(b: Uint8Array): Uint8Array {
  if (b.length > 75) throw new Error('zcash: push too long');
  const out = new Uint8Array(1 + b.length);
  out[0] = b.length;
  out.set(b, 1);
  return out;
}

/**
 * Signs a transparent-only transaction spending P2PKH inputs, every input
 * SIGHASH_ALL. No policy here (fee, dust, expiry are the caller's): this is
 * the layer the Trezor-signed vectors reproduce byte for byte.
 */
export function signZcashTransparent(args: ZcashSigningArgs): ZcashSignResult {
  const version = args.version ?? ZCASH_TX_VERSION;
  if (!Number.isInteger(args.branchId) || args.branchId <= 0 || args.branchId > 0xffffffff) {
    throw new Error('zcash: a consensus branch id from the node is required');
  }
  if (args.inputs.length === 0) throw new Error('zcash: no inputs to sign');
  if (args.outputs.length === 0) throw new Error('zcash: no outputs');
  const tx: ZcashParsedTx = {
    version,
    header: version === 6 ? ZCASH_V6_HEADER : ZCASH_V5_HEADER,
    versionGroupId: version === 6 ? ZCASH_V6_VERSION_GROUP_ID : ZCASH_V5_VERSION_GROUP_ID,
    branchId: args.branchId,
    lockTime: args.lockTime ?? 0,
    expiryHeight: args.expiryHeight,
    vin: args.inputs.map((i) => {
      if (!TXID_RE.test(i.txid)) throw new Error('zcash: input txid must be 64 hex characters');
      if (!Number.isInteger(i.index) || i.index < 0 || i.index > 0xffffffff) throw new Error('zcash: bad input index');
      return {
        prevTxid: hexToBytes(i.txid.toLowerCase()).reverse(),
        prevIndex: i.index,
        scriptSig: new Uint8Array(0),
        sequence: ZCASH_SEQUENCE_FINAL,
      };
    }),
    vout: args.outputs.map((o) => ({ value: o.value, script: o.script })),
    coinbase: false,
    txid: '',
    raw: new Uint8Array(0),
  };
  const coins: ZcashCoin[] = args.inputs.map((i) => ({ value: i.value, script: i.script }));

  args.inputs.forEach((input, k) => {
    if (input.privateKey.length !== 32 || input.privateKey.every((b) => b === 0)) {
      throw new Error('zcash: signing key is missing (is the wallet locked?)');
    }
    const pub = secp256k1.getPublicKey(input.privateKey, true);
    if (bytesToHex(p2pkhScript(hash160(pub))) !== bytesToHex(input.script)) {
      throw new Error(`zcash: input ${k}: the key does not own this P2PKH script`);
    }
    const digest = transparentSigDigest(tx, k, SIGHASH_ALL, coins);
    const sig = secp256k1.sign(digest, input.privateKey, { lowS: true }); // RFC 6979
    if (!secp256k1.verify(sig.toCompactRawBytes(), digest, pub)) throw new Error(`zcash: input ${k}: signature self-check failed`);
    const der = sig.toDERRawBytes();
    const sigAll = new Uint8Array(der.length + 1);
    sigAll.set(der);
    sigAll[der.length] = SIGHASH_ALL;
    const pushSig = pushData(sigAll);
    const pushPub = pushData(pub);
    const scriptSig = new Uint8Array(pushSig.length + pushPub.length);
    scriptSig.set(pushSig);
    scriptSig.set(pushPub, pushSig.length);
    tx.vin[k].scriptSig = scriptSig;
  });

  const raw = serializeV5(tx, version);
  const d = zcashTxDigests(tx);
  tx.raw = raw;
  tx.txid = displayHex(d.txid);
  tx.authDigest = bytesToHex(d.auth);
  return { raw, hex: bytesToHex(raw), txid: tx.txid, tx };
}

// ---------------------------------------------------------------- expiry

/**
 * nExpiryHeight for a transaction built at `tip`: tip + 1 + 40, capped at
 * upgradeHeight - 1 when an upgrade is pending (a transaction must not
 * straddle a branch change). Throws ZcashBuildError('expiry') when fewer than
 * ZCASH_MIN_EXPIRY_MARGIN blocks would remain after the next block.
 */
export function zcashExpiryHeight(tip: number, upgradeHeight?: number): number {
  if (!Number.isSafeInteger(tip) || tip <= 0) throw new Error('zcash: chain tip height is required');
  const next = tip + 1;
  let expiry = next + ZCASH_EXPIRY_DELTA;
  if (upgradeHeight !== undefined && Number.isSafeInteger(upgradeHeight) && upgradeHeight > tip) {
    expiry = Math.min(expiry, upgradeHeight - 1);
  }
  if (expiry - next < ZCASH_MIN_EXPIRY_MARGIN) {
    throw new ZcashBuildError(
      'expiry',
      'A Zcash network upgrade activates in a few blocks. Wait until it has activated, then send.',
    );
  }
  if (expiry > ZCASH_MAX_EXPIRY_HEIGHT) throw new ZcashBuildError('expiry', 'The expiry height is out of range.');
  return expiry;
}

// ---------------------------------------------------------------- builder

const NO_FUNDS = 'No spendable funds: this wallet has no confirmed ZEC to send.';

function outpointKey(u: ZcashUtxo): string {
  return `${u.txid.toLowerCase()}:${u.index}`;
}

/** Checks a UTXO against the watch keys; returns the key that signs it. */
function keyForUtxo(u: ZcashUtxo, byScript: ReadonlyMap<string, ZcashKey>): ZcashKey {
  const bad = () =>
    new ZcashBuildError('input', 'A coin in this wallet does not match its address, so nothing was signed. Refresh and try again.');
  if (!TXID_RE.test(u.txid) || !Number.isInteger(u.index) || u.index < 0 || u.index > 0xffffffff) throw bad();
  if (typeof u.valueZat !== 'bigint' || u.valueZat <= 0n) throw bad();
  if (!(u.script instanceof Uint8Array)) throw bad();
  const key = byScript.get(bytesToHex(u.script));
  // Only a P2PKH script of one of our watch keys can match; a P2SH or foreign
  // script (none can exist at our addresses) is refused, not signed.
  if (!key || key.address !== u.address) throw bad();
  return key;
}

/**
 * Builds and signs a send. Throws ZcashBuildError (with a user-facing
 * message) for every refusal; never returns a transaction it did not fully
 * check.
 */
/** What a sweep of these coins would do, and when it cannot, why:
 *  'none' (no confirmed, non-coinbase coin), 'dust' (the remainder after the
 *  fee is under dust), 'fee-cap' (so many coins that the ZIP-317 fee is above
 *  ZCASH_MAX_FEE_ZAT, which buildZcashTx's sweep refuses). `total` is the sum
 *  of the coins a sweep would spend: what the send form calls Available. */
export interface ZcashSweepInfo {
  amount: bigint | null;
  total: bigint;
  coins: number;
  fee: bigint;
  reason: 'ok' | 'none' | 'dust' | 'fee-cap';
}

/** The coins buildZcashTx can spend: confirmed and not coinbase. */
function sweepableCoins(utxos: readonly ZcashUtxo[]): ZcashUtxo[] {
  return utxos.filter((u) => !u.coinbase && u.height > 0);
}

export function zcashSweepInfo(utxos: readonly ZcashUtxo[]): ZcashSweepInfo {
  const coins = sweepableCoins(utxos);
  const total = coins.reduce((sum, u) => sum + u.valueZat, 0n);
  if (coins.length === 0) return { amount: null, total, coins: 0, fee: 0n, reason: 'none' };
  const fee = zip317FeeP2pkh(coins.length, 1);
  if (fee > ZCASH_MAX_FEE_ZAT) return { amount: null, total, coins: coins.length, fee, reason: 'fee-cap' };
  const amount = total - fee;
  if (amount < ZCASH_DUST_ZAT) return { amount: null, total, coins: coins.length, fee, reason: 'dust' };
  return { amount, total, coins: coins.length, fee, reason: 'ok' };
}

/**
 * What Max sends: every spendable (confirmed, non-coinbase) UTXO in one
 * no-change transaction, minus its ZIP-317 fee. The same selection, fee and
 * fee cap as buildZcashTx's sweep branch, so the number the form shows is the
 * number that goes out. null when a sweep could send nothing (no coins, a
 * remainder under dust, or a fee above the cap: zcashSweepInfo says which).
 */
export function zcashSweepAmount(utxos: readonly ZcashUtxo[]): bigint | null {
  return zcashSweepInfo(utxos).amount;
}

export function buildZcashTx(args: ZcashBuildArgs): ZcashSignedTx {
  const net = args.net ?? 'main';

  let recipientScript: Uint8Array;
  try {
    recipientScript = decodeZcashAddress(args.to, net).script;
  } catch (err) {
    throw new ZcashBuildError('recipient', err instanceof ZcashAddressError ? err.message : 'This is not a valid Zcash address.');
  }
  if (!args.sweep) {
    if (typeof args.amountZat !== 'bigint' || args.amountZat <= 0n) {
      throw new ZcashBuildError('insufficient', 'Enter an amount above zero.');
    }
    if (args.amountZat < ZCASH_DUST_ZAT) {
      throw new ZcashBuildError('dust', `The amount is too small: the network refuses payments below ${formatZec(ZCASH_DUST_ZAT)} ZEC.`);
    }
  }
  const expiryHeight = zcashExpiryHeight(args.tip, args.upgradeHeight);

  const byScript = new Map<string, ZcashKey>();
  for (const k of args.keys.watch) byScript.set(bytesToHex(k.script), k);

  // Validate every UTXO we were handed (a mismatch is corrupt data: refuse
  // the whole send rather than guess), then split off what cannot be spent.
  const seen = new Set<string>();
  const spendable: { utxo: ZcashUtxo; key: ZcashKey }[] = [];
  let coinbaseTotal = 0n;
  for (const u of args.utxos) {
    const key = keyForUtxo(u, byScript);
    const op = outpointKey(u);
    if (seen.has(op)) {
      throw new ZcashBuildError('input', 'The same coin was listed twice, so nothing was signed. Refresh and try again.');
    }
    seen.add(op);
    if (u.coinbase) {
      if (u.height > 0) coinbaseTotal += u.valueZat;
      continue;
    }
    if (!(u.height > 0)) continue;
    spendable.push({ utxo: u, key });
  }
  // Largest first; ties broken by outpoint so the same inputs give the same transaction.
  spendable.sort((a, b) =>
    a.utxo.valueZat === b.utxo.valueZat
      ? outpointKey(a.utxo) < outpointKey(b.utxo)
        ? -1
        : 1
      : a.utxo.valueZat > b.utxo.valueZat
        ? -1
        : 1,
  );

  const total = spendable.reduce((s, x) => s + x.utxo.valueZat, 0n);
  const shortOf = (needed: bigint): ZcashBuildError => {
    if (total === 0n && coinbaseTotal === 0n) return new ZcashBuildError('insufficient', NO_FUNDS);
    if (coinbaseTotal > 0n && total + coinbaseTotal >= needed) {
      return new ZcashBuildError(
        'coinbase',
        'Part of this balance is a mining reward, and a transparent-only wallet cannot spend mining rewards. Send a smaller amount.',
      );
    }
    if (total === 0n) return new ZcashBuildError('insufficient', NO_FUNDS);
    return new ZcashBuildError(
      'insufficient',
      `Not enough ZEC: this send needs ${formatZec(needed)} ZEC including the network fee, and ${formatZec(total)} ZEC is spendable. Use Max to send everything that fits.`,
    );
  };
  const feeCap = (nIn: number) =>
    new ZcashBuildError(
      'fee-cap',
      `This send would spend ${nIn} coins, so its network fee would be above this wallet's cap of ${formatZec(ZCASH_MAX_FEE_ZAT)} ZEC. Send a smaller amount, or send in parts.`,
    );

  let selected: typeof spendable;
  let amount: bigint;
  let fee: bigint;
  let change: bigint;

  if (args.sweep) {
    if (spendable.length === 0) throw shortOf(1n);
    selected = spendable;
    fee = zip317FeeP2pkh(selected.length, 1);
    if (fee > ZCASH_MAX_FEE_ZAT) throw feeCap(selected.length);
    amount = total - fee;
    change = 0n;
    if (amount < ZCASH_DUST_ZAT) {
      throw new ZcashBuildError(
        'dust',
        `The spendable balance of ${formatZec(total)} ZEC is too small to cover the network fee of ${formatZec(fee)} ZEC.`,
      );
    }
  } else {
    amount = args.amountZat;
    let sum = 0n;
    let found: { n: number; fee: bigint; change: bigint } | null = null;
    for (let n = 1; n <= spendable.length; n++) {
      sum += spendable[n - 1].utxo.valueZat;
      const feeWithChange = zip317FeeP2pkh(n, 2);
      const feeNoChange = zip317FeeP2pkh(n, 1);
      if (sum >= amount + feeWithChange && sum - amount - feeWithChange >= ZCASH_DUST_ZAT) {
        found = { n, fee: feeWithChange, change: sum - amount - feeWithChange };
        break;
      }
      if (sum >= amount + feeNoChange) {
        // Change below dust (or none): fold it into the fee.
        found = { n, fee: sum - amount, change: 0n };
        break;
      }
    }
    if (!found) throw shortOf(amount + zip317FeeP2pkh(Math.max(1, spendable.length), 2));
    if (zip317FeeP2pkh(found.n, found.change > 0n ? 2 : 1) > ZCASH_MAX_FEE_ZAT) throw feeCap(found.n);
    selected = spendable.slice(0, found.n);
    fee = found.fee;
    change = found.change;
  }

  try {
    assertZcashFeeSane(fee);
  } catch (err) {
    if (err instanceof ZcashFeeError) throw new ZcashBuildError('fee-cap', err.message);
    throw err;
  }

  const outputs = [{ value: amount, script: recipientScript }];
  if (change > 0n) outputs.push({ value: change, script: args.keys.primary.script });

  const inSum = selected.reduce((s, x) => s + x.utxo.valueZat, 0n);
  const outSum = outputs.reduce((s, o) => s + o.value, 0n);
  if (inSum !== outSum + fee || outputs.some((o) => o.value < ZCASH_DUST_ZAT)) {
    throw new Error('zcash: builder invariant failed (inputs != outputs + fee)');
  }

  const signed = signZcashTransparent({
    inputs: selected.map(({ utxo, key }) => ({
      txid: utxo.txid,
      index: utxo.index,
      value: utxo.valueZat,
      script: utxo.script,
      privateKey: key.privateKey,
    })),
    outputs,
    branchId: args.branchId,
    expiryHeight,
    version: ZCASH_TX_VERSION,
  });

  return {
    hex: signed.hex,
    txid: signed.txid,
    fee,
    amount,
    change,
    expiryHeight,
    inputs: selected.map((x) => x.utxo),
    sizeBytes: signed.raw.length,
  };
}
