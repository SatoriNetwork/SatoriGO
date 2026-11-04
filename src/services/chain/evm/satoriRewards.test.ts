import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { selector } from './erc20';
import {
  SATORI_REWARD_SELECTORS,
  decodeTotalClaimableRewards,
  encodeAlreadyMintedTo,
  encodeClaimAirdrop,
  encodeClaimMerkle,
  encodeHubClaim,
  encodeTransferLockedUntil,
  satoriLockOf,
} from './satoriRewards';

const hex = (data: Uint8Array) => `0x${bytesToHex(data)}`;

// A real claimMerkle on Base mainnet, tx 0x5a97bc31...e9f30b, as it left a wallet.
const REAL_LIFETIME = 0x2c2c9426909d6400n;
const REAL_PROOF = [
  '0x2f316228666f7fb30f2df81df71c481ecd899676e3d9c3121a959247f03575e7',
  '0x22c783ebfb547fbeda5488dfa2e01634b0cd9b19f2e9b0db396eab0f9ead0308',
  '0xcf1498fb387c7b4e2ad023aba37ab9c64ab5e7757ae0afb44d406b3013eaa03f',
  '0x7af2815d86bcadade2647baf11e521ba8fd6e7812cdf2ff451a92a76993efa6b',
  '0x916316189ed680bfb16c34b93e79c6ee83000ebc4d800a5e19e8283d33ff3696',
  '0x98535b8007456032bbd0b7f1fe33d98ab9572af81db7114eea536961ed91d718',
  '0x32fe1f71d692fa4dddc70390a0adcc6b09764783a27d60a2f4d698d2473e2107',
  '0x245d2bebeb65aea117fd211b52629ec6bd42b6b1c8046f968434a879f90a0f37',
];
const REAL_INPUT =
  '0x958944f10000000000000000000000000000000000000000000000002c2c9426909d6400000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000082f316228666f7fb30f2df81df71c481ecd899676e3d9c3121a959247f03575e722c783ebfb547fbeda5488dfa2e01634b0cd9b19f2e9b0db396eab0f9ead0308cf1498fb387c7b4e2ad023aba37ab9c64ab5e7757ae0afb44d406b3013eaa03f7af2815d86bcadade2647baf11e521ba8fd6e7812cdf2ff451a92a76993efa6b916316189ed680bfb16c34b93e79c6ee83000ebc4d800a5e19e8283d33ff369698535b8007456032bbd0b7f1fe33d98ab9572af81db7114eea536961ed91d71832fe1f71d692fa4dddc70390a0adcc6b09764783a27d60a2f4d698d2473e2107245d2bebeb65aea117fd211b52629ec6bd42b6b1c8046f968434a879f90a0f37';

describe('Satori reward calldata', () => {
  it('pins each selector to its signature', () => {
    const signatures: Record<keyof typeof SATORI_REWARD_SELECTORS, string> = {
      claimMerkle: 'claimMerkle(uint256,bytes32[])',
      alreadyMintedTo: 'alreadyMintedTo(address)',
      claimAirdrop: 'claimAirdrop()',
      claimableAirdrop: 'claimableAirdrop(address)',
      airdropAllocation: 'airdropAllocation(address)',
      airdropClaimed: 'airdropClaimed(address)',
      claim: 'claim()',
      getTotalClaimableRewards: 'getTotalClaimableRewards(address)',
      transferLockedUntil: 'transferLockedUntil(address)',
    };
    for (const [name, signature] of Object.entries(signatures)) {
      expect(SATORI_REWARD_SELECTORS[name as keyof typeof SATORI_REWARD_SELECTORS]).toBe(selector(signature));
    }
  });

  it('builds a claimMerkle byte for byte as a real transaction on Base', () => {
    expect(hex(encodeClaimMerkle(REAL_LIFETIME, REAL_PROOF))).toBe(REAL_INPUT);
  });

  it('refuses a proof node that is not bytes32', () => {
    expect(() => encodeClaimMerkle(1n, ['0x1234'])).toThrow(/bytes32/);
  });

  it('calls with no arguments are the selector alone', () => {
    expect(hex(encodeClaimAirdrop())).toBe('0x5b88349d');
    expect(hex(encodeHubClaim())).toBe('0x4e71d92d');
  });

  it('pads an address read to one word', () => {
    expect(encodeAlreadyMintedTo('0x870e70954d356e5512d58f291f0cabb8c90828ed')).toBe(
      '0xe395674e000000000000000000000000870e70954d356e5512d58f291f0cabb8c90828ed',
    );
  });

  it('decodes the Lens answer, and refuses any other width', () => {
    const word = (v: number) => v.toString(16).padStart(64, '0');
    expect(decodeTotalClaimableRewards(`0x${word(5)}${word(1)}`)).toEqual({ total: 5n, complete: true });
    expect(decodeTotalClaimableRewards(`0x${word(5)}${word(0)}`)).toEqual({ total: 5n, complete: false });
    expect(() => decodeTotalClaimableRewards(`0x${word(5)}`)).toThrow();
  });
});

describe('satoriLockOf', () => {
  const DAY = 86_400_000;
  const noon = 20761 * DAY + DAY / 2;

  it('holds through the stored round and frees at the next one', () => {
    expect(satoriLockOf(20761n, noon)).toEqual({ kind: 'until', freeAtMs: 20762 * DAY });
    expect(satoriLockOf(20763n, noon)).toEqual({ kind: 'until', freeAtMs: 20764 * DAY });
  });

  it('a past round or none is free', () => {
    expect(satoriLockOf(20760n, noon)).toEqual({ kind: 'free' });
    expect(satoriLockOf(0n, noon)).toEqual({ kind: 'free' });
  });

  it('the no-end-date value means delegated', () => {
    expect(satoriLockOf(0xffffffn, noon)).toEqual({ kind: 'delegated' });
  });

  it('the selector is the token\'s', () => {
    expect(SATORI_REWARD_SELECTORS.transferLockedUntil).toBe(selector('transferLockedUntil(address)'));
    expect(encodeTransferLockedUntil('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(
      `0x481d7b10${'9858effd232b4033e47d90003d41ec34ecaeda94'.padStart(64, '0')}`,
    );
  });
});
