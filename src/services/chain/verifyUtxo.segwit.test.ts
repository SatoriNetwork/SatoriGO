// Segwit prevout handling in verifyUtxo.
//
// REGRESSION: this parser was legacy-only. It threw `segwit-tx-unsupported` on a
// witness serialization, and the authenticity gate hashed the server's raw bytes,
// which for a segwit transaction is the WTXID, not the txid. Together that made
// every send fail with `input-verify-failed` on Bitcoin, Litecoin and Bitcoin
// Gold as soon as any selected coin came from a segwit transaction, which is
// almost all of them and ALWAYS true of the wallet's own change. The UI blamed
// "a faulty or malicious server" for what was our own bug.

import { describe, expect, it } from 'vitest';
import { parseTx, parseTxOutputs } from './verifyUtxo';
import { txid } from './txBuilder';

// A REAL Bitcoin Gold mainnet transaction, fetched from the chain. It pays the
// owner's bcg1q… address and is witness-serialized (BIP144 marker 0001).
const REAL_SEGWIT_TX =
  '02000000000105ba9f826cd728586a664ff39981bc61b3e3a28363820e8eb13cdc9f246a4cb6' +
  '490100000000fdffffff62e99d20a253f283bb47e7f492ee73da830ce82741190c04a4c8a8d9' +
  '2bdc45720100000000fdffffff7cf5a269a6c8f8e08812d8122b4a0301512942a69ec40b80e3' +
  '87dd2339402fff0000000000fdffffffe6697be4ba8b1f901bf121df61d4b4b5a29d3edd2e5f' +
  '9f6cdfd9379755b1af3d0000000000fdffffff708b61b4281b4976b67581090cb409ee2ba0ee' +
  '90a32a1ca7459941e6e01d47840000000000fdffffff02dd2a073005000000160014364e592c' +
  '852bd49ed542a6c33348c4e04260ace5251a13bb000000001600141d18852c7036d1d8a05a43' +
  'ebd438d65a138e50f802473044022052cba2c3e295392f85e03182b09558f2c3b67b4f1d8b90' +
  '565d1dca51430f0114022076c3714e6f515f93cee645afe7099586f21c080c93522f8a05da25' +
  '3f3f294e740121038640c21fd96a5f907f7817152bd77c13d89012dd594ec53bf97f55079515' +
  'b0870247304402201bd1dd326a84392ef35489377d0c3d299f4bb60ebcbfd3a5f956e895e45a' +
  '0071022016da7c12ebf7cad9bc362a46b537acd09880df79550a66bacf7710139cf8688f0121' +
  '03b40cbcc597c3d495b18405e334416ab81bcdfba5f45e08c2e43211e70611aa4f0247304402' +
  '206f7e7ef1613264c835e59340ecb9f8593301706249df688415568d2754c0e39b0220541c6d' +
  'd74cd0689c755ee1368e4c7ecd232b2b257713c9175aecc44f8adfe607012102f10f3b22ee85' +
  'abd5ce6c126a5ff7908d9d8987180b1fae0a7e21e79fd07900520247304402200ce1a3115a8e' +
  '5492a61ddeb0eddf8e2699f08e7b79eaea648b1e3aa0f6c5f02e02204fede0827d81b1433ac0' +
  'f2270e28ce43fef3b8b5261a37a1cf14f7f9fc2e2cf40121024efd72dd0d8089d460305df48b' +
  '2bef6b02a7cf14fd053ca1ee3c29a721a0b67602473044022001eea461a7fb295994c6ff4ce7' +
  '68e6c125888ff7167db4a1e4ff98ceb0b298ae022061b7eb49835792778a2282bab1b6c68676' +
  '03a6d4e6c9a5316116c7db8b17a97c012102f10f3b22ee85abd5ce6c126a5ff7908d9d898718' +
  '0b1fae0a7e21e79fd0790052b8360000';
const REAL_TXID = '7c288d22976b64e62ea79ac019d698d0f374e356ba03e5f1be870046530c8a5e';

describe('parseTx on a real segwit transaction', () => {
  it('recognises the BIP144 marker instead of throwing', () => {
    expect(REAL_SEGWIT_TX.slice(8, 12)).toBe('0001');
    const parsed = parseTx(REAL_SEGWIT_TX);
    expect(parsed.isSegwit).toBe(true);
    expect(parsed.outputs.length).toBeGreaterThan(0);
  });

  it('derives the REAL txid from the stripped form, not the wtxid', () => {
    const parsed = parseTx(REAL_SEGWIT_TX);
    // Hashing the raw bytes gives the wtxid: that is precisely the old bug.
    expect(txid(REAL_SEGWIT_TX)).not.toBe(REAL_TXID);
    // Hashing the witness-free serialization gives the transaction's real id.
    expect(txid(parsed.strippedHex)).toBe(REAL_TXID);
  });

  it('parses outputs that a legacy-only parser could not reach', () => {
    const outs = parseTxOutputs(REAL_SEGWIT_TX);
    expect(outs.length).toBe(2);
    // Every output must carry a positive value and a P2WPKH script (0014 + 20B).
    for (const o of outs) {
      expect(o.nValue).toBeGreaterThan(0n);
      expect(o.scriptHex.startsWith('0014')).toBe(true);
      expect(o.scriptHex.length).toBe(44);
    }
  });

  it('leaves a LEGACY serialization byte-identical', () => {
    // Any legacy tx: its stripped form must equal the input, so Evrmore and
    // Ravencoin behaviour cannot drift from what it was before this change.
    const legacy =
      '0200000001' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '00000000' + '00' + 'ffffffff' +
      '01' + '00e1f50500000000' + '19' +
      '76a914000000000000000000000000000000000000000088ac' +
      '00000000';
    const parsed = parseTx(legacy);
    expect(parsed.isSegwit).toBe(false);
    expect(parsed.strippedHex).toBe(legacy);
    expect(txid(parsed.strippedHex)).toBe(txid(legacy));
  });

  it('fails closed on a malformed marker', () => {
    // A 0x00 that is not followed by flag 0x01 is not a valid serialization.
    const bad = REAL_SEGWIT_TX.slice(0, 10) + '02' + REAL_SEGWIT_TX.slice(12);
    expect(() => parseTx(bad)).toThrow();
  });
});
