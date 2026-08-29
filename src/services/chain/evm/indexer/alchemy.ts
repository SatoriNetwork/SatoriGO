// Alchemy Transfers API indexer, shaped to satisfy the SAME `EtherscanIndexer`
// interface as etherscan.ts, so activity.ts and the store need no changes to
// take either family (phase 4, the EVM rollout plan, section 5,
// "history"). Where etherscan.ts speaks GET+query-string against a REST
// account API, this speaks the `alchemy_getAssetTransfers` JSON-RPC extension
// through the SAME `EvmRpcClient` (rpc.ts) that balances and sends already
// use: no separate HTTP client, no separate API key plumbing, and the same
// failover/rate-limit machinery rpc.ts already provides.
//
// ---------------------------------------------------------------------------
// (a) TWO QUERIES, ONE PAGE, NO FOLLOW-UP.
//
//     `alchemy_getAssetTransfers` only reports transfers where the address is
//     ONE side (fromAddress OR toAddress), never both at once, so listing an
//     account's history needs two calls. They are always sent together, in
//     one `rpc.batch`, so this never costs the caller two round trips.
//     `pageKey` paging (asking for the transfers past the newest 100 in a
//     direction) is NOT implemented: `opts.page` is accepted and ignored, and
//     the newest 100 transfers per direction is what the wallet shows. A
//     wallet history view is "recent activity", not a ledger export.
//
// (b) A BAD ROW IS SKIPPED, NOT A BAD RESPONSE (matches etherscan.ts note (b)).
//
//     A row whose hash is not 0x+64-hex, or whose blockNum is not a JSON-RPC
//     quantity, does not fail the whole page; it is dropped and the rest of
//     the page is still returned. A token-transfer row missing its contract
//     address, base-unit value or decimals is unusable as a token movement
//     and is dropped the same way.
//
// (c) FEES ARE A SEPARATE, BEST-EFFORT LOOKUP.
//
//     A transfer row carries no gas information at all. For transactions this
//     address SENT, `eth_getTransactionReceipt` is batched afterwards (newest
//     `receiptLimit` sends only, never for received transfers) to fill in
//     gasUsed/gasPrice/isError/l1Fee. This is deliberately best-effort: the
//     transfer list itself is the useful answer even when the receipt lookup
//     cannot complete, so a receipt-batch failure leaves every fee field at
//     its zero default rather than failing `listTransactions` outright.
//
// (d) NO ENDPOINT URL EVER APPEARS IN AN ERROR MESSAGE.
//
//     rpc.ts already keeps the endpoint (which carries the Alchemy API key in
//     its path) out of EvmRpcError/EvmRpcUnavailableError text. This module
//     only ever repeats THOSE messages (or the node's own error text, length
//     capped) into EvmIndexerError, so the rule carries through unbroken.
//
// Environment: Chrome MV3 service worker and popup. No fetch of its own, no
// Node APIs: every network access goes through the injected EvmRpcClient.
// ---------------------------------------------------------------------------

import {
  EvmIndexerError,
  type EtherscanIndexer,
  type EvmOlderPage,
  type IndexedTx,
  type IndexedTokenTransfer,
} from './etherscan';
import {
  EvmRpcError,
  EvmRpcUnavailableError,
  fromQuantity,
  toQuantity,
  type EvmRpcBatchResult,
  type EvmRpcCall,
  type EvmRpcClient,
} from '../rpc';
import { isEvmAddress } from '../keys';

/** Length cap on any text this module did not write itself (the node's own
 *  error message), matching etherscan.ts's note (c) and rpc.ts's note (c). */
const MAX_DETAIL = 200;

/** How many transfers to ask for per direction, per page. The API's own
 *  documented default/ceiling for `maxCount` in one call is 0x3e8 (1000); 100
 *  is chosen here to match etherscan.ts's DEFAULT_PAGE_SIZE, since both are
 *  showing the same "recent activity" list. */
const MAX_COUNT_HEX = '0x64';

/** Default `receiptLimit`: how many of the address's own sends get a receipt
 *  lookup (and therefore a real fee) per `listTransactions` call. Ten, not
 *  more: Alchemy meters compute units per SECOND and a receipt batch lands in
 *  the same second as the transfers batch; the owner saw "exceeded its compute
 *  units per second capacity" in the dashboard with a larger figure. */
const DEFAULT_RECEIPT_LIMIT = 10;

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** Every way a throttled provider words it: public nodes ("rate limit", "too
 *  many requests"), HTTP 429 after the rpc client's own retries ("rate
 *  limited: HTTP 429"), and Alchemy's "exceeded its compute units per second
 *  capacity ... throughput". The owner saw the last one classified as a
 *  REFUSAL (2026-08-19), which reads as "history is gone" instead of "again in
 *  a moment". */
const RATE_LIMIT_RE = /rate limit|rate limited|429|too many|compute units|capacity|throughput/i;
/** The endpoint does not implement the method at all (JSON-RPC -32601): a
 *  public node asked an alchemy_* question. Not a refusal of THIS request; the
 *  history source is simply not reachable through that endpoint. */
const NO_SUCH_METHOD_RE = /method (not found|does not exist|is not available|not supported)|unsupported method|not supported/i;

export interface AlchemyIndexerOptions {
  /** How many receipts to fetch per listTransactions call, newest first, only
   *  for transactions the address SENT. Default 25. */
  receiptLimit?: number;
}

// ---------------------------------------------------------------------------
// Small parsing helpers, mirroring etherscan.ts's style: each returns a
// sentinel for "could not parse" rather than throwing, so a row-level parser
// can decide what a missing/bad field means for that row.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(text: string, max = MAX_DETAIL): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (${text.length} chars)`;
}

/** 0x + 64 hex digits, lowercased. Anything else is not a transaction hash
 *  (rule: a row with a bad hash is skipped, not fatal). */
function parseHash(value: unknown): string | null {
  if (typeof value !== 'string' || !HASH_RE.test(value)) return null;
  return value.toLowerCase();
}

/** Safe wrapper around rpc.ts's `fromQuantity`, which throws on anything that
 *  is not a strict JSON-RPC QUANTITY. Returns null instead, so callers decide
 *  per field whether "not a quantity" skips a row or defaults a value. */
function parseQuantity(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  try {
    return fromQuantity(value);
  } catch {
    return null;
  }
}

/** `metadata.blockTimestamp` (ISO 8601) -> unix ms, or null when missing or
 *  unparseable (Date.parse returns NaN). */
function parseTimestamp(metadata: unknown): number | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata.blockTimestamp;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** Lowercase when a non-empty string, otherwise null: `to` on an external
 *  transfer is null for contract creation, and Alchemy sends null (never ''
 *  in practice, but both are treated the same way as etherscan.ts's txlist
 *  does for the equivalent field). */
function parseToField(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.toLowerCase();
}

function parseFromField(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function getRawContract(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(raw.rawContract) ? raw.rawContract : undefined;
}

/**
 * One `alchemy_getAssetTransfers` transfer -> IndexedTx, or null when the row
 * is unusable (bad hash, bad blockNum, bad/missing timestamp). `value` is
 * ALWAYS read from `rawContract.value` (base-unit hex), never from the
 * decimal `value` field, which is display-only and would misencode any token
 * with a decimals count that does not happen to look right rounded to a JS
 * number. Fee fields are left at their zero defaults; `fillFees` below
 * patches them in afterwards for the address's own sends.
 */
function parseIndexedTx(raw: unknown): IndexedTx | null {
  if (!isRecord(raw)) return null;

  const hash = parseHash(raw.hash);
  if (hash === null) return null;
  const blockNumber = parseQuantity(raw.blockNum);
  if (blockNumber === null) return null;
  const timestamp = parseTimestamp(raw.metadata);
  if (timestamp === null) return null;

  const from = parseFromField(raw.from);
  const to = parseToField(raw.to);
  const rawContract = getRawContract(raw);
  const value =
    rawContract && typeof rawContract.value === 'string'
      ? (parseQuantity(rawContract.value) ?? 0n)
      : 0n;

  return {
    hash,
    blockNumber,
    timestamp,
    from,
    to,
    value,
    gasUsed: 0n,
    gasPrice: 0n,
    isError: false,
    input: '0x',
    contractAddress: null,
    confirmations: 0n,
  };
}

/**
 * One `alchemy_getAssetTransfers` (category erc20) transfer -> IndexedTokenTransfer,
 * or null when any of the fields the row exists to carry cannot be read:
 * hash, blockNum, timestamp (as above), plus the token contract address, the
 * base-unit value and the decimals, none of which have a sane default.
 */
function parseIndexedTokenTransfer(raw: unknown): IndexedTokenTransfer | null {
  if (!isRecord(raw)) return null;

  const hash = parseHash(raw.hash);
  if (hash === null) return null;
  const blockNumber = parseQuantity(raw.blockNum);
  if (blockNumber === null) return null;
  const timestamp = parseTimestamp(raw.metadata);
  if (timestamp === null) return null;

  const rawContract = getRawContract(raw);
  const contractAddress =
    rawContract && typeof rawContract.address === 'string' ? rawContract.address.toLowerCase() : null;
  if (contractAddress === null) return null;

  const value =
    rawContract && typeof rawContract.value === 'string' ? parseQuantity(rawContract.value) : null;
  if (value === null) return null;

  const tokenDecimalQuantity =
    rawContract && typeof rawContract.decimal === 'string' ? parseQuantity(rawContract.decimal) : null;
  if (tokenDecimalQuantity === null) return null;
  const tokenDecimal = Number(tokenDecimalQuantity);

  const from = parseFromField(raw.from);
  const to = typeof raw.to === 'string' ? raw.to.toLowerCase() : '';
  const asset = typeof raw.asset === 'string' ? raw.asset : '';

  return {
    hash,
    blockNumber,
    timestamp,
    from,
    to,
    contractAddress,
    value,
    tokenSymbol: asset,
    tokenName: asset,
    tokenDecimal,
    gasUsed: 0n,
    gasPrice: 0n,
    confirmations: 0n,
  };
}

/** Newest first: timestamp desc, then blockNumber desc. Array#sort is stable,
 *  so two rows tying on both keep the order they were inserted in. */
function sortNewestFirst<T extends { timestamp: number; blockNumber: bigint }>(a: T, b: T): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
  return 0;
}

/** Validates and lowercases an address BEFORE any network activity. Throws a
 *  plain Error, not EvmIndexerError: this is a caller mistake, not something
 *  the indexer said (matches etherscan.ts's requireValidAddress). */
function requireValidAddress(address: string): string {
  if (!isEvmAddress(address)) {
    throw new Error(`Not a valid EVM address: ${clip(address, 64)}`);
  }
  return address.toLowerCase();
}

/** One direction's `alchemy_getAssetTransfers` result, validated down to just
 *  the field this module reads. */
interface TransfersResult {
  transfers: unknown[];
}

/** `result` must be an object with a `transfers` array; anything else is a
 *  shape this client does not understand. */
function validateTransfersResult(result: unknown): TransfersResult {
  if (!isRecord(result) || !Array.isArray(result.transfers)) {
    throw new EvmIndexerError('malformed', 'indexer response malformed: result has no transfers array');
  }
  return { transfers: result.transfers };
}

/** This family's cursor: the `pageKey` still owed for each direction, or null
 *  for a direction that has run out. Anything unreadable (a cursor from the
 *  other family, or from another build) reads as "start at the first page",
 *  which repeats one page and never returns a wrong one. */
function parsePageKeyCursor(
  cursor: string | undefined,
): { from: string | null; to: string | null; toBlock: string } | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const v = JSON.parse(cursor) as unknown;
    if (!isRecord(v)) return null;
    const key = (x: unknown): string | null | undefined =>
      x === null ? null : typeof x === 'string' && x !== '' && x.length <= 512 ? x : undefined;
    const from = key(v.from);
    const to = key(v.to);
    if (from === undefined || to === undefined) return null;
    // The window the pageKeys were issued against. A cursor without a usable
    // one falls back to 'latest', which is the widest query and therefore the
    // one that cannot skip a row.
    const toBlock = v.toBlock === 'latest' || (typeof v.toBlock === 'string' && /^0x[0-9a-fA-F]+$/.test(v.toBlock)) ? v.toBlock : 'latest';
    return { from, to, toBlock };
  } catch {
    return null;
  }
}

/** Turn one per-item EvmRpcError (a definitive answer FROM the node, per
 *  rpc.ts note (a)) into the EvmIndexerError reason it corresponds to. */
function classifyRpcError(err: EvmRpcError): EvmIndexerError {
  if (RATE_LIMIT_RE.test(err.message)) {
    return new EvmIndexerError('rate-limited', 'indexer rate limit reached', clip(err.message));
  }
  if (err.code === -32601 || NO_SUCH_METHOD_RE.test(err.message)) {
    return new EvmIndexerError('unavailable', `history API not available on this endpoint: ${clip(err.message)}`, clip(err.message));
  }
  return new EvmIndexerError('refused', `indexer request refused: ${clip(err.message)}`, clip(err.message));
}

class AlchemyIndexer implements EtherscanIndexer {
  readonly baseUrl: string;

  private readonly rpc: EvmRpcClient;
  private readonly receiptLimit: number;

  constructor(rpc: EvmRpcClient, opts: AlchemyIndexerOptions = {}) {
    this.rpc = rpc;
    // A stable label, never the URL: the active endpoint carries the Alchemy
    // API key in its path (rpc.ts note (c)), and this is shown/logged freely.
    this.baseUrl = `alchemy://${rpc.chain.key}`;
    this.receiptLimit =
      opts.receiptLimit !== undefined && opts.receiptLimit > 0
        ? Math.floor(opts.receiptLimit)
        : DEFAULT_RECEIPT_LIMIT;
  }

  async listTransactions(
    address: string,
    opts: { sinceBlock?: bigint; page?: number } = {},
  ): Promise<IndexedTx[]> {
    const normalized = requireValidAddress(address);
    const results = await this.fetchTransfers(normalized, ['external'], opts.sinceBlock);

    const byHash = new Map<string, IndexedTx>();
    for (const result of results) {
      for (const rawTransfer of result.transfers) {
        const tx = parseIndexedTx(rawTransfer);
        if (tx && !byHash.has(tx.hash)) byHash.set(tx.hash, tx);
      }
    }

    const list = [...byHash.values()];
    list.sort(sortNewestFirst);
    await this.fillFees(list, normalized);
    return list;
  }

  async listTokenTransfers(
    address: string,
    opts: { sinceBlock?: bigint; page?: number; contract?: string } = {},
  ): Promise<IndexedTokenTransfer[]> {
    const normalized = requireValidAddress(address);
    const contractAddresses =
      opts.contract !== undefined ? [opts.contract.toLowerCase()] : undefined;
    const results = await this.fetchTransfers(normalized, ['erc20'], opts.sinceBlock, contractAddresses);

    const byUniqueId = new Map<string, IndexedTokenTransfer>();
    for (const result of results) {
      for (const rawTransfer of result.transfers) {
        if (!isRecord(rawTransfer)) continue;
        const transfer = parseIndexedTokenTransfer(rawTransfer);
        if (!transfer) continue;
        // uniqueId distinguishes multiple ERC-20 logs inside one hash (and is
        // what the API itself uses to identify one transfer); a hash+contract
        // fallback covers the (untested-in-the-wild) case of a row with no
        // uniqueId at all, so such a row still dedupes sanely rather than
        // always being treated as new.
        const uniqueId =
          typeof rawTransfer.uniqueId === 'string'
            ? rawTransfer.uniqueId
            : `${transfer.hash}:${transfer.contractAddress}:${transfer.value.toString()}`;
        if (!byUniqueId.has(uniqueId)) byUniqueId.set(uniqueId, transfer);
      }
    }

    const list = [...byUniqueId.values()];
    list.sort(sortNewestFirst);
    return list;
  }

  /**
   * Older pages, through the API's own `pageKey` (owner, live testing
   * 2026-08-25: "there is no pagination in activities, I checked for USDT on
   * EVM BNB". Verified live the same day against the gateway for his address
   * on BNB Chain: 100 sent transfers, a pageKey, and a second page of 100 more
   * reaching back from block 109,745,356 to 34,208,015. All of that existed
   * and none of it was reachable.)
   *
   * ONE batch of two calls per page, exactly like the newest page: the two
   * directions the API insists on (`fromAddress` OR `toAddress`, never both),
   * asked for `external` and `erc20` TOGETHER so native transactions and token
   * transfers arrive on the same page instead of costing two round trips. Each
   * direction carries its own `pageKey` and runs out on its own; a direction
   * with no key left is not asked again, and when neither has one the cursor
   * comes back null, which is what tells the UI it has reached the end rather
   * than an empty page.
   *
   * The FIRST older page starts BELOW what the caller already holds
   * (`beforeBlock`, its oldest known block), not at the API's own newest page.
   * Without that the first click would spend a whole page re-serving rows
   * already on screen and look like it did nothing: the newest read asks for
   * 100 external AND 100 erc20 transfers, while one page here is 100 of the
   * two combined, so the API's page 1 falls entirely inside what is known.
   * `toBlock` is inclusive, so the boundary block comes back again and the
   * merge dedupes it, which is the safe direction: a row is repeated, never
   * skipped. Every page after the first continues from the returned pageKey
   * with the same query, which is what a pageKey is bound to.
   */
  async listOlder(address: string, opts: { cursor?: string; beforeBlock?: bigint } = {}): Promise<EvmOlderPage> {
    const normalized = requireValidAddress(address);
    const state = parsePageKeyCursor(opts.cursor);
    // The window is fixed for the whole walk: it is set on the first page and
    // carried in the cursor, because a pageKey is only valid for the query it
    // came from.
    const toBlock =
      state?.toBlock ?? (opts.beforeBlock !== undefined && opts.beforeBlock > 0n ? toQuantity(opts.beforeBlock) : 'latest');
    const baseParams: Record<string, unknown> = {
      fromBlock: '0x0',
      toBlock,
      category: ['external', 'erc20'],
      withMetadata: true,
      excludeZeroValue: false,
      order: 'desc',
      maxCount: MAX_COUNT_HEX,
    };
    // A direction whose key is null has already run out: it is not asked
    // again, and its slot in the batch is simply absent.
    const directions: Array<{ side: 'from' | 'to'; call: EvmRpcCall }> = [];
    if (state === null || state.from !== null) {
      directions.push({
        side: 'from',
        call: {
          method: 'alchemy_getAssetTransfers',
          params: [{ ...baseParams, fromAddress: normalized, ...(state?.from ? { pageKey: state.from } : {}) }],
        },
      });
    }
    if (state === null || state.to !== null) {
      directions.push({
        side: 'to',
        call: {
          method: 'alchemy_getAssetTransfers',
          params: [{ ...baseParams, toAddress: normalized, ...(state?.to ? { pageKey: state.to } : {}) }],
        },
      });
    }
    if (directions.length === 0) return { txs: [], tokenTransfers: [], cursor: null };

    const results = await this.runBatchWithKeys(directions.map((d) => d.call));
    const txs: IndexedTx[] = [];
    const tokenTransfers: IndexedTokenTransfer[] = [];
    const nextKeys: { from: string | null; to: string | null } = { from: null, to: null };
    results.forEach((result, i) => {
      nextKeys[directions[i].side] = result.pageKey;
      for (const raw of result.transfers) {
        // The two categories arrive mixed in one answer, so the ROW says which
        // parser it belongs to. Guessing from the shape would let an erc20 row
        // through parseIndexedTx as a native transfer of its token amount.
        const category = isRecord(raw) ? raw.category : undefined;
        if (category === 'erc20') {
          const transfer = parseIndexedTokenTransfer(raw);
          if (transfer) tokenTransfers.push(transfer);
        } else {
          const tx = parseIndexedTx(raw);
          if (tx) txs.push(tx);
        }
      }
    });
    txs.sort(sortNewestFirst);
    tokenTransfers.sort(sortNewestFirst);
    // Fees for the address's own sends on this page, best-effort exactly as on
    // the newest page (and served from the receipt cache for anything already
    // seen), so an older row shows the fee it really paid.
    await this.fillFees(txs, normalized);
    const cursor =
      nextKeys.from === null && nextKeys.to === null
        ? null
        : JSON.stringify({ from: nextKeys.from, to: nextKeys.to, toBlock });
    return { txs, tokenTransfers, cursor };
  }

  /** runBatch, keeping each answer's `pageKey` (absent = that direction has no
   *  more pages). */
  private async runBatchWithKeys(calls: EvmRpcCall[]): Promise<Array<{ transfers: unknown[]; pageKey: string | null }>> {
    let results: EvmRpcBatchResult[];
    try {
      results = await this.rpc.batch(calls);
    } catch (err) {
      if (err instanceof EvmRpcUnavailableError) {
        if (RATE_LIMIT_RE.test(err.message)) {
          throw new EvmIndexerError('rate-limited', 'indexer rate limit reached', clip(err.message));
        }
        throw new EvmIndexerError('unavailable', `indexer request failed: ${err.message}`);
      }
      throw err;
    }
    return results.map((item) => {
      if (!item.ok) throw classifyRpcError(item.error);
      const validated = validateTransfersResult(item.result);
      const pageKey = isRecord(item.result) && typeof item.result.pageKey === 'string' && item.result.pageKey !== ''
        ? item.result.pageKey
        : null;
      return { transfers: validated.transfers, pageKey };
    });
  }

  /**
   * Two `alchemy_getAssetTransfers` calls (fromAddress, toAddress) in one
   * `rpc.batch`, sharing every other parameter. `opts.page` is accepted by
   * the public methods but never read here: the newest page never pages, and
   * older pages go through listOlder above.
   */
  private async fetchTransfers(
    address: string,
    category: readonly string[],
    sinceBlock: bigint | undefined,
    contractAddresses?: readonly string[],
  ): Promise<TransfersResult[]> {
    const baseParams: Record<string, unknown> = {
      fromBlock: sinceBlock !== undefined ? toQuantity(sinceBlock) : '0x0',
      toBlock: 'latest',
      category: [...category],
      withMetadata: true,
      excludeZeroValue: false,
      order: 'desc',
      maxCount: MAX_COUNT_HEX,
    };
    if (contractAddresses !== undefined) {
      baseParams.contractAddresses = [...contractAddresses];
    }

    const calls: EvmRpcCall[] = [
      { method: 'alchemy_getAssetTransfers', params: [{ ...baseParams, fromAddress: address }] },
      { method: 'alchemy_getAssetTransfers', params: [{ ...baseParams, toAddress: address }] },
    ];

    return this.runBatch(calls);
  }

  /** Runs a batch of `alchemy_getAssetTransfers` calls and applies the error
   *  classification rules: a transport failure for the whole batch becomes
   *  'unavailable'; a per-item JSON-RPC refusal becomes 'rate-limited' or
   *  'refused'; a well-formed-but-shapeless result becomes 'malformed'. */
  private async runBatch(calls: EvmRpcCall[]): Promise<TransfersResult[]> {
    let results: EvmRpcBatchResult[];
    try {
      results = await this.rpc.batch(calls);
    } catch (err) {
      if (err instanceof EvmRpcUnavailableError) {
        // Every endpoint failed. If what failed them was throttling (the rpc
        // client retried and gave up), say so: "again in a moment", not "down".
        if (RATE_LIMIT_RE.test(err.message)) {
          throw new EvmIndexerError('rate-limited', 'indexer rate limit reached', clip(err.message));
        }
        throw new EvmIndexerError('unavailable', `indexer request failed: ${err.message}`);
      }
      throw err;
    }
    return results.map((item) => {
      if (!item.ok) throw classifyRpcError(item.error);
      return validateTransfersResult(item.result);
    });
  }

  /**
   * Best-effort fee fill for `list` (already sorted newest first): batches
   * `eth_getTransactionReceipt` for the newest `receiptLimit` rows the address
   * itself sent, and applies gasUsed/effectiveGasPrice/status/l1Fee back onto
   * those rows. Mutates the IndexedTx objects in `list` in place. Any failure
   * (transport-level, or the receipts batch itself throwing) leaves every row
   * at its zero defaults rather than failing `listTransactions`: a transfer
   * list with no fees is still a useful answer (see note (c) above).
   */
  /** Receipts are immutable once mined: remembered per hash for the life of
   *  the indexer, so the history poll (once a minute) re-reads only receipts
   *  it has not seen. Without this, every poll re-spent `receiptLimit` calls. */
  private readonly receiptCache = new Map<string, { gasUsed: bigint; gasPrice: bigint; isError: boolean; l1Fee?: bigint }>();

  private async fillFees(list: IndexedTx[], address: string): Promise<void> {
    const ourSends = list.filter((tx) => tx.from === address).slice(0, this.receiptLimit);
    if (ourSends.length === 0) return;

    const apply = (tx: IndexedTx, fee: { gasUsed: bigint; gasPrice: bigint; isError: boolean; l1Fee?: bigint }) => {
      tx.gasUsed = fee.gasUsed;
      tx.gasPrice = fee.gasPrice;
      tx.isError = fee.isError;
      if (fee.l1Fee !== undefined) tx.l1Fee = fee.l1Fee;
    };
    const missing: IndexedTx[] = [];
    for (const tx of ourSends) {
      const cached = this.receiptCache.get(tx.hash);
      if (cached) apply(tx, cached);
      else missing.push(tx);
    }
    if (missing.length === 0) return;

    const calls: EvmRpcCall[] = missing.map((tx) => ({
      method: 'eth_getTransactionReceipt',
      params: [tx.hash],
    }));

    let results: EvmRpcBatchResult[];
    try {
      results = await this.rpc.batch(calls);
    } catch {
      return;
    }

    results.forEach((item, i) => {
      if (!item.ok) return;
      const receipt = item.result;
      if (!isRecord(receipt)) return;
      const tx = missing[i];

      const gasUsed = parseQuantity(receipt.gasUsed);
      const gasPrice = parseQuantity(receipt.effectiveGasPrice);
      if (gasUsed === null || gasPrice === null) return;
      const fee: { gasUsed: bigint; gasPrice: bigint; isError: boolean; l1Fee?: bigint } = {
        gasUsed,
        gasPrice,
        isError: receipt.status === '0x0',
      };
      if (typeof receipt.l1Fee === 'string') {
        const l1Fee = parseQuantity(receipt.l1Fee);
        if (l1Fee !== null) fee.l1Fee = l1Fee;
      }
      this.receiptCache.set(tx.hash, fee);
      apply(tx, fee);
    });
  }
}

/**
 * Build an indexer over Alchemy's Transfers API for one already-constructed
 * `EvmRpcClient`. The client's endpoints must actually be Alchemy for
 * `alchemy_getAssetTransfers` to exist; against a non-Alchemy node the method
 * comes back as an unrecognised-method EvmRpcError, which this client reports
 * as 'refused' like any other node refusal (see rule 4 in this file's tests).
 */
export function createAlchemyIndexer(rpc: EvmRpcClient, opts?: AlchemyIndexerOptions): EtherscanIndexer {
  return new AlchemyIndexer(rpc, opts);
}
