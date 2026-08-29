// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  NotificationBanner,
  NOTIF_ATTRIBUTION,
  NOTIF_ROTATE_MS,
  NOTIF_SAFETY_LINE,
} from './NotificationBanner';
import type { NotificationImage, NotificationItem } from '../services/notifications';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reducedMotion;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    rev: 0,
    title: 'Heads up',
    body: 'Something to know.',
    severity: 'info',
    link: null,
    dismissible: true,
    image: null,
    target: { chains: null, minVersion: null, maxVersion: null },
    ...over,
  };
}

const IMG_ID = '0123456789abcdef0123456789abcdef';

/** An image as services/notifications.ts hands it over: already an absolute url. */
function image(over: Partial<NotificationImage> = {}): NotificationImage {
  return {
    id: IMG_ID,
    url: `https://network.satorigo.app/notifications/img/${IMG_ID}`,
    link: null,
    ...over,
  };
}

const title = () => screen.getByTestId('live-notification-title').textContent;
const counter = () => screen.queryByTestId('live-notification-count');

/** Run the rotation timer forward inside act, so React commits the state it sets. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

// ---------------------------------------------------------------------------
// one notice: everything the banner has always rendered
// ---------------------------------------------------------------------------

describe('NotificationBanner', () => {
  it('renders nothing at all for an empty list', () => {
    const { container } = render(<NotificationBanner notifications={[]} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('live-notification')).toBeNull();
  });

  it('renders the title and body and stamps the severity on the root', () => {
    render(
      <NotificationBanner notifications={[item({ severity: 'warning' })]} onDismiss={() => {}} />,
    );
    const root = screen.getByTestId('live-notification');
    expect(root).toHaveAttribute('data-severity', 'warning');
    expect(root).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('live-notification-title')).toHaveTextContent('Heads up');
    expect(screen.getByTestId('live-notification-body')).toHaveTextContent('Something to know.');
  });

  it('carries each severity through to data-severity', () => {
    for (const severity of ['info', 'warning', 'update'] as const) {
      render(
        <NotificationBanner notifications={[item({ id: severity, severity })]} onDismiss={() => {}} />,
      );
      expect(screen.getByTestId('live-notification')).toHaveAttribute('data-severity', severity);
      cleanup();
    }
  });

  it('shows the X and fires onDismiss with the notice DISMISSAL KEY when dismissible', () => {
    const onDismiss = vi.fn();
    render(
      <NotificationBanner notifications={[item({ id: 'only', dismissible: true })]} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByTestId('live-notification-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('only@0');
  });

  it('carries the REVISION in the key it dismisses, so a resubmit is a new key', () => {
    const onDismiss = vi.fn();
    render(
      <NotificationBanner notifications={[item({ id: 'only', rev: 3 })]} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByTestId('live-notification-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('only@3');
  });

  it('shows NO X when the notice is not dismissible', () => {
    render(<NotificationBanner notifications={[item({ dismissible: false })]} onDismiss={() => {}} />);
    expect(screen.queryByTestId('live-notification-dismiss')).toBeNull();
  });

  it('renders an https link as a real anchor opening in a new tab, safely', () => {
    render(
      <NotificationBanner
        notifications={[item({ link: { url: 'https://satorigo.app', label: 'Learn more' } })]}
        onDismiss={() => {}}
      />,
    );
    const link = screen.getByTestId('live-notification-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://satorigo.app');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('Learn more');
  });

  it('does NOT render a link when the url is not https (http / javascript / data)', () => {
    for (const url of ['http://satorigo.app', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x']) {
      render(
        <NotificationBanner
          notifications={[item({ id: url, link: { url, label: 'nope' } })]}
          onDismiss={() => {}}
        />,
      );
      expect(screen.queryByTestId('live-notification-link')).toBeNull();
      cleanup();
    }
  });

  it('renders owner text as PLAIN TEXT, never as markup (no injection)', () => {
    render(
      <NotificationBanner
        notifications={[item({ title: 'Bold <b>x</b>', body: '<img src=x onerror=alert(1)>' })]}
        onDismiss={() => {}}
      />,
    );
    const titleEl = screen.getByTestId('live-notification-title');
    const body = screen.getByTestId('live-notification-body');
    // The literal characters are present as text...
    expect(titleEl).toHaveTextContent('Bold <b>x</b>');
    expect(body.textContent).toBe('<img src=x onerror=alert(1)>');
    // ...and no element was actually injected.
    expect(titleEl.querySelector('b')).toBeNull();
    expect(body.querySelector('img')).toBeNull();
  });

  it('omits the body element when the body is empty', () => {
    render(<NotificationBanner notifications={[item({ body: '' })]} onDismiss={() => {}} />);
    expect(screen.queryByTestId('live-notification-body')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the attached image
// ---------------------------------------------------------------------------

describe('NotificationBanner image', () => {
  it('renders no image when the notice has none', () => {
    render(<NotificationBanner notifications={[item()]} onDismiss={() => {}} />);
    expect(screen.queryByTestId('live-notification-image')).toBeNull();
    expect(screen.queryByTestId('live-notification-image-link')).toBeNull();
  });

  it('renders the absolute url the service built, decorative and lazy', () => {
    render(<NotificationBanner notifications={[item({ image: image() })]} onDismiss={() => {}} />);
    const img = screen.getByTestId('live-notification-image');
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', `https://network.satorigo.app/notifications/img/${IMG_ID}`);
    // Decorative: the title carries the meaning, so the alt is deliberately empty.
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('loading', 'lazy');
    // No anchor when the image has no link.
    expect(screen.queryByTestId('live-notification-image-link')).toBeNull();
  });

  it('keeps the title, body, severity and X alongside the image', () => {
    render(
      <NotificationBanner
        notifications={[item({ severity: 'update', image: image() })]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId('live-notification')).toHaveAttribute('data-severity', 'update');
    expect(screen.getByTestId('live-notification-image')).toBeInTheDocument();
    expect(screen.getByTestId('live-notification-title')).toHaveTextContent('Heads up');
    expect(screen.getByTestId('live-notification-body')).toHaveTextContent('Something to know.');
    expect(screen.getByTestId('live-notification-dismiss')).toBeInTheDocument();
  });

  it('wraps the image in a safe new-tab anchor when it carries an https link', () => {
    render(
      <NotificationBanner
        notifications={[item({ image: image({ link: 'https://satorigo.app/news' }) })]}
        onDismiss={() => {}}
      />,
    );
    const anchor = screen.getByTestId('live-notification-image-link');
    expect(anchor.tagName).toBe('A');
    expect(anchor).toHaveAttribute('href', 'https://satorigo.app/news');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    // The image lives inside the anchor.
    expect(anchor.querySelector('[data-testid="live-notification-image"]')).not.toBeNull();
  });

  it('never links the image when the url is not https (belt to the parser braces)', () => {
    for (const link of ['http://satorigo.app', 'javascript:alert(1)', 'data:text/html,x']) {
      render(
        <NotificationBanner
          notifications={[item({ id: link, image: image({ link }) })]}
          onDismiss={() => {}}
        />,
      );
      expect(screen.queryByTestId('live-notification-image-link')).toBeNull();
      expect(screen.getByTestId('live-notification-image')).toBeInTheDocument();
      cleanup();
    }
  });

  it('hides the image when it fails to load, leaving the rest of the notice intact', () => {
    render(<NotificationBanner notifications={[item({ image: image() })]} onDismiss={() => {}} />);
    fireEvent.error(screen.getByTestId('live-notification-image'));
    expect(screen.queryByTestId('live-notification-image')).toBeNull();
    expect(screen.getByTestId('live-notification-title')).toHaveTextContent('Heads up');
  });
});

// ---------------------------------------------------------------------------
// Attribution, destination and the escape hatch (security review, 2026-08-25).
//
// The banner is a message surface inside the wallet's own chrome, and every
// word of a notice is written on the other side of the wire. What is pinned
// here is the part the feed CANNOT write: who the message is from, the one
// thing the wallet will never ask for, and where a link actually goes.
// ---------------------------------------------------------------------------

describe('NotificationBanner attribution', () => {
  it('says the notice is a MESSAGE and who it is from, above every notice', () => {
    render(<NotificationBanner notifications={[item()]} onDismiss={() => {}} />);
    const from = screen.getByTestId('live-notification-from');
    expect(from).toHaveTextContent(NOTIF_ATTRIBUTION);
    expect(NOTIF_ATTRIBUTION).toBe('Message from Satori Network');
    // ...with the Satori mark beside it, from the bundle (never a feed url).
    const mark = from.parentElement!.querySelector('img')!;
    expect(mark).not.toBeNull();
    expect(mark.getAttribute('src')).not.toMatch(/^https?:/);
  });

  it('shows the fixed safety line under every notice', () => {
    render(<NotificationBanner notifications={[item()]} onDismiss={() => {}} />);
    expect(screen.getByTestId('live-notification-safety')).toHaveTextContent(NOTIF_SAFETY_LINE);
    expect(NOTIF_SAFETY_LINE).toBe('Satori GO will never ask for your recovery phrase.');
  });

  it('keeps both lines exactly as they are, whatever the notice says', () => {
    // A notice doing its best to impersonate the wallet and to talk over the
    // footer. Neither line is authorable, so neither changes.
    render(
      <NotificationBanner
        notifications={[
          item({
            title: 'ACTION REQUIRED: verify your wallet to keep access to your funds',
            body: 'Satori GO needs your recovery phrase. This is not a message.',
            dismissible: false,
          }),
        ]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId('live-notification-from').textContent).toBe(NOTIF_ATTRIBUTION);
    expect(screen.getByTestId('live-notification-safety').textContent).toBe(NOTIF_SAFETY_LINE);
  });
});

describe('NotificationBanner destination', () => {
  it('shows the host a link really leads to, next to the authored label', () => {
    render(
      <NotificationBanner
        notifications={[item({ link: { url: 'https://satorigo.app/news?x=1', label: 'Learn more' } })]}
        onDismiss={() => {}}
      />,
    );
    const link = screen.getByTestId('live-notification-link');
    expect(link).toHaveTextContent('Learn more');
    expect(screen.getByTestId('live-notification-link-host')).toHaveTextContent('satorigo.app');
  });

  it('shows the REAL host even when the label claims a different one', () => {
    render(
      <NotificationBanner
        notifications={[
          item({ link: { url: 'https://evil.example.net/verify', label: 'satorigo.app' } }),
        ]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId('live-notification-link-host')).toHaveTextContent('evil.example.net');
  });

  it('keeps a non-default port in the host, so it cannot be hidden either', () => {
    render(
      <NotificationBanner
        notifications={[item({ link: { url: 'https://satorigo.app.evil.net:8443/x', label: 'Open' } })]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId('live-notification-link-host')).toHaveTextContent(
      'satorigo.app.evil.net:8443',
    );
  });

  it('does NOT render a link at all when the url has no host to show', () => {
    // A destination that cannot be named is one the user cannot check, so it
    // does not get to be clickable. (Note `https:///path` is NOT this case: the
    // url parser reads "path" as the host, and that IS where it goes.)
    for (const url of ['https://', 'https://?x=1']) {
      render(
        <NotificationBanner
          notifications={[item({ id: url, link: { url, label: 'Open' } })]}
          onDismiss={() => {}}
        />,
      );
      expect(screen.queryByTestId('live-notification-link')).toBeNull();
      expect(screen.queryByTestId('live-notification-link-host')).toBeNull();
      cleanup();
    }
  });

  it('shows the host under a clickable picture too', () => {
    render(
      <NotificationBanner
        notifications={[item({ image: image({ link: 'https://claims.example.org/go' }) })]}
        onDismiss={() => {}}
      />,
    );
    const anchor = screen.getByTestId('live-notification-image-link');
    expect(anchor).toHaveAttribute('href', 'https://claims.example.org/go');
    const host = screen.getByTestId('live-notification-image-host');
    expect(host).toHaveTextContent('claims.example.org');
    // The host belongs to the click target, not to some other corner.
    expect(anchor.contains(host)).toBe(true);
  });

  it('renders a picture with no link as a plain picture, and no host line', () => {
    render(<NotificationBanner notifications={[item({ image: image() })]} onDismiss={() => {}} />);
    expect(screen.getByTestId('live-notification-image')).toBeInTheDocument();
    expect(screen.queryByTestId('live-notification-image-host')).toBeNull();
  });
});

describe('NotificationBanner escape hatch', () => {
  it('a dismissible notice keeps its X and offers no collapse control', () => {
    render(<NotificationBanner notifications={[item()]} onDismiss={() => {}} />);
    expect(screen.getByTestId('live-notification-dismiss')).toBeInTheDocument();
    expect(screen.queryByTestId('live-notification-collapse')).toBeNull();
    expect(screen.getByTestId('live-notification')).toHaveAttribute('data-collapsed', 'false');
  });

  it('a NON-dismissible notice can always be collapsed to one attributed line', () => {
    render(
      <NotificationBanner
        notifications={[
          item({
            dismissible: false,
            title: 'ACTION REQUIRED',
            body: 'A wall of text that would otherwise own the screen.',
            link: { url: 'https://evil.example.net/verify', label: 'Verify now' },
            image: image(),
          }),
        ]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.queryByTestId('live-notification-dismiss')).toBeNull();
    fireEvent.click(screen.getByTestId('live-notification-collapse'));

    // One line: the attribution and the title, and nothing else of the notice.
    const banner = screen.getByTestId('live-notification');
    expect(banner).toHaveAttribute('data-collapsed', 'true');
    expect(banner.children).toHaveLength(1);
    expect(screen.queryByTestId('live-notification-body')).toBeNull();
    expect(screen.queryByTestId('live-notification-link')).toBeNull();
    expect(screen.queryByTestId('live-notification-image')).toBeNull();
    expect(screen.queryByTestId('live-notification-stack')).toBeNull();
    // Still attributed, still named, still reversible.
    expect(banner).toHaveTextContent(NOTIF_ATTRIBUTION);
    expect(screen.getByTestId('live-notification-title')).toHaveTextContent('ACTION REQUIRED');
    const expand = screen.getByTestId('live-notification-expand');
    expect(expand.tagName).toBe('BUTTON');

    fireEvent.click(expand);
    expect(screen.getByTestId('live-notification')).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByTestId('live-notification-body')).toBeInTheDocument();
    expect(screen.getByTestId('live-notification-collapse')).toBeInTheDocument();
  });

  it('collapses the surface, not one notice: the whole set folds into the line', () => {
    render(
      <NotificationBanner
        notifications={[
          item({ id: 'a', title: 'First', dismissible: false }),
          item({ id: 'b', title: 'Second' }),
        ]}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('live-notification-collapse'));
    expect(screen.getByTestId('live-notification')).toHaveAttribute('data-collapsed', 'true');
    // No stack, no dots, no room for anything to hold the screen.
    expect(counter()).toBeNull();
    expect(screen.getAllByTestId('live-notification-title')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// rotation between several notices
// ---------------------------------------------------------------------------

describe('NotificationBanner rotation', () => {
  const three = [
    item({ id: 'a', title: 'First' }),
    item({ id: 'b', title: 'Second' }),
    item({ id: 'c', title: 'Third' }),
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('shows no counter and starts no timer for a single notice', () => {
    render(<NotificationBanner notifications={[item({ title: 'Alone' })]} onDismiss={() => {}} />);
    expect(counter()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    advance(NOTIF_ROTATE_MS * 3);
    expect(title()).toBe('Alone');
  });

  it('shows the first notice, then advances every NOTIF_ROTATE_MS and wraps', () => {
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    expect(title()).toBe('First');
    advance(NOTIF_ROTATE_MS - 1);
    expect(title()).toBe('First');
    advance(1);
    expect(title()).toBe('Second');
    advance(NOTIF_ROTATE_MS);
    expect(title()).toBe('Third');
    // ...and back around to the start.
    advance(NOTIF_ROTATE_MS);
    expect(title()).toBe('First');
  });

  it('stamps the visible index and the total on the counter', () => {
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    expect(counter()).toHaveAttribute('data-index', '0');
    expect(counter()).toHaveAttribute('data-total', '3');
    advance(NOTIF_ROTATE_MS);
    expect(counter()).toHaveAttribute('data-index', '1');
    expect(counter()).toHaveAttribute('data-total', '3');
  });

  it('clears the timer on unmount', () => {
    const { unmount } = render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses while the pointer is over the banner and resumes when it leaves', () => {
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    fireEvent.mouseEnter(screen.getByTestId('live-notification'));
    advance(NOTIF_ROTATE_MS * 3);
    expect(title()).toBe('First');
    fireEvent.mouseLeave(screen.getByTestId('live-notification'));
    advance(NOTIF_ROTATE_MS);
    expect(title()).toBe('Second');
  });

  it('pauses while focus is inside the banner', () => {
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    fireEvent.focus(screen.getByTestId('live-notification-dismiss'));
    advance(NOTIF_ROTATE_MS * 2);
    expect(title()).toBe('First');
    fireEvent.blur(screen.getByTestId('live-notification-dismiss'));
    advance(NOTIF_ROTATE_MS);
    expect(title()).toBe('Second');
  });

  it('does NOT auto-advance under data-reduced-motion, showing the first notice', () => {
    document.documentElement.dataset.reducedMotion = 'true';
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    expect(vi.getTimerCount()).toBe(0);
    advance(NOTIF_ROTATE_MS * 4);
    expect(title()).toBe('First');
    // The counter still says there are three: only the movement is suppressed.
    expect(counter()).toHaveAttribute('data-total', '3');
  });

  it('does NOT auto-advance when the OS asks for reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: /prefers-reduced-motion/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    advance(NOTIF_ROTATE_MS * 2);
    expect(title()).toBe('First');
  });

  it('still rotates in an environment with no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    advance(NOTIF_ROTATE_MS);
    expect(title()).toBe('Second');
  });

  it('dismisses the VISIBLE notice and advances immediately, without waiting for the store', () => {
    const onDismiss = vi.fn();
    render(<NotificationBanner notifications={three} onDismiss={onDismiss} />);
    advance(NOTIF_ROTATE_MS); // now on 'b'
    expect(title()).toBe('Second');
    fireEvent.click(screen.getByTestId('live-notification-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('b@0');
    // The parent has not re-rendered yet; the banner has already moved on.
    expect(title()).toBe('Third');
  });

  it('keeps showing the notice it advanced to when the parent hands back a shorter list', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<NotificationBanner notifications={three} onDismiss={onDismiss} />);
    advance(NOTIF_ROTATE_MS); // on 'b'
    fireEvent.click(screen.getByTestId('live-notification-dismiss'));
    expect(title()).toBe('Third');
    // The store round-trip lands: 'b' is gone from the array.
    rerender(
      <NotificationBanner notifications={[three[0], three[2]]} onDismiss={onDismiss} />,
    );
    expect(title()).toBe('Third');
    expect(counter()).toHaveAttribute('data-index', '1');
    expect(counter()).toHaveAttribute('data-total', '2');
  });

  // -------------------------------------------------------------------------
  // Stable geometry (owner, live: "the dots sit in different places as it
  // rotates"). jsdom has no layout, so what is pinned here is the STRUCTURE
  // that makes the geometry stable in a browser: every notice is stacked in one
  // grid cell, so the box is as tall as the tallest of them and cannot resize
  // as they swap, and the indicator is a SIBLING of that stack rather than
  // something that rides at the end of a notice's text.
  // -------------------------------------------------------------------------

  it('stacks every notice in ONE grid cell, with only the current one visible', () => {
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    const stack = screen.getByTestId('live-notification-stack');
    expect(stack.style.display).toBe('grid');
    expect(stack.children).toHaveLength(3);
    const visibility = [...stack.children].map((c) => (c as HTMLElement).style.visibility);
    expect(visibility).toEqual(['visible', 'hidden', 'hidden']);
    advance(NOTIF_ROTATE_MS);
    expect([...stack.children].map((c) => (c as HTMLElement).style.visibility)).toEqual([
      'hidden',
      'visible',
      'hidden',
    ]);
    // Still one box, not three: the stack is what holds the height open.
    expect(stack.children).toHaveLength(3);
  });

  it('gives the hidden copies no test ids, so exactly one of each is findable', () => {
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    expect(screen.getAllByTestId('live-notification-title')).toHaveLength(1);
    expect(screen.getAllByTestId('live-notification-body')).toHaveLength(1);
    expect(screen.getAllByTestId('live-notification-dismiss')).toHaveLength(1);
    expect(screen.getAllByTestId('live-notification')).toHaveLength(1);
  });

  it('keeps the indicator OUTSIDE the notices, in the same place for every one', () => {
    render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    const banner = screen.getByTestId('live-notification');
    const stack = screen.getByTestId('live-notification-stack');
    const footer = banner.children[2] as HTMLElement;
    const first = counter()!;
    // It rides at the end of the fixed footer row, not inside a notice's text,
    // and that row is the banner's last child.
    expect(stack.contains(first)).toBe(false);
    expect(first.parentElement).toBe(footer);
    expect(banner.children).toHaveLength(3);
    expect(banner.lastElementChild).toBe(footer);

    // ...and it is the SAME node in the SAME position after every step of the
    // rotation, which is what stops it moving on screen.
    for (let i = 0; i < 3; i++) {
      advance(NOTIF_ROTATE_MS);
      const now = counter()!;
      expect(now).toBe(first);
      expect(now.parentElement).toBe(footer);
      expect(banner.children).toHaveLength(3);
      expect(banner.lastElementChild).toBe(footer);
    }
  });

  it('reserves nothing for a single notice: no indicator dots at all', () => {
    render(<NotificationBanner notifications={[item({ title: 'Alone' })]} onDismiss={() => {}} />);
    const banner = screen.getByTestId('live-notification');
    // The attribution row, the stack, the safety footer. Nothing to rotate
    // through, so no dots and no reservation for them.
    expect(banner.children).toHaveLength(3);
    expect(counter()).toBeNull();
    expect(screen.getByTestId('live-notification-from')).toBeInTheDocument();
    expect(screen.getByTestId('live-notification-safety')).toBeInTheDocument();
  });

  it('falls back to the first notice when the visible one disappears from the list', () => {
    const { rerender } = render(<NotificationBanner notifications={three} onDismiss={() => {}} />);
    // One step per advance: the next timeout is only scheduled once React has
    // committed the state the previous one set.
    advance(NOTIF_ROTATE_MS); // on 'b'
    advance(NOTIF_ROTATE_MS); // on 'c'
    expect(title()).toBe('Third');
    // A refetch or a chain switch replaces the set wholesale.
    rerender(<NotificationBanner notifications={[item({ id: 'z', title: 'Only one' })]} onDismiss={() => {}} />);
    expect(title()).toBe('Only one');
    expect(counter()).toBeNull();
  });
});
