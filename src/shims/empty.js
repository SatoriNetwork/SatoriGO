// Browser stand-in for the Node-only modules monero-ts names but never reaches
// in a browser: fs, path, child_process, web-worker, socks-proxy-agent, net,
// tls (aliased in vite.config.ts, the Monero engine design notes §6.1). Their
// only callers are Node branches (writing wallet files to disk, spawning
// monero-wallet-rpc, a SOCKS proxy, resolving the worker path from __dirname),
// guarded by GenUtils.isBrowser(). The few names below exist so a module-level
// read of them evaluates to something harmless instead of undefined.
const empty = {};
export default empty;
export const existsSync = () => false;
export const promises = {};
export const join = (...parts) => parts.join('/');
export const normalize = (p) => p;
export const dirname = (p) => String(p).replace(/\/[^/]*$/, '');
