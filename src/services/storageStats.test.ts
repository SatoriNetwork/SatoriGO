// Storage diagnostics. The summary is pure, so it is tested directly without a
// browser. What matters here is that the transaction cache is separated from
// everything else (it is the only unbounded consumer, and the reason the quota
// is reachable at all) and that the percentage cannot mislead.

import { describe, expect, it } from 'vitest';
import {
  categoriseKey,
  entryBytes,
  formatBytes,
  summariseStorage,
  DEFAULT_QUOTA_BYTES,
} from './storageStats';

describe('categoriseKey', () => {
  it('separates the unbounded tx cache from wallets and settings', () => {
    expect(categoriseKey('txcache:EMc6LdHEHRtTLRZgPQEJoEtUonJbX2D9Ew')).toBe('txcache');
    expect(categoriseKey('txcache:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toBe('txcache');
    expect(categoriseKey('liveWallets')).toBe('wallets');
    expect(categoriseKey('liveWallet')).toBe('wallets'); // pre-multiwallet key
    expect(categoriseKey('autoLockMinutes')).toBe('settings');
    expect(categoriseKey('addressBook')).toBe('settings');
  });

  it('does not mistake a key that merely CONTAINS the cache prefix', () => {
    // Anchored at the start, so a settings key mentioning it stays settings.
    expect(categoriseKey('lastTxcache:thing')).toBe('settings');
  });
});

describe('entryBytes', () => {
  it('counts UTF-8 bytes, not characters', () => {
    // A 2-char string of 3-byte glyphs is 6 bytes of content plus the 2 quotes.
    expect(entryBytes('日本')).toBe(8);
    expect(entryBytes('ab')).toBe(4);
  });

  it('returns 0 for a value that cannot be serialized rather than throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(entryBytes(cyclic)).toBe(0);
  });
});

describe('summariseStorage', () => {
  it('totals per category and lists the largest entries first', () => {
    const stats = summariseStorage({
      'txcache:A': { txs: new Array(50).fill('x'.repeat(40)) },
      'txcache:B': { txs: ['small'] },
      liveWallets: { wallets: [{ id: '1' }] },
      autoLockMinutes: 5,
    });

    const cache = stats.categories.find((c) => c.id === 'txcache')!;
    expect(cache.entries).toBe(2);
    // The two cache entries dominate, so the cache must be the biggest bucket.
    expect(stats.categories[0].id).toBe('txcache');
    expect(stats.entryCount).toBe(4);
    expect(stats.largest[0].key).toBe('txcache:A');
    expect(stats.largest[0].bytes).toBeGreaterThan(stats.largest[1].bytes);
  });

  it('keeps every category row even when it is empty, so nothing looks unread', () => {
    const stats = summariseStorage({ autoLockMinutes: 5 });
    expect(stats.categories.map((c) => c.id).sort()).toEqual(['settings', 'txcache', 'wallets']);
    expect(stats.categories.find((c) => c.id === 'txcache')!.entries).toBe(0);
  });

  it('prefers the runtime-reported usage and says it was measured', () => {
    const stats = summariseStorage({ liveWallets: { a: 1 } }, 1000, 750);
    expect(stats.usedBytes).toBe(750);
    expect(stats.percentUsed).toBeCloseTo(75, 5);
    expect(stats.measured).toBe(true);
  });

  it('falls back to the serialized total and says it was estimated', () => {
    const stats = summariseStorage({ liveWallets: { a: 1 } }, 1000);
    expect(stats.measured).toBe(false);
    expect(stats.usedBytes).toBeGreaterThan(0);
  });

  it('clamps the percentage so an over-quota reading cannot render past full', () => {
    // Reaching the cap is the failure this screen exists to reveal, so the bar
    // must stay readable rather than overflowing its track.
    const stats = summariseStorage({}, 1000, 5000);
    expect(stats.percentUsed).toBe(100);
  });

  it('never divides by a zero quota', () => {
    const stats = summariseStorage({}, 0, 100);
    expect(stats.quotaBytes).toBe(DEFAULT_QUOTA_BYTES);
    expect(Number.isFinite(stats.percentUsed)).toBe(true);
  });
});

describe('formatBytes', () => {
  it('scales the unit and keeps small numbers legible', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.00 MB');
  });
});
