/**
 * @vitest-environment jsdom
 *
 * THE dApp APPROVAL WINDOW WHILE THE FORCED SETUP IS OWED
 * (the app-password design notes §12).
 *
 * This window is opened by the background worker for ONE pending site request
 * and bypasses LiveApp entirely, so the blocking setup screen the rest of the
 * wallet is showing never reaches it. Two things follow, and both are asserted
 * here because between them they are the difference between a gate and a hole:
 *
 *   * IT MUST NOT SHOW A SETUP SCREEN. A password field in a window a website
 *     caused to open is the shape of a phishing prompt, and the password it
 *     would be asking for protects every wallet on the device.
 *   * IT MUST NOT APPROVE. In this state the active wallet can be one whose
 *     vault opens under the EMPTY passphrase, so a send would be built, signed
 *     and broadcast with nothing typed by anyone, from a window a page asked
 *     for, while the wallet's own UI refuses to open at all.
 *
 * So it refuses, with an honest reason, and the refusal reaches the site.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const sent: unknown[] = [];
let walletsRecord: Record<string, unknown> = {};
const pendingRequest = {
  id: 'req-1',
  tabId: 7,
  origin: 'https://example.test',
  method: 'sendEvr',
  params: { to: 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU', amount: 1 },
};

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
    async unlock() {
      throw new Error('the approval window must not reach an unlock in this state');
    }
    lockApp() {}
    network() {
      return 'mainnet';
    }
  }
  return { LiveWalletService };
});

import { DappApproval } from './DappApproval';

/** A wallet entry as the `liveWallets` record stores it (public fields only). */
function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'w-1',
    name: 'Wallet',
    address: 'EXfUwzGUCJp3AjmxqRVKV8DnpJhTGiuGqU',
    network: 'mainnet',
    vault: { version: 1 },
    ...over,
  };
}

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: pendingRequest }),
      },
    },
    runtime: {
      sendMessage: async (msg: unknown) => {
        sent.push(msg);
      },
    },
  });
  vi.stubGlobal('close', () => {});
  window.close = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('dApp approval while a wallet still opens with no password', () => {
  it('REFUSES the request, says why, and shows no password field of any kind', async () => {
    walletsRecord = {
      activeId: 'w-1',
      wallets: [entry({ id: 'w-1', passwordless: true })],
    };
    render(<DappApproval requestId="req-1" />);

    await waitFor(() => expect(screen.getByTestId('dapp-setup-required')).toBeTruthy());
    const body = screen.getByTestId('dapp-setup-required').textContent ?? '';
    expect(body).toMatch(/needs an app password before it can answer this site/i);
    expect(body).toMatch(/Nothing was approved and nothing was sent/i);
    expect(body).not.toContain('—');

    // NO setup screen: no password field, no strength meter, no "set" button.
    expect(screen.queryByTestId('dapp-password')).toBeNull();
    expect(screen.queryByTestId('live-force-app-pw-new')).toBeNull();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    // And no way to approve anything.
    expect(screen.queryByTestId('dapp-approve')).toBeNull();
    expect(screen.queryByTestId('dapp-confirm')).toBeNull();
  });

  it('sends the site an honest refusal rather than a silent hang', async () => {
    walletsRecord = {
      activeId: 'w-1',
      wallets: [entry({ id: 'w-1', passwordless: true })],
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-reject')).toBeTruthy());
    fireEvent.click(screen.getByTestId('dapp-reject'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      type: 'evr-dapp-approve-result',
      id: 'req-1',
      error: 'wallet-setup-required',
    });
  });

  it('refuses on the SAME device-wide condition as the screen, not on "is the active wallet the open one"', async () => {
    // The active wallet has its own password; ANOTHER wallet opens with none.
    // One condition means there is no combination where the wallet UI demands a
    // password and this window spends without one.
    walletsRecord = {
      activeId: 'w-1',
      wallets: [entry({ id: 'w-1' }), entry({ id: 'w-2', name: 'Open', passwordless: true })],
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-setup-required')).toBeTruthy());
  });
});

describe('dApp approval when the forced setup is NOT owed', () => {
  it('an install with no unprotected wallet is exactly what it was', async () => {
    walletsRecord = { activeId: 'w-1', wallets: [entry({ id: 'w-1' })] };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-send-to')).toBeTruthy());
    expect(screen.queryByTestId('dapp-setup-required')).toBeNull();
    expect(screen.getByTestId('dapp-password')).toBeTruthy();
  });

  it('an unprotected wallet with an app password ALREADY set is not for this window to fix', async () => {
    walletsRecord = {
      activeId: 'w-1',
      wallets: [entry({ id: 'w-1', passwordless: true })],
      appKey: { version: 1, salt: 'x' },
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-send-to')).toBeTruthy());
    expect(screen.queryByTestId('dapp-setup-required')).toBeNull();
  });

  it('the damaged state where no app password CAN be set is left alone here too', async () => {
    // A v2 wallet with no app record: appPasswordRequired() is false, so the
    // wallet UI is not blocking, and neither is this. The two must agree.
    walletsRecord = {
      activeId: 'w-1',
      wallets: [
        entry({ id: 'w-1', passwordless: true }),
        entry({ id: 'w-2', name: 'Moved', vault: { version: 2 } }),
      ],
    };
    render(<DappApproval requestId="req-1" />);
    await waitFor(() => expect(screen.getByTestId('dapp-send-to')).toBeTruthy());
    expect(screen.queryByTestId('dapp-setup-required')).toBeNull();
  });
});
