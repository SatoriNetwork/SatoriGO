import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { encodeP2pkh } from './address';
import { emptyZcashHistory, type ZcashHistoryCache } from './historyCache';
import {
  ZCASH_EXPIRY_SAFETY_BLOCKS,
  ZCASH_RESCAN_OVERLAP,
  classifySend,
  refreshZcash,
  resolveZcashSend,
  type ZcashOwnSend,
  type ZcashSnapshot,
} from './reader';
import { ZCASH_HISTORY_FLOOR, ZCASH_TXS_SPAN, ZcashRpcError, type ZcashInfo, type ZcashMempoolTx, type ZcashRpc } from './rpc';
import { ZCASH_V5_HEADER, ZCASH_V5_VERSION_GROUP_ID, parseZcashTx, serializeV5 } from './tx';

// ---------------------------------------------------------------------------
// Synthetic keys, addresses and v5 transactions. Nothing here is a real
// wallet: private keys are small fixed scalars, signatures are filler bytes
// (the reader never verifies a signature, it only reads the public key a
// P2PKH scriptSig reveals).
// ---------------------------------------------------------------------------

const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
function key(n: number) {
  const priv = new Uint8Array(32);
  priv[31] = n;
  const pub = secp256k1.getPublicKey(priv, true);
  const h = hash160(pub);
  return { pub, address: encodeP2pkh(h), script: Uint8Array.from([0x76, 0xa9, 0x14, ...h, 0x88, 0xac]) };
}
const W0 = key(1); // our /0/0
const W1 = key(2); // our /1/0 (change)
const W2 = key(3); // our /0/1
const X = key(9); // somebody else
const WATCH = [W0.address, W2.address, W1.address];

const BRANCH = 0x37a5165b;
const TIP = 3_100_000;
/** /txs pages from the floor to TIP: each spans at most ZCASH_TXS_SPAN + 1 heights. */
const FULL_PAGES = Math.ceil((TIP - ZCASH_HISTORY_FLOOR + 1) / (ZCASH_TXS_SPAN + 1));

const internal = (txid: string) => hexToBytes(txid).reverse();
function scriptSig(pub: Uint8Array): Uint8Array {
  const sig = new Uint8Array(71).fill(0x30);
  return Uint8Array.from([sig.length, ...sig, pub.length, ...pub]);
}

interface In {
  txid: string;
  index: number;
  pub: Uint8Array;
}
/** A transparent v5 transaction as hex; `salt` (the lock time) keeps otherwise
 *  identical test transactions apart. */
function v5(ins: In[], outs: { script: Uint8Array; value: bigint }[], salt = 0): string {
  const raw = serializeV5({
    header: ZCASH_V5_HEADER,
    versionGroupId: ZCASH_V5_VERSION_GROUP_ID,
    branchId: BRANCH,
    lockTime: salt,
    expiryHeight: 0,
    vin: ins.map((i) => ({ prevTxid: internal(i.txid), prevIndex: i.index, scriptSig: scriptSig(i.pub), sequence: 0xffffffff })),
    vout: outs,
  });
  return bytesToHex(raw);
}
function coinbaseTx(out: { script: Uint8Array; value: bigint }): string {
  const raw = serializeV5({
    header: ZCASH_V5_HEADER,
    versionGroupId: ZCASH_V5_VERSION_GROUP_ID,
    branchId: BRANCH,
    lockTime: 0,
    expiryHeight: 0,
    vin: [{ prevTxid: new Uint8Array(32), prevIndex: 0xffffffff, scriptSig: Uint8Array.of(3, 1, 2, 3), sequence: 0xffffffff }],
    vout: [out],
  });
  return bytesToHex(raw);
}

const txidOf = (hex: string) => parseZcashTx(hexToBytes(hex)).txid;

// ---------------------------------------------------------------------------
// A fake gateway: per-address history, UTXOs, mempool, /tx lookups; every call
// recorded.
// ---------------------------------------------------------------------------

interface FakeState {
  tip: number;
  branch: number;
  history: Map<string, { hex: string; height: number }[]>;
  utxos: { address: string; txid: string; index: number; valueZat: bigint; height: number; script: Uint8Array }[];
  mempool: ZcashMempoolTx[];
  byTxid: Map<string, { hex: string; height: number }>;
  /** Cut a /txs page after this many transactions. */
  pageMax: number;
  failOn?: string;
}

function fake(state: Partial<FakeState> = {}) {
  const s: FakeState = {
    tip: TIP,
    branch: BRANCH,
    history: new Map(),
    utxos: [],
    mempool: [],
    byTxid: new Map(),
    pageMax: 500,
    ...state,
  };
  const calls: { op: string; args: unknown[] }[] = [];
  const fail = (op: string) => {
    if (s.failOn === op) throw new ZcashRpcError('http', `HTTP 502 (${op})`, 502);
  };
  const rpc: ZcashRpc = {
    async info() {
      calls.push({ op: 'info', args: [] });
      fail('info');
      const info: ZcashInfo = {
        chainName: 'main',
        height: s.tip,
        estimatedHeight: s.tip,
        consensusBranchId: s.branch,
        upgradeName: '',
        upgradeHeight: 0,
        taddrSupport: true,
      };
      return info;
    },
    async balance(addresses) {
      calls.push({ op: 'balance', args: [addresses] });
      fail('balance');
      return s.utxos.filter((u) => addresses.includes(u.address)).reduce((a, u) => a + u.valueZat, 0n);
    },
    async utxos(addresses) {
      calls.push({ op: 'utxos', args: [addresses] });
      fail('utxos');
      return { utxos: s.utxos.filter((u) => addresses.includes(u.address)), truncated: false };
    },
    async txs(address, start, end) {
      calls.push({ op: 'txs', args: [address, start, end] });
      fail('txs');
      expect(end - start).toBeLessThanOrEqual(ZCASH_TXS_SPAN);
      const all = (s.history.get(address) ?? []).filter((t) => t.height >= start && t.height <= end).sort((a, b) => a.height - b.height);
      const txs = all.slice(0, s.pageMax);
      const truncated = all.length > s.pageMax;
      return { txs, truncated, resumeFrom: truncated ? txs[txs.length - 1].height : null };
    },
    async tx(txid) {
      calls.push({ op: 'tx', args: [txid] });
      return s.byTxid.get(txid) ?? null;
    },
    async mempool(addresses, outpoints) {
      calls.push({ op: 'mempool', args: [addresses, outpoints] });
      fail('mempool');
      return s.mempool;
    },
    async send() {
      throw new Error('the reader never sends');
    },
  };
  return { rpc, calls, s };
}

// ---------------------------------------------------------------------------
// A small story: X pays us, we pay X with change, we move the change to /0/0.
// ---------------------------------------------------------------------------

const H1 = 3_000_000;
const H2 = 3_000_100;
const H3 = 3_000_200;
const T1 = v5([{ txid: 'ee'.repeat(32), index: 0, pub: X.pub }], [{ script: W0.script, value: 100_000n }], 1);
const T1id = txidOf(T1);
// We pay X 60,000, change 30,000 to /1/0, fee 10,000.
const T2 = v5(
  [{ txid: T1id, index: 0, pub: W0.pub }],
  [
    { script: X.script, value: 60_000n },
    { script: W1.script, value: 30_000n },
  ],
  2,
);
const T2id = txidOf(T2);
// Self-transfer: /1/0's 30,000 to /0/0 as 20,000, fee 10,000.
const T3 = v5([{ txid: T2id, index: 1, pub: W1.pub }], [{ script: W0.script, value: 20_000n }], 3);
const T3id = txidOf(T3);

function story() {
  return fake({
    history: new Map([
      [W0.address, [{ hex: T1, height: H1 }, { hex: T2, height: H2 }, { hex: T3, height: H3 }]],
      [W1.address, [{ hex: T2, height: H2 }, { hex: T3, height: H3 }]],
    ]),
    utxos: [{ address: W0.address, txid: T3id, index: 0, valueZat: 20_000n, height: H3, script: W0.script }],
  });
}

describe('refreshZcash', () => {
  it('a fresh wallet: scans /0/0 from the Sapling floor to the tip in 200,000-block pages', async () => {
    const { rpc, calls } = fake();
    const cache = emptyZcashHistory();
    const before = JSON.stringify(cache);
    const snap = await refreshZcash(rpc, WATCH, cache);
    expect(JSON.stringify(cache)).toBe(before); // never modified
    expect(snap.confirmed).toBe(0n);
    expect(snap.history).toEqual([]);
    expect(snap.spendable).toEqual([]);
    const pages = calls.filter((c) => c.op === 'txs');
    expect(FULL_PAGES).toBe(14);
    expect(pages.map((c) => c.args[0])).toEqual(Array(FULL_PAGES).fill(W0.address));
    expect(pages[0].args[1]).toBe(ZCASH_HISTORY_FLOOR);
    expect(pages.at(-1)?.args[2]).toBe(TIP);
    for (let i = 1; i < pages.length; i++) expect(pages[i].args[1]).toBe((pages[i - 1].args[2] as number) + 1);
    expect(snap.cache).toMatchObject({ v: 1, scannedTo: TIP, activeAddresses: [W0.address] });
    // One balance, one utxos, one mempool call for the whole watch set.
    expect(calls.filter((c) => c.op === 'balance')).toHaveLength(1);
    expect(calls.find((c) => c.op === 'balance')?.args[0]).toEqual(WATCH);
  });

  it('received, sent with fee, and a self-transfer, from raw history', async () => {
    const { rpc } = story();
    const snap = await refreshZcash(rpc, WATCH, emptyZcashHistory());
    const by = new Map(snap.history.map((r) => [r.txid, r]));
    expect(snap.history.map((r) => r.txid)).toEqual([T3id, T2id, T1id]); // newest first

    expect(by.get(T1id)).toMatchObject({ height: H1, version: 5, received: 100_000n, sent: 0n, fee: null, addresses: [X.address], coinbase: false });
    expect(by.get(T2id)).toMatchObject({ height: H2, received: 30_000n, sent: 100_000n, fee: 10_000n, addresses: [X.address] });
    expect(by.get(T3id)).toMatchObject({ height: H3, received: 20_000n, sent: 30_000n, fee: 10_000n, addresses: [] });

    expect(snap.confirmed).toBe(20_000n);
    expect(snap.spendable).toHaveLength(1);
    expect(snap.spendable[0]).toMatchObject({ txid: T3id, index: 0, valueZat: 20_000n, coinbase: false, address: W0.address });
    expect(snap.unspendable).toEqual([]);
  });

  it('dedupes a transaction seen through two addresses; raw hex is never kept', async () => {
    const { rpc } = story();
    // /1/0 is active from an earlier run.
    const cache: ZcashHistoryCache = { ...emptyZcashHistory(), activeAddresses: [W1.address] };
    const snap = await refreshZcash(rpc, WATCH, cache);
    expect(snap.history.filter((r) => r.txid === T2id)).toHaveLength(1);
    expect(JSON.stringify(snap.history, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(T2.slice(0, 40));
  });

  it('incremental: a second refresh asks only from scannedTo minus the overlap, and values a spend from the cache', async () => {
    const st = story();
    const cache = (await refreshZcash(st.rpc, WATCH, emptyZcashHistory())).cache;
    expect(cache.scannedTo).toBe(TIP);

    // Next block: we spend T3:0 (20,000) to X, 15,000, fee 5,000... not a
    // standard ZIP-317 fee, but the reader reports what the chain did.
    const T4 = v5([{ txid: T3id, index: 0, pub: W0.pub }], [{ script: X.script, value: 15_000n }], 4);
    const T4id = txidOf(T4);
    const TIP2 = TIP + 3;
    st.s.tip = TIP2;
    st.s.history.set(W0.address, [...(st.s.history.get(W0.address) ?? []), { hex: T4, height: TIP + 2 }]);
    st.s.utxos = [];
    st.calls.length = 0;

    const snap = await refreshZcash(st.rpc, WATCH, cache);
    const pages = st.calls.filter((c) => c.op === 'txs');
    expect(pages).toEqual([{ op: 'txs', args: [W0.address, TIP - ZCASH_RESCAN_OVERLAP + 1, TIP2] }]);
    expect(snap.history[0]).toMatchObject({ txid: T4id, sent: 20_000n, received: 0n, fee: 5_000n, addresses: [X.address] });
    expect(snap.history).toHaveLength(4);
    expect(snap.cache.scannedTo).toBe(TIP2);
  });

  it('an address that appears in the UTXOs is scanned in full and stays active once spent', async () => {
    const T5 = v5([{ txid: 'dd'.repeat(32), index: 1, pub: X.pub }], [{ script: W2.script, value: 7_000n }], 5);
    const T5id = txidOf(T5);
    const st = fake({
      history: new Map([[W2.address, [{ hex: T5, height: H1 }]]]),
      utxos: [{ address: W2.address, txid: T5id, index: 0, valueZat: 7_000n, height: H1, script: W2.script }],
    });
    const cache: ZcashHistoryCache = { ...emptyZcashHistory(), scannedTo: TIP - 50, activeAddresses: [W0.address] };
    const snap = await refreshZcash(st.rpc, WATCH, cache);
    const firstW2 = st.calls.find((c) => c.op === 'txs' && c.args[0] === W2.address);
    expect(firstW2?.args[1]).toBe(ZCASH_HISTORY_FLOOR); // new: from the floor, not from scannedTo
    expect(snap.history.map((r) => r.txid)).toEqual([T5id]);
    expect(snap.cache.activeAddresses).toEqual([W0.address, W2.address]);

    // Spent elsewhere, gone from /utxos: still scanned next time, incrementally.
    st.s.utxos = [];
    st.calls.length = 0;
    const snap2 = await refreshZcash(st.rpc, WATCH, snap.cache);
    const pages2 = st.calls.filter((c) => c.op === 'txs');
    expect(pages2.map((c) => c.args[0])).toEqual([W0.address, W2.address]);
    expect(pages2.every((c) => c.args[1] === TIP - ZCASH_RESCAN_OVERLAP + 1)).toBe(true);
    expect(snap2.cache.activeAddresses).toEqual([W0.address, W2.address]);
  });

  it('continues a truncated page from its resume height and dedupes across the seam', async () => {
    const txs = Array.from({ length: 7 }, (_, i) => ({
      hex: v5([{ txid: 'aa'.repeat(32), index: i, pub: X.pub }], [{ script: W0.script, value: BigInt(1000 + i) }], 100 + i),
      height: H1 + Math.floor(i / 2), // two per block
    }));
    const st = fake({ history: new Map([[W0.address, txs]]), pageMax: 3 });
    const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory());
    expect(snap.history).toHaveLength(7);
    expect(new Set(snap.history.map((r) => r.txid)).size).toBe(7);
    const resumed = st.calls.filter((c) => c.op === 'txs' && (c.args[1] as number) >= H1);
    expect(resumed.length).toBeGreaterThan(1);
  });

  it('a block with more than a page for one address cannot loop forever', async () => {
    const txs = Array.from({ length: 5 }, (_, i) => ({
      hex: v5([{ txid: 'bb'.repeat(32), index: i, pub: X.pub }], [{ script: W0.script, value: 1000n }], 200 + i),
      height: H1,
    }));
    const st = fake({ history: new Map([[W0.address, txs]]), pageMax: 2 });
    const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory());
    expect(snap.history.length).toBeGreaterThanOrEqual(2);
    expect(st.calls.filter((c) => c.op === 'txs').length).toBeLessThan(20);
  });

  it('coinbase UTXOs are unspendable; mempool-spent UTXOs are not offered; pending figures', async () => {
    const CB = coinbaseTx({ script: W0.script, value: 312_500_000n });
    const CBid = txidOf(CB);
    const st = story();
    st.s.history.get(W0.address)?.push({ hex: CB, height: H3 + 1 });
    st.s.utxos.push({ address: W0.address, txid: CBid, index: 0, valueZat: 312_500_000n, height: H3 + 1, script: W0.script });
    const other = 'cc'.repeat(32);
    st.s.mempool = [
      // Incoming 5,000 from X.
      { txid: other, vin: [{ txid: '11'.repeat(32), index: 0 }], vout: [{ valueZat: 5_000n, script: bytesToHex(W2.script) }] },
      // Our own spend of T3:0 (20,000) paying X 10,000 with 5,000 change.
      {
        txid: '22'.repeat(32),
        vin: [{ txid: T3id, index: 0 }],
        vout: [
          { valueZat: 10_000n, script: bytesToHex(X.script) },
          { valueZat: 5_000n, script: bytesToHex(W1.script) },
        ],
      },
    ];
    const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory());
    expect(snap.unspendable.map((u) => u.txid)).toEqual([CBid]);
    expect(snap.unspendable[0].coinbase).toBe(true);
    expect(snap.spendable).toEqual([]); // T3:0 is being spent in the mempool
    expect(snap.pendingIn).toBe(5_000n);
    expect(snap.pendingOut).toBe(15_000n);
    expect(snap.pending).toEqual([
      { txid: other, received: 5_000n, spent: 0n },
      { txid: '22'.repeat(32), received: 5_000n, spent: 20_000n },
    ]);
    expect(snap.history.find((r) => r.txid === CBid)).toMatchObject({ coinbase: true, received: 312_500_000n, sent: 0n, addresses: [] });
    // The mempool was asked about our outpoints.
    const mp = st.calls.find((c) => c.op === 'mempool');
    expect(mp?.args[1]).toEqual(expect.arrayContaining([`${T3id}:0`, `${CBid}:0`]));
    // An address paid only in the mempool becomes active.
    expect(snap.cache.activeAddresses).toContain(W2.address);
  });

  describe('own sends (the local send record)', () => {
    // Our send of T3:0 (20,000): 10,000 to X, 5,000 change to /1/0, fee 5,000.
    const OWN = '44'.repeat(32);
    const ownSend = (over: Partial<ZcashOwnSend> = {}): ZcashOwnSend => ({
      txid: OWN,
      expiryHeight: TIP + 41,
      spent: [`${T3id}:0`],
      outflowZat: 15_000n,
      ...over,
    });
    const ownMempoolTx = (vin: { txid: string; index: number }[]): ZcashMempoolTx => ({
      txid: OWN,
      vin,
      vout: [
        { valueZat: 10_000n, script: bytesToHex(X.script) },
        { valueZat: 5_000n, script: bytesToHex(W1.script) },
      ],
    });

    it('without inputs in the mempool answer (what lightwalletd sends), the change is NOT income: it is outgoing', async () => {
      const st = story();
      st.s.mempool = [ownMempoolTx([])];
      const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory(), undefined, [ownSend()]);
      expect(snap.confirmed).toBe(20_000n);
      expect(snap.pendingIn).toBe(0n);
      expect(snap.pendingOut).toBe(15_000n);
      expect(snap.spendable).toEqual([]); // its input is spoken for
      expect(snap.pending).toEqual([{ txid: OWN, received: 5_000n, spent: 20_000n }]);
    });

    it('with real inputs it is the same answer (inputs minus change), counted once', async () => {
      const st = story();
      st.s.mempool = [ownMempoolTx([{ txid: T3id, index: 0 }])];
      const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory(), undefined, [ownSend({ outflowZat: null })]);
      expect(snap.pendingIn).toBe(0n);
      expect(snap.pendingOut).toBe(15_000n);
      expect(snap.pending).toHaveLength(1);
    });

    it('not in the mempool answer yet (gateway cache): still outgoing while its input is a confirmed coin', async () => {
      const st = story();
      const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory(), undefined, [ownSend()]);
      expect(snap.pendingOut).toBe(15_000n);
      expect(snap.pendingIn).toBe(0n);
      expect(snap.spendable).toEqual([]);
    });

    it('its input gone from the confirmed coins (mined meanwhile) and not in the mempool: nothing pending', async () => {
      const st = story();
      st.s.utxos = [];
      const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory(), undefined, [ownSend()]);
      expect(snap.pendingOut).toBe(0n);
    });

    it('expired only past the safety margin AND after /tx finds no server that knows it', async () => {
      const st = story();
      // Two blocks past expiry: no lookup yet, still held back as unknown.
      const early = await refreshZcash(st.rpc, WATCH, emptyZcashHistory(), undefined, [ownSend({ expiryHeight: TIP - 2 })]);
      expect(st.calls.filter((c) => c.op === 'tx')).toHaveLength(0);
      expect(classifySend({ txid: OWN, expiryHeight: TIP - 2 }, early)).toBe('unknown');
      expect(early.spendable).toEqual([]);
      // Three blocks past expiry, and /tx does not know it: expired, the coin is free again.
      st.calls.length = 0;
      const late = await refreshZcash(st.rpc, WATCH, emptyZcashHistory(), undefined, [ownSend({ expiryHeight: TIP - ZCASH_EXPIRY_SAFETY_BLOCKS })]);
      expect(st.calls.filter((c) => c.op === 'tx').map((c) => c.args[0])).toEqual([OWN]);
      expect(late.sendLookups).toEqual({ [OWN]: 'gone' });
      expect(classifySend({ txid: OWN, expiryHeight: TIP - ZCASH_EXPIRY_SAFETY_BLOCKS }, late)).toBe('expired');
      expect(late.spendable.map((u) => u.txid)).toEqual([T3id]);
      expect(late.pendingOut).toBe(0n);
      // A server that still has it in its mempool: pending, not expired.
      st.s.byTxid.set(OWN, { hex: T1, height: 0 });
      const known = await refreshZcash(st.rpc, WATCH, emptyZcashHistory(), undefined, [ownSend({ expiryHeight: TIP - ZCASH_EXPIRY_SAFETY_BLOCKS })]);
      expect(classifySend({ txid: OWN, expiryHeight: TIP - ZCASH_EXPIRY_SAFETY_BLOCKS }, known)).toBe('pending');
      expect(known.pendingOut).toBe(15_000n);
    });

    it('a failed /tx lookup keeps the send unknown (held back), never expired, never a failed refresh', async () => {
      const st = story();
      st.rpc.tx = async () => {
        throw new ZcashRpcError('http', 'HTTP 502 (tx)', 502);
      };
      const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory(), undefined, [ownSend({ txid: '45'.repeat(32), expiryHeight: TIP - 10 })]);
      expect(classifySend({ txid: '45'.repeat(32), expiryHeight: TIP - 10 }, snap)).toBe('unknown');
      expect(snap.spendable).toEqual([]);
    });
  });

  it('a spend whose funding record aged out is recognised by its public key and valued with one /tx', async () => {
    const st = story();
    const cache = (await refreshZcash(st.rpc, WATCH, emptyZcashHistory())).cache;
    // Forget everything but T3 (as if the cap had dropped the older records).
    cache.txs = cache.txs.filter((r) => r.txid === T3id).map((r) => ({ ...r, ownOutputs: undefined }));
    const T6 = v5([{ txid: T3id, index: 0, pub: W0.pub }], [{ script: X.script, value: 10_000n }], 6);
    const T6id = txidOf(T6);
    st.s.history.set(W0.address, [{ hex: T6, height: TIP + 1 }]);
    st.s.tip = TIP + 1;
    st.s.utxos = [];
    st.s.byTxid.set(T3id, { hex: T3, height: H3 });
    st.calls.length = 0;
    const snap = await refreshZcash(st.rpc, WATCH, cache);
    expect(snap.history.find((r) => r.txid === T6id)).toMatchObject({ sent: 20_000n, fee: 10_000n });
    expect(st.calls.filter((c) => c.op === 'tx').map((c) => c.args[0])).toEqual([T3id]);
  });

  it('a UTXO whose funding transaction is unknown to history is checked with /tx; unknown stays unspendable', async () => {
    const CB = coinbaseTx({ script: W0.script, value: 1_000n });
    const CBid = txidOf(CB);
    const st = fake({
      utxos: [
        { address: W0.address, txid: CBid, index: 0, valueZat: 1_000n, height: H1, script: W0.script },
        { address: W0.address, txid: '33'.repeat(32), index: 0, valueZat: 2_000n, height: H1, script: W0.script },
      ],
      byTxid: new Map([[CBid, { hex: CB, height: H1 }]]),
    });
    const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory());
    expect(snap.unspendable.map((u) => u.txid).sort()).toEqual([CBid, '33'.repeat(32)].sort());
    expect(snap.spendable).toEqual([]);
  });

  it('an unrecognised transaction version is one row, never a failed refresh', async () => {
    const weird = '07000080' + '00'.repeat(40);
    const st = fake({ history: new Map([[W0.address, [{ hex: weird, height: H1 }, { hex: T1, height: H1 + 1 }]]]) });
    const snap = await refreshZcash(st.rpc, WATCH, emptyZcashHistory());
    expect(snap.history).toHaveLength(2);
    const odd = snap.history.find((r) => r.version === 'unknown');
    expect(odd?.txid).toMatch(/^unrecognised:[0-9a-f]{64}$/);
    expect(odd).toMatchObject({ received: 0n, sent: 0n, fee: null, height: H1 });
    // A malformed transaction of a known version is handled the same way.
    const broken = T1.slice(0, T1.length - 10);
    const st2 = fake({ history: new Map([[W0.address, [{ hex: broken, height: H1 }]]]) });
    expect((await refreshZcash(st2.rpc, WATCH, emptyZcashHistory())).history[0].version).toBe('unknown');
  });

  it('a failed call leaves the cache exactly as it was', async () => {
    const st = story();
    const cache: ZcashHistoryCache = { ...emptyZcashHistory(), scannedTo: 5, activeAddresses: [W1.address] };
    const before = JSON.stringify(cache);
    st.s.failOn = 'txs';
    await expect(refreshZcash(st.rpc, WATCH, cache)).rejects.toThrow(/502/);
    expect(JSON.stringify(cache)).toBe(before);
  });

  it('honours an abort between pages', async () => {
    const st = fake();
    const ctrl = new AbortController();
    const txs = st.rpc.txs.bind(st.rpc);
    st.rpc.txs = async (...args) => {
      ctrl.abort();
      return txs(...args);
    };
    await expect(refreshZcash(st.rpc, WATCH, emptyZcashHistory(), ctrl.signal)).rejects.toMatchObject({ code: 'aborted' });
  });

  it('refuses an empty or malformed watch set', async () => {
    const { rpc, calls } = fake();
    await expect(refreshZcash(rpc, [], emptyZcashHistory())).rejects.toThrow();
    await expect(refreshZcash(rpc, ['u1notours'], emptyZcashHistory())).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('classifySend and resolveZcashSend', () => {
  const base = (over: Partial<ZcashSnapshot>): ZcashSnapshot =>
    ({
      info: { chainName: 'main', height: 1000, estimatedHeight: 1000, consensusBranchId: BRANCH, upgradeName: '', upgradeHeight: 0, taddrSupport: true },
      confirmed: 0n,
      pendingIn: 0n,
      pendingOut: 0n,
      spendable: [],
      unspendable: [],
      utxosTruncated: false,
      history: [],
      mempool: [],
      pending: [],
      cache: emptyZcashHistory(),
      ...over,
    }) as ZcashSnapshot;
  const id = 'ab'.repeat(32);

  it('history means confirmed, mempool pending, expired only past the margin and not found by /tx, else unknown', () => {
    const rec = { txid: id, received: 0n, sent: 1n, fee: 1n, addresses: [], coinbase: false, version: 5 as const, height: 990 };
    const gone = { sendLookups: { [id]: 'gone' as const } };
    expect(classifySend({ txid: id, expiryHeight: 1040 }, base({ history: [rec] }))).toBe('confirmed');
    expect(classifySend({ txid: id.toUpperCase(), expiryHeight: 1040 }, base({ mempool: [{ txid: id, vin: [], vout: [] }] }))).toBe('pending');
    // ZIP-203: it can still be mined IN its expiry block; servers can lag.
    expect(classifySend({ txid: id, expiryHeight: 1000 }, base(gone))).toBe('unknown');
    expect(classifySend({ txid: id, expiryHeight: 998 }, base(gone))).toBe('unknown');
    expect(classifySend({ txid: id, expiryHeight: 997 }, base(gone))).toBe('expired');
    expect(classifySend({ txid: id, expiryHeight: 900 }, base(gone))).toBe('expired');
    // Past the margin but never looked up: not expired.
    expect(classifySend({ txid: id, expiryHeight: 900 }, base({}))).toBe('unknown');
    expect(classifySend({ txid: id, expiryHeight: 900 }, base({ sendLookups: { [id]: 'pending' } }))).toBe('pending');
    expect(classifySend({ txid: id, expiryHeight: 900 }, base({ sendLookups: { [id]: 'confirmed' } }))).toBe('confirmed');
    expect(classifySend({ txid: id, expiryHeight: 1001 }, base({}))).toBe('unknown');
    expect(classifySend({ txid: id, expiryHeight: 0 }, base(gone))).toBe('unknown');
  });

  it('resolveZcashSend: /tx height > 0 confirmed, 0 pending, unknown or side chain unknown; never sends', async () => {
    const byTxid = new Map([[id, { hex: '05000080', height: 0 }]]);
    const { rpc, calls } = fake({ byTxid });
    expect(await resolveZcashSend(rpc, id)).toBe('pending');
    byTxid.set(id, { hex: '05000080', height: 1234 });
    expect(await resolveZcashSend(rpc, id)).toBe('confirmed');
    byTxid.set(id, { hex: '05000080', height: -1 });
    expect(await resolveZcashSend(rpc, id)).toBe('unknown');
    byTxid.clear();
    expect(await resolveZcashSend(rpc, id)).toBe('unknown');
    expect(calls.every((c) => c.op === 'tx')).toBe(true);
  });
});
