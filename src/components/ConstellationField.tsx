import { useEffect, useRef } from 'react';

/**
 * The Satori network, drawn as the background of a screen.
 *
 * Soft dots drift slowly across the frame and a thin line is drawn between any
 * pair close enough to be neighbours, fading out as they separate. It is the
 * one picture that says what this wallet is part of, so it belongs on the two
 * screens a user meets before there is any wallet to look at: first run and the
 * lock screen.
 *
 * Rules this file keeps, because a decorative canvas that misbehaves costs
 * battery on every popup open:
 *
 *  - PAINTS BEHIND, never over: absolute, z-index 0, pointer-events none, and
 *    aria-hidden. It is decoration; nothing here is content.
 *  - CAPPED at 60fps and PAUSED whenever the document is hidden, so a popup
 *    left open in a background tab costs nothing.
 *  - REDUCED MOTION renders exactly one static frame: no loop, no parallax, no
 *    listeners. Honours BOTH the OS media query and the wallet's own
 *    "reduce motion" setting (App.tsx stamps data-reduced-motion on <html>).
 *  - COLOUR comes from the --accent token, read once on mount and re-read when
 *    the theme or the accent changes (Settings can switch both at runtime).
 *    No colour is invented here.
 *
 * Cost: one O(n^2) neighbour pass over at most ~62 points, which is ~1.9k
 * distance tests per frame. A grid would be faster and much less obvious; at
 * this point count it would also be slower to read than it is to run.
 */

export type ConstellationVariant = 'welcome' | 'calm';

interface Preset {
  /** How many dots. Stays inside the 40-70 band at every variant. */
  count: number;
  /** Drift, in px per 60fps frame (0.16 is ~10px/s: a slow wander, not motion
   *  the eye tracks). */
  speed: number;
  /** Pairs closer than this many px get a line. */
  link: number;
  dotAlpha: number;
  lineAlpha: number;
  /** How many px the whole field shifts toward the cursor, at most. */
  parallax: number;
  dotRadius: number;
  haloRadius: number;
}

const PRESETS: Record<ConstellationVariant, Preset> = {
  // First run: the screen is meant to have some life in it.
  welcome: {
    count: 62,
    speed: 0.16,
    link: 92,
    dotAlpha: 0.5,
    lineAlpha: 0.26,
    parallax: 8,
    dotRadius: 1.5,
    haloRadius: 3.4,
  },
  // The lock screen is the SAME world, only slightly turned down: nearly the
  // welcome's density and glow, a touch slower. It started dimmer (36 dots,
  // half the alpha) but the owner could barely see it there and asked for the
  // welcome treatment (2026-08-25); "calm" now means the pace, not the volume.
  calm: {
    count: 54,
    speed: 0.11,
    link: 92,
    dotAlpha: 0.46,
    lineAlpha: 0.23,
    parallax: 6,
    dotRadius: 1.5,
    haloRadius: 3.4,
  },
};

/** The Satori accent from global.css. Used only when the custom property cannot
 *  be read at all (jsdom resolves custom properties to ''), so the field still
 *  renders in the brand hue instead of falling back to something invented. */
const FALLBACK_RGB: [number, number, number] = [90, 90, 255];

/** 60fps ceiling. The 0.5ms slack stops a 60Hz display from dropping every
 *  other frame because rAF fired a hair early. */
const FRAME_MS = 1000 / 60 - 0.5;

/** `#abc`, `#aabbcc` and `rgb()/rgba()` — the forms a CSS custom property can
 *  hold once the browser has resolved it. Anything else (a color-mix() that the
 *  engine did not resolve, an empty string) returns null and the caller keeps
 *  its fallback. */
export function parseCssColor(raw: string): [number, number, number] | null {
  const value = raw.trim();
  if (!value) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16),
        parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16),
      ];
    }
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
  if (rgb) return [Math.round(+rgb[1]), Math.round(+rgb[2]), Math.round(+rgb[3])];
  return null;
}

/** The accent the app is currently painted in, as raw channels. */
export function readAccentRgb(root?: Element): [number, number, number] {
  try {
    const el = root ?? document.documentElement;
    return parseCssColor(getComputedStyle(el).getPropertyValue('--accent')) ?? FALLBACK_RGB;
  } catch {
    return FALLBACK_RGB;
  }
}

/** The light theme puts this field on #f5f5f7 instead of #0d0d0d, where the same
 *  alphas read as a smudge. One multiplier, no second palette. */
export function themeAlphaScale(root?: Element): number {
  try {
    const el = (root ?? document.documentElement) as HTMLElement;
    return el.dataset?.theme === 'light' ? 1.3 : 1;
  } catch {
    return 1;
  }
}

/**
 * Whether this session wants no animation. TWO sources, because the wallet has
 * its own switch (Settings > reduce motion) that a user can turn on without
 * touching their OS: App.tsx folds both into data-reduced-motion on <html>, and
 * the media query is read directly as well so the field is still correct on a
 * surface that mounts before that attribute is stamped.
 */
export function shouldReduceMotion(): boolean {
  try {
    if (typeof document !== 'undefined' && document.documentElement.dataset.reducedMotion === 'true') {
      return true;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface Point {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function ConstellationField({
  variant = 'welcome',
}: {
  variant?: ConstellationVariant;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    // No 2D context (an engine without canvas support): render nothing rather
    // than throwing on a decorative element.
    if (!ctx) return;

    const preset = PRESETS[variant];
    // The canvas is inset:0 inside a positioned parent, so its own client box IS
    // the screen. The fallbacks are the popup's fixed canvas, which is what a
    // non-layouting environment (jsdom) should behave as.
    let width = canvas.clientWidth || 400;
    let height = canvas.clientHeight || 600;
    let rgb = readAccentRgb();
    let alphaScale = themeAlphaScale();

    const points: Point[] = Array.from({ length: preset.count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      // A direction with a fixed magnitude: dots wander, none of them races.
      ...(() => {
        const a = Math.random() * Math.PI * 2;
        return { vx: Math.cos(a) * preset.speed, vy: Math.sin(a) * preset.speed };
      })(),
    }));

    /** Where the field has shifted to (eased), and where the cursor wants it. */
    let offsetX = 0;
    let offsetY = 0;
    let targetX = 0;
    let targetY = 0;

    let reduced = shouldReduceMotion();
    let frame = 0;
    let last = 0;

    const resize = () => {
      const w = canvas.clientWidth || width;
      const h = canvas.clientHeight || height;
      // devicePixelRatio-aware: the backing store is in device pixels, every
      // draw below stays in CSS px because of the transform in draw().
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const bw = Math.max(1, Math.round(w * dpr));
      const bh = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      // Keep the points inside the new box rather than re-rolling them, so a
      // resize does not visibly reshuffle the field.
      if (w !== width || h !== height) {
        for (const p of points) {
          p.x = width ? (p.x / width) * w : Math.random() * w;
          p.y = height ? (p.y / height) * h : Math.random() * h;
        }
        width = w;
        height = h;
      }
    };

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      // The parallax offset rides in the transform, so nothing below has to
      // add it per point.
      ctx.setTransform(dpr, 0, 0, dpr, offsetX * dpr, offsetY * dpr);
      ctx.clearRect(-16, -16, width + 32, height + 32);

      const color = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      const link2 = preset.link * preset.link;

      // Lines first, so the dots sit on top of their own connections.
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      const lineAlpha = preset.lineAlpha * alphaScale;
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        for (let j = i + 1; j < points.length; j += 1) {
          const b = points[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= link2) continue;
          // Squared falloff: a line appears as a hint and only firms up when
          // the pair is genuinely close.
          const t = 1 - Math.sqrt(d2) / preset.link;
          ctx.globalAlpha = lineAlpha * t * t;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // Dots: a soft halo plus a small core, which is what makes them read as
      // lights rather than as pixels.
      ctx.fillStyle = color;
      const dotAlpha = preset.dotAlpha * alphaScale;
      for (const p of points) {
        ctx.globalAlpha = dotAlpha * 0.16;
        ctx.beginPath();
        ctx.arc(p.x, p.y, preset.haloRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = dotAlpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, preset.dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      // 60fps ceiling: on a 120Hz display this simply skips every other callback.
      if (now - last < FRAME_MS) return;
      // `delta` in 60fps frames, clamped so a backgrounded tab returning does
      // not teleport the whole field on its first frame.
      const delta = last ? Math.min((now - last) / (1000 / 60), 3) : 1;
      last = now;

      for (const p of points) {
        p.x += p.vx * delta;
        p.y += p.vy * delta;
        // Wrap with a margin, so a dot leaves and re-enters instead of
        // popping at the edge.
        if (p.x < -20) p.x = width + 20;
        else if (p.x > width + 20) p.x = -20;
        if (p.y < -20) p.y = height + 20;
        else if (p.y > height + 20) p.y = -20;
      }

      // Ease toward the cursor: 8% per frame is slow enough that the field
      // follows the pointer rather than tracking it.
      offsetX += (targetX - offsetX) * 0.08 * delta;
      offsetY += (targetY - offsetY) * 0.08 * delta;

      draw();
    };

    const start = () => {
      if (frame || reduced) return;
      last = 0;
      frame = requestAnimationFrame(step);
    };
    const stop = () => {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    };

    /** Reduced motion is a live setting: switching it on must stop the loop and
     *  leave one honest static frame behind, and switching it off must start. */
    const applyMotion = () => {
      const next = shouldReduceMotion();
      if (next === reduced) return;
      reduced = next;
      if (reduced) {
        stop();
        offsetX = 0;
        offsetY = 0;
        targetX = 0;
        targetY = 0;
        draw();
      } else {
        start();
      }
    };

    const onPointerMove = (e: PointerEvent | MouseEvent) => {
      if (reduced) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      targetX = ((e.clientX - rect.left) / rect.width - 0.5) * preset.parallax;
      targetY = ((e.clientY - rect.top) / rect.height - 0.5) * preset.parallax;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const onResize = () => {
      resize();
      if (reduced) draw();
    };

    resize();
    draw();

    if (!reduced) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      document.addEventListener('visibilitychange', onVisibility);
      start();
    }

    // Resize: the popup is fixed, but the detached window and the side panel are
    // both user-resizable.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onResize);
      observer.observe(canvas);
    } else {
      window.addEventListener('resize', onResize);
    }

    // Theme, accent and reduce-motion all land on <html> as data-* attributes
    // (App.tsx), so one observer catches every one of them.
    let themeObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => {
        rgb = readAccentRgb();
        alphaScale = themeAlphaScale();
        applyMotion();
        if (reduced) draw();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-accent', 'data-reduced-motion'],
      });
    }

    // The OS setting can also change while the popup is open.
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    media?.addEventListener?.('change', applyMotion);

    return () => {
      stop();
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      themeObserver?.disconnect();
      media?.removeEventListener?.('change', applyMotion);
    };
  }, [variant]);

  return (
    <canvas
      ref={canvasRef}
      className="constellation-field"
      data-testid="constellation-field"
      data-variant={variant}
      aria-hidden="true"
    />
  );
}
