// Deterministic account identicon — a blockies-style mark derived from an
// address (or, with no address yet, from a wallet id).
//
// Why hand-rolled and not a library: this is a wallet that ships as a browser
// extension, so every dependency is another package a reviewer has to trust and
// another few KB in the bundle. The whole thing is ~40 lines of pure arithmetic
// with no I/O, no network, and no randomness, so the same address always draws
// the same mark on every device and in every test.
//
// Shape: a 5x5 grid mirrored horizontally (columns 0/1 are copied to 4/3), the
// same symmetry Ethereum blockies use, so a mark reads as a "face" rather than
// as noise. Three colours come out of one hash of the string, all kept in the
// 45-60% lightness band at ~65% saturation: that band is the one that has real
// contrast against BOTH the dark and the light theme background, so the mark
// never washes out on one of them.

/** FNV-1a, 32-bit. Cheap, well-mixed enough for a 15-cell grid + three hues,
 *  and identical on every JS engine (no floating point in the loop). */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, done with imul so the result stays a 32-bit int.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — a tiny deterministic PRNG seeded by the hash above. Used only
 *  to pick which of the three colours each cell takes. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The three colours of one mark. Hues are pushed apart on purpose (a second
 *  hue 115-169 degrees away, a third 215-269 away) so no mark ends up as three
 *  shades of the same colour, which is what makes two accounts hard to tell
 *  apart at 16px. Those windows keep EVERY pairwise gap at 40 degrees or more,
 *  whatever the hash says. */
export function avatarColors(key: string): [string, string, string] {
  const h = fnv1a(key);
  const h1 = h % 360;
  const h2 = (h1 + 115 + ((h >>> 8) % 55)) % 360;
  const h3 = (h1 + 215 + ((h >>> 16) % 55)) % 360;
  return [
    `hsl(${h1} 65% 48%)`,
    `hsl(${h2} 65% 58%)`,
    `hsl(${h3} 65% 52%)`,
  ];
}

/** The 5x5 colour-index grid, row-major, mirrored horizontally. Exported for
 *  the unit test (and because a pure function is easier to reason about than a
 *  loop buried in JSX). */
export function avatarCells(key: string): number[] {
  const rand = prng(fnv1a(`${key}#cells`));
  const cells: number[] = new Array(25);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      // 2.3 (not 3) biases the draw towards the first two colours, so the third
      // one stays an accent instead of a third of the mark.
      const v = Math.floor(rand() * 2.3);
      cells[y * 5 + x] = v;
      cells[y * 5 + (4 - x)] = v;
    }
  }
  return cells;
}

export interface AccountAvatarProps {
  /** The account's address. Primary seed for the mark. */
  address?: string;
  /** Fallback seed (a wallet id) for an entry that has no address yet. */
  seed?: string;
  /** Rendered box in px (square). */
  size?: number;
  className?: string;
  /** Accessible name. Omitted = decorative (the row already names the account
   *  in text), so the mark is hidden from assistive tech instead of read out as
   *  a second, meaningless label. */
  label?: string;
}

export function AccountAvatar({ address, seed, size = 16, className, label }: AccountAvatarProps) {
  // Addresses differ in case between chains (EVM checksums, base58 does not),
  // so the key is lowercased: the same account must not get two different marks
  // because one screen printed it checksummed and another did not.
  const key = (address || seed || '').toLowerCase();
  const [c0, c1, c2] = avatarColors(key);
  const palette = [c0, c1, c2];
  const cells = avatarCells(key);
  const testId = `account-avatar-${(address || seed || '').slice(0, 6)}`;
  return (
    <svg
      role="img"
      {...(label ? { 'aria-label': label } : { 'aria-hidden': true })}
      data-testid={testId}
      className={className}
      width={size}
      height={size}
      viewBox="0 0 5 5"
      shapeRendering="crispEdges"
      style={{ borderRadius: '50%', flexShrink: 0, display: 'block' }}
    >
      {/* Base fill first: the rects below only need to paint the cells that
          differ from it, and it guarantees no transparent gap at the rounded
          edge whatever the grid says. */}
      <rect width="5" height="5" fill={c0} />
      {cells.map((v, i) =>
        v === 0 ? null : (
          <rect key={i} x={i % 5} y={Math.floor(i / 5)} width="1" height="1" fill={palette[v]} />
        ),
      )}
    </svg>
  );
}
