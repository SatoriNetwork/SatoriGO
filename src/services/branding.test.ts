import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLogoFromUrl, isSvgSafe, validateLogoBytes } from './branding';
import { MAX_LOGO_BYTES } from './constants';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>';

const text = (s: string) => new TextEncoder().encode(s);

describe('validateLogoBytes', () => {
  it('accepts PNG and JPEG by magic bytes', () => {
    expect(validateLogoBytes(PNG_BYTES, 'image/png').ok).toBe(true);
    expect(validateLogoBytes(JPEG_BYTES, 'image/jpeg').ok).toBe(true);
  });

  it('produces a data URL with the sniffed mime', () => {
    const result = validateLogoBytes(PNG_BYTES, 'application/octet-stream', 'logo.png');
    expect(result.ok).toBe(true);
    expect(result.logo?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects empty and oversized files', () => {
    expect(validateLogoBytes(new Uint8Array(0), 'image/png').error).toBe('empty');
    expect(validateLogoBytes(new Uint8Array(MAX_LOGO_BYTES + 1), 'image/png').error).toBe('too-large');
  });

  it('rejects non-image bytes', () => {
    expect(validateLogoBytes(text('hello world'), 'image/png').error).toBe('not-an-image');
  });

  it('accepts a safe SVG', () => {
    const result = validateLogoBytes(text(SAFE_SVG), 'image/svg+xml', 'logo.svg');
    expect(result.ok).toBe(true);
    expect(result.logo?.mime).toBe('image/svg+xml');
  });

  it('rejects unsafe SVG content', () => {
    const cases = [
      '<svg xmlns="x"><script>alert(1)</script></svg>',
      '<svg xmlns="x" onload="alert(1)"></svg>',
      '<svg xmlns="x"><a href="javascript:alert(1)">x</a></svg>',
      '<svg xmlns="x"><foreignObject></foreignObject></svg>',
      '<svg xmlns="x"><iframe src="https://evil"/></svg>',
      'not svg at all',
    ];
    for (const svg of cases) {
      expect(validateLogoBytes(text(svg), 'image/svg+xml', 'x.svg').ok).toBe(false);
    }
  });

  it('isSvgSafe requires an <svg> root', () => {
    expect(isSvgSafe(SAFE_SVG)).toBe(true);
    expect(isSvgSafe('<div>nope</div>')).toBe(false);
  });
});

describe('fetchLogoFromUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches and validates a remote PNG', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG_BYTES, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })));
    const result = await fetchLogoFromUrl('https://example.com/logo.png');
    expect(result.ok).toBe(true);
    expect(result.logo?.mime).toBe('image/png');
  });

  it('rejects invalid URLs and non-http schemes', async () => {
    expect((await fetchLogoFromUrl('not a url')).error).toBe('fetch-failed');
    expect((await fetchLogoFromUrl('file:///etc/passwd')).error).toBe('fetch-failed');
  });

  it('propagates HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    expect((await fetchLogoFromUrl('https://example.com/missing.png')).error).toBe('fetch-failed');
  });
});
