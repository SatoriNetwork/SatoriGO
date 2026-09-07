import { describe, expect, it } from 'vitest';
import {
  addApproval,
  approvedWalletId,
  collapseToOnePerOrigin,
  isOriginApproved,
  normalizeApprovals,
  setApproval,
  type ApprovedEntry,
} from './approvals';

const A = 'https://a.example';
const B = 'https://b.example';

describe('normalizeApprovals — legacy migration', () => {
  it('rebinds a legacy bare-string origin to the current activeId', () => {
    const { entries, changed } = normalizeApprovals([A], 'w1');
    expect(entries).toEqual([{ origin: A, walletId: 'w1' }]);
    expect(changed).toBe(true); // string -> object => must persist back
  });

  it('binds multiple legacy strings all to the active wallet', () => {
    const { entries } = normalizeApprovals([A, B], 'w2');
    expect(entries).toEqual([
      { origin: A, walletId: 'w2' },
      { origin: B, walletId: 'w2' },
    ]);
  });

  it('drops a legacy string when there is no active wallet (fail closed)', () => {
    const { entries, changed } = normalizeApprovals([A], undefined);
    expect(entries).toEqual([]);
    expect(changed).toBe(true);
  });

  it('leaves an already-migrated list untouched (changed=false)', () => {
    const list: ApprovedEntry[] = [{ origin: A, walletId: 'w1' }];
    const { entries, changed } = normalizeApprovals(list, 'w1');
    expect(entries).toEqual(list);
    expect(changed).toBe(false);
  });
});

describe('normalizeApprovals — malformed entries', () => {
  it('drops non-string / non-object junk and empty strings', () => {
    const { entries, changed } = normalizeApprovals(
      [A, '', 42, null, undefined, {}, { origin: A }, { walletId: 'w1' }],
      'w1',
    );
    expect(entries).toEqual([{ origin: A, walletId: 'w1' }]);
    expect(changed).toBe(true);
  });

  it('drops entries with empty origin or walletId', () => {
    const { entries } = normalizeApprovals(
      [{ origin: '', walletId: 'w1' }, { origin: A, walletId: '' }],
      'w1',
    );
    expect(entries).toEqual([]);
  });

  it('treats a non-array as empty', () => {
    expect(normalizeApprovals(undefined, 'w1').entries).toEqual([]);
    expect(normalizeApprovals(null, 'w1').entries).toEqual([]);
    expect(normalizeApprovals('nonsense', 'w1').entries).toEqual([]);
    expect(normalizeApprovals({ origin: A }, 'w1').entries).toEqual([]);
  });

  it('collapses duplicate (origin, walletId) pairs', () => {
    const { entries, changed } = normalizeApprovals(
      [{ origin: A, walletId: 'w1' }, { origin: A, walletId: 'w1' }],
      'w1',
    );
    expect(entries).toEqual([{ origin: A, walletId: 'w1' }]);
    expect(changed).toBe(true);
  });
});

describe('normalizeApprovals — deleted-wallet pruning', () => {
  it('drops entries whose walletId is not among the valid wallet ids', () => {
    const list: ApprovedEntry[] = [
      { origin: A, walletId: 'w1' },
      { origin: B, walletId: 'gone' },
    ];
    const { entries, changed } = normalizeApprovals(list, 'w1', new Set(['w1']));
    expect(entries).toEqual([{ origin: A, walletId: 'w1' }]);
    expect(changed).toBe(true);
  });

  it('keeps all entries when every wallet still exists (changed=false)', () => {
    const list: ApprovedEntry[] = [
      { origin: A, walletId: 'w1' },
      { origin: B, walletId: 'w2' },
    ];
    const { entries, changed } = normalizeApprovals(list, 'w1', new Set(['w1', 'w2']));
    expect(entries).toEqual(list);
    expect(changed).toBe(false);
  });

  it('does not prune when no valid-id set is provided', () => {
    const list: ApprovedEntry[] = [{ origin: A, walletId: 'gone' }];
    const { entries } = normalizeApprovals(list, 'w1');
    expect(entries).toEqual(list);
  });
});

describe('isOriginApproved — origin + wallet must both match', () => {
  const entries: ApprovedEntry[] = [
    { origin: A, walletId: 'w1' },
    { origin: B, walletId: 'w2' },
  ];

  it('matches when origin and active wallet both match', () => {
    expect(isOriginApproved(entries, A, 'w1')).toBe(true);
  });

  it('does NOT match when the origin is approved for a DIFFERENT wallet (wallet switch)', () => {
    // A is approved for w1; while w2 is active, A must NOT be treated as connected.
    expect(isOriginApproved(entries, A, 'w2')).toBe(false);
  });

  it('does not match an unknown origin', () => {
    expect(isOriginApproved(entries, 'https://c.example', 'w1')).toBe(false);
  });

  it('never matches when there is no active wallet', () => {
    expect(isOriginApproved(entries, A, undefined)).toBe(false);
    expect(isOriginApproved(entries, A, '')).toBe(false);
  });

  it('supports the same origin approved for multiple wallets simultaneously', () => {
    const multi: ApprovedEntry[] = [
      { origin: A, walletId: 'w1' },
      { origin: A, walletId: 'w2' },
    ];
    expect(isOriginApproved(multi, A, 'w1')).toBe(true);
    expect(isOriginApproved(multi, A, 'w2')).toBe(true);
  });
});

describe('addApproval', () => {
  it('appends a new (origin, walletId) entry', () => {
    expect(addApproval([], A, 'w1')).toEqual([{ origin: A, walletId: 'w1' }]);
  });

  it('does not duplicate an exact existing entry', () => {
    const existing: ApprovedEntry[] = [{ origin: A, walletId: 'w1' }];
    expect(addApproval(existing, A, 'w1')).toEqual(existing);
  });

  it('adds a second wallet for the same origin', () => {
    const existing: ApprovedEntry[] = [{ origin: A, walletId: 'w1' }];
    expect(addApproval(existing, A, 'w2')).toEqual([
      { origin: A, walletId: 'w1' },
      { origin: A, walletId: 'w2' },
    ]);
  });
});

describe('approvedWalletId — which wallet an origin is CONNECTED to', () => {
  it('returns the bound wallet id, and null for an origin never approved', () => {
    const list: ApprovedEntry[] = [{ origin: A, walletId: 'w1' }];
    expect(approvedWalletId(list, A)).toBe('w1');
    expect(approvedWalletId(list, B)).toBeNull();
    expect(approvedWalletId([], A)).toBeNull();
  });

  it('does NOT depend on which wallet is active: the binding is to the picked wallet', () => {
    // The whole point of the 1.4.1 change: a site approved for Wallet 1 stays
    // on Wallet 1 while the wallet UI shows Bitcoin, Wallet 2, anything.
    const list: ApprovedEntry[] = [{ origin: A, walletId: 'w1' }];
    expect(approvedWalletId(list, A)).toBe('w1');
    expect(isOriginApproved(list, A, 'w2')).toBe(false); // the old, active-bound view
  });

  it('with several legacy entries for one origin, the LAST (most recent consent) wins', () => {
    const list: ApprovedEntry[] = [
      { origin: A, walletId: 'w1' },
      { origin: B, walletId: 'w1' },
      { origin: A, walletId: 'w2' },
    ];
    expect(approvedWalletId(list, A)).toBe('w2');
    expect(approvedWalletId(list, B)).toBe('w1');
  });
});

describe('setApproval — one connected wallet per origin', () => {
  it('adds a binding for a new origin without touching the others', () => {
    const list: ApprovedEntry[] = [{ origin: B, walletId: 'w1' }];
    expect(setApproval(list, A, 'w2')).toEqual([
      { origin: B, walletId: 'w1' },
      { origin: A, walletId: 'w2' },
    ]);
  });

  it('REPLACES an existing binding for the origin instead of adding a second one', () => {
    const list: ApprovedEntry[] = [
      { origin: A, walletId: 'w1' },
      { origin: B, walletId: 'w1' },
    ];
    const next = setApproval(list, A, 'w2');
    expect(next).toEqual([
      { origin: B, walletId: 'w1' },
      { origin: A, walletId: 'w2' },
    ]);
    expect(next.filter((e) => e.origin === A)).toHaveLength(1);
    expect(approvedWalletId(next, A)).toBe('w2');
  });

  it('collapses several legacy entries for the origin down to the one chosen', () => {
    const list: ApprovedEntry[] = [
      { origin: A, walletId: 'w1' },
      { origin: A, walletId: 'w2' },
    ];
    expect(setApproval(list, A, 'w1')).toEqual([{ origin: A, walletId: 'w1' }]);
  });

  it('does not mutate its input', () => {
    const list: ApprovedEntry[] = [{ origin: A, walletId: 'w1' }];
    setApproval(list, A, 'w2');
    expect(list).toEqual([{ origin: A, walletId: 'w1' }]);
  });
});

describe('collapseToOnePerOrigin — a 1.4.0 list with one entry per wallet', () => {
  it('keeps the LAST entry for an origin and reports the change', () => {
    const list: ApprovedEntry[] = [
      { origin: A, walletId: 'w1' },
      { origin: B, walletId: 'w1' },
      { origin: A, walletId: 'w2' },
    ];
    const { entries, changed } = collapseToOnePerOrigin(list);
    expect(changed).toBe(true);
    expect(entries).toEqual([
      { origin: A, walletId: 'w2' },
      { origin: B, walletId: 'w1' },
    ]);
  });

  it('leaves a list that is already one-per-origin alone (changed=false)', () => {
    const list: ApprovedEntry[] = [
      { origin: A, walletId: 'w1' },
      { origin: B, walletId: 'w2' },
    ];
    const { entries, changed } = collapseToOnePerOrigin(list);
    expect(changed).toBe(false);
    expect(entries).toEqual(list);
    expect(collapseToOnePerOrigin([]).changed).toBe(false);
  });
});
