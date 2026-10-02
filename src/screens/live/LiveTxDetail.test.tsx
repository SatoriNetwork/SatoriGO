/**
 * @vitest-environment jsdom
 *
 * LiveTxDetail against a mocked store. Two things the 1.4.3 audit found on a
 * Monero row: the amount was rounded to 8 decimals for a 12-decimal coin, and
 * the counterparty placeholder was cut to "Monero (pr…rivate)" next to a Copy
 * button that copied the placeholder. The decimals now come from the chain
 * and a hidden counterparty is worded, not copied.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { LiveTransaction } from '../../services/chain/electrumProvider';

const hoisted = vi.hoisted(() => ({
  family: 'monero' as 'monero' | 'utxo' | 'evm' | 'zcash' | 'substrate',
  evmChain: null as null | { key: string; explorerTxUrl: string; nativeTicker: string; nativeDecimals: number },
  ticker: 'XMR',
  decimals: 12,
  state: {
    txs: [] as LiveTransaction[],
    explorerUrlTemplate: '',
    evm: { chains: [] as unknown[] },
    evmStaking: { snapshot: null },
  },
}));

vi.mock('../../store/liveStore', () => {
  const useLiveStore = (selector: (s: typeof hoisted.state) => unknown) => selector(hoisted.state);
  useLiveStore.getState = () => hoisted.state;
  return {
    useLiveStore,
    nativeTickerFor: () => hoisted.ticker,
    nativeDecimalsFor: () => hoisted.decimals,
    isNativeAssetId: (asset: string) => asset.toUpperCase() === hoisted.ticker,
    activeFamily: () => hoisted.family,
    activeEvmChain: () => hoisted.evmChain,
  };
});

import { LiveTxDetail, MONERO_COUNTERPARTY_NOTE, resolveExplorerUrl } from './LiveTxDetail';
import { MONERO_EXPLORER_TX_URL } from '../../store/moneroChains';
import { ZCASH_EXPLORER_TX_URL } from '../../store/zcashChain';
import { TAO_EXPLORER_TX_URL } from '../../store/taoChain';
import { NavProvider, type NavContextValue } from './LiveNav';

const NAV: NavContextValue = { tab: 'activity', section: 'home', openTab: vi.fn(), openSettings: vi.fn() };

function tx(over: Partial<LiveTransaction>): LiveTransaction {
  return {
    txid: 'abc123',
    asset: 'XMR',
    direction: 'in',
    amount: 1,
    feeEvr: 0,
    status: 'confirmed',
    timestamp: 1_700_000_000_000,
    counterparty: '',
    ...over,
  };
}

function renderDetail(txid = 'abc123') {
  return render(
    <NavProvider value={NAV}>
      <LiveTxDetail txid={txid} onBack={vi.fn()} />
    </NavProvider>,
  );
}

describe('LiveTxDetail', () => {
  afterEach(() => {
    cleanup();
    hoisted.family = 'monero';
    hoisted.ticker = 'XMR';
    hoisted.decimals = 12;
    hoisted.evmChain = null;
    hoisted.state.explorerUrlTemplate = '';
  });

  it('shows a Monero amount at the chain\'s 12 decimals, not a fixed 8', () => {
    hoisted.state.txs = [tx({ amount: 0.123456789012 })];
    renderDetail();
    expect(screen.getByTestId('live-tx-amount').textContent).toBe('+0.123456789012 XMR');
  });

  it('words a hidden Monero counterparty in full and offers nothing to copy', () => {
    hoisted.state.txs = [tx({ direction: 'out', amount: 0.5, feeEvr: 0.000004 })];
    renderDetail();
    const note = screen.getByTestId('live-tx-counterparty-private');
    expect(note.textContent).toBe(MONERO_COUNTERPARTY_NOTE);
    expect(note.textContent).not.toContain('…');
    expect(screen.queryByLabelText('Copy address')).toBeNull();
    // The txid itself is still copyable.
    expect(screen.getByTestId('live-tx-copy-txid')).toBeTruthy();
    expect(screen.getByText('0.000004 XMR')).toBeTruthy();
  });

  it('a UTXO row keeps its copyable counterparty and 8 decimals', () => {
    hoisted.family = 'utxo';
    hoisted.ticker = 'EVR';
    hoisted.decimals = 8;
    hoisted.state.txs = [tx({ asset: 'EVR', amount: 0.123456789012, counterparty: 'Ef4EiYqL2C8LN6Y8AcV1shGFv6MV8hHCgF' })];
    renderDetail();
    expect(screen.getByTestId('live-tx-amount').textContent).toBe('+0.12345679 EVR');
    expect(screen.getByLabelText('Copy address')).toBeTruthy();
    expect(screen.queryByTestId('live-tx-counterparty-private')).toBeNull();
  });

  describe('View on explorer (every chain family)', () => {
    const HASH = '8d393b5a304d2ba25b9a50aaf817a784b992025fa7aec173943e268120790356';

    function explorerLink(): HTMLAnchorElement {
      const a = screen.getByTestId('live-tx-explorer') as HTMLAnchorElement;
      expect(a.tagName).toBe('A');
      expect(a.className).toBe('link');
      expect(a.target).toBe('_blank');
      expect(a.rel).toContain('noopener');
      expect(a.textContent).toBe('View on explorer');
      return a;
    }

    it('UTXO: resolves the active chain template', () => {
      hoisted.family = 'utxo';
      hoisted.ticker = 'RVN';
      hoisted.decimals = 8;
      hoisted.state.explorerUrlTemplate = 'https://rvn.cryptoscope.io/tx/?txid={txid}';
      hoisted.state.txs = [tx({ txid: HASH, asset: 'RVN' })];
      renderDetail(HASH);
      expect(explorerLink().href).toBe(`https://rvn.cryptoscope.io/tx/?txid=${HASH}`);
    });

    it("EVM: uses the chain's own explorerTxUrl, never a foreign stored template", () => {
      hoisted.family = 'evm';
      hoisted.ticker = 'ETH';
      hoisted.decimals = 18;
      hoisted.evmChain = { key: 'ethereum', explorerTxUrl: 'https://etherscan.io/tx/{txid}', nativeTicker: 'ETH', nativeDecimals: 18 };
      // The EVM target's stored slot is Evrmore's bare key, so it can hold Evrmore's explorer.
      hoisted.state.explorerUrlTemplate = 'https://evr.cryptoscope.io/tx/?txid={txid}';
      const evmHash = `0x${'ab'.repeat(32)}`;
      hoisted.state.txs = [tx({ txid: evmHash, asset: 'ETH' })];
      renderDetail(evmHash);
      expect(explorerLink().href).toBe(`https://etherscan.io/tx/${evmHash}`);
    });

    it('Monero: links the public tx hash only, never a key or any other private data', () => {
      hoisted.state.explorerUrlTemplate = MONERO_EXPLORER_TX_URL;
      hoisted.state.txs = [tx({ txid: HASH })];
      renderDetail(HASH);
      const href = explorerLink().href;
      expect(href).toBe(`https://xmrchain.net/tx/${HASH}`);
      expect(href).not.toMatch(/viewkey|view_key|key=|[?&#]/i);
    });

    it('Zcash: links to zcashexplorer.app', () => {
      hoisted.family = 'zcash';
      hoisted.ticker = 'ZEC';
      hoisted.decimals = 8;
      hoisted.state.explorerUrlTemplate = ZCASH_EXPLORER_TX_URL;
      hoisted.state.txs = [tx({ txid: HASH, asset: 'ZEC' })];
      renderDetail(HASH);
      expect(explorerLink().href).toBe(`https://mainnet.zcashexplorer.app/transactions/${HASH}`);
    });

    it('Zcash: a local unrecognised:<sha256> placeholder id gets no link', () => {
      hoisted.family = 'zcash';
      hoisted.ticker = 'ZEC';
      hoisted.decimals = 8;
      hoisted.state.explorerUrlTemplate = ZCASH_EXPLORER_TX_URL;
      const pseudo = `unrecognised:${HASH}`;
      hoisted.state.txs = [tx({ txid: pseudo, asset: 'ZEC' })];
      renderDetail(pseudo);
      expect(screen.queryByTestId('live-tx-explorer')).toBeNull();
      expect(resolveExplorerUrl(ZCASH_EXPLORER_TX_URL, pseudo)).toBe('');
    });

    it('Bittensor: links the extrinsic hash on taostats.io', () => {
      hoisted.family = 'substrate';
      hoisted.ticker = 'TAO';
      hoisted.decimals = 9;
      hoisted.state.explorerUrlTemplate = TAO_EXPLORER_TX_URL;
      const extrinsic = `0x${'cd'.repeat(32)}`;
      hoisted.state.txs = [tx({ txid: extrinsic, asset: 'TAO' })];
      renderDetail(extrinsic);
      expect(explorerLink().href).toBe(`https://taostats.io/extrinsic/${extrinsic}`);
    });

    it('a chain with no known explorer shows no link at all', () => {
      hoisted.family = 'utxo';
      hoisted.ticker = 'WJK';
      hoisted.decimals = 8;
      hoisted.state.explorerUrlTemplate = '';
      hoisted.state.txs = [tx({ txid: HASH, asset: 'WJK' })];
      renderDetail(HASH);
      expect(screen.queryByTestId('live-tx-explorer')).toBeNull();
    });
  });
});
