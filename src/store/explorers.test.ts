// Every chain's block-explorer template.
//
// This had NO test at all, despite carrying a deliberate safety property: a
// chain must never fall back to another chain's explorer. It used to, and the
// result was a transaction id resolved on the wrong chain's site, which reads to
// the user as "this transaction does not exist" for a transaction that plainly
// does. The distinctness check below is the guard against that returning.

import { describe, expect, it } from 'vitest';
import {
  hasDefaultExplorer,
  DEFAULT_EXPLORER_URL,
  DEFAULT_EXPLORER_URL_RVN,
  DEFAULT_EXPLORER_URL_BTGS,
  DEFAULT_EXPLORER_URL_LTC,
  DEFAULT_EXPLORER_URL_BTC,
  DEFAULT_EXPLORER_URL_DOGE,
  DEFAULT_EXPLORER_URL_WJK,
} from './liveStore';
import { resolveExplorerUrl } from '../screens/live/LiveTxDetail';

/** Every chain id a user can hold a wallet on, with its template. */
const CHAINS: { chainId: string; template: string }[] = [
  { chainId: 'mainnet', template: DEFAULT_EXPLORER_URL },
  { chainId: 'ravencoin-mainnet', template: DEFAULT_EXPLORER_URL_RVN },
  { chainId: 'bitcoingold-mainnet', template: DEFAULT_EXPLORER_URL_BTGS },
  { chainId: 'litecoin-mainnet', template: DEFAULT_EXPLORER_URL_LTC },
  { chainId: 'wojakcoin-mainnet', template: DEFAULT_EXPLORER_URL_WJK },
  { chainId: 'bitcoin-mainnet', template: DEFAULT_EXPLORER_URL_BTC },
  { chainId: 'dogecoin-mainnet', template: DEFAULT_EXPLORER_URL_DOGE },
];

const TXID = '8d393b5a304d2ba25b9a50aaf817a784b992025fa7aec173943e268120790356';

describe('block explorer templates', () => {
  it('every chain a user can hold a wallet on has one', () => {
    for (const { chainId } of CHAINS) {
      expect(hasDefaultExplorer(chainId), `${chainId} has no explorer`).toBe(true);
    }
  });

  it('no two chains share a template, so a txid can never resolve on the wrong chain', () => {
    // The actual historical bug: an empty template fell back to Evrmore's, and a
    // WojakCoin transaction opened against the Evrmore explorer.
    const templates = CHAINS.map((c) => c.template);
    expect(new Set(templates).size).toBe(templates.length);
  });

  it('every template is https and carries the {txid} placeholder', () => {
    for (const { chainId, template } of CHAINS) {
      expect(template.startsWith('https://'), `${chainId} is not https`).toBe(true);
      expect(template.includes('{txid}'), `${chainId} has no {txid}`).toBe(true);
    }
  });

  it('resolves to a real per-chain URL containing the transaction id', () => {
    for (const { chainId, template } of CHAINS) {
      const url = resolveExplorerUrl(template, TXID);
      expect(url, `${chainId} resolved to nothing`).not.toBe('');
      expect(url).toContain(TXID);
      expect(url).not.toContain('{txid}');
    }
  });

  it('still fails CLOSED on a template that cannot be used', () => {
    // The guard has to survive a user pasting nonsense into the setting, and an
    // empty value must mean "no explorer", never "use the default chain's".
    for (const bad of ['', '   ', 'not a url', 'https://example.com/tx/no-placeholder']) {
      expect(resolveExplorerUrl(bad, TXID)).toBe('');
    }
  });
});
