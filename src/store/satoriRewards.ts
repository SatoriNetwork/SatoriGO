// The store's Satori reward path on Base, modelled on the neuron
// (satori-lite web/routes.py, /api/wallet/base/*).
//
//   READS   what the contracts report for the active address, plus its Merkle
//           proof from the central server. Never throws: a failed part becomes
//           `issue` text and a null row, never a zero that reads as "nothing".
//   WRITES  each claim is an ordinary EVM transaction: planEvmCall prices it and
//           simulates it, broadcastEvmPlan signs and sends it. No second money path.
//
// Everything EVM is reached through loadEvmModules() (the build flag). The
// type-only imports below are erased at compile time.

import { loadEvmModules } from '../services/chain/engine';
import { fetchBaseConfig, fetchMerkleProof } from '../services/satoriPool';
import { SATORI_BASE_TOKEN } from '../services/assetNotes';
import { planEvmCall, type EvmCallPlan } from './evmCall';
import { EvmSendError, readSatoriLock, refuseLockedSatori } from './evmSend';
import type { EvmWalletDataProvider } from '../services/chain/evm/evmProvider';
import type { SatoriClaimKind, SatoriLock } from '../services/chain/evm/satoriRewards';
import type { LiveTransaction } from '../services/chain/electrumProvider';
import type { EvmChainInfo } from './evmChains';

type EvmMods = NonNullable<Awaited<ReturnType<typeof loadEvmModules>>>;

export type { SatoriClaimKind };

export const SATORI_CLAIM_TITLE: Record<SatoriClaimKind, string> = {
  rewards: 'Rewards',
  airdrop: 'Airdrop',
  prediction: 'Prediction rewards',
};

export interface SatoriRewardsSnapshot {
  address: string;
  /** The Merkle drop. Null when it could not be read. */
  rewards: { lifetimeBase: bigint; claimedBase: bigint; claimableBase: bigint } | null;
  airdrop: { allocationBase: bigint; claimedBase: bigint; claimableBase: bigint } | null;
  /** `complete` false means the Lens stopped early: the amount is a lower bound. */
  prediction: { claimableBase: bigint; complete: boolean } | null;
  /** The token's transfer lock on this address. Null when it could not be read. */
  lock: SatoriLock | null;
  issue: string | null;
  /** Date.now() of this read, so Home can tell when it is due again. */
  readAt: number;
}

/** The Base address of the seed's Evrmore key: old rewards and airdrops sit there. */
export interface SatoriEvrKeyAccount {
  /** The ordinary account this was read for. */
  mainAddress: string;
  address: string;
  /** Null when it could not be read. */
  ethBase: bigint | null;
  satoriBase: bigint | null;
  snapshot: SatoriRewardsSnapshot | null;
}

/** A priced claim, or a move of SATORI off the Evrmore key's address, awaiting
 *  the arming gate. */
export type SatoriClaimPlan = EvmCallPlan & {
  kind: SatoriClaimKind | 'move';
  amountBase: bigint;
  amountIsLowerBound: boolean;
};

export interface SatoriRewardsState {
  snapshot: SatoriRewardsSnapshot | null;
  evrKey: SatoriEvrKeyAccount | null;
  loading: boolean;
  plan: SatoriClaimPlan | null;
  planning: boolean;
  error: string | null;
}

export const EMPTY_SATORI_REWARDS: SatoriRewardsState = Object.freeze({
  snapshot: null,
  evrKey: null,
  loading: false,
  plan: null,
  planning: false,
  error: null,
});

/**
 * Whether the row named SATORI is the official Base token. Rows are keyed by
 * symbol, so it is unless another contract with that symbol has a row too. A
 * discovered token gets a row only once trusted: anyone can send a junk token
 * called SATORI, and that must not take anything away from the real one.
 */
export function satoriRowIsOfficial(
  defaultTokens: readonly { address: string }[] | undefined,
  tokens: {
    tracked: readonly { address: string; symbol?: string }[];
    discovered: readonly { address: string; symbol?: string; trusted?: boolean }[];
  },
): boolean {
  const official = SATORI_BASE_TOKEN.toLowerCase();
  const isOfficial = (t: { address: string }) => t.address.toLowerCase() === official;
  const isOther = (t: { address: string; symbol?: string }) => t.symbol?.trim().toUpperCase() === 'SATORI' && !isOfficial(t);
  return (
    (defaultTokens ?? []).some(isOfficial) &&
    !tokens.tracked.some(isOther) &&
    !tokens.discovered.some((t) => t.trusted === true && isOther(t))
  );
}

/** How an Activity row names a claim, or null for an ordinary transfer. */
export function satoriClaimRowTitle(tx: Pick<LiveTransaction, 'satoriSource'>): string | null {
  switch (tx.satoriSource) {
    case 'rewards':
      return 'Claimed rewards';
    case 'airdrop':
      return 'Claimed airdrop';
    case 'prediction':
      return 'Claimed prediction rewards';
    default:
      return null;
  }
}

/** How long Home trusts a read before asking again. */
export const SATORI_REWARDS_MAX_AGE_MS = 5 * 60_000;

export interface SatoriRewardsPending {
  totalBase: bigint;
  /** Only the channels with something to claim. */
  parts: { kind: SatoriClaimKind; amountBase: bigint }[];
  /** The Lens stopped early, so the real total can be higher. */
  isLowerBound: boolean;
}

/**
 * What `address` can claim right now, or null when nothing (or nothing known).
 * A snapshot of another account says nothing about this one.
 */
export function pendingSatoriRewards(
  snapshot: SatoriRewardsSnapshot | null,
  address: string,
): SatoriRewardsPending | null {
  if (!snapshot || snapshot.address !== address) return null;
  const parts = [
    { kind: 'rewards' as const, amountBase: snapshot.rewards?.claimableBase ?? 0n },
    { kind: 'airdrop' as const, amountBase: snapshot.airdrop?.claimableBase ?? 0n },
    { kind: 'prediction' as const, amountBase: snapshot.prediction?.claimableBase ?? 0n },
  ].filter((part) => part.amountBase > 0n);
  if (parts.length === 0) return null;
  return {
    totalBase: parts.reduce((sum, part) => sum + part.amountBase, 0n),
    parts,
    isLowerBound: parts.some((part) => part.kind === 'prediction') && snapshot.prediction?.complete === false,
  };
}

/** Everything waiting across the account and its Evrmore key, for Home and the
 *  SATORI detail, or null when nothing is. */
export function allPendingSatoriRewards(
  state: Pick<SatoriRewardsState, 'snapshot' | 'evrKey'>,
  address: string,
): (SatoriRewardsPending & { evrKeyBase: bigint }) | null {
  const main = pendingSatoriRewards(state.snapshot, address);
  const old =
    state.evrKey?.mainAddress === address && state.evrKey.snapshot
      ? pendingSatoriRewards(state.evrKey.snapshot, state.evrKey.address)
      : null;
  if (!main && !old) return null;
  return {
    totalBase: (main?.totalBase ?? 0n) + (old?.totalBase ?? 0n),
    parts: main?.parts ?? [],
    isLowerBound: !!main?.isLowerBound || !!old?.isLowerBound,
    evrKeyBase: old?.totalBase ?? 0n,
  };
}

const MOVED_TEXT = 'Satori has moved its reward contracts. Update Satori GO before claiming.';

/** True when the server names reward contracts other than the wallet's pins. */
async function contractsMoved(evm: EvmMods): Promise<boolean> {
  const config = await fetchBaseConfig();
  const pins = evm.SATORI_REWARD_CONTRACTS;
  return (['merkle', 'airdrop', 'hub', 'lens'] as const).some((name) => {
    const named = config[name];
    return typeof named !== 'string' || named.toLowerCase() !== pins[name].toLowerCase();
  });
}

async function readUint(evm: EvmMods, provider: EvmWalletDataProvider, to: string, data: string): Promise<bigint> {
  const result = await provider.rpc.call<string>('eth_call', [{ to, data }, 'latest']);
  return evm.decodeUint256(result as string);
}

/** What the Merkle drop owes `address` now, with the proof that claims it. */
async function readMerkle(evm: EvmMods, provider: EvmWalletDataProvider, address: string) {
  const [entry, claimedBase] = await Promise.all([
    fetchMerkleProof(address),
    readUint(evm, provider, evm.SATORI_REWARD_CONTRACTS.merkle, evm.encodeAlreadyMintedTo(address)),
  ]);
  const lifetimeBase = entry?.amountBase ?? 0n;
  const left = lifetimeBase - claimedBase;
  return { entry, lifetimeBase, claimedBase, claimableBase: left > 0n ? left : 0n };
}

async function readAirdrop(evm: EvmMods, provider: EvmWalletDataProvider, address: string) {
  const airdrop = evm.SATORI_REWARD_CONTRACTS.airdrop;
  const [allocationBase, claimedBase, claimableBase] = await Promise.all([
    readUint(evm, provider, airdrop, evm.encodeAirdropAllocation(address)),
    readUint(evm, provider, airdrop, evm.encodeAirdropClaimed(address)),
    readUint(evm, provider, airdrop, evm.encodeClaimableAirdrop(address)),
  ]);
  return { allocationBase, claimedBase, claimableBase };
}

async function readPrediction(evm: EvmMods, provider: EvmWalletDataProvider, address: string) {
  const result = await provider.rpc.call<string>('eth_call', [
    { to: evm.SATORI_REWARD_CONTRACTS.lens, data: evm.encodeTotalClaimableRewards(address) },
    'latest',
  ]);
  const { total, complete } = evm.decodeTotalClaimableRewards(result as string);
  return { claimableBase: total, complete };
}

/** Everything the Rewards screen shows. Null only when the build has no EVM engine. */
export async function loadSatoriRewards(
  provider: EvmWalletDataProvider,
  address: string,
): Promise<SatoriRewardsSnapshot | null> {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const [moved, merkle, airdrop, prediction, lock] = await Promise.allSettled([
    contractsMoved(evm),
    readMerkle(evm, provider, address),
    readAirdrop(evm, provider, address),
    readPrediction(evm, provider, address),
    readSatoriLock(provider, address),
  ]);
  const issues: string[] = [];
  if (moved.status === 'fulfilled' && moved.value) issues.push(MOVED_TEXT);
  if (merkle.status === 'rejected') issues.push('Your rewards could not be read.');
  if (airdrop.status === 'rejected') issues.push('Your airdrop could not be read.');
  if (prediction.status === 'rejected') issues.push('Your prediction rewards could not be read.');
  return {
    address,
    rewards:
      merkle.status === 'fulfilled'
        ? {
            lifetimeBase: merkle.value.lifetimeBase,
            claimedBase: merkle.value.claimedBase,
            claimableBase: merkle.value.claimableBase,
          }
        : null,
    airdrop: airdrop.status === 'fulfilled' ? airdrop.value : null,
    prediction: prediction.status === 'fulfilled' ? prediction.value : null,
    lock: lock.status === 'fulfilled' ? lock.value : null,
    issue: issues.length > 0 ? issues.join(' ') : null,
    readAt: Date.now(),
  };
}

async function readNative(provider: EvmWalletDataProvider, address: string): Promise<bigint> {
  return BigInt((await provider.rpc.call<string>('eth_getBalance', [address, 'latest'])) as string);
}

async function readSatori(evm: EvmMods, provider: EvmWalletDataProvider, address: string): Promise<bigint> {
  return readUint(evm, provider, SATORI_BASE_TOKEN, evm.encodeBalanceOf(address));
}

/** The Evrmore key's account as the Rewards screen shows it. Never throws. */
export async function loadSatoriEvrKeyAccount(
  provider: EvmWalletDataProvider,
  mainAddress: string,
  address: string,
): Promise<SatoriEvrKeyAccount | null> {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const [snapshot, eth, satori] = await Promise.all([
    loadSatoriRewards(provider, address),
    readNative(provider, address).catch(() => null),
    readSatori(evm, provider, address).catch(() => null),
  ]);
  return { mainAddress, address, ethBase: eth, satoriBase: satori, snapshot };
}

/** What a claim from the Evrmore key's address can pay its fee with, read now. */
export async function evrKeyNativeBalance(provider: EvmWalletDataProvider, address: string): Promise<bigint | undefined> {
  return readNative(provider, address).catch(() => undefined);
}

/** Price moving all SATORI from the Evrmore key's address to the main account. */
export async function buildSatoriMovePlan(args: {
  provider: EvmWalletDataProvider;
  chain: EvmChainInfo;
  from: string;
  to: string;
  nativeBalanceBase?: bigint;
}): Promise<SatoriClaimPlan> {
  const evm = await loadEvmModules();
  if (!evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
  const { provider, chain, from, to, nativeBalanceBase } = args;
  if (nativeBalanceBase === 0n) {
    throw new EvmSendError('insufficient', `This address has no ${chain.nativeTicker} on ${chain.displayName} to pay the network fee. Send it a little ${chain.nativeTicker} first.`);
  }
  let amountBase: bigint;
  try {
    amountBase = await readSatori(evm, provider, from);
  } catch {
    throw new EvmSendError('quote-failed', 'The balance could not be read right now. Try again.');
  }
  if (amountBase <= 0n) throw new EvmSendError('invalid-amount', 'This address holds no SATORI to move.');
  await refuseLockedSatori(provider, from);
  const plan = await planEvmCall({
    provider,
    chain,
    from,
    nativeBalanceBase,
    input: {
      to: SATORI_BASE_TOKEN,
      data: evm.encodeTransfer(to, amountBase),
      value: 0n,
      description: 'Move all SATORI from your old Evrmore key to your main address.',
    },
  });
  return { ...plan, kind: 'move', amountBase, amountIsLowerBound: false };
}

/**
 * Build the priced plan for one claim, from figures read fresh at this moment.
 * Throws EvmSendError, whose message the screen shows verbatim.
 */
export async function buildSatoriClaimPlan(args: {
  provider: EvmWalletDataProvider;
  chain: EvmChainInfo;
  from: string;
  kind: SatoriClaimKind;
  nativeBalanceBase?: bigint;
}): Promise<SatoriClaimPlan> {
  const evm = await loadEvmModules();
  if (!evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
  const { provider, chain, from, kind, nativeBalanceBase } = args;
  const contracts = evm.SATORI_REWARD_CONTRACTS;

  const noEth = `This address has no ${chain.nativeTicker} on ${chain.displayName} to pay the network fee. Send it a little ${chain.nativeTicker}, then claim again.`;
  if (nativeBalanceBase === 0n) throw new EvmSendError('insufficient', noEth);

  let to: string;
  let data: Uint8Array;
  let amountBase: bigint;
  let amountIsLowerBound = false;
  let description: string;
  try {
    if (await contractsMoved(evm)) throw new EvmSendError('unknown-asset', MOVED_TEXT);
    if (kind === 'rewards') {
      const merkle = await readMerkle(evm, provider, from);
      if (!merkle.entry) {
        throw new EvmSendError('invalid-amount', 'Nothing to claim yet. This address is not in the current drop.');
      }
      if (merkle.claimableBase <= 0n) {
        throw new EvmSendError('invalid-amount', 'Nothing to claim. You are already up to date.');
      }
      to = contracts.merkle;
      data = evm.encodeClaimMerkle(merkle.lifetimeBase, merkle.entry.proof);
      amountBase = merkle.claimableBase;
      description = 'Claim your Satori rewards to this address.';
    } else if (kind === 'airdrop') {
      amountBase = (await readAirdrop(evm, provider, from)).claimableBase;
      if (amountBase <= 0n) throw new EvmSendError('invalid-amount', 'Nothing to claim from the airdrop.');
      to = contracts.airdrop;
      data = evm.encodeClaimAirdrop();
      description = 'Claim your Satori airdrop to this address.';
    } else {
      const prediction = await readPrediction(evm, provider, from);
      amountBase = prediction.claimableBase;
      amountIsLowerBound = !prediction.complete;
      if (amountBase <= 0n) throw new EvmSendError('invalid-amount', 'No prediction rewards to claim yet.');
      to = contracts.hub;
      data = evm.encodeHubClaim();
      description = 'Claim your Satori prediction rewards to this address.';
    }
  } catch (err) {
    if (err instanceof EvmSendError) throw err;
    throw new EvmSendError('quote-failed', 'The rewards could not be read right now. Try again.');
  }

  try {
    const plan = await planEvmCall({
      provider,
      chain,
      from,
      nativeBalanceBase,
      input: { to, data, value: 0n, description },
    });
    return { ...plan, kind, amountBase, amountIsLowerBound };
  } catch (err) {
    // A node may price the call against the balance and refuse it for that.
    if (err instanceof Error && /insufficient funds/i.test(err.message)) {
      throw new EvmSendError('insufficient', noEth);
    }
    throw err;
  }
}
