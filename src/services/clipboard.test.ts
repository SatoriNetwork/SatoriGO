// @vitest-environment jsdom
// This suite needs `document` (document.hasFocus) — the project's default
// vitest environment is 'node', so this file opts into jsdom on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyText,
  clearSecretClipboardNow,
  SECRET_CLIPBOARD_CLEAR_SECONDS,
  __resetClipboardForTests,
} from './clipboard';

describe('clipboard auto-clear', () => {
  let writeText: ReturnType<typeof vi.fn>;
  let hasFocus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetClipboardForTests();
    vi.useFakeTimers();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    hasFocus = vi.fn().mockReturnValue(true);
    document.hasFocus = hasFocus;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('non-secret copy with setting 0 never schedules a clear', async () => {
    const ok = await copyText('some-address', 0);
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('some-address');

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 10 minutes, far beyond any cap

    expect(writeText).toHaveBeenCalledTimes(1); // only the original write, no clear
  });

  it('secret copy with setting 0 clears after 30 s', async () => {
    const ok = await copyText('seed words here', 0, { secret: true });
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('seed words here');

    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_SECONDS * 1000 - 1);
    expect(writeText).toHaveBeenCalledTimes(1); // not yet cleared

    await vi.advanceTimersByTimeAsync(1);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith('');
  });

  it('secret copy with user setting 15 clears after 15 s (min of the two)', async () => {
    const ok = await copyText('private-key-wif', 15, { secret: true });
    expect(ok).toBe(true);

    await vi.advanceTimersByTimeAsync(15 * 1000 - 1);
    expect(writeText).toHaveBeenCalledTimes(1); // not yet cleared

    await vi.advanceTimersByTimeAsync(1);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith('');
  });

  it('a second copy cancels the previous pending clear', async () => {
    await copyText('first-secret', 0, { secret: true });
    expect(writeText).toHaveBeenCalledTimes(1);

    // Advance partway through the first clear's countdown, then copy again.
    await vi.advanceTimersByTimeAsync(20 * 1000);
    expect(writeText).toHaveBeenCalledTimes(1); // still not cleared

    await copyText('second-secret', 0, { secret: true });
    expect(writeText).toHaveBeenCalledTimes(2); // the second copy's write

    // Advance past when the first timer would have fired (had it not been cancelled).
    await vi.advanceTimersByTimeAsync(15 * 1000);
    expect(writeText).toHaveBeenCalledTimes(2); // first timer did NOT fire

    // Advance to when the second timer fires (30s after the second copy).
    await vi.advanceTimersByTimeAsync(15 * 1000);
    expect(writeText).toHaveBeenCalledTimes(3);
    expect(writeText).toHaveBeenLastCalledWith('');
  });
});

// The reliable half of KNOWN_LIMITATIONS item 5. The 30 s timer above dies with
// the popup, and clearing on popup teardown is impossible — the Clipboard API
// needs a FOCUSED document and a closing popup has already lost focus, so such a
// handler would always reject. Instead the screens that reveal a secret wipe it
// on the way out, while the popup is still open and the write lands.
describe('clearSecretClipboardNow', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetClipboardForTests();
    vi.useFakeTimers();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    document.hasFocus = vi.fn().mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('wipes a copied secret immediately, ahead of its 30 s timer', async () => {
    await copyText('seed words here', 0, { secret: true });
    await clearSecretClipboardNow();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith('');
  });

  // The hazard this guard exists for: the user copies the seed, pastes it into a
  // password manager, copies an ADDRESS, then leaves the screen. Blanking here
  // would destroy the address they are about to paste.
  it('does NOT wipe an ordinary copy made after the secret', async () => {
    await copyText('seed words here', 0, { secret: true });
    await copyText('some-address');
    await clearSecretClipboardNow();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith('some-address');
  });

  it('is a no-op when nothing secret was ever copied', async () => {
    await copyText('some-address');
    await clearSecretClipboardNow();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('is a no-op once the auto-clear timer has already fired', async () => {
    await copyText('seed words here', 0, { secret: true });
    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_SECONDS * 1000);
    expect(writeText).toHaveBeenCalledTimes(2); // the timer's blank
    await clearSecretClipboardNow();
    expect(writeText).toHaveBeenCalledTimes(2); // no second blank
  });

  it('cancels the pending timer, so a later copy is not blanked by it', async () => {
    await copyText('seed words here', 0, { secret: true });
    await clearSecretClipboardNow(); // early exit from the reveal screen
    await copyText('some-address');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(writeText).toHaveBeenCalledTimes(3); // secret, blank, address — nothing after
    expect(writeText).toHaveBeenLastCalledWith('some-address');
  });

  it('stays silent when the document has lost focus (the write would reject)', async () => {
    await copyText('seed words here', 0, { secret: true });
    document.hasFocus = vi.fn().mockReturnValue(false);
    await expect(clearSecretClipboardNow()).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
