// Live (real-chain) watch-only data provider for the wallet's ACTIVE chain.
// Implements WalletDataProvider by reading that chain over Electrum.
// CSP-safe, no Node APIs — only the ElectrumClient transport abstraction.
//
// DIALECT: Evrmore/Ravencoin ElectrumX servers speak an ASSET dialect —
// get_balance(sh, asset), listunspent(sh, true), blockchain.asset.* — that a
// PLAIN Bitcoin-style server (e.g. Fulcrum on Bitcoin Gold) does not implement:
// sending the extra asset argument there makes the call error or misbehave.
// Every asset-dialect call below is therefore gated on supportsAssets(net), i.e.
// on the chain's CAPABILITY, never on its name — a future plain chain works with
// no edits here.

import type { WalletDataProvider } from '../provider';
import { NetworkOfflineError } from '../provider';
import type {
  Asset,
  AssetBalance,
  AssetId,
  NetworkId,
  NetworkStatus,
  Transaction,
  TransactionRequest,
  TransactionSimulation,
} from '../../types/domain';
import type {
  ElectrumClient,
  ElectrumBalance,
  ElectrumHistoryItem,
  ElectrumUtxo,
} from './electrumTypes';
import { addressToElectrumScripthash } from './keys';
import { ELECTRUM_METHODS, SATORI_ASSET } from './network';
import { EVRMORE_MAINNET, supportsAssets, type EvrmoreNetwork } from './chainParams';

// ---------------------------------------------------------------------------
// Dynamic (MetaMask-style) asset detection types + helpers.
//
// These are LIVE-specific and intentionally decoupled from the domain `AssetId`
// union (which is a closed 'EVR' | 'SATORI'): on the real chain an address can
// hold ANY Evrmore asset, so balances are keyed by an arbitrary string name.
//
// Empirically confirmed against the live chain (electrum1-mainnet.evrmorecoin.org)
// using a multi-asset holder (address ERDJmNCumVpB2TEURZShQYKN4yw2zftfYQ) and a
// mixed EVR+asset holder (EVWYTYq1xMhCpDQBwNzdNgBCruDv4u49ZQ):
//
//   listunspent(sh, true) -> [
//     { tx_hash, tx_pos, height, asset: null,        value: 999146800000 },  // EVR
//     { tx_hash, tx_pos, height, asset: "SATORIEVR",  value: 2539903094412 }, // asset
//     { tx_hash, tx_pos, height, asset: "SATORI",     value: 20547945205 },
//   ]
//     - EVR outputs carry `asset: null`; asset outputs carry the asset NAME.
//     - `value` is always in the SMALLEST unit (sats = whole * 10^divisions).
//
//   get_balance(sh, true) -> {
//     "SATORIEVR": { confirmed, unconfirmed },
//     "rvn":       { confirmed, unconfirmed },   // <-- native EVR key is "rvn"
//   }
//     - The native-coin key is "rvn" (Ravencoin lineage), NOT null/""/"EVR".
//       We DERIVE balances from listunspent (grouping by asset), so we don't
//       depend on that key — but native detection tolerates null/""/rvn/evr.
//
//   asset.get_meta("SATORI") -> { sats_in_circulation, divisions, reissuable,
//                                 has_ipfs, ipfs, source, ... }
//   asset.get_meta("SATOREVR") -> {}   // {} == asset does not exist.

/**
 * The server ANSWERED a history request and REFUSED it.
 *
 * Distinct from NetworkOfflineError on purpose. A refusal means the socket is
 * healthy, the server is up, and it has decided it will not serve THIS address:
 * ElectrumX and Fulcrum both cap how much history they will return and reply
 * `{"code":1,"message":"history too large"}` for big addresses (seen live on
 * real Evrmore and Ravencoin addresses). That is permanent for this address on
 * this server — retrying forever changes nothing — whereas being offline clears
 * itself. Collapsing both into "offline" (what this provider used to do) left
 * the wallet reporting itself online with a frozen, empty Activity list and no
 * way for the user to learn why.
 *
 * `name` is part of the contract: txCache matches it structurally so the cache
 * stays decoupled from this module (see txCache's REFUSED_ERROR_NAME).
 */
export class AddressHistoryRefusedError extends Error {
  /** True for the "history too large" family of refusals — the one a user can
   *  act on ("this address is too big for this server, try another"). */
  readonly tooLarge: boolean;
  /** The server's own words, kept verbatim for diagnostics. */
  readonly serverMessage: string;

  constructor(serverMessage: string, tooLarge: boolean) {
    super(`The server refused this address's transaction history: ${serverMessage}`);
    this.name = 'AddressHistoryRefusedError';
    this.serverMessage = serverMessage;
    this.tooLarge = tooLarge;
  }
}

/** Prefix electrumClient.dispatch() puts on a JSON-RPC ERROR REPLY, i.e. on the
 *  server answering rather than the transport failing. Matching the message is
 *  the same technique liveWallet's isCleanBroadcastRejection() already uses to
 *  tell a daemon rejection from a crashed call. */
const ELECTRUM_ERROR_PREFIX = 'Electrum error:';

/** The refusals that mean "this address has more history than I will serve".
 *  Verified wording: ElectrumX answers `history too large` (code 1). The other
 *  spellings are defensive: a server whose phrasing is not matched here still
 *  surfaces through the generic refusal branch, just with generic copy. */
const HISTORY_TOO_LARGE_RE = /history (is )?too (large|long|big)|too many (history|transactions)|excessive history/i;

/** A live, dynamically-detected balance for one asset held at an address.
 *  `amount` is in WHOLE units (raw sats / 1e8; the on-chain base unit is always
 *  1e8 regardless of `decimals`). */
export interface LiveAssetBalance {
  /** On-chain asset name, uppercase (e.g. "SATORI"). "EVR" for the native coin. */
  name: string;
  /** Balance in whole units (raw sats / 1e8). */
  amount: number;
  /** Divisions / decimal places for display precision only (8 for EVR). */
  decimals: number;
  /** True for the native EVR coin, false for issued assets. */
  isNative: boolean;
}

/** Result of validating an asset name against the live chain (get_meta). */
export interface LiveAssetMeta {
  /** False when get_meta returned `{}` (asset does not exist). */
  exists: boolean;
  /** Divisions / decimal places. */
  decimals: number;
  reissuable: boolean;
  /** Total supply in WHOLE units (sats_in_circulation / 1e8). */
  supply: number;
  hasIpfs: boolean;
}

/** A live, dynamically-classified transaction relative to one address.
 *
 *  Unlike the domain `Transaction` (whose `assetId` is the closed
 *  'EVR' | 'SATORI' union), `asset` here is the ARBITRARY on-chain asset name
 *  ("EVR" for the native coin, else e.g. "SATORIEVR") — so any Evrmore asset an
 *  address holds is reported faithfully.
 *
 *  `amount` is in WHOLE units of `asset`. Verified live against a SATORIEVR
 *  output (electrum1-mainnet.evrmorecoin.org, tx
 *  b67d2317024e41b3101d43a780f87ce8ba272128dc6de2cf6d0315b12916a2c3 vout 32):
 *  the verbose tx `scriptPubKey.asset.amount` is 13.18777294 while the matching
 *  listunspent UTXO `value` is 1318777294 sats — i.e. verbose asset `amount` is
 *  already in WHOLE units (= sats / 1e8), NOT base sats. `vout.value` (EVR) is
 *  likewise decimal EVR. So no scaling of `asset.amount` is needed. */
export interface LiveTransaction {
  txid: string;
  /** "EVR" or the on-chain asset name, e.g. "SATORIEVR". */
  asset: string;
  direction: 'in' | 'out';
  /** Net moved amount in WHOLE units of `asset`. */
  amount: number;
  /** EVR fee when we are the sender, else 0.
   *  PER ADDRESS, and clamped at 0, so it CANNOT be summed across a wallet's
   *  addresses. Wallet-level aggregation uses the two raw fields below. */
  feeEvr: number;
  /** Native-coin inputs THIS address contributed, in whole coins. Raw and
   *  unclamped precisely so mergeTransactions can add it up.
   *  OPTIONAL because an entry cached by an older build predates it; the merge
   *  falls back to the per-address fee when it is missing, which is exactly the
   *  behaviour those entries already had. */
  spentNative?: number;
  /** Total native output value of the WHOLE transaction, in whole coins. Equal
   *  on every entry for the same txid, so a merge can take it from any of them. */
  totalOutNative?: number;
  status: 'confirmed' | 'pending';
  blockHeight?: number;
  timestamp: number;
  counterparty: string;
}

/**
 * Block time (unix ms) out of a raw block header, or null when it cannot be
 * trusted.
 *
 * Every chain here uses the Bitcoin header layout, whose `time` is a
 * little-endian uint32 at byte offset 68 (version 4, prev 32, merkle root 32).
 * Chains with LONGER headers (Ravencoin/Evrmore KAWPOW append fields) keep that
 * offset, so reading a fixed prefix is safe for all of them.
 *
 * The sanity window matters: a garbage or unexpected header must read as
 * "unknown" rather than as a wildly stale or future chain, because this value
 * decides whether the wallet accuses a chain of having stalled.
 */
export function parseHeaderTime(headerHex: string | undefined): number | null {
  if (!headerHex || headerHex.length < 160) return null;
  const le = headerHex.slice(136, 144);
  if (!/^[0-9a-fA-F]{8}$/.test(le)) return null;
  const seconds =
    parseInt(le.slice(0, 2), 16) |
    (parseInt(le.slice(2, 4), 16) << 8) |
    (parseInt(le.slice(4, 6), 16) << 16) |
    (parseInt(le.slice(6, 8), 16) << 24);
  const ms = seconds * 1000;
  // Bitcoin's genesis (2009) as the floor; a little slack ahead of now for the
  // two hours of drift a block timestamp is allowed.
  const FLOOR = 1_231_000_000_000;
  const CEILING = Date.now() + 3 * 60 * 60 * 1000;
  if (!Number.isFinite(ms) || ms < FLOOR || ms > CEILING) return null;
  return ms;
}

/** Raw reply of blockchain.asset.get_meta (real asset) — {} when nonexistent. */
interface ElectrumAssetMeta {
  sats_in_circulation?: number;
  divisions?: number;
  reissuable?: boolean | number;
  has_ipfs?: boolean | number;
  ipfs?: string;
}

/** Decimal places of the native coin (EVR and RVN both use 8). The native NAME is
 *  per-instance and comes from the wallet's network (net.ticker: 'EVR' on Evrmore,
 *  'RVN' on Ravencoin) — see ElectrumWalletDataProvider.nativeName. */
const NATIVE_DECIMALS = 8;
/** Evrmore asset amounts — EVR AND every issued asset — are ALWAYS stored on-chain
 *  in 1e8 base units (like satoshis), regardless of the asset's `divisions`.
 *  `divisions` only limits DISPLAY precision; it is NOT the divisor. So whole
 *  units = rawSats / 1e8 for every asset. Verified live: CHUPPA_CHUB (divisions 0)
 *  holding 100000000 sats == 1 whole unit; owner tokens read 100000000 == exactly
 *  1 token. Dividing by 10^divisions (the previous bug) over-reported low-division
 *  assets by 10^(8-divisions). */
const ASSET_BASE_UNIT = 1e8;

/** Whether a listunspent `asset` field denotes the native coin (EVR). Defensive:
 *  live data uses `null`, but tolerate ""/"rvn"/"evr" too. */
function isNativeAssetField(asset: unknown): boolean {
  if (asset === null || asset === undefined) return true;
  if (typeof asset === 'string') {
    const a = asset.trim().toLowerCase();
    return a === '' || a === 'rvn' || a === 'evr';
  }
  return false;
}

/** Normalize a user/asset name the way Evrmore expects (uppercase, trimmed). */
function normalizeAssetName(name: string): string {
  return name.trim().toUpperCase();
}

/** Parse a get_meta reply into LiveAssetMeta. Empty object => does not exist. */
function parseAssetMeta(raw: ElectrumAssetMeta | null | undefined): LiveAssetMeta {
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
    return { exists: false, decimals: 0, reissuable: false, supply: 0, hasIpfs: false };
  }
  const decimals = typeof raw.divisions === 'number' ? raw.divisions : 0;
  const sats = typeof raw.sats_in_circulation === 'number' ? raw.sats_in_circulation : 0;
  return {
    exists: true,
    decimals,
    reissuable: Boolean(raw.reissuable),
    supply: sats / ASSET_BASE_UNIT,
    hasIpfs: Boolean(raw.has_ipfs),
  };
}

// ---------------------------------------------------------------------------
// Verbose transaction types (blockchain.transaction.get with verbose=true)

interface VerboseTxScriptPubKey {
  addresses?: string[];
  address?: string;
  asset?: {
    name: string;
    amount: number;
  };
}

interface VerboseTxVout {
  value: number; // EVR amount in coins (NOT sats) — verbose tx uses decimal
  n: number;
  scriptPubKey: VerboseTxScriptPubKey;
}

interface VerboseTxVin {
  txid?: string;
  vout?: number;
  coinbase?: string; // coinbase inputs have no txid/vout
}

interface VerboseTx {
  txid: string;
  time?: number;
  vin: VerboseTxVin[];
  vout: VerboseTxVout[];
}

// ---------------------------------------------------------------------------
// Helpers

/** Check whether a scriptPubKey output pays to a given address. */
function voutPaysTo(scriptPubKey: VerboseTxScriptPubKey, address: string): boolean {
  if (scriptPubKey.address === address) return true;
  if (scriptPubKey.addresses && scriptPubKey.addresses.includes(address)) return true;
  return false;
}

/** Find the first non-our address in a tx's outputs (best-effort counterparty). */
function firstExternalAddress(tx: VerboseTx, ourAddress: string): string {
  for (const vout of tx.vout) {
    const spk = vout.scriptPubKey;
    const addr = spk.address ?? spk.addresses?.[0];
    if (addr && addr !== ourAddress) return addr;
  }
  return '';
}

/** Sort history items: mempool (height<=0) first, then confirmed newest-first. */
function sortHistoryMempoolFirst<T extends { height: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aMempool = a.height <= 0;
    const bMempool = b.height <= 0;
    if (aMempool && !bMempool) return -1;
    if (!aMempool && bMempool) return 1;
    return b.height - a.height;
  });
}

// ---------------------------------------------------------------------------
// Provider

export interface ElectrumProviderOptions {
  networkId?: NetworkId;
  /** The wallet's chain params. Drives the native ticker/name (net.ticker) and
   *  whether Evrmore-only assets like SATORI are reported. Defaults to Evrmore
   *  mainnet, so existing callers behave byte-identically. */
  network?: EvrmoreNetwork;
  prices?: Partial<Record<AssetId, { priceUsd: number; change24hPct: number }>>;
}

export class ElectrumWalletDataProvider implements WalletDataProvider {
  private readonly client: ElectrumClient;
  private readonly networkId: NetworkId;
  /** Active chain params. Mutable via setNetwork() so a single shared provider
   *  follows the active wallet's chain (the live service retargets it on switch). */
  private net: EvrmoreNetwork;
  private readonly prices: Partial<Record<AssetId, { priceUsd: number; change24hPct: number }>>;

  /** Native coin name for the ACTIVE chain ('EVR' / 'RVN'). */
  private get nativeName(): string {
    return this.net.ticker;
  }

  /** True on an Evrmore chain, false on every other chain. Gates Evrmore-only
   *  behavior (the built-in SATORI row/queries, the SATORI tx special-case). */
  private get isEvrmore(): boolean {
    return this.net.ticker === 'EVR';
  }

  /** True when the ACTIVE chain implements the Ravencoin-style asset protocol,
   *  i.e. its ElectrumX understands the asset dialect. The single gate for every
   *  asset-dialect request: on a plain chain the extra asset argument is what
   *  makes a server error, and blockchain.asset.* does not exist at all. */
  private get hasAssets(): boolean {
    return supportsAssets(this.net);
  }

  /** Whether an already-normalized asset NAME denotes the native coin. '' means
   *  native for historical callers; 'EVR'/'RVN' stay accepted on every chain so
   *  existing behavior is byte-identical, and the ACTIVE chain's own ticker is
   *  accepted too — otherwise a plain chain's native name (e.g. 'BTGS') would be
   *  mistaken for an asset and send the asset argument. */
  private isNativeName(normalized: string): boolean {
    return (
      normalized === '' ||
      normalized === 'EVR' ||
      normalized === 'RVN' ||
      normalized === this.nativeName.toUpperCase()
    );
  }

  /** Retarget the active chain (Evrmore vs Ravencoin) for a shared provider. */
  setNetwork(net: EvrmoreNetwork): void {
    this.net = net;
  }

  // Cache the server version string from the handshake (if available).
  private cachedServerVersion = 'ElectrumX Evrmore';

  // In-memory cache of asset metadata (name -> parsed meta) so decimals lookups
  // during getAllAssetBalances don't refetch get_meta for the same asset.
  private readonly metaCache = new Map<string, LiveAssetMeta>();

  // Bounded in-memory memo of verbose txs (txid -> VerboseTx). Prevout lookups
  // during classification are the dominant cost of a big first sync, and in a
  // pool-reward wallet each tx's prevout is usually the PREVIOUS wallet tx we
  // just fetched — so memoizing verbose txs roughly halves round-trips. Prevout
  // outputs are immutable, so a cached verbose tx is always safe to reuse for
  // them (the only volatile field, `time`, is unused by prevout tallying).
  // Simple LRU-ish: re-inserting refreshes recency; the oldest insertion is
  // evicted once the cap is exceeded. Bounded so it can't grow without limit.
  private readonly verboseTxCache = new Map<string, VerboseTx>();
  private static readonly VERBOSE_TX_CACHE_CAP = 500;

  constructor(client: ElectrumClient, opts?: ElectrumProviderOptions) {
    this.client = client;
    this.networkId = opts?.networkId ?? 'mainnet';
    this.net = opts?.network ?? EVRMORE_MAINNET;
    this.prices = opts?.prices ?? {};
  }

  // -------------------------------------------------------------------------
  // getAssets

  async getAssets(): Promise<Asset[]> {
    const evrPrice = this.prices['EVR'] ?? { priceUsd: 0, change24hPct: 0 };

    const native: Asset = {
      // Native id/symbol/name follow the active chain (net.ticker). The domain
      // AssetId union predates multichain, so a non-'EVR' native id is cast.
      id: this.nativeName as AssetId,
      symbol: this.nativeName,
      name: this.net.displayName,
      kind: 'native',
      decimals: 8,
      priceUsd: evrPrice.priceUsd,
      change24hPct: evrPrice.change24hPct,
      // Only promise asset transfers on a chain that HAS an asset protocol.
      description: this.hasAssets
        ? `Native coin of the ${this.net.displayName} chain. Pays transaction fees for every transfer, including assets.`
        : `Native coin of the ${this.net.displayName} chain. Pays transaction fees for every transfer.`,
    };

    // Only Evrmore carries the built-in SATORI row; every other chain (asset or
    // plain) returns ONLY the native coin.
    if (!this.isEvrmore) return [native];

    const satPrice = this.prices['SATORI'] ?? { priceUsd: 0, change24hPct: 0 };
    return [
      {
        ...native,
        id: 'EVR',
        symbol: 'EVR',
        name: 'EVRmore',
        description:
          'Native coin of the EVRmore chain. Pays transaction fees for every transfer, including EVRmore assets.',
      },
      {
        id: 'SATORI',
        symbol: 'SATORI',
        name: 'SATORI',
        kind: 'evr-asset',
        decimals: SATORI_ASSET.decimals,
        priceUsd: satPrice.priceUsd,
        change24hPct: satPrice.change24hPct,
        description:
          'Native EVRmore Asset. Transfers are paid with EVR fees.',
      },
    ];
  }

  // -------------------------------------------------------------------------
  // getNetworkStatus

  async getNetworkStatus(): Promise<NetworkStatus> {
    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }

      const before = Date.now();
      const headerResult = await this.client.request<{ height: number; hex?: string }>(
        ELECTRUM_METHODS.headersSubscribe,
      );
      const latencyMs = Date.now() - before;

      const height = headerResult?.height ?? 0;
      // The subscribed header already carries the tip's block time, so this
      // costs no extra round trip.
      const tipTime = parseHeaderTime(headerResult?.hex);

      // Try to retrieve a server version string; tolerate failure.
      try {
        const features = await this.client.request<{ server_version?: string }>(
          ELECTRUM_METHODS.features,
        );
        if (features?.server_version) {
          this.cachedServerVersion = features.server_version;
        }
      } catch {
        // ignore — use cached value
      }

      return {
        networkId: this.networkId,
        state: 'connected',
        latencyMs,
        blockHeight: height,
        serverVersion: this.cachedServerVersion,
        updatedAt: Date.now(),
        tipTime,
      };
    } catch {
      return {
        networkId: this.networkId,
        state: 'offline',
        latencyMs: 0,
        blockHeight: 0,
        serverVersion: 'n/a',
        updatedAt: Date.now(),
        tipTime: null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // getBalances

  async getBalances(address: string): Promise<AssetBalance[]> {
    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }

      const sh = addressToElectrumScripthash(address);

      // Every non-Evrmore chain: native only. Never query 'SATORI' (an
      // Evrmore-only asset), and note the single-argument get_balance below is
      // also the ONLY form a plain (non-asset) server accepts.
      if (!this.isEvrmore) {
        const bal = await this.client.request<ElectrumBalance>(ELECTRUM_METHODS.getBalance, [sh]);
        const amount = ((bal.confirmed ?? 0) + (bal.unconfirmed ?? 0)) / 1e8;
        return [{ assetId: this.nativeName as AssetId, amount }];
      }

      const [evrBalance, satoriBalance] = await Promise.all([
        this.client.request<ElectrumBalance>(ELECTRUM_METHODS.getBalance, [sh]),
        this.client.request<ElectrumBalance>(ELECTRUM_METHODS.getBalance, [sh, 'SATORI']),
      ]);

      const evrAmount = ((evrBalance.confirmed ?? 0) + (evrBalance.unconfirmed ?? 0)) / 1e8;
      const satoriAmount =
        ((satoriBalance.confirmed ?? 0) + (satoriBalance.unconfirmed ?? 0)) / 1e8;

      return [
        { assetId: 'EVR', amount: evrAmount },
        { assetId: 'SATORI', amount: satoriAmount },
      ];
    } catch {
      // Re-throw network errors as NetworkOfflineError so the store can handle them.
      throw new NetworkOfflineError();
    }
  }

  // -------------------------------------------------------------------------
  // getAllAssetBalances — dynamic (MetaMask-style) detection of EVERY asset
  // actually held at an address, derived from listunspent(sh, true).

  async getAllAssetBalances(address: string): Promise<LiveAssetBalance[]> {
    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }

      const sh = addressToElectrumScripthash(address);
      // `true` = "include asset UTXOs" and exists ONLY in the asset dialect. A
      // plain server must get the single-argument form.
      const utxos = await this.client.request<ElectrumUtxo[]>(
        ELECTRUM_METHODS.listUnspent,
        this.hasAssets ? [sh, true] : [sh],
      );

      // Group UTXO sats by asset: native coin (asset null) vs each asset name.
      // On a chain with no asset protocol every UTXO is native by definition, so
      // an `asset` field can only be noise — never let it synthesize an entry.
      let evrSats = 0;
      const satsByAsset = new Map<string, number>();
      for (const u of utxos ?? []) {
        const val = typeof u?.value === 'number' ? u.value : 0;
        if (!this.hasAssets || isNativeAssetField(u?.asset)) {
          evrSats += val;
        } else {
          const name = normalizeAssetName(String(u.asset));
          satsByAsset.set(name, (satsByAsset.get(name) ?? 0) + val);
        }
      }

      // The native coin is always present (even at 0) and listed first. Its NAME
      // follows the active chain (net.ticker), and on a chain without assets it
      // is the ONLY row we can ever report.
      const results: LiveAssetBalance[] = [
        {
          name: this.nativeName,
          amount: evrSats / ASSET_BASE_UNIT,
          decimals: NATIVE_DECIMALS,
          isNative: true,
        },
      ];

      // Resolve decimals for each held asset via get_meta (cached), then scale.
      for (const name of Array.from(satsByAsset.keys()).sort()) {
        const meta = await this.getAssetMeta(name);
        const decimals = meta?.exists ? meta.decimals : NATIVE_DECIMALS;
        const sats = satsByAsset.get(name) ?? 0;
        results.push({
          name,
          amount: sats / ASSET_BASE_UNIT,
          decimals,
          isNative: false,
        });
      }

      return results;
    } catch (err) {
      if (err instanceof NetworkOfflineError) throw err;
      throw new NetworkOfflineError();
    }
  }

  // -------------------------------------------------------------------------
  // getAssetMeta — validate an arbitrary asset name against the live chain.

  async getAssetMeta(name: string): Promise<LiveAssetMeta | null> {
    const normalized = normalizeAssetName(name);
    if (!normalized) return null;

    // blockchain.asset.get_meta does not exist on a chain without an asset
    // protocol (a plain server answers with an ERROR, not `{}`), so no asset can
    // exist there: answer "unknown" locally instead of burning a failing call.
    if (!this.hasAssets) return null;

    const cached = this.metaCache.get(normalized);
    if (cached !== undefined) return cached;

    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }
      const raw = await this.client.request<ElectrumAssetMeta>(ELECTRUM_METHODS.assetGetMeta, [
        normalized,
      ]);
      const result = parseAssetMeta(raw);
      this.metaCache.set(normalized, result);
      return result;
    } catch (err) {
      if (err instanceof NetworkOfflineError) throw err;
      throw new NetworkOfflineError();
    }
  }

  // -------------------------------------------------------------------------
  // getAssetBalance — single-asset balance in whole units.

  async getAssetBalance(address: string, name: string): Promise<number> {
    const normalized = normalizeAssetName(name);
    const isNative = this.isNativeName(normalized);

    // A chain with no asset protocol holds nothing but its native coin, so any
    // other name is definitionally a zero balance — and asking for it would send
    // the asset argument that a plain server rejects. Answer without any call.
    if (!this.hasAssets && !isNative) return 0;

    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }
      const sh = addressToElectrumScripthash(address);

      // The native coin uses no asset arg (the only form a plain server knows);
      // assets pass the name. Either way the raw balance is in 1e8 base units
      // (divisions is display-only), so both divide by ASSET_BASE_UNIT.
      const params = isNative ? [sh] : [sh, normalized];
      const bal = await this.client.request<ElectrumBalance>(ELECTRUM_METHODS.getBalance, params);
      return ((bal.confirmed ?? 0) + (bal.unconfirmed ?? 0)) / ASSET_BASE_UNIT;
    } catch (err) {
      if (err instanceof NetworkOfflineError) throw err;
      throw new NetworkOfflineError();
    }
  }

  // -------------------------------------------------------------------------
  // getTransactions

  async getTransactions(address: string): Promise<Transaction[]> {
    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }

      const sh = addressToElectrumScripthash(address);
      const history = await this.client.request<ElectrumHistoryItem[]>(
        ELECTRUM_METHODS.getHistory,
        [sh],
      );

      // Sort: mempool (height<=0) first, then confirmed newest-first.
      const sorted = sortHistoryMempoolFirst(history);

      // Cap at 25 most recent to bound network calls.
      const capped = sorted.slice(0, 25);

      const results: Transaction[] = [];

      for (const item of capped) {
        try {
          const tx = await this.client.request<VerboseTx>(ELECTRUM_METHODS.txGet, [
            item.tx_hash,
            true,
          ]);

          const txResult = await this.classifyTx(tx, address, item.height);
          if (txResult) {
            results.push(txResult);
          }
        } catch {
          // One bad tx must not break the whole list.
        }
      }

      return results;
    } catch (err) {
      if (err instanceof NetworkOfflineError) throw err;
      throw new NetworkOfflineError();
    }
  }

  // -------------------------------------------------------------------------
  // getLiveTransactions — dynamic-asset classification (any on-chain asset).
  //
  // Like getTransactions() but decoupled from the closed domain AssetId union:
  // each tx is reported with its real on-chain asset NAME. Same resilience (one
  // bad tx doesn't break the list) and the same 25-tx cap.

  async getLiveTransactions(address: string): Promise<LiveTransaction[]> {
    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }

      const history = await this.getAddressHistory(address);

      // Sort mempool-first then newest; cap at 25 most recent to bound calls.
      const capped = sortHistoryMempoolFirst(history).slice(0, 25);

      const results: LiveTransaction[] = [];
      for (const item of capped) {
        try {
          const tx = await this.classifyTxHash(address, item.tx_hash, item.height);
          if (tx) results.push(tx);
        } catch {
          // One bad tx must not break the whole list.
        }
      }
      return results;
    } catch (err) {
      if (err instanceof NetworkOfflineError) throw err;
      throw new NetworkOfflineError();
    }
  }

  // -------------------------------------------------------------------------
  // getAddressHistory — light history (tx_hash + height only), no classifying.
  // This is the cheap fetch the tx cache diffs against.

  async getAddressHistory(address: string): Promise<ElectrumHistoryItem[]> {
    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }
      const sh = addressToElectrumScripthash(address);
      const history = await this.client.request<ElectrumHistoryItem[]>(
        ELECTRUM_METHODS.getHistory,
        [sh],
      );
      return history ?? [];
    } catch (err) {
      if (err instanceof NetworkOfflineError) throw err;
      // A JSON-RPC ERROR REPLY is the server ANSWERING: it is reachable and has
      // declined this address (typically "history too large"). Reporting that as
      // "offline" is what made a permanently unreadable address look identical
      // to a network blip, so it gets its own error — see the class comment.
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith(ELECTRUM_ERROR_PREFIX)) {
        const serverMessage = message.slice(ELECTRUM_ERROR_PREFIX.length).trim();
        throw new AddressHistoryRefusedError(serverMessage, HISTORY_TOO_LARGE_RE.test(serverMessage));
      }
      throw new NetworkOfflineError();
    }
  }

  // -------------------------------------------------------------------------
  // classifyTxHash — fetch ONE verbose tx by hash and classify it (dynamic
  // asset). This is the per-tx hook the transaction cache calls for each new /
  // changed tx_hash, so the cache never needs the ElectrumClient directly.

  async classifyTxHash(
    address: string,
    txHash: string,
    height: number,
  ): Promise<LiveTransaction | null> {
    if (!this.client.isConnected()) {
      await this.client.connect();
    }
    let tx: VerboseTx;
    if (height > 0) {
      // Confirmed tx: immutable, so the memo is safe (and usually a hit on a
      // later tx's prevout lookup). Fetch-through the memo.
      tx = await this.fetchVerboseTx(txHash);
    } else {
      // Mempool tx (height<=0): its confirmation can still change, so always
      // fetch fresh and OVERWRITE any stale memo entry.
      tx = await this.client.request<VerboseTx>(ELECTRUM_METHODS.txGet, [txHash, true]);
      this.cacheVerboseTx(tx);
    }
    return this.classifyLive(tx, address, height);
  }

  // -------------------------------------------------------------------------
  // Private: bounded verbose-tx memo (see verboseTxCache above).

  /** Fetch a verbose tx through the memo: a hit returns the cached copy, a miss
   *  fetches once and caches it. Only use for immutable reads (prevouts, and
   *  confirmed main txs) — never for a mempool main tx (see classifyTxHash). */
  private async fetchVerboseTx(txid: string): Promise<VerboseTx> {
    const cached = this.verboseTxCache.get(txid);
    if (cached) return cached;
    const tx = await this.client.request<VerboseTx>(ELECTRUM_METHODS.txGet, [txid, true]);
    this.cacheVerboseTx(tx);
    return tx;
  }

  /** Insert/refresh a verbose tx in the memo, evicting the oldest entry once the
   *  cap is exceeded. Re-inserting an existing key refreshes its recency. */
  private cacheVerboseTx(tx: VerboseTx): void {
    if (this.verboseTxCache.has(tx.txid)) this.verboseTxCache.delete(tx.txid);
    this.verboseTxCache.set(tx.txid, tx);
    if (this.verboseTxCache.size > ElectrumWalletDataProvider.VERBOSE_TX_CACHE_CAP) {
      const oldest = this.verboseTxCache.keys().next().value;
      if (oldest !== undefined) this.verboseTxCache.delete(oldest);
    }
  }

  // -------------------------------------------------------------------------
  // simulateTransaction / submitTransaction — not supported in live mode

  async simulateTransaction(_request: TransactionRequest): Promise<TransactionSimulation> {
    throw new Error('Live sends go through LiveWalletService, not the data provider');
  }

  async submitTransaction(_request: TransactionRequest): Promise<TransactionSimulation> {
    throw new Error('Live sends go through LiveWalletService, not the data provider');
  }

  // -------------------------------------------------------------------------
  // Private: classify one verbose tx relative to our address

  private async classifyTx(
    tx: VerboseTx,
    address: string,
    height: number,
  ): Promise<Transaction | null> {
    // Tally what we RECEIVE (outputs to our address).
    let receivedEvr = 0;
    let receivedSatori = 0;

    for (const vout of tx.vout) {
      if (!voutPaysTo(vout.scriptPubKey, address)) continue;
      if (this.isEvrmore && vout.scriptPubKey.asset && vout.scriptPubKey.asset.name === SATORI_ASSET.name) {
        // Asset output: amount is already in the asset's decimal units (per Evrmore verbose tx).
        receivedSatori += vout.scriptPubKey.asset.amount;
      } else {
        // EVR output: value is in coins (decimal EVR).
        receivedEvr += vout.value;
      }
    }

    // Tally what we SPEND (inputs whose prevout pays to our address).
    let spentEvr = 0;
    let spentSatori = 0;
    // Also total all EVR output values to compute fee when we are the sender.
    let totalEvrOut = 0;

    for (const vout of tx.vout) {
      if (!vout.scriptPubKey.asset) {
        totalEvrOut += vout.value;
      }
    }

    for (const vin of tx.vin) {
      if (!vin.txid || vin.vout === undefined) continue; // coinbase
      try {
        // Prevout outputs are immutable — always read through the memo.
        const prevTx = await this.fetchVerboseTx(vin.txid);
        const prevVout = prevTx.vout[vin.vout];
        if (!prevVout) continue;
        if (!voutPaysTo(prevVout.scriptPubKey, address)) continue;

        if (
          this.isEvrmore &&
          prevVout.scriptPubKey.asset &&
          prevVout.scriptPubKey.asset.name === SATORI_ASSET.name
        ) {
          spentSatori += prevVout.scriptPubKey.asset.amount;
        } else {
          spentEvr += prevVout.value;
        }
      } catch {
        // Tolerate a missing prevout lookup.
      }
    }

    const netEvr = receivedEvr - spentEvr;
    const netSatori = receivedSatori - spentSatori;

    // Determine dominant asset and direction.
    let assetId: AssetId;
    let amount: number;
    let direction: 'in' | 'out';

    if (Math.abs(netSatori) > 0) {
      // SATORI moved — this is the primary asset.
      assetId = 'SATORI';
      amount = Math.abs(netSatori);
      direction = netSatori >= 0 ? 'in' : 'out';
    } else if (Math.abs(netEvr) > 1e-9) {
      // Native coin of the active chain (EVR / RVN). The domain AssetId union
      // predates multichain, so a non-'EVR' native id is cast.
      assetId = this.nativeName as AssetId;
      amount = Math.abs(netEvr);
      direction = netEvr >= 0 ? 'in' : 'out';
    } else {
      // Nothing meaningful moved relative to our address — skip.
      return null;
    }

    // Fee: only computable when we are the sender (we had inputs).
    let feeEvr = 0;
    if (spentEvr > 0) {
      feeEvr = Math.max(0, spentEvr - totalEvrOut);
    }

    const status = height > 0 ? 'confirmed' : 'pending';
    const blockHeight = height > 0 ? height : undefined;
    const timestamp = tx.time ? tx.time * 1000 : Date.now();
    const counterparty = firstExternalAddress(tx, address);

    return {
      id: tx.txid,
      txid: tx.txid,
      assetId,
      direction,
      amount,
      feeEvr,
      address: counterparty,
      status,
      blockHeight,
      timestamp,
    };
  }

  // -------------------------------------------------------------------------
  // Private: classify one verbose tx relative to our address for ANY asset.
  //
  // Generalizes classifyTx (which only knew SATORI): it tallies net movement
  // per asset (received outputs minus spent prevouts) for EVERY asset name seen
  // in the tx, then reports the DOMINANT moved asset — a non-EVR asset with the
  // largest |net| when one moved, else EVR. Fee is EVR inputs − total EVR outs
  // when we are a sender. Asset amounts are already in WHOLE units (verified
  // live — see LiveTransaction); EVR `value` is decimal EVR.

  private async classifyLive(
    tx: VerboseTx,
    address: string,
    height: number,
  ): Promise<LiveTransaction | null> {
    // What we RECEIVE (outputs paying to our address), split by asset.
    let receivedEvr = 0;
    const receivedByAsset = new Map<string, number>();
    // Total EVR out across ALL outputs (for fee when we are the sender).
    let totalEvrOut = 0;

    for (const vout of tx.vout) {
      // A chain with no asset protocol has no asset outputs, so any `asset`
      // field is noise — ignoring it keeps every tx classified as native.
      const asset = this.hasAssets ? vout.scriptPubKey.asset : undefined;
      if (!asset) totalEvrOut += vout.value;
      if (!voutPaysTo(vout.scriptPubKey, address)) continue;
      if (asset) {
        receivedByAsset.set(asset.name, (receivedByAsset.get(asset.name) ?? 0) + asset.amount);
      } else {
        receivedEvr += vout.value;
      }
    }

    // What we SPEND (inputs whose prevout paid to our address), split by asset.
    let spentEvr = 0;
    const spentByAsset = new Map<string, number>();

    for (const vin of tx.vin) {
      if (!vin.txid || vin.vout === undefined) continue; // coinbase
      try {
        // Prevout outputs are immutable — always read through the memo.
        const prevTx = await this.fetchVerboseTx(vin.txid);
        const prevVout = prevTx.vout[vin.vout];
        if (!prevVout) continue;
        if (!voutPaysTo(prevVout.scriptPubKey, address)) continue;
        const asset = this.hasAssets ? prevVout.scriptPubKey.asset : undefined;
        if (asset) {
          spentByAsset.set(asset.name, (spentByAsset.get(asset.name) ?? 0) + asset.amount);
        } else {
          spentEvr += prevVout.value;
        }
      } catch {
        // Tolerate a missing prevout lookup.
      }
    }

    // Net per non-EVR asset; keep the one with the largest absolute movement.
    const EPS = 1e-9;
    let dominantAsset = '';
    let dominantNet = 0;
    const names = new Set<string>([...receivedByAsset.keys(), ...spentByAsset.keys()]);
    for (const name of names) {
      const net = (receivedByAsset.get(name) ?? 0) - (spentByAsset.get(name) ?? 0);
      if (Math.abs(net) > EPS && Math.abs(net) > Math.abs(dominantNet)) {
        dominantAsset = name;
        dominantNet = net;
      }
    }

    const netEvr = receivedEvr - spentEvr;

    let asset: string;
    let amount: number;
    let direction: 'in' | 'out';
    if (dominantAsset && Math.abs(dominantNet) > EPS) {
      // A non-EVR asset moved — it is the primary asset of this tx.
      asset = dominantAsset;
      amount = Math.abs(dominantNet);
      direction = dominantNet >= 0 ? 'in' : 'out';
    } else if (Math.abs(netEvr) > EPS) {
      asset = this.nativeName;
      amount = Math.abs(netEvr);
      direction = netEvr >= 0 ? 'in' : 'out';
    } else {
      // Nothing meaningful moved relative to our address — skip.
      return null;
    }

    // Fee: only computable when we are the sender (we had EVR inputs).
    let feeEvr = 0;
    if (spentEvr > 0) {
      feeEvr = Math.max(0, spentEvr - totalEvrOut);
    }

    const status = height > 0 ? 'confirmed' : 'pending';
    const blockHeight = height > 0 ? height : undefined;
    const timestamp = tx.time ? tx.time * 1000 : Date.now();
    const counterparty = firstExternalAddress(tx, address);

    return {
      txid: tx.txid,
      asset,
      direction,
      amount,
      feeEvr,
      spentNative: spentEvr,
      totalOutNative: totalEvrOut,
      status,
      blockHeight,
      timestamp,
      counterparty,
    };
  }
}
