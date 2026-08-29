/**
 * @vitest-environment jsdom
 *
 * The constellation background (components/ConstellationField.tsx).
 *
 * It is decoration, so the things worth testing are the ones that would cost a
 * user something if they broke: that it never becomes content (aria-hidden),
 * that it leaves NOTHING running when the screen it decorates goes away (a
 * popup that keeps a rAF loop alive after unmount burns battery for nothing),
 * and that a reduced-motion session gets one static frame rather than a loop
 * that has merely been slowed down.
 *
 * jsdom has no canvas, so `src/test/setup.ts` answers null from getContext()
 * globally. This file installs a recording fake in its place, which is what
 * lets the animation path actually run here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import {
  ConstellationField,
  parseCssColor,
  readAccentRgb,
  shouldReduceMotion,
  themeAlphaScale,
} from './ConstellationField';

/** A 2D context that records the calls the field makes, and nothing else. */
function makeCtx() {
  const calls: string[] = [];
  return {
    calls,
    setTransform: () => calls.push('setTransform'),
    clearRect: () => calls.push('clearRect'),
    beginPath: () => calls.push('beginPath'),
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => calls.push('stroke'),
    arc: () => calls.push('arc'),
    fill: () => calls.push('fill'),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  };
}

let ctx: ReturnType<typeof makeCtx>;
let scheduled: number[];
let cancelled: number[];

/** matchMedia answering `matches` for the reduced-motion query. */
function mockReducedMotion(matches: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: /prefers-reduced-motion/.test(query) ? matches : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  ctx = makeCtx();
  scheduled = [];
  cancelled = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  // rAF is spied, not driven: the loop must be OBSERVED here, never run for
  // real, or the assertions would race a 16ms timer.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
    const handle = scheduled.length + 1;
    scheduled.push(handle);
    return handle;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle: number) => {
    cancelled.push(handle);
  });
  mockReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.reducedMotion;
  delete document.documentElement.dataset.theme;
});

describe('ConstellationField', () => {
  it('renders a canvas that is decoration, never content', () => {
    render(<ConstellationField />);
    const canvas = screen.getByTestId('constellation-field');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas).toHaveClass('constellation-field');
    // Nothing here is reachable by the accessibility tree or the pointer.
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('draws and starts one animation loop on mount', () => {
    render(<ConstellationField />);
    // The first frame is painted synchronously on mount, so the screen is never
    // blank for a frame while waiting for rAF.
    expect(ctx.calls).toContain('setTransform');
    expect(ctx.calls).toContain('arc');
    expect(scheduled).toHaveLength(1);
  });

  it('leaves nothing running after unmount', () => {
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const removeDoc = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<ConstellationField />);
    expect(scheduled).toHaveLength(1);

    unmount();

    // The outstanding frame is cancelled, not orphaned.
    expect(cancelled).toContain(scheduled[scheduled.length - 1]);
    expect(removeWindow.mock.calls.map((c) => c[0])).toContain('pointermove');
    expect(removeDoc.mock.calls.map((c) => c[0])).toContain('visibilitychange');
    // And no frame was scheduled by the teardown itself.
    expect(scheduled).toHaveLength(1);
  });

  it('renders ONE static frame and no loop under prefers-reduced-motion', () => {
    mockReducedMotion(true);
    render(<ConstellationField />);
    // Drawn once...
    expect(ctx.calls).toContain('arc');
    // ...and never animated.
    expect(scheduled).toHaveLength(0);
  });

  it('honours the wallet own reduce-motion setting (data-reduced-motion)', () => {
    // App.tsx stamps this on <html> from Settings, independently of the OS.
    document.documentElement.dataset.reducedMotion = 'true';
    render(<ConstellationField />);
    expect(ctx.calls).toContain('arc');
    expect(scheduled).toHaveLength(0);
  });

  it('takes no pointer listener at all when motion is reduced', () => {
    mockReducedMotion(true);
    const addWindow = vi.spyOn(window, 'addEventListener');
    render(<ConstellationField />);
    expect(addWindow.mock.calls.map((c) => c[0])).not.toContain('pointermove');
  });

  it('carries its variant, so the lock screen can ask for the calmer field', () => {
    render(<ConstellationField variant="calm" />);
    expect(screen.getByTestId('constellation-field')).toHaveAttribute('data-variant', 'calm');
  });

  it('renders nothing animated when the engine has no 2D context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const { unmount } = render(<ConstellationField />);
    expect(screen.getByTestId('constellation-field')).toBeInTheDocument();
    expect(scheduled).toHaveLength(0);
    // Unmounting a field that never started must not throw either.
    expect(() => unmount()).not.toThrow();
  });
});

describe('parseCssColor', () => {
  it('reads the forms a resolved CSS custom property can hold', () => {
    expect(parseCssColor('#5a5aff')).toEqual([90, 90, 255]);
    expect(parseCssColor(' #5A5AFF ')).toEqual([90, 90, 255]);
    expect(parseCssColor('#abc')).toEqual([170, 187, 204]);
    expect(parseCssColor('rgb(90, 90, 255)')).toEqual([90, 90, 255]);
    expect(parseCssColor('rgba(90 90 255 / 0.5)')).toEqual([90, 90, 255]);
  });

  it('refuses anything it cannot read, so the caller keeps its fallback', () => {
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor('   ')).toBeNull();
    expect(parseCssColor('color-mix(in srgb, var(--accent) 16%, transparent)')).toBeNull();
    expect(parseCssColor('#12345')).toBeNull();
  });
});

describe('readAccentRgb', () => {
  it('falls back to the Satori accent when the token cannot be resolved', () => {
    // jsdom resolves custom properties to '', which is exactly the case this
    // guard exists for: the field still paints in the brand hue.
    expect(readAccentRgb()).toEqual([90, 90, 255]);
  });
});

describe('themeAlphaScale', () => {
  it('lifts the field on the light theme and leaves the dark one alone', () => {
    document.documentElement.dataset.theme = 'dark';
    expect(themeAlphaScale()).toBe(1);
    document.documentElement.dataset.theme = 'light';
    expect(themeAlphaScale()).toBeGreaterThan(1);
  });
});

describe('shouldReduceMotion', () => {
  it('is false by default', () => {
    mockReducedMotion(false);
    expect(shouldReduceMotion()).toBe(false);
  });

  it('follows the OS media query', () => {
    mockReducedMotion(true);
    expect(shouldReduceMotion()).toBe(true);
  });

  it('follows the wallet own setting even when the OS says nothing', () => {
    mockReducedMotion(false);
    document.documentElement.dataset.reducedMotion = 'true';
    expect(shouldReduceMotion()).toBe(true);
  });
});
