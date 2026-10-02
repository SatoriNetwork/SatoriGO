// Hiding networks from the switcher and the wallet-creation picker.
//
// Hiding is PRESENTATION ONLY: nothing is deleted and no wallet is touched. The
// rules worth testing are the two chains that must never disappear, because
// each one produces a state the user cannot get out of from inside the app.

import { describe, expect, it } from 'vitest';
import { canonicalHiddenChainId, chainHideBlockedReason, isChainHideable, normalizeStoredHiddenChains } from './liveStore';

describe('which chains can be hidden', () => {
  const ACTIVE = 'bitcoin-mainnet';

  it('never lets the home network be hidden, under either of its ids', () => {
    // Evrmore is where staking lives and is the fallback every wallet lands on.
    for (const id of ['mainnet', 'evrmore-mainnet']) {
      expect(isChainHideable(id, ACTIVE)).toBe(false);
      expect(chainHideBlockedReason(id, ACTIVE)).toMatch(/home network/i);
    }
  });

  it('never lets the network IN USE be hidden', () => {
    // Otherwise the user stands on a chain missing from their own switcher,
    // with no way back to it.
    expect(isChainHideable(ACTIVE, ACTIVE)).toBe(false);
    expect(chainHideBlockedReason(ACTIVE, ACTIVE)).toMatch(/network you are using/i);
  });

  it('recognises the active chain through its alias, not just the exact string', () => {
    // Evrmore's stored id is the legacy bare 'mainnet' while its canonical id is
    // 'evrmore-mainnet'. A string compare would miss one of them.
    expect(chainHideBlockedReason('evrmore-mainnet', 'mainnet')).not.toBeNull();
  });

  it('allows every other network, including ones holding a wallet', () => {
    // Deliberate: hiding is reversible and destroys nothing, so a wallet on the
    // chain is not a reason to refuse. It comes straight back when shown again.
    for (const id of [
      'ravencoin-mainnet',
      'litecoin-mainnet',
      'dogecoin-mainnet',
      'bitcoingold-mainnet',
      'wojakcoin-mainnet',
    ]) {
      expect(isChainHideable(id, ACTIVE)).toBe(true);
      expect(chainHideBlockedReason(id, ACTIVE)).toBeNull();
    }
  });

  it('treats Monero like any other non-home chain: hideable unless it is the one in use', () => {
    // `xmr:mainnet` is not a UTXO id. Without its own branch it would fall
    // through networkFor()'s default case, read as Evrmore, and be refused as
    // "the home network"; worse, setChainHidden would canonicalise it to
    // Evrmore and hide the home chain instead.
    expect(isChainHideable('xmr:mainnet', ACTIVE)).toBe(true);
    expect(chainHideBlockedReason('xmr:mainnet', ACTIVE)).toBeNull();
    expect(isChainHideable('xmr:mainnet', 'xmr:mainnet')).toBe(false);
    expect(chainHideBlockedReason('xmr:mainnet', 'xmr:mainnet')).toMatch(/network you are using/i);
    expect(chainHideBlockedReason('xmr:mainnet', 'xmr:mainnet')).not.toMatch(/home network/i);
  });

  it('treats Zcash and Bittensor the same way: their targets are not UTXO ids either', () => {
    for (const id of ['zec:mainnet', 'tao:mainnet']) {
      expect(isChainHideable(id, ACTIVE)).toBe(true);
      expect(chainHideBlockedReason(id, ACTIVE)).toBeNull();
      expect(isChainHideable(id, id)).toBe(false);
      expect(chainHideBlockedReason(id, id)).toMatch(/network you are using/i);
      expect(chainHideBlockedReason(id, id)).not.toMatch(/home network/i);
    }
  });

  it('gives a reason whenever it refuses, and none when it does not', () => {
    // The UI prints this string, so "blocked" and "has a reason" must agree.
    for (const id of ['mainnet', ACTIVE, 'litecoin-mainnet', 'dogecoin-mainnet']) {
      const blocked = !isChainHideable(id, ACTIVE);
      expect(chainHideBlockedReason(id, ACTIVE) !== null).toBe(blocked);
    }
  });
});

describe('what is stored, and what comes back after a reload', () => {
  it('stores an engine or EVM target verbatim and a UTXO id in its canonical form', () => {
    for (const id of ['zec:mainnet', 'tao:mainnet', 'xmr:mainnet', 'evm:base', 'evm:avalanche']) {
      expect(canonicalHiddenChainId(id)).toBe(id);
    }
    expect(canonicalHiddenChainId('mainnet')).toBe('evrmore-mainnet');
    expect(canonicalHiddenChainId('ravencoin-mainnet')).toBe('ravencoin-mainnet');
  });

  it('a hidden Zcash, Bittensor, Monero or EVM row SURVIVES the read-back (it used to collapse to Evrmore and vanish)', () => {
    // init() normalised every stored id through networkFor(), which answers
    // Evrmore for any id it does not know; the home chain is then filtered
    // out, so the toggle read On again after every reopen.
    const stored = ['zec:mainnet', 'tao:mainnet', 'xmr:mainnet', 'evm:base', 'evm:avalanche', 'ravencoin-mainnet'];
    expect(normalizeStoredHiddenChains(stored)).toEqual(stored);
    // Round trip: what setChainHidden stores is exactly what init reads.
    expect(normalizeStoredHiddenChains(stored.map(canonicalHiddenChainId))).toEqual(stored);
  });

  it('still drops the home chain, unknown junk and duplicates on read', () => {
    expect(normalizeStoredHiddenChains(['mainnet', 'evrmore-mainnet', 'litecoin-mainnet', 'litecoin-mainnet', 42, '', 'no-such-chain'])).toEqual([
      'litecoin-mainnet',
    ]);
  });
});
