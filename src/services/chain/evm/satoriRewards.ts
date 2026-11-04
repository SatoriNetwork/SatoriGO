// The Satori reward contracts on Base: addresses, calldata, return data.
//
// Three separate channels, as the neuron has them (satori-lite
// neuron-lite/satorineuron/base_claim.py). All three mint SATORI to msg.sender
// and the sender pays the gas, so the claiming address needs ETH on Base:
//   SatoriMerkle   claimMerkle(lifetimeEntitlement, proof): the proof comes from
//                  the central server, the contract mints the delta over
//                  alreadyMintedTo(sender).
//   SatoriAirdrop  claimAirdrop(): allocation from the SATORIEVR snapshot, no proof.
//   SatoriHub      claim(): scored prediction rewards, read through the Lens.
//
// PINNED, not read from the server's /base/config as the neuron does: a wallet
// must not sign calls to addresses a server handed it. The store compares the
// pins with that config and refuses to claim when they differ.

import { hexToBytes } from '@noble/hashes/utils';
import { decodeUint256 } from './erc20';
import { normalizeEvmAddress } from './keys';

/** The three channels a claim can come through. */
export type SatoriClaimKind = 'rewards' | 'airdrop' | 'prediction';

export const SATORI_REWARD_CONTRACTS = Object.freeze({
  merkle: '0x8d2EcABbDd72C427A62ECe45E30a75B41Eb71E9B',
  airdrop: '0xD08c6BB90b3Fc96484E51E4BA9a373E15C83C28E',
  hub: '0x195083eE270ad89459e8dbF2d40fDFc85fb21327',
  lens: '0x5a81cd45D6832CD6f2b4Ef53694ea07431c96DD5',
});

/** Pinned, and proven against selector(<signature>) in satoriRewards.test.ts. */
export const SATORI_REWARD_SELECTORS = Object.freeze({
  claimMerkle: '0x958944f1', // claimMerkle(uint256,bytes32[])
  alreadyMintedTo: '0xe395674e', // alreadyMintedTo(address)
  claimAirdrop: '0x5b88349d', // claimAirdrop()
  claimableAirdrop: '0x77d58e32', // claimableAirdrop(address)
  airdropAllocation: '0xdef2a001', // airdropAllocation(address)
  airdropClaimed: '0xd1b6dd30', // airdropClaimed(address)
  claim: '0x4e71d92d', // claim()
  getTotalClaimableRewards: '0x60d8fdd8', // getTotalClaimableRewards(address)
  transferLockedUntil: '0x481d7b10', // transferLockedUntil(address), on the SATORI token
});

/** Which channel a transaction sent to `to` claims from, or null for any other
 *  contract. Every channel names its own contract, so `to` alone answers it. */
export function satoriClaimKindOfContract(to: unknown): SatoriClaimKind | null {
  if (typeof to !== 'string') return null;
  const lower = to.toLowerCase();
  if (lower === SATORI_REWARD_CONTRACTS.merkle.toLowerCase()) return 'rewards';
  if (lower === SATORI_REWARD_CONTRACTS.airdrop.toLowerCase()) return 'airdrop';
  if (lower === SATORI_REWARD_CONTRACTS.hub.toLowerCase()) return 'prediction';
  return null;
}

/** A round is one UTC day, as SatoriToken counts them. */
const SATORI_ROUND_MS = 86_400_000;
/** transferLockedUntil's "no end date": on-chain delegation holds this until undone. */
export const SATORI_LOCK_INDEFINITE = 0xffffffn;

/**
 * What SatoriToken's lock means for an address. It covers the address's whole
 * balance: the token reverts Locked() on any transfer out while the current
 * round is <= the stored one, so tokens are free when the NEXT round starts.
 * Receiving and claiming are never blocked.
 */
export type SatoriLock = { kind: 'free' } | { kind: 'until'; freeAtMs: number } | { kind: 'delegated' };

export function satoriLockOf(lockedUntilRound: bigint, nowMs: number): SatoriLock {
  if (lockedUntilRound === SATORI_LOCK_INDEFINITE) return { kind: 'delegated' };
  if (lockedUntilRound < BigInt(Math.floor(nowMs / SATORI_ROUND_MS))) return { kind: 'free' };
  return { kind: 'until', freeAtMs: (Number(lockedUntilRound) + 1) * SATORI_ROUND_MS };
}

const WORD_HEX = 64;
/** claimMerkle's array starts after its two head words. */
const PROOF_OFFSET_BYTES = 64n;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function uintWord(value: bigint): string {
  if (value < 0n || value >= 2n ** 256n) throw new Error('satoriRewards: value does not fit uint256');
  return value.toString(16).padStart(WORD_HEX, '0');
}

function addressCall(selector: string, address: string): string {
  return selector + normalizeEvmAddress(address).slice(2).toLowerCase().padStart(WORD_HEX, '0');
}

export const encodeAlreadyMintedTo = (address: string) => addressCall(SATORI_REWARD_SELECTORS.alreadyMintedTo, address);
export const encodeClaimableAirdrop = (address: string) => addressCall(SATORI_REWARD_SELECTORS.claimableAirdrop, address);
export const encodeAirdropAllocation = (address: string) => addressCall(SATORI_REWARD_SELECTORS.airdropAllocation, address);
export const encodeAirdropClaimed = (address: string) => addressCall(SATORI_REWARD_SELECTORS.airdropClaimed, address);
export const encodeTransferLockedUntil = (address: string) => addressCall(SATORI_REWARD_SELECTORS.transferLockedUntil, address);
export const encodeTotalClaimableRewards = (address: string) =>
  addressCall(SATORI_REWARD_SELECTORS.getTotalClaimableRewards, address);

/** Calldata for claimMerkle: selector, entitlement, offset of the array (two
 *  head words), its length, its items. */
export function encodeClaimMerkle(lifetimeEntitlement: bigint, proof: readonly string[]): Uint8Array {
  if (proof.some((node) => !BYTES32_RE.test(node))) throw new Error('satoriRewards: a proof node is not bytes32');
  const hex =
    SATORI_REWARD_SELECTORS.claimMerkle.slice(2) +
    uintWord(lifetimeEntitlement) +
    uintWord(PROOF_OFFSET_BYTES) +
    uintWord(BigInt(proof.length)) +
    proof.map((node) => node.slice(2).toLowerCase()).join('');
  return hexToBytes(hex);
}

export const encodeClaimAirdrop = (): Uint8Array => hexToBytes(SATORI_REWARD_SELECTORS.claimAirdrop.slice(2));
export const encodeHubClaim = (): Uint8Array => hexToBytes(SATORI_REWARD_SELECTORS.claim.slice(2));

/** getTotalClaimableRewards returns (total, complete). `complete` is false when
 *  the Lens hit its round budget, which makes `total` a lower bound. */
export function decodeTotalClaimableRewards(returnData: string): { total: bigint; complete: boolean } {
  if (typeof returnData !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(returnData)) {
    throw new Error('satoriRewards: getTotalClaimableRewards must return two words');
  }
  return {
    total: decodeUint256(`0x${returnData.slice(2, 2 + WORD_HEX)}`),
    complete: decodeUint256(`0x${returnData.slice(2 + WORD_HEX)}`) !== 0n,
  };
}
