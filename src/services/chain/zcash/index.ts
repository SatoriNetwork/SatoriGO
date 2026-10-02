// The Zcash engine's public surface (the Zcash engine design notes §8, §15
// Set D). Unlike the Monero barrel this one is NOT the target of a
// flag-guarded dynamic import: the engine is pure TypeScript on packages the
// wallet already ships, touches no manifest host, adds no CSP directive and
// weighs about 60 KB minified, so it is a static import like a UTXO chain
// (§13). Nothing here reaches any host but the gateway (rpc.ts).
//
// Set A: keys, addresses, transactions. Set B: gateway client, reader, cache.
export * from './keys';
export * from './address';
export * from './tx';
export * from './sighash';
export * from './builder';
export * from './fees';
export * from './rpc';
export * from './reader';
export * from './historyCache';
