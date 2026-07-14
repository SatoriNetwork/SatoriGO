// @vitest-environment jsdom
// This suite needs `document` (document.hasFocus) — the project's default
// vitest environment is 'node', so this file opts into jsdom on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText, SECRET_CLIPBOARD_CLEAR_SECONDS } from './clipboard';

describe('clipboard auto-clear', () => {
  let writeText: ReturnType<typeof vi.fn>;
  let hasFocus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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
