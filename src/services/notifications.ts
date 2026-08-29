// Owner-authored notifications, shown as a banner over the coin mark on Home.
//
// SHAPE (2026-08-24): the wallet reads them from the Satori GO gateway, the SAME
// single host prices come from (services/gateway.ts). ONE GET to
// `<gateway>/notifications`, in a build that HAS a gateway; a dev build with no
// gateway makes no request and has no notifications at all.
//
// The gateway has already done the server side: it returns only the active
// notices within their schedule window, SORTED by order (lowest first). The
// wallet does the rest with pure functions here: match the notice's `target`
// against THIS wallet (chain identifier + its own version) and skip the ones
// the user has dismissed. selectNotifications returns the whole set that
// remains, in the gateway's order, because the banner shows one at a time and
// rotates through them itself; selectNotification is the same thing narrowed to
// its first element, kept for callers that only want one.
//
// DISMISSAL IS PER REVISION (2026-08-25). A notice carries an integer `rev` the
// owner bumps to show it again to everyone, including the users who already
// closed it, so a dismissal is recorded against `id@rev` (dismissalKey) rather
// than the bare id. Bumping the rev therefore mints a key nobody has dismissed
// and the notice comes back; leaving it alone changes nothing.
//
// Dependency-free and CSP-safe: plain `fetch`, no libraries. Never throws.

import { GATEWAY_URL, gatewayHeaders } from './gateway';

/** How often the store refetches notifications (ms). Not critical: the gateway
 *  caches (its own ttlSec), and a notice changes rarely. The store throttles on
 *  this so an auto-refresh tick (every 20s) does not hammer the host. */
export const NOTIF_REFRESH_MS = 60_000;

/** The three severities the owner can author, each a colour on the banner:
 *  info = the app accent, warning = the amber warning token, update = the green
 *  success token. An unknown value coming off the wire is clamped to 'info'. */
export type NotificationSeverity = 'info' | 'warning' | 'update';

const SEVERITIES: readonly NotificationSeverity[] = ['info', 'warning', 'update'];

/** An optional call to action. Rendered as a real anchor, and ONLY when the url
 *  is https (see NotificationBanner) — an http/javascript/data url is dropped. */
export interface NotificationLink {
  url: string;
  label: string;
}

/** An optional picture the owner attached to a notice, already resolved to the
 *  absolute url the banner puts in `<img src>`.
 *
 *  The gateway sends `{ id, path, link }` and serves the file PUBLICLY at
 *  `<gateway><path>` with NO token: a browser `<img>` cannot carry a header, so
 *  the 32-hex id being unguessable is the access control by design. The url is
 *  built here rather than in the banner so exactly one place knows the gateway,
 *  and so a build with NO gateway can be made to produce no image at all. */
export interface NotificationImage {
  /** The gateway's opaque id, exactly 32 hex characters. */
  id: string;
  /** Absolute url of the picture (`<gateway><path>`). Always non-empty. */
  url: string;
  /** Where the picture links to when clicked, https only, or null. */
  link: string | null;
}

/** Who a notice is for. A null/empty `chains` means every chain; a null
 *  min/maxVersion means no bound on that side. */
export interface NotificationTarget {
  /** Chain identifiers this notice is for (see selectNotification for the exact
   *  identifier form). Null or empty = all chains. Matched case-insensitively. */
  chains: string[] | null;
  /** Lowest wallet version the notice applies to (inclusive), or null. */
  minVersion: string | null;
  /** Highest wallet version the notice applies to (inclusive), or null. */
  maxVersion: string | null;
}

/** One owner-authored notification, as the wallet holds it. */
export interface NotificationItem {
  id: string;
  /** Revision. The owner bumps it to show a notice AGAIN to everyone, including
   *  the users who already closed it: dismissals are recorded against `id@rev`
   *  (see dismissalKey), so a bumped rev is a key nobody has dismissed yet. A
   *  notice that never gets resubmitted stays at 0 and behaves as it always
   *  did. Always a non-negative integer after parsing. */
  rev: number;
  title: string;
  body: string;
  severity: NotificationSeverity;
  /** A call to action, or null. */
  link: NotificationLink | null;
  /** Whether the user may close it (an X). A non-dismissible notice shows none. */
  dismissible: boolean;
  /** An attached picture, or null. Always present after parsing, so the banner
   *  never has to distinguish "absent" from "malformed". */
  image: NotificationImage | null;
  /** Targeting. Always present after parsing (defaults to "everyone"). */
  target: NotificationTarget;
}

/** The result of a fetch: whether the request SUCCEEDED, plus the list it
 *  returned (empty on any failure). The store needs `ok` so it can keep its
 *  previous list when a request fails rather than blanking the banner on a
 *  transient blip; a caller that just wants a list uses fetchNotifications(). */
export interface NotificationsFetch {
  ok: boolean;
  notifications: NotificationItem[];
}

// --- dismissal keys ---------------------------------------------------------

/**
 * The key a dismissal is recorded under: `id@rev`.
 *
 * EVERY producer and consumer of the dismissed set goes through this, so the
 * format lives in exactly one place: the banner hands this key up, the store
 * persists it, and selectNotifications compares against it. Bumping a notice's
 * `rev` mints a key nobody has dismissed, which is what brings a resubmitted
 * notice back for everyone.
 */
export function dismissalKey(item: { id: string; rev: number }): string {
  return `${item.id}@${toRev(item.rev)}`;
}

/** A stored entry that is already a key ends in `@<digits>`. Checked with a
 *  regex rather than a bare `includes('@')` so an id that happens to contain an
 *  '@' is still migrated correctly. */
const DISMISSAL_KEY_RE = /@\d+$/;

/**
 * One persisted entry -> a dismissal key.
 *
 * MIGRATION: builds before revisions existed stored the BARE id. Such an entry
 * is read as `${id}@0`, so nothing the user had already closed comes back on
 * upgrade (rev 0 is what those notices parse to), while a resubmit to rev 1
 * still gets through. An entry that is already a key is passed through
 * untouched.
 */
export function normalizeDismissalKey(entry: string): string {
  return DISMISSAL_KEY_RE.test(entry) ? entry : `${entry}@0`;
}

/**
 * How many dismissal keys are kept on disk (`notif.dismissed.v1`).
 *
 * The set only ever grew, and every entry in it is a string that came off the
 * wire, so a feed that minted a new id on every fetch could push an unbounded
 * amount of attacker-chosen text into the user's profile storage. 200 keys is
 * far more notices than the owner will ever publish, and the OLDEST are the
 * ones dropped: a notice old enough to fall out of the window is one that
 * stopped being served long ago, and if it ever comes back the user simply
 * closes it once more.
 */
export const MAX_DISMISSED_KEYS = 200;

/** Keep at most MAX_DISMISSED_KEYS entries, dropping the OLDEST first. The list
 *  is append-ordered, so the newest dismissals are at the end. */
export function capDismissedKeys(keys: readonly string[]): string[] {
  return keys.length <= MAX_DISMISSED_KEYS ? [...keys] : keys.slice(-MAX_DISMISSED_KEYS);
}

/** A whole persisted list -> migrated keys, in order, without duplicates, and
 *  capped at MAX_DISMISSED_KEYS (oldest dropped). What the store puts in state
 *  after reading storage. Non-strings are dropped. */
export function migrateDismissedKeys(list: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string' || entry === '') continue;
    const key = normalizeDismissalKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return capDismissedKeys(out);
}

// --- caps -------------------------------------------------------------------
//
// Every field of a notice is authored on the other side of the wire, so its
// LENGTH is attacker-chosen too. Nothing here rejects a notice for being long:
// an over-long field is truncated and the notice is still shown, because a
// silently dropped notice is worse than a clipped one. The caps are generous
// against real copy (the longest notice the owner has published is well inside
// them) and hostile only to the case they exist for: a body the size of a book
// that pushes the balance off the screen, or a title that scrolls forever.

/** Longest id kept. Ids are opaque handles the owner mints; they end up in
 *  storage as part of a dismissal key, so they are bounded there too. */
export const MAX_ID_LEN = 64;
/** Longest title kept (one to two lines in the popup). */
export const MAX_TITLE_LEN = 120;
/** Longest body kept (a short paragraph). */
export const MAX_BODY_LEN = 500;
/** Longest call-to-action label kept (a button's worth of words). */
export const MAX_LINK_LABEL_LEN = 40;
/** Most notices kept from one document. The banner rotates through them at
 *  NOTIF_ROTATE_MS each, and it renders every one of them (stacked) to hold its
 *  height stable, so an unbounded list is unbounded work and an unreadable
 *  carousel. Anything past the fifth is dropped; the gateway sorted by the
 *  owner's own order, so the five kept are the five the owner ranked highest. */
export const MAX_NOTIFICATIONS = 5;

/**
 * Truncate a string to `max` characters.
 *
 * `ellipsis` marks the cut with a single "…" INSIDE the cap, so a clipped
 * title reads as clipped rather than as a typo. It is off for the id, where the
 * value is an identity rather than copy and a decorated one would be wrong.
 */
export function capText(value: string, max: number, ellipsis = false): string {
  if (value.length <= max) return value;
  return ellipsis ? `${value.slice(0, max - 1)}…` : value.slice(0, max);
}

// --- parsing ----------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Normalise a raw revision: a non-negative INTEGER, anything else 0. A float,
 *  a negative, NaN, Infinity, a numeric string and an absent field all mean
 *  "never resubmitted", because the only safe reading of a garbled rev is the
 *  one that does not resurrect a notice the user has already closed. */
function toRev(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Normalise a raw severity to one of the three, defaulting unknowns to 'info'. */
function toSeverity(value: unknown): NotificationSeverity {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (SEVERITIES as readonly string[]).includes(s) ? (s as NotificationSeverity) : 'info';
}

/** A link is kept only when it is an object carrying a string url AND label.
 *  The https-only rule is enforced at RENDER time (the banner), not here, so the
 *  store keeps the authored data verbatim; the banner is the one gate. */
function toLink(value: unknown): NotificationLink | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { url?: unknown; label?: unknown };
  const url = asString(row.url);
  const label = asString(row.label);
  if (!url || !label) return null;
  return { url, label: capText(label, MAX_LINK_LABEL_LEN, true) };
}

/** The id the gateway mints for an image: exactly 32 hex characters. */
const IMAGE_ID_RE = /^[0-9a-f]{32}$/i;

/** The one path prefix the gateway serves images under. Anything else is not an
 *  image route, so it is refused rather than turned into a url. */
const IMAGE_PATH_PREFIX = '/notifications/img/';

/** True when a url is safe to follow: https only. The banner enforces the same
 *  rule on the notice's own link; this is the copy that guards the IMAGE link,
 *  because a bad image link is dropped at parse time (the picture is kept). */
function isHttpsUrl(value: string): boolean {
  return /^https:\/\//i.test(value.trim());
}

/**
 * A raw `image` object -> the resolved image, or null.
 *
 * Fails closed on anything it does not recognise and NEVER throws: a bad `id`
 * (not exactly 32 hex) or a `path` outside the gateway's image route means NO
 * image, because both are what makes the url addressable at all. A bad `link`
 * is softer: the picture is kept and only the link is dropped, the same way the
 * banner drops a non-https call to action.
 *
 * `gateway` is a parameter (defaulting to this build's GATEWAY_URL) both so a
 * test can exercise the no-gateway case and because a build with no gateway
 * MUST NOT produce an image url at all: there is no host to load it from, and
 * pointing an <img> at a relative path would resolve against the extension's
 * own origin.
 */
export function parseNotificationImage(
  value: unknown,
  gateway: string = GATEWAY_URL,
): NotificationImage | null {
  if (!gateway) return null;
  if (!value || typeof value !== 'object') return null;
  const row = value as { id?: unknown; path?: unknown; link?: unknown };
  const id = asString(row.id);
  const path = asString(row.path);
  if (!id || !IMAGE_ID_RE.test(id)) return null;
  if (!path || !path.startsWith(IMAGE_PATH_PREFIX)) return null;
  const rawLink = asString(row.link);
  return {
    id,
    url: `${gateway}${path}`,
    link: rawLink && isHttpsUrl(rawLink) ? rawLink : null,
  };
}

function toTarget(value: unknown): NotificationTarget {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const rawChains = row.chains;
  const chains = Array.isArray(rawChains)
    ? rawChains.filter((c): c is string => typeof c === 'string')
    : null;
  return {
    chains: chains && chains.length > 0 ? chains : null,
    minVersion: asString(row.minVersion) ?? null,
    maxVersion: asString(row.maxVersion) ?? null,
  };
}

/** One raw item -> a normalised NotificationItem, or null when it lacks the
 *  irreducible fields (a string id and a string title). Everything else is
 *  coerced or defaulted, so a slightly malformed item never breaks the batch.
 *  `gateway` is only used to resolve an attached image (see
 *  parseNotificationImage) and defaults to this build's gateway. */
export function parseNotificationItem(
  value: unknown,
  gateway: string = GATEWAY_URL,
): NotificationItem | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = asString(row.id);
  const title = asString(row.title);
  if (!id || !title) return null;
  return {
    // Capped, never rejected (see the caps section): a long field is clipped
    // and the notice still shows. The id is cut WITHOUT an ellipsis because it
    // is an identity, not copy; it stays stable across fetches, so a dismissal
    // recorded against the capped id keeps matching.
    id: capText(id, MAX_ID_LEN),
    rev: toRev(row.rev),
    title: capText(title, MAX_TITLE_LEN, true),
    body: capText(asString(row.body) ?? '', MAX_BODY_LEN, true),
    severity: toSeverity(row.severity),
    link: toLink(row.link),
    // Default TRUE: a notice is dismissible unless the owner explicitly pins it
    // with `dismissible: false`.
    dismissible: row.dismissible === false ? false : true,
    image: parseNotificationImage(row.image, gateway),
    target: toTarget(row.target),
  };
}

/** Parse the gateway document into the notification list, keeping the gateway's
 *  order (it already sorted by order, lowest first) and keeping at most
 *  MAX_NOTIFICATIONS of them. Malformed items are dropped; a malformed document
 *  yields an empty list. Never throws. The `gateway` the document came from is
 *  what image urls are resolved against. */
export function parseNotifications(
  json: unknown,
  gateway: string = GATEWAY_URL,
): NotificationItem[] {
  const body = json && typeof json === 'object' ? (json as { notifications?: unknown }) : undefined;
  const raw = body?.notifications;
  if (!Array.isArray(raw)) return [];
  const out: NotificationItem[] = [];
  for (const item of raw) {
    const parsed = parseNotificationItem(item, gateway);
    if (parsed) out.push(parsed);
    // The gateway already sorted by the owner's order, so stopping here keeps
    // the FIRST five, which are the five ranked highest.
    if (out.length >= MAX_NOTIFICATIONS) break;
  }
  return out;
}

// --- fetching ---------------------------------------------------------------

/** One GET to `<gateway>/notifications`, with the client header. Returns whether
 *  the request succeeded and the list it produced. Never throws: `{ ok: false,
 *  notifications: [] }` on a missing gateway, a missing fetch (jsdom / non-DOM),
 *  a non-OK response, or any thrown error. Makes NO request when this build has
 *  no gateway. */
export async function fetchNotificationsResult(
  gateway: string = GATEWAY_URL,
): Promise<NotificationsFetch> {
  // No gateway (a dev build) or no fetch: no request, no notifications.
  if (typeof fetch === 'undefined' || !gateway) return { ok: false, notifications: [] };
  try {
    const res = await fetch(`${gateway}/notifications`, {
      headers: gatewayHeaders(undefined, gateway),
    });
    if (!res.ok) return { ok: false, notifications: [] };
    // Image urls resolve against the gateway this document came from, not
    // against the build-time constant, so the two can never disagree.
    return { ok: true, notifications: parseNotifications(await res.json(), gateway) };
  } catch {
    return { ok: false, notifications: [] };
  }
}

/** One GET to `<gateway>/notifications`. Never throws: an EMPTY list on any
 *  failure (or when this build has no gateway, in which case it makes no
 *  request). Callers that need to tell a failure from a genuinely empty answer
 *  use fetchNotificationsResult. */
export async function fetchNotifications(
  gateway: string = GATEWAY_URL,
): Promise<NotificationItem[]> {
  return (await fetchNotificationsResult(gateway)).notifications;
}

// --- semver (tiny, no dependency) -------------------------------------------

/** Parse a `major.minor.patch` version into its three numbers, tolerating a
 *  missing patch/minor (padded with 0) and dropping any `-prerelease`/`+build`
 *  suffix. Returns null for anything it cannot parse cleanly (a non-numeric
 *  segment, an empty string, more than three segments) so the caller can fail
 *  closed on a malformed version. */
export function parseSemver(value: string): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const core = value.trim().split('+')[0].split('-')[0];
  if (core === '') return null;
  const parts = core.split('.');
  if (parts.length > 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(parseInt(part, 10));
  }
  while (nums.length < 3) nums.push(0);
  return [nums[0], nums[1], nums[2]];
}

/** Compare two versions: -1 / 0 / 1, or null when EITHER is malformed. A null
 *  result is the fail-closed signal (the caller drops the notice). */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// --- selection --------------------------------------------------------------

/** Does `chainId` fall within a notice's chain target? Null/empty `chains` means
 *  every chain. Matched case-insensitively (both sides trimmed + upper-cased). */
export function chainMatchesTarget(chainId: string, chains: string[] | null | undefined): boolean {
  if (!chains || chains.length === 0) return true;
  const want = chainId.trim().toUpperCase();
  return chains.some((c) => typeof c === 'string' && c.trim().toUpperCase() === want);
}

/** Does `version` fall within a notice's [minVersion, maxVersion] (both
 *  inclusive)? A null bound is no bound on that side. A MALFORMED bound (or a
 *  malformed wallet version) fails closed: the notice does NOT match, so a
 *  garbled constraint can never show a notice to the wrong build. */
export function versionMatchesTarget(version: string, target: NotificationTarget): boolean {
  if (target.minVersion != null) {
    const cmp = compareSemver(version, target.minVersion);
    if (cmp === null || cmp < 0) return false;
  }
  if (target.maxVersion != null) {
    const cmp = compareSemver(version, target.maxVersion);
    if (cmp === null || cmp > 0) return false;
  }
  return true;
}

/** Context the wallet supplies to pick the one notice to show. */
export interface NotificationContext {
  /** THIS wallet's active chain identifier. UTXO chains use their ticker
   *  upper-cased (EVR, RVN, BTGS, LTC, WJK, BTC, DOGE); EVM chains use
   *  `EVM:<KEY>` upper-cased (EVM:BASE, EVM:BSC, EVM:ETHEREUM, EVM:EPIX). */
  chainId: string;
  /** THIS wallet's own version (the value the footer's "Satori GO vX.Y.Z" uses). */
  version: string;
  /** Dismissal keys (`id@rev`, see dismissalKey) the user has already closed.
   *  Entries are normalised on read, so a legacy BARE id written by a build from
   *  before revisions existed still hides revision 0 of that notice. */
  dismissedKeys: string[];
}

/**
 * EVERY notice that applies right now, in the gateway's own order (it already
 * sorted by order, lowest first). An item is kept when it:
 *   - is a well-formed item (a string id),
 *   - has not been dismissed AT THIS REVISION (the comparison is on
 *     `id@rev`, so bumping a notice's rev brings it back for everyone),
 *   - matches the active chain (chain identifier, case-insensitive), and
 *   - matches the wallet version (semver min/max, inclusive; fail-closed on a
 *     malformed version).
 *
 * The whole set rather than one of it, because the banner shows one at a time
 * and rotates through the rest on a timer (see NotificationBanner): the
 * selection decides WHAT applies, the banner decides what is on screen now.
 */
export function selectNotifications(
  list: readonly NotificationItem[],
  ctx: NotificationContext,
): NotificationItem[] {
  // Normalised here as well as in the store, so a caller that hands over a raw
  // persisted list (or a legacy bare id) still gets the right answer.
  const dismissed = new Set(ctx.dismissedKeys.map(normalizeDismissalKey));
  const out: NotificationItem[] = [];
  for (const item of list) {
    if (!item || typeof item.id !== 'string') continue;
    if (dismissed.has(dismissalKey(item))) continue;
    if (!chainMatchesTarget(ctx.chainId, item.target.chains)) continue;
    if (!versionMatchesTarget(ctx.version, item.target)) continue;
    out.push(item);
  }
  return out;
}

/**
 * The FIRST notice that applies right now, or null. Kept for callers that want
 * a single notice; it is exactly `selectNotifications(...)[0]`, so the two can
 * never disagree about what matches.
 */
export function selectNotification(
  list: readonly NotificationItem[],
  ctx: NotificationContext,
): NotificationItem | null {
  return selectNotifications(list, ctx)[0] ?? null;
}
