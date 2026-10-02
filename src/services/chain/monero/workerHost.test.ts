// The page side of the worker (spawn, prefix, token by postMessage) and the
// worker wrapper itself (public/xmr-worker.js), run in a vm sandbox with a
// fake worker global: the XHR rewrite, the header, and that the token message
// never reaches monero-ts's own onmessage.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { XMR_WORKER_TOKEN_MESSAGE, moneroWorkerPrefix, moneroWorkerUrl, spawnMoneroWorker } from './workerHost';

describe('workerHost (page side)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds /xmr/<set> and refuses anything else', () => {
    expect(moneroWorkerPrefix('main')).toBe('/xmr/main');
    for (const bad of ['', 'Main', '../x', 'a/b', 'x'.repeat(33)]) expect(() => moneroWorkerPrefix(bad)).toThrow();
  });

  it('uses chrome.runtime.getURL and puts only the prefix in the URL', () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://abc/${p}` } });
    expect(moneroWorkerUrl('main')).toBe('chrome-extension://abc/xmr-worker.js?prefix=%2Fxmr%2Fmain');
  });

  it('spawns a classic worker and posts the token as the very first message', () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `moz-extension://uuid/${p}` } });
    const made: Array<{ url: string; opts: unknown; posted: unknown[] }> = [];
    vi.stubGlobal(
      'Worker',
      class {
        posted: unknown[] = [];
        constructor(url: string, opts?: unknown) {
          made.push({ url, opts, posted: this.posted });
        }
        postMessage(m: unknown) {
          this.posted.push(m);
        }
      },
    );
    spawnMoneroWorker('main', 'sgw_token');
    expect(made).toHaveLength(1);
    expect(made[0].url).toBe('moz-extension://uuid/xmr-worker.js?prefix=%2Fxmr%2Fmain');
    expect(made[0].url).not.toContain('sgw_token');
    expect(made[0].opts).toBeUndefined(); // classic, not { type: 'module' }
    expect(made[0].posted).toEqual([{ type: XMR_WORKER_TOKEN_MESSAGE, token: 'sgw_token' }]);
  });

  it('fails loudly where there is no Worker (a service worker), never falls back', () => {
    vi.stubGlobal('Worker', undefined);
    expect(() => spawnMoneroWorker('main', 't')).toThrow(/Web Worker/);
  });
});

// ---------------------------------------------------------------------------

interface Sandbox {
  opened: string[];
  headers: Array<[string, string]>;
  sent: number;
  moneroSaw: unknown[];
  dispatch(data: unknown): void;
  xhr(url: string): void;
}

function loadWrapper(workerUrl: string): Sandbox {
  const src = readFileSync(resolve(__dirname, '../../../../public/xmr-worker.js'), 'utf8');
  const listeners: Array<(e: { data: unknown; stopImmediatePropagation(): void }) => void> = [];
  const box: Sandbox = {
    opened: [],
    headers: [],
    sent: 0,
    moneroSaw: [],
    dispatch(data) {
      let stopped = false;
      const ev = { data, stopImmediatePropagation: () => (stopped = true) };
      for (const l of listeners) {
        l(ev);
        if (stopped) return;
      }
      // monero.worker.js sets self.onmessage; it runs after addEventListener
      // listeners registered earlier, unless one of them stopped the event.
      (self as unknown as { onmessage?: (e: unknown) => void }).onmessage?.(ev);
    },
    xhr(url) {
      const x = new FakeXHR();
      x.open('POST', url, true);
      x.send('{}');
    },
  };
  class FakeXHR {
    open(_m: string, url: string, _async?: boolean) {
      box.opened.push(url);
    }
    setRequestHeader(k: string, v: string) {
      box.headers.push([k, v]);
    }
    send(_body?: unknown) {
      box.sent++;
    }
  }
  const self = {
    location: { href: workerUrl },
    XMLHttpRequest: FakeXHR,
    addEventListener: (type: string, fn: (e: { data: unknown; stopImmediatePropagation(): void }) => void) => {
      if (type === 'message') listeners.push(fn);
    },
    onmessage: undefined as undefined | ((e: { data: unknown }) => void),
  };
  const ctx = vm.createContext({
    self,
    URL,
    importScripts: (name: string) => {
      expect(name).toBe('monero.worker.js');
      // What the stock bundle does: install its own onmessage.
      self.onmessage = (e) => box.moneroSaw.push(e.data);
    },
  });
  vm.runInContext(src, ctx);
  return box;
}

describe('public/xmr-worker.js (the wrapper)', () => {
  const BASE = 'chrome-extension://abc/xmr-worker.js';

  it('prefixes monerod paths with /xmr/<set>, once', () => {
    const w = loadWrapper(`${BASE}?prefix=%2Fxmr%2Fmain`);
    w.xhr('https://network.satorigo.app/json_rpc');
    w.xhr('https://network.satorigo.app:443/getblocks.bin');
    w.xhr('https://network.satorigo.app/xmr/main/gethashes.bin');
    expect(w.opened).toEqual([
      'https://network.satorigo.app/xmr/main/json_rpc',
      'https://network.satorigo.app/xmr/main/getblocks.bin',
      'https://network.satorigo.app/xmr/main/gethashes.bin',
    ]);
  });

  it('adds X-Satori-Client only after the token message, and hides that message from monero-ts', () => {
    const w = loadWrapper(`${BASE}?prefix=%2Fxmr%2Fmain`);
    w.xhr('https://network.satorigo.app/json_rpc');
    expect(w.headers).toEqual([]);
    w.dispatch({ type: 'satori:xmr-client-token', token: 'sgw_x' });
    expect(w.moneroSaw).toEqual([]);
    w.xhr('https://network.satorigo.app/json_rpc');
    expect(w.headers).toEqual([['X-Satori-Client', 'sgw_x']]);
    expect(w.sent).toBe(2);
    // Ordinary monero-ts calls pass straight through.
    w.dispatch(['obj', 'createWalletFull', 'cb']);
    expect(w.moneroSaw).toEqual([['obj', 'createWalletFull', 'cb']]);
  });

  it('ignores a prefix of any other shape (no rewrite at all)', () => {
    for (const bad of ['%2Fevm%2Fbase', '%2Fxmr%2F..%2Fevm', '%2Fxmr%2FMain', 'xmr%2Fmain']) {
      const w = loadWrapper(`${BASE}?prefix=${bad}`);
      w.xhr('https://network.satorigo.app/json_rpc');
      expect(w.opened).toEqual(['https://network.satorigo.app/json_rpc']);
    }
  });

  it('the token message constant matches the page side', () => {
    const src = readFileSync(resolve(__dirname, '../../../../public/xmr-worker.js'), 'utf8');
    expect(src).toContain(`'${XMR_WORKER_TOKEN_MESSAGE}'`);
  });
});
