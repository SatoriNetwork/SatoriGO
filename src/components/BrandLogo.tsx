// Renders a branded logo for a slot. Custom logos come from branding storage
// as validated data URLs and are always rendered via <img> — never inline
// markup — so SVG content cannot execute anything.

import { useBrandingStore } from '../store/brandingStore';
import { useTokenLogo } from '../store/tokenLogoRegistry';
import type { LogoSlot } from '../services/branding';
import { displaySymbol } from '../services/displaySymbol';
import evrLogoUrl from '../assets/evrmore-logo.svg';
import satoriLogoUrl from '../assets/satori-logo.png';
// Official Ravencoin (RVN) logo. Source: RavenProject/Ravencoin repo,
// src/qt/res/icons/raven.png (MIT licensed), downscaled from 1024x1024 to
// 256x256. https://raw.githubusercontent.com/RavenProject/Ravencoin/master/src/qt/res/icons/raven.png
import rvnLogoUrl from '../assets/raven-logo.png';
// Official Bitcoin Gold (BTGS) logo. Source: the project's own coins repo,
// BTGSCOINDEV/coins, icons_original/btgs.png, downscaled 500x500 -> 256x256 to
// match the other marks and keep the packaged bundle small.
import btgsLogoUrl from '../assets/btgs-logo.png';
// Litecoin (LTC) mark. Source: KomodoPlatform/coins, icons/ltc.png, upscaled
// from 128x128 to 256x256 to match the other marks. This is the same repository
// the verified Litecoin ElectrumX endpoints came from.
import ltcLogoUrl from '../assets/litecoin-logo.png';
// WojakCoin (WJK) mark. Source: the project's own coins repo, BTGSCOINDEV/coins,
// icons_original/wjk.png, downscaled 1015x1010 -> 256x256 to match the other
// marks. This is the SAME repository the verified Bitcoin Gold logo (and the
// BTGSCOINDEV/coins electrums/WJK server list in network.ts) came from.
import wjkLogoUrl from '../assets/wojak-logo.png';
// Official Bitcoin (BTC) mark. Source: KomodoPlatform/coins, icons/btc.png,
// resized from 128x128 to 256x256 to match the other marks. This is the SAME
// repository the verified Litecoin logo (and the KomodoPlatform/coins
// electrums/BTC server list in network.ts) came from.
import btcLogoUrl from '../assets/bitcoin-logo.png';
// Dogecoin (DOGE) mark. Source: KomodoPlatform/coins, icons/doge.png, resized
// from 128x128 to 256x256 to match the other marks. This is the SAME repository
// the Bitcoin and Litecoin marks came from, and the same operator family
// (cipig) whose verified DOGE ElectrumX endpoints are listed in network.ts.
import dogeLogoUrl from '../assets/dogecoin-logo.png';
// Neoxa (NEOX) mark. Source: the project's OWN repository, NeoxaChain/Neoxa
// (MIT, "Copyright (c) 2024 The Neoxa Core developers"), file
// src/qt/res/icons/neoxa.png -- the icon its own Qt wallet ships. Downscaled
// 1024x1024 -> 256x256 to match the other marks; it is already RGBA with
// transparent corners, so nothing else was changed. Sourced from the project
// itself rather than from a coins registry because no registry carries Neoxa
// (KomodoPlatform/coins has no NEOX entry at all -- the same absence that left
// this chain without an ElectrumX server, see network.ts).
import neoxLogoUrl from '../assets/neoxa-logo.png';
// EVM family marks (phase 3 of the EVM rollout). Ether (ETH), BNB, USD Coin
// (USDC) and Tether (USDT) come from KomodoPlatform/coins, icons/{eth,bnb,usdc,
// usdt}.png, resized 128x128 -> 256x256 like the Bitcoin/Litecoin/Dogecoin
// marks from the same repository. The Base network mark is the official
// "Square" from base/brand-kit (logo/TheSquare/Digital/Base_square_blue.svg),
// with its stylesheet inlined as a fill so the file is a plain shape.
import ethLogoUrl from '../assets/eth-logo.png';
import bnbLogoUrl from '../assets/bnb-logo.png';
import usdcLogoUrl from '../assets/usdc-logo.png';
import usdtLogoUrl from '../assets/usdt-logo.png';
import baseLogoUrl from '../assets/base-logo.svg';
// Epix (EPIX) mark, network and coin alike. Source: the project's own brand
// asset repository, EpixZone/assets (MIT, "Copyright (c) 2025 Epix"), file
// images/icons/generated/linux/epix-256.png, taken byte for byte: it is
// already 256x256 with transparent corners, the same shape as the marks above,
// so no resize was needed.
import epixLogoUrl from '../assets/epix-logo.png';
// Bitcoin BLAKE2b (BTCB2) mark, drawn in-repo (assets/btcb2-logo.svg): the fork
// publishes no logo of its own. A coin with the Bitcoin B and a "2b" tag.
import btcb2LogoUrl from '../assets/btcb2-logo.svg';

export function officialLogoUrl(slot: LogoSlot): string {
  if (slot === 'satori') return satoriLogoUrl;
  if (slot === 'rvn') return rvnLogoUrl;
  if (slot === 'btgs') return btgsLogoUrl;
  if (slot === 'ltc') return ltcLogoUrl;
  if (slot === 'wjk') return wjkLogoUrl;
  if (slot === 'btc') return btcLogoUrl;
  if (slot === 'doge') return dogeLogoUrl;
  if (slot === 'neox') return neoxLogoUrl;
  if (slot === 'btcb2') return btcb2LogoUrl;
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
  /** Any native coin or asset name. "EVR" -> EVR logo; "RVN" -> Ravencoin;
   *  "BTGS" -> Bitcoin Gold; "LTC" -> Litecoin; "WJK" -> WojakCoin; "BTC" ->
   *  Bitcoin; "DOGE" -> Dogecoin; "NEOX" -> Neoxa; a name containing "SATORI" ->
   *  the Satori logo; anything else -> a generic deterministic badge. */
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

/** Circular badge showing an asset's first 1–2 alphanumerics on a color chip.
 *  `name` is the RAW asset name: it keys the colour and the data attribute the
 *  smokes locate the mark by. Only the accessible label is drawn text, so a
 *  token cannot read its own emoji out through a screen reader. */
function GenericTokenBadge({ name, size }: { name: string; size: number }) {
  const letters = (name.replace(/[^A-Z0-9]/gi, '').slice(0, 2) || '?').toUpperCase();
  return (
    <span
      aria-label={displaySymbol(name)}
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

/** Marks that are not branding slots (no custom override): the EVM family's
 *  coins and tokens by ticker, and EVM NETWORK marks by `evm:<key>` id, which
 *  is what the chain picker and switcher pass for an EVM row so Base shows the
 *  Base mark rather than its native coin's. */
const STATIC_MARKS: Readonly<Record<string, { src: string; alt: string }>> = Object.freeze({
  ETH: { src: ethLogoUrl, alt: 'ETH' },
  BNB: { src: bnbLogoUrl, alt: 'BNB' },
  USDC: { src: usdcLogoUrl, alt: 'USDC' },
  USDT: { src: usdtLogoUrl, alt: 'USDT' },
  'EVM:BASE': { src: baseLogoUrl, alt: 'Base' },
  'EVM:BSC': { src: bnbLogoUrl, alt: 'BNB Chain' },
  // Ethereum's network mark IS its coin's mark; nobody draws a separate one.
  'EVM:ETHEREUM': { src: ethLogoUrl, alt: 'Ethereum' },
  // Epix, same story: one mark for the network and for EPIX.
  'EVM:EPIX': { src: epixLogoUrl, alt: 'Epix' },
  EPIX: { src: epixLogoUrl, alt: 'EPIX' },
});

/** Same frame as BrandLogo (style + size follow the branding settings), for a
 *  fixed mark that has no custom-logo slot. */
function StaticMark({ src, alt, size }: { src: string; alt: string; size: number }) {
  const branding = useBrandingStore((s) => s.branding);
  const px = Math.round(size * SIZE_FACTOR[branding.logoSize]);
  return (
    <span className={`logo-frame style-${branding.logoStyle}`} style={{ width: px, height: px }} data-static-mark={alt}>
      <img src={src} alt={alt} draggable={false} />
    </span>
  );
}

export function TokenIcon({ assetId, size = 38 }: TokenIconProps) {
  // RAW, upper-cased: this is the registry key and the branding-slot test. The
  // only place it is DRAWN is the alt text / accessible label, which is
  // sanitised (services/displaySymbol.ts).
  const name = (assetId ?? '').toUpperCase();
  const label = displaySymbol(name);
  // A mark fetched at runtime for a token the user added or imported (a
  // validated PNG data: URL from the token-logo registry) beats the badge.
  const runtimeLogo = useTokenLogo(name);
  const mark = STATIC_MARKS[name];
  if (mark) return <StaticMark src={mark.src} alt={mark.alt} size={size} />;
  if (runtimeLogo) return <StaticMark src={runtimeLogo} alt={label} size={size} />;
  if (name === 'EVR') return <BrandLogo slot="evr" size={size} alt="EVR" />;
  if (name === 'RVN') return <BrandLogo slot="rvn" size={size} alt="RVN" />;
  if (name === 'BTGS') return <BrandLogo slot="btgs" size={size} alt="BTGS" />;
  if (name === 'LTC') return <BrandLogo slot="ltc" size={size} alt="LTC" />;
  if (name === 'WJK') return <BrandLogo slot="wjk" size={size} alt="WJK" />;
  if (name === 'BTC') return <BrandLogo slot="btc" size={size} alt="BTC" />;
  if (name === 'DOGE') return <BrandLogo slot="doge" size={size} alt="DOGE" />;
  if (name === 'NEOX') return <BrandLogo slot="neox" size={size} alt="NEOX" />;
  if (name === 'BTCB2') return <BrandLogo slot="btcb2" size={size} alt="BTCB2" />;
  if (name.includes('SATORI')) return <BrandLogo slot="satori" size={size} alt={label} />;
  return <GenericTokenBadge name={name} size={size} />;
}
