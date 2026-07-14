// Live proof of the full LiveWalletService against the real chain.
// Run: npx vite-node scripts/live-wallet-probe.ts
import { LiveWalletService } from '../src/services/chain/liveWallet';
import { deriveAddress, mnemonicToSeed } from '../src/services/chain/keys';
import { EVRMORE_MAINNET } from '../src/services/chain/chainParams';

const VECTOR_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function main() {
  const svc = new LiveWalletService();
  await svc.import(VECTOR_MNEMONIC, 'probe-password');
  const address = svc.getAddress(0);
  // Independent expectation via the keys module (no passphrase, the real-wallet case).
  const expected = deriveAddress(await mnemonicToSeed(VECTOR_MNEMONIC), EVRMORE_MAINNET, 0, 0, 0).address;
  console.log('derived address:', address, address === expected ? '(matches keys module ✓)' : '(MISMATCH!)');
  if (address !== expected) throw new Error('address mismatch');

  const provider = svc.getProvider();
  const net = await provider.getNetworkStatus();
  console.log('network:', net.state, 'height', net.blockHeight, net.serverVersion);
  const balances = await provider.getBalances(address);
  console.log('live balances:', balances.map((b) => `${b.assetId}=${b.amount}`).join(', '));

  // Build path reaches coin selection; unfunded vector address => insufficient.
  try {
    await svc.buildEvrSend(expected, 1_000_000n);
    console.log('unexpected: build succeeded (address funded?)');
  } catch (e) {
    console.log('buildEvrSend on unfunded address ->', (e as Error).message, '(expected)');
  }
  console.log('OK: live wallet service round-trip works');
}

main().catch((e) => {
  console.error('LIVE WALLET PROBE FAILED:', e);
  process.exit(1);
});
