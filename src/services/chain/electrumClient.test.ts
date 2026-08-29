import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WssElectrumClient,
  createElectrumClient,
  electrumGetBalance,
  electrumListUnspent,
} from './electrumClient';
import {
  PUBLIC_ELECTRUM_SERVERS,
  buildEvrElectrumPool,
  buildNeoxElectrumPool,
  buildRvnElectrumPool,
  buildBtcElectrumPool,
  buildLtcElectrumPool,
  buildDogeElectrumPool,
  buildBtgsElectrumPool,
  buildWjkElectrumPool,
  electrumWssUrl,
  ELECTRUM_METHODS,
} from './network';

/** A stand-in gateway build: the pool builders take the gateway and token as
 *  arguments, so the gateway shape is exercised here without a rebuild and
 *  without mocking the build defines. */
const GW = 'https://network.satorigo.app';
const GW_TOKEN = 'sgw_test_token';

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
  /** EXACTLY what the client passed as the constructor's 2nd argument, kept
   *  `undefined` when it passed nothing: the difference between "no
   *  subprotocol" and "an empty list" is what the gateway-bridge tests below
   *  assert, and a plain public node must get the former. */
  readonly protocols: string | string[] | undefined;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: OnFn = null;
  onmessage: OnFn = null;
  onerror: OnFn = null;
  onclose: OnFn = null;

  constructor(url: string, protocols?: string | string[]) {
    if (MockWebSocket.throwOnConstruct) {
      throw new Error('boom');
    }
    this.url = url;
    this.protocols = protocols;
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
    // A RANGE, never a fixed version: a fixed "1.10" is rejected outright by
    // servers that cap lower (Fulcrum maxes at 1.6), which took a whole chain
    // offline. The server picks the best version it supports within the range.
    // The max is pinned to 1.6 because this client only speaks the
    // blockchain.scripthash.* family: negotiating 1.7 (offered by ElectrumX
    // 2.0.0) yields a connected socket whose every read is an unknown method.
    expect(handshake.params).toEqual(['Satori-GO-Wallet', ['1.4', '1.6']]);

    ws.emitMessage(versionReply(handshake.id));
    await connecting;

    expect(client.isConnected()).toBe(true);
    expect(client.endpoint()).toBe(electrumWssUrl(PUBLIC_ELECTRUM_SERVERS[0]));
    client.close();
  });

  it('1b. connects to a server that caps BELOW our max (Fulcrum answers 1.6)', async () => {
    // REGRESSION: the handshake used to demand a fixed "1.10". Fulcrum supports
    // at most 1.6 and answered "Unsupported protocol version", so the connection
    // never established and every chain served by Fulcrum reported offline.
    const client = new WssElectrumClient(PUBLIC_ELECTRUM_SERVERS, {
      WebSocketImpl: MockWSImpl,
    });
    const connecting = client.connect();
    await flush();
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    await flush();

    const handshake = ws.lastSent();
    ws.emitMessage(
      JSON.stringify({ jsonrpc: '2.0', id: handshake.id, result: ['Fulcrum 2.1.0', '1.6'] }),
    );
    await connecting;

    expect(client.isConnected()).toBe(true);
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

  it('2b. offers the satori-v1 subprotocol pair to the gateway bridge, and NOTHING to a public node', async () => {
    // The pair is how the gateway authenticates the socket. A plain public
    // ElectrumX would not echo a subprotocol back, and a browser fails the
    // handshake when a requested subprotocol is not selected, so passing it to
    // everything would break every public node in the pool.
    const pool = buildEvrElectrumPool(GW, GW_TOKEN);
    const client = new WssElectrumClient(pool, { WebSocketImpl: MockWSImpl });
    const connecting = client.connect();

    await flush();
    const bridge = MockWebSocket.instances[0];
    expect(bridge.url).toBe('wss://network.satorigo.app/electrum/evr');
    expect(bridge.protocols).toEqual(['satori-v1', GW_TOKEN]);

    // Fail the bridge over to the first public fallback and check that socket
    // was opened with no 2nd constructor argument at all.
    bridge.emitError();
    await flush();
    const publicNode = MockWebSocket.instances[1];
    expect(publicNode.url).toBe('wss://electrum1-mainnet.evrmorecoin.org:50004');
    expect(publicNode.protocols).toBeUndefined();

    publicNode.emitOpen();
    await flush();
    publicNode.emitMessage(versionReply(publicNode.lastSent().id));
    await connecting;

    // THE smoke's scenario in miniature: the bridge is tried first, the wallet
    // still ends up connected, served by the public Evrmore pool.
    expect(client.endpoint()).toBe('wss://electrum1-mainnet.evrmorecoin.org:50004');
    client.close();
  });

  it('2c. an EVR bridge failure falls through BOTH public fallbacks before giving up', async () => {
    const pool = buildEvrElectrumPool(GW, GW_TOKEN);
    const client = new WssElectrumClient(pool, { WebSocketImpl: MockWSImpl });
    const failing = client.connect();

    for (let i = 0; i < 3; i++) {
      await flush();
      MockWebSocket.instances[i].emitError();
    }
    await expect(failing).rejects.toThrow(/All Electrum servers failed/);
    expect(MockWebSocket.instances.map((w) => w.url)).toEqual([
      'wss://network.satorigo.app/electrum/evr',
      'wss://electrum1-mainnet.evrmorecoin.org:50004',
      'wss://electrum2-mainnet.evrmorecoin.org:50004',
    ]);
    client.close();
  });

  it('2d. Ravencoin through the gateway has ONE endpoint: the bridge, and no fallback', async () => {
    // Deliberate: there is no acceptable public Ravencoin ElectrumX to fall back
    // to (they run plain upstream ElectrumX and reject the asset dialect), so a
    // gateway outage takes RVN offline rather than corrupting asset balances.
    const pool = buildRvnElectrumPool(GW, GW_TOKEN);
    expect(pool).toHaveLength(1);
    const client = new WssElectrumClient(pool, { WebSocketImpl: MockWSImpl });
    const failing = client.connect();

    await flush();
    const bridge = MockWebSocket.instances[0];
    expect(bridge.url).toBe('wss://network.satorigo.app/electrum/rvn');
    expect(bridge.protocols).toEqual(['satori-v1', GW_TOKEN]);
    bridge.emitError();

    await expect(failing).rejects.toThrow(/All Electrum servers failed/);
    expect(MockWebSocket.instances).toHaveLength(1);
    client.close();
  });

  it('2d-ter. Neoxa: the bridge is the only endpoint, and a 404 route degrades honestly (1.4.0)', async () => {
    // THE CURRENT REAL STATE OF THIS CHAIN, not a hypothetical. Neoxa is offered
    // in the UI, but the gateway has no `neox` upstream configured yet (the
    // owner's node is being stood up), so /electrum/neox answers 404 and the
    // WebSocket handshake fails. What must NOT happen: a throw that escapes, a
    // silent "connected", or a fall-through onto some other chain's servers.
    //
    // Same one-entry shape as Ravencoin above, and for the same reason: Neoxa
    // carries the Ravencoin asset protocol, so a plain public node would answer
    // server.version and then reject every asset call. There is deliberately no
    // fallback to land on.
    const pool = buildNeoxElectrumPool(GW, GW_TOKEN);
    expect(pool).toHaveLength(1);
    const client = new WssElectrumClient(pool, { WebSocketImpl: MockWSImpl });
    const failing = client.connect();

    await flush();
    const bridge = MockWebSocket.instances[0];
    expect(bridge.url).toBe('wss://network.satorigo.app/electrum/neox');
    expect(bridge.protocols).toEqual(['satori-v1', GW_TOKEN]);
    // The route does not exist: the browser fails the handshake.
    bridge.emitError();

    // A rejected promise the caller can render, not an unhandled throw…
    await expect(failing).rejects.toThrow(/All Electrum servers failed/);
    // …no second socket to some other chain's node…
    expect(MockWebSocket.instances).toHaveLength(1);
    // …and the client reports the truth rather than a stale "connected".
    expect(client.isConnected()).toBe(false);
    client.close();

    // Reconnecting later (once the owner's node is behind the bridge) tries the
    // same single endpoint again rather than remembering the failure.
    MockWebSocket.instances = [];
    const retry = new WssElectrumClient(buildNeoxElectrumPool(GW, GW_TOKEN), {
      WebSocketImpl: MockWSImpl,
    });
    const reconnecting = retry.connect();
    await flush();
    expect(MockWebSocket.instances[0].url).toBe('wss://network.satorigo.app/electrum/neox');
    MockWebSocket.instances[0].emitError();
    await expect(reconnecting).rejects.toThrow(/All Electrum servers failed/);
    retry.close();
  });

  it('2d-bis. a DEAD bridge on BTC/LTC/DOGE/BTGS/WJK fails over to that chain FIRST public server (1.4.0)', async () => {
    // The reason the public pools stayed: the live gateway route may not exist
    // yet, or may go down, and a gateway outage must never stop someone's
    // Bitcoin. Each case opens the bridge FIRST (with the subprotocol pair),
    // kills it, and asserts the very next socket is that chain's own first
    // public server, opened with NO subprotocol, and that the client ends up
    // connected there. This is exactly the path the live smoke exercises.
    const cases = [
      { build: buildBtcElectrumPool, bridge: 'wss://network.satorigo.app/electrum/btc', first: 'wss://btc.electrum1.cipig.net:30000' },
      { build: buildLtcElectrumPool, bridge: 'wss://network.satorigo.app/electrum/ltc', first: 'wss://ltc.electrum1.cipig.net:30063' },
      { build: buildDogeElectrumPool, bridge: 'wss://network.satorigo.app/electrum/doge', first: 'wss://doge.electrum1.cipig.net:30060' },
      { build: buildBtgsElectrumPool, bridge: 'wss://network.satorigo.app/electrum/btgs', first: 'wss://electrum.bitcoingold.site:50005' },
      { build: buildWjkElectrumPool, bridge: 'wss://network.satorigo.app/electrum/wjk', first: 'wss://electrum1.wojakcoin.cash:50104' },
    ] as const;

    for (const { build, bridge: bridgeUrl, first } of cases) {
      MockWebSocket.instances = [];
      const client = new WssElectrumClient(build(GW, GW_TOKEN), { WebSocketImpl: MockWSImpl });
      const connecting = client.connect();

      await flush();
      const bridge = MockWebSocket.instances[0];
      expect(bridge.url).toBe(bridgeUrl);
      expect(bridge.protocols).toEqual(['satori-v1', GW_TOKEN]);

      // The gateway route 404s / is down: the socket errors out.
      bridge.emitError();
      await flush();
      const publicNode = MockWebSocket.instances[1];
      expect(publicNode.url).toBe(first);
      expect(publicNode.protocols).toBeUndefined();

      publicNode.emitOpen();
      await flush();
      publicNode.emitMessage(versionReply(publicNode.lastSent().id));
      await connecting;
      expect(client.endpoint()).toBe(first);
      client.close();
    }
  });

  it('2e. a development build (no gateway) opens every socket with no subprotocol', async () => {
    const pool = buildEvrElectrumPool('', '');
    const client = new WssElectrumClient(pool, { WebSocketImpl: MockWSImpl });
    const connecting = client.connect();

    await flush();
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('wss://electrumx1.satorinet.io:50004');
    expect(ws.protocols).toBeUndefined();

    ws.emitOpen();
    await flush();
    ws.emitMessage(versionReply(ws.lastSent().id));
    await connecting;
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
