// "Open in a separate window".
//
// WHY THIS EXISTS: a Chrome extension POPUP cannot be moved. The browser anchors it
// under the toolbar icon and there is no API to reposition it; `-webkit-app-region:
// drag` does nothing there either. So a wallet you can drag around the screen is only
// possible as a real, detached browser window.
//
// `chrome.windows.create({ type: 'popup' })` gives exactly that: an OS window with its
// own title bar, which the user can drag anywhere and keep open while they browse.
// It needs no extra manifest permission.
//
// If one is already open we focus it instead of spawning a second wallet window.

/** Roughly the popup's own footprint, plus the window chrome Chrome adds around it. */
export const DETACHED_WIDTH = 420;
export const DETACHED_HEIGHT = 660;

/** Marks the detached window so we can find it again (and so the UI can tell it is
 *  running detached rather than as a toolbar popup). */
export const DETACHED_FLAG = 'detached';

export function isDetachedWindow(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get(DETACHED_FLAG) === '1';
}

/** True when a `chrome.windows` API is actually available (it is not, in a unit test
 *  or a plain page). */
function windowsApi(): typeof chrome.windows | null {
  const api = (globalThis as { chrome?: typeof chrome }).chrome;
  return api?.windows && api?.runtime ? api.windows : null;
}

/**
 * Open the wallet in a detached, draggable window, or focus the existing one, and
 * then CLOSE the toolbar popup we were called from: the point is to move the wallet
 * into a window, not to end up with two of it on screen.
 *
 * Resolves to false when the API is unavailable, so the caller can stay quiet
 * instead of throwing at the user.
 */
export async function openDetachedWindow(): Promise<boolean> {
  const windows = windowsApi();
  if (!windows) return false;

  const url = chrome.runtime.getURL(`index.html?${DETACHED_FLAG}=1`);

  // Focus an already-open wallet window rather than opening another one.
  const existing = await windows.getAll({ populate: true });
  const already = existing.find((w) => w.id !== undefined && w.tabs?.some((t) => t.url?.startsWith(url)));

  if (already?.id !== undefined) {
    await windows.update(already.id, { focused: true });
  } else {
    await windows.create({ url, type: 'popup', width: DETACHED_WIDTH, height: DETACHED_HEIGHT });
  }

  // Dismiss ourselves. In a real toolbar popup this closes it; Chrome also closes a
  // popup on focus loss anyway, so this only makes the handoff immediate.
  window.close();
  return true;
}
