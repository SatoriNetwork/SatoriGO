// The Zcash side of the Satori GO gateway: a typed client for the small JSON
// API the gateway serves in front of public lightwalletd servers (the Zcash
// engine design notes §6 and §7). The wallet never speaks gRPC.
//
//   GET  <gateway>/zec/<set>/info
//   POST <gateway>/zec/<set>/{balance,utxos,txs,tx,mempool,send}
//
// Rules, the same ones monero/rpc.ts and evm/rpc.ts state for their traffic:
//   - One host. Every URL built here is under the gateway; a hosts pin can grep
//     this directory for anything else.
//   - A request body never appears in an error message (it carries the
//     wallet's addresses and, for /send, the signed transaction).
//   - Text from the gateway or the node is length capped before it reaches an
//     Error or a result.
//   - Amounts are bigint zat the moment they leave JSON; they travel as decimal
//     strings on the wire (int64) and are never a JS number.
//
// THE BROADCAST RULE (what the live gateway implements, 2026-09-28). A send
// that ran out of time (lightwalletd's DEADLINE_EXCEEDED or CANCELLED, or the
// gateway's own 90 s limit) answers HTTP 504: the transaction may already sit
// in a node's mempool, and the gateway does not try another server. The wallet
// must NOT send it again either: send() THROWS a ZcashRpcError with code
// 'unknown', and the caller records the send as pending and looks its txid up
// with /tx or /mempool (reader.ts resolveZcashSend, classifySend). The same
// holds when this client's own timeout fires after the request left, and when
// the node says it already has the transaction ("already queued for
// download"). Since 2026-10-02 the rule is wider: ANY failure once the request
// started is unknown, except the gateway's pre-flight refusal (a 4xx with
// stage 'precheck', no server dialled); the gateway itself answers 504 for any
// failure after the bytes went upstream, gRPC UNKNOWN included. So a RESOLVED
// send() is always the node's final word: ok, or a rejection that relayed
// nothing. The wallet always matches the txid it
// computed itself; it never parses one out of `errorMessage`.

import type { ZcashUtxo } from './builder';

/** Sapling activation: lightwalletd's block cache begins here, so no /txs
 *  query can reach below it (§6.3). */
export const ZCASH_HISTORY_FLOOR = 419200;
/** Most blocks one /txs call may span (the gateway's txsSpanMax). */
export const ZCASH_TXS_SPAN = 200_000;
/** Most addresses one balance/utxos/mempool call may carry (the gateway's
 *  addressesPerCall; the watch set is fifteen). */
export const ZCASH_ADDRESSES_PER_CALL = 20;
/** Most outpoints one mempool call considers (the gateway's outpointsMax). */
export const ZCASH_OUTPOINTS_PER_CALL = 1000;
/** Largest transaction the gateway relays (bytes). */
export const ZCASH_SEND_MAX_BYTES = 100 * 1024;

/** Reads: the gateway's upstream limit is 25 s, plus the tunnel. */
const READ_TIMEOUT_MS = 35_000;
/** A broadcast: the gateway waits up to 90 s for the node's answer (a missing
 *  input took about 61 s in the research), so this client waits longer than
 *  that, then reports the outcome as unknown rather than failed. */
const SEND_TIMEOUT_MS = 100_000;
const MAX_FOREIGN_TEXT = 200;

export interface ZcashInfo {
  chainName: string;
  height: number;
  estimatedHeight: number;
  /** The CURRENT consensus branch ID, as a u32. Never hardcoded anywhere in the
   *  wallet (§4.1): every signature commits to it, and it changes at each
   *  network upgrade. */
  consensusBranchId: number;
  /** The next scheduled upgrade's name and activation height, when the server
   *  announces one (0 / '' otherwise). */
  upgradeName: string;
  upgradeHeight: number;
  taddrSupport: boolean;
}

export interface ZcashMempoolTx {
  txid: string;
  vin: { txid: string; index: number }[];
  vout: { valueZat: bigint; script: string }[];
}

/** A broadcast's FINAL answer: `ok` is the node's errorCode 0; anything else
 *  is a rejection (nothing relayed). An outcome that is not final (a timeout,
 *  or the node already had the transaction) never resolves here: send()
 *  throws ZcashRpcError code 'unknown' instead. */
export interface ZcashSendResult {
  ok: boolean;
  errorCode: number;
  errorMessage: string;
}

export interface ZcashRpc {
  info(signal?: AbortSignal): Promise<ZcashInfo>;
  balance(addresses: string[], signal?: AbortSignal): Promise<bigint>;
  utxos(
    addresses: string[],
    startHeight?: number,
    signal?: AbortSignal,
  ): Promise<{ utxos: Omit<ZcashUtxo, 'coinbase'>[]; truncated: boolean }>;
  txs(
    address: string,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<{ txs: { hex: string; height: number }[]; truncated: boolean; resumeFrom: number | null }>;
  /** height 0 = in the mempool, -1 = on a side chain; null when no server knows the txid. */
  tx(txid: string, signal?: AbortSignal): Promise<{ hex: string; height: number } | null>;
  mempool(addresses: string[], outpoints: string[], signal?: AbortSignal): Promise<ZcashMempoolTx[]>;
  send(hex: string, signal?: AbortSignal): Promise<ZcashSendResult>;
}

/** Why a gateway call failed. `code`:
 *   unknown   send() only: the transaction MAY have been relayed (any
 *             failure once the request started: no answer, a timeout, any
 *             5xx, a 4xx that is not the gateway's pre-flight refusal, an
 *             unreadable answer; or the node already has it). Never send
 *             again; record it as pending and look the txid up.
 *   network   no answer at all (offline, DNS, TLS)
 *   timeout   no answer in time (reads only; a send throws unknown instead)
 *   aborted   the caller cancelled
 *   http      the gateway answered a non-2xx status (see `status`)
 *   format    the answer was not the shape this op returns
 *   refused   the request was refused before any server was asked (400) or the
 *             server set is wrong (a chain that is not mainnet) */
export class ZcashRpcError extends Error {
  readonly code: 'unknown' | 'network' | 'timeout' | 'aborted' | 'http' | 'format' | 'refused';
  readonly status?: number;
  constructor(code: ZcashRpcError['code'], message: string, status?: number) {
    super(message);
    this.name = 'ZcashRpcError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// ---------------------------------------------------------------------------
// URL and headers
// ---------------------------------------------------------------------------

/** Node-set names are one gateway path segment, the pattern the gateway
 *  enforces. Anything else could climb out of `/zec/<set>/`, so it is refused
 *  rather than URL-encoded. */
export function isValidZcashNodeSet(nodeSet: string): boolean {
  return typeof nodeSet === 'string' && /^[a-z0-9-]{1,32}$/.test(nodeSet);
}

/** The gateway base without a trailing slash; throws when there is none.
 *  Zcash has no fallback host: without the gateway there is no server. */
function normalizeGateway(gatewayUrl: string): string {
  const raw = typeof gatewayUrl === 'string' ? gatewayUrl.trim().replace(/\/+$/, '') : '';
  if (!raw) throw new Error('Zcash needs the Satori GO gateway, and this build has none configured.');
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
  if (parsed.search || parsed.hash) throw new Error('The gateway URL must not carry a query or fragment.');
  return raw;
}

/** `<gateway>/zec/<set>`: the prefix every op goes under (§7). */
export function zcashGatewayBase(gatewayUrl: string, nodeSet: string = 'main'): string {
  if (!isValidZcashNodeSet(nodeSet)) throw new Error(`Not a valid Zcash node set name: "${String(nodeSet).slice(0, 40)}".`);
  return `${normalizeGateway(gatewayUrl)}/zec/${nodeSet}`;
}

/** Headers for a gateway request: the client token when there is one (the
 *  gateway authenticates by it; not a secret, it ships in the bundle), and a
 *  JSON content type on a POST. */
export function zcashGatewayHeaders(clientToken: string, post: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (post) headers['content-type'] = 'application/json';
  if (clientToken) headers['X-Satori-Client'] = clientToken;
  return headers;
}

function capText(text: unknown): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  let clean = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    clean += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return clean.length > MAX_FOREIGN_TEXT ? `${clean.slice(0, MAX_FOREIGN_TEXT)}...` : clean;
}

// ---------------------------------------------------------------------------
// Shape checks, split out so the tests can drive them without a network
// ---------------------------------------------------------------------------

const TXID_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^(?:[0-9a-f]{2})*$/;
const T_ADDRESS_RE = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;
const INT64_MAX = (1n << 63n) - 1n;

function formatError(op: string, what: string): ZcashRpcError {
  return new ZcashRpcError('format', `The Zcash gateway's answer to ${op} ${what}.`);
}

function isHeight(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff;
}

/** A non-negative int64 decimal string, as bigint. */
function zatOf(v: unknown, op: string): bigint {
  if (typeof v !== 'string' || !/^[0-9]{1,19}$/.test(v)) throw formatError(op, 'had an amount that is not a decimal string');
  const n = BigInt(v);
  if (n > INT64_MAX) throw formatError(op, 'had an amount out of range');
  return n;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A /info answer. Refuses anything that is not mainnet with transparent
 *  support and a sane branch ID: a misconfigured server set must never hand
 *  a mainnet wallet another chain's tip or branch ID to sign with. */
export function parseZcashInfo(body: unknown): ZcashInfo {
  const o = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (typeof o.chainName !== 'string') throw formatError('info', 'had no chain name');
  if (o.chainName !== 'main') throw new ZcashRpcError('refused', `The Zcash server is on "${capText(o.chainName)}", not mainnet.`);
  if (o.taddrSupport !== true) throw new ZcashRpcError('refused', 'The Zcash server does not serve transparent addresses.');
  if (typeof o.consensusBranchId !== 'string' || !/^[0-9a-fA-F]{8}$/.test(o.consensusBranchId)) {
    throw formatError('info', 'had no valid consensus branch ID');
  }
  const consensusBranchId = parseInt(o.consensusBranchId, 16) >>> 0;
  if (consensusBranchId === 0) throw formatError('info', 'had a zero consensus branch ID');
  if (!isHeight(o.height) || o.height <= ZCASH_HISTORY_FLOOR) throw formatError('info', 'had no valid height');
  const estimatedHeight = isHeight(o.estimatedHeight) ? o.estimatedHeight : o.height;
  const upgradeHeight = isHeight(o.upgradeHeight) ? o.upgradeHeight : 0;
  const upgradeName = typeof o.upgradeName === 'string' ? capText(o.upgradeName).slice(0, 40) : '';
  return {
    chainName: 'main',
    height: o.height,
    estimatedHeight,
    consensusBranchId,
    upgradeName,
    upgradeHeight,
    taddrSupport: true,
  };
}

export function parseZcashBalance(body: unknown): bigint {
  const o = (body ?? {}) as { zat?: unknown };
  return zatOf(o.zat, 'balance');
}

export function parseZcashUtxos(
  body: unknown,
  requested: readonly string[],
): { utxos: Omit<ZcashUtxo, 'coinbase'>[]; truncated: boolean } {
  const o = (body ?? {}) as { utxos?: unknown; truncated?: unknown };
  if (!Array.isArray(o.utxos)) throw formatError('utxos', 'had no list');
  const asked = new Set(requested);
  const seen = new Set<string>();
  const utxos: Omit<ZcashUtxo, 'coinbase'>[] = [];
  for (const raw of o.utxos) {
    const u = (raw ?? {}) as Record<string, unknown>;
    if (typeof u.address !== 'string' || !asked.has(u.address)) throw formatError('utxos', 'named an address that was not asked for');
    if (typeof u.txid !== 'string' || !TXID_RE.test(u.txid)) throw formatError('utxos', 'had a malformed txid');
    if (!isHeight(u.index)) throw formatError('utxos', 'had a malformed output index');
    if (typeof u.script !== 'string' || !HEX_RE.test(u.script) || u.script.length === 0 || u.script.length > 20_000) {
      throw formatError('utxos', 'had a malformed script');
    }
    if (!isHeight(u.height) || u.height === 0) throw formatError('utxos', 'had a malformed height');
    const valueZat = zatOf(u.valueZat, 'utxos');
    const key = `${u.txid}:${u.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    utxos.push({ txid: u.txid, index: u.index, valueZat, script: hexToBytes(u.script), height: u.height, address: u.address });
  }
  return { utxos, truncated: o.truncated === true };
}

export function parseZcashTxs(
  body: unknown,
  start: number,
  end: number,
): { txs: { hex: string; height: number }[]; truncated: boolean; resumeFrom: number | null } {
  const o = (body ?? {}) as { txs?: unknown; truncated?: unknown; resumeFrom?: unknown };
  if (!Array.isArray(o.txs)) throw formatError('txs', 'had no list');
  const txs: { hex: string; height: number }[] = [];
  for (const raw of o.txs) {
    const t = (raw ?? {}) as Record<string, unknown>;
    if (typeof t.hex !== 'string' || !HEX_RE.test(t.hex) || t.hex.length < 8) throw formatError('txs', 'had a malformed transaction');
    if (!isHeight(t.height) || t.height < start || t.height > end) throw formatError('txs', 'had a transaction outside the asked range');
    txs.push({ hex: t.hex, height: t.height });
  }
  const truncated = o.truncated === true;
  let resumeFrom: number | null = null;
  if (truncated) {
    if (!isHeight(o.resumeFrom) || o.resumeFrom < start || o.resumeFrom > end) throw formatError('txs', 'was cut without a valid resume height');
    resumeFrom = o.resumeFrom;
  }
  return { txs, truncated, resumeFrom };
}

export function parseZcashTxAnswer(body: unknown): { hex: string; height: number } {
  const o = (body ?? {}) as { hex?: unknown; height?: unknown };
  if (typeof o.hex !== 'string' || !HEX_RE.test(o.hex) || o.hex.length < 8) throw formatError('tx', 'had no transaction');
  if (o.height !== -1 && !isHeight(o.height)) throw formatError('tx', 'had no valid height');
  return { hex: o.hex, height: o.height as number };
}

export function parseZcashMempool(body: unknown): ZcashMempoolTx[] {
  const o = (body ?? {}) as { txs?: unknown };
  if (!Array.isArray(o.txs)) throw formatError('mempool', 'had no list');
  const out: ZcashMempoolTx[] = [];
  for (const raw of o.txs) {
    const t = (raw ?? {}) as Record<string, unknown>;
    if (typeof t.txid !== 'string' || !TXID_RE.test(t.txid)) throw formatError('mempool', 'had a malformed txid');
    if (!Array.isArray(t.vin) || !Array.isArray(t.vout)) throw formatError('mempool', 'had a malformed transaction');
    const vin = t.vin.map((i: unknown) => {
      const x = (i ?? {}) as Record<string, unknown>;
      if (typeof x.txid !== 'string' || !TXID_RE.test(x.txid) || !isHeight(x.index)) throw formatError('mempool', 'had a malformed input');
      return { txid: x.txid, index: x.index };
    });
    const vout = t.vout.map((v: unknown) => {
      const x = (v ?? {}) as Record<string, unknown>;
      if (typeof x.script !== 'string' || !HEX_RE.test(x.script)) throw formatError('mempool', 'had a malformed output');
      return { valueZat: zatOf(x.valueZat, 'mempool'), script: x.script };
    });
    out.push({ txid: t.txid, vin, vout });
  }
  return out;
}

/** Messages a node gives for a transaction it ALREADY has (a resend, or a
 *  first send that the gateway's timeout cut short). Not a rejection: the
 *  transaction may confirm, so the outcome is unknown, never "failed". */
const ALREADY_KNOWN_RE = /already (?:queued|in (?:the )?(?:mempool|block ?chain))|txn-already|already have transaction|already known/i;

/** A /send answer. Throws ZcashRpcError 'unknown' when the node says it
 *  already has the transaction. */
export function parseZcashSend(body: unknown): ZcashSendResult {
  const o = (body ?? {}) as { ok?: unknown; errorCode?: unknown; errorMessage?: unknown };
  if (typeof o.errorCode !== 'number' || !Number.isSafeInteger(o.errorCode)) throw formatError('send', 'had no error code');
  const errorMessage = capText(typeof o.errorMessage === 'string' ? o.errorMessage : '');
  const ok = o.errorCode === 0;
  if (!ok && ALREADY_KNOWN_RE.test(errorMessage)) throw sendUnknown('The network already has this transaction. It may still go through.');
  return { ok, errorCode: o.errorCode, errorMessage };
}

/** The gateway's own refusal before any server was dialled (bad body, rate
 *  limit, unknown set): `{ error, stage: 'precheck' }`. */
function isPrecheckRefusal(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { stage?: unknown }).stage === 'precheck';
}

function sendUnknown(message: string, status?: number): ZcashRpcError {
  return new ZcashRpcError('unknown', message, status);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type Op = 'info' | 'balance' | 'utxos' | 'txs' | 'tx' | 'mempool' | 'send';

interface RawAnswer {
  status: number;
  body: unknown;
}

async function call(
  base: string,
  token: string,
  op: Op,
  payload: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RawAnswer> {
  const post = op !== 'info';
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    let res: Response;
    try {
      res = await fetch(`${base}/${op}`, {
        method: post ? 'POST' : 'GET',
        headers: zcashGatewayHeaders(token, post),
        ...(post ? { body: JSON.stringify(payload) } : {}),
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (e) {
      if (timedOut) throw new ZcashRpcError('timeout', `The Zcash gateway did not answer in time (${op}).`);
      if (ctrl.signal.aborted) throw new ZcashRpcError('aborted', `The Zcash request was cancelled (${op}).`);
      throw new ZcashRpcError('network', `The Zcash gateway is unreachable (${op}): ${capText((e as Error)?.message)}`);
    }
    let body: unknown = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      if (timedOut) throw new ZcashRpcError('timeout', `The Zcash gateway did not answer in time (${op}).`);
      if (ctrl.signal.aborted) throw new ZcashRpcError('aborted', `The Zcash request was cancelled (${op}).`);
      if (res.ok) throw formatError(op, 'was not JSON');
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

function httpError(op: Op, answer: RawAnswer): ZcashRpcError {
  const detail = (answer.body as { error?: unknown } | null)?.error;
  const text = typeof detail === 'string' && detail ? `: ${capText(detail)}` : '';
  if (answer.status === 400) return new ZcashRpcError('refused', `The Zcash gateway refused the ${op} request${text}`, 400);
  if (answer.status === 429) return new ZcashRpcError('http', `The Zcash gateway is busy, try again in a moment (${op}).`, 429);
  return new ZcashRpcError('http', `The Zcash gateway answered HTTP ${answer.status} (${op})${text}`, answer.status);
}

function checkAddresses(op: Op, addresses: readonly string[]): string[] {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > ZCASH_ADDRESSES_PER_CALL) {
    throw new ZcashRpcError('refused', `${op}: 1 to ${ZCASH_ADDRESSES_PER_CALL} addresses per call.`);
  }
  for (const a of addresses) {
    if (typeof a !== 'string' || !T_ADDRESS_RE.test(a)) throw new ZcashRpcError('refused', `${op}: not a transparent mainnet address.`);
  }
  return [...new Set(addresses)];
}

/**
 * A client for `<gatewayUrl>/zec/<nodeSet>`. `token` is the gateway client
 * token (gatewayClientToken() in the extension). Throws synchronously on a
 * missing or malformed gateway URL or node set, so a misconfigured build fails
 * at construction rather than on the first refresh.
 */
export function zcashRpc(gatewayUrl: string, token: string, nodeSet: string = 'main'): ZcashRpc {
  const base = zcashGatewayBase(gatewayUrl, nodeSet);
  const tok = typeof token === 'string' ? token : '';
  const read = async (op: Op, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const answer = await call(base, tok, op, payload, signal, READ_TIMEOUT_MS);
    if (answer.status < 200 || answer.status > 299) throw httpError(op, answer);
    return answer.body;
  };

  return {
    async info(signal) {
      return parseZcashInfo(await read('info', undefined, signal));
    },

    async balance(addresses, signal) {
      return parseZcashBalance(await read('balance', { addresses: checkAddresses('balance', addresses) }, signal));
    },

    async utxos(addresses, startHeight, signal) {
      const list = checkAddresses('utxos', addresses);
      if (startHeight !== undefined && !isHeight(startHeight)) throw new ZcashRpcError('refused', 'utxos: startHeight must be a block height.');
      const payload: Record<string, unknown> = { addresses: list };
      if (startHeight) payload.startHeight = startHeight;
      return parseZcashUtxos(await read('utxos', payload, signal), list);
    },

    async txs(address, start, end, signal) {
      checkAddresses('txs', [address]);
      if (!isHeight(start) || !isHeight(end) || start < 1 || end < start || end - start > ZCASH_TXS_SPAN) {
        throw new ZcashRpcError('refused', `txs: 1 <= start <= end and a span of at most ${ZCASH_TXS_SPAN} blocks.`);
      }
      return parseZcashTxs(await read('txs', { address, start, end }, signal), start, end);
    },

    async tx(txid, signal) {
      const id = typeof txid === 'string' ? txid.toLowerCase() : '';
      if (!TXID_RE.test(id)) throw new ZcashRpcError('refused', 'tx: a txid is 64 hex characters.');
      const answer = await call(base, tok, 'tx', { txid: id }, signal, READ_TIMEOUT_MS);
      if (answer.status === 404) return null;
      if (answer.status < 200 || answer.status > 299) throw httpError('tx', answer);
      return parseZcashTxAnswer(answer.body);
    },

    async mempool(addresses, outpoints, signal) {
      const list = checkAddresses('mempool', addresses);
      const ops = [...new Set(Array.isArray(outpoints) ? outpoints : [])].map((o) => String(o).toLowerCase());
      if (ops.length > ZCASH_OUTPOINTS_PER_CALL) {
        throw new ZcashRpcError('refused', `mempool: at most ${ZCASH_OUTPOINTS_PER_CALL} outpoints per call.`);
      }
      for (const o of ops) {
        if (!/^[0-9a-f]{64}:\d{1,5}$/.test(o)) throw new ZcashRpcError('refused', 'mempool: outpoints are "txid:index".');
      }
      const payload: Record<string, unknown> = { addresses: list };
      if (ops.length) payload.outpoints = ops;
      return parseZcashMempool(await read('mempool', payload, signal));
    },

    async send(hex, signal) {
      const h = typeof hex === 'string' ? hex.toLowerCase() : '';
      if (!/^(?:[0-9a-f]{2})+$/.test(h) || h.length < 8) throw new ZcashRpcError('refused', 'send: the transaction is not hex.');
      if (h.length > 2 * ZCASH_SEND_MAX_BYTES) throw new ZcashRpcError('refused', 'send: the transaction is too large.');
      const header = h.slice(0, 8);
      if (header !== '05000080' && header !== '06000080') {
        throw new ZcashRpcError('refused', 'send: only v5 or v6 transactions are relayed.');
      }
      // From here on the request may have left. Only two answers are a
      // definite "nothing was relayed": the node's own verdict (HTTP 200 with
      // a non-zero errorCode that is not "already have it", parseZcashSend),
      // and the gateway's pre-flight refusal (a 4xx whose body says stage
      // 'precheck': no server was dialled). EVERYTHING else (no answer, our
      // timeout, any 5xx, any other 4xx, an unreadable answer) is unknown, so
      // nothing above this ever sends a second copy.
      let answer: RawAnswer;
      try {
        answer = await call(base, tok, 'send', { hex: h }, signal, SEND_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof ZcashRpcError && e.code === 'timeout') {
          throw sendUnknown('No answer from the network in time. The transaction may still go through.');
        }
        throw sendUnknown('The connection to the network failed after the send started. The transaction may still go through.');
      }
      if (answer.status >= 200 && answer.status <= 299) {
        try {
          return parseZcashSend(answer.body);
        } catch (e) {
          if (e instanceof ZcashRpcError && e.code === 'unknown') throw e;
          throw sendUnknown('The network answer could not be read. The transaction may still go through.', answer.status);
        }
      }
      if (answer.status >= 400 && answer.status <= 499 && isPrecheckRefusal(answer.body)) throw httpError('send', answer);
      if (answer.status === 504) {
        throw sendUnknown('The network took too long to answer. The transaction may still go through.', 504);
      }
      throw sendUnknown(`The gateway answered HTTP ${answer.status}. The transaction may still go through.`, answer.status);
    },
  };
}
