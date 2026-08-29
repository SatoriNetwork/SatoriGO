// Read-only WalletDataProvider for the EVM family (phase 2 of the EVM
// rollout, the EVM rollout plan, section 3, "read only"; architecture in
// the EVM engine design notes, section 3, "engine seam").
//
// This is the counterpart to ElectrumWalletDataProvider (electrumProvider.ts):
// same shape (WalletDataProvider plus the dynamic-asset trio
// getAllAssetBalances / getAssetMeta / getAssetBalance the store consumes),
// built on top of EvmRpcClient (rpc.ts) and the ERC-20 codec (erc20.ts)
// instead of an Electrum transport.
//
// Nothing here sends, signs or estimates a fee. simulateTransaction and
// submitTransaction exist only to satisfy WalletDataProvider and reject: the
// send path is phase 3.
//
// Two failure kinds carry over unchanged from rpc.ts:
//   - EvmRpcUnavailableError (no endpoint answered) always becomes
//     NetworkOfflineError here, so the store's existing offline handling
//     (built for Electrum) works unchanged for EVM.
//   - EvmRpcError (a definitive node answer, e.g. a revert) is a real answer
//     about ONE call. Depending on which call it hit, that is either "this
//     token/contract does not behave like an ERC-20" (skip it, or report
//     exists:false) or, for the single native-balance read, an offline
//     signal, matching the Electrum provider's own contract.

import type { WalletDataProvider } from '../../provider';
import { NetworkOfflineError } from '../../provider';
import type {
  Asset,
  AssetBalance,
  AssetId,
  NetworkStatus,
  Transaction,
  TransactionRequest,
  TransactionSimulation,
} from '../../../types/domain';
import type { LiveAssetBalance, LiveAssetMeta } from '../electrumProvider';
import {
  EvmRpcUnavailableError,
  fromQuantity,
  createEvmRpcClient,
  type EvmRpcCall,
  type EvmRpcBatchResult,
  type EvmRpcClient,
  type EvmRpcOptions,
} from './rpc';
import { encodeBalanceOf, encodeDecimals, encodeSymbol, decodeUint256, decodeUint8, decodeString } from './erc20';
import type { EvmChain, EvmTokenRef } from './chains';
import { isEvmAddress, normalizeEvmAddress } from './keys';

export interface EvmProviderOptions {
  /** ERC-20 contracts tracked on refresh, in display order. Default:
   *  chain.defaultTokens, or an empty list when the chain has none. */
  tokens?: readonly EvmTokenRef[];
  /** Clock for NetworkStatus.updatedAt. Default Date.now. */
  now?: () => number;
  /** How token balances and metadata are read. 'eth_call' (default): one
   *  balanceOf per token plus decimals/symbol once. 'alchemy': ONE
   *  alchemy_getTokenBalances call for every tracked contract and
   *  alchemy_getTokenMetadata for unknown ones; the metered cost of one call
   *  instead of one per token. Falls back to eth_call when the endpoint
   *  does not know the method (a failover to a public node). */
  tokenBalances?: 'eth_call' | 'alchemy';
}

/** One combined read of everything the store needs per refresh tick. */
export interface EvmSnapshot {
  network: NetworkStatus;
  /** Null when the balance read failed (the native balance refused) while the
   *  chain itself answered: the store keeps its previous rows. */
  assets: LiveAssetBalance[] | null;
  /**
   * FALSE when a tracked token was asked about and did not answer (its
   * balanceOf refused, its data would not decode, or no scale for it could be
   * resolved). Such a token is left OUT of `assets` rather than shown as 0,
   * which is right on its own but makes the short list indistinguishable from
   * "that token is gone". This flag is the difference, and the store's merge
   * rule keys off it: a partial read may never blank a row the wallet already
   * knew (see src/store/balanceCache.ts).
   */
  complete: boolean;
}

/** The chain tip's timestamp is re-read at most this often: it only feeds the
 *  "chain has stalled" indicator, and a fresh block number every tick already
 *  proves the chain moves. */
const TIP_TIME_MAX_AGE_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A hex value that may be a 32-byte data word with leading zeros (what
 *  alchemy_getTokenBalances returns) or a plain quantity. */
function parseDataWord(value: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error('not a hex value');
  return BigInt(value);
}

interface BalancePlan {
  mode: 'eth_call' | 'alchemy';
  tokens: readonly EvmTokenRef[];
  calls: EvmRpcCall[];
  balanceCallIndex: number[];
  alchemyIndex: number | null;
  metaCallIndex: Array<{ decimals: number; symbol: number } | { alchemy: number } | null>;
}

/** '0x8335…2913'-style short label for a token whose name we have no better
 *  answer for: the chain's symbol() call failed and the caller gave no hint. */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** amountBase / 10**decimals as a Number, composed through a decimal STRING
 *  rather than floating-point division, so the result is exact up to the
 *  point where Number itself runs out of precision (1.5 stays 1.5, 12345678
 *  base units at 6 decimals stays 12.345678). DISPLAY-ONLY, exactly like
 *  ElectrumWalletDataProvider's own whole-unit methods: never feed this into
 *  a transaction amount. */
function toWholeUnits(amountBase: bigint, decimals: number): number {
  if (decimals <= 0) return Number(amountBase);
  const divisor = 10n ** BigInt(decimals);
  const whole = amountBase / divisor;
  const remainder = amountBase % divisor;
  const fraction = remainder.toString().padStart(decimals, '0');
  return Number(`${whole.toString()}.${fraction}`);
}

/** decimals() resolution for one tracked token: the chain's own answer when
 *  that call succeeded and decodes, else the EvmTokenRef hint, else 0. The
 *  hint is used ONLY when the chain's call failed, so a chain answer that
 *  disagrees with the hint always wins. */
function resolveTokenDecimals(
  result: EvmRpcBatchResult | undefined,
  hint: number | undefined,
): number | null {
  if (result?.ok) {
    try {
      return decodeUint8(result.result as string);
    } catch {
      // fall through to the hint
    }
  }
  // No chain answer and no hint: there is NO safe scale to show this balance
  // at. Guessing 0 would render 1e18 base units as a trillion tokens; the
  // caller skips the token this refresh instead (and caches nothing, so a
  // transient failure is retried next time).
  return hint ?? null;
}

/** symbol() resolution for one tracked token: the chain's own answer, else
 *  the EvmTokenRef hint, else a short form of the contract address. */
function resolveTokenSymbol(
  result: EvmRpcBatchResult | undefined,
  hint: string | undefined,
  address: string,
): string {
  if (result?.ok) {
    try {
      return decodeString(result.result as string);
    } catch {
      // fall through to the hint / short address
    }
  }
  return hint ?? shortAddress(address);
}

/** Block tip time out of an eth_getBlockByNumber batch entry, or null when
 *  the call failed, the block is null (no such block yet), or `timestamp` is
 *  missing or not a well-formed JSON-RPC quantity. Never throws. */
function readTipTime(blockResult: EvmRpcBatchResult): number | null {
  if (!blockResult.ok) return null;
  const block = blockResult.result;
  if (!block || typeof block !== 'object') return null;
  const timestamp = (block as Record<string, unknown>).timestamp;
  try {
    return Number(fromQuantity(timestamp)) * 1000;
  } catch {
    return null;
  }
}

/** Cached per-token display metadata: the chain's (or fallback) decimals and
 *  symbol, resolved once and reused for the life of the provider. */
interface TokenMeta {
  decimals: number;
  symbol: string;
}

export class EvmWalletDataProvider implements WalletDataProvider {
  readonly chain: EvmChain;

  private tokens: readonly EvmTokenRef[] = [];
  private readonly now: () => number;

  /** Populated by getAllAssetBalances / getBalances. Keyed by lowercase
   *  contract address. Never written to for a token whose balanceOf reverted
   *  or produced undecodable data (see getAllAssetBalances). Never cleared by
   *  setTokens. */
  private readonly tokenMetaCache = new Map<string, TokenMeta>();

  /** Populated by getAssetMeta. Separate from tokenMetaCache on purpose: this
   *  one's failure semantics differ (ANY revert or decode failure here means
   *  exists:false, with no EvmTokenRef hint to fall back on). */
  private readonly assetMetaCache = new Map<string, LiveAssetMeta>();

  /** The RPC client this provider reads through. Exposed (read-only) so the
   *  send path (phase 3) quotes fees, reserves nonces and broadcasts through
   *  the SAME client: one sticky endpoint per chain, so a fee quoted from one
   *  node is not sent to another, and the nonce the tracker read is the nonce
   *  the broadcasting node knows about. */
  readonly rpc: EvmRpcClient;

  private readonly tokenBalancesMode: 'eth_call' | 'alchemy';
  /** Last tip time read, and when (see TIP_TIME_MAX_AGE_MS). */
  private tipTimeCache: { tipTime: number | null; at: number } | null = null;

  constructor(rpc: EvmRpcClient, opts: EvmProviderOptions = {}) {
    this.rpc = rpc;
    this.chain = rpc.chain;
    this.now = opts.now ?? Date.now;
    this.tokenBalancesMode = opts.tokenBalances ?? 'eth_call';
    this.setTokens(opts.tokens ?? rpc.chain.defaultTokens ?? []);
  }

  /**
   * Everything a refresh tick needs in ONE batch: block number (and the tip
   * time only when the cached one is older than a minute), native balance,
   * token balances (one alchemy_getTokenBalances call in 'alchemy' mode, one
   * balanceOf per token otherwise) and metadata for tokens not seen before.
   * Two round trips and a per-token call used to be spent here every 20 s;
   * this is where a metered provider's budget goes, so it is one.
   *
   * Throws NetworkOfflineError when nothing usable came back (transport
   * failure, or the native balance refused); a failed block read alone
   * degrades `network` to offline while the balances still land.
   */
  async getSnapshot(address: string): Promise<EvmSnapshot> {
    if (!isEvmAddress(address)) {
      throw new Error(`evmProvider: not a valid EVM address: ${address}`);
    }
    const needTip = !this.tipTimeCache || this.now() - this.tipTimeCache.at > TIP_TIME_MAX_AGE_MS;
    const head: EvmRpcCall[] = [{ method: 'eth_blockNumber' }];
    if (needTip) head.push({ method: 'eth_getBlockByNumber', params: ['latest', false] });
    const plan = this.planBalanceCalls(address);
    const results = await this.runBatch([...head, ...plan.calls]);
    const headResults = results.slice(0, head.length);
    let balanceResults = results.slice(head.length);

    // Block number / tip time.
    let network: NetworkStatus;
    const blockNumberResult = headResults[0];
    if (blockNumberResult.ok) {
      if (needTip) {
        this.tipTimeCache = { tipTime: readTipTime(headResults[1]), at: this.now() };
      }
      network = {
        networkId: 'mainnet',
        state: 'connected',
        latencyMs: this.rpc.lastLatencyMs() ?? 0,
        blockHeight: Number(fromQuantity(blockNumberResult.result)),
        serverVersion: this.rpc.activeEndpoint() ?? '',
        updatedAt: this.now(),
        tipTime: this.tipTimeCache?.tipTime ?? null,
      };
    } else {
      network = { networkId: 'mainnet', state: 'offline', latencyMs: 0, blockHeight: 0, serverVersion: '', updatedAt: this.now(), tipTime: null };
    }

    // The one-call token read is the first thing a non-Alchemy endpoint
    // refuses: fall back to per-token balanceOf for this read.
    let effective = plan;
    if (plan.alchemyIndex !== null && !balanceResults[plan.alchemyIndex].ok) {
      effective = this.planBalanceCalls(address, 'eth_call');
      balanceResults = await this.runBatch(effective.calls);
    }
    try {
      const parsed = this.parseBalances(address, effective, balanceResults);
      return { network, assets: parsed.rows, complete: parsed.complete };
    } catch (err) {
      // The native balance refused while the chain answered: the store keeps
      // what it had and shows offline for the balances, not a crash.
      if (err instanceof NetworkOfflineError) return { network, assets: null, complete: false };
      throw err;
    }
  }

  /** The calls of one balance read, and where each answer lands. */
  private planBalanceCalls(address: string, mode: 'eth_call' | 'alchemy' = this.tokenBalancesMode): BalancePlan {
    const tokens = this.tokens;
    const calls: EvmRpcCall[] = [{ method: 'eth_getBalance', params: [address, 'latest'] }];
    const balanceCallIndex: number[] = [];
    let alchemyIndex: number | null = null;
    if (mode === 'alchemy' && tokens.length > 0) {
      alchemyIndex = calls.length;
      calls.push({ method: 'alchemy_getTokenBalances', params: [address, tokens.map((t) => t.address)] });
    } else {
      for (const token of tokens) {
        balanceCallIndex.push(calls.length);
        calls.push({ method: 'eth_call', params: [{ to: token.address, data: encodeBalanceOf(address) }, 'latest'] });
      }
    }
    // Metadata only for tokens this provider has never resolved before.
    const metaCallIndex: Array<{ decimals: number; symbol: number } | { alchemy: number } | null> = [];
    for (const token of tokens) {
      const key = token.address.toLowerCase();
      if (this.tokenMetaCache.has(key)) {
        metaCallIndex.push(null);
        continue;
      }
      if (mode === 'alchemy') {
        metaCallIndex.push({ alchemy: calls.length });
        calls.push({ method: 'alchemy_getTokenMetadata', params: [token.address] });
      } else {
        const decimalsIdx = calls.length;
        calls.push({ method: 'eth_call', params: [{ to: token.address, data: encodeDecimals() }, 'latest'] });
        const symbolIdx = calls.length;
        calls.push({ method: 'eth_call', params: [{ to: token.address, data: encodeSymbol() }, 'latest'] });
        metaCallIndex.push({ decimals: decimalsIdx, symbol: symbolIdx });
      }
    }
    return { mode, tokens, calls, balanceCallIndex, alchemyIndex, metaCallIndex };
  }

  /** Rows out of a balance read, plus whether every tracked token answered
   *  (see EvmSnapshot.complete). Throws NetworkOfflineError when the native
   *  balance (the one call the read cannot do without) refused. */
  private parseBalances(
    _address: string,
    plan: BalancePlan,
    results: EvmRpcBatchResult[],
  ): { rows: LiveAssetBalance[]; complete: boolean } {
    let complete = true;
    const nativeResult = results[0];
    if (!nativeResult || !nativeResult.ok) throw new NetworkOfflineError();
    const rows: LiveAssetBalance[] = [
      {
        name: this.chain.nativeTicker,
        amountBase: fromQuantity(nativeResult.result),
        scale: this.chain.nativeDecimals,
        decimals: this.chain.nativeDecimals,
        isNative: true,
      },
    ];

    // Token balances: from the single Alchemy answer (by contract) or per call.
    const alchemyBalances = new Map<string, bigint>();
    if (plan.alchemyIndex !== null) {
      const r = results[plan.alchemyIndex];
      if (r && r.ok && isRecord(r.result) && Array.isArray(r.result.tokenBalances)) {
        for (const entry of r.result.tokenBalances) {
          if (!isRecord(entry) || typeof entry.contractAddress !== 'string') continue;
          if (typeof entry.error === 'string' || typeof entry.tokenBalance !== 'string') continue;
          try {
            alchemyBalances.set(entry.contractAddress.toLowerCase(), parseDataWord(entry.tokenBalance));
          } catch {
            // undecodable: treated as not answered, the token is skipped
          }
        }
      }
    }

    for (let i = 0; i < plan.tokens.length; i++) {
      const token = plan.tokens[i];
      let amountBase: bigint | null = null;
      if (plan.alchemyIndex !== null) {
        amountBase = alchemyBalances.get(token.address.toLowerCase()) ?? null;
      } else {
        const balanceResult = results[plan.balanceCallIndex[i]];
        if (balanceResult && balanceResult.ok) {
          try {
            amountBase = decodeUint256(balanceResult.result as string);
          } catch {
            amountBase = null;
          }
        }
      }
      // A reverting / unanswered balance is skipped, not shown as 0 — and the
      // read is no longer complete, so the store keeps this token's last known
      // figure rather than reading the gap as "the token is gone".
      if (amountBase === null) {
        complete = false;
        continue;
      }

      const key = token.address.toLowerCase();
      let meta = this.tokenMetaCache.get(key);
      if (!meta) {
        const idx = plan.metaCallIndex[i];
        let decimals: number | null;
        let symbol: string;
        if (idx && 'alchemy' in idx) {
          const m = results[idx.alchemy];
          const md = m && m.ok && isRecord(m.result) ? m.result : null;
          const d = md && typeof md.decimals === 'number' && Number.isInteger(md.decimals) && md.decimals >= 0 && md.decimals <= 255 ? md.decimals : null;
          decimals = d ?? token.decimals ?? null;
          const sym = md && typeof md.symbol === 'string' && md.symbol.trim() ? md.symbol.trim() : null;
          symbol = sym ?? token.symbol ?? shortAddress(token.address);
        } else {
          const decimalsResult = idx && 'decimals' in idx ? results[idx.decimals] : undefined;
          const symbolResult = idx && 'symbol' in idx ? results[idx.symbol] : undefined;
          decimals = resolveTokenDecimals(decimalsResult, token.decimals);
          symbol = resolveTokenSymbol(symbolResult, token.symbol, token.address);
        }
        if (decimals === null) {
          // unscalable this refresh: skip, cache nothing, and say the read is
          // partial so the previous figure survives.
          complete = false;
          continue;
        }
        meta = { decimals, symbol };
        this.tokenMetaCache.set(key, meta);
      }
      rows.push({ name: meta.symbol, amountBase, scale: meta.decimals, decimals: meta.decimals, isNative: false });
    }
    return { rows, complete };
  }

  // -------------------------------------------------------------------------
  // Tracked tokens

  /** Replace the tracked token list. Deduped by lowercase address (first
   *  occurrence kept, in the order given). Throws on any invalid address
   *  before anything is replaced, so a rejected call leaves the previous list
   *  intact. Does NOT clear tokenMetaCache: a token seen before still gets its
   *  cached decimals/symbol, and a re-added token costs no new calls. */
  setTokens(tokens: readonly EvmTokenRef[]): void {
    const seen = new Set<string>();
    const deduped: EvmTokenRef[] = [];
    for (const token of tokens) {
      if (!isEvmAddress(token.address)) {
        throw new Error(`evmProvider: not a valid EVM address: ${String(token.address)}`);
      }
      const key = token.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(token);
    }
    this.tokens = deduped;
  }

  getTokens(): readonly EvmTokenRef[] {
    return this.tokens;
  }

  // -------------------------------------------------------------------------
  // Internal: one batch, converting a transport failure to NetworkOfflineError.
  // A per-item JSON-RPC refusal stays an ok:false entry in the returned array;
  // it is the caller's job to decide what that means for its own call.

  private async runBatch(calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> {
    try {
      return await this.rpc.batch(calls);
    } catch (err) {
      if (err instanceof EvmRpcUnavailableError) throw new NetworkOfflineError();
      throw err;
    }
  }

  /** One non-batched call, same transport-failure conversion as runBatch. An
   *  EvmRpcError (the node refused THIS call) is left to propagate: it is a
   *  definitive answer, not an offline signal. */
  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    try {
      return await this.rpc.call<T>(method, params);
    } catch (err) {
      if (err instanceof EvmRpcUnavailableError) throw new NetworkOfflineError();
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // getNetworkStatus — never throws.

  async getNetworkStatus(): Promise<NetworkStatus> {
    try {
      const [blockNumberResult, blockResult] = await this.runBatch([
        { method: 'eth_blockNumber' },
        { method: 'eth_getBlockByNumber', params: ['latest', false] },
      ]);
      if (!blockNumberResult.ok) throw blockNumberResult.error;
      const blockHeight = Number(fromQuantity(blockNumberResult.result));
      const tipTime = readTipTime(blockResult);

      return {
        networkId: 'mainnet',
        state: 'connected',
        latencyMs: this.rpc.lastLatencyMs() ?? 0,
        blockHeight,
        // The RPC host is the closest thing an EVM node has to a server
        // version over plain JSON-RPC: there is no equivalent of Electrum's
        // server.version handshake.
        serverVersion: this.rpc.activeEndpoint() ?? '',
        updatedAt: this.now(),
        tipTime,
      };
    } catch {
      return {
        networkId: 'mainnet',
        state: 'offline',
        latencyMs: 0,
        blockHeight: 0,
        serverVersion: '',
        updatedAt: this.now(),
        tipTime: null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // getAllAssetBalances — the dynamic-asset shape the store consumes.

  async getAllAssetBalances(address: string): Promise<LiveAssetBalance[]> {
    // An invalid address is a caller bug, not a network state: it must not be
    // reported as "offline", which would tell the user to wait it out.
    if (!isEvmAddress(address)) {
      throw new Error(`evmProvider: not a valid EVM address: ${address}`);
    }
    const plan = this.planBalanceCalls(address);
    let results = await this.runBatch(plan.calls);
    if (plan.alchemyIndex !== null && !results[plan.alchemyIndex].ok) {
      const fallback = this.planBalanceCalls(address, 'eth_call');
      results = await this.runBatch(fallback.calls);
      return this.parseBalances(address, fallback, results).rows;
    }
    return this.parseBalances(address, plan, results).rows;
  }

  // -------------------------------------------------------------------------
  // getAssetMeta — validate a contract address against the live chain.
  // EVM tokens are identified by contract, never by symbol: two tokens can
  // share a symbol, so a bare name (not an address) is unanswerable here.

  async getAssetMeta(name: string): Promise<LiveAssetMeta | null> {
    if (!isEvmAddress(name)) return null;

    const key = name.toLowerCase();
    const cached = this.assetMetaCache.get(key);
    if (cached) return cached;

    const results = await this.runBatch([
      { method: 'eth_call', params: [{ to: name, data: encodeDecimals() }, 'latest'] },
      { method: 'eth_call', params: [{ to: name, data: encodeSymbol() }, 'latest'] },
    ]);
    const [decimalsResult, symbolResult] = results;

    let meta: LiveAssetMeta;
    if (decimalsResult.ok && symbolResult.ok) {
      try {
        const decimals = decodeUint8(decimalsResult.result as string);
        // symbol() is read only to prove this really answers like an ERC-20;
        // LiveAssetMeta carries no symbol field.
        decodeString(symbolResult.result as string);
        meta = { exists: true, decimals, reissuable: false, supply: 0, hasIpfs: false };
      } catch {
        meta = { exists: false, decimals: 0, reissuable: false, supply: 0, hasIpfs: false };
      }
    } else {
      meta = { exists: false, decimals: 0, reissuable: false, supply: 0, hasIpfs: false };
    }

    this.assetMetaCache.set(key, meta);
    return meta;
  }

  /**
   * Resolve a token CONTRACT into a tracked-token reference by asking the chain
   * for its symbol and decimals (one batch). Null when the address is not an
   * address, or the contract does not answer like an ERC-20 (a revert or
   * unreadable data). Transport failure surfaces as NetworkOfflineError. This
   * is what "Add token by address" needs: identity is the contract, and the
   * chain's own answers are what get displayed, never what the user typed.
   */
  async resolveToken(address: string): Promise<EvmTokenRef | null> {
    if (!isEvmAddress(address)) return null;
    const results = await this.runBatch([
      { method: 'eth_call', params: [{ to: address, data: encodeDecimals() }, 'latest'] },
      { method: 'eth_call', params: [{ to: address, data: encodeSymbol() }, 'latest'] },
    ]);
    const [decimalsResult, symbolResult] = results;
    if (!decimalsResult.ok || !symbolResult.ok) return null;
    try {
      const decimals = decodeUint8(decimalsResult.result as string);
      const symbol = decodeString(symbolResult.result as string);
      if (!symbol) return null;
      const ref: EvmTokenRef = { address: normalizeEvmAddress(address), symbol, decimals };
      this.tokenMetaCache.set(address.toLowerCase(), { decimals, symbol });
      return ref;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // getAssetBalance — single-asset balance in WHOLE units. DISPLAY-ONLY, the
  // same contract as ElectrumWalletDataProvider.getAssetBalance.

  async getAssetBalance(address: string, name: string): Promise<number> {
    if (name === this.chain.nativeTicker) {
      const raw = await this.rpcCall<string>('eth_getBalance', [address, 'latest']);
      return toWholeUnits(fromQuantity(raw), this.chain.nativeDecimals);
    }

    if (isEvmAddress(name)) {
      const key = name.toLowerCase();
      let decimals = this.tokenMetaCache.get(key)?.decimals;
      if (decimals === undefined) {
        const raw = await this.rpcCall<string>('eth_call', [{ to: name, data: encodeDecimals() }, 'latest']);
        decimals = decodeUint8(raw);
      }
      const raw = await this.rpcCall<string>('eth_call', [{ to: name, data: encodeBalanceOf(address) }, 'latest']);
      return toWholeUnits(decodeUint256(raw), decimals);
    }

    return 0;
  }

  // -------------------------------------------------------------------------
  // getBalances — WalletDataProvider's closed-AssetId shape, derived from
  // getAllAssetBalances. The domain AssetId union predates multi-chain, so
  // the row name (native ticker or token symbol) is cast, exactly as
  // ElectrumWalletDataProvider already casts its own non-'EVR' native ids.

  async getBalances(address: string): Promise<AssetBalance[]> {
    const rows = await this.getAllAssetBalances(address);
    return rows.map((row) => ({
      assetId: row.name as AssetId,
      amountBase: row.amountBase,
      scale: row.scale,
    }));
  }

  // -------------------------------------------------------------------------
  // getTransactions / getAssets — phase 2 has no indexer. Plain JSON-RPC has
  // no method that lists an address's transactions (the EVM engine design notes
  // section 5): that needs an indexer, which is phase 4. Empty, not an error.

  async getTransactions(_address: string): Promise<Transaction[]> {
    return [];
  }

  async getAssets(): Promise<Asset[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // simulateTransaction / submitTransaction — the send path is phase 3. These
  // must never pretend to have sent anything, so they reject outright.

  async simulateTransaction(_request: TransactionRequest): Promise<TransactionSimulation> {
    throw new Error('EVM send is not available in this build (phase 3)');
  }

  async submitTransaction(_request: TransactionRequest): Promise<TransactionSimulation> {
    throw new Error('EVM send is not available in this build (phase 3)');
  }
}

/** Build a provider for one chain: = new EvmWalletDataProvider(createEvmRpcClient(chain, opts.rpc), opts). */
export function createEvmProvider(
  chain: EvmChain,
  opts?: EvmProviderOptions & { rpc?: EvmRpcOptions },
): EvmWalletDataProvider {
  const { rpc: rpcOptions, ...providerOptions } = opts ?? {};
  return new EvmWalletDataProvider(createEvmRpcClient(chain, rpcOptions), providerOptions);
}
