// Token search (Add token, EVM): the CoinGecko per-chain token list, its
// parser, its ranking, and the day-long cache that keeps the popup to one GET.
// Nothing here touches the network: every test passes its own fetch and its own
// clock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TOKEN_LIST_BYTES,
  TOKEN_LIST_HOST_PATTERN,
  TOKEN_LIST_TTL_MS,
  clearTokenListCacheForTests,
  fetchTokenList,
  parseTokenList,
  searchTokenList,
  tokenListUrl,
  type TokenListEntry,
} from './tokenSearch';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDC_EIP55 = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const CBBTC_EIP55 = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const WETH = '0x4200000000000000000000000000000000000006';

/** A row shaped exactly like the ones in the real all.json. */
function row(address: string, symbol: string, name: string, decimals: number) {
  return { chainId: 8453, address, name, symbol, decimals, logoURI: 'https://example.invalid/x.png' };
}

const LIST_BODY = {
  name: 'CoinGecko',
  tokens: [
    row(USDC, 'USDC', 'USD Coin', 6),
    row(CBBTC, 'cbBTC', 'Coinbase Wrapped BTC', 8),
    row(WETH, 'WETH', 'Wrapped Ether', 18),
  ],
};

const okFetch = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

afterEach(() => {
  clearTokenListCacheForTests();
});

describe('token list URL and host', () => {
  it('1. builds the per-chain URL from a plain slug and refuses anything else', () => {
    expect(tokenListUrl('base')).toBe('https://tokens.coingecko.com/base/all.json');
    expect(tokenListUrl('binance-smart-chain')).toBe('https://tokens.coingecko.com/binance-smart-chain/all.json');
    expect(tokenListUrl('')).toBe(null);
    expect(tokenListUrl('../evil')).toBe(null);
    expect(tokenListUrl('Base')).toBe(null);
    expect(tokenListUrl('a/b')).toBe(null);
    // The manifest pattern must cover the URLs this module builds.
    expect(TOKEN_LIST_HOST_PATTERN).toBe('https://tokens.coingecko.com/*');
    expect(new URL(tokenListUrl('base') as string).host).toBe('tokens.coingecko.com');
  });
});

describe('parsing a token list', () => {
  it('2. keeps address (checksummed), name, symbol and decimals, and drops logoURI and chainId', () => {
    expect(parseTokenList(LIST_BODY)).toEqual([
      { address: USDC_EIP55, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
      { address: CBBTC_EIP55, name: 'Coinbase Wrapped BTC', symbol: 'cbBTC', decimals: 8 },
      { address: WETH, name: 'Wrapped Ether', symbol: 'WETH', decimals: 18 },
    ]);
  });

  it('3. drops malformed rows and keeps the first of a duplicated address', () => {
    const entries = parseTokenList({
      tokens: [
        row('0x1234', 'SHORT', 'Not 20 bytes', 18),
        row(USDC, '', 'No symbol at all', 6),
        { chainId: 8453, address: WETH, symbol: 'NODEC', name: 'Decimals missing' },
        row(CBBTC, 'FRACT', 'Fractional decimals', 8.5),
        row(CBBTC, 'NEGDEC', 'Negative decimals', -1),
        row(CBBTC, 'HUGEDEC', 'Absurd decimals', 999),
        row(USDC, 'USDC', 'USD Coin', 6),
        // The same contract again, differently cased: one row survives.
        row(USDC.toUpperCase().replace('0X', '0x'), 'DUPE', 'Same token again', 6),
        'not an object',
        null,
      ],
    });
    expect(entries).toEqual([{ address: USDC_EIP55, name: 'USD Coin', symbol: 'USDC', decimals: 6 }]);
  });

  it('4. answers [] for anything that is not { tokens: [...] }, and falls back to the symbol when the name is missing', () => {
    expect(parseTokenList(null)).toEqual([]);
    expect(parseTokenList({})).toEqual([]);
    expect(parseTokenList({ tokens: 'nope' })).toEqual([]);
    expect(parseTokenList([])).toEqual([]);
    expect(parseTokenList({ tokens: [{ address: WETH, symbol: 'WETH', decimals: 18 }] })).toEqual([
      { address: WETH, name: 'WETH', symbol: 'WETH', decimals: 18 },
    ]);
  });
});

describe('ranking', () => {
  const entries: TokenListEntry[] = [
    { address: `0x${'1'.repeat(40)}`, name: 'USD Coin Bridged', symbol: 'USDbC', decimals: 6 },
    { address: `0x${'2'.repeat(40)}`, name: 'Coinbase Wrapped BTC', symbol: 'cbBTC', decimals: 8 },
    { address: USDC_EIP55, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    { address: `0x${'3'.repeat(40)}`, name: 'Fake USDC clone', symbol: 'SCAM', decimals: 18 },
    { address: `0x${'4'.repeat(40)}`, name: 'USDC Yield Vault', symbol: 'yvUSDC', decimals: 6 },
  ];

  it('5. the exact symbol wins, then a name prefix, then a substring, whatever the case', () => {
    // USDC (symbol exact) > yvUSDC (name prefix "USDC Yield…") > SCAM (name contains).
    expect(searchTokenList(entries, 'usdc').map((e) => e.symbol)).toEqual(['USDC', 'yvUSDC', 'SCAM']);
    expect(searchTokenList(entries, 'USDC').map((e) => e.symbol)).toEqual(['USDC', 'yvUSDC', 'SCAM']);
    expect(searchTokenList(entries, ' UsDc ').map((e) => e.symbol)).toEqual(['USDC', 'yvUSDC', 'SCAM']);
  });

  it('6. a symbol prefix beats a name prefix, which beats a substring; within a tier the SHORTER symbol comes first (USDC above USDbC), then alphabetical', () => {
    // USDbC and USDC are both symbol prefixes: the shorter symbol wins the tier.
    expect(searchTokenList(entries, 'usd').map((e) => e.symbol)).toEqual(['USDC', 'USDbC', 'yvUSDC', 'SCAM']);
    // cbBTC's NAME starts with "Coin"; the other two only contain it.
    expect(searchTokenList(entries, 'coin').map((e) => e.symbol)).toEqual(['cbBTC', 'USDC', 'USDbC']);
  });

  it('7. an address prefix matches only once it is specific (a bare "0x" lists nothing)', () => {
    expect(searchTokenList(entries, '0x')).toEqual([]);
    expect(searchTokenList(entries, '0x8335').map((e) => e.symbol)).toEqual(['USDC']);
    expect(searchTokenList(entries, USDC_EIP55).map((e) => e.symbol)).toEqual(['USDC']);
    expect(searchTokenList(entries, USDC_EIP55.toLowerCase()).map((e) => e.symbol)).toEqual(['USDC']);
    expect(searchTokenList(entries, '0x9999').map((e) => e.symbol)).toEqual([]);
  });

  it('8. an empty query answers nothing, and the limit caps the rows (8 by default)', () => {
    expect(searchTokenList(entries, '')).toEqual([]);
    expect(searchTokenList(entries, '   ')).toEqual([]);
    expect(searchTokenList(entries, 'usd', 2).map((e) => e.symbol)).toEqual(['USDC', 'USDbC']);
    expect(searchTokenList(entries, 'usd', 0)).toEqual([]);
    expect(searchTokenList([], 'usd')).toEqual([]);
    const many: TokenListEntry[] = Array.from({ length: 20 }, (_, i) => ({
      address: `0x${String(i).padStart(40, '0')}`,
      name: `Token ${i}`,
      symbol: `TKN${i}`,
      decimals: 18,
    }));
    expect(searchTokenList(many, 'tkn')).toHaveLength(8);
  });
});

describe('fetching and caching', () => {
  it('9. downloads once, then answers from the cache until the TTL expires', async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const seen: string[] = [];
    const impl = vi.fn(async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(LIST_BODY), { status: 200 });
    });
    const fetchImpl = impl as unknown as typeof fetch;

    const first = await fetchTokenList('base', fetchImpl, { now });
    expect(first.ok && first.entries).toHaveLength(3);
    expect(seen).toEqual(['https://tokens.coingecko.com/base/all.json']);

    clock += TOKEN_LIST_TTL_MS - 1;
    const cached = await fetchTokenList('base', fetchImpl, { now });
    expect(cached.ok && cached.entries).toHaveLength(3);
    expect(seen).toHaveLength(1);

    clock += 2; // past the TTL
    await fetchTokenList('base', fetchImpl, { now });
    expect(seen).toHaveLength(2);

    // A different chain is a different list, cached separately.
    await fetchTokenList('binance-smart-chain', fetchImpl, { now });
    expect(seen[2]).toBe('https://tokens.coingecko.com/binance-smart-chain/all.json');
  });

  it('10. concurrent callers for the same chain share ONE request', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const impl = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(LIST_BODY), { status: 200 });
    });
    const fetchImpl = impl as unknown as typeof fetch;
    const all = Promise.all([
      fetchTokenList('base', fetchImpl),
      fetchTokenList('base', fetchImpl),
      fetchTokenList('base', fetchImpl),
    ]);
    release();
    const results = await all;
    expect(impl).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.ok && r.entries).toHaveLength(3);
  });

  it('11. every failure is a value, never a throw, and a failure is never cached', async () => {
    expect(await fetchTokenList('../evil', okFetch(LIST_BODY))).toEqual({ ok: false, error: 'no token list for this chain' });
    expect(await fetchTokenList('base', okFetch({}, 500))).toEqual({ ok: false, error: 'token list HTTP 500' });
    expect(await fetchTokenList('base', okFetch(LIST_BODY, 200, { 'content-length': String(MAX_TOKEN_LIST_BYTES + 1) }))).toEqual({
      ok: false,
      error: 'token list too large',
    });
    const notJson = (async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchTokenList('base', notJson)).toEqual({ ok: false, error: 'token list unreachable' });
    expect(await fetchTokenList('base', okFetch({ tokens: [] }))).toEqual({ ok: false, error: 'token list is empty or malformed' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchTokenList('base', down)).toEqual({ ok: false, error: 'token list unreachable' });

    // None of the above poisoned the cache: the next call really downloads.
    const impl = vi.fn(async () => new Response(JSON.stringify(LIST_BODY), { status: 200 }));
    const good = await fetchTokenList('base', impl as unknown as typeof fetch);
    expect(good.ok).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('12. clearTokenListCacheForTests() forces the next call to download again', async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify(LIST_BODY), { status: 200 }));
    const fetchImpl = impl as unknown as typeof fetch;
    await fetchTokenList('base', fetchImpl);
    await fetchTokenList('base', fetchImpl);
    expect(impl).toHaveBeenCalledTimes(1);
    clearTokenListCacheForTests();
    await fetchTokenList('base', fetchImpl);
    expect(impl).toHaveBeenCalledTimes(2);
  });
});
