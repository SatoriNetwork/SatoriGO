/**
 * @vitest-environment jsdom
 *
 * The address book LIST is chain-scoped, like saving already was (the owner's
 * rule for every recipient picker). The 1.4.3 audit's V09/V10: an Evrmore
 * wallet listed the Monero and Bitcoin contacts it could never send to. The
 * list must show only the contacts valid on the active chain, and the others
 * must stay in the book (a filter, never a delete).
 *
 * Real store (no wallet: Evrmore mainnet is the default chain), storage in
 * memory, no network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import { NavProvider } from './LiveNav';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const EVR = 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF';
const BTC_SEGWIT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const XMR = '43SMrTtLZsyZL81653f6b3BWpU5u6XZ2SRdAaM1MxLCGDcTq6mKi9D11ZgN2hbmCdS9j66xu8Wz3J9wgiwkYssLnEK44756';
const BOOK = [
  { label: 'EVR friend', address: EVR },
  { label: 'BTC friend', address: BTC_SEGWIT },
  { label: 'XMR friend', address: XMR },
];

let storeMod: typeof import('../../store/liveStore');
let bookMod: typeof import('./LiveAddressBook');
const NAV_VALUE = { tab: 'assets' as const, section: 'settings' as const, openTab: () => {}, openSettings: () => {} };

function renderBook() {
  const LiveAddressBook = bookMod.LiveAddressBook;
  return render(
    <NavProvider value={NAV_VALUE}>
      <LiveAddressBook onBack={() => {}} />
    </NavProvider>,
  );
}

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  bookMod = await import('./LiveAddressBook');
});

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  storeMod.useLiveStore.setState({ addressBook: BOOK.map((c) => ({ ...c })) });
});

afterEach(cleanup);

describe('LiveAddressBook list (Evrmore active)', () => {
  it('lists only the Evrmore contact; the Bitcoin and Monero ones are not shown', () => {
    renderBook();
    expect(screen.getByTestId(`live-contact-${EVR.slice(0, 8)}`)).toBeTruthy();
    expect(screen.queryByTestId(`live-contact-${BTC_SEGWIT.slice(0, 8)}`)).toBeNull();
    expect(screen.queryByTestId(`live-contact-${XMR.slice(0, 8)}`)).toBeNull();
    expect(screen.getByTestId('live-address-book').textContent).not.toContain('XMR friend');
    expect(screen.getByTestId('live-address-book').textContent).not.toContain('BTC friend');
  });

  it('does not delete the other chains\' contacts: the book still holds all three', () => {
    renderBook();
    expect(storeMod.useLiveStore.getState().addressBook.map((c) => c.label)).toEqual(['EVR friend', 'BTC friend', 'XMR friend']);
    // Removing the visible one touches only that one.
    fireEvent.click(screen.getByTestId(`live-contact-remove-${EVR.slice(0, 8)}`));
    expect(storeMod.useLiveStore.getState().addressBook.map((c) => c.label)).toEqual(['BTC friend', 'XMR friend']);
  });

  it('says why the list is empty when every contact belongs to another chain', () => {
    storeMod.useLiveStore.setState({ addressBook: BOOK.filter((c) => c.address !== EVR) });
    renderBook();
    const screenText = screen.getByTestId('live-address-book').textContent ?? '';
    expect(screenText).toContain('No Evrmore contacts yet');
    expect(screenText).toContain('other chains');
    expect(screenText).not.toContain('—');
  });

  it('with an empty book, keeps the plain "No contacts yet" state', () => {
    storeMod.useLiveStore.setState({ addressBook: [] });
    renderBook();
    expect(screen.getByTestId('live-address-book').textContent).toContain('No contacts yet');
  });
});
