import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  ZCASH_HISTORY_FLOOR,
  ZCASH_TXS_SPAN,
  ZcashRpcError,
  isValidZcashNodeSet,
  parseZcashInfo,
  parseZcashSend,
  parseZcashTxs,
  parseZcashUtxos,
  zcashGatewayBase,
  zcashGatewayHeaders,
  zcashRpc,
} from './rpc';

const GW = 'https://network.satorigo.app';
// Public vector addresses (docs/design/zcash-engine.md §2.3): the abandon
// phrase's /0/0 and /1/0. Used as data only, never as a funded wallet here.
const A0 = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F';
const T3 = 't3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd';
const TXID = 'ab'.repeat(32);

type Call = { url: string; init: RequestInit };

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const body = (c: Call) => JSON.parse(String(c.init.body));

const INFO = {
  chainName: 'main',
  height: 3_499_700,
  estimatedHeight: 3_499_700,
  consensusBranchId: '37a5165b',
  upgradeName: 'NU6.3',
  upgradeHeight: 3_400_000,
  taddrSupport: true,
  server: 'lightwalletd v0.5.3 zebra',
};

afterEach(() => vi.unstubAllGlobals());

describe('zcashGatewayBase and headers', () => {
  it('builds <gateway>/zec/<set>', () => {
    expect(zcashGatewayBase(GW, 'main')).toBe('https://network.satorigo.app/zec/main');
    expect(zcashGatewayBase(`${GW}///`)).toBe('https://network.satorigo.app/zec/main');
    expect(zcashGatewayBase(' http://127.0.0.1:8080 ', 'test-1')).toBe('http://127.0.0.1:8080/zec/test-1');
  });

  it('refuses a node set that is not one lowercase path segment', () => {
    for (const bad of ['', 'Main', '../evm', 'a/b', 'main?x=1', 'x'.repeat(33), 'main%2f']) {
      expect(isValidZcashNodeSet(bad)).toBe(false);
      expect(() => zcashGatewayBase(GW, bad)).toThrow();
    }
  });

  it('refuses no gateway, a non-URL, plain http to a remote host, and a query', () => {
    expect(() => zcashGatewayBase('', 'main')).toThrow(/gateway/i);
    expect(() => zcashGatewayBase('not a url', 'main')).toThrow();
    expect(() => zcashGatewayBase('http://network.satorigo.app', 'main')).toThrow(/https/);
    expect(() => zcashGatewayBase(`${GW}/?x=1`, 'main')).toThrow();
    expect(() => zcashRpc('', 'tok')).toThrow(/gateway/i);
  });

  it('headers: the token only when there is one, a content type only on POST', () => {
    expect(zcashGatewayHeaders('tok', true)).toEqual({ 'content-type': 'application/json', 'X-Satori-Client': 'tok' });
    expect(zcashGatewayHeaders('tok', false)).toEqual({ 'X-Satori-Client': 'tok' });
    expect(zcashGatewayHeaders('', true)).toEqual({ 'content-type': 'application/json' });
  });
});

describe('parseZcashInfo', () => {
  it('reads the branch ID as a u32 and keeps the upgrade', () => {
    const info = parseZcashInfo(INFO);
    expect(info.consensusBranchId).toBe(0x37a5165b);
    expect(info).toMatchObject({ chainName: 'main', height: 3_499_700, upgradeName: 'NU6.3', upgradeHeight: 3_400_000, taddrSupport: true });
    expect(parseZcashInfo({ ...INFO, consensusBranchId: 'C8E71055' }).consensusBranchId).toBe(0xc8e71055);
  });

  it('refuses a chain that is not main, no transparent support, and a bad branch ID or height', () => {
    expect(() => parseZcashInfo({ ...INFO, chainName: 'test' })).toThrow(/not mainnet/);
    expect(() => parseZcashInfo({ ...INFO, taddrSupport: false })).toThrow(/transparent/);
    for (const b of ['', '37a5165', '37a5165bb', 'zzzzzzzz', '00000000', 12345]) {
      expect(() => parseZcashInfo({ ...INFO, consensusBranchId: b })).toThrow();
    }
    for (const h of [0, -1, 1.5, '3499700', ZCASH_HISTORY_FLOOR]) expect(() => parseZcashInfo({ ...INFO, height: h })).toThrow(/height/);
    expect(() => parseZcashInfo(null)).toThrow();
  });

  it('caps foreign text', () => {
    try {
      parseZcashInfo({ ...INFO, chainName: 'x'.repeat(5000) });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(300);
    }
  });
});

describe('response shape checks', () => {
  it('utxos: bigint values, script bytes, only addresses that were asked for', () => {
    const out = parseZcashUtxos(
      { utxos: [{ address: A0, txid: TXID, index: 1, script: '76a914' + '00'.repeat(20) + '88ac', valueZat: '15056698', height: 3_000_000 }], truncated: false },
      [A0],
    );
    expect(out.truncated).toBe(false);
    expect(out.utxos[0].valueZat).toBe(15_056_698n);
    expect(out.utxos[0].script).toBeInstanceOf(Uint8Array);
    expect(out.utxos[0].script.length).toBe(25);
    expect(() =>
      parseZcashUtxos({ utxos: [{ address: T3, txid: TXID, index: 1, script: 'a914', valueZat: '1', height: 5 }] }, [A0]),
    ).toThrow(/not asked/);
    expect(() => parseZcashUtxos({ utxos: [{ address: A0, txid: TXID, index: 1, script: '00', valueZat: 1, height: 5 }] }, [A0])).toThrow();
    expect(() => parseZcashUtxos({ utxos: [{ address: A0, txid: TXID, index: 1, script: '00', valueZat: '-1', height: 5 }] }, [A0])).toThrow();
    expect(() =>
      parseZcashUtxos({ utxos: [{ address: A0, txid: TXID, index: 1, script: '00', valueZat: '99999999999999999999', height: 5 }] }, [A0]),
    ).toThrow();
  });

  it('txs: heights inside the asked range; a cut page needs a resume height', () => {
    expect(parseZcashTxs({ txs: [{ hex: '05000080', height: 500 }], truncated: false, resumeFrom: null }, 500, 600).txs).toHaveLength(1);
    expect(() => parseZcashTxs({ txs: [{ hex: '05000080', height: 700 }] }, 500, 600)).toThrow(/range/);
    expect(() => parseZcashTxs({ txs: [], truncated: true, resumeFrom: null }, 500, 600)).toThrow(/resume/);
    expect(parseZcashTxs({ txs: [{ hex: '05000080', height: 550 }], truncated: true, resumeFrom: 550 }, 500, 600).resumeFrom).toBe(550);
  });

  it('send: success is errorCode 0; "already queued" is unknown (thrown), not a failure', () => {
    expect(parseZcashSend({ ok: true, errorCode: 0, errorMessage: `"${TXID}"` })).toMatchObject({ ok: true, errorCode: 0 });
    expect(parseZcashSend({ ok: false, errorCode: -1, errorMessage: 'could not find transparent input UTXO' })).toEqual({
      ok: false,
      errorCode: -1,
      errorMessage: 'could not find transparent input UTXO',
    });
    expect(() => parseZcashSend({ ok: false, errorCode: -1, errorMessage: 'already queued for download' })).toThrow(
      expect.objectContaining({ code: 'unknown' }),
    );
    expect(() => parseZcashSend({ ok: false, errorCode: -27, errorMessage: 'transaction already in block chain' })).toThrow(
      expect.objectContaining({ code: 'unknown' }),
    );
    expect(() => parseZcashSend({ ok: false })).toThrow();
    expect(parseZcashSend({ errorCode: -26, errorMessage: 'y'.repeat(5000) }).errorMessage.length).toBeLessThan(300);
  });
});

describe('zcashRpc ops', () => {
  it('info: GET with the token and no body', async () => {
    const calls = stubFetch(() => json(INFO));
    const info = await zcashRpc(GW, 'tok').info();
    expect(info.consensusBranchId).toBe(0x37a5165b);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://network.satorigo.app/zec/main/info');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>)['X-Satori-Client']).toBe('tok');
    expect(calls[0].init.credentials).toBe('omit');
  });

  it('info: a server set on another chain is refused', async () => {
    stubFetch(() => json({ ...INFO, chainName: 'test' }));
    await expect(zcashRpc(GW, 'tok').info()).rejects.toThrow(/not mainnet/);
  });

  it('balance, utxos, txs, mempool: POST bodies of the documented shape', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('/balance')) return json({ zat: '42' });
      if (url.endsWith('/utxos')) return json({ utxos: [], truncated: false });
      if (url.endsWith('/txs')) return json({ txs: [], truncated: false, resumeFrom: null });
      if (url.endsWith('/mempool')) return json({ txs: [] });
      return json({}, 404);
    });
    const rpc = zcashRpc(GW, 'tok', 'main');
    expect(await rpc.balance([A0, A0, T3])).toBe(42n);
    await rpc.utxos([A0]);
    await rpc.utxos([A0], 3_000_000);
    await rpc.txs(A0, ZCASH_HISTORY_FLOOR, ZCASH_HISTORY_FLOOR + ZCASH_TXS_SPAN);
    await rpc.mempool([A0], [`${TXID}:0`, `${TXID}:0`]);
    await rpc.mempool([A0], []);
    expect(calls.map((c) => c.url.replace(GW, ''))).toEqual([
      '/zec/main/balance',
      '/zec/main/utxos',
      '/zec/main/utxos',
      '/zec/main/txs',
      '/zec/main/mempool',
      '/zec/main/mempool',
    ]);
    for (const c of calls) {
      expect(c.init.method).toBe('POST');
      expect((c.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    }
    expect(body(calls[0])).toEqual({ addresses: [A0, T3] });
    expect(body(calls[1])).toEqual({ addresses: [A0] });
    expect(body(calls[2])).toEqual({ addresses: [A0], startHeight: 3_000_000 });
    expect(body(calls[3])).toEqual({ address: A0, start: ZCASH_HISTORY_FLOOR, end: ZCASH_HISTORY_FLOOR + ZCASH_TXS_SPAN });
    expect(body(calls[4])).toEqual({ addresses: [A0], outpoints: [`${TXID}:0`] });
    expect(body(calls[5])).toEqual({ addresses: [A0] });
  });

  it('mempool: amounts become bigint', async () => {
    stubFetch(() => json({ txs: [{ txid: TXID, vin: [{ txid: TXID, index: 2 }], vout: [{ valueZat: '100000', script: '76a9' }] }] }));
    const txs = await zcashRpc(GW, 'tok').mempool([A0], []);
    expect(txs[0].vout[0].valueZat).toBe(100_000n);
    expect(txs[0].vin[0]).toEqual({ txid: TXID, index: 2 });
  });

  it('refuses bad arguments before any request', async () => {
    const calls = stubFetch(() => json({}));
    const rpc = zcashRpc(GW, 'tok');
    await expect(rpc.balance([])).rejects.toThrow(ZcashRpcError);
    await expect(rpc.balance(Array.from({ length: 21 }, () => A0))).rejects.toThrow(/20/);
    await expect(rpc.balance(['u1abcdef'])).rejects.toThrow(/transparent/);
    await expect(rpc.balance(['tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd'])).rejects.toThrow(/transparent/);
    await expect(rpc.txs(A0, 0, 10)).rejects.toThrow(/span/);
    await expect(rpc.txs(A0, 100, 50)).rejects.toThrow(/span/);
    await expect(rpc.txs(A0, 1, 2 + ZCASH_TXS_SPAN)).rejects.toThrow(/span/);
    await expect(rpc.tx('nothex')).rejects.toThrow(/64 hex/);
    await expect(rpc.mempool([A0], ['bad'])).rejects.toThrow(/txid:index/);
    await expect(rpc.mempool([A0], Array.from({ length: 1001 }, (_, i) => `${TXID}:${i}`))).rejects.toThrow(/1000/);
    await expect(rpc.send('zz')).rejects.toThrow(/hex/);
    await expect(rpc.send('04000080' + '00'.repeat(10))).rejects.toThrow(/v5 or v6/);
    await expect(rpc.send('05000080' + '00'.repeat(100 * 1024))).rejects.toThrow(/too large/);
    expect(calls).toHaveLength(0);
  });

  it('tx: 404 is null; heights 0 and -1 pass through', async () => {
    let answer: Response = json({ error: 'transaction not found' }, 404);
    const calls = stubFetch(() => answer);
    const rpc = zcashRpc(GW, 'tok');
    expect(await rpc.tx(TXID.toUpperCase())).toBeNull();
    expect(body(calls[0])).toEqual({ txid: TXID });
    answer = json({ hex: '05000080aa', height: 0 });
    expect(await rpc.tx(TXID)).toEqual({ hex: '05000080aa', height: 0 });
    answer = json({ hex: '05000080aa', height: -1 });
    expect((await rpc.tx(TXID))?.height).toBe(-1);
  });

  it('names the HTTP status and caps the gateway error text; never echoes the request', async () => {
    stubFetch(() => json({ error: 'z'.repeat(4000) }, 502));
    try {
      await zcashRpc(GW, 'tok').balance([A0]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ZcashRpcError);
      expect((e as ZcashRpcError).status).toBe(502);
      expect((e as Error).message).toMatch(/HTTP 502/);
      expect((e as Error).message.length).toBeLessThan(400);
      expect((e as Error).message).not.toContain(A0);
    }
    stubFetch(() => json({ error: 'addresses: 1..20 t1/t3 addresses' }, 400));
    await expect(zcashRpc(GW, 'tok').balance([A0])).rejects.toMatchObject({ code: 'refused', status: 400 });
    stubFetch(() => new Response('<html>', { status: 403 }));
    await expect(zcashRpc(GW, 'bad').balance([A0])).rejects.toThrow(/HTTP 403/);
    stubFetch(() => new Response('not json', { status: 200 }));
    await expect(zcashRpc(GW, 'tok').balance([A0])).rejects.toMatchObject({ code: 'format' });
  });

  it('reports a transport failure without the request body', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(zcashRpc(GW, 'tok').utxos([A0])).rejects.toThrow(/unreachable \(utxos\): Failed to fetch/);
  });

  it('honours a caller abort', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const ctrl = new AbortController();
    const p = zcashRpc(GW, 'tok').info(ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('zcashRpc send: the 504 rule', () => {
  const HEX = '05000080' + '00'.repeat(60);

  it('relays the node answer: success, and the missing-input rejection', async () => {
    const calls = stubFetch(() => json({ ok: true, errorCode: 0, errorMessage: `"${TXID}"` }));
    const rpc = zcashRpc(GW, 'tok');
    expect(await rpc.send(HEX.toUpperCase())).toMatchObject({ ok: true, errorCode: 0 });
    expect(calls[0].url).toBe('https://network.satorigo.app/zec/main/send');
    expect(body(calls[0])).toEqual({ hex: HEX });
    stubFetch(() => json({ ok: false, errorCode: -1, errorMessage: 'could not find transparent input UTXO' }));
    expect(await rpc.send(HEX)).toMatchObject({ ok: false, errorCode: -1 });
  });

  it('504 is "unknown, look the txid up", never a resolved failure to retry', async () => {
    const calls = stubFetch(() => json({ error: 'upstream timed out; the transaction may still be relayed, check its txid' }, 504));
    const err = await zcashRpc(GW, 'tok')
      .send(HEX)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ZcashRpcError);
    expect(err).toMatchObject({ code: 'unknown', status: 504 });
    expect((err as Error).message).not.toMatch(/—/);
    expect(calls).toHaveLength(1);
  });

  it('a node that already has the transaction is unknown too', async () => {
    stubFetch(() => json({ ok: false, errorCode: -1, errorMessage: 'already queued for download' }));
    await expect(zcashRpc(GW, 'tok').send(HEX)).rejects.toMatchObject({ code: 'unknown' });
  });

  it('our own timeout after the request left is unknown too', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      const p = zcashRpc(GW, 'tok')
        .send(HEX)
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(101_000);
      expect(await p).toMatchObject({ code: 'unknown' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the gateway pre-flight refusal (4xx with stage precheck) is definite: nothing was relayed', async () => {
    stubFetch(() => json({ error: 'only v5 or v6 transactions', stage: 'precheck' }, 400));
    await expect(zcashRpc(GW, 'tok').send(HEX)).rejects.toMatchObject({ code: 'refused' });
    stubFetch(() => json({ error: 'rate limited', stage: 'precheck' }, 429));
    await expect(zcashRpc(GW, 'tok').send(HEX)).rejects.toMatchObject({ code: 'http', status: 429 });
  });

  it('every other failure after the request started is unknown, never a failure to retry', async () => {
    const cases: [string, () => Response | Promise<Response>][] = [
      ['400 without the precheck mark', () => json({ error: 'incorrect consensus branch id' }, 400)],
      ['429 from something in front of the gateway', () => json({ error: 'slow down' }, 429)],
      ['403', () => json({ error: 'origin not allowed' }, 403)],
      ['502', () => json({ error: 'zcash servers unreachable', stage: 'connect' }, 502)],
      ['500', () => new Response('oops', { status: 500 })],
      ['200 that is not JSON', () => new Response('<html>', { status: 200 })],
      ['200 without an error code', () => json({ ok: true })],
      ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ];
    for (const [name, answer] of cases) {
      const calls = stubFetch(answer);
      const err = await zcashRpc(GW, 'tok')
        .send(HEX)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err, name).toBeInstanceOf(ZcashRpcError);
      expect((err as ZcashRpcError).code, name).toBe('unknown');
      expect((err as Error).message, name).not.toMatch(/—/);
      expect(calls, name).toHaveLength(1);
    }
  });

  it('a request refused before fetch (not hex, wrong version) is definite and sends nothing', async () => {
    const calls = stubFetch(() => json({ ok: true, errorCode: 0, errorMessage: '' }));
    await expect(zcashRpc(GW, 'tok').send('04000080' + '00'.repeat(10))).rejects.toMatchObject({ code: 'refused' });
    expect(calls).toHaveLength(0);
  });
});

describe('one host', () => {
  // The network-facing modules of this directory (keys, addresses and
  // transactions make no request at all).
  it('rpc, reader and historyCache name no host other than the gateway', () => {
    const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const hosts = new Set<string>();
    let scanned = 0;
    for (const f of readdirSync(dir)) {
      if (!['rpc.ts', 'reader.ts', 'historyCache.ts'].includes(f)) continue;
      scanned++;
      const text = readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
    }
    expect(scanned).toBe(3);
    const allowed = new Set(['network.satorigo.app', '127.0.0.1', 'localhost']);
    expect([...hosts].filter((h) => !allowed.has(h))).toEqual([]);
  });
});
