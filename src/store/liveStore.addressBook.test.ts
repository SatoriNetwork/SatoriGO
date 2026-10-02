// The address book is CHAIN-SCOPED (the owner's rule for every recipient
// picker): a contact is valid only for the chain that is active when it is
// saved. The regressions this guards, both found by the 1.4.3 audit:
//   - a bc1q... (Bitcoin) address was saved as an "Evrmore" contact, because
//     addContact only asked "does this decode as base58check or bech32";
//   - a valid mainnet Monero address was REFUSED on a Monero wallet, because
//     that same check knows nothing about Monero.
// Also here: siblingBaseName, the name a new chain sibling is derived from.

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import { contactsForChain, headerWalletName, isValidContactAddress, siblingBaseName, useLiveStore } from './liveStore';
import type { WalletSummary } from '../services/chain/liveWallet';

const EVR = 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF';
const BTC_SEGWIT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const XMR = '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756';
const EVM = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

describe('isValidContactAddress (pure)', () => {
  it('a UTXO chain accepts only an address that decodes under ITS params', () => {
    expect(isValidContactAddress(EVR, 'mainnet')).toBe(true);
    // The audit case: a Bitcoin segwit address is not an Evrmore contact.
    expect(isValidContactAddress(BTC_SEGWIT, 'mainnet')).toBe(false);
    expect(isValidContactAddress(BTC_SEGWIT, 'bitcoin-mainnet')).toBe(true);
    expect(isValidContactAddress(EVR, 'bitcoin-mainnet')).toBe(false);
    expect(isValidContactAddress(XMR, 'mainnet')).toBe(false);
    expect(isValidContactAddress(EVM, 'mainnet')).toBe(false);
  });

  it('an EVM chain accepts a 0x address and nothing else', () => {
    expect(isValidContactAddress(EVM, 'evm:base')).toBe(true);
    expect(isValidContactAddress(EVM.toLowerCase(), 'evm:ethereum')).toBe(true);
    expect(isValidContactAddress('0x1234', 'evm:base')).toBe(false);
    expect(isValidContactAddress(EVR, 'evm:base')).toBe(false);
    expect(isValidContactAddress(XMR, 'evm:base')).toBe(false);
  });

  it('Monero goes through the engine validator, and refuses everything without one', () => {
    const validator = (a: string) => a === XMR;
    expect(isValidContactAddress(XMR, 'xmr:mainnet', validator)).toBe(true);
    expect(isValidContactAddress(EVR, 'xmr:mainnet', validator)).toBe(false);
    expect(isValidContactAddress(BTC_SEGWIT, 'xmr:mainnet', validator)).toBe(false);
    // No engine loaded (a plain build): fail closed rather than fall back to
    // the base58check check that mislabelled addresses before.
    expect(isValidContactAddress(XMR, 'xmr:mainnet', null)).toBe(false);
  });
});

describe('contactsForChain (the LIST, scoped by the same predicate as saving)', () => {
  const book = [
    { label: 'EVR friend', address: EVR },
    { label: 'BTC friend', address: BTC_SEGWIT },
    { label: 'XMR friend', address: XMR },
    { label: 'Base friend', address: EVM },
  ];

  it('an Evrmore wallet lists only its Evrmore contact (the audit\'s V09/V10 case)', () => {
    expect(contactsForChain(book, 'mainnet').map((c) => c.label)).toEqual(['EVR friend']);
  });

  it('every other chain sees its own contacts and nothing else', () => {
    expect(contactsForChain(book, 'bitcoin-mainnet').map((c) => c.label)).toEqual(['BTC friend']);
    expect(contactsForChain(book, 'evm:base').map((c) => c.label)).toEqual(['Base friend']);
    expect(contactsForChain(book, 'xmr:mainnet', (a) => a === XMR).map((c) => c.label)).toEqual(['XMR friend']);
  });

  it('filters, never deletes: the input book is untouched', () => {
    const before = book.map((c) => c.address);
    contactsForChain(book, 'mainnet');
    expect(book.map((c) => c.address)).toEqual(before);
  });
});

describe('addContact on the real store (Evrmore active by default)', () => {
  beforeEach(() => {
    setStorageForTests(new MemoryStorageAdapter());
    useLiveStore.setState({ addressBook: [] });
  });

  it('saves an Evrmore address and refuses a Bitcoin one, naming the active chain', () => {
    const { addContact } = useLiveStore.getState();
    expect(addContact('Exchange', EVR)).toEqual({ ok: true });
    expect(addContact('BTC friend', BTC_SEGWIT)).toEqual({ ok: false, error: 'Invalid Evrmore address.' });
    expect(useLiveStore.getState().addressBook.map((c) => c.address)).toEqual([EVR]);
  });
});

describe('siblingBaseName', () => {
  function w(partial: Partial<WalletSummary> & { id: string; name: string }): WalletSummary {
    return {
      network: 'mainnet',
      createdAt: 0,
      active: false,
      kind: 'seed',
      address: '',
      passwordless: false,
      family: 'utxo',
      ...partial,
    };
  }

  it('names the sibling from the seed group root, not from a renamed Monero sibling', () => {
    const source = w({ id: 'a', name: 'Wallet 1', createdAt: 1, seedGroup: 'g1' });
    const xmr = w({ id: 'b', name: 'My XMR', network: 'xmr:mainnet', family: 'monero', createdAt: 2, seedGroup: 'g1' });
    // The audit case: Bitcoin added while the renamed Monero sibling is active.
    expect(siblingBaseName([source, xmr], xmr)).toBe('Wallet 1');
    expect(siblingBaseName([source, xmr], source)).toBe('Wallet 1');
  });

  it('strips the root member\'s own chain tag', () => {
    const source = w({ id: 'a', name: 'Savings (Evrmore)', createdAt: 1, seedGroup: 'g1' });
    const xmr = w({ id: 'b', name: 'Savings (Monero)', network: 'xmr:mainnet', family: 'monero', createdAt: 5, seedGroup: 'g1' });
    expect(siblingBaseName([xmr, source], xmr)).toBe('Savings');
  });

  it('falls back to the active wallet\'s own tag-stripped name without a group', () => {
    const lone = w({ id: 'a', name: 'Cold (Bitcoin)', network: 'bitcoin-mainnet', createdAt: 1 });
    expect(siblingBaseName([lone], lone)).toBe('Cold');
    // A group id nobody else carries behaves the same.
    const solo = w({ id: 'b', name: 'Solo (Monero)', network: 'xmr:mainnet', family: 'monero', createdAt: 1, seedGroup: 'zzz' });
    expect(siblingBaseName([lone, solo], solo)).toBe('Solo');
  });

  it('an EVM seed group roots at Account 1 (the earliest account)', () => {
    const acc1 = w({ id: 'e1', name: 'Wallet 1 (EVM)', network: 'evm', family: 'evm', createdAt: 10, seedGroup: '0xabc', hdIndex: 0 });
    const acc2 = w({ id: 'e2', name: 'Trading', network: 'evm', family: 'evm', createdAt: 20, seedGroup: '0xabc', hdIndex: 1 });
    expect(siblingBaseName([acc1, acc2], acc2)).toBe('Wallet 1');
  });
});

describe('headerWalletName (the header wallet picker label)', () => {
  const w = (name: string, network: string, family: WalletSummary['family'] = 'utxo') => ({ name, network, family });

  it('drops the chain or family tag enableChain appends to a sibling', () => {
    expect(headerWalletName(w('Wallet 1 (Bittensor)', 'tao:mainnet', 'substrate'))).toBe('Wallet 1');
    expect(headerWalletName(w('Wallet 1 (EVM)', 'evm', 'evm'))).toBe('Wallet 1');
    expect(headerWalletName(w('Wallet 1 (Zcash)', 'zec:mainnet', 'zcash'))).toBe('Wallet 1');
    expect(headerWalletName(w('Wallet 1 (Monero)', 'xmr:mainnet', 'monero'))).toBe('Wallet 1');
    expect(headerWalletName(w('Wallet 1 (Bitcoin)', 'bitcoin-mainnet'))).toBe('Wallet 1');
    expect(headerWalletName(w('Wallet 1 (Ravencoin)', 'ravencoin-mainnet'))).toBe('Wallet 1');
  });

  it('leaves a name with no tag alone', () => {
    expect(headerWalletName(w('Wallet 1', 'mainnet'))).toBe('Wallet 1');
    expect(headerWalletName(w('Trading', 'evm', 'evm'))).toBe('Trading');
  });

  it("never strips a user's own parentheses, or ANOTHER chain's tag", () => {
    expect(headerWalletName(w('Savings (old)', 'mainnet'))).toBe('Savings (old)');
    expect(headerWalletName(w('Cold (2024)', 'evm', 'evm'))).toBe('Cold (2024)');
    // The tag must be the wallet's OWN chain: a Bitcoin wallet named after
    // Zcash keeps its name, as does an EVM account whose name ends "(Bitcoin)".
    expect(headerWalletName(w('Mine (Zcash)', 'bitcoin-mainnet'))).toBe('Mine (Zcash)');
    expect(headerWalletName(w('Hot (Bitcoin)', 'evm', 'evm'))).toBe('Hot (Bitcoin)');
    // Parentheses in the middle are not a suffix.
    expect(headerWalletName(w('A (EVM) wallet', 'evm', 'evm'))).toBe('A (EVM) wallet');
  });

  it('never returns an empty label', () => {
    expect(headerWalletName(w('(EVM)', 'evm', 'evm'))).toBe('(EVM)');
    expect(headerWalletName(w(' (EVM)', 'evm', 'evm'))).toBe('(EVM)');
  });
});
