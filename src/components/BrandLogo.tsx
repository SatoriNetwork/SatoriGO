// Renders a branded logo for a slot. Custom logos come from branding storage
// as validated data URLs and are always rendered via <img> — never inline
// markup — so SVG content cannot execute anything.

import { useBrandingStore } from '../store/brandingStore';
import type { LogoSlot } from '../services/branding';
import evrLogoUrl from '../assets/evrmore-logo.svg';
import satoriLogoUrl from '../assets/satori-logo.png';
// Official Ravencoin (RVN) logo. Source: RavenProject/Ravencoin repo,
// src/qt/res/icons/raven.png (MIT licensed), downscaled from 1024x1024 to
// 256x256. https://raw.githubusercontent.com/RavenProject/Ravencoin/master/src/qt/res/icons/raven.png
import rvnLogoUrl from '../assets/raven-logo.png';

export function officialLogoUrl(slot: LogoSlot): string {
  if (slot === 'satori') return satoriLogoUrl;
  if (slot === 'rvn') return rvnLogoUrl;
  return evrLogoUrl;
}

const SIZE_FACTOR = { sm: 0.85, md: 1, lg: 1.22 } as const;

interface BrandLogoProps {
  slot: LogoSlot;
  /** Base size in px, scaled by the branding "logo size" setting. */
  size: number;
  /** Ignore the framed style and render the raw image (welcome screen hero). */
  bare?: boolean;
  alt?: string;
  className?: string;
}

export function BrandLogo({ slot, size, bare = false, alt = '', className }: BrandLogoProps) {
  const branding = useBrandingStore((s) => s.branding);
  const custom = branding.logos[slot];
  const src = custom?.dataUrl ?? officialLogoUrl(slot);
  const px = Math.round(size * SIZE_FACTOR[branding.logoSize]);
  const classes = [
    'logo-frame',
    `style-${branding.logoStyle}`,
    bare ? 'bare' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} style={{ width: px, height: px }} data-logo-slot={slot}>
      <img src={src} alt={alt} draggable={false} />
    </span>
  );
}

interface TokenIconProps {
  /** Any EVRmore asset name. "EVR" -> EVR logo; "RVN" -> the Ravencoin logo;
   *  a name containing "SATORI" -> the Satori logo; anything else -> a
   *  generic deterministic badge. */
  assetId: string;
  size?: number;
}

/** Deterministic accent colour for a generic asset badge (stable per name). */
function assetAccent(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 62% 46%)`;
}

/** Circular badge showing an asset's first 1–2 alphanumerics on a color chip. */
function GenericTokenBadge({ name, size }: { name: string; size: number }) {
  const letters = (name.replace(/[^A-Z0-9]/gi, '').slice(0, 2) || '?').toUpperCase();
  return (
    <span
      aria-label={name}
      data-token-badge={name}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: assetAccent(name),
        color: '#fff',
        fontWeight: 700,
        fontSize: Math.round(size * 0.36),
        letterSpacing: '0.02em',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {letters}
    </span>
  );
}

export function TokenIcon({ assetId, size = 38 }: TokenIconProps) {
  const name = (assetId ?? '').toUpperCase();
  if (name === 'EVR') return <BrandLogo slot="evr" size={size} alt="EVR" />;
  if (name === 'RVN') return <BrandLogo slot="rvn" size={size} alt="RVN" />;
  if (name.includes('SATORI')) return <BrandLogo slot="satori" size={size} alt={name} />;
  return <GenericTokenBadge name={name} size={size} />;
}
