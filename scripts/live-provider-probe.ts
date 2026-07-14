// Live proof of the watch-only provider end-to-end against the real chain.
// Run: npx vite-node scripts/live-provider-probe.ts
import { createElectrumClient } from '../src/services/chain/electrumClient';
import { ElectrumWalletDataProvider } from '../src/services/chain/electrumProvider';

const KNOWN_ADDRESS = 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF';

async function main() {
  const client = createElectrumClient();
  const provider = new ElectrumWalletDataProvider(client, {
    prices: { EVR: { priceUsd: 0.02, change24hPct: 1.5 }, SATORI: { priceUsd: 0.9, change24hPct: -0.3 } },
  });

  const net = await provider.getNetworkStatus();
  console.log('network:', net.state, 'height', net.blockHeight, 'latency', net.latencyMs + 'ms', net.serverVersion);

  const assets = await provider.getAssets();
  console.log('assets:', assets.map((a) => `${a.symbol}(${a.kind}, $${a.priceUsd})`).join(', '));

  const balances = await provider.getBalances(KNOWN_ADDRESS);
  console.log('balances:', balances.map((b) => `${b.assetId}=${b.amount}`).join(', '));

  const txs = await provider.getTransactions(KNOWN_ADDRESS);
  console.log('transactions fetched:', txs.length);

  client.close();
  console.log('OK: live provider round-trip works');
}

main().catch((e) => {
  console.error('LIVE PROVIDER PROBE FAILED:', e);
  process.exit(1);
});
