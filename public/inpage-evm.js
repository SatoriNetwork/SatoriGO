// Satori GO EVM dApp provider (EIP-1193), injected into the page MAIN world by
// content.js next to the Evrmore one (inpage.js).
//
// Lets a site connect to a Satori GO EVM account (Base by default), read the
// address and chain, switch chain, sign messages and typed data, and REQUEST
// transactions. Every connection, signature and transaction is approved by the
// user inside the extension; this script never sees a key, a seed or a password.
//
// Discovery:
// - EIP-6963: always announced, so a modern dApp lists Satori GO beside MetaMask
//   and the user picks per site.
// - window.ethereum: the USER'S choice (Settings > "Default browser wallet").
//   On: Satori GO takes window.ethereum even when another wallet is installed.
//   Off (default): Satori GO sets it only when no other wallet has.
//   content.js passes the setting as data-default-wallet on this script tag.
//
// Transport: window.postMessage, a namespace of its own so the Evrmore provider
// is untouched. Requests go out as
//   { source: 'satorigo-evm-inpage', id, method, params }
// and the content script answers with
//   { source: 'satorigo-evm-content', id, result?, error? }
// or pushes { source: 'satorigo-evm-content', event, data } (chainChanged,
// accountsChanged).
(() => {
  'use strict';
  if (window.__satoriGoEvmProvider) return;

  const script = document.currentScript;
  const takeDefault = !!(script && script.dataset && script.dataset.defaultWallet === '1');

  /** id -> {resolve, reject} of in-flight requests. */
  const pending = new Map();
  /** event name -> Set of listeners. */
  const listeners = new Map();
  let seq = 0;
  const state = { chainId: null, accounts: [] };

  /** EIP-1193 errors carry a numeric code (4001 user rejected, 4100
   *  unauthorized, 4200 unsupported, 4900 disconnected, 4902 unknown chain). */
  function providerError(err) {
    if (err && typeof err === 'object' && typeof err.code === 'number') {
      const e = new Error(typeof err.message === 'string' ? err.message : 'Request failed');
      e.code = err.code;
      if (err.data !== undefined) e.data = err.data;
      return e;
    }
    const message = typeof err === 'string' ? err : 'Request failed';
    const e = new Error(message);
    e.code = message === 'wallet-unavailable' ? 4900 : -32603;
    return e;
  }

  function emit(event, data) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(data);
      } catch (err) {
        console.error('Satori GO: a site listener threw', err);
      }
    }
  }

  function sameAccounts(a, b) {
    return a.length === b.length && a.every((x, i) => String(x).toLowerCase() === String(b[i]).toLowerCase());
  }

  function updateAccounts(next) {
    const accounts = Array.isArray(next) ? next.filter((a) => typeof a === 'string') : [];
    if (sameAccounts(accounts, state.accounts)) return;
    state.accounts = accounts;
    emit('accountsChanged', accounts.slice());
  }

  function updateChain(next) {
    if (typeof next !== 'string' || next === state.chainId) return;
    const first = state.chainId === null;
    state.chainId = next;
    if (first) emit('connect', { chainId: next });
    else emit('chainChanged', next);
  }

  window.addEventListener('message', (event) => {
    // Only accept messages from OUR content script relaying in this same window.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'satorigo-evm-content') return;
    if (typeof data.event === 'string') {
      if (data.event === 'chainChanged') updateChain(data.data);
      else if (data.event === 'accountsChanged') updateAccounts(data.data);
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error !== undefined && data.error !== null) entry.reject(providerError(data.error));
    else entry.resolve(data.result);
  });

  function send(method, params) {
    return new Promise((resolve, reject) => {
      seq += 1;
      const id = `sgo-evm-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
      pending.set(id, { resolve, reject });
      window.postMessage({ source: 'satorigo-evm-inpage', id, method, params }, '*');
    });
  }

  /** EIP-1193 request({ method, params }). */
  async function request(args) {
    if (!args || typeof args !== 'object' || typeof args.method !== 'string' || !args.method) {
      throw providerError({ code: -32602, message: 'request() needs { method, params? }' });
    }
    const params = args.params === undefined ? [] : args.params;
    const result = await send(args.method, params);
    // Keep the cached state (and events) in step with what the wallet answered.
    if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') updateAccounts(result);
    if (args.method === 'eth_chainId') updateChain(result);
    if (args.method === 'wallet_switchEthereumChain' || args.method === 'wallet_addEthereumChain') {
      updateChain(await send('eth_chainId', []));
    }
    return result;
  }

  function on(event, fn) {
    if (typeof fn !== 'function') return provider;
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return provider;
  }

  function removeListener(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
    return provider;
  }

  // Legacy web3 entry points some older dApps still call.
  function sendAsync(payload, callback) {
    request({ method: payload.method, params: payload.params }).then(
      (result) => callback(null, { id: payload.id, jsonrpc: '2.0', result }),
      (error) => callback(error, { id: payload.id, jsonrpc: '2.0', error }),
    );
  }
  function legacySend(methodOrPayload, paramsOrCallback) {
    if (typeof methodOrPayload === 'string') return request({ method: methodOrPayload, params: paramsOrCallback });
    if (typeof paramsOrCallback === 'function') return sendAsync(methodOrPayload, paramsOrCallback);
    throw providerError({ code: 4200, message: 'Synchronous send() is not supported; use request().' });
  }

  const provider = {
    isSatoriGO: true,
    request,
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    once(event, fn) {
      const wrapped = (data) => {
        removeListener(event, wrapped);
        fn(data);
      };
      return on(event, wrapped);
    },
    removeAllListeners(event) {
      if (event === undefined) listeners.clear();
      else listeners.delete(event);
      return provider;
    },
    isConnected: () => true,
    enable: () => request({ method: 'eth_requestAccounts' }),
    sendAsync,
    send: legacySend,
  };
  Object.defineProperty(provider, 'chainId', { get: () => state.chainId, enumerable: true });
  Object.defineProperty(provider, 'selectedAddress', { get: () => state.accounts[0] || null, enumerable: true });
  Object.defineProperty(provider, 'networkVersion', {
    get: () => (state.chainId ? String(parseInt(state.chainId, 16)) : null),
    enumerable: true,
  });
  // Lock what the wallet put on the provider, but leave the object extensible.
  // Sites built for MetaMask write their own fields onto window.ethereum at
  // startup (Uniswap: `window.ethereum.autoRefreshOnNetworkChange = false`, in
  // strict mode). On a frozen object that assignment throws and the whole site
  // stays blank whenever the wallet injects before the site's bundle runs
  // (1.7.0). So: every property of ours is non-writable and non-configurable,
  // a page can add a field of its own, and it cannot replace or delete ours.
  for (const key of Reflect.ownKeys(provider)) {
    const desc = Object.getOwnPropertyDescriptor(provider, key);
    if (desc && 'value' in desc) Object.defineProperty(provider, key, { writable: false, configurable: false });
    else Object.defineProperty(provider, key, { configurable: false });
  }
  Object.defineProperty(window, '__satoriGoEvmProvider', { value: provider, configurable: false, writable: false });

  // --- window.ethereum, as the user chose ----------------------------------
  try {
    if (takeDefault) {
      // The user picked Satori GO as the default: take window.ethereum and keep
      // it. A wallet injecting after us has its assignment ignored, and it
      // still reaches the site through EIP-6963.
      Object.defineProperty(window, 'ethereum', {
        get: () => provider,
        set: () => {
          /* another wallet's assignment is ignored */
        },
        configurable: false,
        enumerable: true,
      });
    } else if (!window.ethereum) {
      // No other wallet (yet): be window.ethereum, but writable, so a wallet the
      // user installed alongside can still take over when it loads.
      Object.defineProperty(window, 'ethereum', { value: provider, writable: true, configurable: true, enumerable: true });
    }
  } catch (err) {
    // Another wallet locked window.ethereum first. Satori GO stays reachable
    // through EIP-6963.
    console.debug('Satori GO: window.ethereum is held by another wallet', err);
  }

  // --- EIP-6963 announce ----------------------------------------------------
  // The spec wants the icon as a data URI (icons/icon32.png, inlined).
  const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAGiUlEQVR4nI1XfUhUWRRXpwgztTJRdpNoM3U3VzO0KAuCiIL+qP5p1yXon/6rIIqKiCKlVpIay5QVd3UzKvqgpC+ooA8pdgvEhIqg8GtsRmfHDJ1muh9z31nO9Z3Hm+lNeuDOvHffvef87vm+CQlxCAASAcBF76Ojoxmc81845w2MseeMsQ+cc4aDMeZljL3gnP/BOa/w+XyZNj4u5BVPjiMBQBIOfGaM5XHO64UQ/8E4GRCf9DchxDBjrJExVhDLb0ICc6HH40mWUlZFIpGwjbnyer3yzp076syZM0ZVVRXgqK2tNdra2pTH45FKKUVAIpHIFyll9eDgYIrJ2zWRcJf5/4NS6l9TsOKcyytXrqgNGzbA7NmzAZc4jbS0NFi7di2cP39ehUKhCO7VDJTqAIC8b4IA8wPnvEgp1W8Kl+3t7UZZWZkWkJiYqP+TkpI0kJycHJg7dy6kp6dbIGhNUVERPHjwADUhTRBeIUSpIwgw1Q4AuUqpPhJ+/PhxcLlcFvOCggKorKyER48eQW9vL3z69AlGRkbg/fv3cPfuXdi5cydkZ2dbQHAcOnRI8zJN4rP7BQnXHgoAyUqppyR8z549luCMjAw4ffo0hMPj7mAYX/shzQ0NDcGBAwcgJSUFpkyZovdv374dNRAxQbwIBAKplmww1aGUqiLh1dXVlvDFixfD27dvx51BKWSgBwqkZ5yXUlrzSO3t7VBRUQH5+fmaz8GDBy1NKKVqokwxNjb2k5RyFD8+fvzYmDZtmt60ZMkSGBwcHEclZdTJ8dk+7PO4Fqm7uxv2798Pc+bM0fxu3rypF0opQ5zzYssHpJR15ge5atUqvTgrKwvevHljCbfTeKQBXLt2DVpbW6PmiEgbfr9fmw95FhcXQzAY1KaQUjbR6TOFED6cvHr1qkGqd7vdjsLtp126dKl2TM65o28QKASzcuVKzbe5uZmSlT8UCn2PYfcrrd+8ebNelJeXpz38W0zRpgR2x44dcZ2TDnDp0iW9ds2aNZqNCWwrAqjHF8xwmZmZetHevXst5E6nDwQC2kQEYPr06dDf3+9oCtrj8Xhgy5YtsHDhQnj9+rVmLIT4EwH8gy/37t1TxPDGjRuOAIh5Z2cnkKNS4nny5InjHiIhBGBeQZO1trbqRYyxpwhgAF8aGhq0/ZOTk+Hly5dxT4NzOJYvX25pALPe58+fv4qIWC2cPXsWMKtWVlZqxpzzbgTwBV9OnDihmc2cORPevXvnCICEIx07dswCsG/fviiAsURzTU1NsGLFCti9ezdpRVkAampqNLPU1FQr/JyYvXr1Ci5cuGB5NY7S0lI4d+6c1pyTBohPS0sLlJeX2wEYCOCD3QQ47t+/H2VPYlBfXx9ld/ugOdRMLHgC1djYqE139OhRPcE570EAz2OdEM1hB0AMMO7x+9SpU3VFpPX4jHMUwk6aC4VCUFdXByUlJZgLNGPOuXbCBnzx+XxWGKJ6STAJZ4xpDyaB8TSA4YnCYvdjsuro6IDCwkLo6uqiMGxGAL+RqTZu3KiZYAnGkmtPJJiY5s+fPyEAzPuxSYw02dbWBsuWLdOy8CccDm9LGBoayhJC6Ipz+fJlyw+ws6GKh/Tx40eYN2/ehACwdA8PD1uC7ZGxfv16OHXqFBWkQDgczqFipM2ArReGCTE9efKk3uj1emFgYAByc3MnZQLMelhFMfmQBjFTrlu3DsHpEymlmq1qyDkvlFIG8cPDhw8NaiQwJ2zatEk3Fhg+GO/kJ05j1qxZOsRQe/b8QD7g9/v16ZVSGPolUb2gUup3c62kJEOeTadDE6CXxwOwYMECPegdNXb9+nWduk2TaHVIKd2WbDBbMr/fP0NK+YJA7Nq1ywKBGnCK/XgDTYSOTPUCawDKN0F0joyMpNvbwQTbJeRHpZSuDbgWe35qSvEfgdibVCfBsWuwbFM/qJQa4pz/HNWUEpEpQqFQGXavpAn0CewL7aagE9oHOSatwV7w9u3bVluO/aoQotwu6yuiD4yx/Egk0kGaYIzJixcvGuhc9jtA7MA6snr1at31jI2N4anp5F3BYHDRN4U73BFmYPdqeqzOK8irr69P3rp1K+J2u9WRI0fg8OHDGK54NYv09PRIwzBQKHk7k1LWGoaRNinhCTYQNiCLhBB/SSnHs8skLqdSyhEp5d94y4rlN2mKvZ4DQDbnfKsQooUx9gybCSynUkqDMdbLOX8mhECh2wDgO9s+vJ7HFf4/kqsGWdzc8xQAAAAASUVORK5CYII=';
  const info = Object.freeze({
    uuid: (crypto && crypto.randomUUID && crypto.randomUUID()) || `sgo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    name: 'Satori GO',
    icon: ICON,
    rdns: 'io.satorinet.go',
  });
  const announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  // Learn the starting chain (and accounts, when the site is already
  // connected) without prompting, so provider.chainId is set and 'connect' fires.
  send('eth_chainId', []).then(updateChain, () => undefined);
  send('eth_accounts', []).then(updateAccounts, () => undefined);

  window.dispatchEvent(new Event('ethereum#initialized'));
})();
