// Token marks for EVM tokens the user added or imported (owner's request,
// 2026-08-19: "for imported tokens fetch their images too, if they exist").
//
// Source: the Trust Wallet assets repository on GitHub, the de-facto public
// registry of token logos, keyless, one host, PNGs of a few KB:
//   https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/<chain>/assets/<EIP-55 address>/logo.png
// (Alchemy's token metadata carries `logo: null` for Base and BNB Chain tokens,
// verified live, so it is no help here.) A token without an entry there (every
// airdrop/spam token) simply keeps the letter badge.
//
// The extension's CSP is `img-src 'self' data: blob:` plus the Satori GO
// gateway origin and nothing else, so a THIRD-PARTY url still cannot be put in
// an <img>: the bytes are FETCHED (the host is a dev-injected
// permission), validated as a PNG of bounded size, and stored as a data: URL,
// exactly how custom branding logos are handled elsewhere in this wallet. Never
// SVG (scriptable), never unbounded.

import { normalizeEvmAddress, isEvmAddress } from './keys';
import { evmGatewayHeaders, evmGatewayUrl } from './endpoints';

export const TRUST_WALLET_ASSETS_HOST_PATTERN = 'https://raw.githubusercontent.com/*';
const TRUST_WALLET_BASE = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains';

/** Largest logo accepted, bytes. Trust Wallet marks are 3 to 25 KB; anything
 *  bigger is not a token logo and would bloat extension storage. */
export const MAX_TOKEN_LOGO_BYTES = 64 * 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The logo URL for a token contract on a chain, or null when the chain has no
 *  Trust Wallet folder or the address is malformed. With a gateway configured
 *  the mark is served by `<gateway>/evm/marks/<chain>/<address>` (same bytes,
 *  cached server-side, 404 passed through: the verdict semantics are identical);
 *  otherwise straight from the GitHub raw host. */
export function trustWalletLogoUrl(
  trustWalletChain: string | null | undefined,
  contract: string,
  gateway: string = evmGatewayUrl(),
): string | null {
  if (!trustWalletChain || !/^[a-z0-9-]+$/.test(trustWalletChain)) return null;
  if (!isEvmAddress(contract)) return null;
  const address = normalizeEvmAddress(contract);
  if (gateway) return `${gateway}/evm/marks/${trustWalletChain}/${address}`;
  return `${TRUST_WALLET_BASE}/${trustWalletChain}/assets/${address}/logo.png`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Validate PNG bytes (magic + size) and wrap them as a data: URL, or null. */
export function pngBytesToDataUrl(bytes: Uint8Array): string | null {
  if (bytes.length < PNG_MAGIC.length || bytes.length > MAX_TOKEN_LOGO_BYTES) return null;
  for (let i = 0; i < PNG_MAGIC.length; i++) if (bytes[i] !== PNG_MAGIC[i]) return null;
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

/** The outcome of asking the registry for a token's mark. 'missing' is a
 *  definitive answer (the token is not listed: untrusted); 'error' is not
 *  (network, timeout) and must be retried, never recorded as a verdict. */
export type TokenLogoProbe = { kind: 'found'; dataUrl: string } | { kind: 'missing' } | { kind: 'error' };

/**
 * Fetch one token logo. Never throws. A 404 is 'missing' (the registry
 * answered: not listed); a non-PNG or oversized body counts as 'missing' too
 * (whatever sits there is not a usable mark); a transport failure, a timeout or
 * a 5xx is 'error'.
 */
export async function fetchTokenLogo(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch?.bind(globalThis),
  timeoutMs = 8_000,
): Promise<TokenLogoProbe> {
  if (!fetchImpl) return { kind: 'error' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: evmGatewayHeaders() });
    if (res.status === 404) return { kind: 'missing' };
    if (!res.ok) return { kind: 'error' };
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_TOKEN_LOGO_BYTES) return { kind: 'missing' };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dataUrl = pngBytesToDataUrl(bytes);
    return dataUrl ? { kind: 'found', dataUrl } : { kind: 'missing' };
  } catch {
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** The data: URL or null (404, non-PNG, oversized, or a network failure). */
export async function fetchTokenLogoDataUrl(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch?.bind(globalThis),
  timeoutMs = 8_000,
): Promise<string | null> {
  const probe = await fetchTokenLogo(url, fetchImpl, timeoutMs);
  return probe.kind === 'found' ? probe.dataUrl : null;
}
