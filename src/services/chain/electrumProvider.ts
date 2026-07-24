// Live (real-chain) watch-only data provider for the Evrmore wallet.
// Implements WalletDataProvider by reading the live Evrmore chain over Electrum.
// CSP-safe, no Node APIs — only the ElectrumClient transport abstraction.

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
import { EVRMORE_MAINNET, type EvrmoreNetwork } from './chainParams';

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
  /** EVR fee when we are the sender, else 0. */
  feeEvr: number;
  status: 'confirmed' | 'pending';
  blockHeight?: number;
  timestamp: number;
  counterparty: string;
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

  /** True on an Evrmore chain, false on Ravencoin. Gates Evrmore-only behavior
   *  (the built-in SATORI row/queries, the SATORI tx special-case). */
  private get isEvrmore(): boolean {
    return this.net.ticker === 'EVR';
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
      // Native id/symbol/name follow the active chain (EVR / RVN). The domain
      // AssetId union predates multichain, so a non-'EVR' native id is cast.
      id: this.nativeName as AssetId,
      symbol: this.nativeName,
      name: this.net.displayName,
      kind: 'native',
      decimals: 8,
      priceUsd: evrPrice.priceUsd,
      change24hPct: evrPrice.change24hPct,
      description: `Native coin of the ${this.net.displayName} chain. Pays transaction fees for every transfer, including assets.`,
    };

    // Ravencoin has no SATORI row: return ONLY the native coin.
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
      const headerResult = await this.client.request<{ height: number }>(
        ELECTRUM_METHODS.headersSubscribe,
      );
      const latencyMs = Date.now() - before;

      const height = headerResult?.height ?? 0;

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
      };
    } catch {
      return {
        networkId: this.networkId,
        state: 'offline',
        latencyMs: 0,
        blockHeight: 0,
        serverVersion: 'n/a',
        updatedAt: Date.now(),
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

      // Ravencoin: native only. Never query 'SATORI' (an Evrmore-only asset).
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
      const utxos = await this.client.request<ElectrumUtxo[]>(ELECTRUM_METHODS.listUnspent, [
        sh,
        true,
      ]);

      // Group UTXO sats by asset: native EVR (asset null) vs each asset name.
      let evrSats = 0;
      const satsByAsset = new Map<string, number>();
      for (const u of utxos ?? []) {
        const val = typeof u?.value === 'number' ? u.value : 0;
        if (isNativeAssetField(u?.asset)) {
          evrSats += val;
        } else {
          const name = normalizeAssetName(String(u.asset));
          satsByAsset.set(name, (satsByAsset.get(name) ?? 0) + val);
        }
      }

      // The native coin is always present (even at 0) and listed first. Its NAME
      // follows the active chain (EVR / RVN).
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

    try {
      if (!this.client.isConnected()) {
        await this.client.connect();
      }
      const sh = addressToElectrumScripthash(address);

      // Native EVR uses no asset arg; assets pass the name. Either way the raw
      // balance is in 1e8 base units (divisions is display-only), so both divide
      // by ASSET_BASE_UNIT.
      const isNative = normalized === '' || normalized === 'EVR' || normalized === 'RVN';
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
      const asset = vout.scriptPubKey.asset;
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
        const asset = prevVout.scriptPubKey.asset;
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
      status,
      blockHeight,
      timestamp,
      counterparty,
    };
  }
}
