import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';

// jsdom does not ship crypto.subtle — use Node's WebCrypto in tests.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// jsdom ships no canvas implementation, and its getContext() answers by
// emitting "Not implemented: HTMLCanvasElement.prototype.getContext" to the
// console for every canvas the UI mounts (components/ConstellationField.tsx
// puts one behind the first-run and lock screens). Answer NULL instead, which
// is exactly what a canvas-less engine returns and precisely the case that
// component already guards: unrelated tests stay quiet and never start an
// animation loop. A test that needs a real 2D context stubs this itself (see
// ConstellationField.test.tsx).
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
}

// jsdom lacks matchMedia (used by the theme sync hook).
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
