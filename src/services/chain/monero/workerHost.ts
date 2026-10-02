// Where the Monero wallet runs (the Monero engine design notes §6.3 and §6.4).
//
// THE ONE FILE THAT DECIDES IT. v1 (owner decision, 2026-09-28): a dedicated
// Worker spawned by the UI page (popup, side panel or full-page tab), alive
// only while that page is open and the wallet is unlocked. The private view
// key, and the spend key for the life of the open wallet, live in that
// worker's WASM heap and nowhere else: never the background service worker,
// never an offscreen document, never a content script (AGENTS.md golden rule
// 4). If the owner later chooses an offscreen document (scans with the popup
// closed, needs the `offscreen` permission), this file is where that switch
// goes; scanner.ts only ever asks for "a worker".
//
// WHY A WRAPPER AND NOT monero.worker.js DIRECTLY. monero-ts's C++ HTTP client
// keeps only scheme://host:port of the server URI and posts to `/json_rpc`,
// `/getblocks.bin` ..., and it has no API for custom headers. The gateway needs
// both a path prefix (`/xmr/<set>/`) and the `X-Satori-Client` token.
// public/xmr-worker.js is a classic worker that patches XMLHttpRequest inside
// the worker (monero-ts's axios uses its xhr adapter there), then
// importScripts('monero.worker.js'), the stock bundle, unmodified.
//
// THE TOKEN TRAVELS BY postMessage, not in the worker URL: a URL is the kind of
// string that ends up in a log or a devtools screenshot. It is not a secret
// (it ships inside the bundle), but it is a credential the gateway rate-limits
// by, and keeping it out of URLs costs nothing. It is posted immediately after
// construction, before monero-ts can post anything, and messages to a worker
// are delivered in order, so the wrapper has it before the first request.
// The prefix DOES go in the URL: it is public routing, and the wrapper needs it
// synchronously before monero.worker.js loads.

/** The message the wrapper consumes (and hides from monero-ts). Keep in sync
 *  with public/xmr-worker.js. */
export const XMR_WORKER_TOKEN_MESSAGE = 'satori:xmr-client-token';

/** Published path of the wrapper inside the extension package (copied to the
 *  output root by scripts/build.mjs, only with --monero). */
export const XMR_WORKER_PATH = 'xmr-worker.js';

/** `/xmr/<set>`, validated the same way rpc.ts validates it. Assumes the
 *  gateway is served at the root of its host (https://network.satorigo.app),
 *  which scanner.ts asserts before spawning. */
export function moneroWorkerPrefix(nodeSet: string): string {
  if (typeof nodeSet !== 'string' || !/^[a-z0-9-]{1,32}$/.test(nodeSet)) {
    throw new Error('Not a valid Monero node set name.');
  }
  return `/xmr/${nodeSet}`;
}

/** Absolute URL of the wrapper with its prefix parameter. In the extension it
 *  is chrome.runtime.getURL (both chrome-extension:// and moz-extension://);
 *  outside one (vite dev server, a test harness page) it resolves against the
 *  page, which is where the build puts it too. */
export function moneroWorkerUrl(nodeSet: string): string {
  const prefix = moneroWorkerPrefix(nodeSet);
  let base: string;
  try {
    base =
      typeof chrome !== 'undefined' && chrome?.runtime?.getURL
        ? chrome.runtime.getURL(XMR_WORKER_PATH)
        : new URL(XMR_WORKER_PATH, globalThis.location?.href ?? 'http://localhost/').toString();
  } catch {
    base = new URL(XMR_WORKER_PATH, globalThis.location?.href ?? 'http://localhost/').toString();
  }
  return `${base}?prefix=${encodeURIComponent(prefix)}`;
}

/**
 * Spawn the wrapper worker for `nodeSet` and hand it the client token. The
 * caller (scanner.ts, through monero-ts's setWorkerLoader) owns the Worker and
 * terminates it on lock: `Worker.terminate()` is the only reliable scrub of the
 * WASM heap, which monero-ts does not promise to zero on close (§6.5).
 *
 * v1: the UI page. A context without `Worker` (a Chrome MV3 service worker)
 * throws here, loudly, instead of falling back to running WASM on that thread.
 */
export function spawnMoneroWorker(nodeSet: string, clientToken: string): Worker {
  if (typeof Worker === 'undefined') {
    throw new Error('Monero needs a Web Worker, and this context has none. Open the wallet window.');
  }
  // Classic, not module: the wrapper uses importScripts, which module workers
  // do not have, and the stock monero.worker.js is a classic script.
  const worker = new Worker(moneroWorkerUrl(nodeSet));
  worker.postMessage({ type: XMR_WORKER_TOKEN_MESSAGE, token: typeof clientToken === 'string' ? clientToken : '' });
  return worker;
}
