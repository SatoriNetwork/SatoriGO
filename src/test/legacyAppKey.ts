// A v1 app-key record, built the way the SHIPPED 1.4.0 build built it.
//
// It exists so the "v1 records are read forever" promise
// (the app-password design notes §13.3) has a test that can actually fail. Once
// createAppKeyRecord() started writing v2 records, nothing in the codebase
// could produce the shape every existing install already has on disk, and a
// compatibility guarantee with no way to construct the old artefact is a
// guarantee nobody is checking.
//
// DELIBERATELY DOES NOT CALL appKey.ts. It re-implements the old derivation
// from scrypt and WebCrypto directly, so a change to appKey.ts cannot quietly
// redefine what "a v1 record" means and keep the tests green. This is the same
// reason a golden vector is a literal and not a call to the function it tests.

import { scryptAsync } from '@noble/hashes/scrypt';
import { bytesToBase64 } from '../services/chain/base64';
import type { AppKeyRecordV1 } from '../services/chain/appKey';

/** The constant v1 sealed under the master key as its wrong-password detector.
 *  A literal here on purpose: if appKey.ts ever changed it, a v1 record on a
 *  real user's disk would still hold THIS string. */
const APP_KEY_CHECK_V1 = 'satori-go/app-key/v1';

const V1_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;

function randomBytes(len: number): Uint8Array {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return b;
}

/**
 * A v1 record for `password`, plus the master key it derives.
 *
 * Under v1 the master key IS scrypt(password, salt) — the whole thing §13.3
 * moved away from. Wallet vaults created against this record are wrapped under
 * that key, exactly as they are on an install that has never made a recovery
 * code.
 */
export async function makeLegacyV1AppKey(
  password: string,
): Promise<{ record: AppKeyRecordV1; masterKey: Uint8Array }> {
  const { N, r, p } = V1_KDF;
  const salt = randomBytes(16);
  const masterKey = await scryptAsync(new TextEncoder().encode(password), salt, {
    N,
    r,
    p,
    dkLen: 32,
  });
  const key = await crypto.subtle.importKey('raw', masterKey, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(APP_KEY_CHECK_V1),
  );
  return {
    record: {
      version: 1,
      kdf: 'scrypt',
      N,
      r,
      p,
      salt: bytesToBase64(salt),
      check: { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ct)) },
    },
    masterKey,
  };
}
