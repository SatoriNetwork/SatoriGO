// The store's notifications slice: how a dismissal is recorded and how the
// persisted set survives the move to per-revision dismissals.
//
// WHY THIS FILE EXISTS: a notice is dismissed against `id@rev`
// (services/notifications.ts dismissalKey), not against its bare id, so the
// owner can resubmit a notice by bumping its `rev` and have it come back for
// everyone. That changed the shape of what `notif.dismissed.v1` holds, and the
// storage key deliberately kept its name, so the ONE thing that must never
// break is the read migration: an upgrading user has bare ids on disk and must
// not get every notice they ever closed back at once.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStorageAdapter, setStorageForTests, type KeyValueStorage } from '../services/storage';
import { MAX_DISMISSED_KEYS } from '../services/notifications';
import { useLiveStore } from './liveStore';

/** The persisted key. Hard-coded here on purpose: it is a storage contract, and
 *  a test that imported the constant could not catch it being renamed. */
const NOTIF_DISMISSED_KEY = 'notif.dismissed.v1';

/** init() connects; nothing in this file wants a socket. */
class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const state = () => useLiveStore.getState();
let storage: KeyValueStorage;

beforeAll(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
});

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  await state().resetLiveWallet();
  // The store is a module singleton: clear what a previous test dismissed, so
  // each case starts from a wallet that has closed nothing.
  useLiveStore.setState({ dismissedNotificationKeys: [] });
});

afterEach(() => {
  state().stopAutoRefresh();
});

describe('dismissNotification', () => {
  it('records the DISMISSAL KEY in state and on disk', async () => {
    await state().dismissNotification('welcome@2');
    expect(state().dismissedNotificationKeys).toEqual(['welcome@2']);
    expect(await storage.get<string[]>(NOTIF_DISMISSED_KEY)).toEqual(['welcome@2']);
  });

  it('normalises a BARE id to revision 0, so every entry has one format', async () => {
    await state().dismissNotification('welcome');
    expect(state().dismissedNotificationKeys).toEqual(['welcome@0']);
    expect(await storage.get<string[]>(NOTIF_DISMISSED_KEY)).toEqual(['welcome@0']);
  });

  it('appends further dismissals and ignores a repeat of one already recorded', async () => {
    await state().dismissNotification('a@0');
    await state().dismissNotification('b@1');
    await state().dismissNotification('a@0'); // already closed: no second entry
    await state().dismissNotification('a'); // the same thing, spelled the old way
    expect(state().dismissedNotificationKeys).toEqual(['a@0', 'b@1']);
    expect(await storage.get<string[]>(NOTIF_DISMISSED_KEY)).toEqual(['a@0', 'b@1']);
  });

  it('keeps each REVISION of one notice separately', async () => {
    await state().dismissNotification('welcome@0');
    await state().dismissNotification('welcome@1');
    expect(state().dismissedNotificationKeys).toEqual(['welcome@0', 'welcome@1']);
  });

  it('BOUNDS what it stores: 200 keys, the oldest dropped', async () => {
    // Every entry here is a string the feed chose, and this list used to grow
    // forever, so a feed minting a new id per fetch could fill the profile.
    useLiveStore.setState({
      dismissedNotificationKeys: Array.from({ length: MAX_DISMISSED_KEYS }, (_, i) => `n${i}@0`),
    });
    await state().dismissNotification('newest@0');
    const kept = state().dismissedNotificationKeys;
    expect(kept).toHaveLength(MAX_DISMISSED_KEYS);
    expect(kept[kept.length - 1]).toBe('newest@0'); // the newest is kept...
    expect(kept[0]).toBe('n1@0'); // ...and the oldest fell off the front
    expect(await storage.get<string[]>(NOTIF_DISMISSED_KEY)).toEqual(kept);
  });
});

describe('the persisted set on load (migration)', () => {
  it('reads a LEGACY bare-id list as revision-0 keys', async () => {
    await storage.set(NOTIF_DISMISSED_KEY, ['welcome', 'maintenance']);
    await state().init();
    expect(state().dismissedNotificationKeys).toEqual(['welcome@0', 'maintenance@0']);
  });

  it('passes real keys through, drops junk, and de-duplicates a mixed list', async () => {
    await storage.set(NOTIF_DISMISSED_KEY, ['a', 'b@3', 'a@0', '', 'c']);
    await state().init();
    expect(state().dismissedNotificationKeys).toEqual(['a@0', 'b@3', 'c@0']);
  });

  it('writes the migrated shape back on the next dismissal', async () => {
    await storage.set(NOTIF_DISMISSED_KEY, ['welcome']);
    await state().init();
    await state().dismissNotification('later@0');
    // The legacy bare id is gone from disk, replaced by its migrated key.
    expect(await storage.get<string[]>(NOTIF_DISMISSED_KEY)).toEqual(['welcome@0', 'later@0']);
  });

  it('starts empty when nothing was ever dismissed', async () => {
    await state().init();
    expect(state().dismissedNotificationKeys).toEqual([]);
  });
});
