import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MoneroTxDraft, MoneroWalletHost } from '../services/chain/monero/scanner';

const hoisted = vi.hoisted(() => ({
  host: null as MoneroWalletHost | null,
}));

vi.mock('./liveStore', () => ({
  useLiveStore: { getState: () => ({ monero: { host: hoisted.host } }) },
}));

vi.mock('../services/chain/monero/address', () => ({
  isValidMoneroAddress: (a: string) => a.startsWith('4') && a.length > 20,
}));

// Small, honest stand-ins for Set A's real fees.ts contract (12-decimal piconero
// scale, an absolute 0.05 XMR cap that REFUSES rather than clamps).
vi.mock('../services/chain/monero/fees', () => {
  const MONERO_MAX_FEE_PICO = 50_000_000_000n;
  return {
    MONERO_MAX_FEE_PICO,
    formatXmr: (pico: bigint) => {
      const s = pico.toString().padStart(13, '0');
      const whole = s.slice(0, -12) || '0';
      const frac = s.slice(-12).replace(/0+$/, '');
      return frac ? `${whole}.${frac}` : whole;
    },
    parseXmr: (text: string) => {
      const t = text.trim();
      if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') throw new Error('Enter a valid amount.');
      const [w, f = ''] = t.split('.');
      if (f.length > 12) throw new Error('Too many decimal places.');
      return BigInt((w || '0') + f.padEnd(12, '0'));
    },
    assertMoneroFeeSane: (feePico: bigint) => {
      if (feePico > MONERO_MAX_FEE_PICO) throw new Error('Fee is unreasonably high; refusing to send.');
    },
  };
});

import { buildMoneroSendPlan, broadcastMoneroPlan, MoneroSendError } from './moneroSend';

const ADDR = '4address_valid_enough_for_the_fake_validator';

function fakeHost(overrides: Partial<MoneroWalletHost> = {}): MoneroWalletHost {
  const draft: MoneroTxDraft = {
    metadata: 'meta',
    hash: 'preview-hash',
    fee: 4_000_000n, // 0.000004 XMR, well under the cap
    amount: 1_000_000_000_000n, // 1 XMR
    sizeBytes: 1500,
    destination: ADDR,
    sweep: false,
  };
  return {
    walletId: 'w1',
    primaryAddress: vi.fn(),
    subaddresses: vi.fn(),
    createSubaddress: vi.fn(),
    sync: vi.fn(),
    balance: vi.fn(async () => ({ total: 2_000_000_000_000n, unlocked: 2_000_000_000_000n, height: 1, daemonHeight: 1 })),
    history: vi.fn(),
    buildTx: vi.fn(async () => draft),
    relay: vi.fn(async () => 'the-real-txid'),
    setRestoreHeight: vi.fn(),
    save: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as MoneroWalletHost;
}

describe('buildMoneroSendPlan', () => {
  beforeEach(() => {
    hoisted.host = null;
  });

  it('throws no-wallet with no open host', async () => {
    await expect(buildMoneroSendPlan({ to: ADDR, amount: '1', priority: 'normal', sweep: false })).rejects.toMatchObject({
      code: 'no-wallet',
    });
  });

  it('rejects an invalid/non-mainnet address before touching the host', async () => {
    hoisted.host = fakeHost();
    await expect(
      buildMoneroSendPlan({ to: 'notanaddress', amount: '1', priority: 'normal', sweep: false }),
    ).rejects.toMatchObject({ code: 'invalid-address' });
    expect((hoisted.host as MoneroWalletHost).buildTx).not.toHaveBeenCalled();
  });

  it('rejects an unparsable amount (non-sweep) before touching the host', async () => {
    hoisted.host = fakeHost();
    await expect(
      buildMoneroSendPlan({ to: ADDR, amount: 'not a number', priority: 'normal', sweep: false }),
    ).rejects.toMatchObject({ code: 'invalid-amount' });
  });

  it('rejects a zero amount', async () => {
    hoisted.host = fakeHost();
    await expect(
      buildMoneroSendPlan({ to: ADDR, amount: '0', priority: 'normal', sweep: false }),
    ).rejects.toMatchObject({ code: 'invalid-amount' });
  });

  it('sweep ignores the amount text entirely and still builds', async () => {
    const host = fakeHost();
    hoisted.host = host;
    await buildMoneroSendPlan({ to: ADDR, amount: 'garbage', priority: 'normal', sweep: true });
    expect(host.buildTx).toHaveBeenCalledWith({ to: ADDR, amountPico: 0n, priority: 'normal', sweep: true });
  });

  it('builds a plan with formatted fee/amount/total and passes priority through', async () => {
    const host = fakeHost();
    hoisted.host = host;
    const plan = await buildMoneroSendPlan({ to: ADDR, amount: '1', priority: 'elevated', sweep: false });
    expect(host.buildTx).toHaveBeenCalledWith({ to: ADDR, amountPico: 1_000_000_000_000n, priority: 'elevated', sweep: false });
    expect(plan.amountXmr).toBe('1');
    expect(plan.feeXmr).toBe('0.000004');
    expect(plan.totalXmr).toBe('1.000004');
    expect(plan.warnings).toEqual([]);
  });

  it('wraps a build failure (e.g. "not enough money") as build-failed', async () => {
    hoisted.host = fakeHost({ buildTx: vi.fn(async () => { throw new Error('not enough money'); }) });
    await expect(
      buildMoneroSendPlan({ to: ADDR, amount: '1', priority: 'normal', sweep: false }),
    ).rejects.toMatchObject({ code: 'build-failed', message: 'not enough money' });
  });

  it('REFUSES (never clamps) when the built fee exceeds the absolute cap', async () => {
    hoisted.host = fakeHost({
      buildTx: vi.fn(async () => ({
        metadata: 'm', hash: 'h', fee: 60_000_000_000n, amount: 1n, sizeBytes: 10, destination: ADDR, sweep: false,
      })),
    });
    await expect(
      buildMoneroSendPlan({ to: ADDR, amount: '1', priority: 'normal', sweep: false }),
    ).rejects.toMatchObject({ code: 'fee-unsafe' });
  });

  it('adds a locked-funds warning on a non-sweep send when unlocked < total', async () => {
    hoisted.host = fakeHost({
      balance: vi.fn(async () => ({ total: 2_000_000_000_000n, unlocked: 1_500_000_000_000n, height: 1, daemonHeight: 1 })),
    });
    const plan = await buildMoneroSendPlan({ to: ADDR, amount: '1', priority: 'normal', sweep: false });
    expect(plan.warnings).toEqual(['0.5 XMR of your balance is still locked and was not included in this send.']);
  });

  it('never fails the plan just because the best-effort balance re-read fails', async () => {
    hoisted.host = fakeHost({ balance: vi.fn(async () => { throw new Error('offline'); }) });
    const plan = await buildMoneroSendPlan({ to: ADDR, amount: '1', priority: 'normal', sweep: false });
    expect(plan.warnings).toEqual([]);
  });
});

describe('broadcastMoneroPlan', () => {
  beforeEach(() => {
    hoisted.host = null;
  });

  const draft: MoneroTxDraft = {
    metadata: 'meta', hash: 'h', fee: 1n, amount: 1n, sizeBytes: 1, destination: ADDR, sweep: false,
  };

  it('throws no-wallet with no open host', async () => {
    await expect(broadcastMoneroPlan({ draft, feeXmr: '0', amountXmr: '0', totalXmr: '0', warnings: [] })).rejects.toMatchObject({
      code: 'no-wallet',
    });
  });

  it('relays the plan draft through the open host and returns its txid', async () => {
    const host = fakeHost();
    hoisted.host = host;
    const result = await broadcastMoneroPlan({ draft, feeXmr: '0', amountXmr: '0', totalXmr: '0', warnings: [] });
    expect(host.relay).toHaveBeenCalledWith(draft);
    expect(result).toEqual({ txid: 'the-real-txid' });
  });

  it('wraps a relay failure as broadcast-failed', async () => {
    hoisted.host = fakeHost({ relay: vi.fn(async () => { throw new Error('daemon rejected'); }) });
    await expect(
      broadcastMoneroPlan({ draft, feeXmr: '0', amountXmr: '0', totalXmr: '0', warnings: [] }),
    ).rejects.toMatchObject({ code: 'broadcast-failed', message: 'daemon rejected' });
  });

  it('MoneroSendError is a real Error subclass', () => {
    const err = new MoneroSendError('no-wallet', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MoneroSendError');
  });
});
