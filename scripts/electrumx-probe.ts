// IS THIS ElectrumX SERVER USABLE BY THIS WALLET, FOR THIS CHAIN?
//
//   npx vite-node scripts/electrumx-probe.ts -- <host> <port> <chainId> [tls]
//   npx vite-node scripts/electrumx-probe.ts -- 88.99.30.253 50011 neoxa-mainnet
//
// Written when the owner was handed a third-party Neoxa server and the honest
// answer to "will it work" was not "probably". It speaks the RAW Electrum
// protocol over TCP (newline-delimited JSON-RPC, which is what the gateway's
// bridge speaks upstream) and calls EVERY method this wallet actually uses,
// against a real address derived from the public BIP39 test vector.
//
// WHAT IT REFUSES TO ASSUME:
//
//   * That the server is on the chain it was advertised as. It compares
//     `server.features.genesis_hash` against the genesis this repo recorded from
//     the chain's own source. A DNS wildcard once answered for a coin that does
//     not exist and served Bitcoin's genesis (see the NEOX block in network.ts),
//     which is exactly the trap this check exists for.
//   * That an asset chain's server speaks the asset dialect. `blockchain.asset.
//     get_meta` for a name nobody has issued must answer "no such asset", NOT
//     "unknown method": the first is a server that understands assets, the
//     second is a plain server that would make every asset invisible.
//
// IT ANSWERS FOR THE MACHINE IT RUNS ON, WHICH IS THE WHOLE POINT AND ALSO THE
// TRAP. An ElectrumX server can be healthy for you and refuse the gateway: on
// 2026-08-28 both WojakCoin hosts answered this probe normally from a developer
// machine and answered from inside the gateway container with "excessive
// resource usage" (ElectrumX's per-source cost limit). Worse, they did not do
// it in step: one refused while the other answered, and twenty minutes later
// both refused, so a single reading from either vantage point supports a
// confident wrong conclusion. Probe from INSIDE the gateway, and more than
// once, before deciding an upstream is fine or broken:
//
//   ssh root@<gateway> "docker exec <gateway-container> node -e '...'"
//
// Read-only. It never broadcasts and never needs a key.

import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { networkFor, type LiveNetworkId } from '../src/services/chain/chainParams';
import { addressToElectrumScripthash, deriveAddress, mnemonicToSeed } from '../src/services/chain/keys';

/** The PUBLIC BIP39 test vector. Deliberately unfunded and known to everyone;
 *  it is here to produce a well-formed address of the right chain, nothing more. */
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * Genesis hash per chain, copied from the header blocks in chainParams.ts, which
 * in turn took each one from that chain's own `chainparams.cpp` assert.
 *
 * A LITERAL, never a computation: several of these chains hash their block
 * header with something other than sha256d (Neoxa uses X16R, Epix is not a UTXO
 * chain at all), so "verify by hashing block 0" would be wrong in a way that
 * looks right. The source of truth is the chain's own assert.
 */
const GENESIS: Record<string, string> = {
  'neoxa-mainnet': '0000000a50fdaaf22f1c98b8c61559e15ab2269249aa1fb20683180703cdbf07',
  'wojakcoin-mainnet': '000000004536a4f8fa9d88f0001ca9f9825f8d9fd3ba6383a2f030c0427bf085',
  'bitcoingold-mainnet': '0000000d1c5a497963a46c0348cb4346779c52d9e1d7cc8b5efb1be0a4a0f964',
  'litecoin-mainnet': '12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2',
  'dogecoin-mainnet': '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691',
  'bitcoin-mainnet': '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  // Evrmore and Ravencoin are ABSENT ON PURPOSE. This repo records no sourced
  // genesis for either, and the first draft of this file carried a guess for
  // both that was actually BitcoinGold's: it would have reported a healthy
  // Evrmore server as the wrong chain. Add them only from the chain's own
  // chainparams.cpp assert, the way every value above was taken.
};

interface Rpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
  close(): void;
}

/** Newline-delimited JSON-RPC over a socket, which is all Electrum-over-TCP is. */
function rpcOver(socket: Socket): Rpc {
  let nextId = 1;
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let cut: number;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') continue; // a subscription push
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error) waiter.fail(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else waiter.ok(msg.result);
    }
  });
  socket.on('error', (err) => {
    for (const w of pending.values()) w.fail(err);
    pending.clear();
  });
  return {
    call<T>(method: string, params: unknown[]): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }, 20_000);
        pending.set(id, {
          ok: (v) => {
            clearTimeout(timer);
            resolve(v as T);
          },
          fail: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    close: () => socket.destroy(),
  };
}

function open(host: string, port: number, tls: boolean): Promise<Rpc> {
  return new Promise((resolve, reject) => {
    const socket = tls
      ? // A third-party server's certificate is commonly self-signed. The
        // transport is not the trust boundary here: the genesis check below is.
        tlsConnect({ host, port, rejectUnauthorized: false }, () => resolve(rpcOver(socket)))
      : createConnection({ host, port }, () => resolve(rpcOver(socket)));
    socket.setTimeout(20_000);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error('connect timeout')));
  });
}

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

async function main() {
  const [host, portRaw, chainId, tlsRaw] = process.argv.slice(2);
  if (!host || !portRaw || !chainId) {
    console.error('usage: electrumx-probe.ts <host> <port> <chainId> [tls]');
    process.exit(2);
  }
  const port = Number(portRaw);
  const tls = tlsRaw === 'tls' || tlsRaw === 's';
  const net = networkFor(chainId as LiveNetworkId);
  console.log(`\n${net.displayName} (${net.ticker}) via ${tls ? 'ssl' : 'tcp'}://${host}:${port}\n`);

  const rpc = await open(host, port, tls);
  try {
    // 1. The handshake this wallet performs on every connection.
    const version = await rpc.call<[string, string]>('server.version', ['satori-go-probe', '1.4']);
    check(Array.isArray(version) && version.length === 2, `server.version -> ${JSON.stringify(version)}`);

    // 2. IS IT EVEN THE RIGHT CHAIN? Everything else is meaningless if not.
    const expected = GENESIS[chainId];
    let features: { genesis_hash?: string; hosts?: unknown; server_version?: string } = {};
    try {
      features = await rpc.call('server.features', []);
    } catch (err) {
      check(false, `server.features -> ${(err as Error).message}`);
    }
    if (expected) {
      check(
        typeof features.genesis_hash === 'string' &&
          features.genesis_hash.toLowerCase() === expected.toLowerCase(),
        `genesis_hash is ${net.displayName}'s -> ${features.genesis_hash ?? '(none)'}`,
      );
    } else {
      console.log(`SKIP  genesis check: no recorded genesis for ${chainId}`);
    }

    // 3. Is it synced, and how far?
    const head = await rpc.call<{ height: number; hex: string }>('blockchain.headers.subscribe', []);
    check(typeof head?.height === 'number' && head.height > 0, `tip height -> ${head?.height}`);

    // 4. Fees. The wallet asks for both; a server that answers neither leaves it
    //    on its floor, which is a degraded but survivable state.
    for (const [method, params] of [
      ['blockchain.relayfee', []],
      ['blockchain.estimatefee', [6]],
    ] as const) {
      try {
        const fee = await rpc.call<number>(method, [...params]);
        check(typeof fee === 'number', `${method} -> ${fee}`);
      } catch (err) {
        check(false, `${method} -> ${(err as Error).message}`);
      }
    }

    // 5. The three address reads every balance, history and send depends on,
    //    against a REAL address of this chain.
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    const { address } = deriveAddress(seed, net, 0, 0, 0);
    const sh = addressToElectrumScripthash(address);
    console.log(`\n  probe address ${address}\n  scripthash    ${sh}\n`);
    for (const method of [
      'blockchain.scripthash.get_balance',
      'blockchain.scripthash.get_history',
      'blockchain.scripthash.listunspent',
    ]) {
      try {
        const out = await rpc.call<unknown>(method, [sh]);
        check(out !== undefined, `${method} -> ${JSON.stringify(out).slice(0, 70)}`);
      } catch (err) {
        check(false, `${method} -> ${(err as Error).message}`);
      }
    }

    // 5b. THE ASSET-SCOPED READS, on a chain that HAS assets. On the Ravencoin/
    //     Evrmore dialect an asset balance is the SAME method with a second
    //     argument, and that is how this wallet reads every asset it shows. A
    //     server that serves the plain call but rejects the two-argument form
    //     would show correct coin balances and silently zero every asset.
    //
    //     GATED on the chain, and it was not at first: run against WojakCoin,
    //     which deliberately has no asset protocol, it reported two failures for
    //     a server that was working perfectly. A check that cannot be true for
    //     the chain under test is not a failing check, it is the wrong check.
    if (net.assetMarkerPrefix) {
      for (const method of [
        'blockchain.scripthash.get_balance',
        'blockchain.scripthash.listunspent',
      ]) {
        try {
          const out = await rpc.call<unknown>(method, [sh, 'SATORI-GO-PROBE-NO-SUCH-ASSET']);
          check(out !== undefined, `${method}(sh, asset) -> ${JSON.stringify(out).slice(0, 60)}`);
        } catch (err) {
          check(false, `${method}(sh, asset) -> ${(err as Error).message}`);
        }
      }
    } else {
      console.log('SKIP  asset-scoped reads: this chain has no asset protocol');
    }

    // 6. THE ASSET DIALECT, for a chain that has one. A name nobody has issued
    //    must come back empty; "unknown method" means a plain server, on which
    //    every asset this chain carries would simply be invisible.
    if (net.assetMarkerPrefix) {
      const bogus = 'SATORI-GO-PROBE-NO-SUCH-ASSET';
      try {
        const meta = await rpc.call<unknown>('blockchain.asset.get_meta', [bogus]);
        check(true, `blockchain.asset.get_meta answers (${JSON.stringify(meta)}) -> asset dialect present`);
      } catch (err) {
        const message = (err as Error).message;
        // A server that KNOWS the method and simply has no such asset may also
        // report it as an error; only "unknown method" proves the dialect absent.
        const unknown = /unknown method|not found|no such method|invalid method/i.test(message);
        check(!unknown, `blockchain.asset.get_meta -> ${message}`);
      }
    }

    // 7. Raw transaction reads: how the wallet verifies a prevout before signing.
    try {
      const hist = await rpc.call<Array<{ tx_hash: string }>>('blockchain.transaction.get', [
        head.hex ? '00'.repeat(32) : '00'.repeat(32),
      ]);
      check(false, `blockchain.transaction.get accepted a zero txid -> ${JSON.stringify(hist).slice(0, 60)}`);
    } catch (err) {
      // The EXPECTED outcome: it knows the method and refuses the bogus id.
      const message = (err as Error).message;
      const unknown = /unknown method|no such method|invalid method/i.test(message);
      check(!unknown, `blockchain.transaction.get is served (refused a bogus txid: ${message.slice(0, 60)})`);
    }
  } finally {
    rpc.close();
  }

  console.log(`\n${failures === 0 ? 'PROBE: server looks usable' : `PROBE: ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('PROBE FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
