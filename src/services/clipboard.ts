// Clipboard helper with an optional auto-clear timer (Security setting).
//
// KNOWN LIMITATION (documented, not fixable here): the timer below is a plain
// setTimeout living in the popup's JS context. If the popup closes before it
// fires (MV3 tears down the popup document), the timer dies with it and the
// clipboard is never cleared. Clearing on `pagehide`/`visibilitychange` does
// NOT fix it and was deliberately not added: `navigator.clipboard.writeText`
// requires the document to be FOCUSED, and a closing popup has already lost
// focus, so such a handler is a placebo that always rejects. The real fix is an
// offscreen document, which is Chrome-only and needs a new permission.
//
// This is NOT moved into the background service worker on purpose — the worker
// must never see secret material (seed/private key), per the "no keys in the
// worker" invariant.
//
// What IS done: `clearSecretClipboardNow()` lets a screen that revealed a
// secret wipe it the moment the user navigates away from that screen, while the
// document still has focus and the write therefore succeeds. That shrinks the
// exposure window from "up to 30 s, or forever if the popup closed" to "until
// you leave the screen" for every flow except closing the popup outright.

// Secrets (recovery phrase / revealed private key) must always be auto-cleared,
// even if the user turned the setting off (0), and never later than this cap.
export const SECRET_CLIPBOARD_CLEAR_SECONDS = 30;

let clearTimer: ReturnType<typeof setTimeout> | null = null;
/** True while a SECRET we wrote is believed to still sit in the clipboard.
 *  Gates `clearSecretClipboardNow()` so leaving a screen can never wipe an
 *  ordinary copy (an address, a txid) the user still needs. */
let secretPending = false;

function cancelTimer(): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

/** Best-effort blank of the clipboard. Silent on failure (no focus / no
 *  permission), which is the normal case once the popup is going away. */
async function blankClipboard(): Promise<void> {
  try {
    // Only clear if the document still has focus; otherwise the write fails.
    if (document.hasFocus()) await navigator.clipboard.writeText('');
  } catch {
    // ignore — popup likely closed or lost focus
  }
}

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
  cancelTimer();
  // A non-secret copy REPLACES any secret we were tracking: the secret is no
  // longer what sits in the clipboard, so a later screen-exit must not blank
  // whatever the user just copied on purpose.
  secretPending = opts?.secret === true;

  const effectiveClearSeconds = opts?.secret
    ? clearAfterSeconds > 0
      ? Math.min(clearAfterSeconds, SECRET_CLIPBOARD_CLEAR_SECONDS)
      : SECRET_CLIPBOARD_CLEAR_SECONDS
    : clearAfterSeconds;

  if (effectiveClearSeconds > 0) {
    clearTimer = setTimeout(async () => {
      clearTimer = null;
      secretPending = false;
      await blankClipboard();
    }, effectiveClearSeconds * 1000);
  }
  return true;
}

/**
 * Wipe a copied SECRET immediately, ahead of its timer. Call this when the
 * screen that revealed the secret is dismissed — at that moment the popup is
 * still open and focused, so the write actually lands.
 *
 * A no-op unless the most recent copy was a secret whose timer has not fired,
 * so it can never destroy an ordinary copy the user is about to paste.
 */
export async function clearSecretClipboardNow(): Promise<void> {
  if (!secretPending) return;
  secretPending = false;
  cancelTimer();
  await blankClipboard();
}

/** Test-only: forget any tracked secret / pending timer between cases. */
export function __resetClipboardForTests(): void {
  cancelTimer();
  secretPending = false;
}
