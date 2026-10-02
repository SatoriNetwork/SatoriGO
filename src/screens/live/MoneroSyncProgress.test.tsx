/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MoneroSyncProgress } from './MoneroSyncProgress';

afterEach(cleanup);

const at = (height: number) => ({ height, startHeight: 100_000, endHeight: 110_000, percent: 0 });

describe('MoneroSyncProgress', () => {
  it('shows the bar and the block line, no ETA before a stable rate', () => {
    const t = 0;
    render(<MoneroSyncProgress sync={at(102_200)} now={() => t} />);
    const el = screen.getByTestId('live-xmr-sync-progress');
    expect(el.getAttribute('data-percent')).toBe('22');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('22');
    expect(screen.getByTestId('live-xmr-sync-line').textContent).toBe('Syncing 2,200 / 10,000 blocks (22%)');
    expect(screen.getByTestId('live-xmr-sync-eta').textContent).toBe('Keep this window open.');
  });

  it('adds the time left once reports span long enough', () => {
    let t = 0;
    const { rerender } = render(<MoneroSyncProgress sync={at(100_000)} now={() => t} />);
    t = 4_000;
    rerender(<MoneroSyncProgress sync={at(100_400)} now={() => t} />);
    // 4 s is too short a span: still no ETA.
    expect(screen.getByTestId('live-xmr-sync-eta').textContent).toBe('Keep this window open.');
    t = 10_000;
    rerender(<MoneroSyncProgress sync={at(101_000)} now={() => t} />);
    // 1,000 blocks / 10 s = 100 blocks/s; 9,000 left = 90 s.
    expect(screen.getByTestId('live-xmr-sync-eta').textContent).toBe('About 2 min left. Keep this window open.');
    expect(screen.getByTestId('live-xmr-sync-progress').getAttribute('data-percent')).toBe('10');
  });

  it('caps a slow scan at more than 1 h', () => {
    let t = 0;
    const { rerender } = render(<MoneroSyncProgress sync={at(100_000)} now={() => t} />);
    t = 10_000;
    rerender(<MoneroSyncProgress sync={at(100_010)} now={() => t} />);
    expect(screen.getByTestId('live-xmr-sync-eta').textContent).toBe('More than 1 h left. Keep this window open.');
  });

  it('forgets the old rate when a new scan starts', () => {
    let t = 0;
    const { rerender } = render(<MoneroSyncProgress sync={at(100_000)} now={() => t} />);
    t = 10_000;
    rerender(<MoneroSyncProgress sync={at(101_000)} now={() => t} />);
    expect(screen.getByTestId('live-xmr-sync-eta').textContent).toContain('left');
    t = 11_000;
    rerender(<MoneroSyncProgress sync={{ height: 50_000, startHeight: 50_000, endHeight: 110_000, percent: 0 }} now={() => t} />);
    expect(screen.getByTestId('live-xmr-sync-eta').textContent).toBe('Keep this window open.');
    expect(screen.getByTestId('live-xmr-sync-progress').getAttribute('data-percent')).toBe('0');
  });
});
