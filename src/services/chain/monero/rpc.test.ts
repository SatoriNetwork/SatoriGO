import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MONERO_RELEASE_HEIGHT,
  estimateHeightForDate,
  isValidMoneroNodeSet,
  moneroDaemonInfo,
  moneroGatewayBase,
  moneroGatewayHeaders,
  parseDaemonInfo,
  restoreHeightForNewWallet,
} from './rpc';

const GW = 'https://network.satorigo.app';

describe('moneroGatewayBase', () => {
  it('builds <gateway>/xmr/<set>', () => {
    expect(moneroGatewayBase(GW, 'main')).toBe('https://network.satorigo.app/xmr/main');
    expect(moneroGatewayBase(`${GW}///`, 'main')).toBe('https://network.satorigo.app/xmr/main');
    expect(moneroGatewayBase(` ${GW} `, 'stage-1')).toBe('https://network.satorigo.app/xmr/stage-1');
  });

  it('refuses a node set that is not one lowercase path segment', () => {
    for (const bad of ['', 'Main', '../evm', 'a/b', 'main?x=1', 'x'.repeat(33), 'main%2f']) {
      expect(isValidMoneroNodeSet(bad)).toBe(false);
      expect(() => moneroGatewayBase(GW, bad)).toThrow();
    }
    expect(isValidMoneroNodeSet('x'.repeat(32))).toBe(true);
  });

  it('refuses no gateway, a non-URL, and plain http to a remote host', () => {
    expect(() => moneroGatewayBase('', 'main')).toThrow(/gateway/i);
    expect(() => moneroGatewayBase('not a url', 'main')).toThrow();
    expect(() => moneroGatewayBase('http://network.satorigo.app', 'main')).toThrow(/https/);
    // A local development gateway may be plain http.
    expect(moneroGatewayBase('http://127.0.0.1:8080', 'main')).toBe('http://127.0.0.1:8080/xmr/main');
  });

  it('headers carry the client token only when there is one', () => {
    expect(moneroGatewayHeaders('tok')).toEqual({ 'content-type': 'application/json', 'X-Satori-Client': 'tok' });
    expect(moneroGatewayHeaders('')).toEqual({ 'content-type': 'application/json' });
  });
});

describe('estimateHeightForDate', () => {
  const anchor = new Date('2026-09-28T13:50:00Z');

  it('at the anchor: the anchor height minus one week of blocks', () => {
    expect(estimateHeightForDate(anchor, anchor)).toBe(3772368 - 5040);
  });

  it('one day earlier is 720 blocks lower', () => {
    const dayBefore = new Date(anchor.getTime() - 86_400_000);
    expect(estimateHeightForDate(dayBefore, anchor)).toBe(3772368 - 5040 - 720);
  });

  it('a year back is about 262,800 blocks lower, never above the real height then', () => {
    const yearBefore = new Date(anchor.getTime() - 365 * 86_400_000);
    expect(estimateHeightForDate(yearBefore, anchor)).toBe(3772368 - 5040 - 262_800);
  });

  it('extrapolates forward from the anchor up to `now`, and reads a future date as now', () => {
    const now = new Date(anchor.getTime() + 10 * 86_400_000);
    expect(estimateHeightForDate(now, now)).toBe(3772368 + 7200 - 5040);
    const future = new Date(now.getTime() + 30 * 86_400_000);
    expect(estimateHeightForDate(future, now)).toBe(estimateHeightForDate(now, now));
  });

  it('uses 60 s blocks before the v2 fork, so a 2015 wallet is never placed above its real height', () => {
    // Real height on 2015-06-01 was about 590,000 (409 days of 60 s blocks
    // from the 2014-04-18 genesis). One 120 s line from today's anchor would
    // answer about 788,000, some 200,000 blocks AFTER the wallet's first
    // receipts. The fork segment answers below the real height.
    const h2015 = estimateHeightForDate(new Date('2015-06-01T00:00:00Z'), anchor);
    expect(h2015).toBeLessThan(590_000);
    expect(h2015).toBeGreaterThan(500_000);
    expect(h2015).toBe(1_009_827 - 296 * 1440 - 5040);
    // The day the fork activated (height 1,009,827): still below it.
    expect(estimateHeightForDate(new Date('2016-03-23T00:00:00Z'), anchor)).toBeLessThan(1_009_827);
    // Well after the fork the 120 s line is the lower one and still applies.
    expect(estimateHeightForDate(new Date('2016-06-01T00:00:00Z'), anchor)).toBeLessThan(1_009_827 + 70 * 720);
    expect(estimateHeightForDate(new Date('2016-06-01T00:00:00Z'), anchor)).toBeGreaterThan(1_009_827);
  });

  it('stays monotonic day by day across the fork', () => {
    let prev = -1;
    const start = Date.UTC(2016, 1, 1);
    for (let d = 0; d < 120; d++) {
      const h = estimateHeightForDate(new Date(start + d * 86_400_000), anchor);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });

  it('clamps at 0 for dates before Monero existed', () => {
    expect(estimateHeightForDate(new Date('2010-01-01T00:00:00Z'), anchor)).toBe(0);
    expect(estimateHeightForDate(new Date(0), anchor)).toBe(0);
  });

  it('always returns a non-negative integer and throws on an invalid date', () => {
    for (const d of ['2014-04-18', '2019-11-30', '2024-02-29T23:59:59Z']) {
      const h = estimateHeightForDate(new Date(d), anchor);
      expect(Number.isSafeInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
    }
    expect(() => estimateHeightForDate(new Date('nope'), anchor)).toThrow();
  });

  it('is monotonic in the date', () => {
    let prev = -1;
    for (let y = 2014; y <= 2026; y++) {
      const h = estimateHeightForDate(new Date(Date.UTC(y, 5, 1)), anchor);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });
});

describe('restoreHeightForNewWallet', () => {
  it('is the tip minus 20, floored at the release height', () => {
    expect(restoreHeightForNewWallet(3_800_000)).toBe(3_799_980);
    expect(restoreHeightForNewWallet(MONERO_RELEASE_HEIGHT + 5)).toBe(MONERO_RELEASE_HEIGHT);
    expect(restoreHeightForNewWallet(100)).toBe(MONERO_RELEASE_HEIGHT);
    expect(() => restoreHeightForNewWallet(-1)).toThrow();
    expect(() => restoreHeightForNewWallet(1.5)).toThrow();
  });
});

describe('parseDaemonInfo', () => {
  const ok = { result: { height: 3772384, status: 'OK', nettype: 'mainnet', version: '' } };

  it('reads height and status from a restricted node reply', () => {
    expect(parseDaemonInfo(ok)).toEqual({ height: 3772384, version: 0, status: 'OK' });
  });

  it('encodes a release string as major << 16 | minor', () => {
    expect(parseDaemonInfo({ result: { ...ok.result, version: '0.18.4.3' } }).version).toBe(18);
    expect(parseDaemonInfo({ result: { ...ok.result, version: '1.2.0' } }).version).toBe((1 << 16) | 2);
  });

  it('refuses a node on another network (nettype or the legacy booleans)', () => {
    expect(() => parseDaemonInfo({ result: { ...ok.result, nettype: 'stagenet' } })).toThrow(/stagenet/);
    expect(() => parseDaemonInfo({ result: { height: 5, status: 'OK', stagenet: true } })).toThrow(/stagenet/);
    expect(parseDaemonInfo({ result: { ...ok.result, nettype: 'stagenet' } }, 'stagenet').height).toBe(3772384);
  });

  it('refuses a JSON-RPC error, a missing or silly height, and a busy node', () => {
    expect(() => parseDaemonInfo({ error: { code: -1, message: 'nope' } })).toThrow(/nope/);
    expect(() => parseDaemonInfo({})).toThrow(/no result/);
    expect(() => parseDaemonInfo({ result: { status: 'OK' } })).toThrow(/height/);
    expect(() => parseDaemonInfo({ result: { height: '12', status: 'OK' } })).toThrow(/height/);
    expect(() => parseDaemonInfo({ result: { height: 0, status: 'OK' } })).toThrow(/height/);
    expect(() => parseDaemonInfo({ result: { height: 10, status: 'BUSY' } })).toThrow(/BUSY/);
  });

  it('caps foreign text in errors', () => {
    const long = 'x'.repeat(5000);
    try {
      parseDaemonInfo({ error: { message: long } });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(300);
    }
  });
});

describe('moneroDaemonInfo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs json_rpc get_info to the gateway route with the token header', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { height: 3772400, status: 'OK', nettype: 'mainnet' } })));
    vi.stubGlobal('fetch', fetchMock);
    const info = await moneroDaemonInfo(GW, 'tok', 'main');
    expect(info).toEqual({ height: 3772400, version: 0, status: 'OK' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://network.satorigo.app/xmr/main/json_rpc');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Satori-Client']).toBe('tok');
    expect(JSON.parse(String(init.body))).toMatchObject({ jsonrpc: '2.0', method: 'get_info' });
    expect(init.credentials).toBe('omit');
  });

  it('names the HTTP status on a gateway refusal (403 = token rejected)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(moneroDaemonInfo(GW, 'bad', 'main')).rejects.toThrow(/HTTP 403/);
  });

  it('reports a transport failure without the request body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(moneroDaemonInfo(GW, 'tok', 'main')).rejects.toThrow(/unreachable \(get_info\): Failed to fetch/);
  });

  it('honours a caller abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
      ),
    );
    const ctrl = new AbortController();
    const p = moneroDaemonInfo(GW, 'tok', 'main', ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow(/cancelled/);
  });

  it('refuses non-JSON and a stagenet node', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>')));
    await expect(moneroDaemonInfo(GW, 'tok', 'main')).rejects.toThrow(/not JSON/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { height: 5, nettype: 'stagenet', status: 'OK' } }))));
    await expect(moneroDaemonInfo(GW, 'tok', 'main')).rejects.toThrow(/stagenet/);
  });

  it('never builds a URL off the gateway host', () => {
    // hosts pin, local to this module: every URL is <gateway>/xmr/<set>/...
    expect(new URL(moneroGatewayBase(GW, 'main')).host).toBe('network.satorigo.app');
  });
});
