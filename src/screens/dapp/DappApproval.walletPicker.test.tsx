/**
 * @vitest-environment jsdom
 *
 * THE CONNECT APPROVAL OFFERS EVRMORE WALLETS, AND ONLY THOSE.
 *
 * `window.evrmore` is an Evrmore provider. Until 1.4.1 the approval showed
 * whichever wallet entry was ACTIVE, so with Bitcoin open a site received a
 * Bitcoin address from an Evrmore provider, could do nothing with it, and
 * reported that it "could not reach the wallet" (satorisignals.app,
 * 2026-09-04). Opening the wallet and switching back to Evrmore was the
 * accidental workaround. These tests pin the rules that replace that:
 *
 *   * the active wallet is preselected when it is an Evrmore wallet;
 *   * when it is not, an Evrmore wallet is preselected instead, and the
 *     non-Evrmore entry is never offered;
 *   * with several Evrmore wallets the user picks one, and the approval
 *     names the PICKED wallet's id so the worker binds the site to it;
 *   * with no Evrmore wallet at all there is nothing to approve.
 *
 * For sign/send the request already names the connected wallet, and the page
 * acts on that one, not on the active one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const sent: unknown[] = [];
type Listener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => unknown;
const listeners: Listener[] = [];
let walletsRecord: Record<string, unknown> = {};
let pendingRequest: Record<string, unknown> = {};
const adopted: string[] = [];

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
  createElectrumClient: () => ({
    connect: async () => {},
    isConnected: () => false,
    endpoint: () => 'wss://fake',
    close: () => {},
    request: async () => {
      throw new Error('no network in unit tests');
    },
    setPoolChain: () => {},
  }),
  ELECTRUM_CLOSED: 'electrum-closed',
  ELECTRUM_NOT_CONNECTED: 'electrum-not-connected',
}));

vi.mock('../../services/chain/liveWallet', () => {
  class LiveWalletService {
    adoptWallet(id: string) {
      adopted.push(id);
    }
    async unlock() {
      return false; // "Incorrect password": enough to prove which wallet was targeted
    }
    lockApp() {}
    network() {
      return 'mainnet';
    }
  }
  return { LiveWalletService };
});

import { DappApproval, type DappHostSession } from './DappApproval';
import type { LiveWalletService } from '../../services/chain/liveWallet';

const EVR_1 = 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU';
const EVR_2 = 'EMc6Wq7hT5kX2vZyQ8cRnJ3pL9sB4dF1aG';
const BTC = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function entry(over: Record<string, unknown> = {}) {
  return { id: 'w-1', name: 'Wallet 1', address: EVR_1, network: 'mainnet', vault: { version: 1 }, ...over };
}

function connectRequest() {
  return { id: 'req-1', tabId: 7, origin: 'https://satorisignals.app', method: 'connect' };
}

beforeEach(() => {
  sent.length = 0;
  adopted.length = 0;
  pendingRequest = connectRequest();
  listeners.length = 0;
  vi.stubGlobal('chrome', {
    storage: { session: { get: async (key: string) => ({ [key]: pendingRequest }) } },
    runtime: {
      sendMessage: async (msg: unknown) => { sent.push(msg); },
      onMessage: {
        addListener: (fn: Listener) => { listeners.push(fn); },
        removeListener: (fn: Listener) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      },
    },
  });
  window.close = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('connect: which wallet the site is offered', () => {
  it('preselects the ACTIVE wallet when it is an Evrmore wallet, and shows no picker for a single one', async () => {
    walletsRecord = { activeId: 'w-1', wallets: [entry()] };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-approve')).toBeTruthy());
    expect(screen.getByTestId('dapp-wallet-name').textContent).toBe('Wallet 1');
    expect(screen.queryByTestId('dapp-wallet-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('dapp-approve'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      type: 'evr-dapp-approve-result',
      id: 'req-1',
      result: { address: EVR_1 },
      approveOrigin: 'https://satorisignals.app',
      walletId: 'w-1',
    });
  });

  it('with BITCOIN active, offers the Evrmore entry instead and never the Bitcoin one', async () => {
    // The 2026-09-04 case: "Wallet 1 (Bitcoin)" is active. The site must get
    // Wallet 1's Evrmore address, not bc1q..., and no picker is needed because
    // there is exactly one Evrmore wallet.
    walletsRecord = {
      activeId: 'w-1-btc',
      wallets: [
        entry(),
        entry({ id: 'w-1-btc', name: 'Wallet 1 (Bitcoin)', address: BTC, network: 'bitcoin-mainnet' }),
      ],
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-approve')).toBeTruthy());
    expect(screen.getByTestId('dapp-wallet-name').textContent).toBe('Wallet 1');
    expect(screen.getByTestId('dapp-wallet-address').textContent).not.toContain('bc1q');
    expect(screen.queryByTestId('dapp-wallet-picker')).toBeNull();
    expect(document.body.textContent).not.toContain('Bitcoin');
    fireEvent.click(screen.getByTestId('dapp-approve'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ result: { address: EVR_1 }, walletId: 'w-1' });
  });

  it('an EVM account is not an Evrmore wallet either, whatever its network field says', async () => {
    walletsRecord = {
      activeId: 'w-evm',
      wallets: [
        entry(),
        entry({ id: 'w-evm', name: 'Wallet 1 (Ethereum)', address: '0xabc', network: 'ethereum', family: 'evm' }),
      ],
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-approve')).toBeTruthy());
    expect(screen.getByTestId('dapp-wallet-name').textContent).toBe('Wallet 1');
    expect(screen.queryByTestId('dapp-wallet-picker')).toBeNull();
  });

  it('with several Evrmore wallets shows a picker, and the approval carries the PICKED wallet', async () => {
    walletsRecord = {
      activeId: 'w-1',
      wallets: [
        entry(),
        entry({ id: 'w-2', name: 'Second Wallet', address: EVR_2 }),
        entry({ id: 'w-1-btc', name: 'Wallet 1 (Bitcoin)', address: BTC, network: 'bitcoin-mainnet' }),
      ],
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-wallet-picker')).toBeTruthy());
    // A dropdown with two options: the two Evrmore wallets. The Bitcoin entry
    // is absent. A dropdown, so the approval stays one screen at any count.
    const select = screen.getByTestId('dapp-wallet-select') as HTMLSelectElement;
    expect(select.querySelectorAll('option')).toHaveLength(2);
    expect(screen.queryByTestId('dapp-wallet-option-w-1-btc')).toBeNull();
    // The active wallet is preselected...
    expect(select.value).toBe('w-1');
    expect(screen.getByTestId('dapp-wallet-name').textContent).toBe('Wallet 1');
    // ...and the user picks the other one.
    fireEvent.change(select, { target: { value: 'w-2' } });
    expect(select.value).toBe('w-2');
    expect(screen.getByTestId('dapp-wallet-name').textContent).toBe('Second Wallet');
    fireEvent.click(screen.getByTestId('dapp-approve'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ result: { address: EVR_2 }, approveOrigin: 'https://satorisignals.app', walletId: 'w-2' });
  });

  it('a RE-connect (site already connected) preselects the CONNECTED wallet, not the active one, and still offers the choice', async () => {
    // The owner's case: the site was connected to Wallet 1, the user pressed
    // "Connect wallet" again to switch. The worker names the connected wallet
    // in the request; it is preselected, and the other wallet is one click away.
    pendingRequest = { ...connectRequest(), walletId: 'w-1' };
    walletsRecord = {
      activeId: 'w-2',
      wallets: [entry(), entry({ id: 'w-2', name: 'Second Wallet', address: EVR_2 })],
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-wallet-picker')).toBeTruthy());
    const select = screen.getByTestId('dapp-wallet-select') as HTMLSelectElement;
    expect(select.value).toBe('w-1');
    expect(screen.getByTestId('dapp-wallet-name').textContent).toBe('Wallet 1');
    fireEvent.change(select, { target: { value: 'w-2' } });
    fireEvent.click(screen.getByTestId('dapp-approve'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ result: { address: EVR_2 }, walletId: 'w-2' });
  });

  it('with NO Evrmore wallet there is nothing to connect: the button is disabled and the reason names Evrmore', async () => {
    walletsRecord = {
      activeId: 'w-1-btc',
      wallets: [entry({ id: 'w-1-btc', name: 'Wallet 1 (Bitcoin)', address: BTC, network: 'bitcoin-mainnet' })],
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-no-evrmore-wallet')).toBeTruthy());
    expect(screen.getByTestId('dapp-no-evrmore-wallet').textContent).toMatch(/Evrmore/);
    expect((screen.getByTestId('dapp-approve') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('dapp-wallet-address').textContent).not.toContain('bc1q');
  });
});

describe('sign: the request names the CONNECTED wallet, and the page acts on that one', () => {
  it('shows and signs with the bound wallet even though another wallet is active', async () => {
    pendingRequest = { ...connectRequest(), method: 'signMessage', params: { message: 'login' }, walletId: 'w-2' };
    walletsRecord = {
      activeId: 'w-1-btc',
      wallets: [
        entry(),
        entry({ id: 'w-2', name: 'Second Wallet', address: EVR_2 }),
        entry({ id: 'w-1-btc', name: 'Wallet 1 (Bitcoin)', address: BTC, network: 'bitcoin-mainnet' }),
      ],
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-sign-address')).toBeTruthy());
    expect(screen.getByTestId('dapp-sign-address').textContent).toContain(EVR_2.slice(0, 10));
    expect(screen.queryByTestId('dapp-wallet-picker')).toBeNull();
    fireEvent.change(screen.getByTestId('dapp-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('dapp-approve'));
    // The service was pointed at the bound wallet BEFORE unlock.
    await waitFor(() => expect(adopted).toEqual(['w-2']));
    await waitFor(() => expect(screen.getByTestId('dapp-error').textContent).toMatch(/Incorrect password/));
  });

  it('a binding to a wallet that no longer exists leaves nothing to sign with', async () => {
    pendingRequest = { ...connectRequest(), method: 'signMessage', params: { message: 'login' }, walletId: 'gone' };
    walletsRecord = { activeId: 'w-1', wallets: [entry()] };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-approve')).toBeTruthy());
    expect((screen.getByTestId('dapp-approve') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('dapp-sign-address').textContent).toMatch(/No wallet/);
  });
});

describe('hosted inside an open wallet window', () => {
  it('settling calls onDone instead of closing the window', async () => {
    walletsRecord = { activeId: 'w-1', wallets: [entry()] };
    let closed = 0;
    let done = 0;
    window.close = () => { closed += 1; };
    render(<DappApproval requestId="req-1" hosted onDone={() => { done += 1; }} />);
    await waitFor(() => expect(screen.getByTestId('dapp-reject')).toBeTruthy());
    fireEvent.click(screen.getByTestId('dapp-reject'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ error: 'user-rejected' });
    await waitFor(() => expect(done).toBe(1));
    expect(closed).toBe(0);
  });
});

describe('the worker asks whether the request is still on screen', () => {
  function ping(id: string): Promise<unknown> {
    return new Promise((resolve) => {
      let answered = false;
      for (const fn of listeners) fn({ type: 'evr-dapp-ping', id }, {}, (r) => { answered = true; resolve(r); });
      if (!answered) setTimeout(() => resolve(undefined), 10);
    });
  }

  it('answers alive for its own request while undecided, nothing for another id, and nothing once settled', async () => {
    walletsRecord = { activeId: 'w-1', wallets: [entry()] };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-approve')).toBeTruthy());
    expect(await ping('req-1')).toEqual({ alive: true });
    expect(await ping('someone-else')).toBeUndefined();
    fireEvent.click(screen.getByTestId('dapp-reject'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(await ping('req-1')).toBeUndefined();
  });
});

describe('hosted in a wallet page that lends its own unlocked service', () => {
  const signedBySession: string[] = [];
  const verified: string[] = [];
  function session(over: Partial<DappHostSession> = {}): DappHostSession {
    const service = {
      signMessage: (m: string) => {
        signedBySession.push(m);
        return { address: EVR_1, signature: 'sig-from-the-unlocked-wallet' };
      },
      network: () => 'mainnet',
    } as unknown as LiveWalletService;
    return {
      service,
      unlocked: true,
      activeWalletId: 'w-1',
      sendNeedsPassword: false,
      verifyPassword: async (pw: string) => { verified.push(pw); return pw === 'right'; },
      ...over,
    };
  }
  beforeEach(() => {
    signedBySession.length = 0;
    verified.length = 0;
  });

  it('unlocked and on the connected wallet: signs with THAT service, no password asked', async () => {
    pendingRequest = { ...connectRequest(), method: 'signMessage', params: { message: 'login' }, walletId: 'w-1' };
    walletsRecord = { activeId: 'w-1', wallets: [entry()] };
    render(<DappApproval requestId="req-1" hosted session={session()} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('dapp-approve')).toBeTruthy());
    expect(screen.queryByTestId('dapp-password')).toBeNull();
    expect(screen.queryByTestId('dapp-unlock-wait')).toBeNull();
    fireEvent.click(screen.getByTestId('dapp-approve'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(signedBySession).toEqual(['login']);
    expect(adopted).toEqual([]); // no fresh service was built
    expect(sent[0]).toMatchObject({ result: { address: EVR_1, signature: 'sig-from-the-unlocked-wallet' } });
  });

  it('LOCKED: shows the waiting strip over the lock screen, and the approval once unlocked', async () => {
    pendingRequest = { ...connectRequest(), method: 'signMessage', params: { message: 'login' }, walletId: 'w-1' };
    walletsRecord = { activeId: 'w-1', wallets: [entry()] };
    const view = render(<DappApproval requestId="req-1" hosted session={session({ unlocked: false })} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('dapp-unlock-wait')).toBeTruthy());
    expect(screen.queryByTestId('dapp-approval')).toBeNull();
    expect(screen.queryByTestId('dapp-host-overlay')).toBeNull();
    expect(screen.getByTestId('dapp-unlock-wait').textContent).toMatch(/Unlock the wallet to continue/);
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    // The user unlocks the wallet: the same request now shows, still without a password.
    view.rerender(<DappApproval requestId="req-1" hosted session={session({ unlocked: true })} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('dapp-approval')).toBeTruthy());
    expect(screen.queryByTestId('dapp-unlock-wait')).toBeNull();
    expect(screen.queryByTestId('dapp-password')).toBeNull();
  });

  it('the strip lets the user reject without unlocking', async () => {
    pendingRequest = { ...connectRequest(), method: 'signMessage', params: { message: 'login' }, walletId: 'w-1' };
    walletsRecord = { activeId: 'w-1', wallets: [entry()] };
    render(<DappApproval requestId="req-1" hosted session={session({ unlocked: false })} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('dapp-reject')).toBeTruthy());
    fireEvent.click(screen.getByTestId('dapp-reject'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ error: 'user-rejected' });
  });

  it('a connect request never waits for the unlock (no keys involved)', async () => {
    walletsRecord = { activeId: 'w-1', wallets: [entry()] };
    render(<DappApproval requestId="req-1" hosted session={session({ unlocked: false })} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('dapp-approve')).toBeTruthy());
    expect(screen.queryByTestId('dapp-unlock-wait')).toBeNull();
  });

  it('unlocked but showing ANOTHER wallet than the connected one: the fresh-service path, password asked', async () => {
    pendingRequest = { ...connectRequest(), method: 'signMessage', params: { message: 'login' }, walletId: 'w-2' };
    walletsRecord = { activeId: 'w-1', wallets: [entry(), entry({ id: 'w-2', name: 'Second Wallet', address: EVR_2 })] };
    render(<DappApproval requestId="req-1" hosted session={session({ activeWalletId: 'w-1' })} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('dapp-approve')).toBeTruthy());
    expect(screen.getByTestId('dapp-password')).toBeTruthy();
    expect(signedBySession).toEqual([]);
  });

  it('in the popup window (no session) the password is asked as before', async () => {
    pendingRequest = { ...connectRequest(), method: 'signMessage', params: { message: 'login' }, walletId: 'w-1' };
    walletsRecord = { activeId: 'w-1', wallets: [entry()] };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-approve')).toBeTruthy());
    expect(screen.getByTestId('dapp-password')).toBeTruthy();
  });
});
