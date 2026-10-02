// Zcash transparent keys: BIP44 on secp256k1, coin type 133, from the
// wallet's existing BIP39 phrase (design docs/design/zcash-engine.md §2).
//
//   seed64  = BIP39 PBKDF2(mnemonic, passphrase)       (keys.ts mnemonicToSeed)
//   node    = m/44'/133'/0'/{change}/{index}           (@scure/bip32)
//   address = base58check(1C B8 || HASH160(compressed pubkey))
//
// This is the path Trust Wallet Core, Zashi (librustzcash), YWallet and
// Trezor use; the published vectors in keys.test.ts pin it, including the
// passphrase pass-through and the change branch.
//
// The wallet hands out exactly one address, /0/0, for receiving and for
// change. It WATCHES more: /0/0..9 and /1/0..4 (fifteen), so funds a phrase
// received at another index in Zashi or YWallet show and can be spent here.
//
// SAFETY: coin type 133 is spoken for by this module. Never reuse it anywhere
// else in the wallet. Private keys are Uint8Array copies owned by the returned
// ZcashKeys; zeroZcashKeys() fills them with 0 when the owner drops them, and
// every intermediate BIP32 node is wiped before this module returns.

import { HDKey } from '@scure/bip32';
import { hash160, mnemonicToSeed, validateMnemonic } from '../keys';
import { ZCASH_NETWORKS, encodeP2pkh, p2pkhScript, type ZcashNetwork } from './address';

export type { ZcashNetwork } from './address';

export const ZCASH_COIN_TYPE = 133;
/** External addresses watched: /0/0 .. /0/9 (librustzcash's external gap is 10). */
export const ZCASH_WATCH_EXTERNAL = 10;
/** Internal (change) addresses watched: /1/0 .. /1/4 (librustzcash's internal gap is 5). */
export const ZCASH_WATCH_INTERNAL = 5;
/** One account per phrase in v1. */
export const ZCASH_ACCOUNT = 0;

const HARDENED = 0x80000000;

export interface ZcashKey {
  change: 0 | 1;
  index: number;
  /** 32-byte secp256k1 secret. Owned by the enclosing ZcashKeys; zeroed by zeroZcashKeys. */
  privateKey: Uint8Array;
  /** 33-byte compressed public key. */
  publicKey: Uint8Array;
  address: string;
  /** The P2PKH output script paying `address`. */
  script: Uint8Array;
}

export interface ZcashKeys {
  /** /0/0: the one address the wallet shows, and the change address. */
  primary: ZcashKey;
  /** /0/0..9 then /1/0..4. `watch[0]` is `primary` (the same object). */
  watch: readonly ZcashKey[];
}

/** The BIP44 path of one transparent key. */
export function zcashPath(change: 0 | 1, index: number, net: ZcashNetwork = 'main', account = ZCASH_ACCOUNT): string {
  return `m/44'/${ZCASH_NETWORKS[net].coinType}'/${account}'/${change}/${index}`;
}

function keyFromNode(node: HDKey, change: 0 | 1, index: number, net: ZcashNetwork): ZcashKey {
  const child = node.deriveChild(index);
  try {
    if (!child.privateKey || !child.publicKey) throw new Error('zcash: derivation produced no key');
    // HDKey.privateKey is the node's own buffer; copy before wiping the node.
    const privateKey = Uint8Array.from(child.privateKey);
    const publicKey = Uint8Array.from(child.publicKey);
    const h = hash160(publicKey);
    return { change, index, privateKey, publicKey, address: encodeP2pkh(h, net), script: p2pkhScript(h) };
  } finally {
    child.wipePrivateData();
  }
}

/**
 * The fifteen watch keys from a 64-byte BIP39 seed (or any BIP32 master seed:
 * the ZIP-320 vectors use a 32-byte one). The seed is not modified or zeroed;
 * its owner does that.
 */
export function zcashKeysFromSeed(seed64: Uint8Array, net: ZcashNetwork = 'main'): ZcashKeys {
  if (!(seed64 instanceof Uint8Array) || seed64.length < 16 || seed64.length > 64) {
    throw new Error('zcash: seed must be 16 to 64 bytes');
  }
  // Step by step (not derive("m/...")) so every intermediate node is wiped.
  const nodes: HDKey[] = [HDKey.fromMasterSeed(seed64)];
  const watch: ZcashKey[] = [];
  try {
    for (const step of [44, ZCASH_NETWORKS[net].coinType, ZCASH_ACCOUNT]) {
      nodes.push(nodes[nodes.length - 1].deriveChild(HARDENED + step));
    }
    const account = nodes[nodes.length - 1];
    const external = account.deriveChild(0);
    nodes.push(external);
    const internal = account.deriveChild(1);
    nodes.push(internal);
    for (let i = 0; i < ZCASH_WATCH_EXTERNAL; i++) watch.push(keyFromNode(external, 0, i, net));
    for (let i = 0; i < ZCASH_WATCH_INTERNAL; i++) watch.push(keyFromNode(internal, 1, i, net));
  } catch (err) {
    for (const k of watch) k.privateKey.fill(0);
    throw err;
  } finally {
    for (const n of nodes) n.wipePrivateData();
  }
  return { primary: watch[0], watch };
}

/**
 * The fifteen watch keys from a BIP39 phrase and optional passphrase (passed
 * through exactly as Trust Wallet Core and Trezor do). The intermediate seed
 * is zeroed before this returns.
 */
export async function zcashKeysFromBip39(
  mnemonic: string,
  passphrase = '',
  net: ZcashNetwork = 'main',
): Promise<ZcashKeys> {
  if (!validateMnemonic(mnemonic)) throw new Error('zcash: invalid recovery phrase');
  const seed = await mnemonicToSeed(mnemonic, passphrase);
  try {
    return zcashKeysFromSeed(seed, net);
  } finally {
    seed.fill(0);
  }
}

/** The fifteen watch addresses, /0/0 first. Public data, safe to store on the entry. */
export function zcashWatchAddresses(keys: ZcashKeys): string[] {
  return keys.watch.map((k) => k.address);
}

/** A copy that shares no secret buffers with `keys` (zero both independently). */
export function cloneZcashKeys(keys: ZcashKeys): ZcashKeys {
  const watch = keys.watch.map((k) => ({
    ...k,
    privateKey: Uint8Array.from(k.privateKey),
    publicKey: Uint8Array.from(k.publicKey),
    script: Uint8Array.from(k.script),
  }));
  return { primary: watch[0], watch };
}

/** Fills every private key with 0. Idempotent. */
export function zeroZcashKeys(keys: ZcashKeys): void {
  for (const k of keys.watch) k.privateKey.fill(0);
  keys.primary.privateKey.fill(0);
}
