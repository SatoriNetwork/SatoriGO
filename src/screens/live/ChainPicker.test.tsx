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
import { ChainPicker, CHAIN_OPTIONS, type ChainChoice } from './ChainPicker';

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
}: {
  initial?: ChainChoice;
  secretKind?: 'phrase' | 'key';
}) {
  const [value, setValue] = useState<ChainChoice>(initial);
  return <ChainPicker value={value} onChange={setValue} testIdPrefix="test-chain" secretKind={secretKind} />;
}

describe('ChainPicker', () => {
  it('renders all seven chain options, Evrmore preselected', () => {
    render(<Harness />);
    const evrOption = screen.getByTestId('test-chain-mainnet');
    const rvnOption = screen.getByTestId('test-chain-ravencoin-mainnet');
    const btgsOption = screen.getByTestId('test-chain-bitcoingold-mainnet');
    const ltcOption = screen.getByTestId('test-chain-litecoin-mainnet');
    const wjkOption = screen.getByTestId('test-chain-wojakcoin-mainnet');
    const btcOption = screen.getByTestId('test-chain-bitcoin-mainnet');
    const dogeOption = screen.getByTestId('test-chain-dogecoin-mainnet');
    expect(evrOption).toHaveTextContent('Evrmore');
    expect(rvnOption).toHaveTextContent('Ravencoin');
    expect(btgsOption).toHaveTextContent('Bitcoin Gold S');
    expect(ltcOption).toHaveTextContent('Litecoin');
    expect(wjkOption).toHaveTextContent('WojakCoin');
    expect(btcOption).toHaveTextContent('Bitcoin');
    expect(dogeOption).toHaveTextContent('Dogecoin');
    expect(evrOption.getAttribute('aria-pressed')).toBe('true');
    expect(rvnOption.getAttribute('aria-pressed')).toBe('false');
    expect(btgsOption.getAttribute('aria-pressed')).toBe('false');
    expect(ltcOption.getAttribute('aria-pressed')).toBe('false');
    expect(wjkOption.getAttribute('aria-pressed')).toBe('false');
    expect(btcOption.getAttribute('aria-pressed')).toBe('false');
    expect(dogeOption.getAttribute('aria-pressed')).toBe('false');
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
    expect(screen.getAllByTestId(/^test-chain-/).length).toBe(7);
  });
});
