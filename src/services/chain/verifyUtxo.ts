// Trustless verification of input (prevout) amounts before signing.
//
// WHY THIS EXISTS — Evrmore is a Ravencoin fork with LEGACY (pre-BIP143) sighash:
// the value of a spent input is NOT committed in the signature (see
// txBuilder.legacySighash — it serializes the prevout SCRIPT but not its VALUE).
// The wallet takes input values straight from the Electrum server's
// `listunspent` reply. A malicious / compromised server (the pool includes
// third-party servers, and users can add their own) can UNDER-REPORT those
// values: coin selection then picks the real outpoints but computes a tiny
// change from the fake totals, so the real remainder is paid to the miner as an
// enormous fee — a near-total, silent balance drain that the fee-sanity ceiling
// can't catch (it's computed from the same fake values).
//
// DEFENSE — a txid is the double-SHA256 of the raw transaction, i.e. a binding
// commitment to every output value AND every output script. So for each input we
// fetch its prevout tx, recompute the txid from the bytes and require it to equal
// the outpoint's txid (proving the bytes are authentic), then check the output at
// `vout` against what the wallet claims. Any mismatch aborts the send (fail closed).
//
// TWO INPUT KINDS (Evrmore stores EVR and every asset in 1e8 base units):
//   * EVR input   — the spendable value is the output's 8-byte nValue field. We
//     require nValue === claimed valueSats AND the output's scriptPubKey to equal
//     the P2PKH script the wallet already knows (SignableUtxo.scriptPubKeyHex).
//   * ASSET input — an OP_EVR_ASSET output carries the asset amount INSIDE the
//     script, and its nValue (the 8-byte EVR field) is 0. VERIFIED LIVE against a
//     real SATORI transfer UTXO (scripts/verify-utxo-probe.ts, 2026-07-13):
//         listunspent.value = 20547945205, prevout nValue = 0,
//         amount parsed from the OP_EVR_ASSET script = 20547945205.
//     So for asset inputs we require nValue === 0 and bind the CLAIMED amount by
//     decoding the prevout's asset script and requiring its (hash160, name,
//     amount) to match what the wallet is spending. We compare PARSED FIELDS, not
//     raw bytes, because a spendable asset UTXO can be a transfer OR an
//     issuance/reissue output (marker "evrt" vs "evrq"/"evrr", plus extra
//     divisions/reissuable/IPFS bytes) — byte-equality against a reconstructed
//     TRANSFER script would false-fail a genuine reissue output exactly like the
//     bug this replaces. Field equality binds the amount for any valid asset kind.
//
// CSP-safe: pure @noble primitives; no Buffer/WebCrypto/WASM.

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { txid as computeTxid } from './txBuilder';
import { electrumGetRawTx } from './electrumClient';
import { decodeAssetScript, DEFAULT_MARKER_PREFIX, type AssetMarkerPrefix } from './assetScript';
import type { ElectrumClient } from './electrumTypes';

/** A single parsed output of a raw transaction: its 8-byte nValue and the raw
 *  scriptPubKey bytes (as lowercase hex). */
export interface TxOutput {
  /** The output's 8-byte little-endian nValue (EVR sats). For an asset output
   *  this is 0 — the asset amount is encoded inside the scriptPubKey. */
  nValue: bigint;
  /** The output's scriptPubKey, lowercase hex. */
  scriptHex: string;
}

/** A parsed raw transaction: its outputs, plus the STRIPPED (witness-free)
 *  serialization the txid is defined over. */
export interface ParsedTx {
  outputs: TxOutput[];
  /** version || inputs || outputs || locktime, with no marker/flag/witness.
   *  For a legacy tx this is byte-identical to the input. */
  strippedHex: string;
  /** True when the source carried a BIP144 marker/flag. */
  isSegwit: boolean;
}

/**
 * Parse a raw transaction, LEGACY or SEGWIT (BIP144), returning its outputs and
 * its witness-free serialization.
 *
 * WHY THE STRIPPED FORM MATTERS: a transaction's txid is the double-SHA256 of
 * the serialization WITHOUT marker, flag and witness. Hashing the bytes an
 * Electrum server returns for a segwit transaction yields the WTXID instead, so
 * an authenticity check written as `dSHA256(rawHex) === txid` rejects perfectly
 * honest servers on every segwit chain. That is what this function exists to
 * prevent: callers compare against `strippedHex`, never the raw input.
 */
export function parseTx(rawHex: string): ParsedTx {
  const b = hexToBytes(rawHex);
  let o = 0;
  const need = (n: number) => {
    if (o + n > b.length) throw new Error('malformed-tx');
  };
  const readUintLE = (n: number): bigint => {
    need(n);
    let v = 0n;
    for (let i = 0; i < n; i++) v |= BigInt(b[o + i]) << BigInt(8 * i);
    o += n;
    return v;
  };
  const readVarint = (): number => {
    need(1);
    const first = b[o++];
    if (first < 0xfd) return first;
    if (first === 0xfd) return Number(readUintLE(2));
    if (first === 0xfe) return Number(readUintLE(4));
    return Number(readUintLE(8));
  };

  const versionStart = o;
  o += 4; // version
  need(0);
  const versionBytes = b.slice(versionStart, o);

  // BIP144: a segwit serialization puts 0x00 (marker) 0x01 (flag) where a legacy
  // one starts its input count. Input count is never 0 in a real transaction, so
  // a leading 0x00 is unambiguous. Anything other than flag 0x01 is malformed.
  let isSegwit = false;
  need(1);
  if (b[o] === 0x00) {
    need(2);
    if (b[o + 1] !== 0x01) throw new Error('malformed-tx');
    isSegwit = true;
    o += 2;
  }

  const bodyStart = o; // inputs + outputs, identical in both serializations
  const vinCount = readVarint();
  for (let i = 0; i < vinCount; i++) {
    o += 36; // prevout hash (32) + index (4)
    need(0);
    const scriptLen = readVarint();
    o += scriptLen; // scriptSig
    o += 4; // sequence
    need(0);
  }

  const voutCount = readVarint();
  const outputs: TxOutput[] = [];
  for (let i = 0; i < voutCount; i++) {
    const nValue = readUintLE(8);
    const scriptLen = readVarint();
    need(scriptLen);
    const scriptHex = bytesToHex(b.slice(o, o + scriptLen));
    o += scriptLen; // scriptPubKey
    need(0);
    outputs.push({ nValue, scriptHex });
  }
  const bodyEnd = o;

  // Witness data sits between the outputs and nLockTime: one stack per input.
  if (isSegwit) {
    for (let i = 0; i < vinCount; i++) {
      const items = readVarint();
      for (let j = 0; j < items; j++) {
        const len = readVarint();
        o += len;
        need(0);
      }
    }
  }

  need(4); // nLockTime must be present
  const lockTime = b.slice(o, o + 4);
  o += 4;
  // Trailing bytes mean we misparsed; fail closed rather than trust the result.
  if (o !== b.length) throw new Error('malformed-tx');

  const strippedHex = isSegwit
    ? bytesToHex(versionBytes) + bytesToHex(b.slice(bodyStart, bodyEnd)) + bytesToHex(lockTime)
    : rawHex.toLowerCase();

  return { outputs, strippedHex, isSegwit };
}

/**
 * Parse the outputs (nValue + scriptPubKey) of a raw transaction, in order.
 * Accepts both legacy and segwit serializations.
 */
export function parseTxOutputs(rawHex: string): TxOutput[] {
  return parseTx(rawHex).outputs;
}

/**
 * Parse just the output VALUES (sats) of a raw LEGACY Evrmore tx, in order.
 * Retained for callers/tests that only need the nValues; delegates to
 * parseTxOutputs. NOTE: for an asset output nValue is 0 — see parseTxOutputs.
 */
export function parseTxOutputValues(rawHex: string): bigint[] {
  return parseTxOutputs(rawHex).map((out) => out.nValue);
}

/**
 * An input to verify. Its outpoint (txid, vout), the value the wallet is
 * spending, and the exact scriptPubKey the wallet reconstructed for signing:
 *   - EVR input:   scriptPubKeyHex is the P2PKH script; valueSats is EVR sats.
 *   - asset input: scriptPubKeyHex is the reconstructed OP_EVR_ASSET transfer
 *                  script (commits h160 + asset name + amount); valueSats is the
 *                  asset amount in 1e8 base units (nValue on-chain is 0).
 * `kind` says how to verify. Defaults to 'evr' for backwards-compatible callers.
 */
export interface VerifiableInput {
  txid: string;
  vout: number;
  valueSats: bigint;
  scriptPubKeyHex: string;
  kind?: 'evr' | 'asset';
}

/**
 * Verify every input against its authentic prevout transaction. Fetches each
 * prevout once (cached per txid), confirms the recomputed txid matches, then per
 * input kind:
 *   EVR   — output nValue === claimed valueSats AND output scriptPubKey ===
 *           the claimed P2PKH script.
 *   ASSET — output nValue === 0 AND the output decodes as an asset script whose
 *           (hash160, name, amount) match the claimed transfer script's, binding
 *           the claimed asset amount for any valid asset kind (transfer/reissue/…).
 * Throws `input-verify-failed` (fetch/parse/txid/script mismatch, unknown kind)
 * or `input-value-mismatch` (a value/amount lie) — either aborts the send BEFORE
 * signing. Fails CLOSED on everything unexpected.
 *
 * `assetMarkerPrefix` is the ACTIVE chain's marker family ('evr'|'rvn'); asset
 * prevouts are decoded ONLY as that family, so a prevout carrying a different
 * chain's marker (e.g. an "evrt" output while sending on Ravencoin) fails closed.
 * Defaults to 'evr' to keep Evrmore callers/tests unchanged.
 */
export async function verifyInputAmounts(
  client: ElectrumClient,
  inputs: VerifiableInput[],
  assetMarkerPrefix: AssetMarkerPrefix = DEFAULT_MARKER_PREFIX,
): Promise<void> {
  const cache = new Map<string, TxOutput[]>();
  for (const inp of inputs) {
    let outputs = cache.get(inp.txid);
    if (!outputs) {
      // Fail CLOSED: if the prevout can't be fetched/parsed or its bytes don't
      // hash to the claimed txid, we cannot trust the output — abort the send.
      try {
        const rawHex = await electrumGetRawTx(client, inp.txid);
        // Hash the WITNESS-FREE serialization: a txid is defined over that form,
        // so hashing the server's raw bytes for a segwit prevout would produce
        // the wtxid and reject an honest server on every segwit chain.
        const parsed = parseTx(rawHex);
        if (computeTxid(parsed.strippedHex) !== inp.txid) throw new Error('txid-mismatch');
        outputs = parsed.outputs;
      } catch {
        throw new Error('input-verify-failed');
      }
      cache.set(inp.txid, outputs);
    }
    const out = outputs[inp.vout];
    if (out === undefined) throw new Error('input-verify-failed');

    const claimedScript = inp.scriptPubKeyHex.toLowerCase();
    if (inp.kind === 'asset') {
      // Asset output: nValue must be 0 (amount lives in the script). Decode both
      // the on-chain script and the wallet's claimed transfer script, then bind
      // the amount by matching parsed fields (not raw bytes — a genuine
      // issuance/reissue prevout is a valid asset output with a different byte
      // layout than a reconstructed transfer script).
      if (out.nValue !== 0n) throw new Error('input-value-mismatch');
      const onChain = decodeAssetScript(out.scriptHex, assetMarkerPrefix);
      const claimed = decodeAssetScript(claimedScript, assetMarkerPrefix);
      // The claimed script is one we built, so it must decode; the on-chain one
      // must decode as an asset output too. Anything else: fail closed.
      if (!onChain || !claimed) throw new Error('input-verify-failed');
      if (bytesToHex(onChain.p2pkhHash160) !== bytesToHex(claimed.p2pkhHash160)) {
        throw new Error('input-verify-failed');
      }
      if (onChain.transfer.name !== claimed.transfer.name) {
        throw new Error('input-verify-failed');
      }
      // The amount is the fund-drain-relevant field: a lie here is a value lie.
      if (onChain.transfer.amount !== claimed.transfer.amount) {
        throw new Error('input-value-mismatch');
      }
      // The claimed amount must equal the value the wallet is actually spending.
      if (onChain.transfer.amount !== inp.valueSats) {
        throw new Error('input-value-mismatch');
      }
    } else {
      // EVR output: value is the nValue, and the script must be the exact P2PKH
      // script the wallet knows for this outpoint (a cheap extra binding).
      if (out.scriptHex.toLowerCase() !== claimedScript) {
        throw new Error('input-verify-failed');
      }
      if (out.nValue !== inp.valueSats) throw new Error('input-value-mismatch');
    }
  }
}
