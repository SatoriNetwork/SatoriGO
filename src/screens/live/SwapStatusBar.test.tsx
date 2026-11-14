/**
 * @vitest-environment jsdom
 *
 * The bar on Home that follows a sent swap: what it says in each state, when it
 * can be closed, and that a confirmed swap clears itself.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import type { SwapStatus } from '../../store/evmSwap';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

const STATUS: SwapStatus = {
  txid: '0xabc',
  from: ME,
  chainKey: 'base',
  chainName: 'Base',
  explorerUrl: 'https://basescan.org/tx/0xabc',
  payAmount: '10',
  paySymbol: 'USDC',
  receiveAmount: '32.52',
  receiveSymbol: 'SATORI',
  state: 'pending',
};

type LiveStoreModule = typeof import('../../store/liveStore');
let storeMod: LiveStoreModule;
let SwapStatusBar: typeof import('./SwapStatusBar')['SwapStatusBar'];
let CLEAR_MS = 0;
const state = () => storeMod.useLiveStore.getState();
const show = (status: SwapStatus | null, activeChainKey = 'base', address = ME) => {
  storeMod.useLiveStore.setState({ swapStatus: status, address, evm: { ...state().evm, activeChainKey } } as never);
  return render(<SwapStatusBar />);
};
const bar = () => screen.getByTestId('live-swap-status');

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  setStorageForTests(new MemoryStorageAdapter());
  storeMod = await import('../../store/liveStore');
  const mod = await import('./SwapStatusBar');
  SwapStatusBar = mod.SwapStatusBar;
  CLEAR_MS = mod.SWAP_STATUS_CLEAR_MS;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SwapStatusBar', () => {
  it('draws nothing when no swap was sent, on another network, or for another account', () => {
    show(null);
    expect(screen.queryByTestId('live-swap-status')).toBeNull();
    cleanup();
    show(STATUS, 'ethereum');
    expect(screen.queryByTestId('live-swap-status')).toBeNull();
    cleanup();
    show(STATUS, 'base', '0x00000000000000000000000000000000000000a1');
    expect(screen.queryByTestId('live-swap-status')).toBeNull();
  });

  it('while it waits: says what is being swapped, links to the explorer, and cannot be closed', () => {
    show(STATUS);
    expect(bar().textContent).toContain('Swapping 10 USDC for SATORI');
    expect(bar().textContent).toContain('Waiting for Base to confirm');
    expect((screen.getByTestId('live-swap-status-view') as HTMLAnchorElement).href).toBe('https://basescan.org/tx/0xabc');
    expect(screen.queryByTestId('live-swap-status-close')).toBeNull();
  });

  it('confirmed: says so with the quoted amount, and clears itself', () => {
    vi.useFakeTimers();
    show({ ...STATUS, state: 'confirmed' });
    expect(bar().textContent).toContain('Swap complete');
    expect(bar().textContent).toContain('10 USDC for about 32.52 SATORI');
    act(() => {
      vi.advanceTimersByTime(CLEAR_MS + 10);
    });
    expect(state().swapStatus).toBeNull();
    expect(screen.queryByTestId('live-swap-status')).toBeNull();
  });

  it('failed: says nothing was swapped and the fee was paid, and stays until closed', () => {
    vi.useFakeTimers();
    show({ ...STATUS, state: 'failed' });
    expect(bar().textContent).toContain('Swap failed');
    expect(bar().textContent).toContain('Nothing was swapped. The network fee was still paid.');
    act(() => {
      vi.advanceTimersByTime(CLEAR_MS * 3);
    });
    expect(screen.getByTestId('live-swap-status')).toBeTruthy();
    fireEvent.click(screen.getByTestId('live-swap-status-close'));
    expect(state().swapStatus).toBeNull();
  });

  it('no answer in time: claims neither success nor failure', () => {
    show({ ...STATUS, state: 'late' });
    expect(bar().textContent).toContain('Swap still pending');
    expect(bar().textContent).toContain('It may still go through.');
    expect(bar().className).toContain('late');
  });
});
