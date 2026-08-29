// "Is this a short screen?" — the ONE place that answers it, so the layout
// decision cannot be made in two dialects (a CSS media query and a JS check
// that quietly disagree about the breakpoint).
//
// Why it exists: Chrome's toolbar popup is a fixed 600px box. Measured there
// on 2026-08-25 with eight tokens, Home's pinned block (the coin mark, the
// balance, the total and the Send/Receive/Stake row) took 270 of the 394px
// under the header, leaving the asset list at its 64px floor: one 42px row
// visible, everything else behind a scroll. A side panel or a detached window
// is a whole browser window tall and has room for both, so the compaction must
// apply THERE and not everywhere.
//
// 700px, not 600: it must fire in the popup with margin to spare, and stay
// clear of any real side panel or detached window (the same reasoning, and the
// same neighbourhood, as the 640px the notification image already uses).

import { useEffect, useState } from 'react';

export const SHORT_VIEWPORT_MAX_HEIGHT = 700;
export const SHORT_VIEWPORT_QUERY = `(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px)`;

/** Current answer, without subscribing. Falls back to innerHeight where
 *  matchMedia does not exist (jsdom, a non-DOM context), and to `false` where
 *  there is no window at all: never compacting is the safe default, because it
 *  is exactly the layout that shipped before. */
export function isShortViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia(SHORT_VIEWPORT_QUERY).matches;
    } catch {
      /* fall through to the height check */
    }
  }
  return typeof window.innerHeight === 'number' && window.innerHeight > 0
    ? window.innerHeight <= SHORT_VIEWPORT_MAX_HEIGHT
    : false;
}

/** `isShortViewport()`, kept current: a detached window the user resizes, or a
 *  side panel dragged narrow, re-lays out without a reload. */
export function useShortViewport(): boolean {
  const [short, setShort] = useState(isShortViewport);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(SHORT_VIEWPORT_QUERY);
    } catch {
      return;
    }
    const onChange = () => setShort(isShortViewport());
    onChange();
    // addListener is the pre-2021 spelling; Safari 13 and the jsdom stub still
    // only carry one of the two, so whichever exists is used.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
    return;
  }, []);
  return short;
}
