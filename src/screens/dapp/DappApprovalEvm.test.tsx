/**
 * @vitest-environment jsdom
 *
 * The window.ethereum approval screen: connect offers EVM accounts only and
 * names the picked one; personal_sign shows the decoded text and returns the
 * signature; typed data that looks like a permit carries a warning; and a
 * signature from any account other than the connected one is refused.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const sent: Record<string, unknown>[] = [];
let walletsRecord: Record<string, unknown> = {};
let pendingRequest: Record<string, unknown> = {};
let signingAddress = '';

const ADDR = '0x1111111111111111111111111111111111111111';
const ADDR2 = '0x2222222222222222222222222222222222222222';

vi.mock('../../services/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/storage')>();
  return {
    ...actual,
    getStorage: () => ({
      get: async (key: string) => (key === 'liveWallets' ? walletsRecord : undefined),
      set: async () => {},
      remove: async () => {},
      keys: async () => [],
    }),
  };
});
vi.mock('../../services/chain/network', () => ({
  applyAllStoredElectrumServers: async () => {},
  isGatewayElectrumUrl: () => false,
}));
vi.mock('../../services/chain/electrumClient', () => ({
  createElectrumClient: () => ({ connect: async () => {}, close: () => {} }),
  ELECTRUM_CLOSED: 'electrum-closed',
  ELECTRUM_NOT_CONNECTED: 'electrum-not-connected',
}));
vi.mock('../../services/chain/engine', async (orig) => ({
  ...(await orig<typeof import('../../services/chain/engine')>()),
  loadEvmModules: async () => import('../../services/chain/evm'),
}));
vi.mock('../../store/evmChains', () => ({
  loadEvmChainInfos: async () => [
    { key: 'base', chainId: 8453, displayName: 'Base', nativeTicker: 'ETH', nativeDecimals: 18, defaultTokens: [] },
  ],
}));
vi.mock('../../services/chain/liveWallet', () => {
  class LiveWalletService {
    adoptWallet() {}
    async unlock() {
      return true;
    }
    lockApp() {}
    personalSignEvm() {
      return { address: signingAddress, signature: '0xsig' };
    }
    signTypedDataEvm() {
      return { address: signingAddress, signature: '0xtyped' };
    }
  }
  return { LiveWalletService };
});

import { DappApproval } from './DappApproval';
import { decodeSignMessage, personalSignMessage } from './DappApprovalEvm';

const evmEntry = (id: string, address: string, name: string) => ({ id, name, address, family: 'evm', vault: { version: 1 } });

beforeEach(() => {
  sent.length = 0;
  signingAddress = ADDR;
  walletsRecord = {
    activeId: 'evr',
    wallets: [
      { id: 'evr', name: 'Evrmore', address: 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU', network: 'mainnet', vault: { version: 1 } },
      evmEntry('a1', ADDR, 'Account 1'),
      evmEntry('a2', ADDR2, 'Account 2'),
    ],
  };
  vi.stubGlobal('chrome', {
    storage: { session: { get: async (key: string) => ({ [key]: pendingRequest }) } },
    runtime: {
      sendMessage: async (msg: Record<string, unknown>) => {
        sent.push(msg);
      },
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
  });
  window.close = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const request = (method: string, params?: unknown, walletId?: string) => ({
  id: 'req-evm', tabId: 7, origin: 'https://dapp.example', method, params, family: 'evm', chainKey: 'base',
  ...(walletId ? { walletId } : {}),
});
const settled = () => sent.find((m) => m.type === 'evr-dapp-approve-result');

describe('window.ethereum approval', () => {
  it('connect offers EVM accounts only and binds the one picked', async () => {
    pendingRequest = request('eth_requestAccounts', []);
    render(<DappApproval requestId="req-evm" />);
    const select = (await screen.findByTestId('dapp-wallet-select')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['a1', 'a2']);
    expect(screen.getByTestId('dapp-evm-chain').textContent).toBe('Base');
    fireEvent.change(select, { target: { value: 'a2' } });
    fireEvent.click(screen.getByTestId('dapp-approve'));
    await waitFor(() => expect(settled()).toBeTruthy());
    expect(settled()).toMatchObject({ result: [ADDR2], approveOrigin: 'https://dapp.example', walletId: 'a2' });
  });

  it('personal_sign shows the decoded text and returns the signature', async () => {
    pendingRequest = request('personal_sign', ['0x68656c6c6f', ADDR], 'a1');
    render(<DappApproval requestId="req-evm" />);
    expect((await screen.findByTestId('dapp-sign-message')).textContent).toBe('hello');
    fireEvent.change(screen.getByTestId('dapp-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('dapp-approve'));
    await waitFor(() => expect(settled()).toBeTruthy());
    expect(settled()).toMatchObject({ result: '0xsig' });
  });

  it('refuses a signature from an account other than the connected one', async () => {
    signingAddress = ADDR2;
    pendingRequest = request('personal_sign', ['0x68656c6c6f', ADDR], 'a1');
    render(<DappApproval requestId="req-evm" />);
    fireEvent.change(await screen.findByTestId('dapp-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('dapp-approve'));
    expect((await screen.findByTestId('dapp-error')).textContent).toMatch(/not the one connected/);
    expect(settled()).toBeUndefined();
  });

  it('warns on a permit-shaped typed data request', async () => {
    const permit = {
      types: { Permit: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }] },
      primaryType: 'Permit',
      domain: { name: 'Token', chainId: 8453 },
      message: { spender: ADDR2, value: '1000' },
    };
    pendingRequest = request('eth_signTypedData_v4', [ADDR, JSON.stringify(permit)], 'a1');
    render(<DappApproval requestId="req-evm" />);
    expect(await screen.findByTestId('dapp-permit-warning')).toBeTruthy();
    expect(screen.getByTestId('dapp-sign-message').textContent).toContain('spender');
  });
});

describe('personalSignMessage', () => {
  it('takes [message, address], and [address, message] from older sites', () => {
    expect(personalSignMessage(['0x68656c6c6f', ADDR])).toBe('0x68656c6c6f');
    expect(personalSignMessage([ADDR, '0x68656c6c6f'])).toBe('0x68656c6c6f');
  });

  it('does not mistake a 20-byte message for an address (found by the browser smoke)', () => {
    const twentyBytes = `0x${'68'.repeat(20)}`;
    expect(personalSignMessage([twentyBytes, ADDR])).toBe(twentyBytes);
  });
});

describe('decodeSignMessage', () => {
  it('reads hex as bytes, text as text', () => {
    expect(decodeSignMessage('0x68656c6c6f').text).toBe('hello');
    expect(decodeSignMessage('0x00ff').text).toBeNull();
    expect(decodeSignMessage('plain words')).toMatchObject({ text: 'plain words' });
  });
});
