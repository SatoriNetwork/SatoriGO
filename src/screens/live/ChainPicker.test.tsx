// @vitest-environment jsdom
// Needs `document` for React Testing Library render, so this file opts into
// jsdom on its own (the project's default vitest environment is 'node').
//
// ChainPicker is deliberately store-free (see its header comment), so this test
// exercises it as a plain controlled component: no zustand/service mocking
// needed, unlike a full LiveOnboarding render.
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChainPicker, CHAIN_OPTIONS, chainOptionsFor, type ChainChoice } from './ChainPicker';
import type { EvmChainInfo } from '../../store/evmChains';
import { NEOXA_MAINNET, chainsShareDerivation, networkFor } from '../../services/chain/chainParams';

/** Minimal EVM chain fixtures, shaped like the store's plain-data mirror
 *  (EvmChainInfo). Only the fields ChainPicker actually reads matter here. */
const EVM_CHAINS: EvmChainInfo[] = [
  {
    key: 'base',
    chainId: 8453,
    displayName: 'Base',
    nativeTicker: 'ETH',
    nativeDecimals: 18,
    explorerTxUrl: 'https://basescan.org/tx/{txid}',
    homepage: 'https://example.test',
    young: false,
    recentlyAdded: false,
    feeModel: 'eip1559',
    l1DataFee: true,
    indexer: null,
    alchemy: false,
    trustWalletChain: null,
    tokenListSlug: null,
    defaultTokens: [],
  },
  {
    key: 'bsc',
    chainId: 56,
    displayName: 'BNB Smart Chain',
    nativeTicker: 'BNB',
    nativeDecimals: 18,
    explorerTxUrl: 'https://bscscan.com/tx/{txid}',
    homepage: 'https://example.test',
    young: false,
    recentlyAdded: false,
    feeModel: 'legacy',
    l1DataFee: false,
    indexer: null,
    alchemy: false,
    trustWalletChain: null,
    tokenListSlug: null,
    defaultTokens: [],
  },
];

// This project's vitest setup does not auto-run Testing Library's cleanup, and
// several `it`s below render the same testids — without this, later tests would
// see duplicate nodes left over from earlier ones (getByTestId then throws
// "multiple elements found").
afterEach(cleanup);

/** Minimal controlled-component harness: ChainPicker takes value/onChange, so a
 *  real click needs somewhere to store the selection between renders. */
function Harness({
  initial = 'mainnet',
  secretKind = 'phrase',
  evmChains,
}: {
  initial?: ChainChoice;
  secretKind?: 'phrase' | 'key';
  evmChains?: readonly EvmChainInfo[];
}) {
  const [value, setValue] = useState<ChainChoice>(initial);
  return (
    <ChainPicker
      value={value}
      onChange={setValue}
      testIdPrefix="test-chain"
      secretKind={secretKind}
      evmChains={evmChains}
    />
  );
}

describe('ChainPicker', () => {
  it('renders all eight chain options, Evrmore preselected', () => {
    render(<Harness />);
    const evrOption = screen.getByTestId('test-chain-mainnet');
    const rvnOption = screen.getByTestId('test-chain-ravencoin-mainnet');
    const btgsOption = screen.getByTestId('test-chain-bitcoingold-mainnet');
    const ltcOption = screen.getByTestId('test-chain-litecoin-mainnet');
    const wjkOption = screen.getByTestId('test-chain-wojakcoin-mainnet');
    const btcOption = screen.getByTestId('test-chain-bitcoin-mainnet');
    const dogeOption = screen.getByTestId('test-chain-dogecoin-mainnet');
    const neoxOption = screen.getByTestId('test-chain-neoxa-mainnet');
    expect(evrOption).toHaveTextContent('Evrmore');
    expect(rvnOption).toHaveTextContent('Ravencoin');
    expect(btgsOption).toHaveTextContent('BitcoinGold');
    expect(ltcOption).toHaveTextContent('Litecoin');
    expect(wjkOption).toHaveTextContent('WojakCoin');
    expect(btcOption).toHaveTextContent('Bitcoin');
    expect(dogeOption).toHaveTextContent('Dogecoin');
    expect(neoxOption).toHaveTextContent('Neoxa');
    expect(evrOption.getAttribute('aria-pressed')).toBe('true');
    expect(rvnOption.getAttribute('aria-pressed')).toBe('false');
    expect(btgsOption.getAttribute('aria-pressed')).toBe('false');
    expect(ltcOption.getAttribute('aria-pressed')).toBe('false');
    expect(wjkOption.getAttribute('aria-pressed')).toBe('false');
    expect(btcOption.getAttribute('aria-pressed')).toBe('false');
    expect(dogeOption.getAttribute('aria-pressed')).toBe('false');
    expect(neoxOption.getAttribute('aria-pressed')).toBe('false');
  });

  it('offers Neoxa, and carries NO privacy note despite being a Ravencoin fork', () => {
    // Neoxa is offered like any other chain. The interesting assertion is the
    // second one: Ravencoin surfaces a shared-derivation warning, and Neoxa is a
    // RAVENCOIN FORK that carries Ravencoin's asset protocol and P2SH prefix, so
    // "it must warn too" is the natural wrong guess. Its coin type is its own
    // (1668 vs 175), so one phrase derives unrelated keys on the two chains and
    // the note would be false. The note is driven by chainsShareDerivation(),
    // which reads the params, so this is asserted rather than assumed.
    render(<Harness />);
    const neoxOption = screen.getByTestId('test-chain-neoxa-mainnet');
    expect(neoxOption).toHaveTextContent('Neoxa');
    expect(neoxOption.getAttribute('aria-pressed')).toBe('false');
    expect(NEOXA_MAINNET.chainId).toBe('neoxa-mainnet');
    expect(networkFor('neoxa-mainnet')).toBe(NEOXA_MAINNET);
    expect(chainsShareDerivation('neoxa-mainnet', 'ravencoin-mainnet')).toBe(false);
    fireEvent.click(neoxOption);
    expect(screen.queryByTestId('test-chain-privacy-note')).toBeNull();
  });

  it('keeps the OWNER-SPECIFIED display order (the header switcher reads this same array)', () => {
    // Pinned as data, not DOM, so a "helpful" alphabetical sort of
    // CHAIN_OPTIONS fails here even if every option still renders.
    expect(CHAIN_OPTIONS.map((o) => o.value)).toEqual([
      'bitcoin-mainnet',
      'litecoin-mainnet',
      'dogecoin-mainnet',
      'mainnet',
      'ravencoin-mainnet',
      'bitcoingold-mainnet',
      'wojakcoin-mainnet',
      'neoxa-mainnet',
    ]);
  });

  it('shows no privacy note while Evrmore is selected', () => {
    render(<Harness />);
    expect(screen.queryByTestId('test-chain-privacy-note')).toBeNull();
  });

  it('shows no privacy note for Bitcoin Gold (it shares no key derivation with the other chains)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('test-chain-bitcoingold-mainnet'));
    expect(screen.getByTestId('test-chain-bitcoingold-mainnet').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('test-chain-privacy-note')).toBeNull();
  });

  it('shows no privacy note for Litecoin (it shares no key derivation with the other chains)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('test-chain-litecoin-mainnet'));
    expect(screen.getByTestId('test-chain-litecoin-mainnet').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('test-chain-privacy-note')).toBeNull();
  });

  it('shows no privacy note for WojakCoin (it shares no key derivation with the other chains)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('test-chain-wojakcoin-mainnet'));
    expect(screen.getByTestId('test-chain-wojakcoin-mainnet').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('test-chain-privacy-note')).toBeNull();
  });

  it('shows no privacy note for Bitcoin (it shares no key derivation with the other chains)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('test-chain-bitcoin-mainnet'));
    expect(screen.getByTestId('test-chain-bitcoin-mainnet').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('test-chain-privacy-note')).toBeNull();
  });

  it('shows no privacy note for Dogecoin (it shares no key derivation with the other chains)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('test-chain-dogecoin-mainnet'));
    expect(screen.getByTestId('test-chain-dogecoin-mainnet').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('test-chain-privacy-note')).toBeNull();
  });

  it('shows the shared-key-derivation privacy note once Ravencoin is picked', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('test-chain-ravencoin-mainnet'));

    const note = screen.getByTestId('test-chain-privacy-note');
    expect(note.textContent).toMatch(/share the same key derivation/i);
    expect(note.textContent).toMatch(/recovery phrase/i);
    expect(screen.getByTestId('test-chain-ravencoin-mainnet').getAttribute('aria-pressed')).toBe('true');
  });

  it('adapts the privacy-note wording for a private-key import (no recovery phrase)', () => {
    render(<Harness secretKind="key" />);
    fireEvent.click(screen.getByTestId('test-chain-ravencoin-mainnet'));

    const note = screen.getByTestId('test-chain-privacy-note');
    expect(note.textContent).toMatch(/private key already has a matching address/i);
    expect(note.textContent).not.toMatch(/recovery phrase/i);
  });

  it('never uses an em-dash in its copy (house style)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('test-chain-ravencoin-mainnet'));
    const note = screen.getByTestId('test-chain-privacy-note');
    expect(note.textContent).not.toContain('—');
  });
});

describe('hidden networks', () => {
  it('does not offer a hidden chain when creating a wallet', () => {
    render(
      <ChainPicker
        hidden={['dogecoin-mainnet', 'wojakcoin-mainnet']}
        value="mainnet"
        onChange={() => {}}
        testIdPrefix="test-chain"
        secretKind="phrase"
      />,
    );
    expect(screen.queryByTestId('test-chain-dogecoin-mainnet')).toBeNull();
    expect(screen.queryByTestId('test-chain-wojakcoin-mainnet')).toBeNull();
    expect(screen.getByTestId('test-chain-bitcoin-mainnet')).toBeTruthy();
  });

  it('keeps the SELECTED chain listed even if it is hidden', () => {
    // Otherwise the form would render a picker with nothing selected, and the
    // user could not see what their wallet is about to be created on.
    render(
      <ChainPicker
        hidden={['litecoin-mainnet']}
        value="litecoin-mainnet"
        onChange={() => {}}
        testIdPrefix="test-chain"
        secretKind="phrase"
      />,
    );
    expect(screen.getByTestId('test-chain-litecoin-mainnet')).toBeTruthy();
  });

  it('offers every chain when nothing is hidden', () => {
    render(
      <ChainPicker value="mainnet" onChange={() => {}} testIdPrefix="test-chain" secretKind="phrase" />,
    );
    expect(screen.getAllByTestId(/^test-chain-/).length).toBe(8);
  });
});

describe('EVM chains', () => {
  it('chainOptionsFor appends one row per EVM chain, after the UTXO rows, only when the list is non-empty', () => {
    expect(chainOptionsFor().map((o) => o.value)).toEqual(CHAIN_OPTIONS.map((o) => o.value));
    expect(chainOptionsFor([]).map((o) => o.value)).toEqual(CHAIN_OPTIONS.map((o) => o.value));
    const withEvm = chainOptionsFor(EVM_CHAINS);
    expect(withEvm.map((o) => o.value)).toEqual([...CHAIN_OPTIONS.map((o) => o.value), 'evm:base', 'evm:bsc']);
    expect(withEvm.find((o) => o.value === 'evm:base')?.label).toBe('Base');
  });

  it('renders no EVM rows and no EVM note when evmChains is empty or omitted (a build without the EVM engine)', () => {
    render(<Harness />);
    expect(screen.queryByTestId('test-chain-evm:base')).toBeNull();
    expect(screen.queryByTestId('test-chain-evm-note')).toBeNull();
    cleanup();

    render(<Harness evmChains={[]} />);
    expect(screen.queryByTestId('test-chain-evm:base')).toBeNull();
    expect(screen.getAllByTestId(/^test-chain-/).length).toBe(8);
  });

  it('offers a row per EVM chain when evmChains is non-empty, and selecting one emits its evm:<key> target', () => {
    render(<Harness evmChains={EVM_CHAINS} />);
    const base = screen.getByTestId('test-chain-evm:base');
    const bsc = screen.getByTestId('test-chain-evm:bsc');
    expect(base).toHaveTextContent('Base');
    expect(bsc).toHaveTextContent('BNB Smart Chain');

    fireEvent.click(base);
    expect(screen.getByTestId('test-chain-evm:base').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the one-EVM-account note only once an EVM row is selected', () => {
    render(<Harness evmChains={EVM_CHAINS} />);
    expect(screen.queryByTestId('test-chain-evm-note')).toBeNull();

    fireEvent.click(screen.getByTestId('test-chain-evm:base'));
    const note = screen.getByTestId('test-chain-evm-note');
    expect(note.textContent).toMatch(/one evm account works on every evm chain/i);
    expect(note.textContent).not.toContain('—');

    // Switching back to a UTXO chain drops the note.
    fireEvent.click(screen.getByTestId('test-chain-mainnet'));
    expect(screen.queryByTestId('test-chain-evm-note')).toBeNull();
  });

  it('never filters an EVM row out of the hidden list (hidden is UTXO-only)', () => {
    render(
      <ChainPicker
        hidden={['bitcoin-mainnet', 'litecoin-mainnet']}
        evmChains={EVM_CHAINS}
        value="evm:base"
        onChange={() => {}}
        testIdPrefix="test-chain"
        secretKind="phrase"
      />,
    );
    expect(screen.queryByTestId('test-chain-bitcoin-mainnet')).toBeNull();
    expect(screen.getByTestId('test-chain-evm:base')).toBeTruthy();
    expect(screen.getByTestId('test-chain-evm:bsc')).toBeTruthy();
  });
});
