import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capDismissedKeys,
  capText,
  chainMatchesTarget,
  compareSemver,
  dismissalKey,
  MAX_BODY_LEN,
  MAX_DISMISSED_KEYS,
  MAX_ID_LEN,
  MAX_LINK_LABEL_LEN,
  MAX_NOTIFICATIONS,
  MAX_TITLE_LEN,
  migrateDismissedKeys,
  normalizeDismissalKey,
  fetchNotifications,
  fetchNotificationsResult,
  parseNotifications,
  parseNotificationImage,
  parseNotificationItem,
  parseSemver,
  selectNotification,
  selectNotifications,
  versionMatchesTarget,
  type NotificationItem,
} from './notifications';
import { gatewayHeaders } from './gateway';

// Minimal Response-like stub: only .ok and .json() are read.
function ok(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fully-formed item with overridable fields. */
function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    rev: 0,
    title: 'Title',
    body: 'Body',
    severity: 'info',
    link: null,
    dismissible: true,
    image: null,
    target: { chains: null, minVersion: null, maxVersion: null },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// semver
// ---------------------------------------------------------------------------

describe('parseSemver / compareSemver', () => {
  it('parses major.minor.patch and pads a missing segment', () => {
    expect(parseSemver('1.4.0')).toEqual([1, 4, 0]);
    expect(parseSemver('1.4')).toEqual([1, 4, 0]);
    expect(parseSemver('2')).toEqual([2, 0, 0]);
    expect(parseSemver(' 1.4.0 ')).toEqual([1, 4, 0]);
    // A prerelease / build suffix is dropped down to the numeric core.
    expect(parseSemver('1.4.0-rc.1')).toEqual([1, 4, 0]);
    expect(parseSemver('1.4.0+build9')).toEqual([1, 4, 0]);
  });

  it('returns null for anything it cannot parse cleanly', () => {
    expect(parseSemver('abc')).toBeNull();
    expect(parseSemver('1.x.0')).toBeNull();
    expect(parseSemver('')).toBeNull();
    expect(parseSemver('1.2.3.4')).toBeNull();
    expect(parseSemver(undefined as unknown as string)).toBeNull();
  });

  it('orders versions and reports null when either side is malformed', () => {
    expect(compareSemver('1.4.0', '1.4.0')).toBe(0);
    expect(compareSemver('1.3.9', '1.4.0')).toBe(-1);
    expect(compareSemver('1.4.1', '1.4.0')).toBe(1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.4', '1.4.0')).toBe(0);
    expect(compareSemver('1.4.0', 'garbage')).toBeNull();
    expect(compareSemver('garbage', '1.4.0')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// target matching
// ---------------------------------------------------------------------------

describe('chainMatchesTarget', () => {
  it('null or empty chains match every chain', () => {
    expect(chainMatchesTarget('EVR', null)).toBe(true);
    expect(chainMatchesTarget('EVM:BASE', [])).toBe(true);
  });

  it('matches case-insensitively and trims', () => {
    expect(chainMatchesTarget('EVR', ['evr'])).toBe(true);
    expect(chainMatchesTarget('evm:base', ['EVM:BASE'])).toBe(true);
    expect(chainMatchesTarget('EVM:EPIX', ['  evm:epix  '])).toBe(true);
    expect(chainMatchesTarget('RVN', ['EVR', 'RVN', 'BTGS'])).toBe(true);
  });

  it('rejects a chain not named', () => {
    expect(chainMatchesTarget('EVR', ['RVN'])).toBe(false);
    expect(chainMatchesTarget('EVM:BASE', ['EVM:BSC'])).toBe(false);
  });
});

describe('versionMatchesTarget', () => {
  const t = (minVersion: string | null, maxVersion: string | null) => ({
    chains: null,
    minVersion,
    maxVersion,
  });

  it('null bounds match every version', () => {
    expect(versionMatchesTarget('1.4.0', t(null, null))).toBe(true);
  });

  it('honours min and max INCLUSIVELY (equal boundary passes)', () => {
    expect(versionMatchesTarget('1.4.0', t('1.4.0', null))).toBe(true); // == min
    expect(versionMatchesTarget('1.4.1', t('1.4.0', null))).toBe(true);
    expect(versionMatchesTarget('1.3.9', t('1.4.0', null))).toBe(false); // < min
    expect(versionMatchesTarget('1.4.0', t(null, '1.4.0'))).toBe(true); // == max
    expect(versionMatchesTarget('1.3.0', t(null, '1.4.0'))).toBe(true);
    expect(versionMatchesTarget('1.4.1', t(null, '1.4.0'))).toBe(false); // > max
    expect(versionMatchesTarget('1.4.0', t('1.3.0', '1.5.0'))).toBe(true); // inside
  });

  it('fails CLOSED on a malformed bound or a malformed wallet version', () => {
    expect(versionMatchesTarget('1.4.0', t('not-a-version', null))).toBe(false);
    expect(versionMatchesTarget('1.4.0', t(null, 'x.y.z'))).toBe(false);
    expect(versionMatchesTarget('garbage', t('1.4.0', null))).toBe(false);
    // A malformed wallet version with NO constraints still matches (no bound to
    // fail against).
    expect(versionMatchesTarget('garbage', t(null, null))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectNotification
// ---------------------------------------------------------------------------

describe('selectNotification', () => {
  const ctx = (over: Partial<{ chainId: string; version: string; dismissedKeys: string[] }> = {}) => ({
    chainId: 'EVR',
    version: '1.4.0',
    dismissedKeys: [] as string[],
    ...over,
  });

  it('returns the FIRST matching item (the list is already order-sorted)', () => {
    const list = [item({ id: 'a' }), item({ id: 'b' })];
    expect(selectNotification(list, ctx())?.id).toBe('a');
  });

  it('skips a dismissed key and shows the next match', () => {
    const list = [item({ id: 'a' }), item({ id: 'b' })];
    expect(selectNotification(list, ctx({ dismissedKeys: ['a@0'] }))?.id).toBe('b');
  });

  it('returns none when every match is dismissed', () => {
    const list = [item({ id: 'a' }), item({ id: 'b' })];
    expect(selectNotification(list, ctx({ dismissedKeys: ['a@0', 'b@0'] }))).toBeNull();
  });

  it('skips items whose chain target does not match, keeps ones that do', () => {
    const list = [
      item({ id: 'rvn-only', target: { chains: ['RVN'], minVersion: null, maxVersion: null } }),
      item({ id: 'evr-ok', target: { chains: ['EVR'], minVersion: null, maxVersion: null } }),
    ];
    expect(selectNotification(list, ctx({ chainId: 'EVR' }))?.id).toBe('evr-ok');
  });

  it('matches an EVM chain identifier case-insensitively', () => {
    const list = [item({ id: 'base', target: { chains: ['EVM:BASE'], minVersion: null, maxVersion: null } })];
    expect(selectNotification(list, ctx({ chainId: 'evm:base' }))?.id).toBe('base');
    expect(selectNotification(list, ctx({ chainId: 'EVM:BSC' }))).toBeNull();
  });

  it('skips items whose version target excludes this wallet, boundaries inclusive', () => {
    const list = [
      item({ id: 'too-new', target: { chains: null, minVersion: '1.5.0', maxVersion: null } }),
      item({ id: 'just-right', target: { chains: null, minVersion: '1.4.0', maxVersion: '1.4.0' } }),
    ];
    expect(selectNotification(list, ctx({ version: '1.4.0' }))?.id).toBe('just-right');
  });

  it('fails closed on a malformed version constraint (never shows it)', () => {
    const list = [item({ id: 'bad', target: { chains: null, minVersion: 'oops', maxVersion: null } })];
    expect(selectNotification(list, ctx())).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(selectNotification([], ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectNotifications (the whole matching set the banner rotates through)
// ---------------------------------------------------------------------------

describe('selectNotifications', () => {
  const ctx = (over: Partial<{ chainId: string; version: string; dismissedKeys: string[] }> = {}) => ({
    chainId: 'EVR',
    version: '1.4.0',
    dismissedKeys: [] as string[],
    ...over,
  });

  it('returns EVERY match, in the gateway order', () => {
    const list = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    expect(selectNotifications(list, ctx()).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops the dismissed ones and keeps the order of the rest', () => {
    const list = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    expect(selectNotifications(list, ctx({ dismissedKeys: ['b@0'] })).map((n) => n.id)).toEqual(['a', 'c']);
  });

  it('applies the chain and version filters to every item, not just the first', () => {
    const list = [
      item({ id: 'rvn-only', target: { chains: ['RVN'], minVersion: null, maxVersion: null } }),
      item({ id: 'evr-ok', target: { chains: ['EVR'], minVersion: null, maxVersion: null } }),
      item({ id: 'too-new', target: { chains: null, minVersion: '1.5.0', maxVersion: null } }),
      item({ id: 'everyone' }),
    ];
    expect(selectNotifications(list, ctx()).map((n) => n.id)).toEqual(['evr-ok', 'everyone']);
  });

  it('returns an empty array when nothing matches, and for an empty list', () => {
    expect(selectNotifications([], ctx())).toEqual([]);
    expect(selectNotifications([item({ id: 'a' })], ctx({ dismissedKeys: ['a@0'] }))).toEqual([]);
  });

  it('selectNotification is exactly its first element', () => {
    const list = [item({ id: 'a' }), item({ id: 'b' })];
    expect(selectNotification(list, ctx())).toBe(selectNotifications(list, ctx())[0]);
    expect(selectNotification([], ctx())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revisions: dismissal is per id@rev, so the owner can resubmit a notice
// ---------------------------------------------------------------------------

describe('dismissalKey / normalizeDismissalKey / migrateDismissedKeys', () => {
  it('is `id@rev`', () => {
    expect(dismissalKey({ id: 'welcome', rev: 0 })).toBe('welcome@0');
    expect(dismissalKey({ id: 'welcome', rev: 2 })).toBe('welcome@2');
  });

  it('clamps a malformed rev the same way parsing does, so it can never throw', () => {
    expect(dismissalKey({ id: 'a', rev: undefined as unknown as number })).toBe('a@0');
    expect(dismissalKey({ id: 'a', rev: -3 })).toBe('a@0');
    expect(dismissalKey({ id: 'a', rev: 1.5 })).toBe('a@0');
    expect(dismissalKey({ id: 'a', rev: NaN })).toBe('a@0');
  });

  it('reads a LEGACY bare id as revision 0 and passes a real key through', () => {
    expect(normalizeDismissalKey('welcome')).toBe('welcome@0');
    expect(normalizeDismissalKey('welcome@0')).toBe('welcome@0');
    expect(normalizeDismissalKey('welcome@7')).toBe('welcome@7');
    // An id that happens to contain an '@' is still migrated: a KEY ends in
    // `@<digits>`, which `hello@world` does not.
    expect(normalizeDismissalKey('hello@world')).toBe('hello@world@0');
  });

  it('migrates a whole stored list, dropping junk and duplicates, keeping order', () => {
    expect(migrateDismissedKeys(['a', 'b@1', 'a@0', '', null, 7, 'c'])).toEqual([
      'a@0',
      'b@1',
      'c@0',
    ]);
    expect(migrateDismissedKeys([])).toEqual([]);
  });
});

describe('selectNotifications with revisions', () => {
  const ctx = (dismissedKeys: string[] = []) => ({
    chainId: 'EVR',
    version: '1.4.0',
    dismissedKeys,
  });

  it('a notice with no rev behaves exactly as it always did', () => {
    const list = [item({ id: 'a' })]; // rev 0
    expect(selectNotifications(list, ctx()).map((n) => n.id)).toEqual(['a']);
    expect(selectNotifications(list, ctx(['a@0']))).toEqual([]);
  });

  it('bumping the rev shows a dismissed notice AGAIN', () => {
    const dismissed = ctx(['a@0']);
    expect(selectNotifications([item({ id: 'a', rev: 0 })], dismissed)).toEqual([]);
    // The owner resubmits: same id, new revision, so the key is one nobody has
    // dismissed and it comes back.
    expect(selectNotifications([item({ id: 'a', rev: 1 })], dismissed).map((n) => n.id)).toEqual(['a']);
    // ...and closing it again hides that revision only.
    expect(selectNotifications([item({ id: 'a', rev: 1 })], ctx(['a@0', 'a@1']))).toEqual([]);
  });

  it('a LEGACY bare id still hides revision 0, and does NOT hide revision 1', () => {
    const legacy = ctx(['a']); // written by a build from before revisions
    expect(selectNotifications([item({ id: 'a', rev: 0 })], legacy)).toEqual([]);
    expect(selectNotifications([item({ id: 'a', rev: 1 })], legacy).map((n) => n.id)).toEqual(['a']);
  });

  it('dismissing one revision never hides a DIFFERENT notice with the same rev', () => {
    const list = [item({ id: 'a', rev: 2 }), item({ id: 'b', rev: 2 })];
    expect(selectNotifications(list, ctx(['a@2'])).map((n) => n.id)).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

describe('parseNotificationItem / parseNotifications', () => {
  it('parses a full item and defaults the soft fields', () => {
    const parsed = parseNotificationItem({
      id: 'welcome-140',
      title: 'Welcome',
      body: 'Hello',
      severity: 'update',
      link: { url: 'https://satorigo.app', label: 'Learn more' },
      dismissible: true,
      target: { chains: ['EVM:EPIX'], minVersion: '1.4.0', maxVersion: null },
    });
    expect(parsed).toEqual({
      id: 'welcome-140',
      rev: 0,
      title: 'Welcome',
      body: 'Hello',
      severity: 'update',
      link: { url: 'https://satorigo.app', label: 'Learn more' },
      dismissible: true,
      image: null,
      target: { chains: ['EVM:EPIX'], minVersion: '1.4.0', maxVersion: null },
    });
  });

  it('drops an item with no string id or title', () => {
    expect(parseNotificationItem({ title: 'x' })).toBeNull();
    expect(parseNotificationItem({ id: 'x' })).toBeNull();
    expect(parseNotificationItem(null)).toBeNull();
  });

  it('clamps an unknown severity to info and defaults dismissible to true', () => {
    const parsed = parseNotificationItem({ id: 'a', title: 't', severity: 'critical' });
    expect(parsed?.severity).toBe('info');
    expect(parsed?.dismissible).toBe(true);
    expect(parsed?.body).toBe('');
    expect(parsed?.link).toBeNull();
    expect(parsed?.target).toEqual({ chains: null, minVersion: null, maxVersion: null });
  });

  it('keeps a valid rev and clamps everything else to 0, never throwing', () => {
    const rev = (value: unknown) => parseNotificationItem({ id: 'a', title: 't', rev: value })?.rev;
    expect(rev(2)).toBe(2);
    expect(rev(0)).toBe(0);
    expect(rev(1_000_000)).toBe(1_000_000);
    // Absent, null, a string, a float, a negative, NaN, Infinity: all "never
    // resubmitted", because the only safe reading of a garbled rev is the one
    // that does not resurrect a notice the user already closed.
    expect(parseNotificationItem({ id: 'a', title: 't' })?.rev).toBe(0);
    expect(rev(null)).toBe(0);
    expect(rev(undefined)).toBe(0);
    expect(rev('2')).toBe(0);
    expect(rev(1.5)).toBe(0);
    expect(rev(-1)).toBe(0);
    expect(rev(NaN)).toBe(0);
    expect(rev(Infinity)).toBe(0);
    expect(rev({})).toBe(0);
  });

  it('honours an explicit dismissible:false', () => {
    expect(parseNotificationItem({ id: 'a', title: 't', dismissible: false })?.dismissible).toBe(false);
  });

  it('drops a malformed link and empties a chains array to null', () => {
    const parsed = parseNotificationItem({
      id: 'a',
      title: 't',
      link: { url: 'https://x' }, // no label
      target: { chains: [] },
    });
    expect(parsed?.link).toBeNull();
    expect(parsed?.target.chains).toBeNull();
  });

  it('keeps the gateway order and drops malformed items from the batch', () => {
    const list = parseNotifications({
      notifications: [
        { id: 'a', title: 'A' },
        { title: 'no id' },
        { id: 'b', title: 'B' },
      ],
    });
    expect(list.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('returns an empty list for a malformed document', () => {
    expect(parseNotifications(null)).toEqual([]);
    expect(parseNotifications({})).toEqual([]);
    expect(parseNotifications({ notifications: 'nope' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LENGTH CAPS (security review, 2026-08-25). Everything in a notice is written
// on the other side of the wire, so its length is attacker-chosen too. Nothing
// here REJECTS a notice for being long: it is truncated and still shown.
// ---------------------------------------------------------------------------

describe('parse-time caps', () => {
  it('caps the id at 64 characters, with no ellipsis (it is an identity)', () => {
    const parsed = parseNotificationItem({ id: 'x'.repeat(500), title: 'T' });
    expect(parsed?.id).toBe('x'.repeat(MAX_ID_LEN));
    expect(parsed?.id).toHaveLength(64);
    // Stable across fetches, so a dismissal recorded against it keeps matching.
    expect(parseNotificationItem({ id: 'x'.repeat(500), title: 'T' })?.id).toBe(parsed?.id);
  });

  it('caps the title at 120 characters and marks the cut', () => {
    const parsed = parseNotificationItem({ id: 'a', title: 'T'.repeat(1000) });
    expect(parsed?.title).toHaveLength(MAX_TITLE_LEN);
    expect(parsed?.title.endsWith('…')).toBe(true);
  });

  it('caps the body at 500 characters and marks the cut', () => {
    const parsed = parseNotificationItem({ id: 'a', title: 'T', body: 'B'.repeat(20_000) });
    expect(parsed?.body).toHaveLength(MAX_BODY_LEN);
    expect(parsed?.body.endsWith('…')).toBe(true);
  });

  it('caps the link label at 40 characters, keeping the url untouched', () => {
    const url = `https://satorigo.app/${'p'.repeat(300)}`;
    const parsed = parseNotificationItem({ id: 'a', title: 'T', link: { url, label: 'L'.repeat(90) } });
    expect(parsed?.link?.label).toHaveLength(MAX_LINK_LABEL_LEN);
    expect(parsed?.link?.label.endsWith('…')).toBe(true);
    // The url is what the destination host is computed from, so it is not
    // trimmed: the banner shows the HOST, which is short by construction.
    expect(parsed?.link?.url).toBe(url);
  });

  it('leaves ordinary copy exactly as authored', () => {
    const parsed = parseNotificationItem({
      id: 'welcome',
      title: 'Satori GO 1.4.0 is here',
      body: 'A normal, human-length body.',
      link: { url: 'https://satorigo.app/', label: 'Read more' },
    });
    expect(parsed?.id).toBe('welcome');
    expect(parsed?.title).toBe('Satori GO 1.4.0 is here');
    expect(parsed?.body).toBe('A normal, human-length body.');
    expect(parsed?.link?.label).toBe('Read more');
  });

  it('keeps at most 5 notices, the first 5 in the gateway order', () => {
    const list = parseNotifications({
      notifications: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, title: `T${i}` })),
    });
    expect(list).toHaveLength(MAX_NOTIFICATIONS);
    expect(list.map((n) => n.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  });

  it('counts only WELL-FORMED items towards the 5, so junk cannot crowd them out', () => {
    const list = parseNotifications({
      notifications: [
        { title: 'no id' },
        null,
        { id: 'a', title: 'A' },
        'nope',
        { id: 'b', title: 'B' },
      ],
    });
    expect(list.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('capText is a plain truncation, marked only when asked', () => {
    expect(capText('short', 10)).toBe('short');
    expect(capText('short', 10, true)).toBe('short');
    expect(capText('abcdef', 4)).toBe('abcd');
    expect(capText('abcdef', 4, true)).toBe('abc…');
  });
});

describe('the dismissed set is bounded', () => {
  it('keeps at most MAX_DISMISSED_KEYS, dropping the OLDEST first', () => {
    const many = Array.from({ length: MAX_DISMISSED_KEYS + 50 }, (_, i) => `n${i}@0`);
    const kept = capDismissedKeys(many);
    expect(kept).toHaveLength(MAX_DISMISSED_KEYS);
    expect(kept[0]).toBe('n50@0'); // the first 50 fell off the front
    expect(kept[kept.length - 1]).toBe(`n${MAX_DISMISSED_KEYS + 49}@0`);
    expect(MAX_DISMISSED_KEYS).toBe(200);
  });

  it('leaves a normal-sized list alone (and copies it, never aliases it)', () => {
    const few = ['a@0', 'b@1'];
    const kept = capDismissedKeys(few);
    expect(kept).toEqual(few);
    expect(kept).not.toBe(few);
  });

  it('caps what is read back from storage too, so a poisoned list cannot grow', () => {
    const stored = Array.from({ length: 1_000 }, (_, i) => `n${i}`);
    const migrated = migrateDismissedKeys(stored);
    expect(migrated).toHaveLength(MAX_DISMISSED_KEYS);
    // Migration still happened on the entries that survived (bare id -> `id@0`).
    expect(migrated[migrated.length - 1]).toBe('n999@0');
  });
});

// ---------------------------------------------------------------------------
// the attached image
// ---------------------------------------------------------------------------

describe('parseNotificationImage', () => {
  const HOST = 'https://gateway.test';
  const ID = '0123456789abcdef0123456789abcdef'; // 32 hex, the gateway's form
  const PATH = `/notifications/img/${ID}`;
  const img = (over: Record<string, unknown> = {}) => ({ id: ID, path: PATH, link: null, ...over });

  it('resolves a valid image against the gateway it came from', () => {
    expect(parseNotificationImage(img(), HOST)).toEqual({
      id: ID,
      url: `${HOST}${PATH}`,
      link: null,
    });
  });

  it('keeps an https link on the image', () => {
    expect(parseNotificationImage(img({ link: 'https://satorigo.app' }), HOST)?.link).toBe(
      'https://satorigo.app',
    );
  });

  it('KEEPS the picture but drops a link that is not https', () => {
    for (const link of ['http://satorigo.app', 'javascript:alert(1)', 'data:text/html,x', 'nope', 42]) {
      const parsed = parseNotificationImage(img({ link }), HOST);
      expect(parsed?.url).toBe(`${HOST}${PATH}`);
      expect(parsed?.link).toBeNull();
    }
  });

  it('refuses an id that is not exactly 32 hex characters', () => {
    for (const id of ['', 'abc', `${ID}0`, ID.slice(0, 31), ID.replace('a', 'z'), 42, null]) {
      expect(parseNotificationImage({ id, path: PATH }, HOST)).toBeNull();
    }
  });

  it('refuses a path outside the gateway image route', () => {
    for (const path of [
      '/evil/x',
      `/notifications/${ID}`,
      `notifications/img/${ID}`,
      `https://evil.test/notifications/img/${ID}`,
      '',
      42,
    ]) {
      expect(parseNotificationImage({ id: ID, path }, HOST)).toBeNull();
    }
  });

  it('is null for an absent, null or non-object image', () => {
    expect(parseNotificationImage(undefined, HOST)).toBeNull();
    expect(parseNotificationImage(null, HOST)).toBeNull();
    expect(parseNotificationImage('nope', HOST)).toBeNull();
    expect(parseNotificationImage({}, HOST)).toBeNull();
  });

  it('NEVER produces a url in a build with no gateway', () => {
    // Nothing to load it from, and a bare path would resolve against the
    // extension's own origin, so the whole image is dropped.
    expect(parseNotificationImage(img(), '')).toBeNull();
    expect(parseNotificationImage(img({ link: 'https://satorigo.app' }), '')).toBeNull();
  });
});

describe('parseNotificationItem (image)', () => {
  const HOST = 'https://gateway.test';
  const ID = 'ffffffffffffffffffffffffffffffff';
  const PATH = `/notifications/img/${ID}`;

  it('attaches a resolved image to the item', () => {
    const parsed = parseNotificationItem(
      { id: 'a', title: 't', image: { id: ID, path: PATH, link: 'https://satorigo.app' } },
      HOST,
    );
    expect(parsed?.image).toEqual({ id: ID, url: `${HOST}${PATH}`, link: 'https://satorigo.app' });
  });

  it('leaves image null when it is absent or malformed, and keeps the item', () => {
    expect(parseNotificationItem({ id: 'a', title: 't' }, HOST)?.image).toBeNull();
    expect(parseNotificationItem({ id: 'a', title: 't', image: null }, HOST)?.image).toBeNull();
    const broken = parseNotificationItem({ id: 'a', title: 't', image: { id: 'nope', path: PATH } }, HOST);
    expect(broken?.title).toBe('t');
    expect(broken?.image).toBeNull();
  });

  it('a no-gateway build parses the item but never its image', () => {
    const parsed = parseNotificationItem({ id: 'a', title: 't', image: { id: ID, path: PATH } }, '');
    expect(parsed?.id).toBe('a');
    expect(parsed?.image).toBeNull();
  });

  it('parseNotifications passes the gateway down to every item', () => {
    const list = parseNotifications(
      { notifications: [{ id: 'a', title: 'A', image: { id: ID, path: PATH } }] },
      HOST,
    );
    expect(list[0].image?.url).toBe(`${HOST}${PATH}`);
    expect(parseNotifications({ notifications: [{ id: 'a', title: 'A', image: { id: ID, path: PATH } }] }, '')[0].image).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------

const GATEWAY = 'https://gateway.test';

const GATEWAY_BODY = {
  fetchedAt: 1_755_000_000_000,
  ttlSec: 60,
  notifications: [
    {
      id: 'welcome-140',
      title: 'Welcome to 1.4.0',
      body: 'Notifications now show here.',
      severity: 'update',
      link: { url: 'https://satorigo.app', label: 'What is new' },
      dismissible: true,
      target: { chains: null, minVersion: '1.4.0', maxVersion: null },
    },
  ],
};

describe('fetchNotifications (gateway path)', () => {
  it('asks <gateway>/notifications exactly once with the client header', async () => {
    const spy = vi.fn(async () => ok(GATEWAY_BODY));
    vi.stubGlobal('fetch', spy);
    const list = await fetchNotifications(GATEWAY);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe(`${GATEWAY}/notifications`);
    expect(init?.headers).toEqual(gatewayHeaders(undefined, GATEWAY));
    expect(list.map((n) => n.id)).toEqual(['welcome-140']);
    expect(list[0].severity).toBe('update');
  });

  it('resolves an image url against the gateway it fetched from', async () => {
    const id = '00112233445566778899aabbccddeeff';
    const body = {
      notifications: [{ id: 'with-image', title: 'Look', image: { id, path: `/notifications/img/${id}` } }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ok(body)));
    const list = await fetchNotifications(GATEWAY);
    expect(list[0].image?.url).toBe(`${GATEWAY}/notifications/img/${id}`);
  });

  it('reports ok:true with the list on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(GATEWAY_BODY)));
    const res = await fetchNotificationsResult(GATEWAY);
    expect(res.ok).toBe(true);
    expect(res.notifications).toHaveLength(1);
  });

  it('never throws: an empty, NOT-ok result on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const res = await fetchNotificationsResult(GATEWAY);
    expect(res.ok).toBe(false);
    expect(res.notifications).toEqual([]);
    expect(await fetchNotifications(GATEWAY)).toEqual([]);
  });

  it('treats a non-OK HTTP response as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response));
    const res = await fetchNotificationsResult(GATEWAY);
    expect(res.ok).toBe(false);
    expect(res.notifications).toEqual([]);
  });

  it('a NON-GATEWAY build makes NO request and returns an empty list', async () => {
    const spy = vi.fn(async () => ok(GATEWAY_BODY));
    vi.stubGlobal('fetch', spy);
    // An empty gateway (a dev build with no gateway configured) must never reach
    // the network.
    expect(await fetchNotifications('')).toEqual([]);
    const res = await fetchNotificationsResult('');
    expect(res).toEqual({ ok: false, notifications: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});
