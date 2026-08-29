// The store's history path for an EVM account (phase 4).
//
// An EVM node cannot list an address's transactions (the JSON-RPC method does
// not exist), so history needs an indexer, and an indexer is a per-chain host.
// A chain without one in this build gets the honest answer, "we cannot list
// history here", never an empty list that reads as "no transactions". Sends made
// from this wallet still show: they are recorded locally by the send path.
//
// Everything EVM is reached through loadEvmModules() (the build flag). The
// type-only imports below are erased at compile time.

import { loadEvmModules } from '../services/chain/engine';
import { evmProviderFor } from './evmBalances';
import type { EtherscanIndexer } from '../services/chain/evm/indexer/etherscan';
import type { StakingCallInfo } from '../services/chain/evm/cosmosStaking';
import type { LiveTransaction } from '../services/chain/electrumProvider';
import type { EvmChainInfo } from './evmChains';
import {
  highestBlockOf,
  loadEvmHistoryCache,
  mergeEvmHistory,
  saveEvmHistoryCache,
  sinceBlockFor,
  type EvmHistoryCacheEntry,
} from './evmHistoryCache';

/** One indexer client per chain key (its base URL never changes in a session). */
const indexers = new Map<string, EtherscanIndexer>();

/** How far an Etherscan-shaped indexer may trail the chain tip before Activity
 *  says so. 200 blocks is minutes on every chain here (Base 2 s, BNB 3 s,
 *  Ethereum 12 s, Epix ~5.6 s): normal indexing delay never reaches it, a
 *  stalled indexer passes it within the hour. */
export const INDEXER_LAG_BLOCKS = 200;

/** The gateway's indexer proxy refuses an `offset` above 100, so a gateway
 *  build asks for exactly that (which is also the client's own default; pinned
 *  here so a future change to the default cannot silently break the route). */
const GATEWAY_MAX_PAGE_SIZE = 100;

// --- staking labels: buying what the history source does not carry -----------
//
// On a cosmos/evm chain a delegation is an EVM transaction whose `value` is 0
// and whose meaning lives entirely in its calldata, and the history source Epix
// is read through reports every such row with `input: '0x'`. So the row alone
// cannot say what it did. Two node reads answer it, and they are the ONLY extra
// requests a labelled Activity costs:
//
//   * `eth_getTransactionByHash` -> the calldata -> WHAT the transaction did
//     and with which validator (and, for a stake/unstake/redelegate, how much).
//   * `eth_getTransactionReceipt` -> the distribution precompile's own event ->
//     HOW MUCH a CLAIM withdrew. A claim's calldata has no amount by design (the
//     chain pays whatever accrued), so this is the only place the figure exists.
//     Confirmed rows only: a pending transaction has no receipt.
//
// Both are bounded the same three ways, because "one more RPC per Activity
// refresh" is how a wallet ends up rate-limited by its own gateway:
//
//   1. ONCE EVER PER TRANSACTION. The decoded result is persisted on the row in
//      the history cache (mergeEvmHistory keeps it when a fresh indexer row
//      arrives without one), so a labelled row is never fetched again, not on
//      the next refresh and not in the next session. A claim whose receipt held
//      no reward event records 0n, which is a KNOWN answer and is equally never
//      asked again; the label prints no amount for it, never "0".
//   2. ONLY CANDIDATES. Only a row whose counterparty IS one of the chain's two
//      staking precompiles is ever asked about, and only on a chain that HAS a
//      staking row. Every other chain makes zero requests.
//   3. CAPPED PER REFRESH. At most STAKING_ENRICH_MAX_PER_REFRESH transactions
//      per refresh across BOTH reads (they share one budget, so a page full of
//      claims cannot double the traffic), in batches of STAKING_ENRICH_BATCH
//      through the ordinary rpc client (so: the gateway in a gateway build,
//      exactly like every other call), one batch at a time. A failure labels
//      nothing and is simply retried on the next refresh: no retry loop, no
//      backoff state.

/** Transactions asked about in one refresh, calldata reads and receipt reads
 *  TOGETHER. An account that somehow has more unenriched staking rows than this
 *  takes the newest first and picks up the rest on later refreshes, rather than
 *  firing a hundred reads at once. */
export const STAKING_ENRICH_MAX_PER_REFRESH = 20;
/** Per HTTP round trip. The rpc client matches batch results by id. */
const STAKING_ENRICH_BATCH = 10;

export interface EvmHistoryIssue {
  /** Short line for the UI (rendered where a refused UTXO history is). */
  message: string;
  /** The indexer's own words, or why there is none, for the tooltip. */
  detail: string;
}

export interface EvmHistoryResult {
  /** Mapped rows, newest first. On an indexer failure these are the CACHED
   *  rows (with `issue` set) when a cache exists, else null (the store then
   *  keeps what it had). */
  txs: LiveTransaction[] | null;
  /** True when `txs` came from the cache because the indexer failed now. */
  stale?: boolean;
  /** Non-null when history is knowingly incomplete: no indexer for the chain,
   *  or the indexer refused / rate-limited / was unreachable. */
  issue: EvmHistoryIssue | null;
  /** Every ERC-20 contract the indexer saw move through this address, with the
   *  symbol/decimals it reports: the token DISCOVERY list. The store reads
   *  balances for them and shows the ones with a balance. Empty without an
   *  indexer or on failure. */
  tokensSeen: Array<{ address: string; symbol: string; decimals: number }>;
}

type EvmMods = NonNullable<Awaited<ReturnType<typeof loadEvmModules>>>;

/** The newest `limit` distinct txids among `rows` that `wants` picks out. */
function enrichCandidates(rows: readonly LiveTransaction[], limit: number, wants: (row: LiveTransaction) => boolean): string[] {
  if (limit <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!wants(row) || seen.has(row.txid)) continue;
    seen.add(row.txid);
    out.push(row.txid);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One JSON-RPC method over a list of transaction hashes, in batches, mapped by
 * hash. Never throws: an unreachable node yields whatever earlier batches
 * answered (usually nothing), and the next refresh asks again.
 */
async function askNodeByHash(
  provider: NonNullable<Awaited<ReturnType<typeof evmProviderFor>>>,
  method: 'eth_getTransactionByHash' | 'eth_getTransactionReceipt',
  hashes: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let at = 0; at < hashes.length; at += STAKING_ENRICH_BATCH) {
    const slice = hashes.slice(at, at + STAKING_ENRICH_BATCH);
    let answers;
    try {
      answers = await provider.rpc.batch(slice.map((hash) => ({ method, params: [hash] })));
    } catch {
      // No endpoint answered. Deliberately a `break`, not a `continue`: if the
      // node is unreachable for the first batch it is unreachable for the
      // second.
      break;
    }
    answers.forEach((answer, i) => {
      if (!answer.ok || !answer.result || typeof answer.result !== 'object') return;
      out.set(slice[i], answer.result as Record<string, unknown>);
    });
  }
  return out;
}

/**
 * Fill in what every staking row is missing: its label, and a claim's amount.
 *
 * NEVER THROWS and never removes anything: the worst case is the list it was
 * given, unchanged. See the bounds above the constants; the two passes share
 * ONE per-refresh budget.
 */
async function labelStakingRows(
  evm: EvmMods,
  chain: EvmChainInfo,
  rows: LiveTransaction[],
  address: string,
): Promise<LiveTransaction[]> {
  // CAPABILITY, not a chain name: a chain with no staking row never reaches the
  // candidate scan, let alone a request.
  const cfg = evm.evmChainByKey(chain.key)?.staking;
  if (!cfg) return rows;

  // Pass 1 candidates, newest first (the order `rows` already carries): a row
  // whose counterparty IS one of the two precompiles and that carries no label.
  const wantCalldata = enrichCandidates(
    rows,
    STAKING_ENRICH_MAX_PER_REFRESH,
    (row) => !row.staking && evm.isStakingPrecompileAddress(cfg, row.counterparty),
  );
  // Pass 2 candidates are computed AFTER pass 1 has been applied, so a claim
  // labelled a moment ago can have its amount read in the same refresh if the
  // budget allows. A claim needs a receipt only once: `amountBase` present (0n
  // included) means the question has been answered.
  const wantsReceipt = (row: LiveTransaction) =>
    row.status === 'confirmed' && row.staking?.kind === 'claim' && row.staking.amountBase === undefined;
  if (wantCalldata.length === 0 && !rows.some(wantsReceipt)) return rows;

  const provider = await evmProviderFor(chain.key);
  if (!provider) return rows;

  let out = rows;
  if (wantCalldata.length > 0) {
    const results = await askNodeByHash(provider, 'eth_getTransactionByHash', wantCalldata);
    const decoded = new Map<string, StakingCallInfo>();
    for (const [hash, result] of results) {
      const info = evm.decodeStakingCallHex(result.input);
      if (info) decoded.set(hash, info);
    }
    if (decoded.size > 0) {
      out = out.map((row) => {
        if (row.staking) return row;
        const info = decoded.get(row.txid);
        return info ? { ...row, staking: info } : row;
      });
    }
  }

  // The budget is spent by what was ASKED, not by what answered: a node that
  // refused ten calldata reads has already cost ten round trips.
  const wantReceipts = enrichCandidates(out, STAKING_ENRICH_MAX_PER_REFRESH - wantCalldata.length, wantsReceipt);
  if (wantReceipts.length === 0) return out;

  const receipts = await askNodeByHash(provider, 'eth_getTransactionReceipt', wantReceipts);
  const amounts = new Map<string, bigint>();
  for (const [hash, receipt] of receipts) {
    const amount = evm.decodeWithdrawnRewards({
      logs: receipt.logs,
      distributionPrecompile: cfg.distributionPrecompile,
      delegator: address,
    });
    if (amount !== null) amounts.set(hash, amount);
  }
  if (amounts.size === 0) return out;
  return out.map((row) => {
    const staking = row.staking;
    if (!staking || !wantsReceipt(row)) return row;
    const amount = amounts.get(row.txid);
    return amount === undefined ? row : { ...row, staking: { ...staking, amountBase: amount } };
  });
}

/**
 * The history client for `chain`, built once per session and cached, or null
 * when this build has no source for that chain. Shared by the newest-page read
 * and the older-page read so the two can never end up on different sources.
 */
function indexerFor(evm: EvmMods, chain: EvmChainInfo): EtherscanIndexer | null {
  const existing = indexers.get(chain.key);
  if (existing) return existing;
  // With a provider key, Alchemy's Transfers API is the history source on every
  // chain with a slug (BNB Chain included), through the SAME rpc client the
  // balances use; without one, the chain's public Etherscan-shaped indexer.
  const chainDef = evm.evmChainByKey(chain.key);
  if (chain.alchemy) {
    // A DEDICATED client holding only the Alchemy endpoint, not the balance
    // provider's failover list: alchemy_* methods exist nowhere else, so a
    // throttled Alchemy must wait and retry, never fail over to a public node
    // that answers "method not found" (which the owner saw surface as "the
    // history service refused the request").
    const url = chainDef ? evm.alchemyRpcUrl(chainDef) : null;
    if (chainDef && url) {
      const built = evm.createAlchemyIndexer(evm.createEvmRpcClient(chainDef, { endpoints: [url] }));
      indexers.set(chain.key, built);
      return built;
    }
  }
  if (!chain.indexer) return null;
  // In a GATEWAY build the wallet is permitted exactly one EVM host, so the
  // chain's own Blockscout is unreachable directly: the gateway proxies it at
  // <gateway>/evm/<key>/indexer and returns the upstream body unchanged, so
  // only the base URL and the auth header differ. `chainid` is deliberately
  // NOT sent there: the proxy accepts module/action/address/sort/page/offset/
  // startblock/contractaddress and nothing else, and it already knows which
  // chain the route names.
  const viaGateway = chainDef ? evm.gatewayIndexerUrl(chainDef) : null;
  const built = viaGateway
    ? evm.createEtherscanIndexer({ baseUrl: viaGateway, headers: evm.evmGatewayHeaders(), pageSize: GATEWAY_MAX_PAGE_SIZE })
    : evm.createEtherscanIndexer({ baseUrl: chain.indexer.baseUrl, chainId: chain.chainId });
  indexers.set(chain.key, built);
  return built;
}

/** Newest 100 transactions and token transfers of `address` on `chain`, mapped
 *  to Activity rows. Never throws. Returns null only when this build has no
 *  EVM engine at all. */
export async function refreshEvmHistory(
  chain: EvmChainInfo,
  address: string,
  tipBlock?: number,
): Promise<EvmHistoryResult | null> {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const indexer = indexerFor(evm, chain);
  if (!indexer) {
    return {
      txs: [],
      tokensSeen: [],
      issue: {
        message: `Activity cannot be listed on ${chain.displayName} yet: this build has no history source for it. Sends made from this wallet still show.`,
        detail: `${chain.displayName} has no indexer configured (no keyless Etherscan-shaped API is available for it).`,
      },
    };
  }
  // What we already know for this account on this chain: shown while the
  // indexer answers, the watermark the incremental query starts from, and the
  // fallback when the indexer fails now.
  const cache: EvmHistoryCacheEntry | null = await loadEvmHistoryCache(chain.key, address);
  try {
    // Sequential, not parallel: on a keyed provider each list is a batch that
    // costs real throughput (Alchemy meters compute units per second, and two
    // Transfers-API batches in the same second exceed the free tier), and the
    // history read is off the critical path anyway. Incremental: only blocks
    // past the cached watermark (minus an overlap) are asked for.
    const sinceBlock = sinceBlockFor(cache);
    const txs = await indexer.listTransactions(address, sinceBlock !== undefined ? { sinceBlock } : {});
    const tokenTransfers = await indexer.listTokenTransfers(address, sinceBlock !== undefined ? { sinceBlock } : {});
    const stakingCfg = evm.evmChainByKey(chain.key)?.staking;
    const freshRows = evm.mapEvmActivity({
      address,
      nativeTicker: chain.nativeTicker,
      nativeDecimals: chain.nativeDecimals,
      txs,
      tokenTransfers,
      tipBlock: tipBlock !== undefined ? BigInt(tipBlock) : undefined,
      // Absent on every chain without native staking, which is the capability
      // test the whole label keys off. A row that arrives WITH its calldata is
      // decoded here, for free; Epix's does not, hence labelStakingRows below.
      ...(stakingCfg ? { staking: stakingCfg } : {}),
    });
    const merged = cache ? mergeEvmHistory(cache.rows, freshRows) : freshRows;
    const rows = await labelStakingRows(evm, chain, merged, address);
    void saveEvmHistoryCache(chain.key, address, {
      rows,
      highestBlock: Math.max(cache?.highestBlock ?? 0, highestBlockOf(rows)),
      fetchedAt: Date.now(),
    });
    // Is the indexer keeping up with the chain? An explorer that stopped
    // indexing answers every list with "no transactions" while the balance
    // (read from the node) already moved: said out loud, not left as an empty
    // list. Only Etherscan-shaped indexers can be asked; Alchemy's Transfers
    // API has no lag to speak of and no such call.
    let lagIssue: EvmHistoryIssue | null = null;
    if (tipBlock !== undefined && typeof indexer.headBlock === 'function') {
      const head = await indexer.headBlock();
      if (head !== null) {
        const behind = BigInt(tipBlock) - head;
        if (behind > BigInt(INDEXER_LAG_BLOCKS)) {
          const n = behind.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          lagIssue = {
            message: `Activity on ${chain.displayName} is behind: the chain's explorer has indexed up to block ${head.toLocaleString('en-US')} while the chain is at block ${tipBlock.toLocaleString('en-US')} (${n} blocks behind). Balances are live; transactions appear here once the explorer catches up.`,
            detail: `indexer head ${head} vs chain tip ${tipBlock} (${behind} blocks)`,
          };
        }
      }
    }
    const seen = new Map<string, { address: string; symbol: string; decimals: number }>();
    for (const t of tokenTransfers) {
      const key = t.contractAddress.toLowerCase();
      if (!seen.has(key) && evm.isEvmAddress(t.contractAddress)) {
        seen.set(key, { address: evm.toChecksumAddress(t.contractAddress), symbol: t.tokenSymbol, decimals: t.tokenDecimal });
      }
    }
    return { txs: rows, issue: lagIssue, tokensSeen: [...seen.values()] };
  } catch (err) {
    const reason = err instanceof evm.EvmIndexerError ? err.reason : 'unavailable';
    const detail = err instanceof Error ? err.message : String(err);
    const cachedRows = cache && cache.rows.length > 0 ? cache.rows : null;
    const saved = cachedRows ? 'Showing saved history; newer items may be missing. ' : '';
    const message =
      reason === 'rate-limited'
        ? `${saved}Activity may be incomplete: the ${chain.displayName} history service is rate-limiting this wallet. It retries on the next refresh.`
        : reason === 'refused'
          ? `${saved}Activity cannot be ${cachedRows ? 'refreshed' : 'listed'} right now: the ${chain.displayName} history service refused the request.`
          : `${saved}Activity may be incomplete: the ${chain.displayName} history service is unreachable. Balances and sending are unaffected.`;
    return { txs: cachedRows, stale: cachedRows !== null, issue: { message, detail }, tokensSeen: [] };
  }
}

/** What one "Load older" click came back with. */
export interface EvmOlderHistoryResult {
  /** Rows from the older page, mapped to Activity rows. Empty when the page
   *  held nothing new; null when the read failed. */
  rows: LiveTransaction[] | null;
  /** Pass to the next call. Null when the source has NOTHING older left. */
  cursor: string | null;
  /** True while the source can serve another page after this one. */
  hasMore: boolean;
  /** Set when the read failed, in the same words Activity already uses. */
  issue: EvmHistoryIssue | null;
}

/**
 * ONE page of history older than what the wallet already holds.
 *
 * The chain's registry row decides whether this is possible at all: a source
 * that cannot walk backwards does not implement `listOlder`, and the caller is
 * told `hasMore: false` so it can say "this is as far as this chain's history
 * goes" rather than offering a button that comes back empty.
 *
 * ONE round trip per call, and the caller (the store) is what stops two from
 * overlapping. Never throws.
 */
export async function loadOlderEvmHistory(
  chain: EvmChainInfo,
  address: string,
  cursor: string | undefined,
  tipBlock?: number,
  /** The OLDEST block already on screen. Starts the first page BELOW what the
   *  wallet holds, so the user's first click adds rows instead of re-serving
   *  the ones in front of them. */
  beforeBlock?: number,
): Promise<EvmOlderHistoryResult | null> {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const indexer = indexerFor(evm, chain);
  if (!indexer || typeof indexer.listOlder !== 'function') {
    return { rows: [], cursor: null, hasMore: false, issue: null };
  }
  try {
    const page = await indexer.listOlder(address, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(beforeBlock !== undefined && beforeBlock > 0 ? { beforeBlock: BigInt(beforeBlock) } : {}),
    });
    const stakingCfg = evm.evmChainByKey(chain.key)?.staking;
    const rows = evm.mapEvmActivity({
      address,
      nativeTicker: chain.nativeTicker,
      nativeDecimals: chain.nativeDecimals,
      txs: page.txs,
      tokenTransfers: page.tokenTransfers,
      tipBlock: tipBlock !== undefined ? BigInt(tipBlock) : undefined,
      ...(stakingCfg ? { staking: stakingCfg } : {}),
    });
    return { rows, cursor: page.cursor, hasMore: page.cursor !== null, issue: null };
  } catch (err) {
    const reason = err instanceof evm.EvmIndexerError ? err.reason : 'unavailable';
    const detail = err instanceof Error ? err.message : String(err);
    const message =
      reason === 'rate-limited'
        ? `Older ${chain.displayName} activity could not be loaded: the history service is rate-limiting this wallet. Try again in a moment.`
        : reason === 'refused'
          ? `Older ${chain.displayName} activity could not be loaded: the history service refused the request.`
          : `Older ${chain.displayName} activity could not be loaded: the history service is unreachable.`;
    // The cursor is handed back unchanged so a retry resumes where it stopped
    // rather than starting over, and `hasMore` stays true: a failure says
    // nothing about whether older rows exist.
    return { rows: null, cursor: cursor ?? null, hasMore: true, issue: { message, detail } };
  }
}

/** Tests only. */
export function resetEvmIndexersForTests(): void {
  indexers.clear();
}
