/**
 * @vitest-environment jsdom
 *
 * LiveSendMonero against a mocked store AND a mocked moneroSend.ts (that
 * file's own build/broadcast logic is covered by moneroSend.test.ts; this
 * file exercises the SCREEN: form validation and hand-off, the review step's
 * numbers and warnings, the arm + password gate, and the success step).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { MoneroWalletHost } from '../../services/chain/monero/scanner';

const hoisted = vi.hoisted(() => ({
  state: {
    monero: {
      chain: { key: 'monero', displayName: 'Monero', explorerTxUrl: 'https://xmrchain.net/tx/{txid}' } as unknown,
      host: null as MoneroWalletHost | null,
      balance: { total: 2_000_000_000_000n, unlocked: 2_000_000_000_000n, height: 1, daemonHeight: 1 } as unknown,
      sync: null,
      error: null,
    },
    wallets: [
      { id: 'w1', name: 'Monero', network: 'xmr:mainnet', createdAt: 0, active: true, kind: 'seed', address: '4primary', passwordless: false, family: 'monero' },
    ] as Array<Record<string, unknown>>,
    activeWalletId: 'w1',
    addressBook: [] as Array<{ label: string; address: string }>,
    addContact: vi.fn((_label: string, _address: string) => ({ ok: true as const })),
    requirePasswordToSend: false,
    verifyPassword: vi.fn(async () => true),
    arm: vi.fn(),
    refresh: vi.fn(async () => {}),
  },
}));

vi.mock('../../store/liveStore', () => {
  const useLiveStore = (selector: (s: typeof hoisted.state) => unknown) => selector(hoisted.state);
  useLiveStore.getState = () => hoisted.state;
  // The real helper scopes by family; the Monero target is exactly the
  // 'monero' family (liveStore.monero.test.ts proves the real one).
  const walletsOnChain = (wallets: Array<{ family?: string }>, chainId: string) =>
    chainId === 'xmr:mainnet' ? wallets.filter((w) => w.family === 'monero') : [];
  return { useLiveStore, walletsOnChain };
});

const moneroSendMock = vi.hoisted(() => ({
  build: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../../store/moneroSend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/moneroSend')>();
  return {
    ...actual,
    buildMoneroSendPlan: (...args: unknown[]) => moneroSendMock.build(...args),
    broadcastMoneroPlan: (...args: unknown[]) => moneroSendMock.broadcast(...args),
  };
});

import { LiveSendMonero, friendlyMoneroSendError } from './LiveSendMonero';
import { MoneroSendError } from '../../store/moneroSend';
import { NavProvider, type NavContextValue } from './LiveNav';

const NAV: NavContextValue = { tab: 'assets', section: 'home', openTab: vi.fn(), openSettings: vi.fn() };
const ADDR = '4destinationAddress';

function renderScreen() {
  return render(
    <NavProvider value={NAV}>
      <LiveSendMonero onBack={vi.fn()} onDone={vi.fn()} />
    </NavProvider>,
  );
}

const draft = {
  metadata: 'meta',
  hash: 'preview',
  fee: 4_000_000n,
  amount: 1_000_000_000_000n,
  sizeBytes: 1500,
  destination: ADDR,
  sweep: false,
};

const plan = {
  draft,
  feeXmr: '0.000004',
  amountXmr: '1',
  totalXmr: '1.000004',
  warnings: [] as string[],
};

// Two real mainnet Monero addresses (the §2.3 vector wallet and the Monero
// project's donation address): the pickers filter the address book with the
// REAL validator, so the fixtures must decode.
const XMR_A = '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756';
const XMR_B = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

describe('LiveSendMonero', () => {
  beforeEach(() => {
    hoisted.state.monero.host = { walletId: 'w1' } as unknown as MoneroWalletHost;
    hoisted.state.requirePasswordToSend = false;
    hoisted.state.monero.balance = { total: 2_000_000_000_000n, unlocked: 2_000_000_000_000n, height: 1, daemonHeight: 1 } as unknown;
    hoisted.state.wallets = [hoisted.state.wallets[0]];
    hoisted.state.addressBook = [];
    hoisted.state.addContact.mockClear();
    moneroSendMock.build.mockReset();
    moneroSendMock.broadcast.mockReset();
  });
  afterEach(cleanup);

  it('shows a closed banner when no Monero wallet is open', () => {
    hoisted.state.monero.host = null;
    renderScreen();
    expect(screen.getByTestId('live-xmr-send-closed')).toBeTruthy();
  });

  it('requires a recipient before building', async () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('live-xmr-send-submit'));
    await waitFor(() => expect(screen.getByText('Recipient address is required.')).toBeTruthy());
    expect(moneroSendMock.build).not.toHaveBeenCalled();
  });

  it('Max sets sweep, builds a never-relayed sweep to this wallet and shows its amount in the field', async () => {
    const buildTx = vi.fn(async () => ({ amount: 1_999_970_000_000n, fee: 30_000_000n }));
    hoisted.state.monero.host = { walletId: 'w1', buildTx } as unknown as MoneroWalletHost;
    renderScreen();
    fireEvent.click(screen.getByTestId('live-xmr-send-sweep'));
    const input = screen.getByTestId('live-xmr-send-amount') as HTMLInputElement;
    expect(input).toBeDisabled();
    await waitFor(() => expect(input.value).toBe('1.99997'));
    expect(buildTx).toHaveBeenCalledWith(expect.objectContaining({ sweep: true, amountPico: 0n }));
  });

  it('submits to buildMoneroSendPlan with to/amount/priority/sweep and shows the review on success', async () => {
    moneroSendMock.build.mockResolvedValue(plan);
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-xmr-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-xmr-send-priority-elevated'));
    fireEvent.click(screen.getByTestId('live-xmr-send-submit'));
    await waitFor(() => expect(moneroSendMock.build).toHaveBeenCalledWith({ to: ADDR, amount: '1', priority: 'elevated', sweep: false }));
    await waitFor(() => expect(screen.getByTestId('live-xmr-send-review')).toBeTruthy());
    expect(screen.getByTestId('live-xmr-send-fee').textContent).toContain('0.000004');
    expect(screen.getByTestId('live-xmr-send-total').textContent).toContain('1.000004');
  });

  it('shows an inline field error when the plan build fails with invalid-address', async () => {
    moneroSendMock.build.mockRejectedValue(new MoneroSendError('invalid-address', 'Enter a valid mainnet Monero address.'));
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: 'bad' } });
    fireEvent.change(screen.getByTestId('live-xmr-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-xmr-send-submit'));
    await waitFor(() => expect(screen.getByText('Enter a valid mainnet Monero address.')).toBeTruthy());
  });

  it('renders every plan warning on the review step', async () => {
    moneroSendMock.build.mockResolvedValue({ ...plan, warnings: ['0.5 XMR is still locked.'] });
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-xmr-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-xmr-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-send-warning-0').textContent).toBe('0.5 XMR is still locked.'));
  });

  it('Confirm & Send is disabled until the arm checkbox is checked', async () => {
    moneroSendMock.build.mockResolvedValue(plan);
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-xmr-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-xmr-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-broadcast')).toBeDisabled());
    fireEvent.click(screen.getByTestId('live-xmr-arm-checkbox'));
    expect(screen.getByTestId('live-xmr-broadcast')).not.toBeDisabled();
  });

  it('asks for the wallet password before broadcasting when requirePasswordToSend is on', async () => {
    hoisted.state.requirePasswordToSend = true;
    hoisted.state.verifyPassword = vi.fn(async () => false);
    moneroSendMock.build.mockResolvedValue(plan);
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-xmr-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-xmr-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-send-password')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-xmr-arm-checkbox'));
    fireEvent.change(screen.getByTestId('live-xmr-send-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('live-xmr-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-send-password-error')).toBeTruthy());
    expect(moneroSendMock.broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts and shows the success step with the txid and an explorer link', async () => {
    moneroSendMock.build.mockResolvedValue(plan);
    moneroSendMock.broadcast.mockResolvedValue({ txid: 'the-real-txid' });
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-xmr-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-xmr-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-arm-checkbox')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-xmr-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-xmr-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-send-txid').textContent).toContain('the-real-txid'));
    const link = screen.getByTestId('live-xmr-send-explorer-link') as HTMLAnchorElement;
    expect(link.href).toBe('https://xmrchain.net/tx/the-real-txid');
  });

  it('a broadcast failure shows an inline error and stays on the review step', async () => {
    moneroSendMock.build.mockResolvedValue(plan);
    moneroSendMock.broadcast.mockRejectedValue(new Error('not enough money'));
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-xmr-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-xmr-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-arm-checkbox')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-xmr-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-xmr-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-send-error').textContent).toMatch(/Insufficient unlocked XMR/));
    expect(screen.getByTestId('live-xmr-send-review')).toBeTruthy();
  });

  it('Max is disabled while the unlocked balance is 0 (nothing to sweep)', () => {
    hoisted.state.monero.balance = { total: 0n, unlocked: 0n, height: 1, daemonHeight: 1 } as unknown;
    renderScreen();
    expect(screen.getByTestId('live-xmr-send-sweep')).toBeDisabled();
  });

  it('reads the unlocked balance from the open wallet: a stale 0 in the store no longer greys out Max', async () => {
    hoisted.state.monero.balance = { total: 1_000_000_000_000n, unlocked: 0n, height: 1, daemonHeight: 1 } as unknown;
    hoisted.state.monero.host = { balance: async () => ({ total: 1_000_000_000_000n, unlocked: 1_000_000_000_000n, height: 5, daemonHeight: 5 }) } as unknown as MoneroWalletHost;
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('live-xmr-send-sweep')).not.toBeDisabled());
    expect(screen.getByTestId('live-xmr-send-available').textContent).toContain('1 XMR');
  });

  it('shows how much is still locked, and disables the percentages with nothing unlocked', () => {
    hoisted.state.monero.balance = { total: 500_000_000_000n, unlocked: 0n, height: 1, daemonHeight: 1 } as unknown;
    renderScreen();
    expect(screen.getByTestId('live-xmr-send-locked').textContent).toContain('0.5 XMR still locked');
    expect(screen.getByTestId('live-xmr-send-amt-75')).toBeDisabled();
  });

  it('offers the address book scoped to Monero addresses, and fills the recipient', () => {
    hoisted.state.addressBook = [
      { label: 'XMR friend', address: XMR_B },
      { label: 'BTC friend', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' },
      { label: 'EVR friend', address: 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF' },
    ];
    renderScreen();
    const select = screen.getByTestId('live-xmr-send-contacts') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(options).toEqual([XMR_B]);
    fireEvent.change(select, { target: { value: XMR_B } });
    expect((screen.getByTestId('live-xmr-send-to') as HTMLInputElement).value).toBe(XMR_B);
  });

  it('offers the user\'s OTHER Monero wallets (never a UTXO or EVM one, never itself)', () => {
    hoisted.state.wallets = [
      hoisted.state.wallets[0],
      { id: 'w2', name: 'Imported XMR', network: 'xmr:mainnet', createdAt: 1, active: false, kind: 'seed', address: XMR_A, passwordless: false, family: 'monero' },
      { id: 'w3', name: 'Bitcoin', network: 'bitcoin-mainnet', createdAt: 1, active: false, kind: 'seed', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', passwordless: false, family: 'utxo' },
    ];
    renderScreen();
    expect(screen.getByTestId('live-xmr-send-wallet-0').textContent).toContain('Imported XMR');
    expect(screen.queryByTestId('live-xmr-send-wallet-1')).toBeNull();
    fireEvent.click(screen.getByTestId('live-xmr-send-wallet-0'));
    expect((screen.getByTestId('live-xmr-send-to') as HTMLInputElement).value).toBe(XMR_A);
  });

  it('can save a typed Monero recipient to the address book', () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: XMR_B } });
    fireEvent.click(screen.getByTestId('live-xmr-send-save-contact'));
    fireEvent.change(screen.getByTestId('live-xmr-send-contact-label'), { target: { value: 'XMR friend' } });
    fireEvent.click(screen.getByTestId('live-xmr-send-contact-save'));
    expect(hoisted.state.addContact).toHaveBeenCalledWith('XMR friend', XMR_B);
    expect(screen.getByText('Saved to address book.')).toBeTruthy();
  });

  it('does not offer to save an invalid address or one of the user\'s own wallets', () => {
    hoisted.state.wallets = [
      hoisted.state.wallets[0],
      { id: 'w2', name: 'Imported XMR', network: 'xmr:mainnet', createdAt: 1, active: false, kind: 'seed', address: XMR_A, passwordless: false, family: 'monero' },
    ];
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: 'not an address' } });
    expect(screen.queryByTestId('live-xmr-send-save-contact')).toBeNull();
    fireEvent.change(screen.getByTestId('live-xmr-send-to'), { target: { value: XMR_A } });
    expect(screen.queryByTestId('live-xmr-send-save-contact')).toBeNull();
  });

  it('friendlyMoneroSendError words the raw wallet2 texts for the user', () => {
    expect(friendlyMoneroSendError(new Error('No unlocked balance in the specified account'))).toMatch(/Insufficient unlocked XMR/);
    expect(friendlyMoneroSendError(new Error('not enough unlocked money'))).toMatch(/Insufficient unlocked XMR/);
    expect(friendlyMoneroSendError(new Error('transaction would be too large'))).toMatch(/more than one Monero transaction/);
    expect(friendlyMoneroSendError(new Error('not enough outputs for specified ring size'))).toMatch(/decoys/);
    expect(friendlyMoneroSendError(new Error('daemon is busy'))).toMatch(/could not be reached/);
    // Unknown texts pass through unchanged rather than being swallowed.
    expect(friendlyMoneroSendError(new Error('something odd'))).toBe('something odd');
  });
});
