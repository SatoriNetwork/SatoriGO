import { describe, expect, it } from 'vitest';
import { assessRecipient, type RecipientKnowledge } from './recipientRisk';

// Real-shaped fixtures: 40 hex characters after 0x, and checksum-valid base58
// on the UTXO side, so nothing here passes only because it is short.
const EVM_KNOWN = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
/** Same first four (9858) and last four (da94) AFTER the 0x, different middle:
 *  exactly what an address-poisoning vanity address is ground for. */
const EVM_SPOOF = '0x9858000000000000000000000000000000EDda94';
const EVM_UNRELATED = '0x1234567890123456789012345678901234567890';

const EVR_KNOWN = 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF';
const EVR_SPOOF = 'Ef4EzzzzzzzzzzzzzzzzzzzzzzzzzzhHCgF';
const EVR_UNRELATED = 'EXaMpLe1111111111111111111111111111';

function evm(overrides: Partial<RecipientKnowledge> = {}): RecipientKnowledge {
  return { mine: [], contacts: [], history: [], caseInsensitive: true, ...overrides };
}

function utxo(overrides: Partial<RecipientKnowledge> = {}): RecipientKnowledge {
  return { mine: [], contacts: [], history: [], caseInsensitive: false, ...overrides };
}

describe('assessRecipient — first time', () => {
  it('an address nowhere in the wallet is first-time', () => {
    expect(assessRecipient(EVM_UNRELATED, evm({ history: [EVM_KNOWN] }))).toEqual({
      firstTime: true,
      lookalikeOf: null,
    });
  });

  it('one of my own wallets suppresses the warning', () => {
    expect(assessRecipient(EVM_KNOWN, evm({ mine: [EVM_KNOWN] })).firstTime).toBe(false);
  });

  it('an address-book contact suppresses the warning', () => {
    expect(assessRecipient(EVM_KNOWN, evm({ contacts: [EVM_KNOWN] })).firstTime).toBe(false);
  });

  it('a counterparty already in history suppresses the warning', () => {
    expect(assessRecipient(EVM_KNOWN, evm({ history: [EVM_KNOWN] })).firstTime).toBe(false);
  });

  it('surrounding whitespace does not make a known address look new', () => {
    expect(assessRecipient(`  ${EVM_KNOWN} `, evm({ history: [EVM_KNOWN] })).firstTime).toBe(false);
  });
});

describe('assessRecipient — look-alike (address poisoning)', () => {
  it('flags an address sharing both ends with a history counterparty', () => {
    const risk = assessRecipient(EVM_SPOOF, evm({ history: [EVM_KNOWN] }));
    expect(risk.firstTime).toBe(true);
    // The known address is returned exactly as the caller wrote it, so the UI
    // can show it in its own short form.
    expect(risk.lookalikeOf).toBe(EVM_KNOWN);
  });

  it('flags a spoof of a contact and of one of my own wallets too', () => {
    expect(assessRecipient(EVM_SPOOF, evm({ contacts: [EVM_KNOWN] })).lookalikeOf).toBe(EVM_KNOWN);
    expect(assessRecipient(EVM_SPOOF, evm({ mine: [EVM_KNOWN] })).lookalikeOf).toBe(EVM_KNOWN);
  });

  it('needs BOTH ends: a matching head alone is not a look-alike', () => {
    const headOnly = `${EVM_KNOWN.slice(0, 6)}${'0'.repeat(30)}beef`;
    expect(assessRecipient(headOnly, evm({ history: [EVM_KNOWN] })).lookalikeOf).toBeNull();
  });

  it('needs BOTH ends: a matching tail alone is not a look-alike', () => {
    const tailOnly = `0x${'0'.repeat(36)}${EVM_KNOWN.slice(-4)}`;
    expect(assessRecipient(tailOnly, evm({ history: [EVM_KNOWN] })).lookalikeOf).toBeNull();
  });

  it('an exact match is never a look-alike of itself', () => {
    expect(assessRecipient(EVM_KNOWN, evm({ history: [EVM_KNOWN, EVM_SPOOF] }))).toEqual({
      firstTime: false,
      lookalikeOf: null,
    });
  });

  it('the same address written without its 0x is not an impersonation of itself', () => {
    expect(assessRecipient(EVM_KNOWN.slice(2), evm({ history: [EVM_KNOWN] })).lookalikeOf).toBeNull();
  });

  it('an unrelated address is not a look-alike', () => {
    expect(assessRecipient(EVM_UNRELATED, evm({ history: [EVM_KNOWN] })).lookalikeOf).toBeNull();
  });

  it('history wins over contacts when both could match (that is where the poison lands)', () => {
    const otherKnown = `0x9858${'a'.repeat(32)}da94`;
    const risk = assessRecipient(EVM_SPOOF, evm({ history: [EVM_KNOWN], contacts: [otherKnown] }));
    expect(risk.lookalikeOf).toBe(EVM_KNOWN);
  });
});

describe('assessRecipient — case rules per chain family', () => {
  it('EVM is case-insensitive: a differently-checksummed known address is still known', () => {
    const risk = assessRecipient(EVM_KNOWN.toLowerCase(), evm({ history: [EVM_KNOWN] }));
    expect(risk).toEqual({ firstTime: false, lookalikeOf: null });
  });

  it('UTXO base58 is case-SENSITIVE: a case-flipped address is a different address', () => {
    const flipped = `${EVR_KNOWN.slice(0, 4).toLowerCase()}${EVR_KNOWN.slice(4)}`;
    expect(assessRecipient(flipped, utxo({ history: [EVR_KNOWN] })).firstTime).toBe(true);
  });

  it('UTXO look-alike detection works on base58 ends', () => {
    const risk = assessRecipient(EVR_SPOOF, utxo({ history: [EVR_KNOWN] }));
    expect(risk.firstTime).toBe(true);
    expect(risk.lookalikeOf).toBe(EVR_KNOWN);
  });

  it('an unrelated base58 address is only first-time', () => {
    expect(assessRecipient(EVR_UNRELATED, utxo({ contacts: [EVR_KNOWN] }))).toEqual({
      firstTime: true,
      lookalikeOf: null,
    });
  });
});

describe('assessRecipient — empty and degenerate inputs', () => {
  it('an empty recipient warns about nothing', () => {
    expect(assessRecipient('', evm({ history: [EVM_KNOWN] }))).toEqual({
      firstTime: false,
      lookalikeOf: null,
    });
    expect(assessRecipient('   ', evm({ history: [EVM_KNOWN] })).firstTime).toBe(false);
  });

  it('an empty knowledge set makes every address first-time and nothing a look-alike', () => {
    expect(assessRecipient(EVM_UNRELATED, evm())).toEqual({ firstTime: true, lookalikeOf: null });
  });

  it('blank entries in the known lists are ignored, not matched against', () => {
    expect(assessRecipient(EVM_UNRELATED, evm({ mine: ['', '   '], history: [''] }))).toEqual({
      firstTime: true,
      lookalikeOf: null,
    });
  });

  it('a recipient too short to have two distinct ends is never a look-alike', () => {
    expect(assessRecipient('abc', utxo({ history: ['abcd1234'] })).lookalikeOf).toBeNull();
  });
});
