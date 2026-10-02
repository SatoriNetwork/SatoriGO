// The Monero case of the store's chain helpers (the Monero engine design notes
// §8, §12.1 "store tables that enumerate chains gain a Monero case"): the one
// fixed target `xmr:mainnet` is described, tickered, scoped and matched to its
// wallets by FAMILY, never by a chain name, and it never reaches the UTXO
// params. Pure helpers only; no wallet is opened.

import { describe, expect, it } from 'vitest';
import {
  assetsSupported,
  chainDisplayName,
  chainsWithWallets,
  describeChain,
  isNativeAssetId,
  nativeDecimalsFor,
  nativeTickerFor,
  stakingSupported,
  walletOnChain,
  walletsOnChain,
} from './liveStore';
import { MONERO_TARGET, type MoneroChainInfo } from './moneroChains';
import type { WalletSummary } from '../services/chain/liveWallet';

const XMR: MoneroChainInfo = {
  key: 'monero',
  displayName: 'Monero',
  nativeTicker: 'XMR',
  nativeDecimals: 12,
  homepage: 'https://getmonero.org',
  explorerTxUrl: 'https://xmrchain.net/tx/{txid}',
  nodeSets: ['main'],
  defaultNodeSet: 'main',
  releaseHeight: 3772358,
  coinType: 128,
  scheme: 'cake-exodus',
  young: false,
  recentlyAdded: true,
};

function wallet(partial: Partial<WalletSummary> & { id: string; network: string }): WalletSummary {
  return {
    name: partial.id,
    createdAt: 0,
    active: false,
    kind: 'seed',
    address: '',
    passwordless: false,
    family: 'utxo',
    ...partial,
  };
}

describe('liveStore chain helpers: Monero', () => {
  it('describeChain names the Monero row, marked New, and answers null without the engine', () => {
    const desc = describeChain(MONERO_TARGET, [], XMR);
    expect(desc).toEqual({
      id: MONERO_TARGET,
      family: 'monero',
      displayName: 'Monero',
      ticker: 'XMR',
      decimals: 12,
      homepage: 'https://getmonero.org',
      young: false,
      isNew: true,
    });
    // A build without --monero has no row: the switcher then offers nothing.
    expect(describeChain(MONERO_TARGET, [], null)).toBe(null);
    // The UTXO and EVM answers are untouched by the third argument.
    expect(describeChain('mainnet', [], XMR)?.family).toBe('utxo');
    expect(describeChain('evm:base', [], XMR)).toBe(null);
  });

  it('ticker, decimals and display name are fixed facts, answered even before init() mirrored the row', () => {
    expect(nativeTickerFor(MONERO_TARGET)).toBe('XMR');
    expect(nativeDecimalsFor(MONERO_TARGET)).toBe(12);
    expect(chainDisplayName(MONERO_TARGET)).toBe('Monero');
    expect(isNativeAssetId('XMR', MONERO_TARGET)).toBe(true);
    expect(isNativeAssetId('xmr ', MONERO_TARGET)).toBe(true);
    expect(isNativeAssetId('EVR', MONERO_TARGET)).toBe(false);
    // Never the Evrmore default that networkFor() would give an unknown id.
    expect(nativeTickerFor(MONERO_TARGET)).not.toBe('EVR');
  });

  it('Monero has no assets and no staking', () => {
    expect(assetsSupported(MONERO_TARGET)).toBe(false);
    expect(stakingSupported(MONERO_TARGET)).toBe(false);
  });

  it('walletsOnChain scopes the Monero target to the monero family only, and keeps it out of UTXO scopes', () => {
    const utxo = wallet({ id: 'u', network: 'mainnet', address: 'EVR1' });
    const evm = wallet({ id: 'e', network: 'evm', family: 'evm', address: '0x1' });
    const xmr = wallet({ id: 'x', network: MONERO_TARGET, family: 'monero', address: '43x' });
    expect(walletsOnChain([utxo, evm, xmr], MONERO_TARGET).map((w) => w.id)).toEqual(['x']);
    expect(walletsOnChain([utxo, evm, xmr], 'mainnet').map((w) => w.id)).toEqual(['u']);
    expect(walletsOnChain([utxo, evm, xmr], 'evm:base').map((w) => w.id)).toEqual(['e']);
  });

  it('chainsWithWallets enables the Monero target for a monero wallet and nothing else', () => {
    const xmr = wallet({ id: 'x', network: MONERO_TARGET, family: 'monero' });
    const set = chainsWithWallets([xmr], ['base']);
    expect(set.has(MONERO_TARGET)).toBe(true);
    expect(set.has('mainnet')).toBe(false);
    expect(set.has('evm:base')).toBe(false);
    // A UTXO wallet alone enables no Monero.
    expect(chainsWithWallets([wallet({ id: 'u', network: 'mainnet' })]).has(MONERO_TARGET)).toBe(false);
  });

  it('walletOnChain prefers the SIBLING of the active wallet ("Name (Monero)"), both ways', () => {
    const a = wallet({ id: 'a', network: 'mainnet', name: 'Savings', active: true });
    const aXmr = wallet({ id: 'ax', network: MONERO_TARGET, family: 'monero', name: 'Savings (Monero)' });
    const bXmr = wallet({ id: 'bx', network: MONERO_TARGET, family: 'monero', name: 'Other (Monero)' });
    expect(walletOnChain([bXmr, a, aXmr], MONERO_TARGET)?.id).toBe('ax');
    // From the Monero wallet back to its UTXO sibling.
    const bUtxo = wallet({ id: 'b', network: 'mainnet', name: 'Other' });
    const aXmrActive = { ...aXmr, active: true };
    expect(walletOnChain([bUtxo, { ...a, active: false }, aXmrActive], 'mainnet')?.id).toBe('a');
    // No Monero wallet at all: null, so the switcher offers Add.
    expect(walletOnChain([a, bUtxo], MONERO_TARGET)).toBe(null);
  });

  it('walletOnChain is SEED-SCOPED: "Wallet 1" with no Monero sibling gets null even when another phrase has Monero (X01/X02)', () => {
    // The verifier's case: Wallet 1 (Evrmore) active, the only Monero wallet is
    // "My XMR", a renamed sibling of a different phrase. The switcher must
    // offer Add for Wallet 1's phrase, not jump into the other one's wallet.
    const wallet1 = wallet({ id: 'w1', network: 'mainnet', name: 'Wallet 1', active: true, createdAt: 1 });
    const wallet2 = wallet({ id: 'w2', network: 'mainnet', name: 'Wallet 2', seedGroup: 'w2addr', createdAt: 2 });
    const myXmr = wallet({ id: 'x2', network: MONERO_TARGET, family: 'monero', name: 'My XMR', seedGroup: 'w2addr', createdAt: 3 });
    expect(walletOnChain([wallet1, wallet2, myXmr], MONERO_TARGET)).toBe(null);
    // Same for a UTXO chain and for an EVM account of the other phrase.
    const btc2 = wallet({ id: 'b2', network: 'bitcoin-mainnet', name: 'Wallet 2 (Bitcoin)', createdAt: 4 });
    const evm2 = wallet({ id: 'e2', network: 'evm', family: 'evm', name: 'Wallet 2 (EVM)', seedGroup: '0xw2', createdAt: 5 });
    expect(walletOnChain([wallet1, wallet2, btc2, evm2], 'bitcoin-mainnet')).toBe(null);
    expect(walletOnChain([wallet1, wallet2, btc2, evm2], 'evm:base')).toBe(null);
    // From Wallet 2 the same rows switch to its own siblings.
    const w2active = { ...wallet2, active: true };
    expect(walletOnChain([{ ...wallet1, active: false }, w2active, myXmr], MONERO_TARGET)?.id).toBe('x2');
    expect(walletOnChain([{ ...wallet1, active: false }, w2active, btc2, evm2], 'bitcoin-mainnet')?.id).toBe('b2');
    expect(walletOnChain([{ ...wallet1, active: false }, w2active, btc2, evm2], 'evm:base')?.id).toBe('e2');
  });

  it('walletOnChain never joins two DIFFERENT phrases that share a name ("Main" and "Main")', () => {
    // Verifier's SAME=1 repro: both phrases named 'Main', Monero added to the
    // second. Different seed groups must win over the equal names.
    const mainA = wallet({ id: 'a', network: 'mainnet', name: 'Main', seedGroup: 'grpA', active: true, createdAt: 1 });
    const mainB = wallet({ id: 'b', network: 'mainnet', name: 'Main', seedGroup: 'grpB', createdAt: 2 });
    const xmrB = wallet({ id: 'bx', network: MONERO_TARGET, family: 'monero', name: 'Main (Monero)', seedGroup: 'grpB', createdAt: 3 });
    // From phrase A: no Monero of its own, so Add (null), never B's wallet.
    expect(walletOnChain([mainA, mainB, xmrB], MONERO_TARGET)).toBe(null);
    // From B's Monero wallet, Evrmore goes to B's own 'Main', not A's.
    const xmrBActive = { ...xmrB, active: true };
    expect(walletOnChain([{ ...mainA, active: false }, mainB, xmrBActive], 'mainnet')?.id).toBe('b');
  });

  it('walletOnChain from a 25-word Monero import (no seed group) keeps the any-wallet rule', () => {
    const imported = wallet({ id: 'i', network: MONERO_TARGET, family: 'monero', name: 'Monero wallet', active: true, moneroKeySource: 'words' });
    const wallet1 = wallet({ id: 'w1', network: 'mainnet', name: 'Wallet 1' });
    expect(walletOnChain([imported, wallet1], 'mainnet')?.id).toBe('w1');
  });
});
