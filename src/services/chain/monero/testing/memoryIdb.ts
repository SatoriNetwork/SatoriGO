// TEST ONLY. A minimal in-memory IndexedDB (IDBFactory) for cache.ts and the
// scanner tests, because the repo has no fake-indexeddb dependency and adding
// one is not this set's call. It implements exactly the surface cache.ts uses:
// open() with onupgradeneeded/onsuccess, objectStoreNames.contains,
// createObjectStore, one-store transactions with get/put/delete, and
// oncomplete/onabort. Values are structuredClone'd on the way in and out, as a
// real IndexedDB does, so a test cannot pass by sharing a reference.
//
// Not imported by any shipped module (the vite build never sees it).

type Listener = (() => void) | null;

class Req<T> {
  result: T | undefined = undefined;
  error: Error | null = null;
  onsuccess: Listener = null;
  onerror: Listener = null;
  onupgradeneeded: Listener = null;
  onblocked: Listener = null;
}

export interface MemoryIdbOptions {
  /** Make the next put() abort its transaction (a quota error, say). */
  failNextPut?: boolean;
}

export interface MemoryIdb {
  factory: IDBFactory;
  /** Raw stored values, by database then store then key (clones). */
  dump(db: string, store: string): Map<string, unknown>;
  /** Replace a raw stored value (to simulate tampering or a moved row). */
  poke(db: string, store: string, key: string, value: unknown): void;
  options: MemoryIdbOptions;
  opens: number;
}

export function createMemoryIdb(): MemoryIdb {
  const dbs = new Map<string, { version: number; stores: Map<string, Map<string, unknown>> }>();
  const options: MemoryIdbOptions = {};
  const mem: MemoryIdb = {
    factory: undefined as unknown as IDBFactory,
    dump(db, store) {
      const m = dbs.get(db)?.stores.get(store) ?? new Map();
      return new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
    },
    poke(db, store, key, value) {
      const m = dbs.get(db)?.stores.get(store);
      if (!m) throw new Error('no such store');
      m.set(key, structuredClone(value));
    },
    options,
    opens: 0,
  };

  function makeDb(name: string) {
    const rec = dbs.get(name)!;
    let closed = false;
    const db = {
      name,
      get version() {
        return rec.version;
      },
      objectStoreNames: {
        contains: (s: string) => rec.stores.has(s),
      },
      onversionchange: null as Listener,
      createObjectStore(s: string) {
        if (!rec.stores.has(s)) rec.stores.set(s, new Map());
        return {};
      },
      close() {
        closed = true;
      },
      transaction(storeName: string, _mode: string) {
        if (closed) throw new Error('InvalidStateError: database closed');
        const store = rec.stores.get(storeName);
        if (!store) throw new Error(`NotFoundError: no store ${storeName}`);
        let pending = 0;
        let aborted = false;
        const tx = {
          oncomplete: null as Listener,
          onerror: null as Listener,
          onabort: null as Listener,
          objectStore() {
            const run = <T>(fn: () => T, fail = false): Req<T> => {
              const req = new Req<T>();
              pending++;
              setTimeout(() => {
                if (fail) {
                  aborted = true;
                  req.error = new Error('QuotaExceededError');
                  req.onerror?.();
                  tx.onabort?.();
                  return;
                }
                req.result = fn();
                req.onsuccess?.();
                pending--;
                if (pending === 0 && !aborted) setTimeout(() => tx.oncomplete?.(), 0);
              }, 0);
              return req;
            };
            return {
              get: (key: string) => run(() => (store.has(key) ? structuredClone(store.get(key)) : undefined)),
              put: (value: unknown, key: string) => {
                const fail = options.failNextPut === true;
                options.failNextPut = false;
                return run(() => {
                  store.set(key, structuredClone(value));
                  return key;
                }, fail);
              },
              delete: (key: string) =>
                run(() => {
                  store.delete(key);
                  return undefined;
                }),
            };
          },
        };
        return tx;
      },
    };
    return db;
  }

  const factory = {
    open(name: string, version = 1) {
      mem.opens++;
      const req = new Req<unknown>();
      setTimeout(() => {
        let rec = dbs.get(name);
        const upgrade = !rec || rec.version < version;
        if (!rec) {
          rec = { version, stores: new Map() };
          dbs.set(name, rec);
        }
        rec.version = Math.max(rec.version, version);
        req.result = makeDb(name);
        if (upgrade) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
    deleteDatabase(name: string) {
      const req = new Req<undefined>();
      setTimeout(() => {
        dbs.delete(name);
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  mem.factory = factory as unknown as IDBFactory;
  return mem;
}
