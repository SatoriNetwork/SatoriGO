// "There is more below" — the scroll affordance for the pinned scroll regions
// (Home's asset list today; .send-scroll could reuse it).
//
// WHY IT EXISTS (owner, live testing 2026-08-25): in the toolbar POPUP, which
// is a fixed 400x600 window, an asset list that outgrows its region gave the
// user nothing to go on. Chromium paints an OVERLAY scrollbar there (it takes
// no layout width and fades out the moment scrolling stops), and the region's
// own bottom mask fade dissolves the last row into a near-black background that
// reads as "the list ends here", not as "it continues". The list simply looked
// finished, one row short of the truth.
//
// Two things fix it, and they are deliberately independent:
//   1. a REAL, always-visible slim scrollbar on the region (pure CSS, see the
//      .home-scroll ::-webkit-scrollbar rules in global.css), and
//   2. this chevron, which appears ONLY while there is content below the fold
//      and vanishes the moment the region is scrolled to its end.
//
// COST: no timer, no polling, nothing that runs when nothing changed. A
// `scroll` listener (passive, so it never blocks the scroll itself), a
// ResizeObserver for the region's own box (the side panel is user-resizable)
// and a MutationObserver for its contents (a token added, a filter applied, a
// skeleton replaced by a real row).
//
// PLACEMENT: the cue is an absolutely positioned overlay anchored to the BOTTOM
// of the scroll region's container, which puts it in the screen's own bottom
// padding band — below the last row, never on top of it. It is also
// `pointer-events: none` and `aria-hidden`, so it can neither swallow a tap
// meant for a row nor add noise to a screen reader (a sighted-only hint about
// scrolling tells an assistive technology nothing it does not already know).

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/** Slack (px) below which "there is more" is a rounding artefact rather than a
 *  row. Sub-pixel layout means scrollHeight - scrollTop - clientHeight rarely
 *  lands on exactly 0 at the end of a scroll. */
const EPSILON = 2;

export interface MoreBelow {
  /** Attach to the scrolling element. A CALLBACK ref, not a useRef object, on
   *  purpose: the tab bar unmounts and remounts this region, and a callback ref
   *  is the only kind of ref whose change React tells us about, so the
   *  listeners always follow the element that is actually on screen. */
  ref: (node: HTMLElement | null) => void;
  /** True while the element has content BELOW its visible bottom edge: it
   *  overflows AND is not scrolled to the end. False when the content fits (no
   *  overflow at all), and false again once the last row is reached. */
  more: boolean;
}

/** Watches one scrolling element and answers "is there more below?". */
export function useMoreBelow(): MoreBelow {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!node) {
      setMore(false);
      return;
    }
    const measure = () => setMore(node.scrollHeight - node.scrollTop - node.clientHeight > EPSILON);
    measure();
    // Passive: this handler only reads, so it must never be allowed to delay
    // the scroll it is watching.
    node.addEventListener('scroll', measure, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(node);
    }
    let mo: MutationObserver | undefined;
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(measure);
      mo.observe(node, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      node.removeEventListener('scroll', measure);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [node]);
  return { ref: setNode, more };
}

/**
 * The chevron itself. Always in the DOM (so its state is one attribute rather
 * than a mount/unmount, and so the fade has something to fade), hidden outright
 * when there is nothing below: `data-more="false"` takes it to opacity 0 AND
 * visibility hidden, so it is invisible to a screenshot and to Playwright's
 * isVisible() alike.
 */
export function ScrollMoreCue({ more, testId }: { more: boolean; testId?: string }) {
  return (
    <div className="scroll-more-cue" data-more={more ? 'true' : 'false'} data-testid={testId} aria-hidden>
      <ChevronDown size={14} />
    </div>
  );
}
