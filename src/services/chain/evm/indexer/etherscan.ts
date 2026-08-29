// One HTTP client for the whole Etherscan-shaped indexer family (phase 4 of
// the EVM rollout, the EVM rollout plan, section 5, "history").
//
// Etherscan itself, Blockscout and BscScan all answer the same account API:
// GET ?module=account&action=txlist|tokentx&address=&page=&offset=&sort=
// [&startblock=][&contractaddress=][&chainid=][&apikey=], replying
// { status: '1'|'0', message, result: Row[] | string }. This module is keyed
// by BASE URL, not by chain: the EVM engine design notes, section 5 says the cost
// is per API family, not per chain, and chains.ts's `indexer?.baseUrl` is the
// only thing a caller needs to hand this factory. This file does not import
// chains.ts: it does not need to know what a chain is, only where to ask.
//
// ---------------------------------------------------------------------------
// (a) NUMBERS ARRIVE AS DECIMAL STRINGS, NOT JSON-RPC QUANTITIES.
//
//     Unlike rpc.ts's hex QUANTITY convention, this API sends plain decimal
//     text ("blockNumber":"49208124"). A value like "1.5" or "" is not a
//     smaller-than-expected number, it is not a number this API produces, so
//     the row it belongs to is skipped rather than guessed at (see (b)).
//
// (b) A BAD ROW IS SKIPPED, NOT A BAD RESPONSE.
//
//     One indexer quirk in one row (a missing field, an unparseable amount)
//     must not hide every other transaction the address actually has. Only a
//     required field failing to parse drops its row; the rest of the page is
//     still returned.
//
// (c) apikey NEVER APPEARS IN AN ERROR MESSAGE.
//
//     The query string that carries it is never echoed back into a thrown
//     message, on any path: transport failure, HTTP status, malformed body,
//     or a refusal/rate-limit answer from the indexer itself. Only the
//     method name ("indexer request failed: ...") and the node's own text
//     (length capped) ever appear, matching rpc.ts's rule (c).
//
// Environment: Chrome MV3 service worker and popup. fetch + AbortController
// only, no Node APIs, no dependency on rpc.ts or chains.ts.
// ---------------------------------------------------------------------------

/** Per HTTP request. Default 15 s: an indexer page is not on the critical
 *  path of a balance read, so this can afford to be more patient than
 *  rpc.ts's 10 s JSON-RPC default. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Default `offset` (page size), and its ceiling: the API's own documented
 *  maximum for this parameter. */
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

/** Length cap on any text this module did not write itself (node message,
 *  fetch failure string), so nothing unbounded reaches a log (see note (c)). */
const MAX_DETAIL = 200;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_RE = /^[0-9]+$/;
const RATE_LIMIT_RE = /max rate limit reached|max calls per sec|rate limit/i;
const NO_TRANSACTIONS_RE = /no transactions found/i;

export interface EtherscanIndexerOptions {
  /** e.g. 'https://base.blockscout.com/api' or 'https://api.etherscan.io/v2/api'. */
  baseUrl: string;
  /** When set, sent as `chainid=<n>` (Etherscan V2 multi-chain routing).
   *  Blockscout ignores an extra query parameter it does not recognise. */
  chainId?: number;
  /** When set, sent as `apikey=`. Never appears in any error text (note (c)). */
  apiKey?: string;
  /** Injected in tests; defaults to globalThis.fetch, bound to globalThis
   *  because an unbound fetch throws "Illegal invocation" in a browser. */
  fetchImpl?: typeof fetch;
  /** Per HTTP request. Default 15_000. */
  timeoutMs?: number;
  /** The `offset` query parameter: rows per page. Default 100, clamped to a
   *  maximum of 1000 (the API's own ceiling for this field). */
  pageSize?: number;
  /** Extra request headers for every GET. Used for the gateway's
   *  `X-Satori-Client` token when `baseUrl` is the gateway's indexer proxy
   *  (endpoints.ts, evmGatewayHeaders); empty against a public indexer, so no
   *  CORS preflight is provoked on a third-party host. Never carries a secret:
   *  the token is a public identifier, and note (c) still applies to anything
   *  echoed into an error. */
  headers?: Record<string, string>;
}

/**
 * A row of account/txlist: one transaction touching the address (native
 * value transfers, contract calls, incoming and outgoing). All amounts are
 * base units as bigint.
 */
export interface IndexedTx {
  /** 0x, lowercase. */
  hash: string;
  blockNumber: bigint;
  /** Unix ms (the API's `timeStamp` is seconds; multiplied by 1000 here). */
  timestamp: number;
  /** Lowercase 0x. */
  from: string;
  /** Lowercase 0x, or null when contract creation (the API sends ''). */
  to: string | null;
  /** Wei. */
  value: bigint;
  gasUsed: bigint;
  /** Effective gas price in wei, as the API reports it. */
  gasPrice: bigint;
  /** True when `isError === '1'` or `txreceipt_status === '0'`. Either field
   *  may be missing on the row; a missing field defaults to false, not to a
   *  skip. */
  isError: boolean;
  /** 0x hex calldata, '0x' when empty or absent. */
  input: string;
  /** The contract this transaction created, lowercase 0x, or null when it did
   *  not create one (including when the field is absent or malformed). */
  contractAddress: string | null;
  confirmations: bigint;
  /** L1 data fee on OP-stack chains, when the API reports it. Blockscout on
   *  Base does NOT report this on txlist, so this stays optional rather than
   *  defaulting to 0n, which would read as "no fee" instead of "not told". */
  l1Fee?: bigint;
}

/** A row of account/tokentx: one ERC-20 movement touching the address. */
export interface IndexedTokenTransfer {
  hash: string;
  blockNumber: bigint;
  timestamp: number;
  from: string;
  to: string;
  /** The token contract, lowercase 0x. */
  contractAddress: string;
  /** Token base units. */
  value: bigint;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimal: number;
  gasUsed: bigint;
  gasPrice: bigint;
  confirmations: bigint;
}

/**
 * Every way this client can fail to answer, distinguished so the UI can react
 * correctly (evm-rollout.md section 5's "done": an absent or rate-limited
 * indexer degrades to an honest message, never to a silent empty list).
 *
 * - 'unavailable': transport failure (HTTP non-2xx, a rejected fetch, a
 *   timeout, or a body that is not JSON). Nothing answered.
 * - 'refused': the indexer answered `status: '0'` for a reason that is not
 *   "no transactions" and not a rate limit (a retired endpoint, a plan
 *   restriction, an invalid key).
 * - 'malformed': the indexer answered, but not in the shape this client
 *   understands (not a JSON object, `result` missing when `status` says
 *   there should be rows, an unrecognised `status` value).
 * - 'rate-limited': the indexer said to slow down.
 */
export class EvmIndexerError extends Error {
  readonly reason: 'unavailable' | 'refused' | 'malformed' | 'rate-limited';
  /** The indexer's own text, when there was any, clipped to MAX_DETAIL. */
  readonly detail?: string;

  constructor(reason: EvmIndexerError['reason'], message: string, detail?: string) {
    super(message);
    this.name = 'EvmIndexerError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * One page of history OLDER than everything served so far, from either family
 * (owner, live testing 2026-08-25: "there is no pagination in activities, I
 * checked for USDT on EVM BNB"). Native transactions and token transfers come
 * back together, because both families answer them in ONE round trip when they
 * are asked for together and the caller wants both on the same page.
 */
export interface EvmOlderPage {
  txs: IndexedTx[];
  tokenTransfers: IndexedTokenTransfer[];
  /**
   * What to pass as `cursor` to get the page after this one, or NULL when the
   * source has nothing older. Opaque to every caller: each family encodes its
   * own paging state in it (Alchemy a `pageKey` per direction, an
   * Etherscan-shaped API a page number per list), and nothing above this
   * module may read or construct one.
   */
  cursor: string | null;
}

export interface EtherscanIndexer {
  readonly baseUrl: string;
  /**
   * Newest first (the request asks the API for `sort=desc`; this client does
   * not re-sort). `sinceBlock` (inclusive) limits the query with `startblock`.
   * Empty list when the API says "No transactions found" or answers an empty
   * `result` under `status: '0'`.
   */
  listTransactions(address: string, opts?: { sinceBlock?: bigint; page?: number }): Promise<IndexedTx[]>;
  listTokenTransfers(
    address: string,
    opts?: { sinceBlock?: bigint; page?: number; contract?: string },
  ): Promise<IndexedTokenTransfer[]>;
  /**
   * The newest block THIS indexer has indexed (`module=block&action=eth_block_number`),
   * or null when it cannot say (older Etherscan clones, a proxy that refuses
   * the action, a transport error). Compared with the chain's own tip by the
   * store, it tells "no transactions" apart from "the explorer is behind the
   * chain" (Epix's Blockscout was found 41k blocks behind on 2026-08-20; a
   * fresh deposit showed as a balance with an empty Activity). Never throws.
   */
  headBlock?(): Promise<bigint | null>;
  /**
   * One page of history OLDER than the newest page, newest first within the
   * page. `cursor` is what the previous call returned; omit it for the first
   * older page.
   *
   * OPTIONAL BY DESIGN: a source that cannot walk backwards simply does not
   * implement it, and the caller then says "this is as far as this chain's
   * history service goes" instead of offering a button that returns an empty
   * page. Absence is the honest answer, not an empty result.
   *
   * ONE ROUND TRIP per call, whatever the family: paging must not become a
   * burst at the gateway.
   */
  listOlder?(
    address: string,
    opts?: {
      cursor?: string;
      /**
       * The OLDEST block the caller already holds. Used only on the first page
       * (no cursor), and only by a source that can express "before this block":
       * without it, a source whose paging starts at its own newest page would
       * spend the user's first click re-serving rows already on screen.
       * Ignored where the API cannot take it (the Etherscan-shaped one, whose
       * page 1 IS the newest page, so its first older page is page 2).
       */
      beforeBlock?: bigint;
    },
  ): Promise<EvmOlderPage>;
}

// ---------------------------------------------------------------------------
// Small parsing helpers. Each one returns a sentinel for "could not parse"
// rather than throwing, so the row-level parsers below can decide what a
// missing or bad field means for THAT field (skip the row, or default).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cap text this module did not write itself (see note (c)). */
function clip(text: string, max = MAX_DETAIL): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (${text.length} chars)`;
}

/** Strict decimal-string -> bigint (note (a)). Rejects '', a sign, a decimal
 *  point, or anything that is not plain digits. */
function parseBigIntField(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** `timeStamp` (decimal seconds) -> unix ms. */
function parseTimestampMs(value: unknown): number | null {
  const seconds = parseBigIntField(value);
  if (seconds === null) return null;
  return Number(seconds) * 1000;
}

/** A decimal string that must additionally fit a safe `number` (tokenDecimal:
 *  small integers like 6 or 18, never large enough to need a bigint). */
function parseDecimalInt(value: unknown): number | null {
  const parsed = parseBigIntField(value);
  if (parsed === null) return null;
  const asNumber = Number(parsed);
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}

/** 0x + 64 hex digits, lowercased. Anything else is not a transaction hash. */
function parseHash(value: unknown): string | null {
  if (typeof value !== 'string' || !HASH_RE.test(value)) return null;
  return value.toLowerCase();
}

/** A required address field: must be a valid 0x + 40 hex string. */
function requireAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) return null;
  return value.toLowerCase();
}

/**
 * `to` on account/txlist: '' means contract creation (a real answer, not a
 * missing one). Three outcomes, not two: a valid address, `null` for '', or
 * `undefined` when the field is present but neither (garbage), which the
 * caller treats as an unparseable required field and skips the row.
 */
function parseToField(value: unknown): string | null | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === '') return null;
  if (!ADDRESS_RE.test(value)) return undefined;
  return value.toLowerCase();
}

/** An address field that is supplementary, not load-bearing: a missing or
 *  malformed value defaults to null rather than skipping the whole row.
 *  Used for txlist's `contractAddress`, which is empty on every row except a
 *  contract creation. */
function parseLenientAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || !ADDRESS_RE.test(value)) return null;
  return value.toLowerCase();
}

function parseIndexedTx(raw: unknown): IndexedTx | null {
  if (!isRecord(raw)) return null;

  const hash = parseHash(raw.hash);
  const blockNumber = parseBigIntField(raw.blockNumber);
  const timestamp = parseTimestampMs(raw.timeStamp);
  const from = requireAddress(raw.from);
  const to = parseToField(raw.to);
  const value = parseBigIntField(raw.value);
  const gasUsed = parseBigIntField(raw.gasUsed);
  const gasPrice = parseBigIntField(raw.gasPrice);
  const confirmations = parseBigIntField(raw.confirmations);

  if (
    hash === null ||
    blockNumber === null ||
    timestamp === null ||
    from === null ||
    to === undefined ||
    value === null ||
    gasUsed === null ||
    gasPrice === null ||
    confirmations === null
  ) {
    return null;
  }

  const isError = raw.isError === '1' || raw.txreceipt_status === '0';
  const input = typeof raw.input === 'string' && raw.input !== '' ? raw.input : '0x';
  const contractAddress = parseLenientAddress(raw.contractAddress);

  const tx: IndexedTx = {
    hash,
    blockNumber,
    timestamp,
    from,
    to,
    value,
    gasUsed,
    gasPrice,
    isError,
    input,
    contractAddress,
    confirmations,
  };
  if (raw.l1Fee !== undefined) {
    const l1Fee = parseBigIntField(raw.l1Fee);
    if (l1Fee !== null) tx.l1Fee = l1Fee;
  }
  return tx;
}

function parseIndexedTokenTransfer(raw: unknown): IndexedTokenTransfer | null {
  if (!isRecord(raw)) return null;

  const hash = parseHash(raw.hash);
  const blockNumber = parseBigIntField(raw.blockNumber);
  const timestamp = parseTimestampMs(raw.timeStamp);
  const from = requireAddress(raw.from);
  const to = requireAddress(raw.to);
  const contractAddress = requireAddress(raw.contractAddress);
  const value = parseBigIntField(raw.value);
  const tokenDecimal = parseDecimalInt(raw.tokenDecimal);
  const gasUsed = parseBigIntField(raw.gasUsed);
  const gasPrice = parseBigIntField(raw.gasPrice);
  const confirmations = parseBigIntField(raw.confirmations);

  if (
    hash === null ||
    blockNumber === null ||
    timestamp === null ||
    from === null ||
    to === null ||
    contractAddress === null ||
    value === null ||
    tokenDecimal === null ||
    gasUsed === null ||
    gasPrice === null ||
    confirmations === null
  ) {
    return null;
  }

  return {
    hash,
    blockNumber,
    timestamp,
    from,
    to,
    contractAddress,
    value,
    tokenSymbol: typeof raw.tokenSymbol === 'string' ? raw.tokenSymbol : '',
    tokenName: typeof raw.tokenName === 'string' ? raw.tokenName : '',
    tokenDecimal,
    gasUsed,
    gasPrice,
    confirmations,
  };
}

// ---------------------------------------------------------------------------
// Transport and envelope handling
// ---------------------------------------------------------------------------

/** One GET, aborted after `timeoutMs`. Returns the parsed JSON body, or
 *  throws EvmIndexerError('unavailable') on any transport-level failure. The
 *  status text and any response body are never included (note (c) and rpc.ts
 *  note (c): a non-2xx body can echo the request back). */
async function requestJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      const init: RequestInit = { method: 'GET', signal: controller.signal };
      // Only set `headers` when there is something to send: an empty object on
      // a cross-origin GET is harmless, but a header that is not there cannot
      // trigger a preflight against a public indexer.
      if (Object.keys(headers).length > 0) init.headers = headers;
      res = await fetchImpl(url, init);
    } catch (err) {
      if (timedOut) {
        throw new EvmIndexerError('unavailable', `indexer request failed: timeout after ${timeoutMs}ms`);
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new EvmIndexerError('unavailable', `indexer request failed: network error: ${clip(detail)}`);
    }
    if (res.status === 429) {
      // "Too Many Requests" is a rate limit at the HTTP layer (Blockscout
      // answers a burst this way, before any JSON): the same request a minute
      // later succeeds, so it is reported as such, not as "unreachable".
      throw new EvmIndexerError('rate-limited', 'indexer request failed: HTTP 429 (rate limited)');
    }
    if (!res.ok) {
      throw new EvmIndexerError('unavailable', `indexer request failed: HTTP ${res.status}`);
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new EvmIndexerError('unavailable', 'indexer request failed: response body is not JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply the {status, message, result} envelope rules and return the row
 * array, or throw the EvmIndexerError the shape calls for. See the class doc
 * on EvmIndexerError for what each reason means.
 */
async function requestRows(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<unknown[]> {
  const parsed = await requestJson(url, fetchImpl, timeoutMs, headers);

  if (!isRecord(parsed)) {
    throw new EvmIndexerError('malformed', 'indexer response malformed: not a JSON object');
  }

  const status = parsed.status;
  const message = typeof parsed.message === 'string' ? parsed.message : '';
  const result = parsed.result;

  if (status === '1') {
    if (!Array.isArray(result)) {
      throw new EvmIndexerError('malformed', 'indexer response malformed: result is not an array');
    }
    return result;
  }

  if (status === '0') {
    // Either signal is enough on its own: an empty result array is a real
    // "nothing here" answer even if the message text is unfamiliar, and a
    // "No transactions found" message is a real answer even from a family
    // that happens to send a non-array result alongside it.
    if (Array.isArray(result) && result.length === 0) return [];
    if (NO_TRANSACTIONS_RE.test(message)) return [];

    const resultText = typeof result === 'string' ? result : '';
    if (RATE_LIMIT_RE.test(resultText)) {
      const detail = clip(resultText);
      throw new EvmIndexerError('rate-limited', 'indexer rate limit reached', detail);
    }
    const detail = clip(resultText || message);
    throw new EvmIndexerError('refused', `indexer request refused: ${detail}`, detail);
  }

  throw new EvmIndexerError('malformed', 'indexer response malformed: unexpected status value');
}

/** Validates and lowercases an address BEFORE any network activity. Throws a
 *  plain Error, not EvmIndexerError: this is a caller mistake, not something
 *  the indexer said. */
function requireValidAddress(address: string): string {
  if (!ADDRESS_RE.test(address)) {
    throw new Error(`Not a valid EVM address: ${clip(address, 64)}`);
  }
  return address.toLowerCase();
}

/** This family's cursor: the next page number for each list, or null for a
 *  list that has already run out. Anything unreadable (a cursor from another
 *  build, or from the other family) reads as "start from the beginning of the
 *  older pages", which costs one repeated page and never a wrong one. */
function parsePageCursor(cursor: string | undefined): { tx: number | null; token: number | null } | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const v = JSON.parse(cursor) as unknown;
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const page = (x: unknown): number | null | undefined =>
      x === null ? null : typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 10_000 ? x : undefined;
    const tx = page(o.tx);
    const token = page(o.token);
    if (tx === undefined || token === undefined) return null;
    return { tx, token };
  } catch {
    return null;
  }
}

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.floor(pageSize));
}

class HttpEtherscanIndexer implements EtherscanIndexer {
  readonly baseUrl: string;

  private readonly chainId?: number;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly headers: Record<string, string>;

  constructor(opts: EtherscanIndexerOptions) {
    const impl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!impl) {
      throw new Error('No fetch implementation available (pass opts.fetchImpl).');
    }
    this.baseUrl = opts.baseUrl;
    this.chainId = opts.chainId;
    this.apiKey = opts.apiKey;
    this.fetchImpl = impl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pageSize = clampPageSize(opts.pageSize);
    this.headers = { ...(opts.headers ?? {}) };
  }

  async listTransactions(
    address: string,
    opts: { sinceBlock?: bigint; page?: number } = {},
  ): Promise<IndexedTx[]> {
    const normalized = requireValidAddress(address);
    const url = this.buildUrl('txlist', normalized, opts.page ?? 1, opts.sinceBlock);
    const rows = await requestRows(url, this.fetchImpl, this.timeoutMs, this.headers);
    const out: IndexedTx[] = [];
    for (const row of rows) {
      const tx = parseIndexedTx(row);
      if (tx) out.push(tx);
    }
    return out;
  }

  async listTokenTransfers(
    address: string,
    opts: { sinceBlock?: bigint; page?: number; contract?: string } = {},
  ): Promise<IndexedTokenTransfer[]> {
    const normalized = requireValidAddress(address);
    const contract = opts.contract !== undefined ? requireValidAddress(opts.contract) : undefined;
    const url = this.buildUrl('tokentx', normalized, opts.page ?? 1, opts.sinceBlock, contract);
    const rows = await requestRows(url, this.fetchImpl, this.timeoutMs, this.headers);
    const out: IndexedTokenTransfer[] = [];
    for (const row of rows) {
      const transfer = parseIndexedTokenTransfer(row);
      if (transfer) out.push(transfer);
    }
    return out;
  }

  /**
   * Older pages, by walking the API's own `page` parameter with `sort=desc`
   * and no `startblock`: page 1 is the newest `pageSize` rows (what the
   * ordinary refresh already showed), so the first older page is page 2.
   *
   * The two lists page INDEPENDENTLY — an address can have 400 native
   * transactions and 30 token transfers — so the cursor carries a page number
   * for each, and a list stops being asked for the moment it answers with less
   * than a full page. When BOTH have stopped there is nothing older and the
   * cursor comes back null.
   *
   * `endblock` is deliberately not used: the gateway's indexer proxy accepts
   * module/action/address/sort/page/offset/startblock/contractaddress and
   * nothing else, and a parameter it does not know is a 400, not a wider
   * query.
   */
  async listOlder(address: string, opts: { cursor?: string; beforeBlock?: bigint } = {}): Promise<EvmOlderPage> {
    // `beforeBlock` is deliberately unused here: this API's page 1 is the
    // newest page, so page 2 is already genuinely older, and the one parameter
    // that could express "before block N" (`endblock`) is not on the gateway
    // proxy's allow-list.
    const normalized = requireValidAddress(address);
    const state = parsePageCursor(opts.cursor) ?? { tx: 2, token: 2 };
    const [txs, tokenTransfers] = await Promise.all([
      state.tx === null ? Promise.resolve<IndexedTx[]>([]) : this.pageOfTransactions(normalized, state.tx),
      state.token === null ? Promise.resolve<IndexedTokenTransfer[]>([]) : this.pageOfTokenTransfers(normalized, state.token),
    ]);
    // A short page is the last one: ask for the next only while this one was
    // full. (An exactly-full last page costs one more request that answers
    // empty, which is the standard cost of a page-numbered API.)
    const nextTx = state.tx !== null && txs.length >= this.pageSize ? state.tx + 1 : null;
    const nextToken = state.token !== null && tokenTransfers.length >= this.pageSize ? state.token + 1 : null;
    return {
      txs,
      tokenTransfers,
      cursor: nextTx === null && nextToken === null ? null : JSON.stringify({ tx: nextTx, token: nextToken }),
    };
  }

  private async pageOfTransactions(address: string, page: number): Promise<IndexedTx[]> {
    const rows = await requestRows(this.buildUrl('txlist', address, page, undefined), this.fetchImpl, this.timeoutMs, this.headers);
    const out: IndexedTx[] = [];
    for (const row of rows) {
      const tx = parseIndexedTx(row);
      if (tx) out.push(tx);
    }
    return out;
  }

  private async pageOfTokenTransfers(address: string, page: number): Promise<IndexedTokenTransfer[]> {
    const rows = await requestRows(this.buildUrl('tokentx', address, page, undefined), this.fetchImpl, this.timeoutMs, this.headers);
    const out: IndexedTokenTransfer[] = [];
    for (const row of rows) {
      const transfer = parseIndexedTokenTransfer(row);
      if (transfer) out.push(transfer);
    }
    return out;
  }

  async headBlock(): Promise<bigint | null> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('module', 'block');
    url.searchParams.set('action', 'eth_block_number');
    if (this.chainId !== undefined) url.searchParams.set('chainid', String(this.chainId));
    if (this.apiKey !== undefined) url.searchParams.set('apikey', this.apiKey);
    try {
      const body = await requestJson(url.toString(), this.fetchImpl, this.timeoutMs, this.headers);
      // Blockscout answers this action in JSON-RPC shape: { jsonrpc, id, result: "0x.." }.
      // Etherscan proper does the same. A {status, result} envelope is
      // accepted too, in case a clone wraps it.
      const raw = (body as { result?: unknown } | null)?.result;
      if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) return null;
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  private buildUrl(
    action: 'txlist' | 'tokentx',
    address: string,
    page: number,
    sinceBlock: bigint | undefined,
    contract?: string,
  ): string {
    const url = new URL(this.baseUrl);
    const sp = url.searchParams;
    sp.set('module', 'account');
    sp.set('action', action);
    sp.set('address', address);
    if (contract !== undefined) sp.set('contractaddress', contract);
    sp.set('page', String(page));
    sp.set('offset', String(this.pageSize));
    sp.set('sort', 'desc');
    if (sinceBlock !== undefined) sp.set('startblock', sinceBlock.toString());
    if (this.chainId !== undefined) sp.set('chainid', String(this.chainId));
    if (this.apiKey !== undefined) sp.set('apikey', this.apiKey);
    return url.toString();
  }
}

/** Build a client for one base URL. Stateless apart from its configuration,
 *  so one per chain (or one shared instance for Etherscan V2, which routes by
 *  `chainid` on a single host) is the intended use. */
export function createEtherscanIndexer(opts: EtherscanIndexerOptions): EtherscanIndexer {
  return new HttpEtherscanIndexer(opts);
}
