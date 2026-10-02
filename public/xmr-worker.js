/* global importScripts */
// Satori GO: classic worker wrapper around monero-ts's stock monero.worker.js
// (the Monero engine design notes §6.4). Shipped only in a --monero build,
// copied next to monero.worker.js at the package root by scripts/build.mjs.
//
// monero-ts's C++ HTTP client keeps only scheme://host:port of the daemon URI
// (so `https://network.satorigo.app/xmr/main` becomes `https://network.satorigo.app`
// and requests go to `/json_rpc`, `/getblocks.bin` ...), and it has no API for
// custom headers. The Satori GO gateway serves monerod under `/xmr/<set>/` and
// authenticates by the `X-Satori-Client` header (Firefox's moz-extension origin
// is random per install, so Origin cannot be allowlisted). Both are fixed here
// by patching XMLHttpRequest inside this worker, where monero-ts's axios uses
// its xhr adapter, BEFORE the stock bundle loads. Proven in Chrome and Firefox
// by the research spike: every request carried the header, and no CORS
// preflight was sent because host_permissions bypass CORS.
//
// Inputs:
//   ?prefix=/xmr/<set>   in the worker URL (public routing, needed
//                        synchronously before monero.worker.js loads)
//   the client token     in the FIRST postMessage, {type, token}; never in a
//                        URL, so it cannot end up in a log line or screenshot.
//
// Nothing else is changed. No logging here: request bodies can carry signed
// transactions and response bodies carry chain data tied to this wallet.
(function () {
  'use strict';

  var TOKEN_MESSAGE = 'satori:xmr-client-token';
  var PREFIX_RE = /^\/xmr\/[a-z0-9-]{1,32}$/;

  var prefix = '';
  try {
    var p = new URL(self.location.href).searchParams.get('prefix') || '';
    // Only the one shape the page ever builds; anything else is ignored rather
    // than trusted, so a crafted worker URL cannot point requests elsewhere
    // on the host.
    if (PREFIX_RE.test(p)) prefix = p;
  } catch {
    prefix = '';
  }

  var token = '';

  // Registered BEFORE importScripts, so it runs before monero-ts's own
  // `self.onmessage` for every message. The token message is consumed here and
  // stopped; monero-ts would otherwise try to dispatch it as a wallet call.
  self.addEventListener('message', function (e) {
    var d = e.data;
    if (d && typeof d === 'object' && !Array.isArray(d) && d.type === TOKEN_MESSAGE) {
      token = typeof d.token === 'string' ? d.token : '';
      e.stopImmediatePropagation();
    }
  });

  function rewrite(url) {
    if (!prefix) return url;
    try {
      var u = new URL(url, self.location.href);
      // Only http(s) daemon traffic is rerouted, and only once.
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return url;
      if (u.pathname === prefix || u.pathname.indexOf(prefix + '/') === 0) return u.toString();
      u.pathname = prefix + u.pathname;
      return u.toString();
    } catch {
      return url;
    }
  }

  var XHR = self.XMLHttpRequest && self.XMLHttpRequest.prototype;
  if (XHR) {
    var open = XHR.open;
    var send = XHR.send;
    XHR.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = rewrite(String(url));
      return open.apply(this, args);
    };
    XHR.send = function (body) {
      if (token) {
        try {
          this.setRequestHeader('X-Satori-Client', token);
        } catch {
          /* not OPENED: let send() raise its own error */
        }
      }
      return send.call(this, body);
    };
  }
})();

importScripts('monero.worker.js');
