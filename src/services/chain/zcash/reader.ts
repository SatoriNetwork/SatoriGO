// The Zcash read path (the Zcash engine design notes §6): one refresh turns the
// gateway's small JSON API into what the wallet shows and spends from.
//
//   /info      tip, the consensus branch ID a send must sign under
//   /balance   the confirmed balance of the whole watch set (one call)
//   /utxos     the confirmed UTXOs of the watch set (one call)
//   /mempool   unconfirmed transactions that pay us or spend our outpoints
//   /txs       history pages per active address, incremental from `scannedTo`
//
// History arrives as raw transactions WITHOUT txids. Each one is parsed here
// (tx.ts: ZIP-244 txid for v5/v6, SHA256d for v1..v4) and reduced to a small
// record: what our scripts received, what our inputs spent, the fee when every
// input was ours. The raw bytes are then dropped; only the record is cached.
//
// "Ours" is a SCRIPT match against the watch set, never a string compare of
// addresses. An input is ours when its prevout is one of our outputs seen in
// history (the funding transaction of every one of our outputs is itself in
// our address history). When that funding record has aged out of the capped
// cache, the input is still recognised by the public key in its scriptSig
// (a P2PKH spend reveals it), and its value is fetched with one /tx call.
//
// Nothing here holds a key: the watch set is public data cached on the wallet
// entry, and a refresh needs no unlock.

import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { decodeZcashAddress, scriptToZcashAddress } from './address';
import type { ZcashUtxo } from './builder';
import { ZCASH_MAX_FEE_ZAT } from './fees';
import { capZcashHistory, type ZcashHistoryCache } from './historyCache';
import {
  ZCASH_ADDRESSES_PER_CALL,
  ZCASH_HISTORY_FLOOR,
  ZCASH_OUTPOINTS_PER_CALL,
  ZCASH_TXS_SPAN,
  ZcashRpcError,
  type ZcashInfo,
  type ZcashMempoolTx,
  type ZcashRpc,
} from './rpc';
import { parseZcashTx, type ZcashParsedTx } from './tx';

/** One transaction of the wallet's history, as cached. Amounts in zat. */
export interface ZcashTxRecord {
  /** Display-order txid. For a transaction version this build cannot parse,
   *  `unrecognised:<sha256 of the raw bytes>` (and `version: 'unknown'`): one
   *  row, never a failed refresh. */
  txid: string;
  /** Block height; null only for a row whose height is not known. */
  height: number | null;
  version: number | 'unknown';
  /** Sum of the outputs paying one of our scripts. */
  received: bigint;
  /** Sum of the inputs spending one of our outputs. */
  sent: bigint;
  /** Inputs minus outputs, known only when EVERY input was ours (our own
   *  sends); null for received rows and anything not fully ours. */
  fee: bigint | null;
  /** The other side, as t-addresses: the recipients of a send (outputs that
   *  are not ours), or the payer of a receipt (from the first input's public
   *  key). May be empty (a script with no t-address form, a shielded source). */
  addresses: string[];
  /** A coinbase (mining reward) transaction: its outputs can never be spent by
   *  a transparent-only wallet (§4.6). */
  coinbase: boolean;
  /** Our outputs of this transaction (index, value), so a later spend of one
   *  is recognised and valued without refetching this transaction. */
  ownOutputs?: { index: number; valueZat: bigint }[];
}

/** One of this wallet's own sends, from the local send record (zcashSend.ts):
 *  what the reader needs to count it as OUTGOING whatever the mempool answer
 *  says about its inputs (lightwalletd's compact mempool answer may carry
 *  none, and then its change would look like income). */
export interface ZcashOwnSend {
  txid: string;
  expiryHeight: number;
  /** The outpoints (`txid:index`) it spends. */
  spent: readonly string[];
  /** amount + fee in zat: what leaves the balance. null when not recorded. */
  outflowZat: bigint | null;
}

/** A mempool transaction reduced to what it does to us. */
export interface ZcashPendingTx {
  txid: string;
  /** What it pays our scripts (for an outgoing one, our change). */
  received: bigint;
  /** What it spends of our confirmed UTXOs. */
  spent: bigint;
}

export interface ZcashSnapshot {
  info: ZcashInfo;
  /** Confirmed balance of the watch set, from /balance. */
  confirmed: bigint;
  /** Incoming and unconfirmed: outputs to us in mempool transactions that
   *  spend nothing of ours. Informational, never spendable (§6.4). */
  pendingIn: bigint;
  /** Net outflow of mempool transactions that spend our UTXOs (what they
   *  spend minus the change they return). */
  pendingOut: bigint;
  /** Confirmed, non-coinbase UTXOs that no mempool transaction spends. */
  spendable: ZcashUtxo[];
  /** Coinbase UTXOs: in the balance, never spendable here (§4.6). */
  unspendable: ZcashUtxo[];
  /** True when /utxos was cut at its cap: `spendable` is then a subset. */
  utxosTruncated: boolean;
  /** Newest first, capped (the same list as `cache.txs`). */
  history: ZcashTxRecord[];
  mempool: ZcashMempoolTx[];
  /** Mempool transactions that touch us, reduced. */
  pending: ZcashPendingTx[];
  /** /tx answers for own sends past their expiry margin that neither history
   *  nor the mempool shows (classifySend): 'gone' means no server knows the
   *  txid. Absent for a send that was not looked up. */
  sendLookups?: Record<string, 'confirmed' | 'pending' | 'gone'>;
  /** The cache after this refresh: a NEW object (the one passed in is never
   *  modified). The caller saves exactly this with saveZcashHistory; building
   *  its own from the other fields would lose which addresses were scanned
   *  from the floor (`activeAddresses` must only name scanned addresses). */
  cache: ZcashHistoryCache;
}

/** Blocks re-read below `scannedTo` on an incremental scan, so a shallow
 *  reorg cannot hide a transaction that landed "just before" the watermark. */
export const ZCASH_RESCAN_OVERLAP = 10;
/** Page guard per address per refresh: 16 pages cover the whole chain from the
 *  floor, a busy address may need more, a loop never gets further than this. */
const MAX_PAGES_PER_ADDRESS = 400;
/** Most /tx lookups one refresh may make (valuing an input whose funding
 *  record aged out, or the coinbase check of a UTXO with no record). */
const MAX_TX_LOOKUPS = 25;
/** Most /tx lookups one refresh makes for own sends past their expiry. */
const MAX_SEND_LOOKUPS = 5;
/** Blocks past nExpiryHeight before a send is called expired. ZIP-203 lets a
 *  transaction be mined IN block nExpiryHeight, and /info and /txs may come
 *  from different servers a block or two apart. */
export const ZCASH_EXPIRY_SAFETY_BLOCKS = 3;
/** Own sends a /tx lookup found mined: final, never asked again. */
const minedOwnSends = new Set<string>();

const T_ADDRESS_RE = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;

function displayTxid(internal: Uint8Array): string {
  return bytesToHex(Uint8Array.from(internal).reverse());
}

function hash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ZcashRpcError('aborted', 'The Zcash refresh was cancelled.');
}

/** The public key a standard P2PKH scriptSig reveals (<sig> <pubkey>), or null. */
function scriptSigPubkey(scriptSig: Uint8Array): Uint8Array | null {
  let p = 0;
  const pushes: Uint8Array[] = [];
  while (p < scriptSig.length && pushes.length < 3) {
    const op = scriptSig[p++];
    if (op < 1 || op > 75 || p + op > scriptSig.length) return null;
    pushes.push(scriptSig.subarray(p, p + op));
    p += op;
  }
  if (p !== scriptSig.length || pushes.length !== 2) return null;
  const pub = pushes[1];
  if (pub.length === 33 && (pub[0] === 0x02 || pub[0] === 0x03)) return pub;
  if (pub.length === 65 && pub[0] === 0x04) return pub;
  return null;
}

/** The P2PKH script a public key pays to, as hex. */
function p2pkhScriptHexOfPubkey(pub: Uint8Array): string {
  return `76a914${bytesToHex(hash160(pub))}88ac`;
}

/** A v5/v6 transaction that moves value through Sapling, Orchard or Ironwood:
 *  its transparent inputs minus outputs is not its fee. */
function hasShieldedParts(tx: ZcashParsedTx): boolean {
  const s = tx.sapling;
  return (
    (s !== undefined && (s.spends.length > 0 || s.outputs.length > 0)) ||
    (tx.orchard !== undefined && tx.orchard.actions.length > 0) ||
    (tx.ironwood !== undefined && tx.ironwood.actions.length > 0)
  );
}

interface Parsed {
  tx: ZcashParsedTx | null;
  txid: string;
  height: number;
  raw: Uint8Array;
}

function parseOne(hex: string, height: number): Parsed {
  const raw = hexToBytes(hex);
  let tx: ZcashParsedTx | null = null;
  try {
    tx = parseZcashTx(raw);
  } catch {
    tx = null;
  }
  if (!tx || tx.version === 'unknown' || !/^[0-9a-f]{64}$/.test(tx.txid)) {
    return { tx: null, txid: `unrecognised:${bytesToHex(sha256(raw))}`, height, raw };
  }
  return { tx, txid: tx.txid, height, raw };
}

/**
 * One refresh of the watch set. `watch` is the entry's cached watch addresses
 * (`/0/0` first); `cache` is the loaded history cache, or emptyZcashHistory().
 *
 * Throws (a ZcashRpcError, or a plain Error on a bad watch set) when any call
 * fails. Never modifies `cache`: the next cache is `snapshot.cache`, to be
 * saved by the caller.
 */
export async function refreshZcash(
  rpc: ZcashRpc,
  watch: string[],
  cache: ZcashHistoryCache,
  signal?: AbortSignal,
  ownSends: readonly ZcashOwnSend[] = [],
): Promise<ZcashSnapshot> {
  const watchList = [...new Set(Array.isArray(watch) ? watch : [])];
  if (watchList.length < 1 || watchList.length > ZCASH_ADDRESSES_PER_CALL) {
    throw new Error(`A Zcash refresh needs 1 to ${ZCASH_ADDRESSES_PER_CALL} watch addresses.`);
  }
  /** scriptPubKey hex -> our address. */
  const ourScripts = new Map<string, string>();
  for (const a of watchList) {
    if (typeof a !== 'string' || !T_ADDRESS_RE.test(a)) throw new Error('A Zcash watch address is not a transparent mainnet address.');
    ourScripts.set(bytesToHex(decodeZcashAddress(a).script), a);
  }
  const watchSet = new Set(watchList);

  throwIfAborted(signal);
  const info = await rpc.info(signal);
  const tip = info.height;

  const [confirmed, utxoAnswer] = await Promise.all([rpc.balance(watchList, signal), rpc.utxos(watchList, undefined, signal)]);
  const outpoints = utxoAnswer.utxos.map((u) => `${u.txid}:${u.index}`);
  const mempool = await rpc.mempool(watchList, outpoints.slice(0, ZCASH_OUTPOINTS_PER_CALL), signal);

  // --- which addresses get a history scan -----------------------------------
  const previouslyActive = new Set(cache.activeAddresses.filter((a) => watchSet.has(a)));
  const active = new Set<string>(previouslyActive);
  active.add(watchList[0]);
  for (const u of utxoAnswer.utxos) if (watchSet.has(u.address)) active.add(u.address);
  for (const t of mempool) {
    for (const o of t.vout) {
      const a = ourScripts.get(o.script);
      if (a) active.add(a);
    }
  }
  const activeOrdered = watchList.filter((a) => active.has(a));

  // --- history pages ----------------------------------------------------------
  const fresh = new Map<string, Parsed>();
  for (const address of activeOrdered) {
    const incremental = cache.scannedTo > 0 && previouslyActive.has(address);
    let start = incremental ? Math.max(ZCASH_HISTORY_FLOOR, cache.scannedTo - ZCASH_RESCAN_OVERLAP + 1) : ZCASH_HISTORY_FLOOR;
    let pages = 0;
    while (start <= tip) {
      throwIfAborted(signal);
      if (++pages > MAX_PAGES_PER_ADDRESS) throw new Error('The Zcash history scan did not finish (too many pages).');
      const end = Math.min(tip, start + ZCASH_TXS_SPAN);
      const page = await rpc.txs(address, start, end, signal);
      for (const t of page.txs) {
        const p = parseOne(t.hex, t.height);
        // Dedupe across addresses and across a truncated page's seam; the
        // later sighting's height wins (they agree unless a reorg moved it).
        fresh.set(p.txid, p);
      }
      if (page.truncated && page.resumeFrom !== null) {
        // Continue from the last height received. A single block holding more
        // than a page for one address would repeat forever: step past it.
        start = page.resumeFrom > start ? page.resumeFrom : start + 1;
      } else {
        start = end + 1;
      }
    }
  }

  // --- our outputs, from the cache and the fresh pages -------------------------
  /** "txid:index" -> value of an output that pays one of our scripts. */
  const ownOut = new Map<string, bigint>();
  const byTxid = new Map<string, ZcashTxRecord>();
  for (const r of cache.txs) {
    byTxid.set(r.txid, r);
    for (const o of r.ownOutputs ?? []) ownOut.set(`${r.txid}:${o.index}`, o.valueZat);
  }
  for (const p of fresh.values()) {
    if (!p.tx) continue;
    p.tx.vout.forEach((o, index) => {
      if (ourScripts.has(bytesToHex(o.script))) ownOut.set(`${p.txid}:${index}`, o.value);
    });
  }
  // Mempool outputs can be spent by another mempool transaction; they are
  // valued for the pending figures only.
  for (const u of utxoAnswer.utxos) ownOut.set(`${u.txid}:${u.index}`, u.valueZat);

  let lookups = 0;
  const lookupCache = new Map<string, ZcashParsedTx | null>();
  const fetchTx = async (txid: string): Promise<ZcashParsedTx | null> => {
    if (lookupCache.has(txid)) return lookupCache.get(txid) ?? null;
    if (lookups >= MAX_TX_LOOKUPS) return null;
    lookups++;
    const answer = await rpc.tx(txid, signal);
    const parsed = answer ? parseOne(answer.hex, Math.max(0, answer.height)).tx : null;
    lookupCache.set(txid, parsed);
    return parsed;
  };

  // --- records -----------------------------------------------------------------
  for (const p of fresh.values()) {
    if (!p.tx) {
      byTxid.set(p.txid, {
        txid: p.txid,
        height: p.height,
        version: 'unknown',
        received: 0n,
        sent: 0n,
        fee: null,
        addresses: [],
        coinbase: false,
      });
      continue;
    }
    const tx = p.tx;
    let received = 0n;
    let totalOut = 0n;
    const ownOutputs: { index: number; valueZat: bigint }[] = [];
    const others: string[] = [];
    tx.vout.forEach((o, index) => {
      totalOut += o.value;
      if (ourScripts.has(bytesToHex(o.script))) {
        received += o.value;
        ownOutputs.push({ index, valueZat: o.value });
      } else {
        const a = scriptToZcashAddress(o.script);
        if (a) others.push(a);
      }
    });
    let sent = 0n;
    let oursIn = 0;
    if (!tx.coinbase) {
      for (const i of tx.vin) {
        const key = `${displayTxid(i.prevTxid)}:${i.prevIndex}`;
        let value = ownOut.get(key);
        if (value === undefined) {
          // Not in our history (its record aged out of the cap): recognise it
          // by the key its scriptSig reveals, then value it with one lookup.
          const pub = scriptSigPubkey(i.scriptSig);
          if (pub && ourScripts.has(p2pkhScriptHexOfPubkey(pub))) {
            const prev = await fetchTx(displayTxid(i.prevTxid));
            const out = prev?.vout[i.prevIndex];
            if (out && ourScripts.has(bytesToHex(out.script))) value = out.value;
          }
        }
        if (value !== undefined) {
          sent += value;
          oursIn++;
        }
      }
    }
    let fee: bigint | null = null;
    if (oursIn > 0 && oursIn === tx.vin.length && !hasShieldedParts(tx)) {
      const f = sent - totalOut;
      // Outside [0, cap] the transparent sums cannot be the fee (a v4
      // transaction with a shielded part this parser does not read, say):
      // unknown rather than a wrong figure.
      fee = f >= 0n && f <= ZCASH_MAX_FEE_ZAT ? f : null;
    }
    let addresses: string[] = [];
    if (sent > 0n) {
      addresses = others;
    } else if (tx.vin.length && !tx.coinbase) {
      const pub = scriptSigPubkey(tx.vin[0].scriptSig);
      if (pub) {
        const payerScript = p2pkhScriptHexOfPubkey(pub);
        const payer = ourScripts.has(payerScript) ? null : scriptToZcashAddress(hexToBytes(payerScript));
        if (payer) addresses = [payer];
      }
    }
    const record: ZcashTxRecord = {
      txid: p.txid,
      height: p.height,
      version: tx.version,
      received,
      sent,
      fee,
      addresses: [...new Set(addresses)].slice(0, 10),
      coinbase: tx.coinbase,
    };
    if (ownOutputs.length) record.ownOutputs = ownOutputs;
    byTxid.set(p.txid, record);
  }

  // --- own sends: where each one stands ------------------------------------------
  // Past the expiry margin and in neither history nor the mempool, a send is
  // looked up with /tx before anyone calls it expired (classifySend).
  const recordsSoFar = [...byTxid.values()];
  const sendLookups: Record<string, 'confirmed' | 'pending' | 'gone'> = {};
  let sendLookupCount = 0;
  for (const s of ownSends) {
    const txid = String(s.txid).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) continue;
    if (minedOwnSends.has(txid)) {
      sendLookups[txid] = 'confirmed';
      continue;
    }
    if (!(s.expiryHeight > 0 && tip >= s.expiryHeight + ZCASH_EXPIRY_SAFETY_BLOCKS)) continue;
    if (recordsSoFar.some((r) => r.txid === txid && r.height !== null && r.height > 0)) continue;
    if (mempool.some((t) => t.txid === txid)) continue;
    if (sendLookupCount >= MAX_SEND_LOOKUPS) continue;
    sendLookupCount++;
    throwIfAborted(signal);
    let answer: { hex: string; height: number } | null;
    try {
      answer = await rpc.tx(txid, signal);
    } catch (err) {
      // A failed lookup proves nothing: the send stays unknown (its inputs
      // stay held back) and is asked again next refresh.
      if (err instanceof ZcashRpcError && err.code === 'aborted') throw err;
      continue;
    }
    if (!answer) sendLookups[txid] = 'gone';
    else if (answer.height > 0) {
      sendLookups[txid] = 'confirmed';
      minedOwnSends.add(txid);
    } else if (answer.height === 0) sendLookups[txid] = 'pending';
    // -1 (a side chain): not looked up as anything; stays unknown.
  }
  const stateView = { info, history: recordsSoFar, mempool, sendLookups };
  /** Own sends still in flight (pending or unknown): their inputs are spoken
   *  for, and what they send counts as going out. */
  const activeOwn = ownSends.filter((s) => {
    const st = classifySend({ txid: s.txid, expiryHeight: s.expiryHeight }, stateView);
    return st === 'pending' || st === 'unknown';
  });
  const ownIds = new Set(activeOwn.map((s) => String(s.txid).toLowerCase()));

  // --- UTXOs: coinbase or not ----------------------------------------------------
  const spentInMempool = new Set<string>();
  for (const t of mempool) for (const i of t.vin) spentInMempool.add(`${i.txid}:${i.index}`);
  for (const s of activeOwn) for (const o of s.spent) spentInMempool.add(String(o).toLowerCase());
  const spendable: ZcashUtxo[] = [];
  const unspendable: ZcashUtxo[] = [];
  for (const u of utxoAnswer.utxos) {
    let coinbase: boolean;
    const rec = byTxid.get(u.txid);
    if (rec && rec.version !== 'unknown') {
      coinbase = rec.coinbase;
    } else {
      // No record (history cut, or the funding transaction could not be
      // parsed): ask for it. When that fails too, the UTXO is held back as
      // unspendable: a coinbase input would wedge every send with an opaque
      // node error (§4.6), and holding back is recoverable on the next refresh.
      const prev = await fetchTx(u.txid);
      coinbase = prev ? prev.coinbase : true;
    }
    const full: ZcashUtxo = { ...u, coinbase };
    if (coinbase) unspendable.push(full);
    else if (!spentInMempool.has(`${u.txid}:${u.index}`)) spendable.push(full);
  }

  // --- pending ---------------------------------------------------------------------
  let pendingIn = 0n;
  let pendingOut = 0n;
  const pending: ZcashPendingTx[] = [];
  for (const t of mempool) {
    // One of our own sends is OUTGOING whatever its reported inputs say (the
    // gateway's mempool answer may carry none): counted below, its change is
    // never income.
    if (ownIds.has(t.txid)) continue;
    let rx = 0n;
    for (const o of t.vout) if (ourScripts.has(o.script)) rx += o.valueZat;
    let spent = 0n;
    for (const i of t.vin) {
      const v = ownOut.get(`${i.txid}:${i.index}`);
      if (v !== undefined) spent += v;
    }
    if (rx === 0n && spent === 0n) continue;
    pending.push({ txid: t.txid, received: rx, spent });
    if (spent > 0n) {
      if (spent > rx) pendingOut += spent - rx;
    } else {
      pendingIn += rx;
    }
  }
  const confirmedOutpoints = new Set(outpoints);
  const mempoolById = new Map(mempool.map((t) => [t.txid, t]));
  for (const s of activeOwn) {
    const txid = String(s.txid).toLowerCase();
    const t = mempoolById.get(txid);
    const outs = new Set(s.spent.map((o) => String(o).toLowerCase()));
    if (t) for (const i of t.vin) outs.add(`${i.txid}:${i.index}`);
    // Not (yet) in the mempool answer: it counts only while one of its inputs
    // is still a confirmed unspent coin, i.e. still inside `confirmed`. Once
    // they are gone it was mined (or replaced) and the balance shows that.
    if (!t && ![...outs].some((o) => confirmedOutpoints.has(o))) continue;
    let rx = 0n;
    if (t) for (const o of t.vout) if (ourScripts.has(o.script)) rx += o.valueZat;
    let spent = 0n;
    let allValued = outs.size > 0;
    for (const o of outs) {
      const v = ownOut.get(o);
      if (v === undefined) allValued = false;
      else spent += v;
    }
    let out: bigint;
    if (t && allValued) out = spent > rx ? spent - rx : 0n;
    else if (s.outflowZat !== null && s.outflowZat > 0n) out = s.outflowZat;
    else out = spent > rx ? spent - rx : 0n;
    pendingOut += out;
    pending.push({ txid, received: rx, spent });
  }

  // --- commit ------------------------------------------------------------------------
  const history = capZcashHistory([...byTxid.values()]);
  const nextCache: ZcashHistoryCache = {
    v: 1,
    scannedTo: Math.max(cache.scannedTo, tip),
    activeAddresses: activeOrdered,
    txs: history,
  };

  return {
    info,
    confirmed,
    pendingIn,
    pendingOut,
    spendable,
    unspendable,
    utxosTruncated: utxoAnswer.truncated,
    history,
    mempool,
    pending,
    sendLookups,
    cache: nextCache,
  };
}

/**
 * Where a send of ours stands after a refresh (§6.5): its txid in history
 * means confirmed, in the mempool means pending (so does a /tx lookup that
 * found it). Expired needs BOTH: the tip at least ZCASH_EXPIRY_SAFETY_BLOCKS
 * past its expiry height (ZIP-203 still lets it be mined IN block
 * nExpiryHeight, and /info and /txs may come from servers a block or two
 * apart), AND the refresh's /tx lookup finding no server that knows the txid
 * (`sendLookups`, 'gone'). Only then is it shown as failed with "Send again".
 * Otherwise unknown: still propagating, or not looked up yet. An expiry height
 * of 0 means no expiry.
 */
export function classifySend(
  record: { txid: string; expiryHeight: number },
  snap: Pick<ZcashSnapshot, 'info' | 'history' | 'mempool' | 'sendLookups'>,
): 'confirmed' | 'pending' | 'expired' | 'unknown' {
  const txid = String(record.txid).toLowerCase();
  if (snap.history.some((r) => r.txid === txid && r.height !== null && r.height > 0)) return 'confirmed';
  if (snap.mempool.some((t) => t.txid === txid)) return 'pending';
  const looked = snap.sendLookups?.[txid];
  if (looked === 'confirmed') return 'confirmed';
  if (looked === 'pending') return 'pending';
  if (record.expiryHeight > 0 && snap.info.height >= record.expiryHeight + ZCASH_EXPIRY_SAFETY_BLOCKS && looked === 'gone') {
    return 'expired';
  }
  return 'unknown';
}

/**
 * The txid lookup for a broadcast whose outcome is unknown (the gateway's 504,
 * or "already queued"): /tx answers from the node's chain and mempool. Never
 * sends anything. 'unknown' when no server knows the txid yet (or it sits on
 * a side chain); the caller keeps it pending until classifySend says expired.
 */
export async function resolveZcashSend(
  rpc: ZcashRpc,
  txid: string,
  signal?: AbortSignal,
): Promise<'confirmed' | 'pending' | 'unknown'> {
  const answer = await rpc.tx(txid, signal);
  if (!answer) return 'unknown';
  if (answer.height > 0) return 'confirmed';
  if (answer.height === 0) return 'pending';
  return 'unknown';
}
