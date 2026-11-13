// X Coin pay-to-pubkey rewards (KNOWN_LIMITATIONS item 14a).
//
// X Coin's minute lottery pays the winner as `<pubkey> OP_CHECKSIG` to a key of
// the winner's HD wallet. That output has no address: the server indexes it
// under a different scripthash than the same key's P2PKH address, so a wallet
// that reads addresses only sees none of it. These tests pin the three things
// that make the winnings real money here: the scripthash, the read (balance,
// history, the address scan) and the spend (maturity, and a scriptSig that
// carries the signature alone).

import { beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { LiveWalletService } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import { ELECTRUM_METHODS } from './network';
import {
  addressToElectrumScripthash,
  deriveAddress,
  mnemonicToSeed,
  p2pkScript,
  scriptToElectrumScripthash,
} from './keys';
import { EVRMORE_MAINNET, XFER_MAINNET } from './chainParams';
import { buildAndSignEvrTx, isP2pkScript } from './txBuilder';
import type { ElectrumClient } from './electrumTypes';
import type { ElectrumWalletDataProvider } from './electrumProvider';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TIP = 89_649;
const COIN = 100_000_000;

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

const reverseHex = (h: string) => (h.match(/../g) as string[]).reverse().join('');

/** A one-output transaction paying `value` to `scriptHex`, and its txid. */
function prevout(tag: number, value: number, scriptHex: string): { raw: string; txid: string } {
  const script = hexToBytes(scriptHex);
  const v = new Uint8Array(8);
  let n = BigInt(value);
  for (let i = 0; i < 8; i++) {
    v[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  const raw =
    '02000000' +
    '01' + '00'.repeat(32) + 'ffffffff' + '01' + tag.toString(16).padStart(2, '0') + 'ffffffff' +
    '01' + bytesToHex(v) + script.length.toString(16).padStart(2, '0') + scriptHex +
    '00000000';
  const txid = bytesToHex(sha256(sha256(hexToBytes(raw))).slice().reverse());
  return { raw, txid };
}

describe('pay-to-pubkey script and scripthash', () => {
  it('matches a real lottery winner on chain', () => {
    // Coinbase of X Coin block 89,000 pays this key. The server answered this
    // scripthash with 24 unspent rewards (120,000.04 XFER) on 2026-11-13.
    const pubkey = hexToBytes('030cbcfe985f7252764d0d23b3743ed898c85134d499cee2c77848e9f0ca8ea8fe');
    const script = p2pkScript(pubkey);
    expect(bytesToHex(script)).toBe('21030cbcfe985f7252764d0d23b3743ed898c85134d499cee2c77848e9f0ca8ea8feac');
    expect(scriptToElectrumScripthash(script)).toBe('e64340c65450b9f8bbe39b732e3dfd2f817164c2d1eca54883de0b4ad05d566b');
    expect(isP2pkScript(script)).toBe(true);
  });

  it('refuses a key of the wrong length', () => {
    expect(() => p2pkScript(new Uint8Array(20))).toThrow();
  });
});

describe('signing a pay-to-pubkey input', () => {
  it('produces the bytes the X Coin node itself produces and accepts', async () => {
    // Cross-checked 2026-11-13 against xcoind v1.0.27: `signrawtransaction` on
    // the unsigned form with this key returned exactly this hex, and on this hex
    // with no keys returned complete:true (a flipped signature byte: false).
    const seed = await mnemonicToSeed(MNEMONIC);
    const key = deriveAddress(seed, XFER_MAINNET, 0, 0, 0);
    const built = buildAndSignEvrTx({
      inputs: [
        {
          txid: 'ab'.repeat(32),
          vout: 0,
          valueSats: 500_000_000_000n,
          scriptPubKeyHex: bytesToHex(p2pkScript(key.publicKey)),
          privateKey: key.privateKey,
          publicKey: key.publicKey,
        },
      ],
      outputs: [{ address: key.address, valueSats: 100_000_000_000n }],
      changeAddress: key.address,
      feeSats: 250_000n,
      net: XFER_MAINNET,
    });
    expect(built.rawHex).toBe(
      '0200000001abababababababababababababababababababababababababababababababab0000000048473044022001e5a60a2248d1087f4936fc13b8d5d7738e7ea626374a999a66ba74962b27f6022012840f9d7dd66044e97b1146672597845b5eb1c5180b61f8132a55f3680d2cbd01ffffffff0200e87648170000001976a9143122e15ca247ec7604d7027b9db7b11acff8a98388ac70cfd7215d0000001976a9143122e15ca247ec7604d7027b9db7b11acff8a98388ac00000000',
    );
    // The scriptSig is the signature push alone: the key is not repeated.
    expect(built.rawHex).not.toContain(bytesToHex(key.publicKey));
  });

  it('refuses to sign an output that names a different key', async () => {
    const seed = await mnemonicToSeed(MNEMONIC);
    const key = deriveAddress(seed, XFER_MAINNET, 0, 0, 0);
    const other = deriveAddress(seed, XFER_MAINNET, 0, 0, 1);
    expect(() =>
      buildAndSignEvrTx({
        inputs: [
          {
            txid: 'ab'.repeat(32),
            vout: 0,
            valueSats: 500_000_000_000n,
            scriptPubKeyHex: bytesToHex(p2pkScript(other.publicKey)),
            privateKey: key.privateKey,
            publicKey: key.publicKey,
          },
        ],
        outputs: [{ address: key.address, valueSats: 100_000_000_000n }],
        changeAddress: key.address,
        feeSats: 250_000n,
        net: XFER_MAINNET,
      }),
    ).toThrow(/different key/);
  });
});

/**
 * A scripted server. The seed's receive key 2 was the node's lottery key: it has
 * NO address history at all, only rewards on its pay-to-pubkey script, one long
 * mature and one won ten blocks ago.
 */
async function lotteryWorld(net = XFER_MAINNET) {
  const seed = await mnemonicToSeed(MNEMONIC);
  const key0 = deriveAddress(seed, net, 0, 0, 0);
  const key2 = deriveAddress(seed, net, 0, 0, 2);
  const script2 = bytesToHex(p2pkScript(key2.publicKey));
  const sh2 = scriptToElectrumScripthash(p2pkScript(key2.publicKey));
  const mature = prevout(1, 5000 * COIN, script2);
  const fresh = prevout(2, 5000 * COIN, script2);
  const raws = new Map([
    [mature.txid, mature.raw],
    [fresh.txid, fresh.raw],
  ]);
  const utxos = [
    { tx_hash: mature.txid, tx_pos: 0, height: TIP - 500, value: 5000 * COIN },
    { tx_hash: fresh.txid, tx_pos: 0, height: TIP - 10, value: 5000 * COIN },
  ];
  const asked: string[] = [];
  const client: ElectrumClient = {
    connect: async () => {},
    isConnected: () => true,
    endpoint: () => 'wss://fake',
    close: () => {},
    request: async (method: string, params: unknown[] = []) => {
      const sh = params[0] as string;
      if (method === ELECTRUM_METHODS.estimateFee) return 0.012 as never;
      if (method === ELECTRUM_METHODS.headersSubscribe) return { height: TIP } as never;
      if (method === ELECTRUM_METHODS.getHistory) {
        asked.push(sh);
        return (sh === sh2 ? utxos.map((u) => ({ tx_hash: u.tx_hash, height: u.height })) : []) as never;
      }
      if (method === ELECTRUM_METHODS.getBalance) {
        asked.push(sh);
        return { confirmed: sh === sh2 ? 10_000 * COIN : 0, unconfirmed: 0 } as never;
      }
      if (method === ELECTRUM_METHODS.listUnspent) {
        asked.push(sh);
        return (sh === sh2 ? utxos : []) as never;
      }
      if (method === ELECTRUM_METHODS.txGet) {
        const raw = raws.get(sh);
        if (!raw) throw new Error(`no prevout for ${sh}`);
        return raw as never;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { client, key0, key2, sh2, mature, fresh, asked };
}

describe('X Coin wallet with lottery winnings', () => {
  it('the address scan finds a key whose only history is pay-to-pubkey rewards', async () => {
    const w = await lotteryWorld();
    const svc = new LiveWalletService(w.client);
    await svc.import(MNEMONIC, 'pw', 'xfer-mainnet');

    const res = await svc.discoverUsedAddresses();
    expect(res.highestUsedIndex).toBe(2);
    expect(res.addressCountAfter).toBe(3);
    expect((await svc.listAddresses()).map((a) => a.address)).toContain(w.key2.address);
  });

  it('counts the rewards in the balance of the key they belong to', async () => {
    const w = await lotteryWorld();
    const svc = new LiveWalletService(w.client);
    await svc.import(MNEMONIC, 'pw', 'xfer-mainnet');
    await svc.discoverUsedAddresses();

    const provider = (svc.getProvider() as ElectrumWalletDataProvider);
    const [native] = await provider.getBalances(w.key2.address);
    expect(native.assetId).toBe('XFER');
    expect(native.amountBase).toBe(BigInt(10_000 * COIN));
    const [empty] = await provider.getBalances(w.key0.address);
    expect(empty.amountBase).toBe(0n);
    expect(await provider.getAddressHistory(w.key2.address)).toHaveLength(2);
    // The Home rows come from the unspent list, which must agree.
    const [row] = await provider.getAllAssetBalances(w.key2.address);
    expect(row.amountBase).toBe(BigInt(10_000 * COIN));
  });

  it('spends a mature reward and leaves a fresh one alone', async () => {
    const w = await lotteryWorld();
    const svc = new LiveWalletService(w.client);
    await svc.import(MNEMONIC, 'pw', 'xfer-mainnet');
    await svc.discoverUsedAddresses();

    // 10,000 on chain, but only the mature 5,000 can be spent yet.
    const max = await svc.estimateMaxEvr();
    expect(max.totalSats).toBe(BigInt(5000 * COIN));
    await expect(svc.buildEvrSend(w.key0.address, BigInt(6000 * COIN))).rejects.toThrow('insufficient-funds');

    const plan = await svc.buildEvrSend(w.key0.address, BigInt(1000 * COIN));
    expect(plan.built.rawHex).toContain(reverseHex(w.mature.txid));
    expect(plan.built.rawHex).not.toContain(reverseHex(w.fresh.txid));
    // Signature-only scriptSig: the reward key's pubkey appears nowhere.
    expect(plan.built.rawHex).not.toContain(bytesToHex(w.key2.publicKey));
  });

  it('a chain without pubkey rewards never asks for the second scripthash', async () => {
    const w = await lotteryWorld(EVRMORE_MAINNET);
    const svc = new LiveWalletService(w.client);
    await svc.import(MNEMONIC, 'pw');
    await svc.discoverUsedAddresses();
    await (svc.getProvider() as ElectrumWalletDataProvider).getAddressHistory(w.key0.address);
    await expect(svc.buildEvrSend(w.key0.address, BigInt(COIN))).rejects.toThrow('insufficient-funds');

    const seed = await mnemonicToSeed(MNEMONIC);
    const p2pkOfAnyKey = new Set<string>();
    for (let i = 0; i < 40; i++) {
      p2pkOfAnyKey.add(scriptToElectrumScripthash(p2pkScript(deriveAddress(seed, EVRMORE_MAINNET, 0, 0, i).publicKey)));
    }
    expect(w.asked.some((sh) => p2pkOfAnyKey.has(sh))).toBe(false);
    expect(w.asked).toContain(addressToElectrumScripthash(w.key0.address));
  });
});
