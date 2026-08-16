// Storage diagnostics for the expert Settings view.
//
// WHY THIS EXISTS: chrome.storage.local caps the WHOLE extension namespace at
// QUOTA_BYTES (10 MB unless `unlimitedStorage` is granted), shared by the
// encrypted vaults, settings AND the per-address transaction cache. The tx cache
// is the only part that grows without bound, and a write that exceeds the quota
// is swallowed, so the cache silently freezes and never recovers. There was no
// way to see any of that from inside the wallet. Now there is.
//
// The summary is a PURE function of a plain record so it can be unit-tested
// without a browser; only `readStorageStats` touches chrome.

import { getStorage } from './storage';

/** Same namespace prefix storage.ts writes under (frozen, see its comment). */
const NS = 'evrdemo:';

/** Conservative default when the runtime does not expose QUOTA_BYTES: the
 *  documented chrome.storage.local limit without `unlimitedStorage`. */
export const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024;

export type StorageCategoryId = 'txcache' | 'wallets' | 'settings';

export interface StorageCategory {
  id: StorageCategoryId;
  label: string;
  bytes: number;
  entries: number;
}

export interface StorageEntrySize {
  /** Key WITHOUT the storage namespace prefix. */
  key: string;
  bytes: number;
}

export interface StorageStats {
  usedBytes: number;
  quotaBytes: number;
  /** 0-100, clamped. Not rounded: the UI decides its own precision. */
  percentUsed: number;
  entryCount: number;
  categories: StorageCategory[];
  /** Biggest entries first. Useful because one runaway address cache is the
   *  realistic way this quota gets exhausted. */
  largest: StorageEntrySize[];
  /** True when the used bytes came from the runtime rather than from summing
   *  serialized values, so the UI can say which number it is showing. */
  measured: boolean;
}

/** Which bucket a storage key belongs to. The tx cache is called out on its own
 *  because it is the only unbounded one. */
export function categoriseKey(key: string): StorageCategoryId {
  if (key.startsWith('txcache:')) return 'txcache';
  if (key === 'liveWallets' || key === 'liveWallet') return 'wallets';
  return 'settings';
}

const CATEGORY_LABELS: Record<StorageCategoryId, string> = {
  txcache: 'Transaction history cache',
  wallets: 'Wallets and vaults',
  settings: 'Settings and other',
};

/** Serialized size of one stored value, in bytes. JSON is what chrome.storage
 *  persists, and UTF-8 is what it counts, so measure both rather than using
 *  string length (which would undercount any non-ASCII content). */
export function entryBytes(value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    return 0; // unserializable values are not what chrome stored anyway
  }
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
  return json.length;
}

/**
 * Summarise a namespace's entries. `entries` is keyed WITHOUT the namespace
 * prefix. `usedBytes` may be passed when the runtime can report it exactly
 * (chrome.storage.local.getBytesInUse); otherwise the serialized total is used
 * and `measured` is false.
 */
export function summariseStorage(
  entries: Record<string, unknown>,
  quotaBytes: number = DEFAULT_QUOTA_BYTES,
  usedBytes?: number,
  topN = 5,
): StorageStats {
  const byCategory = new Map<StorageCategoryId, { bytes: number; entries: number }>();
  const sizes: StorageEntrySize[] = [];
  let serializedTotal = 0;

  for (const [key, value] of Object.entries(entries)) {
    const bytes = entryBytes(value);
    serializedTotal += bytes;
    sizes.push({ key, bytes });
    const id = categoriseKey(key);
    const acc = byCategory.get(id) ?? { bytes: 0, entries: 0 };
    acc.bytes += bytes;
    acc.entries += 1;
    byCategory.set(id, acc);
  }

  const categories: StorageCategory[] = (['txcache', 'wallets', 'settings'] as const)
    .map((id) => ({
      id,
      label: CATEGORY_LABELS[id],
      bytes: byCategory.get(id)?.bytes ?? 0,
      entries: byCategory.get(id)?.entries ?? 0,
    }))
    // Keep every bucket even at zero: "0 entries" is information here, and a
    // disappearing row makes the view look like it failed to load.
    .sort((a, b) => b.bytes - a.bytes);

  const used = usedBytes ?? serializedTotal;
  const quota = quotaBytes > 0 ? quotaBytes : DEFAULT_QUOTA_BYTES;
  const percentUsed = Math.min(100, Math.max(0, (used / quota) * 100));

  return {
    usedBytes: used,
    quotaBytes: quota,
    percentUsed,
    entryCount: sizes.length,
    categories,
    largest: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, topN),
    measured: usedBytes != null,
  };
}

interface ChromeLocalLike {
  get(keys: null): Promise<Record<string, unknown>>;
  getBytesInUse?(keys: null): Promise<number>;
  QUOTA_BYTES?: number;
}

function chromeLocal(): ChromeLocalLike | null {
  try {
    const c = (globalThis as { chrome?: { storage?: { local?: ChromeLocalLike } } }).chrome;
    return c?.storage?.local ?? null;
  } catch {
    return null;
  }
}

/**
 * Read current storage usage. Prefers the runtime's own byte accounting (which
 * includes chrome's per-entry overhead, so it is the number the quota is
 * actually checked against); falls back to summing serialized values when that
 * is unavailable, e.g. in a plain tab or a test.
 */
export async function readStorageStats(topN = 5): Promise<StorageStats> {
  const local = chromeLocal();
  if (local) {
    const all = await local.get(null);
    const scoped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(NS)) scoped[k.slice(NS.length)] = v;
    }
    let used: number | undefined;
    try {
      used = await local.getBytesInUse?.(null);
    } catch {
      used = undefined; // permission or API shape differs; fall back to the sum
    }
    return summariseStorage(scoped, local.QUOTA_BYTES ?? DEFAULT_QUOTA_BYTES, used, topN);
  }

  // No chrome runtime: read what the active adapter can see.
  const store = getStorage();
  const keys = await store.keys();
  const scoped: Record<string, unknown> = {};
  for (const k of keys) scoped[k] = await store.get(k);
  return summariseStorage(scoped, DEFAULT_QUOTA_BYTES, undefined, topN);
}

/** Human byte size, e.g. "1.4 MB" / "812 KB" / "0 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
