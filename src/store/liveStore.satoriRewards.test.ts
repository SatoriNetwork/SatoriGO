// Satori reward claims through the real store and the real EVM modules, against
// a fake Base node and a fake central server. No network.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

vi.mock('../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chain/engine')>();
  return { ...actual, loadEvmModules: async () => await import('../services/chain/evm') };
});

import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import {
  SATORI_REWARD_CONTRACTS,
  decodeSignedTx,
  deriveEvrmoreKeyAsEvm,
  publicKeyToEvmAddress,
  recoverTxPublicKey,
} from '../services/chain/evm';
import { mnemonicToSeed } from '../services/chain/keys';
import { satoriRowIsOfficial } from './satoriRewards';
import { resetEvmProvidersForTests } from './evmBalances';
import { resetEvmIndexersForTests } from './evmHistory';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const PW = 'password123';
const ONE = 10n ** 18n;
const NODE = `0x${'ab'.repeat(32)}`;

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, '0');

interface Req { id: number; method: string; params: unknown[] }

/** What the fake chain and server answer; each test changes what it is about. */
let world: {
  ethBase: bigint;
  lifetime: bigint | null;
  minted: bigint;
  airdropClaimable: bigint;
  prediction: bigint;
  predictionComplete: boolean;
  lensFails: boolean;
  merkleAddress: string;
};
let sentRaw: string[];
/** The same seed's Evrmore key on Base: its own balances and entitlements. */
let evr: { eth: bigint; satori: bigint; lifetime: bigint | null; minted: bigint; airdrop: bigint };
let EVR_ADDRESS = '';
let lockRound = 0n;
let evrLockRound = 0n;
const isEvr = (text: string) => text.toLowerCase().includes(EVR_ADDRESS.slice(2).toLowerCase());

function answer(req: Req): Record<string, unknown> {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
  const err = (message: string, code = 3) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
  switch (req.method) {
    case 'eth_chainId':
      return ok('0x2105');
    case 'eth_blockNumber':
      return ok('0x100');
    case 'eth_getBlockByNumber':
      return ok({ timestamp: '0x66f00000' });
    case 'eth_getBalance':
      return ok(`0x${(isEvr(String(req.params[0])) ? evr.eth : world.ethBase).toString(16)}`);
    case 'eth_estimateGas':
      return ok('0x17940');
    case 'eth_feeHistory':
      return ok({
        baseFeePerGas: Array.from({ length: 6 }, () => '0x4c4b40'),
        reward: Array.from({ length: 5 }, () => ['0xf4240', '0x10c8e0', '0x2dc6c0']),
      });
    case 'eth_gasPrice':
      return ok('0x5b8d80');
    case 'eth_getTransactionCount':
      return ok('0x7');
    case 'eth_sendRawTransaction':
      sentRaw.push(req.params[0] as string);
      return ok(`0x${bytesToHex(keccak_256(hexToBytes((req.params[0] as string).slice(2))))}`);
    case 'eth_call': {
      const { to = '', data = '' } = req.params[0] as { to?: string; data?: string };
      if (to.toLowerCase() === '0x420000000000000000000000000000000000000f') return ok(`0x${word(0x2f0d)}`);
      if (data.startsWith('0x481d7b10')) return ok(`0x${word(isEvr(data) ? evrLockRound : lockRound)}`);
      if (isEvr(data)) {
        if (data.startsWith('0xe395674e')) return ok(`0x${word(evr.minted)}`);
        if (data.startsWith('0xdef2a001') || data.startsWith('0x77d58e32')) return ok(`0x${word(evr.airdrop)}`);
        if (data.startsWith('0xd1b6dd30')) return ok(`0x${word(0)}`);
        if (data.startsWith('0x60d8fdd8')) return ok(`0x${word(0)}${word(1)}`);
        if (data.startsWith('0x70a08231')) return ok(`0x${word(evr.satori)}`);
      }
      if (data.startsWith('0xe395674e')) return ok(`0x${word(world.minted)}`);
      if (data.startsWith('0xdef2a001')) return ok(`0x${word(world.airdropClaimable * 2n)}`);
      if (data.startsWith('0xd1b6dd30')) return ok(`0x${word(world.airdropClaimable)}`);
      if (data.startsWith('0x77d58e32')) return ok(`0x${word(world.airdropClaimable)}`);
      if (data.startsWith('0x60d8fdd8')) {
        return world.lensFails
          ? err('execution reverted')
          : ok(`0x${word(world.prediction)}${word(world.predictionComplete ? 1 : 0)}`);
      }
      if (data.startsWith('0x70a08231')) return ok(`0x${word(0)}`);
      if (data.startsWith('0x313ce567')) return ok(`0x${word(18)}`);
      return err('execution reverted');
    }
    default:
      return err('method not found', -32601);
  }
}

const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const u = String(url);
  if (u.includes('/api/v1/base/config')) {
    return new Response(
      JSON.stringify({ ...SATORI_REWARD_CONTRACTS, merkle: world.merkleAddress }),
      { status: 200 },
    );
  }
  if (u.includes('/api/v1/merkle/proof/')) {
    if (isEvr(u)) {
      return evr.lifetime === null
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ amountWei: evr.lifetime.toString(), proof: [NODE] }), { status: 200 });
    }
    return world.lifetime === null
      ? new Response('{"detail":"not in the current drop"}', { status: 404 })
      : new Response(JSON.stringify({ amountWei: world.lifetime.toString(), proof: [NODE] }), { status: 200 });
  }
  if (init?.method !== 'POST') return new Response('{}', { status: 503 });
  const body = JSON.parse(String(init.body)) as Req | Req[];
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { status: 200 });
};

type LiveStoreModule = typeof import('./liveStore');
let mod: LiveStoreModule;
const state = () => mod.useLiveStore.getState();
const rewards = () => state().satoriRewards;

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  mod = await import('./liveStore');
});

beforeEach(async () => {
  EVR_ADDRESS = deriveEvrmoreKeyAsEvm(await mnemonicToSeed(MNEMONIC, ''), 0).address;
  lockRound = 0n;
  evrLockRound = 0n;
  evr = { eth: ONE, satori: 0n, lifetime: null, minted: 0n, airdrop: 0n };
  world = {
    ethBase: ONE,
    lifetime: 5n * ONE,
    minted: 2n * ONE,
    airdropClaimable: 7n * ONE,
    prediction: 0n,
    predictionComplete: true,
    lensFails: false,
    merkleAddress: SATORI_REWARD_CONTRACTS.merkle,
  };
  sentRaw = [];
  setStorageForTests(new MemoryStorageAdapter());
  resetEvmProvidersForTests();
  resetEvmIndexersForTests();
  vi.stubGlobal('fetch', fakeFetch);
  await state().resetLiveWallet();
  await state().init();
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  await state().importWallet(MNEMONIC, PW, 'EVM', 'evm:base');
  for (let i = 0; i < 100 && state().evm.activeChainKey !== 'base'; i++) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 100 && state().assets.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
});

afterEach(() => {
  state().stopAutoRefresh();
  vi.unstubAllGlobals();
});

describe('Satori reward claims on Base', () => {
  it('reads what each contract reports', async () => {
    await state().refreshSatoriRewards();
    const snap = rewards().snapshot!;
    expect(snap.address).toBe(ME);
    expect(snap.rewards).toEqual({ lifetimeBase: 5n * ONE, claimedBase: 2n * ONE, claimableBase: 3n * ONE });
    expect(snap.airdrop?.claimableBase).toBe(7n * ONE);
    expect(snap.prediction).toEqual({ claimableBase: 0n, complete: true });
    expect(snap.issue).toBe(null);
  });

  it('claims the Merkle delta: the signed bytes carry the lifetime and the proof, to the pinned contract', async () => {
    const plan = await state().planSatoriClaim('rewards');
    expect(plan?.amountBase).toBe(3n * ONE);
    state().arm(true);
    const { txid } = await state().confirmSatoriClaim();

    expect(sentRaw).toHaveLength(1);
    const { tx } = decodeSignedTx(hexToBytes(sentRaw[0].slice(2)));
    expect(tx.to.toLowerCase()).toBe(SATORI_REWARD_CONTRACTS.merkle.toLowerCase());
    expect(tx.value).toBe(0n);
    expect(`0x${bytesToHex(tx.data)}`).toBe(`0x958944f1${word(5n * ONE)}${word(64)}${word(1)}${NODE.slice(2)}`);

    // Shown at once as SATORI coming in, and the plan is spent.
    const row = state().txs.find((t) => t.txid === txid)!;
    expect(row).toMatchObject({ asset: 'SATORI', direction: 'in', status: 'pending', amount: 3, satoriSource: 'rewards' });
    expect(rewards().plan).toBe(null);
  });

  it('claims the airdrop with no arguments', async () => {
    await state().planSatoriClaim('airdrop');
    state().arm(true);
    await state().confirmSatoriClaim();
    const { tx } = decodeSignedTx(hexToBytes(sentRaw[0].slice(2)));
    expect(tx.to.toLowerCase()).toBe(SATORI_REWARD_CONTRACTS.airdrop.toLowerCase());
    expect(`0x${bytesToHex(tx.data)}`).toBe('0x5b88349d');
  });

  it('claims prediction rewards through the hub, and says when the amount is a lower bound', async () => {
    world.prediction = ONE;
    world.predictionComplete = false;
    const plan = await state().planSatoriClaim('prediction');
    expect(plan?.to.toLowerCase()).toBe(SATORI_REWARD_CONTRACTS.hub.toLowerCase());
    expect(plan?.amountIsLowerBound).toBe(true);
    expect(`0x${bytesToHex(plan!.data)}`).toBe('0x4e71d92d');
  });

  it('nothing is sent until the gate is armed', async () => {
    await state().planSatoriClaim('airdrop');
    state().arm(false);
    await expect(state().confirmSatoriClaim()).rejects.toThrow(/armed/);
    expect(sentRaw).toHaveLength(0);
  });

  it('with no ETH it says so and builds no plan', async () => {
    world.ethBase = 0n;
    await state().refresh({ silent: true });
    expect(state().assets.find((a) => a.isNative)?.amountBase).toBe(0n);
    expect(await state().planSatoriClaim('airdrop')).toBe(null);
    expect(rewards().error).toMatch(/no ETH on Base to pay the network fee/);
  });

  it('with too little ETH the plan names the shortfall', async () => {
    world.ethBase = 1n;
    await state().refresh({ silent: true });
    const plan = await state().planSatoriClaim('airdrop');
    expect(plan?.shortfall).toMatch(/Not enough ETH/);
  });

  it('refuses when there is nothing to claim', async () => {
    world.minted = 5n * ONE;
    expect(await state().planSatoriClaim('rewards')).toBe(null);
    expect(rewards().error).toMatch(/already up to date/);
    world.lifetime = null;
    expect(await state().planSatoriClaim('rewards')).toBe(null);
    expect(rewards().error).toMatch(/not in the current drop/);
    world.airdropClaimable = 0n;
    expect(await state().planSatoriClaim('airdrop')).toBe(null);
    expect(rewards().error).toMatch(/Nothing to claim from the airdrop/);
  });

  it('refuses to claim when the server names other contracts than the pins', async () => {
    world.merkleAddress = '0x3535353535353535353535353535353535353535';
    await state().refreshSatoriRewards();
    expect(rewards().snapshot?.issue).toMatch(/moved its reward contracts/);
    expect(await state().planSatoriClaim('airdrop')).toBe(null);
    expect(rewards().error).toMatch(/moved its reward contracts/);
  });

  it('a read that fails is unknown, never zero', async () => {
    world.lensFails = true;
    await state().refreshSatoriRewards();
    expect(rewards().snapshot?.prediction).toBe(null);
    expect(rewards().snapshot?.issue).toMatch(/prediction rewards could not be read/);
    expect(rewards().snapshot?.airdrop?.claimableBase).toBe(7n * ONE);
  });

  it('sums what is waiting, for the account it was read for only', async () => {
    const { pendingSatoriRewards } = await import('./satoriRewards');
    await state().refreshSatoriRewards();
    const pending = pendingSatoriRewards(rewards().snapshot, ME)!;
    expect(pending.totalBase).toBe(10n * ONE);
    expect(pending.parts.map((part) => part.kind)).toEqual(['rewards', 'airdrop']);
    expect(pending.isLowerBound).toBe(false);
    expect(pendingSatoriRewards(rewards().snapshot, '0x3535353535353535353535353535353535353535')).toBe(null);
    expect(pendingSatoriRewards(null, ME)).toBe(null);
  });

  it('with nothing waiting there is nothing to show, and an incomplete Lens read is a lower bound', async () => {
    const { pendingSatoriRewards } = await import('./satoriRewards');
    world.lifetime = null;
    world.airdropClaimable = 0n;
    await state().refreshSatoriRewards();
    expect(pendingSatoriRewards(rewards().snapshot, ME)).toBe(null);
    world.prediction = ONE;
    world.predictionComplete = false;
    await state().refreshSatoriRewards();
    expect(pendingSatoriRewards(rewards().snapshot, ME)).toMatchObject({ totalBase: ONE, isLowerBound: true });
  });

  it('a fee level change keeps what is being claimed', async () => {
    await state().planSatoriClaim('rewards');
    await state().selectSatoriClaimFeeLevel('fast');
    expect(rewards().plan).toMatchObject({ level: 'fast', kind: 'rewards', amountBase: 3n * ONE });
  });
});

describe('the seed\'s Evrmore key on Base', () => {
  const signerOf = (raw: string) => publicKeyToEvmAddress(recoverTxPublicKey(hexToBytes(raw.slice(2))));

  it('reads its own figures, and they count towards what is waiting', async () => {
    const { allPendingSatoriRewards } = await import('./satoriRewards');
    evr.lifetime = 4n * ONE;
    evr.minted = ONE;
    evr.airdrop = 2n * ONE;
    evr.satori = 6n * ONE;
    await state().refreshSatoriRewards();
    const account = rewards().evrKey!;
    expect(account.address).toBe(EVR_ADDRESS);
    expect(account.mainAddress).toBe(ME);
    expect(account.ethBase).toBe(ONE);
    expect(account.satoriBase).toBe(6n * ONE);
    expect(account.snapshot?.rewards?.claimableBase).toBe(3n * ONE);
    expect(account.snapshot?.airdrop?.claimableBase).toBe(2n * ONE);

    world.lifetime = null;
    world.airdropClaimable = 0n;
    await state().refreshSatoriRewards();
    expect(allPendingSatoriRewards(rewards(), ME)).toMatchObject({ totalBase: 5n * ONE, evrKeyBase: 5n * ONE, parts: [] });
    // Read for another account, it says nothing about this one.
    expect(allPendingSatoriRewards(rewards(), EVR_ADDRESS.replace(/.$/, '0'))).toBe(null);
  });

  it('a claim from it is sent from that address and signed by that key, and is not this account\'s activity', async () => {
    evr.lifetime = 4n * ONE;
    const plan = await state().planSatoriClaim('rewards', true);
    expect(plan?.from).toBe(EVR_ADDRESS);
    expect(plan?.amountBase).toBe(4n * ONE);
    state().arm(true);
    const { txid } = await state().confirmSatoriClaim();
    expect(signerOf(sentRaw[0])).toBe(EVR_ADDRESS);
    expect(state().txs.find((t) => t.txid === txid)).toBeUndefined();
    expect(rewards().plan).toBe(null);
  });

  it('a claim from the account itself is still signed by the account\'s key', async () => {
    await state().planSatoriClaim('airdrop');
    state().arm(true);
    await state().confirmSatoriClaim();
    expect(signerOf(sentRaw[0])).toBe(ME);
  });

  it('the fee is judged on that address, not the account\'s balance', async () => {
    evr.lifetime = 4n * ONE;
    evr.eth = 0n;
    expect(await state().planSatoriClaim('rewards', true)).toBe(null);
    expect(rewards().error).toMatch(/no ETH on Base/);
    evr.eth = 1n;
    const plan = await state().planSatoriClaim('rewards', true);
    expect(plan?.shortfall).toMatch(/Not enough ETH/);
    await state().selectSatoriClaimFeeLevel('fast');
    expect(rewards().plan?.shortfall).toMatch(/Not enough ETH/);
  });

  it('moves all its SATORI to the account, and nowhere else', async () => {
    evr.satori = 6n * ONE;
    const plan = await state().planSatoriMove();
    expect(plan).toMatchObject({ kind: 'move', from: EVR_ADDRESS, amountBase: 6n * ONE });
    state().arm(true);
    await state().confirmSatoriClaim();
    const { tx } = decodeSignedTx(hexToBytes(sentRaw[0].slice(2)));
    expect(signerOf(sentRaw[0])).toBe(EVR_ADDRESS);
    expect(tx.to.toLowerCase()).toBe('0xd0a5bff2789230b0fb1bd989fc7ce7084c947e17');
    expect(`0x${bytesToHex(tx.data)}`).toBe(
      `0xa9059cbb${ME.slice(2).toLowerCase().padStart(64, '0')}${word(6n * ONE)}`,
    );
  });

  it('refuses to move nothing', async () => {
    expect(await state().planSatoriMove()).toBe(null);
    expect(rewards().error).toMatch(/holds no SATORI/);
  });

  it('an imported key has no separate address', async () => {
    await state().importPrivateKeyWallet('1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727', PW, 'PK', 'evm:base');
    for (let i = 0; i < 100 && state().address === ME && state().evm.activeChainKey !== 'base'; i++) await new Promise((r) => setTimeout(r, 10));
    await state().refreshSatoriRewards();
    expect(rewards().evrKey).toBe(null);
    expect(await state().planSatoriClaim('rewards', true)).toBe(null);
    expect(rewards().error).toMatch(/no separate Evrmore key/);
    expect(await state().planSatoriMove()).toBe(null);
  });
});

describe('the SATORI lock', () => {
  const today = () => BigInt(Math.floor(Date.now() / 86_400_000));

  it('is read with the rest, and a past round is free', async () => {
    lockRound = today() + 2n;
    await state().refreshSatoriRewards();
    expect(rewards().snapshot?.lock).toEqual({ kind: 'until', freeAtMs: (Number(today()) + 3) * 86_400_000 });
    lockRound = today() - 1n;
    await state().refreshSatoriRewards();
    expect(rewards().snapshot?.lock).toEqual({ kind: 'free' });
  });

  it('refuses moving SATORI off a locked Evrmore key, in words', async () => {
    evr.satori = 6n * ONE;
    evrLockRound = today();
    expect(await state().planSatoriMove()).toBe(null);
    expect(rewards().error).toMatch(/locked until .* cannot be sent until the lock ends/);
    evrLockRound = 0xffffffn;
    expect(await state().planSatoriMove()).toBe(null);
    expect(rewards().error).toMatch(/locked while it is delegated/);
  });

  it('does not stand in the way of claiming', async () => {
    lockRound = today() + 2n;
    expect((await state().planSatoriClaim('airdrop'))?.kind).toBe('airdrop');
  });
});

describe('satoriRowIsOfficial', () => {
  const OFFICIAL = '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17';
  const OTHER = '0x00000000000000000000000000000000000000AA';
  const chain = [{ address: OFFICIAL }];
  const none = { tracked: [], discovered: [] };

  it('needs a chain listing the contract', () => {
    expect(satoriRowIsOfficial(chain, none)).toBe(true);
    expect(satoriRowIsOfficial([{ address: OTHER }], none)).toBe(false);
    expect(satoriRowIsOfficial(undefined, none)).toBe(false);
  });

  it('a junk token someone sent changes nothing, trusted or tracked it does', () => {
    const junk = { address: OTHER, symbol: 'satori ' };
    expect(satoriRowIsOfficial(chain, { tracked: [], discovered: [junk] })).toBe(true);
    expect(satoriRowIsOfficial(chain, { tracked: [], discovered: [{ ...junk, trusted: false }] })).toBe(true);
    expect(satoriRowIsOfficial(chain, { tracked: [], discovered: [{ ...junk, trusted: true }] })).toBe(false);
    expect(satoriRowIsOfficial(chain, { tracked: [junk], discovered: [] })).toBe(false);
  });

  it('the official contract itself, listed again, is no rival', () => {
    expect(satoriRowIsOfficial(chain, { tracked: [{ address: OFFICIAL.toLowerCase(), symbol: 'SATORI' }], discovered: [] })).toBe(true);
  });
});

describe('sending once, and leaving means leaving', () => {
  it('a second confirm while the first is on its way sends nothing', async () => {
    await state().planSatoriClaim('airdrop');
    state().arm(true);
    const first = state().confirmSatoriClaim();
    await expect(state().confirmSatoriClaim()).rejects.toThrow(/already being sent|Nothing to confirm/);
    await first;
    expect(sentRaw).toHaveLength(1);
  });

  it('a review left while it was being priced does not come back', async () => {
    const pending = state().planSatoriClaim('airdrop');
    state().clearSatoriClaim();
    expect(await pending).toBe(null);
    expect(rewards().plan).toBe(null);
    expect(rewards().planning).toBe(false);
  });

  it('a fee change landing after leaving does not bring the review back', async () => {
    await state().planSatoriClaim('airdrop');
    const pending = state().selectSatoriClaimFeeLevel('fast');
    state().clearSatoriClaim();
    await pending;
    expect(rewards().plan).toBe(null);
  });
});

describe('satoriClaimRowTitle', () => {
  it('names each channel, and leaves a transfer to read as one', async () => {
    const { satoriClaimRowTitle } = await import('./satoriRewards');
    expect(satoriClaimRowTitle({ satoriSource: 'rewards' })).toBe('Claimed rewards');
    expect(satoriClaimRowTitle({ satoriSource: 'airdrop' })).toBe('Claimed airdrop');
    expect(satoriClaimRowTitle({ satoriSource: 'prediction' })).toBe('Claimed prediction rewards');
    expect(satoriClaimRowTitle({ satoriSource: 'transfer' })).toBe(null);
    expect(satoriClaimRowTitle({})).toBe(null);
  });
});
