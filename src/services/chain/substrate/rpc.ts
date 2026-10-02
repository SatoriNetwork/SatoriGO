// The Bittensor side of the Satori GO gateway, as seen from the page: one
// JSON-RPC object per POST to `<gateway>/tao/<set>`, and the runtime profile
// digest at `GET <gateway>/tao/<set>/runtime` (the Bittensor engine design
// notes §5.1, §7).
//
// There is no history route: owner decision 2026-09-28, no Taostats in v1.
// Activity is the sends this wallet recorded itself (historyClient.ts).
//
// Rules, the same ones monero/rpc.ts and evm/rpc.ts state for their traffic:
//   - One host. Every URL built here is under the gateway; nothing in this
//     directory names a Substrate node, so the relay's allowlist and node
//     failover are the only way a request reaches the chain.
//   - The client refuses, before any request, a method or runtime API the
//     gateway would drop (TAO_RPC_METHODS, TAO_STATE_CALLS): a typo fails in
//     a test, not as a 400 in front of a user.
//   - A request body (a signed extrinsic, a storage key) never appears in an
//     error message, and text from a node is length capped before it reaches
//     an Error.
//   - A submit that fails in transport, times out, or comes back 502/504 is
//     NOT known to be unsent (the gateway says so for a 504: "the extrinsic
//     may still be in the pool"). The error carries `maybeSent`, and the
//     caller settles it by nonce polling, never by sending again.

import { parseTaoRuntimeProfile, type TaoRuntimeProfile } from './profile';
import { GATEWAY_CLIENT_TOKEN, gatewayUrl } from '../../gateway';

/** The JSON-RPC methods the gateway relays (`TAO_RPC_METHODS` in
 *  gateway/server.mjs). Anything else is refused here without a request. */
export const TAO_RPC_METHODS: readonly string[] = Object.freeze([
  'system_properties',
  'system_chain',
  'state_getRuntimeVersion',
  'chain_getBlockHash',
  'chain_getFinalizedHead',
  'chain_getHeader',
  'chain_getBlock',
  'state_getStorage',
  'state_call',
  'system_accountNextIndex',
  'payment_queryInfo',
  'payment_queryFeeDetails',
  'author_submitExtrinsic',
]);

/** The runtime APIs `state_call` may name (params[0]), the gateway's second
 *  allowlist. */
export const TAO_STATE_CALLS: readonly string[] = Object.freeze([
  'TransactionPaymentApi_query_info',
  'TransactionPaymentApi_query_fee_details',
  'TaggedTransactionQueue_validate_transaction',
  'AccountNonceApi_account_nonce',
]);

/** The node set every wallet build uses. `test` exists on the gateway for the
 *  smoke only; the UI has no testnet. */
export const TAO_DEFAULT_NODE_SET = 'main';

/** Per request. The gateway gives each node 8 s and fails over across the
 *  set, so a slow first node plus a good second one takes about 10 s; a
 *  whole-set outage is refused by the gateway itself (502) well before this. */
const DEFAULT_TIMEOUT_MS = 25_000;
/** A block is a few hundred KB at most; the gateway caps answers at 512 KB. */
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const MAX_FOREIGN_TEXT = 200;

export type TaoRpcErrorCode =
  | 'refused-locally' // the method or params would be dropped by the gateway; no request was made
  | 'transport' // fetch threw (offline, DNS, TLS, connection reset)
  | 'timeout' // no answer within the client timeout
  | 'aborted' // the caller's signal fired
  | 'rate-limited' // HTTP 429
  | 'http' // any other non-2xx without a JSON-RPC answer
  | 'rpc' // a JSON-RPC error object from the node or the gateway
  | 'format'; // an answer that is not the JSON-RPC shape expected

export class TaoRpcError extends Error {
  readonly code: TaoRpcErrorCode;
  readonly method: string;
  /** HTTP status when there was one. */
  readonly status?: number;
  /** JSON-RPC error code when the answer carried one. */
  readonly rpcCode?: number;
  /** Only for `author_submitExtrinsic`: the request may have reached a node
   *  (transport failure after sending, a timeout, a gateway 502/504). The
   *  extrinsic can be in the pool; settle it by nonce, never re-send it. */
  readonly maybeSent: boolean;
  constructor(
    code: TaoRpcErrorCode,
    method: string,
    message: string,
    extra: { status?: number; rpcCode?: number; maybeSent?: boolean } = {},
  ) {
    super(message);
    this.name = 'TaoRpcError';
    this.code = code;
    this.method = method;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.rpcCode !== undefined) this.rpcCode = extra.rpcCode;
    this.maybeSent = extra.maybeSent === true;
  }
}

/** The runtime digest the gateway serves (§7.2), validated and typed: a
 *  `TaoRuntimeProfile` plus where it came from. */
export type TaoRuntimeDigest = TaoRuntimeProfile & { node: string; finalizedHeight: number };

export interface TaoRpc {
  /** POST `/tao/<set>`, one JSON-RPC object. Resolves the `result` (which can
   *  be `null`, e.g. an absent storage key); throws `TaoRpcError`. */
  call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T>;
  /** GET `/tao/<set>/runtime`: the profile digest computed by the gateway
   *  from the live v14 metadata (§4.4 level 2). */
  runtime(signal?: AbortSignal): Promise<TaoRuntimeDigest>;
  /** The node set this client talks to. */
  readonly nodeSet: string;
}

export interface TaoRpcOptions {
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Node-set names are one gateway path segment (the gateway enforces
 *  `/^[a-z0-9-]{1,32}$/` too). Anything else could climb out of `/tao/<set>`,
 *  so it is refused rather than URL-encoded. */
export function isValidTaoNodeSet(nodeSet: string): boolean {
  return typeof nodeSet === 'string' && /^[a-z0-9-]{1,32}$/.test(nodeSet);
}

function normalizeGateway(gatewayUrl: string): string {
  const raw = typeof gatewayUrl === 'string' ? gatewayUrl.trim().replace(/\/+$/, '') : '';
  if (!raw) throw new Error('Bittensor needs the Satori GO gateway, and this build has none configured.');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('The gateway URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    // A local gateway over http is allowed for development only.
    throw new Error('The gateway must be reached over https.');
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('The gateway URL must not carry a query, fragment or credentials.');
  }
  return raw;
}

/** `<gateway>/tao/<set>`: the relay URL, also the prefix of `/runtime`. */
export function taoGatewayBase(gatewayUrl: string, nodeSet: string = TAO_DEFAULT_NODE_SET): string {
  if (!isValidTaoNodeSet(nodeSet)) throw new Error(`Not a valid Bittensor node set name: "${String(nodeSet).slice(0, 40)}".`);
  return `${normalizeGateway(gatewayUrl)}/tao/${nodeSet}`;
}

function capText(text: unknown): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return s.length > MAX_FOREIGN_TEXT ? `${s.slice(0, MAX_FOREIGN_TEXT)}...` : s;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * The client-side copy of the gateway's allowlist (taoRequestAllowed): the
 * method, and for `state_call` the runtime API. Param SHAPES are left to the
 * gateway (it answers 400 with a reason); the ones checked here are the ones a
 * caller could get wrong silently: a missing extrinsic, a hash that is not one.
 * Returns the reason for a refusal, or null.
 */
export function taoCallRefusal(method: string, params: unknown[]): string | null {
  if (typeof method !== 'string' || !TAO_RPC_METHODS.includes(method)) {
    return `method not allowed: ${capText(method).slice(0, 64)}`;
  }
  if (!Array.isArray(params)) return 'params must be an array';
  if (method === 'state_call') {
    if (typeof params[0] !== 'string' || !TAO_STATE_CALLS.includes(params[0])) {
      return `state_call not allowed: ${typeof params[0] === 'string' ? params[0].slice(0, 64) : '?'}`;
    }
    if (typeof params[1] !== 'string' || !HEX_RE.test(params[1])) return 'state_call args must be 0x hex';
    if (params.length > 2 && (typeof params[2] !== 'string' || !HASH_RE.test(params[2]))) return 'state_call block must be a hash';
  }
  if (method === 'author_submitExtrinsic' || method === 'payment_queryInfo' || method === 'payment_queryFeeDetails') {
    if (typeof params[0] !== 'string' || !HEX_RE.test(params[0]) || params[0].length <= 2) return `${method} needs the extrinsic as 0x hex`;
  }
  if (method === 'chain_getBlock' && (typeof params[0] !== 'string' || !HASH_RE.test(params[0]))) {
    return 'chain_getBlock takes a block hash';
  }
  return null;
}

/** Joins the caller's signal and a timeout into one controller. */
function linkedAbort(signal: AbortSignal | undefined, timeoutMs: number): { ctrl: AbortController; done: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController();
  let timed = false;
  const timer = setTimeout(() => {
    timed = true;
    ctrl.abort();
  }, timeoutMs);
  const onOuter = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onOuter, { once: true });
  }
  return {
    ctrl,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuter);
    },
    timedOut: () => timed,
  };
}

let nextId = 1;

/**
 * A client for the gateway's `/tao/<set>` routes. `token` is the shared
 * client identifier sent as `X-Satori-Client` (not a secret: it ships in the
 * bundle); an empty token sends no header, and the gateway then authenticates
 * the extension by its Origin.
 */
export function taoRpc(gatewayUrl: string, token: string, nodeSet: string = TAO_DEFAULT_NODE_SET, opts: TaoRpcOptions = {}): TaoRpc {
  const base = taoGatewayBase(gatewayUrl, nodeSet);
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenHeader: Record<string, string> = token ? { 'X-Satori-Client': token } : {};

  async function request(
    method: string,
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    submit: boolean,
  ): Promise<{ status: number; ok: boolean; text: string }> {
    const link = linkedAbort(signal, timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: link.ctrl.signal, cache: 'no-store', credentials: 'omit' });
    } catch (e) {
      link.done();
      if (signal?.aborted) throw new TaoRpcError('aborted', method, `Bittensor request was cancelled (${method}).`, { maybeSent: submit });
      if (link.timedOut()) throw new TaoRpcError('timeout', method, `The Bittensor network did not answer in time (${method}).`, { maybeSent: submit });
      throw new TaoRpcError('transport', method, `The Bittensor network is unreachable (${method}): ${capText((e as Error)?.message)}`, {
        maybeSent: submit,
      });
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      link.done();
      const code: TaoRpcErrorCode = signal?.aborted ? 'aborted' : link.timedOut() ? 'timeout' : 'transport';
      throw new TaoRpcError(code, method, `The Bittensor answer was cut off (${method}).`, { status: res.status, maybeSent: submit });
    }
    link.done();
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new TaoRpcError('format', method, `The Bittensor answer is too large (${method}).`, { status: res.status });
    }
    return { status: res.status, ok: res.ok, text };
  }

  async function call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const refusal = taoCallRefusal(method, params);
    if (refusal) throw new TaoRpcError('refused-locally', String(method), `Bittensor request refused before sending: ${refusal}.`);
    const submit = method === 'author_submitExtrinsic';
    const id = nextId++;
    const { status, ok, text } = await request(
      method,
      base,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...tokenHeader },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      },
      signal,
      submit,
    );
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON: handled below */
    }
    const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const err = obj && obj.error && typeof obj.error === 'object' ? (obj.error as { code?: unknown; message?: unknown; data?: unknown }) : null;

    if (status === 429) {
      throw new TaoRpcError('rate-limited', method, 'The gateway is rate limiting Bittensor requests; try again in a moment.', { status });
    }
    // The gateway answers 502 when every node failed and 504 when a submit
    // timed out on its node. For a submit neither is proof of "not sent".
    if (submit && (status === 502 || status === 504 || status >= 500)) {
      throw new TaoRpcError(
        'http',
        method,
        status === 504
          ? 'The network did not confirm the transfer in time; it may still be pending.'
          : `The Bittensor gateway answered HTTP ${status} while sending; the transfer may still be pending.`,
        { status, maybeSent: true, ...(err && typeof err.code === 'number' ? { rpcCode: err.code } : {}) },
      );
    }
    if (err) {
      const rpcCode = typeof err.code === 'number' ? err.code : undefined;
      const data = typeof err.data === 'string' ? `: ${capText(err.data)}` : '';
      throw new TaoRpcError('rpc', method, `Bittensor node refused ${method}: ${capText(err.message)}${data}`, {
        status,
        ...(rpcCode !== undefined ? { rpcCode } : {}),
      });
    }
    if (!ok) throw new TaoRpcError('http', method, `The Bittensor gateway answered HTTP ${status} (${method}).`, { status });
    if (!obj || !('result' in obj)) {
      throw new TaoRpcError('format', method, `The Bittensor node sent something that is not a JSON-RPC answer (${method}).`, {
        status,
      });
    }
    if (obj.id !== id) throw new TaoRpcError('format', method, `The Bittensor answer does not match the request (${method}).`, { status });
    return obj.result as T;
  }

  async function runtime(signal?: AbortSignal): Promise<TaoRuntimeDigest> {
    const method = 'runtime';
    const { status, ok, text } = await request(method, `${base}/runtime`, { method: 'GET', headers: { ...tokenHeader } }, signal, false);
    if (status === 429) {
      throw new TaoRpcError('rate-limited', method, 'The gateway is rate limiting Bittensor requests; try again in a moment.', { status });
    }
    if (!ok) throw new TaoRpcError('http', method, `The Bittensor gateway answered HTTP ${status} (runtime).`, { status });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TaoRpcError('format', method, 'The Bittensor runtime digest is not JSON.', { status });
    }
    return parseRuntimeDigest(body);
  }

  return { call, runtime, nodeSet };
}

/** The client for this build's gateway and token (the values vite injects;
 *  see src/services/gateway.ts). Throws when the build has no gateway:
 *  Bittensor has no other route. */
export function defaultTaoRpc(nodeSet: string = TAO_DEFAULT_NODE_SET, opts: TaoRpcOptions = {}): TaoRpc {
  return taoRpc(gatewayUrl(), GATEWAY_CLIENT_TOKEN, nodeSet, opts);
}

/**
 * The gateway's `/runtime` JSON (§7.2) to a typed digest: Set A's strict
 * profile parser (profile.ts parseTaoRuntimeProfile; it refuses an extrinsic
 * version other than 4 or a balance other than u64 outright) plus where the
 * digest came from. Any shape problem is a `TaoRpcError('format')`, which the
 * runtime guard (reader.ts checkRuntime) treats as "layout changed".
 */
export function parseRuntimeDigest(body: unknown): TaoRuntimeDigest {
  let profile: TaoRuntimeProfile;
  try {
    profile = parseTaoRuntimeProfile(body);
  } catch (e) {
    throw new TaoRpcError('format', 'runtime', `The Bittensor runtime digest is not usable: ${capText((e as Error)?.message)}`);
  }
  const o = body as Record<string, unknown>;
  const node = typeof o.node === 'string' ? capText(o.node) : '';
  const h = o.finalizedHeight;
  const finalizedHeight = typeof h === 'number' && Number.isSafeInteger(h) && h >= 0 ? h : 0;
  return { ...profile, node, finalizedHeight };
}
