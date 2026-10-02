// The "New" chip marks only the chains added in the current release (owner,
// 2026-09-29: 1.5.0 = Monero, Zcash, Bittensor, Avalanche; Robinhood Chain joined it
// 2026-10-02). Young chains keep
// their caution notice but no longer get the chip.
import { describe, expect, it } from 'vitest';
import { describeChain } from '../../store/liveStore';
import type { EvmChainInfo } from '../../store/evmChains';
import { EVM_CHAINS } from './evm/chains';

// The registry rows as the store maps them (loadEvmChainInfos needs the EVM
// build flag; the chip only reads these fields).
const evm = EVM_CHAINS.map((c) => ({
  key: c.key,
  displayName: c.displayName,
  nativeTicker: c.nativeTicker,
  nativeDecimals: c.nativeDecimals,
  homepage: c.homepage,
  young: c.young === true,
  recentlyAdded: c.recentlyAdded === true,
})) as unknown as EvmChainInfo[];

const NEW_IN_RELEASE = ['zec:mainnet', 'tao:mainnet', 'evm:avalanche', 'evm:robinhood'];
const OLDER = [
  'mainnet', 'ravencoin-mainnet', 'bitcoin-mainnet', 'litecoin-mainnet', 'dogecoin-mainnet',
  'bitcoingold-mainnet', 'wojakcoin-mainnet', 'neoxa-mainnet', 'bitcoinblake2b-mainnet',
  'evm:base', 'evm:bsc', 'evm:ethereum', 'evm:epix',
];

describe('New chip', () => {
  it.each(NEW_IN_RELEASE)('%s is marked New', (id) => {
    expect(describeChain(id, evm)?.isNew).toBe(true);
  });
  it.each(OLDER)('%s is not marked New', (id) => {
    expect(describeChain(id, evm)?.isNew).toBe(false);
  });
});
