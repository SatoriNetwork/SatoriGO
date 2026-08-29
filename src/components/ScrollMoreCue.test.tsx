/**
 * @vitest-environment jsdom
 *
 * The "more below" scroll affordance (owner, live testing 2026-08-25: in the
 * popup an overflowing asset list showed no scrollbar and no hint that content
 * continued below).
 *
 * jsdom computes NO layout, so scrollHeight / clientHeight / scrollTop are all
 * 0 unless they are defined on the element. That is fine and it is the point:
 * this file pins the DECISION the hook makes from those three numbers, plus the
 * attribute the cue renders from it. The real geometry (a genuinely overflowing
 * list in a 400x600 popup, the cue appearing and then disappearing at the end
 * of the scroll) is measured with real boxes in scripts/evm-extension-smoke.mjs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ScrollMoreCue, useMoreBelow } from './ScrollMoreCue';

afterEach(cleanup);

/** Give a jsdom element the scroll geometry it otherwise has no layout for. */
function setGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop = 0) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
}

/** A minimal stand-in for Home's pinned split: a scrolling region with the cue
 *  as its sibling, exactly the arrangement LiveHome renders. */
function Harness({ scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop?: number }) {
  const { ref, more } = useMoreBelow();
  return (
    <div>
      <div
        data-testid="region"
        ref={(node) => {
          if (node) setGeometry(node, scrollHeight, clientHeight, scrollTop ?? 0);
          ref(node);
        }}
      >
        content
      </div>
      <ScrollMoreCue more={more} testId="cue" />
    </div>
  );
}

const cue = () => screen.getByTestId('cue');

describe('ScrollMoreCue', () => {
  it('shows the chevron when the region overflows and is not at its end', () => {
    render(<Harness scrollHeight={500} clientHeight={200} />);
    expect(cue()).toHaveAttribute('data-more', 'true');
  });

  it('shows nothing when the content fits', () => {
    render(<Harness scrollHeight={180} clientHeight={200} />);
    expect(cue()).toHaveAttribute('data-more', 'false');
  });

  it('shows nothing once the region is scrolled to its end', () => {
    render(<Harness scrollHeight={500} clientHeight={200} scrollTop={300} />);
    expect(cue()).toHaveAttribute('data-more', 'false');
  });

  it('tolerates a sub-pixel remainder at the end of a scroll', () => {
    // 500 - 298.5 - 200 = 1.5px left: rounding, not a row.
    render(<Harness scrollHeight={500} clientHeight={200} scrollTop={298.5} />);
    expect(cue()).toHaveAttribute('data-more', 'false');
  });

  it('follows a real scroll event without any timer', () => {
    render(<Harness scrollHeight={500} clientHeight={200} />);
    const region = screen.getByTestId('region');
    expect(cue()).toHaveAttribute('data-more', 'true');

    act(() => {
      region.scrollTop = 300;
      region.dispatchEvent(new Event('scroll'));
    });
    expect(cue()).toHaveAttribute('data-more', 'false');

    act(() => {
      region.scrollTop = 10;
      region.dispatchEvent(new Event('scroll'));
    });
    expect(cue()).toHaveAttribute('data-more', 'true');
  });

  it('re-measures when the list itself changes, with no scroll and no resize', async () => {
    // The MutationObserver half: a token row appearing is what turns a list
    // that fitted into one that does not, and nothing scrolls when it does.
    function Growing() {
      const { ref, more } = useMoreBelow();
      return (
        <div>
          <div
            data-testid="region"
            ref={(node) => {
              if (node) setGeometry(node, 180, 200);
              ref(node);
            }}
          >
            content
          </div>
          <ScrollMoreCue more={more} testId="cue" />
        </div>
      );
    }
    render(<Growing />);
    expect(cue()).toHaveAttribute('data-more', 'false');

    const region = screen.getByTestId('region');
    await act(async () => {
      setGeometry(region, 500, 200);
      region.appendChild(document.createElement('div'));
      // MutationObserver callbacks are delivered as a microtask.
      await Promise.resolve();
    });
    expect(cue()).toHaveAttribute('data-more', 'true');
  });

  it('is inert: no pointer events and hidden from assistive technology', () => {
    render(<Harness scrollHeight={500} clientHeight={200} />);
    expect(cue()).toHaveAttribute('aria-hidden');
    expect(cue().className).toContain('scroll-more-cue');
  });

  it('unmounts cleanly (the listeners are removed with the element)', () => {
    const { unmount } = render(<Harness scrollHeight={500} clientHeight={200} />);
    expect(() => unmount()).not.toThrow();
  });
});
