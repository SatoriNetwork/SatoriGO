import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WssElectrumClient,
  createElectrumClient,
  electrumGetBalance,
  electrumListUnspent,
} from './electrumClient';
import {
  PUBLIC_ELECTRUM_SERVERS,
  electrumWssUrl,
  ELECTRUM_METHODS,
} from './network';

// ---------------------------------------------------------------------------
// Mock WebSocket
//
// A scriptable, event-driven stand-in for the native WebSocket: each instance
// registers itself in `instances`, tests drive its lifecycle via emitOpen()/
// emitMessage()/emitError()/emitClose(), and captured `sent` frames let tests
// assert on the exact JSON payloads the client transmitted.
// ---------------------------------------------------------------------------

type OnFn = ((ev: unknown) => void) | null;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  // Populated per test run so each `new MockWebSocket()` is observable.
  static instances: MockWebSocket[] = [];
  /** If set, thrown from the constructor to simulate a synchronous open error. */
  static throwOnConstruct = false;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: OnFn = null;
  onmessage: OnFn = null;
  onerror: OnFn = null;
  onclose: OnFn = null;

  constructor(url: string) {
    if (MockWebSocket.throwOnConstruct) {
      throw new Error('boom');
    }
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
  }

  // --- test drivers -------------------------------------------------------
  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitError(): void {
    this.onerror?.({} as Event);
  }

  emitClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  /** Last request the client actually sent, parsed from JSON. */
  lastSent(): { id: number; method: string; params: unknown[] } {
    const raw = this.sent[this.sent.length - 1];
    return JSON.parse(raw.trim());
  }

  sentAt(i: number): { id: number; method: string; params: unknown[] } {
    return JSON.parse(this.sent[i].trim());
  }
}

const MockWSImpl = MockWebSocket as unknown as typeof WebSocket;

/** Reply frame for the server.version handshake matching a given request id. */
function versionReply(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: ['ElectrumX Evrmore 1.12', '1.10'],
  });
}

/** Wait for microtasks to flush so the client can register its next request. */
function flush(): Promise<void> {
  return Promise.resolve();
}

beforeEach(() => {
  MockWebSocket.instances = [];
  MockWebSocket.throwOnConstruct = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WssElectrumClient.connect', () => {
  it('1. performs the server.version handshake and resolves; endpoint() is the first server url', async () => {
    const client = new WssElectrumClient(PUBLIC_ELECTRUM_SERVERS, {
      WebSocketImpl: MockWSImpl,
    });
    const connecting = client.connect();

    // One socket to the first server.
    await flush();
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe(electrumWssUrl(PUBLIC_ELECTRUM_SERVERS[0]));

    ws.emitOpen();
    await flush(); // let onopen fire the handshake request

    const handshake = ws.lastSent();
    expect(handshake.method).toBe(ELECTRUM_METHODS.version);
    expect(handshake.params).toEqual(['Satori-GO-Wallet', '1.10']);

    ws.emitMessage(versionReply(handshake.id));
    await connecting;

    expect(client.isConnected()).toBe(true);
    expect(client.endpoint()).toBe(electrumWssUrl(PUBLIC_ELECTRUM_SERVERS[0]));
    client.close();
  });

  it('2. fails over to the second server when the first errors on open', async () => {
    const client = new WssElectrumClient(PUBLIC_ELECTRUM_SERVERS, {
      WebSocketImpl: MockWSImpl,
    });
    const connecting = client.connect();

    await flush();
    const first = MockWebSocket.instances[0];
    expect(first.url).toBe(electrumWssUrl(PUBLIC_ELECTRUM_SERVERS[0]));
    first.emitError(); // first server fails during connect

    await flush();
    // Client should have opened a socket to the second server.
    const second = MockWebSocket.instances[1];
    expect(second.url).toBe(electrumWssUrl(PUBLIC_ELECTRUM_SERVERS[1]));

    second.emitOpen();
    await flush();
    second.emitMessage(versionReply(second.lastSent().id));
    await connecting;

    expect(client.endpoint()).toBe(electrumWssUrl(PUBLIC_ELECTRUM_SERVERS[1]));
    client.close();
  });
});

/** Connect a client and return the live mock socket, ready for requests. */
async function connectedClient(opts?: {
  requestTimeoutMs?: number;
}): Promise<{ client: WssElectrumClient; ws: MockWebSocket }> {
  const client = new WssElectrumClient(PUBLIC_ELECTRUM_SERVERS, {
    WebSocketImpl: MockWSImpl,
    requestTimeoutMs: opts?.requestTimeoutMs,
  });
  const connecting = client.connect();
  await flush();
  const ws = MockWebSocket.instances[0];
  ws.emitOpen();
  await flush();
  ws.emitMessage(versionReply(ws.lastSent().id));
  await connecting;
  return { client, ws };
}

describe('WssElectrumClient.request', () => {
  it('3. correlates replies by id, including out-of-order concurrent requests', async () => {
    const { client, ws } = await connectedClient();

    const pA = client.request<string>('a.method');
    const pB = client.request<string>('b.method');
    await flush();

    const reqA = ws.sentAt(ws.sent.length - 2);
    const reqB = ws.sentAt(ws.sent.length - 1);
    expect(reqA.id).not.toBe(reqB.id);

    // Reply to B first, then A — out of order.
    ws.emitMessage(JSON.stringify({ jsonrpc: '2.0', id: reqB.id, result: 'B-result' }));
    ws.emitMessage(JSON.stringify({ jsonrpc: '2.0', id: reqA.id, result: 'A-result' }));

    await expect(pA).resolves.toBe('A-result');
    await expect(pB).resolves.toBe('B-result');
    client.close();
  });

  it('4. rejects with the electrum error text on an error reply', async () => {
    const { client, ws } = await connectedClient();

    const p = client.request('bad.method');
    await flush();
    const { id } = ws.lastSent();
    ws.emitMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'method not found' },
      }),
    );

    await expect(p).rejects.toThrow(/method not found/);
    client.close();
  });

  it('5. times out and rejects when no reply arrives within requestTimeoutMs', async () => {
    vi.useFakeTimers();
    const client = new WssElectrumClient(PUBLIC_ELECTRUM_SERVERS, {
      WebSocketImpl: MockWSImpl,
      requestTimeoutMs: 25,
    });
    const connecting = client.connect();
    await flush();
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    await flush();
    ws.emitMessage(versionReply(ws.lastSent().id));
    await connecting;

    const p = client.request('slow.method');
    // Attach rejection assertion before advancing timers to avoid unhandled reject.
    const assertion = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    client.close();
  });

  it('6. ignores unsolicited notifications without resolving/rejecting a pending request', async () => {
    const { client, ws } = await connectedClient();

    const p = client.request<string>('watch.method');
    await flush();
    const { id } = ws.lastSent();

    // Subscription-style notification: has a method, no id.
    expect(() =>
      ws.emitMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'blockchain.headers.subscribe',
          params: [{ height: 123, hex: 'deadbeef' }],
        }),
      ),
    ).not.toThrow();

    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();
    await flush();
    expect(settled).toBe(false);

    // The real reply still resolves the request afterward.
    ws.emitMessage(JSON.stringify({ jsonrpc: '2.0', id, result: 'ok' }));
    await expect(p).resolves.toBe('ok');
    client.close();
  });

  it('7. close() rejects in-flight requests and is safe to call twice', async () => {
    const { client, ws } = await connectedClient();
    void ws;

    const p = client.request('inflight.method');
    const assertion = expect(p).rejects.toThrow(/closed/i);

    client.close();
    expect(() => client.close()).not.toThrow(); // idempotent

    await assertion;
    expect(client.isConnected()).toBe(false);
    expect(client.endpoint()).toBeNull();
  });
});

describe('electrum helpers', () => {
  it('8. electrumGetBalance sends asset as the 2nd param only when provided', async () => {
    const { client, ws } = await connectedClient();

    // Without asset.
    const p1 = electrumGetBalance(client, 'SCRIPTHASH');
    await flush();
    const req1 = ws.lastSent();
    expect(req1.method).toBe(ELECTRUM_METHODS.getBalance);
    expect(req1.params).toEqual(['SCRIPTHASH']);
    ws.emitMessage(
      JSON.stringify({ jsonrpc: '2.0', id: req1.id, result: { confirmed: 1, unconfirmed: 0 } }),
    );
    await expect(p1).resolves.toEqual({ confirmed: 1, unconfirmed: 0 });

    // With asset.
    const p2 = electrumGetBalance(client, 'SCRIPTHASH', 'SATORI');
    await flush();
    const req2 = ws.lastSent();
    expect(req2.params).toEqual(['SCRIPTHASH', 'SATORI']);
    ws.emitMessage(
      JSON.stringify({ jsonrpc: '2.0', id: req2.id, result: { confirmed: 5, unconfirmed: 0 } }),
    );
    await expect(p2).resolves.toEqual({ confirmed: 5, unconfirmed: 0 });

    // listunspent mirrors the same asset-param behavior.
    const p3 = electrumListUnspent(client, 'SCRIPTHASH', 'SATORI');
    await flush();
    expect(ws.lastSent().params).toEqual(['SCRIPTHASH', 'SATORI']);
    ws.emitMessage(JSON.stringify({ jsonrpc: '2.0', id: ws.lastSent().id, result: [] }));
    await expect(p3).resolves.toEqual([]);

    client.close();
  });

  it('9. createElectrumClient returns a working client instance', () => {
    const client = createElectrumClient(PUBLIC_ELECTRUM_SERVERS, { WebSocketImpl: MockWSImpl });
    expect(client.isConnected()).toBe(false);
    expect(client.endpoint()).toBeNull();
    client.close();
  });
});
