// LiveWalletService — the integration keystone for REAL Evrmore mode.
// Ties together: vault (encrypted seed), HD key derivation, the Electrum
// watch-only provider (reads), and txBuilder (build+sign). It deliberately
// keeps a HARD broadcast gate: building/signing a real transaction is allowed
// and reviewable, but actually broadcasting to mainnet requires explicit arming
//
// The unlocked seed lives only in memory here; only the encrypted VaultRecord
// is persisted (via the app's storage adapter). No plaintext seed touches disk.

import { getStorage } from '../storage';
import {
  EVRMORE_MAINNET,
  EVRMORE_TESTNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  BITCOIN_MAINNET,
  BITCOIN_BLAKE2B_MAINNET,
  DOGECOIN_MAINNET,
  NEOXA_MAINNET,
  supportsAssets,
  feePolicyFor,
  type EvrmoreNetwork,
} from './chainParams';
import {
  FEE_OPTION_TARGET_BLOCKS,
  assertFeeSane,
  buildFeeEstimate,
  clampFeeRate,
  serverEstimateToSatPerByte,
  type FeeEstimate,
} from './feePolicy';
import {
  deriveAddress,
  addressToElectrumScripthash,
  addressToHash160,
  isSpendableAddress,
  isP2pkhAddress,
  addressToScript,
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  privateKeyToDerived,
  parsePrivateKey,
  type DerivedKey,
} from './keys';
import { signMessageWithKey } from './message';
import { StoreWriteFailedError, isStoreWriteFailed } from './storeWrite';
import { verifyInputAmounts, parseTx } from './verifyUtxo';
import {
  createVault,
  createVaultV2,
  unlockVault,
  unlockVaultString,
  unlockVaultV2,
  unlockVaultV2String,
  isVaultRecordV2,
  rewrapVaultV2,
  type StoredVaultRecord,
  type VaultRecord,
  type VaultRecordV2,
} from './vault';
import {
  bytesEqual,
  createAppKeyRecord,
  createAppKeyRecordForMaster,
  deriveMasterKey,
  deriveMasterKeyFromRecovery,
  generateMasterKey,
  generateRecoveryCode,
  isAppKeyRecordV2,
  masterKeyMatchesRecord,
  normalizeRecoveryCode,
  recordHasRecovery,
  rewrapAppKeyRecord,
  sealRecoveryBlock,
  verifyAppPassword,
  withoutRecoveryCode,
  zeroKey,
  type AppKeyRecord,
  type AppKeyRecordV2,
  type AppRecoveryBlock,
} from './appKey';
import {
  createBackup,
  readBackup,
  backupFileName,
  NotABackupFileError,
  WrongBackupPasswordError,
} from './backup';
import {
  createElectrumClient,
  electrumListUnspent,
} from './electrumClient';
import { AddressHistoryRefusedError, ElectrumWalletDataProvider } from './electrumProvider';
import type { ElectrumClient, ElectrumUtxo } from './electrumTypes';
import {
  selectCoins,
  buildAndSignEvrTx,
  buildAndSignAssetTransfer,
  estimateTxBytes,
  estimateSpendVBytes,
  txid,
  type SignableUtxo,
  type BuiltTx,
} from './txBuilder';
import { buildTransferAssetScriptFromHash160 } from './assetScript';
import { ELECTRUM_METHODS, SATORI_ASSET } from './network';
import type { WalletDataProvider } from '../provider';
import { EVM_NETWORK, loadEvmModules, type WalletEngine, type WalletFamily } from './engine';
import { bytesToHex } from '@noble/hashes/utils';

// Stored per-wallet network id. 'mainnet'/'testnet' are the LEGACY Evrmore ids
// (kept verbatim so existing wallet records still resolve to Evrmore); new
// non-Evrmore chains use their canonical id, e.g. 'ravencoin-mainnet'.
export type LiveNetworkId =
  | 'mainnet'
  | 'testnet'
  | 'ravencoin-mainnet'
  | 'bitcoingold-mainnet'
  | 'litecoin-mainnet'
  | 'wojakcoin-mainnet'
  | 'bitcoin-mainnet'
  | 'dogecoin-mainnet'
  // The `default` arm below silently resolves anything unknown to EVRMORE, so a
  // missing case here would make a Neoxa wallet sign with Evrmore's params
  // rather than fail. That exact bug shipped once, for Dogecoin.
  | 'neoxa-mainnet'
  | 'bitcoinblake2b-mainnet';

/** Re-exported from engine.ts (its home): the `network` sentinel of an EVM account. */
export { EVM_NETWORK };
export type StoredNetworkId = LiveNetworkId | typeof EVM_NETWORK;

/** The EVM modules once loaded through the build flag (null in a build without
 *  the engine). Type only; the value arrives via loadEvmModules(). */
type EvmModules = NonNullable<Awaited<ReturnType<typeof loadEvmModules>>>;

/** Legacy single-wallet record shape (storage key `liveWallet`). Retained only
 *  so the one-time migration can read a pre-multi-wallet install. */
interface LiveWalletMeta {
  version: 1;
  network: LiveNetworkId;
  vault: VaultRecord;
  createdAt: number;
}

/** A wallet is either HD (BIP39 seed, many addresses) or a single imported
 *  private key (one address — how Satori-network wallets are generated). */
export type WalletKind = 'seed' | 'pk';

/** One entry in the multi-wallet list. Each wallet has its own name, network and
 *  encrypted vault; only its `id` and metadata (never a plaintext secret) leak
 *  out via listWallets(). The vault encrypts a MNEMONIC for `kind:'seed'` or a
 *  WIF private key for `kind:'pk'`. `address` is the public primary (index-0)
 *  address, cached so other wallets' addresses are known without unlocking
 *  (used for the address book / send-to-my-wallet). */
export interface WalletEntry {
  id: string;
  name: string;
  /** UTXO chain id, or EVM_NETWORK ('evm') for an EVM account. */
  network: StoredNetworkId;
  /** v1 (its own password) or v2 (wrapped by the app master key). BOTH are read
   *  forever; a v1 entry is only ever rewritten by the lazy migration below,
   *  and only after the migration has verified itself. */
  vault: StoredVaultRecord;
  createdAt: number;
  /** 'seed' (HD) or 'pk' (single imported key). Legacy entries default to 'seed'. */
  kind?: WalletKind;
  /** Public primary address (may be '' for a migrated wallet until first unlock). */
  address?: string;
  /** When true the vault is encrypted with an EMPTY passphrase — convenient (no
   *  password to unlock or to send) but NOT securely protected at rest. Opt-in.
   *  ONLY EVER TRUE ON A v1 VAULT: migrating to the app key protects the seed
   *  properly, so the flag is cleared and its CONVENIENCE half moves to
   *  `noSendPassword` (the app-password design notes §6). */
  passwordless?: boolean;
  /** "Do not ask for a password when sending", as a property of its own.
   *  Split out of `passwordless` at migration: after the move the seed IS
   *  protected (by the app key), so the old flag can no longer carry both
   *  meanings. Absent = ask, which is what every wallet that never had
   *  `passwordless` has always done. */
  noSendPassword?: boolean;
  /** How many receive addresses (m/44'/coin'/0'/0/0..N-1) this seed wallet has
   *  derived. Absent/legacy = 1. Always 1 for kind:'pk'. */
  addressCount?: number;
  /** Chain family. ABSENT MEANS 'utxo': every wallet stored before the EVM
   *  engine keeps working with no migration and no store version bump. Read it
   *  through walletFamily() (engine.ts), never by direct comparison. An 'evm'
   *  wallet is ONE account across every EVM chain (coin type 60 derives the
   *  same address on all of them), so `network` stays a UTXO-only field. */
  family?: WalletFamily;
  /** EVM only: the chain key (evm/chains.ts) the UI last showed for this
   *  account. Purely a view preference: it NEVER affects the address. */
  evmChainKey?: string;
  /** EVM seed entries only: the BIP44 ADDRESS index i of m/44'/60'/0'/0/i this
   *  entry is (MetaMask's "Account i+1"). Absent = 0. Never set on 'pk' or
   *  UTXO entries. See the EVM accounts design notes. */
  hdIndex?: number;
  /** EVM seed entries only: the lowercased EIP-55 address of INDEX 0 of this
   *  seed. Public and deterministic; groups the accounts of one seed in the UI
   *  and keeps their passwords in sync. Absent on entries stored before the
   *  feature (backfilled on unlock). */
  seedGroup?: string;
}

/**
 * Upper bound on derived receive addresses per wallet (UI/scan sanity cap).
 *
 * WHY 100 and not the old 20: 20 is exactly the BIP44 gap limit, so it could not
 * hold the RESULT of a proper gap scan. A seed whose highest used index is 19
 * already needs 20 addresses, leaving no room for one the user adds by hand, and
 * a scan could never record a used address above 19 at all.
 *
 * The cost of raising the CAP is not the cost of raising the count: every
 * derived address costs one balance query on every refresh, and `addressCount`
 * only ever grows when addReceiveAddress() or discoverUsedAddresses() has proven
 * that address is wanted. Normal wallets stay at 1 to 5 (a Satori single-key
 * wallet is always exactly 1), so the ordinary refresh is byte-for-byte what it
 * was. 100 is where a genuinely heavily-used seed still works, while a hostile
 * server that claims every address has history can widen a refresh to 100
 * queries and no further.
 */
export const MAX_RECEIVE_ADDRESSES = 100;

/**
 * Consecutive UNUSED receive addresses that end a discovery scan. 20 is the
 * BIP44 standard, so a seed exported from any other BIP44/BIP84 wallet is found
 * to the same depth that wallet itself would look.
 */
export const GAP_LIMIT = 20;

/**
 * Highest EVM ADDRESS INDEX discoverEvmAccounts() looks at (indexes 1..this).
 *
 * Not the same bound as GAP_LIMIT even though the number matches today: this
 * one is a flat ceiling on a single batched probe, not a run of empties. It is
 * what MetaMask itself offers when it restores a phrase, so a user who created
 * Account 2..20 there finds all of them here, and one address beyond the last
 * used one costs nothing (the whole scan is ONE JSON-RPC batch per chain).
 */
export const EVM_ACCOUNT_SCAN_MAX = 20;

/**
 * Highest receive index a scan will EVER look at, whatever the server claims.
 * Deliberately derived from MAX_RECEIVE_ADDRESSES rather than chosen separately:
 * a used address above the cap could never be derived by allKeys(), so
 * discovering one would persist a count the wallet immediately clamps away,
 * hiding exactly the funds the scan exists to find. Tying them makes the two
 * bounds impossible to drift apart.
 */
export const MAX_SCAN_INDEX = MAX_RECEIVE_ADDRESSES - 1;

/**
 * Consecutive FAILED history reads that abandon a scan. A failed read is
 * inconclusive rather than empty (see discoverUsedAddresses), so without this an
 * offline wallet would walk every index up to the ceiling before giving up.
 * Small enough to fail fast on a dead connection, large enough to ride out one
 * flaky response.
 */
const MAX_CONSECUTIVE_READ_FAILURES = 5;

/** Outcome of a gap-limit receive-address discovery scan. */
export interface AddressScanResult {
  /** How many receive indices were actually queried. */
  scanned: number;
  /** Highest index found to have on-chain history, or -1 when none did. */
  highestUsedIndex: number;
  /** The wallet's derived-address count before the scan. */
  addressCountBefore: number;
  /** The count after (never lower than before, never above the cap). */
  addressCountAfter: number;
  /** Indices whose history could not be read. Counted, never treated as empty. */
  failedReads: number;
  /** True ONLY when the scan reached the BIP44 gap limit with every index
   *  answered. False means the answer is a lower bound: the hard ceiling stopped
   *  it, the connection died, or at least one address could not be read. */
  complete: boolean;
}

/** Knobs for discoverUsedAddresses(). */
export interface DiscoverAddressesOptions {
  /** Called after each index is examined, so a UI can show live progress. */
  onProgress?: (progress: { scanned: number; highestUsedIndex: number }) => void;
}

/** The fixed (empty) passphrase used for a passwordless wallet's vault. Keeps the
 *  storage format uniform (still AES-GCM, never literal plaintext) while requiring
 *  no user secret. This is convenience, not protection — documented to the user. */
const NO_PASSWORD = '';

/**
 * What a SEED wallet's vault decrypts to.
 *
 * BACKWARD COMPATIBILITY BY CONSTRUCTION, NOT BY MIGRATION. Every wallet ever
 * written by an earlier build stored the bare mnemonic string, and a wallet with
 * NO BIP39 passphrase still does, byte for byte. Only a wallet that actually has
 * a passphrase is stored as this envelope. So there is no upgrade step that can
 * fail, existing vaults are never rewritten, and an older build can still open
 * every wallet it could open before.
 *
 * The discriminator is safe: a BIP39 mnemonic is wordlist words separated by
 * spaces and a WIF is base58, so neither can ever begin with '{'.
 *
 * The one honest limit: a wallet imported WITH a passphrase cannot be read by an
 * older build. That is not a regression, because an older build could not derive
 * that wallet's addresses in the first place.
 */
interface SeedSecretEnvelope {
  v: 1;
  mnemonic: string;
  /** BIP39 passphrase, the "25th word". Part of KEY DERIVATION, not a password. */
  passphrase: string;
}

/** Vault payload for a seed wallet. Bare mnemonic when there is no passphrase. */
export function encodeSeedSecret(mnemonic: string, passphrase: string): string {
  if (!passphrase) return mnemonic;
  const envelope: SeedSecretEnvelope = { v: 1, mnemonic, passphrase };
  return JSON.stringify(envelope);
}

/** Inverse of encodeSeedSecret. Anything unrecognised is treated as a bare
 *  mnemonic, so a malformed or future payload degrades to today's behaviour
 *  instead of throwing on unlock and locking the user out of their wallet. */
export function decodeSeedSecret(secret: string): { mnemonic: string; passphrase: string } {
  if (!secret.startsWith('{')) return { mnemonic: secret, passphrase: '' };
  try {
    const parsed = JSON.parse(secret) as Partial<SeedSecretEnvelope>;
    if (parsed && parsed.v === 1 && typeof parsed.mnemonic === 'string') {
      return {
        mnemonic: parsed.mnemonic,
        passphrase: typeof parsed.passphrase === 'string' ? parsed.passphrase : '',
      };
    }
  } catch {
    // Not our envelope; fall through and treat the whole string as the mnemonic.
  }
  return { mnemonic: secret, passphrase: '' };
}

/** Persisted multi-wallet store (storage key `liveWallets`). */
interface LiveWalletsStore {
  version: 1;
  wallets: WalletEntry[];
  activeId: string;
  /**
   * The OPTIONAL app-password record (the app-password design notes §3). Absent on
   * every install that never set one, which is why nothing else in this file
   * changes behaviour for those users.
   *
   * DELIBERATELY A FIELD OF THIS OBJECT rather than a storage key of its own.
   * The design says "stored beside the wallet list"; a sibling KEY would make an
   * app-password change two writes, and there is no ordering of those two writes
   * that is safe: write the record first and a failed second write leaves every
   * v2 wallet key wrapped under a master key the record no longer derives; write
   * the wallets first and the same happens in reverse. Both outcomes are
   * unopenable wallets. In one object the change is ONE atomic write, and the
   * only two states are "before" and "after".
   *
   * It holds NO key material: a salt, KDF params and a check blob (see appKey.ts).
   * An older build reads `wallets`/`activeId` and ignores this field, so its
   * presence alone strands nothing.
   */
  appKey?: AppKeyRecord;
  /**
   * MONOTONIC WRITE COUNTER, bumped by every write this file makes. It is what
   * makes a whole-store write a compare-and-swap instead of a hope.
   *
   * WHY IT HAS TO EXIST. Every extension page (popup, side panel, detached
   * window) runs its own LiveWalletService over ONE `liveWallets` object, and a
   * write here replaces that whole object. So "read, spend 300 ms in scrypt,
   * write the snapshot back" erases everything another page did in between: an
   * adversarial review turned that shape into a newly imported wallet, seed and
   * all, simply ceasing to exist. Re-reading before the write narrows the window
   * but cannot close it, because there is still a window. Refusing a write whose
   * base is no longer the current revision closes it: the write cannot land on a
   * store it was not computed from, and updateStore() re-reads and re-applies.
   *
   * WHERE IT LIVES, and why it costs an existing install nothing. It is an
   * optional field of THIS object, exactly like `appKey` above: an older build
   * reads `wallets`/`activeId` and ignores it, so its presence strands nothing,
   * and it touches no `WalletEntry` and no vault. It is written only when the
   * store is written, so installing the update writes nothing and every read
   * path leaves storage byte for byte as it was. A store from a build that never
   * had it reads as revision 0 and gets its 1 on the next write.
   */
  rev?: number;
}

/** The revision a store is AT. A store that predates the field (or a key that is
 *  not there at all) is revision 0, so the first write under this build is 1. */
function storeRev(store: LiveWalletsStore | undefined | null): number {
  const rev = store?.rev;
  return typeof rev === 'number' && Number.isFinite(rev) ? rev : 0;
}

/**
 * Returned by an updateStore() mutator that has decided there is nothing to
 * write. The store is then left exactly as it is, and no revision is burned.
 */
const NO_WRITE: unique symbol = Symbol('no-write');

/** Thrown by writeStore() when storage moved under a prepared write. It never
 *  escapes updateStore(), which answers it by re-reading and re-applying. */
class StoreConflictError extends Error {
  constructor() {
    super('store-conflict');
    this.name = 'StoreConflictError';
  }
}

/** How many times updateStore() re-reads and re-applies before giving up. A
 *  conflict means ANOTHER PAGE wrote between this page's read and its write, and
 *  pages write on human actions, so a second conflict is already implausible.
 *  The bound is only here so a pathological loop cannot hang the popup.
 *
 *  Running it out throws StoreWriteFailedError, which is a DIFFERENT type from
 *  the internal conflict above on purpose: it means the store was left untouched
 *  and the user's action did not happen, and every caller owes them that answer
 *  rather than "your password is wrong" or silence. */
const STORE_WRITE_ATTEMPTS = 6;

/** Public, secret-free view of a wallet returned by listWallets(). */
export interface WalletSummary {
  id: string;
  name: string;
  network: string;
  createdAt: number;
  active: boolean;
  /** 'seed' or 'pk' — lets the UI show wallet type + which secrets are revealable. */
  kind: WalletKind;
  /** Public primary address ('' if not yet known for a never-unlocked migrated wallet). */
  address: string;
  /** True when the wallet has no password (unlocks + sends without one). Only
   *  ever true for a v1 vault: see WalletEntry.passwordless. */
  passwordless: boolean;
  /** Present (and true) ONLY for a wallet whose vault is app-key protected (v2).
   *  Absent on every wallet of an install with no app password, which keeps a
   *  v1 summary's key set byte-identical to what it has always been. */
  appProtected?: boolean;
  /** Present (and true) only when the wallet keeps the old "do not ask when
   *  sending" convenience after migrating to the app key (§6). */
  noSendPassword?: boolean;
  /** Chain family, resolved (absent on the entry = 'utxo'). The store scopes
   *  every chain-shaped helper by this, so an EVM account is never fed to the
   *  UTXO chain registry and vice versa. */
  family: WalletFamily;
  /** EVM only: last shown chain key. Undefined for UTXO wallets. */
  evmChainKey?: string;
  /** EVM seed accounts only: address index (MetaMask "Account hdIndex+1"). */
  hdIndex?: number;
  /** EVM seed accounts only: the seed's index-0 address, lowercased (groups accounts). */
  seedGroup?: string;
}

/**
 * What changeAppPassword() answers. A bare boolean could not tell "you mistyped
 * the current password" apart from "one wallet's wrapped key is unreadable", and
 * the UI showed the first message for both: the user retyped a password that was
 * already right while the real problem went unnamed.
 */
export type AppPasswordChangeResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'empty-password' // no new password was given
        | 'no-app-password' // there is no app record to change
        | 'wrong-password' // the CURRENT app password is not this one
        | 'wallet-unreadable' // a v2 wallet's key could not be re-wrapped
        | 'write-failed'; // nothing was written; the store is untouched
      /** The wallet that could not be re-wrapped ('wallet-unreadable' only). */
      wallet?: string;
    };

/**
 * What createRecoveryCode() answers (the app-password design notes §13).
 *
 * The code is in the SUCCESS branch and nowhere else, because that string is
 * the only copy that will ever exist: it is not stored, it cannot be shown
 * again, and a caller that drops it has destroyed it.
 */
export type RecoveryCodeResult =
  | { ok: true; code: string }
  | {
      ok: false;
      reason:
        | 'no-app-password' // nothing to attach a code to
        | 'wrong-password' // the app password given is not the one
        | 'wallet-unreadable' // a v2 wallet's key could not be re-wrapped
        | 'write-failed'; // nothing was written; the store is untouched
      wallet?: string;
    };

/** What unlockWithRecoveryCode() answers. */
export type RecoveryUnlockResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'no-app-password'
        | 'no-recovery-code' // this device has no code set
        | 'wrong-code'
        | 'empty-password' // no NEW password was given
        | 'write-failed';
    };

/** What a decrypted backup file turns out to hold. Names only what the user
 *  needs to decide, and it is produced only AFTER the file has been opened, so
 *  none of it is readable from the file itself (§13.7). */
export interface BackupPreview {
  /** When the file was written (ISO 8601, from the envelope). */
  createdAt: string;
  /** The wallets inside it. */
  wallets: Array<{ id: string; name: string; network: string; address: string }>;
  /** Wallets on THIS device that the file does not have. A replace destroys
   *  exactly these, which is why they are named on the confirmation. */
  losing: Array<{ id: string; name: string; network: string }>;
  /** Wallets in the file that this device does not have. */
  gaining: number;
  /**
   * True when the file's app-key record is the one on this device, so every v2
   * wallet inside it opens under the master key already here and merging is
   * SAFE rather than merely plausible (§13.8).
   */
  canMerge: boolean;
  /** True when this device has no wallets at all, so nothing can be lost. */
  deviceEmpty: boolean;
}

/** What restoring a backup answers. */
export type BackupRestoreResult =
  | { ok: true; wallets: number }
  | { ok: false; reason: 'no-pending' | 'merge-unsafe' | 'write-failed' };

/** Storage key for the multi-wallet store. */
const WALLETS_KEY = 'liveWallets';
/** Legacy single-wallet key. Read once for migration; never written again. */
const LEGACY_KEY = 'liveWallet';

/**
 * A backup file is data from OUTSIDE the wallet, so what comes out of it is
 * checked before it is allowed anywhere near a write. Not a deep validation of
 * every field (a wallet entry has many optional ones, and an entry written by a
 * newer build must survive a round trip through an older one) but of the shape
 * the store cannot function without.
 */
function validateRestoredStore(value: unknown): value is LiveWalletsStore {
  if (!value || typeof value !== 'object') return false;
  const store = value as Partial<LiveWalletsStore>;
  if (!Array.isArray(store.wallets)) return false;
  if (store.wallets.length > MAX_RESTORED_WALLETS) return false;
  for (const w of store.wallets) {
    if (!w || typeof w !== 'object') return false;
    if (typeof w.id !== 'string' || !w.id) return false;
    if (typeof w.name !== 'string') return false;
    if (typeof w.network !== 'string') return false;
    if (!w.vault || typeof w.vault !== 'object') return false;
  }
  if (new Set(store.wallets.map((w) => w.id)).size !== store.wallets.length) return false;
  if (store.appKey !== undefined) {
    const k = store.appKey as AppKeyRecord;
    if (!k || (k.version !== 1 && k.version !== 2)) return false;
  }
  // A v2 vault's key is wrapped under the master key of an app record. A file
  // carrying v2 wallets and NO record is a file of wallets nothing can ever
  // open, and restoring it would be handing the user an empty box that looks
  // full. Refuse it as malformed rather than write it.
  if (store.wallets.some((w) => isVaultRecordV2(w.vault)) && !store.appKey) return false;
  return true;
}

/**
 * Is this the SAME app-key record on both sides?
 *
 * The one condition under which merging a backup is safe (§13.8): identical
 * record means identical master key, so every v2 wallet in the file opens with
 * the key this device already has. Compared on the fields that make a record
 * what it is; two independently created records agree on none of them, because
 * both the salt and the check blob's IV are 16 and 12 random bytes.
 *
 * Both sides having NO record is also a match: every wallet is then v1, opening
 * with its own password, and merging cannot strand any of them.
 */
function sameAppKeyLineage(a: AppKeyRecord | undefined, b: AppKeyRecord | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.version === b.version &&
    a.salt === b.salt &&
    a.check.iv === b.check.iv &&
    a.check.ciphertext === b.check.ciphertext
  );
}

/** A hostile or corrupt file must not be able to ask for an unbounded loop of
 *  wallet work. Far above any real install. */
const MAX_RESTORED_WALLETS = 200;

/** Generate a stable, persisted wallet id. Prefers crypto.randomUUID() when the
 *  runtime exposes it; otherwise falls back to a monotonic counter over the
 *  existing ids (no Date.now()/Math.random() dependency). */
function genWalletId(existingIds: Set<string>): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    let id: string = crypto.randomUUID();
    while (existingIds.has(id)) id = crypto.randomUUID();
    return id;
  }
  let n = existingIds.size + 1;
  let id = `w-${n}`;
  while (existingIds.has(id)) {
    n += 1;
    id = `w-${n}`;
  }
  return id;
}

// SECURITY: fee rates come from an UNTRUSTED Electrum server (estimatefee), so
// every rate is clamped into the ACTIVE chain's [floor, ceiling] policy band and
// every built tx's absolute fee is independently capped by assertFeeSane — see
// feePolicy.ts for the logic and chainParams.CHAIN_FEE_POLICIES for the measured
// per-chain values. There is deliberately NO global fee constant here anymore:
// the old single 1000 sat/byte ceiling clamped Evrmore's measured 1626 and
// Ravencoin's 1041 estimate to EXACTLY their 1000 relay floor (zero headroom
// against a relay-floor rise) while allowing a hostile server ~1000× Bitcoin's
// real next-block rate. One number cannot serve six chains.

/** Re-exported so UI/store code can type the estimateFeeOptions() result
 *  without reaching into feePolicy.ts directly. */
export type { FeeEstimate, FeeOption } from './feePolicy';

/** Optional fee knobs for the build/estimate methods. */
export interface SendFeeOptions {
  /** Chosen rate in sat/byte — e.g. an option picked from estimateFeeOptions().
   *  ALWAYS re-clamped into the active chain's [floor, ceiling] policy band, so
   *  a UI bug or poisoned store value can neither exceed the anti-drain ceiling
   *  nor undercut the chain's relay floor. Omitted => the wallet probes the
   *  server at the 6-block target as before. */
  feeRateSatPerByte?: bigint;
}

/**
 * The txid of a signed transaction, computed LOCALLY and defensively.
 *
 * Prefers the witness-free serialization, which is what a txid is defined over.
 * If the bytes cannot be parsed for any reason this falls back to hashing them
 * as-is: this runs on the broadcast path, where the transaction is already
 * signed, so refusing to compute an id must never be what stops it being sent.
 */
function localTxidOf(rawHex: string): string {
  try {
    return txid(parseTx(rawHex).strippedHex);
  } catch {
    return txid(rawHex);
  }
}

export interface LiveSendPlan {
  built: BuiltTx;
  toAddress: string;
  amountSats: bigint;
  feeSats: bigint;
  /** Undefined for a plain EVR send; the asset name for an asset transfer. */
  assetName?: string;
  /** For an asset send: the asset's decimals (for display formatting). */
  assetDecimals?: number;
}

export class BroadcastGatedError extends Error {
  constructor() {
    super('Broadcast is disabled. Live sending must be explicitly armed (mainnet safety gate).');
    this.name = 'BroadcastGatedError';
  }
}

// ---------------------------------------------------------------------------
// Broadcast outcome verification
//
// A broadcast RPC failing does NOT always mean the tx wasn't sent. Real
// incident: an Electrum server crashed its broadcast handler (-32603 internal
// server error) AFTER already accepting the tx into its mempool — the wallet
// showed a raw error, but the transaction had actually reached the chain.
//
// Only a CLEAN daemon rejection is a definitive "not sent" outcome: Electrum
// returns `{"code":1,"message":"the transaction was rejected by network
// rules.\n\n<reason>..."}` (verified live against both the Evrmore and
// Ravencoin servers), which electrumClient.ts turns into
// `Error("Electrum error: the transaction was rejected by network rules...
// (code 1)")`. Any OTHER broadcast error (a crash, a timeout, a dropped
// connection) leaves the outcome UNKNOWN, and an unknown outcome must never be
// reported as a plain failure — we poll the chain for the tx before deciding.

/** True only for a clean, definitive daemon rejection (Electrum error code 1,
 *  "rejected by network rules"). Any other error's outcome is UNKNOWN. */
function isCleanBroadcastRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rejected by network rules/i.test(msg);
}

/** A transaction id as both sides write it: exactly 64 hex characters. */
const TXID_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * Does the server's answer to `blockchain.transaction.broadcast` name the SAME
 * transaction we signed?
 *
 * An honest server computes the txid itself from the bytes we handed it, so its
 * answer is character-for-character the id we already computed locally and this
 * is true with no extra work. A hostile or buggy server can instead swallow the
 * transaction and answer a plausible-looking id, which would show the user a
 * "sent" transaction and a transaction id that is not theirs. Compared trimmed
 * and case-insensitively; an answer that is not a 64-hex id at all (empty, a
 * status word, an object) is a mismatch, never a match.
 */
function broadcastAnswerMatches(answer: unknown, expectedTxid: string): boolean {
  if (typeof answer !== 'string') return false;
  const got = answer.trim().toLowerCase();
  if (!TXID_HEX_RE.test(got)) return false;
  return got === expectedTxid.trim().toLowerCase();
}

/** Poll cadence for an UNKNOWN broadcast outcome: 8 attempts with a growing
 *  delay, ~45s total. Overridable via the constructor so tests can shrink it. */
const DEFAULT_BROADCAST_POLL_DELAYS_MS = [1000, 2000, 3000, 4000, 6000, 8000, 10000, 11000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LiveWalletService implements WalletEngine {
  /** This engine is the UTXO family; the EVM engine sits beside it (engine.ts). */
  readonly family = 'utxo' as const;
  /** ACTIVE seed-wallet: BIP39 seed in memory (null when locked or a pk-wallet). */
  private seed: Uint8Array | null = null;
  /** ACTIVE pk-wallet: raw private key in memory (null when locked or a seed-wallet). */
  private pk: Uint8Array | null = null;
  /**
   * The app MASTER KEY (32 bytes), or null when the app is locked / no app
   * password exists.
   *
   * SAME RULES AS THE SEED, no exceptions: page memory only, never written to
   * storage, never sent to the service worker or a content script, never logged,
   * and ZEROED on lockApp(). It is held as raw bytes rather than as a
   * non-extractable CryptoKey so the buffer can be overwritten on lock (see
   * appKey.ts's header for exactly what that does and does not buy).
   *
   * It deliberately survives lock() (a wallet switch): the whole point of the
   * app password is that choosing another migrated wallet does not ask again.
   * Only lockApp() drops it.
   *
   * IT IS A CLAIM ABOUT A RECORD, NOT A FACT. Every extension page (popup, side
   * panel, detached window) runs its OWN LiveWalletService over ONE shared
   * storage, and changeAppPassword() in any of them replaces `store.appKey`
   * while every other page keeps the key it derived from the record that just
   * went away. So this key is never trusted against a record without first
   * re-establishing the binding: masterKeyForStore() proves it opens the CURRENT
   * record's check blob, and drops it when it does not. Wrapping a wallet key
   * under a stale master key is the one mistake in this file that destroys a
   * seed rather than merely refusing to open one.
   */
  private masterKey: Uint8Array | null = null;
  /**
   * The `salt` of the app record `masterKey` was derived FROM, kept beside it so
   * the key is bound to a record and not merely to a blob.
   *
   * The check blob alone is not that binding. `masterKeyMatchesRecord` proves
   * "this key opens this record's check", and a record whose SALT has been
   * swapped while its check blob was kept still passes: exactly one hostile edit
   * of storage, and the reward for it is permanent. The cached key then wraps a
   * seed into a v2 record in the same write that discards the v1 one, and the
   * salt on disk derives a different key, so no password opens the words again.
   * `store.appKey.salt === this.masterKeySalt` is the other half of the claim,
   * and it costs nothing: the salt is public, it is already in hand, and it is
   * the one field the derivation actually depends on.
   *
   * Null exactly when `masterKey` is null. It holds no secret (a salt is public);
   * it is here only so the two are set and cleared together.
   */
  private masterKeySalt: string | null = null;
  /**
   * A backup file that has been decrypted and described but NOT applied.
   *
   * Held here rather than in the UI because it contains vault records, and for
   * a `passwordless` wallet a vault record is a seed under an empty passphrase.
   * Session-scoped and never persisted: closing the popup forgets it, which is
   * the correct outcome for a restore nobody confirmed.
   */
  private pendingRestore: { store: LiveWalletsStore; preview: BackupPreview } | null = null;
  /** Compression flag of the active pk-wallet's key (matches its source WIF). */
  private pkCompressed = true;
  /** Kind of the ACTIVE wallet, so derive/reveal branch correctly. */
  private activeKind: WalletKind = 'seed';
  private net: EvrmoreNetwork = EVRMORE_MAINNET;
  /** The active wallet's stored network id (LiveNetworkId), tracked alongside
   *  `net`. `net.id` alone can't carry it: Ravencoin mainnet also has net.id
   *  'mainnet', so we keep the canonical LiveNetworkId here for network(). */
  private activeNetworkId: LiveNetworkId = 'mainnet';
  /** Family of the ACTIVE wallet. 'utxo' for every wallet stored before the EVM
   *  engine. When 'evm', `net`/`activeNetworkId` still describe the LAST UTXO
   *  chain (the Electrum side is simply idle) and `activeEvmChainKey` says which
   *  EVM chain the UI is showing; the address does not depend on it. */
  private activeFamily: WalletFamily = 'utxo';
  private activeEvmChainKey: string | null = null;
  /** The ACTIVE entry's EVM address index (its `hdIndex`, absent = 0). Cached
   *  here for the same reason as the network and the family: every derive path
   *  (address, signing key, reveal) is synchronous and cannot re-read the store,
   *  and deriving index 0 for an "Account 2" entry would show and sign for the
   *  WRONG address. Always 0 for a 'pk' or UTXO wallet. */
  private activeHdIndex = 0;
  /** The EVM modules, loaded through the build flag the first time an EVM wallet
   *  is created, imported or unlocked. Null until then, and forever null in a
   *  build without the engine (every EVM operation then refuses clearly). */
  private evm: EvmModules | null = null;
  /**
   * The wallet THIS PAGE is on. Every "the ACTIVE wallet" method in this file
   * means this one, and activeWalletId() answers it synchronously.
   *
   * IT IS SESSION STATE, NOT STORE STATE, and that distinction is the whole
   * point. `store.activeId` is ONE field shared by every extension page; the
   * secret in this service's memory, the chain it derives on and the address
   * index it derives at belong to exactly one wallet, the one this page
   * activated. Reading "the active wallet" back out of the shared store let
   * another window's switch repoint a page mid-action: addReceiveAddress()
   * handed the user an address derived from THIS page's seed while raising the
   * OTHER wallet's `addressCount`, so the address shown was never scanned by
   * the wallet that owns it and coins sent there could go unseen. changePassword
   * put the new password on whichever wallet the store called active.
   *
   * WHAT SETS IT: activateEntry(), i.e. every deliberate activation this page
   * makes (create, import, unlock, switch, add account, promotion after a
   * removal). A page that has activated nothing yet -- a freshly constructed
   * service, which is what the popup, the side panel and a dApp approval page
   * each are -- ADOPTS the store's `activeId` on its first read, which is what
   * keeps a fresh service correct. After that it moves only when this page moves
   * it, and re-adopts only when its wallet is gone from the store (another page
   * removed it). On an install with one wallet the two are always the same id.
   */
  private activeId: string | null = null;
  private client: ElectrumClient;
  private provider: ElectrumWalletDataProvider;
  /** Delays (ms) between poll attempts used to resolve an UNKNOWN broadcast
   *  outcome. Defaults to ~45s total spread over 8 attempts; a test may pass
   *  a short array via the constructor to keep the suite fast. */
  private readonly broadcastPollDelaysMs: number[];

  /** HARD SAFETY GATE. Must be set true by an explicit user action before any
   *  real broadcast. Defaults false; building/signing for review is always ok. */
  allowBroadcast = false;

  constructor(
    client: ElectrumClient = createElectrumClient(),
    options?: { broadcastPollDelaysMs?: number[] },
  ) {
    this.client = client;
    this.provider = new ElectrumWalletDataProvider(client, {
      networkId: 'mainnet',
      network: EVRMORE_MAINNET,
    });
    this.broadcastPollDelaysMs = options?.broadcastPollDelaysMs ?? DEFAULT_BROADCAST_POLL_DELAYS_MS;
  }

  // --- multi-wallet store -------------------------------------------------

  /** Load the multi-wallet store, migrating a legacy single-wallet install on
   *  first access. Always refreshes the cached active id. */
  private async loadStore(): Promise<LiveWalletsStore> {
    const existing = await getStorage().get<LiveWalletsStore>(WALLETS_KEY);
    if (existing && Array.isArray(existing.wallets)) {
      // THE PAGE KEEPS ITS OWN WALLET (see `activeId`). A page that has not
      // activated one yet adopts the store's, and so does one whose wallet has
      // been removed from under it; otherwise a switch in another window would
      // repoint this page's chain, address index and derivation mid-action.
      const kept =
        this.activeId && existing.wallets.some((w) => w.id === this.activeId) ? this.activeId : null;
      this.activeId = kept ?? (existing.activeId || null);
      // Make the active chain follow the active wallet on load (before any
      // unlock) so network()/marker/magic are correct for a stored RVN wallet.
      const active = existing.wallets.find((w) => w.id === this.activeId);
      if (active) this.activateEntry(active);
      return existing;
    }

    // Migration: a pre-multi-wallet install has a single `liveWallet` record.
    // Wrap it as "Wallet 1" and persist under the new key. The old key is left
    // untouched (harmless) so a downgrade wouldn't lose data.
    const legacy = await getStorage().get<LiveWalletMeta>(LEGACY_KEY);
    if (legacy && legacy.vault) {
      const id = genWalletId(new Set());
      const store: LiveWalletsStore = {
        version: 1,
        wallets: [
          {
            id,
            name: 'Wallet 1',
            network: legacy.network,
            vault: legacy.vault,
            createdAt: legacy.createdAt,
          },
        ],
        activeId: id,
        rev: 1,
      };
      await getStorage().set(WALLETS_KEY, store);
      this.activeId = id;
      return store;
    }

    this.activeId = null;
    return { version: 1, wallets: [], activeId: '' };
  }

  /**
   * THE ONLY WAY ANYTHING IN THIS FILE WRITES THE WALLET STORE, and the reason
   * every caller is correct without having to remember to be.
   *
   * `mutate` is handed a store read MOMENTS ago and changes it in place. What is
   * written is that same object, and only if storage is still at the revision it
   * was read at. If another page wrote in between, the prepared write is thrown
   * away, the store is READ AGAIN and `mutate` is called AGAIN on the fresh one.
   *
   * THE CONTRACT ON `mutate`, and it is the whole discipline:
   *   - it MAY RUN MORE THAN ONCE, so it must decide everything from the store
   *     it is handed. Anything computed from an earlier read (a wallet id, a
   *     wallet count, "the active wallet") is stale by definition and must be
   *     recomputed inside, or pinned by id and re-found inside.
   *   - anything EXPENSIVE (scrypt) that a retry should not repeat belongs
   *     outside, and then what it produced must be re-validated inside against
   *     the fresh store, because it was computed from a store that has moved.
   *   - returning NO_WRITE abandons the write with the store untouched.
   *   - throwing abandons the write and propagates.
   *
   * WHEN THE RETRIES RUN OUT it throws StoreWriteFailedError, and nothing was
   * written. That is a real answer, not an internal detail: it means another
   * page kept writing and this action did not happen, which is neither the
   * user's mistake nor a success. Callers must not fold it into their own
   * "that did not work" answer, and must not swallow it.
   *
   * What this replaces: `const store = await this.loadStore(); ...; await
   * this.saveStore(store)`, which writes the WHOLE object from a snapshot taken
   * before the slow part and so erases whatever another page did in that window.
   */
  private async updateStore<T>(
    mutate: (store: LiveWalletsStore) => T | typeof NO_WRITE | Promise<T | typeof NO_WRITE>,
  ): Promise<T | typeof NO_WRITE> {
    for (let attempt = 1; ; attempt++) {
      const store = await this.loadStore();
      const baseRev = storeRev(store);
      const result = await mutate(store);
      if (result === NO_WRITE) return NO_WRITE;
      try {
        await this.writeStore(store, baseRev);
      } catch (err) {
        if (err instanceof StoreConflictError) {
          if (attempt < STORE_WRITE_ATTEMPTS) continue;
          // Out of attempts. Nothing has been written, and the caller is told
          // that in a type it can tell apart from every other failure.
          throw new StoreWriteFailedError();
        }
        throw err;
      }
      return result;
    }
  }

  /**
   * Write `store` back, but ONLY if storage is still at `baseRev`; otherwise
   * refuse, because this object was computed from a store that no longer exists
   * and writing it would delete whatever replaced it.
   *
   * This is a compare-and-swap over a key-value store that has no CAS of its
   * own, so the comparison and the write are two calls, not one. What remains is
   * the few microseconds between them, against the hundreds of milliseconds of
   * scrypt that the old shape left open; and every path that could lose a seed
   * in that sliver still refuses rather than guesses (the migration re-checks the
   * v1 record it decrypted, changeAppPassword re-checks the record it derived
   * from). Private: updateStore() is the entry point, so no caller can hold a
   * snapshot across a write by accident.
   */
  private async writeStore(store: LiveWalletsStore, baseRev: number): Promise<void> {
    const current = await getStorage().get<LiveWalletsStore>(WALLETS_KEY);
    if (storeRev(current) !== baseRev) throw new StoreConflictError();
    store.rev = baseRev + 1;
    await getStorage().set(WALLETS_KEY, store);
    // DELIBERATELY DOES NOT TOUCH `this.activeId`. A write is not an
    // activation: `store.activeId` here is whatever the SHARED store said,
    // which for a rename or an address-count bump is another page's choice.
    // Every mutator that really does move this page's wallet ends in
    // activateEntry(), which is the one thing that sets it.
  }

  /** The entry THIS PAGE is on, inside `store`. Resolved from the session's own
   *  id, never from the store's shared `activeId` (see `activeId` above). Every
   *  caller hands in a store that came from loadStore(), which is what
   *  guarantees the session id is resolved before this is asked. */
  private sessionEntry(store: LiveWalletsStore): WalletEntry | undefined {
    const id = this.activeId ?? store.activeId;
    return store.wallets.find((w) => w.id === id);
  }

  /** The id of the wallet THIS PAGE is on, adopting the store's active wallet
   *  when this service has activated nothing yet. Null when there is no wallet
   *  to be on. Callers pin this id and then re-find the entry BY ID inside the
   *  write, so a mutator that is re-applied cannot drift onto another wallet. */
  private async sessionWalletId(): Promise<string | null> {
    await this.loadStore();
    return this.activeId;
  }

  /** Point the service at `entry`: its family, and for a UTXO wallet its chain
   *  (Electrum pool, params, magic). Every place that activates a wallet routes
   *  through here so family, chain and the SESSION'S wallet id always follow the
   *  wallet together. */
  private activateEntry(
    entry: Pick<WalletEntry, 'id' | 'network' | 'family' | 'evmChainKey' | 'hdIndex'>,
  ): void {
    this.activeId = entry.id;
    this.activeFamily = entry.family ?? 'utxo';
    // An entry stored before EVM accounts existed has no hdIndex; it IS index 0.
    this.activeHdIndex = entry.hdIndex ?? 0;
    if (this.activeFamily === 'evm') {
      // The Electrum side stays where it was (idle): an EVM account has no
      // UTXO chain, and re-pointing the pool at 'evm' would resolve to Evrmore.
      this.activeEvmChainKey = entry.evmChainKey ?? null;
      return;
    }
    this.activeEvmChainKey = null;
    this.setActiveNetwork(this.utxoNetworkOf(entry.network));
  }

  /** The UTXO chain id of a stored `network`, for a wallet that IS utxo. An EVM
   *  sentinel here is a family-blind caller's bug and resolves to Evrmore mainnet
   *  only for read paths that cannot get here (every activation is family-gated). */
  private utxoNetworkOf(network: StoredNetworkId): LiveNetworkId {
    return network === EVM_NETWORK ? 'mainnet' : network;
  }

  /** The EVM modules, loading them through the build flag on first use. Throws a
   *  clear error in a build without the engine, so an EVM wallet can never be
   *  created, unlocked or signed for by a package that does not carry EVM. */
  private async requireEvm(): Promise<EvmModules> {
    if (this.evm) return this.evm;
    const mods = await loadEvmModules();
    if (!mods) throw new Error('This build of Satori GO has no EVM engine.');
    this.evm = mods;
    return mods;
  }

  /** The EVM modules when an EVM wallet is ACTIVE (they were loaded to activate
   *  it); a synchronous accessor for the address/sign paths that cannot await. */
  private evmModules(): EvmModules {
    if (!this.evm) throw new Error('EVM engine not loaded');
    return this.evm;
  }

  private netFor(network: LiveNetworkId): EvrmoreNetwork {
    switch (network) {
      case 'testnet':
        return EVRMORE_TESTNET;
      case 'ravencoin-mainnet':
        return RAVENCOIN_MAINNET;
      case 'bitcoingold-mainnet':
        return BITCOINGOLD_MAINNET;
      case 'litecoin-mainnet':
        return LITECOIN_MAINNET;
      case 'wojakcoin-mainnet':
        return WOJAKCOIN_MAINNET;
      case 'bitcoin-mainnet':
        return BITCOIN_MAINNET;
      case 'dogecoin-mainnet':
        return DOGECOIN_MAINNET;
      case 'neoxa-mainnet':
        return NEOXA_MAINNET;
      case 'bitcoinblake2b-mainnet':
        return BITCOIN_BLAKE2B_MAINNET;
      case 'mainnet':
      default:
        return EVRMORE_MAINNET;
    }
  }

  /** Set the active in-memory network (both the resolved params and the canonical
   *  LiveNetworkId that network() reports). Every place that activates a wallet
   *  routes through here so the active chain follows the wallet.
   *
   *  Also retargets the shared Electrum client's server pool and the watch-only
   *  provider's native ticker/name at the active chain. When the chain actually
   *  CHANGES we drop the current connection so the next request reconnects against
   *  the new chain's pool (Evrmore and Ravencoin are different hosts with the same
   *  asset dialect; a stale socket must never serve the other chain's reads). */
  private setActiveNetwork(network: LiveNetworkId): void {
    const changed = this.activeNetworkId !== network;
    this.activeNetworkId = network;
    this.net = this.netFor(network);
    this.provider.setNetwork(this.net);
    this.client.setPoolChain?.(network);
    if (changed) {
      try {
        this.client.close();
      } catch {
        // best-effort teardown; the next request reconnects anyway.
      }
    }
  }

  // --- lifecycle (operates on the ACTIVE wallet) --------------------------

  async exists(): Promise<boolean> {
    const store = await this.loadStore();
    return store.wallets.length > 0;
  }

  /**
   * Create a brand-new live wallet, ADD it to the list, make it active and
   * unlock it (seed in memory). Returns the mnemonic ONCE for backup. For the
   * very first wallet this is identical to the old single-wallet behavior.
   *
   * `opts.passphrase` is the BIP39 passphrase (the "25th word"), the SAME field
   * import() takes, routed through the same addWallet(): one way to attach one,
   * not two. Setting it means the returned mnemonic alone no longer restores
   * this wallet, so a caller that offers it owes the user that warning. Omitted
   * or empty is byte-for-byte the old behaviour, down to the bare-mnemonic vault
   * payload encodeSeedSecret() writes.
   */
  async create(
    password: string,
    opts?: {
      network?: LiveNetworkId;
      strength?: 128 | 256;
      name?: string;
      passphrase?: string;
      /** 'evm' creates ONE account that spans every EVM chain, showing
       *  `evmChainKey` first (default: the registry's default chain). */
      family?: WalletFamily;
      evmChainKey?: string;
    },
  ): Promise<{ mnemonic: string }> {
    const mnemonic = generateMnemonic(opts?.strength ?? 128);
    await this.addWallet(mnemonic, password, opts?.network ?? 'mainnet', opts?.name, opts?.passphrase ?? '', {
      family: opts?.family,
      evmChainKey: opts?.evmChainKey,
    });
    return { mnemonic };
  }

  /**
   * Import an existing BIP39 mnemonic as a NEW wallet, make it active + unlock.
   *
   * `passphrase` is the BIP39 passphrase (the "25th word"), which is NOT the
   * wallet password: it feeds the seed derivation, so a different passphrase is
   * a different wallet with different addresses. Omitted/empty behaves exactly
   * as before.
   */
  async import(
    mnemonic: string,
    password: string,
    network: LiveNetworkId = 'mainnet',
    name?: string,
    passphrase = '',
    family?: { family?: WalletFamily; evmChainKey?: string },
  ): Promise<void> {
    const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
    if (!validateMnemonic(trimmed)) throw new Error('Invalid recovery phrase');
    await this.addWallet(trimmed, password, network, name, passphrase, family);
  }

  /** Encrypt the mnemonic, append a seed-wallet entry, set it active and unlock it. */
  private async addWallet(
    mnemonic: string,
    password: string,
    network: LiveNetworkId,
    name?: string,
    passphrase = '',
    family?: { family?: WalletFamily; evmChainKey?: string },
  ): Promise<void> {
    const isEvm = family?.family === 'evm';
    // Load (and thereby require) the engine BEFORE anything is written: a build
    // without it must fail here, not after a vault exists for an unusable wallet.
    const evm = isEvm ? await this.requireEvm() : null;
    const passwordless = password.length === 0;
    const vault = await createVault(
      encodeSeedSecret(mnemonic, passphrase),
      passwordless ? NO_PASSWORD : password,
    );
    const seed = await mnemonicToSeed(mnemonic, passphrase);
    // The id and the default name are the two things that depend on WHAT ELSE is
    // in the store, so they are decided inside the write, on the store the write
    // is actually based on. Another page that added a wallet during the scrypt
    // above would otherwise have handed this one a colliding id.
    const entry = await this.updateStore((store) => {
      const id = genWalletId(new Set(store.wallets.map((w) => w.id)));
      const walletName = name?.trim() || `Wallet ${store.wallets.length + 1}`;
      let created: WalletEntry;
      if (evm) {
        const chainKey =
          family?.evmChainKey && evm.isEvmChainKey(family.evmChainKey)
            ? family.evmChainKey
            : evm.DEFAULT_EVM_CHAIN_KEY;
        // Same seed, coin type 60, index 0: the address MetaMask shows for these words.
        const address = evm.deriveEvmKey(seed, 0).address;
        created = {
          id,
          name: walletName,
          network: EVM_NETWORK,
          vault,
          createdAt: Date.now(),
          kind: 'seed',
          address,
          passwordless,
          family: 'evm',
          evmChainKey: chainKey,
          // This IS Account 1, and its own address names the group every further
          // account of these words joins (the EVM accounts design notes).
          hdIndex: 0,
          seedGroup: address.toLowerCase(),
        };
      } else {
        const net = this.netFor(network);
        const address = deriveAddress(seed, net, 0, 0, 0).address;
        created = { id, name: walletName, network, vault, createdAt: Date.now(), kind: 'seed', address, passwordless };
      }
      store.wallets.push(created);
      store.activeId = id;
      return created;
    });
    if (entry === NO_WRITE) throw new Error('could not save the wallet');
    this.activateEntry(entry);
    this.setActiveSeed(seed);
  }

  /**
   * Import a single private key (WIF or 64-char hex) as a NEW wallet, make it
   * active + unlock it. Unlike a seed wallet this has exactly ONE address — the
   * scheme Satori-network wallets use. The vault stores the canonical WIF.
   */
  async importPrivateKey(
    privateKeyInput: string,
    password: string,
    network: LiveNetworkId = 'mainnet',
    name?: string,
    family?: { family?: WalletFamily; evmChainKey?: string },
  ): Promise<void> {
    if (family?.family === 'evm') return this.importEvmPrivateKey(privateKeyInput, password, name, family.evmChainKey);
    const { privateKey, compressed } = parsePrivateKey(privateKeyInput);
    const net = this.netFor(network);
    // An uncompressed key cannot back a usable native-segwit wallet: the P2WPKH
    // address built from it is unspendable under standard relay policy, and no
    // other wallet derives that address, so accepting the import would strand
    // anything sent to it. Refuse at the import boundary with a message the user
    // can act on, rather than letting the address layer throw a byte-count error.
    // Deliberately NOT silently compressing: the compressed key is a DIFFERENT
    // address, so "helpfully" switching would show a funded-looking wallet that
    // is not where this key's coins actually are.
    if (!compressed && net.addressFormat === 'p2wpkh') {
      throw new Error(
        `This is an uncompressed private key. ${net.displayName} uses native segwit addresses, which require a compressed key.`,
      );
    }
    const derived = privateKeyToDerived(privateKey, net, compressed);
    const passwordless = password.length === 0;
    // Store the canonical WIF (not the user's raw input) so unlock() is uniform.
    const vault = await createVault(derived.wif, passwordless ? NO_PASSWORD : password);
    const created = await this.updateStore((store) => {
      const id = genWalletId(new Set(store.wallets.map((w) => w.id)));
      const walletName = name?.trim() || `Satori wallet ${store.wallets.length + 1}`;
      const entry: WalletEntry = {
        id,
        name: walletName,
        network,
        vault,
        createdAt: Date.now(),
        kind: 'pk',
        address: derived.address,
        passwordless,
      };
      store.wallets.push(entry);
      store.activeId = id;
      return entry;
    });
    if (created === NO_WRITE) throw new Error('could not save the wallet');
    // activateEntry rather than setActiveNetwork(network): same chain, and it is
    // also what makes THIS page's session point at the wallet it just created.
    this.activateEntry(created);
    this.setActivePk(privateKey, compressed);
  }

  /**
   * Import a raw EVM private key (64 hex chars, optional 0x: what MetaMask
   * exports) as a NEW single-address EVM account, make it active and unlock it.
   * A WIF is refused: it is UTXO key material and importing it here would show
   * an address nobody else derives for that key. The vault stores the canonical
   * bare hex so unlock() parses it the same way it parses a seed-wallet's key.
   */
  private async importEvmPrivateKey(
    privateKeyInput: string,
    password: string,
    name?: string,
    evmChainKey?: string,
  ): Promise<void> {
    const evm = await this.requireEvm();
    const trimmed = privateKeyInput.trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new Error('An EVM private key is 64 hex characters (optionally 0x-prefixed).');
    }
    const { privateKey } = parsePrivateKey(trimmed);
    const key = evm.privateKeyToEvmKey(privateKey);
    const chainKey = evmChainKey && evm.isEvmChainKey(evmChainKey) ? evmChainKey : evm.DEFAULT_EVM_CHAIN_KEY;
    const passwordless = password.length === 0;
    const vault = await createVault(bytesToHex(privateKey), passwordless ? NO_PASSWORD : password);
    const entry = await this.updateStore((store) => {
      const id = genWalletId(new Set(store.wallets.map((w) => w.id)));
      const walletName = name?.trim() || `Wallet ${store.wallets.length + 1}`;
      const created: WalletEntry = {
        id,
        name: walletName,
        network: EVM_NETWORK,
        vault,
        createdAt: Date.now(),
        kind: 'pk',
        address: key.address,
        passwordless,
        family: 'evm',
        evmChainKey: chainKey,
      };
      store.wallets.push(created);
      store.activeId = id;
      return created;
    });
    if (entry === NO_WRITE) throw new Error('could not save the wallet');
    this.activateEntry(entry);
    this.setActivePk(privateKey, true);
  }

  // --- the app password (the app-password design notes §3-§6) -----------------
  //
  // OPTIONAL, AND OFF UNTIL THE USER TURNS IT ON. Every method below is inert
  // on an install with no app record: hasAppPassword() is false, masterKey stays
  // null, and unlock()/verifyPassword()/reveal* take exactly the v1 branches
  // they always took.

  /** Is an app password configured on this device? */
  async hasAppPassword(): Promise<boolean> {
    const store = await this.loadStore();
    return !!store.appKey;
  }

  /**
   * THE ONE STATE THE FORCED SETUP SCREEN EXISTS FOR (the app-password design notes
   * §12): at least one wallet opens with NO password at all, and there is no app
   * password on this device to protect it with.
   *
   * `passwordless: true` means the vault is encrypted with an EMPTY passphrase,
   * so that wallet's seed is effectively at rest in the clear and anyone with
   * this computer can spend from it. An app password is the only thing in this
   * release that fixes it, so a user in this state is REQUIRED to set one before
   * the wallet opens. The owner chose that over a dismissible nudge.
   *
   * EXACTLY TWO CONDITIONS, and the third clause is not a third condition:
   * `setAppPassword()` REFUSES while any wallet is already v2 with no app record
   * on disk (a damaged state it deliberately will not bury), so demanding a
   * password there would be demanding something nothing could satisfy: a screen
   * with no way out and no way to the wallet. The trigger and the action it
   * demands must agree, and they do because both ask the same question. That
   * state is unreachable by any path this code has (removeWallet drops the
   * record only with the LAST wallet, when no v2 vault is left), so none of the
   * four real combinations of "passwordless wallet" x "app password" is changed
   * by it.
   *
   * FALSE once an app password exists, even with a passwordless wallet still on
   * v1: that user has a password, was told at their lock screen what moving the
   * wallet over would do, and DECLINED. Re-asking a question already answered is
   * not this screen's job; the transitional prompt keeps offering it.
   */
  async appPasswordRequired(): Promise<boolean> {
    const store = await this.loadStore();
    if (store.appKey) return false;
    if (store.wallets.some((w) => isVaultRecordV2(w.vault))) return false;
    return store.wallets.some((w) => w.passwordless === true);
  }

  /** Is the master key held in memory right now (i.e. the app is unlocked)? */
  appUnlocked(): boolean {
    return this.masterKey !== null;
  }

  /** Replace the in-memory master key, zeroing whatever it displaces. `salt` is
   *  the app record the key was derived FROM; it is kept with the key so the two
   *  can never drift apart, and both go away together. */
  private setMasterKey(key: Uint8Array | null, salt: string | null = null): void {
    if (this.masterKey && this.masterKey !== key) zeroKey(this.masterKey);
    this.masterKey = key;
    this.masterKeySalt = key ? salt : null;
  }

  /**
   * Does the cached master key belong to THIS store's app record?
   *
   * Both halves, and both matter: the record's SALT must be the one the key was
   * derived from (this session's claim about which record it holds a key to),
   * and the key must open that record's check blob (proof it really is that
   * key). The check alone is satisfied by a record whose salt was swapped while
   * its check blob was kept; the salt alone is satisfied by any record carrying
   * that salt. Neither is enough on its own, and together they are one AES-GCM
   * open of 36 bytes plus a string compare, cheap enough to do on every use.
   */
  private async masterKeyBelongsTo(store: LiveWalletsStore): Promise<boolean> {
    if (!this.masterKey || !store.appKey) return false;
    if (store.appKey.salt !== this.masterKeySalt) return false;
    return masterKeyMatchesRecord(store.appKey, this.masterKey);
  }

  /**
   * Set the app password for the FIRST time. Refuses if one already exists
   * (that is changeAppPassword's job) or if the password is empty.
   *
   * MIGRATES NOTHING. Per §5 this step is deliberately risk-free: it writes one
   * record holding a salt, KDF params and a check blob, and every existing
   * wallet is still exactly the v1 record it was a moment ago. Wallets move
   * later, one at a time, as each is opened with its own password.
   *
   * REFUSES WHEN ANY WALLET IS ALREADY v2, even with no app record present. A v2
   * vault's key is wrapped under the master key of the record that is missing;
   * writing a FRESH record over that state does not adopt those wallets, it
   * declares a new key their wrapped keys were never sealed to, and buries the
   * evidence that they were ever protected by anything else. That state is
   * already damaged when it is reached, and this refusal is what keeps it from
   * being made permanent and silent.
   */
  async setAppPassword(password: string): Promise<boolean> {
    if (!password) return false;
    // Refuse cheaply first, so a ~300 ms derivation is not paid to be discarded.
    const before = await this.loadStore();
    if (before.appKey) return false;
    if (before.wallets.some((w) => isVaultRecordV2(w.vault))) return false;
    let created: { record: AppKeyRecord; masterKey: Uint8Array };
    try {
      created = await createAppKeyRecord(password);
    } catch {
      return false;
    }
    let written: true | typeof NO_WRITE;
    try {
      written = await this.updateStore((store) => {
        // Re-asked on the store this write is BASED on, not on the one read
        // before the scrypt: another page may have set an app password, or
        // migrated a wallet to v2, in that window. Both refusals mean the same
        // thing here as above, and both leave every wallet exactly as it is.
        if (store.appKey) return NO_WRITE;
        if (store.wallets.some((w) => isVaultRecordV2(w.vault))) return NO_WRITE;
        store.appKey = created.record;
        return true as const;
      });
    } catch (err) {
      if (isStoreWriteFailed(err)) {
        // Nothing was written, so this key is a key to nothing (as below), and
        // the reason is not "some wallet here is already protected", which is
        // what a bare `false` makes the store say.
        zeroKey(created.masterKey);
        throw err;
      }
      written = NO_WRITE;
    }
    if (written === NO_WRITE) {
      // Nothing was written, so this key is a key to nothing.
      zeroKey(created.masterKey);
      return false;
    }
    // The user just proved this password, so the session holds its master key:
    // the wallets they open from here migrate without a second prompt.
    this.setMasterKey(created.masterKey, created.record.salt);
    return true;
  }

  /** Derive and hold the master key. False on a wrong password or no app record. */
  async unlockApp(password: string): Promise<boolean> {
    const store = await this.loadStore();
    if (!store.appKey) return false;
    try {
      this.setMasterKey(await deriveMasterKey(store.appKey, password), store.appKey.salt);
      return true;
    } catch {
      return false;
    }
  }

  /** Verify the app password WITHOUT changing session state. False if unset. */
  async verifyAppPassword(password: string): Promise<boolean> {
    const store = await this.loadStore();
    if (!store.appKey) return false;
    return verifyAppPassword(store.appKey, password);
  }

  /**
   * Change the app password: re-wrap every v2 wallet key under a new master key
   * and write ONCE.
   *
   * The seed ciphertexts are never touched (rewrapVaultV2 copies them across),
   * and each new wrap is verified with the NEW master key before it is used, so
   * a change cannot leave a wallet unopenable. Wallets still on v1 are left
   * exactly alone: they have their own passwords and migrate later, under the
   * new app password, the same lazy way.
   *
   * On success the master key is DROPPED and the wallet locks (§5): a changed
   * password ends the session it was changed from.
   *
   * FAILURE IS NOT ONE THING. It used to be reported as a bare `false`, which
   * the store rendered as "Incorrect current password." for every cause. A
   * wallet whose wrapped key cannot be re-wrapped (a corrupted or truncated
   * `wrappedKey`) then aborted the change and told the user the password they
   * had just typed correctly was wrong: they retype it forever, the app password
   * can never be changed again, and nothing anywhere names the wallet that is
   * actually broken. The reason is now returned, with the wallet's name where
   * there is one to name.
   */
  async changeAppPassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<AppPasswordChangeResult> {
    if (!newPassword) return { ok: false, reason: 'empty-password' };
    const before = await this.loadStore();
    if (!before.appKey) return { ok: false, reason: 'no-app-password' };
    const fromSalt = before.appKey.salt;
    let oldMaster: Uint8Array;
    try {
      oldMaster = await deriveMasterKey(before.appKey, oldPassword); // throws when wrong
    } catch {
      return { ok: false, reason: 'wrong-password' };
    }
    let created: { record: AppKeyRecord; masterKey: Uint8Array } | null = null;
    let changed = false;
    try {
      // TWO SHAPES, AND THE v2 ONE IS THE CHEAP CASE (the app-password design notes
      // §13.3). A v2 record's master key is random and the password only WRAPS
      // it, so changing the password re-wraps 32 bytes: no vault record is read
      // and none is written, which removes the only operation in this file that
      // could ever damage a seed. It also carries the recovery block across
      // unchanged, which is what makes a recovery code survive a password
      // change at all.
      //
      // A v1 record still works the way it always did: a NEW master key derived
      // from the new password, and every v2 wallet key re-wrapped under it in
      // the same write. That path also promotes the record to v2, so a wallet
      // pays this cost at most once more.
      let newRecord: AppKeyRecord;
      let newMaster: Uint8Array;
      if (isAppKeyRecordV2(before.appKey)) {
        newRecord = await rewrapAppKeyRecord(before.appKey, oldMaster, newPassword);
        newMaster = oldMaster; // the SAME key: v2 changes its wrapping, not it
      } else {
        created = await createAppKeyRecord(newPassword);
        newMaster = created.masterKey;
        newRecord = created.record;
      }
      // Why the RE-WRAP happens inside the write and not before it: the set of
      // v2 wallets is a property of the store, and this method spends two
      // scrypts away from the one it first read. A wallet another page migrated
      // in that window is v2 under the OLD master key, which is in hand here, so
      // it is re-wrapped like any other; and the write can no longer erase a
      // wallet another page imported, because the object written IS the store as
      // it is now.
      let failure: AppPasswordChangeResult | null = null;
      const done = await this.updateStore(async (store) => {
        failure = null; // this attempt decides for itself
        if (!store.appKey) {
          failure = { ok: false, reason: 'no-app-password' };
          return NO_WRITE;
        }
        // The record this change is FROM must still be the record on disk.
        // Another page changing the app password in the window means the
        // password just proved is no longer the current one, and re-wrapping
        // that page's keys under this one's new key would make them unopenable.
        if (
          store.appKey.salt !== fromSalt ||
          !(await masterKeyMatchesRecord(store.appKey, oldMaster))
        ) {
          failure = { ok: false, reason: 'wrong-password' };
          return NO_WRITE;
        }
        // Nothing is ASSIGNED until every re-wrap exists and has verified itself.
        // On a v2 record newMaster IS oldMaster, so there is nothing to re-wrap
        // and this loop is skipped entirely: the wallets are already sealed to
        // the key that is staying.
        const rebuilt: Array<{ entry: WalletEntry; vault: VaultRecordV2 }> = [];
        for (const w of newMaster === oldMaster ? [] : store.wallets) {
          if (!isVaultRecordV2(w.vault)) continue; // v1 wallets are not ours to touch
          try {
            rebuilt.push({ entry: w, vault: await rewrapVaultV2(w.vault, oldMaster, newMaster) });
          } catch {
            // The current password IS right (it opened the record above), so this
            // is this wallet's record being unreadable. Refusing the whole change
            // is still correct (a half-changed store is wallets nobody can open),
            // but the user must be told WHICH wallet, not that they mistyped.
            failure = { ok: false, reason: 'wallet-unreadable', wallet: w.name };
            return NO_WRITE;
          }
        }
        for (const r of rebuilt) r.entry.vault = r.vault;
        store.appKey = newRecord; // ONE write: record + every re-wrapped key
        return true as const;
      });
      if (done === NO_WRITE) return failure ?? { ok: false, reason: 'write-failed' };
      changed = true;
      return { ok: true };
    } catch {
      return { ok: false, reason: 'write-failed' };
    } finally {
      zeroKey(oldMaster);
      if (created) zeroKey(created.masterKey);
      // §5: on a SUCCESSFUL change any cached master key is dropped, so the
      // wallet locks. A failed change (a mistyped current password, a write that
      // did not happen) changed nothing, so it must not lock the user out of a
      // session that is still perfectly valid under the password they still have.
      if (changed) this.lockApp();
    }
  }

  /** Lock the APP: zero the master key, then lock the wallet secret as usual.
   *  This is the user-facing "lock", and the only thing that drops the master
   *  key. A wallet switch uses lock(), which deliberately keeps it. */
  lockApp(): void {
    this.setMasterKey(null);
    this.lock();
  }

  // --- recovery: a code, and a backup file (the app-password design notes §13) -
  //
  // Two answers to one question the wallet could not answer before: what
  // happens when the app password is forgotten. The code answers "I forgot my
  // password"; the file answers "my computer is gone". Neither involves a
  // server, because there is no server that could hold anything (§13.1).

  /** Is a recovery code set on this device? */
  async hasRecoveryCode(): Promise<boolean> {
    const store = await this.loadStore();
    return recordHasRecovery(store.appKey);
  }

  /** When the current recovery code was made (epoch ms), or null if none. */
  async recoveryCodeCreatedAt(): Promise<number | null> {
    const store = await this.loadStore();
    const rec = store.appKey;
    return isAppKeyRecordV2(rec) && rec.recovery ? rec.recovery.createdAt : null;
  }

  /**
   * Make a recovery code, replacing any existing one, and return it ONCE.
   *
   * The returned string is the only copy that will ever exist. Nothing stores
   * it; the record keeps a wrap that only the code opens.
   *
   * TWO PATHS, ONE WRITE. On a v2 record this attaches a second wrap of the
   * master key already in use, and touches no wallet at all. On a v1 record it
   * performs the §13.4 upgrade: a FRESH random master key, every v2 wallet key
   * re-wrapped under it, and the new record, all in one atomic write. The
   * upgrade deliberately does not keep the old key bytes (they are
   * scrypt(the original password), and keeping them would mean a later password
   * change no longer put the old password out of reach).
   *
   * Every scrypt happens BEFORE the write, like changeAppPassword: the mutator
   * does compare-and-swap checks and AES re-wraps only, so the window another
   * page can conflict in stays as small as the existing code makes it.
   */
  async createRecoveryCode(appPassword: string): Promise<RecoveryCodeResult> {
    const before = await this.loadStore();
    if (!before.appKey) return { ok: false, reason: 'no-app-password' };
    const fromSalt = before.appKey.salt;
    let oldMaster: Uint8Array;
    try {
      oldMaster = await deriveMasterKey(before.appKey, appPassword);
    } catch {
      return { ok: false, reason: 'wrong-password' };
    }
    const code = generateRecoveryCode();
    const now = Date.now();
    let upgraded: { record: AppKeyRecordV2; master: Uint8Array } | null = null;
    let block: AppRecoveryBlock | null = null;
    try {
      if (isAppKeyRecordV2(before.appKey)) {
        block = await sealRecoveryBlock(oldMaster, code, now);
      } else {
        const master = generateMasterKey();
        try {
          const record = await createAppKeyRecordForMaster(master, appPassword);
          upgraded = {
            record: { ...record, recovery: await sealRecoveryBlock(master, code, now) },
            master,
          };
        } catch (err) {
          zeroKey(master);
          throw err;
        }
      }
      let failure: RecoveryCodeResult | null = null;
      const done = await this.updateStore(async (store) => {
        failure = null; // this attempt decides for itself
        if (!store.appKey) {
          failure = { ok: false, reason: 'no-app-password' };
          return NO_WRITE;
        }
        // The record this is based on must still be the record on disk: another
        // page changing the app password in the window means the key in hand is
        // no longer the one the wallets are wrapped to.
        if (
          store.appKey.salt !== fromSalt ||
          !(await masterKeyMatchesRecord(store.appKey, oldMaster))
        ) {
          failure = { ok: false, reason: 'wrong-password' };
          return NO_WRITE;
        }
        if (upgraded) {
          // Nothing is ASSIGNED until every re-wrap exists and has verified
          // itself, exactly as in changeAppPassword. A half-upgraded store is
          // wallets nobody can open.
          const rebuilt: Array<{ entry: WalletEntry; vault: VaultRecordV2 }> = [];
          for (const w of store.wallets) {
            if (!isVaultRecordV2(w.vault)) continue; // v1 wallets are not ours to touch
            try {
              rebuilt.push({
                entry: w,
                vault: await rewrapVaultV2(w.vault, oldMaster, upgraded.master),
              });
            } catch {
              failure = { ok: false, reason: 'wallet-unreadable', wallet: w.name };
              return NO_WRITE;
            }
          }
          for (const r of rebuilt) r.entry.vault = r.vault;
          store.appKey = upgraded.record;
        } else if (block) {
          // v2 already: the master key is unchanged, so this is one extra wrap
          // of it and not a single wallet is rewritten.
          store.appKey = { ...(store.appKey as AppKeyRecordV2), recovery: block };
        }
        return true as const;
      });
      if (done === NO_WRITE) return failure ?? { ok: false, reason: 'write-failed' };
      if (upgraded) {
        // The store now speaks the NEW master key, so this session must too, or
        // its next migration would wrap a seed under a key nothing derives.
        this.setMasterKey(upgraded.master, upgraded.record.salt);
        upgraded = null; // handed to the session; not ours to zero any more
      }
      return { ok: true, code };
    } catch (err) {
      if (isStoreWriteFailed(err)) return { ok: false, reason: 'write-failed' };
      return { ok: false, reason: 'write-failed' };
    } finally {
      zeroKey(oldMaster);
      if (upgraded) zeroKey(upgraded.master);
    }
  }

  /** Drop the recovery code. The old code stops opening anything once this is
   *  written. Requires the app password: removing a way back in is exactly as
   *  sensitive as adding one. */
  async removeRecoveryCode(appPassword: string): Promise<boolean> {
    const before = await this.loadStore();
    if (!isAppKeyRecordV2(before.appKey) || !before.appKey.recovery) return false;
    if (!(await verifyAppPassword(before.appKey, appPassword))) return false;
    const fromSalt = before.appKey.salt;
    try {
      const done = await this.updateStore((store) => {
        if (!isAppKeyRecordV2(store.appKey) || !store.appKey.recovery) return NO_WRITE;
        if (store.appKey.salt !== fromSalt) return NO_WRITE;
        store.appKey = withoutRecoveryCode(store.appKey);
        return true as const;
      });
      return done !== NO_WRITE;
    } catch {
      return false;
    }
  }

  /**
   * Open the app with the RECOVERY CODE instead of the password, and set a new
   * password in the same act.
   *
   * There is no "unlock with the code and carry on": the code exists because
   * the password is gone, so leaving without a working password would strand
   * the user again at the next launch. On success the session holds the master
   * key and the app is unlocked, exactly as after a correct password.
   *
   * NO VAULT IS TOUCHED. The master key is unchanged (that is the point of
   * §13.3); only its password wrap is replaced. The recovery code keeps working
   * afterwards, and Settings is where it can be replaced or removed.
   */
  async unlockWithRecoveryCode(code: string, newPassword: string): Promise<RecoveryUnlockResult> {
    if (!newPassword) return { ok: false, reason: 'empty-password' };
    const before = await this.loadStore();
    if (!before.appKey) return { ok: false, reason: 'no-app-password' };
    if (!recordHasRecovery(before.appKey)) return { ok: false, reason: 'no-recovery-code' };
    // Reject a string that cannot be a code before spending a scrypt on it.
    if (!normalizeRecoveryCode(code)) return { ok: false, reason: 'wrong-code' };
    const fromSalt = before.appKey.salt;
    let master: Uint8Array;
    try {
      master = await deriveMasterKeyFromRecovery(before.appKey, code);
    } catch {
      return { ok: false, reason: 'wrong-code' };
    }
    let next: AppKeyRecordV2;
    try {
      next = await rewrapAppKeyRecord(before.appKey as AppKeyRecordV2, master, newPassword);
    } catch {
      zeroKey(master);
      return { ok: false, reason: 'write-failed' };
    }
    try {
      const done = await this.updateStore(async (store) => {
        if (!store.appKey) return NO_WRITE;
        if (
          store.appKey.salt !== fromSalt ||
          !(await masterKeyMatchesRecord(store.appKey, master))
        ) {
          return NO_WRITE;
        }
        store.appKey = next;
        return true as const;
      });
      if (done === NO_WRITE) {
        zeroKey(master);
        return { ok: false, reason: 'write-failed' };
      }
    } catch {
      zeroKey(master);
      return { ok: false, reason: 'write-failed' };
    }
    this.setMasterKey(master, next.salt);
    return { ok: true };
  }

  /**
   * The whole store, encrypted under a password of the FILE's own, as text to
   * save (§13.7). Never the app password: the file exists so that a forgotten
   * app password is survivable, and encrypting it with the forgotten thing
   * would make it useless in exactly that case.
   */
  async exportBackup(filePassword: string): Promise<{ text: string; fileName: string }> {
    if (!filePassword) throw new Error('A backup password cannot be empty.');
    const store = await this.loadStore();
    const now = new Date();
    return {
      text: await createBackup(store, filePassword, now),
      fileName: backupFileName(now),
    };
  }

  /**
   * Open a backup file and describe what restoring it would do. WRITES NOTHING.
   *
   * The decoded store is held here, not handed to the UI: for a `passwordless`
   * wallet the vault is a seed under an empty passphrase, and that belongs in
   * the service that already holds such things rather than in React state.
   */
  async readBackupFile(
    text: string,
    filePassword: string,
  ): Promise<
    | { ok: true; preview: BackupPreview }
    | { ok: false; reason: 'not-a-backup' | 'wrong-password' | 'malformed'; message?: string }
  > {
    let opened: { store: LiveWalletsStore; createdAt: string };
    try {
      opened = await readBackup<LiveWalletsStore>(text, filePassword);
    } catch (err) {
      if (err instanceof WrongBackupPasswordError) return { ok: false, reason: 'wrong-password' };
      if (err instanceof NotABackupFileError) {
        return { ok: false, reason: 'not-a-backup', message: err.message };
      }
      return { ok: false, reason: 'not-a-backup' };
    }
    const restored = opened.store;
    if (!validateRestoredStore(restored)) return { ok: false, reason: 'malformed' };
    const current = await this.loadStore();
    const inFile = new Set(restored.wallets.map((w) => w.id));
    const here = new Set(current.wallets.map((w) => w.id));
    const preview: BackupPreview = {
      createdAt: opened.createdAt,
      wallets: restored.wallets.map((w) => ({
        id: w.id,
        name: w.name,
        network: w.network,
        address: w.address ?? '',
      })),
      // What a REPLACE destroys, named so the confirmation can name it.
      losing: current.wallets
        .filter((w) => !inFile.has(w.id))
        .map((w) => ({ id: w.id, name: w.name, network: w.network })),
      gaining: restored.wallets.filter((w) => !here.has(w.id)).length,
      canMerge: sameAppKeyLineage(current.appKey, restored.appKey),
      deviceEmpty: current.wallets.length === 0,
    };
    this.pendingRestore = { store: restored, preview };
    return { ok: true, preview };
  }

  /** The preview of the backup waiting to be applied, if any. */
  pendingRestorePreview(): BackupPreview | null {
    return this.pendingRestore?.preview ?? null;
  }

  /** Drop a decoded backup without applying it. */
  cancelRestore(): void {
    this.pendingRestore = null;
  }

  /**
   * Apply the backup read by readBackupFile().
   *
   * 'replace' writes the file's wallets AND its app-key record over what is
   * here, in one atomic write, because those two belong together: a v2 wallet
   * is wrapped under the master key of the record it came with, and separating
   * them produces wallets that open with nothing. It then locks, since no key
   * this session holds governs the store any more.
   *
   * 'merge' adds only the wallets this device does not have, and is refused
   * unless the file's record IS this device's record (§13.8). It is not a
   * "safer replace": it is a different, narrower thing that is only meaningful
   * when both sides share a master key.
   */
  async applyRestore(mode: 'replace' | 'merge'): Promise<BackupRestoreResult> {
    const pending = this.pendingRestore;
    if (!pending) return { ok: false, reason: 'no-pending' };
    if (mode === 'merge' && !pending.preview.canMerge) return { ok: false, reason: 'merge-unsafe' };
    let written: number | typeof NO_WRITE;
    try {
      written = await this.updateStore((store) => {
        if (mode === 'merge') {
          const have = new Set(store.wallets.map((w) => w.id));
          const added = pending.store.wallets.filter((w) => !have.has(w.id));
          if (added.length === 0) return NO_WRITE;
          store.wallets.push(...added);
          return added.length;
        }
        store.wallets = pending.store.wallets;
        store.activeId = pending.store.activeId || (pending.store.wallets[0]?.id ?? '');
        if (pending.store.appKey) store.appKey = pending.store.appKey;
        else delete store.appKey;
        return store.wallets.length;
      });
    } catch {
      return { ok: false, reason: 'write-failed' };
    }
    this.pendingRestore = null;
    if (mode === 'replace') {
      // Everything this session knew is about a store that is gone: the wallet
      // it was on may not exist, and the master key it holds is a key to a
      // record that has been replaced.
      this.activeId = null;
      this.lockApp();
    }
    return { ok: true, wallets: written === NO_WRITE ? 0 : written };
  }

  /**
   * The cached master key IF it still belongs to `store.appKey`, else null.
   *
   * The single place a cached key is allowed to be believed. Another page can
   * have changed the app password since this one derived its key, and that page
   * wrote a new record with a new salt and a new check blob. A key that no
   * longer opens the current record is not "the master key" any more, it is a
   * key to a record that no longer exists, so it is ZEROED here rather than
   * returned: keeping it is what turns the next migration into a lost seed and
   * the next correct password into a permanent "wrong password".
   *
   * "Belongs to" is both halves of the claim (see masterKeyBelongsTo): the
   * record's salt is the one this key was derived from, AND the key opens that
   * record's own check blob.
   */
  private async cachedMasterKeyFor(store: LiveWalletsStore): Promise<Uint8Array | null> {
    const cached = this.masterKey;
    if (!cached) return null;
    if (await this.masterKeyBelongsTo(store)) return cached;
    // Stale (or the record is gone, or its salt is not the one this key came
    // from). Drop it: this session is app-locked again.
    this.setMasterKey(null);
    return null;
  }

  /**
   * The master key for this session, deriving it from `password` when the
   * session does not hold a VALID one.
   *
   * The derivation matters for a FRESH service instance: the dApp approval page
   * builds its own LiveWalletService and only has the password the user typed.
   * For an app-key wallet that password IS the app password, so the same field
   * that used to take a wallet password keeps working with no change there.
   *
   * It matters just as much for a STALE one. This used to short-circuit on any
   * cached key and never fall back, so a page whose key had been superseded by
   * another page's password change rejected the CORRECT new app password on
   * every attempt, for the life of the page, with no way back except a lock. The
   * cached key is now validated against the record first, and a key that fails
   * that check is simply not there.
   */
  private async masterKeyFor(store: LiveWalletsStore, password: string): Promise<Uint8Array | null> {
    const cached = await this.cachedMasterKeyFor(store);
    if (cached) return cached;
    if (!store.appKey) return null;
    try {
      const key = await deriveMasterKey(store.appKey, password);
      this.setMasterKey(key, store.appKey.salt);
      return key;
    } catch {
      return null;
    }
  }

  /**
   * Decrypt one entry's vault to its plaintext string, dispatching on the record
   * version. Returns null on a wrong password / missing app key, exactly like
   * every other password-gated read here. NEVER migrates: consent for that is
   * attached to the unlock prompt, so it lives in unlock() alone.
   */
  private async decryptEntrySecret(
    store: LiveWalletsStore,
    entry: WalletEntry,
    password: string,
  ): Promise<string | null> {
    if (isVaultRecordV2(entry.vault)) {
      const master = await this.masterKeyFor(store, password);
      if (!master) return null;
      try {
        return await unlockVaultV2String(entry.vault, master);
      } catch {
        return null;
      }
    }
    try {
      return await unlockVaultString(entry.vault, entry.passwordless ? NO_PASSWORD : password);
    } catch {
      return null;
    }
  }

  /**
   * LAZY MIGRATION of one wallet (and its whole seed group) from v1 to v2 —
   * the app-password design notes §4. Called from unlock() ONLY, and only after
   * the secret has already been decrypted with the wallet's OWN password.
   *
   * Never batched, never scheduled, never triggered by anything but a successful
   * unlock. Returns true only when the v2 record is on disk.
   *
   * WRITE FORWARD, VERIFY, THEN REPLACE (§4 rule 3), all of it inside ONE
   * updateStore() so every decision is made from the store the write lands on:
   *   1. build the v2 record (fresh wallet key, secret under it, key wrapped
   *      under the master key);
   *   2. decrypt that record BACK with the master key;
   *   3. compare it to the plaintext byte for byte, and abort if it differs;
   *   4. assign to every member of the seed group;
   *   5. write, and the write itself refuses if the store moved (see
   *      writeStore); the v1 record is discarded only as part of it.
   *
   * ANY failure at any step leaves the entry on v1 and is invisible to the user:
   * the wallet is already unlocked and stays unlocked, and it will simply be
   * asked for its own password again next time.
   *
   * THE THREE GUARDS, all found by an adversarial review, all in the mutator so
   * a retry re-asks every one of them:
   *
   * - THE KEY MUST BELONG TO THE RECORD. `this.masterKey` is a cached claim
   *   (see the field's comment). Wrapping under a superseded key while the same
   *   write discards the v1 record leaves a seed NOTHING can open: not the new
   *   app password (the record does not derive that key), not the old one (the
   *   record is gone), not the wallet's own password (the v1 record is gone).
   *   That is the one failure here that loses money, so the binding is proven
   *   against the store this write is about to be based on, and a mismatch is
   *   not an error but the design's fail-safe: leave the wallet on v1.
   *
   * - THE v1 RECORD MUST STILL BE THE ONE THIS PLAINTEXT CAME OUT OF. `secret`
   *   was decrypted from the vault as it was ~300 ms ago. If another page
   *   re-encrypted it in that window (the user set a new password on this wallet
   *   in the side panel), migrating now would discard the record carrying that
   *   brand-new password and answer a password the user has just replaced. The
   *   state this decided from is gone, so the answer is the same fail-safe.
   *
   * - THE GROUP MUST BE ONE SECRET. §4 rule 4: every EVM account of one seed
   *   holds a COPY of one vault record, so migrating one and not the others
   *   leaves a group half-readable, and handing this record to a member whose
   *   ciphertext differs would hand it another wallet's secret.
   */
  private async migrateEntryToAppKey(
    store: LiveWalletsStore,
    entry: WalletEntry,
    secret: string,
  ): Promise<boolean> {
    if (!this.masterKey) return false;
    if (isVaultRecordV2(entry.vault)) return false;
    const decrypted = entry.vault as VaultRecord;

    const plaintext = new TextEncoder().encode(secret);
    try {
      const migrated = await this.updateStore(async (fresh) => {
        // The guard on the key, against the store this write will be based on.
        if (!(await this.masterKeyBelongsTo(fresh))) {
          // Either another page changed the app password under us, or the record
          // is gone, or its salt is not the one this key came from. Either way
          // this key must not wrap anything: stay v1.
          this.setMasterKey(null);
          return NO_WRITE;
        }
        const master = this.masterKey;
        if (!master) return NO_WRITE;

        const target = fresh.wallets.find((w) => w.id === entry.id);
        if (!target || isVaultRecordV2(target.vault)) return NO_WRITE;
        const v1 = target.vault as VaultRecord;
        if (v1.iv !== decrypted.iv || v1.ciphertext !== decrypted.ciphertext) return NO_WRITE;

        const group = target.seedGroup;
        const members = group ? fresh.wallets.filter((w) => w.seedGroup === group) : [target];
        for (const m of members) {
          if (isVaultRecordV2(m.vault) || m.vault.ciphertext !== v1.ciphertext || m.vault.iv !== v1.iv) {
            return NO_WRITE;
          }
        }

        // 1 + 2.
        const record = await createVaultV2(plaintext, master);
        // 3. Decrypt it back with the master key and compare to the plaintext.
        const roundTrip = await unlockVaultV2(record, master);
        let verified: boolean;
        try {
          verified = bytesEqual(roundTrip, plaintext);
        } finally {
          roundTrip.fill(0);
        }
        if (!verified) return NO_WRITE;

        // 4.
        for (const m of members) {
          m.vault = { ...record };
          // §6: the seed is protected by the app key now, so `passwordless` (which
          // meant "encrypted with an empty passphrase") stops being true. Its
          // CONVENIENCE half survives as a property of its own.
          if (m.passwordless) {
            m.noSendPassword = true;
            m.passwordless = false;
          }
        }
        return members.map((m) => ({
          id: m.id,
          vault: { ...record },
          passwordless: m.passwordless,
          noSendPassword: m.noSendPassword,
        }));
      });
      if (migrated === NO_WRITE) return false;
      // Keep the CALLER's copy in step with what is now on disk, so nothing
      // downstream can write a v1 record back over this.
      for (const m of migrated) {
        const mirror = store.wallets.find((w) => w.id === m.id);
        if (!mirror) continue;
        mirror.vault = m.vault;
        mirror.passwordless = m.passwordless;
        mirror.noSendPassword = m.noSendPassword;
      }
      return true;
    } catch {
      return false;
    } finally {
      plaintext.fill(0);
    }
  }

  /**
   * Move every wallet that opens with NO password onto the app key, now.
   *
   * THE ONE PLACE MIGRATION IS NOT LAZY, and the reason it is allowed to be: a
   * `passwordless` wallet's own password is the EMPTY one, so its plaintext is
   * already in this code's hands with nothing to ask the user for. §4 rule 2's
   * "migration happens only when the plaintext is already in hand" is satisfied
   * exactly as it is on the unlock path; what is absent is only the prompt,
   * because there is no password to prompt for.
   *
   * IT IS NOT A SECOND MIGRATION PATH. Every wallet still goes through
   * migrateEntryToAppKey(), with its key-binding guard, its record-freshness
   * guard, its seed-group rule and its write-forward-verify-then-replace. This
   * only decides WHICH wallets and hands each one its plaintext.
   *
   * IT TOUCHES NOTHING ELSE. A wallet with a password of its own cannot be
   * migrated here and is not looked at: its seed is unreadable without the
   * password the user has not typed, and it keeps its v1 record untouched until
   * it is opened and asks, exactly as before. That is the whole of the mixed
   * install: the unprotected wallets are protected, the protected ones are left
   * alone.
   *
   * `noSendPassword` IS PRESERVED, NOT ENABLED. migrateEntryToAppKey carries the
   * convenience half of `passwordless` across as `noSendPassword` (§6), which is
   * what "this wallet never asked for a password when sending" means after the
   * move. Deliberately NOT routed through setNoSendPassword(), whose enabling
   * direction costs the app password plus an acknowledgement: that gate exists
   * to stop a wallet SILENTLY GAINING the property, and this flow is not giving
   * it to any wallet that did not already have it.
   *
   * RE-READS BETWEEN WALLETS, because each migration writes: a snapshot taken
   * once would go stale, and a seed group migrates together, so one call can
   * move several of these wallets at once. Every failure is the design's
   * fail-safe, "leave it v1": the wallet is still listed, still opens with no
   * password exactly as it did a moment ago, and the transitional prompt will
   * offer to move it the next time it is opened.
   */
  async migratePasswordlessWallets(): Promise<{ migrated: string[]; kept: string[] }> {
    const migrated: string[] = [];
    const kept: string[] = [];
    if (!this.masterKey) return { migrated, kept };
    for (;;) {
      const store = await this.loadStore();
      const seen = new Set([...migrated, ...kept]);
      const next = store.wallets.find(
        (w) => w.passwordless === true && !isVaultRecordV2(w.vault) && !seen.has(w.id),
      );
      if (!next) return { migrated, kept };
      let secret: string | null = null;
      try {
        // Narrowed by the isVaultRecordV2 test in the predicate above, which the
        // compiler cannot carry out of find().
        secret = await unlockVaultString(next.vault as VaultRecord, NO_PASSWORD);
      } catch {
        secret = null;
      }
      if (secret === null) {
        // Its vault is not openable with the empty passphrase after all, so the
        // flag is lying about it. Nothing here can read that seed, and nothing
        // here rewrites it.
        kept.push(next.id);
        continue;
      }
      const ok = await this.migrateEntryToAppKey(store, next, secret);
      (ok ? migrated : kept).push(next.id);
    }
  }

  /**
   * Unlock the ACTIVE wallet, loading its secret (seed or private key) into
   * memory.
   *
   * `password` is the wallet's own password for a v1 vault and the APP password
   * for a v2 one (ignored entirely when the session already holds the master
   * key, which is what "no second prompt" means).
   *
   * `opts.migrate === false` opts this unlock out of the lazy migration: the
   * transitional prompt offers the user that choice, and declining must leave
   * the wallet on v1, listed and unlockable, exactly as §4 rule 5 requires.
   */
  async unlock(password: string, opts?: { migrate?: boolean }): Promise<boolean> {
    const store = await this.loadStore();
    const entry = this.sessionEntry(store);
    if (!entry) return false;
    const wasV1 = !isVaultRecordV2(entry.vault);
    const secret = await this.decryptEntrySecret(store, entry, password);
    if (secret === null) return false;
    // An EVM wallet needs the engine to derive anything: load it first so a
    // build without it refuses the unlock instead of activating a wallet it
    // cannot address or sign for.
    const evm = (entry.family ?? 'utxo') === 'evm' ? await this.requireEvm() : null;
    this.activateEntry(entry);
    let address: string;
    if (entry.kind === 'pk') {
      const { privateKey, compressed } = parsePrivateKey(secret);
      this.setActivePk(privateKey, compressed);
      address = evm
        ? evm.privateKeyToEvmKey(privateKey).address
        : privateKeyToDerived(privateKey, this.net, compressed).address;
    } else {
      // A pre-passphrase vault decodes to itself, so this is a no-op for every
      // wallet that already existed.
      const { mnemonic, passphrase } = decodeSeedSecret(secret);
      const seed = await mnemonicToSeed(mnemonic, passphrase);
      this.setActiveSeed(seed);
      address = evm
        ? // The entry's OWN index: "Account 2" is address index 1 of these words.
          evm.deriveEvmKey(seed, entry.hdIndex ?? 0).address
        : deriveAddress(seed, this.net, 0, 0, 0).address;
    }
    // Backfill the cached public address for a migrated wallet (unknown until now).
    let dirty = false;
    if (!entry.address) {
      entry.address = address;
      dirty = true;
    }
    // An EVM seed entry stored before accounts existed learns its group here.
    if (this.ensureSeedGroup(entry)) dirty = true;
    if (dirty) {
      // BY WALLET ID onto the store the write is based on, for the same reason
      // the migration below does it: `store` was read before ~300 ms of scrypt,
      // and writing the whole snapshot back would erase a wallet another page
      // imported in that window. This is only a cache backfill, so a failed
      // write is not allowed to fail an unlock that has already succeeded.
      const patch = {
        address: entry.address,
        hdIndex: entry.hdIndex,
        seedGroup: entry.seedGroup,
      };
      try {
        await this.updateStore((fresh) => {
          const target = fresh.wallets.find((w) => w.id === entry.id);
          if (!target) return NO_WRITE;
          let touched = false;
          if (!target.address && patch.address) {
            target.address = patch.address;
            touched = true;
          }
          if (target.hdIndex === undefined && patch.hdIndex !== undefined) {
            target.hdIndex = patch.hdIndex;
            touched = true;
          }
          if (!target.seedGroup && patch.seedGroup) {
            target.seedGroup = patch.seedGroup;
            touched = true;
          }
          // Another page may have backfilled the same fields already: writing
          // then would burn a revision (and a write) for nothing.
          return touched ? true : NO_WRITE;
        });
      } catch {
        // Left for the next unlock to backfill.
      }
    }
    // LAZY MIGRATION, and deliberately the LAST thing this method does: the
    // unlock has already succeeded and already been persisted, so nothing below
    // can fail it. A wallet that does not migrate is simply still a v1 wallet.
    if (wasV1 && this.masterKey && opts?.migrate !== false) {
      await this.migrateEntryToAppKey(store, entry, secret);
    }
    // Both writes above re-read the store, and loadStore() points the service at
    // whatever entry that store calls active. Re-assert THIS entry: the secret in
    // memory is its secret, and a chain/family taken from another page's switch
    // would derive and sign on the wrong chain.
    this.activateEntry(entry);
    return true;
  }

  /**
   * Give an EVM seed entry the two account fields it may predate, WITHOUT any
   * secret: an entry at index 0 (absent hdIndex means 0) has its group's own
   * index-0 address cached in `entry.address`, which IS the group id. Entries
   * created at index > 0 always carry both from birth, so they are left alone.
   * Returns true when something changed and the store needs saving.
   */
  private ensureSeedGroup(entry: WalletEntry): boolean {
    if ((entry.family ?? 'utxo') !== 'evm' || (entry.kind ?? 'seed') !== 'seed') return false;
    let changed = false;
    if (entry.hdIndex === undefined) {
      entry.hdIndex = 0;
      changed = true;
    }
    if (!entry.seedGroup && entry.hdIndex === 0 && entry.address) {
      entry.seedGroup = entry.address.toLowerCase();
      changed = true;
    }
    return changed;
  }

  /** Change the ACTIVE wallet's vault password. An empty `newPassword` makes the
   *  wallet passwordless; a non-empty one on a passwordless wallet adds a password.
   *
   *  REFUSES for an app-key (v2) wallet: it has no password of its own to change.
   *  Its key is wrapped by the app master key, so changeAppPassword() is the only
   *  thing that can move it, and a per-wallet EXTRA password is §7, not this
   *  release. Refusing (rather than quietly writing a v1 record back over a v2
   *  one) keeps the wallet openable by the app password it is already under.
   *
   *  PINNED TO ONE WALLET ID, AND IT IS THIS PAGE'S. The whole thing (two
   *  scrypts) happens inside the write, so it is re-applied if another page
   *  writes in that window; and a re-application must land on the SAME wallet,
   *  not on whatever the store then calls active. The id being pinned was itself
   *  read out of the shared store once, which pinned the wrong wallet just as
   *  firmly: with the same password on both, the password changed on a wallet
   *  the user was not even looking at. It comes from the session now. */
  async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
    const targetId = await this.sessionWalletId();
    if (!targetId) return false;
    const newPasswordless = newPassword.length === 0;
    const newPw = newPasswordless ? NO_PASSWORD : newPassword;
    try {
      const done = await this.updateStore(async (store) => {
        const entry = store.wallets.find((w) => w.id === targetId);
        if (!entry) return NO_WRITE;
        if (isVaultRecordV2(entry.vault)) return NO_WRITE;
        const oldPw = entry.passwordless ? NO_PASSWORD : oldPassword;
        // ONE SEED, ONE CIPHERTEXT. Every account of one seed holds a COPY of the
        // same vault record. That is not decoration: the migration path identifies a
        // group by its members' `iv` + `ciphertext` being IDENTICAL, and a REVEAL or
        // an unlock on any account decrypts the same bytes.
        //
        // This used to call changeVaultPassword() once PER MEMBER, and each call
        // draws a fresh salt and a fresh IV, so the group came out byte-divergent
        // holding the same words. It still opened, so nothing complained, but the
        // group could never migrate again: the member check saw different bytes and
        // refused, forever, while the transitional prompt kept promising the wallet
        // would move. So exactly ONE new record is computed and assigned to all of
        // them, which restores the invariant instead of testing around it.
        const group = entry.seedGroup;
        const members = group ? store.wallets.filter((w) => w.seedGroup === group) : [entry];
        for (const member of members) {
          // A group with a v2 member is not one this password can move; refusing
          // the whole group is what keeps every member openable.
          if (isVaultRecordV2(member.vault)) return NO_WRITE;
        }
        const canonical = entry.vault as VaultRecord;
        const secret = await unlockVault(canonical, oldPw); // throws on a wrong password
        let rebuilt: VaultRecord;
        try {
          // A group an OLDER build already split still holds the same words in
          // every member, so this heals it. But "the same words" has to be PROVEN
          // before one record is handed to a member that does not match byte for
          // byte, or a divergent member could be silently given another wallet's
          // secret. Members that already match need no proof: identical bytes
          // under one password are the same plaintext by construction.
          for (const member of members) {
            const v = member.vault as VaultRecord;
            if (v.iv === canonical.iv && v.ciphertext === canonical.ciphertext) continue;
            const mine = await unlockVault(v, member.passwordless ? NO_PASSWORD : oldPassword);
            try {
              if (!bytesEqual(mine, secret)) return NO_WRITE;
            } finally {
              mine.fill(0);
            }
          }
          rebuilt = await createVault(secret, newPw);
        } finally {
          secret.fill(0);
        }
        for (const member of members) {
          member.vault = { ...rebuilt };
          member.passwordless = newPasswordless;
        }
        return true as const;
      });
      return done === true;
    } catch (err) {
      // `false` here MEANS "that is not this wallet's current password", because
      // that is the only thing the UI can say about it. A write that never
      // happened is not that, and blaming a password the user typed correctly
      // sends them round a loop retyping it, so it goes back up as itself.
      if (isStoreWriteFailed(err)) throw err;
      return false;
    }
  }

  /**
   * Turn the ACTIVE wallet's "do not ask for a password when sending" off or on
   * (the app-password design notes §6).
   *
   * `noSendPassword` is the CONVENIENCE half of the old `passwordless` flag,
   * kept when a passwordless wallet migrates to the app key. It was set by the
   * migration and had no user-facing surface at all: the "No pw" badge belonged
   * to `passwordless`, which the migration clears, so a wallet that still spends
   * with no password looked exactly like one that asks for it. That is the wrong
   * way round for a flag that decides whether money can leave without proof, so
   * it is now visible and can be turned off.
   *
   * Only meaningful for a v2 wallet: on v1 the same convenience IS
   * `passwordless`, and changePassword() is what moves that.
   *
   * TURNING IT ON COSTS THE APP PASSWORD; TURNING IT OFF IS FREE.
   *
   * Enabling it switches OFF the pre-broadcast password check, which is the last
   * thing standing between a wallet left unlocked on a desk and its funds:
   * afterwards verifyPassword() answers true to anything, on this page and on
   * every other. That is exactly the state a v1 wallet reaches through
   * changePassword(old, ''), and that route has always required the CURRENT
   * password plus an explicit risk acknowledgement. Reaching the same state with
   * neither, on a wallet that may never have been passwordless at all, is a gate
   * the wallet does not have. So the enabling direction re-derives the app
   * password exactly as the send gate itself would.
   *
   * Disabling stays free, and must: it only ever ADDS a check, it is the way out
   * of the state a migration put the wallet in, and asking for a password to make
   * the wallet safer is how a safety switch stops being used.
   */
  async setNoSendPassword(enabled: boolean, password?: string): Promise<boolean> {
    const before = await this.loadStore();
    // This page's wallet, pinned by id and re-found inside the write: the flag
    // decides whether money can leave THIS wallet without proof, so it must not
    // land on whichever wallet the shared store happens to call active.
    const targetId = this.sessionEntry(before)?.id;
    if (!targetId) return false;
    if (enabled) {
      // Proved against the record on disk, and re-derived rather than compared
      // against the master key this session may already hold: this is the same
      // proof verifyPassword() demands before a broadcast, and it is being asked
      // for permission to stop demanding it.
      if (!before.appKey) return false;
      if (typeof password !== 'string' || password.length === 0) return false;
      if (!(await verifyAppPassword(before.appKey, password))) return false;
    }
    try {
      const done = await this.updateStore((store) => {
        const entry = store.wallets.find((w) => w.id === targetId);
        if (!entry) return NO_WRITE;
        if (!isVaultRecordV2(entry.vault)) return NO_WRITE;
        // The app record must still be the one the password above was proved
        // against, or that proof was about a password this store no longer uses.
        if (enabled && (!store.appKey || store.appKey.salt !== before.appKey?.salt)) return NO_WRITE;
        if (enabled) entry.noSendPassword = true;
        else delete entry.noSendPassword;
        return true as const;
      });
      return done === true;
    } catch (err) {
      // Same reason as changePassword: `false` is read as "wrong app password",
      // and a write that did not happen is not that.
      if (isStoreWriteFailed(err)) throw err;
      return false;
    }
  }

  /** Make a seed the active in-memory secret (zeroing any prior key/seed). */
  private setActiveSeed(seed: Uint8Array): void {
    this.pk?.fill(0);
    this.pk = null;
    this.seed = seed;
    this.activeKind = 'seed';
  }

  /** Make a raw private key the active in-memory secret (zeroing any prior seed). */
  private setActivePk(privateKey: Uint8Array, compressed: boolean): void {
    this.seed?.fill(0);
    this.seed = null;
    this.pk = privateKey;
    this.pkCompressed = compressed;
    this.activeKind = 'pk';
  }

  lock(): void {
    this.seed?.fill(0);
    this.seed = null;
    this.pk?.fill(0);
    this.pk = null;
    this.allowBroadcast = false;
  }

  isUnlocked(): boolean {
    return this.seed !== null || this.pk !== null;
  }

  network(): LiveNetworkId {
    return this.activeNetworkId;
  }

  // --- multi-wallet management --------------------------------------------

  /** List all wallets (metadata only — never any secret). */
  async listWallets(): Promise<WalletSummary[]> {
    const store = await this.loadStore();
    // "active" means the wallet THIS PAGE is on, the same one every other method
    // here acts on, not whichever wallet another window last switched to.
    const activeId = this.activeId ?? store.activeId;
    return store.wallets.map((w) => ({
      id: w.id,
      name: w.name,
      network: w.network,
      createdAt: w.createdAt,
      active: w.id === activeId,
      kind: w.kind ?? 'seed',
      address: w.address ?? '',
      passwordless: w.passwordless ?? false,
      family: w.family ?? 'utxo',
      // Conditional for the same reason as evmChainKey below: a wallet on an
      // install with no app password must keep the EXACT key set listWallets()
      // has always returned (liveWallet.test.ts pins it as the no-secret-leaks
      // contract). Both are public metadata; neither can appear before the user
      // has opted in.
      ...(isVaultRecordV2(w.vault) ? { appProtected: true } : {}),
      ...(w.noSendPassword ? { noSendPassword: true } : {}),
      // Only present on an EVM account: a UTXO summary keeps its exact key set
      // (liveWallet.test.ts pins that set as the no-secret-leaks contract).
      ...(w.evmChainKey !== undefined ? { evmChainKey: w.evmChainKey } : {}),
      // Same rule for the account fields. Both are public and derived from
      // public data, but a UTXO or 'pk' summary must not sprout EVM-only keys.
      ...(w.hdIndex !== undefined ? { hdIndex: w.hdIndex } : {}),
      ...(w.seedGroup !== undefined ? { seedGroup: w.seedGroup } : {}),
    }));
  }

  /** The active wallet's id, or null if there are no wallets. Synchronous: reads
   *  the cache refreshed by every async store access on this instance. */
  activeWalletId(): string | null {
    return this.activeId;
  }

  /**
   * Point THIS SERVICE at wallet `id` without touching the shared store.
   *
   * The dApp approval page acts on the wallet a site is CONNECTED to, which is
   * not necessarily the one the wallet UI is showing. switchWallet() would
   * persist `activeId` and flip every open window onto that wallet; this only
   * sets the session id, which loadStore() then keeps ("THE PAGE KEEPS ITS OWN
   * WALLET") and activates on the next store access, so the following unlock(),
   * signMessage() or send builds for exactly that wallet. An unknown id is
   * ignored by loadStore() and the session falls back to the store's active
   * wallet, so a caller must check the id exists before relying on this.
   */
  adoptWallet(id: string): void {
    this.activeId = id;
  }

  /**
   * Switch the active wallet. The newly-active wallet starts LOCKED — the seed
   * is cleared and the caller must unlock() with that wallet's own password.
   *
   * ONE EXCEPTION: two accounts of the SAME EVM seed (equal `seedGroup`) are one
   * secret at two address indexes, held under one password. Locking there would
   * ask the user for a password the session already holds, to unlock the words
   * it already has in memory — so the seed stays and only the derivation index
   * moves. The invariant is unchanged: still exactly one seed in memory, still
   * the active wallet's own.
   */
  async switchWallet(id: string): Promise<void> {
    const switched = await this.updateStore((store) => {
      const entry = store.wallets.find((w) => w.id === id);
      if (!entry) throw new Error('unknown-wallet');
      const current = this.sessionEntry(store);
      const sameSeed =
        this.activeKind === 'seed' &&
        this.seed !== null &&
        (entry.family ?? 'utxo') === 'evm' &&
        (entry.kind ?? 'seed') === 'seed' &&
        !!entry.seedGroup &&
        current?.seedGroup === entry.seedGroup;
      // Switching WALLETS never switches CHAINS (owner, 2026-08-19: "the wallet
      // must not change the network by itself"): when both sides are EVM and the
      // session is on an EVM chain, the target account adopts the chain the user
      // is LOOKING AT, not the one it last remembered. Chain changes stay the
      // chain switcher's job alone.
      if (
        this.activeFamily === 'evm' &&
        (entry.family ?? 'utxo') === 'evm' &&
        this.activeEvmChainKey &&
        entry.evmChainKey !== this.activeEvmChainKey
      ) {
        entry.evmChainKey = this.activeEvmChainKey;
      }
      store.activeId = id;
      return { entry: { ...entry }, sameSeed };
    });
    if (switched === NO_WRITE) return;
    if (switched.sameSeed) {
      // The broadcast gate is armed per send, for the account that armed it.
      this.allowBroadcast = false;
    } else {
      this.lock();
    }
    this.activateEntry(switched.entry);
    this.activeKind = switched.entry.kind ?? 'seed';
  }

  /** Rename a wallet (empty/whitespace names are ignored, keeping the old name). */
  async renameWallet(id: string, name: string): Promise<void> {
    await this.updateStore((store) => {
      const entry = store.wallets.find((w) => w.id === id);
      if (!entry) throw new Error('unknown-wallet');
      const next = name.trim();
      if (next) entry.name = next;
    });
  }

  /** Remove a wallet. If it was the one THIS PAGE is on, clear the in-memory
   *  seed and move this page to whatever wallet is left (none, if none is).
   *
   *  TWO SEPARATE QUESTIONS, deliberately answered separately: whether the STORE
   *  has to repoint its shared `activeId` (it does if the removed wallet is the
   *  one it names), and whether THIS PAGE has to drop the secret it is holding
   *  (it does if the removed wallet is the one this page is on). They are the
   *  same wallet on any single-window install and can differ with two windows
   *  open, where taking the second answer from the first would either lock a
   *  page out of a wallet that is still there or leave it holding the seed of
   *  one that is gone.
   *
   *  REMOVING THE LAST WALLET ALSO REMOVES THE APP-PASSWORD RECORD. An app
   *  password is a password FOR wallets; with no wallet left there is nothing
   *  for it to open, and keeping it gated the next wallet the user onboarded
   *  behind a password that wallet had never had anything to do with, with no
   *  reset and no bypass. The record can only be dropped safely at exactly this
   *  moment, when no v2 vault is left for it to be the key to. */
  async removeWallet(id: string): Promise<void> {
    // Is this page's own wallet the one going? Asked of the session, before the
    // write, so another window's switch cannot decide whether this page keeps a
    // secret in memory.
    const wasOurs = (await this.sessionWalletId()) === id;
    // The store decides; the SESSION is only changed once the removal is on
    // disk, so a write that had to be re-applied cannot leave this page locked
    // out of a wallet that is still there.
    const removed = await this.updateStore((store) => {
      const idx = store.wallets.findIndex((w) => w.id === id);
      if (idx === -1) return NO_WRITE;
      const wasStoreActive = store.activeId === id;
      store.wallets.splice(idx, 1);
      if (wasStoreActive) store.activeId = store.wallets.length > 0 ? store.wallets[0].id : '';
      const droppedAppKey = store.wallets.length === 0 && !!store.appKey;
      if (droppedAppKey) delete store.appKey;
      // Where THIS page goes next, and only if its own wallet is the one being
      // removed: the store's active wallet, exactly the wallet loadStore() would
      // adopt for a page whose own is gone.
      const promoted = wasOurs
        ? (store.wallets.find((w) => w.id === store.activeId) ?? store.wallets[0])
        : undefined;
      return { droppedAppKey, promoted: promoted ? { ...promoted } : null };
    });
    if (removed === NO_WRITE) return;
    if (wasOurs) {
      this.lock();
      if (removed.promoted) this.activateEntry(removed.promoted);
      else this.activeId = null; // nothing left to be on
    }
    // The record is gone, so the key derived from it is a key to nothing.
    if (removed.droppedAppKey) this.setMasterKey(null);
  }

  // --- reveal secrets (password-gated) ------------------------------------

  /** Verify `password` against the ACTIVE wallet and return its recovery phrase,
   *  or null on a wrong password. Returns null for a pk-wallet (which has NO
   *  recovery phrase — only a private key). Does not alter session state. */
  async revealMnemonic(password: string): Promise<string | null> {
    const secret = await this.revealSeedSecret(password);
    // The WORDS only: a caller showing this to the user must never be handed the
    // envelope, and the passphrase is revealed separately and deliberately.
    return secret ? secret.mnemonic : null;
  }

  /**
   * Verify `password`, then return the ACTIVE seed wallet's mnemonic AND its
   * BIP39 passphrase. Used where the secret is re-imported rather than displayed
   * (enableChain deriving the same wallet on another chain): dropping the
   * passphrase there would silently produce a DIFFERENT wallet at a different
   * address, which is the whole trap this pair exists to avoid.
   */
  async revealSeedSecret(
    password: string,
  ): Promise<{ mnemonic: string; passphrase: string } | null> {
    const store = await this.loadStore();
    const entry = this.sessionEntry(store);
    if (!entry) return null;
    if (entry.kind === 'pk') return null; // pk-wallets have no seed phrase
    const raw = await this.revealEntrySecret(store, entry, password);
    if (raw === null) return null;
    return decodeSeedSecret(raw);
  }

  /**
   * The plaintext of `entry` for a REVEAL (or any other deliberate
   * re-authentication), as opposed to an unlock.
   *
   * The difference matters: unlock() may ride the master key the session already
   * holds, because the user proved it at the app lock screen. A reveal is the
   * user asking to SEE the secret, and today that always costs a password. If it
   * rode the cached master key, migrating a wallet would silently turn "type
   * your password to show the recovery phrase" into "click to show the recovery
   * phrase" — a regression, on the most sensitive screen in the wallet. So an
   * app-key wallet re-proves the APP password here, every time.
   */
  private async revealEntrySecret(
    store: LiveWalletsStore,
    entry: WalletEntry,
    password: string,
  ): Promise<string | null> {
    if (isVaultRecordV2(entry.vault)) {
      if (!store.appKey) return null;
      if (!(await verifyAppPassword(store.appKey, password))) return null;
    }
    return this.decryptEntrySecret(store, entry, password);
  }

  /** Verify `password`, then return the ACTIVE wallet's private key as WIF, or
   *  null on a wrong password. For a pk-wallet the stored secret IS the WIF; for
   *  a seed-wallet the key at m/44'/coin'/0'/0/index is derived. Any secret
   *  decrypted here is local and zeroed; the active in-memory secret is untouched. */
  async revealPrivateKeyWif(password: string, index = 0): Promise<string | null> {
    const store = await this.loadStore();
    const entry = this.sessionEntry(store);
    if (!entry) return null;
    const secret = await this.revealEntrySecret(store, entry, password);
    if (secret === null) return null;
    if (entry.kind === 'pk') return secret; // stored value is already the canonical WIF (or the raw hex key for EVM)
    // decodeSeedSecret: a passphrase wallet's vault holds an envelope, and the
    // key at this path only exists under THAT passphrase (a bare-mnemonic seed
    // would reveal a key for a different, empty wallet).
    const { mnemonic, passphrase } = decodeSeedSecret(secret);
    const seed = await mnemonicToSeed(mnemonic, passphrase);
    try {
      if ((entry.family ?? 'utxo') === 'evm') {
        // An EVM key has no WIF form: it is shown as the 0x hex MetaMask imports.
        // THIS account's index, so "reveal" on Account 2 reveals Account 2's key.
        const evm = await this.requireEvm();
        const key = evm.deriveEvmKey(seed, entry.hdIndex ?? 0);
        try {
          return '0x' + bytesToHex(key.privateKey);
        } finally {
          key.privateKey.fill(0);
        }
      }
      return deriveAddress(seed, this.netFor(this.utxoNetworkOf(entry.network)), 0, 0, index).wif;
    } finally {
      seed.fill(0);
    }
  }

  /**
   * The backup of ONE named wallet that opens with NO password: its recovery
   * phrase (a seed wallet) or its private key (an imported-key wallet).
   *
   * IT ADDS NO CAPABILITY, and that is the test it has to pass. A wallet with
   * `passwordless: true` on a v1 record is one whose vault opens under the EMPTY
   * passphrase, so these exact words are already reachable today with nothing
   * typed: switch to that wallet (one click, no password) and open Settings >
   * Show recovery phrase. This reaches the same secret WITHOUT switching, so a
   * page that is showing one wallet does not have to repoint the SHARED active
   * wallet (and every other page with it) to answer "let me write my phrase
   * down first".
   *
   * WHY IT EXISTS AT ALL: the forced setup screen takes no-password access away,
   * so it must offer the backup BEFORE it does, and in a mixed install the
   * wallets losing that access are not necessarily the one this page is on.
   *
   * REFUSES ANYTHING ELSE, with no message and no oracle: not a wallet with a
   * password of its own (its seed is unreadable here, and pretending otherwise
   * would be a promise this code cannot keep), not a v2 wallet (the app password
   * is what opens that one, and revealEntrySecret is where it is proved), not an
   * unknown id.
   *
   * DOES NOT ACTIVATE ANYTHING: no seed enters session memory, no chain moves,
   * and the wallet this page is on is exactly the wallet it was on.
   */
  async revealNoPasswordBackup(
    walletId: string,
  ): Promise<{ kind: WalletKind; secret: string } | null> {
    const store = await this.loadStore();
    const entry = store.wallets.find((w) => w.id === walletId);
    if (!entry) return null;
    if (entry.passwordless !== true || isVaultRecordV2(entry.vault)) return null;
    let raw: string;
    try {
      raw = await unlockVaultString(entry.vault, NO_PASSWORD);
    } catch {
      return null;
    }
    // A 'pk' wallet has NO recovery phrase: the stored value IS its key (the
    // canonical WIF, or the 0x hex key for an EVM account), which is its backup.
    if ((entry.kind ?? 'seed') === 'pk') return { kind: 'pk', secret: raw };
    // The WORDS only, exactly as revealMnemonic hands them over: the envelope a
    // passphrase wallet stores is never shown to a user.
    return { kind: 'seed', secret: decodeSeedSecret(raw).mnemonic };
  }

  private requireSeed(): Uint8Array {
    if (!this.seed) throw new Error('Live wallet is locked');
    return this.seed;
  }

  // --- addresses / reads ---------------------------------------------------

  /** Derive the signing key. Seed-wallets derive m/44'/coin'/0'/0/index; pk-wallets
   *  have exactly ONE key so `index` is ignored. */
  deriveKey(index = 0): DerivedKey {
    if (this.activeFamily === 'evm') {
      // UTXO key material (WIF, P2PKH address) has no meaning for an EVM account.
      throw new Error('deriveKey is a UTXO operation; the active wallet is an EVM account');
    }
    if (this.activeKind === 'pk') {
      if (!this.pk) throw new Error('Live wallet is locked');
      return privateKeyToDerived(this.pk, this.net, this.pkCompressed);
    }
    return deriveAddress(this.requireSeed(), this.net, 0, 0, index);
  }

  getAddress(index = 0): string {
    if (this.activeFamily === 'evm') return this.evmAddress();
    return this.deriveKey(index).address;
  }

  // --- EVM account (family 'evm') ------------------------------------------

  activeWalletFamily(): WalletFamily {
    return this.activeFamily;
  }

  /** The chain key the active EVM account is showing, or null for a UTXO wallet. */
  evmChainKey(): string | null {
    return this.activeFamily === 'evm' ? this.activeEvmChainKey : null;
  }

  /** Point the ACTIVE EVM account at another EVM chain (persisted). The address
   *  is the same on every EVM chain, so nothing else changes.
   *
   *  Pinned to this page's own account by id, like every other mutator here.
   *  Nothing is at risk in this one -- the chain key is a view preference, and
   *  the address is identical on every EVM chain -- but it had the same seam,
   *  and one rule for resolving "the active wallet" is the only version of that
   *  rule anybody can check. */
  async setEvmChainKey(key: string): Promise<void> {
    if (this.activeFamily !== 'evm') throw new Error('not-an-evm-wallet');
    const evm = await this.requireEvm();
    if (!evm.isEvmChainKey(key)) throw new Error(`unknown EVM chain: ${key}`);
    const targetId = await this.sessionWalletId();
    if (!targetId) throw new Error('no-active-wallet');
    await this.updateStore((store) => {
      const entry = store.wallets.find((w) => w.id === targetId);
      if (!entry) throw new Error('no-active-wallet');
      entry.evmChainKey = key;
    });
    this.activeEvmChainKey = key;
  }

  // --- EVM accounts on one seed (the EVM accounts design notes) ---------------

  /** The ACTIVE, UNLOCKED EVM seed entry, or the documented refusal. Every
   *  account operation starts here so they all refuse for the same reasons in
   *  the same words. */
  private requireEvmSeedEntry(store: LiveWalletsStore): WalletEntry {
    const entry = this.sessionEntry(store);
    if (
      !entry ||
      this.activeFamily !== 'evm' ||
      (entry.family ?? 'utxo') !== 'evm' ||
      (entry.kind ?? 'seed') !== 'seed'
    ) {
      throw new Error('not-evm-seed');
    }
    if (!this.seed || this.activeKind !== 'seed') throw new Error('locked');
    return entry;
  }

  /** The group id of the seed behind `entry`: the lowercased index-0 address of
   *  these words. Cached on the entry; derived from the in-memory seed for an
   *  entry stored before the feature whose cached address is still unknown. */
  private evmSeedGroupOf(entry: WalletEntry, evm: EvmModules, seed: Uint8Array): string {
    if (entry.seedGroup) return entry.seedGroup;
    const key = evm.deriveEvmKey(seed, 0);
    try {
      return key.address.toLowerCase();
    } finally {
      key.privateKey.fill(0);
    }
  }

  /** The EIP-55 address of `index` for `seed`, with the key material zeroed:
   *  every account operation here wants a public address, never a signer. */
  private evmAddressAt(evm: EvmModules, seed: Uint8Array, index: number): string {
    const key = evm.deriveEvmKey(seed, index);
    try {
      return key.address;
    } finally {
      key.privateKey.fill(0);
    }
  }

  /** A new account entry of `source`'s seed at `hdIndex`. The vault record is
   *  COPIED verbatim: one seed, one ciphertext, one password. That is not a new
   *  secret (the same encrypted words already sit in `source`), and it is what
   *  lets changePassword move the whole group in one step. */
  private buildEvmAccountEntry(
    source: WalletEntry,
    id: string,
    name: string,
    hdIndex: number,
    address: string,
    seedGroup: string,
  ): WalletEntry {
    return {
      id,
      name,
      network: EVM_NETWORK,
      vault: { ...source.vault },
      createdAt: Date.now(),
      kind: 'seed',
      address,
      passwordless: source.passwordless ?? false,
      // The convenience flag follows the seed too: every account of one seed is
      // one secret under one password, so they must answer "ask before sending?"
      // the same way.
      ...(source.noSendPassword ? { noSendPassword: true } : {}),
      family: 'evm',
      ...(source.evmChainKey !== undefined ? { evmChainKey: source.evmChainKey } : {}),
      hdIndex,
      seedGroup,
    };
  }

  /**
   * Add the next MetaMask-style account of the ACTIVE, UNLOCKED EVM seed: the
   * next free address index in its group, made active WITHOUT locking (the same
   * words stay in memory; only the derivation index moves).
   *
   * Throws 'locked' when the session holds no seed and 'not-evm-seed' when the
   * active wallet is a UTXO wallet or a single imported key (neither has an HD
   * account tree to extend).
   */
  async addEvmAccount(name?: string): Promise<{ id: string; hdIndex: number; address: string }> {
    const evm = await this.requireEvm();
    const result = await this.updateStore((store) => {
      // requireEvmSeedEntry FIRST: "this wallet has no account tree" is the
      // truer answer for a pk or UTXO wallet than "the wallet is locked".
      const entry = this.requireEvmSeedEntry(store);
      const seed = this.requireSeed();
      const seedGroup = this.evmSeedGroupOf(entry, evm, seed);
      // A pre-feature entry joins its own group here, before it grows a sibling.
      this.ensureSeedGroup(entry);
      if (!entry.seedGroup) entry.seedGroup = seedGroup;
      // Next FREE index, not member count: a deleted Account 2 must not hand its
      // index to a new account (that would be a second entry for one address).
      const highest = store.wallets
        .filter((w) => w.seedGroup === seedGroup)
        .reduce((max, w) => Math.max(max, w.hdIndex ?? 0), 0);
      const hdIndex = highest + 1;
      const address = this.evmAddressAt(evm, seed, hdIndex);
      const id = genWalletId(new Set(store.wallets.map((w) => w.id)));
      const walletName = name?.trim() || `Account ${hdIndex + 1}`;
      const created = this.buildEvmAccountEntry(entry, id, walletName, hdIndex, address, seedGroup);
      store.wallets.push(created);
      store.activeId = id;
      return { created, hdIndex, address, id };
    });
    if (result === NO_WRITE) throw new Error('could not save the account');
    // No lock(): same seed, new index. activateEntry moves the cached index so
    // the address and the signing key follow immediately.
    this.activateEntry(result.created);
    return { id: result.id, hdIndex: result.hdIndex, address: result.address };
  }

  /**
   * Find the accounts of the ACTIVE, UNLOCKED EVM seed that are ALREADY IN USE
   * on chain and create the entries this wallet is missing.
   *
   * The wallet does not know what "used" means for a chain it does not read, so
   * `probe` answers that: it is called ONCE with every candidate address
   * (indexes 1..EVM_ACCOUNT_SCAN_MAX, in order) and returns a parallel array of
   * verdicts. One call, not one per index, because the store answers it with a
   * single JSON-RPC batch per chain.
   *
   * Every index from 1 up to the HIGHEST used one is created, used or not:
   * MetaMask numbers accounts contiguously, so a gap would renumber every
   * account above it the next time one is added. Idempotent: indexes the group
   * already covers are skipped, so a second run adds nothing.
   */
  async discoverEvmAccounts(
    probe: (addresses: string[]) => Promise<boolean[]>,
  ): Promise<{ added: number; highest: number }> {
    const evm = await this.requireEvm();
    const probeStore = await this.loadStore();
    const probeEntry = this.requireEvmSeedEntry(probeStore);
    const seed = this.requireSeed();
    const seedGroup = this.evmSeedGroupOf(probeEntry, evm, seed);
    const walletId = probeEntry.id;
    // The group must exist BEFORE the probe: the entries created afterwards
    // join it, and a pre-feature entry that never joined would be left outside
    // the very group its own accounts are in.
    await this.updateStore((store) => {
      const entry = store.wallets.find((w) => w.id === walletId);
      if (!entry) return NO_WRITE;
      let needsSave = this.ensureSeedGroup(entry);
      if (!entry.seedGroup) {
        entry.seedGroup = seedGroup;
        needsSave = true;
      }
      return needsSave ? true : NO_WRITE;
    });

    const candidates: string[] = [];
    for (let index = 1; index <= EVM_ACCOUNT_SCAN_MAX; index++) {
      candidates.push(this.evmAddressAt(evm, seed, index));
    }
    const verdicts = await probe(candidates);
    let highest = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (verdicts[i] === true) highest = i + 1;
    }
    if (highest === 0) return { added: 0, highest: 0 };

    // The probe is network-long, so everything below is decided from the store
    // the write is based on: a wallet added meanwhile (or an account added by
    // hand) must not be clobbered by a stale copy.
    const added = await this.updateStore((fresh) => {
      const members = fresh.wallets.filter((w) => w.seedGroup === seedGroup);
      // The vault to copy: this seed's own entry, whichever member still carries it.
      const source = members.find((w) => w.id === walletId) ?? members[0];
      if (!source) return NO_WRITE;
      const covered = new Set(members.map((w) => w.hdIndex ?? 0));
      const ids = new Set(fresh.wallets.map((w) => w.id));
      let count = 0;
      for (let index = 1; index <= highest; index++) {
        if (covered.has(index)) continue;
        const id = genWalletId(ids);
        ids.add(id);
        fresh.wallets.push(
          this.buildEvmAccountEntry(source, id, `Account ${index + 1}`, index, candidates[index - 1], seedGroup),
        );
        count++;
      }
      // The ACTIVE account is deliberately unchanged: discovery is a background
      // find, not a switch.
      return count > 0 ? count : NO_WRITE;
    });
    return { added: added === NO_WRITE ? 0 : added, highest };
  }

  /** The active EVM account's private key: derived at m/44'/60'/0'/0/hdIndex for
   *  a seed wallet, the imported key itself for a pk wallet. A FRESH buffer the
   *  caller must zero after use. Throws when locked. */
  private evmPrivateKey(): Uint8Array {
    const evm = this.evmModules();
    if (this.activeKind === 'pk') {
      if (!this.pk) throw new Error('Live wallet is locked');
      return new Uint8Array(this.pk);
    }
    return evm.deriveEvmKey(this.requireSeed(), this.activeHdIndex).privateKey;
  }

  /** The active EVM account's (only) address, EIP-55. Throws when locked. */
  private evmAddress(): string {
    const evm = this.evmModules();
    if (this.activeKind === 'pk') {
      if (!this.pk) throw new Error('Live wallet is locked');
      return evm.privateKeyToEvmKey(this.pk).address;
    }
    const key = evm.deriveEvmKey(this.requireSeed(), this.activeHdIndex);
    try {
      return key.address;
    } finally {
      // Only the public half is wanted here; the key material goes immediately.
      key.privateKey.fill(0);
    }
  }

  /**
   * Sign an EVM transaction with the ACTIVE EVM account. The one place a key
   * meets a transaction on this family: the request arrives fully built (nonce,
   * fee, gas, chain id) from the store's send path, and the signed bytes go
   * back. The private key is derived for this call and zeroed before it returns.
   * Requires the wallet to be unlocked; never broadcasts.
   */
  signEvmTransaction(request: import('./evm').EvmTxRequest): import('./evm').SignedEvmTx {
    if (this.activeFamily !== 'evm') throw new Error('not-an-evm-wallet');
    const evm = this.evmModules();
    const priv = this.evmPrivateKey();
    try {
      return evm.signTx(request, priv);
    } finally {
      priv.fill(0);
    }
  }

  /** Sign an arbitrary message with the ACTIVE wallet's PRIMARY key (index 0) in
   *  the Evrmore `signmessage` format (base64 recoverable sig), so it verifies
   *  with `evrmore-cli verifymessage` and Satori's backend — enabling
   *  address-proof / login challenges via `window.evrmore.signMessage`.
   *  Requires the wallet to be unlocked; the signature never leaves this page's
   *  memory except as the returned base64 string (no key is exposed). */
  signMessage(message: string): { address: string; signature: string } {
    const key = this.deriveKey(0); // throws 'Live wallet is locked' when locked
    const compressed = key.publicKey.length === 33;
    return {
      address: key.address,
      // Sign with the ACTIVE chain's message magic (EVR default preserved; RVN
      // uses "Raven Signed Message:\n") so the signature verifies on that chain.
      signature: signMessageWithKey(key.privateKey, message, compressed, this.net.messageMagic),
    };
  }

  /** All receive keys of the ACTIVE wallet (one per derived address; a pk wallet
   *  has exactly one). Requires the wallet to be unlocked. */
  private async allKeys(): Promise<DerivedKey[]> {
    if (this.activeFamily === 'evm') throw new Error('allKeys is a UTXO operation');
    if (this.activeKind === 'pk') return [this.deriveKey(0)];
    const store = await this.loadStore();
    const entry = this.sessionEntry(store);
    const count = Math.max(1, Math.min(entry?.addressCount ?? 1, MAX_RECEIVE_ADDRESSES));
    const keys: DerivedKey[] = [];
    for (let i = 0; i < count; i++) keys.push(this.deriveKey(i));
    return keys;
  }

  /** All receive addresses of the ACTIVE wallet, in derivation order. */
  async listAddresses(): Promise<{ index: number; address: string }[]> {
    // One account = one address on the EVM family (design decision, evm-engine.md, section 1).
    if (this.activeFamily === 'evm') return [{ index: 0, address: this.evmAddress() }];
    const keys = await this.allKeys();
    return keys.map((k, i) => ({ index: i, address: k.address }));
  }

  /**
   * The DerivedKeys of every active-wallet address currently holding a positive
   * balance of `assetName` (e.g. SATORIEVR). Funds can sit on any derived address,
   * so Satori pool staking must register ALL of them — this gives the caller the
   * exact keys to sign each per-address challenge with.
   *
   * Requires the wallet to be UNLOCKED (allKeys() throws when locked). Reuses the
   * watch-only provider's per-address asset-balance read; addresses whose balance
   * read fails are skipped (best-effort, never throws for one bad address). Order
   * follows derivation (primary first).
   */
  async keysHoldingAsset(assetName: string): Promise<DerivedKey[]> {
    const name = assetName.trim().toUpperCase();
    const keys = await this.allKeys(); // throws 'Live wallet is locked' when locked
    const held: DerivedKey[] = [];
    for (const key of keys) {
      try {
        const bal = await this.provider.getAssetBalance(key.address, name);
        if (bal > 0) held.push(key);
      } catch {
        // Skip an address whose balance couldn't be read (offline/one bad read);
        // the others still get evaluated.
      }
    }
    return held;
  }

  /** Derive one more receive address for the ACTIVE seed wallet (persisted).
   *  Throws for pk wallets (single-address by construction) and at the cap.
   *
   *  PINNED TO THIS PAGE'S WALLET, and it is the one thing here that can cost a
   *  user money. The address handed back is derived from the seed in THIS
   *  session's memory, so the `addressCount` that has to grow is that wallet's.
   *  Resolving "the active wallet" out of the shared store raised the count on
   *  whichever wallet another window had switched to: the wallet that owns the
   *  address shown never learned the address exists, never scans it, and coins
   *  sent there go unseen. The id is pinned before the write and the entry
   *  re-found by that id inside it, so a re-applied mutator cannot drift. */
  async addReceiveAddress(): Promise<{ index: number; address: string }> {
    if (this.activeKind === 'pk' || this.activeFamily === 'evm') throw new Error('single-address-wallet');
    const targetId = await this.sessionWalletId();
    if (!targetId) throw new Error('no-active-wallet');
    const added = await this.updateStore((store) => {
      const entry = store.wallets.find((w) => w.id === targetId);
      if (!entry) throw new Error('no-active-wallet');
      const count = Math.max(1, entry.addressCount ?? 1);
      if (count >= MAX_RECEIVE_ADDRESSES) throw new Error('address-limit-reached');
      const index = count;
      const key = this.deriveKey(index); // requires unlock; throws when locked
      entry.addressCount = count + 1;
      return { index, address: key.address };
    });
    if (added === NO_WRITE) throw new Error('no-active-wallet');
    return added;
  }

  /**
   * GAP-LIMIT DISCOVERY. Walk the receive chain from index 0 asking the server
   * which addresses have on-chain HISTORY, and raise this wallet's
   * `addressCount` to cover the highest used one.
   *
   * This is the fix for "an imported wallet shows a smaller balance than I
   * expect": the wallet only ever derived the addresses it created itself, so a
   * seed that was used elsewhere had funds sitting on indices this wallet had
   * never looked at. Because balance reads, UTXO gathering and coin selection
   * all iterate `addressCount` keys, raising the count is the whole fix -- every
   * newly-covered address becomes visible AND spendable with no other change.
   *
   * ONLY the external chain (change index 0) is scanned, because that is the
   * only chain this wallet has ever derived: buildEvrSend / buildAssetSend send
   * change back to the primary RECEIVE address, and every deriveAddress() call
   * in this file passes change=0. There is no separate change chain to find.
   *
   * "Used" means HAS HISTORY, not has a balance: an address that received coins
   * and later spent them all is used, and BIP44's gap rule is defined over
   * history. getAddressHistory() is the cheapest existing read that answers it
   * (one blockchain.scripthash.get_history, tx hashes and heights only) and it
   * is the same call the transaction cache already uses.
   *
   * BOUNDED IN BOTH DIRECTIONS:
   *   - GAP_LIMIT consecutive empty addresses end the scan (the BIP44 rule), and
   *   - MAX_SCAN_INDEX ends it unconditionally, so a hostile or broken server
   *     that answers "used" forever cannot make this loop without end.
   *
   * A FAILED READ IS INCONCLUSIVE, NEVER EMPTY. Counting a failure as empty
   * would let a few dropped responses satisfy the gap and end the scan early,
   * which is precisely how funds stay hidden. So a failure neither advances nor
   * resets the gap counter and can never raise `highestUsedIndex`; it is counted
   * in `failedReads`, and it clears `complete` so the caller can tell the user
   * the answer is a lower bound and offer a re-run. The one exception is a
   * server REFUSING an address as "history too large", which is the server
   * stating that history exists: that counts as used.
   *
   * NEVER LOWERS the count, and never skips an index: BIP44 requires 0..N-1 to
   * all exist, and an address the user created by hand but never used must not
   * be dropped. The store is re-read after the scan so a concurrent
   * addReceiveAddress() cannot be clobbered, and nothing is written at all
   * unless the count actually grows.
   *
   * Requires an UNLOCKED wallet (deriving each address needs the seed). A 'pk'
   * wallet is single-address by construction and returns immediately, unchanged.
   */
  async discoverUsedAddresses(opts?: DiscoverAddressesOptions): Promise<AddressScanResult> {
    // Fail before any network round-trip rather than at the first derivation.
    if (!this.isUnlocked()) throw new Error('Live wallet is locked');

    if (this.activeKind === 'pk') {
      // One key, one address, no derivation tree: there is nothing to discover.
      return {
        scanned: 0,
        highestUsedIndex: -1,
        addressCountBefore: 1,
        addressCountAfter: 1,
        failedReads: 0,
        complete: true,
      };
    }

    const store = await this.loadStore();
    const entry = this.sessionEntry(store);
    if (!entry) throw new Error('no-active-wallet');
    // The wallet these findings belong to. A scan is seconds long, so the user
    // can switch wallets while it runs; writing this scan's answer onto whatever
    // happens to be active at the end would raise a DIFFERENT seed's count.
    const scannedWalletId = entry.id;
    const addressCountBefore = Math.max(1, entry.addressCount ?? 1);

    let highestUsedIndex = -1;
    let scanned = 0;
    let failedReads = 0;
    let consecutiveEmpty = 0;
    let consecutiveFailures = 0;
    let endedOnGapLimit = false;

    for (let index = 0; index <= MAX_SCAN_INDEX; index++) {
      const { address } = this.deriveKey(index);
      scanned++;

      // true = has history, false = provably empty, null = could not be read.
      let used: boolean | null;
      try {
        const history = await this.provider.getAddressHistory(address);
        used = history.length > 0;
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof AddressHistoryRefusedError && err.tooLarge) {
          // "history too large" is the server telling us this address HAS
          // history, just more than it will serve. Treating that as empty would
          // hide the most heavily used address of all.
          used = true;
          consecutiveFailures = 0;
        } else {
          used = null;
          failedReads++;
          consecutiveFailures++;
        }
      }

      if (used === true) {
        highestUsedIndex = index;
        consecutiveEmpty = 0;
      } else if (used === false) {
        consecutiveEmpty++;
      }
      // used === null deliberately touches neither counter.

      opts?.onProgress?.({ scanned, highestUsedIndex });

      if (used === false && consecutiveEmpty >= GAP_LIMIT) {
        endedOnGapLimit = true;
        break;
      }
      if (used === null && consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
        break; // the connection is gone; keep whatever was proven before it died
      }
    }

    // Decided from the store the write is based on: the scan is many round-trips
    // long, and an addReceiveAddress() that landed meanwhile must not be undone.
    // Found BY ID, not by "whichever is active now", per scannedWalletId above.
    let addressCountAfter = addressCountBefore;
    await this.updateStore((fresh) => {
      const freshEntry = fresh.wallets.find((w) => w.id === scannedWalletId);
      const currentCount = Math.max(1, freshEntry?.addressCount ?? addressCountBefore);
      addressCountAfter = currentCount;
      const wanted = Math.max(currentCount, highestUsedIndex + 1);
      // Clamp with min() only where it can RAISE nothing: a corrupt stored count
      // above the cap must be left alone, not silently reduced.
      const capped = Math.min(wanted, MAX_RECEIVE_ADDRESSES);
      if (!freshEntry || capped <= currentCount) return NO_WRITE;
      freshEntry.addressCount = capped;
      addressCountAfter = capped;
      return true as const;
    });

    return {
      scanned,
      highestUsedIndex,
      addressCountBefore,
      addressCountAfter,
      failedReads,
      // A gap-limit finish with every address answered is the only authoritative
      // outcome. The ceiling and a dead connection both leave a lower bound.
      complete: endedOnGapLimit && failedReads === 0,
    };
  }

  getProvider(): WalletDataProvider {
    return this.provider;
  }

  /** Drop the current Electrum connection. The next provider request calls
   *  client.connect() again, which re-resolves the live server pool — so this is
   *  how a user's server-pool change (Settings → Network) takes effect. Safe to
   *  call anytime; closing an already-closed client is a no-op. */
  reconnect(): void {
    try {
      this.client.close();
    } catch {
      // ignore — best-effort teardown
    }
  }

  // --- sending (build+sign; broadcast gated) -------------------------------

  /**
   * Effective fee rate (sat/byte) for the ACTIVE chain, policy-clamped.
   *
   * `overrideSatPerByte` (the UI's pick from estimateFeeOptions()) skips the
   * server probe but is clamped IDENTICALLY — no caller-supplied value escapes
   * the chain's [floor, ceiling] band. Otherwise the untrusted server is probed
   * at the 6-block target and its answer clamped; a missing/broken/-1 estimate
   * degrades to the chain's defaultSatPerByte, which the policy tests pin
   * inside the band and above the chain's relay floor (the old global default
   * of 10 sat/byte sat BELOW Evrmore/Ravencoin's measured 1000 relay floor, so
   * a fallback-fee tx there could never have relayed).
   */
  private async feeRate(overrideSatPerByte?: bigint): Promise<bigint> {
    const policy = feePolicyFor(this.net);
    if (overrideSatPerByte !== undefined) return clampFeeRate(overrideSatPerByte, policy);
    try {
      const coinPerKb = await this.client.request<number>(ELECTRUM_METHODS.estimateFee, [6]);
      const satPerByte = serverEstimateToSatPerByte(coinPerKb, this.net.decimals);
      if (satPerByte !== null) return clampFeeRate(satPerByte, policy);
    } catch {
      /* fall through to the chain default */
    }
    return policy.defaultSatPerByte;
  }

  /**
   * Fee OPTIONS for the ACTIVE chain — the UI's data source for a fee-speed
   * picker. Probes the server at FEE_OPTION_TARGET_BLOCKS (2/6/25: fast,
   * normal, slow) and returns each target's effective, policy-clamped rate plus
   * the chain's floor/ceiling/default for display.
   *
   * `differentiated` tells the UI whether a speed choice is REAL: measured
   * 2026-08-14, five of the six chains answer one flat number for every target
   * (only Bitcoin returns a curve), so rendering fast/normal/slow there would
   * offer three identical options. Only offer a picker when it is true; when
   * false, any option (or the chain default) is THE rate. A chosen option's
   * satPerByte is applied by passing it as SendFeeOptions.feeRateSatPerByte to
   * buildEvrSend / buildAssetSend / estimateMaxEvr (it is re-clamped there).
   *
   * NEVER throws: a target whose probe errors or answers -1 degrades to the
   * chain default (marked estimated:false), and a hostile rate is ceiling-
   * clamped, so the UI always gets a usable, bounded set of rates.
   */
  async estimateFeeOptions(): Promise<FeeEstimate> {
    const policy = feePolicyFor(this.net);
    const ratesByTarget = await Promise.all(
      FEE_OPTION_TARGET_BLOCKS.map(async (target): Promise<bigint | null> => {
        try {
          const coinPerKb = await this.client.request<number>(ELECTRUM_METHODS.estimateFee, [target]);
          return serverEstimateToSatPerByte(coinPerKb, this.net.decimals);
        } catch {
          return null; // this target degrades to the chain default
        }
      }),
    );
    return buildFeeEstimate(this.net.chainId, policy, ratesByTarget);
  }

  private toSignable(utxos: ElectrumUtxo[], key: DerivedKey): SignableUtxo[] {
    // The prevout script must match the address's ACTUAL type: a native-segwit
    // wallet's own addresses are bech32, which addressToHash160 cannot decode at
    // all. addressToScript handles both, and the builder routes each input to
    // legacy or BIP143 signing based on exactly these bytes.
    const scriptPubKeyHex = bytesToHex(addressToScript(key.address));
    return utxos.map((u) => {
      // Harden against untrusted server data: a float or out-of-safe-range value
      // would throw or silently lose precision before reaching the fee/change
      // math. Reject anything that is not an exact, safe integer number of sats.
      if (!Number.isSafeInteger(u.value)) {
        throw new Error(`Untrusted UTXO value is not a safe integer: ${String(u.value)}`);
      }
      return {
        txid: u.tx_hash,
        vout: u.tx_pos,
        valueSats: BigInt(u.value),
        scriptPubKeyHex,
        privateKey: key.privateKey,
        publicKey: key.publicKey,
      };
    });
  }

  /** Gather signable EVR UTXOs across ALL of the wallet's addresses. Each UTXO
   *  carries its own address's key + prevout script, so multi-address spends
   *  sign correctly without any txBuilder change. */
  private async gatherEvrUtxos(keys: DerivedKey[]): Promise<SignableUtxo[]> {
    const all: SignableUtxo[] = [];
    for (const key of keys) {
      const sh = addressToElectrumScripthash(key.address);
      const utxos = await electrumListUnspent(this.client, sh);
      all.push(...this.toSignable(utxos, key));
    }
    return all;
  }

  /** Build + sign an EVR payment spending from ALL the wallet's addresses.
   *  Change returns to the primary (index-0) address. Does NOT broadcast. */
  async buildEvrSend(toAddress: string, amountSats: bigint, opts?: SendFeeOptions): Promise<LiveSendPlan> {
    if (amountSats <= 0n) throw new Error('invalid-amount');
    // Reject any recipient the builder cannot pay to: P2PKH on every chain, plus
    // native segwit where the chain has it. isValidAddress also passes P2SH (and
    // P2WSH/taproot on a segwit chain), which would make the funds unspendable.
    if (!isSpendableAddress(toAddress, this.net)) throw new Error('unsupported-address-type');
    const keys = await this.allKeys();
    const key = keys[0];
    const signable = await this.gatherEvrUtxos(keys);
    const feeRate = await this.feeRate(opts?.feeRateSatPerByte);
    const selection = selectCoins(signable, amountSats, feeRate);
    if ('error' in selection) throw new Error('insufficient-funds');
    // Trustlessly verify the selected inputs' amounts (legacy sighash doesn't
    // commit them) so a lying server can't inflate the real fee. Throws on a lie.
    await verifyInputAmounts(
      this.client,
      selection.inputs.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        valueSats: u.valueSats,
        scriptPubKeyHex: u.scriptPubKeyHex,
        kind: 'evr' as const,
      })),
    );
    const built = buildAndSignEvrTx({
      inputs: selection.inputs,
      outputs: [{ address: toAddress, valueSats: amountSats }],
      changeAddress: key.address,
      feeSats: selection.feeSats,
      // Lets the builder assert a segwit input never appears on a legacy chain.
      net: this.net,
    });
    assertFeeSane(built.feeSats, feePolicyFor(this.net));
    return { built, toAddress, amountSats, feeSats: built.feeSats };
  }

  /** Max EVR that can be SENT = (all EVR UTXOs) − network fee to spend them all
   *  into a single output (no change). Returns the sendable amount and that fee,
   *  both in sats. Used by the "Max" button so the user can empty the wallet. */
  async estimateMaxEvr(opts?: SendFeeOptions): Promise<{ maxSats: bigint; feeSats: bigint; totalSats: bigint }> {
    const keys = await this.allKeys();
    const signable = await this.gatherEvrUtxos(keys);
    const totalSats = signable.reduce((acc, u) => acc + u.valueSats, 0n);
    if (totalSats === 0n || signable.length === 0) return { maxSats: 0n, feeSats: 0n, totalSats: 0n };
    const feeRate = await this.feeRate(opts?.feeRateSatPerByte);
    // Fee for a tx spending every UTXO into ONE recipient output (no change).
    // Size from the ACTUAL utxos, not from their count: estimateTxBytes prices
    // every input as legacy p2pkh (148 vB), while a segwit input really costs
    // about 68. On a Max send the fee IS the remainder, so an over-estimate is
    // not a harmless safety margin, it is burnt to miners instead of being sent.
    const feeSats = feeRate * BigInt(estimateSpendVBytes(signable, 1));
    const maxSats = totalSats > feeSats ? totalSats - feeSats : 0n;
    return { maxSats, feeSats, totalSats };
  }

  /**
   * Build + sign an EVRmore asset transfer (e.g. SATORIEVR). Does NOT broadcast.
   *
   * `amountSats` is the asset amount in 1e8 base units (whole units × 1e8), the
   * same base every Evrmore asset uses on-chain regardless of its `divisions`.
   *
   * The asset input's sighash prevout script is the FULL asset scriptPubKey
   * (P2PKH || OP_EVR_ASSET transfer script), reconstructed per-UTXO with
   * buildTransferAssetScriptFromHash160 — verified byte-for-byte against real
   * on-chain asset UTXOs (SATORIEVR/SATORI/CHUPPA_CHUB). EVR inputs pay the fee.
   */
  async buildAssetSend(
    toAddress: string,
    assetName: string,
    amountSats: bigint,
    opts?: SendFeeOptions,
  ): Promise<LiveSendPlan> {
    const name = assetName.trim().toUpperCase();
    if (amountSats <= 0n) throw new Error('invalid-amount');
    // Asset transfers only exist on Ravencoin-family chains. On a plain chain
    // (no OP_x_ASSET) this path must never build anything: fail loudly here
    // rather than emit a script that chain's consensus does not understand.
    if (!supportsAssets(this.net)) throw new Error('assets-not-supported');
    // Asset transfer scripts embed a P2PKH recipient — reject non-P2PKH / wrong
    // network so the asset can't be sent to an output the recipient can't spend.
    if (!isP2pkhAddress(toAddress, this.net)) throw new Error('unsupported-address-type');

    const keys = await this.allKeys();
    const key = keys[0];

    // Validate the amount respects the asset's divisions (an N-division asset can
    // only move multiples of 10^(8-N) base units).
    const meta = await this.provider.getAssetMeta(name);
    if (!meta || !meta.exists) throw new Error('unknown-asset');
    const step = 10n ** BigInt(8 - meta.decimals);
    if (amountSats % step !== 0n) throw new Error('invalid-amount-precision');

    // Asset inputs from ALL addresses: each carries its own address's full asset
    // scriptPubKey (that address's h160) for signing.
    const assetSignable: SignableUtxo[] = [];
    for (const k of keys) {
      const sh = addressToElectrumScripthash(k.address);
      const h160 = addressToHash160(k.address).hash;
      const assetUtxos = await electrumListUnspent(this.client, sh, name);
      for (const u of assetUtxos) {
        if (!Number.isSafeInteger(u.value)) {
          throw new Error(`Untrusted asset UTXO value is not a safe integer: ${String(u.value)}`);
        }
        assetSignable.push({
          txid: u.tx_hash,
          vout: u.tx_pos,
          valueSats: BigInt(u.value),
          // Build the prevout's sighash script with the ACTIVE chain's marker
          // family so it matches the on-chain script byte-for-byte (rvnt on RVN).
          scriptPubKeyHex: bytesToHex(
            buildTransferAssetScriptFromHash160(h160, name, BigInt(u.value), this.net.assetMarkerPrefix),
          ),
          privateKey: k.privateKey,
          publicKey: k.publicKey,
        });
      }
    }

    const byValueDesc = (a: SignableUtxo, b: SignableUtxo) =>
      a.valueSats < b.valueSats ? 1 : a.valueSats > b.valueSats ? -1 : 0;

    // Greedily select asset inputs to cover the amount.
    const assetInputs: SignableUtxo[] = [];
    let assetAcc = 0n;
    for (const u of [...assetSignable].sort(byValueDesc)) {
      assetInputs.push(u);
      assetAcc += u.valueSats;
      if (assetAcc >= amountSats) break;
    }
    if (assetAcc < amountSats) throw new Error('insufficient-asset');
    const assetChangeSats = assetAcc - amountSats;

    // EVR inputs (from all addresses) pay the fee. Grow the selection until EVR
    // covers the (fee-rate × size) estimate, padding for the asset-script outputs.
    const evrSignable = await this.gatherEvrUtxos(keys);
    const feeRate = await this.feeRate(opts?.feeRateSatPerByte);
    const numAssetOuts = assetChangeSats > 0n ? 2 : 1;
    const evrInputs: SignableUtxo[] = [];
    let evrAcc = 0n;
    let feeSats = 0n;
    for (const u of [...evrSignable].sort(byValueDesc)) {
      evrInputs.push(u);
      evrAcc += u.valueSats;
      const bytes =
        estimateTxBytes(assetInputs.length + evrInputs.length, numAssetOuts + 1) + 60 * numAssetOuts;
      feeSats = feeRate * BigInt(bytes);
      if (evrAcc >= feeSats) break;
    }
    if (evrInputs.length === 0 || evrAcc < feeSats) throw new Error('insufficient-evr-for-fee');

    // Trustlessly verify EVERY selected input (asset + EVR) against its authentic
    // prevout — legacy sighash doesn't commit input amounts, so this is what stops
    // a lying server from inflating the real fee. For asset inputs it also binds
    // the claimed asset amount (encoded in the OP_EVR_ASSET script, nValue=0).
    // Throws on a lie.
    await verifyInputAmounts(
      this.client,
      [
        ...assetInputs.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          valueSats: u.valueSats,
          scriptPubKeyHex: u.scriptPubKeyHex,
          kind: 'asset' as const,
        })),
        ...evrInputs.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          valueSats: u.valueSats,
          scriptPubKeyHex: u.scriptPubKeyHex,
          kind: 'evr' as const,
        })),
      ],
      // Decode asset prevouts as the ACTIVE chain's family: a wrong-chain marker
      // (e.g. an 'evrt' output while sending RVN) fails closed here.
      this.net.assetMarkerPrefix,
    );

    const built = buildAndSignAssetTransfer({
      assetInputs,
      evrInputs,
      assetOut: { address: toAddress, assetName: name, amountSats },
      assetChange:
        assetChangeSats > 0n
          ? { address: key.address, assetName: name, amountSats: assetChangeSats }
          : undefined,
      evrChangeAddress: key.address,
      feeSats,
      assetMarkerPrefix: this.net.assetMarkerPrefix,
    });

    assertFeeSane(built.feeSats, feePolicyFor(this.net));
    return { built, toAddress, amountSats, feeSats: built.feeSats, assetName: name, assetDecimals: meta.decimals };
  }

  /** Verify a password against the stored vault WITHOUT changing session state.
   *  Used to require the wallet password immediately before a broadcast.
   *
   *  For an app-key (v2) wallet the password to prove is the APP password, and
   *  it is genuinely re-derived rather than compared against the master key the
   *  session holds: this gate exists so that a wallet left unlocked on a desk
   *  still cannot be spent from without the password.
   *
   *  `noSendPassword` is the §6 successor of `passwordless` and answers exactly
   *  what `passwordless` answered here before the wallet migrated. */
  async verifyPassword(password: string): Promise<boolean> {
    const store = await this.loadStore();
    const entry = this.sessionEntry(store);
    if (!entry) return false;
    if (isVaultRecordV2(entry.vault)) {
      if (entry.noSendPassword) return true; // the convenience the user chose
      if (!store.appKey) return false; // a v2 vault with no app record: fail closed
      return verifyAppPassword(store.appKey, password);
    }
    if (entry.passwordless) return true; // no password to verify
    try {
      await unlockVaultString(entry.vault, password);
      return true;
    } catch {
      return false;
    }
  }

  /** Broadcast a previously built+signed tx. GATED: throws unless armed, and
   *  single-use — the gate auto-disarms after every attempt so each broadcast
   *  requires a fresh, deliberate arming.
   *
   *  On success: returns the LOCALLY computed txid, after checking that the
   *  server's answer names that same transaction. A server that answers a
   *  DIFFERENT id (or something that is not a txid at all) is not believed in
   *  either direction: its string is never returned, and it is not treated as a
   *  failure either, because a broadcast may well have happened. That case is
   *  routed into the same on-chain check an ambiguous error gets.
   *  On a CLEAN daemon rejection (code 1, "rejected by network rules"): the
   *  outcome is definitively "not sent" — rethrown immediately, no polling.
   *  On ANY other error (crash, timeout, dropped connection): the outcome is
   *  UNKNOWN, so we poll `blockchain.transaction.get` for the tx by its
   *  LOCALLY computed txid (never a server-supplied one) before deciding. If
   *  it shows up, the send worked — return success. If it never appears,
   *  throw the 'broadcast-unconfirmed' error code so the caller can tell the
   *  user nothing was sent and it's safe to retry. */
  async broadcast(rawHex: string, knownTxid?: string): Promise<string> {
    if (!this.allowBroadcast) throw new BroadcastGatedError();
    // A txid is the hash of the WITNESS-FREE serialization. `rawHex` is what we
    // broadcast, which for a segwit spend INCLUDES the witness, so hashing it
    // here yields the wtxid. Polling for that after an ambiguous broadcast could
    // never find the transaction, so a send that actually landed was reported as
    // "nothing was sent, safe to try again" on every segwit chain, inviting a
    // second real payment.
    //
    // Callers holding a built plan pass its txid, which the builder already
    // computed over the stripped form. Otherwise derive it, but NEVER let that
    // derivation fail the send: the transaction is signed and about to go out,
    // so a parse problem must degrade to the raw hash, not throw.
    const expectedTxid = knownTxid ?? localTxidOf(rawHex); // local, pre-broadcast
    try {
      // Two ways out of the RPC leave the outcome unresolved: an ambiguous error
      // (a crash, a timeout, a dropped connection), and an answer that does not
      // name the transaction we signed. Both converge on the same on-chain
      // check below, so the server's word is never what decides the outcome and
      // its string is never what the user is shown.
      let answer: unknown = null;
      try {
        answer = await this.client.request<string>(ELECTRUM_METHODS.txBroadcast, [rawHex]);
      } catch (err) {
        if (isCleanBroadcastRejection(err)) throw err;
      }
      // The honest case: the server hashed the same bytes and said so. Returns
      // without a single extra request, exactly as before.
      if (broadcastAnswerMatches(answer, expectedTxid)) return expectedTxid;
      const landed = await this.pollForBroadcastOutcome(expectedTxid);
      if (landed) return expectedTxid;
      throw new Error('broadcast-unconfirmed');
    } finally {
      this.allowBroadcast = false;
    }
  }

  /** Resolve an UNKNOWN broadcast outcome by polling for `expectedTxid` on
   *  chain (mempool or block). Returns true the moment it's found; false once
   *  every attempt is exhausted. Never throws — a lookup failure just means
   *  "not found yet" to the caller. */
  private async pollForBroadcastOutcome(expectedTxid: string): Promise<boolean> {
    for (const delayMs of this.broadcastPollDelaysMs) {
      await sleep(delayMs);
      try {
        await this.client.request<string>(ELECTRUM_METHODS.txGet, [expectedTxid]);
        return true; // the tx is known to the network — the broadcast worked
      } catch {
        // Still unknown to this server; keep polling.
      }
    }
    return false;
  }

  /** Fully reset: remove ALL wallets and both the new and legacy storage keys.
   *  The app-password record lives inside the wallet store, so it goes with it,
   *  and lockApp() zeroes the master key that record derived. */
  async reset(): Promise<void> {
    this.lockApp();
    await getStorage().remove(WALLETS_KEY);
    await getStorage().remove(LEGACY_KEY);
    this.activeId = null;
  }
}

export const SATORI = SATORI_ASSET;
