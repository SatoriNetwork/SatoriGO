// Bittensor (Finney) constants: the pinned runtime profile of design
// bittensor-engine.md §4.1, read from the live chain (spec 470) on 2026-09-28
// and cross-checked against the saved v14 metadata with polkadot.js
// (profile.test.ts pins the digest).
//
// The family is 'substrate': keys, SS58, SCALE, extrinsic v4 and the RPC set
// are Substrate's. What is Bittensor-specific is this one object. A second
// Substrate chain would add a profile, not an engine.

import type { TaoRuntimeProfile } from './profile';

/** The hash of Finney block 0. Every RPC answer the wallet trusts is on this genesis. */
export const TAO_GENESIS = '0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03';

/** 1 TAO = 1e9 rao. Balance is u64 on the wire. */
export const RAO_PER_TAO = 1_000_000_000n;
export const TAO_DECIMALS = 9;

/** A receiver of less than this is reaped and the funds are lost (design §4.5). */
export const TAO_EXISTENTIAL_DEPOSIT = 500n;

/**
 * Mortal era length in blocks: about 13 minutes at 12 s blocks. Signing
 * happens seconds before submit, so 64 is enough; a plan held open longer is
 * rebuilt with a fresh checkpoint and nonce.
 */
export const TAO_ERA_PERIOD = 64;

export const TAO_SPEC_NAME = 'node-subtensor';
export const TAO_SPEC_VERSION = 470;
export const TAO_TRANSACTION_VERSION = 1;

/**
 * The thirteen signed extensions of spec 470, in metadata order. Only five
 * contribute bytes (CheckMortality, CheckNonce, ChargeTransactionPayment,
 * CheckMetadataHash to `extra`; CheckSpecVersion, CheckTxVersion,
 * CheckGenesis, CheckMortality, CheckMetadataHash to `additional`); the rest
 * are Null on both sides. The list is compared whole: a new extension with
 * a Null encoding would still be a layout change the wallet must see.
 */
export const TAO_SIGNED_EXTENSIONS: readonly string[] = Object.freeze([
  'CheckNonZeroSender',
  'CheckSpecVersion',
  'CheckTxVersion',
  'CheckGenesis',
  'CheckMortality',
  'CheckNonce',
  'CheckWeight',
  'ChargeTransactionPayment',
  'SudoTransactionExtension',
  'CheckShieldedTxValidity',
  'SubtensorTransactionExtension',
  'DrandPriority',
  'CheckMetadataHash',
]);

/** Spec 470 / tx 1, the table of design §4.1. */
export const TAO_PROFILE: TaoRuntimeProfile = Object.freeze({
  specName: TAO_SPEC_NAME,
  specVersion: TAO_SPEC_VERSION,
  transactionVersion: TAO_TRANSACTION_VERSION,
  genesis: TAO_GENESIS,
  ss58: 42,
  decimals: TAO_DECIMALS,
  symbol: 'TAO',
  existentialDeposit: TAO_EXISTENTIAL_DEPOSIT,
  extrinsicVersion: 4 as const,
  balanceBytes: 8 as const,
  balances: Object.freeze({ pallet: 5, transfer_allow_death: 0, transfer_keep_alive: 3, transfer_all: 4 }),
  signedExtensions: TAO_SIGNED_EXTENSIONS,
});
