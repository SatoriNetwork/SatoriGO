// Satori GO content script — the relay between the page and the extension.
//
// 1. Injects inpage.js (the `window.evrmore` provider) into the page MAIN world.
// 2. Relays provider requests:  page postMessage -> chrome.runtime.sendMessage.
// 3. Relays results back:       immediate response, or — for approval-gated
//    calls answered `{deferred:true}` — a later `evr-dapp-result` broadcast from
//    the background worker once the user decides in the approval window.
//
// This script holds no wallet state and no secrets; it only ferries JSON.
(() => {
  'use strict';

  // --- 1. Inject the MAIN-world provider as early as possible ---------------
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inpage.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (err) {
    // Injection can fail on exotic documents; the page simply gets no provider.
    console.debug('evr-nexus: provider injection failed', err);
  }

  /** ids we answered `{deferred:true}` for — awaiting an evr-dapp-result. */
  const deferred = new Set();

  const replyToPage = (id, result, error) => {
    window.postMessage({ source: 'evr-nexus-content', id, result, error }, '*');
  };

  // --- 2. Page -> background -------------------------------------------------
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'evr-nexus-inpage') return;
    if (typeof data.id !== 'string' || typeof data.method !== 'string') return;

    try {
      chrome.runtime.sendMessage(
        {
          type: 'evr-dapp',
          id: data.id,
          method: data.method,
          params: data.params,
          origin: location.origin,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            replyToPage(data.id, undefined, chrome.runtime.lastError.message || 'wallet-unavailable');
            return;
          }
          if (response && response.deferred) {
            deferred.add(data.id); // the decision arrives later as evr-dapp-result
            return;
          }
          replyToPage(data.id, response && response.result, response ? response.error : 'no-response');
        },
      );
    } catch {
      // Extension got reloaded/uninstalled — fail the call instead of hanging.
      replyToPage(data.id, undefined, 'wallet-unavailable');
    }
  });

  // --- 3. Deferred results from the background worker ------------------------
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'evr-dapp-result') return;
    // Only relay ids THIS document actually deferred. A navigation replaces the
    // document, and the new document's content script starts with an empty set,
    // so a result approved for the previous page can never reach whatever page
    // now occupies the tab. This is the authoritative half of the check: the
    // background can only read the tab's URL for hosts it has permission for.
    if (!deferred.has(message.id)) return;
    // Second, independent gate on the same property: the background echoes the
    // origin the request came from; refuse to relay into a document whose
    // origin differs (location.origin is immutable for a document's lifetime,
    // so a mismatch means this is not the requesting document).
    if (message.origin !== location.origin) return;
    deferred.delete(message.id);
    replyToPage(message.id, message.result, message.error);
  });
})();
