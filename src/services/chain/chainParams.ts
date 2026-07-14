// Evrmore chain parameters.
//
// SOURCE OF TRUTH: EvrmoreOrg/Evrmore, src/chainparams.cpp (fetched from the
// official repo, not guessed). Getting these wrong = incompatible or
// unspendable addresses, so every value below is annotated with its origin.
//
//   mainnet base58Prefixes[PUBKEY_ADDRESS] = 33   -> addresses begin with 'E'
//   mainnet base58Prefixes[SCRIPT_ADDRESS] = 92   -> addresses begin with 'e'
//   mainnet base58Prefixes[SECRET_KEY]     = 128  (WIF)
//   mainnet EXT_PUBLIC_KEY = 0x0488B21E  (xpub)
//   mainnet EXT_SECRET_KEY = 0x0488ADE4  (xprv)
//   mainnet nExtCoinType   = 175         (SLIP-44, shared with Ravencoin)
//   asset script opcode OP_EVR_ASSET = 0xc0 (src/script/script.h)

export interface EvrmoreNetwork {
  id: 'mainnet' | 'testnet';
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
  /** P2P network magic + default port (informational; the wallet uses Electrum). */
  messageStart: number;
  defaultPort: number;
}

export const EVRMORE_MAINNET: EvrmoreNetwork = {
  id: 'mainnet',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 33,
  scriptHash: 92,
  wif: 128,
  coinType: 175,
  messageStart: 0x45,
  defaultPort: 8820,
};

export const EVRMORE_TESTNET: EvrmoreNetwork = {
  id: 'testnet',
  bip32: { public: 0x043587cf, private: 0x04358394 },
  pubKeyHash: 111,
  scriptHash: 196,
  wif: 239,
  coinType: 1,
  messageStart: 0x45,
  defaultPort: 18820,
};

/** Asset script opcode (OP_EVR_ASSET); marks an asset transfer/issuance output. */
export const OP_EVR_ASSET = 0xc0;

/** BIP44 account path for Evrmore, e.g. m/44'/175'/0'/0/0. */
export function bip44Path(net: EvrmoreNetwork, account: number, change: 0 | 1, index: number): string {
  return `m/44'/${net.coinType}'/${account}'/${change}/${index}`;
}

export function networkFor(id: EvrmoreNetwork['id']): EvrmoreNetwork {
  return id === 'testnet' ? EVRMORE_TESTNET : EVRMORE_MAINNET;
}
