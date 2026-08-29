/**
 * Pure grouping of wallet entries into "one seed, many accounts"
 * (the EVM accounts design notes). The flattened order this produces is what the
 * picker's `live-wallet-item-${i}` indexes count, so it is pinned here rather
 * than re-derived in three screens.
 */

import { describe, expect, it } from 'vitest';
import {
  filterAccountsForChain,
  memberLabel,
  accountNumberOf,
  flattenGroups,
  groupWallets,
  isEvmSeedAccount,
  shortAccountAddress,
  siblingAccounts,
  type GroupableWallet,
} from './walletGroups';

function evmAccount(
  id: string,
  name: string,
  hdIndex: number,
  seedGroup: string | undefined = '0xaaa',
): GroupableWallet {
  return { id, name, family: 'evm', kind: 'seed', hdIndex, seedGroup };
}

const utxo: GroupableWallet = { id: 'u1', name: 'My Evrmore', family: 'utxo', kind: 'seed' };
const pk: GroupableWallet = { id: 'p1', name: 'Satori key', family: 'utxo', kind: 'pk' };
const evmPk: GroupableWallet = { id: 'p2', name: 'EVM key', family: 'evm', kind: 'pk' };

describe('groupWallets', () => {
  it('groups EVM seed accounts of one seed under a single node', () => {
    const nodes = groupWallets([evmAccount('a', 'Account 1', 0), evmAccount('b', 'Account 2', 1)]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('group');
    if (nodes[0].kind !== 'group') throw new Error('expected a group');
    expect(nodes[0].key).toBe('0xaaa');
    expect(nodes[0].title).toBe('Account 1');
    expect(nodes[0].members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('sorts members by hdIndex and titles the group after the lowest one', () => {
    const nodes = groupWallets([
      evmAccount('c', 'Account 3', 2),
      evmAccount('a', 'My EVM', 0),
      evmAccount('b', 'Account 2', 1),
    ]);
    if (nodes[0].kind !== 'group') throw new Error('expected a group');
    expect(nodes[0].members.map((m) => m.hdIndex)).toEqual([0, 1, 2]);
    // Title = the name of the lowest-index member, not of the first entry seen.
    expect(nodes[0].title).toBe('My EVM');
  });

  it('treats a missing hdIndex as index 0', () => {
    const first: GroupableWallet = { id: 'a', name: 'My EVM', family: 'evm', kind: 'seed', seedGroup: '0xaaa' };
    const nodes = groupWallets([evmAccount('b', 'Account 2', 1), first]);
    if (nodes[0].kind !== 'group') throw new Error('expected a group');
    expect(nodes[0].members.map((m) => m.id)).toEqual(['a', 'b']);
    expect(accountNumberOf(first)).toBe(1);
  });

  it('keeps the position of a group at its FIRST member and preserves overall order', () => {
    const nodes = groupWallets([
      utxo,
      evmAccount('a', 'Account 1', 0),
      pk,
      evmAccount('b', 'Account 2', 1),
    ]);
    expect(nodes.map((n) => (n.kind === 'group' ? `group:${n.key}` : n.wallet.id))).toEqual([
      'u1',
      'group:0xaaa',
      'p1',
    ]);
  });

  it('keeps separate seeds in separate groups', () => {
    const nodes = groupWallets([
      evmAccount('a', 'Seed A', 0, '0xaaa'),
      evmAccount('x', 'Seed B', 0, '0xbbb'),
      evmAccount('b', 'Account 2', 1, '0xaaa'),
    ]);
    expect(nodes).toHaveLength(2);
    if (nodes[0].kind !== 'group' || nodes[1].kind !== 'group') throw new Error('expected two groups');
    expect(nodes[0].key).toBe('0xaaa');
    expect(nodes[0].members.map((m) => m.id)).toEqual(['a', 'b']);
    expect(nodes[1].key).toBe('0xbbb');
    expect(nodes[1].members.map((m) => m.id)).toEqual(['x']);
  });

  it('gives an EVM seed entry with NO seedGroup a group of its own, keyed by id', () => {
    const legacy: GroupableWallet = { id: 'legacy', name: 'Old EVM', family: 'evm', kind: 'seed' };
    const nodes = groupWallets([legacy, evmAccount('a', 'Account 1', 0, '0xaaa')]);
    expect(nodes).toHaveLength(2);
    if (nodes[0].kind !== 'group') throw new Error('expected a group');
    expect(nodes[0].key).toBe('id:legacy');
    expect(nodes[0].members).toHaveLength(1);
  });

  it('renders a lone EVM seed account as a group too (Add account hangs off it)', () => {
    const nodes = groupWallets([evmAccount('a', 'My EVM', 0)]);
    expect(nodes[0].kind).toBe('group');
  });

  it('leaves UTXO wallets and private-key wallets as singles', () => {
    const nodes = groupWallets([utxo, pk, evmPk]);
    expect(nodes.map((n) => n.kind)).toEqual(['single', 'single', 'single']);
    expect(isEvmSeedAccount(evmPk)).toBe(false);
    expect(isEvmSeedAccount(utxo)).toBe(false);
  });

  it('flattens back to the visible row order (headings take no index)', () => {
    const nodes = groupWallets([
      utxo,
      evmAccount('c', 'Account 3', 2),
      evmAccount('a', 'Account 1', 0),
      pk,
    ]);
    expect(flattenGroups(nodes).map((w) => w.id)).toEqual(['u1', 'a', 'c', 'p1']);
  });
});

describe('siblingAccounts', () => {
  it('lists the other accounts of the same seed', () => {
    const a = evmAccount('a', 'Account 1', 0);
    const b = evmAccount('b', 'Account 2', 1);
    const other = evmAccount('x', 'Other seed', 0, '0xbbb');
    expect(siblingAccounts([a, b, other, utxo], a).map((w) => w.id)).toEqual(['b']);
  });

  it('is empty for the last account of a seed, for pk and for UTXO wallets', () => {
    const a = evmAccount('a', 'Account 1', 0);
    expect(siblingAccounts([a, utxo, pk], a)).toEqual([]);
    expect(siblingAccounts([a, utxo, pk], utxo)).toEqual([]);
    expect(siblingAccounts([a, utxo, pk], pk)).toEqual([]);
    expect(siblingAccounts([a], null)).toEqual([]);
  });

  it('does not pair two ungrouped legacy EVM entries with each other', () => {
    const l1: GroupableWallet = { id: 'l1', name: 'Old A', family: 'evm', kind: 'seed' };
    const l2: GroupableWallet = { id: 'l2', name: 'Old B', family: 'evm', kind: 'seed' };
    expect(siblingAccounts([l1, l2], l1)).toEqual([]);
  });
});

describe('shortAccountAddress', () => {
  it('shortens a 0x address to 6 + 4', () => {
    expect(shortAccountAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe('0x9858…da94');
  });

  it('leaves a short string alone', () => {
    expect(shortAccountAddress('0x1234')).toBe('0x1234');
    expect(shortAccountAddress('')).toBe('');
  });

  it('memberLabel: the first account reads "Account 1" under its own group title only when the seed has several accounts', () => {
    const first = { id: 'a', name: 'Wallet 1', family: 'evm', kind: 'seed', address: '0x1', seedGroup: '0x1', hdIndex: 0 } as unknown as Parameters<typeof memberLabel>[0];
    const second = { ...first, id: 'b', name: 'Account 2', hdIndex: 1 } as unknown as Parameters<typeof memberLabel>[0];
    expect(memberLabel(first, 'Wallet 1', 2)).toBe('Account 1');
    expect(memberLabel(second, 'Wallet 1', 2)).toBe('Account 2');
    expect(memberLabel(first, 'Wallet 1', 1)).toBe('Wallet 1');
    const renamed = { ...second, name: 'Trading' } as unknown as Parameters<typeof memberLabel>[0];
    expect(memberLabel(renamed, 'Wallet 1', 2)).toBe('Trading');
  });

  it('filterAccountsForChain: scopes a seed to the accounts known on the chain; index 0 and the active account always show; no data shows all; non-EVM untouched', () => {
    const g='0xseed';
    const mk=(id:string,hd:number)=>({ id, name:`Account ${hd+1}`, family:'evm', kind:'seed', address:`0x${hd}`, seedGroup:g, hdIndex:hd } as unknown as Parameters<typeof filterAccountsForChain>[0][number]);
    const utxo={ id:'u', name:'Evr', family:'utxo', kind:'seed', address:'E1' } as unknown as Parameters<typeof filterAccountsForChain>[0][number];
    const all=[mk('a0',0),mk('a1',1),mk('a2',2),mk('a3',3),utxo];
    // Known on this chain: 0 and 2. Active is a3 (must stay visible).
    expect(filterAccountsForChain(all,{ [g]:[0,2] },'a3').map(w=>w.id)).toEqual(['a0','a2','a3','u']);
    // No record for the group: everything shows.
    expect(filterAccountsForChain(all,{},'a0').map(w=>w.id)).toEqual(['a0','a1','a2','a3','u']);
    // Empty record: only index 0 (and the active) survive.
    expect(filterAccountsForChain(all,{ [g]:[] },null).map(w=>w.id)).toEqual(['a0','u']);
  });
});
