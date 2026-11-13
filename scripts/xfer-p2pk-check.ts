// X Coin pay-to-pubkey cross-check material. Prints, for the public BIP39 test
// phrase (unfunded), a transaction that spends an INVENTED pay-to-pubkey output,
// signed by the wallet's own builder, plus everything a Core node needs to check
// that signature (`signrawtransaction <hex> <prevtxs> <keys>` reports
// complete:true only when the existing signature verifies). Also prints the
// Electrum scripthash of a real lottery winner's pubkey so a server read can be
// compared with the chain. Nothing is broadcast; the spent output does not exist.
//
//   npx tsx scripts/xfer-p2pk-check.ts

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { XFER_MAINNET } from '../src/services/chain/chainParams';
import { deriveAddress, mnemonicToSeed, p2pkScript, scriptToElectrumScripthash } from '../src/services/chain/keys';
import { buildAndSignEvrTx } from '../src/services/chain/txBuilder';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Coinbase of block 89,000 pays this key (address XdVq8vEtQ8cfbQxnZXgZ671zpjovDcuyZL).
const WINNER_PUBKEY = '030cbcfe985f7252764d0d23b3743ed898c85134d499cee2c77848e9f0ca8ea8fe';

const seed = await mnemonicToSeed(MNEMONIC);
const key = deriveAddress(seed, XFER_MAINNET, 0, 0, 0);
const script = bytesToHex(p2pkScript(key.publicKey));
const prevTxid = 'ab'.repeat(32);

const built = buildAndSignEvrTx({
  inputs: [
    { txid: prevTxid, vout: 0, valueSats: 500_000_000_000n, scriptPubKeyHex: script, privateKey: key.privateKey, publicKey: key.publicKey },
  ],
  outputs: [{ address: key.address, valueSats: 100_000_000_000n }],
  changeAddress: key.address,
  feeSats: 250_000n,
  net: XFER_MAINNET,
});

console.log(
  JSON.stringify({
    rawHex: built.rawHex,
    prevtxs: [{ txid: prevTxid, vout: 0, scriptPubKey: script, amount: 5000 }],
    wif: key.wif,
    address: key.address,
    winnerP2pkScripthash: scriptToElectrumScripthash(p2pkScript(hexToBytes(WINNER_PUBKEY))),
  }),
);
