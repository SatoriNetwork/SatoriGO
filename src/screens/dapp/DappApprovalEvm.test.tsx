/**
 * @vitest-environment jsdom
 *
 * The window.ethereum approval screen: connect offers EVM accounts only and
 * names the picked one; personal_sign shows the decoded text and returns the
 * signature; typed data that looks like a permit carries a warning; and a
 * signature from any account other than the connected one is refused; a
 * network switch names both chains; a token approval is decoded and an
 * unlimited one is called out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const sent: Record<string, unknown>[] = [];
let walletsRecord: Record<string, unknown> = {};
let pendingRequest: Record<string, unknown> = {};
let signingAddress = '';
let connections: unknown = undefined;

const ADDR = '0x1111111111111111111111111111111111111111';
const ADDR2 = '0x2222222222222222222222222222222222222222';

vi.mock('../../services/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/storage')>();
  return {
    ...actual,
    getStorage: () => ({
      get: async (key: string) =>
        key === 'liveWallets' ? walletsRecord : key === 'dappEvmApprovedOrigins' ? connections : undefined,
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
    { key: 'ethereum', chainId: 1, displayName: 'Ethereum', nativeTicker: 'ETH', nativeDecimals: 18, defaultTokens: [] },
  ],
}));
// No network in unit tests: token metadata stays unknown (raw amounts).
vi.mock('../../store/evmBalances', () => ({ evmProviderFor: async () => null }));
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
  connections = undefined;
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

const request = (method: string, params?: unknown, walletId?: string, chainKey = 'base') => ({
  id: 'req-evm', tabId: 7, origin: 'https://dapp.example', method, params, family: 'evm', chainKey,
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

describe('window.ethereum approval: switch and token calls', () => {
  it('a network switch names both chains and settles with null', async () => {
    connections = [{ origin: 'https://dapp.example', walletId: 'a1', chainKey: 'base' }];
    pendingRequest = request('wallet_switchEthereumChain', [{ chainId: '0x1' }], 'a1', 'ethereum');
    render(<DappApproval requestId="req-evm" />);
    const text = (await screen.findByTestId('dapp-switch-text')).textContent ?? '';
    expect(text.replace(/\s+/g, ' ')).toMatch(/from Base to Ethereum/);
    fireEvent.click(screen.getByTestId('dapp-approve'));
    await waitFor(() => expect(settled()).toBeTruthy());
    expect(settled()).toMatchObject({ result: null });
    expect(settled()).not.toHaveProperty('approveOrigin');
  });

  it('decodes an unlimited approve and warns before Review', async () => {
    const data = `0x095ea7b3${ADDR2.slice(2).padStart(64, '0')}${'f'.repeat(64)}`;
    pendingRequest = request('eth_sendTransaction', [{ from: ADDR, to: '0x3333333333333333333333333333333333333333', data }], 'a1');
    render(<DappApproval requestId="req-evm" />);
    expect((await screen.findByTestId('dapp-allowance-warning')).textContent).toMatch(/UNLIMITED/);
    const rows = screen.getAllByTestId('dapp-call-row').map((r) => r.textContent);
    expect(rows.some((r) => r?.toLowerCase() === ADDR2)).toBe(true);
    expect(rows).toContain('Unlimited');
  });

  it('refuses to review calldata that does not fit the token call it names', async () => {
    // transfer(address,uint256) whose address word has dirty padding.
    const data = `0xa9059cbb${'ff'.repeat(12)}${ADDR2.slice(2)}${'0'.repeat(63)}1`;
    pendingRequest = request('eth_sendTransaction', [{ from: ADDR, to: ADDR2, data }], 'a1');
    render(<DappApproval requestId="req-evm" />);
    expect((await screen.findByTestId('dapp-call-error')).textContent).toMatch(/does not match/);
    expect((screen.getByTestId('dapp-approve') as HTMLButtonElement).disabled).toBe(true);
  });

  it('flags a token recipient that imitates one of my accounts', async () => {
    // Same first and last four characters as ADDR, different in between.
    const lookalike = `0x1111${'a'.repeat(32)}1111`;
    const data = `0xa9059cbb${lookalike.slice(2).padStart(64, '0')}${'0'.repeat(63)}1`;
    pendingRequest = request('eth_sendTransaction', [{ from: ADDR, to: '0x3333333333333333333333333333333333333333', data }], 'a1');
    render(<DappApproval requestId="req-evm" />);
    expect(await screen.findByTestId('live-send-lookalike')).toBeTruthy();
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
