import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MONERO_CACHE_DB,
  MONERO_CACHE_STORE,
  MoneroCacheError,
  _setMoneroCacheIdbFactoryForTests,
  deleteAllMoneroCaches,
  deleteMoneroCache,
  loadMoneroCache,
  saveMoneroCache,
  type MoneroCacheBlob,
} from './cache';
import { createMemoryIdb, type MemoryIdb } from './testing/memoryIdb';

function key(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function blob(overrides: Partial<MoneroCacheBlob> = {}): MoneroCacheBlob {
  const keysData = new Uint8Array(1700);
  const cacheData = new Uint8Array(40_000);
  for (let i = 0; i < keysData.length; i++) keysData[i] = (i * 7) & 0xff;
  for (let i = 0; i < cacheData.length; i++) cacheData[i] = (i * 13 + 5) & 0xff;
  return { v: 1, keysData, cacheData, height: 3772500, restoreHeight: 3772358, savedAt: 1_790_000_000_000, ...overrides };
}

let idb: MemoryIdb;
beforeEach(() => {
  idb = createMemoryIdb();
  _setMoneroCacheIdbFactoryForTests(idb.factory);
});
afterEach(() => _setMoneroCacheIdbFactoryForTests(null));

describe('monero cache (IndexedDB, AES-GCM)', () => {
  it('round-trips a blob byte for byte', async () => {
    const b = blob();
    await saveMoneroCache('w1', key(1), b);
    const got = await loadMoneroCache('w1', key(1));
    expect(got).not.toBeNull();
    expect(got!.v).toBe(1);
    expect(got!.height).toBe(b.height);
    expect(got!.restoreHeight).toBe(b.restoreHeight);
    expect(got!.savedAt).toBe(b.savedAt);
    expect(Buffer.from(got!.keysData).equals(Buffer.from(b.keysData))).toBe(true);
    expect(Buffer.from(got!.cacheData).equals(Buffer.from(b.cacheData))).toBe(true);
  });

  it('round-trips empty blobs', async () => {
    await saveMoneroCache('w1', key(1), blob({ keysData: new Uint8Array(0), cacheData: new Uint8Array(0) }));
    const got = await loadMoneroCache('w1', key(1));
    expect(got!.keysData.length).toBe(0);
    expect(got!.cacheData.length).toBe(0);
  });

  it('returns null when there is no row', async () => {
    expect(await loadMoneroCache('nothing-here', key(1))).toBeNull();
  });

  it('stores only ciphertext: no plaintext bytes, height or sizes in the row', async () => {
    const b = blob();
    await saveMoneroCache('w1', key(1), b);
    const rows = idb.dump(MONERO_CACHE_DB, MONERO_CACHE_STORE);
    expect([...rows.keys()]).toEqual(['w1']);
    const row = rows.get('w1') as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['ct', 'iv', 'v']);
    expect((row.iv as Uint8Array).length).toBe(12);
    const ct = Buffer.from(row.ct as Uint8Array);
    // A 64-byte run of the cacheData plaintext must not appear in the row.
    expect(ct.includes(Buffer.from(b.cacheData.subarray(1000, 1064)))).toBe(false);
    expect(ct.includes(Buffer.from('3772500'))).toBe(false);
    // Serialized header + blobs + 16-byte GCM tag.
    expect(ct.length).toBeGreaterThan(b.keysData.length + b.cacheData.length + 16);
  });

  it('uses a fresh IV for every save', async () => {
    await saveMoneroCache('w1', key(1), blob());
    const iv1 = Buffer.from((idb.dump(MONERO_CACHE_DB, MONERO_CACHE_STORE).get('w1') as { iv: Uint8Array }).iv);
    await saveMoneroCache('w1', key(1), blob());
    const iv2 = Buffer.from((idb.dump(MONERO_CACHE_DB, MONERO_CACHE_STORE).get('w1') as { iv: Uint8Array }).iv);
    expect(iv1.equals(iv2)).toBe(false);
  });

  it('a wrong key fails with code "decrypt"', async () => {
    await saveMoneroCache('w1', key(1), blob());
    await expect(loadMoneroCache('w1', key(2))).rejects.toMatchObject({ name: 'MoneroCacheError', code: 'decrypt' });
  });

  it('binds the wallet id: a row moved to another id does not decrypt, even with the right key', async () => {
    await saveMoneroCache('w1', key(1), blob());
    const row = idb.dump(MONERO_CACHE_DB, MONERO_CACHE_STORE).get('w1');
    idb.poke(MONERO_CACHE_DB, MONERO_CACHE_STORE, 'w2', row);
    await expect(loadMoneroCache('w2', key(1))).rejects.toMatchObject({ code: 'decrypt' });
    // The original is untouched.
    expect(await loadMoneroCache('w1', key(1))).not.toBeNull();
  });

  it('a tampered ciphertext fails with code "decrypt"', async () => {
    await saveMoneroCache('w1', key(1), blob());
    const row = idb.dump(MONERO_CACHE_DB, MONERO_CACHE_STORE).get('w1') as { v: 1; iv: Uint8Array; ct: Uint8Array };
    row.ct[100] ^= 0x01;
    idb.poke(MONERO_CACHE_DB, MONERO_CACHE_STORE, 'w1', row);
    await expect(loadMoneroCache('w1', key(1))).rejects.toMatchObject({ code: 'decrypt' });
  });

  it('a row of the wrong shape fails with code "format"', async () => {
    await saveMoneroCache('w1', key(1), blob());
    idb.poke(MONERO_CACHE_DB, MONERO_CACHE_STORE, 'w1', { v: 2, iv: new Uint8Array(12), ct: new Uint8Array(40) });
    await expect(loadMoneroCache('w1', key(1))).rejects.toMatchObject({ code: 'format' });
    idb.poke(MONERO_CACHE_DB, MONERO_CACHE_STORE, 'w1', 'a string');
    await expect(loadMoneroCache('w1', key(1))).rejects.toBeInstanceOf(MoneroCacheError);
  });

  it('deleteMoneroCache removes the row and is idempotent', async () => {
    await saveMoneroCache('w1', key(1), blob());
    await saveMoneroCache('w2', key(2), blob());
    await deleteMoneroCache('w1');
    expect(await loadMoneroCache('w1', key(1))).toBeNull();
    expect(await loadMoneroCache('w2', key(2))).not.toBeNull();
    await expect(deleteMoneroCache('w1')).resolves.toBeUndefined();
    expect([...idb.dump(MONERO_CACHE_DB, MONERO_CACHE_STORE).keys()]).toEqual(['w2']);
  });

  it('deleteAllMoneroCaches drops every row at once (reset wallet), and the store works again afterwards', async () => {
    await saveMoneroCache('w1', key(1), blob());
    await saveMoneroCache('w2', key(2), blob());
    await deleteAllMoneroCaches();
    expect([...idb.dump(MONERO_CACHE_DB, MONERO_CACHE_STORE).keys()]).toEqual([]);
    expect(await loadMoneroCache('w1', key(1))).toBeNull();
    expect(await loadMoneroCache('w2', key(2))).toBeNull();
    await saveMoneroCache('w3', key(3), blob());
    expect(await loadMoneroCache('w3', key(3))).not.toBeNull();
    await expect(deleteAllMoneroCaches()).resolves.toBeUndefined(); // idempotent
  });

  it('a save overwrites the previous row for the same wallet', async () => {
    await saveMoneroCache('w1', key(1), blob({ height: 10 }));
    await saveMoneroCache('w1', key(1), blob({ height: 20 }));
    expect((await loadMoneroCache('w1', key(1)))!.height).toBe(20);
  });

  it('refuses a key that is not 32 bytes, and a malformed blob, before touching storage', async () => {
    await expect(saveMoneroCache('w1', new Uint8Array(16), blob())).rejects.toMatchObject({ code: 'key' });
    await expect(loadMoneroCache('w1', new Uint8Array(31))).rejects.toMatchObject({ code: 'key' });
    await expect(saveMoneroCache('w1', key(1), blob({ height: -1 }))).rejects.toMatchObject({ code: 'format' });
    await expect(saveMoneroCache('w1', key(1), { ...blob(), v: 2 } as unknown as MoneroCacheBlob)).rejects.toMatchObject({
      code: 'format',
    });
    await expect(saveMoneroCache('', key(1), blob())).rejects.toMatchObject({ code: 'format' });
    expect(idb.opens).toBe(0);
  });

  it('does not zero or alias the caller\'s blob and key', async () => {
    const b = blob();
    const k = key(9);
    const before = Buffer.from(b.cacheData);
    await saveMoneroCache('w1', k, b);
    expect(Buffer.from(b.cacheData).equals(before)).toBe(true);
    expect(k.every((x) => x === 9)).toBe(true);
    const got = await loadMoneroCache('w1', k);
    got!.cacheData.fill(0); // the scanner zeroes what it loaded
    const again = await loadMoneroCache('w1', k);
    expect(Buffer.from(again!.cacheData).equals(before)).toBe(true);
  });

  it('a failed write (quota) rejects with code "unavailable" and leaves the old row', async () => {
    await saveMoneroCache('w1', key(1), blob({ height: 10 }));
    idb.options.failNextPut = true;
    await expect(saveMoneroCache('w1', key(1), blob({ height: 20 }))).rejects.toMatchObject({ code: 'unavailable' });
    expect((await loadMoneroCache('w1', key(1)))!.height).toBe(10);
  });

  it('without IndexedDB: load/save reject with "unavailable", delete resolves', async () => {
    _setMoneroCacheIdbFactoryForTests(null);
    expect(typeof indexedDB).toBe('undefined');
    await expect(loadMoneroCache('w1', key(1))).rejects.toMatchObject({ code: 'unavailable' });
    await expect(saveMoneroCache('w1', key(1), blob())).rejects.toMatchObject({ code: 'unavailable' });
    await expect(deleteMoneroCache('w1')).resolves.toBeUndefined();
    await expect(deleteAllMoneroCaches()).resolves.toBeUndefined();
  });
});
