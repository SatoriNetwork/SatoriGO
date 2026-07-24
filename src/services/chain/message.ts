// Evrmore "signed message" support — the exact format `evrmore-cli signmessage`
// and python-evrmorelib's `SignMessage`/`VerifyMessage` use, so a signature we
// produce here VERIFIES on Satori's backend (which signs/verifies via
// python-evrmorelib). This is what lets `window.evrmore.signMessage(...)` be used
// as a login / proof-of-address challenge on Satori and other EVRmore sites.
//
// Format (identical to Bitcoin's message signing, only the magic differs):
//   preimage = varstr(MAGIC) || varstr(message)             (varstr = CompactSize len || bytes)
//   digest   = sha256(sha256(preimage))                     (double-SHA256)
//   sig      = [ header(1) || r(32) || s(32) ]              (compact, RECOVERABLE, low-S)
//   header   = 27 + recId + (compressed ? 4 : 0)            (31..34 for our compressed keys)
//   result   = base64(sig)
//
// The magic string is verified against Evrmore Core (src/validation.cpp:
// `strMessageMagic = "Evrmore Signed Message:\n"`) and python-evrmorelib
// (EvrmoreMessage default magic). Do NOT change it — the byte-exact magic is what
// makes the signature interoperable.
//
// CSP-safe: pure-JS @noble/@scure primitives only (no Buffer, WebCrypto, WASM).

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '@noble/hashes/utils';
import { hmac } from '@noble/hashes/hmac';
import { base64 } from '@scure/base';
import * as secp256k1 from '@noble/secp256k1';
import { pubkeyToAddress } from './keys';
import type { EvrmoreNetwork } from './chainParams';

// @noble/secp256k1 v2's synchronous `sign` needs a synchronous HMAC-SHA256 for
// RFC6979. Wire the same pure-JS hook txBuilder uses so this module is
// self-contained (idempotent — assigning the same shape twice is harmless).
secp256k1.etc.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]): Uint8Array =>
  hmac(sha256, key, concatBytes(...msgs));

/** Evrmore's message magic — byte-exact match to Evrmore Core / python-evrmorelib. */
export const EVRMORE_MESSAGE_MAGIC = 'Evrmore Signed Message:\n';

/** Ravencoin's message magic — byte-exact match to RavenProject/Ravencoin
 *  src/validation.cpp:129 (`strMessageMagic = "Raven Signed Message:\n"`). */
export const RAVEN_MESSAGE_MAGIC = 'Raven Signed Message:\n';

const utf8 = new TextEncoder();

/** Bitcoin CompactSize (varint) encoding of a non-negative length. Message and
 *  magic lengths are small, but encode correctly up to uint32 to be safe. */
function compactSize(n: number): Uint8Array {
  if (n < 0 || !Number.isInteger(n)) throw new Error('compactSize: bad length');
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff);
  if (n <= 0xffffffff) {
    return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  }
  throw new Error('compactSize: length too large');
}

/** varstr = CompactSize(len) || bytes. */
function varstr(bytes: Uint8Array): Uint8Array {
  return concatBytes(compactSize(bytes.length), bytes);
}

/**
 * The 32-byte double-SHA256 digest that gets signed:
 *   sha256(sha256( varstr(magic) || varstr(message) )).
 * `magic` defaults to the Evrmore magic so every existing caller (Satori login on
 * EVR) is byte-for-byte unchanged; pass a chain's magic for other chains.
 */
export function messageHash(message: string, magic: string = EVRMORE_MESSAGE_MAGIC): Uint8Array {
  const preimage = concatBytes(varstr(utf8.encode(magic)), varstr(utf8.encode(message)));
  return sha256(sha256(preimage));
}

/**
 * Sign `message` with a raw private key, returning the base64 compact recoverable
 * signature (65 bytes: header || r || s). `compressed` MUST match how the address
 * was derived (all our wallets use compressed keys) or verification recovers a
 * different address. RFC6979-deterministic, canonical low-S.
 */
export function signMessageWithKey(
  privateKey: Uint8Array,
  message: string,
  compressed = true,
  magic: string = EVRMORE_MESSAGE_MAGIC,
): string {
  const sig = secp256k1.sign(messageHash(message, magic), privateKey, { lowS: true });
  const header = 27 + sig.recovery + (compressed ? 4 : 0);
  const out = new Uint8Array(65);
  out[0] = header;
  out.set(sig.toCompactRawBytes(), 1);
  return base64.encode(out);
}

/**
 * Verify a base64 compact-recoverable signature against an address on `net`:
 * recover the public key from (digest, sig), encode its P2PKH address and compare.
 * Never throws — returns false on any malformed input. Used to self-check every
 * signature we produce (recover === signer) and available for on-page verify.
 */
export function verifyMessage(
  address: string,
  message: string,
  signatureB64: string,
  net: EvrmoreNetwork,
): boolean {
  try {
    const bytes = base64.decode(signatureB64.trim());
    if (bytes.length !== 65) return false;
    const header = bytes[0];
    // 27..30 uncompressed, 31..34 compressed (27 + recId[0..3] + 4·compressed).
    if (header < 27 || header > 34) return false;
    const recId = (header - 27) & 3;
    const compressed = ((header - 27) & 4) !== 0;
    const recovered = secp256k1.Signature.fromCompact(bytes.slice(1))
      .addRecoveryBit(recId)
      .recoverPublicKey(messageHash(message, net.messageMagic));
    return pubkeyToAddress(recovered.toRawBytes(compressed), net) === address;
  } catch {
    return false;
  }
}
