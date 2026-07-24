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
import { ChainPicker, type ChainChoice } from './ChainPicker';

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
  it('renders both Evrmore and Ravencoin options, Evrmore preselected', () => {
    render(<Harness />);
    const evrOption = screen.getByTestId('test-chain-mainnet');
    const rvnOption = screen.getByTestId('test-chain-ravencoin-mainnet');
    expect(evrOption).toHaveTextContent('Evrmore');
    expect(rvnOption).toHaveTextContent('Ravencoin');
    expect(evrOption.getAttribute('aria-pressed')).toBe('true');
    expect(rvnOption.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows no privacy note while Evrmore is selected', () => {
    render(<Harness />);
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
