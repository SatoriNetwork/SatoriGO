// The open Monero wallet: scan, balance, history, subaddresses and send, all
// through monero-ts (the official wallet2 compiled to WASM) running in the
// page's wallet worker (the Monero engine design notes §6).
//
// WHY monero-ts DOES THE SCANNING. A Monero balance cannot be read from an
// address and history cannot be fetched from an indexer: every output on the
// chain has to be tried against the private view key, spends are only visible
// through key images (spend key), and building a transaction needs decoys from
// other people's outputs, CLSAG and Bulletproofs+. keys.ts/address.ts derive
// keys and addresses in pure TypeScript; everything that touches other
// people's outputs is wallet2's job, here. One scanner, not two.
//
// LIFETIME, the decisions this file enforces:
//   - Opened on unlock, in the UI page only (workerHost.ts), one wallet per
//     page. Opening a second wallet closes the first, because monero-ts keeps
//     ONE shared worker per page and closing a wallet terminates it.
//   - A `navigator.locks` lock named `monero:<walletId>` is held for the life
//     of the host, so a popup and a side panel never scan (and write the cache
//     of) the same wallet at once. The second page gets a MoneroWalletError
//     with code 'busy' and shows the other window's state instead (§6.3).
//   - close() = stop the scan, save, close, then Worker.terminate(). The WASM
//     heap is the one place the spend and view keys live; monero-ts does not
//     promise to scrub it on close, and terminate() releases all of it (§6.5).
//   - The cache (cache.ts) is saved every CHECKPOINT_BLOCKS blocks or
//     CHECKPOINT_MS, whichever first, and on close, so a popup closed mid-scan
//     loses at most that much. wallet2 serializes calls inside the worker, so
//     a save cannot run DURING a sync call; the checkpoint therefore stops the
//     sync (stopSyncing is not queued, it flips wallet2's run flag), saves,
//     and resumes from where the scan got to.
//
// KEYS. The spend key goes into wallet2 as hex at create time (monero-ts takes
// strings; a JS string cannot be zeroed, which is one more reason the worker
// is terminated on lock). This module never keeps `args.keys`: it takes what
// it needs at open (the cache secrets, the expected address) and the caller
// stays the owner of the key bytes. The derived cacheKey is zeroed on close.
// Nothing here logs a key, a password, a request body or a cache blob.
//
// DAEMON TRUST. `isTrustedDaemon: true` for the gateway node set (owner
// decision 2026-09-28): 0.1 MB per open instead of 18 MB, and the node only
// ever sees the gateway's IP. wallet2 still validates everything it can; the
// flag only skips its first-refresh blur and some restricted-node heuristics.

import { bytesToHex } from '@noble/hashes/utils';
import { moneroCacheSecrets, type MoneroKeys, type MoneroNetwork } from './keys';
import { primaryAddress as derivePrimaryAddress, isValidMoneroAddress } from './address';
import { MONERO_PRIORITY_CODE, assertMoneroFeeSane, type MoneroPriority } from './fees';
import { deleteMoneroCache, loadMoneroCache, saveMoneroCache } from './cache';
import { isValidMoneroNodeSet, moneroGatewayBase } from './rpc';
import { spawnMoneroWorker } from './workerHost';

// ---------------------------------------------------------------------------
// Public types (the Set B surface, §15)
// ---------------------------------------------------------------------------

export interface MoneroOpenArgs {
  walletId: string;
  keys: MoneroKeys;
  restoreHeight: number;
  gatewayUrl: string;
  clientToken: string;
  nodeSet: string;
  trustedDaemon: boolean;
  /** Default 'mainnet'. */
  network?: MoneroNetwork;
  /** Does the wallet entry still exist? Asked before every cache write. A
   *  wallet removed from ANOTHER window (its cache row deleted there) must not
   *  have its full history written back by this window's next checkpoint or
   *  close, under an id nothing can ever delete again. Absent = always. */
  walletExists?: () => Promise<boolean>;
}

/** Piconero (1 XMR = 1e12). `total` includes locked outputs; `unlocked` is what
 *  a send can spend now. `height` is the wallet's scanned height, `daemonHeight`
 *  the node's tip. */
export interface MoneroBalance {
  total: bigint;
  unlocked: bigint;
  height: number;
  daemonHeight: number;
}

/** `percent` is 0 to 100 (not 0 to 1 as monero-ts reports it). */
export interface MoneroSyncProgress {
  height: number;
  startHeight: number;
  endHeight: number;
  percent: number;
}

export interface MoneroSubaddress {
  major: number;
  minor: number;
  address: string;
  label: string;
  used: boolean;
}

/** One wallet transaction. Amounts are piconero. `timestamp` is ms since the
 *  epoch (block time when mined, first-seen time while in the pool), null when
 *  wallet2 has neither. `fee` is what THIS wallet paid: the fee of an outgoing
 *  transaction, 0 for a purely incoming one (the sender's fee is not ours). */
export interface MoneroTxRecord {
  hash: string;
  height: number | null;
  timestamp: number | null;
  confirmations: number;
  incoming: bigint;
  outgoing: bigint;
  fee: bigint;
  isLocked: boolean;
  unlockTime: number;
  subaddressIndices: Array<{ major: number; minor: number }>;
}

/** A built, signed, NOT relayed transaction. `metadata` is wallet2's opaque
 *  serialized tx; relay() only accepts a draft this host built, unchanged. */
export interface MoneroTxDraft {
  metadata: string;
  hash: string;
  fee: bigint;
  amount: bigint;
  sizeBytes: number;
  destination: string;
  sweep: boolean;
}

export interface MoneroWalletHost {
  readonly walletId: string;
  primaryAddress(): Promise<string>;
  subaddresses(major?: number): Promise<MoneroSubaddress[]>;
  createSubaddress(major: number, label?: string): Promise<MoneroSubaddress>;
  sync(onProgress?: (p: MoneroSyncProgress) => void): Promise<MoneroBalance>;
  balance(): Promise<MoneroBalance>;
  history(): Promise<MoneroTxRecord[]>;
  buildTx(args: {
    to: string;
    amountPico: bigint;
    priority: MoneroPriority;
    sweep?: boolean;
    accountIndex?: number;
  }): Promise<MoneroTxDraft>;
  /** Broadcast a draft from buildTx. Resolves with the txid. */
  relay(draft: MoneroTxDraft): Promise<string>;
  /** Rescan from `height`: drops the cache, recreates the wallet at that
   *  height. The caller then calls sync(). The entry's own restoreHeight is
   *  liveWallet's (setMoneroRestoreHeight); if it is not updated too, the next
   *  open sees a cache/entry mismatch and rebuilds from the entry's height. */
  setRestoreHeight(height: number): Promise<void>;
  save(): Promise<void>;
  /** Stop, save, close, terminate the worker. Idempotent. */
  close(): Promise<void>;
}

export type MoneroWalletErrorCode =
  | 'busy' // the wallet is open in another window of this browser profile
  | 'insufficient-funds' // wallet2: "not enough money", "No unlocked balance ..."
  | 'invalid-address'
  | 'invalid-amount'
  | 'fee' // the fee guard refused (fees.ts)
  | 'sweep-multiple' // a sweep that would need more than one transaction
  | 'draft-unknown' // relay() of a draft this host did not build, or altered
  | 'network' // the gateway or node did not answer
  | 'closed' // the host was closed
  | 'key-mismatch' // wallet2's address differs from the pure-TS derivation
  | 'unsupported' // no Worker, no gateway, bad arguments
  | 'unknown';

/** Every failure this module throws. `message` keeps wallet2's own words where
 *  there are any ("not enough money"), length capped, so the UI can show them
 *  and the smoke can match them; `code` is what the UI branches on. */
export class MoneroWalletError extends Error {
  readonly code: MoneroWalletErrorCode;
  constructor(code: MoneroWalletErrorCode, message: string) {
    super(message);
    this.name = 'MoneroWalletError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Save the cache at least this often during a long scan (§6.3). */
export const CHECKPOINT_BLOCKS = 500;
export const CHECKPOINT_MS = 30_000;
/** Progress callbacks reach the UI at most this often (plus the final one):
 *  monero-ts reports every block, and a render per block is waste. */
export const PROGRESS_INTERVAL_MS = 200;
const MAX_FOREIGN_TEXT = 200;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests: none of them needs WASM)
// ---------------------------------------------------------------------------

function capText(text: unknown): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return s.length > MAX_FOREIGN_TEXT ? `${s.slice(0, MAX_FOREIGN_TEXT)}...` : s;
}

/** Map anything thrown by monero-ts (or the worker bridge) to a
 *  MoneroWalletError. Already-mapped errors pass through; the fee guard's
 *  error becomes code 'fee' with its message kept. */
export function classifyMoneroError(err: unknown): MoneroWalletError {
  if (err instanceof MoneroWalletError) return err;
  const name = (err as { name?: unknown })?.name;
  const msg = capText((err as { message?: unknown })?.message ?? err);
  if (name === 'MoneroFeeError') return new MoneroWalletError('fee', msg);
  if (/not enough (unlocked )?money|no unlocked balance|not enough outputs|insufficient/i.test(msg)) {
    return new MoneroWalletError('insufficient-funds', msg);
  }
  if (/wallet is closed|wallet has been closed|is closed/i.test(msg)) return new MoneroWalletError('closed', msg);
  if (
    /network|timed? ?out|http|xhr|failed to fetch|no connection|not connected|daemon|connection refused|status code|503|502|504|429/i.test(
      msg,
    )
  ) {
    return new MoneroWalletError('network', msg);
  }
  return new MoneroWalletError('unknown', msg || 'Monero wallet error.');
}

/** monero-ts returns bigint for amounts; older paths and fakes can hand back a
 *  number or a decimal string. Anything else (undefined for "no such amount")
 *  is 0. Never goes through a float. */
export function toPiconero(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/** getData() hands back Uint8Array through the worker bridge, DataView when
 *  run on the same thread. Both become a Uint8Array over the same bytes. */
export function toBytes(d: unknown): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (d instanceof DataView) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  throw new MoneroWalletError('unknown', 'Monero wallet returned data of an unexpected shape.');
}

/** Structural view of the monero-ts transaction object, the few getters used. */
export interface TxLike {
  getHash(): string | undefined;
  getHeight?(): number | undefined;
  getBlock?(): { getTimestamp?(): number | undefined } | undefined;
  getReceivedTimestamp?(): number | undefined;
  getNumConfirmations?(): number | undefined;
  getIncomingAmount?(): unknown;
  getOutgoingAmount?(): unknown;
  getIsOutgoing?(): boolean | undefined;
  getFee?(): unknown;
  getIsLocked?(): boolean | undefined;
  getUnlockTime?(): unknown;
  getIncomingTransfers?(): Array<{ getAccountIndex(): number; getSubaddressIndex(): number }> | undefined;
  getOutgoingTransfer?(): { getAccountIndex(): number; getSubaddressIndices?(): number[] | undefined } | undefined;
  getMetadata?(): string | undefined;
  getSize?(): number | undefined;
  getWeight?(): number | undefined;
}

function secondsToMs(s: unknown): number | null {
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null;
}

/** One monero-ts MoneroTxWallet to the plain record the store keeps. */
export function toMoneroTxRecord(tx: TxLike): MoneroTxRecord {
  const height = tx.getHeight?.();
  const outgoing = toPiconero(tx.getOutgoingAmount?.());
  const isOutgoing = tx.getIsOutgoing?.() === true || outgoing > 0n;
  const unlock = tx.getUnlockTime?.();
  const idx = new Map<string, { major: number; minor: number }>();
  for (const t of tx.getIncomingTransfers?.() ?? []) {
    const major = t.getAccountIndex();
    const minor = t.getSubaddressIndex();
    if (Number.isInteger(major) && Number.isInteger(minor)) idx.set(`${major}/${minor}`, { major, minor });
  }
  const out = tx.getOutgoingTransfer?.();
  if (out) {
    const major = out.getAccountIndex();
    for (const minor of out.getSubaddressIndices?.() ?? []) {
      if (Number.isInteger(major) && Number.isInteger(minor)) idx.set(`${major}/${minor}`, { major, minor });
    }
  }
  const unlockNum =
    typeof unlock === 'bigint'
      ? unlock <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(unlock)
        : Number.MAX_SAFE_INTEGER
      : typeof unlock === 'number' && Number.isFinite(unlock)
        ? unlock
        : 0;
  return {
    hash: String(tx.getHash() ?? ''),
    height: typeof height === 'number' && Number.isSafeInteger(height) && height > 0 ? height : null,
    timestamp: secondsToMs(tx.getBlock?.()?.getTimestamp?.()) ?? secondsToMs(tx.getReceivedTimestamp?.()),
    confirmations: Math.max(0, Number(tx.getNumConfirmations?.() ?? 0) || 0),
    incoming: toPiconero(tx.getIncomingAmount?.()),
    outgoing,
    fee: isOutgoing ? toPiconero(tx.getFee?.()) : 0n,
    isLocked: tx.getIsLocked?.() === true,
    unlockTime: unlockNum,
    subaddressIndices: [...idx.values()].sort((a, b) => a.major - b.major || a.minor - b.minor),
  };
}

/** Newest first; pool (unmined) transactions on top. */
export function sortTxRecords(records: MoneroTxRecord[]): MoneroTxRecord[] {
  return [...records].sort((a, b) => {
    if (a.height === null && b.height !== null) return -1;
    if (b.height === null && a.height !== null) return 1;
    if (a.height !== null && b.height !== null && a.height !== b.height) return b.height - a.height;
    return (b.timestamp ?? 0) - (a.timestamp ?? 0) || a.hash.localeCompare(b.hash);
  });
}

/** Is a checkpoint due? Separate so the policy is testable without a wallet. */
export function checkpointDue(
  state: { lastSavedHeight: number; lastSavedAt: number },
  height: number,
  now: number,
): boolean {
  return height - state.lastSavedHeight >= CHECKPOINT_BLOCKS || now - state.lastSavedAt >= CHECKPOINT_MS;
}

/**
 * A wallet2 progress report to the UI's shape, measured over THIS scan:
 * from `scanFrom` (where the sync() call started: the wallet's height, or its
 * restore height on a first scan) to the node's tip. Not monero-ts's own
 * percentDone, which is measured from wallet2's refresh start: on a first
 * scan that is the fast-refresh hash-chain region far below the restore
 * height (measured live: it reads 95 % before the first real block is
 * scanned), and after a checkpoint restart it resets to 0. Percent is 0 to
 * 100, one decimal.
 */
export function toSyncProgress(height: number, scanFrom: number, endHeight: number): MoneroSyncProgress {
  const from = Number.isFinite(scanFrom) ? scanFrom : 0;
  const end = Number.isFinite(endHeight) ? Math.max(endHeight, from) : from;
  const h = Number.isFinite(height) ? Math.min(Math.max(height, from), end) : from;
  const pct = end > from ? ((h - from) / (end - from)) * 100 : 100;
  return { height: h, startHeight: from, endHeight: end, percent: Math.round(pct * 10) / 10 };
}

/** The gateway's origin, which is what monero-ts gets as the daemon URI (its
 *  C++ client drops any path; the worker wrapper puts `/xmr/<set>` back).
 *  The wrapper's prefix is `/xmr/<set>` exactly, so the gateway must be served
 *  at the root of its host; a gateway with a path of its own is refused here
 *  rather than silently routed to the wrong place. */
export function moneroDaemonUri(gatewayUrl: string, nodeSet: string): string {
  const base = new URL(moneroGatewayBase(gatewayUrl, nodeSet));
  if (base.pathname !== `/xmr/${nodeSet}`) {
    throw new MoneroWalletError('unsupported', 'The Monero route needs the gateway at the root of its host.');
  }
  return base.origin;
}

// ---------------------------------------------------------------------------
// The monero-ts surface this module uses (structural, so tests can fake it)
// ---------------------------------------------------------------------------

interface SubaddressLike {
  getAccountIndex(): number;
  getIndex(): number;
  getAddress(): string;
  getLabel(): string | undefined;
  getIsUsed(): boolean | undefined;
}

export interface MoneroWalletLike {
  getPrimaryAddress(): Promise<string>;
  getSubaddresses(accountIdx: number): Promise<SubaddressLike[]>;
  createSubaddress(accountIdx: number, label?: string): Promise<SubaddressLike>;
  sync(listener?: unknown): Promise<unknown>;
  stopSyncing(): Promise<void>;
  /** monero-ts: no account index = the WALLET-WIDE total across every account;
   *  with one, that account only (the balance the send path can spend). */
  getBalance(accountIdx?: number): Promise<unknown>;
  getUnlockedBalance(accountIdx?: number): Promise<unknown>;
  getHeight(): Promise<number>;
  getDaemonHeight(): Promise<number>;
  getTxs(): Promise<TxLike[]>;
  createTx(config: Record<string, unknown>): Promise<TxLike>;
  sweepUnlocked(config: Record<string, unknown>): Promise<TxLike[]>;
  relayTx(metadata: string): Promise<string>;
  getData(): Promise<unknown[]>;
  getPrivateSpendKey(): Promise<string>;
  close(save?: boolean): Promise<void>;
}

type ListenerCtor = new () => {
  onSyncProgress(height: number, startHeight: number, endHeight: number, percentDone: number, message: string): unknown;
};

export interface MoneroLib {
  createWalletFull(config: Record<string, unknown>): Promise<MoneroWalletLike>;
  openWalletFull(config: Record<string, unknown>): Promise<MoneroWalletLike>;
  LibraryUtils: { setWorkerLoader(loader: () => Worker): void; terminateWorker(): Promise<void> };
  MoneroWalletListener: ListenerCtor;
}

let libOverride: (() => Promise<MoneroLib>) | null = null;
let lockOverride: ((name: string) => Promise<(() => void) | null>) | null = null;

/** Tests only: a fake monero-ts, and a fake lock manager. `null` restores. */
export function _setMoneroLibraryForTests(loader: (() => Promise<MoneroLib>) | null): void {
  libOverride = loader;
}
export function _setMoneroLockForTests(acquire: ((name: string) => Promise<(() => void) | null>) | null): void {
  lockOverride = acquire;
}

async function loadMoneroLib(): Promise<MoneroLib> {
  if (libOverride) return libOverride();
  // Dynamic, so the 95 KB entry and its glue load only when a Monero wallet is
  // actually opened, not when the monero barrel is imported for addresses.
  const mod = (await import('monero-ts')) as unknown as { default?: unknown };
  return (mod.default ?? mod) as MoneroLib;
}

/** Hold `monero:<walletId>` for the life of the host. Resolves with a release
 *  function, or null when another page holds it. A browser without the Web
 *  Locks API (none of the three targets, but tests) gets a no-op lock. */
async function acquireWalletLock(name: string): Promise<(() => void) | null> {
  if (lockOverride) return lockOverride(name);
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks?.request) return () => {};
  return new Promise((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        // Held until the returned promise settles, i.e. until release().
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/** The one open host in this page (monero-ts has one worker per page). */
let activeHost: MoneroHostImpl | null = null;

interface HostContext {
  lib: MoneroLib;
  walletId: string;
  net: MoneroNetwork;
  cacheKey: Uint8Array;
  wallet2Password: string;
  daemonUri: string;
  trustedDaemon: boolean;
  restoreHeight: number;
  releaseLock: () => void;
  walletExists?: () => Promise<boolean>;
}

/** How long close() lets the graceful part (stop the scan, final save,
 *  wallet2 close) run before the worker is terminated regardless. Lock and
 *  the idle auto-lock call close(): the keys must leave the WASM heap promptly
 *  even when the gateway has stopped answering mid-request (monero-ts's own
 *  HTTP timeout is 180 s, and a call that never settles would otherwise keep
 *  the worker alive for good). Losing the final checkpoint costs a rescan of
 *  at most CHECKPOINT_BLOCKS, which is the cheaper side of that trade. */
const CLOSE_GRACE_MS = 3000;

/** Resolve after `promise` or after `ms`, whichever is first; the timer is
 *  cleared either way so a fast close leaves nothing pending. */
async function withinGrace(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class MoneroHostImpl implements MoneroWalletHost {
  readonly walletId: string;
  private ctx: HostContext;
  private wallet: MoneroWalletLike;
  private closed = false;
  private closing: Promise<void> | null = null;
  private syncing: Promise<MoneroBalance> | null = null;
  /** Set by the progress listener: this sync call is being stopped so a
   *  checkpoint save can run; the loop resumes after the save. */
  private checkpointStop = false;
  /** Set by stopScan()/close(): the scan is being stopped for good. */
  private haltRequested = false;
  private saveChain: Promise<void> = Promise.resolve();
  private lastSavedHeight = 0;
  private lastSavedAt = 0;
  private drafts = new Map<string, MoneroTxDraft>();

  constructor(ctx: HostContext, wallet: MoneroWalletLike, savedHeight: number) {
    this.ctx = ctx;
    this.walletId = ctx.walletId;
    this.wallet = wallet;
    this.lastSavedHeight = savedHeight;
    this.lastSavedAt = Date.now();
  }

  private assertOpen(): void {
    if (this.closed) throw new MoneroWalletError('closed', 'This Monero wallet is closed.');
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    try {
      return await fn();
    } catch (e) {
      throw classifyMoneroError(e);
    }
  }

  primaryAddress(): Promise<string> {
    return this.call(() => this.wallet.getPrimaryAddress());
  }

  subaddresses(major = 0): Promise<MoneroSubaddress[]> {
    return this.call(async () => {
      const subs = await this.wallet.getSubaddresses(major);
      return subs.map(toSubaddress);
    });
  }

  createSubaddress(major: number, label = ''): Promise<MoneroSubaddress> {
    return this.call(async () => {
      if (!Number.isInteger(major) || major < 0) throw new MoneroWalletError('unsupported', 'Invalid account index.');
      const sub = toSubaddress(await this.wallet.createSubaddress(major, String(label).slice(0, 100)));
      // A new subaddress is wallet state the user will hand out; persist it now
      // rather than at the next checkpoint.
      void this.saveQuietly();
      return sub;
    });
  }

  balance(): Promise<MoneroBalance> {
    return this.call(async () => {
      // ACCOUNT 0 ONLY, the account buildTx and the sweep spend from (v1's
      // "one account, major 0" rule, §4). Asked without an index, wallet2
      // answers the total across EVERY account, and an imported 25-word
      // wallet whose previous owner used several (Feather and Cake expose
      // them; wallet2's lookahead finds their outputs) would then show money
      // on Home and in Send's "Available" that the send path cannot spend.
      const [total, unlocked, height, daemonHeight] = [
        toPiconero(await this.wallet.getBalance(0)),
        toPiconero(await this.wallet.getUnlockedBalance(0)),
        await this.wallet.getHeight(),
        await this.wallet.getDaemonHeight(),
      ];
      return { total, unlocked, height, daemonHeight };
    });
  }

  history(): Promise<MoneroTxRecord[]> {
    return this.call(async () => sortTxRecords((await this.wallet.getTxs()).map(toMoneroTxRecord)));
  }

  sync(onProgress?: (p: MoneroSyncProgress) => void): Promise<MoneroBalance> {
    this.assertOpen();
    // One scan at a time; a second caller shares the first one's result.
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync(onProgress).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(onProgress?: (p: MoneroSyncProgress) => void): Promise<MoneroBalance> {
    let lastEmit = 0;
    // A holder, not a `let`: TypeScript cannot see the callback's assignment
    // and would narrow a plain variable to null at the read below.
    const seen: { last: MoneroSyncProgress | null } = { last: null };
    // Where this scan starts, for the percentage (see toSyncProgress).
    const scanFrom = Math.max(await this.wallet.getHeight().catch(() => 0), this.ctx.restoreHeight);
    // An arrow, so `this` is the host; the listener class below only forwards
    // to it (monero-ts requires an instance of its own listener class).
    // Measured live (2026-09-28, 3,000 blocks through the gateway): wallet2
    // reports progress once per getblocks.bin batch (about 600 blocks), and a
    // stop takes effect one batch after it is asked for, when the worker next
    // yields on HTTP. The checkpoint below therefore lands roughly every
    // 1,000 blocks or 45 s in practice, and the resumed sync continues from
    // where the wallet got to.
    const handle = (height: number, endHeight: number): void => {
      const p = toSyncProgress(height, scanFrom, endHeight);
      seen.last = p;
      const now = Date.now();
      if (onProgress && (now - lastEmit >= PROGRESS_INTERVAL_MS || p.percent >= 100)) {
        lastEmit = now;
        try {
          onProgress(p);
        } catch {
          /* a UI callback must not break the scan */
        }
      }
      // Checkpoint: stop this sync call so the save can run (wallet2 queues
      // every call behind the running sync), then the loop below resumes.
      if (
        !this.checkpointStop &&
        !this.haltRequested &&
        !this.closed &&
        height < endHeight - 1 &&
        checkpointDue({ lastSavedHeight: this.lastSavedHeight, lastSavedAt: this.lastSavedAt }, height, now)
      ) {
        this.checkpointStop = true;
        this.wallet.stopSyncing().catch(() => {});
      }
    };
    const Listener = class extends this.ctx.lib.MoneroWalletListener {
      onSyncProgress(height: number, _startHeight: number, endHeight: number): void {
        handle(height, endHeight);
      }
    };
    const listener = new Listener();
    try {
      let stalls = 0;
      for (;;) {
        this.assertOpen();
        const before = await this.wallet.getHeight();
        this.checkpointStop = false;
        await this.wallet.sync(listener);
        if (this.closed || this.haltRequested) break;
        const after = await this.wallet.getHeight();
        // Ran to the tip: either no checkpoint was asked for, or the stop
        // landed after the last block anyway.
        if (!this.checkpointStop || (seen.last !== null && after >= seen.last.endHeight)) break;
        // Stopped for a checkpoint: save, then continue from `after`.
        await this.saveQuietly();
        // A stop that made no progress twice in a row means the stop flag is
        // not being cleared by the next sync; finish in one call instead of
        // spinning (checkpoints are a convenience, the scan is not).
        stalls = after <= before ? stalls + 1 : 0;
        if (stalls >= 2) {
          this.checkpointStop = false;
          this.haltRequested = true; // no more checkpoint stops in this scan
          await this.wallet.sync(listener);
          break;
        }
      }
      this.checkpointStop = false;
      if (this.closed) throw new MoneroWalletError('closed', 'This Monero wallet was closed during the scan.');
      await this.saveQuietly();
      const bal = await this.balance();
      if (onProgress) {
        const tip = Math.max(bal.daemonHeight, bal.height);
        const done = { height: bal.height, startHeight: seen.last?.startHeight ?? scanFrom, endHeight: tip, percent: 100 };
        try {
          onProgress(done);
        } catch {
          /* ignore */
        }
      }
      return bal;
    } catch (e) {
      throw classifyMoneroError(e);
    } finally {
      this.checkpointStop = false;
      this.haltRequested = false;
    }
  }

  async buildTx(args: {
    to: string;
    amountPico: bigint;
    priority: MoneroPriority;
    sweep?: boolean;
    accountIndex?: number;
  }): Promise<MoneroTxDraft> {
    this.assertOpen();
    const to = typeof args?.to === 'string' ? args.to.trim() : '';
    if (!isValidMoneroAddress(to, this.ctx.net)) {
      throw new MoneroWalletError('invalid-address', 'That is not a valid Monero address for this network.');
    }
    const code = MONERO_PRIORITY_CODE[args.priority];
    if (!code) throw new MoneroWalletError('unsupported', 'Unknown fee priority.');
    const sweep = args.sweep === true;
    const accountIndex = args.accountIndex ?? 0;
    if (!Number.isInteger(accountIndex) || accountIndex < 0) throw new MoneroWalletError('unsupported', 'Invalid account index.');
    if (!sweep && (typeof args.amountPico !== 'bigint' || args.amountPico <= 0n)) {
      throw new MoneroWalletError('invalid-amount', 'Enter an amount greater than zero.');
    }
    return this.call(async () => {
      let tx: TxLike;
      if (sweep) {
        const txs = await this.wallet.sweepUnlocked({ accountIndex, address: to, priority: code, relay: false });
        if (txs.length !== 1) {
          throw new MoneroWalletError(
            'sweep-multiple',
            'Sending everything here needs more than one transaction. Send a smaller amount first.',
          );
        }
        tx = txs[0];
      } else {
        // relay:false: wallet2 builds and signs, nothing leaves the worker.
        tx = await this.wallet.createTx({ accountIndex, address: to, amount: args.amountPico, priority: code, relay: false });
      }
      const fee = toPiconero(tx.getFee?.());
      assertMoneroFeeSane(fee); // refuse, never clamp (fees.ts)
      const metadata = tx.getMetadata?.();
      const hash = tx.getHash();
      if (!metadata || !hash) throw new MoneroWalletError('unknown', 'Monero wallet built a transaction it cannot relay.');
      const amount = sweep ? toPiconero(tx.getOutgoingAmount?.()) : args.amountPico;
      const draft: MoneroTxDraft = {
        metadata,
        hash,
        fee,
        amount,
        sizeBytes: Number(tx.getSize?.() ?? tx.getWeight?.() ?? 0) || 0,
        destination: to,
        sweep,
      };
      this.drafts.set(hash, draft);
      return { ...draft };
    });
  }

  async relay(draft: MoneroTxDraft): Promise<string> {
    this.assertOpen();
    const known = draft && typeof draft.hash === 'string' ? this.drafts.get(draft.hash) : undefined;
    // Only a draft this host built, byte for byte: the review screen showed its
    // fee and amount, and the metadata is what actually gets broadcast.
    if (
      !known ||
      known.metadata !== draft.metadata ||
      known.fee !== draft.fee ||
      known.amount !== draft.amount ||
      known.destination !== draft.destination
    ) {
      throw new MoneroWalletError('draft-unknown', 'This transaction was not prepared here. Review it again.');
    }
    try {
      assertMoneroFeeSane(known.fee);
    } catch (e) {
      throw classifyMoneroError(e);
    }
    const txid = await this.call(() => this.wallet.relayTx(known.metadata));
    this.drafts.delete(known.hash);
    // The outgoing transfer is wallet state now (spent outputs, change).
    void this.saveQuietly();
    return txid || known.hash;
  }

  async setRestoreHeight(height: number): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new MoneroWalletError('unsupported', 'Restore height must be a whole number, zero or more.');
    }
    await this.stopScan();
    await this.call(async () => {
      // wallet2's own setRestoreHeight does not rescan a wallet that already
      // scanned past it. Recreate instead: same keys (read back from the
      // worker, so this module still never held them), new height, no cache.
      const spend = await this.wallet.getPrivateSpendKey();
      await this.wallet.close(false);
      this.drafts.clear();
      await deleteMoneroCache(this.walletId).catch(() => {});
      this.wallet = await this.ctx.lib.createWalletFull({
        networkType: this.ctx.net,
        password: this.ctx.wallet2Password,
        privateSpendKey: spend,
        restoreHeight: height,
        server: { uri: this.ctx.daemonUri },
        isTrustedDaemon: this.ctx.trustedDaemon,
      });
      this.ctx.restoreHeight = height;
      this.lastSavedHeight = height;
      this.lastSavedAt = Date.now();
    });
  }

  save(): Promise<void> {
    this.assertOpen();
    return this.enqueueSave();
  }

  private enqueueSave(): Promise<void> {
    const run = this.saveChain.then(() => this.persist());
    // The chain itself never rejects, so one failed save does not wedge the next.
    this.saveChain = run.catch(() => {});
    return run;
  }

  private async saveQuietly(): Promise<void> {
    try {
      await this.enqueueSave();
    } catch {
      // A failed checkpoint costs a rescan of at most CHECKPOINT_BLOCKS later.
      // Not logged: the error text could name storage internals, never secrets,
      // but there is nothing the user can do about it here either.
    }
  }

  private async persist(): Promise<void> {
    // A wallet another window removed (and whose cache row it deleted) is not
    // written back: the store is asked first, every time, because a checkpoint
    // that lands after the removal would resurrect the whole history under an
    // id no path can delete any more (MoneroOpenArgs.walletExists).
    if (this.ctx.walletExists) {
      let exists = true;
      try {
        exists = await this.ctx.walletExists();
      } catch {
        exists = true; // a store read that failed says nothing about the wallet
      }
      if (!exists) return;
    }
    let data: unknown[];
    try {
      data = await this.wallet.getData();
    } catch (e) {
      throw classifyMoneroError(e);
    }
    const keysData = toBytes(data[0]);
    const cacheData = toBytes(data[1]);
    try {
      const height = await this.wallet.getHeight();
      await saveMoneroCache(this.walletId, this.ctx.cacheKey, {
        v: 1,
        keysData,
        cacheData,
        height,
        restoreHeight: this.ctx.restoreHeight,
        savedAt: Date.now(),
      });
      this.lastSavedHeight = height;
      this.lastSavedAt = Date.now();
    } finally {
      keysData.fill(0);
      cacheData.fill(0);
    }
  }

  /** Stop a running scan and wait for it to return (its error, if any, is the
   *  scan's caller's to see, not ours). */
  private async stopScan(): Promise<void> {
    const running = this.syncing;
    if (!running) return;
    this.haltRequested = true;
    await this.wallet.stopSyncing().catch(() => {});
    await running.catch(() => {});
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try {
        // Mark closed FIRST so the scan loop exits instead of resuming after
        // its stop, then stop it and take a final snapshot. The graceful part
        // is BOUNDED (CLOSE_GRACE_MS): every step below is a worker round
        // trip, and a worker stuck on a gateway request that never answers
        // would otherwise hold the keys until monero-ts's 180 s HTTP timeout,
        // or forever. The terminate in `finally` runs either way.
        this.closed = true;
        this.haltRequested = true;
        const graceful = (async () => {
          const running = this.syncing;
          if (running) {
            await this.wallet.stopSyncing().catch(() => {});
            await running.catch(() => {});
          }
          await this.saveChain;
          await this.persist().catch(() => {});
          await this.wallet.close(false).catch(() => {});
        })();
        await withinGrace(graceful, CLOSE_GRACE_MS);
      } finally {
        this.drafts.clear();
        // The only reliable scrub of the WASM heap (§6.5).
        await this.ctx.lib.LibraryUtils.terminateWorker().catch(() => {});
        this.ctx.cacheKey.fill(0);
        this.ctx.wallet2Password = '';
        this.ctx.releaseLock();
        if (activeHost === this) activeHost = null;
      }
    })();
    return this.closing;
  }
}

function toSubaddress(s: SubaddressLike): MoneroSubaddress {
  return {
    major: s.getAccountIndex(),
    minor: s.getIndex(),
    address: s.getAddress(),
    label: s.getLabel() ?? '',
    used: s.getIsUsed() === true,
  };
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Open (or create) the wallet for `args.walletId` in this page's worker.
 *
 *   1. The cache row, if any, decrypted with the HKDF cacheKey and opened with
 *      openWalletFull({keysData, cacheData}) and wallet2Password: no rescan.
 *      Discarded (and rebuilt) when it does not decrypt, does not open, was
 *      made for a different restore height, or opens to a different address.
 *   2. Otherwise createWalletFull({privateSpendKey, restoreHeight}); the scan
 *      starts from restoreHeight on the first sync().
 * Either way the wallet's primary address must equal the pure-TS derivation
 * (address.ts) or nothing is returned: two implementations disagreeing about
 * the address is the one failure that must never reach a Receive screen.
 *
 * Does not sync: the caller calls sync() and shows progress.
 */
export async function openMoneroWallet(args: MoneroOpenArgs): Promise<MoneroWalletHost> {
  const walletId = args?.walletId;
  if (typeof walletId !== 'string' || !walletId) throw new MoneroWalletError('unsupported', 'Missing wallet id.');
  if (!Number.isSafeInteger(args.restoreHeight) || args.restoreHeight < 0) {
    throw new MoneroWalletError('unsupported', 'Restore height must be a whole number, zero or more.');
  }
  if (!isValidMoneroNodeSet(args.nodeSet)) throw new MoneroWalletError('unsupported', 'Not a valid Monero node set.');
  const net: MoneroNetwork = args.network ?? 'mainnet';
  let daemonUri: string;
  try {
    daemonUri = moneroDaemonUri(args.gatewayUrl, args.nodeSet);
  } catch (e) {
    throw e instanceof MoneroWalletError ? e : new MoneroWalletError('unsupported', capText((e as Error)?.message));
  }

  // One wallet per page: monero-ts shares one worker, and closing a wallet
  // terminates it. Close whatever is open first (it saves on the way out).
  if (activeHost) await activeHost.close();

  const expectedAddress = derivePrimaryAddress(args.keys, net);
  const releaseLock = await acquireWalletLock(`monero:${walletId}`);
  if (!releaseLock) {
    throw new MoneroWalletError('busy', 'This Monero wallet is open in another Satori GO window. Close it there to sync here.');
  }

  const { cacheKey, wallet2Password } = moneroCacheSecrets(args.keys);
  const ctx: HostContext = {
    lib: undefined as unknown as MoneroLib,
    walletId,
    net,
    cacheKey,
    wallet2Password,
    daemonUri,
    trustedDaemon: args.trustedDaemon === true,
    restoreHeight: args.restoreHeight,
    releaseLock,
    walletExists: args.walletExists,
  };
  let lib: MoneroLib | null = null;
  try {
    lib = await loadMoneroLib();
    ctx.lib = lib;
    // The loader runs when monero-ts first needs its worker; the node set and
    // token are bound now, for this wallet.
    const { nodeSet, clientToken } = args;
    lib.LibraryUtils.setWorkerLoader(() => spawnMoneroWorker(nodeSet, clientToken));
    const common = {
      networkType: net,
      password: wallet2Password,
      server: { uri: daemonUri },
      isTrustedDaemon: ctx.trustedDaemon,
    };

    let wallet: MoneroWalletLike | null = null;
    let savedHeight = args.restoreHeight;
    const blob = await loadMoneroCache(walletId, cacheKey).catch(() => null);
    if (blob) {
      try {
        if (blob.restoreHeight === args.restoreHeight) {
          const opened = await lib.openWalletFull({ ...common, keysData: blob.keysData, cacheData: blob.cacheData });
          if ((await opened.getPrimaryAddress()) === expectedAddress) {
            wallet = opened;
            savedHeight = blob.height;
          } else {
            await opened.close(false).catch(() => {});
          }
        }
      } catch {
        wallet = null; // a cache wallet2 will not open is rebuilt, not fatal
      } finally {
        blob.keysData.fill(0);
        blob.cacheData.fill(0);
      }
    }
    if (!wallet) {
      const created = await lib.createWalletFull({
        ...common,
        privateSpendKey: bytesToHex(args.keys.spendSec),
        restoreHeight: args.restoreHeight,
      });
      if ((await created.getPrimaryAddress()) !== expectedAddress) {
        await created.close(false).catch(() => {});
        throw new MoneroWalletError('key-mismatch', 'Monero wallet address check failed. Nothing was opened.');
      }
      wallet = created;
    }
    const host = new MoneroHostImpl(ctx, wallet, savedHeight);
    activeHost = host;
    return host;
  } catch (e) {
    if (lib) await lib.LibraryUtils.terminateWorker().catch(() => {});
    cacheKey.fill(0);
    releaseLock();
    throw classifyMoneroError(e);
  }
}

/** The host open in this page, if any (the store holds it too; this is for
 *  the lock path, which must close it without a store round trip). */
export function activeMoneroHost(): MoneroWalletHost | null {
  return activeHost;
}

/** Close whatever is open in this page. Called on lock. */
export async function closeActiveMoneroHost(): Promise<void> {
  if (activeHost) await activeHost.close();
}
