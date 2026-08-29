// The asset list's EDIT MODE, store side: the manual row order (persisted per
// wallet AND per chain) and the multi-remove that the list's "Remove N from the
// list" drives.
//
// Node env, in-memory storage, a mocked wallet service whose active wallet /
// chain the test moves around, because "per wallet and per chain" is exactly the
// thing that cannot be proven with one wallet on one chain.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  activeId: 'w1' as string | null,
  network: 'mainnet',
  family: 'utxo' as 'utxo' | 'evm',
  evmChainKey: null as string | null,
}));

vi.mock('../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    activeWalletFamily() {
      return hoisted.family;
    }
    evmChainKey() {
      return hoisted.evmChainKey;
    }
    async listWallets() {
      return [];
    }
    activeWalletId() {
      return hoisted.activeId;
    }
    network() {
      return hoisted.network;
    }
    isUnlocked() {
      return true;
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { useLiveStore } from './liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';

let storage: MemoryStorageAdapter;
const state = () => useLiveStore.getState();

beforeEach(() => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  hoisted.activeId = 'w1';
  hoisted.network = 'mainnet';
  hoisted.family = 'utxo';
  hoisted.evmChainKey = null;
  useLiveStore.setState({ assetOrder: [], pinnedAssets: [], hiddenAssets: [], assets: [] });
});

describe('setAssetOrder / loadAssetOrder', () => {
  it('persists under a key scoped to the wallet AND the chain', async () => {
    state().setAssetOrder(['BBB', 'AAA']);
    expect(state().assetOrder).toEqual(['BBB', 'AAA']);
    expect(await storage.get('assetOrder:w1:mainnet')).toEqual(['BBB', 'AAA']);
    // Nothing was written under the other wallet's or the other chain's key.
    const keys = await storage.keys();
    expect(keys.filter((k) => k.startsWith('assetOrder:'))).toEqual(['assetOrder:w1:mainnet']);
  });

  it('another wallet on the same chain keeps its OWN order', async () => {
    state().setAssetOrder(['BBB', 'AAA']);
    hoisted.activeId = 'w2';
    await state().loadAssetOrder();
    expect(state().assetOrder).toEqual([]); // w2 has never arranged anything
    state().setAssetOrder(['AAA', 'BBB']);

    hoisted.activeId = 'w1';
    await state().loadAssetOrder();
    expect(state().assetOrder).toEqual(['BBB', 'AAA']);
    hoisted.activeId = 'w2';
    await state().loadAssetOrder();
    expect(state().assetOrder).toEqual(['AAA', 'BBB']);
  });

  it('the SAME wallet on another chain keeps its own order (the token set differs)', async () => {
    hoisted.family = 'evm';
    hoisted.evmChainKey = 'base';
    state().setAssetOrder(['USDC', 'WETH']);
    expect(await storage.get('assetOrder:w1:evm:base')).toEqual(['USDC', 'WETH']);

    hoisted.evmChainKey = 'bsc';
    await state().loadAssetOrder();
    expect(state().assetOrder).toEqual([]);
    state().setAssetOrder(['USDT']);

    hoisted.evmChainKey = 'base';
    await state().loadAssetOrder();
    expect(state().assetOrder).toEqual(['USDC', 'WETH']);
  });

  it('collapses duplicates on the way in', async () => {
    state().setAssetOrder(['AAA', 'BBB', 'AAA']);
    expect(state().assetOrder).toEqual(['AAA', 'BBB']);
  });

  it('with no active wallet: empty, and nothing is written', async () => {
    hoisted.activeId = null;
    state().setAssetOrder(['AAA']);
    expect((await storage.keys()).filter((k) => k.startsWith('assetOrder:'))).toEqual([]);
    await state().loadAssetOrder();
    expect(state().assetOrder).toEqual([]);
  });

  it('a stored entry for a token that is gone is simply carried, never resurrected as a row', async () => {
    // The store keeps the entry (a token re-added later lands back in place);
    // applyManualOrder in the UI is what ignores it. Proven together here so the
    // division of labour cannot silently change.
    await storage.set('assetOrder:w1:mainnet', ['GONE', 'AAA']);
    await state().loadAssetOrder();
    expect(state().assetOrder).toEqual(['GONE', 'AAA']);
  });

  it('a corrupt stored value reads as "never arranged" rather than throwing', async () => {
    await storage.set('assetOrder:w1:mainnet', { not: 'an array' });
    await state().loadAssetOrder();
    expect(state().assetOrder).toEqual([]);
  });
});

describe('removeAssets (the list edit mode multi-remove)', () => {
  it('hides EVERY named token in one write, and unpins them', async () => {
    useLiveStore.setState({ pinnedAssets: ['AAA', 'BBB', 'CCC'], hiddenAssets: [] });
    state().removeAssets(['AAA', 'CCC']);
    expect(state().hiddenAssets).toEqual(['AAA', 'CCC']);
    expect(state().pinnedAssets).toEqual(['BBB']);
    expect(await storage.get('hiddenAssets:w1')).toEqual(['AAA', 'CCC']);
    expect(await storage.get('pinnedAssets:w1')).toEqual(['BBB']);
  });

  it('refuses a protected asset and still removes the rest of the batch', () => {
    useLiveStore.setState({ pinnedAssets: [], hiddenAssets: [] });
    // On Evrmore, EVR and SATORIEVR are protected (isRemovableAsset).
    state().removeAssets(['EVR', 'SATORIEVR', 'AAA']);
    expect(state().hiddenAssets).toEqual(['AAA']);
  });

  it('does nothing at all when every name is protected', async () => {
    useLiveStore.setState({ pinnedAssets: ['SATORIEVR'], hiddenAssets: [] });
    state().removeAssets(['EVR', 'SATORIEVR']);
    expect(state().hiddenAssets).toEqual([]);
    expect(state().pinnedAssets).toEqual(['SATORIEVR']);
    expect(await storage.get('hiddenAssets:w1')).toBeUndefined();
  });

  it('normalises case and whitespace, and de-duplicates the batch', () => {
    useLiveStore.setState({ pinnedAssets: [], hiddenAssets: [] });
    state().removeAssets([' aaa ', 'AAA', 'bbb', '']);
    expect(state().hiddenAssets).toEqual(['AAA', 'BBB']);
  });

  it('never hides a name twice', () => {
    useLiveStore.setState({ pinnedAssets: [], hiddenAssets: ['AAA'] });
    state().removeAssets(['AAA', 'BBB']);
    expect(state().hiddenAssets).toEqual(['AAA', 'BBB']);
  });

  it('removeAsset is exactly removeAssets of one name (ONE removal path)', () => {
    useLiveStore.setState({ pinnedAssets: ['AAA'], hiddenAssets: [] });
    state().removeAsset('AAA');
    expect(state().hiddenAssets).toEqual(['AAA']);
    expect(state().pinnedAssets).toEqual([]);
  });

  it('on an EVM chain it forgets the tokens instead of hiding them by symbol', async () => {
    hoisted.family = 'evm';
    hoisted.evmChainKey = 'base';
    useLiveStore.setState({
      evmTokens: {
        tracked: [
          { address: '0x1', symbol: 'WETH', decimals: 18 },
          { address: '0x2', symbol: 'JUNK', decimals: 18 },
        ],
        discovered: [{ address: '0x3', symbol: 'SPAM', decimals: 18 }],
      },
      assets: [
        { name: 'ETH', amountBase: 1n, scale: 18, decimals: 18, isNative: true },
        { name: 'WETH', amountBase: 1n, scale: 18, decimals: 18, isNative: false },
        { name: 'SPAM', amountBase: 1n, scale: 18, decimals: 18, isNative: false },
      ],
    });
    state().removeAssets(['WETH', 'SPAM']);
    expect(state().evmTokens.tracked.map((t) => t.symbol)).toEqual(['JUNK']);
    expect(state().evmTokens.discovered).toEqual([]);
    expect(state().assets.map((a) => a.name)).toEqual(['ETH']);
    expect(await storage.get('evmTokens:w1:base')).toEqual([
      { address: '0x2', symbol: 'JUNK', decimals: 18 },
    ]);
  });
});
