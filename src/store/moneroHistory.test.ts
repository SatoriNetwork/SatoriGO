import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MoneroTxRecord, MoneroWalletHost } from '../services/chain/monero/scanner';

const hoisted = vi.hoisted(() => ({
  host: null as MoneroWalletHost | null,
}));

vi.mock('./liveStore', () => ({
  useLiveStore: { getState: () => ({ monero: { host: hoisted.host } }) },
}));

// formatXmr mirrors Set A's real contract (exact decimal text, 12 places,
// trailing zeros trimmed) closely enough to exercise the conversion boundary
// without importing the not-yet-landed module.
vi.mock('../services/chain/monero/fees', () => ({
  formatXmr: (pico: bigint) => {
    const s = pico.toString().padStart(13, '0');
    const whole = s.slice(0, -12) || '0';
    const frac = s.slice(-12).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  },
}));

import { refreshMoneroHistory } from './moneroHistory';

function fakeHost(history: MoneroTxRecord[]): MoneroWalletHost {
  return {
    walletId: 'w1',
    primaryAddress: vi.fn(),
    subaddresses: vi.fn(),
    createSubaddress: vi.fn(),
    sync: vi.fn(),
    balance: vi.fn(),
    history: vi.fn(async () => history),
    buildTx: vi.fn(),
    relay: vi.fn(),
    setRestoreHeight: vi.fn(),
    save: vi.fn(),
    close: vi.fn(),
  } as unknown as MoneroWalletHost;
}

function rec(overrides: Partial<MoneroTxRecord>): MoneroTxRecord {
  return {
    hash: 'txhash',
    height: 100,
    timestamp: 1_700_000_000_000,
    confirmations: 12,
    incoming: 0n,
    outgoing: 0n,
    fee: 0n,
    isLocked: false,
    unlockTime: 0,
    subaddressIndices: [{ major: 0, minor: 0 }],
    ...overrides,
  };
}

describe('refreshMoneroHistory', () => {
  beforeEach(() => {
    hoisted.host = null;
  });

  it('returns [] when no host is open for this wallet id', async () => {
    expect(await refreshMoneroHistory('w1')).toEqual([]);
  });

  it('returns [] when the open host belongs to a different wallet (stale)', async () => {
    hoisted.host = { ...fakeHost([]), walletId: 'other' };
    expect(await refreshMoneroHistory('w1')).toEqual([]);
  });

  it('maps a pure incoming record to one "in" row with no fee', async () => {
    hoisted.host = fakeHost([rec({ incoming: 500_000_000_000n })]); // 0.5 XMR
    const rows = await refreshMoneroHistory('w1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txid: 'txhash', asset: 'XMR', direction: 'in', amount: 0.5, feeEvr: 0, status: 'confirmed' });
  });

  it('maps a pure outgoing record to one "out" row carrying the fee', async () => {
    hoisted.host = fakeHost([rec({ outgoing: 1_000_000_000_000n, fee: 4_000_000n })]); // 1 XMR, tiny fee
    const rows = await refreshMoneroHistory('w1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'out', amount: 1, feeEvr: 0.000004 });
  });

  it('a mixed record (both sides) becomes ONE "out" row with the NET amount and one txid', async () => {
    // Two rows with one txid collided as Activity keys, and the detail screen
    // (find by txid) could only open the first of them.
    hoisted.host = fakeHost([rec({ incoming: 300_000_000_000n, outgoing: 1_000_000_000_000n, fee: 1_000_000n })]);
    const rows = await refreshMoneroHistory('w1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txid: 'txhash', direction: 'out', amount: 0.7, feeEvr: 0.000001 });
  });

  it('never repeats a txid across rows', async () => {
    hoisted.host = fakeHost([
      rec({ hash: 'a', incoming: 5n, outgoing: 5n, fee: 1n }),
      rec({ hash: 'b', incoming: 7n }),
    ]);
    const rows = await refreshMoneroHistory('w1');
    expect(new Set(rows.map((r) => r.txid)).size).toBe(rows.length);
  });

  it('carries the full 12-decimal precision and an EMPTY counterparty (nothing to copy)', async () => {
    hoisted.host = fakeHost([rec({ incoming: 123_456_789_012n })]); // 0.123456789012 XMR
    const rows = await refreshMoneroHistory('w1');
    expect(rows[0].amount).toBe(0.123456789012);
    expect(rows[0].counterparty).toBe('');
  });

  it('a pending (unconfirmed) record maps to status "pending"', async () => {
    hoisted.host = fakeHost([rec({ height: null, confirmations: 0, incoming: 100n })]);
    const rows = await refreshMoneroHistory('w1');
    expect(rows[0].status).toBe('pending');
  });

  it('sorts newest first', async () => {
    hoisted.host = fakeHost([
      rec({ hash: 'old', timestamp: 1000, incoming: 1n }),
      rec({ hash: 'new', timestamp: 9000, incoming: 1n }),
    ]);
    const rows = await refreshMoneroHistory('w1');
    expect(rows.map((r) => r.txid)).toEqual(['new', 'old']);
  });

  it('returns [] (never throws) when host.history() rejects', async () => {
    const host = fakeHost([]);
    (host.history as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gateway down'));
    hoisted.host = host;
    await expect(refreshMoneroHistory('w1')).resolves.toEqual([]);
  });
});
