// vitest tests for ElectrumWalletDataProvider (node env).
// Uses a fake ElectrumClient so no real WebSocket is opened.

import { describe, it, expect } from 'vitest';
import { ElectrumWalletDataProvider } from './electrumProvider';
import type { ElectrumClient } from './electrumTypes';
import { ELECTRUM_METHODS } from './network';

// ---------------------------------------------------------------------------
// Fake ElectrumClient

type RequestHandler = (method: string, params?: unknown[]) => unknown;

function makeFakeClient(handler: RequestHandler, opts?: { connectShouldFail?: boolean }): ElectrumClient {
  let connected = false;
  return {
    async connect() {
      if (opts?.connectShouldFail) {
        throw new Error('connection refused (fake)');
      }
      connected = true;
    },
    async request<T>(method: string, params?: unknown[]): Promise<T> {
      return handler(method, params) as T;
    },
    close() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
    endpoint() {
      return connected ? 'wss://fake-electrum:50004' : null;
    },
  };
}

// ---------------------------------------------------------------------------
// A real Evrmore address whose scripthash we can compute.
// We'll use a well-known P2PKH address that passes addressToElectrumScripthash.
// For tests that call getBalances/getTransactions we need a valid base58check addr.
// We derive one from the Evrmore mainnet version byte (33 = 0x21).
// Address: EXmple — we'll just reuse the address that is already in domain tests.
// Since we don't want test coupling, let's pick a known valid EVR address:
// "ERMXhg4MFsYVPMHJGNMSk7LHEtcnAGMJ3U" would require real chain params.
// Instead, we can mock addressToElectrumScripthash by using any valid base58check
// payload with version byte 0x21 (Evrmore P2PKH).
//
// Simplest approach: call real addressToElectrumScripthash with a synthetic valid addr.
// Let's build one inline using the same encoding that keys.ts uses.

import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';

const b58c = base58check(sha256);

/** Build a minimal valid P2PKH Evrmore address from 20 raw bytes. */
function makeTestAddress(seed: number): string {
  const h160 = new Uint8Array(20).fill(seed & 0xff);
  h160[0] = seed & 0xff;
  h160[1] = (seed >> 8) & 0xff;
  const payload = new Uint8Array(21);
  payload[0] = 0x21; // Evrmore mainnet P2PKH version byte
  payload.set(h160, 1);
  return b58c.encode(payload);
}

const OUR_ADDRESS = makeTestAddress(0xab);
const OTHER_ADDRESS = makeTestAddress(0xcd);

// ---------------------------------------------------------------------------
// Shared verbose TX builders

function makeVerboseTx(
  txid: string,
  opts: {
    time?: number;
    vout?: Array<{
      value: number;
      address?: string;
      assetName?: string;
      assetAmount?: number;
    }>;
    vin?: Array<{ txid?: string; vout?: number }>;
  } = {},
) {
  return {
    txid,
    time: opts.time ?? 1_700_000_000,
    vin: (opts.vin ?? []).map((v) =>
      v.txid !== undefined
        ? { txid: v.txid, vout: v.vout ?? 0 }
        : { coinbase: 'deadbeef' },
    ),
    vout: (opts.vout ?? []).map((v, n) => ({
      value: v.value,
      n,
      scriptPubKey:
        v.assetName
          ? {
              asset: { name: v.assetName, amount: v.assetAmount ?? 0 },
              address: v.address,
              addresses: v.address ? [v.address] : undefined,
            }
          : {
              address: v.address,
              addresses: v.address ? [v.address] : undefined,
            },
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests

describe('ElectrumWalletDataProvider', () => {
  // Test 1 — getBalances converts sats to decimal amounts
  describe('getBalances', () => {
    it('converts sats to decimals for EVR and SATORI', async () => {
      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getBalance) {
          const hasAsset = params && params[1] === 'SATORI';
          if (hasAsset) {
            return { confirmed: 1258422000000, unconfirmed: 0 };
          }
          return { confirmed: 248174000000, unconfirmed: 0 };
        }
        throw new Error(`unexpected method: ${method}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const balances = await provider.getBalances(OUR_ADDRESS);

      const evr = balances.find((b) => b.assetId === 'EVR');
      const satori = balances.find((b) => b.assetId === 'SATORI');

      expect(evr?.amount).toBeCloseTo(2481.74, 5);
      expect(satori?.amount).toBeCloseTo(12584.22, 5);
    });

    it('includes unconfirmed in the total', async () => {
      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getBalance) {
          const hasAsset = params && params[1] === 'SATORI';
          if (hasAsset) return { confirmed: 0, unconfirmed: 100000000 };
          return { confirmed: 100000000, unconfirmed: 50000000 };
        }
        throw new Error(`unexpected method: ${method}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const balances = await provider.getBalances(OUR_ADDRESS);

      const evr = balances.find((b) => b.assetId === 'EVR');
      expect(evr?.amount).toBeCloseTo(1.5, 5);
    });
  });

  // Test 2 — getAssets returns correct shapes with injected prices
  describe('getAssets', () => {
    it('returns EVR (native) and SATORI (evr-asset) with injected prices', async () => {
      const client = makeFakeClient(() => { throw new Error('not called'); });
      const provider = new ElectrumWalletDataProvider(client, {
        prices: {
          EVR: { priceUsd: 0.085, change24hPct: 3.42 },
          SATORI: { priceUsd: 0.92, change24hPct: -1.27 },
        },
      });

      const assets = await provider.getAssets();
      expect(assets).toHaveLength(2);

      const evr = assets.find((a) => a.id === 'EVR');
      const satori = assets.find((a) => a.id === 'SATORI');

      expect(evr).toBeDefined();
      expect(evr?.kind).toBe('native');
      expect(evr?.decimals).toBe(8);
      expect(evr?.symbol).toBe('EVR');
      expect(evr?.priceUsd).toBe(0.085);
      expect(evr?.change24hPct).toBe(3.42);

      expect(satori).toBeDefined();
      expect(satori?.kind).toBe('evr-asset');
      expect(satori?.decimals).toBe(8);
      expect(satori?.symbol).toBe('SATORI');
      expect(satori?.priceUsd).toBe(0.92);
      expect(satori?.change24hPct).toBe(-1.27);
    });

    it('defaults prices to 0 when not injected', async () => {
      const client = makeFakeClient(() => { throw new Error('not called'); });
      const provider = new ElectrumWalletDataProvider(client);
      const assets = await provider.getAssets();

      for (const a of assets) {
        expect(a.priceUsd).toBe(0);
        expect(a.change24hPct).toBe(0);
      }
    });
  });

  // Test 3 — getNetworkStatus
  describe('getNetworkStatus', () => {
    it('returns connected with blockHeight and numeric latencyMs', async () => {
      const handler: RequestHandler = (method) => {
        if (method === ELECTRUM_METHODS.headersSubscribe) {
          return { height: 1_284_500 };
        }
        if (method === ELECTRUM_METHODS.features) {
          return { server_version: 'ElectrumX Evrmore 1.12' };
        }
        throw new Error(`unexpected: ${method}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client, { networkId: 'mainnet' });
      const status = await provider.getNetworkStatus();

      expect(status.state).toBe('connected');
      expect(status.blockHeight).toBe(1_284_500);
      expect(typeof status.latencyMs).toBe('number');
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
      expect(status.networkId).toBe('mainnet');
    });

    it('returns offline when connect() rejects', async () => {
      const client = makeFakeClient(() => { throw new Error('not called'); }, { connectShouldFail: true });
      const provider = new ElectrumWalletDataProvider(client);
      const status = await provider.getNetworkStatus();

      expect(status.state).toBe('offline');
      expect(status.blockHeight).toBe(0);
      expect(status.latencyMs).toBe(0);
    });
  });

  // Test 4 — getTransactions: received EVR tx
  describe('getTransactions: received EVR', () => {
    it('classifies a RECEIVED EVR tx as direction=in with correct decimal amount and confirmed status', async () => {
      const TXID = 'aaaa1111' + '0'.repeat(56);
      const BLOCK_HEIGHT = 1_284_100;

      const receiveTx = makeVerboseTx(TXID, {
        time: 1_700_000_000,
        vin: [{}], // coinbase-like input: no prevout to resolve
        vout: [
          { value: 10.5, address: OUR_ADDRESS },
          { value: 1.0, address: OTHER_ADDRESS },
        ],
      });

      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getHistory) {
          return [{ tx_hash: TXID, height: BLOCK_HEIGHT }];
        }
        if (method === ELECTRUM_METHODS.txGet && params?.[0] === TXID) {
          return receiveTx;
        }
        throw new Error(`unexpected: ${method} ${JSON.stringify(params)}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const txs = await provider.getTransactions(OUR_ADDRESS);

      expect(txs).toHaveLength(1);
      const tx = txs[0];
      expect(tx.txid).toBe(TXID);
      expect(tx.direction).toBe('in');
      expect(tx.assetId).toBe('EVR');
      expect(tx.amount).toBeCloseTo(10.5, 5);
      expect(tx.status).toBe('confirmed');
      expect(tx.blockHeight).toBe(BLOCK_HEIGHT);
    });
  });

  // Test 5 — getTransactions: sent SATORI tx with fee computation
  describe('getTransactions: sent SATORI', () => {
    it('classifies a SENT SATORI tx with direction=out, assetId=SATORI, and feeEvr', async () => {
      const TXID = 'bbbb2222' + '0'.repeat(56);
      const PREV_TXID = 'cccc3333' + '0'.repeat(56);
      const BLOCK_HEIGHT = 1_284_200;

      // The spend tx: our address provided an EVR input (via prevout) and a SATORI input.
      // Outputs: SATORI to OTHER_ADDRESS, EVR change to OUR_ADDRESS.
      const spendTx = makeVerboseTx(TXID, {
        time: 1_700_010_000,
        vin: [
          { txid: PREV_TXID, vout: 0 }, // EVR input from our address
          { txid: PREV_TXID, vout: 1 }, // SATORI input from our address
        ],
        vout: [
          // SATORI sent to OTHER_ADDRESS
          { value: 0, address: OTHER_ADDRESS, assetName: 'SATORI', assetAmount: 500.0 },
          // EVR change back to us
          { value: 9.9999, address: OUR_ADDRESS },
        ],
      });

      // Prevout tx: both outputs belong to OUR_ADDRESS
      const prevTx = makeVerboseTx(PREV_TXID, {
        time: 1_699_000_000,
        vin: [],
        vout: [
          // vout 0: EVR to OUR_ADDRESS
          { value: 10.0001, address: OUR_ADDRESS },
          // vout 1: SATORI to OUR_ADDRESS
          { value: 0, address: OUR_ADDRESS, assetName: 'SATORI', assetAmount: 500.0 },
        ],
      });

      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getHistory) {
          return [{ tx_hash: TXID, height: BLOCK_HEIGHT }];
        }
        if (method === ELECTRUM_METHODS.txGet) {
          if (params?.[0] === TXID) return spendTx;
          if (params?.[0] === PREV_TXID) return prevTx;
        }
        throw new Error(`unexpected: ${method} ${JSON.stringify(params)}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const txs = await provider.getTransactions(OUR_ADDRESS);

      expect(txs).toHaveLength(1);
      const tx = txs[0];
      expect(tx.assetId).toBe('SATORI');
      expect(tx.direction).toBe('out');
      expect(tx.amount).toBeCloseTo(500.0, 5);
      // fee = EVR inputs (10.0001) - total EVR outputs (9.9999) = 0.0002
      expect(tx.feeEvr).toBeCloseTo(0.0002, 5);
      expect(tx.status).toBe('confirmed');
    });
  });

  // Test 6 — mempool tx (height<=0) has status pending
  describe('getTransactions: mempool tx', () => {
    it('marks a mempool tx (height<=0) as status=pending', async () => {
      const TXID = 'dddd4444' + '0'.repeat(56);

      const mempoolTx = makeVerboseTx(TXID, {
        time: undefined,
        vin: [],
        vout: [{ value: 3.0, address: OUR_ADDRESS }],
      });
      // Remove time to test Date.now() fallback
      delete (mempoolTx as { time?: number }).time;

      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getHistory) {
          return [{ tx_hash: TXID, height: 0 }];
        }
        if (method === ELECTRUM_METHODS.txGet && params?.[0] === TXID) {
          return mempoolTx;
        }
        throw new Error(`unexpected: ${method}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const txs = await provider.getTransactions(OUR_ADDRESS);

      expect(txs).toHaveLength(1);
      expect(txs[0].status).toBe('pending');
      expect(txs[0].blockHeight).toBeUndefined();
    });

    it('also marks height=-1 as pending', async () => {
      const TXID = 'eeee5555' + '0'.repeat(56);

      const mempoolTx = makeVerboseTx(TXID, {
        time: 1_700_100_000,
        vin: [],
        vout: [{ value: 1.0, address: OUR_ADDRESS }],
      });

      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getHistory) {
          return [{ tx_hash: TXID, height: -1 }];
        }
        if (method === ELECTRUM_METHODS.txGet && params?.[0] === TXID) {
          return mempoolTx;
        }
        throw new Error(`unexpected: ${method}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const txs = await provider.getTransactions(OUR_ADDRESS);

      expect(txs[0].status).toBe('pending');
    });
  });

  // Test 7 — one malformed verbose tx does not throw the whole getTransactions
  describe('getTransactions: resilience', () => {
    it('skips a malformed tx and still returns other txs', async () => {
      const GOOD_TXID = 'ffff6666' + '0'.repeat(56);
      const BAD_TXID = '88887777' + '0'.repeat(56);

      const goodTx = makeVerboseTx(GOOD_TXID, {
        time: 1_700_200_000,
        vin: [],
        vout: [{ value: 5.0, address: OUR_ADDRESS }],
      });

      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getHistory) {
          return [
            { tx_hash: BAD_TXID, height: 1_000_000 },
            { tx_hash: GOOD_TXID, height: 999_999 },
          ];
        }
        if (method === ELECTRUM_METHODS.txGet) {
          if (params?.[0] === BAD_TXID) {
            // Return something deeply malformed that will cause a runtime error.
            return null; // null.vout will throw
          }
          if (params?.[0] === GOOD_TXID) {
            return goodTx;
          }
        }
        throw new Error(`unexpected: ${method}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);

      // Must not throw
      const txs = await provider.getTransactions(OUR_ADDRESS);

      // The good tx should still be returned
      expect(txs.some((t) => t.txid === GOOD_TXID)).toBe(true);
      // The bad tx should be skipped
      expect(txs.some((t) => t.txid === BAD_TXID)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Dynamic asset detection (getAllAssetBalances / getAssetMeta / getAssetBalance)
  // -------------------------------------------------------------------------

  // Realistic get_meta replies mirroring the live chain (see electrumProvider.ts
  // recon notes). SATORI: 8 divisions; USDX: 2 divisions; CHUPPA_CHUB: 0 divisions.
  // NOTE: on-chain amounts are ALWAYS in 1e8 base units regardless of divisions —
  // divisions is display precision only. So sats_in_circulation / 1e8 = supply.
  const META: Record<string, unknown> = {
    SATORI: {
      sats_in_circulation: 103389600000000,
      divisions: 8,
      reissuable: true,
      has_ipfs: true,
      ipfs: 'QmevV2V2mDLThgyRrkC6DV6MyRPWBgRy2Vy3BrfUvLEMBF',
    },
    USDX: { sats_in_circulation: 10000000000, divisions: 2, reissuable: false, has_ipfs: false },
    // CHUPPA_CHUB: real div-0 asset — supply 100000 whole units = 1e13 sats.
    CHUPPA_CHUB: { sats_in_circulation: 10000000000000, divisions: 0, reissuable: true, has_ipfs: false },
  };

  describe('getAllAssetBalances (dynamic detection)', () => {
    it('parses listunspent(sh,true) into per-asset LiveAssetBalance[] with correct decimals scaling', async () => {
      // EVR utxos carry asset:null; asset utxos carry the asset NAME. value in sats.
      const utxos = [
        { tx_hash: 'a', tx_pos: 0, height: 100, asset: null, value: 100000000 }, // 1.0 EVR
        { tx_hash: 'b', tx_pos: 1, height: 101, asset: null, value: 50000000 }, // 0.5 EVR
        { tx_hash: 'c', tx_pos: 0, height: 102, asset: 'SATORI', value: 20547945205 }, // 205.47945205
        { tx_hash: 'd', tx_pos: 0, height: 103, asset: 'SATORI', value: 20547945205 }, // 205.47945205
        { tx_hash: 'e', tx_pos: 2, height: 104, asset: 'USDX', value: 12345000000 }, // 123.45 (raw/1e8)
      ];

      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.listUnspent) {
          expect(params?.[1]).toBe(true); // must request the "all assets" variant
          return utxos;
        }
        if (method === ELECTRUM_METHODS.assetGetMeta) {
          const name = params?.[0] as string;
          return META[name] ?? {};
        }
        throw new Error(`unexpected: ${method}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const balances = await provider.getAllAssetBalances(OUR_ADDRESS);

      // EVR first (native), then assets alphabetically.
      expect(balances[0]).toMatchObject({ name: 'EVR', decimals: 8, isNative: true });
      expect(balances[0].amount).toBeCloseTo(1.5, 8);

      const satori = balances.find((b) => b.name === 'SATORI');
      expect(satori).toBeDefined();
      expect(satori?.isNative).toBe(false);
      expect(satori?.decimals).toBe(8);
      expect(satori?.amount).toBeCloseTo(410.9589041, 8);

      const usdx = balances.find((b) => b.name === 'USDX');
      expect(usdx?.decimals).toBe(2);
      expect(usdx?.amount).toBeCloseTo(123.45, 8);

      // Exactly three assets detected: EVR, SATORI, USDX.
      expect(balances).toHaveLength(3);
    });

    it('always includes EVR (amount 0) when the address holds only assets', async () => {
      const utxos = [
        { tx_hash: 'c', tx_pos: 0, height: 102, asset: 'SATORI', value: 20547945205 },
      ];
      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.listUnspent) return utxos;
        if (method === ELECTRUM_METHODS.assetGetMeta) return META[params?.[0] as string] ?? {};
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const balances = await provider.getAllAssetBalances(OUR_ADDRESS);

      const evr = balances.find((b) => b.name === 'EVR');
      expect(evr).toBeDefined();
      expect(evr?.isNative).toBe(true);
      expect(evr?.amount).toBe(0);
      expect(balances.some((b) => b.name === 'SATORI')).toBe(true);
    });

    it('always includes EVR (amount 0) when the address holds nothing at all', async () => {
      const handler: RequestHandler = (method) => {
        if (method === ELECTRUM_METHODS.listUnspent) return [];
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const balances = await provider.getAllAssetBalances(OUR_ADDRESS);

      expect(balances).toHaveLength(1);
      expect(balances[0]).toMatchObject({ name: 'EVR', amount: 0, decimals: 8, isNative: true });
    });

    it('treats "rvn"/"" asset fields as native EVR (defensive)', async () => {
      const utxos = [
        { tx_hash: 'a', tx_pos: 0, height: 100, asset: 'rvn', value: 100000000 }, // 1.0 EVR
        { tx_hash: 'b', tx_pos: 1, height: 101, asset: '', value: 50000000 }, // 0.5 EVR
      ];
      const handler: RequestHandler = (method) => {
        if (method === ELECTRUM_METHODS.listUnspent) return utxos;
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const balances = await provider.getAllAssetBalances(OUR_ADDRESS);

      expect(balances).toHaveLength(1);
      expect(balances[0].name).toBe('EVR');
      expect(balances[0].amount).toBeCloseTo(1.5, 8);
    });

    it('caches get_meta so a repeated asset is only fetched once', async () => {
      let metaCalls = 0;
      const utxos = [
        { tx_hash: 'c', tx_pos: 0, height: 102, asset: 'SATORI', value: 20547945205 },
        { tx_hash: 'd', tx_pos: 0, height: 103, asset: 'SATORI', value: 20547945205 },
      ];
      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.listUnspent) return utxos;
        if (method === ELECTRUM_METHODS.assetGetMeta) {
          metaCalls++;
          return META[params?.[0] as string] ?? {};
        }
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);

      await provider.getAllAssetBalances(OUR_ADDRESS);
      await provider.getAllAssetBalances(OUR_ADDRESS); // second call, same asset
      expect(metaCalls).toBe(1); // SATORI meta fetched exactly once across both calls
    });

    it('divides amounts by the fixed 1e8 base unit, NOT 10^divisions (regression: div-0 asset)', async () => {
      // CHUPPA_CHUB has divisions:0. Holding 1 whole unit is stored on-chain as
      // 100000000 sats. Correct amount is 1 (÷1e8) — the old bug showed 100000000
      // (÷10^0). This is the exact case the user hit ("sent 1, saw 100000000").
      const utxos = [
        { tx_hash: 'x', tx_pos: 0, height: 200, asset: 'CHUPPA_CHUB', value: 100000000 },
      ];
      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.listUnspent) return utxos;
        if (method === ELECTRUM_METHODS.assetGetMeta) return META[params?.[0] as string] ?? {};
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const balances = await provider.getAllAssetBalances(OUR_ADDRESS);
      const cc = balances.find((b) => b.name === 'CHUPPA_CHUB');
      expect(cc?.decimals).toBe(0);
      expect(cc?.amount).toBe(1);
    });
  });

  describe('getAssetMeta (name validation)', () => {
    it('returns exists:true with correct decimals/supply for a real asset', async () => {
      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.assetGetMeta) return META[params?.[0] as string] ?? {};
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);

      const meta = await provider.getAssetMeta('SATORI');
      expect(meta).not.toBeNull();
      expect(meta?.exists).toBe(true);
      expect(meta?.decimals).toBe(8);
      expect(meta?.reissuable).toBe(true);
      expect(meta?.hasIpfs).toBe(true);
      // supply = sats_in_circulation / 10^decimals = 103389600000000 / 1e8
      expect(meta?.supply).toBeCloseTo(1033896, 6);
    });

    it('normalizes lowercase/whitespace names before get_meta', async () => {
      const seen: string[] = [];
      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.assetGetMeta) {
          const name = params?.[0] as string;
          seen.push(name);
          return META[name] ?? {};
        }
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);

      const meta = await provider.getAssetMeta('  satori  ');
      expect(seen).toContain('SATORI'); // uppercased + trimmed
      expect(meta?.exists).toBe(true);
    });

    it('returns exists:false when get_meta replies with {} (nonexistent asset)', async () => {
      const handler: RequestHandler = (method) => {
        if (method === ELECTRUM_METHODS.assetGetMeta) return {};
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);

      const meta = await provider.getAssetMeta('SATOREVR');
      expect(meta).not.toBeNull();
      expect(meta?.exists).toBe(false);
      expect(meta?.decimals).toBe(0);
      expect(meta?.supply).toBe(0);
    });

    it('returns null for an empty/whitespace-only name', async () => {
      const client = makeFakeClient(() => {
        throw new Error('not called');
      });
      const provider = new ElectrumWalletDataProvider(client);
      expect(await provider.getAssetMeta('   ')).toBeNull();
    });

    it('reports an owner token (divisions 0, 1e8 sats_in_circulation) as supply 1', async () => {
      const handler: RequestHandler = (method) => {
        if (method === ELECTRUM_METHODS.assetGetMeta) {
          return { sats_in_circulation: 100000000, divisions: 0, reissuable: false, has_ipfs: false };
        }
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const meta = await provider.getAssetMeta('OWNER!');
      expect(meta?.exists).toBe(true);
      expect(meta?.decimals).toBe(0);
      expect(meta?.supply).toBe(1);
    });
  });

  describe('getAssetBalance (single asset)', () => {
    it('returns an asset balance in whole units (1e8 base, not 10^divisions)', async () => {
      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getBalance && params?.[1] === 'SATORI') {
          return { confirmed: 20547945205, unconfirmed: 0 };
        }
        if (method === ELECTRUM_METHODS.assetGetMeta) return META[params?.[0] as string] ?? {};
        throw new Error(`unexpected: ${method} ${JSON.stringify(params)}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);

      const amount = await provider.getAssetBalance(OUR_ADDRESS, 'satori');
      expect(amount).toBeCloseTo(205.47945205, 8);
    });

    it('returns the native EVR balance (8 dp, no asset arg) for name "EVR"', async () => {
      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getBalance) {
          expect(params?.length).toBe(1); // no asset param for native EVR
          return { confirmed: 248174000000, unconfirmed: 0 };
        }
        throw new Error(`unexpected: ${method}`);
      };
      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);

      const amount = await provider.getAssetBalance(OUR_ADDRESS, 'EVR');
      expect(amount).toBeCloseTo(2481.74, 5);
    });
  });

  // -------------------------------------------------------------------------
  // getLiveTransactions — dynamic-asset classification (ANY on-chain asset,
  // not just SATORI). Verified live: verbose scriptPubKey.asset.amount is in
  // WHOLE units (SATORIEVR output read 13.18777294 == listunspent 1318777294
  // sats / 1e8), so no scaling is applied.
  // -------------------------------------------------------------------------

  describe('getLiveTransactions (dynamic asset classification)', () => {
    it('classifies a RECEIVED non-SATORI asset (SATORIEVR) as direction=in with its name and amount', async () => {
      const TXID = 'a5e70001' + '0'.repeat(56);
      const BLOCK_HEIGHT = 1_300_000;

      // We RECEIVE 13.18777294 SATORIEVR; a tiny EVR output goes elsewhere.
      const receiveTx = makeVerboseTx(TXID, {
        time: 1_700_000_000,
        vin: [{}], // coinbase-like: no prevout to resolve (we spent nothing)
        vout: [
          { value: 0, address: OUR_ADDRESS, assetName: 'SATORIEVR', assetAmount: 13.18777294 },
          { value: 0.01, address: OTHER_ADDRESS },
        ],
      });

      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getHistory) {
          return [{ tx_hash: TXID, height: BLOCK_HEIGHT }];
        }
        if (method === ELECTRUM_METHODS.txGet && params?.[0] === TXID) {
          return receiveTx;
        }
        throw new Error(`unexpected: ${method} ${JSON.stringify(params)}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const txs = await provider.getLiveTransactions(OUR_ADDRESS);

      expect(txs).toHaveLength(1);
      const tx = txs[0];
      expect(tx.txid).toBe(TXID);
      expect(tx.asset).toBe('SATORIEVR');
      expect(tx.direction).toBe('in');
      expect(tx.amount).toBeCloseTo(13.18777294, 8);
      expect(tx.feeEvr).toBe(0); // we are not the sender
      expect(tx.status).toBe('confirmed');
      expect(tx.blockHeight).toBe(BLOCK_HEIGHT);
      expect(tx.counterparty).toBe(OTHER_ADDRESS);
    });

    it('classifies a SENT non-SATORI asset (SATORIEVR) as direction=out with the asset name, amount and EVR fee', async () => {
      const TXID = 'b5e70002' + '0'.repeat(56);
      const PREV_TXID = 'c5e70003' + '0'.repeat(56);
      const BLOCK_HEIGHT = 1_300_100;

      // We spend an EVR input + a SATORIEVR input; send 100 SATORIEVR out and
      // keep EVR change. EVR fee = 10.0001 in - 9.9999 out = 0.0002.
      const spendTx = makeVerboseTx(TXID, {
        time: 1_700_010_000,
        vin: [
          { txid: PREV_TXID, vout: 0 }, // EVR input from us
          { txid: PREV_TXID, vout: 1 }, // SATORIEVR input from us
        ],
        vout: [
          { value: 0, address: OTHER_ADDRESS, assetName: 'SATORIEVR', assetAmount: 100.0 },
          { value: 9.9999, address: OUR_ADDRESS }, // EVR change back to us
        ],
      });

      const prevTx = makeVerboseTx(PREV_TXID, {
        time: 1_699_000_000,
        vin: [],
        vout: [
          { value: 10.0001, address: OUR_ADDRESS }, // vout 0: EVR to us
          { value: 0, address: OUR_ADDRESS, assetName: 'SATORIEVR', assetAmount: 100.0 }, // vout 1: SATORIEVR to us
        ],
      });

      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getHistory) {
          return [{ tx_hash: TXID, height: BLOCK_HEIGHT }];
        }
        if (method === ELECTRUM_METHODS.txGet) {
          if (params?.[0] === TXID) return spendTx;
          if (params?.[0] === PREV_TXID) return prevTx;
        }
        throw new Error(`unexpected: ${method} ${JSON.stringify(params)}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const txs = await provider.getLiveTransactions(OUR_ADDRESS);

      expect(txs).toHaveLength(1);
      const tx = txs[0];
      expect(tx.asset).toBe('SATORIEVR');
      expect(tx.direction).toBe('out');
      expect(tx.amount).toBeCloseTo(100.0, 8);
      expect(tx.feeEvr).toBeCloseTo(0.0002, 8);
      expect(tx.status).toBe('confirmed');
    });

    it('reports EVR when only EVR moved, and skips a tx that does not touch us', async () => {
      const EVR_TXID = 'd5e70004' + '0'.repeat(56);
      const UNRELATED_TXID = 'e5e70005' + '0'.repeat(56);

      const evrReceive = makeVerboseTx(EVR_TXID, {
        vin: [{}],
        vout: [{ value: 2.5, address: OUR_ADDRESS }],
      });
      // Pays only OTHER_ADDRESS — nothing moves relative to us → skipped.
      const unrelated = makeVerboseTx(UNRELATED_TXID, {
        vin: [{}],
        vout: [{ value: 1.0, address: OTHER_ADDRESS }],
      });

      const handler: RequestHandler = (method, params) => {
        if (method === ELECTRUM_METHODS.getHistory) {
          return [
            { tx_hash: EVR_TXID, height: 1_300_200 },
            { tx_hash: UNRELATED_TXID, height: 1_300_199 },
          ];
        }
        if (method === ELECTRUM_METHODS.txGet) {
          if (params?.[0] === EVR_TXID) return evrReceive;
          if (params?.[0] === UNRELATED_TXID) return unrelated;
        }
        throw new Error(`unexpected: ${method}`);
      };

      const client = makeFakeClient(handler);
      await client.connect();
      const provider = new ElectrumWalletDataProvider(client);
      const txs = await provider.getLiveTransactions(OUR_ADDRESS);

      expect(txs).toHaveLength(1);
      expect(txs[0].asset).toBe('EVR');
      expect(txs[0].direction).toBe('in');
      expect(txs[0].amount).toBeCloseTo(2.5, 8);
    });
  });
});
