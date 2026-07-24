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
  type EvrmoreNetwork,
} from './chainParams';
import {
  deriveAddress,
  addressToElectrumScripthash,
  addressToHash160,
  isP2pkhAddress,
  p2pkhScript,
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  privateKeyToDerived,
  parsePrivateKey,
  type DerivedKey,
} from './keys';
import { signMessageWithKey } from './message';
import { verifyInputAmounts } from './verifyUtxo';
import { createVault, unlockVaultString, changeVaultPassword, type VaultRecord } from './vault';
import {
  createElectrumClient,
  electrumListUnspent,
} from './electrumClient';
import { ElectrumWalletDataProvider } from './electrumProvider';
import type { ElectrumClient, ElectrumUtxo } from './electrumTypes';
import {
  selectCoins,
  buildAndSignEvrTx,
  buildAndSignAssetTransfer,
  estimateTxBytes,
  txid,
  type SignableUtxo,
  type BuiltTx,
} from './txBuilder';
import { buildTransferAssetScriptFromHash160 } from './assetScript';
import { ELECTRUM_METHODS, SATORI_ASSET } from './network';
import type { WalletDataProvider } from '../provider';
import { bytesToHex } from '@noble/hashes/utils';

// Stored per-wallet network id. 'mainnet'/'testnet' are the LEGACY Evrmore ids
// (kept verbatim so existing wallet records still resolve to Evrmore); new
// non-Evrmore chains use their canonical id, e.g. 'ravencoin-mainnet'.
export type LiveNetworkId = 'mainnet' | 'testnet' | 'ravencoin-mainnet';

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
  network: LiveNetworkId;
  vault: VaultRecord;
  createdAt: number;
  /** 'seed' (HD) or 'pk' (single imported key). Legacy entries default to 'seed'. */
  kind?: WalletKind;
  /** Public primary address (may be '' for a migrated wallet until first unlock). */
  address?: string;
  /** When true the vault is encrypted with an EMPTY passphrase — convenient (no
   *  password to unlock or to send) but NOT securely protected at rest. Opt-in. */
  passwordless?: boolean;
  /** How many receive addresses (m/44'/coin'/0'/0/0..N-1) this seed wallet has
   *  derived. Absent/legacy = 1. Always 1 for kind:'pk'. */
  addressCount?: number;
}

/** Upper bound on derived receive addresses per wallet (UI/scan sanity cap). */
export const MAX_RECEIVE_ADDRESSES = 20;

/** The fixed (empty) passphrase used for a passwordless wallet's vault. Keeps the
 *  storage format uniform (still AES-GCM, never literal plaintext) while requiring
 *  no user secret. This is convenience, not protection — documented to the user. */
const NO_PASSWORD = '';

/** Persisted multi-wallet store (storage key `liveWallets`). */
interface LiveWalletsStore {
  version: 1;
  wallets: WalletEntry[];
  activeId: string;
}

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
  /** True when the wallet has no password (unlocks + sends without one). */
  passwordless: boolean;
}

/** Storage key for the multi-wallet store. */
const WALLETS_KEY = 'liveWallets';
/** Legacy single-wallet key. Read once for migration; never written again. */
const LEGACY_KEY = 'liveWallet';

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

/** Default fee rate (sat/byte) when the server gives no estimate. Fees are only
 *  consumed at broadcast time, which is gated; exposed for tuning. */
const DEFAULT_FEE_RATE_SAT_PER_BYTE = 10n;

// SECURITY: the fee rate comes from an untrusted Electrum server (estimatefee).
// Without a ceiling, a hostile/MITM'd server could return an enormous rate so the
// whole balance is consumed as the fee (change below dust is absorbed into it).
// Real Evrmore fees are ~1–10 sat/byte, so cap the rate hard, AND independently
// reject any built transaction whose absolute fee exceeds MAX_ABSOLUTE_FEE_SATS.
const MAX_FEE_RATE_SAT_PER_BYTE = 1000n; // ~0.004 EVR for a typical tx — plenty
const MAX_ABSOLUTE_FEE_SATS = 100_000_000n; // 1 EVR hard ceiling on any single tx fee

/** Reject an implausibly large fee before it is ever broadcast (defence-in-depth
 *  against a malicious estimatefee even if the rate cap is bypassed). */
function assertFeeSane(feeSats: bigint): void {
  if (feeSats > MAX_ABSOLUTE_FEE_SATS) {
    throw new Error(
      `fee-too-high: ${feeSats} sats exceeds the ${MAX_ABSOLUTE_FEE_SATS}-sat safety ceiling ` +
        `(possible hostile fee estimate)`,
    );
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

/** Poll cadence for an UNKNOWN broadcast outcome: 8 attempts with a growing
 *  delay, ~45s total. Overridable via the constructor so tests can shrink it. */
const DEFAULT_BROADCAST_POLL_DELAYS_MS = [1000, 2000, 3000, 4000, 6000, 8000, 10000, 11000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LiveWalletService {
  /** ACTIVE seed-wallet: BIP39 seed in memory (null when locked or a pk-wallet). */
  private seed: Uint8Array | null = null;
  /** ACTIVE pk-wallet: raw private key in memory (null when locked or a seed-wallet). */
  private pk: Uint8Array | null = null;
  /** Compression flag of the active pk-wallet's key (matches its source WIF). */
  private pkCompressed = true;
  /** Kind of the ACTIVE wallet, so derive/reveal branch correctly. */
  private activeKind: WalletKind = 'seed';
  private net: EvrmoreNetwork = EVRMORE_MAINNET;
  /** The active wallet's stored network id (LiveNetworkId), tracked alongside
   *  `net`. `net.id` alone can't carry it: Ravencoin mainnet also has net.id
   *  'mainnet', so we keep the canonical LiveNetworkId here for network(). */
  private activeNetworkId: LiveNetworkId = 'mainnet';
  /** Cached id of the active wallet, kept in sync with the persisted store so
   *  activeWalletId() can answer synchronously. */
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
      this.activeId = existing.activeId || null;
      // Make the active chain follow the active wallet on load (before any
      // unlock) so network()/marker/magic are correct for a stored RVN wallet.
      const active = existing.wallets.find((w) => w.id === existing.activeId);
      if (active) this.setActiveNetwork(active.network);
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
      };
      await getStorage().set(WALLETS_KEY, store);
      this.activeId = id;
      return store;
    }

    this.activeId = null;
    return { version: 1, wallets: [], activeId: '' };
  }

  private async saveStore(store: LiveWalletsStore): Promise<void> {
    await getStorage().set(WALLETS_KEY, store);
    this.activeId = store.activeId || null;
  }

  private activeEntry(store: LiveWalletsStore): WalletEntry | undefined {
    return store.wallets.find((w) => w.id === store.activeId);
  }

  private netFor(network: LiveNetworkId): EvrmoreNetwork {
    switch (network) {
      case 'testnet':
        return EVRMORE_TESTNET;
      case 'ravencoin-mainnet':
        return RAVENCOIN_MAINNET;
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
   */
  async create(
    password: string,
    opts?: { network?: LiveNetworkId; strength?: 128 | 256; name?: string },
  ): Promise<{ mnemonic: string }> {
    const mnemonic = generateMnemonic(opts?.strength ?? 128);
    await this.addWallet(mnemonic, password, opts?.network ?? 'mainnet', opts?.name);
    return { mnemonic };
  }

  /** Import an existing BIP39 mnemonic as a NEW wallet, make it active + unlock. */
  async import(
    mnemonic: string,
    password: string,
    network: LiveNetworkId = 'mainnet',
    name?: string,
  ): Promise<void> {
    const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
    if (!validateMnemonic(trimmed)) throw new Error('Invalid recovery phrase');
    await this.addWallet(trimmed, password, network, name);
  }

  /** Encrypt the mnemonic, append a seed-wallet entry, set it active and unlock it. */
  private async addWallet(
    mnemonic: string,
    password: string,
    network: LiveNetworkId,
    name?: string,
  ): Promise<void> {
    const store = await this.loadStore();
    const passwordless = password.length === 0;
    const vault = await createVault(mnemonic, passwordless ? NO_PASSWORD : password);
    const seed = await mnemonicToSeed(mnemonic);
    const net = this.netFor(network);
    const address = deriveAddress(seed, net, 0, 0, 0).address;
    const id = genWalletId(new Set(store.wallets.map((w) => w.id)));
    const walletName = name?.trim() || `Wallet ${store.wallets.length + 1}`;
    store.wallets.push({ id, name: walletName, network, vault, createdAt: Date.now(), kind: 'seed', address, passwordless });
    store.activeId = id;
    await this.saveStore(store);
    this.setActiveNetwork(network);
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
  ): Promise<void> {
    const { privateKey, compressed } = parsePrivateKey(privateKeyInput);
    const net = this.netFor(network);
    const derived = privateKeyToDerived(privateKey, net, compressed);
    const store = await this.loadStore();
    const passwordless = password.length === 0;
    // Store the canonical WIF (not the user's raw input) so unlock() is uniform.
    const vault = await createVault(derived.wif, passwordless ? NO_PASSWORD : password);
    const id = genWalletId(new Set(store.wallets.map((w) => w.id)));
    const walletName = name?.trim() || `Satori wallet ${store.wallets.length + 1}`;
    store.wallets.push({
      id,
      name: walletName,
      network,
      vault,
      createdAt: Date.now(),
      kind: 'pk',
      address: derived.address,
      passwordless,
    });
    store.activeId = id;
    await this.saveStore(store);
    this.setActiveNetwork(network);
    this.setActivePk(privateKey, compressed);
  }

  /** Unlock the ACTIVE wallet, loading its secret (seed or private key) into memory. */
  async unlock(password: string): Promise<boolean> {
    const store = await this.loadStore();
    const entry = this.activeEntry(store);
    if (!entry) return false;
    let secret: string;
    try {
      secret = await unlockVaultString(entry.vault, entry.passwordless ? NO_PASSWORD : password);
    } catch {
      return false;
    }
    this.setActiveNetwork(entry.network);
    let address: string;
    if (entry.kind === 'pk') {
      const { privateKey, compressed } = parsePrivateKey(secret);
      this.setActivePk(privateKey, compressed);
      address = privateKeyToDerived(privateKey, this.net, compressed).address;
    } else {
      const seed = await mnemonicToSeed(secret);
      this.setActiveSeed(seed);
      address = deriveAddress(seed, this.net, 0, 0, 0).address;
    }
    // Backfill the cached public address for a migrated wallet (unknown until now).
    if (!entry.address) {
      entry.address = address;
      await this.saveStore(store);
    }
    return true;
  }

  /** Change the ACTIVE wallet's vault password. An empty `newPassword` makes the
   *  wallet passwordless; a non-empty one on a passwordless wallet adds a password. */
  async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
    const store = await this.loadStore();
    const entry = this.activeEntry(store);
    if (!entry) return false;
    const oldPw = entry.passwordless ? NO_PASSWORD : oldPassword;
    const newPasswordless = newPassword.length === 0;
    try {
      entry.vault = await changeVaultPassword(entry.vault, oldPw, newPasswordless ? NO_PASSWORD : newPassword);
      entry.passwordless = newPasswordless;
      await this.saveStore(store);
      return true;
    } catch {
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
    return store.wallets.map((w) => ({
      id: w.id,
      name: w.name,
      network: w.network,
      createdAt: w.createdAt,
      active: w.id === store.activeId,
      kind: w.kind ?? 'seed',
      address: w.address ?? '',
      passwordless: w.passwordless ?? false,
    }));
  }

  /** The active wallet's id, or null if there are no wallets. Synchronous: reads
   *  the cache refreshed by every async store access on this instance. */
  activeWalletId(): string | null {
    return this.activeId;
  }

  /** Switch the active wallet. The newly-active wallet starts LOCKED — the seed
   *  is cleared and the caller must unlock() with that wallet's own password. */
  async switchWallet(id: string): Promise<void> {
    const store = await this.loadStore();
    const entry = store.wallets.find((w) => w.id === id);
    if (!entry) throw new Error('unknown-wallet');
    store.activeId = id;
    await this.saveStore(store);
    this.lock();
    this.setActiveNetwork(entry.network);
    this.activeKind = entry.kind ?? 'seed';
  }

  /** Rename a wallet (empty/whitespace names are ignored, keeping the old name). */
  async renameWallet(id: string, name: string): Promise<void> {
    const store = await this.loadStore();
    const entry = store.wallets.find((w) => w.id === id);
    if (!entry) throw new Error('unknown-wallet');
    const next = name.trim();
    if (next) entry.name = next;
    await this.saveStore(store);
  }

  /** Remove a wallet. If it was active, promote the first remaining wallet (or
   *  none) and clear the in-memory seed. */
  async removeWallet(id: string): Promise<void> {
    const store = await this.loadStore();
    const idx = store.wallets.findIndex((w) => w.id === id);
    if (idx === -1) return;
    const wasActive = store.activeId === id;
    store.wallets.splice(idx, 1);
    if (wasActive) {
      store.activeId = store.wallets.length > 0 ? store.wallets[0].id : '';
      this.lock();
      const promoted = this.activeEntry(store);
      if (promoted) this.setActiveNetwork(promoted.network);
    }
    await this.saveStore(store);
  }

  // --- reveal secrets (password-gated) ------------------------------------

  /** Verify `password` against the ACTIVE wallet and return its recovery phrase,
   *  or null on a wrong password. Returns null for a pk-wallet (which has NO
   *  recovery phrase — only a private key). Does not alter session state. */
  async revealMnemonic(password: string): Promise<string | null> {
    const store = await this.loadStore();
    const entry = this.activeEntry(store);
    if (!entry) return null;
    if (entry.kind === 'pk') return null; // pk-wallets have no seed phrase
    try {
      return await unlockVaultString(entry.vault, entry.passwordless ? NO_PASSWORD : password);
    } catch {
      return null;
    }
  }

  /** Verify `password`, then return the ACTIVE wallet's private key as WIF, or
   *  null on a wrong password. For a pk-wallet the stored secret IS the WIF; for
   *  a seed-wallet the key at m/44'/coin'/0'/0/index is derived. Any secret
   *  decrypted here is local and zeroed; the active in-memory secret is untouched. */
  async revealPrivateKeyWif(password: string, index = 0): Promise<string | null> {
    const store = await this.loadStore();
    const entry = this.activeEntry(store);
    if (!entry) return null;
    let secret: string;
    try {
      secret = await unlockVaultString(entry.vault, entry.passwordless ? NO_PASSWORD : password);
    } catch {
      return null;
    }
    if (entry.kind === 'pk') return secret; // stored value is already the canonical WIF
    const seed = await mnemonicToSeed(secret);
    try {
      return deriveAddress(seed, this.netFor(entry.network), 0, 0, index).wif;
    } finally {
      seed.fill(0);
    }
  }

  private requireSeed(): Uint8Array {
    if (!this.seed) throw new Error('Live wallet is locked');
    return this.seed;
  }

  // --- addresses / reads ---------------------------------------------------

  /** Derive the signing key. Seed-wallets derive m/44'/coin'/0'/0/index; pk-wallets
   *  have exactly ONE key so `index` is ignored. */
  deriveKey(index = 0): DerivedKey {
    if (this.activeKind === 'pk') {
      if (!this.pk) throw new Error('Live wallet is locked');
      return privateKeyToDerived(this.pk, this.net, this.pkCompressed);
    }
    return deriveAddress(this.requireSeed(), this.net, 0, 0, index);
  }

  getAddress(index = 0): string {
    return this.deriveKey(index).address;
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
    if (this.activeKind === 'pk') return [this.deriveKey(0)];
    const store = await this.loadStore();
    const entry = this.activeEntry(store);
    const count = Math.max(1, Math.min(entry?.addressCount ?? 1, MAX_RECEIVE_ADDRESSES));
    const keys: DerivedKey[] = [];
    for (let i = 0; i < count; i++) keys.push(this.deriveKey(i));
    return keys;
  }

  /** All receive addresses of the ACTIVE wallet, in derivation order. */
  async listAddresses(): Promise<{ index: number; address: string }[]> {
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
   *  Throws for pk wallets (single-address by construction) and at the cap. */
  async addReceiveAddress(): Promise<{ index: number; address: string }> {
    if (this.activeKind === 'pk') throw new Error('single-address-wallet');
    const store = await this.loadStore();
    const entry = this.activeEntry(store);
    if (!entry) throw new Error('no-active-wallet');
    const count = Math.max(1, entry.addressCount ?? 1);
    if (count >= MAX_RECEIVE_ADDRESSES) throw new Error('address-limit-reached');
    const index = count;
    const key = this.deriveKey(index); // requires unlock; throws when locked
    entry.addressCount = count + 1;
    await this.saveStore(store);
    return { index, address: key.address };
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

  private async feeRate(): Promise<bigint> {
    try {
      const evrPerKb = await this.client.request<number>(ELECTRUM_METHODS.estimateFee, [6]);
      if (typeof evrPerKb === 'number' && evrPerKb > 0) {
        const satPerByte = BigInt(Math.max(1, Math.ceil((evrPerKb * 1e8) / 1000)));
        // Clamp the untrusted server rate to a sane ceiling (anti-drain).
        return satPerByte > MAX_FEE_RATE_SAT_PER_BYTE ? MAX_FEE_RATE_SAT_PER_BYTE : satPerByte;
      }
    } catch {
      /* fall through to default */
    }
    return DEFAULT_FEE_RATE_SAT_PER_BYTE;
  }

  private toSignable(utxos: ElectrumUtxo[], key: DerivedKey): SignableUtxo[] {
    const scriptPubKeyHex = bytesToHex(p2pkhScript(addressToHash160(key.address).hash));
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
  async buildEvrSend(toAddress: string, amountSats: bigint): Promise<LiveSendPlan> {
    if (amountSats <= 0n) throw new Error('invalid-amount');
    // The builder only emits P2PKH outputs — reject any non-P2PKH / wrong-network
    // recipient (isValidAddress also passes P2SH), else funds would be unspendable.
    if (!isP2pkhAddress(toAddress, this.net)) throw new Error('unsupported-address-type');
    const keys = await this.allKeys();
    const key = keys[0];
    const signable = await this.gatherEvrUtxos(keys);
    const feeRate = await this.feeRate();
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
    });
    assertFeeSane(built.feeSats);
    return { built, toAddress, amountSats, feeSats: built.feeSats };
  }

  /** Max EVR that can be SENT = (all EVR UTXOs) − network fee to spend them all
   *  into a single output (no change). Returns the sendable amount and that fee,
   *  both in sats. Used by the "Max" button so the user can empty the wallet. */
  async estimateMaxEvr(): Promise<{ maxSats: bigint; feeSats: bigint; totalSats: bigint }> {
    const keys = await this.allKeys();
    const signable = await this.gatherEvrUtxos(keys);
    const totalSats = signable.reduce((acc, u) => acc + u.valueSats, 0n);
    if (totalSats === 0n || signable.length === 0) return { maxSats: 0n, feeSats: 0n, totalSats: 0n };
    const feeRate = await this.feeRate();
    // Fee for a tx spending every UTXO into ONE recipient output (no change).
    const feeSats = feeRate * BigInt(estimateTxBytes(signable.length, 1));
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
  async buildAssetSend(toAddress: string, assetName: string, amountSats: bigint): Promise<LiveSendPlan> {
    const name = assetName.trim().toUpperCase();
    if (amountSats <= 0n) throw new Error('invalid-amount');
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
    const feeRate = await this.feeRate();
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

    assertFeeSane(built.feeSats);
    return { built, toAddress, amountSats, feeSats: built.feeSats, assetName: name, assetDecimals: meta.decimals };
  }

  /** Verify a password against the stored vault WITHOUT changing session state.
   *  Used to require the wallet password immediately before a broadcast. */
  async verifyPassword(password: string): Promise<boolean> {
    const store = await this.loadStore();
    const entry = this.activeEntry(store);
    if (!entry) return false;
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
   *  On success: returns the txid the server returns (unchanged behaviour).
   *  On a CLEAN daemon rejection (code 1, "rejected by network rules"): the
   *  outcome is definitively "not sent" — rethrown immediately, no polling.
   *  On ANY other error (crash, timeout, dropped connection): the outcome is
   *  UNKNOWN, so we poll `blockchain.transaction.get` for the tx by its
   *  LOCALLY computed txid (never a server-supplied one) before deciding. If
   *  it shows up, the send worked — return success. If it never appears,
   *  throw the 'broadcast-unconfirmed' error code so the caller can tell the
   *  user nothing was sent and it's safe to retry. */
  async broadcast(rawHex: string): Promise<string> {
    if (!this.allowBroadcast) throw new BroadcastGatedError();
    const expectedTxid = txid(rawHex); // computed locally, before broadcast
    try {
      return await this.client.request<string>(ELECTRUM_METHODS.txBroadcast, [rawHex]);
    } catch (err) {
      if (isCleanBroadcastRejection(err)) throw err;
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

  /** Fully reset: remove ALL wallets and both the new and legacy storage keys. */
  async reset(): Promise<void> {
    this.lock();
    await getStorage().remove(WALLETS_KEY);
    await getStorage().remove(LEGACY_KEY);
    this.activeId = null;
  }
}

export const SATORI = SATORI_ASSET;
