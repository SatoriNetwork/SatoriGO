// The Monero wallet cache: wallet2's keys file and cache file, persisted so an
// unlock does not rescan (the Monero engine design notes §6.5).
//
// WHAT IS STORED. `wallet.getData()` hands back two blobs: keysData (about
// 1.7 KB, wallet2's own keys file, encrypted by wallet2 under the wallet
// password) and cacheData (about 2.5 MB on a fresh wallet and growing with
// history: the fast-refresh hash chain plus every transfer the scan found).
// cacheData is privacy material even though it cannot spend: it is the whole
// receive and spend history of the wallet.
//
// WHERE. IndexedDB in the extension origin, database `satori-monero`, store
// `walletCache`, key = walletId. NOT chrome.storage.local: 10 MB quota without
// `unlimitedStorage` (a permission the owner has deferred), a JSON-only store
// where base64 would add a third to a blob that is already megabytes, and a
// store the background service worker reads, which must never see anything
// Monero (§9). IndexedDB is per-origin too, but nothing in the background
// opens this database.
//
// HOW IT IS PROTECTED. Two layers, neither of which changes the vault format:
//   1. wallet2's own encryption, keyed by `wallet2Password`, which is derived
//      from the spend key (keys.ts moneroCacheSecrets), not a constant.
//   2. AES-256-GCM over both blobs under `cacheKey`, derived the same way with
//      a different HKDF info string. The same primitive vault.ts uses. The
//      walletId is bound in as additional authenticated data, so a record
//      copied from one wallet's row to another's does not decrypt: the cache
//      of wallet A can never be opened as wallet B even when both keys are
//      available in the same session.
// Deriving the keys rather than storing a random one means the vault needs
// nothing new, a vault-copy sibling entry (§9) works unchanged, and the same
// wallet imported on another machine lands on the same cache key.
//
// WHAT IT IS NOT. Not a source of truth. Losing it costs a rescan from the
// restore height and nothing else; it is not in the encrypted backup file, and
// any failure to read it is treated by the scanner as "no cache". Deleting the
// wallet deletes it (liveWallet.removeWallet calls deleteMoneroCache).
//
// The storage backend is injectable (`_setMoneroCacheIdbFactoryForTests`) so
// the tests drive the real IndexedDB code path against an in-memory factory;
// the repo has no fake-indexeddb dependency and this module does not need one.

/** A decrypted cache entry. `v` is the blob format, not the database version. */
export interface MoneroCacheBlob {
  v: 1;
  keysData: Uint8Array;
  cacheData: Uint8Array;
  /** The wallet's scanned height when the blob was taken. */
  height: number;
  /** The restore height the wallet was created with. A cache whose restore
   *  height differs from the entry's is stale (the user rescanned from another
   *  height) and the scanner discards it. */
  restoreHeight: number;
  /** ms since epoch. */
  savedAt: number;
}

/** Why a cache row could not be used. The scanner treats every one of them as
 *  "no cache" and rebuilds; the codes exist so a test (and a support question)
 *  can tell a wrong key from a damaged row from a browser without IndexedDB. */
export class MoneroCacheError extends Error {
  readonly code: 'unavailable' | 'decrypt' | 'format' | 'key';
  constructor(code: MoneroCacheError['code'], message: string) {
    super(message);
    this.name = 'MoneroCacheError';
    this.code = code;
  }
}

export const MONERO_CACHE_DB = 'satori-monero';
export const MONERO_CACHE_STORE = 'walletCache';
const DB_VERSION = 1;

/** What sits in IndexedDB: only ciphertext and the IV. Nothing about the
 *  wallet (height, address, sizes) is stored in the clear. */
interface StoredCacheRecord {
  v: 1;
  iv: Uint8Array;
  ct: Uint8Array;
}

const IV_LENGTH = 12;
const MAGIC = [0x58, 0x4d, 0x52, 0x43]; // "XMRC"
const AAD_PREFIX = 'satori-go/monero/cache/v1|';

let idbFactoryOverride: IDBFactory | null = null;

/** Tests only: route this module to an in-memory IndexedDB. `null` restores
 *  the global one. */
export function _setMoneroCacheIdbFactoryForTests(factory: IDBFactory | null): void {
  idbFactoryOverride = factory;
}

function idbFactory(): IDBFactory {
  const f = idbFactoryOverride ?? (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!f) throw new MoneroCacheError('unavailable', 'IndexedDB is not available in this context.');
  return f;
}

function assertWalletId(walletId: string): void {
  if (typeof walletId !== 'string' || walletId.length === 0 || walletId.length > 200) {
    throw new MoneroCacheError('format', 'Monero cache: invalid wallet id.');
  }
}

/** One connection per operation. Saves happen every 30 s at most, so the open
 *  cost is noise, and a short-lived connection never blocks a future version
 *  upgrade or a devtools "clear storage". */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = idbFactory().open(MONERO_CACHE_DB, DB_VERSION);
    } catch (e) {
      reject(e instanceof MoneroCacheError ? e : new MoneroCacheError('unavailable', 'IndexedDB could not be opened.'));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MONERO_CACHE_STORE)) db.createObjectStore(MONERO_CACHE_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(new MoneroCacheError('unavailable', 'IndexedDB could not be opened.'));
    req.onblocked = () => reject(new MoneroCacheError('unavailable', 'IndexedDB open was blocked by another page.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(MONERO_CACHE_STORE, mode);
      let result: T | undefined;
      const req = fn(tx.objectStore(MONERO_CACHE_STORE));
      if (req) req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new MoneroCacheError('unavailable', 'IndexedDB transaction failed.'));
      tx.onabort = () => reject(new MoneroCacheError('unavailable', 'IndexedDB transaction was aborted (quota?).'));
    });
  } finally {
    db.close();
  }
}

async function importCacheKey(cacheKey: Uint8Array): Promise<CryptoKey> {
  if (!(cacheKey instanceof Uint8Array) || cacheKey.length !== 32) {
    throw new MoneroCacheError('key', 'Monero cache key must be 32 bytes.');
  }
  // Non-extractable, and imported from a copy the caller still owns: the
  // caller zeroes its cacheKey when the wallet closes (scanner.ts).
  return crypto.subtle.importKey('raw', cacheKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function aadFor(walletId: string): Uint8Array {
  return new TextEncoder().encode(AAD_PREFIX + walletId);
}

/** Plaintext layout: "XMRC" | u32le headerLen | header JSON | keysData | cacheData. */
function serialize(blob: MoneroCacheBlob): Uint8Array {
  const header = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      height: blob.height,
      restoreHeight: blob.restoreHeight,
      savedAt: blob.savedAt,
      keysLen: blob.keysData.length,
      cacheLen: blob.cacheData.length,
    }),
  );
  const out = new Uint8Array(8 + header.length + blob.keysData.length + blob.cacheData.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  out.set(blob.keysData, 8 + header.length);
  out.set(blob.cacheData, 8 + header.length + blob.keysData.length);
  return out;
}

function isHeight(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function deserialize(plain: Uint8Array): MoneroCacheBlob {
  const bad = () => new MoneroCacheError('format', 'Monero cache row is damaged.');
  if (plain.length < 8 || MAGIC.some((b, i) => plain[i] !== b)) throw bad();
  const headerLen = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(4, true);
  if (8 + headerLen > plain.length) throw bad();
  let h: Record<string, unknown>;
  try {
    h = JSON.parse(new TextDecoder().decode(plain.subarray(8, 8 + headerLen))) as Record<string, unknown>;
  } catch {
    throw bad();
  }
  const { keysLen, cacheLen } = h;
  if (h.v !== 1 || !isHeight(h.height) || !isHeight(h.restoreHeight) || !isHeight(h.savedAt)) throw bad();
  if (!isHeight(keysLen) || !isHeight(cacheLen)) throw bad();
  const start = 8 + headerLen;
  if (start + keysLen + cacheLen !== plain.length) throw bad();
  // Copies (slice), so the caller may zero `plain` without touching the result.
  return {
    v: 1,
    keysData: plain.slice(start, start + keysLen),
    cacheData: plain.slice(start + keysLen, start + keysLen + cacheLen),
    height: h.height,
    restoreHeight: h.restoreHeight,
    savedAt: h.savedAt,
  };
}

/** Encrypt and write. Overwrites any existing row for `walletId`. */
export async function saveMoneroCache(walletId: string, cacheKey: Uint8Array, blob: MoneroCacheBlob): Promise<void> {
  assertWalletId(walletId);
  if (
    blob?.v !== 1 ||
    !(blob.keysData instanceof Uint8Array) ||
    !(blob.cacheData instanceof Uint8Array) ||
    !isHeight(blob.height) ||
    !isHeight(blob.restoreHeight) ||
    !isHeight(blob.savedAt)
  ) {
    throw new MoneroCacheError('format', 'Monero cache: refusing to save a malformed blob.');
  }
  const key = await importCacheKey(cacheKey);
  const plain = serialize(blob);
  try {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadFor(walletId) }, key, plain),
    );
    const record: StoredCacheRecord = { v: 1, iv, ct };
    await withStore('readwrite', (store) => store.put(record, walletId));
  } finally {
    plain.fill(0);
  }
}

/** Read and decrypt. `null` when there is no row. Throws MoneroCacheError on a
 *  wrong key, a damaged row, or no IndexedDB; the scanner reads every throw as
 *  "no cache" and rebuilds from the restore height. */
export async function loadMoneroCache(walletId: string, cacheKey: Uint8Array): Promise<MoneroCacheBlob | null> {
  assertWalletId(walletId);
  const key = await importCacheKey(cacheKey);
  const raw = (await withStore<unknown>('readonly', (store) => store.get(walletId))) as StoredCacheRecord | undefined;
  if (raw === undefined || raw === null) return null;
  if (
    typeof raw !== 'object' ||
    raw.v !== 1 ||
    !(raw.iv instanceof Uint8Array) ||
    raw.iv.length !== IV_LENGTH ||
    !(raw.ct instanceof Uint8Array)
  ) {
    throw new MoneroCacheError('format', 'Monero cache row is damaged.');
  }
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.iv, additionalData: aadFor(walletId) }, key, raw.ct),
    );
  } catch {
    // GCM authentication failed: a different key (another wallet's, or a
    // derivation change), a row moved between wallet ids, or tampering.
    throw new MoneroCacheError('decrypt', 'Monero cache could not be decrypted with this wallet key.');
  }
  try {
    return deserialize(plain);
  } finally {
    plain.fill(0);
  }
}

/** Remove the row. Idempotent: deleting a wallet that never synced is fine.
 *  In a context with no IndexedDB at all (a unit test, a background context)
 *  there can be no row, so it resolves rather than making every
 *  removeWallet() caller special-case the environment; any other failure
 *  (a transaction error) still throws. */
export async function deleteMoneroCache(walletId: string): Promise<void> {
  assertWalletId(walletId);
  if (!idbFactoryOverride && typeof indexedDB === 'undefined') return;
  await withStore('readwrite', (store) => store.delete(walletId));
}

/** Drop the WHOLE database: every wallet's row, whatever its id. For "reset
 *  wallet" (liveWallet.reset), which removes every wallet record at once and
 *  would otherwise leave an encrypted history row per Monero wallet id ever
 *  synced on the device, with the ids that could name them gone for good.
 *  Same environment rule as deleteMoneroCache: no IndexedDB, nothing to do.
 *  A delete that another page's open connection blocks still completes once
 *  that connection closes (the store closes its connection after every
 *  operation, and `onversionchange` closes a lingering one), so `blocked` is
 *  waited through rather than treated as failure. */
export async function deleteAllMoneroCaches(): Promise<void> {
  if (!idbFactoryOverride && typeof indexedDB === 'undefined') return;
  const factory = idbFactory();
  await new Promise<void>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.deleteDatabase(MONERO_CACHE_DB);
    } catch {
      reject(new MoneroCacheError('unavailable', 'IndexedDB could not be opened.'));
      return;
    }
    req.onsuccess = () => resolve();
    req.onerror = () => reject(new MoneroCacheError('unavailable', 'IndexedDB database could not be deleted.'));
  });
}
