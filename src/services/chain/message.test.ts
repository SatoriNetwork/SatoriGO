import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import {
  EVRMORE_MESSAGE_MAGIC,
  messageHash,
  signMessageWithKey,
  verifyMessage,
} from './message';
import { privateKeyToDerived } from './keys';
import { EVRMORE_MAINNET } from './chainParams';

// Fixed key + message so the signature is a stable known-answer vector.
const PRIV = new Uint8Array(32).fill(0x42);
const MSG = 'Login to Satori: challenge-12345';
const derived = privateKeyToDerived(PRIV, EVRMORE_MAINNET, true);

// KAT computed by an INDEPENDENT from-scratch reimplementation (not message.ts).
// If message.ts's magic/framing/header ever drifts, this breaks — which is the
// point: it locks the byte-exact, Satori-interoperable format.
const KAT_SIG = 'IAK4Yn9ZzIxqjsEcYR0QQqdHKEd4ppRliPpw+q1RqaQNVO51GbchvDyFMjBfGMqC6Gp4Cv+1ogRXjWL+UVLH22o=';

describe('Evrmore signed messages', () => {
  it('uses the byte-exact Evrmore magic', () => {
    expect(EVRMORE_MESSAGE_MAGIC).toBe('Evrmore Signed Message:\n');
    expect(new TextEncoder().encode(EVRMORE_MESSAGE_MAGIC).length).toBe(24); // 0x18 prefix
  });

  it('messageHash is a deterministic 32-byte double-sha256', () => {
    const h = messageHash(MSG);
    expect(h).toHaveLength(32);
    expect(messageHash(MSG)).toEqual(h);
    expect(messageHash(MSG + '!')).not.toEqual(h); // different message => different hash
  });

  it('matches the independent known-answer signature (Satori-interoperable format)', () => {
    expect(signMessageWithKey(PRIV, MSG, true)).toBe(KAT_SIG);
  });

  it('is RFC6979-deterministic (same key+message => identical signature)', () => {
    expect(signMessageWithKey(PRIV, MSG)).toBe(signMessageWithKey(PRIV, MSG));
  });

  it('produces a 65-byte compact sig with a compressed header (31..34)', () => {
    const bytes = base64.decode(signMessageWithKey(PRIV, MSG, true));
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBeGreaterThanOrEqual(31);
    expect(bytes[0]).toBeLessThanOrEqual(34);
  });

  it('verifies a signature back to the signing address', () => {
    const sig = signMessageWithKey(PRIV, MSG, true);
    expect(verifyMessage(derived.address, MSG, sig, EVRMORE_MAINNET)).toBe(true);
  });

  it('rejects a tampered message', () => {
    const sig = signMessageWithKey(PRIV, MSG, true);
    expect(verifyMessage(derived.address, MSG + ' extra', sig, EVRMORE_MAINNET)).toBe(false);
  });

  it('rejects verification against a different address', () => {
    const sig = signMessageWithKey(PRIV, MSG, true);
    const other = privateKeyToDerived(new Uint8Array(32).fill(0x43), EVRMORE_MAINNET, true);
    expect(verifyMessage(other.address, MSG, sig, EVRMORE_MAINNET)).toBe(false);
  });

  it('never throws on malformed signature input', () => {
    expect(verifyMessage(derived.address, MSG, 'not-base64-@@@', EVRMORE_MAINNET)).toBe(false);
    expect(verifyMessage(derived.address, MSG, base64.encode(new Uint8Array(10)), EVRMORE_MAINNET)).toBe(false);
  });

  it('round-trips an empty and a unicode message', () => {
    for (const m of ['', 'Zażółć gęślą jaźń — 🔐']) {
      const sig = signMessageWithKey(PRIV, m, true);
      expect(verifyMessage(derived.address, m, sig, EVRMORE_MAINNET)).toBe(true);
    }
  });
});
