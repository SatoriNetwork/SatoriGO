/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/clipboard', () => ({
  clearSecretClipboardNow: vi.fn(async () => {}),
  copyText: vi.fn(async () => true),
}));

import { MoneroSeedReveal, type MoneroSeedRevealSecret } from './MoneroSeedReveal';

const WORDS_25 = Array.from({ length: 25 }, (_, i) => `word${i + 1}`);
const SECRET: MoneroSeedRevealSecret = { words: WORDS_25, restoreHeight: 3772400 };

afterEach(cleanup);

describe('MoneroSeedReveal — password-protected wallet', () => {
  it('reveals nothing until the password is submitted', () => {
    render(<MoneroSeedReveal noPassword={false} reveal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('live-xmr-seed-grid')).toBeNull();
    expect(screen.getByTestId('live-xmr-seed-password')).toBeTruthy();
  });

  it('shows an error and no words on a wrong password', async () => {
    const reveal = vi.fn(async () => null);
    render(<MoneroSeedReveal noPassword={false} reveal={reveal} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('live-xmr-seed-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('live-xmr-seed-reveal-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-seed-password-error').textContent).toBe('Incorrect password.'));
    expect(screen.queryByTestId('live-xmr-seed-grid')).toBeNull();
  });

  it('on the right password, renders all 25 words (1-based testids) and the restore height', async () => {
    const reveal = vi.fn(async (pw: string) => (pw === 'correct' ? SECRET : null));
    render(<MoneroSeedReveal noPassword={false} reveal={reveal} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('live-xmr-seed-password'), { target: { value: 'correct' } });
    fireEvent.click(screen.getByTestId('live-xmr-seed-reveal-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-seed-grid')).toBeTruthy());
    expect(screen.getByTestId('live-xmr-seed-word-1').textContent).toBe('word1');
    expect(screen.getByTestId('live-xmr-seed-word-25').textContent).toBe('word25');
    expect(screen.getByTestId('live-xmr-seed-height').textContent).toBe('3,772,400');
  });

  it('shows the owner-approved disclosure naming Cake, Ledger and Trezor', () => {
    render(<MoneroSeedReveal noPassword={false} reveal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/Cake Wallet/)).toBeTruthy();
    expect(screen.getByText(/Ledger or Trezor/)).toBeTruthy();
  });

  it('a wallet imported from its 25 words gets no derivation disclosure: the words are what was typed', () => {
    render(<MoneroSeedReveal noPassword={false} reveal={vi.fn()} onClose={vi.fn()} keySource="words" />);
    const note = screen.getByTestId('live-xmr-seed-note').textContent ?? '';
    expect(note).toMatch(/imported from/i);
    expect(note).not.toMatch(/Cake Wallet/);
    expect(note).not.toMatch(/Derived from your recovery phrase/);
    expect(note).not.toContain('—');
  });

  it('Hide clears the revealed secret and calls onClose', async () => {
    const onClose = vi.fn();
    const reveal = vi.fn(async () => SECRET);
    render(<MoneroSeedReveal noPassword={false} reveal={reveal} onClose={onClose} />);
    fireEvent.change(screen.getByTestId('live-xmr-seed-password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('live-xmr-seed-reveal-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-seed-hide')).toBeTruthy());
    fireEvent.click(screen.getByTestId('live-xmr-seed-hide'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MoneroSeedReveal — passwordless wallet', () => {
  it('reveals on open with no password field', async () => {
    const reveal = vi.fn(async () => SECRET);
    render(<MoneroSeedReveal noPassword reveal={reveal} onClose={vi.fn()} />);
    expect(screen.queryByTestId('live-xmr-seed-password')).toBeNull();
    await waitFor(() => expect(reveal).toHaveBeenCalledWith(''));
    await waitFor(() => expect(screen.getByTestId('live-xmr-seed-grid')).toBeTruthy());
  });

  it('shows an inline error if the passwordless reveal itself fails', async () => {
    const reveal = vi.fn(async () => null);
    render(<MoneroSeedReveal noPassword reveal={reveal} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('live-xmr-seed-error')).toBeTruthy());
  });
});
