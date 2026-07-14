// PROVE THE ASSET-SEND VERIFICATION BUG against the LIVE Evrmore chain (read-only,
// no funds). Run: npx vite-node scripts/verify-utxo-probe.ts
//
// It demonstrates, for a REAL SATORI asset UTXO:
//   - listunspent(sh, 'SATORI').value  (the asset amount in 1e8 base units)
//   - the prevout output's 8-byte nValue field (what verifyUtxo compares against)
//   - the amount parsed from the OP_EVR_ASSET script
// proving nValue = 0 while the amount lives INSIDE the script -> the current
// `nValue === valueSats` check fails for every real asset UTXO.
//
// It ALSO probes a plain-EVR UTXO to confirm nValue === listunspent.value there
// (i.e. plain-EVR sends are NOT affected).

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  createElectrumClient,
  electrumListUnspent,
  electrumGetRawTx,
} from '../src/services/chain/electrumClient';
import { ELECTRUM_METHODS } from '../src/services/chain/network';
import { p2pkhScript } from '../src/services/chain/keys';
import { decodeAssetScript } from '../src/services/chain/assetScript';
import { txid as computeTxid } from '../src/services/chain/txBuilder';
import type { ElectrumClient } from '../src/services/chain/electrumTypes';
import type { ElectrumUtxo } from '../src/services/chain/electrumTypes';

// A live plain-EVR scripthash discovered by walking the chain (scripts/find-evr.ts).
const EVR_SCRIPTHASH = '26b861cae9d36a91be90312ae55ce45dd232c19291dd45dd62d8c15996c40421';

// Real hash160 that received SATORI on-chain (from assetScript.test.ts vectors,
// decoded from live tx 85060ed6...472467). Used to derive a scripthash to search
// for a live SATORI UTXO. If empty, we fall back to walking the asset's history.
// Discovered live (2026-07-13) by walking the SATORI tx graph from its issuance
// tx (scripts/find-satori.ts): hash160 5865ae44... holds a live SATORI UTXO.
const SEED_HASH160S = [
  '5865ae447b82872e393097ffdbfab548435a157b',
  '72e8ba9b5b0bd9cf46398f35155a9faf10e5e3eb',
  '0262bfb0ac9a63e74a32f27aad59c435d2ddd757',
];

function scripthashFromHash160(h160hex: string): string {
  const script = p2pkhScript(hexToBytes(h160hex));
  const digest = sha256(script);
  return bytesToHex(digest.slice().reverse());
}

/** Parse a raw legacy tx and return, per output, {nValue, scriptHex}. */
function parseOutputs(rawHex: string): { nValue: bigint; scriptHex: string }[] {
  const b = hexToBytes(rawHex);
  let o = 0;
  const readUintLE = (n: number): bigint => {
    let v = 0n;
    for (let i = 0; i < n; i++) v |= BigInt(b[o + i]) << BigInt(8 * i);
    o += n;
    return v;
  };
  const readVarint = (): number => {
    const first = b[o++];
    if (first < 0xfd) return first;
    if (first === 0xfd) return Number(readUintLE(2));
    if (first === 0xfe) return Number(readUintLE(4));
    return Number(readUintLE(8));
  };
  o += 4; // version
  const vin = readVarint();
  for (let i = 0; i < vin; i++) {
    o += 36;
    const sl = readVarint();
    o += sl;
    o += 4;
  }
  const vout = readVarint();
  const outs: { nValue: bigint; scriptHex: string }[] = [];
  for (let i = 0; i < vout; i++) {
    const nValue = readUintLE(8);
    const sl = readVarint();
    const scriptHex = bytesToHex(b.slice(o, o + sl));
    o += sl;
    outs.push({ nValue, scriptHex });
  }
  return outs;
}

async function findSatoriUtxo(
  client: ElectrumClient,
): Promise<{ sh: string; utxo: ElectrumUtxo } | null> {
  for (const h160 of SEED_HASH160S) {
    const sh = scripthashFromHash160(h160);
    try {
      const utxos = await electrumListUnspent(client, sh, 'SATORI');
      if (utxos.length > 0) return { sh, utxo: utxos[0] };
    } catch (e) {
      console.log(`  (listunspent SATORI on ${h160} failed: ${(e as Error).message})`);
    }
  }
  return null;
}

async function main() {
  const client = createElectrumClient();
  await client.connect();
  console.log('connected:', client.endpoint());
  const header = await client.request<{ height: number }>(ELECTRUM_METHODS.headersSubscribe, []);
  console.log('block height:', header.height);
  console.log('');

  // -------------------------------------------------------------------------
  // (a)+(b)+(c) ASSET PATH
  // -------------------------------------------------------------------------
  console.log('=== ASSET PATH (SATORI) ===');
  const found = await findSatoriUtxo(client);
  if (!found) {
    console.log('No live SATORI UTXO found at the seed addresses. Aborting asset probe.');
  } else {
    const { sh, utxo } = found;
    console.log('scripthash:', sh);
    console.log('listunspent UTXO:', JSON.stringify(utxo));
    const listunspentValue = BigInt(utxo.value);
    console.log('listunspent.value (asset base units):', listunspentValue.toString());

    const rawHex = await electrumGetRawTx(client, utxo.tx_hash);
    console.log('recomputed txid === claimed txid:', computeTxid(rawHex) === utxo.tx_hash);
    const outs = parseOutputs(rawHex);
    const out = outs[utxo.tx_pos];
    console.log('prevout scriptPubKey hex:', out.scriptHex);
    console.log('prevout nValue (8-byte EVR field):', out.nValue.toString());

    const decoded = decodeAssetScript(out.scriptHex);
    if (decoded) {
      console.log('decoded asset kind:', decoded.transfer.kind);
      console.log('decoded asset name:', decoded.transfer.name);
      console.log('decoded asset amount (from script):', decoded.transfer.amount.toString());
      console.log('');
      console.log('PROOF:');
      console.log('  nValue === 0 ?', out.nValue === 0n);
      console.log('  script-amount === listunspent.value ?',
        decoded.transfer.amount === listunspentValue);
      console.log('  current check (nValue === listunspent.value) ?',
        out.nValue === listunspentValue, '<-- FALSE means every asset send fails');
    } else {
      console.log('decodeAssetScript returned null (not an asset script!)');
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // (d) PLAIN-EVR PATH
  // -------------------------------------------------------------------------
  console.log('=== PLAIN-EVR PATH ===');
  console.log('scripthash:', EVR_SCRIPTHASH);
  const evrUtxos = await electrumListUnspent(client, EVR_SCRIPTHASH);
  console.log('EVR UTXO count:', evrUtxos.length);
  if (evrUtxos.length > 0) {
    const u = evrUtxos[0];
    console.log('listunspent UTXO:', JSON.stringify(u));
    const raw = await electrumGetRawTx(client, u.tx_hash);
    const out = parseOutputs(raw)[u.tx_pos];
    console.log('prevout nValue:', out.nValue.toString());
    console.log('prevout scriptHex:', out.scriptHex);
    console.log('nValue === listunspent.value ?', out.nValue === BigInt(u.value),
      '<-- TRUE means plain-EVR sends are NOT affected');
    console.log('is asset script?', decodeAssetScript(out.scriptHex) !== null);
  }

  client.close();
  console.log('\nprobe complete.');
}

main().catch((e) => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
