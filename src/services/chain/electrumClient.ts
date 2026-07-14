// Electrum-over-WebSocket (wss) transport client for the Evrmore wallet.
//
// Chrome MV3 / browser environment: uses the native `WebSocket` global (also
// present in Node 21+, which is how the tests exercise it). No 'ws' package, no
// Node APIs, CSP-safe, Uint8Array/strings only.
//
// Protocol: each JSON-RPC request is one text WebSocket message terminated with
// '\n'. Each response is a text message containing one JSON object — but we stay
// robust and split every inbound message on '\n', parsing each non-empty line as
// its own JSON-RPC frame. Replies are correlated to requests by their `id`;
// unsolicited subscription notifications (a `method`, no `id`) are ignored.

import {
  type ElectrumClient,
  type ElectrumBalance,
  type ElectrumHistoryItem,
  type ElectrumUtxo,
  type ElectrumServerVersion,
} from './electrumTypes';
import {
  getElectrumServerPool,
  electrumWssUrl,
  parseServerUrl,
  ELECTRUM_METHODS,
  type ElectrumEndpoint,
} from './network';

// Identifiers advertised in the server.version handshake.
const CLIENT_NAME = 'Satori-GO-Wallet';
const PROTOCOL_VERSION = '1.10';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface ElectrumClientOptions {
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Lets tests inject a mock; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  method: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | null;
  method?: string; // present on subscription notifications
  result?: unknown;
  error?: { code?: number; message?: string } | string | null;
}

export class WssElectrumClient implements ElectrumClient {
  /** Explicit server list captured at construction (used by unit tests). When
   *  null the live pool is resolved lazily at connect time (getElectrumServerPool)
   *  so user-configured servers added after startup are honoured. */
  private readonly explicitServers: ElectrumEndpoint[] | null;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly WebSocketImpl: typeof WebSocket;

  private ws: WebSocket | null = null;
  private url: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  /** In-flight connect promise, shared by concurrent connect() callers so they
   *  don't each open (and mutually close) a socket. */
  private connecting: Promise<void> | null = null;

  constructor(servers?: ElectrumEndpoint[], opts: ElectrumClientOptions = {}) {
    // An explicit array (as the tests pass) is used verbatim; with no argument
    // the pool is resolved live in doConnect() from getElectrumServerPool().
    this.explicitServers = servers ?? null;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const impl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!impl) {
      throw new Error('No WebSocket implementation available (pass opts.WebSocketImpl).');
    }
    this.WebSocketImpl = impl;
  }

  /** Connect if needed. Idempotent and concurrency-safe: an already-open client
   *  returns immediately, and concurrent callers share one in-flight attempt
   *  (otherwise each would open a socket and close the others' — which shows up
   *  as "WebSocket closed before the connection is established"). */
  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /** Try each configured server in order until one connects + handshakes. */
  private async doConnect(): Promise<void> {
    this.closed = false;
    const errors: string[] = [];
    // Resolve the pool lazily so servers the user configures AFTER startup are
    // honoured on the next connect. An explicit list (unit tests) is used as-is.
    const servers = this.explicitServers ?? getElectrumServerPool();
    for (const server of servers) {
      const url = electrumWssUrl(server);
      try {
        await this.connectTo(url);
        this.url = url;
        return;
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
        // Ensure a half-open socket from the failed attempt is torn down.
        this.teardownSocket();
      }
    }
    throw new Error(`All Electrum servers failed. ${errors.join('; ')}`);
  }

  /** Open one socket, wire handlers, run the server.version handshake. */
  private connectTo(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new this.WebSocketImpl(url);
      } catch (err) {
        reject(new Error(`WebSocket construction failed: ${(err as Error).message}`));
        return;
      }
      this.ws = ws;

      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`connect timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      ws.onmessage = (ev: MessageEvent) => this.onMessage(ev);

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(new Error('WebSocket error during connect'));
      };

      ws.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          reject(new Error('WebSocket closed during connect'));
          return;
        }
        // Closed after a successful handshake: fail any in-flight requests.
        this.onSocketClosed();
      };

      ws.onopen = () => {
        // Perform the handshake. Only after it resolves do we consider the
        // connection usable.
        this.handshake()
          .then(() => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            resolve();
          })
          .catch((err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            reject(new Error(`handshake failed: ${err.message}`));
          });
      };
    });
  }

  private async handshake(): Promise<ElectrumServerVersion> {
    const reply = await this.request<[string, string]>(ELECTRUM_METHODS.version, [
      CLIENT_NAME,
      PROTOCOL_VERSION,
    ]);
    // A valid reply looks like ["ElectrumX Evrmore 1.12","1.10"].
    if (!Array.isArray(reply) || reply.length < 2) {
      throw new Error(`unexpected server.version reply: ${JSON.stringify(reply)}`);
    }
    return { server: reply[0], protocol: reply[1] };
  }

  /** JSON-RPC call. Correlates the reply by id; rejects on error/timeout/close. */
  request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('Electrum client is closed'));
        return;
      }
      const ws = this.ws;
      if (!ws || ws.readyState !== this.WebSocketImpl.OPEN) {
        reject(new Error('Electrum client is not connected'));
        return;
      }

      const id = this.nextId++;
      const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`request timeout after ${this.requestTimeoutMs}ms (${method})`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });

      try {
        ws.send(JSON.stringify(payload) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`failed to send request (${method}): ${(err as Error).message}`));
      }
    });
  }

  private onMessage(ev: MessageEvent): void {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
    // A single message may hold multiple newline-delimited JSON objects.
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let frame: JsonRpcResponse;
      try {
        frame = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        // Non-JSON garbage: ignore rather than crash.
        continue;
      }
      this.dispatch(frame);
    }
  }

  private dispatch(frame: JsonRpcResponse): void {
    // Unsolicited subscription notification: a `method` and no numeric `id`.
    if (typeof frame.id !== 'number') {
      // Nothing to correlate; ignore safely (covers header/scripthash subs).
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return; // late/duplicate reply after timeout — ignore.
    this.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (frame.error != null) {
      pending.reject(new Error(`Electrum error: ${electrumErrorText(frame.error)}`));
      return;
    }
    pending.resolve(frame.result);
  }

  private onSocketClosed(): void {
    // Reject anything still in flight; the caller decides whether to reconnect.
    if (this.pending.size > 0) {
      this.rejectAllPending(new Error('WebSocket closed with request pending'));
    }
  }

  private rejectAllPending(err: Error): void {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of entries) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private teardownSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  /** Clear timers, reject pending, close the socket. Idempotent. */
  close(): void {
    if (this.closed) {
      // Still make sure any lingering socket is gone.
      this.teardownSocket();
      return;
    }
    this.closed = true;
    this.rejectAllPending(new Error('Electrum client closed'));
    this.teardownSocket();
    this.url = null;
  }

  isConnected(): boolean {
    return (
      !this.closed &&
      this.ws != null &&
      this.ws.readyState === this.WebSocketImpl.OPEN
    );
  }

  endpoint(): string | null {
    return this.isConnected() ? this.url : null;
  }
}

function electrumErrorText(error: NonNullable<JsonRpcResponse['error']>): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const { code, message } = error;
    if (message && code != null) return `${message} (code ${code})`;
    if (message) return message;
    if (code != null) return `code ${code}`;
  }
  return JSON.stringify(error);
}

// ---------------------------------------------------------------------------
// Factory + provider helpers

/** Default factory: a wss client over the Evrmore server pool. With no explicit
 *  `servers` the client resolves the LIVE pool (getElectrumServerPool) at connect
 *  time, so user-configured servers are picked up without recreating the client. */
export function createElectrumClient(
  servers?: ElectrumEndpoint[],
  opts?: ElectrumClientOptions,
): ElectrumClient {
  return new WssElectrumClient(servers, opts);
}

/** Health-check ONE server: connect over wss + fetch the block height. Returns
 *  online/offline plus the height and round-trip latency. Never throws — a bad
 *  URL, self-signed cert, timeout etc. all resolve to `{ online: false }`. */
export async function checkElectrumServer(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<{ online: boolean; height?: number; latencyMs?: number }> {
  const ep = parseServerUrl(url);
  if (!ep) return { online: false };
  const t = opts?.timeoutMs ?? 6000;
  const client = new WssElectrumClient([ep], { connectTimeoutMs: t, requestTimeoutMs: t });
  const start = Date.now();
  try {
    await client.connect();
    const header = await client.request<{ height: number }>(ELECTRUM_METHODS.headersSubscribe, []);
    return { online: true, height: header?.height, latencyMs: Date.now() - start };
  } catch {
    return { online: false };
  } finally {
    client.close();
  }
}

/** EVR (or a specific asset) balance for a scripthash. Passes `asset` as the
 *  2nd param only when provided. */
export function electrumGetBalance(
  client: ElectrumClient,
  scripthash: string,
  asset?: string,
): Promise<ElectrumBalance> {
  const params: unknown[] = asset === undefined ? [scripthash] : [scripthash, asset];
  return client.request<ElectrumBalance>(ELECTRUM_METHODS.getBalance, params);
}

/** Confirmed + mempool history for a scripthash. */
export function electrumGetHistory(
  client: ElectrumClient,
  scripthash: string,
): Promise<ElectrumHistoryItem[]> {
  return client.request<ElectrumHistoryItem[]>(ELECTRUM_METHODS.getHistory, [scripthash]);
}

/** Unspent outputs (EVR, or a specific asset when provided) for a scripthash. */
export function electrumListUnspent(
  client: ElectrumClient,
  scripthash: string,
  asset?: string,
): Promise<ElectrumUtxo[]> {
  const params: unknown[] = asset === undefined ? [scripthash] : [scripthash, asset];
  return client.request<ElectrumUtxo[]>(ELECTRUM_METHODS.listUnspent, params);
}

/** Raw transaction hex for a txid (non-verbose blockchain.transaction.get). The
 *  raw bytes let a caller recompute the txid and thus trust the tx's contents —
 *  used to verify prevout amounts before signing (see verifyInputAmounts). */
export function electrumGetRawTx(client: ElectrumClient, txHash: string): Promise<string> {
  return client.request<string>(ELECTRUM_METHODS.txGet, [txHash]);
}
