import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LiveWalletService, BroadcastGatedError } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { ELECTRUM_METHODS } from './network';
import { deriveAddress, mnemonicToSeed, decodeWif, addressToHash160, p2pkhScript } from './keys';
import { EVRMORE_MAINNET, RAVENCOIN_MAINNET } from './chainParams';
import { createVault } from './vault';
import { buildTransferAssetScriptFromHash160 } from './assetScript';
import { verifyMessage } from './message';
import type { ElectrumClient } from './electrumTypes';
import { txid as computeTxid } from './txBuilder';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/** The index-0 P2PKH scriptPubKey hex for VECTOR_MNEMONIC (owns the test UTXOs). */
async function vectorP2pkhScriptHex(index = 0): Promise<string> {
  const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
  const addr = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, index).address;
  return bytesToHex(p2pkhScript(addressToHash160(addr).hash));
}

/** The index-0 hash160 for VECTOR_MNEMONIC (owns the test asset UTXOs). */
async function vectorHash160(index = 0): Promise<Uint8Array> {
  const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
  const addr = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, index).address;
  return addressToHash160(addr).hash;
}

/** VECTOR_MNEMONIC index-0 P2PKH scriptPubKey hex; populated in beforeAll so the
 *  synchronous fakeClient default embeds the OWNING address's real script (which
 *  verifyInputAmounts now byte-checks for EVR inputs). */
let ANY_P2PKH = '';

const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// A valid Evrmore address used as a send recipient (any valid E-address works).
const RECIPIENT = 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF';

/** The address the service MUST derive for VECTOR_MNEMONIC (no passphrase),
 *  computed independently via the keys module — proves service↔keys integration. */
async function expectedWalletAddress(): Promise<string> {
  const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
  return deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address;
}

type Utxo = { tx_hash: string; tx_pos: number; height: number; value: number };

/** Minimal legacy raw-tx parser — just enough to read the outputs (count + value)
 *  of a produced transaction. Inputs use empty-then-signed scriptSigs of varint
 *  length; outputs are value(8) + varint(scriptLen) + script. */
function parseRawTx(rawHex: string): { outputs: { valueSats: bigint }[] } {
  const bytes = new Uint8Array((rawHex.match(/../g) as string[]).map((h) => parseInt(h, 16)));
  let off = 0;
  const readVarint = (): number => {
    const first = bytes[off++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = bytes[off] | (bytes[off + 1] << 8);
      off += 2;
      return v;
    }
    if (first === 0xfe) {
      const v = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
      off += 4;
      return v;
    }
    throw new Error('64-bit varint not supported in test parser');
  };
  off += 4; // version
  const numInputs = readVarint();
  for (let i = 0; i < numInputs; i++) {
    off += 36; // outpoint (txid 32 + vout 4)
    const scriptLen = readVarint();
    off += scriptLen + 4; // scriptSig + sequence
  }
  const numOutputs = readVarint();
  const outputs: { valueSats: bigint }[] = [];
  for (let i = 0; i < numOutputs; i++) {
    let v = 0n;
    for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(bytes[off + b]);
    off += 8;
    const scriptLen = readVarint();
    off += scriptLen;
    outputs.push({ valueSats: v });
  }
  return { outputs };
}

/** 8-byte little-endian hex of a sats amount. */
function u64le(n: bigint): string {
  let s = '';
  for (let i = 0n; i < 8n; i++) s += Number((n >> (8n * i)) & 0xffn).toString(16).padStart(2, '0');
  return s;
}

/** One raw-tx output as hex: 8-byte nValue + varint scriptLen + scriptPubKey. */
function outputHex(valueSats: bigint, scriptHex: string): string {
  const bytes = scriptHex.length / 2;
  return u64le(valueSats) + bytes.toString(16).padStart(2, '0') + scriptHex;
}

/**
 * A minimal VALID legacy raw tx: 1 (null) input whose prevout hash is `seedHash`
 * (so distinct seeds => distinct txids), then `count` outputs. The output at
 * `valueAt` carries `valueSats` under `scriptHex`; every other output is a 0-value
 * OP_TRUE. Its double-sha256 txid backs a coherent prevout that verifyInputAmounts
 * can fetch, hash, AND now script-check.
 *
 * REAL SHAPE: for an EVR UTXO pass the owning address's P2PKH scriptPubKey (that
 * is what the wallet reconstructs as SignableUtxo.scriptPubKeyHex). For an ASSET
 * UTXO pass valueSats=0 and the OP_EVR_ASSET transfer script (the asset amount
 * lives INSIDE the script; on-chain nValue is 0 — proven live in
 * scripts/verify-utxo-probe.ts).
 */
function makePrevoutRaw(
  seedHash: string,
  count: number,
  valueAt: number,
  valueSats: bigint,
  scriptHex: string,
): string {
  const seed = /^[0-9a-f]{64}$/i.test(seedHash) ? seedHash : '00'.repeat(32);
  let hex = '02000000' + '01' + seed + '00000000' + '00' + 'ffffffff';
  hex += count.toString(16).padStart(2, '0'); // vout count (varint; count < 253)
  for (let i = 0; i < count; i++) {
    hex += i === valueAt ? outputHex(valueSats, scriptHex) : outputHex(0n, '51');
  }
  return hex + '00000000'; // nLockTime
}

/** Turn caller EVR UTXOs into coherent ones (real txid = hash of a served
 *  prevout), embedding `p2pkhHex` as the value output's real scriptPubKey and
 *  registering each raw hex in `raws` for blockchain.transaction.get. */
function coherentUtxos(utxos: Utxo[], raws: Map<string, string>, p2pkhHex: string): Utxo[] {
  return utxos.map((u) => {
    const raw = makePrevoutRaw(u.tx_hash, u.tx_pos + 1, u.tx_pos, BigInt(u.value), p2pkhHex);
    const id = computeTxid(raw);
    raws.set(id, raw);
    return { ...u, tx_hash: id };
  });
}

/** Turn caller ASSET UTXOs into coherent ones the REAL way: nValue=0 and the
 *  OP_EVR_ASSET transfer script (amount encoded in-script) for `assetName` at the
 *  owning `hash160`. Matches how a live asset prevout looks (verify-utxo-probe). */
function coherentAssetUtxos(
  utxos: Utxo[],
  raws: Map<string, string>,
  hash160: Uint8Array,
  assetName: string,
): Utxo[] {
  return utxos.map((u) => {
    const script = bytesToHex(
      buildTransferAssetScriptFromHash160(hash160, assetName, BigInt(u.value)),
    );
    const raw = makePrevoutRaw(u.tx_hash, u.tx_pos + 1, u.tx_pos, 0n, script);
    const id = computeTxid(raw);
    raws.set(id, raw);
    return { ...u, tx_hash: id };
  });
}

function fakeClient(
  utxos: Utxo[],
  p2pkhHex = ANY_P2PKH,
): ElectrumClient & { broadcasted: string[] } {
  const broadcasted: string[] = [];
  const raws = new Map<string, string>();
  const coherent = coherentUtxos(utxos, raws, p2pkhHex);
  return {
    broadcasted,
    connect: async () => {},
    isConnected: () => true,
    endpoint: () => 'wss://fake',
    close: () => {},
    request: async (method: string, params: unknown[] = []) => {
      if (method === ELECTRUM_METHODS.estimateFee) return 0.001 as never; // EVR/kB
      if (method === ELECTRUM_METHODS.listUnspent) {
        const asset = params[1];
        return (asset ? [] : coherent) as never;
      }
      if (method === ELECTRUM_METHODS.txGet) {
        const raw = raws.get(params[0] as string);
        if (!raw) throw new Error(`no prevout for ${String(params[0])}`);
        return raw as never;
      }
      if (method === ELECTRUM_METHODS.txBroadcast) {
        broadcasted.push(params[0] as string);
        return computeTxid(params[0] as string) as never;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

/** Fake client that also serves asset listunspent + asset.get_meta, for asset
 *  sends. Builds asset prevouts the REAL way (nValue=0, amount in the OP_EVR_ASSET
 *  script) for `assetName` owned by the VECTOR_MNEMONIC index-0 address. */
async function assetFakeClient(
  evrUtxos: Utxo[],
  assetUtxos: Utxo[],
  meta: { divisions: number; exists?: boolean },
  assetName: string,
): Promise<ElectrumClient & { broadcasted: string[] }> {
  const broadcasted: string[] = [];
  const raws = new Map<string, string>();
  const p2pkhHex = await vectorP2pkhScriptHex(0);
  const h160 = await vectorHash160(0);
  const coherentEvr = coherentUtxos(evrUtxos, raws, p2pkhHex);
  const coherentAsset = coherentAssetUtxos(assetUtxos, raws, h160, assetName.toUpperCase());
  return {
    broadcasted,
    connect: async () => {},
    isConnected: () => true,
    endpoint: () => 'wss://fake',
    close: () => {},
    request: async (method: string, params: unknown[] = []) => {
      if (method === ELECTRUM_METHODS.estimateFee) return 0.001 as never;
      if (method === ELECTRUM_METHODS.listUnspent) {
        return (params[1] ? coherentAsset : coherentEvr) as never;
      }
      if (method === ELECTRUM_METHODS.assetGetMeta) {
        if (meta.exists === false) return {} as never;
        return {
          sats_in_circulation: 103389600000000,
          divisions: meta.divisions,
          reissuable: true,
          has_ipfs: false,
        } as never;
      }
      if (method === ELECTRUM_METHODS.txGet) {
        const raw = raws.get(params[0] as string);
        if (!raw) throw new Error(`no prevout for ${String(params[0])}`);
        return raw as never;
      }
      if (method === ELECTRUM_METHODS.txBroadcast) {
        broadcasted.push(params[0] as string);
        return computeTxid(params[0] as string) as never;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

beforeAll(async () => {
  ANY_P2PKH = await vectorP2pkhScriptHex(0);
});

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

describe('LiveWalletService', () => {
  it('creates a wallet, returns a valid mnemonic, and re-unlocks it', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    expect(await svc.exists()).toBe(false);
    const { mnemonic } = await svc.create('pw-strong-1');
    expect(mnemonic.split(' ').length).toBe(12);
    expect(await svc.exists()).toBe(true);
    expect(svc.isUnlocked()).toBe(true);
    const addr = svc.getAddress(0);
    expect(addr.startsWith('E')).toBe(true);

    const svc2 = new LiveWalletService(fakeClient([]));
    expect(await svc2.unlock('pw-strong-1')).toBe(true);
    expect(svc2.getAddress(0)).toBe(addr);
  });

  it('derives the address the keys module derives for the same mnemonic', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.import(VECTOR_MNEMONIC, 'pw');
    expect(svc.getAddress(0)).toBe(await expectedWalletAddress());
  });

  it('rejects an invalid mnemonic and a wrong unlock password', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await expect(svc.import('not a valid phrase at all', 'pw')).rejects.toThrow();
    await svc.import(VECTOR_MNEMONIC, 'right-pw');
    const svc2 = new LiveWalletService(fakeClient([]));
    expect(await svc2.unlock('wrong-pw')).toBe(false);
    expect(svc2.isUnlocked()).toBe(false);
  });

  it('builds + signs a real EVR send from synthetic UTXOs (no broadcast)', async () => {
    const client = fakeClient([{ tx_hash: 'a'.repeat(64), tx_pos: 0, height: 1900000, value: 100_000_000 }]);
    const svc = new LiveWalletService(client);
    await svc.import(VECTOR_MNEMONIC, 'pw');
    const plan = await svc.buildEvrSend(RECIPIENT, 40_000_000n);
    expect(plan.built.rawHex).toMatch(/^02000000/);
    expect(plan.built.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.feeSats).toBeGreaterThan(0n);
    expect(client.broadcasted).toHaveLength(0);
  });

  it('Max send: estimateMaxEvr then buildEvrSend(maxSats) succeeds with NO change output', async () => {
    // The "Max" flow: estimate the sendable max (total − 1-output fee), fill that
    // amount, and build. Before the send-max fallback this always failed with
    // insufficient-funds because selectCoins budgeted for a change output.
    const total = 100_000_000n; // 1 EVR in a single UTXO
    const client = fakeClient([{ tx_hash: 'a'.repeat(64), tx_pos: 0, height: 1900000, value: Number(total) }]);
    const svc = new LiveWalletService(client);
    await svc.import(VECTOR_MNEMONIC, 'pw');

    const est = await svc.estimateMaxEvr();
    expect(est.totalSats).toBe(total);
    expect(est.maxSats).toBe(total - est.feeSats);
    expect(est.maxSats).toBeGreaterThan(0n);

    const plan = await svc.buildEvrSend(RECIPIENT, est.maxSats);

    // The built tx spends the whole input into ONE recipient output — no change.
    const parsed = parseRawTx(plan.built.rawHex);
    expect(parsed.outputs.length).toBe(1);
    expect(parsed.outputs[0].valueSats).toBe(est.maxSats);

    // The realized fee equals the Max estimate, and in == out + fee.
    expect(plan.feeSats).toBe(est.feeSats);
    expect(est.maxSats + plan.feeSats).toBe(total);
    expect(client.broadcasted).toHaveLength(0);
  });

  it('caps the fee against a hostile Electrum estimatefee (prevents a drain)', async () => {
    // A malicious/MITM'd server returns an absurd estimatefee (EVR/kB) trying to
    // make the fee eat the whole 10 EVR balance. The rate cap must bound the real
    // fee to a few hundred k sats and return the change to us — not absorb it.
    const raws = new Map<string, string>();
    const utxos = coherentUtxos(
      [{ tx_hash: 'a'.repeat(64), tx_pos: 0, height: 1, value: 1_000_000_000 }], // 10 EVR (honest)
      raws,
      await vectorP2pkhScriptHex(0),
    );
    const hostile: ElectrumClient = {
      connect: async () => {},
      isConnected: () => true,
      endpoint: () => 'wss://fake',
      close: () => {},
      request: async (method: string, params: unknown[] = []) => {
        if (method === ELECTRUM_METHODS.estimateFee) return 100000 as never; // 100000 EVR/kB (insane)
        if (method === ELECTRUM_METHODS.listUnspent) {
          return (params[1] ? [] : utxos) as never;
        }
        if (method === ELECTRUM_METHODS.txGet) {
          const raw = raws.get(params[0] as string);
          if (!raw) throw new Error(`no prevout for ${String(params[0])}`);
          return raw as never;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const svc = new LiveWalletService(hostile);
    await svc.import(VECTOR_MNEMONIC, 'pw');
    const plan = await svc.buildEvrSend(RECIPIENT, 100_000_000n); // send 1 EVR
    // Fee is clamped to a few hundred-k sats — NOT ~9 EVR — well under the ceiling.
    expect(plan.feeSats).toBeLessThan(1_000_000n); // < 0.01 EVR
  });

  it('rejects an EVR amount of 0 or less', async () => {
    const svc = new LiveWalletService(fakeClient([{ tx_hash: 'a'.repeat(64), tx_pos: 0, height: 1, value: 100_000_000 }]));
    await svc.import(VECTOR_MNEMONIC, 'pw');
    await expect(svc.buildEvrSend(RECIPIENT, 0n)).rejects.toThrow('invalid-amount');
    await expect(svc.buildEvrSend(RECIPIENT, -5n)).rejects.toThrow('invalid-amount');
  });

  it('enforces the broadcast gate', async () => {
    const client = fakeClient([{ tx_hash: 'b'.repeat(64), tx_pos: 1, height: 1900000, value: 100_000_000 }]);
    const svc = new LiveWalletService(client);
    await svc.import(VECTOR_MNEMONIC, 'pw');
    const plan = await svc.buildEvrSend(RECIPIENT, 10_000_000n);

    await expect(svc.broadcast(plan.built.rawHex)).rejects.toBeInstanceOf(BroadcastGatedError);
    expect(client.broadcasted).toHaveLength(0);

    svc.allowBroadcast = true;
    const txid = await svc.broadcast(plan.built.rawHex);
    expect(txid).toBe(plan.built.txid);
    expect(client.broadcasted).toEqual([plan.built.rawHex]);
  });

  describe('broadcast outcome verification', () => {
    // Arbitrary but well-formed hex; broadcast() only hashes it locally (txid)
    // and hands it to the server — its transactional validity is irrelevant here.
    const RAW_HEX = '0200000001' + 'ab'.repeat(60);
    const EXPECTED_TXID = computeTxid(RAW_HEX);

    /** A minimal ElectrumClient whose txBroadcast/txGet behaviour is fully
     *  scripted, so each test can exercise a specific outcome path without
     *  needing a real wallet/UTXO set (broadcast() never touches those). */
    function outcomeClient(opts: {
      broadcastError?: Error;
      /** How many leading txGet calls throw "not found" before it succeeds.
       *  Omit to always throw (never confirms). */
      txGetSucceedsOnCall?: number;
    }): ElectrumClient & { broadcastCalls: string[]; txGetCalls: string[] } {
      const broadcastCalls: string[] = [];
      const txGetCalls: string[] = [];
      return {
        broadcastCalls,
        txGetCalls,
        connect: async () => {},
        isConnected: () => true,
        endpoint: () => 'wss://fake',
        close: () => {},
        request: async (method: string, params: unknown[] = []) => {
          if (method === ELECTRUM_METHODS.txBroadcast) {
            broadcastCalls.push(params[0] as string);
            if (opts.broadcastError) throw opts.broadcastError;
            return computeTxid(params[0] as string) as never;
          }
          if (method === ELECTRUM_METHODS.txGet) {
            txGetCalls.push(params[0] as string);
            const succeedsOn = opts.txGetSucceedsOnCall;
            if (succeedsOn !== undefined && txGetCalls.length >= succeedsOn) {
              return '02000000...' as never; // raw hex; broadcast() only cares that this resolved
            }
            throw new Error('Electrum error: no such transaction (code 2)');
          }
          throw new Error(`unexpected method ${method}`);
        },
      };
    }

    it('(a) success path is unchanged: no polling on a clean broadcast', async () => {
      const client = outcomeClient({});
      const svc = new LiveWalletService(client, { broadcastPollDelaysMs: [1, 1, 1] });
      svc.allowBroadcast = true;
      const txid = await svc.broadcast(RAW_HEX);
      expect(txid).toBe(EXPECTED_TXID);
      expect(client.broadcastCalls).toEqual([RAW_HEX]);
      expect(client.txGetCalls).toHaveLength(0); // no outcome check needed
    });

    it('(b) a clean code-1 rejection is rethrown immediately, with NO polling', async () => {
      const rejection = new Error(
        'Electrum error: the transaction was rejected by network rules.\n\ndust output (code 1)',
      );
      const client = outcomeClient({ broadcastError: rejection });
      const svc = new LiveWalletService(client, { broadcastPollDelaysMs: [1, 1, 1] });
      svc.allowBroadcast = true;
      await expect(svc.broadcast(RAW_HEX)).rejects.toBe(rejection);
      expect(client.txGetCalls).toHaveLength(0); // definitively "not sent" — never polls
    });

    it('(c) a -32603 crash followed by transaction.get finding the tx resolves with the txid', async () => {
      const crash = new Error('Electrum error: internal server error (code -32603)');
      // Confirms on the 2nd poll attempt: not found once, then found.
      const client = outcomeClient({ broadcastError: crash, txGetSucceedsOnCall: 2 });
      const svc = new LiveWalletService(client, { broadcastPollDelaysMs: [1, 1, 1, 1] });
      svc.allowBroadcast = true;
      const txid = await svc.broadcast(RAW_HEX);
      // The send actually worked — resolves with success, not an error.
      expect(txid).toBe(EXPECTED_TXID);
      expect(client.txGetCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('(d) a -32603 crash whose tx never appears throws broadcast-unconfirmed after the attempts', async () => {
      const crash = new Error('Electrum error: internal server error (code -32603)');
      // txGetSucceedsOnCall omitted: transaction.get always throws "not found".
      const client = outcomeClient({ broadcastError: crash });
      const delays = [1, 1, 1, 1, 1, 1, 1, 1]; // 8 attempts, matching the production count
      const svc = new LiveWalletService(client, { broadcastPollDelaysMs: delays });
      svc.allowBroadcast = true;
      await expect(svc.broadcast(RAW_HEX)).rejects.toThrow('broadcast-unconfirmed');
      expect(client.txGetCalls).toHaveLength(delays.length);
    });

    it('(e) the poll looks up the LOCALLY computed txid, never one from the server', async () => {
      const crash = new Error('Electrum error: internal server error (code -32603)');
      const client = outcomeClient({ broadcastError: crash, txGetSucceedsOnCall: 1 });
      const svc = new LiveWalletService(client, { broadcastPollDelaysMs: [1] });
      svc.allowBroadcast = true;
      await svc.broadcast(RAW_HEX);
      expect(client.txGetCalls).toEqual([EXPECTED_TXID]);
      expect(EXPECTED_TXID).toBe(computeTxid(RAW_HEX)); // sanity: matches the raw hex's real hash
    });

    it('a timeout/connection-drop style error is also treated as UNKNOWN (polls, then confirms)', async () => {
      const dropped = new Error('WebSocket closed with request pending');
      const client = outcomeClient({ broadcastError: dropped, txGetSucceedsOnCall: 1 });
      const svc = new LiveWalletService(client, { broadcastPollDelaysMs: [1] });
      svc.allowBroadcast = true;
      const txid = await svc.broadcast(RAW_HEX);
      expect(txid).toBe(EXPECTED_TXID);
    });
  });

  it('throws insufficient-funds when there are no UTXOs', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.import(VECTOR_MNEMONIC, 'pw');
    await expect(svc.buildEvrSend(RECIPIENT, 5_000_000n)).rejects.toThrow('insufficient-funds');
  });

  it('builds + signs an asset (SATORIEVR) transfer with asset change and an EVR fee', async () => {
    const evrUtxos = [{ tx_hash: 'a'.repeat(64), tx_pos: 0, height: 1900000, value: 100_000_000 }];
    // 500 SATORIEVR held (× 1e8 base units); send 100, expect 400 asset change.
    const assetUtxos = [{ tx_hash: 'c'.repeat(64), tx_pos: 1, height: 1900000, value: 50_000_000_000 }];
    const client = await assetFakeClient(evrUtxos, assetUtxos, { divisions: 8 }, 'SATORIEVR');
    const svc = new LiveWalletService(client);
    await svc.import(VECTOR_MNEMONIC, 'pw');

    const plan = await svc.buildAssetSend(RECIPIENT, 'SATORIEVR', 10_000_000_000n); // 100 SATORIEVR
    expect(plan.assetName).toBe('SATORIEVR');
    expect(plan.assetDecimals).toBe(8);
    expect(plan.built.rawHex).toMatch(/^02000000/);
    expect(plan.built.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.feeSats).toBeGreaterThan(0n);
    // The asset transfer marker "evrt" (hex 65767274) must appear in the tx.
    expect(plan.built.rawHex).toContain('65767274');
    expect(client.broadcasted).toHaveLength(0);
  });

  it('rejects an asset send when the server OVER-REPORTS the asset UTXO amount (anti-drain)', async () => {
    // The wallet needs 100 SATORIEVR. The server LIES that a single UTXO holds 100
    // (10_000_000_000 base units), but the authentic prevout's OP_EVR_ASSET script
    // encodes only 10 (1_000_000_000). Coin selection would trust the lie, under-
    // fund the send, and (post-broadcast) the tx would be invalid / lose value —
    // the asset-script binding must catch the amount mismatch and abort.
    const evrUtxos = [{ tx_hash: 'a'.repeat(64), tx_pos: 0, height: 1900000, value: 100_000_000 }];
    const raws = new Map<string, string>();
    const p2pkhHex = await vectorP2pkhScriptHex(0);
    const h160 = await vectorHash160(0);
    const coherentEvr = coherentUtxos(evrUtxos, raws, p2pkhHex);
    // REAL prevout encodes only 10 units in its script.
    const realAsset = coherentAssetUtxos(
      [{ tx_hash: 'c'.repeat(64), tx_pos: 1, height: 1900000, value: 1_000_000_000 }],
      raws,
      h160,
      'SATORIEVR',
    )[0];
    const client: ElectrumClient = {
      connect: async () => {},
      isConnected: () => true,
      endpoint: () => 'wss://fake',
      close: () => {},
      request: async (method: string, params: unknown[] = []) => {
        if (method === ELECTRUM_METHODS.estimateFee) return 0.001 as never;
        if (method === ELECTRUM_METHODS.assetGetMeta) {
          return { sats_in_circulation: 1e14, divisions: 8, reissuable: true, has_ipfs: false } as never;
        }
        if (method === ELECTRUM_METHODS.listUnspent) {
          // Asset query: LIE that this outpoint holds 100 units (10_000_000_000).
          if (params[1]) {
            return [{ ...realAsset, value: 10_000_000_000 }] as never;
          }
          return coherentEvr as never;
        }
        if (method === ELECTRUM_METHODS.txGet) {
          const raw = raws.get(params[0] as string);
          if (!raw) throw new Error(`no prevout for ${String(params[0])}`);
          return raw as never;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const svc = new LiveWalletService(client);
    await svc.import(VECTOR_MNEMONIC, 'pw');
    await expect(svc.buildAssetSend(RECIPIENT, 'SATORIEVR', 10_000_000_000n)).rejects.toThrow(
      'input-value-mismatch',
    );
  });

  it('rejects an asset amount finer than the asset divisions', async () => {
    const evrUtxos = [{ tx_hash: 'a'.repeat(64), tx_pos: 0, height: 1900000, value: 100_000_000 }];
    const assetUtxos = [{ tx_hash: 'c'.repeat(64), tx_pos: 1, height: 1900000, value: 500_000_000 }];
    const client = await assetFakeClient(evrUtxos, assetUtxos, { divisions: 0 }, 'CHUPPA_CHUB'); // whole units only
    const svc = new LiveWalletService(client);
    await svc.import(VECTOR_MNEMONIC, 'pw');
    // 1.5 units of a 0-division asset = 150000000 base units, not a multiple of 1e8.
    await expect(svc.buildAssetSend(RECIPIENT, 'CHUPPA_CHUB', 150_000_000n)).rejects.toThrow('invalid-amount-precision');
  });

  it('rejects sending an asset that does not exist on-chain', async () => {
    const client = await assetFakeClient([], [], { divisions: 8, exists: false }, 'NOPE');
    const svc = new LiveWalletService(client);
    await svc.import(VECTOR_MNEMONIC, 'pw');
    await expect(svc.buildAssetSend(RECIPIENT, 'NOPE', 100_000_000n)).rejects.toThrow('unknown-asset');
  });

  it('verifyPassword accepts the correct password and rejects a wrong one', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.import(VECTOR_MNEMONIC, 'pw-correct-123');
    expect(await svc.verifyPassword('pw-correct-123')).toBe(true);
    expect(await svc.verifyPassword('pw-wrong')).toBe(false);
  });

  it('imports a private key (WIF) as a single-address pk-wallet matching the source address', async () => {
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    const derived = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0);
    const svc = new LiveWalletService(fakeClient([]));
    await svc.importPrivateKey(derived.wif, 'pw-strong');
    expect(svc.getAddress(0)).toBe(derived.address);
    // A pk-wallet has exactly ONE address — index is ignored.
    expect(svc.getAddress(7)).toBe(derived.address);
    const list = await svc.listWallets();
    expect(list[0].kind).toBe('pk');
    expect(list[0].address).toBe(derived.address);
  });

  it('pk-wallet reveals its private key (WIF) but has no recovery phrase', async () => {
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    const derived = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0);
    const svc = new LiveWalletService(fakeClient([]));
    await svc.importPrivateKey(derived.wif, 'pw-strong');
    expect(await svc.revealMnemonic('pw-strong')).toBeNull(); // no seed phrase
    expect(await svc.revealPrivateKeyWif('pw-strong')).toBe(derived.wif);
    expect(await svc.revealPrivateKeyWif('wrong')).toBeNull();
  });

  it('rejects an invalid private key on import', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await expect(svc.importPrivateKey('not-a-real-key', 'pw-strong')).rejects.toThrow();
  });

  it('creates a passwordless wallet: unlocks, verifies and reveals without a password', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.create(''); // empty password => passwordless
    const list = await svc.listWallets();
    expect(list[0].passwordless).toBe(true);
    expect(await svc.verifyPassword('literally anything')).toBe(true);
    // Re-open in a fresh service: a passwordless wallet unlocks with no password.
    const svc2 = new LiveWalletService(fakeClient([]));
    expect(await svc2.unlock('')).toBe(true);
    expect(svc2.getAddress(0).startsWith('E')).toBe(true);
    expect((await svc2.revealMnemonic('')) ?? '').toMatch(/\w+ \w+/);
  });

  it('can add a password to a passwordless wallet (and then it is required)', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.create('');
    expect((await svc.listWallets())[0].passwordless).toBe(true);
    expect(await svc.changePassword('', 'now-secured-1')).toBe(true);
    expect((await svc.listWallets())[0].passwordless).toBe(false);
    const svc2 = new LiveWalletService(fakeClient([]));
    expect(await svc2.unlock('now-secured-1')).toBe(true);
    const svc3 = new LiveWalletService(fakeClient([]));
    expect(await svc3.unlock('')).toBe(false);
  });

  it('adds receive addresses (persisted) and lists them; pk wallets stay single-address', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.import(VECTOR_MNEMONIC, 'pw');
    expect((await svc.listAddresses()).length).toBe(1);
    const added = await svc.addReceiveAddress();
    expect(added.index).toBe(1);
    const list = await svc.listAddresses();
    expect(list.length).toBe(2);
    expect(list[0].address).not.toBe(list[1].address);
    // Matches direct derivation at index 1.
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    expect(list[1].address).toBe(deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 1).address);

    // The count persists across a fresh service + unlock.
    const svc2 = new LiveWalletService(fakeClient([]));
    expect(await svc2.unlock('pw')).toBe(true);
    expect((await svc2.listAddresses()).length).toBe(2);

    // pk wallets are single-address by construction.
    const derived = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0);
    const svcPk = new LiveWalletService(fakeClient([]));
    await svcPk.importPrivateKey(derived.wif, 'pw');
    expect((await svcPk.listAddresses()).length).toBe(1);
    await expect(svcPk.addReceiveAddress()).rejects.toThrow('single-address-wallet');
  });

  it('buildEvrSend spends UTXOs gathered across ALL derived addresses', async () => {
    // Two addresses, each with 0.6 EVR. A 1.0 EVR send needs BOTH (either alone
    // is insufficient), proving multi-address gathering + per-UTXO key signing.
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    const addr0 = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address;
    const addr1 = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 1).address;
    const { addressToElectrumScripthash } = await import('./keys');
    // Coherent prevouts (distinct seeds -> distinct real txids) so both inputs
    // pass verifyInputAmounts and their (reversed) txids appear in the raw tx.
    const raws = new Map<string, string>();
    const p2pkh0 = bytesToHex(p2pkhScript(addressToHash160(addr0).hash));
    const p2pkh1 = bytesToHex(p2pkhScript(addressToHash160(addr1).hash));
    const u0 = coherentUtxos([{ tx_hash: 'a'.repeat(64), tx_pos: 0, height: 1, value: 60_000_000 }], raws, p2pkh0)[0];
    const u1 = coherentUtxos([{ tx_hash: 'b'.repeat(64), tx_pos: 0, height: 1, value: 60_000_000 }], raws, p2pkh1)[0];
    const utxosBySh: Record<string, Utxo[]> = {
      [addressToElectrumScripthash(addr0)]: [u0],
      [addressToElectrumScripthash(addr1)]: [u1],
    };
    const client: ElectrumClient = {
      connect: async () => {},
      isConnected: () => true,
      endpoint: () => 'wss://fake',
      close: () => {},
      request: async (method: string, params: unknown[] = []) => {
        if (method === ELECTRUM_METHODS.estimateFee) return 0.001 as never;
        if (method === ELECTRUM_METHODS.listUnspent) {
          return (params[1] ? [] : utxosBySh[params[0] as string] ?? []) as never;
        }
        if (method === ELECTRUM_METHODS.txGet) {
          const raw = raws.get(params[0] as string);
          if (!raw) throw new Error(`no prevout for ${String(params[0])}`);
          return raw as never;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const svc = new LiveWalletService(client);
    await svc.import(VECTOR_MNEMONIC, 'pw');
    await svc.addReceiveAddress();

    const plan = await svc.buildEvrSend(RECIPIENT, 100_000_000n); // 1.0 EVR
    expect(plan.built.rawHex).toMatch(/^02000000/);
    expect(plan.feeSats).toBeGreaterThan(0n);
    // Both outpoints must be inputs. Outpoint txids are serialized byte-reversed,
    // so assert each input txid's reversed hex appears in the raw tx.
    const reverseHex = (h: string) => (h.match(/../g) as string[]).reverse().join('');
    expect(plan.built.rawHex).toContain(reverseHex(u0.tx_hash));
    expect(plan.built.rawHex).toContain(reverseHex(u1.tx_hash));
  });

  it('rejects a P2SH / wrong-network recipient (would build an unspendable output)', async () => {
    const b58c = base58check(sha256);
    // A valid-checksum mainnet P2SH address ('e…'): isValidAddress accepts it, but
    // the builder only makes P2PKH outputs, so it MUST be rejected up front.
    const p2shPayload = new Uint8Array(21);
    p2shPayload[0] = EVRMORE_MAINNET.scriptHash & 0xff;
    p2shPayload.set(new Uint8Array(20).fill(0x11), 1);
    const p2shAddress = b58c.encode(p2shPayload);

    const svc = new LiveWalletService(
      fakeClient([{ tx_hash: 'a'.repeat(64), tx_pos: 0, height: 1, value: 100_000_000 }]),
    );
    await svc.import(VECTOR_MNEMONIC, 'pw');
    await expect(svc.buildEvrSend(p2shAddress, 10_000_000n)).rejects.toThrow('unsupported-address-type');
  });

  it('rejects a send when the server UNDER-REPORTS a UTXO value (anti-drain)', async () => {
    // Real prevout is worth 2 EVR, but listunspent LIES that it is 1 EVR. Without
    // verification the wallet would emit tiny change and burn ~1 EVR to fees; the
    // trustless prevout check must catch the mismatch and abort.
    // Real prevout carries the OWNING address's P2PKH script (so the script check
    // passes and the VALUE lie is what trips the guard) worth 2 EVR.
    const raw = makePrevoutRaw('a'.repeat(64), 1, 0, 200_000_000n, await vectorP2pkhScriptHex(0));
    const id = computeTxid(raw);
    const client: ElectrumClient = {
      connect: async () => {},
      isConnected: () => true,
      endpoint: () => 'wss://fake',
      close: () => {},
      request: async (method: string, params: unknown[] = []) => {
        if (method === ELECTRUM_METHODS.estimateFee) return 0.001 as never;
        if (method === ELECTRUM_METHODS.listUnspent) {
          return (params[1]
            ? []
            : [{ tx_hash: id, tx_pos: 0, height: 1, value: 100_000_000 }]) as never; // LIE: 1 EVR
        }
        if (method === ELECTRUM_METHODS.txGet) return raw as never;
        throw new Error(`unexpected ${method}`);
      },
    };
    const svc = new LiveWalletService(client);
    await svc.import(VECTOR_MNEMONIC, 'pw');
    await expect(svc.buildEvrSend(RECIPIENT, 50_000_000n)).rejects.toThrow('input-value-mismatch');
  });

  it('lock() clears the seed and blocks derivation', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.import(VECTOR_MNEMONIC, 'pw');
    expect(svc.isUnlocked()).toBe(true);
    svc.lock();
    expect(svc.isUnlocked()).toBe(false);
    expect(() => svc.getAddress(0)).toThrow('locked');
  });

  it('supports multiple wallets: list, switch, and per-wallet addresses', async () => {
    const svc = new LiveWalletService(fakeClient([]));

    // Wallet 1: freshly generated (random address).
    await svc.create('pw-one');
    const id1 = svc.activeWalletId();
    const addr1 = svc.getAddress(0);
    expect(id1).not.toBe(null);

    // Wallet 2: imported vector mnemonic, given an explicit name; becomes active.
    await svc.import(VECTOR_MNEMONIC, 'pw-two', 'mainnet', 'Savings');
    const id2 = svc.activeWalletId();
    const addr2 = svc.getAddress(0);

    expect(id2).not.toBe(id1);
    expect(addr2).not.toBe(addr1);
    expect(addr2).toBe(await expectedWalletAddress());

    const list = await svc.listWallets();
    expect(list).toHaveLength(2);
    expect(list.filter((w) => w.active)).toHaveLength(1);
    expect(list.find((w) => w.id === id2)?.active).toBe(true);
    expect(list.find((w) => w.id === id2)?.name).toBe('Savings');
    expect(list.find((w) => w.id === id1)?.name).toBe('Wallet 1');
    // No secret material ever leaks through the summary (only public metadata).
    expect(Object.keys(list[0]).sort()).toEqual(
      ['active', 'address', 'createdAt', 'id', 'kind', 'name', 'network', 'passwordless'].sort(),
    );
    expect(list[0]).not.toHaveProperty('vault');

    // Switching locks the newly-active wallet; it needs its OWN password.
    await svc.switchWallet(id1!);
    expect(svc.isUnlocked()).toBe(false);
    expect(svc.activeWalletId()).toBe(id1);
    expect(await svc.unlock('pw-two')).toBe(false); // wallet 2's password is wrong here
    expect(await svc.unlock('pw-one')).toBe(true);
    expect(svc.getAddress(0)).toBe(addr1);

    // Switch back to wallet 2 and unlock with its password.
    await svc.switchWallet(id2!);
    expect(svc.isUnlocked()).toBe(false);
    expect(await svc.unlock('pw-two')).toBe(true);
    expect(svc.getAddress(0)).toBe(addr2);
  });

  it('migrates a legacy single-wallet key into the multi-wallet store', async () => {
    // Seed the OLD `liveWallet` key directly, built via the real vault path.
    const vault = await createVault(VECTOR_MNEMONIC, 'legacy-pw');
    await getStorage().set('liveWallet', { version: 1, network: 'mainnet', vault, createdAt: 4242 });

    const svc = new LiveWalletService(fakeClient([]));
    expect(await svc.exists()).toBe(true); // first access triggers migration

    const list = await svc.listWallets();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Wallet 1');
    expect(list[0].active).toBe(true);
    expect(list[0].createdAt).toBe(4242);

    // The migrated wallet unlocks with its legacy password and keeps its address.
    expect(await svc.unlock('legacy-pw')).toBe(true);
    expect(svc.getAddress(0)).toBe(await expectedWalletAddress());

    // The new multi-wallet key now exists; the legacy key is left in place.
    expect(await getStorage().get('liveWallets')).toBeDefined();
    expect(await getStorage().get('liveWallet')).toBeDefined();
  });

  it('removeWallet promotes another active wallet; removing the last leaves none', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.create('pw-a');
    const idA = svc.activeWalletId()!;
    await svc.create('pw-b');
    const idB = svc.activeWalletId()!;
    expect(idB).not.toBe(idA);
    expect(await svc.listWallets()).toHaveLength(2);

    // Removing the active wallet (B) promotes A and clears the seed.
    await svc.removeWallet(idB);
    expect(svc.isUnlocked()).toBe(false);
    const afterOne = await svc.listWallets();
    expect(afterOne).toHaveLength(1);
    expect(afterOne[0].id).toBe(idA);
    expect(afterOne[0].active).toBe(true);
    expect(svc.activeWalletId()).toBe(idA);

    // Removing the last wallet leaves exists() false and no active id.
    await svc.removeWallet(idA);
    expect(await svc.exists()).toBe(false);
    expect(svc.activeWalletId()).toBe(null);
  });

  it('renameWallet updates the name and ignores blank names', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.create('pw');
    const id = svc.activeWalletId()!;
    await svc.renameWallet(id, '  Main Wallet  ');
    expect((await svc.listWallets())[0].name).toBe('Main Wallet');
    await svc.renameWallet(id, '   ');
    expect((await svc.listWallets())[0].name).toBe('Main Wallet'); // unchanged
  });

  it('reveals the mnemonic and private-key WIF only for the correct password', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.import(VECTOR_MNEMONIC, 'reveal-pw');

    // Mnemonic reveal is exact for the right password, null for a wrong one.
    expect(await svc.revealMnemonic('reveal-pw')).toBe(VECTOR_MNEMONIC);
    expect(await svc.revealMnemonic('nope')).toBe(null);

    // Private-key reveal returns a WIF that decodes to a 32-byte key and matches
    // what the keys module derives independently.
    const wif = await svc.revealPrivateKeyWif('reveal-pw', 0);
    expect(wif).not.toBe(null);
    const { privateKey } = decodeWif(wif!);
    expect(privateKey).toHaveLength(32);
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    expect(wif).toBe(deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).wif);

    expect(await svc.revealPrivateKeyWif('wrong', 0)).toBe(null);

    // Revealing must not disturb the active in-memory seed.
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getAddress(0)).toBe(await expectedWalletAddress());
  });

  it('reset() removes every wallet and both storage keys', async () => {
    const svc = new LiveWalletService(fakeClient([]));
    await svc.create('pw-1');
    await svc.create('pw-2');
    expect(await svc.listWallets()).toHaveLength(2);

    await svc.reset();
    expect(await svc.exists()).toBe(false);
    expect(svc.activeWalletId()).toBe(null);
    expect(await getStorage().get('liveWallets')).toBeUndefined();
  });

  it("a 'ravencoin-mainnet' wallet round-trips from storage and derives R-addresses; a 'mainnet' wallet stays Evrmore", async () => {
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    const expectedRvn = deriveAddress(seed, RAVENCOIN_MAINNET, 0, 0, 0).address;
    const expectedEvr = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address;

    // Import the SAME mnemonic once as Evrmore ('mainnet') and once as Ravencoin.
    const svc = new LiveWalletService(fakeClient([]));
    await svc.import(VECTOR_MNEMONIC, 'pw', 'mainnet', 'EVR wallet');
    const evrId = svc.activeWalletId();
    await svc.import(VECTOR_MNEMONIC, 'pw', 'ravencoin-mainnet', 'RVN wallet');
    const rvnId = svc.activeWalletId();

    // Active wallet is now the RVN one: net follows the wallet.
    expect(svc.network()).toBe('ravencoin-mainnet');
    expect(svc.getAddress(0)).toBe(expectedRvn);
    expect(expectedRvn[0]).toBe('R');

    // listWallets reports the canonical stored ids (no rewrite of legacy 'mainnet').
    const list = await svc.listWallets();
    expect(list.find((w) => w.id === rvnId)!.network).toBe('ravencoin-mainnet');
    expect(list.find((w) => w.id === evrId)!.network).toBe('mainnet');
    expect(list.find((w) => w.id === rvnId)!.address).toBe(expectedRvn);
    expect(list.find((w) => w.id === evrId)!.address).toBe(expectedEvr);

    // Round-trip through storage: a FRESH service instance reads the persisted
    // store, makes the active chain follow the active (RVN) wallet on load, and
    // after unlock derives the R-address.
    const svc2 = new LiveWalletService(fakeClient([]));
    expect(await svc2.exists()).toBe(true);
    expect(svc2.network()).toBe('ravencoin-mainnet'); // set on loadStore, before unlock
    expect(await svc2.unlock('pw')).toBe(true);
    expect(svc2.getAddress(0)).toBe(expectedRvn);

    // signMessage on the active RVN wallet uses the Raven magic end-to-end: the
    // signature verifies to the R-address under RAVENCOIN_MAINNET.
    const { address, signature } = svc2.signMessage('login-rvn');
    expect(address).toBe(expectedRvn);
    expect(verifyMessage(address, 'login-rvn', signature, RAVENCOIN_MAINNET)).toBe(true);
    expect(verifyMessage(address, 'login-rvn', signature, EVRMORE_MAINNET)).toBe(false);

    // Switch back to the Evrmore wallet: the active chain follows it, E-address.
    await svc2.switchWallet(evrId!);
    expect(svc2.network()).toBe('mainnet');
    expect(await svc2.unlock('pw')).toBe(true);
    expect(svc2.getAddress(0)).toBe(expectedEvr);
    expect(expectedEvr[0]).toBe('E');
  });
});
