import { describe, expect, it } from 'vitest';
import { evmApprovalFor, normalizeEvmApprovals, setEvmApproval, setEvmApprovalChain } from './evmApprovals';

const opts = { isChainKey: (k: string) => ['base', 'ethereum'].includes(k), defaultChainKey: 'base' };

describe('EVM dApp approvals', () => {
  it('treats a missing list as empty without a write-back', () => {
    expect(normalizeEvmApprovals(undefined, opts)).toEqual({ entries: [], changed: false });
    expect(normalizeEvmApprovals('junk', opts)).toEqual({ entries: [], changed: true });
  });

  it('keeps well-formed entries untouched', () => {
    const raw = [{ origin: 'https://a.io', walletId: 'w1', chainKey: 'ethereum' }];
    expect(normalizeEvmApprovals(raw, opts)).toEqual({ entries: raw, changed: false });
  });

  it('drops malformed entries and entries for deleted wallets', () => {
    const raw = [
      { origin: 'https://a.io', walletId: 'w1', chainKey: 'base' },
      { origin: '', walletId: 'w1', chainKey: 'base' },
      'https://legacy.io',
      { origin: 'https://b.io', walletId: 'gone', chainKey: 'base' },
    ];
    const r = normalizeEvmApprovals(raw, { ...opts, validWalletIds: new Set(['w1']) });
    expect(r.entries).toEqual([{ origin: 'https://a.io', walletId: 'w1', chainKey: 'base' }]);
    expect(r.changed).toBe(true);
  });

  it('falls back to the default chain for an unknown chain key', () => {
    const r = normalizeEvmApprovals([{ origin: 'https://a.io', walletId: 'w1', chainKey: 'nope' }], opts);
    expect(r.entries[0].chainKey).toBe('base');
    expect(r.changed).toBe(true);
  });

  it('keeps one account per origin, the later one', () => {
    const r = normalizeEvmApprovals(
      [
        { origin: 'https://a.io', walletId: 'w1', chainKey: 'base' },
        { origin: 'https://a.io', walletId: 'w2', chainKey: 'base' },
      ],
      opts,
    );
    expect(r.entries).toEqual([{ origin: 'https://a.io', walletId: 'w2', chainKey: 'base' }]);
  });

  it('binds, rebinds and switches chain', () => {
    let list = setEvmApproval([], 'https://a.io', 'w1', 'base');
    list = setEvmApproval(list, 'https://a.io', 'w2', 'base');
    expect(list).toEqual([{ origin: 'https://a.io', walletId: 'w2', chainKey: 'base' }]);
    list = setEvmApprovalChain(list, 'https://a.io', 'ethereum');
    expect(evmApprovalFor(list, 'https://a.io')?.chainKey).toBe('ethereum');
    expect(setEvmApprovalChain(list, 'https://other.io', 'base')).toEqual(list);
  });
});
