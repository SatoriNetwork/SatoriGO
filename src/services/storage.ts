// Storage abstraction. React components never touch chrome.storage directly —
// they go through stores/services which use this adapter. In the extension the
// backing store is chrome.storage.local; in a plain browser tab (npm run dev /
// preview) it falls back to localStorage, and to memory as a last resort.

export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /** Removes every key under the storage namespace (see NS). */
  clearNamespace(): Promise<void>;
}

// HISTORICAL PREFIX — FROZEN FOREVER. Every existing install's encrypted vault
// and settings live under keys prefixed with 'evrdemo:'. It dates to the demo
// era, but it MUST NOT be renamed: changing it orphans every existing vault
// (users would silently lose access to their wallet on upgrade).
const NS = 'evrdemo:';

// SECURITY: keys holding the encrypted vault (current + legacy). In the real
// extension these live in chrome.storage.local, which is not readable by page
// script and is not plain page localStorage. In `npm run dev` / preview (a
// plain browser tab), getStorage() falls back to LocalStorageAdapter — and
// page localStorage is readable by ANY script on the origin and persists to
// disk unencrypted-at-rest (the value itself is AES-GCM ciphertext, but a
// passwordless wallet's ciphertext is trivially decryptable, see
// LiveOnboarding's passwordless warning). So LocalStorageAdapter must never
// let these keys touch window.localStorage — it holds them in an in-memory
// overlay instead. Dev/preview sessions lose the vault on reload, same as
// MemoryStorageAdapter; that's an acceptable dev-only trade-off.
const SENSITIVE_KEYS = new Set(['liveWallets', 'liveWallet']);

function hasChromeStorage(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.storage?.local;
  } catch {
    return false;
  }
}

class ChromeStorageAdapter implements KeyValueStorage {
  async get<T>(key: string): Promise<T | undefined> {
    const full = NS + key;
    const result = await chrome.storage.local.get(full);
    return result[full] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await chrome.storage.local.set({ [NS + key]: value });
  }

  async remove(key: string): Promise<void> {
    await chrome.storage.local.remove(NS + key);
  }

  async keys(): Promise<string[]> {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(NS))
      .map((k) => k.slice(NS.length));
  }

  async clearNamespace(): Promise<void> {
    const all = await chrome.storage.local.get(null);
    const toRemove = Object.keys(all).filter((k) => k.startsWith(NS));
    if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
  }
}

export class LocalStorageAdapter implements KeyValueStorage {
  // In-memory overlay for SENSITIVE_KEYS — never written to window.localStorage.
  // structuredClone mirrors the serialization boundary real storage would impose.
  private overlay = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    if (SENSITIVE_KEYS.has(key)) {
      return this.overlay.has(key) ? (structuredClone(this.overlay.get(key)) as T) : undefined;
    }
    const raw = localStorage.getItem(NS + key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (SENSITIVE_KEYS.has(key)) {
      this.overlay.set(key, structuredClone(value));
      return;
    }
    localStorage.setItem(NS + key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    if (SENSITIVE_KEYS.has(key)) {
      this.overlay.delete(key);
      return;
    }
    localStorage.removeItem(NS + key);
  }

  async keys(): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) out.push(k.slice(NS.length));
    }
    for (const k of this.overlay.keys()) {
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }

  async clearNamespace(): Promise<void> {
    const ks = await this.keys();
    ks.forEach((k) => localStorage.removeItem(NS + k));
    this.overlay.clear();
  }
}

export class MemoryStorageAdapter implements KeyValueStorage {
  private map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    // structuredClone mirrors the serialization boundary of real storage
    this.map.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }

  async clearNamespace(): Promise<void> {
    this.map.clear();
  }
}

let instance: KeyValueStorage | null = null;

export function getStorage(): KeyValueStorage {
  if (!instance) {
    if (hasChromeStorage()) instance = new ChromeStorageAdapter();
    else if (typeof localStorage !== 'undefined') instance = new LocalStorageAdapter();
    else instance = new MemoryStorageAdapter();
  }
  return instance;
}

export function setStorageForTests(storage: KeyValueStorage): void {
  instance = storage;
}
