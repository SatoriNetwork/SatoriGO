// moneroBalances.ts reads through the ONE open host in the liveStore `monero`
// slice (Set D surface); liveStore.ts itself is mocked down to that one shape
// so this test does not depend on the whole store (or on Set D's wiring, which
// has not landed yet).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MoneroBalance, MoneroWalletHost } from '../services/chain/monero/scanner';

const hoisted = vi.hoisted(() => ({
  host: null as MoneroWalletHost | null,
}));

vi.mock('./liveStore', () => ({
  useLiveStore: { getState: () => ({ monero: { host: hoisted.host } }) },
}));

import { refreshMoneroWallet, readMoneroBalance } from './moneroBalances';

function fakeHost(overrides: Partial<MoneroWalletHost> = {}): MoneroWalletHost {
  return {
    walletId: 'w1',
    primaryAddress: vi.fn(async () => '4address'),
    subaddresses: vi.fn(async () => []),
    createSubaddress: vi.fn(async () => ({ major: 0, minor: 1, address: '8sub', label: '', used: false })),
    sync: vi.fn(async (): Promise<MoneroBalance> => ({ total: 1_000_000_000_000n, unlocked: 500_000_000_000n, height: 10, daemonHeight: 10 })),
    balance: vi.fn(async (): Promise<MoneroBalance> => ({ total: 1_000_000_000_000n, unlocked: 500_000_000_000n, height: 10, daemonHeight: 10 })),
    history: vi.fn(async () => []),
    buildTx: vi.fn(),
    relay: vi.fn(),
    setRestoreHeight: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  } as unknown as MoneroWalletHost;
}

describe('refreshMoneroWallet', () => {
  beforeEach(() => {
    hoisted.host = null;
  });

  it('reports an empty/offline balance when no host is open for this wallet id', async () => {
    const result = await refreshMoneroWallet('w1');
    expect(result.balance).toEqual({ total: 0n, unlocked: 0n, height: 0, daemonHeight: 0 });
    expect(result.assets).toEqual([{ name: 'XMR', amountBase: 0n, scale: 12, decimals: 12, isNative: true }]);
  });

  it('reports offline when the open host belongs to a DIFFERENT wallet id (stale/switched)', async () => {
    hoisted.host = fakeHost({ walletId: 'other-wallet' });
    const result = await refreshMoneroWallet('w1');
    expect(result.balance.total).toBe(0n);
  });

  it('syncs the open host and returns its balance as one XMR asset row', async () => {
    hoisted.host = fakeHost();
    const result = await refreshMoneroWallet('w1');
    expect(hoisted.host!.sync).toHaveBeenCalledTimes(1);
    expect(result.balance.total).toBe(1_000_000_000_000n);
    expect(result.assets).toEqual([
      { name: 'XMR', amountBase: 1_000_000_000_000n, scale: 12, decimals: 12, isNative: true },
    ]);
  });

  it('falls back to the last known balance() when sync() fails (gateway/node trouble)', async () => {
    const host = fakeHost({
      sync: vi.fn(async () => { throw new Error('gateway unreachable'); }),
    });
    hoisted.host = host;
    const result = await refreshMoneroWallet('w1');
    expect(host.balance).toHaveBeenCalledTimes(1);
    expect(result.balance.total).toBe(1_000_000_000_000n);
  });

  it('degrades to offline when both sync() and balance() fail', async () => {
    hoisted.host = fakeHost({
      sync: vi.fn(async () => { throw new Error('down'); }),
      balance: vi.fn(async () => { throw new Error('down'); }),
    });
    const result = await refreshMoneroWallet('w1');
    expect(result.balance.total).toBe(0n);
  });
});

describe('readMoneroBalance', () => {
  beforeEach(() => {
    hoisted.host = null;
  });

  it('returns null with no open host', async () => {
    expect(await readMoneroBalance('w1')).toBeNull();
  });

  it('returns the host balance without syncing', async () => {
    const host = fakeHost();
    hoisted.host = host;
    const balance = await readMoneroBalance('w1');
    expect(host.sync).not.toHaveBeenCalled();
    expect(balance?.total).toBe(1_000_000_000_000n);
  });

  it('returns null when balance() throws', async () => {
    hoisted.host = fakeHost({ balance: vi.fn(async () => { throw new Error('nope'); }) });
    expect(await readMoneroBalance('w1')).toBeNull();
  });
});
