// taoBalances.ts reads through a stateless TaoRpc client and the wallet's
// cached public address (liveStore `wallets`), never an open host: Substrate
// has no worker the way Monero does (design §13). liveStore.ts and the
// services/chain/substrate barrel are mocked down to the shapes this file
// actually uses so this test does not depend on Set A/B/D's real code, which
// has not landed yet.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeWallet {
  id: string;
  address?: string;
}

const hoisted = vi.hoisted(() => ({
  wallets: [] as FakeWallet[],
  readTaoAccountImpl: vi.fn(),
  checkRuntimeImpl: vi.fn(),
  taoRpcImpl: vi.fn(() => ({ id: 'fake-rpc' })),
}));

vi.mock('./liveStore', () => ({
  useLiveStore: { getState: () => ({ wallets: hoisted.wallets }) },
}));

vi.mock('../services/gateway', () => ({
  GATEWAY_CLIENT_TOKEN: 'tok',
  gatewayUrl: () => 'https://gw.example',
}));

vi.mock('../services/chain/substrate', () => ({
  taoRpc: hoisted.taoRpcImpl,
  readTaoAccount: hoisted.readTaoAccountImpl,
  checkRuntime: hoisted.checkRuntimeImpl,
  TAO_PROFILE: { specVersion: 470, transactionVersion: 1 },
  TAO_EXISTENTIAL_DEPOSIT: 500n,
}));

import { refreshTaoWallet, readTaoBalance, taoRpcClient, resetTaoRpcForTests } from './taoBalances';

const ACCOUNT = {
  exists: true,
  info: { nonce: 1, consumers: 0, providers: 1, sufficients: 0, free: 1_000_000_000n, reserved: 0n, frozen: 0n, flags: 0n },
  spendable: 1_000_000_000n,
  finalizedHash: '0xabc',
  finalizedNumber: 100,
};

beforeEach(() => {
  hoisted.wallets = [];
  hoisted.readTaoAccountImpl.mockReset();
  hoisted.checkRuntimeImpl.mockReset();
  hoisted.taoRpcImpl.mockClear();
  resetTaoRpcForTests();
});

describe('taoRpcClient', () => {
  it('builds one client from the gateway url/token/node-set and caches it', () => {
    const a = taoRpcClient();
    const b = taoRpcClient();
    expect(a).toBe(b);
    expect(hoisted.taoRpcImpl).toHaveBeenCalledTimes(1);
    expect(hoisted.taoRpcImpl).toHaveBeenCalledWith('https://gw.example', 'tok', 'main');
  });
});

describe('refreshTaoWallet', () => {
  it('reports an offline/no-address result when the wallet has no address yet', async () => {
    hoisted.wallets = [{ id: 'w1' }];
    const result = await refreshTaoWallet('w1');
    expect(result.account.exists).toBe(false);
    expect(result.account.spendable).toBe(0n);
    expect(result.assets).toEqual([{ name: 'TAO', amountBase: 0n, scale: 9, decimals: 9, isNative: true }]);
    expect(result.error).toMatch(/no bittensor address/i);
    expect(hoisted.readTaoAccountImpl).not.toHaveBeenCalled();
  });

  it('reports an offline result when no wallet matches walletId at all', async () => {
    hoisted.wallets = [];
    const result = await refreshTaoWallet('missing');
    expect(result.account.exists).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('reads the account and runtime verdict, and uses free (not spendable) for the asset row', async () => {
    hoisted.wallets = [{ id: 'w1', address: '5Addr' }];
    hoisted.readTaoAccountImpl.mockResolvedValue(ACCOUNT);
    hoisted.checkRuntimeImpl.mockResolvedValue({ verdict: 'same', live: { specVersion: 470, transactionVersion: 1 } });

    const result = await refreshTaoWallet('w1');

    expect(hoisted.readTaoAccountImpl).toHaveBeenCalledWith(expect.anything(), '5Addr', 500n);
    expect(result.account).toBe(ACCOUNT);
    expect(result.assets).toEqual([{ name: 'TAO', amountBase: 1_000_000_000n, scale: 9, decimals: 9, isNative: true }]);
    expect(result.runtime).toBe('same');
    expect(result.error).toBeNull();
  });

  it('surfaces a layout-changed verdict so the Send screen can block', async () => {
    hoisted.wallets = [{ id: 'w1', address: '5Addr' }];
    hoisted.readTaoAccountImpl.mockResolvedValue(ACCOUNT);
    hoisted.checkRuntimeImpl.mockResolvedValue({ verdict: 'layout-changed', live: { specVersion: 999, transactionVersion: 2 } });

    const result = await refreshTaoWallet('w1');
    expect(result.runtime).toBe('layout-changed');
  });

  it('degrades to offline with an error when the account read fails (gateway down)', async () => {
    hoisted.wallets = [{ id: 'w1', address: '5Addr' }];
    hoisted.readTaoAccountImpl.mockRejectedValue(new Error('gateway unreachable'));
    hoisted.checkRuntimeImpl.mockResolvedValue({ verdict: 'same', live: {} });

    const result = await refreshTaoWallet('w1');
    expect(result.account.exists).toBe(false);
    expect(result.error).toBe('gateway unreachable');
  });

  it('never fails the whole refresh just because the runtime check failed', async () => {
    hoisted.wallets = [{ id: 'w1', address: '5Addr' }];
    hoisted.readTaoAccountImpl.mockResolvedValue(ACCOUNT);
    hoisted.checkRuntimeImpl.mockRejectedValue(new Error('runtime unreachable'));

    const result = await refreshTaoWallet('w1');
    expect(result.error).toBeNull();
    expect(result.runtime).toBe('same');
    expect(result.account).toBe(ACCOUNT);
  });
});

describe('readTaoBalance', () => {
  it('returns null with no address for this wallet', async () => {
    hoisted.wallets = [{ id: 'w1' }];
    expect(await readTaoBalance('w1')).toBeNull();
    expect(hoisted.readTaoAccountImpl).not.toHaveBeenCalled();
  });

  it('returns the account without a runtime check', async () => {
    hoisted.wallets = [{ id: 'w1', address: '5Addr' }];
    hoisted.readTaoAccountImpl.mockResolvedValue(ACCOUNT);
    const account = await readTaoBalance('w1');
    expect(account).toBe(ACCOUNT);
    expect(hoisted.checkRuntimeImpl).not.toHaveBeenCalled();
  });

  it('returns null when the read throws', async () => {
    hoisted.wallets = [{ id: 'w1', address: '5Addr' }];
    hoisted.readTaoAccountImpl.mockRejectedValue(new Error('down'));
    expect(await readTaoBalance('w1')).toBeNull();
  });
});
