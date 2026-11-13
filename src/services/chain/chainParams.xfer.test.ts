// X Coin (XFER) chain registration: parameter provenance, address and key
// derivation, the Ravencoin asset dialect, the fee policy and the pool wiring.
//
// The fixtures marked LIVE were read from the chain itself on 2026-11-12 through
// the owner's own node (getblock, verbosity 2), so they are independent of every
// encoder in this wallet:
//   - block 20022, tx 1a945de3…b9ff, output 0: a plain P2PKH output
//   - block 20022, tx 50f0a9e5…d930, output 0: a transfer_asset output
//   - block 1 coinbase: a pay-to-pubkey output and the address the node reports
// The derivation fixtures come from @scure/bip32 driven directly (not through
// keys.ts) with the public BIP39 test phrase, path m/44'/3844'/0'/c/i.

import { describe, expect, it } from 'vitest';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  addressToHash160,
  decodeSegwitAddress,
  decodeWif,
  deriveAddress,
  isP2pkhAddress,
  isSpendableAddress,
  isValidAddress,
  mnemonicToSeed,
  pubkeyToAddress,
} from './keys';
import {
  BITCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  BITCOIN_BLAKE2B_MAINNET,
  CHAIN_FEE_POLICIES,
  DOGECOIN_MAINNET,
  EVRMORE_MAINNET,
  LITECOIN_MAINNET,
  NEOXA_MAINNET,
  RAVENCOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  XFER_MAINNET,
  chainsShareDerivation,
  derivationPath,
  feePolicyFor,
  isNewChain,
  isYoungChain,
  networkFor,
  supportsAssets,
  supportsSegwit,
  type EvrmoreNetwork,
} from './chainParams';
import { buildTransferAssetScript, decodeAssetScript } from './assetScript';
import {
  buildXferElectrumPool,
  electrumServersStorageKey,
  electrumWssUrl,
  gatewayElectrumUrl,
} from './network';

const b58c = base58check(sha256);

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const XFER_ADDR_0 = 'XfAejBQdMTb53dLq6JTgaTdiCYmeKfnXmU';
const XFER_ADDR_1 = 'Xu8ZSmhpKw8diNYiv2N1P1i8w1cZZHvPCh';
const XFER_CHANGE_0 = 'Xx2RXjR3d3sdaC5iFcAUp69UKAWEtoyFDE';
const XFER_WIF_0 = 'XJYYyUT9q1iBYZkYjrdbNeg1WhBeeJkQgs6r1vWWopNXmaZE8pTk';

// LIVE fixtures (see the header).
const LIVE_P2PKH_ADDRESS = 'XmLv1ZYu8qMsGTsWvD9N7C7AFcK844nHwF';
const LIVE_P2PKH_HASH160 = '74e48d419b9884981567aedc53a575b2eb381d59';
const LIVE_ASSET_ADDRESS = 'Xi3UpFEU3nx9uqKB2sRxCUE9ur7PMoexoy';
const LIVE_ASSET_SCRIPT =
  '76a91450b0123ebedeadb13e6b40c215afce635653312c88acc02572766e74184c41554e43485f584645522f58434f494e5f53545245414d80dd49d81600000075';
const LIVE_ASSET_NAME = 'LAUNCH_XFER/XCOIN_STREAM';
const LIVE_ASSET_SATS = 98_118_000_000n; // 80dd49d816000000 little-endian
const LIVE_COINBASE_PUBKEY = '0376189200b8195792a3381f274b728fff23b733de62514adaf1e8441b4a7dbc79';
const LIVE_COINBASE_ADDRESS = 'XyigS6yZ6nXgSqXBMzQdWqoAhStw38Ftic';

const OTHERS: readonly EvrmoreNetwork[] = [
  EVRMORE_MAINNET,
  RAVENCOIN_MAINNET,
  BITCOINGOLD_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
  BITCOIN_MAINNET,
  DOGECOIN_MAINNET,
  NEOXA_MAINNET,
  BITCOIN_BLAKE2B_MAINNET,
];

describe('X Coin parameters (NiftyRaven/x-coin v1.0.27 chainparams.cpp)', () => {
  it('carries the verified constants', () => {
    const net = XFER_MAINNET;
    expect(net.chainId).toBe('xfer-mainnet');
    expect(net.pubKeyHash).toBe(76);
    expect(net.scriptHash).toBe(139);
    expect(net.wif).toBe(204);
    expect(net.coinType).toBe(3844);
    expect(net.bip32).toEqual({ public: 0x0488b21e, private: 0x0488ade4 });
    expect(net.messageMagic).toBe('X Coin Signed Message:\n');
    expect(net.ticker).toBe('XFER');
    expect(net.decimals).toBe(8);
    expect(net.addressFormat).toBe('p2pkh');
    expect(net.bech32Hrp).toBeUndefined();
    expect(supportsSegwit(net)).toBe(false);
  });

  it('resolves by chain id and never falls through to Evrmore', () => {
    expect(networkFor('xfer-mainnet')).toBe(XFER_MAINNET);
    expect(networkFor('xfer-mainnet')).not.toBe(EVRMORE_MAINNET);
  });

  it('is young AND new: one seed node signs every block, and it is new in this wallet', () => {
    expect(isYoungChain(XFER_MAINNET)).toBe(true);
    expect(isNewChain(XFER_MAINNET)).toBe(true);
  });

  it('shares its address bytes, WIF byte and coin type with no other chain here', () => {
    for (const other of OTHERS) {
      expect(other.pubKeyHash).not.toBe(76);
      expect(other.scriptHash).not.toBe(139);
      expect(other.scriptHashLegacy ?? -1).not.toBe(139);
      expect(other.wif).not.toBe(204);
      expect(other.coinType).not.toBe(3844);
      expect(chainsShareDerivation('xfer-mainnet', other.chainId)).toBe(false);
      expect(chainsShareDerivation(other.chainId, 'xfer-mainnet')).toBe(false);
    }
  });
});

describe('X Coin addresses and keys', () => {
  it('uses BIP44 with coin type 3844', () => {
    expect(derivationPath(XFER_MAINNET, 0, 0, 0)).toBe("m/44'/3844'/0'/0/0");
    expect(derivationPath(XFER_MAINNET, 0, 1, 7)).toBe("m/44'/3844'/0'/1/7");
  });

  it('derives the independently computed addresses and WIF', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    const first = deriveAddress(seed, XFER_MAINNET, 0, 0, 0);
    expect(first.address).toBe(XFER_ADDR_0);
    expect(first.wif).toBe(XFER_WIF_0);
    expect(deriveAddress(seed, XFER_MAINNET, 0, 0, 1).address).toBe(XFER_ADDR_1);
    expect(deriveAddress(seed, XFER_MAINNET, 0, 1, 0).address).toBe(XFER_CHANGE_0);
    expect(b58c.decode(first.wif)[0]).toBe(204);
    const { privateKey, compressed } = decodeWif(first.wif);
    expect(compressed).toBe(true);
    expect(privateKey).toEqual(first.privateKey);
    expect(decodeSegwitAddress(first.address)).toBeNull();
    expect(pubkeyToAddress(first.publicKey, XFER_MAINNET)).toBe(first.address);
  });

  it('decodes a LIVE mainnet address to the hash160 its output script carries', () => {
    const { version, hash } = addressToHash160(LIVE_P2PKH_ADDRESS);
    expect(version).toBe(76);
    expect(bytesToHex(hash)).toBe(LIVE_P2PKH_HASH160);
  });

  it('encodes the LIVE block 1 coinbase key to the address the node reports', () => {
    expect(pubkeyToAddress(hexToBytes(LIVE_COINBASE_PUBKEY), XFER_MAINNET)).toBe(LIVE_COINBASE_ADDRESS);
  });

  it('accepts its own addresses and can pay only the P2PKH form', () => {
    for (const addr of [XFER_ADDR_0, LIVE_P2PKH_ADDRESS, LIVE_ASSET_ADDRESS]) {
      expect(isValidAddress(addr, XFER_MAINNET)).toBe(true);
      expect(isP2pkhAddress(addr, XFER_MAINNET)).toBe(true);
      expect(isSpendableAddress(addr, XFER_MAINNET)).toBe(true);
    }
    // A P2SH address (version 139, 'x…' or 'y…') is recognised but never payable.
    const p2sh = b58c.encode(Uint8Array.of(139, ...hexToBytes(LIVE_P2PKH_HASH160)));
    expect(p2sh).toBe('y7dv3QL3sCZ4nmeyTe8Sf6FiuPYYmnni5k'); // computed outside this wallet
    expect(isValidAddress(p2sh, XFER_MAINNET)).toBe(true);
    expect(isSpendableAddress(p2sh, XFER_MAINNET)).toBe(false);
  });

  it('is refused by every other chain, and refuses theirs', async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    for (const other of OTHERS) {
      expect(isSpendableAddress(XFER_ADDR_0, other)).toBe(false);
      const foreign = deriveAddress(seed, other, 0, 0, 0).address;
      expect(isSpendableAddress(foreign, XFER_MAINNET)).toBe(false);
    }
  });
});

describe('X Coin assets: the Ravencoin protocol, byte for byte', () => {
  it('speaks the asset dialect with the rvn marker', () => {
    expect(supportsAssets(XFER_MAINNET)).toBe(true);
    expect(XFER_MAINNET.assetMarkerPrefix).toBe('rvn');
  });

  it('rebuilds a LIVE transfer_asset script exactly', () => {
    const built = buildTransferAssetScript(LIVE_ASSET_ADDRESS, LIVE_ASSET_NAME, LIVE_ASSET_SATS, 'rvn');
    expect(bytesToHex(built)).toBe(LIVE_ASSET_SCRIPT);
  });

  it('decodes that script with the rvn marker and not with the evr one', () => {
    const decoded = decodeAssetScript(LIVE_ASSET_SCRIPT, 'rvn');
    expect(decoded).not.toBeNull();
    expect(decoded?.transfer.name).toBe(LIVE_ASSET_NAME);
    expect(decoded?.transfer.amount).toBe(LIVE_ASSET_SATS);
    expect(decoded?.markerPrefix).toBe('rvn');
    expect(decodeAssetScript(LIVE_ASSET_SCRIPT, 'evr')).toBeNull();
  });
});

describe('X Coin fee policy (validation.h DEFAULT_MIN_RELAY_TX_FEE = 1000000 sat/kB)', () => {
  it('floors at the relay minimum and stays bounded', () => {
    const policy = feePolicyFor(XFER_MAINNET);
    expect(policy).toBe(CHAIN_FEE_POLICIES['xfer-mainnet']);
    expect(policy.floorSatPerByte).toBe(1000n);
    expect(policy.defaultSatPerByte).toBeGreaterThan(policy.floorSatPerByte);
    expect(policy.ceilingSatPerByte).toBe(10_000n);
    expect(policy.maxTxFeeSats).toBe(100_000_000n);
  });
});

describe('X Coin Electrum pool: the gateway bridge alone', () => {
  it('is empty without a gateway and one bridge entry with one', () => {
    expect(buildXferElectrumPool('', '')).toEqual([]);
    const pool = buildXferElectrumPool('https://gw.example', 'tok');
    expect(pool).toHaveLength(1);
    expect(pool[0].gateway).toBe(true);
    expect(electrumWssUrl(pool[0])).toBe('wss://gw.example/electrum/xfer');
    expect(gatewayElectrumUrl('xfer', 'https://gw.example')).toBe('wss://gw.example/electrum/xfer');
  });

  it('keeps its saved servers in its own storage slot', () => {
    expect(electrumServersStorageKey('xfer-mainnet')).toBe('electrumServers:xfer-mainnet');
    expect(electrumServersStorageKey('xfer-mainnet')).not.toBe(electrumServersStorageKey('neoxa-mainnet'));
    expect(electrumServersStorageKey('xfer-mainnet')).not.toBe(electrumServersStorageKey());
  });
});
