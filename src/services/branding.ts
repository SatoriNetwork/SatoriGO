// Branding service: wallet name/subtitle, logo overrides (upload / URL /
// official), logo size & style. Custom logos are validated, stored as data
// URLs in storage and always rendered through <img> (never inline HTML),
// which keeps SVG handling safe.

import { getStorage } from './storage';
import { MAX_LOGO_BYTES } from './constants';

export type LogoSlot = 'header' | 'evr' | 'satori';
export type LogoSize = 'sm' | 'md' | 'lg';
export type LogoStyle = 'circle' | 'rounded' | 'square';

export interface CustomLogo {
  dataUrl: string;
  mime: string;
  fileName?: string;
}

export interface BrandingConfig {
  walletName: string;
  subtitle: string;
  logoSize: LogoSize;
  logoStyle: LogoStyle;
  /** Missing slot = official bundled logo. */
  logos: Partial<Record<LogoSlot, CustomLogo>>;
}

export const DEFAULT_BRANDING: BrandingConfig = {
  walletName: 'EVRmore Wallet',
  subtitle: 'Powered by EVRmore • Built for SATORI',
  logoSize: 'md',
  logoStyle: 'circle',
  logos: {},
};

const KEY = 'branding';

export async function loadBranding(): Promise<BrandingConfig> {
  const stored = await getStorage().get<Partial<BrandingConfig>>(KEY);
  return { ...DEFAULT_BRANDING, ...(stored ?? {}), logos: { ...(stored?.logos ?? {}) } };
}

export async function saveBranding(config: BrandingConfig): Promise<void> {
  await getStorage().set(KEY, config);
}

// ---------------------------------------------------------------------------
// Validation

export const ALLOWED_LOGO_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
] as const;

export type LogoValidationError =
  | 'unsupported-type'
  | 'too-large'
  | 'empty'
  | 'unsafe-svg'
  | 'not-an-image'
  | 'fetch-failed';

export interface LogoValidationResult {
  ok: boolean;
  error?: LogoValidationError;
  logo?: CustomLogo;
}

const SVG_FORBIDDEN = [
  /<script/i,
  /\son\w+\s*=/i,
  /javascript:/i,
  /<foreignobject/i,
  /<iframe/i,
  /<embed/i,
  /<object/i,
];

export function isSvgSafe(svgText: string): boolean {
  if (!/<svg[\s>]/i.test(svgText)) return false;
  return !SVG_FORBIDDEN.some((re) => re.test(svgText));
}

function sniffRasterMime(bytes: Uint8Array): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Validates raw logo bytes and converts them into a storable CustomLogo. */
export function validateLogoBytes(
  bytes: Uint8Array,
  declaredMime: string,
  fileName?: string,
): LogoValidationResult {
  if (bytes.length === 0) return { ok: false, error: 'empty' };
  if (bytes.length > MAX_LOGO_BYTES) return { ok: false, error: 'too-large' };

  const isSvgDeclared = declaredMime === 'image/svg+xml' || (fileName ?? '').toLowerCase().endsWith('.svg');
  if (isSvgDeclared) {
    const text = new TextDecoder().decode(bytes);
    if (!isSvgSafe(text)) return { ok: false, error: 'unsafe-svg' };
    return {
      ok: true,
      logo: {
        dataUrl: `data:image/svg+xml;base64,${bytesToBase64(bytes)}`,
        mime: 'image/svg+xml',
        fileName,
      },
    };
  }

  const sniffed = sniffRasterMime(bytes);
  if (!sniffed) return { ok: false, error: 'not-an-image' };
  if (!(ALLOWED_LOGO_MIMES as readonly string[]).includes(sniffed)) {
    return { ok: false, error: 'unsupported-type' };
  }
  return {
    ok: true,
    logo: { dataUrl: `data:${sniffed};base64,${bytesToBase64(bytes)}`, mime: sniffed, fileName },
  };
}

export async function validateLogoFile(file: File): Promise<LogoValidationResult> {
  if (file.size > MAX_LOGO_BYTES) return { ok: false, error: 'too-large' };
  const buffer = await file.arrayBuffer();
  return validateLogoBytes(new Uint8Array(buffer), file.type, file.name);
}

/** Fetches a logo from an http(s) URL once, at save time, and stores it as a
 *  data URL — the extension never loads remote images at runtime. */
export async function fetchLogoFromUrl(url: string): Promise<LogoValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'fetch-failed' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'fetch-failed' };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(parsed.href, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return { ok: false, error: 'fetch-failed' };
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_LOGO_BYTES) return { ok: false, error: 'too-large' };
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    return validateLogoBytes(new Uint8Array(buffer), mime, parsed.pathname.split('/').pop());
  } catch {
    return { ok: false, error: 'fetch-failed' };
  }
}
