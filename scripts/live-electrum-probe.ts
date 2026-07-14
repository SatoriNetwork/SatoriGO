// Live end-to-end proof: drives the REAL Electrum WSS client against the public
// Evrmore server (wss://...:50004). Run: npx vite-node scripts/live-electrum-probe.ts
import { createElectrumClient, electrumGetBalance, electrumGetHistory } from '../src/services/chain/electrumClient';
import { ELECTRUM_METHODS } from '../src/services/chain/network';
import { addressToElectrumScripthash } from '../src/services/chain/keys';

const KNOWN_ADDRESS = 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF'; // Trezor-vector m/44'/175'/0'/0/0

async function main() {
  const client = createElectrumClient();
  await client.connect(); // performs the server.version handshake internally
  console.log('connected:', client.endpoint());

  const header = await client.request<{ height: number }>(ELECTRUM_METHODS.headersSubscribe, []);
  console.log('block height:', header.height);

  const sh = addressToElectrumScripthash(KNOWN_ADDRESS);
  console.log('scripthash:', sh);
  const evr = await electrumGetBalance(client, sh);
  const satori = await electrumGetBalance(client, sh, 'SATORI');
  const history = await electrumGetHistory(client, sh);
  console.log('EVR balance (sats):', evr);
  console.log('SATORI balance (sats):', satori);
  console.log('history length:', history.length);

  client.close();
  console.log('OK: live watch-only round-trip works');
}

main().catch((e) => {
  console.error('LIVE PROBE FAILED:', e);
  process.exit(1);
});
