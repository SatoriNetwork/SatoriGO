// Hiding networks from the switcher and the wallet-creation picker.
//
// Hiding is PRESENTATION ONLY: nothing is deleted and no wallet is touched. The
// rules worth testing are the two chains that must never disappear, because
// each one produces a state the user cannot get out of from inside the app.

import { describe, expect, it } from 'vitest';
import { chainHideBlockedReason, isChainHideable } from './liveStore';

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

  it('gives a reason whenever it refuses, and none when it does not', () => {
    // The UI prints this string, so "blocked" and "has a reason" must agree.
    for (const id of ['mainnet', ACTIVE, 'litecoin-mainnet', 'dogecoin-mainnet']) {
      const blocked = !isChainHideable(id, ACTIVE);
      expect(chainHideBlockedReason(id, ACTIVE) !== null).toBe(blocked);
    }
  });
});
