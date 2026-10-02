// Stand-in for `#monero-ts/monero.js` (the Emscripten glue with the 1.7 MB
// WASM inlined as base64, 2.6 MB) in the PAGE bundle. Satori GO never runs the
// WASM on the page: every monero-ts call goes to the wallet worker
// (MoneroUtils.PROXY_TO_WORKER defaults to true in a browser), and the worker
// loads its own copy inside the stock monero.worker.js. So the page does not
// need this module, and aliasing it here is about 2.6 MB off each package
// (the Monero engine design notes §6.1). If something ever does reach it
// (a `proxyToWorker: false` call), it fails with this message rather than a
// confusing "is not a function".
export default function loadMoneroWasmOnPage() {
  return Promise.reject(
    new Error('Satori GO runs Monero only inside its wallet worker; the page bundle carries no WASM (proxyToWorker must stay true).'),
  );
}
