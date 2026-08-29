import { describe, expect, it } from 'vitest';
import { MAX_TOKEN_LOGO_BYTES, fetchTokenLogo, fetchTokenLogoDataUrl, pngBytesToDataUrl, trustWalletLogoUrl } from './tokenLogos';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('token logos (Trust Wallet assets)', () => {
  it('1. builds the URL from the chain folder and the EIP-55 address', () => {
    expect(trustWalletLogoUrl('base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(
      'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/assets/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/logo.png',
    );
    expect(trustWalletLogoUrl('smartchain', '0x55d398326f99059fF775485246999027B3197955')).toContain('/smartchain/assets/0x55d398326f99059fF775485246999027B3197955/logo.png');
    expect(trustWalletLogoUrl(null, '0x55d398326f99059fF775485246999027B3197955')).toBe(null);
    expect(trustWalletLogoUrl('base', '0x1234')).toBe(null);
    expect(trustWalletLogoUrl('../etc', '0x55d398326f99059fF775485246999027B3197955')).toBe(null);
  });

  it('2. accepts a PNG within the size cap and refuses anything else', () => {
    expect(pngBytesToDataUrl(PNG)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    expect(pngBytesToDataUrl(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x3e, 0, 0, 0, 0]))).toBe(null); // "<svg>"
    expect(pngBytesToDataUrl(new Uint8Array(0))).toBe(null);
    const big = new Uint8Array(MAX_TOKEN_LOGO_BYTES + 1);
    big.set(PNG.subarray(0, 8));
    expect(pngBytesToDataUrl(big)).toBe(null);
  });

  it('3. fetch: 200 PNG -> data URL; 404, non-PNG, oversized header, thrown fetch -> null', async () => {
    const ok = async () => new Response(PNG, { status: 200 });
    expect(await fetchTokenLogoDataUrl('https://x/logo.png', ok as unknown as typeof fetch)).toMatch(/^data:image\/png;base64,/);
    const notFound = async () => new Response('', { status: 404 });
    expect(await fetchTokenLogoDataUrl('https://x/logo.png', notFound as unknown as typeof fetch)).toBe(null);
    const svg = async () => new Response('<svg></svg>', { status: 200 });
    expect(await fetchTokenLogoDataUrl('https://x/logo.png', svg as unknown as typeof fetch)).toBe(null);
    const huge = async () => new Response(PNG, { status: 200, headers: { 'content-length': String(MAX_TOKEN_LOGO_BYTES + 1) } });
    expect(await fetchTokenLogoDataUrl('https://x/logo.png', huge as unknown as typeof fetch)).toBe(null);
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await fetchTokenLogoDataUrl('https://x/logo.png', down as unknown as typeof fetch)).toBe(null);
  });

  it('4. the probe tells a listing verdict from a transient failure: 404 = missing, 5xx / thrown / timeout = error, 200 PNG = found', async () => {
    const mk = (status: number, body: BodyInit = '') => (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect((await fetchTokenLogo('https://x/l.png', mk(404))).kind).toBe('missing');
    expect((await fetchTokenLogo('https://x/l.png', mk(500))).kind).toBe('error');
    expect((await fetchTokenLogo('https://x/l.png', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).kind).toBe('error');
    expect((await fetchTokenLogo('https://x/l.png', mk(200, '<svg></svg>'))).kind).toBe('missing');
    expect(await fetchTokenLogo('https://x/l.png', mk(200, PNG))).toEqual({ kind: 'found', dataUrl: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` });
  });
});
