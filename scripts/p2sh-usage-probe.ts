// Measure how much P2SH is ACTUALLY used on the live Evrmore chain, so the decision
// to implement P2SH output support is based on data, not on a guess.
// Read-only, no funds. Run: npx vite-node scripts/p2sh-usage-probe.ts
//
// Method: take real, busy Evrmore addresses (Satori pool addresses, fetched live from
// network.satorinet.io), pull their transaction history over ElectrumX, fetch the raw
// transactions, and classify EVERY output script:
//
//   P2PKH  76 a9 14 <20B> 88 ac
//   P2SH   a9 14 <20B> 87            <-- the thing we cannot currently send to
//   asset  ... OP_EVR_ASSET (0xc0) ...
//   other  (OP_RETURN, bare multisig, unknown)
import { createElectrumClient, electrumGetRawTx, electrumGetHistory } from '../src/services/chain/electrumClient';
import { PUBLIC_ELECTRUM_SERVERS } from '../src/services/chain/network';
import { addressToElectrumScripthash } from '../src/services/chain/keys';
import { parseTxOutputValues } from '../src/services/chain/verifyUtxo';

const MAX_ADDRESSES = 6;
const MAX_TXS_PER_ADDRESS = 40;

/** Pull the raw output scripts out of a legacy (non-segwit) transaction. */
function outputScripts(rawHex: string): string[] {
  const b = Buffer.from(rawHex, 'hex');
  let o = 4; // version

  const varint = (): number => {
    const n = b[o];
    if (n < 0xfd) {
      o += 1;
      return n;
    }
    if (n === 0xfd) {
      const v = b.readUInt16LE(o + 1);
      o += 3;
      return v;
    }
    if (n === 0xfe) {
      const v = b.readUInt32LE(o + 1);
      o += 5;
      return v;
    }
    const v = Number(b.readBigUInt64LE(o + 1));
    o += 9;
    return v;
  };

  const vin = varint();
  for (let i = 0; i < vin; i++) {
    o += 36; // outpoint
    const len = varint();
    o += len + 4; // scriptSig + sequence
  }

  const vout = varint();
  const scripts: string[] = [];
  for (let i = 0; i < vout; i++) {
    o += 8; // value
    const len = varint();
    scripts.push(b.subarray(o, o + len).toString('hex'));
    o += len;
  }
  return scripts;
}

function classify(script: string): 'P2PKH' | 'P2SH' | 'asset' | 'other' {
  const isP2pkh = script.startsWith('76a914') && script.endsWith('88ac') && script.length === 50;
  const isP2sh = script.startsWith('a914') && script.endsWith('87') && script.length === 46;
  // OP_EVR_ASSET = 0xc0; an asset output is a normal script with the asset payload appended.
  const hasAsset = script.includes('c0');

  if (isP2pkh) return 'P2PKH';
  if (isP2sh) return 'P2SH';
  if (hasAsset && script.startsWith('76a914')) return 'asset';
  if (hasAsset) return 'asset';
  return 'other';
}

async function main() {
  // Real, busy addresses: the Satori pool operators.
  const res = await fetch('https://network.satorinet.io/api/v1/pool/open');
  const body = (await res.json()) as { pools?: { address: string }[] } | { address: string }[];
  const pools = Array.isArray(body) ? body : (body.pools ?? []);
  const addresses = pools.map((p) => p.address).filter(Boolean).slice(0, MAX_ADDRESSES);
  console.log(`Sampling ${addresses.length} live Satori pool addresses.\n`);

  const client = createElectrumClient(PUBLIC_ELECTRUM_SERVERS);
  await client.connect();

  const tally = { P2PKH: 0, P2SH: 0, asset: 0, other: 0 };
  const seenTx = new Set<string>();
  let addrP2pkh = 0;
  let addrP2sh = 0;

  for (const addr of addresses) {
    (addr.startsWith('E') ? () => addrP2pkh++ : () => addrP2sh++)();
    const sh = addressToElectrumScripthash(addr);
    const history = await electrumGetHistory(client, sh);
    const txids = history.slice(-MAX_TXS_PER_ADDRESS).map((h) => h.tx_hash);
    console.log(`  ${addr}  ${history.length} txs (sampling ${txids.length})`);

    for (const txid of txids) {
      if (seenTx.has(txid)) continue;
      seenTx.add(txid);
      try {
        const raw = await electrumGetRawTx(client, txid);
        parseTxOutputValues(raw); // sanity: must be a legacy tx we can parse
        for (const s of outputScripts(raw)) tally[classify(s)]++;
      } catch {
        // skip anything unparseable
      }
    }
  }

  const total = tally.P2PKH + tally.P2SH + tally.asset + tally.other;
  console.log(`\n=== ${seenTx.size} real transactions, ${total} outputs classified ===`);
  for (const [k, v] of Object.entries(tally)) {
    const pct = total ? ((v / total) * 100).toFixed(2) : '0';
    console.log(`  ${k.padEnd(6)} ${String(v).padStart(6)}  ${pct.padStart(6)}%`);
  }
  console.log(`\nPool ADDRESSES themselves: ${addrP2pkh} P2PKH (E...), ${addrP2sh} non-P2PKH`);
  console.log(
    tally.P2SH === 0
      ? '\n=> ZERO P2SH outputs in this sample.'
      : `\n=> P2SH appears in this sample (${tally.P2SH} outputs).`,
  );

  client.close();
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
