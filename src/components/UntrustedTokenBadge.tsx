// The wallet's own mark on a token it will not vouch for: EVM tokens that fail
// the trust rule in services/chain/evm/tokenTrust.ts (in the chain's public
// token list AND carrying a registry mark). Owner's request (2026-08-19): a
// mark on every such token, an explanation on click, and the same disclaimer
// when sending one.
//
// WHY IT IS A FILLED PILL AND NOT A BARE ICON (2026-08-25 security review).
// A token's symbol is drawn from a string its own author chose, and real rows
// on a live Base account read `www.badrp.co ✅`: the green check is INSIDE the
// token's name, and it was larger and more colourful than the small outlined
// triangle the wallet put beside it. A token was out-badging the wallet in the
// wallet's own list. Two changes fix that: every symbol is now drawn through
// services/displaySymbol.ts, which removes the forged check entirely, and this
// warning is a SOLID pill in the warning colour with the word "unlisted" in it,
// so what remains is unmistakably the wallet speaking rather than the token.
//
// WHAT IT CLAIMS IS NARROW AND HONEST: nobody the wallet checks has listed it.
// Airdrop and scam tokens are the common case, and so is any small or new token
// nobody has got round to listing. The wallet never blocks; it says what it
// does and does not know.

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { useTokenTrust } from '../store/tokenLogoRegistry';
import { displaySymbol, isSymbolSanitised } from '../services/displaySymbol';

/** The word in the pill. Short enough to sit inside a token row. */
export const UNTRUSTED_TOKEN_LABEL = 'unlisted';

export const UNTRUSTED_TOKEN_NOTE =
  'It is not in the public token registries this wallet checks, so there is nothing here to confirm it is what its name says. Unlisted is not proof of anything by itself: new and small tokens are often unlisted, and so is nearly all airdropped spam. Treat its name and symbol as text its creator chose, and check the contract address against a source you trust before you send it, approve it, or act on anything it tells you to do.';

/** Extra sentence for a token whose symbol had to be cleaned up to be drawn. */
export const SANITISED_SYMBOL_NOTE =
  'Its symbol also carries characters this wallet does not draw, such as emoji or text-direction controls, so what you see here is shortened and stripped.';

/** True when `symbol` was checked against the trust rule and the wallet will
 *  not vouch for it. `null` (not checked) is NOT a warning: no claim either way. */
export function useIsUntrustedToken(symbol: string): boolean {
  return useTokenTrust(symbol) === false;
}

/** The heading both the pill's note and the banner use. */
function headline(symbol: string): string {
  return `Satori GO cannot vouch for ${displaySymbol(symbol)}.`;
}

/** The filled "unlisted" pill; clicking it opens the explanation. Renders
 *  nothing for a vouched-for or unchecked token. Stops click propagation so it
 *  can sit inside a clickable row.
 *
 *  `symbol` is the RAW symbol throughout: it is the registry key, and it is
 *  what the data-testids are built from. Only what is DRAWN goes through
 *  displaySymbol(). */
/** Popover geometry. The frame is 400x600 in the popup, so a note anchored under
 *  a row near the bottom would run off the screen with no way to scroll it. */
const NOTE_WIDTH = 300;
const NOTE_MARGIN = 8;
/** Below this much free space, the note is placed ABOVE the pill instead. */
const NOTE_MIN_ROOM = 150;

interface NotePosition {
  top: number;
  left: number;
  maxHeight: number;
}

/** Where the note goes, given the pill's box and the viewport: under the pill
 *  when there is room, above it when there is not, and never taller than the
 *  space it has (it scrolls inside instead of running off the frame). */
export function notePositionFor(
  rect: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
): NotePosition {
  const left = Math.max(NOTE_MARGIN, Math.min(rect.left, viewport.width - NOTE_WIDTH - NOTE_MARGIN));
  const below = viewport.height - rect.bottom - 6 - NOTE_MARGIN;
  const above = rect.top - 6 - NOTE_MARGIN;
  if (below < NOTE_MIN_ROOM && above > below) {
    const maxHeight = Math.max(60, above);
    return { top: Math.max(NOTE_MARGIN, rect.top - 6 - maxHeight), left, maxHeight };
  }
  return { top: rect.bottom + 6, left, maxHeight: Math.max(60, below) };
}

export function UntrustedTokenBadge({ symbol }: { symbol: string }) {
  const untrusted = useIsUntrustedToken(symbol);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<NotePosition | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLSpanElement>(null);

  // The note is portaled to <body> and positioned against the pill: the rows it
  // sits in clip their overflow (ellipsised names), so an in-flow popover would
  // be cut off. Outside click / Escape / scroll close it. A scroll INSIDE the
  // note is how a long note is read, so that one is not a close.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && noteRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  if (!untrusted) return null;
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect();
      const viewport =
        typeof window !== 'undefined'
          ? { width: window.innerWidth, height: window.innerHeight }
          : { width: NOTE_WIDTH + 16, height: 600 };
      setPos(notePositionFor(r ?? { top: 0, bottom: 0, left: 0 }, viewport));
    }
    setOpen((v) => !v);
  };
  const note = open ? (
    <span
      ref={noteRef}
      role="note"
      data-testid={`live-untrusted-note-${symbol}`}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: pos?.top ?? 0,
        left: pos?.left ?? NOTE_MARGIN,
        zIndex: 1000,
        width: NOTE_WIDTH,
        maxHeight: pos?.maxHeight,
        overflowY: 'auto',
        display: 'block',
        whiteSpace: 'normal',
        fontSize: 11,
        lineHeight: 1.45,
        padding: '8px 10px',
        borderRadius: 8,
        color: 'var(--text)',
        background: 'var(--card-solid, var(--card))',
        border: '1px solid var(--warning)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
        textAlign: 'left',
      }}
    >
      <strong style={{ color: 'var(--warning)' }}>{headline(symbol)}</strong> {UNTRUSTED_TOKEN_NOTE}
      {isSymbolSanitised(symbol) ? ` ${SANITISED_SYMBOL_NOTE}` : ''}
    </span>
  ) : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label={`${headline(symbol)} Show why.`}
        aria-expanded={open}
        title="Satori GO cannot vouch for this token. Tap for details."
        data-testid={`live-untrusted-${symbol}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          // Solid fill, not an outline: this has to read louder than a check
          // mark a token puts in its own symbol. --bg is near-black in the dark
          // theme and near-white in the light one, so it stays legible on the
          // warning colour in both.
          background: 'var(--warning)',
          color: 'var(--bg)',
          // 10px is the floor the popup's legibility check enforces on every
          // piece of text in the dense list, and this one has to be READ, not
          // just noticed: it is the wallet's sentence about the token.
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.02em',
          padding: '1px 5px',
          borderRadius: 999,
          border: 'none',
          cursor: 'pointer',
          lineHeight: 1.5,
          whiteSpace: 'nowrap',
        }}
      >
        <AlertTriangle size={9} strokeWidth={2.5} style={{ flexShrink: 0 }} />
        {UNTRUSTED_TOKEN_LABEL}
      </button>
      {note && typeof document !== 'undefined' ? createPortal(note, document.body) : note}
    </span>
  );
}

/** The same warning as a banner (send screen, asset detail). Amber, not red:
 *  "we cannot vouch for this" is not the same statement as "this is a scam",
 *  and the wallet must not make the stronger one it cannot support. */
export function UntrustedTokenBanner({ symbol }: { symbol: string }) {
  const untrusted = useIsUntrustedToken(symbol);
  if (!untrusted) return null;
  return (
    <div className="banner warning" data-testid={`live-untrusted-banner-${symbol}`} style={{ alignItems: 'flex-start', marginBottom: 10 }}>
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
      <span>
        <strong>{headline(symbol)}</strong> {UNTRUSTED_TOKEN_NOTE}
        {isSymbolSanitised(symbol) ? ` ${SANITISED_SYMBOL_NOTE}` : ''}
      </span>
    </div>
  );
}
