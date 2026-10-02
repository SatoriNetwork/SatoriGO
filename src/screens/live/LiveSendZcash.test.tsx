/**
 * @vitest-environment jsdom
 *
 * LiveSendZcash against a mocked store AND a mocked zcashSend.ts (that
 * file's own build/broadcast logic is covered by zcashSend.test.ts; this
 * file exercises the SCREEN: form validation and hand-off, the review step's
 * numbers and expiry, the arm + password gate, and the success step). The
 * real liveStore.ts does not carry a `zcash` slice yet (Set D's wiring lands
 * separately, §15) — same not-yet-wired-store discipline as
 * LiveSendMonero.test.tsx / LiveReceiveZcash.test.tsx.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

/** One spendable coin as the reader hands it over (snapshot.spendable). */
const coin = (valueZat: bigint, index = 0, over: Record<string, unknown> = {}) => ({
  txid: 'aa'.repeat(32), index, valueZat, script: new Uint8Array(25), height: 100, address: 't1primary', coinbase: false, ...over,
});
/** Confirmed 2 ZEC, of which 1.5 ZEC is spendable (the rest is held back for a
 *  pending send, or coinbase): Available is the 1.5. */
const SNAPSHOT = () => ({ confirmed: 200_000_000n, spendable: [coin(150_000_000n)] }) as unknown;

const BASE_WALLET = { id: 'w1', name: 'Zcash', network: 'zec:mainnet', createdAt: 0, active: true, kind: 'seed', address: 't1primary', passwordless: false, family: 'zcash' };

const hoisted = vi.hoisted(() => ({
  state: {
    zcash: {
      chain: { key: 'zcash', displayName: 'Zcash', explorerTxUrl: 'https://mainnet.zcashexplorer.app/transactions/{txid}' } as unknown,
      snapshot: null as unknown,
      error: null,
      status: 'idle',
    },
    wallets: [] as Array<Record<string, unknown>>,
    activeWalletId: 'w1',
    addressBook: [] as Array<{ label: string; address: string }>,
    addContact: vi.fn((_label: string, _address: string) => ({ ok: true as const })),
    requirePasswordToSend: false,
    verifyPassword: vi.fn(async () => true),
    arm: vi.fn(),
    // The store's arming gate around zcashSend.ts's relay (the screen never
    // calls broadcastZcashPlan itself); stands in for liveStore.confirmZcashSend.
    confirmZcashSend: vi.fn((...args: unknown[]) => zcashSendMock.broadcast(...args)),
    refresh: vi.fn(async () => {}),
  },
}));

vi.mock('../../store/liveStore', () => {
  const useLiveStore = (selector: (s: typeof hoisted.state) => unknown) => selector(hoisted.state);
  useLiveStore.getState = () => hoisted.state;
  // The real helper scopes by family; the Zcash target is exactly the
  // 'zcash' family (mirrors the Monero screen test's own stand-in).
  const walletsOnChain = (wallets: Array<{ family?: string }>, chainId: string) =>
    chainId === 'zec:mainnet' ? wallets.filter((w) => w.family === 'zcash') : [];
  return { useLiveStore, walletsOnChain };
});

vi.mock('../../services/chain/zcash/address', () => ({
  isValidZcashRecipient: (a: string) => a.startsWith('t1') || a.startsWith('t3') || a.startsWith('tex1'),
}));

const zcashSendMock = vi.hoisted(() => ({
  build: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../../store/zcashSend', () => {
  class ZcashSendError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'ZcashSendError';
      this.code = code;
    }
  }
  return {
    ZcashSendError,
    buildZcashSendPlan: (...args: unknown[]) => zcashSendMock.build(...args),
    broadcastZcashPlan: (...args: unknown[]) => zcashSendMock.broadcast(...args),
  };
});

import { LiveSendZcash, friendlyZcashSendError } from './LiveSendZcash';
import { ZcashSendError } from '../../store/zcashSend';
import { NavProvider, type NavContextValue } from './LiveNav';

const NAV: NavContextValue = { tab: 'assets', section: 'home', openTab: vi.fn(), openSettings: vi.fn() };
const ADDR = 't1destinationAddress';

function renderScreen() {
  return render(
    <NavProvider value={NAV}>
      <LiveSendZcash onBack={vi.fn()} onDone={vi.fn()} />
    </NavProvider>,
  );
}

const plan = {
  signed: { hex: 'cafe', txid: 'the-real-txid', fee: 10_000n, amount: 100_000_000n, change: 0n, expiryHeight: 3_500_041, inputs: [], sizeBytes: 241 },
  feeZec: '0.0001',
  amountZec: '1',
  totalZec: '1.0001',
  expiresInBlocks: 41,
  warnings: [] as string[],
};

describe('LiveSendZcash', () => {
  beforeEach(() => {
    hoisted.state.zcash.snapshot = SNAPSHOT();
    hoisted.state.requirePasswordToSend = false;
    hoisted.state.activeWalletId = 'w1';
    hoisted.state.wallets = [{ ...BASE_WALLET }];
    hoisted.state.addressBook = [];
    hoisted.state.addContact.mockClear();
    zcashSendMock.build.mockReset();
    zcashSendMock.broadcast.mockReset();
  });
  afterEach(cleanup);

  it('shows a closed banner when no Zcash wallet is active', () => {
    hoisted.state.wallets = [];
    hoisted.state.activeWalletId = null as unknown as string;
    renderScreen();
    expect(screen.getByTestId('live-zec-send-closed')).toBeTruthy();
    hoisted.state.activeWalletId = 'w1';
  });

  it('requires a recipient before building', async () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('live-zec-send-submit'));
    await waitFor(() => expect(screen.getByText('Recipient address is required.')).toBeTruthy());
    expect(zcashSendMock.build).not.toHaveBeenCalled();
  });

  it('Max sets sweep and fills the exact sweep amount (coins minus the ZIP-317 fee)', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('live-zec-send-sweep'));
    const input = screen.getByTestId('live-zec-send-amount') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    // 1.5 ZEC, one coin, one output: fee 10,000 zat.
    expect(input.value).toBe('1.4999');
  });

  it('Available, the % chips and Max read the spendable coins, not the confirmed balance', () => {
    renderScreen();
    expect(screen.getByTestId('live-zec-send-available').textContent).toBe('Available: 1.5 ZEC');
    fireEvent.click(screen.getByTestId('live-zec-send-amt-50'));
    expect((screen.getByTestId('live-zec-send-amount') as HTMLInputElement).value).toBe('0.75');
  });

  it('Max is disabled while nothing is spendable, even with a confirmed balance (held back or coinbase)', () => {
    hoisted.state.zcash.snapshot = { confirmed: 200_000_000n, spendable: [] } as unknown;
    renderScreen();
    expect(screen.getByTestId('live-zec-send-sweep')).toBeDisabled();
    expect(screen.getByTestId('live-zec-send-available').textContent).toBe('Available: 0 ZEC');
  });

  it('Max says why when the sweep would pass the fee cap (more than 200 coins)', () => {
    hoisted.state.zcash.snapshot = { confirmed: 201n * 100_000n, spendable: Array.from({ length: 201 }, (_, i) => coin(100_000n, i)) } as unknown;
    renderScreen();
    fireEvent.click(screen.getByTestId('live-zec-send-sweep'));
    expect(screen.getByText(/above this wallet's cap of 0\.01 ZEC/)).toBeTruthy();
    expect((screen.getByTestId('live-zec-send-amount') as HTMLInputElement).disabled).toBe(false);
  });

  it('submits to buildZcashSendPlan with to/amount/sweep and shows the review with fee/total/expiry on success', async () => {
    zcashSendMock.build.mockResolvedValue(plan);
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-zec-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-zec-send-submit'));
    await waitFor(() => expect(zcashSendMock.build).toHaveBeenCalledWith({ to: ADDR, amount: '1', sweep: false }));
    await waitFor(() => expect(screen.getByTestId('live-zec-send-review')).toBeTruthy());
    expect(screen.getByTestId('live-zec-send-fee').textContent).toContain('0.0001');
    expect(screen.getByTestId('live-zec-send-total').textContent).toContain('1.0001');
    expect(screen.getByTestId('live-zec-send-expiry').textContent).toContain('41 blocks');
  });

  it('shows an inline field error when the plan build fails with invalid-address', async () => {
    zcashSendMock.build.mockRejectedValue(new ZcashSendError('invalid-address', 'Enter a valid Zcash address (t1, t3 or tex1).'));
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: 'bad' } });
    fireEvent.change(screen.getByTestId('live-zec-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-zec-send-submit'));
    await waitFor(() => expect(screen.getByText('Enter a valid Zcash address (t1, t3 or tex1).')).toBeTruthy());
  });

  it('shows the exact §3.3 shielded refusal wording inline', async () => {
    zcashSendMock.build.mockRejectedValue(
      new ZcashSendError(
        'invalid-address',
        'This is a shielded Zcash address. Satori GO sends to transparent addresses only (t1, t3 or tex1). Ask the recipient for a transparent address.',
      ),
    );
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: 'u1something' } });
    fireEvent.change(screen.getByTestId('live-zec-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-zec-send-submit'));
    await waitFor(() => expect(screen.getByText(/Ask the recipient for a transparent address/)).toBeTruthy());
  });

  it('Confirm & Send is disabled until the arm checkbox is checked', async () => {
    zcashSendMock.build.mockResolvedValue(plan);
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-zec-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-zec-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-zec-broadcast')).toBeDisabled());
    fireEvent.click(screen.getByTestId('live-zec-arm-checkbox'));
    expect(screen.getByTestId('live-zec-broadcast')).not.toBeDisabled();
  });

  it('asks for the wallet password before broadcasting when requirePasswordToSend is on', async () => {
    hoisted.state.requirePasswordToSend = true;
    hoisted.state.verifyPassword = vi.fn(async () => false);
    zcashSendMock.build.mockResolvedValue(plan);
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-zec-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-zec-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-zec-send-password')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-zec-arm-checkbox'));
    fireEvent.change(screen.getByTestId('live-zec-send-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('live-zec-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-zec-send-password-error')).toBeTruthy());
    expect(zcashSendMock.broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts THROUGH the store gate (confirmZcashSend, with the typed recipient) and shows the success step with the txid and an explorer link', async () => {
    zcashSendMock.build.mockResolvedValue(plan);
    zcashSendMock.broadcast.mockResolvedValue({ txid: 'the-real-txid' });
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-zec-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-zec-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-zec-arm-checkbox')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-zec-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-zec-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-zec-send-txid').textContent).toContain('the-real-txid'));
    expect(hoisted.state.confirmZcashSend).toHaveBeenCalledWith(plan, { to: ADDR });
    expect(screen.getByTestId('live-zec-send-success')).toBeTruthy();
    const link = screen.getByTestId('live-zec-send-explorer-link') as HTMLAnchorElement;
    expect(link.href).toBe('https://mainnet.zcashexplorer.app/transactions/the-real-txid');
  });

  it('a broadcast-unknown error (the 504 gateway deviation) leaves the review step: pending variant with the txid, no way to re-post the same bytes', async () => {
    zcashSendMock.build.mockResolvedValue(plan);
    zcashSendMock.broadcast.mockRejectedValue(
      new ZcashSendError('broadcast-unknown', 'The network did not confirm this send was received. It may still go through: check Activity for this transaction before sending again.'),
    );
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-zec-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-zec-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-zec-arm-checkbox')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-zec-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-zec-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-zec-send-unknown')).toBeTruthy());
    // The wallet's own txid (a ZIP-244 digest) is what Activity looks up.
    expect(screen.getByTestId('live-zec-send-txid').textContent).toContain('the-real-txid');
    expect(screen.getByTestId('live-zec-send-unknown').textContent).toMatch(/Check Activity before sending again/);
    // The review step and its Confirm & Send button are gone: the gateway
    // contract for this answer is "never re-send".
    expect(screen.queryByTestId('live-zec-send-review')).toBeNull();
    expect(screen.queryByTestId('live-zec-broadcast')).toBeNull();
    expect(zcashSendMock.broadcast).toHaveBeenCalledTimes(1);
    // And the gate was closed again by the screen (the store closes it too).
    expect(hoisted.state.arm).toHaveBeenLastCalledWith(false);
  });

  it('a definite broadcast failure stays on the review step with the message inline', async () => {
    zcashSendMock.build.mockResolvedValue(plan);
    zcashSendMock.broadcast.mockRejectedValue(new ZcashSendError('broadcast-failed', 'The Zcash network rejected this transaction (code -25).'));
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: ADDR } });
    fireEvent.change(screen.getByTestId('live-zec-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-zec-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-zec-arm-checkbox')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-zec-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-zec-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-zec-send-error').textContent).toMatch(/rejected this transaction/));
    expect(screen.getByTestId('live-zec-send-review')).toBeTruthy();
  });

  it('Max is disabled while the confirmed balance is 0 (nothing to sweep)', () => {
    hoisted.state.zcash.snapshot = { confirmed: 0n, spendable: [] } as unknown;
    renderScreen();
    expect(screen.getByTestId('live-zec-send-sweep')).toBeDisabled();
  });

  it('offers the address book scoped to valid Zcash addresses, and fills the recipient', () => {
    hoisted.state.addressBook = [
      { label: 'ZEC friend', address: 't3friend' },
      { label: 'BTC friend', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' },
    ];
    renderScreen();
    const select = screen.getByTestId('live-zec-send-contacts') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(options).toEqual(['t3friend']);
    fireEvent.change(select, { target: { value: 't3friend' } });
    expect((screen.getByTestId('live-zec-send-to') as HTMLInputElement).value).toBe('t3friend');
  });

  it("offers the user's OTHER Zcash wallets (never a UTXO or Monero one, never itself)", () => {
    hoisted.state.wallets = [
      hoisted.state.wallets[0],
      { id: 'w2', name: 'Imported ZEC', network: 'zec:mainnet', createdAt: 1, active: false, kind: 'seed', address: 't1other', passwordless: false, family: 'zcash' },
      { id: 'w3', name: 'Monero', network: 'xmr:mainnet', createdAt: 1, active: false, kind: 'seed', address: '4monero', passwordless: false, family: 'monero' },
    ];
    renderScreen();
    expect(screen.getByTestId('live-zec-send-wallet-0').textContent).toContain('Imported ZEC');
    expect(screen.queryByTestId('live-zec-send-wallet-1')).toBeNull();
    fireEvent.click(screen.getByTestId('live-zec-send-wallet-0'));
    expect((screen.getByTestId('live-zec-send-to') as HTMLInputElement).value).toBe('t1other');
  });

  it('can save a typed Zcash recipient to the address book', () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: 't3friend' } });
    fireEvent.click(screen.getByTestId('live-zec-send-save-contact'));
    fireEvent.change(screen.getByTestId('live-zec-send-contact-label'), { target: { value: 'ZEC friend' } });
    fireEvent.click(screen.getByTestId('live-zec-send-contact-save'));
    expect(hoisted.state.addContact).toHaveBeenCalledWith('ZEC friend', 't3friend');
    expect(screen.getByText('Saved to address book.')).toBeTruthy();
  });

  it('does not offer to save an invalid address or one of the user\'s own wallets', () => {
    hoisted.state.wallets = [
      hoisted.state.wallets[0],
      { id: 'w2', name: 'Imported ZEC', network: 'zec:mainnet', createdAt: 1, active: false, kind: 'seed', address: 't1other', passwordless: false, family: 'zcash' },
    ];
    renderScreen();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: 'not an address' } });
    expect(screen.queryByTestId('live-zec-send-save-contact')).toBeNull();
    fireEvent.change(screen.getByTestId('live-zec-send-to'), { target: { value: 't1other' } });
    expect(screen.queryByTestId('live-zec-send-save-contact')).toBeNull();
  });

  it('shows "Loading…" for Available before a snapshot has loaded', () => {
    hoisted.state.zcash.snapshot = null;
    renderScreen();
    expect(screen.getByTestId('live-zec-send-available').textContent).toContain('Loading');
  });

  it('friendlyZcashSendError passes a ZcashSendError message straight through, and gives a generic fallback otherwise', () => {
    expect(friendlyZcashSendError(new ZcashSendError('build-failed', 'Not enough funds.'))).toBe('Not enough funds.');
    expect(friendlyZcashSendError(new Error('boom'))).toBe('boom');
    expect(friendlyZcashSendError('not an error')).toMatch(/Something went wrong/);
  });
});
