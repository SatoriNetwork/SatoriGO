/**
 * @vitest-environment jsdom
 *
 * Network-fee choice on the Send screen (LiveSend + liveStore), against a
 * MOCKED LiveWalletService but the REAL store, so the chosen rate is verified
 * all the way through buildSend -> service.buildEvrSend(opts).
 *
 * What must hold (mirrors the engine's honesty contract):
 *  - a DIFFERENTIATED chain (real per-target curve) shows the speed selector,
 *    each option showing its own resulting amount, and the picked option's
 *    rate is the one the transaction is built with;
 *  - a NON-differentiated chain (one flat rate for every target — the common
 *    case) shows a single fee and NO speed buttons;
 *  - a custom rate below the chain floor or above the ceiling is refused with
 *    an inline message and is never submitted;
 *  - a failed estimate falls back to the chain's default rate without ever
 *    blocking the send.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Shared mutable config for the mocked service (vi.mock factories are hoisted
// above imports, so this must be created via vi.hoisted).
const h = vi.hoisted(() => ({
  /** LiveNetworkId the fake service reports as active. */
  network: 'mainnet' as string,
  /** What estimateFeeOptions resolves to (unknown to stay factory-local). */
  feeEstimate: undefined as unknown,
  /** When true, estimateFeeOptions rejects — exercising the store fallback. */
  feeReject: false,
  /** Every buildEvrSend call, so tests can assert the rate that reached it. */
  builds: [] as { to: string; amountSats: bigint; opts?: { feeRateSatPerByte?: bigint } }[],
}));

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    allowBroadcast = false;
    network() {
      return h.network;
    }
    async exists() {
      return true;
    }
    isUnlocked() {
      return true;
    }
    async listWallets() {
      return [];
    }
    getProvider() {
      return {};
    }
    async estimateFeeOptions() {
      if (h.feeReject) throw new Error('probe-failed');
      return h.feeEstimate;
    }
    async buildEvrSend(to: string, amountSats: bigint, opts?: { feeRateSatPerByte?: bigint }) {
      h.builds.push({ to, amountSats, opts });
      return {
        built: { rawHex: '00', txid: 'ab'.repeat(32), virtualSize: 226, feeSats: 226n },
        toAddress: to,
        amountSats,
        feeSats: 226n,
      };
    }
    async buildAssetSend() {
      throw new Error('not-used-in-these-tests');
    }
    async estimateMaxEvr() {
      return { maxSats: 0n, feeSats: 0n, totalSats: 0n };
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

// Bottom nav is irrelevant here.
vi.mock('./LiveNav', () => ({ LiveNav: () => null }));

import { LiveSend } from './LiveSend';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

// Real, checksum-valid P2PKH addresses of the two chains under test.
const EVR_RECIPIENT = 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF';
const BTC_RECIPIENT = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

/** Typical preview size the screen uses for a native send (1 in, 2 out). */
const TYPICAL_BYTES = 226n;

function walletState(network: string, ticker: string) {
  return {
    phase: 'ready' as const,
    wallets: [
      {
        id: 'w1',
        name: 'Test Wallet',
        network,
        createdAt: 0,
        active: true,
        kind: 'seed' as const,
        address: '',
        passwordless: true,
      },
    ],
    activeWalletId: 'w1',
    assets: [{ name: ticker, amount: 5, decimals: 8, isNative: true }],
    pinnedAssets: [],
    hiddenAssets: [],
    addressBook: [],
    requirePasswordToSend: false,
    error: null,
    loadingSend: false,
    sendPlan: null,
  };
}

/** A flat (non-differentiated) estimate the way the engine reports one. */
function flatEstimate(chainId: string, rate: bigint, floor: bigint, ceiling: bigint) {
  return {
    chainId,
    differentiated: false,
    options: [2, 6, 25].map((targetBlocks) => ({ targetBlocks, satPerByte: rate, estimated: true })),
    defaultSatPerByte: rate,
    floorSatPerByte: floor,
    ceilingSatPerByte: ceiling,
  };
}

function fillAndSubmit(recipient: string, amount = '1') {
  fireEvent.change(screen.getByTestId('live-send-to'), { target: { value: recipient } });
  fireEvent.change(screen.getByTestId('live-send-amount'), { target: { value: amount } });
  fireEvent.click(screen.getByRole('button', { name: /Review transaction/i }));
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  h.builds = [];
  h.feeReject = false;
});

afterEach(cleanup);

describe('LiveSend fee choice — differentiated chain (real per-target curve)', () => {
  beforeEach(() => {
    h.network = 'bitcoin-mainnet';
    h.feeEstimate = {
      chainId: 'bitcoin-mainnet',
      differentiated: true,
      options: [
        { targetBlocks: 2, satPerByte: 5n, estimated: true },
        { targetBlocks: 6, satPerByte: 3n, estimated: true },
        { targetBlocks: 25, satPerByte: 1n, estimated: true },
      ],
      defaultSatPerByte: 2n,
      floorSatPerByte: 1n,
      ceilingSatPerByte: 500n,
    };
    useLiveStore.setState(walletState('bitcoin-mainnet', 'BTC'));
  });

  it('shows the speed selector with each option carrying its own resulting amount', async () => {
    render(<LiveSend onBack={() => {}} />);
    const fast = await screen.findByTestId('live-fee-option-fast');
    const normal = screen.getByTestId('live-fee-option-normal');
    const slow = screen.getByTestId('live-fee-option-slow');
    // Each option shows the REAL resulting amount at its rate (rate × 226 B).
    expect(fast).toHaveTextContent('0.0000113'); // 5 sat/B
    expect(normal).toHaveTextContent('0.00000678'); // 3 sat/B
    expect(slow).toHaveTextContent('0.00000226'); // 1 sat/B
    // Normal (the 6-block target) is the pre-picked option; the headline is
    // the amount in the chain's own coin, with the rate as secondary detail.
    expect(normal).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('live-fee-amount')).toHaveTextContent('~0.00000678 BTC');
    expect(screen.getByTestId('live-fee-rate')).toHaveTextContent('3 sat/byte');
  });

  it('builds the transaction at the PICKED rate', async () => {
    render(<LiveSend onBack={() => {}} />);
    fireEvent.click(await screen.findByTestId('live-fee-option-slow'));
    expect(screen.getByTestId('live-fee-option-slow')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('live-fee-amount')).toHaveTextContent('~0.00000226 BTC');

    fillAndSubmit(BTC_RECIPIENT, '0.5');
    await waitFor(() => expect(h.builds).toHaveLength(1));
    expect(h.builds[0].to).toBe(BTC_RECIPIENT);
    expect(h.builds[0].amountSats).toBe(50_000_000n);
    expect(h.builds[0].opts?.feeRateSatPerByte).toBe(1n);
    // The chosen rate is what reaches the review step (the plan the service
    // built from it is the one shown).
    expect(await screen.findByTestId('live-send-review')).toBeInTheDocument();
  });
});

describe('LiveSend fee choice — duplicate rates inside a real spread (live Ravencoin shape)', () => {
  /** The estimate observed live on Ravencoin 2026-08-14: a REAL fast-vs-rest
   *  spread (differentiated), but normal and slow answer the same rate — so
   *  rendering all three chips showed two with identical amounts. */
  function rvnEstimate(rates: [bigint, bigint, bigint]) {
    return {
      chainId: 'ravencoin-mainnet',
      differentiated: true,
      options: [2, 6, 25].map((targetBlocks, i) => ({
        targetBlocks,
        satPerByte: rates[i],
        estimated: true,
      })),
      defaultSatPerByte: 1042n,
      floorSatPerByte: 1000n,
      ceilingSatPerByte: 10_000n,
    };
  }

  beforeEach(() => {
    h.network = 'ravencoin-mainnet';
    useLiveStore.setState(walletState('ravencoin-mainnet', 'RVN'));
  });

  it('collapses normal == slow into two chips with distinct amounts, Normal pre-picked', async () => {
    h.feeEstimate = rvnEstimate([1860n, 1006n, 1006n]);
    render(<LiveSend onBack={() => {}} />);
    const fast = await screen.findByTestId('live-fee-option-fast');
    const normal = screen.getByTestId('live-fee-option-normal');
    // The 25-block chip is gone: it carried the same amount as Normal, which
    // is no choice at all.
    expect(screen.queryByTestId('live-fee-option-slow')).toBeNull();
    expect(fast).toHaveTextContent('0.0042036'); // 1860 sat/B × 226 B
    expect(normal).toHaveTextContent('0.00227356'); // 1006 sat/B × 226 B
    expect(normal).toHaveAttribute('aria-pressed', 'true');
    expect(fast).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('live-fee-amount')).toHaveTextContent('~0.00227356 RVN');
  });

  it('fast == normal keeps the FAST label, and the default 6-block pick highlights it (rate match)', async () => {
    h.feeEstimate = rvnEstimate([1860n, 1860n, 1006n]);
    render(<LiveSend onBack={() => {}} />);
    const fast = await screen.findByTestId('live-fee-option-fast');
    const slow = screen.getByTestId('live-fee-option-slow');
    expect(screen.queryByTestId('live-fee-option-normal')).toBeNull();
    // The default (unpicked) option is still the 6-block target; its rate now
    // lives on the surviving Fast chip, which must therefore show as picked —
    // the highlight follows the RATE, not the collapsed-away target number.
    expect(fast).toHaveAttribute('aria-pressed', 'true');
    expect(slow).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('live-fee-amount')).toHaveTextContent('~0.0042036 RVN');
  });
});

describe('LiveSend fee choice — non-differentiated chain (one flat rate)', () => {
  beforeEach(() => {
    h.network = 'mainnet'; // Evrmore
    h.feeEstimate = flatEstimate('evrmore-mainnet', 1650n, 1000n, 10_000n);
    useLiveStore.setState(walletState('mainnet', 'EVR'));
  });

  it('shows a single fee and NO speed buttons', async () => {
    render(<LiveSend onBack={() => {}} />);
    const amount = await screen.findByTestId('live-fee-amount');
    // 1650 sat/B × 226 B = 372,900 sats.
    expect(amount).toHaveTextContent('~0.003729 EVR');
    expect(screen.getByTestId('live-fee-rate')).toHaveTextContent('1650 sat/byte');
    expect(screen.getByTestId('live-fee-rate')).toHaveTextContent('current network rate');
    for (const key of ['fast', 'normal', 'slow']) {
      expect(screen.queryByTestId(`live-fee-option-${key}`)).toBeNull();
    }
    // The smoke-asserted fee note is still present, exactly once.
    expect(screen.getAllByTestId('live-send-fee-note')).toHaveLength(1);
  });

  it('builds at the flat network rate without any selector interaction', async () => {
    render(<LiveSend onBack={() => {}} />);
    await screen.findByTestId('live-fee-amount');
    fillAndSubmit(EVR_RECIPIENT);
    await waitFor(() => expect(h.builds).toHaveLength(1));
    expect(h.builds[0].opts?.feeRateSatPerByte).toBe(1650n);
  });

  it('refuses a custom rate below the chain floor, with a message, and never submits it', async () => {
    render(<LiveSend onBack={() => {}} />);
    await screen.findByTestId('live-fee-amount');
    fireEvent.click(screen.getByTestId('live-fee-custom-toggle'));
    fireEvent.change(screen.getByTestId('live-fee-custom'), { target: { value: '500' } });
    expect(screen.getByTestId('live-fee-custom-error')).toHaveTextContent(
      'Too low. This network does not relay transactions under 1000 sat/byte.',
    );
    fillAndSubmit(EVR_RECIPIENT);
    // Give any (wrong) async build a tick to surface, then assert none ran.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.builds).toHaveLength(0);
  });

  it('refuses a custom rate above the chain ceiling, with a message, and never submits it', async () => {
    render(<LiveSend onBack={() => {}} />);
    await screen.findByTestId('live-fee-amount');
    fireEvent.click(screen.getByTestId('live-fee-custom-toggle'));
    fireEvent.change(screen.getByTestId('live-fee-custom'), { target: { value: '20000' } });
    expect(screen.getByTestId('live-fee-custom-error')).toHaveTextContent(
      'Too high. This wallet caps the rate at 10000 sat/byte on this network.',
    );
    fillAndSubmit(EVR_RECIPIENT);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.builds).toHaveLength(0);
  });

  it('accepts an in-bounds custom rate, recomputes the amount live, and builds with it', async () => {
    render(<LiveSend onBack={() => {}} />);
    await screen.findByTestId('live-fee-amount');
    fireEvent.click(screen.getByTestId('live-fee-custom-toggle'));
    fireEvent.change(screen.getByTestId('live-fee-custom'), { target: { value: '2000' } });
    expect(screen.queryByTestId('live-fee-custom-error')).toBeNull();
    // 2000 sat/B × 226 B = 452,000 sats — recomputed live in the headline.
    expect(screen.getByTestId('live-fee-amount')).toHaveTextContent('~0.00452 EVR');
    expect(screen.getByTestId('live-fee-rate')).toHaveTextContent('custom rate');

    fillAndSubmit(EVR_RECIPIENT);
    await waitFor(() => expect(h.builds).toHaveLength(1));
    expect(h.builds[0].opts?.feeRateSatPerByte).toBe(2000n);
  });
});

describe('LiveSend fee choice — estimate failure', () => {
  beforeEach(() => {
    h.network = 'mainnet'; // Evrmore
    h.feeReject = true; // service estimate blows up entirely
    useLiveStore.setState(walletState('mainnet', 'EVR'));
  });

  it('falls back to the chain default rate, says so, and never blocks the send', async () => {
    render(<LiveSend onBack={() => {}} />);
    const rateLine = await screen.findByTestId('live-fee-rate');
    // The store degrades to the chain's static policy (EVR default 1650), and
    // the panel names it a default instead of passing it off as an estimate.
    expect(rateLine).toHaveTextContent('1650 sat/byte');
    expect(rateLine).toHaveTextContent('network default rate');
    for (const key of ['fast', 'normal', 'slow']) {
      expect(screen.queryByTestId(`live-fee-option-${key}`)).toBeNull();
    }

    fillAndSubmit(EVR_RECIPIENT);
    await waitFor(() => expect(h.builds).toHaveLength(1));
    expect(h.builds[0].opts?.feeRateSatPerByte).toBe(1650n);
    expect(await screen.findByTestId('live-send-review')).toBeInTheDocument();
  });
});

// Sanity: the preview arithmetic the assertions above rely on.
it('preview size constant matches a typical 1-input 2-output legacy transaction', async () => {
  const { estimateTxBytes } = await import('../../services/chain/txBuilder');
  expect(BigInt(estimateTxBytes(1, 2))).toBe(TYPICAL_BYTES);
});
