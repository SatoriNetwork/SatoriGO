/**
 * @vitest-environment jsdom
 *
 * LiveSendTao against a mocked store AND a mocked taoSend.ts (that file's own
 * build/broadcast logic is covered by taoSend.test.ts; this file exercises
 * the SCREEN: form validation and hand-off, the review step's numbers and
 * warnings, the runtime-guard banner, the arm + password gate, and the
 * success step's "waiting for inclusion" state).
 *
 * The store fields `taoSend` / `loadingTaoSend` / `buildTaoSend` /
 * `confirmTaoSend` / `clearTaoSend` mirror `evmSend` / `loadingEvmSend` /
 * `quoteEvmSend` / `confirmEvmSend` / `clearEvmSend` exactly (the EVM
 * pattern, not Monero's direct-call one) — see taoSend.ts's file header and
 * the Set C report for why. They DO NOT EXIST on the real liveStore.ts yet
 * (Set D wires them in), so this test stands in a minimal fake with exactly
 * the shape this screen expects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  state: {
    tao: {
      chain: { key: 'bittensor', displayName: 'Bittensor' } as unknown,
      account: { exists: true, info: null, spendable: 2_000_000_000n, finalizedHash: '', finalizedNumber: 0 } as unknown,
      runtime: 'same' as 'same' | 'version-only' | 'layout-changed',
      pending: null as { state: 'pending' | 'included' | 'expired'; blockNumber?: number } | null,
      error: null as string | null,
      status: 'idle' as const,
    },
    taoSend: null as unknown,
    loadingTaoSend: false,
    buildTaoSend: vi.fn(),
    confirmTaoSend: vi.fn(),
    clearTaoSend: vi.fn(),
    wallets: [
      { id: 'w1', name: 'Bittensor', network: 'tao:mainnet', createdAt: 0, active: true, kind: 'seed', address: '5FromAddress', passwordless: false, family: 'substrate' },
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
  const walletsOnChain = (wallets: Array<{ family?: string }>, chainId: string) =>
    chainId === 'tao:mainnet' ? wallets.filter((w) => w.family === 'substrate') : [];
  return { useLiveStore, walletsOnChain };
});

vi.mock('../../store/taoSend', () => {
  class TaoSendError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'TaoSendError';
      this.code = code;
    }
  }
  return { TaoSendError };
});

import { LiveSendTao, friendlyTaoSendError, TAO_NO_FEE_ROOM_HINT, taoMaxFill, amountTouchesExistentialDeposit } from './LiveSendTao';
import { TaoSendError } from '../../store/taoSend';
import { NavProvider, type NavContextValue } from './LiveNav';

const NAV: NavContextValue = { tab: 'assets', section: 'home', openTab: vi.fn(), openSettings: vi.fn() };
const TO = '5ToRecipientAddressXXXXXXXXXXXXXXXXXXXXXXXXX1';

function renderScreen() {
  return render(
    <NavProvider value={NAV}>
      <LiveSendTao onBack={vi.fn()} onDone={vi.fn()} />
    </NavProvider>,
  );
}

const plan = {
  plan: { signed: { hex: '0x', hash: '0xhash', payload: new Uint8Array(), nonce: 7, eraPeriod: 64, checkpointNumber: 100 }, fee: 83_124n, builtAt: Date.now() },
  to: TO,
  sweep: false,
  amountRao: 1_000_000_000n,
  feeTao: '0.000083124',
  amountTao: '1',
  totalTao: '1.000083124',
  warnings: [] as string[],
};

describe('LiveSendTao', () => {
  beforeEach(() => {
    hoisted.state.tao.runtime = 'same';
    hoisted.state.tao.pending = null;
    hoisted.state.tao.account = { exists: true, info: null, spendable: 2_000_000_000n, finalizedHash: '', finalizedNumber: 0 } as unknown;
    hoisted.state.taoSend = null;
    hoisted.state.loadingTaoSend = false;
    hoisted.state.requirePasswordToSend = false;
    hoisted.state.wallets = [hoisted.state.wallets[0]];
    hoisted.state.addressBook = [];
    hoisted.state.addContact.mockClear();
    hoisted.state.buildTaoSend.mockReset();
    hoisted.state.confirmTaoSend.mockReset();
    hoisted.state.clearTaoSend.mockReset();
    hoisted.state.arm.mockClear();
  });
  afterEach(cleanup);

  it('requires a recipient before building', async () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(screen.getByText('Recipient address is required.')).toBeTruthy());
    expect(hoisted.state.buildTaoSend).not.toHaveBeenCalled();
  });

  it('Max fills a concrete amount: spendable minus the fee allowance, and the field stays editable', () => {
    // spendable is 2 TAO; allowance 100,000 rao plus the 10% margin = 110,000 rao.
    renderScreen();
    fireEvent.click(screen.getByTestId('live-tao-send-max'));
    const input = screen.getByTestId('live-tao-send-amount') as HTMLInputElement;
    expect(input).not.toBeDisabled();
    expect(input.value).toBe('1.99989');
    expect(taoMaxFill(2_000_000_000n)).toBe(1_999_890_000n);
    expect(taoMaxFill(50_000n)).toBe(0n);
  });

  it('Max sends that amount as an ordinary transfer (sweep: false)', async () => {
    hoisted.state.buildTaoSend.mockImplementation(async () => {
      hoisted.state.taoSend = plan;
    });
    renderScreen();
    fireEvent.click(screen.getByTestId('live-tao-send-max'));
    fireEvent.change(screen.getByTestId('live-tao-send-to'), { target: { value: TO } });
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(hoisted.state.buildTaoSend).toHaveBeenCalledWith({ to: TO, amount: '1.99989', sweep: false }));
  });

  it('a typed amount with no room for the fee shows the "tap Max" hint, and hides it otherwise', () => {
    renderScreen();
    const input = screen.getByTestId('live-tao-send-amount');
    fireEvent.change(input, { target: { value: '1' } });
    expect(screen.queryByTestId('live-tao-send-ed-hint')).toBeNull();
    fireEvent.change(input, { target: { value: '2' } });
    expect(screen.getByTestId('live-tao-send-ed-hint').textContent).toBe(TAO_NO_FEE_ROOM_HINT);
    expect(TAO_NO_FEE_ROOM_HINT).not.toMatch(/—/);
  });

  it('amountTouchesExistentialDeposit: at or above spendable is true, below, empty or malformed is false', () => {
    expect(amountTouchesExistentialDeposit('2', 2_000_000_000n)).toBe(true);
    expect(amountTouchesExistentialDeposit('2.5', 2_000_000_000n)).toBe(true);
    expect(amountTouchesExistentialDeposit('1.999999999', 2_000_000_000n)).toBe(false);
    expect(amountTouchesExistentialDeposit('', 2_000_000_000n)).toBe(false);
    expect(amountTouchesExistentialDeposit('abc', 2_000_000_000n)).toBe(false);
    expect(amountTouchesExistentialDeposit('0', 2_000_000_000n)).toBe(false);
  });

  it('submits to buildTaoSend with to/amount/sweep and shows the review on success', async () => {
    hoisted.state.buildTaoSend.mockImplementation(async () => {
      hoisted.state.taoSend = plan;
    });
    renderScreen();
    fireEvent.change(screen.getByTestId('live-tao-send-to'), { target: { value: TO } });
    fireEvent.change(screen.getByTestId('live-tao-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(hoisted.state.buildTaoSend).toHaveBeenCalledWith({ to: TO, amount: '1', sweep: false }));
    await waitFor(() => expect(screen.getByTestId('live-tao-send-review')).toBeTruthy());
    expect(screen.getByTestId('live-tao-send-fee').textContent).toContain('0.000083124');
    expect(screen.getByTestId('live-tao-send-total').textContent).toContain('1.000083124');
  });

  it('shows an inline field error when buildTaoSend rejects (any Set B TaoSendError code)', async () => {
    hoisted.state.buildTaoSend.mockRejectedValue(new TaoSendError('bad-call', 'Enter a valid Bittensor address.'));
    renderScreen();
    fireEvent.change(screen.getByTestId('live-tao-send-to'), { target: { value: 'bad' } });
    fireEvent.change(screen.getByTestId('live-tao-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(screen.getByText('Enter a valid Bittensor address.')).toBeTruthy());
  });

  it('renders every plan warning on the review step', async () => {
    hoisted.state.buildTaoSend.mockImplementation(async () => {
      hoisted.state.taoSend = { ...plan, warnings: ["Sends the rest of your balance."] };
    });
    renderScreen();
    fireEvent.change(screen.getByTestId('live-tao-send-to'), { target: { value: TO } });
    fireEvent.change(screen.getByTestId('live-tao-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-tao-send-warning-0').textContent).toBe('Sends the rest of your balance.'));
  });

  it('Confirm & Send is disabled until the arm checkbox is checked', async () => {
    hoisted.state.buildTaoSend.mockImplementation(async () => {
      hoisted.state.taoSend = plan;
    });
    renderScreen();
    fireEvent.change(screen.getByTestId('live-tao-send-to'), { target: { value: TO } });
    fireEvent.change(screen.getByTestId('live-tao-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-tao-broadcast')).toBeDisabled());
    fireEvent.click(screen.getByTestId('live-tao-arm-checkbox'));
    expect(screen.getByTestId('live-tao-broadcast')).not.toBeDisabled();
  });

  it('asks for the wallet password before broadcasting when requirePasswordToSend is on', async () => {
    hoisted.state.requirePasswordToSend = true;
    hoisted.state.verifyPassword = vi.fn(async () => false);
    hoisted.state.buildTaoSend.mockImplementation(async () => {
      hoisted.state.taoSend = plan;
    });
    renderScreen();
    fireEvent.change(screen.getByTestId('live-tao-send-to'), { target: { value: TO } });
    fireEvent.change(screen.getByTestId('live-tao-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-tao-send-password')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-tao-arm-checkbox'));
    fireEvent.change(screen.getByTestId('live-tao-send-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('live-tao-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-tao-send-password-error')).toBeTruthy());
    expect(hoisted.state.confirmTaoSend).not.toHaveBeenCalled();
  });

  it('broadcasts and shows the success step with the hash, an explorer link, and a waiting-for-inclusion state', async () => {
    hoisted.state.buildTaoSend.mockImplementation(async () => {
      hoisted.state.taoSend = plan;
    });
    hoisted.state.confirmTaoSend.mockResolvedValue({ hash: 'the-real-hash', explorerUrl: 'https://taostats.io/extrinsic/the-real-hash' });
    renderScreen();
    fireEvent.change(screen.getByTestId('live-tao-send-to'), { target: { value: TO } });
    fireEvent.change(screen.getByTestId('live-tao-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-tao-arm-checkbox')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-tao-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-tao-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-tao-send-hash').textContent).toContain('the-real-hash'));
    const link = screen.getByTestId('live-tao-send-explorer-link') as HTMLAnchorElement;
    expect(link.href).toBe('https://taostats.io/extrinsic/the-real-hash');
    expect(screen.getByTestId('live-tao-send-inclusion').textContent).toMatch(/waiting for inclusion/i);
  });

  it('a broadcast failure shows an inline error and stays on the review step', async () => {
    hoisted.state.buildTaoSend.mockImplementation(async () => {
      hoisted.state.taoSend = plan;
    });
    hoisted.state.confirmTaoSend.mockRejectedValue(new Error('not enough TAO for the fee'));
    renderScreen();
    fireEvent.change(screen.getByTestId('live-tao-send-to'), { target: { value: TO } });
    fireEvent.change(screen.getByTestId('live-tao-send-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(screen.getByTestId('live-tao-arm-checkbox')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-tao-arm-checkbox'));
    fireEvent.click(screen.getByTestId('live-tao-broadcast'));
    await waitFor(() => expect(screen.getByTestId('live-tao-send-error').textContent).toContain('not enough TAO for the fee'));
    expect(screen.getByTestId('live-tao-send-review')).toBeTruthy();
  });

  it('the runtime-update banner blocks Send while the form stays visible (design §10)', () => {
    hoisted.state.tao.runtime = 'layout-changed';
    renderScreen();
    expect(screen.getByTestId('live-tao-runtime-banner')).toBeTruthy();
    expect(screen.getByTestId('live-tao-send-submit')).toBeDisabled();
    // the fields are still rendered (Receive/Balance keep working elsewhere;
    // this screen only disables Send itself)
    expect(screen.getByTestId('live-tao-send-to')).toBeTruthy();
  });

  it('does not call buildTaoSend when the runtime guard is blocking', async () => {
    hoisted.state.tao.runtime = 'layout-changed';
    renderScreen();
    fireEvent.change(screen.getByTestId('live-tao-send-to'), { target: { value: TO } });
    fireEvent.click(screen.getByTestId('live-tao-send-submit'));
    await waitFor(() => expect(screen.getByText('Bittensor updated its network; update Satori GO to send.')).toBeTruthy());
    expect(hoisted.state.buildTaoSend).not.toHaveBeenCalled();
  });

  it('shows Available from tao.account.spendable, not the store balance row', () => {
    hoisted.state.tao.account = { exists: true, info: null, spendable: 1_500_000_000n, finalizedHash: '', finalizedNumber: 0 } as unknown;
    renderScreen();
    expect(screen.getByTestId('live-tao-send-available').textContent).toContain('1.5');
  });
});

describe('friendlyTaoSendError', () => {
  it('passes a Set B TaoSendError/TaoRuntimeChangedError message through unchanged', () => {
    const err = new TaoSendError('bad-call', 'Bittensor updated its network; update Satori GO to send.');
    expect(friendlyTaoSendError(err)).toBe('Bittensor updated its network; update Satori GO to send.');
  });

  it('does NOT misfire a reword on a message that merely contains the word "network"', () => {
    // The exact bug this file's header documents: a naive keyword reword once
    // turned the runtime-changed banner text into a generic gateway message.
    expect(friendlyTaoSendError(new Error('The Bittensor network is unreachable (state_getStorage): timeout'))).toBe(
      'The Bittensor network is unreachable (state_getStorage): timeout',
    );
  });

  it('passes an unrecognised error through unchanged', () => {
    expect(friendlyTaoSendError(new Error('some other node error'))).toBe('some other node error');
  });
});
