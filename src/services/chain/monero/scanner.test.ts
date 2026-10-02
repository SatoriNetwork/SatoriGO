// The scanner's own logic, with monero-ts replaced by a fake: open/create
// dispatch, the cache round trip, checkpoint saves during a long scan, the
// lock, close/terminate, the send guards and error mapping. Nothing here loads
// WASM; the live path is scripts/monero-extension-smoke.mjs (qa:monero).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { moneroCacheSecrets, moneroKeysFromBip39, type MoneroKeys } from './keys';
import { MONERO_CACHE_DB, MONERO_CACHE_STORE, _setMoneroCacheIdbFactoryForTests, deleteMoneroCache, loadMoneroCache } from './cache';
import { createMemoryIdb, type MemoryIdb } from './testing/memoryIdb';
import {
  CHECKPOINT_BLOCKS,
  MoneroWalletError,
  _setMoneroLibraryForTests,
  _setMoneroLockForTests,
  activeMoneroHost,
  checkpointDue,
  classifyMoneroError,
  closeActiveMoneroHost,
  moneroDaemonUri,
  openMoneroWallet,
  sortTxRecords,
  toBytes,
  toMoneroTxRecord,
  toPiconero,
  toSyncProgress,
  type MoneroLib,
  type MoneroOpenArgs,
  type MoneroSyncProgress,
  type MoneroWalletLike,
  type TxLike,
} from './scanner';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ADDRESS =
  '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756';
const VECTOR_SUB_0_1 =
  '88DAExP6fh2iR45U7DJcFRP5YEQbg8T4EKhhYz7J5vg1YA17kxiQZyv6AMaMyW7yDhaKYTyDN6M5v8AAAVdtMEEB8AeZUEA';
const OTHER_ADDRESS =
  '4BCmqSJ5GVJ7cqoxcu5wXURMDfhgvw596Dp7mjtVoD8fcpuYR3gad8VHBgLBwC11HZ3eWM3DJqWk7UrSKDZ26RtBKwJccRo';

// ---------------------------------------------------------------------------
// A fake monero-ts: just enough wallet2 behaviour to exercise the host.
// ---------------------------------------------------------------------------

interface FakeState {
  address: string;
  password: string;
  spendHex: string;
  restoreHeight: number;
  height: number;
  subs: Array<{ minor: number; address: string; label: string; used: boolean }>;
}

class FakeListener {
  onSyncProgress(_h: number, _s: number, _e: number, _p: number, _m: string): unknown {
    return undefined;
  }
}

interface FakeLibControl {
  lib: MoneroLib;
  tip: number;
  unlocked: bigint;
  fee: bigint;
  sweepCount: number;
  addressOverride: string | null;
  created: Array<Record<string, unknown>>;
  opened: Array<Record<string, unknown>>;
  workerLoaders: number;
  terminated: number;
  closedWallets: number;
  syncCalls: number;
  stopCalls: number;
  relayed: string[];
  txs: TxLike[];
  /** Make stopSyncing ineffective (the stop flag never reaches wallet2). */
  ignoreStops: boolean;
  wallets: FakeWallet[];
}

class FakeWallet implements MoneroWalletLike {
  state: FakeState;
  private ctl: FakeLibControl;
  private stop = false;
  closed = false;
  constructor(ctl: FakeLibControl, state: FakeState) {
    this.ctl = ctl;
    this.state = state;
  }
  private live() {
    if (this.closed) throw new Error('Wallet is closed');
  }
  async getPrimaryAddress() {
    this.live();
    return this.ctl.addressOverride ?? this.state.address;
  }
  async getSubaddresses(major: number) {
    this.live();
    return [{ minor: 0, address: this.state.address, label: 'Primary account', used: false }, ...this.state.subs].map((s) =>
      sub(major, s),
    );
  }
  async createSubaddress(major: number, label = '') {
    this.live();
    const minor = this.state.subs.length + 1;
    const s = { minor, address: minor === 1 ? VECTOR_SUB_0_1 : `8fake${minor}`, label, used: false };
    this.state.subs.push(s);
    return sub(major, s);
  }
  async sync(listener?: unknown) {
    this.live();
    this.ctl.syncCalls++;
    // Like wallet2's refresh(): the run flag is set at the start of a call.
    this.stop = false;
    const start = Math.max(this.state.height, this.state.restoreHeight);
    let fetched = 0;
    for (let h = start; h < this.ctl.tip; h++) {
      if (this.stop && !this.ctl.ignoreStops) break;
      // A macrotask per block, like wallet2 awaiting its next HTTP reply, so a
      // stopSyncing() message can land mid-scan. setImmediate, not setTimeout:
      // Windows timers tick at ~15 ms.
      await new Promise((r) => setImmediate(r));
      if (this.closed) throw new Error('Wallet is closed');
      this.state.height = h + 1;
      fetched++;
      (listener as FakeListener | undefined)?.onSyncProgress(h, start, this.ctl.tip, (h + 1 - start) / (this.ctl.tip - start), '');
    }
    return { numBlocksFetched: fetched };
  }
  async stopSyncing() {
    this.ctl.stopCalls++;
    this.stop = true;
  }
  // The fake holds 1000 piconero of "other accounts" money on top of account 0,
  // so a balance read without the account index is caught by the tests.
  async getBalance(accountIdx?: number) {
    this.live();
    return accountIdx === 0 ? this.ctl.unlocked + 5n : this.ctl.unlocked + 5n + 1000n;
  }
  async getUnlockedBalance(accountIdx?: number) {
    this.live();
    return accountIdx === 0 ? this.ctl.unlocked : this.ctl.unlocked + 1000n;
  }
  async getHeight() {
    this.live();
    return this.state.height;
  }
  async getDaemonHeight() {
    this.live();
    return this.ctl.tip;
  }
  async getTxs() {
    this.live();
    return this.ctl.txs;
  }
  async createTx(config: Record<string, unknown>) {
    this.live();
    if (config.relay !== false) throw new Error('test: createTx must be called with relay:false');
    if ((config.amount as bigint) > this.ctl.unlocked) throw new Error('not enough money');
    return fakeTx({ hash: 'aa'.repeat(32), fee: this.ctl.fee, outgoing: config.amount as bigint, metadata: 'meta-1' });
  }
  async sweepUnlocked(config: Record<string, unknown>) {
    this.live();
    if (config.relay !== false) throw new Error('test: sweep must be called with relay:false');
    if (this.ctl.unlocked === 0n) throw new Error('No unlocked balance in the specified account');
    return Array.from({ length: this.ctl.sweepCount }, (_, i) =>
      fakeTx({ hash: `b${i}`.padEnd(64, '0'), fee: this.ctl.fee, outgoing: this.ctl.unlocked - this.ctl.fee, metadata: `sweep-${i}` }),
    );
  }
  async relayTx(metadata: string) {
    this.live();
    this.ctl.relayed.push(metadata);
    return metadata === 'meta-1' ? 'aa'.repeat(32) : 'b0'.padEnd(64, '0');
  }
  async getData() {
    this.live();
    const keys = new TextEncoder().encode(JSON.stringify({ pw: this.state.password, address: this.state.address, spend: this.state.spendHex }));
    const cache = new TextEncoder().encode(
      JSON.stringify({ height: this.state.height, restoreHeight: this.state.restoreHeight, subs: this.state.subs }),
    );
    return [keys, new DataView(cache.buffer)];
  }
  async getPrivateSpendKey() {
    this.live();
    return this.state.spendHex;
  }
  async close() {
    this.closed = true;
    this.ctl.closedWallets++;
  }
}

function sub(major: number, s: { minor: number; address: string; label: string; used: boolean }) {
  return {
    getAccountIndex: () => major,
    getIndex: () => s.minor,
    getAddress: () => s.address,
    getLabel: () => s.label,
    getIsUsed: () => s.used,
  };
}

function fakeTx(t: { hash: string; fee: bigint; outgoing: bigint; metadata: string }): TxLike {
  return {
    getHash: () => t.hash,
    getFee: () => t.fee,
    getOutgoingAmount: () => t.outgoing,
    getMetadata: () => t.metadata,
    getSize: () => 1500,
    getIsOutgoing: () => true,
  };
}

function makeLib(tip: number): FakeLibControl {
  const ctl: FakeLibControl = {
    lib: undefined as unknown as MoneroLib,
    tip,
    unlocked: 0n,
    fee: 30_000_000n,
    sweepCount: 1,
    addressOverride: null,
    created: [],
    opened: [],
    workerLoaders: 0,
    terminated: 0,
    closedWallets: 0,
    syncCalls: 0,
    stopCalls: 0,
    relayed: [],
    txs: [],
    ignoreStops: false,
    wallets: [],
  };
  ctl.lib = {
    async createWalletFull(cfg) {
      ctl.created.push(cfg);
      const w = new FakeWallet(ctl, {
        address: VECTOR_ADDRESS,
        password: String(cfg.password),
        spendHex: String(cfg.privateSpendKey),
        restoreHeight: Number(cfg.restoreHeight),
        height: 0,
        subs: [],
      });
      ctl.wallets.push(w);
      return w;
    },
    async openWalletFull(cfg) {
      ctl.opened.push(cfg);
      const keys = JSON.parse(new TextDecoder().decode(cfg.keysData as Uint8Array));
      if (keys.pw !== cfg.password) throw new Error('invalid password');
      const cache = JSON.parse(new TextDecoder().decode(cfg.cacheData as Uint8Array));
      const w = new FakeWallet(ctl, {
        address: keys.address,
        password: keys.pw,
        spendHex: keys.spend,
        restoreHeight: cache.restoreHeight,
        height: cache.height,
        subs: cache.subs,
      });
      ctl.wallets.push(w);
      return w;
    },
    LibraryUtils: {
      setWorkerLoader() {
        ctl.workerLoaders++;
      },
      async terminateWorker() {
        ctl.terminated++;
      },
    },
    MoneroWalletListener: FakeListener,
  };
  return ctl;
}

// ---------------------------------------------------------------------------

let idb: MemoryIdb;
let ctl: FakeLibControl;
let keys: MoneroKeys;
let heldLocks: Set<string>;

function args(over: Partial<MoneroOpenArgs> = {}): MoneroOpenArgs {
  return {
    walletId: 'w-xmr',
    keys,
    restoreHeight: 3_772_358,
    gatewayUrl: 'https://network.satorigo.app',
    clientToken: 'tok',
    nodeSet: 'main',
    trustedDaemon: true,
    ...over,
  };
}

beforeEach(() => {
  idb = createMemoryIdb();
  _setMoneroCacheIdbFactoryForTests(idb.factory);
  ctl = makeLib(3_772_358 + 40);
  _setMoneroLibraryForTests(async () => ctl.lib);
  heldLocks = new Set();
  _setMoneroLockForTests(async (name) => {
    if (heldLocks.has(name)) return null;
    heldLocks.add(name);
    return () => heldLocks.delete(name);
  });
  keys = moneroKeysFromBip39(ABANDON);
});

afterEach(async () => {
  await closeActiveMoneroHost();
  _setMoneroLibraryForTests(null);
  _setMoneroLockForTests(null);
  _setMoneroCacheIdbFactoryForTests(null);
});

describe('openMoneroWallet', () => {
  it('creates from the spend key with the owner-fixed options, and checks the address', async () => {
    const host = await openMoneroWallet(args());
    expect(await host.primaryAddress()).toBe(VECTOR_ADDRESS);
    expect(ctl.created).toHaveLength(1);
    expect(ctl.opened).toHaveLength(0);
    const cfg = ctl.created[0];
    const { wallet2Password } = moneroCacheSecrets(keys);
    expect(cfg).toMatchObject({
      networkType: 'mainnet',
      password: wallet2Password,
      privateSpendKey: bytesToHex(keys.spendSec),
      restoreHeight: 3_772_358,
      server: { uri: 'https://network.satorigo.app' },
      isTrustedDaemon: true,
    });
    // No path, no seed, no view-key-only shortcut.
    expect(Object.keys(cfg).sort()).toEqual(
      ['isTrustedDaemon', 'networkType', 'password', 'privateSpendKey', 'restoreHeight', 'server'].sort(),
    );
    expect(ctl.workerLoaders).toBe(1);
    expect(heldLocks.has('monero:w-xmr')).toBe(true);
  });

  it('does not zero or keep the caller\'s keys', async () => {
    const spend = Uint8Array.from(keys.spendSec);
    const host = await openMoneroWallet(args());
    await host.close();
    expect(Buffer.from(keys.spendSec).equals(Buffer.from(spend))).toBe(true);
  });

  it('refuses when wallet2 derives a different address, and cleans up', async () => {
    ctl.addressOverride = OTHER_ADDRESS;
    await expect(openMoneroWallet(args())).rejects.toMatchObject({ name: 'MoneroWalletError', code: 'key-mismatch' });
    expect(ctl.terminated).toBe(1);
    expect(heldLocks.size).toBe(0);
    expect(activeMoneroHost()).toBeNull();
  });

  it('a second page gets "busy" while the first holds the wallet lock', async () => {
    heldLocks.add('monero:w-xmr');
    await expect(openMoneroWallet(args())).rejects.toMatchObject({ code: 'busy' });
    expect(ctl.created).toHaveLength(0);
  });

  it('refuses bad arguments before loading anything', async () => {
    await expect(openMoneroWallet(args({ nodeSet: '../evm' }))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(openMoneroWallet(args({ restoreHeight: -1 }))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(openMoneroWallet(args({ gatewayUrl: '' }))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(openMoneroWallet(args({ gatewayUrl: 'https://network.satorigo.app/gw' }))).rejects.toMatchObject({ code: 'unsupported' });
    expect(ctl.workerLoaders).toBe(0);
  });

  it('opening another wallet closes the one already open (one worker per page)', async () => {
    const a = await openMoneroWallet(args());
    const b = await openMoneroWallet(args({ walletId: 'w-other' }));
    expect(ctl.terminated).toBe(1);
    await expect(a.primaryAddress()).rejects.toMatchObject({ code: 'closed' });
    expect(await b.primaryAddress()).toBe(VECTOR_ADDRESS);
    expect(activeMoneroHost()).toBe(b);
  });
});

describe('sync, cache and reopen', () => {
  it('syncs to the tip with 0 to 100 progress, saves, and the next open uses the cache', async () => {
    const host = await openMoneroWallet(args());
    const seen: MoneroSyncProgress[] = [];
    const bal = await host.sync((p) => seen.push(p));
    expect(bal).toEqual({ total: 5n, unlocked: 0n, height: ctl.tip, daemonHeight: ctl.tip });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.percent >= 0 && p.percent <= 100)).toBe(true);
    expect(seen[seen.length - 1].percent).toBe(100);
    const sub = await host.createSubaddress(0, 'shop');
    expect(sub).toEqual({ major: 0, minor: 1, address: VECTOR_SUB_0_1, label: 'shop', used: false });
    await host.close();
    expect(ctl.terminated).toBe(1);

    // The row is there, encrypted under the derived key, and holds the height.
    const { cacheKey } = moneroCacheSecrets(keys);
    const blob = await loadMoneroCache('w-xmr', cacheKey);
    expect(blob!.height).toBe(ctl.tip);
    expect(blob!.restoreHeight).toBe(3_772_358);

    // Reopen: openWalletFull from the cache, no create, no rescan.
    const again = await openMoneroWallet(args());
    expect(ctl.created).toHaveLength(1);
    expect(ctl.opened).toHaveLength(1);
    expect(ctl.opened[0]).toMatchObject({ isTrustedDaemon: true, networkType: 'mainnet' });
    const syncsBefore = ctl.syncCalls;
    const bal2 = await again.sync();
    expect(bal2.height).toBe(ctl.tip);
    expect(ctl.syncCalls - syncsBefore).toBe(1);
    const subs = await again.subaddresses(0);
    expect(subs.map((s) => s.address)).toEqual([VECTOR_ADDRESS, VECTOR_SUB_0_1]);
  });

  it('a long scan is stopped and saved every CHECKPOINT_BLOCKS blocks, then finishes', async () => {
    ctl.tip = 3_772_358 + CHECKPOINT_BLOCKS * 2 + 150;
    const host = await openMoneroWallet(args());
    const bal = await host.sync();
    expect(bal.height).toBe(ctl.tip);
    expect(ctl.stopCalls).toBe(2);
    expect(ctl.syncCalls).toBe(3);
    const { cacheKey } = moneroCacheSecrets(keys);
    expect((await loadMoneroCache('w-xmr', cacheKey))!.height).toBe(ctl.tip);
  });

  it('does not spin when stopSyncing never takes effect', async () => {
    ctl.tip = 3_772_358 + CHECKPOINT_BLOCKS * 3;
    ctl.ignoreStops = true;
    const host = await openMoneroWallet(args());
    const bal = await host.sync();
    expect(bal.height).toBe(ctl.tip);
    expect(ctl.syncCalls).toBe(1);
  });

  it('concurrent sync() calls share one scan', async () => {
    const host = await openMoneroWallet(args());
    const [a, b] = await Promise.all([host.sync(), host.sync()]);
    expect(a).toEqual(b);
    expect(ctl.syncCalls).toBe(1);
  });

  it('a cache made for another restore height is not used', async () => {
    const host = await openMoneroWallet(args());
    await host.sync();
    await host.close();
    await openMoneroWallet(args({ restoreHeight: 3_772_000 }));
    expect(ctl.opened).toHaveLength(0);
    expect(ctl.created).toHaveLength(2);
    expect(ctl.created[1].restoreHeight).toBe(3_772_000);
  });

  it('a cache wallet2 refuses (or that does not decrypt) is rebuilt, not fatal', async () => {
    const host = await openMoneroWallet(args());
    await host.sync();
    await host.close();
    // Corrupt the stored row: GCM fails, the scanner starts over.
    const row = idb.dump(MONERO_CACHE_DB, MONERO_CACHE_STORE).get('w-xmr') as { ct: Uint8Array };
    row.ct[10] ^= 1;
    idb.poke(MONERO_CACHE_DB, MONERO_CACHE_STORE, 'w-xmr', row);
    const again = await openMoneroWallet(args());
    expect(ctl.created).toHaveLength(2);
    expect(await again.primaryAddress()).toBe(VECTOR_ADDRESS);
  });

  it('close() during a scan stops it, saves, terminates, and the scan rejects "closed"', async () => {
    ctl.tip = 3_772_358 + 300;
    const host = await openMoneroWallet(args());
    let midway!: () => void;
    const reached = new Promise<void>((r) => (midway = r));
    // Progress is throttled to one callback per 200 ms, so the first one (at
    // the first block) is the one to close on.
    const scan = host.sync(() => midway());
    await reached;
    await host.close();
    await expect(scan).rejects.toMatchObject({ code: 'closed' });
    expect(ctl.terminated).toBe(1);
    expect(heldLocks.size).toBe(0);
    const { cacheKey } = moneroCacheSecrets(keys);
    const blob = await loadMoneroCache('w-xmr', cacheKey);
    expect(blob!.height).toBeGreaterThan(3_772_358);
    expect(blob!.height).toBeLessThan(ctl.tip);
    await expect(host.balance()).rejects.toMatchObject({ code: 'closed' });
    await expect(host.close()).resolves.toBeUndefined(); // idempotent
  });

  it('balance() is account 0 only, the account the send path spends from', async () => {
    // The fake reports 1000 piconero more for a wallet-wide read (no index).
    const host = await openMoneroWallet(args());
    ctl.unlocked = 7n;
    const bal = await host.balance();
    expect(bal.total).toBe(12n);
    expect(bal.unlocked).toBe(7n);
  });

  it('a wallet the store no longer lists is never written back to the cache (removed in another window)', async () => {
    let exists = true;
    const host = await openMoneroWallet(args({ walletExists: async () => exists }));
    await host.sync();
    const { cacheKey } = moneroCacheSecrets(keys);
    expect(await loadMoneroCache('w-xmr', cacheKey)).not.toBeNull();
    // The other window removed the wallet and deleted its row.
    await deleteMoneroCache('w-xmr');
    exists = false;
    await host.createSubaddress(0, 'late'); // saves quietly on its own
    await host.save();
    await host.close();
    expect(await loadMoneroCache('w-xmr', cacheKey)).toBeNull();
    expect(ctl.terminated).toBe(1);
    expect(heldLocks.size).toBe(0);
  });

  it('close() terminates the worker within the grace period even when a worker call never settles', async () => {
    const host = await openMoneroWallet(args());
    // The final save's getData hangs (a gateway request that never answers).
    const wallet = ctl.wallets[ctl.wallets.length - 1];
    wallet.getData = () => new Promise<(Uint8Array | DataView)[]>(() => {});
    const t0 = Date.now();
    await host.close();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(2500);
    expect(took).toBeLessThan(6000);
    expect(ctl.terminated).toBe(1);
    expect(heldLocks.size).toBe(0);
  }, 10_000);

  it('setRestoreHeight recreates the wallet at the new height with the same key, and drops the cache', async () => {
    const host = await openMoneroWallet(args());
    await host.sync();
    await host.setRestoreHeight(3_772_100);
    expect(ctl.created).toHaveLength(2);
    expect(ctl.created[1]).toMatchObject({ restoreHeight: 3_772_100, privateSpendKey: bytesToHex(keys.spendSec) });
    const { cacheKey } = moneroCacheSecrets(keys);
    expect(await loadMoneroCache('w-xmr', cacheKey)).toBeNull();
    const bal = await host.sync();
    expect(bal.height).toBe(ctl.tip);
    expect((await loadMoneroCache('w-xmr', cacheKey))!.restoreHeight).toBe(3_772_100);
    await expect(host.setRestoreHeight(-5)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('send path', () => {
  const TO = OTHER_ADDRESS;

  it('an unfunded wallet: createTx fails with wallet2\'s "not enough money", code insufficient-funds', async () => {
    const host = await openMoneroWallet(args());
    const err = await host.buildTx({ to: TO, amountPico: 1_000_000_000n, priority: 'normal' }).catch((e) => e);
    expect(err).toBeInstanceOf(MoneroWalletError);
    expect(err.code).toBe('insufficient-funds');
    expect(err.message).toMatch(/not enough money/);
    const sweepErr = await host.buildTx({ to: TO, amountPico: 0n, priority: 'normal', sweep: true }).catch((e) => e);
    expect(sweepErr.code).toBe('insufficient-funds');
  });

  it('validates destination, amount and priority before wallet2 is asked', async () => {
    const host = await openMoneroWallet(args());
    await expect(host.buildTx({ to: 'nope', amountPico: 1n, priority: 'normal' })).rejects.toMatchObject({ code: 'invalid-address' });
    const stagenet = '5A8FgbMkmG2e3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVHCRUaE';
    await expect(host.buildTx({ to: stagenet, amountPico: 1n, priority: 'normal' })).rejects.toMatchObject({ code: 'invalid-address' });
    await expect(host.buildTx({ to: TO, amountPico: 0n, priority: 'normal' })).rejects.toMatchObject({ code: 'invalid-amount' });
    await expect(
      host.buildTx({ to: TO, amountPico: 1n, priority: 'urgent' as unknown as 'normal' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('builds with relay:false, then relays only that exact draft', async () => {
    ctl.unlocked = 5_000_000_000_000n;
    const host = await openMoneroWallet(args());
    const draft = await host.buildTx({ to: TO, amountPico: 1_000_000_000n, priority: 'elevated' });
    expect(draft).toEqual({
      metadata: 'meta-1',
      hash: 'aa'.repeat(32),
      fee: 30_000_000n,
      amount: 1_000_000_000n,
      sizeBytes: 1500,
      destination: TO,
      sweep: false,
    });
    expect(ctl.relayed).toEqual([]);
    await expect(host.relay({ ...draft, metadata: 'evil' })).rejects.toMatchObject({ code: 'draft-unknown' });
    await expect(host.relay({ ...draft, amount: 1n })).rejects.toMatchObject({ code: 'draft-unknown' });
    expect(await host.relay(draft)).toBe('aa'.repeat(32));
    expect(ctl.relayed).toEqual(['meta-1']);
    // A draft relays once.
    await expect(host.relay(draft)).rejects.toMatchObject({ code: 'draft-unknown' });
  });

  it('the fee guard refuses a fee above the cap (never clamps)', async () => {
    ctl.unlocked = 5_000_000_000_000n;
    ctl.fee = 60_000_000_000n; // 0.06 XMR
    const host = await openMoneroWallet(args());
    const err = await host.buildTx({ to: TO, amountPico: 1_000_000_000n, priority: 'normal' }).catch((e) => e);
    expect(err.code).toBe('fee');
    expect(err.message).toMatch(/cap/);
  });

  it('a sweep is one transaction or nothing', async () => {
    ctl.unlocked = 5_000_000_000_000n;
    const host = await openMoneroWallet(args());
    const d = await host.buildTx({ to: TO, amountPico: 0n, priority: 'normal', sweep: true });
    expect(d.sweep).toBe(true);
    expect(d.amount).toBe(5_000_000_000_000n - 30_000_000n);
    ctl.sweepCount = 2;
    await expect(host.buildTx({ to: TO, amountPico: 0n, priority: 'normal', sweep: true })).rejects.toMatchObject({
      code: 'sweep-multiple',
    });
  });
});

describe('pure helpers', () => {
  it('toPiconero never goes through a float', () => {
    expect(toPiconero(123n)).toBe(123n);
    expect(toPiconero(42)).toBe(42n);
    expect(toPiconero('18446744073709551615')).toBe(18446744073709551615n);
    expect(toPiconero(undefined)).toBe(0n);
    expect(toPiconero(1.5)).toBe(0n);
    expect(toPiconero('1e3')).toBe(0n);
  });

  it('toBytes accepts Uint8Array, DataView and ArrayBuffer', () => {
    const u = new Uint8Array([1, 2, 3, 4]);
    expect(toBytes(u)).toBe(u);
    expect([...toBytes(new DataView(u.buffer, 1, 2))]).toEqual([2, 3]);
    expect([...toBytes(u.buffer)]).toEqual([1, 2, 3, 4]);
    expect(() => toBytes('x')).toThrow(MoneroWalletError);
  });

  it('toSyncProgress measures over this scan (0 to 100), not from wallet2 refresh start', () => {
    expect(toSyncProgress(3_771_060, 3_770_060, 3_772_060)).toEqual({
      height: 3_771_060,
      startHeight: 3_770_060,
      endHeight: 3_772_060,
      percent: 50,
    });
    // wallet2 reports hash-chain heights far below the restore height first.
    expect(toSyncProgress(3_707_001, 3_770_060, 3_772_060).percent).toBe(0);
    expect(toSyncProgress(1, 3_770_060, 3_772_060).height).toBe(3_770_060);
    expect(toSyncProgress(3_780_000, 3_770_060, 3_772_060).percent).toBe(100);
    expect(toSyncProgress(5, 5, 5).percent).toBe(100);
    expect(toSyncProgress(Number.NaN, 10, 20).percent).toBe(0);
  });

  it('checkpointDue: 500 blocks or 30 s', () => {
    expect(checkpointDue({ lastSavedHeight: 100, lastSavedAt: 0 }, 599, 1000)).toBe(false);
    expect(checkpointDue({ lastSavedHeight: 100, lastSavedAt: 0 }, 600, 1000)).toBe(true);
    expect(checkpointDue({ lastSavedHeight: 100, lastSavedAt: 0 }, 101, 30_000)).toBe(true);
  });

  it('moneroDaemonUri is the gateway origin (the worker restores the path)', () => {
    expect(moneroDaemonUri('https://network.satorigo.app/', 'main')).toBe('https://network.satorigo.app');
    expect(() => moneroDaemonUri('https://network.satorigo.app/sub', 'main')).toThrow(MoneroWalletError);
  });

  it('classifyMoneroError maps wallet2 texts and keeps the words', () => {
    expect(classifyMoneroError(new Error('not enough money')).code).toBe('insufficient-funds');
    expect(classifyMoneroError(new Error('not enough unlocked money')).code).toBe('insufficient-funds');
    expect(classifyMoneroError(new Error('No unlocked balance in the specified account')).code).toBe('insufficient-funds');
    expect(classifyMoneroError(new Error('Network error')).code).toBe('network');
    expect(classifyMoneroError(new Error('Wallet is closed')).code).toBe('closed');
    expect(classifyMoneroError(new Error('something odd')).code).toBe('unknown');
    const fee = Object.assign(new Error('Refusing to send: above cap'), { name: 'MoneroFeeError' });
    expect(classifyMoneroError(fee)).toMatchObject({ code: 'fee', message: 'Refusing to send: above cap' });
    const same = new MoneroWalletError('busy', 'x');
    expect(classifyMoneroError(same)).toBe(same);
    expect(classifyMoneroError(new Error('y'.repeat(1000))).message.length).toBeLessThan(300);
  });

  it('toMoneroTxRecord: incoming, outgoing, pool; fee only when we paid it; ms timestamps', () => {
    const incoming = toMoneroTxRecord({
      getHash: () => 'in1',
      getHeight: () => 3_772_400,
      getBlock: () => ({ getTimestamp: () => 1_790_600_000 }),
      getNumConfirmations: () => 12,
      getIncomingAmount: () => 2_000_000_000_000n,
      getOutgoingAmount: () => undefined,
      getIsOutgoing: () => false,
      getFee: () => 30_000_000n,
      getIsLocked: () => false,
      getUnlockTime: () => 0n,
      getIncomingTransfers: () => [
        { getAccountIndex: () => 0, getSubaddressIndex: () => 3 },
        { getAccountIndex: () => 0, getSubaddressIndex: () => 1 },
        { getAccountIndex: () => 0, getSubaddressIndex: () => 3 },
      ],
    });
    expect(incoming).toEqual({
      hash: 'in1',
      height: 3_772_400,
      timestamp: 1_790_600_000_000,
      confirmations: 12,
      incoming: 2_000_000_000_000n,
      outgoing: 0n,
      fee: 0n,
      isLocked: false,
      unlockTime: 0,
      subaddressIndices: [
        { major: 0, minor: 1 },
        { major: 0, minor: 3 },
      ],
    });
    const pool = toMoneroTxRecord({
      getHash: () => 'out1',
      getHeight: () => undefined,
      getReceivedTimestamp: () => 1_790_700_000,
      getNumConfirmations: () => 0,
      getOutgoingAmount: () => 500n,
      getIsOutgoing: () => true,
      getFee: () => 40n,
      getIsLocked: () => true,
      getUnlockTime: () => 10n,
      getOutgoingTransfer: () => ({ getAccountIndex: () => 0, getSubaddressIndices: () => [0] }),
    });
    expect(pool).toMatchObject({ height: null, timestamp: 1_790_700_000_000, outgoing: 500n, fee: 40n, isLocked: true, unlockTime: 10 });
    expect(sortTxRecords([incoming, pool]).map((r) => r.hash)).toEqual(['out1', 'in1']);
  });

  it('history() maps and sorts what the wallet reports', async () => {
    ctl.txs = [
      { getHash: () => 'old', getHeight: () => 10, getIncomingAmount: () => 1n },
      { getHash: () => 'new', getHeight: () => 20, getIncomingAmount: () => 2n },
    ];
    const host = await openMoneroWallet(args());
    expect((await host.history()).map((r) => r.hash)).toEqual(['new', 'old']);
  });
});
