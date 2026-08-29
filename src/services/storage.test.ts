// @vitest-environment jsdom
// This suite needs `window.localStorage` — the project's default vitest
// environment is 'node', so this file opts into jsdom on its own (see
// clipboard.test.ts for the same pattern).
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageAdapter, MemoryStorageAdapter } from './storage';

describe('LocalStorageAdapter — sensitive-key overlay', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('a sensitive key (liveWallets) set via the adapter is retrievable through it', async () => {
    const storage = new LocalStorageAdapter();
    const vault = { wallets: [{ id: 'w1', vault: 'ciphertext-blob' }] };
    await storage.set('liveWallets', vault);

    await expect(storage.get('liveWallets')).resolves.toEqual(vault);
  });

  it('a sensitive key (liveWallets) never appears in window.localStorage', async () => {
    const storage = new LocalStorageAdapter();
    await storage.set('liveWallets', { wallets: ['secret-data'] });

    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      expect(k).not.toContain('liveWallets');
    }
    expect(window.localStorage.getItem('evrdemo:liveWallets')).toBeNull();
  });

  it('the legacy sensitive key (liveWallet) is also kept out of window.localStorage', async () => {
    const storage = new LocalStorageAdapter();
    await storage.set('liveWallet', { legacy: true });

    await expect(storage.get('liveWallet')).resolves.toEqual({ legacy: true });
    expect(window.localStorage.getItem('evrdemo:liveWallet')).toBeNull();
  });

  it('non-sensitive keys still hit window.localStorage, namespaced', async () => {
    const storage = new LocalStorageAdapter();
    await storage.set('theme', 'dark');

    await expect(storage.get('theme')).resolves.toBe('dark');
    expect(window.localStorage.getItem('evrdemo:theme')).toBe(JSON.stringify('dark'));
  });

  it('remove() deletes a sensitive key from the overlay', async () => {
    const storage = new LocalStorageAdapter();
    await storage.set('liveWallets', { wallets: [] });
    await storage.remove('liveWallets');

    await expect(storage.get('liveWallets')).resolves.toBeUndefined();
  });

  it('remove() deletes a non-sensitive key from window.localStorage', async () => {
    const storage = new LocalStorageAdapter();
    await storage.set('theme', 'light');
    await storage.remove('theme');

    await expect(storage.get('theme')).resolves.toBeUndefined();
    expect(window.localStorage.getItem('evrdemo:theme')).toBeNull();
  });

  it('keys() includes both overlay (sensitive) and localStorage (non-sensitive) keys', async () => {
    const storage = new LocalStorageAdapter();
    await storage.set('liveWallets', { wallets: [] });
    await storage.set('theme', 'dark');
    await storage.set('autoLockMinutes', 5);

    const ks = (await storage.keys()).sort();
    expect(ks).toEqual(['autoLockMinutes', 'liveWallets', 'theme'].sort());
  });

  it('clearNamespace() clears both the overlay and window.localStorage', async () => {
    const storage = new LocalStorageAdapter();
    await storage.set('liveWallets', { wallets: ['secret'] });
    await storage.set('theme', 'dark');

    await storage.clearNamespace();

    await expect(storage.get('liveWallets')).resolves.toBeUndefined();
    await expect(storage.get('theme')).resolves.toBeUndefined();
    expect(await storage.keys()).toEqual([]);
    expect(window.localStorage.length).toBe(0);
  });

  it('overlay values are cloned, not aliased, across get() calls', async () => {
    const storage = new LocalStorageAdapter();
    const original = { wallets: [{ id: 'w1' }] };
    await storage.set('liveWallets', original);

    const first = await storage.get<typeof original>('liveWallets');
    first!.wallets.push({ id: 'w2' });

    const second = await storage.get<typeof original>('liveWallets');
    expect(second!.wallets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The MEMORY adapter is the double every service-level test runs against, so
// its fidelity to the two real ones decides what those tests can see.
// ---------------------------------------------------------------------------

describe('MemoryStorageAdapter — the test double must not be kinder than reality', () => {
  it('CLONES on read, so two readers never share one object', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.set('liveWallets', { wallets: [{ id: 'w1' }] });

    type Shape = { wallets: Array<{ id: string }> };
    const pageA = await storage.get<Shape>('liveWallets');
    const pageB = await storage.get<Shape>('liveWallets');

    // Two extension pages read the same key. chrome.storage.local serializes
    // across the IPC boundary and localStorage re-parses JSON, so neither can
    // hand back one shared object. This used to, and every cross-page race the
    // app password can lose a seed to was invisible because of it.
    expect(pageA).not.toBe(pageB);
    pageA!.wallets.push({ id: 'w2' });
    expect(pageB!.wallets).toHaveLength(1);
    expect((await storage.get<Shape>('liveWallets'))!.wallets).toHaveLength(1);
  });

  it('still clones on write, so a mutation after set() does not reach storage', async () => {
    const storage = new MemoryStorageAdapter();
    const written = { wallets: [{ id: 'w1' }] };
    await storage.set('liveWallets', written);
    written.wallets.push({ id: 'w2' });

    type Shape = { wallets: Array<{ id: string }> };
    expect((await storage.get<Shape>('liveWallets'))!.wallets).toHaveLength(1);
  });

  it('undefined stays undefined (structuredClone is never handed a missing key)', async () => {
    const storage = new MemoryStorageAdapter();
    await expect(storage.get('nothing-here')).resolves.toBeUndefined();
  });
});
