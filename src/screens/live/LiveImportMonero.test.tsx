/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const VALID_25 =
  'wedge going quick racetrack auburn physics lectures light waist axes whipped habitat square awkward together injury niece nugget guarded hive obnoxious waxing faked folding square';

const hoisted = vi.hoisted(() => ({
  importMoneroWallet: vi.fn(async (_words: string, _height: number, _name?: string, _password?: string) => ({ id: 'new-wallet-id' })),
  // With an app password set the words are sealed under the app key and the
  // screen asks for no password of its own (the shipped default this file's
  // cases were written against); the one case below flips it.
  appPasswordSet: true,
}));

vi.mock('../../store/liveStore', () => ({
  liveService: () => ({ importMoneroWallet: hoisted.importMoneroWallet }),
  useLiveStore: (selector: (s: { appPasswordSet: boolean }) => unknown) => selector({ appPasswordSet: hoisted.appPasswordSet }),
}));

vi.mock('../../services/chain/monero/mnemonic', () => {
  class FakeMoneroMnemonicError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    MoneroMnemonicError: FakeMoneroMnemonicError,
    normalizeLegacyWords: (input: string) => input.trim().split(/\s+/).filter(Boolean),
    isValidLegacyMnemonic: (input: string) => input.trim() === VALID_25,
  };
});

vi.mock('../../services/chain/monero/rpc', () => ({
  MONERO_RELEASE_HEIGHT: 3772358,
  estimateHeightForDate: (date: Date) => {
    const days = Math.max(0, (Date.now() - date.getTime()) / 86_400_000);
    return Math.max(0, 3_772_358 - Math.round(days) * 720);
  },
}));

import { LiveImportMonero } from './LiveImportMonero';

function renderScreen(onImported = vi.fn()) {
  render(<LiveImportMonero onBack={vi.fn()} onImported={onImported} />);
  return onImported;
}

describe('LiveImportMonero', () => {
  beforeEach(() => {
    hoisted.importMoneroWallet.mockClear();
  });
  afterEach(cleanup);

  it('shows a live word-count hint while typing', () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-words'), { target: { value: 'abandon abandon' } });
    expect(screen.getByTestId('live-xmr-import-words-hint').textContent).toBe('2 of 25 words.');
  });

  it('confirms the checksum once all 25 words are a valid phrase', () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-words'), { target: { value: VALID_25 } });
    expect(screen.getByTestId('live-xmr-import-words-hint').textContent).toBe('25 words, checksum verified.');
  });

  it('refuses to submit with an incomplete phrase, and never calls the service', async () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-words'), { target: { value: 'only a few words here' } });
    fireEvent.change(screen.getByTestId('live-xmr-import-height'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('live-xmr-import-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-import-words-error')).toBeTruthy());
    expect(hoisted.importMoneroWallet).not.toHaveBeenCalled();
  });

  it('refuses to submit with neither a date nor a height', async () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-words'), { target: { value: VALID_25 } });
    fireEvent.click(screen.getByTestId('live-xmr-import-submit'));
    await waitFor(() => expect(screen.getByText(/Enter the creation date/)).toBeTruthy());
    expect(hoisted.importMoneroWallet).not.toHaveBeenCalled();
  });

  it('picking a date fills the height field', () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-date'), { target: { value: '2020-01-01' } });
    const height = screen.getByTestId('live-xmr-import-height') as HTMLInputElement;
    expect(Number(height.value)).toBeLessThan(3_772_358);
  });

  it('bounds the date picker to Monero genesis .. today', () => {
    renderScreen();
    const date = screen.getByTestId('live-xmr-import-date') as HTMLInputElement;
    expect(date.min).toBe('2014-04-18');
    expect(date.max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses a future date and leaves the height field alone', () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-date'), { target: { value: '2999-01-01' } });
    expect(screen.getByText('That date is in the future.')).toBeTruthy();
    expect((screen.getByTestId('live-xmr-import-height') as HTMLInputElement).value).toBe('');
  });

  it('a date before Monero genesis clamps to height 0', () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-date'), { target: { value: '2012-05-05' } });
    expect((screen.getByTestId('live-xmr-import-height') as HTMLInputElement).value).toBe('0');
  });

  it('submits the trimmed words, the parsed height and the optional name; navigates to the new wallet id', async () => {
    const onImported = renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-name'), { target: { value: 'My Monero' } });
    fireEvent.change(screen.getByTestId('live-xmr-import-words'), { target: { value: `  ${VALID_25}  ` } });
    fireEvent.change(screen.getByTestId('live-xmr-import-height'), { target: { value: '3700000' } });
    fireEvent.click(screen.getByTestId('live-xmr-import-submit'));
    // The fourth argument is the wallet password: undefined with an app
    // password set (the words go under the app key).
    await waitFor(() => expect(hoisted.importMoneroWallet).toHaveBeenCalledWith(VALID_25, 3700000, 'My Monero', undefined));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('new-wallet-id'));
  });

  it('an empty wallet name is passed as undefined, not an empty string', async () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-words'), { target: { value: VALID_25 } });
    fireEvent.change(screen.getByTestId('live-xmr-import-height'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('live-xmr-import-submit'));
    await waitFor(() => expect(hoisted.importMoneroWallet).toHaveBeenCalledWith(VALID_25, 0, undefined, undefined));
  });

  it('without an app password, asks for a wallet password (min length, confirmation) and passes it to the service', async () => {
    hoisted.appPasswordSet = false;
    try {
      const onImported = renderScreen();
      fireEvent.change(screen.getByTestId('live-xmr-import-words'), { target: { value: VALID_25 } });
      fireEvent.change(screen.getByTestId('live-xmr-import-height'), { target: { value: '100' } });
      // Too short: refused, service never called.
      fireEvent.change(screen.getByTestId('live-xmr-import-password'), { target: { value: 'short' } });
      fireEvent.change(screen.getByTestId('live-xmr-import-password-confirm'), { target: { value: 'short' } });
      fireEvent.click(screen.getByTestId('live-xmr-import-submit'));
      await waitFor(() => expect(screen.getByText(/at least 8 characters/i)).toBeTruthy());
      expect(hoisted.importMoneroWallet).not.toHaveBeenCalled();
      // Mismatch: refused.
      fireEvent.change(screen.getByTestId('live-xmr-import-password'), { target: { value: 'long-enough-1' } });
      fireEvent.change(screen.getByTestId('live-xmr-import-password-confirm'), { target: { value: 'long-enough-2' } });
      fireEvent.click(screen.getByTestId('live-xmr-import-submit'));
      await waitFor(() => expect(screen.getByText(/do not match/i)).toBeTruthy());
      expect(hoisted.importMoneroWallet).not.toHaveBeenCalled();
      // Matching: the password reaches the service as the fourth argument.
      fireEvent.change(screen.getByTestId('live-xmr-import-password-confirm'), { target: { value: 'long-enough-1' } });
      fireEvent.click(screen.getByTestId('live-xmr-import-submit'));
      await waitFor(() => expect(hoisted.importMoneroWallet).toHaveBeenCalledWith(VALID_25, 100, undefined, 'long-enough-1'));
      await waitFor(() => expect(onImported).toHaveBeenCalledWith('new-wallet-id'));
    } finally {
      hoisted.appPasswordSet = true;
    }
  });

  it('shows a generic form error when the service call rejects', async () => {
    hoisted.importMoneroWallet.mockRejectedValueOnce(new Error('storage write failed'));
    renderScreen();
    fireEvent.change(screen.getByTestId('live-xmr-import-words'), { target: { value: VALID_25 } });
    fireEvent.change(screen.getByTestId('live-xmr-import-height'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('live-xmr-import-submit'));
    await waitFor(() => expect(screen.getByTestId('live-xmr-import-error').textContent).toBe('storage write failed'));
  });
});
