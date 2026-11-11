// window.ethereum as the worker answers it (background/evmDapp.ts): what is
// answered at once, what is deferred to an approval, and what is refused.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const localData = new Map<string, unknown>();
const sessionData = new Map<string, unknown>();
const rpcCall = vi.fn();

function area(store: Map<string, unknown>) {
  return {
    get: async (key: string | string[] | null) => {
      const keys = key === null ? [...store.keys()] : Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) if (store.has(k)) out[k] = store.get(k);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    remove: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
  };
}

// The real engine, with the read provider faked (no network in unit tests).
vi.mock('#worker-evm', async () => {
  const real = await import('../services/chain/evm');
  return { loadWorkerEvm: async () => ({ ...real, createEvmProvider: () => ({ rpc: { call: rpcCall } }) }) };
});

type Mod = typeof import('./evmDapp');
let mod: Mod;

const ORIGIN = 'https://dapp.example';
const ADDR = '0x1111111111111111111111111111111111111111';
const ADDR2 = '0x2222222222222222222222222222222222222222';

function wallets(...list: { id: string; address: string; family?: string }[]) {
  localData.set('evrdemo:liveWallets', { version: 1, activeId: list[0]?.id ?? '', wallets: list });
}
function connect(walletId: string, chainKey = 'base') {
  localData.set('evrdemo:dappEvmApprovedOrigins', [{ origin: ORIGIN, walletId, chainKey }]);
}

const defer = vi.fn(async () => ({ deferred: true }));
const pushEvent = vi.fn();
const ask = (method: string, params?: unknown) =>
  mod.handleEvmDappRequest({ type: 'evm-dapp', id: 'r1', origin: ORIGIN, method, params }, { defer, pushEvent });

beforeAll(async () => {
  vi.stubGlobal('chrome', { storage: { local: area(localData), session: area(sessionData) } });
  mod = await import('./evmDapp');
});

beforeEach(() => {
  localData.clear();
  sessionData.clear();
  defer.mockClear();
  pushEvent.mockClear();
  rpcCall.mockReset();
  wallets({ id: 'evm1', address: ADDR, family: 'evm' }, { id: 'evr1', address: 'EXyz', family: undefined as never });
});

describe('window.ethereum: before connecting', () => {
  it('is on Base and shows no accounts, without prompting', async () => {
    expect(await ask('eth_chainId')).toEqual({ result: '0x2105' });
    expect(await ask('net_version')).toEqual({ result: '8453' });
    expect(await ask('eth_accounts')).toEqual({ result: [] });
    expect(defer).not.toHaveBeenCalled();
  });

  it('defers eth_requestAccounts to an approval on the current chain', async () => {
    expect(await ask('eth_requestAccounts')).toEqual({ deferred: true, result: undefined, error: undefined });
    expect(defer).toHaveBeenCalledWith(undefined, { chainKey: 'base' });
  });

  it('refuses to sign or send for a site that is not connected', async () => {
    for (const m of ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction']) {
      expect((await ask(m, []))?.error?.code).toBe(4100);
    }
    expect(defer).not.toHaveBeenCalled();
  });

  it('switches chain for the session and says so', async () => {
    expect(await ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(pushEvent).toHaveBeenCalledWith('chainChanged', '0x1');
    expect(await ask('eth_chainId')).toEqual({ result: '0x1' });
  });

  it('answers 4902 for a chain it does not support, and does not add chains', async () => {
    expect((await ask('wallet_switchEthereumChain', [{ chainId: '0x89' }])).error?.code).toBe(4902);
    expect((await ask('wallet_addEthereumChain', [{ chainId: '0x89' }])).error?.code).toBe(4200);
    // A chain it already has is just a switch.
    expect(await ask('wallet_addEthereumChain', [{ chainId: '0x2105' }])).toEqual({ result: null });
  });
});

describe('window.ethereum: connected', () => {
  beforeEach(() => connect('evm1'));

  it('returns the connected account at once when it is the only EVM account', async () => {
    expect(await ask('eth_accounts')).toEqual({ result: [ADDR] });
    expect(await ask('eth_requestAccounts')).toEqual({ result: [ADDR] });
    expect(defer).not.toHaveBeenCalled();
  });

  it('answers a connected site at once with several EVM accounts too, without an approval', async () => {
    wallets({ id: 'evm1', address: ADDR, family: 'evm' }, { id: 'evm2', address: ADDR2, family: 'evm' });
    expect(await ask('eth_requestAccounts')).toEqual({ result: [ADDR] });
    expect(defer).not.toHaveBeenCalled();
  });

  it('treats a binding to a deleted account as not connected', async () => {
    wallets({ id: 'evm2', address: ADDR2, family: 'evm' });
    expect(await ask('eth_accounts')).toEqual({ result: [] });
  });

  it('defers personal_sign for the connected address, in either param order', async () => {
    await ask('personal_sign', ['0x68656c6c6f', ADDR]);
    await ask('personal_sign', [ADDR, '0x68656c6c6f']);
    expect(defer).toHaveBeenCalledTimes(2);
    expect((await ask('personal_sign', ['0x00', ADDR2])).error?.code).toBe(4100);
  });

  it('refuses typed data for another chain before any window opens', async () => {
    const typed = {
      types: { Login: [{ name: 'nonce', type: 'uint256' }] },
      primaryType: 'Login',
      domain: { name: 'x', chainId: 1 },
      message: { nonce: 1 },
    };
    expect((await ask('eth_signTypedData_v4', [ADDR, JSON.stringify(typed)])).error?.code).toBe(-32602);
    await ask('eth_signTypedData_v4', [ADDR, JSON.stringify({ ...typed, domain: { name: 'x', chainId: 8453 } })]);
    expect(defer).toHaveBeenCalledTimes(1);
  });

  it('checks a transaction before deferring it', async () => {
    expect((await ask('eth_sendTransaction', [{ from: ADDR2, to: ADDR }])).error?.code).toBe(4100);
    expect((await ask('eth_sendTransaction', [{ from: ADDR, data: '0x00' }])).error?.code).toBe(-32602);
    expect((await ask('eth_sendTransaction', [{ to: ADDR, chainId: '0x1' }])).error?.code).toBe(-32602);
    await ask('eth_sendTransaction', [{ from: ADDR, to: ADDR2, value: '0x10', data: '0x' }]);
    expect(defer).toHaveBeenCalledWith('evm1', { chainKey: 'base' });
  });

  it('asks the user before moving a connected site to another chain', async () => {
    expect(await ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toMatchObject({ deferred: true });
    expect(defer).toHaveBeenCalledWith('evm1', { chainKey: 'ethereum' });
    // Nothing moves until the approval is applied.
    expect(localData.get('evrdemo:dappEvmApprovedOrigins')).toEqual([{ origin: ORIGIN, walletId: 'evm1', chainKey: 'base' }]);
    expect(pushEvent).not.toHaveBeenCalled();
  });

  it('applies an approved switch to the connection, and only for a connected site', async () => {
    expect(await mod.applyEvmChainSwitch(ORIGIN, 'ethereum')).toBe(true);
    expect(localData.get('evrdemo:dappEvmApprovedOrigins')).toEqual([{ origin: ORIGIN, walletId: 'evm1', chainKey: 'ethereum' }]);
    expect(await mod.applyEvmChainSwitch('https://other.example', 'ethereum')).toBe(false);
    expect(await mod.applyEvmChainSwitch(ORIGIN, 'not-a-chain')).toBe(false);
  });

  it('answers a switch to the chain it is already on without asking', async () => {
    expect(await ask('wallet_switchEthereumChain', [{ chainId: '0x2105' }])).toEqual({ result: null });
    expect(defer).not.toHaveBeenCalled();
  });

  it('refuses calldata with an odd number of hex digits', async () => {
    const r = await ask('eth_sendTransaction', [{ to: ADDR2, data: '0xabc' }]);
    expect(r.error?.code).toBe(-32602);
    expect(defer).not.toHaveBeenCalled();
  });

  it('knows SATORI on Base for wallet_watchAsset, and refuses an unknown token', async () => {
    const satori = { type: 'ERC20', options: { address: '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17', symbol: 'SATORI', decimals: 18 } };
    expect(await ask('wallet_watchAsset', satori)).toEqual({ result: true });
    expect((await ask('wallet_watchAsset', { type: 'ERC20', options: { address: ADDR2 } })).error?.code).toBe(4200);
  });
});

describe('window.ethereum: connection events', () => {
  it('announces a disconnect, a new account and a chain move', async () => {
    wallets({ id: 'evm1', address: ADDR, family: 'evm' }, { id: 'evm2', address: ADDR2, family: 'evm' });
    const before = [
      { origin: 'https://a.example', walletId: 'evm1', chainKey: 'base' },
      { origin: 'https://b.example', walletId: 'evm1', chainKey: 'base' },
      { origin: 'https://c.example', walletId: 'evm1', chainKey: 'base' },
    ];
    const after = [
      { origin: 'https://b.example', walletId: 'evm2', chainKey: 'base' },
      { origin: 'https://c.example', walletId: 'evm1', chainKey: 'ethereum' },
      { origin: 'https://d.example', walletId: 'evm1', chainKey: 'base' },
    ];
    const events = await mod.evmApprovalEvents(before, after);
    expect(events).toEqual(
      expect.arrayContaining([
        { origin: 'https://a.example', event: 'accountsChanged', data: [] },
        { origin: 'https://b.example', event: 'accountsChanged', data: [ADDR2] },
        { origin: 'https://c.example', event: 'chainChanged', data: '0x1' },
        { origin: 'https://d.example', event: 'accountsChanged', data: [ADDR] },
      ]),
    );
    expect(events).toHaveLength(4);
  });
});

describe('window.ethereum: read limits', () => {
  beforeEach(() => mod.resetReadBudgets());

  it('limits how many reads a site that is not connected may make', async () => {
    rpcCall.mockResolvedValue('0x10');
    let refused = 0;
    for (let i = 0; i < 70; i++) if ((await ask('eth_blockNumber')).error?.code === -32005) refused++;
    expect(refused).toBe(10);
  });

  it('refuses eth_getLogs over a wide or unbounded range', async () => {
    rpcCall.mockResolvedValue('0x100000');
    expect((await ask('eth_getLogs', [{ fromBlock: 'earliest' }])).error?.code).toBe(-32602);
    expect((await ask('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x100000' }])).error?.code).toBe(-32602);
    expect((await ask('eth_getLogs', [{ fromBlock: '0x0' }])).error?.code).toBe(-32602);
    rpcCall.mockClear();
    rpcCall.mockResolvedValue([]);
    expect(await ask('eth_getLogs', [{ fromBlock: '0x10', toBlock: '0x20' }])).toEqual({ result: [] });
    expect(await ask('eth_getLogs', [{ blockHash: '0x' + '11'.repeat(32) }])).toEqual({ result: [] });
  });
});

describe('window.ethereum: everything else', () => {
  it('forwards allowlisted reads to the chain RPC', async () => {
    rpcCall.mockResolvedValueOnce('0x10');
    expect(await ask('eth_blockNumber')).toEqual({ result: '0x10' });
    expect(rpcCall).toHaveBeenCalledWith('eth_blockNumber', []);
  });

  it('never forwards a write, and never offers eth_sign', async () => {
    expect((await ask('eth_sendRawTransaction', ['0x00'])).error?.code).toBe(4200);
    expect((await ask('eth_sign', [ADDR, '0x00'])).error?.code).toBe(4200);
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it('maps approval outcomes to EIP-1193 errors', () => {
    expect(mod.toEvmProviderError('user-rejected')?.code).toBe(4001);
    expect(mod.toEvmProviderError(undefined)).toBeUndefined();
    expect(mod.toEvmProviderError('approval-already-open')?.code).toBe(-32002);
    expect(mod.toEvmProviderError('too-many-pending-requests')?.code).toBe(-32603);
  });

  it('binds only an EVM account that exists', async () => {
    await mod.bindEvmOrigin(ORIGIN, 'evr1', 'base');
    expect(localData.get('evrdemo:dappEvmApprovedOrigins')).toBeUndefined();
    await mod.bindEvmOrigin(ORIGIN, 'evm1', 'ethereum');
    expect(localData.get('evrdemo:dappEvmApprovedOrigins')).toEqual([{ origin: ORIGIN, walletId: 'evm1', chainKey: 'ethereum' }]);
  });
});
