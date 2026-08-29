// The owner-authored notification banner, shown on Home right under the Block /
// Synced row. It takes the WHOLE set of notices that apply to this wallet
// (selectNotifications) and shows ONE at a time: a severity-coloured accent, an
// optional picture, the title, the body, and an optional link, with an X to
// close when the notice allows it. With more than one notice it rotates through
// them every NOTIF_ROTATE_MS and shows a small "which of how many" indicator.
//
// The rotation lives HERE rather than in the store because it is presentation:
// nothing outside this component needs to know which of the matching notices is
// on screen at this instant, and keeping it local means a rotation never
// re-renders Home.
//
// ATTRIBUTION (2026-08-25, security review). This banner sits inside the
// wallet's OWN chrome, framed by our header and our nav, and every word in it
// is written somewhere else: whoever can publish to the gateway (or steal the
// admin token) writes the title, the body, the link label, the picture and the
// dismissible flag. Rendering was already safe, but nothing on screen said the
// text was a MESSAGE rather than the wallet speaking, so a notice reading
// "ACTION REQUIRED: verify your wallet to keep access to your funds" wore the
// wallet's own authority. Three things fix that, and NONE of them can come off
// the wire:
//   1. a fixed attribution line, NOTIF_ATTRIBUTION, above every notice, with
//      the official Satori mark (read straight from the bundle, so even a
//      custom branding logo cannot stand in for it);
//   2. a fixed footer, NOTIF_SAFETY_LINE, under every notice, which is the one
//      sentence that makes the commonest phishing ask self-refuting;
//   3. the link's REAL destination host next to its authorable label (and
//      under a clickable picture), so "Verify now" pointing at some other host
//      is visible rather than hidden behind the words.
// A link whose host cannot even be parsed is not rendered as a link at all: if
// we cannot say where it goes, it does not get to be clickable.
//
// ALWAYS ESCAPABLE (same review). `dismissible: false` is honoured, but it is
// no longer a way to hold the screen: a notice that cannot be closed can always
// be COLLAPSED to a single attributed line (tap it to bring it back). The
// invariant is that the user can always get back to their balance, whatever the
// feed says. A dismissible notice keeps its X and needs no collapse control.
//
// GEOMETRY (owner, live, 2026-08-25: "the dots sit in different places as it
// rotates"). Notices are not the same size: bodies wrap to different numbers of
// lines and only some carry a picture, so a banner sized to whichever notice is
// on screen changed height every 3 seconds and dragged the indicator with it.
// The fix is that the banner is sized to the TALLEST notice in the set, always:
// all of them are rendered stacked in ONE css grid cell and the ones that are
// not current are `visibility: hidden`. The grid row is as tall as its tallest
// child, so the box never changes size while the set does not change, no
// notice's text is truncated to fit, and no magic pixel height has to be
// guessed for a font or a language. The attribution row, the close/collapse
// control and the footer row are OUTSIDE that stack (they are the same for
// every notice), and the indicator rides at the end of the footer row, so it
// hangs off boxes of constant height and cannot move.
//
// The hidden copies carry NO test ids and no accessible content (`visibility:
// hidden` takes them out of the a11y tree and out of the tab order), so exactly
// one title, one body, one image and one close button are ever findable.
//
// SECURITY: title, body and link label are OWNER-authored but are rendered as
// plain TEXT (React escapes them) — never dangerouslySetInnerHTML — so a stray
// `<b>` in a notice shows as literal text and can inject no markup. The link is
// rendered ONLY when its url is https: an http / javascript: / data: url is
// dropped rather than made clickable. Their LENGTHS are bounded at parse time
// (services/notifications.ts), so a book-length body cannot push the balance
// off the screen.
//
// SECURITY (the image, 2026-08-25): the picture is served PUBLICLY by the
// gateway at an unguessable 32-hex id and carries NO token, because a browser
// `<img>` cannot send a header. The wallet never sends anything with it: it is
// a plain GET of a public url, so the request leaks nothing but the fact that
// this install rendered the notice. The url itself is built in
// services/notifications.ts (never here) and is null in a build with no
// gateway, so no <img> can ever point at the extension's own origin. The
// picture is DECORATIVE: `alt=""`, because the title and body carry the whole
// meaning and a screen reader should not read an owner-authored file id. When
// the notice gives the image a link it goes through the same https-only gate as
// the text link, and shows the host it leads to. The extension CSP must allow
// the gateway host in `img-src` (see platforms/*/manifest.json); without that
// allowance the load simply fails, and a failed load hides the image rather
// than leaving a broken frame. Note that the stack renders every picture in the
// set up front (that is what makes the height stable), so all of them are
// fetched when the banner mounts rather than one per rotation step.

import { useEffect, useState } from 'react';
import { Info, AlertTriangle, ArrowUpCircle, ChevronDown, ChevronUp, X } from 'lucide-react';
import { officialLogoUrl } from './BrandLogo';
import {
  dismissalKey,
  type NotificationItem,
  type NotificationSeverity,
} from '../services/notifications';

/** How long each notice stays on screen before the banner rotates to the next
 *  one (ms). Exported so a test and the Playwright smoke can wait on the real
 *  number instead of hard-coding it in three places. Only used when there is
 *  more than one notice to rotate between. */
export const NOTIF_ROTATE_MS = 3_000;

/** WHO IS TALKING. Fixed here, never read from the feed: it is the whole point
 *  of the line that the sender cannot rename itself. */
export const NOTIF_ATTRIBUTION = 'Message from Satori Network';

/** The one thing no message from anyone will ever legitimately ask for. Fixed
 *  here too, and shown under every notice: the owner cannot edit it away, so a
 *  notice asking for a recovery phrase argues with the line below it. */
export const NOTIF_SAFETY_LINE = 'Satori GO will never ask for your recovery phrase.';

/** Per-severity colour, read from the global.css tokens (never invented):
 *  info = the app accent, warning = the amber warning token, update = the green
 *  success token. `accent` colours the stripe/icon/link; `bg` is the soft tint;
 *  `border` is the same hue at low alpha. */
const SEVERITY_STYLE: Record<
  NotificationSeverity,
  { accent: string; bg: string; border: string }
> = {
  info: {
    accent: 'var(--accent)',
    bg: 'var(--accent-soft)',
    border: 'color-mix(in srgb, var(--accent) 30%, transparent)',
  },
  warning: {
    accent: 'var(--warning)',
    bg: 'var(--warning-bg)',
    border: 'color-mix(in srgb, var(--warning) 30%, transparent)',
  },
  update: {
    accent: 'var(--success)',
    bg: 'var(--success-bg)',
    border: 'color-mix(in srgb, var(--success) 30%, transparent)',
  },
};

function SeverityIcon({ severity, color }: { severity: NotificationSeverity; color: string }) {
  const common = { size: 15, color, style: { flexShrink: 0, marginTop: 1 } };
  if (severity === 'warning') return <AlertTriangle {...common} />;
  if (severity === 'update') return <ArrowUpCircle {...common} />;
  return <Info {...common} />;
}

/** The official Satori mark, taken from the bundle rather than through
 *  BrandLogo: this one identifies the SENDER, so a custom logo the user (or
 *  anything writing branding storage) set must not be able to stand in for it.
 *  Decorative — the attribution text beside it carries the meaning. */
function SatoriMark({ size = 12 }: { size?: number }) {
  return (
    <img
      src={officialLogoUrl('satori')}
      alt=""
      width={size}
      height={size}
      draggable={false}
      style={{ display: 'block', width: size, height: size, flexShrink: 0, borderRadius: 3 }}
    />
  );
}

/** True when a url is safe to render as a real link: https only. */
function isHttpsUrl(url: string): boolean {
  return /^https:\/\//i.test(url.trim());
}

/** The host a url actually leads to, or null when it cannot be parsed. What the
 *  banner shows next to an authorable label, and the reason an unparseable url
 *  is never made clickable: a destination we cannot name is one the user cannot
 *  check. */
function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).host || null;
  } catch {
    return null;
  }
}

/**
 * Whether this session wants no animation, in which case the banner does NOT
 * auto-advance: a carousel that moves on its own is exactly what "reduce
 * motion" is asking to be spared, and the notices are still all reachable by
 * dismissing them one by one.
 *
 * TWO sources, the same pair ConstellationField reads: App.tsx folds the
 * wallet's own switch and the OS media query into `data-reduced-motion` on
 * <html>, and the media query is read directly as well so this is still correct
 * on a surface that renders before that attribute is stamped. Both are wrapped
 * because jsdom (and a non-DOM context) may have no matchMedia at all.
 */
function prefersReducedMotion(): boolean {
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

/** The muted "where does this actually go" host, rendered beside a label or
 *  under a clickable picture. Never authorable: it is computed from the url. */
function DestinationHost({ host, testId }: { host: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-faint)', wordBreak: 'break-all' }}
    >
      {host}
    </span>
  );
}

/** The rotation indicator: one dot per notice, the current one solid. It rides
 *  at the end of the FOOTER row (never inside a notice), which is what keeps it
 *  in one place while the set rotates. Deliberately inert (no click targets)
 *  and aria-hidden, because the banner is a live region and a screen reader
 *  reading "1 of 3" over the notice's own text adds nothing. A Playwright smoke
 *  reads data-index / data-total off it. */
function RotationDots({ index, total }: { index: number; total: number }) {
  return (
    <div
      data-testid="live-notification-count"
      data-index={index}
      data-total={total}
      aria-hidden="true"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3, height: 4, flexShrink: 0 }}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: 'var(--r-pill)',
            background: i === index ? 'var(--text-dim)' : 'var(--text-faint)',
            opacity: i === index ? 1 : 0.4,
          }}
        />
      ))}
    </div>
  );
}

/**
 * One notice, as it appears inside the stack. `current` decides both whether it
 * is the visible copy and whether it carries the test ids: the hidden copies
 * exist only to hold the box open at the height of the tallest notice, so
 * nothing in them should be findable, focusable or clickable.
 *
 * The close/collapse control is NOT here: it belongs to the banner's chrome,
 * not to a message, and keeping it in the attribution row means it does not
 * move as notices of different shapes rotate through.
 */
function NoticeCell({
  item,
  current,
  imageHidden,
  onImageError,
}: {
  item: NotificationItem;
  current: boolean;
  imageHidden: boolean;
  onImageError: () => void;
}) {
  const { title, body, severity, link, image } = item;
  const palette = SEVERITY_STYLE[severity];
  // A link is rendered only when it is https AND its host can be named: the
  // host is what the user checks the label against, so no host means no link.
  const linkHost = link != null && isHttpsUrl(link.url) ? hostOf(link.url) : null;
  const showImage = image != null && !imageHidden;
  const imageHref = image?.link && isHttpsUrl(image.link) ? image.link : null;
  const imageHost = imageHref ? hostOf(imageHref) : null;
  /** Test ids belong to the copy that is actually on screen, and to no other. */
  const tid = (name: string) => (current ? name : undefined);

  const picture = showImage ? (
    <img
      data-testid={tid('live-notification-image')}
      // The size lives in global.css (.live-notification-image), not here: the
      // toolbar popup is a fixed 600px box and has to cap the picture shorter
      // than the side panel does, and only a stylesheet can carry that media
      // query. An inline style would win over it.
      className="live-notification-image"
      src={image.url}
      alt=""
      loading="lazy"
      onError={onImageError}
    />
  ) : null;

  return (
    <div
      style={{
        // Every copy occupies the SAME grid cell, so the row is as tall as the
        // tallest of them and the banner stops resizing as they swap.
        gridArea: '1 / 1',
        visibility: current ? 'visible' : 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 0,
      }}
      aria-hidden={current ? undefined : true}
    >
      {picture != null &&
        (imageHost != null ? (
          <a
            data-testid={tid('live-notification-image-link')}
            href={imageHref ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'block', lineHeight: 0, textDecoration: 'none' }}
          >
            {picture}
            {/* A picture that leads somewhere says where, exactly as a text
                link does: it is a click target, not just decoration. */}
            <span style={{ display: 'block', lineHeight: 1.3, marginTop: 3 }}>
              <DestinationHost host={imageHost} testId={tid('live-notification-image-host')} />
            </span>
          </a>
        ) : (
          picture
        ))}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <SeverityIcon severity={severity} color={palette.accent} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            data-testid={tid('live-notification-title')}
            style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', lineHeight: 1.3 }}
          >
            {title}
          </div>
          {body && (
            <div
              data-testid={tid('live-notification-body')}
              style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.4 }}
            >
              {body}
            </div>
          )}
          {link != null && linkHost != null && (
            <a
              data-testid={tid('live-notification-link')}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'baseline',
                flexWrap: 'wrap',
                gap: 5,
                marginTop: 5,
                fontSize: 11.5,
                fontWeight: 600,
                color: palette.accent,
                textDecoration: 'none',
              }}
            >
              <span>{link.label}</span>
              <span aria-hidden="true" style={{ color: 'var(--text-faint)', fontWeight: 400 }}>
                ·
              </span>
              <DestinationHost host={linkHost} testId={tid('live-notification-link-host')} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function NotificationBanner({
  notifications,
  onDismiss,
}: {
  /** Every notice that applies right now, in the gateway's order. Empty renders
   *  nothing at all (no empty box), so Home shifts by nothing. */
  notifications: NotificationItem[];
  /** Called with the DISMISSAL KEY (`id@rev`) of the notice the X was pressed
   *  on, which is what the store persists. Only reachable when that notice is
   *  `dismissible`. */
  onDismiss: (key: string) => void;
}) {
  // The visible notice is tracked by ID, not by index, so the component survives
  // the list changing under it: the parent re-renders with a SHORTER array right
  // after a dismissal, and a refetch or a chain switch can replace the array
  // wholesale. An id that is no longer in the list falls back to the first item.
  const [currentId, setCurrentId] = useState<string | null>(null);
  // Rotation pauses while the pointer is over the banner or focus is inside it:
  // a notice that slides away mid-read (or mid-click on its link) is worse than
  // no rotation at all.
  const [paused, setPaused] = useState(false);
  // Images that failed to load, by id. Held as a list rather than one flag so a
  // broken picture stays hidden as the rotation comes back around to it.
  const [brokenImageIds, setBrokenImageIds] = useState<string[]>([]);
  // The escape hatch for a notice that cannot be dismissed: collapsed to one
  // line, and expandable again. Banner-level (not per notice) because it is the
  // user saying "not now" to the surface, not to one message.
  const [collapsed, setCollapsed] = useState(false);

  const total = notifications.length;
  const at = currentId == null ? -1 : notifications.findIndex((n) => n.id === currentId);
  const index = at >= 0 ? Math.min(at, Math.max(total - 1, 0)) : 0;
  // The id the timer will move to, or null when there is nothing to rotate to.
  // Deriving it here (rather than inside the effect) keeps the effect's only
  // dependencies a string and a boolean, so an unrelated parent re-render that
  // hands back an equal-but-new array does not restart the countdown.
  const nextId = total > 1 ? notifications[(index + 1) % total].id : null;

  useEffect(() => {
    if (nextId == null || paused) return;
    if (prefersReducedMotion()) return;
    const timer = setTimeout(() => setCurrentId(nextId), NOTIF_ROTATE_MS);
    return () => clearTimeout(timer);
  }, [nextId, paused]);

  const visible = total > 0 ? notifications[index] : undefined;
  if (!visible) return null;

  const palette = SEVERITY_STYLE[visible.severity];

  /** Dismiss the notice that is ON SCREEN, and move to the next one immediately
   *  rather than waiting for the store round-trip to hand back a shorter array.
   *  The key carries the revision, so a later resubmit of the same notice is a
   *  different key and comes back. */
  function handleDismiss() {
    if (!visible) return;
    if (nextId != null) setCurrentId(nextId);
    onDismiss(dismissalKey(visible));
  }

  function markImageBroken(id: string) {
    setBrokenImageIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  /** Shared by both states, so the frame does not change when one collapses. */
  const shell = {
    className: 'live-notification-enter',
    'data-testid': 'live-notification',
    'data-severity': visible.severity,
    role: 'status',
    onMouseEnter: () => setPaused(true),
    onMouseLeave: () => setPaused(false),
    onFocus: () => setPaused(true),
    onBlur: () => setPaused(false),
  } as const;

  const shellStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    textAlign: 'left',
    padding: '8px 11px',
    marginBottom: 12,
    background: palette.bg,
    border: `1px solid ${palette.border}`,
    borderLeft: `3px solid ${palette.accent}`,
    borderRadius: 'var(--r-md)',
  } as const;

  // COLLAPSED: one attributed line, and nothing else. This is the state a
  // `dismissible: false` notice can always be put into, so no feed can hold the
  // screen. The whole strip is the button, so a tap anywhere brings it back.
  if (collapsed) {
    return (
      <div {...shell} data-collapsed="true" style={shellStyle}>
        <button
          type="button"
          data-testid="live-notification-expand"
          onClick={() => setCollapsed(false)}
          aria-label="Expand notification"
          aria-expanded={false}
          title="Expand"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            width: '100%',
            minWidth: 0,
            padding: 0,
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
          }}
        >
          <SatoriMark />
          <span style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {NOTIF_ATTRIBUTION}
          </span>
          <span aria-hidden="true" style={{ fontSize: 10, color: 'var(--text-faint)', flexShrink: 0 }}>
            ·
          </span>
          <span
            data-testid="live-notification-title"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {visible.title}
          </span>
          <ChevronDown size={13} color="var(--text-dim)" style={{ flexShrink: 0 }} />
        </button>
      </div>
    );
  }

  return (
    <div {...shell} data-collapsed="false" style={shellStyle}>
      {/* WHO IS TALKING, plus the one control that gets the user out of here.
          Fixed content, outside the stack: it is the same for every notice, so
          it neither moves nor can be rewritten by the feed. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <SatoriMark />
        <span
          data-testid="live-notification-from"
          style={{ flex: 1, minWidth: 0, fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.2 }}
        >
          {NOTIF_ATTRIBUTION}
        </span>
        {visible.dismissible ? (
          <button
            type="button"
            className="icon-btn"
            onClick={handleDismiss}
            aria-label="Dismiss notification"
            title="Dismiss"
            data-testid="live-notification-dismiss"
            style={{ width: 20, height: 20, flexShrink: 0, color: 'var(--text-dim)' }}
          >
            <X size={13} />
          </button>
        ) : (
          // Not dismissible, but never a trap: it collapses to one line.
          <button
            type="button"
            className="icon-btn"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse notification"
            aria-expanded={true}
            title="Collapse"
            data-testid="live-notification-collapse"
            style={{ width: 20, height: 20, flexShrink: 0, color: 'var(--text-dim)' }}
          >
            <ChevronUp size={13} />
          </button>
        )}
      </div>

      {/* The stack: every notice in the same cell, so the box is as tall as the
          tallest one and stops resizing as they rotate. */}
      <div data-testid="live-notification-stack" style={{ display: 'grid' }}>
        {notifications.map((item, i) => (
          <NoticeCell
            key={item.id}
            item={item}
            current={i === index}
            imageHidden={item.image != null && brokenImageIds.includes(item.image.id)}
            onImageError={() => item.image && markImageBroken(item.image.id)}
          />
        ))}
      </div>

      {/* The footer: the fixed safety line, with the rotation indicator riding
          at its end. Both are siblings of the stack, never inside a notice, so
          they hang off a box whose height does not change. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          data-testid="live-notification-safety"
          style={{ fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.3, minWidth: 0 }}
        >
          {NOTIF_SAFETY_LINE}
        </span>
        {total > 1 && <RotationDots index={index} total={total} />}
      </div>
    </div>
  );
}
