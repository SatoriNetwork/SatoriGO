// Satori GO dApp provider — injected into the page MAIN world by content.js.
//
// Exposes `window.evrmore` so a site (e.g. the Satori neuron UI) can connect to
// the wallet, read the address/balances and REQUEST sends. Every connection and
// every send is approval-gated inside the extension; this script never sees a
// key, a seed or a password — only address / balances / txids come back.
//
// Transport: window.postMessage. Requests go out as
//   { source: 'evr-nexus-inpage', id, method, params }
// and the content script answers with
//   { source: 'evr-nexus-content', id, result?, error? }.
(() => {
  'use strict';
  if (window.evrmore) return; // do not clobber an already-installed provider

  /** id -> {resolve, reject} of in-flight requests. */
  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (event) => {
    // Only accept replies from OUR content script relaying in this same window.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'evr-nexus-content') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error !== undefined && data.error !== null) {
      entry.reject(new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error)));
    } else {
      entry.resolve(data.result);
    }
  });

  /** Generic request. `args` is { method, params? }. Returns a Promise. */
  function request(args) {
    const method = args && args.method;
    const params = (args && args.params) || {};
    return new Promise((resolve, reject) => {
      if (typeof method !== 'string' || !method) {
        reject(new Error('evrmore.request: a method name is required'));
        return;
      }
      seq += 1;
      const id = `evr-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
      pending.set(id, { resolve, reject });
      window.postMessage({ source: 'evr-nexus-inpage', id, method, params }, '*');
    });
  }

  const provider = {
    isEvrNexus: true,
    request,
    /** Ask the wallet for a connection. Resolves { address } after approval. */
    connect: () => request({ method: 'connect' }),
    /** Active wallet address (connected origins only). */
    getAddress: () => request({ method: 'getAddress' }),
    /** All balances incl. assets like SATORIEVR: [{ name, amount, decimals }]. */
    getBalances: () => request({ method: 'getBalances' }),
    /** Request an EVR send (decimal amount). Approval-gated; resolves the txid. */
    sendEvr: (to, amountDecimal) => request({ method: 'sendEvr', params: { to, amount: amountDecimal } }),
    /** Request an asset send (decimal amount). Approval-gated; resolves the txid. */
    sendAsset: (to, assetName, amountDecimal) =>
      request({ method: 'sendAsset', params: { to, asset: assetName, amount: amountDecimal } }),
    /** Sign a message with the active wallet (Evrmore signmessage format).
     *  Approval-gated; resolves { address, signature } where `signature` is the
     *  base64 recoverable sig that `verifymessage` / Satori accepts. Use for
     *  login / proof-of-address challenges. */
    signMessage: (message) => request({ method: 'signMessage', params: { message } }),
  };

  Object.defineProperty(window, 'evrmore', {
    value: Object.freeze(provider),
    writable: false,
    configurable: false,
  });
  window.dispatchEvent(new Event('evrmore#initialized'));
})();
