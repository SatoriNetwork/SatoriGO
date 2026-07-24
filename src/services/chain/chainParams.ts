// UTXO-legacy chain parameters (Evrmore + Ravencoin).
//
// SOURCE OF TRUTH: each chain's own chainparams.cpp / validation.cpp, fetched
// from the official repo (not guessed). Getting these wrong = incompatible or
// unspendable addresses, so every value below is annotated with its origin.
//
// EVRMORE — EvrmoreOrg/Evrmore, src/chainparams.cpp:
//   mainnet base58Prefixes[PUBKEY_ADDRESS] = 33   -> addresses begin with 'E'
//   mainnet base58Prefixes[SCRIPT_ADDRESS] = 92   -> addresses begin with 'e'
//   mainnet base58Prefixes[SECRET_KEY]     = 128  (WIF)
//   mainnet EXT_PUBLIC_KEY = 0x0488B21E  (xpub)
//   mainnet EXT_SECRET_KEY = 0x0488ADE4  (xprv)
//   mainnet nExtCoinType   = 175         (SLIP-44, shared with Ravencoin)
//   asset script opcode OP_EVR_ASSET = 0xc0 (src/script/script.h)
//   strMessageMagic = "Evrmore Signed Message:\n" (src/validation.cpp)
//
// RAVENCOIN — RavenProject/Ravencoin, verified 2026-07-21 against master:
//   src/chainparams.cpp (CMainParams):
//     line 195  base58Prefixes[PUBKEY_ADDRESS] = 60   -> addresses begin with 'R'
//     line 196  base58Prefixes[SCRIPT_ADDRESS] = 122
//     line 197  base58Prefixes[SECRET_KEY]     = 128  (WIF)
//     line 198  base58Prefixes[EXT_PUBLIC_KEY] = {0x04,0x88,0xB2,0x1E}
//     line 199  base58Prefixes[EXT_SECRET_KEY] = {0x04,0x88,0xAD,0xE4}
//     line 202  nExtCoinType = 175   (SLIP-44, SHARED with Evrmore)
//     line 177  pchMessageStart = 0x52,0x41,0x56,0x4e ("RAVN"); nDefaultPort 8767
//   src/script/script.h:188  OP_RVN_ASSET = 0xc0  (same opcode value as Evrmore)
//   src/assets/assets.cpp: transfer marker bytes RVN_R,RVN_V,RVN_N,RVN_T ("rvnt"),
//     issue "rvnq", reissue "rvnr", owner "rvno" (assets.h:19 RVN_R=114='r').
//   src/validation.cpp:129  strMessageMagic = "Raven Signed Message:\n"
//
// SHARED-KEY PROPERTY: because Evrmore and Ravencoin share coinType 175 and the
// same BIP32 mainnet version bytes, the same seed + path derives the SAME
// private/public key and therefore the SAME hash160 on both chains. Only the
// address VERSION byte differs (33 'E' vs 60 'R'). Verified in keys.test.ts.

/** Canonical identity of a supported chain+network. */
export type ChainId = 'evrmore-mainnet' | 'evrmore-testnet' | 'ravencoin-mainnet';

export interface EvrmoreNetwork {
  /** Legacy electrum-network role ('mainnet'|'testnet'). Kept for the Electrum
   *  server pool + stored-wallet compatibility; NOT the cross-chain identity —
   *  Ravencoin mainnet also carries id:'mainnet'. Use `chainId` to distinguish. */
  id: 'mainnet' | 'testnet';
  /** Canonical cross-chain identity (chain + network). */
  chainId: ChainId;
  /** BIP32 version bytes. */
  bip32: { public: number; private: number };
  /** base58check version byte for P2PKH addresses. */
  pubKeyHash: number;
  /** base58check version byte for P2SH addresses. */
  scriptHash: number;
  /** base58check version byte for WIF private keys. */
  wif: number;
  /** SLIP-44 coin type used in the BIP44 derivation path. */
  coinType: number;
  /** P2P network magic (first byte) + default port (informational; the wallet
   *  uses Electrum, never the P2P protocol). */
  messageStart: number;
  defaultPort: number;
  /** 3-char asset-marker family prefix appended inside OP_x_ASSET scripts:
   *  'evr' -> markers evrt/evrq/evrr/evro; 'rvn' -> rvnt/rvnq/rvnr/rvno. */
  assetMarkerPrefix: 'evr' | 'rvn';
  /** Bitcoin-style signed-message magic (byte-exact; interoperability-critical). */
  messageMagic: string;
  /** Native-coin ticker symbol. */
  ticker: 'EVR' | 'RVN';
  /** Human-readable chain name (informational; not a user-facing i18n string). */
  displayName: string;
}

/** Alias for the generalised (multi-chain) network type. The `EvrmoreNetwork`
 *  name is retained for the existing callers that import it; new code may prefer
 *  `ChainNetwork`. Both are the same shape. */
export type ChainNetwork = EvrmoreNetwork;

export const EVRMORE_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  chainId: 'evrmore-mainnet',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 33,
  scriptHash: 92,
  wif: 128,
  coinType: 175,
  messageStart: 0x45,
  defaultPort: 8820,
  assetMarkerPrefix: 'evr',
  messageMagic: 'Evrmore Signed Message:\n',
  ticker: 'EVR',
  displayName: 'Evrmore',
};

export const EVRMORE_TESTNET: EvrmoreNetwork = {
  id: 'testnet',
  chainId: 'evrmore-testnet',
  bip32: { public: 0x043587cf, private: 0x04358394 },
  pubKeyHash: 111,
  scriptHash: 196,
  wif: 239,
  coinType: 1,
  messageStart: 0x45,
  defaultPort: 18820,
  assetMarkerPrefix: 'evr',
  messageMagic: 'Evrmore Signed Message:\n',
  ticker: 'EVR',
  displayName: 'Evrmore Testnet',
};

// Ravencoin mainnet. `id:'mainnet'` keeps the Electrum-network role identical to
// Evrmore mainnet (asset-aware ElectrumX, same method dialect); `chainId`
// distinguishes it. Every value verified vs RavenProject/Ravencoin master (see
// the header block above for exact source lines).
export const RAVENCOIN_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  chainId: 'ravencoin-mainnet',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 }, // chainparams.cpp:198/199
  pubKeyHash: 60, // chainparams.cpp:195 -> 'R'
  scriptHash: 122, // chainparams.cpp:196
  wif: 128, // chainparams.cpp:197
  coinType: 175, // chainparams.cpp:202 (SLIP-44, shared with Evrmore)
  messageStart: 0x52, // chainparams.cpp:177 pchMessageStart[0] = 0x52 ('R' of "RAVN")
  defaultPort: 8767, // chainparams.cpp:181
  assetMarkerPrefix: 'rvn', // assets.cpp transfer marker RVN_R/V/N/T -> "rvnt"
  messageMagic: 'Raven Signed Message:\n', // validation.cpp:129
  ticker: 'RVN',
  displayName: 'Ravencoin',
};

/** Asset script opcode (OP_EVR_ASSET / OP_RVN_ASSET); marks an asset
 *  transfer/issuance output. Both chains use the SAME value 0xc0. */
export const OP_EVR_ASSET = 0xc0;

/** BIP44 account path, e.g. m/44'/175'/0'/0/0. */
export function bip44Path(net: EvrmoreNetwork, account: number, change: 0 | 1, index: number): string {
  return `m/44'/${net.coinType}'/${account}'/${change}/${index}`;
}

/**
 * Resolve a network from either a legacy id ('mainnet'|'testnet', which mean the
 * EVRMORE mainnet/testnet for backwards compatibility) or a canonical ChainId.
 * Unknown values fall back to EVRMORE_MAINNET (fail safe: the historical default).
 */
export function networkFor(id: ChainId | EvrmoreNetwork['id']): EvrmoreNetwork {
  switch (id) {
    case 'ravencoin-mainnet':
      return RAVENCOIN_MAINNET;
    case 'testnet':
    case 'evrmore-testnet':
      return EVRMORE_TESTNET;
    case 'mainnet':
    case 'evrmore-mainnet':
    default:
      return EVRMORE_MAINNET;
  }
}
