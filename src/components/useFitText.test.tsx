// @vitest-environment jsdom
// The unit-test DOM has no layout, so the two measurements the hook reads (the
// parent's width, the content's width) are stood in for here: the content is
// modelled as `chars * 0.6 * font-size` wide, which is all the hook needs to be
// told to react the way a real line of digits does. The real-browser check is
// a capture of the built extension at 320, 400 and 420px.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useFitText } from './useFitText';

const PARENT_WIDTH = 288;
const BASE_PX = 34;

function Figure({ text }: { text: string }) {
  const ref = useFitText({ reserve: 68, ignore: '.eye' });
  return (
    <div data-testid="parent">
      <div data-testid="figure" ref={ref}>
        {text}
        <span className="eye" />
      </div>
    </div>
  );
}

let restore: Array<() => void> = [];

beforeEach(() => {
  const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(PARENT_WIDTH);
  // The stylesheet's size for the figure, which the hook starts from.
  const computed = vi
    .spyOn(window, 'getComputedStyle')
    .mockReturnValue({ fontSize: `${BASE_PX}px` } as CSSStyleDeclaration);
  const original = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = function (this: Range) {
    const el = this.commonAncestorContainer as HTMLElement;
    const size = parseFloat(el.style.fontSize) || BASE_PX;
    const width = (el.textContent ?? '').length * 0.6 * size;
    return { width, height: size, top: 0, left: 0, right: width, bottom: size, x: 0, y: 0, toJSON: () => ({}) };
  };
  restore = [
    () => clientWidth.mockRestore(),
    () => computed.mockRestore(),
    () => {
      Range.prototype.getBoundingClientRect = original;
    },
  ];
});

afterEach(() => {
  cleanup();
  restore.forEach((fn) => fn());
});

const sizeOf = (el: HTMLElement) => parseFloat(el.style.fontSize);

describe('useFitText', () => {
  it('leaves a figure that fits at the size the stylesheet gave it', () => {
    const { getByTestId } = render(<Figure text="1,290,100" />);
    // 9 chars * 0.6 * 34 = 183.6px, room is 288 - 68 = 220px.
    expect(getByTestId('figure').style.fontSize).toBe('');
  });

  it('steps a figure that is too wide down until it fits, and not below the floor', () => {
    const { getByTestId } = render(<Figure text="1,290,100.12345678" />);
    const size = sizeOf(getByTestId('figure'));
    // 18 chars: fits at 220 / (18 * 0.6) = 20.37px.
    expect(size).toBeLessThanOrEqual(20.37);
    expect(size).toBeGreaterThan(19.5);

    cleanup();
    const long = render(<Figure text={'9'.repeat(60)} />);
    expect(sizeOf(long.getByTestId('figure'))).toBe(15);
  });

  it('follows the figure: a longer balance shrinks it, a shorter one restores it', async () => {
    const { getByTestId, rerender } = render(<Figure text="1,290,100" />);
    const el = getByTestId('figure');
    expect(el.style.fontSize).toBe('');
    await act(async () => {
      rerender(<Figure text="1,290,100.12345678" />);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sizeOf(el)).toBeLessThan(BASE_PX);
    await act(async () => {
      rerender(<Figure text="100" />);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(el.style.fontSize).toBe('');
  });
});
