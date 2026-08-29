// IS EVERY UTXO CHAIN REACHABLE THROUGH THE GATEWAY RIGHT NOW?
//
//   node scripts/gateway-bridge-check.mjs
//   node scripts/gateway-bridge-check.mjs neox        (one chain)
//
// Connects the way the WALLET connects: wss to the public gateway host, with
// the committed client token as the second WebSocket subprotocol. It is an
// operational check, not a test: it says what the bridge is doing at this
// moment, which is the question you actually have when a chain reads as
// offline and you need to know whether it is the wallet, the gateway or the
// upstream node.
//
// It also VERIFIES THE CHAIN'S IDENTITY where the genesis is known, because
// "the bridge answered" and "the bridge answered for the right chain" are
// different facts, and a misrouted upstream would look perfectly healthy on
// every other line of output.
//
// Read-only. No key, no broadcast.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = JSON.parse(readFileSync(path.join(root, 'platforms/evm-gateway.json'), 'utf8'));
const GATEWAY = (process.env.EVM_GATEWAY_URL || platform.gatewayUrl || '').replace(/\/+$/, '');
const TOKEN = process.env.EVM_CLIENT_TOKEN || platform.clientToken || '';

if (!GATEWAY) {
  console.error('No gateway URL: set EVM_GATEWAY_URL or platforms/evm-gateway.json.gatewayUrl');
  process.exit(2);
}

/**
 * Genesis per gateway chain key, from the header blocks in chainParams.ts (each
 * taken from that chain's own chainparams.cpp assert). A LITERAL, never derived
 * by hashing block 0: not every chain here hashes its header with sha256d.
 */
const GENESIS = {
  neox: '0000000a50fdaaf22f1c98b8c61559e15ab2269249aa1fb20683180703cdbf07',
  wjk: '000000004536a4f8fa9d88f0001ca9f9825f8d9fd3ba6383a2f030c0427bf085',
  btc: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  btgs: '0000000d1c5a497963a46c0348cb4346779c52d9e1d7cc8b5efb1be0a4a0f964',
  ltc: '12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2',
  doge: '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691',
  // evr and rvn are ABSENT ON PURPOSE. This repo records no sourced genesis for
  // either, and a value written here from memory is worse than none: the first
  // draft of this file carried a guess that was actually BitcoinGold's, and it
  // reported a healthy Evrmore bridge as WRONG CHAIN. Add them only from the
  // chain's own chainparams.cpp, the way network.ts documents every other one.
};

const CHAINS = ['evr', 'rvn', 'neox', 'btc', 'ltc', 'doge', 'btgs', 'wjk'];

function check(chain) {
  return new Promise((resolve) => {
    const out = { chain };
    const t0 = Date.now();
    const ws = new WebSocket(`${GATEWAY}/electrum/${chain}`, ['satori-v1', TOKEN]);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(out);
    };
    const timer = setTimeout(() => {
      out.error = 'timeout';
      finish();
    }, 20_000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'server.version', params: ['satori-go-check', '1.4'] }));
      ws.send(JSON.stringify({ id: 2, method: 'blockchain.headers.subscribe', params: [] }));
      ws.send(JSON.stringify({ id: 3, method: 'server.features', params: [] }));
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.id === 1) out.server = Array.isArray(msg.result) ? msg.result[0] : String(msg.result);
      if (msg.id === 3) out.genesis = msg.result?.genesis_hash;
      if (msg.id === 2 && typeof msg.result?.height === 'number') {
        out.height = msg.result.height;
        out.ms = Date.now() - t0;
      }
      // Wait for the tip AND (when the server serves it) the identity.
      if (out.height !== undefined && (out.genesis !== undefined || out.featuresFailed)) finish();
    };
    ws.onerror = () => {
      out.error = out.error ?? 'refused (no upstream, or the gateway is down)';
      finish();
    };
    ws.onclose = (e) => {
      if (!out.height) out.error = out.error ?? `closed ${e.code}`;
      finish();
    };
  });
}

const only = process.argv[2];
const list = only ? CHAINS.filter((c) => c === only) : CHAINS;
if (list.length === 0) {
  console.error(`unknown chain "${only}". Known: ${CHAINS.join(', ')}`);
  process.exit(2);
}

console.log(`\n${GATEWAY}\n`);
let bad = 0;
for (const chain of list) {
  const r = await check(chain);
  if (r.error) {
    bad++;
    console.log(`${chain.padEnd(5)} FAIL  ${r.error}`);
    continue;
  }
  const expected = GENESIS[chain];
  // A server that does not publish genesis_hash (ElectrumX Evrmore reports all
  // zeros) leaves the identity UNVERIFIED, which is not the same as wrong and
  // must not be reported as it.
  const published = r.genesis && !/^0+$/.test(r.genesis) ? r.genesis : null;
  // A wrong genesis is WORSE than an outage: the chain looks healthy while
  // every balance on it belongs to a different network.
  const wrongChain = Boolean(expected && published && published.toLowerCase() !== expected.toLowerCase());
  const unverified = !expected || !published;
  if (wrongChain) bad++;
  console.log(
    `${chain.padEnd(5)} ${wrongChain ? 'WRONG CHAIN' : 'OK   '} ${String(r.server ?? '?').padEnd(26)} ` +
      `tip ${String(r.height).padEnd(9)} ${String(r.ms).padStart(5)}ms` +
      (wrongChain ? `  genesis ${r.genesis}` : unverified ? '  (identity unverified)' : ''),
  );
}
console.log(`\n${bad === 0 ? 'all bridges healthy' : `${bad} chain(s) unhealthy`}\n`);
process.exit(bad === 0 ? 0 : 1);
