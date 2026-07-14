// Clipboard helper with an optional auto-clear timer (Security setting).
//
// KNOWN LIMITATION: the timer below is a plain setTimeout living in the popup's
// JS context. If the popup closes before it fires (MV3 tears down the popup
// document), the timer dies with it and the clipboard is never cleared. This is
// NOT moved into the background service worker on purpose — the worker must
// never see secret material (seed/private key), per the "no keys in the worker"
// invariant. Closing the popup promptly after copying a secret is on the user.

// Secrets (recovery phrase / revealed private key) must always be auto-cleared,
// even if the user turned the setting off (0), and never later than this cap.
export const SECRET_CLIPBOARD_CLEAR_SECONDS = 30;

let clearTimer: ReturnType<typeof setTimeout> | null = null;

export async function copyText(
  text: string,
  clearAfterSeconds = 0,
  opts?: { secret?: boolean }
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false;
  }
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  const effectiveClearSeconds = opts?.secret
    ? clearAfterSeconds > 0
      ? Math.min(clearAfterSeconds, SECRET_CLIPBOARD_CLEAR_SECONDS)
      : SECRET_CLIPBOARD_CLEAR_SECONDS
    : clearAfterSeconds;

  if (effectiveClearSeconds > 0) {
    clearTimer = setTimeout(async () => {
      try {
        // Only clear if the document still has focus; otherwise the write fails.
        if (document.hasFocus()) await navigator.clipboard.writeText('');
      } catch {
        // ignore — popup likely closed or lost focus
      }
    }, effectiveClearSeconds * 1000);
  }
  return true;
}
