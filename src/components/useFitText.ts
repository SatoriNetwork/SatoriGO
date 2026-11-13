// A big figure that must stay on ONE line and inside the screen.
//
// The balance on Home is set large (34px since 1.7.23). A coin with no price
// shows its own balance there at full precision, and "1,290,100.12345678 XFER"
// at that size is wider than a 320px side panel: it ran off both edges. A
// figure cannot wrap (half a number on the next line reads as two numbers) and
// must not be cut (a balance with digits missing is a wrong balance), so the
// one thing left is to set it smaller until it fits.
//
// The size in the stylesheet stays the size: this only ever steps DOWN from it,
// and only while the content is wider than the room it has.

import { useEffect, useState } from 'react';

/** Never smaller than this: below it the figure stops being the hero. */
const MIN_PX = 15;

export interface FitTextOptions {
  /** Room (px) to leave free beside the figure, e.g. for a control that hangs
   *  off its right edge. Taken off the parent's width on both sides' behalf. */
  reserve?: number;
  /** Selector of a child that is positioned outside the line (it does not take
   *  part in the width being fitted). */
  ignore?: string;
}

/** Width of the element's in-flow content, ignoring `ignore` if it is last. */
function contentWidth(el: HTMLElement, ignore?: string): number {
  if (typeof document.createRange !== 'function') return 0;
  const range = document.createRange();
  range.selectNodeContents(el);
  const skip = ignore ? el.querySelector(ignore) : null;
  if (skip && skip.parentNode === el) range.setEndBefore(skip);
  // Not every DOM has layout (the unit tests' does not): no width, no fitting.
  return typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect().width : 0;
}

/**
 * Returns a CALLBACK ref (the hero swaps between two elements, and a callback
 * ref is the kind React reports a change of). Attach it to the figure.
 */
export function useFitText({ reserve = 0, ignore }: FitTextOptions = {}): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const parent = node?.parentElement;
    if (!node || !parent) return;
    const fit = () => {
      node.style.fontSize = '';
      const room = parent.clientWidth - reserve;
      if (room <= 0) return;
      let size = parseFloat(getComputedStyle(node).fontSize) || 0;
      // A few passes: a child with its own fixed size (the ticker) does not
      // scale with the figure, so one proportional step can land a little wide.
      for (let i = 0; i < 4 && size > MIN_PX; i++) {
        const width = contentWidth(node, ignore);
        if (width <= room + 0.5) break;
        size = Math.max(MIN_PX, Math.floor(size * (room / width) * 100) / 100);
        node.style.fontSize = `${size}px`;
      }
    };
    fit();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(fit);
      ro.observe(parent);
    }
    // The figure changing (a refresh, hide/show) is a text mutation. Attributes
    // are NOT observed: `fit` writes one, and must not wake itself.
    let mo: MutationObserver | undefined;
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(fit);
      mo.observe(node, { childList: true, subtree: true, characterData: true });
    }
    // The display face arriving after first paint changes every glyph's width.
    let cancelled = false;
    void document.fonts?.ready?.then(() => {
      if (!cancelled) fit();
    });
    return () => {
      cancelled = true;
      ro?.disconnect();
      mo?.disconnect();
      node.style.fontSize = '';
    };
  }, [node, reserve, ignore]);
  return setNode;
}
