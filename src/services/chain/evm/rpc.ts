// JSON-RPC 2.0 over HTTPS for EVM chains (phase 2 of the EVM rollout,
// the EVM rollout plan, section 3, "read only").
//
// This is the only place in the EVM engine that talks to a network. Everything
// above it (erc20.ts, evmProvider.ts, later fees/nonce/send) goes through
// EvmRpcClient, so the rules below are stated once, here.
//
// ---------------------------------------------------------------------------
// (a) TWO KINDS OF FAILURE, AND THEY ARE NOT INTERCHANGEABLE.
//
//     EvmRpcError is an answer. The node received the request, understood it,
//     and said no: a revert, a bad parameter, an unsupported method. Retrying
//     it on a second endpoint returns the same no, so failing over would only
//     double the load on public infrastructure and delay the message the user
//     needs to see. It is thrown immediately.
//
//     EvmRpcUnavailableError means NOBODY answered: every endpoint failed at
//     the transport level (fetch rejected, timed out, answered non-2xx, sent
//     something that is not JSON, sent a reply whose id we never asked for, or
//     turned out to be serving a different chain). The UI reads this as
//     "offline for this chain" and degrades, exactly as the Electrum side
//     already degrades when a server pool is unreachable. It carries one
//     {url, reason} per endpoint so a support question has an answer.
//
// (b) A CHAIN IS VERIFIED BEFORE IT IS READ FROM.
//
//     eth_chainId goes to an endpoint before the first real request does, and
//     an endpoint whose answer is not this chain's id is struck off for the
//     life of the client. A hijacked DNS entry, a copy-pasted URL from another
//     network, or a provider that silently repoints a hostname would otherwise
//     hand this wallet balances from a chain the user is not looking at, and
//     in phase 3 would receive a signed transaction built for a different fee
//     market. EIP-155 stops that transaction being replayable, but it does not
//     stop us from sending it to the wrong place.
//
// (c) A REQUEST BODY NEVER APPEARS IN AN ERROR MESSAGE.
//
//     From phase 3 the body of a call can be a signed transaction
//     (eth_sendRawTransaction), and error text ends up in logs and in bug
//     reports. Every message this module builds carries the METHOD NAME and
//     the REASON, never the params. The one string that comes from outside is
//     the node's own error message, which is the reason itself; it is length
//     capped so a node that echoes a large payload back cannot smuggle one in.
//
// Environment: Chrome MV3 service worker and popup. fetch + AbortController
// only, no Node APIs, no WebSocket, no dependencies.
// ---------------------------------------------------------------------------

import { type EvmChain } from './chains';
import { evmGatewayHeaders } from './endpoints';

/** Per HTTP request, not per call: a call that fails over to a second endpoint
 *  gets a fresh budget there. Chosen to match the Electrum client's connect
 *  timeout rather than its request timeout, because an unreachable public RPC
 *  is the common case and the user is waiting on a balance. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Length cap on any text this module did not write itself (see note (c)). */
const MAX_FOREIGN_TEXT = 200;

/** How many method names an EvmRpcUnavailableError names for a failed batch
 *  before it summarises the rest. */
const BATCH_LABEL_NAMES = 4;

export interface EvmRpcOptions {
  /** Injected in tests; defaults to globalThis.fetch, bound to globalThis
   *  because an unbound fetch throws "Illegal invocation" in a browser. */
  fetchImpl?: typeof fetch;
  /** Per HTTP request. Default 10_000. */
  timeoutMs?: number;
  /** Clock for latency measurement. Default Date.now. */
  now?: () => number;
  /** Sleep used between rate-limit retries. Injected in tests; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Endpoints to use INSTEAD of `chain.rpc` (same order-for-failover rule):
   *  endpoints.ts puts a keyed provider first when the build has a key. */
  endpoints?: readonly string[];
}

/** Backoff between retries of a rate-limited request, on the same endpoint. */
const RATE_LIMIT_BACKOFF_MS: readonly number[] = Object.freeze([600, 1500]);

/**
 * A JSON-RPC error that says "slow down" rather than "no". Public RPCs answer
 * a burst with -32016 "over rate limit" (Base) or -32005 "limit exceeded"
 * (BSC, Infura-style); the request itself was fine and the same request a
 * moment later succeeds. Note (a) says a JSON-RPC error is an answer, and it is,
 * except this one: it is the ONLY error class retried, and only a few times.
 */
function isRateLimited(err: EvmRpcError): boolean {
  if (err.code === -32016 || err.code === -32005) return true;
  return /rate limit|too many requests|limit exceeded/i.test(err.message);
}

/**
 * A JSON-RPC error object returned BY the node: a definitive answer (a revert,
 * bad params, an unknown method). NOT a failover trigger, see note (a).
 *
 * `message` is composed as "<method> failed: <code> <node message>". The
 * params are deliberately absent from it (note (c)).
 */
export class EvmRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method: string;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method} failed: ${code} ${message}`);
    this.name = 'EvmRpcError';
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

/** One endpoint's failure, as recorded on EvmRpcUnavailableError. */
export interface EvmRpcAttempt {
  url: string;
  reason: string;
}

/**
 * Every endpoint failed at the transport level. The UI treats this as offline
 * for the chain, never as "the balance is zero" and never as a crash.
 */
export class EvmRpcUnavailableError extends Error {
  readonly attempts: ReadonlyArray<EvmRpcAttempt>;

  constructor(label: string, attempts: EvmRpcAttempt[]) {
    const detail = attempts.map((a) => `${a.url} (${a.reason})`).join('; ');
    super(`No EVM RPC endpoint answered ${label}: ${detail}`);
    this.name = 'EvmRpcUnavailableError';
    this.attempts = Object.freeze(attempts.slice());
  }
}

export interface EvmRpcCall {
  method: string;
  params?: unknown[];
}

/** One entry of a batch result. A per-item JSON-RPC error is data here, not a
 *  throw: one reverting eth_call in a batch of twenty balances must not lose
 *  the other nineteen. */
export type EvmRpcBatchResult = { ok: true; result: unknown } | { ok: false; error: EvmRpcError };

export interface EvmRpcClient {
  readonly chain: EvmChain;
  /** One JSON-RPC call. Resolves with the node's `result` (which may legitimately
   *  be null), throws EvmRpcError when the node refuses, throws
   *  EvmRpcUnavailableError when no endpoint answered. */
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** One HTTP round trip carrying a JSON-RPC array. Results come back IN THE
   *  ORDER OF `calls` (they are matched by id, because a server may reorder
   *  them). A per-item JSON-RPC error is an ok:false entry, never a throw; a
   *  transport failure throws EvmRpcUnavailableError for the whole batch. An
   *  empty input resolves to [] without any HTTP request. */
  batch(calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]>;
  /** The endpoint currently in use, or null before the first successful call. */
  activeEndpoint(): string | null;
  /** Latency (ms) of the most recent successful HTTP round trip, or null. */
  lastLatencyMs(): number | null;
}

// ---------------------------------------------------------------------------
// Quantity and data helpers (JSON-RPC hex conventions)
//
// Strict on the way in, canonical on the way out. Ethereum's JSON-RPC spec
// gives QUANTITY exactly one encoding (0x, then hex digits, no leading zeros,
// with zero written '0x0') and DATA exactly one (0x, then an even number of
// hex digits). Accepting sloppier forms would mean this wallet reads a value a
// second implementation reads differently, which on a balance is a wrong
// number on screen and on a nonce is a stuck transaction.
// ---------------------------------------------------------------------------

/** '0x' + hex digits, no leading zeros, zero is exactly '0x0'. */
const QUANTITY_RE = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
/** '0x' + an even number of hex digits ('0x' alone means no data). */
const DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

/** Cap and label text this module did not write (a node message, a fetch
 *  failure string, a rejected hex value), so nothing unbounded reaches a log. */
function clip(text: string, max = MAX_FOREIGN_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (${text.length} chars)`;
}

/**
 * Encode a non-negative integer as a JSON-RPC QUANTITY.
 * A `number` must be a SAFE integer: 2**60 is an integer but not an exact one,
 * and silently encoding an inexact gas limit or value is how a wallet sends
 * the wrong amount. Pass a bigint for anything large.
 */
export function toQuantity(n: bigint | number): string {
  let value: bigint;
  if (typeof n === 'number') {
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `Cannot encode ${String(n)} as a quantity: expected a safe integer (use a bigint)`,
      );
    }
    value = BigInt(n);
  } else {
    value = n;
  }
  if (value < 0n) {
    throw new Error(`Cannot encode ${value.toString()} as a quantity: negative`);
  }
  return `0x${value.toString(16)}`;
}

/**
 * Decode a JSON-RPC QUANTITY. Requires a string, the '0x' prefix, at least one
 * hex digit, and no leading zeros (except '0x0' itself). Throws on anything
 * else, including a number: a node that answers 8453 instead of '0x2105' is
 * not speaking this protocol, and guessing on its behalf hides that.
 */
export function fromQuantity(hex: unknown): bigint {
  if (typeof hex !== 'string') {
    throw new Error(`Not a JSON-RPC quantity: expected a string, got ${typeof hex}`);
  }
  if (!QUANTITY_RE.test(hex)) {
    throw new Error(`Not a JSON-RPC quantity: ${clip(hex, 24)}`);
  }
  return BigInt(hex);
}

/** Encode bytes as JSON-RPC DATA: '0x' + even-length lowercase hex. Empty
 *  input gives '0x', which is what an empty calldata field must be. */
export function toHexData(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Decode JSON-RPC DATA. Requires a string, the '0x' prefix, an even number of
 *  hex digits (0 allowed), and nothing but hex digits. An odd length is the
 *  interesting rejection: half a byte means the value was truncated somewhere. */
export function fromHexData(hex: unknown): Uint8Array {
  if (typeof hex !== 'string') {
    throw new Error(`Not JSON-RPC data: expected a string, got ${typeof hex}`);
  }
  if (!DATA_RE.test(hex)) {
    throw new Error(`Not JSON-RPC data: ${clip(hex, 24)}`);
  }
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * A failure of the TRANSPORT, meaning this endpoint told us nothing usable.
 * Deliberately a private class rather than a bare Error: the failover loop
 * catches this and only this, so a genuine bug in the parsing below surfaces
 * as a bug instead of being laundered into "the network is down".
 */
class TransportFailure extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TransportFailure';
  }
}

type JsonRpcOutcome = { ok: true; result: unknown } | { ok: false; error: EvmRpcError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build an EvmRpcError from whatever sits in a response's `error` field.
 *  Tolerant on shape (some nodes send a bare string) but never re-classifies
 *  a refusal as a transport failure: the node answered, and that answer is the
 *  user's answer. */
function toRpcError(method: string, raw: unknown): EvmRpcError {
  if (isRecord(raw)) {
    const code = typeof raw.code === 'number' ? raw.code : 0;
    const message = typeof raw.message === 'string' ? raw.message : 'unspecified JSON-RPC error';
    return new EvmRpcError(method, code, clip(message), raw.data);
  }
  const message = typeof raw === 'string' ? raw : 'unspecified JSON-RPC error';
  return new EvmRpcError(method, 0, clip(message));
}

/** Validate one JSON-RPC response object against the id we sent. Throws
 *  TransportFailure when it is not a usable reply at all. */
function readResponse(node: unknown, id: number, method: string): JsonRpcOutcome {
  if (!isRecord(node)) {
    throw new TransportFailure('response is not a JSON-RPC object');
  }
  if (node.id !== id) {
    throw new TransportFailure('response id does not match the request');
  }
  if (node.error !== undefined && node.error !== null) {
    return { ok: false, error: toRpcError(method, node.error) };
  }
  // `result: null` is a real answer (eth_getTransactionReceipt for a hash the
  // node has not seen), so presence of the key is what counts, not its value.
  if (!('result' in node)) {
    throw new TransportFailure('response carries neither result nor error');
  }
  return { ok: true, result: node.result };
}

/** What an EvmRpcUnavailableError calls the work that failed. Method names
 *  only: params never appear (note (c)). */
function batchLabel(calls: EvmRpcCall[]): string {
  const names = calls.slice(0, BATCH_LABEL_NAMES).map((c) => c.method);
  if (calls.length > names.length) names.push(`+${calls.length - names.length} more`);
  return `for batch [${names.join(', ')}]`;
}

class HttpEvmRpcClient implements EvmRpcClient {
  readonly chain: EvmChain;

  private readonly endpoints: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Ids are unique per client and increasing, so a reply from a previous,
   *  timed-out request can never be mistaken for the current one. */
  private nextId = 1;
  /** Sticky endpoint index: once one answers we keep using it, and only a
   *  transport failure moves us off it. */
  private activeIndex: number | null = null;
  private latencyMs: number | null = null;
  /** Endpoints whose chain id matched. Checked once per endpoint per client. */
  private readonly verified = new Set<number>();
  /** Endpoints that answered eth_chainId with a DIFFERENT chain. Never used
   *  again by this client: that is a misconfiguration or an attack, and
   *  neither gets a second chance within one session. */
  private readonly wrongChain = new Set<number>();
  /** In-flight chain check per endpoint, shared by concurrent callers so two
   *  overlapping first calls send one eth_chainId, not two. */
  private readonly chainChecks = new Map<number, Promise<void>>();

  constructor(chain: EvmChain, opts: EvmRpcOptions = {}) {
    const endpoints = opts.endpoints ?? chain.rpc;
    if (endpoints.length === 0) {
      throw new Error(`EVM chain ${chain.key} has no RPC endpoints configured`);
    }
    const impl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!impl) {
      throw new Error('No fetch implementation available (pass opts.fetchImpl).');
    }
    this.chain = chain;
    this.endpoints = endpoints;
    this.fetchImpl = impl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  activeEndpoint(): string | null {
    return this.activeIndex === null ? null : this.endpoints[this.activeIndex];
  }

  lastLatencyMs(): number | null {
    return this.latencyMs;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const outcome = await this.withEndpoint(`for ${method}`, (url) =>
      this.retryingRateLimits(
        () => this.roundTripSingle(url, method, params),
        (o) => (!o.ok && isRateLimited(o.error) ? o.error : null),
      ),
    );
    // The endpoint answered, so it is sticky either way; only now does a
    // refusal become the caller's problem.
    if (!outcome.ok) throw outcome.error;
    return outcome.result as T;
  }

  async batch(calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> {
    if (calls.length === 0) return [];
    return this.withEndpoint(batchLabel(calls), (url) =>
      this.retryingRateLimits(
        () => this.roundTripBatch(url, calls),
        (results) => {
          const hit = results.find((r) => !r.ok && isRateLimited(r.error));
          return hit && !hit.ok ? hit.error : null;
        },
      ),
    );
  }

  /**
   * Run `exec`; when its answer is a rate limit (per `limited`), wait and try
   * the same endpoint again, up to RATE_LIMIT_BACKOFF_MS.length times. Still
   * limited after that: a TransportFailure, so withEndpoint moves to the next
   * endpoint (or reports every endpoint as unavailable). A rate limit is the
   * one JSON-RPC error that is not an answer about the request.
   */
  private async retryingRateLimits<T>(
    exec: () => Promise<T>,
    limited: (out: T) => EvmRpcError | null,
  ): Promise<T> {
    // A rate limit arrives either as a JSON-RPC error object (public nodes:
    // -32016 / -32005) or as HTTP 429 with no usable body (Alchemy: "exceeded
    // its compute units per second capacity"). Both mean "again in a moment",
    // on the SAME endpoint: failing over from a keyed provider to a public
    // node on a throughput blip would trade a 1-second wait for a worse node.
    const attempt = async (): Promise<{ out: T; limitedBy: string | null }> => {
      try {
        const out = await exec();
        const err = limited(out);
        return { out, limitedBy: err ? err.message : null };
      } catch (err) {
        if (err instanceof TransportFailure && err.message.startsWith('HTTP 429')) {
          return { out: undefined as T, limitedBy: err.message };
        }
        throw err;
      }
    };
    let last = await attempt();
    for (const backoff of RATE_LIMIT_BACKOFF_MS) {
      if (last.limitedBy === null) return last.out;
      await this.sleep(backoff);
      last = await attempt();
    }
    if (last.limitedBy !== null) throw new TransportFailure(`rate limited: ${clip(last.limitedBy)}`);
    return last.out;
  }

  /**
   * The failover loop: verify the chain, run the work, and on a transport
   * failure move to the next endpoint and try the same work there. Endpoints
   * are visited in chain.rpc order starting at the sticky one and wrapping
   * around, so every url is attempted exactly once and every url appears in
   * the attempts list if the whole loop fails.
   */
  private async withEndpoint<T>(label: string, exec: (url: string) => Promise<T>): Promise<T> {
    const attempts: EvmRpcAttempt[] = [];
    for (const index of this.candidateOrder()) {
      const url = this.endpoints[index];
      if (this.wrongChain.has(index)) {
        attempts.push({
          url,
          reason: `struck off: serves a chain id other than ${this.chain.chainId}`,
        });
        continue;
      }
      try {
        await this.verifyChain(index);
      } catch (err) {
        if (!(err instanceof TransportFailure)) throw err;
        attempts.push({ url, reason: err.message });
        this.unstick(index);
        continue;
      }
      try {
        const out = await exec(url);
        this.activeIndex = index;
        return out;
      } catch (err) {
        // EvmRpcError never reaches here (a refusal is returned as data by
        // both round trips), so anything that is not a TransportFailure is a
        // bug and is allowed out unchanged.
        if (!(err instanceof TransportFailure)) throw err;
        attempts.push({ url, reason: err.message });
        this.unstick(index);
      }
    }
    throw new EvmRpcUnavailableError(label, attempts);
  }

  /** Sticky endpoint first, then the rest in registry order, wrapping. */
  private candidateOrder(): number[] {
    const start = this.activeIndex ?? 0;
    const order: number[] = [];
    for (let k = 0; k < this.endpoints.length; k++) {
      order.push((start + k) % this.endpoints.length);
    }
    return order;
  }

  private unstick(index: number): void {
    if (this.activeIndex === index) this.activeIndex = null;
  }

  /**
   * eth_chainId before the first real request reaches this endpoint. Concurrent
   * callers share one in-flight check; a verified endpoint is not re-checked
   * for the life of the client, and a wrong one is never checked again either
   * because withEndpoint skips it outright.
   */
  private verifyChain(index: number): Promise<void> {
    if (this.verified.has(index)) return Promise.resolve();
    const inFlight = this.chainChecks.get(index);
    if (inFlight) return inFlight;
    // The stored promise is the one carrying the cleanup, so the map entry is
    // gone before any awaiter resumes and a later call retries a fresh check
    // rather than re-reading a settled failure.
    const started = this.checkChain(index).finally(() => {
      this.chainChecks.delete(index);
    });
    this.chainChecks.set(index, started);
    void started.catch(() => undefined);
    return started;
  }

  private async checkChain(index: number): Promise<void> {
    const outcome = await this.roundTripSingle(this.endpoints[index], 'eth_chainId', []);
    if (!outcome.ok) {
      // A node that refuses eth_chainId cannot be verified, so it cannot be
      // read from. That is this endpoint's failure, not the caller's answer:
      // reporting "eth_chainId is not supported" for an eth_getBalance would
      // be a lie about which call failed.
      throw new TransportFailure(`chain check refused: ${outcome.error.message}`);
    }
    let seen: bigint;
    try {
      seen = fromQuantity(outcome.result);
    } catch {
      throw new TransportFailure('chain check answered with a malformed quantity');
    }
    if (seen !== BigInt(this.chain.chainId)) {
      this.wrongChain.add(index);
      this.unstick(index);
      throw new TransportFailure(
        `wrong chain: endpoint serves chain id ${seen.toString()}, expected ${this.chain.chainId}`,
      );
    }
    this.verified.add(index);
  }

  private async roundTripSingle(
    url: string,
    method: string,
    params: unknown[],
  ): Promise<JsonRpcOutcome> {
    const id = this.nextId++;
    const body = { jsonrpc: '2.0', id, method, params };
    return readResponse(await this.post(url, body), id, method);
  }

  private async roundTripBatch(url: string, calls: EvmRpcCall[]): Promise<EvmRpcBatchResult[]> {
    const ids = calls.map(() => this.nextId++);
    const body = calls.map((c, i) => ({
      jsonrpc: '2.0',
      id: ids[i],
      method: c.method,
      params: c.params ?? [],
    }));
    const parsed = await this.post(url, body);
    if (!Array.isArray(parsed)) {
      throw new TransportFailure('batch response is not an array');
    }
    // Match by id, never by position: JSON-RPC explicitly allows a server to
    // answer a batch in any order, and reading them positionally would return
    // one address's balance under another address.
    const requested = new Set(ids);
    const byId = new Map<number, unknown>();
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.id !== 'number') {
        throw new TransportFailure('batch response carries an entry without a numeric id');
      }
      if (!requested.has(item.id)) {
        throw new TransportFailure('batch response carries an id that was not requested');
      }
      if (byId.has(item.id)) {
        throw new TransportFailure('batch response repeats an id');
      }
      byId.set(item.id, item);
    }
    return calls.map((c, i) => {
      const item = byId.get(ids[i]);
      if (item === undefined) {
        throw new TransportFailure('batch response is missing a requested id');
      }
      return readResponse(item, ids[i], c.method);
    });
  }

  /**
   * One HTTP POST, aborted after timeoutMs. Returns the parsed JSON body, or
   * throws TransportFailure with a reason that never contains the request body
   * (note (c)): not on a network error, not on a non-2xx status (whose response
   * text is dropped precisely because a node may echo the request into it), and
   * not on unparseable JSON.
   */
  private async post(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const started = this.now();
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          // evmGatewayHeaders() adds X-Satori-Client only in a gateway build
          // (where every endpoint IS the gateway); it is {} for dev builds, so
          // no custom header reaches a third-party public RPC.
          headers: { 'content-type': 'application/json', ...evmGatewayHeaders() },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) throw new TransportFailure(`timeout after ${this.timeoutMs}ms`);
        const detail = err instanceof Error ? err.message : String(err);
        throw new TransportFailure(`network error: ${clip(detail)}`);
      }
      if (!res.ok) {
        throw new TransportFailure(`HTTP ${res.status}`);
      }
      let parsed: unknown;
      try {
        parsed = (await res.json()) as unknown;
      } catch {
        throw new TransportFailure('response body is not JSON');
      }
      this.latencyMs = this.now() - started;
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build a client for one chain. Cheap and stateless apart from the sticky
 * endpoint, the per-endpoint chain verification and the id counter, so one
 * client per chain kept for the session is the intended use: a fresh client
 * per call would re-run eth_chainId every time.
 */
export function createEvmRpcClient(chain: EvmChain, opts?: EvmRpcOptions): EvmRpcClient {
  return new HttpEvmRpcClient(chain, opts);
}
