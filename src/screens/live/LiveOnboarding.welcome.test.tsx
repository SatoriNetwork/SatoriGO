/**
 * @vitest-environment jsdom
 *
 * The first-run WELCOME step: structure and copy.
 *
 * This screen was rebuilt for presentation (constellation background, a
 * breathing mark, a staggered entrance, vertically centred content) and the one
 * thing that rebuild must never do is move the ground under the smoke: the live
 * smoke drives onboarding by the BUTTON LABELS ("Create new wallet", "Import
 * recovery phrase") and by `live-choose-pk`, and every other onboarding test
 * clicks its way in from here. So the assertions below are about what those
 * depend on: the three actions, in order, with their labels and testids intact.
 *
 * The copy assertions are the owner's two standing rules made testable: the
 * identity line is "non-custodial multi-chain wallet made by Satori Network"
 * and it names no chain, and no user-facing string in this screen carries an
 * em-dash.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    async exists() {
      return false;
    }
    async listWallets() {
      return [];
    }
    activeWalletId() {
      return null;
    }
    isUnlocked() {
      return false;
    }
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { LiveOnboarding } from './LiveOnboarding';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  useLiveStore.setState({ pendingMnemonic: null, addingWallet: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('first-run welcome step', () => {
  it('offers the three actions, in order, with their labels and testids', () => {
    render(<LiveOnboarding />);
    const labels = screen
      .getAllByRole('button')
      .map((b) => (b.textContent ?? '').trim())
      .filter(Boolean);
    expect(labels).toEqual([
      'Create new wallet',
      'Import recovery phrase',
      'Import private key (Satori)',
    ]);
    // The private-key action is the one the smoke reaches by testid.
    expect(screen.getByTestId('live-choose-pk')).toHaveTextContent('Import private key (Satori)');
  });

  it('leads with the product name and the brand line, naming no chain', () => {
    render(<LiveOnboarding />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Satori GO');
    const sub = screen.getByText(/non-custodial multi-chain wallet made by Satori Network/i);
    expect(sub).toBeInTheDocument();
    // House rule: descriptions must not enumerate chains.
    expect(sub.textContent).not.toMatch(/evrmore|ravencoin|bitcoin|ethereum|litecoin/i);
  });

  it('uses no em-dash anywhere on the screen', () => {
    render(<LiveOnboarding />);
    expect(screen.getByTestId('live-onboarding').textContent ?? '').not.toContain('—');
  });

  it('puts the constellation field behind the content', () => {
    render(<LiveOnboarding />);
    const frame = screen.getByTestId('live-onboarding');
    const field = screen.getByTestId('constellation-field');
    // A direct child of the frame, BEFORE .app-content: the content carries
    // z-index 1 and the field paints under it.
    expect(field.parentElement).toBe(frame);
    expect(field.nextElementSibling?.className).toContain('app-content');
    expect(field).toHaveAttribute('aria-hidden', 'true');
  });

  it('centres the welcome block in the panel', () => {
    render(<LiveOnboarding />);
    const content = screen.getByTestId('live-onboarding').querySelector('.app-content');
    // The same pure-flex auto-margin centring Home uses: the class is the whole
    // mechanism, so it is what there is to assert.
    expect(content?.className).toContain('welcome-centered');
    expect(content?.querySelector('.welcome-wow')).not.toBeNull();
  });

  it('staggers the entrance without touching the actions themselves', () => {
    render(<LiveOnboarding />);
    const root = screen.getByTestId('live-onboarding');
    // The mark sails in ONCE on its own one-shot arrival (owner, 2026-08-25:
    // "to its final position, once, no loop"), so it is no longer one of the
    // staggered risers.
    expect(root.querySelector('.welcome-mark')?.className).toContain('welcome-mark-arrive');
    // ...and the class is DROPPED when the arrival finishes, so the mark stops
    // being a composited texture and paints at native device resolution
    // (Windows display scaling stretched the promoted layer into pixelation).
    fireEvent.animationEnd(root.querySelector('.welcome-mark')!);
    expect(root.querySelector('.welcome-mark')?.className).not.toContain('welcome-mark-arrive');
    const risers = Array.from(root.querySelectorAll<HTMLElement>('.wow-in'));
    // Title, sub-line and the three buttons.
    expect(risers).toHaveLength(5);
    const delays = risers.map((el) => parseInt(el.style.animationDelay, 10));
    // Strictly increasing, so the block arrives as one movement.
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(new Set(delays).size).toBe(delays.length);
  });

  it('names the task instead of the product when adding another wallet', () => {
    useLiveStore.setState({ addingWallet: true });
    render(<LiveOnboarding />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Add another wallet');
    expect(screen.getByTestId('live-add-wallet-cancel')).toBeInTheDocument();
  });

  it('drops the field on the forms, which are work surfaces', () => {
    render(<LiveOnboarding />);
    fireEvent.click(screen.getByTestId('live-choose-pk'));
    expect(screen.queryByTestId('constellation-field')).toBeNull();
    expect(screen.getByTestId('live-pk-import')).toBeInTheDocument();
  });
});
