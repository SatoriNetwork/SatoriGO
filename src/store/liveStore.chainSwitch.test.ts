// MetaMask-style network switcher — STORE side.
//
// The lightweight multi-chain model: one wallet entry per chain, the header
// switches between them, and a chain with no wallet yet is "enabled" by deriving
// one FROM THE SAME SECRET so the recovery phrase is never retyped. These tests
// pin the four pieces the UI depends on:
//   chainsWithWallets / walletOnChain — which chains are enabled + deterministic
//     selection of the wallet to land on,
//   switchChain — swaps the active wallet, no-ops when already there,
//   enableChain — reuses the ACTIVE wallet's secret (proved by deriving the
//     expected address independently), refuses a wrong password and creates
//     nothing when it does,
//   chainsShareDerivation — the privacy fact behind the mandatory warning.
//
// The module-level LiveWalletService singleton owns a REAL Electrum client, so we
// stub a throwing WebSocket BEFORE importing the store (dynamic import) — the
// singleton then captures the fake and every fire-and-forget refresh fails closed
// (offline) instead of opening a socket. Storage is an in-memory adapter.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryStorageAdapter,
  setStorageForTests,
  type KeyValueStorage,
} from '../services/storage';
import {
  BITCOINGOLD_MAINNET,
  EVRMORE_MAINNET,
  LITECOIN_MAINNET,
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  chainsShareDerivation,
} from '../services/chain/chainParams';
import {
  deriveAddress,
  mnemonicToSeed,
  parsePrivateKey,
  privateKeyToDerived,
} from '../services/chain/keys';
import type { WalletSummary } from '../services/chain/liveWallet';

// A WebSocket that refuses to connect: `new` throws, so the client's connect()
// fails fast and every watch-only read resolves offline (no network in tests).
class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

// BIP39 test vectors (no passphrase) — fixed input so every derived address
// below is checkable against an independent deriveAddress() call.
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_MNEMONIC_2 =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
// Raw 32-byte hex key -> single-address 'pk' wallet (how Satori wallets are made).
const HEX_KEY = '0'.repeat(63) + '1';

const PW = 'password123';

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
let storage: KeyValueStorage;

interface StoredWallets {
  wallets: { id: string; name: string; network: string; address?: string }[];
  activeId: string;
}

const state = () => mod.useLiveStore.getState();

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  mod = await import('./liveStore');
});

beforeEach(async () => {
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  await state().resetLiveWallet();
});

afterEach(() => {
  state().stopAutoRefresh();
});

// --- pure selectors ---------------------------------------------------------

function summary(over: Partial<WalletSummary> & { id: string; network: string }): WalletSummary {
  return {
    name: over.id,
    createdAt: 0,
    active: false,
    kind: 'seed',
    address: '',
    passwordless: false,
    ...over,
  };
}

describe('chainsWithWallets', () => {
  it('is empty with no wallets', () => {
    expect(mod.chainsWithWallets([])).toEqual(new Set());
  });

  it('an Evrmore wallet enables BOTH ids that name Evrmore mainnet', () => {
    // Stored entries carry the legacy id 'mainnet'; the UI chain list uses the
    // same LiveNetworkId, while other code uses the canonical ChainId. Both must
    // report the chain as enabled.
    const set = mod.chainsWithWallets([summary({ id: 'a', network: 'mainnet' })]);
    expect(set.has('mainnet')).toBe(true);
    expect(set.has('evrmore-mainnet')).toBe(true);
    expect(set.has('ravencoin-mainnet')).toBe(false);
  });

  it('a Ravencoin wallet must NOT make Evrmore look enabled', () => {
    // Ravencoin's ELECTRUM ROLE id is also 'mainnet'; only the canonical chain id
    // may leak into the set, or the switcher would hide the Evrmore "enable" CTA.
    const set = mod.chainsWithWallets([summary({ id: 'r', network: 'ravencoin-mainnet' })]);
    expect(set.has('ravencoin-mainnet')).toBe(true);
    expect(set.has('mainnet')).toBe(false);
    expect(set.has('evrmore-mainnet')).toBe(false);
  });

  it('reports every chain the user holds, and only those', () => {
    const set = mod.chainsWithWallets([
      summary({ id: 'a', network: 'mainnet' }),
      summary({ id: 'b', network: 'ravencoin-mainnet' }),
      summary({ id: 'c', network: 'litecoin-mainnet' }),
    ]);
    expect(set.has('mainnet')).toBe(true);
    expect(set.has('ravencoin-mainnet')).toBe(true);
    expect(set.has('litecoin-mainnet')).toBe(true);
    expect(set.has('bitcoingold-mainnet')).toBe(false);
    expect(set.has('wojakcoin-mainnet')).toBe(false);
  });

  it('a WojakCoin wallet is reported enabled, and only WojakCoin', () => {
    const set = mod.chainsWithWallets([summary({ id: 'w', network: 'wojakcoin-mainnet' })]);
    expect(set.has('wojakcoin-mainnet')).toBe(true);
    expect(set.has('mainnet')).toBe(false);
    expect(set.has('litecoin-mainnet')).toBe(false);
  });

  it('testnet is its own chain (never conflated with mainnet)', () => {
    const set = mod.chainsWithWallets([summary({ id: 't', network: 'testnet' })]);
    expect(set.has('testnet')).toBe(true);
    expect(set.has('evrmore-testnet')).toBe(true);
    expect(set.has('mainnet')).toBe(false);
  });
});

describe('walletOnChain', () => {
  it('returns null when the chain has no wallet', () => {
    expect(mod.walletOnChain([summary({ id: 'a', network: 'mainnet' })], 'litecoin-mainnet')).toBe(
      null,
    );
    expect(mod.walletOnChain([], 'mainnet')).toBe(null);
  });

  it('returns the only wallet on that chain', () => {
    const wallets = [
      summary({ id: 'a', network: 'mainnet', active: true }),
      summary({ id: 'r', network: 'ravencoin-mainnet' }),
    ];
    expect(mod.walletOnChain(wallets, 'ravencoin-mainnet')?.id).toBe('r');
  });

  it('prefers the ACTIVE wallet sibling (same base name) over the first match', () => {
    const wallets = [
      summary({ id: 'e1', network: 'mainnet', name: 'Savings', active: true }),
      summary({ id: 'r1', network: 'ravencoin-mainnet', name: 'Trading (Ravencoin)' }),
      summary({ id: 'r2', network: 'ravencoin-mainnet', name: 'Savings (Ravencoin)' }),
    ];
    expect(mod.walletOnChain(wallets, 'ravencoin-mainnet')?.id).toBe('r2');
  });

  it('strips the ACTIVE wallet OWN chain tag before matching siblings', () => {
    // Active is itself a derived sibling ("Savings (Ravencoin)"); hopping on to a
    // third chain must still recognise "Savings (Litecoin)" as the same family.
    const wallets = [
      summary({ id: 'l1', network: 'litecoin-mainnet', name: 'Other (Litecoin)' }),
      summary({ id: 'l2', network: 'litecoin-mainnet', name: 'Savings (Litecoin)' }),
      summary({ id: 'r1', network: 'ravencoin-mainnet', name: 'Savings (Ravencoin)', active: true }),
    ];
    expect(mod.walletOnChain(wallets, 'litecoin-mainnet')?.id).toBe('l2');
  });

  it('falls back to the FIRST wallet on the chain when no sibling matches', () => {
    const wallets = [
      summary({ id: 'e1', network: 'mainnet', name: 'Nothing alike', active: true }),
      summary({ id: 'r1', network: 'ravencoin-mainnet', name: 'Alpha' }),
      summary({ id: 'r2', network: 'ravencoin-mainnet', name: 'Beta' }),
    ];
    expect(mod.walletOnChain(wallets, 'ravencoin-mainnet')?.id).toBe('r1');
    // ...and "first" means first in the given order — no hidden sort.
    const reversed = [wallets[0], wallets[2], wallets[1]];
    expect(mod.walletOnChain(reversed, 'ravencoin-mainnet')?.id).toBe('r2');
  });

  it('is deterministic: repeated calls on identical input agree', () => {
    const wallets = [
      summary({ id: 'e1', network: 'mainnet', name: 'Savings', active: true }),
      summary({ id: 'r1', network: 'ravencoin-mainnet', name: 'Savings (Ravencoin)' }),
      summary({ id: 'r2', network: 'ravencoin-mainnet', name: 'Savings (Ravencoin)' }),
    ];
    const picks = [0, 1, 2, 3].map(() => mod.walletOnChain(wallets, 'ravencoin-mainnet')?.id);
    expect(new Set(picks)).toEqual(new Set(['r1']));
  });

  it('works with no active wallet in the list at all', () => {
    const wallets = [summary({ id: 'r1', network: 'ravencoin-mainnet', name: 'Solo' })];
    expect(mod.walletOnChain(wallets, 'ravencoin-mainnet')?.id).toBe('r1');
  });
});

// --- switchChain ------------------------------------------------------------

describe('switchChain', () => {
  it('switches the active wallet to the one on the requested chain', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();
    const evrId = state().activeWalletId;
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main (Ravencoin)', 'ravencoin-mainnet');
    await state().loadWallets();
    expect(mod.activeChainId()).toBe('ravencoin-mainnet');

    await state().switchChain('mainnet');

    expect(state().activeWalletId).toBe(evrId);
    expect(mod.activeChainId()).toBe('mainnet');
    // Switching a wallet always lands LOCKED (the service clears the secret).
    expect(state().phase).toBe('locked');
  });

  it('is a NO-OP when that chain is already active', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();
    const before = { id: state().activeWalletId, phase: state().phase, address: state().address };

    await state().switchChain('mainnet');
    // ...including via the canonical alias of the very same chain.
    await state().switchChain('evrmore-mainnet');

    expect(state().activeWalletId).toBe(before.id);
    // A real switch would have wiped these; an unchanged unlocked wallet proves
    // nothing happened.
    expect(state().phase).toBe(before.phase);
    expect(state().address).toBe(before.address);
  });

  it('is a NO-OP for a chain with no wallet yet (enableChain handles that)', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();
    const before = state().activeWalletId;

    await state().switchChain('litecoin-mainnet');

    expect(state().activeWalletId).toBe(before);
    expect(mod.activeChainId()).toBe('mainnet');
    expect(state().wallets).toHaveLength(1);
  });

  it('lands on the ACTIVE wallet sibling when the chain holds several wallets', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Alpha', 'mainnet');
    await state().importWallet(VECTOR_MNEMONIC_2, PW, 'Beta', 'mainnet');
    await state().loadWallets();
    const betaId = state().activeWalletId;
    // Derive Beta's Ravencoin sibling, then hop back to Evrmore: the sibling
    // rule must return us to Beta, not to the first Evrmore wallet (Alpha).
    expect((await state().enableChain('ravencoin-mainnet', PW)).ok).toBe(true);

    await state().switchChain('mainnet');

    expect(state().activeWalletId).toBe(betaId);
  });
});

// --- enableChain ------------------------------------------------------------

describe('enableChain', () => {
  it('derives the new chain wallet FROM THE ACTIVE SEED (not a fresh one)', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();

    const res = await state().enableChain('litecoin-mainnet', PW);
    expect(res).toEqual({ ok: true });

    const wallets = state().wallets;
    expect(wallets).toHaveLength(2);
    const ltc = wallets.find((w) => w.network === 'litecoin-mainnet')!;
    // THE PROOF: the address equals what deriveAddress gives for the SAME
    // mnemonic on the TARGET chain's params. A freshly generated seed could not
    // produce this value.
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    expect(ltc.address).toBe(deriveAddress(seed, LITECOIN_MAINNET, 0, 0, 0).address);
    expect(ltc.address.startsWith('ltc1')).toBe(true); // BIP84/native segwit path
    // ...and the same phrase is what the new wallet reveals.
    expect(await state().revealMnemonic(PW)).toBe(VECTOR_MNEMONIC);

    // The derived wallet becomes the active one, on the target chain, named after
    // its source wallet.
    expect(ltc.active).toBe(true);
    expect(ltc.name).toBe('Main (Litecoin)');
    expect(ltc.kind).toBe('seed');
    expect(mod.activeChainId()).toBe('litecoin-mainnet');
    expect(state().address).toBe(ltc.address);
    expect(state().phase).toBe('ready');
  });

  it('reuses the seed across the LINKED pair too (same key, different version byte)', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();
    const evr = state().wallets[0].address;

    expect((await state().enableChain('ravencoin-mainnet', PW)).ok).toBe(true);

    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    const rvn = state().wallets.find((w) => w.network === 'ravencoin-mainnet')!;
    expect(rvn.address).toBe(deriveAddress(seed, RAVENCOIN_MAINNET, 0, 0, 0).address);
    expect(evr.startsWith('E')).toBe(true);
    expect(rvn.address.startsWith('R')).toBe(true);
    // Same hash160, different version byte — precisely what the privacy sentence
    // chainsShareDerivation gates on is warning the user about.
    expect(chainsShareDerivation('mainnet', 'ravencoin-mainnet')).toBe(true);
  });

  it('rejects a WRONG password with ok:false and creates NOTHING', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();

    const res = await state().enableChain('ravencoin-mainnet', 'not-my-password');

    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(state().wallets).toHaveLength(1);
    // Nothing persisted either — not just nothing in memory.
    const stored = (await storage.get<StoredWallets>('liveWallets'))!;
    expect(stored.wallets).toHaveLength(1);
    expect(stored.wallets[0].network).toBe('mainnet');
    // The active wallet/chain is untouched.
    expect(mod.activeChainId()).toBe('mainnet');
    expect(state().phase).toBe('ready');
  });

  it('works for a PASSWORDLESS wallet with the empty password, staying passwordless', async () => {
    await state().importWallet(VECTOR_MNEMONIC, '', 'Free', 'mainnet');
    await state().loadWallets();
    expect(state().wallets[0].passwordless).toBe(true);

    const res = await state().enableChain('bitcoingold-mainnet', '');
    expect(res).toEqual({ ok: true });

    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    const btgs = state().wallets.find((w) => w.network === 'bitcoingold-mainnet')!;
    expect(btgs.address).toBe(deriveAddress(seed, BITCOINGOLD_MAINNET, 0, 0, 0).address);
    // The derived sibling inherits "no password" — it must not silently become
    // password-protected with an empty passphrase the user can never type.
    expect(btgs.passwordless).toBe(true);
    // Assert against the params, not a literal: the display name is owner-facing
    // copy that can be renamed, and pinning it here just breaks on the rename.
    expect(btgs.name).toBe(`Free (${BITCOINGOLD_MAINNET.displayName})`);
  });

  it('derives a WojakCoin sibling with a LEGACY (non-bech32) address, unlike BTGS/LTC', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();

    const res = await state().enableChain('wojakcoin-mainnet', PW);
    expect(res).toEqual({ ok: true });

    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    const wjk = state().wallets.find((w) => w.network === 'wojakcoin-mainnet')!;
    expect(wjk.address).toBe(deriveAddress(seed, WOJAKCOIN_MAINNET, 0, 0, 0).address);
    // WojakCoin never activates segwit (SegwitHeight = INT_MAX): the derived
    // receive address must be legacy 'W...', NEVER a 'wj1...' bech32 address.
    expect(wjk.address.startsWith('W')).toBe(true);
    expect(wjk.address.startsWith('wj1')).toBe(false);
    expect(wjk.name).toBe('Main (WojakCoin)');
    expect(mod.activeChainId()).toBe('wojakcoin-mainnet');
  });

  it("re-imports a kind:'pk' wallet's PRIVATE KEY (it has no recovery phrase)", async () => {
    await state().importPrivateKeyWallet(HEX_KEY, PW, 'Satori key', 'mainnet');
    await state().loadWallets();
    expect(state().wallets[0].kind).toBe('pk');

    const res = await state().enableChain('ravencoin-mainnet', PW);
    expect(res).toEqual({ ok: true });

    const rvn = state().wallets.find((w) => w.network === 'ravencoin-mainnet')!;
    expect(rvn.kind).toBe('pk');
    // THE PROOF for the pk path: the SAME private key re-encoded under the target
    // chain's params (the WIF version byte differs, the key does not).
    const { privateKey, compressed } = parsePrivateKey(HEX_KEY);
    expect(rvn.address).toBe(privateKeyToDerived(privateKey, RAVENCOIN_MAINNET, compressed).address);
    expect(state().wallets[0].address).toBe(
      privateKeyToDerived(privateKey, EVRMORE_MAINNET, compressed).address,
    );
    expect(rvn.name).toBe('Satori key (Ravencoin)');
    // A pk wallet still has no recovery phrase after the hop.
    expect(await state().revealMnemonic(PW)).toBe(null);
  });

  it("rejects a wrong password on a kind:'pk' wallet too, creating nothing", async () => {
    await state().importPrivateKeyWallet(HEX_KEY, PW, 'Satori key', 'mainnet');
    await state().loadWallets();

    const res = await state().enableChain('ravencoin-mainnet', 'wrong');

    expect(res.ok).toBe(false);
    expect(state().wallets).toHaveLength(1);
    const stored = (await storage.get<StoredWallets>('liveWallets'))!;
    expect(stored.wallets).toHaveLength(1);
  });

  it('refuses to duplicate a chain that is already enabled', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'Main', 'mainnet');
    await state().loadWallets();

    // Same chain as the active wallet...
    const same = await state().enableChain('mainnet', PW);
    expect(same.ok).toBe(false);
    expect(same.error).toBeTruthy();

    // ...and a chain enabled by some OTHER wallet.
    expect((await state().enableChain('ravencoin-mainnet', PW)).ok).toBe(true);
    const again = await state().enableChain('ravencoin-mainnet', PW);
    expect(again.ok).toBe(false);
    expect(state().wallets).toHaveLength(2);
  });

  it('fails cleanly when there is no wallet at all', async () => {
    const res = await state().enableChain('ravencoin-mainnet', PW);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(state().wallets).toHaveLength(0);
  });
});

// --- chainsShareDerivation --------------------------------------------------

describe('chainsShareDerivation', () => {
  // Every distinct chain (aliases excluded — they are the same chain).
  const CHAINS = [
    'mainnet',
    'ravencoin-mainnet',
    'bitcoingold-mainnet',
    'litecoin-mainnet',
    'wojakcoin-mainnet',
    'evrmore-testnet',
  ] as const;
  const LINKED = new Set(['mainnet|ravencoin-mainnet', 'ravencoin-mainnet|mainnet']);

  it('is TRUE for Evrmore <-> Ravencoin (shared coin type 175 + shared bip32 bytes)', () => {
    expect(chainsShareDerivation('mainnet', 'ravencoin-mainnet')).toBe(true);
    expect(chainsShareDerivation('ravencoin-mainnet', 'mainnet')).toBe(true);
    // The canonical id names the same chain as the legacy 'mainnet' alias.
    expect(chainsShareDerivation('evrmore-mainnet', 'ravencoin-mainnet')).toBe(true);
  });

  it('is FALSE for every other pair of distinct chains', () => {
    for (const a of CHAINS) {
      for (const b of CHAINS) {
        if (a === b) continue;
        expect({ a, b, linked: chainsShareDerivation(a, b) }).toEqual({
          a,
          b,
          linked: LINKED.has(`${a}|${b}`),
        });
      }
    }
  });

  it('is reflexive — a chain always shares derivation with itself', () => {
    for (const c of CHAINS) expect(chainsShareDerivation(c, c)).toBe(true);
  });

  it('is computed from the params: equal bip32 bytes alone are NOT enough', () => {
    // Litecoin keeps the STANDARD Bitcoin bip32 version bytes, identical to
    // Evrmore's — a bip32-only implementation would wrongly report them linked.
    // The differing coin type (2 vs 175) is what makes them independent.
    expect(LITECOIN_MAINNET.bip32).toEqual(EVRMORE_MAINNET.bip32);
    expect(LITECOIN_MAINNET.coinType).not.toBe(EVRMORE_MAINNET.coinType);
    expect(chainsShareDerivation('litecoin-mainnet', 'mainnet')).toBe(false);
  });

  it('is computed from the params: equal coin type alone is NOT enough either', () => {
    // The true pair matches on BOTH axes; that is the whole predicate.
    expect(RAVENCOIN_MAINNET.coinType).toBe(EVRMORE_MAINNET.coinType);
    expect(RAVENCOIN_MAINNET.bip32).toEqual(EVRMORE_MAINNET.bip32);
    // Bitcoin Gold differs on both (18888, non-standard 0x0488B21F/0x0488ADE5).
    expect(BITCOINGOLD_MAINNET.coinType).not.toBe(EVRMORE_MAINNET.coinType);
    expect(BITCOINGOLD_MAINNET.bip32).not.toEqual(EVRMORE_MAINNET.bip32);
    expect(chainsShareDerivation('bitcoingold-mainnet', 'mainnet')).toBe(false);
    expect(chainsShareDerivation('bitcoingold-mainnet', 'litecoin-mainnet')).toBe(false);
  });

  it('WojakCoin has its OWN coin type (20760, registered SLIP-44) and STANDARD bip32 bytes', () => {
    // WojakCoin keeps the standard bip32 bytes (like Litecoin, unlike BTGS), but a
    // distinct coin type is enough on its own to make it unlinked from everything.
    expect(WOJAKCOIN_MAINNET.bip32).toEqual(EVRMORE_MAINNET.bip32);
    expect(WOJAKCOIN_MAINNET.coinType).not.toBe(EVRMORE_MAINNET.coinType);
    expect(WOJAKCOIN_MAINNET.coinType).not.toBe(LITECOIN_MAINNET.coinType);
    expect(chainsShareDerivation('wojakcoin-mainnet', 'mainnet')).toBe(false);
    expect(chainsShareDerivation('wojakcoin-mainnet', 'litecoin-mainnet')).toBe(false);
    expect(chainsShareDerivation('wojakcoin-mainnet', 'ravencoin-mainnet')).toBe(false);
    expect(chainsShareDerivation('wojakcoin-mainnet', 'bitcoingold-mainnet')).toBe(false);
  });
});
