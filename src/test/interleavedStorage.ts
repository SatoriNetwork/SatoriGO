// THE STORAGE DOUBLE THE MULTI-PAGE TESTS DRIVE, shared by every suite that
// needs two pages over one `liveWallets` object.
//
// The faithful double (MemoryStorageAdapter, which clones on read AND write, the
// way chrome.storage does across the extension IPC boundary), plus ONE explicit
// interleaving hook.
//
// The first round of race tests was driven by starting a slow operation and
// letting a second one land inside it, which depends on scrypt taking longer
// than an import; the reviewer who found those defects noted that one such test
// flaked under CPU contention. This drives the interleaving instead of hoping
// for it: `afterRead` runs another page's whole operation at a NAMED point in
// this page's read-modify-write, and nothing depends on how long anything takes.
//
// The hook fires AFTER the value has been read and cloned, BEFORE `get`
// resolves, so the reader is handed the store as it was and the interference is
// already on disk by the time that reader writes. Which read to target:
//
//   nth = 1  the operation's FIRST read, i.e. another page writing during the
//            slow part (scrypt). Every method reads the store first thing, so
//            this one does not depend on counting anything.
//   nth = 2  unlock()'s LAZY MIGRATION re-read (read 1 is unlock's own, read 2
//            is the migration's). Another page landing HERE is past every
//            re-read, so only the compare-and-swap on `rev` can catch it. This
//            one does depend on the read count of the path under test, which is
//            the price of driving the exact window on purpose.
//
// A hook that RE-ARMS ITSELF is how a test drives a page that can never win:
// every read is followed by another page's write, so every compare-and-swap
// fails and the retry budget runs out. See `conflictOnEveryRead`.
//
// It lives here rather than in one test file because more than one suite needs
// it and importing a *.test.ts from another test file would run its tests twice.

import { MemoryStorageAdapter, getStorage, setStorageForTests } from '../services/storage';

export class InterleavedStorage extends MemoryStorageAdapter {
  private pending: (() => Promise<void>) | null = null;
  private skip = 0;

  /** Run `fn` once, right after the `nth` read of `liveWallets` from now. */
  afterRead(fn: () => Promise<void>, nth = 1): void {
    this.pending = fn;
    this.skip = nth - 1;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = await super.get<T>(key);
    if (key === 'liveWallets' && this.pending) {
      if (this.skip > 0) {
        this.skip -= 1;
      } else {
        const fn = this.pending;
        this.pending = null; // re-entrant: the interference reads too
        await fn();
      }
    }
    return value;
  }
}

/** Install one as the storage under test and hand it back. */
export function interleaved(): InterleavedStorage {
  const storage = new InterleavedStorage();
  setStorageForTests(storage);
  return storage;
}

/**
 * ANOTHER PAGE WRITES AFTER EVERY READ, so no compare-and-swap can ever land and
 * the retry budget runs out. The interference is the smallest real write there
 * is: the store put back with its revision bumped, which is exactly what any
 * other page's write looks like to this one.
 *
 * Deterministic, not timed: it re-arms itself from inside the hook, so it does
 * not matter how many reads the path under test makes. Returns the function that
 * stops it, which a test calls before reading the store to assert on it.
 */
export function conflictOnEveryRead(storage: InterleavedStorage): () => void {
  let on = true;
  const arm = (): void => {
    storage.afterRead(async () => {
      if (!on) return; // stopped: do not re-arm
      const store = await getStorage().get<{ rev?: number }>('liveWallets');
      if (store) {
        await getStorage().set('liveWallets', { ...store, rev: (store.rev ?? 0) + 1 });
      }
      arm();
    });
  };
  arm();
  return () => {
    on = false;
  };
}
